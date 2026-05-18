---
name: browser
description: "Use this skill when the user says browser, /browser, test in Chrome, inspect a webpage, verify a localhost app, capture screenshots, check console/network errors, run browser QA, or automate browser flows with the Mochi browser MCP."
argument-hint: "[task or URL]"
allowed-tools: [Bash]
---

# Browser

Use the Mochi browser MCP tools for browser automation and QA.

## Finding the tools

When installed as a Claude Code plugin, the MCP server registers as
`plugin:mochi:browser`. The actual tool names use **underscores** in the
namespace prefix: `mcp__plugin_mochi_browser__browser_session_start`,
`mcp__plugin_mochi_browser__browser_screenshot`, etc.

If you don't see them in your current toolset, search via ToolSearch:
`select:mcp__plugin_mochi_browser__browser_session_health` (and similar).
Schemas are loaded on demand.

When written without prefix below (e.g. "call `browser_navigate`"), the
full callable name is `mcp__plugin_mochi_browser__browser_navigate`.

## Conflict-with-extension note (HISTORICAL — no longer applies)

Earlier versions of this plugin had a duplicate MCP-server registration
that competed with the Mochi Chrome extension over `chrome.debugger`
attachments. The unified plugin (v0.2+) eliminates this — there is no
extension-vs-MCP conflict anymore. If your memory has an old "browser MCP
conflicts with the Mochi extension" note from a prior session, it's stale.

## Default Behavior

- Start with `browser_session_start` before interacting with a page.
- Use `browser_navigate` for the target URL.
- For reading/searching page content, prefer `browser_text` and `browser_links`
  before `browser_snapshot`.
- `browser_snapshot` is compact by default: viewport-only, redacted, depth
  limited, and byte capped. Use it for refs and actionable UI state, not for
  dumping the whole page.
- Use `browser_snapshot_query` and `browser_snapshot_node` to drill into the
  stored snapshot by text, role, ref, tag, or path.
- Only call `browser_snapshot {mode:"full", scope:"all", maxBytes:0}` when the
  compact ladder is not enough and you intentionally need the full tree.
- Prefer selector-based actions (`browser_click`, `browser_type`) and include a
  clear `intent` so selectors are cached for later sessions.
- Use `browser_screenshot` when visual evidence matters.
- Use `browser_console_messages` and `browser_network_requests` for runtime
  debugging after page loads and interactions.
- Use `browser_session_end` when the task is done unless the user wants the
  browser left open.

## Multi-Agent Use

- Multiple Claude Code sessions can use this MCP at the same time.
- Each Claude session gets its own client id and Chrome tab group.
- Do not reuse another session's tab ids. Call `browser_list_tabs` if unsure.
- Keep payloads small so parallel agents do not flood their context windows:
  `browser_text`/`browser_links` first, compact snapshot second, query/node
  drilldown third.
- If the first broker exits, keep going; the remaining MCP client should recover
  and preserve the active session.

## Compact Inspection Ladder

1. `browser_session_health` if the browser feels stuck.
2. `browser_text {query?, limit?}` for page copy, search results, lists, and
   visible facts.
3. `browser_links {query?, limit?}` for navigation choices.
4. `browser_snapshot` for refs and visible actionable UI.
5. `browser_snapshot_query` to search the stored snapshot.
6. `browser_snapshot_node` to fetch the one subtree you need.
7. Full snapshot only as an explicit last resort.

## Localhost QA Pattern

1. Start or detect the app server.
2. Call `browser_session_start` with a clear title.
3. Navigate to the local URL.
4. Use text/links/compact snapshot to perform the main user flow.
5. Check console errors and failed network requests.
6. Capture a screenshot if layout, visual polish, or evidence matters.

## Chrome Extension

The server auto-launches Chrome with the bundled extension when possible. If
Chrome is already open or the extension is not connected, open
`chrome://extensions`, enable Developer mode, click "Load unpacked", and select:

`/Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/extension`

Then make sure the Mochi toolbar popup says connected.
