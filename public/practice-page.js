const PracticePage = (() => {
  const { api, showMessage, refreshUser, enforcePageAccess, tts, state: appState } = window.WordsApp;

  const MODE_META = {
    zh_to_en: { label: "中選英", questionType: "choice" },
    en_to_zh: { label: "英選中", questionType: "choice" },
    type_en_from_zh: { label: "看中打英", questionType: "typing" },
    cloze_en: { label: "克漏字", questionType: "typing" }
  };
  const PRACTICE_MAX_QUESTIONS = 5000;

  const state = {
    sources: [],
    questions: [],
    index: 0,
    answers: [],
    retryQuestions: [],
    locked: false,
    questionTimerId: null,
    questionTimerDeadline: 0,
    questionTimerLimitSeconds: 0,
    questionTimerIndex: -1,
    nextQuestionTimerId: null,
    generationAbortController: null,
    typingTtsEnabled: true,
    lastSuggestedNormalLimit: 10,
    lastSuggestedClozeLimit: 10,
    availabilityLoaded: false,
    availabilitySignature: "",
    currentPracticeKind: "normal",
    availability: {
      wordCount: 0,
      allMeaningCount: 0,
      clozeAllCount: 0
    }
  };

  function getNextQuestionDelayMs() {
    const configuredDelay = Number(appState.user?.practiceNextQuestionDelayMs);
    if (!Number.isFinite(configuredDelay)) {
      return 1000;
    }

    return Math.max(0, Math.min(10000, Math.round(configuredDelay)));
  }

  function resolvePracticeTimeLimitSeconds(value, fallback) {
    const seconds = Number(value);
    if (!Number.isInteger(seconds)) {
      return fallback;
    }

    if (seconds === 0) {
      return 0;
    }

    return seconds >= 5 && seconds <= 40 ? seconds : fallback;
  }

  function getQuestionTimeLimitSeconds(question) {
    if (question.questionType === "choice") {
      return resolvePracticeTimeLimitSeconds(appState.user?.practiceChoiceTimeLimitSeconds, 15);
    }

    return resolvePracticeTimeLimitSeconds(appState.user?.practiceTypingTimeLimitSeconds, 30);
  }

  function clearQuestionTimer() {
    if (state.questionTimerId !== null) {
      window.clearInterval(state.questionTimerId);
    }

    state.questionTimerId = null;
    state.questionTimerDeadline = 0;
    state.questionTimerLimitSeconds = 0;
    state.questionTimerIndex = -1;
  }

  function clearPendingNextQuestion() {
    if (state.nextQuestionTimerId !== null) {
      window.clearTimeout(state.nextQuestionTimerId);
    }

    state.nextQuestionTimerId = null;
  }

  function clearPracticeTimers() {
    clearQuestionTimer();
    clearPendingNextQuestion();
  }

  function updateQuestionTimerDisplay() {
    if (state.questionTimerIndex !== state.index || state.locked) {
      clearQuestionTimer();
      return;
    }

    const remainingMs = Math.max(0, state.questionTimerDeadline - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const timer = document.getElementById("questionTimer");
    const timerValue = document.getElementById("questionTimerValue");
    const timerFill = document.getElementById("questionTimerFill");

    if (!timer || !timerValue || !timerFill) {
      clearQuestionTimer();
      return;
    }

    timerValue.textContent = `${remainingSeconds}s`;
    timerFill.style.width = `${Math.max(0, (remainingMs / (state.questionTimerLimitSeconds * 1000)) * 100)}%`;
    timer.classList.toggle("is-warning", remainingSeconds <= 5);

    if (remainingMs <= 0) {
      clearQuestionTimer();
      handleAnswer("", { timedOut: true });
    }
  }

  function startQuestionTimer(question, answerState) {
    clearQuestionTimer();

    const timeLimitSeconds = getQuestionTimeLimitSeconds(question);
    if (answerState.checked || timeLimitSeconds === 0) {
      return;
    }

    state.questionTimerLimitSeconds = timeLimitSeconds;
    state.questionTimerDeadline = Date.now() + timeLimitSeconds * 1000;
    state.questionTimerIndex = state.index;
    updateQuestionTimerDisplay();
    state.questionTimerId = window.setInterval(updateQuestionTimerDisplay, 100);
  }

  function renderQuestionTimer(question, answerState) {
    const timeLimitSeconds = getQuestionTimeLimitSeconds(question);
    if (answerState.checked || timeLimitSeconds === 0) {
      return "";
    }

    return `
      <div id="questionTimer" class="question-timer" role="timer" aria-label="本題剩餘時間">
        <span class="question-timer-label">剩餘時間 <strong id="questionTimerValue" class="question-timer-value">${timeLimitSeconds}s</strong></span>
        <div class="question-timer-track" aria-hidden="true"><span id="questionTimerFill"></span></div>
      </div>
    `;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function stripPracticeParentheses(value) {
    return String(value ?? "")
      .replace(/\uFF08[^\uFF08\uFF09]*\uFF09/g, "")
      .replace(/\([^()]*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function buildPracticeMarker(index) {
    return index < 20 ? String.fromCharCode(9312 + index) : `${index + 1}.`;
  }

  function splitPracticeLines(value, options = {}) {
    const baseText = options.preserveParentheses ? String(value ?? "").trim() : stripPracticeParentheses(value);
    const text = baseText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!text) return [];

    if (/[\u2460-\u2473]/.test(text)) {
      const parts = text
        .split(/(?=[\u2460-\u2473])/)
        .map((item) => item.replace(/[\uFF1B;\u3002]+$/g, "").trim())
        .filter(Boolean);
      return parts.length <= 1 ? parts.map((item) => item.replace(/^[\u2460-\u2473]\s*/, "").trim()) : parts;
    }

    const parts = text
      .split(/\n+|[\uFF1B;\u3002]/)
      .map((item) => item.trim())
      .filter(Boolean);

    return parts.length <= 1 ? parts : parts.map((item, index) => `${buildPracticeMarker(index)} ${item}`);
  }

  function renderPracticeText(value, className, options = {}) {
    const lines = splitPracticeLines(value, options).slice(0, options.maxLines || 3);
    const resolvedLines = lines.length
      ? lines
      : [
          options.preserveParentheses
            ? String(value || "").trim()
            : stripPracticeParentheses(value) || String(value || "").trim()
        ].filter(Boolean);

    return `
      <div class="${className}">
        ${resolvedLines.map((line) => `<span class="practice-text-line">${escapeHtml(line)}</span>`).join("")}
      </div>
    `;
  }

  function renderCompactValue(value, className, options = {}) {
    const lines = splitPracticeLines(value, options).slice(0, options.maxLines || 2);
    if (lines.length) {
      return `
        <div class="${className}">
          ${lines.map((line) => `<span class="practice-text-line">${escapeHtml(line)}</span>`).join("")}
        </div>
      `;
    }

    const text = options.preserveParentheses
      ? String(value || "").trim()
      : stripPracticeParentheses(value) || String(value || "").trim();
    return `<span class="${className}">${escapeHtml(text)}</span>`;
  }

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function buildClozeHint(answer) {
    const text = String(answer ?? "").trim();
    if (!text) {
      return "";
    }

    return text.replace(/[A-Za-z]+/g, (word) => {
      if (word.length <= 2) {
        return word;
      }

      return `${word[0]}${"_".repeat(word.length - 2)}${word[word.length - 1]}`;
    });
  }

  function buildClozePromptWithHint(prompt, hint) {
    const text = String(prompt || "").trim();
    const cleanHint = String(hint || "").trim();
    if (!text || !cleanHint) {
      return text;
    }

    if (/_{2,}/.test(text)) {
      return text.replace(/_{2,}/, (blank) => `${blank} (${cleanHint})`);
    }

    return `${text} (${cleanHint})`;
  }

  function renderClozeTranslationHint(question) {
    const translation = String(question?.exampleTranslation || "").trim();
    if (!translation) {
      return "";
    }

    return `
      <details class="cloze-translation-hint">
        <summary>顯示中文提示</summary>
        <div>${escapeHtml(translation)}</div>
      </details>
    `;
  }

  function cancelSpeech() {
    tts.cancel();
  }

  function speakText(text, options = {}) {
    const { delay = 420, force = false } = options;
    if ((!state.typingTtsEnabled && !force) || !text || !tts.isSupported()) {
      return;
    }

    tts.speak(text, { delay });
  }

  function renderSourceOptions() {
    const select = document.getElementById("practiceSource");
    select.innerHTML =
      '<option value="">全部來源</option>' +
      state.sources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`).join("");
  }

  function findVisibleUnits(sourceId) {
    const source = state.sources.find((item) => String(item.id) === String(sourceId));
    return source ? source.units : state.sources.flatMap((item) => item.units);
  }

  function getSelectedUnitInputs() {
    return Array.from(document.querySelectorAll('#practiceUnit input[name="unitId"]:checked'));
  }

  function renderUnitOptions(sourceId) {
    const units = findVisibleUnits(sourceId);
    document.getElementById("practiceUnit").innerHTML = units
      .map(
        (unit) => `
          <label class="unit-pill">
            <input type="checkbox" name="unitId" value="${unit.id}" />
            <span>${escapeHtml(unit.name)}</span>
          </label>
        `
      )
      .join("");

    document.querySelectorAll('#practiceUnit input[name="unitId"]').forEach((input) => {
      input.addEventListener("change", () => refreshPracticeAvailability(true, { force: true }).catch((error) => showMessage(error.message)));
    });

    refreshPracticeAvailability(true, { force: true }).catch((error) => showMessage(error.message));
  }

  function getGuestStarredKeys() {
    try {
      return JSON.parse(sessionStorage.getItem("wordsKingGuestStars") || "[]");
    } catch {
      return [];
    }
  }

  function isStarredOnlySelected() {
    return Boolean(state.starredOnly || document.getElementById("practiceStarredOnly")?.checked);
  }

  function setStarredOnly(starred) {
    state.starredOnly = Boolean(starred);
    const checkbox = document.getElementById("practiceStarredOnly");
    if (checkbox) {
      checkbox.checked = state.starredOnly;
    }

    document.querySelectorAll("#practiceScopeSwitch .practice-scope-option").forEach((btn) => {
      const isTarget = (btn.dataset.scope === "starred") === state.starredOnly;
      btn.classList.toggle("is-active", isTarget);
      btn.setAttribute("aria-pressed", String(isTarget));
    });

    refreshPracticeAvailability(true, { force: true }).catch((error) => showMessage(error.message));
  }

  function buildAvailabilityParams() {
    const params = new URLSearchParams();
    const sourceId = document.getElementById("practiceSource")?.value || "";
    const selectedUnitIds = getSelectedUnitInputs().map((input) => input.value);

    if (sourceId) params.set("sourceId", sourceId);
    if (selectedUnitIds.length === 1) {
      params.set("unitId", selectedUnitIds[0]);
    } else if (selectedUnitIds.length > 1) {
      params.set("unitIds", selectedUnitIds.join(","));
    }
    if (isStarredOnlySelected()) {
      params.set("starredOnly", "true");
      if (!appState.user || appState.user.isGuest) {
        params.set("guestStarredKeys", JSON.stringify(getGuestStarredKeys()));
      }
    }
    return params;
  }

  function getAvailabilitySignature() {
    const sourceId = document.getElementById("practiceSource")?.value || "";
    const selectedUnitIds = getSelectedUnitInputs()
      .map((input) => String(input.value))
      .sort()
      .join(",");
    const starredOnly = isStarredOnlySelected();
    const guestKeys = starredOnly && (!appState.user || appState.user.isGuest) ? getGuestStarredKeys().sort().join(",") : "";
    return `${sourceId}::${selectedUnitIds}::${starredOnly}::${guestKeys}`;
  }

  function getNormalAvailableCount() {
    return state.availability.allMeaningCount;
  }

  function getClozeAvailableCount() {
    return state.availability.clozeAllCount;
  }

  function getSelectedModes() {
    return Array.from(document.querySelectorAll('input[name="practiceModes"]:checked')).map((input) => input.value);
  }

  function updateModeCardState() {
    document.querySelectorAll(".practice-mode-card").forEach((card) => {
      const checkbox = card.querySelector('input[name="practiceModes"]');
      card.classList.toggle("is-active", Boolean(checkbox?.checked));
    });
  }

  function setPracticeKind(kind = "normal") {
    state.currentPracticeKind = kind === "cloze" ? "cloze" : "normal";

    document.querySelectorAll("[data-practice-kind]").forEach((button) => {
      const isActive = button.dataset.practiceKind === state.currentPracticeKind;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    document.querySelectorAll("[data-practice-kind-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.practiceKindPanel !== state.currentPracticeKind;
    });
  }

  function applyLimitState(inputId, availableCount, stateKey, autofillLimit, minLimit = 10) {
    const input = document.getElementById(inputId);
    const maximumLimit = Math.min(availableCount, PRACTICE_MAX_QUESTIONS);
    const defaultLimit = availableCount > 0 ? maximumLimit : minLimit;
    const minValue = availableCount > 0 && availableCount < minLimit ? 1 : minLimit;

    input.max = availableCount > 0 ? String(maximumLimit) : String(PRACTICE_MAX_QUESTIONS);
    input.min = String(minValue);

    const numericValue = Number(input.value);
    if (
      autofillLimit ||
      !input.value ||
      Number.isNaN(numericValue) ||
      numericValue > availableCount ||
      numericValue === state[stateKey]
    ) {
      input.value = String(defaultLimit);
    }

    state[stateKey] = defaultLimit;
  }

  function updatePracticeSummaries(autofillLimit = false) {
    const selectedCount = getSelectedUnitInputs().length;
    const normalAvailable = getNormalAvailableCount();
    const clozeAvailable = getClozeAvailableCount();
    const rangePrefix = selectedCount
      ? `已選 ${selectedCount} 個單元`
      : "未勾選單元時會使用目前來源下全部單元";
    const isStarred = isStarredOnlySelected();
    const starPrefix = isStarred ? "【⭐ 僅標記單字】" : "";
    const starHint = isStarred && normalAvailable === 0
      ? "（目前範圍尚無標記單字，請至單字庫或專注單字卡中標記）"
      : "";

    document.getElementById("practiceUnitSummary").textContent =
      `${rangePrefix}，共 ${state.availability.wordCount} 個單字、${state.availability.allMeaningCount} 個可練習字義。${starHint}`;
    document.getElementById("normalPracticeSummary").textContent =
      `${starPrefix}一般練習可出 ${normalAvailable} 題，單次最多 ${PRACTICE_MAX_QUESTIONS} 題。`;
    document.getElementById("clozeSummary").textContent =
      `${starPrefix}克漏字可出 ${clozeAvailable} 題，單次最多 ${PRACTICE_MAX_QUESTIONS} 題。`;

    applyLimitState("practiceLimit", normalAvailable, "lastSuggestedNormalLimit", autofillLimit, 10);
    applyLimitState("clozeLimit", clozeAvailable, "lastSuggestedClozeLimit", autofillLimit, 1);

    document.getElementById("loadPracticeBtn").disabled = normalAvailable < 1;
    document.getElementById("loadClozeBtn").disabled = clozeAvailable < 1;
  }

  async function refreshPracticeAvailability(autofillLimit = false, options = {}) {
    const signature = getAvailabilitySignature();
    if (!options.force && state.availabilityLoaded && state.availabilitySignature === signature) {
      updatePracticeSummaries(autofillLimit);
      return state.availability;
    }

    const params = buildAvailabilityParams();
    const data = await api(`/api/practice/availability?${params.toString()}`);
    state.availability = {
      wordCount: Number(data.wordCount || 0),
      allMeaningCount: Number(data.allMeaningCount || 0),
      clozeAllCount: Number(data.clozeAllCount || data.clozeCount || 0)
    };
    state.availabilityLoaded = true;
    state.availabilitySignature = signature;
    updatePracticeSummaries(autofillLimit);
    return state.availability;
  }

  async function loadSources() {
    const { sources } = await api("/api/words/sources");
    state.sources = sources || [];
    renderSourceOptions();
    renderUnitOptions("");
  }

  function currentQuestion() {
    return state.questions[state.index];
  }

  function preloadUpcomingQuestionAudio() {
    if (typeof tts.preloadWords !== "function" || !state.questions.length) {
      return;
    }

    const words = state.questions
      .slice(state.index + 1, state.index + 4)
      .map((question) => question?.reference?.eng)
      .filter(Boolean);
    tts.preloadWords(words, {
      max: 3,
      delay: 300
    });
  }

  function evaluateAnswer(question, answer) {
    if (question.mode === "en_to_zh") {
      return normalize(question.expectedAnswer).includes(normalize(answer)) || normalize(answer).includes(normalize(question.expectedAnswer));
    }
    return normalize(question.expectedAnswer) === normalize(answer);
  }

  function renderChoices(question, answerState) {
    return `
      <div class="choice-grid">
        ${question.choices
          .map((choice) => {
            let statusClass = "";
            if (answerState?.checked) {
              if (choice === question.expectedAnswer) {
                statusClass = "correct";
              } else if (choice === answerState.answer && !answerState.correct) {
                statusClass = "wrong";
              }
            }

            return `
              <button
                type="button"
                class="choice-btn ${statusClass}"
                data-choice="${encodeURIComponent(choice)}"
                ${answerState?.checked ? "disabled" : ""}
              >
                ${renderCompactValue(choice, "choice-label-block", { maxLines: 2 })}
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderFeedback(question, answerState) {
    if (!answerState?.checked || answerState.correct) {
      return '<div class="feedback-slot"></div>';
    }

    return `
      <div class="feedback-slot">
        <div class="answer-feedback wrong">
          <span class="answer-feedback-label">${answerState.timedOut ? "時間到，正確答案" : "正確答案"}</span>
          <span class="answer-feedback-value">${escapeHtml(question.expectedAnswer)}</span>
        </div>
      </div>
    `;
  }

  function buildTypingControls(question, answerState) {
    const shouldShowTts = question.mode === "type_en_from_zh";
    return `
      ${
        shouldShowTts
          ? `
              <div class="practice-actions inline-tools">
                <label class="inline-check">
                  <input id="ttsEnabled" type="checkbox" ${state.typingTtsEnabled ? "checked" : ""}>
                  語音提示
                </label>
                <button type="button" class="ghost-btn" id="speakBtn">播放</button>
              </div>
            `
          : ""
      }
      <div class="typing-row">
        <input
          id="typingAnswer"
          class="typing-answer-input ${answerState.checked ? (answerState.correct ? "is-correct" : "is-wrong") : ""}"
          placeholder="輸入答案"
          value="${escapeHtml(answerState.answer || "")}"
          type="text"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          inputmode="latin"
          enterkeyhint="done"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          ${answerState.checked ? "disabled" : ""}
        >
        <button type="button" id="typingSubmitBtn" ${answerState.checked ? "disabled" : ""}>送出</button>
      </div>
    `;
  }

  function renderQuestion() {
    clearQuestionTimer();
    document.getElementById("setupCard").style.display = "none";
    const area = document.getElementById("practiceArea");
    area.classList.remove("empty");

    const question = currentQuestion();
    if (!question) return;

    cancelSpeech();

    const progress = Math.round(((state.index + 1) / state.questions.length) * 100);
    const answerState = state.answers[state.index] || { answer: "", checked: false, correct: null };
    const modeMeta = MODE_META[question.mode] || MODE_META.zh_to_en;
    const isCloze = question.mode === "cloze_en";
    const clozeHint = isCloze ? buildClozeHint(question.clozeAnswer || question.expectedAnswer || "") : "";
    const promptText = isCloze
      ? buildClozePromptWithHint(question.prompt || "請作答", clozeHint)
      : question.prompt || "請作答";

    area.innerHTML = `
      <div class="practice-question">
        <div class="practice-meta">
          <span class="pill">${state.index + 1} / ${state.questions.length}</span>
          <span class="muted">${escapeHtml(question.reference.sourceName)} / ${escapeHtml(question.reference.unitName)}</span>
        </div>
        <div class="progress-track"><span style="width: ${progress}%"></span></div>
        ${renderQuestionTimer(question, answerState)}
        <div class="question-panel ${isCloze ? "cloze-question-panel" : ""}">
          <div class="practice-meta">
            <h2>${modeMeta.label}</h2>
          </div>
          ${renderPracticeText(promptText, isCloze ? "question-prompt cloze-prompt" : "question-prompt", {
            maxLines: isCloze ? 4 : question.mode === "zh_to_en" || question.mode === "type_en_from_zh" ? 2 : 3,
            preserveParentheses: isCloze
          })}
          <div class="muted small-text">詞性：${escapeHtml(question.reference.tense || "未提供")}</div>
          ${isCloze ? renderClozeTranslationHint(question) : ""}
          ${
            question.mode === "type_en_from_zh"
              ? `<div class="muted small-text">KK：${escapeHtml(question.reference.kk || "未提供")}</div>`
              : ""
          }
          ${question.questionType === "typing" ? buildTypingControls(question, answerState) : renderChoices(question, answerState)}
          ${renderFeedback(question, answerState)}
        </div>
      </div>
    `;

    const ttsEnabled = document.getElementById("ttsEnabled");
    if (ttsEnabled) {
      ttsEnabled.addEventListener("change", (event) => {
        state.typingTtsEnabled = event.target.checked;
        if (state.typingTtsEnabled && !answerState.checked) {
          speakText(question.reference.eng);
        } else {
          cancelSpeech();
        }
      });
    }

    document.getElementById("speakBtn")?.addEventListener("click", () => speakText(question.reference.eng, { delay: 80, force: true }));
    preloadUpcomingQuestionAudio();

    if (question.questionType === "choice") {
      document.querySelectorAll("[data-choice]").forEach((button) => {
        button.addEventListener("click", (event) => {
          if (state.locked) return;
          handleAnswer(decodeURIComponent(event.currentTarget.dataset.choice));
        });
      });
      startQuestionTimer(question, answerState);
      return;
    }

    const typingInput = document.getElementById("typingAnswer");
    const submitBtn = document.getElementById("typingSubmitBtn");
    const triggerTypingSubmit = () => {
      if (state.locked) return;
      handleAnswer(typingInput.value.trim());
    };

    submitBtn.addEventListener("click", triggerTypingSubmit);
    typingInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        triggerTypingSubmit();
      }
    });

    if (!answerState.checked) {
      window.setTimeout(() => typingInput.focus(), 100);
      if (question.mode === "type_en_from_zh") {
        speakText(question.reference.eng);
      }
    }

    startQuestionTimer(question, answerState);
  }

  async function handleAnswer(answer, { timedOut = false } = {}) {
    if (state.locked) return;

    const question = currentQuestion();
    const finalAnswer = (answer || "").trim();

    if (!timedOut && !finalAnswer && question.questionType === "typing") {
      showMessage("請先輸入答案。");
      return;
    }

    const correct = timedOut ? false : evaluateAnswer(question, finalAnswer);
    state.answers[state.index] = {
      answer: finalAnswer,
      checked: true,
      correct,
      timedOut
    };

    state.locked = true;
    clearQuestionTimer();
    renderQuestion();

    const nextDelay = getNextQuestionDelayMs();
    clearPendingNextQuestion();
    state.nextQuestionTimerId = window.setTimeout(async () => {
      state.nextQuestionTimerId = null;
      state.locked = false;
      if (state.index === state.questions.length - 1) {
        await submitAnswers();
      } else {
        state.index += 1;
        renderQuestion();
      }
    }, nextDelay);
  }

  function buildResultSummary(result) {
    const wrongResults = result.results.filter((item) => !item.correct);
    state.retryQuestions = wrongResults.map((item) => state.questions[item.questionIndex]).filter(Boolean);

    const wrongListHtml = wrongResults.length
      ? `
          <div class="wrong-summary">
            <h3 class="summary-title">錯題</h3>
            <div class="summary-list">
              ${wrongResults
                .map((resultItem) => {
                  const question = state.questions[resultItem.questionIndex];
                  const localRecord = state.answers[resultItem.questionIndex];
                  if (!question) return "";
                  const wordLink = `/words.html?wordRef=${encodeURIComponent(resultItem.wordRef)}`;
                  const context = question.mode === "cloze_en"
                    ? question.prompt
                    : question.reference.practiceMeaning || question.reference.ch || "";
                  return `
                    <div class="summary-item">
                      <div class="summary-word-row">
                        <a class="summary-eng-link" href="${wordLink}">
                          <span class="summary-eng"><strong>${escapeHtml(question.reference.eng)}</strong></span>
                        </a>
                        ${renderCompactValue(context, "summary-zh", { maxLines: 2 })}
                      </div>
                      <div class="summary-ans-row">
                        <span>${escapeHtml(MODE_META[question.mode]?.label || "練習")}</span>
                        <span class="your-ans-value">${escapeHtml(localRecord?.timedOut ? "逾時未作答" : localRecord?.answer || "未作答")}</span>
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        `
      : '<div class="perfect-box">全部答對。</div>';

    return `
      <div class="practice-result-container">
        <div class="result-header">
          <h2>練習結果</h2>
          <div class="score-circle">
            <span class="score-num">${result.accuracy}</span>
            <span class="score-unit">%</span>
          </div>
          <p class="score-detail">答對 ${result.correctAnswers} / ${result.totalQuestions} 題</p>
        </div>
        ${wrongListHtml}
        <div class="practice-actions">
          ${state.retryQuestions.length ? '<button type="button" id="retryWrongBtn" class="primary-btn">重練錯題</button>' : ""}
          <button type="button" id="restartPracticeBtn" class="ghost-btn">回到設定</button>
        </div>
      </div>
    `;
  }

  async function submitAnswers() {
    clearPracticeTimers();
    const payloadAnswers = state.questions.map((question, index) => ({
      wordId: question.wordId,
      wordRef: question.wordRef,
      mode: question.mode,
      prompt: question.prompt,
      expectedAnswer: question.expectedAnswer,
      clozeAnswer: question.clozeAnswer || "",
      reference: question.reference,
      answer: state.answers[index]?.answer || ""
    }));

    try {
      const result = await api("/api/practice/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionModes: [...new Set(state.questions.map((question) => question.mode))],
          answers: payloadAnswers
        })
      });

      const area = document.getElementById("practiceArea");
      area.innerHTML = buildResultSummary(result);

      document.getElementById("restartPracticeBtn")?.addEventListener("click", () => {
        clearPracticeTimers();
        document.getElementById("setupCard").style.display = "grid";
        area.textContent = "選擇範圍與題型後開始練習。";
        area.classList.add("empty");
        setPracticeKind(state.currentPracticeKind);
      });

      document.getElementById("retryWrongBtn")?.addEventListener("click", () => {
        clearPracticeTimers();
        state.questions = [...state.retryQuestions];
        state.answers = [];
        state.index = 0;
        state.locked = false;
        renderQuestion();
      });
    } catch (error) {
      showMessage(`提交練習結果失敗：${error.message}`);
      state.locked = false;
    }
  }

  function validateLimit(limitValue, availableQuestionCount, minLimit = 10) {
    if (availableQuestionCount < 1) {
      return "目前範圍沒有可出題目。";
    }
    if (!Number.isInteger(limitValue) || limitValue < 1) {
      return "題數需為大於 0 的整數。";
    }
    if (limitValue > PRACTICE_MAX_QUESTIONS) {
      return `單次練習最多 ${PRACTICE_MAX_QUESTIONS} 題。`;
    }
    if (limitValue < minLimit && availableQuestionCount >= minLimit) {
      return `題數至少需要 ${minLimit} 題。`;
    }
    if (limitValue > availableQuestionCount) {
      return `目前最多可出 ${availableQuestionCount} 題。`;
    }
    return "";
  }

  async function loadPractice(kind = "normal") {
    clearPracticeTimers();

    if (state.generationAbortController) {
      return;
    }

    const isCloze = kind === "cloze";
    const limitInput = document.getElementById(isCloze ? "clozeLimit" : "practiceLimit");
    const limitValue = Number(limitInput.value);
    const selectedModes = isCloze ? ["cloze_en"] : getSelectedModes();
    let availableQuestionCount = isCloze ? getClozeAvailableCount() : getNormalAvailableCount();

    if (!isCloze && !selectedModes.length) {
      showMessage("請至少選擇一種一般練習題型。");
      return;
    }

    const validationMessage = validateLimit(limitValue, availableQuestionCount, isCloze ? 1 : 10);
    if (validationMessage) {
      showMessage(validationMessage);
      return;
    }

    const params = buildAvailabilityParams();
    params.set("limit", String(limitValue));
    params.set("modes", selectedModes.join(","));
    const controller = new AbortController();
    state.generationAbortController = controller;
    try {
      const data = await api(`/api/practice/session?${params.toString()}`, {
        signal: controller.signal,
        loading: {
          title: isCloze ? "正在生成克漏字題目" : "正在生成練習題目",
          detail: "題數較多時需要一點時間。",
          showOverlay: true,
          revealDelay: 0,
          cancelLabel: "取消生成",
          onCancel: () => controller.abort()
        }
      });

      if (data.availability) {
        state.availability = {
          wordCount: Number(data.availability.wordCount || 0),
          allMeaningCount: Number(data.availability.allMeaningCount || 0),
          clozeAllCount: Number(data.availability.clozeAllCount || data.availability.clozeCount || 0)
        };
        state.availabilityLoaded = true;
        state.availabilitySignature = getAvailabilitySignature();
        updatePracticeSummaries(false);
      }

      state.questions = data.questions || [];
      state.answers = [];
      state.index = 0;
      state.retryQuestions = [];
      state.locked = false;
      state.currentPracticeKind = kind;

      if (!state.questions.length) {
        const area = document.getElementById("practiceArea");
        area.classList.add("empty");
        area.textContent = isCloze ? "目前範圍沒有可用克漏字題目。" : "目前範圍沒有可用題目。";
        return;
      }

      renderQuestion();
    } catch (error) {
      showMessage(controller.signal.aborted ? "已取消題目生成。" : error.message);
    } finally {
      if (state.generationAbortController === controller) {
        state.generationAbortController = null;
      }
    }
  }

  function bindModeSelectors() {
    document.querySelectorAll('input[name="practiceModes"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!getSelectedModes().length) input.checked = true;
        updateModeCardState();
      });
    });
    updateModeCardState();
  }

  function bindPracticeKindSwitch() {
    const buttons = document.querySelectorAll("[data-practice-kind]");
    if (!buttons.length) {
      return;
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        setPracticeKind(button.dataset.practiceKind || "normal");
      });
    });

    setPracticeKind(state.currentPracticeKind);
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    bindModeSelectors();
    bindPracticeKindSwitch();
    await loadSources();

    document.getElementById("practiceSource").addEventListener("change", (event) => {
      state.availabilityLoaded = false;
      renderUnitOptions(event.target.value);
    });

    document.getElementById("practiceScopeSwitch")?.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".practice-scope-option");
      if (!button) return;
      const isStarred = button.dataset.scope === "starred";
      if (isStarred === Boolean(state.starredOnly)) return;
      setStarredOnly(isStarred);
    });

    document.getElementById("practiceStarredOnly")?.addEventListener("change", (event) => {
      setStarredOnly(event.target.checked);
    });

    document.getElementById("loadPracticeBtn").addEventListener("click", () => loadPractice("normal"));
    document.getElementById("loadClozeBtn").addEventListener("click", () => loadPractice("cloze"));
    window.addEventListener("pagehide", () => {
      clearPracticeTimers();
      state.generationAbortController?.abort();
    });
  }

  return { init };
})();

PracticePage.init().catch((error) => window.WordsApp.showMessage(error.message));
