'use strict';

const path = require('path');

// Directory (under collabDir) holding MCP-to-session binding tickets.
// register.js writes one per SessionStart hook; mcp/session-bind.mjs reads
// them to resolve which session this MCP server belongs to; cleanup.js
// removes the ticket on session end.
const BINDINGS_DIR = 'mcp-bindings';

// Ticket filenames encode both the Claude CLI pid (direct parent of the
// hook on POSIX; shell/intermediate parent on Windows) and the hook's own
// pid. The hookPid suffix lets two SessionStart hooks sharing one shell
// write distinct tickets — without it they'd collide on the same key and
// whichever wrote last would win.
function ticketFilename(claudePid, hookPid) {
  return claudePid + '-' + hookPid + '.json';
}

function ticketPath(collabDir, claudePid, hookPid) {
  return path.join(collabDir, BINDINGS_DIR, ticketFilename(claudePid, hookPid));
}

function bindingsDir(collabDir) {
  return path.join(collabDir, BINDINGS_DIR);
}

// Returns the <claudePid>- prefix used by session-bind.mjs to find tickets
// written by hooks whose process.ppid matched this MCP server's process.ppid.
function ppidPrefix(claudePid) {
  return claudePid + '-';
}

module.exports = { BINDINGS_DIR, ticketFilename, ticketPath, bindingsDir, ppidPrefix };
