'use strict';

const { decide } = require('../lib/mirror-policy');
const { clampUtf8 } = require('../lib/discord-sanitize');
const { SHORT_ID_LEN } = require('../lib/constants');

// Discord message cap is 2000. We truncate to 1800 to leave room for:
//   - severity prefix emoji + space (≤ 5 bytes)
//   - short-ID suffix " (abc12345)" (≤ 16 bytes)
//   - closing code fence if truncation split one (4 bytes)
//   - a tiny "…" marker (3 bytes)
const CONTENT_CAP = 1800;

const SEVERITY_EMOJI = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🛑',
  error: '🛑'
};

/**
 * Formats a bus event as a Discord message body and decides where it goes.
 *
 * Uses lib/mirror-policy.decide() under the hood so bridge routing stays
 * consistent with the declarative policy. Returns { content: null, action:
 * 'silent' } for silent/never outcomes so the caller can uniformly skip.
 *
 * @param {object} event - Bus event (requires type, body; may include from,
 *   to, meta, severity).
 * @param {object} [policyConfig] - Mirror policy map (result of
 *   mergePolicy). Defaults to DEFAULT_POLICY.
 * @returns {{ content: string|null, action: string, target_session_id?: string }}
 */
function formatEvent(event, policyConfig) {
  const decision = decide(event, policyConfig);

  if (decision.action === 'silent' || decision.action === 'never') {
    return { content: null, action: 'silent' };
  }

  // rename_thread doesn't post content — caller should dispatch the rename
  // via discord/threads.js. We still return a label so callers can inspect.
  if (decision.action === 'rename_thread') {
    return {
      content: null,
      action: 'rename_thread',
      target_session_id: decision.target_session_id
    };
  }

  const content = buildContent(event, decision.severity);
  return {
    content,
    action: decision.action,
    ...(decision.target_session_id ? { target_session_id: decision.target_session_id } : {})
  };
}

/**
 * Builds the message body: `<emoji> [<type>] <body> — <sender> (<shortId>)`
 *
 * Truncates at CONTENT_CAP without breaking UTF-8 sequences and closes any
 * orphaned ``` code fence so Discord doesn't render half a code block.
 */
function buildContent(event, severity) {
  const emoji = SEVERITY_EMOJI[severity] || SEVERITY_EMOJI.info;
  const body = typeof event.body === 'string' ? event.body : '';
  const from = typeof event.from === 'string' ? event.from : '';
  const shortId = from.substring(0, SHORT_ID_LEN);
  const typeLabel = event.type ? '[' + event.type + '] ' : '';
  const prefix = emoji + ' ' + typeLabel;
  const suffix = shortId ? ' — ' + shortId : '';

  // Reserve space in the cap for prefix + suffix so the visible body
  // survives truncation predictably.
  const bodyCap = CONTENT_CAP - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8');
  let clamped = clampUtf8(body, Math.max(0, bodyCap));
  let ellipsis = '';
  if (clamped.length < body.length) ellipsis = '…';

  clamped = closeOpenCodeFence(clamped);

  return prefix + clamped + ellipsis + suffix;
}

/**
 * If the string has an odd number of ``` markers, appends a closing ``` so
 * the final message doesn't leak into surrounding Discord UI as a code block.
 */
function closeOpenCodeFence(str) {
  const fences = (str.match(/```/g) || []).length;
  if (fences % 2 === 1) {
    return str + '\n```';
  }
  return str;
}

module.exports = { formatEvent, CONTENT_CAP, SHORT_ID_LEN, SEVERITY_EMOJI };
