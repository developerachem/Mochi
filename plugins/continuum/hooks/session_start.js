#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  paths,
  isBootstrapped,
  readIndexTail,
  readLinkSummary,
  readStateMd,
  readConfig,
  estimateTokens,
} from "../lib/paths.js";
import { readSentinel } from "../lib/archive.js";
import { register as brokerRegister } from "../lib/broker.js";

async function readStdin() {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // If no stdin within 200ms, resolve empty (defensive — hook input is always sent, but don't hang)
    setTimeout(() => resolve(data), 200);
  });
}

function emitContext(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function emitEmpty() {
  process.exit(0);
}

function bootstrapDirective(projectDir) {
  return [
    `[continuum] No context chain found at \`${path.relative(projectDir, paths(projectDir).root) || ".continuum/"}\`.`,
    ``,
    `**One-time bootstrap required.** Before doing other work, please:`,
    `1. Scan the repository's high-level structure (top-level dirs, package.json/Cargo.toml/etc, README).`,
    `2. Read \`git log --oneline -20\` to understand recent direction.`,
    `3. Create the directory structure:`,
    `   - \`.continuum/STATE.md\` — bounded snapshot of current project truth (stack, active decisions, "do not do" list, open threads). Keep under 150 lines.`,
    `   - \`.continuum/chain/index.jsonl\` — append a single line: \`{"id":1,"ts":"<ISO-UTC>","commit":"<git rev-parse HEAD or null>","summary_tokens":<int>,"tags":["bootstrap"]}\``,
    `   - \`.continuum/chain/links/0001/summary.md\` — initial baseline summary (≤800 tokens).`,
    `   - \`.continuum/chain/links/0001/meta.json\` — \`{"commit_id":"<sha>","parent_link":null,"created_at":"<ISO>","model":"<this model>"}\``,
    `   - \`.continuum/chain/links/0001/refs.json\` — \`{}\` for now.`,
    `   - \`.continuum/archive/transcripts/\` — empty directory (mkdir).`,
    `   - \`.continuum/.gitignore\` — recommend ignoring \`archive/\` if user prefers small repo (ask user, default: do not ignore).`,
    ``,
    `Confirm with the user before writing if anything seems unclear. Then proceed with their actual request.`,
  ].join("\n");
}

function buildLoadedContext(projectDir, cfg) {
  const stateMd = readStateMd(projectDir);
  const tail = readIndexTail(projectDir, cfg.newest_links_to_load);
  const stateBlock = stateMd
    ? `### Current state (STATE.md)\n\n${stateMd.trim()}\n`
    : `### Current state\n\n(STATE.md missing — chain exists but state is empty. Regenerate at next checkpoint.)\n`;

  const linkBlocks = [];
  for (const entry of tail) {
    const summary = readLinkSummary(projectDir, entry.id);
    if (!summary) continue;
    linkBlocks.push(
      `### Link ${String(entry.id).padStart(4, "0")} — ${entry.ts ?? "?"} (commit: ${entry.commit ?? "n/a"})\n\n${summary.trim()}`
    );
  }

  let assembled = [
    `[continuum] Loaded context chain (${tail.length > 0 ? `${tail.length} recent link${tail.length === 1 ? "" : "s"}` : "no links yet"}).`,
    ``,
    stateBlock,
    ...linkBlocks,
  ].join("\n");

  // Enforce token budget: drop oldest link summaries until under cap, never truncate STATE.md.
  let tokens = estimateTokens(assembled);
  let dropped = 0;
  while (tokens > cfg.inject_token_cap && linkBlocks.length > 0) {
    linkBlocks.shift();
    dropped += 1;
    assembled = [
      `[continuum] Loaded context chain (${linkBlocks.length} recent link${linkBlocks.length === 1 ? "" : "s"}; ${dropped} dropped to stay under token cap).`,
      ``,
      stateBlock,
      ...linkBlocks,
    ].join("\n");
    tokens = estimateTokens(assembled);
  }

  assembled += `\n\n_(continuum: token budget used ≈ ${tokens}/${cfg.inject_token_cap}. Use \`/continuum:checkpoint\` to write a new link when decisions accrue.)_`;
  return assembled;
}

function computeDefaultSessionName(projectDir) {
  const base = path.basename(projectDir);
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return branch && branch !== "HEAD" ? `${base} · ${branch}` : base;
  } catch {
    return base;
  }
}

async function main() {
  const stdinRaw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(stdinRaw || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload.session_id || null;

  // Persist session id so other hooks/commands can correlate.
  try {
    const p = paths(projectDir);
    fs.mkdirSync(p.root, { recursive: true });
    if (sessionId) fs.writeFileSync(p.sessionIdFile, sessionId);
  } catch {}

  // Register with the Mochi broker so the extension popup can target this
  // session by name and push hints into it. AWAITED so the popup sees the
  // session immediately, but the broker.js fetch has a short timeout —
  // if Mochi is offline, this returns {ok:false} quickly and SessionStart
  // continues normally.
  if (sessionId) {
    const name = computeDefaultSessionName(projectDir);
    try {
      const p = paths(projectDir);
      fs.writeFileSync(path.join(p.root, ".session-name"), name);
    } catch {}
    try { await brokerRegister({ sessionId, name, projectDir }); } catch {}
  }

  const cfg = readConfig(projectDir);

  if (!isBootstrapped(projectDir)) {
    emitContext(bootstrapDirective(projectDir));
    return;
  }

  let context = buildLoadedContext(projectDir, cfg);

  const sentinel = readSentinel(projectDir);
  if (sentinel) {
    const trigger = sentinel.trigger || "?";
    const why = sentinel.matcher || sentinel.why_session_ended || "?";
    const archive = sentinel.archive_path || "(no archive recorded)";
    context += `\n\n---\n\n**⚠ Pending checkpoint detected.** Previous session ended via \`${trigger}\` (${why}). Raw transcript was archived to:\n\n\`${archive}\`\n\nIf the last session changed decisions or surfaced new threads, run \`/continuum:checkpoint\` now — read the archive with \`zcat\` if you need to recover detail. The sentinel clears automatically when a new link is written.`;
  }

  emitContext(context);
}

main().catch((err) => {
  process.stderr.write(`[continuum:session_start] ${err?.message ?? err}\n`);
  emitEmpty();
});
