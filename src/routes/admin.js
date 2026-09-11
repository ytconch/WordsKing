const express = require("express");
const bcrypt = require("bcryptjs");
const { clientDb, serverDb } = require("../db/connections");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { countAdmins, deleteUserAccount } = require("../utils/userAccounts");
const { normalizeText } = require("../utils/wordHelpers");
const { FIELD_LIMITS, validateTextField, validateSecretField } = require("../utils/validation");
const {
  TAIWAN_SQL_LAST_7_DAYS_START,
  TAIWAN_SQL_LAST_14_DAYS_START,
  taiwanDateExpr,
  buildRecentTaiwanDateKeys
} = require("../utils/time");

const router = express.Router();

function parseJsonSafely(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

router.get("/server-logs", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(20, Math.min(200, Math.floor(requestedLimit))) : 80;

    const summaryRow = await serverDb.get(
      `SELECT
         COUNT(*) AS total24h,
         SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors24h,
         SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) AS warnings24h,
         COUNT(DISTINCT COALESCE(actor_user_id, 0)) AS actors24h
       FROM server_logs
       WHERE created_at >= datetime('now', '-1 day')`
    );

    const categoryRows = await serverDb.all(
      `SELECT category, COUNT(*) AS count
       FROM server_logs
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY category
       ORDER BY count DESC, category ASC
       LIMIT 6`
    );

    const rows = await serverDb.all(
      `SELECT
         id,
         level,
         category,
         action,
         actor_user_id AS actorUserId,
         actor_username AS actorUsername,
         method,
         route,
         ip_address AS ipAddress,
         message,
         details_json AS detailsJson,
         created_at AS createdAt
       FROM server_logs
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    res.json({
      summary: {
        total24h: Number(summaryRow?.total24h || 0),
        errors24h: Number(summaryRow?.errors24h || 0),
        warnings24h: Number(summaryRow?.warnings24h || 0),
        actors24h: Number(summaryRow?.actors24h || 0)
      },
      categories: categoryRows.map((row) => ({
        category: row.category,
        count: Number(row.count || 0)
      })),
      logs: rows.map((row) => ({
        id: row.id,
        level: row.level,
        category: row.category,
        action: row.action,
        actorUserId: row.actorUserId,
        actorUsername: row.actorUsername || "",
        method: row.method || "",
        route: row.route || "",
        ipAddress: row.ipAddress || "",
        message: row.message || "",
        details: parseJsonSafely(row.detailsJson),
        createdAt: row.createdAt
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await clientDb.all(
      `SELECT
         u.id,
         u.username,
         u.display_name AS displayName,
         u.role,
         u.theme,
         u.created_at AS createdAt,
         COUNT(sl.id) AS attempts
       FROM users u
       LEFT JOIN study_logs sl ON sl.user_id = u.id
       GROUP BY u.id
       ORDER BY u.role DESC, u.created_at ASC`
    );

    res.json({ users });
  } catch (error) {
    next(error);
  }
});

router.get("/activity", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await clientDb.all(
      `SELECT
         id,
         username,
         display_name AS displayName,
         role,
         created_at AS createdAt
       FROM users
       ORDER BY role DESC, created_at ASC`
    );

    const logTotals = await clientDb.all(
      `SELECT
         user_id AS userId,
         COUNT(*) AS totalAttempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS totalCorrect,
         MAX(created_at) AS lastLogAt
       FROM study_logs
       GROUP BY user_id`
    );

    const logRecent = await clientDb.all(
      `SELECT
         user_id AS userId,
         COUNT(*) AS attempts7d,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct7d,
         MAX(created_at) AS lastRecentLogAt
       FROM study_logs
       WHERE created_at >= ${TAIWAN_SQL_LAST_7_DAYS_START}
       GROUP BY user_id`
    );

    const sessionRecent = await serverDb.all(
      `SELECT
         user_id AS userId,
         COUNT(*) AS sessions7d,
         SUM(total_questions) AS questions7d,
         SUM(correct_answers) AS sessionCorrect7d,
         MAX(created_at) AS lastSessionAt
       FROM practice_sessions
       WHERE created_at >= ${TAIWAN_SQL_LAST_7_DAYS_START}
       GROUP BY user_id`
    );

    const totalMap = new Map(logTotals.map((row) => [row.userId, row]));
    const recentMap = new Map(logRecent.map((row) => [row.userId, row]));
    const sessionMap = new Map(sessionRecent.map((row) => [row.userId, row]));

    const activity = users
      .map((user) => {
        const total = totalMap.get(user.id) || {};
        const recent = recentMap.get(user.id) || {};
        const session = sessionMap.get(user.id) || {};
        const lastActiveCandidates = [total.lastLogAt, recent.lastRecentLogAt, session.lastSessionAt].filter(Boolean);
        const lastActiveAt = lastActiveCandidates.sort().at(-1) || null;
        const attempts7d = Number(recent.attempts7d || 0);
        const correct7d = Number(recent.correct7d || 0);
        const sessions7d = Number(session.sessions7d || 0);
        const totalAttempts = Number(total.totalAttempts || 0);
        const totalCorrect = Number(total.totalCorrect || 0);

        return {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          createdAt: user.createdAt,
          lastActiveAt,
          attempts7d,
          correct7d,
          sessions7d,
          questions7d: Number(session.questions7d || 0),
          accuracy7d: attempts7d ? Number(((correct7d / attempts7d) * 100).toFixed(1)) : 0,
          totalAttempts,
          totalCorrect,
          totalAccuracy: totalAttempts ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : 0
        };
      })
      .sort((a, b) => {
        const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
        const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
        return bTime - aTime || b.attempts7d - a.attempts7d || b.totalAttempts - a.totalAttempts;
      });

    res.json({ activity });
  } catch (error) {
    next(error);
  }
});

router.get("/activity/visits", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const uniqueVisitorRow = await clientDb.get(
      `SELECT COUNT(DISTINCT user_id) AS uniqueVisitors
       FROM page_visit_sessions
       WHERE started_at >= ${TAIWAN_SQL_LAST_14_DAYS_START}
         AND started_at <= CURRENT_TIMESTAMP`
    );

    const dailyRows = await clientDb.all(
      `SELECT
         ${taiwanDateExpr("started_at")} AS visitDate,
         COUNT(*) AS visits,
         COUNT(DISTINCT user_id) AS uniqueUsers,
         SUM(
           MAX(
             0,
             (unixepoch(COALESCE(ended_at, last_seen_at)) - unixepoch(started_at))
           )
         ) AS durationSeconds
       FROM page_visit_sessions
       WHERE started_at >= ${TAIWAN_SQL_LAST_14_DAYS_START}
         AND started_at <= CURRENT_TIMESTAMP
       GROUP BY ${taiwanDateExpr("started_at")}
       ORDER BY visitDate ASC`
    );

    const pageRows = await clientDb.all(
      `SELECT
         page_key AS pageKey,
         COUNT(*) AS visits,
         COUNT(DISTINCT user_id) AS uniqueUsers,
         SUM(
           MAX(
             0,
             (unixepoch(COALESCE(ended_at, last_seen_at)) - unixepoch(started_at))
           )
         ) AS durationSeconds,
         AVG(
           MAX(
             0,
             (unixepoch(COALESCE(ended_at, last_seen_at)) - unixepoch(started_at))
           )
         ) AS avgDurationSeconds,
         MAX(started_at) AS lastVisitAt
       FROM page_visit_sessions
       WHERE started_at >= ${TAIWAN_SQL_LAST_14_DAYS_START}
         AND started_at <= CURRENT_TIMESTAMP
       GROUP BY page_key
       ORDER BY visits DESC, durationSeconds DESC, uniqueUsers DESC, page_key ASC`
    );

    const recentRows = await clientDb.all(
      `SELECT
         pvs.id,
         pvs.page_key AS pageKey,
         pvs.path,
         pvs.started_at AS startedAt,
         pvs.last_seen_at AS lastSeenAt,
         pvs.ended_at AS endedAt,
         MAX(
           0,
           (unixepoch(COALESCE(pvs.ended_at, pvs.last_seen_at)) - unixepoch(pvs.started_at))
         ) AS durationSeconds,
         u.id AS userId,
         u.username,
         u.display_name AS displayName,
         u.role
       FROM page_visit_sessions pvs
       JOIN users u ON u.id = pvs.user_id
       WHERE pvs.started_at >= ${TAIWAN_SQL_LAST_14_DAYS_START}
         AND pvs.started_at <= CURRENT_TIMESTAMP
       ORDER BY pvs.started_at DESC
       LIMIT 80`
    );

    const dailyMap = new Map(
      dailyRows.map((row) => [
        row.visitDate,
        {
          visits: Number(row.visits || 0),
          uniqueUsers: Number(row.uniqueUsers || 0),
          durationSeconds: Number(row.durationSeconds || 0)
        }
      ])
    );

    const trend = [];
    for (const key of buildRecentTaiwanDateKeys(14)) {
      const row = dailyMap.get(key) || { visits: 0, uniqueUsers: 0 };
      trend.push({
        visitDate: key,
        visits: row.visits,
        uniqueUsers: row.uniqueUsers,
        durationSeconds: Number(row.durationSeconds || 0)
      });
    }

    const totalVisits = trend.reduce((sum, item) => sum + item.visits, 0);
    const totalDurationSeconds = trend.reduce((sum, item) => sum + item.durationSeconds, 0);
    const uniqueVisitors = Number(uniqueVisitorRow?.uniqueVisitors || 0);
    const peakDay = trend.reduce(
      (best, item) => (item.visits > best.visits ? item : best),
      { visitDate: null, visits: 0, uniqueUsers: 0, durationSeconds: 0 }
    );
    const todayVisits = trend.at(-1)?.visits || 0;
    const todayDurationSeconds = trend.at(-1)?.durationSeconds || 0;
    const averageDurationSeconds = totalVisits ? Math.round(totalDurationSeconds / totalVisits) : 0;

    res.json({
      summary: {
        totalVisits,
        uniqueVisitors,
        peakVisits: peakDay.visits,
        peakVisitDate: peakDay.visitDate,
        todayVisits,
        totalDurationSeconds,
        averageDurationSeconds,
        todayDurationSeconds
      },
      trend,
      pages: pageRows.map((row) => ({
        pageKey: row.pageKey,
        visits: Number(row.visits || 0),
        uniqueUsers: Number(row.uniqueUsers || 0),
        durationSeconds: Number(row.durationSeconds || 0),
        avgDurationSeconds: Number(row.avgDurationSeconds || 0),
        lastVisitAt: row.lastVisitAt || null
      })),
      recentVisits: recentRows.map((row) => ({
        id: row.id,
        pageKey: row.pageKey,
        path: row.path || "",
        startedAt: row.startedAt,
        lastSeenAt: row.lastSeenAt,
        endedAt: row.endedAt,
        durationSeconds: Number(row.durationSeconds || 0),
        userId: row.userId,
        username: row.username,
        displayName: row.displayName,
        role: row.role
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/activity/:userId/trend", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    const user = await clientDb.get(
      `SELECT id, username, display_name AS displayName, role
       FROM users
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      return res.status(404).json({ message: "找不到該使用者。" });
    }

    const rows = await clientDb.all(
      `SELECT
         ${taiwanDateExpr("created_at")} AS studyDate,
         COUNT(*) AS attempts,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount
       FROM study_logs
       WHERE user_id = ?
         AND created_at >= ${TAIWAN_SQL_LAST_14_DAYS_START}
       GROUP BY ${taiwanDateExpr("created_at")}
       ORDER BY studyDate ASC`,
      [userId]
    );

    const dailyMap = new Map(
      rows.map((row) => [
        row.studyDate,
        {
          attempts: Number(row.attempts || 0),
          correctCount: Number(row.correctCount || 0)
        }
      ])
    );

    const trend = [];
    for (const key of buildRecentTaiwanDateKeys(14)) {
      const row = dailyMap.get(key) || { attempts: 0, correctCount: 0 };
      trend.push({
        studyDate: key,
        attempts: row.attempts,
        correctCount: row.correctCount,
        accuracy: row.attempts ? Number(((row.correctCount / row.attempts) * 100).toFixed(1)) : 0
      });
    }

    const totalAttempts = trend.reduce((sum, item) => sum + item.attempts, 0);
    const totalCorrect = trend.reduce((sum, item) => sum + item.correctCount, 0);
    const activeDays = trend.filter((item) => item.attempts > 0).length;
    const peakAttempts = trend.reduce((max, item) => Math.max(max, item.attempts), 0);

    res.json({
      user,
      summary: {
        totalAttempts,
        totalCorrect,
        activeDays,
        peakAttempts,
        accuracy: totalAttempts ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : 0
      },
      trend
    });
  } catch (error) {
    next(error);
  }
});

router.get("/weekly-leaderboard", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await clientDb.all(
      `SELECT id, username, display_name AS displayName, role
       FROM users
       ORDER BY role DESC, created_at ASC`
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
         COUNT(*) AS sessions,
         SUM(total_questions) AS totalQuestions,
         SUM(correct_answers) AS totalCorrect
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

    const leaderboard = users
      .map((user) => {
        const words = wordBuckets.get(user.id) || [];
        const session = sessionMap.get(user.id) || {};
        const practicedWords = words.length;
        const score = Number(words.reduce((sum, item) => sum + item.wordScore, 0).toFixed(2));
        const totalAttempts = words.reduce((sum, item) => sum + item.attempts, 0);
        const totalCorrect = words.reduce((sum, item) => sum + item.correctCount, 0);
        const accuracy = totalAttempts ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : 0;
        const lastActiveAt = words
          .map((item) => item.lastAnsweredAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null;

        return {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          score,
          practicedWords,
          attempts: totalAttempts,
          accuracy,
          sessions: Number(session.sessions || 0),
          totalQuestions: Number(session.totalQuestions || 0),
          totalCorrect: Number(session.totalCorrect || 0),
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
        ...item
      }));

    res.json({ leaderboard });
  } catch (error) {
    next(error);
  }
});

router.patch("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const role = normalizeText(req.body.role);
    const displayName = validateTextField(req.body.displayName, "名稱", FIELD_LIMITS.displayName);
    const theme = normalizeText(req.body.theme);

    const user = await clientDb.get("SELECT id, role FROM users WHERE id = ?", [targetId]);
    if (!user) {
      return res.status(404).json({ message: "找不到該帳號。" });
    }

    if (user.role === "admin" && role === "student") {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({ message: "至少要保留 1 個管理員。" });
      }
    }

    await clientDb.run(
      `UPDATE users
       SET role = COALESCE(?, role),
           display_name = COALESCE(?, display_name),
           theme = COALESCE(?, theme),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [role || null, displayName, theme || null, targetId]
    );

    res.json({ message: "帳號資料已更新。" });
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);

    if (targetId === req.user.id) {
      return res.status(400).json({ message: "不能刪除自己目前登入的帳號。" });
    }

    const user = await clientDb.get("SELECT id, role FROM users WHERE id = ?", [targetId]);
    if (!user) {
      return res.status(404).json({ message: "找不到該帳號。" });
    }

    if (user.role === "admin") {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({ message: "至少要保留 1 個管理員。" });
      }
    }

    await deleteUserAccount(targetId);
    res.json({ message: "帳號已刪除。" });
  } catch (error) {
    next(error);
  }
});

router.get("/recovery-requests", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requests = await clientDb.all(
      `SELECT
         id,
         username,
         display_name AS displayName,
         note,
         status,
         created_at AS createdAt,
         resolved_at AS resolvedAt
       FROM recovery_requests
       ORDER BY
         CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
         created_at DESC`
    );

    res.json({ requests });
  } catch (error) {
    next(error);
  }
});

router.patch("/recovery-requests/:id/reset", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const temporaryPassword = validateSecretField(req.body.temporaryPassword, "臨時密碼", FIELD_LIMITS.password);

    if (temporaryPassword.length < 6) {
      return res.status(400).json({ message: "臨時密碼至少要 6 碼。" });
    }

    const request = await clientDb.get(
      "SELECT id, username, status FROM recovery_requests WHERE id = ?",
      [requestId]
    );

    if (!request) {
      return res.status(404).json({ message: "找不到該救援申請。" });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: "這筆申請已經處理過。" });
    }

    const user = await clientDb.get("SELECT id FROM users WHERE username = ?", [request.username]);
    if (!user) {
      return res.status(404).json({ message: "找不到對應帳號。" });
    }

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await clientDb.run(
      "UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [passwordHash, user.id]
    );

    await clientDb.run(
      `UPDATE recovery_requests
         SET status = 'resolved',
             resolved_by = ?,
             temporary_password = NULL,
             resolved_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [req.user.id, requestId]
    );

    res.json({ message: "密碼已重設，請自行將新密碼提供給使用者。" });
  } catch (error) {
    next(error);
  }
});

router.delete("/recovery-requests/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const request = await clientDb.get(
      "SELECT id, status FROM recovery_requests WHERE id = ?",
      [requestId]
    );

    if (!request) {
      return res.status(404).json({ message: "找不到這筆救援申請。" });
    }

    await clientDb.run("DELETE FROM recovery_requests WHERE id = ?", [requestId]);
    res.json({
      message: request.status === "pending" ? "已刪除救援申請。" : "已刪除救援紀錄。"
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
