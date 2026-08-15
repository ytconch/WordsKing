const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { clientDb } = require("../db/connections");
const { jwtSecret } = require("../config");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimit");
const { countAdmins, deleteUserAccount } = require("../utils/userAccounts");
const { normalizeText } = require("../utils/wordHelpers");
const { FIELD_LIMITS, validateTextField, validateSecretField } = require("../utils/validation");

const router = express.Router();
const ALLOWED_THEMES = new Set(["sage", "paper", "ocean", "light", "dark"]);
const DEFAULT_PRACTICE_NEXT_QUESTION_DELAY_MS = 1000;
const MAX_PRACTICE_NEXT_QUESTION_DELAY_MS = 10000;
const DEFAULT_PRACTICE_CHOICE_TIME_LIMIT_SECONDS = 15;
const DEFAULT_PRACTICE_TYPING_TIME_LIMIT_SECONDS = 30;
const MIN_PRACTICE_TIME_LIMIT_SECONDS = 5;
const MAX_PRACTICE_TIME_LIMIT_SECONDS = 40;
const ALLOWED_VISIT_PAGES = new Set([
  "words",
  "practice",
  "leaderboard",
  "analytics",
  "notifications",
  "settings",
  "admin"
]);

const AUTH_ACTION_RESPONSE_MESSAGE = "If the account information is valid, the request has been accepted.";
const loginRateLimit = createRateLimiter({
  key: "auth:login",
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again later."
});
const registerRateLimit = createRateLimiter({
  key: "auth:register",
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many registration attempts. Please try again later."
});
const recoveryRateLimit = createRateLimiter({
  key: "auth:recovery",
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many recovery requests. Please try again later."
});

function sanitizeTheme(value) {
  const theme = normalizeText(value).toLowerCase();
  return ALLOWED_THEMES.has(theme) ? theme : "sage";
}

function sanitizePracticeNextQuestionDelayMs(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) {
    return DEFAULT_PRACTICE_NEXT_QUESTION_DELAY_MS;
  }

  return Math.max(0, Math.min(MAX_PRACTICE_NEXT_QUESTION_DELAY_MS, Math.round(delay)));
}

function resolvePracticeTimeLimitSeconds(value, fallback) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds)) {
    return fallback;
  }

  if (seconds === 0) {
    return 0;
  }

  return seconds >= MIN_PRACTICE_TIME_LIMIT_SECONDS && seconds <= MAX_PRACTICE_TIME_LIMIT_SECONDS
    ? seconds
    : fallback;
}

function validatePracticeTimeLimitSeconds(value, label) {
  if (value === undefined) {
    return null;
  }

  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    (seconds !== 0 &&
      (seconds < MIN_PRACTICE_TIME_LIMIT_SECONDS || seconds > MAX_PRACTICE_TIME_LIMIT_SECONDS))
  ) {
    const error = new Error(`${label} must be 0 or an integer from ${MIN_PRACTICE_TIME_LIMIT_SECONDS} to ${MAX_PRACTICE_TIME_LIMIT_SECONDS}.`);
    error.status = 400;
    throw error;
  }

  return seconds;
}

function toUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    role: user.role,
    theme: user.theme || "sage",
    leaderboardVisible:
      typeof user.leaderboard_visible === "number"
        ? Boolean(user.leaderboard_visible)
        : user.leaderboardVisible !== undefined
          ? Boolean(user.leaderboardVisible)
          : true,
    practiceNextQuestionDelayMs: sanitizePracticeNextQuestionDelayMs(
      user.practice_next_question_delay_ms ?? user.practiceNextQuestionDelayMs
    ),
    practiceChoiceTimeLimitSeconds: resolvePracticeTimeLimitSeconds(
      user.practice_choice_time_limit_seconds ?? user.practiceChoiceTimeLimitSeconds,
      DEFAULT_PRACTICE_CHOICE_TIME_LIMIT_SECONDS
    ),
    practiceTypingTimeLimitSeconds: resolvePracticeTimeLimitSeconds(
      user.practice_typing_time_limit_seconds ?? user.practiceTypingTimeLimitSeconds,
      DEFAULT_PRACTICE_TYPING_TIME_LIMIT_SECONDS
    ),
    createdAt: user.created_at || user.createdAt
  };
}

async function fetchUserById(userId) {
  return clientDb.get(
    `SELECT
       id,
       username,
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
       student_tutorial_completed_at,
       token_version,
       created_at
     FROM users
     WHERE id = ?`,
    [userId]
  );
}

function issueToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: Number(user.token_version ?? user.tokenVersion ?? 0)
    },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

router.post("/register", registerRateLimit, async (req, res, next) => {
  try {
    const username = validateTextField(req.body.username, "Username", FIELD_LIMITS.username);
    const password = validateSecretField(req.body.password, "Password", FIELD_LIMITS.password);
    const displayName = normalizeText(req.body.displayName)
      ? validateTextField(req.body.displayName, "Display name", FIELD_LIMITS.displayName)
      : username;

    const existingUser = await clientDb.get("SELECT id FROM users WHERE username = ?", [username]);
    if (existingUser) {
      return res.status(409).json({ message: "Username is already taken." });
    }

    const userCountRow = await clientDb.get("SELECT COUNT(*) AS count FROM users");
    const role = userCountRow?.count ? "student" : "admin";
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await clientDb.run(
      `INSERT INTO users
         (
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
           student_tutorial_completed_at
         )
       VALUES (?, ?, ?, ?, 'sage', 1, 'auto', 0.9, 1, ?, ?, ?, NULL)`,
      [
        username,
        passwordHash,
        displayName,
        role,
        DEFAULT_PRACTICE_NEXT_QUESTION_DELAY_MS,
        DEFAULT_PRACTICE_CHOICE_TIME_LIMIT_SECONDS,
        DEFAULT_PRACTICE_TYPING_TIME_LIMIT_SECONDS
      ]
    );

    const user = await fetchUserById(result.lastID);
    res.status(201).json({
      token: issueToken(user),
      user: toUserPayload(user)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", loginRateLimit, async (req, res, next) => {
  try {
    const username = validateTextField(req.body.username, "Username", FIELD_LIMITS.username);
    const password = validateSecretField(req.body.password, "Password", FIELD_LIMITS.password);
    const user = await clientDb.get(
      `SELECT
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
         student_tutorial_completed_at,
         token_version,
         created_at
       FROM users
       WHERE username = ?`,
      [username]
    );

    if (!user) {
      return res.status(401).json({ message: "Invalid username or password." });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid username or password." });
    }

    res.json({
      token: issueToken(user),
      user: toUserPayload(user)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await fetchUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user: toUserPayload(user) });
  } catch (error) {
    next(error);
  }
});

router.patch("/me/profile", requireAuth, async (req, res, next) => {
  try {
    const displayName = validateTextField(req.body.displayName, "Display name", FIELD_LIMITS.displayName);
    const theme = sanitizeTheme(req.body.theme);
    const leaderboardVisible =
      req.body.leaderboardVisible === false || req.body.leaderboardVisible === "false" ? 0 : 1;
    const practiceNextQuestionDelayMs = sanitizePracticeNextQuestionDelayMs(
      req.body.practiceNextQuestionDelayMs
    );
    const practiceChoiceTimeLimitSeconds = validatePracticeTimeLimitSeconds(
      req.body.practiceChoiceTimeLimitSeconds,
      "Choice time limit"
    );
    const practiceTypingTimeLimitSeconds = validatePracticeTimeLimitSeconds(
      req.body.practiceTypingTimeLimitSeconds,
      "Typing time limit"
    );

    await clientDb.run(
      `UPDATE users
       SET display_name = ?,
           theme = ?,
           leaderboard_visible = ?,
           practice_next_question_delay_ms = ?,
           practice_choice_time_limit_seconds = COALESCE(?, practice_choice_time_limit_seconds),
           practice_typing_time_limit_seconds = COALESCE(?, practice_typing_time_limit_seconds),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        displayName,
        theme,
        leaderboardVisible,
        practiceNextQuestionDelayMs,
        practiceChoiceTimeLimitSeconds,
        practiceTypingTimeLimitSeconds,
        req.user.id
      ]
    );

    const user = await fetchUserById(req.user.id);
    res.json({ user: toUserPayload(user) });
  } catch (error) {
    next(error);
  }
});

router.patch("/me/password", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = validateSecretField(req.body.currentPassword, "Current password", FIELD_LIMITS.password);
    const nextPassword = validateSecretField(req.body.newPassword, "New password", FIELD_LIMITS.password);

    const user = await clientDb.get("SELECT id, password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(nextPassword, 10);
    await clientDb.run(
      "UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [passwordHash, req.user.id]
    );

    res.json({ message: "Password updated." });
  } catch (error) {
    next(error);
  }
});

router.delete("/me", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = validateSecretField(req.body.currentPassword, "Current password", FIELD_LIMITS.password);
    const user = await clientDb.get("SELECT id, role, password_hash FROM users WHERE id = ?", [req.user.id]);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }

    if (user.role === "admin") {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({ message: "At least one admin account must remain." });
      }
    }

    await deleteUserAccount(user.id);
    res.json({ message: "Account deleted." });
  } catch (error) {
    next(error);
  }
});

router.post("/visit", requireAuth, async (req, res, next) => {
  try {
    const pageKey = normalizeText(req.body.pageKey).toLowerCase();
    const path = normalizeText(req.body.path).slice(0, 120);

    if (!ALLOWED_VISIT_PAGES.has(pageKey)) {
      return res.status(400).json({ message: "Invalid page key." });
    }

    await clientDb.run(
      `INSERT INTO page_visits (user_id, page_key, path)
       VALUES (?, ?, ?)`,
      [req.user.id, pageKey, path || null]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/visit/session/start", requireAuth, async (req, res, next) => {
  try {
    const pageKey = normalizeText(req.body.pageKey).toLowerCase();
    const path = normalizeText(req.body.path).slice(0, 120);

    if (!ALLOWED_VISIT_PAGES.has(pageKey)) {
      return res.status(400).json({ message: "Invalid page key." });
    }

    await clientDb.run(
      `INSERT INTO page_visits (user_id, page_key, path)
       VALUES (?, ?, ?)`,
      [req.user.id, pageKey, path || null]
    );

    const result = await clientDb.run(
      `INSERT INTO page_visit_sessions (user_id, page_key, path)
       VALUES (?, ?, ?)`,
      [req.user.id, pageKey, path || null]
    );

    res.json({
      ok: true,
      sessionId: result.lastID
    });
  } catch (error) {
    next(error);
  }
});

router.post("/visit/session/:id/heartbeat", requireAuth, async (req, res, next) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return res.status(400).json({ message: "Invalid session id." });
    }

    const result = await clientDb.run(
      `UPDATE page_visit_sessions
       SET last_seen_at = CURRENT_TIMESTAMP,
           heartbeat_count = heartbeat_count + 1
       WHERE id = ?
         AND user_id = ?
         AND ended_at IS NULL`,
      [sessionId, req.user.id]
    );

    if (!result.changes) {
      return res.status(404).json({ message: "Visit session not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/visit/session/:id/end", requireAuth, async (req, res, next) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return res.status(400).json({ message: "Invalid session id." });
    }

    const result = await clientDb.run(
      `UPDATE page_visit_sessions
       SET last_seen_at = CURRENT_TIMESTAMP,
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
       WHERE id = ?
         AND user_id = ?`,
      [sessionId, req.user.id]
    );

    if (!result.changes) {
      return res.status(404).json({ message: "Visit session not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/recovery-request", recoveryRateLimit, async (req, res, next) => {
  try {
    const username = validateTextField(req.body.username, "Username", FIELD_LIMITS.username);
    const displayName = normalizeText(req.body.displayName)
      ? validateTextField(req.body.displayName, "Display name", {
          ...FIELD_LIMITS.displayName,
          required: false
        })
      : "";
    const note = validateTextField(req.body.note, "Recovery note", {
      ...FIELD_LIMITS.recoveryNote,
      required: false
    });

    const user = await clientDb.get("SELECT id, display_name FROM users WHERE username = ?", [username]);
    if (user) {
      await clientDb.run(
        `INSERT INTO recovery_requests (username, display_name, note)
         VALUES (?, ?, ?)`,
        [username, displayName || user.display_name || "", note || ""]
      );
    }

    res.status(202).json({
      message: AUTH_ACTION_RESPONSE_MESSAGE
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
