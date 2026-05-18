// In-page send-hint modal for Mochi.
//
// Injected on demand by background.js when the user presses the configured
// keyboard shortcut (default Cmd+Shift+M / Ctrl+Shift+M). Lives in a shadow
// DOM container so it can't be styled (or seen) by the host page.
//
// Design: minimal modern productivity tool aesthetic — SF system font,
// inline stroke SVG iconography (no emoji), iOS-style toggle switches for
// the include-URL / include-console-errors flags, system dark-mode support
// via prefers-color-scheme.

(() => {
  const HOST_ID = "mochi-modal-host-9d2f7a1c";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    const ta = existing.shadowRoot?.querySelector("textarea");
    if (ta) ta.focus();
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

      /* -------- color tokens -------- */
      :host {
        --bg: #ffffff;
        --bg-subtle: rgba(0,0,0,0.04);
        --border: rgba(0,0,0,0.08);
        --border-strong: rgba(0,0,0,0.14);
        --text: #0a0a0a;
        --text-muted: #6e6e76;
        --text-soft: #8e8e94;
        --accent: #0a0a0a;
        --accent-fg: #ffffff;
        --primary: #2563eb;
        --primary-fg: #ffffff;
        --primary-hover: #1d4fd1;
        --success: #16a34a;
        --danger: #dc2626;
        --picked-bg: rgba(37, 99, 235, 0.08);
        --picked-border: rgba(37, 99, 235, 0.28);
        --picked-text: #1d4fd1;
        --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 28px -8px rgba(0,0,0,0.18), 0 4px 12px -2px rgba(0,0,0,0.08);
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #1c1c1f;
          --bg-subtle: rgba(255,255,255,0.05);
          --border: rgba(255,255,255,0.10);
          --border-strong: rgba(255,255,255,0.18);
          --text: #f5f5f7;
          --text-muted: #a1a1a6;
          --text-soft: #6e6e76;
          --accent: #f5f5f7;
          --accent-fg: #0a0a0a;
          --primary: #3b82f6;
          --primary-fg: #ffffff;
          --primary-hover: #4d8ffb;
          --success: #22c55e;
          --danger: #f87171;
          --picked-bg: rgba(59, 130, 246, 0.14);
          --picked-border: rgba(59, 130, 246, 0.32);
          --picked-text: #93c5fd;
          --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 16px 32px -8px rgba(0,0,0,0.5), 0 6px 16px -2px rgba(0,0,0,0.3);
        }
      }

      .backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.32);
        opacity: 0;
        transition: opacity 180ms ease-out;
        pointer-events: auto;
      }
      .backdrop.shown { opacity: 1; }
      .backdrop.picker { background: transparent; pointer-events: none; }
      @media (prefers-color-scheme: dark) {
        .backdrop { background: rgba(0,0,0,0.50); }
      }

      .modal {
        position: fixed;
        top: 80px; left: 50%;
        transform: translateX(-50%) translateY(-12px);
        width: min(520px, calc(100vw - 32px));
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow: var(--shadow);
        overflow: hidden;
        opacity: 0;
        transition: opacity 180ms ease-out, transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: auto;
        color: var(--text);
      }
      .modal.shown {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .modal.hidden-for-pick { opacity: 0; transform: translateX(-50%) translateY(-16px); pointer-events: none; transition: opacity 120ms ease-out, transform 160ms ease-out; }

      /* -------- header -------- */
      .titlebar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--border);
      }
      .brand { display: flex; align-items: baseline; gap: 8px; }
      .brand .name { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
      .brand .sub { font-size: 11.5px; font-weight: 500; color: var(--text-muted); letter-spacing: -0.005em; }
      .icon-btn {
        appearance: none; border: none; background: transparent;
        width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--text-muted); transition: background 100ms, color 100ms;
      }
      .icon-btn:hover { background: var(--bg-subtle); color: var(--text); }

      /* -------- body -------- */
      .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 14px; }

      .field-label {
        font-size: 11px; font-weight: 500;
        color: var(--text-muted);
        letter-spacing: 0.02em;
        text-transform: uppercase;
        margin-bottom: 6px;
      }

      select, textarea {
        font-family: inherit; font-size: 13.5px; color: var(--text);
        background: var(--bg); width: 100%;
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        padding: 8px 11px;
        transition: border-color 120ms, box-shadow 120ms;
      }
      select {
        padding-right: 30px;
        appearance: none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238e8e94' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
        background-repeat: no-repeat; background-position: right 11px center; background-size: 10px;
        cursor: pointer;
      }
      textarea {
        min-height: 92px; resize: vertical; line-height: 1.5;
      }
      textarea::placeholder { color: var(--text-soft); }
      select:focus, textarea:focus {
        outline: none;
        border-color: var(--primary);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }
      @media (prefers-color-scheme: dark) {
        select:focus, textarea:focus { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25); }
      }

      /* -------- picked-element chip -------- */
      .picked-chip {
        display: flex; align-items: center; gap: 9px;
        padding: 9px 11px;
        background: var(--picked-bg);
        border: 1px solid var(--picked-border);
        border-radius: 8px;
        font-size: 12.5px; color: var(--picked-text);
      }
      .picked-chip svg { flex-shrink: 0; }
      .picked-chip .selector {
        font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
        font-size: 11.5px;
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .picked-chip .x-btn {
        appearance: none; border: none; background: transparent;
        padding: 3px; border-radius: 4px; cursor: pointer;
        color: inherit; opacity: 0.6;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .picked-chip .x-btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
      @media (prefers-color-scheme: dark) { .picked-chip .x-btn:hover { background: rgba(255,255,255,0.10); } }

      /* -------- toggle rows -------- */
      .toggles {
        display: flex; flex-direction: column; gap: 2px;
        padding: 4px 0;
      }
      .toggle-row {
        display: flex; align-items: center; gap: 11px;
        padding: 7px 0;
        font-size: 13px;
        color: var(--text);
      }
      .toggle-row .label { flex: 1; display: flex; align-items: center; gap: 8px; }
      .toggle-row .label svg { color: var(--text-muted); flex-shrink: 0; }
      .toggle-row .hint { font-size: 11.5px; color: var(--text-soft); margin-left: 22px; }

      /* iOS-style switch */
      .switch { position: relative; display: inline-block; width: 32px; height: 20px; flex-shrink: 0; }
      .switch input { opacity: 0; width: 0; height: 0; }
      .switch .track {
        position: absolute; cursor: pointer; inset: 0;
        background: rgba(0,0,0,0.18);
        border-radius: 20px;
        transition: background 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .switch .thumb {
        position: absolute;
        top: 2px; left: 2px;
        width: 16px; height: 16px; border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 1px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.15);
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .switch input:checked + .track { background: #16a34a; }
      .switch input:checked + .track .thumb { transform: translateX(12px); }
      @media (prefers-color-scheme: dark) {
        .switch .track { background: rgba(255,255,255,0.18); }
        .switch input:checked + .track { background: #22c55e; }
      }

      /* -------- actions -------- */
      .actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; padding-top: 6px; border-top: 1px solid var(--border); margin-top: 2px; padding-top: 14px; }

      button.btn {
        appearance: none; border: 1px solid var(--border-strong);
        background: var(--bg);
        color: var(--text);
        padding: 7px 13px; border-radius: 7px; cursor: pointer;
        font-family: inherit; font-size: 12.5px; font-weight: 500;
        display: inline-flex; align-items: center; gap: 6px;
        transition: background 100ms, border-color 100ms, transform 80ms;
      }
      button.btn:hover { background: var(--bg-subtle); border-color: var(--border-strong); }
      button.btn:active { transform: scale(0.98); }
      button.btn.primary {
        background: var(--primary); color: var(--primary-fg); border-color: var(--primary);
      }
      button.btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
      button.btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
      button.btn svg { flex-shrink: 0; }

      .status {
        font-size: 11.5px; color: var(--text-soft); min-height: 14px;
        margin-top: 8px; transition: color 120ms;
      }
      .status.ok  { color: var(--success); }
      .status.err { color: var(--danger); }

      /* -------- element picker overlay -------- */
      .picker-info {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        background: rgba(20,20,22,0.95);
        backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        color: white; padding: 8px 14px; border-radius: 8px;
        font-size: 12px; font-family: -apple-system, system-ui;
        z-index: 2147483647; pointer-events: none;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        display: inline-flex; align-items: center; gap: 8px;
      }
      .picker-info code {
        font-family: ui-monospace, "SF Mono", monospace;
        font-size: 11px;
        background: rgba(255,255,255,0.10);
        padding: 2px 6px; border-radius: 4px;
      }
    </style>

    <div class="backdrop"></div>
    <div class="modal" role="dialog" aria-label="Mochi send hint">
      <div class="titlebar">
        <div class="brand">
          <span class="name">Mochi</span>
          <span class="sub">Send hint</span>
        </div>
        <button class="icon-btn" id="m-close" title="Close (Esc)" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="body">
        <div>
          <div class="field-label">Session</div>
          <select id="m-session"></select>
        </div>
        <div>
          <div class="field-label">Hint</div>
          <textarea id="m-text" placeholder="What should the agent know? Lands as a system reminder on its next tool call."></textarea>
        </div>
        <div id="m-picked-wrap" style="display:none;"></div>
        <div class="toggles">
          <div class="toggle-row">
            <div class="label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              <span>Include current URL</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="t-url" checked />
              <span class="track"><span class="thumb"></span></span>
            </label>
          </div>
          <div class="toggle-row">
            <div class="label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Include recent console errors</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="t-errors" checked />
              <span class="track"><span class="thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="actions">
          <button class="btn" id="m-pick" title="Pick a DOM element to attach">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>
            <span>Pick element</span>
          </button>
          <button class="btn primary" id="m-send">
            <span>Send</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
        <div class="status" id="m-status"></div>
      </div>
    </div>
  `;

  const backdrop = root.querySelector(".backdrop");
  const modal    = root.querySelector(".modal");
  const select   = root.querySelector("#m-session");
  const textarea = root.querySelector("#m-text");
  const pickedWrap = root.querySelector("#m-picked-wrap");
  const tUrl     = root.querySelector("#t-url");
  const tErrors  = root.querySelector("#t-errors");
  const pickBtn  = root.querySelector("#m-pick");
  const sendBtn  = root.querySelector("#m-send");
  const closeBtn = root.querySelector("#m-close");
  const status   = root.querySelector("#m-status");

  let pickedElement = null;

  function setStatus(text, cls = "") {
    status.textContent = text;
    status.className = "status" + (cls ? " " + cls : "");
  }

  function close() {
    backdrop.classList.remove("shown");
    modal.classList.remove("shown");
    setTimeout(() => { try { host.remove(); } catch {} }, 220);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function renderPicked() {
    if (!pickedElement) { pickedWrap.style.display = "none"; pickedWrap.innerHTML = ""; return; }
    pickedWrap.style.display = "block";
    pickedWrap.innerHTML = `
      <div class="picked-chip">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
        <span class="selector">${escapeHtml(pickedElement.selector)}</span>
        <button class="x-btn" title="Remove" aria-label="Remove picked element">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `;
    pickedWrap.querySelector(".x-btn").addEventListener("click", () => {
      pickedElement = null;
      renderPicked();
      textarea.focus();
    });
  }

  async function loadSessions() {
    let res;
    try { res = await chrome.runtime.sendMessage({ type: "popup_get_claude_sessions" }); }
    catch { res = null; }
    const sessions = (res && Array.isArray(res.sessions)) ? res.sessions : [];
    if (sessions.length === 0) {
      select.innerHTML = `<option value="" disabled selected>No active Claude sessions</option>`;
      sendBtn.disabled = true;
      setStatus("No Claude sessions registered. Start one with the Continuum plugin to enable sending.", "err");
      return;
    }
    select.innerHTML = "";
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.sessionId;
      opt.textContent = s.name || s.sessionId;
      select.appendChild(opt);
    }
    sendBtn.disabled = false;
  }

  async function send() {
    const sessionId = select.value;
    const message = textarea.value.trim();
    if (!sessionId) { setStatus("Pick a session first.", "err"); return; }
    if (!message) { setStatus("Type something first.", "err"); textarea.focus(); return; }

    setStatus("Sending…");
    sendBtn.disabled = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "popup_send_claude_message",
        sessionId, message,
        includeUrl: tUrl.checked,
        includeConsoleErrors: tErrors.checked,
        domContext: pickedElement,
      });
    } catch (e) {
      setStatus(`Send failed: ${e?.message ?? e}`, "err");
      sendBtn.disabled = false;
      return;
    }
    sendBtn.disabled = false;
    if (res?.ok) {
      setStatus("Delivered. Agent will see it on its next tool call.", "ok");
      setTimeout(close, 800);
    } else {
      setStatus(res?.error || "Send failed.", "err");
    }
  }

  // ---- Element picker ----
  let pickerOutline = null;
  let pickerInfo = null;
  let pickerActive = false;

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    modal.classList.add("hidden-for-pick");
    backdrop.classList.add("picker");

    pickerOutline = document.createElement("div");
    pickerOutline.style.cssText = "position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,0.10);border-radius:3px;z-index:2147483646;box-shadow:0 0 0 1px rgba(255,255,255,0.6),0 4px 12px rgba(0,0,0,0.18);transition:all 60ms ease-out;";
    document.documentElement.appendChild(pickerOutline);

    pickerInfo = document.createElement("div");
    pickerInfo.className = "picker-info";
    pickerInfo.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(20,20,22,0.95);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);color:white;padding:8px 14px;border-radius:8px;font-size:12px;font-family:-apple-system,system-ui;z-index:2147483647;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.25);display:inline-flex;align-items:center;gap:8px;";
    pickerInfo.innerHTML = `<span>Hover an element · click to pick · Esc to cancel</span>`;
    document.documentElement.appendChild(pickerInfo);

    document.addEventListener("mousemove", onPickerMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKey, true);
  }

  function stopPicker() {
    pickerActive = false;
    document.removeEventListener("mousemove", onPickerMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("keydown", onPickerKey, true);
    try { pickerOutline?.remove(); } catch {}
    try { pickerInfo?.remove(); } catch {}
    pickerOutline = null; pickerInfo = null;
    modal.classList.remove("hidden-for-pick");
    backdrop.classList.remove("picker");
  }

  function onPickerMove(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === host || host.contains(el)) return;
    if (!pickerOutline) return;
    const r = el.getBoundingClientRect();
    pickerOutline.style.left = `${r.left}px`;
    pickerOutline.style.top  = `${r.top}px`;
    pickerOutline.style.width  = `${r.width}px`;
    pickerOutline.style.height = `${r.height}px`;
    if (pickerInfo) {
      const sel = uniqueSelector(el);
      pickerInfo.innerHTML = `<code>${escapeHtml(sel.slice(0, 70))}${sel.length > 70 ? "…" : ""}</code>`;
    }
  }

  function onPickerClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === host || host.contains(el)) { stopPicker(); return; }
    pickedElement = serializeElement(el);
    stopPicker();
    renderPicked();
    textarea.focus();
  }

  function onPickerKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      stopPicker();
    }
  }

  function uniqueSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        const cls = [...cur.classList].slice(0, 2).map((c) => c.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join(".");
        if (cls) part += "." + cls;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) {
          const idx = sibs.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length >= 6) break;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function serializeElement(el) {
    const r = el.getBoundingClientRect();
    const html = (el.outerHTML || "").slice(0, 800);
    const text = (el.innerText || el.textContent || "").trim().slice(0, 300);
    const cs = window.getComputedStyle(el);
    return {
      selector: uniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === "string" ? el.className : null,
      outerHTML: html,
      text,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      visibility: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity },
    };
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !pickerActive) close(); });
  pickBtn.addEventListener("click", startPicker);
  sendBtn.addEventListener("click", send);
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.key === "Escape" && !pickerActive) { e.preventDefault(); close(); }
  });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape" && !pickerActive && document.getElementById(HOST_ID)) {
      e.preventDefault();
      close();
      document.removeEventListener("keydown", escHandler, true);
    }
  }, true);

  requestAnimationFrame(() => {
    backdrop.classList.add("shown");
    modal.classList.add("shown");
    textarea.focus();
  });

  loadSessions();
})();
