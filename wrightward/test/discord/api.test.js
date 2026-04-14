'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createApi,
  DiscordApiError,
  DiscordNetworkError,
  USER_AGENT,
  ALLOWED_AUTO_ARCHIVE,
  MAX_THREAD_NAME_LEN,
  MAX_MESSAGE_LEN
} = require('../../discord/api');

// Tiny helper: a mock fetch that returns a canned response and records the
// call. Each entry in `queue` is a { status, headers, body } response; or a
// function (url, init) → response for per-call logic.
function makeMockFetch(queue) {
  const calls = [];
  const mock = async (url, init) => {
    calls.push({ url, init });
    const next = typeof queue === 'function' ? queue(url, init, calls.length - 1) : queue.shift();
    if (next == null) throw new Error('mock fetch queue exhausted for ' + url);
    if (next instanceof Error) throw next;
    const headers = new Map(Object.entries(next.headers || {}));
    return {
      status: next.status || 200,
      headers: {
        get(name) {
          // Discord headers are case-insensitive in reality; normalize.
          for (const [k, v] of headers) {
            if (k.toLowerCase() === name.toLowerCase()) return v;
          }
          return null;
        }
      },
      async json() { return JSON.parse(next.body || 'null'); },
      async text() { return next.body || ''; },
      clone() {
        // Clone must return an object that also supports .json() reading.
        const self = this;
        return { async json() { return JSON.parse(next.body || 'null'); } };
      }
    };
  };
  mock.calls = calls;
  return mock;
}

describe('discord/api', () => {
  describe('construction', () => {
    it('requires a non-empty bot token', () => {
      assert.throws(() => createApi('', { fetch: () => {} }), /bot token/);
      assert.throws(() => createApi(null, { fetch: () => {} }), /bot token/);
    });

    it('throws when the provided fetch is not a function', () => {
      // Guards against accidentally passing a truthy non-function (string, object).
      // In Node 18+ global.fetch is always present, so the real-world path for
      // this error is someone passing a bogus fetch override.
      assert.throws(() => createApi('tok', { fetch: 'not a function' }),
        /fetch is not available|fetch/i);
    });
  });

  describe('request headers', () => {
    it('sends Authorization: Bot <token>', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('secret-token', { fetch });
      await api.postMessage('123', 'hi');
      assert.equal(fetch.calls[0].init.headers['Authorization'], 'Bot secret-token');
    });

    it('sends User-Agent starting with DiscordBot', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.postMessage('123', 'hi');
      const ua = fetch.calls[0].init.headers['User-Agent'];
      assert.ok(ua.startsWith('DiscordBot '),
        'User-Agent must start with DiscordBot (Cloudflare block otherwise), got: ' + ua);
      assert.equal(ua, USER_AGENT);
    });

    it('sets Content-Type: application/json on POST with body', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.postMessage('c', 'x');
      assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
    });

    it('does NOT set Content-Type on GET (no body)', async () => {
      const fetch = makeMockFetch([{ status: 200, headers: { 'Content-Type': 'application/json' }, body: '[]' }]);
      const api = createApi('tok', { fetch });
      await api.getMessagesAfter('c');
      assert.equal(fetch.calls[0].init.headers['Content-Type'], undefined);
    });

    it('allows overriding User-Agent via options', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch, userAgent: 'DiscordBot (https://example, 9.9.9)' });
      await api.postMessage('c', 'x');
      assert.match(fetch.calls[0].init.headers['User-Agent'], /9\.9\.9/);
    });
  });

  describe('endpoint wrappers', () => {
    it('postMessage hits POST /channels/:id/messages with content', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.postMessage('111', 'hello');
      const call = fetch.calls[0];
      assert.equal(call.init.method, 'POST');
      assert.match(call.url, /\/channels\/111\/messages$/);
      assert.equal(JSON.parse(call.init.body).content, 'hello');
    });

    it('postMessage sets allowed_mentions:{parse:[]} to suppress @everyone/role pings', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.postMessage('111', '@everyone please review');
      const body = JSON.parse(fetch.calls[0].init.body);
      assert.deepEqual(body.allowed_mentions, { parse: [] },
        'allowed_mentions must force Discord to skip mention parsing');
    });

    it('postMessage rejects content over 2000 chars (MAX_MESSAGE_LEN)', async () => {
      const api = createApi('tok', { fetch: makeMockFetch([]) });
      await assert.rejects(() => api.postMessage('c', 'x'.repeat(MAX_MESSAGE_LEN + 1)), /2000/);
    });

    it('getMessagesAfter hits GET with limit and after params', async () => {
      const fetch = makeMockFetch([{
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '[]'
      }]);
      const api = createApi('tok', { fetch });
      await api.getMessagesAfter('chan', 'msg-1', 25);
      const call = fetch.calls[0];
      assert.equal(call.init.method, 'GET');
      assert.match(call.url, /\/channels\/chan\/messages\?limit=25&after=msg-1$/);
    });

    it('getMessagesAfter defaults limit=50, omits after when not provided', async () => {
      const fetch = makeMockFetch([{
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '[]'
      }]);
      const api = createApi('tok', { fetch });
      await api.getMessagesAfter('chan');
      assert.match(fetch.calls[0].url, /limit=50$/);
    });

    it('createForumThread sends name + auto_archive_duration + message', async () => {
      const fetch = makeMockFetch([{
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'thread-1' })
      }]);
      const api = createApi('tok', { fetch });
      const r = await api.createForumThread('forum-1', 'auth refactor', 'kickoff');
      const body = JSON.parse(fetch.calls[0].init.body);
      assert.equal(body.name, 'auth refactor');
      assert.equal(body.auto_archive_duration, 1440);
      assert.equal(body.message.content, 'kickoff');
      assert.deepEqual(body.message.allowed_mentions, { parse: [] },
        'thread kickoff must suppress @everyone/role pings');
      assert.equal(r.id, 'thread-1');
    });

    it('createForumThread rejects empty name', async () => {
      const api = createApi('tok', { fetch: makeMockFetch([]) });
      await assert.rejects(() => api.createForumThread('f', '', 'body'), /name/);
    });

    it('createForumThread rejects name over MAX_THREAD_NAME_LEN (100)', async () => {
      const api = createApi('tok', { fetch: makeMockFetch([]) });
      await assert.rejects(
        () => api.createForumThread('f', 'x'.repeat(MAX_THREAD_NAME_LEN + 1), 'b'),
        /100/
      );
    });

    it('createForumThread rejects invalid auto_archive_duration', async () => {
      const api = createApi('tok', { fetch: makeMockFetch([]) });
      await assert.rejects(
        () => api.createForumThread('f', 'n', 'b', { auto_archive_duration: 999 }),
        /auto_archive_duration/
      );
    });

    it('createForumThread accepts all documented auto_archive_duration values', async () => {
      for (const d of ALLOWED_AUTO_ARCHIVE) {
        const fetch = makeMockFetch([{ status: 201, headers: {} }]);
        const api = createApi('tok', { fetch });
        await api.createForumThread('f', 'n', 'b', { auto_archive_duration: d });
      }
    });

    it('editChannel hits PATCH /channels/:id with patch body', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.editChannel('thread-1', { name: 'renamed' });
      assert.equal(fetch.calls[0].init.method, 'PATCH');
      assert.match(fetch.calls[0].url, /\/channels\/thread-1$/);
      assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { name: 'renamed' });
    });

    it('archiveThread PATCHes {archived: true}', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      await api.archiveThread('thread-1');
      assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { archived: true });
    });
  });

  describe('rate-limit handling', () => {
    it('honors Retry-After header on 429 and retries', async () => {
      const fetch = makeMockFetch([
        {
          status: 429,
          headers: { 'Retry-After': '0.05', 'X-RateLimit-Scope': 'user' },
          body: '{}'
        },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      const start = Date.now();
      await api.postMessage('c', 'hi');
      const elapsed = Date.now() - start;
      assert.equal(fetch.calls.length, 2, 'expected retry after 429');
      assert.ok(elapsed >= 50, 'should have waited at least 50ms, got ' + elapsed);
    });

    it('honors retry_after JSON body when larger than header', async () => {
      const fetch = makeMockFetch([
        {
          status: 429,
          headers: { 'Retry-After': '0', 'X-RateLimit-Scope': 'user' },
          body: JSON.stringify({ retry_after: 0.05, message: 'rate limited' })
        },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      const start = Date.now();
      await api.postMessage('c', 'hi');
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 50, 'body retry_after should drive wait, got ' + elapsed);
      assert.equal(fetch.calls.length, 2);
    });

    it('uses max(header, body) when both are present', async () => {
      const fetch = makeMockFetch([
        {
          status: 429,
          headers: { 'Retry-After': '0.02', 'X-RateLimit-Scope': 'user' },
          body: JSON.stringify({ retry_after: 0.08 })
        },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      const start = Date.now();
      await api.postMessage('c', 'hi');
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 80, 'should use body 0.08s since it is larger, got ' + elapsed);
    });

    it('treats malformed Retry-After as 0 (does not NaN into an immediate retry loop)', async () => {
      // parseFloat('abc') → NaN. Math.max(NaN, ...) → NaN. setTimeout(NaN) → 0ms.
      // Without the Number.isFinite guard this would retry in a tight loop
      // and burn through MAX_RETRIES against a rate-limited endpoint.
      const fetch = makeMockFetch([
        {
          status: 429,
          headers: { 'Retry-After': 'not-a-number', 'X-RateLimit-Scope': 'user' },
          body: 'not-json'
        },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      // Should resolve (retry with 0 delay) rather than throw / hang on NaN.
      await api.postMessage('c', 'hi');
      assert.equal(fetch.calls.length, 2);
    });

    it('X-RateLimit-Scope: global blocks ALL subsequent requests', async () => {
      const fetch = makeMockFetch([
        {
          status: 429,
          headers: { 'Retry-After': '0.05', 'X-RateLimit-Scope': 'global' },
          body: '{}'
        },
        { status: 204, headers: {} },
        { status: 204, headers: {} } // second request — different endpoint
      ]);
      const api = createApi('tok', { fetch });

      const start = Date.now();
      // Fire two requests on DIFFERENT endpoints. Both should wait for the
      // global timer, not just the first one's bucket.
      await api.postMessage('c', 'hi');
      // This call is on a different bucket. Global scope must delay it.
      const t1 = Date.now();
      await api.editChannel('c2', { name: 'x' });
      const t2 = Date.now();

      // First call took ≥50ms (waited once + retried). Second call should NOT
      // have waited again because global timer already elapsed.
      assert.ok(t1 - start >= 50, 'first 429 should have waited, got ' + (t1 - start));
      assert.ok(t2 - t1 < 20, 'second call should not re-wait, got ' + (t2 - t1));
      assert.equal(fetch.calls.length, 3);
    });

    it('preemptive delay when X-RateLimit-Remaining: 0', async () => {
      const fetch = makeMockFetch([
        // First response tells us we exhausted the bucket, reset in 50ms.
        {
          status: 204,
          headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.05' }
        },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      await api.postMessage('c', 'first');
      const start = Date.now();
      await api.postMessage('c', 'second');
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 50, 'expected preemptive delay, elapsed=' + elapsed);
    });

    it('does NOT preemptively delay when Remaining > 0', async () => {
      const fetch = makeMockFetch([
        { status: 204, headers: { 'X-RateLimit-Remaining': '5', 'X-RateLimit-Reset-After': '10' } },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      await api.postMessage('c', 'first');
      const start = Date.now();
      await api.postMessage('c', 'second');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 50, 'should not delay when quota remains, elapsed=' + elapsed);
    });

    it('honors shared X-RateLimit-Bucket across different paths', async () => {
      // Channel-A call 1 reports bucket H with 1 remaining (5s window).
      // Channel-B call 1 hits the SAME bucket H and empties it (50ms reset).
      // Channel-A call 2 must preemptively delay because A and B now share state.
      // With path-only tracking (the pre-fix behavior), A's state would still
      // read {remaining: 1, reset 5s} and the call would skip the delay,
      // then get 429'd by the server.
      const fetch = makeMockFetch([
        { status: 204,
          headers: { 'X-RateLimit-Bucket': 'H',
                     'X-RateLimit-Remaining': '1',
                     'X-RateLimit-Reset-After': '5' } },
        { status: 204,
          headers: { 'X-RateLimit-Bucket': 'H',
                     'X-RateLimit-Remaining': '0',
                     'X-RateLimit-Reset-After': '0.05' } },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      await api.postMessage('A', 'first');
      await api.postMessage('B', 'first');
      const start = Date.now();
      await api.postMessage('A', 'second');
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 50,
        'path-A must wait on shared bucket exhausted by path-B, elapsed=' + elapsed);
    });

    it('throws DiscordApiError after maxRetries exhausted on 429', async () => {
      // Queue 3× 429 (retryCount=2 means maxRetries=2 means 3 total attempts).
      const fetch = makeMockFetch([
        { status: 429, headers: { 'Retry-After': '0', 'X-RateLimit-Scope': 'user' }, body: '{}' },
        { status: 429, headers: { 'Retry-After': '0', 'X-RateLimit-Scope': 'user' }, body: '{}' },
        { status: 429, headers: { 'Retry-After': '0', 'X-RateLimit-Scope': 'user' }, body: '{}' }
      ]);
      const api = createApi('tok', { fetch, maxRetries: 2 });
      await assert.rejects(() => api.postMessage('c', 'hi'),
        (err) => err instanceof DiscordApiError && err.status === 429);
    });
  });

  describe('error handling', () => {
    it('throws DiscordApiError on 401 (auth) — no retry', async () => {
      const fetch = makeMockFetch([
        { status: 401, headers: {}, body: '{"message":"Unauthorized"}' }
      ]);
      const api = createApi('bad', { fetch });
      await assert.rejects(() => api.postMessage('c', 'hi'),
        (err) => err instanceof DiscordApiError && err.status === 401);
      assert.equal(fetch.calls.length, 1, '401 must NOT retry');
    });

    it('throws DiscordApiError on 403 (forbidden) — no retry', async () => {
      const fetch = makeMockFetch([
        { status: 403, headers: {}, body: '{"message":"Missing Access"}' }
      ]);
      const api = createApi('tok', { fetch });
      await assert.rejects(() => api.postMessage('c', 'hi'),
        (err) => err.status === 403);
      assert.equal(fetch.calls.length, 1);
    });

    it('throws DiscordApiError on 404 — no retry', async () => {
      const fetch = makeMockFetch([
        { status: 404, headers: {}, body: '{"message":"Unknown Channel"}' }
      ]);
      const api = createApi('tok', { fetch });
      await assert.rejects(() => api.postMessage('missing', 'hi'),
        (err) => err.status === 404);
      assert.equal(fetch.calls.length, 1);
    });

    it('retries 5xx with backoff then succeeds', async () => {
      const fetch = makeMockFetch([
        { status: 502, headers: {}, body: 'bad gateway' },
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      await api.postMessage('c', 'hi');
      assert.equal(fetch.calls.length, 2);
    });

    it('retries network errors (fetch throws) with backoff', async () => {
      const fetch = makeMockFetch([
        Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
        { status: 204, headers: {} }
      ]);
      const api = createApi('tok', { fetch });
      await api.postMessage('c', 'hi');
      assert.equal(fetch.calls.length, 2);
    });

    it('wraps network errors as DiscordNetworkError after retries exhausted', async () => {
      const fetch = makeMockFetch(() => { throw new Error('ENOTFOUND'); });
      const api = createApi('tok', { fetch, maxRetries: 1 });
      await assert.rejects(() => api.postMessage('c', 'hi'),
        (err) => err instanceof DiscordNetworkError);
    });

    it('returns null for 204 No Content responses', async () => {
      const fetch = makeMockFetch([{ status: 204, headers: {} }]);
      const api = createApi('tok', { fetch });
      const r = await api.postMessage('c', 'hi');
      assert.equal(r, null);
    });

    it('returns null for non-JSON content types', async () => {
      const fetch = makeMockFetch([
        { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' }
      ]);
      const api = createApi('tok', { fetch });
      const r = await api.postMessage('c', 'hi');
      assert.equal(r, null);
    });
  });
});
