// Haiku-as-judge validator. Takes a raw pain-signal observation from
// a miner and returns a structured judgement + synthesized idea.

import { callJudge } from '../judge.mjs';
import { normalizeVerdict } from './normalize-verdict.mjs';

const SYSTEM = `You are an indie-product-ideation classifier.

Given a signal (forum post, comment, or issue), decide:
  1. Does it describe a real unmet need for a product?
  2. Can that need be solved by pure CODE — no hardware, no large capital,
     no access to private/proprietary datasets, no regulatory approval?
  3. If yes, synthesize a concise product idea.

Return strict JSON with EXACTLY this shape:
{
  "is_real_need": boolean,
  "pain_score_0_10": integer,
  "code_only": boolean,
  "no_capital": boolean,
  "no_private_data": boolean,
  "idea": {
    "title": "3-10 word specific name, not generic",
    "summary": "one or two sentence pitch",
    "target_user": "who benefits — specific segment, not 'everyone'",
    "category": "lowercase-kebab e.g. developer-tools, personal-finance, productivity",
    "emerging_tech": "new api/lib/dataset this leans on, or null",
    "suggested_approach": "1-2 sentences on implementation"
  }
}

Set "idea": null if any of these are false:
- is_real_need (just venting or social issue → false)
- code_only (needs hardware or physical service → false)
- no_capital (needs millions of $ upfront → false)
- no_private_data (requires proprietary data access → false)
- pain_score_0_10 >= 4 (too trivial → false)

NEVER wrap the JSON in prose or markdown code fences. Return ONLY the object.`;

export async function validateSignal(observation, { timeoutMs, model } = {}) {
  const user = JSON.stringify(
    {
      source: observation.source,
      source_url: observation.source_url,
      title: observation.title,
      quote: observation.quote,
      author: observation.author,
      engagement: observation.engagement,
    },
    null,
    2,
  );
  const opts = { system: SYSTEM, user };
  if (timeoutMs) opts.timeoutMs = timeoutMs;
  if (model) opts.model = model;
  const result = await callJudge(opts);
  return normalizeVerdict(result);
}

const BATCH_SYSTEM = `You are an indie-product-ideation classifier.

You will receive a JSON array of signals (forum posts, comments, or issues).
For EACH signal, decide:
  1. Does it describe a real unmet need for a product?
  2. Can that need be solved by pure CODE — no hardware, no large capital,
     no access to private/proprietary datasets, no regulatory approval?
  3. If yes, synthesize a concise product idea.

Return a strict JSON ARRAY with one result per input signal, in the same order.
Each element has EXACTLY this shape:
{
  "index": integer (0-based position matching the input array),
  "is_real_need": boolean,
  "pain_score_0_10": integer,
  "code_only": boolean,
  "no_capital": boolean,
  "no_private_data": boolean,
  "idea": {
    "title": "3-10 word specific name, not generic",
    "summary": "one or two sentence pitch",
    "target_user": "who benefits — specific segment, not 'everyone'",
    "category": "lowercase-kebab e.g. developer-tools, personal-finance, productivity",
    "emerging_tech": "new api/lib/dataset this leans on, or null",
    "suggested_approach": "1-2 sentences on implementation"
  }
}

Set "idea": null if any of these are false:
- is_real_need (just venting or social issue → false)
- code_only (needs hardware or physical service → false)
- no_capital (needs millions of $ upfront → false)
- no_private_data (requires proprietary data access → false)
- pain_score_0_10 >= 4 (too trivial → false)

NEVER wrap the JSON in prose or markdown code fences. Return ONLY the array.`;

export async function validateSignalBatch(observations, { timeoutMs, model } = {}) {
  if (!observations.length) return [];
  const user = JSON.stringify(
    observations.map((o) => ({
      source: o.source,
      source_url: o.source_url,
      title: o.title,
      quote: o.quote,
      author: o.author,
      engagement: o.engagement,
    })),
    null,
    2,
  );
  const opts = { system: BATCH_SYSTEM, user };
  if (timeoutMs) opts.timeoutMs = timeoutMs ?? 120_000;
  if (model) opts.model = model;
  const results = await callJudge(opts);
  const arr = Array.isArray(results) ? results : [results];
  return arr.map((r) => normalizeVerdict(r));
}
