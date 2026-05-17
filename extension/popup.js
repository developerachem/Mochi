async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup_status" });
  if (!res) return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const takeOverBtn = document.getElementById("take-over-btn");
  if (res.status === "connected" && res.role === "active") {
    dot.className = "dot ok";
    text.textContent = "active";
    takeOverBtn.style.display = "none";
  } else if (res.status === "connected" && res.role === "standby") {
    dot.className = "dot standby";
    text.textContent = "standby (another profile is active)";
    takeOverBtn.style.display = "block";
  } else {
    dot.className = "dot bad";
    text.textContent = "disconnected";
    takeOverBtn.style.display = "none";
  }
  const count = res.sessionCount ?? 0;
  if (count === 0) {
    document.getElementById("session-text").textContent = "none";
  } else {
    const tabs = (res.sessions ?? []).reduce((n, s) => n + s.tabCount, 0);
    document.getElementById("session-text").textContent =
      `${count} session${count > 1 ? "s" : ""}, ${tabs} tab${tabs !== 1 ? "s" : ""}`;
  }
  document.getElementById("enabled-text").textContent = res.connectionEnabled ? "on" : "off";
}

document.getElementById("take-over-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_take_over" });
  refresh();
});

document.getElementById("toggle-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});

document.getElementById("end-session-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_end_all_sessions" });
  refresh();
});

refresh();
setInterval(refresh, 1500);

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
