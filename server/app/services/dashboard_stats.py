"""Aggregate sales KPIs for the dashboard overview."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Query, Session

from app.models.company import Company
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.schemas.dashboard import DashboardBreakdownRow, DashboardStatsResponse

SALE_STATUSES = (
    TransactionStatus.COMPLETED,
    TransactionStatus.REFUNDED,
    TransactionStatus.PARTIAL_REFUND,
)


def _to_float(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _apply_time_window(query: Query, from_dt: datetime, to_dt: datetime) -> Query:
    return query.filter(
        Transaction.created_at >= from_dt,
        Transaction.created_at < to_dt,
    )


def _zero_stats(from_dt: datetime, to_dt: datetime) -> DashboardStatsResponse:
    now = datetime.now(timezone.utc)
    return DashboardStatsResponse(
        gross_revenue=0.0,
        net_revenue=0.0,
        transactions_count=0,
        average_basket=0.0,
        items_sold=0.0,
        refunds_count=0,
        refunds_amount=0.0,
        tips_cash=0.0,
        tips_card=0.0,
        payment_cash=0.0,
        payment_card=0.0,
        from_=from_dt,
        to=to_dt,
        generated_at=now,
    )


def compute_sales_summary(
    db: Session,
    scoped_query: Optional[Query],
    from_dt: datetime,
    to_dt: datetime,
) -> DashboardStatsResponse:
    if scoped_query is None:
        return _zero_stats(from_dt, to_dt)

    base = _apply_time_window(scoped_query, from_dt, to_dt)

    sale_q = base.filter(
        Transaction.refund_of_transaction_id.is_(None),
        Transaction.status.in_(SALE_STATUSES),
    )

    sale_agg = sale_q.with_entities(
        func.coalesce(func.sum(Transaction.total_amount), 0).label("gross"),
        func.count(Transaction.id).label("tx_count"),
        func.coalesce(func.sum(Transaction.tip_amount), 0).label("tips_total"),
    ).one()

    gross = _to_float(sale_agg.gross)
    tx_count = int(sale_agg.tx_count or 0)
    avg_basket = gross / tx_count if tx_count > 0 else 0.0

    items_row = (
        db.query(func.coalesce(func.sum(TransactionItem.quantity), 0))
        .filter(
            TransactionItem.transaction_id.in_(
                sale_q.with_entities(Transaction.id),
            ),
        )
        .scalar()
    )
    items_sold = _to_float(items_row)

    refund_q = base.filter(Transaction.refund_of_transaction_id.isnot(None))
    refund_agg = refund_q.with_entities(
        func.coalesce(func.sum(Transaction.total_amount), 0).label("amount"),
        func.count(Transaction.id).label("count"),
    ).one()
    refunds_amount = _to_float(refund_agg.amount)
    refunds_count = int(refund_agg.count or 0)
    net = gross - refunds_amount

    payment_rows = (
        sale_q.with_entities(
            Transaction.payment_method,
            func.coalesce(func.sum(Transaction.total_amount), 0).label("amount"),
        )
        .group_by(Transaction.payment_method)
        .all()
    )
    payment_cash = 0.0
    payment_card = 0.0
    for method, amount in payment_rows:
        m = (method or "").lower()
        amt = _to_float(amount)
        if m == "cash":
            payment_cash += amt
        elif m == "card":
            payment_card += amt

    tip_rows = (
        sale_q.filter(Transaction.tip_amount > 0)
        .with_entities(
            Transaction.tip_payment_method,
            Transaction.payment_method,
            func.coalesce(func.sum(Transaction.tip_amount), 0).label("amount"),
        )
        .group_by(Transaction.tip_payment_method, Transaction.payment_method)
        .all()
    )
    tips_cash = 0.0
    tips_card = 0.0
    for tip_method, pay_method, amount in tip_rows:
        m = (tip_method or pay_method or "").lower()
        amt = _to_float(amount)
        if m == "cash":
            tips_cash += amt
        elif m == "card":
            tips_card += amt

    return DashboardStatsResponse(
        gross_revenue=gross,
        net_revenue=net,
        transactions_count=tx_count,
        average_basket=avg_basket,
        items_sold=items_sold,
        refunds_count=refunds_count,
        refunds_amount=refunds_amount,
        tips_cash=tips_cash,
        tips_card=tips_card,
        payment_cash=payment_cash,
        payment_card=payment_card,
        from_=from_dt,
        to=to_dt,
        generated_at=datetime.now(timezone.utc),
    )


def compute_breakdown(
    db: Session,
    scoped_query: Optional[Query],
    from_dt: datetime,
    to_dt: datetime,
    group_by: str,
) -> list[DashboardBreakdownRow]:
    """Revenue grouped by company or by shop, within the scoped + windowed set."""
    if scoped_query is None:
        return []

    base = _apply_time_window(scoped_query, from_dt, to_dt)

    sale_cond = and_(
        Transaction.refund_of_transaction_id.is_(None),
        Transaction.status.in_(SALE_STATUSES),
    )
    refund_cond = Transaction.refund_of_transaction_id.isnot(None)

    gross_expr = func.coalesce(
        func.sum(case((sale_cond, Transaction.total_amount), else_=0)), 0
    )
    refund_expr = func.coalesce(
        func.sum(case((refund_cond, Transaction.total_amount), else_=0)), 0
    )
    count_expr = func.coalesce(
        func.sum(case((sale_cond, 1), else_=0)), 0
    )

    if group_by == "shop":
        q = (
            base.join(Shop, Shop.id == Transaction.shop_id)
            .with_entities(
                Shop.id.label("group_id"),
                Shop.name.label("group_name"),
                gross_expr.label("gross"),
                refund_expr.label("refunds"),
                count_expr.label("cnt"),
            )
            .group_by(Shop.id, Shop.name)
        )
    else:
        q = (
            base.join(Shop, Shop.id == Transaction.shop_id)
            .join(Company, Company.id == Shop.company_id)
            .with_entities(
                Company.id.label("group_id"),
                Company.name.label("group_name"),
                gross_expr.label("gross"),
                refund_expr.label("refunds"),
                count_expr.label("cnt"),
            )
            .group_by(Company.id, Company.name)
        )

    rows: list[DashboardBreakdownRow] = []
    for r in q.all():
        gross = _to_float(r.gross)
        refunds = _to_float(r.refunds)
        rows.append(
            DashboardBreakdownRow(
                id=r.group_id,
                name=r.group_name or "—",
                gross_revenue=gross,
                net_revenue=gross - refunds,
                transactions_count=int(r.cnt or 0),
            )
        )

    rows.sort(key=lambda x: x.gross_revenue, reverse=True)
    return rows
