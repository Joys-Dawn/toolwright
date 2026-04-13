'use strict';

// Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
// Used to back off between lock/rename retries without spinning.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

module.exports = { sleepSync };
