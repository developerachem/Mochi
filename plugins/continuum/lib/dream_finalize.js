#!/usr/bin/env node
// dream_finalize: atomically commits a rollup.
//   1. Writes the new digest as a normal link (next id), with tags including "phase-digest".
//   2. MOVES each rollup-id's directory from chain/links/NNNN/ to chain/links/_archived/NNNN/.
//      (PRD §7.4: originals never deleted, never mutated.)
//   3. APPENDS a tombstone entry to index.jsonl for each archived link:
//      {tombstone: true, id: <N>, supersededBy: <digestId>, ts}
//   4. Clears the .pending-checkpoint sentinel if present (rollup satisfies it).
//
// Reads digest summary from stdin.
//
// Usage:
//   cat digest.md | node dream_finalize.js \
//     --rollup-ids "3,4,5,6,7" \
//     [--tags "phase-digest,auth,db"] \
//     [--project-dir <path>]
//
// Prints the new digest link id on success (e.g. "0008").

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { paths, estimateTokens, loadIndex } from "./paths.js";

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

function readAllStdin() {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(""));
  });
}

function gitCommit(cwd) {
  try {
    return execSync("git rev-parse HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch { return null; }
}

function nextLinkId(p) {
  // Next id is max(existing real ids) + 1, including archived (because they STILL occupy ids).
  if (!fs.existsSync(p.indexJsonl)) return 1;
  const lines = fs.readFileSync(p.indexJsonl, "utf8").split("\n").filter(Boolean);
  let maxId = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.tombstone) continue;
      if (typeof e.id === "number" && e.id > maxId) maxId = e.id;
    } catch {}
  }
  return maxId + 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const summary = (await readAllStdin()).trim();

  if (!summary) {
    process.stderr.write("dream_finalize: empty digest summary on stdin\n");
    process.exit(1);
  }
  if (!args["rollup-ids"] || typeof args["rollup-ids"] !== "string") {
    process.stderr.write("dream_finalize: --rollup-ids \"id1,id2,...\" is required\n");
    process.exit(1);
  }

  const rollupIds = String(args["rollup-ids"]).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  if (rollupIds.length < 2) {
    process.stderr.write("dream_finalize: refusing — need at least 2 ids to roll up\n");
    process.exit(1);
  }

  const p = paths(projectDir);
  if (!fs.existsSync(p.indexJsonl)) {
    process.stderr.write("dream_finalize: no chain found (chain/index.jsonl missing)\n");
    process.exit(1);
  }

  // Sanity: all rollup ids must currently exist as live link dirs
  for (const id of rollupIds) {
    const dir = path.join(p.linksDir, String(id).padStart(4, "0"));
    if (!fs.existsSync(dir)) {
      process.stderr.write(`dream_finalize: link ${id} not found at ${dir} (already archived?)\n`);
      process.exit(1);
    }
  }

  // 1. Write the new digest link
  const tags = (args.tags && typeof args.tags === "string")
    ? args.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : ["phase-digest"];
  if (!tags.includes("phase-digest")) tags.push("phase-digest");

  const id = nextLinkId(p);
  const idStr = String(id).padStart(4, "0");
  const linkDir = path.join(p.linksDir, idStr);
  fs.mkdirSync(linkDir, { recursive: true });
  const ts = new Date().toISOString();
  const commit = gitCommit(projectDir);

  fs.writeFileSync(path.join(linkDir, "summary.md"), summary + "\n");
  fs.writeFileSync(path.join(linkDir, "refs.json"), JSON.stringify({ rolledUpIds: rollupIds }, null, 2) + "\n");
  fs.writeFileSync(path.join(linkDir, "meta.json"), JSON.stringify({
    commit_id: commit,
    parent_link: rollupIds[rollupIds.length - 1],
    rolled_up_ids: rollupIds,
    created_at: ts,
    kind: "phase-digest",
  }, null, 2) + "\n");

  // 2. Append digest entry to index.jsonl
  fs.appendFileSync(p.indexJsonl, JSON.stringify({
    id,
    ts,
    commit,
    summary_tokens: estimateTokens(summary),
    tags,
    rolledUpIds: rollupIds,
  }) + "\n");

  // 3. MOVE originals to _archived/
  const archivedRoot = path.join(p.linksDir, "_archived");
  fs.mkdirSync(archivedRoot, { recursive: true });
  for (const rid of rollupIds) {
    const ridStr = String(rid).padStart(4, "0");
    const src = path.join(p.linksDir, ridStr);
    const dst = path.join(archivedRoot, ridStr);
    if (fs.existsSync(dst)) {
      process.stderr.write(`dream_finalize: WARNING — archived slot already exists at ${dst}, leaving original in place\n`);
      continue;
    }
    fs.renameSync(src, dst);
  }

  // 4. Append tombstone entries (one per archived id)
  for (const rid of rollupIds) {
    fs.appendFileSync(p.indexJsonl, JSON.stringify({
      tombstone: true,
      id: rid,
      supersededBy: id,
      ts,
    }) + "\n");
  }

  // 5. Clear pending-checkpoint sentinel if present
  const sentinel = path.join(p.root, ".pending-checkpoint");
  if (fs.existsSync(sentinel)) { try { fs.unlinkSync(sentinel); } catch {} }

  process.stdout.write(idStr + "\n");
}

main().catch((err) => {
  process.stderr.write(`dream_finalize: ${err?.message ?? err}\n`);
  process.exit(1);
});
