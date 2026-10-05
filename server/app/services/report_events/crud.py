"""
The event's life (docs/SPEC_EVENTS.md §1–§2): create / update / delete while draft, the
overlap rule, and the confirmation ("נותן תוקף") that freezes the report and releases the
tills. Nothing here writes to a till, a document, a shift or a Z.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.middleware.auth import ensure_same_tenant
from app.models.pos_machine import POSMachine
from app.models.report_event import EVENT_CONFIRMED, EVENT_DRAFT, ReportEvent, ReportEventMachine
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


def load_event(db: Session, user: User, tenant_id, event_id, *, write: bool = False) -> ReportEvent:
    try:
        ident = event_id if isinstance(event_id, uuid.UUID) else uuid.UUID(str(event_id))
    except (TypeError, ValueError):
        raise _error(status.HTTP_404_NOT_FOUND, "event_not_found", "האירוע לא נמצא")
    event = db.query(ReportEvent).filter(ReportEvent.id == ident).first()
    if event is None or event.tenant_id != tenant_id:
        raise _error(status.HTTP_404_NOT_FOUND, "event_not_found", "האירוע לא נמצא")
    load_shop(db, user, tenant_id, event.shop_id, write=write)
    return event


def _require_draft(event: ReportEvent) -> None:
    if event.status != EVENT_DRAFT:
        raise _error(status.HTTP_409_CONFLICT, "event_confirmed", "האירוע אושר ונעול לעריכה")


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
    """The shop's active tills, plus any named (an inactive till already in the event)."""
    rows = db.query(POSMachine).filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True)).all()
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
    shop = load_shop(db, user, tenant_id, shop_id, write=False)
    tills = shop_tills(db, shop)
    busy = busy_tills(db, tenant_id, [m.id for m in tills], *window, exclude_event_id) if window else {}
    from app.models.shop_area import ShopArea

    area_ids = {m.area_id for m in tills if m.area_id}
    areas = {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).all()} if area_ids else {}
    return {
        "shopId": str(shop.id),
        "tills": [
            {
                "id": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "areaName": areas.get(m.area_id) if m.area_id else None,
                "lastHeartbeatAt": iso(m.last_heartbeat_at),
                "busy": (
                    {"eventId": str(busy[m.id].id), "eventName": busy[m.id].name,
                     "startsAt": iso(busy[m.id].starts_at), "endsAt": iso(busy[m.id].ends_at)}
                    if m.id in busy else None
                ),
            }
            for m in tills
        ],
    }


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
    assert_no_overlap(db, tenant_id, machines, starts, ends)
    event = ReportEvent(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=shop.company_id,
        shop_id=shop.id,
        name=_name(body.name),
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
    db.flush()
    db.refresh(event)
    return event


def update_event(db: Session, user: User, tenant_id, event: ReportEvent, body) -> ReportEvent:
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
    assert_no_overlap(db, tenant_id, machines, utc(event.starts_at), utc(event.ends_at), event.id)
    if "machine_ids" in fields and body.machine_ids is not None:
        wanted = {m.id for m in machines}
        for row in list(event.machines):
            if row.machine_id not in wanted:
                db.delete(row)
        have = {r.machine_id for r in event.machines}
        for m in machines:
            if m.id not in have:
                db.add(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=m.id))
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
