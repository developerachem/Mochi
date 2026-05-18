## Bootstrap link

Initial Continuum bootstrap for the Super-Tester repository — the source repo
for the `mochi` Claude Code plugin (v0.3.0). The plugin bundles browser
automation MCP (`server/`), context-chain memory (`plugins/continuum/`), and
a Chrome extension (`extension/`) with an in-page hint modal.

State at bootstrap (commit `31a233d`):

- Server is bundled via esbuild to `server/dist/server.bundle.mjs` —
  single 760KB self-contained ESM file, no native deps, no npm install
  required for end-users. CI rebuilds on every push to Master.
- Memory is file-based under `.continuum/` (replacing the older SQLite
  store at `.super-tester/memory.db`).
- Plugin installs from GitHub via `/plugin marketplace add DevZonayed/Super-Tester`
  + `/plugin install mochi@mochi`. Loaded successfully in this session;
  `mcp__plugin_mochi_browser__browser_session_health` returns
  `mode:"broker", connected:true, extensionAttached:true`.
- All test suites green at bootstrap: 63 plugin synthetic + 38 popup e2e
  + 22 broker + browser smoke.

Refs: STATE.md captures current truth. Subsequent `/continuum:checkpoint`
calls will append links as decisions accrue.
