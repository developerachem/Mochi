#!/usr/bin/env node
// Stop hook: fires when the agent is about to stop a turn (i.e. just
// finished its response, about to yield to the user). If the popup-message
// inbox has pending hints at this moment, we BLOCK the stop with the hint
// as the reason — the agent will continue this turn and address the hint
// instead of forcing the user to type a follow-up prompt.
//
// This catches the "user sent hint right as the agent finished" case so the
// hint lands in the same turn rather than queuing for the next one.
//
// Same sentinel-fast-skip optimisation as PreToolUse: typical idle cost
// ~1ms, only hits HTTP when there's actually something to drain.

import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { drainInbox } from "../lib/broker.js";
import { formatHints } from "../lib/hint_formatter.js";

async function readStdin() {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(d), 100);
  });
}

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let sessionId = payload.session_id || null;

  const sentinel = path.join(projectDir, ".continuum", ".inbox-flag");
  if (!fs.existsSync(sentinel)) { process.exit(0); return; }

  if (!sessionId) {
    try {
      const p = paths(projectDir);
      if (fs.existsSync(p.sessionIdFile)) sessionId = fs.readFileSync(p.sessionIdFile, "utf8").trim();
    } catch {}
  }
  if (!sessionId) { process.exit(0); return; }

  const { messages } = await drainInbox({ sessionId });
  if (!messages || !messages.length) {
    try { fs.unlinkSync(sentinel); } catch {}
    process.exit(0); return;
  }

  // Block the stop. `reason` becomes the message the agent reads on its
  // continued turn. Same formatter as PreToolUse for consistency.
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: formatHints(messages, projectDir, sessionId),
  }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[continuum:stop] ${err?.message ?? err}\n`);
  process.exit(0);
});
