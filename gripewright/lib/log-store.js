'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 50;

const LOCK_STALE_MS = 5000;
const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_MS = 50;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function defaultLogFile() {
  return path.join(os.homedir(), '.claude', 'gripewright', 'log.ndjson');
}

function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function lockPathFor(logFile) {
  return logFile + '.lock';
}

// Serializes read-modify-write on logFile across concurrent backfills.
// Uses O_CREAT|O_EXCL — atomic on local POSIX and Windows. Stale locks
// older than LOCK_STALE_MS get cleared so a crashed holder can't wedge
// every other writer for the rest of the day.
function withLogLock(logFile, fn) {
  const lock = lockPathFor(logFile);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lock); } catch {}
          continue;
        }
      } catch {}
      if (attempt < LOCK_MAX_ATTEMPTS - 1) {
        sleepMs(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
        continue;
      }
      throw new Error(`gripewright: failed to acquire log lock at ${lock} after ${LOCK_MAX_ATTEMPTS} attempts`);
    }

    try {
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      try { fs.closeSync(fd); } catch {}
      return fn();
    } finally {
      try { fs.unlinkSync(lock); } catch {}
    }
  }
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
  // Lock so concurrent runBackfill rewrites can't truncate this append
  // (it reads-modifies-writes the whole file).
  withLogLock(file, () => {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  });
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
  withLogLock,
};
