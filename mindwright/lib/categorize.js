// Deterministic (category, scope) prediction heuristic. The calling Claude
// session tags each fact during `/mindwright:dream`, but when a fact arrives
// untagged (explicit retain, bootstrap path, mock test) this falls back to
// keyword cues to pick one of the orthogonal-taxonomy tuples:
//
//   { category: 'fact',       scope: 'user'        }   — preference / user-state
//   { category: 'fact',       scope: 'project'     }   — codebase fact
//   { category: 'procedural', scope: 'role:<role>' }   — role-tagged know-how
//   { category: 'procedural', scope: 'project'     }   — project-wide procedure
//   { category: 'episodic',   scope: 'project'     }   — lesson-from-incident
//
// Conservative: returns `null` when nothing fires, letting callers default
// to `{ category: 'fact', scope: 'project' }`.
//
// LANGUAGE SCOPE: this fallback is English-only. The cue regexes match
// English verbs and word forms. Non-English content silently returns null
// (→ caller defaults). The PRIMARY categorization path is the dream-cycle
// LLM (i.e. the calling Claude session) which IS multilingual — non-English
// users rely on that path tagging facts explicitly via
// mindwright_retain_fact, and the retrieval side stays multilingual
// independently via bge-m3. Localizing the heuristic is out of scope.

const PREFERENCE_CUES = [
  /\bthe user (prefers?|wants?|likes?|expects?|asks?)/i,
  /\bi (prefer|want|like|expect)/i,
  /\bdo not (use|run|do|add|include)/i,
  /\bnever (commit|push|use|do)/i,
  /\balways (use|do|run)/i,
  /\bI(?:'m| am) the user\b/i,
];

// Procedural cues — "when planning…", "<role> should…", etc.
// Role alternations are built from CANONICAL_ROLES so adding a new role in
// role-prompts.js automatically wires it into categorization. Generic verbs
// (planning/implementing/...) live alongside the canonical names and resolve
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

// When a procedural cue fires, try to extract WHICH role the procedure is
// about. Capture-group 1 is the role name (case-insensitive). Matches the
// canonical roles plus the generic verbs that VERB_TO_ROLE then resolves.
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
  /\b[A-Z]\w+(?:Service|Manager|Controller|Component|Module|Client)\b/, // PascalCase tokens
];

const EPISODIC_CUES = [
  /\bI claimed .* without checking\b/i,
  /\b(?:was|were) wrong\b/i,
  /\bthe \d{4}-\d{2}-\d{2}\b/, // ISO date — "the 2026-05-13 incident"
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

// Returns one of:
//   { category, scope }
//   null   (nothing fired — caller defaults to { category: 'fact', scope: 'project' })
//
// `role` (optional): a callsite-explicit role tag (e.g. mindwright_retain
// `role` field). If provided AND no preference cue fires, the result is
// procedural / role:<role>.
export function categorize(text, { role = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

  for (const re of PREFERENCE_CUES) {
    if (re.test(text)) return { category: 'fact', scope: 'user' };
  }

  for (const re of EPISODIC_CUES) {
    if (re.test(text)) return { category: 'episodic', scope: 'project' };
  }

  // Procedural cues
  for (const re of PROCEDURAL_CUES) {
    if (re.test(text)) {
      const inferred = role || extractRoleFromText(text);
      return inferred
        ? { category: 'procedural', scope: `role:${inferred}` }
        : { category: 'procedural', scope: 'project' };
    }
  }
  if (role) {
    // Explicit role tag without a procedural cue → still procedural,
    // role-scoped.
    return { category: 'procedural', scope: `role:${role}` };
  }

  for (const re of PROJECT_FACT_CUES) {
    if (re.test(text)) return { category: 'fact', scope: 'project' };
  }

  return null;
}
