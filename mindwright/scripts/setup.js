#!/usr/bin/env node
// /mindwright:setup — one-time model download + smoke test.
//
// Downloads Xenova/bge-m3 (~1.1 GB at q8/~2.1 GB at fp16) and
// onnx-community/bge-reranker-v2-m3-ONNX (~570 MB at fp32) to the
// transformers.js cache (~/.cache/huggingface/hub/ by default), then runs a
// smoke test to confirm shapes and the sigmoid range.
//
// Designed to be run via `bash node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.js`
// from the /mindwright:setup skill. All progress goes to stderr; stdout is
// reserved for the final success line so callers can parse it.

import { pathToFileURL } from 'node:url';
import {
  EMBEDDING_DIM,
  EMBEDDER_MODEL_ID,
  RERANKER_MODEL_ID,
  embed,
  rerank,
  getEmbedder,
  getReranker,
} from '../lib/models.js';

function log(msg) {
  process.stderr.write(`[mindwright:setup] ${msg}\n`);
}

// Exported for unit testing — assertion thresholds live here so a regression
// in (a) Float32Array typecheck, (b) embedding dimensionality, (c) unit-norm
// tolerance, (d) sigmoid range, or (e) rerank result shape can be caught
// without downloading 5GB of models.
export function assertEmbeddingShape(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new Error(`smoke test failed: embed did not return Float32Array (got ${typeof vec})`);
  }
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `smoke test failed: embedding dim ${vec.length}, expected ${EMBEDDING_DIM}`
    );
  }
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (Math.abs(norm - 1) > 1e-3) {
    throw new Error(
      `smoke test failed: embedding not unit-normalized (norm=${norm.toFixed(6)})`
    );
  }
  return norm;
}

export function assertRerankScore(scores) {
  if (!Array.isArray(scores) || scores.length !== 1) {
    throw new Error(`smoke test failed: rerank returned ${JSON.stringify(scores)}`);
  }
  const score = scores[0];
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(
      `smoke test failed: rerank score ${score} outside expected sigmoid range [0, 1]`
    );
  }
  return score;
}

async function main() {
  log(`downloading + loading embedder: ${EMBEDDER_MODEL_ID}`);
  log(`  (transformers.js prints its own progress lines to stderr)`);
  const tStartEmb = Date.now();
  const { dtype } = await getEmbedder();
  log(`embedder ready (dtype=${dtype}, ${Date.now() - tStartEmb} ms)`);

  log(`downloading + loading reranker: ${RERANKER_MODEL_ID}`);
  const tStartRer = Date.now();
  const { dtype: rerankerDtype } = await getReranker();
  log(`reranker ready (dtype=${rerankerDtype}, ${Date.now() - tStartRer} ms)`);

  log('smoke test: embed("hello")');
  const [vec] = await embed(['hello']);
  const norm = assertEmbeddingShape(vec);
  log(`  shape OK (${vec.length}-d), norm=${norm.toFixed(6)}`);

  log('smoke test: rerank("hello", ["world"])');
  const scores = await rerank('hello', ['world']);
  const score = assertRerankScore(scores);
  log(`  score=${score.toFixed(6)} (sigmoid-applied, in [0, 1])`);

  log(`success: mindwright models are cached and operational`);
  process.stdout.write(
    `mindwright:setup ok dtype=${dtype} embed_dim=${EMBEDDING_DIM} rerank=${Math.round(score * 1000) / 10}%\n`
  );
}

// Only run main() when this file is invoked directly by /mindwright:setup —
// importing it from a test should not download 5GB of models. Same gate
// pattern as mcp/server.mjs.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[mindwright:setup] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
