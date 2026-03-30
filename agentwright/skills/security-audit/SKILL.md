---
name: security-audit
description: Performs a thorough security audit against established industry standards (OWASP Top 10 2025, OWASP API Security Top 10 2023, CWE taxonomy, GDPR, PCI-DSS). Use when reviewing for security vulnerabilities, hardening production systems, auditing auth/payment/database code, or conducting periodic security reviews. Works on git diffs, specific files, or an entire codebase.
---

# Security Audit

Audit code against established security standards and threat models. Every finding **must** cite the specific standard ID (OWASP, CWE, GDPR article, etc.) so the developer understands the authoritative source for each requirement. This skill is for security-specific review; for clean code and architecture concerns, use `best-practices-audit` instead.

## Scope

Determine what to audit based on user request and context:

- **Git diff mode** (default when no scope specified and changes exist): run `git diff` and `git diff --cached` to audit only changed/added code and its immediate context
- **File/directory mode**: audit the files or directories the user specifies
- **Full audit mode**: when the user asks for a full security review, scan all source code (skip vendor/node_modules/build artifacts); prioritize files touching auth, payments, database, and external integrations

Read all in-scope code before producing findings.

## Domains to Evaluate

Check each domain. Skip domains with no findings. See [REFERENCE.md](REFERENCE.md) for detailed definitions, standard IDs, and concrete examples.

### 1. Authentication & Session Management
*(OWASP A07:2025, CWE-287, CWE-384)*

- Using `getSession()` instead of server-side `getUser()` for auth decisions (JWT trusting without server validation)
- Missing token expiry enforcement; long-lived tokens without rotation
- Weak or missing logout (session not invalidated server-side)
- OAuth state parameter missing or not validated (CSRF on OAuth flows)
- Trusting client-provided user identity without server-side verification
- Credentials stored in localStorage instead of httpOnly cookies

### 2. Authorization & Access Control
*(OWASP A01:2025, OWASP API2:2023, CWE-284, CWE-639)*

- BOLA/IDOR: object IDs accepted from user input without ownership verification
- Missing Row-Level Security (RLS) policies on database tables
- Privilege escalation paths: routes or RPCs accessible to roles that shouldn't have access
- Broken function-level auth: admin/internal endpoints not restricted by role
- REVOKE gaps: functions or tables accessible to PUBLIC or anon when they shouldn't be
- Assuming the presence of a valid JWT implies authorization (JWT ≠ authz check)

### 3. Injection
*(OWASP A05:2025, CWE-89, CWE-79, CWE-77, CWE-94)*

- **SQL injection**: raw string interpolation in queries; use parameterized queries or an ORM
- **XSS**: unsanitized user content inserted into HTML; missing `Content-Security-Policy`
- **Command injection**: user input passed to shell commands, `exec()`, `eval()`, `Function()`
- **Template injection**: user-controlled strings rendered by a template engine
- **Schema pollution (PostgreSQL)**: SECURITY DEFINER functions without `SET search_path = ''`; attacker-controlled schemas prepended to search path

### 4. Cryptography & Secrets
*(OWASP A04:2025, CWE-327, CWE-798, CWE-312, CWE-321)*

- Hardcoded credentials, API keys, tokens, or secrets in source code or `.env.example`
- Secrets in environment variables loaded client-side (exposed in browser bundles)
- Weak hashing algorithms (MD5, SHA-1) used for security purposes
- Tokens or sensitive data stored in plaintext in the database instead of a secrets vault
- Missing HTTPS enforcement; secrets transmitted over HTTP
- JWT secrets that are short, guessable, or shared across environments

### 5. Input Validation & Output Encoding
*(CWE-20, CWE-116, CWE-601, OWASP A05:2025)*

- No schema validation (Zod, Yup, JSON Schema, etc.) at API boundaries
- Validation only on the client, not enforced on the server
- Missing length/range constraints on user-supplied strings (no `maxLength`, no `CHECK` constraint)
- Missing content-type validation on file uploads
- Open redirects: user-controlled URL passed directly to redirect without allowlist validation
- Missing `encodeURIComponent` on user data placed in URLs

### 6. API Security
*(OWASP API Top 10 2023)*

- **API1 — BOLA**: resources returned or modified by user-supplied ID without ownership check
- **API2 — Broken Auth**: unprotected endpoints, missing JWT verification, bearer token in URL
- **API3 — Broken Object Property Level Auth**: response includes fields (e.g. `role`, `coins`, `internal_id`) that the caller should not see
- **API4 — Unrestricted Resource Consumption**: no rate limiting, pagination, or request size limits
- **API5 — Broken Function Level Auth**: non-public actions (admin, delete, ban) not verified against caller's role
- **API7 — SSRF**: URL parameters or webhook URLs accepted from user input without allowlist validation
- **API8 — Security Misconfiguration**: permissive CORS (`*`), verbose error messages leaking stack traces or schema details, debug endpoints in production
- **API10 — Unsafe Consumption of APIs**: external API responses trusted without validation; webhooks not verified via HMAC signature

### 7. Database Security
*(CWE-250, CWE-284, PostgreSQL Security Best Practices)*

- Tables created without `ENABLE ROW LEVEL SECURITY`
- Missing `REVOKE EXECUTE` on SECURITY DEFINER functions from `PUBLIC`, `authenticated`, `anon`
- SECURITY DEFINER functions without `SET search_path = ''` (schema pollution vector)
- Missing `REVOKE TRUNCATE` on financial, audit, or compliance tables
- Overly permissive RLS policies (e.g., `USING (true)` on sensitive tables)
- Direct client-to-database connections bypassing application security layer
- Sensitive columns (tokens, PII) stored in plaintext instead of encrypted columns or vault references
- Missing `CHECK` constraints on financial columns (e.g., balance `>= 0`, amount sign validation)

### 8. Rate Limiting & Denial-of-Service
*(OWASP API4:2023, CWE-770, CWE-400)*

- No rate limiting on authentication endpoints (brute force enabler)
- No rate limiting on expensive operations (sync, export, AI calls, file uploads)
- Rate limits implemented in-memory per process/isolate (bypassed by horizontal scaling or redeployment)
- Missing request body size limits (memory exhaustion)
- Unbounded database queries without `LIMIT` clause (full table scan DoS)
- No backoff or circuit breaker for outbound calls to third-party services

### 9. Concurrency & Race Conditions
*(CWE-362, CWE-367 TOCTOU)*

- Check-then-act patterns on financial or inventory data without database-level locking
- Double-spend or double-grant risk: no idempotency key or `ON CONFLICT DO NOTHING` guard
- Missing advisory locks or `SELECT FOR UPDATE` on critical rows during multi-step transactions
- Non-atomic read-modify-write sequences on shared state (coin balance, stock count, etc.)
- Idempotency keys that can be `NULL` (treated as distinct by PostgreSQL UNIQUE, allowing bypass)

### 10. Financial & Transaction Integrity
*(PCI-DSS Req 6 & 10, CWE-362)*

- Client-side coin/credit/reward calculation (any value trusted from client is a vulnerability)
- Missing `CHECK` constraint on transaction amount sign (credits vs. debits not enforced at DB level)
- Coin or balance modification without an audit trail (append-only transaction log)
- Webhook events not deduplicated by a provider-assigned event ID (replay attack enabler)
- Webhook signature not verified (unauthenticated financial state changes)
- Deletion of financial transaction records (violates audit trail requirements; potential legal violation)
- Missing `NOT NULL` on idempotency key column for transaction tables

### 11. Security Logging & Monitoring
*(OWASP A09:2025, CWE-778, CWE-117)*

- Security-relevant events not logged (auth failures, permission denials, validation failures, HMAC failures)
- Log injection: unsanitized user input included directly in log messages
- Sensitive data (passwords, tokens, card numbers, PII) written to logs
- No structured logging — free-text logs that can't be queried or alerted on
- Missing correlation between security events and user/request IDs
- No alerting or anomaly detection on suspicious event patterns
- Logs stored in a volatile medium (in-memory, ephemeral filesystem) that survives restarts but not scaling events

### 12. Secrets & Environment Security
*(CWE-798, CWE-312, 12-Factor App)*

- Secrets committed to git (`.env`, private keys, API tokens in source files)
- Fallback to insecure defaults when env vars are absent (e.g., CORS origin falling back to `*`)
- Using the same secrets across development, staging, and production environments
- Secrets logged or included in error messages
- Client-side environment variables (prefixed `VITE_`, `NEXT_PUBLIC_`, etc.) containing server-side secrets
- Secrets passed as CLI arguments (visible in process list)

### 13. Data Privacy & Retention
*(GDPR Art. 5/17/25, CCPA, CWE-359)*

- PII stored longer than necessary (no retention policy or purge cron)
- No anonymization path for account deletion (right to erasure, GDPR Art. 17)
- PII in logs, error messages, or analytics events that shouldn't be there
- Missing `ON DELETE SET NULL` or equivalent for user-linked tables that must survive account deletion
- Financial records with FK `ON DELETE CASCADE` that would purge legally required audit evidence
- No consent record for data collection (GDPR Art. 6)
- User data returned in API responses without field-level access checks (over-fetching)

### 14. Security Misconfiguration
*(OWASP A02:2025, CWE-16)*

- Permissive CORS (reflecting request `Origin` without validation + `Access-Control-Allow-Credentials: true`)
- Missing `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options` headers
- HTTP used instead of HTTPS; missing HSTS header
- Debug/development endpoints or verbose error responses in production
- Default credentials or example configurations deployed
- Database or storage buckets with public access that should be private
- Missing `SameSite` attribute on session cookies
- JWT verification disabled on functions that handle authenticated user data

### 15. Supply Chain & Dependency Security
*(OWASP A03:2025, CWE-1357)*

- Dependencies with known CVEs (run `npm audit`, `pip audit`, `bun audit`)
- Unpinned dependency versions (`*`, `latest`, `^` for production dependencies)
- Dependencies pulled from non-official registries without integrity hashing
- Dev dependencies installed in production containers
- Missing integrity subresource hashing on CDN-loaded scripts

### 16. TypeScript / JavaScript Specific
*(CWE-843 Type Confusion, CWE-915 Improperly Controlled Modification)*

- `as any` or `as unknown as T` casts that bypass type checking on externally-sourced data
- Prototype pollution: `Object.assign(target, userControlledObject)` or spread of unvalidated input onto objects
- `eval()`, `new Function()`, `setTimeout(string)`, or `innerHTML =` with user-controlled content
- `JSON.parse()` result used without validation (treat parsed JSON as `unknown`, not `any`)
- Arithmetic on `bigint` and `number` without explicit conversion (silent precision loss)
- Async functions missing `await` on promises that should be awaited (unhandled rejection, ordering bug)

## Static Analysis Tools

Before producing findings, **run available tools** on in-scope code. Incorporate tool output into your findings (cite the tool rule alongside the standard ID).

### npm / bun audit (dependency vulnerabilities)
```bash
npm audit --audit-level=moderate    # or: bun audit
```
Map findings to **OWASP A03:2025** and the specific CVE ID.

### ESLint with security plugins
```bash
# Check for eslint-plugin-security in devDependencies first
npx eslint src/
```
Key rules to look for: `security/detect-object-injection`, `security/detect-non-literal-regexp`, `no-eval`, `no-implied-eval`.

### Semgrep (if available)
```bash
semgrep --config=p/owasp-top-ten .
semgrep --config=p/typescript .
```

### Ruff with Bandit rules (Python)
```bash
ruff check --select S .   # Bandit security rules
```

### How to use tool output
1. Map each tool finding to its security domain (e.g., a SQL injection ESLint rule → Domain 3: Injection).
2. Critical CVEs or injection/auth findings → **Critical**. Outdated deps with low-severity CVEs → **Warning** or **Suggestion**.
3. If a tool is not present or produces no findings, note "npm audit: clean" etc. in the Summary.

## API & Tech Stack Verification

Before finalizing findings, verify security-relevant API and SDK usage against official documentation:

- **Look up official docs**: If the code uses a specific SDK, API, or service (e.g. Supabase auth, Stripe, OAuth providers), consult the official documentation to confirm the correct security usage pattern. Do not rely on training knowledge — APIs change, and incorrect usage is frequently a **Critical** security flaw that looks correct to a code reviewer.
- **Use available MCP tools**: Check if available MCP tools (Supabase MCP, Vercel MCP, etc.) can provide faster or more authoritative access to official docs.
- **Wrong API usage = security finding**: If code uses an API in a non-standard or incorrect way that bypasses security controls (e.g. trusting client-side session data instead of server-side verification), it **must** be reported as a finding at the appropriate severity — not treated as a style issue.

## False Positive Filtering

Before including any finding in the report, apply these filters in order. A report with 3 real findings is more valuable than one with 3 real findings buried in 12 noise items.

### Hard Exclusions

Automatically exclude findings that match these categories — do not report them even as Low:

1. **Pure DoS / resource exhaustion** without an auth bypass or data-integrity component. Domain 8 items belong in the report only when combined with another vulnerability class (e.g., unbounded query + missing auth = Critical, unbounded query alone = excluded).
2. **Theoretical race conditions** without a concrete exploitation path. Only report a race condition if you can describe the specific interleaving of requests that causes harm (e.g., double-spend). "This read-modify-write *could* race" is not a finding.
3. **Outdated dependency versions** — these are surfaced by `npm audit` / `bun audit` output in the Summary section. Do not create individual findings for known CVEs in third-party libraries; that is the dependency scanner's job.
4. **Missing hardening with no attack vector** — e.g., "should add CSP header" when there is no XSS vector in the application, or "should add rate limiting" on an internal-only endpoint. A missing defense layer is only a finding when the attack it defends against is actually possible.
5. **Test-only code** — unit tests, fixtures, test helpers, mocks, and seed scripts. Exception: test files that contain real secrets or credentials.
6. **Log spoofing / unsanitized log output** — unless the log output feeds a downstream system that parses and acts on log content (SIEM injection, log-based alerting bypass).
7. **Regex injection / ReDoS** — unless the regex runs on untrusted input in a hot path with no timeout and you can demonstrate catastrophic backtracking.
8. **Documentation-only files** — markdown, JSDoc comments, README content. These are not executable.
9. **Client-side validation gaps when server-side validation exists** — missing Zod schema in a React form is a UX concern, not a security finding, if the API endpoint validates the same input.
10. **SSRF limited to path control** — only report SSRF when the attacker can control the host or protocol. Path-only SSRF is not exploitable in practice.
11. **Memory safety issues in memory-safe languages** — buffer overflows, use-after-free, etc. are impossible in TypeScript, Python, Go, Rust, and Java. Do not report them.
12. **Secrets or credentials stored on disk** if they are otherwise secured (e.g., encrypted at rest, in a secrets vault, or managed by a dedicated process).

### Framework & Language Precedents

These are established rulings — patterns that are NOT vulnerabilities by themselves:

1. **React / Angular / Vue are XSS-safe by default.** Only flag XSS when using `dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`, `v-html`, `[innerHTML]`, or equivalent escape hatches. Normal JSX interpolation (`{userInput}`) is auto-escaped.
2. **UUIDs (v4) are unguessable.** Don't flag UUID-based resource access as IDOR unless the real issue is missing ownership verification (the problem is the missing WHERE clause, not the identifier format).
3. **Environment variables and CLI flags are trusted input.** Attacks requiring attacker-controlled env vars are invalid in standard deployment models. Do not flag `process.env.X` as "unsanitized input."
4. **Client-side code does not need auth checks.** The backend is responsible for authorization. Missing permission guards in React components, API client wrappers, or frontend route guards are not security findings — they are UX decisions.
5. **GitHub Actions: most injection vectors are not exploitable.** Only flag when untrusted input (PR title, branch name, issue body, commit message) flows into `run:` steps via `${{ }}` expression injection without intermediate sanitization.
6. **Jupyter notebooks run locally.** Only flag if untrusted external input reaches code execution, not just because a cell calls `eval()` on a hardcoded string.
7. **Shell scripts with no untrusted input are safe.** Command injection requires untrusted user input flowing into the script. Scripts that only process env vars, hardcoded paths, or pipeline-internal values are not vulnerable.
8. **`JSON.parse()` is not a vulnerability.** Only a finding if the parsed result is used without validation in a security-critical path (auth decisions, financial calculations, SQL query construction).
9. **Logging non-PII data is safe.** Only report logging findings when secrets (passwords, tokens, API keys) or personally identifiable information is written to logs. Logging URLs, request metadata, or error messages is not a vulnerability.

### Confidence Gate

Before including any finding, answer these three questions:

1. **Concrete attack path?** Can you describe the specific HTTP request, API call, or user action an attacker would use? If not, it's a code smell, not a finding.
2. **Reasonable disagreement?** Could a competent security engineer argue this is not a vulnerability given the application's threat model? If yes, downgrade to a "Needs Investigation" note in the Summary.
3. **Specific location?** Does the finding have an exact file path, line number, and reproduction scenario? Vague findings ("the app should use HTTPS somewhere") are not actionable and must be excluded.

If any question raises doubt, do not report it as a formal finding. Instead, add a brief "Needs Investigation" note in the Summary section so the developer is aware without the noise.

## Output Format

Group findings by severity. Each finding **must** name the specific standard violated.

```
## Critical
Violations that are directly exploitable or enable data theft, privilege escalation, or financial fraud.

### [DOMAIN] Brief title
**File**: `path/to/file.ts` (lines X–Y)
**Standard**: OWASP A01:2025 / CWE-639 — one-line description of what the standard requires.
**Violation**: What the code does wrong and the concrete attack scenario.
**Fix**: Specific, actionable code change or architectural remedy.

## High
Violations that create significant risk but require specific conditions or chaining to exploit.

(same structure)

## Medium
Defense-in-depth gaps, missing controls, or violations that increase attack surface.

(same structure)

## Low
Best-practice deviations, hardening opportunities, or compliance gaps unlikely to be directly exploited.

(same structure)

## Needs Investigation (optional)
Brief notes on patterns that warrant a closer look but did not pass the Confidence Gate. These are not formal findings.

## Summary
- Total findings: N (X critical, Y high, Z medium, W low)
- Highest-risk area: name the domain with the most severe findings
- Key standards violated: list specific OWASP/CWE IDs
- Overall security posture: 1–2 sentence verdict
- Recommended immediate action: the single most urgent fix
```

## Verification Pass

Before finalizing your report, verify every finding:

1. **Re-read the code**: Go back to the flagged file and re-read the flagged lines in full context (±20 lines). Confirm the issue actually exists — not a misread, not handled elsewhere in the same file, not guarded by middleware, a wrapper, or a parent function.
2. **Check for existing mitigations**: Search the codebase for related patterns. Is the "missing" check done in a shared middleware, auth wrapper, API gateway, or configuration file? If so, drop the finding.
3. **Verify against official docs**: For every standard or API you cite, confirm your interpretation is correct. If you're unsure whether a pattern constitutes a real vulnerability, look it up — don't guess. Use available tools (context7, web search, REFERENCE.md, Supabase MCP, etc.) to check current documentation when uncertain.
4. **Filter by confidence**: If you're certain a finding is a false positive after re-reading, drop it entirely. If doubt remains but the issue seems plausible, move it to "Needs Investigation" in the report — don't include it as a formal finding.

## Rules

- **Cite the standard**: every finding must reference a specific standard ID (OWASP A-code, CWE-NNN, GDPR Art. N, PCI-DSS Req. N). This is the core value of this skill.
- **Model the attack**: every Critical or High finding must describe the realistic attack scenario, not just the code smell.
- **Be specific**: always cite file paths and line numbers.
- **Be actionable**: every finding must include a concrete fix — not "add validation" but "use a Zod schema on the request body and reject with 400 if it fails."
- **Severity by exploitability**: rate severity by real-world exploitability and impact, not theoretical worst-case. A missing CSP header with no XSS vector is Low at most. A SQL injection in a public endpoint is Critical regardless of whether a WAF might catch it.
- **Don't duplicate best-practices-audit**: focus on security vulnerabilities and compliance gaps. Architecture and clean code issues belong in the other skill.
- **Minimize false positives**: Apply the False Positive Filtering rules (Hard Exclusions, Framework Precedents, Confidence Gate) before including any finding. When uncertain, add a "Needs Investigation" note in the Summary rather than reporting a formal finding. A clean report with 3 real findings is more valuable than one with 3 real findings buried in 12 noise items.
- **Verify API usage against official docs**: Do not assume an API or SDK is being used correctly based on training knowledge. If the code uses a specific SDK or service, look up the official documentation (using MCP tools where available) and verify the security-relevant usage pattern is correct. Incorrect API usage that bypasses security controls is a **Critical** finding.
- **Defense-in-depth counts**: a control missing a second layer of enforcement (e.g., RLS present but no CHECK constraint) is a Medium finding even if the first layer is sound.
