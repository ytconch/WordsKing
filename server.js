require("dotenv").config();

const path = require("path");
const express = require("express");
const { jwtSecret } = require("./src/config");
const { initializeDatabases } = require("./src/db/init");
const { createAuditLogMiddleware } = require("./src/middleware/auditLog");
const authRoutes = require("./src/routes/auth");
const wordsRoutes = require("./src/routes/words");
const practiceRoutes = require("./src/routes/practice");
const analyticsRoutes = require("./src/routes/analytics");
const importRoutes = require("./src/routes/import");
const adminRoutes = require("./src/routes/admin");
const notificationRoutes = require("./src/routes/notifications");
const { router: ttsRoutes, startPronunciationPrefetchWorker } = require("./src/routes/tts");
const { getClientIp, queueServerLog } = require("./src/utils/serverLogger");

const app = express();
const PORT = process.env.PORT || 3000;

if (!jwtSecret) {
  console.error("JWT_SECRET is required. Server startup aborted.");
  process.exit(1);
}

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(createAuditLogMiddleware());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "WordsKingServer is running." });
});

app.use("/api/auth", authRoutes);
app.use("/api/words", wordsRoutes);
app.use("/api/practice", practiceRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/import", importRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/tts", ttsRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  req.__skipAuditLog = true;

  if (!req.user?.isGuest) {
    queueServerLog({
      level: "error",
      category: "server",
      action: `${req.method} ${String(req.originalUrl || "").split("?")[0] || req.path || ""}`,
      actorUserId: req.user?.id || null,
      actorUsername: req.user?.username || "",
      method: req.method,
      route: String(req.originalUrl || "").split("?")[0] || req.path || "",
      ipAddress: getClientIp(req),
      message: err.message || "Unexpected server error.",
      details: {
        status: err.status || 500,
        code: err.code || "",
        stack: err.stack || "",
        body: req.body || {},
        params: req.params || {},
        query: req.query || {}
      }
    });
  }

  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      message: "上傳內容過大，請改用較小的圖片，或先裁切後再上傳。"
    });
  }

  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      message: "圖片檔案過大，請控制在 20MB 以內。"
    });
  }

  res.status(err.status || 500).json({
    message: err.message || "Unexpected server error."
  });
});

initializeDatabases()
  .then(async () => {
    await startPronunciationPrefetchWorker();
    queueServerLog({
      level: "info",
      category: "server",
      action: "startup",
      method: "SYSTEM",
      route: `http://localhost:${PORT}`,
      ipAddress: "local",
      message: `Server started on http://localhost:${PORT}`,
      details: {
        port: Number(PORT),
        env: process.env.NODE_ENV || "development"
      }
    });

    app.listen(PORT, () => {
      console.log(`Server started on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize databases.", error);
    process.exit(1);
  });
