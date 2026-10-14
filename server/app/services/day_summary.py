"""
"סיכום יום" v2 (P:/specs/reports-designed-pdf.md §3, contract §7.3): one business day of a scope —
company, shops, points of sale, tills — in figures, against the same weekday a week before and the
average of that weekday over the last four weeks, with the day's insights, as JSON for the page
(`GET /reports/day-summary?date=`) and as the full designed PDF (`GET /reports/day-summary/pdf`).

**The day** is the business day — 04:00 to 04:00 local (`sales_targets.business_day_range`, the
day of the targets, the phone's "סיכום יום" and the insights).

**The money** is the reports' own (`reports._sales_buckets` over `build_scoped_transaction_query`):
the same documents, statuses and rules as every report, so a shop's figure here is the
per-cashier report's over the same hours. Net = gross − discounts − refunds; the average ticket
= (gross − discounts) ÷ sales; discounts without production vouchers' deductions.

**The scope** only narrows what the caller's role sees: `companyId` (that company and its
subsidiaries — also when no shop is picked, which the old day summary did not do), `shopIds`,
`areaIds` (the area each document's shift was stamped with, or `none`), `machineIds`.

Sections: KPIs (with a 7-day sparkline), insights, sales by hour against last week, shop → area →
till, payment methods (with orders paid at a till and credits with no money moved), departments,
top items, risers and fallers, tables, staff (with attendance hours when there are any), risks
(per employee; card legs not transmitted; drawer openings with no sale; cancelled documents;
the exceptions found) and kiosks.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.services import report_design as D
from app.services import report_insights as I
from app.services import report_pdf as P
from app.services.reports import (
    ReportWindow,
    _is_refund_condition,
    _load_cashier_names,
    _new_sales_bucket,
    _sales_buckets,
    _to_float,
    build_scoped_transaction_query,
    resolve_report_timezone,
    _load_zoneinfo,
)

AREA_NONE = "none"
WEEKDAYS = ("יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת", "יום ראשון")
TOP_ITEMS = 15
MOVERS = 5
OPEN_TABLES_LISTED = 30

PAYMENT_LABELS = {
    "cash": "מזומן", "card": "אשראי", "credit_card": "אשראי", "voucher": "שובר הפקה", "vouchers": "שובר הפקה",
    "production_voucher": "שובר הפקה", "prepaid_voucher": "שובר", "prepaid": "שובר", "exchange": "קיזוז החלפה",
    "mixed": "משולב", "other": "אחר", "credit": "הקפה", "on_account": "הקפה", "charge": "הקפה", "bit": "ביט",
    "paybox": "פייבוקס", "check": "צ׳ק", "cheque": "צ׳ק", "gift_card": "כרטיס מתנה", "external": "חיצוני",
}
EXCEPTION_LABELS = {
    "discount": "הנחה", "oth": "על חשבון הבית", "refund": "זיכוי", "drawer_open": "פתיחת מגירה ללא מכירה",
    "line_void": "ביטול שורה", "basket_cancel": "ביטול סל", "table_cancelled": "ביטול שולחן",
    "reprint": "הדפסה חוזרת", "high_tip": "טיפ גבוה", "high_amount": "סכום גבוה", "cash_difference": "הפרש קופה",
    "long_order": "הזמנה ארוכה", "attendance_manual": "נוכחות ידנית", "till_offline": "קופה לא מחוברת",
    "kiosk_offline": "קיוסק לא מחובר", "z_missing": "Z חסר", "user_session_release": "שחרור משתמש",
    "card_decision_override": "הכרעת אשראי ידנית", "forced_z_close": "סגירת Z בכפייה",
    "z_transmission_failed": "שידור Z נכשל", "offline_z_gap": "פער Z לא מקוון", "till_printer": "תקלת מדפסת",
}

#: (key, label, kind, icon) — the cards, in order (covers and per cover only when tables traded).
KPI_DEFS = (
    ("net", "מכירות נטו", "money", "sales"),
    ("gross", "מכירות ברוטו", "money", "sales"),
    ("documents", "עסקאות", "number", "receipt"),
    ("averageTicket", "ממוצע לעסקה", "money", "basket"),
    ("items", "פריטים", "number", "items"),
    ("covers", "סועדים", "number", "users"),
    ("perCover", "ממוצע לסועד", "money", "users"),
    ("refunds", "זיכויים", "money", "refund"),
    ("voids", "ביטולים", "money", "void"),
    ("discounts", "הנחות", "money", "discount"),
    ("oth", "על חשבון הבית", "money", "gift"),
    ("tips", "טיפים", "money", "tip"),
)


def _r(value: Any) -> float:
    return round(_to_float(value), 2)


def _pct_change(cur: Optional[float], prev: Optional[float]) -> Optional[float]:
    if cur is None or prev is None or not prev:
        return None
    return round((cur - prev) / abs(prev) * 100, 2)


def _share(part: float, whole: float) -> float:
    return round(part / whole * 100, 2) if whole else 0.0


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


# ── Scope and day ────────────────────────────────────────────────────────────


@dataclass
class Scope:
    company_id: Optional[uuid.UUID] = None
    shop_ids: List[uuid.UUID] = field(default_factory=list)
    area_ids: List[Any] = field(default_factory=list)  # UUIDs and/or "none"
    machine_ids: List[uuid.UUID] = field(default_factory=list)

    @property
    def narrows_tills(self) -> bool:
        return bool(self.area_ids or self.machine_ids)

    def as_json(self) -> Dict[str, Any]:
        return {
            "companyId": str(self.company_id) if self.company_id else None,
            "shopIds": [str(s) for s in self.shop_ids],
            "areaIds": [str(a) for a in self.area_ids],
            "machineIds": [str(m) for m in self.machine_ids],
        }


def parse_scope(company_id=None, shop_ids=None, area_ids=None, machine_ids=None) -> Scope:
    """The query's scope; an area is its id or `none` (anything else is a 422, as everywhere)."""
    from app.services.areas import parse_area_filter

    areas: List[Any] = []
    for raw in area_ids or []:
        parsed = parse_area_filter(raw if isinstance(raw, str) else str(raw))
        if parsed is not None and parsed not in areas:
            areas.append(parsed)
    return Scope(
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        shop_ids=[s for s in (shop_ids or []) if isinstance(s, uuid.UUID)],
        area_ids=areas,
        machine_ids=[m for m in (machine_ids or []) if isinstance(m, uuid.UUID)],
    )


def business_window(db: Session, tenant_id, day: date, tz: Optional[str] = None) -> ReportWindow:
    """The business day `day` as a report window (04:00 → 04:00 local, DST-safe)."""
    from app.services.sales_targets import business_day_range

    tz_name = resolve_report_timezone(db, tenant_id, tz)
    _load_zoneinfo(tz_name)  # an unknown zone is a 400
    start, end = business_day_range(day, tz_name)
    return ReportWindow(from_date=day, to_date=day, from_hour=None, to_hour=None, tz_name=tz_name, start=start, end=end)


def business_today(db: Session, tenant_id, tz: Optional[str] = None) -> date:
    from app.services.block_durations import business_today as today

    return today(datetime.now(timezone.utc), resolve_report_timezone(db, tenant_id, tz))


def _area_predicate(area_ids: Sequence[Any]):
    ids = [a for a in area_ids if isinstance(a, uuid.UUID)]
    clauses = []
    if ids:
        clauses.append(Transaction.shift_id.in_(select(Shift.id).where(Shift.area_id.in_(ids))))
    if any(a == AREA_NONE for a in area_ids):
        clauses.append(or_(
            Transaction.shift_id.is_(None),
            Transaction.shift_id.in_(select(Shift.id).where(Shift.area_id.is_(None))),
        ))
    return or_(*clauses) if clauses else None


def documents(db: Session, user: User, tenant_id, window: ReportWindow, scope: Scope):
    """The reportable documents of the window in the caller's scope, narrowed to the scope chosen."""
    q = build_scoped_transaction_query(db, user, tenant_id, window, company_id=scope.company_id)
    if q is None:
        return None
    if scope.shop_ids:
        q = q.filter(Transaction.shop_id.in_(scope.shop_ids))
    if scope.machine_ids:
        q = q.filter(Transaction.machine_id.in_(scope.machine_ids))
    pred = _area_predicate(scope.area_ids)
    if pred is not None:
        q = q.filter(pred)
    return q


def scope_machines(db: Session, user: User, tenant_id, scope: Scope) -> List[POSMachine]:
    """The tills the caller sees in the scope (an area: the tills standing in it now)."""
    from app.services.company_hierarchy import descendant_company_ids
    from app.services.scoping import scope_query_by_user

    q = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id)
    if user.role == UserRole.DISTRIBUTOR:
        q = q.filter(POSMachine.distributor_id == user.id)
    else:
        q = scope_query_by_user(q, user, db, shop_column=POSMachine.shop_id, machine_column=POSMachine.id)
        if q is None:
            return []
    if scope.company_id is not None:
        group = descendant_company_ids(db, scope.company_id)
        q = q.filter(POSMachine.shop_id.in_(select(Shop.id).where(Shop.company_id.in_(group))))
    if scope.shop_ids:
        q = q.filter(POSMachine.shop_id.in_(scope.shop_ids))
    if scope.machine_ids:
        q = q.filter(POSMachine.id.in_(scope.machine_ids))
    if scope.area_ids:
        ids = [a for a in scope.area_ids if isinstance(a, uuid.UUID)]
        clauses = [POSMachine.area_id.in_(ids)] if ids else []
        if AREA_NONE in scope.area_ids:
            clauses.append(POSMachine.area_id.is_(None))
        q = q.filter(or_(*clauses))
    return q.all()


def scope_label(db: Session, scope: Scope) -> str:
    from app.models.company import Company

    parts: List[str] = []

    def names(model, ids, limit=3) -> str:
        rows = [r.name for r in db.query(model).filter(model.id.in_(ids)).all()] if ids else []
        rows.sort()
        more = len(ids) - min(len(rows), limit)
        text = ", ".join(rows[:limit])
        return f"{text} ועוד {more}" if more > 0 else text

    if scope.company_id is not None:
        company = db.get(Company, scope.company_id)
        if company is not None:
            parts.append(company.name)
    if scope.shop_ids:
        parts.append(names(Shop, scope.shop_ids))
    if scope.area_ids:
        ids = [a for a in scope.area_ids if isinstance(a, uuid.UUID)]
        text = names(ShopArea, ids) if ids else ""
        if AREA_NONE in scope.area_ids:
            text = ", ".join(x for x in (text, "ללא נקודת מכירה") if x)
        parts.append(text)
    if scope.machine_ids:
        parts.append(names(POSMachine, scope.machine_ids))
    return " › ".join(p for p in parts if p) or "כל הסניפים"


# ── The figures of one day ───────────────────────────────────────────────────


def _bucket(q) -> Dict[str, float]:
    total = _new_sales_bucket()
    if q is None:
        return total
    for bucket in _sales_buckets(q, Transaction.tenant_id).values():
        for k, v in bucket.items():
            total[k] += v
    return total


def _lines_q(db: Session, q):
    sub = q.with_entities(
        Transaction.id.label("tx_id"),
        Transaction.cashier_id.label("cashier_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    return sub


def _till_events(db: Session, machine_ids: Sequence[uuid.UUID], window: ReportWindow, types: Sequence[str]):
    from app.models.audit_exception import TillEvent

    if not machine_ids:
        return None
    return db.query(TillEvent).filter(
        TillEvent.machine_id.in_(list(machine_ids)),
        TillEvent.occurred_at >= window.start,
        TillEvent.occurred_at < window.end,
        TillEvent.event_type.in_(list(types)),
    )


def _table_orders(db: Session, shop_ids: Sequence[uuid.UUID], machine_ids: Optional[Sequence[uuid.UUID]]):
    from app.models.tables import TableOrder

    if not shop_ids:
        return None
    q = db.query(TableOrder).filter(TableOrder.shop_id.in_(list(shop_ids)))
    if machine_ids is not None:
        ids = list(machine_ids)
        q = q.filter(or_(TableOrder.closed_machine_id.in_(ids), TableOrder.opened_machine_id.in_(ids)))
    return q


@dataclass
class _Ctx:
    db: Session
    user: User
    tenant_id: Any
    scope: Scope
    tz: Optional[str]
    machines: List[POSMachine]

    @property
    def machine_ids(self) -> List[uuid.UUID]:
        return [m.id for m in self.machines]

    @property
    def shop_ids(self) -> List[uuid.UUID]:
        return sorted({m.shop_id for m in self.machines if m.shop_id is not None}, key=str)

    @property
    def table_machines(self) -> Optional[List[uuid.UUID]]:
        return self.machine_ids if self.scope.narrows_tills else None


def figures(ctx: _Ctx, window: ReportWindow) -> Dict[str, Any]:
    """The day's KPI figures (§7.3) over `window`."""
    db = ctx.db
    q = documents(db, ctx.user, ctx.tenant_id, window, ctx.scope)
    b = _bucket(q)
    sales = int(b["sales_count"])
    net = b["gross"] - b["discounts"] - b["refunds"]
    out: Dict[str, Any] = {
        "net": _r(net),
        "gross": _r(b["gross"] - b["voucher_deductions"]),
        "documents": sales,
        "averageTicket": _r((b["gross"] - b["discounts"]) / sales) if sales else 0.0,
        "items": 0.0,
        "refunds": _r(b["refunds"]),
        "refundsCount": int(b["refunds_count"]),
        "discounts": _r(b["discounts"] - b["voucher_deductions"]),
        "discountsCount": 0,
        "oth": 0.0,
        "othCount": 0,
        "voids": 0.0,
        "voidsCount": 0,
        "tips": _r(b["tips"]),
        "covers": 0,
        "tableSales": 0.0,
        "perCover": None,
        "hasTables": False,
    }
    if q is not None:
        sub = _lines_q(db, q)
        qty = case((TransactionItem.voucher_memo_value.isnot(None), 0), else_=TransactionItem.quantity)
        items, oth, oth_lines = (
            db.query(
                func.coalesce(func.sum(case((sub.c.is_refund.is_(False), qty), else_=0)), 0),
                func.coalesce(func.sum(case(
                    (and_oth(sub), func.abs(TransactionItem.unit_price * TransactionItem.quantity)), else_=0)), 0),
                func.coalesce(func.sum(case((and_oth(sub), 1), else_=0)), 0),
            )
            .select_from(TransactionItem)
            .join(sub, sub.c.tx_id == TransactionItem.transaction_id)
            .one()
        )
        out["items"] = round(_to_float(items), 3)
        out["oth"] = _r(oth)
        out["othCount"] = int(oth_lines or 0)
        out["discountsCount"] = int(
            q.filter(~_is_refund_condition(), func.coalesce(Transaction.document_discount, 0) > 0)
            .with_entities(func.count(Transaction.id)).scalar() or 0
        )
    ev = _till_events(db, ctx.machine_ids, window, ("line_void", "basket_cancel"))
    if ev is not None:
        from app.models.audit_exception import TillEvent

        n, amount = ev.with_entities(func.count(TillEvent.id), func.coalesce(func.sum(func.abs(TillEvent.amount)), 0)).one()
        out["voids"], out["voidsCount"] = _r(amount), int(n or 0)
    tq = _table_orders(db, ctx.shop_ids, ctx.table_machines)
    if tq is not None:
        from app.models.tables import TableOrder

        opened = tq.filter(TableOrder.opened_at >= window.start, TableOrder.opened_at < window.end).count()
        guests, paid = (
            tq.filter(TableOrder.status == "paid", TableOrder.closed_at >= window.start, TableOrder.closed_at < window.end)
            .with_entities(func.coalesce(func.sum(TableOrder.guests), 0), func.coalesce(func.sum(TableOrder.paid_total), 0))
            .one()
        )
        out["covers"] = int(guests or 0)
        out["tableSales"] = _r(paid)
        out["perCover"] = _r(_to_float(paid) / int(guests)) if guests else None
        out["hasTables"] = bool(opened or guests or paid)
    return out


def and_oth(sub):
    """A sale line given on the house (`oth_reason`), as the discounts report counts it."""
    from sqlalchemy import and_

    return and_(sub.c.is_refund.is_(False), TransactionItem.oth_reason.isnot(None))


# ── Sections ─────────────────────────────────────────────────────────────────


def _pg(db: Session) -> bool:
    return db.get_bind().dialect.name == "postgresql"


def hourly(db: Session, q, window: ReportWindow) -> Dict[int, Tuple[float, int]]:
    """Net and documents per local hour (Postgres: by its tzdata; elsewhere in Python)."""
    from app.services.extra_reports import _local, _signed_document_net

    if q is None:
        return {}
    out: Dict[int, List] = {}
    net = _signed_document_net()
    if _pg(db):
        hour = func.extract("hour", func.timezone(window.tz_name, Transaction.created_at))
        rows = q.with_entities(hour.label("k"), func.coalesce(func.sum(net), 0), func.count(Transaction.id)).group_by(hour).all()
        for k, v, n in rows:
            acc = out.setdefault(int(k), [0.0, 0])
            acc[0] += _to_float(v)
            acc[1] += int(n or 0)
    else:
        rows = q.with_entities(Transaction.created_at, func.coalesce(func.sum(net), 0), func.count(Transaction.id)).group_by(
            Transaction.created_at).all()
        for moment, v, n in rows:
            m = moment if isinstance(moment, datetime) else datetime.fromisoformat(str(moment))
            acc = out.setdefault(_local(window, m).hour, [0.0, 0])
            acc[0] += _to_float(v)
            acc[1] += int(n or 0)
    return {h: (round(v[0], 2), v[1]) for h, v in out.items()}


def _items(db: Session, q) -> Dict[Any, Dict[str, Any]]:
    """Per product: units and net (a credit's lines subtract), by the line as sold."""
    from app.models.category import Category
    from app.models.product import Product

    if q is None:
        return {}
    sub = _lines_q(db, q)
    is_refund = sub.c.is_refund
    qty = case((TransactionItem.voucher_memo_value.isnot(None), 0), else_=TransactionItem.quantity)
    line_discount = (func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0)
                     + func.coalesce(TransactionItem.voucher_discount, 0))
    rows = (
        db.query(
            TransactionItem.product_id, TransactionItem.product_name, Product.category_id,
            func.coalesce(func.sum(case((is_refund.is_(True), -qty), else_=qty)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), TransactionItem.total_price - line_discount),
                                        else_=-TransactionItem.total_price)), 0),
        )
        .select_from(TransactionItem)
        .join(sub, sub.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .group_by(TransactionItem.product_id, TransactionItem.product_name, Product.category_id)
        .all()
    )
    cats = {c.id: c.name for c in db.query(Category).filter(Category.id.in_({r[2] for r in rows if r[2]})).all()} if rows else {}
    out: Dict[Any, Dict[str, Any]] = {}
    for pid, name, cat, units, net in rows:
        key = str(pid) if pid else f"name:{name}"
        acc = out.setdefault(key, {"productId": str(pid) if pid else None, "name": name or P.DASH, "categoryId": cat,
                                   "department": cats.get(cat) if cat else None, "units": 0.0, "net": 0.0})
        acc["units"] += _to_float(units)
        acc["net"] += _to_float(net)
    return out


def _departments(items: Dict[Any, Dict[str, Any]]) -> Dict[Any, Dict[str, Any]]:
    out: Dict[Any, Dict[str, Any]] = {}
    for it in items.values():
        key = str(it["categoryId"]) if it["categoryId"] else None
        acc = out.setdefault(key, {"id": key, "name": it["department"] or "ללא מחלקה", "units": 0.0, "net": 0.0})
        acc["units"] += it["units"]
        acc["net"] += it["net"]
    return out


def _with_change(rows: List[Dict[str, Any]], previous: Dict[Any, Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    for r in rows:
        prev = previous.get(r[key]) if r[key] is not None else previous.get(None)
        last = _r(prev["net"]) if prev else 0.0
        r["lastWeekNet"] = last
        r["changePct"] = _pct_change(r["net"], last)
    return rows


def hierarchy(ctx: _Ctx, q, q_last) -> List[Dict[str, Any]]:
    """Shop → point of sale → till: each one's net, share, documents, average and change."""
    db = ctx.db
    if q is None:
        return []
    joins = ((Shift, Shift.id == Transaction.shift_id),)
    levels = {
        "shop": (_sales_buckets(q, Transaction.shop_id), _sales_buckets(q_last, Transaction.shop_id) if q_last is not None else {}),
        "area": (_sales_buckets(q, Shift.area_id, joins=joins),
                 _sales_buckets(q_last, Shift.area_id, joins=joins) if q_last is not None else {}),
        "till": (_sales_buckets(q, Transaction.machine_id),
                 _sales_buckets(q_last, Transaction.machine_id) if q_last is not None else {}),
    }
    total = sum(b["gross"] - b["discounts"] - b["refunds"] for k, b in levels["shop"][0].items() if k is not None)

    def get(level, key):
        cur, last = levels[level]
        b = cur.get(key) or cur.get(str(key))
        lb = last.get(key) or last.get(str(key))
        return b, lb

    def row(level, ident, name, parent, b, lb) -> Dict[str, Any]:
        net = (b["gross"] - b["discounts"] - b["refunds"]) if b else 0.0
        sales = int(b["sales_count"]) if b else 0
        last = (lb["gross"] - lb["discounts"] - lb["refunds"]) if lb else 0.0
        return {
            "level": level, "id": str(ident) if ident else None, "parentId": str(parent) if parent else None,
            "name": name, "net": _r(net), "share": _share(net, total),
            "documents": sales + (int(b["refunds_count"]) if b else 0),
            "averageTicket": _r((b["gross"] - b["discounts"]) / sales) if b and sales else 0.0,
            "lastWeekNet": _r(last), "changePct": _pct_change(_r(net), _r(last)),
        }

    shop_ids = {k for k in levels["shop"][0] if k is not None} | {k for k in levels["shop"][1] if k is not None}
    till_ids = {k for k in levels["till"][0] if k is not None} | {k for k in levels["till"][1] if k is not None}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
    tills = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(till_ids))).all()} if till_ids else {}
    area_ids = {k for k in levels["area"][0] if k is not None} | {m.area_id for m in tills.values() if m.area_id}
    areas = {a.id: a for a in db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).all()} if area_ids else {}

    def num_key(raw, name):
        s = str(raw or "").strip()
        return (not s.isdigit(), int(s) if s.isdigit() else 0, (name or "").lower())

    out: List[Dict[str, Any]] = []
    for shop in sorted(shops.values(), key=lambda s: (s.shop_number is None, s.shop_number or 0, (s.name or "").lower())):
        b, lb = get("shop", shop.id)
        out.append(row("shop", shop.id, shop.name, None, b, lb))
        own_tills = sorted((m for m in tills.values() if m.shop_id == shop.id), key=lambda m: num_key(m.pos_number, m.name))
        own_areas = sorted({m.area_id for m in own_tills if m.area_id} | {a.id for a in areas.values() if a.shop_id == shop.id},
                           key=lambda a: ((areas[a].sort_order or 0) if a in areas else 0, (areas[a].name if a in areas else "")))
        for area_id in own_areas:
            ab, alb = get("area", area_id)
            area = areas.get(area_id)
            if not ab and not alb:
                continue
            out.append(row("area", area_id, area.name if area else P.DASH, shop.id, ab, alb))
            for m in own_tills:
                if m.area_id == area_id:
                    tb, tlb = get("till", m.id)
                    if tb or tlb:
                        out.append(row("till", m.id, _till_name(m), area_id, tb, tlb))
        for m in own_tills:
            if not m.area_id or m.area_id not in own_areas or not (get("area", m.area_id)[0] or get("area", m.area_id)[1]):
                tb, tlb = get("till", m.id)
                if tb or tlb:
                    out.append(row("till", m.id, _till_name(m), shop.id, tb, tlb))
    return out


def _till_name(m: POSMachine) -> str:
    pos = (m.pos_number or "").strip()
    name = (m.name or "").strip()
    if pos and name and pos not in name:
        return f"{name} ({pos})"
    return name or (f"קופה {pos}" if pos else P.DASH)


def payment_methods(q) -> List[Dict[str, Any]]:
    from app.services.all_in_one import by_payment_method

    if q is None:
        return []
    rows = by_payment_method(q)
    for r in rows:
        r["label"] = PAYMENT_LABELS.get((r["method"] or "").lower(), r["method"])
    return [r for r in rows if r["amount"] or r["documents"]]


def pay_at_till(ctx: _Ctx, window: ReportWindow) -> Dict[str, Any]:
    from app.models.kiosk import KioskOrder

    if not ctx.shop_ids:
        return {"orders": 0, "amount": 0.0}
    q = ctx.db.query(func.count(KioskOrder.id), func.coalesce(func.sum(KioskOrder.total_agorot), 0)).filter(
        KioskOrder.shop_id.in_(ctx.shop_ids), KioskOrder.pay_at_till.is_(True), KioskOrder.open_state == "paid",
        KioskOrder.paid_at >= window.start, KioskOrder.paid_at < window.end,
    )
    n, agorot = q.one()
    return {"orders": int(n or 0), "amount": round(int(agorot or 0) / 100, 2)}


def no_money_movement(q) -> Dict[str, Any]:
    if q is None:
        return {"documents": 0, "amount": 0.0}
    n, amount = q.filter(Transaction.no_money_movement.is_(True)).with_entities(
        func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)).one()
    return {"documents": int(n or 0), "amount": _r(amount)}


def tables(ctx: _Ctx, window: ReportWindow) -> Optional[Dict[str, Any]]:
    from app.models.tables import TableOrder

    tq = _table_orders(ctx.db, ctx.shop_ids, ctx.table_machines)
    if tq is None:
        return None
    opened = tq.filter(TableOrder.opened_at >= window.start, TableOrder.opened_at < window.end).all()
    closed = tq.filter(TableOrder.closed_at >= window.start, TableOrder.closed_at < window.end).all()
    paid = [o for o in closed if o.status == "paid"]
    cancelled = [o for o in closed if o.status in ("cancelled", "void")]
    still = [o for o in opened if o.status == "open" or (o.closed_at is not None and _aware(o.closed_at) >= window.end)]
    if not opened and not closed:
        return None
    seated = [(_aware(o.closed_at) - _aware(o.opened_at)).total_seconds() / 60 for o in paid if o.closed_at and o.opened_at]
    paid_total = sum(_to_float(o.paid_total) for o in paid)
    guests_paid = sum(int(o.guests or 0) for o in paid)
    zone = _load_zoneinfo(window.tz_name)
    return {
        "opened": len(opened),
        "paid": len(paid),
        "cancelled": len(cancelled),
        "stillOpen": len(still),
        "guests": sum(int(o.guests or 0) for o in opened),
        "averageSeatedMinutes": round(sum(seated) / len(seated), 1) if seated else None,
        "averagePerTable": _r(paid_total / len(paid)) if paid else None,
        "averagePerCover": _r(paid_total / guests_paid) if guests_paid else None,
        "open": [
            {
                "name": o.table_name or (f"שולחן {o.table_number}" if o.table_number is not None else P.DASH),
                "openedAt": _iso(o.opened_at),
                "openedLocal": _aware(o.opened_at).astimezone(zone).strftime("%H:%M") if o.opened_at else None,
                "total": _r(o.total),
                "guests": o.guests,
                "waiter": o.waiter_pos_user_name or o.opened_by_pos_user_name,
            }
            for o in sorted(still, key=lambda o: _aware(o.opened_at))[:OPEN_TABLES_LISTED]
        ],
    }


def staff(ctx: _Ctx, q, window: ReportWindow) -> List[Dict[str, Any]]:
    from app.services.all_in_one import by_employee

    if q is None:
        return []
    rows = by_employee(ctx.db, q)
    hours = attendance_hours(ctx, window)
    out = []
    for r in rows:
        out.append({
            "cashierId": r["cashierId"], "name": r["cashierName"] or P.DASH, "net": r["net"],
            "documents": r["documents"], "averageTicket": r["averageBasket"], "tips": r["tips"],
            "discounts": r["discounts"], "hours": hours.pop(str(r["cashierId"]), None) if r["cashierId"] else None,
        })
    if hours:
        names = _load_cashier_names(ctx.db, list(hours))
        from app.services.reports import _display_name

        for pid, h in hours.items():
            out.append({"cashierId": pid, "name": _display_name(names.get(pid)) or pid, "net": 0.0, "documents": 0,
                        "averageTicket": 0.0, "tips": 0.0, "discounts": 0.0, "hours": h})
    return out


def attendance_hours(ctx: _Ctx, window: ReportWindow) -> Dict[str, float]:
    """Hours each employee clocked inside the day (a shift that runs past either end is cut)."""
    from app.models.attendance import AttendanceShift as A

    if not ctx.shop_ids:
        return {}
    now = datetime.now(timezone.utc)
    rows = ctx.db.query(A.pos_user_id, A.clock_in_at, A.clock_out_at).filter(
        A.shop_id.in_(ctx.shop_ids), A.clock_in_at < window.end,
        or_(A.clock_out_at.is_(None), A.clock_out_at > window.start),
    ).all()
    out: Dict[str, float] = {}
    for pid, cin, cout in rows:
        a = max(_aware(cin), window.start)
        b = min(_aware(cout) or min(now, window.end), window.end)
        if b > a:
            out[str(pid)] = round(out.get(str(pid), 0.0) + (b - a).total_seconds() / 3600, 2)
    return out


def risks(ctx: _Ctx, q, window: ReportWindow, staff_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    from app.models.audit_exception import AuditException, TillEvent
    from app.models.tables import TableOrder
    from app.services.reports import _display_name
    from app.services.scoping import scope_transactions_by_user

    db = ctx.db
    per: Dict[str, Dict[str, Any]] = {}

    def acc(pid: Optional[str], name: Optional[str] = None) -> Dict[str, Any]:
        key = pid or f"name:{name or P.DASH}"
        return per.setdefault(key, {"id": pid, "name": name, "refunds": 0.0, "refundsCount": 0, "voids": 0.0,
                                    "voidsCount": 0, "tableCancels": 0, "discounts": 0.0, "oth": 0.0, "drawerOpens": 0})

    if q is not None:
        for cid, n, amount in q.filter(_is_refund_condition()).with_entities(
                Transaction.cashier_id, func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)
        ).group_by(Transaction.cashier_id).all():
            a = acc(cid)
            a["refunds"] += _r(amount)
            a["refundsCount"] += int(n or 0)
        sub = _lines_q(db, q)
        who = func.coalesce(TransactionItem.oth_by, sub.c.cashier_id)
        for pid, amount in (
            db.query(who, func.coalesce(func.sum(func.abs(TransactionItem.unit_price * TransactionItem.quantity)), 0))
            .select_from(TransactionItem).join(sub, sub.c.tx_id == TransactionItem.transaction_id)
            .filter(and_oth(sub)).group_by(who).all()
        ):
            acc(pid)["oth"] += _r(amount)
    for r in staff_rows:
        if r.get("discounts"):
            acc(r["cashierId"], r["name"])["discounts"] += r["discounts"]
    ev = _till_events(db, ctx.machine_ids, window, ("line_void", "basket_cancel", "drawer_open"))
    drawer_opens = 0
    if ev is not None:
        for kind, pid, n, amount in ev.with_entities(
                TillEvent.event_type, TillEvent.pos_user_id, func.count(TillEvent.id),
                func.coalesce(func.sum(func.abs(TillEvent.amount)), 0)).group_by(TillEvent.event_type, TillEvent.pos_user_id).all():
            a = acc(pid)
            if kind == "drawer_open":
                a["drawerOpens"] += int(n or 0)
                drawer_opens += int(n or 0)
            else:
                a["voids"] += _r(amount)
                a["voidsCount"] += int(n or 0)
    tq = _table_orders(db, ctx.shop_ids, ctx.table_machines)
    if tq is not None:
        for o in tq.filter(TableOrder.status.in_(("cancelled", "void")), TableOrder.closed_at >= window.start,
                           TableOrder.closed_at < window.end).all():
            acc(o.closed_by_pos_user_id or o.waiter_pos_user_id,
                o.closed_by_pos_user_name or o.waiter_pos_user_name)["tableCancels"] += 1
    ids = [k for k in per if not k.startswith("name:")]
    names = _load_cashier_names(db, ids)
    rows = []
    for key, a in per.items():
        if not any(a[f] for f in ("refunds", "voids", "tableCancels", "discounts", "oth", "drawerOpens")):
            continue
        name = a["name"] or _display_name(names.get(key)) or (key if not key.startswith("name:") else P.DASH)
        rows.append({k: v for k, v in a.items() if k != "id"} | {"name": name})
    rows.sort(key=lambda r: -(r["refunds"] + r["voids"] + r["discounts"] + r["oth"]))

    from app.services import transmissions as T

    untransmitted = T.untransmitted_summary(db, ctx.machine_ids)
    names_of = {m.id: _till_name(m) for m in ctx.machines}
    tills = [
        {"machineId": str(mid), "name": names_of.get(mid, P.DASH), "count": c, "amount": _r(amount)}
        for mid, (c, amount, _oldest) in untransmitted.items() if c
    ]
    cancelled = {"count": 0, "amount": 0.0}
    cq = scope_transactions_by_user(
        db.query(Transaction).filter(
            Transaction.tenant_id == ctx.tenant_id, Transaction.status == TransactionStatus.CANCELLED,
            Transaction.created_at >= window.start, Transaction.created_at < window.end,
        ), ctx.user, db,
    )
    if cq is not None:
        if ctx.scope.company_id is not None or ctx.scope.shop_ids or ctx.scope.narrows_tills:
            cq = cq.filter(Transaction.machine_id.in_(ctx.machine_ids or [uuid.uuid4()]))
        n, amount = cq.with_entities(func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)).one()
        cancelled = {"count": int(n or 0), "amount": _r(amount)}
    exceptions = []
    if ctx.machine_ids or ctx.shop_ids:
        eq = db.query(AuditException.exception_type, func.count(AuditException.id)).filter(
            AuditException.tenant_id == ctx.tenant_id,
            AuditException.occurred_at >= window.start, AuditException.occurred_at < window.end,
            or_(AuditException.machine_id.in_(ctx.machine_ids or [uuid.uuid4()]),
                (AuditException.machine_id.is_(None) & AuditException.shop_id.in_(ctx.shop_ids or [uuid.uuid4()]))),
        ).group_by(AuditException.exception_type)
        exceptions = sorted(
            ({"type": t, "label": EXCEPTION_LABELS.get(t, t), "count": int(n or 0)} for t, n in eq.all()),
            key=lambda r: -r["count"],
        )
    return {
        "byEmployee": rows,
        "untransmittedCard": {"count": sum(t["count"] for t in tills), "amount": _r(sum(t["amount"] for t in tills)),
                              "tills": tills},
        "drawerOpensNoSale": drawer_opens,
        "cancelledDocuments": cancelled,
        "exceptions": exceptions,
    }


def kiosks(ctx: _Ctx, q, window: ReportWindow) -> Optional[Dict[str, Any]]:
    from app.services.z_table import kiosk_machine_ids

    ids = kiosk_machine_ids(ctx.db, ctx.machine_ids)
    if not ids:
        return None
    rows = []
    totals = _new_sales_bucket()
    if q is not None:
        for mid, b in _sales_buckets(q.filter(Transaction.machine_id.in_(list(ids))), Transaction.machine_id).items():
            sales = int(b["sales_count"])
            for k, v in b.items():
                totals[k] += v
            rows.append({"machineId": str(mid), "name": next((_till_name(m) for m in ctx.machines if m.id == mid), P.DASH),
                         "net": _r(b["gross"] - b["discounts"] - b["refunds"]), "documents": sales + int(b["refunds_count"])})
    head: Dict[str, Any] = {}
    try:
        from app.services.kiosk_insights import _headline_sessions

        head = _headline_sessions(ctx.db, list(ids), window.start, window.end)
    except Exception:  # noqa: BLE001 — the kiosks' sessions are a bonus, never the summary's failure
        head = {}
    sales = int(totals["sales_count"])
    if not rows and not head.get("sessions"):
        return None
    rows.sort(key=lambda r: -r["net"])
    return {
        "orders": sales,
        "net": _r(totals["gross"] - totals["discounts"] - totals["refunds"]),
        "averageTicket": _r((totals["gross"] - totals["discounts"]) / sales) if sales else 0.0,
        "sessions": int(head.get("sessions") or 0),
        "abandoned": int(head.get("abandoned") or 0),
        "medianOrderSec": head.get("medianOrderSec"),
        "byKiosk": rows,
    }


# ── The report ───────────────────────────────────────────────────────────────


def build(db: Session, user: User, tenant_id, *, day: Optional[date] = None, tz: Optional[str] = None,
          scope: Optional[Scope] = None) -> Dict[str, Any]:
    """The day summary v2 JSON (§7.3)."""
    scope = scope or Scope()
    day = day or business_today(db, tenant_id, tz)
    window = business_window(db, tenant_id, day, tz)
    ctx = _Ctx(db=db, user=user, tenant_id=tenant_id, scope=scope, tz=tz, machines=scope_machines(db, user, tenant_id, scope))

    last_week = day - timedelta(days=7)
    weeks = [day - timedelta(days=7 * k) for k in range(1, 5)]
    spark_days = [day - timedelta(days=k) for k in range(6, -1, -1)]
    windows: Dict[date, ReportWindow] = {d: business_window(db, tenant_id, d, tz) for d in set(weeks) | set(spark_days)}
    figs: Dict[date, Dict[str, Any]] = {d: figures(ctx, w) for d, w in windows.items()}
    today = figs[day]
    has_tables = any(f["hasTables"] for f in figs.values())

    kpis = []
    for key, label, kind, icon in KPI_DEFS:
        if key in ("covers", "perCover") and not has_tables:
            continue
        value = today[key]
        last = figs[last_week][key]
        hist = [figs[w][key] for w in weeks if figs[w][key] is not None]
        avg = round(sum(hist) / len(hist), 2) if hist else None
        item = {
            "key": key, "label": label, "kind": kind, "icon": icon, "better": D.better_of(key),
            "value": value, "lastWeek": last, "avg4w": avg,
            "changePct": _pct_change(value, last), "changePctAvg": _pct_change(value, avg),
            "spark": [figs[d][key] or 0 for d in spark_days], "sparkDays": [d.isoformat() for d in spark_days],
        }
        if key in ("refunds", "voids", "discounts", "oth"):
            item["count"] = today[f"{key}Count"]
        kpis.append(item)

    q = documents(db, user, tenant_id, window, scope)
    q_last = documents(db, user, tenant_id, windows[last_week], scope)
    hours_now = hourly(db, q, window)
    hours_last = hourly(db, q_last, windows[last_week])
    start_hour = window.start.astimezone(_load_zoneinfo(window.tz_name)).hour
    hourly_rows = []
    for i in range(24):
        h = (start_hour + i) % 24
        n, d = hours_now.get(h, (0.0, 0))
        ln, ld = hours_last.get(h, (0.0, 0))
        hourly_rows.append({"hour": h, "label": f"{h:02d}:00", "net": n, "documents": d, "lastWeekNet": ln,
                            "lastWeekDocuments": ld})

    items_now, items_last = _items(db, q), _items(db, q_last)
    total_net = today["net"]
    deps_now, deps_last = _departments(items_now), _departments(items_last)
    departments = sorted(
        ({"id": k, "name": v["name"], "units": round(v["units"], 3), "net": _r(v["net"]), "share": _share(v["net"], total_net)}
         for k, v in deps_now.items()),
        key=lambda r: -r["net"],
    )
    _with_change(departments, deps_last, "id")
    item_rows = [
        {"key": k, "productId": v["productId"], "name": v["name"], "department": v["department"],
         "units": round(v["units"], 3), "net": _r(v["net"]), "share": _share(v["net"], total_net)}
        for k, v in items_now.items()
    ]
    item_rows.sort(key=lambda r: -r["net"])
    for r in item_rows:
        prev = items_last.get(r["key"])
        r["lastWeekNet"] = _r(prev["net"]) if prev else 0.0
        r["changePct"] = _pct_change(r["net"], r["lastWeekNet"])
    movers = []
    for k in set(items_now) | set(items_last):
        cur = _r(items_now[k]["net"]) if k in items_now else 0.0
        prev = _r(items_last[k]["net"]) if k in items_last else 0.0
        src = items_now.get(k) or items_last.get(k)
        movers.append({"productId": src["productId"], "name": src["name"], "net": cur, "lastWeekNet": prev,
                       "change": _r(cur - prev), "changePct": _pct_change(cur, prev)})
    risers = sorted((m for m in movers if m["change"] > 0), key=lambda m: -m["change"])[:MOVERS]
    fallers = sorted((m for m in movers if m["change"] < 0), key=lambda m: m["change"])[:MOVERS]
    top_items = [{k: v for k, v in r.items() if k != "key"} for r in item_rows[:TOP_ITEMS]]

    staff_rows = staff(ctx, q, window)
    out = {
        "version": 2,
        "date": day.isoformat(),
        "weekday": WEEKDAYS[day.weekday()],
        "businessDay": {"start": window.start.isoformat(), "end": window.end.isoformat(),
                        "startHour": start_hour, "timezone": window.tz_name},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": {**scope.as_json(), "label": scope_label(db, scope)},
        "compare": {"lastWeek": last_week.isoformat(), "weeks": [w.isoformat() for w in weeks]},
        "empty": not (today["documents"] or today["refundsCount"]),
        "kpis": kpis,
        "hourly": hourly_rows,
        "hierarchy": hierarchy(ctx, q, q_last),
        "paymentMethods": payment_methods(q),
        "payAtTill": pay_at_till(ctx, window),
        "noMoneyMovement": no_money_movement(q),
        "departments": departments,
        "topItems": top_items,
        "risers": risers,
        "fallers": fallers,
        "tables": tables(ctx, window),
        "staff": staff_rows,
        "risks": risks(ctx, q, window, staff_rows),
        "kiosks": kiosks(ctx, q, window),
    }
    out["insights"] = [i.as_json() for i in insights(out)]
    return out


# ── The day's insights ───────────────────────────────────────────────────────


def _kpi(data: Dict[str, Any], key: str) -> Optional[Dict[str, Any]]:
    return next((k for k in data["kpis"] if k["key"] == key), None)


def insights(data: Dict[str, Any]) -> List[D.Insight]:
    """The day's sentences (§1.3), best first, at most seven; none when the day is empty."""
    if data.get("empty"):
        return []
    found: List[Tuple[float, D.Insight]] = []

    def say(score: float, kind: str, text: str) -> None:
        found.append((score, D.Insight(kind, text)))

    fmt = lambda v, kind="money": D.format_value(v, kind, short=True)  # noqa: E731
    cards = [
        D.Kpi(key=k["key"], label=k["label"], value=k["value"], kind=k["kind"], compare=k["lastWeek"],
              compare_label="שבוע שעבר", better=k["better"])
        for k in data["kpis"] if k["key"] in ("net", "documents", "averageTicket", "items", "covers")
    ]
    for f in I.kpi_findings(cards):
        found.append((f.score, f.insight))
    net = _kpi(data, "net")
    if net and net["avg4w"]:
        pct = _pct_change(net["value"], net["avg4w"])
        if pct is not None and abs(pct) >= 5:
            say(84, "up" if pct > 0 else "down",
                f"מכירות נטו: {I._p(pct)} {'מעל ממוצע' if pct > 0 else 'מתחת לממוצע'} 4 השבועות האחרונים באותו יום "
                f"({fmt(net['avg4w'])})")

    # Hours.
    active = {r["hour"]: r["net"] for r in data["hourly"] if r["net"] > 0}
    total = sum(active.values())
    if len(active) >= 3 and total > 0:
        peak = max(active, key=lambda h: active[h])
        low = min(active, key=lambda h: active[h])
        say(80, "leader", f"שעת השיא: {I.hour_range(peak)} — {fmt(active[peak])} ({I._p(active[peak] / total * 100)} מהיום)")
        last = next((r["lastWeekNet"] for r in data["hourly"] if r["hour"] == peak), 0)
        say(52, "down", f"השעה החלשה: {I.hour_range(low)} — {fmt(active[low])}")
        if last and active[peak] < last * 0.8:
            say(60, "alert", f"שעת השיא חלשה מבשבוע שעבר: {fmt(active[peak])} מול {fmt(last)}")

    # Shops, points of sale, tills.
    shops = [r for r in data["hierarchy"] if r["level"] == "shop" and r["net"] > 0]
    if len(shops) >= 2:
        top = max(shops, key=lambda r: r["net"])
        say(78, "leader", f"הסניף המוביל: {top['name']} — {fmt(top['net'])}, {I._p(top['share'])} מהיום")
    tills = [r for r in data["hierarchy"] if r["level"] == "till"]
    if len(tills) >= I.MIN_OUTLIER_ROWS:
        values = [r["net"] for r in tills]
        med = I.median(values)
        for r in tills:
            z = I.robust_z(r["net"], values)
            if med and med > 0 and z is not None and abs(z) >= I.ROBUST_Z and abs(r["net"] - med) / med >= I.OUTLIER_RATIO:
                say(74, "alert", f"קופה חריגה: {r['name']} — {fmt(r['net'])}, מול חציון של {fmt(med)} לקופה")
                break
    deps = [d for d in data["departments"] if d["net"] > 0]
    if len(deps) >= 2:
        say(66, "leader", f"המחלקה המובילה: {deps[0]['name']} — {I._p(deps[0]['share'])} מהמכירות")
    if data["topItems"] and data["topItems"][0]["net"] > 0:
        it = data["topItems"][0]
        say(64, "leader", f"הפריט המוביל: {it['name']} — {fmt(it['units'], 'number')} יח׳, {fmt(it['net'])}")
    if data["risers"]:
        r = data["risers"][0]
        if r["lastWeekNet"] > 0:
            say(70, "up", f"העלייה הגדולה מול שבוע שעבר: {r['name']} — מ-{fmt(r['lastWeekNet'])} ל-{fmt(r['net'])}")
    if data["fallers"]:
        r = data["fallers"][0]
        say(69, "down", f"הירידה הגדולה מול שבוע שעבר: {r['name']} — מ-{fmt(r['lastWeekNet'])} ל-{fmt(r['net'])}")

    # Risks: above the usual for this weekday.
    for key, label in (("refunds", "זיכויים"), ("voids", "ביטולים"), ("discounts", "הנחות"), ("oth", "על חשבון הבית")):
        k = _kpi(data, key)
        if not k or not k["value"]:
            continue
        usual = k["avg4w"] or 0
        if usual and k["value"] >= usual * 1.5 and k["value"] - usual >= 50:
            say(88, "alert", f"{label} מעל הרגיל: {fmt(k['value'])} מול ממוצע של {fmt(usual)} לאותו יום ({I._p(_pct_change(k['value'], usual) or 0)} יותר)")
        elif not usual and k["value"] >= 200:
            say(72, "alert", f"{label}: {fmt(k['value'])} — אין כאלה בדרך כלל באותו יום")
    people = data["risks"]["byEmployee"]
    refunds_total = sum(p["refunds"] for p in people)
    if refunds_total > 0:
        top = max(people, key=lambda p: p["refunds"])
        if top["refundsCount"] >= 3 and top["refunds"] >= refunds_total * 0.5 and len(people) > 1:
            say(82, "alert", f"{I._p(top['refunds'] / refunds_total * 100)} מהזיכויים אצל {top['name']} "
                             f"({top['refundsCount']} זיכויים, {fmt(top['refunds'])})")
    card = data["risks"]["untransmittedCard"]
    if card["count"]:
        what = "עסקת אשראי אחת לא שודרה" if card["count"] == 1 else f"{card['count']} עסקאות אשראי לא שודרו"
        say(96, "alert", f"{what} ({fmt(card['amount'])}) — יש לשדר מהקופה")
    if data["risks"]["drawerOpensNoSale"] >= 3:
        say(76, "alert", f"{data['risks']['drawerOpensNoSale']} פתיחות מגירה ללא מכירה")
    if data["tables"] and data["tables"]["stillOpen"]:
        n = data["tables"]["stillOpen"]
        say(79, "alert", "שולחן אחד נשאר פתוח בסוף היום" if n == 1 else f"{n} שולחנות נשארו פתוחים בסוף היום")
    if data["kiosks"] and data["kiosks"]["sessions"] >= 10:
        k = data["kiosks"]
        left = k["abandoned"] / k["sessions"] * 100
        if left >= 30:
            say(58, "tip", f"בקיוסקים {I._p(left)} מההזמנות ננטשו ({k['abandoned']} מתוך {k['sessions']})")
    if len(active) >= 3 and total > 0:
        low = min(active, key=lambda h: active[h])
        if active[low] / total < 0.02:
            say(34, "tip", f"שקלו מבצע בשעה החלשה ({I.hour_range(low)}) כדי להגדיל את התנועה")
    found.sort(key=lambda f: -f[0])
    out: List[D.Insight] = []
    for _score, ins in found:
        if ins.text not in {i.text for i in out}:
            out.append(ins)
        if len(out) >= I.MAX_INSIGHTS:
            break
    return out


# ── The PDF ──────────────────────────────────────────────────────────────────


def _col(key: str, label: str, kind: str = "text", **kw) -> P.Column:
    return P.column_of({"key": key, "label": label, "kind": kind, **kw})


def _cells(columns: Sequence[P.Column], rows: Sequence[Dict[str, Any]]) -> List[List[str]]:
    return [[P.format_cell(r.get(c.key), c.kind) for c in columns] for r in rows]


def document(data: Dict[str, Any], *, branding: Optional[Dict[str, Any]] = None, user_name: str = "") -> D.Document:
    """The full designed PDF of a day summary (§3, §5)."""
    branding = branding or {}
    day = date.fromisoformat(data["date"])
    tz = data["businessDay"]["timezone"]
    start_h = data["businessDay"]["startHour"]
    last_week = date.fromisoformat(data["compare"]["lastWeek"])
    blocks: List[Any] = []
    kpis = [
        D.Kpi(key=k["key"], label=k["label"], value=k["value"], kind=k["kind"], compare=k["lastWeek"],
              compare_label="שבוע שעבר", spark=[float(v or 0) for v in k["spark"]], better=k["better"], icon=k["icon"])
        for k in data["kpis"]
    ]
    blocks.append(D.Heading("מדדי היום", f"מול {data['weekday']} {last_week.strftime('%d.%m')} ומול ממוצע 4 השבועות"))
    blocks.append(D.KpiBlock(kpis))
    if data["insights"]:
        blocks.append(D.InsightBlock([D.Insight(i["type"], i["text"]) for i in data["insights"]], title="תובנות היום"))

    hours = [r for r in data["hourly"]]
    active = [i for i, r in enumerate(hours) if r["net"] or r["lastWeekNet"]]
    charts: List[D.Chart] = []
    if active:
        sl = hours[active[0]: active[-1] + 1]
        charts.append(D.Chart("bar", [f"{r['hour']:02d}" for r in sl],
                              [D.Series("היום", [r["net"] for r in sl]), D.Series("שבוע שעבר", [r["lastWeekNet"] for r in sl])],
                              "מכירות לפי שעה", "money"))
    if data["paymentMethods"]:
        charts.append(D.Chart("donut", [p["label"] for p in data["paymentMethods"]],
                              [D.Series("", [max(0.0, p["amount"]) for p in data["paymentMethods"]])], "אמצעי תשלום", "money"))
    if charts:
        blocks.append(D.ChartBlock(charts))
    second: List[D.Chart] = []
    for level, title in (("shop", "מכירות לפי סניף"), ("area", "לפי נקודת מכירה"), ("till", "לפי קופה")):
        rows = [r for r in data["hierarchy"] if r["level"] == level and r["net"] > 0]
        if len(rows) >= 2:
            rows.sort(key=lambda r: -r["net"])
            second.append(D.Chart("hbar", [r["name"] for r in rows[:10]],
                                  [D.Series("היום", [r["net"] for r in rows[:10]]),
                                   D.Series("שבוע שעבר", [r["lastWeekNet"] for r in rows[:10]])], title, "money"))
            break
    deps = [d for d in data["departments"] if d["net"] > 0]
    if len(deps) >= 2:
        second.append(D.Chart("hbar", [d["name"] for d in deps[:10]], [D.Series("", [d["net"] for d in deps[:10]])],
                              "מכירות לפי מחלקה", "money"))
    if second:
        blocks.append(D.ChartBlock(second))

    # The comparisons, figure by figure.
    cmp_cols = [_col("label", "מדד"), _col("value", "היום", "text"), _col("lastWeek", "שבוע שעבר", "text"),
                _col("change", "שינוי", "trend"), _col("avg4w", "ממוצע 4 שבועות", "text"), _col("changeAvg", "מול הממוצע", "trend")]
    cmp_rows = []
    for k in data["kpis"]:
        cmp_rows.append([
            k["label"], D.format_value(k["value"], k["kind"]), D.format_value(k["lastWeek"], k["kind"]),
            P.format_cell(k["changePct"], "trend"), D.format_value(k["avg4w"], k["kind"]),
            P.format_cell(k["changePctAvg"], "trend"),
        ])
    blocks.append(D.Table(cmp_cols, cmp_rows, title="השוואות",
                          subtitle="היום מול אותו יום בשבוע שעבר ומול ממוצע 4 השבועות",
                          row_better=[k["better"] for k in data["kpis"]]))

    hier_cols = [_col("name", "שם"), _col("kind", "סוג"), _col("net", "מכירות", "money"), _col("share", "%", "percent"),
                 _col("documents", "עסקאות", "number"), _col("averageTicket", "ממוצע", "money"),
                 _col("lastWeekNet", "שבוע שעבר", "money"), _col("changePct", "שינוי", "trend")]
    kinds = {"shop": "סניף", "area": "נקודת מכירה", "till": "קופה"}
    hier_rows, styles = [], []
    for r in data["hierarchy"]:
        indent = {"shop": "", "area": "     › ", "till": "           • "}[r["level"]]
        parent_is_area = r["level"] == "till" and any(a["id"] == r["parentId"] and a["level"] == "area" for a in data["hierarchy"])
        if r["level"] == "till" and not parent_is_area:
            indent = "     • "
        row = dict(r, name=indent + r["name"], kind=kinds[r["level"]])
        hier_rows.append([P.format_cell(row.get(c.key), c.kind) if c.key != "name" else row["name"] for c in hier_cols])
        styles.append("sub" if r["level"] == "shop" else "row")
    total = _kpi(data, "net")
    blocks.append(D.Table(hier_cols, hier_rows, styles,
                          totals=[P.TOTAL_LABEL, "", P.format_money(total["value"] if total else 0), "100%" if hier_rows else "",
                                  P.format_number(_kpi(data, "documents")["value"]), "", P.format_money(total["lastWeek"] if total else 0), ""],
                          title="פירוט: סניף › נקודת מכירה › קופה", subtitle="מכירות נטו, מול אותו יום בשבוע שעבר"))

    pay_cols = [_col("label", "אמצעי תשלום"), _col("amount", "סכום", "money"), _col("share", "%", "percent"),
                _col("documents", "מסמכים", "number")]
    pay_rows = _cells(pay_cols, data["paymentMethods"])
    extra = []
    if data["payAtTill"]["orders"]:
        extra.append(f"הזמנות קיוסק ששולמו בקופה: {data['payAtTill']['orders']} ({P.format_money(data['payAtTill']['amount'])})")
    if data["noMoneyMovement"]["documents"]:
        nm = data["noMoneyMovement"]
        extra.append(f"זיכויים ללא החזר כספי: {nm['documents']} ({P.format_money(nm['amount'])})")
    blocks.append(D.Table(pay_cols, pay_rows, totals=[P.TOTAL_LABEL, P.format_money(sum(p["amount"] for p in data["paymentMethods"])),
                                                      "100%" if pay_rows else "", ""],
                          title="אמצעי תשלום", subtitle=" · ".join(extra)))

    dep_cols = [_col("name", "מחלקה"), _col("units", "כמות", "number"), _col("net", "מכירות", "money"),
                _col("share", "%", "percent"), _col("lastWeekNet", "שבוע שעבר", "money"), _col("changePct", "מגמה", "trend")]
    blocks.append(D.Table(dep_cols, _cells(dep_cols, data["departments"]), title="מחלקות"))
    item_cols = [_col("name", "פריט"), _col("department", "מחלקה"), _col("units", "כמות", "number"), _col("net", "מכירות", "money"),
                 _col("share", "%", "percent"), _col("lastWeekNet", "שבוע שעבר", "money"), _col("changePct", "מגמה", "trend")]
    blocks.append(D.Table(item_cols, _cells(item_cols, data["topItems"]), title=f"{len(data['topItems'])} הפריטים המובילים"
                          if data["topItems"] else "הפריטים המובילים"))
    mover_cols = [_col("name", "פריט"), _col("lastWeekNet", "שבוע שעבר", "money"), _col("net", "היום", "money"),
                  _col("change", "הפרש", "money"), _col("changePct", "שינוי", "trend")]
    if data["risers"]:
        blocks.append(D.Table(mover_cols, _cells(mover_cols, data["risers"]), title="עלו"))
    if data["fallers"]:
        blocks.append(D.Table(mover_cols, _cells(mover_cols, data["fallers"]), title="ירדו"))

    t = data["tables"]
    if t:
        blocks.append(D.Heading("שולחנות"))
        cards = [
            D.Kpi("opened", "נפתחו", t["opened"], "number", icon="table"),
            D.Kpi("paid", "שולמו", t["paid"], "number", icon="receipt"),
            D.Kpi("stillOpen", "פתוחים בסוף היום", t["stillOpen"], "number", icon="alert"),
            D.Kpi("guests", "סועדים", t["guests"], "number", icon="users"),
            D.Kpi("seated", "ממוצע ישיבה (דק׳)", t["averageSeatedMinutes"], "number", icon="clock"),
            D.Kpi("perTable", "ממוצע לשולחן", t["averagePerTable"], "money", icon="basket"),
            D.Kpi("perCover", "ממוצע לסועד", t["averagePerCover"], "money", icon="users"),
            D.Kpi("cancelled", "בוטלו", t["cancelled"], "number", icon="void", better="down"),
        ]
        blocks.append(D.KpiBlock(cards))
        if t["open"]:
            open_cols = [_col("name", "שולחן"), _col("openedLocal", "נפתח"), _col("guests", "סועדים", "number"),
                         _col("total", "סכום", "money"), _col("waiter", "מלצר")]
            blocks.append(D.Table(open_cols, _cells(open_cols, t["open"]), title="שולחנות פתוחים בסוף היום"))

    staff_cols = [_col("name", "עובד"), _col("net", "מכירות", "money"), _col("documents", "עסקאות", "number"),
                  _col("averageTicket", "ממוצע", "money"), _col("tips", "טיפים", "money")]
    if any(s.get("hours") for s in data["staff"]):
        staff_cols.append(_col("hours", "שעות", "number"))
    blocks.append(D.Table(staff_cols, _cells(staff_cols, data["staff"]), title="עובדים"))

    r = data["risks"]
    risk_cols = [_col("name", "עובד"), _col("refunds", "זיכויים", "money"), _col("refundsCount", "מס׳ זיכויים", "number"),
                 _col("voids", "ביטולים", "money"), _col("tableCancels", "ביטולי שולחן", "number"),
                 _col("discounts", "הנחות", "money"), _col("oth", "על חשבון הבית", "money"),
                 _col("drawerOpens", "פתיחות מגירה", "number")]
    notes = []
    if r["untransmittedCard"]["count"]:
        notes.append(f"עסקאות אשראי שלא שודרו: {r['untransmittedCard']['count']} "
                     f"({P.format_money(r['untransmittedCard']['amount'])})")
    notes.append(f"פתיחות מגירה ללא מכירה: {r['drawerOpensNoSale']}")
    if r["cancelledDocuments"]["count"]:
        notes.append(f"מסמכים שבוטלו: {r['cancelledDocuments']['count']} ({P.format_money(r['cancelledDocuments']['amount'])})")
    blocks.append(D.Heading("סיכונים", new_page=False))
    blocks.append(D.Note(" · ".join(notes), "alert" if r["untransmittedCard"]["count"] else "info"))
    blocks.append(D.Table(risk_cols, _cells(risk_cols, r["byEmployee"]), title="לפי עובד",
                          empty_text="אין זיכויים, ביטולים, הנחות או OTH היום"))
    if r["exceptions"]:
        exc_cols = [_col("label", "חריגה"), _col("count", "כמות", "number")]
        blocks.append(D.Table(exc_cols, _cells(exc_cols, r["exceptions"]), title="חריגות"))

    k = data["kiosks"]
    if k:
        blocks.append(D.Heading("קיוסקים"))
        blocks.append(D.KpiBlock([
            D.Kpi("net", "מכירות", k["net"], "money", icon="kiosk"),
            D.Kpi("orders", "הזמנות", k["orders"], "number", icon="receipt"),
            D.Kpi("avg", "ממוצע להזמנה", k["averageTicket"], "money", icon="basket"),
            D.Kpi("abandoned", "נטישות", k["abandoned"], "number", icon="void", better="down"),
            D.Kpi("median", "זמן הזמנה (חציון)", k["medianOrderSec"], "duration", icon="clock"),
        ]))
        kc = [_col("name", "קיוסק"), _col("net", "מכירות", "money"), _col("documents", "הזמנות", "number")]
        blocks.append(D.Table(kc, _cells(kc, k["byKiosk"])))

    by_key = {x.key: x for x in kpis}
    cover = [by_key[x] for x in ("net", "documents", "averageTicket", "items") if x in by_key]
    return D.Document(
        title="סיכום יום",
        period=f"{data['weekday']} {day.strftime('%d.%m.%Y')}  ·  יום עסקים {start_h:02d}:00–{start_h:02d}:00",
        scope=data["scope"]["label"],
        generated_at=D.now_label(tz),
        generated_by=user_name,
        business_name=branding.get("name") or "",
        logo=branding.get("logo"),
        accent=branding.get("accent") or D.DEFAULT_ACCENT,
        orientation="portrait",
        cover="always",
        cover_kpis=cover,
        blocks=blocks,
    )


def render_pdf(data: Dict[str, Any], *, branding: Optional[Dict[str, Any]] = None, user_name: str = "") -> bytes:
    return D.render_document(document(data, branding=branding, user_name=user_name))
