import json
import os
import re
import sys
import time
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

try:
    import pytesseract
    from PIL import Image
    from google import genai
except ImportError as error:
    print(
        "__WK_RESULT__" + json.dumps(
            {"ok": False, "error": f"缺少 Python 套件：{error}"},
            ensure_ascii=False
        )
    )
    raise SystemExit(1)


pytesseract.pytesseract.tesseract_cmd = os.environ.get(
    "TESSERACT_CMD",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")


class UserFacingPipelineError(Exception):
    """Error message safe to show in the admin import UI."""


OUTPUT_FIELD_ORDER = (
    "eng",
    "kk",
    "tense",
    "ch",
    "analysis",
    "definition",
    "example"
)

ALLOWED_TENSE_VALUES = frozenset(
    {
        "n.",
        "vt.",
        "vi.",
        "v.",
        "adj.",
        "adv.",
        "prep.",
        "conj.",
        "pron.",
        "interj.",
        "det.",
        "aux.",
        "modal v."
    }
)

TENSE_VALUE_ALIASES = {
    "n": "n.",
    "noun": "n.",
    "vt": "vt.",
    "transitive verb": "vt.",
    "transitive v.": "vt.",
    "vi": "vi.",
    "intransitive verb": "vi.",
    "intransitive v.": "vi.",
    "v": "v.",
    "verb": "v.",
    "adj": "adj.",
    "adjective": "adj.",
    "adv": "adv.",
    "adverb": "adv.",
    "prep": "prep.",
    "preposition": "prep.",
    "conj": "conj.",
    "conjunction": "conj.",
    "pron": "pron.",
    "pronoun": "pron.",
    "interj": "interj.",
    "interjection": "interj.",
    "det": "det.",
    "determiner": "det.",
    "aux": "aux.",
    "auxiliary": "aux.",
    "auxiliary verb": "aux.",
    "modal": "modal v.",
    "modal verb": "modal v."
}

POS_OUTPUT_ORDER = (
    "n.",
    "vt.",
    "vi.",
    "v.",
    "adj.",
    "adv.",
    "prep.",
    "conj.",
    "pron.",
    "interj.",
    "det.",
    "aux.",
    "modal v."
)

OMISSION_SENSITIVE_POS_GROUPS = {
    "scrap": [("n.",), ("v.", "vt.", "vi.")],
    "charge": [("n.",), ("v.", "vt.", "vi.")],
    "claim": [("n.",), ("v.", "vt.", "vi.")],
    "draft": [("n.",), ("v.", "vt.", "vi.")],
    "guard": [("n.",), ("v.", "vt.", "vi.")],
    "attack": [("n.",), ("v.", "vt.", "vi.")],
    "release": [("n.",), ("v.", "vt.", "vi.")],
    "record": [("n.",), ("v.", "vt.", "vi.")],
    "target": [("n.",), ("v.", "vt.", "vi.")],
    "yield": [("n.",), ("v.", "vt.", "vi.")],
    "haul": [("n.",), ("v.", "vt.", "vi.")],
    "offering": [("n.",), ("v.", "vt.", "vi.")]
}

EVIDENCE_THRESHOLD_BLOCK = """
# Positive Evidence Threshold
新增詞性、義項或詞源敘述時，必須有可靠的現代標準英語用法或可辯護的歷史語言學依據。
1. 不可因為某詞性或義項「可能存在」就新增；不確定時寧可省略，不可猜測。
2. 零轉品、結果名詞、動作名詞、及物／不及物用法都必須先確認是穩定且常見的現代用法。
3. 一般字典可查但冷門、古老、地域性極強或高度專業的義項，不屬於預設輸出。
4. OCR 或來源上下文明確使用某個低頻義時才可納入，並須保持該 row 的詞性正確。
5. 不得以「資訊越多越好」為理由加入無法可靠支持的內容。
"""

COMMONNESS_FILTER_BLOCK = """
# Learner-oriented Sense Coverage
每個 row 必須完整保留該詞性的核心義，以及學生在教材、一般閱讀、考試、新聞或學術入門內容中常遇到的高頻義。
1. ch 依實際需要建立 1 到 5 個語義群組，不是只保留一個意思。
2. 每個群組代表一個獨立語義；高度相近的中文譯法放在同一群組，不可膨脹成多個假義項。
3. 不同核心概念、抽象延伸或穩定語境義分成不同群組，依常見度排序。
4. 專業、古義、罕見義只有在來源上下文需要時才加入。
5. 不可只翻輸入片段中的狹義，也不可為追求最大字典覆蓋而加入邊角義。
6. 各群組必須互斥：同一中文譯義不可重複出現在不同群；若兩群定義重疊或其中一群只是另一群的領域示例，必須合併。
7. 每個群組只能對應一個清楚的英文 definition 與一個例句；不可在第一群混入第二群的中文譯義。
"""

INFLECTED_FORM_RULE_BLOCK = """
# Surface Form and Inflection Rule
1. 英文列表輸入時，eng 必須保留使用者輸入的表面詞形，不可擅自改成未輸入的 lemma。
2. -ing、-ed、過去式、過去分詞或其他變化形，必須在 analysis 指出原形、變化身份與語義延續。
3. 若表面詞形另有已詞典化的常見名詞或形容詞，必須以不同 tense row 分開。
4. 來源動詞的變化形可使用 v.、vt. 或 vi. row，但 eng 仍保留輸入詞形。
5. 不可把來源動詞與已詞典化名詞／形容詞的中文義、definition 或 example 混在同一 row。
"""

ETYMOLOGY_SOURCE_HIERARCHY_BLOCK = """
# Morphology and Etymology Contract
analysis 必須先區分「現代可辨識的構詞」與「歷史詞源」，兩者不可混為一談。
1. 先判定此字屬於現代透明構詞、歷史借詞、不可透明拆解的繼承詞，或變化詞形，再選擇適用的分析。
2. 只有歷史上成立時才能拆成 prefix、root/base、suffix 或複合成分；表面字母相似不能當作證據。
3. 拉丁語資料必須標明是「詞根／詞幹」或「完整拉丁詞形」。若完整拉丁詞能可靠拆解，需交代各成分，不可把整個拉丁詞籠統稱為字根。
4. ad-、in-、con- 等字首的 ac-、im-、il-、ir-、com-、col-、cor- 同化形式，只有在該字歷史上確實成立時才說明，並交代拼寫變化及發生的來源語構詞階段；不可誤寫成借入英語後才發生。
5. 傳入媒介是可選資訊，不是必填欄位。只有能可靠確認歷史路徑時才可寫入；沒有把握就直接連接可靠上源與英語發展。
6. 不可因英文字有拉丁上源，就預設它經法語傳入。直接或學術性借自拉丁語的詞，不得虛構 Old French、Middle French 或泛稱「法語」作媒介。
7. 若寫 Old French、Middle French 或其他媒介，必須能提供可靠的中介詞形並說明傳遞關係；只有語言名稱而沒有可辯護詞形時必須刪除。
8. 若有可靠拉丁上源與媒介，順序為：拉丁核心根源與原義 → 已證成的傳入媒介 → 英語詞形與語義演變。
9. 若無可靠拉丁來源，必須如實使用古英語、日耳曼語、希臘語或其他實際來源；不可為迎合拉丁分析而虛構。
10. 詞根變體或歷史詞幹不可假裝成可獨立使用的單字；需說明它與來源詞形及現代拼字的關係。
11. 語意演變需呈現原始義、中介義與現代義的因果鏈；不可只列語言名稱或寫「後來演變成」。
12. 無法可靠確定的細節應省略或使用謹慎表述，不可編造精確詞形、年代、傳入媒介或語意鏈。
"""

ROW_AND_POS_CONTRACT_BLOCK = f"""
# Row and Part-of-speech Contract
1. 每個 row 只能有一個 tense；合法值只有：{", ".join(POS_OUTPUT_ORDER)}。
2. 同一表面詞形的不同常見詞性分成不同 row。
3. vt. 與 vi. 的句型或常見義明顯不同時分開；高度重疊且拆分只會重複時才使用 v.。
4. vt. 例句必須有直接受詞；vi. 例句不得硬加直接受詞。
5. 同一 eng + tense 只能有一筆。若同詞性包含同形異源義，合併在該 row，並在 analysis 清楚分開來源。
6. 保留輸入單字順序；同字多 row 固定依下列順序：{", ".join(POS_OUTPUT_ORDER)}。
7. 只有符合正面證據門檻的常見詞性才能建立 row，不可機械枚舉所有可能詞性。
"""

OUTPUT_CONTRACT_BLOCK = f"""
# Output Contract
只能輸出可由 JSON.parse() 解析的 JSON 陣列，不可輸出 Markdown、註解或任何陣列外文字。
每個物件只能有以下七個欄位，且順序固定：
{", ".join(OUTPUT_FIELD_ORDER)}

欄位規則：
1. eng：英文表面詞形。英文列表輸入時必須保留輸入拼字；OCR 模式才可修正明確 OCR 拼字錯誤。
2. kk：可靠的常見美式 KK 音標，必須核對重音、非重讀母音弱化與不同詞性讀音；不可依拼字逐字母猜音，也不可用看似音標的混合格式。沒有把握時輸出空字串。
3. tense：只能使用合法單一詞性值。
4. ch：繁體中文學習義。單一語義群組使用 ["譯義", "同群近義"]；多群使用 [["第一群"], ["第二群"]]。群組數必須為 1 到 5。
5. analysis：單一連續繁體中文段落，不可使用 object、array 或條列。依適用情況說明語法身份、表面詞形與 lemma、可靠構詞、歷史來源、語意演變及多義連結。
6. definition：英文定義，依 ch 群組以 "1. ...; 2. ..." 編號；編號數與順序必須和 ch 群組完全一致，各定義不可互相重疊。
7. example：JSON 陣列，每個 ch 群組恰好一筆例句，順序一致，最多五筆。每筆只能有非空的 eng 與 ch；英文自然、中文為準確繁體中文，且只示範對應群組，不可跨群混義。
"""

SHARED_GENERATION_CONTRACT_BLOCK = f"""
{EVIDENCE_THRESHOLD_BLOCK}
{COMMONNESS_FILTER_BLOCK}
{INFLECTED_FORM_RULE_BLOCK}
{ROW_AND_POS_CONTRACT_BLOCK}
{ETYMOLOGY_SOURCE_HIERARCHY_BLOCK}
{OUTPUT_CONTRACT_BLOCK}
"""

FIRST_PASS_FOCUS_BLOCK = """
# Pass 1: Structural Draft
第一輪負責建立可靠骨架：辨識表面詞形與 lemma、列出有正面證據的常見詞性、判斷 vt./vi.，並完成七個欄位。
若資訊取捨衝突，優先保住輸入覆蓋、row 結構、詞性與核心中文義；但 analysis、definition、example 仍須符合完整輸出合約。
"""

SECOND_PASS_EXPANSION_AUDIT_BLOCK = """
# Pass 2: Semantic and Etymology Audit
第二輪以第一稿為基礎，逐 row 補足遺漏的核心／高頻義，核對 definition 與 example 的順序對應，並嚴查構詞與詞源。
若第一稿的 example 為空、格式不完整或少於 ch 群組，不可沿用空陣列；必須為每個群組補上自然英文例句與準確繁體中文翻譯。
只在有正面證據時新增 row 或義項；不得為了看起來更完整而加入低頻、可疑或無法辯護的內容，也不得無必要改寫正確內容。
"""

THIRD_PASS_FINAL_AUDIT_BLOCK = """
# Pass 3: Evidence-based Arbitration
第三輪比較第一稿與第二稿並產出唯一最終稿。優先採用較正確、較完整且符合證據門檻的內容，而不是較長的內容。
必須刪除無證據 row、假詞性、假字根與跨欄矛盾；可修正、拆分或合併 row，但不可因文風偏好改寫正確內容。
最終每個 row 的 example 必須為非空雙語陣列；前稿若為空，必須補齊，不可原樣保留空陣列。
若提供 existing，僅用於避免空白、明顯縮水與誤刪；舊資料不能凌駕正確性。
"""


def worker_prefix():
    worker_index = os.environ.get("GEMINI_WORKER_INDEX", "").strip()
    worker_count = os.environ.get("GEMINI_WORKER_COUNT", "").strip()
    if worker_index and worker_count:
        return f"[worker {worker_index}/{worker_count}] "
    return ""


def emit_progress(progress, stage, message):
    print(
        "__WK_PROGRESS__"
        + json.dumps(
            {
                "progress": progress,
                "stage": stage,
                "message": f"{worker_prefix()}{message}"
            },
            ensure_ascii=False
        ),
        flush=True
    )


def emit_result(payload):
    print("__WK_RESULT__" + json.dumps(payload, ensure_ascii=False), flush=True)


def fail(message):
    emit_result({"ok": False, "error": message})
    raise SystemExit(1)


def load_gemini_api_keys():
    raw_keys = os.environ.get("GEMINI_API_KEYS", "").strip()
    if not raw_keys:
        raw_keys = os.environ.get("GEMINI_API_KEY", "").strip()

    keys = [
        item.strip()
        for item in re.split(r"[\r\n,;|]+", raw_keys)
        if item.strip()
    ]

    unique_keys = []
    seen = set()
    for key in keys:
        if key not in seen:
            seen.add(key)
            unique_keys.append(key)

    return unique_keys


def create_gemini_client(api_key):
    return genai.Client(api_key=api_key, http_options={"api_version": "v1"})


def is_gemini_permission_error(error):
    err_str = str(error).upper()
    return (
        "403" in err_str
        or "PERMISSION_DENIED" in err_str
        or "DENIED ACCESS" in err_str
        or "API_KEY_INVALID" in err_str
        or "API KEY NOT VALID" in err_str
    )


def is_gemini_rate_limit_error(error):
    err_str = str(error).upper()
    return "429" in err_str or "EXHAUSTED" in err_str or "RATE_LIMIT" in err_str


def is_gemini_busy_error(error):
    err_str = str(error).upper()
    return (
        "503" in err_str
        or "UNAVAILABLE" in err_str
        or "500" in err_str
        or "INTERNAL" in err_str
        or "DEADLINE" in err_str
        or "TIMEOUT" in err_str
        or "CONNECTION" in err_str
        or "SSL" in err_str
    )


def format_gemini_permission_error(disabled_keys_count, total_keys):
    return (
        "Gemini API 權限被拒絕：目前專案或 API key 無法使用此模型/API。"
        f"已停用 {disabled_keys_count}/{total_keys} 把 key。"
        "請更換有效 GEMINI_API_KEY/GEMINI_API_KEYS，確認該 Google Cloud 專案已允許 Gemini API，"
        f"且模型 {MODEL_NAME} 可用。"
    )


def call_gemini_with_retry(prompt, api_keys, retries=15):
    clients = [create_gemini_client(api_key) for api_key in api_keys]
    total_keys = len(clients)
    client_index = 0
    disabled_key_indexes = set()
    cooldown_until = {}
    last_error = None

    def next_available_index():
        now = time.monotonic()
        for offset in range(total_keys):
            index = (client_index + offset) % total_keys
            if index in disabled_key_indexes:
                continue
            if cooldown_until.get(index, 0) <= now:
                return index
        return None

    def sleep_until_next_available(attempt_index):
        active_indexes = [index for index in range(total_keys) if index not in disabled_key_indexes]
        if not active_indexes:
            return
        next_ready_at = min(cooldown_until.get(index, 0) for index in active_indexes)
        wait_seconds = max(1, min(20, int(next_ready_at - time.monotonic()) + 1))
        for remaining in range(wait_seconds, 0, -1):
            emit_progress(
                30,
                "key-cooldown",
                f"所有可用 Gemini key 暫時冷卻中，{remaining}s 後第 {attempt_index + 1}/{retries} 次重試..."
            )
            time.sleep(1)

    for retry_index in range(retries):
        if len(disabled_key_indexes) >= total_keys:
            raise UserFacingPipelineError(
                format_gemini_permission_error(len(disabled_key_indexes), total_keys)
            )

        available_index = next_available_index()
        if available_index is None:
            sleep_until_next_available(retry_index)
            available_index = next_available_index()
            if available_index is None:
                continue

        client_index = available_index

        try:
            emit_progress(
                30,
                "gemini",
                f"Gemini 分析中... (key {client_index + 1}/{total_keys}, attempt {retry_index + 1}/{retries})"
            )
            response = clients[client_index].models.generate_content(
                model=MODEL_NAME,
                contents=prompt
            )
            return response
        except Exception as error:
            last_error = error
            is_rate_limit = is_gemini_rate_limit_error(error)
            is_service_busy = is_gemini_busy_error(error)
            is_permission_denied = is_gemini_permission_error(error)

            if is_permission_denied:
                disabled_key_indexes.add(client_index)
                emit_progress(
                    30,
                    "permission-denied",
                    f"Gemini API key {client_index + 1}/{total_keys} 權限被拒絕，停用此 key 並切換其他 key..."
                )
                client_index = (client_index + 1) % total_keys
                time.sleep(0.8)
                continue

            if is_rate_limit:
                # The Node job coordinator owns cross-worker key cooldown and
                # rotation. When it assigns one key, return 429 immediately so
                # another worker does not keep waiting on an exhausted slot.
                if total_keys == 1:
                    raise error

                wait_seconds = min(30, 4 + retry_index * 2)
                cooldown_until[client_index] = time.monotonic() + wait_seconds
                emit_progress(
                    30,
                    "rate-limit",
                    f"Gemini API key {client_index + 1}/{total_keys} 觸發 429，冷卻 {wait_seconds}s 並切換其他 key..."
                )
                client_index = (client_index + 1) % total_keys
                continue

            if is_service_busy:
                wait_seconds = min(20, 2 + retry_index)
                cooldown_until[client_index] = time.monotonic() + wait_seconds
                emit_progress(
                    30,
                    "retry",
                    f"Gemini 服務暫時不可用，key {client_index + 1}/{total_keys} 冷卻 {wait_seconds}s 並切換重試..."
                )
                client_index = (client_index + 1) % total_keys
                continue

            raise error

    if len(disabled_key_indexes) >= total_keys:
        raise UserFacingPipelineError(
            format_gemini_permission_error(len(disabled_key_indexes), total_keys)
        )
    if last_error:
        raise Exception(f"在自適應切換與等待 {retries} 次後，Gemini 仍無法完成請求：{last_error}")
    raise Exception(f"在自適應切換與等待 {retries} 次後，所有 Gemini API key 仍無法完成請求。")


def sanitize_pipeline_error(error):
    if isinstance(error, UserFacingPipelineError):
        return str(error)
    if is_gemini_permission_error(error):
        return format_gemini_permission_error(1, 1)
    return f"AI 匯入流程失敗：{error}"


def repair_json(text):
    text = re.sub(r"^```json\s*|```\s*$", "", text.strip(), flags=re.MULTILINE)
    array_match = re.search(r"\[\s*{.*}\s*\]", text, flags=re.DOTALL)
    if array_match:
        text = array_match.group(0)
    text = re.sub(r"\\(?![\\\"/bfnrtu])", r"\\\\", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", text)
    text = re.sub(r",\s*\]", "]", text)
    text = re.sub(r",\s*\}", "}", text)
    return text


def escape_control_chars_in_strings(text):
    result = []
    in_string = False
    escaped = False

    for char in text:
        if in_string:
            if escaped:
                result.append(char)
                escaped = False
                continue

            if char == "\\":
                result.append(char)
                escaped = True
                continue

            if char == '"':
                result.append(char)
                in_string = False
                continue

            if char == "\n":
                result.append("\\n")
                continue

            if char == "\r":
                result.append("\\r")
                continue

            if char == "\t":
                result.append("\\t")
                continue

            if ord(char) < 32:
                result.append(" ")
                continue

            result.append(char)
            continue

        result.append(char)
        if char == '"':
            in_string = True

    return "".join(result)


def repair_missing_json_commas(text, max_repairs=20):
    """Insert only structurally provable missing commas between JSON members."""
    candidate = str(text or "")
    for _ in range(max_repairs):
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError as error:
            if error.msg != "Expecting ',' delimiter":
                return candidate

            cursor = error.pos
            while cursor < len(candidate) and candidate[cursor].isspace():
                cursor += 1
            previous_cursor = cursor - 1
            while previous_cursor >= 0 and candidate[previous_cursor].isspace():
                previous_cursor -= 1

            starts_object_member = (
                cursor < len(candidate)
                and candidate[cursor] == '"'
                and re.match(r'^"(?:[^"\\]|\\.)*"\s*:', candidate[cursor:])
            )
            starts_adjacent_container = (
                cursor < len(candidate)
                and candidate[cursor] in "[{"
                and previous_cursor >= 0
                and candidate[previous_cursor] in "]}"
            )
            if not starts_object_member and not starts_adjacent_container:
                return candidate

            candidate = f"{candidate[:cursor]},{candidate[cursor:]}"

    return candidate


def parse_json_payload(text):
    cleaned = repair_missing_json_commas(repair_json(text))

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return json.loads(escape_control_chars_in_strings(cleaned))


def build_json_repair_prompt(bad_json_text):
    return f"""
你是 JSON 修復器。請把下面內容修正成可被 Python json.loads 解析的合法 JSON。

硬性規則：
1. 只能輸出 JSON 陣列
2. 不可加入任何說明
3. 不可加入 Markdown
4. 保留原本欄位與資料內容
5. 若有未跳脫雙引號、漏逗號、控制字元、尾逗號，請修正
6. 欄位順序保持原樣

待修復內容：
{bad_json_text}
"""


def parse_json_payload_with_fallback(text, api_keys):
    cleaned = repair_json(text)
    parse_errors = []
    locally_repaired = repair_missing_json_commas(cleaned)

    for candidate in (
        cleaned,
        escape_control_chars_in_strings(cleaned),
        locally_repaired,
        escape_control_chars_in_strings(locally_repaired)
    ):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as error:
            parse_errors.append(error)

    emit_progress(72, "repair-json", "JSON 格式受損，送交 Gemini 修復...")
    repaired_response = call_gemini_with_retry(build_json_repair_prompt(cleaned), api_keys, retries=6)
    repaired_text = repair_json(getattr(repaired_response, "text", "") or "")
    locally_repaired_response = repair_missing_json_commas(repaired_text)

    for candidate in (
        repaired_text,
        escape_control_chars_in_strings(repaired_text),
        locally_repaired_response,
        escape_control_chars_in_strings(locally_repaired_response)
    ):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as error:
            parse_errors.append(error)

    raise parse_errors[-1]


class GeneratedOutputValidationError(ValueError):
    """Raised when an AI draft violates the stable word-output contract."""

    def __init__(self, errors):
        self.errors = list(errors)
        preview = "；".join(self.errors[:8])
        if len(self.errors) > 8:
            preview += f"；另有 {len(self.errors) - 8} 項"
        super().__init__(preview)


def normalize_ch_groups(value):
    if isinstance(value, list):
        if value and all(not isinstance(item, list) for item in value):
            group = [str(item).strip() for item in value if str(item).strip()]
            return [group] if group else []

        groups = []
        for item in value:
            if not isinstance(item, list):
                continue
            group = [str(part).strip() for part in item if str(part).strip()]
            if group:
                groups.append(group)
        return groups

    text = str(value or "").strip()
    if not text:
        return []

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return normalize_ch_groups(parsed)
    except Exception:
        pass

    return [
        [entry]
        for entry in parse_ch_entries(text)
        if entry
    ]


def normalize_example_value(value):
    return [
        {
            "eng": str(item.get("eng", "")).strip(),
            "ch": str(item.get("ch", "")).strip()
        }
        for item in parse_example_items(value)
        if str(item.get("eng", "")).strip() and str(item.get("ch", "")).strip()
    ]


def normalize_words(items):
    rows = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue

        rows.append(
            {
                "eng": str(item.get("eng", "")).strip(),
                "kk": str(item.get("kk", "")).strip(),
                "tense": str(item.get("tense", "")).strip(),
                "ch": normalize_ch_groups(item.get("ch", "")),
                "analysis": str(item.get("analysis", item.get("anlaysis", ""))).strip(),
                "definition": str(item.get("definition", "")).strip(),
                "example": normalize_example_value(item.get("example", ""))
            }
        )
    return rows


def normalize_ch_value(value):
    return normalize_ch_groups(value)


def parse_ch_entries(value):
    if not value:
        return []

    if isinstance(value, list):
        entries = []
        for item in value:
            entries.extend(parse_ch_entries(item))
        return list(dict.fromkeys(entry for entry in entries if entry))

    text = str(value or "").strip()
    if not text:
        return []

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parse_ch_entries(parsed)
    except Exception:
        pass

    entries = []
    for part in re.split(r"[\n；;。]+", text):
        cleaned = str(part).strip().strip("[]'\"")
        cleaned = re.sub(r"^\d+\.\s*", "", cleaned)
        cleaned = cleaned.strip()
        if cleaned:
            entries.append(cleaned)

    return list(dict.fromkeys(entries))


def parse_example_items(value):
    english_keys = ("eng", "en", "english", "sentence", "example")
    chinese_keys = ("ch", "zh", "zh_tw", "chinese", "translation")

    def first_value(item, keys):
        for key in keys:
            if key in item and item[key] is not None:
                return item[key]
        return ""

    def pair_values(english_value, chinese_value):
        if isinstance(english_value, list) and isinstance(chinese_value, list):
            return [
                {"eng": str(eng).strip(), "ch": str(ch).strip()}
                for eng, ch in zip(english_value, chinese_value)
                if str(eng).strip() and str(ch).strip()
            ]

        english_text = str(english_value or "").strip()
        chinese_text = str(chinese_value or "").strip()
        if english_text and chinese_text:
            return [{"eng": english_text, "ch": chinese_text}]
        return []

    if isinstance(value, dict):
        direct_items = pair_values(
            first_value(value, english_keys),
            first_value(value, chinese_keys)
        )
        if direct_items:
            return direct_items

        nested_items = []
        for nested_key in ("examples", "items", "sentences", "data"):
            if nested_key in value:
                nested_items.extend(parse_example_items(value[nested_key]))
        if nested_items:
            return nested_items

        for nested_value in value.values():
            if isinstance(nested_value, (dict, list)):
                nested_items.extend(parse_example_items(nested_value))
        return nested_items

    if isinstance(value, list):
        items = []
        for item in value:
            items.extend(parse_example_items(item))
        return items

    text = str(value or "").strip()
    if not text:
        return []

    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None

    if parsed is not None and parsed != value:
        return parse_example_items(parsed)

    for separator in ("\n", "｜", "||", "=>", "→"):
        parts = [part.strip() for part in text.split(separator) if part.strip()]
        if len(parts) != 2:
            continue
        english_text, chinese_text = parts
        if re.search(r"[A-Za-z]", english_text) and re.search(r"[\u3400-\u9fff]", chinese_text):
            return [{"eng": english_text, "ch": chinese_text}]

    return []


def validate_definition_alignment(definition, group_count):
    text = str(definition or "").strip()
    if not text:
        return False

    segments = re.split(r";\s*(?=\d+\.\s*)", text)
    if len(segments) != group_count:
        return False

    return all(
        re.match(rf"^{index}\.\s*\S", segment.strip())
        for index, segment in enumerate(segments, start=1)
    )


def normalize_tense_value(value):
    text = re.sub(r"\s+", " ", str(value or "").strip().lower())
    if text in ALLOWED_TENSE_VALUES:
        return text
    return TENSE_VALUE_ALIASES.get(text, str(value or "").strip())


def normalize_definition_numbering(value, group_count):
    text = str(value or "").strip()
    if not text or group_count < 1:
        return text
    if validate_definition_alignment(text, group_count):
        return text

    segments = [
        re.sub(r"^\d+\.\s*", "", segment).strip()
        for segment in re.split(r"\s*;\s*|\n+", text)
        if re.sub(r"^\d+\.\s*", "", segment).strip()
    ]
    if len(segments) != group_count:
        return text
    return "; ".join(
        f"{index}. {segment}"
        for index, segment in enumerate(segments, start=1)
    )


def generated_row_quality_score(row):
    return (
        len(row.get("ch") or []) * 100
        + len(row.get("example") or []) * 80
        + len(str(row.get("analysis", "")))
        + len(str(row.get("definition", "")))
        + len(str(row.get("kk", "")))
    )


def canonicalize_generated_rows(
    items,
    expected_words=None,
    reference_items=None
):
    """Repair harmless model variance before enforcing semantic invariants."""
    warnings = []
    rows = normalize_words(items)
    expected_order = []
    expected_seen = set()
    for word in expected_words or []:
        normalized = normalize_lemma(word)
        if normalized and normalized not in expected_seen:
            expected_seen.add(normalized)
            expected_order.append(normalized)

    reference_tenses_by_word = {}
    for item in reference_items or []:
        if not isinstance(item, dict):
            continue
        normalized_eng = normalize_lemma(item.get("eng", ""))
        normalized_tense = normalize_tense_value(item.get("tense", ""))
        if normalized_eng and normalized_tense in ALLOWED_TENSE_VALUES:
            reference_tenses_by_word.setdefault(normalized_eng, []).append(normalized_tense)

    generated_indexes_by_word = {}
    for index, row in enumerate(rows):
        normalized_eng = normalize_lemma(row.get("eng", ""))
        if normalized_eng:
            generated_indexes_by_word.setdefault(normalized_eng, []).append(index)

    for normalized_eng, row_indexes in generated_indexes_by_word.items():
        reference_tenses = reference_tenses_by_word.get(normalized_eng, [])
        blank_indexes = [index for index in row_indexes if not str(rows[index].get("tense", "")).strip()]
        if not blank_indexes or not reference_tenses:
            continue

        if len(row_indexes) == len(reference_tenses) and len(blank_indexes) == len(row_indexes):
            for row_index, reference_tense in zip(row_indexes, reference_tenses):
                rows[row_index]["tense"] = reference_tense
            warnings.append(f"{normalized_eng} 的空白 tense 已依既有 row 順序還原")
            continue

        unique_reference_tenses = set(reference_tenses)
        if len(unique_reference_tenses) == 1:
            reference_tense = next(iter(unique_reference_tenses))
            for row_index in blank_indexes:
                rows[row_index]["tense"] = reference_tense
            warnings.append(f"{normalized_eng} 的空白 tense 已依唯一既有詞性還原")

    canonical_rows = []
    for row_index, row in enumerate(rows, start=1):
        original_tense = row["tense"]
        row["tense"] = normalize_tense_value(original_tense)
        if row["tense"] != original_tense:
            warnings.append(
                f"第 {row_index} 筆 tense 已由 {original_tense or '(空白)'} 正規化為 {row['tense']}"
            )

        seen_meanings = set()
        deduplicated_groups = []
        for group in row["ch"]:
            cleaned_group = []
            for meaning in group:
                meaning_key = re.sub(r"\s+", "", meaning)
                if not meaning_key or meaning_key in seen_meanings:
                    continue
                seen_meanings.add(meaning_key)
                cleaned_group.append(meaning)
            if cleaned_group:
                deduplicated_groups.append(cleaned_group)
        if deduplicated_groups != row["ch"]:
            warnings.append(f"第 {row_index} 筆 ch 的空白或重複義項已移除")
        if len(deduplicated_groups) > 5:
            warnings.append(f"第 {row_index} 筆 ch 超過五群，依常用度保留前五群")
            deduplicated_groups = deduplicated_groups[:5]
        row["ch"] = deduplicated_groups

        if len(row["example"]) > 5:
            warnings.append(f"第 {row_index} 筆 example 超過五筆，保留前五筆")
            row["example"] = row["example"][:5]

        normalized_definition = normalize_definition_numbering(
            row["definition"],
            len(row["ch"])
        )
        if normalized_definition != row["definition"]:
            warnings.append(f"第 {row_index} 筆 definition 編號已正規化")
            row["definition"] = normalized_definition

        normalized_eng = normalize_lemma(row["eng"])
        if expected_seen and normalized_eng not in expected_seen:
            warnings.append(f"第 {row_index} 筆非輸入單字 {row['eng']} 已移除")
            continue
        canonical_rows.append(row)

    unique_rows = {}
    unkeyed_rows = []
    for row in canonical_rows:
        row_key = build_row_key_from_value(row) if row.get("tense") else ""
        if not row_key:
            unkeyed_rows.append(row)
            continue
        previous = unique_rows.get(row_key)
        if previous is None:
            unique_rows[row_key] = row
            continue
        if generated_row_quality_score(row) > generated_row_quality_score(previous):
            unique_rows[row_key] = row
        warnings.append(f"重複 row {row_key} 已合併並保留資訊較完整者")

    deduplicated_rows = list(unique_rows.values()) + unkeyed_rows
    first_seen_words = []
    first_seen_set = set()
    for row in deduplicated_rows:
        normalized_eng = normalize_lemma(row.get("eng", ""))
        if normalized_eng and normalized_eng not in first_seen_set:
            first_seen_set.add(normalized_eng)
            first_seen_words.append(normalized_eng)
    word_order = expected_order or first_seen_words
    word_indexes = {word: index for index, word in enumerate(word_order)}
    pos_indexes = {tense: index for index, tense in enumerate(POS_OUTPUT_ORDER)}
    original_indexes = {id(row): index for index, row in enumerate(deduplicated_rows)}
    deduplicated_rows.sort(
        key=lambda row: (
            word_indexes.get(normalize_lemma(row.get("eng", "")), len(word_indexes)),
            pos_indexes.get(row.get("tense", ""), len(pos_indexes)),
            original_indexes[id(row)]
        )
    )

    return deduplicated_rows, warnings


def validate_generated_rows(
    items,
    expected_words=None,
    allow_missing_expected=False,
    allow_empty_examples=False,
    allow_empty_tense=False
):
    errors = []
    if not isinstance(items, list) or not items:
        raise GeneratedOutputValidationError(["輸出必須是非空 JSON 陣列"])

    normalized_expected = []
    expected_seen = set()
    for word in expected_words or []:
        normalized = normalize_lemma(word)
        if normalized and normalized not in expected_seen:
            expected_seen.add(normalized)
            normalized_expected.append(normalized)

    actual_word_order = []
    actual_word_seen = set()
    actual_words = set()
    row_keys = set()
    last_pos_index_by_word = {}

    for row_index, item in enumerate(items, start=1):
        prefix = f"第 {row_index} 筆"
        if not isinstance(item, dict):
            errors.append(f"{prefix}不是 JSON object")
            continue

        eng = str(item.get("eng", "")).strip()
        normalized_eng = normalize_lemma(eng)
        tense = str(item.get("tense", "")).strip()
        if not normalized_eng:
            errors.append(f"{prefix} eng 為空")
        else:
            actual_words.add(normalized_eng)
            if normalized_eng not in actual_word_seen:
                actual_word_seen.add(normalized_eng)
                actual_word_order.append(normalized_eng)

        if tense not in ALLOWED_TENSE_VALUES and not (allow_empty_tense and not tense):
            errors.append(f"{prefix} tense 非法：{tense or '(空白)'}")

        row_key = build_row_key(eng, tense)
        if row_key and not (allow_empty_tense and not tense):
            if row_key in row_keys:
                errors.append(f"{prefix}重複 eng + tense：{row_key}")
            row_keys.add(row_key)

        if normalized_eng and tense in POS_OUTPUT_ORDER:
            pos_index = POS_OUTPUT_ORDER.index(tense)
            previous_index = last_pos_index_by_word.get(normalized_eng, -1)
            if pos_index < previous_index:
                errors.append(f"{prefix}詞性排列順序錯誤：{normalized_eng} {tense}")
            last_pos_index_by_word[normalized_eng] = pos_index

        ch_value = item.get("ch")
        if not isinstance(ch_value, list) or not ch_value:
            errors.append(f"{prefix} ch 必須是非空陣列")
            groups = []
        elif all(not isinstance(group, list) for group in ch_value):
            group = [str(part).strip() for part in ch_value if str(part).strip()]
            groups = [group] if group else []
            if len(group) != len(ch_value):
                errors.append(f"{prefix} ch 含空白義項")
        elif all(isinstance(group, list) for group in ch_value):
            groups = []
            for group_index, group in enumerate(ch_value, start=1):
                cleaned_group = [str(part).strip() for part in group if str(part).strip()]
                if not cleaned_group or len(cleaned_group) != len(group):
                    errors.append(f"{prefix} ch 第 {group_index} 群為空或含空白")
                else:
                    groups.append(cleaned_group)
        else:
            groups = []
            errors.append(f"{prefix} ch 不可混用字串與子陣列")

        if groups and not 1 <= len(groups) <= 5:
            errors.append(f"{prefix} ch 群組數必須介於 1 到 5")
        meaning_owners = {}
        for group_index, group in enumerate(groups, start=1):
            for meaning in group:
                meaning_key = re.sub(r"\s+", "", meaning)
                previous_group = meaning_owners.get(meaning_key)
                if previous_group is not None:
                    errors.append(
                        f"{prefix} ch「{meaning}」重複出現在第 "
                        f"{previous_group} 與第 {group_index} 群"
                    )
                else:
                    meaning_owners[meaning_key] = group_index

        analysis = str(item.get("analysis", "")).strip()
        if not analysis:
            errors.append(f"{prefix} analysis 為空")

        definition = str(item.get("definition", "")).strip()
        if not definition:
            errors.append(f"{prefix} definition 為空")

        examples = item.get("example")
        if not isinstance(examples, list):
            errors.append(f"{prefix} example 必須是陣列")
            examples = []
        elif not examples and not allow_empty_examples:
            errors.append(f"{prefix} example 不可為空")

        if len(examples) > 5:
            errors.append(f"{prefix} example 不可超過五筆")
        for example_index, example in enumerate(examples, start=1):
            if not isinstance(example, dict) or tuple(example.keys()) != ("eng", "ch"):
                errors.append(f"{prefix}第 {example_index} 例句格式錯誤")
                continue
            if not str(example.get("eng", "")).strip() or not str(example.get("ch", "")).strip():
                errors.append(f"{prefix}第 {example_index} 例句英中欄位不可為空")

    if normalized_expected:
        expected_set = set(normalized_expected)
        missing_words = [word for word in normalized_expected if word not in actual_words]
        unexpected_words = [word for word in actual_word_order if word not in expected_set]
        if missing_words and not allow_missing_expected:
            errors.append(f"遺漏輸入單字：{', '.join(missing_words)}")
        if unexpected_words:
            errors.append(f"擅自新增或改寫輸入單字：{', '.join(unexpected_words)}")
        if not missing_words and not unexpected_words and actual_word_order != normalized_expected:
            errors.append("輸出單字順序與輸入順序不一致")

    if errors:
        raise GeneratedOutputValidationError(errors)
    return items


def parse_and_validate_response(
    response,
    api_keys,
    expected_words=None,
    allow_missing_expected=False,
    allow_empty_examples=False,
    allow_empty_tense=False,
    reference_items=None
):
    payload = parse_json_payload_with_fallback(
        getattr(response, "text", "") or "",
        api_keys
    )
    normalized_rows, warnings = canonicalize_generated_rows(
        payload,
        expected_words=expected_words,
        reference_items=reference_items
    )
    if warnings:
        emit_progress(
            58,
            "normalize",
            f"已自適應修正 {len(warnings)} 項格式差異：{'；'.join(warnings[:3])}"
        )
    validate_generated_rows(
        normalized_rows,
        expected_words=expected_words,
        allow_missing_expected=allow_missing_expected,
        allow_empty_examples=allow_empty_examples,
        allow_empty_tense=allow_empty_tense
    )
    return normalized_rows


def dump_json_for_review(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def normalize_lemma(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def normalize_tense_key(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def build_row_key(eng, tense=""):
    normalized_eng = normalize_lemma(eng)
    if not normalized_eng:
        return ""
    return f"{normalized_eng}::{normalize_tense_key(tense)}"


def build_row_key_from_value(value):
    if not isinstance(value, dict):
        return ""
    return build_row_key(value.get("eng", ""), value.get("tense", ""))


def collect_unique_rows_by_key(rows):
    grouped = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = build_row_key_from_value(row)
        if not key:
            continue
        grouped.setdefault(key, []).append(row)
    return {key: items[0] for key, items in grouped.items() if len(items) == 1}


def format_words_list(words):
    return "\n".join(f"{index + 1}. {word}" for index, word in enumerate(words))


def collect_words_from_rows(*row_sets):
    words = []
    seen = set()
    for rows in row_sets:
        for row in rows or []:
            word = normalize_lemma(row.get("eng", "")) if isinstance(row, dict) else ""
            if word and word not in seen:
                seen.add(word)
                words.append(word)
    return words


def build_targeted_conversion_audit_block(input_words):
    targets = []
    seen = set()
    for word in input_words or []:
        normalized = normalize_lemma(word)
        if normalized in OMISSION_SENSITIVE_POS_GROUPS and normalized not in seen:
            seen.add(normalized)
            targets.append(normalized)

    if not targets:
        return ""

    target_lines = "\n".join(
        f"- {word}: 必須覆蓋 {describe_pos_group(OMISSION_SENSITIVE_POS_GROUPS[word][0])}"
        f" 與 {describe_pos_group(OMISSION_SENSITIVE_POS_GROUPS[word][1])}"
        for word in targets
    )
    return f"""
# Input-specific Conversion Audit
下列實際輸入字屬於已驗證的高風險漏詞性字，只檢查這些字，不可把規則套到其他輸入：
{target_lines}
各 row 仍須遵守正面證據門檻、單一詞性、常用義分層與 vt./vi. 規則。
"""


def normalize_existing_row_payload(value, fallback_eng="", fallback_tense="", fallback_kk=""):
    if not isinstance(value, dict):
        return None

    rows = normalize_words(
        [
            {
                "eng": value.get("eng", fallback_eng),
                "kk": value.get("kk", fallback_kk),
                "tense": value.get("tense", fallback_tense),
                "ch": value.get("ch", ""),
                "analysis": value.get("analysis", value.get("anlaysis", "")),
                "definition": value.get("definition", ""),
                "example": value.get("example", "")
            }
        ]
    )
    if not rows:
        return None

    row = rows[0]
    row["eng"] = row["eng"] or str(fallback_eng or "").strip()
    row["tense"] = row["tense"] or str(fallback_tense or "").strip()
    row["kk"] = row["kk"] or str(fallback_kk or "").strip()
    return row


def normalize_exam_meanings(value):
    rows = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict):
            meaning_text = str(item.get("meaningText", item.get("meaning_text", ""))).strip()
            meaning_index = item.get("meaningIndex", item.get("meaning_index", None))
        else:
            meaning_text = str(item or "").strip()
            meaning_index = None

        if not meaning_text:
            continue

        parsed_index = None
        try:
            parsed_index = int(meaning_index)
        except Exception:
            parsed_index = None

        rows.append(
            {
                "meaningIndex": parsed_index,
                "meaningText": meaning_text
            }
        )
    return rows


def normalize_input_word_items(payload):
    if isinstance(payload, dict):
        raw_items = payload.get("items", payload.get("words", []))
    else:
        raw_items = payload

    items = []
    for raw_item in raw_items if isinstance(raw_items, list) else []:
        if isinstance(raw_item, dict):
            eng = str(raw_item.get("eng", raw_item.get("word", ""))).strip()
            kk = str(raw_item.get("kk", "")).strip()
            tense = str(raw_item.get("tense", "")).strip()
            existing = normalize_existing_row_payload(
                raw_item.get("existing"),
                fallback_eng=eng,
                fallback_tense=tense,
                fallback_kk=kk
            )
            exam_meanings = normalize_exam_meanings(
                raw_item.get("examMeanings", raw_item.get("exam_meanings", []))
            )
        else:
            eng = str(raw_item or "").strip()
            kk = ""
            tense = ""
            existing = None
            exam_meanings = []

        if not eng:
            continue

        items.append(
            {
                "eng": eng,
                "kk": kk,
                "tense": tense,
                "existing": existing,
                "examMeanings": exam_meanings
            }
        )

    return items


def build_existing_context_for_prompt(input_items):
    context_rows = []
    for item in input_items or []:
        existing = item.get("existing")
        exam_meanings = item.get("examMeanings", [])
        if not existing and not exam_meanings:
            continue

        row = {
            "eng": item.get("eng", ""),
            "tense": item.get("tense", "")
        }
        if existing:
            row["existing"] = {
                "ch": existing.get("ch", ""),
                "analysis": existing.get("analysis", ""),
                "definition": existing.get("definition", ""),
                "example": existing.get("example", "")
            }
        if exam_meanings:
            row["examMeanings"] = exam_meanings
        context_rows.append(row)

    if not context_rows:
        return ""

    return dump_json_for_review(context_rows)


def describe_pos_group(group):
    return " / ".join(group)


def find_required_pos_coverage_gaps(rows, input_words=None):
    tense_by_word = {}
    for row in rows:
        if not isinstance(row, dict):
            continue

        word = normalize_lemma(row.get("eng", ""))
        tense = str(row.get("tense", "")).strip().lower()
        if not word:
            continue

        tense_by_word.setdefault(word, set())
        if tense:
            tense_by_word[word].add(tense)

    if input_words is None:
        candidate_words = sorted(set(tense_by_word) & set(OMISSION_SENSITIVE_POS_GROUPS))
    else:
        candidate_words = []
        seen = set()
        for word in input_words:
            normalized = normalize_lemma(word)
            if normalized in OMISSION_SENSITIVE_POS_GROUPS and normalized not in seen:
                seen.add(normalized)
                candidate_words.append(normalized)

    gaps = []
    for word in candidate_words:
        available_tenses = tense_by_word.get(word, set())
        missing_groups = [
            describe_pos_group(group)
            for group in OMISSION_SENSITIVE_POS_GROUPS[word]
            if not any(option.lower() in available_tenses for option in group)
        ]

        if missing_groups:
            gaps.append({"word": word, "missing": missing_groups})

    return gaps


def summarize_required_pos_gaps(gaps):
    return "; ".join(
        f"{gap['word']} 缺少 {'、'.join(gap['missing'])}"
        for gap in gaps
    )


def build_required_pos_repair_prompt(source_label, source_text, current_rows, coverage_gaps):
    missing_lines = "\n".join(
        f"- {gap['word']}: 缺少 {'、'.join(gap['missing'])}"
        for gap in coverage_gaps
    )
    return f"""
# Role
{SECOND_PASS_EXPANSION_AUDIT_BLOCK}
{SHARED_GENERATION_CONTRACT_BLOCK}

你是聚焦式多詞性修正器。只修正下列實際缺漏，保留其他已通過驗證的 row 與欄位。

# Mandatory Repair Target
目前草稿缺少已驗證的常見詞性：
{missing_lines}

# Hard Rules
1. 你必須回傳完整修正後的 JSON 陣列，不是只回傳新增的幾筆。
2. 保留目前正確且高品質的 analysis / definition / example，不可因修正而降精度。
3. 只補上面列出的實際目標，不可順帶增加無證據詞性或低頻義。
4. vt. / vi. 只有在句型或常見義明顯不同時拆分，否則使用 v.。
5. 不可把不同詞性的 ch、definition 或 example 混在同一筆。
6. 修正後仍須符合固定七欄、1–5 群及一群一例句的輸出合約。

# Source Context
{source_label}
{source_text}

# Current JSON Draft
{dump_json_for_review(current_rows)}
"""


def audit_required_pos_coverage(
    rows,
    api_keys,
    source_label,
    source_text,
    input_words=None,
    expected_words=None
):
    coverage_gaps = find_required_pos_coverage_gaps(rows, input_words=input_words)
    if not coverage_gaps:
        return rows

    emit_progress(
        86,
        "coverage-repair",
        f"偵測到高風險漏詞性，送交 Gemini 強制補齊：{summarize_required_pos_gaps(coverage_gaps)}"
    )

    repair_response = call_gemini_with_retry(
        build_required_pos_repair_prompt(source_label, source_text, rows, coverage_gaps),
        api_keys,
        retries=8
    )
    validation_words = expected_words or collect_words_from_rows(rows)
    repaired_rows = parse_and_validate_response(
        repair_response,
        api_keys,
        expected_words=validation_words
    )
    if not repaired_rows:
        raise ValueError("高風險漏詞性修正後沒有產出有效資料。")

    remaining_gaps = find_required_pos_coverage_gaps(repaired_rows, input_words=input_words)
    if remaining_gaps:
        raise ValueError(f"高風險多詞性覆核未通過：{summarize_required_pos_gaps(remaining_gaps)}")

    emit_progress(89, "coverage-approved", "高風險多詞性覆核通過。")
    return repaired_rows


def build_second_pass_review_prompt_from_ocr(raw_text, first_pass_rows):
    detected_words = collect_words_from_rows(first_pass_rows)
    targeted_audit = build_targeted_conversion_audit_block(detected_words)
    return f"""
# Role
{SECOND_PASS_EXPANSION_AUDIT_BLOCK}
你是英文詞彙、詞源、構詞、繁體中文翻譯與 OCR 校對的高精度審稿者。
{SHARED_GENERATION_CONTRACT_BLOCK}
{targeted_audit}

# OCR Raw Text
{raw_text}

# First-pass JSON Draft
{dump_json_for_review(first_pass_rows)}
"""


def build_second_pass_review_prompt_from_words(words, first_pass_rows):
    words_text = format_words_list(words)
    targeted_audit = build_targeted_conversion_audit_block(words)
    return f"""
# Role
{SECOND_PASS_EXPANSION_AUDIT_BLOCK}
你是英文詞彙、詞源、構詞與繁體中文翻譯的高精度審稿者。
{SHARED_GENERATION_CONTRACT_BLOCK}
{targeted_audit}

# Input Words
{words_text}

# First-pass JSON Draft
{dump_json_for_review(first_pass_rows)}
"""


def build_third_pass_review_prompt_from_ocr(raw_text, first_pass_rows, second_pass_rows):
    detected_words = collect_words_from_rows(first_pass_rows, second_pass_rows)
    targeted_audit = build_targeted_conversion_audit_block(detected_words)
    return f"""
# Role
{THIRD_PASS_FINAL_AUDIT_BLOCK}
你是英文詞彙、詞源、構詞、繁體中文翻譯與 OCR 校對的最終仲裁者。
{SHARED_GENERATION_CONTRACT_BLOCK}
{targeted_audit}

# OCR Raw Text
{raw_text}

# First-pass JSON Draft
{dump_json_for_review(first_pass_rows)}

# Second-pass JSON Draft
{dump_json_for_review(second_pass_rows)}
"""


def build_third_pass_review_prompt_from_words(words, first_pass_rows, second_pass_rows, input_items=None):
    words_text = format_words_list(words)
    targeted_audit = build_targeted_conversion_audit_block(words)
    existing_context = build_existing_context_for_prompt(input_items or [])
    existing_section = (
        f"""

# Existing Data Context
下列 existing 僅用於防止空白、縮水、誤刪，以及保護已標記的重要中文義項；不可盲目照抄。
若 examMeanings 中某個中文義項在你的最終 ch 中仍然成立，優先保留同一個中文字面，避免無必要改寫。
{existing_context}
"""
        if existing_context
        else ""
    )
    return f"""
# Role
{THIRD_PASS_FINAL_AUDIT_BLOCK}
你是英文詞彙、詞源、構詞與繁體中文翻譯的最終仲裁者。
{SHARED_GENERATION_CONTRACT_BLOCK}
{targeted_audit}

# Input Words
{words_text}
{existing_section}

# First-pass JSON Draft
{dump_json_for_review(first_pass_rows)}

# Second-pass JSON Draft
{dump_json_for_review(second_pass_rows)}
"""


def field_has_value(field_name, value):
    if field_name == "ch":
        return bool(parse_ch_entries(value))
    if field_name == "example":
        return bool(parse_example_items(value))
    return bool(str(value or "").strip())


def apply_row_field_fallback(row, field_name, candidate_sources):
    if field_has_value(field_name, row.get(field_name, "")):
        return row

    for candidate in candidate_sources:
        if not isinstance(candidate, dict):
            continue
        candidate_value = candidate.get(field_name, "")
        if field_has_value(field_name, candidate_value):
            row[field_name] = candidate_value
            return row

    return row


def apply_third_pass_safeguards(final_rows, second_pass_rows, first_pass_rows, input_items=None):
    normalized_final_rows = normalize_words(final_rows)
    if not normalized_final_rows:
        return normalize_words(second_pass_rows)

    final_key_counts = {}
    for row in normalized_final_rows:
        key = build_row_key_from_value(row)
        if key:
            final_key_counts[key] = final_key_counts.get(key, 0) + 1

    unique_second = collect_unique_rows_by_key(normalize_words(second_pass_rows))
    unique_first = collect_unique_rows_by_key(normalize_words(first_pass_rows))
    unique_existing = collect_unique_rows_by_key(
        [item["existing"] for item in (input_items or []) if isinstance(item.get("existing"), dict)]
    )

    safeguarded_rows = []
    for row in normalized_final_rows:
        row_copy = dict(row)
        key = build_row_key_from_value(row_copy)
        if key and final_key_counts.get(key, 0) == 1:
            candidate_sources = [
                unique_second.get(key),
                unique_first.get(key),
                unique_existing.get(key)
            ]
            for field_name in ("ch", "analysis", "definition", "example"):
                row_copy = apply_row_field_fallback(row_copy, field_name, candidate_sources)
        safeguarded_rows.append(row_copy)

    return safeguarded_rows


def restore_fully_missing_words(
    rows,
    fallback_row_sets=None,
    input_items=None
):
    """Restore a word only when every generated row for that word vanished."""
    restored_rows = normalize_words(rows)
    present_words = {
        normalize_lemma(row.get("eng", ""))
        for row in restored_rows
        if normalize_lemma(row.get("eng", ""))
    }
    restored_words = []
    fallback_sources = [
        normalize_words(source_rows)
        for source_rows in (fallback_row_sets or [])
        if source_rows
    ]
    fallback_sources.append(
        [
            item["existing"]
            for item in (input_items or [])
            if isinstance(item, dict) and isinstance(item.get("existing"), dict)
        ]
    )

    for source_rows in fallback_sources:
        rows_by_word = {}
        for source_row in source_rows:
            normalized_eng = normalize_lemma(source_row.get("eng", ""))
            if normalized_eng:
                rows_by_word.setdefault(normalized_eng, []).append(source_row)
        for normalized_eng, matching_rows in rows_by_word.items():
            if normalized_eng in present_words:
                continue
            restored_rows.extend(matching_rows)
            restored_words.append(normalized_eng)
            present_words.add(normalized_eng)

    return restored_rows, restored_words


def generate_words_with_three_pass_review(
    primary_prompt,
    second_pass_prompt_builder,
    third_pass_prompt_builder,
    api_keys,
    source_label="",
    source_text="",
    input_words=None,
    input_items=None
):
    expected_words = input_words if input_words else None
    emit_progress(20, "review", "第一次 AI 分析中...")
    response = call_gemini_with_retry(primary_prompt, api_keys)

    emit_progress(58, "parse", "解析第一次 AI 草稿...")
    try:
        first_pass_rows = parse_and_validate_response(
            response,
            api_keys,
            expected_words=expected_words,
            allow_missing_expected=bool(expected_words),
            allow_empty_examples=True,
            allow_empty_tense=True,
            reference_items=input_items
        )
    except Exception as error:
        fail(f"第一次 AI 草稿驗證失敗：{error}")

    emit_progress(68, "second-review", "第一次草稿完成，送交第二次 AI 送審...")
    try:
        review_response = call_gemini_with_retry(second_pass_prompt_builder(first_pass_rows), api_keys, retries=10)
        emit_progress(82, "second-parse", "解析二次送審結果...")
        second_pass_rows = parse_and_validate_response(
            review_response,
            api_keys,
            expected_words=expected_words,
            allow_missing_expected=bool(expected_words),
            allow_empty_examples=True,
            allow_empty_tense=True,
            reference_items=input_items
        )
        emit_progress(88, "second-approved", "二次送審完成，準備最終仲裁。")
    except Exception as error:
        emit_progress(84, "second-fallback", f"二次送審失敗，沿用第一次結果：{error}")
        second_pass_rows = normalize_words(first_pass_rows)

    emit_progress(90, "third-review", "第二次草稿完成，送交第三次 AI 送審...")
    try:
        third_response = call_gemini_with_retry(
            third_pass_prompt_builder(first_pass_rows, second_pass_rows),
            api_keys,
            retries=8
        )
        emit_progress(94, "third-parse", "解析第三次送審結果...")
        third_payload = parse_json_payload_with_fallback(
            getattr(third_response, "text", "") or "",
            api_keys
        )
        third_pass_rows, third_warnings = canonicalize_generated_rows(
            third_payload,
            expected_words=expected_words,
            reference_items=input_items
        )
        if third_warnings:
            emit_progress(
                94,
                "third-normalize",
                f"第三次送審已自適應修正 {len(third_warnings)} 項格式差異。"
            )
        final_rows = apply_third_pass_safeguards(
            third_pass_rows,
            second_pass_rows,
            first_pass_rows,
            input_items=input_items
        )
        final_rows, restored_words = restore_fully_missing_words(
            final_rows,
            fallback_row_sets=[second_pass_rows, first_pass_rows],
            input_items=input_items
        )
        if restored_words:
            emit_progress(
                95,
                "existing-fallback",
                f"最終稿遺漏 {len(restored_words)} 個輸入單字，已由前稿或既有資料安全回退。"
            )
        final_rows, final_warnings = canonicalize_generated_rows(
            final_rows,
            expected_words=expected_words,
            reference_items=input_items
        )
        if final_warnings:
            emit_progress(
                95,
                "final-normalize",
                f"最終稿已自適應修正 {len(final_warnings)} 項格式差異。"
            )
        validate_generated_rows(final_rows, expected_words=expected_words)
        emit_progress(96, "third-approved", "第三次送審完成，採用最終仲裁結果。")
    except Exception as error:
        emit_progress(94, "third-fallback", f"第三次送審失敗，沿用第二次結果：{error}")
        final_rows = apply_third_pass_safeguards(
            second_pass_rows,
            second_pass_rows,
            first_pass_rows,
            input_items=input_items
        )
        final_rows, restored_words = restore_fully_missing_words(
            final_rows,
            fallback_row_sets=[first_pass_rows],
            input_items=input_items
        )
        if restored_words:
            emit_progress(
                95,
                "existing-fallback",
                f"最終送審 fallback 遺漏 {len(restored_words)} 個輸入單字，已由前稿或既有資料安全回退。"
            )
        final_rows, fallback_warnings = canonicalize_generated_rows(
            final_rows,
            expected_words=expected_words,
            reference_items=input_items
        )
        if fallback_warnings:
            emit_progress(
                95,
                "fallback-normalize",
                f"fallback 稿已自適應修正 {len(fallback_warnings)} 項格式差異。"
            )
        try:
            validate_generated_rows(final_rows, expected_words=expected_words)
        except Exception as validation_error:
            fail(f"三次送審後仍有不可安全寫入的缺漏：{validation_error}")

    if source_label and source_text:
        try:
            final_rows = audit_required_pos_coverage(
                final_rows,
                api_keys,
                source_label,
                source_text,
                input_words=input_words,
                expected_words=expected_words
            )
        except Exception as error:
            emit_progress(
                96,
                "coverage-fallback",
                f"聚焦詞性修補未通過驗證，保留最後有效稿：{error}"
            )

    return final_rows


def build_primary_generation_prompt(source_label, source_text, input_words=None, ocr_mode=False):
    if ocr_mode:
        input_contract = """
# OCR Input Contract
1. 清除明顯版面符號，修正常見 OCR 混淆、錯誤切開或黏合，但不可把標題、頁碼或雜訊當單字。
2. 依拼字距離、上下文與常見度選擇最合理修正；無法可靠判定的 token 不可猜成另一個字。
3. 重複單字依第一次出現位置只處理一次；一般字轉小寫，專有名詞保留必要大寫。
4. 片語原則上拆成單字；只有語義不可組合推得的固定詞項才保留整體。
"""
    else:
        input_contract = """
# English-list Input Contract
1. 每個輸入項目都必須至少產生一個 row，重複輸入依第一次出現位置去重。
2. eng 必須保留輸入表面詞形；不可擅自修正拼字、改成 lemma 或新增未輸入單字。
3. 片語輸入視為使用者指定的整體詞項，不可自行拆成其他 eng。
"""

    targeted_audit = build_targeted_conversion_audit_block(input_words or [])
    return f"""
# Role
{FIRST_PASS_FOCUS_BLOCK}
你是英文詞彙、歷史語言學、詞源、構詞與繁體中文翻譯的高精度分析者。
{input_contract}
{SHARED_GENERATION_CONTRACT_BLOCK}
{targeted_audit}

{source_label}
{source_text}
""".strip()


def build_prompt(raw_text):
    return build_primary_generation_prompt(
        "# OCR Raw Text",
        raw_text,
        ocr_mode=True
    )



def build_words_only_prompt(words):
    words_text = format_words_list(words)
    return build_primary_generation_prompt(
        "# Input Words",
        words_text,
        input_words=words,
        ocr_mode=False
    )



def ocr_image_text(image_path):
    path = Path(image_path)
    if not path.exists():
        fail("找不到要辨識的圖片檔案。")

    emit_progress(10, "ocr", "OCR 辨識中...")
    raw_text = pytesseract.image_to_string(
        Image.open(path),
        lang="chi_tra+eng",
        config="--oem 3 --psm 6"
    ).strip()

    if not raw_text:
        fail("OCR 沒有辨識出任何文字。")

    return raw_text


def image_to_words(image_path):
    api_keys = load_gemini_api_keys()
    if not api_keys:
        fail("請設定 GEMINI_API_KEY 或 GEMINI_API_KEYS。")

    raw_text = ocr_image_text(image_path)
    emit_progress(12, "review", "OCR 完成，準備送往 Gemini 分析...")
    rows = generate_words_with_three_pass_review(
        build_prompt(raw_text),
        lambda first_pass_rows: build_second_pass_review_prompt_from_ocr(raw_text, first_pass_rows),
        lambda first_pass_rows, second_pass_rows: build_third_pass_review_prompt_from_ocr(
            raw_text,
            first_pass_rows,
            second_pass_rows
        ),
        api_keys,
        source_label="# OCR Raw Text",
        source_text=raw_text
    )

    emit_progress(90, "finalize", "整理辨識結果...")
    emit_result(
        {
            "ok": True,
            "ocrText": raw_text,
            "words": rows
        }
    )


def image_to_ocr_only(image_path):
    raw_text = ocr_image_text(image_path)
    emit_progress(90, "finalize", "OCR 完成，等待人工核對...")
    emit_result(
        {
            "ok": True,
            "ocrText": raw_text,
            "words": []
        }
    )


def reviewed_ocr_json_to_words(json_path):
    api_keys = load_gemini_api_keys()
    if not api_keys:
        fail("請設定 GEMINI_API_KEY 或 GEMINI_API_KEYS。")

    path = Path(json_path)
    if not path.exists():
        fail("找不到 OCR 核對 JSON 檔案。")

    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as error:
        fail(f"OCR 核對 JSON 解析失敗：{error}")

    raw_text = str(payload.get("ocrText", "")).strip()
    if not raw_text:
        fail("沒有可送交 AI 的 OCR 文字。")

    emit_progress(12, "review", "已讀取人工核對 OCR，準備送往 Gemini 分析...")
    rows = generate_words_with_three_pass_review(
        build_prompt(raw_text),
        lambda first_pass_rows: build_second_pass_review_prompt_from_ocr(raw_text, first_pass_rows),
        lambda first_pass_rows, second_pass_rows: build_third_pass_review_prompt_from_ocr(
            raw_text,
            first_pass_rows,
            second_pass_rows
        ),
        api_keys,
        source_label="# OCR Raw Text",
        source_text=raw_text
    )

    emit_progress(90, "finalize", "整理辨識結果...")
    emit_result(
        {
            "ok": True,
            "ocrText": raw_text,
            "words": rows
        }
    )


def words_json_to_words(json_path):
    api_keys = load_gemini_api_keys()
    if not api_keys:
        fail("請設定 GEMINI_API_KEY 或 GEMINI_API_KEYS。")

    path = Path(json_path)
    if not path.exists():
        fail("找不到英文列表檔案。")

    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as error:
        fail(f"英文列表 JSON 解析失敗：{error}")

    input_items = normalize_input_word_items(payload)
    words = [item["eng"] for item in input_items]

    if not words:
        fail("沒有可送交 AI 的英文單字。")

    emit_progress(10, "prepare", f"已載入 {len(words)} 個英文單字。")
    emit_progress(12, "review", "送往 Gemini 進行英文單字重掃...")
    normalized_rows = generate_words_with_three_pass_review(
        build_words_only_prompt(words),
        lambda first_pass_rows: build_second_pass_review_prompt_from_words(words, first_pass_rows),
        lambda first_pass_rows, second_pass_rows: build_third_pass_review_prompt_from_words(
            words,
            first_pass_rows,
            second_pass_rows,
            input_items=input_items
        ),
        api_keys,
        source_label="# Input Words",
        source_text=format_words_list(words),
        input_words=words,
        input_items=input_items
    )
    emit_progress(90, "finalize", "整理英文重掃結果...")
    emit_result(
        {
            "ok": True,
            "ocrText": "",
            "words": normalized_rows
        }
    )


if __name__ == "__main__":
    try:
        if len(sys.argv) < 2:
            fail("請提供圖片路徑或英文列表檔案。")

        if sys.argv[1] == "--ocr-only":
            if len(sys.argv) < 3:
                fail("請提供圖片檔案。")
            image_to_ocr_only(sys.argv[2])
        elif sys.argv[1] == "--ocr-text-json":
            if len(sys.argv) < 3:
                fail("請提供 OCR 核對 JSON 檔案。")
            reviewed_ocr_json_to_words(sys.argv[2])
        elif sys.argv[1] == "--words-json":
            if len(sys.argv) < 3:
                fail("請提供英文列表 JSON 檔案。")
            words_json_to_words(sys.argv[2])
        else:
            image_to_words(sys.argv[1])
    except SystemExit:
        raise
    except Exception as error:
        fail(sanitize_pipeline_error(error))
