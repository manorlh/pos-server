"""
The floor's notices (P:/specs/table-waiter-assignment.md §5, §8): a short message about a table for one
device or one waiter, stored (`table_notices`), woken through Ably and pulled by the till.

* **"בקש מדנה לצאת"** (§8, `tableBusyEntry` = request, the cloud's tables): a till refused at a busy table
  asks the device inside it (`create_entry_request`). The holder sees it at once (Ably `table-notice` on
  its channel) and on its next table heartbeat (`entryRequests`); it answers "שמור וצא" (`leaving`) or
  "התעלם" (`ignored`) — the asking till is woken with the answer. When the holder leaves, the lock is
  released and the tables signal wakes everyone as always. Unanswered, it is gone after `ENTRY_TTL`.
* **"מוכן להגשה"** (§5): the KDS made a table's order ready (`on_kds_ready`, from app/services/kds.py).
* **"שולחן מתעכב"** (§5): an open table of the cloud's with no action for `tableOverdueMinutes`
  (`overdue_pass`, app/services/table_notices_worker.py), once per quiet spell.

The last two go to the table's **assigned** waiters (app/services/table_assignments.py), only with
`tableAssignmentNotify` on (and the assignment mode on) for the shop. Their device: where they are signed
in — the cloud knows it with "עובד מחובר בקופה אחת בלבד" (their live session), or from a table they hold
now; else every till of the shop is woken and each shows it only while that waiter is signed in at it
(`toPosUserId`).

Till: `GET /sync/{m}/tables/notices?posUserId=` (pending for this device or that waiter), `GET
/sync/{m}/tables/notices/{id}` (a request it sent, with its answer), `POST /sync/{m}/tables/notices/{id}/answer`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.table_assignment import TableNotice
from app.models.tables import DiningTable, TableOrder

logger = logging.getLogger(__name__)

ENTRY_REQUEST, KDS_READY, OVERDUE = "entry_request", "kds_ready", "overdue"
LEAVING, IGNORED, SEEN = "leaving", "ignored", "seen"
ANSWERS = (LEAVING, IGNORED, SEEN)
#: How long each waits for its device.
ENTRY_TTL = timedelta(minutes=2)
READY_TTL = timedelta(minutes=10)
OVERDUE_TTL = timedelta(minutes=15)
#: The Ably event on a till's own channel: `{serverTime, noticeId, kind, tableId, answer?}` — pull.
EVENT = "table-notice"


def _now() -> datetime:
    from app.services import tables as T

    return T._now()


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = _utc(moment)
    return moment.isoformat() if moment is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _conflict(code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, **extra})


def table_words(table: Optional[DiningTable], order: Optional[TableOrder] = None) -> str:
    """"שולחן 12", or its label alone ("ש-12")."""
    if table is not None:
        name = (table.name or "").strip()
        if getattr(table, "label_only", False) and name:
            return name
        return f"שולחן {table.number}" + (f" ({name})" if name else "")
    if order is not None and order.table_number is not None:
        return f"שולחן {order.table_number}"
    return "שולחן"


def status_of(n: TableNotice, now: datetime) -> str:
    """pending | leaving | ignored | seen | expired."""
    if n.answer:
        return n.answer
    expires = _utc(n.expires_at)
    return "expired" if expires is not None and expires <= now else "pending"


def notice_out(n: TableNotice, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or _now()
    payload = n.payload if isinstance(n.payload, dict) else {}
    return {
        "id": str(n.id),
        "kind": n.kind,
        "tableId": str(n.table_id) if n.table_id else None,
        "orderId": str(n.order_id) if n.order_id else None,
        "tableNumber": payload.get("tableNumber"),
        "tableName": payload.get("tableName"),
        "toMachineId": str(n.to_machine_id) if n.to_machine_id else None,
        "toPosUserId": n.to_pos_user_id,
        "from": {
            "machineId": str(n.from_machine_id) if n.from_machine_id else None,
            "deviceLabel": payload.get("fromDevice"),
            "posUserId": n.from_pos_user_id,
            "posUserName": n.from_pos_user_name,
        } if n.kind == ENTRY_REQUEST else None,
        "text": n.text,
        "createdAt": _iso(n.created_at),
        "expiresAt": _iso(n.expires_at),
        "status": status_of(n, now),
        "answer": n.answer,
        "answeredAt": _iso(n.answered_at),
        "answeredByName": n.answered_by_name,
    }


# ── Waking ──────────────────────────────────────────────────────────────────────────


def _targets(db: Session, n: TableNotice) -> List[POSMachine]:
    """The device a notice is for, else (a waiter's, device unknown) every till of the shop."""
    if n.to_machine_id is not None:
        m = db.get(POSMachine, n.to_machine_id)
        return [m] if m is not None else []
    return [
        m for m in db.query(POSMachine).filter(POSMachine.shop_id == n.shop_id, POSMachine.is_active.is_(True)).all()
        if getattr(m, "is_fiscal", True) is not False
    ]


def wake_after_commit(db: Session, notices: Iterable[TableNotice], *, answered: bool = False) -> None:
    """Once `db` commits: `table-notice` to each notice's device(s) — or, for an answer, to the asker's."""
    from app.services import after_commit
    from app.services.ably_notify import _notify_base, publish_notify

    sends: List[tuple] = []
    for n in notices:
        machines = (
            [db.get(POSMachine, n.from_machine_id)] if answered and n.from_machine_id is not None else _targets(db, n)
        )
        body = {**_notify_base(), "noticeId": str(n.id), "kind": n.kind,
                "tableId": str(n.table_id) if n.table_id else None}
        if answered:
            body["answer"] = n.answer
        for m in machines:
            if m is not None and m.tenant_id is not None:
                sends.append((str(m.tenant_id), str(m.id), body))
    if not sends:
        return

    def go() -> None:
        for tenant_id, machine_id, body in sends:
            try:
                publish_notify(tenant_id, machine_id, EVENT, body)
            except Exception:  # noqa: BLE001 - the till pulls on its heartbeat anyway
                logger.exception("table notice wake failed for machine %s", machine_id)

    after_commit.run(db, go)


# ── "בקש מדנה לצאת" (§8 `request`) ────────────────────────────────────────────────


def create_entry_request(db: Session, actor: Any, table: DiningTable, *, now: Optional[datetime] = None) -> TableNotice:
    """
    A till refused at a busy table asks the device inside to leave. 409 `table_not_locked` when nobody
    is (enter it), `entry_request_off` unless this till's `tableBusyEntry` is `request`. One pending
    request per table and asking device: a second tap is the same request.
    """
    from app.services import table_assignments as TAS
    from app.services import tables as T

    now = now or _now()
    cfg = T.busy_entry(db, actor.machine)
    if cfg.busy_entry != TAS.BUSY_REQUEST:
        raise _conflict("entry_request_off", entry=cfg.busy_entry)
    if not T.lock_live(table, now) or table.lock_machine_id == actor.machine.id:
        raise _conflict("table_not_locked", table=T.table_ref(table))
    existing = (
        db.query(TableNotice)
        .filter(
            TableNotice.kind == ENTRY_REQUEST,
            TableNotice.table_id == table.id,
            TableNotice.from_machine_id == actor.machine.id,
            TableNotice.to_machine_id == table.lock_machine_id,
            TableNotice.answer.is_(None),
            TableNotice.expires_at > now,
        )
        .first()
    )
    if existing is not None:
        return existing
    who = (actor.pos_user_name or "").strip() or T.device_label(actor.machine) or "קופה אחרת"
    order = T.open_order(db, table.id)
    n = TableNotice(
        id=uuid.uuid4(),
        tenant_id=table.tenant_id,
        shop_id=table.shop_id,
        table_id=table.id,
        order_id=order.id if order is not None else None,
        kind=ENTRY_REQUEST,
        to_machine_id=table.lock_machine_id,
        to_pos_user_id=table.lock_pos_user_id,
        from_machine_id=actor.machine.id,
        from_pos_user_id=actor.pos_user_id,
        from_pos_user_name=actor.pos_user_name,
        text=f"{who} מבקש להיכנס ל{table_words(table)}"[:300],
        payload={
            "tableNumber": table.number,
            "tableName": table.name,
            "fromDevice": T.device_label(actor.machine),
        },
        created_at=now,
        expires_at=now + ENTRY_TTL,
    )
    db.add(n)
    db.flush()
    return n


def entry_requests_for(db: Session, machine: POSMachine, table: DiningTable, now: datetime) -> List[TableNotice]:
    """The pending requests to come into `table`, for the device inside it (its heartbeat's `entryRequests`)."""
    return (
        db.query(TableNotice)
        .filter(
            TableNotice.kind == ENTRY_REQUEST,
            TableNotice.table_id == table.id,
            TableNotice.to_machine_id == machine.id,
            TableNotice.answer.is_(None),
            TableNotice.expires_at > now,
        )
        .order_by(TableNotice.created_at.asc())
        .all()
    )


def pending_for(db: Session, machine: POSMachine, pos_user_id: Optional[str], *, now: Optional[datetime] = None) -> List[TableNotice]:
    """
    What this device shows now: the notices for it, and those for the waiter signed in at it
    (`pos_user_id`) wherever the cloud thought they were. The first pull marks them delivered.
    """
    now = now or _now()
    if machine.shop_id is None:
        return []
    mine = [TableNotice.to_machine_id == machine.id]
    if pos_user_id:
        mine.append(and_(TableNotice.shop_id == machine.shop_id, TableNotice.to_pos_user_id == str(pos_user_id),
                         TableNotice.kind != ENTRY_REQUEST))
    rows = (
        db.query(TableNotice)
        .filter(or_(*mine), TableNotice.answer.is_(None), TableNotice.expires_at > now)
        .order_by(TableNotice.created_at.asc())
        .limit(50)
        .all()
    )
    for n in rows:
        if n.delivered_at is None:
            n.delivered_at = now
    if rows:
        db.flush()
    return rows


def _visible(db: Session, machine: POSMachine, n: Optional[TableNotice]) -> bool:
    if n is None or machine.shop_id is None or n.shop_id != machine.shop_id:
        return False
    return machine.id in (n.to_machine_id, n.from_machine_id) or n.to_machine_id is None


def get_for(db: Session, machine: POSMachine, notice_id: Any) -> TableNotice:
    """A notice this device sent or got (the asker follows its request's answer); 404 otherwise."""
    ident = _uuid(notice_id)
    n = db.get(TableNotice, ident) if ident else None
    if not _visible(db, machine, n):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "notice_not_found"})
    return n


def answer(db: Session, machine: POSMachine, notice_id: Any, value: str, by_name: Optional[str], *,
           now: Optional[datetime] = None) -> TableNotice:
    """
    The device answers: `leaving` ("שמור וצא" — it leaves once its action is done, never mid-payment),
    `ignored`, or `seen` (a notice read). Once: a second answer is answered with the first.
    """
    now = now or _now()
    if value not in ANSWERS:
        raise HTTPException(status_code=422, detail={"code": "answer_unknown"})
    n = get_for(db, machine, notice_id)
    if n.from_machine_id == machine.id and n.to_machine_id != machine.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "not_the_addressee"})
    if n.answer is None:
        n.answer = value
        n.answered_at = now
        n.answered_by_name = (by_name or "").strip()[:200] or None
        db.flush()
    return n


# ── For the assigned waiter (§5) ────────────────────────────────────────────────────


def waiter_device(db: Session, shop_id: Any, pos_user_id: Any, now: datetime) -> Optional[uuid.UUID]:
    """
    Where the waiter is signed in, when the cloud knows: their live session ("עובד מחובר בקופה אחת
    בלבד"), else the device holding a table in their name now. None — unknown.
    """
    from app.models.pos_user_session import PosUserSession

    ident = _uuid(pos_user_id)
    if ident is not None:
        row = (
            db.query(PosUserSession)
            .filter(PosUserSession.pos_user_id == ident, PosUserSession.released_at.is_(None))
            .order_by(PosUserSession.last_seen_at.desc())
            .first()
        )
        if row is not None and (row.shop_id is None or str(row.shop_id) == str(shop_id)):
            try:
                from app.services import user_sessions as US

                machine = db.get(POSMachine, row.machine_id)
                stale = US.is_stale(row, now, US.policy_for_machine(db, machine).stale_minutes) if machine else True
            except Exception:  # noqa: BLE001 - treat as fresh
                stale = False
            if not stale:
                return row.machine_id
    held = (
        db.query(DiningTable)
        .filter(
            DiningTable.shop_id == shop_id,
            DiningTable.lock_pos_user_id == str(pos_user_id),
            DiningTable.lock_expires_at > now,
        )
        .order_by(DiningTable.lock_seen_at.desc())
        .first()
    )
    return held.lock_machine_id if held is not None else None


def notify_assigned(
    db: Session, table: DiningTable, order: Optional[TableOrder], kind: str, text: str, dedupe: str, *,
    ttl: timedelta, now: Optional[datetime] = None, payload: Optional[Dict[str, Any]] = None,
) -> List[TableNotice]:
    """
    One notice per waiter `table` is assigned to — with `tableAssignmentNotify` (and the mode) on for the
    shop; none otherwise, or for a table assigned to nobody. `dedupe`: the event's key (one notice per
    waiter per event, whoever sees it twice).
    """
    from app.services import table_assignments as TAS

    from app.models.table_assignment import TableAssignment

    now = now or _now()
    shop = db.get(Shop, table.shop_id)
    if shop is None:
        return []
    # A shop that assigns nobody costs one read.
    if (
        db.query(TableAssignment.id)
        .filter(TableAssignment.shop_id == shop.id, TableAssignment.released_at.is_(None))
        .first()
    ) is None:
        return []
    cfg = TAS.shop_config(db, shop)
    if not (cfg.on and cfg.notify):
        return []
    waiters = TAS.assigned_to(db, table, now=now)
    out: List[TableNotice] = []
    for pid in waiters:
        key = f"{dedupe}:{pid}"[:160]
        if db.query(TableNotice.id).filter(TableNotice.dedupe_key == key).first() is not None:
            continue
        n = TableNotice(
            id=uuid.uuid4(), tenant_id=table.tenant_id, shop_id=table.shop_id, table_id=table.id,
            order_id=order.id if order is not None else None, kind=kind,
            to_machine_id=waiter_device(db, shop.id, pid, now), to_pos_user_id=str(pid),
            text=text[:300], payload={"tableNumber": table.number, "tableName": table.name, **(payload or {})},
            dedupe_key=key, created_at=now, expires_at=now + ttl,
        )
        try:
            with db.begin_nested():
                db.add(n)
                db.flush()
        except IntegrityError:
            continue
        out.append(n)
    if out:
        wake_after_commit(db, out)
    return out


def on_kds_ready(db: Session, korder: Any, *, now: Optional[datetime] = None) -> List[TableNotice]:
    """
    "מוכן להגשה" (§5): the KDS made a table's order ready — its assigned waiters are told. Its own
    savepoint, never raising: a notice never costs the kitchen's action.
    """
    try:
        with db.begin_nested():
            if getattr(korder, "source", None) != "table":
                return []
            order = db.get(TableOrder, _uuid(getattr(korder, "source_ref", None))) if _uuid(getattr(korder, "source_ref", None)) else None
            if order is None or order.table_id is None:
                return []
            table = db.get(DiningTable, order.table_id)
            if table is None or str(table.shop_id) != str(korder.shop_id):
                return []
            now = now or _now()
            ready = _utc(getattr(korder, "ready_at", None)) or now
            return notify_assigned(
                db, table, order, KDS_READY, f"מוכן להגשה — {table_words(table)}",
                f"kds_ready:{korder.id}:{int(ready.timestamp())}", ttl=READY_TTL, now=now,
                payload={"kdsOrderId": str(korder.id)},
            )
    except Exception:  # pragma: no cover - logged, the kitchen goes on
        logger.exception("ready notice for KDS order %s failed", getattr(korder, "id", None))
        return []


#: An open table is checked once its quiet spell reaches this, whatever `tableOverdueMinutes` says.
_OVERDUE_FLOOR = timedelta(minutes=5)


def overdue_pass(db: Session, *, now: Optional[datetime] = None) -> List[TableNotice]:
    """
    "שולחן מתעכב" (§5): every open order of the cloud's tables with no action (`updated_at`) for its
    shop's `tableOverdueMinutes` tells its assigned waiters — once per quiet spell (a new action starts a
    new one). Shops with `tableAssignmentNotify` off cost one read of their parameters.
    """
    from app.models.table_assignment import TableAssignment
    from app.services import table_assignments as TAS
    from app.services import till_parameters as TP
    from app.services.table_tile_look import OVERDUE_DEFAULT, OVERDUE_KEY, OVERDUE_MAX, OVERDUE_MIN

    now = now or _now()
    # Only the shops that assign someone.
    assigning = {
        sid for (sid,) in db.query(TableAssignment.shop_id).filter(TableAssignment.released_at.is_(None)).distinct().all()
    }
    if not assigning:
        return []
    orders = (
        db.query(TableOrder)
        .filter(
            TableOrder.status == "open", TableOrder.source == "synced", TableOrder.updated_at <= now - _OVERDUE_FLOOR,
            TableOrder.shop_id.in_(list(assigning)),
        )
        .all()
    )
    by_shop: Dict[Any, List[TableOrder]] = {}
    for o in orders:
        by_shop.setdefault(o.shop_id, []).append(o)
    out: List[TableNotice] = []
    for shop_id, rows in by_shop.items():
        shop = db.get(Shop, shop_id)
        if shop is None:
            continue
        params = TP.resolve_for_shop(db, shop)
        cfg = TAS.config_of(params)
        if not (cfg.on and cfg.notify):
            continue
        minutes = params.get(OVERDUE_KEY)
        if isinstance(minutes, bool) or not isinstance(minutes, (int, float)):
            minutes = OVERDUE_DEFAULT
        minutes = int(min(max(int(minutes), OVERDUE_MIN), OVERDUE_MAX))
        for o in rows:
            quiet_since = _utc(o.updated_at)
            if quiet_since is None or now - quiet_since < timedelta(minutes=minutes):
                continue
            table = db.get(DiningTable, o.table_id)
            if table is None or table.archived_at is not None:
                continue
            quiet = int((now - quiet_since).total_seconds() // 60)
            out += notify_assigned(
                db, table, o, OVERDUE, f"{table_words(table)} מתעכב — {quiet} דק׳ בלי פעולה",
                f"overdue:{o.id}:{int(quiet_since.timestamp())}", ttl=OVERDUE_TTL, now=now,
                payload={"quietMinutes": quiet},
            )
    return out
