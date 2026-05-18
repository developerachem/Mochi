---
description: Write a new link in the continuum chain summarizing decisions/changes since the last link
allowed-tools: Bash, Read, Write, Edit
---

You are writing a new link in the **continuum context chain** for this project. A "link" is a small, durable summary of what happened since the previous link — it survives session boundaries and compaction.

## What to do

1. **Read the previous state** to know what to summarize *against*:
   - `.continuum/STATE.md` — current project truth (do not duplicate; only note deltas).
   - The last entry in `.continuum/chain/index.jsonl` — tells you the previous link id and timestamp.
   - The previous link's `summary.md` (highest-numbered dir under `.continuum/chain/links/`) — so you don't repeat decisions already captured.
   - **Frontend verification status** (only if applicable):
     ```bash
     node "${CLAUDE_SKILL_DIR}/../lib/verify_status_cli.js"
     ```
     If this reports any UNVERIFIED frontend files or FAILURES, include them as **Open threads** in the new link summary so they survive into the next session. Don't silently skip — surfacing unfinished verification is the whole point of the loop.

2. **Compose a link summary** in your head with these sections (omit any that are empty). Hard cap: ~800 tokens. Be terse; pointers, not payloads.

   ```
   ## Decisions
   - <new settled decisions; if any SUPERSEDES a prior decision, say so explicitly with the prior link id>

   ## Changes since last link
   - <what changed at the level of intent — not line-by-line. Reference git commits, not diffs.>

   ## Open threads
   - <unresolved questions in flight as of this checkpoint>

   ## Constraints / Do not
   - <new "do not" items; e.g. "client rejected X — do not re-propose">

   ## Refs
   - <semantic anchors → where to find the detail. e.g. "auth-decision → commit abc123, file src/auth.ts:L40-80">
   ```

   Rules:
   - NEVER restate code that git already holds. Use commit ids.
   - NEVER narrate conversation flow ("then the user asked"). Record outcomes only.
   - If something contradicts a previous link, STATE the contradiction and which is authoritative now — do not silently overwrite.

3. **Write the link** by piping your summary to the helper, which handles ids, timestamps, git commit capture, and index update atomically:

   ```bash
   cat <<'CONTINUUM_SUMMARY_EOF' | node "${CLAUDE_SKILL_DIR}/../lib/write_link.js" --tags "tag1,tag2"
   <YOUR SUMMARY MARKDOWN HERE>
   CONTINUUM_SUMMARY_EOF
   ```

   The script prints the new link id (e.g. `0003`). Choose tags that aid retrieval later: domain (`auth`, `db`, `ui`), kind (`decision`, `bugfix`, `refactor`, `bootstrap`), or topic.

4. **Regenerate `STATE.md`** to reflect new cumulative truth:
   - Read the OLD `.continuum/STATE.md`.
   - Apply the deltas from this new link: superseded decisions are REMOVED (not crossed out), new decisions added, open threads updated, "do not" list updated.
   - Hard cap: 150 lines. If you can't fit, suggest a rollup (do not silently truncate).
   - Use `Write` to overwrite `.continuum/STATE.md`.

5. **Report back to the user** in 2 lines: new link id, and one-sentence headline of what it captures.

## Constraints

- Do NOT write anything to `.continuum/chain/links/NNNN/` directly — always go through `write_link.js`. The script enforces correct id assignment, timestamp, and index update.
- Do NOT modify existing links — corrections become a NEW link that supersedes.
- If `.continuum/` does not exist yet, refuse this command and tell the user to start a fresh Claude session so the SessionStart bootstrap directive can fire.
