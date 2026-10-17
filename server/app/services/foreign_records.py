"""
A device's records of another pairing (P:/specs/foreign-records-upload.md §3, §4).

The owner (17.10.2026): "אם צומד מחדש ויש בו עסקאות של קופה אחרת — תעלה את המסמכים לקופה הרלוונטית".
Rule above all: a fiscal record is never lost and never filed under a machine / shop / tenant other
than the one it was made under.

**§3 — the ordinary sync never carries another pairing's rows.** `POST /sync/{B}/transactions`
refuses a document (`rejected`, reason `document_foreign_machine`, nothing stored) when it is
*provably* another machine's:

* its `machineId` stamp is neither B nor a machine in B's predecessor chain
  (`document_filing.predecessor_chain` — a linked re-pairing of the same device), or
* it carries no stamp and names a shift the cloud holds for such a machine.

A document with no stamp and no foreign shift is filed exactly as before (`foreign_document`
returns None), and so is one the cloud already holds under B or its chain (a re-push of what is
already filed changes nothing). Transmission reports and cash movements whose own `machineId` is
another machine's are `409 document_foreign_machine` (`refuse_foreign_stamp`).

**§4 — the upload.** `POST /sync/{B}/foreign-records` files a device's previous-pairing records
(machine A) exactly as A's, through the same services as A's own sync (`upsert_transactions(db, A,
…, pushed_by=B)`, `report_shift_open`, `check_close_preconditions` + `apply_shift_close`, the
transmission / offline authorization / cash movement handlers). Same tenant only. A's shift is
never closed by the cloud here; a close the device sends is A's own close.
"""
from __future__ import annotations

import logging
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.transaction import Transaction

logger = logging.getLogger(__name__)

#: The per-document reason on the ordinary sync, the transmission / cash movement 409, and a §4
#: record whose own stamp is not A.
DOCUMENT_FOREIGN_MACHINE = "document_foreign_machine"
#: Exception kinds (app/services/exceptions.py RULE_SPECS) — support's (push INTEGRITY_KINDS).
KIND_REFUSED_ON_SYNC = "document_foreign_machine"
KIND_UPLOADED = "foreign_records_uploaded"
KIND_REFUSED = "foreign_records_refused"

#: Whole-request refusals (409, nothing written).
FOREIGN_MACHINE_UNKNOWN = "foreign_machine_unknown"
FOREIGN_MACHINE_OTHER_TENANT = "foreign_machine_other_tenant"
FOREIGN_MACHINE_IS_SELF = "foreign_machine_is_self"

#: Per-record codes.
FOREIGN_NUMBER_CONFLICT = "foreign_number_conflict"
INVALID_RECORD = "invalid_record"
UNSUPPORTED_KIND = "unsupported_kind"
SHIFT_BELONGS_TO_ANOTHER_MACHINE = "shift_belongs_to_another_machine"

MAX_RECORDS = 200
KINDS = ("shift_open", "transaction", "shift_close", "transmission", "cash_movement", "offline_authorization")
KIND_LABELS = {
    "transaction": "מסמכים",
    "shift_open": "פתיחות משמרת",
    "shift_close": "סגירות משמרת",
    "transmission": "שידורי אשראי",
    "cash_movement": "תנועות מזומן",
    "offline_authorization": "אישורי אשראי לא מקוונים",
}


class ForeignUploadRefused(Exception):
    """A whole §4 request refused: `409 {"detail": code}`, nothing written."""

    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def _label(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "—"
    number = (getattr(machine, "pos_number", None) or "").strip()
    return f"קופה {number}" if number else (machine.name or str(machine.id))


def own_machine_ids(db: Session, machine: POSMachine) -> Set[str]:
    """B and the machines this device was before (a linked re-pairing): whose rows B may carry."""
    from app.services.document_filing import predecessor_chain

    return {str(machine.id)} | {str(m.id) for m in predecessor_chain(db, machine)}


# ── §3: the ordinary sync ────────────────────────────────────────────────────


def foreign_document(db: Session, machine: POSMachine, tx: Any, own: Optional[Set[str]] = None) -> Optional[Dict[str, Any]]:
    """
    {issuerMachineId, why} when `tx` (a `TransactionIn`) is provably another machine's — its stamp,
    or (no stamp) the shift it names — and the cloud does not already hold it under B or its
    chain; else None (filed as always).
    """
    own = own if own is not None else own_machine_ids(db, machine)
    stamp = getattr(tx, "machine_id", None)
    issuer: Optional[str] = None
    why: Optional[str] = None
    if stamp is not None:
        if str(stamp) not in own:
            issuer, why = str(stamp), "stamped"
    elif getattr(tx, "shift_id", None) is not None:
        row = db.query(Shift.machine_id).filter(Shift.id == tx.shift_id).first()
        if row is not None and str(row[0]) not in own:
            issuer, why = str(row[0]), "foreign_shift"
    if issuer is None:
        return None
    held = db.query(Transaction.machine_id).filter(Transaction.id == tx.id).first()
    if held is not None and str(held[0]) in own:
        # Already filed under this till (before this guard existed): a re-push stores nothing new.
        return None
    return {"issuerMachineId": issuer, "why": why, "shiftId": str(tx.shift_id) if getattr(tx, "shift_id", None) else None}


def split_foreign(db: Session, machine: POSMachine, valid: Sequence[tuple]) -> tuple:
    """
    `valid` — (index, TransactionIn, warnings) as `validate_documents` gives them. Returns (the ones
    to file, [(index, TransactionUpsertResult rejected)], [(tx, found)] for the alerts).
    """
    from app.schemas.transaction import TransactionUpsertResult

    if not valid:
        return list(valid), [], []
    own = own_machine_ids(db, machine)
    keep, refused, found_all = [], [], []
    for entry in valid:
        tx = entry[1]
        found = foreign_document(db, machine, tx, own)
        if found is None:
            keep.append(entry)
            continue
        logger.warning(
            "machine %s pushed document %s of machine %s (%s): refused, nothing stored",
            machine.id, tx.id, found["issuerMachineId"], found["why"],
        )
        refused.append((entry[0], TransactionUpsertResult(id=tx.id, status="rejected", reason=DOCUMENT_FOREIGN_MACHINE)))
        found_all.append((tx, found))
    return keep, refused, found_all


def alert_refused_on_sync(db: Session, machine: POSMachine, found: Iterable[tuple]) -> None:
    """One `document_foreign_machine` exception per refused document (support's). Never raises."""
    from app.services.exceptions import record_z_exception

    found = list(found)
    if not found:
        return
    savepoint = db.begin_nested()
    try:
        now = datetime.now(timezone.utc)
        for tx, info in found:
            issuer = db.get(POSMachine, _uuid(info["issuerMachineId"])) if _uuid(info["issuerMachineId"]) else None
            record_z_exception(
                db, machine,
                exception_type=KIND_REFUSED_ON_SYNC,
                key=f"{KIND_REFUSED_ON_SYNC}:{machine.id}:{tx.id}",
                occurred_at=now,
                amount=getattr(tx, "total_amount", None),
                details={
                    "documentId": str(tx.id),
                    "transactionNumber": getattr(tx, "transaction_number", None),
                    "issuerMachineId": info["issuerMachineId"],
                    "issuerName": _label(issuer) if issuer is not None else None,
                    "pushedByMachineId": str(machine.id),
                    "why": info["why"],
                    "shiftId": info.get("shiftId"),
                    "summary": (
                        f"מסמך {getattr(tx, 'transaction_number', '') or tx.id} של "
                        f"{_label(issuer) if issuer is not None else 'קופה אחרת'} נשלח מ{_label(machine)} "
                        "בסנכרון הרגיל — נדחה ונשאר במכשיר (יועלה לקופה שלו)"
                    ),
                },
            )
        savepoint.commit()
    except Exception:  # noqa: BLE001 - the alert never fails the push
        try:
            savepoint.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.exception("could not record the foreign documents of machine %s", machine.id)


def refuse_foreign_stamp(db: Session, machine: POSMachine, stamp: Any) -> None:
    """`409 document_foreign_machine` for a transmission / cash movement stamped with another machine."""
    if stamp is None:
        return
    if str(stamp) not in own_machine_ids(db, machine):
        logger.warning("machine %s pushed a record of machine %s on the ordinary sync: refused", machine.id, stamp)
        raise HTTPException(status_code=409, detail=DOCUMENT_FOREIGN_MACHINE)


# ── §4: the upload ───────────────────────────────────────────────────────────


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _result(kind: str, rid: Any, status: str, code: Optional[str] = None, message: Optional[str] = None) -> Dict[str, Any]:
    return {"kind": kind, "id": None if rid is None else str(rid), "status": status, "code": code, "message": message}


def resolve_target(db: Session, pusher: POSMachine, machine_id: Any, tenant_id: Any) -> POSMachine:
    """A, or `ForeignUploadRefused`."""
    target_id = _uuid(machine_id)
    target = db.get(POSMachine, target_id) if target_id is not None else None
    if target is None:
        raise ForeignUploadRefused(FOREIGN_MACHINE_UNKNOWN, "הקופה שהרשומות שייכות לה לא קיימת בענן")
    if str(target.id) == str(pusher.id):
        raise ForeignUploadRefused(FOREIGN_MACHINE_IS_SELF, "הרשומות שייכות לקופה הזו — נשלחות בסנכרון הרגיל")
    if target.tenant_id is None or str(target.tenant_id) != str(pusher.tenant_id) or (
        tenant_id is not None and str(tenant_id) != str(target.tenant_id)
    ):
        raise ForeignUploadRefused(FOREIGN_MACHINE_OTHER_TENANT, "הקופה שהרשומות שייכות לה שייכת לארגון אחר")
    return target


def _http_code(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, dict):
        detail = detail.get("code") or detail.get("detail")
    text = str(detail or "")
    if text.startswith(SHIFT_BELONGS_TO_ANOTHER_MACHINE):
        return SHIFT_BELONGS_TO_ANOTHER_MACHINE
    return text.split(":", 1)[0] or INVALID_RECORD


def _invalid(kind: str, rid: Any, exc: Exception) -> Dict[str, Any]:
    message = str(exc)
    if isinstance(exc, ValidationError):
        from app.services.transactions import validation_reason

        message = validation_reason(exc)
    return _result(kind, rid, "refused", INVALID_RECORD, message[:300])


def _transaction(db: Session, target: POSMachine, pusher: POSMachine, rid: Any, body: Any, accepted_docs: List) -> Dict[str, Any]:
    from app.services.document_filing import numbering_holder
    from app.services.document_prefix import document_series_of
    from app.services.shifts import ShiftConflict
    from app.services.transactions import upsert_transactions, validate_documents

    valid, refused, unidentified = validate_documents([body])
    if unidentified or refused or not valid:
        reason = (refused[0][1].reason if refused else (unidentified[0].reason if unidentified else None)) or "invalid"
        return _result("transaction", rid, "refused", INVALID_RECORD, str(reason)[:300])
    tx = valid[0][1]
    if rid is not None and str(rid) != str(tx.id):
        return _result("transaction", rid, "refused", INVALID_RECORD, "id does not match body.id")
    if tx.machine_id is not None and str(tx.machine_id) != str(target.id):
        return _result("transaction", tx.id, "refused", DOCUMENT_FOREIGN_MACHINE, "body.machineId is not machineId")
    existing = db.get(Transaction, tx.id)
    if existing is None:
        holder = numbering_holder(
            db, target.id, document_series_of(tx.document_type, tx.refund_of_transaction_id), tx.transaction_number, tx.id,
        )
        if holder is not None and not (
            tx.document_prefix and holder.document_prefix and str(tx.document_prefix) != str(holder.document_prefix)
        ):
            return _result(
                "transaction", tx.id, "refused", FOREIGN_NUMBER_CONFLICT,
                f"{_label(target)} already holds number {tx.transaction_number} under document {holder.id}",
            )
    try:
        upserted = upsert_transactions(db, target, [tx], pushed_by=pusher)
    except ShiftConflict as conflict:
        db.rollback()
        return _result("transaction", tx.id, "retry", "shift_conflict", str(conflict)[:300])
    r = upserted[0]
    if r.status == "rejected":
        db.rollback()
        return _result("transaction", tx.id, "retry", "store_failed", (r.reason or "")[:300])
    if r.status == "accepted":
        accepted_docs.append(tx.id)
    return _result("transaction", tx.id, r.status)


def _shift_open(db: Session, target: POSMachine, rid: Any, body: Any) -> Dict[str, Any]:
    from app.schemas.shift import ShiftOpenIn
    from app.services.shifts import report_shift_open

    data = ShiftOpenIn.model_validate(body)
    if rid is not None and str(rid) != str(data.id):
        return _result("shift_open", rid, "refused", INVALID_RECORD, "id does not match body.id")
    existed = db.query(Shift.id).filter(Shift.id == data.id).first() is not None
    try:
        report_shift_open(db, target, data)
    except HTTPException as exc:
        db.rollback()
        code = _http_code(exc)
        if code == SHIFT_BELONGS_TO_ANOTHER_MACHINE:
            return _result("shift_open", data.id, "refused", code, str(exc.detail))
        # Another shift of A is open: this one is taken once that one is closed.
        return _result("shift_open", data.id, "retry", code, str(exc.detail)[:300])
    return _result("shift_open", data.id, "duplicate" if existed else "accepted")


def _shift_close(db: Session, target: POSMachine, rid: Any, body: Any) -> Dict[str, Any]:
    from app.schemas.shift import ShiftCloseIn
    from app.services.remote_close import on_shift_close_accepted
    from app.services.shifts import (
        ShiftUnknown,
        apply_shift_close,
        check_close_preconditions,
        is_foreign_shift,
    )

    data = ShiftCloseIn.model_validate(body)
    shift_id = _uuid(rid) or _uuid((body or {}).get("shiftId") if isinstance(body, dict) else None)
    if shift_id is None:
        return _result("shift_close", rid, "refused", INVALID_RECORD, "no shift id")
    if is_foreign_shift(db, target, shift_id):
        return _result("shift_close", shift_id, "refused", SHIFT_BELONGS_TO_ANOTHER_MACHINE, None)
    missing, stale = check_close_preconditions(db, target, shift_id, data.transaction_ids)
    if missing or stale:
        return _result(
            "shift_close", shift_id, "retry", "missing_transactions",
            f"missing {len(missing)}, stale {len(stale)}",
        )
    try:
        shift, outcome = apply_shift_close(db, target, shift_id, data)
    except ShiftUnknown:
        db.rollback()
        return _result("shift_close", shift_id, "retry", "shift_unknown", None)
    on_shift_close_accepted(db, target, shift)
    return _result("shift_close", shift_id, outcome)


def _transmission(db: Session, target: POSMachine, rid: Any, body: Any) -> Dict[str, Any]:
    from app.schemas.transmission import TransmissionReportIn
    from app.services import transmissions, transmit_requests

    data = TransmissionReportIn.model_validate(body)
    if rid is not None and str(rid) != str(data.id):
        return _result("transmission", rid, "refused", INVALID_RECORD, "id does not match body.id")
    if data.machine_id is not None and str(data.machine_id) != str(target.id):
        return _result("transmission", data.id, "refused", DOCUMENT_FOREIGN_MACHINE, "body.machineId is not machineId")
    outcome = transmissions.record_report(db, target, data)
    transmit_requests.on_report(db, target, outcome.transmission)
    return _result("transmission", data.id, "accepted" if outcome.created else "duplicate")


def _offline_authorization(db: Session, target: POSMachine, rid: Any, body: Any) -> Dict[str, Any]:
    from app.schemas.offline_authorization import OfflineAuthorizationIn
    from app.services import offline_authorizations

    data = OfflineAuthorizationIn.model_validate(body)
    if rid is not None and str(rid) != str(data.id):
        return _result("offline_authorization", rid, "refused", INVALID_RECORD, "id does not match body.id")
    outcome = offline_authorizations.record_report(db, target, data)
    return _result("offline_authorization", data.id, "accepted" if outcome.created else "duplicate")


def _cash_movement(db: Session, target: POSMachine, rid: Any, body: Any, created: List) -> Dict[str, Any]:
    from app.models.cash_drawer import CashMovement
    from app.schemas.cash_drawer import CashMovementIn
    from app.services import cash_drawer

    data = CashMovementIn.model_validate(body)
    if rid is not None and str(rid) != str(data.id):
        return _result("cash_movement", rid, "refused", INVALID_RECORD, "id does not match body.id")
    if data.machine_id is not None and str(data.machine_id) != str(target.id):
        return _result("cash_movement", data.id, "refused", DOCUMENT_FOREIGN_MACHINE, "body.machineId is not machineId")
    if target.shop_id is None:
        return _result("cash_movement", data.id, "retry", "machine_not_assigned", None)
    existing = db.get(CashMovement, data.id)
    if existing is not None and existing.machine_id != target.id:
        return _result("cash_movement", data.id, "refused", INVALID_RECORD, "movement_id_conflict")
    movement, was_created = cash_drawer.record_movement(db, target, data)
    if was_created:
        created.append(movement)
    return _result("cash_movement", data.id, "accepted" if was_created else "duplicate")


def upload(db: Session, pusher: POSMachine, target: POSMachine, records: Sequence[Any]) -> List[Dict[str, Any]]:
    """
    File each record under `target` (A), in the order sent; committed record by record (one that
    fails never takes the ones before it). Returns the per-record results, alerts recorded.
    """
    results: List[Dict[str, Any]] = []
    accepted_docs: List[uuid.UUID] = []
    movements: List[Any] = []
    for record in records:
        kind = getattr(record, "kind", None)
        rid = getattr(record, "id", None)
        body = getattr(record, "body", None)
        try:
            if kind == "transaction":
                out = _transaction(db, target, pusher, rid, body, accepted_docs)
            elif kind == "shift_open":
                out = _shift_open(db, target, rid, body)
            elif kind == "shift_close":
                out = _shift_close(db, target, rid, body)
            elif kind == "transmission":
                out = _transmission(db, target, rid, body)
            elif kind == "cash_movement":
                out = _cash_movement(db, target, rid, body, movements)
            elif kind == "offline_authorization":
                out = _offline_authorization(db, target, rid, body)
            else:
                out = _result(str(kind), rid, "refused", UNSUPPORTED_KIND, None)
            if out["status"] in ("accepted", "duplicate"):
                db.commit()
            else:
                db.rollback()
        except ValidationError as exc:
            db.rollback()
            out = _invalid(str(kind), rid, exc)
        except HTTPException as exc:
            db.rollback()
            code = _http_code(exc)
            out = _result(
                str(kind), rid, "refused",
                SHIFT_BELONGS_TO_ANOTHER_MACHINE if code == SHIFT_BELONGS_TO_ANOTHER_MACHINE else INVALID_RECORD,
                str(exc.detail)[:300],
            )
        except Exception as exc:  # noqa: BLE001 - one record never fails the call
            db.rollback()
            logger.exception("foreign record %s %s of machine %s from %s failed", kind, rid, target.id, pusher.id)
            out = _result(str(kind), rid, "retry", "store_failed", str(exc)[:300])
        results.append(out)
    _after(db, pusher, target, results, accepted_docs, movements)
    return results


def _after(db: Session, pusher: POSMachine, target: POSMachine, results: List[Dict[str, Any]],
           accepted_docs: List[uuid.UUID], movements: List[Any]) -> None:
    """What A's own sync does after a commit (exceptions, realtime), and this call's alerts. Never raises."""
    from app.services import cash_drawer
    from app.services import exceptions as exc_svc

    if accepted_docs:
        try:
            from app.services.transactions import publish_transactions_synced

            publish_transactions_synced(target.tenant_id, target.id, len(accepted_docs))
            exc_svc.detect_safely(db, exc_svc.detect_transactions, list(accepted_docs))
        except Exception:  # noqa: BLE001
            logger.exception("after-upload detection failed for machine %s", target.id)
    for movement in movements:
        exc_svc.detect_safely(db, lambda d, m: cash_drawer.detect_movement(d, target, m), movement)
    record_alerts(db, pusher, target, results)


def record_alerts(db: Session, pusher: POSMachine, target: POSMachine, results: Sequence[Dict[str, Any]]) -> None:
    """`foreign_records_uploaded` (per call with any accepted record) and `foreign_records_refused` (per refused one)."""
    from app.services.exceptions import record_z_exception

    accepted = Counter(r["kind"] for r in results if r["status"] == "accepted")
    refused = [r for r in results if r["status"] == "refused"]
    if not accepted and not refused:
        return
    now = datetime.now(timezone.utc)
    try:
        if accepted:
            counts = " · ".join(f"{KIND_LABELS.get(k, k)} {n}" for k, n in accepted.items())
            record_z_exception(
                db, target,
                exception_type=KIND_UPLOADED,
                key=f"{KIND_UPLOADED}:{target.id}:{uuid.uuid4()}",
                occurred_at=now,
                details={
                    "machineId": str(target.id),
                    "pushedByMachineId": str(pusher.id),
                    "pushedByName": _label(pusher),
                    "counts": dict(accepted),
                    "summary": f"מסמכים של {_label(target)} הועלו ממכשיר {_label(pusher)}: {counts}",
                },
            )
        for r in refused:
            record_z_exception(
                db, target,
                exception_type=KIND_REFUSED,
                key=f"{KIND_REFUSED}:{target.id}:{r['kind']}:{r['id']}",
                occurred_at=now,
                details={
                    **r,
                    "machineId": str(target.id),
                    "pushedByMachineId": str(pusher.id),
                    "summary": (
                        f"רשומה של {_label(target)} ({KIND_LABELS.get(r['kind'], r['kind'])}) שהועלתה ממכשיר "
                        f"{_label(pusher)} נדחתה: {r.get('code')} — נשמרת במכשיר ובגיבוי"
                    ),
                },
            )
        db.commit()
    except Exception:  # noqa: BLE001 - the alerts never fail the upload
        db.rollback()
        logger.exception("could not record the upload alerts of machine %s", target.id)


def record_request_refused(db: Session, pusher: POSMachine, refused: ForeignUploadRefused, machine_id: Any, count: int) -> None:
    """A whole request refused: one `foreign_records_refused` on the pushing machine. Never raises."""
    from app.services.exceptions import record_z_exception

    try:
        record_z_exception(
            db, pusher,
            exception_type=KIND_REFUSED,
            key=f"{KIND_REFUSED}:{pusher.id}:request:{machine_id}:{refused.code}",
            occurred_at=datetime.now(timezone.utc),
            details={
                "code": refused.code,
                "machineId": None if machine_id is None else str(machine_id),
                "pushedByMachineId": str(pusher.id),
                "records": count,
                "summary": f"העלאת {count} רשומות של קופה אחרת מ{_label(pusher)} נדחתה: {refused.message}",
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("could not record the refused upload of machine %s", pusher.id)


def target_out(db: Session, target: POSMachine) -> Dict[str, Any]:
    from app.models.shop import Shop

    shop = db.get(Shop, target.shop_id) if target.shop_id is not None else None
    return {
        "machineId": str(target.id),
        "machineName": target.name,
        "posNumber": target.pos_number,
        "shopName": getattr(shop, "name", None),
    }
