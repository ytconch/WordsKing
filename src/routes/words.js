const express = require("express");
const { wordsDb, clientDb } = require("../db/connections");
const { optionalAuth, requireAuth } = require("../middleware/auth");
const {
  normalizeEnglish,
  normalizeText,
  parseMeaningEntries,
  buildStarKey
} = require("../utils/wordHelpers");
const { naturalCompare } = require("../utils/sort");

const router = express.Router();
const GROUP_ORDER_SQL =
  "CASE WHEN instr(w.eng_normalized, ' ') > 0 THEN 1 ELSE 0 END, w.eng_normalized, length(w.eng_normalized)";

function attachMeaningMetadata(word) {
  return {
    ...word,
    chEntries: parseMeaningEntries(word.ch)
  };
}

function parsePositiveIds(value) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(",");
  return [
    ...new Set(
      rawValues
        .flatMap((item) => String(item || "").split(","))
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  ];
}

function normalizeWordOrderMode(mode) {
  return mode === "alpha" ? "alpha" : "unit";
}

function buildUnitRankMap(unitIds = []) {
  return new Map(unitIds.map((id, index) => [Number(id), index]));
}

function getUnitRank(word, unitRankMap) {
  const unitId = Number(word?.unit_id);
  return unitRankMap.has(unitId) ? unitRankMap.get(unitId) : Number.MAX_SAFE_INTEGER;
}

function compareWordLocation(a, b, unitRankMap) {
  const unitRankDelta = getUnitRank(a, unitRankMap) - getUnitRank(b, unitRankMap);
  if (unitRankDelta !== 0) return unitRankDelta;

  return (
    naturalCompare(a.source_name, b.source_name) ||
    naturalCompare(a.unit_name, b.unit_name) ||
    Number(a.id || 0) - Number(b.id || 0)
  );
}

function buildSelectedUnitOrderSql(selectedUnitIds = []) {
  if (!selectedUnitIds.length) {
    return "0";
  }

  const cases = selectedUnitIds.map((id, index) => `WHEN ${Number(id)} THEN ${index}`).join(" ");
  return `CASE u.id ${cases} ELSE ${selectedUnitIds.length} END`;
}

function buildGroupOrderSql(orderMode, selectedUnitIds = []) {
  if (orderMode !== "unit") {
    return GROUP_ORDER_SQL;
  }

  const unitOrderSql = buildSelectedUnitOrderSql(selectedUnitIds);
  return `MIN(${unitOrderSql}), MIN(s.name), MIN(u.name), ${GROUP_ORDER_SQL}, MIN(w.id)`;
}

function containsChinese(value) {
  return /\p{Script=Han}/u.test(String(value || ""));
}

function escapeLikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function buildWordsFilter(reqQuery = {}) {
  const { sourceId, unitId, unitIds, search } = reqQuery;
  const filters = [];
  const params = [];
  const requestedUnitIds = parsePositiveIds(unitIds);
  const selectedUnitIds = requestedUnitIds.length ? requestedUnitIds : parsePositiveIds(unitId);

  if (sourceId) {
    filters.push("s.id = ?");
    params.push(sourceId);
  }

  if (selectedUnitIds.length) {
    filters.push(`u.id IN (${selectedUnitIds.map(() => "?").join(",")})`);
    params.push(...selectedUnitIds);
  }

  if (search) {
    const searchText = String(search).trim();
    if (containsChinese(searchText)) {
      filters.push("w.ch LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(searchText)}%`);
    } else {
      filters.push("w.eng_normalized LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(normalizeEnglish(searchText))}%`);
    }
  }

  return {
    whereClause: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
    selectedUnitIds
  };
}

async function fetchWordsByGroupKeys({ engKeys, whereClause, params, orderMode = "unit", selectedUnitIds = [] }) {
  if (!engKeys.length) {
    return [];
  }

  const pageWords = await wordsDb.all(
    `SELECT
       w.id,
       w.word_ref AS wordRef,
       w.eng,
       w.eng_normalized,
       w.kk,
       w.tense,
       w.ch,
       w.analysis,
       w.definition,
       w.example,
       u.id AS unit_id,
       u.name AS unit_name,
       s.id AS source_id,
       s.name AS source_name
     FROM words w
     JOIN units u ON u.id = w.unit_id
     JOIN sources s ON s.id = u.source_id
     ${whereClause ? `${whereClause} AND` : "WHERE"} w.eng_normalized IN (${engKeys.map(() => "?").join(",")})
     ORDER BY ${GROUP_ORDER_SQL}, s.name, u.name, w.id`,
    [...params, ...engKeys]
  );

  const orderMap = new Map(engKeys.map((key, index) => [key, index]));
  const unitRankMap = buildUnitRankMap(selectedUnitIds);
  pageWords.sort((a, b) => {
    const groupDelta = (orderMap.get(a.eng_normalized) ?? 0) - (orderMap.get(b.eng_normalized) ?? 0);
    if (groupDelta !== 0) return groupDelta;
    return orderMode === "unit"
      ? compareWordLocation(a, b, unitRankMap)
      : naturalCompare(a.source_name, b.source_name) ||
          naturalCompare(a.unit_name, b.unit_name) ||
          Number(a.id || 0) - Number(b.id || 0);
  });

  return pageWords;
}

router.get("/sources", async (req, res, next) => {
  try {
    const sources = await wordsDb.all("SELECT id, name FROM sources");
    sources.sort((a, b) => naturalCompare(a.name, b.name));
    const data = [];

    for (const source of sources) {
      const units = await wordsDb.all(
        `SELECT
           u.id,
           u.name,
           (
             SELECT COUNT(*)
             FROM words w
             WHERE w.unit_id = u.id
           ) AS word_count
         FROM units u
         WHERE u.source_id = ?
         ORDER BY u.name`,
        [source.id]
      );

      for (const unit of units) {
        const unitWords = await wordsDb.all(
          `SELECT ch, definition
           FROM words
           WHERE unit_id = ?`,
          [unit.id]
        );

        unit.all_meaning_count = unitWords.reduce((sum, word) => {
          const entries = parseMeaningEntries(word.ch || word.definition || "");
          return sum + Math.max(entries.length, 1);
        }, 0);
      }

      units.sort((a, b) => naturalCompare(a.name, b.name));
      data.push({ ...source, units });
    }

    res.json({ sources: data });
  } catch (error) {
    next(error);
  }
});

router.get("/starred", requireAuth, async (req, res, next) => {
  try {
    if (req.user.isGuest) {
      return res.json({ starredWordKeys: [], starredWords: [] });
    }

    const rows = await clientDb.all(
      `SELECT word_key, eng, tense, word_ref, created_at
       FROM user_starred_words
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      starredWordKeys: rows.map((r) => r.word_key),
      starredWords: rows
    });
  } catch (error) {
    next(error);
  }
});

router.post("/starred/toggle", requireAuth, async (req, res, next) => {
  try {
    const eng = normalizeText(req.body.eng);
    const tense = normalizeText(req.body.tense);
    const wordRef = normalizeText(req.body.wordRef) || null;

    if (!eng) {
      return res.status(400).json({ message: "英文單字不可為空。" });
    }

    const wordKey = buildStarKey(eng, tense);

    if (req.user.isGuest) {
      return res.json({
        ok: true,
        isGuest: true,
        wordKey,
        starred: Boolean(req.body.starred)
      });
    }

    const existing = await clientDb.get(
      "SELECT id FROM user_starred_words WHERE user_id = ? AND word_key = ?",
      [req.user.id, wordKey]
    );

    if (existing) {
      await clientDb.run("DELETE FROM user_starred_words WHERE id = ?", [existing.id]);
      return res.json({
        ok: true,
        starred: false,
        wordKey
      });
    }

    await clientDb.run(
      `INSERT INTO user_starred_words (user_id, word_key, eng, tense, word_ref)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, wordKey, eng, tense, wordRef]
    );

    res.json({
      ok: true,
      starred: true,
      wordKey
    });
  } catch (error) {
    next(error);
  }
});

router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { limit, offset } = req.query;
    let { whereClause, params, selectedUnitIds } = buildWordsFilter(req.query);

    if (req.query.starredOnly === "true") {
      if (req.user?.id && !req.user?.isGuest) {
        const starredRows = await clientDb.all(
          "SELECT DISTINCT eng FROM user_starred_words WHERE user_id = ?",
          [req.user.id]
        );
        const starredEngs = starredRows.map((r) => normalizeEnglish(r.eng)).filter(Boolean);
        if (!starredEngs.length) {
          return res.json({
            words: [],
            totalGroups: 0,
            loadedGroups: 0,
            hasMore: false,
            nextOffset: 0
          });
        }
        whereClause = whereClause
          ? `${whereClause} AND w.eng_normalized IN (${starredEngs.map(() => "?").join(",")})`
          : `WHERE w.eng_normalized IN (${starredEngs.map(() => "?").join(",")})`;
        params.push(...starredEngs);
      }
    }

    const orderMode = normalizeWordOrderMode(req.query.order);
    const groupOrderSql = buildGroupOrderSql(orderMode, selectedUnitIds);
    const finalLimit = Math.min(Math.max(parseInt(limit, 10) || 36, 1), 120);
    const finalOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const totalRow = await wordsDb.get(
      `SELECT COUNT(*) AS total
       FROM (
         SELECT w.eng_normalized
         FROM words w
         JOIN units u ON u.id = w.unit_id
         JOIN sources s ON s.id = u.source_id
         ${whereClause}
         GROUP BY w.eng_normalized
       ) grouped_words`,
      params
    );

    const groupedRows = await wordsDb.all(
      `SELECT
         w.eng_normalized
       FROM words w
       JOIN units u ON u.id = w.unit_id
       JOIN sources s ON s.id = u.source_id
       ${whereClause}
       GROUP BY w.eng_normalized
       ORDER BY ${groupOrderSql}
       LIMIT ? OFFSET ?`,
      [...params, finalLimit, finalOffset]
    );

    if (!groupedRows.length) {
      return res.json({
        words: [],
        totalGroups: Number(totalRow?.total || 0),
        loadedGroups: 0,
        hasMore: false,
        nextOffset: finalOffset
      });
    }

    const engKeys = groupedRows.map((row) => row.eng_normalized);
    const pageWords = await fetchWordsByGroupKeys({ engKeys, whereClause, params, orderMode, selectedUnitIds });
    const nextOffset = finalOffset + groupedRows.length;

    res.json({
      words: pageWords.map((word) => attachMeaningMetadata(word)),
      totalGroups: Number(totalRow?.total || 0),
      loadedGroups: groupedRows.length,
      hasMore: nextOffset < Number(totalRow?.total || 0),
      nextOffset
    });
  } catch (error) {
    next(error);
  }
});

router.get("/by-ref/:wordRef", async (req, res, next) => {
  try {
    const finalLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 36, 1), 120);
    const { whereClause, params, selectedUnitIds } = buildWordsFilter(req.query);
    const orderMode = normalizeWordOrderMode(req.query.order);
    const groupOrderSql = buildGroupOrderSql(orderMode, selectedUnitIds);
    const targetWord = await wordsDb.get(
      `SELECT word_ref AS wordRef, eng_normalized
       FROM words
       WHERE word_ref = ?`,
      [req.params.wordRef]
    );

    if (!targetWord) {
      return res.status(404).json({ message: "找不到指定單字。" });
    }

    const groupedRows = await wordsDb.all(
      `SELECT w.eng_normalized
       FROM words w
       JOIN units u ON u.id = w.unit_id
       JOIN sources s ON s.id = u.source_id
       ${whereClause}
       GROUP BY w.eng_normalized
       ORDER BY ${groupOrderSql}`,
      params
    );

    const targetGroupIndex = groupedRows.findIndex((row) => row.eng_normalized === targetWord.eng_normalized);
    if (targetGroupIndex === -1) {
      return res.status(404).json({ message: "找不到指定單字。" });
    }

    const pageOffset = Math.floor(targetGroupIndex / finalLimit) * finalLimit;
    const pageGroupKeys = groupedRows.slice(pageOffset, pageOffset + finalLimit).map((row) => row.eng_normalized);
    const pageWords = await fetchWordsByGroupKeys({
      engKeys: pageGroupKeys,
      whereClause,
      params,
      orderMode,
      selectedUnitIds
    });
    const nextOffset = pageOffset + pageGroupKeys.length;

    res.json({
      words: pageWords.map((word) => attachMeaningMetadata(word)),
      totalGroups: groupedRows.length,
      loadedGroups: pageGroupKeys.length,
      hasMore: nextOffset < groupedRows.length,
      nextOffset,
      pageOffset,
      targetWordRef: targetWord.wordRef
    });
  } catch (error) {
    next(error);
  }
});

router.get("/overview", async (req, res, next) => {
  try {
    const totals = await wordsDb.get(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS source_count,
        (SELECT COUNT(*) FROM units) AS unit_count,
        (
          SELECT COUNT(*)
          FROM words w
          JOIN units u ON u.id = w.unit_id
          JOIN sources s ON s.id = u.source_id
        ) AS word_count
    `);

    const latestWords = await wordsDb.all(
      `SELECT
         w.id,
         w.word_ref AS wordRef,
         w.eng,
         w.kk,
         w.tense,
         w.ch,
         u.name AS unit_name,
         s.name AS source_name
       FROM words w
       JOIN units u ON u.id = w.unit_id
       JOIN sources s ON s.id = u.source_id
       ORDER BY w.updated_at DESC, w.id DESC
       LIMIT 8`
    );

    res.json({
      totals,
      latestWords: latestWords.map((word) => attachMeaningMetadata(word))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const word = await wordsDb.get(
      `SELECT
         w.id,
         w.word_ref AS wordRef,
         w.eng,
         w.kk,
         w.tense,
         w.ch,
         w.analysis,
         w.definition,
         w.example,
         u.name AS unit_name,
         s.name AS source_name
       FROM words w
       JOIN units u ON u.id = w.unit_id
       JOIN sources s ON s.id = u.source_id
       WHERE w.id = ?`,
      [req.params.id]
    );

    if (!word) {
      return res.status(404).json({ message: "找不到該單字。" });
    }

    res.json({
      word: attachMeaningMetadata(word)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

