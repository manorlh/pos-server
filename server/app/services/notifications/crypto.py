"""
Encryption at rest and keyed hashes for personal data of the notification service and
the club.

* **Encryption** reuses the payment-secrets Fernet key (app/services/payment_secrets.py):
  one key to manage and rotate, the same "PAYMENT_SECRETS_KEY or derived from the JWT key"
  rule.
* **Keyed hashes** (HMAC-SHA256) stand in for a phone number wherever it must be compared
  (dedupe, suppression, "is this number a member") without being readable. The key is
  derived from the same material with its own label, so a hash is useless without the
  server's key — a plain SHA-256 of a phone number is reversible by enumeration.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any, Optional

from app.services import payment_secrets


def encrypt_text(value: str) -> str:
    return payment_secrets.encrypt(value)


def decrypt_text(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    return payment_secrets.decrypt(token)


def encrypt_json(value: Any) -> str:
    return encrypt_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def decrypt_json(token: Optional[str]) -> Any:
    text = decrypt_text(token)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _hash_key(label: bytes) -> bytes:
    from app.config import get_settings

    settings = get_settings()
    material = (getattr(settings, "payment_secrets_key", "") or "").strip() or settings.jwt_secret_key
    return hashlib.sha256(b"r2m-notifications-hash:" + label + b":" + material.encode("utf-8")).digest()


def keyed_hash(value: str, *, label: str = "phone") -> str:
    """Hex HMAC-SHA256 of [value] under the server key for [label]."""
    return hmac.new(_hash_key(label.encode("utf-8")), value.encode("utf-8"), hashlib.sha256).hexdigest()


def constant_time_equal(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def random_token(nbytes: int = 18) -> str:
    """URL-safe random token (`nbytes` of entropy), for QR / source / session tokens."""
    import secrets

    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode("ascii").rstrip("=")
