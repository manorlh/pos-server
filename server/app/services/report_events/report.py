"""
The event's producer report (docs/SPEC_EVENTS.md §3) — live from the documents while the
event is a draft; a confirmed event serves the snapshot taken at confirmation instead.

Which documents: the event's tills' `transactions`, of the event's tenant, in the counted
statuses (`SALE_STATUSES`, exactly as the Z and every report), with `created_at` in
[starts_at, ends_at). The money is read the way `shift_totals` and `reports` read it
(`common.make_doc`): a sale's collected = total − document discount, a credit note's
total is what went back and is subtracted, tips stay outside the sales, tenders come
from the legs (signed), VAT as declared (estimated from the rate when not).

Everything is computed in Python over the loaded documents: an event is at most 14 days
of a few tills, and doing the 15-minute buckets, idle gaps and medians in Python keeps
the result identical on Postgres and on the tests' SQLite.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException, TillEvent
from app.models.category import Category
from app.models.menu import TransactionItemPart
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.report_event import EVENT_CONFIRMED, EVENT_DRAFT, ReportEvent
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.models.z_report import ZReport
from app.services.dashboard_stats import SALE_STATUSES
from app.services.main_till import till_order
from app.services.tenders import sale_condition
from app.services.z_waiters import _names as pos_user_names
from app.services.z_waiters import _orders_by_tx, _uuid_text

from . import rules as R
from .common import ZERO, Doc, chunks, dec, iso, make_doc, money, utc
from .reconcile import reconcile_transmissions, reconcile_z, z_label

BUCKET_MINUTES = 15
BASELINE_DAYS = 28
ITEM_ROWS_MAX = 500
TOP_ITEMS = 10
MATRIX_ITEMS = 15
EXCEPTION_ROWS_MAX = 300
TILL_EVENT_TYPES = ("line_void", "basket_cancel", "drawer_open")


def zone(name: Optional[str]):
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        return ZoneInfo(name or "Asia/Jerusalem")
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("Asia/Jerusalem")


def _pct(part: float, whole: float) -> Optional[float]:
    return round(part / whole * 100, 2) if whole else None


def _user_name(db: Session, user_id) -> Optional[str]:
    if user_id is None:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return (u.username or u.email) if u else None


def event_machine_rows(event: ReportEvent):
    return list(event.machines or [])


def event_block(db: Session, event: ReportEvent, machines: Optional[Sequence[POSMachine]] = None) -> Dict[str, Any]:
    """The event itself, as every endpoint shows it."""
    tz = zone(event.timezone)
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    s_local, e_local = starts.astimezone(tz), ends.astimezone(tz)
    rows = event_machine_rows(event)
    if machines is None:
        ids = [r.machine_id for r in rows]
        machines = db.query(POSMachine).filter(POSMachine.id.in_(ids)).all() if ids else []
    by_id = {m.id: m for m in machines}
    released = {r.machine_id: r.released_at for r in rows}
    shop = db.query(Shop).filter(Shop.id == event.shop_id).first()
    ordered = sorted((by_id[r.machine_id] for r in rows if r.machine_id in by_id), key=till_order)
    return {
        "id": str(event.id),
        "name": event.name,
        "shopId": str(event.shop_id),
        "shopName": shop.name if shop else None,
        "companyId": str(event.company_id) if event.company_id else None,
        "startsAt": iso(starts),
        "endsAt": iso(ends),
        "startDate": s_local.date().isoformat(),
        "startTime": s_local.strftime("%H:%M"),
        "endDate": e_local.date().isoformat(),
        "endTime": e_local.strftime("%H:%M"),
        "timezone": event.timezone,
        "durationMinutes": int((ends - starts).total_seconds() // 60),
        "status": event.status,
        "producerName": event.producer_name,
        "notes": event.notes,
        "thresholds": R.normalize_thresholds(event.thresholds),
        "machineIds": [str(m.id) for m in ordered],
        "machines": [
            {
                "id": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "releasedAt": iso(released.get(m.id)),
            }
            for m in ordered
        ],
        "createdAt": iso(event.created_at),
        "updatedAt": iso(event.updated_at),
        "createdBy": _user_name(db, event.created_by_user_id),
        "confirmedAt": iso(event.confirmed_at),
        "confirmedBy": _user_name(db, event.confirmed_by_user_id),
        "confirmNote": event.confirm_note,
    }


# ── Loading ───────────────────────────────────────────────────────────────────


def load_docs(db: Session, event: ReportEvent, machine_ids: Sequence[uuid.UUID]) -> List[Doc]:
    if not machine_ids:
        return []
    txs = (
        db.query(Transaction)
        .filter(
            Transaction.machine_id.in_(list(machine_ids)),
            Transaction.tenant_id == event.tenant_id,
            Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False),
            Transaction.created_at >= utc(event.starts_at),
            Transaction.created_at < utc(event.ends_at),
        )
        .order_by(Transaction.created_at, Transaction.transaction_number)
        .all()
    )
    legs: Dict[Any, List[TransactionPayment]] = defaultdict(list)
    for chunk in chunks([t.id for t in txs]):
        for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_(list(chunk))).all():
            legs[leg.transaction_id].append(leg)
    from app.services.shift_totals import production_deductions_of

    deductions = production_deductions_of(db, [t.id for t in txs])
    return [make_doc(t, legs.get(t.id, []), deductions.get(t.id, Decimal("0"))) for t in txs]


def _bucket_start(moment: datetime, minutes: int) -> datetime:
    seconds = minutes * 60
    epoch = int(moment.timestamp())
    return datetime.fromtimestamp(epoch - epoch % seconds, tz=timezone.utc)


# ── Items ─────────────────────────────────────────────────────────────────────


def _product_meta(db: Session, product_ids) -> Tuple[Dict[str, Tuple[str, str, Optional[str]]], Dict[str, str]]:
    """product id → (key, current name, category id); category id → name."""
    ids = [i for i in set(product_ids) if i is not None]
    products: Dict[Any, Product] = {}
    for chunk in chunks(ids):
        for p in db.query(Product).filter(Product.id.in_(list(chunk))).all():
            products[p.id] = p
    globals_ = [p.global_product_id for p in products.values() if p.global_product_id and p.global_product_id not in products]
    for chunk in chunks(globals_):
        for p in db.query(Product).filter(Product.id.in_(list(chunk))).all():
            products[p.id] = p
    meta = {}
    for pid in ids:
        p = products.get(pid)
        if p is None:
            continue
        g = products.get(p.global_product_id) if p.global_product_id else None
        base = g or p
        meta[str(pid)] = (str(base.id), base.name, str(base.category_id) if base.category_id else None)
    cat_ids = {m[2] for m in meta.values() if m[2]}
    cats = {}
    for chunk in chunks([uuid.UUID(c) for c in cat_ids]):
        for c in db.query(Category).filter(Category.id.in_(list(chunk))).all():
            cats[str(c.id)] = c.name
    return meta, cats


def build_items(db: Session, docs: Sequence[Doc], machines: Dict[str, POSMachine]) -> Dict[str, Any]:
    by_doc = {d.id: d for d in docs}
    lines: List[TransactionItem] = []
    for chunk in chunks([d.tx.id for d in docs]):
        lines += db.query(TransactionItem).filter(TransactionItem.transaction_id.in_(list(chunk))).all()
    meta, cats = _product_meta(db, [l.product_id for l in lines])

    acc: Dict[str, Dict[str, Any]] = {}
    for line in lines:
        doc = by_doc.get(str(line.transaction_id))
        if doc is None:
            continue
        pid = str(line.product_id) if line.product_id else None
        m = meta.get(pid) if pid else None
        key = m[0] if m else (pid or f"name:{(line.product_name or '').strip()}")
        name = m[1] if m else (line.product_name or "—")
        cat = m[2] if m else None
        qty = dec(line.quantity)
        if doc.refund:
            value = -dec(line.total_price)
            qty = -qty
        else:
            value = (
                dec(line.total_price) - dec(line.discount) - dec(line.promotion_discount)
                - dec(getattr(line, "voucher_discount", None))
            )
        row = acc.setdefault(key, {
            "key": key, "name": name, "categoryId": cat, "categoryName": cats.get(cat) if cat else None,
            "quantity": ZERO, "sold": ZERO, "refunded": ZERO, "revenue": ZERO, "lines": 0,
            "byTill": defaultdict(lambda: ZERO), "byTillRevenue": defaultdict(lambda: ZERO),
        })
        row["quantity"] += qty
        if doc.refund:
            row["refunded"] += -qty
        else:
            row["sold"] += qty
            row["lines"] += 1
        row["revenue"] += value
        row["byTill"][doc.machine_id] += qty
        row["byTillRevenue"][doc.machine_id] += value

    total_revenue = sum((r["revenue"] for r in acc.values()), ZERO)
    rows = sorted(acc.values(), key=lambda r: (-r["revenue"], r["name"] or ""))
    out_rows = []
    for rank, r in enumerate(rows, start=1):
        out_rows.append({
            "key": r["key"],
            "name": r["name"],
            "categoryId": r["categoryId"],
            "categoryName": r["categoryName"],
            "quantity": float(r["quantity"]),
            "sold": float(r["sold"]),
            "refunded": float(r["refunded"]),
            "revenue": money(r["revenue"]),
            "lines": r["lines"],
            "sharePct": _pct(float(r["revenue"]), float(total_revenue)),
            "rank": rank,
            "byTill": {mid: float(q) for mid, q in r["byTill"].items() if q},
        })
    positive = [r for r in out_rows if r["revenue"] > 0]
    top = positive[:TOP_ITEMS]
    top_keys = {r["key"] for r in top}
    bottom = [r for r in sorted(positive, key=lambda r: (r["revenue"], r["name"] or "")) if r["key"] not in top_keys][:TOP_ITEMS]

    categories: Dict[Optional[str], Dict[str, Any]] = {}
    for r in out_rows:
        c = categories.setdefault(r["categoryId"], {
            "categoryId": r["categoryId"], "name": r["categoryName"] or "ללא קטגוריה",
            "quantity": 0.0, "revenue": 0.0, "items": 0,
        })
        c["quantity"] += r["quantity"]
        c["revenue"] += r["revenue"]
        c["items"] += 1
    cat_rows = sorted(categories.values(), key=lambda c: -c["revenue"])
    for c in cat_rows:
        c["revenue"] = round(c["revenue"], 2)
        c["sharePct"] = _pct(c["revenue"], float(total_revenue))

    active_tills = {d.machine_id for d in docs}
    single = []
    if len(active_tills) >= 2:
        for r in out_rows:
            if r["quantity"] < R.SINGLE_TILL_MIN_UNITS:
                continue
            mid, qty = max(r["byTill"].items(), key=lambda kv: kv[1], default=(None, 0))
            if mid and qty / r["quantity"] >= R.SINGLE_TILL_SHARE:
                single.append({
                    "key": r["key"], "name": r["name"], "machineId": mid,
                    "machineName": machines[mid].name if mid in machines else "—",
                    "quantity": r["quantity"], "sharePct": round(qty / r["quantity"] * 100, 1),
                })

    matrix_rows = [
        {"key": r["key"], "name": r["name"], "total": r["quantity"], "cells": r["byTill"]}
        for r in out_rows[:MATRIX_ITEMS]
    ]
    return {
        "totalRevenue": money(total_revenue),
        "itemsSold": float(sum((r["quantity"] for r in acc.values()), ZERO)),
        "itemsSoldInSales": float(sum((r["sold"] for r in acc.values()), ZERO)),
        "rows": out_rows[:ITEM_ROWS_MAX],
        "truncated": len(out_rows) > ITEM_ROWS_MAX,
        "top": top,
        "bottom": bottom,
        "categories": cat_rows,
        "modifiers": build_modifiers(db, docs),
        "matrix": {"machineIds": sorted(active_tills, key=lambda m: till_order(machines[m]) if m in machines else (9, 0, m)), "rows": matrix_rows},
        "singleTill": single,
    }


def build_modifiers(db: Session, docs: Sequence[Doc]) -> List[Dict[str, Any]]:
    refund = {d.tx.id: d.refund for d in docs}
    acc: Dict[str, Dict[str, Any]] = {}
    P = TransactionItemPart
    for chunk in chunks(list(refund)):
        for part in db.query(P).filter(P.transaction_id.in_(list(chunk)), P.kind == "modifier").all():
            key = str(part.option_id) if part.option_id else f"{part.group_name}|{part.name}"
            row = acc.setdefault(key, {"key": key, "name": part.name, "groupName": part.group_name,
                                       "kind": part.modifier_kind, "quantity": ZERO, "revenue": ZERO})
            sign = -1 if refund.get(part.transaction_id) else 1
            row["quantity"] += sign * dec(part.quantity)
            row["revenue"] += sign * dec(part.gross)
    rows = sorted(acc.values(), key=lambda r: (-r["quantity"], r["name"] or ""))[:15]
    return [{**r, "quantity": float(r["quantity"]), "revenue": money(r["revenue"])} for r in rows]


# ── The report ───────────────────────────────────────────────────────────────


def _idle_gaps(times: List[datetime], first: datetime, last: datetime, gap_minutes: int) -> List[Dict[str, Any]]:
    gaps = []
    limit = timedelta(minutes=gap_minutes)
    if not times:
        return gaps
    if times[0] - first > limit:
        gaps.append(("lateStart", first, times[0]))
    for a, b in zip(times, times[1:]):
        if b - a > limit:
            gaps.append(("gap", a, b))
    if last - times[-1] > limit:
        gaps.append(("earlyStop", times[-1], last))
    return [
        {"kind": k, "from": iso(a), "to": iso(b), "minutes": int(round((b - a).total_seconds() / 60))}
        for k, a, b in gaps
    ]


def _baseline_avg_ticket(db: Session, event: ReportEvent) -> Optional[float]:
    start = utc(event.starts_at)
    row = (
        db.query(
            func.coalesce(func.sum(Transaction.total_amount - func.coalesce(Transaction.document_discount, 0)), 0),
            func.count(Transaction.id),
        )
        .filter(
            Transaction.shop_id == event.shop_id,
            Transaction.tenant_id == event.tenant_id,
            Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False),
            sale_condition(),
            Transaction.created_at >= start - timedelta(days=BASELINE_DAYS),
            Transaction.created_at < start,
        )
        .one()
    )
    total, count = dec(row[0]), int(row[1] or 0)
    return money(total / count) if count else None


def _window_shifts(db: Session, event: ReportEvent, machine_ids) -> List[Shift]:
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    if not machine_ids:
        return []
    out = []
    for s in db.query(Shift).filter(Shift.machine_id.in_(list(machine_ids)), Shift.opened_at < ends).all():
        end = utc(s.closed_at or s.close_accepted_at)
        if s.status == ShiftStatus.OPEN or end is None or end > starts:
            out.append(s)
    out.sort(key=lambda s: (utc(s.opened_at), str(s.machine_id)))
    return out


def build_report(db: Session, event: ReportEvent, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = utc(now) or datetime.now(timezone.utc)
    tz = zone(event.timezone)
    th = R.normalize_thresholds(event.thresholds)
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    window_minutes = (ends - starts).total_seconds() / 60

    machine_ids = [r.machine_id for r in event_machine_rows(event)]
    machine_list = db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all() if machine_ids else []
    machine_list.sort(key=till_order)
    machines: Dict[str, POSMachine] = {str(m.id): m for m in machine_list}
    block = event_block(db, event, machine_list)
    docs = load_docs(db, event, machine_ids)
    sales = [d for d in docs if not d.refund]
    refunds = [d for d in docs if d.refund]

    shifts = _window_shifts(db, event, machine_ids)
    shift_by_id = {str(s.id): s for s in shifts}
    extra = sorted({d.shift_id for d in docs if d.shift_id and d.shift_id not in shift_by_id})
    for chunk in chunks(extra):
        for s in db.query(Shift).filter(Shift.id.in_([uuid.UUID(i) for i in chunk])).all():
            shift_by_id[str(s.id)] = s

    # Areas: the doc's shift's stamp, else the till's area now.
    area_ids = {s.area_id for s in shift_by_id.values() if s.area_id} | {m.area_id for m in machine_list if m.area_id}
    areas = {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).all()} if area_ids else {}

    def doc_area(d: Doc):
        s = shift_by_id.get(d.shift_id) if d.shift_id else None
        if s is not None and s.area_id:
            return s.area_id
        m = machines.get(d.machine_id)
        return m.area_id if m else None

    # ── KPIs ──
    gross = sum((d.gross for d in sales), ZERO)
    discounts = sum((d.discount for d in sales), ZERO)
    collected = sum((d.collected for d in sales), ZERO)
    refunded = sum((d.collected for d in refunds), ZERO)
    net = collected - refunded
    vat = sum((d.vat for d in docs), ZERO)
    tips = sum((d.tip for d in docs), ZERO)
    tenders = defaultdict(lambda: ZERO)
    tender_docs = defaultdict(set)
    brands = defaultdict(lambda: [ZERO, 0])
    for d in docs:
        for bucket, _raw, amount, leg in d.legs:
            tenders[bucket] += amount
            tender_docs[bucket].add(d.id)
            if bucket == "card":
                b = brands[(leg.card_brand if leg is not None else None) or "other"]
                b[0] += amount
                b[1] += 1

    # 15-minute buckets, and clock hours.
    first_at = min((d.at for d in docs), default=None)
    last_at = max((d.at for d in docs), default=None)
    bucket_net = defaultdict(lambda: ZERO)
    bucket_count = defaultdict(int)
    bucket_till = defaultdict(lambda: defaultdict(lambda: ZERO))
    hour_net = defaultdict(lambda: ZERO)
    hour_count = defaultdict(int)
    for d in docs:
        b = _bucket_start(d.at, BUCKET_MINUTES)
        bucket_net[b] += d.net
        bucket_till[b][d.machine_id] += d.net
        h = _bucket_start(d.at, 60)
        hour_net[h] += d.net
        if not d.refund:
            bucket_count[b] += 1
            hour_count[h] += 1
    timeline = []
    cursor = _bucket_start(starts, BUCKET_MINUTES)
    while cursor < ends:
        timeline.append({
            "start": iso(cursor),
            "net": money(bucket_net.get(cursor, ZERO)),
            "count": bucket_count.get(cursor, 0),
            "byTill": {mid: money(v) for mid, v in bucket_till.get(cursor, {}).items() if v},
        })
        cursor += timedelta(minutes=BUCKET_MINUTES)
    peak = None
    if hour_net:
        h, value = max(hour_net.items(), key=lambda kv: (kv[1], -kv[0].timestamp()))
        if value > 0:
            peak = {"start": iso(h), "end": iso(h + timedelta(hours=1)), "net": money(value),
                    "count": hour_count.get(h, 0), "sharePct": _pct(float(value), float(net))}
    active_hours = len([h for h, c in hour_net.items() if c or hour_count.get(h)])

    items = build_items(db, docs, machines)

    # ── Exceptions and till events ──
    ex_rows = []
    if machine_ids:
        ex_rows = (
            db.query(AuditException)
            .filter(
                AuditException.machine_id.in_(machine_ids),
                AuditException.occurred_at >= starts,
                AuditException.occurred_at < ends,
                AuditException.status != "dismissed",
            )
            .order_by(AuditException.occurred_at)
            .all()
        )
    ex_by_till = defaultdict(int)
    ex_by_type: Dict[str, Dict[str, Any]] = {}
    for e in ex_rows:
        mid = str(e.machine_id) if e.machine_id else None
        if mid:
            ex_by_till[mid] += 1
        t = ex_by_type.setdefault(e.exception_type, {"type": e.exception_type, "label": R.exception_label(e.exception_type),
                                                     "count": 0, "amount": ZERO, "tills": defaultdict(int)})
        t["count"] += 1
        t["amount"] += dec(e.amount)
        if mid and mid in machines:
            t["tills"][machines[mid].name] += 1
    till_events = defaultdict(lambda: defaultdict(int))
    if machine_ids:
        for mid, kind, count in (
            db.query(TillEvent.machine_id, TillEvent.event_type, func.count(TillEvent.id))
            .filter(
                TillEvent.machine_id.in_(machine_ids),
                TillEvent.occurred_at >= starts,
                TillEvent.occurred_at < ends,
                TillEvent.event_type.in_(TILL_EVENT_TYPES),
            )
            .group_by(TillEvent.machine_id, TillEvent.event_type)
            .all()
        ):
            till_events[str(mid)][kind] = int(count)

    # ── Cashiers / waiters ──
    orders = _orders_by_tx(db, event.shop_id, [d.tx for d in docs])
    names = pos_user_names(db, [d.tx.cashier_id for d in docs if d.tx.cashier_id])

    def owner(d: Doc) -> Tuple[Optional[str], Optional[str]]:
        order = orders.get(d.id)
        if order is None and d.refund:
            order = orders.get(_uuid_text(d.tx.refund_of_transaction_id) or "")
        if order is not None:
            wid = order.waiter_pos_user_id or order.opened_by_pos_user_id
            name = order.waiter_pos_user_name or order.opened_by_pos_user_name
            return wid, name or (names.get(_uuid_text(wid) or "") if wid else None)
        raw = (d.tx.cashier_id or "").strip() or None
        return raw, (names.get(_uuid_text(raw) or "") or raw) if raw else None

    doc_owner = {d.id: owner(d) for d in docs}

    # ── Per till ──
    by_till: Dict[str, List[Doc]] = defaultdict(list)
    for d in docs:
        by_till[d.machine_id].append(d)
    till_rows = []
    for mid, m in machines.items():
        mine = by_till.get(mid, [])
        s_docs = [d for d in mine if not d.refund]
        r_docs = [d for d in mine if d.refund]
        t_sales = sum((d.collected for d in s_docs), ZERO)
        t_ref = sum((d.collected for d in r_docs), ZERO)
        t_net = t_sales - t_ref
        t_tips = sum((d.tip for d in mine), ZERO)
        times = sorted(d.at for d in mine)
        span = 0.0
        if times:
            span = min(window_minutes, (times[-1] - times[0]).total_seconds() / 60 + BUCKET_MINUTES)
        active_buckets = {_bucket_start(t, BUCKET_MINUTES) for t in times}
        active_min = len(active_buckets) * BUCKET_MINUTES
        t_tenders = defaultdict(lambda: ZERO)
        for d in mine:
            for bucket, _raw, amount, _leg in d.legs:
                t_tenders[bucket] += amount
        till_items = sum((Decimal(str(r["byTill"].get(mid, 0))) for r in items["rows"]), ZERO)
        till_rows.append({
            "machineId": mid,
            "name": m.name,
            "posNumber": m.pos_number,
            "areaName": areas.get(m.area_id) if m.area_id else None,
            "documentsCount": len(mine),
            "salesCount": len(s_docs),
            "sales": money(t_sales),
            "refunds": money(t_ref),
            "refundsCount": len(r_docs),
            "net": money(t_net),
            "avgTicket": money(t_sales / len(s_docs)) if s_docs else 0.0,
            "items": float(till_items),
            "tips": money(t_tips),
            "tipPct": _pct(float(t_tips), float(t_sales)),
            "exceptions": ex_by_till.get(mid, 0),
            "voids": till_events[mid].get("line_void", 0),
            "cancels": till_events[mid].get("basket_cancel", 0),
            "drawerOpens": till_events[mid].get("drawer_open", 0),
            "firstSaleAt": iso(times[0]) if times else None,
            "lastSaleAt": iso(times[-1]) if times else None,
            "spanMinutes": round(span, 1),
            "activeMinutes": active_min,
            "salesPerHour": money(t_net / Decimal(str(span / 60))) if span else 0.0,
            "avgPerActiveHour": money(t_net / Decimal(str(active_min / 60))) if active_min else 0.0,
            "sharePct": _pct(float(t_net), float(net)),
            "idleGaps": _idle_gaps(times, first_at, last_at, th["idleGapMinutes"]) if times else [],
            "cash": money(t_tenders["cash"]),
            "card": money(t_tenders["card"]),
            "other": money(t_tenders["other"]),
            "exchange": money(t_tenders["exchange"]),
            "overCredited": sum(1 for d in r_docs if d.tx.over_credited),
            "lastHeartbeatAt": iso(m.last_heartbeat_at),
            "pendingDocuments": m.pending_documents,
            "pendingCountAt": iso(m.pending_count_at),
        })
    for t in till_rows:
        t["idleMinutes"] = sum(g["minutes"] for g in t["idleGaps"])

    # ── Shifts ──
    zs = {}
    z_ids = {s.z_report_id for s in shifts if s.z_report_id}
    if z_ids:
        zs = {z.id: z for z in db.query(ZReport).filter(ZReport.id.in_(list(z_ids))).all()}
    shift_rows = []
    for s in shifts:
        mid = str(s.machine_id)
        in_window = [d for d in docs if d.shift_id == str(s.id)]
        closed = utc(s.closed_at or s.close_accepted_at)
        z = zs.get(s.z_report_id) if s.z_report_id else None
        shift_rows.append({
            "shiftId": str(s.id),
            "machineId": mid,
            "machineName": machines[mid].name if mid in machines else "—",
            "sequence": s.sequence_number,
            "status": s.status.value if hasattr(s.status, "value") else str(s.status),
            "openedAt": iso(s.opened_at),
            "closedAt": iso(closed),
            "openedBy": s.opened_by,
            "closedBy": s.closed_by,
            "openingCash": money(s.opening_cash) if s.opening_cash is not None else None,
            "expectedCash": money(s.expected_cash) if s.expected_cash is not None else None,
            "countedCash": money(s.counted_cash) if s.counted_cash is not None else None,
            "discrepancy": money(s.discrepancy) if s.discrepancy is not None else None,
            "unattended": bool(s.unattended),
            "openedBeforeWindow": utc(s.opened_at) < starts,
            "closesAfterWindow": closed is not None and closed > ends,
            "zReportId": str(z.id) if z else None,
            "zLabel": z_label(z) if z else None,
            "documentsInWindow": len(in_window),
            "netInWindow": money(sum((d.net for d in in_window), ZERO)),
        })

    # ── Segments ──
    def seg_rows(groups: Dict[Any, List[Doc]], name_of) -> List[Dict[str, Any]]:
        out = []
        for key, group in groups.items():
            g_sales = [d for d in group if not d.refund]
            g_net = sum((d.net for d in group), ZERO)
            out.append({"id": None if key is None else str(key), "name": name_of(key), "net": money(g_net),
                        "count": len(g_sales), "sharePct": _pct(float(g_net), float(net))})
        out.sort(key=lambda r: -r["net"])
        return out

    by_area: Dict[Any, List[Doc]] = defaultdict(list)
    for d in docs:
        by_area[doc_area(d)].append(d)
    by_cashier_docs: Dict[Any, List[Doc]] = defaultdict(list)
    for d in docs:
        wid, name = doc_owner[d.id]
        by_cashier_docs[(wid or name or "")].append(d)
    cashier_rows = []
    for key, group in by_cashier_docs.items():
        g_sales = [d for d in group if not d.refund]
        g_ref = [d for d in group if d.refund]
        s_amt = sum((d.collected for d in g_sales), ZERO)
        r_amt = sum((d.collected for d in g_ref), ZERO)
        g_tips = sum((d.tip for d in group), ZERO)
        name = next((doc_owner[d.id][1] for d in group if doc_owner[d.id][1]), None)
        cashier_rows.append({
            "id": key or None, "name": name, "net": money(s_amt - r_amt), "sales": money(s_amt),
            "salesCount": len(g_sales), "refunds": money(r_amt), "refundsCount": len(g_ref),
            "tips": money(g_tips), "tipPct": _pct(float(g_tips), float(s_amt)),
            "avgTicket": money(s_amt / len(g_sales)) if g_sales else 0.0,
            "sharePct": _pct(float(s_amt - r_amt), float(net)),
        })
    cashier_rows.sort(key=lambda r: -r["net"])

    hour_of_day = defaultdict(lambda: [ZERO, 0])
    for d in docs:
        h = d.at.astimezone(tz).hour
        hour_of_day[h][0] += d.net
        if not d.refund:
            hour_of_day[h][1] += 1
    start_hour = starts.astimezone(tz).hour
    by_hour = [
        {"hour": h, "net": money(v[0]), "count": v[1], "sharePct": _pct(float(v[0]), float(net))}
        for h, v in sorted(hour_of_day.items(), key=lambda kv: (kv[0] - start_hour) % 24)
    ]
    payments = [
        {"method": k, "amount": money(tenders[k]), "count": len(tender_docs[k]), "sharePct": _pct(float(tenders[k]), float(net))}
        for k in ("cash", "card", "other", "exchange") if tenders.get(k) or tender_docs.get(k)
    ]
    card_brands = sorted(
        ({"brand": b, "amount": money(v[0]), "count": v[1]} for b, v in brands.items()),
        key=lambda r: -r["amount"],
    )
    has_areas = any(k is not None for k in by_area)

    kpis = {
        "gross": money(gross),
        "discounts": money(discounts),
        "sales": money(collected),
        "refunds": money(refunded),
        "refundsCount": len(refunds),
        "net": money(net),
        "vat": money(vat),
        "netExVat": money(net - vat),
        "vatEstimatedCount": sum(1 for d in docs if d.vat_estimated),
        "salesCount": len(sales),
        "documentsCount": len(docs),
        "avgTicket": money(collected / len(sales)) if sales else 0.0,
        "itemsSold": items["itemsSold"],
        "itemsPerSale": round(items["itemsSoldInSales"] / len(sales), 2) if sales else None,
        "discountPct": _pct(float(discounts), float(gross)),
        "tips": money(tips),
        "tipPct": _pct(float(tips), float(collected)),
        "exceptionsCount": len(ex_rows),
        "cash": money(tenders["cash"]),
        "card": money(tenders["card"]),
        "other": money(tenders["other"]),
        "exchange": money(tenders["exchange"]),
        "peakHour": peak,
        "windowHours": round(window_minutes / 60, 2),
        "salesPerHour": money(net / Decimal(str(window_minutes / 60))) if window_minutes else 0.0,
        "activeHours": active_hours,
        "avgPerActiveHour": money(net / active_hours) if active_hours else 0.0,
        "tillsCount": len(machines),
        "activeTills": len(by_till),
        "firstSaleAt": iso(first_at),
        "lastSaleAt": iso(last_at),
        "baselineAvgTicket": _baseline_avg_ticket(db, event),
    }

    report: Dict[str, Any] = {
        "event": block,
        "generatedAt": iso(now),
        "frozen": False,
        "timezone": event.timezone,
        "thresholds": th,
        "bucketMinutes": BUCKET_MINUTES,
        "kpis": kpis,
        "timeline": timeline,
        "tills": till_rows,
        "shifts": shift_rows,
        "items": items,
        "segments": {
            "byCategory": items["categories"],
            "byPayment": payments,
            "byCardBrand": card_brands,
            "byHour": by_hour,
            "byTill": [
                {"id": t["machineId"], "name": t["name"], "net": t["net"], "count": t["salesCount"], "sharePct": t["sharePct"]}
                for t in sorted(till_rows, key=lambda t: -t["net"])
            ],
            "byCashier": cashier_rows,
            "byArea": seg_rows(by_area, lambda k: areas.get(k) or "ללא אזור") if has_areas else [],
        },
        "exceptions": {
            "total": len(ex_rows),
            "byType": [
                {**t, "amount": money(t["amount"]), "tills": sorted(t["tills"].items(), key=lambda kv: -kv[1])}
                for t in sorted(ex_by_type.values(), key=lambda t: -t["count"])
            ],
            "rows": [
                {
                    "id": str(e.id), "type": e.exception_type, "label": R.exception_label(e.exception_type),
                    "severity": e.severity, "occurredAt": iso(e.occurred_at),
                    "machineId": str(e.machine_id) if e.machine_id else None,
                    "machineName": machines[str(e.machine_id)].name if e.machine_id and str(e.machine_id) in machines else None,
                    "posUserName": e.pos_user_name, "amount": money(e.amount) if e.amount is not None else None,
                    "transactionId": str(e.transaction_id) if e.transaction_id else None, "status": e.status,
                }
                for e in ex_rows[:EXCEPTION_ROWS_MAX]
            ],
        },
        "reconciliation": {
            "z": reconcile_z(db, event, machines, docs, list(shift_by_id.values())),
            "transmissions": reconcile_transmissions(db, event, machines, docs, now, tz),
        },
    }

    median = R.flag_tills(till_rows, th)
    report["medianSalesPerHour"] = money(median) if median else None
    facts = [
        R.DocFact(
            id=d.id, number=d.tx.transaction_number, machine_id=d.machine_id,
            machine_name=machines[d.machine_id].name if d.machine_id in machines else "—",
            cashier=doc_owner[d.id][1], created_at=iso(d.at), collected=float(d.collected),
            tip=float(d.tip), refund=d.refund,
        )
        for d in docs
    ]
    ended = now >= ends
    report["insights"] = R.build_insights(
        report, facts, th, median, tz=tz, ended=ended, is_draft=event.status == EVENT_DRAFT,
    )
    report["readiness"] = readiness(event, report, machines, now, tz)
    return report


def readiness(event: ReportEvent, report: Dict[str, Any], machines: Dict[str, POSMachine], now: datetime, tz) -> Dict[str, Any]:
    """What stands between the event and its confirmation (docs/SPEC_EVENTS.md §2.1)."""
    ends = utc(event.ends_at)
    blocking, warnings = [], []
    if now < ends:
        blocking.append({
            "code": "not_ended",
            "text": f"האירוע עוד לא הסתיים — הוא מסתיים ב-{ends.astimezone(tz).strftime('%d/%m/%Y %H:%M')}. "
                    "אישור עכשיו יקפיא דוח חלקי.",
        })
    if not machines:
        blocking.append({"code": "no_tills", "text": "לאירוע אין קופות."})
    for s in report["shifts"]:
        if s["status"] == "open":
            warnings.append({"code": "open_shift", "ref": s["shiftId"],
                             "text": f"ב-{s['machineName']} משמרת פתוחה שחופפת לחלון האירוע."})
        elif s["closesAfterWindow"]:
            warnings.append({"code": "shift_closes_after", "ref": s["shiftId"],
                             "text": f"משמרת של {s['machineName']} נסגרה אחרי סוף האירוע — ה-X/Z שלה כולל גם מכירות מחוץ לאירוע."})
    for mid, m in machines.items():
        if m.pending_documents:
            at = utc(m.pending_count_at)
            when = f" (נכון ל-{at.astimezone(tz).strftime('%d/%m %H:%M')})" if at else ""
            warnings.append({"code": "pending_documents", "ref": mid,
                             "text": f"ב-{m.name} {m.pending_documents} מסמכים שעוד לא הגיעו לענן{when}."})
        beat = utc(m.last_heartbeat_at)
        if now >= ends and (beat is None or beat < ends):
            warnings.append({"code": "no_heartbeat_since_end", "ref": mid,
                             "text": f"{m.name} לא דיווחה לענן מאז סוף האירוע — ייתכן שיש מסמכים שלא סונכרנו."})
    for t in report["reconciliation"]["z"]["tills"]:
        if t["pendingZ"]["count"]:
            warnings.append({"code": "pending_z", "ref": t["machineId"],
                             "text": f"{t['pendingZ']['count']} מסמכים של {t['name']} בחלון עוד לא נכללו ב-Z."})
    for t in report["reconciliation"]["transmissions"]["tills"]:
        if t["untransmitted"]["count"]:
            warnings.append({"code": "untransmitted", "ref": t["machineId"],
                             "text": f"{t['untransmitted']['count']} מכירות אשראי של {t['name']} עוד לא שודרו."})
    return {"ended": now >= ends, "blocking": blocking, "warnings": warnings, "checkedAt": iso(now)}


def report_for(db: Session, event: ReportEvent, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The snapshot of a confirmed event, else the live report."""
    if event.status == EVENT_CONFIRMED and event.snapshot:
        return {**event.snapshot, "frozen": True}
    return build_report(db, event, now=now)
