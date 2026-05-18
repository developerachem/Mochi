---
description: Show continuum chain health — link count, latest link, STATE.md size, archive usage, pending checkpoint
allowed-tools: Bash
---

Run the status helper and show its output to the user verbatim:

```bash
node "$(cat .continuum/.plugin-root)/lib/status.js"
```

Do not add commentary unless the user asks for it. The helper output is the answer.
