// Synthetic test for the broker's /claude/* HTTP routes + claude_sessions_update
// WS broadcasts. Spins up a real Bridge instance on a free port and drives it
// via fetch + a fake extension WS client.

import { Bridge } from "./src/bridge.js";
import { WebSocket } from "ws";

const PORT = 19009;          // off the default 9009 so we don't clash with a running broker
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok   = (m) => { console.log("  ✓", m); pass++; };
const bad  = (m) => { console.log("  ✗", m); fail++; };

const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: PORT });
if (role !== "broker") {
  console.error("could not bind broker on", PORT, "—", bridge.lastError);
  process.exit(1);
}

// Connect a fake extension WS client. Collect every claude_sessions_update.
const updates = [];
const ext = new WebSocket(WSURL);
await new Promise((res, rej) => {
  ext.once("open", () => {
    ext.send(JSON.stringify({ type: "hello", role: "extension" }));
    res();
  });
  ext.once("error", rej);
});
ext.on("message", (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === "claude_sessions_update") updates.push(msg.sessions);
});
await sleep(50);   // wait for initial broadcast on attach

// ---- T1: GET /claude/sessions returns empty list initially ----
console.log("T1 — GET /claude/sessions (empty)");
{
  const r = await (await fetch(`${BASE}/claude/sessions`)).json();
  Array.isArray(r.sessions) && r.sessions.length === 0
    ? ok("empty session list") : bad(`expected empty, got ${JSON.stringify(r)}`);
}

// ---- T2: POST /claude/register adds a session ----
console.log("T2 — POST /claude/register");
{
  const r = await postJson("/claude/register", {
    sessionId: "sess-A", name: "demo-A · main", projectDir: "/tmp/demo-a",
  });
  r.ok === true ? ok("register returned ok") : bad("register failed");
  await sleep(20);
  const list = (await (await fetch(`${BASE}/claude/sessions`)).json()).sessions;
  list.length === 1 && list[0].sessionId === "sess-A" && list[0].name === "demo-A · main"
    ? ok("session appears in list with correct name") : bad(`list wrong: ${JSON.stringify(list)}`);
}

// ---- T3: extension WS received claude_sessions_update on register ----
console.log("T3 — extension WS received claude_sessions_update");
{
  // updates[0] = initial empty broadcast on attach. updates[1] = post-register.
  updates.length >= 2 && updates[updates.length - 1].some((s) => s.sessionId === "sess-A")
    ? ok(`got ${updates.length} broadcasts, latest has sess-A`)
    : bad(`broadcasts wrong: ${updates.length} total`);
}

// ---- T4: POST /claude/inbox enqueues a message ----
console.log("T4 — POST /claude/inbox queues a message");
{
  const r = await postJson("/claude/inbox", {
    sessionId: "sess-A",
    message: "look at the 500 in checkout",
    context: { url: "https://app.example.com/checkout", recentErrors: ["TypeError: cart"] },
  });
  r.ok === true ? ok("inbox push returned ok") : bad("inbox push failed");
  await sleep(20);
  const list = (await (await fetch(`${BASE}/claude/sessions`)).json()).sessions;
  list[0].queuedCount === 1 ? ok("queuedCount=1") : bad(`queuedCount=${list[0].queuedCount}`);
}

// ---- T5: GET /claude/inbox?sessionId=X drains and returns messages ----
console.log("T5 — GET /claude/inbox drains the queue");
{
  const r = await (await fetch(`${BASE}/claude/inbox?sessionId=sess-A`)).json();
  r.messages?.length === 1 && r.messages[0].message.includes("500")
    ? ok("drained 1 message") : bad(`drain wrong: ${JSON.stringify(r)}`);
  r.messages[0].context?.url === "https://app.example.com/checkout"
    ? ok("context preserved through inbox") : bad("context lost");
  // Second drain should be empty
  const r2 = await (await fetch(`${BASE}/claude/inbox?sessionId=sess-A`)).json();
  r2.messages?.length === 0 ? ok("second drain is empty (queue cleared)") : bad("queue not cleared");
}

// ---- T6: POST /claude/rename updates name + broadcasts ----
console.log("T6 — POST /claude/rename");
{
  const before = updates.length;
  const r = await postJson("/claude/rename", { sessionId: "sess-A", name: "RENAMED" });
  r.ok === true ? ok("rename ok") : bad("rename failed");
  await sleep(20);
  const list = (await (await fetch(`${BASE}/claude/sessions`)).json()).sessions;
  list[0].name === "RENAMED" ? ok("name updated") : bad(`name=${list[0].name}`);
  updates.length > before ? ok("broadcast fired on rename") : bad("no broadcast on rename");
}

// ---- T7: send_claude_message via WS from extension also queues ----
console.log("T7 — WS send_claude_message from extension");
{
  const msgId = 9999;
  const responded = new Promise((res) => {
    const h = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id === msgId) { ext.off("message", h); res(m); }
    };
    ext.on("message", h);
  });
  ext.send(JSON.stringify({
    id: msgId, type: "send_claude_message",
    sessionId: "sess-A", message: "from popup ws",
    context: { url: "https://app/x" },
  }));
  const reply = await responded;
  reply.ok === true ? ok("WS push acked") : bad(`WS push failed: ${JSON.stringify(reply)}`);
  const drained = (await (await fetch(`${BASE}/claude/inbox?sessionId=sess-A`)).json()).messages;
  drained.length === 1 && drained[0].message === "from popup ws"
    ? ok("message landed in inbox") : bad("inbox wrong");
}

// ---- T8: register unknown session returns 404 for inbox/rename ----
console.log("T8 — operations on unknown session fail cleanly");
{
  const r = await fetch(`${BASE}/claude/inbox`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "does-not-exist", message: "x" }),
  });
  r.status === 404 ? ok("inbox push to unknown → 404") : bad(`status=${r.status}`);
  const r2 = await fetch(`${BASE}/claude/rename`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "does-not-exist", name: "y" }),
  });
  r2.status === 404 ? ok("rename unknown → 404") : bad(`status=${r2.status}`);
}

// ---- T9: unregister removes + broadcasts ----
console.log("T9 — POST /claude/unregister");
{
  const before = updates.length;
  const r = await postJson("/claude/unregister", { sessionId: "sess-A" });
  r.ok === true ? ok("unregister ok") : bad("unregister failed");
  await sleep(20);
  const list = (await (await fetch(`${BASE}/claude/sessions`)).json()).sessions;
  list.length === 0 ? ok("session list empty after unregister") : bad("session still present");
  updates.length > before ? ok("broadcast fired on unregister") : bad("no broadcast on unregister");
}

// ---- T10: bad requests rejected ----
console.log("T10 — bad input rejected with 400");
{
  const r = await fetch(`${BASE}/claude/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),  // missing sessionId
  });
  r.status === 400 ? ok("register w/o sessionId → 400") : bad(`status=${r.status}`);
  const r2 = await fetch(`${BASE}/claude/inbox?missingArg=1`);
  r2.status === 400 ? ok("inbox GET w/o sessionId → 400") : bad(`status=${r2.status}`);
  const r3 = await fetch(`${BASE}/claude/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: "{this is not json",
  });
  r3.status === 400 ? ok("malformed JSON → 400") : bad(`status=${r3.status}`);
}

ext.close();
bridge.shutdown();
console.log("─────────────────────");
console.log(`passed: ${pass}`);
console.log(`failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);

// ---- helpers ----
async function postJson(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
