#!/usr/bin/env node
'use strict';

// PreToolUse hook for the Bash tool.
//
// Background: Claude Code's permission glob matcher (`Bash(node *)` declared
// in a skill's frontmatter) does not match commands that contain newlines or
// quoted arguments — see anthropics/claude-code#11932 and #32818. Wrightward's
// collab skills invoke node scripts via heredoc-fed JSON, which hits both
// defeaters at once. The result is a permission prompt on every skill call,
// even though the skill declared `allowed-tools: Bash(node *)`.
//
// This hook bypasses the broken glob matcher by emitting a PreToolUse
// `permissionDecision: 'allow'` for Bash commands that invoke a wrightward
// script under this plugin's own scripts directory. The check is pinned to
// absolute paths rooted at PLUGIN_ROOT (computed from __dirname, not from
// the command text), so a malicious command cannot spoof its way past the
// check by embedding a fake path string.

const fs = require('fs');
const path = require('path');

// Plugin root, computed from this file's location. Matches the value that
// ${CLAUDE_PLUGIN_ROOT} expands to when skills invoke wrightward scripts.
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR_ABS = path.join(PLUGIN_ROOT, 'scripts');

// Enumerate approved scripts dynamically from the plugin's scripts directory.
// This avoids drift: if a future wrightward skill invokes a new script,
// it's auto-approved without having to remember to update a hand-maintained
// list. The scripts directory is purpose-built for skill invocations, so
// everything in it is a legitimate target.
function loadApprovedScripts() {
  try {
    return fs.readdirSync(SCRIPTS_DIR_ABS)
      .filter(f => f.endsWith('.js'));
  } catch (err) {
    // Fail-safe: return empty list so the hook defers rather than crashing.
    // Surface the error to stderr so a user debugging "wrightward prompts
    // came back" has a breadcrumb in the session log.
    process.stderr.write('[wrightward/bash-allow] could not read scripts dir: ' + err.message + '\n');
    return [];
  }
}

const APPROVED_SCRIPTS = loadApprovedScripts();

function normalize(s) {
  if (typeof s !== 'string') return '';
  let n = s.replace(/\\/g, '/');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function isApprovedWrightwardCommand(command) {
  if (typeof command !== 'string') return false;
  // Match: optional whitespace, `node`, whitespace, then the first argument
  // (quoted or unquoted, stopping at whitespace/quote). We compare the
  // SCRIPT path specifically — not any substring of the command — so flag
  // values that happen to contain a wrightward script path do not get
  // auto-approved (e.g. `node other.js --input /plugin/scripts/context.js`).
  //
  // `i` flag: Windows path comparison is case-insensitive. On POSIX this
  // is irrelevant because the normalized comparison below is case-sensitive
  // and the captured path casing is preserved.
  const m = command.match(/^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return false;

  const scriptPath = normalize(m[1] || m[2] || m[3]);
  const scriptsDir = normalize(SCRIPTS_DIR_ABS) + '/';

  return APPROVED_SCRIPTS.some(s => scriptPath === scriptsDir + s);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_) {
    process.exit(0); // malformed — defer to normal permission flow
  }

  const { tool_name, tool_input } = payload || {};
  if (tool_name !== 'Bash' || !tool_input || typeof tool_input.command !== 'string') {
    process.exit(0);
  }

  if (!isApprovedWrightwardCommand(tool_input.command)) {
    process.exit(0); // not ours — defer
  }

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow'
    }
  });
  // Use the callback form: on POSIX, process.stdout to a pipe is asynchronous
  // and `process.exit()` does not wait for pending writes to flush. Calling
  // exit() before the callback fires would silently drop the decision.
  // https://nodejs.org/api/process.html#a-note-on-process-io
  process.stdout.write(output, () => process.exit(0));
}

// Never fail closed — exit 0 on unexpected errors so the normal permission
// flow still applies. At worst the user sees the same prompt as before.
main().catch(err => {
  process.stderr.write('[wrightward/bash-allow] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
