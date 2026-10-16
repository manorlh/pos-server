"""
Web Push, server side (RFC 8030 delivery, RFC 8291 message encryption, RFC 8292 VAPID) — no
third-party push library: `cryptography` (already a dependency) does the P-256 ECDH, HKDF,
AES-128-GCM and the ES256 signature; `httpx` posts to the browser's push service.

Keys: the VAPID key pair identifies this server to the push services. Configure it with
`WEBPUSH_VAPID_PUBLIC_KEY` / `WEBPUSH_VAPID_PRIVATE_KEY` (base64url: the 65-byte uncompressed
public point and the 32-byte private scalar — `python -m scripts.generate_vapid_keys` prints a
fresh pair) and `WEBPUSH_VAPID_SUBJECT` (a `mailto:` or `https:` contact). The private key
lives only in the environment, never in the repository. Without the private key push is off.

The keys are read forgivingly (fix/pwa-push): surrounding quotes and whitespace, standard base64
or padding, and a PEM / DER private key are all accepted, and the public key handed to browsers
is always the one DERIVED from the private key — a public key in the environment that does not
match it (pasted from another pair) is logged and ignored instead of turning push off without
a word. `config_problem()` names what is wrong (codes only, never a key).

Only Web Push. Nothing here sends SMS or WhatsApp.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import struct
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

#: One record holds the whole message (a notification is far below it).
RECORD_SIZE = 4096
#: The VAPID token's lifetime (push services accept up to 24 h).
JWT_TTL_SECONDS = 12 * 60 * 60
#: How long the push service keeps an undelivered message (a phone off for the night).
DEFAULT_TTL = 6 * 60 * 60
MAX_PAYLOAD = 3000
#: One push service answering slowly must not hold the sender for long.
SEND_TIMEOUT = 5
#: The Topic header's alphabet (RFC 8030 §5.4: URL-safe base64).
_TOPIC_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

logger = logging.getLogger(__name__)


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    """base64url — or standard base64 — with or without padding."""
    text = "".join((text or "").split()).replace("+", "-").replace("/", "_").rstrip("=")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _clean_env(text: Optional[str]) -> str:
    """An environment value as pasted: whitespace and one pair of surrounding quotes removed."""
    text = (text or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = text[1:-1].strip()
    # A PEM pasted into one line keeps literal "\n".
    return text.replace("\\n", "\n")


# ── Keys ─────────────────────────────────────────────────────────────────────


def generate_vapid_keys() -> Tuple[str, str]:
    """(private, public) as base64url: the raw 32-byte scalar and the 65-byte uncompressed point."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64u(private), b64u(public)


def private_key_from(b64: str) -> ec.EllipticCurvePrivateKey:
    """
    The VAPID private key: the raw 32-byte scalar (base64url, what `generate_vapid_keys` and the
    `web-push` CLI print) — or a PEM / base64 DER (PKCS#8 or SEC1) P-256 key, as other tools write it.
    """
    text = _clean_env(b64)
    if text.startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(text.encode("ascii"), password=None)
        return _p256(key)
    try:
        raw = b64u_decode(text)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("VAPID private key is not base64") from exc
    if len(raw) == 32:
        return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
    try:
        key = serialization.load_der_private_key(raw, password=None)
    except (ValueError, TypeError) as exc:
        raise ValueError("VAPID private key must be 32 bytes (base64url), PEM or DER") from exc
    return _p256(key)


def _p256(key: Any) -> ec.EllipticCurvePrivateKey:
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ValueError("VAPID private key must be a P-256 (prime256v1) key")
    return key


def public_key_of(private: ec.EllipticCurvePrivateKey) -> str:
    return b64u(private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def valid_client_key(p256dh: str, auth: str) -> bool:
    """A browser's subscription keys: a P-256 point and a 16-byte secret."""
    try:
        point = b64u_decode(p256dh)
        secret = b64u_decode(auth)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    except Exception:  # noqa: BLE001 - anything unreadable is invalid
        return False
    return len(point) == 65 and len(secret) == 16


# ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────


def audience_of(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}"


def vapid_jwt(endpoint: str, private: ec.EllipticCurvePrivateKey, subject: str, *, now: Optional[float] = None) -> str:
    now = time.time() if now is None else now
    header = {"typ": "JWT", "alg": "ES256"}
    claims = {"aud": audience_of(endpoint), "exp": int(now) + JWT_TTL_SECONDS, "sub": subject}
    signing_input = (
        b64u(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64u(json.dumps(claims, separators=(",", ":")).encode())
    )
    der = private.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


# ── Encryption (RFC 8291, aes128gcm) ─────────────────────────────────────────


def _hkdf(salt: bytes, info: bytes, length: int, ikm: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(
    payload: bytes,
    p256dh: str,
    auth: str,
    *,
    salt: Optional[bytes] = None,
    server_key: Optional[ec.EllipticCurvePrivateKey] = None,
) -> bytes:
    """The request body: header (salt, record size, our ephemeral public key) + one encrypted record."""
    ua_public = b64u_decode(p256dh)
    auth_secret = b64u_decode(auth)
    as_private = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = as_private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    shared = as_private.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, b"WebPush: info\x00" + ua_public + as_public, 32, shared)
    salt = salt or os.urandom(16)
    cek = _hkdf(salt, b"Content-Encoding: aes128gcm\x00", 16, ikm)
    nonce = _hkdf(salt, b"Content-Encoding: nonce\x00", 12, ikm)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack("!I", RECORD_SIZE) + bytes([len(as_public)]) + as_public + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """What the browser does (tests only): the plaintext of one aes128gcm record."""
    salt, rs, idlen = body[:16], struct.unpack("!I", body[16:20])[0], body[20]
    as_public = body[21:21 + idlen]
    ciphertext = body[21 + idlen:]
    ua_public = ua_private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = ua_private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    ikm = _hkdf(b64u_decode(auth), b"WebPush: info\x00" + ua_public + as_public, 32, shared)
    cek = _hkdf(salt, b"Content-Encoding: aes128gcm\x00", 16, ikm)
    nonce = _hkdf(salt, b"Content-Encoding: nonce\x00", 12, ikm)
    plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert rs == RECORD_SIZE
    return plain.rstrip(b"\x00")[:-1]  # drop the padding delimiter (0x02)


# ── Sending ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VapidConfig:
    public_key: str
    private_key: str
    subject: str


@dataclass(frozen=True)
class SendResult:
    ok: bool
    status: Optional[int]
    #: The subscription is gone for good (404 / 410): never send to it again.
    gone: bool = False
    error: Optional[str] = None
    #: What the push service said, shortened (its reason for a 4xx: a VAPID mismatch, a bad
    #: token…) — diagnosis only; never the endpoint or a key.
    detail: Optional[str] = None


#: The browsers' push services by host (the host itself or any subdomain) — named in logs and
#: in the diagnosis.
SERVICES = (
    ("fcm.googleapis.com", "fcm"),         # Chrome (Windows, Android), Samsung Internet, Opera
    ("notify.windows.com", "wns"),         # Edge on Windows
    ("push.services.mozilla.com", "mozilla"),
    ("push.apple.com", "apple"),
)


def service_of(endpoint: str) -> str:
    """"fcm" / "wns" / "mozilla" / "apple" / "other" — which push service an endpoint belongs to."""
    try:
        host = (urlsplit(endpoint or "").hostname or "").lower()
    except ValueError:
        return "other"
    for domain, name in SERVICES:
        if host == domain or host.endswith("." + domain):
            return name
    return "other"


#: Problems already logged by this process (each once, not on every send).
_logged: set = set()
_log_lock = threading.Lock()


def _log_once(code: str, message: str, level: int = logging.WARNING) -> None:
    with _log_lock:
        if code in _logged:
            return
        _logged.add(code)
    logger.log(level, message)


def _settings_keys() -> Tuple[str, str, str]:
    from app.config import get_settings

    s = get_settings()
    return (
        _clean_env(getattr(s, "webpush_vapid_public_key", "") or ""),
        _clean_env(getattr(s, "webpush_vapid_private_key", "") or ""),
        _clean_env(getattr(s, "webpush_vapid_subject", "") or ""),
    )


def config_problem() -> Optional[str]:
    """
    What keeps push from working as configured, as a code (never a key): "missing_private_key",
    "private_key_unreadable" (push is off), "public_key_mismatch" / "public_key_missing" (push
    works with the public key derived from the private one), "subject_localhost" (Safari refuses
    it), or None.
    """
    public, private, subject = _settings_keys()
    if not private:
        return "missing_private_key"
    try:
        derived = public_key_of(private_key_from(private))
    except ValueError:
        return "private_key_unreadable"
    if not public:
        return "public_key_missing"
    try:
        if b64u(b64u_decode(public)) != derived:
            return "public_key_mismatch"
    except (binascii.Error, ValueError):
        return "public_key_mismatch"
    if _subject(subject).endswith("@localhost"):
        return "subject_localhost"
    return None


def _subject(configured: str) -> str:
    if configured:
        return configured if configured.startswith(("mailto:", "https://")) else f"mailto:{configured}"
    from app.config import get_settings

    s = get_settings()
    base = (getattr(s, "exception_alerts_link_base_url", "") or "").strip() or (
        getattr(s, "pairing_mobile_app_base_url", "") or "")
    return base if base.startswith("https://") else "mailto:admin@localhost"


def config() -> Optional[VapidConfig]:
    """
    The server's VAPID keys, or None (push off) when the private key is missing or unreadable.
    The public key is always the one derived from the private key: a public key in the
    environment that differs (padding, standard base64, or from another pair) is logged once and
    never handed to a browser — a browser subscribed with it could never verify our tokens.
    """
    public, private, subject = _settings_keys()
    if not private:
        if public:
            _log_once("missing_private_key",
                      "push: WEBPUSH_VAPID_PUBLIC_KEY is set but WEBPUSH_VAPID_PRIVATE_KEY is not — phone alerts are off")
        return None
    try:
        derived = public_key_of(private_key_from(private))
    except ValueError:
        _log_once("private_key_unreadable", "push: WEBPUSH_VAPID_PRIVATE_KEY is not a P-256 key (base64url 32 bytes, "
                  "PEM or DER) — phone alerts are off", logging.ERROR)
        return None
    if public:
        try:
            same = b64u(b64u_decode(public)) == derived
        except (binascii.Error, ValueError):
            same = False
        if not same:
            _log_once("public_key_mismatch", "push: WEBPUSH_VAPID_PUBLIC_KEY does not belong to WEBPUSH_VAPID_PRIVATE_KEY — "
                      "using the public key derived from the private key", logging.ERROR)
    else:
        _log_once("public_key_missing", "push: WEBPUSH_VAPID_PUBLIC_KEY is not set — using the public key derived from "
                  "the private key", logging.INFO)
    resolved_subject = _subject(subject)
    if resolved_subject.endswith("@localhost"):
        _log_once("subject_localhost", "push: WEBPUSH_VAPID_SUBJECT is not set (mailto:admin@localhost) — Safari / iPhone "
                  "refuse it; set a real mailto: or https: contact")
    return VapidConfig(public_key=derived, private_key=private, subject=resolved_subject)


def send(
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: Dict[str, Any],
    *,
    vapid: VapidConfig,
    ttl: int = DEFAULT_TTL,
    urgency: str = "high",
    topic: Optional[str] = None,
    client: Any = None,
    timeout: float = SEND_TIMEOUT,
) -> SendResult:
    """Encrypt and post one message. Never raises: a failure is a result."""
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_PAYLOAD:
            payload = {**payload, "body": str(payload.get("body") or "")[:400]}
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        private = private_key_from(vapid.private_key)
        headers = {
            "Authorization": f"vapid t={vapid_jwt(endpoint, private, vapid.subject)}, k={vapid.public_key}",
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(int(ttl)),
            "Urgency": urgency,
        }
        if topic:
            # ≤ 32 characters of the URL-safe base64 alphabet: a newer message of the same topic
            # replaces an undelivered older one (a till offline → back → offline again). ASCII only:
            # a Hebrew letter passes str.isalnum() and would break the header.
            cleaned = "".join(ch for ch in topic if ch in _TOPIC_CHARS)[:32]
            if cleaned:
                headers["Topic"] = cleaned
        content = encrypt(body, p256dh, auth)
        if client is None:
            import httpx

            response = httpx.post(endpoint, content=content, headers=headers, timeout=timeout)
        else:
            response = client.post(endpoint, content=content, headers=headers, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - see the docstring
        return SendResult(ok=False, status=None, error=type(exc).__name__)
    status = getattr(response, "status_code", None)
    if status in (200, 201, 202):
        return SendResult(ok=True, status=status)
    return SendResult(ok=False, status=status, gone=status in (404, 410), error=f"http_{status}",
                      detail=_answer(response))


def _answer(response: Any) -> Optional[str]:
    """The push service's reason, one short line (FCM / WNS / Mozilla put it in the body or a header)."""
    try:
        text = getattr(response, "text", None)
        text = text() if callable(text) else text
    except Exception:  # noqa: BLE001 - a reason is a nicety
        text = None
    if not text:
        headers = getattr(response, "headers", None) or {}
        try:
            text = headers.get("X-WNS-Error-Description") or headers.get("x-wns-error-description") or headers.get("X-WNS-Status")
        except Exception:  # noqa: BLE001
            text = None
    if not text:
        return None
    return " ".join(str(text).split())[:200] or None
