// Pain-phrase detection. Word-boundary, case-insensitive patterns
// calibrated to Reddit/HN/StackOverflow posts that precede successful
// indie product launches. First-pass filter before LLM validation.

const PAIN_PATTERNS = [
  // Explicit desire for a tool that doesn't exist
  /\bi wish there (was|were) (an?|a tool|a way|some|any)/i,
  /\bif only there (was|were) (an?|a way|some)/i,
  /\bwhy (isn't|isnt|is) there (no|an?|any) /i,
  /\bwhy is no one /i,
  /\bwhy (hasn't|hasnt) (anyone|someone) /i,
  /\bhow (has no one|come nobody|is nobody) /i,
  /\bseriously (no one|nobody) has /i,
  /\bis there (an?|any) (tool|app|site|service|library|package|extension|plugin|way) (for|that|which|to)/i,
  /\bdoes (anything|anyone know of (an?|a)) .{0,30}(tool|app|service|library|way)/i,
  /\bdoes (this|that|something like this) (not )?exist/i,
  /\bi(?:'d| would) pay for /i,
  /\bi(?:'d| would) happily pay /i,
  /\b(would|i'?d) kill for (an?|a) /i,
  /\bsomeone (should|needs to) (build|make|write|create) /i,
  /\bshould (just )?(build|make) (an?|a) /i,
  /\bthere (should|needs to) be (an?|a) /i,
  /\bwish someone would /i,
  /\blooking for (an?|a) (tool|app|way|solution|alternative) to /i,
  /\bi need (an?|a) (tool|app|way|solution) (to|for|that) /i,
  /\bdesperate(ly)? for (an?|a) /i,

  // Asking for recommendations (implies gap in knowledge or market)
  /\bwhat do you (guys |all )?use for /i,
  /\bwhat (tool|app|service) do you /i,
  /\bcan (someone|anyone|you) recommend (an?|a) /i,
  /\bany (good |decent )?(alternatives|recommendations|suggestions) (for|to) /i,
  /\bdoes anyone know (of )?(an?|a good) /i,
  /\banyone found a (good |decent |reliable )?(way|tool|app|solution) /i,

  // Frustration / unmet need
  /\bfrustrat(ed|ing) (with|that|by|how) /i,
  /\bi hate (that|when|how|having to) /i,
  /\bannoy(ed|ing) (that|when|by|how) /i,
  /\bthere has to be a better way/i,
  /\bthere'?s (got to be|no good way)/i,
  /\bit'?s (so |really |super |incredibly )?(clunky|broken|painful|terrible|awful|unusable|janky|buggy)/i,
  /\bi can'?t believe there'?s no /i,
  /\bhow is this (still )?not a thing/i,
  /\bstill no (good )?(way|tool|app|option|solution) to /i,
  /\btired of (having to |manually )?/i,
  /\bsick of (having to |manually )?/i,
  /\b(this is |it'?s )(killing|driving) me/i,
  /\bdriving me (crazy|insane|nuts|mad)/i,
  /\bwast(ed|ing) (so much |too much |hours of )?time /i,
  /\bspent (hours|days|weeks|forever) (trying to|looking for|searching for)/i,
  /\bstruggl(e|ing) (with|to) /i,
  /\bpain(ful|point| point)/i,
  /\bwhy does every (tool|app|service|product|option) /i,
  /\bnothing (works|seems to work|does what i)/i,

  // Built-my-own (strong gap signal)
  /\b(ended up|had to) (build|writ|mak|creat)(ing|e) my own/i,
  /\brolled my own /i,
  /\bcobbled together /i,
  /\bbuilt (my own|a hacky|a janky|a quick) /i,
  /\bwrote (my own|a script|a hack) /i,

  // Gap / already-searched signals
  /\bevery (app|tool|product|option|solution) (i tried|i'?ve tried|out there|i'?ve used)/i,
  /\bi'?ve been looking for /i,
  /\bcan'?t find (an?|any) (good |decent |proper |reliable )?(app|tool|library|package|solution|way)/i,
  /\bnone of the (existing|current|popular|available) /i,
  /\btried (everything|them all|all of them|every)/i,
  /\bimpossible to find (an?|a good)/i,
  /\b(all|every) (the )?(options|tools|apps|solutions) (are |)(terrible|awful|bad|garbage|trash|lacking|limited)/i,
  /\bno good (options|solutions|tools|alternatives)/i,
  /\bthe (existing|current|available) (tools|options|solutions) (are |)(all |)(terrible|awful|bad|broken|clunky|lacking)/i,
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
