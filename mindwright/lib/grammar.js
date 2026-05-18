// Tiny pluralization helpers for user-facing messages.

// "1 row" / "5 rows" — count + noun in correct form.
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Singular/plural verb form by count, no count prefix. Use when noun and verb
// are not adjacent: `${pluralize(n, 'row')} ${agree(n, 'is', 'are')} stored`.
export function agree(count, singular, plural) {
  return count === 1 ? singular : plural;
}
