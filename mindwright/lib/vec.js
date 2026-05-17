// Cosine similarity of two same-length vectors → scalar in [-1, 1] (throws on
// length mismatch). Own file so hooks can import it without the retrieval
// surface. Hand-rolled to keep the codebase numerics-package-free. bge-m3
// inputs are already L2-normalized (cosine = dot), but this still computes
// magnitudes so a non-normalized test fixture stays correct.
export function cosineSimilarity(a, b) {
  if (!a || !b) {
    throw new Error('cosineSimilarity: both vectors are required');
  }
  if (typeof a.length !== 'number' || typeof b.length !== 'number') {
    throw new Error('cosineSimilarity: inputs must be array-like with .length');
  }
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  if (a.length === 0) {
    throw new Error('cosineSimilarity: inputs must be non-empty');
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    // Cosine of a zero vector defined as 0 so callers don't branch; the
    // novelty gate then treats it as "fire retrieval", which is correct.
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
