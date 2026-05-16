// Uniform stderr logging for hook scripts. Pre-existing call sites used
// several slightly different formats (some prefixed the hook name, some
// didn't; "crashed" vs "failed"). A single helper keeps the output
// grep-friendly: `[mindwright/<hook>] <stage>: <message>` everywhere.
//
// Hooks run as short-lived stdio processes spawned by Claude Code. Their
// stdout is consumed by Claude Code (must be JSON or empty); stderr is the
// only diagnostic channel back to an operator running `claude --debug` or
// tailing the agent's stderr stream.

export function logHookError(hookName, stage, e) {
  const msg = e && e.message ? e.message : e;
  process.stderr.write(`[mindwright/${hookName}] ${stage}: ${msg}\n`);
}
