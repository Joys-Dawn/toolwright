# Project Planning — Reference

Detailed stack selection criteria, directory structure templates, and tooling recommendations for the skill defined in `SKILL.md`.

---

## 1. Stack Selection

### Web Frameworks

| Framework | Best For | Watch Out |
|-----------|----------|-----------|
| **Next.js** | Largest ecosystem, SSR/SSG, fullstack React. Turbopack is default as of v16. | Vercel soft lock-in for ISR, middleware, PPR. Cost scales with traffic. |
| **SvelteKit** | Best DX, smallest runtime, compile-time optimization. `$lib/server` is enforced by SvelteKit's Vite plugin at build time. | Smaller ecosystem, fewer third-party integrations. |
| **Remix / React Router v7** | Form-heavy apps, progressive enhancement. Merged into React Router v7 (Nov 2024). | Community split after merge; some moved to TanStack. |
| **Plain SPA (Vite)** | Client-only dashboards behind auth, no SSR needed. | No SEO, no server-side data loading. |

**When to use a separate backend**: Multiple clients (web + mobile + third-party), complex domain logic, or non-JS backend language needed.

### JS/TS Runtimes

| Runtime | Best For | Watch Out |
|---------|----------|-----------|
| **Node.js** | Default choice. Largest ecosystem, most battle-tested, biggest hiring pool. | Not the fastest option. |
| **Deno** | Greenfield TS-first projects, security-sensitive apps (permission model), edge/serverless, CLI tools. High npm compat since 2.0. | Smaller talent pool, less Stack Overflow coverage. Native C++ addons may break. Fresh framework is immature vs Next.js/SvelteKit. |
| **Bun** | Performance-critical workloads, fast dev loops (significantly faster installs). | No security sandbox. Newer runtime (1.0 Sept 2023), less battle-tested at scale. |

**Default to Node.js** unless there's a specific reason to choose otherwise. Deno's permission model is genuinely unique for security. Bun's speed is real but the ecosystem maturity gap matters for production.

**JSR (JavaScript Registry):** New registry from the Deno team — publish TypeScript source directly, works with all runtimes. Early adoption, useful for TS-first library authors. npm remains the primary registry for consuming packages.

### Backend Languages

| Language | Best For | Avoid When |
|----------|----------|------------|
| **Node.js / TS** | I/O-heavy CRUD, full-stack JS teams, real-time | CPU-intensive workloads |
| **Python** | ML/AI serving, data pipelines, rapid prototyping | High-concurrency low-latency services |
| **Go** | Cloud-native infra, high-concurrency APIs, CLI tools | Rapid prototyping, ML/AI |
| **Rust** | Performance-critical, security-critical, WASM | Fast prototyping, small teams needing quick iteration |

### API Protocols

| Protocol | Best For | Avoid When |
|----------|----------|------------|
| **REST** | Public APIs, simple CRUD, CDN caching | Complex nested data fetching for own UI |
| **GraphQL** | Variable data needs, aggregating multiple sources | Simple CRUD, small teams (overhead not worth it) |
| **tRPC** | TS monorepos, full-stack TS with zero codegen. `@trpc/openapi` (alpha) generates OpenAPI 3.1 specs. | Polyglot environments, public APIs for non-TS clients |
| **gRPC** | Internal service-to-service, high-throughput, streaming | Browser-facing APIs (needs proxy) |

### Mobile

| Framework | Best For | Notes |
|-----------|----------|-------|
| **React Native (Expo)** | Teams that know React, code sharing with web | New Architecture (Fabric) is default since 0.76. Expo is the default starting point — eject was removed in SDK 46, replaced by prebuild. |
| **Flutter** | UI-intensive, pixel-perfect cross-platform | Larger binary size, Dart ecosystem smaller than JS |
| **Native (Swift/Kotlin)** | Maximum platform integration, games, AR | Requires dedicated platform teams |

### Databases

**Default to PostgreSQL** unless there's a specific reason not to.

| Database | When | Notes |
|----------|------|-------|
| **PostgreSQL** | Almost always. Complex queries, ACID, JSONB, pgvector, extensions. | Handles document workloads that used to require MongoDB. |
| **SQLite** | Embedded apps, edge/serverless (D1, Turso), read-heavy single-server | Renaissance with Litestream, Turso, D1. Significantly faster than network DB for simple local reads. |
| **MySQL** | Simple CRUD, broad hosting compatibility | Fewer advanced features than Postgres. |
| **MongoDB** | Truly schema-fluid document data with no relational needs | Don't use for data with complex relational needs. Transactions exist (since 4.0) but are less ergonomic and performant than in relational DBs. |
| **DynamoDB** | AWS-native, extreme scale, simple access patterns | Complex queries, joins, ad-hoc analytics are painful. |

### ORMs (TypeScript)

| ORM | Best For | Notes |
|-----|----------|-------|
| **Drizzle** | Serverless/edge, SQL-first teams, minimal cold starts | Tiny bundle, zero dependencies, tree-shakeable, schema-as-TypeScript |
| **Prisma** | Frontend-heavy teams, maximum tooling (Studio, migrations) | Prisma 7 rewrote engine from Rust to TS, significantly smaller bundle. Cold starts still higher than Drizzle. |

### Auth

| Provider | Best For | Notes |
|----------|----------|-------|
| **Clerk** | Fastest setup, pre-built components | Managed service, free tier available |
| **Supabase Auth** | Projects already on Supabase | Managed service, free tier available |
| **Auth.js** | Maximum control, zero vendor lock-in | Self-hosted, unlimited, more development time |
| ~~Lucia~~ | ~~Deprecated March 2025~~ | Do not use for new projects. |

### Deployment

| Platform | Model | Best For | Cost Model |
|----------|-------|----------|------------|
| **Vercel** | Serverless | Next.js, frontend-heavy | Per-seat + usage; costs compound at scale |
| **Railway** | Containers, usage-based | Full-stack apps, databases, workers | Usage-based with hobby tier |
| **Fly.io** | VMs at edge | WebSockets, real-time, global edge | Pay-as-you-go |
| **Cloudflare Workers** | V8 isolates | Low-latency routing/caching, edge compute | Usage-based; near-zero cold starts |

### CSS & UI Frameworks

#### Styling Approaches

| Approach | Status | Best For | Watch Out |
|----------|--------|----------|-----------|
| **Tailwind CSS** (v4) | Industry default for new projects | Rapid prototyping, component-heavy apps, AI-generated UIs | Learning curve for CSS purists; verbose class strings |
| **CSS Modules** | Stable, still viable | Teams preferring traditional CSS; strict style encapsulation | More boilerplate than Tailwind; no built-in design tokens |
| **styled-components** | **Maintenance mode** (March 2025) | Legacy projects only | Creator recommends against new adoption; incompatible with React Server Components |
| **Emotion** | Stable but stagnant | Projects already using it; MUI v5 dependency | Same RSC limitations as styled-components; no new features planned |

**Current consensus**: Tailwind CSS is the default. CSS Modules is the fallback for teams preferring vanilla CSS. Runtime CSS-in-JS is declining due to RSC incompatibility and runtime overhead.

#### Component Libraries

| Library | Architecture | Best For | Notes |
|---------|-------------|----------|-------|
| **shadcn/ui** | Copy-paste source; Tailwind + Radix/Base UI | Default for React/Next.js. Full code ownership, zero runtime overhead. | Not an npm dependency — CLI copies components into your project. |
| **Radix UI** | Headless/unstyled primitives | Building custom design systems; foundation layer for shadcn/ui | Handles accessibility, keyboard nav, focus management. |
| **Base UI** | Headless/unstyled primitives (MUI team) | Alternative to Radix; shadcn/ui supports it as of Feb 2026 | v1.0 stable Dec 2025. |
| **MUI** (v6) | Traditional library; Emotion-based | Material Design compliance; advanced data components (MUI X: grids, charts, date pickers) | Emotion dependency creates RSC friction; heavier bundle. |
| **Mantine** (v8) | CSS Modules (since v7); 120+ components | Best all-around traditional library. Forms, dates, rich text, notifications in one package. | Best RSC compatibility of any full-featured library. |
| **Ant Design** (v6) | Traditional library; CSS-in-JS | Enterprise dashboards; data-heavy admin tools | Strong in Chinese market; large bundle; opinionated visual style. |

#### Decision Matrix

| Project Type | Recommended |
|---|---|
| Startup MVP / SaaS | Tailwind CSS + shadcn/ui |
| Custom design system | Tailwind CSS + Radix UI (or Base UI) primitives |
| Enterprise admin / data-heavy | Ant Design or MUI + MUI X |
| Full-featured app, single library | Mantine |
| Material Design required | MUI v6 |

### State Management (React)

| Library | Best For | Notes |
|---------|----------|-------|
| **Zustand** | Default for most React apps | Minimal API, no boilerplate, works with RSC. Handles most state needs. |
| **Jotai** | Atomic/fine-grained state, derived state | Bottom-up approach, composable atoms. Good for complex derived state. |
| **Redux Toolkit** | Large teams with existing Redux expertise | Still viable with RTK, but heavier than Zustand for new projects. |
| **React Context** | Small, infrequently-changing state (theme, auth user) | Not a state manager — avoid for frequently-updating state (causes re-renders). |

**Rule of thumb**: Start with Zustand. Add Jotai if you have complex derived/atomic state needs. Avoid Redux for new projects unless the team already knows it.

### Data Fetching (React)

| Library | Best For | Notes |
|---------|----------|-------|
| **TanStack Query** | Default for server state in React apps | Caching, deduplication, background refetch, optimistic updates. Replaces most hand-rolled data fetching. |
| **SWR** | Simpler use cases, Vercel ecosystem | Lighter than TanStack Query, fewer features. Good for read-heavy apps. |
| **tRPC** | Full-stack TypeScript monorepos | End-to-end type safety with zero codegen. Uses TanStack Query or SWR under the hood. |

**Rule of thumb**: Use TanStack Query for any React app that fetches data. If using tRPC, it handles this layer for you.

### Real-Time

| Method | Use When |
|--------|----------|
| **WebSockets** | Bidirectional (chat, gaming, collaborative editing) |
| **SSE** | Server-to-client streaming (notifications, AI token streaming). Auto-reconnects. |
| **Polling** | Legacy compatibility or environments blocking WebSockets |

### CLI Tools

| Language | Strength |
|----------|----------|
| **Go** | Single binary, effortless cross-compilation (cobra, bubbletea) |
| **Rust** | C-class performance with safety (clap, indicatif) |
| **Python** | Fastest to write, best for data/ML-adjacent (typer, click, rich) |
| **Node.js** | Massive ecosystem, fastest to prototype (commander, inquirer) |

**Rule of thumb**: If end users install it, Go or Rust for single-binary distribution. If internal/team tool, Python. If whole stack is JS, Node.

---

## 2. Directory Structures

### Next.js (App Router)

```
src/
  app/                    # File-based routing, layouts, route groups
    (auth)/               # Route group (no URL segment)
    (dashboard)/
    api/
  components/
    ui/                   # Generic primitives (Button, Modal)
    features/             # Domain-specific composed components
  lib/                    # Utility functions, API clients
  hooks/                  # Custom React hooks
  types/                  # TypeScript definitions
public/
```

Scaffolded by `npx create-next-app@latest`. Also generates `AGENTS.md` for AI coding assistants (since 16.2).

### SvelteKit

```
src/
  lib/                    # Importable via $lib alias
    components/
    server/               # Server-only ($lib/server, enforced by Vite plugin at build time)
    utils/
  routes/                 # File-based routing
    +layout.svelte
    +page.svelte
static/
```

Scaffolded by `npx sv create` (replaces deprecated `create-svelte`).

### React (Vite)

```
src/
  features/               # Feature-based (bulletproof-react pattern)
    auth/
      components/
      hooks/
      api/
      types/
      index.ts
    dashboard/
  components/             # Shared UI components
  hooks/                  # App-wide hooks
  lib/                    # Third-party wrappers, utilities
  pages/                  # Page-level components
```

Features do not import from each other — enforce with ESLint `no-restricted-imports`. Scaffolded by `npm create vite@latest` (minimal — structure is manual).

### FastAPI

```
app/
  auth/                   # Domain-based modules
    router.py
    schemas.py
    models.py
    service.py
  users/
  core/                   # config.py, security.py
  main.py
```

Endpoints handle HTTP only; business logic in service functions.

### Go

```
cmd/
  myapp/
    main.go               # Entry point
internal/                  # Private code, enforced by the go tool (since Go 1.5 for all repos)
  config/
  user/
  product/
pkg/                       # Public reusable libraries (only if needed externally)
```

Start simple — a single `main.go` is fine. The `golang-standards/project-layout` repo is community-maintained, not official. The Go team does not endorse a single standard layout.

### Rust (Workspace)

```
Cargo.toml                # [workspace] members
crates/
  api/                    # HTTP server (axum, actix-web)
  core/                   # Business logic, domain types
  db/                     # Database layer
  shared/                 # Common types, errors
```

Workspaces share `Cargo.lock`, compile shared code once.

### Python Package

```
src/
  my_package/
    __init__.py
    module1.py
    py.typed               # PEP 561 marker
tests/
pyproject.toml             # PEP 621: all metadata here
```

PyPA recommends `src/` layout — tests run against installed version, not source files.

### Python CLI

```
src/
  mycli/
    __init__.py
    __main__.py           # python -m mycli entry
    cli.py                # Typer/Click interface
    commands/
    core/                 # Business logic
pyproject.toml            # [project.scripts] mycli = "mycli.cli:app"
```

### Node.js CLI

```
src/
  index.ts
  commands/
  lib/
bin/
  mycli.js                # #!/usr/bin/env node shebang
package.json              # "bin": { "mycli": "./bin/mycli.js" }
```

Note: `vercel/pkg` is deprecated (Jan 2024). For single-binary distribution, use Node.js single executable applications (Node 19.7+ / backported to 18.16+) or compile with `bun build --compile`.

### ML / Data Science (Cookiecutter Data Science v2)

```
data/
  raw/                    # Original, immutable data
  interim/                # Intermediate transforms
  processed/              # Final canonical datasets
models/                   # Trained/serialized models
notebooks/                # Jupyter (naming: 01-explore, 02-clean)
src/
  config.py
  dataset.py
  features.py
  modeling/
    train.py
    predict.py
pyproject.toml
Makefile                  # Reproducibility commands
```

Install with `pip install cookiecutter-data-science` (or `pipx`), then run `ccds`.

### Monorepo

```
apps/
  web/                    # Next.js frontend
  api/                    # Backend service
packages/
  ui/                     # Shared component library
  config-eslint/
  config-typescript/
  utils/
  database/               # Prisma/Drizzle schema + client
turbo.json
pnpm-workspace.yaml
```

Scaffolded by `npx create-turbo@latest`. Use pnpm workspaces. Remote caching dramatically reduces repeat build times.

### npm Package

```
src/
  index.ts
dist/                     # Build output (gitignored, published)
package.json
  "main": "dist/index.js"
  "module": "dist/index.mjs"
  "types": "dist/index.d.ts"
  "files": ["dist"]
  "peerDependencies": {}  # Framework deps (React, etc.) — never bundle
```

Export both ESM and CJS. Use `npm pack --dry-run` before publishing.

---

## 3. Tooling Quick Reference

### Package Managers (JS/TS)

| Manager | Use When |
|---------|----------|
| **pnpm** | Professional/team projects. Strict deps, significantly less disk space, good monorepo support. |
| **npm** | Maximum compatibility, zero-setup friction. Ships with Node. |
| **Bun** | Experimental/personal projects. Significantly faster installs. Runtime maturity still catching up. |
| **Yarn Classic** | Don't. Maintenance mode. |

### Linting & Formatting

| Ecosystem | Tool | Notes |
|-----------|------|-------|
| **JS/TS** | Biome | Single tool, significantly faster than ESLint+Prettier. Biome 2.0+ includes type inference for type-aware lint rules. |
| **JS/TS** | ESLint + Prettier | Mature plugin ecosystem. ESLint v9+ uses flat config (`eslint.config.mjs`). `.eslintrc.*` deprecated, removed in v10. |
| **Python** | Ruff | Written in Rust, dramatically faster than Flake8/Black. Replaces Flake8, Black, isort, pydocstyle, pyupgrade, autoflake. Configure in `pyproject.toml`. |
| **Go** | gofmt + golangci-lint | Built-in formatting + comprehensive linting. |
| **Rust** | rustfmt + clippy | Built-in. |

### Testing

| Ecosystem | Tool | Notes |
|-----------|------|-------|
| **JS/TS (Vite)** | Vitest | Default for new projects. Native ESM/TS, significantly faster than Jest, especially in watch mode. |
| **JS/TS (other)** | Jest | Legacy, React Native, heavily invested ecosystems. |
| **Python** | pytest | Undisputed standard. `pyproject.toml` config. `--import-mode=importlib` for new projects. |
| **E2E** | Playwright | Add when stable user flows exist (not day 1). Chromium + Firefox + WebKit. |

### TypeScript Config

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler"  // "nodenext" for pure Node.js
  }
}
```

### CI Minimum (GitHub Actions)

Day 1 pipeline: lint + test on every PR with dependency caching. Pin actions to SHA.

Defer: deployment pipelines, Docker layer caching, matrix testing, security scanning (add within first month).

### Environment Variables

#### Ecosystem Defaults

| Ecosystem | Tool | Notes |
|-----------|------|-------|
| **Node.js 20.6+** | Built-in `--env-file=.env` | No dependency needed. Add to `package.json` scripts. Stable since Node 22. |
| **TypeScript (web)** | T3 Env (`@t3-oss/env-nextjs` or `@t3-oss/env-core`) | Zod-based validation, separate server/client schemas, typed access with autocomplete. The standard for TS web projects. |
| **Python** | `pydantic-settings` (`BaseSettings`) | Validates types, supports dotenv, nested models, secrets dirs. Recommended by FastAPI docs. |
| **Python (trivial scripts)** | `python-dotenv` | Fine for one-off scripts. Avoid in production apps. |

Do not add `dotenv` to new Node.js projects — the built-in flag covers the primary use case.

#### .env File Conventions

| File | Git? | Purpose |
|------|------|---------|
| `.env.example` | **Always yes** | Documents every required variable with placeholder values. Mandatory. |
| `.env` | Yes (if no secrets) | Shared defaults across all environments |
| `.env.local` | No | Local overrides, machine-specific secrets |
| `.env.development` | Yes | Defaults for development mode |
| `.env.production` | Yes | Defaults for production mode |

In production, do not rely on .env files. Use the platform's native env injection (Vercel, Railway, Docker) or a secrets manager.

#### Framework-Specific Prefixes

| Framework | Client prefix | Build behavior |
|-----------|--------------|----------------|
| **Next.js** | `NEXT_PUBLIC_` | Inlined at `next build` — cannot change without rebuild |
| **Vite** | `VITE_` (configurable via `envPrefix`) | Replaced via `import.meta.env` at build time |
| **SvelteKit** | `PUBLIC_` | Offers both static (build-time) and dynamic (runtime) env access via separate import paths |

All three frameworks strip non-prefixed vars from client bundles for security.

#### When to Upgrade to a Secrets Manager

Upgrade from .env files when: multiple developers need shared secrets, multiple environments/services, secret rotation needed, compliance requirements (SOC 2, HIPAA, PCI), or you've had a secret leak.

| Tool | Best For |
|------|----------|
| **Doppler** | Startups, small teams. Best DX, 5-minute setup. |
| **Infisical** | Open-source, self-hostable. Doppler-like UX with data sovereignty. |
| **AWS Secrets Manager / SSM** | Teams already on AWS. Native IAM integration. |
| **HashiCorp Vault** | Enterprise multi-cloud. Dynamic secrets, granular policies. High operational overhead. |

### Docker / Containerization

#### When to Add Docker

**Day 1**: Multi-service apps (API + DB + cache), teams with 2+ developers, any project targeting cloud/K8s deployment.

**Defer**: Solo developer on a library or CLI tool, rapid prototyping / throwaway spikes, static sites.

**Rule of thumb**: If your project has a database or external service dependency, add Docker Compose on day 1.

#### Base Image Selection

| Image | Size | Best For |
|-------|------|----------|
| **`-slim` variants** (e.g., `node:22-slim`, `python:3.13-slim`) | ~75 MB | Default choice. glibc compat, reasonable size. |
| **Alpine** | ~5 MB | Go/Rust static binaries, simple apps where musl compat is tested. **Avoid for Python** — musl causes subtle issues with compiled packages. |
| **Distroless** (`gcr.io/distroless/*`) | 2-20 MB | Production Go/Java/Python images. Minimal attack surface. |
| **scratch** | 0 MB | Go/Rust with fully static binaries (`CGO_ENABLED=0`). |

#### Multi-Stage Build Rules

1. Copy dependency manifests (lockfiles) before source code — enables layer caching.
2. Use `--mount=type=cache` for package manager stores.
3. Run as non-root in the final stage (`USER node`, `USER nonroot`, `USER nobody`).
4. Pin base image tags to `major.minor`, never `latest`.
5. Always add a `.dockerignore` (include `.git`, `node_modules`, `.env*`, `__pycache__`, IDE dirs).
6. Always add a `HEALTHCHECK` for orchestrated deployments.

#### Docker Compose Notes

- Docker Compose V2 is the standard (CLI plugin: `docker compose`, not old `docker-compose` binary).
- Omit the `version:` field — it is obsolete.
- Keep Compose minimal for local dev. Do not replicate production orchestration.

#### Alternatives

| Tool | Notes |
|------|-------|
| **OrbStack** | Recommended for macOS. Faster file I/O than Docker Desktop. Free for personal use, paid for commercial. |
| **Podman** | Rootless, daemonless, free. Good for security-sensitive orgs or avoiding Docker Desktop licensing. |
| **DevContainers** | Works on top of any container runtime. Good for onboarding consistency with 3+ developers. |

### Monitoring & Observability

#### Error Tracking / Observability Providers

| Provider | Free Tier | Best For |
|----------|-----------|----------|
| **Sentry** | Free tier available | Error tracking, stack traces, session replay. Day 1 tool. |
| **Grafana Cloud** | Generous free tier | OTel-native, vendor-neutral observability. Best free tier for logs. |
| **New Relic** | Generous free tier | Full-stack APM. |
| **Better Stack** | Free tier available | Combined logging + uptime + incident management. |
| **Datadog** | 14-day trial only | Full-stack observability at scale. Costs spiral fast — defer until you have real infra complexity. |

#### Uptime Monitoring

| Provider | Free Tier | Notes |
|----------|-----------|-------|
| **UptimeRobot** | Free tier available | Simple and reliable. Best free option. |
| **Better Stack Uptime** | Free tier available | Nicer UI, incident management built in. |

#### OpenTelemetry

Adopt from day 1 for new projects. It is the industry standard for observability instrumentation. Auto-instrumentation requires zero code changes for many frameworks. Prevents vendor lock-in — switching backends is a config change, not a rewrite.

#### When to Add What

| Phase | Add | Cost |
|-------|-----|------|
| **Day 1** | Structured logging (pino/winston/Python logging), Sentry, OTel SDK | Free |
| **First deploy** | UptimeRobot, Slack/email alerts from Sentry + UptimeRobot | Free |
| **Production launch** | Log aggregation (Grafana Cloud or Better Stack), OTel traces to backend, status page | Low cost |
| **Scale** | Datadog or equivalent, custom dashboards, SLOs, on-call rotation | Significant cost |

**Minimum viable stack at no cost**: Sentry (errors) + UptimeRobot (uptime) + Grafana Cloud free (logs) + OpenTelemetry (instrumentation).

---

## 4. Decision Principles

### Choose Boring Technology (Dan McKinley / Etsy)

Your org has a limited number of "innovation tokens." Spend them on technologies that differentiate your product, not your infrastructure. Every new technology costs operational capacity. Default to boring (PostgreSQL, React, Node.js, REST, monolith), spend innovation tokens only where they provide measurable advantage.

### Start Monolith, Extract Later

Start with a modular monolith. It delivers most of microservices benefits at a fraction of the cost. Many organizations that adopted microservices are consolidating services back into larger units, citing debugging complexity and operational overhead. Extract services only for proven hot paths with concrete scaling needs.

### Architecture Decision Records (ADRs)

For every non-obvious technology choice, embed a mini-ADR:

```
**Decision**: [What was chosen]
**Context**: [Why a decision was needed; alternatives considered]
**Consequences**: [What becomes easier; what becomes harder]
```

### What Scaffolds Are Missing

Nearly every `create-*` command is missing: testing framework, pre-commit hooks, CI/CD config, `.env.example`, Docker config, `.editorconfig`. Plan to add these manually.

---

## 5. Common Anti-Patterns

### Resume-Driven Development
Choosing a stack because it looks good on a resume rather than because it fits the project. Team expertise is the #1 factor — familiarity and productivity outweigh theoretical benefits.

### Premature Microservices
Building distributed systems for problems a monolith handles trivially. A modular monolith with clear module boundaries is the right starting point for the vast majority of projects.

### Over-Scaffolding
Creating `features/auth/components/`, `features/auth/hooks/`, `features/auth/api/` directories before you have a single component. Start flat, add structure when you feel the pain.

### Deferring Auth
"We'll add auth later" means bolting it onto routing, middleware, database schema, and API design after the fact. If the project needs user accounts, add auth on day 1 with a managed service.

### NoSQL When You Need Relational Data
If you need joins, ACID transactions, or anything involving financial data / inventory / compliance — you need a relational database. PostgreSQL handles document workloads via JSONB.

### Custom Auth
Building email/password + social login from scratch takes weeks and has real security consequences. All major auth providers are free at early scale. Use one.

### No Error Tracking Until Production
"We'll add Sentry later" means you don't know about crashes until users report them. Sentry's free tier and 10-minute setup make this indefensible. Add it on day 1.

### Committing Secrets in .env Files
`.env` files with real secrets committed to git. Use `.env.example` with placeholders, keep `.env.local` in `.gitignore`, and centralize env access in one file (`env.ts` / `config.py`) with validation.

### Accessing process.env Everywhere
Scattered `process.env.X` calls throughout the codebase lead to typos, missing vars, and no type safety. Centralize and validate in one place (T3 Env for TS, pydantic-settings for Python).

---

## 6. License Selection

Choose a license on day 1 for any project that will be shared or open-sourced. No license = no one can legally use your code.

| License | Use When | Notes |
|---------|----------|-------|
| **MIT** | Default for most open-source projects | Maximum permissiveness. Short, simple, widely understood. |
| **Apache-2.0** | Need patent protection | Like MIT but includes an explicit patent grant. Common for corporate-backed OSS. |
| **GPL-3.0** | Want to ensure derivatives stay open-source | Copyleft — all derivative works must also be GPL. Incompatible with some commercial use. |
| **AGPL-3.0** | SaaS/server-side code that must stay open | Like GPL but covers network use (closes the "SaaS loophole"). |
| **BSL / SSPL** | Want to prevent competitors from hosting your project as a service | Source-available but not OSI-approved open source. Used by MongoDB, Elastic, HashiCorp. |
| **None (proprietary)** | Commercial / internal projects | No LICENSE file needed, but be explicit in README if the repo is public. |

**Rule of thumb**: MIT for libraries, Apache-2.0 for anything with patent concerns, proprietary for commercial products. If unsure, ask.
