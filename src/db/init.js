const { wordsDb, serverDb, clientDb } = require("./connections");
const {
  normalizeText,
  normalizeExample,
  normalizeEnglish,
  slugify,
  buildWordRef
} = require("../utils/wordHelpers");

async function tableExists(db, tableName) {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return !!row;
}

async function columnExists(db, tableName, columnName) {
  if (!(await tableExists(db, tableName))) {
    return false;
  }

  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
}

async function loadLegacyWords() {
  if (!(await tableExists(wordsDb, "words"))) {
    return [];
  }

  const hasKk = await columnExists(wordsDb, "words", "kk");
  const selectKk = hasKk ? "w.kk AS kk," : "'' AS kk,";

  return wordsDb.all(
    `SELECT
       w.id AS legacy_word_id,
       w.eng,
       ${selectKk}
       w.tense,
       w.ch,
       w.analysis,
       w.definition,
       w.example,
       w.created_at,
       w.updated_at,
       u.name AS unit_name,
       s.name AS source_name
     FROM words w
     JOIN units u ON u.id = w.unit_id
     JOIN sources s ON s.id = u.source_id
     ORDER BY s.name, u.name, w.id`
  );
}

async function rebuildWordsDatabase() {
  const legacyWords = await loadLegacyWords();
  const legacyWordMap = new Map();

  await wordsDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS words;
    DROP TABLE IF EXISTS units;
    DROP TABLE IF EXISTS sources;
    PRAGMA foreign_keys = ON;

    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_id, slug),
      FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
    );

    CREATE TABLE words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_ref TEXT NOT NULL UNIQUE,
      unit_id INTEGER NOT NULL,
      eng TEXT NOT NULL,
      eng_normalized TEXT NOT NULL,
      kk TEXT,
      tense TEXT,
      ch TEXT,
      analysis TEXT,
      definition TEXT,
      example TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE
    );

    DROP TABLE IF EXISTS unit_exam_meanings;

    CREATE INDEX idx_sources_slug ON sources(slug);
    CREATE INDEX idx_units_source ON units(source_id);
    CREATE INDEX idx_units_slug ON units(source_id, slug);
    CREATE INDEX idx_words_unit ON words(unit_id);
    CREATE INDEX idx_words_ref ON words(word_ref);
    CREATE INDEX idx_words_eng_normalized ON words(eng_normalized);
  `);

  const sourceMap = new Map();
  const unitMap = new Map();
  const wordMap = new Map();

  for (const item of legacyWords) {
    const sourceName = normalizeText(item.source_name);
    const unitName = normalizeText(item.unit_name);
    const eng = normalizeText(item.eng);

    if (!sourceName || !unitName || !eng) {
      continue;
    }

    if (!sourceMap.has(sourceName)) {
      const result = await wordsDb.run(
        "INSERT INTO sources (name, slug) VALUES (?, ?)",
        [sourceName, slugify(sourceName)]
      );
      sourceMap.set(sourceName, result.lastID);
    }

    const sourceId = sourceMap.get(sourceName);
    const unitKey = `${sourceId}::${unitName}`;

    if (!unitMap.has(unitKey)) {
      const result = await wordsDb.run(
        "INSERT INTO units (source_id, name, slug) VALUES (?, ?, ?)",
        [sourceId, unitName, slugify(unitName)]
      );
      unitMap.set(unitKey, result.lastID);
    }

    const wordRef = buildWordRef({
      sourceName,
      unitName,
      eng,
      tense: item.tense
    });

    if (wordMap.has(wordRef)) {
      legacyWordMap.set(item.legacy_word_id, wordMap.get(wordRef));
      continue;
    }

    const unitId = unitMap.get(unitKey);
    const result = await wordsDb.run(
      `INSERT INTO words
         (
           word_ref,
           unit_id,
           eng,
           eng_normalized,
           kk,
           tense,
           ch,
           analysis,
           definition,
           example,
           created_at,
           updated_at
         )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        wordRef,
        unitId,
        eng,
        normalizeEnglish(eng),
        normalizeText(item.kk),
        normalizeText(item.tense),
        normalizeText(item.ch),
        normalizeText(item.analysis),
        normalizeText(item.definition),
        normalizeExample(item.example),
        item.created_at || null,
        item.updated_at || null
      ]
    );

    const currentWord = {
      id: result.lastID,
      wordRef,
      eng,
      kk: normalizeText(item.kk),
      tense: normalizeText(item.tense),
      ch: normalizeText(item.ch),
      analysis: normalizeText(item.analysis),
      definition: normalizeText(item.definition),
      example: normalizeExample(item.example),
      sourceName,
      unitName
    };

    wordMap.set(wordRef, currentWord);
    legacyWordMap.set(item.legacy_word_id, currentWord);
  }

  return { legacyWordMap, wordMap };
}

async function ensureOptimizedWordsSchema() {
  const hasWords = await tableExists(wordsDb, "words");
  const hasWordRef = await columnExists(wordsDb, "words", "word_ref");
  const hasEngNormalized = await columnExists(wordsDb, "words", "eng_normalized");
  if (!hasWords || !hasWordRef || !hasEngNormalized) {
    return rebuildWordsDatabase();
  }

  const rows = await wordsDb.all(
    `SELECT
       w.id,
       w.word_ref,
       w.eng,
       w.kk,
       w.tense,
       w.ch,
       w.analysis,
       w.definition,
       w.example,
       u.name AS unit_name,
       s.name AS source_name
     FROM words w
     JOIN units u ON u.id = w.unit_id
     JOIN sources s ON s.id = u.source_id`
  );

  const wordMap = new Map();
  for (const row of rows) {
    wordMap.set(row.word_ref, {
      id: row.id,
      wordRef: row.word_ref,
      eng: row.eng,
      kk: row.kk,
      tense: row.tense,
      ch: row.ch,
      analysis: row.analysis,
      definition: row.definition,
      example: row.example,
      sourceName: row.source_name,
      unitName: row.unit_name
    });
  }

  return { legacyWordMap: new Map(), wordMap };
}

async function loadLegacyUsers() {
  if (!(await tableExists(clientDb, "users"))) {
    return [];
  }

  const hasRole = await columnExists(clientDb, "users", "role");
  const hasTheme = await columnExists(clientDb, "users", "theme");
  const hasLeaderboardVisible = await columnExists(clientDb, "users", "leaderboard_visible");
  const hasTtsVoiceStyle = await columnExists(clientDb, "users", "tts_voice_style");
  const hasTtsRate = await columnExists(clientDb, "users", "tts_rate");
  const hasTtsRepeatCount = await columnExists(clientDb, "users", "tts_repeat_count");
  const hasPracticeNextQuestionDelayMs = await columnExists(
    clientDb,
    "users",
    "practice_next_question_delay_ms"
  );
  const hasPracticeChoiceTimeLimitSeconds = await columnExists(
    clientDb,
    "users",
    "practice_choice_time_limit_seconds"
  );
  const hasPracticeTypingTimeLimitSeconds = await columnExists(
    clientDb,
    "users",
    "practice_typing_time_limit_seconds"
  );
  const hasTokenVersion = await columnExists(clientDb, "users", "token_version");
  const hasUpdatedAt = await columnExists(clientDb, "users", "updated_at");

  return clientDb.all(
    `SELECT
       id,
       username,
       password_hash,
       display_name,
       ${hasRole ? "role" : "'student' AS role"},
       ${hasTheme ? "theme" : "'sage' AS theme"},
       ${hasLeaderboardVisible ? "leaderboard_visible" : "1 AS leaderboard_visible"},
       ${hasTtsVoiceStyle ? "tts_voice_style" : "'auto' AS tts_voice_style"},
       ${hasTtsRate ? "tts_rate" : "0.9 AS tts_rate"},
       ${hasTtsRepeatCount ? "tts_repeat_count" : "1 AS tts_repeat_count"},
       ${
         hasPracticeNextQuestionDelayMs
           ? "practice_next_question_delay_ms"
           : "1000 AS practice_next_question_delay_ms"
       },
       ${
         hasPracticeChoiceTimeLimitSeconds
           ? "practice_choice_time_limit_seconds"
           : "15 AS practice_choice_time_limit_seconds"
       },
       ${
         hasPracticeTypingTimeLimitSeconds
           ? "practice_typing_time_limit_seconds"
           : "30 AS practice_typing_time_limit_seconds"
       },
       ${hasTokenVersion ? "token_version" : "0 AS token_version"},
       created_at,
       ${hasUpdatedAt ? "updated_at" : "created_at AS updated_at"}
     FROM users
     ORDER BY id`
  );
}

async function loadLegacyStudyLogs(legacyWordMap, currentWordMap) {
  if (await tableExists(clientDb, "study_logs")) {
    const hasWordId = await columnExists(clientDb, "study_logs", "word_id");
    const hasSourceName = await columnExists(clientDb, "study_logs", "source_name");
    const hasUnitName = await columnExists(clientDb, "study_logs", "unit_name");
    return clientDb.all(
      `SELECT
         id,
         user_id,
         word_ref,
         ${hasWordId ? "word_id" : "NULL AS word_id"},
         mode,
         user_answer,
         is_correct,
         ${hasSourceName ? "source_name" : "NULL AS source_name"},
         ${hasUnitName ? "unit_name" : "NULL AS unit_name"},
         created_at
       FROM study_logs
       ORDER BY id`
    );
  }

  if (!(await tableExists(clientDb, "practice_logs"))) {
    return [];
  }

  const rows = await clientDb.all(
    `SELECT
       user_id,
       word_id,
       mode,
       prompt,
       user_answer,
       expected_answer,
       is_correct,
       created_at
     FROM practice_logs
     ORDER BY id`
  );

  return rows
    .map((row) => {
      const legacyWord = legacyWordMap.get(row.word_id);
      if (!legacyWord) {
        return null;
      }

      const currentWord = currentWordMap.get(legacyWord.wordRef);
      return {
        id: row.id || null,
        user_id: row.user_id,
        word_ref: legacyWord.wordRef,
        word_id: currentWord?.id || null,
        mode: row.mode,
        user_answer: row.user_answer,
        is_correct: row.is_correct,
        source_name: currentWord?.sourceName || legacyWord.sourceName,
        unit_name: currentWord?.unitName || legacyWord.unitName,
        created_at: row.created_at
      };
    })
    .filter(Boolean);
}

async function loadLegacyMasteryStats(legacyWordMap, currentWordMap) {
  if (await tableExists(clientDb, "mastery_stats")) {
    const hasWordId = await columnExists(clientDb, "mastery_stats", "word_id");
    const hasSourceName = await columnExists(clientDb, "mastery_stats", "source_name");
    const hasUnitName = await columnExists(clientDb, "mastery_stats", "unit_name");
    return clientDb.all(
      `SELECT
         id,
         user_id,
         word_ref,
         ${hasWordId ? "word_id" : "NULL AS word_id"},
         ${hasSourceName ? "source_name" : "NULL AS source_name"},
         ${hasUnitName ? "unit_name" : "NULL AS unit_name"},
         attempts,
         correct_count,
         wrong_count,
         last_mode,
         last_result,
         streak,
         last_answered_at
       FROM mastery_stats
       ORDER BY id`
    );
  }

  if (!(await tableExists(clientDb, "user_word_stats"))) {
    return [];
  }

  const rows = await clientDb.all(
    `SELECT
       user_id,
       word_id,
       attempts,
       correct_count,
       wrong_count,
       last_mode,
       last_result,
       last_reviewed_at
     FROM user_word_stats
     ORDER BY id`
  );

  return rows
    .map((row) => {
      const legacyWord = legacyWordMap.get(row.word_id);
      if (!legacyWord) {
        return null;
      }

      const currentWord = currentWordMap.get(legacyWord.wordRef);
      if (!currentWord) {
        return null;
      }

      return {
        id: row.id || null,
        user_id: row.user_id,
        word_ref: legacyWord.wordRef,
        word_id: currentWord.id,
        source_name: currentWord.sourceName,
        unit_name: currentWord.unitName,
        attempts: row.attempts || 0,
        correct_count: row.correct_count || 0,
        wrong_count: row.wrong_count || 0,
        last_mode: row.last_mode,
        last_result: row.last_result,
        streak: row.last_result ? 1 : 0,
        last_answered_at: row.last_reviewed_at
      };
    })
    .filter(Boolean);
}

async function rebuildServerDatabase() {
  const importRows = (await tableExists(serverDb, "import_batches"))
    ? await serverDb.all(
        `SELECT source_name, unit_name, file_name, imported_count, created_by, created_at
         FROM import_batches
         ORDER BY id`
      )
    : (await tableExists(serverDb, "import_logs"))
      ? await serverDb.all(
          `SELECT source_name, unit_name, file_name, imported_count, NULL AS created_by, created_at
           FROM import_logs
           ORDER BY id`
        )
      : [];

  const sessionRows = (await tableExists(serverDb, "practice_sessions"))
    ? await serverDb.all(
        `SELECT user_id, mode, total_questions, correct_answers, created_at
         FROM practice_sessions
         ORDER BY id`
      )
    : [];

  await serverDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS import_logs;
    DROP TABLE IF EXISTS import_batches;
    DROP TABLE IF EXISTS practice_sessions;
    DROP TABLE IF EXISTS pronunciation_cache;
    DROP TABLE IF EXISTS pronunciation_miss_cache;
    PRAGMA foreign_keys = ON;

    CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      unit_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE practice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      total_questions INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS server_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_username TEXT,
      method TEXT,
      route TEXT,
      ip_address TEXT,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE pronunciation_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      word_normalized TEXT NOT NULL,
      cache_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      attribution_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE pronunciation_miss_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_normalized TEXT NOT NULL,
      provider_signature TEXT NOT NULL,
      reason_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(word_normalized, provider_signature)
    );

    CREATE TABLE pronunciation_prefetch_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_normalized TEXT NOT NULL UNIQUE,
      priority INTEGER NOT NULL DEFAULT 0,
      refresh_requested INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      failed_at TEXT
    );

    CREATE TABLE pronunciation_usage (
      word_normalized TEXT PRIMARY KEY,
      request_window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      direct_request_count INTEGER NOT NULL DEFAULT 0,
      last_requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_refresh_enqueued_at TEXT
    );

    CREATE TABLE pronunciation_provider_key_locks (
      provider TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      locked_until TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, key_fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_server_logs_created_at ON server_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_logs_level_date ON server_logs(level, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_logs_category_date ON server_logs(category, created_at DESC);
    CREATE INDEX idx_pronunciation_cache_word ON pronunciation_cache(word_normalized);
    CREATE INDEX idx_pronunciation_cache_key ON pronunciation_cache(cache_key);
    CREATE INDEX idx_pronunciation_miss_cache_word ON pronunciation_miss_cache(word_normalized, provider_signature);
    CREATE INDEX idx_pronunciation_prefetch_ready ON pronunciation_prefetch_jobs(status, priority DESC, next_attempt_at);
    CREATE INDEX idx_pronunciation_usage_requested ON pronunciation_usage(last_requested_at);
    CREATE INDEX idx_pronunciation_key_locks_until ON pronunciation_provider_key_locks(locked_until);
  `);

  for (const row of importRows) {
    await serverDb.run(
      `INSERT INTO import_batches
         (source_name, unit_name, file_name, imported_count, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        row.source_name,
        row.unit_name,
        row.file_name,
        row.imported_count || 0,
        row.created_by || null,
        row.created_at || null
      ]
    );
  }

  for (const row of sessionRows) {
    await serverDb.run(
      `INSERT INTO practice_sessions
         (user_id, mode, total_questions, correct_answers, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [row.user_id, row.mode, row.total_questions, row.correct_answers, row.created_at || null]
    );
  }
}

async function rebuildClientDatabase(legacyWordMap, currentWordMap) {
  const users = await loadLegacyUsers();
  const logs = await loadLegacyStudyLogs(legacyWordMap, currentWordMap);
  const stats = await loadLegacyMasteryStats(legacyWordMap, currentWordMap);

  await clientDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS practice_logs;
    DROP TABLE IF EXISTS user_word_stats;
    DROP TABLE IF EXISTS study_logs;
    DROP TABLE IF EXISTS mastery_stats;
    DROP TABLE IF EXISTS users;
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      theme TEXT NOT NULL DEFAULT 'sage',
      leaderboard_visible INTEGER NOT NULL DEFAULT 1,
      tts_voice_style TEXT NOT NULL DEFAULT 'auto',
      tts_rate REAL NOT NULL DEFAULT 0.9,
      tts_repeat_count INTEGER NOT NULL DEFAULT 1,
      practice_next_question_delay_ms INTEGER NOT NULL DEFAULT 1000,
      practice_choice_time_limit_seconds INTEGER NOT NULL DEFAULT 15,
      practice_typing_time_limit_seconds INTEGER NOT NULL DEFAULT 30,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE user_starred_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_key TEXT NOT NULL,
      eng TEXT NOT NULL,
      tense TEXT NOT NULL DEFAULT '',
      word_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, word_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_user_starred_words_user ON user_starred_words(user_id);
    CREATE INDEX idx_user_starred_words_user_key ON user_starred_words(user_id, word_key);

    CREATE TABLE study_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_ref TEXT NOT NULL,
      word_id INTEGER,
      mode TEXT NOT NULL,
      user_answer TEXT,
      is_correct INTEGER NOT NULL DEFAULT 0,
      source_name TEXT,
      unit_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE mastery_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_ref TEXT NOT NULL,
      word_id INTEGER,
      source_name TEXT,
      unit_name TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      last_mode TEXT,
      last_result INTEGER,
      streak INTEGER NOT NULL DEFAULT 0,
      last_answered_at TEXT,
      UNIQUE(user_id, word_ref),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_user_id INTEGER NOT NULL,
      recipient_user_id INTEGER,
      title TEXT NOT NULL DEFAULT '通知',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(notification_id, user_id),
      FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE notification_dismissals (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(notification_id, user_id),
      FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE page_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      page_key TEXT NOT NULL,
      path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE page_visit_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      page_key TEXT NOT NULL,
      path TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_users_role ON users(role);
    CREATE INDEX idx_logs_user_date ON study_logs(user_id, created_at);
    CREATE INDEX idx_logs_word_ref ON study_logs(word_ref);
    CREATE INDEX idx_mastery_user ON mastery_stats(user_id);
    CREATE INDEX idx_mastery_word_ref ON mastery_stats(word_ref);
    CREATE INDEX idx_notifications_recipient_date ON notifications(recipient_user_id, created_at);
    CREATE INDEX idx_notification_reads_user ON notification_reads(user_id, read_at);
    CREATE INDEX idx_notification_dismissals_user ON notification_dismissals(user_id, dismissed_at);
    CREATE INDEX idx_page_visits_user_date ON page_visits(user_id, created_at);
    CREATE INDEX idx_page_visits_page_date ON page_visits(page_key, created_at);
    CREATE INDEX idx_page_visits_created_at ON page_visits(created_at);
    CREATE INDEX idx_page_visit_sessions_user_start ON page_visit_sessions(user_id, started_at);
    CREATE INDEX idx_page_visit_sessions_page_start ON page_visit_sessions(page_key, started_at);
    CREATE INDEX idx_page_visit_sessions_last_seen ON page_visit_sessions(last_seen_at);
  `);

  for (const user of users) {
    await clientDb.run(
      `INSERT INTO users
         (
           id,
           username,
           password_hash,
           display_name,
           role,
           theme,
           leaderboard_visible,
           tts_voice_style,
           tts_rate,
           tts_repeat_count,
           practice_next_question_delay_ms,
           practice_choice_time_limit_seconds,
           practice_typing_time_limit_seconds,
           token_version,
           created_at,
           updated_at
         )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        user.id,
        normalizeText(user.username),
        user.password_hash,
        normalizeText(user.display_name) || normalizeText(user.username),
        normalizeText(user.role) || "student",
        normalizeText(user.theme) || "sage",
        Number.isFinite(Number(user.leaderboard_visible)) ? Number(user.leaderboard_visible) : 1,
        "auto",
        Number.isFinite(Number(user.tts_rate)) ? Number(user.tts_rate) : 0.9,
        Number.isFinite(Number(user.tts_repeat_count)) ? Number(user.tts_repeat_count) : 1,
        Number.isFinite(Number(user.practice_next_question_delay_ms))
          ? Math.max(0, Math.min(10000, Math.round(Number(user.practice_next_question_delay_ms))))
          : 1000,
        Number.isInteger(Number(user.practice_choice_time_limit_seconds)) &&
        (Number(user.practice_choice_time_limit_seconds) === 0 ||
          (Number(user.practice_choice_time_limit_seconds) >= 5 &&
            Number(user.practice_choice_time_limit_seconds) <= 40))
          ? Number(user.practice_choice_time_limit_seconds)
          : 15,
        Number.isInteger(Number(user.practice_typing_time_limit_seconds)) &&
        (Number(user.practice_typing_time_limit_seconds) === 0 ||
          (Number(user.practice_typing_time_limit_seconds) >= 5 &&
            Number(user.practice_typing_time_limit_seconds) <= 40))
          ? Number(user.practice_typing_time_limit_seconds)
          : 30,
        Number.isFinite(Number(user.token_version)) ? Number(user.token_version) : 0,
        user.created_at || null,
        user.updated_at || null
      ]
    );
  }

  for (const row of logs) {
    if (!row.word_ref) {
      continue;
    }

    await clientDb.run(
      `INSERT INTO study_logs
         (id, user_id, word_ref, word_id, mode, user_answer, is_correct, source_name, unit_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        row.id || null,
        row.user_id,
        row.word_ref,
        row.word_id || null,
        row.mode,
        row.user_answer || "",
        row.is_correct ? 1 : 0,
        row.source_name || "",
        row.unit_name || "",
        row.created_at || null
      ]
    );
  }

  for (const row of stats) {
    if (!row.word_ref) {
      continue;
    }

    await clientDb.run(
      `INSERT INTO mastery_stats
         (id, user_id, word_ref, word_id, source_name, unit_name, attempts, correct_count, wrong_count, last_mode, last_result, streak, last_answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id || null,
        row.user_id,
        row.word_ref,
        row.word_id || null,
        row.source_name || "",
        row.unit_name || "",
        row.attempts || 0,
        row.correct_count || 0,
        row.wrong_count || 0,
        row.last_mode || null,
        typeof row.last_result === "number" ? row.last_result : null,
        row.streak || 0,
        row.last_answered_at || null
      ]
    );
  }
}

async function optimizeClientStorage() {
  const hasStudyLogs = await tableExists(clientDb, "study_logs");
  const hasMasteryStats = await tableExists(clientDb, "mastery_stats");
  if (!hasStudyLogs || !hasMasteryStats) {
    return;
  }

  const studyHasPrompt = await columnExists(clientDb, "study_logs", "prompt");
  const studyHasExpectedAnswer = await columnExists(clientDb, "study_logs", "expected_answer");
  const studyHasSnapshots = (await columnExists(clientDb, "study_logs", "eng_snapshot")) || (await columnExists(clientDb, "study_logs", "ch_snapshot"));
  const masteryHasSnapshots = (await columnExists(clientDb, "mastery_stats", "eng_snapshot")) || (await columnExists(clientDb, "mastery_stats", "ch_snapshot"));

  if (!studyHasPrompt && !studyHasExpectedAnswer && !studyHasSnapshots && !masteryHasSnapshots) {
    return;
  }

  const logs = await loadLegacyStudyLogs(new Map(), new Map());
  const stats = await loadLegacyMasteryStats(new Map(), new Map());

  await clientDb.exec(`
    PRAGMA foreign_keys = OFF;

    DROP INDEX IF EXISTS idx_logs_user_date;
    DROP INDEX IF EXISTS idx_logs_word_ref;
    DROP INDEX IF EXISTS idx_mastery_user;
    DROP INDEX IF EXISTS idx_mastery_word_ref;

    ALTER TABLE study_logs RENAME TO study_logs_old;
    ALTER TABLE mastery_stats RENAME TO mastery_stats_old;

    CREATE TABLE study_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_ref TEXT NOT NULL,
      word_id INTEGER,
      mode TEXT NOT NULL,
      user_answer TEXT,
      is_correct INTEGER NOT NULL DEFAULT 0,
      source_name TEXT,
      unit_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE mastery_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_ref TEXT NOT NULL,
      word_id INTEGER,
      source_name TEXT,
      unit_name TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      last_mode TEXT,
      last_result INTEGER,
      streak INTEGER NOT NULL DEFAULT 0,
      last_answered_at TEXT,
      UNIQUE(user_id, word_ref),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_logs_user_date ON study_logs(user_id, created_at);
    CREATE INDEX idx_logs_word_ref ON study_logs(word_ref);
    CREATE INDEX idx_mastery_user ON mastery_stats(user_id);
    CREATE INDEX idx_mastery_word_ref ON mastery_stats(word_ref);
    CREATE INDEX idx_mastery_user_wordref ON mastery_stats(user_id, word_ref);
  `);

  for (const row of logs) {
    if (!row.word_ref) continue;
    await clientDb.run(
      `INSERT INTO study_logs
         (id, user_id, word_ref, word_id, mode, user_answer, is_correct, source_name, unit_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        row.id || null,
        row.user_id,
        row.word_ref,
        row.word_id || null,
        row.mode || "",
        row.user_answer || "",
        row.is_correct ? 1 : 0,
        row.source_name || "",
        row.unit_name || "",
        row.created_at || null
      ]
    );
  }

  for (const row of stats) {
    if (!row.word_ref) continue;
    await clientDb.run(
      `INSERT INTO mastery_stats
         (id, user_id, word_ref, word_id, source_name, unit_name, attempts, correct_count, wrong_count, last_mode, last_result, streak, last_answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id || null,
        row.user_id,
        row.word_ref,
        row.word_id || null,
        row.source_name || "",
        row.unit_name || "",
        row.attempts || 0,
        row.correct_count || 0,
        row.wrong_count || 0,
        row.last_mode || null,
        typeof row.last_result === "number" ? row.last_result : null,
        row.streak || 0,
        row.last_answered_at || null
      ]
    );
  }

  await clientDb.exec(`
    DROP TABLE study_logs_old;
    DROP TABLE mastery_stats_old;
    PRAGMA foreign_keys = ON;
  `);

  await clientDb.exec("VACUUM;");
}

async function initializeDatabases() {
  const schemaReady =
    (await tableExists(wordsDb, "words")) &&
    (await columnExists(wordsDb, "words", "word_ref")) &&
    (await columnExists(wordsDb, "words", "eng_normalized")) &&
    (await tableExists(serverDb, "import_batches")) &&
    (await tableExists(clientDb, "study_logs")) &&
    (await tableExists(clientDb, "mastery_stats")) &&
    (await columnExists(clientDb, "users", "theme"));

  const { legacyWordMap, wordMap } = await ensureOptimizedWordsSchema();

  if (!schemaReady) {
    await rebuildServerDatabase();
    await rebuildClientDatabase(legacyWordMap, wordMap);
    return;
  }

  await wordsDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_sources_slug ON sources(slug);
    CREATE INDEX IF NOT EXISTS idx_units_source ON units(source_id);
    CREATE INDEX IF NOT EXISTS idx_units_slug ON units(source_id, slug);
    CREATE INDEX IF NOT EXISTS idx_words_unit ON words(unit_id);
    CREATE INDEX IF NOT EXISTS idx_words_ref ON words(word_ref);
    CREATE INDEX IF NOT EXISTS idx_words_eng_normalized ON words(eng_normalized);
    DROP TABLE IF EXISTS unit_exam_meanings;
  `);

  await serverDb.exec(`
    DROP TABLE IF EXISTS generated_cloze_questions;

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      unit_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS practice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      total_questions INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS server_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_username TEXT,
      method TEXT,
      route TEXT,
      ip_address TEXT,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pronunciation_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      word_normalized TEXT NOT NULL,
      cache_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      attribution_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pronunciation_miss_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_normalized TEXT NOT NULL,
      provider_signature TEXT NOT NULL,
      reason_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(word_normalized, provider_signature)
    );

    CREATE TABLE IF NOT EXISTS pronunciation_prefetch_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_normalized TEXT NOT NULL UNIQUE,
      priority INTEGER NOT NULL DEFAULT 0,
      refresh_requested INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      failed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pronunciation_usage (
      word_normalized TEXT PRIMARY KEY,
      request_window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      direct_request_count INTEGER NOT NULL DEFAULT 0,
      last_requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_refresh_enqueued_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pronunciation_provider_key_locks (
      provider TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      locked_until TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, key_fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_server_logs_created_at ON server_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_logs_level_date ON server_logs(level, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_logs_category_date ON server_logs(category, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_cache_word ON pronunciation_cache(word_normalized);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_cache_key ON pronunciation_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_miss_cache_word ON pronunciation_miss_cache(word_normalized, provider_signature);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_prefetch_ready ON pronunciation_prefetch_jobs(status, priority DESC, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_usage_requested ON pronunciation_usage(last_requested_at);
    CREATE INDEX IF NOT EXISTS idx_pronunciation_key_locks_until ON pronunciation_provider_key_locks(locked_until);
  `);

  if (!(await columnExists(serverDb, "pronunciation_cache", "refreshed_at"))) {
    await serverDb.exec("ALTER TABLE pronunciation_cache ADD COLUMN refreshed_at TEXT;");
    await serverDb.run(
      "UPDATE pronunciation_cache SET refreshed_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE refreshed_at IS NULL"
    );
  }

  await clientDb.exec(`
    CREATE TABLE IF NOT EXISTS recovery_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      display_name TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by INTEGER,
      temporary_password TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_user_id INTEGER NOT NULL,
      recipient_user_id INTEGER,
      title TEXT NOT NULL DEFAULT '通知',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(notification_id, user_id),
      FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_dismissals (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(notification_id, user_id),
      FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS page_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      page_key TEXT NOT NULL,
      path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS page_visit_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      page_key TEXT NOT NULL,
      path TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_logs_user_date ON study_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_word_ref ON study_logs(word_ref);
    CREATE INDEX IF NOT EXISTS idx_mastery_user ON mastery_stats(user_id);
    CREATE INDEX IF NOT EXISTS idx_mastery_word_ref ON mastery_stats(word_ref);
    CREATE INDEX IF NOT EXISTS idx_mastery_user_wordref ON mastery_stats(user_id, word_ref);
    CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_date ON notifications(recipient_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_notification_dismissals_user ON notification_dismissals(user_id, dismissed_at);
    CREATE INDEX IF NOT EXISTS idx_page_visits_user_date ON page_visits(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_page_visits_page_date ON page_visits(page_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_page_visits_created_at ON page_visits(created_at);
    CREATE INDEX IF NOT EXISTS idx_page_visit_sessions_user_start ON page_visit_sessions(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_page_visit_sessions_page_start ON page_visit_sessions(page_key, started_at);
    CREATE INDEX IF NOT EXISTS idx_page_visit_sessions_last_seen ON page_visit_sessions(last_seen_at);
  `);

  if (!(await columnExists(clientDb, "users", "leaderboard_visible"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN leaderboard_visible INTEGER NOT NULL DEFAULT 1;
    `);
  }

  if (!(await columnExists(clientDb, "users", "tts_voice_style"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN tts_voice_style TEXT NOT NULL DEFAULT 'auto';
    `);
  }

  await clientDb.run(
    `UPDATE users
     SET tts_voice_style = 'auto'
     WHERE tts_voice_style IS NULL
        OR LOWER(TRIM(tts_voice_style)) <> 'auto'`
  );

  if (!(await columnExists(clientDb, "users", "tts_rate"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN tts_rate REAL NOT NULL DEFAULT 0.9;
    `);
  }

  if (!(await columnExists(clientDb, "users", "tts_repeat_count"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN tts_repeat_count INTEGER NOT NULL DEFAULT 1;
    `);
  }

  if (!(await columnExists(clientDb, "users", "practice_next_question_delay_ms"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN practice_next_question_delay_ms INTEGER NOT NULL DEFAULT 1000;
    `);
  }

  if (!(await columnExists(clientDb, "users", "practice_choice_time_limit_seconds"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN practice_choice_time_limit_seconds INTEGER NOT NULL DEFAULT 15;
    `);
  }

  if (!(await columnExists(clientDb, "users", "practice_typing_time_limit_seconds"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN practice_typing_time_limit_seconds INTEGER NOT NULL DEFAULT 30;
    `);
  }

  if (await columnExists(clientDb, "users", "student_tutorial_completed_at")) {
    await clientDb.exec("ALTER TABLE users DROP COLUMN student_tutorial_completed_at;");
  }

  await clientDb.exec(`
    CREATE TABLE IF NOT EXISTS user_starred_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      word_key TEXT NOT NULL,
      eng TEXT NOT NULL,
      tense TEXT NOT NULL DEFAULT '',
      word_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, word_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_starred_words_user ON user_starred_words(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_starred_words_user_key ON user_starred_words(user_id, word_key);
  `);

  if (!(await columnExists(clientDb, "users", "token_version"))) {
    await clientDb.exec(`
      ALTER TABLE users
      ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
    `);
  }

  if (await columnExists(clientDb, "recovery_requests", "temporary_password")) {
    await clientDb.run(
      "UPDATE recovery_requests SET temporary_password = NULL WHERE temporary_password IS NOT NULL"
    );
  }

  await optimizeClientStorage();

  if (await columnExists(clientDb, "users", "word_detail_display_mode")) {
    await clientDb.exec("ALTER TABLE users DROP COLUMN word_detail_display_mode;");
  }

  if (await columnExists(wordsDb, "words", "latin_root")) {
    await wordsDb.exec("ALTER TABLE words DROP COLUMN latin_root;");
  }

  await wordsDb.exec("DROP TABLE IF EXISTS unit_exam_meanings;");

  await wordsDb.exec(`
    DELETE FROM words
    WHERE unit_id NOT IN (SELECT id FROM units);

    DELETE FROM units
    WHERE source_id NOT IN (SELECT id FROM sources);
  `);
}

module.exports = {
  initializeDatabases
};
