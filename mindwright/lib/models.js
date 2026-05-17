// Embedder + reranker loaders for mindwright.
//
// Models live as lazy singletons inside the calling process. The MCP daemon
// (mcp/server.mjs) holds these across the session lifetime; hooks reach them
// through the daemon-pipe RPC so they never pay the cold-load cost themselves.
// See DESIGN.md "Architecture sketch" for the full picture.
//
// Embedder: Xenova/bge-m3, dtype q8 (model_quantized.onnx) with fp16 fallback
//   (model_fp16.onnx) when the q8 file is missing in the cached repo.
// Reranker: onnx-community/bge-reranker-v2-m3-ONNX, dtype q8
//   (model_quantized.onnx, ~571 MB) with fp16 fallback (model_fp16.onnx,
//   ~1.14 GB). We explicitly opt into a single-file quantized variant
//   because the upstream repo's default `model.onnx` is a 657 KB graph stub
//   that pairs with a 2.27 GB `model.onnx_data` sidecar — and transformers.js
//   only fetches that sidecar when called with `use_external_data_format:
//   true`. Without the dtype hint, the load completes with a missing sidecar
//   and ONNX-runtime fails at first inference. Raw logits → manual sigmoid
//   `1 / (1 + exp(-x))` (the ONNX port does NOT apply sigmoid itself).

// transformers.js is resolved from the persistent ${CLAUDE_PLUGIN_DATA}/
// node_modules via lib/native-require.js (see that file's header for why a
// bare import can't reach it). createRequire().resolve() picks the package's
// `require` condition → its webpack-bundled CJS build, whose named exports
// the cjs-module-lexer can't see through, so the symbols live only on the
// module.exports object — loadNativeDefault() returns exactly that. Top-level
// await is safe: models.js is only ever loaded AFTER the readiness gate
// (through the MCP daemon / sweeper / store path), never from a deps-less
// hook process.
import { loadNativeDefault } from './native-require.js';
const { pipeline, AutoModelForSequenceClassification, AutoTokenizer } =
  await loadNativeDefault('@huggingface/transformers');

export const EMBEDDER_MODEL_ID = 'Xenova/bge-m3';
export const RERANKER_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';
export const EMBEDDING_DIM = 1024;

let _embedderPromise = null;
let _rerankerPromise = null;

/**
 * Load the embedder with dtype='q8', falling back to dtype='fp16' if the
 * quantized ONNX file isn't shipped in the cached repo.
 *
 * Exported separately from getEmbedder() so tests can drive the fallback path
 * with a stubbed pipeline factory (no network, no real model load).
 *
 * @param {(task: string, model: string, opts: object) => Promise<any>} pipelineFn
 * @param {string} modelId
 * @returns {Promise<{ pipe: any, dtype: 'q8'|'fp16' }>}
 */
export async function _loadEmbedderWithFallback(pipelineFn, modelId) {
  try {
    const pipe = await pipelineFn('feature-extraction', modelId, { dtype: 'q8' });
    return { pipe, dtype: 'q8' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(
      `[mindwright/models] embedder load with dtype='q8' failed (${message}); ` +
        `falling back to dtype='fp16'. This is expected when the upstream repo ` +
        `does not ship model_quantized.onnx.`
    );
    const pipe = await pipelineFn('feature-extraction', modelId, { dtype: 'fp16' });
    return { pipe, dtype: 'fp16' };
  }
}

// The _pipelineFn override is a test-only seam — production callers always
// use the imported transformers.js `pipeline`.
export async function getEmbedder({ _pipelineFn = pipeline } = {}) {
  if (_embedderPromise) return _embedderPromise;
  // Cache the resolved value, but DROP the cache on rejection so a transient
  // load failure (network glitch during HF download, mid-bootstrap daemon)
  // doesn't permanently wedge embedding for the lifetime of the process.
  _embedderPromise = _loadEmbedderWithFallback(_pipelineFn, EMBEDDER_MODEL_ID).catch((err) => {
    _embedderPromise = null;
    throw err;
  });
  return _embedderPromise;
}

/**
 * Load the reranker with dtype='q8', falling back to dtype='fp16' if the
 * quantized ONNX file isn't shipped in the cached repo.
 *
 * Mirrors _loadEmbedderWithFallback so the reranker pulls a single-file
 * variant (model_quantized.onnx at q8 or model_fp16.onnx at fp16) instead of
 * the split model.onnx + model.onnx_data fp32 export, which transformers.js
 * won't fully fetch without `use_external_data_format: true`. The tokenizer
 * load is dtype-agnostic so it runs in parallel with the first model attempt.
 *
 * Exported separately so tests can drive the fallback path with stubbed
 * loaders.
 *
 * @param {(modelId: string, opts: object) => Promise<any>} modelFn
 * @param {(modelId: string) => Promise<any>} tokenizerFn
 * @param {string} modelId
 * @returns {Promise<{ model: any, tokenizer: any, dtype: 'q8'|'fp16' }>}
 */
export async function _loadRerankerWithFallback(modelFn, tokenizerFn, modelId) {
  const tokenizerPromise = tokenizerFn(modelId);
  let model;
  let dtype;
  try {
    model = await modelFn(modelId, { dtype: 'q8' });
    dtype = 'q8';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(
      `[mindwright/models] reranker load with dtype='q8' failed (${message}); ` +
        `falling back to dtype='fp16'. This is expected when the upstream repo ` +
        `does not ship model_quantized.onnx.`
    );
    model = await modelFn(modelId, { dtype: 'fp16' });
    dtype = 'fp16';
  }
  const tokenizer = await tokenizerPromise;
  return { model, tokenizer, dtype };
}

// The _modelFn / _tokenizerFn overrides are test-only seams — production
// callers always use transformers.js's static from_pretrained methods.
export async function getReranker({
  _modelFn = (modelId, opts) => AutoModelForSequenceClassification.from_pretrained(modelId, opts),
  _tokenizerFn = (modelId) => AutoTokenizer.from_pretrained(modelId),
} = {}) {
  if (_rerankerPromise) return _rerankerPromise;
  _rerankerPromise = _loadRerankerWithFallback(_modelFn, _tokenizerFn, RERANKER_MODEL_ID).catch((err) => {
    _rerankerPromise = null;
    throw err;
  });
  return _rerankerPromise;
}

/**
 * CLS-pooled, L2-normalized embeddings from bge-m3.
 *
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>} one Float32Array of length EMBEDDING_DIM per input
 */
export async function embed(texts) {
  if (!Array.isArray(texts)) {
    throw new TypeError('embed(texts): texts must be an array of strings');
  }
  if (texts.length === 0) return [];
  const { pipe } = await getEmbedder();
  const tensor = await pipe(texts, { pooling: 'cls', normalize: true });
  const dims = tensor.dims;
  if (dims.length !== 2 || dims[1] !== EMBEDDING_DIM) {
    throw new Error(
      `embed: expected tensor shape [batch, ${EMBEDDING_DIM}], got [${dims.join(', ')}]`
    );
  }
  const [batch, hidden] = dims;
  const flat = tensor.data;
  const out = new Array(batch);
  for (let i = 0; i < batch; i++) {
    const row = new Float32Array(hidden);
    for (let j = 0; j < hidden; j++) row[j] = flat[i * hidden + j];
    out[i] = row;
  }
  return out;
}

/**
 * Score (query, candidate) pairs through bge-reranker-v2-m3.
 *
 * @param {string} query
 * @param {string[]} candidates
 * @returns {Promise<number[]>} sigmoid-applied scores in [0, 1], one per candidate
 */
export async function rerank(query, candidates) {
  if (typeof query !== 'string') {
    throw new TypeError('rerank(query, candidates): query must be a string');
  }
  if (!Array.isArray(candidates)) {
    throw new TypeError('rerank(query, candidates): candidates must be an array of strings');
  }
  if (candidates.length === 0) return [];
  const { model, tokenizer } = await getReranker();
  const queries = new Array(candidates.length).fill(query);
  const inputs = tokenizer(queries, {
    text_pair: candidates,
    padding: true,
    truncation: true,
  });
  const outputs = await model(inputs);
  const logits = outputs?.logits?.data;
  // Fail loud on shape mismatch rather than silently emitting NaN scores —
  // `Math.exp(-undefined) === NaN`, and downstream NaN scores get silently
  // dropped by `score >= floor` comparisons, looking like rerank-floor
  // abstention. The daemon-pipe handler converts a thrown error into a
  // null response, which lib/pipe-client.js + lib/retriever.js know how to
  // degrade against (1.0-per-row fallback).
  if (!logits || logits.length < candidates.length) {
    throw new Error(
      `rerank: expected at least ${candidates.length} logits, got ${logits ? logits.length : 'undefined'}`,
    );
  }
  const out = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    out[i] = 1 / (1 + Math.exp(-logits[i]));
  }
  return out;
}

/**
 * Reset the cached loader promises. Test-only.
 */
export function _resetForTesting() {
  _embedderPromise = null;
  _rerankerPromise = null;
}
