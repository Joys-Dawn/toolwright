---
name: check-deltas
description: Compute the delta between an existing audit snapshot and the live tree before snapshot cleanup
argument-hint: <run-id>
user-invocable: false
---

Read the diff stats between a still-existing audit snapshot and the live working tree. Used by callers that need to know how much the tree has drifted since the audit ran (e.g., re-audit decision logic) — they call this BEFORE `cleanup-snapshot` deletes the snapshot.

Execute:
!`node ${CLAUDE_PLUGIN_ROOT}/coordinator/index.js check-deltas --run $ARGUMENTS`

The command outputs a JSON object:

```json
{
  "ok": true,
  "runId": "<runId>",
  "groupIndex": 0,
  "snapshotPath": "<absolute path>",
  "totalAdded": <int>,
  "totalDeleted": <int>,
  "totalDiffLines": <int>,
  "totalLoc": <int>,
  "ratio": <float>,
  "changedFiles": ["<rel path>", ...]
}
```

Counts are scoped to git-visible source files (excludes `.gitignore`'d paths, build artifacts under `.claude/` / `node_modules/` / `dist/` / etc., and real `.env` secret files — `.env.example`, `.env.template`, `.env.sample` are kept, since those are routinely committed as documentation).

Errors if the snapshot has already been cleaned up. Always call this BEFORE `cleanup-snapshot --run <runId> --group <index>`.

Relay the JSON object verbatim to whoever invoked the skill — the caller decides whether the deltas warrant any action.
