import { spawn } from 'node:child_process';

// callJudge spawns `claude -p` headless and returns parsed JSON.
// Pattern mirrors agentwright's spawnAuditor but in single-shot JSON mode.
//
// Usage:
//   const verdict = await callJudge({
//     system: 'You judge whether a Reddit post describes a code-only product need. Return strict JSON {is_need: boolean, target_user: string, pain: string}.',
//     user: postBody,
//   });

// Default model is sourced from $IDEAWRIGHT_LLM_MODEL when set; otherwise
// Opus 4.6. Call sites may override via the `model` option (typically fed
// from `config.llm.model` by the runner).
const DEFAULT_MODEL = process.env.IDEAWRIGHT_LLM_MODEL || 'claude-opus-4-6';

export async function callJudge({
  system,
  user,
  model = DEFAULT_MODEL,
  cwd = process.cwd(),
  timeoutMs = 60_000,
} = {}) {
  if (!system || !user) throw new Error('callJudge: system and user are required');
  return new Promise((resolve, reject) => {
    const args = [
      '-p', user,
      '--output-format', 'json',
      '--append-system-prompt', system,
      '--model', model,
      '--permission-mode', 'dontAsk',
    ];
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in response');
  return JSON.parse(m[0]);
}
