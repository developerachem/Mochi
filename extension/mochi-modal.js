// In-page send-hint modal for Mochi.
//
// Injected on demand by background.js when the user presses the configured
// keyboard shortcut (default Cmd+Shift+M / Ctrl+Shift+M). Lives in a shadow
// DOM container so it can't be styled (or seen) by the host page. macOS-
// vibrancy aesthetic: translucent blurred backdrop, rounded corners, SF font.
//
// Features:
//   - Session dropdown (populated from background's claudeSessionsCache)
//   - Hint textarea (autofocus)
//   - "Pick element" button → hides modal, lets user click any DOM node;
//     captured element shown as a removable chip and shipped with the hint
//   - "Include URL + console errors" toggle
//   - Send button → fires popup_send_claude_message IPC
//
// Idempotent: pressing the shortcut twice opens-then-focuses the same modal
// (we tag the container DOM node so a re-injection finds it and reuses it).

(() => {
  const HOST_ID = "mochi-modal-host-9d2f7a1c";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    // Already open — focus the textarea and bail.
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
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }

      .backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.18);
        opacity: 0;
        transition: opacity 180ms ease-out;
        pointer-events: auto;
      }
      .backdrop.shown { opacity: 1; }
      .backdrop.picker { background: transparent; pointer-events: none; }

      .modal {
        position: fixed;
        top: 88px; left: 50%;
        transform: translateX(-50%) translateY(-8px);
        width: min(520px, calc(100vw - 32px));
        background: rgba(245, 245, 247, 0.78);
        backdrop-filter: blur(40px) saturate(180%);
        -webkit-backdrop-filter: blur(40px) saturate(180%);
        border: 0.5px solid rgba(0,0,0,0.12);
        border-radius: 16px;
        box-shadow:
          0 24px 60px rgba(0,0,0,0.20),
          0 4px 16px rgba(0,0,0,0.08),
          inset 0 0 0 0.5px rgba(255,255,255,0.5);
        overflow: hidden;
        opacity: 0;
        transition: opacity 200ms ease-out, transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: auto;
        color: #1d1d1f;
      }
      .modal.shown {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .modal.hidden-for-pick { opacity: 0; transform: translateX(-50%) translateY(-16px); pointer-events: none; transition: opacity 120ms ease-out, transform 160ms ease-out; }

      .titlebar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px 8px;
        border-bottom: 0.5px solid rgba(0,0,0,0.08);
      }
      .title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: #1d1d1f; letter-spacing: -0.01em; }
      .title .bun { font-size: 18px; line-height: 1; }
      .close {
        appearance: none; border: none; background: rgba(0,0,0,0.06);
        width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: rgba(0,0,0,0.55); font-size: 13px; transition: background 120ms;
      }
      .close:hover { background: rgba(0,0,0,0.10); color: #1d1d1f; }

      .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }

      label.row { font-size: 11px; color: #6e6e73; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; display: block; }

      select, textarea, button, input { font-family: inherit; font-size: 13px; color: #1d1d1f; }

      select {
        width: 100%; padding: 7px 28px 7px 10px;
        border: 0.5px solid rgba(0,0,0,0.15);
        background: rgba(255,255,255,0.7);
        border-radius: 8px;
        appearance: none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M0 0l5 6 5-6z' fill='%236e6e73'/></svg>");
        background-repeat: no-repeat; background-position: right 10px center; background-size: 10px;
      }
      select:focus { outline: 2px solid #007aff; outline-offset: -2px; border-color: transparent; }

      textarea {
        width: 100%; min-height: 84px; resize: vertical;
        padding: 9px 11px;
        border: 0.5px solid rgba(0,0,0,0.15);
        background: rgba(255,255,255,0.7);
        border-radius: 8px;
        line-height: 1.45;
      }
      textarea::placeholder { color: rgba(0,0,0,0.32); }
      textarea:focus { outline: 2px solid #007aff; outline-offset: -2px; border-color: transparent; }

      .picked {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px;
        background: rgba(255, 107, 168, 0.10);
        border: 0.5px solid rgba(255, 107, 168, 0.35);
        border-radius: 8px;
        font-size: 12px; color: #5b2841;
      }
      .picked code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; background: rgba(255,255,255,0.6); padding: 1px 5px; border-radius: 4px; }
      .picked .pin { font-size: 13px; }
      .picked .x { margin-left: auto; cursor: pointer; padding: 2px 6px; border-radius: 4px; color: rgba(0,0,0,0.5); }
      .picked .x:hover { background: rgba(0,0,0,0.08); color: #1d1d1f; }

      .opts { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #424245; }
      .opts input[type=checkbox] { accent-color: #007aff; }

      .actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; padding-top: 4px; }
      .actions .left { display: flex; gap: 8px; }

      button.btn {
        appearance: none; border: 0.5px solid rgba(0,0,0,0.15);
        background: rgba(255,255,255,0.8);
        padding: 7px 14px; border-radius: 8px; cursor: pointer;
        font-weight: 500; transition: transform 80ms, background 120ms;
      }
      button.btn:hover { background: rgba(255,255,255,1); }
      button.btn:active { transform: scale(0.97); }
      button.btn.primary {
        background: linear-gradient(180deg, #2a92ff, #0066d6);
        color: white; border-color: rgba(0, 102, 214, 0.6);
        box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.4), 0 1px 2px rgba(0, 102, 214, 0.3);
      }
      button.btn.primary:hover { background: linear-gradient(180deg, #4aa0ff, #1170d4); }
      button.btn.primary:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }

      .status { font-size: 11px; color: #6e6e73; min-height: 14px; transition: color 120ms; }
      .status.ok  { color: #2da44e; }
      .status.err { color: #c93c20; }

      .empty {
        padding: 16px;
        text-align: center;
        font-size: 12px;
        color: #6e6e73;
        background: rgba(255, 200, 0, 0.08);
        border: 0.5px solid rgba(255, 200, 0, 0.3);
        border-radius: 8px;
      }

      /* Element-picker overlay */
      .picker-outline {
        position: fixed; pointer-events: none;
        border: 2px solid #ff6ba8;
        background: rgba(255, 107, 168, 0.08);
        border-radius: 2px;
        z-index: 2147483646;
        transition: all 60ms ease-out;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.6), 0 2px 8px rgba(0,0,0,0.15);
      }
      .picker-info {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        background: rgba(20,20,22,0.92);
        backdrop-filter: blur(20px);
        color: white; padding: 7px 14px; border-radius: 20px;
        font-size: 12px; font-family: -apple-system, system-ui;
        z-index: 2147483647; pointer-events: none;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      }
      .picker-info code { font-family: ui-monospace, "SF Mono", monospace; opacity: 0.85; }
    </style>

    <div class="backdrop"></div>
    <div class="modal" role="dialog" aria-label="Mochi send hint">
      <div class="titlebar">
        <div class="title"><span class="bun">🐰</span> Mochi · Send hint to Claude</div>
        <button class="close" title="Close (Esc)">✕</button>
      </div>
      <div class="body">
        <div>
          <label class="row">Session</label>
          <select id="m-session"></select>
        </div>
        <div>
          <label class="row">Hint</label>
          <textarea id="m-text" placeholder="What should the agent know? Lands as a system-reminder on its next tool call."></textarea>
        </div>
        <div id="m-picked-wrap" style="display:none;"></div>
        <div class="opts">
          <input type="checkbox" id="m-ctx" checked />
          <label for="m-ctx">Include current URL + recent console errors</label>
        </div>
        <div class="actions">
          <div class="left">
            <button class="btn" id="m-pick" title="Pick a DOM element to attach">📍 Pick element</button>
          </div>
          <button class="btn primary" id="m-send">Send hint</button>
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
  const ctxCheck = root.querySelector("#m-ctx");
  const pickBtn  = root.querySelector("#m-pick");
  const sendBtn  = root.querySelector("#m-send");
  const closeBtn = root.querySelector(".close");
  const status   = root.querySelector("#m-status");

  let pickedElement = null; // {selector, html, text, rect, tagName}

  function setStatus(text, cls = "") {
    status.textContent = text;
    status.className = "status" + (cls ? " " + cls : "");
  }

  function close() {
    backdrop.classList.remove("shown");
    modal.classList.remove("shown");
    setTimeout(() => { try { host.remove(); } catch {} }, 220);
  }

  function renderPicked() {
    if (!pickedElement) { pickedWrap.style.display = "none"; pickedWrap.innerHTML = ""; return; }
    pickedWrap.style.display = "block";
    pickedWrap.innerHTML = `
      <div class="picked">
        <span class="pin">📍</span>
        <span>Picked:</span>
        <code>${escapeHtml(pickedElement.selector)}</code>
        <span class="x" title="Remove">✕</span>
      </div>
    `;
    pickedWrap.querySelector(".x").addEventListener("click", () => {
      pickedElement = null;
      renderPicked();
      textarea.focus();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  // ---- Populate sessions ----
  async function loadSessions() {
    let res;
    try { res = await chrome.runtime.sendMessage({ type: "popup_get_claude_sessions" }); }
    catch { res = null; }
    const sessions = (res && Array.isArray(res.sessions)) ? res.sessions : [];
    if (sessions.length === 0) {
      select.innerHTML = "";
      sendBtn.disabled = true;
      setStatus("No Claude sessions registered. Start a session with the Continuum plugin first.", "err");
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

  // ---- Send action ----
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
        includeContext: ctxCheck.checked,
        domContext: pickedElement,
      });
    } catch (e) {
      setStatus(`Send failed: ${e?.message ?? e}`, "err");
      sendBtn.disabled = false;
      return;
    }
    sendBtn.disabled = false;
    if (res?.ok) {
      setStatus("✓ Delivered — agent will see it on its next tool call", "ok");
      setTimeout(close, 700);
    } else {
      setStatus(res?.error || "Send failed", "err");
    }
  }

  // ---- Element picker mode ----
  let pickerOutline = null;
  let pickerInfo = null;
  let pickerActive = false;

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    modal.classList.add("hidden-for-pick");
    backdrop.classList.add("picker");

    pickerOutline = document.createElement("div");
    pickerOutline.className = "picker-outline";
    pickerOutline.style.cssText = "position:fixed;pointer-events:none;border:2px solid #ff6ba8;background:rgba(255,107,168,0.08);border-radius:2px;z-index:2147483646;box-shadow:0 0 0 1px rgba(255,255,255,0.6),0 2px 8px rgba(0,0,0,0.15);transition:all 60ms ease-out;";
    document.documentElement.appendChild(pickerOutline);

    pickerInfo = document.createElement("div");
    pickerInfo.className = "picker-info";
    pickerInfo.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(20,20,22,0.92);backdrop-filter:blur(20px);color:white;padding:7px 14px;border-radius:20px;font-size:12px;font-family:-apple-system,system-ui;z-index:2147483647;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.25);";
    pickerInfo.textContent = "Hover an element · click to pick · Esc to cancel";
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
    if (pickerInfo) pickerInfo.innerHTML = `<code>${escapeHtml(uniqueSelector(el).slice(0, 80))}</code>`;
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

  // ---- Element serialization helpers ----
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

  // ---- Wire-up ----
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

  // Fade in
  requestAnimationFrame(() => {
    backdrop.classList.add("shown");
    modal.classList.add("shown");
    textarea.focus();
  });

  loadSessions();
})();
