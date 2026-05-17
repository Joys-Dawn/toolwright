// Uniform grep-friendly stderr logging for hooks:
// `[mindwright/<hook>] <stage>: <message>`. stdout is consumed by Claude Code
// (must be JSON/empty); stderr is the only diagnostic channel.

export function logHookError(hookName, stage, e) {
  const msg = e && e.message ? e.message : e;
  process.stderr.write(`[mindwright/${hookName}] ${stage}: ${msg}\n`);
}
