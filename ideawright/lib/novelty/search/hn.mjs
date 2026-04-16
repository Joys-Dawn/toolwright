const API = "https://hn.algolia.com/api/v1/search";

export async function searchHN(query, { limit = 10, signal } = {}) {
  const params = new URLSearchParams({
    query,
    tags: "(story,show_hn)",
    hitsPerPage: String(limit)
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { "User-Agent": "ideawright-novelty/0.1" },
    signal
  });
  if (!res.ok) throw new Error(`hn status=${res.status}`);
  const data = await res.json();
  return (data.hits || []).map(h => ({
    source: "hn",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    title: h.title || h.story_title || "",
    snippet: `HN: ${h.points || 0} points, ${h.num_comments || 0} comments`,
    meta: {
      points: h.points,
      comments: h.num_comments,
      created_at: h.created_at
    }
  }));
}
