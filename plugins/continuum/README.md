# continuum (Phase 1 + 2 + 3 + Mochi popup-messaging)

A Claude Code plugin that gives every project an append-only **context chain**: small per-session "links" summarizing decisions, deltas, and open threads. Each new Claude session reads `STATE.md` + the last K link summaries as system context, so you never re-explain a project.

See `../../CONTEXT_CHAIN_PLUGIN_PRD.md` for the full spec.

## Layout

```
.claude-plugin/plugin.json    # plugin manifest
.mcp.json                     # MCP server registration
package.json                  # {type:"module"} so .js files run as ESM
hooks/
  hooks.json                  # event → script mapping
  session_start.js            # injects STATE.md + chain tail (or bootstrap directive); surfaces pending sentinel; REGISTERS session with Mochi broker
  pre_compact.js              # gzip-archives transcript, drops pending-checkpoint sentinel
  session_end.js              # same, on session exit; UNREGISTERS session
  pre_tool_use.js             # (Mochi popup hint pipeline) drains broker inbox on every tool call, injects as additionalContext
  post_tool_use.js            # (Phase 3) on Write/Edit of frontend file matching frontend_globs, emits verification directive + logs the change
commands/
  checkpoint.md               # /continuum:checkpoint — write a new link (surfaces frontend verification status)
  status.md                   # /continuum:status — show chain health
  recall.md                   # /continuum:recall <query> — backward traversal (stemmed scoring)
  dream.md                    # /continuum:dream [n=25] — rollup last N links
  feedback.md                 # /continuum:feedback file|flush|list — capability-gap notes
  rename.md                   # /continuum:rename <name> — rename this session in the Mochi popup
  render.md                   # /continuum:render <archive|--latest> — decompress + summarize a gzipped transcript
mcp/
  server.js                   # minimal stdio JSON-RPC MCP server exposing `recall`
lib/
  paths.js                    # shared path/config/token helpers + index loaders
  archive.js                  # gzip transcript + sentinel helpers
  write_link.js               # mechanical link writer (used by /continuum:checkpoint); clears verification log
  status.js                   # status helper (used by /continuum:status)
  recall.js + recall_cli.js   # recall engine (stemmed scoring + TF) + CLI wrapper
  dream_prepare.js            # gather inputs for a rollup
  dream_finalize.js           # atomically commit a rollup (digest + archive + tombstones)
  feedback.js + feedback_cli.js  # feedback queue + dedup + flush
  broker.js                   # HTTP client for Mochi broker /claude/* routes
  rename_cli.js               # used by /continuum:rename
  glob.js                     # zero-dep glob → regex matcher (for frontend_globs)
  verification_log.js + verify_record_cli.js + verify_status_cli.js  # frontend-verify state
  render_archive.js           # decompress + summarize a gzipped transcript
tests/
  run-synthetic.sh                # 59 offline invariants (Phase 1 + 2 + 3) — no Claude tokens
  run-popup-synthetic.mjs         # 15 e2e invariants for the popup-messaging track (boots real broker)
TESTING.md                        # synthetic + multi-session real-Claude scenarios
```

## What each project gets (after bootstrap)

```
.continuum/
  STATE.md                       # bounded, always-current project truth
  chain/
    index.jsonl                  # append-only; one line per link + tombstones for archived
    links/NNNN/{summary.md, refs.json, meta.json}
    links/_archived/NNNN/{...}   # rolled-up originals; NEVER deleted, NEVER mutated
  archive/
    transcripts/*.jsonl.gz       # raw transcripts, gzipped (PreCompact/SessionEnd)
  feedback/
    pending/<hash>.json          # queued capability-gap notes
    sent/<hash>.json             # after flush
    flush-log.jsonl              # daily-cap enforcement record
  config.json                    # optional overrides
  .pending-checkpoint            # transient sentinel after PreCompact/SessionEnd
```

## Use

```bash
# From the repo root:
claude --plugin-dir ./plugins/continuum
```

Then in any project:

| Command | What it does |
|---|---|
| (auto) | SessionStart asks the agent to bootstrap on a new repo, or injects STATE+tail on a known one |
| `/continuum:checkpoint` | Write a new link after decisions/changes accrue |
| `/continuum:status` | Show chain health (counts, sizes, pending sentinel) |
| `/continuum:recall <query>` | Search past links by tag/keyword (includes archived) |
| `/continuum:dream [N]` | Roll up last N links into a phase-digest; originals → `_archived/` |
| `/continuum:feedback file ...` | Queue a plugin-capability-gap note |
| `/continuum:feedback flush` | Convert pending notes to GitHub issues (via `gh`, rate-limited) |
| `/continuum:rename <name>` | Manually rename this session as shown in the Mochi popup |
| `mcp__continuum__recall(query)` | Programmatic recall (Claude can call this directly without a slash command) |

## Popup-messaging integration with Mochi

When the Mochi broker is running (the bundled `server/`), Continuum registers every Claude session with it. From the Mochi extension popup you can:

1. See a list of running Claude sessions (with names like `mochi · master`).
2. Send a hint into any session's inbox — optionally bundled with the current tab's URL + recent console errors.
3. The hint arrives as a system reminder before the agent's **next tool call** (any tool: built-in `Read`/`Bash`/`Edit` or any MCP) — non-interrupting, zero-token-cost when idle.

How:
- `SessionStart` hook calls `POST /claude/register` with `{sessionId, name, projectDir}`.
- Broker (in `server/src/bridge.js`) maintains `claudeSessions` + per-session `claudeInbox`, broadcasts updates over WS to the extension.
- User clicks "Send hint" in the popup → extension sends `send_claude_message` WS frame → broker queues it AND writes `<projectDir>/.continuum/.inbox-flag`.
- Plugin's `PreToolUse` hook (wildcard matcher = fires on every tool call) checks for that sentinel file — ~1ms fast-skip when empty. When present, hits `GET /claude/inbox?sessionId=X`, drains, and emits an `additionalContext` system reminder.
- Env vars to override broker location: `CONTINUUM_BROKER_URL` (default `http://127.0.0.1:9009`), `CONTINUUM_BROKER_TIMEOUT_MS` (default `250`).

If the broker is offline, all hook calls silently no-op — no errors, no slow tool calls.

## Phase 1 + 2 deviations from PRD (documented)

- **gzip instead of zstd** for transcript archives. Zero external dependency (Node built-in). Format is `.jsonl.gz`. Can be re-encoded later.
- **PreCompact does not inject model context.** Claude Code's hook reference only injects `additionalContext` for the Pre/PostToolUse family — not PreCompact. PreCompact is purely side-effect (archive + sentinel); the agent learns of pending checkpoints via the next SessionStart or `/continuum:status`.
- **Tombstones, not in-place mutation.** Archived link entries in `index.jsonl` are not modified — instead a NEW `{tombstone:true, id, supersededBy, ts}` line is appended. This preserves the append-only invariant (PRD §4).
- **`refs.json` is a free-form anchor map.** Phase 2 surfaces it through `recall`, but the format is "anchor → human-readable pointer string"; full byte-offset retrieval into archived transcripts is deferred to Phase 3.
- **Feedback rate-limit is a daily count, not a token-bucket.** Default 10 flushes per 24h, configurable per invocation with `--cap`.

## Phase 3 (shipped)

- **Browser-MCP frontend verification loop.** `PostToolUse` hook on `Write|Edit|MultiEdit|NotebookEdit` — when the file matches `frontend_globs` (default `src/**/*.{tsx,jsx,vue,svelte,css}`) and `frontend_verify: true` in `config.json`, emits a directive guiding the agent through `browser_emulate_viewport` → `browser_navigate` → `browser_screenshot` → `browser_console_messages` at each configured viewport (default 375/768/1280). Records the change in `.continuum/.frontend-changes.jsonl`; `/continuum:checkpoint` surfaces verification status into the new link.
- **Lightweight semantic recall.** Stemmed tokenization (singular/plural, common verb forms — *decisions ≈ decision*, *deciding ≈ decided*) plus TF-scaled keyword scoring (`log(1+freq)`). Full embedding-based recall deferred — see "Future".
- **Archive debug renderer.** `/continuum:render <archive>` or `--latest` decompresses a `.jsonl.gz` and prints record counts, tool calls, errors. Useful when deciding whether to write a retroactive `/continuum:checkpoint` after a `PreCompact` or `SessionEnd`.

### Enabling frontend verification

`frontend_verify` defaults to `false` (PRD §6 — opt-in). Drop into `.continuum/config.json`:

```json
{ "frontend_verify": true,
  "frontend_globs": ["src/**/*.{tsx,jsx,vue,svelte,css}"],
  "frontend_breakpoints_px": [375, 768, 1280] }
```

## Future

- Real embedding-based recall (Voyage/Cohere/OpenAI or `@xenova/transformers` local) — needs an API-key or large-binary decision; deferred until the stemmed scoring is shown to be insufficient in practice.
- Per-archive byte-offset retrieval (decompress only the relevant span from `archive/transcripts/*.jsonl.gz` given an anchor in `refs.json`) — currently `recall` surfaces refs but doesn't auto-fetch detail.

## Testing

```bash
bash tests/run-synthetic.sh           # 59 invariants (Phase 1+2+3), ~5s, no broker
node tests/run-popup-synthetic.mjs    # 15 invariants (popup messaging), boots real broker
# then see TESTING.md for the multi-session real-Claude scenario.
```
