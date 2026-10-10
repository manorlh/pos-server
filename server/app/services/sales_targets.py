"""
"יעדים ותחרות" — sales targets per shop, point of sale and cashier, for a day or an event, their
progress with the pace forecast, the till's leaderboard, and the "יעד הושג" alert.

* **A target** (`sales_targets`): `period = "day"` — every day (`day` NULL), or one date (beats the
  every-day target of the same scope that day); `period = "event"` — the window of an event, its
  tills only. `scope`: the shop, one point of sale (the area each document's shift was stamped
  with — as the sales-by-area report), or one cashier (`transactions.cashier_id`).
* **The money** is the per-cashier report's net (gross − discounts − refunds, reports.py
  `_sales_buckets`), the documents a report counts (SALE_STATUSES, no duplicate copies), in the
  shop's local day (its report zone).
* **The pace** — "בקצב הנוכחי: ₪X עד סוף היום": today's net spread over the trading hours elapsed
  (`day_start`–`day_end`, local, default 08:00–23:00): net ÷ the elapsed fraction; nothing before 5%
  of the day has passed (too early to say), the net itself once the day is over. An event: its window.
* **Reached** — once per target and period (`sales_target_hits`, unique): written on the first
  progress read past the amount (the board, the till's leaderboard) and by the background pass every
  few minutes; the exceptions log records it as "יעד הושג" (`target_reached`), so an SMS rule may send it.
* **The till's leaderboard** — till parameters `leaderboardEnabled` (default off) and
  `leaderboardMetric` ("מכירות" — today's net; "פריטי אפסייל" — lines added by an upsell): the shop's
  cashiers today, ranked, and the shop's target progress.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.sales_target import TARGET_PERIODS, TARGET_SCOPES, SalesTarget, SalesTargetHit
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.services import block_durations

logger = logging.getLogger(__name__)

PARAM_ENABLED = "leaderboardEnabled"
PARAM_METRIC = "leaderboardMetric"
METRIC_SALES = "מכירות"
METRIC_UPSELL = "פריטי אפסייל"
MIN_PACE_FRACTION = 0.05
DEFAULT_DAY_START = "08:00"
DEFAULT_DAY_END = "23:00"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dec(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ── The pace, pure ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Pace:
    fraction: float
    forecast: Optional[Decimal]


def pace(actual: Decimal, start: datetime, end: datetime, now: datetime) -> Pace:
    """The share of the trading window elapsed, and the net it points to by the window's end."""
    total = (end - start).total_seconds()
    if total <= 0:
        return Pace(1.0, actual)
    fraction = min(max((now - start).total_seconds() / total, 0.0), 1.0)
    if fraction >= 1.0:
        return Pace(1.0, actual)
    if fraction < MIN_PACE_FRACTION:
        return Pace(fraction, None)
    return Pace(fraction, (actual / Decimal(str(fraction))).quantize(Decimal("0.01")))


def day_window(day: date, start: str, end: str, zone_name: str) -> Tuple[datetime, datetime]:
    """The trading window of `day` (local HH:MM → UTC); an end at or before the start runs past midnight."""
    zone = block_durations.zone_of(zone_name)
    s = block_durations.parse_hhmm(start) or block_durations.parse_hhmm(DEFAULT_DAY_START)
    e = block_durations.parse_hhmm(end) or block_durations.parse_hhmm(DEFAULT_DAY_END)
    a = block_durations._local_at(day, s, zone)
    b = block_durations._local_at(day, e, zone)
    if b <= a:
        b = block_durations._local_at(day + timedelta(days=1), e, zone)
    return a, b


def calendar_day(day: date, zone_name: str) -> Tuple[datetime, datetime]:
    zone = block_durations.zone_of(zone_name)
    a = datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)
    b = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone).astimezone(timezone.utc)
    return a, b


def trading_range(day: date, start: str, end: str, zone_name: str) -> Tuple[datetime, datetime]:
    """
    The money a day target counts: the business day (04:00 to 04:00, as blocks, the reset and
    insights), stretched to the trading window's end when the window runs past 04:00, and starting
    where the previous day's window ended — so a night's sales count once, in the day that began
    them: [max(D 04:00, end of D−1's window), max(D+1 04:00, end of D's window)).
    """
    a, b = business_day_range(day, zone_name)
    previous_end = day_window(day - timedelta(days=1), start, end, zone_name)[1]
    return max(a, previous_end), max(b, day_window(day, start, end, zone_name)[1])


def business_day_range(day: date, zone_name: str) -> Tuple[datetime, datetime]:
    """The business day `day`: from its 04:00 to the next day's 04:00 (local, DST-safe) — the day
    boundary of targets, blocks, the reset and insights alike."""
    zone = block_durations.zone_of(zone_name)
    start = block_durations.parse_hhmm(block_durations.business_day_start())
    return (
        block_durations._local_at(day, start, zone),
        block_durations._local_at(day + timedelta(days=1), start, zone),
    )


def still_open_from(day: date, start: str, end: str, zone_name: str, now: datetime) -> bool:
    """`day`'s trading window runs past the business day's end (04:00) and has not ended yet."""
    _a, b = business_day_range(day, zone_name)
    window_end = day_window(day, start, end, zone_name)[1]
    return window_end > b and now < window_end


def business_today(zone_name: str, now: Optional[datetime] = None) -> date:
    """Today's business day (it starts at 04:00, as blocks, the reset and insights)."""
    return block_durations.business_today(now or utc_now(), zone_name)


def local_today(zone_name: str, now: Optional[datetime] = None) -> date:
    return (now or utc_now()).astimezone(block_durations.zone_of(zone_name)).date()


# ── The money ────────────────────────────────────────────────────────────────


def _base_query(db: Session, tenant_id: Any, shop_id: Any, start: datetime, end: datetime, machine_ids: Optional[Sequence[Any]] = None):
    from app.services.dashboard_stats import SALE_STATUSES

    q = db.query(Transaction).filter(
        Transaction.tenant_id == tenant_id,
        Transaction.shop_id == shop_id,
        Transaction.created_at >= start,
        Transaction.created_at < end,
        Transaction.status.in_(SALE_STATUSES),
        Transaction.duplicate_copy.is_(False),
    )
    if machine_ids is not None:
        q = q.filter(Transaction.machine_id.in_(list(machine_ids) or [uuid.uuid4()]))
    return q


def net_by(db: Session, q, key, joins=()) -> Dict[Any, Decimal]:
    from app.services.reports import _sales_buckets

    out: Dict[Any, Decimal] = {}
    for k, b in _sales_buckets(q, key, joins=joins).items():
        out[k] = _dec(b["gross"]) - _dec(b["discounts"]) - _dec(b["refunds"])
    return out


def actual_of(db: Session, target: SalesTarget, start: datetime, end: datetime, machine_ids=None) -> Decimal:
    q = _base_query(db, target.tenant_id, target.shop_id, start, end, machine_ids)
    if target.scope == "cashier":
        q = q.filter(Transaction.cashier_id == str(target.pos_user_id))
    elif target.scope == "area":
        q = q.join(Shift, Shift.id == Transaction.shift_id).filter(Shift.area_id == target.area_id)
    rows = net_by(db, q, Transaction.shop_id)
    return sum(rows.values(), Decimal("0")).quantize(Decimal("0.01"))


# ── Which targets apply ──────────────────────────────────────────────────────


def _zone_for(db: Session, tenant_id: Any) -> str:
    from app.services.reports import resolve_report_timezone

    return resolve_report_timezone(db, tenant_id, None)


def targets_for(db: Session, shop_ids: Sequence[Any], day: date, *, include_events: bool = True, now: Optional[datetime] = None) -> List[SalesTarget]:
    """The day's targets of these shops (a dated one beats the every-day one of its scope) and live events'."""
    now = now or utc_now()
    ids = [s for s in shop_ids if s is not None]
    if not ids:
        return []
    rows = (
        db.query(SalesTarget)
        .filter(SalesTarget.shop_id.in_(ids), SalesTarget.archived_at.is_(None))
        .all()
    )
    day_rows = [r for r in rows if r.period == "day" and (r.day is None or r.day == day)]
    chosen: Dict[Tuple[Any, str, Any, Any], SalesTarget] = {}
    for r in sorted(day_rows, key=lambda r: r.day is not None):
        chosen[(r.shop_id, r.scope, r.area_id, r.pos_user_id)] = r
    out = list(chosen.values())
    if include_events:
        events = {
            e.id: e for e in db.query(ReportEvent).filter(
                ReportEvent.id.in_([r.event_id for r in rows if r.period == "event" and r.event_id])
            ).all()
        } if any(r.period == "event" for r in rows) else {}
        for r in rows:
            e = events.get(r.event_id) if r.period == "event" else None
            if e is not None and _aware(e.starts_at) <= now + timedelta(hours=12) and _aware(e.ends_at) >= now - timedelta(hours=12):
                out.append(r)
    return out


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── Progress ─────────────────────────────────────────────────────────────────


def label_of(db: Session, target: SalesTarget) -> str:
    if target.name:
        return target.name
    if target.scope == "area" and target.area_id:
        area = db.get(ShopArea, target.area_id)
        return f"יעד {area.name}" if area else "יעד נקודת מכירה"
    if target.scope == "cashier" and target.pos_user_id:
        from app.services.reports import _display_name, _load_cashier_names

        names = _load_cashier_names(db, [str(target.pos_user_id)])
        return f"יעד {_display_name(names.get(str(target.pos_user_id))) or 'עובד'}"
    shop = db.get(Shop, target.shop_id)
    return f"יעד {shop.name}" if shop else "יעד הסניף"


def progress_of(db: Session, target: SalesTarget, *, now: Optional[datetime] = None, day: Optional[date] = None) -> Dict[str, Any]:
    """One target's progress now; records the hit when reached (the caller commits)."""
    now = now or utc_now()
    zone = _zone_for(db, target.tenant_id)
    machine_ids = None
    if target.period == "event" and target.event_id:
        event = db.get(ReportEvent, target.event_id)
        if event is None:
            raise _bad("event_not_found", "האירוע לא נמצא", status.HTTP_404_NOT_FOUND)
        start, end = _aware(event.starts_at), _aware(event.ends_at)
        window = (start, end)
        machine_ids = [r[0] for r in db.query(ReportEventMachine.machine_id).filter(ReportEventMachine.event_id == event.id).all()]
        period_key = str(event.id)
    else:
        day = day or business_today(zone, now)
        d_start, d_end = target.day_start or DEFAULT_DAY_START, target.day_end or DEFAULT_DAY_END
        start, end = trading_range(day, d_start, d_end, zone)
        window = day_window(day, d_start, d_end, zone)
        period_key = day.isoformat()
    actual = actual_of(db, target, start, end, machine_ids)
    amount = _dec(target.amount)
    p = pace(actual, window[0], window[1], now)
    reached = amount > 0 and actual >= amount
    hit = None
    if reached:
        hit = record_hit(db, target, period_key, actual, now=now)
    return {
        "targetId": str(target.id),
        "label": label_of(db, target),
        "scope": target.scope,
        "areaId": str(target.area_id) if target.area_id else None,
        "posUserId": str(target.pos_user_id) if target.pos_user_id else None,
        "shopId": str(target.shop_id),
        "period": target.period,
        "periodKey": period_key,
        "amount": float(amount),
        "actual": float(actual),
        "percent": round(float(actual / amount * 100), 1) if amount > 0 else None,
        "forecast": float(p.forecast) if p.forecast is not None else None,
        "forecastReaches": (p.forecast >= amount) if p.forecast is not None and amount > 0 else None,
        "elapsed": round(p.fraction, 3),
        "windowStart": window[0].isoformat(),
        "windowEnd": window[1].isoformat(),
        "reached": reached,
        "reachedAt": _aware(hit.reached_at).isoformat() if hit is not None and hit.reached_at else None,
    }


def record_hit(db: Session, target: SalesTarget, period_key: str, actual: Decimal, *, now: Optional[datetime] = None) -> Optional[SalesTargetHit]:
    """"יעד הושג", once per target and period (a race loses quietly to the unique key)."""
    existing = (
        db.query(SalesTargetHit)
        .filter(SalesTargetHit.target_id == target.id, SalesTargetHit.period_key == period_key)
        .first()
    )
    if existing is not None:
        return existing
    now = now or utc_now()
    shop = db.get(Shop, target.shop_id)
    hit = SalesTargetHit(
        id=uuid.uuid4(), tenant_id=target.tenant_id, target_id=target.id,
        company_id=shop.company_id if shop is not None else None, shop_id=target.shop_id,
        area_id=target.area_id, pos_user_id=target.pos_user_id, period_key=period_key,
        amount=_dec(target.amount), actual=actual, label=label_of(db, target), reached_at=now, created_at=now,
    )
    savepoint = db.begin_nested()
    try:
        db.add(hit)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        return db.query(SalesTargetHit).filter(SalesTargetHit.target_id == target.id, SalesTargetHit.period_key == period_key).first()
    savepoint.commit()
    return hit


def current_targets(db: Session, shop_ids: Sequence[Any], *, now: Optional[datetime] = None) -> List[Tuple[SalesTarget, Optional[date]]]:
    """
    The targets in play now, each with its trading day: today's, except a day target whose
    yesterday's window runs past midnight and is still open — that one is still yesterday's.
    """
    now = now or utc_now()
    if not shop_ids:
        return []
    first = db.get(Shop, shop_ids[0])
    zone = _zone_for(db, first.tenant_id) if first is not None else block_durations.DEFAULT_ZONE
    today = business_today(zone, now)
    yesterday = today - timedelta(days=1)

    def key(t: SalesTarget) -> Tuple[Any, str, Any, Any]:
        return (t.shop_id, t.scope, t.area_id, t.pos_user_id)

    picked: List[Tuple[SalesTarget, Optional[date]]] = []
    still_yesterday = set()
    for t in targets_for(db, shop_ids, yesterday, include_events=False, now=now):
        if still_open_from(yesterday, t.day_start or DEFAULT_DAY_START, t.day_end or DEFAULT_DAY_END, zone, now):
            picked.append((t, yesterday))
            still_yesterday.add(key(t))
    for t in targets_for(db, shop_ids, today, now=now):
        if t.period == "day" and key(t) in still_yesterday:
            continue
        picked.append((t, today if t.period == "day" else None))
    return picked


def progress(db: Session, shop_ids: Sequence[Any], *, day: Optional[date] = None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Progress now (each target on its trading day), or on a given day."""
    now = now or utc_now()
    if not shop_ids:
        return []
    if day is not None:
        pairs = [(t, day) for t in targets_for(db, shop_ids, day, now=now)]
    else:
        pairs = current_targets(db, shop_ids, now=now)
    out = [progress_of(db, t, now=now, day=d) for t, d in pairs]
    order = {"shop": 0, "area": 1, "cashier": 2}
    out.sort(key=lambda r: (r["period"] != "event", order.get(r["scope"], 3), r["label"]))
    return out


def event_target(db: Session, event: ReportEvent) -> Optional[SalesTarget]:
    """
    The event's own sales target — the shop's (`scope = "shop"`) target of `period = "event"` for this
    event, not archived (the latest changed when there are several). Area and cashier targets of an
    event are partial targets, not the event's. "מצב אירוע חי" reads it through
    app/services/report_events/targets.py, and its "הגדרת יעד" writes it (`set_event_target`).
    """
    return (
        db.query(SalesTarget)
        .filter(
            SalesTarget.event_id == event.id,
            SalesTarget.period == "event",
            SalesTarget.scope == "shop",
            SalesTarget.archived_at.is_(None),
        )
        .order_by(SalesTarget.updated_at.desc(), SalesTarget.created_at.desc())
        .first()
    )


def event_target_amount(db: Session, event: ReportEvent) -> Optional[Decimal]:
    target = event_target(db, event)
    return _dec(target.amount) if target is not None else None


def set_event_target(db: Session, event: ReportEvent, amount: Optional[Decimal], *, user: Any = None,
                     now: Optional[datetime] = None) -> Optional[SalesTarget]:
    """
    "הגדרת יעד" on the live screen: the event's shop target set to [amount] (made when missing, its
    fields validated like the targets page's), or archived when [amount] is None. Its "יעד הושג" is
    then this module's, like every target's (one alert source). The caller commits.
    """
    now = now or utc_now()
    current = event_target(db, event)
    if amount is None:
        if current is not None:
            current.archived_at = now
            db.flush()
        return None
    if current is not None:
        current.amount = amount
        current.updated_at = now
        db.flush()
        return current
    shop = db.get(Shop, event.shop_id)
    if shop is None:
        raise _bad("shop_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
    fields = validate(db, shop, {"scope": "shop", "period": "event", "eventId": str(event.id), "amount": str(amount)})
    row = SalesTarget(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id,
        created_by_user_id=getattr(user, "id", None), **fields,
    )
    db.add(row)
    db.flush()
    return row


def evaluate_due(db: Session, *, now: Optional[datetime] = None) -> int:
    """The background pass: today's targets of every shop that has any, their hits recorded. Commits."""
    now = now or utc_now()
    shop_ids = [r[0] for r in db.query(SalesTarget.shop_id).filter(SalesTarget.archived_at.is_(None)).distinct().all()]
    n = 0
    for sid in shop_ids:
        try:
            for row in progress(db, [sid], now=now):
                n += 1 if row["reached"] else 0
            db.commit()
        except Exception:  # noqa: BLE001 - one shop never stops the others
            db.rollback()
            logger.exception("sales targets pass failed for shop %s", sid)
    return n


# ── Writing ──────────────────────────────────────────────────────────────────


def validate(db: Session, shop: Shop, body: Dict[str, Any]) -> Dict[str, Any]:
    scope = body.get("scope") or "shop"
    period = body.get("period") or "day"
    if scope not in TARGET_SCOPES:
        raise _bad("invalid_scope", "היקף לא מוכר")
    if period not in TARGET_PERIODS:
        raise _bad("invalid_period", "תקופה לא מוכרת")
    amount = _dec(body.get("amount"))
    if amount <= 0:
        raise _bad("amount_must_be_positive", "היעד חייב להיות גדול מאפס")
    area_id = body.get("areaId")
    pos_user_id = body.get("posUserId")
    if scope == "area":
        area = db.get(ShopArea, uuid.UUID(str(area_id))) if area_id else None
        if area is None or area.shop_id != shop.id:
            raise _bad("invalid_area", "נקודת המכירה לא שייכת לסניף")
        area_id = area.id
    else:
        area_id = None
    if scope == "cashier":
        from app.models.pos_user import PosUser

        pu = db.get(PosUser, uuid.UUID(str(pos_user_id))) if pos_user_id else None
        if pu is None or (pu.shop_id is not None and pu.shop_id != shop.id) or (
            pu.tenant_id is not None and str(pu.tenant_id) != str(shop.tenant_id)
        ):
            raise _bad("invalid_cashier", "העובד לא שייך לסניף")
        pos_user_id = pu.id
    else:
        pos_user_id = None
    event_id = body.get("eventId")
    day = body.get("day")
    if period == "event":
        event = db.get(ReportEvent, uuid.UUID(str(event_id))) if event_id else None
        if event is None or event.shop_id != shop.id:
            raise _bad("invalid_event", "האירוע לא שייך לסניף")
        event_id, day = event.id, None
    else:
        event_id = None
        day = date.fromisoformat(day) if isinstance(day, str) and day else None
    for key in ("dayStart", "dayEnd"):
        if body.get(key) is not None and block_durations.parse_hhmm(body.get(key)) is None:
            raise _bad("invalid_time", "שעה בתבנית HH:MM")
    return {
        "scope": scope, "period": period, "amount": amount, "area_id": area_id, "pos_user_id": pos_user_id,
        "event_id": event_id, "day": day, "day_start": body.get("dayStart") or DEFAULT_DAY_START,
        "day_end": body.get("dayEnd") or DEFAULT_DAY_END, "name": (body.get("name") or "").strip()[:120] or None,
    }


def target_out(db: Session, t: SalesTarget) -> Dict[str, Any]:
    return {
        "id": str(t.id), "shopId": str(t.shop_id), "scope": t.scope, "period": t.period,
        "areaId": str(t.area_id) if t.area_id else None, "posUserId": str(t.pos_user_id) if t.pos_user_id else None,
        "eventId": str(t.event_id) if t.event_id else None, "day": t.day.isoformat() if t.day else None,
        "amount": float(t.amount), "dayStart": t.day_start, "dayEnd": t.day_end, "name": t.name,
        "label": label_of(db, t),
    }


# ── The till's leaderboard ───────────────────────────────────────────────────


def leaderboard(db: Session, machine: Any, *, metric: str = METRIC_SALES, now: Optional[datetime] = None, top: int = 5) -> Dict[str, Any]:
    """The shop's cashiers today by net sales (or upsell lines), and the shop's target progress."""
    from app.models.transaction_item import TransactionItem
    from app.services.reports import _display_name, _load_cashier_names

    now = now or utc_now()
    if machine.shop_id is None:
        return {"cashiers": [], "target": None, "metric": metric}
    zone = _zone_for(db, machine.tenant_id)
    # The shop's day target sets the trading day and its range (a window past midnight included).
    shop_day = next(((t, d) for t, d in current_targets(db, [machine.shop_id], now=now) if t.period == "day" and t.scope == "shop"), None)
    if shop_day is not None:
        target, day = shop_day
        start, end = trading_range(day, target.day_start or DEFAULT_DAY_START, target.day_end or DEFAULT_DAY_END, zone)
    else:
        day = business_today(zone, now)
        start, end = trading_range(day, DEFAULT_DAY_START, DEFAULT_DAY_END, zone)
    # "נעילת הקופה לנקודת המכירה שלה" (app/services/area_lock.py): a locked till ranks the cashiers
    # of its point of sale's tills, against that point of sale's day target (none: no target).
    from app.services import area_lock

    scope = area_lock.scope_for(db, machine)
    area_ids = sorted(area_lock.area_machine_ids(db, scope), key=str) if scope.locked else None
    q = _base_query(db, machine.tenant_id, machine.shop_id, start, end, machine_ids=area_ids)
    if metric == METRIC_UPSELL:
        rows = (
            q.join(TransactionItem, TransactionItem.transaction_id == Transaction.id)
            .filter(TransactionItem.upsell_rule_id.isnot(None))
            .with_entities(Transaction.cashier_id, func.coalesce(func.sum(TransactionItem.quantity), 0))
            .group_by(Transaction.cashier_id)
            .all()
        )
        values = {r[0]: _dec(r[1]) for r in rows}
    else:
        values = net_by(db, q, Transaction.cashier_id)
    names = _load_cashier_names(db, [k for k in values if k])
    ranked = sorted(((k, v) for k, v in values.items() if k), key=lambda kv: kv[1], reverse=True)[:top]
    cashiers = [
        {"rank": i + 1, "cashierId": k, "name": _display_name(names.get(k)) or "עובד", "value": float(v)}
        for i, (k, v) in enumerate(ranked)
    ]
    if scope.locked:
        shop_target = next(
            (
                p for p in progress(db, [machine.shop_id], now=now)
                if p["scope"] == "area" and p["period"] == "day" and p.get("areaId") == str(scope.area_id)
            ),
            None,
        )
    else:
        shop_target = next((p for p in progress(db, [machine.shop_id], now=now) if p["scope"] == "shop" and p["period"] == "day"), None)
    return {"metric": metric, "day": day.isoformat(), "cashiers": cashiers, "target": shop_target}
