const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const { wordsDb, serverDb, clientDb } = require("../db/connections");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { clearPracticeWordCache } = require("./practice");
const {
  normalizeText,
  normalizeExample,
  normalizeEnglish,
  slugify,
  buildWordRef,
  parseMeaningEntries,
  cleanMeaningEntry
} = require("../utils/wordHelpers");
const { naturalCompare } = require("../utils/sort");
const { FIELD_LIMITS, validateTextField } = require("../utils/validation");
const { syncStudyData } = require("../utils/studySync");
const { queueServerLog } = require("../utils/serverLogger");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 10
  }
});

const draftJobs = new Map();
const draftJobQueue = [];
let activeDraftJobId = "";
const WORD_PIPELINE_MAX_UNIQUE_WORDS = 75;
const WORD_PIPELINE_MAX_SOURCE_ROWS = 120;
const MAX_REVIEWED_OCR_CHARS = 10_000;

function validateSourceName(value, required = true) {
  return validateTextField(value, "來源", { ...FIELD_LIMITS.sourceName, required });
}

function validateUnitName(value, required = true) {
  return validateTextField(value, "單元", { ...FIELD_LIMITS.unitName, required });
}

function loadGeminiApiKeysForWorkers() {
  const rawKeys = String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "").trim();
  if (!rawKeys) {
    return [];
  }

  const keys = rawKeys
    .split(/[\r\n,;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(keys)];
}

function buildWorkerConfigs(itemCount) {
  const keys = loadGeminiApiKeysForWorkers();
  const workerCount = Math.max(1, Math.min(itemCount || 1, keys.length || 1));

  if (!keys.length) {
    return [
      {
        id: 1,
        env: {
          GEMINI_WORKER_INDEX: "1",
          GEMINI_WORKER_COUNT: "1"
        }
      }
    ];
  }

  return Array.from({ length: workerCount }, (_, index) => ({
    id: index + 1,
    env: {
      GEMINI_API_KEY: keys[index],
      GEMINI_API_KEYS: keys[index],
      GEMINI_WORKER_INDEX: String(index + 1),
      GEMINI_WORKER_COUNT: String(workerCount)
    }
  }));
}

function isRateLimitError(error) {
  const message = String(error?.message || error || "").toUpperCase();
  return message.includes("429") || message.includes("EXHAUSTED") || message.includes("RATE_LIMIT");
}

function isDailyGeminiQuotaError(error) {
  const message = String(error?.message || error || "").toUpperCase();
  return (
    message.includes("PER_DAY")
    || message.includes("PERDAY")
    || message.includes("PER DAY")
    || message.includes("DAILY")
    || message.includes("REQUESTS_PER_MODEL_PER_DAY")
  );
}

function isGeminiPermissionError(error) {
  const message = String(error?.message || error || "").toUpperCase();
  return (
    message.includes("403")
    || message.includes("PERMISSION_DENIED")
    || message.includes("DENIED ACCESS")
    || message.includes("API_KEY_INVALID")
    || message.includes("API KEY NOT VALID")
    || message.includes("權限被拒絕")
  );
}

function getSortedJobs() {
  return [...draftJobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function jobBelongsToUser(job, userId) {
  return Boolean(job) && Number(job.createdBy || 0) === Number(userId || 0);
}

function getCurrentJob() {
  if (activeDraftJobId && draftJobs.has(activeDraftJobId)) {
    return draftJobs.get(activeDraftJobId);
  }

  const blockingJob = getSortedJobs().find((job) => !job.dismissed && (job.status === "queued" || job.status === "running"));
  if (blockingJob) {
    return blockingJob;
  }

  return getSortedJobs().find((job) => !job.dismissed && job.reviewPending) || null;
}

function getCurrentJobForUser(userId) {
  const sortedJobs = getSortedJobs().filter((job) => jobBelongsToUser(job, userId));

  if (activeDraftJobId && draftJobs.has(activeDraftJobId)) {
    const activeJob = draftJobs.get(activeDraftJobId);
    if (jobBelongsToUser(activeJob, userId)) {
      return activeJob;
    }
  }

  const blockingJob = sortedJobs.find((job) => !job.dismissed && (job.status === "queued" || job.status === "running"));
  if (blockingJob) {
    return blockingJob;
  }

  return sortedJobs.find((job) => !job.dismissed && job.reviewPending) || null;
}

function getOwnedJob(jobId, userId) {
  const job = draftJobs.get(jobId);
  if (!jobBelongsToUser(job, userId)) {
    return null;
  }
  return job;
}

function getBlockingJob() {
  return getCurrentJob();
}

function logDraftJobEvent(job, level, action, message, details = {}) {
  queueServerLog({
    level,
    category: "import",
    action,
    actorUserId: job.createdBy || null,
    method: "JOB",
    route: `/api/import/${job.operation || "import"}`,
    ipAddress: "",
    message,
    details: {
      jobId: job.id,
      operation: job.operation || "import",
      phase: job.phase || "",
      itemCount: Array.isArray(job.items) ? job.items.length : 0,
      ...details
    }
  });
}

function appendLog(target, percent, message) {
  target.progress = percent;
  target.message = message;
  target.updatedAt = Date.now();
  target.logs.push(`[${String(percent).padStart(2, "0")}%] ${message}`);
  if (target.logs.length > 40) {
    target.logs = target.logs.slice(-40);
  }
}

function createDraftJob(files, options = {}) {
  const ocrReviewRequired = Boolean(options.ocrReviewRequired);
  const job = {
    id: randomUUID(),
    createdBy: Number(options.createdBy || 0) || null,
    operation: "import",
    phase: ocrReviewRequired ? "ocr-review" : "analyze",
    status: "queued",
    reviewPending: false,
    dismissed: false,
    progress: 0,
    stage: "queued",
    message: activeDraftJobId ? "前方尚有任務，等待排程" : "等待開始",
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: files.map((file, index) => ({
      id: randomUUID(),
      index,
      fileName: file.originalname || `image-${index + 1}`,
      sourceName: "",
      unitName: "",
      status: "queued",
      progress: 0,
      stage: "queued",
      message: "等待開始",
      logs: [],
      rows: [],
      ocrText: "",
      error: "",
      tempFilePath: ""
    }))
  };

  appendLog(job, 0, `已建立批量任務，共 ${job.items.length} 張圖片`);
  draftJobs.set(job.id, job);
  logDraftJobEvent(job, "info", "job_created", `Image draft job created with ${job.items.length} item(s).`);
  return job;
}

function createTextDraftJob(batches, options = {}) {
  const operation = options.operation === "append" ? "append" : "import";
  const job = {
    id: randomUUID(),
    createdBy: Number(options.createdBy || 0) || null,
    operation,
    phase: "analyze",
    status: "queued",
    reviewPending: false,
    dismissed: false,
    progress: 0,
    stage: "queued",
    message: activeDraftJobId ? "前方尚有任務，等待排程" : "等待開始",
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: batches.map((batch, index) => ({
      id: randomUUID(),
      index,
      fileName: `${batch.sourceName} / ${batch.unitName}`,
      unitId: batch.unitId || null,
      sourceName: batch.sourceName,
      unitName: batch.unitName,
      status: "queued",
      progress: 0,
      stage: "queued",
      message: "等待開始",
      logs: [],
      rows: [],
      ocrText: "",
      error: "",
      tempFilePath: "",
      words: batch.words
    }))
  };

  appendLog(job, 0, `已建立英文列表任務，共 ${job.items.length} 批`);
  draftJobs.set(job.id, job);
  logDraftJobEvent(job, "info", "job_created", `Text draft job created with ${job.items.length} item(s).`, {
    operation
  });
  return job;
}

function createLibraryRefreshJob(units, options = {}) {
  const job = {
    id: randomUUID(),
    createdBy: Number(options.createdBy || 0) || null,
    operation: "refresh",
    status: "queued",
    reviewPending: false,
    dismissed: false,
    progress: 0,
    stage: "queued",
    message: activeDraftJobId ? "已有其他工作進行中，等待排隊。" : "等待開始",
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: units.map((unit, index) => ({
      id: randomUUID(),
      index,
      unitId: unit.unitId,
      fileName: `${unit.sourceName} / ${unit.unitName}`,
      sourceName: unit.sourceName,
      unitName: unit.unitName,
      status: "queued",
      progress: 0,
      stage: "queued",
      message: "等待開始",
      logs: [],
      rows: [],
      error: "",
      tempFilePath: "",
      words: unit.words
    }))
  };

  appendLog(job, 0, `已建立全庫英文重掃任務，共 ${job.items.length} 個單元。`);
  draftJobs.set(job.id, job);
  logDraftJobEvent(job, "info", "job_created", `Library refresh job created with ${job.items.length} unit(s).`, {
    operation: "refresh"
  });
  return job;
}

function sanitizeJobItem(item) {
  return {
    id: item.id,
    index: item.index,
    fileName: item.fileName,
    unitId: item.unitId || null,
    sourceName: item.sourceName,
    unitName: item.unitName,
    status: item.status,
    progress: item.progress,
    stage: item.stage,
    message: item.message,
    logs: item.logs,
    rows: item.rows,
    ocrText: item.ocrText,
    error: item.error
  };
}

function toJobResponse(job) {
  return {
    jobId: job.id,
    operation: job.operation || "import",
    phase: job.phase || "analyze",
    status: job.status,
    reviewPending: Boolean(job.reviewPending),
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    logs: job.logs,
    items: job.items.map(sanitizeJobItem)
  };
}

function updateBatchProgress(job, itemIndex, itemPercent, message, stage) {
  if (job.items[itemIndex]) {
    job.items[itemIndex].progress = itemPercent;
  }
  const total = job.items.length || 1;
  const aggregate = job.items.reduce((sum, item) => sum + Math.max(0, Math.min(100, Number(item.progress) || 0)), 0);
  job.progress = Math.min(100, Math.floor(aggregate / total));
  job.stage = stage;
  job.message = `[${itemIndex + 1}/${total}] ${message}`;
  job.updatedAt = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of draftJobs.entries()) {
    if (now - job.updatedAt > 30 * 60 * 1000) {
      draftJobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

async function getExistingUnit(sourceName, unitName) {
  return wordsDb.get(
    `SELECT
       u.id,
       u.name AS unit_name,
       s.name AS source_name
     FROM units u
     JOIN sources s ON s.id = u.source_id
     WHERE s.slug = ? AND u.slug = ?`,
    [slugify(sourceName), slugify(unitName)]
  );
}

async function ensureUnitIsEmpty(sourceName, unitName) {
  const unit = await getExistingUnit(sourceName, unitName);
  if (!unit) {
    return;
  }

  const countRow = await wordsDb.get("SELECT COUNT(*) AS count FROM words WHERE unit_id = ?", [unit.id]);
  if (countRow?.count) {
    const error = new Error(`${unit.source_name} / ${unit.unit_name} 已經有資料，請先刪除原單元再重新匯入。`);
    error.status = 409;
    throw error;
  }
}

async function getUnitById(unitId) {
  return wordsDb.get(
    `SELECT
       u.id,
       u.name AS unit_name,
       s.name AS source_name
     FROM units u
     JOIN sources s ON s.id = u.source_id
     WHERE u.id = ?`,
    [unitId]
  );
}

async function ensureSourceAndUnit(sourceName, unitName) {
  const sourceSlug = slugify(sourceName);
  const unitSlug = slugify(unitName);

  let source = await wordsDb.get("SELECT id, name FROM sources WHERE slug = ?", [sourceSlug]);
  if (!source) {
    const sourceResult = await wordsDb.run("INSERT INTO sources (name, slug) VALUES (?, ?)", [sourceName, sourceSlug]);
    source = { id: sourceResult.lastID, name: sourceName };
  }

  let unit = await wordsDb.get("SELECT id, name FROM units WHERE source_id = ? AND slug = ?", [source.id, unitSlug]);
  if (!unit) {
    const unitResult = await wordsDb.run(
      "INSERT INTO units (source_id, name, slug) VALUES (?, ?, ?)",
      [source.id, unitName, unitSlug]
    );
    unit = { id: unitResult.lastID, name: unitName };
  }

  return { source, unit };
}

async function remapStudyWordRefs(mappings) {
  if (!mappings.length) {
    return;
  }

  await clientDb.exec("BEGIN TRANSACTION");
  try {
    for (const mapping of mappings) {
      await clientDb.run(
        `UPDATE mastery_stats
         SET word_ref = ?,
             source_name = ?,
             unit_name = ?
         WHERE word_ref = ?`,
        [mapping.newWordRef, mapping.sourceName, mapping.unitName, mapping.oldWordRef]
      );

      await clientDb.run(
        `UPDATE study_logs
         SET word_ref = ?,
             source_name = ?,
             unit_name = ?
         WHERE word_ref = ?`,
        [mapping.newWordRef, mapping.sourceName, mapping.unitName, mapping.oldWordRef]
      );
    }
    await clientDb.exec("COMMIT");
  } catch (error) {
    await clientDb.exec("ROLLBACK");
    throw error;
  }
}


function buildWordRefMappings(words, sourceName, unitName) {
  return words.map((word) => ({
    id: word.id,
    unitId: Number(word.unitId || word.unit_id || 0) || null,
    oldWordRef: word.wordRef,
    newWordRef: buildWordRef({
      sourceName,
      unitName,
      eng: word.eng,
      tense: word.tense
    }),
    sourceName,
    unitName
  }));
}

function normalizeImportRow(row) {
  const eng = normalizeText(row?.eng);
  if (!eng) {
    return null;
  }

  const chValue = Array.isArray(row?.ch) ? JSON.stringify(row.ch, null, 2) : normalizeText(row?.ch);
  const exampleValue =
    typeof row.example === "string" ? row.example : JSON.stringify(row.example || [], null, 2);

  return {
    eng,
    kk: normalizeText(row.kk),
    tense: normalizeText(row.tense),
    ch: chValue,
    analysis: normalizeText(row.analysis || row.anlaysis),
    definition: normalizeText(row.definition),
    example: normalizeExample(exampleValue)
  };
}

function getPipelineWord(entry) {
  return normalizeText(typeof entry === "string" ? entry : entry?.eng);
}

function buildWordChunks(entries, maxUniqueWords = WORD_PIPELINE_MAX_UNIQUE_WORDS, maxSourceRows = WORD_PIPELINE_MAX_SOURCE_ROWS) {
  const groups = [];
  const groupsByWord = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const word = getPipelineWord(entry);
    const key = normalizeEnglish(word);
    if (!key) {
      continue;
    }

    let group = groupsByWord.get(key);
    if (!group) {
      group = [];
      groupsByWord.set(key, group);
      groups.push(group);
    }
    group.push(entry);
  }

  const chunks = [];
  let chunk = [];
  let uniqueWords = 0;
  for (const group of groups) {
    if (group.length > maxSourceRows) {
      throw new Error(`單字 ${getPipelineWord(group[0])} 共有 ${group.length} 筆來源資料，超過單批上限 ${maxSourceRows} 筆。`);
    }
    if (chunk.length && (uniqueWords >= maxUniqueWords || chunk.length + group.length > maxSourceRows)) {
      chunks.push(chunk);
      chunk = [];
      uniqueWords = 0;
    }
    chunk.push(...group);
    uniqueWords += 1;
  }
  if (chunk.length) {
    chunks.push(chunk);
  }
  return chunks;
}

async function processChunksResumable(state, runChunk) {
  for (let index = 0; index < state.chunks.length; index += 1) {
    if (state.results[index]) {
      continue;
    }
    state.results[index] = await runChunk(state.chunks[index], index, state.chunks.length);
  }
  return state.results.flat();
}

function mapChunkProgress(currentProgress, childProgress, chunkIndex, chunkCount) {
  const count = Math.max(1, Number(chunkCount) || 1);
  const local = Math.max(0, Math.min(100, Number(childProgress) || 0));
  const start = 4 + (92 * chunkIndex) / count;
  const end = 4 + (92 * (chunkIndex + 1)) / count;
  return Math.max(Number(currentProgress) || 0, Math.floor(start + ((end - start) * local) / 100));
}

function mergePipelineMetrics(target, metrics) {
  if (!metrics || typeof metrics !== "object") {
    return target;
  }
  const aggregate = target || {};
  for (const [key, value] of Object.entries(metrics)) {
    aggregate[key] = (Number(aggregate[key]) || 0) + (Number(value) || 0);
  }
  return aggregate;
}

function validateMergedWordRows(rows, sourceEntries) {
  const expectedWords = [];
  const expectedSet = new Set();
  for (const entry of sourceEntries || []) {
    const key = normalizeEnglish(getPipelineWord(entry));
    if (key && !expectedSet.has(key)) {
      expectedSet.add(key);
      expectedWords.push(key);
    }
  }

  const actualWords = [];
  const actualSet = new Set();
  const rowKeys = new Set();
  for (const row of rows || []) {
    const wordKey = normalizeEnglish(row.eng);
    const rowKey = `${wordKey}\u0000${normalizeText(row.tense).toLowerCase()}`;
    if (!expectedSet.has(wordKey)) {
      throw new Error(`AI 草稿包含非輸入單字：${row.eng}`);
    }
    if (rowKeys.has(rowKey)) {
      throw new Error(`AI 草稿包含重複 eng + tense：${row.eng} ${row.tense}`);
    }
    rowKeys.add(rowKey);
    if (!actualSet.has(wordKey)) {
      actualSet.add(wordKey);
      actualWords.push(wordKey);
    }
  }

  const missing = expectedWords.filter((word) => !actualSet.has(word));
  if (missing.length) {
    throw new Error(`AI 草稿遺漏輸入單字：${missing.join(", ")}`);
  }
  if (actualWords.some((word, index) => word !== expectedWords[index])) {
    throw new Error("AI 草稿合併後的單字順序與輸入不一致。");
  }
  return rows;
}

function hasExampleContent(value) {
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (typeof item === "string") {
        return normalizeText(item);
      }
      if (item && typeof item === "object") {
        return normalizeText(item.eng) || normalizeText(item.ch);
      }
      return false;
    });
  }

  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  try {
    const parsed = JSON.parse(text);
    return hasExampleContent(parsed);
  } catch {
    return false;
  }
}

function hasRefreshFieldValue(fieldName, value) {
  if (fieldName === "ch") {
    return parseMeaningEntries(value).length > 0;
  }
  if (fieldName === "example") {
    return hasExampleContent(value);
  }
  return Boolean(normalizeText(value));
}

function mergeRefreshRowWithExisting(row, existingRow) {
  if (!existingRow) {
    return row;
  }

  const merged = { ...row };
  for (const fieldName of ["kk", "tense", "ch", "analysis", "definition", "example"]) {
    if (!hasRefreshFieldValue(fieldName, merged[fieldName])) {
      merged[fieldName] = existingRow[fieldName];
    }
  }

  return merged;
}

function buildRefreshWordPayload(item) {
  return {
    mode: "refresh",
    items: (Array.isArray(item.words) ? item.words : []).map((word) => ({
      wordId: word.wordId || null,
      wordRef: word.wordRef || "",
      eng: word.eng || "",
      kk: word.kk || "",
      tense: word.tense || "",
      existing: {
        eng: word.eng || "",
        kk: word.kk || "",
        tense: word.tense || "",
        ch: word.ch || "",
        analysis: word.analysis || "",
        definition: word.definition || "",
        example: word.example || ""
      }
    }))
  };
}

function buildRefreshDraftRows(existingWords, normalizedRows) {
  const existingGroups = new Map();
  const generatedGroups = new Map();
  const wordOrder = [];

  for (const word of existingWords || []) {
    const key = normalizeEnglish(word.eng);
    if (!existingGroups.has(key)) {
      existingGroups.set(key, []);
      wordOrder.push(key);
    }
    existingGroups.get(key).push(word);
  }
  for (const row of normalizedRows || []) {
    const key = normalizeEnglish(row.eng);
    if (!generatedGroups.has(key)) {
      generatedGroups.set(key, []);
    }
    generatedGroups.get(key).push(row);
  }

  const draftRows = [];
  for (const wordKey of wordOrder) {
    const available = [...(existingGroups.get(wordKey) || [])];
    const generated = generatedGroups.get(wordKey) || [];
    const matches = Array(generated.length).fill(null);

    // Reserve exact eng + tense matches across the whole group first.
    for (let index = 0; index < generated.length; index += 1) {
      const tense = normalizeText(generated[index].tense);
      const matchIndex = available.findIndex((word) => normalizeText(word.tense) === tense);
      if (matchIndex >= 0) {
        matches[index] = available.splice(matchIndex, 1)[0];
      }
    }

    for (let index = 0; index < generated.length; index += 1) {
      const row = generated[index];
      const matched = matches[index] || available.shift() || null;
      const protectedRow = mergeRefreshRowWithExisting(row, matched);
      draftRows.push({
        wordId: matched?.wordId || null,
        wordRef: matched?.wordRef || "",
        ...protectedRow
      });
    }

    for (const existing of available) {
      const protectedRow = normalizeImportRow(existing);
      if (protectedRow) {
        draftRows.push({
          wordId: existing.wordId || null,
          wordRef: existing.wordRef || "",
          ...protectedRow
        });
      }
    }
  }

  return draftRows;
}

async function importRowsToUnit({ sourceName, unitName, rows, fileName, createdBy }) {
  sourceName = validateSourceName(sourceName);
  unitName = validateUnitName(unitName);
  await ensureUnitIsEmpty(sourceName, unitName);
  const { unit } = await ensureSourceAndUnit(sourceName, unitName);

  let importedCount = 0;
  let skippedDuplicateCount = 0;
  const seenWordRefs = new Set();
  for (const rawRow of rows) {
    const row = normalizeImportRow(rawRow);
    if (!row) {
      continue;
    }

    const wordRef = buildWordRef({
      sourceName,
      unitName,
      eng: row.eng,
      tense: row.tense
    });

    if (seenWordRefs.has(wordRef)) {
      skippedDuplicateCount += 1;
      continue;
    }
    seenWordRefs.add(wordRef);

    await wordsDb.run(
      `INSERT INTO words
         (word_ref, unit_id, eng, eng_normalized, kk, tense, ch, analysis, definition, example)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wordRef,
        unit.id,
        row.eng,
        normalizeEnglish(row.eng),
        row.kk,
        row.tense,
        row.ch,
        row.analysis,
        row.definition,
        row.example
      ]
    );
    importedCount += 1;
  }

  await serverDb.run(
    `INSERT INTO import_batches
       (source_name, unit_name, file_name, imported_count, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [sourceName, unitName, fileName, importedCount, createdBy]
  );

  await syncStudyData();
  return {
    importedCount,
    skippedDuplicateCount
  };
}

async function appendRowsToUnit({ unitId, rows, fileName, createdBy }) {
  const unit = await getUnitById(Number(unitId) || 0);
  if (!unit) {
    throw new Error("指定的單元不存在。");
  }

  const sourceName = unit.source_name;
  const unitName = unit.unit_name;
  const existingRows = await wordsDb.all(
    `SELECT word_ref
     FROM words
     WHERE unit_id = ?`,
    [unit.id]
  );
  const reservedRefs = new Set(existingRows.map((row) => row.word_ref));
  const seenWordRefs = new Set();
  let importedCount = 0;
  let skippedDuplicateCount = 0;

  await wordsDb.exec("BEGIN TRANSACTION");
  try {
    for (const rawRow of rows) {
      const row = normalizeImportRow(rawRow);
      if (!row) {
        skippedDuplicateCount += 1;
        continue;
      }

      const wordRef = buildWordRef({
        sourceName,
        unitName,
        eng: row.eng,
        tense: row.tense
      });

      if (seenWordRefs.has(wordRef) || reservedRefs.has(wordRef)) {
        skippedDuplicateCount += 1;
        continue;
      }

      seenWordRefs.add(wordRef);
      reservedRefs.add(wordRef);
      await wordsDb.run(
        `INSERT INTO words
           (word_ref, unit_id, eng, eng_normalized, kk, tense, ch, analysis, definition, example)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          wordRef,
          unit.id,
          row.eng,
          normalizeEnglish(row.eng),
          row.kk,
          row.tense,
          row.ch,
          row.analysis,
          row.definition,
          row.example
        ]
      );
      importedCount += 1;
    }

    await serverDb.run(
      `INSERT INTO import_batches
         (source_name, unit_name, file_name, imported_count, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [sourceName, unitName, fileName, importedCount, createdBy]
    );

    await wordsDb.exec("COMMIT");
  } catch (error) {
    await wordsDb.exec("ROLLBACK");
    throw error;
  }

  await syncStudyData();
  return {
    importedCount,
    skippedDuplicateCount,
    sourceName,
    unitName,
    unitId: unit.id
  };
}

function runPythonImagePipeline(tempFilePath, item, job, itemIndex) {
  return runPythonPipeline(["python", ["scripts/image_word_pipeline.py", tempFilePath]], item, job, itemIndex, "圖片辨識程序失敗。");
}

function runPythonOcrOnlyPipeline(tempFilePath, item, job, itemIndex) {
  return runPythonPipeline(
    ["python", ["scripts/image_word_pipeline.py", "--ocr-only", tempFilePath]],
    item,
    job,
    itemIndex,
    "OCR 辨識程序失敗。"
  );
}

function runPythonReviewedOcrPipeline(tempFilePath, item, job, itemIndex) {
  return runPythonPipeline(
    ["python", ["scripts/image_word_pipeline.py", "--ocr-text-json", tempFilePath]],
    item,
    job,
    itemIndex,
    "OCR 送交 AI 分析失敗。"
  );
}

function runPythonPipeline([command, args], item, job, itemIndex, fallbackError, envOverrides = {}, progressOptions = {}) {
  return new Promise((resolve, reject) => {
    const resolvedArgs = args.map((arg) =>
      arg === "scripts/image_word_pipeline.py" ? path.join(process.cwd(), arg) : arg
    );
    const python = spawn(command, resolvedArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...envOverrides,
        PYTHONIOENCODING: "utf-8"
      }
    });

    let stderr = "";
    let buffer = "";
    let resultPayload = null;

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed.startsWith("__WK_PROGRESS__")) {
        try {
          const payload = JSON.parse(trimmed.slice("__WK_PROGRESS__".length));
          const hasChunk = Number.isInteger(progressOptions.chunkIndex) && progressOptions.chunkCount;
          const progress = hasChunk
            ? mapChunkProgress(item.progress, payload.progress, progressOptions.chunkIndex, progressOptions.chunkCount)
            : Number(payload.progress || item.progress);
          const message = `${hasChunk ? `第 ${progressOptions.chunkIndex + 1}/${progressOptions.chunkCount} 批：` : ""}${payload.message || "處理中"}`;
          item.status = "running";
          item.stage = payload.stage || item.stage;
          appendLog(item, progress, message);
          updateBatchProgress(job, itemIndex, item.progress, `${item.fileName}：${item.message}`, item.stage);
          appendLog(job, job.progress, `${item.fileName}：${item.message}`);
        } catch {
          appendLog(item, item.progress, trimmed);
        }
        return;
      }

      if (trimmed.startsWith("__WK_RESULT__")) {
        resultPayload = JSON.parse(trimmed.slice("__WK_RESULT__".length));
        return;
      }

      appendLog(item, item.progress, trimmed);
    };

    python.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(handleLine);
    });

    python.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    python.on("error", (error) => {
      reject(new Error(`無法啟動 Python：${error.message}`));
    });

    python.on("close", (code) => {
      if (buffer.trim()) {
        handleLine(buffer);
      }

      if (code !== 0) {
        reject(new Error(resultPayload?.error || stderr.trim() || fallbackError));
        return;
      }

      if (!resultPayload) {
        reject(new Error(stderr.trim() || `${fallbackError} 回傳結果無法解析。`));
        return;
      }

      if (!resultPayload.ok) {
        reject(new Error(resultPayload.error || fallbackError));
        return;
      }

      resolve(resultPayload);
    });
  });
}

async function runWordChunks(job, item, itemIndex, workerConfig, totalWorkers, options = {}) {
  if (!item._wordChunkState) {
    if (item.tempFilePath) {
      await fs.unlink(item.tempFilePath).catch(() => {});
      item.tempFilePath = "";
    }
    const chunks = buildWordChunks(item.words);
    Object.defineProperty(item, "_wordChunkState", {
      value: { chunks, results: Array(chunks.length).fill(null) },
      writable: true,
      configurable: true
    });
    Object.defineProperty(item, "_pipelineMetrics", {
      value: {},
      writable: true,
      configurable: true
    });
    appendLog(item, item.progress || 1, `英文列表已分為 ${chunks.length} 批，每批最多 ${WORD_PIPELINE_MAX_UNIQUE_WORDS} 個單字／${WORD_PIPELINE_MAX_SOURCE_ROWS} 筆來源資料。`);
  }

  const state = item._wordChunkState;
  const words = await processChunksResumable(state, async (chunk, chunkIndex, chunkCount) => {
    const chunkPayload = options.refresh
      ? buildRefreshWordPayload({ words: chunk })
      : { words: chunk };
    const tempFilePath = path.join(
      os.tmpdir(),
      `words-king-${options.refresh ? "refresh" : "text"}-${job.id}-${item.id}-${chunkIndex + 1}.json`
    );
    item.tempFilePath = tempFilePath;
    await fs.writeFile(tempFilePath, JSON.stringify(chunkPayload, null, 2), "utf8");

    try {
      const payload = await runPythonPipeline(
        ["python", ["scripts/image_word_pipeline.py", "--words-json", tempFilePath]],
        item,
        job,
        itemIndex,
        options.fallbackError || "英文列表分析失敗。",
        {
          ...workerConfig.env,
          GEMINI_WORKER_INDEX: String(workerConfig.id),
          GEMINI_WORKER_COUNT: String(totalWorkers)
        },
        { chunkIndex, chunkCount }
      );
      item._pipelineMetrics = mergePipelineMetrics(item._pipelineMetrics, payload.metrics);
      return Array.isArray(payload.words) ? payload.words : [];
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
      if (item.tempFilePath === tempFilePath) {
        item.tempFilePath = "";
      }
    }
  });

  return {
    words,
    chunkCount: state.chunks.length,
    metrics: item._pipelineMetrics
  };
}

function appendPipelineMetricsLog(item, chunkCount) {
  const metrics = item._pipelineMetrics || {};
  appendLog(
    item,
    item.progress,
    `AI 統計：${chunkCount} 批、${Number(metrics.modelCalls) || 0} 次呼叫、input ${Number(metrics.promptTokens) || 0}、output ${Number(metrics.outputTokens) || 0}、cached ${Number(metrics.cachedTokens) || 0} tokens、耗時 ${Number(metrics.durationMs) || 0}ms；local/Gemini JSON repair ${Number(metrics.localJsonRepairs) || 0}/${Number(metrics.geminiJsonRepairs) || 0}，coverage repair ${Number(metrics.coverageRepairs) || 0}，pass fallback ${Number(metrics.secondPassFallbacks) || 0}/${Number(metrics.thirdPassFallbacks) || 0}/${Number(metrics.coverageFallbacks) || 0}。`
  );
}

function runPythonWordsJsonPipeline(tempFilePath, item, job, itemIndex) {
  return runPythonPipeline(
    ["python", ["scripts/image_word_pipeline.py", "--words-json", tempFilePath]],
    item,
    job,
    itemIndex,
    "英文重掃失敗。"
  );
}

function getDraftPipelineSpecParallel(job, item) {
  if (item.words?.length) {
    return {
      args: ["--words-json", item.tempFilePath],
      fallbackError: "英文列表分析失敗",
      buildRows(payload) {
        return Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
      },
      successMessage(itemRef) {
        return `英文列表完成，共 ${itemRef.rows.length} 筆。`;
      }
    };
  }

  if (job.phase === "ocr-review") {
    return {
      args: ["--ocr-only", item.tempFilePath],
      fallbackError: "OCR 辨識失敗",
      buildRows() {
        return [];
      },
      successMessage() {
        return "OCR 已完成，等待人工核對。";
      }
    };
  }

  if (job.phase === "ai-from-ocr") {
    return {
      args: ["--ocr-text-json", item.tempFilePath],
      fallbackError: "OCR 送交 AI 分析失敗",
      buildRows(payload) {
        return Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
      },
      successMessage(itemRef) {
        return `AI 草稿完成，共 ${itemRef.rows.length} 筆。`;
      }
    };
  }

  return {
    args: [item.tempFilePath],
    fallbackError: "圖片草稿分析失敗",
    buildRows(payload) {
      return Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
    },
    successMessage(itemRef) {
      return `圖片草稿完成，共 ${itemRef.rows.length} 筆。`;
    }
  };
}

function getRefreshPipelineSpecParallel(item) {
  return {
    args: ["--words-json", item.tempFilePath],
    fallbackError: "全庫重掃分析失敗",
    buildRows(payload) {
      const normalizedRows = Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
      return buildRefreshDraftRows(item.words, normalizedRows);
    },
    successMessage(itemRef) {
      return `重掃完成，共 ${itemRef.rows.length} 筆。`;
    }
  };
}

async function processJobItemsWithWorkers(job, processItem) {
  const workerConfigs = buildWorkerConfigs(job.items.length);
  const geminiKeys = loadGeminiApiKeysForWorkers();
  const keyPool = geminiKeys.map((key, index) => ({
    id: index + 1,
    disabled: false,
    inUse: false,
    cooldownUntil: 0,
    rateLimitCount: 0,
    lastFailure: "",
    env: {
      GEMINI_API_KEY: key,
      // Node owns cross-worker rotation. A child process must not consume another
      // worker's key because its cooldown state would be invisible here.
      GEMINI_API_KEYS: key
    }
  }));
  const queue = job.items.map((_, index) => index);
  const counters = {
    success: 0,
    failed: 0,
    workers: workerConfigs.length,
    keyStats: []
  };

  for (const item of job.items) {
    item.status = "running";
    item.stage = "queued";
    item.message = "等待處理";
    item.error = "";
    item.progress = 1;
    appendLog(item, 1, "已加入工作池。");
  }

  async function waitForKeySlot() {
    if (!keyPool.length) {
      return null;
    }

    while (true) {
      const now = Date.now();
      const availableSlot = keyPool.find(
        (slot) => !slot.disabled && !slot.inUse && slot.cooldownUntil <= now
      );
      if (availableSlot) {
        availableSlot.inUse = true;
        return availableSlot;
      }

      if (!keyPool.some((slot) => !slot.disabled)) {
        return null;
      }

      const nextCooldownAt = Math.min(
        ...keyPool
          .filter((slot) => !slot.disabled && !slot.inUse && slot.cooldownUntil > now)
          .map((slot) => slot.cooldownUntil)
      );
      const waitMs = Number.isFinite(nextCooldownAt)
        ? Math.max(180, Math.min(1000, nextCooldownAt - now))
        : 180;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  function releaseKeySlot(slot) {
    if (slot) {
      slot.inUse = false;
    }
  }

  function disableKeySlot(slot) {
    if (slot) {
      slot.disabled = true;
      slot.inUse = false;
    }
  }

  function coolDownKeySlot(slot, error) {
    slot.rateLimitCount += 1;
    slot.lastFailure = String(error?.message || error || "429").slice(0, 300);
    slot.inUse = false;

    if (isDailyGeminiQuotaError(error) || slot.rateLimitCount >= 3) {
      slot.disabled = true;
      return {
        disabled: true,
        waitSeconds: 0,
        reason: isDailyGeminiQuotaError(error) ? "daily quota exhausted" : "repeated rate limit"
      };
    }

    const waitSeconds = Math.min(60, 10 * (2 ** (slot.rateLimitCount - 1)));
    slot.cooldownUntil = Date.now() + waitSeconds * 1000;
    return {
      disabled: false,
      waitSeconds,
      reason: "temporary rate limit"
    };
  }

  async function runWorker(workerConfig) {
    while (queue.length) {
      const itemIndex = queue.shift();
      if (itemIndex === undefined) {
        return;
      }

      const item = job.items[itemIndex];
      item.workerId = workerConfig.id;
      appendLog(item, item.progress || 1, `由 worker ${workerConfig.id}/${workerConfigs.length} 處理。`);
      updateBatchProgress(job, itemIndex, item.progress || 1, `${item.fileName} -> worker ${workerConfig.id}/${workerConfigs.length}`, "queued");
      appendLog(job, job.progress, `${item.fileName} -> worker ${workerConfig.id}/${workerConfigs.length}`);

      try {
        while (true) {
          const keySlot = await waitForKeySlot();
          if (keyPool.length && !keySlot) {
            throw new Error("本次任務的 Gemini API key 已全部因 429 停用。");
          }

          const effectiveWorkerConfig = keySlot
            ? {
                ...workerConfig,
                env: {
                  ...workerConfig.env,
                  ...keySlot.env
                },
                keySlotId: keySlot.id
              }
            : workerConfig;

          if (keySlot) {
            appendLog(item, item.progress || 1, `使用 key ${keySlot.id}/${keyPool.length}。`);
            appendLog(job, job.progress, `${item.fileName} 使用 key ${keySlot.id}/${keyPool.length}`);
          }

          try {
            await processItem(item, itemIndex, effectiveWorkerConfig, workerConfigs.length);
            releaseKeySlot(keySlot);
            break;
          } catch (error) {
            if (keySlot && isGeminiPermissionError(error)) {
              disableKeySlot(keySlot);
              keySlot.lastFailure = String(error?.message || error || "403").slice(0, 300);
              appendLog(item, item.progress || 30, `key ${keySlot.id}/${keyPool.length} 發生 403 / permission denied，已停用並切換下一把重試。`);
              appendLog(job, job.progress, `${item.fileName} 的 key ${keySlot.id}/${keyPool.length} 因 403 / permission denied 停用`);
              logDraftJobEvent(job, "warn", "gemini_key_disabled", `Gemini key ${keySlot.id} was disabled after a permission error.`, {
                itemId: item.id,
                fileName: item.fileName,
                keySlotId: keySlot.id,
                reason: "permission_denied",
                error: error.message || String(error)
              });
              continue;
            }

            if (keySlot && isRateLimitError(error)) {
              const rateLimitState = coolDownKeySlot(keySlot, error);
              const actionText = rateLimitState.disabled
                ? `已停用（${rateLimitState.reason}）`
                : `冷卻 ${rateLimitState.waitSeconds} 秒`;
              appendLog(item, item.progress || 30, `key ${keySlot.id}/${keyPool.length} 發生 429，${actionText}，切換下一把重試。`);
              appendLog(job, job.progress, `${item.fileName} 的 key ${keySlot.id}/${keyPool.length} 發生 429，${actionText}`);
              logDraftJobEvent(job, "warn", "gemini_key_rate_limited", `Gemini key ${keySlot.id} was rate limited.`, {
                itemId: item.id,
                fileName: item.fileName,
                keySlotId: keySlot.id,
                disabled: rateLimitState.disabled,
                waitSeconds: rateLimitState.waitSeconds,
                rateLimitCount: keySlot.rateLimitCount,
                reason: rateLimitState.reason,
                error: error.message || String(error)
              });
              continue;
            }

            releaseKeySlot(keySlot);
            throw error;
          }
        }
        counters.success += 1;
      } catch (error) {
        item.status = "failed";
        item.stage = "failed";
        item.error = error.message;
        appendLog(item, item.progress || 0, `失敗：${error.message}`);
        updateBatchProgress(job, itemIndex, item.progress || 0, `${item.fileName} 失敗`, "failed");
        appendLog(job, job.progress, `${item.fileName} 失敗：${error.message}`);
        logDraftJobEvent(job, "error", "job_item_failed", `${item.fileName} failed: ${error.message || error}`, {
          itemId: item.id,
          fileName: item.fileName,
          sourceName: item.sourceName || "",
          unitName: item.unitName || "",
          stage: item.stage,
          workerId: item.workerId || null,
          progress: item.progress || 0,
          error: error.message || String(error),
          recentLogs: Array.isArray(item.logs) ? item.logs.slice(-5) : []
        });
        counters.failed += 1;
      } finally {
        if (item.tempFilePath) {
          await fs.unlink(item.tempFilePath).catch(() => {});
          item.tempFilePath = "";
        }
      }
    }
  }

  await Promise.all(workerConfigs.map((workerConfig) => runWorker(workerConfig)));
  counters.keyStats = keyPool.map((slot) => ({
    id: slot.id,
    disabled: slot.disabled,
    coolingDown: !slot.disabled && slot.cooldownUntil > Date.now(),
    rateLimitCount: slot.rateLimitCount,
    lastFailure: slot.lastFailure
  }));
  return counters;
}

async function processDraftJobParallel(job) {
  job.status = "running";
  job.stage = "queued";
  const workerCount = buildWorkerConfigs(job.items.length).length;
  logDraftJobEvent(job, "info", "job_started", `Draft job started with ${workerCount} worker(s).`, {
    workerCount
  });
  appendLog(
    job,
    1,
    job.phase === "ocr-review"
      ? `OCR 工作池啟動，worker ${workerCount} 個，共 ${job.items.length} 批。`
      : job.phase === "ai-from-ocr"
        ? `OCR -> AI 工作池啟動，worker ${workerCount} 個，共 ${job.items.length} 批。`
        : `AI 草稿工作池啟動，worker ${workerCount} 個，共 ${job.items.length} 批。`
  );

  const counters = await processJobItemsWithWorkers(job, async (item, itemIndex, workerConfig, totalWorkers) => {
    const spec = getDraftPipelineSpecParallel(job, item);
    const payload = item.words?.length
      ? await runWordChunks(job, item, itemIndex, workerConfig, totalWorkers, { fallbackError: spec.fallbackError })
      : await runPythonPipeline(
          ["python", ["scripts/image_word_pipeline.py", ...spec.args]],
          item,
          job,
          itemIndex,
          spec.fallbackError,
          {
            ...workerConfig.env,
            GEMINI_WORKER_INDEX: String(workerConfig.id),
            GEMINI_WORKER_COUNT: String(totalWorkers)
          }
        );

    item.rows = spec.buildRows(payload);
    validateMergedWordRows(item.rows, item.words || item.rows);
    if (!item.words?.length) {
      Object.defineProperty(item, "_pipelineMetrics", {
        value: mergePipelineMetrics(item._pipelineMetrics, payload.metrics),
        writable: true,
        configurable: true
      });
    }
    appendPipelineMetricsLog(item, payload.chunkCount || 1);
    item.ocrText = typeof payload.ocrText === "string" ? payload.ocrText : item.ocrText || "";
    item.status = "completed";
    item.stage = "done";
    appendLog(item, 100, spec.successMessage(item));
    updateBatchProgress(job, itemIndex, 100, `${item.fileName} 完成`, "done");
    appendLog(job, job.progress, `${item.fileName} 完成`);
    delete item._wordChunkState;
  });

  job.status = "completed";
  job.reviewPending = true;
  job.stage = job.phase === "ocr-review" ? "awaiting-ocr-review" : counters.failed ? "completed_with_errors" : "done";
  logDraftJobEvent(job, counters.failed ? "warn" : "info", "job_completed", `Draft job completed. Success: ${counters.success}, failed: ${counters.failed}.`, {
    successCount: counters.success,
    failedCount: counters.failed,
    workerCount: counters.workers,
    keyStats: counters.keyStats,
    failedItems: job.items
      .filter((item) => item.status === "failed")
      .slice(0, 10)
      .map((item) => ({
        itemId: item.id,
        fileName: item.fileName,
        error: item.error
      }))
  });
  appendLog(
    job,
    100,
    job.phase === "ocr-review"
      ? `OCR 工作池完成。worker ${counters.workers} 個，成功 ${counters.success} 批，失敗 ${counters.failed} 批。`
      : `AI 工作池完成。worker ${counters.workers} 個，成功 ${counters.success} 批，失敗 ${counters.failed} 批。`
  );
}

async function processLibraryRefreshJobParallel(job) {
  job.status = "running";
  job.stage = "queued";
  const workerCount = buildWorkerConfigs(job.items.length).length;
  logDraftJobEvent(job, "info", "job_started", `Library refresh job started with ${workerCount} worker(s).`, {
    workerCount
  });
  appendLog(job, 1, `全庫重掃工作池啟動，worker ${workerCount} 個，共 ${job.items.length} 個單元。`);

  const counters = await processJobItemsWithWorkers(job, async (item, itemIndex, workerConfig, totalWorkers) => {
    const spec = getRefreshPipelineSpecParallel(item);
    const payload = await runWordChunks(job, item, itemIndex, workerConfig, totalWorkers, {
      refresh: true,
      fallbackError: spec.fallbackError
    });

    item.rows = spec.buildRows(payload);
    validateMergedWordRows(item.rows, item.words);
    appendPipelineMetricsLog(item, payload.chunkCount);
    item.status = "completed";
    item.stage = "done";
    appendLog(item, 100, spec.successMessage(item));
    updateBatchProgress(job, itemIndex, 100, `${item.fileName} 完成`, "done");
    appendLog(job, job.progress, `${item.fileName} 完成`);
    delete item._wordChunkState;
  });

  job.status = "completed";
  job.reviewPending = true;
  job.stage = counters.failed ? "completed_with_errors" : "done";
  logDraftJobEvent(job, counters.failed ? "warn" : "info", "job_completed", `Library refresh job completed. Success: ${counters.success}, failed: ${counters.failed}.`, {
    successCount: counters.success,
    failedCount: counters.failed,
    workerCount: counters.workers,
    keyStats: counters.keyStats,
    failedItems: job.items
      .filter((item) => item.status === "failed")
      .slice(0, 10)
      .map((item) => ({
        itemId: item.id,
        fileName: item.fileName,
        error: item.error
      }))
  });
  appendLog(job, 100, `全庫重掃工作池完成。worker ${counters.workers} 個，成功 ${counters.success} 個單元，失敗 ${counters.failed} 個單元。`);
}

async function processDraftJob(job) {
  job.status = "running";
  job.stage = "queued";
  appendLog(
    job,
    1,
    job.phase === "ocr-review"
      ? `開始 OCR 辨識，共 ${job.items.length} 張圖片`
      : job.phase === "ai-from-ocr"
        ? `開始送交人工核對 OCR 至 AI，共 ${job.items.length} 張圖片`
        : `開始處理批量任務，共 ${job.items.length} 張圖片`
  );

  let successCount = 0;
  let failedCount = 0;

  for (const item of job.items) {
    item.status = "running";
    item.stage = "queued";
    item.message = "等待辨識";
    appendLog(item, 1, "已進入辨識佇列");
  }

  for (let index = 0; index < job.items.length; index += 1) {
    const item = job.items[index];

    try {
      if (job.phase === "ai-from-ocr") {
        appendLog(item, 2, "已接收人工核對 OCR，準備送交 AI");
        updateBatchProgress(job, index, 2, `${item.fileName}：已接收人工核對 OCR`, "queued");
      } else {
        appendLog(item, 2, "已接收圖片，準備建立辨識任務");
        updateBatchProgress(job, index, 2, `${item.fileName}：已接收圖片`, "queued");
      }

      const payload =
        item.words?.length
          ? await runPythonWordsJsonPipeline(item.tempFilePath, item, job, index)
          : job.phase === "ocr-review"
          ? await runPythonOcrOnlyPipeline(item.tempFilePath, item, job, index)
          : job.phase === "ai-from-ocr"
            ? await runPythonReviewedOcrPipeline(item.tempFilePath, item, job, index)
            : await runPythonImagePipeline(item.tempFilePath, item, job, index);

      item.rows = Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
      item.ocrText = typeof payload.ocrText === "string" ? payload.ocrText : item.ocrText || "";
      item.status = "completed";
      item.stage = "done";
      if (job.phase === "ocr-review") {
        appendLog(item, 100, "OCR 完成，等待人工核對");
        updateBatchProgress(job, index, 100, `${item.fileName}：OCR 完成`, "done");
        appendLog(job, job.progress, `${item.fileName}：OCR 完成，等待人工核對`);
      } else {
        appendLog(item, 100, `辨識完成，共 ${item.rows.length} 筆`);
        updateBatchProgress(job, index, 100, `${item.fileName}：辨識完成`, "done");
        appendLog(job, job.progress, `${item.fileName}：辨識完成，共 ${item.rows.length} 筆`);
      }
      successCount += 1;
    } catch (error) {
      item.status = "failed";
      item.stage = "failed";
      item.error = error.message;
      appendLog(item, item.progress || 0, `失敗：${error.message}`);
      updateBatchProgress(job, index, item.progress || 0, `${item.fileName}：失敗`, "failed");
      appendLog(job, job.progress, `${item.fileName}：失敗：${error.message}`);
      failedCount += 1;
    } finally {
      if (item.tempFilePath) {
        await fs.unlink(item.tempFilePath).catch(() => {});
        item.tempFilePath = "";
      }
    }
  }

  job.status = "completed";
  job.reviewPending = true;
  job.stage = job.phase === "ocr-review" ? "awaiting-ocr-review" : failedCount ? "completed_with_errors" : "done";
  appendLog(
    job,
    100,
    job.phase === "ocr-review"
      ? `OCR 完成。成功 ${successCount} 張，失敗 ${failedCount} 張，等待人工核對`
      : `批量辨識完成。成功 ${successCount} 張，失敗 ${failedCount} 張`
  );
}

async function processLibraryRefreshJob(job) {
  job.status = "running";
  job.stage = "queued";
  appendLog(job, 1, `開始全庫英文重掃，共 ${job.items.length} 個單元。`);

  let successCount = 0;
  let failedCount = 0;

  for (let index = 0; index < job.items.length; index += 1) {
    const item = job.items[index];
    item.status = "running";
    item.stage = "queued";
    item.message = "準備送出英文列表";
    appendLog(item, 1, "準備建立英文列表");

    try {
      const wordPayload = buildRefreshWordPayload(item);
      item.tempFilePath = path.join(os.tmpdir(), `words-king-refresh-${job.id}-${item.id}.json`);
      await fs.writeFile(item.tempFilePath, JSON.stringify(wordPayload, null, 2), "utf8");

      appendLog(item, 4, "英文列表已建立，送往 AI。");
      updateBatchProgress(job, index, 4, `${item.fileName}：已建立英文列表`, "queued");

      const payload = await runPythonWordsJsonPipeline(item.tempFilePath, item, job, index);
      const normalizedRows = Array.isArray(payload.words) ? payload.words.map(normalizeImportRow).filter(Boolean) : [];
      item.rows = buildRefreshDraftRows(item.words, normalizedRows);
      item.status = "completed";
      item.stage = "done";
      appendLog(item, 100, `重掃完成，共 ${item.rows.length} 筆。`);
      updateBatchProgress(job, index, 100, `${item.fileName}：重掃完成`, "done");
      appendLog(job, job.progress, `${item.fileName}：重掃完成，共 ${item.rows.length} 筆。`);
      successCount += 1;
    } catch (error) {
      item.status = "failed";
      item.stage = "failed";
      item.error = error.message;
      appendLog(item, item.progress || 0, `失敗：${error.message}`);
      updateBatchProgress(job, index, item.progress || 0, `${item.fileName}：失敗`, "failed");
      appendLog(job, job.progress, `${item.fileName}：失敗，${error.message}`);
      failedCount += 1;
    } finally {
      if (item.tempFilePath) {
        await fs.unlink(item.tempFilePath).catch(() => {});
        item.tempFilePath = "";
      }
    }
  }

  job.status = "completed";
  job.reviewPending = true;
  job.stage = failedCount ? "completed_with_errors" : "done";
  appendLog(job, 100, `全庫英文重掃完成：成功 ${successCount} 個單元，失敗 ${failedCount} 個單元。`);
}

async function drainDraftJobQueue() {
  if (activeDraftJobId || !draftJobQueue.length) {
    return;
  }

  const nextJob = draftJobQueue.shift();
  if (!nextJob) {
    return;
  }

  activeDraftJobId = nextJob.id;
  try {
    if (nextJob.operation === "refresh") {
      await processLibraryRefreshJobParallel(nextJob);
    } else {
      await processDraftJobParallel(nextJob);
    }
  } catch (error) {
    nextJob.status = "failed";
    nextJob.reviewPending = false;
    nextJob.stage = "failed";
    nextJob.updatedAt = Date.now();
    nextJob.message = error.message || "Draft job failed.";
    appendLog(nextJob, nextJob.progress || 0, `Job failed: ${nextJob.message}`);
    logDraftJobEvent(nextJob, "error", "job_failed", nextJob.message, {
      stack: error.stack || ""
    });
    throw error;
  } finally {
    activeDraftJobId = "";
    if (draftJobQueue.length) {
      drainDraftJobQueue().catch((error) => console.error(error));
    }
  }
}

router.post("/image-draft-jobs", requireAuth, requireAdmin, upload.array("images", 10), async (req, res, next) => {
  try {
    const blockingJob = getBlockingJob();
    if (blockingJob) {
      return res.status(409).json({
        message: "目前已有進行中或待核對的草稿任務，請先完成或清除後再建立新任務。",
        jobId: blockingJob.id
      });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ message: "請至少上傳一張圖片。" });
    }

    const ocrReviewRequired =
      req.body?.ocrReviewRequired === "true" ||
      req.body?.ocrReviewRequired === true ||
      req.body?.ocrReviewRequired === "1";

    const job = createDraftJob(files, { ocrReviewRequired, createdBy: req.user.id });
    for (const [index, file] of files.entries()) {
      const item = job.items[index];
      item.tempFilePath = path.join(
        os.tmpdir(),
        `words-king-${job.id}-${item.id}${path.extname(file.originalname || "").toLowerCase() || ".png"}`
      );
      await fs.writeFile(item.tempFilePath, file.buffer);
    }

    draftJobQueue.push(job);
    drainDraftJobQueue().catch((error) => console.error(error));

    res.status(202).json({
      message:
        activeDraftJobId && activeDraftJobId !== job.id
          ? "已加入排隊，將依序辨識。"
          : ocrReviewRequired
            ? "OCR 任務已開始，完成後可先人工核對再送 AI。"
            : "辨識任務已開始。",
      jobId: job.id
    });
  } catch (error) {
    next(error);
  }
});

router.post("/text-draft-jobs", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const blockingJob = getBlockingJob();
    if (blockingJob) {
      return res.status(409).json({
        message: "目前已有進行中的草稿任務，請先完成、清除或等待目前任務結束。",
        jobId: blockingJob.id
      });
    }

    const operation = req.body?.operation === "append" ? "append" : "import";
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = [];

    for (const item of rawItems) {
      const words = Array.isArray(item?.words) ? item.words.map((word) => normalizeText(word)).filter(Boolean) : [];
      if (!words.length) {
        continue;
      }

      if (operation === "append") {
        const unitId = Number(item?.unitId) || 0;
        if (!unitId) {
          continue;
        }

        const unit = await getUnitById(unitId);
        if (!unit) {
          return res.status(404).json({ message: "指定的單元不存在。" });
        }

        items.push({
          unitId: unit.id,
          sourceName: unit.source_name,
          unitName: unit.unit_name,
          words
        });
        continue;
      }

      const sourceName = item?.sourceName ? validateSourceName(item.sourceName, false) : "";
      const unitName = item?.unitName ? validateUnitName(item.unitName, false) : "";
      if (!sourceName || !unitName) {
        continue;
      }

      items.push({
        sourceName,
        unitName,
        words
      });
    }

    if (!items.length) {
      return res.status(400).json({
        message: operation === "append" ? "請至少選擇一個既有單元並提供補字英文列表。" : "請至少提供一批完整的來源、單元與英文列表。"
      });
    }

    const job = createTextDraftJob(items, { operation, createdBy: req.user.id });
    for (const item of job.items) {
      item.tempFilePath = path.join(os.tmpdir(), `words-king-text-${job.id}-${item.id}.json`);
      await fs.writeFile(item.tempFilePath, JSON.stringify({ words: item.words }, null, 2), "utf8");
    }

    draftJobQueue.push(job);
    drainDraftJobQueue().catch((error) => console.error(error));

    return res.status(202).json({
      message: operation === "append" ? "補字 AI 草稿任務已送出。" : "英文列表草稿任務已送出。",
      jobId: job.id
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/text-draft-jobs-legacy", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const blockingJob = getBlockingJob();
    if (blockingJob) {
      return res.status(409).json({
        message: "目前已有進行中或待核對的草稿任務，請先完成或清除後再建立新任務。",
        jobId: blockingJob.id
      });
    }

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems
      .map((item) => {
        const sourceName = item?.sourceName ? validateSourceName(item.sourceName, false) : "";
        const unitName = item?.unitName ? validateUnitName(item.unitName, false) : "";
        const words = Array.isArray(item?.words)
          ? item.words.map((word) => normalizeText(word)).filter(Boolean)
          : [];

        return {
          sourceName,
          unitName,
          words
        };
      })
      .filter((item) => item.sourceName && item.unitName && item.words.length);

    if (!items.length) {
      return res.status(400).json({ message: "請至少提供一批來源、單元與英文列表。" });
    }

    const job = createTextDraftJob(items, { createdBy: req.user.id });
    for (const item of job.items) {
      item.tempFilePath = path.join(os.tmpdir(), `words-king-text-${job.id}-${item.id}.json`);
      await fs.writeFile(item.tempFilePath, JSON.stringify({ words: item.words }, null, 2), "utf8");
    }

    draftJobQueue.push(job);
    drainDraftJobQueue().catch((error) => console.error(error));

    res.status(202).json({
      message: activeDraftJobId && activeDraftJobId !== job.id ? "已加入排隊，將依序分析。" : "英文列表分析任務已開始。",
      jobId: job.id
    });
  } catch (error) {
    next(error);
  }
});

router.post("/library-refresh-jobs", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const blockingJob = getBlockingJob();
    if (blockingJob) {
      return res.status(409).json({
        message: "目前已有進行中或待核對的草稿任務，請先完成或清除後再建立新任務。",
        jobId: blockingJob.id
      });
    }

    const sourceId = Number(req.body?.sourceId) || null;
    const rawUnitIds = Array.isArray(req.body?.unitIds) ? req.body.unitIds : [];
    const unitIds = rawUnitIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    const filters = ["EXISTS (SELECT 1 FROM words w WHERE w.unit_id = u.id)"];
    const params = [];

    if (sourceId && unitIds.length) {
      const unitScope = await wordsDb.all(
        `SELECT id
         FROM units
         WHERE source_id = ?
           AND id IN (${unitIds.map(() => "?").join(",")})`,
        [sourceId, ...unitIds]
      );

      if (unitScope.length !== unitIds.length) {
        return res.status(400).json({ message: "所選單元與來源不一致，請重新選擇。" });
      }
    }

    if (unitIds.length) {
      filters.push(`u.id IN (${unitIds.map(() => "?").join(",")})`);
      params.push(...unitIds);
    } else if (sourceId) {
      filters.push("s.id = ?");
      params.push(sourceId);
    }

    const units = await wordsDb.all(
      `SELECT
         u.id AS unitId,
         u.name AS unitName,
         s.name AS sourceName
       FROM units u
       JOIN sources s ON s.id = u.source_id
       WHERE ${filters.join(" AND ")}`,
      params
    );
    units.sort((a, b) => naturalCompare(a.sourceName, b.sourceName) || naturalCompare(a.unitName, b.unitName));

    if (!units.length) {
      return res.status(400).json({ message: "目前沒有可重掃的單字資料。" });
    }

    const unitItems = [];
    for (const unit of units) {
      const words = await wordsDb.all(
        `SELECT
           id AS wordId,
           word_ref AS wordRef,
           eng,
           kk,
           tense,
           ch,
           analysis,
           definition,
           example
         FROM words
         WHERE unit_id = ?
         ORDER BY id`,
        [unit.unitId]
      );

      if (!words.length) {
        continue;
      }

      unitItems.push({
        sourceName: unit.sourceName,
        unitName: unit.unitName,
        words
      });
    }

    if (!unitItems.length) {
      return res.status(400).json({ message: "目前沒有可重掃的單字資料。" });
    }

    const job = createLibraryRefreshJob(unitItems, { createdBy: req.user.id });
    draftJobQueue.push(job);
    drainDraftJobQueue().catch((error) => console.error(error));

    res.status(202).json({
      message: activeDraftJobId && activeDraftJobId !== job.id ? "全庫英文重掃已排入佇列。" : "全庫英文重掃已開始。",
      jobId: job.id
    });
  } catch (error) {
    next(error);
  }
});

router.get("/image-draft-jobs/:id", requireAuth, requireAdmin, async (req, res) => {
  const job = getOwnedJob(req.params.id, req.user.id);
  if (!job) {
    return res.status(404).json({ message: "找不到辨識任務。" });
  }

  res.json(toJobResponse(job));
});

router.get("/image-draft-jobs-current", requireAuth, requireAdmin, async (req, res) => {
  const job = getCurrentJobForUser(req.user.id);
  res.json({ job: job ? toJobResponse(job) : null });
});

router.post("/image-draft-jobs/:id/dismiss", requireAuth, requireAdmin, async (req, res) => {
  const job = getOwnedJob(req.params.id, req.user.id);
  if (!job) {
    return res.status(404).json({ message: "找不到草稿任務。" });
  }

  job.dismissed = true;
  job.reviewPending = false;
  job.updatedAt = Date.now();
  logDraftJobEvent(job, "info", "job_dismissed", "Draft job dismissed by owner.");
  res.json({ message: "草稿任務已清除。" });
});

router.post("/image-draft-jobs/:id/continue-ocr", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const job = getOwnedJob(req.params.id, req.user.id);
    if (!job) {
      return res.status(404).json({ message: "找不到草稿任務。" });
    }

    if (job.operation !== "import" || job.phase !== "ocr-review" || !job.reviewPending) {
      return res.status(400).json({ message: "這筆草稿目前不能進行 OCR 核對後送 AI。" });
    }

    const blockingJob = getBlockingJob();
    if (blockingJob && blockingJob.id !== job.id) {
      return res.status(409).json({ message: "目前已有其他進行中或待核對任務，請稍後再試。", jobId: blockingJob.id });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "沒有可送交 AI 的 OCR 核對內容。" });
    }

    const byId = new Map(items.map((item) => [item.itemId, item]));
    for (const jobItem of job.items) {
      const reviewed = byId.get(jobItem.id);
      if (!reviewed) {
        continue;
      }

      const ocrText = normalizeText(reviewed.ocrText);
      if (!ocrText) {
        return res.status(400).json({ message: `${jobItem.fileName} 的 OCR 內容不可為空。` });
      }
      if (ocrText.length > MAX_REVIEWED_OCR_CHARS) {
        return res.status(400).json({
          message: `${jobItem.fileName} 的 OCR 內容超過 ${MAX_REVIEWED_OCR_CHARS.toLocaleString()} 個字元，請先拆頁後再送出。`
        });
      }

      jobItem.ocrText = ocrText;
      jobItem.sourceName = reviewed.sourceName
        ? validateSourceName(reviewed.sourceName, false) || jobItem.sourceName || ""
        : jobItem.sourceName || "";
      jobItem.unitName = reviewed.unitName
        ? validateUnitName(reviewed.unitName, false) || jobItem.unitName || ""
        : jobItem.unitName || "";
      jobItem.rows = [];
      jobItem.error = "";
      jobItem.status = "queued";
      jobItem.stage = "queued";
      jobItem.progress = 0;
      jobItem.message = "等待送交 AI";
      jobItem.logs = [];
      jobItem.tempFilePath = path.join(os.tmpdir(), `words-king-ocr-review-${job.id}-${jobItem.id}.json`);
      await fs.writeFile(jobItem.tempFilePath, JSON.stringify({ ocrText }, null, 2), "utf8");
    }

    job.phase = "ai-from-ocr";
    job.status = "queued";
    job.reviewPending = false;
    job.progress = 0;
    job.stage = "queued";
    job.message = activeDraftJobId ? "前方尚有任務，等待排程" : "等待開始";
    job.logs = [];
    job.updatedAt = Date.now();
    appendLog(job, 0, `已接收人工核對 OCR，共 ${job.items.length} 張圖片，準備送交 AI`);

    draftJobQueue.push(job);
    drainDraftJobQueue().catch((error) => console.error(error));

    res.status(202).json({
      message: activeDraftJobId && activeDraftJobId !== job.id ? "已加入排隊，將依序送交 AI。" : "已開始送交 AI 生成草稿。",
      jobId: job.id
    });
  } catch (error) {
    next(error);
  }
});

router.post("/reviewed-words", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sourceName = validateSourceName(req.body.sourceName);
    const unitName = validateUnitName(req.body.unitName);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    if (!rows.length) {
      return res.status(400).json({ message: "沒有可匯入的單字資料。" });
    }

    const result = await importRowsToUnit({
      sourceName,
      unitName,
      rows,
      fileName: normalizeText(req.body.fileName) || "image-review",
      createdBy: req.user.id
    });

    clearPracticeWordCache();

    res.status(201).json({
      message: "核對後匯入完成。",
      importedCount: result.importedCount,
      skippedDuplicateCount: result.skippedDuplicateCount
    });
  } catch (error) {
    next(error);
  }
});

router.post("/reviewed-words-append", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const unitId = Number(req.body.unitId) || null;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    if (!unitId) {
      return res.status(400).json({ message: "請先指定要補字的單元。" });
    }

    if (!rows.length) {
      return res.status(400).json({ message: "沒有可追加的單字資料。" });
    }

    const result = await appendRowsToUnit({
      unitId,
      rows,
      fileName: normalizeText(req.body.fileName) || "append-review",
      createdBy: req.user.id
    });

    clearPracticeWordCache();

    res.status(201).json({
      message: "補字已寫入既有單元。",
      importedCount: result.importedCount,
      skippedDuplicateCount: result.skippedDuplicateCount
    });
  } catch (error) {
    next(error);
  }
});

router.post("/reviewed-words-refresh", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requestedSourceName = req.body.sourceName ? validateSourceName(req.body.sourceName, false) : "";
    const requestedUnitName = req.body.unitName ? validateUnitName(req.body.unitName, false) : "";
    const requestedUnitId = Number(req.body.unitId) || null;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    if (!requestedUnitId && (!requestedSourceName || !requestedUnitName)) {
      return res.status(400).json({ message: "請提供來源與單元。" });
    }

    if (!rows.length) {
      return res.status(400).json({ message: "沒有可覆蓋的單字資料。" });
    }

    const unit = requestedUnitId
      ? await getUnitById(requestedUnitId)
      : await getExistingUnit(requestedSourceName, requestedUnitName);

    if (!unit) {
      return res.status(404).json({ message: "找不到要覆蓋的單元。" });
    }

    const sourceName = unit.source_name;
    const unitName = unit.unit_name;
    const existingRows = await wordsDb.all(
      `SELECT id, word_ref, eng, kk, tense, ch, analysis, definition, example
       FROM words
       WHERE unit_id = ?`,
      [unit.id]
    );
    const existingById = new Map(existingRows.map((row) => [Number(row.id), row]));
    const usedExistingIds = new Set();
    const seenWordRefs = new Set();
    const remapByOldRef = new Map();
    const rowsToInsert = [];
    let skippedCount = 0;

    for (const rawRow of rows) {
      const row = normalizeImportRow(rawRow);
      if (!row) {
        skippedCount += 1;
        continue;
      }

      const nextWordRef = buildWordRef({
        sourceName,
        unitName,
        eng: row.eng,
        tense: row.tense
      });

      if (seenWordRefs.has(nextWordRef)) {
        skippedCount += 1;
        continue;
      }
      seenWordRefs.add(nextWordRef);

      const requestedWordId = Number(rawRow.wordId) || null;
      let matchedExisting =
        requestedWordId && existingById.has(requestedWordId) && !usedExistingIds.has(requestedWordId)
          ? existingById.get(requestedWordId)
          : null;

      if (!matchedExisting) {
        matchedExisting = existingRows.find(
          (currentWord) =>
            !usedExistingIds.has(currentWord.id) &&
            normalizeEnglish(currentWord.eng) === normalizeEnglish(row.eng) &&
            normalizeText(currentWord.tense) === normalizeText(row.tense)
        );
      }

      if (!matchedExisting) {
        matchedExisting = existingRows.find(
          (currentWord) =>
            !usedExistingIds.has(currentWord.id) &&
            normalizeEnglish(currentWord.eng) === normalizeEnglish(row.eng)
        );
      }

      if (matchedExisting) {
        usedExistingIds.add(matchedExisting.id);
        remapByOldRef.set(matchedExisting.word_ref, {
          newWordRef: nextWordRef,
          newEntries: parseMeaningEntries(row.ch)
        });
      }

      const protectedRow = mergeRefreshRowWithExisting(row, matchedExisting);

      rowsToInsert.push({
        wordRef: nextWordRef,
        eng: protectedRow.eng,
        kk: protectedRow.kk,
        tense: protectedRow.tense,
        ch: protectedRow.ch,
        analysis: protectedRow.analysis,
        definition: protectedRow.definition,
        example: protectedRow.example
      });
    }

    if (!rowsToInsert.length) {
      return res.status(400).json({ message: "草稿沒有可寫入的有效單字。" });
    }

    await wordsDb.exec("BEGIN TRANSACTION");
    try {
      await wordsDb.run("DELETE FROM words WHERE unit_id = ?", [unit.id]);

      for (const row of rowsToInsert) {
        await wordsDb.run(
          `INSERT INTO words
             (word_ref, unit_id, eng, eng_normalized, kk, tense, ch, analysis, definition, example)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.wordRef,
            unit.id,
            row.eng,
            normalizeEnglish(row.eng),
            row.kk,
            row.tense,
            row.ch,
            row.analysis,
            row.definition,
            row.example
          ]
        );
      }

      await wordsDb.exec("COMMIT");
    } catch (error) {
      await wordsDb.exec("ROLLBACK");
      throw error;
    }

    const mappings = [...remapByOldRef.entries()].map(([oldWordRef, remap]) => ({
      unitId: unit.id,
      oldWordRef,
      newWordRef: remap.newWordRef,
      newEntries: remap.newEntries,
      sourceName,
      unitName
    }));

    if (mappings.length) {
      await remapStudyWordRefs(mappings);
    }

    await syncStudyData();

    clearPracticeWordCache();

    res.status(200).json({
      message: "全庫重掃草稿已完整覆蓋目前單元資料。",
      importedCount: rowsToInsert.length,
      skippedDuplicateCount: skippedCount
    });
  } catch (error) {
    next(error);
  }
});

router.post("/reviewed-words-refresh-legacy", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sourceName = validateSourceName(req.body.sourceName);
    const unitName = validateUnitName(req.body.unitName);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    if (!rows.length) {
      return res.status(400).json({ message: "沒有可更新的草稿資料。" });
    }

    const unit = await getExistingUnit(sourceName, unitName);
    if (!unit) {
      return res.status(404).json({ message: "找不到對應單元。" });
    }

    const existingRows = await wordsDb.all(
      `SELECT id, word_ref
              , eng, kk, tense, ch, analysis, definition, example
       FROM words
       WHERE unit_id = ?`,
      [unit.id]
    );
    const existingById = new Map(existingRows.map((row) => [Number(row.id), row]));
    const reservedRefs = new Set(existingRows.map((row) => row.word_ref));

    let updatedCount = 0;
    let skippedCount = 0;
    const mappings = [];

    for (const rawRow of rows) {
      const wordId = Number(rawRow.wordId);
      const existing = existingById.get(wordId);
      const row = normalizeImportRow(rawRow);

      if (!existing || !row) {
        skippedCount += 1;
        continue;
      }

      const protectedRow = mergeRefreshRowWithExisting(row, existing);

      const nextWordRef = buildWordRef({
        sourceName,
        unitName,
        eng: protectedRow.eng,
        tense: protectedRow.tense
      });

      if (nextWordRef !== existing.word_ref && reservedRefs.has(nextWordRef)) {
        skippedCount += 1;
        continue;
      }

      reservedRefs.delete(existing.word_ref);
      reservedRefs.add(nextWordRef);

      await wordsDb.run(
        `UPDATE words
         SET word_ref = ?,
             eng = ?,
             eng_normalized = ?,
             kk = ?,
             tense = ?,
             ch = ?,
             analysis = ?,
             definition = ?,
             example = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nextWordRef,
          protectedRow.eng,
          normalizeEnglish(protectedRow.eng),
          protectedRow.kk,
          protectedRow.tense,
          protectedRow.ch,
          protectedRow.analysis,
          protectedRow.definition,
          protectedRow.example,
          wordId
        ]
      );
      mappings.push({
        unitId: unit.id,
        oldWordRef: existing.word_ref,
        newWordRef: nextWordRef,
        newEntries: parseMeaningEntries(protectedRow.ch),
        sourceName,
        unitName
      });
      updatedCount += 1;
    }

    if (mappings.length) {
      await remapStudyWordRefs(mappings);
    }

    await syncStudyData();

    clearPracticeWordCache();

    res.status(200).json({
      message: "英文重掃更新完成。",
      importedCount: updatedCount,
      skippedDuplicateCount: skippedCount
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/sources/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sourceId = Number(req.params.id);
    const nextName = validateSourceName(req.body.name);

    if (!nextName) {
      return res.status(400).json({ message: "來源名稱不可為空。" });
    }

    const source = await wordsDb.get("SELECT id, name, slug FROM sources WHERE id = ?", [sourceId]);
    if (!source) {
      return res.status(404).json({ message: "找不到來源。" });
    }

    const nextSlug = slugify(nextName);
    const duplicate = await wordsDb.get("SELECT id FROM sources WHERE slug = ? AND id != ?", [nextSlug, sourceId]);
    if (duplicate) {
      return res.status(409).json({ message: "已有相同來源名稱。" });
    }

    const words = await wordsDb.all(
      `SELECT
         w.id,
         w.word_ref AS wordRef,
         w.eng,
         w.tense,
         u.id AS unitId,
         u.name AS unitName
       FROM words w
       JOIN units u ON u.id = w.unit_id
       WHERE u.source_id = ?
       ORDER BY w.id`,
      [sourceId]
    );
    const mappings = words.map((word) => ({
      ...buildWordRefMappings(
        [
          {
            id: word.id,
            wordRef: word.wordRef,
            eng: word.eng,
            tense: word.tense
          }
        ],
        nextName,
        word.unitName
      )[0]
    }));

    await wordsDb.exec("BEGIN TRANSACTION");
    try {
      await wordsDb.run(
        "UPDATE sources SET name = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [nextName, nextSlug, sourceId]
      );

      for (const mapping of mappings) {
        await wordsDb.run(
          "UPDATE words SET word_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [mapping.newWordRef, mapping.id]
        );
      }

      await wordsDb.exec("COMMIT");
    } catch (error) {
      await wordsDb.exec("ROLLBACK");
      throw error;
    }

    await remapStudyWordRefs(mappings);
    await syncStudyData();
    clearPracticeWordCache();
    res.json({ message: "來源名稱已更新。" });
  } catch (error) {
    next(error);
  }
});

router.patch("/units/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const unitId = Number(req.params.id);
    const nextName = validateUnitName(req.body.name);
    const nextSourceId = Number(req.body.sourceId) || null;

    if (!nextName) {
      return res.status(400).json({ message: "單元名稱不可為空。" });
    }

    const unit = await wordsDb.get(
      `SELECT
         u.id,
         u.name,
         u.source_id AS sourceId,
         s.name AS sourceName
       FROM units u
       JOIN sources s ON s.id = u.source_id
       WHERE u.id = ?`,
      [unitId]
    );
    if (!unit) {
      return res.status(404).json({ message: "找不到單元。" });
    }

    let targetSource = null;
    if (nextSourceId) {
      targetSource = await wordsDb.get("SELECT id, name FROM sources WHERE id = ?", [nextSourceId]);
      if (!targetSource) {
        return res.status(404).json({ message: "找不到目標來源。" });
      }
    } else {
      targetSource = { id: unit.sourceId, name: unit.sourceName };
    }

    const nextSlug = slugify(nextName);
    const duplicate = await wordsDb.get(
      "SELECT id FROM units WHERE source_id = ? AND slug = ? AND id != ?",
      [targetSource.id, nextSlug, unitId]
    );
    if (duplicate) {
      return res.status(409).json({ message: "此來源下已有相同單元名稱。" });
    }

    const words = await wordsDb.all(
      `SELECT
         id,
         word_ref AS wordRef,
         eng,
         tense,
         unit_id AS unitId
       FROM words
       WHERE unit_id = ?
       ORDER BY id`,
      [unitId]
    );
    const mappings = buildWordRefMappings(words, targetSource.name, nextName);

    await wordsDb.exec("BEGIN TRANSACTION");
    try {
      await wordsDb.run(
        "UPDATE units SET source_id = ?, name = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [targetSource.id, nextName, nextSlug, unitId]
      );

      for (const mapping of mappings) {
        await wordsDb.run(
          "UPDATE words SET word_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [mapping.newWordRef, mapping.id]
        );
      }

      if (targetSource.id !== unit.sourceId) {
        const leftUnits = await wordsDb.get("SELECT COUNT(*) AS count FROM units WHERE source_id = ?", [unit.sourceId]);
        if (!leftUnits?.count) {
          await wordsDb.run("DELETE FROM sources WHERE id = ?", [unit.sourceId]);
        }
      }

      await wordsDb.exec("COMMIT");
    } catch (error) {
      await wordsDb.exec("ROLLBACK");
      throw error;
    }

    await remapStudyWordRefs(mappings);
    await syncStudyData();
    clearPracticeWordCache();
    res.json({
      message:
        targetSource.id !== unit.sourceId
          ? "單元名稱與來源已更新。"
          : "單元名稱已更新。"
    });
  } catch (error) {
    next(error);
  }
});

router.get("/catalog", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sources = await wordsDb.all("SELECT id, name FROM sources");
    sources.sort((a, b) => naturalCompare(a.name, b.name));
    const result = [];

    for (const source of sources) {
      const units = await wordsDb.all(
        `SELECT
           u.id,
           u.name,
           (SELECT COUNT(*) FROM words w WHERE w.unit_id = u.id) AS word_count
         FROM units u
         WHERE u.source_id = ?`,
        [source.id]
      );
      units.sort((a, b) => naturalCompare(a.name, b.name));
      result.push({ ...source, units });
    }

    res.json({ sources: result });
  } catch (error) {
    next(error);
  }
});

router.delete("/units/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const unit = await wordsDb.get(
      `SELECT u.id, u.name, u.source_id, s.name AS source_name
       FROM units u
       JOIN sources s ON s.id = u.source_id
       WHERE u.id = ?`,
      [req.params.id]
    );

    if (!unit) {
      return res.status(404).json({ message: "找不到單元。" });
    }

    await wordsDb.run("DELETE FROM units WHERE id = ?", [req.params.id]);
    const leftUnits = await wordsDb.get("SELECT COUNT(*) AS count FROM units WHERE source_id = ?", [unit.source_id]);
    if (!leftUnits?.count) {
      await wordsDb.run("DELETE FROM sources WHERE id = ?", [unit.source_id]);
    }

    await syncStudyData();
    clearPracticeWordCache();
    res.json({ message: `${unit.source_name} / ${unit.name} 已刪除。` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports._test = {
  buildRefreshDraftRows,
  buildWordChunks,
  mapChunkProgress,
  processChunksResumable,
  validateMergedWordRows
};
