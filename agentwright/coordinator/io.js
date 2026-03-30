'use strict';

// NOTE: Both plugins (wrightward and agentwright) implement their own JSON
// I/O and atomic-write utilities independently. This is intentional — the
// plugins are designed to be installed and distributed separately, so they
// must not share runtime code. Duplicated patterns are acceptable here.

const fs = require('fs');
const path = require('path');

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

function readJsonLines(filePath, fallback = []) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
  const results = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      results.push(JSON.parse(trimmed));
    } catch (error) {
      skipped++;
    }
  }
  results.skipped = skipped;
  return results;
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

module.exports = {
  writeJson,
  appendJsonLine,
  readJson,
  readJsonLines,
  removePath
};
