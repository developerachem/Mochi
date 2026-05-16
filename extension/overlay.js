// Super-Tester visual overlay. Injected via chrome.scripting.executeScript
// into every session tab after the debugger attaches. Renders an animated
// cursor + target ring + click ripple + HUD narration in a Shadow-DOM root
// that's pinned at the top of the stacking context and ignores pointer events.

(() => {
  if (window.__superTesterOverlayInstalled) return;
  window.__superTesterOverlayInstalled = true;

  let config = { enabled: true, cursor: true, hud: true, slowMo: 0 };
  let cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  // Host element pinned over the page; closed shadow root keeps the page's
  // CSS out and our DOM unreachable from page scripts.
  const host = document.createElement("div");
  host.id = "super-tester-overlay-host";
  Object.assign(host.style, {
    position: "fixed", inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .cursor, .ring, .ripple, .hud { position: fixed; pointer-events: none; will-change: transform, opacity; }
    .cursor { width: 24px; height: 24px; left: 0; top: 0;
              transform: translate3d(0,0,0); z-index: 2147483646; }
    .cursor svg { width: 100%; height: 100%; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45)); }
    .ring { border: 3px solid #22d3ee; border-radius: 6px;
            box-shadow: 0 0 0 6px rgba(34,211,238,0.18);
            opacity: 0; transition: opacity 200ms ease-out, transform 200ms ease-out; }
    .ring.fail { border-color: #ef4444; box-shadow: 0 0 0 6px rgba(239,68,68,0.20); }
    .ripple { width: 40px; height: 40px; border-radius: 50%;
              background: rgba(34,211,238,0.35); opacity: 0; }
    .hud { top: 16px; left: 50%; transform: translateX(-50%);
           background: rgba(15,23,42,0.86); color: white;
           font: 13px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
           padding: 10px 16px; border-radius: 999px;
           max-width: 70vw; white-space: nowrap;
           overflow: hidden; text-overflow: ellipsis;
           opacity: 0; transition: opacity 200ms ease-out; }
    .hud.show { opacity: 1; }
    .hud.fail { color: #fca5a5; }
  `;
  root.appendChild(style);

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L3 18 L8 14 L11 21 L14 20 L11 13 L18 13 Z"
            fill="white" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  cursor.style.transform = `translate3d(${cursorPos.x}px, ${cursorPos.y}px, 0)`;
  root.appendChild(cursor);

  // Listener stub — actual handlers added in later tasks.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.kind !== "string") return;
    if (msg.kind === "overlay.init") {
      config = { ...config, ...(msg.config ?? {}) };
      cursor.style.display = config.enabled && config.cursor ? "" : "none";
    }
  });
})();
