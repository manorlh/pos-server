"""
The event's life (docs/SPEC_EVENTS.md §1–§2): create / update / delete while draft, the
overlap rule, and the confirmation ("נותן תוקף") that freezes the report and releases the
tills. Nothing here writes to a till, a document, a shift or a Z.
"""
from __future__ import annotations

import re
import uuid
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.middleware.auth import ensure_same_tenant
from app.models.pos_machine import POSMachine
from app.models.report_event import (
    EVENT_CONFIRMED,
    EVENT_DRAFT,
    ReportEvent,
    ReportEventMachine,
    ReportEventMachineChange,
)
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.main_till import till_order
from app.services.reports import resolve_report_timezone

from . import rules as R
from .common import iso, utc
from .report import build_report, event_block, zone

#: Who may create, edit, delete and confirm an event (reading follows the shop's access).
WRITE_ROLES = frozenset({
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.SHOP_MANAGER,
})
MAX_EVENT_DAYS = 14
NAME_MAX = 120
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _error(code: int, key: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=code, detail={"code": key, "message": message, **extra})


def check_shop_access(user: User, shop: Shop, db: Session) -> None:
    from app.routers.shops import _check_shop_access

    _check_shop_access(user, shop, db)


def load_shop(db: Session, user: User, tenant_id, shop_id, *, write: bool) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise _error(status.HTTP_404_NOT_FOUND, "shop_not_found", "הסניף לא נמצא")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    if write and user.role not in WRITE_ROLES:
        raise _error(status.HTTP_403_FORBIDDEN, "forbidden", "אין הרשאה לנהל אירועים")
    check_shop_access(user, shop, db)
    return shop


def load_event(
    db: Session, user: User, tenant_id, event_id, *, write: bool = False, draft: bool = False,
) -> ReportEvent:
    """
    The event, when the user may read it — or, with `write`, change it. A write takes the event's
    row lock (`FOR UPDATE`, held to the end of the transaction) and re-reads the row and its tills
    under it, so every change to one event — its window, its tills, its confirmation — runs one
    at a time on what is really there. `draft`: and it must still be a draft (checked under the
    lock). Lock order everywhere: events first (by id), then tills (by id).
    """
    try:
        ident = event_id if isinstance(event_id, uuid.UUID) else uuid.UUID(str(event_id))
    except (TypeError, ValueError):
        raise _error(status.HTTP_404_NOT_FOUND, "event_not_found", "האירוע לא נמצא")
    event = db.query(ReportEvent).filter(ReportEvent.id == ident).first()
    if event is None or event.tenant_id != tenant_id:
        raise _error(status.HTTP_404_NOT_FOUND, "event_not_found", "האירוע לא נמצא")
    load_shop(db, user, tenant_id, event.shop_id, write=write)
    if write:
        # Checked before locking: a caller who may not touch the event never holds its lock.
        event = lock_event(db, event)
    if draft:
        _require_draft(event)
    return event


def lock_event(db: Session, event: ReportEvent) -> ReportEvent:
    """
    Take the event's row lock (a no-op when this transaction holds it already) and re-read the
    row and its tills under it — what another transaction committed while we waited counts.
    """
    locked = (
        db.query(ReportEvent)
        .filter(ReportEvent.id == event.id)
        .with_for_update()
        .populate_existing()
        .one()
    )
    db.expire(locked, ["machines"])
    return locked


def _require_draft(event: ReportEvent) -> None:
    if event.status != EVENT_DRAFT:
        raise _error(status.HTTP_409_CONFLICT, "event_confirmed", "האירוע אושר ונעול לעריכה")


# ── Concurrency: one transaction per request, its losers a 409 ───────────────

CONCURRENT_SQLSTATES = {"40P01", "40001", "55P03"}   # deadlock, serialization failure, lock not available


def concurrency_conflict(exc: BaseException) -> Optional[HTTPException]:
    """
    The database refusing a write because another one got there first — a deadlock between two
    assignments, the same till added twice at once — as a clear 409, never a 500. None: not that.
    """
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "pgcode", None) or getattr(orig, "sqlstate", None) or getattr(
        getattr(orig, "diag", None), "sqlstate", None
    )
    if isinstance(exc, IntegrityError) and (
        code == "23505" or "uq_report_event_machines_event_machine" in str(orig or exc)
    ):
        return _error(status.HTTP_409_CONFLICT, "till_already_assigned",
                      "הקופה כבר שויכה לאירוע בבקשה אחרת — רעננו ונסו שוב")
    if code in CONCURRENT_SQLSTATES:
        return _error(status.HTTP_409_CONFLICT, "concurrent_change",
                      "האירוע או הקופות השתנו במקביל — רעננו ונסו שוב")
    return None


@contextmanager
def atomic(db: Session) -> Iterator[None]:
    """A router's write: commit at the end, or roll everything back (a race → 409, see above)."""
    try:
        yield
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        mapped = concurrency_conflict(exc)
        if mapped is None:
            raise
        raise mapped from exc
    except BaseException:
        db.rollback()
        raise


# ── The window ────────────────────────────────────────────────────────────────


def _parse_date(value: Any, field: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_window", f"תאריך לא תקין ({field})", field=field)


def _parse_time(value: Any, field: str) -> time:
    m = _TIME.match(str(value or "").strip())
    if not m:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_window", f"שעה לא תקינה ({field}) — HH:MM", field=field)
    return time(int(m.group(1)), int(m.group(2)))


def resolve_window(
    db: Session, tenant_id, start_date, start_time, end_date, end_time,
) -> Tuple[datetime, datetime, str]:
    """Local date + hour (both required) → UTC bounds, in the tenant's timezone."""
    missing = [f for f, v in (("startDate", start_date), ("startTime", start_time),
                              ("endDate", end_date), ("endTime", end_time)) if v in (None, "")]
    if missing:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_window",
                     "חובה לבחור תאריך ושעה להתחלה ולסיום", fields=missing)
    tz_name = resolve_report_timezone(db, tenant_id, None)
    tz = zone(tz_name)
    starts = datetime.combine(_parse_date(start_date, "startDate"), _parse_time(start_time, "startTime"), tzinfo=tz)
    ends = datetime.combine(_parse_date(end_date, "endDate"), _parse_time(end_time, "endTime"), tzinfo=tz)
    starts, ends = starts.astimezone(timezone.utc), ends.astimezone(timezone.utc)
    if ends <= starts:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_window", "סיום האירוע חייב להיות אחרי ההתחלה")
    if ends - starts > timedelta(days=MAX_EVENT_DAYS):
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_window",
                     f"אירוע יכול להימשך עד {MAX_EVENT_DAYS} ימים")
    return starts, ends, tz_name


# ── Tills and the overlap rule ────────────────────────────────────────────────


def shop_tills(db: Session, shop: Shop, extra_ids: Sequence[uuid.UUID] = ()) -> List[POSMachine]:
    """
    The shop's active tills, plus any named (an inactive till already in the event). Not a
    display device (a KDS / the board, app/services/display_devices.py): it sells nothing.
    """
    rows = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
        .all()
    )
    have = {m.id for m in rows}
    missing = [i for i in extra_ids if i not in have]
    if missing:
        rows += db.query(POSMachine).filter(POSMachine.id.in_(missing), POSMachine.shop_id == shop.id).all()
    return sorted(rows, key=till_order)


def validate_machines(db: Session, shop: Shop, machine_ids: Sequence[Any]) -> List[POSMachine]:
    ids: List[uuid.UUID] = []
    for raw in machine_ids or []:
        try:
            ident = raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw))
        except (TypeError, ValueError):
            raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_till", "מזהה קופה לא תקין")
        if ident not in ids:
            ids.append(ident)
    if not ids:
        return []
    found = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()}
    for ident in ids:
        m = found.get(ident)
        if m is None or m.shop_id != shop.id or (m.tenant_id is not None and m.tenant_id != shop.tenant_id):
            raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "till_not_in_shop",
                         "אפשר לשייך לאירוע רק קופות של הסניף שלו", machineId=str(ident))
    return [found[i] for i in ids]


def busy_tills(
    db: Session, tenant_id, machine_ids: Sequence[uuid.UUID], starts: datetime, ends: datetime,
    exclude_event_id: Optional[uuid.UUID] = None,
) -> Dict[uuid.UUID, ReportEvent]:
    """Each till already in another draft event whose window overlaps [starts, ends)."""
    if not machine_ids:
        return {}
    q = (
        db.query(ReportEventMachine.machine_id, ReportEvent)
        .join(ReportEvent, ReportEvent.id == ReportEventMachine.event_id)
        .filter(
            ReportEvent.tenant_id == tenant_id,
            ReportEventMachine.machine_id.in_(list(machine_ids)),
            ReportEventMachine.released_at.is_(None),
            ReportEvent.status == EVENT_DRAFT,
            ReportEvent.starts_at < ends,
            ReportEvent.ends_at > starts,
        )
    )
    if exclude_event_id is not None:
        q = q.filter(ReportEvent.id != exclude_event_id)
    out: Dict[uuid.UUID, ReportEvent] = {}
    for mid, ev in q.order_by(ReportEvent.starts_at).all():
        out.setdefault(mid, ev)
    return out


def assert_no_overlap(
    db: Session, tenant_id, machines: Sequence[POSMachine], starts: datetime, ends: datetime,
    exclude_event_id: Optional[uuid.UUID] = None,
) -> None:
    if not machines:
        return
    # Serialise on the tills' rows, in one order, so two events cannot both take a till.
    ids = sorted(m.id for m in machines)
    db.query(POSMachine.id).filter(POSMachine.id.in_(ids)).order_by(POSMachine.id).with_for_update().all()
    busy = busy_tills(db, tenant_id, ids, starts, ends, exclude_event_id)
    if not busy:
        return
    by_id = {m.id: m for m in machines}
    mid, other = next(iter(sorted(busy.items(), key=lambda kv: till_order(by_id[kv[0]]))))
    tz = zone(other.timezone)
    window = (
        f"{utc(other.starts_at).astimezone(tz).strftime('%d/%m %H:%M')}–"
        f"{utc(other.ends_at).astimezone(tz).strftime('%d/%m %H:%M')}"
    )
    raise _error(
        status.HTTP_409_CONFLICT, "till_in_overlapping_event",
        f"הקופה {by_id[mid].name} כבר משויכת לאירוע \"{other.name}\" ({window}) שחופף לחלון הזמן",
        machineId=str(mid), machineName=by_id[mid].name, eventId=str(other.id), eventName=other.name,
        startsAt=iso(other.starts_at), endsAt=iso(other.ends_at),
        busy=[{"machineId": str(k), "machineName": by_id[k].name, "eventId": str(v.id), "eventName": v.name}
              for k, v in busy.items()],
    )


def tills_view(
    db: Session, user: User, tenant_id, shop_id, window: Optional[Tuple[datetime, datetime]],
    exclude_event_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """
    The shop's tills for the event dialog and the quick pickers ("שיוך קופות מהיר לאירוע"):
    each with its area ("נקודת מכירה"), its device groups, whether it is a kiosk and, with a
    window, the overlapping draft event it is already in; the areas and groups to pick by; and
    the shop's latest events, to copy their tills.
    """
    from app.models.kiosk import KioskDevice
    from app.models.machine_group import MachineGroup, MachineGroupMember
    from app.models.shop_area import ShopArea

    shop = load_shop(db, user, tenant_id, shop_id, write=False)
    tills = shop_tills(db, shop)
    ids = [m.id for m in tills]
    busy = busy_tills(db, tenant_id, ids, *window, exclude_event_id) if window else {}

    area_ids = {m.area_id for m in tills if m.area_id}
    area_rows = (
        db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).order_by(ShopArea.sort_order, ShopArea.name).all()
        if area_ids else []
    )
    areas = {a.id: a.name for a in area_rows}
    kiosks = {k for (k,) in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id.in_(ids)).all()} if ids else set()
    groups_of: Dict[uuid.UUID, List[str]] = {}
    group_rows: List[MachineGroup] = []
    if ids and shop.company_id is not None:
        members = (
            db.query(MachineGroupMember.machine_id, MachineGroup)
            .join(MachineGroup, MachineGroup.id == MachineGroupMember.group_id)
            .filter(
                MachineGroupMember.machine_id.in_(ids),
                MachineGroup.company_id == shop.company_id,
                MachineGroup.tenant_id == shop.tenant_id,
            )
            .order_by(MachineGroup.sort_order, MachineGroup.name)
            .all()
        )
        seen = set()
        for mid, group in members:
            groups_of.setdefault(mid, []).append(str(group.id))
            if group.id not in seen:
                seen.add(group.id)
                group_rows.append(group)
    return {
        "shopId": str(shop.id),
        "tills": [
            {
                "id": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "areaId": str(m.area_id) if m.area_id in areas else None,
                "areaName": areas.get(m.area_id) if m.area_id else None,
                "kind": "kiosk" if m.id in kiosks else "till",
                "groupIds": groups_of.get(m.id, []),
                "lastHeartbeatAt": iso(m.last_heartbeat_at),
                "busy": (
                    {"eventId": str(busy[m.id].id), "eventName": busy[m.id].name,
                     "startsAt": iso(busy[m.id].starts_at), "endsAt": iso(busy[m.id].ends_at)}
                    if m.id in busy else None
                ),
            }
            for m in tills
        ],
        "areas": [{"id": str(a.id), "name": a.name} for a in area_rows],
        "groups": [{"id": str(g.id), "name": g.name} for g in group_rows],
        "recentEvents": recent_events(db, shop, set(ids), exclude_event_id),
    }


#: How many of the shop's latest events "העתק קופות מאירוע קודם" offers.
RECENT_EVENTS = 8


def recent_events(db: Session, shop: Shop, current_ids, exclude_event_id: Optional[uuid.UUID]) -> List[Dict[str, Any]]:
    """The shop's latest events with tills, newest first — each with those of its tills the shop still has."""
    q = db.query(ReportEvent).filter(ReportEvent.shop_id == shop.id, ReportEvent.tenant_id == shop.tenant_id)
    if exclude_event_id is not None:
        q = q.filter(ReportEvent.id != exclude_event_id)
    out: List[Dict[str, Any]] = []
    for event in q.order_by(ReportEvent.starts_at.desc()).limit(RECENT_EVENTS * 3).all():
        machine_ids = [str(r.machine_id) for r in event.machines if r.machine_id in current_ids]
        if not machine_ids:
            continue
        out.append({
            "id": str(event.id), "name": event.name, "status": event.status,
            "startsAt": iso(event.starts_at), "endsAt": iso(event.ends_at), "machineIds": machine_ids,
        })
        if len(out) >= RECENT_EVENTS:
            break
    return out


# ── Moving a till between events, and the history ────────────────────────────

CHANGE_ADDED = "added"
CHANGE_REMOVED = "removed"
CHANGE_MOVED_IN = "moved_in"
CHANGE_MOVED_OUT = "moved_out"


def parse_ids(raw_ids: Optional[Sequence[Any]]) -> List[uuid.UUID]:
    out: List[uuid.UUID] = []
    for raw in raw_ids or []:
        try:
            ident = raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw))
        except (TypeError, ValueError):
            raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_till", "מזהה קופה לא תקין")
        if ident not in out:
            out.append(ident)
    return out


def record_change(
    db: Session, tenant_id, event_id: uuid.UUID, machine_id: uuid.UUID, action: str, user: Optional[User],
    other: Optional[Tuple[uuid.UUID, str]] = None,
) -> None:
    db.add(ReportEventMachineChange(
        id=uuid.uuid4(), tenant_id=tenant_id, event_id=event_id, machine_id=machine_id, action=action,
        other_event_id=other[0] if other else None, other_event_name=(other[1] or "")[:NAME_MAX] if other else None,
        user_id=user.id if user is not None else None,
    ))


def _check_moves(move_ids: Sequence[uuid.UUID], target_ids) -> None:
    stray = [i for i in move_ids if i not in target_ids]
    if stray:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_move",
                     "אפשר להעביר לאירוע רק קופה שמשויכת אליו", machineId=str(stray[0]))


def _holders(
    db: Session, tenant_id, machine_ids: Sequence[uuid.UUID], starts: datetime, ends: datetime,
    exclude_event_id: uuid.UUID,
) -> List[Tuple[ReportEventMachine, ReportEvent]]:
    """The other draft events overlapping [starts, ends) that hold any of the tills, with their rows."""
    if not machine_ids:
        return []
    q = (
        db.query(ReportEventMachine, ReportEvent)
        .join(ReportEvent, ReportEvent.id == ReportEventMachine.event_id)
        .filter(
            ReportEvent.tenant_id == tenant_id,
            ReportEventMachine.machine_id.in_(list(machine_ids)),
            ReportEventMachine.released_at.is_(None),
            ReportEvent.status == EVENT_DRAFT,
            ReportEvent.starts_at < ends,
            ReportEvent.ends_at > starts,
            ReportEvent.id != exclude_event_id,
        )
        .order_by(ReportEvent.id, ReportEventMachine.machine_id)
    )
    return q.all()


def _may_edit_other(db: Session, user: User, tenant_id, other: ReportEvent, machine: POSMachine) -> None:
    """
    Moving a till out of an event is editing that event. Refused: a 403 that names the event only
    when the user can see its shop (an event elsewhere stays unnamed).
    """
    try:
        load_shop(db, user, tenant_id, other.shop_id, write=True)
        return
    except HTTPException:
        pass
    try:
        load_shop(db, user, tenant_id, other.shop_id, write=False)
        visible = True
    except HTTPException:
        visible = False
    if visible:
        raise _error(
            status.HTTP_403_FORBIDDEN, "cannot_edit_other_event",
            f"אין הרשאה לערוך את האירוע \"{other.name}\" — אי אפשר להעביר ממנו את הקופה {machine.name}",
            machineId=str(machine.id), eventId=str(other.id), eventName=other.name,
        )
    raise _error(
        status.HTTP_403_FORBIDDEN, "cannot_edit_other_event",
        f"הקופה {machine.name} משויכת לאירוע אחר שאין לך הרשאה לערוך — אי אפשר להעביר אותה",
        machineId=str(machine.id),
    )


def lock_assignment(
    db: Session, user: User, tenant_id, target_id: uuid.UUID, machines: Sequence[POSMachine],
    moving: Sequence[POSMachine], starts: datetime, ends: datetime,
) -> Dict[uuid.UUID, ReportEvent]:
    """
    The one lock phase of an assignment, after the target event's own lock: first the other
    draft events holding the tills to move (sorted by id; each one the user must be allowed to
    edit, and re-read under its lock), then every till being assigned, once, sorted by id.
    Returns the source events locked.
    """
    sources: Dict[uuid.UUID, ReportEvent] = {}
    by_id = {m.id: m for m in moving}
    seen = _holders(db, tenant_id, list(by_id), starts, ends, target_id)
    first_till = {}
    for row, ev in seen:
        first_till.setdefault(ev.id, row.machine_id)
    if first_till:
        locked = (
            db.query(ReportEvent)
            .filter(ReportEvent.id.in_(sorted(first_till)))
            .order_by(ReportEvent.id)
            .with_for_update(of=ReportEvent)
            .populate_existing()
            .all()
        )
        for ev in locked:
            _may_edit_other(db, user, tenant_id, ev, by_id[first_till[ev.id]])
            db.expire(ev, ["machines"])
            sources[ev.id] = ev
    ids = sorted({m.id for m in machines})
    if ids:
        db.query(POSMachine.id).filter(POSMachine.id.in_(ids)).order_by(POSMachine.id).with_for_update().all()
    return sources


def move_tills(
    db: Session, user: User, tenant_id, target: Tuple[uuid.UUID, str], machines: Sequence[POSMachine],
    starts: datetime, ends: datetime, sources: Dict[uuid.UUID, ReportEvent],
    now: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    "העבר לאירוע הזה": take each of `machines` out of every other draft event whose window
    overlaps [starts, ends) — only when asked, till by till, never silently. Runs after
    `lock_assignment` (`sources`: the events holding them, locked and checked; then the tills
    locked): the holders are read again under those locks. An event confirmed meanwhile keeps its
    till (released: nothing to move). A till that went to another event meanwhile is not taken
    from there — the request saw it elsewhere: 409 `concurrent_change`. Each move is recorded on
    both events. The caller commits, or nothing happened.
    """
    if not machines:
        return []
    by_id = {m.id: m for m in machines}
    rows = _holders(db, tenant_id, list(by_id), starts, ends, target[0])
    now = utc(now) or datetime.now(timezone.utc)
    touched: Dict[uuid.UUID, ReportEvent] = {}
    moved: List[Dict[str, Any]] = []
    for row, other in rows:
        if other.status != EVENT_DRAFT or row.released_at is not None:
            continue
        if other.id not in sources:
            raise _error(
                status.HTTP_409_CONFLICT, "concurrent_change",
                f"הקופה {by_id[row.machine_id].name} שויכה לאירוע אחר בזמן השמירה — רעננו ונסו שוב",
                machineId=str(row.machine_id),
            )
        if other.id not in touched:
            touched[other.id] = other
            other.updated_at = now
        db.delete(row)
        record_change(db, tenant_id, other.id, row.machine_id, CHANGE_MOVED_OUT, user, target)
        record_change(db, tenant_id, target[0], row.machine_id, CHANGE_MOVED_IN, user, (other.id, other.name))
        moved.append({
            "machineId": str(row.machine_id), "machineName": by_id[row.machine_id].name,
            "fromEventId": str(other.id), "fromEventName": other.name,
        })
    db.flush()
    for other in touched.values():
        db.expire(other, ["machines"])
    return moved


def change_tills(
    db: Session, user: User, tenant_id, event: ReportEvent, *,
    add: Sequence[Any] = (), remove: Sequence[Any] = (), move: Sequence[Any] = (),
) -> Dict[str, Any]:
    """
    The bulk assignment ("שייך לאירוע", "הוסף/הסר קופות"): add tills, remove tills and move
    tills here from overlapping draft events, in one go. All or nothing — any refusal (a till
    of another shop, a till busy in an overlapping event not asked to be moved, another event
    the user may not edit) raises before the caller commits. `move` tills are added as well.

    Locks: this event (re-read: still a draft, its window and tills as committed), then the
    events the moved tills leave, then every till added — so two assignments, a window edit and
    a confirmation of the same events run one after the other, never interleaved.
    """
    event = lock_event(db, event)
    _require_draft(event)
    shop = load_shop(db, user, tenant_id, event.shop_id, write=True)
    add_ids, remove_ids, move_ids = parse_ids(add), parse_ids(remove), parse_ids(move)
    to_add = add_ids + [i for i in move_ids if i not in add_ids]
    both = [i for i in to_add if i in remove_ids]
    if both:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_change",
                     "אותה קופה לא יכולה להתווסף ולהיות מוסרת יחד", machineId=str(both[0]))
    adding = validate_machines(db, shop, to_add)
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    moving = [m for m in adding if m.id in move_ids]
    sources = lock_assignment(db, user, tenant_id, event.id, adding, moving, starts, ends)
    moved = move_tills(db, user, tenant_id, (event.id, event.name), moving, starts, ends, sources)
    assert_no_overlap(db, tenant_id, adding, starts, ends, event.id)
    moved_ids = {uuid.UUID(m["machineId"]) for m in moved}
    # The event's tills as they are now, under the locks (not as first loaded).
    db.expire(event, ["machines"])
    current = {r.machine_id: r for r in event.machines}
    added, removed = [], []
    for rid in remove_ids:
        row = current.get(rid)
        if row is None:
            continue
        event.machines.remove(row)
        record_change(db, tenant_id, event.id, rid, CHANGE_REMOVED, user)
        removed.append(str(rid))
    for m in adding:
        if m.id in current:
            continue
        event.machines.append(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=m.id))
        if m.id not in moved_ids:
            record_change(db, tenant_id, event.id, m.id, CHANGE_ADDED, user)
        added.append(str(m.id))
    if added or removed or moved:
        event.updated_at = datetime.now(timezone.utc)
    db.flush()
    return {"added": added, "removed": removed, "moved": moved}


def till_changes(
    db: Session, event: ReportEvent, limit: int = 200, *, user: Optional[User] = None, tenant_id=None,
) -> List[Dict[str, Any]]:
    """
    The event's till history, newest first. Who: the username only, never an email. The other
    event of a move: named only when the caller (`user`) can see its shop.
    """
    rows = (
        db.query(ReportEventMachineChange)
        .filter(ReportEventMachineChange.event_id == event.id, ReportEventMachineChange.tenant_id == event.tenant_id)
        .order_by(ReportEventMachineChange.created_at.desc(), ReportEventMachineChange.id)
        .limit(limit)
        .all()
    )
    ids = {r.machine_id for r in rows}
    names = {m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all()} if ids else {}
    user_ids = {r.user_id for r in rows if r.user_id}
    # A username that is itself an email address is not shown either.
    users = {u.id: (u.username if u.username and "@" not in u.username else None)
             for u in db.query(User).filter(User.id.in_(list(user_ids))).all()} if user_ids else {}
    others = {r.other_event_id for r in rows if r.other_event_id}
    visible: Dict[uuid.UUID, bool] = {}
    if others:
        shop_of = {e.id: e.shop_id for e in db.query(ReportEvent).filter(ReportEvent.id.in_(list(others))).all()}
        for oid in others:
            sid = shop_of.get(oid)
            if sid is None:
                visible[oid] = False          # deleted: its shop is unknown
            elif sid == event.shop_id or user is None:
                visible[oid] = True
            else:
                try:
                    load_shop(db, user, tenant_id if tenant_id is not None else event.tenant_id, sid, write=False)
                    visible[oid] = True
                except HTTPException:
                    visible[oid] = False
    return [
        {
            "machineId": str(r.machine_id), "machineName": names.get(r.machine_id), "action": r.action,
            "otherEventId": str(r.other_event_id) if r.other_event_id and visible.get(r.other_event_id) else None,
            "otherEventName": r.other_event_name if r.other_event_id and visible.get(r.other_event_id) else None,
            "by": users.get(r.user_id), "at": iso(r.created_at),
        }
        for r in rows
    ]


# ── Create / update / delete ─────────────────────────────────────────────────


def _name(value: Any) -> str:
    name = " ".join(str(value or "").split())
    if not name:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_name", "חובה לתת לאירוע שם")
    return name[:NAME_MAX]


def _optional_text(value: Any, limit: Optional[int] = None) -> Optional[str]:
    text = (str(value).strip() if value is not None else "") or None
    return text[:limit] if text and limit else text


def create_event(db: Session, user: User, tenant_id, body) -> ReportEvent:
    shop = load_shop(db, user, tenant_id, body.shop_id, write=True)
    starts, ends, tz_name = resolve_window(db, tenant_id, body.start_date, body.start_time, body.end_date, body.end_time)
    machines = validate_machines(db, shop, body.machine_ids)
    move_ids = parse_ids(getattr(body, "move_machine_ids", None))
    _check_moves(move_ids, {m.id for m in machines})
    event_id, name = uuid.uuid4(), _name(body.name)
    moving = [m for m in machines if m.id in move_ids]
    sources = lock_assignment(db, user, tenant_id, event_id, machines, moving, starts, ends)
    moved = move_tills(db, user, tenant_id, (event_id, name), moving, starts, ends, sources)
    assert_no_overlap(db, tenant_id, machines, starts, ends)
    moved_ids = {uuid.UUID(m["machineId"]) for m in moved}
    event = ReportEvent(
        id=event_id,
        tenant_id=tenant_id,
        company_id=shop.company_id,
        shop_id=shop.id,
        name=name,
        starts_at=starts,
        ends_at=ends,
        timezone=tz_name,
        status=EVENT_DRAFT,
        producer_name=_optional_text(body.producer_name, 120),
        notes=_optional_text(body.notes),
        thresholds=R.normalize_thresholds(body.thresholds),
        created_by_user_id=user.id,
    )
    db.add(event)
    db.flush()
    for m in machines:
        db.add(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=m.id))
        if m.id not in moved_ids:
            record_change(db, tenant_id, event.id, m.id, CHANGE_ADDED, user)
    db.flush()
    db.refresh(event)
    return event


def update_event(db: Session, user: User, tenant_id, event: ReportEvent, body) -> ReportEvent:
    # Under the event's lock, re-read: a window edit and an assignment of the same event serialise.
    event = lock_event(db, event)
    _require_draft(event)
    fields = body.model_fields_set
    shop = load_shop(db, user, tenant_id, event.shop_id, write=True)
    if fields & {"start_date", "start_time", "end_date", "end_time"}:
        tz = zone(event.timezone)
        s_local, e_local = utc(event.starts_at).astimezone(tz), utc(event.ends_at).astimezone(tz)
        starts, ends, tz_name = resolve_window(
            db, tenant_id,
            body.start_date if "start_date" in fields else s_local.date(),
            body.start_time if "start_time" in fields else s_local.strftime("%H:%M"),
            body.end_date if "end_date" in fields else e_local.date(),
            body.end_time if "end_time" in fields else e_local.strftime("%H:%M"),
        )
        event.starts_at, event.ends_at, event.timezone = starts, ends, tz_name
    if "machine_ids" in fields and body.machine_ids is not None:
        machines = validate_machines(db, shop, body.machine_ids)
    else:
        ids = [r.machine_id for r in event.machines]
        machines = db.query(POSMachine).filter(POSMachine.id.in_(ids)).all() if ids else []
    move_ids = parse_ids(getattr(body, "move_machine_ids", None))
    _check_moves(move_ids, {m.id for m in machines})
    name = _name(body.name) if "name" in fields else event.name
    moving = [m for m in machines if m.id in move_ids]
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    sources = lock_assignment(db, user, tenant_id, event.id, machines, moving, starts, ends)
    moved = move_tills(db, user, tenant_id, (event.id, name), moving, starts, ends, sources)
    moved_ids = {uuid.UUID(m["machineId"]) for m in moved}
    assert_no_overlap(db, tenant_id, machines, utc(event.starts_at), utc(event.ends_at), event.id)
    if "machine_ids" in fields and body.machine_ids is not None:
        wanted = {m.id for m in machines}
        for row in list(event.machines):
            if row.machine_id not in wanted:
                event.machines.remove(row)
                record_change(db, tenant_id, event.id, row.machine_id, CHANGE_REMOVED, user)
        have = {r.machine_id for r in event.machines}
        for m in machines:
            if m.id not in have:
                event.machines.append(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=m.id))
                if m.id not in moved_ids:
                    record_change(db, tenant_id, event.id, m.id, CHANGE_ADDED, user)
    if "name" in fields:
        event.name = _name(body.name)
    if "producer_name" in fields:
        event.producer_name = _optional_text(body.producer_name, 120)
    if "notes" in fields:
        event.notes = _optional_text(body.notes)
    if "thresholds" in fields:
        merged = {**R.normalize_thresholds(event.thresholds), **(body.thresholds or {})}
        event.thresholds = R.normalize_thresholds(merged)
    event.updated_at = datetime.now(timezone.utc)
    db.flush()
    db.refresh(event)
    return event


def delete_event(db: Session, event: ReportEvent) -> None:
    event = lock_event(db, event)
    _require_draft(event)
    db.delete(event)
    db.flush()


# ── List ──────────────────────────────────────────────────────────────────────


def list_events(db: Session, user: User, tenant_id, *, shop_id=None, status_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    q = db.query(ReportEvent).filter(ReportEvent.tenant_id == tenant_id)
    if shop_id is not None:
        load_shop(db, user, tenant_id, shop_id, write=False)
        q = q.filter(ReportEvent.shop_id == shop_id)
    if status_filter:
        q = q.filter(ReportEvent.status == status_filter)
    events = q.order_by(ReportEvent.starts_at.desc()).limit(500).all()
    allowed: Dict[Any, bool] = {}
    out = []
    for e in events:
        if e.shop_id not in allowed:
            try:
                load_shop(db, user, tenant_id, e.shop_id, write=False)
                allowed[e.shop_id] = True
            except HTTPException:
                allowed[e.shop_id] = False
        if not allowed[e.shop_id]:
            continue
        block = event_block(db, e)
        summary = None
        if e.status == EVENT_CONFIRMED and e.snapshot:
            k = e.snapshot.get("kpis") or {}
            summary = {key: k.get(key) for key in ("net", "salesCount", "avgTicket", "tips", "activeTills")}
            summary["alerts"] = sum(1 for i in e.snapshot.get("insights") or [] if i.get("level") == "alert")
        out.append({**block, "summary": summary})
    return out


# ── Confirm ("נותן תוקף") ─────────────────────────────────────────────────────


def confirm_event(
    db: Session, user: User, tenant_id, event: ReportEvent, *, force: bool, note: Optional[str],
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    # Under the event's lock: no till joins or leaves while the report is frozen and released.
    event = lock_event(db, event)
    _require_draft(event)
    load_shop(db, user, tenant_id, event.shop_id, write=True)
    now = utc(now) or datetime.now(timezone.utc)
    report = build_report(db, event, now=now)
    blocking = report["readiness"]["blocking"]
    if any(b["code"] == "no_tills" for b in blocking) or (blocking and not force):
        raise _error(
            status.HTTP_409_CONFLICT, "event_not_ready",
            "לא ניתן לאשר את האירוע: " + " ".join(b["text"] for b in blocking),
            readiness=report["readiness"],
        )
    event.status = EVENT_CONFIRMED
    event.confirmed_at = now
    event.confirmed_by_user_id = user.id
    event.confirm_note = _optional_text(note) or (
        "אושר לפני סוף האירוע" if any(b["code"] == "not_ended" for b in blocking) else None
    )
    for row in event.machines:
        if row.released_at is None:
            row.released_at = now
    db.flush()
    report["event"] = event_block(db, event)
    report["frozen"] = True
    report["confirmedAt"] = iso(now)
    event.snapshot = report
    db.flush()
    return report


# ── Compare ───────────────────────────────────────────────────────────────────

COMPARE_MAX = 6


def compare_events(db: Session, user: User, tenant_id, ids: Sequence[Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Two or more events side by side: headline figures, per-till averages, top items."""
    from .report import report_for

    unique: List[Any] = []
    for i in ids:
        if i not in unique:
            unique.append(i)
    if not 2 <= len(unique) <= COMPARE_MAX:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_compare",
                     f"בחרו בין 2 ל-{COMPARE_MAX} אירועים להשוואה")
    out = []
    for ident in unique:
        event = load_event(db, user, tenant_id, ident)
        report = report_for(db, event, now=now)
        k = report["kpis"]
        active = [t for t in report["tills"] if t["documentsCount"]]
        per_till = (k["net"] / len(active)) if active else 0.0
        out.append({
            "event": report["event"],
            "frozen": bool(report.get("frozen")),
            "kpis": k,
            "perTill": {
                "avgNet": round(per_till, 2),
                "medianSalesPerHour": report.get("medianSalesPerHour"),
                "avgTicket": k["avgTicket"],
                "activeTills": len(active),
            },
            "tills": [
                {key: t.get(key) for key in ("machineId", "name", "net", "salesCount", "avgTicket", "salesPerHour",
                                             "sharePct", "tipPct", "weak", "idle", "noSales")}
                for t in report["tills"]
            ],
            "topItems": [
                {key: r.get(key) for key in ("key", "name", "quantity", "revenue", "sharePct")}
                for r in report["items"]["top"][:5]
            ],
            "byPayment": report["segments"]["byPayment"],
            "alerts": sum(1 for i in report["insights"] if i["level"] == "alert"),
            "warnings": sum(1 for i in report["insights"] if i["level"] == "warning"),
        })
    return {"events": out}
