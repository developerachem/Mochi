#!/usr/bin/env node
// PreToolUse: fires before EVERY tool call (built-in or MCP, with matcher "*").
// Drains the Mochi popup-message inbox for this session and injects whatever
// the user queued as a system reminder via hookSpecificOutput.additionalContext.
// Claude reads it before deciding on its next tool — so the message lands
// without interrupting the agent mid-thought.
//
// Hot path: this runs on every tool call. Fast-skips via sentinel file
// (.continuum/.inbox-flag, written by the broker on push, deleted on drain).
// If no sentinel → exit 0 with no body (~1ms).

import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { drainInbox } from "../lib/broker.js";

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
      hookEventName: "PreToolUse",
      additionalContext: text,
    },
  }));
  process.exit(0);
}

function formatHints(messages) {
  const lines = [];
  lines.push("**Mochi**");
  lines.push("");
  for (const m of messages) {
    lines.push(`> ${m.message || "(empty message)"}`);
    const ctx = m.context || {};
    const bits = [];
    if (ctx.url)       bits.push(`url: \`${ctx.url}\``);
    if (ctx.title)     bits.push(`title: "${ctx.title}"`);
    if (ctx.viewport)  bits.push(`viewport: ${ctx.viewport}`);
    if (bits.length)   lines.push(`> _${bits.join(" · ")}_`);
    if (Array.isArray(ctx.recentErrors) && ctx.recentErrors.length) {
      lines.push(`> _recent console errors:_`);
      for (const e of ctx.recentErrors.slice(0, 5)) lines.push(`>   • \`${String(e).replace(/`/g, "'")}\``);
    }
    const el = ctx.pickedElement;
    if (el && (el.selector || el.outerHTML)) {
      lines.push(`> _user picked DOM element:_`);
      if (el.selector)  lines.push(`>   • selector: \`${String(el.selector).replace(/`/g, "'")}\``);
      if (el.tagName)   lines.push(`>   • tag: \`<${el.tagName}>\``);
      if (el.rect)      lines.push(`>   • rect: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} @ (${Math.round(el.rect.x)},${Math.round(el.rect.y)})`);
      if (el.text)      lines.push(`>   • text: "${String(el.text).slice(0, 120).replace(/"/g, "'")}${el.text.length > 120 ? "…" : ""}"`);
      if (el.outerHTML) {
        const snippet = String(el.outerHTML).slice(0, 400).replace(/\n/g, " ").replace(/`/g, "'");
        lines.push(`>   • outerHTML: \`${snippet}${el.outerHTML.length > 400 ? "…" : ""}\``);
      }
    }
    lines.push(`> _sent ${m.ts}_`);
    lines.push("");
  }
  lines.push("React to the hint(s) in your next reply or action. They have already been removed from the inbox.");
  return lines.join("\n");
}

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let sessionId = payload.session_id || null;

  // Fast-skip: if no sentinel, no message — exit ~immediately.
  const sentinel = path.join(projectDir, ".continuum", ".inbox-flag");
  if (!fs.existsSync(sentinel)) { process.exit(0); return; }

  // Recover sessionId from the file SessionStart writes, if not in stdin.
  if (!sessionId) {
    try {
      const p = paths(projectDir);
      if (fs.existsSync(p.sessionIdFile)) sessionId = fs.readFileSync(p.sessionIdFile, "utf8").trim();
    } catch {}
  }
  if (!sessionId) { process.exit(0); return; }

  const { messages } = await drainInbox({ sessionId });
  if (!messages || !messages.length) {
    // Self-clean the sentinel if the broker didn't (e.g. session not
    // registered on the broker side — orphan flag from a prior run). Without
    // this, every tool call would re-hit HTTP for nothing.
    try { fs.unlinkSync(sentinel); } catch {}
    process.exit(0); return;
  }

  emit(formatHints(messages));
}

main().catch((err) => {
  process.stderr.write(`[continuum:pre_tool_use] ${err?.message ?? err}\n`);
  process.exit(0);
});
