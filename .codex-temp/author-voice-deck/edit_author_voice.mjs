import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const ROOT = "C:/Users/ytcon/server/server/WordsKingServer";
const BUILD = `${ROOT}/.codex-temp/author-voice-deck`;
const STARTER = `${BUILD}/template-starter.pptx`;
const OUTPUT = `${ROOT}/deliverables/Words_King_特殊選才專案報告_詹秉睿_作者口吻優化版.pptx`;
const PREVIEW = `${BUILD}/final-preview`;
const LAYOUT = `${BUILD}/final-layout`;

const updates = {
  2: {
    "subtitle-2": "起點是一個反覆出現的學習摩擦。",
  },
  3: {
    "subtitle-3": "我先建立理解、練習與追蹤三步循環，再逐步補齊功能。",
    "hypothesis-guardrail": "每次作答都會留下紀錄，支援錯題整理與熟練度追蹤。",
  },
  4: {
    "subtitle-4": "三個核心畫面串起理解、練習與追蹤。",
  },
  5: {
    "title-5": "我在四個月內把原型做成公開服務",
    "subtitle-5": "我以實際使用為目標，依序完成核心功能、內容匯入與公開部署。",
    "timeline-title-0": "開始開發",
    "timeline-desc-0": "完成專案骨架",
    "timeline-title-1": "第一版可用",
    "timeline-desc-1": "開始累積練習紀錄",
    "timeline-title-2": "AI 匯入",
    "timeline-desc-2": "建立內容處理管線",
    "timeline-title-3": "公開部署",
    "timeline-desc-3": "同學可透過網路使用",
    "timeline-title-4": "持續維運",
    "timeline-desc-4": "持續補充內容與功能",
    "timeline-evidence": "● 功能逐步完成",
    "timeline-inference": "● 開始真實使用",
    "timeline-note": "我透過實際使用與自行測試\n持續推動下一輪迭代。",
  },
  6: {
    "title-6": "我把學習流程做成可持續運作的完整系統",
    "subtitle-6": "從使用者操作到資料留存、內容匯入與維運，我必須同時處理多個責任邊界。",
    "architecture-conclusion": "我將資料、權限、錯誤處理與使用流程整合在同一套服務中。",
  },
  7: {
    "title-7": "品質控制讓 AI 內容能進入真實系統",
    "subtitle-7": "發現單次生成會留下錯誤後，我把流程改成三階段審查。",
  },
  8: {
    "title-8": "Words King 已累積真實使用紀錄",
    "subtitle-8": "內容規模與作答資料，讓我能觀察系統運作並持續調整功能。",
    "metric-learners-caption": "位產生作答紀錄者\n已留下實際學習資料",
    "evidence-strip-note": "截至 2026/08/15",
    "evidence-guardrail": "這些紀錄協助我定位錯題、調整內容，並規劃下一版功能。",
  },
  9: {
    "title-9": "錯誤成為下一版設計的起點",
    "subtitle-9": "同學回報與自行測試讓我找到問題，再把修正納入系統流程。",
    "iteration-conclusion": "我為錯誤建立發現、阻擋與修正的完整路徑。",
  },
  10: {
    "title-10": "我的成長：從寫程式到做系統決策",
    "subtitle-10": "我開始能把模糊需求轉成可被驗收的系統決策。",
  },
  11: {
    "subtitle-11": "附錄整理完整系統範圍，呈現各模組如何分工。",
  },
  12: {
    "subtitle-12": "這些測試聚焦在模型最常出現、也最容易污染資料庫的輸出差異。",
    "test-count-caption": "2026/08/15\n26 項測試全部通過",
  },
  13: {
    "title-13": "五項工程決策支撐系統持續運作",
    "subtitle-13": "我依照使用情境選擇技術，讓功能、資料與維運彼此配合。",
    "ledger-head-0": "面向",
    "ledger-head-1": "我的選擇",
    "ledger-head-2": "技術組合",
    "ledger-head-3": "目的",
    "ledger-0-0": "帳號與權限",
    "ledger-0-1": "依角色控管功能",
    "ledger-0-2": "JWT／中介層",
    "ledger-0-3": "區分學生與管理功能",
    "ledger-1-0": "學習資料",
    "ledger-1-1": "三個資料庫分工",
    "ledger-1-2": "SQLite 三庫",
    "ledger-1-3": "降低耦合並保留作答紀錄",
    "ledger-2-0": "內容匯入",
    "ledger-2-1": "辨識後進入三階段審查",
    "ledger-2-2": "OCR／Gemini",
    "ledger-2-3": "提高建庫效率並阻擋錯誤",
    "ledger-3-0": "發音服務",
    "ledger-3-1": "字典音源優先，TTS 備援",
    "ledger-3-2": "快取／fallback",
    "ledger-3-3": "兼顧正確性與可用性",
    "ledger-4-0": "公開部署",
    "ledger-4-1": "將服務連上公開網域",
    "ledger-4-2": "HTTPS／DuckDNS",
    "ledger-4-3": "讓同學能直接使用與回饋",
  },
  14: {
    "title-14": "我在專案中負責的核心工作",
    "subtitle-14": "我從問題定義開始，持續做出系統規格、品質與迭代決策。",
    "human-kicker": "產品與需求",
    "human-title": "把學習痛點轉成系統規格",
    "human-items": "• 觀察單字學習情境\n• 設計理解、練習、追蹤流程\n• 拆解需求並安排優先順序\n• 根據使用情況持續調整",
    "agent-kicker": "品質與維運",
    "agent-title": "讓每次改動都能被測試與驗收",
    "agent-items": "• 設定資料格式與錯誤規則\n• 測試主要功能與異常情境\n• 檢查 AI 內容並要求修正\n• 維護公開服務與學習資料",
    "ai-disclosure-close": "這個專案讓我從完成功能，進一步學會對整體系統負責。",
  },
  15: {
    "title-15": "公開服務與展示資料的隱私保護",
    "subtitle-15": "服務可由網路連線；展示時，我只使用去識別化畫面。",
    "privacy-title": "我的展示原則",
    "privacy-items": "• 使用獨立的展示資料副本\n• 將帳號與顯示名稱改為示範名稱\n• 不呈現同學帳號、IP 與復原資料\n• 不在正式服務上修改資料",
    "data-defs": "公開服務已累積 38 位造訪者、13 位作答者與 10,011 筆作答紀錄。",
  },
};

const notes = [
  ["本專案識別與申請人資料。"],
  ["Merriam-Webster — https://www.merriam-webster.com/dictionary/distribute", "Oxford Advanced Learner's Dictionary — https://www.oxfordlearnersdictionaries.com/definition/english/distribute", "本專案開發動機。"],
  ["本專案功能流程與資料結構。"],
  ["本專案展示畫面。"],
  ["本專案開發紀錄。"],
  ["本專案原始碼：server.js、src/routes、src/db、src/middleware、src/utils、public。"],
  ["本專案 AI 匯入流程：scripts/image_word_pipeline.py、src/routes/import.js。"],
  ["本專案資料庫統計，2026/08/15。"],
  ["本專案發音服務與內容審查功能。"],
  ["本專案學習反思、公開服務與未來規劃。", "https://words.ytconch.duckdns.org/"],
  ["本專案公開頁面與後端路由。"],
  ["測試命令：python -m unittest tests.test_image_word_pipeline；2026/08/15 共 26 項通過。"],
  ["本專案原始碼、資料庫分工與部署架構。"],
  ["本專案需求、測試與維運紀錄。"],
  ["公開服務：https://words.ytconch.duckdns.org/", "本專案展示用去識別化畫面。"],
];

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function layoutFor(slideNumber) {
  const padded = String(slideNumber).padStart(2, "0");
  return JSON.parse(await fs.readFile(`${BUILD}/template-starter-layout/starter-slide-${padded}.layout.json`, "utf8"));
}

const presentation = await PresentationFile.importPptx(await FileBlob.load(STARTER));
await fs.mkdir(PREVIEW, { recursive: true });
await fs.mkdir(LAYOUT, { recursive: true });

for (const [slideKey, slideUpdates] of Object.entries(updates)) {
  const slideNumber = Number(slideKey);
  const layout = await layoutFor(slideNumber);
  const slide = presentation.slides.items[slideNumber - 1];
  for (const [name, nextText] of Object.entries(slideUpdates)) {
    const element = layout.elements.find((item) => item.name === name);
    const target = slide.elements.items.find((item) => item.type === "shape" && item.name === name);
    if (!target || typeof element?.text !== "string") throw new Error(`Missing editable text ${slideNumber}:${name}`);
    if (nextText.includes("\n")) target.text.set(nextText);
    else target.text.replace(element.text, nextText);
  }
}

for (let index = 0; index < presentation.slides.items.length; index += 1) {
  const slide = presentation.slides.items[index];
  slide.speakerNotes.textFrame.setText(`[Sources]\n${notes[index].map((item) => `- ${item}`).join("\n")}`);
  const padded = String(index + 1).padStart(2, "0");
  await writeBlob(`${PREVIEW}/slide-${padded}.png`, await presentation.export({ slide, format: "png", scale: 1 }));
  await fs.writeFile(`${LAYOUT}/slide-${padded}.layout.json`, await (await slide.export({ format: "layout" })).text());
}

await writeBlob(`${BUILD}/final-montage.webp`, await presentation.export({ format: "webp", montage: true, scale: 1 }));
const snapshot = await presentation.inspect({ kind: "slide,textbox,shape,image,notes,layout", maxChars: 120000 });
await fs.writeFile(`${BUILD}/final-inspect.ndjson`, snapshot.ndjson, "utf8");
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(OUTPUT);
console.log(JSON.stringify({ output: OUTPUT, slides: presentation.slides.items.length }));
