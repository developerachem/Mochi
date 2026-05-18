# Super-Tester (mochi plugin) — baseline

**Status:** v0.3.0 of the `mochi` Claude Code plugin. Source repo + the plugin
distribution. Active development.

**Stack:** Node 22+, ESM. esbuild bundles `server/src/index.js` →
`server/dist/server.bundle.mjs` (one self-contained file, ~760KB, no native
deps). Plugin distributed via GitHub marketplace install.

**What the plugin bundles:**
- `browser` MCP — 39 tools for Chrome automation (server/, Mochi extension)
- `continuum` MCP — `recall` tool + 7 slash commands + 7 hooks for chain memory
- In-page send-hint modal (⌘⇧M) with DOM element picker + screenshot context

**Active decisions:**
- Plugin name: `mochi` (in `mochi` marketplace; repo dir stays `Super-Tester`).
- Browser MCP tools surface as `mcp__plugin_mochi_browser__*` (underscores,
  not colons — `claude mcp list` shows `plugin:mochi:browser` but the tool
  namespace uses `plugin_mochi_browser`).
- All persistence in `.continuum/` (per-project): chain, archive, screenshots,
  feedback, selectors, workflows, runs. No SQLite anywhere.
- Server bundled with esbuild; `dist/server.bundle.mjs` committed to repo
  by `.github/workflows/build.yml` on every push to Master.
- Install: `/plugin marketplace add DevZonayed/Super-Tester` then
  `/plugin install mochi@mochi`. Chrome extension loaded manually from
  `~/.claude/plugins/cache/mochi/mochi/0.3.0/extension`.

**Do NOT:**
- Re-introduce `better-sqlite3` or any native module — bundle-ability and
  zero-install were the explicit goals (resolved 2026-05-18).
- Add a project-level `.mcp.json` outside the plugin's own — duplicates the
  plugin's `browser` server and causes Chrome debugger conflicts.
- Edit `~/.claude.json` MCP entries manually for this plugin — the plugin's
  `.mcp.json` handles registration. Manual edits cause duplicates.
- Refer to the plugin as "super-tester" in user-facing strings (the brand is
  `mochi`); internal artifacts like `SUPER_TESTER_*` env vars and the repo
  directory name are unchanged for backward-compat / git-history reasons.

**Open threads:**
- Stale-memory cleanup in other projects (e.g. Continuum-demo) still flagging
  "Mochi extension conflicts with browser MCP" — false since the unification.
  Each affected session needs to clear or update that memory.
- Chrome extension publication to Web Store would eliminate the manual "Load
  unpacked" step; deferred until the plugin sees broader use.
- Real embedding-based `recall` (Voyage/Cohere or local model) — deferred per
  Phase 3 docs; current stemmed-token recall is "good enough" for now.
- Per-archive byte-offset retrieval (refs.json anchors → specific transcript
  spans) — deferred.

**Latest commit at bootstrap:** `31a233d` (feat: file-based memory + bundled
server + GitHub-installable plugin).
