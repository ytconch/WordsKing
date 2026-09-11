(function bootstrapShared() {
  const TOKEN_KEY = "wordsKingToken";
  const USER_KEY = "wordsKingUser";
  const GUEST_TOKEN_KEY = "wordsKingGuestToken";
  const GUEST_USER_KEY = "wordsKingGuestUser";

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function readStoredUser(storage, key) {
    const raw = storage.getItem(key);
    if (!raw || raw === "undefined" || raw === "null") {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      storage.removeItem(key);
      return null;
    }
  }

  const guestToken = sessionStorage.getItem(GUEST_TOKEN_KEY) || "";
  const guestUser = readStoredUser(sessionStorage, GUEST_USER_KEY);
  const state = {
    token: guestToken && guestUser ? guestToken : localStorage.getItem(TOKEN_KEY) || "",
    user: guestToken && guestUser ? guestUser : readStoredUser(localStorage, USER_KEY),
    unreadCount: 0
  };

  const requestLoadingState = {
    shell: null,
    overlay: null,
    title: null,
    detail: null,
    cancel: null,
    active: new Map()
  };
  const ttsState = {
    requestId: 0,
    timer: 0,
    voicesPromise: null,
    audioSessionRequestId: 0,
    audioSessionRestoreType: "auto",
    audioContext: null,
    preferredVoiceCacheKey: "",
    preferredVoiceUri: "",
    audioElement: null,
    audioObjectUrl: "",
    audioObjectUrlCacheKey: "",
    pronunciationMetadataCache: new Map(),
    pronunciationAudioObjectUrlCache: new Map(),
    pronunciationPreloadQueue: [],
    pronunciationPreloadQueuedWords: new Set(),
    pronunciationPreloadMissCache: new Map(),
    pronunciationServerPrefetchAt: new Map(),
    pronunciationPreloadTimer: 0,
    pronunciationPreloadInFlight: false,
    audioAbortController: null
  };
  const visitLoggingState = {
    loggedPage: "",
    sessionId: 0,
    heartbeatTimer: 0,
    starting: false
  };
  const headerMenuState = {
    collapsed: false,
    open: false,
    observer: null
  };

  const page = document.body.dataset.page || "home";
  const protectedPages = new Set([
    "words",
    "practice",
    "leaderboard",
    "analytics",
    "notifications",
    "admin",
    "settings"
  ]);

  try {
    sessionStorage.removeItem("wordsKingTutorialStep");
    sessionStorage.removeItem("wordsKingTutorialActive");
    sessionStorage.removeItem("wordsKingTutorialPaused");
  } catch {}

  const TTS_PREFERRED_ENGLISH_LOCALES = ["en-us", "en-gb", "en-au", "en-ca", "en-ie", "en-nz", "en-in", "en-sg"];
  const TTS_TRUSTED_ENGINE_HINTS = [
    "google",
    "microsoft",
    "apple",
    "samsung",
    "natural",
    "neural",
    "enhanced",
    "premium"
  ];
  const TTS_AVOID_ENGINE_HINTS = ["espeak", "festival", "mbrola", "speech dispatcher", "flite", "pico"];
  const TTS_PREMIUM_VOICE_HINTS = [
    "online natural",
    "natural",
    "neural",
    "premium",
    "enhanced",
    "google us english",
    "google uk english",
    "microsoft aria online",
    "microsoft jenny online",
    "microsoft libby online",
    "microsoft guy online",
    "microsoft ryan online",
    "samantha",
    "allison",
    "ava",
    "daniel",
    "alex",
    "serena",
    "nicky",
    "moira"
  ];
  const TTS_AVOID_NOVELTY_HINTS = [
    "albert",
    "bahh",
    "bubbles",
    "wobble",
    "zarvox",
    "trinoids",
    "bells",
    "boing",
    "whisper",
    "good news",
    "bad news",
    "hysterical",
    "princess",
    "superstar",
    "junior",
    "organ",
    "cello",
    "cellos",
    "deranged",
    "robot",
    "novelty"
  ];
  const TTS_PRONUNCIATION_FETCH_TIMEOUT_MS = 1800;
  const TTS_PRONUNCIATION_PRELOAD_TIMEOUT_MS = 1800;
  const TTS_PRONUNCIATION_OBJECT_URL_CACHE_LIMIT = 24;
  const TTS_PRONUNCIATION_METADATA_CACHE_LIMIT = 48;
  const TTS_PRONUNCIATION_PRELOAD_QUEUE_LIMIT = 18;
  const TTS_PRONUNCIATION_PRELOAD_BATCH_LIMIT = 3;
  const TTS_PRONUNCIATION_PRELOAD_INTERVAL_MS = 1400;
  const TTS_PRONUNCIATION_PRELOAD_MISS_TTL_MS = 10 * 60 * 1000;
  const TTS_SERVER_PREFETCH_DEDUPE_MS = 45 * 1000;

  function applyTheme(theme) {
    document.body.dataset.theme = theme || state.user?.theme || "sage";
  }

  function hasSpeechSupport() {
    return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function hasPronunciationAudioSupport() {
    return (
      typeof window !== "undefined" &&
      typeof window.Audio === "function" &&
      typeof window.fetch === "function" &&
      typeof window.URL !== "undefined" &&
      typeof window.URL.createObjectURL === "function"
    );
  }

  function clampClientTtsRate(value, fallback = 0.9) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Number(Math.min(1.4, Math.max(0.6, parsed)).toFixed(2));
  }

  function getTtsSettings() {
    return {
      rate: 0.95,
      repeatCount: 1
    };
  }

  function hasActiveUserGesture() {
    return Boolean(
      typeof navigator !== "undefined" &&
        navigator.userActivation &&
        navigator.userActivation.isActive
    );
  }

  function primeSpeechSynthesis() {
    if (!hasSpeechSupport()) {
      return;
    }

    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      window.speechSynthesis.getVoices();
    } catch {}
  }

  function getEnglishSpeechVoices() {
    if (!hasSpeechSupport()) {
      return [];
    }

    return window.speechSynthesis
      .getVoices()
      .filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang) || /english/i.test(voice.name));
  }

  async function ensureSpeechVoices(timeoutMs = 1200) {
    const voices = getEnglishSpeechVoices();
    if (voices.length || !hasSpeechSupport()) {
      return voices;
    }

    if (!ttsState.voicesPromise) {
      ttsState.voicesPromise = new Promise((resolve) => {
        let settled = false;
        let timeoutId = 0;

        const cleanup = () => {
          window.clearTimeout(timeoutId);
          if (typeof window.speechSynthesis.removeEventListener === "function") {
            window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
          } else {
            window.speechSynthesis.onvoiceschanged = null;
          }
        };

        const finish = () => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(getEnglishSpeechVoices());
        };

        const handleVoicesChanged = () => {
          if (getEnglishSpeechVoices().length) {
            finish();
          }
        };

        timeoutId = window.setTimeout(finish, timeoutMs);
        if (typeof window.speechSynthesis.addEventListener === "function") {
          window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged, { once: true });
        } else {
          window.speechSynthesis.onvoiceschanged = handleVoicesChanged;
        }
        primeSpeechSynthesis();
      }).finally(() => {
        ttsState.voicesPromise = null;
      });
    }

    return ttsState.voicesPromise;
  }

  function countVoiceHintMatches(haystack, hints = []) {
    return hints.reduce((total, hint) => total + (haystack.includes(hint) ? 1 : 0), 0);
  }

  function getSpeechVoiceHaystack(voice) {
    return `${voice.name} ${voice.lang} ${voice.voiceURI || ""}`.toLowerCase();
  }

  function normalizeSpeechLang(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replaceAll("_", "-");
  }

  function buildSpeechVoiceCacheKey(voices) {
    return voices
      .map((voice) => `${voice.voiceURI || ""}::${voice.name || ""}::${normalizeSpeechLang(voice.lang)}`)
      .join("|");
  }

  function isTrustedSpeechVoice(voice) {
    const haystack = getSpeechVoiceHaystack(voice);
    return Boolean(
      voice.default ||
        voice.localService ||
        TTS_TRUSTED_ENGINE_HINTS.some((hint) => haystack.includes(hint))
    );
  }

  function isAvoidedSpeechVoice(voice) {
    const haystack = getSpeechVoiceHaystack(voice);
    return (
      TTS_AVOID_ENGINE_HINTS.some((hint) => haystack.includes(hint)) ||
      TTS_AVOID_NOVELTY_HINTS.some((hint) => haystack.includes(hint))
    );
  }

  function scoreSpeechVoice(voice) {
    const haystack = getSpeechVoiceHaystack(voice);
    let score = 0;
    const lang = normalizeSpeechLang(voice.lang);
    const localeIndex = TTS_PREFERRED_ENGLISH_LOCALES.indexOf(lang);

    if (localeIndex >= 0) {
      score += 36 - localeIndex;
    } else if (/^en-/.test(lang)) {
      score += 24;
    } else if (lang === "en") {
      score += 20;
    }

    if (voice.default) score += 7;
    if (voice.localService) score += 2;
    if (/natural|neural|online|premium|enhanced/i.test(haystack)) score += 10;
    if (isTrustedSpeechVoice(voice)) score += 6;
    score += countVoiceHintMatches(haystack, TTS_TRUSTED_ENGINE_HINTS) * 3;
    score += countVoiceHintMatches(haystack, TTS_PREMIUM_VOICE_HINTS) * 4;
    if (/english/i.test(haystack)) score += 2;
    if (/compact|embedded|basic|legacy/i.test(haystack)) score -= 8;
    if (isAvoidedSpeechVoice(voice)) score -= 80;

    return score;
  }

  async function pickSpeechVoice() {
    const voices = await ensureSpeechVoices();
    if (!voices.length) {
      return null;
    }

    const cacheKey = buildSpeechVoiceCacheKey(voices);
    if (ttsState.preferredVoiceCacheKey === cacheKey && ttsState.preferredVoiceUri) {
      const cachedVoice = voices.find((voice) => String(voice.voiceURI || "") === ttsState.preferredVoiceUri);
      if (cachedVoice && !isAvoidedSpeechVoice(cachedVoice)) {
        return cachedVoice;
      }
    }

    const ranked = voices
      .map((voice) => ({
        voice,
        score: scoreSpeechVoice(voice)
      }))
      .sort((left, right) => right.score - left.score);

    const safeBest = ranked.find((entry) => !isAvoidedSpeechVoice(entry.voice)) || null;
    ttsState.preferredVoiceCacheKey = cacheKey;
    ttsState.preferredVoiceUri = safeBest?.voice?.voiceURI || "";
    return safeBest?.voice || null;
  }

  function getSpeechPitch() {
    return 1;
  }

  function normalizeSpeechText(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
  }

  function looksLikeDictionaryHeadword(text) {
    if (!text || /[.!?;:,。！？；：]$/.test(text)) {
      return false;
    }

    if (!/[A-Za-z]/.test(text)) {
      return false;
    }

    const compact = text.replace(/\s+/g, " ");
    if (!/^[A-Za-z][A-Za-z' -]*$/.test(compact)) {
      return false;
    }

    const wordCount = compact.split(" ").filter(Boolean).length;
    return wordCount >= 1 && wordCount <= 4;
  }

  function buildSpeechUtteranceText(text, options = {}) {
    const normalized = normalizeSpeechText(text);
    if (!normalized) {
      return "";
    }

    if (options.dictionaryTone !== false && looksLikeDictionaryHeadword(normalized)) {
      return `${normalized}.`;
    }

    return normalized;
  }

  function isPronunciationAudioCandidate(text, options = {}) {
    if (options.usePronunciationAudio === false || !hasPronunciationAudioSupport()) {
      return false;
    }

    return looksLikeDictionaryHeadword(normalizeSpeechText(text));
  }

  function createTtsFetchHeaders() {
    const headers = {};
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    return headers;
  }

  function clearPronunciationFetchController() {
    if (!ttsState.audioAbortController) {
      return;
    }

    try {
      ttsState.audioAbortController.abort();
    } catch {}
    ttsState.audioAbortController = null;
  }

  function revokePronunciationObjectUrl(objectUrl) {
    if (!objectUrl) {
      return;
    }

    try {
      window.URL.revokeObjectURL(objectUrl);
    } catch {}
  }

  function getCachedPronunciationObjectUrl(cacheKey) {
    if (!cacheKey || !ttsState.pronunciationAudioObjectUrlCache.has(cacheKey)) {
      return "";
    }

    const objectUrl = ttsState.pronunciationAudioObjectUrlCache.get(cacheKey);
    ttsState.pronunciationAudioObjectUrlCache.delete(cacheKey);
    ttsState.pronunciationAudioObjectUrlCache.set(cacheKey, objectUrl);
    return objectUrl;
  }

  function getCachedPronunciationMetadata(word) {
    const key = normalizeSpeechText(word);
    if (!key || !ttsState.pronunciationMetadataCache.has(key)) {
      return null;
    }

    const metadata = ttsState.pronunciationMetadataCache.get(key);
    ttsState.pronunciationMetadataCache.delete(key);
    ttsState.pronunciationMetadataCache.set(key, metadata);
    return metadata;
  }

  function cachePronunciationMetadata(word, metadata) {
    const key = normalizeSpeechText(word || metadata?.word || "");
    if (!key || !metadata?.available || !metadata.audioUrl || !metadata.cacheKey) {
      return;
    }

    ttsState.pronunciationMetadataCache.delete(key);
    ttsState.pronunciationMetadataCache.set(key, metadata);

    while (ttsState.pronunciationMetadataCache.size > TTS_PRONUNCIATION_METADATA_CACHE_LIMIT) {
      const oldestKey = ttsState.pronunciationMetadataCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      ttsState.pronunciationMetadataCache.delete(oldestKey);
    }
  }

  function cachePronunciationObjectUrl(cacheKey, objectUrl) {
    if (!cacheKey || !objectUrl) {
      return;
    }

    const existingObjectUrl = ttsState.pronunciationAudioObjectUrlCache.get(cacheKey);
    if (existingObjectUrl && existingObjectUrl !== objectUrl) {
      revokePronunciationObjectUrl(existingObjectUrl);
    }

    ttsState.pronunciationAudioObjectUrlCache.delete(cacheKey);
    ttsState.pronunciationAudioObjectUrlCache.set(cacheKey, objectUrl);

    while (ttsState.pronunciationAudioObjectUrlCache.size > TTS_PRONUNCIATION_OBJECT_URL_CACHE_LIMIT) {
      const oldestEntry = ttsState.pronunciationAudioObjectUrlCache.entries().next().value;
      if (!oldestEntry) {
        break;
      }

      const [oldestCacheKey, oldestObjectUrl] = oldestEntry;
      ttsState.pronunciationAudioObjectUrlCache.delete(oldestCacheKey);
      if (oldestObjectUrl !== ttsState.audioObjectUrl) {
        revokePronunciationObjectUrl(oldestObjectUrl);
      }
    }
  }

  function clearPronunciationObjectUrlCache() {
    window.clearTimeout(ttsState.pronunciationPreloadTimer);
    ttsState.pronunciationPreloadTimer = 0;
    ttsState.pronunciationPreloadQueue = [];
    ttsState.pronunciationPreloadQueuedWords.clear();
    ttsState.pronunciationPreloadInFlight = false;
    for (const objectUrl of ttsState.pronunciationAudioObjectUrlCache.values()) {
      revokePronunciationObjectUrl(objectUrl);
    }
    ttsState.pronunciationAudioObjectUrlCache.clear();
    ttsState.pronunciationMetadataCache.clear();
    ttsState.pronunciationPreloadMissCache.clear();
    ttsState.pronunciationServerPrefetchAt.clear();
    ttsState.audioObjectUrl = "";
    ttsState.audioObjectUrlCacheKey = "";
  }

  function releasePronunciationAudio() {
    clearPronunciationFetchController();

    const audio = ttsState.audioElement;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {}
    }

    if (ttsState.audioObjectUrl) {
      const cachedObjectUrl = getCachedPronunciationObjectUrl(ttsState.audioObjectUrlCacheKey);
      if (cachedObjectUrl !== ttsState.audioObjectUrl) {
        revokePronunciationObjectUrl(ttsState.audioObjectUrl);
      }
      ttsState.audioObjectUrl = "";
      ttsState.audioObjectUrlCacheKey = "";
    }
  }

  function getPronunciationAudioElement() {
    if (!ttsState.audioElement) {
      ttsState.audioElement = new Audio();
      ttsState.audioElement.preload = "auto";
      ttsState.audioElement.crossOrigin = "same-origin";
    }

    return ttsState.audioElement;
  }

  function createPronunciationAbortSignal() {
    if (typeof window.AbortController !== "function") {
      return null;
    }

    clearPronunciationFetchController();
    ttsState.audioAbortController = new AbortController();
    return ttsState.audioAbortController.signal;
  }

  async function fetchPronunciationMetadata(word, requestId) {
    if (!state.token || requestId !== ttsState.requestId) {
      return null;
    }

    const cachedMetadata = getCachedPronunciationMetadata(word);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    const signal = createPronunciationAbortSignal();
    const timeoutId = window.setTimeout(clearPronunciationFetchController, TTS_PRONUNCIATION_FETCH_TIMEOUT_MS);
    let response;
    let data;

    try {
      response = await fetch(`/api/tts/pronunciation?word=${encodeURIComponent(word)}`, {
        headers: createTtsFetchHeaders(),
        credentials: "same-origin",
        signal
      });
      data = await response.json().catch(() => ({}));
    } finally {
      window.clearTimeout(timeoutId);
    }

    if (requestId !== ttsState.requestId) {
      return null;
    }

    if (!response.ok) {
      if (response.status === 401) {
        setAuth(null);
      }
      return null;
    }

    if (data && data.available && data.audioUrl) {
      cachePronunciationMetadata(word, data);
      return data;
    }

    return null;
  }

  async function fetchPronunciationAudioObjectUrl(metadata, requestId) {
    const audioUrl = metadata?.audioUrl || "";
    const cacheKey = metadata?.cacheKey || "";

    if (!audioUrl || requestId !== ttsState.requestId) {
      return null;
    }

    const cachedObjectUrl = getCachedPronunciationObjectUrl(cacheKey);
    if (cachedObjectUrl) {
      return {
        objectUrl: cachedObjectUrl,
        cacheKey
      };
    }

    const signal = createPronunciationAbortSignal();
    const timeoutId = window.setTimeout(clearPronunciationFetchController, TTS_PRONUNCIATION_FETCH_TIMEOUT_MS);
    let response;

    try {
      response = await fetch(`${audioUrl}${audioUrl.includes("?") ? "&" : "?"}intent=play`, {
        headers: createTtsFetchHeaders(),
        credentials: "same-origin",
        signal
      });
    } finally {
      window.clearTimeout(timeoutId);
    }

    if (requestId !== ttsState.requestId) {
      return null;
    }

    if (!response.ok) {
      if (response.status === 401) {
        setAuth(null);
      }
      return null;
    }

    const blob = await response.blob();
    if (!blob.size || requestId !== ttsState.requestId) {
      return null;
    }

    const objectUrl = window.URL.createObjectURL(blob);
    cachePronunciationObjectUrl(cacheKey, objectUrl);
    return {
      objectUrl,
      cacheKey
    };
  }

  async function fetchWithClientTimeout(url, options = {}, timeoutMs = TTS_PRONUNCIATION_PRELOAD_TIMEOUT_MS) {
    if (typeof window.AbortController !== "function") {
      return fetch(url, options);
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function rememberPronunciationPreloadMiss(word) {
    const key = normalizeSpeechText(word);
    if (!key) {
      return;
    }

    ttsState.pronunciationPreloadMissCache.set(key, Date.now() + TTS_PRONUNCIATION_PRELOAD_MISS_TTL_MS);
    while (ttsState.pronunciationPreloadMissCache.size > TTS_PRONUNCIATION_METADATA_CACHE_LIMIT * 2) {
      const oldestKey = ttsState.pronunciationPreloadMissCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      ttsState.pronunciationPreloadMissCache.delete(oldestKey);
    }
  }

  function hasRecentPronunciationPreloadMiss(word) {
    const key = normalizeSpeechText(word);
    if (!key || !ttsState.pronunciationPreloadMissCache.has(key)) {
      return false;
    }

    const expiresAt = Number(ttsState.pronunciationPreloadMissCache.get(key) || 0);
    if (expiresAt > Date.now()) {
      return true;
    }

    ttsState.pronunciationPreloadMissCache.delete(key);
    return false;
  }

  async function fetchPronunciationMetadataForPreload(word) {
    if (!state.token || !hasPronunciationAudioSupport() || hasRecentPronunciationPreloadMiss(word)) {
      return null;
    }

    const cachedMetadata = getCachedPronunciationMetadata(word);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    const response = await fetchWithClientTimeout(
      `/api/tts/pronunciation?word=${encodeURIComponent(word)}&cacheOnly=1&prefetch=1`,
      {
        headers: createTtsFetchHeaders(),
        credentials: "same-origin"
      }
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401) {
        setAuth(null);
      }
      rememberPronunciationPreloadMiss(word);
      return null;
    }

    if (data?.available && data.audioUrl && data.cacheKey) {
      cachePronunciationMetadata(word, data);
      return data;
    }

    return null;
  }

  async function requestPronunciationPrefetch(words) {
    if (!state.token || !hasPronunciationAudioSupport()) {
      return;
    }

    const now = Date.now();
    const candidates = [...new Set(words.map((word) => normalizeSpeechText(word)).filter((word) => word && looksLikeDictionaryHeadword(word)))]
      .filter((word) => now - Number(ttsState.pronunciationServerPrefetchAt.get(word) || 0) >= TTS_SERVER_PREFETCH_DEDUPE_MS)
      .slice(0, TTS_PRONUNCIATION_PRELOAD_BATCH_LIMIT);
    if (!candidates.length) {
      return;
    }

    candidates.forEach((word) => ttsState.pronunciationServerPrefetchAt.set(word, now));
    try {
      const response = await fetchWithClientTimeout(
        "/api/tts/pronunciation/prefetch",
        {
          method: "POST",
          headers: {
            ...createTtsFetchHeaders(),
            "Content-Type": "application/json"
          },
          credentials: "same-origin",
          body: JSON.stringify({ words: candidates })
        },
        TTS_PRONUNCIATION_PRELOAD_TIMEOUT_MS
      );
      if (response.status === 401) {
        setAuth(null);
      }
      if (!response.ok) {
        candidates.forEach((word) => ttsState.pronunciationServerPrefetchAt.delete(word));
      }
    } catch {
      candidates.forEach((word) => ttsState.pronunciationServerPrefetchAt.delete(word));
    }
  }

  async function fetchPronunciationAudioObjectUrlForPreload(metadata) {
    const audioUrl = metadata?.audioUrl || "";
    const cacheKey = metadata?.cacheKey || "";
    if (!audioUrl || !cacheKey || getCachedPronunciationObjectUrl(cacheKey)) {
      return false;
    }

    const response = await fetchWithClientTimeout(audioUrl, {
      headers: createTtsFetchHeaders(),
      credentials: "same-origin"
    });

    if (!response.ok) {
      if (response.status === 401) {
        setAuth(null);
      }
      return false;
    }

    const blob = await response.blob();
    if (!blob.size) {
      return false;
    }

    cachePronunciationObjectUrl(cacheKey, window.URL.createObjectURL(blob));
    return true;
  }

  function schedulePronunciationPreload(delayMs = TTS_PRONUNCIATION_PRELOAD_INTERVAL_MS) {
    if (ttsState.pronunciationPreloadTimer || ttsState.pronunciationPreloadInFlight) {
      return;
    }

    ttsState.pronunciationPreloadTimer = window.setTimeout(processPronunciationPreloadQueue, Math.max(0, delayMs));
  }

  async function processPronunciationPreloadQueue() {
    ttsState.pronunciationPreloadTimer = 0;

    if (ttsState.pronunciationPreloadInFlight || !ttsState.pronunciationPreloadQueue.length) {
      return;
    }

    if (!state.token || !hasPronunciationAudioSupport()) {
      ttsState.pronunciationPreloadQueue = [];
      ttsState.pronunciationPreloadQueuedWords.clear();
      return;
    }

    const word = ttsState.pronunciationPreloadQueue.shift();
    ttsState.pronunciationPreloadQueuedWords.delete(word);
    ttsState.pronunciationPreloadInFlight = true;

    try {
      const metadata = await fetchPronunciationMetadataForPreload(word);
      if (metadata) {
        await fetchPronunciationAudioObjectUrlForPreload(metadata);
      }
    } catch {
      rememberPronunciationPreloadMiss(word);
    } finally {
      ttsState.pronunciationPreloadInFlight = false;
      if (ttsState.pronunciationPreloadQueue.length) {
        schedulePronunciationPreload(TTS_PRONUNCIATION_PRELOAD_INTERVAL_MS);
      }
    }
  }

  function preloadPronunciationWords(words = [], options = {}) {
    if (!state.token || !hasPronunciationAudioSupport()) {
      return;
    }

    const rawWords = Array.isArray(words) ? words : [words];
    const maxItems = Math.min(
      TTS_PRONUNCIATION_PRELOAD_BATCH_LIMIT,
      Math.max(1, Number(options.max ?? TTS_PRONUNCIATION_PRELOAD_BATCH_LIMIT) || TTS_PRONUNCIATION_PRELOAD_BATCH_LIMIT)
    );
    const candidates = [
      ...new Set(
        rawWords
          .map((word) => normalizeSpeechText(word))
          .filter((word) => word && looksLikeDictionaryHeadword(word))
      )
    ].slice(0, maxItems);

    requestPronunciationPrefetch(candidates);

    let added = false;
    for (const word of candidates) {
      const cachedMetadata = getCachedPronunciationMetadata(word);
      if (
        (cachedMetadata?.cacheKey && getCachedPronunciationObjectUrl(cachedMetadata.cacheKey)) ||
        hasRecentPronunciationPreloadMiss(word) ||
        ttsState.pronunciationPreloadQueuedWords.has(word)
      ) {
        continue;
      }

      ttsState.pronunciationPreloadQueue.push(word);
      ttsState.pronunciationPreloadQueuedWords.add(word);
      added = true;

      while (ttsState.pronunciationPreloadQueue.length > TTS_PRONUNCIATION_PRELOAD_QUEUE_LIMIT) {
        const removed = ttsState.pronunciationPreloadQueue.shift();
        ttsState.pronunciationPreloadQueuedWords.delete(removed);
      }
    }

    if (added) {
      schedulePronunciationPreload(Math.max(0, Number(options.delay ?? 650) || 0));
    }
  }

  function waitForPronunciationRepeatDelay(requestId) {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        resolve(requestId === ttsState.requestId);
      }, 220);
    });
  }

  function playPronunciationAudioOnce(audio, requestId) {
    return new Promise((resolve) => {
      if (!audio || requestId !== ttsState.requestId) {
        resolve(false);
        return;
      }

      let settled = false;
      const timeoutId = window.setTimeout(() => finish(false), 9000);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("error", handleError);
      };

      const finish = (ok) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(ok);
      };

      const handleEnded = () => {
        finish(true);
      };

      const handleError = () => {
        finish(false);
      };

      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("error", handleError);

      try {
        audio.currentTime = 0;
      } catch {}

      audio.play().catch(() => {
        finish(false);
      });
    });
  }

  async function playPronunciationAudio(text, options, requestId) {
    if (!isPronunciationAudioCandidate(text, options) || requestId !== ttsState.requestId) {
      return false;
    }

    const metadata = await fetchPronunciationMetadata(normalizeSpeechText(text), requestId);
    if (!metadata || requestId !== ttsState.requestId) {
      return false;
    }

    const audioObject = await fetchPronunciationAudioObjectUrl(metadata, requestId);
    if (!audioObject?.objectUrl || requestId !== ttsState.requestId) {
      if (audioObject?.objectUrl && audioObject.objectUrl !== getCachedPronunciationObjectUrl(audioObject.cacheKey)) {
        revokePronunciationObjectUrl(audioObject.objectUrl);
      }
      return false;
    }

    releasePronunciationAudio();
    const audio = getPronunciationAudioElement();
    ttsState.audioObjectUrl = audioObject.objectUrl;
    ttsState.audioObjectUrlCacheKey = audioObject.cacheKey || "";
    audio.src = audioObject.objectUrl;
    audio.playbackRate = 1;
    audio.volume = 1;
    activateSpeechAudioSession(requestId);

    let ok = true;
    for (let round = 0; round < options.repeatCount; round += 1) {
      ok = await playPronunciationAudioOnce(audio, requestId);
      if (!ok || requestId !== ttsState.requestId) {
        break;
      }

      if (round + 1 < options.repeatCount) {
        const shouldContinue = await waitForPronunciationRepeatDelay(requestId);
        if (!shouldContinue) {
          ok = false;
          break;
        }
      }
    }

    if (requestId === ttsState.requestId) {
      releasePronunciationAudio();
      releaseSpeechAudioSession(requestId);
    }

    return ok;
  }

  function getSpeechAudioSession() {
    if (typeof navigator === "undefined" || !navigator.audioSession) {
      return null;
    }

    return navigator.audioSession;
  }

  function getSpeechAudioContext() {
    if (typeof window === "undefined") {
      return null;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      return null;
    }

    if (!ttsState.audioContext) {
      try {
        ttsState.audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
      } catch {
        ttsState.audioContext = null;
      }
    }

    return ttsState.audioContext;
  }

  async function resumeSpeechAudioContext() {
    const audioContext = getSpeechAudioContext();
    if (!audioContext) {
      return null;
    }

    try {
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
    } catch {}

    return audioContext;
  }

  function playSpeechFocusPulse(audioContext) {
    if (!audioContext) {
      return;
    }

    try {
      const now = audioContext.currentTime;
      const duration = 0.05;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.00001, now);
      gain.gain.linearRampToValueAtTime(0.0002, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + duration);
      oscillator.onended = () => {
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {}
      };
    } catch {}
  }

  function activateSpeechAudioSession(requestId) {
    const audioSession = getSpeechAudioSession();
    if (!audioSession || requestId !== ttsState.requestId) {
      return;
    }

    if (ttsState.audioSessionRequestId === requestId) {
      return;
    }

    try {
      ttsState.audioSessionRestoreType =
        typeof audioSession.type === "string" && audioSession.type ? audioSession.type : "auto";
      audioSession.type = "transient-solo";
      ttsState.audioSessionRequestId = requestId;
    } catch {
      ttsState.audioSessionRequestId = 0;
      ttsState.audioSessionRestoreType = "auto";
    }
  }

  async function primeSpeechAudioFocus(requestId, options = {}) {
    if (!requestId || requestId !== ttsState.requestId) {
      return;
    }

    activateSpeechAudioSession(requestId);
    const audioContext = await resumeSpeechAudioContext();
    if (!audioContext || !options.pulse) {
      return;
    }

    playSpeechFocusPulse(audioContext);
  }

  function releaseSpeechAudioSession(requestId) {
    if (!requestId || ttsState.audioSessionRequestId !== requestId) {
      return;
    }

    const audioSession = getSpeechAudioSession();
    const restoreType = ttsState.audioSessionRestoreType || "auto";
    ttsState.audioSessionRequestId = 0;
    ttsState.audioSessionRestoreType = "auto";

    if (!audioSession) {
      return;
    }

    try {
      audioSession.type = restoreType;
    } catch {}
  }

  function cancelSpeechPlayback() {
    const previousRequestId = ttsState.requestId;
    ttsState.requestId += 1;
    window.clearTimeout(ttsState.timer);
    releasePronunciationAudio();
    releaseSpeechAudioSession(previousRequestId);
    if (hasSpeechSupport()) {
      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch {}
    }
    return ttsState.requestId;
  }

  async function playSpeechRound(text, options, requestId, round, useBrowserDefaultVoice = false) {
    if (!hasSpeechSupport() || requestId !== ttsState.requestId) {
      return;
    }

    primeSpeechSynthesis();
    activateSpeechAudioSession(requestId);
    const selectedVoice = useBrowserDefaultVoice ? null : await pickSpeechVoice();
    if (requestId !== ttsState.requestId) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = selectedVoice?.lang || "en-US";
    utterance.rate = options.rate;
    utterance.pitch = getSpeechPitch();
    utterance.volume = 1;
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    let started = false;
    let finished = false;

    const finish = () => {
      if (finished) {
        return false;
      }
      finished = true;
      return true;
    };

    const retryWithFallback = () => {
      if (!finish() || requestId !== ttsState.requestId) {
        return;
      }

      window.clearTimeout(watchdogId);
      if (useBrowserDefaultVoice) {
        releaseSpeechAudioSession(requestId);
        return;
      }

      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch {}

      ttsState.timer = window.setTimeout(() => {
        playSpeechRound(text, options, requestId, round, true).catch(() => {});
      }, 140);
    };

    const watchdogId = window.setTimeout(() => {
      if (!started) {
        retryWithFallback();
      }
    }, 1600);

    utterance.onstart = () => {
      started = true;
      window.clearTimeout(watchdogId);
    };

    utterance.onend = () => {
      if (!finish() || requestId !== ttsState.requestId) {
        return;
      }

      window.clearTimeout(watchdogId);
      if (round + 1 < options.repeatCount) {
        ttsState.timer = window.setTimeout(() => {
          playSpeechRound(text, options, requestId, round + 1, useBrowserDefaultVoice).catch(() => {});
        }, 220);
        return;
      }

      releaseSpeechAudioSession(requestId);
    };

    utterance.onerror = () => {
      retryWithFallback();
    };

    try {
      activateSpeechAudioSession(requestId);
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      window.speechSynthesis.speak(utterance);
    } catch {
      retryWithFallback();
    }
  }

  const tts = {
    isSupported() {
      return hasPronunciationAudioSupport() || hasSpeechSupport();
    },

    prime() {
      primeSpeechSynthesis();
    },

    cancel() {
      cancelSpeechPlayback();
    },

    preloadWords(words, options = {}) {
      preloadPronunciationWords(words, options);
    },

    speak(text, options = {}) {
      const normalizedText = normalizeSpeechText(text);
      if (!normalizedText || (!hasPronunciationAudioSupport() && !hasSpeechSupport())) {
        return false;
      }

      const defaults = getTtsSettings(options.user);
      const requestId = cancelSpeechPlayback();
      const utteranceText = buildSpeechUtteranceText(normalizedText, options);
      const resolvedOptions = {
        rate: clampClientTtsRate(options.rate ?? defaults.rate, defaults.rate),
        repeatCount: Math.min(4, Math.max(1, Number(options.repeatCount ?? defaults.repeatCount) || 1)),
        delay: Math.max(0, Number(options.delay ?? 0) || 0)
      };
      const shouldClaimAudioFocus = options.claimAudioFocus !== false;

      if (shouldClaimAudioFocus) {
        primeSpeechAudioFocus(requestId, { pulse: false }).catch(() => {});
      }

      ttsState.timer = window.setTimeout(() => {
        playPronunciationAudio(normalizedText, resolvedOptions, requestId)
          .then((playedAudio) => {
            if (playedAudio || requestId !== ttsState.requestId || !hasSpeechSupport()) {
              if (!playedAudio && requestId === ttsState.requestId) {
                releaseSpeechAudioSession(requestId);
              }
              return;
            }

            playSpeechRound(utteranceText, resolvedOptions, requestId, 0, false).catch(() => {
              releaseSpeechAudioSession(requestId);
            });
          })
          .catch(() => {
            if (requestId !== ttsState.requestId) {
              return;
            }

            if (!hasSpeechSupport()) {
              releaseSpeechAudioSession(requestId);
              return;
            }

            playSpeechRound(utteranceText, resolvedOptions, requestId, 0, false).catch(() => {
              releaseSpeechAudioSession(requestId);
            });
          });
      }, resolvedOptions.delay);

      return true;
    },

    getSettings(user) {
      return getTtsSettings(user);
    }
  };

  function getMessageBar() {
    return document.getElementById("messageBar");
  }

  function ensureRequestLoadingUi() {
    if (requestLoadingState.shell) {
      return requestLoadingState.shell;
    }

    const shell = document.createElement("div");
    shell.id = "requestLoadingShell";
    shell.className = "request-loading-shell";
    shell.hidden = true;
    shell.innerHTML = `
      <div class="request-loading-bar" aria-hidden="true">
        <span></span>
      </div>
      <div class="request-loading-overlay" hidden>
        <section class="request-loading-card" aria-live="polite" aria-busy="true">
          <div class="request-loading-spinner" aria-hidden="true"></div>
          <div class="request-loading-copy">
            <strong id="requestLoadingTitle">資料處理中</strong>
            <p id="requestLoadingDetail">正在與伺服器同步資料，請稍候。</p>
          </div>
          <button type="button" id="requestLoadingCancel" class="ghost-btn request-loading-cancel" hidden>取消</button>
        </section>
      </div>
    `;

    document.body.appendChild(shell);
    requestLoadingState.shell = shell;
    requestLoadingState.overlay = shell.querySelector(".request-loading-overlay");
    requestLoadingState.title = shell.querySelector("#requestLoadingTitle");
    requestLoadingState.detail = shell.querySelector("#requestLoadingDetail");
    requestLoadingState.cancel = shell.querySelector("#requestLoadingCancel");
    requestLoadingState.cancel.addEventListener("click", () => {
      const entry = getLatestLoadingEntry({ revealedOnly: true }) || getLatestLoadingEntry();
      if (typeof entry?.config?.onCancel !== "function") {
        return;
      }

      requestLoadingState.cancel.disabled = true;
      requestLoadingState.cancel.textContent = "正在取消…";
      entry.config.onCancel();
    });
    return shell;
  }

  function getLatestLoadingEntry({ revealedOnly = false } = {}) {
    const entries = [...requestLoadingState.active.values()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!revealedOnly || entry.revealed) {
        return entry;
      }
    }
    return null;
  }

  function refreshRequestLoadingUi() {
    const shell = ensureRequestLoadingUi();
    const hasActiveRequests = requestLoadingState.active.size > 0;

    shell.hidden = !hasActiveRequests;
    shell.classList.toggle("show", hasActiveRequests);

    if (!hasActiveRequests) {
      requestLoadingState.overlay.hidden = true;
      return;
    }

    const activeEntry = getLatestLoadingEntry({ revealedOnly: true }) || getLatestLoadingEntry() || {
      config: {}
    };
    const config = activeEntry.config || {};

    requestLoadingState.title.textContent = config.title || "資料處理中";
    requestLoadingState.detail.textContent = config.detail || "正在與伺服器同步資料，請稍候。";
    requestLoadingState.cancel.hidden = typeof config.onCancel !== "function";
    requestLoadingState.cancel.disabled = false;
    requestLoadingState.cancel.textContent = config.cancelLabel || "取消";

    const showOverlay = [...requestLoadingState.active.values()].some(
      (entry) => entry.revealed && entry.config.showOverlay !== false
    );

    requestLoadingState.overlay.hidden = !showOverlay;
  }

  function resolveLoadingConfig(method, loading) {
    if (loading === false) {
      return null;
    }

    const resolvedMethod = String(method || "GET").toUpperCase();
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(resolvedMethod);

    if (!isMutation && !loading) {
      return null;
    }

    const baseConfig = {
      title: isMutation ? "資料處理中" : "資料載入中",
      detail: isMutation ? "正在與伺服器同步資料，請稍候。" : "正在讀取資料，請稍候。",
      showOverlay: isMutation,
      revealDelay: isMutation ? 220 : 0
    };

    if (loading === true || loading == null) {
      return baseConfig;
    }

    if (typeof loading === "string") {
      return { ...baseConfig, title: loading };
    }

    if (typeof loading === "object") {
      return { ...baseConfig, ...loading };
    }

    return baseConfig;
  }

  function beginRequestLoading(config) {
    if (!config) {
      return null;
    }

    const token = Symbol("request-loading");
    const entry = {
      config,
      revealed: config.revealDelay === 0
    };

    if (!entry.revealed && config.showOverlay !== false) {
      entry.timer = window.setTimeout(() => {
        const current = requestLoadingState.active.get(token);
        if (!current) {
          return;
        }
        current.revealed = true;
        refreshRequestLoadingUi();
      }, Math.max(0, Number(config.revealDelay) || 0));
    }

    requestLoadingState.active.set(token, entry);
    refreshRequestLoadingUi();
    return token;
  }

  function endRequestLoading(token) {
    if (!token) {
      return;
    }

    const entry = requestLoadingState.active.get(token);
    if (entry?.timer) {
      window.clearTimeout(entry.timer);
    }

    requestLoadingState.active.delete(token);
    refreshRequestLoadingUi();
  }

  function positionMessageBar() {
    const messageBar = getMessageBar();
    if (!messageBar) return;

    const header = document.querySelector(".site-header-wrap");
    const isMobile = window.innerWidth <= 640;
    const headerBottom = header
      ? Math.max(56, Math.round(header.getBoundingClientRect().bottom))
      : isMobile
        ? 76
        : 64;
    const width = Math.min(320, Math.max(180, window.innerWidth - (isMobile ? 24 : 40)));

    messageBar.style.width = `${width}px`;
    messageBar.style.top = `${headerBottom + (isMobile ? 10 : 12)}px`;
    messageBar.style.right = isMobile ? "12px" : "20px";
    messageBar.style.left = "auto";
  }

  function showMessage(message) {
    const messageBar = getMessageBar();
    if (!messageBar) return;

    positionMessageBar();
    messageBar.textContent = message;
    messageBar.classList.add("show");
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => {
      messageBar.classList.remove("show");
    }, 2600);
  }

  function setAuth(data) {
    const previousUserId = state.user?.id || "";
    state.token = data?.token || "";
    state.user = data?.user || null;

    if (previousUserId && previousUserId !== (state.user?.id || "")) {
      cancelSpeechPlayback();
      clearPronunciationObjectUrlCache();
    }

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(GUEST_TOKEN_KEY);
    sessionStorage.removeItem(GUEST_USER_KEY);

    if (state.token && state.user?.isGuest) {
      sessionStorage.setItem(GUEST_TOKEN_KEY, state.token);
      sessionStorage.setItem(GUEST_USER_KEY, JSON.stringify(state.user));
    } else if (state.token && state.user) {
      localStorage.setItem(TOKEN_KEY, state.token);
      localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    } else {
      cancelSpeechPlayback();
      clearPronunciationObjectUrlCache();
      state.unreadCount = 0;
      clearVisitHeartbeat();
      visitLoggingState.loggedPage = "";
      visitLoggingState.sessionId = 0;
    }

    applyTheme(state.user?.theme);
  }

  function logout() {
    endVisitSession({ keepalive: true }).catch(() => {});
    setAuth(null);
    window.location.href = "/home.html";
  }

  function clearVisitHeartbeat() {
    if (visitLoggingState.heartbeatTimer) {
      window.clearInterval(visitLoggingState.heartbeatTimer);
      visitLoggingState.heartbeatTimer = 0;
    }
  }

  function startVisitHeartbeat() {
    clearVisitHeartbeat();
    if (!visitLoggingState.sessionId) {
      return;
    }

    visitLoggingState.heartbeatTimer = window.setInterval(() => {
      heartbeatVisitSession().catch(() => {});
    }, 15000);
  }

  async function startVisitSession() {
    if (
      !state.token ||
      state.user?.isGuest ||
      !protectedPages.has(page) ||
      visitLoggingState.loggedPage === page ||
      visitLoggingState.sessionId ||
      visitLoggingState.starting
    ) {
      return;
    }

    visitLoggingState.starting = true;

    try {
      const response = await api("/api/auth/visit/session/start", {
        method: "POST",
        loading: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageKey: page,
          path: window.location.pathname
        })
      });
      visitLoggingState.loggedPage = page;
      visitLoggingState.sessionId = Number(response.sessionId || 0);
      startVisitHeartbeat();
    } catch {
      visitLoggingState.loggedPage = "";
      visitLoggingState.sessionId = 0;
    } finally {
      visitLoggingState.starting = false;
    }
  }

  async function heartbeatVisitSession() {
    if (!state.token || !visitLoggingState.sessionId || document.visibilityState === "hidden") {
      return;
    }

    try {
      await api(`/api/auth/visit/session/${visitLoggingState.sessionId}/heartbeat`, {
        method: "POST",
        loading: false
      });
    } catch {
      clearVisitHeartbeat();
    }
  }

  async function endVisitSession({ keepalive = false } = {}) {
    const sessionId = visitLoggingState.sessionId;
    clearVisitHeartbeat();

    if (!state.token || !sessionId) {
      visitLoggingState.sessionId = 0;
      visitLoggingState.loggedPage = "";
      return;
    }

    visitLoggingState.sessionId = 0;
    visitLoggingState.loggedPage = "";

    const headers = {};
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    try {
      await fetch(`/api/auth/visit/session/${sessionId}/end`, {
        method: "POST",
        headers,
        keepalive,
        credentials: "same-origin"
      });
    } catch {
      // Ignore unload failures.
    }
  }

  async function legacyApiPlaceholder(path, options = {}) {
    const {
      loading,
      headers: optionHeaders = {},
      ...fetchOptions
    } = options;
    const method = String(fetchOptions.method || "GET").toUpperCase();
    const headers = { ...optionHeaders };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    /*
    const loadingToken = beginRequestLoading(resolveLoadingConfig(method, loading));

    try {
      const response = await fetch(path, { ...fetchOptions, headers });
      const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401) {
        setAuth(null);
      }
      throw new Error(data.message || "請先登入。");
    }

    return data;
    */
  }

  async function api(path, options = {}) {
    const {
      loading,
      headers: optionHeaders = {},
      ...fetchOptions
    } = options;
    const method = String(fetchOptions.method || "GET").toUpperCase();
    const headers = { ...optionHeaders };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    if (
      fetchOptions.body &&
      typeof fetchOptions.body === "object" &&
      !(fetchOptions.body instanceof FormData) &&
      !(fetchOptions.body instanceof Blob) &&
      !(fetchOptions.body instanceof URLSearchParams)
    ) {
      fetchOptions.body = JSON.stringify(fetchOptions.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    const loadingToken = beginRequestLoading(resolveLoadingConfig(method, loading));

    try {
      const response = await fetch(path, { ...fetchOptions, headers });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 401) {
          setAuth(null);
        }
        throw new Error(data.message || "請求失敗，請稍後再試。");
      }

      return data;
    } finally {
      endRequestLoading(loadingToken);
    }
  }

  async function refreshUnreadCount({ rerender = true } = {}) {
    if (!state.token || state.user?.isGuest) {
      state.unreadCount = 0;
      if (rerender) renderHeader();
      return 0;
    }

    try {
      const data = await api("/api/notifications/inbox");
      state.unreadCount = Number(data.unreadCount || 0);
      if (rerender) renderHeader();
      return state.unreadCount;
    } catch {
      state.unreadCount = 0;
      if (rerender) renderHeader();
      return 0;
    }
  }

  function getHeaderMenuElements() {
    return {
      shell: document.getElementById("siteMenuShell"),
      header: document.querySelector(".site-header"),
      brand: document.querySelector(".brand-block"),
      toggle: document.getElementById("siteMenuToggle"),
      panel: document.getElementById("siteMenuPanel"),
      links: document.getElementById("siteMenuLinks"),
      tools: document.getElementById("siteMenuTools")
    };
  }

  function disconnectHeaderMenuObserver() {
    if (headerMenuState.observer) {
      headerMenuState.observer.disconnect();
      headerMenuState.observer = null;
    }
  }

  function measureExpandedHeaderMenuWidth(elements = getHeaderMenuElements()) {
    if (!elements.links || !elements.tools) {
      return 0;
    }

    const measurement = document.createElement("div");
    measurement.style.position = "fixed";
    measurement.style.left = "-9999px";
    measurement.style.top = "0";
    measurement.style.display = "flex";
    measurement.style.alignItems = "center";
    measurement.style.gap = "12px";
    measurement.style.visibility = "hidden";
    measurement.style.pointerEvents = "none";
    measurement.style.whiteSpace = "nowrap";

    const linksClone = elements.links.cloneNode(true);
    linksClone.id = "";
    linksClone.style.display = "flex";
    linksClone.style.flexWrap = "nowrap";
    linksClone.style.alignItems = "center";
    linksClone.style.gap = "10px";
    linksClone.style.width = "auto";

    const toolsClone = elements.tools.cloneNode(true);
    toolsClone.id = "";
    toolsClone.style.display = "flex";
    toolsClone.style.flexDirection = "row";
    toolsClone.style.alignItems = "center";
    toolsClone.style.gap = "10px";
    toolsClone.style.width = "auto";

    measurement.appendChild(linksClone);
    measurement.appendChild(toolsClone);
    document.body.appendChild(measurement);

    const width = Math.ceil(measurement.getBoundingClientRect().width);
    measurement.remove();
    return width;
  }

  function shouldCollapseHeaderMenu(elements = getHeaderMenuElements()) {
    if (!elements.header || !elements.brand || !elements.links) {
      return false;
    }

    if (window.innerWidth <= 900) {
      return true;
    }

    const headerWidth = Math.ceil(elements.header.getBoundingClientRect().width);
    const brandWidth = Math.ceil(elements.brand.getBoundingClientRect().width);
    const menuWidth = measureExpandedHeaderMenuWidth(elements);
    return brandWidth + menuWidth + 64 > headerWidth;
  }

  function applyHeaderMenuState(elements = getHeaderMenuElements()) {
    const { shell, toggle, panel } = elements;
    if (!shell || !toggle || !panel) {
      return;
    }

    const menuVisible = !headerMenuState.collapsed || headerMenuState.open;
    shell.classList.toggle("is-collapsed", headerMenuState.collapsed);
    shell.classList.toggle("is-open", headerMenuState.collapsed && headerMenuState.open);
    toggle.hidden = !headerMenuState.collapsed;
    toggle.setAttribute("aria-expanded", String(menuVisible));
    toggle.setAttribute("aria-label", headerMenuState.open ? "收合選單" : "開啟選單");
    panel.setAttribute("data-menu-visible", menuVisible ? "1" : "0");
  }

  function syncHeaderMenuLayout() {
    const elements = getHeaderMenuElements();
    if (!elements.shell) {
      return;
    }

    headerMenuState.collapsed = shouldCollapseHeaderMenu(elements);
    if (!headerMenuState.collapsed) {
      headerMenuState.open = false;
    }

    applyHeaderMenuState(elements);
  }

  function setHeaderMenuOpen(open) {
    if (!headerMenuState.collapsed) {
      headerMenuState.open = false;
      applyHeaderMenuState();
      return;
    }

    headerMenuState.open = Boolean(open);
    applyHeaderMenuState();
  }

  function bindHeaderMenu() {
    const elements = getHeaderMenuElements();
    if (!elements.shell || !elements.toggle || !elements.panel) {
      disconnectHeaderMenuObserver();
      return;
    }

    disconnectHeaderMenuObserver();

    elements.toggle.addEventListener("click", () => {
      setHeaderMenuOpen(!headerMenuState.open);
    });

    if ("ResizeObserver" in window) {
      headerMenuState.observer = new ResizeObserver(() => {
        syncHeaderMenuLayout();
      });

      [elements.header, elements.brand, elements.links, elements.tools].forEach((element) => {
        if (element) {
          headerMenuState.observer.observe(element);
        }
      });
    }

    syncHeaderMenuLayout();
    window.requestAnimationFrame(syncHeaderMenuLayout);
  }

  function renderHeader() {
    const target = document.getElementById("siteHeader");
    if (!target) return;

    const links = [
      { href: "/home.html", label: "首頁", key: "home", visible: !state.token },
      { href: "/words.html", label: "單字庫", key: "words", visible: !!state.token },
      { href: "/practice.html", label: "練習", key: "practice", visible: !!state.token },
      { href: "/leaderboard.html", label: "排行榜", key: "leaderboard", visible: !!state.token },
      { href: "/analytics.html", label: "趨勢", key: "analytics", visible: !!state.token },
      { href: "/settings.html", label: "設定", key: "settings", visible: !!state.token },
      { href: "/admin.html", label: "管理", key: "admin", visible: state.user?.role === "admin" }
    ];

    const subtitle = state.user
      ? state.user.isGuest
        ? "訪客 / 不儲存學習紀錄"
        : `${state.user.displayName || state.user.username}${state.user.role === "admin" ? " / 管理員" : ""}`
      : "登入後可使用單字庫、練習、趨勢與排行榜。";

    const notificationLink = state.user && !state.user.isGuest
      ? `
          <a
            id="notificationBellBtn"
            class="notify-btn ghost-btn ${page === "notifications" ? "active-notify" : ""}"
            href="/notifications.html"
            aria-label="通知"
          >
            <span class="notify-icon" aria-hidden="true">🔔</span>
            <span class="notify-label">通知</span>
            ${
              state.unreadCount > 0
                ? `<span class="notify-badge">${state.unreadCount > 99 ? "99+" : state.unreadCount}</span>`
                : ""
            }
          </a>
        `
      : "";

    target.innerHTML = `
      <div class="site-header-wrap">
        <header class="site-header">
          <a class="brand-block" href="/home.html" aria-label="Words King 首頁">
            <img class="brand-icon" src="/wordking-icon-192.png?v=20260722b" alt="" width="44" height="44" />
            <span class="brand-copy">
              <span class="brand-title">Words King</span>
              <span class="brand-subtitle">${escapeHtml(subtitle)}</span>
            </span>
          </a>
          <div id="siteMenuShell" class="site-menu-shell">
            <button
              type="button"
              id="siteMenuToggle"
              class="site-menu-toggle ghost-btn"
              aria-label="開啟選單"
              aria-expanded="false"
              aria-controls="siteMenuPanel"
              aria-haspopup="true"
            >
              <span class="site-menu-toggle-box" aria-hidden="true">
                <span></span>
                <span></span>
                <span></span>
              </span>
              <span class="site-menu-toggle-label">選單</span>
            </button>
            <div id="siteMenuPanel" class="site-menu-panel">
              <nav class="nav-row" aria-label="主要選單">
                <div id="siteMenuLinks" class="nav-links">
                  ${links
                    .filter((item) => item.visible)
                    .map(
                      (item) => `
                        <a class="nav-link ${page === item.key ? "active" : ""}" href="${item.href}">
                          ${item.label}
                        </a>
                      `
                    )
                    .join("")}
                </div>
                <div id="siteMenuTools" class="nav-tools">
                  ${notificationLink}
                  ${
                    state.user
                      ? `<button type="button" id="logoutBtn" class="ghost-btn">${state.user.isGuest ? "離開訪客" : "登出"}</button>`
                      : `<a class="nav-link ${page === "home" ? "active" : ""}" href="/home.html">登入</a>`
                  }
                </div>
              </nav>
            </div>
          </div>
        </header>
      </div>
    `;

    bindHeaderMenu();
    document.getElementById("logoutBtn")?.addEventListener("click", logout);
    positionMessageBar();
  }

  async function refreshUser() {
    if (!state.token) {
      applyTheme(null);
      renderHeader();
      return null;
    }

    try {
      const data = await api("/api/auth/me");
      state.user = state.user?.isGuest && data.user?.isGuest
        ? {
            ...data.user,
            displayName: state.user.displayName,
            theme: state.user.theme,
            leaderboardVisible: state.user.leaderboardVisible,
            practiceNextQuestionDelayMs: state.user.practiceNextQuestionDelayMs,
            practiceChoiceTimeLimitSeconds: state.user.practiceChoiceTimeLimitSeconds,
            practiceTypingTimeLimitSeconds: state.user.practiceTypingTimeLimitSeconds
          }
        : data.user;
      if (state.user?.isGuest) {
        sessionStorage.setItem(GUEST_USER_KEY, JSON.stringify(state.user));
      } else {
        localStorage.setItem(USER_KEY, JSON.stringify(state.user));
      }
      applyTheme(state.user?.theme);
      renderHeader();
      await refreshUnreadCount({ rerender: true });
      return data.user;
    } catch {
      renderHeader();
      if (page !== "home") {
        showMessage("登入狀態已失效，請重新登入。");
        window.location.href = "/home.html";
      }
      return null;
    }
  }

  function enforcePageAccess() {
    if (protectedPages.has(page) && !state.token) {
      window.location.href = "/home.html";
      return false;
    }

    if (page === "admin" && state.user?.role !== "admin") {
      window.location.href = "/home.html";
      return false;
    }

    startVisitSession().catch(() => {});
    return true;
  }

  window.WordsApp = {
    state,
    api,
    showMessage,
    setAuth,
    logout,
    renderHeader,
    refreshUser,
    enforcePageAccess,
    applyTheme,
    refreshUnreadCount,
    startVisitSession,
    heartbeatVisitSession,
    endVisitSession,
    tts
  };

  applyTheme(state.user?.theme);
  renderHeader();
  window.addEventListener("resize", () => {
    positionMessageBar();
    syncHeaderMenuLayout();
  });
  window.addEventListener("scroll", positionMessageBar, { passive: true });
  document.addEventListener("click", (event) => {
    tts.prime();
    if (!headerMenuState.collapsed || !headerMenuState.open || !(event.target instanceof Node)) {
      return;
    }

    const { shell } = getHeaderMenuElements();
    if (!shell || shell.contains(event.target)) {
      return;
    }

    setHeaderMenuOpen(false);
  });
  document.addEventListener("keydown", () => {
    tts.prime();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setHeaderMenuOpen(false);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      endVisitSession({ keepalive: true }).catch(() => {});
    } else {
      startVisitSession().catch(() => {});
    }
  });
  window.addEventListener("pagehide", () => {
    clearPronunciationObjectUrlCache();
    endVisitSession({ keepalive: true }).catch(() => {});
  });
  window.requestAnimationFrame(() => {
    document.body.classList.add("page-ready");
    positionMessageBar();
    syncHeaderMenuLayout();
    tts.prime();
  });
})();
