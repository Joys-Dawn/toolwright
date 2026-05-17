#!/usr/bin/env node
// mindwright CLI — the single entrypoint every memory skill invokes.
//
// Replaces the per-session MCP server: instead of a long-lived process
// exposing tools over the MCP protocol, each skill runs
//   node scripts/mindwright.mjs <tool> --session-id '${CLAUDE_SESSION_ID}'
// with a JSON args object on stdin. Claude Code substitutes the real session
// id into the skill command (the same ${CLAUDE_SESSION_ID} pattern wrightward
// and gripewright already use), so there is no ticket polling / session-bind.
//
// The tool logic itself is unchanged — this dispatches into the exact same
// mcp/tools.mjs#handleToolCall handlers the MCP server used. Embeddings go to
// the MACHINE-wide model daemon (one ONNX load per box, not per session) via
// the pipe-client; the adapter throws on a down daemon so the handlers' own
// degrade paths behave exactly as they did with the old in-process models.
//
// Output contract: the handler's JSON payload is printed to stdout (the MCP
// {content:[{text}]} envelope is unwrapped). Always exit 0 and always emit
// the JSON — soft errors (SETUP_HINT, validation) carry an `error` field the
// skill relays to the user, exactly as the MCP tool result did.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { depsInstalled } from '../lib/ready.js';
import { maybeAutoInstall, installLogPath } from '../lib/auto-setup.js';

function parseArgv(argv) {
  // First non-flag token is the tool; flags are --key value (or --flag).
  let tool = null;
  let sessionId = null;
  let inlineArgs = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') { sessionId = argv[++i] ?? null; continue; }
    if (a === '--args') { inlineArgs = argv[++i] ?? null; continue; }
    if (a.startsWith('--session-id=')) { sessionId = a.slice('--session-id='.length); continue; }
    if (a.startsWith('--args=')) { inlineArgs = a.slice('--args='.length); continue; }
    if (!a.startsWith('-') && tool === null) { tool = a; continue; }
  }
  return { tool, sessionId, inlineArgs };
}

function readStdinJson() {
  // Skills pass the args object via a heredoc on stdin (the wrightward
  // pattern). A TTY / no pipe / empty body → no args.
  try {
    if (process.stdin.isTTY) return {};
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return { __parse_error: true };
  }
}

function emit(payload, { toStderrNote } = {}) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  if (toStderrNote) process.stderr.write(`mindwright: ${toStderrNote}\n`);
}

async function main() {
  const { tool: rawTool, sessionId, inlineArgs } = parseArgv(process.argv.slice(2));
  if (!rawTool) {
    emit({ error: 'usage: mindwright.mjs <tool> [--session-id <id>] [--args <json> | JSON on stdin]' });
    return;
  }
  const tool = rawTool.startsWith('mindwright_') ? rawTool : `mindwright_${rawTool}`;

  let args;
  if (inlineArgs != null) {
    try { args = JSON.parse(inlineArgs); }
    catch { emit({ error: `--args is not valid JSON: ${inlineArgs.slice(0, 200)}` }); return; }
  } else {
    args = readStdinJson();
    if (args && args.__parse_error) { emit({ error: 'stdin is not valid JSON' }); return; }
  }

  // Dependency gate (same contract as scripts/seed-from-repo.js): a deps-less
  // marketplace copy must not ESM-crash on the better-sqlite3 import.
  if (!depsInstalled()) {
    maybeAutoInstall();
    emit(
      { error: 'deps_not_installed', detail: `mindwright native deps installing in the background (log: ${installLogPath()}). Retry shortly.` },
      { toStderrNote: 'native dependencies not installed yet — background install triggered' },
    );
    return;
  }

  const { openStore } = await import('../lib/store.js');
  const { handleToolCall } = await import('../mcp/tools.mjs');

  let embed;
  let rerank;
  if (process.env.MINDWRIGHT_USE_STUB_MODELS === '1') {
    // Deterministic, dependency-free stubs (constant 0.5 vector; rerank
    // 0.5 + i*0.01) — the same shapes the old MCP server's stub seam used.
    // Keeps tests hermetic (no daemon, no ONNX); also a usable offline mode.
    const { EMBEDDING_DIM } = await import('../lib/constants.js');
    embed = async (texts) => texts.map(() => { const v = new Float32Array(EMBEDDING_DIM); v.fill(0.5); return v; });
    rerank = async (_q, candidates) => candidates.map((_, i) => 0.5 + i * 0.01);
  } else {
    const { connectPipe } = await import('../lib/pipe-client.js');
    // Machine-wide model daemon adapter. Mirrors the OLD in-process
    // realEmbed/realRerank contract: resolve to vectors/scores or THROW —
    // never null — so the handlers' existing try/catch degrade paths (e.g.
    // retain's sweeper-backfill fallback) and retrieve()'s internal handling
    // behave exactly as under the MCP server. A down daemon throws here;
    // connectPipe has already fire-and-forget respawned it for the retry.
    const pipe = connectPipe(sessionId);
    embed = async (texts) => {
      const v = await pipe.embed(texts);
      if (!Array.isArray(v)) throw new Error('mindwright model daemon unavailable — retry shortly (it is being started)');
      return v;
    };
    rerank = async (query, candidates) => {
      const s = await pipe.rerank(query, candidates);
      if (!Array.isArray(s)) throw new Error('mindwright model daemon unavailable — retry shortly (it is being started)');
      return s;
    };
  }

  const { UNBOUND_SESSION_ID } = await import('../lib/constants.js');
  const store = openStore();
  try {
    // Mirror the old MCP server's binding contract exactly: ctx.sessionId is
    // the real id or null (session-requiring tools error on null, as before);
    // the store's author falls back to UNBOUND_SESSION_ID so rows written
    // without a session still land in the well-known unbound bucket that
    // status/unbound_count and drainBatch's cross-session hint key on —
    // never a NULL author.
    const sid = sessionId || null;
    store.setSessionId(sid || UNBOUND_SESSION_ID);
    const ctx = { store, sessionId: sid, embed, rerank };
    const res = await handleToolCall(tool, args, ctx);
    // Unwrap the MCP envelope {content:[{type:'text',text:<json>}], isError?}.
    let payload;
    try {
      payload = JSON.parse(res.content[0].text);
    } catch {
      payload = { error: 'internal: tool returned an unparseable result' };
    }
    emit(payload, res.isError ? { toStderrNote: `tool ${tool} returned an error` } : undefined);
  } finally {
    store.close();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    // Last-resort: never crash silently — emit the structured error the
    // skill expects on stdout, plus a stack on stderr for operators.
    process.stdout.write(JSON.stringify({ error: (err && err.message) || String(err) }) + '\n');
    process.stderr.write(`mindwright CLI crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
