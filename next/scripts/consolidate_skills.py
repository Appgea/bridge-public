#!/usr/bin/env python3
"""Move personal skill sources into Panel. Preserve originals through symlinks.

Print the plan by default. --apply performs the reversible migration.
Provider-managed .system and plugin packages remain provider-owned.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
from datetime import datetime, timezone


def migrate(home: Path, panel: Path, apply: bool = False):
    root = panel / "skills"
    sources = [home / ".claude/skills", home / ".codex/skills", home / ".agents/skills"]
    groups = {}
    for source in [root, *sources]:
        if not source.exists():
            continue
        for entry in sorted(source.iterdir()):
            if entry.name.startswith(".") or not (entry / "SKILL.md").is_file():
                continue
            groups.setdefault(entry.name, []).append(entry)

    # Read every collision before moving anything. Conflicting content stays untouched.
    for name, entries in groups.items():
        seen = {}
        for entry in entries:
            for file in entry.rglob("*"):
                if not file.is_file() or file.is_symlink():
                    continue
                relative = file.relative_to(entry)
                previous = seen.get(relative)
                if previous and previous.read_bytes() != file.read_bytes():
                    raise RuntimeError(f"Conflicting {name}/{relative}: {previous} and {file}")
                seen[relative] = file
        destination = root / name
        for source in sources:
            link = source / name
            if os.path.lexists(link) and link not in entries:
                raise RuntimeError(f"Occupied discovery path: {link}")
        print(f"{name}: {destination}")
    if not apply:
        return len(groups)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = panel / "state/skills/migrations" / stamp
    backup.mkdir(parents=True)
    journal = []

    def record(action, source, destination):
        journal.append({"action": action, "source": str(source), "destination": str(destination)})
        (backup / "journal.json").write_text(json.dumps(journal, indent=2) + "\n")

    root.mkdir(parents=True, exist_ok=True)
    for name, entries in groups.items():
        destination = root / name
        if not destination.exists():
            original = entries[0].resolve()
            record("move", original, destination)
            original.rename(destination)
            original.symlink_to(destination, target_is_directory=True)
        for entry in entries:
            if entry.resolve() == destination.resolve():
                continue
            # Duplicate entrypoints matched above. Retain provider UI metadata too.
            for file in entry.rglob("*"):
                target = destination / file.relative_to(entry)
                if file.is_file() and not os.path.lexists(target):
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, target)
            saved = backup / f"{entry.parent.parent.name.lstrip('.')}-{name}"
            record("backup", entry, saved)
            entry.rename(saved)
            entry.symlink_to(destination, target_is_directory=True)
        for source in sources:
            source.mkdir(parents=True, exist_ok=True)
            link = source / name
            if os.path.lexists(link):
                if link.resolve() != destination.resolve():
                    raise RuntimeError(f"Discovery path changed during migration: {link}")
                continue
            record("link", link, destination)
            link.symlink_to(destination, target_is_directory=True)
    print(f"Migration journal: {backup / 'journal.json'}")
    return len(groups)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    migrate(Path.home(), Path(os.environ.get("PANEL_USER_HOME", Path.home() / ".appgeapanel")), args.apply)
