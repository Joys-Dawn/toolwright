// Deterministic (category, scope) fallback for facts that arrive untagged
// (explicit retain, bootstrap, tests). Returns null when nothing fires
// (caller defaults to fact/project).
//
// English-only: the cue regexes match English word forms, so non-English
// content returns null. Acceptable because the PRIMARY path is the
// multilingual dream-cycle LLM tagging facts explicitly.

const PREFERENCE_CUES = [
  /\bthe user (prefers?|wants?|likes?|expects?|asks?)/i,
  /\bi (prefer|want|like|expect)/i,
  /\bdo not (use|run|do|add|include)/i,
  /\bnever (commit|push|use|do)/i,
  /\balways (use|do|run)/i,
  /\bI(?:'m| am) the user\b/i,
];

// Role alternations built from CANONICAL_ROLES so a new role in
// role-prompts.js auto-wires into categorization. Generic verbs resolve
// through VERB_TO_ROLE at extraction time.
import { CANONICAL_ROLES } from './role-prompts.js';
const ROLE_ALTERNATION = CANONICAL_ROLES.join('|');
const VERB_ALTERNATION = 'planning|implementing|reviewing|auditing|consolidating|testing';
const PROCEDURAL_CUES = [
  new RegExp(`\\bwhen (?:${VERB_ALTERNATION})`, 'i'),
  new RegExp(`\\b(${ROLE_ALTERNATION}) (?:should|must|will|prefers)`, 'i'),
  /\brole[- ]?(?:procedural|specific)/i,
  /\bthis (?:role|peer|agent) (?:should|must|does)/i,
];

// Extract WHICH role a procedural cue is about (capture group 1).
const PROCEDURAL_ROLE_EXTRACTORS = [
  new RegExp(`\\bwhen (${ROLE_ALTERNATION}) (?:is|are)`, 'i'),
  new RegExp(`\\bwhen (${VERB_ALTERNATION})`, 'i'),
  new RegExp(`\\b(${ROLE_ALTERNATION}) (?:should|must|will|prefers|does)`, 'i'),
];

const VERB_TO_ROLE = {
  planning: 'planner',
  implementing: 'implementer',
  reviewing: 'reviewer',
  auditing: 'reviewer',
  consolidating: 'consolidator',
  testing: 'tester',
};

const PROJECT_FACT_CUES = [
  /\b(repo|repository|project|codebase|module|service|api|library)\b/i,
  /\b(uses|implements|depends on|requires)\b/i,
  /\b[A-Z]\w+(?:Service|Manager|Controller|Component|Module|Client)\b/,
];

const EPISODIC_CUES = [
  /\bI claimed .* without checking\b/i,
  /\b(?:was|were) wrong\b/i,
  /\bthe \d{4}-\d{2}-\d{2}\b/, // "the <ISO date> incident"
  /\b(?:incident|outage|regression|post[- ]mortem)\b/i,
  /\b(?:lessons? learned|in retrospect)\b/i,
];

function extractRoleFromText(text) {
  for (const re of PROCEDURAL_ROLE_EXTRACTORS) {
    const m = text.match(re);
    if (m && m[1]) {
      const token = m[1].toLowerCase();
      if (VERB_TO_ROLE[token]) return VERB_TO_ROLE[token];
      return token;
    }
  }
  return null;
}

// Returns { category, scope } or null (nothing fired). An explicit `role`
// with no preference cue yields procedural / role:<role>.
export function categorize(text, { role = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

  for (const re of PREFERENCE_CUES) {
    if (re.test(text)) return { category: 'fact', scope: 'user' };
  }

  for (const re of EPISODIC_CUES) {
    if (re.test(text)) return { category: 'episodic', scope: 'project' };
  }

  for (const re of PROCEDURAL_CUES) {
    if (re.test(text)) {
      const inferred = role || extractRoleFromText(text);
      return inferred
        ? { category: 'procedural', scope: `role:${inferred}` }
        : { category: 'procedural', scope: 'project' };
    }
  }
  if (role) {
    return { category: 'procedural', scope: `role:${role}` };
  }

  for (const re of PROJECT_FACT_CUES) {
    if (re.test(text)) return { category: 'fact', scope: 'project' };
  }

  return null;
}
