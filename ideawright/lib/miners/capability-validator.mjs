// Capability validator (Pipeline 2). Takes a paper/tool/dataset signal and
// asks the judge to synthesize ONE code-only product idea that only became
// feasible because the capability exists.
//
// Returns the same verdict shape as validator.mjs so the runner's toIdea()
// can consume either pipeline uniformly.

import { callJudge } from '../judge.mjs';
import { normalizeVerdict } from './normalize-verdict.mjs';

const SYSTEM = `You are a supply-side product-ideation synthesizer.

Input: a recently published paper, open-source tool, or public dataset.

Task: decide whether this capability unlocks a novel code-only product that
WASN'T feasible 12 months ago, and if so, synthesize ONE concrete idea.

Decision gates — ALL must be true to emit an idea:
  - is_real_need:  the idea addresses a plausible real user need (not a demo toy)
  - code_only:     buildable with pure software (no hardware, no physical logistics)
  - no_capital:    no large upfront $ (cloud costs under ~$500/mo OK; GPU farm = no)
  - no_private_data: does not require proprietary/private dataset access
  - the capability is genuinely NEW (not a reimplementation of a 5-year-old technique)

Return strict JSON with EXACTLY this shape:
{
  "is_real_need": boolean,
  "pain_score_0_10": integer,
  "code_only": boolean,
  "no_capital": boolean,
  "no_private_data": boolean,
  "idea": {
    "title": "3-10 word specific product name, not generic",
    "summary": "one or two sentence pitch that names the capability and the product",
    "target_user": "who benefits — specific segment, not 'everyone'",
    "category": "lowercase-kebab e.g. developer-tools, scientific-tooling, clinical-research",
    "emerging_tech": "name the paper / tool / dataset this depends on, with id if provided",
    "suggested_approach": "1-2 sentences on how a solo dev would build it"
  }
}

pain_score_0_10 is an opportunity score: how badly a real user segment needs this, 0-10.

Set "idea": null if any gate fails, or if the capability is already commoditized,
or if no concrete product is plausible.

NEVER wrap the JSON in prose or markdown code fences. Return ONLY the object.`;

export async function validateCapability(observation, { model, timeoutMs } = {}) {
  const user = JSON.stringify(
    {
      source: observation.source,
      source_url: observation.source_url,
      title: observation.title,
      abstract: observation.quote,
      authors: observation.author,
      published: observation.created_at,
      code_url: observation.code_url ?? null,
      categories: observation.categories ?? null,
      engagement: observation.engagement,
    },
    null,
    2,
  );
  const opts = { system: SYSTEM, user };
  if (model) opts.model = model;
  if (timeoutMs) opts.timeoutMs = timeoutMs;
  const result = await callJudge(opts);
  return normalizeVerdict(result);
}
