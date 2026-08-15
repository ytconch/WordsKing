const express = require("express");
const { wordsDb, clientDb, serverDb } = require("../db/connections");
const { requireAuth } = require("../middleware/auth");
const { syncStudyData } = require("../utils/studySync");
const { parseMeaningEntries } = require("../utils/wordHelpers");
const {
  TAIWAN_SQL_LAST_7_DAYS_START,
  taiwanDateExpr,
  formatTaiwanDateKey,
  diffDateKeys
} = require("../utils/time");

const router = express.Router();

async function buildWeeklyLeaderboard() {
  const users = await clientDb.all(
    `SELECT id, username, display_name AS displayName, leaderboard_visible AS leaderboardVisible
     FROM users
     ORDER BY created_at ASC`
  );

  const weeklyWordRows = await clientDb.all(
    `SELECT
       user_id AS userId,
       word_ref AS wordRef,
       COUNT(*) AS attempts,
       SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
       MAX(created_at) AS lastAnsweredAt
     FROM study_logs
     WHERE created_at >= ${TAIWAN_SQL_LAST_7_DAYS_START}
     GROUP BY user_id, word_ref`
  );

  const weeklySessionRows = await serverDb.all(
    `SELECT
       user_id AS userId,
       COUNT(*) AS sessions
     FROM practice_sessions
     WHERE created_at >= ${TAIWAN_SQL_LAST_7_DAYS_START}
     GROUP BY user_id`
  );

  const sessionMap = new Map(weeklySessionRows.map((row) => [row.userId, row]));
  const wordBuckets = new Map();

  for (const row of weeklyWordRows) {
    const attempts = Number(row.attempts || 0);
    const correctCount = Number(row.correctCount || 0);
    const accuracy = attempts ? correctCount / attempts : 0;
    const attemptGate = Math.min(1, attempts / 2);
    const wordScore = Number((attemptGate * (0.35 + accuracy * 0.65)).toFixed(4));

    if (!wordBuckets.has(row.userId)) {
      wordBuckets.set(row.userId, []);
    }

    wordBuckets.get(row.userId).push({
      wordRef: row.wordRef,
      attempts,
      correctCount,
      accuracy,
      wordScore,
      lastAnsweredAt: row.lastAnsweredAt
    });
  }

  return users
    .map((user) => {
      const words = wordBuckets.get(user.id) || [];
      const session = sessionMap.get(user.id) || {};
      const practicedWords = words.length;
      const score = Number(words.reduce((sum, item) => sum + item.wordScore, 0).toFixed(2));
      const totalAttempts = words.reduce((sum, item) => sum + item.attempts, 0);
      const totalCorrect = words.reduce((sum, item) => sum + item.correctCount, 0);
      const accuracy = totalAttempts ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : 0;
      const lastActiveAt =
        words
          .map((item) => item.lastAnsweredAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null;

      return {
        id: user.id,
        name:
          Number(user.leaderboardVisible || 0) === 1
            ? user.displayName || user.username || `Player ${user.id}`
            : "匿名使用者",
        score,
        practicedWords,
        attempts: totalAttempts,
        accuracy,
        sessions: Number(session.sessions || 0),
        lastActiveAt
      };
    })
    .filter((item) => item.practicedWords > 0)
    .sort((a, b) => {
      const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
      const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
      return (
        b.score - a.score ||
        b.practicedWords - a.practicedWords ||
        b.accuracy - a.accuracy ||
        b.sessions - a.sessions ||
        bTime - aTime
      );
    })
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      score: item.score,
      practicedWords: item.practicedWords,
      accuracy: item.accuracy
    }));
}

function computeStreaks(days) {
  const sorted = [...new Set(days)].sort();
  if (!sorted.length) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  let longestStreak = 1;
  let running = 1;

  for (let index = 1; index < sorted.length; index += 1) {
    const diffDays = diffDateKeys(sorted[index - 1], sorted[index]);

    if (diffDays === 1) {
      running += 1;
      longestStreak = Math.max(longestStreak, running);
    } else {
      running = 1;
    }
  }

  let currentStreak = 1;
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const diffDays = diffDateKeys(sorted[index - 1], sorted[index]);

    if (diffDays === 1) {
      currentStreak += 1;
    } else {
      break;
    }
  }

  const gapFromToday = diffDateKeys(sorted[sorted.length - 1], formatTaiwanDateKey(new Date()));
  if (gapFromToday > 1) {
    currentStreak = 0;
  }

  return { currentStreak, longestStreak };
}

router.get("/summary", requireAuth, async (req, res, next) => {
  try {
    await syncStudyData(req.user.id);

    const overview = await clientDb.get(
      `SELECT
         COUNT(*) AS total_attempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS total_correct,
         SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS total_wrong,
         COUNT(DISTINCT ${taiwanDateExpr("created_at")}) AS active_days
       FROM study_logs
       WHERE user_id = ?`,
      [req.user.id]
    );

    const studyDays = await clientDb.all(
      `SELECT DISTINCT ${taiwanDateExpr("created_at")} AS study_date
       FROM study_logs
       WHERE user_id = ?
       ORDER BY study_date`,
      [req.user.id]
    );

    const dailyTrend = await clientDb.all(
      `SELECT
         ${taiwanDateExpr("created_at")} AS study_date,
         COUNT(*) AS attempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
       FROM study_logs
       WHERE user_id = ?
       GROUP BY ${taiwanDateExpr("created_at")}
       ORDER BY study_date DESC
       LIMIT 14`,
      [req.user.id]
    );

    const modeBreakdown = await clientDb.all(
      `SELECT
         mode,
         COUNT(*) AS attempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
       FROM study_logs
       WHERE user_id = ?
       GROUP BY mode
       ORDER BY attempts DESC`,
      [req.user.id]
    );

    const unitPerformance = await clientDb.all(
      `SELECT
         source_name AS sourceName,
         unit_name AS unitName,
         COUNT(*) AS attempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount
       FROM study_logs
       WHERE user_id = ?
       GROUP BY source_name, unit_name
       ORDER BY attempts DESC, correctCount DESC
       LIMIT 8`,
      [req.user.id]
    );

    const weakWords = await clientDb.all(
      `SELECT
         word_ref AS wordRef,
         source_name AS sourceName,
         unit_name AS unitName,
         attempts,
         correct_count AS correctCount,
         wrong_count AS wrongCount,
         last_answered_at AS lastAnsweredAt
       FROM mastery_stats
       WHERE user_id = ?
       ORDER BY
         CASE WHEN attempts = 0 THEN 1 ELSE CAST(correct_count AS REAL) / attempts END ASC,
         wrong_count DESC,
         attempts DESC
       LIMIT 8`,
      [req.user.id]
    );

    const weakWordRefs = weakWords.map((item) => item.wordRef).filter(Boolean);
    const weakWordMap = new Map();
    if (weakWordRefs.length) {
      const currentWords = await wordsDb.all(
        `SELECT
           w.word_ref AS wordRef,
           w.eng,
           w.ch
         FROM words w
         WHERE w.word_ref IN (${weakWordRefs.map(() => "?").join(",")})`,
        weakWordRefs
      );
      currentWords.forEach((row) =>
        weakWordMap.set(row.wordRef, {
          ...row,
          chEntries: parseMeaningEntries(row.ch)
        })
      );
    }

    const reviewSummary = await clientDb.get(
      `SELECT
         SUM(CASE WHEN wrong_count > correct_count THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN correct_count >= 3 AND wrong_count = 0 THEN 1 ELSE 0 END) AS mastered_words,
         COUNT(*) AS tracked_words
       FROM mastery_stats
       WHERE user_id = ?`,
      [req.user.id]
    );

    const streaks = computeStreaks(studyDays.map((item) => item.study_date));
    const totalAttempts = overview?.total_attempts || 0;
    const totalCorrect = overview?.total_correct || 0;

    res.json({
      overview: {
        totalAttempts,
        totalCorrect,
        totalWrong: overview?.total_wrong || 0,
        accuracy: totalAttempts ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : 0,
        activeDays: overview?.active_days || 0
      },
      streaks,
      dailyTrend: dailyTrend.reverse().map((item) => ({
        studyDate: item.study_date,
        attempts: item.attempts,
        correctCount: item.correct_count || 0,
        accuracy: item.attempts
          ? Number((((item.correct_count || 0) / item.attempts) * 100).toFixed(1))
          : 0
      })),
      modeBreakdown: modeBreakdown.map((item) => ({
        mode: item.mode,
        attempts: item.attempts,
        correctCount: item.correct_count || 0,
        accuracy: item.attempts
          ? Number((((item.correct_count || 0) / item.attempts) * 100).toFixed(1))
          : 0
      })),
      unitPerformance: unitPerformance.map((item) => ({
        ...item,
        accuracy: item.attempts
          ? Number((((item.correctCount || 0) / item.attempts) * 100).toFixed(1))
          : 0
      })),
      weakWords: weakWords.map((item) => ({
        ...item,
        eng: weakWordMap.get(item.wordRef)?.eng || "",
        ch: weakWordMap.get(item.wordRef)?.ch || "",
        chEntries: weakWordMap.get(item.wordRef)?.chEntries || [],
        accuracy: item.attempts
          ? Number((((item.correctCount || 0) / item.attempts) * 100).toFixed(1))
          : 0
      })),
      reviewSummary: {
        needsReview: reviewSummary?.needs_review || 0,
        masteredWords: reviewSummary?.mastered_words || 0,
        trackedWords: reviewSummary?.tracked_words || 0
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/weekly-leaderboard", requireAuth, async (req, res, next) => {
  try {
    const leaderboard = await buildWeeklyLeaderboard();
    res.json({ leaderboard });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
