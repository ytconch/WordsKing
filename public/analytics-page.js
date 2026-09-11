const AnalyticsPage = (() => {
  const { api, refreshUser, enforcePageAccess } = window.WordsApp;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function buildMeaningMarker(index) {
    return index < 20 ? String.fromCharCode(9312 + index) : `${index + 1}.`;
  }

  function parseMeaningEntries(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }

    const text = String(value || "").trim();
    if (!text) {
      return [];
    }

    return text
      .split(/\n+|[\uFF1B;\u3002]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function renderMeaningPreview(value, maxItems = 2) {
    const entries = parseMeaningEntries(value);
    if (!entries.length) {
      return `<div class="muted small-text">目前沒有字義資料。</div>`;
    }

    const visibleEntries = entries.slice(0, maxItems);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

    return `
      <div class="word-meaning-preview compact">
        ${visibleEntries
          .map(
            (entry, index) => `
              <div class="meaning-item">
                <span class="meaning-index">${buildMeaningMarker(index)}</span>
                <span class="meaning-text">${escapeHtml(entry)}</span>
              </div>
            `
          )
          .join("")}
        ${hiddenCount ? `<div class="meaning-more">另有 ${hiddenCount} 項</div>` : ""}
      </div>
    `;
  }

  function modeLabel(mode) {
    if (mode === "zh_to_en") return "中選英";
    if (mode === "en_to_zh") return "英選中";
    if (mode === "type_en_from_zh") return "看中打英";
    return mode;
  }

  function renderOverview(data) {
    document.getElementById("analyticsOverview").innerHTML = `
      <div class="metric-card">
        <span>累積作答</span>
        <strong>${data.overview.totalAttempts}</strong>
      </div>
      <div class="metric-card">
        <span>整體正確率</span>
        <strong>${data.overview.accuracy}%</strong>
      </div>
      <div class="metric-card">
        <span>活躍天數</span>
        <strong>${data.overview.activeDays}</strong>
      </div>
      <div class="metric-card">
        <span>待複習單字</span>
        <strong>${data.reviewSummary.needsReview}</strong>
      </div>
    `;

    document.getElementById("streakCards").innerHTML = `
      <div class="metric-card">
        <span>目前連續天數</span>
        <strong>${data.streaks.currentStreak}</strong>
      </div>
      <div class="metric-card">
        <span>最長連續天數</span>
        <strong>${data.streaks.longestStreak}</strong>
      </div>
      <div class="metric-card">
        <span>已學會單字</span>
        <strong>${data.reviewSummary.masteredWords}</strong>
      </div>
      <div class="metric-card">
        <span>追蹤單字數</span>
        <strong>${data.reviewSummary.trackedWords}</strong>
      </div>
    `;
  }

  let requestId = 0;
  let requestedRange = "30";
  let renderedRange = "30";
  let overviewLoaded = false;

  async function loadGrowth(range) {
    const id = ++requestId;
    requestedRange = range;
    const target = document.getElementById("trendList");
    const status = document.getElementById("growthStatus");
    const retry = document.getElementById("growthRetry");
    const markRange = (value) => document.querySelectorAll("#growthRanges button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.range === value));
    });
    markRange(range);
    target.setAttribute("aria-busy", "true");
    status.textContent = "正在載入…";
    retry.hidden = true;
    try {
      const data = await api(`/api/analytics/summary?range=${range}`);
      if (id !== requestId) return;
      window.GrowthCharts.render(data.growthTrend);
      renderedRange = range;
      if (!overviewLoaded) {
        renderOverview(data);
        renderModeBreakdown(data.modeBreakdown);
        renderUnitPerformance(data.unitPerformance);
        renderWeakWords(data.weakWords);
        overviewLoaded = true;
      }
      status.textContent = "";
    } catch (error) {
      if (id !== requestId) return;
      markRange(renderedRange);
      status.textContent = `載入失敗：${error.message}。${overviewLoaded ? "仍顯示上次載入的圖表。" : "請重試。"}`;
      if (!overviewLoaded) target.innerHTML = "";
      retry.hidden = false;
    } finally {
      if (id === requestId) target.setAttribute("aria-busy", "false");
    }
  }

  function renderModeBreakdown(rows) {
    const target = document.getElementById("modeBreakdown");
    if (!rows.length) {
      target.innerHTML = `<div class="empty">目前還沒有題型統計。</div>`;
      return;
    }

    target.innerHTML = rows
      .map(
        (item) => `
          <div class="list-item compact-item">
            <div class="word-topline">
              <strong>${escapeHtml(modeLabel(item.mode))}</strong>
              <span class="pill">${item.accuracy}%</span>
            </div>
            <div class="mini-bar mode-bar">
              <span style="width:${item.accuracy}%"></span>
            </div>
            <div class="muted small-text">作答 ${item.attempts} 題，答對 ${item.correctCount} 題</div>
          </div>
        `
      )
      .join("");
  }

  function renderUnitPerformance(rows) {
    const target = document.getElementById("unitPerformance");
    if (!rows.length) {
      target.innerHTML = `<div class="empty">目前還沒有單元表現資料。</div>`;
      return;
    }

    target.innerHTML = rows
      .map(
        (item) => `
          <div class="list-item compact-item">
            <div class="word-topline">
              <strong>${escapeHtml(item.sourceName)} / ${escapeHtml(item.unitName)}</strong>
              <span class="pill">${item.accuracy}%</span>
            </div>
            <div class="mini-bar mode-bar">
              <span style="width:${item.accuracy}%"></span>
            </div>
            <div class="muted small-text">作答 ${item.attempts} 題</div>
          </div>
        `
      )
      .join("");
  }

  function renderWeakWords(weakWords) {
    const target = document.getElementById("weakWords");
    if (!weakWords.length) {
      target.innerHTML = `<div class="empty">目前沒有需要優先複習的單字。</div>`;
      return;
    }

    const maxWrong = Math.max(...weakWords.map((item) => Number(item.wrongCount || 0)), 1);
    target.innerHTML = weakWords
      .map(
        (item) => `
          <div class="list-item compact-item">
            <div class="word-topline">
              <strong>${escapeHtml(item.eng)}</strong>
              <span class="pill">錯 ${item.wrongCount}</span>
            </div>
            ${renderMeaningPreview(item.chEntries?.length ? item.chEntries : item.ch, 2)}
            <div class="muted small-text">${escapeHtml(item.sourceName)} / ${escapeHtml(item.unitName)}</div>
            <div class="mini-bar">
              <span style="width:${Math.max((Number(item.wrongCount || 0) / maxWrong) * 100, 8)}%"></span>
            </div>
            <div class="muted small-text">正確率 ${item.accuracy}% / 作答 ${item.attempts} 題</div>
          </div>
        `
      )
      .join("");
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    document.querySelectorAll("#growthRanges button").forEach((button) => {
      button.addEventListener("click", () => loadGrowth(button.dataset.range));
    });
    document.getElementById("growthRetry").addEventListener("click", () => loadGrowth(requestedRange));
    await loadGrowth("30");
  }

  return { init };
})();

AnalyticsPage.init().catch((error) => window.WordsApp.showMessage(error.message));
