// Shared helpers for transcript archival + pending-checkpoint sentinel.
// Phase 1 deviation from PRD §4: using gzip (Node built-in) instead of zstd
// to avoid an external binary/npm dependency. Format is .jsonl.gz; can be
// re-encoded to .jsonl.zst in a later phase without losing data.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { paths } from "./paths.js";

export function archiveTranscript(projectDir, transcriptPath, trigger) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const p = paths(projectDir);
  fs.mkdirSync(p.archiveDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = `${ts}__${trigger}.jsonl.gz`;
  const outPath = path.join(p.archiveDir, fname);

  const src = fs.readFileSync(transcriptPath);
  const gz = zlib.gzipSync(src, { level: 9 });
  fs.writeFileSync(outPath, gz);
  return outPath;
}

export function writeSentinel(projectDir, info) {
  const p = paths(projectDir);
  fs.mkdirSync(p.root, { recursive: true });
  const sentinelPath = path.join(p.root, ".pending-checkpoint");
  fs.writeFileSync(sentinelPath, JSON.stringify(info, null, 2));
  return sentinelPath;
}

export function readSentinel(projectDir) {
  const p = paths(projectDir);
  const sentinelPath = path.join(p.root, ".pending-checkpoint");
  if (!fs.existsSync(sentinelPath)) return null;
  try { return JSON.parse(fs.readFileSync(sentinelPath, "utf8")); }
  catch { return { raw: "<unparseable sentinel>" }; }
}
