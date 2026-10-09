"""
OTH and club discounts ("על חשבון הבית" / "הנחת מועדון"): the dashboard's figures.

Both are switched on per till by parameters (`othEnabled`, `clubButtonEnabled`,
`app.services.till_parameters`) and reach the cloud on the sale documents the tills push:

* an OTH line is a sale line with `oth_reason` set — a 100% line discount, given by
  `oth_by`, approved by `oth_approved_by`. Counted at its list price (unit price ×
  quantity): what the shop gave away. By item, employee, reason, till and local day.
* a club discount is a sale whose `basket_discount_kind` is `club`, the amount in
  `basket_discount`. By till and local day — and beside the manual basket discounts,
  so the two read as the two kinds of basket discount they are.

* a discount voucher ("שובר הנחה", a prepaid voucher of a discount kind —
  docs/SPEC_VOUCHER_PRODUCTION.md §7) is a row of `transaction_voucher_discounts` on the
  sale: a discount on the document like the others, never a tender. By batch, till and
  local day, with the uses taken.

Over the same document set as every report (`build_scoped_transaction_query`: the
window, the caller's scope, sale statuses), sales only — a credit note credits what
was paid, and an OTH line was paid nothing.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User

CLUB = "club"
MANUAL = "manual"


def _money(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _dec(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _local_day(moment: datetime, zone) -> str:
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone).date().isoformat()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


class _Names:
    """Shops, tills and people by id, one query per kind."""

    def __init__(self, db: Session):
        self.db = db

    def tills(self, ids) -> Dict[str, POSMachine]:
        keys = [k for k in (_uuid(i) for i in ids) if k]
        if not keys:
            return {}
        return {str(m.id): m for m in self.db.query(POSMachine).filter(POSMachine.id.in_(keys)).all()}

    def shops(self, ids) -> Dict[str, str]:
        keys = [k for k in (_uuid(i) for i in ids) if k]
        if not keys:
            return {}
        return {str(s.id): s.name for s in self.db.query(Shop).filter(Shop.id.in_(keys)).all()}

    def people(self, ids) -> Dict[str, str]:
        """A till user's name, else a cloud account's — an employee or approver may be either."""
        keys = {str(i): _uuid(i) for i in ids if i}
        wanted = [k for k in keys.values() if k]
        out: Dict[str, str] = {}
        if wanted:
            for pu in self.db.query(PosUser).filter(PosUser.id.in_(wanted)).all():
                full = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
                out[str(pu.id)] = full or pu.username
            rest = [k for k in wanted if str(k) not in out]
            if rest:
                for u in self.db.query(User).filter(User.id.in_(rest)).all():
                    out[str(u.id)] = u.username or u.email
        return out


def _till_row(key: Optional[str], tills: Dict[str, POSMachine], shops: Dict[str, str]) -> Dict[str, Any]:
    till = tills.get(key) if key else None
    return {
        "machineId": key,
        "name": till.name if till else None,
        "posNumber": getattr(till, "pos_number", None) if till else None,
        "shopName": shops.get(str(till.shop_id)) if till and till.shop_id else None,
    }


def build_discounts_report(
    db: Session,
    user: User,
    tenant_id,
    window,
    *,
    shop_id=None,
    machine_id=None,
) -> Dict[str, Any]:
    """`{window, generatedAt, oth: {...}, club: {...}, basketByKind: [...]}` — see the module."""
    from app.services.reports import _is_refund_condition, _load_zoneinfo, build_scoped_transaction_query

    out: Dict[str, Any] = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "oth": {
            "totals": {"count": 0, "quantity": 0.0, "value": 0.0, "documents": 0},
            "byItem": [], "byEmployee": [], "byReason": [], "byTill": [], "byDay": [],
        },
        "club": {"totals": {"count": 0, "amount": 0.0}, "byTill": [], "byDay": []},
        "basketByKind": [],
        "vouchers": {
            "totals": {"count": 0, "uses": 0, "amount": 0.0, "documents": 0},
            "byBatch": [], "byTill": [], "byDay": [],
            "testDeductions": {"count": 0, "uses": 0, "amount": 0.0, "documents": 0},
        },
        # Production vouchers booked as a deduction: not discounts — their own category.
        "productionVouchers": {"totals": {"count": 0, "uses": 0, "amount": 0.0, "documents": 0}, "byBatch": []},
    }
    tx_q = build_scoped_transaction_query(db, user, tenant_id, window, shop_id=shop_id, machine_id=machine_id)
    if tx_q is None:
        return out
    sales = tx_q.filter(~_is_refund_condition())
    zone = _load_zoneinfo(window.tz_name)
    names = _Names(db)

    # ── OTH ──
    sale_ids = sales.with_entities(Transaction.id).subquery()
    oth_rows = (
        db.query(
            TransactionItem.product_id,
            TransactionItem.product_name,
            TransactionItem.quantity,
            TransactionItem.unit_price,
            TransactionItem.oth_reason,
            TransactionItem.oth_by,
            Transaction.id,
            Transaction.cashier_id,
            Transaction.created_at,
            Transaction.machine_id,
        )
        .join(Transaction, Transaction.id == TransactionItem.transaction_id)
        .filter(TransactionItem.transaction_id.in_(db.query(sale_ids.c.id)))
        .filter(TransactionItem.oth_reason.isnot(None))
        .all()
    )

    def oth_bucket():
        return {"count": 0, "quantity": Decimal("0"), "value": Decimal("0"), "documents": set()}

    totals = oth_bucket()
    by_item: Dict[str, dict] = {}
    item_names: Dict[str, Optional[str]] = {}
    by_employee: Dict[Optional[str], dict] = {}
    by_reason: Dict[str, dict] = {}
    by_till: Dict[Optional[str], dict] = {}
    by_day: Dict[str, dict] = {}
    for product_id, product_name, qty, unit_price, reason, by, tx_id, cashier, created_at, till in oth_rows:
        item_key = str(product_id) if product_id else f"name:{product_name or ''}"
        if product_name or item_key not in item_names:
            item_names[item_key] = product_name or item_names.get(item_key)
        employee = (by or cashier or None)
        quantity = _dec(qty)
        value = (_dec(unit_price) * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        for b in (
            totals,
            by_item.setdefault(item_key, oth_bucket()),
            by_employee.setdefault(employee, oth_bucket()),
            by_reason.setdefault((reason or "").strip(), oth_bucket()),
            by_till.setdefault(str(till) if till else None, oth_bucket()),
            by_day.setdefault(_local_day(created_at, zone), oth_bucket()),
        ):
            b["count"] += 1
            b["quantity"] += quantity
            b["value"] += value
            b["documents"].add(tx_id)

    def oth_flat(b) -> Dict[str, Any]:
        return {
            "count": b["count"],
            "quantity": float(b["quantity"]),
            "value": _money(b["value"]),
            "documents": len(b["documents"]),
        }

    # ── Club, and the basket discounts by kind ──
    basket_rows = (
        sales.filter(Transaction.basket_discount.isnot(None), Transaction.basket_discount > 0)
        .with_entities(
            Transaction.basket_discount,
            Transaction.basket_discount_kind,
            Transaction.created_at,
            Transaction.machine_id,
        )
        .all()
    )

    def club_bucket():
        return {"count": 0, "amount": Decimal("0")}

    club_totals = club_bucket()
    club_by_till: Dict[Optional[str], dict] = {}
    club_by_day: Dict[str, dict] = {}
    by_kind: Dict[str, dict] = {}
    for amount, kind, created_at, till in basket_rows:
        kind = CLUB if kind == CLUB else MANUAL
        money = _dec(amount)
        targets = [by_kind.setdefault(kind, club_bucket())]
        if kind == CLUB:
            targets += [
                club_totals,
                club_by_till.setdefault(str(till) if till else None, club_bucket()),
                club_by_day.setdefault(_local_day(created_at, zone), club_bucket()),
            ]
        for b in targets:
            b["count"] += 1
            b["amount"] += money

    def club_flat(b) -> Dict[str, Any]:
        return {"count": b["count"], "amount": _money(b["amount"])}

    # ── Discount vouchers ──
    from sqlalchemy import and_, case

    from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION
    from app.models.prepaid_voucher import TransactionVoucherDiscount as TVD
    from app.services.shift_totals import production_deduction_conditions

    # The one rule of every report and the Z (shift_totals.production_deduction_conditions): a
    # production voucher's deduction, unless it is a staff test batch's.
    production = case((and_(*production_deduction_conditions(db)), True), else_=False).label("production")
    all_voucher_rows = (
        db.query(
            TVD.discount_amount, TVD.uses, TVD.batch_id, TVD.batch_name,
            Transaction.id, Transaction.created_at, Transaction.machine_id, TVD.kind, production,
        )
        .join(Transaction, Transaction.id == TVD.transaction_id)
        .filter(TVD.transaction_id.in_(db.query(sale_ids.c.id)))
        .all()
    )
    # A production voucher's deduction is "שוברי הפקה", apart. A staff test voucher's that reached a
    # real sale anyway (flagged `test_real`) is no production's: an ordinary voucher discount here,
    # as in the cashier report, the Z and insights — counted with the discount vouchers and shown as
    # "of which" (`vouchers.testDeductions`).
    voucher_rows = [r[:7] for r in all_voucher_rows if not r[8]]
    deduction_rows = [r[:7] for r in all_voucher_rows if r[8]]
    test_rows = [r[:7] for r in all_voucher_rows if r[7] == PRODUCTION_VOUCHER_DEDUCTION and not r[8]]

    def voucher_bucket():
        return {"count": 0, "uses": 0, "amount": Decimal("0"), "documents": set()}

    v_totals = voucher_bucket()
    v_by_batch: Dict[Optional[str], dict] = {}
    v_batch_names: Dict[Optional[str], Optional[str]] = {}
    v_by_till: Dict[Optional[str], dict] = {}
    v_by_day: Dict[str, dict] = {}
    for amount, uses, batch_id, batch_name, tx_id, created_at, till in voucher_rows:
        batch_key = str(batch_id) if batch_id else None
        if batch_name:
            v_batch_names[batch_key] = batch_name
        for b in (
            v_totals,
            v_by_batch.setdefault(batch_key, voucher_bucket()),
            v_by_till.setdefault(str(till) if till else None, voucher_bucket()),
            v_by_day.setdefault(_local_day(created_at, zone), voucher_bucket()),
        ):
            b["count"] += 1
            b["uses"] += int(uses or 1)
            b["amount"] += abs(_dec(amount))
            b["documents"].add(tx_id)

    def voucher_flat(b) -> Dict[str, Any]:
        return {"count": b["count"], "uses": b["uses"], "amount": _money(b["amount"]), "documents": len(b["documents"])}

    # ── Names ──
    tills = names.tills([k for k in list(by_till) + list(club_by_till) + list(v_by_till) if k])
    shops = names.shops([str(m.shop_id) for m in tills.values() if m.shop_id])
    people = names.people([k for k in by_employee if k])

    def by_value(rows: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
        return sorted(rows, key=lambda r: -r[key])

    out["oth"] = {
        "totals": oth_flat(totals),
        "byItem": by_value([
            {
                "productId": None if k.startswith("name:") else k,
                "name": item_names.get(k),
                **oth_flat(b),
            }
            for k, b in by_item.items()
        ], "value"),
        "byEmployee": by_value([
            {"posUserId": k, "name": people.get(k) if k else None, **oth_flat(b)} for k, b in by_employee.items()
        ], "value"),
        "byReason": by_value([
            {"reason": k or None, **oth_flat(b)} for k, b in by_reason.items()
        ], "value"),
        "byTill": by_value([
            {**_till_row(k, tills, shops), **oth_flat(b)} for k, b in by_till.items()
        ], "value"),
        "byDay": [{"date": d, **oth_flat(by_day[d])} for d in sorted(by_day)],
    }
    out["club"] = {
        "totals": club_flat(club_totals),
        "byTill": by_value([
            {**_till_row(k, tills, shops), **club_flat(b)} for k, b in club_by_till.items()
        ], "amount"),
        "byDay": [{"date": d, **club_flat(club_by_day[d])} for d in sorted(club_by_day)],
    }
    out["basketByKind"] = [
        {"kind": kind, **club_flat(by_kind[kind])} for kind in (CLUB, MANUAL) if kind in by_kind
    ]
    d_totals = voucher_bucket()
    d_by_batch: Dict[Optional[str], dict] = {}
    for amount, uses, batch_id, batch_name, tx_id, _created_at, _till in deduction_rows:
        batch_key = str(batch_id) if batch_id else None
        if batch_name:
            v_batch_names[batch_key] = batch_name
        for b in (d_totals, d_by_batch.setdefault(batch_key, voucher_bucket())):
            b["count"] += 1
            b["uses"] += int(uses or 1)
            b["amount"] += abs(_dec(amount))
            b["documents"].add(tx_id)
    out["productionVouchers"] = {
        "totals": voucher_flat(d_totals),
        "byBatch": by_value([
            {"batchId": k, "name": v_batch_names.get(k), **voucher_flat(b)} for k, b in d_by_batch.items()
        ], "amount"),
    }
    t_totals = voucher_bucket()
    for amount, uses, _batch_id, _batch_name, tx_id, _created_at, _till in test_rows:
        t_totals["count"] += 1
        t_totals["uses"] += int(uses or 1)
        t_totals["amount"] += abs(_dec(amount))
        t_totals["documents"].add(tx_id)
    out["vouchers"] = {
        "totals": voucher_flat(v_totals),
        "testDeductions": voucher_flat(t_totals),
        "byBatch": by_value([
            {"batchId": k, "name": v_batch_names.get(k), **voucher_flat(b)} for k, b in v_by_batch.items()
        ], "amount"),
        "byTill": by_value([
            {**_till_row(k, tills, shops), **voucher_flat(b)} for k, b in v_by_till.items()
        ], "amount"),
        "byDay": [{"date": d, **voucher_flat(v_by_day[d])} for d in sorted(v_by_day)],
    }
    return out
