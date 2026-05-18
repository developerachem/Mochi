// Tracks frontend-file changes between checkpoints so /continuum:checkpoint
// can surface verification status into the link summary. Append-only JSONL
// at .continuum/.frontend-changes.jsonl. Cleared on checkpoint.
//
// Records have one of two shapes:
//   {type:"change",   path, tool, ts}
//   {type:"verified", path, viewport, status, notes?, ts}

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

function logFile(projectDir) {
  return path.join(paths(projectDir).root, ".frontend-changes.jsonl");
}

export function recordChange(projectDir, { filePath, tool }) {
  try {
    fs.mkdirSync(paths(projectDir).root, { recursive: true });
    fs.appendFileSync(logFile(projectDir), JSON.stringify({
      type: "change",
      path: filePath, tool, ts: new Date().toISOString(),
    }) + "\n");
  } catch {}
}

export function recordVerification(projectDir, { filePath, viewport, status, notes }) {
  try {
    fs.mkdirSync(paths(projectDir).root, { recursive: true });
    fs.appendFileSync(logFile(projectDir), JSON.stringify({
      type: "verified",
      path: filePath, viewport, status,
      notes: notes ?? null,
      ts: new Date().toISOString(),
    }) + "\n");
  } catch {}
}

export function readLog(projectDir) {
  const f = logFile(projectDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function summarize(entries) {
  const changed = new Set();
  const verifications = []; // {path, viewport, status, notes}
  for (const e of entries) {
    if (e.type === "change" && e.path) changed.add(e.path);
    else if (e.type === "verified" && e.path) {
      verifications.push(e);
      // If we have a verification but no preceding change record (e.g. user
      // manually invoked verify_record), treat it as implicit evidence of a
      // change so the path still appears in the change set.
      changed.add(e.path);
    }
  }
  const verifiedPaths = new Set(verifications.map((v) => v.path));
  const unverified = [...changed].filter((p) => !verifiedPaths.has(p));
  const failures = verifications.filter((v) => v.status !== "pass");
  return {
    changedCount: changed.size,
    changed: [...changed],
    verifications,
    unverifiedCount: unverified.length,
    unverified,
    failureCount: failures.length,
    failures,
  };
}

export function clearLog(projectDir) {
  const f = logFile(projectDir);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}
