import { callJudge } from "../judge.mjs";

const NOVELTY_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const BATCH_SYSTEM = `You are a product analyst judging whether a set of search results each represent an existing product/library that directly competes with a proposed product idea.

Be strict: require meaningful functional overlap, not merely shared topic keywords. A blog post, unrelated library, or general article about the problem space is NOT a competitor. A shipped tool/app/library that solves the same pain for the same user IS a competitor.

Input: one <idea> and a <results> list where each <result> has an integer id.

Return strict JSON with EXACTLY this shape:
{
  "verdicts": [
    { "id": 0, "is_competitor": boolean, "overlap_score": number_0_1, "reason": "one sentence", "serves_same_user": boolean, "solves_same_pain": boolean },
    ...
  ]
}

Return exactly one verdict per result id. No prose, no markdown fences.`;

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPrompt(idea, result) {
  return [
    "<idea>",
    `  <title>${xmlEscape(idea.title)}</title>`,
    `  <summary>${xmlEscape(idea.summary)}</summary>`,
    `  <target_user>${xmlEscape(idea.target_user)}</target_user>`,
    "</idea>",
    "<search_result>",
    `  <source>${xmlEscape(result.source)}</source>`,
    `  <title>${xmlEscape(result.title)}</title>`,
    `  <snippet>${xmlEscape(result.snippet)}</snippet>`,
    `  <url>${xmlEscape(result.url)}</url>`,
    "</search_result>"
  ].join("\n");
}

function buildBatchPrompt(idea, results) {
  const lines = [
    "<idea>",
    `  <title>${xmlEscape(idea.title)}</title>`,
    `  <summary>${xmlEscape(idea.summary)}</summary>`,
    `  <target_user>${xmlEscape(idea.target_user)}</target_user>`,
    "</idea>",
    "<results>",
  ];
  results.forEach((r, idx) => {
    lines.push(
      `  <result id="${idx}">`,
      `    <source>${xmlEscape(r.source)}</source>`,
      `    <title>${xmlEscape(r.title)}</title>`,
      `    <snippet>${xmlEscape(r.snippet)}</snippet>`,
      `    <url>${xmlEscape(r.url)}</url>`,
      "  </result>",
    );
  });
  lines.push("</results>");
  return lines.join("\n");
}

function applyVerdict(result, v) {
  return {
    ...result,
    is_competitor: !!v.is_competitor,
    overlap_score: Number(v.overlap_score) || 0,
    reason: String(v.reason || ""),
    serves_same_user: !!v.serves_same_user,
    solves_same_pain: !!v.solves_same_pain,
  };
}

function errorVerdict(result, message) {
  return {
    ...result,
    is_competitor: false,
    overlap_score: 0,
    reason: `judge-error: ${message}`,
    serves_same_user: false,
    solves_same_pain: false,
    judge_error: true,
  };
}

// Single-result scorer — kept for unit tests and for callers that have
// only one result to judge. Production paths use scoreResults (batched).
export async function scoreResult(idea, result, { judge = callJudge, model = NOVELTY_DEFAULT_MODEL } = {}) {
  try {
    const out = await judge({ system: BATCH_SYSTEM, user: buildPrompt(idea, result), model });
    return applyVerdict(result, out);
  } catch (e) {
    return errorVerdict(result, e?.message || e);
  }
}

// Batched scorer — ONE judge call for all results of an idea. On malformed
// responses, unmatched results are marked judge_error. No serial fallback:
// if the batch itself throws, every result is marked judge_error.
export async function scoreResults(idea, results, { judge = callJudge, model = NOVELTY_DEFAULT_MODEL } = {}) {
  if (results.length === 0) return [];
  let out;
  try {
    out = await judge({
      system: BATCH_SYSTEM,
      user: buildBatchPrompt(idea, results),
      model,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    return results.map((r) => errorVerdict(r, msg));
  }
  const verdicts = Array.isArray(out?.verdicts) ? out.verdicts : null;
  if (!verdicts) {
    return results.map((r) => errorVerdict(r, "batch response missing verdicts array"));
  }
  const byId = new Map(
    verdicts
      .filter((v) => v && Number.isInteger(v.id))
      .map((v) => [v.id, v]),
  );
  return results.map((r, idx) => {
    const v = byId.get(idx);
    if (!v) return errorVerdict(r, `batch missing verdict for id=${idx}`);
    return applyVerdict(r, v);
  });
}
