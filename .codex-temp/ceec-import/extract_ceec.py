import argparse
import hashlib
import json
import re
from pathlib import Path

import pdfplumber


EXPECTED_SHA256 = "27B010F8230B2E8763653DDB35783FE9E0140C143B0040F13839046AEBB2A126"
EXPECTED_OFFICIAL_PER_LEVEL = 1002
EXPECTED_EXPANDED_COUNTS = {1: 1056, 2: 1046, 3: 1022, 4: 1028, 5: 1009, 6: 1035}
COLUMNS = ((50, 220), (220, 385), (385, 555))
POS_START = re.compile(r"\s+(?=(?:art|n|v|adj|adv|prep|conj|pron|aux)\.)")


def extract_records(pdf_path):
    records = []
    leftovers = []

    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 116:
            raise ValueError(f"Expected 116 PDF pages, found {len(pdf.pages)}")

        # PDF indexes 64-114 are the alphabetical listing. Each entry ends in its level.
        for page_index in range(64, 115):
            page = pdf.pages[page_index]
            for column_index, (x0, x1) in enumerate(COLUMNS):
                buffer = []
                text = page.crop((x0, 50, x1, 800)).extract_text(layout=False) or ""
                for raw_line in text.splitlines():
                    line = " ".join(raw_line.split())
                    if not line or re.fullmatch(r"[A-Z]", line):
                        continue
                    # Chinese headings use a broken embedded font. Real entries start in Latin script.
                    if not buffer and not re.match(r"^[A-Za-z\u00c0-\u00ff]", line):
                        continue

                    buffer.append(line)
                    joined = " ".join(buffer)
                    match = re.fullmatch(r"(.+?)\s+([1-6])", joined)
                    if match:
                        records.append(
                            {
                                "raw": match.group(1),
                                "level": int(match.group(2)),
                                "page": page_index + 1,
                                "column": column_index + 1,
                            }
                        )
                        buffer = []

                if buffer:
                    leftovers.append((page_index + 1, column_index + 1, " ".join(buffer)))

    if leftovers:
        raise ValueError(f"Unparsed PDF fragments: {leftovers[:5]}")
    return records


def split_entry(raw):
    parts = POS_START.split(raw, maxsplit=1)
    if len(parts) != 2:
        raise ValueError(f"Cannot split entry and POS: {raw!r}")
    return parts[0].strip(), parts[1].strip()


def expand_lexeme(lexeme):
    pronoun_forms = re.fullmatch(r"([A-Za-z\u00c0-\u00ff]+)\s+\(([^)]+)\)", lexeme)
    if pronoun_forms:
        return [pronoun_forms.group(1), *[item.strip() for item in pronoun_forms.group(2).split(",")]]

    expanded = []
    for alternative in lexeme.split("/"):
        # The official list contains no multi-word entries; internal whitespace is a PDF line-wrap artifact.
        alternative = re.sub(r"\s+", "", alternative)
        optional = re.fullmatch(r"([A-Za-z\u00c0-\u00ff-]+)\(([^)]+)\)", alternative)
        if not optional:
            expanded.append(alternative)
            continue

        base, inner = optional.groups()
        expanded.append(base)
        expanded.append(base + inner if inner in {"ment", "ism", "s"} else inner)

    return expanded


def build_manifest(records):
    official_counts = {level: 0 for level in range(1, 7)}
    level_words = {level: [] for level in range(1, 7)}
    seen = {level: set() for level in range(1, 7)}

    for record in records:
        level = record["level"]
        official_counts[level] += 1
        lexeme, _official_pos = split_entry(record["raw"])
        for word in expand_lexeme(lexeme):
            if not word or re.search(r"[()/,\s]", word):
                raise ValueError(f"Invalid expanded word from {record['raw']!r}: {word!r}")
            key = word.casefold()
            if key in seen[level]:
                continue
            seen[level].add(key)
            level_words[level].append(word)

    expected_official = {level: EXPECTED_OFFICIAL_PER_LEVEL for level in range(1, 7)}
    if official_counts != expected_official:
        raise ValueError(f"Official counts changed: {official_counts}")

    expanded_counts = {level: len(level_words[level]) for level in range(1, 7)}
    if expanded_counts != EXPECTED_EXPANDED_COUNTS:
        raise ValueError(f"Expanded counts changed: {expanded_counts}")

    return {
        "sourceName": "大考中心高中英文參考詞彙表",
        "pdfSha256": EXPECTED_SHA256,
        "officialCounts": {str(key): value for key, value in official_counts.items()},
        "expandedCounts": {str(key): value for key, value in expanded_counts.items()},
        "expandedTotal": sum(expanded_counts.values()),
        "levels": {str(level): level_words[level] for level in range(1, 7)},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    digest = hashlib.sha256(args.pdf.read_bytes()).hexdigest().upper()
    if digest != EXPECTED_SHA256:
        raise ValueError(f"PDF SHA-256 mismatch: {digest}")

    manifest = build_manifest(extract_records(args.pdf))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp_output = args.output.with_suffix(args.output.suffix + ".tmp")
    temp_output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_output.replace(args.output)
    print(json.dumps({key: manifest[key] for key in ("officialCounts", "expandedCounts", "expandedTotal")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
