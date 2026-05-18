---
description: Inspect an archived transcript (gzipped) — show counts, tool calls, errors. Useful after a PreCompact or SessionEnd, before deciding to write a retroactive /continuum:checkpoint.
allowed-tools: Bash
argument-hint: <archive-path> | --latest [--full]
---

Run:

```bash
node "$CLAUDE_PLUGIN_ROOT/lib/render_archive.js" $ARGUMENTS
```

If the user asks "what was in the last archived transcript" without specifying a file, prefer `--latest`. If they want every record, add `--full` (can be large).

Show the output to the user. If you spot anything that should become a link (a decision, an open thread, a recurring error pattern), propose `/continuum:checkpoint` next.
