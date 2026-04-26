import { STOPWORDS } from "./stopwords.mjs";

function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9\-]+/g)
      ?.filter(t => t.length >= 3 && !STOPWORDS.has(t)) || []
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function prefilterResults(idea, results, { keep = 25 } = {}) {
  const ideaBag = tokenize(`${idea.title} ${idea.summary} ${idea.target_user || ""}`);
  const scored = results.map(r => {
    const bag = tokenize(`${r.title} ${r.snippet}`);
    const sim = jaccard(ideaBag, bag);
    return { ...r, prefilter_score: Number(sim.toFixed(3)) };
  });
  scored.sort((a, b) => b.prefilter_score - a.prefilter_score);
  return scored.slice(0, keep);
}
