"""Google credentials for the support module.

Same shape as the analytics module: a service-account JSON in the module's state `secrets/`
folder, or gcloud Application Default Credentials when the human would rather authorise the
account that already owns the forms. Credentials never leave this process.
"""
import base64
import json
import os
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN_URL = "https://oauth2.googleapis.com/token"
TOKEN_SKEW_SECONDS = 120

SCOPES = [
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/forms.body.readonly",
    "https://www.googleapis.com/auth/forms.responses.readonly",
]


class ApiError(Exception):
    def __init__(self, status, message, detail=""):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


def state_dir(name="support"):
    root = os.environ.get("PANEL_STATE_DIR")
    target = Path(root) if root else Path.home() / ".appgeapanel" / "state" / name
    target.mkdir(parents=True, exist_ok=True)
    return target


STATE = state_dir()
SECRETS_DIR = STATE / "secrets"
CACHE_DIR = STATE / "cache"
KEYS_PATH = STATE / "keys.json"


def ensure_secure_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, stat.S_IRWXU)


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def load_accounts():
    """Every configured credential. A missing one is an empty list, never an exception."""
    accounts = []
    seen = set()

    def take(raw, source):
        try:
            sa = json.loads(raw)
        except ValueError:
            return
        email = sa.get("client_email")
        if not email or not sa.get("private_key") or email in seen:
            return
        seen.add(email)
        accounts.append({"kind": "sa", "sa": sa, "email": email, "source": source})

    env = (os.environ.get("SUPPORT_SERVICE_ACCOUNT_JSON") or "").strip()
    if env:
        if env.startswith("{"):
            take(env, "environment")
        else:
            try:
                take(Path(env).expanduser().read_text(encoding="utf-8"), "environment")
            except OSError:
                pass

    if SECRETS_DIR.is_dir():
        for path in sorted(SECRETS_DIR.glob("*.sa.json")):
            try:
                take(path.read_text(encoding="utf-8"), "module secrets")
            except OSError:
                continue

    # Keys that already live in the repos are referenced by path, never copied. A second copy of
    # a private key is a second thing to leak and a second thing to rotate.
    for path in registered_key_paths():
        try:
            take(Path(path).expanduser().read_text(encoding="utf-8"), path)
        except OSError:
            continue

    adc = _load_adc(seen)
    if adc is not None:
        accounts.append(adc)
    return accounts


def registered_key_paths():
    try:
        doc = json.loads(KEYS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [p for p in (doc.get("paths") or []) if isinstance(p, str)]


def register_key_paths(paths):
    KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    KEYS_PATH.write_text(json.dumps({"paths": sorted(set(paths))}, indent=2), encoding="utf-8")


def _load_adc(seen):
    """gcloud ADC, opt-in.

    A plain `gcloud auth application-default login` is scopeless and only adds a credential that
    fails on every call, so this stays behind SUPPORT_ENABLE_ADC=1. Turn it on after a login that
    actually carried the Forms scopes.
    """
    if not os.environ.get("SUPPORT_ENABLE_ADC"):
        return None
    try:
        import google.auth
    except ImportError:
        return None
    try:
        creds, _ = google.auth.default(scopes=SCOPES)
    except Exception:
        return None
    email = getattr(creds, "service_account_email", None) or getattr(creds, "_account", None) or "gcloud ADC"
    if email in seen:
        return None
    seen.add(email)
    return {"kind": "adc", "creds": creds, "email": email, "source": "gcloud ADC"}


def _sign_rs256(message, private_key_pem):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    return key.sign(message, padding.PKCS1v15(), hashes.SHA256())


def _token_cache_path(email):
    safe = re.sub(r"[^A-Za-z0-9_.@-]", "_", email)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f".token-{safe}.json"


def access_token(account):
    if account.get("kind") == "adc":
        import google.auth.transport.requests

        creds = account["creds"]
        if not getattr(creds, "valid", False):
            try:
                creds.refresh(google.auth.transport.requests.Request())
            except Exception as exc:
                raise ApiError(401, f"ADC token refresh failed: {exc}",
                               "re-run: gcloud auth application-default login --scopes="
                               + ",".join(SCOPES)) from exc
        if not creds.token:
            raise ApiError(401, "ADC produced no access token")
        return creds.token

    email = account["email"]
    path = _token_cache_path(email)
    now = int(time.time())
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("expires_at", 0) - TOKEN_SKEW_SECONDS > now and cached.get("token"):
            return cached["token"]
    except (OSError, ValueError):
        pass

    sa = account["sa"]
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claim = b64url(json.dumps({
        "iss": sa["client_email"],
        "scope": " ".join(SCOPES),
        "aud": sa.get("token_uri") or TOKEN_URL,
        "exp": now + 3600,
        "iat": now,
    }, separators=(",", ":")).encode())
    signature = b64url(_sign_rs256(f"{header}.{claim}".encode(), sa["private_key"]))
    payload = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": f"{header}.{claim}.{signature}",
    }).encode()
    got = http_json(sa.get("token_uri") or TOKEN_URL, method="POST", raw=payload,
                    ctype="application/x-www-form-urlencoded")
    token = got.get("access_token")
    if not token:
        raise ApiError(401, "token endpoint returned no access_token")
    ensure_secure_dir(CACHE_DIR)
    path.write_text(json.dumps({"token": token, "expires_at": now + int(got.get("expires_in", 3600))}),
                    encoding="utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return token


def http_json(url, *, token="", method="GET", body=None, raw=None, ctype="application/json",
              timeout=30):
    headers = {"Accept": "application/json"}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = ctype
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        message, detail = f"HTTP {exc.code}", body_text[:400]
        try:
            err = json.loads(body_text).get("error", {})
            if isinstance(err, dict):
                message = err.get("message") or message
                detail = (err.get("status") or "")
            elif isinstance(err, str):
                message = err
                detail = json.loads(body_text).get("error_description", "")
        except ValueError:
            pass
        raise ApiError(exc.code, message, detail) from exc
    except urllib.error.URLError as exc:
        raise ApiError(503, f"network unreachable: {exc.reason}") from exc
