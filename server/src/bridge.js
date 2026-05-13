// Bridge: dual-mode coordination layer between MCP server processes and the
// Chrome extension's service worker.
//
// On startup each MCP process tries to bind ws://127.0.0.1:9009. The winner
// becomes the BROKER and holds the single TCP listener. Losers become CLIENTS
// and connect to the broker as a peer. Clients forward all browser-level
// commands through the broker; the broker tags each command with the
// originating clientId and the extension routes it to that client's session.
//
// Wire protocol (over a single port):
//   On connect, every WS sends:  {type:"hello", role:"extension"|"mcp-client", ...}
//   Extension role uses the original protocol with one new field:
//     broker → ext   {id, type, params, clientId}
//     ext   → broker {id, ok, result}
//   MCP-client role uses:
//     client → broker {id, type, params}        (regular tool calls)
//     broker → client {type:"welcome", clientId} (sent right after hello)
//     broker → client {id, ok, result}          (responses)
//
// When a client disconnects, the broker tells the extension to end that
// client's session so tab groups don't leak.

import { WebSocketServer, WebSocket } from "ws";

const HELLO_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30000;
const CLIENT_CONNECT_TIMEOUT_MS = 5000;
const CLIENT_RECOVERY_MAX_DELAY_MS = 5000;
const CLIENT_CLEANUP_GRACE_MS = 5000;

export class Bridge {
  constructor({ log = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.log = log;
    this.mode = null;            // "broker" | "client"
    this.requestTimeoutMs = requestTimeoutMs;
    this.host = null;
    this.port = null;
    this.closed = false;

    // Broker state ---------------------------------------------------------
    this.wss = null;
    this.extensionWs = null;
    this.mcpClients = new Map(); // clientId → ws
    this.clientCleanupTimers = new Map();
    this.extPending = new Map(); // id → { resolve, reject, clientId? }
    this.extWaiters = [];        // unblocked when extension connects
    this.localClientId = null;

    // Client state ---------------------------------------------------------
    this.brokerWs = null;
    this.brokerPending = new Map(); // id → { resolve, reject }
    this.brokerWaiters = [];
    this.recoveryPromise = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryAt = null;
    this.lastError = null;

    this.nextId = 1;
  }

  // --------- Mode entry points ----------

  // Try to become broker by binding the port. Resolves to "broker" on success
  // or "client" if the port is already taken.
  async start({ port = 9009, host = "127.0.0.1" } = {}) {
    this.port = port;
    this.host = host;
    const role = await this._tryBecomeBroker(port, host);
    if (role === "broker") return "broker";
    try {
      await this._becomeClient(port, host);
    } catch (e) {
      this.lastError = e.message;
      this.log(`[bridge] initial broker connection failed: ${e.message}; entering recovery`);
      await this._startClientRecovery();
    }
    return this.mode;
  }

  // ---------------- BROKER ----------------

  _tryBecomeBroker(port, host, { preserveLocalClientId = false } = {}) {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port, host });
      wss.once("error", (e) => {
        // Port taken or some other failure → step aside.
        if (e.code === "EADDRINUSE") return resolve("client");
        this.lastError = e.message;
        this.log(`[bridge] wss error: ${e.message}`);
        resolve("client");
      });
      wss.once("listening", () => {
        this.wss = wss;
        this.mode = "broker";
        this.localClientId = preserveLocalClientId && this.localClientId
          ? this.localClientId
          : this._mintClientId("self");
        this.log(`[bridge] broker bound ws://${host}:${port} (clientId=${this.localClientId})`);
        wss.removeAllListeners("error");
        wss.on("error", (e) => this.log(`[bridge] wss error: ${e.message}`));
        wss.on("connection", (ws, req) => this._onBrokerConnection(ws, req));
        resolve("broker");
      });
    });
  }

  _onBrokerConnection(ws) {
    let identified = false;
    const helloTimer = setTimeout(() => {
      if (!identified) {
        try { ws.close(1002, "no hello"); } catch {}
      }
    }, HELLO_TIMEOUT_MS);

    ws.once("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { try { ws.close(); } catch {}; return; }
      identified = true;
      clearTimeout(helloTimer);

      if (msg.type === "hello" && msg.role === "extension") {
        this._attachExtension(ws);
      } else if (msg.type === "hello" && msg.role === "mcp-client") {
        const clientId = this._resolvePeerClientId(msg.clientId);
        this._attachMcpClient(ws, clientId);
      } else {
        try { ws.close(1002, "bad hello"); } catch {}
      }
    });
  }

  _attachExtension(ws) {
    if (this.extensionWs && this.extensionWs !== ws) {
      try { this.extensionWs.close(); } catch {}
    }
    this.extensionWs = ws;
    this.log("[bridge] extension connected");

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "hello") return;
      const { id, ok, result, error } = msg;
      const p = this.extPending.get(id);
      if (!p) return;
      this.extPending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error ?? "unknown extension error"));
    });

    ws.on("close", () => {
      if (this.extensionWs === ws) this.extensionWs = null;
      for (const [id, p] of this.extPending) {
        p.reject(new Error("extension disconnected mid-request"));
        this.extPending.delete(id);
      }
      this.log("[bridge] extension disconnected");
    });
    ws.on("error", () => {});

    const waiters = this.extWaiters;
    this.extWaiters = [];
    for (const w of waiters) w.resolve();
  }

  _attachMcpClient(ws, clientId) {
    const cleanupTimer = this.clientCleanupTimers.get(clientId);
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      this.clientCleanupTimers.delete(clientId);
    }
    this.mcpClients.set(clientId, ws);
    this.log(`[bridge] mcp-client connected (clientId=${clientId}, total=${this.mcpClients.size})`);
    try { ws.send(JSON.stringify({ type: "welcome", clientId })); } catch {}

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { id, type, params } = msg;
      if (id == null || !type) return;
      // A peer MCP wants us to forward this command to the extension.
      this._sendToExtension(type, params ?? {}, clientId)
        .then((result) => { try { ws.send(JSON.stringify({ id, ok: true, result })); } catch {} })
        .catch((e) => { try { ws.send(JSON.stringify({ id, ok: false, error: String(e?.message ?? e) })); } catch {} });
    });

    ws.on("close", () => {
      if (this.mcpClients.get(clientId) === ws) this.mcpClients.delete(clientId);
      this.log(`[bridge] mcp-client disconnected (clientId=${clientId})`);
      // Give a crashed/restarted MCP client a short window to reconnect with
      // the same clientId before we release its tab group.
      const timer = setTimeout(() => {
        this.clientCleanupTimers.delete(clientId);
        if (this.mcpClients.has(clientId)) return;
        this._sendToExtension("client_cleanup", {}, clientId).catch(() => {});
      }, CLIENT_CLEANUP_GRACE_MS);
      this.clientCleanupTimers.set(clientId, timer);
    });
    ws.on("error", () => {});
  }

  // --------- broker: send-to-extension primitive ---------
  async _sendToExtension(type, params, clientId) {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      // Wait briefly in case the extension is reconnecting.
      await this._waitForExtension(15000).catch(() => {
        throw new Error(
          "extension didn't connect within timeout — make sure the Super-Tester extension is loaded in Chrome and auto-connect is on"
        );
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.extPending.has(id)) {
          this.extPending.delete(id);
          reject(new Error(`extension request timeout (${type})`));
        }
      }, this.requestTimeoutMs);
      this.extPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.extensionWs.send(JSON.stringify({ id, type, params, clientId }));
      } catch (e) {
        this.extPending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _waitForExtension(timeoutMs) {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResolve = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const i = this.extWaiters.findIndex((w) => w.resolve === onResolve);
        if (i !== -1) this.extWaiters.splice(i, 1);
        reject(new Error("extension wait timeout"));
      }, timeoutMs);
      this.extWaiters.push({ resolve: onResolve });
    });
  }

  // ---------------- CLIENT ----------------

  _becomeClient(port, host) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        reject(error);
      };

      this.mode = "client";
      const ws = new WebSocket(`ws://${host}:${port}`);
      this.brokerWs = ws;

      ws.on("open", () => {
        try {
          ws.send(JSON.stringify({
            type: "hello",
            role: "mcp-client",
            clientId: this.localClientId ?? undefined,
          }));
        } catch {}
      });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "welcome") {
          this.localClientId = msg.clientId;
          this.log(`[bridge] client mode (clientId=${this.localClientId})`);
          // Wake any waiters.
          const waiters = this.brokerWaiters; this.brokerWaiters = [];
          for (const w of waiters) w.resolve();
          settleResolve();
          return;
        }
        const { id, ok, result, error } = msg;
        const p = this.brokerPending.get(id);
        if (!p) return;
        this.brokerPending.delete(id);
        if (ok) p.resolve(result);
        else p.reject(new Error(error ?? "broker error"));
      });

      ws.on("close", () => {
        if (this.brokerWs === ws) this.brokerWs = null;
        this._rejectBrokerPending("broker connection lost mid-request");
        this.log("[bridge] broker connection closed");
        if (!settled) settleReject(new Error("broker connection closed before welcome"));
        if (!this.closed) this._startClientRecovery().catch((e) => {
          this.lastError = e.message;
          this.log(`[bridge] client recovery failed: ${e.message}`);
        });
      });

      ws.on("error", (e) => {
        this.lastError = e.message;
        if (!settled) settleReject(new Error(`could not connect to broker: ${e.message}`));
      });

      // Failsafe — if welcome never arrives.
      const welcomeTimer = setTimeout(() => {
        if (!settled) settleReject(new Error(`no welcome from broker within ${CLIENT_CONNECT_TIMEOUT_MS}ms`));
        try { ws.close(); } catch {}
      }, CLIENT_CONNECT_TIMEOUT_MS);
    });
  }

  // --------- public API used by tools.js ---------

  // Send a tool command. In broker mode, this goes straight to the extension
  // tagged with our own clientId. In client mode, it goes to the broker which
  // tags and forwards.
  async send(type, params = {}) {
    if (this.mode === "broker") {
      return this._sendToExtension(type, params, this.localClientId);
    }
    if (this.mode === "client") {
      await this._withTimeout(
        this._ensureClientTransport(),
        this.requestTimeoutMs,
        "broker connection not ready"
      );
      if (this.mode === "broker") return this._sendToExtension(type, params, this.localClientId);
      return this._sendToBroker(type, params);
    }
    throw new Error("bridge not started");
  }

  isConnected() {
    if (this.mode === "broker") return !!this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN;
    if (this.mode === "client") return !!this.brokerWs && this.brokerWs.readyState === WebSocket.OPEN && !!this.localClientId;
    return false;
  }

  // Wait until we can serve a request (extension connected if broker, broker
  // connected if client). The MCP server's first tool call uses this.
  async waitForConnection(timeoutMs = 15000) {
    if (this.mode === "broker") {
      if (this.isConnected()) return;
      return this._waitForExtension(timeoutMs).catch(() => {
        throw new Error(
          "extension didn't connect within timeout — make sure the Super-Tester extension is loaded in Chrome and auto-connect is on"
        );
      });
    }
    if (this.mode === "client") {
      if (this.isConnected() && this.localClientId) return;
      await this._withTimeout(
        this._ensureClientTransport(),
        timeoutMs,
        "broker connection wait timeout"
      );
      if (this.mode === "broker") return this.waitForConnection(timeoutMs);
      return;
    }
    throw new Error("bridge not started");
  }

  // What clientId we appear as to the extension (used by tests + diagnostics).
  getLocalClientId() { return this.localClientId; }

  getStatus() {
    return {
      mode: this.mode ?? "uninitialized",
      connected: this.isConnected(),
      clientId: this.localClientId ?? null,
      mcpPeerCount: this.mode === "broker" ? this.mcpClients.size : null,
      recovering: !!this.recoveryPromise,
      recoveryAttempts: this.recoveryAttempts,
      lastRecoveryAt: this.lastRecoveryAt,
      lastError: this.lastError,
    };
  }

  async cleanupLocalSession() {
    if (!this.localClientId) return { cleaned: false, reason: "no-client-id" };
    try {
      if (this.mode === "broker") {
        if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
          return { cleaned: false, reason: "extension-not-connected" };
        }
        return await this._sendToExtension("client_cleanup", {}, this.localClientId);
      }
      if (this.mode === "client") {
        if (!this.brokerWs || this.brokerWs.readyState !== WebSocket.OPEN) {
          return { cleaned: false, reason: "broker-not-connected" };
        }
        return await this._sendToBroker("client_cleanup", {});
      }
    } catch (e) {
      return { cleaned: false, reason: String(e?.message ?? e) };
    }
    return { cleaned: false, reason: "bridge-not-started" };
  }

  shutdown() {
    this.closed = true;
    this._rejectBrokerPending("bridge shutting down");
    this._rejectBrokerWaiters("bridge shutting down");
    try { this.wss?.close(); } catch {}
    try { this.extensionWs?.close(); } catch {}
    try { this.brokerWs?.close(); } catch {}
    for (const ws of this.mcpClients.values()) try { ws.close(); } catch {}
    for (const timer of this.clientCleanupTimers.values()) clearTimeout(timer);
    this.clientCleanupTimers.clear();
  }

  _mintClientId(prefix = "c") {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    return `mc-${prefix}-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  _resolvePeerClientId(requested) {
    if (this._isUsableClientId(requested)) {
      const existing = this.mcpClients.get(requested);
      if (!existing || existing.readyState !== WebSocket.OPEN) {
        if (existing) this.mcpClients.delete(requested);
        if (requested !== this.localClientId) return requested;
      }
    }
    return this._mintClientId("c");
  }

  _isUsableClientId(value) {
    return typeof value === "string" &&
      /^[A-Za-z0-9_-]{4,96}$/.test(value) &&
      value.startsWith("mc-");
  }

  _sendToBroker(type, params) {
    if (!this.brokerWs || this.brokerWs.readyState !== WebSocket.OPEN) {
      throw new Error("broker connection not ready");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.brokerPending.has(id)) {
          this.brokerPending.delete(id);
          reject(new Error(`broker request timeout (${type})`));
        }
      }, this.requestTimeoutMs);
      this.brokerPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.brokerWs.send(JSON.stringify({ id, type, params }));
      } catch (e) {
        this.brokerPending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async _ensureClientTransport() {
    if (this.mode !== "client") return;
    if (this.brokerWs?.readyState === WebSocket.OPEN && this.localClientId) return;
    await this._startClientRecovery();
  }

  _startClientRecovery() {
    if (this.closed) return Promise.reject(new Error("bridge is shutting down"));
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this._recoverClientConnection()
      .finally(() => { this.recoveryPromise = null; });
    return this.recoveryPromise;
  }

  async _recoverClientConnection() {
    if (this.port == null || !this.host) {
      throw new Error("cannot recover broker connection before bridge.start()");
    }

    let delayMs = 100;
    while (!this.closed) {
      this.recoveryAttempts += 1;
      await this._sleep(delayMs);

      const role = await this._tryBecomeBroker(this.port, this.host, {
        preserveLocalClientId: true,
      });
      if (role === "broker") {
        this.lastRecoveryAt = new Date().toISOString();
        this.recoveryAttempts = 0;
        const waiters = this.brokerWaiters;
        this.brokerWaiters = [];
        for (const w of waiters) w.resolve();
        this.log(`[bridge] client promoted to broker (clientId=${this.localClientId})`);
        return "broker";
      }

      try {
        await this._becomeClient(this.port, this.host);
        this.lastRecoveryAt = new Date().toISOString();
        this.recoveryAttempts = 0;
        return "client";
      } catch (e) {
        this.lastError = e.message;
        this.log(`[bridge] broker reconnect attempt failed: ${e.message}`);
        delayMs = Math.min(delayMs * 2, CLIENT_RECOVERY_MAX_DELAY_MS);
      }
    }
    throw new Error("bridge is shutting down");
  }

  _rejectBrokerPending(reason) {
    for (const [id, p] of this.brokerPending) {
      p.reject(new Error(reason));
      this.brokerPending.delete(id);
    }
  }

  _rejectBrokerWaiters(reason) {
    const waiters = this.brokerWaiters;
    this.brokerWaiters = [];
    for (const w of waiters) {
      if (w.reject) w.reject(new Error(reason));
      else w.resolve();
    }
  }

  _withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
