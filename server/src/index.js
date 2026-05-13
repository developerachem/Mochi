#!/usr/bin/env node
// Super-Tester MCP server.
// Each Claude Code session spawns its own instance of this process via stdio.
// On startup we race for port 9009: the winner becomes the BROKER (holds the
// extension WS), losers become CLIENTS that route browser-level commands
// through the broker. Each Claude Code session ends up with its own session
// (tab group) inside the extension, transparently.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Bridge } from "./bridge.js";
import { tools, handleToolCall, initToolsState } from "./tools.js";
import { launchChromeIfNeeded } from "./chrome-launcher.js";

const WS_PORT = Number(process.env.SUPER_TESTER_WS_PORT ?? 9009);
const AUTO_LAUNCH = process.env.SUPER_TESTER_AUTO_LAUNCH !== "false";
const EXTENSION_WAIT_MS = Number(process.env.SUPER_TESTER_EXTENSION_WAIT_MS ?? 20000);

const log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

// 0) SQLite memory + selector cache + workflow store. Both broker and client
//    open the same DB file (WAL mode → multi-process safe).
initToolsState({ log });

// 1) Bridge: try to be broker; otherwise become a client of the running broker.
const bridge = new Bridge({ log });
const role = await bridge.start({ port: WS_PORT });
log(`[bridge] role=${role}`);

// 2) MCP server (stdio) — same surface in both broker and client mode.
const mcp = new Server(
  { name: "super-tester", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  await ensureReady();
  return handleToolCall(bridge, req.params);
});

let launchAttempted = false;
async function ensureReady() {
  if (bridge.isConnected()) return;

  // Only the broker should launch Chrome — the client doesn't own the
  // extension WS and would just be wasteful. The broker is also the only
  // process whose `bridge.isConnected()` reflects the extension state.
  if (role === "broker" && AUTO_LAUNCH && !launchAttempted) {
    launchAttempted = true;
    try {
      await launchChromeIfNeeded(log);
    } catch (e) {
      log(`[chrome-launcher] failed: ${e.message}`);
    }
  }

  await bridge.waitForConnection(EXTENSION_WAIT_MS);
}

// 3) Wire stdio
const transport = new StdioServerTransport();
await mcp.connect(transport);
log(`[mcp] super-tester ready (role=${role}, auto-launch=${AUTO_LAUNCH}, clientId=${bridge.getLocalClientId()})`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("[mcp] shutting down");
  try {
    await Promise.race([
      bridge.cleanupLocalSession?.(),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch {}
  try { bridge.shutdown(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
