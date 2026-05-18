// End-to-end synthetic test for the popup-messaging track:
//   broker HTTP routes  →  continuum hooks  →  PreToolUse drain  →  additionalContext
//
// Spins up a real Bridge on an off-default port and runs the actual hook
// scripts as subprocesses with $CONTINUUM_BROKER_URL pointing at it.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bridge } from "../../../server/src/bridge.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 19009;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (m) => { console.log("  ✓", m); pass++; };
const bad = (m) => { console.log("  ✗", m); fail++; };

// ---- spin up broker --------------------------------------------------------
const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: PORT });
if (role !== "broker") {
  console.error("could not bind broker on", PORT, "—", bridge.lastError);
  process.exit(1);
}

// ---- prepare a fake project dir with .continuum/ ---------------------------
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-popup-e2e-"));
fs.mkdirSync(path.join(REPO, ".continuum/chain/links"), { recursive: true });
fs.mkdirSync(path.join(REPO, ".continuum/archive/transcripts"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".continuum/chain/index.jsonl"), "");

// Init git so SessionStart can compute a branch for the default name.
spawnSync("git", ["init", "-q"], { cwd: REPO, stdio: "ignore" });
spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: REPO, stdio: "ignore" });
spawnSync("git", ["checkout", "-q", "-b", "popup-test"], { cwd: REPO, stdio: "ignore" });

const SESSION_ID = "sess-popup-e2e";

const ENV = {
  ...process.env,
  CONTINUUM_BROKER_URL: BASE,
  CONTINUUM_BROKER_TIMEOUT_MS: "2000",
};

// MUST be async (spawn, not spawnSync) — the broker runs in this same
// process, so a synchronous wait would block its HTTP event loop and the
// subprocess's fetch would hang.
function runProc(cmd, args, { input = "", env = ENV } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.on("error", (err) => resolve({ status: -1, stdout, stderr: String(err) }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function runHook(hookFile, payload) {
  return runProc("node", [path.join(PLUGIN_DIR, "hooks", hookFile)], {
    input: JSON.stringify(payload),
  });
}

function runCli(libFile, args, input = "") {
  return runProc("node", [path.join(PLUGIN_DIR, "lib", libFile), ...args], { input });
}

async function fetchJson(p, opts) {
  const r = await fetch(`${BASE}${p}`, opts);
  return r.json();
}

// ---- T1: SessionStart registers with broker --------------------------------
console.log("T1 — SessionStart registers session with broker, name = '<base> · popup-test'");
{
  const r = await runHook("session_start.js", {
    session_id: SESSION_ID, transcript_path: "/tmp/x.jsonl",
    cwd: REPO, hook_event_name: "SessionStart", source: "startup",
  });
  if (r.status !== 0) bad(`hook exited ${r.status}: ${r.stderr}`);
  await sleep(80); // give async register call time to flush
  const list = (await fetchJson("/claude/sessions")).sessions;
  const found = list.find((s) => s.sessionId === SESSION_ID);
  if (!found) { bad("session not registered"); }
  else {
    ok(`registered, name="${found.name}"`);
    found.name.endsWith("· popup-test") ? ok("name has branch suffix") : bad(`name="${found.name}" missing branch`);
    found.projectDir === REPO ? ok("projectDir captured") : bad(`projectDir=${found.projectDir}`);
  }
}

// ---- T2: PreToolUse fast-path: no sentinel → no output ---------------------
console.log("T2 — PreToolUse with empty inbox returns empty (fast path)");
{
  // ensure no sentinel left
  try { fs.unlinkSync(path.join(REPO, ".continuum/.inbox-flag")); } catch {}
  const r = await runHook("pre_tool_use.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "PreToolUse",
    tool_name: "Read",
  });
  (r.status === 0 && r.stdout.trim() === "")
    ? ok("no output when inbox empty") : bad(`unexpected output: "${r.stdout}"`);
}

// ---- T3: Push a hint via HTTP → sentinel appears → PreToolUse drains it ----
console.log("T3 — push hint via HTTP, sentinel appears, PreToolUse emits additionalContext");
{
  await fetchJson("/claude/inbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      message: "try the discount-code path next",
      context: {
        url: "https://app.example.com/checkout",
        title: "Checkout",
        recentErrors: ["TypeError: cart.items.map is not a function"],
      },
    }),
  });
  await sleep(40);
  fs.existsSync(path.join(REPO, ".continuum/.inbox-flag"))
    ? ok("sentinel written by broker") : bad("sentinel not written");
  const r = await runHook("pre_tool_use.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "PreToolUse", tool_name: "Read",
  });
  if (r.status !== 0 || !r.stdout) { bad(`hook failed: status=${r.status} stderr=${r.stderr}`); }
  else {
    let parsed; try { parsed = JSON.parse(r.stdout); } catch { bad("bad JSON output"); parsed = null; }
    if (parsed) {
      const ctx = parsed.hookSpecificOutput?.additionalContext || "";
      parsed.hookSpecificOutput?.hookEventName === "PreToolUse"
        ? ok("hookEventName = PreToolUse") : bad("wrong hookEventName");
      ctx.includes("discount-code") ? ok("message text present") : bad("message text missing");
      ctx.includes("https://app.example.com/checkout") ? ok("url context present") : bad("url missing");
      ctx.includes("TypeError: cart.items.map") ? ok("error context present") : bad("error missing");
    }
  }
  await sleep(40);
  !fs.existsSync(path.join(REPO, ".continuum/.inbox-flag"))
    ? ok("sentinel cleared after drain") : bad("sentinel still present after drain");
}

// ---- T4: Second PreToolUse on empty inbox is fast/empty again --------------
console.log("T4 — drain is idempotent — second invocation returns nothing");
{
  const r = await runHook("pre_tool_use.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "PreToolUse", tool_name: "Bash",
  });
  r.stdout.trim() === "" ? ok("empty stdout after drain") : bad(`expected empty, got: ${r.stdout}`);
}

// ---- T5: /continuum:rename via CLI updates the broker registry -------------
console.log("T5 — rename_cli updates the broker registry");
{
  // Persist session-id file so rename_cli can find it (SessionStart did this already)
  const r = await runCli("rename_cli.js", ["--project-dir", REPO, "--", "Mochi", "demo", "popup"]);
  if (r.status !== 0) { bad(`rename exited ${r.status}: ${r.stderr}`); }
  else {
    let resp; try { resp = JSON.parse(r.stdout); } catch {}
    resp?.ok ? ok(`rename returned ok (name="${resp.name}")`) : bad(`rename failed: ${r.stdout}`);
  }
  await sleep(40);
  const list = (await fetchJson("/claude/sessions")).sessions;
  const s = list.find((x) => x.sessionId === SESSION_ID);
  s?.name === "Mochi demo popup" ? ok("broker has new name") : bad(`broker name=${s?.name}`);
}

// ---- T6: SessionEnd unregisters --------------------------------------------
console.log("T6 — SessionEnd unregisters session");
{
  const r = await runHook("session_end.js", {
    session_id: SESSION_ID, transcript_path: "/tmp/x.jsonl",
    cwd: REPO, hook_event_name: "SessionEnd", why_session_ended: "logout",
  });
  if (r.status !== 0) bad(`hook exited ${r.status}: ${r.stderr}`);
  await sleep(80);
  const list = (await fetchJson("/claude/sessions")).sessions;
  const stillThere = list.find((s) => s.sessionId === SESSION_ID);
  !stillThere ? ok("session removed from registry") : bad("session still in registry");
}

// ---- T6.5: Picked DOM element survives through to additionalContext -------
console.log("T6.5 — picked DOM element flows through inbox → hook → additionalContext");
{
  // Re-register the session (T6 unregistered it).
  await fetchJson("/claude/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, name: "picker-test", projectDir: REPO }),
  });
  await sleep(20);
  await fetchJson("/claude/inbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      message: "fix this element",
      context: {
        url: "https://app/checkout",
        pickedElement: {
          selector: "div.cart-total#cart-total",
          tagName: "div",
          outerHTML: '<div class="cart-total" id="cart-total">$39</div>',
          text: "$39",
          rect: { x: 100, y: 200, width: 80, height: 24 },
        },
      },
    }),
  });
  await sleep(30);
  const r = await runHook("pre_tool_use.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "PreToolUse", tool_name: "Read",
  });
  if (r.status !== 0 || !r.stdout) { bad(`hook failed: ${r.stderr}`); }
  else {
    const ctx = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext || "";
    ctx.includes("user picked DOM element") ? ok("picked-element section rendered") : bad("element section missing");
    ctx.includes("div.cart-total") ? ok("selector present in context") : bad("selector missing");
    ctx.includes("80×24") ? ok("rect dimensions present") : bad("rect missing");
    ctx.includes('"$39"') ? ok("text content present") : bad("text missing");
  }
  // Cleanup: unregister so T6 logic below is consistent
  await fetchJson("/claude/unregister", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
}

// ---- T6.7: Screenshot data URI in context → saved to .continuum/screenshots ----
console.log("T6.7 — screenshot context is saved to disk + referenced in hook output");
{
  await fetchJson("/claude/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, name: "shot-test", projectDir: REPO }),
  });
  await sleep(20);
  // 1x1 transparent PNG — smallest possible valid file.
  const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await fetchJson("/claude/inbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      message: "see what's wrong here",
      context: {
        viewport: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2, scrollY: 100, scrollX: 0, scrollHeight: 2000, scrollWidth: 1280 },
        screenshot: {
          dataUri: `data:image/png;base64,${TINY_PNG}`,
          scope: "parent",
          rect: { x: 100, y: 200, width: 320, height: 180 },
          format: "png",
        },
      },
    }),
  });
  await sleep(30);
  const r = await runHook("pre_tool_use.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "PreToolUse", tool_name: "Read",
  });
  if (r.status !== 0 || !r.stdout) { bad(`hook failed: ${r.stderr}`); }
  else {
    const ctx = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext || "";
    ctx.includes("viewport: 1280×720 @2x") ? ok("viewport rendered with dpr") : bad("viewport line missing");
    ctx.includes("scroll (0,100)") ? ok("scroll position rendered") : bad("scroll missing");
    ctx.includes("page 1280×2000") ? ok("full page dims rendered") : bad("page dims missing");
    ctx.includes("screenshot:") ? ok("screenshot mention present") : bad("screenshot mention missing");
    ctx.includes("scope=parent") ? ok("scope reported") : bad("scope missing");
    ctx.includes("Read(") ? ok("agent instructed to use Read") : bad("Read instruction missing");
    // Confirm file actually exists on disk
    const fs = await import("node:fs");
    const path = await import("node:path");
    const shotDir = path.default.join(REPO, ".continuum", "screenshots");
    const files = fs.default.existsSync(shotDir) ? fs.default.readdirSync(shotDir).filter(f => f.endsWith(".png")) : [];
    files.length >= 1 ? ok(`screenshot file written (${files.length} on disk)`) : bad("no screenshot file");
  }
  await fetchJson("/claude/unregister", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
}

// ---- T8: Stop hook blocks with hint as reason ------------------------------
console.log("T8 — Stop hook drains inbox and emits {decision:block, reason}");
{
  await fetchJson("/claude/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, name: "stop-test", projectDir: REPO }),
  });
  await sleep(20);
  await fetchJson("/claude/inbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      message: "please address this before stopping",
    }),
  });
  await sleep(30);
  const r = await runHook("stop.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "Stop",
  });
  if (r.status !== 0 || !r.stdout) { bad(`hook failed: ${r.stderr}`); }
  else {
    let parsed; try { parsed = JSON.parse(r.stdout); } catch { bad("bad JSON output"); parsed = null; }
    if (parsed) {
      parsed.decision === "block" ? ok("emits decision:block") : bad(`decision=${parsed.decision}`);
      String(parsed.reason || "").includes("please address this")
        ? ok("reason contains hint text") : bad("reason missing hint");
      String(parsed.reason || "").includes("**Mochi**")
        ? ok("reason uses Mochi formatter") : bad("Mochi header missing in reason");
    }
  }
  // Stop hook with empty inbox should NOT block
  const r2 = await runHook("stop.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "Stop",
  });
  r2.stdout.trim() === "" ? ok("empty inbox → no block") : bad(`unexpected stop output: ${r2.stdout}`);
  await fetchJson("/claude/unregister", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
}

// ---- T9: UserPromptSubmit drains + injects additionalContext --------------
console.log("T9 — UserPromptSubmit hook drains queued hints");
{
  await fetchJson("/claude/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, name: "ups-test", projectDir: REPO }),
  });
  await sleep(20);
  await fetchJson("/claude/inbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      message: "queued while idle",
    }),
  });
  await sleep(30);
  const r = await runHook("user_prompt_submit.js", {
    session_id: SESSION_ID, cwd: REPO, hook_event_name: "UserPromptSubmit",
    prompt: "ok what's next",
  });
  if (r.status !== 0 || !r.stdout) { bad(`hook failed: ${r.stderr}`); }
  else {
    const parsed = JSON.parse(r.stdout);
    parsed.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
      ? ok("hookEventName = UserPromptSubmit") : bad("wrong hookEventName");
    const ctx = parsed.hookSpecificOutput?.additionalContext || "";
    ctx.includes("queued while idle") ? ok("hint merged into prompt context") : bad("hint missing");
  }
  await fetchJson("/claude/unregister", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
}

// ---- T7: Hook silently no-ops if broker is offline -------------------------
console.log("T7 — hooks survive when broker offline (use bogus URL)");
{
  const offlineEnv = { ...process.env, CONTINUUM_BROKER_URL: "http://127.0.0.1:1", CONTINUUM_BROKER_TIMEOUT_MS: "300" };
  const r = await runProc("node", [path.join(PLUGIN_DIR, "hooks", "pre_tool_use.js")], {
    input: JSON.stringify({
      session_id: "offline-test", cwd: REPO, hook_event_name: "PreToolUse", tool_name: "Read",
    }),
    env: offlineEnv,
  });
  // No sentinel exists; should fast-skip before even trying broker.
  (r.status === 0 && r.stdout.trim() === "") ? ok("PreToolUse silent when broker offline + no sentinel")
    : bad(`unexpected: status=${r.status} stdout=${r.stdout}`);
}

// ---- cleanup ---------------------------------------------------------------
bridge.shutdown();
fs.rmSync(REPO, { recursive: true, force: true });

console.log("─────────────────────");
console.log(`passed: ${pass}`);
console.log(`failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
