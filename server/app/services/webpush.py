"""
Web Push, server side (RFC 8030 delivery, RFC 8291 message encryption, RFC 8292 VAPID) — no
third-party push library: `cryptography` (already a dependency) does the P-256 ECDH, HKDF,
AES-128-GCM and the ES256 signature; `httpx` posts to the browser's push service.

Keys: the VAPID key pair identifies this server to the push services. Configure it with
`WEBPUSH_VAPID_PUBLIC_KEY` / `WEBPUSH_VAPID_PRIVATE_KEY` (base64url: the 65-byte uncompressed
public point and the 32-byte private scalar — `python -m scripts.generate_vapid_keys` prints a
fresh pair) and `WEBPUSH_VAPID_SUBJECT` (a `mailto:` or `https:` contact). The private key
lives only in the environment, never in the repository. Without both keys push is off.

Only Web Push. Nothing here sends SMS or WhatsApp.
"""
from __future__ import annotations

import base64
import json
import os
import struct
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


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    text = (text or "").strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ── Keys ─────────────────────────────────────────────────────────────────────


def generate_vapid_keys() -> Tuple[str, str]:
    """(private, public) as base64url: the raw 32-byte scalar and the 65-byte uncompressed point."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64u(private), b64u(public)


def private_key_from(b64: str) -> ec.EllipticCurvePrivateKey:
    raw = b64u_decode(b64)
    if len(raw) != 32:
        raise ValueError("VAPID private key must be 32 bytes (base64url)")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


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


def config() -> Optional[VapidConfig]:
    """The server's VAPID keys, or None (push off) when either is missing or unreadable."""
    from app.config import get_settings

    s = get_settings()
    public = (getattr(s, "webpush_vapid_public_key", "") or "").strip()
    private = (getattr(s, "webpush_vapid_private_key", "") or "").strip()
    if not public or not private:
        return None
    try:
        if public_key_of(private_key_from(private)) != public:
            return None  # a mismatched pair would sign tokens the browser's key cannot verify
    except ValueError:
        return None
    subject = (getattr(s, "webpush_vapid_subject", "") or "").strip()
    if not subject:
        base = (getattr(s, "exception_alerts_link_base_url", "") or "").strip() or s.pairing_mobile_app_base_url
        subject = base if base.startswith("https://") else "mailto:admin@localhost"
    return VapidConfig(public_key=public, private_key=private, subject=subject)


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
            # replaces an undelivered older one (a till offline → back → offline again).
            headers["Topic"] = "".join(ch for ch in topic if ch.isalnum() or ch in "-_")[:32]
        content = encrypt(body, p256dh, auth)
        if client is None:
            import httpx

            response = httpx.post(endpoint, content=content, headers=headers, timeout=10)
        else:
            response = client.post(endpoint, content=content, headers=headers, timeout=10)
    except Exception as exc:  # noqa: BLE001 - see the docstring
        return SendResult(ok=False, status=None, error=type(exc).__name__)
    status = getattr(response, "status_code", None)
    if status in (200, 201, 202):
        return SendResult(ok=True, status=status)
    return SendResult(ok=False, status=status, gone=status in (404, 410), error=f"http_{status}")
