#!/usr/bin/env python3
"""support module host — CGI-argv protocol (same shape as server-health / analytics).

argv: <METHOD> <PATH[?query]>   stdin: body (POST)   stdout: "<status>\\n<ctype>\\n\\n<body>"

Registered projects can publish Google Forms as support channels on store listings,
privacy pages and settings screens. Until this module existed, a person filling
one in reached a spreadsheet nobody opened. This reads all of them in one call.

Read-only against Google: Drive metadata to find the forms, Forms API to read the responses.
Nothing here writes to Google, so no route is stop-gated.

Bare CLI works too:
    python3 bin/host.py POST /fetch
    python3 bin/host.py GET  /inbox?days=90
"""
import json
import os
import sys
from urllib.parse import urlsplit, parse_qs, quote

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_MODULE_ROOT, "lib"))

import gauth      # noqa: E402
import sources    # noqa: E402
import store      # noqa: E402

DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
FORMS_API = "https://forms.googleapis.com/v1/forms"

# A support message is short. Anything longer is a pasted log, and the inbox shows a lead only.
LEAD_CHARS = 400


def respond(status, body, ctype="application/json"):
    payload = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, (dict, list)) else str(body).encode()
    sys.stdout.buffer.write(("%d\n%s\n\n" % (status, ctype)).encode())
    sys.stdout.buffer.write(payload)


# --- registry ----------------------------------------------------------------

def do_scan():
    """Rescan the repos. Keeps whatever Google ids a previous fetch already resolved."""
    known = {f["url"]: f for f in store.load_forms().get("forms") or []}
    forms = []
    for entry in sources.scan():
        previous = known.get(entry["url"], {})
        entry["responder_id"] = previous.get("responder_id") or (
            entry["public_id"] if entry["kind"] == "responder" else "")
        entry["form_id"] = previous.get("form_id") or (
            entry["public_id"] if entry["kind"] == "form" else "")
        entry["title"] = previous.get("title", "")
        entry["readable"] = previous.get("readable", False)
        entry["last_error"] = previous.get("last_error", "")
        forms.append(entry)
    # Adopted forms were found in Drive, not in the tree, so a rescan of the tree cannot re-find
    # them. Dropping them here would silently unsubscribe from a live queue.
    forms.extend(f for f in known.values() if f.get("adopted"))
    doc = {"version": 1, "scanned_at": store.now(), "forms": forms}
    store.save_forms(doc)
    return doc


def _registry():
    doc = store.load_forms()
    if not doc.get("forms"):
        doc = do_scan()
    return doc


def _resolve_shortlinks(forms):
    """Turn every forms.gle link into the responder id it points at, once."""
    resolved = 0
    for form in forms:
        if form["kind"] != "shortlink" or form.get("responder_id"):
            continue
        responder = sources.resolve_shortlink(form["url"])
        if responder:
            form["responder_id"] = responder
            resolved += 1
    return resolved


# --- Google ------------------------------------------------------------------

def _drive_forms(token):
    """Every Google Form this credential can see, real form id included."""
    out, page = [], ""
    query = quote("mimeType='application/vnd.google-apps.form' and trashed=false")
    while True:
        url = f"{DRIVE_FILES}?q={query}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=100"
        if page:
            url += f"&pageToken={page}"
        got = gauth.http_json(url, token=token)
        out.extend(got.get("files") or [])
        page = got.get("nextPageToken") or ""
        if not page:
            break
    return out


def _link_registry(token, forms):
    """Match what Drive can see against what the repos publish.

    `forms.get` is the only thing that maps a real form id to the `/forms/d/e/<responderId>/`
    URL the apps actually ship, so the join runs through `responderUri`.
    """
    linked, orphans = 0, []
    by_responder = {f.get("responder_id"): f for f in forms if f.get("responder_id")}
    by_form_id = {f.get("form_id"): f for f in forms if f.get("form_id")}
    for drive_file in _drive_forms(token):
        form_id = drive_file["id"]
        entry = by_form_id.get(form_id)
        responder = ""
        try:
            detail = gauth.http_json(f"{FORMS_API}/{form_id}", token=token)
            responder_uri = detail.get("responderUri") or ""
            if "/forms/d/e/" in responder_uri:
                responder = responder_uri.split("/forms/d/e/")[1].split("/")[0]
            title = (detail.get("info") or {}).get("title") or drive_file.get("name") or ""
        except gauth.ApiError:
            title = drive_file.get("name") or ""
        entry = entry or by_responder.get(responder)
        if entry is None:
            orphans.append({"form_id": form_id, "title": title, "responder_id": responder})
            continue
        entry["form_id"] = form_id
        entry["responder_id"] = entry.get("responder_id") or responder
        entry["title"] = title
        linked += 1
    # A shortlink and its long URL are the same form; carry the id across.
    for form in forms:
        if form.get("form_id") or not form.get("responder_id"):
            continue
        twin = next((f for f in forms if f.get("form_id")
                     and f.get("responder_id") == form["responder_id"]), None)
        if twin:
            form["form_id"] = twin["form_id"]
            form["title"] = form.get("title") or twin.get("title", "")

    # A support form the credential can see is a support form, whether or not a repo still links
    # to it. The repo scan is how forms are FOUND, not the test of whether they count — a form
    # whose URL was dropped from a store listing keeps collecting messages either way.
    for orphan in orphans:
        forms.append({
            "url": f"https://docs.google.com/forms/d/{orphan['form_id']}/edit",
            "public_id": orphan["form_id"],
            "kind": "form",
            "apps": [],
            "sites": [],
            "responder_id": orphan.get("responder_id", ""),
            "form_id": orphan["form_id"],
            "title": orphan.get("title", ""),
            "readable": False,
            "last_error": "",
            "adopted": True,
        })
        linked += 1
    return linked, orphans


def _answers_to_text(answers, questions):
    """Flatten one response into ordered question/answer pairs plus a single searchable blob."""
    pairs = []
    for item_id, answer in (answers or {}).items():
        values = [v.get("value", "") for v in ((answer.get("textAnswers") or {}).get("answers") or [])]
        pairs.append({
            "question": questions.get(item_id, item_id),
            "answer": "\n".join(v for v in values if v),
        })
    pairs.sort(key=lambda p: p["question"].lower())
    blob = "\n".join(f"{p['question']}: {p['answer']}" for p in pairs if p["answer"])
    return pairs, blob


def _questions(token, form_id):
    try:
        detail = gauth.http_json(f"{FORMS_API}/{form_id}", token=token)
    except gauth.ApiError:
        return {}
    out = {}
    for item in detail.get("items") or []:
        question = (item.get("questionItem") or {}).get("question") or {}
        if question.get("questionId"):
            out[question["questionId"]] = item.get("title") or ""
    return out


def _responses(token, form):
    form_id = form["form_id"]
    questions = _questions(token, form_id)
    messages, page = [], ""
    while True:
        url = f"{FORMS_API}/{form_id}/responses?pageSize=1000"
        if page:
            url += f"&pageToken={page}"
        got = gauth.http_json(url, token=token)
        for raw in got.get("responses") or []:
            pairs, blob = _answers_to_text(raw.get("answers"), questions)
            messages.append({
                "id": raw.get("responseId"),
                "form_id": form_id,
                "form_title": form.get("title") or form["url"],
                "apps": form.get("apps") or [],
                "submitted_at": raw.get("lastSubmittedTime") or raw.get("createTime") or "",
                "email": raw.get("respondentEmail") or "",
                "fields": pairs,
                "text": blob,
            })
        page = got.get("nextPageToken") or ""
        if not page:
            break
    return messages


# --- credential discovery ----------------------------------------------------

FASTLANE_KEY_NAME = "play-store-key.json"


def do_autodiscover():
    """Register the Google identities already on disk, by path.

    Registered projects may have fastlane credentials for Play. They can be reused as a Google
    identity for reading forms. Pointing at one beats minting another the human then stores twice.
    Only the path is recorded here — nothing is copied.
    """
    found = []
    for root, _ in sources.scan_roots():
        for path in sources._walk(root):
            if path.name != FASTLANE_KEY_NAME and not path.name.endswith(".sa.json"):
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(raw, dict) or raw.get("type") != "service_account" or not raw.get("client_email"):
                continue
            found.append({"path": str(path), "email": raw["client_email"]})
    # One identity is enough. Several of these are the same robot checked into different repos.
    by_email = {}
    for item in found:
        by_email.setdefault(item["email"], item)
    gauth.register_key_paths([item["path"] for item in by_email.values()])
    return {"registered": sorted(by_email.keys()), "candidates": len(found)}


# --- routes ------------------------------------------------------------------

def route_setup():
    doc = _registry()
    forms = doc["forms"]
    accounts = gauth.load_accounts()
    readable = [f for f in forms if f.get("readable")]
    if not accounts:
        stage = "no_key"
    elif not readable:
        stage = "no_access"
    elif len(readable) < len({f.get("responder_id") or f["url"] for f in forms}):
        stage = "partial"
    else:
        stage = "ready"
    return {
        "stage": stage,
        "credentials": [{"email": a["email"], "source": a["source"], "kind": a.get("kind", "sa")}
                        for a in accounts],
        "grant_email": accounts[0]["email"] if accounts else "",
        "secrets_dir": str(gauth.SECRETS_DIR),
        "forms_total": len(forms),
        "forms_readable": len(readable),
        "gaps": [{"url": f["url"], "apps": f["apps"], "reason": f.get("last_error") or "not shared"}
                 for f in forms if not f.get("readable")],
        "scanned_at": doc.get("scanned_at", ""),
    }


def route_fetch():
    doc = _registry()
    forms = doc["forms"]
    accounts = gauth.load_accounts()
    if not accounts:
        return 400, {"error": "no credential",
                     "hint": f"drop a service-account JSON as *.sa.json into {gauth.SECRETS_DIR}, "
                             "then share every support form with its client_email as an Editor"}

    # Persist before touching Google. Resolving eleven redirects is the slow half of this route,
    # and a Google-side failure should not throw that work away.
    if _resolve_shortlinks(forms):
        doc["forms"] = forms
        store.save_forms(doc)

    token = gauth.access_token(accounts[0])
    linked, orphans = _link_registry(token, forms)

    new_messages, errors = [], []
    verdicts = {}
    for form in forms:
        form_id = form.get("form_id")
        if not form_id or form_id in verdicts:
            continue
        try:
            new_messages.extend(_responses(token, form))
            verdicts[form_id] = ""
        except gauth.ApiError as exc:
            verdicts[form_id] = exc.message
            errors.append({"url": form["url"], "error": exc.message})

    # One form, several published URLs. The read happens once, but the verdict belongs to every
    # URL that points at it — otherwise a shortlink reads as broken next to the long URL it
    # redirects to, and the gap list names links that are perfectly fine.
    for form in forms:
        form_id = form.get("form_id")
        if not form_id:
            form["readable"] = False
            form["last_error"] = form.get("last_error") or "no form found for this URL"
            continue
        problem = verdicts.get(form_id, "")
        form["readable"] = not problem
        form["last_error"] = problem

    doc["forms"] = forms
    doc["fetched_at"] = store.now()
    store.save_forms(doc)
    fresh = store.merge_messages(new_messages)
    return 200, {
        "fetched_at": doc["fetched_at"],
        "forms_linked": linked,
        "forms_unreachable": [f["url"] for f in forms if not f.get("readable")],
        "orphan_forms": orphans,
        "responses_seen": len(new_messages),
        "new": len(fresh),
        "errors": errors,
    }


def route_inbox(query):
    days = int((query.get("days") or ["0"])[0] or 0)
    app = (query.get("app") or [""])[0]
    only_unread = (query.get("unread") or [""])[0] in ("1", "true")
    limit = int((query.get("limit") or ["200"])[0])

    read = store.load_read()
    messages = store.load_messages()
    if days:
        import datetime
        cutoff = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=days)).isoformat()
        messages = [m for m in messages if (m.get("submitted_at") or "") >= cutoff]
    if app:
        messages = [m for m in messages if app.lower() in [a.lower() for a in m.get("apps") or []]]
    messages.sort(key=lambda m: m.get("submitted_at") or "", reverse=True)

    out = []
    for message in messages:
        item = dict(message)
        item["read"] = message["id"] in read
        item["lead"] = (message.get("text") or "")[:LEAD_CHARS]
        if only_unread and item["read"]:
            continue
        out.append(item)
    unread = sum(1 for m in store.load_messages() if m["id"] not in read)
    return {"total": len(messages), "unread": unread, "messages": out[:limit]}


def route_read(body):
    read = store.load_read()
    if body.get("all"):
        read |= {m["id"] for m in store.load_messages()}
    else:
        read |= set(body.get("ids") or [])
    store.save_read(read)
    return {"read": len(read)}


SCHEMA = {
    "routes": {
        "GET /setup": "credential state, grant_email, which forms are readable, and the gap list",
        "POST /autodiscover": "register the Google identities already on disk, by path",
        "POST /scan": "rescan the repos for published support form URLs",
        "GET /forms": "the registry",
        "POST /fetch": "pull every response from every readable form and merge into the log",
        "GET /inbox": "the merged feed — ?days= ?app= ?unread=1 ?limit=",
        "POST /read": "mark read — {\"ids\":[...]} or {\"all\":true}",
    },
    "storage": str(gauth.STATE),
}


def main():
    method = (sys.argv[1] if len(sys.argv) > 1 else "GET").upper()
    target = sys.argv[2] if len(sys.argv) > 2 else "/setup"
    split = urlsplit(target)
    path = split.path.rstrip("/") or "/setup"
    query = parse_qs(split.query)
    body = {}
    if method == "POST":
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        if raw.strip():
            try:
                body = json.loads(raw)
            except ValueError:
                return respond(400, {"error": "body is not JSON"})

    try:
        if path == "/schema":
            return respond(200, SCHEMA)
        if path == "/setup":
            return respond(200, route_setup())
        if path == "/forms":
            return respond(200, _registry())
        if path == "/autodiscover" and method == "POST":
            return respond(200, do_autodiscover())
        if path == "/scan" and method == "POST":
            return respond(200, do_scan())
        if path == "/fetch" and method == "POST":
            status, payload = route_fetch()
            return respond(status, payload)
        if path == "/inbox":
            return respond(200, route_inbox(query))
        if path == "/read" and method == "POST":
            return respond(200, route_read(body))
    except gauth.ApiError as exc:
        return respond(exc.status, {"error": exc.message, "detail": exc.detail})
    return respond(404, {"error": f"no route {method} {path}", "try": sorted(SCHEMA["routes"])})


if __name__ == "__main__":
    main()
