#!/usr/bin/env node
// UserPromptSubmit hook: fires when the user submits a new prompt. If the
// popup-message inbox has anything queued (because the agent was idle when
// the user sent a hint via the modal), drain it and inject as
// additionalContext so the agent sees the hint TOGETHER with the user's
// just-typed prompt — no separate prompt needed.
//
// Same sentinel-fast-skip pattern as PreToolUse and Stop.

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

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  }));
  process.exit(0);
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

  emit(formatHints(messages, projectDir, sessionId));
}

main().catch((err) => {
  process.stderr.write(`[continuum:user_prompt_submit] ${err?.message ?? err}\n`);
  process.exit(0);
});
