// Multi-client/failover integration test for Super-Tester.
// Starts two real MCP server processes. The first becomes the broker, the
// second becomes a peer client. A fake extension verifies client isolation,
// then the broker is stopped and the peer client must promote/recover without
// losing its clientId or session.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_PORT = 9129;
const SERVER_ENTRY = path.join(__dirname, "src", "index.js");
const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "super-tester-")), "memory.db");

function logStep(label) { console.log(`\n-> ${label}`); }

function assertOk(label, condition, info) {
  if (!condition) {
    console.error(`FAIL ${label}`, info ?? "");
    process.exit(1);
  }
  console.log(`  ok ${label}`);
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`  ok ${label}`);
}

function parsePayload(callResult) {
  return JSON.parse(callResult.content?.[0]?.text ?? "{}");
}

function createFakeExtension() {
  const calls = [];
  const sessions = new Map();
  let ws = null;
  let closed = false;
  let openCount = 0;
  let nextTabId = 500;

  function connect() {
    if (closed) return;
    ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

    ws.on("open", () => {
      openCount += 1;
      ws.send(JSON.stringify({ type: "hello", role: "extension", version: "test" }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "hello") return;
      const { id, type, params, clientId } = msg;
      calls.push({ type, params, clientId, at: Date.now() });

      let ok = true;
      let result;
      const session = sessions.get(clientId);
      switch (type) {
        case "session_start": {
          const tabId = nextTabId++;
          const entry = {
            sessionId: `sess-${clientId}`,
            groupId: tabId + 1000,
            primaryTabId: tabId,
            windowId: 1,
            url: params?.url ?? "about:blank",
          };
          sessions.set(clientId, entry);
          result = {
            sessionId: entry.sessionId,
            groupId: entry.groupId,
            primaryTabId: entry.primaryTabId,
            windowId: entry.windowId,
            ownsWindow: false,
            clientId,
          };
          break;
        }
        case "navigate":
          if (!session) {
            ok = false;
            result = "no session for navigate";
          } else {
            session.url = params?.url ?? session.url;
            result = { tabId: session.primaryTabId, url: session.url };
          }
          break;
        case "list_tabs":
          if (!session) {
            ok = false;
            result = "no session for list_tabs";
          } else {
            result = {
              sessionId: session.sessionId,
              groupId: session.groupId,
              primaryTabId: session.primaryTabId,
              tabs: [{
                id: session.primaryTabId,
                url: session.url,
                title: clientId,
                active: false,
                primary: true,
                debuggerAttached: false,
              }],
            };
          }
          break;
        case "client_cleanup":
        case "session_end":
          result = {
            ended: sessions.delete(clientId),
            sessionId: session?.sessionId,
            tabCount: session ? 1 : 0,
          };
          break;
        default:
          ok = false;
          result = `unhandled fake extension command: ${type}`;
      }

      ws.send(JSON.stringify(ok ? { id, ok: true, result } : { id, ok: false, error: result }));
    });

    ws.on("close", () => {
      if (!closed) setTimeout(connect, 100);
    });

    ws.on("error", () => {});
  }

  connect();

  return {
    calls,
    sessions,
    close: () => {
      closed = true;
      try { ws?.close(); } catch {}
    },
    waitForOpenCount: async (count, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (openCount >= count) return;
        await sleep(50);
      }
      throw new Error(`fake extension open count timed out: wanted ${count}, got ${openCount}`);
    },
    waitForCall: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = calls.find(predicate);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error("fake extension call timeout");
    },
  };
}

async function startMcp(label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      SUPER_TESTER_WS_PORT: String(TEST_PORT),
      SUPER_TESTER_AUTO_LAUNCH: "false",
      SUPER_TESTER_EXTENSION_WAIT_MS: "5000",
      SUPER_TESTER_DB_PATH: DB_PATH,
    },
    stderr: "pipe",
  });
  const stderr = [];
  if (transport.stderr) transport.stderr.on("data", (b) => stderr.push(b.toString()));

  const client = new Client(
    { name: `super-tester-${label}`, version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport, stderr };
}

async function main() {
  logStep("Start primary MCP broker and fake extension");
  const primary = await startMcp("primary");
  await sleep(250);
  const ext = createFakeExtension();
  await ext.waitForOpenCount(1);

  logStep("Start second MCP client");
  const secondary = await startMcp("secondary");

  logStep("Start isolated sessions concurrently");
  const [s1, s2] = await Promise.all([
    primary.client.callTool({
      name: "browser_session_start",
      arguments: { url: "https://example.test/one" },
    }).then(parsePayload),
    secondary.client.callTool({
      name: "browser_session_start",
      arguments: { url: "https://example.test/two" },
    }).then(parsePayload),
  ]);
  assertOk("client IDs are distinct", s1.clientId !== s2.clientId, { s1, s2 });
  assertEq("fake extension has two sessions", ext.sessions.size, 2);

  logStep("Navigate both sessions at the same time");
  await Promise.all([
    primary.client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.test/one/dashboard" },
    }),
    secondary.client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.test/two/dashboard" },
    }),
  ]);
  assertEq("session one URL isolated", ext.sessions.get(s1.clientId).url, "https://example.test/one/dashboard");
  assertEq("session two URL isolated", ext.sessions.get(s2.clientId).url, "https://example.test/two/dashboard");

  logStep("Stop primary broker and verify secondary recovers");
  await primary.client.close();
  await sleep(500);

  const tabs = parsePayload(await secondary.client.callTool({
    name: "browser_list_tabs",
    arguments: {},
  }));
  assertEq("secondary kept the same session after failover", tabs.sessionId, `sess-${s2.clientId}`);
  assertEq("secondary kept its URL after failover", tabs.tabs[0].url, "https://example.test/two/dashboard");
  await ext.waitForCall((c) => c.type === "list_tabs" && c.clientId === s2.clientId);

  logStep("Attach a third MCP client to the recovered broker");
  const tertiary = await startMcp("tertiary");
  const s3 = parsePayload(await tertiary.client.callTool({
    name: "browser_session_start",
    arguments: { url: "https://example.test/three" },
  }));
  assertOk("third client got a unique client ID", ![s1.clientId, s2.clientId].includes(s3.clientId), s3);
  assertOk("extension tracks secondary and tertiary", ext.sessions.has(s2.clientId) && ext.sessions.has(s3.clientId));

  logStep("Cleanup");
  await tertiary.client.callTool({ name: "browser_session_end", arguments: {} }).catch(() => {});
  await secondary.client.callTool({ name: "browser_session_end", arguments: {} }).catch(() => {});
  await tertiary.client.close().catch(() => {});
  await secondary.client.close().catch(() => {});
  ext.close();

  console.log("\nALL MULTI-CLIENT CHECKS PASSED");
}

main().catch((e) => {
  console.error("\nMULTI-CLIENT TEST FAILED:", e);
  process.exit(1);
});
