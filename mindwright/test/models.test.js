// Tests for lib/models.js


import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _loadEmbedderWithFallback,
  _loadRerankerWithFallback,
  _resetForTesting,
  disposeModels,
  embed,
  rerank,
  getEmbedder,
  getReranker,
  EMBEDDING_DIM,
} from '../lib/models.js';

// Models on first cold pull can take 10+ minutes. Even warm loads spend
// several seconds in onnxruntime-node init. 20 minutes is generous; the
// real bound is `node --test` overall, not per-test.
const MODEL_TEST_TIMEOUT_MS = 20 * 60 * 1000;

// ---------- network-free: dtype fallback ----------

test('_loadEmbedderWithFallback returns dtype=q8 when q8 load succeeds', async () => {
  const calls = [];
  const stubPipe = { _tag: 'stub-pipe' };
  const pipelineFn = async (task, modelId, opts) => {
    calls.push({ task, modelId, dtype: opts && opts.dtype });
    return stubPipe;
  };
  const { pipe, dtype } = await _loadEmbedderWithFallback(pipelineFn, 'fake/embedder');
  assert.equal(pipe, stubPipe);
  assert.equal(dtype, 'q8');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    task: 'feature-extraction',
    modelId: 'fake/embedder',
    dtype: 'q8',
  });
});

test('_loadEmbedderWithFallback falls back to fp16 when q8 load fails (missing model_quantized.onnx)', async () => {
  const calls = [];
  const fp16Pipe = { _tag: 'fp16-pipe' };
  const pipelineFn = async (task, modelId, opts) => {
    calls.push({ task, modelId, dtype: opts && opts.dtype });
    if (opts && opts.dtype === 'q8') {
      // Mirrors the kind of error transformers.js raises when a dtype-specific
      // ONNX file isn't shipped in the upstream repo.
      const err = new Error(
        'Could not locate file "https://huggingface.co/fake/embedder/resolve/main/onnx/model_quantized.onnx"'
      );
      err.name = 'AggregateError';
      throw err;
    }
    return fp16Pipe;
  };
  // Silence the expected warning during this test so it doesn't pollute the runner output.
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { pipe, dtype } = await _loadEmbedderWithFallback(pipelineFn, 'fake/embedder');
    assert.equal(pipe, fp16Pipe);
    assert.equal(dtype, 'fp16');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].dtype, 'q8');
    assert.equal(calls[1].dtype, 'fp16');
    assert.ok(
      warnings.some((w) => w.includes("dtype='q8'") && w.includes("dtype='fp16'")),
      `expected a warning about the q8→fp16 fallback, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('_loadEmbedderWithFallback propagates errors when both dtypes fail', async () => {
  const pipelineFn = async (task, modelId, opts) => {
    const err = new Error(`load failed for dtype=${opts && opts.dtype}`);
    throw err;
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      _loadEmbedderWithFallback(pipelineFn, 'fake/embedder'),
      /load failed for dtype=fp16/
    );
  } finally {
    console.warn = originalWarn;
  }
});

// ---------- network-free: reranker dtype fallback ----------

test('_loadRerankerWithFallback returns dtype=q8 when q8 load succeeds', async () => {
  const calls = [];
  const stubModel = { _tag: 'stub-model' };
  const stubTok = { _tag: 'stub-tok' };
  const modelFn = async (modelId, opts) => {
    calls.push({ kind: 'model', modelId, dtype: opts && opts.dtype });
    return stubModel;
  };
  const tokenizerFn = async (modelId) => {
    calls.push({ kind: 'tokenizer', modelId });
    return stubTok;
  };
  const { model, tokenizer, dtype } = await _loadRerankerWithFallback(modelFn, tokenizerFn, 'fake/reranker');
  assert.equal(model, stubModel);
  assert.equal(tokenizer, stubTok);
  assert.equal(dtype, 'q8');
  // q8 model attempt + 1 tokenizer attempt, no fp16 fallback.
  const modelCalls = calls.filter((c) => c.kind === 'model');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].dtype, 'q8');
});

test('_loadRerankerWithFallback falls back to fp16 when q8 load fails (missing model_quantized.onnx)', async () => {
  const calls = [];
  const fp16Model = { _tag: 'fp16-model' };
  const stubTok = { _tag: 'stub-tok' };
  const modelFn = async (modelId, opts) => {
    calls.push({ modelId, dtype: opts && opts.dtype });
    if (opts && opts.dtype === 'q8') {
      const err = new Error(
        'Could not locate file "https://huggingface.co/fake/reranker/resolve/main/onnx/model_quantized.onnx"'
      );
      err.name = 'AggregateError';
      throw err;
    }
    return fp16Model;
  };
  const tokenizerFn = async () => stubTok;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { model, tokenizer, dtype } = await _loadRerankerWithFallback(modelFn, tokenizerFn, 'fake/reranker');
    assert.equal(model, fp16Model);
    assert.equal(tokenizer, stubTok);
    assert.equal(dtype, 'fp16');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].dtype, 'q8');
    assert.equal(calls[1].dtype, 'fp16');
    assert.ok(
      warnings.some((w) => w.includes("dtype='q8'") && w.includes("dtype='fp16'")),
      `expected q8→fp16 fallback warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('_loadRerankerWithFallback propagates errors when both dtypes fail', async () => {
  const modelFn = async (_modelId, opts) => {
    throw new Error(`reranker load failed for dtype=${opts && opts.dtype}`);
  };
  const tokenizerFn = async () => ({ _tag: 'tok' });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      _loadRerankerWithFallback(modelFn, tokenizerFn, 'fake/reranker'),
      /reranker load failed for dtype=fp16/,
    );
  } finally {
    console.warn = originalWarn;
  }
});

// ---------- network-free: ONNX CPU-arena opt-out ----------
// The unbounded-RSS pathology: ONNX Runtime's CPU memory arena is ON by
// default and never returns its worst-case high-water allocation to the OS.
// transformers.js forwards session_options straight to onnxruntime's
// InferenceSession.create, so both loaders MUST pass
// { enableCpuMemArena: false } — and the key MUST be camelCase
// (onnxruntime-node silently ignores the Python snake_case form, so a typo
// here re-opens the leak with zero signal).

test('_loadEmbedderWithFallback disables the ONNX CPU arena on the q8 path', async () => {
  let opts;
  const pipelineFn = async (_task, _modelId, o) => { opts = o; return { _tag: 'p' }; };
  await _loadEmbedderWithFallback(pipelineFn, 'fake/embedder');
  assert.deepEqual(opts.session_options, { enableCpuMemArena: false });
});

test('_loadEmbedderWithFallback keeps the arena disabled on the fp16 fallback path', async () => {
  const seen = [];
  const pipelineFn = async (_task, _modelId, o) => {
    seen.push(o.session_options);
    if (o.dtype === 'q8') throw new Error('no model_quantized.onnx shipped');
    return { _tag: 'fp16' };
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await _loadEmbedderWithFallback(pipelineFn, 'fake/embedder');
  } finally {
    console.warn = origWarn;
  }
  assert.equal(seen.length, 2, 'q8 attempt + fp16 fallback both carry session_options');
  for (const so of seen) assert.deepEqual(so, { enableCpuMemArena: false });
});

test('_loadRerankerWithFallback disables the ONNX CPU arena on both dtype paths', async () => {
  const seen = [];
  const modelFn = async (_modelId, o) => {
    seen.push(o.session_options);
    if (o.dtype === 'q8') throw new Error('no model_quantized.onnx shipped');
    return { _tag: 'm' };
  };
  const tokenizerFn = async () => ({ _tag: 't' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await _loadRerankerWithFallback(modelFn, tokenizerFn, 'fake/reranker');
  } finally {
    console.warn = origWarn;
  }
  assert.equal(seen.length, 2, 'q8 attempt + fp16 fallback');
  for (const so of seen) assert.deepEqual(so, { enableCpuMemArena: false });
});

// ---------- network-free: getEmbedder cache + retry semantics ----------

test('getEmbedder drops its cache on rejection so the next call retries', async () => {
  _resetForTesting();
  // _loadEmbedderWithFallback tries dtype=q8 first, then dtype=fp16 on
  // failure — so a single throw is caught internally. To force getEmbedder
  // itself to reject we need BOTH attempts on the first getEmbedder() call
  // to fail. Track the call count and treat the first two as the first
  // getEmbedder; let the third (the q8 attempt of the retry) succeed.
  let attempts = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const flakyPipeline = async (task, modelId, opts) => {
      attempts++;
      if (attempts <= 2) {
        throw new Error('synthetic transient network failure');
      }
      return { _tag: 'recovered', _modelId: modelId, _dtype: opts && opts.dtype };
    };

    // First getEmbedder rejects — both q8 and fp16 attempts fail.
    await assert.rejects(
      () => getEmbedder({ _pipelineFn: flakyPipeline }),
      /synthetic transient/,
    );

    // Second getEmbedder MUST retry — the rejection must not have been cached.
    const result = await getEmbedder({ _pipelineFn: flakyPipeline });
    assert.equal(result.pipe._tag, 'recovered');
    assert.ok(attempts >= 3, `loader must have been called at least three times, was ${attempts}`);
  } finally {
    console.warn = originalWarn;
    _resetForTesting();
  }
});

test('getEmbedder caches the resolved value across calls (no double load)', async () => {
  _resetForTesting();
  let attempts = 0;
  const okPipeline = async () => {
    attempts++;
    return { _tag: 'happy' };
  };
  const a = await getEmbedder({ _pipelineFn: okPipeline });
  const b = await getEmbedder({ _pipelineFn: okPipeline });
  assert.equal(a, b, 'getEmbedder should return the cached pipeline on the second call');
  assert.equal(attempts, 1, 'loader should be called exactly once on the happy path');
  _resetForTesting();
});

// ---------- network-free: disposeModels (daemon idle-exit / RSS recycle) ----------
// transformers.js disposal is MANUAL (its FinalizationRegistry auto-free is a
// @todo), so a dropped model's native onnxruntime session leaks until process
// exit unless disposeModels() releases it. The daemon calls this on idle-exit /
// shutdown / RSS-recycle; it must dispose the resolved instances AND clear the
// loader cache so a post-recycle load is cold (never a dead-session pipe).

test('disposeModels disposes the resolved embedder + reranker and clears the loader cache', async () => {
  _resetForTesting();
  let embDisposed = 0;
  let rerankDisposed = 0;
  let embLoads = 0;
  const pipelineFn = async () => {
    embLoads++;
    return { _tag: 'emb', dispose: async () => { embDisposed++; } };
  };
  const modelFn = async () => ({ _tag: 'rer', dispose: async () => { rerankDisposed++; } });
  const tokenizerFn = async () => ({ _tag: 'tok' });

  await getEmbedder({ _pipelineFn: pipelineFn });
  await getReranker({ _modelFn: modelFn, _tokenizerFn: tokenizerFn });
  assert.equal(embLoads, 1, 'one cold embedder load');

  await disposeModels();
  assert.equal(embDisposed, 1, 'embedder pipe .dispose() was awaited');
  assert.equal(rerankDisposed, 1, 'reranker model .dispose() was awaited');

  // Cache cleared ⇒ the next getEmbedder cold-loads again instead of handing
  // back a disposed (dead native session) pipe.
  await getEmbedder({ _pipelineFn: pipelineFn });
  assert.equal(embLoads, 2, 'disposeModels cleared the loader cache');
  _resetForTesting();
});

test('disposeModels is a safe, idempotent no-op when nothing is loaded', async () => {
  _resetForTesting();
  await disposeModels(); // nothing resolved yet — must not throw
  await disposeModels(); // repeated — still a clean no-op
  let loads = 0;
  const pipelineFn = async () => { loads++; return { _tag: 'p' }; };
  await getEmbedder({ _pipelineFn: pipelineFn });
  assert.equal(loads, 1, 'a load after a no-op disposeModels still works');
  _resetForTesting();
});

// ---------- real model behavior (always runs; pulls ~5 GB if cache cold) ----------
// These exercise the real bge-m3 + bge-reranker pipeline end to end.

test(
  'embed("hello") returns one Float32Array of dim EMBEDDING_DIM, unit-normalized',
  { timeout: MODEL_TEST_TIMEOUT_MS },
  async () => {
    _resetForTesting();
    const vectors = await embed(['hello']);
    assert.equal(vectors.length, 1);
    const v = vectors[0];
    assert.ok(v instanceof Float32Array, 'expected Float32Array');
    assert.equal(v.length, EMBEDDING_DIM);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    assert.ok(
      Math.abs(norm - 1) < 1e-3,
      `embedding should be unit-normalized, got norm=${norm}`
    );
  }
);

test(
  'embed is semantically stable across batches for the same input',
  { timeout: MODEL_TEST_TIMEOUT_MS },
  async () => {
    _resetForTesting();
    const text = 'mindwright batch determinism test sentence';
    const [singleA] = await embed([text]);
    const [singleB, otherB] = await embed([text, 'different content here']);
    assert.equal(singleA.length, singleB.length);
    // q8-quantized BERT-family models compute attention with per-tensor
    // INT8 scale/zero-point that depends on the batch's dynamic range, so
    // the same input embeds with observable component-wise drift across
    // different batch compositions. The semantic invariant we care about is
    // "the same input produces a near-identical embedding direction", and
    // cosine similarity is the industry-standard measure for that.
    //
    // Two thresholds layered:
    //   - cos(same, same) > 0.97 — empirical q8 batch-stability floor for
    //     bge-m3 on onnxruntime-node; loose enough to tolerate quantization
    //     noise, tight enough to catch a real regression (wrong model, wrong
    //     pooling strategy, missing normalize, etc.) which would tank cos to
    //     <0.5.
    //   - cos(same, same) > cos(same, different) by a clear margin — the
    //     test that matters for retrieval. Quantization noise must be MUCH
    //     smaller than semantic discrimination, otherwise rerank/RRF can't
    //     distinguish "same query, different batch" from "different query".
    let dotSame = 0;
    let dotDiff = 0;
    for (let i = 0; i < singleA.length; i++) {
      dotSame += singleA[i] * singleB[i];
      dotDiff += singleA[i] * otherB[i];
    }
    // Both vectors are already L2-unit-normalized (CLS-pooled, normalize:true).
    const cosSame = dotSame;
    const cosDiff = dotDiff;
    assert.ok(
      cosSame > 0.97,
      `same input must embed near-identically across batches (cos > 0.97), got cos=${cosSame}`,
    );
    assert.ok(
      cosSame > cosDiff + 0.1,
      `quantization noise (cos_same=${cosSame}) must be much smaller than semantic discrimination (cos_diff=${cosDiff}); gap must exceed 0.1`,
    );
    assert.ok(otherB instanceof Float32Array);
    assert.equal(otherB.length, EMBEDDING_DIM);
  }
);

test(
  'embed handles batch input and returns per-row Float32Arrays of EMBEDDING_DIM',
  { timeout: MODEL_TEST_TIMEOUT_MS },
  async () => {
    _resetForTesting();
    const inputs = ['one', 'two', 'three'];
    const vectors = await embed(inputs);
    assert.equal(vectors.length, inputs.length);
    for (const v of vectors) {
      assert.ok(v instanceof Float32Array);
      assert.equal(v.length, EMBEDDING_DIM);
      let sumSq = 0;
      for (const x of v) sumSq += x * x;
      assert.ok(Math.abs(Math.sqrt(sumSq) - 1) < 1e-3);
    }
  }
);

test(
  'rerank returns one sigmoid-applied score per candidate in [0, 1]',
  { timeout: MODEL_TEST_TIMEOUT_MS },
  async () => {
    _resetForTesting();
    const scores = await rerank('hello', ['world', 'goodbye', 'hello again']);
    assert.equal(scores.length, 3);
    for (const s of scores) {
      assert.ok(Number.isFinite(s), `score ${s} not finite`);
      assert.ok(s >= 0 && s <= 1, `score ${s} outside [0, 1]`);
    }
  }
);

test(
  'rerank ranks a near-paraphrase higher than an unrelated candidate',
  { timeout: MODEL_TEST_TIMEOUT_MS },
  async () => {
    _resetForTesting();
    const query = 'What is the capital of France?';
    const candidates = ['Paris is the capital of France.', 'Bananas grow on trees.'];
    const [relevant, irrelevant] = await rerank(query, candidates);
    assert.ok(
      relevant > irrelevant,
      `expected relevant candidate to outrank irrelevant; got relevant=${relevant}, irrelevant=${irrelevant}`
    );
  }
);

// ---------- network-free: argument validation ----------

test('embed rejects non-array input', async () => {
  await assert.rejects(embed('not-an-array'), /must be an array/);
});

test('embed([]) returns [] without loading the model', async () => {
  _resetForTesting();
  const out = await embed([]);
  assert.deepEqual(out, []);
});

test('rerank rejects non-string query', async () => {
  await assert.rejects(rerank(42, ['x']), /query must be a string/);
});

test('rerank rejects non-array candidates', async () => {
  await assert.rejects(rerank('q', 'not-an-array'), /candidates must be an array/);
});

test('rerank with empty candidates returns [] without loading the model', async () => {
  _resetForTesting();
  const out = await rerank('q', []);
  assert.deepEqual(out, []);
});
