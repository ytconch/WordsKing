function normalizeText(value) {
  return (value || "").toString().trim();
}

function normalizeExample(value) {
  return normalizeText(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeEnglish(value) {
  return normalizeText(value).replace(/\s+/g, " ").toLowerCase();
}

function slugify(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "item";
}

function buildWordRef({ sourceName, unitName, eng, tense }) {
  const parts = [slugify(sourceName), slugify(unitName), slugify(normalizeEnglish(eng))];

  if (normalizeText(tense)) {
    parts.push(slugify(tense));
  }

  return parts.join("::");
}

function stripPracticeParentheses(value) {
  return normalizeText(value)
    .replace(/\uFF08[^\uFF08\uFF09]*\uFF09/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildPracticeMarker(index) {
  return index < 20 ? String.fromCharCode(9312 + index) : `${index + 1}.`;
}

function cleanMeaningEntry(value) {
  return stripPracticeParentheses(value)
    .replace(/^\s*[\[\]'"]+/, "")
    .replace(/[\[\]'"]+\s*$/g, "")
    .replace(/^[\u2460-\u2473]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/[\uFF1B;\u3002]+$/g, "")
    .trim();
}

function splitMeaningFragments(value) {
  return String(value || "")
    .split(/\n+|[\uFF1B;\u3002]/)
    .map((item) => cleanMeaningEntry(item))
    .filter(Boolean);
}

function flattenMeaningEntries(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenMeaningEntries(item));
  }

  return [String(value)];
}

function tryParseBracketMeaningString(text) {
  if (!/^\s*\[\s*\[/.test(text)) {
    return null;
  }

  try {
    const normalized = text.replace(/'/g, '"');
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMeaningEntries(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return [...new Set(flattenMeaningEntries(value).flatMap((item) => splitMeaningFragments(item)))];
  }

  const text = normalizeText(value);
  if (!text) {
    return [];
  }

  const bracketParsed = tryParseBracketMeaningString(text);
  if (Array.isArray(bracketParsed)) {
    return [...new Set(flattenMeaningEntries(bracketParsed).flatMap((item) => splitMeaningFragments(item)))];
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parseMeaningEntries(parsed);
    }
  } catch {}

  const quotedMatches = Array.from(text.matchAll(/["']([^"'\r\n]+)["']/g))
    .flatMap((match) => splitMeaningFragments(match[1]))
    .filter(Boolean);
  if (quotedMatches.length) {
    return [...new Set(quotedMatches)];
  }

  if (/[\u2460-\u2473]/.test(text)) {
    return [
      ...new Set(
        text
          .split(/(?=[\u2460-\u2473])/)
          .flatMap((item) => splitMeaningFragments(item))
          .filter(Boolean)
      )
    ];
  }

  return [...new Set(splitMeaningFragments(text))];
}

function sanitizeMeaningIndexes(indexes, maxLength) {
  if (!Array.isArray(indexes) || maxLength <= 0) {
    return [];
  }

  return [...new Set(
    indexes
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0 && item < maxLength)
  )];
}

function getCoreMeaningIndexes(entries, maxItems = 2) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }

  return entries.slice(0, Math.max(1, maxItems)).map((_, index) => index);
}

function getWordParsedMeanings(word) {
  if (Array.isArray(word?._parsedMeanings)) {
    return word._parsedMeanings;
  }
  const parsed = parseMeaningEntries(word?.ch || word?.definition || "");
  if (word && typeof word === "object") {
    word._parsedMeanings = parsed;
  }
  return parsed;
}

function buildStarKey(eng, tense) {
  return `${normalizeEnglish(eng)}::${normalizeText(tense).toLowerCase()}`;
}

function splitPracticeMeaning(value) {
  const entries = parseMeaningEntries(value);
  if (!entries.length) {
    return [];
  }

  if (entries.length === 1) {
    return entries;
  }

  return entries.map((item, index) => `${buildPracticeMarker(index)} ${item}`);
}

function buildPracticeDisplayText(value, options = {}) {
  const { maxItems = 3 } = options;
  const lines = splitPracticeMeaning(value);

  if (!lines.length) {
    return stripPracticeParentheses(value) || normalizeText(value);
  }

  return lines.slice(0, maxItems).join("\n");
}

function pickPracticeMeaning(word, preferredIndex = 0) {
  const entries = getWordParsedMeanings(word);
  if (!entries.length) {
    return stripPracticeParentheses(word?.ch || word?.definition || "");
  }

  const safeIndex = Math.max(0, Number(preferredIndex) || 0);
  return entries[safeIndex % entries.length];
}

function buildPracticePrompt(mode, word, options = {}) {
  if (mode === "zh_to_en" || mode === "type_en_from_zh") {
    return normalizeText(options.meaning || pickPracticeMeaning(word, options.meaningIndex));
  }

  return word.eng;
}

function buildExpectedAnswer(mode, word, options = {}) {
  if (mode === "en_to_zh") {
    return normalizeText(options.meaning || pickPracticeMeaning(word, options.meaningIndex));
  }

  return word.eng;
}

function isAnswerCorrect(mode, answer, expectedAnswer) {
  const cleanAnswer = normalizeText(answer).toLowerCase();
  const cleanExpected = normalizeText(expectedAnswer).toLowerCase();

  if (!cleanAnswer || !cleanExpected) {
    return false;
  }

  if (mode === "en_to_zh") {
    return cleanExpected.includes(cleanAnswer) || cleanAnswer.includes(cleanExpected);
  }

  return cleanAnswer === cleanExpected;
}

module.exports = {
  normalizeText,
  normalizeExample,
  normalizeEnglish,
  slugify,
  buildWordRef,
  buildStarKey,
  stripPracticeParentheses,
  cleanMeaningEntry,
  parseMeaningEntries,
  getWordParsedMeanings,
  getCoreMeaningIndexes,
  pickPracticeMeaning,
  splitPracticeMeaning,
  buildPracticeDisplayText,
  buildPracticePrompt,
  buildExpectedAnswer,
  isAnswerCorrect
};

