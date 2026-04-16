const API = "https://registry.npmjs.org/-/v1/search";

export async function searchNpm(query, { limit = 10, signal } = {}) {
  const params = new URLSearchParams({ text: query, size: String(limit) });
  const res = await fetch(`${API}?${params}`, {
    headers: { "User-Agent": "ideawright-novelty/0.1" },
    signal
  });
  if (!res.ok) throw new Error(`npm status=${res.status}`);
  const data = await res.json();
  return (data.objects || []).map(o => {
    const p = o.package || {};
    return {
      source: "npm",
      url: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
      title: p.name,
      snippet: p.description || "",
      meta: { version: p.version, keywords: p.keywords || [] }
    };
  });
}
