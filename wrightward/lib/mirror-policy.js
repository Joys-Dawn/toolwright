'use strict';

/**
 * Mirror policy for Phase 3 Discord bridge.
 *
 * Pure function — given a bus event and a policy config, returns an action
 * the bridge should take (post to thread, post to broadcast, rename the
 * session's thread, stay silent, or never mirror).
 *
 * Design:
 *   - `silent`  → don't post, but user can override to a mirror action.
 *   - `never`   → don't post AND hard-rail: user cannot elevate internal
 *                 bookkeeping events (ack, interest, delivery_failed,
 *                 rate_limited) to a mirror action.
 *   - Unknown event types default to `silent` — safer than post_broadcast
 *     since a new type could leak internal state before the bridge knows
 *     how to format it.
 */

const DEFAULT_POLICY = Object.freeze({
  user_message:    { action: 'post_thread', severity: 'info' },
  handoff:         { action: 'post_thread', severity: 'info' },
  blocker:         { action: 'post_thread', severity: 'warn' },
  file_freed:      { action: 'post_thread_if_targeted', severity: 'info' },
  session_started: { action: 'post_broadcast', severity: 'info' },
  session_ended:   { action: 'post_broadcast', severity: 'info' },
  note:            { action: 'silent' },
  finding:         { action: 'silent' },
  decision:        { action: 'silent' },
  context_updated: { action: 'rename_thread' },
  interest:        { action: 'never' },
  ack:             { action: 'never' },
  delivery_failed: { action: 'never' },
  rate_limited:    { action: 'never' }
});

// Types that cannot be elevated to a mirror action. User config may demote
// them to silent (still won't post), but cannot promote to post_*. Prevents
// the user from accidentally mirroring internal ack/interest churn.
const HARD_RAIL_TYPES = new Set(['interest', 'ack', 'delivery_failed', 'rate_limited']);

const VALID_ACTIONS = new Set([
  'post_thread',
  'post_thread_if_targeted',
  'post_broadcast',
  'rename_thread',
  'silent',
  'never'
]);

const MIRROR_ACTIONS = new Set(['post_thread', 'post_thread_if_targeted', 'post_broadcast', 'rename_thread']);

/**
 * Merges user policy overrides on top of DEFAULT_POLICY.
 *
 * - Unknown override keys are kept as-is so users can opt into future
 *   event types without upgrading the plugin (bridge will still fall
 *   through to `silent` if it doesn't know the type at decide-time).
 * - Invalid `action` values in an override are ignored (default wins).
 * - HARD_RAIL_TYPES stay `never` unless demoted to `silent` explicitly.
 */
function mergePolicy(userPolicy) {
  const merged = {};
  for (const type of Object.keys(DEFAULT_POLICY)) {
    merged[type] = { ...DEFAULT_POLICY[type] };
  }
  if (!userPolicy || typeof userPolicy !== 'object' || Array.isArray(userPolicy)) {
    return merged;
  }
  for (const [type, override] of Object.entries(userPolicy)) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
    const current = merged[type] || { action: 'silent' };
    let action = VALID_ACTIONS.has(override.action) ? override.action : current.action;
    if (HARD_RAIL_TYPES.has(type) && MIRROR_ACTIONS.has(action)) {
      action = current.action;
    }
    const severity = typeof override.severity === 'string' ? override.severity : current.severity;
    merged[type] = { action, severity };
  }
  return merged;
}

/**
 * Decides how to mirror a bus event to Discord.
 *
 * @param {object} event - Bus event (requires `type`; may include `to`, `from`, `severity`).
 * @param {object} [policyConfig] - Result of mergePolicy. Defaults to DEFAULT_POLICY.
 * @returns {{ action: string, severity: string, target_session_id?: string }}
 */
function decide(event, policyConfig) {
  const policy = policyConfig || DEFAULT_POLICY;
  const rule = policy[event.type] || { action: 'silent' };
  // Policy severity wins so the bridge's display is stable per-type; event
  // severity is kept as a fallback for types whose policy omits severity.
  const severity = rule.severity || event.severity || 'info';

  if (rule.action === 'never' || rule.action === 'silent') {
    return { action: rule.action, severity };
  }

  if (rule.action === 'post_broadcast') {
    return { action: 'post_broadcast', severity };
  }

  if (rule.action === 'post_thread' || rule.action === 'post_thread_if_targeted') {
    // Both need a single-session target to post to a thread. Fallback for an
    // untargeted (broadcast or array) event differs by rule:
    //   post_thread              → promote to broadcast (event stays visible)
    //   post_thread_if_targeted  → silent (e.g. file_freed to "all" is noise;
    //                              only targeted file_freed matters)
    if (typeof event.to === 'string' && event.to !== 'all') {
      return { action: 'post_thread', severity, target_session_id: event.to };
    }
    return {
      action: rule.action === 'post_thread' ? 'post_broadcast' : 'silent',
      severity
    };
  }

  if (rule.action === 'rename_thread') {
    // context_updated: rename the sender's thread to reflect the new task.
    return { action: 'rename_thread', severity, target_session_id: event.from };
  }

  return { action: 'silent', severity };
}

module.exports = {
  DEFAULT_POLICY,
  HARD_RAIL_TYPES,
  VALID_ACTIONS,
  MIRROR_ACTIONS,
  mergePolicy,
  decide
};
