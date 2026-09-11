const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the browser's actual selection code without bootstrapping the page or DB.
const source = fs.readFileSync(path.join(__dirname, "../public/shared.js"), "utf8");
const constants = source.slice(source.indexOf("  const TTS_PREFERRED_ENGLISH_LOCALES"),
  source.indexOf("  const TTS_PRONUNCIATION_FETCH_TIMEOUT_MS"));
const selection = source.slice(source.indexOf("  function countVoiceHintMatches"),
  source.indexOf("  function getSpeechPitch"));

function picker(voices) {
  const context = vm.createContext({
    ttsState: {},
    ensureSpeechVoices: async () => voices
  });
  vm.runInContext(constants + selection, context);
  return () => context.pickSpeechVoice();
}

function appleVoice(name, compact = false) {
  return { name, lang: "en-US", localService: true, default: false,
    voiceURI: `com.apple.voice.${compact ? "compact" : "legacy"}.en-US.${name}` };
}

test("fallback avoids novelty voices even when marked as the system default", async () => {
  const samantha = appleVoice("Samantha", true);
  for (const name of ["Albert", "Bahh", "Bubbles", "Wobble", "Zarvox"]) {
    const novelty = { ...appleVoice(name), default: true };
    const pick = picker([novelty, samantha]);
    assert.equal(await pick(), samantha, name);
    assert.equal(await pick(), samantha, `${name}: cached selection`);
  }
});

test("fallback leaves selection to the browser when no acceptable voice is available", async () => {
  assert.equal(await picker([appleVoice("Zarvox")])(), null);
  assert.equal(await picker([])(), null);
});
