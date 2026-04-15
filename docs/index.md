# toolwright — Claude Code plugins

Three zero-config [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins, shipped from one marketplace:

| Plugin | What it does |
|---|---|
| [agentwright](#agentwright) | Automated code audits that find and fix bugs, security issues, and bad practices. Also includes skills for planning, debugging, and testing. Run `/audit-run` and it does the rest. |
| [wrightward](#wrightward) | Multi-agent coordination — when two or more Claude Code sessions work in the same repo, wrightward blocks conflicting writes, injects awareness context, and gives the sessions a peer-to-peer message bus (with seven MCP tools) to hand off tasks, watch files, and wake each other up. Ships with an optional Discord bridge. |
| [timewright](#timewright) | Undo for Claude's in-session source file changes — including Bash-driven mutations (file deletions, sed rewrites, git operations) that native `/rewind` misses. Type `/undo` to revert. |

All three plugins are independent. Install any subset.

## Installation

Run inside any Claude Code session:

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

Or run `/plugin` and browse the **Discover** tab.

### Requirements

- Node.js ≥ 18 (all three plugins)
- Git (timewright uses git plumbing for snapshots; wrightward expects a git repo)
- Claude CLI on `PATH` — required for agentwright's headless auditor subprocess
- A Discord bot token — only if you want wrightward's optional Discord bridge

### Using them together

The three plugins are independent but aware of each other:

- During an audit, if wrightward signals that another agent is working on a file, agentwright skips that finding and revisits it on the next poll.
- When an audit finishes, it automatically runs `/wrightward:collab-done` to release file claims if other agents are active.

---

## agentwright

> Chained audit pipelines with a spawned auditor and in-session verification/fixes. Run `/audit-run` and a headless subprocess audits a frozen snapshot of your code while the current session independently verifies each finding and applies fixes on the live repo. Turns AI slop into beautiful working code.

**Version**: 1.7.2 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/agentwright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/README.md)

### Setup

Everything you need to get agentwright working, in order.

#### 1. Prerequisites

- **Node.js ≥ 18** (the coordinator and auditor processes are Node scripts).
- **Claude CLI** (`claude`) on your `PATH`. agentwright spawns a `claude -p` subprocess as the headless auditor; if `claude` isn't on `PATH`, audits will fail to start.
- **A `.gitignore`** that excludes large non-source files (datasets, binaries, virtual environments). The auditor snapshots the working tree before each stage group — large untracked files slow this down.

#### 2. Add the marketplace and install the plugin

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install agentwright@Joys-Dawn/toolwright
```

No additional configuration is required. agentwright's commands are registered automatically via the plugin manifest.

#### 3. Optional: create `.claude/agentwright.json` to customize pipelines and retention

All fields are optional. Only include what you want to override. See [`agentwright.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/agentwright.example.json) for a full example.

```json
{
  "pipelines": {
    "default": ["correctness", "security", "best-practices"],
    "full": ["correctness", "security", "best-practices", ["migration", "ui"], "test-coverage"]
  },
  "customStages": {
    "perf": { "type": "skill", "skillId": "performance-investigation" },
    "my-checks": { "type": "skill", "skillPath": "skills/my-custom-audit/SKILL.md" }
  },
  "retention": {
    "keepCompletedRuns": 2,
    "deleteCompletedLogs": true,
    "deleteCompletedFindings": false,
    "maxRunAgeDays": 2
  }
}
```

#### 4. Verification

Run an audit on a repo with changes:

```text
/audit-run
```

Expected output:

1. A JSON line with the run ID.
2. The auditor subprocess starts; the session polls every 60 seconds.
3. After 1–several minutes, findings stream back and each is independently verified.
4. A summary table is printed when the run completes.

If the auditor never produces findings, confirm `claude` is on `PATH` and that the working tree has changes in the default scope (staged + unstaged `git diff`).

### Functionality

Every command, skill, agent, and hook agentwright ships with.

#### Slash commands

Seven commands, all under the plugin's `/` namespace (no prefix required because they live in `commands/`, not as skills).

| Command | Args | What it does |
|---|---|---|
| `/audit-run` | `[pipeline\|stages] [scope]` | Run the default or a named pipeline. With no args, runs `correctness → security → best-practices` on `git diff`. |
| `/audit-step` | `<stage> [scope]` | Run a single audit stage on the given scope. |
| `/audit-resume` | `<run-id>` | Resume an interrupted run from the next incomplete stage. |
| `/audit-status` | `[run-id]` | Show current run state: active/completed/pending stages, verification progress. With no run-id, lists all runs. |
| `/audit-stop` | `[run-id]` | Kill all worker/auditor processes for an active run and mark it cancelled. Auto-detects the active run if omitted. |
| `/audit-reset` | `[run-id]` | Guided instructions for deleting a run directory under `.claude/audit-runs/<run-id>/`. Asks for confirmation. |
| `/audit-clean` | `[--logs-only]` | Clean retained artifacts (stage logs, findings files, pruned completed runs) per the retention policy. |

Concrete invocations:

```text
/audit-run                              # default pipeline on git diff (staged + unstaged)
/audit-run src/api/                     # default pipeline on a directory
/audit-run full --diff                  # named pipeline on git diff
/audit-run correctness,security src/    # comma-separated stage list on a directory
/audit-step security src/auth/          # single stage on a directory
/audit-resume 2026-04-15-abc123         # resume a specific run
/audit-clean --logs-only                # keep findings, drop the log noise
```

#### How audits work

1. A frozen snapshot of the codebase is created (`.gitignore`-aware).
2. A headless `claude -p` subprocess audits the snapshot using a vendored or custom skill.
3. Findings stream back as newline-delimited JSON.
4. The current session independently verifies each finding against the live repo — auditor claims are never blindly trusted.
5. Objectively correct fixes are applied immediately; judgment calls are deferred for user approval.
6. After all stages complete, the [verifier agent](#agents-5) validates the applied fixes.
7. A per-finding summary table is presented with every finding's disposition.

**Default pipeline** (no pipeline specified): `correctness → security → best-practices`
**Default scope** (no scope specified): files changed in `git diff` (staged + unstaged)

##### Pipeline rules

- String entries run sequentially — each stage must complete before the next starts.
- Nested arrays (`["a", "b"]`) run as a **parallel group** — all stages in the group audit the same snapshot concurrently. Use for independent audits (e.g., UI and test coverage).
- After a group completes and fixes are applied, the next group gets a fresh snapshot of the now-fixed repo.
- Duplicate stage names are automatically suffixed (`correctness` → `correctness-2`).

##### Fix vs defer policy

During an audit, fixes are applied only when **objectively correct** — any competent reviewer would agree with no meaningful tradeoff. This covers bugs, security flaws, naming, dead code, and clean-code improvements alike.

Judgment calls, style preferences, large refactors, and architectural opinions are marked `valid_needs_approval` and presented to the user after the run. **Nothing deferred is implemented without explicit approval.**

##### Custom stages

Reference a builtin skill by `skillId` or a project-relative SKILL.md by `skillPath`. Only needed when defining your own audit stages — the vendored audit skills are available by name without any configuration.

##### Retention

Controls cleanup of completed runs. Defaults: keep 2 runs, prune after 2 days, delete logs, keep findings. Override via the `retention` key in `.claude/agentwright.json`.

#### Skills (21)

Skills are auto-discovered from `agentwright/skills/` and invocable as `/agentwright:<name>` or via the `Skill` tool. They are grouped by role below.

##### Audit skills (used by the pipeline)

| Skill | Focus |
|---|---|
| `/agentwright:correctness-audit` | Logic errors, null handling, async races, type coercion, resource leaks, N+1 queries. |
| `/agentwright:security-audit` | OWASP Top 10 2025, OWASP API Security Top 10 2023, CWE, GDPR, PCI-DSS. |
| `/agentwright:best-practices-audit` | DRY, SOLID, KISS, YAGNI, Clean Code, naming, coupling, anti-patterns. |
| `/agentwright:migration-audit` | PL/pgSQL: NULL traps, race conditions, missing constraints, JSONB pitfalls. Auto-triggers when a `supabase/migrations/*.sql` file is written or modified. |
| `/agentwright:implementation-audit` | Roundabout solutions, unnecessary complexity, reinvented wheels, naive designs that ignore established patterns. |
| `/agentwright:ui-audit` | WCAG 2.2 accessibility, WAI-ARIA patterns, touch target sizing, focus management, component anti-patterns (React/Tailwind). |
| `/agentwright:test-coverage-audit` | Maps source files against tests, produces a risk-prioritized list of coverage gaps. |

##### Planning skills

| Skill | Focus |
|---|---|
| `/agentwright:feature-planning` | Impact analysis, requirements, design, implementation steps, risk assessment for a proposed feature. |
| `/agentwright:project-planning` | Stack selection, directory structure, tooling, and scaffolding for greenfield projects in an empty directory. |
| `/agentwright:bug-fix-planning` | Root cause mapping, change impact, minimal fix, regression tests for a confirmed bug. |
| `/agentwright:refactor-planning` | Blast radius mapping, safe transformation sequence, behavior-preservation verification. |

##### Debugging

| Skill | Focus |
|---|---|
| `/agentwright:systematic-debugging` | Reproduce, isolate, hypothesize, verify — evidence-based root-cause analysis. |

##### Test-writing skills

Typically invoked by the main agent after `test-coverage-audit` identifies gaps.

| Skill | Focus |
|---|---|
| `/agentwright:write-tests` | General test quality: assertions, isolation, flakiness, over-mocking. Any language/framework. Defers to the domain-specific skills below when applicable. |
| `/agentwright:write-tests-frontend` | React component/hook tests with Vitest + React Testing Library. |
| `/agentwright:write-tests-deno` | Deno integration tests for Supabase Edge Functions. |
| `/agentwright:write-tests-pgtap` | pgTAP database tests for Supabase SQL migrations. |

##### Agent-shortcut skills

Thin wrappers that invoke the built-in agents. Use `/agentwright:<name>` instead of typing the full `@agent-agentwright:<agent>` mention.

| Skill | Underlying agent | Pattern |
|---|---|---|
| `/agentwright:research <topic>` | deep-research | Forked — self-contained topic |
| `/agentwright:update-docs [scope]` | update-docs | Forked — infers from git diff |
| `/agentwright:critique [focus]` | party-pooper | Forked — reads session transcript |
| `/agentwright:verify [focus]` | verifier | Forked — reads session transcript + git diff |
| `/agentwright:challenge [claim]` | detective (×2) | Inline — dispatches two detectives with opposing hypotheses |

#### Agents (5)

Five built-in subagents. All are invokable directly as `@agent-agentwright:<name>` or through the shortcut skills above.

| Agent | What it does | Tool permissions |
|---|---|---|
| **detective** | Investigates a hypothesis about code or API behavior — traces logic, reads files, runs tests, reports evidence. Used by `/agentwright:challenge` to independently verify disputed claims. | Read-only + research MCP tools + Bash for tests. No Edit/Write/NotebookEdit. |
| **verifier** | Validates applied fixes: implementations exist, tests pass, no unstated changes were made. Dispatched automatically after audit fixes. | Read-only + Bash for tests. No Edit/Write/NotebookEdit. |
| **deep-research** | Web search and literature review with synthesis. Uses Exa, Context7, AlphaXiv, Scholar Gateway, Hugging Face, PubMed, bioRxiv, and other research MCPs in parallel. | Read-only. No Bash/Edit/Write/NotebookEdit. |
| **party-pooper** | Adversarial critique of ideas, plans, claims, or proposals. Runs parallel searches for counter-evidence across academic, web, and docs sources. | Read-only + research MCPs. No Edit/Write/NotebookEdit. |
| **update-docs** | Keeps project documentation in sync with code. Only edits `.md` files — a scoped `PreToolUse` hook ([`hooks/md-only-edit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/hooks/md-only-edit.js)) blocks writes to any other file. | `.md` files only. No Bash/NotebookEdit. |

All agents run with `permissionMode: dontAsk` — they don't prompt the user for every permission because they either can't modify files at all or are tightly scoped.

#### Hooks

agentwright registers one hook, and it's **scoped to the `update-docs` agent** via the agent's frontmatter `hooks` field — not a plugin-level hook.

| Hook | Scope | Event | What it does |
|---|---|---|---|
| [`md-only-edit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/agentwright/hooks/md-only-edit.js) | update-docs agent only | `PreToolUse` on `Edit\|Write` | Blocks any Edit or Write where `tool_input.file_path` does not end in `.md`. Exits with code 2 and a message so the agent sees the block. |

No other hooks run unless you invoke the update-docs agent.

#### Configuration reference

All keys live under `.claude/agentwright.json`. All are optional.

| Key | Default | Description |
|---|---|---|
| `pipelines.default` | `["correctness", "security", "best-practices"]` | Default pipeline for `/audit-run` with no pipeline argument. |
| `pipelines.<name>` | — | Named pipeline. Value is an array of stage names or nested arrays for parallel groups. |
| `customStages.<key>.type` | `"skill"` | Kind of custom stage. Currently only `"skill"`. |
| `customStages.<key>.skillId` | — | Refer to a builtin skill by ID. |
| `customStages.<key>.skillPath` | — | Refer to a project-relative `SKILL.md`. |
| `retention.keepCompletedRuns` | 2 | How many completed runs to retain. |
| `retention.deleteCompletedLogs` | true | Delete stage log folders for completed runs. |
| `retention.deleteCompletedFindings` | false | Delete per-finding JSON for completed runs. |
| `retention.maxRunAgeDays` | 2 | Prune completed runs older than this. |

#### State

Audit state lives at `.claude/audit-runs/<run-id>/` inside your project. Each run directory contains:

- `findings/` — per-finding JSON files as they stream in from the auditor.
- `logs/` — per-stage auditor subprocess logs.
- `group-<N>-snapshot.json` — path to the frozen snapshot used for each parallel group (consumed by the verifier).
- Run metadata for `/audit-status` and `/audit-resume`.

---

## wrightward

> Multi-agent coordination and message bus for Claude Code. When multiple Claude Code sessions work in the same repo, wrightward prevents them from silently overwriting each other's work and gives them a peer-to-peer message bus to hand off tasks, watch files, and wake each other up.

**Version**: 3.6.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/wrightward) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/README.md)

### Setup

Start-to-finish: base install, optional channel push, and the optional Discord bridge.

#### 1. Prerequisites

- **Node.js ≥ 18** — the plugin, hook scripts, and bundled MCP server are all Node.
- **A git repository** — wrightward's state lives at `<repo-root>/.claude/collab/`. Non-git directories aren't fully supported.
- The single runtime dependency — `@modelcontextprotocol/sdk` — is bundled inside the plugin's `node_modules/`. Nothing to install separately.

#### 2. Add the marketplace and install the plugin

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install wrightward@Joys-Dawn/toolwright
```

No configuration is required. File-coordination hooks activate automatically on session start.

#### 3. Recommended permissions

Skip consent dialogs on wrightward's skills and MCP tools by adding these to your **global** `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Skill(wrightward:collab-context)",
      "Skill(wrightward:collab-done)",
      "Skill(wrightward:collab-release)",
      "mcp__wrightward-bus__*"
    ]
  }
}
```

The `mcp__wrightward-bus__*` entry auto-allows every wrightward MCP tool. This matters when using Channels (see next section): after a wake-up ping, the model typically calls `wrightward_list_inbox` immediately — if that call hits a permission prompt, the wake-up flow stalls.

#### 4. Verify base install

1. Open Claude Code in a git repo.
2. Edit a file. A `.claude/collab/` directory appears at the repo root with:
    - `agents.json` — your session registration
    - `context/`, `context-hash/` — per-session task/file claims
    - `mcp/` — MCP binding tickets
    - `bus.jsonl` — the append-only event log
    - `bus-delivered/`, `bus-index/` — delivery bookmarks and derived indices
3. Open a second Claude Code session in the same repo. Try to Edit the file the first session is working on. The write is blocked with a message showing who owns the file.

If `.claude/collab/` doesn't appear, check that you're in a git repo and that wrightward is installed (`/plugin` should list it).

#### 5. Optional — enable channel push (v3.1 research preview)

By default, wrightward delivers urgent events through **Path 1**: the guard/heartbeat hooks inject pending events as `additionalContext` on the session's next tool call. Path 1 is always-on and authoritative.

**Path 2** adds a `notifications/claude/channel` doorbell so idle sessions wake between turns. Requires **Claude Code ≥ 2.1.80**. This path is gated behind Anthropic's research-preview allowlist. Until wrightward is approved, use the `server:` workaround:

1. Add the server to your **user-level** `~/.mcp.json`:

    ```json
    {
      "mcpServers": {
        "wrightward-bus": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/.claude/plugins/cache/<marketplace>/wrightward/<version>/mcp/server.mjs"]
        }
      }
    }
    ```

2. Launch Claude Code with the development flag:

    ```text
    claude --dangerously-load-development-channels server:wrightward-bus
    ```

    Expected banner: *"Listening for channel messages from: server:wrightward-bus"*. If you see "not on the approved channels allowlist", you used `plugin:` instead of `server:` — switch.

##### VS Code / Cursor wrapper

The Claude Code VS Code / Cursor extension (both IDEs read the same setting key) respects [`claudeCode.claudeProcessWrapper`](https://code.claude.com/docs/en/vs-code) — an executable that wraps the `claude` binary and can prepend CLI args. Step 1 above (user-level `~/.mcp.json`) is still required; the wrapper only handles the dev flag.

1. Save a wrapper script anywhere on disk. A typical location is `%USERPROFILE%\bin\` on Windows or `~/bin/` on POSIX — but the path is arbitrary, just point `settings.json` at wherever you save it.

    === "Windows (`claude-dev.cmd`)"
        ```cmd
        @echo off
        claude --dangerously-load-development-channels server:wrightward-bus %*
        ```

    === "POSIX (`claude-dev.sh`)"
        ```sh
        #!/usr/bin/env sh
        exec claude --dangerously-load-development-channels server:wrightward-bus "$@"
        ```

2. On POSIX, make the wrapper executable: `chmod +x ~/bin/claude-dev.sh`. (Windows `.cmd` files don't need this.)

3. Point the extension at the wrapper in `settings.json` (User settings, so every workspace picks it up — or Workspace settings to scope it per-repo):

    === "Windows"
        ```json
        { "claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\bin\\claude-dev.cmd" }
        ```

    === "POSIX"
        ```json
        { "claudeCode.claudeProcessWrapper": "/home/<you>/bin/claude-dev.sh" }
        ```

4. Reload the IDE window. On next session start, look for the *"Listening for channel messages from: server:wrightward-bus"* banner — same verification as the CLI path.

#### 6. Optional — enable the Discord bridge (v3.2)

The bridge is an opt-in subprocess that mirrors bus events to Discord in near-real-time. REST-only — no gateway — so it **coexists with the stock `discord@claude-plugins-official` plugin on the same bot token**.

##### Step-by-step

1. **Create a Discord application and bot** at <https://discord.com/developers/applications>.
    - Click **New Application**, name it, then go to the **Bot** tab and click **Add Bot**.
    - Under **Token**, click **Reset Token** and copy the token (you'll only see it once). Keep it secret — it's the credential the bridge will authenticate with.
    - **Turn on Message Content Intent.** Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and toggle **Message Content Intent (MCI)** *on*. Without MCI, Discord strips the body from every message your bot reads, which breaks `@agent-<id>` mentions in the broadcast channel (they need the body to identify the target) and makes thread replies arrive with an empty body. The bridge will still route thread replies to the thread owner without MCI, but no content will come through. Effectively, enable MCI — it's the only toggle that gates inbound content.
2. **Invite the bot to your server.** In the developer portal, go to **OAuth2 → URL Generator**.
    - Scopes: `bot`
    - Bot permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Manage Threads`, `Read Message History` (`Create Public Threads` is **not** required — Discord gates forum-thread creation on `SEND_MESSAGES` alone).
    - Open the generated URL in a browser and add the bot to a server you own.
3. **Create channels** in your Discord server:
    - One **forum channel** — wrightward will create one thread per agent here.
    - One **text channel** — the shared broadcast feed.
4. **Enable Developer Mode in Discord** (User Settings → Advanced → *Developer Mode* on). With it on, you can right-click channels, users, and messages to **Copy ID**. You'll need:
    - The **forum channel ID** (for `FORUM_CHANNEL_ID`).
    - The **broadcast text channel ID** (for `BROADCAST_CHANNEL_ID`).
    - Your **own Discord user ID** (for `ALLOWED_SENDERS` — right-click your name anywhere in Discord → *Copy User ID*).
5. **Install the plugin and provide the bot token.** Run `/plugin install wrightward@Joys-Dawn/toolwright`. Per [the Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference#user-configuration), userConfig fields are "prompted at enable time" — so the first time wrightward is enabled, Claude Code asks for the `discord_bot_token`. Paste it. The field is declared `sensitive: true` in [`plugin.json`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/.claude-plugin/plugin.json), so on platforms with an OS keychain the token is stored there (otherwise it goes to `~/.claude/.credentials.json`). Claude Code then substitutes it into the MCP server's environment as `DISCORD_BOT_TOKEN` via [`wrightward/.mcp.json`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/.mcp.json).

    !!! warning "Claude Code has no in-UI way to re-edit plugin userConfig values after the initial prompt"
        There is no `/plugin reconfigure`, no CLI equivalent, and the `/plugin` menu only exposes install / uninstall / enable / disable / update. If you miss the prompt, dismiss it, or need to rotate the token later, the sanctioned path is to **set the token via an environment variable** before launching `claude`. The bridge checks two env vars, in order, via [`lib/discord-token.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/lib/discord-token.js):

        1. **`DISCORD_BOT_TOKEN`** — primary. Set this in the shell that launches Claude Code:

            ```sh
            # POSIX
            export DISCORD_BOT_TOKEN=your-token-here
            claude
            ```

            ```cmd
            :: Windows (current session only)
            set DISCORD_BOT_TOKEN=your-token-here
            claude
            ```

            ```powershell
            # Windows PowerShell
            $env:DISCORD_BOT_TOKEN = "your-token-here"
            claude
            ```

        2. **`CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN`** — fallback. This is the variable Claude Code itself would auto-export from the userConfig value. Setting it by hand reproduces the same behavior as the `/plugin` prompt succeeding.

        Disabling and re-enabling the plugin (`/plugin disable wrightward` then `/plugin enable wrightward`) *may* re-trigger the prompt per the "at enable time" wording, but this isn't an explicitly documented reconfigure path — the env-var route is the reliable one.

        When neither env var is set (and no keychain value propagated), the bridge exits with `[bridge] DISCORD_BOT_TOKEN missing; exiting.` in `.claude/collab/bridge/bridge.log`. That's your signal the token isn't reaching the subprocess.
6. **Create `.claude/wrightward.json`** in your project root:

    ```json
    {
      "discord": {
        "ENABLED": true,
        "FORUM_CHANNEL_ID": "1234567890",
        "BROADCAST_CHANNEL_ID": "1234567891",
        "ALLOWED_SENDERS": ["your-discord-user-id"]
      }
    }
    ```

    Leave `ALLOWED_SENDERS` empty (`[]`) to run the bridge send-only — no inbound messages from Discord will be routed to the bus until at least one user ID is listed.
7. **Start a Claude session in the repo.** The first session to come up spawns the bridge subprocess under a single-owner lockfile at `.claude/collab/bridge/bridge.lock`. Other sessions in the same repo observe the existing owner and do nothing — exactly one bridge runs per repo.

!!! note "The Discord bridge is independent of the Channels research-preview flag"
    The Phase 3 bridge is a plain subprocess that posts via REST. It does **not** require `--dangerously-load-development-channels` or allowlist inclusion — those are only needed for Phase 2's between-turn wake-up pings. If channels are disabled, the bridge still functions fully; you just won't get local wake-ups, and Path 1 (the hook-injected `additionalContext`) still delivers events on the next tool call.

##### Verify the Discord bridge

- Start a session. The bridge should post a `session_started` entry in the broadcast channel, and create a forum thread named `<task> (<shortId>)`.
- Call `wrightward_bus_status` — the `bridge` sub-object should show `running: true`, `last_error: null`, and `owner_session_id` matching your session.
- Post `@agent-all hello` in the broadcast channel (from a user ID listed in `ALLOWED_SENDERS`). Every active session should see a `user_message` on their next tool call.
- Tail `.claude/collab/bridge/bridge.log` for rotated diagnostic logs (1 MB rotation, keeps 3).

!!! warning "Persistent auth-failure circuit breaker"
    A Discord 401 (invalid/rotated bot token) trips a **1-hour persistent circuit breaker** across all sessions to prevent spawn loops. If you rotate the token mid-session, the bridge will stay down for up to an hour. The breaker state is visible in `wrightward_bus_status.bridge.circuit_breaker`.

### Functionality

Every coordination primitive, messaging tool, event type, and configuration knob.

#### File coordination

wrightward's default-on layer. Every Edit/Write is automatically tracked. No setup required; conflicts are blocked before they can happen.

##### Auto-tracking

Every Edit/Write is automatically tracked. Auto-tracked files are held for **2 minutes** from the last touch — short enough to expire quickly when the agent moves on.

##### Declared files

Running `/wrightward:collab-context` lets an agent declare files up front with a task description. Declared files are held for **15 minutes**, with automatic extension if the agent is still actively editing near the deadline. Best used after planning.

##### Guard behavior

Before every tool call, wrightward checks for conflicts:

- **Read/Glob/Grep on another agent's files** — non-blocking context is injected (who owns it, what they're doing).
- **Write to another agent's file** — blocked, the agent sees who owns it.
- **Write to an unrelated file** — proceeds with awareness of other active agents.
- **Solo agent** — everything proceeds silently with zero overhead.

Context injection is deduplicated — the same summary is only shown once per change in other agents' state.

##### Collab state is off-limits to the model

Edit/Write on any file inside `.claude/collab/` is hard-blocked unconditionally — whether or not other agents are active. This prevents an agent from bypassing the coordination system by directly editing `agents.json` or another agent's context file. Read access is not blocked — agents can still inspect their own state for debugging.

Bash is **not** intercepted by this block — the guard only enforces Edit/Write/Read/Glob/Grep. The block message and every collab skill tell the agent to never escalate to shell commands (`rm`, `sed`, redirects) to edit collab files, but this is a prompt-level directive, not an enforced block. State changes should always go through the wrightward skills.

If an agent believes another agent's claim is stale, the instructions in every collab skill tell it to **wait 6 minutes and try again**. After 6 minutes of no heartbeat, a crashed or abandoned session is automatically excluded from the active set, and its claims stop enforcing. Claims declared via `/wrightward:collab-context` can legitimately persist for 15 min or longer while the other agent works through a plan.

##### Idle reminders

If an agent hasn't touched a file in **5 minutes**, a one-time reminder suggests releasing it.

#### Slash commands (8)

All commands live under `/wrightward:<name>` and are auto-discovered from `wrightward/skills/`.

| Command | Purpose |
|---|---|
| `/wrightward:help` | Coordination rulebook — tool reference, file-coordination rules, Discord routing, event types, etiquette. |
| `/wrightward:collab-context` | Declare or update the current task and claimed files. JSON payload with `task`, `files` (`+` create / `~` modify / `-` delete), `functions`, `status`. |
| `/wrightward:collab-release` | Release specific files immediately so other agents can work on them. JSON payload with `files` array. |
| `/wrightward:collab-done` | Release all file claims and exit coordination. Clears the session entirely from collab state. |
| `/wrightward:inbox` | List pending urgent events. Usually unnecessary — events auto-inject. |
| `/wrightward:ack` | Acknowledge a handoff or other urgent event with `accepted` / `rejected` / `dismissed`. |
| `/wrightward:handoff` | Hand a task off to another agent, releasing listed files in the same atomic step. |
| `/wrightward:watch` | Register interest in a file — get notified when it frees up. |

!!! tip "The `help` skill is the canonical rulebook"
    `/wrightward:help` prints an in-context table of every tool, its key parameters, routing rules, event types, and etiquette — written for the agent to read when it's unsure what to do.

#### Message bus (v3.0)

On top of file coordination, wrightward runs a file-based peer-to-peer message bus so sessions can hand off work, watch files, and notify each other.

- Events are appended to `.claude/collab/bus.jsonl` (append-only, length-bounded, self-compacting).
- Per-session delivery bookmarks in `.claude/collab/bus-delivered/<sessionId>.json` track what each session has already seen.
- Urgent events are delivered via **Path 1** — the guard/heartbeat hooks inject pending events as `additionalContext` on the session's next tool call, then advance the bookmark. This is the sole source of truth for event delivery.
- A bundled MCP server (`wrightward-bus`) exposes seven tools for the model to use directly.

##### MCP tools (7)

| Tool | Required params | Optional params | Purpose |
|---|---|---|---|
| `wrightward_list_inbox` | — | `limit`, `types`, `mark_delivered` (default `true`) | List urgent events targeted at this session. Advances the delivery bookmark by default. Filters within urgent types only — non-urgent types are never returned. |
| `wrightward_ack` | `id` | `decision` (`"accepted"` \| `"rejected"` \| `"dismissed"`, default `"accepted"`) | Acknowledge a handoff. Routes the ack at the sender's session so they see your decision on their next tool call and in their Discord thread. |
| `wrightward_send_note` | `body` | `to` (sessionId or `"all"`, default `"all"`), `kind` (`"note"` \| `"finding"` \| `"decision"`, default `"note"`), `files` | Log an observability entry. `note` is quiet; `finding` and `decision` are **urgent** and broadcast to every agent's inbox. |
| `wrightward_send_handoff` | `to`, `task_ref`, `next_action` | `files_unlocked` | Hand work off to another session. Atomically releases the listed files and emits `file_freed` events to watchers. |
| `wrightward_watch_file` | `file` | — | Register interest in a file. You get a `file_freed` event when the owner releases it. |
| `wrightward_bus_status` | — | — | Diagnostic: pending urgent count, recent timestamp, bound session ID, bridge status (running, last_error, circuit_breaker). |
| `wrightward_send_message` | `body`, `audience` | — | Send a message via Discord. `audience` is `"user"` (Discord-only reply), `"all"` (Discord broadcast + every agent's inbox), or a sessionId (that agent's thread + inbox). Use to reply to a Discord user — plain assistant output is CLI-only. |

!!! note "`wrightward_send_message` requires the Discord bridge"
    This tool's message body is routed through Discord. If the bridge isn't running, the message still appears in the bus but no Discord delivery happens. Call `wrightward_bus_status` to check `bridge.running`.

##### Event types (15)

Defined in [`wrightward/lib/bus-schema.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/lib/bus-schema.js). Nine are **urgent** (auto-inject into recipients' contexts, capped by `BUS_URGENT_INJECTION_CAP`); six are non-urgent (persisted but not surfaced unless queried).

**Urgent (9)** — delivered via Path 1 hook injection on the next tool call:

- `handoff` — work assigned to you; ack with `wrightward_ack`
- `file_freed` — a file you watched was released
- `user_message` — from a human (CLI or Discord)
- `blocker` — another agent is blocked on something
- `delivery_failed` — bus failed to deliver one of your earlier events
- `agent_message` — from `wrightward_send_message` (Discord-facing)
- `ack` — your handoff was acknowledged (so you see accepted/rejected/dismissed)
- `finding` — another agent discovered something you MUST know
- `decision` — another agent committed to a choice that affects your work

**Non-urgent (6)** — persisted but not auto-surfaced:

- `note` — casual observation
- `interest` — someone registered a watch on a file
- `session_started` / `session_ended`
- `context_updated` — a session's task string changed
- `rate_limited` — Discord bridge hit a rate-limit bucket

##### Routing model

- `to` can be a session ID, `"all"`, or an array of session IDs.
- `from === to` never matches — no echo.
- An `ambiguous_mention` flag signals when a short-ID collision was resolved to `"all"` (see Discord section).

#### Channel push (v3.1, research preview)

By default, peer messages surface on a session's next tool call (Path 1). Channels add **Path 2**: a single `notifications/claude/channel` wake-up ping so an idle session notices new events between turns without a new user prompt.

- The doorbell writes no state and delivers no payload — it just says "you have N pending events".
- The woken session's next tool call runs Path 1 as usual and injects the actual event content.
- **Path 1 is always-on and authoritative.** Path 2 is best-effort. If the channel notification drops (known Claude Code bugs on some platforms) or the subsystem is disabled, Path 1 still delivers on the next interaction.
- The doorbell also trips when the Discord bridge appends `user_message` events, so a Discord reply can wake an otherwise-idle session.

See the setup section above for launching with channels.

#### Discord bridge (v3.2, opt-in)

When enabled, the bridge:

- Creates one **forum thread per agent** named `<task> (<shortId>)` and posts per-session events there.
- Mirrors `session_started` / `session_ended` / broadcast handoffs / `user_message` targeted at `"all"` into a shared **broadcast text channel**.
- Watches the broadcast channel **and every live (non-archived) agent thread** for inbound messages, routing them back into `bus.jsonl` as `user_message` events.
- Renames a thread when `/wrightward:collab-context` updates the session's task string (throttled by Discord's per-bucket rate limits).

##### Inbound routing

Three forms, all gated on `ALLOWED_SENDERS`:

- **Reply inside an agent's forum thread** → delivered to that thread's session without an `@mention`. Useful when you're watching the thread and want to respond in context.
- **`@agent-<id>` in the broadcast channel or inside a thread** → delivered to the mentioned session(s). Fan-out is supported: a thread reply that also includes `@agent-<id>` mentions delivers to the union of the thread owner and the mentioned sessions (deduped).
- **`@agent-all`** → explicit broadcast to every registered agent. Works in the broadcast channel or inside a thread. Distinct from an ambiguous short-ID collision — `ambiguous_mention` stays `false` for explicit `@agent-all`.

If Discord's **Message Content Intent** is off for your bot, thread replies still route to the thread owner (body may be empty). Broadcast `@mentions` require MCI because the body is the only signal.

##### Mirror policy defaults

User overrides merge on top of these defaults:

| Event type | Default mirror destination |
|---|---|
| `user_message`, `handoff`, `blocker`, `agent_message` | Recipient's thread. If sent to `"all"`, promotes to the broadcast channel. |
| `file_freed` | Recipient's thread (only when targeted at a specific sessionId); `silent` when broadcast (e.g., released-to-all is noise). |
| `session_started`, `session_ended` | Broadcast channel |
| `note`, `finding`, `decision` | Target thread when sent to a sessionId; promotes to the broadcast channel when sent to `"all"`. Demotable to `silent` via `mirrorPolicy` if you find them noisy. |
| `ack` | The original handoff sender's thread (so they see `accepted` / `rejected` / `dismissed` without grepping). Demotable to `silent`. |
| `context_updated` | Renames the sender's thread to match the new task string. |
| `interest`, `delivery_failed`, `rate_limited` | **Never mirrored** — hard rail (user cannot elevate these to a mirror action). |

##### Security model

- **`ALLOWED_SENDERS` gates on Discord user ID, not channel membership.** Access to the broadcast channel alone does not let anyone inject into your bus — only IDs explicitly listed can route mentions. Empty list = send-only.
- **Token redaction.** Bot tokens, `Bot <token>` headers, and Discord webhook URLs (including `canary.discord.com`, `ptb.discord.com`, `discordapp.com`, versioned `/api/v10/webhooks/…`) are scrubbed from every `bridge.log` write and every inbound message body before it reaches `bus.jsonl`.
- **UTF-8 + length cap on inbound.** Inbound message content is clamped at 4000 bytes on a UTF-8 boundary before append.
- **The bridge is a subprocess**, not a sender. Events originating from Discord use the reserved `system` sender with `meta.source: "discord"`. A loop-guard prevents re-mirroring Discord-sourced events back to Discord.
- **Local operation is never blocked by Discord.** If the Discord API is down, the bridge logs and retries; local `bus.jsonl` flow is unaffected. Auth failures (401) trip a persistent 1-hour circuit breaker across all sessions.

##### Diagnostics

- `wrightward_bus_status` returns a `bridge` sub-object with `running`, `owner_session_id`, `child_pid`, `last_error`, and the `circuit_breaker` trip state.
- `.claude/collab/bridge/bridge.log` — rotated diagnostic logs (1 MB rotation, keep 3).

#### Hooks (6)

All six run automatically — no user intervention needed.

| Hook | Trigger | What it does |
|---|---|---|
| [`register.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/register.js) | `SessionStart` | Registers the agent in `.claude/collab/agents.json`. |
| [`heartbeat.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/heartbeat.js) | `PostToolUse` (all tools) | Updates heartbeat, auto-tracks files, scavenges stale sessions, fires idle reminders. |
| [`guard.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/guard.js) | `PreToolUse` (`Edit\|Write\|Read\|Glob\|Grep`) | Blocks conflicting writes; injects awareness context for reads. |
| [`bash-allow.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/bash-allow.js) | `PreToolUse` (`Bash`) | Auto-approves wrightward's own script invocations (workaround for claude-code#11932). |
| [`plan-exit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/plan-exit.js) | `PostToolUse` (`ExitPlanMode`) | Reminds the agent to declare files via `/wrightward:collab-context` — only when other agents are active. |
| [`cleanup.js`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/hooks/cleanup.js) | `SessionEnd` | Deregisters the agent, releases all claims, emits `session_ended`. |

#### Configuration

Create `.claude/wrightward.json` in your project. All fields optional. See [`wrightward.example.json`](https://github.com/Joys-Dawn/toolwright/blob/master/wrightward/wrightward.example.json).

##### Base coordination keys

| Key | Default | Description |
|---|---|---|
| `ENABLED` | `true` | Master switch — when `false`, all hooks exit immediately. |
| `PLANNED_FILE_TIMEOUT_MIN` | 15 | How long declared files are held. |
| `PLANNED_FILE_GRACE_MIN` | 2 | Extends the timeout if the file was touched within this window before expiry. |
| `AUTO_TRACKED_FILE_TIMEOUT_MIN` | 2 | How long auto-tracked files are held (from last touch). |
| `REMINDER_IDLE_MIN` | 5 | How long a file must be idle before the release reminder fires. |
| `INACTIVE_THRESHOLD_MIN` | 6 | How long before a session is considered stale. |
| `SESSION_HARD_SCAVENGE_MIN` | 60 | Hard cleanup for truly dead sessions. |
| `AUTO_TRACK` | `true` | Whether Edit/Write auto-creates a context when none has been declared. |

##### Bus keys

| Key | Default | Description |
|---|---|---|
| `BUS_ENABLED` | `true` | Disable to skip MCP server entirely. |
| `BUS_RETENTION_DAYS` | 7 | Drop events older than this from `bus.jsonl`. |
| `BUS_RETENTION_MAX_EVENTS` | 10000 | Hard cap on events retained in `bus.jsonl`. |
| `BUS_HANDOFF_TTL_MIN` | 30 | TTL on handoff events (they expire if never acknowledged). |
| `BUS_INTEREST_TTL_MIN` | 60 | TTL on file-watch interest registrations. |
| `BUS_URGENT_INJECTION_CAP` | 5 | Max urgent events auto-injected per tool call. Overflow directs the agent to `/wrightward:inbox`. |

##### Discord block

| Key | Default | Description |
|---|---|---|
| `discord.ENABLED` | `false` | Master switch for the bridge. |
| `discord.FORUM_CHANNEL_ID` | — | Forum channel where per-agent threads are created. |
| `discord.BROADCAST_CHANNEL_ID` | — | Text channel for announcements and inbound `@`-mentions. |
| `discord.ALLOWED_SENDERS` | `[]` | Array of Discord user IDs permitted to route inbound messages. Empty blocks all inbound. |
| `discord.POLL_INTERVAL_MS` | 3000 | How often to poll the broadcast channel and each active forum thread. |
| `discord.THREAD_RENAME_ON_CONTEXT_UPDATE` | `true` | Whether `/wrightward:collab-context` task changes rename the Discord thread. |
| `discord.BOT_USER_AGENT` | `DiscordBot (https://github.com/Joys-Dawn/toolwright, 3.6.0)` | Override only if you have a reason; must start with the literal `DiscordBot` to avoid Cloudflare blocking. |
| `discord.mirrorPolicy` | (see above) | Per-event-type override of what gets mirrored where. |

##### Disabling wrightward in a repo

```json
{ "ENABLED": false }
```

All hooks exit immediately — no registration, no tracking, no blocking.

#### State directory layout

All coordination state lives in `.claude/collab/` (auto-gitignored). No state persists between sessions.

- `context/`, `context-hash/` — per-session task/file claims (Phase 1)
- `mcp/` — MCP server binding tickets (Phase 2)
- `bus.jsonl` — append-only event log (Phase 1–2)
- `bus-delivered/` — per-session delivery bookmarks
- `bus-index/` — derived indices (Discord thread map, etc.)
- `bridge/` — Discord lockfile, log, circuit breaker, last-polled markers (Phase 3)

#### Security summary

- **No network I/O by default.** Zero outbound HTTP/DNS/socket calls out of the box. Outbound traffic happens **only** when the Discord bridge is explicitly enabled, in which case the bridge talks to `discord.com/api/v10` via REST.
- **Channel notifications carry no payload.** The doorbell emits a fixed short string; event content always flows through Path 1's hook-injected `additionalContext`.
- **Bus messages originate only from co-located sessions.** No external sender.
- **Edit/Write to collab state are hard-blocked.** The guard hook unconditionally rejects Edit and Write tool calls targeting any file under `.claude/collab/`. Bash is not intercepted — agents are prompted (by the block message and every collab skill) to never escalate to shell to modify collab state, but this is a prompt-level directive, not an enforced block.
- **Advisory file locking.** All bus mutations run under one exclusive file lock with stale-lock detection.
- **No telemetry.** No events, usage stats, or crash reports leave the user's machine.

---

## timewright

> Single-slot undo for Claude's in-session changes, covering Bash-driven filesystem mutations that native `/rewind` misses.

**Version**: 1.2.0 · [Source](https://github.com/Joys-Dawn/toolwright/tree/master/timewright) · [README](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/README.md)

### Setup

Nothing beyond install and a git repo.

#### 1. Prerequisites

- **Git** — timewright uses git plumbing (`git worktree add HEAD`) for efficient snapshotting.
- **Node.js ≥ 18**.
- Your project must be inside a git repository. Non-git projects **silently opt out** — the SessionStart hook detects the missing repo and no-ops.

#### 2. Add the marketplace and install the plugin

```text
/plugin marketplace add Joys-Dawn/toolwright
/plugin install timewright@Joys-Dawn/toolwright
```

No configuration needed. All three hooks auto-register via the plugin manifest.

#### 3. Verify installation

1. Submit any prompt that edits a file. The `UserPromptSubmit` hook takes a snapshot of your working tree.
2. After Claude finishes, confirm `.claude/timewright/` exists at the repo root and contains:
    - `snapshot/` — the file-tree snapshot (git-worktree-driven)
    - `snapshot.json` — metadata (timestamp, git HEAD at snapshot time)
    - `stale.d/` — internal flag directory
    - `root` — project-root anchor file, used by hooks when Claude `cd`s into a subdirectory
3. Type `/undo`. You'll see a Modified / Added / Removed summary and a confirmation prompt.

### Functionality

Every piece of user-visible behavior.

#### `/undo` slash command

The only command the plugin ships. It interleaves with `AskUserQuestion` so the user must confirm before anything is applied.

##### Workflow

1. **Diff preview.** The command runs `node ${CLAUDE_PLUGIN_ROOT}/bin/undo.js --diff` via the Bash tool. The CLI prints JSON with `modified`, `added`, `removed`, `headDrift`, and `snapshotCreatedAt`.
2. **Summary.** Claude shows a three-bucket view:
    - **Modified (will be reverted)** — files Claude changed; undo restores them.
    - **Added (will be DELETED)** — files that did not exist in the snapshot; undo deletes them. **The dangerous set** — called out explicitly because it may include files the user created in parallel in their IDE.
    - **Removed (will be restored)** — files the snapshot had but that are gone now.
    - Lists of >20 show the first 20 with a "…and N more" line.
3. **Head-drift warning.** If `headDrift` is non-null, Claude shows both `headDrift.snapshot` and `headDrift.current` SHAs and warns before asking. This fires when you or another tool ran `git reset`, `git checkout`, `git rebase`, or similar between the snapshot and the undo.
4. **Confirmation.** `AskUserQuestion` prompts "Apply this undo? This will overwrite the working tree to match the snapshot." Two choices: **Yes, undo** or **No, cancel**.
5. **Apply or cancel.**
    - **Yes** — Claude runs `node ${CLAUDE_PLUGIN_ROOT}/bin/undo.js --apply`. On success, confirms. On partial success (some files couldn't be restored — often Windows symlink-privilege or file-in-use issues), reports the exact list. On failure, shows the error.
    - **No** — nothing is changed.

!!! warning "No snapshot means nothing to undo"
    Submitting `/undo` on the very first turn of a project (before any `UserPromptSubmit` hook has fired) will return `ok: false` with an error. This is also true if the snapshot was never re-taken after a previous undo and all state was consumed.

#### Snapshot model

- **When**: Every `UserPromptSubmit` where the stale flag is set — which is any turn after a mutating tool ran. Pure Read/Grep/Glob turns skip snapshotting entirely.
- **What**: Every tracked file (`git ls-files`) plus every dirty/untracked file in the working tree. Includes your uncommitted edits.
- **Where**: `.claude/timewright/snapshot/` inside the repo root.
- **Key invariant**: **Single-slot.** Each new prompt replaces the previous snapshot. There is no undo history — `/undo` rewinds to the *most recent* snapshot, not any prior one.
- **Race-safe ordering**: The `UserPromptSubmit` hook clears the stale marker **before** taking the snapshot. If a concurrent `PostToolUse` sets stale during `createSnapshot`, the next turn re-snapshots cleanly — no lost-turn risk.
- **`/undo` detection**: The `UserPromptSubmit` hook recognizes `/undo` and `/timewright:undo` (with or without trailing args) and **skips snapshotting** when the user is invoking undo itself — otherwise the snapshot would be overwritten before `/undo` could consume it.

#### What gets preserved

Your in-progress work. If you had unsaved edits, uncommitted changes, or untracked files when Claude started its turn, `/undo` restores them — not just the last git commit.

#### What gets excluded

timewright's `shouldExclude` function (see [`lib/excludes.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/lib/excludes.js)) combines `.gitignore` (via `git ls-files`) with an explicit exclusion set.

##### Excluded directories (any path segment matches)

`.claude`, `node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `.output`, `.turbo`, `.vercel`, `.svelte-kit`, `coverage`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`.

##### Excluded secret env files (basename match)

`.env`, `.env.local`, `.env.development.local`, `.env.test.local`, `.env.production.local`.

**Not** excluded: `.env.example`, `.env.template`, `.env.sample`. These are routinely committed and undo is expected to restore Claude's changes to them.

#### Coverage

`/undo` rewinds the **project directory**, not your machine. It reverts changes from all mutating tools inside the repo:

| Covered | Not covered |
|---|---|
| `Bash` — any command that modifies tracked or untracked source files (`rm -rf`, migrations, `git reset`, sed/awk rewrites, etc.) | Files outside the git repo (`~`, `C:\`, etc.) that Claude touched via Bash |
| `Write` — new files Claude creates | Global package installs, system configuration changes |
| `Edit` — inline edits to existing files | Git commits, pushes, or branch operations on a *different* repository Claude `cd`'d into |
| `NotebookEdit` — Jupyter notebook changes | Side effects of Bash commands that live outside the repo |
| `MultiEdit` — batched edits | Anything inside excluded directories (`node_modules/` after `npm install`, `dist/` after a build) |

Read-only tools (`Read`, `Grep`, `Glob`) **don't trigger snapshots** — they're free.

!!! note "Re-run after undoing the installer, not after undoing the install"
    If Claude runs `npm install`, `/undo` covers changes to `package.json` and `package-lock.json`, but **not** the installed packages in `node_modules/` (which are excluded). If you undo a `package.json` change, re-run `npm install` to reconcile.

#### Hooks (3)

Three hooks, all auto-registered via [`hooks/hooks.json`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/hooks.json).

| Hook | Trigger | Script | What it does |
|---|---|---|---|
| Anchor | `SessionStart` | [`on-session-start.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-session-start.js) | Resolves the git repo root from the launch `cwd` and records it at `<repoRoot>/.claude/timewright/root` so later hooks can locate the project root via walk-up — even if Claude `cd`s into a subdirectory. Non-git projects silently opt out. |
| Snapshot | `UserPromptSubmit` | [`on-user-prompt-submit.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-user-prompt-submit.js) | If stale and the prompt is **not** `/undo`, clears the stale marker and runs `createSnapshot`. On failure, re-asserts stale so the next turn retries. Never blocks the user's prompt. |
| Mark stale | `PostToolUse` (matcher `Bash\|Write\|Edit\|MultiEdit\|NotebookEdit`) | [`on-post-tool-use.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/hooks/on-post-tool-use.js) | Flips the stale flag so the next `UserPromptSubmit` takes a fresh snapshot. Defense-in-depth re-checks the tool name against the mutating set. |

All three hooks fail silently to stderr — none can block a session start, prompt, or tool call.

#### Head-drift warning

If you (or another tool) run git commands that move `HEAD` between the snapshot and the undo (`git checkout`, `git reset`, `git rebase`), timewright reports `headDrift = { snapshot: <sha>, current: <sha> }` in the diff output. `/undo` shows both SHAs and warns before applying — the undo would restore files to a state that assumed the old `HEAD`, which may not be what you want.

#### Partial failures

If some files can't be restored (locked by another process, permission issues, Windows symlink-privilege issues), the apply path returns `ok: true, partial: true, errors: [...]`. `/undo` reports exactly which files failed and which succeeded. Nothing is silently skipped.

#### State directory layout

All timewright state lives in `.claude/timewright/` inside your project:

- `snapshot/` — the file-tree snapshot
- `snapshot.json` — metadata (timestamp, git HEAD at snapshot time)
- `stale.d/` — internal flag directory
- `root` — project-root anchor file

This directory is excluded from snapshots (the `.claude` entry in the exclusion set) and is auto-`.gitignore`'d via the root-level `.gitignore`.

#### CLI entry point

[`bin/undo.js`](https://github.com/Joys-Dawn/toolwright/blob/master/timewright/bin/undo.js) has two modes:

| Invocation | Behavior |
|---|---|
| `node bin/undo.js --diff` | Prints JSON summary with `modified`, `added`, `removed`, `headDrift`, `counts`, `hasChanges`, `snapshotCreatedAt`. |
| `node bin/undo.js --apply` | Actually restores the snapshot. Prints JSON with `ok`, `applied`, and (if partial) `errors`. |

The `/undo` slash command invokes both via the Bash tool — **not** via `!` preprocessing — so the user gets a chance to confirm between `--diff` and `--apply`.

---

## License

All three plugins are Apache-2.0. See [LICENSE](https://github.com/Joys-Dawn/toolwright/blob/master/LICENSE).

## Issues and feedback

- File an issue: <https://github.com/Joys-Dawn/toolwright/issues>
- Source: <https://github.com/Joys-Dawn/toolwright>
