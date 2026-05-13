// In-memory trace of successful actions inside the active session.
// Resets on session_start. Persisted into a workflow on workflow_save.
// Lives only in the server process — does not touch SQLite until saved.

export class SessionTrace {
  constructor() {
    this.reset();
  }

  reset(sessionId = null) {
    this.sessionId = sessionId;
    this.entries = [];
    this.firstUrl = null;
  }

  record(action, payload) {
    if (!this.sessionId) return;
    this.entries.push({
      action,
      ...payload,
      ts: Date.now(),
    });
    if (!this.firstUrl && payload.url) this.firstUrl = payload.url;
  }

  // Convert the live trace into the persistable step shape the workflow store
  // expects. We collapse adjacent navigations to the same URL, drop reads
  // (snapshot, list_tabs, screenshot) — only writes belong in a replay.
  asSteps() {
    const out = [];
    let lastNavUrl = null;
    for (const e of this.entries) {
      switch (e.action) {
        case "navigate":
          if (e.url === lastNavUrl) continue;
          lastNavUrl = e.url;
          out.push({ action: "navigate", value: e.url, intent: e.intent ?? null });
          break;
        case "click":
        case "click_at":
          out.push({
            action: e.action,
            intent: e.intent ?? null,
            selector: e.ref ?? null,
            role: e.role ?? null,
            name: e.name ?? null,
            value: e.action === "click_at" ? `${e.x},${e.y}` : null,
            last_box: e.box ?? null,
            params: { button: e.button, clickCount: e.clickCount, x: e.x, y: e.y },
          });
          break;
        case "type":
          out.push({
            action: "type",
            intent: e.intent ?? null,
            selector: e.ref ?? null,
            role: e.role ?? null,
            name: e.name ?? null,
            value: e.text ?? "",
            params: { submit: !!e.submit, clear: e.clear !== false },
          });
          break;
        case "press_key":
          out.push({ action: "press_key", value: e.key });
          break;
        case "scroll":
          out.push({ action: "scroll", params: { x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY } });
          break;
        case "wait":
          out.push({ action: "wait", value: String(e.ms ?? 0) });
          break;
        case "assert":
          out.push({ action: "assert", expected: e.expected, intent: e.intent ?? null });
          break;
        default: break;
      }
    }
    return out;
  }

  size() { return this.entries.length; }
}
