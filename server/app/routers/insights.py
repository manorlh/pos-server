"""
Insights ("תובנות") — the manager's analyses, docs/SPEC_INSIGHTS.md.

Dashboard-only (Clerk/user JWT + X-Tenant-Id), scoped exactly like the control board: the
caller's role decides what they see, and `companyId` / `shopId` / `areaId` / `machineId`
only narrow it. Every money figure is **integer agorot**.

Period: `from`–`to` (business days, inclusive) or `days` (the complete days ending
yesterday; 28 by default), compared with the period of the same length before it. A
business day starts at `dayStartHour` (04:00 by default) in the tenant's timezone
(Asia/Jerusalem unless configured), so a sale at 01:30 belongs to the evening before.

GET  /insights                     → the feed: cards (type, severity, params), headline
                                     figures, what data exists
GET  /insights/kpis                → headline figures, period vs the period before
GET  /insights/menu-engineering    → Kasavana–Smith matrix (`categoryId` to narrow)
GET  /insights/abc                 → ABC (Pareto) classes over net revenue
GET  /insights/products/slow       → dead items, slow movers, declines
GET  /insights/stock               → days of cover and stock-out risk (stocked products)
GET  /insights/heatmap             → weekday × hour, weak and peak slots
GET  /insights/trends              → the daily series vs the same weekday, week over week,
                                     rising / falling products
GET  /insights/forecast            → today's pace, the next 7 days, tomorrow by the hour
GET  /insights/baskets             → average check, items per sale, basket sizes, pairs
GET  /insights/cashiers            → discount / refund / void rates per employee
GET  /insights/tables-live         → open tables now (the control board's widget)
GET  /insights/tables              → covers, spend per cover, seated time, turnover
GET  /insights/customers           → identified and repeat customers
PUT  /insights/product-costs/{id}  → a product's unit cost (excl. VAT); `null` clears it
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services.areas import parse_area_filter
from app.services.insights import feed as F
from app.services.insights import service as S
from app.services.insights.data import InsightScope

router = APIRouter(prefix="/insights", tags=["insights"])


@dataclass
class InsightParams:
    company_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    area_id: Optional[str] = None
    machine_id: Optional[uuid.UUID] = None
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    days: Optional[int] = None
    tz: Optional[str] = None
    day_start_hour: Optional[int] = None


def insight_params(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId", description="Narrow to this company and its subsidiaries."),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId", description="A point of sale's id, or `none`."),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    from_date: Optional[date] = Query(None, alias="from", description="First business day (inclusive)."),
    to_date: Optional[date] = Query(None, alias="to", description="Last business day (inclusive); at most today."),
    days: Optional[int] = Query(None, ge=1, le=366, description="Without from/to: the complete days ending yesterday (28)."),
    tz: Optional[str] = Query(None, description="IANA timezone; the tenant's, else Asia/Jerusalem."),
    day_start_hour: Optional[int] = Query(None, alias="dayStartHour", ge=0, le=8, description="When a business day starts (04:00)."),
) -> InsightParams:
    return InsightParams(company_id, shop_id, area_id, machine_id, from_date, to_date, days, tz, day_start_hour)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    return value if isinstance(value, uuid.UUID) else None


def build_context(db: Session, user: User, tenant_id, p: InsightParams) -> S.InsightsContext:
    clock = S.make_clock(db, tenant_id, tz=p.tz, day_start_hour=p.day_start_hour)
    period = S.resolve_period(clock, p.from_date, p.to_date, p.days)
    scope = InsightScope(
        user=user,
        tenant_id=tenant_id,
        company_id=_uuid(p.company_id),
        shop_id=_uuid(p.shop_id),
        area_filter=parse_area_filter(p.area_id),
        machine_id=_uuid(p.machine_id),
    )
    return S.InsightsContext(db, scope, clock, period)


def _section(builder, p: InsightParams, user: User, tenant_id, db: Session, **kwargs) -> dict:
    ctx = build_context(db, user, tenant_id, p)
    return {**S.meta_block(ctx), **builder(ctx, **kwargs)}


@router.get("")
def get_insights_feed(
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The feed: what to look at first, as cards, with the headline figures."""
    return F.build_feed(build_context(db, current_user, active_tenant_id, p))


@router.get("/kpis")
def get_insights_kpis(
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Net, sales, average check, items per sale, discount / refund / tip rates — vs before."""
    ctx = build_context(db, current_user, active_tenant_id, p)
    return {**S.meta_block(ctx), "kpis": S.kpis(ctx), "availability": S.availability(ctx)}


@router.get("/menu-engineering")
def get_menu_engineering(
    category_id: Optional[uuid.UUID] = Query(None, alias="categoryId"),
    by_category: bool = Query(True, alias="byCategory", description="Judge each item within its category (Kasavana–Smith)."),
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Popularity × contribution margin (price excl. VAT when costs are missing)."""
    cat = str(category_id) if isinstance(category_id, uuid.UUID) else None
    grouped = by_category if isinstance(by_category, bool) else True
    return _section(S.menu_engineering, p, current_user, active_tenant_id, db, category_id=cat, by_category=grouped)


@router.get("/abc")
def get_abc(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
            active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """A = the items making the first 80% of the net, B the next 15%, C the last 5%."""
    return _section(S.abc, p, current_user, active_tenant_id, db)


@router.get("/products/slow")
def get_slow_products(
    dead_days: int = Query(21, alias="deadDays", ge=7, le=120, description="Days without a sale that make an item dead."),
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Not sold for `deadDays`+ days while on sale; the long tail; 40%+ declines."""
    days = dead_days if isinstance(dead_days, int) else 21
    return _section(S.slow, p, current_user, active_tenant_id, db, dead_days=days)


@router.get("/stock")
def get_stock_risk(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                   active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Days of cover per stocked product and shop, the risk and a suggested order."""
    return _section(S.stock, p, current_user, active_tenant_id, db)


@router.get("/heatmap")
def get_heatmap(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Average net per weekday × hour; the weak and the peak slots."""
    return _section(S.heatmap, p, current_user, active_tenant_id, db)


@router.get("/trends")
def get_trends(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
               active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Each day against its weekday's last four; this week against last; products moving."""
    return _section(S.trends, p, current_user, active_tenant_id, db)


@router.get("/forecast")
def get_forecast(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                 active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Today's pace, the next seven days (with a range and the method's recent error)."""
    return _section(S.forecast, p, current_user, active_tenant_id, db)


@router.get("/baskets")
def get_baskets(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Average check, items per sale, basket sizes and the pairs bought together."""
    return _section(S.baskets, p, current_user, active_tenant_id, db)


@router.get("/cashiers")
def get_cashier_rates(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                      active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Manual discount, refund and void rates per employee against the team."""
    return _section(S.cashiers, p, current_user, active_tenant_id, db)


@router.get("/tables-live")
def get_tables_live(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                    active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Open tables now: count, guests, open amount, the longest seated, occupancy."""
    return _section(S.tables_live, p, current_user, active_tenant_id, db)


@router.get("/tables")
def get_tables_kpis(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                    active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Covers, spend per cover, seated time, turnover — vs the period before."""
    return _section(S.tables, p, current_user, active_tenant_id, db)


@router.get("/customers")
def get_customers(p: InsightParams = Depends(insight_params), current_user: User = Depends(get_current_user),
                  active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    """Identified customers and how many came back."""
    return _section(S.customers, p, current_user, active_tenant_id, db)


@router.put("/product-costs/{product_id}")
def put_product_cost(
    product_id: uuid.UUID,
    cost: Optional[float] = Body(None, embed=True, description="Per unit, shekels excl. VAT; null clears it."),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What a unit of the product costs (excl. VAT), for the menu engineering."""
    return S.set_product_cost(db, current_user, active_tenant_id, product_id, cost)
