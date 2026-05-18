// HTTP client for the Mochi broker's /claude/* routes. All calls are
// best-effort and fail closed: if the broker is offline, callers get
// {ok: false, error: "..."} and the rest of the plugin proceeds normally.
//
// Used by:
//   hooks/session_start.js  — register
//   hooks/session_end.js    — unregister
//   hooks/pre_tool_use.js   — drainInbox  (hot path; uses sentinel fast-skip)
//   lib/rename_cli.js       — rename
//
// Configuration:
//   $CONTINUUM_BROKER_URL         (default http://127.0.0.1:9009)
//   $CONTINUUM_BROKER_TIMEOUT_MS  (default 250)

const DEFAULT_URL = process.env.CONTINUUM_BROKER_URL || "http://127.0.0.1:9009";
const DEFAULT_TIMEOUT_MS = Number(process.env.CONTINUUM_BROKER_TIMEOUT_MS || 250);

async function brokerFetch(url, path, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, path, body, timeoutMs) {
  try {
    const r = await brokerFetch(url, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!r.ok) return { ok: false, status: r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function register({ sessionId, name, projectDir, url = DEFAULT_URL }) {
  if (!sessionId) return { ok: false, error: "sessionId required" };
  return postJson(url, "/claude/register", { sessionId, name, projectDir });
}

export async function unregister({ sessionId, url = DEFAULT_URL }) {
  if (!sessionId) return { ok: false, error: "sessionId required" };
  return postJson(url, "/claude/unregister", { sessionId });
}

export async function rename({ sessionId, name, url = DEFAULT_URL }) {
  if (!sessionId || !name) return { ok: false, error: "sessionId+name required" };
  return postJson(url, "/claude/rename", { sessionId, name });
}

export async function drainInbox({ sessionId, url = DEFAULT_URL }) {
  if (!sessionId) return { messages: [] };
  try {
    const r = await brokerFetch(url, `/claude/inbox?sessionId=${encodeURIComponent(sessionId)}`);
    if (!r.ok) return { messages: [] };
    const j = await r.json();
    return { messages: Array.isArray(j.messages) ? j.messages : [] };
  } catch {
    return { messages: [] };
  }
}

export async function pushMessage({ sessionId, message, context, url = DEFAULT_URL }) {
  if (!sessionId || !message) return { ok: false, error: "sessionId+message required" };
  return postJson(url, "/claude/inbox", { sessionId, message, context });
}

export async function listSessions({ url = DEFAULT_URL } = {}) {
  try {
    const r = await brokerFetch(url, "/claude/sessions");
    if (!r.ok) return { sessions: [] };
    const j = await r.json();
    return { sessions: Array.isArray(j.sessions) ? j.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}
