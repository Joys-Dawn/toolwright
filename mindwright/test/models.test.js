// Tests for lib/models.js
//
// Most tests touch the network and the full ONNX runtime, so they're gated
// behind MINDWRIGHT_SKIP_MODEL_TESTS=1 — CI and fresh-clone scenarios set
// that to skip multi-gigabyte downloads. The fallback-path test does not
// touch the network; it drives _loadEmbedderWithFallback with a stub
// pipeline factory.

import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import {
  _loadEmbedderWithFallback,
  _loadRerankerWithFallback,
  _resetForTesting,
  embed,
  rerank,
  getEmbedder,
  EMBEDDING_DIM,
} from '../lib/models.js';

const SKIP_MODEL_TESTS = process.env.MINDWRIGHT_SKIP_MODEL_TESTS === '1';

// Re-route the network-gated tests through node:test's top-level `skip` when
// MINDWRIGHT_SKIP_MODEL_TESTS=1. The function body never runs in that mode,
// so the multi-gigabyte download and onnxruntime spin-up are both avoided.
const modelTest = SKIP_MODEL_TESTS ? skip : test;

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

// ---------- network-gated: real model behavior ----------
// These exercise the real bge-m3 + bge-reranker pipeline. Skipped unless the
// caller opted in (i.e., they have models cached or are willing to download).

modelTest(
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

modelTest(
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

modelTest(
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

modelTest(
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

modelTest(
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
