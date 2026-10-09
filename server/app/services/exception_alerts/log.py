"""
Writing the exceptions log ("יומן חריגות").

* `record(db, spec)` — one row per source event, idempotent on `dedupe_key`: the same
  source event again finds its row and, while nobody acknowledged it, refreshes its
  figures (a re-pushed document, a refusal tried again); it never adds a second row and
  never overwrites a manager's "טופל". Returns `(entry, created)`.
* `acknowledge(db, entry, …)` — "טופל" with a note (or back to open). For an entry that
  mirrors an `audit_exceptions` row, that row is marked reviewed / new as well, so the
  exceptions report and the log never disagree.
* Short codes (`short_code`) — 8 characters from an unambiguous alphabet, for the SMS
  link `<dashboard>/x/<code>`.
"""
from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.exception_alerts import ExceptionLogEntry

#: No 0/o, 1/l/i: read aloud or typed from a phone without doubt.
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
CODE_LENGTH = 8


def new_short_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: Optional[datetime]) -> Optional[datetime]:
    """SQLite hands back naive datetimes; everything here is UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def as_uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def as_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except Exception:  # noqa: BLE001 - a figure that does not read is simply not one
        return None


@dataclass
class EntrySpec:
    """What a source says about one exception event (app/services/exception_alerts/sources.py)."""

    source: str
    source_id: str
    dedupe_key: str
    kind: str
    severity: str
    occurred_at: datetime
    tenant_id: Any = None
    company_id: Any = None
    shop_id: Any = None
    area_id: Any = None
    machine_id: Any = None
    pos_user_id: Optional[str] = None
    pos_user_name: Optional[str] = None
    amount: Any = None
    value: Any = None
    threshold: Any = None
    summary: Optional[str] = None
    details: Optional[Dict[str, Any]] = None
    transaction_id: Any = None
    shift_id: Any = None
    z_report_id: Any = None
    till_event_id: Any = None
    audit_exception_id: Any = None
    received_at: Optional[datetime] = None
    #: The source's own review state, mirrored (audit_exceptions): (at, user id, note) or
    #: None = open. `mirror_ack=False`: the source has no review state of its own.
    ack: Optional[Tuple[Optional[datetime], Any, Optional[str]]] = None
    mirror_ack: bool = False
    #: Fields refreshed on an existing, still-open entry.
    refresh: Tuple[str, ...] = field(default=("amount", "value", "threshold", "summary", "details", "severity",
                                              "pos_user_id", "pos_user_name", "transaction_id", "shift_id",
                                              "z_report_id"))


def _values(spec: EntrySpec) -> Dict[str, Any]:
    return dict(
        tenant_id=as_uuid(spec.tenant_id),
        company_id=as_uuid(spec.company_id),
        shop_id=as_uuid(spec.shop_id),
        area_id=as_uuid(spec.area_id),
        machine_id=as_uuid(spec.machine_id),
        kind=spec.kind[:40],
        severity=(spec.severity or "medium")[:16],
        source=spec.source[:32],
        source_id=(spec.source_id or None) and str(spec.source_id)[:100],
        pos_user_id=(spec.pos_user_id or None) and str(spec.pos_user_id)[:100],
        pos_user_name=(spec.pos_user_name or None) and str(spec.pos_user_name)[:200],
        amount=as_decimal(spec.amount),
        value=as_decimal(spec.value),
        threshold=as_decimal(spec.threshold),
        summary=(spec.summary or None) and str(spec.summary)[:300],
        details=spec.details or None,
        transaction_id=as_uuid(spec.transaction_id),
        shift_id=as_uuid(spec.shift_id),
        z_report_id=as_uuid(spec.z_report_id),
        till_event_id=as_uuid(spec.till_event_id),
        audit_exception_id=as_uuid(spec.audit_exception_id),
        occurred_at=aware(spec.occurred_at) or utcnow(),
    )


def find(db: Session, dedupe_key: str) -> Optional[ExceptionLogEntry]:
    return db.query(ExceptionLogEntry).filter(ExceptionLogEntry.dedupe_key == dedupe_key[:200]).first()


def _mirror_ack(entry: ExceptionLogEntry, spec: EntrySpec) -> bool:
    if not spec.mirror_ack:
        return False
    at, user_id, note = spec.ack if spec.ack is not None else (None, None, None)
    if spec.ack is None:
        changed = entry.acknowledged_at is not None
        entry.acknowledged_at = None
        entry.acknowledged_by_user_id = None
        return changed
    changed = entry.acknowledged_at is None or entry.note != note
    entry.acknowledged_at = aware(at) or entry.acknowledged_at or utcnow()
    entry.acknowledged_by_user_id = as_uuid(user_id)
    entry.note = note
    return changed


def record(db: Session, spec: EntrySpec, *, backfilled: bool = False, now: Optional[datetime] = None) -> Tuple[ExceptionLogEntry, bool]:
    """Write or refresh the entry of one source event. The caller commits."""
    key = spec.dedupe_key[:200]
    existing = find(db, key)
    if existing is not None:
        _refresh(existing, spec)
        return existing, False
    values = _values(spec)
    for _attempt in range(4):
        row = ExceptionLogEntry(
            id=uuid.uuid4(),
            dedupe_key=key,
            short_code=new_short_code(),
            received_at=aware(spec.received_at) or now or utcnow(),
            backfilled=backfilled,
            **values,
        )
        if spec.mirror_ack:
            _mirror_ack(row, spec)
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            # The same source event written by a parallel request: that row is the one.
            existing = find(db, key)
            if existing is not None:
                return existing, False
            continue  # a short code taken: draw another
        return row, True
    raise RuntimeError("exception log: could not allocate a short code")


def _refresh(entry: ExceptionLogEntry, spec: EntrySpec) -> None:
    values = _values(spec)
    if entry.acknowledged_at is None:
        for name in spec.refresh:
            new = values.get(name)
            if new is not None and getattr(entry, name) != new:
                setattr(entry, name, new)
    _mirror_ack(entry, spec)


def acknowledge(db: Session, entry: ExceptionLogEntry, *, user: Any, acknowledged: bool,
                note: Optional[str], now: Optional[datetime] = None) -> ExceptionLogEntry:
    """"טופל" (with a note) or back to open; mirrored onto its `audit_exceptions` row."""
    now = now or utcnow()
    clean_note = (note.strip() or None) if note is not None else entry.note
    if acknowledged:
        entry.acknowledged_at = now
        entry.acknowledged_by_user_id = getattr(user, "id", None)
        entry.note = clean_note
    else:
        entry.acknowledged_at = None
        entry.acknowledged_by_user_id = None
        if note is not None:
            entry.note = clean_note
    if entry.audit_exception_id is not None:
        from app.models.audit_exception import AuditException

        ae = db.get(AuditException, entry.audit_exception_id)
        if ae is not None:
            if acknowledged:
                if ae.status == "new":
                    ae.status = "reviewed"
                ae.reviewed_by_user_id = entry.acknowledged_by_user_id
                ae.reviewed_at = now
                ae.review_note = entry.note
            else:
                ae.status = "new"
                ae.reviewed_by_user_id = None
                ae.reviewed_at = None
                if note is not None:
                    ae.review_note = entry.note
    return entry
