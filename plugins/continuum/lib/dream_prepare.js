#!/usr/bin/env node
// dream_prepare: gathers the inputs the agent needs to compose a rollup digest.
//
// Output (stdout, JSON):
//   {
//     rollupCandidateIds: [3,4,5,6,7],
//     summaries: { "3": "...", "4": "...", ... },
//     tagsUnion: ["auth","mfa","db","ui","button","rate-limit"],
//     tsRange: ["2026-05-10T...","2026-05-18T..."],
//     warnings: [...] // e.g. fewer-than-N candidates
//   }
//
// Selection: most-recent N ACTIVE (non-archived) non-digest links.
// "non-digest" means tags do not include "phase-digest".

import { loadActiveIndex, readLinkSummary } from "./paths.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      args[key] = (next === undefined || next.startsWith("--")) ? true : argv[++i];
    }
  }
  return args;
}

function isDigest(entry) {
  return Array.isArray(entry.tags) && entry.tags.includes("phase-digest");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const n = Number(args.n ?? 25);

  const active = loadActiveIndex(projectDir);
  const rollable = active.filter((e) => !isDigest(e));
  const candidates = rollable.slice(-n);
  const warnings = [];
  if (candidates.length < n) warnings.push(`Only ${candidates.length} rollable link(s) available (requested ${n}).`);
  if (candidates.length < 2) warnings.push(`Refusing to roll up <2 links — nothing to consolidate.`);

  const summaries = {};
  const tagsSet = new Set();
  for (const e of candidates) {
    summaries[String(e.id)] = readLinkSummary(projectDir, e.id, false) || "(summary missing)";
    for (const t of (e.tags || [])) tagsSet.add(t);
  }

  const ids = candidates.map((e) => e.id);
  const tsRange = candidates.length > 0
    ? [candidates[0].ts || null, candidates[candidates.length - 1].ts || null]
    : [null, null];

  process.stdout.write(JSON.stringify({
    rollupCandidateIds: ids,
    summaries,
    tagsUnion: [...tagsSet].sort(),
    tsRange,
    warnings,
    canProceed: candidates.length >= 2,
  }, null, 2) + "\n");
}

main();
