// Run the existing Node suite against disposable databases, never data/*.db.
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "wordsking-tests-"));
const targets = process.argv.slice(2);
const files = targets.length ? targets : readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => `tests/${f}`);
const timeout = targets.length ? 120000 : 600000;
const args = ["--import", "./tests/helpers/isolated-db.mjs", "--test", "--test-isolation=none", ...files];
const started = Date.now();
try {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...process.env, WORDSKING_TEST_DB_DIR: temporary },
    encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) console.error(`Command: node ${args.join(" ")}\nElapsed: ${Date.now() - started} ms\n${result.error.message}`);
  process.exitCode = result.error ? 1 : result.status ?? 1;
} finally {
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("wordsking-tests-")) {
    throw new Error("Unexpected test database directory");
  }
  rmSync(temporary, { recursive: true, force: true });
}
