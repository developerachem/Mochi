#!/usr/bin/env node
// PreCompact: archive the raw transcript (so the post-compact window can still
// recover what is about to be dropped) and drop a pending-checkpoint sentinel
// so the next SessionStart (or any future /continuum:checkpoint invocation)
// can pick it up.
//
// Note: PreCompact stdout is NOT injected as model context (per the hooks
// reference, only Pre/PostToolUse-family events inject additionalContext).
// So this hook is purely side-effect: archive + sentinel. The agent learns
// about the pending checkpoint via SessionStart on the next session, or via
// /continuum:status mid-session.

import { paths } from "../lib/paths.js";
import { archiveTranscript, writeSentinel } from "../lib/archive.js";

async function readStdin() {
  return await new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(d), 200);
  });
}

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}
  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const transcriptPath = payload.transcript_path || null;
  const sessionId = payload.session_id || null;
  const matcher = payload.matcher || payload.trigger || "unknown"; // "manual" or "auto"

  // If no .continuum/ yet, do nothing — user hasn't bootstrapped this repo.
  // (Don't block compaction over an unrelated plugin.)
  try {
    const p = paths(projectDir);
    const archivePath = archiveTranscript(projectDir, transcriptPath, `precompact-${matcher}`);
    writeSentinel(projectDir, {
      trigger: "PreCompact",
      matcher,
      ts: new Date().toISOString(),
      session_id: sessionId,
      transcript_path: transcriptPath,
      archive_path: archivePath,
    });
  } catch (err) {
    process.stderr.write(`[continuum:pre_compact] ${err?.message ?? err}\n`);
  }
  process.exit(0);
}

main();
