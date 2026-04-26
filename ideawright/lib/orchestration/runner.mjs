import { gateFeasibility } from './feasibility.mjs';
import { rankAll } from './ranker.mjs';
import { buildDigest } from './digest.mjs';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function runOrchestration({ db, repoRoot }) {
  const config = loadConfig(repoRoot);
  const feas = await gateFeasibility({ db, config });
  const ranked = rankAll({ db, weights: config.weights });
  const topN = config.digest?.top_n ?? 10;
  const today = todayDate();
  const digest = buildDigest({ db, topN, sinceDate: today });

  const digestDir = join(repoRoot, '.claude', 'ideawright', 'digests');
  mkdirSync(digestDir, { recursive: true });
  const digestPath = join(digestDir, `${today}.md`);
  writeFileSync(digestPath, digest.markdown);

  const summary = {
    feasibility: feas,
    ranker: ranked,
    digest: { promoted: digest.promoted, count: digest.count, path: digestPath },
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('---DIGEST---');
  console.log(digest.markdown);
  return summary;
}

function loadConfig(repoRoot) {
  const path = join(repoRoot, '.claude', 'ideawright.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[runner] failed to parse ${path}: ${e.message} — using defaults`);
    return {};
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}
