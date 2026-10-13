"""Where the portfolio publishes a support channel.

Nothing here is hand-maintained. A support form is a URL that already ships in a store listing,
a privacy page or an app's settings screen, so the registry is a scan of the repos rather than a
second list that drifts from the first one. Pure stdlib on purpose — the scan has to work in the
signed app bundle, where `rg` is not guaranteed to be on PATH.
"""
import json
import os
import re
from pathlib import Path

FORM_RE = re.compile(
    r"https://forms\.gle/[A-Za-z0-9_-]{6,}"
    r"|https://docs\.google\.com/forms/d/e/[A-Za-z0-9_-]{20,}"
    r"|https://docs\.google\.com/forms/d/[A-Za-z0-9_-]{20,}"
)

SKIP_DIRS = {
    ".git", "node_modules", "build", "Pods", ".dart_tool", "dist", "DerivedData",
    ".gradle", ".idea", "vendor", "Carthage", ".venv", "venv", "__pycache__",
    ".next", "coverage", ".symlinks", "ephemeral",
}
TEXT_SUFFIXES = {
    ".html", ".htm", ".md", ".txt", ".json", ".yaml", ".yml", ".dart", ".swift", ".kt",
    ".java", ".ts", ".tsx", ".js", ".jsx", ".plist", ".xml", ".gd", ".py", ".sh", ".cfg",
    ".properties", ".toml", "",
}
MAX_BYTES = 2_000_000


def _short_id(url):
    return url.rstrip("/").rsplit("/", 1)[-1]


def kind_of(url):
    if "/forms/d/e/" in url:
        return "responder"      # the public /viewform id, not the API's form id
    if "forms.gle/" in url:
        return "shortlink"
    return "form"               # /forms/d/<formId> — the real one


def _walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            try:
                if path.stat().st_size > MAX_BYTES:
                    continue
            except OSError:
                continue
            yield path


def scan_roots(root=None):
    """Explicit workspace override, or registered projects outside the read-only bundle."""
    override = root or os.environ.get("APPGEA_ROOT")
    if override:
        return [(Path(override).expanduser(), None)]
    home = Path(os.environ.get("PANEL_USER_HOME") or Path.home() / ".appgeapanel")
    try:
        config = json.loads((home / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    projects = config.get("projects", []) if isinstance(config, dict) else []
    if not isinstance(projects, list):
        return []
    roots = []
    seen = set()
    for project in projects:
        if not isinstance(project, dict) or project.get("role") == "collection":
            continue
        raw = project.get("path")
        if not isinstance(raw, str) or not raw.strip():
            continue
        path = Path(raw).expanduser().resolve()
        if not path.is_dir() or path in seen:
            continue
        seen.add(path)
        label = project.get("name") or project.get("id") or path.name
        roots.append((path, str(label)))
    return roots


def scan(root=None):
    """Every support form in registered repositories. No bundle ancestor scans."""
    found = {}
    for repo, label in scan_roots(root):
        for path in _walk(repo):
            try:
                rel = path.relative_to(repo)
                text = path.read_text(encoding="utf-8", errors="ignore")
            except (OSError, ValueError):
                continue
            app = label or (rel.parts[0] if rel.parts else "?")
            if "forms.gle" not in text and "google.com/forms" not in text:
                continue
            for url in FORM_RE.findall(text):
                entry = found.setdefault(url, {
                    "url": url,
                    "public_id": _short_id(url),
                    "kind": kind_of(url),
                    "apps": set(),
                    "sites": [],
                })
                entry["apps"].add(app)
                site = str(Path(label) / rel) if label else str(rel)
                if site not in entry["sites"] and len(entry["sites"]) < 8:
                    entry["sites"].append(site)

    registry = []
    for entry in found.values():
        entry["apps"] = sorted(entry["apps"])
        registry.append(entry)
    registry.sort(key=lambda e: (e["apps"][0].lower(), e["url"]))
    return registry


def resolve_shortlink(url, timeout=15):
    """forms.gle/<x> redirects to the /forms/d/e/<responderId>/viewform page. Follow it once so a
    shortlink and the long URL for the same form stop counting as two channels."""
    import urllib.request

    class _Keep(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            _Keep.last = newurl
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    _Keep.last = ""
    opener = urllib.request.build_opener(_Keep)
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "appgea-panel"}),
                         timeout=timeout) as resp:
            final = resp.geturl()
    except Exception:
        final = _Keep.last
    match = re.search(r"/forms/d/e/([A-Za-z0-9_-]+)", final or "")
    return match.group(1) if match else ""
