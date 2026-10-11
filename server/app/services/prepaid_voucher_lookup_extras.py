"""What the till's voucher lookup adds for "בירור יתרת שובר" and the voucher station's "תנאי המימוש" (11.10.2026).

POST /sync/{id}/prepaid-vouchers/lookup adds, beside the voucher's status, quota and terms:

    redemptions        newest first, at most TILL_HISTORY_LIMIT:
                       {id, at, machineName, shopName, posUserName, quantity, items [{productId, name,
                        quantity}], uses, amountAgorot, status "redeemed" | "reversed", reversedAt,
                        documentNumber}
    redemptionsTotal   how many there are in all (reversed ones included)
    firstRedeemedAt / lastRedeemedAt   the voucher's own stamps
    validShops         only for a batch limited to named shops: [{id, name}] by name ("תקף בסניפים: …");
                       absent = every shop of its company group
    maxUnitsPerSale    only where a limit exists: an item discount's most units in one sale
                       (units per use × uses per sale); absent for goods (the quota is the only limit)

No batch restricts days or hours, so there is no `validTimes`: validity is `validFrom` / `validUntil`
(already in the lookup, with `stacking`, `maxVouchersPerSale`, `splitAllowed`, `includeExtras`,
`pricing`, `tillValueAgorot`, `quota` / `used` / `remaining`, per group `eligibleProductIds`).

The rows are the dashboard's (GET /prepaid-vouchers/vouchers/{id}, voucher_out's redemptions: the
same table, the same till names) read newest first. `at` is UTC ISO; the till shows it in its
tenant's time. `quantity` is the goods' units taken (a discount voucher: its uses); `amountAgorot`
the ₪ a discount took off (null for goods). `documentNumber` is the sale document's number when that
document has reached the cloud.

Only the voucher's own company group sees the history and the shop names: a till whose shop's company is not the batch's or under
it (the redemption's own rule, refusal_reason) gets an empty history, no stamps and no shop names — the lookup
itself stays what it was (`redeemable: false`, `prepaid_voucher_wrong_shop`); another tenant's code
is a 404 before any of this. Read only: nothing is held, taken or written.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.models.shop import Shop

#: The most redemptions a till's lookup lists.
TILL_HISTORY_LIMIT = 20

REDEEMED = "redeemed"
REVERSED = "reversed"


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def machine_names(db: Session, ids: Iterable[Any]) -> Dict[str, str]:
    """Till id → its name (voucher_out's lookup, shared)."""
    wanted = list({i for i in (_uuid(x) for x in ids) if i is not None})
    if not wanted:
        return {}
    return {str(i): n for i, n in db.query(POSMachine.id, POSMachine.name).filter(POSMachine.id.in_(wanted))}


def _shop_names(db: Session, ids: Iterable[Any]) -> Dict[str, str]:
    wanted = list({i for i in (_uuid(x) for x in ids) if i is not None})
    if not wanted:
        return {}
    return {str(i): n for i, n in db.query(Shop.id, Shop.name).filter(Shop.id.in_(wanted))}


def _document_numbers(db: Session, tenant_id, rows: List[PrepaidVoucherRedemption]) -> Dict[str, str]:
    """The sale document's number per transaction id, for the documents the cloud has."""
    from sqlalchemy import or_

    from app.models.transaction import Transaction

    ids = list({i for i in (_uuid(r.transaction_id) for r in rows) if i is not None})
    if not ids:
        return {}
    tills = list({r.machine_id for r in rows if r.machine_id is not None})
    scope = [Transaction.tenant_id == tenant_id]
    if tills:
        # A document stored before tenants were stamped on it: the redeeming till's own.
        scope.append(Transaction.tenant_id.is_(None) & Transaction.machine_id.in_(tills))
    found = db.query(Transaction.id, Transaction.transaction_number).filter(Transaction.id.in_(ids), or_(*scope))
    return {str(i): str(n) for i, n in found if n is not None}


def sees_history(db: Session, machine: POSMachine, voucher: PrepaidVoucher) -> bool:
    """Whether [machine] belongs to the voucher's company group (the redemption's company rule)."""
    from app.services.prepaid_vouchers import _company_group

    if str(voucher.tenant_id) != str(machine.tenant_id) or not machine.shop_id:
        return False
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    return shop is not None and str(shop.company_id) in _company_group(db, voucher.batch.company_id)


def _quantity(r: PrepaidVoucherRedemption):
    from app.services.prepaid_vouchers import qty, qty_out

    if r.uses:
        return int(r.uses)
    return qty_out(sum((qty(i.get("quantity")) for i in (r.items or []) if isinstance(i, dict)), Decimal(0)))


def redemption_row(
    r: PrepaidVoucherRedemption, tills: Dict[str, str], shops: Dict[str, str], documents: Dict[str, str],
) -> Dict[str, Any]:
    from app.services.prepaid_vouchers import _iso, qty_out

    return {
        "id": str(r.id),
        "at": _iso(r.redeemed_at),
        "machineName": tills.get(str(r.machine_id)) if r.machine_id else None,
        "shopName": shops.get(str(r.shop_id)) if r.shop_id else None,
        "posUserName": r.pos_user_name,
        "quantity": _quantity(r),
        "items": [
            {"productId": i.get("productId"), "name": i.get("name"), "quantity": qty_out(i.get("quantity"))}
            for i in (r.items or [])
            if isinstance(i, dict)
        ],
        "uses": int(r.uses) if r.uses is not None else None,
        # A discount voucher's use: the ₪ it took off the sale, agorot (goods: null).
        "amountAgorot": int(r.discount_amount) if r.discount_amount is not None else None,
        "status": REVERSED if r.reversed_at is not None else REDEEMED,
        "reversedAt": _iso(r.reversed_at),
        "documentNumber": documents.get(str(r.transaction_id)) if r.transaction_id else None,
    }


def _hidden() -> Dict[str, Any]:
    """What a till outside the voucher's company group gets: no history, no stamps."""
    return {"redemptions": [], "redemptionsTotal": 0, "firstRedeemedAt": None, "lastRedeemedAt": None}


def till_history(
    db: Session, machine: POSMachine, voucher: PrepaidVoucher, limit: int = TILL_HISTORY_LIMIT, *, checked: bool = False,
) -> Dict[str, Any]:
    """`redemptions` (newest first, at most [limit]), `redemptionsTotal`, `firstRedeemedAt`, `lastRedeemedAt`."""
    from app.services.prepaid_vouchers import _iso

    if not checked and not sees_history(db, machine, voucher):
        return _hidden()
    q = db.query(PrepaidVoucherRedemption).filter(
        PrepaidVoucherRedemption.voucher_id == voucher.id,
        PrepaidVoucherRedemption.tenant_id == voucher.tenant_id,
    )
    total = q.count()
    rows = (
        q.order_by(PrepaidVoucherRedemption.redeemed_at.desc(), PrepaidVoucherRedemption.id.desc())
        .limit(max(0, int(limit)))
        .all()
    )
    tills = machine_names(db, [r.machine_id for r in rows])
    shops = _shop_names(db, [r.shop_id for r in rows])
    documents = _document_numbers(db, voucher.tenant_id, rows)
    return {
        "redemptions": [redemption_row(r, tills, shops, documents) for r in rows],
        "redemptionsTotal": int(total),
        "firstRedeemedAt": _iso(voucher.first_redeemed_at),
        "lastRedeemedAt": _iso(voucher.last_redeemed_at),
    }


def valid_shops(db: Session, voucher: PrepaidVoucher) -> Optional[List[Dict[str, str]]]:
    """The named shops of a batch for some shops only, by name; None for a batch for every shop."""
    named = [i for i in (_uuid(s) for s in (voucher.batch.shop_ids or [])) if i is not None]
    if not named:
        return None
    rows = db.query(Shop.id, Shop.name).filter(Shop.id.in_(named), Shop.tenant_id == voucher.tenant_id).all()
    return [{"id": str(i), "name": n} for i, n in sorted(rows, key=lambda r: (r[1] or "", str(r[0])))]


def max_units_per_sale(voucher: PrepaidVoucher) -> Optional[int]:
    """An item discount's most discounted units in one sale; None where no such limit exists."""
    batch = voucher.batch
    if (batch.kind or "items") != "item_discount" or batch.max_units is None:
        return None
    return int(batch.max_units) * max(1, int(batch.max_uses_per_sale or 1))


def lookup_extras(db: Session, machine: POSMachine, voucher: PrepaidVoucher) -> Dict[str, Any]:
    """Everything the lookup adds: the history (till_history), `validShops`, `maxUnitsPerSale`. Read only."""
    seen = sees_history(db, machine, voucher)
    out = till_history(db, machine, voucher, checked=True) if seen else _hidden()
    shops = valid_shops(db, voucher) if seen else None
    if shops:
        out["validShops"] = shops
    most = max_units_per_sale(voucher)
    if most is not None:
        out["maxUnitsPerSale"] = most
    return out
