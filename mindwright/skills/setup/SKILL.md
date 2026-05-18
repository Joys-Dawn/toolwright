---
name: setup
description: One-time download of the bge-m3 embedder and bge-reranker-v2-m3 cross-encoder into the local Hugging Face cache, plus a smoke test. Run once after installing mindwright before any memory features become active. ~4-5 GB on disk, ~5-15 min on first run.
allowed-tools: Bash(node *)
---

Download the local models mindwright needs and verify the environment is sane. This is a one-time setup step. Subsequent sessions reuse the cached models.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.js
```

The script:

1. Installs the plugin's native npm dependencies first if they're missing — a marketplace install (or any plugin update) leaves `node_modules` empty. This runs synchronously and is one-time; it can take a few minutes when `better-sqlite3` compiles from source. If the background self-heal already installed them, this step is a no-op; if that background prep is still in progress, the script exits early and asks you to wait a moment and re-run — expected, not a failure.
2. Loads the embedder `Xenova/bge-m3` (1024-dim, 8192-token context) with `dtype: 'q8'`, falling back to `dtype: 'fp16'` if the quantized ONNX file isn't shipped in the upstream repo. Progress lines go to stderr.
3. Loads the reranker `onnx-community/bge-reranker-v2-m3-ONNX` (raw-logit output — mindwright applies the sigmoid in code).
4. Runs a smoke test: embeds "hello" and asserts the resulting Float32Array is 1024-d and unit-normalized; reranks `("hello", "world")` and asserts the score is in `[0, 1]`.
5. Prints a final `mindwright:setup ok …` line to stdout on success, or a stack trace to stderr with exit code 1 on failure.

Models cache in the plugin's persistent data dir (`${CLAUDE_PLUGIN_DATA}/model-cache`; override the location with `MINDWRIGHT_MODEL_CACHE_DIR`) so they survive plugin updates and `/mindwright:reset`. The total download is ~4-5 GB; first run takes ~5-15 minutes depending on the connection. Re-running after the cache is warm is fast — the script still validates by re-loading and re-running the smoke test, but no bytes move over the network.

If the script fails with an HTTP error, retry — Hugging Face occasionally serves partial files. If it fails with `not a valid Win32 application` or a similar ABI mismatch on Windows, the issue is the better-sqlite3 / sqlite-vec binary combination, not the models; see the README for recovery.
