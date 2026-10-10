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

Till anomalies and quick actions (docs/SPEC_INSIGHTS.md §10):

GET  /insights/anomalies                         → each till against its peers (`window`:
                                                   period | today): cards and the figures
GET  /insights/anomaly-settings                  → the organization's thresholds
PUT  /insights/anomaly-settings                  → … replaced (super admin)
GET  /insights/quick-actions                     → recent quick actions with their result
GET  /insights/quick-actions/promotions/suggestion → a product's price, cost and offers
POST /insights/quick-actions/messages            → "הודעה מהירה": a banner to the tills
POST /insights/quick-actions/messages/{id}/cancel
POST /insights/quick-actions/promotions          → "מבצע מהיר": a promotion, never below cost
POST /insights/quick-actions/promotions/{id}/cancel → "בטל מבצע"
GET  /insights/happy-hours/suggestions           → weak weekday × hour slots as happy hours
POST /insights/quick-actions/happy-hours         → "Happy hour מתוזמן": weekdays × an hour window

A quick promotion may be on a product, a category or the whole basket ("מבצע מזדמן"), and
any of them may announce itself to the cashiers (`announce`, app/services/promotion_announcements.py).

`eventId` on any read: the scope is a report event (docs/SPEC_EVENTS.md) — its tills, its
window, its business days.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
from app.models.user import User
from app.services import promotions as P
from app.services import till_messages as TM
from app.services.areas import parse_area_filter
from app.services.insights import feed as F
from app.services.insights import quick_actions as Q
from app.services.insights import service as S
from app.services.insights.data import InsightScope, _as_dt

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
    event_id: Optional[uuid.UUID] = None


def insight_params(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId", description="Narrow to this company and its subsidiaries."),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId", description="A point of sale's id, or `none`."),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    from_date: Optional[date] = Query(None, alias="from", description="First business day (inclusive)."),
    to_date: Optional[date] = Query(None, alias="to", description="Last business day (inclusive); at most today."),
    days: Optional[int] = Query(None, ge=1, le=366, description="Without from/to: the complete days ending yesterday (28)."),
    tz: Optional[str] = Query(None, description="IANA timezone; the tenant's, else Asia/Jerusalem."),
    day_start_hour: Optional[int] = Query(
        None, alias="dayStartHour", ge=0, le=12,
        description="When a business day ends/starts; default: the scope's \"שעת סיום יום עסקי\" (04:00 unless set).",
    ),
    event_id: Optional[uuid.UUID] = Query(None, alias="eventId", description="A report event: its tills, window and days (the period is ignored)."),
) -> InsightParams:
    return InsightParams(company_id, shop_id, area_id, machine_id, from_date, to_date, days, tz, day_start_hour, event_id)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    return value if isinstance(value, uuid.UUID) else None


def _clock_scope(p: "InsightParams") -> dict:
    """The level whose "שעת סיום יום עסקי" the insights' days end at (app/services/business_day.py)."""
    from app.services.business_day import scope_of

    return scope_of(company_id=p.company_id, shop_id=p.shop_id, area_id=p.area_id, machine_id=p.machine_id)


def _event_context(db: Session, user: User, tenant_id, p: InsightParams, clock) -> S.InsightsContext:
    """An event's scope: its shop, its tills (a till of it narrows), its window and its days."""
    from app.services.report_events.crud import load_event

    event = load_event(db, user, tenant_id, p.event_id)
    machine_ids = tuple(row.machine_id for row in event.machines)
    machine_id = _uuid(p.machine_id)
    if machine_id is not None and machine_id not in machine_ids:
        machine_id = None
    starts, ends = _as_dt(event.starts_at), _as_dt(event.ends_at)
    scope = InsightScope(
        user=user,
        tenant_id=tenant_id,
        shop_id=event.shop_id,
        machine_id=machine_id,
        machine_ids=machine_ids,
        window_start=starts,
        window_end=ends,
        event=event,
    )
    return S.InsightsContext(db, scope, clock, S.event_period(clock, starts, ends))


def build_context(db: Session, user: User, tenant_id, p: InsightParams) -> S.InsightsContext:
    clock = S.make_clock(db, tenant_id, tz=p.tz, day_start_hour=p.day_start_hour, scope=_clock_scope(p))
    if _uuid(p.event_id) is not None:
        return _event_context(db, user, tenant_id, p, clock)
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


# ── Till anomalies ────────────────────────────────────────────────────────────


@router.get("/anomalies")
def get_till_anomalies(
    window: str = Query("period", pattern="^(period|today)$", description="The page's period (an event: its window), or today so far."),
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Each till against its peers (median and MAD): weak sales, an odd average ticket, odd cash."""
    kind = window if isinstance(window, str) else "period"
    return _section(S.anomalies, p, current_user, active_tenant_id, db, window=kind)


@router.get("/anomaly-settings")
def get_anomaly_settings(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The organization's anomaly thresholds, the defaults and the limits."""
    return S.anomaly_settings(db, current_user, active_tenant_id)


@router.put("/anomaly-settings")
def put_anomaly_settings(
    thresholds: Optional[Dict[str, Any]] = Body(None, embed=True, description="Keys of DEFAULT_THRESHOLDS; missing: the default."),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Replace the organization's anomaly thresholds (the super admin: they hold for every company)."""
    return S.set_anomaly_settings(db, current_user, active_tenant_id, thresholds)


# ── Quick actions ─────────────────────────────────────────────────────────────


@router.get("/quick-actions")
def list_quick_actions(
    product_id: Optional[uuid.UUID] = Query(None, alias="productId"),
    limit: int = Query(30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Recent quick messages and promotions that reached a till the caller sees, with their result."""
    pid = product_id if isinstance(product_id, uuid.UUID) else None
    n = limit if isinstance(limit, int) else 30
    return Q.list_quick_actions(db, current_user, active_tenant_id, product_id=pid, limit=n)


@router.get("/quick-actions/promotions/suggestion")
def get_promotion_suggestion(
    product_id: Optional[uuid.UUID] = Query(None, alias="productId"),
    category_id: Optional[uuid.UUID] = Query(None, alias="categoryId"),
    all_products: bool = Query(False, alias="all", description="The whole basket (a happy hour, an ad-hoc promotion)."),
    target_level: Optional[str] = Query(None, alias="targetLevel"),
    target_id: Optional[uuid.UUID] = Query(None, alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A product's price (lowest in the target) and cost — or a category's / everything's costed products — the offers, the suggested one."""
    body = {
        "productId": product_id if isinstance(product_id, uuid.UUID) else None,
        "categoryId": category_id if isinstance(category_id, uuid.UUID) else None,
        "all": all_products is True,
        "targetLevel": target_level if isinstance(target_level, str) else None,
        "targetId": target_id if isinstance(target_id, uuid.UUID) else None,
    }
    return Q.promotion_suggestion(db, current_user, active_tenant_id, body)


@router.post("/quick-actions/messages", status_code=status.HTTP_201_CREATED)
def post_quick_message(
    background_tasks: BackgroundTasks,
    body: Dict[str, Any] = Body(..., description="text, targetLevel, targetId, duration, productId?, display?, color?, source?"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"הודעה מהירה": a banner to the target's tills that ends by itself (the till messages' rule)."""
    action, machines = Q.send_quick_message(db, current_user, active_tenant_id, body)
    targets = TM.notify_targets(machines)
    db.commit()
    background_tasks.add_task(TM.publish_message_notify, targets)
    return Q.action_out(action, Q._now())


@router.post("/quick-actions/messages/{action_id}/cancel")
def cancel_quick_message(
    action_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Take the quick message down now; idempotent."""
    done = Q.cancel_quick_message(db, current_user, active_tenant_id, action_id)
    targets = TM.notify_targets(done.woken)
    db.commit()
    background_tasks.add_task(TM.publish_message_notify, targets)
    # Some of an event's tills may be another's: those messages stay, and the answer says so.
    return {**Q.action_out(done.action, Q._now()), "partial": done.skipped > 0, "skipped": done.skipped}


def _promotions_changed(db: Session, tenant_id, background_tasks: BackgroundTasks, woken=()) -> None:
    """Commit; wake the tills for the promotions, and those an announcement reached now."""
    targets = P.notify_targets(db, tenant_id)
    message_targets = TM.notify_targets(woken)
    db.commit()
    background_tasks.add_task(P.publish_promotions_notify, targets)
    if message_targets:
        background_tasks.add_task(TM.publish_message_notify, message_targets)


@router.post("/quick-actions/promotions", status_code=status.HTTP_201_CREATED)
def post_quick_promotion(
    background_tasks: BackgroundTasks,
    body: Dict[str, Any] = Body(..., description="productId | categoryId | all, targetLevel, targetId, offer {kind, value}, duration, announce?, source?"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"מבצע מהיר" / "מבצע מזדמן": a promotion for the target's tills, ending by itself, never below cost."""
    action, woken = Q.create_quick_promotion(db, current_user, active_tenant_id, body)
    _promotions_changed(db, active_tenant_id, background_tasks, woken)
    return Q.action_out(action, Q._now())


@router.post("/quick-actions/promotions/{action_id}/cancel")
def cancel_quick_promotion(
    action_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"בטל מבצע": the promotion is paused now (the tills drop it on their next pull)."""
    done = Q.cancel_quick_promotion(db, current_user, active_tenant_id, action_id)
    _promotions_changed(db, active_tenant_id, background_tasks, done.woken)
    return Q.action_out(done.action, Q._now())


# ── Happy hour ────────────────────────────────────────────────────────────────


@router.get("/happy-hours/suggestions")
def get_happy_hour_suggestions(
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The weakest weekday × hour slots of the period as happy-hour windows, with what they overlap."""
    ctx = build_context(db, current_user, active_tenant_id, p)
    return {**S.meta_block(ctx), **Q.happy_hour_suggestions(ctx, S.heatmap(ctx))}


@router.post("/quick-actions/happy-hours", status_code=status.HTTP_201_CREATED)
def post_happy_hour(
    background_tasks: BackgroundTasks,
    body: Dict[str, Any] = Body(..., description="weekdays, startTime, endTime, weeks?, offer, categoryId | all | productId, targetLevel, targetId, announce?"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"Happy hour מתוזמן": a weekly promotion in an hour window, for some weeks from today."""
    action, woken = Q.create_happy_hour(db, current_user, active_tenant_id, body)
    _promotions_changed(db, active_tenant_id, background_tasks, woken)
    return Q.action_out(action, Q._now())
