---
description: Search past links in the continuum chain by tag/keyword and return matched summaries
allowed-tools: Bash
argument-hint: <query words>
---

Run the recall helper and show its output to the user verbatim:

```bash
node "$(cat .continuum/.plugin-root)/lib/recall_cli.js" -- $ARGUMENTS
```

After showing the output:
- If a hit's `_anchors:_` line references a commit, the user may want detail from that commit — offer to `git show <sha>`.
- If a hit references an archived transcript span (`archive_path` in refs), offer to `zcat` and surface the relevant lines.
- Do NOT re-summarize what's already in the output unless the user asks.
