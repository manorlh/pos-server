"""
"מצב הדרכה" — a shop's training mode (docs/SPEC_TRAINING_MODE.md, phase 1: the cloud).

**The flag** is the shop's (`shops.training_mode`, with who / when it started and ended).
It reaches the till as `trainingMode` in `GET /machines/me` and in the settings sync
(`GET /sync/{m}/settings`: a top-level `trainingMode` and the `settings.trainingMode`
key). Turning it on or off moves the shop's settings watermark and wakes its tills.

**The quarantine.** A document a till sends is a *training* document when:

* it is flagged `training: true` (what a till in training mode sends, phase 2), or
* its shop is in training mode and it carries a training-series number ("ה-12"), or
* (a shift's close) its shift was opened as a training shift.

A training document is stored in `training_documents`, as it was sent, and in no real
table: never a sale, a shift, a Z. So no report, accounting export, Z, event report or
transmission ever sees it. The till is answered exactly as for a real document
(`accepted` / `duplicate`), so its outbox clears. A training document that arrives once
the shop has left training mode (a till that had not synced the switch) is **dropped**:
answered as accepted, stored nowhere, and logged (`training_audit_log`, `dropped`).

Everything else — a document without the flag and without the "ה-" number — is a real
document and takes the real path unchanged, even while the shop is in training mode: a
till that has not picked up the flag yet still sells for real (the spec's edge case).

**Turning it on** is refused while a real shift is open on any till of the shop: a till
switches only at a shift boundary. **Turning it off** (the dashboard's wizard) deletes
the quarantine and the shop's open table orders (and the orders paid with training
documents), optionally removes the demo menu (app/services/demo_menu.py), and logs who,
when and what was deleted.

Who: the super admin, a distributor, or the customer's company manager over the shop's
company ("הרשאת ניהול סניף", as for opening a shop). Reading the card (its status, the
preview, the training report) is open to the shop's managers too (`printers.can_edit`).
"""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.tables import DiningTable, TableEvent, TableOrder
from app.models.training import (
    AUDIT_DISABLED,
    AUDIT_DROPPED,
    AUDIT_ENABLED,
    TRAINING_KINDS,
    TrainingAuditLog,
    TrainingDocument,
)
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

#: The training series ("ה-1", "ה-2"…). The Hebrew maqaf is accepted too.
TRAINING_NUMBER_PREFIXES = ("ה-", "ה־")

#: What `route` decides for one incoming document.
REAL = "real"
QUARANTINE = "quarantine"
DROP = "drop"

#: The 409 / 422 codes (`detail.code`).
REAL_SHIFT_OPEN = "real_shift_open"
NOT_IN_TRAINING = "not_in_training"
NAME_MISMATCH = "name_mismatch"
BLOCKERS = "blockers"

#: Why a till holds the shop back from leaving training mode (`blockers[].code`).
UNSYNCED_TILL = "unsynced_till"
OPEN_TABLES = "open_tables"

#: The settings notify reason when the flag moves.
NOTIFY_REASON = "training_mode"

_MANAGE_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


# ── Permissions ───────────────────────────────────────────────────────────────


def can_manage(db: Session, user: User, shop: Shop) -> bool:
    """Turn it on or off, load or remove a demo menu: as for opening a shop."""
    from app.services.company_hierarchy import user_covers_company

    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if user.role == UserRole.COMPANY_MANAGER:
        return bool(user_covers_company(db, user, shop.company_id))
    return False


def check_manage(db: Session, user: User, shop: Shop) -> None:
    if not can_manage(db, user, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def check_read(db: Session, user: User, shop: Shop) -> None:
    """The card, the preview and the training report: the shop's managers too."""
    from app.services.printers import can_edit

    if not (can_manage(db, user, shop) or can_edit(db, user, shop)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


# ── Which documents are training documents ────────────────────────────────────


def is_on(shop: Optional[Shop]) -> bool:
    return bool(shop is not None and getattr(shop, "training_mode", False))


def is_flagged(value: Any) -> bool:
    """`training: true` (a JSON true; a "true" string is read the same)."""
    return value is True or (isinstance(value, str) and value.strip().lower() == "true")


def has_training_number(number: Any) -> bool:
    return isinstance(number, str) and number.strip().startswith(TRAINING_NUMBER_PREFIXES)


def route(shop: Optional[Shop], *, flagged: bool, number: Any = None, known_training: bool = False) -> str:
    """
    REAL, QUARANTINE or DROP for one incoming document (see the module docstring).

    `known_training`: the document belongs to something already quarantined (a training
    shift's close).
    """
    if flagged or known_training:
        return QUARANTINE if is_on(shop) else DROP
    if is_on(shop) and has_training_number(number):
        return QUARANTINE
    return REAL


def shop_of(db: Session, machine: POSMachine) -> Optional[Shop]:
    """The till's shop; None without one (or for a stand-in session / till, as in tests)."""
    shop_id = _uuid(getattr(machine, "shop_id", None))
    getter = getattr(db, "get", None)
    if shop_id is None or not callable(getter):
        return None
    shop = getter(Shop, shop_id)
    return shop if isinstance(shop, Shop) else None


# ── The quarantine ────────────────────────────────────────────────────────────


def _json_safe(payload: Any) -> Dict[str, Any]:
    """The document as JSON (JSONB refuses NaN; anything odd becomes its text)."""
    try:
        text = json.dumps(payload, default=str, allow_nan=False)
    except (TypeError, ValueError):
        text = json.dumps({"raw": str(payload)})
    value = json.loads(text)
    return value if isinstance(value, dict) else {"value": value}


def find(db: Session, machine: POSMachine, kind: str, local_id: Any) -> Optional[TrainingDocument]:
    return (
        db.query(TrainingDocument)
        .filter(
            TrainingDocument.machine_id == machine.id,
            TrainingDocument.kind == kind,
            TrainingDocument.local_id == str(local_id),
        )
        .first()
    )


def store(
    db: Session,
    machine: POSMachine,
    shop: Shop,
    kind: str,
    local_id: Any,
    payload: Any,
    number: Any = None,
) -> Tuple[TrainingDocument, bool]:
    """Quarantine one document. Idempotent: `(row, False)` when this id is already here."""
    if kind not in TRAINING_KINDS:
        kind = "other"
    key = str(local_id)[:100]
    existing = find(db, machine, kind, key)
    if existing is not None:
        return existing, False
    row = TrainingDocument(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        shop_id=shop.id,
        machine_id=machine.id,
        kind=kind,
        local_id=key,
        number=str(number)[:100] if number not in (None, "") else None,
        payload=_json_safe(payload),
        received_at=_now(),
    )
    try:
        with db.begin_nested():
            db.add(row)
    except IntegrityError:
        # The same document racing in on another request: that one stored it.
        existing = find(db, machine, kind, key)
        if existing is None:
            raise
        return existing, False
    return row, True


def log_dropped(db: Session, machine: POSMachine, shop: Optional[Shop], kind: str, ids: Sequence[Any]) -> None:
    """Training documents that came after the shop left training mode: logged, kept nowhere."""
    if not ids:
        return
    logger.warning(
        "Dropping %d training %s document(s) from machine %s (shop %s is not in training mode): %s",
        len(ids), kind, machine.id, getattr(shop, "id", None), ", ".join(str(i) for i in list(ids)[:10]),
    )
    if shop is None:
        return
    db.add(TrainingAuditLog(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        action=AUDIT_DROPPED,
        machine_id=machine.id,
        details={"kind": kind, "count": len(ids), "ids": [str(i) for i in list(ids)[:50]]},
        created_at=_now(),
    ))


# ── The till's ingestion points ───────────────────────────────────────────────


def _answer_id(raw_id: str):
    try:
        return uuid.UUID(raw_id)
    except (TypeError, ValueError):
        return raw_id


def divert_transactions(
    db: Session, machine: POSMachine, raw_documents: Sequence[Any]
) -> Tuple[List[int], List[Any], List[Tuple[int, Any]]]:
    """
    Split a `POST /sync/{m}/transactions` batch.

    Returns the batch positions and documents of the real ones (to go down the real path
    untouched) and the answers, by batch position, of the training ones — quarantined or
    dropped, each answered `accepted` (`duplicate` for one already quarantined). A
    document with no string id stays on the real path, which answers it as always.
    """
    from app.schemas.transaction import TransactionUpsertResult

    shop = shop_of(db, machine)
    positions: List[int] = []
    kept: List[Any] = []
    answered: List[Tuple[int, Any]] = []
    dropped: List[str] = []
    now = _now()
    for index, raw in enumerate(raw_documents):
        doc_id = raw.get("id") if isinstance(raw, dict) else None
        if not isinstance(doc_id, str) or not doc_id.strip():
            positions.append(index)
            kept.append(raw)
            continue
        number = raw.get("transactionNumber")
        decision = route(shop, flagged=is_flagged(raw.get("training")), number=number)
        if decision == REAL:
            positions.append(index)
            kept.append(raw)
            continue
        outcome = "accepted"
        if decision == QUARANTINE:
            _row, created = store(db, machine, shop, "transaction", doc_id, raw, number=number)
            outcome = "accepted" if created else "duplicate"
        else:
            dropped.append(doc_id)
        answered.append((index, TransactionUpsertResult(
            id=_answer_id(doc_id), status=outcome, server_received_at=now,
        )))
    log_dropped(db, machine, shop, "transaction", dropped)
    return positions, kept, answered


def divert_shift_open(db: Session, machine: POSMachine, data) -> Optional[Any]:
    """`POST /sync/{m}/shifts`: None for a real shift, else the answer a real open gets."""
    from app.schemas.shift import ShiftOut

    shop = shop_of(db, machine)
    decision = route(shop, flagged=getattr(data, "training", False) is True)
    if decision == REAL:
        return None
    if decision == QUARANTINE:
        row, created = store(
            db, machine, shop, "shift", data.id, {"open": data.model_dump(mode="json", by_alias=True)}
        )
        if not created and "open" not in (row.payload or {}):
            row.payload = {**(row.payload or {}), "open": data.model_dump(mode="json", by_alias=True)}
            row.updated_at = _now()
    else:
        log_dropped(db, machine, shop, "shift", [data.id])
    return ShiftOut(
        id=data.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        business_date=data.business_date,
        sequence_number=data.sequence_number,
        status="open",
        opened_at=data.opened_at,
        opening_cash=data.opening_cash,
        opened_by_user_id=data.opened_by_user_id,
        opened_by_name=data.opened_by_name,
    )


def divert_shift_close(db: Session, machine: POSMachine, shift_id: uuid.UUID, body) -> Optional[Any]:
    """
    `POST /sync/{m}/shifts/{id}/close`: None for a real close, else the answer a real
    close gets (`accepted`, `duplicate` for a second close; no totals, no Z). Decided
    before the missing-documents check: a training shift's documents are not in the real
    table, and a 409 for them would never end.
    """
    from app.schemas.shift import ShiftCloseResponse

    shop = shop_of(db, machine)
    flagged = getattr(body, "training", False) is True
    if not flagged and not is_on(shop):
        return None  # the real path, untouched (nothing quarantined outside training mode)
    known = find(db, machine, "shift", str(shift_id)) if is_on(shop) else None
    decision = route(
        shop,
        flagged=flagged,
        number=getattr(body, "last_transaction_number", None),
        known_training=known is not None,
    )
    if decision == REAL:
        return None
    outcome = "accepted"
    close = body.model_dump(mode="json", by_alias=True)
    if decision == QUARANTINE:
        if known is None:
            store(db, machine, shop, "shift", shift_id, {"close": close})
        elif "close" in (known.payload or {}):
            outcome = "duplicate"
        else:
            known.payload = {**(known.payload or {}), "close": close}
            known.updated_at = _now()
    else:
        log_dropped(db, machine, shop, "shift", [shift_id])
    return ShiftCloseResponse(
        status=outcome,
        shift_id=shift_id,
        server_totals=None,
        totals_mismatch=False,
        z_report_id=None,
        z_number=None,
        server_time=_now(),
    )


def divert_till_z(db: Session, machine: POSMachine, body) -> Optional[Tuple[int, Dict[str, Any]]]:
    """
    `POST /sync/{m}/till-z` flagged `training`: None for a real request, else
    `(status code, body)` — 201 `created` (200 `duplicate` for a request id already
    quarantined), with `training: true` and no cloud Z (`zReport` null): a training Z is
    the till's own, numbered in its own training run, never the cloud's.
    """
    shop = shop_of(db, machine)
    decision = route(shop, flagged=getattr(body, "training", False) is True)
    if decision == REAL:
        return None
    created = True
    if decision == QUARANTINE:
        _row, created = store(
            db, machine, shop, "z", body.client_request_id, body.model_dump(mode="json", by_alias=True),
            number=getattr(body, "number", None),
        )
    else:
        log_dropped(db, machine, shop, "z", [body.client_request_id])
    return (
        status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        {
            "status": "created" if created else "duplicate",
            "training": True,
            "zReport": None,
            "shiftIds": [],
            "totalsMismatch": False,
            "serverTime": _now().isoformat(),
        },
    )


def divert_till_event(db: Session, machine: POSMachine, body) -> Optional[bool]:
    """`POST /sync/{m}/events` flagged `training`: None for a real event, else whether it is new."""
    shop = shop_of(db, machine)
    decision = route(shop, flagged=getattr(body, "training", False) is True)
    if decision == REAL:
        return None
    if decision == DROP:
        log_dropped(db, machine, shop, "other", [body.id])
        return True
    _row, created = store(db, machine, shop, "other", body.id, body.model_dump(mode="json", by_alias=True))
    return created


def receive_documents(db: Session, machine: POSMachine, documents: Iterable[Any]) -> List[Dict[str, Any]]:
    """
    `POST /sync/{m}/training-documents`: the till's own training Z / X (and anything else
    of training with no real endpoint). Everything sent here is training by definition:
    quarantined, or dropped once the shop has left training mode.
    """
    shop = shop_of(db, machine)
    results: List[Dict[str, Any]] = []
    dropped: Dict[str, List[str]] = defaultdict(list)
    for doc in documents:
        decision = route(shop, flagged=True)
        if decision == DROP:
            dropped[doc.kind].append(doc.id)
            results.append({"id": doc.id, "kind": doc.kind, "status": "dropped"})
            continue
        payload = doc.payload if isinstance(doc.payload, dict) else {"value": doc.payload}
        _row, created = store(db, machine, shop, doc.kind, doc.id, payload, number=doc.number)
        results.append({"id": doc.id, "kind": doc.kind, "status": "accepted" if created else "duplicate"})
    for kind, ids in dropped.items():
        log_dropped(db, machine, shop, kind, ids)
    return results


# ── The dashboard's card ──────────────────────────────────────────────────────


def _user_ref(db: Session, user_id: Any) -> Optional[Dict[str, Any]]:
    ident = _uuid(user_id)
    if ident is None:
        return None
    user = db.get(User, ident)
    if user is None:
        return {"id": str(ident), "name": None}
    return {"id": str(user.id), "name": user.username or user.email}


def counts_by_kind(db: Session, shop_id: Any) -> Dict[str, int]:
    rows = (
        db.query(TrainingDocument.kind, func.count(TrainingDocument.id))
        .filter(TrainingDocument.shop_id == shop_id)
        .group_by(TrainingDocument.kind)
        .all()
    )
    out = {kind: 0 for kind in TRAINING_KINDS}
    for kind, count in rows:
        out[kind if kind in out else "other"] += int(count)
    return out


def _log_out(db: Session, rows: List[TrainingAuditLog]) -> List[Dict[str, Any]]:
    machine_ids = {r.machine_id for r in rows if r.machine_id is not None}
    names = {
        m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all()
    } if machine_ids else {}
    out = []
    for r in rows:
        who = _user_ref(db, r.user_id)
        out.append({
            "id": str(r.id),
            "action": r.action,
            "at": _iso(r.created_at),
            "userName": who["name"] if who else None,
            "machineName": names.get(r.machine_id),
            "details": r.details,
        })
    return out


def status_out(db: Session, shop: Shop, user: User) -> Dict[str, Any]:
    log = (
        db.query(TrainingAuditLog)
        .filter(TrainingAuditLog.shop_id == shop.id)
        .order_by(TrainingAuditLog.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "trainingMode": is_on(shop),
        "startedAt": _iso(shop.training_started_at),
        "startedBy": _user_ref(db, shop.training_started_by),
        "endedAt": _iso(shop.training_ended_at),
        "endedBy": _user_ref(db, shop.training_ended_by),
        "canManage": can_manage(db, user, shop),
        "counts": counts_by_kind(db, shop.id),
        "log": _log_out(db, log),
    }


def _shop_tills(db: Session, shop: Shop) -> List[POSMachine]:
    from app.services.main_till import till_order

    tills = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .all()
    )
    return sorted(tills, key=till_order)


def real_open_shift_tills(db: Session, shop: Shop) -> List[POSMachine]:
    """
    The shop's tills with a real shift open: one the cloud holds open, or one the till
    reports open (heartbeat) that the cloud has not closed and that is not a quarantined
    training shift.
    """
    from app.services.shifts import open_shifts_for_machines
    from app.services.z_runs import _reported_open_is_live

    tills = _shop_tills(db, shop)
    open_in_cloud = open_shifts_for_machines(db, [m.id for m in tills])
    out = []
    for machine in tills:
        if machine.id in open_in_cloud:
            out.append(machine)
            continue
        claimed = getattr(machine, "reported_open_shift_id", None)
        if claimed is None or find(db, machine, "shift", str(claimed)) is not None:
            continue
        if _reported_open_is_live(db, machine):
            out.append(machine)
    return out


def _till_ref(machine: POSMachine) -> Dict[str, Any]:
    return {"machineId": str(machine.id), "name": machine.name, "posNumber": machine.pos_number}


def _audit(db: Session, shop: Shop, action: str, user: Optional[User], details: Optional[Dict[str, Any]]) -> None:
    db.add(TrainingAuditLog(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        action=action,
        user_id=getattr(user, "id", None),
        details=_json_safe(details) if details is not None else None,
        created_at=_now(),
    ))


def _flag_moved(shop: Shop, now: datetime) -> None:
    """The tills' settings watermark moves, so their next pull carries the flag."""
    shop.settings_updated_at = now


def start(db: Session, shop: Shop, user: Optional[User], *, check_shifts: bool = True) -> None:
    """Turn it on. 409 `real_shift_open` (with the tills) while a real shift is open."""
    if is_on(shop):
        return
    if check_shifts:
        busy = real_open_shift_tills(db, shop)
        if busy:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": REAL_SHIFT_OPEN, "tills": [_till_ref(m) for m in busy]},
            )
    now = _now()
    shop.training_mode = True
    shop.training_started_at = now
    shop.training_started_by = getattr(user, "id", None)
    shop.training_ended_at = None
    shop.training_ended_by = None
    _flag_moved(shop, now)
    _audit(db, shop, AUDIT_ENABLED, user, None)
    db.flush()


# ── Leaving training mode ─────────────────────────────────────────────────────


def _training_table_orders(db: Session, shop: Shop) -> Tuple[List[TableOrder], int]:
    """The shop's open table orders, and the orders paid with a training document."""
    open_orders = (
        db.query(TableOrder)
        .filter(TableOrder.shop_id == shop.id, TableOrder.status == "open")
        .all()
    )
    quarantined = {
        local_id for (local_id,) in db.query(TrainingDocument.local_id).filter(
            TrainingDocument.shop_id == shop.id, TrainingDocument.kind == "transaction"
        )
    }
    paid = [
        o for o in db.query(TableOrder).filter(TableOrder.shop_id == shop.id, TableOrder.status != "open").all()
        if (o.transaction_id and str(o.transaction_id) in quarantined)
        or has_training_number(o.transaction_number)
    ]
    return open_orders + paid, len(open_orders)


def blockers(db: Session, shop: Shop) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for machine in _shop_tills(db, shop):
        documents = machine.pending_documents
        pending = documents if documents is not None else machine.pending_count
        if pending:
            out.append({
                "code": UNSYNCED_TILL,
                **_till_ref(machine),
                "pendingDocuments": machine.pending_documents,
                "pendingCount": machine.pending_count,
                "asOf": _iso(machine.pending_count_at),
            })
    open_orders = (
        db.query(TableOrder)
        .filter(TableOrder.shop_id == shop.id, TableOrder.status == "open")
        .order_by(TableOrder.table_number)
        .all()
    )
    if open_orders:
        out.append({
            "code": OPEN_TABLES,
            "count": len(open_orders),
            "tables": [{"number": o.table_number, "name": o.table_name} for o in open_orders],
        })
    return out


def disable_preview(db: Session, shop: Shop) -> Dict[str, Any]:
    from app.services import demo_menu

    counts = counts_by_kind(db, shop.id)
    orders, open_count = _training_table_orders(db, shop)
    loads = demo_menu.loads_for_shop(db, shop)
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "trainingMode": is_on(shop),
        "counts": {
            "transactions": counts["transaction"],
            "shifts": counts["shift"],
            "zReports": counts["z"],
            "xReports": counts["x"],
            "other": counts["other"],
            "tableOrders": len(orders),
            "openTables": open_count,
        },
        "blockers": blockers(db, shop),
        "demoMenu": {"loaded": bool(loads), "loads": loads},
    }


def purge(db: Session, shop: Shop) -> Dict[str, int]:
    """Delete the shop's quarantine and its training table orders. Returns the counts."""
    counts = counts_by_kind(db, shop.id)
    orders, _open = _training_table_orders(db, shop)
    order_ids = [o.id for o in orders]
    table_ids = {o.table_id for o in orders}
    if order_ids:
        db.query(TableEvent).filter(TableEvent.order_id.in_(order_ids)).delete(synchronize_session=False)
        db.query(TableOrder).filter(TableOrder.id.in_(order_ids)).delete(synchronize_session=False)
    if table_ids:
        # Their locks and "לניקוי" were the training orders'.
        for table in db.query(DiningTable).filter(DiningTable.id.in_(table_ids)).all():
            table.lock_machine_id = None
            table.lock_pos_user_id = None
            table.lock_pos_user_name = None
            table.lock_acquired_at = None
            table.lock_expires_at = None
            table.cleaning_since = None
    db.query(TrainingDocument).filter(TrainingDocument.shop_id == shop.id).delete(synchronize_session=False)
    db.flush()
    return {
        "transactions": counts["transaction"],
        "shifts": counts["shift"],
        "zReports": counts["z"],
        "xReports": counts["x"],
        "other": counts["other"],
        "tableOrders": len(order_ids),
    }


def stop(
    db: Session,
    shop: Shop,
    user: User,
    *,
    confirm_name: str,
    remove_demo_menu: bool = False,
    force: bool = False,
) -> Dict[str, Any]:
    """
    The wizard's last step. 409 `not_in_training`; 422 `name_mismatch` unless the shop's
    name was typed; 409 `blockers` (with them) unless `force`. Deletes the quarantine and
    the training table orders, removes the demo menu when asked, turns the flag off and
    logs it all.
    """
    from app.services import demo_menu

    if not is_on(shop):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": NOT_IN_TRAINING})
    if (confirm_name or "").strip() != (shop.name or "").strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": NAME_MISMATCH})
    found = blockers(db, shop)
    if found and not force:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": BLOCKERS, "blockers": found})

    deleted = purge(db, shop)
    demo = demo_menu.remove_for_shop(db, shop, user) if remove_demo_menu else None
    now = _now()
    shop.training_mode = False
    shop.training_ended_at = now
    shop.training_ended_by = user.id
    _flag_moved(shop, now)
    _audit(db, shop, AUDIT_DISABLED, user, {
        "deleted": deleted,
        "demoMenu": demo,
        "forced": bool(found),
        "blockers": found,
    })
    db.flush()
    return {"deleted": deleted, "demoMenu": demo}


# ── The training report ───────────────────────────────────────────────────────


def _dec(value: Any) -> Decimal:
    try:
        return Decimal(str(value)) if value not in (None, "") else Decimal("0")
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _money(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01")))


def report(db: Session, shop: Shop) -> Dict[str, Any]:
    """A simple summary of the quarantined sales: by till, item and payment method."""
    rows = (
        db.query(TrainingDocument)
        .filter(TrainingDocument.shop_id == shop.id)
        .order_by(TrainingDocument.received_at)
        .all()
    )
    counts = defaultdict(int)
    sales_count = 0
    total = Decimal("0")
    refunds_count = 0
    refunds_total = Decimal("0")
    by_till: Dict[Any, Dict[str, Any]] = {}
    items: Dict[str, Dict[str, Decimal]] = defaultdict(lambda: {"quantity": Decimal("0"), "total": Decimal("0")})
    payments: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"count": 0, "amount": Decimal("0")})
    first_at = last_at = None
    for row in rows:
        counts[row.kind] += 1
        if row.kind != "transaction":
            continue
        doc = row.payload or {}
        if str(doc.get("status") or "completed") == "cancelled":
            continue
        first_at = first_at or row.received_at
        last_at = row.received_at
        amount = _dec(doc.get("totalAmount")) - _dec(doc.get("documentDiscount"))
        if str(doc.get("documentType")) == "330":
            refunds_count += 1
            refunds_total += abs(amount)
            continue
        sales_count += 1
        total += amount
        till = by_till.setdefault(row.machine_id, {"count": 0, "total": Decimal("0")})
        till["count"] += 1
        till["total"] += amount
        for line in doc.get("items") or []:
            if not isinstance(line, dict):
                continue
            name = str(line.get("productName") or line.get("sku") or "—")
            items[name]["quantity"] += _dec(line.get("quantity") or 1)
            items[name]["total"] += _dec(line.get("totalPrice"))
        legs = [leg for leg in (doc.get("payments") or []) if isinstance(leg, dict)]
        if not legs:
            legs = [{"method": doc.get("paymentMethod") or "other", "amount": amount}]
        for leg in legs:
            method = str(leg.get("method") or "other").strip().lower()
            payments[method]["count"] += 1
            payments[method]["amount"] += _dec(leg.get("amount"))

    machines = {
        m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(by_till))).all()
    } if by_till else {}
    by_till_out = sorted(
        (
            {
                "machineId": str(mid),
                "name": machines[mid].name if mid in machines else None,
                "posNumber": machines[mid].pos_number if mid in machines else None,
                "count": v["count"],
                "total": _money(v["total"]),
            }
            for mid, v in by_till.items()
        ),
        key=lambda r: -r["total"],
    )
    top_items = sorted(
        (
            {"name": name, "quantity": float(v["quantity"]), "total": _money(v["total"])}
            for name, v in items.items()
        ),
        key=lambda r: (-r["total"], -r["quantity"]),
    )[:10]
    by_payment = sorted(
        (
            {"method": method, "count": v["count"], "amount": _money(v["amount"])}
            for method, v in payments.items()
        ),
        key=lambda r: -r["amount"],
    )
    return {
        "shopId": str(shop.id),
        "trainingMode": is_on(shop),
        "count": sales_count,
        "total": _money(total),
        "refunds": {"count": refunds_count, "total": _money(refunds_total)},
        "firstAt": _iso(first_at),
        "lastAt": _iso(last_at),
        "shifts": counts["shift"],
        "zReports": counts["z"],
        "byTill": by_till_out,
        "topItems": top_items,
        "byPayment": by_payment,
    }
