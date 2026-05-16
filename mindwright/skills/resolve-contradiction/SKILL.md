---
name: resolve-contradiction
description: When two long-term facts contradict each other, pick one, merge them, or scope each so they coexist.
---

# /mindwright:resolve-contradiction

Call `mindwright_resolve_contradiction` with:
- `fact_id_a`, `fact_id_b`: the two contradictory facts.
- `resolution`: one of `prefer_a`, `prefer_b`, `merge`, `scope_both`.
- `scope_a`, `scope_b` (only for `scope_both`): qualifying scopes appended to each fact's content.
- `merged_content` (only for `merge`): the combined text.

Resolutions:
- `prefer_a` archives B.
- `prefer_b` archives A.
- `merge` inserts a new merged fact and archives both originals.
- `scope_both` inserts two new rows with the qualifier appended to each fact's content and archives both originals via supersede (so the audit chain is preserved). The returned `new_id_a` / `new_id_b` are the IDs to use for any later /mindwright:forget or /mindwright:restore.
