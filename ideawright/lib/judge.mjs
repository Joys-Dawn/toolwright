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

export async function callJudge({
  system,
  user,
  model = DEFAULT_MODEL,
  cwd,
  timeoutMs = 180_000,
} = {}) {
  if (!system || !user) throw new Error('callJudge: system and user are required');
  const spawnCwd = cwd ?? getJudgeCwd();
  return new Promise((resolve, reject) => {
    const args = [
      '-p', user,
      '--output-format', 'json',
      '--append-system-prompt', system,
      '--model', model,
      '--permission-mode', 'dontAsk',
    ];
    const child = spawn('claude', args, { cwd: spawnCwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`callJudge timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
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

function extractJson(text) {
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
