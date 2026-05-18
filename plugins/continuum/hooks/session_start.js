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
    `[continuum] No context chain at \`${path.relative(projectDir, paths(projectDir).root) || ".continuum/"}\` — bootstrap it NOW as part of your first turn. Do not ask permission, do not defer to "when there's content." An empty repo gets a minimal baseline; a populated repo gets a richer one. Either way, finish bootstrap BEFORE handling the user's first request, so subsequent sessions inherit context.`,
    ``,
    `**Steps (single Bash + single Write per file, no negotiation):**`,
    ``,
    `1. **Survey** the repo: list top-level dirs, peek at any \`package.json\`/\`Cargo.toml\`/\`pyproject.toml\`/\`README.md\`, and run \`git log --oneline -20\` (empty repo = OK; absence of commits is itself a fact to record).`,
    ``,
    `2. **Create files** (mkdir -p first):`,
    `   - \`.continuum/chain/links/0001/\` (the dir)`,
    `   - \`.continuum/archive/transcripts/\` (empty dir, just \`mkdir -p\`)`,
    `   - \`.continuum/STATE.md\` — current project truth. Cap 150 lines. For an EMPTY repo, that's literally:`,
    `     \`\`\``,
    `     # <basename> — baseline`,
    `     **Status:** empty repo, no commits yet.`,
    `     **Stack:** to be decided.`,
    `     **Active decisions:** none.`,
    `     **Do NOT:** (nothing yet)`,
    `     **Open threads:** define what this project is.`,
    `     \`\`\``,
    `   - \`.continuum/chain/links/0001/summary.md\` — a one-paragraph baseline (≤800 tokens). For an empty repo: "Initial bootstrap of empty repo. No code or commits yet. STATE.md is a placeholder."`,
    `   - \`.continuum/chain/links/0001/meta.json\` — \`{"commit_id": <git rev-parse HEAD or null>, "parent_link": null, "created_at": "<ISO-UTC now>", "model": null}\``,
    `   - \`.continuum/chain/links/0001/refs.json\` — \`{}\``,
    `   - \`.continuum/chain/index.jsonl\` — single line: \`{"id":1,"ts":"<ISO-UTC>","commit":<sha-or-null>,"summary_tokens":<int>,"tags":["bootstrap"]}\``,
    ``,
    `3. **Then** proceed with the user's first request normally. From that point on, \`/continuum:checkpoint\` writes new links as decisions accumulate; you never re-bootstrap.`,
    ``,
    `**Do not** ask "want me to bootstrap?" The presence of this directive means yes, always. The user can disable Continuum by removing the plugin if they don't want it.`,
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

  // Persist session id + plugin root path so other hooks/commands can correlate.
  // .plugin-root is a fallback for slash command bodies in case
  // ${CLAUDE_SKILL_DIR} doesn't resolve for flat command files.
  try {
    const p = paths(projectDir);
    fs.mkdirSync(p.root, { recursive: true });
    if (sessionId) fs.writeFileSync(p.sessionIdFile, sessionId);
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      fs.writeFileSync(path.join(p.root, ".plugin-root"), process.env.CLAUDE_PLUGIN_ROOT);
    }
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
