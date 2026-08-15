const { serverDb } = require("../db/connections");

const REDACTED_KEYS = new Set([
  "password",
  "currentPassword",
  "newPassword",
  "temporaryPassword",
  "token",
  "authorization",
  "cookie"
]);

function truncateText(value, maxLength = 240) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= 3) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }
    if (typeof value === "object") {
      return "[Object]";
    }
  }

  if (Array.isArray(value)) {
    if (value.length > 12) {
      return {
        kind: "array",
        length: value.length,
        sample: value.slice(0, 5).map((item) => sanitizeValue(item, depth + 1))
      };
    }
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = sanitizeValue(entryValue, depth + 1);
    }
    return result;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  return value;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function queueServerLog(entry) {
  writeServerLog(entry).catch((error) => {
    console.error("Failed to write server log.", error);
  });
}

async function writeServerLog(entry) {
  const details =
    entry.details === null || entry.details === undefined ? null : JSON.stringify(sanitizeValue(entry.details));

  await serverDb.run(
    `INSERT INTO server_logs
       (
         level,
         category,
         action,
         actor_user_id,
         actor_username,
         method,
         route,
         ip_address,
         message,
         details_json
       )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(entry.level || "info").slice(0, 16),
      String(entry.category || "server").slice(0, 40),
      String(entry.action || "event").slice(0, 80),
      entry.actorUserId ? Number(entry.actorUserId) : null,
      truncateText(entry.actorUsername || "", 80),
      truncateText(entry.method || "", 16),
      truncateText(entry.route || "", 180),
      truncateText(entry.ipAddress || "", 64),
      truncateText(entry.message || "", 300),
      details
    ]
  );
}

module.exports = {
  getClientIp,
  queueServerLog,
  sanitizeValue,
  writeServerLog
};
