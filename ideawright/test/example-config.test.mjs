import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE_PATH = join(REPO_ROOT, 'ideawright.example.json');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'ideawright.mjs');

test('ideawright.example.json matches what /ideawright:config-init writes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ideawright-example-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, 'config-init'], {
      env: { ...process.env, IDEAWRIGHT_REPO_ROOT: tmp },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `config-init exited ${r.status}: ${r.stderr}`);

    const written = JSON.parse(readFileSync(join(tmp, '.claude', 'ideawright.json'), 'utf8'));
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));

    assert.deepEqual(
      example,
      written,
      'ideawright.example.json has drifted from DEFAULTS in scripts/ideawright.mjs — regenerate with `node scripts/ideawright.mjs config-init` and copy the output',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
