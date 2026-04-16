// Pain-phrase detection. Word-boundary, case-insensitive patterns
// calibrated to Reddit/HN/StackOverflow posts that precede successful
// indie product launches. First-pass filter before LLM validation.

const PAIN_PATTERNS = [
  // Explicit desire for a tool that doesn't exist
  /\bi wish there (was|were) (an?|a tool|a way|some|any)/i,
  /\bwhy (isn't|isnt|is) there (no|an?|any) /i,
  /\bwhy is no one /i,
  /\bwhy (hasn't|hasnt) (anyone|someone) /i,
  /\bis there (an?|any) (tool|app|site|service|library|package) (for|that|which)/i,
  /\bi(?:'d| would) pay for /i,
  /\bi(?:'d| would) happily pay /i,
  /\bsomeone should (build|make|write|create) /i,
  /\bshould (just )?(build|make) (an?|a) /i,
  /\blooking for (an?|a) (tool|app|way) to /i,

  // Frustration / unmet need
  /\bfrustrated (with|that|by) /i,
  /\bi hate (that|when|how) /i,
  /\bannoy(ed|ing) (that|when|by) /i,
  /\bthere has to be a better way /i,
  /\bthere'?s (got to be|no good way) /i,
  /\bit'?s (so |really |super )?(clunky|broken|painful|terrible|awful) /i,
  /\bi can'?t believe there'?s no /i,

  // Gap / already-searched signals
  /\bevery (app|tool|product|option) (i tried|i'?ve tried|out there) /i,
  /\bi'?ve been looking for /i,
  /\bcan'?t find (an?|any) (good |decent |proper )?(app|tool|library|package) /i,
  /\bnone of the (existing|current|popular) /i,
  /\btried (everything|them all|all of them) /i,
];

export function matchPainPhrases(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  for (const pattern of PAIN_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const idx = m.index;
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + m[0].length + 240);
    const excerpt = text.slice(start, end).trim().replace(/\s+/g, ' ');
    matches.push({ pattern: pattern.source, match: m[0].trim(), excerpt });
  }
  return matches;
}

export function hasPainPhrase(text) {
  return PAIN_PATTERNS.some((p) => p.test(text));
}

export function painPatternCount() {
  return PAIN_PATTERNS.length;
}
