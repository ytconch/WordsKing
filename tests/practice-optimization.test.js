const test = require("node:test");
const assert = require("node:assert/strict");

const { getWordParsedMeanings } = require("../src/utils/wordHelpers");
const practiceRouter = require("../src/routes/practice");

test("getWordParsedMeanings caches parsed meanings on word object", () => {
  const word = {
    eng: "apple",
    ch: "1. 蘋果 2. 蘋果樹"
  };

  assert.equal(word._parsedMeanings, undefined);
  const first = getWordParsedMeanings(word);
  assert.ok(Array.isArray(first));
  assert.equal(word._parsedMeanings, first);

  const second = getWordParsedMeanings(word);
  assert.equal(first, second);
});

test("clearPracticeWordCache is exported on practice router and callable", () => {
  assert.equal(typeof practiceRouter.clearPracticeWordCache, "function");
  practiceRouter.clearPracticeWordCache();
});

test("practice question limit accepts at most 5000 whole questions", () => {
  assert.equal(practiceRouter.PRACTICE_MAX_QUESTIONS, 5000);
  assert.equal(practiceRouter.parsePracticeQuestionLimit("5000"), 5000);
  assert.equal(practiceRouter.parsePracticeQuestionLimit("5001"), null);
  assert.equal(practiceRouter.parsePracticeQuestionLimit("20questions"), null);
});

test("full-scope practice generation respects the requested question count", async () => {
  const sessionLayer = practiceRouter.stack.find(
    (layer) => layer.route?.path === "/session" && layer.route.methods.get
  );
  const sessionHandler = sessionLayer.route.stack.at(-1).handle;

  const response = await new Promise((resolve, reject) => {
    const res = {
      destroyed: false,
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      }
    };

    sessionHandler(
      {
        query: { limit: "10", modes: "zh_to_en" },
        user: { id: -1 },
        aborted: false
      },
      res,
      reject
    );
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.questions.length, 10);
});

test("aborted practice generation stops before sending questions", async () => {
  const sessionLayer = practiceRouter.stack.find(
    (layer) => layer.route?.path === "/session" && layer.route.methods.get
  );
  const sessionHandler = sessionLayer.route.stack.at(-1).handle;
  const req = {
    query: { limit: "5000", modes: "zh_to_en" },
    user: { id: -1 },
    aborted: false
  };
  let responseSent = false;
  let nextError = null;

  const generation = sessionHandler(
    req,
    {
      destroyed: false,
      status() {
        return this;
      },
      json() {
        responseSent = true;
      }
    },
    (error) => {
      nextError = error;
    }
  );

  setImmediate(() => {
    req.aborted = true;
  });
  await generation;

  assert.equal(nextError, null);
  assert.equal(responseSent, false);
});

test("WAL mode is active on database connections", async () => {
  const { wordsDb, clientDb, serverDb } = require("../src/db/connections");
  const wordsJournal = await wordsDb.get("PRAGMA journal_mode");
  const clientJournal = await clientDb.get("PRAGMA journal_mode");
  const serverJournal = await serverDb.get("PRAGMA journal_mode");

  assert.equal(wordsJournal.journal_mode.toLowerCase(), "wal");
  assert.equal(clientJournal.journal_mode.toLowerCase(), "wal");
  assert.equal(serverJournal.journal_mode.toLowerCase(), "wal");
});

test("new composite indexes exist in databases", async () => {
  const { clientDb } = require("../src/db/connections");
  const { initializeDatabases } = require("../src/db/init");
  await initializeDatabases();

  const clientIndexes = await clientDb.all("PRAGMA index_list('mastery_stats')");
  const starredIndexes = await clientDb.all("PRAGMA index_list('user_starred_words')");

  const clientIndexNames = clientIndexes.map((i) => i.name);
  const starredIndexNames = starredIndexes.map((i) => i.name);

  assert.ok(clientIndexNames.includes("idx_mastery_user_wordref"), "idx_mastery_user_wordref should exist");
  assert.ok(starredIndexNames.includes("idx_user_starred_words_user_key"), "idx_user_starred_words_user_key should exist");
  assert.ok(starredIndexNames.includes("idx_user_starred_words_user"), "idx_user_starred_words_user should exist");
});
