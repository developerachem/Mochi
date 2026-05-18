---
description: File a plugin-capability-gap note, or flush queued notes to GitHub issues
allowed-tools: Bash, Read
argument-hint: file|flush|list [--dry-run]
---

The continuum feedback queue captures cases where THIS plugin's capabilities forced you to work around something. Items are deduplicated by normalized-title hash; flushing creates GitHub issues via `gh` (rate-limited).

## Subcommands

### `/continuum:feedback file --title "<short>" --severity minor|major|blocker`

Use when, mid-task, you notice "this would have been easier if continuum could ____." Compose the body as:

```
**Observed limitation:** what's missing or wrong
**Workaround taken:** what you did instead
**Suggested capability:** concrete proposal
**Where it bit me:** link id, file, or step
```

Then pipe to:

```bash
cat <<'CONTINUUM_FB_EOF' | node "$(cat .continuum/.plugin-root)/lib/feedback_cli.js" file --title "$TITLE" --severity "$SEVERITY" --link-id "$LINK_ID"
<body markdown>
CONTINUUM_FB_EOF
```

Output is JSON: `{status: "queued"|"duplicate-pending"|"duplicate-sent", hash, path}`.

### `/continuum:feedback flush [--dry-run]`

Flush queued items into GitHub issues. By default rate-limited to 10 per 24h (configurable with `--cap`). Use `--dry-run` to preview without creating issues.

```bash
node "$(cat .continuum/.plugin-root)/lib/feedback_cli.js" flush ${ARGUMENTS}
```

Show the resulting JSON to the user. If `gh` CLI is not installed, the user will need to install it (`brew install gh`) and run `gh auth login` before real flushes work.

### `/continuum:feedback list`

Show pending + sent counts.

```bash
node "$(cat .continuum/.plugin-root)/lib/feedback_cli.js" list
```

## When NOT to file feedback

- Bugs in OTHER projects → file directly in those projects' issue trackers.
- Conversational gripes ("this prompt was ugly") → not capability gaps.
- One-off papercuts that won't recur → don't pollute the queue.
