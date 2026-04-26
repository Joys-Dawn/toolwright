// Exa web search. Requires EXA_API_KEY env var.
// Docs: https://docs.exa.ai/reference/search

const API = "https://api.exa.ai/search";

export async function searchExa(query, { limit = 10, signal } = {}) {
  const key = process.env.EXA_API_KEY;
  if (!key) return [];
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, numResults: limit }),
    signal,
  });
  if (!res.ok) throw new Error(`exa status=${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => ({
    source: "exa",
    url: r.url,
    title: r.title || "",
    snippet: r.text ? r.text.slice(0, 300) : "",
    meta: { publishedDate: r.publishedDate, author: r.author },
  }));
}
