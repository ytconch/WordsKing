const { getClientIp, queueServerLog, sanitizeValue } = require("../utils/serverLogger");

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const SKIP_ROUTE_PREFIXES = ["/api/auth/visit"];

function classifyCategory(pathname) {
  const parts = String(pathname || "")
    .split("/")
    .filter(Boolean);

  return parts[1] || parts[0] || "server";
}

function extractFileDetails(req) {
  if (Array.isArray(req.files) && req.files.length) {
    return {
      count: req.files.length,
      names: req.files.slice(0, 5).map((file) => file.originalname || file.fieldname || "upload")
    };
  }

  if (req.file) {
    return {
      count: 1,
      names: [req.file.originalname || req.file.fieldname || "upload"]
    };
  }

  return null;
}

function shouldSkip(pathname) {
  return SKIP_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function createAuditLogMiddleware() {
  return (req, res, next) => {
    const startedAt = Date.now();

    res.on("finish", () => {
      if (req.__skipAuditLog) {
        return;
      }

      const pathname = String(req.originalUrl || "").split("?")[0] || req.path || "";
      if (!pathname.startsWith("/api/") || shouldSkip(pathname)) {
        return;
      }

      const statusCode = Number(res.statusCode || 0);
      if (!MUTATION_METHODS.has(req.method) && statusCode < 400) {
        return;
      }

      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
      const fileDetails = extractFileDetails(req);

      queueServerLog({
        level,
        category: classifyCategory(pathname),
        action: `${req.method} ${pathname}`,
        actorUserId: req.user?.id || null,
        actorUsername: req.user?.username || "",
        method: req.method,
        route: pathname,
        ipAddress: getClientIp(req),
        message: `${req.method} ${pathname} -> ${statusCode}`,
        details: {
          statusCode,
          durationMs: Date.now() - startedAt,
          params: sanitizeValue(req.params || {}),
          query: sanitizeValue(req.query || {}),
          body: sanitizeValue(req.body || {}),
          files: fileDetails
        }
      });
    });

    next();
  };
}

module.exports = {
  createAuditLogMiddleware
};
