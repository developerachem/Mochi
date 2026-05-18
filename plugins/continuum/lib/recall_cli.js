#!/usr/bin/env node
// CLI wrapper for lib/recall.js — used by the /continuum:recall slash command.
//
// Usage:
//   node recall_cli.js [--project-dir DIR] [--limit N] [--tags t1,t2] [--json] -- <query words>
// Or:
//   node recall_cli.js --query "<query>" [...]

import { recall, formatRecallForHuman } from "./recall.js";

function parseArgs(argv) {
  const args = { _: [] };
  let dashdash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (dashdash) { args._.push(a); continue; }
    if (a === "--") { dashdash = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const isFlag = next === undefined || next.startsWith("--");
      args[key] = isFlag ? true : argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const limit = Number(args.limit || 5);
  const tags = args.tags ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : null;
  const query = args.query ? String(args.query) : args._.join(" ").trim();

  if (!query) {
    process.stderr.write("recall: query is required. Usage: recall_cli.js -- <query words>\n");
    process.exit(2);
  }

  let result;
  try {
    result = recall({ projectDir, query, limit, tags, includeArchived: true });
  } catch (err) {
    process.stderr.write(`recall: ${err?.message ?? err}\n`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatRecallForHuman(result) + "\n");
  }
}

main();
