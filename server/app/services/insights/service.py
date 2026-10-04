"""
Insights ("תובנות") — one request's worth of analysis.

`InsightsContext` loads each data set at most once per request (lazily: a section endpoint
reads only what it needs, the feed reads it all) and the section builders turn them into
the JSON the dashboard draws. Money is integer agorot throughout, in and out.

Periods are **business days** (`BusinessClock`): by default the 28 complete days that end
yesterday, compared with the 28 before them. "Today" is live and is only ever compared
with its own weekday (the pace), never folded into a period's averages.
"""
from __future__ import annotations

import uuid as uuid_mod
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import cached_property
from typing import Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.user import User
from app.services.reports import resolve_report_timezone, _load_zoneinfo
from app.services.permission_matrix import Action, Resource, SHOP_SCOPED_ROLES, roles_for
from app.services.company_hierarchy import user_covers_company
from app.models.user import UserRole

from . import analytics as A
from . import data as D

DEFAULT_DAYS = 28
MAX_DAYS = 366
DEFAULT_DAY_START_HOUR = 4
#: How far back "when did it last sell" looks.
LOOKBACK_DAYS = 120
#: History kept for baselines, the pace and the forecast (nine weeks).
HISTORY_DAYS = 63


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _now() -> datetime:
    """The wall clock; a test freezes it here."""
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class Period:
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def prev_start(self) -> date:
        return self.start - timedelta(days=self.days)

    @property
    def prev_end(self) -> date:
        return self.start - timedelta(days=1)

    def to_json(self) -> dict:
        return {
            "from": self.start.isoformat(),
            "to": self.end.isoformat(),
            "days": self.days,
            "prevFrom": self.prev_start.isoformat(),
            "prevTo": self.prev_end.isoformat(),
        }


def make_clock(db: Session, tenant_id, *, tz: Optional[str], day_start_hour: Optional[int], now: Optional[datetime] = None) -> A.BusinessClock:
    tz_name = resolve_report_timezone(db, tenant_id, tz if isinstance(tz, str) else None)
    _load_zoneinfo(tz_name)  # 400 on an unknown zone
    hour = DEFAULT_DAY_START_HOUR if not isinstance(day_start_hour, int) else day_start_hour
    if not 0 <= hour <= 8:
        raise _bad("dayStartHour must be between 0 and 8")
    return A.BusinessClock(tz_name=tz_name, day_start_hour=hour, now=now or _now())


def resolve_period(clock: A.BusinessClock, from_date: Optional[date], to_date: Optional[date], days: Optional[int]) -> Period:
    """`from`–`to` (business days, inclusive), or the `days` complete days ending yesterday."""
    today = clock.today
    if isinstance(from_date, date) or isinstance(to_date, date):
        end = to_date if isinstance(to_date, date) else today - timedelta(days=1)
        start = from_date if isinstance(from_date, date) else end - timedelta(days=DEFAULT_DAYS - 1)
        if start > end:
            raise _bad("from must be before or equal to to")
        if end > today:
            raise _bad("to cannot be after today")
        if (end - start).days + 1 > MAX_DAYS:
            raise _bad(f"Range too wide. Maximum is {MAX_DAYS} days.")
        return Period(start, end)
    n = days if isinstance(days, int) else DEFAULT_DAYS
    if not 1 <= n <= MAX_DAYS:
        raise _bad(f"days must be between 1 and {MAX_DAYS}")
    end = today - timedelta(days=1)
    return Period(end - timedelta(days=n - 1), end)


# ── The request context ──────────────────────────────────────────────────────


class InsightsContext:
    def __init__(self, db: Session, scope: D.InsightScope, clock: A.BusinessClock, period: Period):
        self.db = db
        self.scope = scope
        self.clock = clock
        self.period = period

    # Time ------------------------------------------------------------------

    @property
    def today(self) -> date:
        return self.clock.today

    def span(self, start: date, end: date):
        """[start of `start`, start of the day after `end`) as UTC instants."""
        return self.clock.day_start(start), self.clock.day_start(end + timedelta(days=1))

    # Structure -------------------------------------------------------------

    @cached_property
    def shops(self):
        return D.scope_shops(self.db, self.scope)

    # Documents -------------------------------------------------------------

    @cached_property
    def cells(self) -> Dict:
        start = min(self.period.prev_start, self.today - timedelta(days=HISTORY_DAYS))
        return D.load_hour_cells(self.db, self.scope, self.clock, start, self.today)

    @cached_property
    def daily(self) -> Dict[date, A.Cell]:
        return A.daily_totals(self.cells)

    @cached_property
    def history_start(self) -> Optional[date]:
        days = [d for d, c in self.daily.items() if c.docs]
        return min(days) if days else None

    def totals(self, start: date, end: date) -> A.Cell:
        return A.window_sum(self.daily, start, end)

    # Products --------------------------------------------------------------

    @cached_property
    def product_sums(self) -> Dict[str, D.ProductAgg]:
        today = self.today
        windows = {
            "period": self.span(self.period.start, self.period.end),
            "prev": self.span(self.period.prev_start, self.period.prev_end),
            "week": self.span(today - timedelta(days=7), today - timedelta(days=1)),
            "prevWeek": self.span(today - timedelta(days=14), today - timedelta(days=8)),
            "velocity": self.span(today - timedelta(days=A.VELOCITY_DAYS), today - timedelta(days=1)),
        }
        lookback = self.clock.day_start(min(self.period.prev_start, today - timedelta(days=LOOKBACK_DAYS)))
        return D.load_product_sums(self.db, self.scope, self.clock, windows, lookback, self.clock.day_start(today + timedelta(days=1)))

    @cached_property
    def listed_ids(self):
        return D.load_listed_product_ids(self.db, self.scope, self.shops)

    @cached_property
    def stock_rows(self) -> List[D.StockRow]:
        return D.load_stock(self.db, self.shops)

    @cached_property
    def all_product_ids(self) -> List[uuid_mod.UUID]:
        ids = {a.product_id for a in self.product_sums.values() if a.product_id is not None}
        ids |= set(self.listed_ids)
        ids |= {r.product_id for r in self.stock_rows}
        return list(ids)

    @cached_property
    def meta(self) -> Dict[str, D.ProductMeta]:
        return D.load_product_meta(self.db, self.scope.tenant_id, self.all_product_ids)

    @cached_property
    def costs(self) -> Dict[str, int]:
        return D.load_costs(self.db, self.scope.tenant_id, self.all_product_ids)

    @cached_property
    def on_hand(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for r in self.stock_rows:
            out[str(r.product_id)] = out.get(str(r.product_id), 0.0) + r.quantity
        return out

    @cached_property
    def products(self) -> List[dict]:
        """One row per product: the period, the period before, this week and last week."""
        listed = {str(i) for i in self.listed_ids}
        keys = set(self.product_sums) | listed | set(self.on_hand)
        rows = []
        for key in keys:
            agg = self.product_sums.get(key)
            meta = self.meta.get(key)
            if agg is None and meta is None:
                continue

            def w(name):
                return agg.windows.get(name, D.ProductWindowSums()) if agg else D.ProductWindowSums()

            period, prev, week, prev_week, velocity = w("period"), w("prev"), w("week"), w("prevWeek"), w("velocity")
            rows.append({
                "key": key,
                "productId": key if meta is not None else None,
                "name": (meta.name if meta else None) or (agg.snapshot_name if agg else None) or "",
                "categoryId": str(meta.category_id) if meta and meta.category_id else None,
                "categoryName": meta.category_name if meta else None,
                "isGeneral": bool(meta and meta.is_general),
                "trackStock": bool(meta and meta.track_stock),
                "listed": key in listed,
                "price": meta.price if meta else None,
                "vatRate": meta.vat_rate if meta else A.DEFAULT_VAT_RATE,
                "cost": self.costs.get(key),
                "onHand": self.on_hand.get(key),
                "firstSeen": self.clock.business_date(meta.created_at) if meta and meta.created_at else None,
                "lastSold": self.clock.business_date(agg.last_sold) if agg and agg.last_sold else None,
                "units": period.units,
                "unitsSold": period.units_sold,
                "net": period.net,
                "lines": period.lines,
                "unitsPrev": prev.units,
                "netPrev": prev.net,
                "unitsWeek": week.units,
                "netWeek": week.net,
                "unitsPrevWeek": prev_week.units,
                "netPrevWeek": prev_week.net,
                "unitsVelocity": velocity.units,
            })
        rows.sort(key=lambda r: (-r["net"], r["name"]))
        return rows

    @cached_property
    def menu_products(self) -> List[dict]:
        """The products a menu analysis is about: not the general item, not a nameless line."""
        return [r for r in self.products if not r["isGeneral"] and r["productId"] is not None]

    # Other data ------------------------------------------------------------

    @cached_property
    def tables(self) -> D.TablesData:
        return D.load_open_tables(self.db, self.scope, self.shops)

    @cached_property
    def cashier_aggs(self):
        return D.load_cashiers(self.db, self.scope, self.clock, *self.span(self.period.start, self.period.end))


# ── Sections ─────────────────────────────────────────────────────────────────


def meta_block(ctx: InsightsContext) -> dict:
    return {
        "generatedAt": ctx.clock.now.isoformat(),
        "timezone": ctx.clock.tz_name,
        "dayStartHour": ctx.clock.day_start_hour,
        "today": ctx.today.isoformat(),
        "period": ctx.period.to_json(),
        "historyStart": ctx.history_start.isoformat() if ctx.history_start else None,
    }


def kpis(ctx: InsightsContext) -> dict:
    """The period's headline figures against the period before."""
    cur = ctx.totals(ctx.period.start, ctx.period.end)
    prev = ctx.totals(ctx.period.prev_start, ctx.period.prev_end)
    units = sum(r["unitsSold"] for r in ctx.products)
    units_prev_sold = 0.0
    for agg in ctx.product_sums.values():
        units_prev_sold += agg.windows.get("prev", D.ProductWindowSums()).units_sold

    def block(c: A.Cell, units_sold: float) -> dict:
        net_sales = c.gross - c.discounts
        return {
            "net": c.net,
            "gross": c.gross,
            "discounts": c.discounts,
            "refunds": c.refunds,
            "refundsCount": c.refunds_count,
            "sales": c.sales,
            "documents": c.docs,
            "tips": c.tips,
            "avgCheck": round(net_sales / c.sales) if c.sales else None,
            "itemsPerSale": round(units_sold / c.sales, 2) if c.sales else None,
            "discountPct": A.r1(A.pct(c.discounts, c.gross)),
            "refundPct": A.r1(A.pct(c.refunds, net_sales)) if net_sales > 0 else None,
            "tipPct": A.r1(A.pct(c.tips, c.net)) if c.net > 0 else None,
            "perDay": round(c.net / ctx.period.days),
        }

    current, previous = block(cur, units), block(prev, units_prev_sold)
    has_prev = ctx.history_start is not None and ctx.history_start <= ctx.period.prev_end
    return {"current": current, "previous": previous if has_prev else None}


def availability(ctx: InsightsContext) -> dict:
    products = ctx.menu_products
    sold = [r for r in products if r["units"] > 0]
    with_cost = [r for r in sold if r["cost"] is not None]
    return {
        "hasSales": bool(ctx.history_start),
        "historyDays": (ctx.today - ctx.history_start).days if ctx.history_start else 0,
        "hasCost": bool(with_cost),
        "costCoveragePct": A.r1(A.pct(len(with_cost), len(sold))) if sold else None,
        "hasStock": bool(ctx.stock_rows),
        "hasTables": ctx.tables.tables_total > 0,
        "shops": len(ctx.shops),
    }


def menu_engineering(ctx: InsightsContext, category_id: Optional[str] = None, by_category: bool = True) -> dict:
    rows = [r for r in ctx.menu_products if category_id is None or r["categoryId"] == category_id]
    items = [
        A.MenuItemIn(
            key=r["key"], name=r["name"], units=r["units"], net=r["net"], cost=r["cost"],
            vat_rate=r["vatRate"], category_id=r["categoryId"], category_name=r["categoryName"],
            product_id=r["productId"],
        )
        for r in rows
    ]
    out = A.menu_matrix(items, by_category=by_category)
    categories: Dict[str, dict] = {}
    for r in ctx.menu_products:
        if r["units"] > 0 and r["categoryId"]:
            c = categories.setdefault(r["categoryId"], {"id": r["categoryId"], "name": r["categoryName"], "items": 0, "net": 0})
            c["items"] += 1
            c["net"] += r["net"]
    out["categories"] = sorted(categories.values(), key=lambda c: -c["net"])
    out["categoryId"] = category_id
    return out


def abc(ctx: InsightsContext) -> dict:
    rows = [r for r in ctx.menu_products if r["units"] != 0 or r["net"] != 0]
    result = A.abc_classes([(r["key"], r["net"]) for r in rows])
    items = []
    for r in rows:
        cls = result["items"][r["key"]]
        items.append({
            "key": r["key"], "productId": r["productId"], "name": r["name"],
            "categoryName": r["categoryName"], "units": round(r["units"], 3), "net": r["net"],
            "class": cls["class"], "share": cls["share"], "cumShare": cls["cumShare"],
        })
    items.sort(key=lambda i: (-i["net"], i["name"]))
    return {"total": result["total"], "classes": result["classes"], "items": items, "cuts": {"A": A.A_CUT * 100, "B": A.B_CUT * 100}}


def slow(ctx: InsightsContext, dead_days: int = A.DEAD_DAYS) -> dict:
    items = [
        A.ProductIn(
            key=r["key"], name=r["name"], units=r["units"], units_prev=r["unitsPrev"], net=r["net"],
            last_sold=r["lastSold"], first_seen=r["firstSeen"], listed=r["listed"], is_general=r["isGeneral"],
            track_stock=r["trackStock"], on_hand=r["onHand"], price=r["price"], cost=r["cost"],
            category_name=r["categoryName"], product_id=r["productId"],
        )
        for r in ctx.menu_products
    ]
    out = A.slow_movers(items, today=ctx.today, period_days=ctx.period.days, lookback_days=LOOKBACK_DAYS, dead_days=dead_days)
    out["thresholds"] = {"deadDays": dead_days, "newItemDays": A.NEW_ITEM_DAYS, "slowSharePct": A.SLOW_SHARE * 100, "declinePct": A.DECLINE_RATIO * 100}
    return out


def stock(ctx: InsightsContext) -> dict:
    if not ctx.stock_rows:
        return {"hasStock": False, "rows": []}
    today = ctx.today
    start, end = ctx.span(today - timedelta(days=A.VELOCITY_DAYS), today - timedelta(days=1))
    ids = list({r.product_id for r in ctx.stock_rows})
    units = D.load_units_by_shop(ctx.db, ctx.scope, ctx.clock, start, end, ids)
    shop_names = {str(s.id): s.name for s in ctx.shops}
    rows = []
    for r in ctx.stock_rows:
        key = str(r.product_id)
        meta = ctx.meta.get(key)
        rows.append(A.StockIn(
            key=key, product_id=key, name=meta.name if meta else key, shop_id=str(r.shop_id),
            shop_name=shop_names.get(str(r.shop_id)), on_hand=r.quantity,
            units=units.get((str(r.shop_id), key), 0.0), reorder_min=r.reorder_min,
            reorder_max=r.reorder_max, cost=ctx.costs.get(key),
        ))
    out = A.stock_risk(rows)
    counts: Dict[str, int] = {}
    for r in out:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {
        "hasStock": True,
        "rows": out,
        "counts": counts,
        "params": {"velocityDays": A.VELOCITY_DAYS, "leadDays": A.LEAD_DAYS, "targetDays": A.TARGET_COVER_DAYS},
    }


def heatmap(ctx: InsightsContext) -> dict:
    return A.heatmap(ctx.cells, ctx.period.start, ctx.period.end, day_start_hour=ctx.clock.day_start_hour)


def trends(ctx: InsightsContext) -> dict:
    items = [
        A.TrendItemIn(
            key=r["key"], name=r["name"], units=r["unitsWeek"], units_prev=r["unitsPrevWeek"],
            net=r["netWeek"], net_prev=r["netPrevWeek"], product_id=r["productId"],
            category_name=r["categoryName"],
        )
        for r in ctx.menu_products
    ]
    return {
        "daily": A.trend_series(ctx.daily, ctx.period.start, ctx.period.end, history_start=ctx.history_start),
        "weekOverWeek": A.week_over_week(ctx.daily, ctx.today, history_start=ctx.history_start),
        "products": A.product_trends(items),
        "yesterday": A.day_anomaly(ctx.daily, ctx.today - timedelta(days=1), history_start=ctx.history_start),
    }


def forecast(ctx: InsightsContext) -> dict:
    out = A.forecast(ctx.daily, ctx.cells, today=ctx.today, history_start=ctx.history_start, day_start_hour=ctx.clock.day_start_hour)
    slot, fraction = ctx.clock.now_slot()
    out["pace"] = A.today_pace(
        ctx.cells, ctx.daily, today=ctx.today, now_slot=slot, now_fraction=fraction,
        history_start=ctx.history_start, day_start_hour=ctx.clock.day_start_hour,
    )
    return out


def baskets(ctx: InsightsContext) -> dict:
    cur = ctx.totals(ctx.period.start, ctx.period.end)
    start, end = ctx.span(ctx.period.start, ctx.period.end)
    min_count = A.pair_min_count(cur.sales)
    pairs, per_item, sizes, n_baskets = D.load_baskets(ctx.db, ctx.scope, ctx.clock, start, end, min_count=min_count)
    names = {r["key"]: r["name"] for r in ctx.products}
    units_sold = sum(r["unitsSold"] for r in ctx.products)
    lines = sum(r["lines"] for r in ctx.products)
    return {
        "sales": cur.sales,
        "avgCheck": round((cur.gross - cur.discounts) / cur.sales) if cur.sales else None,
        "itemsPerSale": round(units_sold / cur.sales, 2) if cur.sales else None,
        "linesPerSale": round(lines / cur.sales, 2) if cur.sales else None,
        "sizes": A.basket_sizes(sizes),
        "pairs": A.pair_metrics(pairs, per_item, n_baskets, names=names, min_count=min_count),
        "minCount": min_count,
    }


def cashiers(ctx: InsightsContext) -> dict:
    rows = [
        A.CashierIn(
            cashier_id=a.cashier_id, name=a.name, sales=a.sales, gross=a.gross,
            discounts=max(0, a.document_discounts - a.promotions), promotions=a.promotions,
            refunds_count=a.refunds_count, refunds=a.refunds, voids_count=a.voids_count,
            voids=a.voids, cancels_count=a.cancels_count, cancels=a.cancels,
        )
        for a in ctx.cashier_aggs.values()
    ]
    return A.cashier_rates(rows)


def tables_live(ctx: InsightsContext) -> dict:
    t = ctx.tables
    usual = None
    if t.tables_total:
        start, end = ctx.span(ctx.today - timedelta(days=28), ctx.today - timedelta(days=1))
        recent = A.tables_period(
            D.load_paid_tables(ctx.db, ctx.scope, ctx.shops, start, end),
            tables_total=t.tables_total, seats_total=t.seats_total, days=28,
        )
        usual = recent["avgSeatedMinutes"]
    out = A.tables_live(t.open_orders, tables_total=t.tables_total, seats_total=t.seats_total, now=ctx.clock.now, usual_minutes=usual)
    out["usualSeatedMinutes"] = usual
    out["generatedAt"] = ctx.clock.now.isoformat()
    out["hasTables"] = t.tables_total > 0
    return out


def _open_hours(ctx: InsightsContext, start: date, end: date) -> Optional[float]:
    """Hours open over `start`..`end`: each open day counts its weekday's opening span."""
    spans = A.heatmap(ctx.cells, start, end, day_start_hour=ctx.clock.day_start_hour)["spans"]
    per_weekday = A.open_hours_by_weekday(spans)
    total = sum(
        per_weekday[A.weekday_of(d)]
        for d in A.days_between(start, end)
        if d in ctx.daily and ctx.daily[d].docs
    )
    return float(total) or None


def tables(ctx: InsightsContext) -> dict:
    t = ctx.tables
    if not t.tables_total:
        return {"hasTables": False}
    cur = A.tables_period(
        D.load_paid_tables(ctx.db, ctx.scope, ctx.shops, *ctx.span(ctx.period.start, ctx.period.end)),
        tables_total=t.tables_total, seats_total=t.seats_total, days=ctx.period.days,
        open_hours=_open_hours(ctx, ctx.period.start, ctx.period.end),
    )
    prev = A.tables_period(
        D.load_paid_tables(ctx.db, ctx.scope, ctx.shops, *ctx.span(ctx.period.prev_start, ctx.period.prev_end)),
        tables_total=t.tables_total, seats_total=t.seats_total, days=ctx.period.days,
        open_hours=_open_hours(ctx, ctx.period.prev_start, ctx.period.prev_end),
    )
    return {"hasTables": True, "tablesTotal": t.tables_total, "seatsTotal": t.seats_total, "current": cur, "previous": prev if prev["orders"] else None}


def customers(ctx: InsightsContext) -> dict:
    cur = ctx.totals(ctx.period.start, ctx.period.end)
    rows = D.load_customers(ctx.db, ctx.scope, ctx.clock, *ctx.span(ctx.period.start, ctx.period.end))
    return {"summary": A.customers_summary(rows, sales=cur.sales, net=cur.net)}


# ── Product costs ────────────────────────────────────────────────────────────

CATALOG_WRITE_ROLES = roles_for(Resource.CATALOG, Action.WRITE)
MAX_COST = 100_000


def set_product_cost(db: Session, user: User, tenant_id, product_id: uuid_mod.UUID, cost) -> dict:
    """
    Sets (or, with `cost` None, clears) what a unit of a product costs, excl. VAT. On the
    global product: a till's local copy resolves to it. Who may edit the product may set it.
    """
    if user.role not in CATALOG_WRITE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    product = db.get(Product, product_id)
    if product is None or product.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    if product.global_product_id is not None:
        product = db.get(Product, product.global_product_id) or product
    allowed = (
        user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)
        or (user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, product.company_id))
        or (user.role in SHOP_SCOPED_ROLES and product.shop_id is not None and product.shop_id == user.shop_id)
    )
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    row = db.query(ProductCost).filter(ProductCost.tenant_id == tenant_id, ProductCost.product_id == product.id).first()
    if cost is None:
        if row is not None:
            db.delete(row)
        db.commit()
        return {"productId": str(product.id), "cost": None}
    from decimal import Decimal, InvalidOperation

    try:
        value = Decimal(str(cost)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise _bad("cost must be a number")
    if value < 0 or value > MAX_COST:
        raise _bad(f"cost must be between 0 and {MAX_COST}")
    if row is None:
        row = ProductCost(tenant_id=tenant_id, product_id=product.id, cost=value, updated_by_user_id=user.id)
        db.add(row)
    else:
        row.cost = value
        row.updated_by_user_id = user.id
    db.commit()
    return {"productId": str(product.id), "cost": A.to_agorot(value)}
