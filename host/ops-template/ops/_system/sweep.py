#!/usr/bin/env python3
"""
sweep.py — keep the ACTIVE layer lean automatically.

The brain is two tiers (see CLAUDE.md): a lean ACTIVE layer that gets injected, and a LEDGER
that's saved for review/grep but never injected. Over time the active layer accumulates resolved
items. This sweep enforces "delete when stale" mechanically:

  - backlog.md    : move every `[x]` done line into log/<year>.md
  - decisions/    : drop `superseded` / `reversed` lines from the active index
                    (their full entry stays in the ledger decisions/<year>.md — nothing is lost)
  - work/         : archive any work/<id>.md not listed in work/index.md's Active section
  - caps          : warn when active tasks > 25 or active work streams > 15

Nothing is deleted irrecoverably: tasks/work move to */archive/, decisions keep their ledger
entry, and it's all in git. Run from anywhere; it operates on the ops/ it lives in.

  python3 ops/_system/sweep.py            # apply
  python3 ops/_system/sweep.py --dry      # preview, change nothing
"""
import argparse, os, re, sys
from datetime import datetime

OPS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # this file is ops/_system/sweep.py

def read(p):
    try:
        return open(p, encoding="utf-8").read()
    except Exception:
        return None

def write(p, s, dry):
    if dry:
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)

def append(p, s, dry):
    if dry:
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(s)

def sweep_tasks(dry, report):
    p = os.path.join(OPS, "backlog.md")
    txt = read(p)
    if txt is None:
        return
    lines = txt.split("\n")
    done = [l for l in lines if l.lstrip().startswith("- [x]")]
    active = [l for l in lines if l.lstrip().startswith("- [ ]")]
    if done:
        year = datetime.now().strftime("%Y")
        arch = os.path.join(OPS, "log", year + ".md")
        stamp = datetime.now().strftime("%Y-%m-%d")
        append(arch, "\n".join("%s | %s" % (stamp, l.strip()[5:].strip().lstrip("|").strip()) for l in done) + "\n", dry)
        kept = [l for l in lines if not l.lstrip().startswith("- [x]")]
        write(p, "\n".join(kept), dry)
        report.append("backlog: archived %d done -> log/%s.md" % (len(done), year))
    else:
        report.append("backlog: 0 done to archive")
    if len(active) > 25:
        report.append("  ⚠ %d queued items (cap 25) — close/merge, don't grow" % len(active))

DEC_LINE = re.compile(r"^\s*-\s*(D-\d+)\s*\|\s*[^|]*\|\s*(\w+)")

def sweep_decisions(dry, report):
    p = os.path.join(OPS, "decisions", "index.md")
    txt = read(p)
    if txt is None:
        return
    lines = txt.split("\n")
    out, pruned = [], []
    for l in lines:
        m = DEC_LINE.match(l)
        if m and m.group(2).lower() in ("superseded", "reversed"):
            pruned.append(m.group(1))
            continue
        out.append(l)
    if pruned:
        write(p, "\n".join(out), dry)
        report.append("decisions: pruned %s from active index (full entry stays in ledger)"
                      % ", ".join(pruned))
    else:
        report.append("decisions: 0 superseded/reversed in active index")
    active = [l for l in out if DEC_LINE.match(l)]
    report.append("  %d active decisions in index" % len(active))

def sweep_work(dry, report):
    wdir = os.path.join(OPS, "work")
    idx = read(os.path.join(wdir, "index.md"))
    if idx is None:
        return
    # active stream ids = first field of each pipe line under the file
    listed = set()
    for l in idx.split("\n"):
        m = re.match(r"^([a-z0-9][\w-]+)\s*\|", l.strip())
        if m:
            listed.add(m.group(1))
    orphans = []
    for fn in sorted(os.listdir(wdir)) if os.path.isdir(wdir) else []:
        if not fn.endswith(".md") or fn in ("index.md", "_template.md"):
            continue
        sid = fn[:-3]
        if sid not in listed:
            orphans.append(fn)
    for fn in orphans:
        src = os.path.join(wdir, fn)
        dst = os.path.join(wdir, "archive", fn)
        if not dry:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)
    if orphans:
        report.append("work: archived %d orphan stream(s) -> work/archive/: %s"
                      % (len(orphans), ", ".join(orphans)))
    else:
        report.append("work: 0 orphan streams")
    if len(listed) > 15:
        report.append("  ⚠ %d active work streams (cap 15) — WIP overload, close/merge" % len(listed))

def main():
    ap = argparse.ArgumentParser(prog="sweep.py")
    ap.add_argument("--dry", action="store_true", help="preview only, change nothing")
    a = ap.parse_args()
    report = []
    sweep_tasks(a.dry, report)
    sweep_decisions(a.dry, report)
    sweep_work(a.dry, report)
    head = "ops sweep — %s%s" % (datetime.now().strftime("%Y-%m-%d %H:%M"),
                                 "  (DRY RUN)" if a.dry else "")
    print(head)
    for r in report:
        print("  " + r)

if __name__ == "__main__":
    main()
