"use strict";

const { wordsDb, serverDb } = require("../../src/db/connections");
const { naturalCompare } = require("../../src/utils/sort");

const sourceName = "大考中心高中英文參考詞彙表";

async function main() {
  const units = await wordsDb.all(
    `SELECT u.id, u.name, COUNT(w.id) AS rows, COUNT(DISTINCT w.eng_normalized) AS distinct_eng
       FROM sources s JOIN units u ON u.source_id = s.id LEFT JOIN words w ON w.unit_id = u.id
      WHERE s.name = ? GROUP BY u.id, u.name`,
    [sourceName]
  );
  units.sort((a, b) => naturalCompare(a.name, b.name));

  const sampleWords = await wordsDb.all(
    `SELECT u.name AS unit, w.eng, w.tense, w.kk
       FROM words w JOIN units u ON u.id = w.unit_id JOIN sources s ON s.id = u.source_id
      WHERE s.name = ? AND w.eng_normalized IN
        ('a','an','actor','actress','agree','agreement','ad','advertise','advertisement','he','him','his','himself')
      ORDER BY u.name, w.eng_normalized, w.tense`,
    [sourceName]
  );

  const allSpellings = await wordsDb.all(
    `SELECT DISTINCT w.eng
       FROM words w JOIN units u ON u.id = w.unit_id JOIN sources s ON s.id = u.source_id
      WHERE s.name = ?`,
    [sourceName]
  );
  const markedSpellings = allSpellings
    .map((row) => row.eng)
    .filter((word) => /[^\x00-\x7F]/.test(word))
    .slice(0, 30);

  const crossLevel = await wordsDb.all(
    `SELECT w.eng_normalized AS eng, COUNT(DISTINCT u.id) AS levels, GROUP_CONCAT(DISTINCT u.name) AS units
       FROM words w JOIN units u ON u.id = w.unit_id JOIN sources s ON s.id = u.source_id
      WHERE s.name = ? GROUP BY w.eng_normalized HAVING COUNT(DISTINCT u.id) > 1
      ORDER BY w.eng_normalized LIMIT 20`,
    [sourceName]
  );

  const invalidJson = await wordsDb.get(
    `SELECT COUNT(*) AS count
       FROM words w JOIN units u ON u.id = w.unit_id JOIN sources s ON s.id = u.source_id
      WHERE s.name = ? AND (json_valid(w.ch) = 0 OR json_valid(w.example) = 0)`,
    [sourceName]
  );
  const duplicateEngTense = await wordsDb.get(
    `SELECT COUNT(*) AS count FROM (
       SELECT u.id, w.eng_normalized, w.tense
         FROM words w JOIN units u ON u.id = w.unit_id JOIN sources s ON s.id = u.source_id
        WHERE s.name = ? GROUP BY u.id, w.eng_normalized, w.tense HAVING COUNT(*) > 1
      )`,
    [sourceName]
  );
  const importBatches = await serverDb.all(
    `SELECT unit_name, imported_count, created_by
       FROM import_batches WHERE source_name = ? ORDER BY id`,
    [sourceName]
  );

  console.log(JSON.stringify({
    units,
    sampleWords,
    markedSpellings,
    crossLevel,
    invalidJson: Number(invalidJson.count),
    duplicateEngTense: Number(duplicateEngTense.count),
    importBatches
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
