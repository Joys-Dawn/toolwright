'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

function requireClaudeCli() {
  const MAX_ATTEMPTS = 3;
  const DELAY_MS = 2000;
  // Synchronous sleep — Atomics.wait is the only non-busy-wait blocking primitive in Node.
  const waitBuf = new Int32Array(new SharedArrayBuffer(4));
  let lastResult;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    lastResult = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (!lastResult.error && lastResult.status === 0) return;
    if (attempt < MAX_ATTEMPTS - 1) {
      Atomics.wait(waitBuf, 0, 0, DELAY_MS);
    }
  }
  throw new Error('Claude CLI is not available. Install Claude Code and ensure `claude` is on PATH.');
}

function buildDisallowedTools() {
  // Auditor must not modify files (Edit/Write/NotebookEdit). Everything else
  // (Bash, Skill, WebFetch, WebSearch, MCP tools) is available so it can load
  // other skills, run linters, and verify findings against official docs.
  return ['Edit', 'Write', 'NotebookEdit'];
}

function createJsonLineReader(readable, onLine) {
  let buffer = '';
  readable.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  readable.on('end', () => {
    const line = buffer.trim();
    if (line) {
      onLine(line);
    }
  });
}

function createTextDeltaLineReader(onLine) {
  let buffer = '';
  function flush() {
    const line = buffer.trim();
    buffer = '';
    if (line) {
      onLine(line);
    }
  }
  function handleDelta(text) {
    buffer += String(text || '');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }
  handleDelta.flush = flush;
  return handleDelta;
}

const AUDITOR_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

function spawnAuditor({ cwd, pluginRoot, prompt, logsDir, runId, stageName, onEvent }) {
  requireClaudeCli();
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, 'auditor.stdout.log');
  const stderrPath = path.join(logsDir, 'auditor.stderr.log');
  const stdoutLog = fs.createWriteStream(stdoutPath, { flags: 'w' });
  const stderrLog = fs.createWriteStream(stderrPath, { flags: 'w' });
  let doneEvent = null;
  let resultEvent = null;
  let sawTextDelta = false;
  const parseErrorLog = fs.createWriteStream(path.join(logsDir, 'parse-errors.log'), { flags: 'w' });
  const handleTextDelta = createTextDeltaLineReader(line => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'done') {
        doneEvent = parsed;
      }
      if (typeof onEvent === 'function' && (parsed.type === 'finding' || parsed.type === 'done')) {
        onEvent(parsed);
      }
    } catch (error) {
      parseErrorLog.write(`[text-delta] ${error.message}: ${line.slice(0, 200)}\n`);
    }
  });
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--plugin-dir',
    pluginRoot,
    '--add-dir',
    cwd,
    '--disallowedTools',
    ...buildDisallowedTools(),
    '--name',
    `agentic-auditor-${stageName}`,
    '--append-system-prompt',
    `You are the spawned auditor worker for run ${runId}. You cannot modify files (Edit, Write, NotebookEdit are unavailable) — only return structured findings. Use the Skill tool to load other agentwright skills when an audit needs them, run linters via Bash, and use WebFetch, WebSearch, and MCP tools (e.g. context7) to verify findings against official documentation when uncertain about library APIs, version-specific behavior, or best practices. Do not rely on memory alone for claims about external libraries or specifications.`
  ];
  // Prompt goes via stdin, not argv. Fused stages concatenate multiple skill
  // bodies into a prompt that easily exceeds the Windows CreateProcess
  // command-line limit (~32KB), causing spawn ENAMETOOLONG.
  const child = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  }
  child.stdout.pipe(stdoutLog, { end: false });
  child.stderr.pipe(stderrLog, { end: false });
  createJsonLineReader(child.stdout, line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        resultEvent = event;
      }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta') {
        sawTextDelta = true;
        handleTextDelta(event.event.delta.text);
      }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_stop') {
        handleTextDelta.flush();
      }
      if (!sawTextDelta && event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            handleTextDelta(`${block.text}\n`);
          }
        }
      }
      if (typeof onEvent === 'function') {
        if (event.type !== 'assistant') {
          onEvent({
            type: 'heartbeat',
            rawType: event.type || null,
            rawSubtype: event.subtype || event.event?.type || null
          });
        }
        if (event.type === 'result' && resultEvent?.is_error) {
          onEvent({
            type: 'done',
            auditType: stageName,
            summary: String(resultEvent.result || 'Auditor failed before emitting a done marker.'),
            emittedCount: 0,
            error: true
          });
        }
      }
      if (event.type === 'result' && resultEvent?.is_error) {
        doneEvent = {
          type: 'done',
          auditType: stageName,
          summary: String(resultEvent.result || 'Auditor failed before emitting a done marker.'),
          emittedCount: 0,
          error: true
        };
      }
    } catch (error) {
      parseErrorLog.write(`[stream-json] ${error.message}: ${line.slice(0, 200)}\n`);
    }
  });
  return {
    pid: child.pid,
    stdoutPath,
    stderrPath,
    wait() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
          handleTextDelta.flush();
          stdoutLog.end();
          stderrLog.end();
          parseErrorLog.end();
          resolve({
            exitCode: 1,
            resultEvent,
            doneEvent: doneEvent || {
              type: 'done',
              auditType: stageName,
              summary: `Auditor timed out after ${AUDITOR_TIMEOUT_MS / 60000} minutes.`,
              emittedCount: 0,
              error: true
            }
          });
        }, AUDITOR_TIMEOUT_MS);
        child.on('close', code => {
          clearTimeout(timer);
          handleTextDelta.flush();
          stdoutLog.end();
          stderrLog.end();
          parseErrorLog.end();
          resolve({ exitCode: code ?? 1, resultEvent, doneEvent });
        });
        child.on('error', error => {
          clearTimeout(timer);
          handleTextDelta.flush();
          stdoutLog.end();
          stderrLog.end();
          parseErrorLog.end();
          reject(error);
        });
      });
    },
    kill() {
      try {
        child.kill();
      } catch (error) {
        return;
      }
    }
  };
}

module.exports = {
  requireClaudeCli,
  spawnAuditor,
  buildDisallowedTools,
  createJsonLineReader,
  createTextDeltaLineReader
};
