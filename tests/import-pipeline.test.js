const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildRefreshDraftRows,
  buildWordChunks,
  mapChunkProgress,
  processChunksResumable,
  validateMergedWordRows
} = require("../src/routes/import")._test;

function row(eng, tense, meaning = eng) {
  return {
    eng,
    kk: "",
    tense,
    ch: JSON.stringify([[meaning]]),
    analysis: `${eng} analysis`,
    definition: `1. ${eng} definition`,
    example: JSON.stringify([{ eng: `Use ${eng}.`, ch: `使用 ${meaning}。` }])
  };
}

test("word chunks keep every form of one word together and enforce both limits", () => {
  const fortyOne = Array.from({ length: 41 }, (_, index) => row(`small${index}`, "n."));
  assert.deepEqual(buildWordChunks(fortyOne).map((chunk) => chunk.length), [41]);

  const entries = [];
  for (let index = 0; index < 76; index += 1) {
    entries.push({ ...row(`word${index}`, "n."), wordId: index + 1 });
  }
  entries.push({ ...row("word0", "v."), wordId: 1000 });

  const chunks = buildWordChunks(entries);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].filter((entry) => entry.eng === "word0").length, 2);
  assert.equal(chunks[1].some((entry) => entry.eng === "word0"), false);
  assert.equal(new Set(chunks[0].map((entry) => entry.eng)).size, 75);

  const twoRowsPerWord = Array.from({ length: 61 }, (_, index) => [
    row(`pair${index}`, "n."),
    row(`pair${index}`, "v.")
  ]).flat();
  const rowLimited = buildWordChunks(twoRowsPerWord);
  assert.deepEqual(rowLimited.map((chunk) => chunk.length), [120, 2]);

  assert.throws(
    () => buildWordChunks(Array.from({ length: 121 }, () => row("oversized", "n."))),
    /超過單批上限/
  );
});

test("resumable chunk state does not rerun completed chunks after a retryable failure", async () => {
  const state = { chunks: [["a"], ["b"], ["c"]], results: [null, null, null] };
  const calls = [];
  let failedOnce = false;
  const runChunk = async (chunk, index) => {
    calls.push(index);
    if (index === 1 && !failedOnce) {
      failedOnce = true;
      throw new Error("429 RESOURCE_EXHAUSTED");
    }
    return chunk;
  };

  await assert.rejects(processChunksResumable(state, runChunk), /429/);
  assert.deepEqual(await processChunksResumable(state, runChunk), ["a", "b", "c"]);
  assert.deepEqual(calls, [0, 1, 1, 2]);
});

test("chunk progress remains monotonic when a chunk restarts", () => {
  const first = mapChunkProgress(0, 100, 0, 3);
  const restarted = mapChunkProgress(first, 10, 1, 3);
  const later = mapChunkProgress(restarted, 80, 1, 3);

  assert.ok(first <= restarted);
  assert.ok(restarted <= later);
  assert.ok(later < 100);
});

test("refresh draft restores an existing part of speech omitted by AI", () => {
  const existing = [
    { ...row("record", "n.", "紀錄"), wordId: 1, wordRef: "record-n" },
    { ...row("record", "v.", "記錄"), wordId: 2, wordRef: "record-v" }
  ];
  const generated = [row("record", "n.", "紀錄")];

  const result = buildRefreshDraftRows(existing, generated);
  assert.deepEqual(result.map((item) => [item.wordId, item.tense]), [[1, "n."], [2, "v."]]);
  assert.doesNotThrow(() => validateMergedWordRows(result, existing));
});

test("refresh reserves exact part-of-speech matches before same-word corrections", () => {
  const existing = [
    { ...row("record", "n.", "紀錄"), wordId: 1, wordRef: "record-n" },
    { ...row("record", "v.", "記錄"), wordId: 2, wordRef: "record-v" }
  ];
  const generated = [row("record", "adj.", "紀錄的"), row("record", "n.", "紀錄")];

  const result = buildRefreshDraftRows(existing, generated);
  assert.deepEqual(result.map((item) => [item.wordId, item.tense]), [[2, "adj."], [1, "n."]]);
});
