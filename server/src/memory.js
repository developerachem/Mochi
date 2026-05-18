// File-based memory for the Mochi browser MCP: selector cache + workflows +
// runs. Lives under <project>/.continuum/ (same dir as the Continuum chain
// data) so everything Mochi persists is in one place, per-project, no SQLite.
//
// On-disk layout:
//
//   .continuum/
//     selectors/<origin>.json          # dict of intent_hash → record
//     workflows/<origin>/<name>.json   # full workflow with steps inline
//     runs/<workflow_id>.jsonl         # one line per run, append-only
//
// API matches the previous SQLite-backed Memory class exactly so tools.js
// callers don't change. Concurrent writers use atomic-rename writes
// (write to .tmp then rename) — POSIX-atomic on the same filesystem.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { intentHash, normalizeIntent } from "./origin.js";

// ---------- project root + data dir resolution ----------

function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".git")) ||
        fs.existsSync(path.join(dir, "package.json")) ||
        fs.existsSync(path.join(dir, ".continuum")) ||
        fs.existsSync(path.join(dir, ".super-tester"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveDataDir() {
  if (process.env.SUPER_TESTER_DATA_DIR) return process.env.SUPER_TESTER_DATA_DIR;
  const cwd = process.env.SUPER_TESTER_PROJECT_DIR ?? process.cwd();
  const root = findProjectRoot(cwd);
  if (root) return path.join(root, ".continuum");
  return path.join(homedir(), ".continuum");
}

// Backward-compat for any old caller — returns a faux path inside the data dir.
export function resolveDbPath() {
  return path.join(resolveDataDir(), "memory.db");
}

// ---------- low-level file helpers ----------

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200) || "_";
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- public API ----------

export class Memory {
  constructor({ dataDir, log = () => {} } = {}) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.selectorsDir = path.join(this.dataDir, "selectors");
    this.workflowsDir = path.join(this.dataDir, "workflows");
    this.runsDir = path.join(this.dataDir, "runs");
    fs.mkdirSync(this.selectorsDir, { recursive: true });
    fs.mkdirSync(this.workflowsDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    log(`[memory] file-based store at ${this.dataDir}`);
  }

  close() {}
  now() { return new Date().toISOString(); }

  // ---- selectors ----

  _selectorFile(origin) {
    return path.join(this.selectorsDir, sanitizeForFilename(origin) + ".json");
  }
  _readSelectors(origin) {
    return readJsonSafe(this._selectorFile(origin), {});
  }
  _writeSelectors(origin, data) {
    atomicWriteJson(this._selectorFile(origin), data);
  }

  recallSelector(origin, intent) {
    if (!origin || !intent) return null;
    const all = this._readSelectors(origin);
    return all[intentHash(intent)] ?? null;
  }

  recordSelectorHit({ origin, intent, selector, role, name, lastBox }) {
    if (!origin || !intent || !selector) return;
    const all = this._readSelectors(origin);
    const hash = intentHash(intent);
    const now = this.now();
    const existing = all[hash];
    const boxJson = lastBox ? JSON.stringify(lastBox) : (existing?.last_box ?? null);
    if (existing) {
      all[hash] = {
        ...existing,
        selector,
        role: role ?? existing.role,
        name: name ?? existing.name,
        last_box: boxJson,
        hit_count: (existing.hit_count ?? 0) + 1,
        last_verified: now,
      };
    } else {
      all[hash] = {
        origin,
        intent: normalizeIntent(intent),
        selector,
        selector_alt: null,
        role: role ?? null,
        name: name ?? null,
        last_box: boxJson,
        hit_count: 1,
        miss_count: 0,
        last_verified: now,
        created_at: now,
      };
    }
    this._writeSelectors(origin, all);
  }

  recordSelectorMiss(origin, intent) {
    if (!origin || !intent) return;
    const all = this._readSelectors(origin);
    const hash = intentHash(intent);
    if (all[hash]) {
      all[hash].miss_count = (all[hash].miss_count ?? 0) + 1;
      this._writeSelectors(origin, all);
    }
  }

  updateSelector({ origin, intent, selector, role, name, lastBox }) {
    if (!origin || !intent || !selector) return;
    const all = this._readSelectors(origin);
    const hash = intentHash(intent);
    const existing = all[hash];
    if (!existing) return;
    existing.selector = selector;
    existing.role = role ?? existing.role;
    existing.name = name ?? existing.name;
    if (lastBox) existing.last_box = JSON.stringify(lastBox);
    existing.last_verified = this.now();
    this._writeSelectors(origin, all);
  }

  forgetSelector(origin, intent) {
    if (!origin || !intent) return 0;
    const all = this._readSelectors(origin);
    const hash = intentHash(intent);
    if (!(hash in all)) return 0;
    delete all[hash];
    this._writeSelectors(origin, all);
    return 1;
  }

  listSelectors(origin) {
    const result = [];
    if (origin) {
      for (const entry of Object.values(this._readSelectors(origin))) result.push(entry);
    } else {
      try {
        for (const f of fs.readdirSync(this.selectorsDir)) {
          if (!f.endsWith(".json")) continue;
          const all = readJsonSafe(path.join(this.selectorsDir, f), {});
          for (const entry of Object.values(all)) result.push(entry);
        }
      } catch {}
    }
    const projected = result
      .sort((a, b) => String(b.last_verified ?? "").localeCompare(String(a.last_verified ?? "")))
      .slice(0, origin ? undefined : 200)
      .map(({ origin: o, intent, selector, role, name, hit_count, miss_count, last_verified }) => ({
        origin: o, intent, selector, role, name, hit_count, miss_count, last_verified,
      }));
    return projected;
  }

  // ---- workflows + steps ----

  _workflowFile(origin, name) {
    return path.join(this.workflowsDir, sanitizeForFilename(origin), sanitizeForFilename(name) + ".json");
  }

  saveWorkflow({ origin, name, description, steps }) {
    if (!origin) throw new Error("workflow requires an origin");
    if (!name) throw new Error("workflow requires a name");
    const file = this._workflowFile(origin, name);
    const existing = readJsonSafe(file, null);
    const now = this.now();
    const id = existing?.id ?? randomId();
    const packedSteps = (steps ?? []).map((s, ord) => ({
      id: randomId(),
      workflow_id: id,
      ord,
      action: s.action,
      intent: s.intent ?? null,
      selector: s.selector ?? null,
      selector_alt: s.selector_alt ?? null,
      role: s.role ?? null,
      name: s.name ?? null,
      value: s.value ?? null,
      params: s.params ?? null,
      expected: s.expected ?? null,
      last_box: s.last_box ?? null,
      fail_count: 0,
    }));
    const wf = {
      id,
      origin,
      name,
      description: description ?? existing?.description ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      steps: packedSteps,
    };
    atomicWriteJson(file, wf);
    return { id, origin, name, stepCount: packedSteps.length };
  }

  getWorkflow(origin, name) {
    return readJsonSafe(this._workflowFile(origin, name), null);
  }

  listWorkflows(origin) {
    const out = [];
    const visit = (originDir, originName) => {
      if (!fs.existsSync(originDir)) return;
      for (const f of fs.readdirSync(originDir)) {
        if (!f.endsWith(".json")) continue;
        const wf = readJsonSafe(path.join(originDir, f), null);
        if (!wf) continue;
        out.push({
          id: wf.id,
          origin: wf.origin ?? originName,
          name: wf.name,
          description: wf.description,
          updated_at: wf.updated_at,
          step_count: Array.isArray(wf.steps) ? wf.steps.length : 0,
        });
      }
    };
    if (origin) {
      visit(path.join(this.workflowsDir, sanitizeForFilename(origin)), origin);
    } else if (fs.existsSync(this.workflowsDir)) {
      for (const d of fs.readdirSync(this.workflowsDir)) {
        const dir = path.join(this.workflowsDir, d);
        try { if (fs.statSync(dir).isDirectory()) visit(dir, d); } catch {}
      }
    }
    return out.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  }

  deleteWorkflow(origin, name) {
    const file = this._workflowFile(origin, name);
    if (!fs.existsSync(file)) return 0;
    const wf = readJsonSafe(file, null);
    try { fs.unlinkSync(file); } catch { return 0; }
    if (wf?.id) {
      try { fs.unlinkSync(this._runsFile(wf.id)); } catch {}
    }
    return 1;
  }

  // Find which workflow file owns this step id. O(N workflows) scan — fine for
  // our scale (a project rarely has more than a few dozen workflows).
  _findWorkflowFileByStepId(stepId) {
    if (!fs.existsSync(this.workflowsDir)) return null;
    for (const d of fs.readdirSync(this.workflowsDir)) {
      const originDir = path.join(this.workflowsDir, d);
      let isDir = false;
      try { isDir = fs.statSync(originDir).isDirectory(); } catch {}
      if (!isDir) continue;
      for (const f of fs.readdirSync(originDir)) {
        if (!f.endsWith(".json")) continue;
        const file = path.join(originDir, f);
        const wf = readJsonSafe(file, null);
        if (!wf || !Array.isArray(wf.steps)) continue;
        if (wf.steps.some((s) => s.id === stepId)) return { file, wf };
      }
    }
    return null;
  }

  bumpStepFail(stepId) {
    const found = this._findWorkflowFileByStepId(stepId);
    if (!found) return;
    const step = found.wf.steps.find((s) => s.id === stepId);
    step.fail_count = (step.fail_count ?? 0) + 1;
    atomicWriteJson(found.file, found.wf);
  }

  patchStep(stepId, patch) {
    const found = this._findWorkflowFileByStepId(stepId);
    if (!found) return;
    const step = found.wf.steps.find((s) => s.id === stepId);
    for (const k of ["selector", "role", "name", "last_box"]) {
      if (k in patch) {
        // SQLite stored last_box as JSON string for callers that expect that
        // shape; preserve it here.
        step[k] = typeof patch[k] === "object" && patch[k] !== null
          ? JSON.stringify(patch[k]) : patch[k];
      }
    }
    atomicWriteJson(found.file, found.wf);
  }

  // ---- runs (append-only JSONL per workflow) ----

  _runsFile(workflowId) {
    return path.join(this.runsDir, sanitizeForFilename(workflowId) + ".jsonl");
  }

  _readRuns(workflowId) {
    const file = this._runsFile(workflowId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  _writeRunsAll(workflowId, rows) {
    const file = this._runsFile(workflowId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    const text = rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  startRun(workflowId, totalSteps) {
    const id = randomId();
    const row = {
      id,
      workflow_id: workflowId,
      started_at: this.now(),
      ended_at: null,
      status: "pending",
      steps_total: totalSteps,
      steps_passed: 0,
      result_json: "[]",
    };
    const file = this._runsFile(workflowId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return id;
  }

  finishRun(runId, { status, stepsPassed, resultJson }) {
    if (!fs.existsSync(this.runsDir)) return;
    for (const f of fs.readdirSync(this.runsDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const wfId = f.replace(/\.jsonl$/, "");
      const rows = this._readRuns(wfId);
      const i = rows.findIndex((r) => r.id === runId);
      if (i === -1) continue;
      rows[i].ended_at = this.now();
      rows[i].status = status;
      rows[i].steps_passed = stepsPassed;
      rows[i].result_json = JSON.stringify(resultJson ?? []);
      this._writeRunsAll(wfId, rows);
      return;
    }
  }

  pruneRuns(workflowId, keep = 50) {
    const rows = this._readRuns(workflowId);
    if (rows.length <= keep) return;
    // Keep the `keep` newest by started_at; preserve chronological storage order.
    const sorted = rows.slice().sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
    const kept = sorted.slice(0, keep);
    kept.sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
    this._writeRunsAll(workflowId, kept);
  }

  listRuns(origin, name, limit = 20) {
    const wf = this.getWorkflow(origin, name);
    if (!wf) return [];
    const rows = this._readRuns(wf.id);
    return rows
      .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        status: r.status,
        steps_total: r.steps_total,
        steps_passed: r.steps_passed,
      }));
  }

  // ---- export / import ----

  exportWorkflow(origin, name) {
    const wf = this.getWorkflow(origin, name);
    if (!wf) return null;
    return {
      schema: "super-tester/workflow",
      version: 1,
      origin: wf.origin,
      name: wf.name,
      description: wf.description,
      steps: wf.steps.map((s) => ({
        action: s.action,
        intent: s.intent,
        selector: s.selector,
        selector_alt: s.selector_alt,
        role: s.role,
        name: s.name,
        value: s.value,
        params: s.params,
        expected: s.expected,
        last_box: s.last_box,
      })),
    };
  }

  importWorkflow(payload) {
    if (!payload || payload.schema !== "super-tester/workflow") {
      throw new Error("not a super-tester workflow JSON");
    }
    return this.saveWorkflow({
      origin: payload.origin,
      name: payload.name,
      description: payload.description,
      steps: payload.steps,
    });
  }
}
