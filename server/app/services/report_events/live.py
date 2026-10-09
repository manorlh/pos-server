"""
"מצב אירוע חי" — the event's live screen: one request's worth of what a manager or a
producer watches on a big screen during the event.

Same documents and money as the event report (docs/SPEC_EVENTS.md §3, `common.make_doc`'s
definitions): the event's tills, the counted statuses, `created_at` in the window, a sale's
collected = total − document discount, a credit note subtracting. The window here ends at
"now" while the event runs.

What it returns:

* `phase` — upcoming / live / ended, and the clock;
* `totals` — net, sales, documents, average ticket (collected ÷ sales), documents per hour
  (over the elapsed time and over the last hour), tips;
* `series` — net and documents per 1 or 5 minutes, clock-aligned, zero-filled, the last
  2 hours (1 min) or 12 hours (5 min) of the window;
* `target` — the target (app/services/report_events/targets.py: a targets module's, else
  the one typed on the screen), the progress and when the pace reaches it;
* `pace` — the forecast to the end: what is in, plus the remaining minutes at a blend of
  the last 30 minutes' rate (60%) and the whole event's (40%), with a low–high band from
  the two rates alone. Before 15 minutes have passed, the event's average only;
* `items` — the top items of the last hour and of the whole event;
* `tills` — every till of the event: online / offline (machine_status.is_online), its net,
  documents and last sale, unsynced documents as the till last reported them;
* `kds` — the shop's kitchen when it has KDS data in the cloud: orders waiting now and for
  how long, the late ones (the stations' "late" minutes), the preparation time of the last
  hour. Null when the shop has no KDS orders at all;
* `vouchers` — prepaid vouchers redeemed on the event's tills in the window (a reversed
  redemption counts nowhere): redemptions, vouchers, units, the last hour, by batch.

Pure helpers (`bucket_series`, `pace_forecast`, `eta_minutes`, `progress_pct`) carry the
arithmetic and are tested on their own.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.report_event import ReportEvent
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.services.dashboard_stats import SALE_STATUSES
from app.services.machine_status import is_online
from app.services.main_till import till_order
from app.services.tenders import expected_tender_total, is_refund_document

from .common import ZERO, chunks, dec, iso, money, utc
from .targets import target_for_event

BUCKETS = (1, 5)
DEFAULT_BUCKET = 5
#: How much of the window the chart shows, per bucket size.
SPAN_MINUTES = {1: 120, 5: 12 * 60}
#: The "recent" rate of the pace forecast.
RECENT_MINUTES = 30
#: Before this much of the event has passed, the forecast uses the event's average only.
WARMUP_MINUTES = 15
RECENT_WEIGHT = 0.6
LAST_HOUR_MINUTES = 60
TOP_ITEMS = 8
#: A KDS order waiting this long is late, when the shop's stations set no minutes.
DEFAULT_KDS_LATE_MINUTES = 20
#: "Current" events: live now, starting within this many hours, or ended within these.
UPCOMING_HOURS = 12
RECENT_END_HOURS = 3

PHASE_UPCOMING = "upcoming"
PHASE_LIVE = "live"
PHASE_ENDED = "ended"


# ── Pure arithmetic ──────────────────────────────────────────────────────────


def phase_of(starts: datetime, ends: datetime, now: datetime) -> str:
    if now < starts:
        return PHASE_UPCOMING
    if now >= ends:
        return PHASE_ENDED
    return PHASE_LIVE


def bucket_floor(moment: datetime, minutes: int) -> datetime:
    """The clock-aligned start of `moment`'s bucket (UTC epoch arithmetic, so 5 min = :00, :05…)."""
    seconds = minutes * 60
    epoch = int(moment.timestamp())
    return datetime.fromtimestamp(epoch - epoch % seconds, tz=timezone.utc)


def bucket_series(
    points: Iterable[Tuple[datetime, Decimal]],
    *,
    start: datetime,
    end: datetime,
    minutes: int,
    span_minutes: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Net and documents per `minutes`, clock-aligned, zero-filled, over [start, end) — or only
    its last `span_minutes`. Each point: `{at, net, docs}` (`at` = the bucket's start, ISO).
    """
    if end <= start or minutes <= 0:
        return []
    first = bucket_floor(start, minutes)
    if span_minutes:
        first = max(first, bucket_floor(end - timedelta(minutes=span_minutes), minutes))
    step = timedelta(minutes=minutes)
    keys: List[datetime] = []
    cursor = first
    while cursor < end:
        keys.append(cursor)
        cursor += step
    net: Dict[datetime, Decimal] = {k: ZERO for k in keys}
    docs: Dict[datetime, int] = {k: 0 for k in keys}
    for at, amount in points:
        at = utc(at)
        if at is None or at < start or at >= end:
            continue
        key = bucket_floor(at, minutes)
        if key in net:
            net[key] += dec(amount)
            docs[key] += 1
    return [{"at": k.isoformat(), "net": money(net[k]), "docs": docs[k]} for k in keys]


def pace_forecast(
    *,
    net: float,
    elapsed_minutes: float,
    remaining_minutes: float,
    recent_net: float,
    recent_minutes: float,
) -> Dict[str, Optional[float]]:
    """
    The net at the end of the event at the current pace.

    rate = 60% of the last `recent_minutes`' rate + 40% of the whole event's (the event's
    average only during the first `WARMUP_MINUTES`); projected = net + rate × remaining. The
    band: the same with each rate alone. Rates are per hour in the output. No elapsed time —
    nothing to project (all None but `projected` = what is in when the event is over).
    """
    remaining = max(0.0, float(remaining_minutes))
    if elapsed_minutes <= 0:
        return {"projected": None, "low": None, "high": None, "ratePerHour": None,
                "recentRatePerHour": None, "averageRatePerHour": None}
    avg_rate = float(net) / float(elapsed_minutes)
    recent_window = min(float(recent_minutes), float(elapsed_minutes))
    recent_rate = float(recent_net) / recent_window if recent_window > 0 else avg_rate
    if elapsed_minutes < WARMUP_MINUTES:
        rate = avg_rate
    else:
        rate = RECENT_WEIGHT * recent_rate + (1 - RECENT_WEIGHT) * avg_rate
    rate = max(rate, 0.0)
    low_rate, high_rate = sorted((max(avg_rate, 0.0), max(recent_rate, 0.0)))
    return {
        "projected": round(float(net) + rate * remaining, 2),
        "low": round(float(net) + low_rate * remaining, 2),
        "high": round(float(net) + high_rate * remaining, 2),
        "ratePerHour": round(rate * 60, 2),
        "recentRatePerHour": round(recent_rate * 60, 2),
        "averageRatePerHour": round(avg_rate * 60, 2),
    }


def eta_minutes(net: float, target: float, rate_per_hour: Optional[float]) -> Optional[float]:
    """Minutes until `target` at `rate_per_hour`; 0 when already there; None when it never gets there."""
    if target is None:
        return None
    if net >= target:
        return 0.0
    if not rate_per_hour or rate_per_hour <= 0:
        return None
    return round((float(target) - float(net)) / float(rate_per_hour) * 60, 1)


def progress_pct(net: float, target: Optional[float]) -> Optional[float]:
    if not target or target <= 0:
        return None
    return round(float(net) / float(target) * 100, 1)


def per_hour(count: float, minutes: float) -> Optional[float]:
    if minutes <= 0:
        return None
    return round(float(count) / float(minutes) * 60, 1)


# ── Loading ──────────────────────────────────────────────────────────────────


@dataclass
class LiveDoc:
    id: Any
    at: datetime
    machine_id: str
    refund: bool
    collected: Decimal
    net: Decimal
    tip: Decimal


def load_live_docs(db: Session, event: ReportEvent, machine_ids: Sequence[Any], start: datetime, end: datetime) -> List[LiveDoc]:
    """The counted documents of the tills in [start, end): only the columns the money needs."""
    if not machine_ids or end <= start:
        return []
    rows = (
        db.query(
            Transaction.id, Transaction.created_at, Transaction.machine_id, Transaction.total_amount,
            Transaction.document_discount, Transaction.document_type, Transaction.refund_of_transaction_id,
            Transaction.tip_amount,
        )
        .filter(
            Transaction.machine_id.in_(list(machine_ids)),
            Transaction.tenant_id == event.tenant_id,
            Transaction.status.in_(SALE_STATUSES),
            Transaction.duplicate_copy.is_(False),
            Transaction.created_at >= start,
            Transaction.created_at < end,
        )
        .order_by(Transaction.created_at)
        .all()
    )
    out: List[LiveDoc] = []
    for r in rows:
        refund = is_refund_document(document_type=r.document_type, refund_of_transaction_id=r.refund_of_transaction_id)
        collected = expected_tender_total(
            total_amount=r.total_amount, document_discount=r.document_discount,
            document_type=r.document_type, refund_of_transaction_id=r.refund_of_transaction_id,
        )
        out.append(LiveDoc(
            id=r.id, at=utc(r.created_at), machine_id=str(r.machine_id), refund=refund,
            collected=collected, net=-collected if refund else collected, tip=dec(r.tip_amount),
        ))
    return out


def totals_of(docs: Sequence[LiveDoc]) -> Dict[str, Any]:
    sales = [d for d in docs if not d.refund]
    refunds = [d for d in docs if d.refund]
    collected = sum((d.collected for d in sales), ZERO)
    return {
        "net": sum((d.net for d in docs), ZERO),
        "sales": len(sales),
        "docs": len(docs),
        "refunds": len(refunds),
        "refundsAmount": sum((d.collected for d in refunds), ZERO),
        "collected": collected,
        "tips": sum((d.tip for d in docs), ZERO),
        "avgTicket": (collected / len(sales)) if sales else None,
    }


def item_rows(db: Session, docs: Sequence[LiveDoc], *, limit: int = TOP_ITEMS) -> List[Dict[str, Any]]:
    """Net quantity and revenue per product over `docs`, best first (the event report's line rules)."""
    if not docs:
        return []
    from .report import _product_meta

    refund = {d.id: d.refund for d in docs}
    acc: Dict[str, Dict[str, Any]] = {}
    lines = []
    ids = list(refund)
    for chunk in chunks(ids):
        lines += (
            db.query(
                TransactionItem.transaction_id, TransactionItem.product_id, TransactionItem.product_name,
                TransactionItem.quantity, TransactionItem.total_price, TransactionItem.discount,
                TransactionItem.promotion_discount,
            )
            .filter(TransactionItem.transaction_id.in_(list(chunk)))
            .all()
        )
    meta, _cats = _product_meta(db, [l.product_id for l in lines])
    for line in lines:
        is_refund = refund.get(line.transaction_id, False)
        pid = str(line.product_id) if line.product_id else None
        m = meta.get(pid) if pid else None
        key = m[0] if m else (pid or f"name:{(line.product_name or '').strip()}")
        name = m[1] if m else (line.product_name or "—")
        qty = dec(line.quantity)
        if is_refund:
            qty, value = -qty, -dec(line.total_price)
        else:
            value = dec(line.total_price) - dec(line.discount) - dec(line.promotion_discount)
        row = acc.setdefault(key, {"key": key, "name": name, "quantity": ZERO, "revenue": ZERO})
        row["quantity"] += qty
        row["revenue"] += value
    rows = [r for r in acc.values() if r["quantity"] > 0 or r["revenue"] > 0]
    rows.sort(key=lambda r: (-r["quantity"], -r["revenue"], r["name"] or ""))
    return [
        {"key": r["key"], "name": r["name"], "quantity": float(r["quantity"]), "revenue": money(r["revenue"])}
        for r in rows[:limit]
    ]


def tills_live(machines: Sequence[POSMachine], docs: Sequence[LiveDoc], now: datetime) -> List[Dict[str, Any]]:
    by_till: Dict[str, List[LiveDoc]] = defaultdict(list)
    for d in docs:
        by_till[d.machine_id].append(d)
    out = []
    for m in sorted(machines, key=till_order):
        mine = by_till.get(str(m.id), [])
        t = totals_of(mine)
        online = is_online(m.last_heartbeat_at, now=now)
        out.append({
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "online": online,
            "lastSeenAt": iso(m.last_heartbeat_at),
            "net": money(t["net"]),
            "sales": t["sales"],
            "docs": t["docs"],
            "lastSaleAt": iso(max((d.at for d in mine), default=None)),
            "pendingDocuments": m.pending_documents,
            "pendingAsOf": iso(m.pending_count_at),
        })
    return out


def kds_summary(db: Session, event: ReportEvent, start: datetime, now: datetime) -> Optional[Dict[str, Any]]:
    """The shop's kitchen during the event, from the cloud's KDS orders; None when the shop has none."""
    from app.models.kds import KdsStationSetting, KitchenOrder

    if db.query(KitchenOrder.id).filter(KitchenOrder.shop_id == event.shop_id).first() is None:
        return None
    late_values = [
        int(v) for (v,) in db.query(KdsStationSetting.late_minutes)
        .filter(KdsStationSetting.shop_id == event.shop_id, KdsStationSetting.target_kind == "prep")
        .all() if v
    ]
    late_minutes = min(late_values) if late_values else DEFAULT_KDS_LATE_MINUTES
    window_start = max(start, now - timedelta(hours=24))
    open_rows = (
        db.query(KitchenOrder.first_released_at)
        .filter(
            KitchenOrder.shop_id == event.shop_id,
            KitchenOrder.status == "open",
            KitchenOrder.first_released_at.isnot(None),
            KitchenOrder.first_released_at >= window_start,
        )
        .all()
    )
    waits = sorted(max(0.0, (now - utc(r[0])).total_seconds() / 60) for r in open_rows)
    hour_ago = now - timedelta(minutes=LAST_HOUR_MINUTES)
    done_rows = (
        db.query(KitchenOrder.first_released_at, KitchenOrder.ready_at)
        .filter(
            KitchenOrder.shop_id == event.shop_id,
            KitchenOrder.ready_at.isnot(None),
            KitchenOrder.first_released_at.isnot(None),
            KitchenOrder.ready_at >= max(start, hour_ago),
            KitchenOrder.ready_at <= now,
        )
        .all()
    )
    preps = [max(0.0, (utc(r[1]) - utc(r[0])).total_seconds() / 60) for r in done_rows]
    return {
        "openOrders": len(waits),
        "avgWaitMinutes": round(sum(waits) / len(waits), 1) if waits else None,
        "oldestWaitMinutes": round(waits[-1], 1) if waits else None,
        "lateOrders": sum(1 for w in waits if w >= late_minutes),
        "lateMinutes": late_minutes,
        "readyLastHour": len(preps),
        "avgPrepMinutesLastHour": round(sum(preps) / len(preps), 1) if preps else None,
        "maxPrepMinutesLastHour": round(max(preps), 1) if preps else None,
    }


def voucher_summary(db: Session, machine_ids: Sequence[Any], start: datetime, end: datetime, now: datetime) -> Dict[str, Any]:
    """Prepaid vouchers redeemed on the tills in [start, end); a reversed redemption counts nowhere."""
    from app.models.prepaid_voucher import PrepaidVoucherBatch, PrepaidVoucherRedemption

    empty = {"redemptions": 0, "vouchers": 0, "units": 0.0, "lastHour": 0, "byBatch": []}
    if not machine_ids or end <= start:
        return empty
    rows = (
        db.query(
            PrepaidVoucherRedemption.voucher_id, PrepaidVoucherRedemption.batch_id,
            PrepaidVoucherRedemption.items, PrepaidVoucherRedemption.uses, PrepaidVoucherRedemption.redeemed_at,
        )
        .filter(
            PrepaidVoucherRedemption.machine_id.in_(list(machine_ids)),
            PrepaidVoucherRedemption.redeemed_at >= start,
            PrepaidVoucherRedemption.redeemed_at < end,
            PrepaidVoucherRedemption.reversed_at.is_(None),
        )
        .all()
    )
    if not rows:
        return empty
    hour_ago = now - timedelta(minutes=LAST_HOUR_MINUTES)
    by_batch: Dict[Any, Dict[str, Any]] = {}
    units_total = 0.0
    for r in rows:
        units = redemption_units(r.items, r.uses)
        units_total += units
        b = by_batch.setdefault(r.batch_id, {"batchId": str(r.batch_id), "redemptions": 0, "vouchers": set(), "units": 0.0})
        b["redemptions"] += 1
        b["vouchers"].add(r.voucher_id)
        b["units"] += units
    names = {
        bid: name for bid, name in db.query(PrepaidVoucherBatch.id, PrepaidVoucherBatch.name)
        .filter(PrepaidVoucherBatch.id.in_(list(by_batch))).all()
    }
    batches = sorted(
        ({"batchId": b["batchId"], "name": names.get(bid) or "—", "redemptions": b["redemptions"],
          "vouchers": len(b["vouchers"]), "units": round(b["units"], 3)} for bid, b in by_batch.items()),
        key=lambda b: (-b["redemptions"], b["name"]),
    )
    return {
        "redemptions": len(rows),
        "vouchers": len({r.voucher_id for r in rows}),
        "units": round(units_total, 3),
        "lastHour": sum(1 for r in rows if utc(r.redeemed_at) >= hour_ago),
        "byBatch": batches,
    }


def redemption_units(items: Any, uses: Any) -> float:
    """Goods: the quantities taken; a discount voucher's use: its uses (at least one)."""
    total = 0.0
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                try:
                    total += float(it.get("quantity") or 0)
                except (TypeError, ValueError):
                    continue
    if total > 0:
        return total
    try:
        return float(uses) if uses else 1.0
    except (TypeError, ValueError):
        return 1.0


# ── The screen ───────────────────────────────────────────────────────────────


def _machines(db: Session, event: ReportEvent) -> List[POSMachine]:
    ids = [r.machine_id for r in event.machines or []]
    return db.query(POSMachine).filter(POSMachine.id.in_(ids)).all() if ids else []


def build_live(db: Session, event: ReportEvent, *, now: Optional[datetime] = None, bucket: int = DEFAULT_BUCKET) -> Dict[str, Any]:
    from .report import event_block

    now = utc(now) or datetime.now(timezone.utc)
    minutes = bucket if bucket in BUCKETS else DEFAULT_BUCKET
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    phase = phase_of(starts, ends, now)
    window_end = min(now, ends)
    machines = _machines(db, event)
    machine_ids = [m.id for m in machines]
    docs = load_live_docs(db, event, machine_ids, starts, window_end) if phase != PHASE_UPCOMING else []

    totals = totals_of(docs)
    duration = (ends - starts).total_seconds() / 60
    elapsed = max(0.0, min((window_end - starts).total_seconds() / 60, duration))
    remaining = max(0.0, (ends - max(now, starts)).total_seconds() / 60) if phase != PHASE_ENDED else 0.0
    recent_from = window_end - timedelta(minutes=RECENT_MINUTES)
    recent_net = sum((d.net for d in docs if d.at >= recent_from), ZERO)
    hour_from = window_end - timedelta(minutes=LAST_HOUR_MINUTES)
    last_hour = [d for d in docs if d.at >= hour_from]
    pace = pace_forecast(
        net=float(totals["net"]), elapsed_minutes=elapsed, remaining_minutes=remaining,
        recent_net=float(recent_net), recent_minutes=RECENT_MINUTES,
    )

    target = target_for_event(db, event)
    target_block = None
    if target is not None:
        amount = float(target.amount)
        progress_net, target_id = _target_actual(db, event, target, machine_ids, starts, window_end, totals["net"])
        net = float(progress_net)
        eta = eta_minutes(net, amount, pace["ratePerHour"]) if phase == PHASE_LIVE else (0.0 if net >= amount else None)
        target_block = {
            "amount": money(target.amount),
            "source": target.source,
            "targetId": target_id,
            "actual": money(progress_net),
            "progressPct": progress_pct(net, amount),
            "remaining": money(max(Decimal("0"), target.amount - progress_net)),
            "reached": net >= amount,
            "etaMinutes": eta,
            "etaAt": iso(now + timedelta(minutes=eta)) if eta not in (None, 0.0) and phase == PHASE_LIVE else None,
            "onPace": (pace["projected"] is not None and pace["projected"] >= amount) if phase == PHASE_LIVE else net >= amount,
        }

    return {
        "event": event_block(db, event, machines),
        "now": now.isoformat(),
        "phase": phase,
        "elapsedMinutes": round(elapsed, 1),
        "remainingMinutes": round(remaining, 1),
        "startsInMinutes": round((starts - now).total_seconds() / 60, 1) if phase == PHASE_UPCOMING else None,
        "bucketMinutes": minutes,
        "totals": {
            "net": money(totals["net"]),
            "sales": totals["sales"],
            "docs": totals["docs"],
            "refunds": totals["refunds"],
            "refundsAmount": money(totals["refundsAmount"]),
            "tips": money(totals["tips"]),
            "avgTicket": money(totals["avgTicket"]) if totals["avgTicket"] is not None else None,
            "docsPerHour": per_hour(totals["docs"], elapsed),
            "docsLastHour": len(last_hour),
            "netLastHour": money(sum((d.net for d in last_hour), ZERO)),
        },
        "series": bucket_series(
            ((d.at, d.net) for d in docs), start=starts, end=window_end if phase != PHASE_UPCOMING else starts,
            minutes=minutes, span_minutes=SPAN_MINUTES[minutes],
        ),
        "target": target_block,
        "pace": pace,
        "items": {
            "lastHour": item_rows(db, last_hour),
            "event": item_rows(db, docs),
        },
        "tills": tills_live(machines, docs, now),
        "kds": kds_summary(db, event, starts, now) if phase != PHASE_UPCOMING else None,
        "vouchers": voucher_summary(db, machine_ids, starts, window_end, now),
    }


def _target_actual(db: Session, event: ReportEvent, target, machine_ids, start: datetime, end: datetime,
                   live_net: Decimal) -> Tuple[Decimal, Optional[str]]:
    """
    What counts toward the target: for the event's target in "יעדים ותחרות", that module's own net
    (sales_targets.actual_of — the figure its "יעד הושג" is decided on), so the screen says
    "reached" exactly when the alert does; otherwise the screen's own net.
    """
    if target.source != "targets":
        return live_net, None
    from app.services import sales_targets

    row = sales_targets.event_target(db, event)
    if row is None or Decimal(str(row.amount)).quantize(Decimal("0.01")) != target.amount:
        return live_net, None  # another provider's target: the screen's net
    if end <= start:
        return Decimal("0.00"), str(row.id)
    return sales_targets.actual_of(db, row, start, end, list(machine_ids)), str(row.id)


def current_events(db: Session, events: Sequence[ReportEvent], now: datetime) -> List[Dict[str, Any]]:
    """The events worth a live screen now: live, starting soon, or just over — live first."""
    from .report import event_block

    out = []
    for e in events:
        starts, ends = utc(e.starts_at), utc(e.ends_at)
        if starts - timedelta(hours=UPCOMING_HOURS) > now or ends + timedelta(hours=RECENT_END_HOURS) < now:
            continue
        block = event_block(db, e)
        out.append({**block, "phase": phase_of(starts, ends, now)})
    order = {PHASE_LIVE: 0, PHASE_UPCOMING: 1, PHASE_ENDED: 2}
    out.sort(key=lambda b: (order[b["phase"]], b["startsAt"]))
    return out


def as_uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


__all__ = [
    "BUCKETS", "bucket_series", "pace_forecast", "eta_minutes", "progress_pct", "phase_of", "build_live",
    "current_events", "redemption_units", "per_hour",
]
