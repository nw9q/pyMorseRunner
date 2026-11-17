#!/usr/bin/env python3
"""pyMorseRunner — python web morse code contest simulator

Ported from Alex Shovkoplyas (VE3NEA) Morse Runner 1.68 (MPL-2.0) with added
support for K1USN Slow Speed Test (SST), CWops CWT, N1MM ESM workflows
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import http.cookies
import json
import mimetypes
import os
import re
import secrets
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = (BASE_DIR / "static").resolve()
DATA_DIR = (BASE_DIR / "data").resolve()
SCORES_FILE = DATA_DIR / "scores.json"
USERS_FILE = DATA_DIR / "users.json"

DATA_LOCK = threading.RLock()

MAX_BODY_BYTES = 512 * 1024  # 512 KB max request payload
MAX_SCORES_STORED = 500
MAX_QSOS_EXPORT = 5000
SESSION_TTL_SECONDS = 12 * 3600  # 12 hours
AUTH_STATE_TTL_SECONDS = 600  # 10 minutes for OAuth2 PKCE handshake
MAX_PENDING_STATES = 512
MAX_ACTIVE_SESSIONS = 2048

# only allow ascii printables
ASCII_PRINTABLE_RE = re.compile(r"^[\x20-\x7E]*$")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


def load_dotenv_if_present() -> None:
    """Load key=value pairs from .env if present (without overriding existing env)."""
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ and ASCII_PRINTABLE_RE.match(v):
                os.environ[k] = v
    except OSError:
        pass


load_dotenv_if_present()


def ensure_data_dir() -> None:
    """Ensure the persistent data directory exists."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def get_session_secret() -> bytes:
    """Return a persistent 256-bit HMAC secret for signing session tokens."""
    env_sec = os.environ.get("SESSION_SECRET", "").strip()
    if len(env_sec) >= 32:
        return env_sec.encode("utf-8")
    ensure_data_dir()
    sec_path = DATA_DIR / ".session_secret"
    if sec_path.is_file():
        try:
            raw = sec_path.read_bytes().strip()
            if len(raw) >= 32:
                return raw
        except OSError:
            pass
    generated = secrets.token_hex(32).encode("ascii")
    try:
        fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), prefix=".sec_", suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(generated)
        os.chmod(tmp, 0o600)
        os.replace(tmp, sec_path)
    except OSError:
        pass
    return generated


SESSION_SECRET = get_session_secret()

# In-memory pending OAuth2 PKCE states: state -> {verifier, nonce, created_at}
PENDING_AUTH_STATES: dict[str, dict[str, Any]] = {}
# Active server-side sessions: session_id -> {sub, csrf, created_at, last_seen, ip, ua}
ACTIVE_SESSIONS: dict[str, dict[str, Any]] = {}


def get_auth0_config() -> dict[str, str]:
    """Read and sanitize Auth0 configuration from environment."""
    domain = taint_check_ascii(os.environ.get("AUTH0_DOMAIN", ""), 128).strip()
    domain = re.sub(r"^https?://", "", domain).rstrip("/")
    client_id = taint_check_ascii(os.environ.get("AUTH0_CLIENT_ID", ""), 128).strip()
    client_secret = taint_check_ascii(os.environ.get("AUTH0_CLIENT_SECRET", ""), 256).strip()
    callback_url = taint_check_ascii(
        os.environ.get("AUTH0_CALLBACK_URL", "http://localhost:8073/auth/callback"), 256
    ).strip()
    return {
        "domain": domain,
        "client_id": client_id,
        "client_secret": client_secret,
        "callback_url": callback_url,
    }


def is_auth0_configured() -> bool:
    cfg = get_auth0_config()
    return bool(
        cfg["domain"]
        and "." in cfg["domain"]
        and cfg["client_id"]
        and cfg["client_secret"]
    )


def taint_check_ascii(val: Any, max_len: int = 64, default: str = "") -> str:
    """Strictly enforce printable ASCII (0x20..0x7E) and length limit on any input."""
    if val is None or isinstance(val, (bool, dict, list)):
        return default
    raw = str(val)
    # Strip any non-printable or non-ASCII characters immediately
    cleaned = "".join(ch for ch in raw if 0x20 <= ord(ch) <= 0x7E).strip()
    if not cleaned:
        return default
    return cleaned[:max_len]


def sanitize_call(val: Any, default: str = "N0CALL") -> str:
    s = taint_check_ascii(val, 16, "").upper()
    s = re.sub(r"[^A-Z0-9/]", "", s)[:15]
    return s if len(s) >= 2 else default


def sanitize_field(val: Any, max_len: int = 16) -> str:
    s = taint_check_ascii(val, max_len, "").upper()
    return re.sub(r"[^A-Z0-9\s\-/]", "", s)[:max_len].strip()


def sanitize_user_id(val: Any) -> str:
    s = taint_check_ascii(val, 128, "")
    return re.sub(r"[^A-Za-z0-9|_.\-@:]", "", s)[:128]


def safe_int(val: Any, default: int, min_val: int, max_val: int) -> int:
    """Safely parse and clamp an integer from untrusted JSON input."""
    try:
        if isinstance(val, bool) or val is None:
            parsed = default
        else:
            parsed = int(str(val).strip())
    except (ValueError, TypeError, OverflowError):
        parsed = default
    return max(min_val, min(max_val, parsed))


# Persistent Storage (Users & Scores) with Atomic Writes
def _atomic_write_json(target_path: Path, data: Any) -> None:
    ensure_data_dir()
    fd, tmp_path = tempfile.mkstemp(dir=str(DATA_DIR), prefix=f".{target_path.name}_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, target_path)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _load_users_unlocked() -> dict[str, dict[str, Any]]:
    ensure_data_dir()
    if not USERS_FILE.is_file():
        return {}
    try:
        raw = USERS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def register_or_update_user_on_login(
    claims: dict[str, Any], client_ip: str, user_agent: str
) -> tuple[dict[str, Any], str]:
    """Upsert user from Auth0 claims. The VERY FIRST user to log in becomes admin."""
    with DATA_LOCK:
        users = _load_users_unlocked()
        sub = sanitize_user_id(claims.get("sub"))
        if not sub:
            raise ValueError("Missing Auth0 'sub' claim")

        now_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        provider = sub.split("|", 1)[0] if "|" in sub else "auth0"
        email = taint_check_ascii(claims.get("email"), 120, "N/A")
        email_verified = bool(claims.get("email_verified", False))
        name = taint_check_ascii(
            claims.get("name") or claims.get("nickname") or email or sub, 80, "Operator"
        )
        nickname = taint_check_ascii(claims.get("nickname"), 64, name)
        picture = taint_check_ascii(claims.get("picture"), 256, "")
        locale = taint_check_ascii(claims.get("locale"), 24, "")
        updated_at_idp = taint_check_ascii(claims.get("updated_at"), 40, "")

        # First user to ever log in becomes admin
        is_first_user = len(users) == 0
        existing = users.get(sub)

        if existing is None:
            user_rec: dict[str, Any] = {
                "sub": sub,
                "role": "admin" if is_first_user else "user",
                "blocked": False,
                "email": email,
                "email_verified": email_verified,
                "name": name,
                "nickname": nickname,
                "picture": picture,
                "provider": provider,
                "locale": locale,
                "idp_updated_at": updated_at_idp,
                "first_login_utc": now_str,
                "last_login_utc": now_str,
                "last_seen_utc": now_str,
                "login_count": 1,
                "last_ip": taint_check_ascii(client_ip, 64, "unknown"),
                "user_agent": taint_check_ascii(user_agent, 160, "unknown"),
                "last_callsign": "N0CALL",
                "total_runs": 0,
                "best_score": 0,
                "kicked_at": "",
            }
            users[sub] = user_rec
        else:
            if existing.get("blocked", False):
                _atomic_write_json(USERS_FILE, users)
                return existing, "blocked"

            existing["email"] = email or existing.get("email", "N/A")
            existing["email_verified"] = email_verified
            existing["name"] = name or existing.get("name", "Operator")
            existing["nickname"] = nickname or existing.get("nickname", "")
            existing["picture"] = picture or existing.get("picture", "")
            existing["provider"] = provider
            if locale:
                existing["locale"] = locale
            if updated_at_idp:
                existing["idp_updated_at"] = updated_at_idp
            existing["last_login_utc"] = now_str
            existing["last_seen_utc"] = now_str
            existing["login_count"] = safe_int(existing.get("login_count"), 0, 0, 1_000_000) + 1
            existing["last_ip"] = taint_check_ascii(client_ip, 64, "unknown")
            existing["user_agent"] = taint_check_ascii(user_agent, 160, "unknown")
            user_rec = existing

        _atomic_write_json(USERS_FILE, users)
        return user_rec, "ok"


def create_session(sub: str, client_ip: str, user_agent: str) -> tuple[str, str]:
    """Create a signed session token and CSRF token for an authenticated user."""
    with DATA_LOCK:
        now = time.time()
        expired = [
            sid for sid, s in ACTIVE_SESSIONS.items() if now - s["created_at"] > SESSION_TTL_SECONDS
        ]
        for sid in expired:
            ACTIVE_SESSIONS.pop(sid, None)
        while len(ACTIVE_SESSIONS) >= MAX_ACTIVE_SESSIONS:
            oldest_sid = min(ACTIVE_SESSIONS, key=lambda k: ACTIVE_SESSIONS[k]["last_seen"])
            ACTIVE_SESSIONS.pop(oldest_sid, None)

        raw_sid = secrets.token_urlsafe(32)
        csrf_token = secrets.token_hex(24)
        ACTIVE_SESSIONS[raw_sid] = {
            "sub": sub,
            "csrf": csrf_token,
            "created_at": now,
            "last_seen": now,
            "ip": taint_check_ascii(client_ip, 64, "unknown"),
            "ua": taint_check_ascii(user_agent, 160, "unknown"),
        }
        sig = hmac.new(SESSION_SECRET, raw_sid.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{raw_sid}.{sig}", csrf_token


def verify_session_cookie(cookie_val: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str]:
    """Verify signed session cookie and check that user is neither blocked nor kicked."""
    if not cookie_val or "." not in cookie_val or not ASCII_PRINTABLE_RE.match(cookie_val):
        return None, None, "unauthenticated"
    raw_sid, sig = cookie_val.rsplit(".", 1)
    expected_sig = hmac.new(SESSION_SECRET, raw_sid.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None, None, "invalid_signature"

    now = time.time()
    with DATA_LOCK:
        sess = ACTIVE_SESSIONS.get(raw_sid)
        if not sess:
            return None, None, "kicked_or_expired"
        if now - sess["created_at"] > SESSION_TTL_SECONDS:
            ACTIVE_SESSIONS.pop(raw_sid, None)
            return None, None, "expired"

        users = _load_users_unlocked()
        user = users.get(sess["sub"])
        if not user:
            ACTIVE_SESSIONS.pop(raw_sid, None)
            return None, None, "unknown_user"
        if user.get("blocked", False):
            ACTIVE_SESSIONS.pop(raw_sid, None)
            return None, None, "blocked"

        sess["last_seen"] = now
        return user, sess, "ok"


def revoke_user_sessions(sub: str) -> int:
    """Kick a user by immediately destroying all of their active sessions."""
    with DATA_LOCK:
        to_remove = [sid for sid, s in ACTIVE_SESSIONS.items() if s.get("sub") == sub]
        for sid in to_remove:
            ACTIVE_SESSIONS.pop(sid, None)
        return len(to_remove)


def admin_List_users() -> list[dict[str, Any]]:
    """Return all users enriched with live active session counts and last-seen times."""
    with DATA_LOCK:
        users = _load_users_unlocked()
        session_counts: dict[str, int] = {}
        latest_seen: dict[str, float] = {}
        now = time.time()
        for s in list(ACTIVE_SESSIONS.values()):
            if now - s["created_at"] <= SESSION_TTL_SECONDS:
                u_sub = s["sub"]
                session_counts[u_sub] = session_counts.get(u_sub, 0) + 1
                if s["last_seen"] > latest_seen.get(u_sub, 0.0):
                    latest_seen[u_sub] = s["last_seen"]

        out: list[dict[str, Any]] = []
        for sub, u in users.items():
            item = dict(u)
            item["active_sessions"] = session_counts.get(sub, 0)
            if sub in latest_seen:
                item["last_seen_utc"] = datetime.datetime.fromtimestamp(
                    latest_seen[sub], tz=datetime.timezone.utc
                ).strftime("%Y-%m-%d %H:%M:%S UTC")
            out.append(item)
        out.sort(key=lambda x: (0 if x.get("role") == "admin" else 1, x.get("first_login_utc", "")))
        return out


def admin_mutate_user(actor_sub: str, target_sub: str, action: str) -> tuple[bool, str]:
    """Perform an admin action (block, unblock, kick, make_admin) on a target user."""
    with DATA_LOCK:
        users = _load_users_unlocked()
        target = users.get(target_sub)
        if not target:
            return False, "User not found"

        now_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        if action == "kick":
            kicked_cnt = revoke_user_sessions(target_sub)
            target["kicked_at"] = now_str
            _atomic_write_json(USERS_FILE, users)
            return True, f"Kicked user ({kicked_cnt} active session(s) terminated)"

        if target_sub == actor_sub and action in ("block", "demote"):
            return False, "Cannot block or demote your own admin account"

        if action == "block":
            target["blocked"] = True
            target["kicked_at"] = now_str
            revoke_user_sessions(target_sub)
            _atomic_write_json(USERS_FILE, users)
            return True, "User blocked and active sessions terminated"

        if action == "unblock":
            target["blocked"] = False
            _atomic_write_json(USERS_FILE, users)
            return True, "User unblocked"

        if action == "promote":
            target["role"] = "admin"
            _atomic_write_json(USERS_FILE, users)
            return True, "User promoted to admin"

        return False, "Unsupported action"


def _load_scores_unlocked() -> list[dict[str, Any]]:
    ensure_data_dir()
    if not SCORES_FILE.is_file():
        return []
    try:
        raw = SCORES_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, list):
            return data[:MAX_SCORES_STORED]
    except (OSError, json.JSONDecodeError):
        pass
    return []


def load_scores() -> list[dict[str, Any]]:
    """Thread-safely read stored contest scores from disk."""
    with DATA_LOCK:
        return _load_scores_unlocked()


def save_score_entry(entry: dict[str, Any], user_sub: str) -> list[dict[str, Any]]:
    """Thread-safely and atomically append a validated score entry and update user stats."""
    with DATA_LOCK:
        scores = _load_scores_unlocked()
        scores.insert(0, entry)
        scores = scores[:MAX_SCORES_STORED]
        _atomic_write_json(SCORES_FILE, scores)

        users = _load_users_unlocked()
        if user_sub in users:
            u = users[user_sub]
            u["last_callsign"] = entry.get("call", "N0CALL")
            u["total_runs"] = safe_int(u.get("total_runs"), 0, 0, 1_000_000) + 1
            u["best_score"] = max(
                safe_int(u.get("best_score"), 0, 0, 100_000_000),
                safe_int(entry.get("score"), 0, 0, 100_000_000),
            )
            _atomic_write_json(USERS_FILE, users)

        return scores

# oauth
def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def decode_id_token_payload(id_token: str) -> dict[str, Any]:
    """Decode JWT payload claims received directly over TLS from Auth0's token endpoint."""
    parts = id_token.split(".")
    if len(parts) != 3:
        return {}
    try:
        raw = _b64url_decode(parts[1])
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def build_auth0_authorize_url() -> str:
    """Create PKCE verifier/challenge and return the Auth0 /authorize redirect URL."""
    cfg = get_auth0_config()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier = _b64url_encode(secrets.token_bytes(32))
    challenge = _b64url_encode(hashlib.sha256(verifier.encode("ascii")).digest())

    now = time.time()
    with DATA_LOCK:
        # Purge expired states and enforce MAX_PENDING_STATES cap
        expired = [
            k for k, v in PENDING_AUTH_STATES.items() if now - v["created_at"] > AUTH_STATE_TTL_SECONDS
        ]
        for k in expired:
            PENDING_AUTH_STATES.pop(k, None)
        while len(PENDING_AUTH_STATES) >= MAX_PENDING_STATES:
            oldest_state = min(PENDING_AUTH_STATES, key=lambda k: PENDING_AUTH_STATES[k]["created_at"])
            PENDING_AUTH_STATES.pop(oldest_state, None)
        PENDING_AUTH_STATES[state] = {
            "verifier": verifier,
            "nonce": nonce,
            "created_at": now,
        }

    params = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": cfg["client_id"],
            "redirect_uri": cfg["callback_url"],
            "scope": "openid profile email",
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"https://{cfg['domain']}/authorize?{params}"


def exchange_auth0_code(code: str, state: str) -> dict[str, Any]:
    """Exchange authorization code + PKCE verifier with Auth0 over HTTPS and fetch user claims."""
    with DATA_LOCK:
        st_info = PENDING_AUTH_STATES.pop(state, None)
    if not st_info or time.time() - st_info["created_at"] > AUTH_STATE_TTL_SECONDS:
        raise ValueError("Invalid or expired OAuth state parameter")

    cfg = get_auth0_config()
    token_url = f"https://{cfg['domain']}/oauth/token"
    payload = json.dumps(
        {
            "grant_type": "authorization_code",
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code": code,
            "redirect_uri": cfg["callback_url"],
            "code_verifier": st_info["verifier"],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        token_url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        token_data = json.loads(resp.read().decode("utf-8"))

    id_token = str(token_data.get("id_token") or "")
    access_token = str(token_data.get("access_token") or "")
    claims = decode_id_token_payload(id_token)

    # Validate standard OIDC ID Token claims (iss, aud, exp, nonce)
    expected_iss = f"https://{cfg['domain']}/"
    if str(claims.get("iss") or "") != expected_iss:
        raise ValueError("OIDC issuer mismatch")

    aud_claim = claims.get("aud")
    aud_ok = (
        cfg["client_id"] in aud_claim
        if isinstance(aud_claim, list)
        else str(aud_claim or "") == cfg["client_id"]
    )
    if not aud_ok:
        raise ValueError("OIDC audience mismatch")

    exp_val = safe_int(claims.get("exp"), 0, 0, 4_000_000_000)
    if exp_val <= time.time() - 60:
        raise ValueError("OIDC ID token expired")

    token_nonce = taint_check_ascii(claims.get("nonce"), 128, "")
    if not token_nonce or not hmac.compare_digest(token_nonce, st_info["nonce"]):
        raise ValueError("OIDC nonce mismatch")

    # Enrich with /userinfo if access_token is present and sub matches
    if access_token:
        uinfo_req = urllib.request.Request(
            f"https://{cfg['domain']}/userinfo",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(uinfo_req, timeout=6) as uresp:
                uinfo = json.loads(uresp.read().decode("utf-8"))
                if isinstance(uinfo, dict) and uinfo.get("sub") == claims.get("sub"):
                    claims.update(uinfo)
        except OSError:
            pass

    return claims


# Cabrillo & ADIF Contest Log Builders
def build_cabrillo(payload: dict[str, Any]) -> str:
    """Generate a standard Cabrillo 3.0 log from session QSOs."""
    my_call = sanitize_call(payload.get("myCall"), "VE3NEA")
    my_name = sanitize_field(payload.get("myName"), 12) or "OP"
    my_spc = sanitize_field(payload.get("mySpc"), 6) or "MA"
    mode_id = sanitize_field(payload.get("mode"), 16) or "K1USN-SST"
    qsos = payload.get("qsos")
    if not isinstance(qsos, list):
        qsos = []

    contest_map = {
        "SST": "K1USNSST",
        "CWT": "CWOPS-CWT",
        "WPX": "CQ-WPX-CW",
        "PILEUP": "CQ-WPX-CW",
        "SINGLE": "CQ-WPX-CW",
        "HST": "IARU-HST",
    }
    contest_name = contest_map.get(mode_id, "K1USNSST")
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    date_str = now_utc.strftime("%Y-%m-%d")

    lines = [
        "START-OF-LOG: 3.0",
        f"CALLSIGN: {my_call}",
        f"CONTEST: {contest_name}",
        "CATEGORY-OPERATOR: SINGLE-OP",
        "CATEGORY-BAND: ALL",
        "CATEGORY-MODE: CW",
        "CREATED-BY: pyMorseRunner 2.0",
    ]

    for q in qsos[:MAX_QSOS_EXPORT]:
        if not isinstance(q, dict):
            continue
        utc_time = re.sub(r"[^0-9]", "", taint_check_ascii(q.get("utc"), 8, "0000"))[:4].ljust(4, "0")
        his_call = sanitize_call(q.get("call"), "UNKNOWN")
        sent_1 = sanitize_field(q.get("sent1"), 10)
        sent_2 = sanitize_field(q.get("sent2"), 10)
        recv_1 = sanitize_field(q.get("recv1"), 10)
        recv_2 = sanitize_field(q.get("recv2"), 10)
        if mode_id == "SST":
            # K1USNSST.udc: CabrilloString = SentExch, 15, CallSign, 13, Name, 10, Exchange1, 5
            sent_exch = f"{sent_1 or my_name} {sent_2 or my_spc}"[:15]
            lines.append(
                f"QSO: 14032 CW {date_str} {utc_time} {my_call:<13} {sent_exch:<15} "
                f"{his_call:<13} {recv_1:<10} {recv_2:<5}"
            )
        else:
            if mode_id == "CWT":
                sent_1 = sent_1 or my_name
                sent_2 = sent_2 or my_spc
            lines.append(
                f"QSO: 14032 CW {date_str} {utc_time} {my_call:<13} {sent_1:<6} {sent_2:<6} "
                f"{his_call:<13} {recv_1:<6} {recv_2:<6}"
            )

    lines.append("END-OF-LOG:")
    return "\r\n".join(lines) + "\r\n"


def adif_field(tag: str, val: str) -> str:
    clean = taint_check_ascii(val, 64, "").strip()
    if not clean:
        return ""
    return f"<{tag}:{len(clean)}>{clean} "


def build_adif(payload: dict[str, Any]) -> str:
    """Generate an ADIF 3.1 (.adi) log for macOS loggers (SkookumLogger, RUMlogNG)."""
    my_call = sanitize_call(payload.get("myCall"), "VE3NEA")
    mode_id = sanitize_field(payload.get("mode"), 16) or "SST"
    qsos = payload.get("qsos")
    if not isinstance(qsos, list):
        qsos = []

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    date_str = now_utc.strftime("%Y%m%d")

    lines = [
        "pyMorseRunner ADIF Export",
        "<ADIF_VER:5>3.1.4",
        "<PROGRAMID:13>pyMorseRunner",
        "<EOH>",
    ]

    for q in qsos[:MAX_QSOS_EXPORT]:
        if not isinstance(q, dict):
            continue
        his_call = sanitize_call(q.get("call"), "")
        if not his_call:
            continue
        utc_raw = re.sub(r"[^0-9]", "", taint_check_ascii(q.get("utc"), 8, "000000"))[:6].ljust(6, "0")
        sent_1 = sanitize_field(q.get("sent1"), 12)
        sent_2 = sanitize_field(q.get("sent2"), 12)
        recv_1 = sanitize_field(q.get("recv1"), 12)
        recv_2 = sanitize_field(q.get("recv2"), 12)

        rec = (
            adif_field("STATION_CALLSIGN", my_call)
            + adif_field("CALL", his_call)
            + adif_field("QSO_DATE", date_str)
            + adif_field("TIME_ON", utc_raw)
            + adif_field("BAND", "20m")
            + adif_field("FREQ", "14.032")
            + adif_field("MODE", "CW")
        )
        if mode_id in ("SST", "CWT"):
            rec += adif_field("NAME", recv_1)
            rec += adif_field("STATE", recv_2)
            rec += adif_field("SRX_STRING", f"{recv_1} {recv_2}".strip())
            rec += adif_field("STX_STRING", f"{sent_1} {sent_2}".strip())
        else:
            rec += adif_field("RST_SENT", sent_1 or "599")
            rec += adif_field("STX", sent_2)
            rec += adif_field("RST_RCVD", recv_1 or "599")
            rec += adif_field("SRX", recv_2)

        rec += "<EOR>"
        lines.append(rec)

    return "\n".join(lines) + "\n"


# HTTP server & route protection
class DaemonThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True


class MorseRunnerHandler(BaseHTTPRequestHandler):
    server_version = "pyMorseRunner/2.0"
    sys_version = ""
    timeout = 5

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[pyMorseRunner] {self.address_string()} - {fmt % args}\n")

    def _add_security_headers(self) -> None:
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

    def _get_session_cookie(self) -> str:
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return ""
        c = http.cookies.SimpleCookie()
        try:
            c.load(raw_cookie)
        except http.cookies.CookieError:
            return ""
        morsel = c.get("pymr_session")
        return morsel.value if morsel else ""

    def _require_auth(self) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str]:
        cookie_val = self._get_session_cookie()
        return verify_session_cookie(cookie_val)

    def _redirect(self, location: str, set_cookie: str | None = None) -> None:
        self.send_response(HTTPStatus.FOUND)
        self._add_security_headers()
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._add_security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_text_download(self, content: str, filename: str) -> None:
        raw = content.encode("utf-8")
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", taint_check_ascii(filename, 64, "export.txt"))
        self.send_response(HTTPStatus.OK)
        self._add_security_headers()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{safe_name}"')
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _serve_static_file(self, filename: str) -> None:
        candidate = (STATIC_DIR / filename).resolve()
        if not candidate.is_relative_to(STATIC_DIR) or not candidate.is_file():
            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        ctype, _ = mimetypes.guess_type(str(candidate))
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"

        try:
            data = candidate.read_bytes()
        except OSError:
            self._send_json({"error": "Read error"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self._add_security_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _validate_ascii_tree(self, obj: Any, depth: int = 0) -> bool:
        """Recursively verify that all decoded JSON strings contain only printable ASCII."""
        if depth > 6:
            return False
        if isinstance(obj, str):
            return bool(ASCII_PRINTABLE_RE.match(obj))
        if isinstance(obj, (int, float, bool)) or obj is None:
            return True
        if isinstance(obj, list):
            return all(self._validate_ascii_tree(item, depth + 1) for item in obj)
        if isinstance(obj, dict):
            return all(
                isinstance(k, str)
                and bool(ASCII_PRINTABLE_RE.match(k))
                and self._validate_ascii_tree(v, depth + 1)
                for k, v in obj.items()
            )
        return False

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
            # Reject any payload containing control chars outside printable ASCII + whitespace
            if any((ord(ch) < 0x20 and ch not in ("\n", "\r", "\t")) or ord(ch) > 0x7E for ch in text):
                return None
            parsed = json.loads(text)
            if not isinstance(parsed, dict) or not self._validate_ascii_tree(parsed):
                return None
            return parsed
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Healthcheck endpoint (for container healthcheck probe)
        if route == "/healthz":
            self._send_json({"status": "ok"})
            return

        # 2. Public login assets (ONLY login page, login script, and stylesheet)
        if route == "/login":
            user, _, status_reason = self._require_auth()
            if user and status_reason == "ok":
                self._redirect("/")
                return
            self._serve_static_file("login.html")
            return

        if route in ("/static/style.css", "/static/login.js"):
            self._serve_static_file(route[len("/static/") :])
            return

        if route == "/api/auth/status":
            user, _, status_reason = self._require_auth()
            self._send_json(
                {
                    "configured": is_auth0_configured(),
                    "authenticated": bool(user and status_reason == "ok"),
                }
            )
            return

        # 3. Auth0 Login Redirect
        if route == "/auth/login":
            if not is_auth0_configured():
                self._redirect("/login?error=auth0_not_configured")
                return
            self._redirect(build_auth0_authorize_url())
            return

        # 4. Auth0 OAuth2 Callback
        if route == "/auth/callback":
            if "error" in query:
                err_code = sanitize_field(query.get("error", ["auth_failed"])[0], 32).lower()
                self._redirect(f"/login?error={err_code}")
                return

            code = taint_check_ascii(query.get("code", [""])[0], 512, "")
            state = taint_check_ascii(query.get("state", [""])[0], 128, "")
            if not code or not state:
                self._redirect("/login?error=missing_code")
                return

            try:
                claims = exchange_auth0_code(code, state)
                client_ip = self.client_address[0] if self.client_address else "unknown"
                ua = self.headers.get("User-Agent", "unknown")
                user_rec, login_status = register_or_update_user_on_login(claims, client_ip, ua)
            except Exception:
                self._redirect("/login?error=token_exchange_failed")
                return

            if login_status == "blocked" or user_rec.get("blocked", False):
                self._redirect("/login?error=account_blocked")
                return

            signed_cookie, _ = create_session(user_rec["sub"], client_ip, ua)
            cookie_hdr = (
                f"pymr_session={signed_cookie}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_TTL_SECONDS}"
            )
            self._redirect("/", set_cookie=cookie_hdr)
            return

        # 5. Logout
        if route == "/auth/logout":
            cookie_val = self._get_session_cookie()
            if "." in cookie_val and ASCII_PRINTABLE_RE.match(cookie_val):
                raw_sid, sig = cookie_val.rsplit(".", 1)
                expected_sig = hmac.new(
                    SESSION_SECRET, raw_sid.encode("ascii"), hashlib.sha256
                ).hexdigest()
                if hmac.compare_digest(sig, expected_sig):
                    with DATA_LOCK:
                        ACTIVE_SESSIONS.pop(raw_sid, None)
            clear_cookie = "pymr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
            self._redirect("/login?logged_out=1", set_cookie=clear_cookie)
            return

        # ALL ROUTES BELOW REQUIRE AN ACTIVE, UNBLOCKED AUTH0 SESSION
        user, sess, auth_reason = self._require_auth()
        if not user or not sess or auth_reason != "ok":
            if route.startswith("/api/"):
                self._send_json({"error": "Authentication required", "reason": auth_reason}, HTTPStatus.UNAUTHORIZED)
            else:
                err_q = "?error=account_blocked" if auth_reason == "blocked" else ""
                self._redirect(f"/login{err_q}")
            return

        # Authenticated API routes
        if route == "/api/me":
            self._send_json(
                {
                    "user": {
                        "sub": user["sub"],
                        "name": user["name"],
                        "nickname": user.get("nickname", ""),
                        "email": user["email"],
                        "role": user["role"],
                        "picture": user.get("picture", ""),
                        "provider": user.get("provider", "auth0"),
                        "login_count": user.get("login_count", 1),
                    },
                    "csrfToken": sess["csrf"],
                }
            )
            return

        if route == "/api/scores":
            self._send_json({"scores": load_scores()})
            return

        # Admin-only routes
        if route == "/admin":
            if user.get("role") != "admin":
                self._redirect("/")
                return
            self._serve_static_file("admin.html")
            return

        if route == "/api/admin/users":
            if user.get("role") != "admin":
                self._send_json({"error": "Admin privileges required"}, HTTPStatus.FORBIDDEN)
                return
            self._send_json({"users": admin_List_users(), "selfSub": user["sub"]})
            return

        # Protected static files (resolve path BEFORE checking admin asset names)
        rel_path = "index.html" if route in ("", "/") else route.lstrip("/")
        if rel_path.startswith("static/"):
            rel_path = rel_path[len("static/") :]
        candidate = (STATIC_DIR / rel_path).resolve()
        if not candidate.is_relative_to(STATIC_DIR) or not candidate.is_file():
            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        if candidate.name in ("admin.html", "admin.js") and user.get("role") != "admin":
            self._send_json({"error": "Forbidden"}, HTTPStatus.FORBIDDEN)
            return
        self._serve_static_file(candidate.name)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path

        user, sess, auth_reason = self._require_auth()
        if not user or not sess or auth_reason != "ok":
            self._send_json({"error": "Authentication required", "reason": auth_reason}, HTTPStatus.UNAUTHORIZED)
            return

        # Verify CSRF token header on all authenticated POST requests
        csrf_hdr = taint_check_ascii(self.headers.get("X-CSRF-Token", ""), 128, "")
        if not csrf_hdr or not hmac.compare_digest(csrf_hdr, sess["csrf"]):
            self._send_json({"error": "Invalid or missing CSRF token"}, HTTPStatus.FORBIDDEN)
            return

        body = self._read_json_body()
        if body is None:
            self._send_json(
                {"error": "Invalid, oversized, or non-ASCII-printable JSON payload"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        if route == "/api/scores":
            entry = {
                "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                "user": user["name"],
                "call": sanitize_call(body.get("call"), "VE3NEA"),
                "mode": sanitize_field(body.get("mode"), 16) or "SST",
                "wpm": safe_int(body.get("wpm"), 20, 5, 120),
                "rawQsos": safe_int(body.get("rawQsos"), 0, 0, 10000),
                "validQsos": safe_int(body.get("validQsos"), 0, 0, 10000),
                "mults": safe_int(body.get("mults"), 0, 0, 5000),
                "score": safe_int(body.get("score"), 0, 0, 100_000_000),
                "crc": sanitize_field(body.get("crc"), 16),
            }
            scores = save_score_entry(entry, user["sub"])
            self._send_json({"ok": True, "scores": scores}, HTTPStatus.CREATED)
            return

        if route == "/api/export/cabrillo":
            cabrillo = build_cabrillo(body)
            call = sanitize_call(body.get("myCall"), "VE3NEA")
            mode = sanitize_field(body.get("mode"), 12) or "SST"
            self._send_text_download(cabrillo, f"{call}_{mode}.log")
            return

        if route == "/api/export/adif":
            adif = build_adif(body)
            call = sanitize_call(body.get("myCall"), "VE3NEA")
            mode = sanitize_field(body.get("mode"), 12) or "SST"
            self._send_text_download(adif, f"{call}_{mode}.adi")
            return

        if route == "/api/admin/users/action":
            if user.get("role") != "admin":
                self._send_json({"error": "Admin privileges required"}, HTTPStatus.FORBIDDEN)
                return
            target_sub = sanitize_user_id(body.get("sub"))
            action = sanitize_field(body.get("action"), 16).lower()
            if not target_sub or action not in ("block", "unblock", "kick", "promote"):
                self._send_json({"error": "Invalid target user or action"}, HTTPStatus.BAD_REQUEST)
                return
            ok, message = admin_mutate_user(user["sub"], target_sub, action)
            status = HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST
            self._send_json(
                {"ok": ok, "message": message, "users": admin_List_users()},
                status,
            )
            return

        self._send_json({"error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)


def main() -> None:
    ensure_data_dir()
    host = os.environ.get("HOST", "0.0.0.0")
    port = safe_int(os.environ.get("PORT"), 8073, 1, 65535)

    server = DaemonThreadingHTTPServer((host, port), MorseRunnerHandler)

    def handle_signal(signum: int, _frame: Any) -> None:
        sys.stderr.write(f"\n[pyMorseRunner] Received signal {signum}, shutting down...\n")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    sys.stderr.write(f"[pyMorseRunner] Listening on http://{host}:{port}\n")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
