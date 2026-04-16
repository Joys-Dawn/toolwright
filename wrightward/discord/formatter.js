'use strict';

const { decide } = require('../lib/mirror-policy');
const { clampUtf8 } = require('../lib/discord-sanitize');
const { SHORT_ID_LEN } = require('../lib/constants');
const { handleFor } = require('../lib/handles');

// Discord's hard API limit is 2000 chars/message. CONTENT_CAP = 1800 gives
// headroom for the prefix on each chunk (emoji + `**handle**` + `[type]` +
// spaces, or `↳ **handle** (N/N) ` on continuations) plus synthetic code-fence
// close markers when a ``` block straddles a chunk boundary. Every chunk we
// emit is ≤ CONTENT_CAP + fence overhead, which stays under 2000.
const CONTENT_CAP = 1800;

// Safety valve — in the pathological "agent pastes a 1MB blob" case we'd
// otherwise emit hundreds of chunks. Cap at 99 so the (n/N) marker stays
// two-digit and the user isn't buried in Discord posts. Remaining body is
// truncated on the final chunk with an ellipsis.
const MAX_CHUNKS = 99;

const SEVERITY_EMOJI = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🛑',
  error: '🛑'
};

/**
 * Formats a bus event as one or more Discord message bodies and decides where
 * they go. Long bodies are split into ordered chunks; each chunk is ≤ the
 * Discord 2000-byte cap and carries sender attribution so the user can tell
 * who sent a mid-stream chunk without scrolling up.
 *
 * Uses lib/mirror-policy.decide() under the hood so bridge routing stays
 * consistent with the declarative policy. Returns `contents: []` for
 * silent/never/rename_thread outcomes so the caller can uniformly skip.
 *
 * @param {object} event - Bus event (requires type, body; may include from,
 *   to, meta, severity).
 * @param {object} [policyConfig] - Mirror policy map (result of
 *   mergePolicy). Defaults to DEFAULT_POLICY.
 * @param {object} [roster] - agents.json map, consulted for sender handle.
 *   When absent or sender is missing, falls back to derived handle from the
 *   UUID (still deterministic — same UUID always yields the same handle).
 * @returns {{ contents: string[], action: string, target_session_id?: string }}
 */
function formatEvent(event, policyConfig, roster) {
  const decision = decide(event, policyConfig);

  if (decision.action === 'silent' || decision.action === 'never') {
    return { contents: [], action: 'silent' };
  }

  // rename_thread doesn't post content — caller should dispatch the rename
  // via discord/threads.js. We still return the action so callers can inspect.
  if (decision.action === 'rename_thread') {
    return {
      contents: [],
      action: 'rename_thread',
      target_session_id: decision.target_session_id
    };
  }

  const contents = buildContents(event, decision.severity, roster);
  return {
    contents,
    action: decision.action,
    ...(decision.target_session_id ? { target_session_id: decision.target_session_id } : {})
  };
}

/**
 * Renders the sender badge for a Discord message prefix.
 *
 * Resolution: if the event has a `from` sessionId in the roster (or any
 * valid sessionId shape we can derive a handle from), returns `**handle**`.
 * If `from` is absent / synthetic (e.g. `wrightward:runtime`), returns
 * `**system**` so the human reader always sees a source attribution at the
 * top of the message.
 */
function senderBadge(from, roster) {
  if (!from) return '**system**';
  // Synthetic / reserved senders never belong to a real session — label them
  // explicitly rather than running deriveHandle on a non-UUID string.
  if (from === 'wrightward:runtime' || from === '__bridge__') return '**system**';
  const row = roster && typeof roster === 'object' ? roster[from] : undefined;
  try {
    return '**' + handleFor(from, row) + '**';
  } catch (_) {
    // Non-UUID / malformed sender — defensive fallback to a short-ID marker
    // so the message still shows *something* at the top.
    const short = String(from).substring(0, SHORT_ID_LEN);
    return '**???-' + short + '**';
  }
}

/**
 * Builds one or more message bodies. First chunk: `<emoji> **<handle>** [<type>] <body>`.
 * Continuations: `↳ **<handle>** (n/N) <body>`. Sender attribution is at the
 * TOP of every chunk so it survives any scroll position.
 */
function buildContents(event, severity, roster) {
  const emoji = SEVERITY_EMOJI[severity] || SEVERITY_EMOJI.info;
  const body = typeof event.body === 'string' ? event.body : '';
  const from = typeof event.from === 'string' ? event.from : '';
  const badge = senderBadge(from, roster);
  const typeLabel = event.type ? ' [' + event.type + ']' : '';
  const firstPrefix = emoji + ' ' + badge + typeLabel + ' ';
  const contPrefixFn = (n, total) => '↳ ' + badge + ' (' + n + '/' + total + ') ';

  return splitIntoChunks(body, firstPrefix, contPrefixFn, CONTENT_CAP);
}

/**
 * Partitions a body into chunk bodies that fit under `cap` once the first
 * chunk's `firstPrefix` and continuation chunks' `contPrefixFn(n, total)`
 * are prepended. Invariants held across chunks:
 *
 *   - Total UTF-8 byte length of each returned string ≤ cap + fence overhead.
 *   - Each chunk has an even number of ``` markers — if a split falls inside
 *     an open fence, chunk K closes synthetically and chunk K+1 opens a fresh
 *     fence, inheriting the language tag from the opener in the original body.
 *   - No multi-byte UTF-8 sequence is cut in half (clampUtf8 rounds down).
 *   - Sum of the body slices (with reopen markers stripped) reconstructs the
 *     original body — no content is silently dropped, unless MAX_CHUNKS fires.
 */
function splitIntoChunks(body, firstPrefix, contPrefixFn, cap) {
  // Empty body: one chunk with just the prefix (trailing space trimmed).
  if (!body) return [firstPrefix.replace(/\s+$/, '')];

  // Fast path — whole body fits in one chunk, with fence closed if needed.
  const single = firstPrefix + body;
  if (Buffer.byteLength(single, 'utf8') <= cap) {
    return [closeOpenCodeFence(single)];
  }

  // Slow path: multi-chunk. Use a conservative cont-prefix estimate (99/99)
  // so the per-chunk budget is safe regardless of final total. The (n/N)
  // marker is inflated here, but that's byte overhead, not content loss.
  const worstContBytes = Buffer.byteLength(contPrefixFn(99, 99), 'utf8');
  const firstPrefixBytes = Buffer.byteLength(firstPrefix, 'utf8');
  // Fence-close suffix is `\n` + 3 backticks = 4 bytes. Reserve headroom.
  const FENCE_CLOSE_BYTES = 6;

  const slices = [];
  let pos = 0;
  let needReopen = false;
  let reopenLang = '';

  while (pos < body.length && slices.length < MAX_CHUNKS) {
    const isFirst = slices.length === 0;
    const prefixBytes = isFirst ? firstPrefixBytes : worstContBytes;
    // Bytes the fence-reopen prefix will consume on THIS slice (if we
    // inherited an open fence from the previous slice).
    const reopenBytes = needReopen ? 4 + Buffer.byteLength(reopenLang, 'utf8') + 1 : 0;
    const budget = cap - prefixBytes - FENCE_CLOSE_BYTES - reopenBytes;

    if (budget <= 0) {
      // Pathological: prefix alone exceeds cap. Emit a minimal slice to make
      // progress rather than looping forever.
      const emergencyLen = Math.max(1, cap - prefixBytes - 10);
      const chunk = body.substring(pos, pos + emergencyLen);
      pos += chunk.length;
      slices.push(chunk);
      continue;
    }

    const remaining = body.substring(pos);
    const taken = clampUtf8(remaining, budget);
    if (taken.length === 0) {
      // Budget too small for even one character (e.g. 4-byte emoji with
      // budget=3). Take one char raw to guarantee forward progress.
      slices.push(remaining.substring(0, 1));
      pos += 1;
      continue;
    }
    pos += taken.length;

    let sliceText = taken;
    if (needReopen) {
      sliceText = '```' + reopenLang + '\n' + sliceText;
      needReopen = false;
      reopenLang = '';
    }

    // Track fence state at end of this slice.
    const scan = scanFenceState(sliceText);
    if (scan.open) {
      sliceText = sliceText + '\n```';
      if (pos < body.length) {
        needReopen = true;
        reopenLang = scan.lang;
      }
    }

    slices.push(sliceText);
  }

  // MAX_CHUNKS hit with body remaining: append `…` to last chunk so the
  // user knows content was cut. Unlikely in practice (bodies would need to
  // be >99 * CONTENT_CAP ≈ 178KB).
  if (pos < body.length && slices.length > 0) {
    slices[slices.length - 1] = slices[slices.length - 1] + '…';
  }

  const total = slices.length;
  return slices.map((text, i) => (i === 0 ? firstPrefix : contPrefixFn(i + 1, total)) + text);
}

/**
 * Walks a string counting ``` markers. Returns { open, lang } describing the
 * fence state at end: `open=true` means the last marker opened a code block
 * that wasn't closed; `lang` is the language tag from that opener (e.g.
 * "python") or '' if none. Used so chunk K+1 can reopen with the right
 * language tag when a fence straddles a chunk boundary.
 */
function scanFenceState(str) {
  let open = false;
  let lang = '';
  const re = /```(\w*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (open) {
      open = false;
      lang = '';
    } else {
      open = true;
      lang = m[1] || '';
    }
  }
  return { open, lang };
}

/**
 * If the string has an odd number of ``` markers, appends a closing ``` so
 * the final message doesn't leak into surrounding Discord UI as a code block.
 * Used only by the single-chunk fast path; the multi-chunk path tracks fence
 * state explicitly across chunks.
 */
function closeOpenCodeFence(str) {
  const fences = (str.match(/```/g) || []).length;
  if (fences % 2 === 1) {
    return str + '\n```';
  }
  return str;
}

module.exports = {
  formatEvent,
  splitIntoChunks,
  CONTENT_CAP,
  MAX_CHUNKS,
  SHORT_ID_LEN,
  SEVERITY_EMOJI
};
