#!/usr/bin/env node
// Prints a human-readable status block for the continuum chain in the current
// (or --project-dir) repo. Pure read-only.

import fs from "node:fs";
import path from "node:path";
import { paths, isBootstrapped, readIndexTail, readStateMd, readConfig, estimateTokens } from "./paths.js";
import { readSentinel } from "./archive.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else { try { total += fs.statSync(full).size; } catch {} }
  }
  return total;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function countLines(text) {
  if (!text) return 0;
  return text.split("\n").length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const p = paths(projectDir);
  const cfg = readConfig(projectDir);

  const out = [];
  out.push(`# continuum status — ${path.basename(projectDir)}`);
  out.push("");
  out.push(`**Project dir:** \`${projectDir}\``);
  out.push(`**Continuum root:** \`${p.root}\``);

  if (!isBootstrapped(projectDir)) {
    out.push("");
    out.push("⚠  **Not bootstrapped.** No `chain/index.jsonl` yet. Start a fresh Claude session to trigger SessionStart bootstrap.");
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  // Count links
  const allLines = fs.readFileSync(p.indexJsonl, "utf8").split("\n").filter(Boolean);
  const links = allLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const lastLink = links[links.length - 1];

  // STATE.md health
  const stateMd = readStateMd(projectDir);
  const stateLines = countLines(stateMd);
  const stateTokens = estimateTokens(stateMd);
  const stateOver = stateLines > cfg.state_md_line_cap;

  // Archive size
  const archiveBytes = dirSize(p.archiveDir);
  const archiveFiles = fs.existsSync(p.archiveDir) ? fs.readdirSync(p.archiveDir).filter((f) => !f.startsWith(".")).length : 0;

  // Sentinel
  const sentinel = readSentinel(projectDir);

  out.push("");
  out.push(`**Chain:** ${links.length} link${links.length === 1 ? "" : "s"}`);
  if (lastLink) {
    out.push(`  • latest: \`${String(lastLink.id).padStart(4, "0")}\` — ${lastLink.ts ?? "?"} (commit: ${lastLink.commit ? lastLink.commit.slice(0, 8) : "n/a"})`);
    if (lastLink.tags && lastLink.tags.length) out.push(`  • tags: ${lastLink.tags.join(", ")}`);
  }
  out.push("");
  out.push(`**STATE.md:** ${stateLines} lines (cap ${cfg.state_md_line_cap}), ≈${stateTokens} tokens ${stateOver ? "⚠ OVER cap — consider /continuum:checkpoint or a rollup" : "✓"}`);
  out.push(`**Archive:** ${archiveFiles} file${archiveFiles === 1 ? "" : "s"}, ${fmtBytes(archiveBytes)} total`);

  if (sentinel) {
    out.push("");
    out.push(`⚠  **Pending checkpoint:** ${sentinel.trigger ?? "?"} (${sentinel.matcher ?? sentinel.why_session_ended ?? "?"}) at ${sentinel.ts ?? "?"}`);
    if (sentinel.archive_path) out.push(`   archived transcript: \`${sentinel.archive_path}\``);
    out.push(`   → run \`/continuum:checkpoint\` to commit it to the chain.`);
  }

  out.push("");
  out.push(`**Recent links (last ${Math.min(5, links.length)}):**`);
  for (const l of links.slice(-5)) {
    const tags = (l.tags && l.tags.length) ? ` [${l.tags.join(",")}]` : "";
    out.push(`  ${String(l.id).padStart(4, "0")}  ${l.ts ?? "?"}  ≈${l.summary_tokens ?? "?"}tok${tags}`);
  }

  process.stdout.write(out.join("\n") + "\n");
}

main();
