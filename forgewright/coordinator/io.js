'use strict';

// NOTE: Each toolwright plugin implements its own JSON I/O independently.
// This is intentional — plugins are installed and distributed separately, so
// runtime code must not be shared. Duplicated patterns are acceptable.

const fs = require('fs');
const path = require('path');

// On Windows, fs.renameSync intermittently fails with EPERM/EACCES when
// another process briefly has the target file open (antivirus, indexer,
// concurrent reader). Retry a few times with a linear-backoff sleep before
// giving up. Atomics.wait on a tiny SharedArrayBuffer is the canonical
// way to block synchronously without burning a CPU core.
const MAX_RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_MS = 20;
const waitBuf = new Int32Array(new SharedArrayBuffer(4));

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  let lastErr;
  for (let attempt = 0; attempt < MAX_RENAME_RETRIES; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EACCES') break;
      Atomics.wait(waitBuf, 0, 0, RENAME_RETRY_BASE_MS * (attempt + 1));
    }
  }
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  throw lastErr;
}

function readJson(filePath, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

module.exports = {
  writeJson,
  readJson,
  appendJsonLine,
  removePath
};
