'use strict';

const path = require('path');

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function splitBraceAlternatives(str) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < str.length; j++) {
    if (str[j] === '{') depth++;
    else if (str[j] === '}') depth--;
    else if (str[j] === ',' && depth === 0) {
      parts.push(str.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = glob[i + 1];
    if (char === '*') {
      if (next === '*') {
        const afterNext = glob[i + 2];
        if (afterNext === '/') {
          pattern += '(?:.*/)?';
          i += 2;
        } else {
          pattern += '.*';
          i += 1;
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{') {
      let depth = 1;
      let close = i + 1;
      while (close < glob.length && depth > 0) {
        if (glob[close] === '{') depth++;
        else if (glob[close] === '}') depth--;
        close++;
      }
      if (depth === 0) {
        close--;
        const alternatives = splitBraceAlternatives(glob.slice(i + 1, close)).map(
          alt => globToRegExp(alt).source.slice(1, -1)
        );
        pattern += '(' + alternatives.join('|') + ')';
        i = close;
      } else {
        pattern += '\\{';
      }
    } else if (char === '[') {
      const close = glob.indexOf(']', i);
      if (close !== -1) {
        let charClass = glob.slice(i, close + 1);
        if (charClass.length > 2 && charClass[1] === '!') {
          charClass = '[^' + charClass.slice(2);
        }
        pattern += charClass;
        i = close;
      } else {
        pattern += '\\[';
      }
    } else if ('\\^$+?.()|}'.includes(char)) {
      pattern += '\\' + char;
    } else {
      pattern += char;
    }
  }
  return new RegExp('^' + pattern + '$');
}

function matchesGlob(relativePath, pattern) {
  return globToRegExp(toPosixPath(pattern || '**/*')).test(toPosixPath(relativePath));
}

module.exports = { toPosixPath, splitBraceAlternatives, globToRegExp, matchesGlob };
