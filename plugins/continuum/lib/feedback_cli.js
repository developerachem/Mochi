#!/usr/bin/env node
// CLI shim for the feedback helper. Used by /continuum:feedback.
//
// Subcommands:
//   file     --title "..." [--severity minor|major|blocker] [--link-id N]
//            body read from stdin
//   flush    [--dry-run] [--cap N]
//   list

import { fileFeedback, flushFeedback, listFeedback } from "./feedback.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      args[key] = (next === undefined || next.startsWith("--")) ? true : argv[++i];
    } else args._.push(a);
  }
  return args;
}

function readAllStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (sub === "file") {
    const title = args.title;
    if (!title || title === true) {
      process.stderr.write("feedback file: --title \"<title>\" required\n");
      process.exit(2);
    }
    const body = (await readAllStdin()).trim();
    if (!body) {
      process.stderr.write("feedback file: body required on stdin\n");
      process.exit(2);
    }
    const r = fileFeedback(projectDir, {
      title,
      body,
      severity: args.severity === true ? "minor" : (args.severity || "minor"),
      linkId: args["link-id"] && args["link-id"] !== true ? Number(args["link-id"]) : null,
      source: "agent",
    });
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }

  if (sub === "flush") {
    const r = flushFeedback(projectDir, {
      dailyCap: Number(args.cap || 10),
      dryRun: !!args["dry-run"],
    });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }

  if (sub === "list" || !sub) {
    const r = listFeedback(projectDir);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`feedback_cli: ${err?.message ?? err}\n`);
  process.exit(1);
});
