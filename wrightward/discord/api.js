'use strict';

/**
 * Minimal Discord REST client for the Phase 3 bridge daemon.
 *
 * Scope: bot-token authenticated calls only (no OAuth2, no webhooks, no
 * gateway). Built on Node 18+ global fetch with zero external deps.
 *
 * Rate-limit handling (per https://discord.com/developers/docs/topics/rate-limits):
 *   - Reads X-RateLimit-Remaining / X-RateLimit-Reset-After on every response
 *     and preemptively delays the NEXT call when Remaining === 0.
 *   - On HTTP 429: honors max(Retry-After header, retry_after JSON body).
 *     If X-RateLimit-Scope === 'global', sets a process-wide stop-the-world
 *     timer so every subsequent endpoint waits.
 *   - Retries 429 and 5xx up to MAX_RETRIES with exponential backoff.
 *   - Fails fast on 4xx auth/permission errors (401, 403, 404) — retrying an
 *     invalid token would just burn quota.
 */

const DEFAULT_BASE = 'https://discord.com/api/v10';
// User-Agent MUST start with 'DiscordBot' per Discord's API reference —
// generic UAs are Cloudflare-blocked with misleading errors.
const USER_AGENT = 'DiscordBot (https://github.com/Joys-Dawn/toolwright, 3.2.1)';
const MAX_RETRIES = 5;
// Auto-archive duration is an enum — arbitrary values are rejected with 400.
const ALLOWED_AUTO_ARCHIVE = new Set([60, 1440, 4320, 10080]);
const DEFAULT_AUTO_ARCHIVE = 1440; // 1 day
const MAX_THREAD_NAME_LEN = 100;
const MAX_MESSAGE_LEN = 2000;

class DiscordApiError extends Error {
  constructor(status, body, scope) {
    super('Discord API error ' + status + (body ? ': ' + body : ''));
    this.status = status;
    this.body = body;
    this.scope = scope || null;
  }
}

class DiscordNetworkError extends Error {
  constructor(cause) {
    super('Discord network error: ' + (cause && cause.message ? cause.message : String(cause)));
    this.cause = cause;
  }
}

function sleepAsync(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt) {
  // Exponential backoff: 500ms, 1s, 2s, 4s, 8s — with ±25% jitter. Total
  // growth is bounded by MAX_RETRIES (8s + jitter at attempt=5), so an
  // explicit ceiling is unnecessary. If MAX_RETRIES is raised past ~7, add
  // `Math.min(..., 60_000)` back to cap runaway delays.
  const base = 500 * Math.pow(2, attempt);
  const jitter = (Math.random() - 0.5) * base * 0.5;
  return base + jitter;
}

/**
 * Creates a Discord REST client bound to a single bot token.
 *
 * @param {string} botToken
 * @param {object} [options]
 * @param {function} [options.fetch] - fetch implementation (default: global.fetch)
 * @param {string} [options.userAgent]
 * @param {string} [options.baseUrl]
 * @param {number} [options.maxRetries]
 * @param {function} [options.onSuccess] - invoked once after every 2xx/3xx
 *   response. Used by the bridge to arm its circuit-breaker-clear timer only
 *   after a real REST call has succeeded (instead of unconditionally 30s
 *   after startup, which prematurely clears state on a dead-network bridge).
 */
function createApi(botToken, options) {
  options = options || {};
  if (typeof botToken !== 'string' || botToken.length === 0) {
    throw new Error('createApi requires a non-empty bot token');
  }
  const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch : global.fetch);
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available — require Node 18+ or pass options.fetch');
  }
  const userAgent = options.userAgent || USER_AGENT;
  const baseUrl = options.baseUrl || DEFAULT_BASE;
  const maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : MAX_RETRIES;
  const onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;

  // Rate-limit bucket tracking keyed by Discord's canonical `X-RateLimit-Bucket`
  // response header. Multiple paths can share one server-side bucket (e.g.
  // channel-message POSTs on many channels under a common bucket), and
  // path-only keying would miss that shared exhaustion and 429 unexpectedly.
  //
  //   pathToBucketHash: method+path → bucket hash (learned from responses)
  //   buckets: bucket hash (or pathKey fallback before we've seen a response)
  //            → { remaining, resetAt }
  const pathToBucketHash = new Map();
  const buckets = new Map();
  let globalStopUntil = 0;

  function pathKey(method, path) {
    return method + ' ' + path.split('?')[0];
  }

  function bucketIdFor(method, path) {
    const pk = pathKey(method, path);
    return pathToBucketHash.get(pk) || pk;
  }

  async function waitForQuota(method, path) {
    const now = Date.now();
    if (globalStopUntil > now) {
      await sleepAsync(globalStopUntil - now);
    }
    const b = buckets.get(bucketIdFor(method, path));
    if (b && b.remaining <= 0 && b.resetAt > Date.now()) {
      await sleepAsync(b.resetAt - Date.now());
    }
  }

  function trackHeaders(res, method, path) {
    const pk = pathKey(method, path);
    const bucketHash = res.headers.get('X-RateLimit-Bucket') || null;
    const bucketId = bucketHash || pk;
    if (bucketHash) pathToBucketHash.set(pk, bucketHash);
    const rem = res.headers.get('X-RateLimit-Remaining');
    const resetAfter = res.headers.get('X-RateLimit-Reset-After');
    if (rem != null && resetAfter != null) {
      const remInt = parseInt(rem, 10);
      const resetSec = parseFloat(resetAfter);
      if (!isNaN(remInt) && !isNaN(resetSec)) {
        buckets.set(bucketId, {
          remaining: remInt,
          resetAt: Date.now() + resetSec * 1000
        });
      }
    }
  }

  async function readRetryAfter(res) {
    // Coerce defensively: a malformed header (non-numeric string) makes
    // parseFloat return NaN, which propagates through Math.max to NaN, which
    // setTimeout treats as 0 — turning a 429 into a tight retry loop. Strip
    // NaN before the max so we always back off by at least 0s.
    const headerRaw = Number.parseFloat(res.headers.get('Retry-After') || '0');
    const header = Number.isFinite(headerRaw) ? headerRaw : 0;
    let bodyAfter = 0;
    try {
      const body = await res.clone().json();
      if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
        bodyAfter = body.retry_after;
      }
    } catch (_) {
      // Non-JSON body — header-only.
    }
    // Discord's header+body can disagree; community consensus is to use the
    // larger value. NOTE: this code does NOT handle webhook endpoints, where
    // Retry-After is in MILLISECONDS rather than seconds (long-standing bug
    // per https://github.com/discord/discord-api-docs/issues/4043). Extending
    // to webhooks requires per-endpoint unit scaling.
    return Math.max(header, bodyAfter, 0);
  }

  async function request(method, path, body) {
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitForQuota(method, path);

      const headers = {
        'Authorization': 'Bot ' + botToken,
        'User-Agent': userAgent
      };
      const init = { method, headers };
      if (body !== undefined && body !== null) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }

      let res;
      try {
        res = await fetchImpl(baseUrl + path, init);
      } catch (err) {
        lastErr = new DiscordNetworkError(err);
        if (attempt >= maxRetries) throw lastErr;
        await sleepAsync(backoffMs(attempt));
        continue;
      }

      trackHeaders(res, method, path);

      if (res.status === 429) {
        const retryAfter = await readRetryAfter(res);
        const scope = res.headers.get('X-RateLimit-Scope');
        if (scope === 'global') {
          globalStopUntil = Date.now() + retryAfter * 1000;
        }
        if (attempt >= maxRetries) {
          throw new DiscordApiError(429, 'Rate limited (retry_after=' + retryAfter + 's)', scope);
        }
        await sleepAsync(retryAfter * 1000);
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt >= maxRetries) {
          const text = await res.text().catch(() => '');
          throw new DiscordApiError(res.status, text);
        }
        await sleepAsync(backoffMs(attempt));
        continue;
      }

      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        throw new DiscordApiError(res.status, text);
      }

      // Successful REST call — signal to the caller so they can clear any
      // circuit-breaker state. Wrapped in try/catch because a thrown hook
      // shouldn't fail the request that actually succeeded.
      if (onSuccess) { try { onSuccess(); } catch (_) {} }

      if (res.status === 204) return null;
      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) return null;
      try {
        return await res.json();
      } catch (_) {
        return null;
      }
    }

    // Exhausted retries without success or explicit throw — shouldn't hit
    // this path, but guard against it anyway.
    throw lastErr || new Error('request exhausted retries');
  }

  // ------------------------ Endpoint wrappers ------------------------

  async function postMessage(channelId, content) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (content.length > MAX_MESSAGE_LEN) {
      throw new Error('message content exceeds ' + MAX_MESSAGE_LEN + ' chars');
    }
    // allowed_mentions: { parse: [] } — Discord defaults to parsing @everyone,
    // @here, roles and users when the field is omitted. Any bus event body or
    // inbound-relayed message that contained @everyone would ping the guild.
    // Opt-out of all mention resolution by default; explicit relay of a
    // targeted mention would require adding it to `parse` (not a current feature).
    return request('POST', '/channels/' + encodeURIComponent(channelId) + '/messages', {
      content,
      allowed_mentions: { parse: [] }
    });
  }

  async function getMessagesAfter(channelId, afterId, limit) {
    const effLimit = typeof limit === 'number' ? limit : 50;
    const params = new URLSearchParams();
    params.set('limit', String(effLimit));
    if (afterId) params.set('after', afterId);
    return request('GET',
      '/channels/' + encodeURIComponent(channelId) + '/messages?' + params.toString());
  }

  async function createForumThread(forumChannelId, name, content, opts) {
    opts = opts || {};
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('thread name must be a non-empty string');
    }
    if (name.length > MAX_THREAD_NAME_LEN) {
      throw new Error('thread name exceeds ' + MAX_THREAD_NAME_LEN + ' chars');
    }
    const autoArchive = typeof opts.auto_archive_duration === 'number'
      ? opts.auto_archive_duration
      : DEFAULT_AUTO_ARCHIVE;
    if (!ALLOWED_AUTO_ARCHIVE.has(autoArchive)) {
      throw new Error('auto_archive_duration must be one of ' +
        [...ALLOWED_AUTO_ARCHIVE].join(', '));
    }
    return request('POST', '/channels/' + encodeURIComponent(forumChannelId) + '/threads', {
      name,
      auto_archive_duration: autoArchive,
      message: { content: content || '', allowed_mentions: { parse: [] } }
    });
  }

  async function editChannel(channelId, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('editChannel requires a patch object');
    }
    return request('PATCH', '/channels/' + encodeURIComponent(channelId), patch);
  }

  async function archiveThread(threadId) {
    return editChannel(threadId, { archived: true });
  }

  return {
    postMessage,
    getMessagesAfter,
    createForumThread,
    editChannel,
    archiveThread,
    // For testability + diagnostics — do not expose publicly.
    _state: {
      getBuckets: () => new Map(buckets),
      getGlobalStopUntil: () => globalStopUntil
    }
  };
}

module.exports = {
  createApi,
  DiscordApiError,
  DiscordNetworkError,
  USER_AGENT,
  DEFAULT_AUTO_ARCHIVE,
  ALLOWED_AUTO_ARCHIVE,
  MAX_THREAD_NAME_LEN,
  MAX_MESSAGE_LEN
};
