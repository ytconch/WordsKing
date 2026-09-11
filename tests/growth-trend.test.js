const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3");
const { getLearningTrends } = require("../src/utils/growthTrend");

async function fixture(t, rows) {
  const connection = new sqlite3.Database(":memory:");
  const db = {
    all: (sql, args = []) => new Promise((resolve, reject) => connection.all(sql, args, (err, value) => err ? reject(err) : resolve(value))),
    run: (sql, args = []) => new Promise((resolve, reject) => connection.run(sql, args, (err) => err ? reject(err) : resolve()))
  };
  t.after(() => new Promise((resolve, reject) => connection.close((err) => err ? reject(err) : resolve())));
  await db.run("CREATE TABLE study_logs (user_id INTEGER, word_ref TEXT, is_correct INTEGER, created_at TEXT, mode TEXT)");
  for (const [user, word, correct, date, mode = "zh_to_en"] of rows) {
    await db.run("INSERT INTO study_logs VALUES (?, ?, ?, ?, ?)", [user, word, correct, date, mode]);
  }
  return db;
}

test("first correct per word is permanent, mode independent and user isolated; Taiwan days are complete", async (t) => {
  const db = await fixture(t, [
    [1, "old-deleted-word", 1, "2026-07-01 00:00:00"],
    [1, "apple", 0, "2026-08-29 15:59:59"],
    [1, "apple", 1, "2026-08-29 16:00:00"],
    [1, "apple", 1, "2026-08-30 00:00:00", "type_en_from_zh"],
    [1, "apple", 0, "2026-09-01 00:00:00"],
    [2, "banana", 1, "2026-09-02 00:00:00"],
    [1, "future", 1, "2026-09-06 00:00:00"]
  ]);
  const { growthTrend: g, dailyTrend } = await getLearningTrends(db, 1, "7", "2026-09-05");
  assert.equal(g.startDate, "2026-08-30");
  assert.equal(g.baselineWords, 1);
  assert.equal(g.totalWords, 2);
  assert.equal(g.newWords, 1);
  assert.equal(g.points.length, 7);
  assert.equal(g.points[0].newWords, 1);
  assert.equal(g.points[0].attempts, 2);
  assert.equal(g.points[1].attempts, 0);
  assert.ok(g.points.every((p) => p.cumulativeWords === 2));
  assert.equal(dailyTrend.length, 14);
  assert.equal(dailyTrend[0].studyDate, "2026-08-23");
  assert.equal(dailyTrend.at(-1).studyDate, "2026-09-05");
  const other = await getLearningTrends(db, 2, "7", "2026-09-05");
  assert.equal(other.growthTrend.totalWords, 1);
});

test("rolling accuracy weights attempts and includes six days before the displayed window", async (t) => {
  const rows = [[1, "a", 1, "2026-08-24 00:00:00"]];
  for (let i = 0; i < 9; i++) rows.push([1, "b", 0, "2026-08-30 00:00:00"]);
  const db = await fixture(t, rows);
  const { growthTrend: g } = await getLearningTrends(db, 1, "7", "2026-09-05");
  assert.equal(g.points[0].rollingAccuracy, 10);
  assert.equal(g.points[0].accuracy, 0);
  assert.equal(g.points[0].rollingAttempts, 10);
  assert.equal(g.points[1].rollingAccuracy, 0);
  const later = await getLearningTrends(db, 1, "7", "2026-09-06");
  assert.equal(later.growthTrend.points.at(-1).rollingAccuracy, null);
  assert.equal(later.growthTrend.points.at(-1).cumulativeWords, 1);
});

test("all history starts at first attempt; empty, single-day, all-wrong and inactive windows remain honest", async (t) => {
  const db = await fixture(t, [[1, "a", 0, "2026-09-05 00:00:00"]]);
  const one = await getLearningTrends(db, 1, "all", "2026-09-05");
  assert.equal(one.growthTrend.startDate, "2026-09-05");
  assert.equal(one.growthTrend.points.length, 1);
  assert.equal(one.growthTrend.totalWords, 0);
  assert.equal(one.growthTrend.points[0].rollingAccuracy, 0);
  const empty = await getLearningTrends(db, 2, "30", "2026-09-05");
  assert.deepEqual(empty.growthTrend.points, []);
  assert.equal(empty.dailyTrend.length, 14);
  const inactive = await getLearningTrends(db, 1, "30", "2026-11-05");
  assert.equal(inactive.growthTrend.points.length, 30);
  assert.ok(inactive.growthTrend.points.every((p) => p.rollingAccuracy === null && p.newWords === 0));
});

test("summary integrates growth data, defaults to 30 days and retains deleted-word history", async (t) => {
  assert.ok(process.env.WORDSKING_TEST_DB_DIR, "route tests require the isolated runner");
  const { clientDb } = require("../src/db/connections");
  const router = require("../src/routes/analytics");
  const handler = router.stack.find((layer) => layer.route?.path === "/summary").route.stack.at(-1).handle;
  await clientDb.run("INSERT INTO users (id, username, password_hash, display_name) VALUES (9001, 'growth-test', 'unused', 'Growth')");
  t.after(() => clientDb.run("DELETE FROM users WHERE id = 9001"));
  await clientDb.run("INSERT INTO study_logs (user_id, word_ref, mode, is_correct) VALUES (9001, 'deleted-word', 'zh_to_en', 1)");
  let body;
  await handler({ user: { id: 9001 }, query: {} }, { json: (value) => { body = value; } }, (err) => { throw err; });
  assert.equal(body.growthTrend.range, "30");
  assert.equal(body.growthTrend.points.length, 30);
  assert.equal(body.growthTrend.totalWords, 1);
  assert.equal(body.dailyTrend.length, 14);
  assert.equal(body.overview.totalAttempts, 1);
  assert.equal(body.reviewSummary.masteredWords, 0);
});

test("summary rejects invalid ranges and returns guest empty state without database access", async () => {
  assert.ok(process.env.WORDSKING_TEST_DB_DIR, "route tests require the isolated runner");
  const { clientDb } = require("../src/db/connections");
  const router = require("../src/routes/analytics");
  const handler = router.stack.find((layer) => layer.route?.path === "/summary").route.stack.at(-1).handle;
  const original = clientDb.all;
  clientDb.all = async () => { throw new Error("guest must not read learning records"); };
  try {
    let body;
    const response = { status(code) { this.statusCode = code; return this; }, json(value) { body = value; } };
    await handler({ user: { isGuest: true }, query: { range: "all" } }, response, (err) => { throw err; });
    assert.equal(body.growthTrend.range, "all");
    assert.deepEqual(body.growthTrend.points, []);
    await handler({ user: { isGuest: true }, query: { range: "365" } }, response, (err) => { throw err; });
    assert.equal(response.statusCode, 400);
  } finally { clientDb.all = original; }
});
