import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const directory = process.env.WORDSKING_TEST_DB_DIR;
if (!directory) throw new Error("Use node scripts/test-isolated.js to run database tests safely.");
process.env.JWT_SECRET = "guest-auth-test-secret";
const config = require("../../src/config");
for (const name of ["words", "server", "client"]) config.dbPaths[name] = path.join(directory, `${name}.db`);
await require("../../src/db/init").initializeDatabases();
const { wordsDb } = require("../../src/db/connections");
await wordsDb.run("INSERT INTO sources (name, slug) VALUES ('Test', 'test')");
await wordsDb.run("INSERT INTO units (source_id, name, slug) VALUES (1, 'Test', 'test')");
// Existing cancellation coverage requests 5,000 questions; keep that path reachable.
await wordsDb.run("BEGIN");
for (let i = 0; i < 5000; i++) {
  await wordsDb.run("INSERT INTO words (word_ref, unit_id, eng, eng_normalized, ch) VALUES (?, 1, ?, ?, ?)",
    [`test-${i}`, `word${i}`, `word${i}`, `測試字義${i}`]);
}
await wordsDb.run("COMMIT");
