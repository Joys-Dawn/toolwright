---
name: project-planning
description: Plans a new project from scratch — determines stack, directory structure, tooling, and scaffolding for an empty directory. Use when the user wants to start a new project, initialize a codebase, or asks "set up a new app/API/CLI/library" from nothing.
---

# Project Planning

Enter plan mode and produce a complete, implementation-ready project plan for a greenfield codebase. Do not write any code until the plan is approved.

## Trigger

When this skill is invoked, **immediately enter plan mode** using the EnterPlanMode tool. All planning work happens inside plan mode.

## Scope

- **User describes a project idea**: Treat it as the starting point. Ask clarifying questions before making any technology decisions.
- **Request is vague**: Probe for project type, target users, scale expectations, team size, and deployment constraints before proceeding.
- **User specifies a stack**: Validate the choices against the project requirements. Flag mismatches but respect their preferences.

Do NOT skip clarification. A project initialized with the wrong stack wastes more time than a question.

## Process

### 1. Classify the Project

Determine which category best describes the project. This drives every subsequent decision.

| Category | Signal | Default Stack Direction |
|----------|--------|------------------------|
| **Web app (fullstack)** | User-facing UI + backend logic, auth, database | Fullstack framework (Next.js, SvelteKit, Remix) |
| **API / backend service** | Serves data to other clients, no UI | Backend framework (FastAPI, Express, Go net/http) |
| **Mobile app** | iOS/Android, possibly cross-platform | React Native (Expo) or Flutter |
| **CLI tool** | Terminal interface, installed by users | Go or Rust for distribution; Python or Node for internal tools |
| **Library / package** | Consumed by other developers, published | Minimal deps, dual ESM/CJS (JS) or src layout (Python) |
| **ML / data science** | Training, inference, data pipelines | Python (FastAPI for serving, cookiecutter-data-science for structure) |
| **Monorepo** | Multiple apps/packages sharing code | Turborepo or Nx with pnpm workspaces |

If the project spans multiple categories (e.g., "web app with a CLI admin tool"), identify the primary category and treat others as secondary concerns.

### 2. Clarify Requirements

Ask before continuing if any of these are unclear:

- **What does it do?** Core functionality in 1-2 sentences.
- **Who uses it?** End users, developers, internal team?
- **Scale expectations**: Hobby project, startup MVP, enterprise? Expected users/requests?
- **Team**: Solo developer, small team, large org? What languages/frameworks does the team know?
- **Deployment target**: Where will this run? (Vercel, Railway, Fly.io, AWS, self-hosted, edge, desktop)
- **Constraints**: Budget, compliance requirements, offline support, real-time needs, existing integrations?
- **Timeline**: MVP or production-ready? What's the first milestone?

Output: A numbered list of confirmed requirements.

### 3. Select the Stack

Make technology choices based on the project category, requirements, and team expertise. For each choice, state **what** you chose and **why** — not just the name. See [REFERENCE.md](REFERENCE.md) for detailed selection criteria and tradeoffs.

#### 3a. Language, Runtime & Framework

Choose based on project category and team expertise. **Team expertise is the most important factor** — a team proficient in Python will ship faster with Django than with a theoretically better framework they don't know.

- **JS/TS runtime**: Default to Node.js. Consider Deno for greenfield TypeScript-first projects or security-sensitive apps (permission model). Consider Bun for performance-critical workloads. See [REFERENCE.md](REFERENCE.md) for runtime comparison.
- Verify framework features against **official docs** before recommending. Use available MCP tools (context7, Supabase docs, Vercel docs) where possible. Do not rely on training knowledge for API specifics.
- If the choice is non-obvious, embed a mini-ADR: **Decision** / **Context** / **Consequences**.

#### 3b. Database

Default to **PostgreSQL** unless there's a specific reason not to. State the reason if choosing something else.

- Choose an ORM based on the ecosystem: Drizzle for serverless/edge TS, Prisma for fullstack TS with tooling needs, SQLAlchemy for Python.
- If the project needs caching, start with Redis. If it needs a message queue, start with Redis Streams.
- For BaaS: Supabase for most web projects, Firebase for mobile-first with offline-first needs.

#### 3c. Infrastructure & Deployment

Match deployment to the project's needs:
- **Frontend-heavy / Next.js**: Vercel (watch for cost at scale)
- **Full control / background workers**: Railway or Fly.io
- **Real-time / WebSockets / global edge**: Fly.io
- **Enterprise / complex architecture**: AWS (accept the complexity tax)

Don't choose microservices. Start with a modular monolith. Extract services only for proven hot paths.

#### 3d. Auth

If the project needs user accounts, choose an auth provider on day 1 — don't defer.
- **Fastest setup**: Clerk (generous free tier)
- **Already using Supabase**: Supabase Auth (generous free tier)
- **Maximum control**: Auth.js (free, more development time)
- **Do NOT use**: Lucia (deprecated March 2025), custom auth (unless you have a specific compliance reason)

#### 3e. CSS & UI Framework

Choose a styling approach and component library on day 1 for any web project with UI.

- **Default**: Tailwind CSS + shadcn/ui for React/Next.js projects. shadcn/ui copies component source into your project — you own and modify the code.
- **Full-featured library needed**: Mantine (best RSC compat) or MUI (Material Design, largest component catalog).
- **Enterprise dashboards**: Ant Design or MUI + MUI X (data grids, charts).
- **Do NOT use for new projects**: styled-components (maintenance mode since March 2025), Emotion (stagnant, RSC-incompatible).

See [REFERENCE.md](REFERENCE.md) for detailed comparison of all options.

### 4. Design the Directory Structure

Design a directory structure based on the project category. Follow **feature-based organization** for anything beyond trivial size. See [REFERENCE.md](REFERENCE.md) for category-specific layouts.

Principles:
- **Feature-based over layer-based** at any non-trivial scale. Group by domain (auth, billing, users), not by technical role (controllers, services, models).
- **Start simple, add structure as complexity demands.** A single `main.go` or flat `src/` is fine for small projects. Don't over-scaffold.
- **Separate source from config.** `src/` for code, root for config files, `dist/`/`build/` for output.
- **Colocate related code.** Tests next to source, styles next to components, types next to the code that uses them.
- **Enforce boundaries where the language supports it.** Go's `internal/`, SvelteKit's `$lib/server`, Rust's crate boundaries, ESLint import rules.
- **Config at root is the pragmatic default.** Use `pyproject.toml` (Python) or `package.json` (Node) to consolidate where possible.

Output: The full directory tree with comments explaining the purpose of each top-level directory.

### 5. Plan Tooling & Configuration

Specify the exact config files and tooling the project needs on day 1.

#### 5a. Package Manager (JS/TS projects)
- **pnpm** for team/professional projects (strict deps, disk-efficient, good monorepo support)
- **npm** when maximum compatibility matters or zero-setup friction is the priority
- **Bun** for experimental projects where you control the entire runtime

#### 5b. Linting & Formatting
- **JS/TS**: Biome (single tool, fast) or ESLint flat config + Prettier (mature plugin ecosystem). Specify which.
- **Python**: Ruff (replaces Flake8, Black, isort). Configure in `pyproject.toml`.
- **Go**: `gofmt` + `golangci-lint`
- **Rust**: `rustfmt` + `clippy`

#### 5c. Testing
- **JS/TS**: Vitest for Vite-based projects, Jest for React Native or legacy. Add Playwright for E2E when stable user flows exist (not day 1).
- **Python**: pytest. Configure in `pyproject.toml`.
- **Go**: built-in `go test`
- **Rust**: built-in `cargo test`

#### 5d. TypeScript Configuration (if applicable)
- `strict: true` always
- `noUncheckedIndexedAccess: true`
- `moduleResolution: "bundler"` for Vite/webpack, `"nodenext"` for pure Node
- Separate tsconfigs for different environments when needed

#### 5e. Pre-commit Hooks
- **JS/TS**: Husky + lint-staged (format + lint staged files only)
- **Python**: `pre-commit` framework with Ruff

#### 5f. Environment Variables
- **JS/TS**: Use Node.js built-in `--env-file=.env` (Node 20.6+). Add T3 Env (`@t3-oss/env-core` or `@t3-oss/env-nextjs`) for type-safe validation with Zod in TypeScript projects. Do not add `dotenv` to new projects.
- **Python**: Use `pydantic-settings` (`BaseSettings`) for validated, typed config. `python-dotenv` only for trivial scripts.
- **Always create `.env.example`** with placeholder values — this is the documentation for your env vars.
- **Framework prefixes**: Next.js uses `NEXT_PUBLIC_`, Vite uses `VITE_`, SvelteKit uses `PUBLIC_`. Non-prefixed vars are server-only.
- **Secrets management**: .env files are fine early on. Upgrade to Doppler, Infisical, or cloud-native secrets (AWS SSM, etc.) when you have multiple developers, environments, or compliance needs. See [REFERENCE.md](REFERENCE.md) for details.

#### 5g. Docker / Containerization
- **Add Docker Compose on day 1 if** the project has a database or external service dependency (Postgres, Redis, etc.). It eliminates "install X locally" friction.
- **Defer Docker if** building a library, CLI tool, or static site with no service dependencies.
- Use **multi-stage builds** for production images. Copy lockfiles before source code for layer caching.
- Default to **`-slim` base images** (e.g., `node:22-slim`, `python:3.13-slim`). Use distroless/scratch for Go/Rust static binaries.
- Always add a `.dockerignore` and run as non-root in the final stage.
- Omit the `version:` field in compose files — it is obsolete.
- See [REFERENCE.md](REFERENCE.md) for language-specific Dockerfile patterns.

#### 5h. Monitoring & Error Tracking
- **Day 1**: Add Sentry (has a free tier) and structured logging (pino/winston for JS, Python logging). This takes under 15 minutes and catches crashes immediately.
- **Day 1 (optional)**: Install OpenTelemetry SDK with auto-instrumentation. Even sending to console during dev means you can point it at any backend later without code changes.
- **First deploy**: Add uptime monitoring (UptimeRobot, free: 50 monitors).
- **Production launch**: Add log aggregation (Grafana Cloud free tier or Better Stack) and connect OTel traces to a backend.
- **Defer Datadog** until you have infra complexity (multiple services, K8s). It is overkill and expensive for small projects.
- See [REFERENCE.md](REFERENCE.md) for provider comparison and full timeline.

#### 5i. CI/CD
- Minimum day-1 pipeline: lint + test on every PR
- Cache dependencies (single biggest CI speedup)
- Pin third-party actions to SHA (supply chain security)
- Defer deployment pipelines until there's something to deploy

### 6. Plan Scaffolding Steps

Provide the exact sequence of commands to initialize the project. Each step should be copy-pasteable.

1. **Git init** — `git init`, create `.gitignore` (use a template matching the stack)
2. **Framework scaffold** — the `create-*` or `init` command (may include its own git init)
3. **Remove scaffold bloat** — delete example components, demo pages, etc.
4. **Add missing config** — `.env.example`, `.editorconfig`, linter config, test config
5. **Install core dependencies** — ORM, auth, UI library, state management, data fetching, etc.
6. **Set up database** — migration tool, initial schema, seed data
7. **Create directory structure** — the feature directories, shared utilities, etc.
8. **Add pre-commit hooks** — husky/lint-staged or pre-commit framework
9. **Add CI pipeline** — GitHub Actions workflow file
10. **Add license** — choose and add a LICENSE file (MIT, Apache-2.0, etc. — see [REFERENCE.md](REFERENCE.md))
11. **First test** — one passing test to prove the pipeline works
12. **README** — project name, one-line description, setup instructions, env var docs

Note which scaffold commands create which files (so the user knows what's auto-generated vs. manual).

### 7. Identify Risks & Open Questions

Flag anything that could go wrong or that you're uncertain about:
- Technology choices that depend on unconfirmed requirements
- Framework features you recommended but didn't verify against current docs
- Scaling concerns for the chosen architecture
- Cost projections that could surprise the user
- Missing requirements that weren't discussed

## Output Format

Write the plan to the plan file with this structure:

```
# Project: [Name]

## Requirements
1. [Confirmed requirement]
2. ...

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | | |
| Language | | |
| Framework | | |
| Database | | |
| ORM | | |
| Auth | | |
| CSS / UI | | |
| Hosting | | |
| Package Manager | | |
| Linting | | |
| Testing | | |
| Env Vars | | |
| Containerization | | |
| Monitoring | | |

[ADRs for non-obvious choices]

## Directory Structure
[Full tree with comments]

## Tooling & Config
[Config files needed, what goes in each]

## Scaffolding Steps
1. [Exact command]
2. ...

## Risks & Open Questions
- [Risk with mitigation or decision needed]

## Out of Scope
- [What this plan explicitly does not cover]
```

## Rules

- **Plan mode first**: Always enter plan mode before doing any planning work.
- **No code**: Do not write implementation code during planning. The plan is the deliverable.
- **Ask, don't assume**: If the request is ambiguous, ask clarifying questions. One round of good questions beats multiple rounds of back-and-forth.
- **Verify against docs**: Before recommending a specific framework feature, SDK, or API, check the official documentation. Use MCP tools where available.
- **Team expertise wins**: Default to what the team knows. Only recommend unfamiliar technology when there's a measurable advantage that justifies the learning cost.
- **Start boring**: Default to boring technology (PostgreSQL, React, Node.js, REST, monolith). Spend innovation tokens only where they provide measurable advantage.
- **Don't over-scaffold**: Match the directory structure to the project's actual complexity, not its hypothetical future complexity. You can always add structure later.
- **Honest about tradeoffs**: Every technology choice has downsides. Name them. Don't sell.
- **Scope boundaries**: State what's in and out of scope. Prevent scope creep by naming it.
