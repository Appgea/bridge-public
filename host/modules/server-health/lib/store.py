"""Where the target list and the last results live.

Never inside the module folder. Once Panel ships as a signed bundle that folder is read-only,
so a write there succeeds on the machine that wrote it and fails on every other one. Panel
hands the writable place over as PANEL_STATE_DIR; a bare CLI run resolves the same path itself.

The results file is the reason checks can run while Panel is closed: launchd writes it, Panel
reads it on startup and shows what it missed.
"""
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
SEED = MODULE_ROOT / "assets" / "targets.default.json"


def state_dir():
    root = os.environ.get("PANEL_STATE_DIR")
    target = Path(root) if root else Path.home() / ".appgeapanel" / "state" / "server-health"
    target.mkdir(parents=True, exist_ok=True)
    return target


def targets_path():
    return state_dir() / "targets.json"


def results_path():
    return state_dir() / "results.json"


def load_targets():
    """The seed is copied out on first run so the file is yours to edit from then on.

    Editing the shipped default would be lost on the next Panel update, and merging a shipped
    list into a hand-edited one is a guessing game. Copy once, then never touch it again.
    """
    path = targets_path()
    if not path.is_file() and SEED.is_file():
        shutil.copyfile(SEED, path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1, "targets": []}
    if not isinstance(doc, dict) or not isinstance(doc.get("targets"), list):
        return {"version": 1, "targets": []}
    return doc


def save_targets(doc):
    doc.setdefault("version", 1)
    _write_atomic(targets_path(), doc)
    return targets_path()


def load_results():
    try:
        return json.loads(results_path().read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1, "checked_at": None, "results": [], "streaks": {}}


def save_results(doc):
    doc.setdefault("version", 1)
    _write_atomic(results_path(), doc)
    return results_path()


def _write_atomic(path, doc):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
