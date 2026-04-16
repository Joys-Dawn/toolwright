// Semantic Scholar paper search. Works without auth (lower rate limit);
// set SEMANTIC_SCHOLAR_API_KEY env var for 1 req/s authenticated access.
// Docs: https://api.semanticscholar.org/api-docs/graph

const API = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,url,abstract,citationCount,year";

export async function searchScholar(query, { limit = 10, signal } = {}) {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: FIELDS,
  });
  const headers = { "User-Agent": "ideawright-novelty/0.1" };
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (key) headers["x-api-key"] = key;
  const res = await fetch(`${API}?${params}`, { headers, signal });
  if (!res.ok) throw new Error(`scholar status=${res.status}`);
  const data = await res.json();
  return (data.data || []).map(p => ({
    source: "scholar",
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    title: p.title || "",
    snippet: p.abstract ? p.abstract.slice(0, 300) : `${p.citationCount ?? 0} citations, ${p.year ?? "?"}`,
    meta: { paperId: p.paperId, citationCount: p.citationCount, year: p.year },
  }));
}
