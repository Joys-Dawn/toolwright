'use strict';

// NOTE: agentwright has its own atomic writeJson in coordinator/io.js.
// The duplication is intentional — both plugins are independently
// distributable and must not share runtime code.

const fs = require('fs');
const path = require('path');
const { sleepSync } = require('./sleep-sync');

const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 50;

/**
 * Writes text content to a file atomically (temp-file + rename).
 * Retries rename up to 3× on EPERM with linear backoff — Windows AV and
 * fs.watch briefly hold the target file, so the first rename often fails
 * even on otherwise-healthy writes. Always cleans up the tmp file on
 * failure (including writeFileSync failures like ENOSPC).
 * @param {string} filePath - Target file path.
 * @param {string} content - Text content to write.
 */
function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (err.code === 'EPERM' && attempt < RENAME_ATTEMPTS - 1) {
        sleepSync(RENAME_BACKOFF_MS * (attempt + 1));
        continue;
      }
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw err;
    }
  }
}

/**
 * Writes JSON to a file atomically using a temp-file + rename pattern.
 * Prevents corruption if the process is killed mid-write.
 * @param {string} filePath - Target file path.
 * @param {*} data - Data to serialize as JSON.
 */
function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

module.exports = { atomicWriteJson, atomicWriteText };
