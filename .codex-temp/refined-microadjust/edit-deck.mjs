import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const buildDir = "C:/Users/ytcon/server/server/WordsKingServer/.codex-temp/refined-microadjust";
const sourcePptx = path.join(buildDir, "template-starter.pptx");
const outputPptx = "C:/Users/ytcon/server/server/WordsKingServer/deliverables/Words_King_特殊選才專案報告_詹秉睿_微調完成版.pptx";
const renderDir = path.join(buildDir, "final-rendered");
const layoutDir = path.join(buildDir, "final-layout", "final");

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePptx));
const before = await presentation.inspect({
  kind: "slide,textbox,shape,image,table,chart,notes,layout",
  include: "id,slide,name,title,text,textPreview,textChars,textLines,bbox,bboxUnit,isPlaceholder,placeholders",
  maxChars: 140000,
});
await fs.writeFile(path.join(buildDir, "edit-before.ndjson"), before.ndjson, "utf8");

const records = before.ndjson
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function textboxRecord(slideNumber, oldText) {
  const match = records.find(
    (record) =>
      record.kind === "textbox" &&
      record.slide === slideNumber &&
      typeof record.text === "string" &&
      record.text.trim() === oldText.trim(),
  );
  if (!match) throw new Error(`Textbox not found on slide ${slideNumber}: ${oldText}`);
  return match;
}

function rewrite(slideNumber, oldText, newText) {
  const record = textboxRecord(slideNumber, oldText);
  const shape = presentation.resolve(record.id);
  shape.text = newText;
  return shape;
}

rewrite(1, "從學習痛點出發\n\t建立單字學習網站。", "從學習痛點出發\n建立單字學習網站");

rewrite(
  2,
  "拉丁字跟的背誦與搭配，使的記憶量減少與英語單字邏輯化。",
  "拆解拉丁字根與詞源，能降低記憶負擔，也看懂單字結構。",
);

rewrite(3, "四個月內，把想法架構做成公開服務", "不到四個月，把想法做成公開服務");
rewrite(3, "beta版本釋出\n基本單字功能與練習", "第一版可用\n基本單字功能與練習");
rewrite(3, "OCR掃描資料\nAI擬合分析資料匯入", "建立 AI 匯入流程\nOCR 掃描與內容處理");
rewrite(3, "公測版本發布", "公開部署");
rewrite(3, "同學可透過公網鏈結使用", "同學可透過網路使用");

rewrite(
  4,
  "我把重複化的查詢學習做成了高效且方便的網頁",
  "我把重複查詢，做成方便使用的學習網站",
);

rewrite(5, "完整的學習功能與監測", "從理解、練習到學習追蹤");
rewrite(
  5,
  "Words King 的核心目的並非單純提供單字庫，\n而是引導使用者透過實作練習發現個人學習盲點。\n系統隨後進行數據分析並提供精準練題，協助使用者徹底克服難點、提升學習效率。",
  "Words King 不只提供單字內容，也讓使用者透過練習找出容易答錯的單字。\n系統會整理作答結果與熟練度，作為下一次複習與題目推送的依據。",
);

rewrite(
  6,
  "趨勢功能把『會背』變成能看見的『掌握程度』",
  "讓「會背」變成看得見的掌握程度",
);
rewrite(
  6,
  "使用者於單字庫完成單字複習後，\n可進入練習區選擇單元與模式進行測驗。\n測驗完畢後，系統會彙整答題數據並傳送至後端儲存。\n下次使用者再次測驗時，系統將依據先前的答題表現，\n結合錯題演算法精準推送並調整題目。",
  "使用者先在單字庫理解字根與詞源，再進入練習區作答。\n系統保留答題、錯題與熟練度，並在下次練習時，\n依先前表現調整題目與推送重點。",
);

rewrite(
  7,
  "單字庫入庫品質控制讓優質 AI 內容才能進入資料系統",
  "我先讓 AI 內容通過審查，再進入單字庫",
);
rewrite(
  7,
  "針對 AI 輸出內容的不確定性，我們設計了「AI 自我核查」與「人工最終把關」的雙重防線。\n資料經由 AI 內部的「初審、複審、最終仲裁」三重自我審查與格式過濾，能有效收斂異常；\n最終再經由人工專業審核，確保進入資料庫的每一筆資料皆具備高穩定度與檢索價值。",
  "AI 產生的內容不會直接寫入資料庫。我將流程拆成生成、兩次複核與仲裁，\n再用格式、詞性、漏字與重複規則過濾；最後由我在管理後台確認，\n才正式入庫。",
);
rewrite(
  7,
  "最後仍要通過：\njson格式驗證 · 詞性規則 · 漏字／重複檢查 · 失敗回退",
  "最後仍要通過：\nJSON 格式 · 詞性規則 · 漏字／重複檢查 · 失敗回退",
);

rewrite(
  8,
  "內容規模與作答資料，讓我能觀察系統運作並持續調整功能。",
  "截至 2026/08/15，這些資料持續支援我觀察系統與調整功能。",
);
rewrite(8, "位造訪者\n公開服務使用紀錄", "位造訪使用者\n公開服務使用紀錄");
rewrite(8, "位產生作答紀錄者\n已留下實際學習資料", "位留下作答紀錄者\n已產生實際學習資料");

rewrite(
  9,
  "結合使用者回報與自主邊界測試精準定位問題，並導入工程化標準流程進行修復與版本更新。",
  "我從同學回報與自行測試中找出問題，再把修正納入下一輪版本。",
);
rewrite(
  9,
  "優先抓取API字典真人發音；\n無合適來源時，再以 TTS模組 作為 fallback。",
  "優先使用 API 字典真人發音；\n無合適來源時，再以 TTS 作為備援。",
);
rewrite(
  9,
  "我透過實際使用與自行測試\n持續推動下一輪迭代\n公測發布後我也持續的蒐集使用者回饋\n來持續的優化前後端",
  "我透過實際使用、自行測試與同學回報，\n持續修正前後端，推動下一輪迭代。",
);

rewrite(10, "從寫程式到做系統決策", "我學到的，不只是把功能做出來");
rewrite(
  10,
  "過往我主要運用 C++ 與 TypeScript 開發基礎專案；\n如今隨著 AI 工具的普及，我將開發重點從單純的「寫碼」轉化為「工程大局觀」的展現。\n結合對系統架構的理解與程式扎實度，我不僅能快速整合新技術，\n更能在注重可用性與資訊安全的前提下，獨立建構出高品質、高穩定度的 Web 應用程式。",
  "一開始，我把開發理解成把功能寫出來；系統真正上線後，我才發現，\n定義問題、拆解需求、驗證結果與持續修正，才決定作品是否可靠。\n我運用 AI 與 Coding Agent 協助實作，但由我決定要解決什麼、如何驗收，\n以及哪些結果不能直接採用。這也讓我學會建立備援、審查與迭代流程。",
);
rewrite(10, "具備程式基礎\n做過小型專案", "會寫程式\n做出功能");
rewrite(10, "定義問題 · 拆解需求\n制定規則 · 測試驗收", "定義問題 · 拆解需求\n驗證品質 · 承擔結果");

rewrite(11, "五項工程決策支撐系統持續運作", "五項工程選擇，讓系統能持續運作");
rewrite(11, "輕量型資料庫與三個資料庫分工", "以三個資料庫分工");
rewrite(11, "快速部屬與降低耦合", "快速部署並降低耦合");
rewrite(11, "多資料來源與嚴格AI審核並入庫", "多資料來源，審查後再入庫");
rewrite(11, "將服務部屬至公開網域", "將服務部署至公開網域");
rewrite(11, "架設網頁使其多裝置支援與快速迭代", "支援多裝置使用與快速迭代");

rewrite(12, "專案作品報告", "公開服務");
rewrite(12, "從學習痛點出發\n\t建立單字學習網站。", "歡迎實際使用\nWords King");
const linkShape = rewrite(
  12,
  "詹秉睿\n清水高中 · 高三",
  "words.ytconch.duckdns.org\n點擊網址，體驗完整學習流程",
);
const linkRange = linkShape.text.get("words.ytconch.duckdns.org");
linkRange.link = { uri: "https://words.ytconch.duckdns.org/", isExternal: true };
linkRange.underline = "sng";
linkRange.bold = true;

presentation.slides.getItem(9).speakerNotes.textFrame.setText(
  "[Sources]\n- 本專案學習反思。\n- https://words.ytconch.duckdns.org/",
);
presentation.slides.getItem(11).speakerNotes.textFrame.setText(
  "[Sources]\n- 公開服務：https://words.ytconch.duckdns.org/\n- 本專案識別與展示入口。",
);

await fs.mkdir(path.dirname(outputPptx), { recursive: true });
await fs.mkdir(renderDir, { recursive: true });
await fs.mkdir(layoutDir, { recursive: true });

const after = await presentation.inspect({
  kind: "slide,textbox,shape,image,table,chart,notes,layout",
  include: "id,slide,name,title,text,textPreview,textChars,textLines,bbox,bboxUnit,isPlaceholder,placeholders",
  maxChars: 140000,
});
await fs.writeFile(path.join(buildDir, "edit-after.ndjson"), after.ndjson, "utf8");

for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(path.join(renderDir, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(path.join(layoutDir, `${stem}.layout.json`), await layout.text(), "utf8");
}

await writeBlob(
  path.join(buildDir, "final-montage.webp"),
  await presentation.export({ format: "webp", montage: true, scale: 1 }),
);

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(outputPptx);
console.log(outputPptx);
