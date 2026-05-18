// Direct unit tests for lib/model-daemon-status.js. isModelDaemonAlive() is
// an industry-standard connection probe (cf. pg_isready / redis ping /
// Kubernetes TCP-socket liveness): it connects to the daemon's own socket and
// treats an accepted connect as "serving". It deliberately ignores the
// singleton lock file (a held lock with no accepting listener is exactly the
// "down for the caller" case status + the pending-embeds warning must report
// honestly). These tests pin the two states that matter: no listener → false,
// a real listener → true. The socket path is overridden via
// MINDWRIGHT_MODEL_DAEMON_SOCK so the machine-global Windows pipe / POSIX
// ~/.cache socket of a real dev daemon can never flake the result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isModelDaemonAlive } from '../lib/model-daemon-status.js';

// A listen path that is valid on the host platform: a named pipe on Windows
// (no FS node), a short unix-domain-socket path elsewhere (kept well under the
// ~104-char sun_path limit by rooting it in a fresh mkdtemp dir).
function freshSockPath() {
  if (process.platform === 'win32') {
    return {
      sock: `\\\\.\\pipe\\mw-modeld-test-${process.pid}-${Date.now()}`,
      cleanup: () => {},
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'mw-modeld-'));
  return {
    sock: join(dir, 's'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } },
  };
}

async function withSockEnv(sock, fn) {
  const prev = process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
  process.env.MINDWRIGHT_MODEL_DAEMON_SOCK = sock;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
    else process.env.MINDWRIGHT_MODEL_DAEMON_SOCK = prev;
  }
}

test('no listener at the socket path → false (and honours an explicit timeout)', async () => {
  const { sock, cleanup } = freshSockPath();
  try {
    await withSockEnv(sock, async () => {
      // Nothing is listening: the connect fails fast (ENOENT / ECONNREFUSED)
      // well before the timeout, so this resolves false near-instantly.
      const alive = await isModelDaemonAlive({ timeoutMs: 500 });
      assert.equal(alive, false);
    });
  } finally {
    cleanup();
  }
});

test('a live listener accepting connections → true', async () => {
  const { sock, cleanup } = freshSockPath();
  // A bare server with no connection handler still accepts the connection at
  // the OS level, so the client's 'connect' fires — which is the entire
  // liveness signal (the probe speaks no protocol).
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
    await withSockEnv(sock, async () => {
      const alive = await isModelDaemonAlive({ timeoutMs: 1000 });
      assert.equal(alive, true, 'an accepting listener must read as alive');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup();
  }
});

test('listener gone again → false (stale socket, no accepting process)', async () => {
  const { sock, cleanup } = freshSockPath();
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
    await new Promise((resolve) => server.close(resolve));
    // Server is down; the path may linger (POSIX) but nothing accepts.
    await withSockEnv(sock, async () => {
      assert.equal(await isModelDaemonAlive({ timeoutMs: 500 }), false);
    });
  } finally {
    cleanup();
  }
});
