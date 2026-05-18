// Embedder + reranker loaders for mindwright.
//
// Models load as lazy singletons in-process. The ONLY process that should load
// them is the machine-wide model daemon (scripts/model-daemon.mjs): it holds them
// for the whole machine over a fixed global socket, so hooks and the CLI never
// pay the ONNX cold-load themselves.
//
// Embedder: Xenova/bge-m3, dtype q8 with fp16 fallback when q8 is missing.
// Reranker: onnx-community/bge-reranker-v2-m3-ONNX, dtype q8 with fp16
//   fallback. We explicitly opt into a single-file quantized variant because
//   the upstream repo's default `model.onnx` is a 657 KB graph stub paired
//   with a 2.27 GB `model.onnx_data` sidecar that transformers.js only fetches
//   with `use_external_data_format: true`. Without the dtype hint the load
//   completes with a missing sidecar and ONNX-runtime fails at first
//   inference. Raw logits → manual sigmoid (the ONNX port omits sigmoid).

// transformers.js resolved from the persistent node_modules via
// lib/native-require.js. createRequire().resolve() picks the `require`
// condition → webpack-bundled CJS build whose named exports the
// cjs-module-lexer can't see, so symbols live only on module.exports —
// loadNativeDefault() returns that. Top-level await is safe: this file loads
// only AFTER the readiness gate, never from a deps-less hook process.
import { loadNativeDefault } from './native-require.js';
const { pipeline, AutoModelForSequenceClassification, AutoTokenizer, env } =
  await loadNativeDefault('@huggingface/transformers');

import { EMBEDDING_DIM } from './constants.js';
import { modelCacheDir } from './paths.js';

// Redirect transformers.js' model cache OFF its volatile package-local default
// (node_modules/@huggingface/transformers/.cache/ — destroyed by a
// transformers.js version bump or a dependency reinstall, forcing a multi-GB
// re-download) onto the durable ${CLAUDE_PLUGIN_DATA}/model-cache: the
// Claude-Code-documented persistent plugin data dir that survives plugin
// updates and dependency reinstalls, and is OUTSIDE node_modules so npm never
// touches it. transformers.js reads env.cacheDir at fetch time; setting it
// ONCE here at module init — before any getEmbedder/getReranker — keeps every
// load and embedderCached()'s probe (lib/paths.js) on one agreed location.
env.cacheDir = modelCacheDir();

export const EMBEDDER_MODEL_ID = 'Xenova/bge-m3';
export const RERANKER_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';
// Re-exported from lib/constants.js (single source of truth).
export { EMBEDDING_DIM };

let _embedderPromise = null;
let _rerankerPromise = null;
// Resolved instances kept so disposeModels() can release the native ONNX
// sessions. transformers.js disposal is MANUAL (PreTrainedModel.dispose /
// Pipeline.dispose; its FinalizationRegistry auto-free is still a @todo), so
// a dropped model's native session — owned by onnxruntime-node, outside V8
// GC — leaks until process exit unless we dispose it explicitly.
let _embedderPipe = null; // a Pipeline (has async .dispose())
let _rerankerModel = null; // a PreTrainedModel (has async .dispose())

// ONNX Runtime's CPU memory arena is ON by default and grows to the
// worst-case batch×sequence high-water mark, never returning it to the OS
// (documented ORT behavior, maintainer-confirmed: a 2 MB model can
// pre-allocate ~6 GB). A long-lived daemon serving highly variable batch
// sizes ratchets RSS to tens of GB and stays there. transformers.js spreads
// `session_options` straight through to onnxruntime's
// InferenceSession.create, so disabling the arena here is the one effective
// lever. The key MUST be camelCase — onnxruntime-node ignores the Python
// `enable_cpu_mem_arena` silently.
const ONNX_SESSION_OPTIONS = { enableCpuMemArena: false };

async function safeDispose(obj) {
  try {
    if (obj && typeof obj.dispose === 'function') await obj.dispose();
  } catch {
    /* best-effort: a failed dispose must never crash shutdown/reload */
  }
}

/**
 * Release the resident embedder + reranker ONNX sessions and clear the
 * loader caches. Called by the model daemon on idle-exit / shutdown /
 * RSS-recycle. Safe to call repeatedly and before any load (a no-op when
 * nothing is resolved). The next getEmbedder/getReranker cold-loads again.
 */
export async function disposeModels() {
  const pipe = _embedderPipe;
  const model = _rerankerModel;
  _embedderPipe = null;
  _rerankerModel = null;
  _embedderPromise = null;
  _rerankerPromise = null;
  await safeDispose(pipe);
  await safeDispose(model);
}

/**
 * Load the embedder at dtype='q8', falling back to 'fp16' when q8 isn't
 * shipped in the cached repo.
 *
 * @param {(task: string, model: string, opts: object) => Promise<any>} pipelineFn
 * @param {string} modelId
 * @returns {Promise<{ pipe: any, dtype: 'q8'|'fp16' }>}
 */
export async function _loadEmbedderWithFallback(pipelineFn, modelId) {
  try {
    const pipe = await pipelineFn('feature-extraction', modelId, {
      dtype: 'q8',
      session_options: ONNX_SESSION_OPTIONS,
    });
    return { pipe, dtype: 'q8' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(
      `[mindwright/models] embedder load with dtype='q8' failed (${message}); ` +
        `falling back to dtype='fp16'. This is expected when the upstream repo ` +
        `does not ship model_quantized.onnx.`
    );
    const pipe = await pipelineFn('feature-extraction', modelId, {
      dtype: 'fp16',
      session_options: ONNX_SESSION_OPTIONS,
    });
    return { pipe, dtype: 'fp16' };
  }
}

// _pipelineFn is a test-only seam.
export async function getEmbedder({ _pipelineFn = pipeline } = {}) {
  if (_embedderPromise) return _embedderPromise;
  // DROP the cache on rejection so a transient load failure doesn't
  // permanently wedge embedding for the process lifetime.
  _embedderPromise = _loadEmbedderWithFallback(_pipelineFn, EMBEDDER_MODEL_ID)
    .then((res) => {
      _embedderPipe = res.pipe; // record for disposeModels()
      return res;
    })
    .catch((err) => {
      _embedderPromise = null;
      throw err;
    });
  return _embedderPromise;
}

/**
 * Load the reranker at dtype='q8', falling back to 'fp16'. The tokenizer
 * load is dtype-agnostic so it runs in parallel with the first model attempt.
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
    model = await modelFn(modelId, { dtype: 'q8', session_options: ONNX_SESSION_OPTIONS });
    dtype = 'q8';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(
      `[mindwright/models] reranker load with dtype='q8' failed (${message}); ` +
        `falling back to dtype='fp16'. This is expected when the upstream repo ` +
        `does not ship model_quantized.onnx.`
    );
    model = await modelFn(modelId, { dtype: 'fp16', session_options: ONNX_SESSION_OPTIONS });
    dtype = 'fp16';
  }
  const tokenizer = await tokenizerPromise;
  return { model, tokenizer, dtype };
}

// _modelFn / _tokenizerFn are test-only seams.
export async function getReranker({
  _modelFn = (modelId, opts) => AutoModelForSequenceClassification.from_pretrained(modelId, opts),
  _tokenizerFn = (modelId) => AutoTokenizer.from_pretrained(modelId),
} = {}) {
  if (_rerankerPromise) return _rerankerPromise;
  _rerankerPromise = _loadRerankerWithFallback(_modelFn, _tokenizerFn, RERANKER_MODEL_ID)
    .then((res) => {
      _rerankerModel = res.model; // record for disposeModels()
      return res;
    })
    .catch((err) => {
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
  // Fail loud on shape mismatch rather than emit NaN scores: `Math.exp(
  // -undefined)===NaN` gets silently dropped by `score >= floor`, looking
  // like rerank-floor abstention. The daemon-pipe handler converts a throw
  // into a null response that pipe-client + retriever degrade against
  // (1.0-per-row fallback).
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
  // Fire-and-forget dispose so a real loaded model from one test does not
  // leak into the next; stubs have no .dispose() so this is a no-op there.
  void safeDispose(_embedderPipe);
  void safeDispose(_rerankerModel);
  _embedderPipe = null;
  _rerankerModel = null;
  _embedderPromise = null;
  _rerankerPromise = null;
}
