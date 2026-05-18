import path from "node:path";
import fs from "node:fs";

export const DIR_NAME = ".continuum";

export function continuumRoot(projectDir) {
  return path.join(projectDir, DIR_NAME);
}

export function paths(projectDir) {
  const root = continuumRoot(projectDir);
  return {
    root,
    stateMd: path.join(root, "STATE.md"),
    chainDir: path.join(root, "chain"),
    indexJsonl: path.join(root, "chain", "index.jsonl"),
    linksDir: path.join(root, "chain", "links"),
    archiveDir: path.join(root, "archive", "transcripts"),
    feedbackDir: path.join(root, "feedback", "pending"),
    configJson: path.join(root, "config.json"),
    sessionIdFile: path.join(root, ".session-id"),
  };
}

export function isBootstrapped(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.indexJsonl)) return false;
  try {
    const stat = fs.statSync(p.indexJsonl);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// loadIndex: returns ALL non-tombstone entries with an `archived` field
// annotated based on whether a later tombstone entry supersedes them.
//
// Tombstone entries look like: {tombstone: true, id: <N>, supersededBy: <digestId>, ts}
// They are APPENDED by /continuum:dream — never mutate originals (PRD §4: links immutable).
export function loadIndex(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.indexJsonl)) return [];
  const lines = fs.readFileSync(p.indexJsonl, "utf8").split("\n").filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tombstoned = new Map(); // id -> supersededBy
  for (const e of entries) {
    if (e.tombstone === true && e.id != null) {
      tombstoned.set(e.id, e.supersededBy ?? null);
    }
  }
  return entries
    .filter((e) => e.tombstone !== true)
    .map((e) => ({
      ...e,
      archived: tombstoned.has(e.id),
      supersededBy: tombstoned.get(e.id) ?? null,
    }));
}

// Active (non-archived) entries only.
export function loadActiveIndex(projectDir) {
  return loadIndex(projectDir).filter((e) => !e.archived);
}

export function readIndexTail(projectDir, n) {
  return loadActiveIndex(projectDir).slice(-n);
}

export function linkPath(projectDir, linkId, archived = false) {
  const p = paths(projectDir);
  const idStr = String(linkId).padStart(4, "0");
  return archived ? path.join(p.linksDir, "_archived", idStr) : path.join(p.linksDir, idStr);
}

export function readLinkSummary(projectDir, linkId, archived = false) {
  const file = path.join(linkPath(projectDir, linkId, archived), "summary.md");
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

export function readStateMd(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.stateMd)) return null;
  return fs.readFileSync(p.stateMd, "utf8");
}

export function readConfig(projectDir) {
  const p = paths(projectDir);
  const defaults = {
    dir_name: DIR_NAME,
    inject_token_cap: 4000,
    state_md_line_cap: 150,
    link_summary_token_cap: 800,
    newest_links_to_load: 2,
    soft_context_threshold_pct: 60,
    rollup_every_n_links: 25,
    frontend_verify: false,
    frontend_globs: ["src/**/*.{tsx,jsx,vue,svelte,css}"],
    frontend_breakpoints_px: [375, 768, 1280],
    feedback_to_git_issues: false,
  };
  if (!fs.existsSync(p.configJson)) return defaults;
  try {
    const user = JSON.parse(fs.readFileSync(p.configJson, "utf8"));
    return { ...defaults, ...user };
  } catch {
    return defaults;
  }
}

// Cheap heuristic, not a real tokenizer. Good enough for budget enforcement.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
