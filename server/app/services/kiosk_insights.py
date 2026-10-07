"""
"ביצועי קיוסקים" — the kiosks' report in the manager's insights (docs/SPEC_KIOSK_INSIGHTS.md §2).

`GET /insights/kiosks`: over the insights' scope (company › shop › point of sale › till, the
caller's role first) and period (complete business days, against the period before), for
every self-order kiosk in it — or the one asked for (`kioskId`):

* **the funnel** — sessions (a first tap) → the menu → a product opened → added to the
  basket → the basket → the checkout's steps → payment → paid, with the drop between stages
  (`kiosk_sessions.max_rank`: a session counts at a stage it reached or passed);
* **where they leave** — the sessions not paid by the step they were last on, and why
  (left / timed out / cancelled / asked for help);
* **time to order** — first tap → payment approved: median, average, 90th percentile;
* **the basket** — the paid kiosk orders (`kiosk_orders`): count, revenue, average basket,
  items per order, tips; orders by hour; the top items (the kiosks' own documents);
* **upsell** — windows shown / taken / declined, by rule and by product (the funnel's
  events; for kiosks that have none yet, the till's own counts `upsell_stats`);
* **payments** — attempts, failures and their reasons (the funnel), and the terminal's
  outcomes recorded by "עסקאות שלא הושלמו" for the kiosks;
* **per kiosk** — the same figures side by side (the table the CSV export takes).

Money is integer agorot; times are seconds. Sessions and orders are counted by their own
time inside the period's business days, in the tenant's timezone.
"""
from __future__ import annotations

import statistics
import uuid as uuid_mod
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice, KioskOrder
from app.models.kiosk_insights import KioskEvent, KioskSession
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.services.insights import data as D
from app.services.insights.analytics import to_agorot
from app.services.kiosk_funnel import END_REASONS, FUNNEL, PAY_FAILURES, STEPS
from app.services.reports import _is_refund_condition

TOP_ITEMS = 15
RULES_MAX = 30
#: "time to order" buckets, in seconds (upper bounds; the last is open).
ORDER_TIME_BUCKETS = (60, 120, 180, 300, 600)


def _aware(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return D._as_dt(value)


def _pct(part: float, whole: float) -> Optional[float]:
    return round(100.0 * part / whole, 1) if whole else None


def _sec(ms: Optional[float]) -> Optional[int]:
    return int(round(ms / 1000.0)) if ms is not None else None


def _uuid(value: Any) -> Optional[uuid_mod.UUID]:
    if value is None or isinstance(value, uuid_mod.UUID):
        return value
    try:
        return uuid_mod.UUID(str(value))
    except (TypeError, ValueError):
        return None


# ── Which kiosks ─────────────────────────────────────────────────────────────


def scope_kiosks(db: Session, ctx, kiosk_id: Optional[uuid_mod.UUID] = None) -> Tuple[List[Shop], Dict[Any, Dict[str, Any]]]:
    """
    The shops of the scope and its kiosks: today's kiosks (`kiosk_devices`) and any machine
    that reported sessions there (a kiosk turned back into a till keeps its history).
    """
    shops = ctx.shops
    shop_ids = [s.id for s in shops]
    names = {s.id: s.name for s in shops}
    if not shop_ids:
        return shops, {}
    machine_filter = ctx.scope.machine_id
    if kiosk_id is not None:
        machine_filter = kiosk_id if machine_filter is None or machine_filter == kiosk_id else uuid_mod.uuid4()
    area = D.scope_area(ctx.db, ctx.scope)
    q = db.query(POSMachine, KioskDevice).outerjoin(KioskDevice, KioskDevice.machine_id == POSMachine.id).filter(POSMachine.shop_id.in_(shop_ids))
    session_machines = db.query(KioskSession.machine_id).filter(KioskSession.shop_id.in_(shop_ids)).distinct()
    q = q.filter(or_(KioskDevice.machine_id.isnot(None), POSMachine.id.in_(session_machines)))
    if machine_filter is not None:
        q = q.filter(POSMachine.id == machine_filter)
    out: Dict[Any, Dict[str, Any]] = {}
    for machine, device in q.all():
        if area is not None:
            mine = machine.area_id if machine.area_id is not None else D.AREA_NONE
            if str(mine) != str(area):
                continue
        out[machine.id] = {
            "machineId": str(machine.id),
            "name": device.name if device is not None else machine.name,
            "machineName": machine.name,
            "shopId": str(machine.shop_id) if machine.shop_id else None,
            "shopName": names.get(machine.shop_id),
            "isKiosk": device is not None,
        }
    return shops, out


# ── Sessions ─────────────────────────────────────────────────────────────────


def _sessions_q(db: Session, ids: Sequence[Any], start: datetime, end: datetime):
    return db.query(KioskSession).filter(
        KioskSession.machine_id.in_(list(ids)), KioskSession.started_at >= start, KioskSession.started_at < end,
    )


def _headline_sessions(db: Session, ids, start, end) -> Dict[str, Any]:
    row = (
        _sessions_q(db, ids, start, end)
        .with_entities(
            func.count(KioskSession.id),
            func.coalesce(func.sum(case((KioskSession.paid.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(KioskSession.upsell_shown), 0),
            func.coalesce(func.sum(KioskSession.upsell_accepted), 0),
            func.coalesce(func.sum(KioskSession.pay_attempts), 0),
            func.coalesce(func.sum(KioskSession.pay_failures), 0),
            func.coalesce(func.sum(case((KioskSession.basket_changed.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((KioskSession.help.is_(True), 1), else_=0)), 0),
        )
        .one()
    )
    sessions, paid, shown, accepted, attempts, failures, changed, helped = (int(x or 0) for x in row)
    times = [
        int(ms) for (ms,) in _sessions_q(db, ids, start, end)
        .with_entities(KioskSession.order_ms)
        .filter(KioskSession.paid.is_(True), KioskSession.order_ms.isnot(None))
        .all()
        if ms is not None and ms >= 0
    ]
    return {
        "sessions": sessions,
        "paidSessions": paid,
        "conversion": _pct(paid, sessions),
        "abandoned": sessions - paid,
        "upsellShown": shown,
        "upsellAccepted": accepted,
        "upsellRate": _pct(accepted, shown),
        "payAttempts": attempts,
        "payFailures": failures,
        "payFailureRate": _pct(failures, attempts),
        "basketChanged": changed,
        "helpRequests": helped,
        "medianOrderSec": _sec(statistics.median(times)) if times else None,
        "avgOrderSec": _sec(sum(times) / len(times)) if times else None,
        "_times": times,
    }


def _funnel(db: Session, ids, start, end) -> List[Dict[str, Any]]:
    counts: Dict[int, int] = defaultdict(int)
    for rank, n in (
        _sessions_q(db, ids, start, end).with_entities(KioskSession.max_rank, func.count(KioskSession.id))
        .group_by(KioskSession.max_rank).all()
    ):
        counts[int(rank or 0)] += int(n or 0)
    total = sum(counts.values())
    stages = []
    for key, rank in FUNNEL:
        reached = sum(n for r, n in counts.items() if r >= rank)
        stages.append({"key": key, "rank": rank, "sessions": reached, "pctOfStart": _pct(reached, total)})
    for i, stage in enumerate(stages):
        nxt = stages[i + 1]["sessions"] if i + 1 < len(stages) else None
        stage["dropToNext"] = stage["sessions"] - nxt if nxt is not None else None
        stage["dropPct"] = _pct(stage["sessions"] - nxt, stage["sessions"]) if nxt is not None else None
    return stages


def _abandonment(db: Session, ids, start, end) -> Dict[str, Any]:
    by_step: Dict[str, Dict[str, int]] = {}
    reasons: Dict[str, int] = defaultdict(int)
    for step, reason, paid, n in (
        _sessions_q(db, ids, start, end)
        .with_entities(KioskSession.last_step, KioskSession.end_reason, KioskSession.paid, func.count(KioskSession.id))
        .group_by(KioskSession.last_step, KioskSession.end_reason, KioskSession.paid)
        .all()
    ):
        n = int(n or 0)
        if paid:
            reasons["paid"] += n
            continue
        r = reason if reason in END_REASONS and reason != "paid" else "open"
        reasons[r] += n
        bucket = by_step.setdefault(step or "attract", defaultdict(int))
        bucket[r] += n
    left = sum(sum(b.values()) for b in by_step.values())
    order = {s: i for i, s in enumerate(STEPS)}
    rows = []
    for step, bucket in sorted(by_step.items(), key=lambda kv: order.get(kv[0], 99)):
        count = sum(bucket.values())
        rows.append({"step": step, "count": count, "pct": _pct(count, left), "reasons": dict(bucket)})
    worst = max(rows, key=lambda r: r["count"]) if rows else None
    return {"left": left, "byStep": rows, "endReasons": dict(reasons), "worstStep": worst["step"] if worst else None}


def _order_time(times: List[int]) -> Dict[str, Any]:
    if not times:
        return {"count": 0, "medianSec": None, "avgSec": None, "p90Sec": None, "buckets": []}
    ordered = sorted(times)
    p90 = ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]
    buckets = []
    lo = 0
    for hi in ORDER_TIME_BUCKETS:
        buckets.append({"fromSec": lo, "toSec": hi, "count": sum(1 for t in ordered if lo * 1000 <= t < hi * 1000)})
        lo = hi
    buckets.append({"fromSec": lo, "toSec": None, "count": sum(1 for t in ordered if t >= lo * 1000)})
    return {
        "count": len(ordered),
        "medianSec": _sec(statistics.median(ordered)),
        "avgSec": _sec(sum(ordered) / len(ordered)),
        "p90Sec": _sec(p90),
        "buckets": buckets,
    }


# ── Orders (kiosk_orders) ────────────────────────────────────────────────────


def _orders_q(db: Session, ids, start, end):
    return db.query(KioskOrder).filter(
        KioskOrder.machine_id.in_(list(ids)),
        KioskOrder.paid_at.isnot(None),
        KioskOrder.paid_at >= start,
        KioskOrder.paid_at < end,
        # "תשלום בקופה": an order still open (or expired / cancelled) is no sale.
        or_(KioskOrder.open_state.is_(None), KioskOrder.open_state == "paid"),
    )


def _orders_headline(db: Session, ids, start, end) -> Dict[str, Any]:
    count, total, tips, items = (
        _orders_q(db, ids, start, end)
        .with_entities(
            func.count(KioskOrder.id),
            func.coalesce(func.sum(KioskOrder.total_agorot), 0),
            func.coalesce(func.sum(KioskOrder.tip_agorot), 0),
            func.coalesce(func.sum(KioskOrder.item_count), 0),
        )
        .one()
    )
    count, total, tips, items = int(count or 0), int(total or 0), int(tips or 0), int(items or 0)
    return {
        "orders": count,
        "revenue": total,
        "tips": tips,
        "avgBasket": int(round(total / count)) if count else None,
        "itemsPerOrder": round(items / count, 2) if count else None,
    }


def _orders_by_hour_and_day(db: Session, ctx, ids, start, end) -> Tuple[List[Dict[str, Any]], Dict[date, Dict[str, int]]]:
    keys, decode = D._local_keys(db, ctx.clock, KioskOrder.paid_at)
    hours: Dict[int, Dict[str, int]] = {h: {"orders": 0, "revenue": 0} for h in range(24)}
    days: Dict[date, Dict[str, int]] = {}
    for row in (
        _orders_q(db, ids, start, end)
        .with_entities(
            *[k.label(f"k{i}") for i, k in enumerate(keys)],
            func.count(KioskOrder.id).label("n"),
            func.coalesce(func.sum(KioskOrder.total_agorot), 0).label("total"),
        )
        .group_by(*keys)
        .all()
    ):
        day, hour = decode(row)
        hours[hour]["orders"] += int(row.n or 0)
        hours[hour]["revenue"] += int(row.total or 0)
        bucket = days.setdefault(day, {"orders": 0, "revenue": 0})
        bucket["orders"] += int(row.n or 0)
        bucket["revenue"] += int(row.total or 0)
    return [{"hour": h, **v} for h, v in sorted(hours.items())], days


def _sessions_by_day(db: Session, ctx, ids, start, end) -> Dict[date, Dict[str, int]]:
    keys, decode = D._local_keys(db, ctx.clock, KioskSession.started_at)
    out: Dict[date, Dict[str, int]] = {}
    for row in (
        _sessions_q(db, ids, start, end)
        .with_entities(
            *[k.label(f"k{i}") for i, k in enumerate(keys)],
            func.count(KioskSession.id).label("n"),
            func.coalesce(func.sum(case((KioskSession.paid.is_(True), 1), else_=0)), 0).label("paid"),
        )
        .group_by(*keys)
        .all()
    ):
        day, _hour = decode(row)
        bucket = out.setdefault(day, {"sessions": 0, "paid": 0})
        bucket["sessions"] += int(row.n or 0)
        bucket["paid"] += int(row.paid or 0)
    return out


def _sessions_by_hour(db: Session, ctx, ids, start, end) -> Dict[int, int]:
    keys, decode = D._local_keys(db, ctx.clock, KioskSession.started_at)
    out: Dict[int, int] = defaultdict(int)
    for row in (
        _sessions_q(db, ids, start, end)
        .with_entities(*[k.label(f"k{i}") for i, k in enumerate(keys)], func.count(KioskSession.id).label("n"))
        .group_by(*keys)
        .all()
    ):
        _day, hour = decode(row)
        out[hour] += int(row.n or 0)
    return out


def _top_items(db: Session, ctx, ids, start, end) -> List[Dict[str, Any]]:
    """The kiosks' own documents: units and net per product (refunds subtract)."""
    query = D.scoped_documents(db, ctx.scope, ctx.clock, start, end)
    if query is None:
        return []
    tx = (
        query.filter(Transaction.machine_id.in_(list(ids)))
        .with_entities(Transaction.id.label("tx_id"), case((_is_refund_condition(), True), else_=False).label("is_refund"))
        .subquery()
    )
    sign = case((tx.c.is_refund.is_(True), -1), else_=1)
    discount = func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0) + func.coalesce(TransactionItem.voucher_discount, 0)
    rows = (
        db.query(
            TransactionItem.product_id.label("pid"),
            func.max(TransactionItem.product_name).label("name"),
            func.coalesce(func.sum(sign * TransactionItem.quantity), 0).label("units"),
            func.coalesce(func.sum(case(
                (tx.c.is_refund.is_(True), -TransactionItem.total_price), else_=TransactionItem.total_price - discount,
            )), 0).label("net"),
        )
        .select_from(TransactionItem)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .group_by(TransactionItem.product_id)
        .all()
    )
    items = [
        {"productId": str(r.pid) if r.pid else None, "name": r.name, "units": round(float(r.units or 0), 3), "net": to_agorot(r.net)}
        for r in rows
    ]
    items = [i for i in items if i["units"] > 0]
    items.sort(key=lambda i: (-i["units"], -i["net"], i["name"] or ""))
    return items[:TOP_ITEMS]


# ── Upsell and payments (the funnel's events) ────────────────────────────────


def _events(db: Session, ids, start, end, kind: str):
    return (
        db.query(KioskEvent.machine_id, KioskEvent.data)
        .filter(KioskEvent.machine_id.in_(list(ids)), KioskEvent.type == kind, KioskEvent.at >= start, KioskEvent.at < end)
        .all()
    )


def _upsell(db: Session, ids, start, end, period: Tuple[date, date]) -> Dict[str, Any]:
    by_rule: Dict[str, Dict[str, int]] = {}
    by_product: Dict[str, int] = defaultdict(int)
    by_moment: Dict[str, Dict[str, int]] = {}
    rows = _events(db, ids, start, end, "upsell")
    source = "events"
    for _mid, data in rows:
        data = data if isinstance(data, dict) else {}
        rule = str(data.get("ruleId") or "")
        action = data.get("action") or "shown"
        key = "accepted" if action == "accepted" else ("shown" if action == "shown" else "declined")
        bucket = by_rule.setdefault(rule, {"shown": 0, "accepted": 0, "declined": 0})
        bucket[key] += 1
        moment = data.get("moment")
        if moment:
            m = by_moment.setdefault(moment, {"shown": 0, "accepted": 0, "declined": 0})
            m[key] += 1
        if key == "accepted" and data.get("productId"):
            by_product[str(data["productId"])] += 1
    if not rows:
        # Kiosks with no funnel yet: the till's own counts per rule and day (Android).
        from app.models.menu import UpsellStat

        source = "till_stats"
        for rule_id, shown, accepted, dismissed, declined, options in (
            db.query(UpsellStat.rule_id, UpsellStat.shown, UpsellStat.accepted, UpsellStat.dismissed, UpsellStat.declined, UpsellStat.accepted_options)
            .filter(UpsellStat.machine_id.in_(list(ids)), UpsellStat.day >= period[0], UpsellStat.day <= period[1])
            .all()
        ):
            bucket = by_rule.setdefault(str(rule_id), {"shown": 0, "accepted": 0, "declined": 0})
            bucket["shown"] += int(shown or 0)
            bucket["accepted"] += int(accepted or 0)
            bucket["declined"] += int(dismissed or 0) + int(declined or 0)
            for pid, n in (options or {}).items():
                by_product[str(pid)] += int(n or 0)
    rule_ids = [_uuid(r) for r in by_rule if _uuid(r) is not None]
    names: Dict[str, str] = {}
    if rule_ids:
        from app.models.menu import UpsellRule

        names = {str(r.id): r.name for r in db.query(UpsellRule.id, UpsellRule.name).filter(UpsellRule.id.in_(rule_ids)).all()}
    product_ids = [_uuid(p) for p in by_product if _uuid(p) is not None]
    product_names = (
        {str(p.id): p.name for p in db.query(Product.id, Product.name).filter(Product.id.in_(product_ids)).all()} if product_ids else {}
    )
    rules = [
        {
            "ruleId": rid or None, "name": names.get(rid), "shown": b["shown"], "accepted": b["accepted"],
            "declined": b["declined"], "rate": _pct(b["accepted"], b["shown"]),
        }
        for rid, b in by_rule.items()
    ]
    rules.sort(key=lambda r: (-r["shown"], -r["accepted"], r["name"] or ""))
    shown = sum(b["shown"] for b in by_rule.values())
    accepted = sum(b["accepted"] for b in by_rule.values())
    declined = sum(b["declined"] for b in by_rule.values())
    products = sorted(
        ({"productId": pid, "name": product_names.get(pid), "accepted": n} for pid, n in by_product.items()),
        key=lambda p: (-p["accepted"], p["name"] or ""),
    )
    return {
        "source": source,
        "shown": shown,
        "accepted": accepted,
        "declined": declined,
        "rate": _pct(accepted, shown),
        "byRule": rules[:RULES_MAX],
        "byProduct": products[:RULES_MAX],
        "byMoment": [{"moment": m, **v, "rate": _pct(v["accepted"], v["shown"])} for m, v in sorted(by_moment.items())],
    }


def _payments(db: Session, ids, start, end) -> Dict[str, Any]:
    results: Dict[str, int] = defaultdict(int)
    reasons: Dict[Tuple[str, str], int] = defaultdict(int)
    methods: Dict[str, int] = defaultdict(int)
    for _mid, data in _events(db, ids, start, end, "pay"):
        data = data if isinstance(data, dict) else {}
        result = data.get("result") or "unknown"
        results[result] += 1
        if result == "started" and data.get("method"):
            methods[str(data["method"])] += 1
        if result in PAY_FAILURES:
            reasons[(result, str(data.get("reason") or result))] += 1
    attempts = results.get("started", 0)
    failures = sum(results.get(r, 0) for r in PAY_FAILURES)
    by_reason = [{"result": res, "reason": why, "count": n} for (res, why), n in reasons.items()]
    by_reason.sort(key=lambda r: (-r["count"], r["reason"]))
    # What the terminal itself said, as "עסקאות שלא הושלמו" recorded it for these kiosks.
    outcomes: List[Dict[str, Any]] = []
    try:
        from app.models.failed_payment import FailedPaymentAttempt

        outcomes = [
            {"outcome": o, "count": int(n or 0)}
            for o, n in db.query(FailedPaymentAttempt.outcome, func.count(FailedPaymentAttempt.id))
            .filter(
                FailedPaymentAttempt.machine_id.in_(list(ids)),
                FailedPaymentAttempt.occurred_at >= start,
                FailedPaymentAttempt.occurred_at < end,
            )
            .group_by(FailedPaymentAttempt.outcome)
            .all()
        ]
        outcomes.sort(key=lambda r: -r["count"])
    except Exception:  # noqa: BLE001 - an optional block; the report stands without it
        outcomes = []
    return {
        "attempts": attempts,
        "approved": results.get("approved", 0),
        "failures": failures,
        "failureRate": _pct(failures, attempts),
        "results": dict(results),
        "byReason": by_reason,
        "byMethod": [{"method": m, "count": n} for m, n in sorted(methods.items(), key=lambda kv: -kv[1])],
        "terminalOutcomes": outcomes,
    }


# ── Per kiosk ────────────────────────────────────────────────────────────────


def _per_kiosk(db: Session, kiosks: Dict[Any, Dict[str, Any]], start, end) -> List[Dict[str, Any]]:
    ids = list(kiosks)
    sessions: Dict[Any, Dict[str, int]] = {}
    for mid, n, paid, shown, accepted, attempts, failures in (
        _sessions_q(db, ids, start, end)
        .with_entities(
            KioskSession.machine_id,
            func.count(KioskSession.id),
            func.coalesce(func.sum(case((KioskSession.paid.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(KioskSession.upsell_shown), 0),
            func.coalesce(func.sum(KioskSession.upsell_accepted), 0),
            func.coalesce(func.sum(KioskSession.pay_attempts), 0),
            func.coalesce(func.sum(KioskSession.pay_failures), 0),
        )
        .group_by(KioskSession.machine_id)
        .all()
    ):
        sessions[mid] = {
            "sessions": int(n or 0), "paid": int(paid or 0), "shown": int(shown or 0), "accepted": int(accepted or 0),
            "attempts": int(attempts or 0), "failures": int(failures or 0),
        }
    times: Dict[Any, List[int]] = defaultdict(list)
    for mid, ms in (
        _sessions_q(db, ids, start, end)
        .with_entities(KioskSession.machine_id, KioskSession.order_ms)
        .filter(KioskSession.paid.is_(True), KioskSession.order_ms.isnot(None))
        .all()
    ):
        if ms is not None and ms >= 0:
            times[mid].append(int(ms))
    orders: Dict[Any, Tuple[int, int, int]] = {}
    for mid, n, total, items in (
        _orders_q(db, ids, start, end)
        .with_entities(
            KioskOrder.machine_id, func.count(KioskOrder.id),
            func.coalesce(func.sum(KioskOrder.total_agorot), 0), func.coalesce(func.sum(KioskOrder.item_count), 0),
        )
        .group_by(KioskOrder.machine_id)
        .all()
    ):
        orders[mid] = (int(n or 0), int(total or 0), int(items or 0))
    out = []
    for mid, info in kiosks.items():
        s = sessions.get(mid, {"sessions": 0, "paid": 0, "shown": 0, "accepted": 0, "attempts": 0, "failures": 0})
        n, total, items = orders.get(mid, (0, 0, 0))
        t = times.get(mid, [])
        out.append({
            **info,
            "sessions": s["sessions"],
            "paidSessions": s["paid"],
            "conversion": _pct(s["paid"], s["sessions"]),
            "abandoned": s["sessions"] - s["paid"],
            "orders": n,
            "revenue": total,
            "avgBasket": int(round(total / n)) if n else None,
            "itemsPerOrder": round(items / n, 2) if n else None,
            "medianOrderSec": _sec(statistics.median(t)) if t else None,
            "upsellShown": s["shown"],
            "upsellAccepted": s["accepted"],
            "upsellRate": _pct(s["accepted"], s["shown"]),
            "payAttempts": s["attempts"],
            "payFailures": s["failures"],
            "payFailureRate": _pct(s["failures"], s["attempts"]),
        })
    out.sort(key=lambda r: (-(r["revenue"] or 0), -(r["sessions"] or 0), r["name"] or ""))
    return out


# ── The report ───────────────────────────────────────────────────────────────


def _headline(db: Session, ids, start, end) -> Dict[str, Any]:
    s = _headline_sessions(db, ids, start, end)
    s.pop("_times", None)
    return {**s, **_orders_headline(db, ids, start, end)}


def report(ctx, kiosk_id: Optional[uuid_mod.UUID] = None) -> Dict[str, Any]:
    """`GET /insights/kiosks` — the whole report for the context's scope and period."""
    db = ctx.db
    _shops, kiosks = scope_kiosks(db, ctx, kiosk_id)
    start, end = ctx.span(ctx.period.start, ctx.period.end)
    prev_start, prev_end = ctx.span(ctx.period.prev_start, ctx.period.prev_end)
    kiosk_list = sorted(kiosks.values(), key=lambda k: (k["shopName"] or "", k["name"] or ""))
    empty = {
        "kiosks": kiosk_list, "hasKiosks": bool(kiosks), "hasData": False,
        "headline": {"current": None, "previous": None}, "funnel": [], "abandonment": {"left": 0, "byStep": [], "endReasons": {}, "worstStep": None},
        "orderTime": _order_time([]), "byHour": [], "daily": [], "topItems": [],
        "upsell": {"source": "events", "shown": 0, "accepted": 0, "declined": 0, "rate": None, "byRule": [], "byProduct": [], "byMoment": []},
        "payments": {"attempts": 0, "approved": 0, "failures": 0, "failureRate": None, "results": {}, "byReason": [], "byMethod": [], "terminalOutcomes": []},
        "perKiosk": [],
    }
    if not kiosks:
        return empty
    ids = list(kiosks)
    current = _headline_sessions(db, ids, start, end)
    times = current.pop("_times")
    current.update(_orders_headline(db, ids, start, end))
    previous = _headline(db, ids, prev_start, prev_end)
    by_hour, order_days = _orders_by_hour_and_day(db, ctx, ids, start, end)
    session_hours = _sessions_by_hour(db, ctx, ids, start, end)
    for h in by_hour:
        h["sessions"] = session_hours.get(h["hour"], 0)
    session_days = _sessions_by_day(db, ctx, ids, start, end)
    daily = []
    day = ctx.period.start
    while day <= ctx.period.end:
        s = session_days.get(day, {"sessions": 0, "paid": 0})
        o = order_days.get(day, {"orders": 0, "revenue": 0})
        daily.append({"date": day.isoformat(), **s, **o, "conversion": _pct(s["paid"], s["sessions"])})
        day += timedelta(days=1)
    has_data = bool(current["sessions"] or current["orders"])
    return {
        **empty,
        "hasData": has_data,
        "headline": {"current": current, "previous": previous if (previous["sessions"] or previous["orders"]) else None},
        "funnel": _funnel(db, ids, start, end),
        "abandonment": _abandonment(db, ids, start, end),
        "orderTime": _order_time(times),
        "byHour": by_hour,
        "daily": daily,
        "topItems": _top_items(db, ctx, ids, start, end),
        "upsell": _upsell(db, ids, start, end, (ctx.period.start, ctx.period.end)),
        "payments": _payments(db, ids, start, end),
        "perKiosk": _per_kiosk(db, kiosks, start, end),
    }
