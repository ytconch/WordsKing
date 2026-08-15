# Words King Server

英文單字學習伺服器，使用 `Node.js + Express + SQLite + HTML/CSS/JS`。

## 啟動

```powershell
npm install
npm start
```

開啟 `http://localhost:3000/home.html`

## `.env` 設定

第一次可直接複製：

```powershell
Copy-Item .env.example .env
```

然後編輯 `.env`：

```env
PORT=3000
JWT_SECRET=replace-with-a-strong-secret
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_API_KEYS=your_key_1,your_key_2,your_key_3
TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
```

如果你只有單一 Gemini key，也可以改成：

```env
GEMINI_API_KEY=your_key
```

`GEMINI_API_KEYS` 支援：
- `key1,key2,key3`
- `key1;key2;key3`
- 一行一把 key

Node 啟動後會自動讀取 `.env`，圖片辨識用的 Python 流程也會繼承同一組環境變數。

## `xlsx` 欄位

- `eng`
- `kk`
- `tense`
- `ch`
- `analysis` 或 `anlaysis`
- `definition`
- `example`

`source` 與 `unit` 由管理頁額外輸入，不需要寫在 Excel 內。

## 圖片辨識匯入

管理員流程：

1. 上傳圖片
2. 後端執行 OCR + Gemini
3. 產生草稿
4. 管理頁核對草稿
5. 核對後才正式匯入

### Python 相依套件

```powershell
pip install -r requirements-image-import.txt
```

另外需要：

- `Tesseract OCR`
- 可執行的 `python`

## 資料庫

- `data/Words.db`
- `data/Server.db`
- `data/Client.db`
