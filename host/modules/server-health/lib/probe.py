"""The checks. Standard library only — no new dependency enters Panel for this.

A target is a URL plus a list of check kinds. Each check answers one narrow question and
returns a verdict; the target's state is the worst verdict it collected. The split that
matters is `down` vs `degraded`: unreachable is an outage, a certificate with three weeks
left is not. Waking someone for the second teaches them to ignore the first.
"""
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlsplit

USER_AGENT = "panel-server-health/1"

# Verdict severity, worst last. A target's state is the max of its checks.
ORDER = ["ok", "degraded", "down"]


def _worse(a, b):
    return a if ORDER.index(a) >= ORDER.index(b) else b


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _host_port(url):
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.hostname or "", port


def _check(kind, ok, detail, severity="down"):
    return {"kind": kind, "ok": bool(ok), "detail": detail,
            "severity": "ok" if ok else severity}


# --- individual checks -------------------------------------------------------

def check_dns(url, target):
    host, _ = _host_port(url)
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        addrs = sorted({i[4][0] for i in infos})
        return _check("dns", True, ", ".join(addrs[:3]))
    except OSError as e:
        return _check("dns", False, "%s does not resolve (%s)" % (host, e))


def check_tcp(url, target):
    host, port = _host_port(url)
    port = target.get("port") or port
    t = target.get("timeout_s", 10)
    try:
        with socket.create_connection((host, port), timeout=t):
            return _check("tcp", True, "port %d open" % port)
    except OSError as e:
        return _check("tcp", False, "port %d shut (%s)" % (port, e))


def _fetch(url, target, follow):
    """One HTTP request. Returns (status, headers, body_bytes, elapsed_ms) or raises."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    opener = urllib.request.build_opener()
    if not follow:
        opener = urllib.request.build_opener(_NoRedirect)
    started = time.monotonic()
    try:
        with opener.open(req, timeout=target.get("timeout_s", 10)) as resp:
            body = resp.read(target.get("max_bytes", 262144))
            elapsed = int((time.monotonic() - started) * 1000)
            return resp.status, dict(resp.headers), body, elapsed
    except urllib.error.HTTPError as e:
        # A 4xx/5xx is an answer, not a failure to reach. Let the expectation judge it.
        body = e.read(target.get("max_bytes", 262144))
        elapsed = int((time.monotonic() - started) * 1000)
        return e.code, dict(e.headers), body, elapsed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check_http(url, target, state):
    expect = target.get("expect") or {}
    want = expect.get("status", 200)
    try:
        status, headers, body, ms = _fetch(url, target, follow=expect.get("follow_redirects", True))
    except Exception as e:
        return _check("http", False, "no answer (%s)" % _short(e))
    state["status"] = status
    state["headers"] = headers
    state["body"] = body
    state["latency_ms"] = ms
    if status != want:
        return _check("http", False, "got %d, expected %d" % (status, want))
    return _check("http", True, "%d in %dms" % (status, ms))


def check_redirect(url, target, state):
    expect = target.get("expect") or {}
    want = (expect.get("redirects_to") or "").lower()
    try:
        status, headers, _body, ms = _fetch(url, target, follow=False)
    except Exception as e:
        return _check("redirect", False, "no answer (%s)" % _short(e))
    state["latency_ms"] = ms
    state["status"] = status
    if status not in (301, 302, 303, 307, 308):
        return _check("redirect", False, "expected a redirect, got %d" % status)
    location = headers.get("Location", "")
    if want and want not in location.lower():
        return _check("redirect", False, "%d to %s, expected %s" % (status, location, want))
    return _check("redirect", True, "%d to %s" % (status, location))


def check_tls(url, target):
    host, port = _host_port(url)
    if urlsplit(url).scheme != "https":
        return _check("tls", True, "plain http, nothing to check")
    warn = target.get("tls_warn_days", 21)
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=target.get("timeout_s", 10)) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
    except Exception as e:
        return _check("tls", False, "handshake failed (%s)" % _short(e))
    not_after = cert.get("notAfter")
    if not not_after:
        return _check("tls", True, "no expiry in certificate")
    try:
        expires = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return _check("tls", True, "unparsed expiry %s" % not_after)
    days = (expires - datetime.now(timezone.utc)).days
    if days < 0:
        return _check("tls", False, "expired %d days ago" % -days)
    if days < warn:
        return _check("tls", False, "%d days left" % days, severity="degraded")
    return _check("tls", True, "%d days left" % days)


def check_json(url, target, state):
    want = ((target.get("expect") or {}).get("json")) or {}
    body = state.get("body")
    if body is None:
        return _check("json", False, "no body to read")
    try:
        doc = json.loads(body.decode("utf-8", "replace"))
    except Exception as e:
        return _check("json", False, "not json (%s)" % _short(e))
    state["json"] = doc
    if not isinstance(doc, dict):
        return _check("json", True, "parses")
    misses = []
    for key, expected in want.items():
        actual = doc.get(key)
        if actual != expected:
            misses.append("%s=%r (wanted %r)" % (key, actual, expected))
    if misses:
        # A server answering with its own bad news is degraded, not unreachable.
        return _check("json", False, "; ".join(misses), severity="degraded")
    shown = ", ".join("%s=%s" % (k, doc[k]) for k in list(doc)[:3])
    return _check("json", True, shown or "parses")


def check_json_parses(url, target, state):
    body = state.get("body")
    if body is None:
        return _check("json_parses", False, "no body to read")
    try:
        json.loads(body.decode("utf-8", "replace"))
    except Exception as e:
        return _check("json_parses", False, "not json (%s)" % _short(e))
    return _check("json_parses", True, "%d bytes parse" % len(body))


def check_body(url, target, state):
    needle = ((target.get("expect") or {}).get("body_contains")) or ""
    body = state.get("body")
    if body is None:
        return _check("body", False, "no body to read")
    text = body.decode("utf-8", "replace")
    if needle and needle.lower() not in text.lower():
        return _check("body", False, "%r absent from %d bytes" % (needle, len(body)))
    return _check("body", True, "%r present" % needle if needle else "%d bytes" % len(body))


def check_latency(url, target, state):
    """Recorded, never an outage on its own. A slow VPS is news; it is not a page."""
    ms = state.get("latency_ms")
    if ms is None:
        return _check("latency", False, "not measured", severity="degraded")
    slow = target.get("slow_ms", 2500)
    if ms > slow:
        return _check("latency", False, "%dms, over %dms" % (ms, slow), severity="degraded")
    return _check("latency", True, "%dms" % ms)


def _short(e):
    text = str(e) or type(e).__name__
    return re.sub(r"\s+", " ", text)[:120]


# --- the runner --------------------------------------------------------------

# Order matters: the ones that fill `state` run before the ones that read it.
_NEEDS_STATE = {"http", "redirect", "json", "json_parses", "body", "latency"}
_SEQUENCE = ["dns", "tcp", "http", "redirect", "tls", "json", "json_parses", "body", "latency"]


def probe(target):
    """Run one target's checks and fold them into a single result."""
    result = {
        "id": target.get("id", "?"),
        "label": target.get("label") or target.get("id", "?"),
        "url": target.get("url", ""),
        "project": target.get("project"),
        "note": target.get("note"),
        "checked_at": _now(),
    }
    if not target.get("enabled", True):
        result.update({"state": "skipped", "checks": [], "failed": [], "latency_ms": None})
        return result

    url = target.get("url") or ""
    if not url:
        result.update({"state": "down", "checks": [], "latency_ms": None,
                       "failed": ["no url configured"]})
        return result

    wanted = [k for k in _SEQUENCE if k in (target.get("checks") or ["dns", "http"])]
    state = {}
    checks = []
    reached = True
    for kind in wanted:
        # Once the box is unreachable the rest is noise. Report it once, plainly.
        if not reached and kind in _NEEDS_STATE:
            continue
        if kind == "dns":
            c = check_dns(url, target)
        elif kind == "tcp":
            c = check_tcp(url, target)
        elif kind == "http":
            c = check_http(url, target, state)
        elif kind == "redirect":
            c = check_redirect(url, target, state)
        elif kind == "tls":
            c = check_tls(url, target)
        elif kind == "json":
            c = check_json(url, target, state)
        elif kind == "json_parses":
            c = check_json_parses(url, target, state)
        elif kind == "body":
            c = check_body(url, target, state)
        elif kind == "latency":
            c = check_latency(url, target, state)
        else:
            continue
        checks.append(c)
        if kind in ("dns", "tcp") and not c["ok"]:
            reached = False
        if kind in ("http", "redirect") and not c["ok"] and "no answer" in c["detail"]:
            reached = False

    worst = "ok"
    for c in checks:
        if not c["ok"]:
            worst = _worse(worst, c["severity"])
    result.update({
        "state": worst if worst != "ok" else "up",
        "checks": checks,
        "failed": ["%s: %s" % (c["kind"], c["detail"]) for c in checks if not c["ok"]],
        "latency_ms": state.get("latency_ms"),
        "status": state.get("status"),
    })
    return result
