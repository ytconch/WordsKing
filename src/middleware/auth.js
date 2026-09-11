const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config");
const { clientDb } = require("../db/connections");

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Authorization token is required." });
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }

  if (payload.guest === true) {
    req.user = {
      id: null,
      username: "guest",
      role: "guest",
      isGuest: true
    };
    req.__skipAuditLog = true;
    next();
    return;
  }

  try {
    const user = await clientDb.get(
      `SELECT id, username, role, token_version AS tokenVersion
       FROM users
       WHERE id = ?`,
      [payload.id]
    );

    if (!user) {
      return res.status(401).json({ message: "Account no longer exists." });
    }

    if (Number(user.tokenVersion || 0) !== Number(payload.tokenVersion)) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: Number(user.tokenVersion || 0)
    };
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin permission is required." });
  }
  next();
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return next();
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    return next();
  }

  if (payload.guest === true) {
    req.user = {
      id: null,
      username: "guest",
      role: "guest",
      isGuest: true
    };
    return next();
  }

  try {
    const user = await clientDb.get(
      `SELECT id, username, role, token_version AS tokenVersion
       FROM users
       WHERE id = ?`,
      [payload.id]
    );

    if (user && Number(user.tokenVersion || 0) === Number(payload.tokenVersion)) {
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        tokenVersion: Number(user.tokenVersion || 0)
      };
    }
    next();
  } catch {
    next();
  }
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth
};

