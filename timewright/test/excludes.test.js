'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { shouldExclude } = require('../lib/excludes');

describe('shouldExclude', () => {
  describe('excluded roots', () => {
    it('excludes files under .claude', () => {
      assert.equal(shouldExclude('.claude/foo.json'), true);
      assert.equal(shouldExclude('.claude/timewright/snapshot/x.txt'), true);
    });

    it('excludes files under node_modules', () => {
      assert.equal(shouldExclude('node_modules/pkg/index.js'), true);
      assert.equal(shouldExclude('packages/app/node_modules/dep/index.js'), true);
    });

    it('excludes files under .git', () => {
      assert.equal(shouldExclude('.git/HEAD'), true);
      assert.equal(shouldExclude('.git/objects/ab/cdef'), true);
    });

    it('excludes build-output directories', () => {
      for (const dir of ['dist', 'build', '.next', '.nuxt', '.output',
        '.turbo', '.vercel', '.svelte-kit', 'coverage']) {
        assert.equal(shouldExclude(`${dir}/bundle.js`), true, `${dir} should be excluded`);
      }
    });

    it('excludes python cache directories', () => {
      for (const dir of ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']) {
        assert.equal(shouldExclude(`${dir}/foo`), true, `${dir} should be excluded`);
      }
    });

    it('matches excluded dirs at any depth', () => {
      assert.equal(shouldExclude('src/component/__pycache__/mod.pyc'), true);
      assert.equal(shouldExclude('apps/web/dist/app.js'), true);
    });

    it('accepts both / and \\ as path separators', () => {
      assert.equal(shouldExclude('node_modules\\pkg\\index.js'), true);
      assert.equal(shouldExclude('.git\\HEAD'), true);
    });
  });

  describe('secret env files', () => {
    it('excludes .env', () => {
      assert.equal(shouldExclude('.env'), true);
    });

    it('excludes .env.local and platform-specific local variants', () => {
      assert.equal(shouldExclude('.env.local'), true);
      assert.equal(shouldExclude('.env.development.local'), true);
      assert.equal(shouldExclude('.env.test.local'), true);
      assert.equal(shouldExclude('.env.production.local'), true);
    });

    it('DOES NOT exclude .env.example', () => {
      // Regression for the audit finding: the previous `.env.*` prefix
      // match ate .env.example and left it silently unprotected.
      assert.equal(shouldExclude('.env.example'), false);
    });

    it('DOES NOT exclude .env.template or .env.sample', () => {
      assert.equal(shouldExclude('.env.template'), false);
      assert.equal(shouldExclude('.env.sample'), false);
    });

    it('DOES NOT exclude .env.development or .env.production (non-local)', () => {
      // Non-local platform env files are often committed to source control
      // (e.g., staging/dev defaults). They are not secret-bearing by name.
      assert.equal(shouldExclude('.env.development'), false);
      assert.equal(shouldExclude('.env.production'), false);
    });

    it('excludes a .env file nested in a subdirectory by basename', () => {
      // `.env` anywhere in the tree should be excluded — it's still a
      // secret file regardless of location.
      assert.equal(shouldExclude('services/api/.env'), true);
    });
  });

  describe('normal files', () => {
    it('does not exclude ordinary source files', () => {
      assert.equal(shouldExclude('src/app.ts'), false);
      assert.equal(shouldExclude('README.md'), false);
      assert.equal(shouldExclude('package.json'), false);
    });

    it('does not exclude empty/falsy inputs', () => {
      assert.equal(shouldExclude(''), false);
      assert.equal(shouldExclude(null), false);
      assert.equal(shouldExclude(undefined), false);
    });

    it('does not exclude files merely containing an excluded name as substring', () => {
      assert.equal(shouldExclude('src/node_modules_helper.js'), false);
      assert.equal(shouldExclude('docs/build-system.md'), false);
    });
  });
});
