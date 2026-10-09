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
* **SynqPay's key comes from the till** (docs/SPEC_SYNQPAY.md §2.2): the till pairs with its
  terminal and sends the key (`POST /sync/{m}/synqpay/pairing`, a manager's write), stored on
  the machine's layer with when / which till / whose authority (`store_till_pairing`); a till
  that sees the terminal refuse its key says so (`mark_rejected`). Typing it in the dashboard
  stays possible, for the rare manual case.
"""
from __future__ import annotations

import base64
import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.payment_secret import (
    ORIGIN_DASHBOARD,
    ORIGIN_TILL_PAIRING,
    PAYMENT_SECRET_LEVELS,
    PaymentIntegrationSecret,
)

#: Every secret a layer may hold, by its settings key.
ZCREDIT_PASSWORD = "zcreditPassword"
ZCREDIT_KEY = "zcreditKey"
#: The SynqPay terminal's API key, from its pairing (docs/SPEC_SYNQPAY.md).
SYNQPAY_API_KEY = "synqpayApiKey"
SECRET_KEYS: Tuple[str, ...] = (ZCREDIT_PASSWORD, ZCREDIT_KEY, SYNQPAY_API_KEY)

#: A SynqPay API key as its pairing hands it out ("1234abcd" in the docs): letters and digits.
_SYNQPAY_API_KEY = re.compile(r"^[A-Za-z0-9]{1,64}$")

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
    for field, key in (
        ("zcredit_password", ZCREDIT_PASSWORD),
        ("zcredit_key", ZCREDIT_KEY),
        ("synqpay_api_key", SYNQPAY_API_KEY),
    ):
        if field not in sent:
            continue
        raw = getattr(data, field, None)
        if is_mask(raw):
            continue
        value = clean_secret(raw)
        if key == SYNQPAY_API_KEY and value is not None and not _SYNQPAY_API_KEY.match(value):
            raise PaymentSecretError("secret_invalid")
        out[key] = value
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
        _set_origin(row, ORIGIN_DASHBOARD)
        changed = True
    if changed:
        db.flush()
    return changed


def _set_origin(
    row: PaymentIntegrationSecret,
    origin: str,
    *,
    paired_at: Optional[datetime] = None,
    machine_id: Any = None,
    pos_user_id: Any = None,
    user_id: Any = None,
    serial: Optional[str] = None,
) -> None:
    """A new value: where it came from, and no rejection (that was about the old one)."""
    row.origin = origin
    row.paired_at = paired_at
    row.paired_by_machine_id = _as_uuid(machine_id)
    row.paired_by_pos_user_id = _as_uuid(pos_user_id)
    row.paired_by_user_id = _as_uuid(user_id)
    row.terminal_serial = serial
    row.rejected_at = None
    row.rejected_by_machine_id = None


# ── The SynqPay pairing at the till (docs/SPEC_SYNQPAY.md §2.2) ──────────────


def is_synqpay_api_key(value: Any) -> bool:
    """A key as SynqPay's `authenticate` hands it out: letters and digits ("1234abcd")."""
    return isinstance(value, str) and bool(_SYNQPAY_API_KEY.match(value.strip()))


def store_till_pairing(
    db: Session,
    machine: Any,
    api_key: str,
    *,
    serial: Optional[str] = None,
    pos_user_id: Any = None,
    user_id: Any = None,
    now: Optional[datetime] = None,
) -> PaymentIntegrationSecret:
    """
    The key [machine] got by pairing with its SynqPay terminal, on the machine's own layer,
    encrypted — with when, by which till and on whose authority. Replaces whatever key the
    machine's layer held (a key typed by hand too). The caller commits.
    """
    value = clean_secret(api_key)
    if value is None or not _SYNQPAY_API_KEY.match(value):
        raise PaymentSecretError("secret_invalid")
    entity = _as_uuid(machine.id)
    row = (
        db.query(PaymentIntegrationSecret)
        .filter(
            PaymentIntegrationSecret.level == "machine",
            PaymentIntegrationSecret.entity_id == entity,
            PaymentIntegrationSecret.key == SYNQPAY_API_KEY,
        )
        .first()
    )
    at = now or datetime.now(timezone.utc)
    if row is None:
        row = PaymentIntegrationSecret(
            id=uuid.uuid4(), level="machine", entity_id=entity, key=SYNQPAY_API_KEY,
            tenant_id=_as_uuid(getattr(machine, "tenant_id", None)),
        )
        db.add(row)
    row.ciphertext = encrypt(value)
    row.updated_by = _as_uuid(user_id)
    row.updated_at = at
    _set_origin(
        row, ORIGIN_TILL_PAIRING, paired_at=at, machine_id=machine.id,
        pos_user_id=pos_user_id, user_id=user_id, serial=serial,
    )
    db.flush()
    return row


def mark_rejected(
    db: Session, layers: Sequence[Tuple[str, Any]], key: str, machine: Any, *, now: Optional[datetime] = None
) -> Optional[PaymentIntegrationSecret]:
    """
    The terminal refused the key [machine] uses (the most specific layer's): marked on that
    row, once — a later report of the same refusal keeps the first time. None when the
    machine has no key at all (nothing to mark: it is simply not paired).
    """
    hit = merged_secret_sources(layers, secrets_for_layers(db, layers)).get(key)
    if hit is None:
        return None
    row = hit[1]
    if row.rejected_at is None:
        # updated_at is the value's own time: a report must not move it. An explicit
        # "updated_at = updated_at" keeps the column's onupdate out of this UPDATE.
        row.updated_at = PaymentIntegrationSecret.updated_at
        row.rejected_at = now or datetime.now(timezone.utc)
        row.rejected_by_machine_id = _as_uuid(machine.id)
        db.flush()
    return row


def pairing_status(db: Session, row: Optional[PaymentIntegrationSecret]) -> Dict[str, Any]:
    """Where a key came from and whether it was refused, for the dashboard. Never the value."""
    if row is None:
        return {
            "origin": None, "pairedAt": None, "pairedByMachineId": None, "pairedByMachineName": None,
            "terminalSerial": None, "rejectedAt": None, "rejectedByMachineId": None, "rejectedByMachineName": None,
        }
    from app.models.pos_machine import POSMachine

    ids = {i for i in (_as_uuid(row.paired_by_machine_id), _as_uuid(row.rejected_by_machine_id)) if i is not None}
    names: Dict[uuid.UUID, str] = {}
    if ids:
        for m in db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all():
            names[_as_uuid(m.id)] = m.name
    return {
        "origin": row.origin,
        "pairedAt": row.paired_at,
        "pairedByMachineId": str(row.paired_by_machine_id) if row.paired_by_machine_id else None,
        "pairedByMachineName": names.get(_as_uuid(row.paired_by_machine_id)),
        "terminalSerial": row.terminal_serial,
        "rejectedAt": row.rejected_at,
        "rejectedByMachineId": str(row.rejected_by_machine_id) if row.rejected_by_machine_id else None,
        "rejectedByMachineName": names.get(_as_uuid(row.rejected_by_machine_id)),
    }


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
    # SynqPay's key: paired at a till, or typed; refused by the terminal (SPEC_SYNQPAY.md §2.2).
    hit = merged.get(SYNQPAY_API_KEY)
    out[SYNQPAY_API_KEY]["pairing"] = pairing_status(db, hit[1] if hit else None)
    return out


def resolved_secret(db: Session, layers: Sequence[Tuple[str, Any]], key: str) -> Optional[str]:
    """The clear text of the most specific layer's secret, for the till's sync only."""
    hit = merged_secret_sources(layers, secrets_for_layers(db, layers)).get(key)
    return decrypt(hit[1].ciphertext) if hit else None
