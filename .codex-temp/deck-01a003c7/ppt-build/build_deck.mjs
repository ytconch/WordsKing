import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "C:/Users/ytcon/server/server/WordsKingServer";
const BUILD = `${ROOT}/.codex-temp/deck-01a003c7/ppt-build`;
const ASSETS = `${ROOT}/.codex-temp/deck-01a003c7/deck-assets`;
const OUTPUT = `${ROOT}/deliverables/Words_King_特殊選才專案報告_詹秉睿.pptx`;
const PREVIEW = `${BUILD}/preview`;

const W = 1280;
const H = 720;
const FONT = "Microsoft JhengHei";
const COLORS = {
  paper: "#F6F8F2",
  paper2: "#EEF3E8",
  white: "#FFFFFF",
  ink: "#1F2D25",
  muted: "#5D6B62",
  forest: "#315F45",
  forest2: "#427456",
  sage: "#7C9D63",
  sageLight: "#DDE9D4",
  navy: "#102B4E",
  navyLight: "#DDE7F2",
  gold: "#D4A94E",
  orange: "#C8753A",
  line: "#CBD6C7",
  red: "#A84B3D",
};

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

async function readBytes(filePath) {
  const bytes = await fs.readFile(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function rect(slide, name, left, top, width, height, fill, radius = 0, line = "none") {
  return slide.shapes.add({
    geometry: radius ? "roundRect" : "rect",
    name,
    position: { left, top, width, height },
    fill,
    line: line === "none"
      ? { style: "solid", fill: "none", width: 0 }
      : { style: "solid", fill: line, width: 1 },
    ...(radius ? { borderRadius: radius } : {}),
  });
}

function line(slide, name, left, top, width, height, color = COLORS.line, weight = 2) {
  return slide.shapes.add({
    geometry: "line",
    name,
    position: { left, top, width, height },
    fill: "none",
    line: { style: "solid", fill: color, width: weight },
  });
}

function text(slide, name, value, left, top, width, height, opts = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name,
    position: { left, top, width, height },
    fill: opts.fill ?? "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    typeface: opts.typeface ?? FONT,
    fontSize: opts.size ?? 24,
    bold: opts.bold ?? false,
    color: opts.color ?? COLORS.ink,
    alignment: opts.align ?? "left",
    verticalAlignment: opts.valign ?? "top",
    lineSpacing: opts.lineSpacing ?? 1.12,
    autoFit: "none",
    insets: opts.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function baseSlide(section, slideNo, titleValue, subtitleValue = "") {
  const slide = presentation.slides.add();
  slide.background.fill = COLORS.paper;
  rect(slide, `top-rule-${slideNo}`, 0, 0, W, 10, COLORS.forest);
  text(slide, `section-${slideNo}`, section.toUpperCase(), 72, 38, 360, 24, {
    size: 15, bold: true, color: COLORS.forest, lineSpacing: 1,
  });
  text(slide, `title-${slideNo}`, titleValue, 72, 72, 1136, 62, {
    size: 43, bold: true, color: COLORS.ink, lineSpacing: 1,
  });
  if (subtitleValue) {
    text(slide, `subtitle-${slideNo}`, subtitleValue, 72, 132, 1136, 32, {
      size: 20, color: COLORS.muted, lineSpacing: 1,
    });
  }
  text(slide, `footer-brand-${slideNo}`, "WORDS KING · 詹秉睿", 72, 686, 360, 18, {
    size: 13, bold: true, color: COLORS.muted, lineSpacing: 1,
  });
  text(slide, `footer-page-${slideNo}`, String(slideNo).padStart(2, "0"), 1170, 686, 38, 18, {
    size: 13, bold: true, color: COLORS.muted, align: "right", lineSpacing: 1,
  });
  return slide;
}

function setNotes(slide, items) {
  slide.speakerNotes.textFrame.setText(`[Sources]\n${items.map((x) => `- ${x}`).join("\n")}`);
}

function label(slide, name, value, left, top, width, fill = COLORS.sageLight, color = COLORS.forest) {
  rect(slide, `${name}-bg`, left, top, width, 30, fill, 15);
  text(slide, name, value, left, top + 4, width, 22, {
    size: 15, bold: true, color, align: "center", lineSpacing: 1,
  });
}

function metric(slide, name, value, caption, left, top, width, color = COLORS.forest) {
  text(slide, `${name}-value`, value, left, top, width, 62, {
    size: 48, bold: true, color, lineSpacing: 1,
  });
  line(slide, `${name}-line`, left, top + 66, width, 0, COLORS.line, 1);
  text(slide, `${name}-caption`, caption, left, top + 78, width, 52, {
    size: 18, color: COLORS.muted, lineSpacing: 1.2,
  });
}

function image(slide, name, bytes, alt, left, top, width, height, fit = "contain") {
  return slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit,
    geometry: "roundRect",
    borderRadius: 16,
    position: { left, top, width, height },
    name,
  });
}

const logo = await readBytes(`${ROOT}/public/wordking-icon-512.png`);
const publicLogin = await readBytes(`${ASSETS}/public-login.png`);
const wordsShot = await readBytes(`${ASSETS}/student-words.png`);
const practiceShot = await readBytes(`${ASSETS}/student-practice.png`);
const analyticsShot = await readBytes(`${ASSETS}/student-analytics.png`);
const adminShot = await readBytes(`${ASSETS}/admin-overview.png`);

// 01 — Cover
{
  const slide = presentation.slides.add();
  slide.background.fill = COLORS.paper;
  rect(slide, "cover-left-panel", 0, 0, 430, H, COLORS.navy);
  rect(slide, "cover-gold-rule", 72, 86, 64, 8, COLORS.gold, 4);
  slide.images.add({
    blob: logo,
    contentType: "image/png",
    alt: "Words King 皇冠標誌",
    fit: "contain",
    position: { left: 88, top: 132, width: 170, height: 170 },
  });
  text(slide, "cover-brand", "WORDS KING", 84, 332, 290, 46, {
    size: 29, bold: true, color: COLORS.white, lineSpacing: 1,
  });
  text(slide, "cover-tag", "特殊選才 · 專案作品報告", 84, 386, 290, 34, {
    size: 18, color: "#DCE5EE", lineSpacing: 1,
  });
  text(slide, "cover-title", "把詞源理解\n轉化為可驗證的學習系統", 500, 128, 690, 185, {
    size: 61, bold: true, color: COLORS.ink, lineSpacing: 0.98,
  });
  text(slide, "cover-subtitle", "從個人學習痛點出發，建立可公開使用、可記錄、可持續修正的單字學習服務。", 504, 338, 650, 86, {
    size: 24, color: COLORS.muted, lineSpacing: 1.25,
  });
  line(slide, "cover-divider", 504, 472, 610, 0, COLORS.line, 1);
  text(slide, "cover-meta", "詹秉睿\n清水高中 · 高三", 504, 505, 340, 78, {
    size: 23, bold: true, color: COLORS.forest, lineSpacing: 1.25,
  });
  text(slide, "cover-date", "PROJECT SNAPSHOT\n2026.08.15", 960, 515, 150, 55, {
    size: 14, bold: true, color: COLORS.muted, align: "right", lineSpacing: 1.2,
  });
  setNotes(slide, ["Local project icon and applicant-provided identity information."]);
}

// 02 — Origin story
{
  const slide = baseSlide("Origin", 2, "我不想再逐字詢問 AI", "真正的起點不是功能，而是一個反覆出現的學習摩擦。");
  text(slide, "origin-quote", "以前，我會把每個單字逐一問 AI：\n它的拉丁字根是什麼？詞源如何演變？", 78, 200, 510, 120, {
    size: 29, bold: true, color: COLORS.navy, lineSpacing: 1.18,
  });
  text(slide, "origin-body", "這種方法能讓我理解單字，卻無法規模化；我也觀察到，同學多半仍靠重複背誦。於是我把個人的查詢流程，改造成可以整理、練習與追蹤的系統。", 78, 352, 510, 145, {
    size: 21, color: COLORS.muted, lineSpacing: 1.32,
  });
  rect(slide, "word-study-bg", 650, 192, 490, 350, COLORS.white, 22, COLORS.line);
  label(slide, "word-study-label", "ONE WORD, ONE MEMORY HOOK", 690, 222, 250, COLORS.navyLight, COLORS.navy);
  text(slide, "word", "distribute", 690, 280, 390, 58, {
    size: 47, bold: true, color: COLORS.ink, lineSpacing: 1,
  });
  text(slide, "prefix", "dis-", 690, 362, 120, 44, {
    size: 31, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1,
  });
  text(slide, "plus", "+", 815, 362, 38, 44, {
    size: 29, bold: true, color: COLORS.gold, align: "center", lineSpacing: 1,
  });
  text(slide, "root", "tribuere", 860, 362, 190, 44, {
    size: 31, bold: true, color: COLORS.navy, align: "center", lineSpacing: 1,
  });
  text(slide, "prefix-meaning", "apart／分開", 680, 418, 145, 34, {
    size: 18, color: COLORS.muted, align: "center", lineSpacing: 1,
  });
  text(slide, "root-meaning", "assign／分配", 856, 418, 215, 34, {
    size: 18, color: COLORS.muted, align: "center", lineSpacing: 1,
  });
  text(slide, "word-takeaway", "理解「分開分配」的意象，比只背中文翻譯更容易建立連結。", 690, 486, 390, 42, {
    size: 19, color: COLORS.ink, lineSpacing: 1.15,
  });
  setNotes(slide, [
    "Merriam-Webster — https://www.merriam-webster.com/dictionary/distribute",
    "Oxford Advanced Learner's Dictionary — https://www.oxfordlearnersdictionaries.com/definition/english/distribute",
    "Applicant interview: original learning workflow and observation of classmates.",
  ]);
}

// 03 — Product hypothesis
{
  const slide = baseSlide("Problem framing", 3, "把『會背』改成『看得見掌握程度』", "我沒有先堆功能，而是先定義一個可以反覆驗證的學習循環。");
  const y = 222;
  line(slide, "hypothesis-flow-1", 356, y + 73, 80, 0, COLORS.line, 4);
  line(slide, "hypothesis-flow-2", 746, y + 73, 80, 0, COLORS.line, 4);
  const items = [
    { x: 76, w: 280, n: "01", t: "理解", d: "以字根、詞源、詞義與例句建立記憶線索。", c: COLORS.navyLight, tc: COLORS.navy },
    { x: 436, w: 310, n: "02", t: "練習", d: "用中選英、看中打英、克漏字等模式反覆提取。", c: COLORS.sageLight, tc: COLORS.forest },
    { x: 826, w: 378, n: "03", t: "追蹤", d: "保留作答、錯題與熟練度，讓下一次複習有依據。", c: "#F4E9D1", tc: "#7A5620" },
  ];
  for (const item of items) {
    rect(slide, `hyp-${item.n}-bg`, item.x, y, item.w, 248, COLORS.white, 22, COLORS.line);
    rect(slide, `hyp-${item.n}-badge`, item.x + 24, y + 24, 54, 54, item.c, 27);
    text(slide, `hyp-${item.n}-num`, item.n, item.x + 24, y + 36, 54, 28, { size: 18, bold: true, color: item.tc, align: "center", lineSpacing: 1 });
    text(slide, `hyp-${item.n}-title`, item.t, item.x + 24, y + 104, item.w - 48, 48, { size: 32, bold: true, color: COLORS.ink, lineSpacing: 1 });
    text(slide, `hyp-${item.n}-body`, item.d, item.x + 24, y + 164, item.w - 48, 68, { size: 19, color: COLORS.muted, lineSpacing: 1.25 });
  }
  text(slide, "hypothesis-guardrail", "目前能證明的是『有人使用與持續產生學習紀錄』，尚不能直接推論成績因系統而提升。", 82, 544, 1110, 42, {
    size: 19, bold: true, color: COLORS.red, align: "center", lineSpacing: 1,
  });
  setNotes(slide, ["Applicant interview and project behavior; no causal learning-effect claim is made."]);
}

// 04 — Product loop/screenshots
{
  const slide = baseSlide("Product", 4, "Words King 已形成完整學習循環", "三個核心畫面對應理解、練習與追蹤，而不是孤立功能清單。");
  image(slide, "words-screenshot", wordsShot, "去識別化單字庫畫面", 72, 224, 356, 200, "contain");
  image(slide, "practice-screenshot", practiceShot, "去識別化練習設定畫面", 462, 224, 356, 200, "contain");
  image(slide, "analytics-screenshot", analyticsShot, "去識別化學習趨勢畫面", 852, 224, 356, 200, "contain");
  label(slide, "words-cap", "理解：單字庫", 140, 454, 220);
  label(slide, "practice-cap", "提取：多模式練習", 520, 454, 240);
  label(slide, "analytics-cap", "追蹤：學習趨勢", 918, 454, 220);
  text(slide, "product-loop-caption", "單字內容不是終點；每一次作答都會回到下一次複習與資料修正。", 172, 558, 936, 42, {
    size: 24, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1,
  });
  setNotes(slide, ["Screenshots captured from a temporary anonymized local clone; no production credentials or names shown."]);
}

// 05 — Timeline
{
  const slide = baseSlide("Evolution", 5, "四個月內，原型走向可公開使用的服務", "時間點採證據分級；資料能證明什麼，就只寫到什麼程度。");
  line(slide, "timeline-base", 104, 342, 1050, 0, COLORS.line, 5);
  const events = [
    { x: 114, date: "04/24", title: "專案啟動", desc: "src／public 建立時間", strong: true },
    { x: 336, date: "04/25", title: "最早練習紀錄", desc: "20 題，答對 15 題", strong: true },
    { x: 558, date: "04/29", title: "AI 匯入管線", desc: "核心 pipeline 建立", strong: true },
    { x: 780, date: "05/25", title: "公網連入證據", desc: "非本機來源 HTTP 請求", strong: false },
    { x: 1002, date: "08/15", title: "持續運作", desc: "資料與使用紀錄仍更新", strong: true },
  ];
  for (const [idx, ev] of events.entries()) {
    rect(slide, `timeline-dot-${idx}`, ev.x, 327, 30, 30, ev.strong ? COLORS.forest : COLORS.gold, 15);
    text(slide, `timeline-date-${idx}`, ev.date, ev.x - 35, 254, 100, 42, { size: 28, bold: true, color: ev.strong ? COLORS.forest : "#8B641F", align: "center", lineSpacing: 1 });
    text(slide, `timeline-title-${idx}`, ev.title, ev.x - 75, 382, 180, 50, { size: 20, bold: true, color: COLORS.ink, align: "center", lineSpacing: 1.05 });
    text(slide, `timeline-desc-${idx}`, ev.desc, ev.x - 78, 442, 186, 66, { size: 16, color: COLORS.muted, align: "center", lineSpacing: 1.18 });
  }
  label(slide, "timeline-evidence", "● 直接證據", 350, 560, 160);
  label(slide, "timeline-inference", "● 強合理推定", 540, 560, 180, "#F4E9D1", "#7A5620");
  text(slide, "timeline-note", "目前沒有 Git commit\n因此檔案時間只作證據，不當成版本史。", 772, 548, 378, 50, { size: 16, bold: true, color: COLORS.muted, align: "center", lineSpacing: 1.08 });
  setNotes(slide, ["Workspace CreationTime metadata, anonymized SQLite event timestamps, and anonymized server-log categories checked 2026-08-15."]);
}

// 06 — System architecture
{
  const slide = baseSlide("Engineering", 6, "這是一個完整系統，而不是單頁展示", "從使用者操作到資料留存、內容匯入與維運，我必須同時處理多個責任邊界。");
  line(slide, "arch-link-1", 338, 330, 90, 0, COLORS.line, 4);
  line(slide, "arch-link-2", 788, 330, 90, 0, COLORS.line, 4);
  const cols = [
    { x: 76, w: 262, title: "使用者體驗", items: "單字庫\n多模式練習\n趨勢與排行榜", accent: COLORS.navy, pale: COLORS.navyLight },
    { x: 428, w: 360, title: "服務與資料", items: "Express API／JWT 權限\nSQLite 三庫分工\n學習同步、通知、日誌", accent: COLORS.forest, pale: COLORS.sageLight },
    { x: 878, w: 326, title: "內容與維運", items: "OCR／Gemini 匯入\n管理後台與人工審核\n發音快取與 fallback", accent: "#8B641F", pale: "#F4E9D1" },
  ];
  for (const [idx, col] of cols.entries()) {
    rect(slide, `arch-${idx}-bg`, col.x, 210, col.w, 326, COLORS.white, 22, COLORS.line);
    rect(slide, `arch-${idx}-top`, col.x, 210, col.w, 12, col.accent, 6);
    rect(slide, `arch-${idx}-icon`, col.x + 28, 250, 58, 58, col.pale, 29);
    text(slide, `arch-${idx}-num`, `0${idx + 1}`, col.x + 28, 266, 58, 24, { size: 17, bold: true, color: col.accent, align: "center", lineSpacing: 1 });
    text(slide, `arch-${idx}-title`, col.title, col.x + 28, 336, col.w - 56, 44, { size: 27, bold: true, color: COLORS.ink, lineSpacing: 1 });
    text(slide, `arch-${idx}-items`, col.items, col.x + 28, 404, col.w - 56, 110, { size: 19, color: COLORS.muted, lineSpacing: 1.42 });
  }
  text(slide, "architecture-conclusion", "真正的挑戰不是『會不會寫一頁』，而是讓資料、權限、錯誤與使用流程能一起運作。", 110, 576, 1060, 48, { size: 23, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1.1 });
  setNotes(slide, ["Local source inspection: server.js, src/routes, src/db, src/middleware, src/utils, public pages."]);
}

// 07 — AI reliability
{
  const slide = baseSlide("AI reliability", 7, "AI 生成不是答案；品質控制才是系統", "一次生成曾出現錯誤，因此我把流程改成分工明確的三階段審查。");
  image(slide, "admin-ai-screenshot", adminShot, "去識別化管理後台 AI 匯入畫面", 72, 202, 500, 330, "cover");
  line(slide, "ai-flow-line", 636, 328, 500, 0, COLORS.line, 5);
  const aiSteps = [
    { x: 630, n: "1", title: "生成", sub: "建立初稿", fill: COLORS.navyLight, color: COLORS.navy },
    { x: 820, n: "2", title: "複核", sub: "檢查缺漏", fill: COLORS.sageLight, color: COLORS.forest },
    { x: 1010, n: "3", title: "仲裁", sub: "決定最終稿", fill: "#F4E9D1", color: "#7A5620" },
  ];
  for (const step of aiSteps) {
    rect(slide, `ai-step-${step.n}`, step.x, 280, 96, 96, step.fill, 48);
    text(slide, `ai-step-n-${step.n}`, step.n, step.x, 304, 96, 42, { size: 31, bold: true, color: step.color, align: "center", lineSpacing: 1 });
    text(slide, `ai-step-title-${step.n}`, step.title, step.x - 28, 398, 152, 38, { size: 23, bold: true, color: COLORS.ink, align: "center", lineSpacing: 1 });
    text(slide, `ai-step-sub-${step.n}`, step.sub, step.x - 28, 442, 152, 30, { size: 17, color: COLORS.muted, align: "center", lineSpacing: 1 });
  }
  rect(slide, "ai-guardrail", 636, 510, 500, 86, COLORS.white, 18, COLORS.line);
  text(slide, "ai-guardrail-text", "最後仍要通過：格式驗證 · 詞性規則 · 漏字／重複檢查 · 失敗回退", 660, 534, 452, 40, { size: 18, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1.15 });
  setNotes(slide, ["Local source: scripts/image_word_pipeline.py and src/routes/import.js.", "Anonymized admin screenshot captured from a temporary local clone."]);
}

// 08 — Real usage
{
  const slide = baseSlide("Evidence", 8, "專案已離開『只有我自己用』的階段", "數字代表內容規模與真實行為；不把註冊數或正確率誇大成學習成效。");
  metric(slide, "metric-words", "3,684", "個單字\n分布於 71 個單元", 78, 230, 230, COLORS.navy);
  metric(slide, "metric-visitors", "38", "位去重造訪者\n公開服務使用紀錄", 362, 230, 230, COLORS.forest);
  metric(slide, "metric-learners", "13", "位產生作答紀錄者\n不是測試帳號總數", 646, 230, 230, "#7A5620");
  metric(slide, "metric-attempts", "10,011", "筆作答紀錄\n可追蹤錯題與熟練度", 930, 230, 278, COLORS.orange);
  rect(slide, "evidence-strip", 82, 472, 1122, 102, COLORS.white, 20, COLORS.line);
  text(slide, "evidence-strip-main", "142 批匯入 · 277 場練習 · 2,122 筆熟練度資料", 118, 498, 760, 44, { size: 27, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "evidence-strip-note", "資料快照：2026/08/15", 932, 506, 230, 28, { size: 16, bold: true, color: COLORS.muted, align: "right", lineSpacing: 1 });
  text(slide, "evidence-guardrail", "證據能支持『真實使用』；目前沒有前後測，因此不主張系統造成成績提升。", 160, 608, 960, 38, { size: 19, bold: true, color: COLORS.red, align: "center", lineSpacing: 1 });
  setNotes(slide, ["Read-only SQLite snapshot on 2026-08-15: Words.db, Client.db, Server.db."]);
}

// 09 — Iteration
{
  const slide = baseSlide("Iteration", 9, "錯誤不是被藏起來，而是變成下一版設計", "同學回報與自行測試共同暴露問題；我只呈現已能說明的改變。");
  rect(slide, "iter-one", 78, 214, 528, 332, COLORS.white, 22, COLORS.line);
  label(slide, "iter-one-label", "PRONUNCIATION", 110, 246, 170, COLORS.navyLight, COLORS.navy);
  text(slide, "iter-one-title", "語音模型發音不正確", 110, 302, 430, 48, { size: 29, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "iter-one-arrow", "↓", 110, 360, 36, 34, { size: 28, bold: true, color: COLORS.gold, align: "center", lineSpacing: 1 });
  text(slide, "iter-one-fix", "優先抓取字典真人發音；無合適來源時，再以 TTS 作為 fallback。", 110, 412, 430, 88, { size: 21, color: COLORS.muted, lineSpacing: 1.28 });
  rect(slide, "iter-two", 674, 214, 528, 332, COLORS.white, 22, COLORS.line);
  label(slide, "iter-two-label", "CONTENT QUALITY", 706, 246, 190);
  text(slide, "iter-two-title", "單次生成會留下分析錯誤", 706, 302, 430, 48, { size: 29, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "iter-two-arrow", "↓", 706, 360, 36, 34, { size: 28, bold: true, color: COLORS.gold, align: "center", lineSpacing: 1 });
  text(slide, "iter-two-fix", "拆成生成、複核、仲裁，並用規則驗證與回退避免錯誤直接進入單字庫。", 706, 412, 430, 88, { size: 21, color: COLORS.muted, lineSpacing: 1.28 });
  text(slide, "iteration-conclusion", "迭代的核心不是『加更多 AI』，而是讓錯誤有被發現、被阻擋、被修正的路徑。", 126, 584, 1028, 46, { size: 23, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1.1 });
  setNotes(slide, ["Applicant interview: pronunciation and analysis-error iteration examples.", "Local source inspection: src/routes/tts.js and AI import pipeline."]);
}

// 10 — Growth and close
{
  const slide = baseSlide("Reflection", 10, "我學到的不是『叫 AI 寫程式』", "最大的成長，是把模糊需求轉成可被驗收的系統決策。");
  text(slide, "growth-before-label", "BEFORE", 82, 224, 140, 28, { size: 15, bold: true, color: COLORS.muted, lineSpacing: 1 });
  text(slide, "growth-before", "具備程式基礎\n做過小型專案", 82, 272, 330, 102, { size: 34, bold: true, color: COLORS.navy, lineSpacing: 1.15 });
  text(slide, "growth-arrow", "→", 438, 284, 100, 70, { size: 54, bold: true, color: COLORS.gold, align: "center", lineSpacing: 1 });
  text(slide, "growth-after-label", "NOW", 568, 224, 140, 28, { size: 15, bold: true, color: COLORS.muted, lineSpacing: 1 });
  text(slide, "growth-after", "定義問題 · 拆解需求\n制定規則 · 測試驗收", 568, 272, 560, 102, { size: 34, bold: true, color: COLORS.forest, lineSpacing: 1.15 });
  rect(slide, "future-box", 82, 438, 1048, 118, COLORS.white, 20, COLORS.line);
  text(slide, "future-title", "下一步：軟體系統 × AI 可靠性", 112, 466, 500, 42, { size: 29, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "future-body", "繼續研究如何讓 AI 產出可驗證、可回退、能在真實服務中被信任。", 112, 516, 630, 32, { size: 19, color: COLORS.muted, lineSpacing: 1 });
  const publicUrlShape = text(slide, "public-url", "words.ytconch.duckdns.org", 800, 478, 292, 34, { size: 19, bold: true, color: COLORS.forest, align: "right", lineSpacing: 1 });
  text(slide, "public-url-note", "公開服務入口", 856, 518, 236, 26, { size: 15, color: COLORS.muted, align: "right", lineSpacing: 1 });
  text(slide, "closing", "一個從自身需求開始，透過使用、錯誤與驗證持續成長的系統。", 160, 602, 960, 42, { size: 24, bold: true, color: COLORS.navy, align: "center", lineSpacing: 1 });
  publicUrlShape.text.get("words.ytconch.duckdns.org").link = { uri: "https://words.ytconch.duckdns.org/", isExternal: true };
  setNotes(slide, ["Applicant interview: starting skill level, main growth, and intended study direction.", "Public service: https://words.ytconch.duckdns.org/"]);
}

// 11 — Appendix: scope
{
  const slide = baseSlide("Appendix A", 11, "系統範圍：八個使用介面，六類後端責任", "附錄提供技術完整度；正文不要求評審逐項閱讀。");
  const pages = ["首頁／登入", "單字庫", "練習", "排行榜", "學習趨勢", "設定", "通知", "管理後台"];
  const services = ["驗證與權限", "單字查詢", "練習與熟練度", "分析與排行榜", "匯入與審核", "TTS／發音快取"];
  text(slide, "scope-pages-title", "使用介面", 86, 208, 260, 38, { size: 27, bold: true, color: COLORS.navy, lineSpacing: 1 });
  text(slide, "scope-services-title", "後端責任", 684, 208, 260, 38, { size: 27, bold: true, color: COLORS.forest, lineSpacing: 1 });
  for (let i = 0; i < pages.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    rect(slide, `page-item-bg-${i}`, 86 + col * 246, 276 + row * 66, 220, 48, COLORS.white, 12, COLORS.line);
    text(slide, `page-item-${i}`, pages[i], 100 + col * 246, 289 + row * 66, 192, 24, { size: 18, bold: true, color: COLORS.ink, lineSpacing: 1 });
  }
  for (let i = 0; i < services.length; i++) {
    rect(slide, `svc-item-bg-${i}`, 684, 276 + i * 54, 430, 40, i % 2 ? COLORS.paper2 : COLORS.white, 10, COLORS.line);
    text(slide, `svc-item-${i}`, services[i], 704, 286 + i * 54, 390, 22, { size: 18, bold: true, color: COLORS.ink, lineSpacing: 1 });
  }
  setNotes(slide, ["Local source: public/*.html, public/*.js, src/routes/*.js, server.js."]);
}

// 12 — Appendix: tests
{
  const slide = baseSlide("Appendix B", 12, "26 項測試守住 AI 匯入的關鍵邊界", "測試聚焦在模型最常出現、又最容易污染資料庫的輸出差異。");
  metric(slide, "test-count", "26 / 26", "2026/08/15\n一次性測試全部通過", 84, 220, 280, COLORS.forest);
  const checks = [
    ["格式契約", "輸出欄位、順序與提示契約"],
    ["詞性合法", "拒絕非法 tense，允許安全正規化"],
    ["內容完整", "補回漏字、維持輸入順序"],
    ["去除重複", "合併重複 row 與重複字義"],
    ["降級回退", "後續審查失敗時沿用可靠版本"],
    ["API 限流", "429 時切換 key 或交回協調器"],
  ];
  for (let i = 0; i < checks.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 430 + col * 380;
    const y = 214 + row * 126;
    rect(slide, `check-${i}-bg`, x, y, 342, 98, COLORS.white, 16, COLORS.line);
    text(slide, `check-${i}-title`, checks[i][0], x + 22, y + 18, 125, 30, { size: 21, bold: true, color: COLORS.forest, lineSpacing: 1 });
    text(slide, `check-${i}-desc`, checks[i][1], x + 22, y + 52, 296, 38, { size: 16, color: COLORS.muted, lineSpacing: 1.12 });
  }
  text(slide, "test-command", "驗證命令：python -m unittest tests.test_image_word_pipeline", 84, 578, 870, 30, { size: 17, color: COLORS.muted, lineSpacing: 1 });
  setNotes(slide, ["One-shot test run on 2026-08-15: 26 tests, all passed.", "Local source: tests/test_image_word_pipeline.py."]);
}

// 13 — Appendix: evidence ledger
{
  const slide = baseSlide("Appendix C", 13, "時間線採用證據分級，不把推定寫成事實", "這份報告刻意保留限制，因為可信度比故事完整更重要。");
  const rows = [
    ["2026/04/24", "src／public 建立", "直接證據", "作為啟動時間點，不等於 Git commit"],
    ["2026/04/25", "20 題／15 題正確", "直接證據", "原帳號已無法回連，不稱第一位同學"],
    ["2026/04/29", "AI pipeline 建立", "直接證據", "目前工作區檔案時間"],
    ["2026/05/25", "非本機來源請求", "強合理推定", "支持當時具公網連入能力"],
    ["2026/05/28", "一單元重掃成功", "直接證據", "仍待人工確認，不稱完成全庫重掃"],
  ];
  const x0 = 78;
  const widths = [160, 250, 180, 480];
  const headers = ["日期", "可觀察事件", "證據強度", "安全措辭／限制"];
  let x = x0;
  for (let i = 0; i < headers.length; i++) {
    rect(slide, `ledger-head-bg-${i}`, x, 204, widths[i], 48, COLORS.forest, 0);
    text(slide, `ledger-head-${i}`, headers[i], x + 12, 217, widths[i] - 24, 24, { size: 17, bold: true, color: COLORS.white, lineSpacing: 1 });
    x += widths[i];
  }
  for (let r = 0; r < rows.length; r++) {
    x = x0;
    for (let c = 0; c < rows[r].length; c++) {
      rect(slide, `ledger-${r}-${c}-bg`, x, 252 + r * 68, widths[c], 68, r % 2 ? COLORS.paper2 : COLORS.white, 0, COLORS.line);
      text(slide, `ledger-${r}-${c}`, rows[r][c], x + 12, 268 + r * 68, widths[c] - 24, 40, { size: c === 3 ? 15 : 16, bold: c === 0 || c === 2, color: c === 2 && rows[r][c].includes("推定") ? "#7A5620" : COLORS.ink, lineSpacing: 1.12 });
      x += widths[c];
    }
  }
  setNotes(slide, ["Workspace filesystem metadata and anonymized SQLite/server-log evidence reviewed 2026-08-15."]);
}

// 14 — Appendix: AI collaboration disclosure
{
  const slide = baseSlide("Appendix D", 14, "AI 協作透明揭露：主導權放在決策與驗收", "Coding Agent 執行大量程式實作；我的責任是讓系統方向、規則與品質可被解釋。");
  rect(slide, "human-panel", 80, 214, 500, 350, COLORS.navy, 24);
  text(slide, "human-kicker", "我負責", 116, 250, 160, 34, { size: 18, bold: true, color: COLORS.gold, lineSpacing: 1 });
  text(slide, "human-title", "問題定義與工程判斷", 116, 304, 390, 48, { size: 31, bold: true, color: COLORS.white, lineSpacing: 1 });
  text(slide, "human-items", "• 找出學習痛點與使用情境\n• 拆解需求、決定優先順序\n• 設定資料規則與失敗策略\n• 測試、驗收並要求修正", 116, 382, 390, 138, { size: 20, color: "#E5ECF3", lineSpacing: 1.38 });
  rect(slide, "agent-panel", 650, 214, 550, 350, COLORS.white, 24, COLORS.line);
  text(slide, "agent-kicker", "Coding Agent 負責", 686, 250, 220, 34, { size: 18, bold: true, color: COLORS.forest, lineSpacing: 1 });
  text(slide, "agent-title", "大量程式實作與修正執行", 686, 304, 450, 48, { size: 31, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "agent-items", "• 依規格產生與調整程式\n• 協助除錯、重構與補測試\n• 執行重複性高的修改\n• 由我檢查結果是否符合目的", 686, 382, 450, 138, { size: 20, color: COLORS.muted, lineSpacing: 1.38 });
  text(slide, "ai-disclosure-close", "我不把 AI 產出的程式冒充為全數手寫；我呈現的是如何運用工具完成可驗證的工程成果。", 112, 606, 1056, 38, { size: 20, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1.05 });
  setNotes(slide, ["Applicant interview: Coding Agent participation was substantial; applicant led requirements, decisions, testing, and acceptance."]);
}

// 15 — Appendix: data definitions & public access
{
  const slide = baseSlide("Appendix E", 15, "公開可驗證，但展示資料仍必須保護隱私", "網址能證明服務可連線；截圖採去識別化副本，避免把同學資料當成作品素材。");
  image(slide, "public-login-screenshot", publicLogin, "Words King 公開 HTTPS 登入入口", 72, 208, 590, 332, "cover");
  text(slide, "public-status", "公開 HTTPS 入口", 724, 218, 340, 36, { size: 19, bold: true, color: COLORS.forest, lineSpacing: 1 });
  const publicLinkShape = text(slide, "public-link", "words.ytconch.duckdns.org", 724, 266, 440, 44, { size: 27, bold: true, color: COLORS.navy, lineSpacing: 1 });
  publicLinkShape.text.get("words.ytconch.duckdns.org").link = { uri: "https://words.ytconch.duckdns.org/", isExternal: true };
  text(slide, "privacy-title", "截圖保護措施", 724, 350, 260, 36, { size: 23, bold: true, color: COLORS.ink, lineSpacing: 1 });
  text(slide, "privacy-items", "• 使用暫存資料庫副本\n• 帳號與顯示名稱全部替換\n• IP、復原申請與日誌內容去識別\n• 不修改正式資料與公開服務", 724, 402, 440, 132, { size: 19, color: COLORS.muted, lineSpacing: 1.34 });
  text(slide, "data-defs", "數據定義：38＝去重造訪者；13＝至少一筆 study_log 的使用者；10,011＝作答事件。", 114, 590, 1052, 44, { size: 18, bold: true, color: COLORS.forest, align: "center", lineSpacing: 1.1 });
  setNotes(slide, ["Public service verified in browser: https://words.ytconch.duckdns.org/", "Screenshots captured from public entrance and a temporary anonymized local clone."]);
}

await fs.mkdir(PREVIEW, { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(`${PREVIEW}/${stem}.png`, await presentation.export({ slide, format: "png", scale: 1 }));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${PREVIEW}/${stem}.layout.json`, await layout.text());
}
await writeBlob(`${PREVIEW}/deck-montage.webp`, await presentation.export({ format: "webp", montage: true, scale: 1 }));

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(OUTPUT);
console.log(JSON.stringify({ output: OUTPUT, slides: presentation.slides.items.length }));
