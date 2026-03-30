# Security Audit — Reference

Detailed definitions, standard sources, violation examples, and fixes for each domain in `SKILL.md`.

---

## 1. Authentication & Session Management
**Standards**: OWASP A07:2025 — Authentication Failures; CWE-287 Improper Authentication; CWE-384 Session Fixation; RFC 6750 Bearer Token Usage

### `getSession()` vs. `getUser()` — OWASP A07:2025

`getSession()` reads the JWT from the client-supplied cookie/header and parses it locally. A tampered or expired JWT can appear valid if clock skew or local validation is used. `getUser()` performs a server-side round-trip to the authorization server, guaranteeing the token is currently valid and the user account has not been revoked.

**Violation pattern (Supabase/TypeScript):**
```ts
// WRONG — trusts client-supplied JWT locally
const { data: { session } } = await supabase.auth.getSession();
const userId = session?.user?.id;
```
**Fix:**
```ts
// CORRECT — server validates the token
const { data: { user }, error } = await supabase.auth.getUser(authHeader);
if (error || !user) return unauthorized();
```

### OAuth State Parameter — CWE-352 CSRF

The OAuth `state` parameter must be a cryptographically random nonce stored server-side (or signed cookie). Without it, an attacker can force a victim to link their account to the attacker's OAuth token.

**Fix**: Generate `state = crypto.randomUUID()`, store in DB or signed cookie with short TTL, validate on callback before exchanging code.

---

## 2. Authorization & Access Control
**Standards**: OWASP A01:2025 — Broken Access Control; OWASP API1:2023 — Broken Object Level Authorization; CWE-284 Improper Access Control; CWE-639 Authorization Bypass Through User-Controlled Key

### BOLA / IDOR

The most prevalent API vulnerability class. Any time a user-controlled identifier (UUID, integer, slug) is used to look up a resource, ownership must be verified server-side — it cannot be assumed from the JWT alone.

**Violation pattern:**
```ts
// WRONG — trusts caller-supplied userId
const { id } = req.body;
const resource = await db.query("SELECT * FROM documents WHERE id = $1", [id]);
return resource; // returns any user's document
```
**Fix:**
```ts
// CORRECT — adds ownership column to WHERE clause
const resource = await db.query(
  "SELECT * FROM documents WHERE id = $1 AND owner_id = $2",
  [id, authenticatedUser.id]
);
if (!resource) return notFound(); // don't reveal existence
```

### Row-Level Security (PostgreSQL)

Every table with user-scoped data must have RLS enabled AND a policy defined. RLS enabled with no policies = no access. RLS disabled = all data visible to any authenticated DB connection.

**Required pattern:**
```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_documents"
  ON documents FOR ALL
  TO authenticated
  USING (owner_id = auth.uid());
```

**High-risk gap**: Financial tables (transactions, payment records) should have RLS but also block UPDATE/DELETE via separate policies or triggers — RLS `FOR ALL` with `USING` only controls SELECT.

---

## 3. Injection
**Standards**: OWASP A05:2025 — Injection; CWE-89 SQL Injection; CWE-79 XSS; CWE-77 Command Injection; CWE-94 Code Injection

### SQL Injection — CWE-89

Any string concatenation or interpolation in a SQL query is potentially exploitable. The fix is always parameterized queries (also called prepared statements).

**Violation:**
```ts
// WRONG
const result = await db.query(`SELECT * FROM users WHERE name = '${name}'`);
```
**Fix:**
```ts
// CORRECT
const result = await db.query("SELECT * FROM users WHERE name = $1", [name]);
```

### Schema Pollution (PostgreSQL SECURITY DEFINER) — CWE-89

A function with `SECURITY DEFINER` runs with the privileges of the function's owner (often a superuser). If `search_path` is not pinned, an attacker who can create schemas may prepend a malicious schema, causing the function to resolve table names to their injected versions.

**Violation:**
```sql
CREATE OR REPLACE FUNCTION credit_coins(uid uuid, amount int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET coins = coins + amount WHERE id = uid;
END;
$$;
```
**Fix:**
```sql
CREATE OR REPLACE FUNCTION public.credit_coins(uid uuid, amount int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''  -- pins search path; no user schema can be injected
AS $$
BEGIN
  UPDATE public.profiles SET coins = coins + amount WHERE id = uid;
END;
$$;
```

### XSS — CWE-79

Never assign user-controlled content to `innerHTML`, `outerHTML`, `document.write()`, or React's `dangerouslySetInnerHTML` without sanitization.

**Violation:**
```ts
element.innerHTML = userInput; // executes embedded <script> tags
```
**Fix:**
```ts
element.textContent = userInput; // text node — never executed as HTML
// If HTML is genuinely needed, use DOMPurify:
element.innerHTML = DOMPurify.sanitize(userInput, { ALLOWED_TAGS: ['b', 'i'] });
```

---

## 4. Cryptography & Secrets
**Standards**: OWASP A04:2025 — Cryptographic Failures; CWE-327 Use of Broken Algorithm; CWE-798 Hardcoded Credentials; CWE-312 Cleartext Storage; NIST SP 800-131A

### Hardcoded Secrets — CWE-798

Any secret in source code is compromised the moment the repo is cloned. Even private repos have been breached.

**Scan for**: `apiKey =`, `password =`, `secret =`, `token =`, `-----BEGIN RSA PRIVATE KEY-----` in `.ts`, `.js`, `.json`, `.toml`, `.yaml` files.

**Fix**: Rotate immediately. Store in environment variables loaded at runtime (never in source), or a secrets manager (HashiCorp Vault, AWS Secrets Manager, Supabase Vault).

### Broken Hash Algorithms — CWE-327

MD5 and SHA-1 are collision-compromised. Never use for password hashing, HMAC, or integrity verification.

- Passwords: use `bcrypt` (cost ≥ 12), `argon2id`, or `scrypt`.
- HMAC: use SHA-256 minimum. `HMAC-SHA256` is the baseline for webhook signatures.
- File integrity: SHA-256 minimum.

### Client-Side Secret Exposure

In Vite: `VITE_*` variables are embedded in the JS bundle and visible to any user who opens DevTools. In Next.js: `NEXT_PUBLIC_*` is the same. Never put API keys or service secrets in these variables.

---

## 5. Input Validation & Output Encoding
**Standards**: CWE-20 Improper Input Validation; CWE-116 Improper Encoding; CWE-601 Open Redirect; OWASP Input Validation Cheat Sheet

### Server-Side Validation is Non-Negotiable

Client-side validation (React form validation, browser `required` attributes) is UX, not security. Any attacker can send raw HTTP requests bypassing the client entirely.

**Required pattern (TypeScript with Zod):**
```ts
const Schema = z.object({
  username: z.string().min(1).max(30),
  amount:   z.number().int().positive().max(10_000),
});

const parsed = Schema.safeParse(req.body);
if (!parsed.success) return badRequest(parsed.error.flatten());
// Use parsed.data — never req.body — downstream
```

### Defense-in-Depth: Database CHECK Constraints

Application validation can be bypassed (direct DB connection, migration mistake, future code path). CHECK constraints are the last line of defense.

```sql
-- Prevents negative balance under any race condition
ALTER TABLE profiles ADD CONSTRAINT chk_coins_non_negative CHECK (coins >= 0);

-- Enforces transaction sign by type
ALTER TABLE coin_transactions ADD CONSTRAINT chk_credit_positive
  CHECK (tx_type NOT IN ('quest_reward', 'purchase') OR amount > 0);
ALTER TABLE coin_transactions ADD CONSTRAINT chk_debit_negative
  CHECK (tx_type NOT IN ('cosmetic_purchase', 'refund') OR amount < 0);
```

### Open Redirect — CWE-601

```ts
// WRONG — attacker crafts ?next=https://evil.com
const next = req.query.next;
res.redirect(next);

// CORRECT — validate against allowlist
const ALLOWED_PATHS = ['/dashboard', '/profile', '/settings'];
const next = req.query.next;
if (!ALLOWED_PATHS.includes(next)) return res.redirect('/dashboard');
res.redirect(next);
```

---

## 6. API Security
**Standards**: OWASP API Security Top 10 2023

### API1:2023 — Broken Object Level Authorization (BOLA)

See Domain 2. Every resource access must verify ownership. This is the #1 API vulnerability.

### API3:2023 — Broken Object Property Level Authorization

APIs often return full database row objects. If the object contains fields the caller should not see (other users' data, internal flags, admin properties), this is a data exposure violation.

**Fix**: Explicitly allowlist fields returned in API responses. Never return `SELECT *` to the client.

```ts
// WRONG
return res.json(userRow); // includes password_hash, role, internal_flags

// CORRECT
return res.json({
  id: userRow.id,
  displayName: userRow.display_name,
  avatarUrl: userRow.avatar_url,
});
```

### API7:2023 — Server-Side Request Forgery (SSRF)

If the application fetches a URL derived from user input, an attacker can target internal services (metadata endpoints, Redis, internal databases).

**Violation:**
```ts
// WRONG — user controls the URL
const data = await fetch(req.body.webhookUrl);
```
**Fix:** Validate URL against a strict allowlist of expected domains. Block private IP ranges (10.x, 172.16.x–172.31.x, 192.168.x, 169.254.x, ::1, fc00::/7).

### API8:2023 — Security Misconfiguration

- CORS origin reflection without validation combined with `Access-Control-Allow-Credentials: true` allows any origin to make credentialed requests.
- Verbose error messages that expose stack traces, SQL query structure, or internal paths.
- Debug endpoints (`/debug`, `/metrics`, `/__admin`) accessible in production.

---

## 7. Database Security
**Standards**: CWE-250 Execution with Unnecessary Privileges; PostgreSQL Security Best Practices; CIS PostgreSQL Benchmark

### Principle of Least Privilege

Every database role should have only the minimum permissions required. The `public` schema grants `CREATE` to all roles by default in PostgreSQL < 15 — revoke this explicitly.

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Then explicitly grant only what each role needs
GRANT SELECT, INSERT ON public.profiles TO authenticated;
```

### REVOKE EXECUTE on SECURITY DEFINER Functions

SECURITY DEFINER functions run as their owner. If PUBLIC or `authenticated` can call them without restriction, any logged-in user can trigger privileged operations.

```sql
-- After defining any SECURITY DEFINER function:
REVOKE EXECUTE ON FUNCTION public.credit_coins(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_coins(uuid, int) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_coins(uuid, int) FROM anon;
-- Re-grant only to service_role or internal callers as needed
```

### REVOKE TRUNCATE on Audit Tables

`TRUNCATE` bypasses RLS and row-level triggers. Any role that can TRUNCATE an audit table can silently destroy evidence.

```sql
REVOKE TRUNCATE ON TABLE public.coin_transactions FROM PUBLIC;
REVOKE TRUNCATE ON TABLE public.coin_transactions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.coin_transactions FROM service_role;
-- Even service_role should not be able to bulk-erase financial records
```

---

## 8. Rate Limiting & Denial-of-Service
**Standards**: OWASP API4:2023 — Unrestricted Resource Consumption; CWE-770 Allocation of Resources Without Limits; CWE-400 Uncontrolled Resource Consumption

### In-Memory Rate Limiting Is Ineffective

Rate limits implemented with an in-process `Map` or `LRU` cache are reset on process restart and are not shared across horizontal replicas. An attacker simply retries after waiting for a cold deploy, or routes requests to different instances.

**Correct approach**: Store rate limit counters in a database (Redis, PostgreSQL) keyed by user ID and action type. The counter must be incremented atomically in the same transaction as the action.

**PostgreSQL pattern:**
```sql
-- Atomic check-and-increment
INSERT INTO rate_limits (user_id, action, window_start, count)
VALUES ($1, $2, date_trunc('minute', now()), 1)
ON CONFLICT (user_id, action, window_start)
DO UPDATE SET count = rate_limits.count + 1
RETURNING count;
-- If returned count > max_allowed, reject with 429
```

### Missing Rate Limits on Auth Endpoints

Authentication endpoints (login, password reset, OTP verification) without rate limiting enable brute-force and credential-stuffing attacks.

**Recommended limits (baseline):**
- Login: 5 attempts per minute per IP
- Password reset: 3 per hour per email
- OTP verification: 3 attempts per code before invalidating

---

## 9. Concurrency & Race Conditions
**Standards**: CWE-362 Concurrent Execution Using Shared Resource with Improper Synchronization (TOCTOU); CWE-367 TOCTOU Race Condition

### Check-Then-Act on Financial Data

The most dangerous race condition pattern in financial systems: read the balance, check if sufficient, then deduct. If two requests run concurrently, both checks pass against the same stale balance.

**Violation:**
```sql
-- Thread 1 and Thread 2 both read balance = 100 at the same time
SELECT coins FROM profiles WHERE id = $1; -- both see 100
-- Both check: 100 >= 50 → true
UPDATE profiles SET coins = coins - 50 WHERE id = $1; -- both run
-- Result: balance = 0 instead of 50. Or worse, -50 if CHECK constraint absent.
```

**Fix — advisory lock + FOR UPDATE:**
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext($1::text)); -- serialize per user
SELECT coins FROM profiles WHERE id = $1 FOR UPDATE; -- lock the row
-- Now deduct safely — only one transaction holds the lock
UPDATE profiles SET coins = coins - $2 WHERE id = $1 AND coins >= $2;
COMMIT;
```

### Idempotency Key Bypass

If an idempotency key column allows `NULL`, PostgreSQL's UNIQUE constraint treats each `NULL` as a distinct value — meaning `NULL` keys do not deduplicate. This allows unlimited replay of reward operations.

```sql
-- WRONG — NULLs are not unique in PostgreSQL
idempotency_key TEXT UNIQUE  -- NULL can appear unlimited times

-- CORRECT
idempotency_key TEXT NOT NULL UNIQUE  -- enforces exactly-once
```

---

## 10. Financial & Transaction Integrity
**Standards**: PCI-DSS v4 Req. 6 (Secure Systems), Req. 10 (Audit Logs); ISO 27001 A.9; CWE-362

### Server-Authoritative Coin Logic

Any value computed or provided by the client that affects financial state is a vulnerability. The server must compute all rewards, deductions, and balances independently.

**Pattern to flag:**
```ts
// WRONG — client tells server how many coins to award
const { userId, coinsEarned } = req.body;
await creditCoins(userId, coinsEarned); // attacker sends coinsEarned = 99999
```

**Correct:** The server computes the reward based on verified activity data (e.g., verified GitHub events), never from a client-supplied amount.

### Append-Only Transaction Log

Coin/credit transaction tables must be immutable after insert. Updates would allow retroactive falsification of balances; deletes destroy the audit trail.

```sql
-- Trigger blocking updates to financial records
CREATE OR REPLACE FUNCTION block_transaction_updates()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Updates to coin_transactions are not permitted';
END;
$$;

CREATE TRIGGER no_update_coin_transactions
BEFORE UPDATE ON coin_transactions
FOR EACH ROW EXECUTE FUNCTION block_transaction_updates();
```

### Webhook Deduplication — Replay Attack

Payment providers may retry webhooks. Without deduplication on the provider's event ID, the same payment event can credit coins multiple times.

```sql
INSERT INTO payment_events (provider_event_id, payload, received_at)
VALUES ($1, $2, now())
ON CONFLICT (provider_event_id) DO NOTHING;
-- Only process coins if INSERT affected 1 row (i.e., event was new)
```

---

## 11. Security Logging & Monitoring
**Standards**: OWASP A09:2025 — Security Logging and Alerting Failures; CWE-778 Insufficient Logging; CWE-117 Log Injection; NIST SP 800-92

### What Must Be Logged

At minimum, log these events with timestamp, user ID, IP address, and action detail:
- Authentication failures (wrong password, expired token, missing auth header)
- Authorization failures (access denied to a resource)
- Input validation failures that look like attacks (unexpected field shapes, oversized inputs)
- Cryptographic verification failures (HMAC mismatch on webhooks)
- Rate limit hits
- Account actions (password change, email change, account deletion)
- Financial anomalies (deduction larger than balance attempted)

### Log Injection — CWE-117

If log messages are constructed using string interpolation with user input, an attacker can inject newlines to forge log entries.

**Violation:**
```ts
logger.info(`User logged in: ${req.body.username}`);
// Attacker sends username = "admin\nSECURITY: Admin password changed"
```
**Fix**: Use structured logging (JSON with separate fields), never string interpolation.
```ts
logger.info({ event: "login", username: req.body.username }); // safe
```

---

## 12. Secrets & Environment Security
**Standards**: CWE-798 Hardcoded Credentials; CWE-312 Cleartext Storage; The Twelve-Factor App (Factor III: Config)

### Env Var Fallback to Insecure Default

A common pattern in "developer-friendly" code is to fall back to a permissive default if an env var is missing. This silently disables security in production if the env var is misconfigured.

**Violation:**
```ts
// WRONG — falls back to wildcard CORS if env var missing
const origin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
```
**Fix:**
```ts
// CORRECT — hard-error on missing config; fail secure
const origin = Deno.env.get("ALLOWED_ORIGIN");
if (!origin) throw new Error("ALLOWED_ORIGIN env var is required");
```

---

## 13. Data Privacy & Retention
**Standards**: GDPR Art. 5 (data minimization), Art. 17 (right to erasure), Art. 25 (privacy by design); CCPA §1798.105; CWE-359 Exposure of Private Information

### Right to Erasure — Account Deletion

On account deletion, the application must:
1. Delete or anonymize personal data (name, email, avatar, IP, user-agent)
2. Retain legally required financial records (PCI-DSS, EU VAT — typically 7–10 years)
3. Preserve abuse/moderation evidence (content reports, security flags)
4. Nullify sender references in shared records (e.g., chat messages become anonymous)

**Critical FK patterns:**
```sql
-- Chat: anonymize messages, don't delete them (conversation history remains intact)
sender_id UUID REFERENCES auth.users(id) ON DELETE SET NULL

-- Transactions: retain for audit; user_id becomes orphaned (no cascade)
user_id UUID  -- intentionally no FK constraint, or FK with ON DELETE SET NULL
```

### Data Minimization — GDPR Art. 5(1)(c)

Do not collect or store more data than necessary. Flag:
- IP addresses stored permanently when 30/90 day retention suffices
- User-agent strings logged indefinitely (personal data under GDPR when combined with other identifiers like IP and timestamps, which is typical in server logs)
- Full request bodies logged when only metadata is needed for debugging
- `SELECT *` queries that pull PII columns into contexts that don't need them

---

## 14. Security Misconfiguration
**Standards**: OWASP A02:2025; CWE-16 Configuration; CIS Benchmarks; OWASP Secure Headers

### Required Security Headers

```
Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

### CORS Misconfiguration

`Access-Control-Allow-Origin: *` allows any origin to read responses to non-credentialed requests. For cookie-based auth, browsers **block** credentialed requests when the wildcard is used (MDN: "If a request includes a credential and the response includes an `Access-Control-Allow-Origin: *` header, the browser will block access to the response"). The more dangerous misconfiguration is **reflecting the request `Origin` header** without validation while setting `Access-Control-Allow-Credentials: true` — this effectively allows any origin to make credentialed requests.

The origin allowlist must be an explicit list of trusted domains, validated server-side. Never reflect the request `Origin` header without verification.

```ts
// WRONG — reflects any origin
const origin = req.headers.get("origin");
headers.set("Access-Control-Allow-Origin", origin ?? "*");

// CORRECT — validate against explicit allowlist
const ALLOWED = new Set(["https://app.example.com"]);
const requestOrigin = req.headers.get("origin") ?? "";
if (ALLOWED.has(requestOrigin)) {
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Vary", "Origin");
}
```

---

## 15. Supply Chain & Dependency Security
**Standards**: OWASP A03:2025 — Software Supply Chain Failures; CWE-1357; SLSA Framework

### Dependency Audit

Run `npm audit` or `bun audit` and treat results as:
- **Critical/High CVEs** → block deployment; patch immediately
- **Moderate CVEs** → fix within the sprint
- **Low CVEs** → fix in next dependency update cycle

### Version Pinning

Use exact versions in `package.json` for production dependencies, or lock with `package-lock.json`/`bun.lockb`. The `^` prefix allows minor version bumps that could introduce regressions or security fixes you haven't reviewed.

---

## 16. TypeScript / JavaScript Specific
**Standards**: CWE-843 Type Confusion; CWE-915 Prototype Pollution; CWE-94 Code Injection; OWASP Cheat Sheet: DOM-based XSS

### Prototype Pollution — CWE-915

Merging user-controlled objects onto existing objects can overwrite properties on `Object.prototype`, affecting all objects in the process.

**Violation:**
```ts
function mergeOptions(defaults: object, userOptions: unknown) {
  return Object.assign(defaults, userOptions); // if userOptions is {"__proto__": {"admin": true}}
}
```
**Fix**: Validate and allowlist the keys of user-controlled objects before merging. Use `Object.create(null)` for dictionaries that must not inherit from `Object.prototype`. Use schema validation (Zod) to strip unknown keys.

### `as any` Type Assertions on External Data — CWE-843

External data (API responses, webhook payloads, database query results typed as `any`, `JSON.parse()` output) must be treated as `unknown` and parsed through a validator before use. Using `as any` or `as ExpectedType` directly bypasses TypeScript's safety guarantees entirely.

```ts
// WRONG
const payload = JSON.parse(body) as WebhookPayload;
creditCoins(payload.userId, payload.amount); // if payload.amount is a string: NaN coins

// CORRECT
const parsed = WebhookPayloadSchema.safeParse(JSON.parse(body));
if (!parsed.success) return badRequest();
creditCoins(parsed.data.userId, parsed.data.amount); // type-safe and validated
```

### Unhandled Promise Rejections — CWE-755

In async TypeScript/JavaScript, a missing `await` means the promise runs in the background and any rejection is silently swallowed (or crashes Node.js). This is especially dangerous in financial operations where you need to know if the DB write succeeded.

```ts
// WRONG — fire-and-forget on a critical operation
logSecurityEvent(userId, "auth_failure"); // rejection silently lost

// CORRECT — await or explicitly handle
await logSecurityEvent(userId, "auth_failure");
// or: void logSecurityEvent(...).catch(err => console.error("Failed to log:", err));
```

