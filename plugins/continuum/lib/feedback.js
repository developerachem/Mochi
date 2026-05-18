// Feedback queue: the agent files structured self-improvement items when it
// notices a plugin capability gap. Items live as JSON files under
// .continuum/feedback/pending/ and can be flushed to GitHub issues via
// `/continuum:feedback flush`.
//
// Dedup: hash of normalized title (lowercased, whitespace-collapsed). A second
// feedback with the same normalized title is dropped silently.
//
// Rate-limit: max N flushes per day (default 10) recorded in feedback/flush-log.jsonl.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { paths } from "./paths.js";

const DEFAULT_DAILY_FLUSH_CAP = 10;

function normTitle(t) {
  return String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hash8(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export function feedbackPaths(projectDir) {
  const p = paths(projectDir);
  return {
    pendingDir: path.join(p.root, "feedback", "pending"),
    sentDir: path.join(p.root, "feedback", "sent"),
    flushLog: path.join(p.root, "feedback", "flush-log.jsonl"),
  };
}

export function fileFeedback(projectDir, { title, body, linkId, severity, source } = {}) {
  if (!title || !body) throw new Error("feedback: title and body required");
  const fp = feedbackPaths(projectDir);
  fs.mkdirSync(fp.pendingDir, { recursive: true });
  fs.mkdirSync(fp.sentDir, { recursive: true });

  const normalized = normTitle(title);
  const h = hash8(normalized);
  const pendingFile = path.join(fp.pendingDir, `${h}.json`);
  const sentFile = path.join(fp.sentDir, `${h}.json`);

  if (fs.existsSync(pendingFile)) {
    return { status: "duplicate-pending", hash: h, path: pendingFile };
  }
  if (fs.existsSync(sentFile)) {
    return { status: "duplicate-sent", hash: h, path: sentFile };
  }

  const item = {
    hash: h,
    title: title.trim(),
    body: body.trim(),
    linkId: linkId ?? null,
    severity: severity || "minor", // minor | major | blocker
    source: source || "agent",
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(pendingFile, JSON.stringify(item, null, 2) + "\n");
  return { status: "queued", hash: h, path: pendingFile };
}

function readFlushLog(fp) {
  if (!fs.existsSync(fp.flushLog)) return [];
  return fs.readFileSync(fp.flushLog, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function flushesInLast24h(fp) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return readFlushLog(fp).filter((e) => e.ts && Date.parse(e.ts) >= cutoff).length;
}

function appendFlushLog(fp, entry) {
  fs.appendFileSync(fp.flushLog, JSON.stringify(entry) + "\n");
}

function ghAvailable() {
  try { execSync("gh --version", { stdio: "ignore" }); return true; } catch { return false; }
}

function createGitHubIssue({ title, body, dryRun }) {
  if (dryRun) {
    return { ok: true, url: `(dry-run: would create issue "${title.slice(0, 60)}")` };
  }
  if (!ghAvailable()) {
    return { ok: false, error: "gh CLI not installed or not on PATH" };
  }
  try {
    const out = execSync(`gh issue create --title ${JSON.stringify(title)} --body-file -`, {
      input: body, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8",
    });
    const url = out.trim().split("\n").pop();
    return { ok: true, url };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : "";
    return { ok: false, error: `gh failed: ${err?.message || err}\n${stderr}` };
  }
}

export function flushFeedback(projectDir, { dailyCap = DEFAULT_DAILY_FLUSH_CAP, dryRun = false } = {}) {
  const fp = feedbackPaths(projectDir);
  fs.mkdirSync(fp.pendingDir, { recursive: true });
  fs.mkdirSync(fp.sentDir, { recursive: true });

  const pending = fs.readdirSync(fp.pendingDir).filter((f) => f.endsWith(".json"));
  if (pending.length === 0) return { flushed: [], skipped: [], summary: "nothing pending" };

  const already = flushesInLast24h(fp);
  let budget = Math.max(0, dailyCap - already);

  const flushed = [];
  const skipped = [];

  for (const fname of pending) {
    if (budget <= 0) {
      skipped.push({ file: fname, reason: `daily flush cap (${dailyCap}) reached` });
      continue;
    }
    const full = path.join(fp.pendingDir, fname);
    let item;
    try { item = JSON.parse(fs.readFileSync(full, "utf8")); }
    catch { skipped.push({ file: fname, reason: "unparseable" }); continue; }

    const bodyWithMeta = [
      item.body,
      "",
      "---",
      `_continuum feedback · hash \`${item.hash}\` · linkId \`${item.linkId ?? "n/a"}\` · severity \`${item.severity}\` · ts \`${item.ts}\`_`,
    ].join("\n");

    const r = createGitHubIssue({ title: item.title, body: bodyWithMeta, dryRun });
    if (r.ok) {
      const sentRecord = { ...item, issueUrl: r.url, flushedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(fp.sentDir, fname), JSON.stringify(sentRecord, null, 2) + "\n");
      fs.unlinkSync(full);
      appendFlushLog(fp, { hash: item.hash, ts: sentRecord.flushedAt, url: r.url });
      flushed.push({ file: fname, url: r.url });
      budget -= 1;
    } else {
      skipped.push({ file: fname, reason: r.error });
    }
  }

  return { flushed, skipped, summary: `${flushed.length} flushed, ${skipped.length} skipped` };
}

export function listFeedback(projectDir) {
  const fp = feedbackPaths(projectDir);
  const pending = fs.existsSync(fp.pendingDir) ? fs.readdirSync(fp.pendingDir).filter((f) => f.endsWith(".json")) : [];
  const sent = fs.existsSync(fp.sentDir) ? fs.readdirSync(fp.sentDir).filter((f) => f.endsWith(".json")) : [];
  return { pendingCount: pending.length, sentCount: sent.length, pending, sent };
}
