const sqlite3 = require("sqlite3").verbose();
const { dbPaths } = require("../config");

function createDatabase(filePath) {
  const db = new sqlite3.Database(filePath);
  db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
  });

  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function runStatement(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(row);
        });
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        });
      });
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  };
}

const wordsDb = createDatabase(dbPaths.words);
const serverDb = createDatabase(dbPaths.server);
const clientDb = createDatabase(dbPaths.client);

module.exports = {
  wordsDb,
  serverDb,
  clientDb
};
