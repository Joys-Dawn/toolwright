import test from "node:test";
import assert from "node:assert/strict";
import { openDb, insertIdea, getIdea, updateNovelty } from "../../lib/db.mjs";
import { runNoveltyPass } from "../../lib/novelty/runner.mjs";

function setupDb() {
  return openDb({ filename: ":memory:" });
}

function seedIdea(db, { id, title, target_user, summary = "", category = null }) {
  return insertIdea(db, { title, target_user, summary, category, source_module: "test" });
}

function mockPipelineFor(verdictByTitle) {
  return async (idea) => {
    const verdict = verdictByTitle[idea.title] ?? "novel";
    return {
      novelty: {
        score_0_100: 80,
        verdict,
        competitors: verdict === "crowded" ? [{ name: "X", url: "u", overlap: 0.9 }] : [],
        queries_run: ["mock"],
        verified_at: new Date().toISOString(),
        errored_count: 0,
        total_scored: 5,
        competitor_count: verdict === "crowded" ? 7 : 0
      },
      debug: { variant_count: 3, raw_result_count: 5, prefilter_count: 5, competitor_count: 0, search_errors: [], judge_errors: 0, started_at: "t" }
    };
  };
}

test("runNoveltyPass advances novel/niche to verified, archives crowded", async () => {
  const db = setupDb();
  try {
    const { id: idA } = seedIdea(db, { title: "A", target_user: "u1" });
    const { id: idB } = seedIdea(db, { title: "B", target_user: "u2" });
    const { id: idC } = seedIdea(db, { title: "C", target_user: "u3" });

    const pipeline = mockPipelineFor({ A: "novel", B: "niche", C: "crowded" });
    const summary = await runNoveltyPass({ db, pipeline, batchSize: 10 });

    assert.equal(summary.processed, 3);
    assert.equal(summary.novel, 1);
    assert.equal(summary.niche, 1);
    assert.equal(summary.crowded, 1);
    assert.equal(summary.errors, 0);

    assert.equal(getIdea(db, idA).status, "verified");
    assert.equal(getIdea(db, idB).status, "verified");
    assert.equal(getIdea(db, idC).status, "archived");
  } finally { db.close(); }
});

test("runNoveltyPass preserves novelty JSON even on archived ideas", async () => {
  const db = setupDb();
  try {
    const { id } = seedIdea(db, { title: "crowded one", target_user: "u" });
    const pipeline = mockPipelineFor({ "crowded one": "crowded" });
    await runNoveltyPass({ db, pipeline });
    const row = getIdea(db, id);
    assert.equal(row.status, "archived");
    assert.ok(row.novelty, "novelty JSON should persist");
    assert.equal(row.novelty.verdict, "crowded");
    assert.equal(row.novelty.competitor_count, 7);
  } finally { db.close(); }
});

test("runNoveltyPass only touches status=new rows", async () => {
  const db = setupDb();
  try {
    const { id } = seedIdea(db, { title: "ignored", target_user: "u" });
    updateNovelty(db, id, { score_0_100: 80, verdict: "novel", competitors: [] }, "verified");
    const pipeline = async () => { throw new Error("should not be called"); };
    const summary = await runNoveltyPass({ db, pipeline });
    assert.equal(summary.processed, 0);
    assert.equal(getIdea(db, id).status, "verified");
  } finally { db.close(); }
});

test("runNoveltyPass honors batchSize", async () => {
  const db = setupDb();
  try {
    for (let i = 0; i < 5; i++) seedIdea(db, { title: `T${i}`, target_user: `u${i}` });
    let calls = 0;
    const pipeline = async () => {
      calls++;
      return mockPipelineFor({})({ title: "T0" });
    };
    const summary = await runNoveltyPass({ db, pipeline, batchSize: 2 });
    assert.equal(calls, 2);
    assert.equal(summary.processed, 2);
  } finally { db.close(); }
});

test("runNoveltyPass records error and continues on pipeline throw", async () => {
  const db = setupDb();
  try {
    const { id: idA } = seedIdea(db, { title: "A", target_user: "u1" });
    const { id: idB } = seedIdea(db, { title: "B", target_user: "u2" });
    const pipeline = async (idea) => {
      if (idea.title === "A") throw new Error("boom");
      return mockPipelineFor({ B: "novel" })(idea);
    };
    const summary = await runNoveltyPass({ db, pipeline });
    assert.equal(summary.errors, 1);
    assert.equal(summary.novel, 1);
    assert.equal(summary.processed, 1);
    assert.equal(getIdea(db, idA).status, "new", "errored row unchanged");
    assert.equal(getIdea(db, idB).status, "verified");
  } finally { db.close(); }
});

test("runNoveltyPass guards unknown verdict and counts as error", async () => {
  const db = setupDb();
  try {
    seedIdea(db, { title: "weird", target_user: "u" });
    const pipeline = async () => ({
      novelty: {
        score_0_100: 50, verdict: "unknown-bucket",
        competitors: [], queries_run: [], verified_at: "t", errored_count: 0, total_scored: 0, competitor_count: 0
      },
      debug: {}
    });
    const summary = await runNoveltyPass({ db, pipeline });
    assert.equal(summary.processed, 1);
    assert.equal(summary.errors, 1, "unknown verdict counts as error");
    assert.equal(summary.novel, 0);
    assert.equal(summary.niche, 0);
    assert.equal(summary.crowded, 0);
  } finally { db.close(); }
});

test("runNoveltyPass onIdea callback fires per processed idea", async () => {
  const db = setupDb();
  try {
    seedIdea(db, { title: "A", target_user: "u1" });
    seedIdea(db, { title: "B", target_user: "u2" });
    const seen = [];
    const pipeline = mockPipelineFor({ A: "novel", B: "niche" });
    await runNoveltyPass({
      db, pipeline,
      onIdea: ({ idea, newStatus }) => seen.push({ title: idea.title, newStatus })
    });
    assert.equal(seen.length, 2);
    assert.ok(seen.every(s => s.newStatus === "verified"));
  } finally { db.close(); }
});

test("runNoveltyPass minSimilarity maps to competitorOverlap threshold", async () => {
  const db = setupDb();
  try {
    seedIdea(db, { title: "A", target_user: "u" });
    let captured = null;
    const pipeline = async (_idea, opts) => {
      captured = opts;
      return mockPipelineFor({ A: "novel" })({ title: "A" });
    };
    await runNoveltyPass({ db, pipeline, minSimilarity: 0.8 });
    assert.deepEqual(captured.thresholds, { competitorOverlap: 0.8 });
  } finally { db.close(); }
});

test("runNoveltyPass empty batch returns zero summary", async () => {
  const db = setupDb();
  try {
    const summary = await runNoveltyPass({ db, pipeline: async () => { throw new Error("should not run"); } });
    assert.deepEqual(summary, { processed: 0, novel: 0, niche: 0, crowded: 0, errors: 0, details: [] });
  } finally { db.close(); }
});
