"use strict";

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const { dbPaths } = require("../../src/config");
const {
  normalizeEnglish,
  slugify,
  buildWordRef
} = require("../../src/utils/wordHelpers");

const SOURCE_NAME = "大考中心高中英文參考詞彙表";
const PDF_SHA256 = "27B010F8230B2E8763653DDB35783FE9E0140C143B0040F13839046AEBB2A126";
const EXPECTED_OFFICIAL = Object.freeze({ 1: 1002, 2: 1002, 3: 1002, 4: 1002, 5: 1002, 6: 1002 });
const EXPECTED_EXPANDED = Object.freeze({ 1: 1056, 2: 1046, 3: 1022, 4: 1028, 5: 1009, 6: 1035 });
const EXISTING_SOURCE_COUNTS = Object.freeze({ "字彙王": 3178, "龍騰課本": 402, "學測模擬試題-字彙題單字": 106 });
const FIELDS = Object.freeze(["eng", "kk", "tense", "ch", "analysis", "definition", "example"]);
const ALLOWED_TENSES = new Set([
  "n.", "vt.", "vi.", "v.", "adj.", "adv.", "prep.", "conj.",
  "pron.", "interj.", "det.", "aux.", "modal v."
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeText(value) {
  return (value ?? "").toString().trim();
}

function hasText(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0 && value.every(hasText);
  if (value && typeof value === "object") return Object.values(value).length > 0 && Object.values(value).every(hasText);
  return false;
}

function normalizeRow(row) {
  return {
    eng: normalizeText(row.eng),
    kk: normalizeText(row.kk),
    tense: normalizeText(row.tense),
    ch: JSON.stringify(row.ch, null, 2),
    analysis: normalizeText(row.analysis),
    definition: normalizeText(row.definition),
    example: JSON.stringify(row.example, null, 2)
  };
}

function validateRow(row, context, allowedInputs, seenKeys) {
  assert(row && typeof row === "object" && !Array.isArray(row), `${context}: row must be an object`);
  assert(JSON.stringify(Object.keys(row)) === JSON.stringify(FIELDS), `${context}: seven-field contract/order mismatch`);
  for (const field of ["eng", "kk", "tense", "analysis", "definition"]) {
    assert(typeof row[field] === "string" && row[field].trim(), `${context}: ${field} is empty or invalid`);
  }
  assert(ALLOWED_TENSES.has(row.tense.trim()), `${context}: invalid tense ${JSON.stringify(row.tense)}`);
  assert(Array.isArray(row.ch) && hasText(row.ch), `${context}: ch must be a non-empty nested string array`);
  assert(Array.isArray(row.example) && row.example.length > 0, `${context}: example must be a non-empty array`);
  for (const [index, example] of row.example.entries()) {
    assert(example && typeof example === "object" && !Array.isArray(example), `${context}: example ${index + 1} is invalid`);
    assert(typeof example.eng === "string" && example.eng.trim(), `${context}: example ${index + 1} English is empty`);
    assert(typeof example.ch === "string" && example.ch.trim(), `${context}: example ${index + 1} Chinese is empty`);
  }

  const eng = normalizeEnglish(row.eng);
  assert(allowedInputs.has(eng), `${context}: unexpected surface form ${JSON.stringify(row.eng)}`);
  const key = `${eng}\u0000${row.tense.trim()}`;
  assert(!seenKeys.has(key), `${context}: duplicate eng + tense ${JSON.stringify(row.eng)} / ${row.tense}`);
  seenKeys.add(key);
  return eng;
}

function loadAndValidate(manifestPath, resultsDir) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(manifest.sourceName === SOURCE_NAME, "manifest source name mismatch");
  assert(manifest.pdfSha256 === PDF_SHA256, "manifest PDF SHA-256 mismatch");
  assert(manifest.expandedTotal === 6196, "manifest expanded total must be 6196");

  const rowsByLevel = new Map();
  const coverageByLevel = new Map();
  const rowCounts = {};

  for (let level = 1; level <= 6; level += 1) {
    assert(Number(manifest.officialCounts[level]) === EXPECTED_OFFICIAL[level], `level ${level}: official count mismatch`);
    assert(Number(manifest.expandedCounts[level]) === EXPECTED_EXPANDED[level], `level ${level}: expanded count mismatch`);
    const inputs = manifest.levels[level];
    assert(Array.isArray(inputs) && inputs.length === EXPECTED_EXPANDED[level], `level ${level}: input list length mismatch`);
    assert(new Set(inputs.map(normalizeEnglish)).size === inputs.length, `level ${level}: duplicate input surface forms`);
    for (const input of inputs) {
      assert(typeof input === "string" && input.trim(), `level ${level}: blank input`);
      assert(!/[\/()]/.test(input), `level ${level}: unexpanded shorthand remains in ${JSON.stringify(input)}`);
      assert(!/^\d+$/.test(input), `level ${level}: page number remains in ${JSON.stringify(input)}`);
    }

    const allowedInputs = new Set(inputs.map(normalizeEnglish));
    const seenKeys = new Set();
    const covered = new Set();
    const levelRows = [];
    const chunkCount = Math.ceil(inputs.length / 50);

    for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex += 1) {
      const resultPath = path.join(resultsDir, `level-${level}-chunk-${String(chunkIndex).padStart(3, "0")}.json`);
      assert(fs.existsSync(resultPath), `missing result ${path.basename(resultPath)}`);
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const expectedInputs = inputs.slice((chunkIndex - 1) * 50, chunkIndex * 50);
      assert(result.level === level && result.chunkIndex === chunkIndex, `${path.basename(resultPath)}: metadata mismatch`);
      assert(JSON.stringify(result.inputs) === JSON.stringify(expectedInputs), `${path.basename(resultPath)}: input slice mismatch`);
      assert(Array.isArray(result.rows) && result.rows.length > 0, `${path.basename(resultPath)}: no Gemini rows`);

      for (const [rowIndex, row] of result.rows.entries()) {
        const context = `${path.basename(resultPath)} row ${rowIndex + 1}`;
        covered.add(validateRow(row, context, allowedInputs, seenKeys));
        levelRows.push(normalizeRow(row));
      }
    }

    assert(covered.size === allowedInputs.size, `level ${level}: surface coverage ${covered.size}/${allowedInputs.size}`);
    for (const input of allowedInputs) assert(covered.has(input), `level ${level}: missing surface form ${input}`);
    rowsByLevel.set(level, levelRows);
    coverageByLevel.set(level, covered.size);
    rowCounts[level] = levelRows.length;
  }

  return { manifest, rowsByLevel, coverageByLevel, rowCounts };
}

function openDatabase(filePath) {
  const raw = new sqlite3.Database(filePath);
  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => raw.run(sql, params, function done(error) {
        if (error) reject(error);
        else resolve({ lastID: this.lastID, changes: this.changes });
      }));
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => raw.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => raw.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    },
    exec(sql) {
      return new Promise((resolve, reject) => raw.exec(sql, (error) => error ? reject(error) : resolve()));
    },
    close() {
      return new Promise((resolve, reject) => raw.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function getSourceCounts(db) {
  const rows = await db.all(
    `SELECT s.name, COUNT(w.id) AS word_count
       FROM sources s
       LEFT JOIN units u ON u.source_id = s.id
       LEFT JOIN words w ON w.unit_id = u.id
      GROUP BY s.id, s.name`
  );
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.word_count)]));
}

function assertExistingSourcesUnchanged(counts, phase) {
  for (const [name, expected] of Object.entries(EXISTING_SOURCE_COUNTS)) {
    assert(counts[name] === expected, `${phase}: existing source ${name} changed (${counts[name]} != ${expected})`);
  }
}

function makeBackupPath(backupDir, filePath, stamp) {
  const parsed = path.parse(filePath);
  return path.join(backupDir, `${parsed.name}.before-ceec-${stamp}${parsed.ext}.bak`);
}

async function validateDatabasePreconditions() {
  const db = openDatabase(dbPaths.words);
  try {
    const target = await db.get("SELECT id FROM sources WHERE name = ? OR slug = ?", [SOURCE_NAME, slugify(SOURCE_NAME)]);
    assert(!target, `source ${SOURCE_NAME} already exists; refusing to overwrite it`);
    assertExistingSourcesUnchanged(await getSourceCounts(db), "before import");
  } finally {
    await db.close();
  }
}

async function commitImport(validated, backupDir) {
  await validateDatabasePreconditions();
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wordsBackup = makeBackupPath(backupDir, dbPaths.words, stamp);
  const serverBackup = makeBackupPath(backupDir, dbPaths.server, stamp);
  fs.copyFileSync(dbPaths.words, wordsBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(dbPaths.server, serverBackup, fs.constants.COPYFILE_EXCL);

  const db = openDatabase(dbPaths.words);
  let committed = false;
  try {
    await db.run("ATTACH DATABASE ? AS server_meta", [path.resolve(dbPaths.server)]);
    await db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE TRANSACTION;");
    const sourceResult = await db.run("INSERT INTO sources (name, slug) VALUES (?, ?)", [SOURCE_NAME, slugify(SOURCE_NAME)]);

    for (let level = 1; level <= 6; level += 1) {
      const unitName = `第 ${level} 級`;
      const unitResult = await db.run(
        "INSERT INTO units (source_id, name, slug) VALUES (?, ?, ?)",
        [sourceResult.lastID, unitName, slugify(unitName)]
      );

      for (const row of validated.rowsByLevel.get(level)) {
        const wordRef = buildWordRef({ sourceName: SOURCE_NAME, unitName, eng: row.eng, tense: row.tense });
        await db.run(
          `INSERT INTO words
             (word_ref, unit_id, eng, eng_normalized, kk, tense, ch, analysis, definition, example)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [wordRef, unitResult.lastID, row.eng, normalizeEnglish(row.eng), row.kk, row.tense, row.ch, row.analysis, row.definition, row.example]
        );
      }

      await db.run(
        `INSERT INTO server_meta.import_batches
           (source_name, unit_name, file_name, imported_count, created_by)
         VALUES (?, ?, ?, ?, NULL)`,
        [SOURCE_NAME, unitName, "高中英文參考詞彙表(111學年度起適用).pdf", validated.rowsByLevel.get(level).length]
      );
    }

    await db.exec("COMMIT;");
    committed = true;
  } catch (error) {
    if (!committed) {
      try { await db.exec("ROLLBACK;"); } catch { /* no active transaction */ }
    }
    throw error;
  } finally {
    await db.close();
  }

  const { syncStudyData } = require("../../src/utils/studySync");
  await syncStudyData();
  return { wordsBackup, serverBackup };
}

async function verifyImportedDatabase() {
  const db = openDatabase(dbPaths.words);
  try {
    const sourceRows = await db.all("SELECT id FROM sources WHERE name = ?", [SOURCE_NAME]);
    assert(sourceRows.length === 1, `expected exactly one imported source, found ${sourceRows.length}`);
    const sourceId = sourceRows[0].id;
    const units = await db.all(
      `SELECT u.id, u.name, COUNT(w.id) AS row_count, COUNT(DISTINCT w.eng_normalized) AS distinct_eng
         FROM units u
         LEFT JOIN words w ON w.unit_id = u.id
        WHERE u.source_id = ?
        GROUP BY u.id, u.name
        ORDER BY u.id`,
      [sourceId]
    );
    assert(units.length === 6, `expected six units, found ${units.length}`);
    for (let index = 0; index < units.length; index += 1) {
      const level = index + 1;
      assert(units[index].name === `第 ${level} 級`, `unit ${level}: name/order mismatch`);
      assert(Number(units[index].distinct_eng) === EXPECTED_EXPANDED[level], `unit ${level}: distinct eng mismatch`);
    }

    const duplicateRefs = await db.get("SELECT COUNT(*) AS count FROM (SELECT word_ref FROM words GROUP BY word_ref HAVING COUNT(*) > 1)");
    assert(Number(duplicateRefs.count) === 0, "duplicate word_ref values found");
    const incomplete = await db.get(
      `SELECT COUNT(*) AS count
         FROM words w JOIN units u ON u.id = w.unit_id
        WHERE u.source_id = ? AND (
          TRIM(w.eng) = '' OR TRIM(w.kk) = '' OR TRIM(w.tense) = '' OR TRIM(w.ch) = '' OR
          TRIM(w.analysis) = '' OR TRIM(w.definition) = '' OR TRIM(w.example) = ''
        )`,
      [sourceId]
    );
    assert(Number(incomplete.count) === 0, `import contains ${incomplete.count} incomplete rows`);
    const examMeanings = await db.get(
      `SELECT COUNT(*) AS count
         FROM unit_exam_meanings em JOIN units u ON u.id = em.unit_id
        WHERE u.source_id = ?`,
      [sourceId]
    );
    assert(Number(examMeanings.count) === 0, "new units unexpectedly contain unit_exam_meanings");
    assertExistingSourcesUnchanged(await getSourceCounts(db), "after import");
    return units.map((unit) => ({ name: unit.name, rows: Number(unit.row_count), distinctEng: Number(unit.distinct_eng) }));
  } finally {
    await db.close();
  }
}

async function main() {
  const mode = process.argv[2] || "validate";
  const manifestPath = path.resolve(process.argv[3] || path.join(__dirname, "manifest.json"));
  const resultsDir = path.resolve(process.argv[4] || path.join(__dirname, "results"));
  const validated = loadAndValidate(manifestPath, resultsDir);
  const baseSummary = {
    chunks: Array.from({ length: 6 }, (_, index) => Math.ceil(EXPECTED_EXPANDED[index + 1] / 50)).reduce((a, b) => a + b, 0),
    distinctSurfaceForms: Object.fromEntries(validated.coverageByLevel),
    geminiRows: validated.rowCounts,
    geminiRowsTotal: Object.values(validated.rowCounts).reduce((sum, count) => sum + count, 0)
  };

  if (mode === "validate") {
    await validateDatabasePreconditions();
    console.log(JSON.stringify({ status: "validated", ...baseSummary }, null, 2));
    return;
  }
  assert(mode === "commit", `unknown mode ${mode}`);
  const backupDir = path.resolve(process.argv[5] || path.join(__dirname, "backups"));
  const backups = await commitImport(validated, backupDir);
  const units = await verifyImportedDatabase();
  console.log(JSON.stringify({ status: "committed", ...baseSummary, units, backups }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
