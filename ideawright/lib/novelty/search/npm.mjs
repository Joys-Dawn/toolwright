const API = "https://registry.npmjs.org/-/v1/search";

// npm registry rejects text outside [2, 64] chars (HTTP 400 ERR_TEXT_LENGTH).
// Long queries get truncated at the last word boundary so we still search with
// as much signal as the API will accept; queries below the floor return [].
const NPM_MIN_QUERY_LEN = 2;
const NPM_MAX_QUERY_LEN = 64;

export function clipQueryForNpm(query) {
  const s = String(query ?? "").trim().replace(/\s+/g, " ");
  if (s.length < NPM_MIN_QUERY_LEN) return null;
  if (s.length <= NPM_MAX_QUERY_LEN) return s;
  const head = s.slice(0, NPM_MAX_QUERY_LEN);
  const lastSpace = head.lastIndexOf(" ");
  // Prefer word-boundary cut, but only when it leaves something substantive.
  const cut = lastSpace >= NPM_MIN_QUERY_LEN ? head.slice(0, lastSpace) : head;
  return cut.trim();
}

export async function searchNpm(query, { limit = 10, signal } = {}) {
  const text = clipQueryForNpm(query);
  if (!text) return [];
  const params = new URLSearchParams({ text, size: String(limit) });
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
