"""
Live sales by item ("מכירות לפי פריט — חי"): what each product has sold so far, over a
company, shop, area (point of sale) or till, for the manager's phone.

The product sales report's definition exactly — the same documents
(`build_scoped_transaction_query`: the role's scope, `SALE_STATUSES`, the report
window), the same line arithmetic (a credit note's line reduces `net` and `qty`, never
adds to `gross`) and the same grouping on the line's snapshot — so a product's figures
here and on that report over the same day are the same figures. One grouped query,
whatever the scope.

The extra over that report: a company scope (with its subsidiaries, as on the
overview), and the "this shift" period — the documents of the shifts open now in the
scope, from whenever each one began.
"""
from __future__ import annotations

import uuid as uuid_mod
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.schemas.live_items import LiveItemRow, LiveItemTotals, LiveItemsResponse
from app.services.areas import transaction_area_predicate
from app.services.company_hierarchy import descendant_company_ids
from app.services.dashboard_stats import SALE_STATUSES
from app.services.reports import (
    ReportWindow,
    _cents,
    _is_refund_condition,
    _to_float,
    build_scoped_transaction_query,
)
from app.services.scoping import scope_transactions_by_user

LIVE_ITEMS_DEFAULT = 500
LIVE_ITEMS_MAX = 1000

PERIOD_DAY = "day"
PERIOD_RANGE = "range"
PERIOD_SHIFT = "shift"


def _open_shift_query(
    db: Session,
    current_user: User,
    tenant_id,
    *,
    shop_id=None,
    machine_id=None,
    area_filter=None,
):
    """The documents of the shifts open now, scoped like every report; None for none."""
    query = scope_transactions_by_user(
        db.query(Transaction).filter(Transaction.tenant_id == tenant_id), current_user, db
    )
    if query is None:
        return None, 0
    open_shifts = db.query(Shift.id).filter(
        Shift.tenant_id == tenant_id, Shift.status == ShiftStatus.OPEN
    )
    if shop_id is not None:
        open_shifts = open_shifts.filter(Shift.shop_id == shop_id)
    if machine_id is not None:
        open_shifts = open_shifts.filter(Shift.machine_id == machine_id)
    shift_ids = [row[0] for row in open_shifts.all()]
    if not shift_ids:
        return None, 0
    query = query.filter(
        Transaction.status.in_(SALE_STATUSES), Transaction.duplicate_copy.is_(False),
        Transaction.shift_id.in_(shift_ids),
    )
    if shop_id is not None:
        query = query.filter(Transaction.shop_id == shop_id)
    if machine_id is not None:
        query = query.filter(Transaction.machine_id == machine_id)
    area_pred = transaction_area_predicate(area_filter)
    if area_pred is not None:
        query = query.filter(area_pred)
    return query, len(shift_ids)


def build_live_items(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    period: str = PERIOD_DAY,
    company_id: Optional[uuid_mod.UUID] = None,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
    area_filter=None,
    limit: int = LIVE_ITEMS_DEFAULT,
) -> LiveItemsResponse:
    now = datetime.now(timezone.utc)
    open_shift_count: Optional[int] = None
    if period == PERIOD_SHIFT:
        tx_q, open_shift_count = _open_shift_query(
            db, current_user, tenant_id,
            shop_id=shop_id, machine_id=machine_id, area_filter=area_filter,
        )
    else:
        tx_q = build_scoped_transaction_query(
            db, current_user, tenant_id, window,
            shop_id=shop_id, machine_id=machine_id, area_filter=area_filter,
        )
    if tx_q is not None and company_id is not None:
        # A holding company means the group, as on the overview; AND-ed onto the role's
        # scope, so it can only narrow.
        group = descendant_company_ids(db, company_id)
        tx_q = tx_q.filter(
            Transaction.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group)))
        )

    def response(rows, totals, truncated=False):
        return LiveItemsResponse(
            window=window.to_schema(),
            generated_at=now,
            period=period,
            open_shift_count=open_shift_count,
            truncated=truncated,
            row_limit=limit,
            totals=totals,
            rows=rows,
        )

    if tx_q is None:
        return response(
            [], LiveItemTotals(qty=0, gross=0, discounts=0, refunds=0, net=0, product_count=0)
        )

    tx_sub = tx_q.with_entities(
        Transaction.id.label("tx_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    is_refund = tx_sub.c.is_refund
    qty = TransactionItem.quantity
    line_total = TransactionItem.total_price
    # The line's own discount and its promotions' share ("מבצעים").
    line_discount = func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0)

    grouped = (
        db.query(
            TransactionItem.product_id.label("product_id"),
            TransactionItem.sku.label("sku"),
            TransactionItem.product_name.label("product_name"),
            func.coalesce(func.sum(case((is_refund.is_(False), qty), else_=0)), 0).label("units_sold"),
            func.coalesce(func.sum(case((is_refund.is_(True), qty), else_=0)), 0).label("units_refunded"),
            func.coalesce(func.sum(case((is_refund.is_(False), line_total), else_=0)), 0).label("gross"),
            func.coalesce(func.sum(case((is_refund.is_(False), line_discount), else_=0)), 0).label("discounts"),
            # A credit-note line's total is already net of its discount (see the
            # product sales report), so it is taken as-is.
            func.coalesce(func.sum(case((is_refund.is_(True), line_total), else_=0)), 0).label("refunds"),
        )
        .select_from(TransactionItem)
        .join(tx_sub, tx_sub.c.tx_id == TransactionItem.transaction_id)
        .group_by(TransactionItem.product_id, TransactionItem.sku, TransactionItem.product_name)
        .all()
    )

    raw = []
    t = dict(qty=0.0, gross=0.0, discounts=0.0, refunds=0.0)
    for r in grouped:
        sold, refunded = _to_float(r.units_sold), _to_float(r.units_refunded)
        gross, discounts, refunds = _to_float(r.gross), _to_float(r.discounts), _to_float(r.refunds)
        t["qty"] += sold - refunded
        t["gross"] += gross
        t["discounts"] += discounts
        t["refunds"] += refunds
        raw.append((r, sold, refunded, gross, discounts, refunds, gross - discounts - refunds))
    total_net = t["gross"] - t["discounts"] - t["refunds"]

    rows = [
        LiveItemRow(
            product_id=r.product_id,
            sku=r.sku,
            name=r.product_name,
            qty=round(sold - refunded, 3),
            units_sold=round(sold, 3),
            units_refunded=round(refunded, 3),
            gross=_cents(gross),
            discounts=_cents(discounts),
            refunds=_cents(refunds),
            net=_cents(net),
            share=round(net / total_net * 100, 2) if total_net > 0 else 0.0,
        )
        for r, sold, refunded, gross, discounts, refunds, net in raw
    ]
    # Best earner first, as on the product sales report.
    rows.sort(key=lambda x: (-x.net, -x.qty, (x.name or "").lower()))
    totals = LiveItemTotals(
        qty=round(t["qty"], 3),
        gross=_cents(t["gross"]),
        discounts=_cents(t["discounts"]),
        refunds=_cents(t["refunds"]),
        net=_cents(total_net),
        product_count=len(rows),
    )
    return response(rows[:limit], totals, truncated=len(rows) > limit)
