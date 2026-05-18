#!/usr/bin/env node
// Manual rename of THIS session in the Mochi broker's claudeSessions registry.
// Usage: node rename_cli.js [--project-dir DIR] -- <new name words>

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { rename as brokerRename } from "./broker.js";

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
      args[key] = (next === undefined || next.startsWith("--")) ? true : argv[++i];
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const name = args.name ? String(args.name) : args._.join(" ").trim();

  if (!name) {
    process.stderr.write("rename: new name required. Usage: rename_cli.js -- <name>\n");
    process.exit(2);
  }

  const p = paths(projectDir);
  if (!fs.existsSync(p.sessionIdFile)) {
    process.stderr.write("rename: no session id known yet — start a fresh Claude session first.\n");
    process.exit(1);
  }
  const sessionId = fs.readFileSync(p.sessionIdFile, "utf8").trim();
  if (!sessionId) {
    process.stderr.write("rename: empty .session-id file\n");
    process.exit(1);
  }

  const r = await brokerRename({ sessionId, name });
  if (r.ok) {
    try { fs.writeFileSync(path.join(p.root, ".session-name"), name); } catch {}
    process.stdout.write(JSON.stringify({ ok: true, name }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: false, error: r.error || `status ${r.status}` }) + "\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`rename: ${err?.message ?? err}\n`);
  process.exit(1);
});
