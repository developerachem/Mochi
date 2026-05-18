#!/usr/bin/env node
// Writes a new link to the chain. Mechanical bookkeeping only — the summary
// content itself must be composed by the agent and piped in on stdin.
//
// Usage:
//   echo "<summary markdown>" | node write_link.js \
//     [--project-dir <path>] \
//     [--tags tag1,tag2] \
//     [--refs '{"anchor":"offset"}'] \
//     [--parent <prev-link-id>]
//
// Prints the new link id (zero-padded) to stdout on success.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { paths, estimateTokens } from "./paths.js";

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

function readAllStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
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
  if (!fs.existsSync(p.indexJsonl)) return 1;
  const lines = fs.readFileSync(p.indexJsonl, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return 1;
  const last = JSON.parse(lines[lines.length - 1]);
  return (last.id ?? 0) + 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const summary = (await readAllStdin()).trim();

  if (!summary) {
    process.stderr.write("write_link: empty summary on stdin\n");
    process.exit(1);
  }

  const p = paths(projectDir);
  fs.mkdirSync(p.linksDir, { recursive: true });
  fs.mkdirSync(p.archiveDir, { recursive: true });

  const id = nextLinkId(p);
  const idStr = String(id).padStart(4, "0");
  const linkDir = path.join(p.linksDir, idStr);
  fs.mkdirSync(linkDir, { recursive: true });

  const tags = (args.tags && typeof args.tags === "string")
    ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  let refs = {};
  if (args.refs && typeof args.refs === "string") {
    try { refs = JSON.parse(args.refs); } catch {
      process.stderr.write(`write_link: --refs is not valid JSON\n`);
      process.exit(1);
    }
  }

  const ts = new Date().toISOString();
  const commit = gitCommit(projectDir);
  const parent = (args.parent && args.parent !== "null") ? Number(args.parent) : (id > 1 ? id - 1 : null);
  const summaryTokens = estimateTokens(summary);

  fs.writeFileSync(path.join(linkDir, "summary.md"), summary + "\n");
  fs.writeFileSync(path.join(linkDir, "refs.json"), JSON.stringify(refs, null, 2) + "\n");
  fs.writeFileSync(path.join(linkDir, "meta.json"), JSON.stringify({
    commit_id: commit,
    parent_link: parent,
    created_at: ts,
    model: process.env.CLAUDE_MODEL || null,
  }, null, 2) + "\n");

  const indexEntry = { id, ts, commit, summary_tokens: summaryTokens, tags };
  fs.appendFileSync(p.indexJsonl, JSON.stringify(indexEntry) + "\n");

  // Clear any pending-checkpoint sentinel — this link satisfies it.
  const sentinel = path.join(p.root, ".pending-checkpoint");
  if (fs.existsSync(sentinel)) {
    try { fs.unlinkSync(sentinel); } catch {}
  }

  // Clear the frontend-changes log — fresh slate after a link is written.
  const fcLog = path.join(p.root, ".frontend-changes.jsonl");
  if (fs.existsSync(fcLog)) {
    try { fs.unlinkSync(fcLog); } catch {}
  }

  process.stdout.write(idStr + "\n");
}

main().catch((err) => {
  process.stderr.write(`write_link: ${err?.message ?? err}\n`);
  process.exit(1);
});
