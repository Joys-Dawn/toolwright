'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { globToRegExp, matchesGlob, splitBraceAlternatives } = require('../../lib/glob');

describe('splitBraceAlternatives', () => {
  it('splits simple comma-separated alternatives', () => {
    assert.deepStrictEqual(splitBraceAlternatives('a,b,c'), ['a', 'b', 'c']);
  });

  it('preserves nested braces as single alternatives', () => {
    assert.deepStrictEqual(splitBraceAlternatives('a,{b,c}'), ['a', '{b,c}']);
  });

  it('handles deeply nested braces', () => {
    assert.deepStrictEqual(splitBraceAlternatives('a,{b,{c,d}}'), ['a', '{b,{c,d}}']);
  });

  it('returns single element for no commas', () => {
    assert.deepStrictEqual(splitBraceAlternatives('abc'), ['abc']);
  });

  it('handles empty string', () => {
    assert.deepStrictEqual(splitBraceAlternatives(''), ['']);
  });
});

describe('globToRegExp', () => {
  it('matches exact file names', () => {
    const re = globToRegExp('foo.js');
    assert.ok(re.test('foo.js'));
    assert.ok(!re.test('bar.js'));
    assert.ok(!re.test('foo.jsx'));
  });

  it('matches single wildcard *', () => {
    const re = globToRegExp('*.js');
    assert.ok(re.test('foo.js'));
    assert.ok(re.test('bar.js'));
    assert.ok(!re.test('src/foo.js'));
  });

  it('matches ? as single non-slash character', () => {
    const re = globToRegExp('?.js');
    assert.ok(re.test('a.js'));
    assert.ok(!re.test('ab.js'));
    assert.ok(!re.test('/.js'));
  });

  it('matches **/ as zero or more directories', () => {
    const re = globToRegExp('**/foo.js');
    assert.ok(re.test('foo.js'));
    assert.ok(re.test('src/foo.js'));
    assert.ok(re.test('a/b/c/foo.js'));
    assert.ok(!re.test('foo.jsx'));
  });

  it('matches ** at end of pattern', () => {
    const re = globToRegExp('src/**');
    assert.ok(re.test('src/foo.js'));
    assert.ok(re.test('src/a/b/c.js'));
    assert.ok(!re.test('lib/foo.js'));
  });

  it('matches simple brace alternatives {a,b}', () => {
    const re = globToRegExp('*.{js,ts}');
    assert.ok(re.test('foo.js'));
    assert.ok(re.test('foo.ts'));
    assert.ok(!re.test('foo.py'));
  });

  it('matches nested brace alternatives {a,{b,c}}', () => {
    const re = globToRegExp('{a,{b,c}}.js');
    assert.ok(re.test('a.js'));
    assert.ok(re.test('b.js'));
    assert.ok(re.test('c.js'));
    assert.ok(!re.test('d.js'));
  });

  it('matches character class [abc]', () => {
    const re = globToRegExp('[abc].js');
    assert.ok(re.test('a.js'));
    assert.ok(re.test('b.js'));
    assert.ok(!re.test('d.js'));
  });

  it('matches negated character class [!abc]', () => {
    const re = globToRegExp('[!abc].js');
    assert.ok(!re.test('a.js'));
    assert.ok(re.test('d.js'));
    assert.ok(re.test('z.js'));
  });

  it('escapes regex metacharacters in literal text', () => {
    const re = globToRegExp('file(1).js');
    assert.ok(re.test('file(1).js'));
    assert.ok(!re.test('file1.js'));
  });

  it('treats unmatched { as literal', () => {
    const re = globToRegExp('{unclosed');
    assert.ok(re.test('{unclosed'));
  });

  it('treats unmatched [ as literal', () => {
    const re = globToRegExp('[unclosed');
    assert.ok(re.test('[unclosed'));
  });

  it('handles brace with wildcard alternatives', () => {
    const re = globToRegExp('{src/**,lib/**}');
    assert.ok(re.test('src/foo.js'));
    assert.ok(re.test('lib/bar.js'));
    assert.ok(!re.test('test/baz.js'));
  });

  it('handles **/ in the middle of a pattern', () => {
    const re = globToRegExp('src/**/test/*.js');
    assert.ok(re.test('src/test/foo.js'));
    assert.ok(re.test('src/a/b/test/foo.js'));
    assert.ok(!re.test('lib/test/foo.js'));
  });
});

describe('matchesGlob', () => {
  it('defaults to **/* when pattern is undefined', () => {
    assert.ok(matchesGlob('any/path/file.js'));
  });

  it('normalizes path separators', () => {
    assert.ok(matchesGlob('src\\lib\\foo.js', 'src/**'));
  });
});
