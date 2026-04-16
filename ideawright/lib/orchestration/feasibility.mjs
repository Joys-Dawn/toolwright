import { callJudge } from '../judge.mjs';
import { listByStatus, updateFeasibility } from '../db.mjs';

const SYSTEM = `You judge whether a product idea satisfies three hard constraints:
1. code_only — can be fully implemented in software alone (no hardware, no human-labor services, no physical integrations).
2. no_capital — can be built by one person using free-tier infrastructure (no paid API quotas, no licensed datasets, no hired help).
3. no_private_data — does not require access to private or proprietary datasets to function; public data or user-supplied data only.

Also produce:
- impl_sketch: 1–3 sentences on how a single developer would build it.
- effort: "hours" | "days" | "weeks".
- score_0_100: overall attractiveness 0..100.
- verdict:
  - "go"     if all 3 gates true AND score_0_100 >= 60
  - "defer"  if all 3 gates true AND 30 <= score_0_100 < 60
  - "reject" if any gate false OR score_0_100 < 30

Return STRICT JSON, no prose, no code fences:
{"code_only": true|false, "no_capital": true|false, "no_private_data": true|false, "impl_sketch": "...", "effort": "hours"|"days"|"weeks", "score_0_100": N, "verdict": "go"|"defer"|"reject"}`;

const BATCH_SYSTEM = `You judge whether product ideas satisfy three hard constraints:
1. code_only — can be fully implemented in software alone (no hardware, no human-labor services, no physical integrations).
2. no_capital — can be built by one person using free-tier infrastructure (no paid API quotas, no licensed datasets, no hired help).
3. no_private_data — does not require access to private or proprietary datasets to function; public data or user-supplied data only.

You will receive a JSON array of ideas. For EACH idea, produce:
- impl_sketch: 1–3 sentences on how a single developer would build it.
- effort: "hours" | "days" | "weeks".
- score_0_100: overall attractiveness 0..100.
- verdict:
  - "go"     if all 3 gates true AND score_0_100 >= 60
  - "defer"  if all 3 gates true AND 30 <= score_0_100 < 60
  - "reject" if any gate false OR score_0_100 < 30

Return a strict JSON ARRAY with one result per input idea, in the same order.
Each element has EXACTLY this shape:
{"index": integer, "code_only": true|false, "no_capital": true|false, "no_private_data": true|false, "impl_sketch": "...", "effort": "hours"|"days"|"weeks", "score_0_100": N, "verdict": "go"|"defer"|"reject"}

NEVER wrap the JSON in prose or markdown code fences. Return ONLY the array.`;

export async function gateFeasibility({ db, config = {}, _judge } = {}) {
  const gates = {
    code_only: config?.feasibility?.require_code_only ?? true,
    no_capital: config?.feasibility?.require_no_capital ?? true,
    no_private_data: config?.feasibility?.require_no_private_data ?? true,
  };
  const model = config?.llm?.model ?? null;
  const batchSize = config?.novelty?.batch_size ?? 10;
  const judge = _judge ?? callJudge;
  const ideas = listByStatus(db, 'verified');
  let gated = 0, archived = 0, errored = 0;
  const errored_ideas = [];

  for (let i = 0; i < ideas.length; i += batchSize) {
    const batch = ideas.slice(i, i + batchSize);
    let results;
    try {
      const judgeOpts = { system: BATCH_SYSTEM, user: buildBatchPrompt(batch) };
      if (model) judgeOpts.model = model;
      results = await judge(judgeOpts);
      if (!Array.isArray(results)) results = [results];
    } catch (e) {
      // Batch failed — fall back to per-item
      console.error(`[feasibility] batch ${i}-${i + batch.length} failed: ${e.message}, falling back to per-item`);
      results = [];
      for (const idea of batch) {
        try {
          const judgeOpts = { system: SYSTEM, user: buildPrompt(idea) };
          if (model) judgeOpts.model = model;
          results.push(await judge(judgeOpts));
        } catch (err) {
          results.push(null);
        }
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const idea = batch[j];
      const feasibility = results[j];
      if (!feasibility || typeof feasibility !== 'object') {
        errored++;
        errored_ideas.push({ id: idea.id, title: idea.title, error: 'no result from judge' });
        continue;
      }
      const failsGate =
        (gates.code_only && feasibility.code_only !== true) ||
        (gates.no_capital && feasibility.no_capital !== true) ||
        (gates.no_private_data && feasibility.no_private_data !== true);
      if (failsGate || feasibility.verdict === 'reject') {
        const reason = `feasibility:${failsGate ? 'gate_failed' : 'rejected'}`;
        updateFeasibility(db, idea.id, feasibility, null, 'archived', reason);
        archived++;
      } else {
        updateFeasibility(db, idea.id, feasibility, null, 'gated');
        gated++;
      }
    }
  }
  return { gated, archived, errored, errored_ideas, total: ideas.length };
}

function buildBatchPrompt(ideas) {
  return JSON.stringify(
    ideas.map((idea, idx) => {
      const evidence = (idea.pain_evidence ?? []).slice(0, 3)
        .map(e => `"${String(e.quote).slice(0, 280)}" [${e.source_url}]`).join('; ');
      return {
        index: idx,
        title: idea.title,
        summary: idea.summary ?? null,
        target_user: idea.target_user ?? null,
        category: idea.category ?? null,
        emerging_tech: idea.emerging_tech ?? null,
        pain_evidence: evidence || null,
      };
    }),
    null,
    2,
  );
}

function buildPrompt(idea) {
  const evidence = (idea.pain_evidence ?? []).slice(0, 3)
    .map(e => `- "${String(e.quote).slice(0, 280)}" [${e.source_url}]`).join('\n');
  return [
    `Title: ${idea.title}`,
    idea.summary ? `Summary: ${idea.summary}` : null,
    idea.target_user ? `Target user: ${idea.target_user}` : null,
    idea.category ? `Category: ${idea.category}` : null,
    idea.emerging_tech ? `Emerging tech used: ${idea.emerging_tech}` : null,
    evidence ? `Pain evidence:\n${evidence}` : null,
  ].filter(Boolean).join('\n');
}
