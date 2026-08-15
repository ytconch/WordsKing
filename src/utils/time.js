const TAIWAN_TIME_ZONE = "Asia/Taipei";
const TAIWAN_SQLITE_OFFSET = "+8 hours";
const TAIWAN_SQL_LAST_7_DAYS_START = "datetime('now', '+8 hours', 'start of day', '-6 days', '-8 hours')";
const TAIWAN_SQL_LAST_14_DAYS_START = "datetime('now', '+8 hours', 'start of day', '-13 days', '-8 hours')";

function taiwanDateExpr(columnName) {
  return `DATE(${columnName}, '${TAIWAN_SQLITE_OFFSET}')`;
}

function formatTaiwanDateKey(value = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIWAN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(new Date(value));
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map((item) => Number(item));
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function diffDateKeys(previousKey, currentKey) {
  const previous = parseDateKey(previousKey);
  const current = parseDateKey(currentKey);
  if (!previous || !current) {
    return 0;
  }
  return Math.round((current.getTime() - previous.getTime()) / 86400000);
}

function buildRecentTaiwanDateKeys(days) {
  const totalDays = Math.max(1, Number(days || 1));
  const todayKey = formatTaiwanDateKey(new Date());
  const today = parseDateKey(todayKey);
  const keys = [];

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const current = new Date(today.getTime());
    current.setUTCDate(current.getUTCDate() - offset);
    keys.push(formatTaiwanDateKey(current));
  }

  return keys;
}

module.exports = {
  TAIWAN_TIME_ZONE,
  TAIWAN_SQL_LAST_7_DAYS_START,
  TAIWAN_SQL_LAST_14_DAYS_START,
  taiwanDateExpr,
  formatTaiwanDateKey,
  diffDateKeys,
  buildRecentTaiwanDateKeys
};
