#!/usr/bin/env node
// Used by the agent to record a single viewport verification result for a
// frontend change. Then /continuum:checkpoint will fold it into the next link.
//
// Usage:
//   node verify_record_cli.js \
//     --path "src/components/Button.tsx" \
//     --viewport 375 \
//     --status pass|fail \
//     [--notes "what was checked"] \
//     [--project-dir DIR]

import { recordVerification } from "./verification_log.js";

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
  const filePath = args.path && args.path !== true ? args.path : null;
  const viewport = args.viewport && args.viewport !== true ? args.viewport : null;
  const status = args.status && args.status !== true ? args.status : null;
  const notes = args.notes && args.notes !== true ? args.notes : null;

  if (!filePath || !status) {
    process.stderr.write("verify_record: --path and --status are required\n");
    process.exit(2);
  }
  if (!["pass", "fail", "skip"].includes(status)) {
    process.stderr.write(`verify_record: --status must be pass|fail|skip (got ${status})\n`);
    process.exit(2);
  }

  recordVerification(projectDir, { filePath, viewport, status, notes });
  process.stdout.write(JSON.stringify({ ok: true, path: filePath, viewport, status }) + "\n");
}

main();
