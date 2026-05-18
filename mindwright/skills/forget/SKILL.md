---
name: forget
description: Soft-archive a long-term fact so it stops surfacing in retrieval and the markdown mirrors. Reversible at the SQL level; the auto path treats it as gone.
---

# /mindwright:forget

Usage: `/mindwright:forget <fact_id>`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mindwright.mjs" forget --session-id '${CLAUDE_SESSION_ID}' <<'MINDWRIGHT_ARGS'
{"fact_id": 123}
MINDWRIGHT_ARGS
```

JSON args (stdin):
- `fact_id`: the id of the long-term row to forget.

The handler flips `active=0` on the row and regenerates the markdown mirrors. No tombstone row is created and no embedding is recomputed.

The response includes `content_preview` (first 200 chars of the archived row). Echo it back to the user so they can immediately see what was forgotten — if it's the wrong row (typo'd id from a stale recall result), they catch it on the spot.

If you forgot the wrong id, the row is still in the DB — call `/mindwright:restore <fact_id>` to flip `active=1` back. The audit trail (no row deletion) makes this safe.
