import { rowToIdea } from '../db.mjs';

export function selectTopN(db, topN = 10) {
  return db.prepare(`
    SELECT * FROM ideas
     WHERE status IN ('gated','promoted') AND composite_rank IS NOT NULL
     ORDER BY composite_rank DESC
     LIMIT ?
  `).all(topN);
}

export function promoteIdeas(db, rows) {
  const stmt = db.prepare(
    `UPDATE ideas SET status = 'promoted', updated_at = datetime('now') WHERE id = ? AND status = 'gated'`
  );
  let promoted = 0;
  for (const row of rows) {
    if (row.status === 'gated') {
      stmt.run(row.id);
      promoted++;
    }
  }
  return promoted;
}

export function buildDigest({ db, topN = 10 }) {
  const rows = selectTopN(db, topN);
  const promoted = promoteIdeas(db, rows);
  return {
    count: rows.length,
    promoted,
    markdown: formatMarkdown(rows.map(rowToIdea)),
  };
}

export function formatMarkdown(ideas) {
  if (!ideas.length) {
    return '_No promoted ideas yet. Run `/ideawright:scan` to collect signals, then `/ideawright:daily`._';
  }
  const lines = ['# ideawright daily digest', ''];
  ideas.forEach((idea, i) => {
    const evidence = (idea.pain_evidence ?? [])[0];
    const rank = (idea.composite_rank ?? 0).toFixed(3);
    lines.push(`### ${i + 1}. ${idea.title} — rank ${rank}`);
    if (idea.target_user) lines.push(`- **for:** ${idea.target_user}`);
    if (idea.category) lines.push(`- **category:** ${idea.category}`);
    if (idea.summary) lines.push(`- ${idea.summary}`);
    if (idea.novelty?.verdict) {
      lines.push(`- **novelty:** ${idea.novelty.verdict} (${idea.novelty.score_0_100}/100, ${(idea.novelty.competitors ?? []).length} competitors)`);
    }
    if (idea.feasibility?.verdict) {
      lines.push(`- **feasibility:** ${idea.feasibility.verdict} · ${idea.feasibility.effort}`);
    }
    if (idea.feasibility?.impl_sketch) {
      lines.push(`- **sketch:** ${idea.feasibility.impl_sketch}`);
    }
    if (evidence) {
      const quote = String(evidence.quote ?? '').replace(/\s+/g, ' ');
      const truncated = quote.length > 180 ? quote.slice(0, 180) + '…' : quote;
      lines.push(`- **evidence:** "${truncated}" — <${evidence.source_url}>`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
