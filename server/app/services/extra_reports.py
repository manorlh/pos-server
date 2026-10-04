"""
The reports of docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.

All of them start from the same reportable-document set as every other report
(`build_scoped_transaction_query`: tenant, role scope, window, hour window, statuses), so
their figures agree with the per-cashier report over the same window:

* **payment methods** — net per tender leg (a credit note's legs subtract), per local
  day × shop × till × method;
* **hour of day** — net per document (sale: collected; credit note: minus) on a weekday ×
  hour grid, for shift planning;
* **department** — line money per product category, as the product report counts it;
* **document sequence** — per till and document type, every number issued in the window
  (cancelled ones too: a cancelled number is still issued), with the gaps and duplicates;
* **cash variance** — per closed shift, expected vs counted, and per cashier.

Local day, weekday and hour are computed by Postgres (`timezone(tz, created_at)`, its own
tzdata). SQLite (the test world) has no `timezone()`; there rows are grouped by the UTC
instant and converted in Python with zoneinfo — the same answer, a slower path.
"""
from __future__ import annotations

import uuid as uuid_mod
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from sqlalchemy import Integer, case, cast, func
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.schemas.extra_reports import (
    CardBrandRow,
    CardBrandsReportResponse,
    CardBrandTotal,
    CashVarianceCashier,
    CashVarianceResponse,
    CashVarianceShift,
    DepartmentReportResponse,
    DepartmentRow,
    DocumentSequenceResponse,
    HourlyCell,
    HourlyReportResponse,
    HourlyRow,
    PaymentMethodRow,
    PaymentMethodsReportResponse,
    PaymentMethodTotal,
    SequenceGap,
    SequenceRow,
)
from app.services.reports import (
    ReportWindow,
    _is_refund_condition,
    _load_zoneinfo,
    _to_float,
    build_scoped_transaction_query,
    hour_window_predicate,
    normalize_tender,
)
from app.services.scoping import scope_query_by_user, scope_transactions_by_user
from app.services.tenders import signed_tender_amount_expr, tender_method_expr

#: Gaps listed per till and type; the count is always exact.
MAX_GAPS_LISTED = 200
#: Documents read for the sequence report. Numbers are compared one by one, so this is
#: the guard against a year of a chain in one request.
MAX_SEQUENCE_DOCUMENTS = 200_000
MAX_SHIFTS = 5_000


def _pg(db: Session) -> bool:
    return db.get_bind().dialect.name == "postgresql"


def _local(window: ReportWindow, moment: datetime) -> datetime:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_load_zoneinfo(window.tz_name))


def _cents(value: float) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.01")))


def _signed_document_net():
    """A sale's collected money, or minus a credit note's (tips excluded)."""
    return case(
        (_is_refund_condition(), -Transaction.total_amount),
        else_=Transaction.total_amount - func.coalesce(Transaction.document_discount, 0),
    )


def _names(db: Session, model, ids) -> Dict:
    ids = [i for i in set(ids) if i is not None]
    if not ids:
        return {}
    return {row.id: row.name for row in db.query(model.id, model.name).filter(model.id.in_(ids)).all()}


# ── 1. Payment methods ───────────────────────────────────────────────────────


def build_payment_methods_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
) -> PaymentMethodsReportResponse:
    now = datetime.now(timezone.utc)
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )
    if tx_q is None:
        return PaymentMethodsReportResponse(window=window.to_schema(), generated_at=now, rows=[], totals=[], total=0.0)

    method = func.lower(tender_method_expr())
    day = (
        func.date(func.timezone(window.tz_name, Transaction.created_at))
        if _pg(db)
        else Transaction.created_at
    )
    rows = (
        tx_q.outerjoin(TransactionPayment, TransactionPayment.transaction_id == Transaction.id)
        .with_entities(
            day.label("day"),
            Transaction.shop_id.label("shop_id"),
            Transaction.machine_id.label("machine_id"),
            method.label("method"),
            func.coalesce(func.sum(signed_tender_amount_expr()), 0).label("amount"),
            func.count(func.distinct(Transaction.id)).label("documents"),
        )
        .group_by(day, Transaction.shop_id, Transaction.machine_id, method)
        .all()
    )

    agg: Dict[Tuple, List] = {}
    for r in rows:
        d = r.day
        if isinstance(d, str):
            d = datetime.fromisoformat(d)
        if isinstance(d, datetime):
            d = _local(window, d).date()
        key = (d, r.shop_id, r.machine_id, (r.method or "other").strip() or "other")
        bucket = agg.setdefault(key, [0.0, 0])
        bucket[0] += _to_float(r.amount)
        bucket[1] += int(r.documents or 0)

    shops = _names(db, Shop, [k[1] for k in agg])
    machines = _names(db, POSMachine, [k[2] for k in agg])
    out_rows = [
        PaymentMethodRow(
            day=k[0], shop_id=k[1], shop_name=shops.get(k[1]), machine_id=k[2],
            machine_name=machines.get(k[2]), method=k[3], bucket=normalize_tender(k[3]),
            amount=_cents(v[0]), documents=v[1],
        )
        for k, v in agg.items()
    ]
    out_rows.sort(key=lambda r: (r.day, r.shop_name or "", r.machine_name or "", r.method), reverse=False)

    totals: Dict[str, List] = {}
    for r in out_rows:
        t = totals.setdefault(r.method, [0.0, 0])
        t[0] += r.amount
        t[1] += r.documents
    grand = _cents(sum(t[0] for t in totals.values()))
    total_rows = [
        PaymentMethodTotal(
            method=m, bucket=normalize_tender(m), amount=_cents(t[0]), documents=t[1],
            share=round(t[0] / grand * 100, 2) if grand else 0.0,
        )
        for m, t in sorted(totals.items(), key=lambda kv: -kv[1][0])
    ]
    return PaymentMethodsReportResponse(
        window=window.to_schema(), generated_at=now, rows=out_rows, totals=total_rows, total=grand
    )


# ── 1b. Card brands and acquirers (דוח סליקה) ────────────────────────────────


def build_card_brands_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
) -> CardBrandsReportResponse:
    """
    Card legs per shop × brand (מותג) × acquirer (חברת סליקה), sales and credit notes
    apart, for reconciling with the card companies' settlement reports. Same documents
    as every other report; tips are not legs, so not in here (the card total of the
    payment-methods report over the same window equals this net).
    """
    now = datetime.now(timezone.utc)
    empty = CardBrandsReportResponse(
        window=window.to_schema(), generated_at=now, rows=[], by_brand=[], by_acquirer=[],
        sales_count=0, sales_amount=0.0, refunds_count=0, refunds_amount=0.0, net=0.0,
    )
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )
    if tx_q is None:
        return empty

    refund = case((_is_refund_condition(), 1), else_=0)
    rows = (
        tx_q.join(TransactionPayment, TransactionPayment.transaction_id == Transaction.id)
        .filter(func.lower(TransactionPayment.method) == "card")
        .with_entities(
            Transaction.shop_id.label("shop_id"),
            TransactionPayment.card_brand.label("brand"),
            TransactionPayment.card_acquirer.label("acquirer"),
            refund.label("refund"),
            func.count(TransactionPayment.id).label("legs"),
            func.coalesce(func.sum(TransactionPayment.amount), 0).label("amount"),
        )
        .group_by(Transaction.shop_id, TransactionPayment.card_brand, TransactionPayment.card_acquirer, refund)
        .all()
    )
    agg: Dict[Tuple, List] = {}
    for r in rows:
        key = (r.shop_id, r.brand or "other", r.acquirer or "unknown")
        b = agg.setdefault(key, [0, 0.0, 0, 0.0])
        if int(r.refund or 0):
            b[2] += int(r.legs or 0)
            b[3] += _to_float(r.amount)
        else:
            b[0] += int(r.legs or 0)
            b[1] += _to_float(r.amount)
    shops = _names(db, Shop, [k[0] for k in agg])
    out_rows = [
        CardBrandRow(
            shop_id=k[0], shop_name=shops.get(k[0]), brand=k[1], acquirer=k[2],
            sales_count=v[0], sales_amount=_cents(v[1]), refunds_count=v[2],
            refunds_amount=_cents(v[3]), net=_cents(v[1] - v[3]),
        )
        for k, v in agg.items()
    ]
    out_rows.sort(key=lambda r: (r.shop_name or "", -r.net, r.brand, r.acquirer))

    def totals(attr: str) -> List[CardBrandTotal]:
        acc: Dict[str, List] = {}
        for r in out_rows:
            t = acc.setdefault(getattr(r, attr), [0, 0.0, 0, 0.0])
            t[0] += r.sales_count
            t[1] += r.sales_amount
            t[2] += r.refunds_count
            t[3] += r.refunds_amount
        grand = sum(t[1] - t[3] for t in acc.values())
        return sorted(
            (
                CardBrandTotal(
                    key=k, sales_count=t[0], sales_amount=_cents(t[1]), refunds_count=t[2],
                    refunds_amount=_cents(t[3]), net=_cents(t[1] - t[3]),
                    share=round((t[1] - t[3]) / grand * 100, 2) if grand else 0.0,
                )
                for k, t in acc.items()
            ),
            key=lambda t: -t.net,
        )

    sales_amount = sum(r.sales_amount for r in out_rows)
    refunds_amount = sum(r.refunds_amount for r in out_rows)
    return CardBrandsReportResponse(
        window=window.to_schema(), generated_at=now, rows=out_rows,
        by_brand=totals("brand"), by_acquirer=totals("acquirer"),
        sales_count=sum(r.sales_count for r in out_rows), sales_amount=_cents(sales_amount),
        refunds_count=sum(r.refunds_count for r in out_rows), refunds_amount=_cents(refunds_amount),
        net=_cents(sales_amount - refunds_amount),
    )


# ── 2. Hour of day ───────────────────────────────────────────────────────────


def build_hourly_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
) -> HourlyReportResponse:
    now = datetime.now(timezone.utc)
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )
    grid: Dict[Tuple[int, int], List] = defaultdict(lambda: [0.0, 0, 0])  # net, docs, sales
    if tx_q is not None:
        net = _signed_document_net()
        is_sale = case((_is_refund_condition(), 0), else_=1)
        if _pg(db):
            local = func.timezone(window.tz_name, Transaction.created_at)
            # Postgres dow: 0 = Sunday, the Israeli week's first day.
            dow = cast(func.extract("dow", local), Integer)
            hour = cast(func.extract("hour", local), Integer)
            keys = (dow, hour)
        else:
            keys = (Transaction.created_at,)
        rows = (
            tx_q.with_entities(
                *[k.label(f"k{i}") for i, k in enumerate(keys)],
                func.coalesce(func.sum(net), 0).label("net"),
                func.count(Transaction.id).label("documents"),
                func.coalesce(func.sum(is_sale), 0).label("sales"),
            )
            .group_by(*keys)
            .all()
        )
        for r in rows:
            if _pg(db):
                weekday, hour = int(r.k0), int(r.k1)
            else:
                moment = r.k0 if isinstance(r.k0, datetime) else datetime.fromisoformat(str(r.k0))
                local_dt = _local(window, moment)
                weekday, hour = (local_dt.weekday() + 1) % 7, local_dt.hour
            cell = grid[(weekday, hour)]
            cell[0] += _to_float(r.net)
            cell[1] += int(r.documents or 0)
            cell[2] += int(r.sales or 0)

    cells = [
        HourlyCell(weekday=k[0], hour=k[1], net=_cents(v[0]), documents=v[1])
        for k, v in sorted(grid.items())
    ]
    by_hour = []
    for hour in range(24):
        net = sum(v[0] for k, v in grid.items() if k[1] == hour)
        docs = sum(v[1] for k, v in grid.items() if k[1] == hour)
        sales = sum(v[2] for k, v in grid.items() if k[1] == hour)
        if docs:
            by_hour.append(
                HourlyRow(hour=hour, net=_cents(net), documents=docs, average_basket=_cents(net / sales) if sales else 0.0)
            )
    return HourlyReportResponse(
        window=window.to_schema(), generated_at=now, cells=cells, by_hour=by_hour,
        total=_cents(sum(v[0] for v in grid.values())), documents=sum(v[1] for v in grid.values()),
    )


# ── 3. Department ────────────────────────────────────────────────────────────


def build_department_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    cashier_id: Optional[str] = None,
) -> DepartmentReportResponse:
    """Line money per product category — the product report's rules, one level up."""
    now = datetime.now(timezone.utc)
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id
    )
    empty = DepartmentRow(units=0, gross=0, discounts=0, refunds=0, net=0, share=100.0)
    if tx_q is None:
        return DepartmentReportResponse(window=window.to_schema(), generated_at=now, rows=[], totals=empty)

    tx_sub = tx_q.with_entities(
        Transaction.id.label("tx_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    is_refund = tx_sub.c.is_refund
    qty = TransactionItem.quantity
    rows = (
        db.query(
            Product.category_id.label("category_id"),
            func.coalesce(
                func.sum(case((is_refund.is_(True), -qty), else_=qty)), 0
            ).label("units"),
            func.coalesce(func.sum(case((is_refund.is_(False), TransactionItem.total_price), else_=0)), 0).label("gross"),
            func.coalesce(
                func.sum(case((
                    is_refund.is_(False),
                    # The line's own discount and its promotions' share ("מבצעים").
                    func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0),
                ), else_=0)), 0
            ).label("discounts"),
            # A credit-note line's total_price is already net of its discount.
            func.coalesce(func.sum(case((is_refund.is_(True), TransactionItem.total_price), else_=0)), 0).label("refunds"),
        )
        .select_from(TransactionItem)
        .join(tx_sub, tx_sub.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .group_by(Product.category_id)
        .all()
    )
    names = _names(db, Category, [r.category_id for r in rows])
    out: List[DepartmentRow] = []
    for r in rows:
        gross, disc, ref = _to_float(r.gross), _to_float(r.discounts), _to_float(r.refunds)
        out.append(
            DepartmentRow(
                category_id=r.category_id, category_name=names.get(r.category_id),
                units=_to_float(r.units), gross=_cents(gross), discounts=_cents(disc),
                refunds=_cents(ref), net=_cents(gross - disc - ref), share=0.0,
            )
        )
    total_net = sum(r.net for r in out)
    for r in out:
        r.share = round(r.net / total_net * 100, 2) if total_net else 0.0
    out.sort(key=lambda r: r.net, reverse=True)
    totals = DepartmentRow(
        units=sum(r.units for r in out), gross=_cents(sum(r.gross for r in out)),
        discounts=_cents(sum(r.discounts for r in out)), refunds=_cents(sum(r.refunds for r in out)),
        net=_cents(total_net), share=100.0 if out else 0.0,
    )
    return DepartmentReportResponse(window=window.to_schema(), generated_at=now, rows=out, totals=totals)


# ── 4. Document sequence ─────────────────────────────────────────────────────


def find_gaps(numbers: Sequence[str]) -> Tuple[List[Tuple[int, int]], List[str], int]:
    """(gaps as inclusive (from, to), duplicate numbers, count of non-numeric numbers)."""
    counts = Counter(n.strip() for n in numbers if n and n.strip())
    duplicates = sorted((n for n, c in counts.items() if c > 1), key=lambda n: (len(n), n))
    numeric = sorted({int(n) for n in counts if n.isdigit()})
    non_numeric = sum(1 for n in counts if not n.isdigit())
    gaps = [
        (a + 1, b - 1) for a, b in zip(numeric, numeric[1:]) if b - a > 1
    ]
    return gaps, duplicates, non_numeric


def build_document_sequence_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> DocumentSequenceResponse:
    """
    Every number each till issued in the window, per document type, and what is missing
    between the first and the last. Every status counts — a cancelled document still used
    its number — so this is deliberately NOT the reportable set of the other reports.
    """
    now = datetime.now(timezone.utc)
    q = db.query(Transaction.machine_id, Transaction.document_type, Transaction.transaction_number).filter(
        Transaction.tenant_id == tenant_id,
        Transaction.created_at >= window.start,
        Transaction.created_at < window.end,
    )
    q = scope_transactions_by_user(q, current_user, db)
    if q is None:
        return DocumentSequenceResponse(window=window.to_schema(), generated_at=now, rows=[], total_missing=0)
    hour_pred = hour_window_predicate(window)
    if hour_pred is not None:
        q = q.filter(hour_pred)
    if shop_id is not None:
        q = q.filter(Transaction.shop_id == shop_id)
    if machine_id is not None:
        q = q.filter(Transaction.machine_id == machine_id)
    rows = q.limit(MAX_SEQUENCE_DOCUMENTS + 1).all()
    if len(rows) > MAX_SEQUENCE_DOCUMENTS:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many documents in range; narrow the dates or pick a shop.",
        )

    groups: Dict[Tuple, List[str]] = defaultdict(list)
    for m, t, n in rows:
        groups[(m, t)].append(n)
    machines = {
        m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([k[0] for k in groups])).all()
    } if groups else {}
    shops = _names(db, Shop, [m.shop_id for m in machines.values()])

    out: List[SequenceRow] = []
    for (m, t), numbers in groups.items():
        gaps, dups, non_numeric = find_gaps(numbers)
        numeric = sorted(int(n) for n in set(x.strip() for x in numbers) if n.isdigit())
        machine = machines.get(m)
        out.append(
            SequenceRow(
                machine_id=m,
                machine_name=machine.name if machine else None,
                shop_name=shops.get(machine.shop_id) if machine else None,
                document_type=t,
                first_number=str(numeric[0]) if numeric else None,
                last_number=str(numeric[-1]) if numeric else None,
                documents=len(numbers),
                missing=sum(b - a + 1 for a, b in gaps),
                duplicates=dups[:MAX_GAPS_LISTED],
                non_numeric=non_numeric,
                gaps=[SequenceGap(from_number=a, to_number=b, missing=b - a + 1) for a, b in gaps[:MAX_GAPS_LISTED]],
            )
        )
    out.sort(key=lambda r: (-r.missing, r.shop_name or "", r.machine_name or "", r.document_type or 0))
    return DocumentSequenceResponse(
        window=window.to_schema(), generated_at=now, rows=out, total_missing=sum(r.missing for r in out)
    )


# ── 5. Cash variance ─────────────────────────────────────────────────────────


def build_cash_variance_report(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> CashVarianceResponse:
    """Closed shifts by business date in the range: expected vs counted, and per cashier."""
    now = datetime.now(timezone.utc)
    q = db.query(Shift).filter(
        Shift.tenant_id == tenant_id,
        Shift.status == ShiftStatus.CLOSED,
        Shift.business_date >= window.from_date,
        Shift.business_date <= window.to_date,
    )
    q = scope_query_by_user(q, current_user, db, shop_column=Shift.shop_id, machine_column=Shift.machine_id)
    if q is None:
        return CashVarianceResponse(
            window=window.to_schema(), generated_at=now, shifts=[], by_cashier=[], total_variance=0.0, uncounted=0
        )
    if shop_id is not None:
        q = q.filter(Shift.shop_id == shop_id)
    if machine_id is not None:
        q = q.filter(Shift.machine_id == machine_id)
    shifts: List[Shift] = q.order_by(Shift.business_date, Shift.opened_at).limit(MAX_SHIFTS).all()

    shops = _names(db, Shop, [s.shop_id for s in shifts])
    machines = _names(db, POSMachine, [s.machine_id for s in shifts])
    out: List[CashVarianceShift] = []
    per_cashier: Dict[Optional[str], List] = {}
    total = 0.0
    uncounted = 0
    for s in shifts:
        variance = None
        if s.counted_cash is not None and not s.unattended:
            if s.discrepancy is not None:
                variance = _to_float(s.discrepancy)
            elif s.expected_cash is not None:
                variance = _to_float(s.counted_cash) - _to_float(s.expected_cash)
        cashier = s.closed_by or s.opened_by
        out.append(
            CashVarianceShift(
                shift_id=s.id, business_date=s.business_date, shop_name=shops.get(s.shop_id),
                machine_name=machines.get(s.machine_id), sequence_number=s.sequence_number,
                cashier=cashier, opened_at=s.opened_at, closed_at=s.closed_at,
                expected_cash=_to_float(s.expected_cash) if s.expected_cash is not None else None,
                counted_cash=_to_float(s.counted_cash) if s.counted_cash is not None else None,
                variance=_cents(variance) if variance is not None else None,
                unattended=bool(s.unattended),
            )
        )
        c = per_cashier.setdefault(cashier, [0, 0, 0.0, 0.0])
        c[0] += 1
        if variance is None:
            uncounted += 1
            continue
        c[1] += 1
        if variance > 0:
            c[2] += variance
        else:
            c[3] += variance
        total += variance

    by_cashier = [
        CashVarianceCashier(
            cashier=k, shifts=v[0], counted_shifts=v[1], over=_cents(v[2]), short=_cents(v[3]), net=_cents(v[2] + v[3])
        )
        for k, v in per_cashier.items()
    ]
    by_cashier.sort(key=lambda r: r.net)
    return CashVarianceResponse(
        window=window.to_schema(), generated_at=now, shifts=out, by_cashier=by_cashier,
        total_variance=_cents(total), uncounted=uncounted,
    )
