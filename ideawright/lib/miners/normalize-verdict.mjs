// Shared verdict normalizer for both pain-signal and capability validators.
// Enforces the gate logic (is_real_need, code_only, no_capital, no_private_data,
// pain_score >= 4, title length >= 3) and returns a clean verdict shape.

export function normalizeVerdict(r) {
  if (!r || typeof r !== 'object') return { is_real_need: false, idea: null };
  const passesAll =
    r.is_real_need === true &&
    r.code_only === true &&
    r.no_capital === true &&
    r.no_private_data === true &&
    (r.pain_score_0_10 ?? 0) >= 4 &&
    r.idea &&
    typeof r.idea.title === 'string' &&
    r.idea.title.length >= 3;
  return {
    is_real_need: !!r.is_real_need,
    pain_score_0_10: Number.isFinite(r.pain_score_0_10) ? r.pain_score_0_10 : 0,
    code_only: !!r.code_only,
    no_capital: !!r.no_capital,
    no_private_data: !!r.no_private_data,
    idea: passesAll ? r.idea : null,
  };
}
