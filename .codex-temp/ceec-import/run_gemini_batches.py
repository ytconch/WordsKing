import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path


ALLOWED_FIELDS = {"eng", "kk", "tense", "ch", "analysis", "definition", "example"}
ALLOWED_POS = {"n.", "vt.", "vi.", "v.", "adj.", "adv.", "prep.", "conj.", "pron.", "interj.", "det.", "aux.", "modal v."}
PRINT_LOCK = threading.Lock()


def load_dotenv(path):
    values = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def normalize_word(value):
    return " ".join(str(value or "").split()).casefold()


def validate_rows(inputs, rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError("Gemini returned no rows")

    expected = {normalize_word(word) for word in inputs}
    actual = set()
    row_keys = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or set(row) != ALLOWED_FIELDS:
            raise ValueError(f"row {index + 1} has an invalid field contract")

        eng = str(row.get("eng", "")).strip()
        tense = str(row.get("tense", "")).strip()
        actual.add(normalize_word(eng))
        row_key = (normalize_word(eng), tense)
        if row_key in row_keys:
            raise ValueError(f"duplicate eng + tense: {eng} / {tense}")
        row_keys.add(row_key)

        if tense not in ALLOWED_POS:
            raise ValueError(f"invalid POS: {eng} / {tense}")
        if not str(row.get("kk", "")).strip():
            raise ValueError(f"empty KK: {eng} / {tense}")
        if not str(row.get("analysis", "")).strip() or not str(row.get("definition", "")).strip():
            raise ValueError(f"empty analysis or definition: {eng} / {tense}")

        meanings = row.get("ch")
        examples = row.get("example")
        if not isinstance(meanings, list) or not 1 <= len(meanings) <= 5:
            raise ValueError(f"invalid Chinese meanings: {eng} / {tense}")
        if not isinstance(examples, list) or not examples:
            raise ValueError(f"empty examples: {eng} / {tense}")
        for example in examples:
            if not isinstance(example, dict) or not str(example.get("eng", "")).strip() or not str(example.get("ch", "")).strip():
                raise ValueError(f"invalid example: {eng} / {tense}")

    missing = expected - actual
    extra = actual - expected
    if missing or extra:
        raise ValueError(f"surface coverage mismatch; missing={sorted(missing)}, extra={sorted(extra)}")


def read_valid_result(path, expected_inputs):
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("inputs") != expected_inputs:
        return None
    validate_rows(expected_inputs, payload.get("rows"))
    return payload


def run_chunk(task, project_root, pipeline_path, results_dir, api_key, worker_index, worker_count, python_exe):
    level, chunk_index, inputs = task
    result_path = results_dir / f"level-{level}-chunk-{chunk_index:03d}.json"
    try:
        cached = read_valid_result(result_path, inputs)
        if cached:
            with PRINT_LOCK:
                print(f"CACHED level={level} chunk={chunk_index} rows={len(cached['rows'])}", flush=True)
            return result_path
    except Exception:
        pass

    payload_path = results_dir / f"level-{level}-chunk-{chunk_index:03d}.input.json"
    payload_path.write_text(json.dumps({"words": inputs}, ensure_ascii=False, indent=2), encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "GEMINI_API_KEY": api_key,
            "GEMINI_API_KEYS": api_key,
            "GEMINI_WORKER_INDEX": str(worker_index),
            "GEMINI_WORKER_COUNT": str(worker_count),
            "PYTHONUTF8": "1",
        }
    )

    with PRINT_LOCK:
        print(f"START level={level} chunk={chunk_index} words={len(inputs)} worker={worker_index}/{worker_count}", flush=True)

    started = time.time()
    completed = subprocess.run(
        [python_exe, str(pipeline_path), "--words-json", str(payload_path)],
        cwd=project_root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=45 * 60,
    )
    result = None
    progress_tail = []
    for line in completed.stdout.splitlines():
        if line.startswith("__WK_RESULT__"):
            result = json.loads(line[len("__WK_RESULT__"):])
        elif line.startswith("__WK_PROGRESS__"):
            progress_tail.append(line[len("__WK_PROGRESS__"):])
            progress_tail = progress_tail[-5:]

    if completed.returncode != 0 or not result or not result.get("ok"):
        error = (result or {}).get("error") or completed.stderr.strip() or f"pipeline exit {completed.returncode}"
        raise RuntimeError(f"level={level} chunk={chunk_index}: {error}; progress={progress_tail}")

    rows = result.get("words")
    validate_rows(inputs, rows)
    output = {"level": level, "chunkIndex": chunk_index, "inputs": inputs, "rows": rows}
    temp_path = result_path.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(result_path)
    payload_path.unlink(missing_ok=True)

    with PRINT_LOCK:
        print(f"DONE level={level} chunk={chunk_index} rows={len(rows)} elapsed={time.time() - started:.1f}s", flush=True)
    return result_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--chunk-size", type=int, default=50)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    project_root = Path.cwd()
    pipeline_path = project_root / "scripts" / "image_word_pipeline.py"
    env_values = load_dotenv(project_root / ".env")
    api_keys = [item.strip() for item in re_split_keys(env_values.get("GEMINI_API_KEYS") or env_values.get("GEMINI_API_KEY", "")) if item.strip()]
    api_keys = list(dict.fromkeys(api_keys))
    if not api_keys:
        raise ValueError("No Gemini API keys configured")

    if env_values.get("GEMINI_MODEL"):
        os.environ["GEMINI_MODEL"] = env_values["GEMINI_MODEL"]

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    all_tasks = []
    for level in range(1, 7):
        words = manifest["levels"][str(level)]
        for offset in range(0, len(words), args.chunk_size):
            all_tasks.append((level, offset // args.chunk_size + 1, words[offset:offset + args.chunk_size]))

    tasks = []
    cached_count = 0
    for task in all_tasks:
        level, chunk_index, inputs = task
        result_path = args.results / f"level-{level}-chunk-{chunk_index:03d}.json"
        try:
            if read_valid_result(result_path, inputs):
                cached_count += 1
                continue
        except Exception:
            pass
        tasks.append(task)

    if args.limit:
        tasks = tasks[: args.limit]

    args.results.mkdir(parents=True, exist_ok=True)
    if not tasks:
        print(f"COMPLETE chunks={len(all_tasks)} cached={cached_count} workers=0", flush=True)
        return

    print(f"PENDING chunks={len(tasks)} cached={cached_count}", flush=True)
    worker_count = min(len(api_keys), len(tasks))
    assignments = [[] for _ in range(worker_count)]
    for index, task in enumerate(tasks):
        assignments[index % worker_count].append(task)

    def run_worker(index):
        paths = []
        failures = []
        for task in assignments[index]:
            for attempt in range(1, 4):
                try:
                    paths.append(
                        run_chunk(
                            task,
                            project_root,
                            pipeline_path,
                            args.results,
                            api_keys[index],
                            index + 1,
                            worker_count,
                            sys.executable,
                        )
                    )
                    break
                except Exception as error:
                    with PRINT_LOCK:
                        print(f"RETRY level={task[0]} chunk={task[1]} attempt={attempt}/3 error={error}", flush=True)
                    if attempt == 3:
                        failures.append(str(error))
                    else:
                        time.sleep(5)
        return paths, failures

    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(run_worker, index) for index in range(worker_count)]
        for future in concurrent.futures.as_completed(futures):
            _paths, worker_failures = future.result()
            failures.extend(worker_failures)

    if failures:
        raise RuntimeError(f"{len(failures)} chunk(s) failed after retries: {failures}")

    print(f"COMPLETE chunks={len(tasks)} workers={worker_count}", flush=True)


def re_split_keys(value):
    import re

    return re.split(r"[\r\n,;|]+", value)


if __name__ == "__main__":
    main()
