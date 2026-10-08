"""
The control board's "שוברים" card (the owner: "הצג בלוח בקרה כמה שוברים נוצלו בסניף — שם
שובר"): the prepaid vouchers ("שוברי הפקה") redeemed in the scope over a period, by voucher
name, against a compared period.

Read-only over the voucher tables — nothing here writes to them, and nothing in the voucher
services changed for it:

* `prepaid_voucher_redemptions` in the window (by `redeemed_at`, the report timezone's days);
  a **reversed** redemption (its payment was abandoned at the till, the goods went back on
  the voucher) counts nowhere, as in the batch report;
* scoped by role exactly like the overview's money — `scope_query_by_user` on the
  redemption's shop and till — and narrowed (never widened) by the company / shop / point of
  sale / till asked for. A point of sale is the tills standing in it now (a redemption has
  no shift to carry a stamped area);
* per voucher: distinct vouchers used, redemptions, units (a discount voucher's uses) and the
  value — a discount voucher's discount, goods at the unit price on their own sale document
  (one query over the documents' lines; a sale not yet synced adds no ₪).

The name shown is `voucher_display_name` — today the batch's name. Voucher *types* are being
added on another branch; at that merge, that one function switches to the type's name.
"""
from __future__ import annotations

import uuid as uuid_mod
from collections import defaultdict
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.models.shop import Shop
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.schemas.voucher_board import VoucherBoardResponse, VoucherUsage, VoucherUsageRow
from app.services.areas import AREA_NONE
from app.services.company_hierarchy import descendant_company_ids
from app.services.period_compare import Period, figure_delta
from app.services.scoping import scope_query_by_user

USAGE_KEYS = ("vouchers", "redemptions", "units", "value")
#: Sale documents priced per query (an IN list); a festival day can hold thousands.
_PRICE_CHUNK = 1000


def voucher_display_name(batch: PrepaidVoucherBatch) -> str:
    """
    The name the board shows for a voucher.

    TODO(voucher-types): the voucher-types branch adds a type to the batch; at that merge
    return the type's name here (falling back to the batch's name), and nothing else changes.
    """
    return batch.name or "—"


def _uuid(raw) -> Optional[uuid_mod.UUID]:
    if isinstance(raw, uuid_mod.UUID):
        return raw
    try:
        return uuid_mod.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def _qty(value) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:  # noqa: BLE001 — a malformed JSON quantity counts as nothing
        return Decimal(0)


class _Acc:
    __slots__ = ("vouchers", "redemptions", "units", "agorot", "goods_value")

    def __init__(self) -> None:
        self.vouchers: Set[str] = set()
        self.redemptions = 0
        self.units = Decimal(0)
        self.agorot = 0
        self.goods_value = Decimal(0)

    def out(self) -> VoucherUsage:
        return VoucherUsage(
            vouchers=len(self.vouchers),
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
):
    R = PrepaidVoucherRedemption
    q = db.query(
        R.batch_id, R.voucher_id, R.items, R.uses, R.discount_amount, R.transaction_id,
    ).filter(
        R.tenant_id == tenant_id,
        R.reversed_at.is_(None),
        R.redeemed_at >= period.start,
        R.redeemed_at < period.end,
    )
    if period.lens is not None:
        # An event: its exact window (above) and its tills.
        q = q.filter(R.machine_id.in_(list(period.lens.machine_ids)))
    q = scope_query_by_user(q, user, db, shop_column=R.shop_id, machine_column=R.machine_id)
    if q is None:
        return []
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
    return q.all()


def _unit_prices(db: Session, transaction_ids: Iterable[str]) -> Dict[Tuple[str, str], Decimal]:
    """(sale document id, product id) → the unit price on that document's line."""
    ids = sorted({u for u in (_uuid(t) for t in transaction_ids) if u is not None}, key=str)
    prices: Dict[Tuple[str, str], Decimal] = {}
    for start in range(0, len(ids), _PRICE_CHUNK):
        chunk = ids[start:start + _PRICE_CHUNK]
        for tx_id, product_id, unit_price in db.query(
            TransactionItem.transaction_id, TransactionItem.product_id, TransactionItem.unit_price
        ).filter(TransactionItem.transaction_id.in_(chunk), TransactionItem.product_id.isnot(None)):
            prices.setdefault((str(tx_id), str(product_id)), Decimal(str(unit_price or 0)))
    return prices


def _usage(db: Session, rows) -> Tuple[_Acc, Dict[str, _Acc]]:
    total = _Acc()
    by_batch: Dict[str, _Acc] = defaultdict(_Acc)
    prices = _unit_prices(db, [r.transaction_id for r in rows if r.transaction_id and not r.uses])
    for r in rows:
        batch = str(r.batch_id)
        units = Decimal(int(r.uses)) if r.uses else sum((_qty(x.get("quantity")) for x in (r.items or [])), Decimal(0))
        value = Decimal(0)
        tx = str(_uuid(r.transaction_id)) if r.transaction_id and _uuid(r.transaction_id) else None
        if not r.uses and tx:
            for x in r.items or []:
                price = prices.get((tx, str(x.get("productId"))))
                if price is not None:
                    value += price * _qty(x.get("quantity"))
        for acc in (total, by_batch[batch]):
            acc.vouchers.add(str(r.voucher_id))
            acc.redemptions += 1
            acc.units += units
            acc.agorot += int(r.discount_amount or 0)
            acc.goods_value += value
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
) -> VoucherBoardResponse:
    """`window` / `compare_window`: a `ReportWindow` (days) or a `Period` (days or an event)."""
    current_p = window if isinstance(window, Period) else Period(window)
    previous_p = compare_window if isinstance(compare_window, Period) or compare_window is None else Period(compare_window)
    narrow = dict(company_id=company_id, shop_id=shop_id, area_filter=area_filter, machine_id=machine_id)
    total, by_batch = _usage(db, _redemptions(db, current_user, tenant_id, current_p, **narrow))
    prev_total: Optional[_Acc] = None
    prev_by: Dict[str, _Acc] = {}
    if previous_p is not None:
        prev_total, prev_by = _usage(db, _redemptions(db, current_user, tenant_id, previous_p, **narrow))

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
        previous = (prev_by.get(batch_id) or _Acc()).out() if previous_p is not None else None
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
