const ENDPOINT = "https://html.duckduckgo.com/html/";
const UA = "Mozilla/5.0 (compatible; ideawright-novelty/0.1; +https://github.com/Joys-Dawn/toolwright)";

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseRedirect(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const inner = u.searchParams.get("uddg");
    if (inner) return decodeURIComponent(inner);
    return u.toString();
  } catch {
    return href;
  }
}

export async function searchDDG(query, { limit = 10, signal } = {}) {
  const body = new URLSearchParams({ q: query, b: "", kl: "us-en" });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html"
    },
    body,
    signal
  });
  if (!res.ok) {
    throw new Error(`ddg status=${res.status}`);
  }
  const html = await res.text();
  const results = [];
  const blockRe = /<div class="result__body"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < limit) {
    results.push({
      source: "ddg",
      url: parseRedirect(m[1]),
      title: stripTags(m[2]),
      snippet: stripTags(m[3])
    });
  }
  if (html.length > 1000 && results.length === 0) {
    console.warn(`[ddg] parsed 0 results from ${html.length}-byte response — selector may be stale or hit captcha/rate-limit`);
  }
  return results;
}
