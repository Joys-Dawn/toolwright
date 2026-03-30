'use strict';

// NOTE: agentwright has its own atomic writeJson in coordinator/io.js.
// The duplication is intentional — both plugins are independently
// distributable and must not share runtime code.

const fs = require('fs');

/**
 * Writes JSON to a file atomically using a temp-file + rename pattern.
 * Prevents corruption if the process is killed mid-write.
 * @param {string} filePath - Target file path.
 * @param {*} data - Data to serialize as JSON.
 */
function atomicWriteJson(filePath, data) {
  fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

module.exports = { atomicWriteJson };
