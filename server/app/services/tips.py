"""Tips aggregation and distribution for dashboard reports."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Dict, List, Optional
import uuid

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.transaction import Transaction, TransactionStatus
from app.schemas.tips import TipCashierRow, TipsReportResponse
from app.services.settings_merge import merge_all_settings_layers


def _decimal(v) -> Decimal:
    if v is None:
        return Decimal("0")
    return Decimal(str(v))


def _resolve_distribution(company: Company, shop: Shop, tenant: Optional[Tenant]) -> str:
    merged = merge_all_settings_layers(company, shop, tenant)
    dist = merged.get("tipDistribution")
    if dist in ("direct", "equal_pool", "by_sales"):
        return dist
    return "direct"


def build_tips_report(
    db: Session,
    shop: Shop,
    *,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    trading_day_id: Optional[uuid.UUID] = None,
) -> TipsReportResponse:
    company = db.query(Company).filter(Company.id == shop.company_id).first()
    tenant = db.query(Tenant).filter(Tenant.id == shop.tenant_id).first() if shop.tenant_id else None
    distribution = _resolve_distribution(company, shop, tenant)

    q = db.query(Transaction).filter(
        Transaction.shop_id == shop.id,
        Transaction.status == TransactionStatus.COMPLETED,
    )
    if trading_day_id:
        q = q.filter(Transaction.trading_day_id == trading_day_id)
    else:
        if from_date:
            start = datetime.combine(from_date, time.min, tzinfo=timezone.utc)
            q = q.filter(Transaction.created_at >= start)
        if to_date:
            end = datetime.combine(to_date, time.max, tzinfo=timezone.utc)
            q = q.filter(Transaction.created_at <= end)

    rows = q.all()

    by_cashier: Dict[str, dict] = defaultdict(
        lambda: {
            "tips_collected": Decimal("0"),
            "cash_tips": Decimal("0"),
            "card_tips": Decimal("0"),
            "sales_total": Decimal("0"),
            "transaction_count": 0,
        }
    )

    for tx in rows:
        cid = tx.cashier_id or "__unknown__"
        tip = _decimal(tx.tip_amount)
        sales = _decimal(tx.total_amount)
        by_cashier[cid]["tips_collected"] += tip
        by_cashier[cid]["sales_total"] += sales
        by_cashier[cid]["transaction_count"] += 1
        method = (tx.tip_payment_method or tx.payment_method or "").lower()
        if method == "cash":
            by_cashier[cid]["cash_tips"] += tip
        elif method == "card":
            by_cashier[cid]["card_tips"] += tip
        elif tip > 0:
            # Fallback: attribute to payment method of sale
            if (tx.payment_method or "").lower() == "cash":
                by_cashier[cid]["cash_tips"] += tip
            else:
                by_cashier[cid]["card_tips"] += tip

    total_tips = sum(v["tips_collected"] for v in by_cashier.values())
    total_cash_tips = sum(v["cash_tips"] for v in by_cashier.values())
    total_card_tips = sum(v["card_tips"] for v in by_cashier.values())
    total_sales = sum(v["sales_total"] for v in by_cashier.values())

    # Load pos user names
    cashier_ids = [k for k in by_cashier.keys() if k != "__unknown__"]
    pos_users: Dict[str, PosUser] = {}
    if cashier_ids:
        for pu in db.query(PosUser).filter(PosUser.id.in_(cashier_ids)).all():
            pos_users[str(pu.id)] = pu

    eligible = [
        cid
        for cid, agg in by_cashier.items()
        if agg["transaction_count"] > 0 and cid != "__unknown__"
    ]
    n_eligible = len(eligible) or 1

    cashier_rows: List[TipCashierRow] = []
    for cid, agg in sorted(by_cashier.items(), key=lambda x: -x[1]["tips_collected"]):
        pu = pos_users.get(cid) if cid != "__unknown__" else None
        name = None
        if pu:
            parts = [pu.first_name or "", pu.last_name or ""]
            name = " ".join(p for p in parts if p).strip() or pu.username

        if distribution == "direct":
            owed = agg["tips_collected"]
        elif distribution == "equal_pool":
            owed = total_tips / Decimal(n_eligible) if cid in eligible else Decimal("0")
        else:  # by_sales
            if total_sales > 0 and cid in eligible:
                owed = total_tips * (agg["sales_total"] / total_sales)
            else:
                owed = Decimal("0")

        cashier_rows.append(
            TipCashierRow(
                cashier_id=None if cid == "__unknown__" else cid,
                cashier_name=name or ("Unknown" if cid == "__unknown__" else cid),
                worker_number=pu.worker_number if pu else None,
                tips_collected=agg["tips_collected"],
                cash_tips=agg["cash_tips"],
                card_tips=agg["card_tips"],
                sales_total=agg["sales_total"],
                transaction_count=agg["transaction_count"],
                amount_owed=owed.quantize(Decimal("0.01")),
            )
        )

    return TipsReportResponse(
        shop_id=shop.id,
        distribution=distribution,
        from_date=from_date.isoformat() if from_date else None,
        to_date=to_date.isoformat() if to_date else None,
        total_tips=total_tips,
        total_cash_tips=total_cash_tips,
        total_card_tips=total_card_tips,
        total_sales=total_sales,
        cashiers=cashier_rows,
    )
