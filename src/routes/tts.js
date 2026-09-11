const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { serverDb } = require("../db/connections");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimit");
const { getClientIp, queueServerLog } = require("../utils/serverLogger");

const router = express.Router();
const CACHE_DIR = path.join(__dirname, "..", "..", "data", "pronunciations");
const MAX_WORD_LENGTH = 64;
const REQUEST_TIMEOUT_MS = 4500;
const AUDIO_DOWNLOAD_LIMIT_BYTES = 2 * 1024 * 1024;
const PRONUNCIATION_MISS_TTL_HOURS = 24;
const PRONUNCIATION_CACHE_TTL_DAYS = 7;
const PRONUNCIATION_HIGH_FREQUENCY_THRESHOLD = 10;
const PREFETCH_BATCH_LIMIT = 3;
const PREFETCH_WORKER_INTERVAL_MS = 1500;
const PREFETCH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GEMINI_TTS_PROVIDER = "gemini_flash_tts_preview";
const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_TTS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_TTS_API_REVISION = "2026-05-20";
const SUPPORTED_AUDIO_TYPES = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/ogg", "ogg"],
  ["application/ogg", "ogg"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"]
]);

const pronunciationRateLimit = createRateLimiter({
  key: "tts:pronunciation",
  windowMs: 60 * 1000,
  max: 80,
  message: "Too many pronunciation requests. Please wait and try again."
});

const pronunciationPrefetchRateLimit = createRateLimiter({
  key: "tts:pronunciation-prefetch",
  windowMs: 60 * 1000,
  max: 24,
  message: "Too many pronunciation prefetch requests. Please wait and try again."
});

const prefetchWorkerState = {
  started: false,
  running: false,
  timer: null,
  cleanupTimer: null
};

function normalizePronunciationWord(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function validatePronunciationWord(value) {
  const normalized = normalizePronunciationWord(value);
  if (!normalized || normalized.length > MAX_WORD_LENGTH) {
    return null;
  }

  if (!/^[a-z][a-z' -]*$/.test(normalized)) {
    return null;
  }

  const wordCount = normalized.split(" ").filter(Boolean).length;
  if (wordCount < 1 || wordCount > 4) {
    return null;
  }

  return normalized;
}

function isTruthyQueryFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getGeminiTtsKeys() {
  return [...new Set(
    String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
  )];
}

function getGeminiKeyFingerprint(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
}

function getNextTaipeiMidnightUtc() {
  const taipeiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const nextMidnightUtc = Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + 1,
    0,
    0,
    0
  ) - 8 * 60 * 60 * 1000;
  return new Date(nextMidnightUtc).toISOString().slice(0, 19).replace("T", " ");
}

function createPrefetchRetryError(message, retryAt) {
  const error = new Error(message);
  error.prefetchRetryAt = retryAt;
  return error;
}

function createCacheKey(source, sourceUrl, word) {
  return crypto
    .createHash("sha256")
    .update(`${source}\n${sourceUrl}\n${word}`)
    .digest("hex")
    .slice(0, 40);
}

function getAudioExtension(contentType, sourceUrl = "") {
  const normalizedType = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (SUPPORTED_AUDIO_TYPES.has(normalizedType)) {
    return SUPPORTED_AUDIO_TYPES.get(normalizedType);
  }

  const pathname = (() => {
    try {
      return new URL(sourceUrl).pathname;
    } catch {
      return "";
    }
  })();
  const extension = path.extname(pathname).replace(".", "").toLowerCase();
  return ["mp3", "wav", "ogg", "webm", "m4a"].includes(extension) ? extension : "mp3";
}

function normalizeAudioUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return "";
}

function resolveCacheFilePath(filePath) {
  const resolvedCacheDir = path.resolve(CACHE_DIR);
  const resolvedFilePath = path.resolve(filePath);
  const relativePath = path.relative(resolvedCacheDir, resolvedFilePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }

  return resolvedFilePath;
}

function isLikelyAudioContentType(value) {
  const contentType = String(value || "").toLowerCase();
  return /^audio\//i.test(contentType) || contentType === "application/ogg";
}

function buildAttribution(source, sourceUrl, license = "") {
  return JSON.stringify({
    source,
    sourceUrl,
    license,
    fetchedAt: new Date().toISOString()
  });
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readAudioResponse(response, sourceUrl) {
  if (!response.ok) {
    throw new Error(`Audio source responded with HTTP ${response.status}.`);
  }

  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !isLikelyAudioContentType(contentType)) {
    throw new Error(`Unsupported audio content type: ${contentType}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > AUDIO_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Audio file is too large.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > AUDIO_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Audio file is empty or too large.");
  }

  return {
    buffer,
    contentType: contentType || inferContentTypeFromUrl(sourceUrl)
  };
}

function inferContentTypeFromUrl(sourceUrl) {
  const extension = getAudioExtension("", sourceUrl);
  if (extension === "wav") return "audio/wav";
  if (extension === "ogg") return "audio/ogg";
  if (extension === "webm") return "audio/webm";
  if (extension === "m4a") return "audio/mp4";
  return "audio/mpeg";
}

function rowToPayload(row) {
  return {
    available: true,
    word: row.word,
    audioUrl: `/api/tts/pronunciation/audio/${encodeURIComponent(row.cache_key)}`,
    cacheKey: row.cache_key,
    source: row.source,
    sourceUrl: row.source_url,
    contentType: row.content_type,
    attribution: safeParseJson(row.attribution_json)
  };
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getGoogleTtsConfig() {
  const apiKey = String(process.env.GOOGLE_TTS_API_KEY || "").trim();
  const voiceName = String(process.env.GOOGLE_TTS_VOICE || "").trim();
  const languageCode = String(process.env.GOOGLE_TTS_LANGUAGE_CODE || "en-US").trim() || "en-US";
  return {
    apiKey,
    enabled: Boolean(apiKey),
    voiceName,
    languageCode
  };
}

function getProviderSignature() {
  const googleConfig = getGoogleTtsConfig();
  return [
    "free_dictionary:v1",
    "wikimedia_commons:v1",
    `${GEMINI_TTS_PROVIDER}:${getGeminiTtsKeys().length ? "enabled" : "disabled"}:${GEMINI_TTS_MODEL}`,
    `google_cloud_tts:${googleConfig.enabled ? "enabled" : "disabled"}:${googleConfig.languageCode}:${googleConfig.voiceName}`
  ].join("|");
}

async function findRecentPronunciationMiss(word) {
  const row = await serverDb.get(
    `SELECT *
     FROM pronunciation_miss_cache
     WHERE word_normalized = ?
       AND provider_signature = ?
       AND created_at >= datetime('now', ?)
     LIMIT 1`,
    [word, getProviderSignature(), `-${PRONUNCIATION_MISS_TTL_HOURS} hours`]
  );

  if (!row) {
    return null;
  }

  await serverDb.run(
    `UPDATE pronunciation_miss_cache
     SET last_checked_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [row.id]
  );
  return row;
}

async function savePronunciationMiss(word, failures) {
  await serverDb.run(
    `INSERT INTO pronunciation_miss_cache
       (word_normalized, provider_signature, reason_json, created_at, last_checked_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(word_normalized, provider_signature) DO UPDATE SET
       reason_json = excluded.reason_json,
       created_at = CURRENT_TIMESTAMP,
       last_checked_at = CURRENT_TIMESTAMP`,
    [
      word,
      getProviderSignature(),
      JSON.stringify({
        failures,
        ttlHours: PRONUNCIATION_MISS_TTL_HOURS
      })
    ]
  );
}

async function clearPronunciationMiss(word) {
  await serverDb.run(
    `DELETE FROM pronunciation_miss_cache
     WHERE word_normalized = ?`,
    [word]
  );
}

async function findCachedPronunciation(word) {
  const row = await serverDb.get(
    `SELECT *
     FROM pronunciation_cache
     WHERE word_normalized = ?
     ORDER BY refreshed_at DESC, last_used_at DESC, id DESC
     LIMIT 1`,
    [word]
  );

  if (!row) {
    return null;
  }

  const filePath = resolveCacheFilePath(row.file_path);
  if (!filePath) {
    return null;
  }

  try {
    await fs.access(filePath);
  } catch {
    await serverDb.run("DELETE FROM pronunciation_cache WHERE id = ?", [row.id]);
    return null;
  }

  await serverDb.run(
    `UPDATE pronunciation_cache
     SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [row.id]
  );
  return row;
}

async function savePronunciationAudio({ word, source, sourceUrl, contentType, attributionJson, buffer }) {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const cacheKey = createCacheKey(source, sourceUrl, word);
  const extension = getAudioExtension(contentType, sourceUrl);
  const filePath = path.join(CACHE_DIR, `${cacheKey}.${extension}`);
  await fs.writeFile(filePath, buffer);

  await serverDb.run(
    `INSERT INTO pronunciation_cache
       (
         word,
         word_normalized,
         cache_key,
         source,
         source_url,
         content_type,
         file_path,
         attribution_json,
         created_at,
         last_used_at,
         refreshed_at
       )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(cache_key) DO UPDATE SET
       word = excluded.word,
       word_normalized = excluded.word_normalized,
       source = excluded.source,
       source_url = excluded.source_url,
       content_type = excluded.content_type,
       file_path = excluded.file_path,
       attribution_json = excluded.attribution_json,
       last_used_at = CURRENT_TIMESTAMP,
       refreshed_at = CURRENT_TIMESTAMP`,
    [word, word, cacheKey, source, sourceUrl, contentType, filePath, attributionJson]
  );

  await clearPronunciationMiss(word);

  return serverDb.get(
    `SELECT *
     FROM pronunciation_cache
     WHERE cache_key = ?`,
    [cacheKey]
  );
}

function pickDictionaryAudio(entries) {
  const phonetics = Array.isArray(entries)
    ? entries.flatMap((entry) => (Array.isArray(entry?.phonetics) ? entry.phonetics : []))
    : [];

  const candidates = phonetics
    .map((phonetic) => {
      const audioUrl = normalizeAudioUrl(phonetic?.audio);
      const haystack = `${audioUrl} ${phonetic?.sourceUrl || ""} ${phonetic?.text || ""}`.toLowerCase();
      let score = 0;
      if (/[-_/]us[-_/.]|en-us|_us_|us\.mp3|american/.test(haystack)) score += 20;
      if (/[-_/]uk[-_/.]|en-gb|_gb_|british/.test(haystack)) score += 8;
      if (/^https:\/\//i.test(audioUrl)) score += 4;
      if (/\.mp3(?:$|\?)/i.test(audioUrl)) score += 2;
      return { audioUrl, score };
    })
    .filter((candidate) => candidate.audioUrl)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.audioUrl || "";
}

async function fetchFreeDictionaryPronunciation(word) {
  if (word.includes(" ")) {
    return null;
  }

  const apiUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const response = await fetchWithTimeout(apiUrl, {
    headers: {
      Accept: "application/json"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Dictionary API responded with HTTP ${response.status}.`);
  }

  const entries = await response.json();
  const audioUrl = pickDictionaryAudio(entries);
  if (!audioUrl) {
    return null;
  }

  const audioResponse = await fetchWithTimeout(audioUrl, {
    headers: {
      Accept: "audio/*"
    }
  });
  const audio = await readAudioResponse(audioResponse, audioUrl);

  return {
    word,
    source: "free_dictionary_api",
    sourceUrl: audioUrl,
    contentType: audio.contentType,
    attributionJson: buildAttribution("Free Dictionary API", "https://dictionaryapi.dev/", "See source response"),
    buffer: audio.buffer
  };
}

function extractWiktionaryAudioFileNames(wikitext) {
  const text = String(wikitext || "");
  const fileNames = [];
  const seen = new Set();
  const audioTemplatePattern = /\{\{\s*audio\s*\|\s*en\s*\|\s*([^|}]+)\|/gi;
  let match = audioTemplatePattern.exec(text);

  while (match) {
    const fileName = String(match[1] || "").trim().replace(/^File:/i, "");
    if (/\.(?:ogg|oga|mp3|wav|webm)$/i.test(fileName) && !seen.has(fileName.toLowerCase())) {
      seen.add(fileName.toLowerCase());
      fileNames.push(fileName);
    }
    match = audioTemplatePattern.exec(text);
  }

  return fileNames;
}

async function fetchWiktionaryAudioFileNames(word) {
  if (word.includes(" ")) {
    return [];
  }

  const url =
    "https://en.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&titles=" +
    encodeURIComponent(word);
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WordsKingServer/1.0 pronunciation-cache"
    }
  });

  if (!response.ok) {
    throw new Error(`Wiktionary API responded with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  const wikitext = pages
    .map((page) => page?.revisions?.[0]?.slots?.main?.["*"] || page?.revisions?.[0]?.["*"] || "")
    .join("\n");

  return extractWiktionaryAudioFileNames(wikitext);
}

function getCommonsImageInfoPage(data) {
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  return pages.find((page) => Array.isArray(page?.imageinfo) && page.imageinfo.length) || null;
}

function buildCommonsAttribution(fileName, imageInfo) {
  const metadata = imageInfo?.extmetadata || {};
  const filePageUrl = imageInfo?.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`;

  return JSON.stringify({
    source: "Wikimedia Commons / Wiktionary",
    sourceUrl: filePageUrl,
    fileName,
    license: stripHtml(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || ""),
    artist: stripHtml(metadata.Artist?.value || ""),
    credit: stripHtml(metadata.Credit?.value || ""),
    fetchedAt: new Date().toISOString()
  });
}

async function fetchCommonsAudioInfo(fileName) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|mime|extmetadata&format=json&titles=File:" +
    encodeURIComponent(fileName);
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WordsKingServer/1.0 pronunciation-cache"
    }
  });

  if (!response.ok) {
    throw new Error(`Wikimedia Commons API responded with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const page = getCommonsImageInfoPage(data);
  const imageInfo = page?.imageinfo?.[0] || null;
  const mediaUrl = normalizeAudioUrl(imageInfo?.url);

  if (!mediaUrl || !isLikelyAudioContentType(imageInfo?.mime || "")) {
    return null;
  }

  return {
    mediaUrl,
    mime: imageInfo.mime,
    attributionJson: buildCommonsAttribution(fileName, imageInfo)
  };
}

async function fetchWikimediaPronunciation(word) {
  const fileNames = await fetchWiktionaryAudioFileNames(word);
  for (const fileName of fileNames) {
    const audioInfo = await fetchCommonsAudioInfo(fileName);
    if (!audioInfo) {
      continue;
    }

    const audioResponse = await fetchWithTimeout(audioInfo.mediaUrl, {
      headers: {
        Accept: "audio/*",
        "User-Agent": "WordsKingServer/1.0 pronunciation-cache"
      }
    });
    const audio = await readAudioResponse(audioResponse, audioInfo.mediaUrl);

    return {
      word,
      source: "wikimedia_commons",
      sourceUrl: audioInfo.mediaUrl,
      contentType: audio.contentType || audioInfo.mime,
      attributionJson: audioInfo.attributionJson,
      buffer: audio.buffer
    };
  }

  return null;
}

async function fetchGoogleCloudTtsPronunciation(word) {
  const googleConfig = getGoogleTtsConfig();
  if (!googleConfig.apiKey) {
    return null;
  }

  const endpoint = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(googleConfig.apiKey)}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: { text: word },
      voice: {
        languageCode: googleConfig.languageCode,
        ...(googleConfig.voiceName ? { name: googleConfig.voiceName } : {})
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 0.95,
        pitch: 0
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Cloud TTS responded with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const audioContent = String(data.audioContent || "");
  if (!audioContent) {
    throw new Error("Google Cloud TTS returned no audio content.");
  }

  return {
    word,
    source: "google_cloud_tts",
    sourceUrl: "https://cloud.google.com/text-to-speech",
    contentType: "audio/mpeg",
    attributionJson: buildAttribution("Google Cloud Text-to-Speech", "https://cloud.google.com/text-to-speech", "Generated audio"),
    buffer: Buffer.from(audioContent, "base64")
  };
}

function createPcmWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function extractGeminiAudioChunks(payload) {
  const candidates = [
    payload?.delta?.data,
    payload?.output_audio?.data,
    payload?.output?.audio?.data,
    payload?.audio?.data
  ];
  return candidates
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => Buffer.from(value, "base64"));
}

async function readGeminiAudioStream(response) {
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    const error = new Error(`Gemini Flash TTS responded with HTTP ${response.status}.`);
    error.statusCode = response.status;
    error.responseText = responseText.slice(0, 400);
    throw error;
  }

  if (!response.body) {
    throw new Error("Gemini Flash TTS returned no response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let pending = "";

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const value = trimmed.slice(5).trim();
    if (!value || value === "[DONE]") {
      return;
    }
    try {
      chunks.push(...extractGeminiAudioChunks(JSON.parse(value)));
    } catch {
      // Ignore non-JSON stream events such as keepalives.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    lines.forEach(consumeLine);
  }
  pending += decoder.decode();
  pending.split(/\r?\n/).forEach(consumeLine);

  const pcmBuffer = Buffer.concat(chunks);
  if (!pcmBuffer.length || pcmBuffer.length > AUDIO_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Gemini Flash TTS returned invalid audio data.");
  }
  return createPcmWavBuffer(pcmBuffer);
}

async function lockGeminiTtsKey(key, reason) {
  const lockedUntil = getNextTaipeiMidnightUtc();
  await serverDb.run(
    `INSERT INTO pronunciation_provider_key_locks
       (provider, key_fingerprint, locked_until, reason, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider, key_fingerprint) DO UPDATE SET
       locked_until = excluded.locked_until,
       reason = excluded.reason,
       updated_at = CURRENT_TIMESTAMP`,
    [GEMINI_TTS_PROVIDER, getGeminiKeyFingerprint(key), lockedUntil, reason]
  );
  queueServerLog({
    level: "warn",
    category: "tts",
    action: "gemini_tts_key_locked",
    method: "SYSTEM",
    route: "/api/tts/pronunciation",
    ipAddress: "local",
    message: "Gemini TTS key locked until the next Taipei day after a provider quota or access response.",
    details: { provider: GEMINI_TTS_PROVIDER, lockedUntil, reason }
  });
  return lockedUntil;
}

async function getAvailableGeminiTtsKeys() {
  const keys = getGeminiTtsKeys();
  if (!keys.length) {
    return [];
  }

  const fingerprints = keys.map(getGeminiKeyFingerprint);
  const placeholders = fingerprints.map(() => "?").join(", ");
  const rows = await serverDb.all(
    `SELECT key_fingerprint, locked_until
     FROM pronunciation_provider_key_locks
     WHERE provider = ?
       AND key_fingerprint IN (${placeholders})
       AND locked_until > CURRENT_TIMESTAMP`,
    [GEMINI_TTS_PROVIDER, ...fingerprints]
  );
  const locked = new Map(rows.map((row) => [row.key_fingerprint, row.locked_until]));
  return keys.filter((key) => !locked.has(getGeminiKeyFingerprint(key)));
}

async function getNextGeminiTtsUnlockAt() {
  const row = await serverDb.get(
    `SELECT MIN(locked_until) AS locked_until
     FROM pronunciation_provider_key_locks
     WHERE provider = ?
       AND locked_until > CURRENT_TIMESTAMP`,
    [GEMINI_TTS_PROVIDER]
  );
  return row?.locked_until || getNextTaipeiMidnightUtc();
}

async function fetchGeminiFlashTtsPronunciation(word) {
  const configuredKeys = getGeminiTtsKeys();
  if (!configuredKeys.length) {
    return null;
  }

  const keys = await getAvailableGeminiTtsKeys();
  if (!keys.length) {
    throw createPrefetchRetryError("All Gemini Flash TTS keys are locked until the next Taipei day.", await getNextGeminiTtsUnlockAt());
  }

  let lastError = null;
  for (const key of keys) {
    try {
      const response = await fetchWithTimeout(GEMINI_TTS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Api-Revision": GEMINI_TTS_API_REVISION,
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          model: GEMINI_TTS_MODEL,
          input: word,
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{ voice: "Kore" }]
          },
          stream: true
        })
      });
      const buffer = await readGeminiAudioStream(response);
      return {
        word,
        source: GEMINI_TTS_PROVIDER,
        sourceUrl: "https://ai.google.dev/gemini-api/docs/speech-generation",
        contentType: "audio/wav",
        attributionJson: buildAttribution("Gemini Flash TTS", "https://ai.google.dev/gemini-api/docs/speech-generation", "Generated audio"),
        buffer
      };
    } catch (error) {
      lastError = error;
      if ([403, 409, 429].includes(Number(error.statusCode))) {
        await lockGeminiTtsKey(key, `HTTP ${error.statusCode}`);
        continue;
      }
    }
  }

  const retryAt = await getNextGeminiTtsUnlockAt();
  if (!await getAvailableGeminiTtsKeys().then((keys) => keys.length)) {
    throw createPrefetchRetryError("Gemini Flash TTS quota is unavailable until the next Taipei day.", retryAt);
  }
  throw lastError || new Error("Gemini Flash TTS failed.");
}

async function enqueuePronunciationPrefetch(word, { priority = 0, refresh = false, requestedBy = null } = {}) {
  await serverDb.run(
    `INSERT INTO pronunciation_prefetch_jobs
       (word_normalized, priority, refresh_requested, status, attempts, next_attempt_at, requested_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(word_normalized) DO UPDATE SET
       priority = MAX(pronunciation_prefetch_jobs.priority, excluded.priority),
       refresh_requested = MAX(pronunciation_prefetch_jobs.refresh_requested, excluded.refresh_requested),
       status = CASE WHEN pronunciation_prefetch_jobs.status IN ('completed', 'failed') THEN 'queued' ELSE pronunciation_prefetch_jobs.status END,
       next_attempt_at = CASE WHEN pronunciation_prefetch_jobs.status IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE pronunciation_prefetch_jobs.next_attempt_at END,
       updated_at = CURRENT_TIMESTAMP`,
    [word, Number(priority) || 0, refresh ? 1 : 0]
  );
  queueServerLog({
    level: "info",
    category: "tts",
    action: "pronunciation_prefetch_enqueued",
    actorUserId: requestedBy?.id || null,
    actorUsername: requestedBy?.username || "",
    method: "SYSTEM",
    route: "/api/tts/pronunciation/prefetch",
    ipAddress: "local",
    message: `Pronunciation prefetch queued for ${word}.`,
    details: { word, priority, refresh }
  });
}

async function recordPronunciationUse(word, user) {
  await serverDb.run(
    `INSERT INTO pronunciation_usage
       (word_normalized, request_window_started_at, direct_request_count, last_requested_at)
     VALUES (?, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(word_normalized) DO UPDATE SET
       request_window_started_at = CASE
         WHEN pronunciation_usage.request_window_started_at < datetime('now', '-24 hours') THEN CURRENT_TIMESTAMP
         ELSE pronunciation_usage.request_window_started_at
       END,
       direct_request_count = CASE
         WHEN pronunciation_usage.request_window_started_at < datetime('now', '-24 hours') THEN 1
         ELSE pronunciation_usage.direct_request_count + 1
       END,
       last_requested_at = CURRENT_TIMESTAMP`,
    [word]
  );

  const usage = await serverDb.get(
    "SELECT direct_request_count FROM pronunciation_usage WHERE word_normalized = ?",
    [word]
  );
  return Number(usage?.direct_request_count || 0);
}

function isStalePronunciation(row) {
  const refreshedAt = Date.parse(String(row?.refreshed_at || row?.created_at || "").replace(" ", "T") + "Z");
  return !Number.isFinite(refreshedAt) || Date.now() - refreshedAt >= PRONUNCIATION_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

async function resolvePronunciation(word, req = {}, { forceRefresh = false } = {}) {
  const cached = forceRefresh ? null : await findCachedPronunciation(word);
  if (cached) {
    queueServerLog({
      level: "info",
      category: "tts",
      action: "pronunciation_cache_hit",
      actorUserId: req.user?.id || null,
      actorUsername: req.user?.username || "",
      method: req.method,
      route: req.path,
      ipAddress: getClientIp(req),
      message: `Pronunciation cache hit for ${word}.`,
      details: {
        word,
        source: cached.source
      }
    });
    return rowToPayload(cached);
  }

  const recentMiss = forceRefresh ? null : await findRecentPronunciationMiss(word);
  if (recentMiss) {
    queueServerLog({
      level: "info",
      category: "tts",
      action: "pronunciation_miss_cache_hit",
      actorUserId: req.user?.id || null,
      actorUsername: req.user?.username || "",
      method: req.method,
      route: req.path,
      ipAddress: getClientIp(req),
      message: `Pronunciation miss cache hit for ${word}.`,
      details: {
        word,
        ttlHours: PRONUNCIATION_MISS_TTL_HOURS
      }
    });

    return {
      available: false,
      word,
      cachedMiss: true,
      fallback: "browser_speech"
    };
  }

  const providers = [
    fetchFreeDictionaryPronunciation,
    fetchWikimediaPronunciation,
    fetchGeminiFlashTtsPronunciation,
    fetchGoogleCloudTtsPronunciation
  ];
  const failures = [];
  const retryErrors = [];

  for (const provider of providers) {
    try {
      const result = await provider(word);
      if (!result) {
        continue;
      }

      const saved = await savePronunciationAudio(result);
      queueServerLog({
        level: "info",
        category: "tts",
        action: "pronunciation_cached",
        actorUserId: req.user?.id || null,
        actorUsername: req.user?.username || "",
        method: req.method,
        route: req.path,
        ipAddress: getClientIp(req),
        message: `Pronunciation cached for ${word}.`,
        details: {
          word,
          source: saved.source
        }
      });
      return rowToPayload(saved);
    } catch (error) {
      if (error.prefetchRetryAt) {
        retryErrors.push(error);
      }
      failures.push({
        provider: provider.name,
        message: error.message
      });
    }
  }

  if (retryErrors.length) {
    throw retryErrors[0];
  }

  await savePronunciationMiss(word, failures);
  queueServerLog({
    level: failures.length ? "warn" : "info",
    category: "tts",
    action: "pronunciation_provider_failed",
    actorUserId: req.user?.id || null,
    actorUsername: req.user?.username || "",
    method: req.method,
    route: req.path,
    ipAddress: getClientIp(req),
    message: `No pronunciation provider succeeded for ${word}.`,
    details: {
      word,
      failures,
      ttlHours: PRONUNCIATION_MISS_TTL_HOURS
    }
  });

  return {
    available: false,
    word,
    fallback: "browser_speech"
  };
}

async function getNextPronunciationPrefetchJob() {
  return serverDb.get(
    `SELECT *
     FROM pronunciation_prefetch_jobs
     WHERE status = 'queued'
       AND next_attempt_at <= CURRENT_TIMESTAMP
     ORDER BY priority DESC, requested_at ASC, id ASC
     LIMIT 1`
  );
}

function getRetryAtAfterFailure(attempts) {
  const delayMinutes = Math.min(60, Math.max(2, 2 ** Math.min(5, attempts)));
  return new Date(Date.now() + delayMinutes * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

async function processPronunciationPrefetchQueue() {
  if (prefetchWorkerState.running) {
    return;
  }
  prefetchWorkerState.running = true;

  try {
    const job = await getNextPronunciationPrefetchJob();
    if (!job) {
      return;
    }

    await serverDb.run(
      `UPDATE pronunciation_prefetch_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP, last_error = NULL
       WHERE id = ?`,
      [job.id]
    );

    const workerRequest = {
      headers: {},
      user: null,
      method: "SYSTEM",
      path: "/api/tts/pronunciation/prefetch",
      ip: "local"
    };
    const payload = await resolvePronunciation(job.word_normalized, workerRequest, {
      forceRefresh: Boolean(job.refresh_requested)
    });

    if (payload.available) {
      await serverDb.run(
        `UPDATE pronunciation_prefetch_jobs
         SET status = 'completed', refresh_requested = 0, completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP, last_error = NULL
         WHERE id = ?`,
        [job.id]
      );
      queueServerLog({
        level: "info",
        category: "tts",
        action: "pronunciation_prefetch_completed",
        method: "SYSTEM",
        route: "/api/tts/pronunciation/prefetch",
        ipAddress: "local",
        message: `Pronunciation prefetch completed for ${job.word_normalized}.`,
        details: { word: job.word_normalized, source: payload.source }
      });
      return;
    }

    await serverDb.run(
      `UPDATE pronunciation_prefetch_jobs
       SET status = 'failed', failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           last_error = 'No pronunciation provider returned audio.'
       WHERE id = ?`,
      [job.id]
    );
  } catch (error) {
    const activeJob = await serverDb.get(
      `SELECT id, word_normalized, attempts
       FROM pronunciation_prefetch_jobs
       WHERE status = 'running'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    );
    if (!activeJob) {
      throw error;
    }

    const retryAt = error.prefetchRetryAt || getRetryAtAfterFailure(activeJob.attempts);
    await serverDb.run(
      `UPDATE pronunciation_prefetch_jobs
       SET status = 'queued', next_attempt_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [retryAt, String(error.message || "Prefetch failed.").slice(0, 500), activeJob.id]
    );
    queueServerLog({
      level: "warn",
      category: "tts",
      action: "pronunciation_prefetch_deferred",
      method: "SYSTEM",
      route: "/api/tts/pronunciation/prefetch",
      ipAddress: "local",
      message: `Pronunciation prefetch deferred for ${activeJob.word_normalized}.`,
      details: { word: activeJob.word_normalized, retryAt, error: error.message }
    });
  } finally {
    prefetchWorkerState.running = false;
  }
}

async function cleanupPronunciationCache() {
  const expiredRows = await serverDb.all(
    `SELECT id, file_path
     FROM pronunciation_cache
     WHERE last_used_at < datetime('now', ?)` ,
    [`-${PRONUNCIATION_CACHE_TTL_DAYS} days`]
  );

  for (const row of expiredRows) {
    const filePath = resolveCacheFilePath(row.file_path);
    if (filePath) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    await serverDb.run("DELETE FROM pronunciation_cache WHERE id = ?", [row.id]);
  }

  await serverDb.exec(`
    DELETE FROM pronunciation_miss_cache WHERE last_checked_at < datetime('now', '-7 days');
    DELETE FROM pronunciation_prefetch_jobs WHERE status IN ('completed', 'failed') AND updated_at < datetime('now', '-7 days');
    DELETE FROM pronunciation_usage WHERE last_requested_at < datetime('now', '-7 days');
    DELETE FROM pronunciation_provider_key_locks WHERE locked_until <= CURRENT_TIMESTAMP;
  `);

  if (expiredRows.length) {
    queueServerLog({
      level: "info",
      category: "tts",
      action: "pronunciation_cache_cleanup",
      method: "SYSTEM",
      route: "/api/tts/pronunciation",
      ipAddress: "local",
      message: "Expired pronunciation cache entries were removed.",
      details: { removed: expiredRows.length, ttlDays: PRONUNCIATION_CACHE_TTL_DAYS }
    });
  }
}

async function startPronunciationPrefetchWorker() {
  if (prefetchWorkerState.started) {
    return;
  }
  prefetchWorkerState.started = true;
  await serverDb.run(
    `UPDATE pronunciation_prefetch_jobs
     SET status = 'queued', next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'running'`
  );
  await cleanupPronunciationCache();
  await processPronunciationPrefetchQueue();
  prefetchWorkerState.timer = setInterval(() => {
    processPronunciationPrefetchQueue().catch((error) => console.error("Pronunciation prefetch worker failed.", error));
  }, PREFETCH_WORKER_INTERVAL_MS);
  prefetchWorkerState.cleanupTimer = setInterval(() => {
    cleanupPronunciationCache().catch((error) => console.error("Pronunciation cache cleanup failed.", error));
  }, PREFETCH_CLEANUP_INTERVAL_MS);
  prefetchWorkerState.timer.unref?.();
  prefetchWorkerState.cleanupTimer.unref?.();
}

router.get("/pronunciation", requireAuth, pronunciationRateLimit, async (req, res, next) => {
  try {
    const word = validatePronunciationWord(req.query.word);
    if (!word) {
      return res.status(400).json({
        message: "A valid English word or short phrase is required."
      });
    }

    if (isTruthyQueryFlag(req.query.cacheOnly)) {
      const cached = await findCachedPronunciation(word);
      return res.json(
        cached
          ? rowToPayload(cached)
          : {
              available: false,
              word,
              cacheOnly: true,
              externalLookupSkipped: true,
              fallback: "browser_speech"
            }
      );
    }

    const cached = await findCachedPronunciation(word);
    if (cached) {
      return res.json(rowToPayload(cached));
    }

    await enqueuePronunciationPrefetch(word, {
      priority: 100,
      requestedBy: req.user.isGuest ? null : req.user
    });
    return res.json({
      available: false,
      word,
      queued: true,
      fallback: "browser_speech"
    });
  } catch (error) {
    next(error);
  }
});

router.post("/pronunciation/prefetch", requireAuth, pronunciationPrefetchRateLimit, async (req, res, next) => {
  try {
    const requestedWords = Array.isArray(req.body?.words) ? req.body.words : [];
    const words = [...new Set(requestedWords.map(validatePronunciationWord).filter(Boolean))].slice(0, PREFETCH_BATCH_LIMIT);
    if (!words.length) {
      return res.status(400).json({ message: "Provide up to three valid English words or short phrases." });
    }

    await Promise.all(words.map((word, index) => enqueuePronunciationPrefetch(word, {
      priority: PREFETCH_BATCH_LIMIT - index,
      requestedBy: req.user.isGuest ? null : req.user
    })));
    return res.status(202).json({ queued: true, words });
  } catch (error) {
    next(error);
  }
});

router.get("/pronunciation/audio/:cacheKey", requireAuth, pronunciationRateLimit, async (req, res, next) => {
  try {
    const cacheKey = String(req.params.cacheKey || "").trim();
    if (!/^[a-f0-9]{40}$/i.test(cacheKey)) {
      return res.status(400).json({ message: "Invalid pronunciation cache key." });
    }

    const row = await serverDb.get(
      `SELECT *
       FROM pronunciation_cache
       WHERE cache_key = ?`,
      [cacheKey]
    );

    if (!row) {
      return res.status(404).json({ message: "Pronunciation audio was not found." });
    }

    const filePath = resolveCacheFilePath(row.file_path);
    if (!filePath) {
      return res.status(404).json({ message: "Pronunciation audio file is invalid." });
    }

    await fs.access(filePath);
    await serverDb.run(
      `UPDATE pronunciation_cache
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.id]
    );

    if (String(req.query.intent || "").toLowerCase() === "play") {
      const requestCount = await recordPronunciationUse(row.word_normalized, req.user);
      if (requestCount >= PRONUNCIATION_HIGH_FREQUENCY_THRESHOLD && isStalePronunciation(row)) {
        await enqueuePronunciationPrefetch(row.word_normalized, {
          priority: 100,
          refresh: true,
          requestedBy: req.user.isGuest ? null : req.user
        });
      }
    }

    res.setHeader("Content-Type", row.content_type || "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).json({ message: "Pronunciation audio file is missing." });
      return;
    }
    next(error);
  }
});

module.exports = {
  router,
  startPronunciationPrefetchWorker
};
