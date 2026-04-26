const API = "https://api.github.com";

function headers() {
  const h = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "ideawright-novelty",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

async function getJSON(url, signal) {
  const res = await fetch(url, { headers: headers(), signal });
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const resetAt = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    const err = new Error(`github rate limit; resets at ${new Date(resetAt).toISOString()}`);
    err.code = "RATELIMIT";
    err.resetAt = resetAt;
    throw err;
  }
  if (!res.ok) throw new Error(`github status=${res.status}`);
  return res.json();
}

export async function searchGitHubRepos(query, { limit = 10, signal } = {}) {
  const q = encodeURIComponent(query);
  const url = `${API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`;
  try {
    const data = await getJSON(url, signal);
    return (data.items || []).map(r => ({
      source: "github-repo",
      url: r.html_url,
      title: r.full_name,
      snippet: `${r.description || ""} • ${r.stargazers_count}★ • ${r.language || "?"}`,
      meta: { stars: r.stargazers_count, language: r.language, pushed_at: r.pushed_at }
    }));
  } catch (e) {
    if (e.code === "RATELIMIT") return [];
    throw e;
  }
}

export async function searchGitHubCode(query, { limit = 10, signal } = {}) {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) return [];
  const q = encodeURIComponent(query);
  const url = `${API}/search/code?q=${q}+in:readme&per_page=${limit}`;
  try {
    const data = await getJSON(url, signal);
    return (data.items || []).map(r => ({
      source: "github-code",
      url: r.html_url,
      title: r.repository?.full_name || r.name,
      snippet: `README match in ${r.path}`,
      meta: { repo: r.repository?.full_name }
    }));
  } catch (e) {
    if (e.code === "RATELIMIT") return [];
    throw e;
  }
}
