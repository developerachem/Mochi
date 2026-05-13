async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup_status" });
  if (!res) return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (res.status === "connected") {
    dot.className = "dot ok";
    text.textContent = "connected";
  } else {
    dot.className = "dot bad";
    text.textContent = "disconnected";
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
