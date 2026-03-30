'use strict';

const crypto = require('crypto');

/**
 * Returns an MD5 hex digest of the given string.
 */
function hashString(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

module.exports = { hashString };
