# support module

Every app in the portfolio publishes a Google Form as its support channel — eleven of them, on
store listings, privacy pages and in-app settings screens. This module reads all of them in one
call. Read-only against Google.

Call it over the panel origin at `/m/support/<route>`. A bare CLI run works the same:

```bash
H=panel/host/modules/support/bin/host.py
python3 $H GET  /setup
python3 $H POST /fetch
python3 $H GET  '/inbox?unread=1'
```

## Routes

- `GET /setup` — `stage` ∈ `no_key` | `no_access` | `partial` | `ready`, plus `grant_email` and
  the honest `gaps` list. Lead with the stage.
- `POST /scan` — rescan the repos for published form URLs. Resolved Google ids survive the rescan.
- `GET /forms` — the registry: URL, kind, which apps publish it, where it appears in the tree.
- `POST /fetch` — resolve shortlinks, join the registry against Drive, pull every response, merge.
- `GET /inbox?days=&app=&unread=1&limit=` — the merged feed, newest first.
- `POST /read` — `{"ids":[…]}` or `{"all":true}`.

## Why the registry is a scan

A support form is a URL that already ships somewhere — `fastlane/metadata/*/support_url.txt`, a
privacy page, `Links.swift`, a settings screen. Keeping a second hand-written list is how the two
drift apart, so `lib/sources.py` walks the repos instead. Never hand-edit `forms.json`; run
`POST /scan`.

## The id problem

Apps publish `forms.gle/<x>` or `/forms/d/e/<responderId>/viewform`. The Forms API wants the real
`formId`, which appears in neither. The join runs: shortlink → follow the redirect → responder id;
Drive lists every form the credential can see → `forms.get` returns `responderUri` → responder id.
Match on that. A form Drive can see but no repo publishes comes back in `orphan_forms`.

## Setting it up

1. `POST /autodiscover`. It registers the fastlane Google identity already in the repos, by
   path. Nothing is copied. To use a different key, drop it into the module's state `secrets/`
   as `*.sa.json` — `GET /setup` prints the directory.
2. Enable **Drive API** and **Forms API** in that identity's Google Cloud project. The first
   `POST /fetch` names the project and the console URL when they are off.
3. Share **every** support form with the `grant_email` from `GET /setup`, as an **Editor**.
   Viewer is not enough. Google gates response reads behind edit access.
4. `POST /fetch`. Anything still unreadable is listed in `forms_unreachable` with the reason.

The no-new-key path is gcloud ADC, behind `SUPPORT_ENABLE_ADC=1`, after a login that actually
carried the Forms scopes. A plain `gcloud auth application-default login` is scopeless and only
adds a credential that fails on every call.
