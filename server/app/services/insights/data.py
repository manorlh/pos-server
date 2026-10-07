"""
Insights — reading the data: scoped exactly like the control board, and in a fixed number
of grouped queries whatever the size of the scope (never one per product, till or table).

Which documents count, and how their money is read, is the reports' definition and is
imported from there (`build_scoped_transaction_query`, `_is_refund_condition`): the role's
scope, `SALE_STATUSES`, a credit note subtracting, a sale's net = total − its discount.
`companyId` / `shopId` / `areaId` / `machineId` only ever narrow it.

Local business day and hour are computed by Postgres (`timezone(tz, created_at)`, its own
tzdata) and grouped there. SQLite — the test world — has no `timezone()`: there rows are
grouped by the instant and converted in Python with zoneinfo; the same answer, slower.

Everything money leaves here as integer agorot.
"""
from __future__ import annotations

import uuid as uuid_mod
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import Date, Integer, and_, case, cast, func, or_
from sqlalchemy.orm import Query, Session, aliased

from app.models.audit_exception import TillEvent
from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.product_cost import ProductCost
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.stock_level import StockLevel
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.services.areas import AREA_NONE
from app.services.company_hierarchy import descendant_company_ids
from app.services.overview import _visible_shops_query
from app.services.reports import (
    ReportWindow,
    _display_name,
    _is_refund_condition,
    _load_cashier_names,
    build_scoped_transaction_query,
)
from app.services.scoping import scope_query_by_user

from .analytics import BusinessClock, Cell, OpenTableIn, PaidTableIn, to_agorot


def _pg(db: Session) -> bool:
    return db.get_bind().dialect.name == "postgresql"


def _as_dt(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    parsed = datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _uuid_or_none(value) -> Optional[uuid_mod.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid_mod.UUID):
        return value
    try:
        return uuid_mod.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


# ── Scope ────────────────────────────────────────────────────────────────────


@dataclass
class InsightScope:
    """Who asks, and what they narrowed to (the control board's company › shop › area › till)."""

    user: User
    tenant_id: uuid_mod.UUID
    company_id: Optional[uuid_mod.UUID] = None
    shop_id: Optional[uuid_mod.UUID] = None
    #: None (no filter), `AREA_NONE`, or an area id — as `parse_area_filter` returns.
    area_filter: Any = None
    machine_id: Optional[uuid_mod.UUID] = None
    _machine: Any = field(default=None, repr=False)

    def machine(self, db: Session) -> Optional[POSMachine]:
        if self.machine_id is None:
            return None
        if self._machine is None:
            m = db.get(POSMachine, self.machine_id)
            self._machine = m if m is not None and m.tenant_id == self.tenant_id else False
        return self._machine or None


def scoped_documents(db: Session, scope: InsightScope, clock: BusinessClock, start: datetime, end: datetime) -> Optional[Query]:
    """The reportable documents of the scope created in [start, end); None for no access."""
    window = ReportWindow(
        from_date=clock.business_date(start),
        to_date=clock.business_date(end - timedelta(seconds=1)),
        from_hour=None,
        to_hour=None,
        tz_name=clock.tz_name,
        start=start,
        end=end,
    )
    query = build_scoped_transaction_query(
        db, scope.user, scope.tenant_id, window,
        shop_id=scope.shop_id, machine_id=scope.machine_id, area_filter=scope.area_filter,
    )
    if query is not None and scope.company_id is not None:
        group = descendant_company_ids(db, scope.company_id)
        query = query.filter(Transaction.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group))))
    return query


def scope_shops(db: Session, scope: InsightScope) -> List[Shop]:
    """The shops the scope covers, by `GET /shops`' role rule (as the overview lists them)."""
    query = _visible_shops_query(db, scope.user, scope.tenant_id)
    if query is None:
        return []
    if scope.company_id is not None:
        query = query.filter(Shop.company_id.in_(descendant_company_ids(db, scope.company_id)))
    if scope.shop_id is not None:
        query = query.filter(Shop.id == scope.shop_id)
    machine = scope.machine(db)
    if scope.machine_id is not None:
        if machine is None or machine.shop_id is None:
            return []
        query = query.filter(Shop.id == machine.shop_id)
    return query.order_by(Shop.name).all()


def scope_area(db: Session, scope: InsightScope) -> Any:
    """The area a zone filter applies: the one asked for, or the scoped till's own."""
    if scope.area_filter is not None:
        return scope.area_filter
    machine = scope.machine(db)
    if machine is not None:
        return machine.area_id or AREA_NONE
    return None


# ── Documents by business day and hour ───────────────────────────────────────


def _local_keys(db: Session, clock: BusinessClock, column):
    """The group-by expressions for (business day, hour) and a row decoder."""
    if _pg(db):
        local = func.timezone(clock.tz_name, column)
        day = cast(local - func.make_interval(0, 0, 0, 0, clock.day_start_hour), Date)
        hour = cast(func.extract("hour", local), Integer)
        return [day, hour], (lambda row: (row.k0, int(row.k1)))
    return [column], (lambda row: (clock.business_date(_as_dt(row.k0)), clock.hour(_as_dt(row.k0))))


def load_hour_cells(
    db: Session,
    scope: InsightScope,
    clock: BusinessClock,
    start_day: date,
    end_day: date,
) -> Dict[Tuple[date, int], Cell]:
    """Per business day and local hour: net, documents, sales, gross, discounts, refunds, tips."""
    query = scoped_documents(db, scope, clock, clock.day_start(start_day), clock.day_start(end_day + timedelta(days=1)))
    cells: Dict[Tuple[date, int], Cell] = {}
    if query is None:
        return cells
    refund = _is_refund_condition()
    discount = func.coalesce(Transaction.document_discount, 0)
    keys, decode = _local_keys(db, clock, Transaction.created_at)
    rows = (
        query.with_entities(
            *[k.label(f"k{i}") for i, k in enumerate(keys)],
            func.coalesce(func.sum(case((refund, -Transaction.total_amount), else_=Transaction.total_amount - discount)), 0).label("net"),
            func.count(Transaction.id).label("docs"),
            func.coalesce(func.sum(case((refund, 0), else_=1)), 0).label("sales"),
            func.coalesce(func.sum(case((refund, 0), else_=Transaction.total_amount)), 0).label("gross"),
            func.coalesce(func.sum(case((refund, 0), else_=discount)), 0).label("discounts"),
            func.coalesce(func.sum(case((refund, Transaction.total_amount), else_=0)), 0).label("refunds"),
            func.coalesce(func.sum(case((refund, 1), else_=0)), 0).label("refunds_count"),
            func.coalesce(func.sum(Transaction.tip_amount), 0).label("tips"),
        )
        .group_by(*keys)
        .all()
    )
    for row in rows:
        key = decode(row)
        cell = cells.setdefault(key, Cell())
        cell.add(Cell(
            net=to_agorot(row.net), docs=int(row.docs or 0), sales=int(row.sales or 0),
            gross=to_agorot(row.gross), discounts=to_agorot(row.discounts), refunds=to_agorot(row.refunds),
            refunds_count=int(row.refunds_count or 0), tips=to_agorot(row.tips),
        ))
    return cells


# ── Products ─────────────────────────────────────────────────────────────────


@dataclass
class ProductWindowSums:
    units_sold: float = 0.0
    units_refunded: float = 0.0
    gross: int = 0
    discounts: int = 0
    refunds: int = 0
    lines: int = 0

    @property
    def units(self) -> float:
        return self.units_sold - self.units_refunded

    @property
    def net(self) -> int:
        return self.gross - self.discounts - self.refunds


@dataclass
class ProductAgg:
    key: str
    product_id: Optional[uuid_mod.UUID]
    snapshot_name: Optional[str]
    windows: Dict[str, ProductWindowSums]
    last_sold: Optional[datetime]


def _product_key_expr():
    """A sold line's product, as its global product when the line names a till's local copy."""
    return func.coalesce(Product.global_product_id, TransactionItem.product_id)


def product_key(product_id: Optional[uuid_mod.UUID], name: Optional[str]) -> str:
    return str(product_id) if product_id is not None else f"name:{(name or '').strip()}"


def load_product_sums(
    db: Session,
    scope: InsightScope,
    clock: BusinessClock,
    windows: Dict[str, Tuple[datetime, datetime]],
    lookback_start: datetime,
    end: datetime,
) -> Dict[str, ProductAgg]:
    """
    Per product (its global product; a line with none by its name): units sold / refunded,
    gross, discounts (the line's own and its promotions' share), refunds and lines inside
    each named window, and the last time it sold — one grouped query over the look-back.
    """
    query = scoped_documents(db, scope, clock, lookback_start, end)
    if query is None:
        return {}
    tx = query.with_entities(
        Transaction.id.label("tx_id"),
        Transaction.created_at.label("created_at"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    is_refund = tx.c.is_refund
    qty = TransactionItem.quantity
    total = TransactionItem.total_price
    line_discount = func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0) + func.coalesce(TransactionItem.voucher_discount, 0)
    key = _product_key_expr()
    name_key = case((key.is_(None), TransactionItem.product_name), else_=None)

    columns = []
    for name, (w_start, w_end) in windows.items():
        inside = and_(tx.c.created_at >= w_start, tx.c.created_at < w_end)
        sale, ref = and_(inside, is_refund.is_(False)), and_(inside, is_refund.is_(True))
        columns += [
            func.coalesce(func.sum(case((sale, qty), else_=0)), 0).label(f"{name}__units_sold"),
            func.coalesce(func.sum(case((ref, qty), else_=0)), 0).label(f"{name}__units_refunded"),
            func.coalesce(func.sum(case((sale, total), else_=0)), 0).label(f"{name}__gross"),
            func.coalesce(func.sum(case((sale, line_discount), else_=0)), 0).label(f"{name}__discounts"),
            func.coalesce(func.sum(case((ref, total), else_=0)), 0).label(f"{name}__refunds"),
            func.coalesce(func.sum(case((sale, 1), else_=0)), 0).label(f"{name}__lines"),
        ]
    rows = (
        db.query(
            key.label("key"),
            name_key.label("name_key"),
            func.max(TransactionItem.product_name).label("snapshot"),
            func.max(case((is_refund.is_(False), tx.c.created_at), else_=None)).label("last_sold"),
            *columns,
        )
        .select_from(TransactionItem)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .group_by(key, name_key)
        .all()
    )
    out: Dict[str, ProductAgg] = {}
    for row in rows:
        pid = _uuid_or_none(row.key)
        k = product_key(pid, row.name_key or row.snapshot)
        agg = out.get(k)
        if agg is None:
            agg = out[k] = ProductAgg(key=k, product_id=pid, snapshot_name=row.snapshot, windows={}, last_sold=None)
        for name in windows:
            sums = agg.windows.setdefault(name, ProductWindowSums())
            sums.units_sold += float(getattr(row, f"{name}__units_sold") or 0)
            sums.units_refunded += float(getattr(row, f"{name}__units_refunded") or 0)
            sums.gross += to_agorot(getattr(row, f"{name}__gross"))
            sums.discounts += to_agorot(getattr(row, f"{name}__discounts"))
            sums.refunds += to_agorot(getattr(row, f"{name}__refunds"))
            sums.lines += int(getattr(row, f"{name}__lines") or 0)
        last = _as_dt(row.last_sold)
        if last is not None and (agg.last_sold is None or last > agg.last_sold):
            agg.last_sold = last
    return out


@dataclass
class ProductMeta:
    id: uuid_mod.UUID
    name: str
    category_id: Optional[uuid_mod.UUID]
    category_name: Optional[str]
    price: int
    vat_rate: float
    is_general: bool
    is_open_price: bool
    track_stock: bool
    is_available: bool
    created_at: Optional[datetime]


def load_product_meta(db: Session, tenant_id, ids: Iterable[uuid_mod.UUID]) -> Dict[str, ProductMeta]:
    ids = [i for i in set(ids) if i is not None]
    out: Dict[str, ProductMeta] = {}
    for chunk_start in range(0, len(ids), 900):
        chunk = ids[chunk_start:chunk_start + 900]
        rows = (
            db.query(
                Product.id, Product.name, Product.category_id, Category.name.label("category_name"),
                Product.price, Product.tax_rate, Product.is_general, Product.is_open_price,
                Product.track_stock, Product.is_available, Product.created_at,
            )
            .outerjoin(Category, Category.id == Product.category_id)
            .filter(Product.id.in_(chunk), Product.tenant_id == tenant_id)
            .all()
        )
        for r in rows:
            rate = float(r.tax_rate) / 100.0 if r.tax_rate is not None else 0.18
            out[str(r.id)] = ProductMeta(
                id=r.id, name=r.name, category_id=r.category_id, category_name=r.category_name,
                price=to_agorot(r.price), vat_rate=rate, is_general=bool(r.is_general),
                is_open_price=bool(r.is_open_price), track_stock=bool(r.track_stock),
                is_available=bool(r.is_available), created_at=_as_dt(r.created_at),
            )
    return out


def load_listed_product_ids(db: Session, scope: InsightScope, shops: Sequence[Shop]) -> Set[uuid_mod.UUID]:
    """
    The global products on sale in the scope's shops now: listed on the shop's assortment,
    not locked there, available, not the general item. A tenant that never used the
    assortment (no rows at all for these shops) falls back to its available products.
    """
    if not shops:
        return set()
    shop_ids = [s.id for s in shops]
    any_rows = db.query(ShopProductOverride.id).filter(ShopProductOverride.shop_id.in_(shop_ids)).first()
    if any_rows is not None:
        rows = (
            db.query(ShopProductOverride.global_product_id)
            .join(Product, Product.id == ShopProductOverride.global_product_id)
            .filter(
                ShopProductOverride.shop_id.in_(shop_ids),
                ShopProductOverride.is_listed.is_(True),
                or_(ShopProductOverride.is_available.is_(None), ShopProductOverride.is_available.is_(True)),
                Product.is_available.is_(True),
                Product.is_general.is_(False),
            )
            .distinct()
            .all()
        )
        return {r[0] for r in rows}
    query = db.query(Product.id).filter(
        Product.tenant_id == scope.tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
        Product.is_available.is_(True),
        Product.is_general.is_(False),
    )
    company_ids = {s.company_id for s in shops if s.company_id is not None}
    if company_ids:
        query = query.filter(or_(Product.company_id.is_(None), Product.company_id.in_(company_ids)))
    return {r[0] for r in query.all()}


def load_costs(db: Session, tenant_id, ids: Iterable[uuid_mod.UUID]) -> Dict[str, int]:
    ids = [i for i in set(ids) if i is not None]
    if not ids:
        return {}
    out: Dict[str, int] = {}
    for chunk_start in range(0, len(ids), 900):
        chunk = ids[chunk_start:chunk_start + 900]
        for r in db.query(ProductCost.product_id, ProductCost.cost).filter(
            ProductCost.tenant_id == tenant_id, ProductCost.product_id.in_(chunk)
        ):
            out[str(r.product_id)] = to_agorot(r.cost)
    return out


# ── Stock ────────────────────────────────────────────────────────────────────


@dataclass
class StockRow:
    shop_id: uuid_mod.UUID
    product_id: uuid_mod.UUID
    quantity: float
    reorder_min: Optional[float]
    reorder_max: Optional[float]


def load_stock(db: Session, shops: Sequence[Shop]) -> List[StockRow]:
    if not shops:
        return []
    rows = (
        db.query(StockLevel.shop_id, StockLevel.product_id, StockLevel.quantity, StockLevel.reorder_min, StockLevel.reorder_max)
        .join(Product, Product.id == StockLevel.product_id)
        .filter(StockLevel.shop_id.in_([s.id for s in shops]), Product.track_stock.is_(True))
        .all()
    )
    return [
        StockRow(
            shop_id=r.shop_id, product_id=r.product_id, quantity=float(r.quantity or 0),
            reorder_min=float(r.reorder_min) if r.reorder_min is not None else None,
            reorder_max=float(r.reorder_max) if r.reorder_max is not None else None,
        )
        for r in rows
    ]


def load_units_by_shop(
    db: Session,
    scope: InsightScope,
    clock: BusinessClock,
    start: datetime,
    end: datetime,
    product_ids: Sequence[uuid_mod.UUID],
) -> Dict[Tuple[str, str], float]:
    """Net units per (shop, product) in [start, end), for the stocked products only."""
    if not product_ids:
        return {}
    query = scoped_documents(db, scope, clock, start, end)
    if query is None:
        return {}
    tx = query.with_entities(
        Transaction.id.label("tx_id"),
        Transaction.shop_id.label("shop_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    key = _product_key_expr()
    rows = (
        db.query(
            tx.c.shop_id,
            key.label("key"),
            func.coalesce(func.sum(case((tx.c.is_refund.is_(True), -TransactionItem.quantity), else_=TransactionItem.quantity)), 0).label("units"),
        )
        .select_from(TransactionItem)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .filter(key.in_(list(product_ids)))
        .group_by(tx.c.shop_id, key)
        .all()
    )
    return {(str(r.shop_id), str(r.key)): float(r.units or 0) for r in rows}


# ── Baskets ──────────────────────────────────────────────────────────────────


def _basket_items(db: Session, scope: InsightScope, clock: BusinessClock, start: datetime, end: datetime):
    """(document, product) once per sale document — the market-basket view."""
    query = scoped_documents(db, scope, clock, start, end)
    if query is None:
        return None
    sales = query.filter(~_is_refund_condition()).with_entities(Transaction.id.label("tx_id")).subquery()
    key = _product_key_expr()
    return (
        db.query(TransactionItem.transaction_id.label("tx"), key.label("k"))
        .join(sales, sales.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .filter(key.isnot(None), or_(Product.is_general.is_(None), Product.is_general.is_(False)))
        .distinct()
        .subquery()
    )


def load_baskets(
    db: Session,
    scope: InsightScope,
    clock: BusinessClock,
    start: datetime,
    end: datetime,
    *,
    min_count: int,
    limit: int = 60,
) -> Tuple[List[Tuple[str, str, int]], Dict[str, int], List[Tuple[int, int]], int]:
    """
    The pairs bought together in at least `min_count` baskets, how many baskets each
    product is in, the basket-size histogram (distinct products) and the basket count.
    """
    items = _basket_items(db, scope, clock, start, end)
    if items is None:
        return [], {}, [], 0
    a, b = aliased(items), aliased(items)
    together = func.count().label("n")
    pairs = (
        db.query(a.c.k.label("a"), b.c.k.label("b"), together)
        .join(b, and_(a.c.tx == b.c.tx, a.c.k < b.c.k))
        .group_by(a.c.k, b.c.k)
        .having(func.count() >= min_count)
        .order_by(together.desc())
        .limit(limit)
        .all()
    )
    per_item = db.query(items.c.k, func.count()).group_by(items.c.k).all()
    sizes_sub = db.query(items.c.tx, func.count().label("n")).group_by(items.c.tx).subquery()
    sizes = db.query(sizes_sub.c.n, func.count()).group_by(sizes_sub.c.n).all()
    baskets = sum(int(c) for _, c in sizes)
    return (
        [(str(r.a), str(r.b), int(r.n)) for r in pairs],
        {str(k): int(c) for k, c in per_item},
        [(int(n), int(c)) for n, c in sizes],
        baskets,
    )


# ── Cashiers ─────────────────────────────────────────────────────────────────


@dataclass
class CashierAgg:
    cashier_id: Optional[str]
    name: Optional[str] = None
    sales: int = 0
    gross: int = 0
    document_discounts: int = 0
    promotions: int = 0
    refunds_count: int = 0
    refunds: int = 0
    voids_count: int = 0
    voids: int = 0
    cancels_count: int = 0
    cancels: int = 0


def load_cashiers(
    db: Session,
    scope: InsightScope,
    clock: BusinessClock,
    start: datetime,
    end: datetime,
) -> Dict[Optional[str], CashierAgg]:
    """
    Per employee: sales, gross, the document discounts and what promotions took of them
    (automatic, so not the employee's), credit notes, and — from the till events — the
    lines voided and the baskets cancelled.
    """
    out: Dict[Optional[str], CashierAgg] = {}
    query = scoped_documents(db, scope, clock, start, end)
    if query is None:
        return out
    refund = _is_refund_condition()
    for r in (
        query.with_entities(
            Transaction.cashier_id,
            func.coalesce(func.sum(case((refund, 0), else_=1)), 0).label("sales"),
            func.coalesce(func.sum(case((refund, 0), else_=Transaction.total_amount)), 0).label("gross"),
            func.coalesce(func.sum(case((refund, 0), else_=func.coalesce(Transaction.document_discount, 0))), 0).label("discounts"),
            func.coalesce(func.sum(case((refund, 1), else_=0)), 0).label("refunds_count"),
            func.coalesce(func.sum(case((refund, Transaction.total_amount), else_=0)), 0).label("refunds"),
        )
        .group_by(Transaction.cashier_id)
        .all()
    ):
        agg = out.setdefault(r.cashier_id or None, CashierAgg(cashier_id=r.cashier_id or None))
        agg.sales += int(r.sales or 0)
        agg.gross += to_agorot(r.gross)
        agg.document_discounts += to_agorot(r.discounts)
        agg.refunds_count += int(r.refunds_count or 0)
        agg.refunds += to_agorot(r.refunds)

    sales = query.filter(~refund).with_entities(
        Transaction.id.label("tx_id"), Transaction.cashier_id.label("cashier_id")
    ).subquery()
    for r in (
        db.query(sales.c.cashier_id, func.coalesce(func.sum(TransactionItem.promotion_discount), 0).label("promo"))
        .join(TransactionItem, TransactionItem.transaction_id == sales.c.tx_id)
        .group_by(sales.c.cashier_id)
        .all()
    ):
        agg = out.setdefault(r.cashier_id or None, CashierAgg(cashier_id=r.cashier_id or None))
        agg.promotions += to_agorot(r.promo)

    events = db.query(
        TillEvent.pos_user_id,
        TillEvent.event_type,
        func.count(TillEvent.id).label("n"),
        func.coalesce(func.sum(TillEvent.amount), 0).label("amount"),
    ).filter(
        TillEvent.tenant_id == scope.tenant_id,
        TillEvent.occurred_at >= start,
        TillEvent.occurred_at < end,
        TillEvent.event_type.in_(("line_void", "basket_cancel")),
    )
    events = scope_query_by_user(events, scope.user, db, shop_column=TillEvent.shop_id, machine_column=TillEvent.machine_id)
    if events is not None:
        if scope.shop_id is not None:
            events = events.filter(TillEvent.shop_id == scope.shop_id)
        if scope.machine_id is not None:
            events = events.filter(TillEvent.machine_id == scope.machine_id)
        if scope.area_filter == AREA_NONE:
            events = events.filter(TillEvent.area_id.is_(None))
        elif scope.area_filter is not None:
            events = events.filter(TillEvent.area_id == scope.area_filter)
        if scope.company_id is not None:
            group = descendant_company_ids(db, scope.company_id)
            events = events.filter(TillEvent.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group))))
        for r in events.group_by(TillEvent.pos_user_id, TillEvent.event_type).all():
            agg = out.setdefault(r.pos_user_id or None, CashierAgg(cashier_id=r.pos_user_id or None))
            if r.event_type == "line_void":
                agg.voids_count += int(r.n or 0)
                agg.voids += to_agorot(r.amount)
            else:
                agg.cancels_count += int(r.n or 0)
                agg.cancels += to_agorot(r.amount)

    names = _load_cashier_names(db, [k for k in out if k])
    for k, agg in out.items():
        agg.name = _display_name(names.get(k)) if k else None
    return out


# ── Tables ───────────────────────────────────────────────────────────────────


def _scoped_zones(db: Session, scope: InsightScope, shops: Sequence[Shop]) -> List[TableZone]:
    if not shops:
        return []
    query = db.query(TableZone).filter(
        TableZone.shop_id.in_([s.id for s in shops]),
        TableZone.archived_at.is_(None),
    )
    area = scope_area(db, scope)
    if area == AREA_NONE:
        query = query.filter(TableZone.area_id.is_(None))
    elif area is not None:
        # A point of sale sees its own zones and the shop-wide ones, as its tills do.
        query = query.filter(or_(TableZone.area_id.is_(None), TableZone.area_id == area))
    return query.all()


@dataclass
class TablesData:
    zones: List[TableZone]
    tables_total: int
    seats_total: int
    open_orders: List[OpenTableIn]


def load_open_tables(db: Session, scope: InsightScope, shops: Sequence[Shop]) -> TablesData:
    """
    The scope's live tables and the order open on each (a synced order wins over a
    single till's report for the same table, as on `GET /tables/live`).
    """
    zones = _scoped_zones(db, scope, shops)
    if not zones:
        return TablesData(zones=[], tables_total=0, seats_total=0, open_orders=[])
    zone_names = {z.id: z.name for z in zones}
    shop_names = {s.id: s.name for s in shops}
    tables = (
        db.query(DiningTable)
        .filter(DiningTable.zone_id.in_([z.id for z in zones]), DiningTable.archived_at.is_(None))
        .all()
    )
    by_id = {t.id: t for t in tables}
    orders: Dict[Any, TableOrder] = {}
    if tables:
        for order in (
            db.query(TableOrder)
            .filter(TableOrder.table_id.in_(list(by_id)), TableOrder.status == "open")
            .all()
        ):
            existing = orders.get(order.table_id)
            if existing is None or (existing.source == "local" and order.source == "synced"):
                orders[order.table_id] = order
    out = []
    for table_id, order in orders.items():
        table = by_id[table_id]
        if order.bill_printed_at is not None:
            state = "awaiting_payment"
        elif (order.send_count or 0) > 0:
            state = "sent"
        else:
            state = "occupied"
        out.append(OpenTableIn(
            table_id=str(table.id), number=table.number, name=table.name,
            zone_name=zone_names.get(table.zone_id), shop_id=str(table.shop_id),
            shop_name=shop_names.get(table.shop_id), guests=order.guests,
            total=to_agorot(order.total), opened_at=_as_dt(order.opened_at), state=state,
            seats=table.seats, opened_by=order.opened_by_pos_user_name,
        ))
    return TablesData(
        zones=zones,
        tables_total=len(tables),
        seats_total=sum(t.seats or 0 for t in tables),
        open_orders=out,
    )


def load_paid_tables(
    db: Session,
    scope: InsightScope,
    shops: Sequence[Shop],
    start: datetime,
    end: datetime,
) -> List[PaidTableIn]:
    """
    The scope's table orders paid in [start, end). Narrowed to a point of sale by the zone
    the order was written in (its snapshot, archived zones included: history stays put).
    """
    if not shops:
        return []
    shop_ids = [s.id for s in shops]
    area = scope_area(db, scope)
    allowed: Optional[Set[Any]] = None
    if area is not None:
        zones = db.query(TableZone.id, TableZone.area_id).filter(TableZone.shop_id.in_(shop_ids)).all()
        allowed = {z.id for z in zones if z.area_id is None or (area != AREA_NONE and z.area_id == area)}
    rows = (
        db.query(TableOrder.table_id, TableOrder.opened_at, TableOrder.closed_at, TableOrder.guests, TableOrder.paid_total, TableOrder.total, TableOrder.zone_id)
        .filter(
            TableOrder.shop_id.in_(shop_ids),
            TableOrder.status == "paid",
            TableOrder.closed_at >= start,
            TableOrder.closed_at < end,
        )
        .all()
    )
    out = []
    for r in rows:
        if allowed is not None and r.zone_id is not None and r.zone_id not in allowed:
            continue
        amount = r.paid_total if r.paid_total is not None else r.total
        out.append(PaidTableIn(
            table_id=str(r.table_id) if r.table_id else None, opened_at=_as_dt(r.opened_at),
            closed_at=_as_dt(r.closed_at), guests=r.guests, amount=to_agorot(amount),
        ))
    return out


# ── Customers ────────────────────────────────────────────────────────────────


def load_customers(db: Session, scope: InsightScope, clock: BusinessClock, start: datetime, end: datetime) -> List[Tuple[str, int, int]]:
    """(customer, sale documents, net agorot) for the identified customers of the period."""
    query = scoped_documents(db, scope, clock, start, end)
    if query is None:
        return []
    rows = (
        query.filter(~_is_refund_condition(), Transaction.customer_ref_id.isnot(None))
        .with_entities(
            Transaction.customer_ref_id,
            func.count(Transaction.id),
            func.coalesce(func.sum(Transaction.total_amount - func.coalesce(Transaction.document_discount, 0)), 0),
        )
        .group_by(Transaction.customer_ref_id)
        .all()
    )
    return [(str(c), int(n), to_agorot(v)) for c, n, v in rows]
