#!/usr/bin/env node
// Decompress a .jsonl.gz transcript archive and print a human-readable
// summary: turn count, durations, tool calls, errors. Useful for inspecting
// what got archived during a PreCompact/SessionEnd before deciding whether
// to write a retroactive checkpoint.
//
// Usage:
//   node render_archive.js <path-to-archive.jsonl.gz> [--full]
//   node render_archive.js --link 0007 [--project-dir DIR] [--full]
//   node render_archive.js --latest [--project-dir DIR] [--full]
//
// --full prints every record one per line instead of just a summary.

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { paths } from "./paths.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      args[k] = (n === undefined || n.startsWith("--")) ? true : argv[++i];
    } else args._.push(a);
  }
  return args;
}

function loadArchive(file) {
  if (!fs.existsSync(file)) throw new Error(`archive not found: ${file}`);
  const buf = fs.readFileSync(file);
  const raw = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { _bad: line.slice(0, 120) }; }
  });
}

function findLatestArchive(projectDir) {
  const dir = paths(projectDir).archiveDir;
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz"));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

function summarize(records) {
  const counts = { user: 0, assistant: 0, tool_use: 0, tool_result: 0, other: 0 };
  const tools = new Map();
  const errors = [];
  let firstTs = null, lastTs = null;

  for (const r of records) {
    const role = r.role || r.message?.role || r.type || "other";
    if (counts[role] !== undefined) counts[role]++;
    else counts.other++;

    const ts = r.ts || r.timestamp || r.message?.created_at;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    // Try to detect tool calls in a few common shapes
    if (r.tool_name) tools.set(r.tool_name, (tools.get(r.tool_name) || 0) + 1);
    if (Array.isArray(r.content)) {
      for (const block of r.content) {
        if (block && block.type === "tool_use" && block.name) {
          tools.set(block.name, (tools.get(block.name) || 0) + 1);
        }
        if (block && block.type === "tool_result" && block.is_error) {
          errors.push(typeof block.content === "string" ? block.content.slice(0, 200) : "(error)");
        }
      }
    }
  }

  return { total: records.length, counts, tools, errors, firstTs, lastTs };
}

function renderSummary(file, sum) {
  const lines = [];
  lines.push(`# Archive: ${file}`);
  lines.push("");
  lines.push(`**Records:** ${sum.total}`);
  if (sum.firstTs && sum.lastTs && sum.firstTs !== sum.lastTs) {
    lines.push(`**Span:** ${sum.firstTs} → ${sum.lastTs}`);
  }
  lines.push("");
  lines.push("**By role/type:**");
  for (const [k, v] of Object.entries(sum.counts)) {
    if (v) lines.push(`  ${k}: ${v}`);
  }
  if (sum.tools.size) {
    lines.push("");
    lines.push("**Tool calls:**");
    const sorted = [...sum.tools.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) lines.push(`  ${name}: ${count}`);
  }
  if (sum.errors.length) {
    lines.push("");
    lines.push(`**Errors (${sum.errors.length}):**`);
    for (const e of sum.errors.slice(0, 10)) lines.push(`  - ${e}`);
    if (sum.errors.length > 10) lines.push(`  …and ${sum.errors.length - 10} more`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  let file;
  if (args._[0]) {
    file = args._[0];
  } else if (args.latest) {
    file = findLatestArchive(projectDir);
    if (!file) { process.stderr.write("no archives found\n"); process.exit(1); }
  } else if (args.link) {
    process.stderr.write("--link lookup is not yet supported (archives aren't keyed by link id). Use --latest or pass a path.\n");
    process.exit(2);
  } else {
    process.stderr.write("usage: render_archive.js <file> | --latest | --link N\n");
    process.exit(2);
  }

  const records = loadArchive(file);
  if (args.full) {
    process.stdout.write(`# Archive: ${file}\n# ${records.length} records\n\n`);
    for (const r of records) {
      try { process.stdout.write(JSON.stringify(r) + "\n"); }
      catch { process.stdout.write("(unserializable)\n"); }
    }
    return;
  }
  process.stdout.write(renderSummary(file, summarize(records)) + "\n");
}

try { main(); } catch (e) {
  process.stderr.write(`render_archive: ${e?.message ?? e}\n`);
  process.exit(1);
}
