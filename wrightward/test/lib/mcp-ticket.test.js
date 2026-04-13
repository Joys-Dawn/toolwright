'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  BINDINGS_DIR,
  ticketFilename,
  ticketPath,
  bindingsDir,
  ppidPrefix
} = require('../../lib/mcp-ticket');

// Pin the binding contract: session-bind.mjs's prefix matcher assumes
// `<claudePid>-<hookPid>.json` exactly. If ticketFilename ever changes
// separator or layout, register/bind/cleanup all break silently.

describe('mcp-ticket', () => {
  describe('ticketFilename', () => {
    it('encodes pids as "<claudePid>-<hookPid>.json"', () => {
      assert.equal(ticketFilename(1234, 5678), '1234-5678.json');
    });

    it('accepts string-valued pids without mutation', () => {
      assert.equal(ticketFilename('1234', '5678'), '1234-5678.json');
    });
  });

  describe('ppidPrefix', () => {
    it('returns the "<claudePid>-" prefix used by the binder to scan tickets', () => {
      assert.equal(ppidPrefix(1234), '1234-');
    });

    it('matches the prefix produced by ticketFilename for the same claudePid', () => {
      const filename = ticketFilename(1234, 5678);
      assert.ok(filename.startsWith(ppidPrefix(1234)));
    });
  });

  describe('ticketPath', () => {
    it('joins collabDir + bindings dir + ticket filename', () => {
      const p = ticketPath('/tmp/cd', 1234, 5678);
      assert.equal(p, path.join('/tmp/cd', BINDINGS_DIR, '1234-5678.json'));
    });
  });

  describe('bindingsDir', () => {
    it('joins collabDir + bindings dir', () => {
      assert.equal(bindingsDir('/tmp/cd'), path.join('/tmp/cd', BINDINGS_DIR));
    });
  });

  describe('BINDINGS_DIR constant', () => {
    it('is "mcp-bindings" — the name cleanup.js, register.js, and session-bind.mjs all rely on', () => {
      assert.equal(BINDINGS_DIR, 'mcp-bindings');
    });
  });
});
