// Shared harness for the converted tool tests. The MCP server is gone; the
// same handlers are now driven through scripts/mindwright.mjs exactly as the
// skills drive them. cliCall spawns the CLI once per call (stateless, like
// the skill invocations) and returns the unwrapped JSON payload plus an
// isError flag derived from the payload's `error` field — the faithful
// replacement for the old `{ result, isError }` MCP envelope.

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'scripts',
  'mindwright.mjs',
);

// tool: MCP name with or without the `mindwright_` prefix (the CLI accepts
// either; we strip it for the short form skills use).
// args: object | undefined. { projectRoot, sessionId } required.
export function cliCall(tool, args, { projectRoot, sessionId }) {
  const short = String(tool).replace(/^mindwright_/, '');
  const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
  const argv = [SCRIPT, short];
  if (sessionId) argv.push('--session-id', sessionId);
  const r = spawnSync(process.execPath, argv, {
    input: hasArgs ? JSON.stringify(args) : '',
    encoding: 'utf8',
    cwd: projectRoot,
    env: {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: projectRoot,
      // Hermetic: deterministic stub embed/rerank, no model daemon, no ONNX.
      MINDWRIGHT_USE_STUB_MODELS: '1',
      MINDWRIGHT_MODEL_DAEMON_DISABLE: '1',
    },
  });
  let payload;
  try {
    payload = JSON.parse(String(r.stdout || '').trim());
  } catch {
    payload = { error: `unparseable CLI stdout (status=${r.status}): ${r.stdout} | stderr: ${r.stderr}` };
  }
  const isError =
    payload != null && typeof payload === 'object' && 'error' in payload;
  return { payload, isError, raw: r };
}
