// Single-purpose vector math helper. Lives in its own file (not on
// retriever.js) so hooks/pre-tool-use.js can import cosineSimilarity
// without dragging in the full retrieval pipeline's surface, and so
// diagnostic / status tooling can use it the same way.

// Cosine similarity of two same-length vectors. Returns a scalar in
// [-1, 1]. Both inputs MUST be the same length — throws otherwise.
// We hand-roll the loop rather than going through a numerics library
// because we already depend on Float32Array via @huggingface/transformers
// output, and the entire mindwright codebase otherwise pulls in zero
// numerics packages.
//
// Inputs from bge-m3 (via the embed RPC + transformers.js with
// `normalize: true`) are already L2-unit-normalized — cosine simplifies to
// a dot product. We do NOT assume that here; the helper computes magnitudes
// and divides, so it stays correct if a caller feeds in a non-normalized
// vector (e.g. a hand-built test fixture). The extra cost on a normalized
// pair is ~1024 extra multiplications, negligible vs. the embed call itself.
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
    // Defining cosine of a zero vector as 0 keeps callers from having to
    // branch on the degenerate case. The caller's novelty gate then treats
    // "fully irrelevant" as "fire retrieval" — fine, that's what we want.
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
