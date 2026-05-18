#!/usr/bin/env node
// PostToolUse: if the agent just wrote/edited a frontend file, emit a
// directive telling it to verify the change at the configured viewport
// breakpoints using Mochi's browser MCP tools (before declaring complete).
// Also append a record to .continuum/.frontend-changes.jsonl so the next
// /continuum:checkpoint can surface verification status into the link.
//
// Pure side-effect when the edit is non-frontend or frontend_verify is off.

import { readConfig } from "../lib/paths.js";
import { matchAny } from "../lib/glob.js";
import { recordChange } from "../lib/verification_log.js";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  }));
  process.exit(0);
}

function rel(projectDir, p) {
  if (!p) return p;
  if (p.startsWith(projectDir + "/")) return p.slice(projectDir.length + 1);
  return p;
}

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const toolName = payload.tool_name || payload.toolName || "";
  if (!FILE_EDIT_TOOLS.has(toolName)) { process.exit(0); return; }

  // tool_input shape: { file_path: "...", ... } for Write/Edit/MultiEdit
  const input = payload.tool_input || payload.toolInput || {};
  const filePath = input.file_path || input.notebook_path || null;
  if (!filePath || typeof filePath !== "string") { process.exit(0); return; }

  const cfg = readConfig(projectDir);
  if (cfg.frontend_verify === false) { process.exit(0); return; }
  const relPath = rel(projectDir, filePath);

  const globs = Array.isArray(cfg.frontend_globs) && cfg.frontend_globs.length
    ? cfg.frontend_globs : ["src/**/*.{tsx,jsx,vue,svelte,css}"];
  if (!matchAny(relPath, globs)) { process.exit(0); return; }

  recordChange(projectDir, { filePath: relPath, tool: toolName });

  const breakpoints = Array.isArray(cfg.frontend_breakpoints_px) && cfg.frontend_breakpoints_px.length
    ? cfg.frontend_breakpoints_px : [375, 768, 1280];

  const lines = [];
  lines.push(`**Frontend file edited: \`${relPath}\`** — before you declare this complete, verify it visually.`);
  lines.push("");
  lines.push("If a Mochi browser session is active (or you can start one), run this verification loop:");
  lines.push("");
  lines.push("1. Identify the URL where this change manifests (dev server URL — ask the user if you don't have it).");
  for (let i = 0; i < breakpoints.length; i++) {
    const bp = breakpoints[i];
    lines.push(`${i + 2}. \`mcp__browser__browser_emulate_viewport({ width: ${bp}, height: ${Math.round(bp * 0.75)} })\` → \`browser_navigate(url)\` → \`browser_screenshot()\` → \`browser_console_messages({ level: "error" })\`.`);
  }
  lines.push("");
  lines.push("Record each viewport's outcome (pass/fail + a one-line note) and report back. Failures should become open threads in the next `/continuum:checkpoint` so they survive into the next session.");
  lines.push("");
  lines.push(`_continuum: this change is logged at \`.continuum/.frontend-changes.jsonl\`. \`/continuum:checkpoint\` will surface its verification status into the new link automatically._`);

  emit(lines.join("\n"));
}

main().catch(() => process.exit(0));
