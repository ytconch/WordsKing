const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { clientDb } = require('../src/db/connections');
const router = require('../src/routes/admin');

test('visit report uses one range, exact seconds and distinct accounts', async () => {
  const user = await clientDb.run("INSERT INTO users (username, password_hash, display_name) VALUES ('visit-report-test', 'unused', 'Test')");
  try {
    for (const [page, start, end] of [
      ['home', '-5 minutes', '-299 seconds'],
      ['words', '-4 minutes', '-180 seconds'],
      ['home', '-20 days', '-20 days'],
      ['home', '+2 days', '+2 days']
    ]) {
      await clientDb.run(`INSERT INTO page_visit_sessions (user_id, page_key, started_at, last_seen_at) VALUES (?, ?, datetime('now', ?), datetime('now', ?))`, [user.lastID, page, start, end]);
    }
    const route = router.stack.find(layer => layer.route?.path === '/activity/visits').route;
    let data;
    await route.stack.at(-1).handle({}, { json(value) { data = value; } }, error => { throw error; });
    assert.equal(data.summary.totalVisits, 2);
    assert.equal(data.summary.uniqueVisitors, 1);
    assert.equal(data.summary.totalDurationSeconds, 61);
    assert.equal(data.recentVisits.length, 2);
    assert.equal(data.trend.length, 14);
    assert.equal(data.pages.reduce((sum, p) => sum + p.visits, 0), 2);
    assert.equal(data.pages.find(p => p.pageKey === 'home').durationSeconds, 1);
    assert.equal(data.pages.find(p => p.pageKey === 'home').lastVisitAt, data.recentVisits.find(p => p.pageKey === 'home').startedAt);
  } finally {
    await clientDb.run('DELETE FROM users WHERE id = ?', [user.lastID]);
  }
});

test('report formats sub-minute durations honestly and interprets SQLite timestamps as UTC', () => {
  const source = fs.readFileSync('public/admin.js', 'utf8');
  const context = vm.createContext({ Intl, Date });
  for (const name of ['formatDurationCompact', 'formatDateTime']) {
    vm.runInContext(source.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0], context);
  }
  assert.equal(context.formatDurationCompact(1), '1 秒');
  assert.equal(context.formatDurationCompact(61), '1 分 1 秒');
  assert.equal(context.formatDurationCompact(0), '0 秒');
  assert.equal(context.formatDateTime('2026-09-08 01:02:00'), context.formatDateTime('2026-09-08T01:02:00Z'));
});
