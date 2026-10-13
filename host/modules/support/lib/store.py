"""On-disk state for the support module. One append-only message log, one registry, one read set."""
import json
import os
import time
from pathlib import Path

import gauth

STATE = gauth.STATE
FORMS_PATH = STATE / "forms.json"
MESSAGES_PATH = STATE / "messages.jsonl"
READ_PATH = STATE / "read.json"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _write_json(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_forms():
    return _read_json(FORMS_PATH, {"version": 1, "scanned_at": "", "forms": []})


def save_forms(doc):
    _write_json(FORMS_PATH, doc)


def load_read():
    return set(_read_json(READ_PATH, {"ids": []}).get("ids") or [])


def save_read(ids):
    _write_json(READ_PATH, {"ids": sorted(ids)})


def load_messages():
    if not MESSAGES_PATH.is_file():
        return []
    out = []
    with MESSAGES_PATH.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def merge_messages(incoming):
    """Append only what we have not stored before. Returns the genuinely new ones.

    Google gives every response a stable `responseId`, so dedupe is exact and re-fetching the
    whole history is always safe.
    """
    existing = {m["id"] for m in load_messages()}
    fresh = [m for m in incoming if m["id"] not in existing]
    if fresh:
        MESSAGES_PATH.parent.mkdir(parents=True, exist_ok=True)
        with MESSAGES_PATH.open("a", encoding="utf-8") as handle:
            for message in fresh:
                handle.write(json.dumps(message, ensure_ascii=False) + "\n")
    return fresh
