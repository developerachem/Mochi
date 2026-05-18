---
description: Rename this Claude session as it appears in the Mochi extension popup
allowed-tools: Bash
argument-hint: <new name>
---

Rename this session in the Mochi broker so the popup shows a nicer label:

```bash
node "${CLAUDE_SKILL_DIR}/../lib/rename_cli.js" -- $ARGUMENTS
```

If the broker is not running (Mochi extension/server offline), the script will print `{"ok":false,...}` and exit non-zero — that's the only failure mode worth mentioning to the user.

Default name (set automatically at SessionStart) is `<repo-basename> · <git-branch>`.
