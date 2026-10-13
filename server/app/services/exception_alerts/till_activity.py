"""
Tills that do not sell, watched live (P:/specs/push-more.md §B2) — the push category
"קופה כמעט לא מוכרת" (`till_low_sales`) carries both kinds.

* **"קופה כמעט לא מוכרת"** (`till_low_sales`, `scan_low_sales`): the insights' anomaly rule
  (app/services/insights/anomalies.py `rule_low_sales`) used to run only when someone read the
  cards (`GET /insights/anomalies`) — with no cockpit open, nothing was sent. Now the background
  pass runs the very same evaluation (`insights.service.anomalies`, today's window) every
  `LOW_SALES_EVERY` (10 minutes) for every open shop (a fiscal till with a shift open) and every
  live event (its window, its tills) — the thresholds by level (organization → company → shop →
  event, `insights.service.thresholds_for`). Its hook writes one entry per till and business day
  (app/services/exception_alerts/external.py), so the cockpit and the pass never alert twice.
* **"קופה לא מוכרת כשהאחרות מוכרות"** (`till_idle`, `scan_idle`) — the event report's live checks
  (app/services/report_events/rules.py "קופה שקטה" / "אין אף מכירה") at any moment: a till with an
  open shift — or a till of a live event — that sold nothing for `idleMinutes` (30), or nothing at
  all since its shift opened (the event began), while at least `minPeers` (2) other tills of its
  group (the shop's tills with a shift open, or the event's; kiosks against kiosks) sold within
  those minutes. An exception rule (off by default, per level on the till's chain). One row per
  streak (`till_idle:<till>:<the streak's start>`); closed by itself when the till sells again (or
  its shift closes, the event ends). A till of a live event is judged with the event's tills, not
  again with its shop's.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.report_event import ReportEvent
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.services.exception_alerts import watch as WT

logger = logging.getLogger(__name__)

IDLE = "till_idle"
LOW_SALES_EVERY = timedelta(minutes=10)
#: A shift opened longer ago than this is not today's trading (forgotten open).
SHIFT_MAX_AGE = timedelta(hours=18)

_last_low_sales: Dict[str, datetime] = {}


def reset() -> None:
    """Forget when the low-sales pass last ran (tests; a process restart does the same)."""
    _last_low_sales.clear()


# ── Shared reads ─────────────────────────────────────────────────────────────


def open_shifts(db: Session, now: datetime, tenants: Optional[Iterable[Any]] = None) -> Dict[Any, datetime]:
    """Per till with a shift open (opened in the last 18 hours): when its earliest open shift opened."""
    q = db.query(Shift.machine_id, func.min(Shift.opened_at)).filter(
        Shift.status == ShiftStatus.OPEN, Shift.opened_at > now - SHIFT_MAX_AGE, Shift.opened_at <= now,
    )
    if tenants is not None:
        q = q.filter(Shift.tenant_id.in_(list(tenants)))
    return {m: WT.utc(at) for m, at in q.group_by(Shift.machine_id).all()}


def live_events(db: Session, now: datetime, tenants: Optional[Iterable[Any]] = None) -> List[ReportEvent]:
    q = db.query(ReportEvent).filter(ReportEvent.starts_at <= now, ReportEvent.ends_at > now)
    if tenants is not None:
        q = q.filter(ReportEvent.tenant_id.in_(list(tenants)))
    return q.order_by(ReportEvent.starts_at).all()


def last_sales(db: Session, machine_ids: Iterable[Any], since: datetime, now: datetime) -> Dict[Any, datetime]:
    """Per till, its last sale (not a credit note) in [since, now]."""
    from app.services.dashboard_stats import SALE_STATUSES
    from app.services.tenders import sale_condition

    ids = [m for m in machine_ids if m is not None]
    if not ids:
        return {}
    rows = (
        db.query(Transaction.machine_id, func.max(Transaction.created_at))
        .filter(
            Transaction.machine_id.in_(ids), Transaction.created_at >= since, Transaction.created_at <= now,
            Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False), sale_condition(),
        )
        .group_by(Transaction.machine_id)
        .all()
    )
    return {m: WT.utc(at) for m, at in rows if at is not None}


# ── "קופה כמעט לא מוכרת" in the background ───────────────────────────────────


def _system_user(tenant_id):
    """The reads' scoping as the organization's own (never stored, never a session's)."""
    from app.models.user import User, UserRole

    return User(id=None, role=UserRole.SUPER_ADMIN, tenant_id=tenant_id, is_active=True)


def low_sales_due(now: datetime, key: str = "all") -> bool:
    last = _last_low_sales.get(key)
    return last is None or now - last >= LOW_SALES_EVERY - timedelta(seconds=5)


def scan_low_sales(db: Session, *, now: Optional[datetime] = None, force: bool = False) -> int:
    """
    Every 10 minutes: the insights' anomaly evaluation of today, for each open shop and each live
    event, through its alert hook. Returns how many low-sales cards were reported (their entries
    are deduplicated per till and day). The hook commits what it writes.
    """
    from app.services.insights import service as S
    from app.services.insights.data import InsightScope, _as_dt

    now = WT.utc(now) or datetime.now(timezone.utc)
    if not force and not low_sales_due(now):
        return 0
    _last_low_sales["all"] = now
    reported = 0
    shifts = open_shifts(db, now)
    shops: Dict[Any, Any] = {}
    if shifts:
        for machine in (
            db.query(POSMachine)
            .filter(POSMachine.id.in_(list(shifts)), POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
            .all()
        ):
            if machine.shop_id is not None:
                shops.setdefault(machine.shop_id, machine.tenant_id)
    clocks: Dict[Any, Any] = {}

    def clock_of(tenant_id):
        if tenant_id not in clocks:
            clocks[tenant_id] = S.make_clock(db, tenant_id, tz=None, day_start_hour=None, now=now)
        return clocks[tenant_id]

    # Live events first: a till of one is reported with its event (the entry names it).
    for event in live_events(db, now):
        try:
            clock = clock_of(event.tenant_id)
            machine_ids = tuple(row.machine_id for row in event.machines)
            if len(machine_ids) < 2:
                continue
            starts, ends = _as_dt(event.starts_at), _as_dt(event.ends_at)
            scope = InsightScope(user=_system_user(event.tenant_id), tenant_id=event.tenant_id, shop_id=event.shop_id,
                                 machine_ids=machine_ids, window_start=starts, window_end=ends, event=event)
            ctx = S.InsightsContext(db, scope, clock, S.event_period(clock, starts, ends))
            out = S.anomalies(ctx, "period")
            reported += sum(1 for c in out["cards"] if c.get("type") == "till_low_sales")
        except Exception:  # noqa: BLE001 - one event never stops the others
            db.rollback()
            logger.exception("till_low_sales: event %s failed", event.id)
    for shop_id, tenant_id in shops.items():
        shop = db.get(Shop, shop_id)
        if shop is None or not shop.is_active or shop.training_mode:
            continue
        fiscal = (
            db.query(func.count(POSMachine.id))
            .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
            .scalar()
        )
        if int(fiscal or 0) < 2:
            continue  # nothing to compare with
        try:
            clock = clock_of(tenant_id)
            scope = InsightScope(user=_system_user(tenant_id), tenant_id=tenant_id, shop_id=shop_id)
            ctx = S.InsightsContext(db, scope, clock, S.resolve_period(clock, None, None, 7))
            out = S.anomalies(ctx, "today")
            reported += sum(1 for c in out["cards"] if c.get("type") == "till_low_sales")
        except Exception:  # noqa: BLE001 - one shop never stops the others
            db.rollback()
            logger.exception("till_low_sales: shop %s failed", shop_id)
    return reported


# ── "קופה לא מוכרת כשהאחרות מוכרות" ──────────────────────────────────────────


@dataclass
class Group:
    """Tills judged together: a shop's with a shift open, or a live event's — one kind (kiosks apart)."""

    key: str
    since: Dict[Any, datetime]
    event: Any = None
    members: List[POSMachine] = field(default_factory=list)
    #: The members judged here (a shop's till of a live event is judged with the event's): None = all.
    judged: Optional[Set[Any]] = None


def _groups(db: Session, now: datetime, tenants: Set[Any]) -> List[Group]:
    groups: List[Group] = []
    taken: Set[Any] = set()
    events = live_events(db, now, tenants)
    machine_ids: Set[Any] = set()
    for event in events:
        machine_ids.update(row.machine_id for row in event.machines)
    shifts = open_shifts(db, now, tenants)
    machine_ids.update(shifts)
    if not machine_ids:
        return groups
    machines = {
        m.id: m for m in db.query(POSMachine)
        .filter(POSMachine.id.in_(list(machine_ids)), POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
        .all()
    }
    kiosks = WT.kiosk_ids(db, list(machines))
    for event in events:
        start = WT.utc(event.starts_at)
        members = [machines[row.machine_id] for row in event.machines if row.machine_id in machines]
        for kiosk in (False, True):
            part = [m for m in members if (m.id in kiosks) == kiosk]
            if len(part) >= 2:
                groups.append(Group(key=f"event:{event.id}:{int(kiosk)}", since={m.id: start for m in part},
                                    event=event, members=part))
        taken.update(m.id for m in members)
    by_shop: Dict[Tuple[Any, bool], List[POSMachine]] = defaultdict(list)
    for machine_id in shifts:
        m = machines.get(machine_id)
        if m is None or m.shop_id is None:
            continue
        by_shop[(m.shop_id, m.id in kiosks)].append(m)
    for (shop_id, kiosk), part in by_shop.items():
        if len(part) >= 2:
            groups.append(Group(key=f"shop:{shop_id}:{int(kiosk)}", since={m.id: shifts[m.id] for m in part},
                                members=part, judged={m.id for m in part if m.id not in taken}))
    return groups


def scan_idle(db: Session, *, now: Optional[datetime] = None) -> int:
    """One pass: idle tills recorded (once per streak), tills selling again closed. Caller commits."""
    now = WT.utc(now) or datetime.now(timezone.utc)
    zones = WT.Zones(db)
    changed = 0
    tenants = WT.enabled_tenants(db, IDLE)
    shops: Dict[Any, Optional[Shop]] = {}
    for group in (_groups(db, now, tenants) if tenants else []):
        earliest = min(group.since.values())
        last = last_sales(db, [m.id for m in group.members], earliest, now)
        for till in group.members:
            if group.judged is not None and till.id not in group.judged:
                continue
            rule = WT.machine_rule(db, till, IDLE)
            if rule is None:
                continue
            idle = int(WT.param(rule, "idleMinutes", 30))
            min_peers = int(WT.param(rule, "minPeers", 2))
            start = group.since[till.id]
            sold = last.get(till.id)
            streak = sold if sold is not None and sold >= start else start
            if now - streak < timedelta(minutes=idle):
                continue
            selling = [p for p in group.members if p.id != till.id and last.get(p.id) is not None
                       and now - last[p.id] <= timedelta(minutes=idle)]
            if len(selling) < min_peers:
                continue
            key = f"{IDLE}:{till.id}:{streak.strftime('%Y%m%dT%H%M%S')}"
            if WT.find(db, key) is not None:
                continue
            if till.shop_id not in shops:
                shops[till.shop_id] = db.get(Shop, till.shop_id) if till.shop_id else None
            shop = shops[till.shop_id]
            zone_name = zones.name(till.tenant_id)
            minutes = (now - streak).total_seconds() / 60
            name = WT.till_label(till)
            if sold is not None and sold >= start:
                what = f"{name} לא מכרה {WT.minutes_text(minutes)} (מכירה אחרונה {WT.hhmm(sold, zone_name)})"
                kind = "gap"
            else:
                since_what = "תחילת האירוע" if group.event is not None else "פתיחת המשמרת"
                what = f"{name} לא מכרה כלל מאז {since_what} ({WT.minutes_text(minutes)})"
                kind = "no_sales"
            summary = f"{what} — {len(selling)} קופות אחרות מוכרות"
            if group.event is not None:
                summary += f" · {group.event.name}"
            row = WT.write(
                db, exception_type=IDLE, dedupe_key=key, occurred_at=streak + timedelta(minutes=idle), now=now,
                severity="medium", tenant_id=till.tenant_id, company_id=shop.company_id if shop else None,
                shop_id=till.shop_id, area_id=till.area_id, machine_id=till.id,
                value=round(minutes, 2), threshold=idle,
                details={
                    "summary": summary,
                    "kind": kind,
                    "since": streak.isoformat(),
                    "lastSaleAt": sold.isoformat() if sold is not None and sold >= start else None,
                    "peersSelling": len(selling),
                    "peers": [WT.till_label(p) for p in selling][:10],
                    "eventId": str(group.event.id) if group.event is not None else None,
                    "eventEndsAt": WT.utc(group.event.ends_at).isoformat() if group.event is not None else None,
                    "group": group.key,
                },
            )
            if row is not None:
                changed += 1
    changed += _close_idle(db, now, zones)
    db.flush()
    return changed


def _close_idle(db: Session, now: datetime, zones: WT.Zones) -> int:
    changed = 0
    rows = WT.open_rows(db, IDLE, now=now, days=2)
    if not rows:
        return 0
    shifts = open_shifts(db, now)
    for row in rows:
        details = row.details or {}
        since = WT.parse_iso(details.get("since"))
        if row.machine_id is None or since is None:
            continue
        sold = last_sales(db, [row.machine_id], since + timedelta(seconds=1), now).get(row.machine_id)
        zone_name = zones.name(row.tenant_id)
        if sold is not None:
            ok = WT.resolve(row, now=now, at=sold, why=f"הקופה חזרה למכור ב-{WT.hhmm(sold, zone_name)}",
                            extra={"backAt": sold.isoformat()})
        elif details.get("eventId"):
            ends = WT.parse_iso(details.get("eventEndsAt"))
            ok = ends is not None and now >= ends and WT.resolve(row, now=now, at=ends, why="האירוע הסתיים")
        else:
            ok = row.machine_id not in shifts and WT.resolve(row, now=now, why="המשמרת נסגרה")
        if ok:
            changed += 1
    return changed
