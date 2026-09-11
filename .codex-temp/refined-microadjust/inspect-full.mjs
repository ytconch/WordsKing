import fs from "node:fs/promises";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const source = "C:/Users/ytcon/server/server/WordsKingServer/.codex-temp/refined-microadjust/source-refined.pptx";
const out = "C:/Users/ytcon/server/server/WordsKingServer/.codex-temp/refined-microadjust/full-inspect.ndjson";

const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
const snapshot = await presentation.inspect({
  kind: "slide,textbox,shape,image,table,chart,notes,layout",
  include: "id,slide,name,title,text,textPreview,textChars,textLines,bbox,bboxUnit,isPlaceholder,placeholders",
  maxChars: 120000,
});
await fs.writeFile(out, snapshot.ndjson, "utf8");
console.log(out);
