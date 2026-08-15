const path = require("path");

module.exports = {
  jwtSecret: String(process.env.JWT_SECRET || "").trim(),
  dbPaths: {
    words: path.join(__dirname, "..", "data", "Words.db"),
    server: path.join(__dirname, "..", "data", "Server.db"),
    client: path.join(__dirname, "..", "data", "Client.db")
  }
};
