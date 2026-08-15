const OverviewPage = (() => {
  const { api, showMessage, refreshUser, enforcePageAccess, tts, state: appState } = window.WordsApp;

  const state = {
    sources: [],
    words: [],
    groupedWords: [],
    totalGroups: 0,
    loadedStartOffset: 0,
    offset: 0,
    pageSize: 36,
    hasMore: true,
    loading: false,
    observer: null,
    activeWordId: null,
    activeVariantIndex: 0,
    focusOpen: false,
    focusShouldScroll: false,
    lastCardElementId: null,
    listViewMode: "detailed",
    speakingTimer: null,
    pendingWordRef: new URLSearchParams(window.location.search).get("wordRef") || "",
    pendingWordRefFromRestore: false,
    restoreSnapshot: null,
    persistTimer: 0,
    persistenceSuspended: false
  };
  const OVERVIEW_STATE_PREFIX = "wordsKingOverviewState";

  function getOverviewStateKey() {
    const userKey = appState.user?.id || appState.user?.username || "guest";
    return `${OVERVIEW_STATE_PREFIX}:${userKey}`;
  }

  function normalizeListViewMode(mode) {
    return mode === "compact" ? "compact" : "detailed";
  }

  function readSavedOverviewState() {
    const raw = localStorage.getItem(getOverviewStateKey());
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      localStorage.removeItem(getOverviewStateKey());
      return null;
    }
  }

  function getCurrentScrollY() {
    return Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function cancelSpeech() {
    tts.cancel();
  }

  function speakWord(word) {
    cancelSpeech();
    if (!word?.eng) {
      return;
    }

    if (!tts.isSupported()) {
      showMessage("此裝置不支援語音播放。");
      return;
    }

    tts.speak(word.eng, { delay: 0 });
  }

  function parseExamples(example) {
    if (!example) {
      return [];
    }

    if (Array.isArray(example)) {
      return example.filter((item) => item && (item.eng || item.ch));
    }

    if (typeof example !== "string") {
      return [];
    }

    try {
      const parsed = JSON.parse(example);
      return Array.isArray(parsed) ? parsed.filter((item) => item && (item.eng || item.ch)) : [];
    } catch {
      const matches = Array.from(
        example.matchAll(/\{\s*['"]eng['"]\s*:\s*['"]([^'"]*)['"]\s*,\s*['"]ch['"]\s*:\s*['"]([^'"]*)['"]\s*\}/g)
      );
      return matches.map((match) => ({
        eng: match[1] || "",
        ch: match[2] || ""
      }));
    }
  }

  function cleanMeaningEntry(input) {
    return String(input || "")
      .replace(/^\s*[\[\]'"]+/, "")
      .replace(/[\[\]'"]+\s*$/g, "")
      .replace(/^[\u2460-\u2473]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/[\uFF1B;\u3002]+$/g, "")
      .trim();
  }

  function splitMeaningFragments(input) {
    return String(input || "")
      .split(/\n+|[\uFF1B;\u3002]/)
      .map((item) => cleanMeaningEntry(item))
      .filter(Boolean);
  }

  function parseMeaningEntries(value) {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return [
        ...new Set(
          value.flatMap((item) => (Array.isArray(item) ? parseMeaningEntries(item) : splitMeaningFragments(item)))
        )
      ];
    }

    if (typeof value !== "string") {
      return [];
    }

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parseMeaningEntries(parsed);
      }
    } catch {}

    try {
      const normalized = value.replace(/'/g, '"');
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parseMeaningEntries(parsed);
      }
    } catch {}

    const quotedMatches = Array.from(value.matchAll(/["']([^"'\r\n]+)["']/g))
      .flatMap((match) => splitMeaningFragments(match[1]))
      .filter(Boolean);
    if (quotedMatches.length) {
      return [...new Set(quotedMatches)];
    }

    if (/[\u2460-\u2473]/.test(value)) {
      return [
        ...new Set(
          value
            .split(/(?=[\u2460-\u2473])/)
            .flatMap((item) => splitMeaningFragments(item))
            .filter(Boolean)
        )
      ];
    }

    return [...new Set(splitMeaningFragments(value))];
  }

  function buildMeaningMarker(index) {
    return index < 20 ? String.fromCharCode(9312 + index) : `${index + 1}.`;
  }

  function renderMeaningList(value, options = {}) {
    const baseEntries = Array.isArray(value) ? value : parseMeaningEntries(value);
    const className = options.className || "meaning-list";
    const highlightTexts = new Set(
      (options.highlightTexts || []).map((item) => String(item || "").trim()).filter(Boolean)
    );
    const entries = options.ensureHighlightsVisible
      ? [...new Set([...baseEntries, ...[...highlightTexts].filter((item) => !baseEntries.includes(item))])]
      : baseEntries;

    if (!entries.length) {
      return `<div class="${className}"><div class="meaning-item"><span class="meaning-text">未提供</span></div></div>`;
    }

    const maxItems = options.maxItems || entries.length;
    const visibleEntries = entries.slice(0, maxItems);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

    return `
      <div class="${className} ${options.compact ? "compact" : ""}">
        ${visibleEntries
          .map(
            (entry, index) => `
              <div class="meaning-item ${highlightTexts.has(String(entry).trim()) ? "exam-highlight" : ""}">
                <span class="meaning-index">${buildMeaningMarker(index)}</span>
                <span class="meaning-text">${escapeHtml(entry)}</span>
              </div>
            `
          )
          .join("")}
        ${hiddenCount ? `<div class="meaning-more">還有 ${hiddenCount} 項</div>` : ""}
      </div>
    `;
  }

  function buildGroupKey(word) {
    return String(word.eng || "").trim().toLowerCase();
  }

  function buildVariantKey(word) {
    return String(word.tense || "").trim().toLowerCase();
  }

  function mergeVariantWord(baseWord, incomingWord) {
    const sourceNames = new Set([...(baseWord.sourceNames || []), incomingWord.source_name].filter(Boolean));
    const unitNames = new Set([...(baseWord.unitNames || []), incomingWord.unit_name].filter(Boolean));
    const sourceUnitPairs = new Set([
      ...(baseWord.sourceUnitPairs || []),
      [incomingWord.source_name, incomingWord.unit_name].filter(Boolean).join(" / ")
    ].filter(Boolean));
    const wordRefs = new Set([...(baseWord.wordRefs || []), incomingWord.wordRef].filter(Boolean));
    const examMeaningIndexes = new Set([
      ...(baseWord.examMeaningIndexes || []),
      ...(incomingWord.examMeaningIndexes || [])
    ]);
    const examMeaningTexts = new Set([
      ...(baseWord.examMeaningTexts || []),
      ...(incomingWord.examMeaningTexts || [])
    ]);

    return {
      ...baseWord,
      kk: baseWord.kk || incomingWord.kk,
      ch: baseWord.ch || incomingWord.ch,
      chEntries: (baseWord.chEntries && baseWord.chEntries.length ? baseWord.chEntries : incomingWord.chEntries) || [],
      analysis: baseWord.analysis || incomingWord.analysis,
      definition: baseWord.definition || incomingWord.definition,
      example: baseWord.example || incomingWord.example,
      sourceNames: [...sourceNames],
      unitNames: [...unitNames],
      sourceUnitPairs: [...sourceUnitPairs],
      wordRefs: [...wordRefs],
      examMeaningIndexes: [...examMeaningIndexes],
      examMeaningTexts: [...examMeaningTexts]
    };
  }

  function groupWords(words) {
    const map = new Map();
    const grouped = [];

    words.forEach((word) => {
      const groupKey = buildGroupKey(word);
      if (!groupKey) return;

      if (!map.has(groupKey)) {
        const group = {
          id: word.id,
          groupKey,
          eng: word.eng,
          variants: []
        };
        map.set(groupKey, group);
        grouped.push(group);
      }

      const group = map.get(groupKey);
      const variantKey = buildVariantKey(word);
      const existingVariantIndex = group.variants.findIndex((item) => buildVariantKey(item) === variantKey);

      if (existingVariantIndex === -1) {
        group.variants.push({
          ...word,
          chEntries: Array.isArray(word.chEntries) ? word.chEntries : parseMeaningEntries(word.ch),
          examMeaningIndexes: Array.isArray(word.examMeaningIndexes) ? word.examMeaningIndexes : [],
          examMeaningTexts: Array.isArray(word.examMeaningTexts) ? word.examMeaningTexts : [],
          sourceNames: [word.source_name].filter(Boolean),
          unitNames: [word.unit_name].filter(Boolean),
          sourceUnitPairs: [[word.source_name, word.unit_name].filter(Boolean).join(" / ")].filter(Boolean),
          wordRefs: [word.wordRef].filter(Boolean)
        });
      } else {
        group.variants[existingVariantIndex] = mergeVariantWord(group.variants[existingVariantIndex], word);
      }
    });

    return grouped;
  }

  function getActiveGroup() {
    return state.groupedWords.find((item) => item.id === state.activeWordId) || null;
  }

  function getActiveVariant(group = getActiveGroup()) {
    if (!group?.variants?.length) {
      return null;
    }

    const clampedIndex = Math.min(Math.max(state.activeVariantIndex, 0), group.variants.length - 1);
    return group.variants[clampedIndex];
  }

  function getActiveWordRef() {
    const word = getActiveVariant();
    if (!word) {
      return "";
    }

    return String(word.wordRef || word.wordRefs?.[0] || "").trim();
  }

  function buildOverviewStateSnapshot() {
    const query = currentQueryParams();
    return {
      sourceId: query.sourceId || "",
      unitId: query.unitId || "",
      unitIds: query.unitIds || [],
      orderMode: query.orderMode || "unit",
      listViewMode: state.listViewMode,
      search: query.search || "",
      activeWordRef: getActiveWordRef(),
      activeVariantIndex: Number(state.activeVariantIndex || 0),
      focusOpen: Boolean(state.focusOpen && state.activeWordId),
      scrollY: getCurrentScrollY()
    };
  }

  function saveOverviewState() {
    if (!appState.user || state.persistenceSuspended) {
      return;
    }

    localStorage.setItem(getOverviewStateKey(), JSON.stringify(buildOverviewStateSnapshot()));
  }

  function queueSaveOverviewState() {
    if (state.persistenceSuspended) {
      return;
    }

    window.clearTimeout(state.persistTimer);
    state.persistTimer = window.setTimeout(saveOverviewState, 100);
  }

  function saveOverviewStateNow() {
    if (state.persistenceSuspended) {
      return;
    }

    window.clearTimeout(state.persistTimer);
    saveOverviewState();
  }

  function applySavedOverviewFilters(snapshot) {
    if (!snapshot) {
      return;
    }

    const sourceFilter = document.getElementById("sourceFilter");
    const unitFilter = getUnitFilterElement();
    const searchInput = document.getElementById("searchInput");

    if (sourceFilter && snapshot.sourceId) {
      sourceFilter.value = String(snapshot.sourceId);
      renderUnitOptions(sourceFilter.value);
    }

    if (unitFilter) {
      setSelectedUnitIds(readSnapshotUnitIds(snapshot));
    }

    if (searchInput && typeof snapshot.search === "string") {
      searchInput.value = snapshot.search;
    }

    setWordOrderMode(snapshot.orderMode || "unit");
    state.listViewMode = normalizeListViewMode(snapshot.listViewMode);
  }

  function restoreOverviewViewport(snapshot) {
    if (!snapshot || !Number.isFinite(Number(snapshot.scrollY))) {
      return;
    }

    const targetY = Math.max(0, Number(snapshot.scrollY) || 0);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: targetY, behavior: "auto" });
      });
    });
  }

  function renderSourceOptions() {
    document.getElementById("sourceFilter").innerHTML =
      '<option value="">全部來源</option>' +
      state.sources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`).join("");
  }

  function getUnitFilterElement() {
    const target = document.getElementById("unitFilter");
    if (!target) {
      return null;
    }

    if (target.tagName === "SELECT") {
      const replacement = document.createElement("div");
      replacement.id = "unitFilter";
      replacement.className = "unit-filter-pills";
      replacement.setAttribute("role", "group");
      replacement.setAttribute("aria-label", target.getAttribute("aria-label") || "單元篩選");
      target.replaceWith(replacement);
      return replacement;
    }

    target.classList.add("unit-filter-pills");
    if (!target.getAttribute("role")) {
      target.setAttribute("role", "group");
    }
    if (!target.getAttribute("aria-label")) {
      target.setAttribute("aria-label", "單元篩選");
    }
    return target;
  }

  function readSnapshotUnitIds(snapshot) {
    if (!snapshot) {
      return [];
    }

    const rawUnitIds = Array.isArray(snapshot.unitIds) ? snapshot.unitIds : [snapshot.unitId].filter(Boolean);
    return [
      ...new Set(
        rawUnitIds
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      )
    ];
  }

  function getSelectedUnitIds() {
    const unitFilter = getUnitFilterElement();
    if (!unitFilter) {
      return [];
    }

    return Array.from(unitFilter.querySelectorAll('input[name="unitIds"]:checked'))
      .map((item) => Number(item.value))
      .filter((item) => Number.isInteger(item) && item > 0);
  }

  function setSelectedUnitIds(unitIds = []) {
    const unitFilter = getUnitFilterElement();
    if (!unitFilter) {
      return;
    }

    const selected = new Set((unitIds || []).map((item) => String(item)));
    unitFilter.querySelectorAll('input[name="unitIds"]').forEach((input) => {
      input.checked = selected.has(String(input.value));
    });
    syncUnitFilterClearState();
  }

  function syncUnitFilterClearState() {
    const clearButton = getUnitFilterElement()?.querySelector("[data-clear-unit-filter]");
    if (clearButton) {
      clearButton.classList.toggle("active", getSelectedUnitIds().length === 0);
    }

    const selectedCount = getSelectedUnitIds().length;
    const summary = document.getElementById("unitFilterSummary");
    if (summary) {
      summary.textContent = selectedCount ? `已選 ${selectedCount} 個單元` : "全部單元";
    }
  }

  function normalizeWordOrderMode(mode) {
    return mode === "alpha" ? "alpha" : "unit";
  }

  function getWordOrderMode() {
    const activeButton = document.querySelector("#wordOrderMode [data-word-order].is-active");
    return normalizeWordOrderMode(activeButton?.dataset.wordOrder);
  }

  function setWordOrderMode(mode) {
    const normalizedMode = normalizeWordOrderMode(mode);
    document.querySelectorAll("#wordOrderMode [data-word-order]").forEach((button) => {
      const isActive = button.dataset.wordOrder === normalizedMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function renderUnitOptions(sourceId, selectedUnitIds = getSelectedUnitIds()) {
    const unitFilter = getUnitFilterElement();
    if (!unitFilter) {
      return;
    }

    const source = state.sources.find((item) => String(item.id) === String(sourceId));
    const units = source ? source.units : state.sources.flatMap((item) => item.units);
    const selected = new Set((selectedUnitIds || []).map((item) => String(item)));
    unitFilter.innerHTML =
      `<label class="unit-filter-search">
        <span>搜尋單元</span>
        <input type="search" data-unit-filter-search placeholder="輸入單元名稱" autocomplete="off" />
      </label>` +
      `<button type="button" class="unit-filter-clear ${selected.size ? "" : "active"}" data-clear-unit-filter>全部單元</button>` +
      units
        .map(
          (unit) => `
            <label class="unit-filter-pill">
              <input type="checkbox" name="unitIds" value="${unit.id}" ${selected.has(String(unit.id)) ? "checked" : ""} />
              <span>${escapeHtml(unit.name)}</span>
            </label>
          `
        )
        .join("");
    syncUnitFilterClearState();
  }

  function renderOverviewStats(totals) {
    document.getElementById("overviewStats").innerHTML = `
      <div class="stat"><span>來源數</span><strong>${totals.source_count || 0}</strong></div>
      <div class="stat"><span>單元數</span><strong>${totals.unit_count || 0}</strong></div>
      <div class="stat"><span>單字總數</span><strong>${totals.word_count || 0}</strong></div>
    `;
  }

  function currentQueryParams() {
    const unitIds = getSelectedUnitIds();
    return {
      sourceId: document.getElementById("sourceFilter").value,
      unitId: unitIds[0] ? String(unitIds[0]) : "",
      unitIds,
      orderMode: getWordOrderMode(),
      search: document.getElementById("searchInput").value.trim()
    };
  }

  function appendCurrentQueryParams(params) {
    const query = currentQueryParams();
    if (query.sourceId) params.set("sourceId", query.sourceId);
    if (query.unitIds?.length) params.set("unitIds", query.unitIds.join(","));
    params.set("order", query.orderMode || "unit");
    if (query.search) params.set("search", query.search);
    return query;
  }

  function clearPendingWordRefFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("wordRef");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function setWordListStatus(message) {
    const target = document.getElementById("loadMoreHint");
    if (target) {
      target.textContent = message || "";
    }
  }

  function renderWordListStatus() {
    if (state.totalGroups === 0) {
      setWordListStatus("沒有符合條件的單字。");
    } else if (state.hasMore) {
      setWordListStatus(`已載入 ${state.groupedWords.length} / ${state.totalGroups} 個單字，向下滑動可繼續載入。`);
    } else {
      setWordListStatus(`已載入全部 ${state.groupedWords.length} 個單字。`);
    }
  }

  function resetFocusState() {
    cancelSpeech();
    state.activeWordId = null;
    state.activeVariantIndex = 0;
    document.getElementById("focusPanel").classList.add("hidden");
    document.getElementById("focusDetail").innerHTML = "";
  }

  function replaceLoadedWords(rows) {
    state.words = [];
    state.groupedWords = [];
    appendWords(rows || []);
  }

  function renderWordCard(group) {
    const word = group.variants[0];
    const sourceText = (word.sourceUnitPairs || []).join(" · ");

    return `
      <article id="word-card-${group.id}" class="word-preview-card ${state.activeWordId === group.id ? "active" : ""}" data-word-id="${group.id}">
        <h3>
          ${escapeHtml(group.eng)}
          <span>${escapeHtml(word.kk || "未提供 KK")}</span>
        </h3>
        <p class="small-text muted">${escapeHtml(sourceText || "未提供來源")}</p>
        ${renderMeaningList(word.chEntries || word.ch, { className: "meaning-list compact", maxItems: 3 })}
        ${group.variants.length > 1 ? `<p class="small-text muted">${group.variants.length} 個詞性版本</p>` : ""}
      </article>
    `;
  }

  function renderCompactWordCard(group) {
    return `
      <article
        id="word-card-${group.id}"
        class="word-preview-card word-preview-card-compact ${state.activeWordId === group.id ? "active" : ""}"
        data-word-id="${group.id}"
        role="button"
        tabindex="0"
        aria-label="開啟 ${escapeHtml(group.eng)} 的單字詳情"
      >
        <h3>${escapeHtml(group.eng)}</h3>
      </article>
    `;
  }

  function renderWordGrid() {
    const grid = document.getElementById("wordGrid");
    grid.innerHTML = state.groupedWords
      .map((group) => (state.listViewMode === "compact" ? renderCompactWordCard(group) : renderWordCard(group)))
      .join("");

    grid.querySelectorAll("[data-word-id]").forEach((card) => {
      const openCard = () => {
        const wordId = Number(card.dataset.wordId);
        openFocusByGroupId(wordId);
      };
      card.addEventListener("click", openCard);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCard();
        }
      });
    });

    syncFocusFollowDock();
    window.WordsApp.tutorial?.refresh?.();
  }

  function getGroupPronunciationWord(group) {
    return String(group?.eng || group?.variants?.[0]?.eng || "").trim();
  }

  function preloadPronunciationsAroundFocus() {
    if (typeof tts.preloadWords !== "function" || !state.groupedWords.length) {
      return;
    }

    const activeIndex = findGroupIndexById(state.activeWordId);
    const startIndex = activeIndex >= 0 ? activeIndex + 1 : 0;
    const endIndex = activeIndex >= 0 ? activeIndex + 4 : 3;
    const words = state.groupedWords.slice(startIndex, endIndex).map(getGroupPronunciationWord).filter(Boolean);
    tts.preloadWords(words, {
      max: 3,
      delay: activeIndex >= 0 ? 180 : 700
    });
  }

  function renderVariantTabs(group) {
    if (!group || group.variants.length <= 1) {
      return "";
    }

    return `
      <div class="detail-actions">
        ${group.variants
          .map(
            (variant, index) => `
              <button
                type="button"
                class="ghost-btn ${index === state.activeVariantIndex ? "active" : ""}"
                data-variant-index="${index}"
              >
                ${escapeHtml(variant.tense || `版本 ${index + 1}`)}
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderExamples(example) {
    const examples = parseExamples(example);
    if (!examples.length) {
      return '<div class="detail-value">未提供例句</div>';
    }

    return `
      <div class="detail-value">
        ${examples
          .map(
            (item) => `
              <div class="meaning-item">
                <span class="meaning-text">${escapeHtml(item.eng || "")}</span>
              </div>
              <div class="small-text muted">${escapeHtml(item.ch || "")}</div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderFocusDetail() {
    const group = getActiveGroup();
    const word = getActiveVariant(group);
    const detail = document.getElementById("focusDetail");
    const panel = document.getElementById("focusPanel");

    if (!group || !word) {
      panel.classList.add("hidden");
      detail.innerHTML = "";
      return;
    }

    panel.classList.remove("hidden");
    const sourceSummary = [...new Set([...(word.sourceNames || []), ...(word.unitNames || [])].filter(Boolean))].join(" / ");
    const examHighlightTexts = Array.isArray(word.examMeaningTexts) ? word.examMeaningTexts : [];
    const detailModeSection = `
        <section class="detail-section">
          <span class="detail-label">分析</span>
          <div class="detail-value">${escapeHtml(word.analysis || "未提供")}</div>
        </section>
      `;

    detail.innerHTML = `
      <div class="word-detail-card">
        <div class="section-title-row">
          <div>
            <h2>${escapeHtml(group.eng)}</h2>
            <p class="small-text muted">${escapeHtml(sourceSummary || "未提供來源")}</p>
          </div>
          <button type="button" id="speakWordBtn" class="ghost-btn">播放單字</button>
        </div>
        ${renderVariantTabs(group)}
        <section class="detail-section">
          <span class="detail-label">詞性 / KK</span>
          <div class="detail-value">${escapeHtml(word.tense || "未提供詞性")} / ${escapeHtml(word.kk || "未提供")}</div>
        </section>
        <section class="detail-section">
          <span class="detail-label">中文解釋</span>
          ${renderMeaningList(word.chEntries || word.ch, {
            className: "meaning-list",
            highlightTexts: examHighlightTexts,
            ensureHighlightsVisible: true
          })}
          ${examHighlightTexts.length ? '<p class="small-text muted exam-highlight-hint">螢光底表示已標記的考試字義。</p>' : ""}
        </section>
        <section class="detail-section">
          <span class="detail-label">分析</span>
          <div class="detail-value">${escapeHtml(word.analysis || "未提供")}</div>
        </section>
        <section class="detail-section">
          <span class="detail-label">英文定義</span>
          <div class="detail-value">${escapeHtml(word.definition || "未提供")}</div>
        </section>
        <section class="detail-section">
          <span class="detail-label">例句</span>
          ${renderExamples(word.example)}
        </section>
      </div>
    `;

    detail.querySelectorAll("[data-variant-index]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeVariantIndex = Number(button.dataset.variantIndex || 0);
        renderFocusDetail();
      });
    });

    document.getElementById("speakWordBtn")?.addEventListener("click", () => speakWord(word));
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    window.WordsApp.tutorial?.refresh?.();
  }

  function findGroupIndexById(groupId) {
    return state.groupedWords.findIndex((item) => item.id === groupId);
  }

  function openFocusByGroupId(groupId) {
    const index = findGroupIndexById(groupId);
    if (index === -1) {
      return;
    }

    state.activeWordId = groupId;
    state.activeVariantIndex = 0;
    state.lastCardElementId = `word-card-${groupId}`;
    renderWordGrid();
    renderFocusDetail();
  }

  function openFocusByWordRef(wordRef) {
    if (!wordRef) return false;

    const group = state.groupedWords.find((item) =>
      item.variants.some((variant) => (variant.wordRefs || []).includes(wordRef) || variant.wordRef === wordRef)
    );

    if (!group) {
      return false;
    }

    state.activeWordId = group.id;
    state.activeVariantIndex = Math.max(
      0,
      group.variants.findIndex((variant) => (variant.wordRefs || []).includes(wordRef) || variant.wordRef === wordRef)
    );
    state.lastCardElementId = `word-card-${group.id}`;
    renderWordGrid();
    renderFocusDetail();
    return true;
  }

  function closeFocus() {
    const currentCardId = state.activeWordId ? `word-card-${state.activeWordId}` : state.lastCardElementId;
    resetFocusState();
    renderWordGrid();

    const target = currentCardId ? document.getElementById(currentCardId) : null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  async function goFocusStep(step) {
    const currentIndex = findGroupIndexById(state.activeWordId);
    if (currentIndex === -1) return;

    const nextIndex = currentIndex + step;
    if (nextIndex < 0) {
      if (step < 0 && state.loadedStartOffset > 0 && !state.loading) {
        const currentGroupId = state.activeWordId;
        const loaded = await loadPreviousWordsPage();
        if (loaded) {
          const shiftedIndex = findGroupIndexById(currentGroupId);
          const targetIndex = shiftedIndex - 1;
          if (targetIndex >= 0) {
            openFocusByGroupId(state.groupedWords[targetIndex].id, {
              openPanel: state.focusOpen,
              scrollToPanel: state.focusOpen,
              scrollCard: !state.focusOpen
            });
          }
        }
      }
      return;
    }
    if (nextIndex >= state.groupedWords.length) {
      if (step > 0 && state.hasMore && !state.loading) {
        const previousLength = state.groupedWords.length;
        await loadWords();
        if (state.groupedWords.length > previousLength) {
          openFocusByGroupId(state.groupedWords[previousLength].id, {
            openPanel: state.focusOpen,
            scrollToPanel: state.focusOpen,
            scrollCard: !state.focusOpen
          });
        }
      }
      return;
    }

    openFocusByGroupId(state.groupedWords[nextIndex].id, {
      openPanel: state.focusOpen,
      scrollToPanel: state.focusOpen,
      scrollCard: !state.focusOpen
    });
  }

  function appendWords(rows) {
    if (!rows.length) return;

    state.words.push(...rows);
    state.groupedWords = groupWords(state.words);
    renderWordGrid();
    preloadPronunciationsAroundFocus();
  }

  function prependWords(rows) {
    if (!rows.length) return;

    state.words = [...rows, ...state.words];
    state.groupedWords = groupWords(state.words);
    renderWordGrid();
    preloadPronunciationsAroundFocus();
  }

  async function loadPreviousWordsPage() {
    if (state.loading || state.loadedStartOffset <= 0) {
      return false;
    }

    const previousOffset = Math.max(0, state.loadedStartOffset - state.pageSize);
    const previousLimit = Math.max(1, state.loadedStartOffset - previousOffset);

    state.loading = true;
    syncFocusFollowDock();
    setWordListStatus("載入上一批單字中...");

    try {
      const params = new URLSearchParams({
        limit: String(previousLimit),
        offset: String(previousOffset)
      });
      appendCurrentQueryParams(params);

      const data = await api(`/api/words?${params.toString()}`);
      const rows = data.words || [];
      if (!rows.length) {
        state.loadedStartOffset = 0;
        renderWordListStatus();
        return false;
      }

      prependWords(rows);
      state.loadedStartOffset = previousOffset;
      state.totalGroups = Number(data.totalGroups || state.totalGroups || 0);
      renderWordListStatus();
      return true;
    } catch (error) {
      setWordListStatus("");
      showMessage(error.message);
      return false;
    } finally {
      state.loading = false;
      syncFocusFollowDock();
    }
  }

  async function loadWords({ reset = false } = {}) {
    if (state.loading || (!state.hasMore && !reset)) {
      return;
    }

    state.loading = true;
    syncFocusFollowDock();
    setWordListStatus("載入單字中...");

    if (reset) {
      state.words = [];
      state.groupedWords = [];
      state.loadedStartOffset = 0;
      state.offset = 0;
      state.totalGroups = 0;
      state.hasMore = true;
      resetFocusState();
    }

    try {
      const params = new URLSearchParams({
        limit: String(state.pageSize),
        offset: String(state.offset)
      });
      appendCurrentQueryParams(params);

      const data = await api(`/api/words?${params.toString()}`);
      appendWords(data.words || []);
      state.offset = Number(data.nextOffset || state.offset);
      state.totalGroups = Number(data.totalGroups || 0);
      state.hasMore = Boolean(data.hasMore);
      renderWordListStatus();

      if (state.pendingWordRef) {
        const restoreSnapshot = state.restoreSnapshot?.activeWordRef === state.pendingWordRef ? state.restoreSnapshot : null;
        const opened = openFocusByWordRef(state.pendingWordRef, {
          openPanel: restoreSnapshot ? Boolean(restoreSnapshot.focusOpen) : true,
          scrollToPanel: !restoreSnapshot,
          scrollCard: !restoreSnapshot,
          variantIndex: restoreSnapshot ? Number(restoreSnapshot.activeVariantIndex || 0) : undefined
        });
      if (opened) {
        state.pendingWordRef = "";
        state.pendingWordRefFromRestore = false;
        clearPendingWordRefFromUrl();
      }
      }
    } catch (error) {
      setWordListStatus("");
      showMessage(error.message);
    } finally {
      state.loading = false;
      syncFocusFollowDock();
    }
  }

  async function loadPendingWordRefGroup() {
    if (!state.pendingWordRef) {
      return false;
    }

    state.loading = true;
    setWordListStatus("載入目標單字中...");
    resetFocusState();

    try {
      const params = new URLSearchParams({ limit: String(state.pageSize) });
      appendCurrentQueryParams(params);
      const data = await api(`/api/words/by-ref/${encodeURIComponent(state.pendingWordRef)}?${params.toString()}`);
      replaceLoadedWords(data.words || []);
      state.loadedStartOffset = Math.max(0, Number(data.pageOffset || 0));
      state.offset = Number(data.nextOffset || 0);
      state.totalGroups = Number(data.totalGroups || 0);
      state.hasMore = Boolean(data.hasMore);
      renderWordListStatus();

      const restoreSnapshot = state.restoreSnapshot?.activeWordRef === state.pendingWordRef ? state.restoreSnapshot : null;
      const opened = openFocusByWordRef(state.pendingWordRef, {
        openPanel: restoreSnapshot ? Boolean(restoreSnapshot.focusOpen) : true,
        scrollToPanel: false,
        scrollCard: false,
        variantIndex: restoreSnapshot ? Number(restoreSnapshot.activeVariantIndex || 0) : undefined
      });
      if (!opened) {
        throw new Error("找不到指定單字。");
      }

      state.pendingWordRef = "";
      clearPendingWordRefFromUrl();
      return true;
    } catch (error) {
      setWordListStatus("");
      if (!state.pendingWordRefFromRestore) {
        showMessage(error.message);
      }
      state.pendingWordRefFromRestore = false;
      return false;
    } finally {
      state.loading = false;
    }
  }

  function bindInfiniteScroll() {
    state.observer?.disconnect();
    const sentinel = document.getElementById("loadMoreHint");
    if (!sentinel) return;

    state.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadWords();
        }
      },
      { rootMargin: "240px 0px" }
    );

    state.observer.observe(sentinel);
  }

  async function loadSources() {
    const { sources } = await api("/api/words/sources");
    state.sources = sources || [];
    renderSourceOptions();
    renderUnitOptions("");
    window.WordsApp.tutorial?.refresh?.();
  }

  async function loadOverview() {
    const data = await api("/api/words/overview");
    renderOverviewStats(data.totals || {});
  }

  function renderSourceOptions() {
    document.getElementById("sourceFilter").innerHTML =
      '<option value="">全部來源</option>' +
      state.sources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`).join("");
  }

  function renderUnitOptions(sourceId, selectedUnitIds = getSelectedUnitIds()) {
    const unitFilter = getUnitFilterElement();
    if (!unitFilter) {
      return;
    }

    const source = state.sources.find((item) => String(item.id) === String(sourceId));
    const units = source ? source.units : state.sources.flatMap((item) => item.units);
    const selected = new Set((selectedUnitIds || []).map((item) => String(item)));
    unitFilter.innerHTML =
      `<button type="button" class="unit-filter-clear ${selected.size ? "" : "active"}" data-clear-unit-filter>全部單元</button>` +
      units
        .map(
          (unit) => `
            <label class="unit-filter-pill">
              <input type="checkbox" name="unitIds" value="${unit.id}" ${selected.has(String(unit.id)) ? "checked" : ""} />
              <span>${escapeHtml(unit.name)}</span>
            </label>
          `
        )
        .join("");
  }

  function renderOverviewStats(totals) {
    const target = document.getElementById("overviewStats");
    if (!target) return;

    target.innerHTML = `
      <div class="stat subtle-stat"><span>來源數</span><strong>${totals.source_count || 0}</strong></div>
      <div class="stat subtle-stat"><span>單元數</span><strong>${totals.unit_count || 0}</strong></div>
      <div class="stat subtle-stat"><span>單字總數</span><strong>${totals.word_count || 0}</strong></div>
    `;
  }

  function setWordListStatus(message) {
    const target = document.getElementById("loadMoreHint");
    if (target) {
      target.textContent = message || "";
    }
  }

  function renderWordListStatus() {
    if (state.totalGroups === 0) {
      setWordListStatus("目前沒有符合條件的單字。");
    } else if (state.hasMore) {
      setWordListStatus(`已載入 ${state.groupedWords.length} / ${state.totalGroups} 個單字，向下滑動可繼續載入。`);
    } else {
      setWordListStatus(`已載入全部 ${state.groupedWords.length} 個單字。`);
    }
  }

  function getFocusPanelElement() {
    return document.getElementById("focusPanel");
  }

  function getFocusFollowDock() {
    return document.getElementById("focusFollowDock");
  }

  function scrollCardIntoView(groupId = state.activeWordId, behavior = "smooth") {
    if (!groupId) {
      return;
    }

    document.getElementById(`word-card-${groupId}`)?.scrollIntoView({ behavior, block: "center" });
  }

  function syncFocusFollowDock() {
    const dock = getFocusFollowDock();
    if (!dock) {
      return;
    }

    if (!state.activeWordId) {
      dock.classList.add("hidden");
      return;
    }

    const prevButtons = [
      document.getElementById("focusPrevBtn"),
      document.getElementById("focusFollowPrevBtn")
    ].filter(Boolean);
    const nextButtons = [
      document.getElementById("focusNextBtn"),
      document.getElementById("focusFollowNextBtn")
    ].filter(Boolean);
    const listViewToggle = document.getElementById("wordListViewToggle");
    if (listViewToggle) {
      const isCompact = state.listViewMode === "compact";
      const nextModeLabel = isCompact ? "切換為詳細單字列表" : "切換為簡略英文列表";
      listViewToggle.classList.toggle("is-compact", isCompact);
      listViewToggle.setAttribute("aria-pressed", String(isCompact));
      listViewToggle.setAttribute("aria-label", nextModeLabel);
      listViewToggle.setAttribute("title", nextModeLabel);
    }
    const jumpButton = document.getElementById("focusFollowJumpBtn");
    const currentIndex = findGroupIndexById(state.activeWordId);
    const canGoPrevious = currentIndex > 0 || state.loadedStartOffset > 0;
    const canGoNext = currentIndex >= 0 && (currentIndex < state.groupedWords.length - 1 || state.hasMore);

    dock.classList.remove("hidden");
    prevButtons.forEach((button) => {
      button.disabled = !canGoPrevious || state.loading;
    });
    nextButtons.forEach((button) => {
      button.disabled = !canGoNext || state.loading;
    });
    if (jumpButton) {
      jumpButton.textContent = state.focusOpen ? "定位專注卡" : "返回專注卡";
      jumpButton.setAttribute("aria-label", state.focusOpen ? "定位到專注單字卡" : "重新打開專注單字卡");
    }
  }

  function scrollToFocusPanel() {
    if (!state.activeWordId) {
      return;
    }

    if (!state.focusOpen) {
      state.focusOpen = true;
      state.focusShouldScroll = true;
      renderFocusDetail();
      return;
    }

    const panel = getFocusPanelElement();
    if (!panel || panel.classList.contains("hidden")) {
      return;
    }

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetFocusState() {
    cancelSpeech();
    state.activeWordId = null;
    state.activeVariantIndex = 0;
    state.focusOpen = false;
    state.focusShouldScroll = false;
    document.getElementById("focusPanel").classList.add("hidden");
    document.getElementById("focusDetail").innerHTML = "";
    syncFocusFollowDock();
    queueSaveOverviewState();
  }

  function renderWordCard(group) {
    const word = group.variants[0];
    const sourceText = (word.sourceUnitPairs || []).join("・");

    return `
      <article id="word-card-${group.id}" class="word-preview-card ${state.activeWordId === group.id ? "active" : ""}" data-word-id="${group.id}">
        <h3>
          ${escapeHtml(group.eng)}
          <span>${escapeHtml(word.kk || "未提供 KK")}</span>
        </h3>
        <p class="small-text muted">${escapeHtml(sourceText || "未標示來源")}</p>
        ${renderMeaningList(word.chEntries || word.ch, { className: "meaning-list compact", maxItems: 3 })}
        ${group.variants.length > 1 ? `<p class="small-text muted">${group.variants.length} 種詞性</p>` : ""}
      </article>
    `;
  }

  function renderExamples(example) {
    const examples = parseExamples(example);
    if (!examples.length) {
      return '<div class="detail-value">未提供例句</div>';
    }

    return `
      <div class="detail-value example-list">
        ${examples
          .map(
            (item) => `
              <div class="meaning-item">
                <span class="meaning-text">${escapeHtml(item.eng || "")}</span>
              </div>
              <div class="small-text muted">${escapeHtml(item.ch || "")}</div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderFocusDetail() {
    const group = getActiveGroup();
    const word = getActiveVariant(group);
    const detail = document.getElementById("focusDetail");
    const panel = document.getElementById("focusPanel");

    if (!group || !word || !state.focusOpen) {
      panel.classList.add("hidden");
      detail.innerHTML = "";
      syncFocusFollowDock();
      return;
    }

    panel.classList.remove("hidden");
    const sourceSummary = [...new Set([...(word.sourceNames || []), ...(word.unitNames || [])].filter(Boolean))].join(" / ");
    const examHighlightTexts = Array.isArray(word.examMeaningTexts) ? word.examMeaningTexts : [];
    const detailModeSection = `
        <section class="detail-section">
          <span class="detail-label">分析</span>
          <div class="detail-value">${escapeHtml(word.analysis || "未提供")}</div>
        </section>
      `;

    detail.innerHTML = `
      <div class="word-detail-card">
        <div class="section-title-row">
          <div>
            <h2>${escapeHtml(group.eng)}</h2>
            <p class="small-text muted focus-source-summary">${escapeHtml(sourceSummary || "未標示來源")}</p>
          </div>
          <button type="button" id="speakWordBtn" class="ghost-btn">播放單字</button>
        </div>
        ${renderVariantTabs(group)}
        <section class="detail-section">
          <span class="detail-label">詞性 / KK</span>
          <div class="detail-value">${escapeHtml(word.tense || "未標示詞性")} / ${escapeHtml(word.kk || "未提供")}</div>
        </section>
        <section class="detail-section">
          <span class="detail-label">中文解釋</span>
          ${renderMeaningList(word.chEntries || word.ch, {
            className: "meaning-list",
            highlightTexts: examHighlightTexts,
            ensureHighlightsVisible: true
          })}
          ${examHighlightTexts.length ? '<p class="small-text muted exam-highlight-hint">螢光底代表已標記為考試字義。</p>' : ""}
        </section>
        ${detailModeSection}
        <section class="detail-section">
          <span class="detail-label">英文定義</span>
          <div class="detail-value">${escapeHtml(word.definition || "未提供")}</div>
        </section>
        <section class="detail-section">
          <span class="detail-label">例句</span>
          ${renderExamples(word.example)}
        </section>
      </div>
    `;

    detail.querySelectorAll("[data-variant-index]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeVariantIndex = Number(button.dataset.variantIndex || 0);
        renderFocusDetail();
        queueSaveOverviewState();
      });
    });

    document.getElementById("speakWordBtn")?.addEventListener("click", () => speakWord(word));
    if (state.focusShouldScroll) {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    state.focusShouldScroll = false;
    syncFocusFollowDock();
    queueSaveOverviewState();
    preloadPronunciationsAroundFocus();
    window.WordsApp.tutorial?.refresh?.();
  }

  function openFocusByGroupId(groupId, options = {}) {
    const index = findGroupIndexById(groupId);
    if (index === -1) {
      return;
    }

    state.activeWordId = groupId;
    state.activeVariantIndex = Math.max(0, Number(options.variantIndex ?? 0) || 0);
    state.focusOpen = options.openPanel !== false;
    state.focusShouldScroll = Boolean(state.focusOpen && options.scrollToPanel !== false);
    state.lastCardElementId = `word-card-${groupId}`;
    renderWordGrid();
    renderFocusDetail();

    if (!state.focusOpen && options.scrollCard !== false) {
      scrollCardIntoView(groupId);
    }
    queueSaveOverviewState();
  }

  function openFocusByWordRef(wordRef, options = {}) {
    if (!wordRef) return false;

    const group = state.groupedWords.find((item) =>
      item.variants.some((variant) => (variant.wordRefs || []).includes(wordRef) || variant.wordRef === wordRef)
    );

    if (!group) {
      return false;
    }

    const matchedVariantIndex = group.variants.findIndex(
      (variant) => (variant.wordRefs || []).includes(wordRef) || variant.wordRef === wordRef
    );

    state.activeWordId = group.id;
    state.activeVariantIndex = Math.max(0, Number(options.variantIndex ?? matchedVariantIndex) || 0);
    state.focusOpen = options.openPanel !== false;
    state.focusShouldScroll = Boolean(state.focusOpen && options.scrollToPanel !== false);
    state.lastCardElementId = `word-card-${group.id}`;
    renderWordGrid();
    renderFocusDetail();

    if (!state.focusOpen && options.scrollCard !== false) {
      scrollCardIntoView(group.id);
    }

    queueSaveOverviewState();
    return true;
  }

  function closeFocus() {
    cancelSpeech();
    state.focusOpen = false;
    state.focusShouldScroll = false;
    renderFocusDetail();
    scrollCardIntoView(state.activeWordId);
    queueSaveOverviewState();
  }

  async function loadOverview() {
    const target = document.getElementById("overviewStats");
    if (!target) {
      return;
    }

    const data = await api("/api/words/overview");
    renderOverviewStats(data.totals || {});
  }

  function bindFocusJumpControls() {
    document.getElementById("focusFollowPrevBtn")?.addEventListener("click", () => goFocusStep(-1));
    document.getElementById("focusFollowJumpBtn")?.addEventListener("click", scrollToFocusPanel);
    document.getElementById("focusFollowNextBtn")?.addEventListener("click", () => goFocusStep(1));
    document.getElementById("wordListViewToggle")?.addEventListener("click", () => {
      state.listViewMode = state.listViewMode === "compact" ? "detailed" : "compact";
      renderWordGrid();
      syncFocusFollowDock();
      queueSaveOverviewState();
    });
    window.addEventListener(
      "scroll",
      () => {
        queueSaveOverviewState();
      },
      { passive: true }
    );
    window.addEventListener("pagehide", saveOverviewState);
  }

  function bindUnitFilterDismissal() {
    const dropdown = document.getElementById("unitFilterDropdown");
    if (!dropdown) {
      return;
    }

    document.addEventListener("pointerdown", (event) => {
      if (dropdown.open && !dropdown.contains(event.target)) {
        dropdown.open = false;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && dropdown.open) {
        dropdown.open = false;
        dropdown.querySelector("summary")?.focus();
      }
    });
  }

  function bindToolbar() {
    document.getElementById("sourceFilter").addEventListener("change", (event) => {
      renderUnitOptions(event.target.value, []);
      saveOverviewStateNow();
      loadWords({ reset: true });
    });

    const unitFilter = getUnitFilterElement();

    unitFilter?.addEventListener("change", (event) => {
      if (event.target?.matches?.('input[name="unitIds"]')) {
        syncUnitFilterClearState();
        saveOverviewStateNow();
        loadWords({ reset: true });
      }
    });

    unitFilter?.addEventListener("click", (event) => {
      const clearButton = event.target?.closest?.("[data-clear-unit-filter]");
      if (!clearButton) {
        return;
      }

      setSelectedUnitIds([]);
      saveOverviewStateNow();
      loadWords({ reset: true });
    });

    unitFilter?.addEventListener("input", (event) => {
      const searchInput = event.target?.closest?.("[data-unit-filter-search]");
      if (!searchInput) {
        return;
      }

      const query = String(searchInput.value || "").trim().toLocaleLowerCase();
      unitFilter.querySelectorAll(".unit-filter-pill").forEach((pill) => {
        pill.hidden = Boolean(query) && !pill.textContent.toLocaleLowerCase().includes(query);
      });
    });

    document.getElementById("wordOrderMode")?.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-word-order]");
      if (!button) {
        return;
      }

      const nextMode = normalizeWordOrderMode(button.dataset.wordOrder);
      if (nextMode === getWordOrderMode()) {
        return;
      }

      setWordOrderMode(nextMode);
      saveOverviewStateNow();
      loadWords({ reset: true });
    });

    document.getElementById("searchBtn").addEventListener("click", () => {
      saveOverviewStateNow();
      loadWords({ reset: true });
    });

    document.getElementById("searchInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveOverviewStateNow();
        loadWords({ reset: true });
      }
    });
    document.getElementById("searchInput").addEventListener("input", () => {
      queueSaveOverviewState();
    });

    document.getElementById("focusPrevBtn").addEventListener("click", () => goFocusStep(-1));
    document.getElementById("focusNextBtn").addEventListener("click", () => goFocusStep(1));
    document.getElementById("focusCloseBtn").addEventListener("click", closeFocus);
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    state.persistenceSuspended = true;
    await Promise.all([loadSources(), loadOverview()]);
    state.restoreSnapshot = readSavedOverviewState();
    applySavedOverviewFilters(state.restoreSnapshot);
    if (!state.pendingWordRef && state.restoreSnapshot?.activeWordRef) {
      state.pendingWordRef = String(state.restoreSnapshot.activeWordRef);
      state.pendingWordRefFromRestore = true;
    }
    bindToolbar();
    bindUnitFilterDismissal();
    bindFocusJumpControls();
    bindInfiniteScroll();

    const jumped = await loadPendingWordRefGroup();
    if (!jumped) {
      await loadWords({ reset: true });
    }

    restoreOverviewViewport(state.restoreSnapshot);
    syncFocusFollowDock();
    state.persistenceSuspended = false;
    state.restoreSnapshot = null;
    queueSaveOverviewState();
  }

  return { init };
})();

OverviewPage.init().catch((error) => window.WordsApp.showMessage(error.message));
