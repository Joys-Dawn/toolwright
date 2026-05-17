// End-to-end MCP server test: spawn mcp/server.mjs as a subprocess and drive
// it over real stdio via @modelcontextprotocol/sdk's StdioClientTransport.
//
// Without this test, a string-vs-Zod schema regression in setRequestHandler,
// a missing tool name, or a broken JSON-RPC envelope would slip through the
// in-process unit tests (which import handleToolCall directly and bypass the
// MCP wire layer).
//
// Test isolation:
//   - MINDWRIGHT_PROJECT_ROOT points at a fresh tmpdir per test so the
//     SQLite DB, mirrors, and (POSIX) socket files don't collide between
//     runs or with the user's real .claude/mindwright/.
//   - MINDWRIGHT_SESSION_ID is set explicitly so session-bind.mjs's
//     ticket polling is bypassed (no SessionStart hook in this test).
//   - MINDWRIGHT_USE_STUB_MODELS=1 swaps the ONNX-backed embedder/reranker
//     for deterministic stubs (constant 0.5 vectors; rerank scores
//     0.5 + i*0.01). The retain→recall roundtrip would otherwise need to
//     download ~500MB of model weights.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// test/mcp/ → mindwright/
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SERVER_PATH = join(PLUGIN_ROOT, 'mcp', 'server.mjs');

// Expected complete tool set. If you add/remove a tool, update both this list
// and the design doc — the assertion intentionally pins the exact name set so
// silent surface changes don't ship un-noticed.
const EXPECTED_TOOLS = [
  'mindwright_assign_role',
  'mindwright_drain_batch',
  'mindwright_finalize_drain',
  'mindwright_forget',
  'mindwright_get_roles',
  'mindwright_mark_superseded',
  'mindwright_recall',
  'mindwright_resolve_contradiction',
  'mindwright_restore',
  'mindwright_retain',
  'mindwright_retain_fact',
  'mindwright_status',
  'mindwright_unassign_role',
  'mindwright_update_memory',
];

function setupSandbox(label) {
  const dir = mkdtempSync(join(tmpdir(), `mindwright-mcp-${label}-`));
  // Per-test unique sessionId keeps Windows named-pipe paths
  // (`\\.\pipe\mindwright-<sid>`) from colliding between tests.
  const sessionId = `mw-test-${label}-${process.pid}-${Date.now()}`;
  return {
    dir,
    sessionId,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort tmp cleanup
      }
    },
  };
}

async function connectClient({ projectRoot, sessionId }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: projectRoot,
    env: {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: projectRoot,
      MINDWRIGHT_SESSION_ID: sessionId,
      MINDWRIGHT_USE_STUB_MODELS: '1',
    },
    // 'pipe' would buffer the server's stderr in the test; 'inherit' lets
    // it stream to the test runner's stderr so failures show diagnostics.
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'mindwright-test-client', version: '0.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

function parseToolResult(result) {
  // tools.mjs encodes the payload as a single text content block carrying
  // JSON.stringify(payload). Decoding here keeps each test focused on the
  // semantic payload, not the envelope shape.
  assert.ok(result && Array.isArray(result.content), 'tool result must have content[]');
  assert.equal(result.content.length, 1, 'expected exactly one content block');
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('tools/list returns the expected mindwright tools', async () => {
  const sb = setupSandbox('list');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const result = await client.listTools();
      assert.ok(Array.isArray(result.tools), 'tools field must be an array');
      const names = result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, EXPECTED_TOOLS, `tool set mismatch: got ${JSON.stringify(names)}`);

      for (const tool of result.tools) {
        assert.ok(tool.description, `${tool.name} must have a description`);
        assert.ok(tool.inputSchema, `${tool.name} must declare an inputSchema`);
        assert.equal(tool.inputSchema.type, 'object', `${tool.name}.inputSchema.type must be object`);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_status returns the documented shape', async () => {
  const sb = setupSandbox('status');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const raw = await client.callTool({ name: 'mindwright_status', arguments: {} });
      const status = parseToolResult(raw);
      // Empty DB: counts default to 0 and last_consolidation is null. We pin
      // the keys, not the values, so the test stays stable as defaults shift.
      for (const key of [
        'short_count',
        'long_count',
        'by_category',
        'last_consolidation',
        'model_cached',
        'daemon_alive',
        'pending_embeds',
        'poison_embeds',
        'unbound_count',
        'oldest_preference_at',
        'warnings',
      ]) {
        assert.ok(key in status, `status missing key: ${key}`);
      }
      assert.equal(typeof status.short_count, 'number');
      assert.equal(typeof status.long_count, 'number');
      assert.equal(typeof status.by_category, 'object');
      assert.equal(typeof status.model_cached, 'boolean');
      assert.equal(typeof status.daemon_alive, 'boolean');
      assert.equal(typeof status.pending_embeds, 'number');
      assert.equal(typeof status.poison_embeds, 'number');
      assert.equal(typeof status.unbound_count, 'number');
      // Empty DB: null. Populated DB: ISO timestamp string of oldest active
      // fact/user row. Used by users to spot stale preferences that should
      // be audited (auto-decay is post-v1 per DESIGN.md).
      assert.ok(status.oldest_preference_at === null
        || typeof status.oldest_preference_at === 'string',
        `oldest_preference_at should be null or ISO string; got ${typeof status.oldest_preference_at}`);
      assert.ok(Array.isArray(status.warnings));
      // Clean install has nothing under 'mindwright-unbound'.
      assert.equal(status.unbound_count, 0);
      assert.equal(status.oldest_preference_at, null,
        'clean install has no fact/user rows yet');
      assert.equal(status.warnings.length, 0);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_drain_batch on a consolidator-role peer surfaces a scope=all hint when own short-term is empty', async () => {
  // Regression for the documented-but-undelivered consolidator role.
  // README.md and DESIGN.md say a peer assigned the 'consolidator' role is
  // the natural fit for draining on cue. But default `mindwright_drain_batch`
  // is session-scoped — the consolidator peer typically has nothing of its
  // own to drain, so the default call returns empty exchanges and the user
  // hears "nothing to consolidate" while 100s of other-session rows wait.
  const sb = setupSandbox('consolidator-hint');
  // Snapshot MINDWRIGHT_PROJECT_ROOT so it doesn't leak past this test.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  try {
    const storeMod = await import('../../lib/store.js');
    process.env.MINDWRIGHT_PROJECT_ROOT = sb.dir;
    const store = storeMod.openStore();
    // Plant rows under a different session — this represents the team's
    // un-consolidated short-term.
    for (let i = 0; i < 3; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: `team observation ${i}`, sessionId: 'peer-xyz',
      });
    }
    // Assign the consolidator role to the calling session.
    store.setRoles(sb.sessionId, ['consolidator']);
    store.close();

    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const raw = await client.callTool({
        name: 'mindwright_drain_batch',
        arguments: {}, // default scope='session'
      });
      const out = parseToolResult(raw);
      assert.ok(out, 'drain_batch must return a structured result');
      assert.deepEqual(out.exchanges, [],
        'session-scoped drain on consolidator peer with empty own short-term returns no exchanges');
      assert.ok(typeof out.hint === 'string' && out.hint.length > 0,
        `expected hint pointing at scope='all', got: ${JSON.stringify(out)}`);
      assert.match(out.hint, /consolidator/);
      assert.match(out.hint, /scope='all'/);
      assert.match(out.hint, /confirm_all_sessions/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  }
});

test('mindwright_drain_batch surfaces a cross-session hint even when current session has its own exchanges (solo-user case)', async () => {
  // Regression for the silent-miss scenario: a solo user manually runs
  // /mindwright:dream. Their current session has 1 small exchange but
  // past sessions accumulated 49 rows. Under the old logic the hint was
  // suppressed because exchanges.length > 0 — the user would "succeed"
  // consolidating 1 row while 49 rows sat under past sessions forever
  // and they'd never know. New contract: the hint fires whenever other-
  // session bound rows exist, regardless of the current drain's size.
  const sb = setupSandbox('solo-cross-hint');
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  try {
    const storeMod = await import('../../lib/store.js');
    process.env.MINDWRIGHT_PROJECT_ROOT = sb.dir;
    const store = storeMod.openStore();
    // Plant rows under the CURRENT session — enough exchanges to fill a
    // drain batch (drainBatch's default is ~70% of cap, so >0 exchanges
    // come back from this session).
    for (let i = 0; i < 5; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: `current session observation ${i}`, sessionId: sb.sessionId,
      });
    }
    // Plant a much larger pile under a past session — none of these will
    // be returned by a session-scoped drain but they're the "silent miss".
    for (let i = 0; i < 12; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: `past session observation ${i}`, sessionId: 'past-session-xyz',
      });
    }
    // No consolidator role assignment — this is the typical solo user.
    store.close();

    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const raw = await client.callTool({
        name: 'mindwright_drain_batch',
        arguments: {}, // default scope='session'
      });
      const out = parseToolResult(raw);
      assert.ok(out, 'drain_batch must return a structured result');
      assert.ok(Array.isArray(out.exchanges) && out.exchanges.length > 0,
        `expected current-session drain to return >0 exchanges (got ${out.exchanges && out.exchanges.length})`);
      assert.ok(typeof out.hint === 'string' && out.hint.length > 0,
        `expected cross-session hint even with a non-empty current-session drain, got: ${JSON.stringify(out)}`);
      // Must mention scope='all' (the action the user is supposed to take)
      assert.match(out.hint, /scope='all'/);
      // Must mention the past-session pile by reasonable count
      assert.match(out.hint, /12 short-term row/);
      // Must NOT use the "drain found nothing" phrasing — drain DID find something
      assert.ok(!/drain found nothing/i.test(out.hint),
        `hint should reflect that the current drain succeeded, got: ${out.hint}`);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  }
});

test('mindwright_status surfaces a warning when rows live under mindwright-unbound', async () => {
  // When the MCP server boots without a SessionStart ticket, all writes
  // land under session_id='mindwright-unbound'. Those rows are invisible
  // to countShortTermFor(realSessionId) and the Stop hook's cap check —
  // they exist but can't be reached through session-scoped flows. status
  // must explicitly surface their existence so the user knows to consolidate
  // with scope='all' instead of silently wondering where their data went.
  const sb = setupSandbox('unbound-warn');
  // Snapshot MINDWRIGHT_PROJECT_ROOT so it doesn't leak past this test.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  try {
    // Seed an unbound-session row directly in SQLite before connecting.
    const sqlite = await import('better-sqlite3');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dbDir = path.join(sb.dir, '.claude', 'mindwright');
    fs.mkdirSync(dbDir, { recursive: true });
    // Open via the actual store so migrations + indexes are present.
    const storeMod = await import('../../lib/store.js');
    process.env.MINDWRIGHT_PROJECT_ROOT = sb.dir;
    const store = storeMod.openStore();
    store.insertEntry({
      tier: 'short', kind: 'thinking',
      content: 'orphaned by failed session bind', sessionId: 'mindwright-unbound',
    });
    store.close();

    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const raw = await client.callTool({ name: 'mindwright_status', arguments: {} });
      const status = parseToolResult(raw);
      assert.equal(status.unbound_count, 1,
        `expected unbound_count=1, got ${status.unbound_count}`);
      assert.ok(status.warnings.length >= 1, 'expected at least one warning');
      assert.match(status.warnings[0], /mindwright-unbound/);
      assert.match(status.warnings[0], /scope='all'/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
  }
});

test('mindwright_retain → mindwright_recall roundtrip surfaces the saved fact', async () => {
  const sb = setupSandbox('roundtrip');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const retainRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the project deadline is 2026-06-30 for the Q2 ship cadence',
          kind: 'fact',
          tier: 'long',
          category: 'fact',
          scope: 'project',
        },
      });
      const retain = parseToolResult(retainRaw);
      assert.ok(retain.id, `retain should return an id, got ${JSON.stringify(retain)}`);

      // Status should now show one long-term row as a project-scoped fact.
      const statusRaw = await client.callTool({ name: 'mindwright_status', arguments: {} });
      const status = parseToolResult(statusRaw);
      assert.equal(status.long_count, 1, 'long_count should be 1 after retain');
      assert.equal(status.by_category['fact'], 1);
      assert.equal(status.by_category_scope['fact/project'], 1);

      // Recall with a related query. With stub embeddings every vector is
      // identical (constant 0.5), so semantic search degenerates to a tie
      // and BM25/recency carry the rerank. The point of the assertion is
      // that the retrieval pipeline returns SOMETHING — i.e. the row was
      // actually written, indexed, and is reachable through the public
      // recall surface, not that the rerank scoring is meaningful under
      // stubbed models.
      const recallRaw = await client.callTool({
        name: 'mindwright_recall',
        arguments: { query: 'project deadline', k: 5 },
      });
      const recall = parseToolResult(recallRaw);
      assert.ok(Array.isArray(recall.results), 'recall must return results[]');
      assert.ok(
        recall.results.length >= 1,
        `expected ≥1 hit after retain, got ${recall.results.length}: ${JSON.stringify(recall.results)}`
      );
      const ids = recall.results.map((r) => String(r.id));
      assert.ok(ids.includes(String(retain.id)), `retained id ${retain.id} should appear in recall hits, got ${JSON.stringify(ids)}`);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_recall bypass_session_dedup=true returns the same hits on consecutive calls (debug path)', async () => {
  // Regression: without the bypass, a second /mindwright:recall <query> call
  // returned fewer hits than the first because the first call's emitted ids
  // were appended to meta:injected_fact_ids:<sessionId> and excluded from
  // the second. SKILL.md previously documented /mindwright:reset (which
  // deletes the entire DB) as the only workaround — disproportionate to a
  // debug action. The bypass flag skips both the read-and-exclude AND the
  // post-emit append, so consecutive debug calls are stable.
  const sb = setupSandbox('recall-bypass');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // Plant two long-term facts so recall has something to dedup against.
      const r1 = parseToolResult(await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'project deadline is 2026-06-30', kind: 'fact', tier: 'long', category: 'fact', scope: 'project' },
      }));
      const r2 = parseToolResult(await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'release cadence is monthly', kind: 'fact', tier: 'long', category: 'fact', scope: 'project' },
      }));
      assert.ok(r1.id && r2.id);

      // Without bypass: first call sees both, second call sees fewer (dedup).
      // This pins the documented hostile-on-fresh-install behavior so a
      // future regression to silent dedup is caught.
      const firstNoBypass = parseToolResult(await client.callTool({
        name: 'mindwright_recall',
        arguments: { query: 'project', k: 5 },
      })).results;
      const secondNoBypass = parseToolResult(await client.callTool({
        name: 'mindwright_recall',
        arguments: { query: 'project', k: 5 },
      })).results;
      assert.ok(firstNoBypass.length >= 1, 'first call without bypass must return at least one hit');
      assert.ok(secondNoBypass.length < firstNoBypass.length,
        `dedup must hide previously-emitted ids on the second call (got ${secondNoBypass.length} >= ${firstNoBypass.length})`);

      // With bypass: stable across consecutive calls. Same query, same hits.
      const firstBypass = parseToolResult(await client.callTool({
        name: 'mindwright_recall',
        arguments: { query: 'deadline', k: 5, bypass_session_dedup: true },
      })).results;
      const secondBypass = parseToolResult(await client.callTool({
        name: 'mindwright_recall',
        arguments: { query: 'deadline', k: 5, bypass_session_dedup: true },
      })).results;
      assert.ok(firstBypass.length >= 1, 'bypass path must still return hits');
      assert.deepEqual(
        firstBypass.map((h) => String(h.id)).sort(),
        secondBypass.map((h) => String(h.id)).sort(),
        'bypass must skip the post-emit append so a repeat call returns the same ids',
      );
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_retain (tier=long) surfaces supersede_candidates so explicit retains can flag conflicts the same way the dream cycle does', async () => {
  // Regression for behavior-5: the dream-cycle path (lib/consolidator.js
  // retainFact) runs retrieve() over existing long-term and returns
  // supersede_candidates. The explicit /mindwright:retain path used to skip
  // this entirely, so a user retaining "I prefer dark mode" on top of an
  // existing "I prefer light mode" got both facts active with no warning.
  // The fix mirrors retainFact's behavior — scope='long' + embedding
  // available → run retrieve, filter to long-term hits other than the just-
  // inserted id, return them.
  const sb = setupSandbox('supersede-candidates');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // Seed an existing long-term row.
      const firstRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the user prefers light mode for the editor',
          kind: 'preference',
          tier: 'long',
          category: 'fact',
          scope: 'user',
        },
      });
      const first = parseToolResult(firstRaw);
      assert.ok(first.id, 'seed retain should succeed');
      assert.deepEqual(first.supersede_candidates, [],
        'first retain has nothing to supersede');

      // Now retain a contradicting fact — should flag the prior row.
      const secondRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the user prefers dark mode for the editor',
          kind: 'preference',
          tier: 'long',
          category: 'fact',
          scope: 'user',
        },
      });
      const second = parseToolResult(secondRaw);
      assert.ok(second.id, 'second retain should succeed');
      assert.ok(Array.isArray(second.supersede_candidates),
        'response must include supersede_candidates array');
      assert.ok(second.supersede_candidates.length >= 1,
        `expected ≥1 supersede candidate from related long-term, got ${JSON.stringify(second.supersede_candidates)}`);
      assert.ok(second.supersede_candidates.map(String).includes(String(first.id)),
        `prior id ${first.id} should be flagged; got ${JSON.stringify(second.supersede_candidates)}`);
      // The just-inserted row must NOT flag itself.
      assert.ok(!second.supersede_candidates.map(String).includes(String(second.id)),
        'second.id must not appear in its own supersede_candidates');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_retain (tier=short) does NOT compute supersede_candidates — short-term rows are observations, not claims', async () => {
  // Companion to the test above: supersede detection is meaningful only for
  // long-term facts. Running retrieve() for every short-term cli_prompt
  // would be wasted work and noise in the response.
  const sb = setupSandbox('supersede-shortterm');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // Plant a long-term row so retrieve() would have something to flag.
      await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the user prefers light mode',
          kind: 'preference',
          tier: 'long',
          category: 'fact',
          scope: 'user',
        },
      });
      const shortRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the user prefers dark mode',
          kind: 'note',
          tier: 'short',
        },
      });
      const short = parseToolResult(shortRaw);
      assert.ok(short.id);
      assert.deepEqual(short.supersede_candidates, [],
        'tier=short retain must return empty supersede_candidates');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_retain (tier=long) surfaces a categorization warning when content cues do not match (default fact/project fallback)', async () => {
  // Regression for the silent-misclassification failure: a user runs
  // /mindwright:retain content="dark theme yes" tier=long without an
  // explicit category/scope. The deterministic heuristic in lib/categorize.js
  // can't match the terse phrasing and returns null. The caller falls back
  // to { category:'fact', scope:'project' } — the user's PERSONAL preference
  // is now filed as a CODEBASE fact and influences retrieval as project
  // architecture truth. The fix surfaces a `warning` in the response so
  // the calling skill can relay it to the user.
  const sb = setupSandbox('retain-categorization-warning');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // (1) Cue-matching content — no warning expected
      const matchedRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'the user prefers dark mode',
          kind: 'preference',
          tier: 'long',
        },
      });
      const matched = parseToolResult(matchedRaw);
      assert.ok(matched.id);
      assert.equal(matched.warning, undefined,
        'content matching a cue ("the user prefers...") must NOT carry a warning');

      // (2) Cue-resistant terse content — warning expected
      const terseRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'dark theme yes',
          kind: 'note',
          tier: 'long',
        },
      });
      const terse = parseToolResult(terseRaw);
      assert.ok(terse.id);
      assert.ok(typeof terse.warning === 'string' && terse.warning.length > 0,
        `terse uncategorizable content must carry a warning, got: ${JSON.stringify(terse)}`);
      assert.match(terse.warning, /no scope\/category cue matched/);
      assert.match(terse.warning, /fact\/project/);
      assert.match(terse.warning, /update-memory/);

      // (3) Explicit category/scope — warning suppressed even on cue-resistant content
      const explicitRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'dark theme yes',
          kind: 'preference',
          tier: 'long',
          category: 'fact',
          scope: 'user',
          confidence: 0.7,
        },
      });
      const explicit = parseToolResult(explicitRaw);
      assert.ok(explicit.id);
      assert.equal(explicit.warning, undefined,
        'explicit category+scope must suppress the auto-classification warning');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_forget soft-archives a long-term fact without writing a tombstone', async () => {
  const sb = setupSandbox('forget');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const forgetContent = 'an old preference that no longer applies';
      const retainRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: forgetContent,
          kind: 'fact',
          tier: 'long',
          category: 'fact',
          scope: 'user',
        },
      });
      const retain = parseToolResult(retainRaw);
      const factId = Number(retain.id);

      const beforeRaw = await client.callTool({ name: 'mindwright_status', arguments: {} });
      const before = parseToolResult(beforeRaw);
      assert.equal(before.long_count, 1, 'one active long-term row after retain');

      const forgetRaw = await client.callTool({
        name: 'mindwright_forget',
        arguments: { fact_id: factId, reason: 'no longer applies' },
      });
      const forget = parseToolResult(forgetRaw);
      assert.equal(forget.ok, true);
      assert.equal(Number(forget.fact_id), factId);
      // Regression for behavior-6: a typo'd fact_id (e.g. from a stale recall
      // result) silently archives the wrong row unless the response echoes
      // what was forgotten. The handler must return content_preview so the
      // caller can surface "you just forgot: <content>" to the user.
      assert.equal(typeof forget.content_preview, 'string',
        'response must include content_preview');
      assert.equal(forget.content_preview, forgetContent,
        'content_preview must echo the archived row exactly when ≤200 chars');

      const afterRaw = await client.callTool({ name: 'mindwright_status', arguments: {} });
      const after = parseToolResult(afterRaw);
      assert.equal(after.long_count, 0, 'forget must drop the active long_count; no tombstone row');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_forget rejects short-term ids and missing rows', async () => {
  const sb = setupSandbox('forget-errors');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // Missing row
      const missing = await client.callTool({
        name: 'mindwright_forget',
        arguments: { fact_id: 999999 },
      });
      assert.equal(missing.isError, true);
      assert.match(JSON.parse(missing.content[0].text).error, /not found/);

      // Short-term row — forget rejects (consolidator owns short-term lifecycle).
      const shortRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'transient note', kind: 'note', tier: 'short' },
      });
      const shortId = Number(parseToolResult(shortRaw).id);
      const shortForget = await client.callTool({
        name: 'mindwright_forget',
        arguments: { fact_id: shortId },
      });
      assert.equal(shortForget.isError, true);
      assert.match(JSON.parse(shortForget.content[0].text).error, /long-term/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_restore flips active back to 1 and re-renders mirrors', async () => {
  const sb = setupSandbox('restore');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const factText = 'preference accidentally forgotten via typo';
      const retainRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: factText, kind: 'fact', tier: 'long', category: 'fact', scope: 'user' },
      });
      const factId = Number(parseToolResult(retainRaw).id);

      await client.callTool({
        name: 'mindwright_forget',
        arguments: { fact_id: factId },
      });
      const afterForget = parseToolResult(
        await client.callTool({ name: 'mindwright_status', arguments: {} }),
      );
      assert.equal(afterForget.long_count, 0, 'forget should drop the active count to 0');

      const restoreRaw = await client.callTool({
        name: 'mindwright_restore',
        arguments: { fact_id: factId },
      });
      const restore = parseToolResult(restoreRaw);
      assert.equal(restore.ok, true);
      assert.equal(Number(restore.fact_id), factId);
      assert.equal(restore.content_preview, factText, 'preview should echo the restored row');

      const afterRestore = parseToolResult(
        await client.callTool({ name: 'mindwright_status', arguments: {} }),
      );
      assert.equal(afterRestore.long_count, 1, 'restore should bring the count back to 1');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_restore rejects short-term ids and missing rows', async () => {
  const sb = setupSandbox('restore-errors');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const missing = await client.callTool({
        name: 'mindwright_restore',
        arguments: { fact_id: 999999 },
      });
      assert.equal(missing.isError, true);
      assert.match(JSON.parse(missing.content[0].text).error, /not found/);

      const shortRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'transient', kind: 'note', tier: 'short' },
      });
      const shortId = Number(parseToolResult(shortRaw).id);
      const shortRestore = await client.callTool({
        name: 'mindwright_restore',
        arguments: { fact_id: shortId },
      });
      assert.equal(shortRestore.isError, true);
      assert.match(JSON.parse(shortRestore.content[0].text).error, /long-term/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mindwright_mark_superseded validates numeric args and records the supersede', async () => {
  // Direct MCP-wire coverage for the markSupersededHandler envelope: the
  // argument-type guard ('old_id and new_id must be numbers') and the
  // happy-path dispatch through the store. Other handlers all have wire
  // tests; without this one a regression in arg validation or envelope
  // shape for this tool would slip past.
  const sb = setupSandbox('mark-superseded');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      // Non-numeric args → isError + the documented message.
      const badStr = await client.callTool({
        name: 'mindwright_mark_superseded',
        arguments: { old_id: 'one', new_id: 'two' },
      });
      assert.equal(badStr.isError, true);
      assert.match(JSON.parse(badStr.content[0].text).error, /old_id and new_id must be numbers/);

      // Missing args also trip the guard (undefined is not a number).
      const missing = await client.callTool({
        name: 'mindwright_mark_superseded',
        arguments: {},
      });
      assert.equal(missing.isError, true);
      assert.match(JSON.parse(missing.content[0].text).error, /old_id and new_id must be numbers/);

      // Retain two long-term facts so we have real ids to supersede.
      const oldRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'user prefers dark mode',
          kind: 'fact', tier: 'long', category: 'fact', scope: 'user',
        },
      });
      const newRaw = await client.callTool({
        name: 'mindwright_retain',
        arguments: {
          content: 'user prefers light mode',
          kind: 'fact', tier: 'long', category: 'fact', scope: 'user',
        },
      });
      const oldId = Number(parseToolResult(oldRaw).id);
      const newId = Number(parseToolResult(newRaw).id);

      const before = parseToolResult(await client.callTool({ name: 'mindwright_status', arguments: {} }));
      assert.equal(before.long_count, 2, 'baseline: both facts active');

      const okRaw = await client.callTool({
        name: 'mindwright_mark_superseded',
        arguments: { old_id: oldId, new_id: newId },
      });
      assert.ok(!okRaw.isError, `expected ok envelope, got: ${JSON.stringify(okRaw)}`);
      const okPayload = parseToolResult(okRaw);
      assert.equal(okPayload.ok, true);

      // Side effect: the old row drops active, long_count falls to 1.
      const after = parseToolResult(await client.callTool({ name: 'mindwright_status', arguments: {} }));
      assert.equal(after.long_count, 1, 'old fact should be marked inactive');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('unknown tool name returns a structured error envelope', async () => {
  const sb = setupSandbox('unknown');
  try {
    const { client, transport } = await connectClient({
      projectRoot: sb.dir,
      sessionId: sb.sessionId,
    });
    try {
      const raw = await client.callTool({ name: 'mindwright_does_not_exist', arguments: {} });
      assert.equal(raw.isError, true, 'unknown tool must set isError');
      const payload = JSON.parse(raw.content[0].text);
      assert.match(payload.error, /unknown tool/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('mcp/server.mjs stays silent on stdout and exits 0 when deps are absent (the JSON-RPC channel must not be half-spoken)', () => {
  // The deps-absent branch runs for real on every plugin update that wipes
  // node_modules. Its contract: write NOTHING to stdout (stdout is the
  // JSON-RPC channel — any byte corrupts the MCP client), emit a recognizable
  // stderr diagnostic that names the install log, and exit 0 so the client
  // marks the server unavailable until a post-heal session. Every other test
  // here runs in the deps-present dev tree, so this branch was never executed
  // and the static-graph invariant does not assert this runtime constraint.
  //
  // Fixture: a faithful marketplace copy — the full mcp/ + lib/ tree with NO
  // node_modules, so the copy's depsInstalled() is false (paths.js derives
  // PLUGIN_ROOT from its own location → the sandbox). server-impl.mjs is
  // copied but never imported (the branch process.exit(0)s before the dynamic
  // import). MINDWRIGHT_AUTO_INSTALL=false makes maybeAutoInstall() a no-op so
  // no real `npm install` is spawned; the stdout/stderr/exit contract is
  // independent of that call.
  const sb = setupSandbox('deps-absent');
  try {
    cpSync(join(PLUGIN_ROOT, 'lib'), join(sb.dir, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'mcp'), join(sb.dir, 'mcp'), { recursive: true });

    const r = spawnSync(process.execPath, [join(sb.dir, 'mcp', 'server.mjs')], {
      cwd: sb.dir,
      env: {
        ...process.env,
        MINDWRIGHT_AUTO_INSTALL: 'false',
        MINDWRIGHT_INSTALL_LOCK_DIR: sb.dir,
      },
      encoding: 'utf8',
      timeout: 20000,
    });

    assert.equal(
      r.status,
      0,
      `expected clean exit 0; status=${r.status} signal=${r.signal} stderr=${r.stderr}`,
    );
    assert.equal(
      r.stdout,
      '',
      `stdout MUST be byte-empty (JSON-RPC channel); got ${JSON.stringify(r.stdout)}`,
    );
    assert.match(r.stderr, /\[mindwright\/mcp\]/, 'a recognizable stderr diagnostic must be written');
    assert.match(r.stderr, /native dependencies not installed/);
    assert.match(
      r.stderr,
      /mindwright-install-.*\.log/,
      'the diagnostic must reference the install log path',
    );
  } finally {
    sb.cleanup();
  }
});
