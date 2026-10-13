# Servers

A health check for whatever the human runs. It is portfolio-wide, not per project — a server
belongs to the estate, and the one serving a static site is usually not in that site's repo at
all. It ships with an empty list; the list is the whole configuration.

## Setting it up

If the human asks you to set this up, do not ask them to fill in a form. Find the servers
yourself, then confirm the list with them before writing it.

**1. Find candidates.** Look in the repos for what a deploy actually talks to:

- deploy scripts and `ssh`/`rsync` targets, `docker-compose*.yml`, `Caddyfile`, nginx confs,
  systemd units, `fly.toml`, `vercel.json`, GitHub Actions deploy jobs
- `.env.example` and README for domains, and client code for the URL it calls at runtime
- existing health routes: grep for `/health`, `/healthz`, `/api/health`, `/status`, `/ping`

**2. Confirm each one is real** before adding it. `curl -sI` it. A domain in a README is a claim,
not a server.

**3. Prefer the endpoint that means something.** A CDN's apex may 404 while the bucket is fine —
check a real object. A site with no health route needs `body_contains` against a string that only
appears when the page truly rendered, not just a 200 from a parking page.

**4. Add them one at a time.** `/targets/add` probes on write and hands back the result, so a
wrong expectation surfaces immediately instead of becoming a green board that lies.

```bash
H=host/modules/server-health/bin/host.py

echo '{"id":"api","label":"API","url":"https://api.example.com/health",
       "checks":["dns","http","tls","json","latency"],
       "expect":{"status":200,"json":{"status":"ok"}},
       "note":"the thing every client calls"}' | python3 $H POST /targets/add
```

Read the `result` and `hint` that come back. If it did not pass, fix the expectation or tell the
human what is broken. Do not leave a target failing without saying so.

**5. Park what you cannot verify.** Set `enabled: false` with the reason in `note`. A monitor
whose red lights are all known-stale gets ignored, and then the real one is ignored too.

**6. Offer the sweep.** Checks only run while Panel is open unless the human installs the
launchd job: `host/modules/server-health/install-sweep.sh` (every 5 minutes, `--uninstall` to
remove). Say it exists; do not install it without being asked.

## The vocabulary

`GET /schema` returns it in full. In short:

| field | meaning |
|---|---|
| `id` `label` `url` | required. `url` is the exact thing to fetch |
| `checks` | any of `dns` `tcp` `http` `redirect` `tls` `json` `json_parses` `body` `latency` |
| `expect` | `status`, `json` (exact key/value match), `body_contains`, `redirects_to`, `follow_redirects` |
| `tls_warn_days` | degraded below this, default 21 |
| `timeout_s` `slow_ms` `port` | default 10, 2500, from the URL |
| `enabled` `note` | park it, and say why |

Unknown fields are rejected on purpose. A typo'd key would store fine and monitor nothing.

## States

- `up` — every check passed.
- `degraded` — reachable, but something soft failed: certificate inside its warning window, slow
  response, or a health endpoint reporting its own bad news. Worth reading, not worth waking for.
- `down` — did not resolve, did not connect, or answered wrong. Two consecutive misses before
  `confirmed` goes true, so one timeout is not an alarm.
- `skipped` — `enabled: false`.

## Routes

```
GET  /portfolio            stored results, no network
GET  /portfolio?fresh=1    probe everything now
GET  /check?id=<id>        probe one
GET  /targets              the list
GET  /schema               the field vocabulary
POST /targets/add          {…target} — adds or replaces, then probes
POST /targets/remove       {id}
POST /targets/toggle       {id, enabled}
POST /targets              {targets:[…]} — replace wholesale
     --sweep               headless run, what launchd calls
```

The list lives at `~/.appgeapanel/state/server-health/targets.json`. Edit that, never
`assets/targets.default.json` — the default is a seed copied out on first run.

## What it does not know

Nothing inside the boxes. No disk, memory, container count, database reachability, or backup
freshness — those need SSH and are not built. A 200 means the front door opened. Do not report a
server as healthy on more than that.
