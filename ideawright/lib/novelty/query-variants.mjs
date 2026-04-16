import { STOPWORDS } from "./stopwords.mjs";

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function keywordize(title, summary) {
  const words = `${title} ${summary}`.toLowerCase().match(/[a-z0-9][a-z0-9\-]+/g) || [];
  const picked = [];
  for (const w of words) {
    if (STOPWORDS.has(w) || w.length < 3) continue;
    if (!picked.includes(w)) picked.push(w);
    if (picked.length >= 6) break;
  }
  return picked;
}

export function buildQueryVariants(idea) {
  const title = normalize(idea.title);
  const summary = normalize(idea.summary);
  const target = normalize(idea.target_user);
  const keywords = keywordize(title, summary);
  const kwJoin = keywords.slice(0, 4).join(" ");

  const variants = [];
  const push = (query, strategy) => {
    if (!query) return;
    const clean = query.trim().replace(/\s+/g, " ");
    if (clean && !variants.some(v => v.query === clean)) {
      variants.push({ query: clean, strategy });
    }
  };

  push(title, "exact");
  if (kwJoin && kwJoin !== title) push(kwJoin, "keywords");
  if (target) push(`${kwJoin} for ${target}`, "feature");
  push(`tool for ${kwJoin}`, "feature");
  push(`${kwJoin} app`, "feature");
  push(`open source ${kwJoin}`, "feature");

  const siteScopes = [
    "github.com",
    "producthunt.com",
    "news.ycombinator.com",
    "chromewebstore.google.com",
    "chrome.google.com",
    "apps.apple.com",
    "addons.mozilla.org",
    "npmjs.com",
    "pypi.org",
    "marketplace.visualstudio.com"
  ];
  for (const site of siteScopes) {
    push(`${kwJoin} site:${site}`, `site:${site}`);
  }

  return variants;
}

export const _internal = { normalize, keywordize };
