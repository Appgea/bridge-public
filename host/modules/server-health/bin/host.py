#!/usr/bin/env python3
"""server-health module host — CGI-argv protocol (same shape as the other modules).

argv: <METHOD> <PATH[?query]>   stdin: body (POST)   stdout: "<status>\\n<ctype>\\n\\n<body>"

Probes the servers behind the portfolio and says which are up. Read-only against the network:
it fetches URLs and reads certificates, nothing else, so no route here is stop-gated.

Also runs headless for the launchd job — `host.py --sweep` — which is how the checks keep
happening while Panel is closed. Same code, same state file; Panel reads it on startup.
"""
import concurrent.futures
import json
import os
import sys
import urllib.request
from urllib.parse import urlsplit, parse_qs

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_MODULE_ROOT, "lib"))

import probe as probe_lib  # noqa: E402
import store  # noqa: E402

# Two consecutive failures before a target counts as down. One timeout on a VPS in Turkiye
# is weather, not an outage, and a monitor that cries on the first packet loss gets muted.
STRIKES_TO_ALARM = 2


def _respond(status, body, ctype="application/json"):
    if isinstance(body, (dict, list)):
        payload = json.dumps(body, ensure_ascii=False).encode()
    elif isinstance(body, str):
        payload = body.encode()
    else:
        payload = body
    sys.stdout.buffer.write(("%d\n%s\n\n" % (status, ctype)).encode())
    sys.stdout.buffer.write(payload)


# --- sweeping ----------------------------------------------------------------

def _sweep(only=None):
    """Probe every enabled target at once and fold the run into the stored state."""
    doc = store.load_targets()
    targets = doc.get("targets") or []
    if only:
        targets = [t for t in targets if t.get("id") == only]
    if not targets:
        return {"version": 1, "checked_at": store.now(), "results": [], "streaks": {}}

    # Network-bound and independent, so a slow box costs its own latency and not everyone else's.
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
        results = list(pool.map(probe_lib.probe, targets))

    previous = store.load_results()
    streaks = dict(previous.get("streaks") or {})
    prior_state = {r.get("id"): r.get("state") for r in (previous.get("results") or [])}

    for r in results:
        tid = r["id"]
        if r["state"] == "down":
            streaks[tid] = int(streaks.get(tid, 0)) + 1
        else:
            streaks[tid] = 0
        r["strikes"] = streaks[tid]
        # `down` is what the probe saw; `confirmed` is what we are willing to wake someone for.
        r["confirmed"] = r["state"] == "down" and streaks[tid] >= STRIKES_TO_ALARM
        r["was"] = prior_state.get(tid)

    if only:
        merged = {r["id"]: r for r in (previous.get("results") or [])}
        for r in results:
            merged[r["id"]] = r
        results = list(merged.values())

    out = {"version": 1, "checked_at": store.now(), "results": results, "streaks": streaks}
    store.save_results(out)
    return out


def _summary(doc):
    results = doc.get("results") or []
    live = [r for r in results if r.get("state") != "skipped"]
    return {
        "total": len(results),
        "watched": len(live),
        "up": sum(1 for r in live if r.get("state") == "up"),
        "degraded": sum(1 for r in live if r.get("state") == "degraded"),
        "down": sum(1 for r in live if r.get("state") == "down"),
        "confirmed_down": sum(1 for r in live if r.get("confirmed")),
        "skipped": sum(1 for r in results if r.get("state") == "skipped"),
        "checked_at": doc.get("checked_at"),
    }


def _portfolio(fresh):
    doc = _sweep() if fresh else (store.load_results() or {})
    if not doc.get("results") and not fresh:
        doc = _sweep()
    return {"summary": _summary(doc), "results": doc.get("results") or [],
            "checked_at": doc.get("checked_at"),
            "targets_path": str(store.targets_path())}


# --- editing the target list -------------------------------------------------

# Served at GET /schema so an agent setting this up does not have to guess the vocabulary or
# read this file. It is the same contract AGENT.md describes in prose.
SCHEMA = {
    "target": {
        "id": "required, unique, short slug — the key everything else refers to",
        "label": "required, what a human calls it",
        "url": "required, the exact URL to fetch, not the apex unless the apex is the thing",
        "checks": "list from: dns, tcp, http, redirect, tls, json, json_parses, body, latency",
        "expect": {
            "status": "expected HTTP status, default 200",
            "json": "object of key/value pairs the response body must match exactly",
            "body_contains": "substring the body must contain, case-insensitive",
            "redirects_to": "host the redirect must point at, for checks:[redirect]",
            "follow_redirects": "default true; false to assert the first response",
        },
        "tls_warn_days": "degraded below this many days left, default 21",
        "timeout_s": "default 10",
        "slow_ms": "degraded above this response time, default 2500",
        "port": "override the port for checks:[tcp]",
        "enabled": "default true; false parks it with the reason in note",
        "note": "why it matters and what breaks when it is down",
        "project": "Panel project id receiving background alerts",
    },
    "states": {
        "up": "every check passed",
        "degraded": "reachable, but a soft check failed — cert near expiry, slow, or the health "
                    "endpoint reporting its own bad news",
        "down": "did not resolve, did not connect, or answered wrong",
        "skipped": "enabled is false",
    },
    "routes": {
        "GET /portfolio": "stored results, no network",
        "GET /portfolio?fresh=1": "probe everything now",
        "GET /check?id=<id>": "probe one",
        "GET /targets": "the current list",
        "POST /targets": "replace the whole list",
        "POST /targets/add": "add or update one target, then probe it and return the result",
        "POST /targets/remove": "{id}",
        "POST /targets/toggle": "{id, enabled}",
    },
}

_ALLOWED = {"id", "label", "url", "checks", "expect", "tls_warn_days", "timeout_s",
            "slow_ms", "port", "enabled", "note", "project"}
_CHECKS = {"dns", "tcp", "http", "redirect", "tls", "json", "json_parses", "body", "latency"}


def _validate(target):
    """Say what is wrong in words the agent that sent it can act on.

    Rejecting an unknown key matters more here than it looks: a typo like `expects` would be
    stored happily and silently monitor nothing, and the board would show a confident green.
    """
    if not isinstance(target, dict):
        return "a target must be an object"
    for key in ("id", "label", "url"):
        if not str(target.get(key) or "").strip():
            return "a target needs id, label and url; missing %s" % key
    unknown = set(target) - _ALLOWED
    if unknown:
        return "unknown field(s): %s — see GET /schema" % ", ".join(sorted(unknown))
    checks = target.get("checks")
    if checks is not None:
        if not isinstance(checks, list) or not all(isinstance(c, str) for c in checks):
            return "checks must be a list of strings"
        bad = [c for c in checks if c not in _CHECKS]
        if bad:
            return "no such check(s): %s — pick from %s" % (
                ", ".join(bad), ", ".join(sorted(_CHECKS)))
    scheme = urlsplit(str(target["url"])).scheme
    if scheme not in ("http", "https"):
        return "url must start with http:// or https://"
    if "tls" in (checks or []) and scheme != "https":
        return "a tls check needs an https url"
    if target.get("expect") is not None and not isinstance(target["expect"], dict):
        return "expect must be an object"
    return None


def _add(d):
    """Add or replace one target, then immediately probe it.

    Probing on add is the point. Most of what goes wrong setting this up is an expectation that
    does not match reality — a health endpoint returning `"ok"` where you wrote `true`. Telling
    the agent at write time turns that into one more call instead of a green board that lies.
    """
    target = d.get("target") if isinstance(d.get("target"), dict) else d
    problem = _validate(target)
    if problem:
        return _respond(400, {"error": problem})
    doc = store.load_targets()
    targets = [t for t in (doc.get("targets") or []) if t.get("id") != target["id"]]
    targets.append(target)
    store.save_targets({"version": 1, "targets": targets})
    result = probe_lib.probe(target)
    return _respond(200, {"ok": True, "target": target, "result": result,
                          "path": str(store.targets_path()),
                          "hint": _hint(result)})


def _hint(result):
    """One sentence an agent can act on, or nothing. Silence when the answer is already right."""
    if result.get("state") == "up":
        return None
    if result.get("state") == "skipped":
        return "stored but not watched — set enabled true to start checking it"
    return "stored, but it did not pass: %s. Fix the server or the expectation, then check again." \
        % "; ".join(result.get("failed") or ["unknown"])


def _remove(d):
    tid = str(d.get("id") or "").strip()
    doc = store.load_targets()
    targets = doc.get("targets") or []
    kept = [t for t in targets if t.get("id") != tid]
    if len(kept) == len(targets):
        return _respond(404, {"error": "no such target: " + tid})
    store.save_targets({"version": 1, "targets": kept})
    return _respond(200, {"ok": True, "removed": tid, "count": len(kept)})


def _toggle(d):
    tid = str(d.get("id") or "").strip()
    doc = store.load_targets()
    targets = doc.get("targets") or []
    hit = next((t for t in targets if t.get("id") == tid), None)
    if not hit:
        return _respond(404, {"error": "no such target: " + tid})
    hit["enabled"] = bool(d.get("enabled", not hit.get("enabled", True)))
    store.save_targets({"version": 1, "targets": targets})
    return _respond(200, {"ok": True, "id": tid, "enabled": hit["enabled"]})


# --- alerting ----------------------------------------------------------------

def _emit_to_panel(doc):
    """Fire-and-forget into the running Panel, if there is one. Never raises: a monitor that
    breaks the run because nobody was listening is worse than a monitor that stayed quiet."""
    port = os.environ.get("PANEL_PORT")
    if not port:
        home = os.environ.get("PANEL_USER_HOME") or os.path.join(
            os.path.expanduser("~"), ".appgeapanel")
        try:
            with open(os.path.join(home, "ingress-port"), encoding="utf-8") as handle:
                port = handle.read().strip()
        except OSError:
            return False
    bad = [r for r in (doc.get("results") or []) if r.get("confirmed")]
    warn = [r for r in (doc.get("results") or []) if r.get("state") == "degraded"]
    recovered = [r for r in (doc.get("results") or [])
                 if r.get("state") == "up" and r.get("was") in ("down", "degraded")]
    if not bad and not warn and not recovered:
        return False

    grouped = {}
    for result in bad + warn + recovered:
        project = str(result.get("project") or "").strip()
        if project:
            grouped.setdefault(project, []).append(result)

    emitted = False
    for project, results in grouped.items():
        project_bad = [r for r in results if r in bad]
        project_warn = [r for r in results if r in warn]
        project_recovered = [r for r in results if r in recovered]
        if project_bad:
            title = "%s down" % ", ".join(r["label"] for r in project_bad)
            outcome = "blocked"
        elif project_warn:
            title = "%s degraded" % ", ".join(r["label"] for r in project_warn)
            outcome = "needs_decision"
        else:
            title = "%s back up" % ", ".join(r["label"] for r in project_recovered)
            outcome = "done"
        lines = [
            "%s — %s" % (r["label"], "; ".join(r.get("failed") or ["recovered"]))
            for r in results
        ]
        flow = [{"ref": r.get("url") or r["id"], "label": r["label"],
                 "detail": "; ".join(r.get("failed") or ["recovered"])} for r in results]
        body = {"project": project, "type": "message", "payload": {
            "title": title, "text": "\n".join(lines), "outcome": outcome,
            "flow": flow, "source": "server-health"}}
        req = urllib.request.Request(
            "http://127.0.0.1:%s/panel/emit" % port,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                reply = json.loads(response.read().decode() or "{}")
            emitted = emitted or reply.get("routed") is True
        except Exception:
            continue
    return emitted


# --- routes ------------------------------------------------------------------

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--sweep":
        doc = _sweep()
        emitted = _emit_to_panel(doc)
        s = _summary(doc)
        sys.stderr.write("server-health %s: %d up, %d degraded, %d down%s\n" % (
            s["checked_at"], s["up"], s["degraded"], s["down"],
            " (told panel)" if emitted else ""))
        return 1 if s["confirmed_down"] else 0

    if len(sys.argv) < 3:
        return _respond(400, {"error": "usage: host.py METHOD PATH  |  host.py --sweep"})
    method, raw_path = sys.argv[1], sys.argv[2]
    parsed = urlsplit(raw_path)
    path, q = parsed.path, parse_qs(parsed.query)

    def qs(name, default=""):
        v = q.get(name)
        return v[0] if v else default

    if method == "GET":
        if path == "/schema":
            return _respond(200, SCHEMA)
        if path == "/portfolio":
            return _respond(200, _portfolio(fresh=qs("fresh") == "1"))
        if path == "/check":
            tid = qs("id")
            doc = _sweep(only=tid or None)
            if tid:
                hit = next((r for r in doc["results"] if r["id"] == tid), None)
                if not hit:
                    return _respond(404, {"error": "no such target: " + tid})
                return _respond(200, hit)
            return _respond(200, {"summary": _summary(doc), "results": doc["results"]})
        if path == "/targets":
            return _respond(200, {"path": str(store.targets_path()), **store.load_targets()})
        return _respond(404, {"error": "no such route: GET " + path})

    if method == "POST":
        try:
            d = json.loads(sys.stdin.buffer.read() or b"{}")
        except Exception:
            d = {}
        if path == "/check":
            doc = _sweep(only=d.get("id"))
            _emit_to_panel(doc)
            return _respond(200, {"summary": _summary(doc), "results": doc["results"],
                                  "checked_at": doc["checked_at"]})
        if path == "/targets/add":
            return _add(d)
        if path == "/targets/remove":
            return _remove(d)
        if path == "/targets/toggle":
            return _toggle(d)
        if path == "/targets":
            targets = d.get("targets")
            if not isinstance(targets, list):
                return _respond(400, {"error": "body must be {\"targets\": [...]}"})
            seen = set()
            for t in targets:
                problem = _validate(t)
                if problem:
                    return _respond(400, {"error": problem})
                if t["id"] in seen:
                    return _respond(400, {"error": "duplicate id: " + t["id"]})
                seen.add(t["id"])
            path_written = store.save_targets({"version": 1, "targets": targets})
            return _respond(200, {"ok": True, "path": str(path_written), "count": len(targets)})
        return _respond(404, {"error": "no such route: POST " + path})

    return _respond(405, {"error": "unsupported method: " + method})


if __name__ == "__main__":
    try:
        code = main()
        sys.exit(code if isinstance(code, int) else 0)
    except Exception as e:
        _respond(500, {"error": "%s: %s" % (type(e).__name__, e)})
