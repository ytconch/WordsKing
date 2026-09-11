const { formatTaiwanDateKey, taiwanDateExpr } = require("./time");

function shiftDate(date, offset) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

async function getLearningTrends(db, userId, range = "30", today = formatTaiwanDateKey()) {
  const daily = await db.all(
    `SELECT ${taiwanDateExpr("created_at")} AS studyDate, COUNT(*) AS attempts,
       SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount
     FROM study_logs WHERE user_id = ? AND ${taiwanDateExpr("created_at")} <= ?
     GROUP BY studyDate ORDER BY studyDate`, [userId, today]
  );
  const firstCorrect = await db.all(
    `SELECT studyDate, COUNT(*) AS newWords FROM (
       SELECT MIN(${taiwanDateExpr("created_at")}) AS studyDate
       FROM study_logs WHERE user_id = ? AND is_correct = 1
         AND ${taiwanDateExpr("created_at")} <= ? GROUP BY word_ref
     ) GROUP BY studyDate ORDER BY studyDate`, [userId, today]
  );
  const dailyMap = new Map(daily.map((row) => [row.studyDate, row]));
  const newWordMap = new Map(firstCorrect.map((row) => [row.studyDate, row.newWords]));
  const dayData = (date) => {
    const row = dailyMap.get(date);
    const attempts = row?.attempts || 0;
    const correctCount = row?.correctCount || 0;
    return { studyDate: date, attempts, correctCount,
      accuracy: attempts ? Number((correctCount / attempts * 100).toFixed(1)) : null };
  };
  const dailyTrend = Array.from({ length: 14 }, (_, i) => dayData(shiftDate(today, i - 13)));
  const startDate = range === "all" ? daily[0]?.studyDate || today : shiftDate(today, 1 - Number(range));
  const baselineWords = firstCorrect.reduce((sum, row) => sum + (row.studyDate < startDate ? row.newWords : 0), 0);
  let cumulativeWords = baselineWords;
  let rollingAttempts = 0;
  let rollingCorrect = 0;
  for (let i = -6; i < 0; i++) {
    const row = dayData(shiftDate(startDate, i));
    rollingAttempts += row.attempts;
    rollingCorrect += row.correctCount;
  }
  const points = [];
  if (daily.length) {
    for (let date = startDate; date <= today; date = shiftDate(date, 1)) {
      const row = dayData(date);
      const newWords = newWordMap.get(date) || 0;
      cumulativeWords += newWords;
      rollingAttempts += row.attempts;
      rollingCorrect += row.correctCount;
      points.push({ ...row, newWords, cumulativeWords, rollingAttempts,
        rollingAccuracy: rollingAttempts ? Number((rollingCorrect / rollingAttempts * 100).toFixed(1)) : null });
      const expired = dayData(shiftDate(date, -6));
      rollingAttempts -= expired.attempts;
      rollingCorrect -= expired.correctCount;
    }
  }
  return { dailyTrend, growthTrend: { range, startDate, endDate: today, baselineWords,
    totalWords: cumulativeWords, newWords: cumulativeWords - baselineWords, points } };
}

module.exports = { getLearningTrends };
