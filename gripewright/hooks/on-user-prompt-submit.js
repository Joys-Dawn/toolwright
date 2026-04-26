#!/usr/bin/env node
'use strict';

const { runHook, parsePayload } = require('../lib/hook-runner');

const HOOK_NAME = 'on-user-prompt-submit';

function main(opts = {}) {
  return runHook(HOOK_NAME, { ...opts, requireWtfIsLastUser: false });
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[gripewright/${HOOK_NAME}] uncaught: ${err.stack || err.message || err}\n`);
    process.exit(0);
  });
}

module.exports = { main, parsePayload };
