"""
The control board's "שוברים" card (the owner: "הצג בלוח בקרה כמה שוברים נוצלו בסניף — שם
שובר"): the prepaid vouchers ("שוברי הפקה") redeemed in the scope over a period, by voucher
name, against a compared period.

Read-only over the voucher tables — nothing here writes to them, and nothing in the voucher
services changed for it:

* `prepaid_voucher_redemptions` in the window (by `redeemed_at`, the report timezone's days, on
  the index `(tenant_id, redeemed_at)`); a **reversed** redemption (its payment was abandoned
  at the till, the goods went back on the voucher) counts nowhere, as in the batch report;
* scoped by role exactly like the overview's money — `scope_query_by_user` on the
  redemption's shop and till — and narrowed (never widened) by the company / shop / point of
  sale / till asked for. A point of sale is the tills standing in it now (a redemption has
  no shift to carry a stamped area);
* per voucher, in SQL (`GROUP BY` the batch, never row by row): distinct vouchers used,
  redemptions, a discount's uses and ₪; a goods redemption's units from its `items` JSON
  expanded in the database (`json_array_elements` / SQLite `json_each`), grouped by batch,
  sale and product; those goods priced at the unit price on their own sale document in one
  more query (a sale not yet synced adds no ₪);
* while the period is still running, the compared one is cut like for like
  (`period_compare.like_for_like`).

The name shown is `voucher_display_name`: the voucher's type (fix/voucher-print's types — the
batch keeps the name of the type it was issued as), else the batch's own name.
"""
from __future__ import annotations

import uuid as uuid_mod
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import JSON, Numeric, String, case, cast, func, literal, select, true
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Query, Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.models.shop import Shop
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.schemas.voucher_board import VoucherBoardResponse, VoucherUsage, VoucherUsageRow
from app.services.areas import AREA_NONE
from app.services.company_hierarchy import descendant_company_ids
from app.services.extra_reports import _pg
from app.services.period_compare import Period, figure_delta, like_for_like
from app.services.scoping import scope_query_by_user

USAGE_KEYS = ("vouchers", "redemptions", "units", "value")
#: A sale's id as the till names it: a UUID (anything else is never priced).
_UUID_RE = "^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$"


def voucher_display_name(batch: PrepaidVoucherBatch) -> str:
    """
    The name the board shows for a voucher: its type's (the vouchers core's types, wired at the
    integration merge — `type_name`, the type's name the batch was issued as), else the batch's own
    name. A batch made before types has no `type_name` (the migration gave it a legacy type named
    after it), so it shows its own name, as before.
    """
    type_name = (getattr(batch, "type_name", None) or "").strip()
    return type_name or batch.name or "—"


def _uuid(raw) -> Optional[uuid_mod.UUID]:
    if isinstance(raw, uuid_mod.UUID):
        return raw
    try:
        return uuid_mod.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def _dec(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0))
    except Exception:  # noqa: BLE001 — a malformed quantity counts as nothing
        return Decimal(0)


class _Acc:
    __slots__ = ("vouchers", "redemptions", "units", "agorot", "goods_value")

    def __init__(self) -> None:
        self.vouchers = 0
        self.redemptions = 0
        self.units = Decimal(0)
        self.agorot = 0
        self.goods_value = Decimal(0)

    def add(self, other: "_Acc") -> None:
        self.vouchers += other.vouchers
        self.redemptions += other.redemptions
        self.units += other.units
        self.agorot += other.agorot
        self.goods_value += other.goods_value

    def out(self) -> VoucherUsage:
        return VoucherUsage(
            vouchers=self.vouchers,
            redemptions=self.redemptions,
            units=float(round(self.units, 3)),
            value=float(round(Decimal(self.agorot) / 100 + self.goods_value, 2)),
        )


def _redemptions(
    db: Session,
    user: User,
    tenant_id: uuid_mod.UUID,
    period: Period,
    *,
    company_id: Optional[uuid_mod.UUID],
    shop_id: Optional[uuid_mod.UUID],
    area_filter,
    machine_id: Optional[uuid_mod.UUID],
) -> Optional[Query]:
    """The scoped, not-reversed redemptions of the period (a query, not rows), or None."""
    R = PrepaidVoucherRedemption
    q = db.query(R).filter(
        R.tenant_id == tenant_id,
        R.redeemed_at >= period.start,
        R.redeemed_at < period.full_end,
        R.reversed_at.is_(None),
    )
    if period.cut is not None:
        # Like for like: up to the same point as the period still running (inclusive).
        q = q.filter(R.redeemed_at <= period.cut)
    if period.lens is not None:
        # An event: its exact window (above) and its tills.
        q = q.filter(R.machine_id.in_(list(period.lens.machine_ids)))
    q = scope_query_by_user(q, user, db, shop_column=R.shop_id, machine_column=R.machine_id)
    if q is None:
        return None
    if company_id is not None:
        group = descendant_company_ids(db, company_id)
        q = q.filter(R.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group))))
    if shop_id is not None:
        q = q.filter(R.shop_id == shop_id)
    if machine_id is not None:
        q = q.filter(R.machine_id == machine_id)
    if area_filter is not None:
        tills = db.query(POSMachine.id).filter(POSMachine.tenant_id == tenant_id)
        tills = tills.filter(POSMachine.area_id.is_(None)) if area_filter == AREA_NONE else tills.filter(
            POSMachine.area_id == area_filter
        )
        q = q.filter(R.machine_id.in_(tills))
    return q


def goods_statement(pg: bool, ids_subquery):
    """
    A goods redemption's units, its `items` JSON expanded in the database: per batch, sale and
    product, the quantity taken. `ids_subquery`: the redemptions' ids (`SELECT id …`).
    """
    R = PrepaidVoucherRedemption
    if pg:
        items = cast(R.items, postgresql.JSON)
        # Never anything but an array to expand (a malformed row adds nothing, never a 500).
        arr = case((func.json_typeof(items) == "array", items), else_=cast(literal("[]"), postgresql.JSON))
        elem = func.json_array_elements(arr).table_valued("value", joins_implicitly=True).alias("elem")
        product = elem.c.value.op("->>")("productId")
        qty = cast(elem.c.value.op("->>")("quantity"), Numeric(14, 3))
    else:
        elem = func.json_each(R.items).table_valued("value", joins_implicitly=True).alias("elem")
        product = func.json_extract(elem.c.value, "$.productId")
        qty = cast(func.json_extract(elem.c.value, "$.quantity"), Numeric(14, 3))
    stmt = (
        select(
            R.batch_id.label("batch_id"),
            R.transaction_id.label("transaction_id"),
            product.label("product_id"),
            func.coalesce(func.sum(qty), 0).label("qty"),
        )
        .select_from(R)
        .join(elem, true())
        .where(R.id.in_(ids_subquery), R.uses.is_(None))
        .group_by(R.batch_id, R.transaction_id, product)
    )
    if not pg:
        stmt = stmt.where(func.json_type(R.items) == "array")
    return stmt


def prices_statement(pg: bool, ids_subquery, sale_ids: List[uuid_mod.UUID]):
    """(sale, product) → the unit price on that sale's line: one query."""
    TI = TransactionItem
    stmt = select(TI.transaction_id, TI.product_id, TI.unit_price).where(TI.product_id.isnot(None))
    if pg:
        # The sales named by the redemptions, cast to the documents' id type (a malformed name
        # is never cast — it matches nothing).
        R = PrepaidVoucherRedemption
        named = (
            select(cast(R.transaction_id, postgresql.UUID(as_uuid=True)))
            .where(R.id.in_(ids_subquery), R.uses.is_(None), R.transaction_id.op("~")(_UUID_RE))
            .scalar_subquery()
        )
        return stmt.where(TI.transaction_id.in_(named))
    return stmt.where(TI.transaction_id.in_(sale_ids))


def _usage(db: Session, q: Optional[Query]) -> Tuple[_Acc, Dict[str, _Acc]]:
    total = _Acc()
    by_batch: Dict[str, _Acc] = defaultdict(_Acc)
    if q is None:
        return total, by_batch
    R = PrepaidVoucherRedemption
    pg = _pg(db)

    # 1. Per batch: vouchers (distinct), redemptions, a discount's uses and agorot.
    for row in (
        q.with_entities(
            R.batch_id,
            func.count(func.distinct(R.voucher_id)),
            func.count(R.id),
            func.coalesce(func.sum(R.uses), 0),
            func.coalesce(func.sum(R.discount_amount), 0),
        )
        .group_by(R.batch_id)
        .all()
    ):
        acc = by_batch[str(row[0])]
        acc.vouchers, acc.redemptions = int(row[1] or 0), int(row[2] or 0)
        acc.units += _dec(row[3])
        acc.agorot += int(row[4] or 0)

    # 2. Goods units per batch, sale and product (the JSON expanded in SQL).
    ids = q.with_entities(R.id).subquery()
    goods = db.execute(goods_statement(pg, select(ids.c.id))).all()
    if goods:
        # 3. Their prices on their own sale documents: one query.
        sale_ids = [u for u in {_uuid(g.transaction_id) for g in goods if g.transaction_id} if u is not None]
        prices: Dict[Tuple[str, str], Decimal] = {}
        if sale_ids:
            for tx_id, product_id, unit_price in db.execute(prices_statement(pg, select(ids.c.id), sale_ids)):
                prices.setdefault((str(tx_id), str(product_id)), _dec(unit_price))
        for g in goods:
            acc = by_batch[str(g.batch_id)]
            qty = _dec(g.qty)
            acc.units += qty
            sale = _uuid(g.transaction_id)
            if sale is not None and g.product_id is not None:
                price = prices.get((str(sale), str(g.product_id)))
                if price is not None:
                    acc.goods_value += price * qty

    for acc in by_batch.values():
        # A voucher is one batch's: the distinct vouchers add up across batches.
        total.add(acc)
    return total, by_batch


def _deltas(current: VoucherUsage, previous: VoucherUsage):
    a, b = current.model_dump(), previous.model_dump()
    return {k: figure_delta("items" if k == "units" else k, float(a[k]), float(b[k])) for k in USAGE_KEYS}


def build_voucher_board(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window,
    compare_window=None,
    *,
    company_id: Optional[uuid_mod.UUID] = None,
    shop_id: Optional[uuid_mod.UUID] = None,
    area_filter=None,
    machine_id: Optional[uuid_mod.UUID] = None,
    now: Optional[datetime] = None,
) -> VoucherBoardResponse:
    """`window` / `compare_window`: a `ReportWindow` (days) or a `Period` (days or an event)."""
    now = now or datetime.now(timezone.utc)
    current_p = window if isinstance(window, Period) else Period(window)
    previous_p = compare_window if isinstance(compare_window, Period) or compare_window is None else Period(compare_window)
    # While the period runs, the compared one like for like (the comparisons' rule).
    cut_p = like_for_like(current_p, previous_p, now)
    narrow = dict(company_id=company_id, shop_id=shop_id, area_filter=area_filter, machine_id=machine_id)
    total, by_batch = _usage(db, _redemptions(db, current_user, tenant_id, current_p, **narrow))
    prev_total: Optional[_Acc] = None
    prev_by: Dict[str, _Acc] = {}
    if cut_p is not None:
        prev_total, prev_by = _usage(db, _redemptions(db, current_user, tenant_id, cut_p, **narrow))

    batch_ids = [_uuid(b) for b in set(by_batch) | set(prev_by)]
    batches = {
        str(b.id): b
        for b in db.query(PrepaidVoucherBatch).filter(
            PrepaidVoucherBatch.tenant_id == tenant_id,
            PrepaidVoucherBatch.id.in_([b for b in batch_ids if b is not None]),
        )
    } if batch_ids else {}

    rows: List[VoucherUsageRow] = []
    for batch_id in set(by_batch) | set(prev_by):
        batch = batches.get(batch_id)
        if batch is None:
            continue  # another tenant's id on a redemption: never named, never counted
        current = (by_batch.get(batch_id) or _Acc()).out()
        previous = (prev_by.get(batch_id) or _Acc()).out() if cut_p is not None else None
        rows.append(
            VoucherUsageRow(
                batch_id=batch_id,
                name=voucher_display_name(batch),
                kind=batch.kind or "items",
                current=current,
                previous=previous,
                deltas=_deltas(current, previous) if previous is not None else None,
            )
        )
    rows.sort(key=lambda r: (-r.current.vouchers, -r.current.value, -(r.previous.vouchers if r.previous else 0), r.name))

    totals = total.out()
    previous_totals = prev_total.out() if prev_total is not None else None
    return VoucherBoardResponse(
        window=current_p.window.to_schema(),
        compare_window=previous_p.window.to_schema() if previous_p is not None else None,
        totals=totals,
        previous=previous_totals,
        deltas=_deltas(totals, previous_totals) if previous_totals is not None else None,
        rows=rows,
    )
