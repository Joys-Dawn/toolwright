import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// callJudge spawns `claude -p` headless and returns parsed JSON.
// Pattern mirrors agentwright's spawnAuditor but in single-shot JSON mode.
//
// Usage:
//   const verdict = await callJudge({
//     system: 'You judge whether a Reddit post describes a code-only product need. Return strict JSON {is_need: boolean, target_user: string, pain: string}.',
//     user: postBody,
//   });

// Default model is sourced from $IDEAWRIGHT_LLM_MODEL when set; otherwise
// Haiku 4.5 (matches the shipped config and keeps fallback cheap). Call sites
// may override via the `model` option (typically fed from `config.llm.model`
// by the runner).
const DEFAULT_MODEL = process.env.IDEAWRIGHT_LLM_MODEL || 'claude-haiku-4-5-20251001';

// Sandbox cwd for spawned `claude -p` processes. The wrightward SessionStart
// hook reads `<cwd>/.claude/wrightward.json` and exits early when ENABLED=false —
// so each judge call boots without registering on the bus or polluting the
// agent roster. Computed once and reused across all spawns.
let _judgeCwd = null;
function getJudgeCwd() {
  if (_judgeCwd) return _judgeCwd;
  const dir = join(tmpdir(), 'ideawright-judge-sandbox');
  const cfgDir = join(dir, '.claude');
  const cfgPath = join(cfgDir, 'wrightward.json');
  if (!existsSync(cfgPath)) {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ ENABLED: false }, null, 2));
  }
  _judgeCwd = dir;
  return dir;
}

// Collapse whitespace and bound a captured stream so a multi-line stack trace
// (e.g. a spawned-session hook crash) becomes one readable, length-capped line.
function clip(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function callJudge({
  system,
  user,
  model = DEFAULT_MODEL,
  cwd,
  timeoutMs = 180_000,
  _spawn,
} = {}) {
  if (!system || !user) throw new Error('callJudge: system and user are required');
  const spawnFn = _spawn ?? spawn;
  const spawnCwd = cwd ?? getJudgeCwd();
  return new Promise((resolve, reject) => {
    // Prompt goes via stdin (-p with no inline arg), not argv. Long
    // batches (e.g., 20 arxiv abstracts at 1800 chars each) easily
    // exceed Windows' ~32KB CreateProcess command-line limit, causing
    // spawn ENAMETOOLONG. Same pattern agentwright uses in
    // coordinator/process-manager.js.
    const args = [
      '-p',
      '--output-format', 'json',
      '--append-system-prompt', system,
      '--model', model,
      '--permission-mode', 'dontAsk',
      // Judge calls are single-shot and never resumed, and a daily run makes
      // hundreds-to-thousands of them — all sharing one stable sandbox cwd.
      // Without this, each call drops a fresh <session>.jsonl into that one
      // ~/.claude/projects/<slug> dir, so it balloons with transcripts the
      // judge never reads. --no-session-persistence (only valid with -p)
      // skips the disk write entirely; the JSON result still returns on stdout.
      '--no-session-persistence',
    ];
    const child = spawnFn('claude', args, { cwd: spawnCwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`callJudge timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(user);
    }
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        // `claude --output-format json` writes its real failure to STDOUT, and
        // a kill shows up as a signal with code=null. The old message reported
        // only stderr — empty for the common failure — losing the actual
        // reason. Surface code+signal+stderr+stdout, whitespace-collapsed and
        // bounded so it fits the raw_observations.last_error cap.
        reject(new Error(
          `claude exited code=${code} signal=${signal ?? 'null'}`
          + ` | stderr: ${clip(stderr, 500) || '<empty>'}`
          + ` | stdout: ${clip(stdout, 400) || '<empty>'}`,
        ));
        return;
      }
      try {
        const outer = JSON.parse(stdout);
        const text = outer.result ?? outer.response ?? stdout;
        resolve(extractJson(text));
      } catch (e) {
        reject(new Error(`callJudge parse error: ${e.message}; raw: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

export function extractJson(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch {}
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const obj = stripped.match(/\{[\s\S]*\}/);
  if (obj) return JSON.parse(obj[0]);
  const arr = stripped.match(/\[[\s\S]*\]/);
  if (arr) return JSON.parse(arr[0]);
  throw new Error('no JSON object or array in response');
}
