#!/usr/bin/env node
// Prints the current frontend-changes log summary for the agent to read
// during /continuum:checkpoint. Pure read.
//
// Usage: node verify_status_cli.js [--project-dir DIR] [--json]

import { readLog, summarize } from "./verification_log.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      args[k] = (n === undefined || n.startsWith("--")) ? true : argv[++i];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const log = readLog(projectDir);
  const s = summarize(log);

  if (args.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return;
  }

  if (s.changedCount === 0) {
    process.stdout.write("(no frontend changes since last checkpoint)\n");
    return;
  }

  const lines = [];
  lines.push(`Frontend changes since last checkpoint: ${s.changedCount}`);
  for (const p of s.changed) lines.push(`  - ${p}`);
  lines.push("");
  if (s.unverifiedCount > 0) {
    lines.push(`UNVERIFIED (${s.unverifiedCount}):`);
    for (const p of s.unverified) lines.push(`  - ${p}`);
    lines.push("");
  }
  if (s.failureCount > 0) {
    lines.push(`FAILURES (${s.failureCount}):`);
    for (const f of s.failures) {
      lines.push(`  - ${f.path} @ ${f.viewport ?? "?"}: ${f.status} ${f.notes ? "— " + f.notes : ""}`);
    }
    lines.push("");
  }
  const passes = s.verifications.filter((v) => v.status === "pass");
  if (passes.length) {
    lines.push(`Passes (${passes.length}):`);
    for (const v of passes) lines.push(`  - ${v.path} @ ${v.viewport ?? "?"}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

main();
