#!/usr/bin/env node
// Super-Tester one-step installer.
//   1) Verifies Node + Chrome
//   2) Runs `npm install` in server/
//   3) Wires this MCP into ~/.claude.json (with backup + confirmation)
//   4) Prints next steps
//
// Pass --yes to skip the confirmation prompt.
// Pass --plugin-only to skip the ~/.claude.json edit (use the plugin route instead).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const SERVER_DIR = path.join(ROOT, "server");
const SERVER_ENTRY = path.join(SERVER_DIR, "src", "index.js");
const EXTENSION_DIR = path.join(ROOT, "extension");
const MCP_NAME = "browser";

const args = new Set(process.argv.slice(2));
const AUTO_YES = args.has("--yes") || args.has("-y");
const PLUGIN_ONLY = args.has("--plugin-only");
const UNINSTALL = args.has("--uninstall");

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function header(t) { console.log(`\n${cyan("▸")} ${t}`); }
function ok(t) { console.log(`  ${green("✓")} ${t}`); }
function warn(t) { console.log(`  ${yellow("!")} ${t}`); }
function fail(t) { console.log(`  ${red("✗")} ${t}`); }

async function prompt(q) {
  if (AUTO_YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${q} [Y/n] `, r));
  rl.close();
  return answer.trim() === "" || /^y(es)?$/i.test(answer.trim());
}

// ---------- uninstall ----------

function removeFromClaudeConfig() {
  const claudeConfig = path.join(homedir(), ".claude.json");
  if (!existsSync(claudeConfig)) {
    warn(`${claudeConfig} not found — nothing to remove`);
    return;
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(claudeConfig, "utf-8")); }
  catch (e) { fail(`could not parse ${claudeConfig}: ${e.message}`); process.exit(1); }
  if (!cfg.mcpServers || !(MCP_NAME in cfg.mcpServers)) {
    warn(`${MCP_NAME} not present in ${claudeConfig}`);
    return;
  }
  const backup = `${claudeConfig}.super-tester-backup-${Date.now()}`;
  writeFileSync(backup, readFileSync(claudeConfig));
  delete cfg.mcpServers[MCP_NAME];
  writeFileSync(claudeConfig, JSON.stringify(cfg, null, 2));
  ok(`removed ${MCP_NAME} from ${claudeConfig}`);
  ok(`backup at ${backup}`);
}

if (UNINSTALL) {
  console.log(cyan("Super-Tester uninstall"));
  removeFromClaudeConfig();
  console.log(`\n${green("Done.")} Restart Claude Code.\n`);
  process.exit(0);
}

// ---------- install ----------

console.log(cyan("Super-Tester installer\n"));
console.log(dim(`  repo:      ${ROOT}`));
console.log(dim(`  server:    ${SERVER_ENTRY}`));
console.log(dim(`  extension: ${EXTENSION_DIR}`));

// 1. Node version
header("Checking Node.js");
const [maj] = process.versions.node.split(".").map(Number);
if (maj < 18) {
  fail(`Node ${process.versions.node} is too old — need >= 18`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. Chrome detection (best-effort warn — server can still run if user installs Chrome later)
header("Checking Chrome");
const chromeBins = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  win32: [process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe")],
};
const chrome = (chromeBins[platform()] ?? []).find((p) => p && existsSync(p));
if (chrome) ok(`found ${chrome}`);
else warn("Chrome/Chromium not detected. Install it before first use, or set SUPER_TESTER_CHROME_PATH.");

// 3. Server deps
header("Installing server dependencies");
const npmCmd = platform() === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npmCmd, ["install"], { cwd: SERVER_DIR, stdio: "inherit" });
if (r.status !== 0) { fail("npm install failed"); process.exit(1); }
ok(`installed at ${SERVER_DIR}/node_modules`);

if (PLUGIN_ONLY) {
  console.log(`\n${green("Done.")} Plugin-only mode — skipped ~/.claude.json edit.`);
  console.log(`\nTo use as a Claude Code plugin:`);
  console.log(`  ${dim("In Claude Code:")}`);
  console.log(`  /plugin marketplace add ${ROOT}`);
  console.log(`  /plugin install super-tester@super-tester`);
  process.exit(0);
}

// 4. Wire ~/.claude.json
header("Wiring Claude Code");
const claudeConfig = path.join(homedir(), ".claude.json");
const desiredEntry = {
  command: "node",
  args: [SERVER_ENTRY],
  env: { SUPER_TESTER_EXTENSION_PATH: EXTENSION_DIR },
};

if (!existsSync(claudeConfig)) {
  warn(`${claudeConfig} not found — Claude Code may not be installed`);
  console.log(`\n  Manual config — add to your MCP client:\n`);
  console.log("  " + JSON.stringify({ mcpServers: { [MCP_NAME]: desiredEntry } }, null, 2).split("\n").join("\n  "));
  process.exit(0);
}

let cfg;
try { cfg = JSON.parse(readFileSync(claudeConfig, "utf-8")); }
catch (e) { fail(`could not parse ${claudeConfig}: ${e.message}`); process.exit(1); }

cfg.mcpServers ??= {};
const existed = MCP_NAME in cfg.mcpServers;
const same = existed && JSON.stringify(cfg.mcpServers[MCP_NAME]) === JSON.stringify(desiredEntry);

if (same) {
  ok(`${MCP_NAME} already wired correctly in ${claudeConfig}`);
} else {
  if (existed) {
    warn(`${MCP_NAME} already exists in ${claudeConfig} but with different config`);
    console.log(`  ${dim("current: ")}${JSON.stringify(cfg.mcpServers[MCP_NAME])}`);
    console.log(`  ${dim("new:     ")}${JSON.stringify(desiredEntry)}`);
  }
  const proceed = await prompt(`  Edit ${claudeConfig}?`);
  if (!proceed) {
    warn("skipped — paste this manually instead:");
    console.log("  " + JSON.stringify({ [MCP_NAME]: desiredEntry }, null, 2).split("\n").join("\n  "));
    process.exit(0);
  }
  const backup = `${claudeConfig}.super-tester-backup-${Date.now()}`;
  writeFileSync(backup, readFileSync(claudeConfig));
  cfg.mcpServers[MCP_NAME] = desiredEntry;
  writeFileSync(claudeConfig, JSON.stringify(cfg, null, 2));
  ok(`wired into ${claudeConfig}${existed ? " (replaced)" : ""}`);
  ok(`backup at ${backup}`);
}

console.log(`
${green("All set.")}

Next:
  1) ${cyan("Restart Claude Code")} so it picks up the new MCP server.
  2) On the first browser_* tool call, Chrome auto-launches with the
     extension preloaded into a dedicated profile (your normal Chrome
     profile is untouched).
  3) Try: ${dim("\"Test the login flow on staging.myapp.com\"")}

Memory db will be created at ${cyan("<your-project>/.super-tester/memory.db")}
(falls back to ~/.super-tester/memory.db if no project root).

To uninstall: ${dim("node " + path.basename(__filename) + " --uninstall")}
`);
