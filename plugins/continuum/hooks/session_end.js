#!/usr/bin/env node
// SessionEnd: archive the transcript + drop a pending-checkpoint sentinel so
// the next session's SessionStart can prompt for a retroactive checkpoint.
// SessionEnd cannot block and cannot inject model context, but it can emit
// a systemMessage that the user (not the model) sees in the terminal.

import { paths } from "../lib/paths.js";
import { archiveTranscript, writeSentinel } from "../lib/archive.js";
import { unregister as brokerUnregister } from "../lib/broker.js";

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
  const why = payload.why_session_ended || "unknown";

  let archivePath = null;
  try {
    paths(projectDir); // no-op, just ensure import is wired
    archivePath = archiveTranscript(projectDir, transcriptPath, `sessionend-${why}`);
    writeSentinel(projectDir, {
      trigger: "SessionEnd",
      why_session_ended: why,
      ts: new Date().toISOString(),
      session_id: sessionId,
      transcript_path: transcriptPath,
      archive_path: archivePath,
    });
  } catch (err) {
    process.stderr.write(`[continuum:session_end] ${err?.message ?? err}\n`);
  }

  // Tell the broker to drop this session from the extension popup. Best-effort.
  if (sessionId) {
    try { await brokerUnregister({ sessionId }); } catch {}
  }

  // Emit user-visible terminal message (NOT model context).
  const msg = archivePath
    ? `[continuum] Session ended (${why}). Transcript archived → ${archivePath}. Run /continuum:checkpoint in your next session to commit it to the chain.`
    : `[continuum] Session ended (${why}). No transcript path was provided; skipping archive.`;
  try {
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
  } catch {}
  process.exit(0);
}

main();
