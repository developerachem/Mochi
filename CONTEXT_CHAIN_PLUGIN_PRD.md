# PRD: Continuum — A Context-Chaining Memory Plugin for Claude Code

**Status:** Draft v1
**Owner:** (you — solo developer; single-user scope explicitly)
**Audience:** An LLM agent (Claude Code) that will implement this plugin, plus the human author.
**Format note:** Written to be machine-parseable and unambiguous. Sections are stable anchors; an implementing agent may reference them by heading.

---

## 0. How to read this document (instructions for the implementing LLM)

- This PRD describes a Claude Code **plugin** built primarily on **hooks**. Implement against the official hooks reference (`SessionStart`, `PreCompact`, `SessionEnd`, `UserPromptSubmit`, `PostToolUse`, `Stop`) and the plugins reference. Verify each hook's input schema and exit-code semantics against current docs before coding — the API surface changes.
- Where this PRD says **MUST**, it is a hard requirement. **SHOULD** is a strong default that may be overridden with a recorded reason. **MAY** is optional.
- Several of the author's original ideas are technically constrained. These are called out explicitly in **§12 Reality Constraints**. Do not silently "fix" them by assuming capabilities that do not exist. If a constraint blocks a requirement, surface it, do not paper over it.
- The hardest and highest-risk component is **§7 Summarization & Compression**. Treat it as the core of the system, not a utility. Most of the design effort belongs there.

---

## 1. Problem statement

A solo freelance developer works across many projects. Within a single Claude Code session, context is rich and the assistant performs well. The moment a session ends, the context window fills and compacts, or work moves to another device, continuity is lost and the developer must re-explain project state, decisions, and the evolution of client requirements. Requirements themselves churn continuously (e.g. "add login" today, "make it MFA" tomorrow), so the lost context includes not just *what the code is* but *why it is that way and what changed*.

Existing mechanisms each cover only a slice:

- `CLAUDE.md` — static, human-maintained, does not auto-evolve.
- Claude Code auto memory / dreaming — machine-local, keyword-recall, not a structured project chain.
- Code-graph tools — map structure, not decision history.

This plugin's job: **make project context survive session boundaries, context-window compaction, and device switches automatically, at minimal token cost, with the decision history preserved.**

## 2. Goals and non-goals

### Goals
- G1. Zero-effort continuity: starting a new session on any device reconstructs working context automatically.
- G2. Bounded, lossless-where-it-matters history: an append-only chain of compressed session summaries plus a queryable raw transcript archive.
- G3. Token efficiency: the per-session context injection MUST stay small and bounded regardless of project age.
- G4. Decision preservation: requirement changes and their supersession are first-class, never flattened away.
- G5. Backward traversal: ability to retrieve a specific past exchange by reference without loading the whole history.
- G6. Optional frontend verification loop via a browser MCP on completions that touch frontend code.
- G7. Self-improvement loop: the plugin can file structured feedback (as a git issue) when the model identifies a capability gap.

### Non-goals (v1)
- NG1. Multi-user / team coordination. Explicitly out of scope per author. (Architecture SHOULD NOT preclude it later, but no feature targets it now.)
- NG2. A hosted service. Everything is local + git.
- NG3. Replacing Claude Code's native compaction. This plugin *cooperates with* compaction, it does not reimplement the model loop.
- NG4. Human-readable archives. Archives are machine-first; human readability is not a requirement (a debug renderer is a MAY).

## 3. Core concept

A **context chain**: a linked sequence of immutable "links." Each link represents one bounded unit of work (roughly one session, or one pre-compaction segment). A link contains a compressed summary, machine-readable references back to its raw transcript, and the git commit id at the time of writing. New links are *appended*, never overwritten. Session N starts by loading only: the latest cumulative state + the tail of the chain, not the whole history. Older links are retrievable on demand by reference.

This is the bounded-snapshot-plus-archived-history pattern, automated and chained.

## 4. On-disk layout

A single top-level directory at repo root (final name TBD by author; placeholder `.continuum/`). It MUST be one directory, git-trackable, with a `.gitignore`-able volatile subtree.

```
.continuum/
  STATE.md                  # the ONLY always-loaded, always-rewritten file. Bounded. Human-readable.
  chain/
    index.jsonl             # one line per link: {id, ts, commit, summary_tokens, refs_file, tags[]}
    links/
      0001/
        summary.md          # compressed, model-facing summary of this link
        refs.json           # machine-readable pointers into raw archive (no prose)
        meta.json           # {commit_id, parent_link, model, token_stats, created_at}
      0002/
      ...
  archive/
    transcripts/
      0001.jsonl.zst        # compressed raw transcript segment for link 0001
      ...
    embeddings/             # OPTIONAL (Phase 3): vector index for semantic back-search
  feedback/
    pending/                # queued self-improvement items before they become git issues
  config.json               # plugin config (thresholds, toggles, model choices)
  .gitignore                # ignores volatile/local-only artifacts
```

Rules:

- `STATE.md` MUST be bounded (hard cap, default 150 lines / ~2k tokens). It is rewritten in place, never appended. It is the only file injected in full every session.
- `chain/links/NNNN/` directories are immutable once written. Corrections create a new link that supersedes, never an edit.
- `archive/transcripts/*.jsonl.zst` are compressed (zstd) and machine-only. Not human-readable by design; that is acceptable.
- `index.jsonl` is append-only JSON Lines so it can be tailed cheaply without parsing the whole file.
- Commit ids are recorded in `meta.json` per link AND surfaced in `index.jsonl` for fast lookup.

## 5. Lifecycle: how the chain advances

### 5.1 First-ever session on a repo (bootstrap)
Trigger: `SessionStart` hook fires; `.continuum/` does not exist or `chain/index.jsonl` is empty.

Behavior (MUST):
1. The hook detects absence of the structure.
2. It does **not** itself analyze the codebase (hooks must stay fast — see §12). Instead it emits, via `SessionStart` stdout (which becomes model context), a directive instructing the agent to perform a one-time bootstrap: scan the codebase, read recent git log, and produce the initial `STATE.md` plus link `0001`.
3. The agent performs the analysis in-session, writes `STATE.md`, writes link `0001` (summary = "initial baseline", refs = pointer to the bootstrap transcript), records current commit id.
4. From then on the structure exists and normal flow applies.

Rationale: heavy analysis belongs in the agent turn, not the hook process. The hook is a thin trigger + context injector only.

### 5.2 Normal session start
Trigger: `SessionStart` (source = `startup` or `resume`), structure exists.

Behavior (MUST):
- The hook reads `STATE.md` (full) + the last K links' `summary.md` (default K=2) + tail of `index.jsonl`.
- It concatenates these into a single bounded context block and prints to stdout so it becomes the session's seed context.
- It MUST enforce the token budget: if `STATE.md` + K summaries exceed the injection cap (default ~4k tokens), it reduces K, never truncates `STATE.md` mid-content.
- It does NOT inject raw transcripts or old links.

### 5.3 Mid-session: context filling up
This is the part the author described as "when ~60% of context is full." See §12.1 — that exact trigger is not directly observable. The implementable design:

- Primary trigger: the `PreCompact` hook (fires before Claude Code compacts; matcher `auto` = window filled, `manual` = user `/compact`).
- Secondary/proactive trigger: a statusline or periodic token-estimate script that watches an approximate token counter and, past a configurable soft threshold (default 60% of model window *as estimated*), writes a flag file requesting an orderly checkpoint at the next safe boundary.

On `PreCompact` (MUST):
1. Hook copies the current raw transcript to `archive/transcripts/NNNN.jsonl.zst` (compressed).
2. Hook emits a directive (via the mechanism available to it) instructing the agent, at the next turn, to produce a **link summary** of everything since the last link: key decisions, requirement changes, open threads, unresolved questions, and machine-readable refs (turn ids / anchors) into the just-archived transcript.
3. Agent writes `chain/links/NNNN/{summary.md,refs.json,meta.json}`, appends to `index.jsonl`, updates `STATE.md` (rewrite, not append) to reflect new current truth, records commit id.
4. Recommended workflow after compaction: a fresh effective context now consists of updated `STATE.md` + newest link summary. The chain has advanced by one link.

This makes compaction *lossless at the decision level*: the window shrinks, but nothing important is dropped because it was precipitated into a link first.

### 5.4 Session end
Trigger: `SessionEnd` (cannot block).
Behavior (SHOULD): if meaningful state changed since the last link and no `PreCompact` already checkpointed it, perform the same link-write as 5.3 step 2–4 so no session is lost. Append an end record to a `session-history.jsonl`.

### 5.5 Backward traversal (retrieval)
Requirement G5. The agent must be able to answer "what did we decide about X three sessions ago" without loading everything.

Design (MUST, Phase 2):
- `index.jsonl` carries per-link `tags[]` and a short `summary` line. Cheap keyword scan over this small file locates candidate links.
- Each link's `refs.json` maps semantic anchors (decision ids, topic tags, "user asked about auth retry") to byte/line offsets within its compressed transcript.
- A retrieval helper (exposed as an MCP tool, see §8) takes a query, scans `index.jsonl`, picks candidate links, decompresses only those transcript segments, and returns the minimal relevant span — never the whole archive.
- Phase 3 MAY add an embedding index for semantic (non-keyword) recall; keep it optional and local.

## 6. The browser-MCP frontend verification loop

Requirement G6. Optional, gated by config (`frontend_verify: true`).

Trigger: `PostToolUse` (or `Stop`) where the matched tool wrote/edited files under configured frontend globs (e.g. `src/**/*.{tsx,jsx,vue,svelte,css}`).

Behavior (MAY, opt-in):
1. The plugin signals that a frontend change occurred.
2. The agent, before declaring completion, uses the configured browser MCP to load the affected view at up to **3 viewport breakpoints** (configurable; defaults e.g. 375 / 768 / 1280 px).
3. It captures result/state (screenshot or DOM assertions) and feeds a short pass/fail + observations summary back into its own reasoning before responding.
4. Failures are recorded into the current link's summary as an open thread so they survive into the next session if unresolved.

Constraint: this loop adds latency and tokens. It MUST be skippable per session and MUST NOT run when no frontend files changed.

## 7. Summarization & compression — THE CORE

This is explicitly the hardest part. Bad summarization silently corrupts the entire chain (compounding-error risk). Design principles:

### 7.1 What a link summary MUST capture (priority order)
1. **Decisions and their deltas.** Every settled decision and, critically, every *change* to a prior decision with explicit supersession ("MFA now required; supersedes basic-login from link 0007"). This is the highest-value, lowest-token content. Never drop it.
2. **Current open threads / unresolved questions.** What was in flight when the link closed.
3. **Constraints and prohibitions.** "Client rejected dark mode — do not re-propose."
4. **State deltas.** What changed in the codebase at the level of intent, not line-by-line (the diff is in git; reference the commit instead of restating it).
5. **Pointers, not payloads.** Anything bulky (long reasoning, code) is referenced by `refs.json` anchor + commit id, not inlined.

### 7.2 What a link summary MUST NOT do
- MUST NOT restate code that git already holds (reference commit id instead).
- MUST NOT narrate conversational flow ("then the user asked, then I said"). Record outcomes, not transcripts.
- MUST NOT exceed its token cap (default 800 tokens/link). If content exceeds cap, split: durable decisions go in summary; detail goes to archive with a ref.
- MUST NOT silently resolve contradictions. If link N contradicts link N-3, the summary states the contradiction and which one is now authoritative.

### 7.3 STATE.md regeneration rule
`STATE.md` is the always-current, no-history snapshot. On each link write the agent regenerates it as: current stack/decisions (current values only, superseded ones removed), active requirements list, open blockers, "do not do" list, and a pointer to the latest link id + commit. It is a *replacement*, computed from the newest link plus the previous `STATE.md`. It MUST stay under its hard cap; if it grows, that is the signal to roll up (see §7.4).

### 7.4 Rollup / consolidation (long-horizon defense)
To prevent the chain's working set from degrading over a long project (the "unusual state" failure):
- Trigger: configurable, e.g. every N links (default 25) or on manual `continuum dream`.
- A consolidation pass reads the last N link summaries (NOT raw transcripts) and produces a single "phase digest" link that merges duplicates, drops superseded-and-irrelevant items, and preserves the decision lineage in condensed form.
- Superseded individual links are **archived** (moved to `chain/links/_archived/`), never deleted; `index.jsonl` keeps a tombstone with their tags so retrieval still finds them.
- The input links are never mutated; the digest is a new link. Output is reviewable; if bad, discard the digest and keep originals. (This mirrors a known-good consolidation pattern: never modify inputs, produce a reviewable output.)

### 7.5 Token & file-size optimization techniques (apply all)
- **zstd-compress** all raw transcript archives. Store JSONL, not pretty JSON.
- **JSONL everywhere append-only** (`index.jsonl`, history) so reads can `tail` without full parse.
- **Refs over payloads:** never store what git already stores; store `commit_id + path + anchor`.
- **Tiered loading:** only `STATE.md` + K newest summaries enter context by default. Everything else is pull-on-demand.
- **Cap enforcement at write time,** not read time — a link that would exceed cap is split before it is ever stored, so reads are always bounded.
- **Cheap model for bookkeeping:** summarization/rollup MAY use a smaller/cheaper model than the main coding model; the task is compression, not reasoning. Make model choice per-operation configurable.
- **Delta summaries:** each link summarizes only *since the previous link*, never re-summarizes the whole project. Cumulative truth lives in `STATE.md` only.
- **Dedupe at rollup:** consolidation explicitly removes repeated decisions so the chain does not bloat with restatements.
- **Strip volatile fields** (timestamps in prose, transient IDs) from summaries; keep them only in `meta.json` where they are structured and cheap.
- **Resolve relative time at write:** store absolute dates/commits, never "yesterday" (prevents stale-on-resume ambiguity).

## 8. Plugin surface (commands & MCP tools)

Implement as a Claude Code plugin per the plugins reference. Provide:

- Hooks: `SessionStart`, `PreCompact`, `SessionEnd`, `PostToolUse` (frontend matcher), optionally `Stop`.
- Slash commands (or equivalent): `continuum status`, `continuum checkpoint` (force a link write), `continuum recall "<query>"` (backward traversal), `continuum dream` (manual rollup), `continuum feedback "<text>"`.
- MCP retrieval tool: `continuum_recall(query)` → returns minimal relevant span(s) from the chain/archive. This is the machine path for §5.5.
- All destructive-looking operations (rollup) MUST produce reviewable output and MUST NOT mutate inputs.

## 9. Self-improvement feedback loop

Requirement G7.
- When the agent, during normal work, identifies that a plugin capability gap forced a workaround, it appends a structured item to `.continuum/feedback/pending/`.
- A command (`continuum feedback flush`) or a `SessionEnd` step converts pending items into a git issue (via `gh` CLI or git issue mechanism) with a deduplicated title and a body containing: observed limitation, the workaround taken, suggested capability, and the link id where it occurred.
- Feedback creation MUST be rate-limited and deduplicated (hash of normalized title) so the loop cannot spam issues.
- This loop is advisory only; it never auto-modifies the plugin.

## 10. Configuration (`config.json`)

```jsonc
{
  "dir_name": ".continuum",
  "inject_token_cap": 4000,
  "state_md_line_cap": 150,
  "link_summary_token_cap": 800,
  "newest_links_to_load": 2,
  "soft_context_threshold_pct": 60,      // best-effort estimate only; see §12.1
  "rollup_every_n_links": 25,
  "summarizer_model": "cheaper-model-id",
  "main_model": "primary-model-id",
  "frontend_verify": false,
  "frontend_globs": ["src/**/*.{tsx,jsx,vue,svelte,css}"],
  "frontend_breakpoints_px": [375, 768, 1280],
  "feedback_to_git_issues": false
}
```
All thresholds MUST be config-driven, never hardcoded.

## 11. Phasing (build order)

- **Phase 1 (MVP):** `.continuum/` layout, `SessionStart` injection of `STATE.md` + tail, `PreCompact`/`SessionEnd` link writing, manual `continuum checkpoint`, zstd archive. No retrieval, no MCP, no frontend, no rollup. This alone solves ~80% of the pain.
- **Phase 2:** `continuum recall` + MCP retrieval tool (§5.5), rollup/`dream` (§7.4), feedback loop (§9).
- **Phase 3:** browser-MCP frontend verification (§6), optional embedding index for semantic recall, debug renderer for archives.

Each phase is independently shippable and useful.

## 12. Reality constraints (read before implementing — do not design around fictions)

### 12.1 "Trigger summarization at 60% context" is not directly available
There is no hook input that reports live context-window fill percentage to a plugin. The reliable trigger is the `PreCompact` event (fires before Claude Code compacts, with `auto` vs `manual` matchers). The 60% number can only be a *best-effort estimate* from a side token-counter/statusline script, used to request an early voluntary checkpoint — it cannot be treated as ground truth. Design the system so correctness does not depend on the estimate being accurate; `PreCompact` is the real safety net.

### 12.2 Hooks must be fast and have limited control
`SessionStart` stdout becomes context (good — that is the injection path). But hooks run on every session and must stay fast; heavy codebase analysis MUST happen in an agent turn, not in the hook process. Some events cannot block. Mid-session events replay stale values on resume, so never bake timestamps/commit SHAs into replayed hook output — compute them in-turn and write them to files instead.

### 12.3 Compounding-error risk is inherent
The agent both writes and consumes the chain. A wrong summary propagates. Mitigations are mandatory, not optional: tag inferred vs stated content; never auto-resolve contradictions in summaries; keep raw transcripts so any link can be re-derived; make rollup non-destructive and reviewable. Treat chain content as a strong hint, and verify against git/code before acting on anything load-bearing.

### 12.4 Git is the source of truth for code; the chain is the source of truth for intent
Do not duplicate diffs into summaries. Reference commit ids. The chain's unique value is *decisions and their evolution*, which git does not capture. Keep that boundary clean or the system bloats and contradicts itself.

### 12.5 Single-user assumption is load-bearing for v1
No locking, no merge strategy, no concurrent-write handling is specified because it is explicitly out of scope. If multi-device-same-time use happens, last-writer-wins on `STATE.md` is the accepted (documented) risk for v1; the immutable append-only links and archives are safe regardless. Do not build team features; do not block them architecturally.

## 13. Success criteria

- S1. Starting a fresh session on any synced device requires zero manual re-explanation to resume productive work.
- S2. Injected context per session stays under `inject_token_cap` regardless of project age (verify at 1, 25, 100 links).
- S3. A requirement that changed 10 links ago is correctly reported as current (not the superseded value) from `STATE.md` alone.
- S4. An arbitrary past decision is retrievable via `continuum recall` without decompressing more than its own link's archive.
- S5. After a forced compaction, no decision recorded before compaction is lost.
- S6. Total `.continuum/` size grows sub-linearly vs raw transcript volume (compression + rollup working).

## 14. Open questions for the author

- Final directory name and whether `archive/` is committed to git or kept local-only (size vs cross-device tradeoff — committing enables device sync of history; not committing keeps the repo small).
- Which concrete browser MCP, and whether Phase 3 is wanted at all.
- Acceptable cost ceiling per summarization/rollup operation (drives summarizer-model choice).
- Whether `STATE.md` should stay human-readable (recommended: yes — it is your at-a-glance project truth and costs nothing to keep readable).
