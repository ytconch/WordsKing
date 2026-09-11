// One-shot browser acceptance with synthetic responses; no server or real account.
// Use the bundled Playwright via NODE_PATH when it is not installed locally.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getLearningTrends } = require("../../src/utils/growthTrend");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".codex-temp/growth-qa");
const daily = Array.from({ length: 100 }, (_, i) => ({
  studyDate: new Date(Date.UTC(2026, 8, 5 - 99 + i)).toISOString().slice(0, 10),
  attempts: 40, correctCount: 20 + i % 20
}));
const firstCorrect = daily.map((row, i) => ({ studyDate: row.studyDate, newWords: i % 5 }));
const db = { all: async (sql) => sql.includes("MIN(") ? firstCorrect : daily };
async function summary(range) {
  return { ...await getLearningTrends(db, 1, range, "2026-09-05"),
    overview: { totalAttempts: 4000, accuracy: 73.8, activeDays: 100 },
    streaks: { currentStreak: 100, longestStreak: 100 },
    reviewSummary: { needsReview: 3, masteredWords: 10, trackedWords: 220 },
    modeBreakdown: [], unitPerformance: [], weakWords: [] };
}
let browser;
let failed = false;
const started = Date.now();
const deadline = setTimeout(async () => {
  failed = true;
  console.error(`TIMEOUT: node tests/browser/growth-charts.cjs; elapsed ${Date.now() - started} ms`);
  await browser?.close();
  process.exitCode = 1;
}, 120000);

(async () => {
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  let failNext = false;
  let holdSeven;
  let sevenArrived;
  let requestBarrier;
  await context.route("http://wordsking.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/analytics/summary") {
      if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { message: "測試連線失敗" } }); }
      if (url.searchParams.get("range") === "7" && holdSeven) { sevenArrived(); await holdSeven; }
      return route.fulfill({ json: await summary(url.searchParams.get("range")) });
    }
    if (url.pathname === "/shared.js") {
      return route.fulfill({ contentType: "text/javascript", body: `window.WordsApp = {
        refreshUser: async () => {}, enforcePageAccess: () => true, tutorial: { refresh() {} },
        showMessage: (message) => { throw new Error(message); },
        api: async (url) => { const res = await fetch(url); const body = await res.json();
          if (!res.ok) throw new Error(body.message); return body; }
      };` });
    }
    const allowed = ["/analytics.html", "/analytics-page.js", "/growth-charts.js", "/styles.css"];
    if (!allowed.includes(url.pathname)) return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ body: await fs.readFile(path.join(root, "public", url.pathname.slice(1))),
      contentType: url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html" });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://wordsking.test/analytics.html");
  await page.locator("#growthDay").waitFor();
  assert.equal(await page.locator("#growthDay").getAttribute("max"), "30");
  assert.match(await page.locator(".growth-gain").innerText(), /60/);
  await page.locator(".growth-card").screenshot({ path: path.join(output, "desktop.png") });
  const slider = page.locator("#growthDay");
  await slider.focus();
  await slider.press("Home");
  assert.match(await page.locator("#growthDate").innerText(), /期初/);
  assert.match(await page.locator("#growthDetail").innerText(), /140 字/);
  await slider.press("ArrowRight");
  assert.equal(await slider.inputValue(), "1");
  await slider.press("End");
  assert.equal(await slider.inputValue(), "30");
  const chart = page.locator('svg[data-chart="cumulativeWords"]');
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 80);
  assert.ok(Number(await slider.inputValue()) < 5);

  // Out-of-order completion must leave the newer range selected and rendered.
  holdSeven = new Promise((resolve) => { requestBarrier = resolve; });
  const arrived = new Promise((resolve) => { sevenArrived = resolve; });
  await page.locator('[data-range="7"]').click();
  await arrived;
  await page.locator('[data-range="all"]').click();
  await page.waitForFunction(() => document.querySelector("#growthDay").max === "100");
  const oldResponse = page.waitForResponse((response) => response.url().includes("range=7"));
  requestBarrier();
  await oldResponse;
  holdSeven = null;
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("#growthDay").getAttribute("max"), "100");
  assert.equal(await page.locator('[data-range="all"]').getAttribute("aria-pressed"), "true");
  failNext = true;
  await page.locator('[data-range="7"]').click();
  await page.locator("#growthRetry").waitFor({ state: "visible" });
  assert.equal(await page.locator("#growthDay").getAttribute("max"), "100");
  await page.locator("#growthRetry").click();
  await page.waitForFunction(() => document.querySelector("#growthDay").max === "7");
  assert.equal(await page.locator('[data-range="7"]').getAttribute("aria-pressed"), "true");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('[data-range="30"]').click();
  await page.waitForFunction(() => document.querySelector("#growthDay").max === "30");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rangeHeights = await page.locator("#growthRanges button").evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height));
  assert.ok(rangeHeights.every((height) => height === rangeHeights[0]), "range buttons must stay on one text line");
  await page.locator(".growth-card").screenshot({ path: path.join(output, "mobile.png") });
  await page.setViewportSize({ width: 812, height: 375 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => { document.body.dataset.theme = "dark"; });
  await page.locator(".growth-card").screenshot({ path: path.join(output, "dark.png") });

  // Null accuracy windows break the path; a single valid day still has a dot.
  const data = (await summary("7")).growthTrend;
  data.points.forEach((point, i) => { point.rollingAccuracy = i === 1 || i === 6 ? 50 : null; });
  await page.evaluate((value) => window.GrowthCharts.render(value), data);
  const accuracyPath = await page.locator('.growth-accuracy .growth-line').getAttribute("d");
  assert.equal((accuracyPath.match(/M/g) || []).length, 2);
  assert.equal(await page.locator(".growth-accuracy .growth-line-dot").count(), 2);
  await page.evaluate(() => window.GrowthCharts.render({ points: [] }));
  assert.equal(await page.locator('a[href="/practice.html"]').count(), 1);
  assert.equal(await page.locator("#trendList svg").count(), 0);

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await mobile.route("http://wordsking.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      return route.fulfill({ body: await fs.readFile(path.join(root, "public", url.pathname.slice(1))), contentType: url.pathname.endsWith(".js") ? "text/javascript" : "text/css" });
    }
    return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="trendList"></div><script src="/growth-charts.js"></script>' });
  });
  const touchPage = await mobile.newPage();
  await touchPage.goto("http://wordsking.test/touch");
  await touchPage.evaluate((value) => window.GrowthCharts.render(value), (await summary("7")).growthTrend);
  await touchPage.locator('svg[data-chart="cumulativeWords"]').tap({ position: { x: 70, y: 100 } });
  assert.ok(Number(await touchPage.locator("#growthDay").inputValue()) < 3);
  assert.deepEqual(errors, []);
  if (!failed) console.log("PASS: desktop, 375px, landscape, keyboard, mouse, touch, range race, failure/retry, null gaps, empty state. Screenshots: " + output);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  await browser?.close();
});
