const LeaderboardPage = (() => {
  const { api, refreshUser, enforcePageAccess } = window.WordsApp;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderOverview(list) {
    const target = document.getElementById("leaderboardOverview");
    const visibleRows = list.slice(0, 3);

    target.innerHTML = `
      <div class="metric-card">
        <span>上榜人數</span>
        <strong>${list.length}</strong>
      </div>
      <div class="metric-card">
        <span>最高分數</span>
        <strong>${list[0]?.score ?? 0}</strong>
      </div>
      <div class="metric-card">
        <span>前三名</span>
        <strong>${visibleRows.map((item) => escapeHtml(item.name)).join(" / ") || "尚無資料"}</strong>
      </div>
    `;
  }

  function renderLeaderboard(list) {
    const target = document.getElementById("leaderboardPageList");

    if (!list.length) {
      target.innerHTML = `<div class="empty">本週尚未產生排行榜資料。</div>`;
      return;
    }

    target.innerHTML = `
      <div class="leaderboard-list">
        ${list
          .map(
            (item) => `
              <article class="list-item leaderboard-card">
                <div class="leaderboard-rank">#${item.rank}</div>
                <div class="leaderboard-main">
                  <div class="leaderboard-topline">
                    <strong class="leaderboard-name">${escapeHtml(item.name)}</strong>
                    <span class="pill">分數 ${item.score}</span>
                  </div>
                  <div class="leaderboard-metrics">
                    <span>單字 ${item.practicedWords}</span>
                    <span>正確率 ${item.accuracy}%</span>
                  </div>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    const { leaderboard } = await api("/api/analytics/weekly-leaderboard");
    renderOverview(leaderboard || []);
    renderLeaderboard(leaderboard || []);
  }

  return { init };
})();

LeaderboardPage.init().catch((error) => window.WordsApp.showMessage(error.message));
