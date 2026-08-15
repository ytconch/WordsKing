const express = require("express");
const { clientDb } = require("../db/connections");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { FIELD_LIMITS, validateTextField } = require("../utils/validation");

const router = express.Router();

function mapNotificationRow(row) {
  return {
    id: row.id,
    title: row.title || "通知",
    message: row.message || "",
    recipientUserId: row.recipientUserId,
    senderName: row.senderName || "管理員",
    isRead: Boolean(row.readAt),
    createdAt: row.createdAt
  };
}

router.get("/inbox", requireAuth, async (req, res, next) => {
  try {
    const rows = await clientDb.all(
      `SELECT
         n.id,
         n.title,
         n.message,
         n.recipient_user_id AS recipientUserId,
         n.created_at AS createdAt,
         u.display_name AS senderName,
         nr.read_at AS readAt
       FROM notifications n
       LEFT JOIN users u ON u.id = n.sender_user_id
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id
        AND nr.user_id = ?
       LEFT JOIN notification_dismissals nd
         ON nd.notification_id = n.id
        AND nd.user_id = ?
       WHERE (n.recipient_user_id IS NULL OR n.recipient_user_id = ?)
         AND n.created_at >= (SELECT created_at FROM users WHERE id = ?)
         AND nd.dismissed_at IS NULL
       ORDER BY n.created_at DESC
       LIMIT 40`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );

    const unreadRow = await clientDb.get(
      `SELECT COUNT(*) AS unreadCount
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id
        AND nr.user_id = ?
       LEFT JOIN notification_dismissals nd
         ON nd.notification_id = n.id
        AND nd.user_id = ?
       WHERE (n.recipient_user_id IS NULL OR n.recipient_user_id = ?)
         AND n.created_at >= (SELECT created_at FROM users WHERE id = ?)
         AND nr.read_at IS NULL
         AND nd.dismissed_at IS NULL`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );

    res.json({
      unreadCount: Number(unreadRow?.unreadCount || 0),
      notifications: rows.map(mapNotificationRow)
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/read-all", requireAuth, async (req, res, next) => {
  try {
    const unreadRows = await clientDb.all(
      `SELECT n.id
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id
        AND nr.user_id = ?
       LEFT JOIN notification_dismissals nd
         ON nd.notification_id = n.id
        AND nd.user_id = ?
       WHERE (n.recipient_user_id IS NULL OR n.recipient_user_id = ?)
         AND n.created_at >= (SELECT created_at FROM users WHERE id = ?)
         AND nr.read_at IS NULL
         AND nd.dismissed_at IS NULL`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );

    for (const row of unreadRows) {
      await clientDb.run(
        `INSERT OR REPLACE INTO notification_reads (notification_id, user_id, read_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [row.id, req.user.id]
      );
    }

    res.json({ message: "通知已全部標示為已讀。" });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const notificationId = Number(req.params.id);
    const notification = await clientDb.get(
      `SELECT id
       FROM notifications
       WHERE id = ?
         AND (recipient_user_id IS NULL OR recipient_user_id = ?)
         AND created_at >= (SELECT created_at FROM users WHERE id = ?)`,
      [notificationId, req.user.id, req.user.id]
    );

    if (!notification) {
      return res.status(404).json({ message: "找不到這則通知。" });
    }

    await clientDb.run(
      `INSERT OR REPLACE INTO notification_reads (notification_id, user_id, read_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [notificationId, req.user.id]
    );

    res.json({ message: "通知已標示為已讀。" });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const notificationId = Number(req.params.id);
    const notification = await clientDb.get(
      `SELECT id
       FROM notifications
       WHERE id = ?
         AND (recipient_user_id IS NULL OR recipient_user_id = ?)
         AND created_at >= (SELECT created_at FROM users WHERE id = ?)`,
      [notificationId, req.user.id, req.user.id]
    );

    if (!notification) {
      return res.status(404).json({ message: "找不到這則通知。" });
    }

    await clientDb.run(
      `INSERT OR REPLACE INTO notification_dismissals (notification_id, user_id, dismissed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [notificationId, req.user.id]
    );

    res.json({ message: "通知已刪除。" });
  } catch (error) {
    next(error);
  }
});

router.get("/recipients", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await clientDb.all(
      `SELECT id, username, display_name AS displayName, role
       FROM users
       ORDER BY role DESC, created_at ASC`
    );

    res.json({
      users: users.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        username: user.username,
        role: user.role
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const title = validateTextField(req.body.title || "通知", "通知標題", {
      ...FIELD_LIMITS.notificationTitle,
      required: false
    }) || "通知";
    const message = validateTextField(req.body.message, "通知內容", FIELD_LIMITS.notificationMessage);
    const rawRecipient = req.body.recipientUserId;
    const recipientUserId =
      rawRecipient === null || rawRecipient === undefined || rawRecipient === "" || rawRecipient === "all"
        ? null
        : Number(rawRecipient);

    if (recipientUserId !== null) {
      const targetUser = await clientDb.get("SELECT id FROM users WHERE id = ?", [recipientUserId]);
      if (!targetUser) {
        return res.status(404).json({ message: "找不到通知對象。" });
      }
    }

    await clientDb.run(
      `INSERT INTO notifications (sender_user_id, recipient_user_id, title, message)
       VALUES (?, ?, ?, ?)`,
      [req.user.id, recipientUserId, title, message]
    );

    res.status(201).json({
      message: recipientUserId === null ? "全體通知已送出。" : "通知已送出。"
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
