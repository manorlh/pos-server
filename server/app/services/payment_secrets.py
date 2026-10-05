"""
Card-integration secrets (the Z-Credit terminal password) on the settings layers.

* **Write-only from the dashboard.** A PATCH of a layer's settings may carry
  `zcreditPassword` / `zcreditKey`; they are taken out of the patch before it touches the
  layer's `settings` JSON (`PosSettingsV1Patch` excludes them from every dump) and stored
  here instead. Nothing ever reads them back to the dashboard: it is told only whether a
  layer has one (`secret_status`), and shows "••••".
* **Encrypted at rest** with Fernet. The key is `PAYMENT_SECRETS_KEY` from the
  environment, or, when that is not set, one derived from `JWT_SECRET_KEY` — so a
  development server works out of the box, and production can rotate the JWT key
  without losing every stored password once it sets its own.
* **Read in the clear by one caller only:** the till's authenticated settings sync
  (`GET /sync/{machine_id}/settings`), for a till that charges on Z-Credit
  (app/services/payment_integration.py).
* **Layered like the settings:** the most specific layer that has a secret wins, so a
  shop's password reaches all its tills and one till can still have its own.
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.payment_secret import PAYMENT_SECRET_LEVELS, PaymentIntegrationSecret

#: Every secret a layer may hold, by its settings key.
ZCREDIT_PASSWORD = "zcreditPassword"
ZCREDIT_KEY = "zcreditKey"
SECRET_KEYS: Tuple[str, ...] = (ZCREDIT_PASSWORD, ZCREDIT_KEY)

#: A secret's longest accepted value.
SECRET_MAX = 200

#: What the dashboard shows in place of a stored secret. Sent back unchanged it means
#: "keep the one stored", never a new password made of bullets.
MASK_CHARS = frozenset("•*●·")


class PaymentSecretError(ValueError):
    """A secret value that cannot be stored. [code] is the API's `detail.code`."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# ── Encryption ───────────────────────────────────────────────────────────────


def _fernet():
    from cryptography.fernet import Fernet

    from app.config import get_settings

    settings = get_settings()
    own = (getattr(settings, "payment_secrets_key", "") or "").strip()
    if own:
        try:
            return Fernet(own.encode())
        except ValueError:
            # Not a Fernet key as it stands: use it as a passphrase, like the fallback.
            pass
    material = own or settings.jwt_secret_key
    digest = hashlib.sha256(b"r2m-payment-secrets:" + material.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> Optional[str]:
    """The clear text, or None when the token cannot be read (a key that changed)."""
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


# ── Values ───────────────────────────────────────────────────────────────────


def is_mask(value: Any) -> bool:
    """The dashboard's "••••" echoed back: keep what is stored."""
    return isinstance(value, str) and value.strip() != "" and set(value.strip()) <= MASK_CHARS


def clean_secret(value: Any) -> Optional[str]:
    """
    The value to store, or None to remove this layer's secret ("" or null). Refuses
    control characters and anything over SECRET_MAX: a password is typed, not pasted
    with a newline the gateway would then refuse at the first card.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise PaymentSecretError("secret_invalid")
    text = value.strip()
    if text == "":
        return None
    if len(text) > SECRET_MAX or any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise PaymentSecretError("secret_invalid")
    return text


def secret_patch(data: Any) -> Dict[str, Optional[str]]:
    """
    The secrets a `PosSettingsV1Patch` carries: key → value to store, or None to remove.
    Only the fields the caller sent; a masked echo ("••••") is left out (unchanged).
    """
    sent = getattr(data, "model_fields_set", set())
    out: Dict[str, Optional[str]] = {}
    for field, key in (("zcredit_password", ZCREDIT_PASSWORD), ("zcredit_key", ZCREDIT_KEY)):
        if field not in sent:
            continue
        raw = getattr(data, field, None)
        if is_mask(raw):
            continue
        out[key] = clean_secret(raw)
    return out


# ── Store ────────────────────────────────────────────────────────────────────


def _as_uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def apply_secret_patch(
    db: Session,
    level: str,
    entity_id: Any,
    patch: Dict[str, Optional[str]],
    *,
    tenant_id: Any = None,
    user_id: Any = None,
) -> bool:
    """
    Store or remove this layer's secrets; True when anything changed. The caller commits,
    and moves the layer's `settings_updated_at` so the tills pull again.
    """
    if not patch:
        return False
    if level not in PAYMENT_SECRET_LEVELS:
        raise PaymentSecretError("level_invalid")
    entity = _as_uuid(entity_id)
    if entity is None:
        raise PaymentSecretError("level_invalid")
    changed = False
    for key, value in patch.items():
        if key not in SECRET_KEYS:
            continue
        row = (
            db.query(PaymentIntegrationSecret)
            .filter(
                PaymentIntegrationSecret.level == level,
                PaymentIntegrationSecret.entity_id == entity,
                PaymentIntegrationSecret.key == key,
            )
            .first()
        )
        if value is None:
            if row is not None:
                db.delete(row)
                changed = True
            continue
        if row is None:
            row = PaymentIntegrationSecret(
                id=uuid.uuid4(), level=level, entity_id=entity, key=key, tenant_id=_as_uuid(tenant_id)
            )
            db.add(row)
        elif decrypt(row.ciphertext) == value:
            continue
        row.ciphertext = encrypt(value)
        row.updated_by = _as_uuid(user_id)
        row.updated_at = datetime.now(timezone.utc)
        changed = True
    if changed:
        db.flush()
    return changed


def secrets_for_layers(
    db: Session, layers: Sequence[Tuple[str, Any]]
) -> List[PaymentIntegrationSecret]:
    """Every secret row on these `(level, entity id)` layers, one query."""
    wanted = [(level, _as_uuid(eid)) for level, eid in layers if _as_uuid(eid) is not None]
    if not wanted:
        return []
    ids = list({eid for _, eid in wanted})
    rows = db.query(PaymentIntegrationSecret).filter(PaymentIntegrationSecret.entity_id.in_(ids)).all()
    pairs = set(wanted)
    return [r for r in rows if (r.level, _as_uuid(r.entity_id)) in pairs]


def merged_secret_sources(
    layers: Sequence[Tuple[str, Any]], rows: Iterable[PaymentIntegrationSecret]
) -> Dict[str, Tuple[str, PaymentIntegrationSecret]]:
    """
    Per secret key, the most specific layer that has one: key → (level, row). [layers]
    are `(level, entity id)` least specific first, as the settings merge.
    """
    by_layer: Dict[Tuple[str, Optional[uuid.UUID]], Dict[str, PaymentIntegrationSecret]] = {}
    for r in rows:
        by_layer.setdefault((r.level, _as_uuid(r.entity_id)), {})[r.key] = r
    out: Dict[str, Tuple[str, PaymentIntegrationSecret]] = {}
    for level, eid in layers:
        for key, row in by_layer.get((level, _as_uuid(eid)), {}).items():
            out[key] = (level, row)
    return out


def secret_status(
    db: Session, layers: Sequence[Tuple[str, Any]], own_level: str
) -> Dict[str, Dict[str, Any]]:
    """
    For the dashboard: per secret key, whether it is set, at which level, and whether
    on the layer being edited (`own`). Never the value.
    """
    rows = secrets_for_layers(db, layers)
    merged = merged_secret_sources(layers, rows)
    own_ids = {_as_uuid(eid) for level, eid in layers if level == own_level}
    own = {r.key: r for r in rows if r.level == own_level and _as_uuid(r.entity_id) in own_ids}
    out: Dict[str, Dict[str, Any]] = {}
    for key in SECRET_KEYS:
        hit = merged.get(key)
        own_row = own.get(key)
        out[key] = {
            "set": hit is not None,
            "source": hit[0] if hit else None,
            "own": own_row is not None,
            "updatedAt": own_row.updated_at if own_row is not None else None,
        }
    return out


def resolved_secret(db: Session, layers: Sequence[Tuple[str, Any]], key: str) -> Optional[str]:
    """The clear text of the most specific layer's secret, for the till's sync only."""
    hit = merged_secret_sources(layers, secrets_for_layers(db, layers)).get(key)
    return decrypt(hit[1].ciphertext) if hit else None
