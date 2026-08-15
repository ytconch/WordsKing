const { wordsDb, clientDb } = require("../db/connections");

async function getCurrentWordsMap() {
  const rows = await wordsDb.all(
    `SELECT
       w.id,
       w.word_ref,
       w.eng,
       w.ch,
       u.name AS unit_name,
       s.name AS source_name
     FROM words w
     JOIN units u ON u.id = w.unit_id
     JOIN sources s ON s.id = u.source_id`
  );

  const map = new Map();
  for (const row of rows) {
    map.set(row.word_ref, row);
  }
  return map;
}

async function syncStudyData(userId = null) {
  const wordMap = await getCurrentWordsMap();
  const whereClause = userId ? "WHERE user_id = ?" : "";
  const params = userId ? [userId] : [];

  const stats = await clientDb.all(
    `SELECT id, word_ref FROM mastery_stats ${whereClause}`,
    params
  );

  for (const stat of stats) {
    const currentWord = wordMap.get(stat.word_ref);

    if (!currentWord) {
      await clientDb.run("DELETE FROM mastery_stats WHERE id = ?", [stat.id]);
      continue;
    }

    await clientDb.run(
      `UPDATE mastery_stats
       SET word_id = ?, source_name = ?, unit_name = ?
       WHERE id = ?`,
      [
        currentWord.id,
        currentWord.source_name,
        currentWord.unit_name,
        stat.id
      ]
    );
  }

  const logs = await clientDb.all(
    `SELECT id, word_ref FROM study_logs ${whereClause}`,
    params
  );

  for (const log of logs) {
    const currentWord = wordMap.get(log.word_ref);

    if (!currentWord) {
      await clientDb.run("UPDATE study_logs SET word_id = NULL WHERE id = ?", [log.id]);
      continue;
    }

    await clientDb.run(
      `UPDATE study_logs
       SET word_id = ?, source_name = ?, unit_name = ?
       WHERE id = ?`,
      [
        currentWord.id,
        currentWord.source_name,
        currentWord.unit_name,
        log.id
      ]
    );
  }
}

module.exports = {
  syncStudyData
};
