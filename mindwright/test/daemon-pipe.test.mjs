// daemon-pipe tests.
//
// In-process tests cover the wire format and the graceful-degradation
// contract: when the server is closed (or never existed), pipe-client
// returns `null` instead of throwing. One additional subprocess test does
// a real SIGKILL of a stub-backed daemon — the in-process server.close()
// only covers orderly shutdown, whereas SIGKILL exercises the abrupt
// "ECONNRESET / ENOENT on next connect" path that the real-world failure
// modes (daemon crash, OOM kill, idle-out) actually look like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = dirname(__dirname); // mindwright/
const DAEMON_PIPE_URL = pathToFileURL(`${PLUGIN_ROOT}/mcp/daemon-pipe.mjs`).href;

const STUB_EMBED_VALUE = 0.5;
const STUB_DIM = 1024;

function stubEmbed(texts) {
  return texts.map(() => {
    const v = new Float32Array(STUB_DIM);
    for (let i = 0; i < STUB_DIM; i++) v[i] = STUB_EMBED_VALUE;
    return v;
  });
}
function stubRerank(query, candidates) {
  return candidates.map((_, i) => 0.5 + i * 0.01);
}

function setupIsolatedRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-daemon-test-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  return {
    dir,
    cleanup() {
      if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
      else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort; tmp clean-up shouldn't fail the suite.
      }
    },
  };
}

async function importFresh() {
  // Import after MINDWRIGHT_PROJECT_ROOT is set so `pipePath()` resolves
  // against the isolated tmp root. ES modules cache by URL, so we use
  // cache-busting query strings.
  const stamp = Date.now() + '-' + Math.random();
  const pipeMod = await import(`../mcp/daemon-pipe.mjs?t=${stamp}`);
  const clientMod = await import(`../lib/pipe-client.js?t=${stamp}`);
  return { startPipeServer: pipeMod.startPipeServer, connectPipe: clientMod.connectPipe };
}

test('roundtrip: embed + rerank against in-process stub server', async () => {
  const sandbox = setupIsolatedRoot();
  try {
    const { startPipeServer, connectPipe } = await importFresh();
    const { close } = await startPipeServer({
      sessionId: 'roundtrip-1',
      embedFn: stubEmbed,
      rerankFn: stubRerank,
    });
    try {
      const client = connectPipe('roundtrip-1');
      const vectors = await client.embed(['hello', 'world']);
      assert.ok(Array.isArray(vectors), `expected array, got ${vectors}`);
      assert.equal(vectors.length, 2);
      assert.ok(vectors[0] instanceof Float32Array);
      assert.equal(vectors[0].length, STUB_DIM);
      for (let i = 0; i < STUB_DIM; i++) {
        assert.equal(vectors[0][i], STUB_EMBED_VALUE);
      }

      const scores = await client.rerank('q', ['a', 'b', 'c']);
      assert.deepEqual(scores, [0.5, 0.51, 0.52]);
    } finally {
      await close();
    }
  } finally {
    sandbox.cleanup();
  }
});

test('embed returns null after server.close()', async () => {
  const sandbox = setupIsolatedRoot();
  try {
    const { startPipeServer, connectPipe } = await importFresh();
    const { close } = await startPipeServer({
      sessionId: 'close-1',
      embedFn: stubEmbed,
      rerankFn: stubRerank,
    });
    const client = connectPipe('close-1', { timeoutMs: 1000 });
    // Prove the server worked once first, so we know the null isn't from a
    // misconfigured pipe path.
    const before = await client.embed(['x']);
    assert.ok(before && before[0] instanceof Float32Array);
    await close();
    const after = await client.embed(['x']);
    assert.equal(after, null);
    const afterRerank = await client.rerank('q', ['y']);
    assert.equal(afterRerank, null);
  } finally {
    sandbox.cleanup();
  }
});

test('embed returns null when no server has ever started for this sessionId', async () => {
  const sandbox = setupIsolatedRoot();
  try {
    const { connectPipe } = await importFresh();
    const client = connectPipe('never-existed', { timeoutMs: 500 });
    assert.equal(await client.embed(['x']), null);
    assert.equal(await client.rerank('q', ['y']), null);
  } finally {
    sandbox.cleanup();
  }
});

test('server-side errors degrade to null AND surface the message on stderr', async () => {
  // Server-side errors (params validation, embed exceptions, oversized
  // buffer) used to collapse to the same `null` as a dead daemon, hiding
  // the diagnostic. The client now writes the error to stderr so an
  // operator running with --debug or piping stderr to a log can triage.
  const sandbox = setupIsolatedRoot();
  // Capture only pipe-client's own lines. node:test's reporter and any
  // concurrent setup also write to stderr, so an unfiltered buffer can pull
  // in unrelated text that either masks a real miss or pollutes the failure
  // diagnostic. Filtering by the `mindwright/pipe-client:` prefix scopes the
  // capture to what this test actually cares about.
  let pipeClientStderr = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.startsWith('mindwright/pipe-client:')) {
      pipeClientStderr += s;
    }
    return origWrite(chunk, ...rest);
  };
  try {
    const { startPipeServer, connectPipe } = await importFresh();
    const failEmbed = async () => {
      throw new Error('synthetic embed failure');
    };
    const { close } = await startPipeServer({
      sessionId: 'errlog-1',
      embedFn: failEmbed,
      rerankFn: stubRerank,
    });
    try {
      const client = connectPipe('errlog-1', { timeoutMs: 1000 });
      const out = await client.embed(['x']);
      assert.equal(out, null, 'failure must still degrade to null for the caller');
      assert.match(
        pipeClientStderr,
        /mindwright\/pipe-client: daemon error on embed:.*synthetic embed failure/,
        `expected server error in stderr; got: ${pipeClientStderr}`,
      );
    } finally {
      await close();
    }
  } finally {
    process.stderr.write = origWrite;
    sandbox.cleanup();
  }
});

test('empty input bypasses the pipe and returns []', async () => {
  const sandbox = setupIsolatedRoot();
  try {
    const { connectPipe } = await importFresh();
    // No server running — empty-input fast paths must not even attempt to
    // open a connection.
    const client = connectPipe('unused', { timeoutMs: 100 });
    assert.deepEqual(await client.embed([]), []);
    assert.deepEqual(await client.rerank('q', []), []);
  } finally {
    sandbox.cleanup();
  }
});

test('client returns null after the daemon is SIGKILL\'d (subprocess)', async () => {
  const sandbox = setupIsolatedRoot();
  try {
    const sessionId = 'subproc-kill-' + process.pid;
    // Bootstrap script: start a pipe server with stubbed model functions and
    // wait forever. The parent then KILLs us with SIGKILL. The script is
    // embedded inline (`node --input-type=module -e ...`) so we don't need
    // to add a test fixture file to the repo.
    const bootstrap = `
      import { startPipeServer } from '${DAEMON_PIPE_URL}';
      const stubEmbed = async (texts) => texts.map(() => {
        const v = new Float32Array(${STUB_DIM});
        v.fill(${STUB_EMBED_VALUE});
        return v;
      });
      const stubRerank = async (q, cs) => cs.map((_, i) => 0.5 + i * 0.01);
      await startPipeServer({ sessionId: process.env.MW_TEST_SID, embedFn: stubEmbed, rerankFn: stubRerank });
      process.stdout.write('READY\\n');
      // keep the loop alive
      setInterval(() => {}, 1 << 30);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        MINDWRIGHT_PROJECT_ROOT: sandbox.dir,
        MW_TEST_SID: sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Capture stderr only so child failures are visible in test output if anything goes wrong.
    let childErr = '';
    child.stderr.on('data', (b) => {
      childErr += b.toString();
    });
    const ready = new Promise((resolve, reject) => {
      let stdoutBuf = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        if (stdoutBuf.includes('READY')) resolve();
      });
      child.once('exit', (code) =>
        reject(new Error(`child exited before READY (code=${code}) stderr=${childErr}`))
      );
    });
    await ready;

    const { connectPipe } = await importFresh();
    const client = connectPipe(sessionId, { timeoutMs: 2000 });
    const vectors = await client.embed(['hello']);
    assert.ok(vectors, `expected vectors before SIGKILL, got ${vectors}; child stderr: ${childErr}`);
    assert.equal(vectors[0].length, STUB_DIM);

    // Abrupt kill — no graceful shutdown, the way a real OOM-killed or crashed
    // daemon would disappear.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    // First post-kill call should return null. (May take one extra connect
    // attempt on some platforms — pipe-client handles ENOENT/ECONNREFUSED.)
    const after = await client.embed(['hello']);
    assert.equal(after, null);
    const afterRerank = await client.rerank('q', ['c']);
    assert.equal(afterRerank, null);
  } finally {
    sandbox.cleanup();
  }
});

test('daemon refuses unbounded no-newline input and closes the connection (CWE-770)', async () => {
  // Defense against the buffer-growth DoS: a peer with socket access sends
  // an endless stream with no '\n'. Before the cap the daemon would keep
  // concatenating until heap exhaustion. With the cap it closes the
  // connection past the threshold; the rest of the daemon stays up.
  const sandbox = setupIsolatedRoot();
  try {
    const { startPipeServer } = await importFresh();
    const MAX = 4096;
    const { server, path, close } = await startPipeServer({
      sessionId: 'flood',
      embedFn: stubEmbed,
      rerankFn: stubRerank,
      maxBufferBytes: MAX,
    });
    try {
      // Open a raw client and pour bytes with no newline.
      const sock = net.createConnection({ path });
      let received = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => { received += chunk; });
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const closed = new Promise((resolve) => sock.once('close', resolve));
      // Write enough to push past the cap. 'A'.repeat(MAX + 1024) is fine —
      // we want >MAX in one or two chunks so the cap-check trips before any
      // newline.
      sock.write('A'.repeat(MAX + 1024));
      await closed;
      // Server must have replied with an error line before closing.
      assert.ok(/exceeded.*bytes/i.test(received),
        `expected cap-exceeded error reply, got: ${received}`);
      // Server itself is still listening (other clients can still connect).
      assert.ok(server.listening, 'server must stay up after one bad peer');
    } finally {
      await close();
    }
  } finally {
    sandbox.cleanup();
  }
});
