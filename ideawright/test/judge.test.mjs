import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { callJudge, extractJson } from '../lib/judge.mjs';

// -- extractJson: all six branches ------------------------------------------

test('extractJson returns a non-string argument unchanged (passthrough branch)', () => {
  const obj = { already: 'parsed' };
  assert.equal(extractJson(obj), obj);
  assert.equal(extractJson(42), 42);
  assert.equal(extractJson(null), null);
});

test('extractJson parses a clean JSON string directly (raw-parse branch)', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test('extractJson strips ```json fences then re-parses (fence branch)', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"b":2}\n```'), { b: 2 });
});

test('extractJson extracts an object embedded in prose (object-regex branch)', () => {
  assert.deepEqual(extractJson('Here is the verdict: {"ok":true} — done.'), { ok: true });
});

test('extractJson extracts an array embedded in prose when no object braces exist (array-regex branch)', () => {
  assert.deepEqual(extractJson('Results follow [1, 2, 3] end of list'), [1, 2, 3]);
});

test('extractJson throws when no JSON object or array is present (throw branch)', () => {
  assert.throws(() => extractJson('there is no json here at all'),
    /no JSON object or array in response/);
});

// -- callJudge: fake-spawn harness ------------------------------------------

function makeChild() {
  const child = new EventEmitter();
  let stdinData = null;
  const stdin = new EventEmitter();
  stdin.end = (d) => { stdinData = d; };
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig) => { child.killedWith = sig; };
  child.getStdin = () => stdinData;
  return child;
}

// Returns an injectable `_spawn` plus the recorded call args and the child
// the test drives. callJudge attaches all its listeners synchronously inside
// its Promise executor, so by the time `callJudge(...)` returns we can emit
// events deterministically — no timers, no real process.
function spawnHarness() {
  const calls = [];
  let child;
  const _spawn = (cmd, args, opts) => {
    child = makeChild();
    calls.push({ cmd, args, opts });
    return child;
  };
  return { _spawn, calls, child: () => child };
}

test('callJudge rejects synchronously when system or user is missing', async () => {
  await assert.rejects(callJudge({ system: 'only system' }),
    /callJudge: system and user are required/);
  await assert.rejects(callJudge({ user: 'only user' }),
    /callJudge: system and user are required/);
});

test('callJudge pipes the user prompt to stdin and passes model + flags as argv', async () => {
  const h = spawnHarness();
  const p = callJudge({
    system: 'SYS', user: 'USER-PROMPT', model: 'claude-opus-4-7', _spawn: h._spawn,
  });

  const child = h.child();
  child.stdout.emit('data', Buffer.from(JSON.stringify({ result: '{"v":1}' })));
  child.emit('close', 0);
  await p;

  assert.equal(h.calls[0].cmd, 'claude');
  assert.equal(child.getStdin(), 'USER-PROMPT', 'prompt goes via stdin, not argv');
  const args = h.calls[0].args;
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'json', '--append-system-prompt']);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-7');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'SYS');
});

test('callJudge unwraps outer.result through extractJson', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  h.child().stdout.emit('data', Buffer.from(JSON.stringify({ result: '{"from":"result"}' })));
  h.child().emit('close', 0);

  assert.deepEqual(await p, { from: 'result' });
});

test('callJudge falls back to outer.response when result is absent', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  h.child().stdout.emit('data', Buffer.from(JSON.stringify({ response: '{"from":"response"}' })));
  h.child().emit('close', 0);

  assert.deepEqual(await p, { from: 'response' });
});

test('callJudge falls back to raw stdout when neither result nor response is present', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  // stdout is itself valid JSON with no result/response keys → text = stdout.
  h.child().stdout.emit('data', Buffer.from('{"from":"stdout"}'));
  h.child().emit('close', 0);

  assert.deepEqual(await p, { from: 'stdout' });
});

test('callJudge surfaces code, signal, stderr, and stdout on a non-zero exit', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  h.child().stderr.emit('data', Buffer.from('model overloaded'));
  h.child().stdout.emit('data', Buffer.from('{"reason":"real cause on stdout"}'));
  h.child().emit('close', 1, 'SIGTERM');

  // Regression: stdout was previously discarded on non-zero exit, so a
  // `claude exited 1` with empty stderr lost the real reason — which
  // `claude --output-format json` writes to stdout, not stderr.
  await assert.rejects(p, (err) => {
    assert.match(err.message, /claude exited code=1 signal=SIGTERM/);
    assert.match(err.message, /stderr: model overloaded/);
    assert.match(err.message, /stdout: .*real cause on stdout/);
    return true;
  });
});

test('callJudge rejects with a parse error when stdout is not JSON', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  h.child().stdout.emit('data', Buffer.from('not json at all'));
  h.child().emit('close', 0);

  await assert.rejects(p, /callJudge parse error/);
});

test('callJudge rejects when the child emits an error event', async () => {
  const h = spawnHarness();
  const p = callJudge({ system: 's', user: 'u', _spawn: h._spawn });

  h.child().emit('error', new Error('spawn ENOENT'));

  await assert.rejects(p, /spawn ENOENT/);
});

test('callJudge SIGKILLs the child and rejects on timeout', async () => {
  const h = spawnHarness();
  // Tiny real timeout; never emit close → the timer is guaranteed to fire.
  const p = callJudge({ system: 's', user: 'u', timeoutMs: 25, _spawn: h._spawn });

  await assert.rejects(p, /callJudge timeout after 25ms/);
  assert.equal(h.child().killedWith, 'SIGKILL', 'the hung child must be SIGKILLed');
});
