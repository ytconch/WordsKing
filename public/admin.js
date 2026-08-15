const AdminPage = (() => {
  const { api, refreshUser, enforcePageAccess, showMessage, state: appState } = window.WordsApp;

  const state = {
    draft: null,
    activeJobId: "",
    activeJobStatus: "",
    creatingLongTask: false,
    pollTimer: 0,
    textDraftBatches: [],
    sourceNames: [],
    catalogSources: [],
    examMeaningEditor: null,
    activityUsers: [],
    selectedActivityUserId: "",
    selectedRefreshSourceId: "",
    selectedExtraWordSourceId: "",
    selectedExtraWordUnitId: "",
    usersLoaded: false,
    usersVisible: false
  };

  const LIMITS = {
    usernameMax: 24,
    displayNameMax: 24,
    passwordMax: 64,
    sourceNameMax: 40,
    unitNameMax: 40,
    recoveryNoteMax: 160,
    notificationTitleMax: 40,
    notificationMessageMax: 500
  };

  const PAGE_LABELS = {
    words: "單字庫",
    practice: "練習",
    leaderboard: "排行榜",
    analytics: "趨勢",
    notifications: "通知",
    settings: "設定",
    admin: "管理"
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatDateTime(value) {
    if (!value) return "未提供";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatShortDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  }

  function formatPercent(value) {
    const number = Number(value || 0);
    return `${number.toFixed(1)}%`;
  }

  function formatDurationCompact(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds || 0)));
    if (!safeSeconds) return "0 分";
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    if (hours && minutes) return `${hours} 小時 ${minutes} 分`;
    if (hours) return `${hours} 小時`;
    return `${Math.max(1, minutes)} 分`;
  }

  function getPageLabel(pageKey) {
    return PAGE_LABELS[pageKey] || pageKey || "未知頁面";
  }

  function formatExample(example) {
    if (typeof example === "string") {
      return example;
    }
    try {
      return JSON.stringify(example || [], null, 2);
    } catch {
      return "[]";
    }
  }

  function hydrateMultiline(value) {
    return String(value ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }

  function formatJsonBlock(value) {
    if (value === null || value === undefined || value === "") {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function applyStaticLimits() {
    document.getElementById("notificationTitle")?.setAttribute("maxlength", String(LIMITS.notificationTitleMax));
    document.getElementById("notificationMessage")?.setAttribute("maxlength", String(LIMITS.notificationMessageMax));
  }

  function setLongTaskBusy(isBusy) {
    document
      .querySelectorAll(
        "#imageDraftForm input, #imageDraftForm button, #textDraftForm input, #textDraftForm button, #textDraftForm textarea, #extraWordForm button, #extraWordForm select, #extraWordForm textarea, #libraryRefreshForm button, #libraryRefreshForm select, #libraryRefreshUnitList input"
      )
      .forEach((element) => {
        element.disabled = isBusy;
      });
  }

  function createTextDraftBatch() {
    return {
      id: window.crypto?.randomUUID?.() || `text-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceName: "",
      unitName: "",
      wordsText: ""
    };
  }

  function parseWordListText(text) {
    return String(text ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .flatMap((line) => line.split(/[,，;；、]/))
      .map((item) => item.replace(/^(\d+[\.\)]\s*|[-*•]\s*)/, "").trim())
      .filter(Boolean);
  }

  function readTextDraftBatchesFromDom() {
    return [...document.querySelectorAll(".text-draft-batch-card")].map((card) => ({
      id: card.dataset.batchId,
      sourceName: card.querySelector('[data-field="sourceName"]')?.value.trim() || "",
      unitName: card.querySelector('[data-field="unitName"]')?.value.trim() || "",
      wordsText: card.querySelector('[data-field="wordsText"]')?.value || ""
    }));
  }

  function buildTextDraftBatchCard(batch, index) {
    const wordCount = parseWordListText(batch.wordsText).length;
    return `
      <article class="text-draft-batch-card list-item" data-batch-id="${batch.id}">
        <div class="section-title-row">
          <div>
            <strong>批次 ${index + 1}</strong>
            <div class="muted small-text">單字 ${wordCount} 個</div>
          </div>
          <button type="button" class="ghost-btn remove-text-draft-batch-btn" data-batch-id="${batch.id}" ${state.textDraftBatches.length <= 1 ? "disabled" : ""}>
            刪除
          </button>
        </div>
        <div class="draft-text-batch-grid admin-user-grid">
          <label>來源<input data-field="sourceName" list="sourceNameOptions" maxlength="${LIMITS.sourceNameMax}" value="${escapeHtml(batch.sourceName)}" /></label>
          <label>單元<input data-field="unitName" maxlength="${LIMITS.unitNameMax}" value="${escapeHtml(batch.unitName)}" /></label>
        </div>
        <label>
          英文列表
          <textarea
            data-field="wordsText"
            rows="6"
            placeholder="每行一個或用逗號分隔，例如：&#10;pretend&#10;frequent&#10;faith"
          >${escapeHtml(batch.wordsText)}</textarea>
        </label>
      </article>
    `;
  }

  function renderTextDraftBatches() {
    const target = document.getElementById("textDraftBatchList");
    if (!target) return;
    if (!state.textDraftBatches.length) {
      state.textDraftBatches = [createTextDraftBatch()];
    }

    target.innerHTML = state.textDraftBatches.map(buildTextDraftBatchCard).join("");
    target.querySelectorAll(".remove-text-draft-batch-btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.textDraftBatches = readTextDraftBatchesFromDom().filter((batch) => batch.id !== button.dataset.batchId);
        if (!state.textDraftBatches.length) {
          state.textDraftBatches = [createTextDraftBatch()];
        }
        renderTextDraftBatches();
      });
    });
  }

  function clearPollTimer() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }

  function renderSourceSuggestions() {
    const target = document.getElementById("sourceNameOptions");
    if (!target) return;
    target.innerHTML = state.sourceNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  }

  async function loadNotificationRecipients() {
    const target = document.getElementById("notificationRecipient");
    if (!target) return;
    const { users } = await api("/api/notifications/recipients");
    target.innerHTML = [
      `<option value="all">全部使用者</option>`,
      ...users.map(
        (user) =>
          `<option value="${user.id}">${escapeHtml(user.displayName || user.username)} (${escapeHtml(user.role)})</option>`
      )
    ].join("");
  }

  async function submitNotification(form) {
    const recipientUserId = document.getElementById("notificationRecipient").value;
    const title = document.getElementById("notificationTitle").value.trim();
    const message = document.getElementById("notificationMessage").value.trim();

    await api("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientUserId: recipientUserId === "all" ? null : Number(recipientUserId),
        title,
        message
      })
    });

    form.reset();
    document.getElementById("notificationRecipient").value = "all";
    showMessage(recipientUserId === "all" ? "已送出全體通知。" : "已送出個別通知。");
  }

  function buildDraftEditorRow(row, index, itemId) {
    return `
      <article
        class="list-item draft-word-card"
        data-item-id="${itemId}"
        data-draft-index="${index}"
        data-word-id="${row.wordId || ""}"
        data-word-ref="${escapeHtml(row.wordRef || "")}"
      >
        <div class="word-topline">
          <strong>單字 ${index + 1}</strong>
          <button type="button" class="ghost-btn remove-draft-row-btn" data-item-id="${itemId}" data-draft-index="${index}">
            刪除
          </button>
        </div>
        <div class="admin-user-grid draft-field-grid">
          <label>eng<input data-field="eng" value="${escapeHtml(row.eng)}" /></label>
          <label>kk<input data-field="kk" value="${escapeHtml(row.kk)}" /></label>
          <label>tense<input data-field="tense" value="${escapeHtml(row.tense)}" /></label>
          <label>ch<input data-field="ch" value="${escapeHtml(row.ch)}" /></label>
        </div>
        <details class="draft-extra-fields">
          <summary>更多欄位</summary>
          <div class="draft-extra-grid">
            <label>analysis<textarea data-field="analysis" rows="4">${escapeHtml(hydrateMultiline(row.analysis))}</textarea></label>
            <label>definition<textarea data-field="definition" rows="3">${escapeHtml(hydrateMultiline(row.definition))}</textarea></label>
            <label>example<textarea data-field="example" rows="5">${escapeHtml(hydrateMultiline(formatExample(row.example)))}</textarea></label>
          </div>
        </details>
      </article>
    `;
  }

  function buildDraftBatchCard(item) {
    if (item.status === "failed") {
      return `
        <article class="list-item draft-batch-card" data-item-id="${item.id}">
          <div class="word-topline">
            <strong>${escapeHtml(item.fileName)}</strong>
            <span class="pill">失敗</span>
          </div>
          <div class="muted small-text">${escapeHtml(hydrateMultiline(item.error || "處理失敗"))}</div>
        </article>
      `;
    }

    const readOnlyAttr =
      state.draft?.operation === "refresh" || state.draft?.operation === "append" ? "readonly" : "";
    const editableOcr = state.draft?.phase === "ocr-review";
    const ocrReviewBlock =
      state.draft?.operation === "import"
        ? `
            <details class="draft-extra-fields draft-ocr-review">
              <summary>OCR 內容核對</summary>
              <label>
                <textarea rows="10" data-batch-field="ocrText" ${editableOcr ? "" : "readonly"}>${escapeHtml(hydrateMultiline(item.ocrText || ""))}</textarea>
              </label>
            </details>
          `
        : "";

    if (editableOcr) {
      return `
        <article class="list-item draft-batch-card" data-item-id="${item.id}">
          <details class="draft-batch-shell" open>
            <summary class="draft-batch-summary">
              <div>
                <strong>${escapeHtml(item.fileName)}</strong>
                <div class="muted small-text">先人工核對 OCR，再送 AI</div>
              </div>
              <span class="pill">${item.status === "completed" ? "已完成 OCR" : "待處理"}</span>
            </summary>
            <div class="draft-batch-body">
              <div class="admin-user-grid draft-field-grid batch-meta-grid">
                <label>來源<input data-batch-field="sourceName" list="sourceNameOptions" maxlength="${LIMITS.sourceNameMax}" value="${escapeHtml(item.sourceName || "")}" /></label>
                <label>單元<input data-batch-field="unitName" maxlength="${LIMITS.unitNameMax}" value="${escapeHtml(item.unitName || "")}" /></label>
              </div>
              ${ocrReviewBlock}
            </div>
          </details>
        </article>
      `;
    }

    return `
      <article class="list-item draft-batch-card" data-item-id="${item.id}">
        <details class="draft-batch-shell">
          <summary class="draft-batch-summary">
            <div>
              <strong>${escapeHtml(item.fileName)}</strong>
              <div class="muted small-text">單字數：${item.rows.length}</div>
            </div>
            <span class="pill">${item.status === "completed" ? "可編修" : "處理中"}</span>
          </summary>
          <div class="draft-batch-body">
            <div class="admin-user-grid draft-field-grid batch-meta-grid">
              <label>來源<input data-batch-field="sourceName" list="sourceNameOptions" maxlength="${LIMITS.sourceNameMax}" value="${escapeHtml(item.sourceName || "")}" ${readOnlyAttr} /></label>
              <label>單元<input data-batch-field="unitName" maxlength="${LIMITS.unitNameMax}" value="${escapeHtml(item.unitName || "")}" ${readOnlyAttr} /></label>
            </div>
            ${ocrReviewBlock}
            <div class="draft-item-rows">
              ${item.rows.map((row, index) => buildDraftEditorRow(row, index, item.id)).join("")}
            </div>
          </div>
        </details>
      </article>
    `;
  }

  function clearDraft() {
    state.draft = null;
    state.activeJobId = "";
    state.activeJobStatus = "";
    state.creatingLongTask = false;
    clearPollTimer();
    setLongTaskBusy(false);
    document.getElementById("imageDraftPanel").classList.add("hidden");
    document.getElementById("draftWordEditor").innerHTML = "";
    document.getElementById("draftSummaryText").textContent = "目前沒有待核對草稿。";
    document.getElementById("draftCountText").textContent = "";
    document.getElementById("draftProgressBox").classList.add("hidden");
    document.getElementById("draftProgressTitle").textContent = "處理進度";
    document.getElementById("draftProgressPercent").textContent = "0%";
    document.getElementById("draftProgressBar").style.width = "0%";
    document.getElementById("draftProgressMessage").textContent = "尚未開始";
    document.getElementById("draftProgressLogs").textContent = "";
    document.getElementById("clearDraftBtn").disabled = false;
    document.getElementById("saveDraftBtn").disabled = true;
  }

  function renderJobProgress(job) {
    state.activeJobStatus = job.status || "";
    setLongTaskBusy(job.status === "queued" || job.status === "running" || Boolean(job.reviewPending));
    const canSaveDraft = job.status === "completed" && Boolean(job.reviewPending);
    document.getElementById("clearDraftBtn").disabled = job.status === "queued" || job.status === "running";
    document.getElementById("saveDraftBtn").disabled = !canSaveDraft;
    document.getElementById("imageDraftPanel").classList.remove("hidden");
    document.getElementById("draftProgressBox").classList.remove("hidden");
    document.getElementById("draftProgressTitle").textContent =
      job.status === "completed" ? "處理完成" : job.status === "failed" ? "處理失敗" : "處理中";
    document.getElementById("draftProgressPercent").textContent = `${job.progress || 0}%`;
    document.getElementById("draftProgressBar").style.width = `${job.progress || 0}%`;
    document.getElementById("draftProgressMessage").textContent = hydrateMultiline(job.message || "處理中");
    document.getElementById("draftProgressLogs").textContent = (job.logs || []).map(hydrateMultiline).join("\n");
  }

  function renderDraftPanel() {
    if (!state.draft) {
      clearDraft();
      return;
    }

    document.getElementById("imageDraftPanel").classList.remove("hidden");
    const saveButton = document.getElementById("saveDraftBtn");
    saveButton.textContent =
      state.draft.phase === "ocr-review"
        ? "送交 AI 生成草稿"
        : state.draft.operation === "refresh"
          ? "確認並覆蓋資料庫"
          : state.draft.operation === "append"
            ? "確認並追加到原單元"
          : "確認並匯入";

    const successCount = state.draft.items.filter((item) => item.status === "completed").length;
    const failedCount = state.draft.items.filter((item) => item.status === "failed").length;
    const rowCount = state.draft.items.reduce((sum, item) => sum + (item.rows?.length || 0), 0);
    document.getElementById("draftSummaryText").textContent =
      state.draft.phase === "ocr-review"
        ? `共 ${state.draft.items.length} 批，已完成 OCR ${successCount} 批`
        : state.draft.operation === "append"
          ? `共 ${state.draft.items.length} 批補字草稿，成功 ${successCount} 批`
          : `共 ${state.draft.items.length} 批草稿，成功 ${successCount} 批`;
    document.getElementById("draftCountText").textContent =
      state.draft.phase === "ocr-review"
        ? `${failedCount ? `失敗 ${failedCount} 批` : "請先核對 OCR 內容後再送交 AI。"}`
        : `單字總數 ${rowCount}${failedCount ? `，失敗 ${failedCount} 批` : ""}`;
    document.getElementById("draftWordEditor").innerHTML = state.draft.items.map(buildDraftBatchCard).join("");

    document.querySelectorAll(".remove-draft-row-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const itemId = button.dataset.itemId;
        const rowIndex = Number(button.dataset.draftIndex);
        const targetItem = state.draft.items.find((item) => item.id === itemId);
        if (!targetItem) return;
        targetItem.rows.splice(rowIndex, 1);
        renderDraftPanel();
      });
    });
  }

  function readDraftRowsFromDom() {
    const batchCards = [...document.querySelectorAll(".draft-batch-card")];
    return batchCards.map((card) => {
      const itemId = card.dataset.itemId;
      const sourceName = card.querySelector('[data-batch-field="sourceName"]')?.value.trim() || "";
      const unitName = card.querySelector('[data-batch-field="unitName"]')?.value.trim() || "";
      const fileName =
        state.draft?.items.find((item) => item.id === itemId)?.fileName ||
        card.querySelector("strong")?.textContent?.trim() ||
        "";

      const rows = [...card.querySelectorAll(".draft-word-card")].map((rowCard) => ({
        wordId: Number(rowCard.dataset.wordId || 0) || null,
        wordRef: rowCard.dataset.wordRef || "",
        eng: rowCard.querySelector('[data-field="eng"]')?.value.trim() || "",
        kk: rowCard.querySelector('[data-field="kk"]')?.value.trim() || "",
        tense: rowCard.querySelector('[data-field="tense"]')?.value.trim() || "",
        ch: rowCard.querySelector('[data-field="ch"]')?.value.trim() || "",
        analysis: rowCard.querySelector('[data-field="analysis"]')?.value.trim() || "",
        definition: rowCard.querySelector('[data-field="definition"]')?.value.trim() || "",
        example: rowCard.querySelector('[data-field="example"]')?.value.trim() || "[]"
      }));

      return {
        itemId,
        unitId: state.draft?.items.find((item) => item.id === itemId)?.unitId || null,
        sourceName,
        unitName,
        ocrText: card.querySelector('[data-batch-field="ocrText"]')?.value || "",
        fileName,
        rows
      };
    });
  }

  function renderActivityTable(activity) {
    const target = document.getElementById("activityTableWrap");
    if (!activity.length) {
      target.innerHTML = `<div class="list-item">目前沒有活躍資料。</div>`;
      return;
    }

    target.innerHTML = `
      <div class="activity-table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>玩家</th>
              <th>角色</th>
              <th>最近活躍</th>
              <th>近 7 天作答</th>
              <th>近 7 天場次</th>
              <th>近 7 天正確率</th>
              <th>累積作答</th>
            </tr>
          </thead>
          <tbody>
            ${activity
              .map(
                (user) => `
                  <tr>
                    <td>${escapeHtml(user.displayName || user.username)}</td>
                    <td>${escapeHtml(user.role)}</td>
                    <td>${escapeHtml(formatDateTime(user.lastActiveAt))}</td>
                    <td>${Number(user.attempts7d || 0)}</td>
                    <td>${Number(user.sessions7d || 0)}</td>
                    <td>${formatPercent(user.accuracy7d || 0)}</td>
                    <td>${Number(user.totalAttempts || 0)}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderActivityTrendChart(trend) {
    const wrap = document.getElementById("activityTrendChart");
    if (!trend.length) {
      wrap.innerHTML = `<div class="list-item">目前沒有趨勢資料。</div>`;
      return;
    }

    const width = 520;
    const height = 190;
    const padding = { top: 18, right: 18, bottom: 28, left: 32 };
    const maxAttempts = Math.max(...trend.map((item) => item.attempts), 1);
    const xStep = trend.length > 1 ? (width - padding.left - padding.right) / (trend.length - 1) : 0;
    const yScale = (height - padding.top - padding.bottom) / maxAttempts;

    const points = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        const y = height - padding.bottom - item.attempts * yScale;
        return `${x},${y}`;
      })
      .join(" ");

    const dots = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        const y = height - padding.bottom - item.attempts * yScale;
        return `<circle class="activity-line-dot" cx="${x}" cy="${y}" r="4.5"></circle>`;
      })
      .join("");

    const labels = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        return `<text x="${x}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatShortDate(item.studyDate))}</text>`;
      })
      .join("");

    wrap.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" class="activity-line-chart" role="img" aria-label="近期活躍折線圖">
        <g class="activity-line-grid">
          <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
          <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
        </g>
        <polyline class="activity-line-path" points="${points}"></polyline>
        <g class="activity-line-points">${dots}</g>
        <g class="activity-line-labels">${labels}</g>
      </svg>
    `;
  }

  async function loadActivityTrend(userId) {
    if (!userId) {
      document.getElementById("activityTrendSummary").innerHTML = "";
      document.getElementById("activityTrendChart").innerHTML = `<div class="list-item">請先選擇使用者。</div>`;
      return;
    }

    const data = await api(`/api/admin/activity/${userId}/trend`);
    document.getElementById("activityTrendSummary").innerHTML = `
      <div class="leaderboard-metric"><strong>14 天作答</strong><span>${data.summary.totalAttempts}</span></div>
      <div class="leaderboard-metric"><strong>活躍天數</strong><span>${data.summary.activeDays}</span></div>
      <div class="leaderboard-metric"><strong>正確率</strong><span>${formatPercent(data.summary.accuracy)}</span></div>
      <div class="leaderboard-metric"><strong>單日峰值</strong><span>${data.summary.peakAttempts}</span></div>
    `;
    renderActivityTrendChart(data.trend || []);
  }

  async function loadActivity() {
    const { activity } = await api("/api/admin/activity");
    state.activityUsers = activity || [];
    renderActivityTable(state.activityUsers);

    const select = document.getElementById("activityUserSelect");
    select.innerHTML = state.activityUsers.length
      ? state.activityUsers
          .map(
            (user) =>
              `<option value="${user.id}">${escapeHtml(user.displayName || user.username)} (${escapeHtml(user.role)})</option>`
          )
          .join("")
      : `<option value="">目前沒有資料</option>`;

    const stillExists = state.activityUsers.some((user) => String(user.id) === String(state.selectedActivityUserId));
    if (!stillExists) {
      state.selectedActivityUserId = state.activityUsers[0]?.id || "";
    }

    select.value = state.selectedActivityUserId ? String(state.selectedActivityUserId) : "";
    await loadActivityTrend(select.value);
  }

  function renderServerLogs(data) {
    const summary = data?.summary || {};
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    const logs = Array.isArray(data?.logs) ? data.logs : [];

    document.getElementById("serverLogSummary").innerHTML = `
      <div class="leaderboard-metric"><strong>24h 總量</strong><span>${Number(summary.total24h || 0)}</span></div>
      <div class="leaderboard-metric"><strong>24h 錯誤</strong><span>${Number(summary.errors24h || 0)}</span></div>
      <div class="leaderboard-metric"><strong>24h 警告</strong><span>${Number(summary.warnings24h || 0)}</span></div>
      <div class="leaderboard-metric"><strong>24h 操作者</strong><span>${Number(summary.actors24h || 0)}</span></div>
    `;

    document.getElementById("serverLogCategorySummary").innerHTML = categories.length
      ? categories
          .map(
            (item) =>
              `<span class="pill server-log-chip">${escapeHtml(item.category)} · ${Number(item.count || 0)}</span>`
          )
          .join("")
      : `<div class="muted small-text">最近 24 小時尚無分類資料。</div>`;

    const target = document.getElementById("serverLogTableWrap");
    if (!logs.length) {
      target.innerHTML = `<div class="list-item">目前沒有 server log。</div>`;
      return;
    }

    target.innerHTML = `
      <div class="activity-table-scroll">
        <table class="activity-table server-log-table">
          <thead>
            <tr>
              <th>時間</th>
              <th>等級</th>
              <th>分類</th>
              <th>動作</th>
              <th>帳號</th>
              <th>IP</th>
              <th>訊息</th>
              <th>細節</th>
            </tr>
          </thead>
          <tbody>
            ${logs
              .map((log) => {
                const detailText = formatJsonBlock(log.details);
                const actorText = log.actorUsername
                  ? `${escapeHtml(log.actorUsername)}${log.actorUserId ? ` (#${log.actorUserId})` : ""}`
                  : log.actorUserId
                    ? `#${log.actorUserId}`
                    : "系統";

                return `
                  <tr>
                    <td>${escapeHtml(formatDateTime(log.createdAt))}</td>
                    <td><span class="pill server-log-level server-log-level-${escapeHtml(log.level || "info")}">${escapeHtml(log.level || "info")}</span></td>
                    <td>${escapeHtml(log.category || "-")}</td>
                    <td><div class="server-log-action">${escapeHtml(log.action || "-")}</div><div class="muted small-text">${escapeHtml(log.method || "")} ${escapeHtml(log.route || "")}</div></td>
                    <td>${actorText}</td>
                    <td>${escapeHtml(log.ipAddress || "-")}</td>
                    <td>${escapeHtml(log.message || "-")}</td>
                    <td>
                      ${
                        detailText
                          ? `<details class="server-log-details"><summary>查看</summary><pre class="cli-log-box server-log-detail-pre">${escapeHtml(detailText)}</pre></details>`
                          : `<span class="muted small-text">-</span>`
                      }
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  async function loadServerLogs() {
    const data = await api("/api/admin/server-logs?limit=80");
    renderServerLogs(data);
  }

  function renderCatalog(sources) {
    state.catalogSources = sources;
    state.sourceNames = sources.map((source) => source.name);
    renderSourceSuggestions();
    renderExtraWordFilters();
    renderLibraryRefreshFilters();

    const target = document.getElementById("catalogList");
    if (!sources.length) {
      target.innerHTML = `<div class="list-item">目前沒有單字資料。</div>`;
      return;
    }

    target.innerHTML = sources
      .map(
        (source) => `
          <article class="list-item catalog-source-card" data-source-id="${source.id}">
            <div class="word-topline">
              <strong>${escapeHtml(source.name)}</strong>
              <span class="pill">${source.units.length} 單元</span>
            </div>
            <div class="catalog-source-editor">
              <label>
                來源名稱
                <input
                  class="catalog-name-input source-rename-input"
                  data-source-id="${source.id}"
                  value="${escapeHtml(source.name)}"
                />
              </label>
              <button type="button" class="ghost-btn rename-source-btn" data-source-id="${source.id}">
                更新來源
              </button>
            </div>
            <div class="list">
              ${source.units
                .map(
                  (unit) => `
                    <div class="list-item compact-item catalog-unit-card">
                      <div>
                        <strong>${escapeHtml(unit.name)}</strong>
                        <div class="muted small-text">
                          ${Number(unit.word_count || 0)} 單字
                          · 已標 ${Number(unit.exam_word_count || 0)} 詞 / ${Number(unit.exam_meaning_count || 0)} 項考試字義
                        </div>
                      </div>
                      <div class="catalog-inline-actions">
                        <label class="catalog-inline-field">
                          <span class="sr-only">單元名稱</span>
                          <input
                            class="catalog-name-input unit-rename-input"
                            data-unit-id="${unit.id}"
                            value="${escapeHtml(unit.name)}"
                          />
                        </label>
                        <label class="catalog-inline-field">
                          <span class="sr-only">來源</span>
                          <select class="unit-source-select" data-unit-id="${unit.id}">
                            ${sources
                              .map(
                                (sourceOption) =>
                                  `<option value="${sourceOption.id}" ${String(sourceOption.id) === String(source.id) ? "selected" : ""}>${escapeHtml(sourceOption.name)}</option>`
                              )
                              .join("")}
                          </select>
                        </label>
                        <button type="button" class="ghost-btn edit-exam-meanings-btn" data-unit-id="${unit.id}">
                          考試字義
                        </button>
                        <button type="button" class="ghost-btn rename-unit-btn" data-unit-id="${unit.id}">
                          更新
                        </button>
                        <button type="button" class="ghost-btn delete-unit-btn" data-unit-id="${unit.id}">
                          刪除
                        </button>
                      </div>
                    </div>
                  `
                )
                .join("")}
            </div>
          </article>
        `
      )
      .join("");

    document.querySelectorAll(".rename-source-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const sourceId = button.dataset.sourceId;
        const input = document.querySelector(`.source-rename-input[data-source-id="${sourceId}"]`);
        const name = input?.value.trim() || "";
        if (!name) {
          showMessage("來源名稱不可為空。");
          return;
        }

        await api(`/api/import/sources/${sourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        showMessage("來源名稱已更新。");
        await loadCatalog();
      });
    });

    document.querySelectorAll(".edit-exam-meanings-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        await openExamMeaningEditor(button.dataset.unitId);
      });
    });

    document.querySelectorAll(".rename-unit-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const unitId = button.dataset.unitId;
        const input = document.querySelector(`.unit-rename-input[data-unit-id="${unitId}"]`);
        const sourceSelect = document.querySelector(`.unit-source-select[data-unit-id="${unitId}"]`);
        const name = input?.value.trim() || "";
        const sourceId = sourceSelect?.value || "";
        if (!name) {
          showMessage("單元名稱不可為空。");
          return;
        }

        await api(`/api/import/units/${unitId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, sourceId })
        });
        showMessage("單元資料已更新。");
        await loadCatalog();
        if (state.examMeaningEditor?.unitId === Number(unitId)) {
          await openExamMeaningEditor(unitId);
        }
      });
    });

    document.querySelectorAll(".delete-unit-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const unitId = button.dataset.unitId;
        const ok = window.confirm("確定要刪除此單元與其所有單字嗎？");
        if (!ok) return;
        await api(`/api/import/units/${unitId}`, { method: "DELETE" });
        showMessage("單元已刪除。");
        if (state.examMeaningEditor?.unitId === Number(unitId)) {
          closeExamMeaningPanel();
        }
        await loadCatalog();
      });
    });
  }

  function buildExamMeaningWordCard(word) {
    const entries = Array.isArray(word.chEntries) ? word.chEntries : [];
    const selectedIndexes = new Set((word.examMeaningIndexes || []).map((item) => Number(item)));
    return `
      <article class="list-item exam-meaning-word-card" data-word-ref="${escapeHtml(word.wordRef)}">
        <div class="word-topline">
          <div>
            <strong>${escapeHtml(word.eng)}</strong>
            <div class="muted small-text">${escapeHtml(word.tense || "未分類")} · ${entries.length} 項義項</div>
          </div>
          <span class="muted small-text">${escapeHtml(word.kk || "未提供 KK")}</span>
        </div>
        <div class="exam-meaning-chip-list">
          ${entries.length
            ? entries
                .map(
                  (entry, index) => `
                    <label class="exam-meaning-chip">
                      <input type="checkbox" data-meaning-index="${index}" ${selectedIndexes.has(index) ? "checked" : ""} />
                      <span>${index + 1}. ${escapeHtml(entry)}</span>
                    </label>
                  `
                )
                .join("")
            : `<div class="muted small-text">此單字目前沒有可切分的中文義項。</div>`}
        </div>
      </article>
    `;
  }

  function renderVisitTrendChart(trend) {
    const wrap = document.getElementById("visitActivityChart");
    if (!trend.length) {
      wrap.innerHTML = `<div class="list-item">目前沒有造訪資料。</div>`;
      return;
    }

    const width = 620;
    const height = 220;
    const padding = { top: 20, right: 22, bottom: 30, left: 36 };
    const maxVisits = Math.max(...trend.map((item) => item.visits), 1);
    const maxDurationSeconds = Math.max(...trend.map((item) => item.durationSeconds), 1);
    const yScaleVisits = (height - padding.top - padding.bottom) / maxVisits;
    const yScaleDuration = (height - padding.top - padding.bottom) / maxDurationSeconds;
    const xStep = trend.length > 1 ? (width - padding.left - padding.right) / (trend.length - 1) : 0;

    const visitPoints = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        const y = height - padding.bottom - item.visits * yScaleVisits;
        return `${x},${y}`;
      })
      .join(" ");

    const durationPoints = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        const y = height - padding.bottom - item.durationSeconds * yScaleDuration;
        return `${x},${y}`;
      })
      .join(" ");

    const bars = trend
      .map((item, index) => {
        const x = padding.left + index * xStep - 8;
        const barHeight = item.visits * yScaleVisits;
        return `<rect class="visit-bar" x="${x}" y="${height - padding.bottom - barHeight}" width="16" height="${Math.max(barHeight, 2)}" rx="8"></rect>`;
      })
      .join("");

    const labels = trend
      .map((item, index) => {
        const x = padding.left + index * xStep;
        return `<text x="${x}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatShortDate(item.visitDate))}</text>`;
      })
      .join("");

    wrap.innerHTML = `
      <div class="chart-legend visit-chart-legend">
        <span><i class="legend-swatch visits"></i> 造訪次數</span>
        <span><i class="legend-swatch users"></i> 停留時長</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="activity-line-chart visit-activity-chart" role="img" aria-label="近十四天造訪活躍圖">
        <g class="activity-line-grid">
          <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
          <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
        </g>
        <g class="visit-bars">${bars}</g>
        <polyline class="visit-user-path" points="${durationPoints}"></polyline>
        <polyline class="activity-line-path" points="${visitPoints}"></polyline>
        <g class="activity-line-labels">${labels}</g>
      </svg>
    `;
  }

  function renderVisitBreakdown(pages) {
    const target = document.getElementById("visitBreakdownTable");
    if (!pages.length) {
      target.innerHTML = `<div class="list-item">目前沒有頁面分佈資料。</div>`;
      return;
    }

    target.innerHTML = `
      <div class="activity-table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>頁面</th>
              <th>造訪次數</th>
              <th>造訪人數</th>
              <th>總停留</th>
              <th>平均停留</th>
              <th>最近造訪</th>
            </tr>
          </thead>
          <tbody>
            ${pages
              .map(
                (item) => `
                  <tr>
                    <td>${escapeHtml(getPageLabel(item.pageKey))}</td>
                    <td>${Number(item.visits || 0)}</td>
                    <td>${Number(item.uniqueUsers || 0)}</td>
                    <td>${escapeHtml(formatDurationCompact(item.durationSeconds || 0))}</td>
                    <td>${escapeHtml(formatDurationCompact(item.avgDurationSeconds || 0))}</td>
                    <td>${escapeHtml(formatDateTime(item.lastVisitAt))}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRecentVisits(visits) {
    const target = document.getElementById("visitRecentList");
    if (!visits.length) {
      target.innerHTML = `<div class="list-item">目前沒有近期造訪紀錄。</div>`;
      return;
    }

    target.innerHTML = visits
      .map(
        (visit) => `
          <div class="list-item compact-item visit-recent-item">
            <div>
              <strong>${escapeHtml(visit.displayName || visit.username)}</strong>
              <div class="muted small-text">${escapeHtml(getPageLabel(visit.pageKey))}${visit.path ? ` · ${escapeHtml(visit.path)}` : ""}</div>
              <div class="muted small-text">停留 ${escapeHtml(formatDurationCompact(visit.durationSeconds || 0))}</div>
            </div>
            <div class="muted small-text">${escapeHtml(formatDateTime(visit.startedAt))}</div>
          </div>
        `
      )
      .join("");
  }

  async function loadVisitActivity() {
    const data = await api("/api/admin/activity/visits");
    document.getElementById("visitActivitySummary").innerHTML = `
      <div class="leaderboard-metric"><strong>14 天造訪</strong><span>${Number(data.summary.totalVisits || 0)}</span></div>
      <div class="leaderboard-metric"><strong>造訪人數</strong><span>${Number(data.summary.uniqueVisitors || 0)}</span></div>
      <div class="leaderboard-metric"><strong>今日造訪</strong><span>${Number(data.summary.todayVisits || 0)}</span></div>
      <div class="leaderboard-metric"><strong>總停留</strong><span>${escapeHtml(formatDurationCompact(data.summary.totalDurationSeconds || 0))}</span></div>
      <div class="leaderboard-metric"><strong>平均停留</strong><span>${escapeHtml(formatDurationCompact(data.summary.averageDurationSeconds || 0))}</span></div>
      <div class="leaderboard-metric"><strong>今日停留</strong><span>${escapeHtml(formatDurationCompact(data.summary.todayDurationSeconds || 0))}</span></div>
      <div class="leaderboard-metric"><strong>單日峰值</strong><span>${Number(data.summary.peakVisits || 0)}</span></div>
    `;
    renderVisitTrendChart(data.trend || []);
    renderVisitBreakdown(data.pages || []);
    renderRecentVisits(data.recentVisits || []);
  }

  function syncExamMeaningSummaryFromDom() {
    if (!state.examMeaningEditor) {
      return;
    }

    const cards = [...document.querySelectorAll(".exam-meaning-word-card")];
    const selectedMeaningCount = cards.reduce(
      (sum, card) => sum + card.querySelectorAll('input[type="checkbox"]:checked').length,
      0
    );
    const summary = document.getElementById("examMeaningPanelSummary");
    if (summary) {
      summary.textContent = `共 ${cards.length} 個單字，目前標記 ${selectedMeaningCount} 項考試字義。`;
    }
  }

  function attachExamMeaningEvents() {
    document.querySelectorAll('.exam-meaning-chip input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        const chip = input.closest(".exam-meaning-chip");
        chip?.classList.toggle("is-active", input.checked);
        syncExamMeaningSummaryFromDom();
      });
    });
  }

  function renderExamMeaningPanel() {
    const panel = document.getElementById("examMeaningPanel");
    const title = document.getElementById("examMeaningPanelTitle");
    const summary = document.getElementById("examMeaningPanelSummary");
    const editor = document.getElementById("examMeaningEditor");
    const current = state.examMeaningEditor;

    if (!current) {
      panel.classList.add("hidden");
      title.textContent = "尚未選擇單元";
      summary.textContent = "請先從上方單元管理選擇一個單元。";
      editor.innerHTML = "";
      return;
    }

    const selectedMeaningCount = current.words.reduce(
      (sum, word) => sum + (Array.isArray(word.examMeaningIndexes) ? word.examMeaningIndexes.length : 0),
      0
    );

    panel.classList.remove("hidden");
    title.textContent = `${current.sourceName} / ${current.unitName}`;
    summary.textContent = `共 ${current.words.length} 個單字，目前標記 ${selectedMeaningCount} 項考試字義。`;
    editor.innerHTML = current.words.length
      ? current.words.map(buildExamMeaningWordCard).join("")
      : `<div class="list-item">這個單元目前沒有單字。</div>`;
    attachExamMeaningEvents();
  }

  async function openExamMeaningEditor(unitId) {
    const response = await api(`/api/import/units/${unitId}/exam-meanings`);
    state.examMeaningEditor = {
      unitId: Number(response.unit.id),
      unitName: response.unit.name,
      sourceName: response.unit.sourceName,
      words: response.words || []
    };
    renderExamMeaningPanel();
    document.getElementById("examMeaningPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readExamMeaningSelections() {
    return [...document.querySelectorAll(".exam-meaning-word-card")].map((card) => ({
      wordRef: card.dataset.wordRef || "",
      meaningIndexes: [...card.querySelectorAll('input[type="checkbox"]:checked')].map((input) =>
        Number(input.dataset.meaningIndex)
      )
    }));
  }

  async function saveExamMeaningSelections() {
    if (!state.examMeaningEditor?.unitId) {
      showMessage("請先選擇單元。");
      return;
    }

    const response = await api(`/api/import/units/${state.examMeaningEditor.unitId}/exam-meanings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: readExamMeaningSelections() })
    });

    showMessage(response.message || "考試字義設定已更新。");
    await loadCatalog();
    await openExamMeaningEditor(state.examMeaningEditor.unitId);
  }

  function closeExamMeaningPanel() {
    state.examMeaningEditor = null;
    renderExamMeaningPanel();
  }

  async function loadCatalog() {
    const { sources } = await api("/api/import/catalog");
    renderCatalog(sources || []);
  }

  function getVisibleRefreshUnits() {
    const selectedSourceId = state.selectedRefreshSourceId;
    const sources = selectedSourceId
      ? state.catalogSources.filter((source) => String(source.id) === String(selectedSourceId))
      : state.catalogSources;

    return sources.flatMap((source) =>
      (source.units || []).map((unit) => ({
        sourceId: source.id,
        sourceName: source.name,
        unitId: unit.id,
        unitName: unit.name,
        wordCount: Number(unit.word_count || 0)
      }))
    );
  }

  function getVisibleExtraWordUnits() {
    const source = state.catalogSources.find((item) => String(item.id) === String(state.selectedExtraWordSourceId));
    if (!source) {
      return [];
    }

    return (source.units || []).map((unit) => ({
      sourceId: source.id,
      sourceName: source.name,
      unitId: unit.id,
      unitName: unit.name,
      wordCount: Number(unit.word_count || 0)
    }));
  }

  function updateExtraWordSummary() {
    const summaryTarget = document.getElementById("extraWordSummaryText");
    if (!summaryTarget) return;

    if (!state.catalogSources.length) {
      summaryTarget.textContent = "目前沒有可補字的既有單元。";
      return;
    }

    if (!state.selectedExtraWordSourceId) {
      summaryTarget.textContent = "請先選擇來源與單元。";
      return;
    }

    const visibleUnits = getVisibleExtraWordUnits();
    const selectedUnit = visibleUnits.find((unit) => String(unit.unitId) === String(state.selectedExtraWordUnitId));
    if (!selectedUnit) {
      summaryTarget.textContent = visibleUnits.length ? "請選擇要補字的單元。" : "這個來源目前沒有可選單元。";
      return;
    }

    summaryTarget.textContent = `將把 AI 分析後的單字追加到 ${selectedUnit.sourceName} / ${selectedUnit.unitName}，目前此單元已有 ${selectedUnit.wordCount} 個單字，重複單字會自動略過。`;
  }

  function renderExtraWordFilters() {
    const sourceSelect = document.getElementById("extraWordSourceSelect");
    const unitSelect = document.getElementById("extraWordUnitSelect");
    if (!sourceSelect || !unitSelect) return;

    if (
      state.selectedExtraWordSourceId &&
      !state.catalogSources.some((source) => String(source.id) === String(state.selectedExtraWordSourceId))
    ) {
      state.selectedExtraWordSourceId = "";
    }

    sourceSelect.innerHTML = [
      `<option value="">請先選擇來源</option>`,
      ...state.catalogSources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`)
    ].join("");
    sourceSelect.value = state.selectedExtraWordSourceId ? String(state.selectedExtraWordSourceId) : "";

    const visibleUnits = getVisibleExtraWordUnits();
    if (!visibleUnits.some((unit) => String(unit.unitId) === String(state.selectedExtraWordUnitId))) {
      state.selectedExtraWordUnitId = "";
    }

    unitSelect.innerHTML = visibleUnits.length
      ? [
          `<option value="">請選擇單元</option>`,
          ...visibleUnits.map(
            (unit) => `<option value="${unit.unitId}">${escapeHtml(unit.unitName)} (${unit.wordCount} 單字)</option>`
          )
        ].join("")
      : `<option value="">請先選擇單元</option>`;
    unitSelect.value = state.selectedExtraWordUnitId ? String(state.selectedExtraWordUnitId) : "";

    updateExtraWordSummary();
  }

  function getSelectedRefreshUnitIds() {
    return [...document.querySelectorAll('#libraryRefreshUnitList input[type="checkbox"]:checked')].map((input) => input.value);
  }

  function updateLibraryRefreshSummary() {
    const selectedIds = new Set(getSelectedRefreshUnitIds());
    const visibleUnits = getVisibleRefreshUnits();
    const selectedUnits = visibleUnits.filter((unit) => selectedIds.has(String(unit.unitId)));
    const summaryTarget = document.getElementById("libraryRefreshSummaryText");
    if (!summaryTarget) return;

    if (selectedUnits.length) {
      const totalWords = selectedUnits.reduce((sum, unit) => sum + unit.wordCount, 0);
      summaryTarget.textContent = `已選 ${selectedUnits.length} 個單元，共 ${totalWords} 個單字。`;
      return;
    }

    if (state.selectedRefreshSourceId) {
      const totalWords = visibleUnits.reduce((sum, unit) => sum + unit.wordCount, 0);
      summaryTarget.textContent = `未勾選單元，將重掃此來源下全部 ${visibleUnits.length} 個單元，共 ${totalWords} 個單字。`;
      return;
    }

    summaryTarget.textContent = "未選單元時會重掃全庫。";
  }

  function renderLibraryRefreshFilters() {
    const sourceSelect = document.getElementById("libraryRefreshSourceSelect");
    const unitList = document.getElementById("libraryRefreshUnitList");
    if (!sourceSelect || !unitList) return;

    if (
      state.selectedRefreshSourceId &&
      !state.catalogSources.some((source) => String(source.id) === String(state.selectedRefreshSourceId))
    ) {
      state.selectedRefreshSourceId = "";
    }

    const previousSelected = new Set(getSelectedRefreshUnitIds());
    sourceSelect.innerHTML = [
      `<option value="">全部來源</option>`,
      ...state.catalogSources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`)
    ].join("");
    sourceSelect.value = state.selectedRefreshSourceId ? String(state.selectedRefreshSourceId) : "";

    const visibleUnits = getVisibleRefreshUnits();
    unitList.innerHTML = visibleUnits.length
      ? visibleUnits
          .map(
            (unit) => `
              <label class="unit-pill">
                <input type="checkbox" value="${unit.unitId}" ${previousSelected.has(String(unit.unitId)) ? "checked" : ""} />
                <span>${escapeHtml(unit.sourceName)} / ${escapeHtml(unit.unitName)}</span>
              </label>
            `
          )
          .join("")
      : `<div class="muted small-text">目前沒有可選單元。</div>`;

    updateLibraryRefreshSummary();
  }

  function setUsersVisibility(visible) {
    state.usersVisible = visible;
    document.getElementById("userList").classList.toggle("hidden", !visible);
    document.getElementById("userListHint").classList.toggle("hidden", visible);
    document.getElementById("reloadUsersBtn").classList.toggle("hidden", !visible);
    document.getElementById("toggleUsersBtn").textContent = visible ? "收起帳號" : "載入帳號";
  }

  function themeOptions(selected) {
    return ["sage", "paper", "ocean", "light", "dark"]
      .map((theme) => `<option value="${theme}" ${theme === selected ? "selected" : ""}>${theme}</option>`)
      .join("");
  }

  function buildUserCard(user) {
    return `
      <article class="list-item admin-user-card" data-user-id="${user.id}">
        <div class="word-topline">
          <strong>${escapeHtml(user.displayName || user.username)}</strong>
          <span class="pill">${escapeHtml(user.role)}</span>
        </div>
        <div class="muted small-text">
          帳號：${escapeHtml(user.username)} · 建立：${escapeHtml(formatDateTime(user.createdAt))} · 作答：${Number(user.attempts || 0)}
        </div>
        <div class="admin-user-grid">
          <label>名稱<input data-field="displayName" maxlength="${LIMITS.displayNameMax}" value="${escapeHtml(user.displayName || "")}" /></label>
          <label>
            角色
            <select data-field="role">
              <option value="student" ${user.role === "student" ? "selected" : ""}>student</option>
              <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
            </select>
          </label>
          <label>
            主題
            <select data-field="theme">${themeOptions(user.theme || "sage")}</select>
          </label>
        </div>
        <div class="practice-actions">
          <button type="button" class="save-user-btn">儲存</button>
          <button type="button" class="ghost-btn delete-user-btn">刪除</button>
        </div>
      </article>
    `;
  }

  async function saveUserFromCard(card) {
    const userId = card.dataset.userId;
    const displayName = card.querySelector('[data-field="displayName"]').value.trim();
    const role = card.querySelector('[data-field="role"]').value;
    const theme = card.querySelector('[data-field="theme"]').value;
    await api(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, role, theme })
    });
    showMessage("帳號資料已更新。");
    await loadUsers();
  }

  async function deleteUserFromCard(card) {
    const userId = Number(card.dataset.userId);
    const name = card.querySelector("strong")?.textContent?.trim() || "未命名使用者";
    const users = [...document.querySelectorAll(".admin-user-card")].map((item) => ({
      id: Number(item.dataset.userId),
      role: item.querySelector('[data-field="role"]')?.value || "student"
    }));
    const adminCount = users.filter((item) => item.role === "admin").length;

    if (userId === appState.user?.id) {
      showMessage("不能刪除目前登入中的管理員帳號。");
      return;
    }

    const role = card.querySelector('[data-field="role"]')?.value || "student";
    if (role === "admin" && adminCount <= 1) {
      showMessage("系統至少必須保留一個管理員。");
      return;
    }

    const ok = window.confirm(`確定要刪除 ${name} 嗎？這會移除他的帳號與學習資料。`);
    if (!ok) return;

    await api(`/api/admin/users/${userId}`, { method: "DELETE" });
    showMessage("帳號已刪除。");
    await loadUsers();
  }

  function attachUserCardEvents() {
    document.querySelectorAll(".admin-user-card").forEach((card) => {
      card.querySelector(".save-user-btn")?.addEventListener("click", () => {
        saveUserFromCard(card).catch((error) => showMessage(error.message));
      });
      card.querySelector(".delete-user-btn")?.addEventListener("click", () => {
        deleteUserFromCard(card).catch((error) => showMessage(error.message));
      });
    });
  }

  async function loadUsers() {
    const { users } = await api("/api/admin/users");
    state.usersLoaded = true;
    const target = document.getElementById("userList");
    target.innerHTML = users.length ? users.map(buildUserCard).join("") : `<div class="list-item">目前沒有帳號資料。</div>`;
    attachUserCardEvents();
  }

  async function handleToggleUsers() {
    if (state.usersVisible) {
      setUsersVisibility(false);
      return;
    }

    if (!state.usersLoaded) {
      await loadUsers();
    }

    setUsersVisibility(true);
  }

  function buildRecoveryCard(request) {
    const pending = request.status === "pending";
    return `
      <article class="list-item recovery-card" data-request-id="${request.id}">
        <div class="word-topline">
          <strong>${escapeHtml(request.displayName || request.username)}</strong>
          <span class="pill">${escapeHtml(request.status)}</span>
        </div>
        <div class="muted small-text">
          帳號：${escapeHtml(request.username)} · 申請：${escapeHtml(formatDateTime(request.createdAt))}
          ${request.resolvedAt ? ` · 處理：${escapeHtml(formatDateTime(request.resolvedAt))}` : ""}
        </div>
        <div class="muted small-text">${escapeHtml(request.note || "未填寫備註")}</div>
        ${
          pending
            ? `
              <div class="admin-user-grid">
                <label>臨時密碼<input data-field="temporaryPassword" placeholder="至少 6 碼" maxlength="${LIMITS.passwordMax}" /></label>
              </div>
              <div class="practice-actions">
                <button type="button" class="reset-recovery-btn">重設密碼</button>
                <button type="button" class="delete-recovery-btn secondary-button">刪除申請</button>
              </div>
            `
            : `
              <div class="practice-actions">
                <button type="button" class="delete-recovery-btn secondary-button">刪除紀錄</button>
              </div>
            `
        }
      </article>
    `;
  }

  function attachRecoveryEvents() {
    document.querySelectorAll(".recovery-card .reset-recovery-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest(".recovery-card");
        const requestId = card?.dataset.requestId;
        const temporaryPassword = card?.querySelector('[data-field="temporaryPassword"]')?.value.trim() || "";
        if (!temporaryPassword) {
          showMessage("請先輸入臨時密碼。");
          return;
        }

        const response = await api(`/api/admin/recovery-requests/${requestId}/reset`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ temporaryPassword })
        });
        showMessage(response.message || "已重設密碼。");
        await loadRecoveryRequests();
      });
    });

    document.querySelectorAll(".recovery-card .delete-recovery-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest(".recovery-card");
        const requestId = card?.dataset.requestId;
        if (!requestId) {
          return;
        }

        const requestName = card?.querySelector("strong")?.textContent?.trim() || "這筆救援申請";
        const confirmed = window.confirm(`確定要刪除 ${requestName} 的救援申請嗎？`);
        if (!confirmed) {
          return;
        }

        const response = await api(`/api/admin/recovery-requests/${requestId}`, {
          method: "DELETE"
        });
        showMessage(response.message || "已刪除救援申請。");
        await loadRecoveryRequests();
      });
    });
  }

  async function loadRecoveryRequests() {
    const { requests } = await api("/api/admin/recovery-requests");
    const target = document.getElementById("recoveryList");
    target.innerHTML = requests.length
      ? requests.map(buildRecoveryCard).join("")
      : `<div class="list-item">目前沒有救援申請。</div>`;
    attachRecoveryEvents();
  }

  async function pollDraftJob(jobId) {
    if (jobId !== state.activeJobId) {
      return;
    }

    const job = await api(`/api/import/image-draft-jobs/${jobId}`);
    if (jobId !== state.activeJobId) {
      return;
    }

    renderJobProgress(job);

    if (job.status === "completed") {
      state.draft = {
        jobId: job.jobId,
        operation: job.operation || "import",
        phase: job.phase || "analyze",
        items: job.items || []
      };
      renderDraftPanel();
      document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      showMessage("草稿已完成，請開始核對。");
      return;
    }

    if (job.status === "failed") {
      showMessage(job.error || job.message || "草稿任務失敗。");
      return;
    }

    clearPollTimer();
    state.pollTimer = window.setTimeout(() => {
      pollDraftJob(jobId).catch((error) => showMessage(error.message));
    }, 900);
  }

  async function submitImageDraft(formData) {
    state.creatingLongTask = true;
    const response = await api("/api/import/image-draft-jobs", {
      method: "POST",
      body: formData
    });

    clearDraft();
    state.activeJobId = response.jobId;
    state.activeJobStatus = "queued";
    document.getElementById("imageDraftPanel").classList.remove("hidden");
    renderJobProgress({
      status: "queued",
      progress: 1,
      message: response.message || "圖片草稿任務已送出。",
      logs: ["[01%] 已送出圖片草稿任務，等待後端處理..."]
    });
    document.getElementById("draftSummaryText").textContent = "圖片草稿分析進行中。";
    document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    await pollDraftJob(response.jobId);
  }

  async function submitTextDraft() {
    const batches = readTextDraftBatchesFromDom()
      .map((batch) => ({
        ...batch,
        words: parseWordListText(batch.wordsText)
      }))
      .filter((batch) => batch.sourceName || batch.unitName || batch.words.length);

    if (!batches.length) {
      throw new Error("至少新增一批來源、單元與英文列表。");
    }

    const invalidBatch = batches.find((batch) => !batch.sourceName || !batch.unitName || !batch.words.length);
    if (invalidBatch) {
      throw new Error("每一批都必須填寫來源、單元與英文列表。");
    }

    state.textDraftBatches = readTextDraftBatchesFromDom();
    const response = await api("/api/import/text-draft-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: batches.map((batch) => ({
          sourceName: batch.sourceName,
          unitName: batch.unitName,
          words: batch.words
        }))
      })
    });

    clearDraft();
    state.activeJobId = response.jobId;
    state.activeJobStatus = "queued";
    document.getElementById("imageDraftPanel").classList.remove("hidden");
    renderJobProgress({
      status: "queued",
      progress: 1,
      message: response.message || "英文列表任務已送出。",
      logs: ["[01%] 已送出英文列表任務，等待後端處理..."]
    });
    document.getElementById("draftSummaryText").textContent = "英文列表分析進行中。";
    document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    await pollDraftJob(response.jobId);
  }

  async function submitExtraWordDraft() {
    const unitId = Number(document.getElementById("extraWordUnitSelect")?.value || 0) || null;
    const words = parseWordListText(document.getElementById("extraWordList")?.value || "");

    if (!state.selectedExtraWordSourceId || !unitId) {
      throw new Error("請先選擇來源與單元。");
    }

    if (!words.length) {
      throw new Error("請至少輸入一個要補上的英文單字。");
    }

    const response = await api("/api/import/text-draft-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "append",
        items: [
          {
            unitId,
            words
          }
        ]
      })
    });

    document.getElementById("extraWordList").value = "";
    clearDraft();
    state.activeJobId = response.jobId;
    state.activeJobStatus = "queued";
    document.getElementById("imageDraftPanel").classList.remove("hidden");
    renderJobProgress({
      status: "queued",
      progress: 1,
      message: response.message || "補字任務已送出。",
      logs: ["[01%] 已送出補字 AI 草稿任務，等待後端處理..."]
    });
    document.getElementById("draftSummaryText").textContent = "單字庫補字分析進行中。";
    document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    await pollDraftJob(response.jobId);
  }

  async function submitLibraryRefreshJob() {
    state.creatingLongTask = true;
    const unitIds = getSelectedRefreshUnitIds();
    const response = await api("/api/import/library-refresh-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: state.selectedRefreshSourceId || null,
        unitIds
      })
    });

    clearDraft();
    state.activeJobId = response.jobId;
    state.activeJobStatus = "queued";
    document.getElementById("imageDraftPanel").classList.remove("hidden");
    renderJobProgress({
      status: "queued",
      progress: 1,
      message: response.message || "全庫重掃任務已送出。",
      logs: ["[01%] 已送出全庫重掃任務，等待後端處理..."]
    });
    document.getElementById("draftSummaryText").textContent = "全庫重掃進行中。";
    document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    await pollDraftJob(response.jobId);
  }

  async function saveReviewedDraft() {
    if (!state.draft) {
      showMessage("目前沒有待核對草稿。");
      return;
    }

    if (state.draft.phase === "ocr-review") {
      const batches = readDraftRowsFromDom().filter((batch) =>
        document
          .querySelector(`.draft-batch-card[data-item-id="${batch.itemId}"] [data-batch-field="ocrText"]`)
      );
      if (!batches.length) {
        showMessage("目前沒有可送交 AI 的 OCR 草稿。");
        return;
      }
      const invalidBatch = batches.find((batch) => !batch.ocrText.trim());
      if (invalidBatch) {
        showMessage(`${invalidBatch.fileName} 的 OCR 內容不可為空。`);
        return;
      }

      const response = await api(`/api/import/image-draft-jobs/${state.draft.jobId}/continue-ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: batches.map((batch) => ({
            itemId: batch.itemId,
            sourceName: batch.sourceName,
            unitName: batch.unitName,
            ocrText: batch.ocrText
          }))
        })
      });

      clearDraft();
      state.activeJobId = response.jobId;
      state.activeJobStatus = "queued";
      document.getElementById("imageDraftPanel").classList.remove("hidden");
      renderJobProgress({
        status: "queued",
        progress: 1,
        phase: "ai-from-ocr",
        message: response.message || "已送交 AI 生成草稿。",
        logs: ["[01%] 已送交人工核對後的 OCR 內容，等待 AI 分析..."]
      });
      document.getElementById("draftSummaryText").textContent = "人工核對 OCR 已送交 AI。";
      document.getElementById("imageDraftPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      await pollDraftJob(response.jobId);
      return;
    }

    const batches = readDraftRowsFromDom()
      .map((batch) => ({
        ...batch,
        rows: batch.rows.filter((row) => row.eng)
      }))
      .filter((batch) => batch.rows.length);

    if (!batches.length) {
      showMessage("至少保留一筆單字後再儲存。");
      return;
    }

    let importedTotal = 0;
    let skippedDuplicateTotal = 0;
    const errors = [];

    for (const batch of batches) {
      if (!batch.sourceName || !batch.unitName) {
        errors.push(`${batch.fileName} 缺少來源或單元。`);
        continue;
      }

      try {
        const endpoint =
          state.draft.operation === "refresh"
            ? "/api/import/reviewed-words-refresh"
            : state.draft.operation === "append"
              ? "/api/import/reviewed-words-append"
              : "/api/import/reviewed-words";
        const response = await api(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: state.draft.jobId,
            unitId: batch.unitId,
            sourceName: batch.sourceName,
            unitName: batch.unitName,
            fileName: batch.fileName,
            rows: batch.rows
          })
        });
        importedTotal += Number(response.importedCount || 0);
        skippedDuplicateTotal += Number(response.skippedDuplicateCount || 0);
      } catch (error) {
        errors.push(`${batch.fileName}：${error.message}`);
      }
    }

    await loadCatalog();
    if (errors.length) {
      showMessage(`已處理 ${importedTotal} 筆，仍有 ${errors.length} 批失敗。`);
      return;
    }

    if (state.draft?.jobId) {
      await api(`/api/import/image-draft-jobs/${state.draft.jobId}/dismiss`, {
        method: "POST"
      });
    }
    clearDraft();
    const duplicateHint = skippedDuplicateTotal ? `，略過 ${skippedDuplicateTotal} 筆重複` : "";
    showMessage(`已完成 ${importedTotal} 筆${duplicateHint}。`);
  }

  async function dismissCurrentDraft() {
    const jobId = state.activeJobId || state.draft?.jobId;
    if (!jobId) {
      clearDraft();
      return;
    }

    await api(`/api/import/image-draft-jobs/${jobId}/dismiss`, {
      method: "POST"
    });
    clearDraft();
    showMessage("草稿任務已清除。");
  }

  async function resumeCurrentJob() {
    const response = await api("/api/import/image-draft-jobs-current");
    const job = response.job;

    if (!job) {
      clearDraft();
      return;
    }

    state.activeJobId = job.jobId;
    state.activeJobStatus = job.status || "";
    renderJobProgress(job);

    if (job.status === "completed" && job.reviewPending) {
      state.draft = {
        jobId: job.jobId,
        operation: job.operation || "import",
        phase: job.phase || "analyze",
        items: job.items || []
      };
      renderDraftPanel();
      return;
    }

    if (job.status === "queued" || job.status === "running") {
      await pollDraftJob(job.jobId);
      return;
    }

    if (job.status === "failed") {
      showMessage(job.error || job.message || "草稿任務失敗。");
    }
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    applyStaticLimits();
    setUsersVisibility(false);
    await resumeCurrentJob();

    document.getElementById("imageDraftForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (state.creatingLongTask || state.activeJobStatus === "queued" || state.activeJobStatus === "running") {
        showMessage("目前已有進行中的草稿任務。");
        return;
      }
      const formData = new FormData(form);
      const files = formData.getAll("images").filter((file) => file && typeof file === "object" && file.size > 0);
      if (!files.length) {
        showMessage("請至少上傳一張圖片。");
        return;
      }
      state.creatingLongTask = true;
      setLongTaskBusy(true);

      try {
        await submitImageDraft(formData);
      } catch (error) {
        showMessage(error.message || "圖片草稿分析失敗。");
        await resumeCurrentJob().catch(() => {});
      } finally {
        state.creatingLongTask = false;
        if (!state.activeJobStatus && !state.draft) {
          setLongTaskBusy(false);
        }
      }
    });

    document.getElementById("addTextDraftBatchBtn").addEventListener("click", () => {
      state.textDraftBatches = readTextDraftBatchesFromDom();
      state.textDraftBatches.push(createTextDraftBatch());
      renderTextDraftBatches();
    });

    document.getElementById("textDraftForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.creatingLongTask || state.activeJobStatus === "queued" || state.activeJobStatus === "running") {
        showMessage("目前已有進行中的草稿任務。");
        return;
      }
      state.creatingLongTask = true;
      setLongTaskBusy(true);

      try {
        await submitTextDraft();
      } catch (error) {
        showMessage(error.message || "英文列表分析失敗。");
        await resumeCurrentJob().catch(() => {});
      } finally {
        state.creatingLongTask = false;
        if (!state.activeJobStatus && !state.draft) {
          setLongTaskBusy(false);
        }
      }
    });

    document.getElementById("libraryRefreshForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.creatingLongTask || state.activeJobStatus === "queued" || state.activeJobStatus === "running") {
        showMessage("目前已有進行中的草稿任務。");
        return;
      }
      state.creatingLongTask = true;
      setLongTaskBusy(true);

      try {
        await submitLibraryRefreshJob();
      } catch (error) {
        showMessage(error.message || "全庫重掃失敗。");
        await resumeCurrentJob().catch(() => {});
      } finally {
        state.creatingLongTask = false;
        if (!state.activeJobStatus && !state.draft) {
          setLongTaskBusy(false);
        }
      }
    });

    document.getElementById("extraWordForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.creatingLongTask || state.activeJobStatus === "queued" || state.activeJobStatus === "running") {
        showMessage("目前已有進行中的草稿任務。");
        return;
      }
      state.creatingLongTask = true;
      setLongTaskBusy(true);

      try {
        await submitExtraWordDraft();
      } catch (error) {
        showMessage(error.message || "補字分析失敗。");
        await resumeCurrentJob().catch(() => {});
      } finally {
        state.creatingLongTask = false;
        if (!state.activeJobStatus && !state.draft) {
          setLongTaskBusy(false);
        }
      }
    });

    document.getElementById("notificationForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await submitNotification(event.currentTarget);
      } catch (error) {
        showMessage(error.message);
      }
    });

    document.getElementById("saveDraftBtn").addEventListener("click", () => {
      saveReviewedDraft().catch((error) => showMessage(error.message));
    });
    document.getElementById("clearDraftBtn").addEventListener("click", () => {
      dismissCurrentDraft().catch((error) => showMessage(error.message));
    });
    document.getElementById("reloadActivityBtn").addEventListener("click", () => {
      loadActivity().catch((error) => showMessage(error.message));
    });
    document.getElementById("reloadServerLogsBtn").addEventListener("click", () => {
      loadServerLogs().catch((error) => showMessage(error.message));
    });
    document.getElementById("reloadVisitActivityBtn").addEventListener("click", () => {
      loadVisitActivity().catch((error) => showMessage(error.message));
    });
    document.getElementById("activityUserSelect").addEventListener("change", (event) => {
      state.selectedActivityUserId = event.target.value;
      loadActivityTrend(event.target.value).catch((error) => showMessage(error.message));
    });
    document.getElementById("libraryRefreshSourceSelect").addEventListener("change", (event) => {
      state.selectedRefreshSourceId = event.target.value;
      renderLibraryRefreshFilters();
    });
    document.getElementById("extraWordSourceSelect").addEventListener("change", (event) => {
      state.selectedExtraWordSourceId = event.target.value;
      state.selectedExtraWordUnitId = "";
      renderExtraWordFilters();
    });
    document.getElementById("extraWordUnitSelect").addEventListener("change", (event) => {
      state.selectedExtraWordUnitId = event.target.value;
      updateExtraWordSummary();
    });
    document.getElementById("libraryRefreshUnitList").addEventListener("change", () => {
      updateLibraryRefreshSummary();
    });
    document.getElementById("reloadCatalogBtn").addEventListener("click", () => {
      loadCatalog().catch((error) => showMessage(error.message));
    });
    document.getElementById("saveExamMeaningBtn").addEventListener("click", () => {
      saveExamMeaningSelections().catch((error) => showMessage(error.message));
    });
    document.getElementById("closeExamMeaningBtn").addEventListener("click", closeExamMeaningPanel);
    document.getElementById("toggleUsersBtn").addEventListener("click", () => {
      handleToggleUsers().catch((error) => showMessage(error.message));
    });
    document.getElementById("reloadUsersBtn").addEventListener("click", () => {
      loadUsers().catch((error) => showMessage(error.message));
    });
    document.getElementById("reloadRecoveryBtn").addEventListener("click", () => {
      loadRecoveryRequests().catch((error) => showMessage(error.message));
    });

    renderTextDraftBatches();
    renderExamMeaningPanel();
    await loadNotificationRecipients();
    await loadActivity();
    await loadServerLogs();
    await loadVisitActivity();
    await loadCatalog();
    await loadRecoveryRequests();
  }

  return { init };
})();

AdminPage.init().catch((error) => window.WordsApp.showMessage(error.message));

