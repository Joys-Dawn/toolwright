# Feature: wrightward v2 — file-based message bus with a Discord bridge

## Context

wrightward today is a single-process-per-session coordination plugin. Every hook runs in response to events inside its own session, reads from `.claude/collab/`, and exits. Peer sessions communicate only through the shared filesystem state: A touches a file, B's next tool call runs guard.js and sees it. There is no path for A to actively notify B of anything, and an idle session never learns about anything that happens after its last tool call.

The user wants (1) peer-to-peer signalling between running sessions — handoffs, "file X is free now", broadcast notes — and (2) a way for the human to talk to all active agents from Discord, with agents able to reply back. Research in this conversation verified:

- The only documented mechanism to inject content into an idle Claude Code session is **Channels** — an MCP server with `experimental: { 'claude/channel': {} }` in its capabilities. Events arrive between turns via `notifications/claude/channel`, requires `claude --channels plugin:<name>` at launch, research preview, v2.1.80+, claude.ai login only. Primary source: `https://code.claude.com/docs/en/channels-reference`.
- Plugins can bundle MCP servers via `.mcp.json` at plugin root or the `mcpServers` field in `plugin.json`. Channels are declared via a first-class `channels` array in `plugin.json` that references a server by name. Source: `https://code.claude.com/docs/en/plugins-reference`.
- `userConfig` in plugin.json prompts users at enable time; values become `${user_config.KEY}` substitutions and `CLAUDE_PLUGIN_OPTION_<KEY>` env vars inside plugin subprocesses. Sensitive values go to keychain. This is how we store a Discord bot token.
- `${CLAUDE_PLUGIN_DATA}` is a persistent per-plugin directory surviving updates, suitable for lazily installed dependencies and daemon state files.
- `FileChanged` and `Notification` hooks cannot wake idle sessions — side-effect only.
- `CronCreate` fires while idle but is session-scoped self-poll only and costs a model turn per interval.
- Prior art (`pc035860/scratchpad-mcp`, `barkain/claude-code-workflow-orchestration`, `disler/claude-code-hooks-multi-agent-observability`) covers parent→subagent orchestration or event observability. None do peer-to-peer between independent top-level sessions.

Current wrightward (v2.3.2) is zero-dep Node ≥18, no `package.json`, file-based state. Phase 1 introduces one runtime dependency — `@modelcontextprotocol/sdk` — required for the bundled MCP server (the `Server` class and `StdioServerTransport` are the only way to implement MCP tools and Channel push). This is the official protocol library maintained by Anthropic; there is no raw-protocol alternative that isn't reinventing the wheel. A `package.json` is added to the plugin root with this single dependency. Phase 3 Discord transport adds no further dependencies (uses built-in `fetch()`).

wrightward already has all the primitives this feature needs:

- **File locking** (`lib/agents.js:27-64`): `withAgentsLock` uses `O_CREAT|O_EXCL|O_WRONLY` on `agents.json.lock`, 5 s mtime staleness recovery, randomized 50 ms backoff via `Atomics.wait`, 20 attempts. Cross-process — works between hook subprocess and long-lived MCP server subprocess in the same session.
- **Atomic writes** (`lib/atomic-write.js`): `atomicWriteJson` writes `<path>.<pid>.tmp` then renames.
- **Hard block on collab writes** (`hooks/guard.js:164-176`): Edit/Write on any path inside `.claude/collab/` exits code 2 with a loud stderr refusal, unconditionally.
- **Context injection format** (`hooks/guard.js:126-135`): `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: 'allow', additionalContext: message } }))`.
- **Context dedupe** (`lib/context-hash.js`): hash of the summary stored per-session so the same summary is never injected twice.
- **State directory** (`lib/collab-dir.js`): `ensureCollabDir` creates `.claude/collab/{context,context-hash}/`, writes a `root` file, appends to `.gitignore`.
- **Snapshot bypass** (`hooks/register.js:45-48`): cwds under `os.tmpdir()/agentwright-snapshots` skip registration.
- **Tests**: `node:test` + `node:assert/strict`. Hooks tested via `execFileSync('node', [HOOK], { input })` against fresh tmpdirs.

### The key architectural decision for v2

**The bus substrate is the filesystem, not a router.** wrightward sessions are independent local processes that all share `.claude/collab/`. That is *already* a usable communication substrate — it is how every feature works today. A v2 that introduces a broker daemon just to route messages between processes that already share a state directory would be reinventing what `fs.watch` + append-only JSONL provides for free.

So:

- **Phase 1 and Phase 2 have no daemon.** Hooks and per-session MCP servers talk through `.claude/collab/bus.jsonl` (append-only JSONL) and `.claude/collab/bus-delivered/<sessionId>.json` (per-session delivery bookmark). The MCP server watches the log with `fs.watch` (+ polling fallback) and emits `notifications/claude/channel` for Path 2 push. Hooks scan the log on every tool call for Path 1 fallback injection. Both paths coordinate through the bookmark file, serialized with `withAgentsLock`.
- **Phase 3 introduces exactly one daemon — the "Discord bridge."** Its entire job is to sit on one side of `bus.jsonl` as a reader/writer and on the other side of a Discord gateway websocket. It is not a router. It holds no agent connections. It has no IPC with local agents. It participates in bus I/O the same way every other process does.

This collapses an enormous amount of originally-planned surface area. No CLI in Phase 1, no IPC layer, no broker routing table, no connection heartbeat, no per-agent fallback mode. Phase 1 adds a handful of library modules, one MCP server, four skills, and a few hook extensions. Phase 3 is the first time wrightward has a long-lived process at all, and that process exists only because Discord requires one.

The scratchpad from earlier in this conversation is subsumed: `bus.jsonl` is the scratchpad. Same typed-entry schema, same hook-driven ambient injection, same retrospective queries, same retention.

## Requirements

1. **Peer-to-peer messaging between independent Claude Code sessions** sharing one repo. Typed messages: `note`, `finding`, `decision`, `blocker`, `handoff`, `file_freed`, `user_message`, `reply`, `status`, `interest`, `ack`, `session_started`, `session_ended`, `rate_limited`, `delivery_failed`.
2. **Addressing** — `to` field supports: specific `agentId`, `all` (broadcast), `role:<name>` (reserved for future), or `discord` (Phase 3 transport tag).
3. **Handoff protocol** — `type: "handoff"` carries `task_ref`, `files_unlocked` (released from the sender's claims as part of the handoff), `next_action`. Implicit ack when the recipient claims or writes one of the released files; explicit ack via `/wrightward:ack`. Expires after configurable TTL.
4. **Interest + file-freed notifications** — guard.js records an `interest` event when B's Write is blocked by A's claim. On release (via skill, scavenge, handoff, or session end), `lib/session-state.js` emits a targeted `file_freed` event for every interested agent.
5. **Two delivery modes for incoming events, both file-based**:
   - **Path 1 (always works, no opt-in)**: guard.js and heartbeat.js read pending urgent events targeted at this session from `bus.jsonl` (starting from the session's delivery bookmark) and inject them as `additionalContext` on the next tool call.
   - **Path 2 (opt-in push)**: when Claude Code is launched with `--channels plugin:wrightward@<marketplace>`, the bundled MCP server's file watcher detects new events targeted at this session between turns and emits them as `notifications/claude/channel` to wake the idle session. Path 2 and Path 1 coordinate via the per-session delivery bookmark — whichever processes an event first advances the bookmark, and the other path skips it.
6. **No daemon, no IPC, no CLI in Phase 1 or Phase 2.** Every agent-side actor is a filesystem reader/writer. The MCP server is spawned by Claude Code itself per session via `plugin.json:mcpServers` — wrightward does not manage any long-lived process.
7. **Phase 3 introduces exactly one long-lived process — the Discord bridge daemon** — whose sole purpose is to hold a Discord gateway connection and translate bus events ↔ Discord messages according to a mirror policy. The bridge daemon is a peer on the bus like everything else; it reads `bus.jsonl`, writes `bus.jsonl`, and takes `withAgentsLock` when updating shared state. It does not route between local agents.
8. **Bundled MCP server in one plugin** — hooks, skills, lib, MCP server, and (in Phase 3) the bridge daemon all ship inside `wrightward`. One `/plugin install wrightward@<marketplace>` — no sub-plugins.
9. **Cross-platform** — Windows-first dev. `fs.watch` behaves differently across platforms but Node.js provides a single API; the file watcher uses `fs.watch` with a 1 s polling fallback that is always on.
10. **Discord transport (Phase 3)** — one bot per machine, one forum channel holding per-agent threads plus a broadcast text channel, `@agent` routing in the broadcast channel, structured mirror policy. Agents never see any Discord-specific content; the bridge filters and formats on the way out.
11. **Private bus, opt-in Discord mirror** — non-negotiable. By default the bus is local-only. Discord is a transport that must be explicitly enabled via `userConfig` (bot token) plus `wrightward.json:discord.ENABLED`. The bridge applies a mirror policy filtering which bus events reflect outward.
12. **Noise policy is a first-class object** — not hard-coded. Default policy in `lib/mirror-policy.js`. Users override via `wrightward.json:discord.mirror`.
13. **Backwards compatibility** — wrightward with the MCP server uninstalled, no `--channels` flag, and no Discord configured must behave exactly like today: register, heartbeat, guard, plan-exit, cleanup all work, files are still coordinated, the hard block still enforces. The bus is strictly additive.
14. **One runtime dependency: `@modelcontextprotocol/sdk`.** Required for the bundled MCP server — there is no way to implement MCP tools or Channel push without it. A `package.json` is added to the plugin root with this single dependency. Phase 3 Discord transport uses the Discord REST API via Node 18's built-in `fetch()` — no additional dependencies. No `discord.js`, no lazy dependency management.
15. **Hard block on `.claude/collab/` stays.** `bus.jsonl` and `bus-delivered/` live inside `.claude/collab/` and are therefore protected by the existing hard block in `guard.js:164-176`. Agents read the bus only through MCP tools (which go through validated library functions) or Path 1 injection. Direct Edit/Write of the bus is blocked the same as direct edits to `agents.json`.

## Change Impact Map

### Files directly modified (across all phases)

- `wrightward/package.json` — **new file** (Phase 1). Single dependency: `@modelcontextprotocol/sdk`. Required for the bundled MCP server.
- `wrightward/.gitignore` — add `node_modules/` if not already present
- `wrightward/.claude-plugin/plugin.json` — Phase 1 adds `mcpServers`; Phase 2 adds `channels`; Phase 3 adds `userConfig.discord_bot_token`
- `wrightward/hooks/guard.js` — (a) on Write blocked, append an `interest` event to the bus; (b) on any tool call, include urgent events from the bus inbox (past the session's delivery bookmark) in the existing dedupe-hashed summary
- `wrightward/hooks/heartbeat.js` — inject urgent events on PostToolUse; advance delivery bookmark for what was injected; trigger bus retention compaction on the same cadence as existing scavenging
- `wrightward/hooks/register.js` — write MCP session-binding ticket (`mcp-bindings/<claudePid>.json`); append `session_started` event to the bus
- `wrightward/hooks/cleanup.js` — release claims (which cascades to `file_freed` emission); remove this session's entries from `bus-index/interest.json` via `interest-index.removeBySession`; append `session_ended` event; delete the MCP binding ticket
- `wrightward/hooks/plan-exit.js` — optional `status` event (no behavior change in Phase 1)
- `wrightward/lib/session-state.js` — on every removal path (`removeSessionState`, `scavengeExpiredSessions`, `scavengeExpiredFiles`), emit `file_freed` events for each interested agent
- `wrightward/lib/agents.js` — optional `session_started` / `session_ended` event emission; otherwise unchanged
- `wrightward/lib/config.js` — add `bus` section with defaults, `discord` section (Phase 3)
- `wrightward/wrightward.example.json` — add `bus`, `discord`, `discord.mirror` sections
- `wrightward/README.md` — Phase 1: "Message bus" section, updated skill list, backwards-compat statement. Phase 2: `--channels` setup. Phase 3: Discord setup, stock plugin conflict, `wrightward daemon` CLI

### Files added — Phase 1 (v3.0.0)

**Library (4 modules)**

- `wrightward/lib/bus-schema.js` — event type constants, schema validators, ID generation (ULID or UUIDv7 — used as stable identifiers only, **not** for ordering), timestamp helpers. Defines which types are "urgent" vs "ambient." `matchesSession(event, sessionId)` — exported for both readers to import (no inlined duplicates).
- `wrightward/lib/bus-log.js` — all bus I/O in one module. **Every function requires the caller to hold `withAgentsLock`** — no function acquires the lock internally. This is a single, composable convention: callers bracket with `withAgentsLock`, then call any combination of bus-log functions within that scope. Dev-mode assertion in every function trips if the lock isn't held.
  - `append(collabDir, event)` — appends one JSONL line, returns the new end-of-file offset.
  - `appendBatch(collabDir, events)` — appends multiple events as a single `fs.appendFileSync` call with `\n`-delimited lines. One I/O operation regardless of batch size. Used by scavenge paths to emit all `file_freed` events in one write instead of N separate appends.
  - `tailReader(collabDir, fromOffset)` — streaming tail reader returning `{ events, endOffset }`. `endOffset` is the byte position after the last *complete* line successfully parsed. Partial trailing lines are skipped with stderr warning. **If `fromOffset > fileSize` (happens after compaction shrinks the file), returns `{ events: [], endOffset: fileSize }` — the bookmark self-corrects on the next scan without any explicit reset.**
  - `readBookmark(collabDir, sessionId)` / `writeBookmark` — delivery bookmark I/O at `.claude/collab/bus-delivered/<sessionId>.json`, atomic via `lib/atomic-write.js`.
  - `compact(collabDir, config)` — retention by age and count; rewrites `bus.jsonl` atomically (write new file, rename); rebuilds `bus-index/interest.json` from scratch. **Does NOT touch bookmark files** — bookmarks self-correct because `tailReader` handles `fromOffset > fileSize` gracefully. Logs `[bus-log] compacted N→M events` to stderr.
  - TTL-expired events remain in the log until compaction removes them. Readers filter them out via `bus-query.js`.
- `wrightward/lib/bus-query.js` — read-side operations, all TTL-aware:
  - `listInbox(collabDir, sessionId, fromOffset)` returns urgent events past `fromOffset` where `matchesSession(e, sessionId)` is true and `e.expires_at` is unset or in the future. Also collapses duplicate `file_freed` events on `(meta.file, to)` within a 5 s window.
  - `findInterested(collabDir, filePath)` reads `bus-index/interest.json` and returns entries where the session is still alive (exists in `agents.json`) and the TTL hasn't expired. Pure index read — no bus log scan.
  - `writeInterest(collabDir, sessionId, filePath, ttlMs)` and `writeAck(collabDir, sessionId, ackOf, decision)` — write-a-specific-event helpers. `writeInterest` appends the bus event AND updates `bus-index/interest.json` in the same caller-held `withAgentsLock` scope.
- `wrightward/lib/interest-index.js` — thin wrapper around `lib/atomic-write.js` that owns `bus-index/interest.json`:
  - `read(collabDir)` — parses the index file, returns `{}` if missing.
  - `write(collabDir, index)` — atomic write.
  - `rebuild(collabDir)` — walks `bus.jsonl` from the head, rebuilds the index from scratch. Called by `bus-log.compact` and by `findInterested` on any JSON parse error (self-healing).
  - `upsert(collabDir, file, entry)` — incremental add, used by `writeInterest`.
  - `removeBySession(collabDir, sessionId)` — removes all entries for a session. Called by `cleanup.js` and `scavengeExpiredSessions` inside the same lock scope as the agent removal.

**MCP server (5 files)**

- `wrightward/mcp/server.js` — MCP server entry. Spawned by Claude Code per session via `plugin.json:mcpServers`. Startup sequence:
  1. Resolve the project root: the plugin is spawned with `cwd` inherited from Claude Code, so walk up from `process.cwd()` looking for `.claude/collab/root`. Fall back to `${CLAUDE_PLUGIN_DATA}` for daemon-state files only (never for locating the project).
  2. **Bind to a session ID via `mcp/session-bind.js`** (see below). If binding fails within the startup deadline, log to stderr and run in "unbound" mode — all tools return `{ error: "session binding not available" }` and the file watcher is inert. Hooks continue to work.
  3. Register tools, connect stdio transport, start the file watcher.
  4. On SIGTERM: release the binding file, drain, exit.
- `wrightward/mcp/session-bind.js` — **new file, resolves the critical session-ID-in-MCP-subprocess problem.** Claude Code does not expose session ID to MCP subprocess env (verified: `code.claude.com/docs/en/plugins-reference` documents only `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CLAUDE_PLUGIN_OPTION_<KEY>`). The MCP server and the SessionStart hook are both children of the same Claude Code CLI process, so `process.ppid` is identical for both. Binding protocol:
  1. SessionStart hook (`hooks/register.js`) learns `session_id` from stdin and `claudePid = process.ppid`. Under `withAgentsLock`, writes `.claude/collab/mcp-bindings/<claudePid>.json = { session_id, created_at, hook_pid: process.pid }`.
  2. `mcp/server.js` on startup: `claudePid = process.ppid`. Polls `.claude/collab/mcp-bindings/<claudePid>.json` once every 100 ms for up to 5 s. When the file appears, reads `session_id`, and immediately writes a `claimed: true, mcp_pid: process.pid` update under `withAgentsLock`. Logs the bound session ID to stderr.
  3. `hooks/cleanup.js` on SessionEnd deletes `.claude/collab/mcp-bindings/<claudePid>.json` (same lock).
  4. Edge case: Claude Code spawning order is implementation-defined — the MCP server may start before or after the SessionStart hook fires. The 5 s poll handles either order. If the hook is delayed >5 s, the MCP server enters unbound mode and re-attempts binding every 30 s by re-polling.
  5. Edge case: `process.ppid` doesn't identify the Claude Code process if a shell wrapper intervenes. With `.mcp.json:"command": "node"` there is no shell wrapper — `node` is execed directly by Claude Code. Verified acceptable on Linux/macOS; on Windows, Node 9+ implements `process.ppid` correctly over CreateProcess.
  6. Edge case: **session resume** — when a user resumes a session via `--resume` or `--continue`, Claude Code may reuse the MCP server subprocess but fire a new SessionStart hook with a different `session_id`. The hook overwrites the binding ticket (same `claudePid`, new `session_id`). The MCP server detects this by **re-reading the ticket on every tool call** (cheap: one small JSON read) and comparing `session_id` against the cached value. If it changed, the server re-binds and logs `[wrightward-mcp] re-bound to session <new_id> (resume detected)`.

  This mechanism is isolated to one small module with its own test, so if Anthropic later ships `${CLAUDE_SESSION_ID}` as a substitution token (tracked in the plan's "Open questions"), we replace `session-bind.js` wholesale without touching the rest of the MCP server.
- `wrightward/mcp/capabilities.js` — capability declaration. Phase 1 ships `tools: {}` only. Phase 2 adds `experimental: { 'claude/channel': {} }`. Phase 3 optionally adds `experimental: { 'claude/channel/permission': {} }` (deferred).
- `wrightward/mcp/tools.js` — the six MCP tools (see API section).
- `wrightward/mcp/file-watcher.js` — `fs.watch(bus.jsonl)` with unconditional 1 s polling fallback for reliability. Debounced (50 ms). **Before acquiring `withAgentsLock`, checks `fs.statSync(bus.jsonl).mtimeMs` against a cached value — if unchanged, skips the lock entirely.** This eliminates phantom contention from idle buses (N sessions × 1 poll/sec × lock acquisition each = N unnecessary lock-holds/sec without this check). On mtime change, acquires the lock and calls `bus-query.listInbox(boundSessionId)`; if there are new urgent events targeted at me, calls into `mcp/channel-push.js` (Phase 2) or is a no-op in Phase 1. If the server is in unbound mode, the watcher is inert.

Note: there is no `mcp/fallback.js` — there is nothing to fall back from. The file-based path is the normal path.

**Skills (4 new)**

- `wrightward/skills/handoff/SKILL.md` — `/wrightward:handoff <target> <task>` invokes `wrightward_send_handoff` via the MCP tool. Releases listed files as part of the handoff.
- `wrightward/skills/watch/SKILL.md` — `/wrightward:watch <file>` invokes `wrightward_watch_file`.
- `wrightward/skills/inbox/SKILL.md` — `/wrightward:inbox` invokes `wrightward_list_inbox`.
- `wrightward/skills/ack/SKILL.md` — `/wrightward:ack <id>` invokes `wrightward_ack`.

No `/wrightward:bus` skill yet — there's no daemon to query in Phase 1. Defers to Phase 3.

**Tests — Phase 1** (file list; see Testing Strategy for per-test cases)

- `wrightward/test/lib/bus-schema.test.js`
- `wrightward/test/lib/bus-log.test.js`
- `wrightward/test/lib/bus-query.test.js`
- `wrightward/test/lib/interest-index.test.js`
- `wrightward/test/mcp/session-bind.test.js`
- `wrightward/test/mcp/server.test.js`
- `wrightward/test/mcp/file-watcher.test.js`
- `wrightward/test/hooks/guard.test.js` — extensions
- `wrightward/test/hooks/heartbeat.test.js` — extensions
- `wrightward/test/hooks/register.test.js` — extensions
- `wrightward/test/hooks/cleanup.test.js` — extensions
- `wrightward/test/integration/handoff.test.js`
- `wrightward/test/integration/file-freed.test.js`
- `wrightward/test/integration/path-dedupe.test.js`
- `wrightward/test/integration/mcp-binding-race.test.js`
- `wrightward/test/integration/scavenge-perf.test.js`

### Files added — Phase 2 (v3.1.0)

- `wrightward/mcp/channel-push.js` — given a list of urgent events targeted at my session, emit `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` and advance the delivery bookmark.
- `wrightward/test/mcp/channel-push.test.js` — mock the MCP `notification` path, verify channel messages emitted correctly (primary automated test for channel push)
- `wrightward/test/integration/channel-push.test.js` — spawn MCP server over stdio, perform handshake, append bus event, assert `notification()` called internally via spy. Does NOT test end-to-end delivery into a Claude Code session (requires interactive mode; verified manually)

Phase 2 also updates:

- `mcp/capabilities.js` — add `'claude/channel': {}` to experimental capabilities
- `mcp/file-watcher.js` — wire up the channel-push call path (previously a no-op in Phase 1)
- `.claude-plugin/plugin.json` — add `channels: [{ server: "wrightward-bus" }]`

### Files added — Phase 3 (v3.2.0, the Discord bridge)

Phase 3 uses the **Discord REST API via built-in `fetch()`** (Node 18+) instead of `discord.js`. No additional runtime dependencies beyond the existing `@modelcontextprotocol/sdk`. The stock `discord@claude-plugins-official` Channel plugin handles direct user→agent DM messaging per session; wrightward's bridge adds multi-agent observability on top: thread-per-agent, broadcast routing, bus event mirroring. The two are complementary — users can install both.

**The bridge daemon (4 files)**

- `wrightward/broker/bridge.js` — the entire long-lived process. Startup: read config, verify Discord enabled, verify bot token, start a file watcher on `bus.jsonl`, start the inbound poller. Main loop: outbound path (bus event → mirror policy → Discord REST POST), inbound path (poll broadcast channel via REST GET every 3 s → parse @-mentions → write to `bus.jsonl`). SIGTERM drains and exits.
- `wrightward/broker/lifecycle.js` — PID file at `${CLAUDE_PLUGIN_DATA}/bridge.pid`, log at `${CLAUDE_PLUGIN_DATA}/bridge.log` (rotated at 10 MB, keep 3), ready marker `bridge.ready`, stale-PID detection, start/stop/status.
- `wrightward/broker/file-watcher.js` — same pattern as `mcp/file-watcher.js`: `fs.watch` + 1 s polling with mtime skip. Filters events by mirror policy.
- `wrightward/broker/bridge-delivery.js` — bridge's delivery bookmark I/O. The bridge has its own bookmark in `.claude/collab/bus-delivered/bridge.json` so it doesn't re-mirror events on restart. First-start seeds to tail.

**Mirror policy (in lib so it's reusable and testable)**

- `wrightward/lib/mirror-policy.js` — pure function. Takes `(event, policyConfig)`, returns `{ action: 'post_thread'|'post_broadcast'|'silent'|'never', severity, formatted_body? }`. Defaults baked in; user config merges on top. First-match-wins override ordering.
- `wrightward/test/lib/mirror-policy.test.js`

**Discord REST client (3 files — all use built-in `fetch()`, no dependencies)**

- `wrightward/discord/api.js` — thin wrapper around `fetch()` for Discord REST API v10. Handles auth header (`Bot <token>`), rate-limit response headers (429 → backoff + retry), JSON serialization. ~80 lines. Exposes: `postMessage(channelId, content)`, `getMessages(channelId, after?)`, `createForumThread(channelId, name, content)`, `archiveThread(threadId)`, `editThread(threadId, name)`.
- `wrightward/discord/threads.js` — per-agent thread lifecycle via REST calls. Creates a forum thread on `session_started` events, renames on collab-context updates (rate-limited to 2/10 min), archives on `session_ended`. Maintains `.claude/collab/bus-index/discord-threads.json` (derived cache, rebuildable).
- `wrightward/discord/formatter.js` — bus event → Markdown. Severity emoji, short-ID suffix, attribution, truncation.

Inbound message parsing (`@agent-<name>` mentions in the broadcast channel) is handled directly in `broker/bridge.js` during the REST poll loop — simple enough to not warrant a separate module.

**CLI**

- `wrightward/bin/wrightward` — `daemon start|stop|status|logs`, `doctor`. Node shebang; Linux/macOS executable.
- `wrightward/bin/wrightward.cmd` — Windows wrapper (per plugin docs, `bin/` files are added to the Bash tool's PATH; Windows users get `.cmd` shim).

**Skills — Phase 3**

- `wrightward/skills/bus/SKILL.md` — `/wrightward:bus` shows bridge daemon status, recent mirror policy matches. Shells out to `bin/wrightward status`.

**Tests — Phase 3**

- `wrightward/test/broker/bridge.test.js` — spawn bridge with mock Discord REST responses, append bus events, assert mirror policy-appropriate REST calls. First-start test with pre-populated bus.jsonl.
- `wrightward/test/broker/lifecycle.test.js` — start/stop/status, stale PID detection, log rotation
- `wrightward/test/broker/file-watcher.test.js` — mirror of the MCP file-watcher tests (with mtime skip)
- `wrightward/test/discord/api.test.js` — mock `fetch()`, verify auth header, rate-limit retry, error handling
- `wrightward/test/discord/threads.test.js` — create/rename/archive lifecycle via mocked REST; rate limit honored
- `wrightward/test/discord/formatter.test.js`

### Files indirectly affected

- `lib/context-hash.js` — dedupe hash now covers both the "other agents summary" AND the injected inbox events. Extending the hash input is the only change; the function signature doesn't change.
- Every existing hook test — because `lib/session-state.js` now emits bus events on removal, tests that assert "only agents.json and contexts changed" may see an additional `bus.jsonl` append. Relax assertions where needed.
- `agentwright/coordinator/` — agentwright consumes wrightward state through library exports (`readAgents`, `readContext`) and the `collab-done` skill. No API changes; the additive bus emission should not break it. Verify during Phase 1 implementation.

### Implicit contracts at risk

- **`hookSpecificOutput.additionalContext` dedupe hash**: today it's hashed over the "other agents summary" only. Extending guard.js to also inject inbox events means the hash must cover the combined payload. Fix: compute hash over the combined string (summary + serialized urgent events, sorted by offset).
- **`scavengeExpiredFiles` side-effect expansion**: today silent, soon emits `file_freed` bus events and updates `bus-index/interest.json` — all inside the same `withAgentsLock` critical section. Existing tests assert filesystem state only; we add bus state + index assertions without removing old ones. `integration/scavenge-perf.test.js` is the backstop for lock-hold regressions.
- **Locking convention**: every bus-log and bus-query function requires the caller to hold `withAgentsLock`. Dev-mode assertion in every bus-log function trips if the lock isn't held.
- **Hard block on `.claude/collab/`**: `bus.jsonl`, `bus-delivered/`, and `bus-index/` all live inside — they're protected by the existing hard block unchanged. The MCP server reads/writes these files but it runs as a separate process and is not subject to the `guard.js` hard block (which only applies to model-initiated tool calls, not plugin subprocesses).
- **Snapshot bypass (`register.js:45-48`)** must still fire before any bus emission AND before the MCP binding ticket is written, so snapshots never pollute `bus.jsonl` or leave stray ticket files. Order in the updated `register.js`: snapshot-check → write binding ticket → append `session_started`.
- **Session ID validation**: every new file path derived from session ID must go through `validateSessionId`. Bus log `from` field validated on append.

### Untested zones (pre-existing, not expanded by this plan)

- `lib/atomic-write.js` has no standalone test file
- `lib/auto-track.js` has no standalone test file (covered transitively by `heartbeat.test.js`)

Neither blocks this plan; they're current gaps we do not make worse.

### Coupling hotspots

- `lib/session-state.js` — imported by register, heartbeat, cleanup, context. Adding bus emission here is high-leverage. Keep everything inside a single `withAgentsLock` critical section: serialize filesystem state, consult `bus-index/interest.json`, collect all `file_freed` events, then **emit them in one `bus-log.appendBatch` call** — one I/O operation regardless of how many interested agents there are. Benchmark `scavengeExpiredFiles` with 50 expired files × 20 interested agents to confirm total lock-hold remains well under the existing 5 s staleness recovery threshold.
- `lib/agents.js:withAgentsLock` — the sole serialization point for every bus operation. Every caller of bus-log and bus-query functions holds this lock. No bus-log function acquires it internally. **Lock contention metric**: `withAgentsLock` logs wait time to stderr when acquisition takes >100 ms, so degradation is visible before it causes failures. The 5 s `LOCK_STALE_MS` threshold is the hard ceiling; the 100 ms warning is the soft signal.

## Design

### User-Facing Behavior

**Baseline — no MCP server, no channels, no Discord (backwards-compat)**

If a user doesn't upgrade their plugin.json to declare the MCP server (or they explicitly disable it), wrightward behaves exactly like v2.3.2. All existing hooks and skills work unchanged.

**Phase 1 — MCP server active, no `--channels`, no Discord**

User runs `/plugin install wrightward@...`. The plugin declares an MCP server in `plugin.json`, and Claude Code auto-spawns it per session. Agents can now:

- Use `/wrightward:handoff <target> <task>` to push a handoff to another agent
- Use `/wrightward:watch <file>` to register interest in a file owned by another agent
- Receive `file_freed` events on the next tool call saying "src/auth.ts is now free, you were blocked earlier"
- Receive handoffs from other agents on the next tool call via Path 1 injection
- Query `/wrightward:inbox` to see pending urgent events
- Ack handoffs with `/wrightward:ack <id>`

No daemon to manage. No CLI. No IPC. Everything is a file read or append.

**Phase 2 — MCP server + `--channels`**

User launches Claude Code with `claude --channels plugin:wrightward@<marketplace>`. The bundled MCP server's channel capability activates. When a peer sends a handoff or a file frees up, the target session wakes between turns — no tool call needed — and processes the event. User sees Claude start responding on its own: "Agent A released src/auth.ts — I can now edit it."

**Phase 3 — Discord bridge active**

User configures a Discord bot token once via the plugin `userConfig` prompt. Edits `.claude/wrightward.json` to enable Discord and set channel IDs. Runs `wrightward daemon start`. The bridge connects via Discord REST API (no dependencies to install), watches `bus.jsonl`, and creates forum threads per active agent. User posts `@agent-a run the test suite` in the broadcast channel — the bridge polls via REST, parses the @-mention, and writes a `user_message` to agent A's bus inbox. Agent A replies; the reply posts to A's Discord thread.

### Error states

- **MCP server can't reach `.claude/collab/`** — log to stderr, degrade: channel push disabled, tools become no-ops that return `{ error: "collab dir missing" }`. Hooks continue to work on the filesystem.
- **`fs.watch` doesn't fire** (known cross-platform flake) — the 1 s polling fallback is always running, so the file is re-checked every second regardless.
- **`bus.jsonl` has a partial last line** (process SIGKILL'd mid-append while holding `withAgentsLock`) — reader skips the malformed line and logs to stderr. `tailReader.endOffset` advances past the partial line only when retention compaction rewrites the file; until then, every reader sees the same skip-and-warn. Since callers hold `withAgentsLock` for every append, concurrent writers cannot interleave — the only partial-write scenario is a hard kill, not a race.
- **Phase 3 daemon crashes** — `wrightward daemon status` reports crashed, shows last 20 log lines. User restarts with `wrightward daemon start`. Local agent-to-agent is unaffected; only Discord mirroring is interrupted.
- **Phase 3 Discord REST failures** — `discord/api.js` retries on 5xx and 429 (rate limit) with exponential backoff. Persistent failures log to stderr and the bridge continues watching the bus; Discord posting resumes when the API recovers.
- **Rate limit hit** (Discord only) — outbound coalesced or dropped with a `rate_limited` meta-event in the bus for observability.

### Data Model

**`.claude/collab/bus.jsonl`** — new file, append-only, one JSON record per line, UTF-8.

```jsonc
{
  "id": "string",             // ULID or UUIDv7 — stable identifier only, NOT a sort key (ordering = byte offset)
  "ts": 1712890000000,        // integer ms since epoch
  "from": "string",           // session ID, or "bridge" (Phase 3)
  "to": "string|string[]",    // "all" | "<agentId>" | "role:<name>" | "discord"
  "type": "note|finding|decision|blocker|handoff|file_freed|user_message|reply|status|interest|ack|session_started|session_ended|rate_limited|delivery_failed",
  "body": "string",
  "meta": {
    // handoff:           { task_ref, files_unlocked: [], next_action, ttl_ms }
    // file_freed:        { file, released_by, reason }
    // interest:          { file, blocked_at, ttl_ms }
    // ack:               { ack_of: "<id>", decision: "accepted|rejected|dismissed" }
    // user_message/reply:{ thread_id, sender_display_name }
  },
  "severity": "info|warn|critical",
  "expires_at": 1712890000000
}
```

"Urgent" is derived from `type`: `{handoff, file_freed, user_message, blocker, delivery_failed}`. Only urgent events trigger Path 1/Path 2 delivery.

**`.claude/collab/bus-delivered/<sessionId>.json`** — per-session delivery bookmark, atomic JSON.

```jsonc
{
  "lastDeliveredOffset": 45678,        // PRIMARY: byte offset where the last delivered event ends
  "lastScannedOffset": 45900,           // byte offset of the last byte the reader has seen
  "lastDeliveredId": "01HV5FZ...",     // event ID — retained for audit/debug only, NOT for ordering
  "lastDeliveredTs": 1712890000000     // event ts — retained for audit/debug only
}
```

Initial shape on first session tool call (no file present yet): all four zero/empty. The first append-and-deliver pass is not gated by a magic "first-run" check — a zero `lastScannedOffset` and a zero-length bookmark ID naturally match "tail from start of file, no event yet delivered."

Always written under `withAgentsLock` to serialize between guard.js/heartbeat.js (hook subprocesses) and the long-lived MCP server in the same session. Every bus append is in the same lock — no split serialization.

**TTL filter at read time.** Every read path in `bus-query.js` (`listInbox`, `findInterested`, `lookupAck`) filters out events whose `expires_at` is set and `< Date.now()`. TTL-expired events live in the log until retention compaction, but they are invisible to readers. This applies to `interest` events (prevents stale file_freed emissions after INTEREST_TTL_MIN elapses), `handoff` events (past HANDOFF_TTL_MIN), and any future typed event carrying `expires_at`.

**`.claude/collab/bus-index/discord-threads.json`** — Phase 3 only. Bidirectional `agentId ↔ threadId` map. Derived cache, rebuildable from Discord API if corrupted.

**`.claude/collab/bus-index/interest.json`** — authoritative index of active interests, keyed by file path. `findInterested(file)` is on the hot path of every release inside `scavengeExpiredFiles`, so index-backed O(1) lookup is required. Compact map:

```jsonc
{
  "src/auth.ts": [
    { "sessionId": "b9742e4d", "busEventId": "01HV...", "declaredAt": 1712890000000, "expiresAt": 1712893600000 }
  ],
  "src/jwt.ts": [ ... ]
}
```

Updated atomically (via `lib/atomic-write.js`) inside the same `withAgentsLock` critical section as the interest event append. Rebuildable from `bus.jsonl` on corruption. Consulted on every release path in `session-state.js` — turns an O(log-size × files-released) scan into O(files-released × 1-index-read).

**`wrightward.json` additions**

```jsonc
{
  // existing keys unchanged
  "bus": {
    "ENABLED": true,               // default ON — the bus is the Phase 1 feature
    "RETENTION_DAYS": 7,
    "RETENTION_MAX_EVENTS": 10000,
    "HANDOFF_TTL_MIN": 30,
    "INTEREST_TTL_MIN": 60,
    "URGENT_INJECTION_CAP": 5
  },
  "discord": {
    "ENABLED": false,              // default OFF — Phase 3 opt-in
    "FORUM_CHANNEL_ID": null,
    "BROADCAST_CHANNEL_ID": null,
    "AGENT_DISPLAY_NAME_SOURCE": "task",
    "THREAD_RENAME_ON_CONTEXT_UPDATE": true,
    "ALLOWED_SENDERS": [],          // Discord user IDs; empty = send-only
    "MIRROR_RATE_LIMIT": { "msgs": 5, "per_ms": 5000 }
  },
  "discord.mirror": {
    "overrides": [
      // first-match-wins, e.g.:
      { "match": { "type": "finding", "severity": "critical" }, "action": "post_thread" }
    ]
  }
}
```

Bot token is **not** in `wrightward.json` — it goes through `userConfig.sensitive` and the keychain.

### Architecture

#### Phase 1 and Phase 2 — two processes per session, file-based

```
       Claude Code session A                  Claude Code session B
             │                                      │
      ┌──────┴──────┐                         ┌─────┴──────┐
      │             │                         │            │
      ▼             ▼                         ▼            ▼
   hooks (5)   MCP server                  hooks (5)   MCP server
      │             │                         │            │
      │             │ fs.watch + polling      │            │
      │             ▼                         │            ▼
      │       channel push                    │       channel push
      │       (Phase 2)                       │       (Phase 2)
      │             │                         │            │
      └──────┬──────┘                         └─────┬──────┘
             │  append + read                       │
             ▼                                      ▼
   ┌────────────────────────────────────────────────────┐
   │  .claude/collab/bus.jsonl  (append-only JSONL)     │
   │  .claude/collab/bus-delivered/<sessionId>.json     │
   │  .claude/collab/agents.json, context/, ...         │
   └────────────────────────────────────────────────────┘
```

Two Node.js processes per session — five hook subprocesses (one per Claude Code hook event, same as today) and one long-lived MCP server subprocess spawned by Claude Code itself via `plugin.json:mcpServers`. Both communicate through filesystem state. The MCP server is the only process that watches `bus.jsonl` continuously; hooks read on demand during tool calls.

No IPC. No daemon. No CLI. No broker.

#### Phase 3 — add the Discord bridge as a peer on the bus

```
   Session A                    Session B                    Bridge daemon
      │                            │                              │
      ▼                            ▼                              ▼
   [hooks + MCP]                [hooks + MCP]               [Discord client]
      │                            │                              │
      │ append + read              │ append + read                │ append + read
      ▼                            ▼                              ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │             .claude/collab/bus.jsonl + bus-delivered/               │
   └─────────────────────────────────────────────────────────────────────┘
                                                                  │
                                                                  ▼
                                                         Discord gateway
```

The bridge is just another reader/writer on the same substrate. It has its own delivery bookmark (`bus-delivered/bridge.json`), takes `withAgentsLock` when updating, and participates in the file-based protocol the same way a session's MCP server does.

What the bridge uniquely owns:

- The Discord REST API client (bot token, rate-limit state)
- The `discord/threads.json` cache
- The `bridge.pid` / `bridge.log` lifecycle files

What the bridge does **not** own:

- Any routing between local agents
- Any IPC connections
- Any authority over the bus log (every other process reads/writes it too)
- Any rate limiting for agent-to-agent (only for Discord)

If the bridge crashes, local agents are unaffected — the bus keeps flowing. They just lose Discord mirroring until the user restarts the daemon.

#### Path 1 / Path 2 dedupe

Both paths read from `bus.jsonl` and both update the same per-session bookmark at `.claude/collab/bus-delivered/<sessionId>.json`. The bookmark's authoritative ordering key is the **byte offset into `bus.jsonl`**, not the event ID — ULIDs have undefined lex order within the same millisecond (spec: `github.com/ulid/spec` "Within the same millisecond, sort order is not guaranteed"), so ID-based comparison can silently skip events. Offset is monotonic and reflects actual append order regardless of clock.

Dedupe:

```js
// simplified — runs inside guard.js (Path 1) and mcp/file-watcher.js (Path 2)
// caller holds withAgentsLock; all bus-log calls happen within this scope
withAgentsLock(collabDir, () => {
  const bookmark = readBookmark(sessionId);
    // initial shape: { lastDeliveredOffset: 0, lastScannedOffset: 0, lastDeliveredId: "", lastDeliveredTs: 0 }
  const { events, endOffset } = tailBusLog(busLog, bookmark.lastScannedOffset);
  const urgent = events.filter(e => isUrgent(e) && matchesSession(e, sessionId));
  if (urgent.length === 0) {
    // still advance the scanned offset — we've seen these events, they just weren't for us
    if (endOffset !== bookmark.lastScannedOffset) {
      writeBookmark(sessionId, { ...bookmark, lastScannedOffset: endOffset });
    }
    return;
  }
  // deliver: Path 1 returns additionalContext, Path 2 calls mcp.notification()
  deliver(urgent);
  const last = urgent[urgent.length - 1];
  writeBookmark(sessionId, {
    lastDeliveredOffset: last._offset,   // byte offset where this event ends
    lastScannedOffset: endOffset,         // byte offset where the tail read stopped
    lastDeliveredId: last.id,             // retained for audit/debug only
    lastDeliveredTs: last.ts
  });
});
```

Key invariants:

1. **Callers hold `withAgentsLock` for every bus operation.** No bus-log function acquires the lock internally — this keeps the API composable so callers can do `append + index update + bookmark write` in a single critical section. The lock is the sole serialization point on every platform. Locks are cheap (<1 ms median per existing `agents.js` benchmarks).
2. **`tailBusLog` returns `{ events, endOffset }`.** The reader tracks the offset where parsing actually stopped — after the last complete line successfully consumed. A partial trailing line (from a process killed mid-append) is skipped, logged to stderr, and the offset advances past it on the next compaction pass, not this one.
3. **Bookmark advances even when the urgent filter is empty** — as long as we've scanned past new events. Otherwise a flood of irrelevant events (notes, session_started broadcasts the session is filtered out of) would force a re-scan every tool call.
4. **Ordering key is offset, not ID.** `lastDeliveredOffset` is the primary. ID and ts are retained in the bookmark for audit logs only.

Whichever path runs first advances the bookmark. The other path sees an empty urgent list (or a smaller one, if more events arrived in between) and does nothing.

**`matchesSession(event, sessionId)` — exact semantics:**

```js
function matchesSession(event, sessionId) {
  if (event.from === sessionId) return false;       // never echo to sender
  if (Array.isArray(event.to)) {
    return event.to.some(t => matchOne(t, sessionId));
  }
  return matchOne(event.to, sessionId);
}

function matchOne(to, sessionId) {
  if (to === sessionId) return true;
  if (to === "all") return true;
  if (typeof to === "string" && to.startsWith("role:")) return false;  // Phase 1: no roles
  return false;
}
```

Both readers (guard.js Path 1, file-watcher.js Path 2) import this exact function from `bus-query.js` — never inlined. `bus-query.listInbox` and every other read path also run events through `matchesSession`. No semantic drift possible between callers.

Semantic acks remain as bus events. An `ack` event means "the model accepted/rejected/dismissed this handoff" — audit data, separate from "wrightward delivered this event to the model." Delivery = bookmark file; semantic = bus event.

#### Why the MCP server also handles channel push (Path 2)

The MCP server is the only process in the per-session model that runs continuously between tool calls. Claude Code spawns it via stdio, keeps it alive for the session, and routes `notifications/claude/channel` emissions from it straight into the session's conversation stream. Hooks can't do channel push — they're short-lived subprocesses that exit before any notification could be delivered between turns.

So the division is forced by Claude Code's architecture:
- Path 1 (tool-call injection) = hooks
- Path 2 (idle session wake) = MCP server

Both produce the same end result from the user's perspective: an urgent event lands in the session's conversation. Path 2 is faster; Path 1 is the permanent fallback.

### API & Integration Points

#### `plugin.json` — final form after Phase 3

```jsonc
{
  "name": "wrightward",
  "version": "3.2.0",
  "description": "Multi-agent coordination and message bus for Claude Code",
  "author": { "name": "yiann" },
  "license": "Apache-2.0",
  "keywords": ["multi-agent", "collaboration", "bus", "discord"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "channels": [
    { "server": "wrightward-bus" }
  ],
  "userConfig": {
    "discord_bot_token": {
      "description": "Discord bot token (optional — leave blank to run without Discord)",
      "sensitive": true
    }
  }
}
```

#### `.mcp.json`

```jsonc
{
  "mcpServers": {
    "wrightward-bus": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"],
      "env": {
        "WRIGHTWARD_DATA_DIR": "${CLAUDE_PLUGIN_DATA}"
      }
    }
  }
}
```

Claude Code documents only two substitution tokens in `env` for plugin MCP subprocesses: `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`, plus `${user_config.KEY}` / `CLAUDE_PLUGIN_OPTION_<KEY>` for user-configured values (source: `code.claude.com/docs/en/plugins-reference`). There is **no session-ID substitution**. `WRIGHTWARD_DATA_DIR` here is used only for bridge-daemon state files (Phase 3); project-root resolution walks up from `process.cwd()`, and session-ID resolution uses the `process.ppid`-based binding described in `mcp/session-bind.js`.

The MCP server imports from `@modelcontextprotocol/sdk`, so wrightward ships a `package.json` at the plugin root with this dependency. `node_modules/` is populated by the standard `npm install` during plugin development/publishing. Claude Code's plugin system resolves `node` imports from the plugin's own `node_modules/` because the MCP server runs with `cwd` set to the plugin directory.

#### MCP tool surface (6 tools, `wrightward_*` prefix)

| Tool | Inputs | Output | Semantics |
|---|---|---|---|
| `wrightward_list_inbox` | `{ limit?: number, types?: string[], mark_delivered?: boolean }` | `{ events: BusEvent[] }` | Returns urgent events targeted at this session, starting past the delivery bookmark. `mark_delivered` defaults to `true` — the calling model *is* delivery, so advance the bookmark. Pass `false` for inspection-only reads (e.g. from an audit skill). |
| `wrightward_ack` | `{ id: string, decision?: 'accepted'\|'rejected'\|'dismissed' }` | `{ ok: true }` | Appends a semantic `ack` event to the bus. |
| `wrightward_send_note` | `{ to?: string, body: string, files?: string[] }` | `{ id: string }` | Appends a `note` event; defaults `to: "all"`. |
| `wrightward_send_handoff` | `{ to: string, task_ref: string, files_unlocked: string[], next_action: string }` | `{ id: string }` | Releases listed files from this session's claims (via `lib/session-state`), then appends a `handoff` event. Downstream `file_freed` events are emitted for interested agents **except the handoff recipient** — the recipient learns about the unlocked files from the handoff event itself, so a second `file_freed` would be noise. |
| `wrightward_watch_file` | `{ file: string }` | `{ id: string }` | Appends an `interest` event and updates `bus-index/interest.json` in the same lock. |
| `wrightward_bus_status` | `{}` | `{ pending_urgent: number, last_ts, retention_entries: number, bound_session_id: string\|null }` | Diagnostic. Does not query a daemon — reads bus log directly. Reports the MCP server's bound session ID (or null if in unbound mode). |

#### Channel push format (Phase 2)

```js
mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: buildChannelBody(event),
    meta: {
      bus_id: event.id,
      event_type: event.type,
      from: event.from,
      severity: event.severity || 'info'
    }
  }
});
```

Rendered to the session as:

```
<channel source="wrightward-bus" bus_id="01HV5FZ..." event_type="handoff" from="agentA" severity="info">
Agent agentA handed off the auth refactor to you. Files unlocked: src/auth.ts, src/jwt.ts.
Next action: run the migration test suite.
Ack with /wrightward:ack <id> or accept implicitly by editing one of the released files.
</channel>
```

### State Management

#### In-memory state

Phase 1 + Phase 2: **none owned by wrightward.** Hooks are short-lived. The MCP server holds: a file watcher, a debounce timer, the bound session ID (learned at startup via `mcp/session-bind.js`; null until bound), and the last-known bookmark for fast-path skip. All authoritative state is on disk.

Phase 3 (bridge daemon): the Discord REST rate-limit bucket state, a `lastPolledMessageId` for the broadcast channel inbound poller, and an in-memory copy of `discord-threads.json` refreshed on write.

#### On-disk state in `.claude/collab/`

- Existing: `agents.json`, `agents.json.lock`, `context/<id>.json`, `context-hash/<id>.json`, `root`
- New (Phase 1): `bus.jsonl` — append-only event log
- New (Phase 1): `bus-delivered/<sessionId>.json` — per-session delivery bookmark
- New (Phase 1): `bus-index/interest.json` — derived index of active interests (rebuildable from the log)
- New (Phase 1): `mcp-bindings/<claudePid>.json` — MCP session-binding tickets written by SessionStart hook, read by MCP server, deleted by SessionEnd hook
- New (Phase 3): `bus-delivered/bridge.json` — bridge's own bookmark (seeded to tail on first start)
- New (Phase 3): `bus-index/discord-threads.json` — derived cache

#### On-disk state in `${CLAUDE_PLUGIN_DATA}`

Phases 1 + 2 use this directory only for `WRIGHTWARD_DATA_DIR` hand-off to the MCP server, with no files currently written there.

Phase 3 writes:

- `bridge.pid`
- `bridge.log` (rotated 10 MB, keep 3)
- `bridge.ready` (marker, removed on shutdown)

### Testing Strategy

All tests use the existing `node:test` + `node:assert/strict` pattern with `fs.mkdtempSync` temp dirs. Test skill: `write-tests`. Existing test conventions preserved.

**Phase 1 — unit and integration**

- `lib/bus-schema.test.js` — validators reject missing fields, accept all types, ID generation produces unique IDs, `matchesSession` rules tabulated: sender exclusion, `all`, direct match, array form, `role:*` returns false
- `lib/bus-log.test.js` — append under caller-held lock, `appendBatch` writes multiple events in one I/O call, tail-read returning `{ events, endOffset }`, **tailReader handles `fromOffset > fileSize` after compaction (returns `{ events: [], endOffset: fileSize }`)**, same-millisecond appends retrieved in append order via offset, compaction (by age, by count, preserves orphans, rebuilds interest index, does NOT touch bookmarks), bookmark roundtrip with zero initial shape, malformed-line tolerance with endOffset unchanged, dev-mode assertion fires on any call without held lock
- `lib/bus-query.test.js` — urgent filter, `to` matching, TTL-expired interest invisible at read time, dead-session interest invisible at read time, duplicate file_freed collapse within 5 s window, ack lookup
- `lib/interest-index.test.js` — upsert, removeBySession, rebuild from corrupted index, rebuild from log after compaction
- `mcp/session-bind.test.js` — ticket written by fake hook process → MCP server binds on matching ppid; ticket appearing after MCP startup → poll loop succeeds; no ticket after 5 s → unbound mode returns correctly; concurrent bindings on different ppids do not collide; cleanup deletes ticket; **session resume: ticket overwritten with new session_id → MCP server detects change on next tool call and re-binds**
- `mcp/server.test.js` — spawn via stdio, pre-seeded binding ticket, MCP handshake, tool discovery, each tool invocation with bus assertions; unbound-mode tool returns error
- `mcp/file-watcher.test.js` — watcher fires on append, debounced, polling fallback always runs, **mtime skip: unchanged mtime skips lock acquisition**, inert in unbound mode
- `hooks/guard.test.js` extensions — Write blocked → interest event + index update; urgent inbox event → injected with dedupe hash covering combined summary; bookmark advances (offset-based)
- `hooks/heartbeat.test.js` extensions — urgent event delivered on PostToolUse; bookmark advances even on empty-urgent scans; retention compaction ticks; compaction rebuilds interest index
- `hooks/cleanup.test.js` extensions — `session_ended` emitted; interest index entries removed via `removeBySession`; `file_freed` emitted for every interested agent; MCP binding ticket deleted
- `hooks/register.test.js` extensions — MCP binding ticket written under lock; snapshot bypass still fires before bus emission
- **`integration/scavenge-perf.test.js` — 50 expired files × 20 interested agents × session-state removal loop. Assert total wall time under 500 ms; assert no single `withAgentsLock` acquisition held longer than 50 ms**
- `integration/handoff.test.js` — two fake sessions, A sends handoff via `wrightward_send_handoff`, B's next guard invocation injects the handoff, B acks, re-injection suppressed. Additional assertion: recipient receives handoff but NOT a redundant file_freed for the same files
- `integration/file-freed.test.js` — A claims, B blocked (interest recorded + indexed), A releases via cleanup, B's next guard run injects `file_freed`; interest index consistent after release
- `integration/path-dedupe.test.js` — simulate Path 1 (hook run) and Path 2 (MCP watcher) processing the same event concurrently; verify exactly one delivery, bookmark offset consistent afterwards; includes same-millisecond ULID case
- `integration/mcp-binding-race.test.js` — spawn two fake SessionStart hooks with distinct ppids in quick succession, spawn two MCP servers with matching ppids; assert each binds to the correct session

**Phase 2 — channel push**

- `mcp/channel-push.test.js` — mock the MCP `Server.notification()` method, call `channelPush(events)`, assert correct `notifications/claude/channel` frames produced. This is the primary automated test — it verifies the serialization and formatting without needing a real Claude Code session.
- `integration/channel-push.test.js` — spawn MCP server over stdio, perform MCP handshake, append a bus event to test `bus.jsonl`, assert the server calls `notification()` internally (via spy on the Server instance). **Cannot test end-to-end delivery** — Channel notifications require Claude Code running in interactive mode (piped stdin causes the session to exit before notifications fire, confirmed during pre-implementation testing on Windows). End-to-end channel delivery is verified manually per the Phase 2 verification checklist (step 8).

**Phase 3 — bridge + Discord**

- `lib/mirror-policy.test.js` — default policy, overrides, precedence
- `broker/bridge.test.js` — mock Discord REST, append bus events, assert mirror policy → REST calls; first-start seed test; inbound poll test
- `broker/lifecycle.test.js` — start/stop/status, stale PID, log rotation
- `broker/file-watcher.test.js` — same pattern as MCP watcher (with mtime skip)
- `discord/api.test.js` — mock `fetch()`, auth header, rate-limit retry, error handling
- `discord/threads.test.js` — create/rename/archive lifecycle via mocked REST; rate limit honored
- `discord/formatter.test.js`

**Test isolation**

- Fresh tmpdir per test
- `WRIGHTWARD_DATA_DIR` env override per test for Phase 3
- Timeouts: 10 s per unit, 30 s per integration
- Parallel-safe: every test uses its own tmpdir

### Implementation Steps

Phases ship independently. Each step is a single commit.

#### Phase 1 — file-based bus (v3.0.0)

1. Add `package.json` to the plugin root with `@modelcontextprotocol/sdk` as the sole dependency. Run `npm install`. Add `node_modules/` to `.gitignore` if not already present. The SDK is required for `mcp/server.js` (Phase 1) and channel push (Phase 2).
2. Add `lib/bus-schema.js` with tests. Types, validators, ID generation (IDs are stable identifiers, not ordering keys), `matchesSession` export.
3. Add `lib/bus-log.js` with tests. `append`, `tailReader` returning `{ events, endOffset }`, `readBookmark`/`writeBookmark`, `compact` (rebuilds interest index). All functions require caller to hold `withAgentsLock`; dev-mode assertion enforces. Tests cover: same-millisecond appends retrieved in append order via offset, partial-trailing-line skip with endOffset unchanged until compaction, bookmark roundtrip with zero initial shape, dev-mode assertion fires on calls without lock.
4. Add `lib/bus-query.js` with tests. `listInbox` (TTL-aware, collapses duplicate file_freed within 5 s on `(meta.file, to)`), `findInterested` (reads index, filters by agent liveness + TTL), `writeInterest` (appends event + updates index in caller's lock scope), `writeAck`, `matchesSession` re-export.
5. Add `lib/interest-index.js` with tests. `read`/`write`/`upsert`/`removeBySession`/`rebuild`. Rebuild tested with a corrupted index to ensure recovery.
6. Wire retention compaction into `hooks/heartbeat.js` on the existing scavenge cadence. Compaction pass also rebuilds the interest index at the end. Add tests.
7. Add `mcp/session-bind.js` with unit tests. Tests cover: ticket written by fake-hook process → MCP server reads on matching `ppid`; ticket appearing after MCP startup (delayed write) → poll loop finds it; no ticket after 5 s → unbound mode; concurrent bindings with different ppids do not collide.
8. Add `mcp/server.js`, `mcp/capabilities.js`, `mcp/tools.js`. Capabilities are `tools: {}` only (no channel yet). Six tools implemented; each takes the bound session ID from the session-bind module. `list_inbox` supports `mark_delivered` (default true). `send_handoff` skips `file_freed` emission for the recipient. `bus_status` reports `bound_session_id`. Add tests using stdio spawn + pre-seeded binding ticket.
9. Add `mcp/file-watcher.js` with tests. Phase 1: the watcher runs, invokes `bus-query.listInbox` when fired, but the delivery path is a no-op (Phase 2 wires it up). Watcher is inert in unbound mode.
10. Wire the MCP server into `.mcp.json` at plugin root. Update `.claude-plugin/plugin.json` with `mcpServers`. Manual smoke test: `claude --debug` shows the MCP server starting and binding to the session.
11. Extend `hooks/register.js`: write the MCP binding ticket `.claude/collab/mcp-bindings/<process.ppid>.json` under `withAgentsLock`; append `session_started` event to the bus. Add tests covering the ticket write and race-resistance.
12. Extend `hooks/guard.js`: on Write blocked, append an `interest` event via `bus-query.writeInterest` (inside the existing guard lock scope). Fold urgent inbox events into the dedupe-hashed `additionalContext` summary, advancing the per-session bookmark (offset-based). Add tests.
13. Extend `hooks/heartbeat.js`: deliver urgent events via PostToolUse `additionalContext`, advancing the bookmark. Add tests for empty-urgent-but-scanned case (bookmark still advances).
14. Extend `lib/session-state.js`: on every removal path (`removeSessionState`, `scavengeExpiredSessions`, `scavengeExpiredFiles`), look up interested agents via `bus-query.findInterested` (index-backed), collect all `file_freed` events, emit them in one `bus-log.appendBatch` call — everything inside a single `withAgentsLock` scope per removed file. Add tests asserting total lock-hold under 500 ms for 50 files × 20 interested agents.
15. Extend `hooks/cleanup.js`: release claims, call `interest-index.removeBySession(sessionId)`, append `session_ended`, delete the MCP binding ticket. Add tests.
16. Add the four skills (`handoff`, `watch`, `inbox`, `ack`). Each SKILL.md calls into an MCP tool.
17. Extend `lib/config.js` with `bus` section. Add tests.
18. Write integration test: two sessions, handoff via MCP tool, assertions on bus state and injected context. Includes assertion that the recipient gets a handoff event but no redundant file_freed.
19. Write integration test: two sessions, interest + file_freed round trip, including index-file consistency after release.
20. Write integration test: Path 1 dedupe — two path-1 hook runs in quick succession process the same event, only one injects. Also covers the same-millisecond ULID append case.
21. Write integration test: MCP session-binding race — two Claude Code sessions spawn nearly simultaneously, each binds to its own ppid without cross-contamination.
22. Update README: new "Message bus" section, four new skills, backwards-compat statement, documented caveat that session ID is resolved via ppid correlation.

Ship as wrightward 3.0.0. Every existing feature still works; the bus is additive.

#### Phase 2 — channel push (v3.1.0)

23. Add `'claude/channel': {}` to `mcp/capabilities.js`.
24. Add `mcp/channel-push.js`. Wire it into `mcp/file-watcher.js` so new urgent events for the bound session emit `notifications/claude/channel` and advance the bookmark. Add tests.
25. Extend path-dedupe integration test: now Path 1 (hook) and Path 2 (MCP channel push) can race. Verify single delivery, bookmark consistent.
26. Add `channels: [{ server: "wrightward-bus" }]` to `plugin.json`.
27. Integration test: spawn the MCP server over stdio, perform MCP handshake, append a targeted urgent event to `bus.jsonl`, assert `Server.notification()` is called with the correct channel frame (spy-based — cannot test end-to-end delivery because Channel notifications require interactive mode). Manual smoke test per verification step 8.
28. README section: running with `--channels plugin:wrightward@...`, research preview caveat, `--dangerously-load-development-channels` workaround.
29. Document the IDE launch wrapper for the Cursor / VS Code extension. The extension has no direct "extra CLI args" setting, but `claudeCode.claudeProcessWrapper` (documented at `code.claude.com/docs/en/vs-code` as "Executable path used to launch the Claude process") lets users point at a shim that prepends the flag and forwards the remaining args. Ship two wrapper examples in the README:

    - Windows `claude-dev.cmd`:
      ```cmd
      @echo off
      claude --dangerously-load-development-channels plugin:wrightward@<marketplace> %*
      ```
    - POSIX `claude-dev.sh`:
      ```sh
      #!/usr/bin/env sh
      exec claude --dangerously-load-development-channels plugin:wrightward@<marketplace> "$@"
      ```

    Point the user at `claudeCode.claudeProcessWrapper` in VS Code / Cursor `settings.json`, e.g. `"claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\bin\\claude-dev.cmd"`. Caveat to document: set the wrapper only while actively testing Phase 2, otherwise every session unnecessarily loads dev-mode channels. Verify `%*` / `"$@"` argument forwarding end-to-end when writing the README — the setting's forwarding behavior is documented only at the "executable path" level, not explicitly for passed arguments.

Ship as 3.1.0.

#### Phase 3 — Discord bridge daemon (v3.2.0)

29. Add `lib/mirror-policy.js` with default policy + tests. Pure function.
30. Add `broker/lifecycle.js` with tests (PID, log, ready marker, stale detection).
31. Add `broker/bridge-delivery.js` with tests — bridge's own bookmark I/O. First-start seeds to tail; restart resumes from stored bookmark.
32. Add `broker/file-watcher.js` — same pattern as `mcp/file-watcher.js` (with mtime skip), filtering by mirror policy. Tests with a fake sink.
33. Add `discord/api.js` with tests — thin REST wrapper around `fetch()`. Mock `fetch()` in tests; verify auth header, rate-limit retry, error handling.
34. Add `discord/formatter.js` with tests.
35. Add `discord/threads.js` with tests — forum thread lifecycle via REST. Create/rename/archive.
36. Add `broker/bridge.js` — the main daemon loop. Outbound: file-watcher → mirror policy → REST POST. Inbound: poll broadcast channel via REST GET every 3 s → parse @-mentions → write to bus.jsonl. Tests with mocked REST. First-start test: pre-populate bus.jsonl with 100 historical events, assert zero mirroring of history.
37. Add `bin/wrightward` + `bin/wrightward.cmd`. Subcommands: `daemon start|stop|status|logs`, `doctor`.
38. Add `/wrightward:bus` skill. Shells out to `wrightward status`.
39. Add `userConfig.discord_bot_token` to `plugin.json`. Update `lib/config.js` with `discord` section and mirror policy merging.
40. Integration test: bridge daemon + two sessions + mocked Discord REST. Assert outbound mirroring and inbound user_message routing.
41. Update README: Discord setup walkthrough, `wrightward daemon` CLI reference, complementary relationship with stock `discord@claude-plugins-official`, no additional dependencies beyond `@modelcontextprotocol/sdk`.

Ship as 3.2.0.

#### Future (out of scope for this plan)

- Web dashboard transport (planned for v3.3+)
- Telegram, Slack, iMessage transports — follow the same bridge pattern, add a new transport module
- Agent roles (`role:tester`, `role:reviewer`)
- Permission relay (`claude/channel/permission` capability) — straightforward addition in v3.3
- Attachment handling (inbound or outbound Discord attachments)
- Cross-repo coordination
- Formal audit of the Discord transport's security surface (`security-audit` skill pass)

### Discord transport design (Phase 3 detail)

#### User setup flow

1. Create a Discord application + bot in the Discord developer portal, get bot token
2. Create a Discord server with one text channel (broadcast) and one forum channel (agent threads)
3. Add the bot with permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`, `Add Reactions`, `Manage Threads`
4. In Claude Code: `/plugin install wrightward@...` or `/plugin enable wrightward` triggers the `userConfig` prompt for `discord_bot_token`
5. Edit `.claude/wrightward.json`: set `discord.ENABLED: true`, `discord.FORUM_CHANNEL_ID`, `discord.BROADCAST_CHANNEL_ID`, `discord.ALLOWED_SENDERS`
6. `wrightward daemon start` — bridge connects via REST API (no `discord.js` install needed), creates threads for any currently-active agents
7. Verify with `wrightward doctor`

**Complementary with stock `discord@claude-plugins-official` plugin**: the stock plugin handles direct user→agent DM messaging per session (one bot DM → one session). wrightward's bridge adds multi-agent observability: thread-per-agent forum, broadcast @-mention routing, bus event mirroring. Users can install both — the stock plugin on individual sessions for DM interaction, plus wrightward's bridge for the shared dashboard. They can share the same bot token because the stock plugin uses the Discord gateway while the bridge uses only REST API (no gateway conflict).

#### Thread model

- One Discord forum channel holds all agent threads
- Bridge maintains a bidirectional `agentId ↔ threadId` map in `.claude/collab/bus-index/discord-threads.json`
- On `session_started` bus event: bridge creates a thread titled `<displayName> (<shortId>)` where `displayName` comes from the agent's collab-context task (or session ID if none declared)
- On collab-context updates (observable via existing context file timestamps — bridge tails them on the same watcher), thread is renamed if `THREAD_RENAME_ON_CONTEXT_UPDATE: true`. Rate-limited to 2 renames/10 min per Discord's own limits
- On `session_ended` or scavenge: thread archived, not deleted

#### Broadcast channel model

- One text channel for broadcasts: session starts/ends, broadcast handoffs, user announcements
- Messages with `@agent-<name>` parsed, routed as `user_message` targeted at that agent
- Messages without mentions routed as `user_message` with `to: "all"` and `meta.broadcast: true`
- Bot replies always post into the responding agent's thread, not back into the broadcast channel

#### Mirror policy

```js
const DEFAULT_POLICY = {
  user_message:    { action: 'post_thread', severity: 'info' },
  reply:           { action: 'post_thread', severity: 'info' },
  handoff:         { action: 'post_thread', severity: 'info' },
  blocker:         { action: 'post_thread', severity: 'warn' },
  file_freed:      { action: 'post_thread_if_targeted', severity: 'info' },
  session_started: { action: 'post_broadcast', severity: 'info' },
  session_ended:   { action: 'post_broadcast', severity: 'info' },
  note:            { action: 'silent' },
  finding:         { action: 'silent' },
  decision:        { action: 'silent' },
  status:          { action: 'silent' },
  interest:        { action: 'never' },
  ack:             { action: 'never' },
  delivery_failed: { action: 'never' },
  rate_limited:    { action: 'never' }
};
```

User overrides merge on top; first match wins. `post_thread_if_targeted` only posts to the thread of the agent in the `to` field.

#### Rate limits

Discord: 5 messages / 5 s per channel. Bridge uses a leaky bucket per destination.

- Identical messages within 2 s coalesce to "+N similar"
- Bursts beyond cap queue up to 500; overflow drops oldest with a `rate_limited` meta-event appended to the bus

#### Security

- Bot token stored only in keychain via `userConfig.sensitive: true`
- Inbound messages gated by `discord.ALLOWED_SENDERS` (Discord user IDs). Defaults to empty → send-only until user explicitly allows
- All inbound content treated as untrusted: the bridge wraps user content in quoted-safe form before writing to `bus.jsonl` (never raw concatenation into any shell context — the bus is JSON)

#### Attachment handling

Out of scope for v3.2. Inbound attachments logged as a warning and dropped.

## Risks

- **`@modelcontextprotocol/sdk` is a runtime dependency.** wrightward was previously zero-dep. The MCP SDK is required — there is no way to implement MCP tools or Channel push without it, and reimplementing the JSON-RPC protocol would be fragile and wasteful. The SDK is maintained by Anthropic and is the canonical way to build MCP servers. Mitigation: it is the *only* dependency; `package.json` is minimal; `node_modules/` is gitignored.

- **Channels feature is a research preview** (Phase 2 dependency). Mitigation: Path 1 is the permanent first-class fallback. Users without Channels still get a working plugin via next-tool-call injection. Document preview status.

- **Channel push cannot be tested end-to-end in automation.** Claude Code exits immediately when stdin is piped (non-interactive), so Channel notifications never fire in a test harness. Confirmed during pre-implementation testing on Windows. Mitigation: Phase 2 automated tests verify that `Server.notification()` is called with correct frames (spy-based). End-to-end delivery is verified manually per the verification checklist. Path 1 (hook injection) is fully automatable and is the permanent fallback.

- **Allowlist blocks `--channels plugin:wrightward`** until Anthropic approval. Mitigation: document `--dangerously-load-development-channels plugin:wrightward@<marketplace>` workaround. Submit for allowlist after Phase 2 stabilizes.

- **Bus append partial write from a hard-killed process**. Callers hold `withAgentsLock` for every append, so concurrent writers cannot interleave — the only partial-write case is SIGKILL mid-`write(2)`. Reader skips the malformed line, logs to stderr, and retention compaction rewrites the file on the next scheduled pass.

- **`fs.watch` unreliability across platforms** (Phase 1+). Windows in particular has known quirks (missed events, inconsistent payloads). Mitigation: the watcher always runs a 1 s polling fallback alongside `fs.watch` — not a failover, always-on. Tests cover both paths.

- **Inbox scan cost on busy repos**. Tail scan of `bus.jsonl` from `bookmark.lastScannedOffset` on every tool call. At the 10k retention cap with small events, worst case is ~5 MB if the bookmark is near the head; typical case is <10 KB. Mitigation: retention compaction keeps the file bounded; the bookmark advances on every scan (including empty-urgent scans) so re-reads are incremental.

- **Release-path scan cost on busy repos**. `findInterested(file)` is called from `scavengeExpiredFiles` for every released file per heartbeat tick. Mitigation: `bus-index/interest.json` provides O(1) lookup. Updated under `withAgentsLock` on every interest write and every session cleanup. Integration test covers 50 expired files × 20 interested agents to confirm total lock-hold fits the 5 s staleness recovery window.

- **MCP server cannot learn its session ID from Claude Code's env**. Verified against `code.claude.com/docs/en/plugins-reference` — Claude Code exposes only `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CLAUDE_PLUGIN_OPTION_<KEY>` to plugin MCP subprocesses. No session substitution exists. Mitigation: `mcp/session-bind.js` implements a `process.ppid`-based ticket mechanism — SessionStart hook and MCP server share the same Claude Code parent, so they correlate on parent PID. If binding fails within 5 s, the MCP server enters "unbound" mode and hooks still function. The binding module is isolated so a future Claude Code release exposing `${CLAUDE_SESSION_ID}` can replace it wholesale without touching the rest of the plugin.

- **TOCTOU on interest registration**. When B's Write is blocked, guard.js appends `interest`. A could release the file between the block decision and the interest append. Mitigation: both the block decision and the interest append run inside the same `withAgentsLock` critical section — no interleaving window. After appending interest, if the file is no longer claimed by any active agent (check is same-section), immediately append `file_freed` targeted at this session.

- **Duplicate `file_freed` events under racing releases**. Two release paths could emit the same `file_freed`. Mitigation: `file_freed` events dedupe within a 5 s window on `(meta.file, to)` at read time — `bus-query.js:listInbox` collapses duplicates. Additionally, `wrightward_send_handoff` does not emit `file_freed` to the handoff recipient (recipient learns via the handoff event itself).

- **Stale interests after session death**. Mitigation: `cleanup.js` calls `interest-index.removeBySession(sessionId)` inside the same `withAgentsLock` scope as `removeAgent`. `scavengeExpiredSessions` does the same. `findInterested` checks that the session still exists in `agents.json` — if the session is dead, its interests are invisible. SIGKILL edge case (dies between agent removal and index cleanup): the index has an orphan entry; next compaction rebuilds it; in between, one extra harmless `file_freed` (already handled by the 5 s dedupe).

- **Model edits to `.claude/collab/bus.jsonl`** would corrupt the log. Mitigation: the existing hard block in `guard.js:164-176` already applies unconditionally to the entire collab dir. No change needed.

- **Malicious or buggy agent spams the bus**. The model's only write path is via MCP tools (gated by MCP server logic) and hook-triggered appends (1 per tool call at most). There is no external writer population, and the model cannot exceed its own tool-call cadence. No dedicated rate limiter — retention compaction bounds disk regardless. If this proves insufficient, add a leaky-bucket on `.claude/collab/bus-rate/<sessionId>.json` under `withAgentsLock` (does NOT rely on per-process memory, since hook subprocesses have none).

- **Phase 3: bot token compromise via logging**. Mitigation: all log writes pass through a redactor that scrubs anything matching Discord token shape. Keychain storage; never written to `wrightward.json`.

- **Phase 3: bridge daemon as a user-managed process**. Mitigation: `wrightward doctor` detects stale PID, missing `${CLAUDE_PLUGIN_DATA}` subdirs. `daemon status` shows last 20 log lines on crashes.

- **Phase 3: Windows line-ending / path handling in `bin/wrightward`**. Mitigation: ship `bin/wrightward.cmd` wrapper; all internal paths use `path.join`.

- **Phase 3: Discord REST API rate limits**. The bridge posts messages via REST, which is subject to Discord's per-route rate limits (5 msg/5s per channel). Mitigation: `discord/api.js` reads `X-RateLimit-*` response headers and backs off automatically. Burst protection via the mirror policy's leaky bucket per destination.

- **Phase 3: bridge bookmark behavior on restart AND first start**. On daemon restart with an existing `bus-delivered/bridge.json`, the bridge resumes from where it left off. On **first-ever start** (no bridge.json present), the bridge seeds its bookmark to the current tail of `bus.jsonl` (`lastScannedOffset = lastDeliveredOffset = current file size`) rather than reading from offset 0 — otherwise it would mirror every historical event in the log to Discord on a fresh install. After seeding, it emits a single `daemon_started` event for the audit trail. Verification: `broker/bridge.test.js` first-start test with a pre-populated bus.jsonl asserts that no mirroring happens for historical events, only for events appended after startup.

## Decisions locked in this plan

- **Architecture**: file-based for Phases 1 and 2. No daemon, no IPC, no CLI. The bus is `.claude/collab/bus.jsonl`, `.claude/collab/bus-delivered/<sessionId>.json`, and `.claude/collab/bus-index/interest.json`. Hooks and the per-session MCP server are the only Phase 1 actors.
- **Phase 3 daemon scope**: exactly one process whose only job is the Discord bridge. Not a router. Reads and writes the bus the same way every other process does.
- **Library module count**: four (`bus-schema`, `bus-log`, `bus-query`, `interest-index`). Mirror policy lives in `lib/mirror-policy.js` and ships in Phase 3.
- **Skill count Phase 1**: four (`handoff`, `watch`, `inbox`, `ack`). No `bus` skill until Phase 3.
- **Locking policy**: callers hold `withAgentsLock` for every bus-log and bus-query operation. No bus-log function acquires the lock internally — composable by design. Dev-mode assertion enforces this.
- **Ordering key**: **byte offset into `bus.jsonl`**, not event ID. ULIDs are stable identifiers for audit/debug; they are NOT sort keys. Every bookmark comparison and every dedupe check uses `lastDeliveredOffset`.
- **MCP session binding**: `process.ppid` correlation via `mcp/session-bind.js`. Isolated in one small module so a future Claude Code release exposing `${CLAUDE_SESSION_ID}` can replace it without touching the rest of the plugin.
- **Delivery dedupe**: per-session offset bookmark file, updated under `withAgentsLock`. Semantic acks remain as bus events and serve only their audit purpose.
- **Runtime dependency**: `@modelcontextprotocol/sdk` is the sole runtime dependency, required for the MCP server. A `package.json` is added to the plugin root. Phase 3 Discord transport uses built-in `fetch()` — no `discord.js`, no additional dependencies.
- **MCP tool namespace**: `wrightward_*` prefix for all six tools. `list_inbox` advances the bookmark by default (`mark_delivered: true`).
- **`send_handoff` suppresses redundant `file_freed`** to the handoff recipient (they learn via the handoff event itself). Other interested agents still receive `file_freed`.
- **Retention defaults**: 7 days OR 10,000 events, whichever keeps more. Compaction rebuilds `bus-index/interest.json`.

## Open questions

The following ride defaults unless the user says otherwise:

1. **`/wrightward:handoff` auto-releases the files in `files_unlocked`.** Default: yes. Handing off a file is the idiomatic way to release it.
2. **`file_freed` emission happens in `lib/session-state.js`.** Default: yes. Every removal path goes through session-state, and that's the right leverage point. Alternative (emitting from hooks only) would miss scavenges.
3. **Version bump**: wrightward 2.3.2 → **3.0.0** for Phase 1. New MCP server, new state files, new skills — semver-major warranted.
4. **`bus.ENABLED` default**: true. The bus is the headline Phase 1 feature; making it opt-in would hurt adoption and serves no one. Users who want to fully disable the plugin set `ENABLED: false` at the top level.
5. **MCP session binding uses `process.ppid` correlation** until Anthropic ships a documented `${CLAUDE_SESSION_ID}` substitution or equivalent env var. Track Claude Code release notes; replace `mcp/session-bind.js` wholesale when a supported mechanism exists. Submit a feature request referencing this plan.

## Verification

**After Phase 1 (3.0.0):**

1. Backwards-compat: with `bus.ENABLED: false` in `wrightward.json`, all existing tests pass unchanged.
2. Bus basics: `node --test test/lib/bus-*.test.js test/lib/interest-index.test.js test/mcp/*.test.js` passes.
3. Hook integration: `node --test test/hooks/**/*.test.js test/integration/**/*.test.js` passes.
4. Scavenge perf: `test/integration/scavenge-perf.test.js` completes under 500 ms wall with no lock acquisition >50 ms.
5. Two-session handoff smoke test: start two Claude Code sessions in the same repo. Session A: `/wrightward:collab-context` claiming `src/foo.js`. Session B: run `/wrightward:handoff <A_session_id> "continue the work"` (A's ID from `/wrightward:inbox` or `agents.json`). Verify A's next tool call surfaces the handoff in an additionalContext block. Verify A does NOT see a redundant `file_freed` for the handed-off files.
6. File-freed smoke test: A claims `src/foo.js`. B tries to write it, is blocked (stderr confirms). A runs `/wrightward:collab-release`. B's next tool call surfaces "src/foo.js is now free."
7. Session-binding smoke test: `claude --debug` shows the MCP server starting and binding to the expected session ID (stderr log line: `[wrightward-mcp] bound to session <id> via ppid <n>`). Kill the MCP server; verify it rebinds on restart via the same ticket file. Run two concurrent Claude Code sessions in the same repo; verify each MCP server binds to its own session (no cross-contamination visible in `/wrightward:inbox` output).

**After Phase 2 (3.1.0):**

8. Repeat the handoff smoke test (Phase 1 step 5) with the second session started via `claude --dangerously-load-development-channels plugin:wrightward@<marketplace>`. Verify the target session wakes between turns and processes the handoff *without* a new user prompt.
9. Verify Path 1 / Path 2 race integration test passes.

**After Phase 3 (3.2.0):**

10. Configure Discord bot token via `userConfig`, enable in wrightward.json, `wrightward daemon start`. No npm install needed — bridge connects via REST immediately. Verify `bridge.ready` marker.
11. First-start seed test: with existing bus.jsonl containing 100 historical events, start bridge — verify no Discord posts for historical events.
12. Smoke test: start two Claude Code sessions. Verify two threads appear in the Discord forum channel, named after each agent's task.
13. Send `@agent-<a> run the test suite` in the broadcast channel. Verify only session A's inbox receives it (via `/wrightward:inbox` or on next tool call).
14. Session A replies via a bus event. Verify the reply posts to A's Discord thread.
15. `wrightward daemon stop` exits cleanly; `bridge.ready` removed, PID file removed.
16. Complementary test: install stock `discord@claude-plugins-official` on one session alongside wrightward bridge. Verify DM→session works via stock plugin while wrightward bridge mirrors bus events to forum threads. No conflicts.

## Out of scope

- Web dashboard transport
- Telegram, Slack, iMessage transports
- Agent roles mechanism
- Discord permission relay via `claude/channel/permission`
- Attachment handling (Discord in/out)
- Cross-repo coordination (multiple brokers, multiple project roots)
- Migration tooling — the bus is strictly additive, no migration needed
- Automated Discord bot creation
- Changes to existing `collab-context`, `collab-release`, `collab-done` skills — they keep working as-is
- `agentwright` integration beyond regression verification
- Subagent coordination (wrightward is about peer top-level sessions)
- Formal security audit of the Discord transport before Phase 3 ship — handled separately via the `security-audit` skill
