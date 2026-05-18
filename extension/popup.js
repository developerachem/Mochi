// ---------- Bridge status ----------
async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup_status" });
  if (!res) return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const takeOverBtn = document.getElementById("take-over-btn");
  if (res.status === "connected" && res.role === "active") {
    dot.className = "dot ok";
    text.textContent = "Active";
    takeOverBtn.style.display = "none";
  } else if (res.status === "connected" && res.role === "standby") {
    dot.className = "dot standby";
    text.textContent = "Standby";
    takeOverBtn.style.display = "block";
  } else {
    dot.className = "dot bad";
    text.textContent = "Disconnected";
    takeOverBtn.style.display = "none";
  }

  const count = res.sessionCount ?? 0;
  const sessionText = document.getElementById("session-text");
  if (count === 0) {
    sessionText.textContent = "none";
  } else {
    const tabs = (res.sessions ?? []).reduce((n, s) => n + s.tabCount, 0);
    sessionText.textContent = `${count} session${count > 1 ? "s" : ""}, ${tabs} tab${tabs !== 1 ? "s" : ""}`;
  }

  // Sync the auto-connect switch with state (only if user isn't actively toggling)
  const sw = document.getElementById("auto-connect-switch");
  if (sw && document.activeElement !== sw) sw.checked = !!res.connectionEnabled;
}

document.getElementById("take-over-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_take_over" });
  refresh();
});

document.getElementById("toggle-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});
document.getElementById("auto-connect-switch").addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});

document.getElementById("end-session-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_end_all_sessions" });
  refresh();
});

refresh();
setInterval(refresh, 1500);

// ---------- Claude Sessions section ----------
async function refreshClaudeSessions() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "popup_get_claude_sessions" });
  } catch { return; }
  const sessions = (res && Array.isArray(res.sessions)) ? res.sessions : [];

  const empty = document.getElementById("claude-empty");
  const list = document.getElementById("claude-list");
  const form = document.getElementById("claude-form");
  const target = document.getElementById("claude-target");

  for (const el of list.querySelectorAll(".session-row")) el.remove();

  if (sessions.length === 0) {
    empty.style.display = "block";
    form.style.display = "none";
    target.innerHTML = "";
    return;
  }
  empty.style.display = "none";
  form.style.display = "flex";

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const name = document.createElement("span");
    name.className = "session-name";
    name.title = `${s.name} · ${s.sessionId}`;
    name.textContent = s.name || s.sessionId;
    const badge = document.createElement("span");
    badge.className = "session-badge" + (s.queuedCount ? " queued" : "");
    badge.textContent = s.queuedCount > 0 ? `${s.queuedCount} queued` : "idle";
    row.appendChild(name);
    row.appendChild(badge);
    list.insertBefore(row, empty);
  }

  const prev = target.value;
  target.innerHTML = "";
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.sessionId;
    opt.textContent = s.name || s.sessionId;
    target.appendChild(opt);
  }
  if (sessions.some((s) => s.sessionId === prev)) target.value = prev;
}

document.getElementById("claude-send-btn").addEventListener("click", async () => {
  const sessionId = document.getElementById("claude-target").value;
  const message = document.getElementById("claude-message").value;
  const includeUrl = document.getElementById("t-url").checked;
  const includeConsoleErrors = document.getElementById("t-errors").checked;
  const includeShot = document.getElementById("t-shot").checked;
  const status = document.getElementById("claude-status");

  if (!sessionId) { status.className = "status err"; status.textContent = "No session selected."; return; }
  if (!message.trim()) { status.className = "status err"; status.textContent = "Type something first."; return; }

  status.className = "status"; status.textContent = "Sending…";
  let res;
  try {
    // Popup has no element picker, so screenshot scope is always the
    // visible viewport. Background determines tab dpr from chrome.tabs.
    const screenshotIntent = includeShot ? { scope: "viewport", rect: null } : null;
    res = await chrome.runtime.sendMessage({
      type: "popup_send_claude_message",
      sessionId, message: message.trim(),
      includeUrl, includeConsoleErrors,
      screenshotIntent,
    });
  } catch (e) {
    status.className = "status err"; status.textContent = String(e?.message ?? e); return;
  }
  if (res?.ok) {
    document.getElementById("claude-message").value = "";
    status.className = "status ok";
    status.textContent = "Delivered. Agent will see it on its next tool call.";
    refreshClaudeSessions();
    setTimeout(() => { status.textContent = ""; status.className = "status"; }, 3000);
  } else {
    status.className = "status err";
    status.textContent = res?.error || "Send failed.";
  }
});

refreshClaudeSessions();
setInterval(refreshClaudeSessions, 1500);

// ---------- Visuals settings ----------
async function loadVisuals() {
  const v = (await chrome.storage.local.get(["visualsDefault"])).visualsDefault
    ?? { enabled: true, cursor: true, hud: true, slowMo: 0 };
  document.getElementById("visuals-cursor").checked = !!v.cursor;
  document.getElementById("visuals-hud").checked = !!v.hud;
  document.getElementById("visuals-slowmo").value = String(v.slowMo ?? 0);
}

async function saveVisuals() {
  const v = {
    enabled: true,
    cursor: document.getElementById("visuals-cursor").checked,
    hud:    document.getElementById("visuals-hud").checked,
    slowMo: Math.max(0, Math.min(5000, Number(document.getElementById("visuals-slowmo").value) || 0)),
  };
  await chrome.storage.local.set({ visualsDefault: v });
}

["visuals-cursor","visuals-hud","visuals-slowmo"].forEach((id) => {
  document.getElementById(id).addEventListener("change", saveVisuals);
});

loadVisuals();
