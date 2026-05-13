// SQLite-backed memory: selector cache + workflows + steps + run history.
// One DB file per project (looked up from CWD upward), with global fallback
// at ~/.super-tester/memory.db. Schema migrations are inline below.

import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { intentHash, normalizeIntent } from "./origin.js";

const SCHEMA_VERSION = 1;
const require = createRequire(import.meta.url);

let Database = null;
let databaseLoadError = null;
try {
  Database = require("better-sqlite3");
} catch (e) {
  databaseLoadError = e;
}

// ---------- DB location resolution ----------

function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, ".git")) ||
        existsSync(path.join(dir, "package.json")) ||
        existsSync(path.join(dir, ".super-tester"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveDbPath() {
  if (process.env.SUPER_TESTER_DB_PATH) return process.env.SUPER_TESTER_DB_PATH;

  const cwd = process.env.SUPER_TESTER_PROJECT_DIR ?? process.cwd();
  const root = findProjectRoot(cwd);
  if (root) {
    const dir = path.join(root, ".super-tester");
    return path.join(dir, "memory.db");
  }

  return path.join(homedir(), ".super-tester", "memory.db");
}

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------- migrations ----------

const MIGRATIONS = [
  // v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );

      -- "do I already know how to find X on Y?" cache.
      -- Updated on every successful interaction whose intent the agent named.
      CREATE TABLE IF NOT EXISTS selectors (
        origin         TEXT NOT NULL,
        intent_hash    TEXT NOT NULL,
        intent         TEXT NOT NULL,
        selector       TEXT NOT NULL,
        selector_alt   TEXT,            -- JSON array of fallbacks
        role           TEXT,
        name           TEXT,
        last_box       TEXT,            -- JSON {x,y,w,h,viewport:{w,h,dpr}}
        hit_count      INTEGER NOT NULL DEFAULT 0,
        miss_count     INTEGER NOT NULL DEFAULT 0,
        last_verified  TEXT NOT NULL,   -- ISO timestamp
        created_at     TEXT NOT NULL,
        PRIMARY KEY (origin, intent_hash)
      );
      CREATE INDEX IF NOT EXISTS selectors_origin_idx ON selectors (origin);

      -- Named workflow (e.g. "login flow on staging.myapp.com").
      CREATE TABLE IF NOT EXISTS workflows (
        id           TEXT PRIMARY KEY,
        origin       TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (origin, name)
      );
      CREATE INDEX IF NOT EXISTS workflows_origin_idx ON workflows (origin);

      -- Ordered actions inside a workflow.
      CREATE TABLE IF NOT EXISTS steps (
        id            TEXT PRIMARY KEY,
        workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        ord           INTEGER NOT NULL,
        action        TEXT NOT NULL,    -- navigate|click|type|press_key|scroll|wait|assert
        intent        TEXT,
        selector      TEXT,
        selector_alt  TEXT,             -- JSON array
        role          TEXT,
        name          TEXT,
        value         TEXT,             -- text to type / key / url / etc.
        params        TEXT,             -- JSON of full original args
        expected      TEXT,             -- JSON post-condition
        last_box      TEXT,             -- JSON
        fail_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS steps_workflow_idx ON steps (workflow_id, ord);

      -- Run history for diffing + reporting.
      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT PRIMARY KEY,
        workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        started_at   TEXT NOT NULL,
        ended_at     TEXT,
        status       TEXT NOT NULL,     -- pending|pass|fail|partial
        steps_total  INTEGER NOT NULL DEFAULT 0,
        steps_passed INTEGER NOT NULL DEFAULT 0,
        result_json  TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS runs_workflow_idx ON runs (workflow_id, started_at DESC);

      INSERT INTO schema_version (version) VALUES (1);
    `);
  },
];

function getCurrentVersion(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  if (!row) return 0;
  const v = db.prepare("SELECT version FROM schema_version").get();
  return v?.version ?? 0;
}

function applyMigrations(db) {
  const cur = getCurrentVersion(db);
  for (let v = cur + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v - 1];
    db.transaction(() => {
      migrate(db);
      if (v > 1) db.prepare("UPDATE schema_version SET version = ?").run(v);
    })();
  }
}

// ---------- public API ----------

export class Memory {
  constructor({ dbPath, log = () => {} } = {}) {
    if (!Database || process.env.SUPER_TESTER_MEMORY_BACKEND === "memory") {
      const reason = !Database
        ? `better-sqlite3 unavailable: ${databaseLoadError?.message ?? "unknown error"}`
        : "SUPER_TESTER_MEMORY_BACKEND=memory";
      log(`[memory] using in-memory fallback (${reason})`);
      return new EphemeralMemory({ log });
    }

    this.dbPath = dbPath ?? resolveDbPath();
    ensureDir(this.dbPath);
    try {
      this.db = new Database(this.dbPath);
    } catch (e) {
      log(`[memory] using in-memory fallback (SQLite open failed: ${e.message})`);
      return new EphemeralMemory({ log });
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    applyMigrations(this.db);
    log(`[memory] db ${this.dbPath} (schema v${getCurrentVersion(this.db)})`);
  }

  close() {
    try { this.db.close(); } catch {}
  }

  now() {
    return new Date().toISOString();
  }

  // ---- selector cache ----

  recallSelector(origin, intent) {
    if (!origin || !intent) return null;
    const hash = intentHash(intent);
    return this.db.prepare(`
      SELECT origin, intent, selector, selector_alt, role, name, last_box,
             hit_count, miss_count, last_verified
        FROM selectors
       WHERE origin = ? AND intent_hash = ?
    `).get(origin, hash) ?? null;
  }

  recordSelectorHit({ origin, intent, selector, role, name, lastBox }) {
    if (!origin || !intent || !selector) return;
    const hash = intentHash(intent);
    const norm = normalizeIntent(intent);
    const now = this.now();
    const boxJson = lastBox ? JSON.stringify(lastBox) : null;

    const existing = this.db.prepare(
      "SELECT origin FROM selectors WHERE origin=? AND intent_hash=?"
    ).get(origin, hash);

    if (existing) {
      this.db.prepare(`
        UPDATE selectors
           SET selector = ?,
               role = COALESCE(?, role),
               name = COALESCE(?, name),
               last_box = COALESCE(?, last_box),
               hit_count = hit_count + 1,
               last_verified = ?
         WHERE origin = ? AND intent_hash = ?
      `).run(selector, role ?? null, name ?? null, boxJson, now, origin, hash);
    } else {
      this.db.prepare(`
        INSERT INTO selectors (origin, intent_hash, intent, selector, role, name,
                               last_box, hit_count, miss_count, last_verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(origin, hash, norm, selector, role ?? null, name ?? null, boxJson, now, now);
    }
  }

  recordSelectorMiss(origin, intent) {
    if (!origin || !intent) return;
    const hash = intentHash(intent);
    this.db.prepare(`
      UPDATE selectors SET miss_count = miss_count + 1
       WHERE origin = ? AND intent_hash = ?
    `).run(origin, hash);
  }

  // Replace the cached selector after self-healing found a new working one.
  updateSelector({ origin, intent, selector, role, name, lastBox }) {
    if (!origin || !intent || !selector) return;
    const hash = intentHash(intent);
    const now = this.now();
    const boxJson = lastBox ? JSON.stringify(lastBox) : null;
    this.db.prepare(`
      UPDATE selectors
         SET selector = ?, role = COALESCE(?, role), name = COALESCE(?, name),
             last_box = COALESCE(?, last_box), last_verified = ?
       WHERE origin = ? AND intent_hash = ?
    `).run(selector, role ?? null, name ?? null, boxJson, now, origin, hash);
  }

  forgetSelector(origin, intent) {
    if (!origin || !intent) return 0;
    const hash = intentHash(intent);
    return this.db.prepare(
      "DELETE FROM selectors WHERE origin=? AND intent_hash=?"
    ).run(origin, hash).changes;
  }

  listSelectors(origin) {
    if (origin) {
      return this.db.prepare(`
        SELECT origin, intent, selector, role, name, hit_count, miss_count, last_verified
          FROM selectors WHERE origin=? ORDER BY last_verified DESC
      `).all(origin);
    }
    return this.db.prepare(`
      SELECT origin, intent, selector, role, name, hit_count, miss_count, last_verified
        FROM selectors ORDER BY last_verified DESC LIMIT 200
    `).all();
  }

  // ---- workflows + steps ----

  saveWorkflow({ origin, name, description, steps }) {
    if (!origin) throw new Error("workflow requires an origin");
    if (!name) throw new Error("workflow requires a name");
    const now = this.now();
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM workflows WHERE origin=? AND name=?"
      ).get(origin, name);

      let id;
      if (existing) {
        id = existing.id;
        this.db.prepare(`
          UPDATE workflows SET description = COALESCE(?, description), updated_at = ?
           WHERE id = ?
        `).run(description ?? null, now, id);
        this.db.prepare("DELETE FROM steps WHERE workflow_id=?").run(id);
      } else {
        id = randomId();
        this.db.prepare(`
          INSERT INTO workflows (id, origin, name, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, origin, name, description ?? null, now, now);
      }

      const insStep = this.db.prepare(`
        INSERT INTO steps (id, workflow_id, ord, action, intent, selector, selector_alt,
                           role, name, value, params, expected, last_box, fail_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      let ord = 0;
      for (const s of steps ?? []) {
        insStep.run(
          randomId(), id, ord++, s.action,
          s.intent ?? null,
          s.selector ?? null,
          s.selector_alt ? JSON.stringify(s.selector_alt) : null,
          s.role ?? null,
          s.name ?? null,
          s.value ?? null,
          s.params ? JSON.stringify(s.params) : null,
          s.expected ? JSON.stringify(s.expected) : null,
          s.last_box ? JSON.stringify(s.last_box) : null,
        );
      }
      return { id, origin, name, stepCount: ord };
    })();
  }

  getWorkflow(origin, name) {
    const wf = this.db.prepare(
      "SELECT * FROM workflows WHERE origin=? AND name=?"
    ).get(origin, name);
    if (!wf) return null;
    const steps = this.db.prepare(
      "SELECT * FROM steps WHERE workflow_id=? ORDER BY ord ASC"
    ).all(wf.id).map(unpackStep);
    return { ...wf, steps };
  }

  listWorkflows(origin) {
    if (origin) {
      return this.db.prepare(`
        SELECT id, origin, name, description, updated_at,
               (SELECT COUNT(*) FROM steps WHERE workflow_id = workflows.id) AS step_count
          FROM workflows WHERE origin=? ORDER BY updated_at DESC
      `).all(origin);
    }
    return this.db.prepare(`
      SELECT id, origin, name, description, updated_at,
             (SELECT COUNT(*) FROM steps WHERE workflow_id = workflows.id) AS step_count
        FROM workflows ORDER BY updated_at DESC
    `).all();
  }

  deleteWorkflow(origin, name) {
    return this.db.prepare(
      "DELETE FROM workflows WHERE origin=? AND name=?"
    ).run(origin, name).changes;
  }

  bumpStepFail(stepId) {
    this.db.prepare("UPDATE steps SET fail_count = fail_count + 1 WHERE id=?").run(stepId);
  }

  patchStep(stepId, patch) {
    const cols = [];
    const vals = [];
    for (const k of ["selector", "role", "name", "last_box"]) {
      if (k in patch) {
        cols.push(`${k} = ?`);
        vals.push(typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]);
      }
    }
    if (!cols.length) return;
    vals.push(stepId);
    this.db.prepare(`UPDATE steps SET ${cols.join(", ")} WHERE id=?`).run(...vals);
  }

  // ---- run history ----

  startRun(workflowId, totalSteps) {
    const id = randomId();
    this.db.prepare(`
      INSERT INTO runs (id, workflow_id, started_at, status, steps_total)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, workflowId, this.now(), totalSteps);
    return id;
  }

  finishRun(runId, { status, stepsPassed, resultJson }) {
    this.db.prepare(`
      UPDATE runs SET ended_at = ?, status = ?, steps_passed = ?, result_json = ?
       WHERE id = ?
    `).run(this.now(), status, stepsPassed, JSON.stringify(resultJson ?? []), runId);
  }

  pruneRuns(workflowId, keep = 50) {
    this.db.prepare(`
      DELETE FROM runs
       WHERE workflow_id = ?
         AND id NOT IN (
           SELECT id FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?
         )
    `).run(workflowId, workflowId, keep);
  }

  listRuns(origin, name, limit = 20) {
    const wf = this.db.prepare(
      "SELECT id FROM workflows WHERE origin=? AND name=?"
    ).get(origin, name);
    if (!wf) return [];
    return this.db.prepare(`
      SELECT id, started_at, ended_at, status, steps_total, steps_passed
        FROM runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?
    `).all(wf.id, limit);
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
        action: s.action, intent: s.intent,
        selector: s.selector, selector_alt: s.selector_alt,
        role: s.role, name: s.name, value: s.value,
        params: s.params, expected: s.expected, last_box: s.last_box,
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

class EphemeralMemory {
  constructor({ log = () => {} } = {}) {
    this.selectors = new Map();
    this.workflows = new Map();
    this.workflowKeysById = new Map();
    this.runs = new Map();
    log("[memory] selector/workflow persistence is disabled for this process");
  }

  close() {}

  now() {
    return new Date().toISOString();
  }

  selectorKey(origin, intent) {
    return `${origin}\0${intentHash(intent)}`;
  }

  workflowKey(origin, name) {
    return `${origin}\0${name}`;
  }

  recallSelector(origin, intent) {
    if (!origin || !intent) return null;
    return this.selectors.get(this.selectorKey(origin, intent)) ?? null;
  }

  recordSelectorHit({ origin, intent, selector, role, name, lastBox }) {
    if (!origin || !intent || !selector) return;
    const key = this.selectorKey(origin, intent);
    const now = this.now();
    const existing = this.selectors.get(key);
    const last_box = lastBox ? JSON.stringify(lastBox) : existing?.last_box ?? null;
    if (existing) {
      this.selectors.set(key, {
        ...existing,
        selector,
        role: role ?? existing.role,
        name: name ?? existing.name,
        last_box,
        hit_count: existing.hit_count + 1,
        last_verified: now,
      });
    } else {
      this.selectors.set(key, {
        origin,
        intent: normalizeIntent(intent),
        selector,
        selector_alt: null,
        role: role ?? null,
        name: name ?? null,
        last_box: lastBox ? JSON.stringify(lastBox) : null,
        hit_count: 1,
        miss_count: 0,
        last_verified: now,
        created_at: now,
      });
    }
  }

  recordSelectorMiss(origin, intent) {
    const row = this.recallSelector(origin, intent);
    if (row) row.miss_count += 1;
  }

  updateSelector({ origin, intent, selector, role, name, lastBox }) {
    const row = this.recallSelector(origin, intent);
    if (!row || !selector) return;
    row.selector = selector;
    row.role = role ?? row.role;
    row.name = name ?? row.name;
    row.last_box = lastBox ? JSON.stringify(lastBox) : row.last_box;
    row.last_verified = this.now();
  }

  forgetSelector(origin, intent) {
    return this.selectors.delete(this.selectorKey(origin, intent)) ? 1 : 0;
  }

  listSelectors(origin) {
    return [...this.selectors.values()]
      .filter((row) => !origin || row.origin === origin)
      .sort((a, b) => String(b.last_verified).localeCompare(String(a.last_verified)))
      .slice(0, origin ? undefined : 200)
      .map(({ origin: rowOrigin, intent, selector, role, name, hit_count, miss_count, last_verified }) => ({
        origin: rowOrigin,
        intent,
        selector,
        role,
        name,
        hit_count,
        miss_count,
        last_verified,
      }));
  }

  saveWorkflow({ origin, name, description, steps }) {
    if (!origin) throw new Error("workflow requires an origin");
    if (!name) throw new Error("workflow requires a name");
    const key = this.workflowKey(origin, name);
    const now = this.now();
    const existing = this.workflows.get(key);
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
    this.workflows.set(key, wf);
    this.workflowKeysById.set(id, key);
    return { id, origin, name, stepCount: packedSteps.length };
  }

  getWorkflow(origin, name) {
    const wf = this.workflows.get(this.workflowKey(origin, name));
    if (!wf) return null;
    return { ...wf, steps: wf.steps.map((s) => ({ ...s })) };
  }

  listWorkflows(origin) {
    return [...this.workflows.values()]
      .filter((wf) => !origin || wf.origin === origin)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((wf) => ({
        id: wf.id,
        origin: wf.origin,
        name: wf.name,
        description: wf.description,
        updated_at: wf.updated_at,
        step_count: wf.steps.length,
      }));
  }

  deleteWorkflow(origin, name) {
    const key = this.workflowKey(origin, name);
    const wf = this.workflows.get(key);
    if (!wf) return 0;
    this.workflows.delete(key);
    this.workflowKeysById.delete(wf.id);
    this.runs.delete(wf.id);
    return 1;
  }

  bumpStepFail(stepId) {
    for (const wf of this.workflows.values()) {
      const step = wf.steps.find((s) => s.id === stepId);
      if (step) {
        step.fail_count += 1;
        return;
      }
    }
  }

  patchStep(stepId, patch) {
    for (const wf of this.workflows.values()) {
      const step = wf.steps.find((s) => s.id === stepId);
      if (!step) continue;
      for (const key of ["selector", "role", "name", "last_box"]) {
        if (key in patch) step[key] = patch[key];
      }
      return;
    }
  }

  startRun(workflowId, totalSteps) {
    const id = randomId();
    const rows = this.runs.get(workflowId) ?? [];
    rows.unshift({
      id,
      workflow_id: workflowId,
      started_at: this.now(),
      ended_at: null,
      status: "pending",
      steps_total: totalSteps,
      steps_passed: 0,
      result_json: "[]",
    });
    this.runs.set(workflowId, rows);
    return id;
  }

  finishRun(runId, { status, stepsPassed, resultJson }) {
    for (const rows of this.runs.values()) {
      const run = rows.find((r) => r.id === runId);
      if (!run) continue;
      run.ended_at = this.now();
      run.status = status;
      run.steps_passed = stepsPassed;
      run.result_json = JSON.stringify(resultJson ?? []);
      return;
    }
  }

  pruneRuns(workflowId, keep = 50) {
    const rows = this.runs.get(workflowId);
    if (rows) this.runs.set(workflowId, rows.slice(0, keep));
  }

  listRuns(origin, name, limit = 20) {
    const wf = this.workflows.get(this.workflowKey(origin, name));
    if (!wf) return [];
    return (this.runs.get(wf.id) ?? []).slice(0, limit).map((r) => ({
      id: r.id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      status: r.status,
      steps_total: r.steps_total,
      steps_passed: r.steps_passed,
    }));
  }

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

function unpackStep(row) {
  return {
    id: row.id,
    ord: row.ord,
    action: row.action,
    intent: row.intent,
    selector: row.selector,
    selector_alt: row.selector_alt ? safeParse(row.selector_alt) : null,
    role: row.role,
    name: row.name,
    value: row.value,
    params: row.params ? safeParse(row.params) : null,
    expected: row.expected ? safeParse(row.expected) : null,
    last_box: row.last_box ? safeParse(row.last_box) : null,
    fail_count: row.fail_count,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function randomId() {
  // 16 hex chars ≈ 64 bits; collision-free for our scale.
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
