const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStarKey, normalizeEnglish, normalizeText } = require("../src/utils/wordHelpers");
const { clientDb, wordsDb } = require("../src/db/connections");
const { initializeDatabases } = require("../src/db/init");
const wordsRouter = require("../src/routes/words");
const practiceRouter = require("../src/routes/practice");

test("buildStarKey correctly separates same word with different parts of speech (tenses)", () => {
  const nounKey = buildStarKey("record", "n.");
  const verbKey = buildStarKey("record", "v.");

  assert.equal(nounKey, "record::n.");
  assert.equal(verbKey, "record::v.");
  assert.notEqual(nounKey, verbKey);

  // Normalization checks
  assert.equal(buildStarKey("  Record  ", "  N.  "), "record::n.");
  assert.equal(buildStarKey("Lead", "v. (led, led)"), "lead::v. (led, led)");
  assert.equal(buildStarKey("Lead", "n."), "lead::n.");
  assert.notEqual(buildStarKey("Lead", "v. (led, led)"), buildStarKey("Lead", "n."));
});

test("user_starred_words DB operations enforce user and POS isolation", async () => {
  await initializeDatabases();

  const testUserId = 999991;
  const wordKeyNoun = buildStarKey("testword", "n.");
  const wordKeyVerb = buildStarKey("testword", "v.");

  // Clean up any test records and ensure user exists
  await clientDb.run("DELETE FROM user_starred_words WHERE user_id = ?", [testUserId]);
  await clientDb.run(
    "INSERT OR REPLACE INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)",
    [testUserId, "testuser_star_1", "hash", "Test Star 1", "student"]
  );

  // Insert noun star
  await clientDb.run(
    "INSERT INTO user_starred_words (user_id, word_key, eng, tense, word_ref) VALUES (?, ?, ?, ?, ?)",
    [testUserId, wordKeyNoun, "testword", "n.", "testword::n."]
  );

  const starredRows = await clientDb.all(
    "SELECT word_key, eng, tense FROM user_starred_words WHERE user_id = ?",
    [testUserId]
  );

  assert.equal(starredRows.length, 1);
  assert.equal(starredRows[0].word_key, wordKeyNoun);
  assert.equal(starredRows[0].tense, "n.");

  // Query checking that verb is NOT starred
  const verbCheck = await clientDb.get(
    "SELECT id FROM user_starred_words WHERE user_id = ? AND word_key = ?",
    [testUserId, wordKeyVerb]
  );
  assert.equal(verbCheck, undefined);

  // Clean up
  await clientDb.run("DELETE FROM user_starred_words WHERE user_id = ?", [testUserId]);
  await clientDb.run("DELETE FROM users WHERE id = ?", [testUserId]);
});

test("wordsRouter starred endpoints toggle and return starredWordKeys with POS separation", async () => {
  await initializeDatabases();

  const testUserId = 999992;
  await clientDb.run("DELETE FROM user_starred_words WHERE user_id = ?", [testUserId]);
  await clientDb.run(
    "INSERT OR REPLACE INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)",
    [testUserId, "testuser_star_2", "hash", "Test Star 2", "student"]
  );

  // Find toggle route
  const toggleLayer = wordsRouter.stack.find(
    (layer) => layer.route?.path === "/starred/toggle" && layer.route.methods.post
  );
  assert.ok(toggleLayer, "Toggle route must exist");
  const toggleHandler = toggleLayer.route.stack.at(-1).handle;

  // Toggle on noun
  const toggleRes1 = await new Promise((resolve, reject) => {
    toggleHandler(
      {
        user: { id: testUserId, isGuest: false },
        body: { eng: "object", tense: "n.", wordRef: "ref-1", starred: true }
      },
      {
        json: (data) => resolve(data)
      },
      reject
    );
  });
  assert.equal(toggleRes1.starred, true);
  assert.equal(toggleRes1.wordKey, "object::n.");

  // Find get starred route
  const getStarredLayer = wordsRouter.stack.find(
    (layer) => layer.route?.path === "/starred" && layer.route.methods.get
  );
  assert.ok(getStarredLayer, "Get starred route must exist");
  const getStarredHandler = getStarredLayer.route.stack.at(-1).handle;

  const getStarredRes = await new Promise((resolve, reject) => {
    getStarredHandler(
      { user: { id: testUserId, isGuest: false } },
      { json: (data) => resolve(data) },
      reject
    );
  });

  assert.ok(Array.isArray(getStarredRes.starredWordKeys));
  assert.ok(getStarredRes.starredWordKeys.includes("object::n."));
  assert.ok(!getStarredRes.starredWordKeys.includes("object::v."));

  // Toggle off noun
  const toggleRes2 = await new Promise((resolve, reject) => {
    toggleHandler(
      {
        user: { id: testUserId, isGuest: false },
        body: { eng: "object", tense: "n.", wordRef: "ref-1", starred: false }
      },
      {
        json: (data) => resolve(data)
      },
      reject
    );
  });
  assert.equal(toggleRes2.starred, false);

  // Clean up
  await clientDb.run("DELETE FROM user_starred_words WHERE user_id = ?", [testUserId]);
  await clientDb.run("DELETE FROM users WHERE id = ?", [testUserId]);
});

test("practice availability and session support guestStarredKeys", async () => {
  const availLayer = practiceRouter.stack.find(
    (layer) => layer.route?.path === "/availability" && layer.route.methods.get
  );
  const availHandler = availLayer.route.stack.at(-1).handle;

  // Query with an impossible star key -> availability wordCount should be 0
  const availRes = await new Promise((resolve, reject) => {
    availHandler(
      {
        query: { starredOnly: "true", guestStarredKeys: JSON.stringify(["nonexistent_key_xyz::n."]) },
        user: { id: null, isGuest: true }
      },
      {
        json: (data) => resolve(data)
      },
      reject
    );
  });

  assert.equal(availRes.wordCount, 0);
  assert.equal(availRes.allMeaningCount, 0);
  assert.equal(availRes.starredOnly, true);
});
