---
name: update-memory
description: Replace the content of an existing long-term fact, preserving the supersede chain.
---

# /mindwright:update-memory

Call `mindwright_update_memory` with:
- `fact_id`: the id of the existing fact.
- `new_content`: the replacement text.

The original row is marked inactive and a new row is created with `supersedes` pointing back at it. The supersede chain itself is the audit trail; markdown mirrors regenerate automatically.

The response includes `old_content_preview` (first 200 chars of the replaced row). Echo it to the user so they can verify they updated the right row before moving on — silent replacement of the wrong fact is hard to detect later.
