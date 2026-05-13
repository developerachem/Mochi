// Launches Chrome with a dedicated user-data-dir so the Super-Tester extension
// auto-loads in a clean profile. Idempotent — if Chrome with that profile is
// already running, --user-data-dir routes the new instance to the existing process.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROFILE_NAME = "super-tester-profile";

// Auto-resolve to the bundled `extension/` shipped with this package.
// Layout: <pkg>/server/src/chrome-launcher.js  +  <pkg>/extension/
const __filename = fileURLToPath(import.meta.url);
const BUNDLED_EXTENSION_PATH = path.resolve(__filename, "..", "..", "..", "extension");

function resolveExtensionPath() {
  const fromEnv = process.env.SUPER_TESTER_EXTENSION_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  if (existsSync(path.join(BUNDLED_EXTENSION_PATH, "manifest.json"))) {
    return BUNDLED_EXTENSION_PATH;
  }
  return null;
}

const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["LocalAppData"] && path.join(process.env["LocalAppData"], "Google", "Chrome", "Application", "chrome.exe"),
  ],
};

function findChromeBinary() {
  if (process.env.SUPER_TESTER_CHROME_PATH) {
    return existsSync(process.env.SUPER_TESTER_CHROME_PATH) ? process.env.SUPER_TESTER_CHROME_PATH : null;
  }
  const list = CHROME_CANDIDATES[platform()] ?? [];
  for (const p of list) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

let launchedAlready = false;

export async function launchChromeIfNeeded(log = () => {}) {
  if (launchedAlready) return { skipped: true, reason: "already-launched-this-process" };

  const bin = findChromeBinary();
  if (!bin) {
    log("[chrome-launcher] no Chrome binary found — please launch Chrome manually");
    return { skipped: true, reason: "no-binary" };
  }

  const profileDir = process.env.SUPER_TESTER_PROFILE_DIR
    ?? path.join(homedir(), ".super-tester", DEFAULT_PROFILE_NAME);

  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--restore-last-session=false",
  ];

  // Resolve the extension path: explicit env var → bundled `extension/` next
  // to the server. Without this, the user must install the extension manually
  // once into the profile.
  const extensionPath = resolveExtensionPath();
  if (extensionPath) {
    args.unshift(`--load-extension=${extensionPath}`);
    args.unshift("--enable-extensions");
  }

  args.push("about:blank");

  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  launchedAlready = true;

  log(`[chrome-launcher] launched ${bin}`);
  log(`[chrome-launcher] profile: ${profileDir}`);
  if (extensionPath) {
    log(`[chrome-launcher] extension: ${extensionPath}${process.env.SUPER_TESTER_EXTENSION_PATH ? "" : " (bundled)"}`);
  } else {
    log(`[chrome-launcher] no extension path — install the extension manually in chrome://extensions`);
  }

  // Brief delay so Chrome has time to fire up its WS client before the first tool call.
  await new Promise((r) => setTimeout(r, 1500));
  return { launched: true, bin, profileDir };
}
