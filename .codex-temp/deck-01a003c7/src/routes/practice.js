const express = require("express");
const { wordsDb, serverDb, clientDb } = require("../db/connections");
const { requireAuth } = require("../middleware/auth");
const {
  buildPracticePrompt,
  buildExpectedAnswer,
  isAnswerCorrect,
  cleanMeaningEntry,
  normalizeText,
  parseMeaningEntries,
  resolveMeaningScopeEntries
} = require("../utils/wordHelpers");

const router = express.Router();
const ALLOWED_MODES = new Set(["zh_to_en", "en_to_zh", "type_en_from_zh", "cloze_en"]);
const CLOZE_MODE = "cloze_en";
const DEFAULT_WEIGHT = 1;

function shuffle(list) {
  const clone = [...list];
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }
  return clone;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPracticeWordKey(word) {
  return `${String(word.eng || "").trim().toLowerCase()}::${String(word.tense || "").trim().toLowerCase()}`;
}

function buildPracticeLexemeKey(word) {
  return String(word.eng || "").trim().toLowerCase();
}

function buildPracticeFamilyKey(word) {
  return buildPracticeLexemeKey(word) || String(word.word_ref || word.wordRef || buildPracticeWordKey(word));
}

function buildPracticeItemKey(word) {
  return String(word.practiceKey || word.word_ref || word.id || "");
}

function normalizeMeaningForMatch(value) {
  return cleanMeaningEntry(value)
    .replace(/[\s,，.。;；:：!?！？、'"「」『』（）()【】\[\]{}<>《》]/g, "")
    .toLowerCase();
}

function parseExampleItems(example) {
  if (!example) {
    return [];
  }

  if (Array.isArray(example)) {
    return example
      .map((item) => ({
        eng: normalizeText(item?.eng),
        ch: normalizeText(item?.ch)
      }))
      .filter((item) => item.eng);
  }

  const text = normalizeText(example);
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parseExampleItems(parsed);
    }
  } catch {}

  const normalizedKeys = text.replace(/([{,]\s*)'([A-Za-z]+)'\s*:/g, '$1"$2":');
  try {
    const parsed = JSON.parse(normalizedKeys.replace(/:\s*'([^']*)'/g, (_match, value) => `: ${JSON.stringify(value)}`));
    if (Array.isArray(parsed)) {
      return parseExampleItems(parsed);
    }
  } catch {}

  return Array.from(
    text.matchAll(/\{\s*['"]eng['"]\s*:\s*(['"])(.*?)\1\s*,\s*['"]ch['"]\s*:\s*(['"])(.*?)\3\s*\}/gs)
  )
    .map((match) => ({
      eng: normalizeText(match[2]),
      ch: normalizeText(match[4])
    }))
    .filter((item) => item.eng);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findClozeMatch(sentence, targetText) {
  const source = normalizeText(sentence);
  const target = normalizeText(targetText).replace(/\s+/g, " ");
  if (!source || !target) {
    return null;
  }

  const pattern = escapeRegExp(target).replace(/\s+/g, "\\s+");
  const regex = new RegExp(`(^|[^A-Za-z])(${pattern})(?=$|[^A-Za-z])`, "i");
  const match = source.match(regex);
  if (!match) {
    return null;
  }

  const start = Number(match.index || 0) + match[1].length;
  const answer = match[2];
  const end = start + answer.length;
  return {
    answer,
    sentence: `${source.slice(0, start)}____${source.slice(end)}`
  };
}

function exampleMatchesExamMeaning(exampleTranslation, examMeanings) {
  const exampleParts = parseMeaningEntries(exampleTranslation || exampleTranslation === 0 ? exampleTranslation : "")
    .concat([normalizeText(exampleTranslation)])
    .map(normalizeMeaningForMatch)
    .filter((item) => item.length >= 2);
  const meaningParts = (examMeanings || [])
    .flatMap((meaning) => parseMeaningEntries(meaning).concat([meaning]))
    .map(normalizeMeaningForMatch)
    .filter((item) => item.length >= 2);

  if (!exampleParts.length || !meaningParts.length) {
    return false;
  }

  return exampleParts.some((examplePart) =>
    meaningParts.some(
      (meaningPart) => examplePart === meaningPart || examplePart.includes(meaningPart) || meaningPart.includes(examplePart)
    )
  );
}

function mergePracticeWord(baseWord, incomingWord) {
  const sourceNames = new Set([...(baseWord.sourceNames || []), incomingWord.source_name].filter(Boolean));
  const unitNames = new Set([...(baseWord.unitNames || []), incomingWord.unit_name].filter(Boolean));
  const sourceUnitPairs = new Set([
    ...(baseWord.sourceUnitPairs || []),
    [incomingWord.source_name, incomingWord.unit_name].filter(Boolean).join(" / ")
  ].filter(Boolean));
  const wordRefs = new Set([...(baseWord.wordRefs || []), incomingWord.word_ref].filter(Boolean));

  return {
    ...baseWord,
    kk: baseWord.kk || incomingWord.kk,
    ch: baseWord.ch || incomingWord.ch,
    analysis: baseWord.analysis || incomingWord.analysis,
    definition: baseWord.definition || incomingWord.definition,
    example: baseWord.example || incomingWord.example,
    examMeaningIndexes: [...new Set([...(baseWord.examMeaningIndexes || []), ...(incomingWord.examMeaningIndexes || [])])],
    examMeaningTexts: [...new Set([...(baseWord.examMeaningTexts || []), ...(incomingWord.examMeaningTexts || [])])],
    sourceNames: [...sourceNames],
    unitNames: [...unitNames],
    sourceUnitPairs: [...sourceUnitPairs],
    wordRefs: [...wordRefs]
  };
}

function dedupePracticeWords(words) {
  const map = new Map();
  const result = [];

  for (const word of words) {
    const key = buildPracticeWordKey(word);
    if (!key || key === "::") continue;

    if (!map.has(key)) {
        const initial = {
          ...word,
          examMeaningIndexes: Array.isArray(word.examMeaningIndexes) ? word.examMeaningIndexes : [],
          examMeaningTexts: Array.isArray(word.examMeaningTexts) ? word.examMeaningTexts : [],
          sourceNames: [word.source_name].filter(Boolean),
          unitNames: [word.unit_name].filter(Boolean),
          sourceUnitPairs: [[word.source_name, word.unit_name].filter(Boolean).join(" / ")].filter(Boolean),
          wordRefs: [word.word_ref].filter(Boolean)
        };
      map.set(key, initial);
      result.push(initial);
      continue;
    }

    map.set(key, mergePracticeWord(map.get(key), word));
    const index = result.findIndex((item) => buildPracticeWordKey(item) === key);
    if (index >= 0) {
      result[index] = map.get(key);
    }
  }

  return result;
}

function expandPracticeItems(words, options = {}) {
  const meaningScope = options.meaningScope || "all_meanings";

  return words.flatMap((word) => {
    const allMeanings = parseMeaningEntries(word.ch || word.definition || "");
    const meanings = resolveMeaningScopeEntries(word, meaningScope, { fallbackCoreCount: 2 });
    if (meaningScope === "exam_only" && !meanings.length) {
      return [];
    }

    if (!meanings.length) {
      return [
        {
          ...word,
          practiceMeaning: normalizeText(word.ch || word.definition || ""),
          meaningIndex: 0,
          practiceKey: `${word.word_ref}::meaning::0`
        }
      ];
    }

    const usedIndexes = new Set();
    return meanings.map((meaning, index) => {
      let meaningIndex = allMeanings.findIndex(
        (entry, entryIndex) => !usedIndexes.has(entryIndex) && entry === meaning
      );
      if (meaningIndex === -1) {
        meaningIndex = index;
      }
      usedIndexes.add(meaningIndex);

      return {
        ...word,
        practiceMeaning: meaning,
        meaningIndex,
        practiceKey: `${word.word_ref}::meaning::${meaningIndex}`,
        meaningPriority: meaningIndex <= 1 ? meaningIndex : meaningIndex + 10
      };
    });
  });
}

function expandClozeItems(words, options = {}) {
  const meaningScope = options.meaningScope || "all_meanings";

  return words.flatMap((word) => {
    const examples = parseExampleItems(word.example);
    if (!examples.length) {
      return [];
    }

    const examMeanings = resolveMeaningScopeEntries(word, "exam_only");
    if (meaningScope === "exam_only" && !examMeanings.length) {
      return [];
    }

    return examples.flatMap((example, exampleIndex) => {
      if (meaningScope === "exam_only" && !exampleMatchesExamMeaning(example.ch, examMeanings)) {
        return [];
      }

      const cloze = findClozeMatch(example.eng, word.eng);
      if (!cloze) {
        return [];
      }

      return [
        {
          ...word,
          practiceMeaning: normalizeText(example.ch || examMeanings[0] || word.ch || word.definition || ""),
          meaningIndex: Number.isInteger(word.meaningIndex) ? word.meaningIndex : 0,
          practiceKey: `${word.word_ref}::cloze::${exampleIndex}::${normalizeText(cloze.answer).toLowerCase()}`,
          clozeSentence: cloze.sentence,
          clozeAnswer: cloze.answer,
          exampleTranslation: normalizeText(example.ch),
          meaningPriority: exampleIndex <= 1 ? exampleIndex : exampleIndex + 10
        }
      ];
    });
  });
}

async function buildClozePracticeItems(words, options = {}) {
  const meaningScope = options.meaningScope || "all_meanings";
  return expandClozeItems(words, { meaningScope });
}

function daysSince(value) {
  if (!value) return 999;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return 999;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

function parseSelectedModes(query) {
  const rawModes = query.modes || query.mode || "zh_to_en";
  const modes = String(rawModes)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => ALLOWED_MODES.has(item));

  return [...new Set(modes)].length ? [...new Set(modes)] : ["zh_to_en"];
}

function parseModeWeights(rawWeights, modes) {
  let parsed = {};

  if (rawWeights) {
    try {
      parsed = JSON.parse(rawWeights);
    } catch (error) {
      parsed = {};
    }
  }

  return modes.map((mode) => ({
    mode,
    weight: Number(parsed[mode]) > 0 ? Number(parsed[mode]) : DEFAULT_WEIGHT
  }));
}

function parseSelectedUnitIds(query) {
  if (query.unitIds) {
    return String(query.unitIds)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return query.unitId ? [String(query.unitId).trim()].filter(Boolean) : [];
}

function pickWeightedMode(weightedModes) {
  const totalWeight = weightedModes.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * totalWeight;

  for (const item of weightedModes) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.mode;
    }
  }

  return weightedModes[weightedModes.length - 1].mode;
}

function buildModeQueue(weightedModes, totalQuestions) {
  if (!weightedModes.length || totalQuestions <= 0) {
    return [];
  }

  const totalWeight = weightedModes.reduce((sum, item) => sum + item.weight, 0) || 1;
  const exactCounts = weightedModes.map((item) => ({
    mode: item.mode,
    exact: (item.weight / totalWeight) * totalQuestions
  }));
  const counts = exactCounts.map((item) => ({
    mode: item.mode,
    count: Math.floor(item.exact),
    remainder: item.exact - Math.floor(item.exact)
  }));

  let assigned = counts.reduce((sum, item) => sum + item.count, 0);
  while (assigned < totalQuestions) {
    counts.sort((a, b) => b.remainder - a.remainder || a.count - b.count);
    counts[0].count += 1;
    counts[0].remainder = 0;
    assigned += 1;
  }

  const queue = [];
  let previousMode = "";
  while (queue.length < totalQuestions) {
    const candidates = counts
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode));

    if (!candidates.length) {
      break;
    }

    const next =
      candidates.find((item) => item.mode !== previousMode) ||
      candidates[0];
    next.count -= 1;
    queue.push(next.mode);
    previousMode = next.mode;
  }

  return queue;
}

function isMasteredWord(stat) {
  const attempts = safeNumber(stat?.attempts);
  const correctCount = safeNumber(stat?.correctCount);
  const wrongCount = safeNumber(stat?.wrongCount);
  const streak = safeNumber(stat?.streak);
  const accuracy = attempts ? correctCount / attempts : 0;

  return attempts >= 4 && accuracy >= 0.85 && streak >= 2 && wrongCount <= 1;
}

function buildPracticeProfile(word, stat, { preferFocusedReview = false } = {}) {
  const attempts = safeNumber(stat?.attempts);
  const correctCount = safeNumber(stat?.correctCount);
  const wrongCount = safeNumber(stat?.wrongCount);
  const streak = safeNumber(stat?.streak);
  const accuracy = attempts ? correctCount / attempts : 0;
  const wrongRatio = attempts ? wrongCount / attempts : 0;
  const mastered = isMasteredWord({ attempts, correctCount, wrongCount, streak });
  const recencyDays = daysSince(stat?.lastAnsweredAt);

  let weight = 1;

  if (!attempts) {
    weight += 1.8;
  } else {
    weight += Math.min(attempts, 6) * 0.05;
    weight += Math.max(0, 0.85 - accuracy) * 2.2;
    weight += Math.min(wrongCount, 4) * 0.25;
    weight += wrongRatio * 0.9;
  }

  if (wrongCount > 0) {
    weight += 0.35;
  }

  if (attempts >= 3 && accuracy < 0.7) {
    weight += 0.45;
  }

  if (recencyDays >= 5 && attempts > 0 && !mastered) {
    weight += Math.min(0.75, recencyDays * 0.04);
  }

  if (mastered) {
    weight *= preferFocusedReview ? 0.55 : 0.75;
  }

  if (Number.isInteger(word.meaningIndex)) {
    if (word.meaningIndex === 0) {
      weight += 0.45;
    } else if (word.meaningIndex === 1) {
      weight += 0.18;
    } else {
      weight += 0.03;
    }
  }

  return {
    ...word,
    attempts,
    correctCount,
    wrongCount,
    streak,
    accuracy,
    wrongRatio,
    recencyDays,
    mastered,
    practiceWeight: Math.max(0.05, Number(weight.toFixed(4)))
  };
}

function buildChoiceBuckets(wordPool) {
  const all = shuffle(wordPool);
  const byTense = new Map();

  for (const item of all) {
    const tenseKey = String(item.tense || "");
    if (!byTense.has(tenseKey)) {
      byTense.set(tenseKey, []);
    }
    byTense.get(tenseKey).push(item);
  }

  return { all, byTense };
}

function buildChoices(mode, word, choiceBuckets) {
  if (mode === "type_en_from_zh" || mode === CLOZE_MODE) {
    return [];
  }

  const answer = buildExpectedAnswer(mode, word, {
    meaning: word.practiceMeaning,
    meaningIndex: word.meaningIndex
  });
  const answerKey = normalizeText(answer).toLowerCase();
  const targetLexemeKey = buildPracticeLexemeKey(word);
  const options = [];
  const optionKeys = new Set([answerKey]);
  const seenItemKey = buildPracticeItemKey(word);

  function appendOptionsFromPool(pool) {
    for (const item of pool || []) {
      if (options.length >= 3) {
        break;
      }

      if (buildPracticeItemKey(item) === seenItemKey) {
        continue;
      }

      if (buildPracticeLexemeKey(item) === targetLexemeKey) {
        continue;
      }

      const value =
        mode === "en_to_zh"
          ? buildExpectedAnswer(mode, item, {
              meaning: item.practiceMeaning,
              meaningIndex: item.meaningIndex
            })
          : item.eng;
      const valueKey = normalizeText(value).toLowerCase();

      if (value && valueKey && !optionKeys.has(valueKey)) {
        options.push(value);
        optionKeys.add(valueKey);
      }
    }
  }

  appendOptionsFromPool(choiceBuckets.byTense.get(String(word.tense || "")));
  if (options.length < 3) {
    appendOptionsFromPool(choiceBuckets.all);
  }

  return shuffle([...options, answer]);
}

function buildQuestionWordPlan(wordPool, totalQuestions, options = {}) {
  if (!wordPool.length || totalQuestions <= 0) {
    return [];
  }

  function pickNextItemIndex(items) {
    if (!items.length) {
      return -1;
    }

    const weighted = items.map((item, index) => {
      const priority = safeNumber(item.meaningPriority, 999);
      const baseWeight = Math.max(0.05, safeNumber(item.practiceWeight, 1));
      const priorityBias = priority <= 0 ? 1.2 : priority === 1 ? 1.08 : 0.92;
      return {
        index,
        weight: Number((baseWeight * priorityBias).toFixed(4))
      };
    });

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) {
      return 0;
    }

    let cursor = Math.random() * totalWeight;
    for (const item of weighted) {
      cursor -= item.weight;
      if (cursor <= 0) {
        return item.index;
      }
    }

    return weighted[weighted.length - 1].index;
  }

  const familyMap = new Map();
  for (const word of wordPool) {
    const familyKey = buildPracticeFamilyKey(word);
    if (!familyMap.has(familyKey)) {
      familyMap.set(familyKey, []);
    }
    familyMap.get(familyKey).push(word);
  }

  const families = [...familyMap.entries()].map(([familyKey, items]) => ({
    familyKey,
    items: shuffle(items)
  }));

  const plan = [];
  let previousFamilyKey = "";

  while (plan.length < totalQuestions) {
    const roundFamilies = shuffle(families.filter((family) => family.items.length)).sort((a, b) => {
        const weightDelta =
          safeNumber(b.items[0]?.practiceWeight, 1) - safeNumber(a.items[0]?.practiceWeight, 1);
        if (weightDelta !== 0) return weightDelta;

        const priorityDelta =
          safeNumber(a.items[0]?.meaningPriority, 999) - safeNumber(b.items[0]?.meaningPriority, 999);
        if (priorityDelta !== 0) return priorityDelta;

        return 0;
      });

    if (!roundFamilies.length) {
      break;
    }

    const orderedFamilies = previousFamilyKey
      ? [
          ...roundFamilies.filter((family) => family.familyKey !== previousFamilyKey),
          ...roundFamilies.filter((family) => family.familyKey === previousFamilyKey)
        ]
      : roundFamilies;

    let pickedInRound = false;
    for (const family of orderedFamilies) {
      if (plan.length >= totalQuestions) {
        break;
      }

      const nextIndex = pickNextItemIndex(family.items);
      const [nextWord] = nextIndex >= 0 ? family.items.splice(nextIndex, 1) : [];
      if (!nextWord) {
        continue;
      }

      plan.push(nextWord);
      previousFamilyKey = family.familyKey;
      pickedInRound = true;
    }

    if (!pickedInRound) {
      break;
    }
  }

  return plan;
}

function spreadQuestionPlan(words) {
  if (words.length <= 1) {
    return words;
  }

  const familyMap = new Map();
  for (const word of words) {
    const familyKey = buildPracticeFamilyKey(word);
    if (!familyMap.has(familyKey)) {
      familyMap.set(familyKey, []);
    }
    familyMap.get(familyKey).push(word);
  }

  const result = [];
  let previousFamilyKey = "";

  while (result.length < words.length) {
    const candidates = [...familyMap.entries()]
      .filter(([, items]) => items.length)
      .map(([familyKey, items]) => ({ familyKey, items }))
      .sort((a, b) => {
        if (a.familyKey === previousFamilyKey && b.familyKey !== previousFamilyKey) return 1;
        if (b.familyKey === previousFamilyKey && a.familyKey !== previousFamilyKey) return -1;

        const countDelta = b.items.length - a.items.length;
        if (countDelta !== 0) return countDelta;

        const weightDelta =
          safeNumber(b.items[0]?.practiceWeight, 1) - safeNumber(a.items[0]?.practiceWeight, 1);
        if (weightDelta !== 0) return weightDelta;

        const priorityDelta =
          safeNumber(a.items[0]?.meaningPriority, 999) -
          safeNumber(b.items[0]?.meaningPriority, 999);
        if (priorityDelta !== 0) return priorityDelta;

        return a.familyKey.localeCompare(b.familyKey);
      });

    if (!candidates.length) {
      break;
    }

    const nextFamily = candidates[0];
    const nextWord = nextFamily.items.shift();
    if (!nextWord) {
      break;
    }

    result.push(nextWord);
    previousFamilyKey = nextFamily.familyKey;
  }

  return result.length === words.length ? result : words;
}

async function loadExamMeaningMap(wordRefs) {
  const uniqueRefs = [...new Set((wordRefs || []).filter(Boolean))];
  if (!uniqueRefs.length) {
    return new Map();
  }

  const rows = await wordsDb.all(
    `SELECT
       word_ref AS wordRef,
       meaning_index AS meaningIndex,
       meaning_text AS meaningText
     FROM unit_exam_meanings
     WHERE word_ref IN (${uniqueRefs.map(() => "?").join(",")})
     ORDER BY word_ref, meaning_index`,
    uniqueRefs
  );

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.wordRef)) {
      map.set(row.wordRef, { indexes: [], texts: [] });
    }
    const target = map.get(row.wordRef);
    target.indexes.push(Number(row.meaningIndex));
    target.texts.push(row.meaningText);
  }

  return map;
}

function buildPracticeScopeFilters(query) {
  const { sourceId, unitId, unitIds } = query;
  const filters = [];
  const params = [];

  if (sourceId) {
    filters.push("s.id = ?");
    params.push(sourceId);
  }

  if (unitIds) {
    const ids = String(unitIds)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (ids.length) {
      filters.push(`u.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  } else if (unitId) {
    filters.push("u.id = ?");
    params.push(unitId);
  }

  return {
    whereClause: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params
  };
}

async function loadScopedPracticeWords(query) {
  const { whereClause, params } = buildPracticeScopeFilters(query);
  const rawWords = await wordsDb.all(
    `SELECT
       w.id,
       w.word_ref,
       w.eng,
       w.kk,
       w.tense,
       w.ch,
       w.analysis,
       w.definition,
       w.example,
       u.id AS unit_id,
       u.name AS unit_name,
       s.name AS source_name
     FROM words w
     JOIN units u ON u.id = w.unit_id
     JOIN sources s ON s.id = u.source_id
     ${whereClause}`,
    params
  );

  const examMeaningMap = await loadExamMeaningMap(rawWords.map((word) => word.word_ref));
  const wordsWithExamScope = rawWords.map((word) => ({
    ...word,
    examMeaningIndexes: examMeaningMap.get(word.word_ref)?.indexes || [],
    examMeaningTexts: examMeaningMap.get(word.word_ref)?.texts || []
  }));

  return dedupePracticeWords(wordsWithExamScope);
}

router.get("/availability", requireAuth, async (req, res, next) => {
  try {
    const meaningScope = req.query.meaningScope === "exam_only" ? "exam_only" : "all_meanings";
    const words = await loadScopedPracticeWords(req.query);
    const allMeaningItems = expandPracticeItems(words, { meaningScope: "all_meanings" });
    const examOnlyItems = expandPracticeItems(words, { meaningScope: "exam_only" });
    const [clozeAllItems, clozeExamItems] = await Promise.all([
      buildClozePracticeItems(words, { meaningScope: "all_meanings" }),
      buildClozePracticeItems(words, { meaningScope: "exam_only" })
    ]);
    const normalCount = meaningScope === "exam_only" ? examOnlyItems.length : allMeaningItems.length;
    const clozeCount = meaningScope === "exam_only" ? clozeExamItems.length : clozeAllItems.length;

    res.json({
      wordCount: words.length,
      allMeaningCount: allMeaningItems.length,
      examMeaningCount: examOnlyItems.length,
      examWordCount: words.filter((word) => (word.examMeaningIndexes || []).length > 0).length,
      hasExamMeanings: examOnlyItems.length > 0,
      clozeCount,
      clozeAllCount: clozeAllItems.length,
      clozeExamCount: clozeExamItems.length,
      modeAvailability: {
        zh_to_en: normalCount,
        en_to_zh: normalCount,
        type_en_from_zh: normalCount,
        cloze_en: clozeCount
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/session", requireAuth, async (req, res, next) => {
  try {
    const { sourceId, unitId, unitIds, limit = 20, modeWeights } = req.query;
    const meaningScope = req.query.meaningScope === "exam_only" ? "exam_only" : "all_meanings";
    const requestedLimit = parseInt(limit, 10) || 20;
    const selectedModes = parseSelectedModes(req.query);
    const isClozeSession = selectedModes.includes(CLOZE_MODE);
    if (isClozeSession && selectedModes.length > 1) {
      return res.status(400).json({ message: "克漏字模式需獨立開始，不能與一般題型混合。" });
    }

    const weightedModes = parseModeWeights(modeWeights, selectedModes);
    const selectedUnitIds = parseSelectedUnitIds(req.query);
    const words = await loadScopedPracticeWords(req.query);

    if (!words.length) {
      res.json({ questions: [] });
      return;
    }

    const scopedWordRefs = [...new Set(words.flatMap((word) => word.wordRefs || [word.word_ref]).filter(Boolean))];
    const masteryRows = scopedWordRefs.length
      ? await clientDb.all(
          `SELECT
             word_ref AS wordRef,
             attempts,
             correct_count AS correctCount,
             wrong_count AS wrongCount,
             streak,
             last_answered_at AS lastAnsweredAt
           FROM mastery_stats
           WHERE user_id = ?
             AND word_ref IN (${scopedWordRefs.map(() => "?").join(",")})`,
          [req.user.id, ...scopedWordRefs]
        )
      : [];
    const masteryMap = new Map(masteryRows.map((row) => [row.wordRef, row]));

    const totalUnitsRow = sourceId
      ? await wordsDb.get("SELECT COUNT(*) AS totalUnits FROM units WHERE source_id = ?", [sourceId])
      : await wordsDb.get("SELECT COUNT(*) AS totalUnits FROM units");
    const totalUnits = safeNumber(totalUnitsRow?.totalUnits);
    const selectedUnitCount = unitId ? 1 : selectedUnitIds.length;
    const isFullScopeSelection =
      (!unitId && !selectedUnitIds.length) ||
      (totalUnits > 0 && selectedUnitCount >= totalUnits);

    let preferFocusedReview = false;
    if ((unitId || selectedUnitIds.length) && !isFullScopeSelection) {
      preferFocusedReview = true;
    }

    const practiceItems = isClozeSession
      ? await buildClozePracticeItems(words, { meaningScope })
      : expandPracticeItems(words, { meaningScope });
    const availableQuestionCount = practiceItems.length;

    if (!availableQuestionCount) {
      res.json({ questions: [] });
      return;
    }

    if (requestedLimit > availableQuestionCount) {
      return res.status(400).json({
        message: `目前最多可出 ${availableQuestionCount} 題，請降低題數。`
      });
    }

    if (!isClozeSession && availableQuestionCount >= 10 && requestedLimit < 10) {
      return res.status(400).json({
        message: "題數至少需要 10 題。"
      });
    }

    const finalLimit =
      !isClozeSession && availableQuestionCount >= 10
        ? Math.max(requestedLimit, 10)
        : Math.max(1, requestedLimit);
    const profiledWords = practiceItems.map((word) =>
      buildPracticeProfile(word, masteryMap.get(word.word_ref), { preferFocusedReview })
    );

    const wordPool = profiledWords;
    const choiceBuckets = buildChoiceBuckets(profiledWords);
    const effectiveLimit = isFullScopeSelection && !isClozeSession ? wordPool.length : finalLimit;
    const modeQueue = buildModeQueue(weightedModes, effectiveLimit);
    const questionWords = spreadQuestionPlan(
      buildQuestionWordPlan(wordPool, effectiveLimit, {
        preferFocusedReview,
        uniqueOnly: isFullScopeSelection
      })
    );
    const questions = [];

    for (let index = 0; index < questionWords.length; index += 1) {
      const word = questionWords[index];
      const mode = modeQueue[index] || pickWeightedMode(weightedModes);
      questions.push({
        wordId: word.id,
        wordRef: word.word_ref,
        mode,
        questionType: mode === "type_en_from_zh" || mode === CLOZE_MODE ? "typing" : "choice",
        prompt:
          mode === CLOZE_MODE
            ? word.clozeSentence
            : buildPracticePrompt(mode, word, {
                meaning: word.practiceMeaning,
                meaningIndex: word.meaningIndex
              }),
        expectedAnswer:
          mode === CLOZE_MODE
            ? word.clozeAnswer
            : buildExpectedAnswer(mode, word, {
                meaning: word.practiceMeaning,
                meaningIndex: word.meaningIndex
              }),
        choices: buildChoices(mode, word, choiceBuckets),
        clozeSentence: word.clozeSentence || "",
        clozeAnswer: word.clozeAnswer || "",
        exampleTranslation: word.exampleTranslation || "",
        reference: {
          eng: word.eng,
          kk: word.kk,
          tense: word.tense,
          ch: word.ch,
          chEntries: parseMeaningEntries(word.ch),
          practiceMeaning: word.practiceMeaning,
          analysis: word.analysis,
          definition: word.definition,
          example: word.example,
          exampleTranslation: word.exampleTranslation || "",
          sourceName: (word.sourceNames || []).join("、") || word.source_name,
          unitName: (word.unitNames || []).join("、") || word.unit_name
        },
        learningMeta: {
          attempts: word.attempts,
          accuracy: Number((word.accuracy * 100).toFixed(1)),
          mastered: word.mastered
        }
      });
    }

    res.json({ questions });
  } catch (error) {
    next(error);
  }
});

router.post("/submit", requireAuth, async (req, res, next) => {
  try {
    const { mode, sessionModes = [], answers = [] } = req.body;
    let correctAnswers = 0;
    const results = [];

    for (const [questionIndex, item] of answers.entries()) {
      const answerMode = ALLOWED_MODES.has(item.mode) ? item.mode : mode || "zh_to_en";
      const currentWord =
        (item.wordRef &&
          (await wordsDb.get(
            `SELECT
               w.id,
               w.word_ref,
               w.eng,
               w.ch,
               u.name AS unit_name,
               s.name AS source_name
             FROM words w
             JOIN units u ON u.id = w.unit_id
             JOIN sources s ON s.id = u.source_id
             WHERE w.word_ref = ?`,
            [item.wordRef]
          ))) ||
        null;

      const wordRef = item.wordRef || currentWord?.word_ref;
      if (!wordRef) {
        continue;
      }

      const expectedAnswer =
        answerMode === CLOZE_MODE
          ? normalizeText(item.expectedAnswer || item.clozeAnswer || "")
          : answerMode === "en_to_zh"
          ? normalizeText(item.reference?.practiceMeaning || item.expectedAnswer || currentWord?.ch || "")
          : currentWord
            ? buildExpectedAnswer(answerMode, currentWord)
            : normalizeText(item.expectedAnswer || item.reference?.eng);
      const answer = normalizeText(item.answer);
      const correct = isAnswerCorrect(answerMode, answer, expectedAnswer);

      if (correct) {
        correctAnswers += 1;
      }

      const snapshot = {
        wordId: currentWord?.id || null,
        eng: currentWord?.eng || item.reference?.eng || "",
        ch: currentWord?.ch || item.reference?.ch || "",
        sourceName: currentWord?.source_name || item.reference?.sourceName || "",
        unitName: currentWord?.unit_name || item.reference?.unitName || ""
      };

      await clientDb.run(
        `INSERT INTO study_logs
           (user_id, word_ref, word_id, mode, user_answer, is_correct, source_name, unit_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          wordRef,
          snapshot.wordId,
          answerMode,
          answer,
          correct ? 1 : 0,
          snapshot.sourceName,
          snapshot.unitName
        ]
      );

      const previous = await clientDb.get(
        "SELECT streak FROM mastery_stats WHERE user_id = ? AND word_ref = ?",
        [req.user.id, wordRef]
      );
      const nextStreak = correct ? (previous?.streak || 0) + 1 : 0;

      await clientDb.run(
        `INSERT INTO mastery_stats
           (user_id, word_ref, word_id, source_name, unit_name, attempts, correct_count, wrong_count, last_mode, last_result, streak, last_answered_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, word_ref) DO UPDATE SET
           word_id = excluded.word_id,
           source_name = excluded.source_name,
           unit_name = excluded.unit_name,
           attempts = mastery_stats.attempts + 1,
           correct_count = mastery_stats.correct_count + excluded.correct_count,
           wrong_count = mastery_stats.wrong_count + excluded.wrong_count,
           last_mode = excluded.last_mode,
           last_result = excluded.last_result,
           streak = excluded.streak,
           last_answered_at = CURRENT_TIMESTAMP`,
        [
          req.user.id,
          wordRef,
          snapshot.wordId,
          snapshot.sourceName,
          snapshot.unitName,
          correct ? 1 : 0,
          correct ? 0 : 1,
          answerMode,
          correct ? 1 : 0,
          nextStreak
        ]
      );

      results.push({
        questionIndex,
        wordRef,
        wordId: snapshot.wordId,
        mode: answerMode,
        correct,
        expectedAnswer
      });
    }

    const sessionModeValue = Array.isArray(sessionModes) && sessionModes.length
      ? sessionModes.join(",")
      : mode || "mixed";

    await serverDb.run(
      `INSERT INTO practice_sessions (user_id, mode, total_questions, correct_answers)
       VALUES (?, ?, ?, ?)`,
      [req.user.id, sessionModeValue, answers.length, correctAnswers]
    );

    res.json({
      totalQuestions: answers.length,
      correctAnswers,
      accuracy: answers.length ? Number(((correctAnswers / answers.length) * 100).toFixed(1)) : 0,
      results
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
