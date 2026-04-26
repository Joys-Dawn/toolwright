#!/usr/bin/env node
'use strict';

// Preprocessing step for /agentwright:verify-plan.
//
// Reads the current session's JSONL transcript, locates the most recent plan
// (via the plan_mode attachment Claude Code injects, or via --plan-path), and
// extracts the implementer's narrative + user turns + tool-use trace from the
// most recent ExitPlanMode through the end of the transcript. User messages
// are wrapped in <user>…</user> blocks so the verifier sees mid-implementation
// directives ("skip step 4") and so any free-form args on the verify-plan
// invocation itself ("/verify-plan but ignore the skip") reach the verifier as
// part of the chronological context. Writes three artifacts to a fresh temp
// dir and prints the dir path on stdout for the slash command body to pass to
// the plan-verifier subagent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findSessionJsonl,
  readTranscript,
  findLastPlanAttachment,
  findLastExitPlanMode,
  extractAssistantBlocks,
  extractToolResultsByToolUseId,
  indexOfEventByUuid
} = require('./transcript');

// Cap report.md so the subagent's tool-result for the Read of report.md stays
// well within Claude's per-tool-result content budget.
const REPORT_MAX_BYTES = 200 * 1024;
const TOOL_INPUT_MAX_LEN = 200;
const TEMP_DIR_PREFIX = 'agentwright-plan-verify-';
const STALE_TEMP_DIR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { sessionId: null, planPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan-path' && i + 1 < argv.length) {
      args.planPath = argv[++i];
    } else if (a.startsWith('--plan-path=')) {
      args.planPath = a.slice('--plan-path='.length);
    } else if (!args.sessionId && !a.startsWith('--')) {
      args.sessionId = a;
    }
  }
  return args;
}

function fail(message, exitCode = 1) {
  process.stderr.write(`extract-plan-context: ${message}\n`);
  process.exit(exitCode);
}

function warn(message) {
  process.stderr.write(`extract-plan-context: warning: ${message}\n`);
}

function shortenInput(input, maxLen = TOOL_INPUT_MAX_LEN) {
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  s = (s ?? '').replace(/\s+/g, ' ');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…[truncated]';
}

function resolveWindow(events, planAttachmentEv) {
  // Returns { startIndex, degradedStart, endIndex } describing the half-open
  // window (startIndex, endIndex) of events that constitute the implementer's
  // turns. startIndex is the ExitPlanMode (or fallback) event itself; the
  // walker iterates from startIndex+1. endIndex is always the end of the
  // transcript — the script runs during the verify-plan invocation, so the
  // last user event is that invocation itself; including it lets the user
  // pass directives to the verifier in the slash-command args.
  let startIndex = -1;
  let degradedStart = false;

  const exit = findLastExitPlanMode(events);
  if (exit) {
    const exitIdx = indexOfEventByUuid(events, exit.event.uuid);
    if (planAttachmentEv) {
      const planIdx = indexOfEventByUuid(events, planAttachmentEv.uuid);
      if (exitIdx > planIdx) {
        startIndex = exitIdx;
      } else {
        degradedStart = true;
        startIndex = planIdx;
      }
    } else {
      startIndex = exitIdx;
    }
  } else if (planAttachmentEv) {
    degradedStart = true;
    startIndex = indexOfEventByUuid(events, planAttachmentEv.uuid);
  }
  // Fallthrough: --plan-path with no plan-mode anchor at all leaves
  // startIndex = -1 so buildReportAndTrace walks the full session.

  return { startIndex, degradedStart, endIndex: events.length };
}

// Strip injected wrappers so the verifier only sees text the user actually
// typed. tool_result blocks live in user-type events but aren't user words.
const NON_USER_TEXT_PREFIXES = ['<system-reminder', '<local-command-stdout', '<local-command-stderr'];

function extractUserText(event) {
  const msg = event && event.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const content = msg.content;

  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (!c || typeof c !== 'object' || c.type !== 'text') continue;
      const t = String(c.text || '').trim();
      if (!t) continue;
      if (NON_USER_TEXT_PREFIXES.some(p => t.startsWith(p))) continue;
      parts.push(t);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  return null;
}

function buildReportAndTrace(events, startIndex, endIndex) {
  const toolResults = extractToolResultsByToolUseId(events);
  const reportSegments = [];
  const traceLines = [];
  let traceIndex = 0;

  for (let i = startIndex + 1; i < endIndex; i++) {
    const ev = events[i];
    if (!ev) continue;

    if (ev.type === 'user') {
      const userText = extractUserText(ev);
      if (userText) {
        reportSegments.push(`<user>\n${userText}\n</user>`);
      }
      continue;
    }

    if (ev.type !== 'assistant') continue;

    const blocks = extractAssistantBlocks(ev);
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        reportSegments.push(b.text);
      } else if (b.type === 'thinking' && b.text) {
        reportSegments.push(`<thinking>\n${b.text}\n</thinking>`);
      } else if (b.type === 'tool_use') {
        traceIndex++;
        const result = b.id ? toolResults.get(b.id) : null;
        const status = !result ? 'pending' : (result.isError ? 'fail' : 'ok');
        traceLines.push(`${traceIndex}\t${b.name || 'unknown'}\t${shortenInput(b.input)}\t${status}`);
      }
    }
  }

  return { reportSegments, traceLines };
}

function truncateReportBody(body) {
  // Tail-keep — most recent implementation work is what matters most for
  // verification. Slicing a UTF-8 buffer at an arbitrary byte boundary can land
  // mid-codepoint and decode to U+FFFD; advance to the next newline so the
  // surviving body always starts at a clean line boundary.
  if (Buffer.byteLength(body, 'utf8') <= REPORT_MAX_BYTES) {
    return { body, truncated: false };
  }
  const buf = Buffer.from(body, 'utf8');
  const tail = buf.subarray(buf.length - REPORT_MAX_BYTES);
  const nl = tail.indexOf(0x0a);
  const cleanTail = nl >= 0 ? tail.subarray(nl + 1) : tail;
  return { body: cleanTail.toString('utf8'), truncated: true };
}

function safeWriteFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    fail(`Failed to write ${filePath}: ${err.message}`);
  }
}

function sweepStaleTempDirs() {
  // Best-effort cleanup of prior runs' temp dirs older than 7 days. Failures
  // here are silent — this is housekeeping, not a precondition.
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_DIR_AGE_MS;
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const full = path.join(os.tmpdir(), ent.name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore — another process may have cleaned it, or it's locked
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessionId) {
    fail('Usage: extract-plan-context.js <sessionId> [--plan-path <path>]');
  }

  sweepStaleTempDirs();

  const jsonlPath = findSessionJsonl(args.sessionId);
  if (!jsonlPath) {
    fail(`Session transcript not found for sessionId=${args.sessionId}. Pass --plan-path <path> to bypass auto-detection.`);
  }

  let events;
  try {
    events = readTranscript(jsonlPath);
  } catch (err) {
    fail(`Failed to read transcript at ${jsonlPath}: ${err.message}`);
  }

  let planPath = args.planPath;
  let planAttachmentEv = null;
  if (!planPath) {
    planAttachmentEv = findLastPlanAttachment(events);
    if (!planAttachmentEv) {
      fail('No plan_mode attachment found in session transcript. Pass --plan-path <path> to bypass auto-detection.');
    }
    planPath = planAttachmentEv.attachment.planFilePath;
  }
  if (!fs.existsSync(planPath)) {
    fail(`Plan file does not exist: ${planPath}`);
  }

  let planContent;
  try {
    planContent = fs.readFileSync(planPath, 'utf8');
  } catch (err) {
    fail(`Failed to read plan file ${planPath}: ${err.message}`);
  }

  const { startIndex, degradedStart, endIndex } = resolveWindow(events, planAttachmentEv);
  if (degradedStart) {
    warn('No ExitPlanMode found after the most recent plan attachment — using plan attachment as window start (degraded extraction).');
  }
  if (startIndex < 0 && !planAttachmentEv) {
    warn('No plan-mode anchor found and --plan-path provided — implementer report scope is the entire session.');
  }

  const { reportSegments, traceLines } = buildReportAndTrace(events, startIndex, endIndex);

  let tempDir;
  try {
    // mkdtempSync is atomic and uses mode 0o700 on POSIX, so the dir holding
    // tool inputs (Bash commands, Write contents, etc.) isn't readable by other
    // local users.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  } catch (err) {
    fail(`Failed to create temp dir: ${err.message}`);
  }

  safeWriteFile(path.join(tempDir, 'plan.md'), planContent);

  const { body: reportBody, truncated } = truncateReportBody(reportSegments.join('\n\n'));

  const eventCount = Math.max(0, endIndex - startIndex - 1);
  const reportHeaderLines = [
    `# Implementer Report`,
    `# Source: ${jsonlPath}`,
    `# Plan: ${planPath}`,
    `# Window: events ${startIndex + 1}..${endIndex - 1} (${eventCount} events)`
  ];
  if (degradedStart) {
    reportHeaderLines.push('# WARNING: degraded extraction (no ExitPlanMode anchor; window starts at plan attachment)');
  }
  if (!planAttachmentEv && args.planPath) {
    reportHeaderLines.push('# NOTE: --plan-path supplied — plan was not auto-detected from session transcript');
  }
  if (truncated) {
    reportHeaderLines.push(`# WARNING: report truncated to last ${REPORT_MAX_BYTES} bytes (line-aligned)`);
  }
  safeWriteFile(
    path.join(tempDir, 'report.md'),
    reportHeaderLines.join('\n') + '\n\n' + reportBody + '\n'
  );

  const traceHeader = '# index\ttool\tinput\tstatus';
  safeWriteFile(
    path.join(tempDir, 'tool-trace.txt'),
    traceHeader + '\n' + traceLines.join('\n') + (traceLines.length > 0 ? '\n' : '')
  );

  process.stdout.write(tempDir + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  shortenInput,
  resolveWindow,
  buildReportAndTrace,
  truncateReportBody,
  extractUserText
};
