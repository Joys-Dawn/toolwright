'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 50;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function defaultLogFile() {
  return path.join(os.homedir(), '.claude', 'gripewright', 'log.ndjson');
}

function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (err.code === 'EPERM' && attempt < RENAME_ATTEMPTS - 1) {
        sleepMs(RENAME_BACKOFF_MS * (attempt + 1));
        continue;
      }
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }
}

function appendRecord(record, opts = {}) {
  const file = opts.logFile ?? defaultLogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function readAllRecords(opts = {}) {
  const file = opts.logFile ?? defaultLogFile();
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
    }
  }
  return records;
}

function rewriteAllRecords(records, opts = {}) {
  const file = opts.logFile ?? defaultLogFile();
  const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  atomicWriteText(file, content);
}

module.exports = {
  defaultLogFile,
  atomicWriteText,
  appendRecord,
  readAllRecords,
  rewriteAllRecords,
};
