"""
"תחזית ואיוש" — the sales forecast for the next hours and for tomorrow, per shop, and how many
tills (cashiers) to open each hour. Extends the insights forecast (analytics.forecast_day /
hourly_profile / today_pace) — the same documents, the same scope, money in integer agorot.

**The forecast** (per shop in the scope):

* *Tomorrow* — the insights' seasonal forecast (weekday × hour: the weighted 4-3-2-1 average of
  the same weekday over the last four weeks, an outlier week dropped), spread over the hours by
  those weeks' hourly shares, then corrected by the **recent trend**: how the last 14 complete
  days came in against what the same method forecast for them (actual ÷ forecast, clamped
  0.7–1.3; none with fewer than 5 judgeable days).
* *The next hours* — each remaining hour of today at the same weekday's weighted hourly average,
  corrected by **today's pace** (so far ÷ the usual so far, clamped 0.5–1.6) when today is
  judgeable, else by the trend. The current hour counts only its remaining part.
* *Holidays* — no holiday calendar exists in the system; `register_holiday_provider` is the
  hook: a provider returns `{"name": …, "factor": 0.0–3.0}` for a day (and shop), and tomorrow's
  forecast is multiplied by it. The outlier rule already keeps a past holiday from skewing a
  weekday.

**Staffing** — the throughput a till handles, observed: for every past hour of the shop, the
documents per till that worked that hour; a till's capacity is the 75th percentile over the
busy hours (≥ 5 documents) of the last nine weeks, or 30 documents an hour without enough
history (`capacitySource`). Tills to open = ⌈expected documents at the cashier tills ÷ (capacity ×
80%)⌉ — at least one when anything is expected, never more than the shop has (`short` when
it would need more). Kiosks are not tills to staff: their share of the documents is taken out.
"""
from __future__ import annotations

import logging
import math
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction

from . import analytics as A
from . import data as D

logger = logging.getLogger(__name__)

DEFAULT_CAPACITY = 30.0
TARGET_UTILISATION = 0.8
MIN_SLOT_DOCS = 5
MIN_CAPACITY_SLOTS = 8
CAPACITY_PERCENTILE = 0.75
TREND_DAYS = 14
TREND_MIN_DAYS = 5
TREND_CLAMP = (0.7, 1.3)
PACE_CLAMP = (0.5, 1.6)
NEXT_HOURS = 6
HISTORY_DAYS = 63
MAX_SHOPS = 30


# ── Holidays (hook) ──────────────────────────────────────────────────────────

HolidayProvider = Callable[[date, Optional[uuid.UUID]], Optional[Dict[str, Any]]]
_HOLIDAYS: List[HolidayProvider] = []


def register_holiday_provider(provider: HolidayProvider) -> None:
    if provider not in _HOLIDAYS:
        _HOLIDAYS.append(provider)


def unregister_holiday_provider(provider: HolidayProvider) -> None:
    if provider in _HOLIDAYS:
        _HOLIDAYS.remove(provider)


def holiday_for(day: date, shop_id: Optional[uuid.UUID] = None) -> Optional[Dict[str, Any]]:
    for provider in list(_HOLIDAYS):
        try:
            found = provider(day, shop_id)
        except Exception:  # noqa: BLE001 - a broken calendar never breaks the forecast
            logger.exception("holiday provider %r failed", provider)
            continue
        if found:
            factor = found.get("factor", 1.0)
            try:
                factor = min(3.0, max(0.0, float(factor)))
            except (TypeError, ValueError):
                factor = 1.0
            return {"name": str(found.get("name") or ""), "factor": factor}
    return None


# ── Pure arithmetic ──────────────────────────────────────────────────────────


def clamp(value: float, bounds: Tuple[float, float]) -> float:
    return max(bounds[0], min(bounds[1], value))


def percentile(values: Sequence[float], q: float) -> Optional[float]:
    """Linear interpolation between closest ranks (q in 0–1)."""
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return float(ordered[lo])
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo))


def trend_factor(daily: Mapping[date, A.Cell], *, today: date, history_start: Optional[date]) -> Optional[float]:
    """The last 14 complete days against what the method forecast for each of them (clamped)."""
    actual_sum, forecast_sum, n = 0.0, 0.0, 0
    for day in A.days_between(today - timedelta(days=TREND_DAYS), today - timedelta(days=1)):
        f = A.forecast_day(daily, day, today=day, history_start=history_start)
        if f["net"] is None or f["confidence"] in ("none", "low") or f["net"] <= 0:
            continue
        actual_sum += max(0, daily[day].net if day in daily else 0)
        forecast_sum += f["net"]
        n += 1
    if n < TREND_MIN_DAYS or forecast_sum <= 0:
        return None
    return round(clamp(actual_sum / forecast_sum, TREND_CLAMP), 3)


def pace_factor(pace: Optional[Mapping[str, Any]]) -> Optional[float]:
    """Today so far against the usual so far (clamped), when today can be judged."""
    if not pace or not pace.get("judgeable") or not pace.get("expectedSoFar"):
        return None
    return round(clamp(float(pace["actual"]) / float(pace["expectedSoFar"]), PACE_CLAMP), 3)


def capacity_per_till(slots: Mapping[Tuple[date, int], Mapping[Any, int]]) -> Tuple[float, str]:
    """
    Documents a till handles in an hour: over the busy past hours (≥ MIN_SLOT_DOCS documents),
    documents ÷ tills that worked that hour, the 75th percentile. `slots` = {(day, hour): {till: docs}}.
    """
    rates = []
    for tills in slots.values():
        working = [d for d in tills.values() if d > 0]
        total = sum(working)
        if total >= MIN_SLOT_DOCS and working:
            rates.append(total / len(working))
    if len(rates) < MIN_CAPACITY_SLOTS:
        return DEFAULT_CAPACITY, "default"
    return round(max(1.0, percentile(rates, CAPACITY_PERCENTILE) or DEFAULT_CAPACITY), 1), "history"


def tills_needed(docs: float, capacity: float, available: int) -> Tuple[int, bool]:
    """(tills to open, short) — ⌈docs ÷ (capacity × 80%)⌉, ≥ 1 when anything is expected, ≤ what the shop has."""
    if docs <= 0.5:
        return 0, False
    need = max(1, math.ceil(docs / (max(capacity, 1.0) * TARGET_UTILISATION)))
    if available > 0 and need > available:
        return available, True
    return need, False


def weighted_hour(hourly: Mapping[Tuple[date, int], A.Cell], sample_days: Sequence[date], hour: int) -> Tuple[float, float]:
    """(net, docs) of `hour` over the sample days, weighted 4-3-2-1 like the forecast."""
    if not sample_days:
        return 0.0, 0.0
    weights = A.FORECAST_WEIGHTS[: len(sample_days)]
    total = sum(weights)
    net = sum(w * (hourly[(d, hour)].net if (d, hour) in hourly else 0) for d, w in zip(sample_days, weights)) / total
    docs = sum(w * (hourly[(d, hour)].docs if (d, hour) in hourly else 0) for d, w in zip(sample_days, weights)) / total
    return net, docs


def next_hours(
    hourly: Mapping[Tuple[date, int], A.Cell],
    *,
    sample_days: Sequence[date],
    now_slot: int,
    now_fraction: float,
    day_start_hour: int,
    factor: float,
    hours: int = NEXT_HOURS,
) -> List[Dict[str, Any]]:
    """The rest of today, hour by hour: the usual hour × the factor; the current hour's remaining part only."""
    out = []
    for slot in range(now_slot, min(24, now_slot + hours + 1)):
        hour = A.slot_hour(slot, day_start_hour)
        net, docs = weighted_hour(hourly, sample_days, hour)
        part = (1.0 - now_fraction) if slot == now_slot else 1.0
        if part <= 0:
            continue
        out.append({"hour": hour, "net": round(net * part * factor), "docs": round(docs * part * factor, 1),
                    "partial": slot == now_slot})
    return [h for h in out if h["net"] > 0 or h["docs"] > 0][:hours]


# ── Loading ──────────────────────────────────────────────────────────────────


def load_shop_cells(db: Session, scope: D.InsightScope, clock: A.BusinessClock, start_day: date, end_day: date,
                    kiosk_ids: Iterable[Any]) -> Tuple[Dict[Any, Dict[Tuple[date, int], A.Cell]], Dict[Any, Dict[Tuple[date, int], Dict[Any, int]]], Dict[Any, float]]:
    """
    Per shop: the hour cells (net, documents), the documents per till per hour (cashier tills
    only), and the share of documents the cashier tills (not kiosks) took.
    """
    query = D.scoped_documents(db, scope, clock, clock.day_start(start_day), clock.day_start(end_day + timedelta(days=1)))
    cells: Dict[Any, Dict[Tuple[date, int], A.Cell]] = defaultdict(dict)
    slots: Dict[Any, Dict[Tuple[date, int], Dict[Any, int]]] = defaultdict(lambda: defaultdict(dict))
    docs_all: Dict[Any, int] = defaultdict(int)
    docs_tills: Dict[Any, int] = defaultdict(int)
    if query is None:
        return {}, {}, {}
    kiosks = set(kiosk_ids)
    refund = D._is_refund_condition()
    discount = func.coalesce(Transaction.document_discount, 0)
    keys, decode = D._local_keys(db, clock, Transaction.created_at)
    rows = (
        query.with_entities(
            Transaction.shop_id.label("shop_id"),
            Transaction.machine_id.label("machine_id"),
            *[k.label(f"k{i}") for i, k in enumerate(keys)],
            func.coalesce(func.sum(case((refund, -Transaction.total_amount), else_=Transaction.total_amount - discount)), 0).label("net"),
            func.count(Transaction.id).label("docs"),
        )
        .group_by(Transaction.shop_id, Transaction.machine_id, *keys)
        .all()
    )
    for row in rows:
        key = decode(row)
        cell = cells[row.shop_id].setdefault(key, A.Cell())
        cell.add(A.Cell(net=A.to_agorot(row.net), docs=int(row.docs or 0)))
        docs_all[row.shop_id] += int(row.docs or 0)
        if row.machine_id is not None and row.machine_id not in kiosks:
            docs_tills[row.shop_id] += int(row.docs or 0)
            per = slots[row.shop_id][key]
            per[row.machine_id] = per.get(row.machine_id, 0) + int(row.docs or 0)
    share = {shop: (docs_tills[shop] / docs_all[shop]) if docs_all[shop] else 1.0 for shop in docs_all}
    return cells, slots, share


def _available_tills(db: Session, shop_ids: Sequence[Any], kiosk_ids: Iterable[Any]) -> Dict[Any, int]:
    if not shop_ids:
        return {}
    kiosks = set(kiosk_ids)
    out: Dict[Any, int] = defaultdict(int)
    for mid, sid in (
        db.query(POSMachine.id, POSMachine.shop_id)
        .filter(POSMachine.shop_id.in_(list(shop_ids)), POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
        .all()
    ):
        if mid not in kiosks:
            out[sid] += 1
    return out


# ── The section ──────────────────────────────────────────────────────────────


def _hourly_with_tills(rows: List[Dict[str, Any]], *, share: float, capacity: float, available: int) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        tills, short = tills_needed(r["docs"] * share, capacity, available)
        out.append({**r, "tills": tills, "short": short})
    return out


def shop_forecast(
    shop,
    hourly: Mapping[Tuple[date, int], A.Cell],
    slots: Mapping[Tuple[date, int], Mapping[Any, int]],
    *,
    clock: A.BusinessClock,
    share: float,
    available: int,
) -> Dict[str, Any]:
    today = clock.today
    daily = A.daily_totals(hourly)
    open_days = [d for d, c in daily.items() if c.docs]
    history_start = min(open_days) if open_days else None
    trend = trend_factor(daily, today=today, history_start=history_start)
    capacity, capacity_source = capacity_per_till({k: v for k, v in slots.items() if k[0] < today})

    # Tomorrow.
    tomorrow = today + timedelta(days=1)
    f = A.forecast_day(daily, tomorrow, today=today, history_start=history_start)
    holiday = holiday_for(tomorrow, getattr(shop, "id", None))
    factor = (trend or 1.0) * (holiday["factor"] if holiday else 1.0)
    net = round(f["net"] * factor) if f["net"] is not None else None
    docs = round(f["docs"] * factor, 1) if f["docs"] is not None else None
    profile = A.hourly_profile(hourly, daily, f["basis"], day_start_hour=clock.day_start_hour, total=net) if net else []
    if profile and docs:
        doc_total = sum(p["docs"] for p in profile) or 1.0
        profile = [{**p, "docs": round(p["docs"] / doc_total * docs, 1)} for p in profile]
    tomorrow_hours = _hourly_with_tills(
        [{"hour": p["hour"], "net": p["net"], "docs": p["docs"]} for p in profile],
        share=share, capacity=capacity, available=available,
    )

    # The next hours of today.
    slot, fraction = clock.now_slot()
    pace = A.today_pace(hourly, daily, today=today, now_slot=slot, now_fraction=fraction,
                        history_start=history_start, day_start_hour=clock.day_start_hour)
    today_factor = pace_factor(pace) or trend or 1.0
    today_f = A.forecast_day(daily, today, today=today, history_start=history_start)
    sample_days = [date.fromisoformat(d) for d in today_f["basis"]]
    upcoming = _hourly_with_tills(
        next_hours(hourly, sample_days=sample_days, now_slot=slot, now_fraction=fraction,
                   day_start_hour=clock.day_start_hour, factor=today_factor),
        share=share, capacity=capacity, available=available,
    )
    peak = max((h["tills"] for h in tomorrow_hours), default=0)
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "availableTills": available,
        "capacityPerTill": capacity,
        "capacitySource": capacity_source,
        "cashierShare": round(share, 3),
        "trendFactor": trend,
        "historyStart": history_start.isoformat() if history_start else None,
        "today": {
            "date": today.isoformat(),
            "pacePct": pace.get("pacePct") if pace else None,
            "factor": round(today_factor, 3),
            "factorSource": "pace" if pace_factor(pace) else ("trend" if trend else "none"),
            "actual": int(daily[today].net) if today in daily else 0,
            "nextHours": upcoming,
            "nextHoursNet": sum(h["net"] for h in upcoming),
        },
        "tomorrow": {
            "date": tomorrow.isoformat(),
            "weekday": f["weekday"],
            "net": net,
            "docs": docs,
            "low": round(f["low"] * factor) if f["low"] is not None else None,
            "high": round(f["high"] * factor) if f["high"] is not None else None,
            "confidence": f["confidence"],
            "holiday": holiday,
            "hourly": tomorrow_hours,
            "peakTills": peak,
            "short": any(h["short"] for h in tomorrow_hours),
        },
    }


def build(db: Session, scope: D.InsightScope, clock: A.BusinessClock) -> Dict[str, Any]:
    shops = D.scope_shops(db, scope)[:MAX_SHOPS]
    today = clock.today
    shop_ids = [s.id for s in shops]
    kiosk_ids = [r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.shop_id.in_(shop_ids)).all()] if shop_ids else []
    cells, slots, share = load_shop_cells(db, scope, clock, today - timedelta(days=HISTORY_DAYS), today, kiosk_ids)
    available = _available_tills(db, shop_ids, kiosk_ids)
    out = [
        shop_forecast(s, cells.get(s.id, {}), slots.get(s.id, {}), clock=clock, share=share.get(s.id, 1.0),
                      available=available.get(s.id, 0))
        for s in shops
    ]
    tomorrow_net = sum(s["tomorrow"]["net"] or 0 for s in out)
    return {
        "generatedAt": clock.now.isoformat(),
        "timezone": clock.tz_name,
        "dayStartHour": clock.day_start_hour,
        "today": today.isoformat(),
        "shops": out,
        "totals": {
            "tomorrowNet": tomorrow_net,
            "nextHoursNet": sum(s["today"]["nextHoursNet"] for s in out),
            "tomorrowPeakTills": sum(s["tomorrow"]["peakTills"] for s in out),
        },
        "method": {
            "capacityDefault": DEFAULT_CAPACITY,
            "utilisation": TARGET_UTILISATION,
            "trendDays": TREND_DAYS,
            "nextHours": NEXT_HOURS,
        },
    }
