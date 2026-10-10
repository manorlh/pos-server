"""
"מסמך שנדחה בענן" — the record of every till document the cloud refused.

Since 2026-10-07 the cloud refuses a till document only when it is not a document at all
(a payload the model cannot read, a write the database refuses); everything else lands
(`app.services.transactions.upsert_transactions`). A refusal must never stay silent again,
so every one is recorded here per till and document — first / last seen, attempts, the
latest reason and payload — and `landed_at` is set when the same document is later
stored. Read by the reconciliation report (check `refused_documents`) and the
transmissions report. Never fails the push it is called from.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.document_refusal import DocumentRefusal
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: The most of a document's payload kept (bytes of JSON); beyond it, a marker and the head.
PAYLOAD_MAX_BYTES = 64_000
REF_MAX = 120


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str):
        try:
            return uuid.UUID(value)
        except ValueError:
            return None
    return None


def _when(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return None


def _int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None and not isinstance(value, bool) else None
    except (TypeError, ValueError):
        return None


def _text(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    return str(value)[:limit]


def _payload(raw: Any) -> Any:
    """The document as sent, JSON-safe and capped."""
    try:
        text = json.dumps(raw, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = json.dumps(repr(raw), ensure_ascii=False)
    if len(text.encode("utf-8")) <= PAYLOAD_MAX_BYTES:
        return json.loads(text)
    return {"truncated": True, "head": text[: PAYLOAD_MAX_BYTES // 2]}


def document_ref(raw: Any, index: Optional[int] = None) -> str:
    """How the till identified the document: its id as sent, else its batch position."""
    doc_id = raw.get("id") if isinstance(raw, dict) else getattr(raw, "id", None)
    if doc_id is not None and str(doc_id).strip():
        return str(doc_id).strip()[:REF_MAX]
    return f"batch-index:{index if index is not None else '?'}"


def record(
    db: Session,
    machine: POSMachine,
    raw: Any,
    reason: str,
    *,
    index: Optional[int] = None,
    now: Optional[datetime] = None,
) -> None:
    """One refusal of one document: a new row, or the existing one's attempts and last sight."""
    now = now or datetime.now(timezone.utc)
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump(mode="json", by_alias=True)
    get = raw.get if isinstance(raw, dict) else (lambda _k, _d=None: None)
    ref = document_ref(raw, index)
    values = {
        "id": uuid.uuid4(),
        "tenant_id": machine.tenant_id,
        "machine_id": machine.id,
        "document_ref": ref,
        "document_id": _uuid(get("id")),
        "document_number": _text(get("transactionNumber"), 100),
        "document_type": _int(get("documentType")),
        "issued_at": _when(get("createdAt")),
        "total_amount": _text(get("totalAmount"), 40),
        "reason": (reason or "refused")[:2000],
        "attempts": 1,
        "first_seen_at": now,
        "last_seen_at": now,
        "payload": _payload(raw),
        "landed_at": None,
    }
    stmt = pg_insert(DocumentRefusal).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[DocumentRefusal.machine_id, DocumentRefusal.document_ref],
        set_={
            "attempts": DocumentRefusal.attempts + 1,
            "last_seen_at": stmt.excluded.last_seen_at,
            "reason": stmt.excluded.reason,
            "payload": stmt.excluded.payload,
            "document_number": stmt.excluded.document_number,
            "document_type": stmt.excluded.document_type,
            "issued_at": stmt.excluded.issued_at,
            "total_amount": stmt.excluded.total_amount,
            "landed_at": None,
        },
    )
    db.execute(stmt)
    _note_exception_log(db, machine.id, ref)


def _note_exception_log(db: Session, machine_id: Any, ref: str) -> None:
    """
    "יומן חריגות": the upsert bypasses the ORM, so the refusal is named to the log by hand;
    it is read back and logged once the push commits (app/services/exception_alerts/hooks.py).
    """
    try:
        from app.services.exception_alerts import hooks

        ident = (
            db.query(DocumentRefusal.id)
            .filter(DocumentRefusal.machine_id == machine_id, DocumentRefusal.document_ref == ref)
            .scalar()
        )
        hooks.note(db, "document_refusal", ident)
    except Exception:  # noqa: BLE001 - the refusal is recorded; only its log line is lost
        logger.exception("could not note a document refusal for the exceptions log")


def mark_landed(db: Session, machine: POSMachine, document_ids: Iterable[Any], now: Optional[datetime] = None) -> int:
    """The documents among `document_ids` this till had refused are now stored."""
    ids = [i for i in (_uuid(d) for d in document_ids) if i is not None]
    if not ids:
        return 0
    now = now or datetime.now(timezone.utc)
    return (
        db.query(DocumentRefusal)
        .filter(
            DocumentRefusal.machine_id == machine.id,
            DocumentRefusal.document_id.in_(ids),
            DocumentRefusal.landed_at.is_(None),
        )
        .update({DocumentRefusal.landed_at: now}, synchronize_session=False)
    )


def record_push_safely(
    db: Session,
    machine: POSMachine,
    *,
    raw_by_ref: Dict[str, Any],
    results: Sequence[Any],
    unidentified: Sequence[tuple] = (),
) -> None:
    """
    After a push: record its refusals and mark its stored documents landed. Inside a
    savepoint, and never raising — the push's own answer must not depend on its log.

    `raw_by_ref`: the documents as sent, by `document_ref` lower-cased. `results`: the per-document
    answers (`status` / `reason` / `id`). `unidentified`: `(index, raw, reason)` for the
    documents refused with no id to answer by.
    """
    savepoint = db.begin_nested()
    try:
        landed = []
        for r in results:
            status = getattr(r, "status", None)
            if status == "rejected":
                ref = str(getattr(r, "id", "")).strip()[:REF_MAX]
                raw = raw_by_ref.get(ref.lower()) or {"id": ref}
                record(db, machine, raw, getattr(r, "reason", None) or "rejected")
            elif status in ("accepted", "duplicate"):
                landed.append(getattr(r, "id", None))
        for index, raw, reason in unidentified:
            record(db, machine, raw, reason, index=index)
        mark_landed(db, machine, landed)
        savepoint.commit()
    except Exception:  # noqa: BLE001 - the log of a push never fails the push
        try:
            savepoint.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.exception("could not record the document refusals of machine %s", machine.id)


def as_row(r: DocumentRefusal) -> Dict[str, Any]:
    def iso(m):
        return m.isoformat() if m is not None else None

    return {
        "id": str(r.id),
        "machineId": str(r.machine_id),
        "documentRef": r.document_ref,
        "documentId": str(r.document_id) if r.document_id else None,
        "documentNumber": r.document_number,
        "documentType": r.document_type,
        "issuedAt": iso(r.issued_at),
        "totalAmount": r.total_amount,
        "reason": r.reason,
        "attempts": r.attempts,
        "firstSeenAt": iso(r.first_seen_at),
        "lastSeenAt": iso(r.last_seen_at),
        "landedAt": iso(r.landed_at),
    }


def refusals_for(
    db: Session,
    machine_ids: Sequence[Any],
    *,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
) -> List[DocumentRefusal]:
    """
    The refusals of these tills to show: every one still open (never landed), whenever it
    started, and those seen in [since, until) that landed since.
    """
    from sqlalchemy import and_, or_

    ids = list(machine_ids)
    if not ids:
        return []
    seen = []
    if since is not None:
        seen.append(DocumentRefusal.last_seen_at >= since)
    if until is not None:
        seen.append(DocumentRefusal.first_seen_at < until)
    cond = DocumentRefusal.landed_at.is_(None)
    if seen:
        cond = or_(cond, and_(*seen))
    return (
        db.query(DocumentRefusal)
        .filter(DocumentRefusal.machine_id.in_(ids), cond)
        .order_by(DocumentRefusal.first_seen_at.asc())
        .limit(2000)
        .all()
    )
