"""
"דוח שמכיל הכל" — the all-in-one report (docs/SPEC_REPORTS.md §5).

One report over a date range and shop(s) / till(s): the sales summary, by payment method and
card brand, by till, by employee, by day, by category and item, refunds (credit notes),
discounts, tips, VAT, the Zs, the card transmissions, failed payment attempts, staff and
managers' meals, and the kiosks' orders — one dashboard page with sections and one Excel
workbook with a sheet per section.

Built from the existing report code, never a second set of rules:

* the documents are `reports.build_scoped_transaction_query` (tenant, role scope, window,
  sale statuses) narrowed to the shops / tills chosen;
* every money table ("by till", "by employee", "by day", kiosks, the summary) is
  `reports._sales_buckets` — the per-cashier report's money, so the tables add up to the
  same net as every other report over the same documents;
* items, categories and card brands are the product / department / card-brand reports
  (`build_product_sales_report`, `extra_reports.build_department_report` /
  `build_card_brands_report`), run per shop or till chosen and merged;
* the Zs are the consolidated Z table (app/services/z_table.py), the failed attempts the
  failed-payments list (app/services/failed_payments.py), the meals the tables' meals report
  (app/services/table_policies.py).
"""
from __future__ import annotations

import uuid
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.card_transmission import CardTransmission
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.models.z_report import ZReport
from app.services.document_prefix import document_number_from, document_number_of
from app.services.reports import (
    PRODUCT_ROWS_MAX,
    ReportWindow,
    _display_name,
    _is_refund_condition,
    _load_cashier_names,
    _sales_buckets,
    _to_float,
    build_product_sales_report,
    build_scoped_transaction_query,
)
from app.services.tenders import (
    normalize_tender,
    sale_condition,
    signed_tender_amount_expr,
    tender_method_expr,
)

#: Rows of one list section (credit notes, attempts, transmissions, meals) — beyond it the
#: section says it was cut (`truncated`), and its totals still cover every row.
LIST_ROWS_MAX = 5000


def _r(value: Any) -> float:
    return round(_to_float(value), 2)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def _money_row(bucket: Dict[str, float]) -> Dict[str, Any]:
    """A `_sales_buckets` bucket as a report row: the cashier report's money, rounded."""
    sales = int(bucket["sales_count"])
    refunds = int(bucket["refunds_count"])
    net = bucket["gross"] - bucket["discounts"] - bucket["refunds"]
    return {
        "documents": sales + refunds,
        "salesCount": sales,
        "refundsCount": refunds,
        "gross": _r(bucket["gross"]),
        "discounts": _r(bucket["discounts"]),
        "refunds": _r(bucket["refunds"]),
        "net": _r(net),
        "averageBasket": _r((bucket["gross"] - bucket["discounts"]) / sales) if sales else 0.0,
        "cash": _r(bucket["cash_net"]),
        "card": _r(bucket["card_net"]),
        "other": _r(bucket["other_net"]),
        "exchange": _r(bucket["exchange_net"]),
        "tips": _r(bucket["tips"]),
    }


def _sum_rows(rows: Iterable[Dict[str, Any]], fields: Sequence[str]) -> Dict[str, float]:
    out = {f: 0.0 for f in fields}
    for row in rows:
        for f in fields:
            out[f] += _to_float(row.get(f))
    return {f: round(v, 3) if f.startswith("units") else round(v, 2) for f, v in out.items()}


MONEY_FIELDS = (
    "documents", "salesCount", "refundsCount", "gross", "discounts", "refunds", "net",
    "cash", "card", "other", "exchange", "tips",
)


def _totals_of(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    t = _sum_rows(rows, MONEY_FIELDS)
    for k in ("documents", "salesCount", "refundsCount"):
        t[k] = int(t[k])
    sales = t["salesCount"]
    t["averageBasket"] = round((t["gross"] - t["discounts"]) / sales, 2) if sales else 0.0
    return t


# ── The documents ────────────────────────────────────────────────────────────


def documents_query(
    db: Session,
    user: User,
    tenant_id,
    window: ReportWindow,
    *,
    shop_ids: Sequence[uuid.UUID] = (),
    machine_ids: Sequence[uuid.UUID] = (),
):
    """The reportable documents of the window in scope, narrowed to the shops / tills chosen."""
    q = build_scoped_transaction_query(db, user, tenant_id, window)
    if q is None:
        return None
    if shop_ids:
        q = q.filter(Transaction.shop_id.in_(list(shop_ids)))
    if machine_ids:
        q = q.filter(Transaction.machine_id.in_(list(machine_ids)))
    return q


def _targets(shop_ids: Sequence[uuid.UUID], machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    """How a single-shop / single-till report builder is run to cover the choice."""
    if machine_ids:
        return [{"machine_id": m} for m in machine_ids]
    if shop_ids:
        return [{"shop_id": s} for s in shop_ids]
    return [{}]


def _merge(lists: Iterable[Sequence[Dict[str, Any]]], key: Callable[[Dict[str, Any]], Any],
           fields: Sequence[str]) -> List[Dict[str, Any]]:
    merged: "OrderedDict[Any, Dict[str, Any]]" = OrderedDict()
    for rows in lists:
        for row in rows:
            k = key(row)
            if k not in merged:
                merged[k] = dict(row)
                continue
            for f in fields:
                merged[k][f] = _to_float(merged[k].get(f)) + _to_float(row.get(f))
    return list(merged.values())


def _names(db: Session, model, ids: Iterable[Any]) -> Dict[Any, Any]:
    wanted = list({i for i in ids if i is not None})
    if not wanted:
        return {}
    return {row.id: row for row in db.query(model).filter(model.id.in_(wanted)).all()}


def _local_day(window: ReportWindow, moment: Any) -> Optional[str]:
    from app.services.reports import _load_zoneinfo

    if moment is None:
        return None
    if isinstance(moment, str):
        try:
            moment = datetime.fromisoformat(moment)
        except ValueError:
            return moment[:10]
    if isinstance(moment, date) and not isinstance(moment, datetime):
        return moment.isoformat()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_load_zoneinfo(window.tz_name)).date().isoformat()


# ── Sections ─────────────────────────────────────────────────────────────────


def by_till(db: Session, tx_q) -> List[Dict[str, Any]]:
    from app.services.z_table import kiosk_machine_ids

    agg = _sales_buckets(tx_q, Transaction.machine_id)
    machines = _names(db, POSMachine, agg.keys())
    shops = _names(db, Shop, (m.shop_id for m in machines.values()))
    kiosks = kiosk_machine_ids(db, list(machines))
    rows = []
    for machine_id, bucket in agg.items():
        m = machines.get(machine_id)
        shop = shops.get(m.shop_id) if m else None
        rows.append({
            "machineId": str(machine_id) if machine_id else None,
            "machineName": m.name if m else None,
            "posNumber": m.pos_number if m else None,
            "shopName": shop.name if shop else None,
            "kiosk": machine_id in kiosks,
            **_money_row(bucket),
        })
    rows.sort(key=lambda r: (r["shopName"] or "", r["posNumber"] or "", r["machineName"] or ""))
    return rows


def by_employee(db: Session, tx_q) -> List[Dict[str, Any]]:
    agg = _sales_buckets(tx_q, Transaction.cashier_id)
    users = _load_cashier_names(db, [k for k in agg if k])
    rows = []
    for cashier_id, bucket in agg.items():
        pu = users.get(cashier_id) if cashier_id else None
        rows.append({
            "cashierId": cashier_id,
            "cashierName": _display_name(pu) or cashier_id,
            "workerNumber": getattr(pu, "worker_number", None) if pu else None,
            **_money_row(bucket),
        })
    rows.sort(key=lambda r: -r["net"])
    return rows


def by_day(window: ReportWindow, tx_q) -> List[Dict[str, Any]]:
    """Per local day: grouped by the document's time, then folded into the shop's days."""
    agg = _sales_buckets(tx_q, Transaction.created_at)
    days: Dict[str, Dict[str, float]] = {}
    for moment, bucket in agg.items():
        day = _local_day(window, moment)
        acc = days.setdefault(day, {k: 0 for k in bucket})
        for k, v in bucket.items():
            acc[k] += v
    return [{"day": d, **_money_row(b)} for d, b in sorted(days.items())]


def by_payment_method(tx_q) -> List[Dict[str, Any]]:
    method = func.lower(tender_method_expr())
    rows = (
        tx_q.outerjoin(TransactionPayment, TransactionPayment.transaction_id == Transaction.id)
        .with_entities(
            method.label("method"),
            func.coalesce(func.sum(signed_tender_amount_expr()), 0).label("amount"),
            func.count(func.distinct(Transaction.id)).label("documents"),
        )
        .group_by(method)
        .all()
    )
    total = sum(_to_float(r.amount) for r in rows)
    out = [
        {
            "method": (r.method or "other").strip() or "other",
            "bucket": normalize_tender(r.method),
            "amount": _r(r.amount),
            "documents": int(r.documents or 0),
            "share": round(_to_float(r.amount) / total * 100, 2) if total else 0.0,
        }
        for r in rows
    ]
    out.sort(key=lambda r: -r["amount"])
    return out


def by_vat_rate(tx_q) -> Dict[str, Any]:
    refund = _is_refund_condition()
    collected = case(
        (refund, -Transaction.total_amount),
        else_=Transaction.total_amount - func.coalesce(Transaction.document_discount, 0),
    )
    signed_vat = case((refund, -Transaction.vat_amount), else_=Transaction.vat_amount)
    rows = (
        tx_q.with_entities(
            Transaction.vat_rate.label("rate"),
            func.count(Transaction.id).label("documents"),
            func.coalesce(func.sum(collected), 0).label("gross"),
            func.coalesce(func.sum(signed_vat), 0).label("vat"),
            func.coalesce(func.sum(case((Transaction.vat_amount.is_(None), 1), else_=0)), 0).label("missing"),
        )
        .group_by(Transaction.vat_rate)
        .all()
    )
    out = []
    for r in rows:
        gross = _to_float(r.gross)
        vat = _to_float(r.vat)
        out.append({
            "rate": _r(r.rate) if r.rate is not None else None,
            "documents": int(r.documents or 0),
            "gross": round(gross, 2),
            "vat": round(vat, 2),
            "netOfVat": round(gross - vat, 2),
            "missingVat": int(r.missing or 0),
        })
    out.sort(key=lambda r: (r["rate"] is None, r["rate"] or 0))
    return {
        "rows": out,
        "totals": {
            "documents": sum(r["documents"] for r in out),
            "gross": round(sum(r["gross"] for r in out), 2),
            "vat": round(sum(r["vat"] for r in out), 2),
            "netOfVat": round(sum(r["netOfVat"] for r in out), 2),
            "missingVat": sum(r["missingVat"] for r in out),
        },
    }


def refunds_section(db: Session, tx_q) -> Dict[str, Any]:
    q = tx_q.filter(_is_refund_condition())
    count, total = q.with_entities(func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)).one()
    rows = q.order_by(Transaction.created_at.desc(), Transaction.id).limit(LIST_ROWS_MAX).all()
    machines = _names(db, POSMachine, (r.machine_id for r in rows))
    originals = {}
    wanted = [r.refund_of_transaction_id for r in rows if r.refund_of_transaction_id]
    if wanted:
        for tid, number, prefix, pos in (
            db.query(Transaction.id, Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number)
            .filter(Transaction.id.in_(wanted))
            .all()
        ):
            originals[tid] = document_number_from(number, prefix, pos)
    users = _load_cashier_names(db, [r.cashier_id for r in rows if r.cashier_id])
    items = []
    for tx in rows:
        m = machines.get(tx.machine_id)
        items.append({
            "id": str(tx.id),
            "createdAt": _iso(tx.created_at),
            "documentNumber": document_number_of(tx),
            "documentType": tx.document_type,
            "originalNumber": originals.get(tx.refund_of_transaction_id),
            "machineName": m.name if m else None,
            "posNumber": m.pos_number if m else None,
            "cashierName": _display_name(users.get(tx.cashier_id)) if tx.cashier_id else None,
            "paymentMethod": tx.payment_method,
            "amount": _r(tx.total_amount),
        })
    return {"count": int(count or 0), "total": _r(total), "items": items, "truncated": int(count or 0) > len(items)}


def discounts_section(tx_q, till_rows: Sequence[Dict[str, Any]], employee_rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    sales = tx_q.filter(sale_condition())
    sale_ids = sales.with_entities(Transaction.id).subquery()
    from sqlalchemy import select

    line, promo = (
        sales.session.query(
            func.coalesce(func.sum(func.abs(TransactionItem.discount)), 0),
            func.coalesce(func.sum(func.abs(TransactionItem.promotion_discount)), 0),
        )
        .filter(TransactionItem.transaction_id.in_(select(sale_ids.c.id)))
        .one()
    )
    kinds = (
        sales.with_entities(
            Transaction.basket_discount_kind.label("kind"),
            func.count(Transaction.id).label("documents"),
            func.coalesce(func.sum(Transaction.document_discount), 0).label("amount"),
        )
        .filter(func.coalesce(Transaction.document_discount, 0) != 0)
        .group_by(Transaction.basket_discount_kind)
        .all()
    )
    document_total = sum(r["discounts"] for r in till_rows)
    return {
        "documentDiscounts": round(document_total, 2),
        "lineDiscounts": _r(line),
        "promotionDiscounts": _r(promo),
        "byKind": sorted(
            ({"kind": r.kind or "other", "documents": int(r.documents or 0), "amount": _r(r.amount)} for r in kinds),
            key=lambda r: -r["amount"],
        ),
        "byTill": [
            {"machineName": r["machineName"], "posNumber": r["posNumber"], "shopName": r["shopName"], "discounts": r["discounts"]}
            for r in till_rows if r["discounts"]
        ],
        "byEmployee": [
            {"cashierName": r["cashierName"], "discounts": r["discounts"]} for r in employee_rows if r["discounts"]
        ],
    }


def tips_section(tx_q, till_rows, employee_rows) -> Dict[str, Any]:
    from app.services.shift_totals import tip_goes_to_cash

    rows = (
        tx_q.filter(func.coalesce(Transaction.tip_amount, 0) != 0)
        .with_entities(Transaction.tip_payment_method, Transaction.payment_method, Transaction.tip_amount)
        .all()
    )
    cash = card = 0.0
    for tip_method, sale_method, amount in rows:
        if tip_goes_to_cash(tip_method, sale_method):
            cash += _to_float(amount)
        else:
            card += _to_float(amount)
    return {
        "total": round(cash + card, 2),
        "cash": round(cash, 2),
        "card": round(card, 2),
        "documents": len(rows),
        "byTill": [
            {"machineName": r["machineName"], "posNumber": r["posNumber"], "shopName": r["shopName"], "tips": r["tips"]}
            for r in till_rows if r["tips"]
        ],
        "byEmployee": [{"cashierName": r["cashierName"], "tips": r["tips"]} for r in employee_rows if r["tips"]],
    }


def items_and_categories(db: Session, user, tenant_id, window, shop_ids, machine_ids) -> Dict[str, Any]:
    from app.services.extra_reports import build_card_brands_report, build_department_report

    targets = _targets(shop_ids, machine_ids)
    products, departments, brands = [], [], []
    truncated = False
    for t in targets:
        p = build_product_sales_report(db, user, tenant_id, window, limit=PRODUCT_ROWS_MAX, **t)
        truncated = truncated or bool(p.truncated)
        products.append([r.model_dump(by_alias=True, mode="json") for r in p.rows])
        d = build_department_report(db, user, tenant_id, window, **t)
        departments.append([r.model_dump(by_alias=True, mode="json") for r in d.rows])
        b = build_card_brands_report(db, user, tenant_id, window, **t)
        brands.append([r.model_dump(by_alias=True, mode="json") for r in b.rows])

    item_fields = ("unitsSold", "unitsRefunded", "unitsNet", "gross", "discounts", "refunds", "net",
                   "linesSold", "linesRefunded", "unitsInMeals")
    items = _merge(products, lambda r: r.get("productId") or (r.get("productName"), r.get("sku")), item_fields)
    items.sort(key=lambda r: -_to_float(r.get("net")))
    cats = _merge(departments, lambda r: r.get("categoryId") or r.get("categoryName"),
                  ("units", "gross", "discounts", "refunds", "net"))
    total_net = sum(_to_float(c.get("net")) for c in cats)
    for c in cats:
        c["share"] = round(_to_float(c.get("net")) / total_net * 100, 2) if total_net else 0.0
    cats.sort(key=lambda r: -_to_float(r.get("net")))
    brand_rows = _merge(brands, lambda r: (r.get("shopId"), r.get("brand"), r.get("acquirer")),
                        ("salesCount", "salesAmount", "refundsCount", "refundsAmount", "net"))
    by_brand = _merge([brand_rows], lambda r: r.get("brand"),
                      ("salesCount", "salesAmount", "refundsCount", "refundsAmount", "net"))
    for rows in (items, cats, brand_rows, by_brand):
        for row in rows:
            for k, v in list(row.items()):
                if isinstance(v, float):
                    row[k] = round(v, 3) if k.startswith("units") else round(v, 2)
    return {
        "items": items,
        "itemsTruncated": truncated,
        "categories": cats,
        "cardBrands": [{"brand": r.get("brand"), **{k: r.get(k) for k in ("salesCount", "salesAmount", "refundsCount", "refundsAmount", "net")}} for r in by_brand],
        "cardBrandRows": brand_rows,
    }


def machines_in_scope(db: Session, user, tenant_id, shop_ids, machine_ids) -> List[POSMachine]:
    from app.services.scoping import scope_query_by_user

    q = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id)
    q = scope_query_by_user(q, user, db, shop_column=POSMachine.shop_id, machine_column=POSMachine.id)
    if q is None:
        return []
    if machine_ids:
        q = q.filter(POSMachine.id.in_(list(machine_ids)))
    if shop_ids:
        q = q.filter(POSMachine.shop_id.in_(list(shop_ids)))
    return q.all()


def transmissions_section(db: Session, machines: Sequence[POSMachine], window: ReportWindow) -> Dict[str, Any]:
    from app.services.transmissions import assumed_counts, legs_matched, transmission_to_out

    by_id = {m.id: m for m in machines}
    if not by_id:
        return {"count": 0, "items": [], "byTill": [], "truncated": False}
    q = db.query(CardTransmission).filter(
        CardTransmission.machine_id.in_(list(by_id)),
        CardTransmission.started_at >= window.start,
        CardTransmission.started_at < window.end,
    )
    total = q.count()
    rows = q.order_by(CardTransmission.started_at.desc()).limit(LIST_ROWS_MAX).all()
    matched = legs_matched(db, [r.id for r in rows])
    assumed = assumed_counts(db, [r.id for r in rows])
    items = []
    per: Dict[uuid.UUID, Dict[str, Any]] = {}
    for r in rows:
        out = transmission_to_out(db, r, matched=matched.get(r.id, 0), assumed=assumed.get(r.id, 0))
        m = by_id.get(r.machine_id)
        out.update(machineName=m.name if m else None, posNumber=m.pos_number if m else None)
        out["startedAt"] = _iso(r.started_at)
        out["finishedAt"] = _iso(r.finished_at)
        out["receivedAt"] = _iso(r.received_at)
        items.append(out)
        t = per.setdefault(r.machine_id, {
            "machineId": str(r.machine_id), "machineName": out["machineName"], "posNumber": out["posNumber"],
            "attempts": 0, "success": 0, "failed": 0, "unknown": 0, "amount": 0.0, "transactions": 0,
            "lastSuccessAt": None, "lastAttemptAt": None,
        })
        t["attempts"] += 1
        t[r.status if r.status in ("success", "failed", "unknown") else "unknown"] += 1
        if r.status == "success":
            t["amount"] = round(t["amount"] + _to_float(r.amount), 2)
            t["transactions"] += int(r.transaction_count or 0)
            t["lastSuccessAt"] = max(filter(None, [t["lastSuccessAt"], _iso(r.started_at)]))
        t["lastAttemptAt"] = max(filter(None, [t["lastAttemptAt"], _iso(r.started_at)]))
    return {"count": total, "items": items, "byTill": list(per.values()), "truncated": total > len(items)}


def failed_payments_section(db: Session, user, tenant_id, window: ReportWindow, shop_ids, machine_ids) -> Dict[str, Any]:
    from app.models.failed_payment import FailedPaymentAttempt as A
    from app.services import failed_payments as FP

    # The list's UTC days, a day wider each side; the window's own local bounds then cut.
    f = FP.Filters(from_date=window.from_date - timedelta(days=1), to_date=window.to_date + timedelta(days=1))
    q = FP.attempts_query(db, tenant_id, user, f)
    if q is None:
        return {"summary": FP.summarize(None), "items": [], "truncated": False}
    q = q.filter(A.occurred_at >= window.start, A.occurred_at < window.end)
    if shop_ids:
        q = q.filter(A.shop_id.in_(list(shop_ids)))
    if machine_ids:
        q = q.filter(A.machine_id.in_(list(machine_ids)))
    summary = FP.summarize(q)
    rows = q.order_by(A.occurred_at.desc(), A.id).limit(LIST_ROWS_MAX).all()
    labels = FP.labels_for(db, tenant_id, rows)
    items = []
    for r in rows:
        out = FP.attempt_out(r, labels)
        items.append({
            "occurredAt": _iso(out["occurred_at"]),
            "machineName": out["machine_name"],
            "posNumber": out["pos_number"],
            "employeeName": out["employee_name"],
            "amount": round(int(out["amount_agorot"] or 0) / 100, 2),
            "method": out["method"],
            "kind": out["kind"],
            "outcome": out["outcome"],
            "outcomeLabel": FP.outcome_label(out["outcome"]),
            "reason": out["reason_message"] or out["reason_code"],
            "cardBrand": out["card_brand"],
            "cardLast4": out["card_last4"],
            "paidLaterBy": out["paid_by_transaction_number"],
        })
    return {"summary": summary, "items": items, "truncated": summary["count"] + summary["payoutCount"] > len(items)}


def meals_section(db: Session, tx_q, window: ReportWindow) -> Dict[str, Any]:
    from app.services.table_policies import MEAL_KINDS, meals_report

    shop_ids = [
        s for (s,) in tx_q.filter(Transaction.meal_kind.in_(MEAL_KINDS))
        .with_entities(Transaction.shop_id).distinct().all() if s is not None
    ]
    shops = _names(db, Shop, shop_ids)
    out = {"staff": {"count": 0, "before": 0.0, "discount": 0.0, "paid": 0.0},
           "managers": {"count": 0, "before": 0.0, "discount": 0.0, "paid": 0.0},
           "byEmployee": [], "meals": []}
    for shop_id in shop_ids:
        shop = shops.get(shop_id)
        if shop is None:
            continue
        rep = meals_report(db, shop, window.start, window.end)
        for kind in ("staff", "managers"):
            for k in ("count", "before", "discount", "paid"):
                out[kind][k] = round(out[kind][k] + _to_float(rep[kind][k]), 2) if k != "count" else out[kind][k] + int(rep[kind][k])
        out["byEmployee"] += [{**r, "shopName": shop.name} for r in rep["byEmployee"]]
        out["meals"] += [{**r, "shopName": shop.name} for r in rep["meals"]]
    return out


def kiosk_section(db: Session, tx_q, till_rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    kiosks = [r for r in till_rows if r.get("kiosk")]
    return {"byKiosk": kiosks, "totals": _totals_of(kiosks) if kiosks else _totals_of([])}


# ── The report ───────────────────────────────────────────────────────────────


def build_all_in_one(
    db: Session,
    user: User,
    tenant_id,
    window: ReportWindow,
    *,
    shop_ids: Sequence[uuid.UUID] = (),
    machine_ids: Sequence[uuid.UUID] = (),
) -> Dict[str, Any]:
    from app.services import z_table

    now = datetime.now(timezone.utc)
    head = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": now.isoformat(),
        "shopIds": [str(s) for s in shop_ids],
        "machineIds": [str(m) for m in machine_ids],
    }
    tx_q = documents_query(db, user, tenant_id, window, shop_ids=shop_ids, machine_ids=machine_ids)
    if tx_q is None:
        return {**head, "empty": True}

    tills = by_till(db, tx_q)
    employees = by_employee(db, tx_q)
    summary = _totals_of(tills)
    vat = by_vat_rate(tx_q)
    summary["vat"] = vat["totals"]["vat"]
    summary["netOfVat"] = vat["totals"]["netOfVat"]

    # The documents the sale statuses leave out: cancelled sales (declined taps, voids).
    from app.services.scoping import scope_transactions_by_user

    cancelled = {"count": 0, "amount": 0.0}
    cq = scope_transactions_by_user(
        db.query(Transaction).filter(
            Transaction.tenant_id == tenant_id,
            Transaction.status == TransactionStatus.CANCELLED,
            Transaction.created_at >= window.start,
            Transaction.created_at < window.end,
        ),
        user,
        db,
    )
    if cq is not None:
        if shop_ids:
            cq = cq.filter(Transaction.shop_id.in_(list(shop_ids)))
        if machine_ids:
            cq = cq.filter(Transaction.machine_id.in_(list(machine_ids)))
        n, amount = cq.with_entities(func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)).one()
        cancelled = {"count": int(n or 0), "amount": _r(amount)}

    catalog = items_and_categories(db, user, tenant_id, window, shop_ids, machine_ids)

    zq = z_table.filtered_z_query(
        db, user, tenant_id, from_date=window.from_date, to_date=window.to_date,
        shop_ids=shop_ids, machine_ids=machine_ids,
    )
    zs = {"total": 0, "zs": [], "tills": [], "paymentMethods": []}
    if zq is not None:
        rows = zq.order_by(ZReport.business_date.desc(), ZReport.closed_at.desc()).limit(z_table.Z_TABLE_MAX).all()
        from app.services.reports import _load_zoneinfo

        zs = z_table.build_z_table(db, rows, _load_zoneinfo(window.tz_name))

    machines = machines_in_scope(db, user, tenant_id, shop_ids, machine_ids)
    transmissions = transmissions_section(db, machines, window)
    failed = failed_payments_section(db, user, tenant_id, window, shop_ids, machine_ids)

    summary.update(
        cancelledDocuments=cancelled["count"],
        cancelledAmount=cancelled["amount"],
        failedAttempts=failed["summary"]["count"],
        zCount=zs["total"],
        transmissions=transmissions["count"],
    )
    return {
        **head,
        "empty": False,
        "summary": summary,
        "byPaymentMethod": by_payment_method(tx_q),
        "cardBrands": catalog["cardBrands"],
        "byTill": tills,
        "byEmployee": employees,
        "byDay": by_day(window, tx_q),
        "byCategory": catalog["categories"],
        "byItem": catalog["items"],
        "itemsTruncated": catalog["itemsTruncated"],
        "refunds": refunds_section(db, tx_q),
        "discounts": discounts_section(tx_q, tills, employees),
        "tips": tips_section(tx_q, tills, employees),
        "vat": vat,
        "zs": zs,
        "transmissions": transmissions,
        "failedPayments": failed,
        "meals": meals_section(db, tx_q, window),
        "kiosks": kiosk_section(db, tx_q, tills),
    }

