function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function createRateLimiter({ key, windowMs, max, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [entryKey, entry] of hits.entries()) {
      if (entry.resetAt <= now) {
        hits.delete(entryKey);
      }
    }
  }, Math.max(60 * 1000, Math.min(windowMs, 10 * 60 * 1000))).unref();

  return (req, res, next) => {
    const now = Date.now();
    const entryKey = `${key}:${getClientIp(req)}`;
    const current = hits.get(entryKey);

    if (!current || current.resetAt <= now) {
      hits.set(entryKey, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    if (current.count >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      res.status(429).json({ message });
      return;
    }

    current.count += 1;
    next();
  };
}

module.exports = {
  createRateLimiter
};
