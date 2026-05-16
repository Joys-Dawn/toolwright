// Tiny pluralization helpers for user-facing messages. The inline ternary
// `count === 1 ? '' : 's'` was repeated 10+ times across tools.mjs, mirrors.js,
// and session-start.js, and at least two sites had a subject-verb mismatch
// ("1 row are stored", "1 row have exceeded") because the count branch used a
// verb chosen for the plural case. These helpers make the agreement explicit.

// Returns "1 row" / "5 rows" — count + noun in correct form.
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Returns the singular or plural form of a verb based on count, without the
// count prefix. Use when the noun and verb are not adjacent.
//   `${pluralize(n, 'row')} ${agree(n, 'is', 'are')} stored`
export function agree(count, singular, plural) {
  return count === 1 ? singular : plural;
}
