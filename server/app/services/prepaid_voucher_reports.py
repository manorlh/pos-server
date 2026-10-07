"""
Prepaid voucher ("שוברי הפקה") reports: one batch, over its whole life.

* **Vouchers** — issued / unused / partly used / used / cancelled, by the vouchers' state
  now (the same counts as the batch list).
* **Goods** — per product of the batch: issued (quantity × vouchers), taken, forfeited
  (one-time vouchers taken in part), still outstanding on live vouchers, and void on
  cancelled ones. issued = taken + forfeited + outstanding + void.
* **Redemptions** — by hour of day, by day, by shop, by till and by employee: how many
  redemptions, how many vouchers, how many units.

* **Usage** — a discount voucher's batch (docs/SPEC_VOUCHER_PRODUCTION.md §7): uses issued
  (vouchers × uses per voucher), used, remaining on live vouchers, void on cancelled ones,
  and the total benefit given (₪, what the sale documents took off); also how many uses
  were flagged by the cloud's re-check and how many are held by open sales right now.
  issued = used + remaining + void. A goods batch: its units the same way (no ₪ figure —
  the goods were paid outside the till).

A **reversed** redemption (its payment was abandoned at the till and the goods went back
on the voucher) counts nowhere: it did not happen. Hours and days are the tenant's
local time (`resolve_report_timezone`). For a discount batch a redemption is one use
confirmed with its sale: its "units" are its uses, and its `amount` the ₪ it took off.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption, PrepaidVoucherReservation
from app.models.shop import Shop
from app.models.user import User
from app.services import prepaid_vouchers as PV
from app.services.reports import _load_zoneinfo, resolve_report_timezone


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def _units(rows) -> int:
    return sum(int((r or {}).get("quantity") or 0) for r in (rows or []))


class _Bucket:
    __slots__ = ("redemptions", "units", "vouchers", "agorot")

    def __init__(self) -> None:
        self.redemptions = 0
        self.units = 0
        self.vouchers: set = set()
        self.agorot = 0

    def add(self, r: PrepaidVoucherRedemption) -> None:
        self.redemptions += 1
        # A discount voucher's use counts its uses; goods count their units.
        self.units += int(r.uses) if r.uses else _units(r.items)
        self.agorot += int(r.discount_amount or 0)
        self.vouchers.add(str(r.voucher_id))

    def out(self, money: bool = False) -> Dict[str, Any]:
        out: Dict[str, Any] = {"redemptions": self.redemptions, "vouchers": len(self.vouchers), "units": self.units}
        if money:
            # A discount batch: the ₪ its uses took off.
            out["amount"] = round(self.agorot / 100, 2)
        return out


def _usage(db: Session, batch, stats: Dict[str, int], products, redemptions) -> Dict[str, Any]:
    """Issued / used / remaining / void, and the ₪ given — see the module docstring."""
    if not PV.is_discount(batch):
        return {
            "unit": "units",
            "issued": sum(p["issued"] for p in products),
            "used": sum(p["taken"] for p in products),
            "remaining": sum(p["outstanding"] for p in products),
            "void": sum(p["void"] + p["forfeited"] for p in products),
            "benefit": None,
            "flagged": 0,
            "held": 0,
        }
    per = int(batch.uses_per_voucher or 1)
    remaining = void = 0
    for status_, left in db.query(PrepaidVoucher.status, PrepaidVoucher.uses_left).filter(
        PrepaidVoucher.batch_id == batch.id
    ):
        if status_ == "cancelled":
            void += int(left or 0)
        else:
            remaining += int(left or 0)
    now = datetime.now(timezone.utc)
    held = sum(
        int(r.uses or 1)
        for r in db.query(PrepaidVoucherReservation).filter(
            PrepaidVoucherReservation.batch_id == batch.id, PrepaidVoucherReservation.status == "held"
        )
        if _utc(r.expires_at) and _utc(r.expires_at) > now
    )
    return {
        "unit": "uses",
        "issued": per * int(stats.get("total", 0)),
        "used": sum(int(r.uses or 0) for r in redemptions),
        "remaining": remaining,
        "void": void,
        "benefit": round(sum(int(r.discount_amount or 0) for r in redemptions) / 100, 2),
        "flagged": sum(1 for r in redemptions if r.flags),
        "held": held,
    }


def batch_report(db: Session, user: User, tenant_id, batch_id, tz: Optional[str] = None) -> Dict[str, Any]:
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    tz_name = resolve_report_timezone(db, tenant_id, tz)
    zone = _load_zoneinfo(tz_name)

    money = PV.is_discount(batch)
    stats = PV._stats(db, [batch.id]).get(str(batch.id)) or {
        "total": 0, "active": 0, "partiallyUsed": 0, "used": 0, "cancelled": 0,
    }

    # ── Goods ────────────────────────────────────────────────────────────────
    order = [str(i.product_id) for i in batch.items]
    names = {str(i.product_id): i.product_name for i in batch.items}
    per_voucher = {str(i.product_id): int(i.quantity) for i in batch.items}
    outstanding: Dict[str, int] = defaultdict(int)
    void: Dict[str, int] = defaultdict(int)
    for status_, remaining in db.query(PrepaidVoucher.status, PrepaidVoucher.remaining).filter(
        PrepaidVoucher.batch_id == batch.id
    ):
        target = void if status_ == "cancelled" else outstanding
        for pid, q in (remaining or {}).items():
            target[str(pid)] += int(q or 0)

    redemptions: List[PrepaidVoucherRedemption] = (
        db.query(PrepaidVoucherRedemption)
        .filter(
            PrepaidVoucherRedemption.batch_id == batch.id,
            PrepaidVoucherRedemption.reversed_at.is_(None),
        )
        .order_by(PrepaidVoucherRedemption.redeemed_at)
        .all()
    )
    taken: Dict[str, int] = defaultdict(int)
    forfeited: Dict[str, int] = defaultdict(int)
    for r in redemptions:
        for row in r.items or []:
            taken[str(row.get("productId"))] += int(row.get("quantity") or 0)
        for row in r.forfeited or []:
            forfeited[str(row.get("productId"))] += int(row.get("quantity") or 0)

    products = [
        {
            "productId": pid,
            "name": names.get(pid),
            "perVoucher": per_voucher.get(pid, 0),
            "issued": per_voucher.get(pid, 0) * int(stats.get("total", 0)),
            "taken": taken.get(pid, 0),
            "forfeited": forfeited.get(pid, 0),
            "outstanding": outstanding.get(pid, 0),
            "void": void.get(pid, 0),
        }
        for pid in order
    ]

    # ── Redemptions ──────────────────────────────────────────────────────────
    total = _Bucket()
    by_hour: Dict[int, _Bucket] = defaultdict(_Bucket)
    by_day: Dict[str, _Bucket] = defaultdict(_Bucket)
    day_products: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_shop: Dict[str, _Bucket] = defaultdict(_Bucket)
    by_till: Dict[str, _Bucket] = defaultdict(_Bucket)
    by_employee: Dict[str, _Bucket] = defaultdict(_Bucket)
    employee_names: Dict[str, Optional[str]] = {}
    till_shop: Dict[str, Optional[str]] = {}
    for r in redemptions:
        total.add(r)
        at = _utc(r.redeemed_at)
        local = at.astimezone(zone) if at is not None else None
        if local is not None:
            by_hour[local.hour].add(r)
            day = local.date().isoformat()
            by_day[day].add(r)
            for row in r.items or []:
                day_products[day][str(row.get("productId"))] += int(row.get("quantity") or 0)
        shop_key = str(r.shop_id) if r.shop_id else ""
        by_shop[shop_key].add(r)
        till_key = str(r.machine_id) if r.machine_id else ""
        by_till[till_key].add(r)
        till_shop.setdefault(till_key, shop_key or None)
        emp_key = (r.pos_user_id or "").strip() or (r.pos_user_name or "").strip()
        by_employee[emp_key].add(r)
        if r.pos_user_name:
            employee_names[emp_key] = r.pos_user_name

    shop_ids = [k for k in by_shop if k]
    shop_names = (
        {str(i): n for i, n in db.query(Shop.id, Shop.name).filter(Shop.id.in_([PV._as_uuid(s) for s in shop_ids]))}
        if shop_ids
        else {}
    )
    till_ids = [k for k in by_till if k]
    till_names = (
        {
            str(i): n
            for i, n in db.query(POSMachine.id, POSMachine.name).filter(
                POSMachine.id.in_([PV._as_uuid(t) for t in till_ids])
            )
        }
        if till_ids
        else {}
    )

    def ranked(buckets: Dict[str, _Bucket], label) -> List[Dict[str, Any]]:
        rows = [{"key": k or None, **label(k), **b.out(money)} for k, b in buckets.items()]
        return sorted(rows, key=lambda x: (-x["units"], -x["redemptions"], str(x.get("name") or "")))

    return {
        "batchId": str(batch.id),
        "timezone": tz_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "kind": batch.kind or "items",
        "usage": _usage(db, batch, stats, products, redemptions),
        "vouchers": stats,
        "products": products,
        "totals": total.out(money),
        "byHour": [{"hour": h, **by_hour[h].out(money)} for h in range(24) if h in by_hour],
        "byDay": [
            {
                "date": d,
                **by_day[d].out(money),
                "products": [
                    {"productId": pid, "name": names.get(pid), "quantity": day_products[d].get(pid, 0)}
                    for pid in order
                ],
            }
            for d in sorted(by_day)
        ],
        "byShop": ranked(by_shop, lambda k: {"name": shop_names.get(k)}),
        "byTill": ranked(
            by_till,
            lambda k: {"name": till_names.get(k), "shopName": shop_names.get(till_shop.get(k) or "")},
        ),
        "byEmployee": ranked(by_employee, lambda k: {"name": employee_names.get(k) or (k or None)}),
    }
