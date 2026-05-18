---
name: restore
description: Inverse of /mindwright:forget — flip a soft-archived long-term fact back to active so it returns to retrieval and the markdown mirrors. Use when a typo'd fact_id sent the wrong row down.
---

# /mindwright:restore

Usage: `/mindwright:restore <fact_id>`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" restore --session-id '${CLAUDE_SESSION_ID}' --plugin-data "${CLAUDE_PLUGIN_DATA}" <<'MINDWRIGHT_ARGS'
{"fact_id": 123}
MINDWRIGHT_ARGS
```

JSON args (stdin):
- `fact_id`: the id of the long-term row to restore.

The handler flips `active=1` on the row and regenerates the markdown mirrors. Soft-archive never deletes anything, so the row + embedding + entity links are all intact — the restore is just the inverse flip.

The response includes `content_preview` (first 200 chars of the restored row). Echo it back to the user so they can confirm they restored the right row.

If `/mindwright:forget` was followed by a `/mindwright:dream` cycle, the consolidator may have promoted a near-duplicate fact in the meantime. Re-run `/mindwright:recall` after restoring to surface any contradictions.
