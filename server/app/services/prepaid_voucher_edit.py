"""
"ערוך סדרה" — every setting of a batch after it was set up, except its codes and serials.

The owner: "אין אפשרות לערוך סדרת שוברים קיימת — את ההגדרות אחרי שהקמתי. אני רוצה לתקן משהו".
A change is planned first (what changes, before → after, and what it touches), then applied:

* **free** — no warning: the name, for whom, the event, the order ref, the free text, the logo
  and the print settings. A reprint keeps the same codes.
* **validity** — the dates: every open voucher (unredeemed or partly redeemed).
* **where** — the shops and "מימוש ללא אינטרנט". A batch assigned to a device cannot lose that
  device's shop, nor stop allowing offline, while assigned; any change bumps the assignment's
  version, so the device downloads the batch again (the sync rules stay as they are).
* **rules** / **accounting** — vouchers per sale, the stacking, the discount-block policy,
  `redemption_accounting`, the pricing and its value, top-up: they apply to redemptions from now
  on (each redemption keeps the snapshot it was made with).
* **contents** — the goods, the groups, the discount's terms: they apply to the unredeemed
  vouchers, and to the partly redeemed ones only with `applyToPartial` ("החל גם על שוברים במימוש
  חלקי") — what a voucher already used stays used, the rest is the new contents less it.
* **quantity** — more vouchers are issued (the next serials); never fewer than were issued
  (cancel them instead).
* **price** — the production price, with the prices section only: it applies to the vouchers
  issued from now on (`production_price_history`, by serial — the settlement reads it).

The kind (goods / discount) and the company do not change: a new batch is made for that.
Every applied edit is one "update" line of the batch's log, with each change before → after.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

from fastapi import status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherBatchItem,
    PrepaidVoucherRedemption,
)
from app.models.user import User
from app.services import prepaid_voucher_rules as RULES

KIND_FIXED = "prepaid_voucher_kind_fixed"
COUNT_BELOW_ISSUED = "prepaid_voucher_count_below_issued"
COUNT_TOO_MANY = "prepaid_voucher_count_too_many"
OFFLINE_SHOP = "prepaid_voucher_offline_shop"
HOLDS_LIVE = "prepaid_voucher_holds_live"

FREE, VALIDITY, WHERE, RULES_OF_USE, ACCOUNTING, CONTENTS, QUANTITY, PRICE = (
    "free", "validity", "where", "rules", "accounting", "contents", "quantity", "price",
)
#: The wire name of each editable setting, and its category (the order the confirmation lists them in).
FIELDS: Tuple[Tuple[str, str], ...] = (
    ("name", FREE), ("customerName", FREE), ("eventName", FREE), ("orderRef", FREE), ("freeText", FREE),
    ("logoUrl", FREE), ("showItems", FREE), ("showValidity", FREE), ("showCredit", FREE), ("showCode", FREE),
    ("barcodeType", FREE), ("printTillValue", FREE), ("productionId", FREE), ("reportEventId", FREE),
    ("validFrom", VALIDITY), ("validUntil", VALIDITY),
    ("shopIds", WHERE), ("offlineAllowed", WHERE),
    ("stacking", RULES_OF_USE), ("maxVouchersPerSale", RULES_OF_USE), ("promotionPolicy", RULES_OF_USE),
    ("maxUsesPerSale", RULES_OF_USE), ("maxUsesPerDay", RULES_OF_USE),
    ("redemptionAccounting", ACCOUNTING), ("discountBlockPolicy", ACCOUNTING), ("pricing", ACCOUNTING),
    ("tillValue", ACCOUNTING), ("allowTopUp", ACCOUNTING),
    ("items", CONTENTS), ("includeExtras", CONTENTS), ("splitAllowed", CONTENTS), ("discountType", CONTENTS),
    ("discountValue", CONTENTS), ("minPurchase", CONTENTS), ("maxDiscount", CONTENTS), ("maxUnits", CONTENTS),
    ("targets", CONTENTS), ("usesPerVoucher", CONTENTS), ("selection", CONTENTS), ("groups", CONTENTS),
    ("totalQty", CONTENTS), ("catalogMode", CONTENTS),
    ("count", QUANTITY),
    ("productionPrice", PRICE),
)
CATEGORY = dict(FIELDS)
#: Stored money (agorot) on the batch; ₪ in the schema and on the wire.
_MONEY = ("till_value", "production_price", "min_purchase", "max_discount", "discount_value")
#: Settings a body may send that are columns of the batch as they are (no conversion).
_PLAIN = (
    "name", "customer_name", "event_name", "order_ref", "free_text", "logo_url", "show_items", "show_validity",
    "show_credit", "show_code", "barcode_type", "print_till_value", "valid_from", "valid_until", "offline_allowed",
)
#: The terms, checked as a whole (the schema's `_check_terms` / `_check_prices`) over what the batch says.
_TERMS = (
    "till_value", "production_price", "pricing", "allow_top_up", "redemption_accounting", "print_till_value",
    "split_allowed", "include_extras", "discount_type", "discount_value", "min_purchase", "max_discount",
    "max_units", "stacking", "max_vouchers_per_sale", "promotion_policy", "uses_per_voucher", "max_uses_per_sale",
    "max_uses_per_day", "selection", "total_qty", "catalog_mode",
)
#: A discount's rules of use — a goods voucher has none (whatever came is left as it is).
_DISCOUNT_ONLY = ("promotion_policy", "max_uses_per_sale", "max_uses_per_day", "uses_per_voucher")
#: Never cleared by a null: a print setting or a rule always has a value.
_NOT_NULL = (
    "show_code", "show_items", "show_credit", "print_till_value", "barcode_type", "stacking", "promotion_policy",
    "max_uses_per_sale", "redemption_accounting", "show_validity", "offline_allowed", "pricing", "allow_top_up",
    "split_allowed", "include_extras", "uses_per_voucher", "selection", "catalog_mode", "count",
)


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _shekels(agorot: Optional[int]) -> Optional[Decimal]:
    return None if agorot is None else Decimal(int(agorot)) / 100


def _agorot(amount) -> Optional[int]:
    from app.services.prepaid_voucher_types import _agorot as to_agorot

    return to_agorot(amount)


# ── The batch as the edit reads it ────────────────────────────────────────────


def _items_view(items) -> List[Dict[str, Any]]:
    PV = _pv()
    return [
        {"productId": str(i.product_id), "name": i.product_name, "quantity": PV.qty_out(i.quantity),
         "unitLabel": getattr(i, "unit_label", None)}
        for i in items
    ]


def _groups_view(groups) -> Optional[List[Dict[str, Any]]]:
    from app.services import production_voucher_groups as PG

    return PG.out_shekels(groups)


def view(b, *, prices: bool) -> Dict[str, Any]:
    """The editable settings of [b] (a batch, or a batch with the edit laid over it) on the wire."""
    PV = _pv()
    from app.services.prepaid_voucher_types import policy_out

    discount = (getattr(b, "kind", None) or "items") in RULES.DISCOUNT_KINDS
    targets = getattr(b, "targets", None) or {}
    out = {
        "name": b.name,
        "customerName": b.customer_name,
        "eventName": b.event_name,
        "orderRef": b.order_ref,
        "freeText": b.free_text,
        "logoUrl": b.logo_url,
        "showItems": b.show_items is not False,
        "showValidity": b.show_validity is not False,
        "showCredit": b.show_credit is not False,
        "showCode": bool(b.show_code),
        "barcodeType": b.barcode_type or "qr",
        "printTillValue": bool(b.print_till_value),
        "validFrom": PV._iso(b.valid_from),
        "validUntil": PV._iso(b.valid_until),
        "shopIds": sorted(str(s) for s in b.shop_ids) if b.shop_ids else None,
        "offlineAllowed": bool(b.offline_allowed),
        "stacking": b.stacking or "single",
        "maxVouchersPerSale": b.max_vouchers_per_sale if (b.stacking or "single") != "single" else None,
        "promotionPolicy": b.promotion_policy or "exclude",
        "maxUsesPerSale": int(b.max_uses_per_sale or 1),
        "maxUsesPerDay": b.max_uses_per_day,
        "redemptionAccounting": b.redemption_accounting or "zero",
        "discountBlockPolicy": policy_out(b),
        "pricing": b.pricing or "cover",
        "tillValue": PV._shekels_out(b.till_value),
        "allowTopUp": b.allow_top_up is not False,
        "items": [] if discount else _items_view(b.items),
        "includeExtras": bool(b.include_extras),
        "splitAllowed": bool(b.split_allowed),
        "discountType": b.discount_type if discount else None,
        "discountValue": PV._shekels_out(b.discount_value) if discount else None,
        "minPurchase": PV._shekels_out(b.min_purchase),
        "maxDiscount": PV._shekels_out(b.max_discount),
        "maxUnits": b.max_units,
        "targets": (
            {"productIds": sorted(targets.get("productIds") or []), "categoryIds": sorted(targets.get("categoryIds") or []),
             "names": list(targets.get("names") or [])}
            if b.kind == "item_discount" else None
        ),
        "usesPerVoucher": int(b.uses_per_voucher or 1),
        "selection": b.selection or "items",
        "groups": _groups_view(b.groups),
        "totalQty": b.total_qty,
        "catalogMode": b.catalog_mode or "frozen",
        "count": int(b.next_serial or 1) - 1,
        "productionId": str(b.production_id) if getattr(b, "production_id", None) else None,
        "reportEventId": str(b.report_event_id) if getattr(b, "report_event_id", None) else None,
    }
    if prices:
        out["productionPrice"] = PV._shekels_out(b.production_price)
    return out


def _same(field: str, a: Any, b: Any) -> bool:
    if field == "items":
        key = lambda rows: sorted((r["productId"], str(r["quantity"])) for r in rows or [])  # noqa: E731
        return key(a) == key(b)
    if field == "targets":
        strip = lambda t: None if t is None else {k: v for k, v in t.items() if k != "names"}  # noqa: E731
        return strip(a) == strip(b)
    return a == b


class _Overlay:
    """[batch] with the edit's columns over it — read only, for the plan's "after"."""

    def __init__(self, batch: PrepaidVoucherBatch, cols: Dict[str, Any], items=None):
        self._batch, self._cols, self._items = batch, cols, items

    def __getattr__(self, name):
        if name == "items" and self._items is not None:
            return self._items
        if name in self._cols:
            return self._cols[name]
        return getattr(self._batch, name)


def _status_counts(db: Session, batch_id) -> Dict[str, int]:
    rows = (
        db.query(PrepaidVoucher.status, func.count(PrepaidVoucher.id))
        .filter(PrepaidVoucher.batch_id == batch_id)
        .group_by(PrepaidVoucher.status)
        .all()
    )
    return {s: int(n) for s, n in rows}


# ── The plan ──────────────────────────────────────────────────────────────────


def _merged_terms(batch: PrepaidVoucherBatch, body, given: set) -> SimpleNamespace:
    """The batch's terms in the schema's units (₪), with what the body sent over them."""
    m = SimpleNamespace(kind=batch.kind or "items")
    for f in _TERMS:
        v = getattr(batch, f)
        setattr(m, f, _shekels(v) if f in _MONEY else v)
    m.items = [SimpleNamespace(product_id=i.product_id, quantity=i.quantity) for i in batch.items]
    t = batch.targets or None
    m.targets = (
        SimpleNamespace(product_ids=[uuid.UUID(p) for p in t.get("productIds") or []],
                        category_ids=[uuid.UUID(c) for c in t.get("categoryIds") or []])
        if t else None
    )
    m.groups = list(batch.groups or [])
    for f in _TERMS + ("items", "targets", "groups"):
        if f not in given:
            continue
        v = getattr(body, f)
        if v is None and f in _NOT_NULL:
            continue
        setattr(m, f, v)
    if m.items is None:
        m.items = []
    return m


def plan_edit(db: Session, user: User, tenant_id, batch: PrepaidVoucherBatch, body) -> Dict[str, Any]:
    """
    What [body] changes on [batch] — checked as a whole, nothing written: `changes` (each setting
    before → after, its category), `effects` (what each category touches) and `columns` / `items`
    / `issue` / `refits` for [apply_edit]. Refused (HTTP) where a rule says no.
    """
    PV = _pv()
    from app.schemas.prepaid_voucher import MAX_VOUCHERS_PER_BATCH, _check_prices, _check_terms
    from app.services import prepaid_voucher_offline as PVO
    from app.services import prepaid_voucher_types as PVT

    given = set(body.model_fields_set) - {"apply_to_partial"}
    discount = PV.is_discount(batch)
    if not discount:
        given -= set(_DISCOUNT_ONLY)
    prices = PVT.prices_visible(db, user)
    if "production_price" in given:
        PVT._require_prices(db, user)
    if "kind" in given and body.kind is not None and body.kind != (batch.kind or "items"):
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, KIND_FIXED)

    cols: Dict[str, Any] = {}
    for f in _PLAIN:
        if f in given:
            v = getattr(body, f)
            if v is None and (f in _NOT_NULL or f == "name"):
                continue
            cols[f] = v
    if "name" in cols and not cols["name"]:
        cols.pop("name")
    # The production (its name becomes the batch's `customer_name`) and the event (§13).
    if "production_id" in given:
        from app.services import prepaid_productions as PPR

        if body.production_id is None:
            cols["production_id"] = None
        else:
            production = PPR.production_for_batch(db, tenant_id, body.production_id, batch.company_id, user)
            cols["production_id"] = production.id
            cols["customer_name"] = production.name
    if "report_event_id" in given:
        from app.services import prepaid_productions as PPR

        cols["report_event_id"] = (
            None if body.report_event_id is None
            else PPR.event_for_batch(db, tenant_id, body.report_event_id, batch.company_id, user).id
        )
    vf, vu = cols.get("valid_from", batch.valid_from), cols.get("valid_until", batch.valid_until)
    if vf and vu and PV._utc(vu) <= PV._utc(vf):
        raise PV._http(status.HTTP_400_BAD_REQUEST, "validUntil must be after validFrom")

    # Where: the shops (checked as at setup), and a device the batch is assigned to.
    shop_ids = batch.shop_ids
    if "shop_ids" in given:
        shop_ids = PV._validate_shops(db, user, tenant_id, batch.company_id, body.shop_ids)
        if not shop_ids and not PV._covers_company(db, user, batch.company_id):
            raise PV._http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)  # a shop manager: their own shops only
        cols["shop_ids"] = shop_ids
    assignment = PVO.active_of(db, batch.id)
    if assignment is not None:
        if cols.get("offline_allowed") is False:
            raise PV._http(status.HTTP_409_CONFLICT, PVO.OFFLINE_ASSIGNED)
        if shop_ids and assignment.shop_id is not None and str(assignment.shop_id) not in {str(s) for s in shop_ids}:
            raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_SHOP)

    # The terms, checked as a whole over what the batch says.
    terms_given = given & set(_TERMS + ("items", "targets", "groups"))
    items = None
    if terms_given or "shop_ids" in given:
        m = _merged_terms(batch, body, given)
        if discount:
            m.items = []
        try:
            _check_terms(m)
            _check_prices(m, one_off=False)
        except ValueError as exc:
            raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
        # The goods, the targets and the groups are checked again only when they (or the shops)
        # change: a product that became unusable since never blocks an unrelated edit (the rules,
        # the accounting) — the redemption refuses it as ever (`prepaid_voucher_item_unusable`).
        was_groups = (batch.selection or "items") == "groups"
        if not discount and m.selection != "groups":
            if {"items", "shop_ids", "selection"} & given:
                products = PV._validate_products(db, tenant_id, batch.company_id, m.items, shop_ids=shop_ids)
                items = [
                    SimpleNamespace(product_id=p.id, product_name=p.name, quantity=PV.qty(i.quantity),
                                    weighed=bool(p.is_weighed),
                                    unit_label=((p.unit_label or PV.DEFAULT_WEIGHT_UNIT) if p.is_weighed else None))
                    for i, p in zip(m.items, products)
                ]
        elif not discount and not was_groups:
            items = []  # from a fixed list to groups: the list goes
        for f in _TERMS:
            v = getattr(m, f)
            cols[f] = _agorot(v) if f in _MONEY else v
        if batch.kind == "item_discount":
            if m.targets is not None and {"targets", "shop_ids"} & given:
                cols["targets"] = PV._validate_targets(db, tenant_id, batch.company_id, m.targets, shop_ids=shop_ids)
        else:
            cols["targets"] = None
        if not discount and m.selection == "groups":
            if {"groups", "catalog_mode", "selection", "shop_ids"} & given:
                from app.services import production_voucher_groups as PG

                stored = PG.stored(m.groups) if "groups" in given else list(batch.groups or [])
                PG.validate(db, tenant_id, batch.company_id, stored or [])
                if {"groups", "catalog_mode", "selection"} & given:
                    stored = PG.freeze(db, tenant_id, batch.company_id, stored) if m.catalog_mode == "frozen" else stored
                cols["groups"] = stored
        else:
            cols["groups"] = None
        if discount:
            cols.update(redemption_accounting="discount", discount_block_policy="honour", split_allowed=False,
                        include_extras=False)
        if "production_price" not in given:
            cols.pop("production_price", None)  # never rewritten in passing (nor by whoever cannot see it)
    if "discount_block_policy" in given and not discount:
        cols.update(PVT.policy_columns(db, user, tenant_id, body.discount_block_policy))
    if (cols.get("stacking") or batch.stacking) == "single":
        cols["max_vouchers_per_sale"] = None  # "שובר אחד בעסקה" is its own maximum

    # Quantity: more is issued; never fewer than were.
    issued = int(batch.next_serial or 1) - 1
    issue = 0
    if "count" in given and body.count is not None:
        if body.count < issued:
            raise PV._http(status.HTTP_409_CONFLICT, COUNT_BELOW_ISSUED)
        issue = body.count - issued
        if issue > MAX_VOUCHERS_PER_BATCH:
            raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, COUNT_TOO_MANY)

    before = view(batch, prices=prices)
    after_cols = dict(cols, next_serial=int(batch.next_serial or 1) + issue)
    after = view(_Overlay(batch, after_cols, items), prices=prices)
    changes = [
        {"field": f, "category": cat, "before": before.get(f), "after": after.get(f)}
        for f, cat in FIELDS
        if f in after and f in before and not _same(f, before.get(f), after.get(f))
    ]
    _name_refs(db, changes)
    changed = {c["category"] for c in changes}
    if batch.status == "cancelled" and changed - {FREE}:
        raise PV._http(status.HTTP_409_CONFLICT, PV.BATCH_CANCELLED)
    if CONTENTS in changed:
        from app.models.prepaid_voucher import PrepaidVoucherReservation

        live = [r for r in db.query(PrepaidVoucherReservation).filter(
            PrepaidVoucherReservation.batch_id == batch.id, PrepaidVoucherReservation.status == "held")
            if PV._reservation_live(r, PV._now())]
        if live:
            # An open sale holds a voucher by the old contents: change them once it is done (review 09.10).
            raise PV._http(status.HTTP_409_CONFLICT, HOLDS_LIVE)

    counts = _status_counts(db, batch.id)
    open_n = counts.get("active", 0) + counts.get("partially_used", 0)
    apply_partial = bool(getattr(body, "apply_to_partial", False))
    effects: Dict[str, Any] = {}
    if FREE in changed:
        effects[FREE] = {"reprintSameCodes": True}
    for cat in (VALIDITY, WHERE, RULES_OF_USE, ACCOUNTING):
        if cat in changed:
            effects[cat] = {"vouchers": open_n}
    if WHERE in changed and assignment is not None:
        effects[WHERE]["offlineAssigned"] = True
    if CONTENTS in changed:
        effects[CONTENTS] = {
            "unredeemed": counts.get("active", 0), "partial": counts.get("partially_used", 0),
            "applyToPartial": apply_partial,
            "vouchers": counts.get("active", 0) + (counts.get("partially_used", 0) if apply_partial else 0),
        }
    if QUANTITY in changed:
        effects[QUANTITY] = {"issued": issued, "issue": issue}
    if PRICE in changed:
        effects[PRICE] = {"fromSerial": int(batch.next_serial or 1), "issued": issued}
    return {
        "changes": changes,
        "effects": effects,
        "confirm": bool(changed - {FREE}),
        # For apply_edit.
        "_columns": cols,
        "_items": items,
        "_issue": issue,
        "_refit": CONTENTS in changed,
        "_apply_partial": apply_partial,
        "_assignment": assignment,
        "_categories": changed,
    }


def _name_refs(db: Session, changes: List[Dict[str, Any]]) -> None:
    """A production's / an event's id on either side of a change, as `{id, name}` (the confirmation reads names)."""
    from app.models.prepaid_voucher import PrepaidProduction
    from app.models.report_event import ReportEvent

    PV = _pv()
    for c in changes:
        model = {"productionId": PrepaidProduction, "reportEventId": ReportEvent}.get(c["field"])
        if model is None:
            continue
        for side in ("before", "after"):
            if c[side]:
                row = db.get(model, PV._as_uuid(c[side]))
                c[side] = {"id": c[side], "name": row.name if row is not None else None}


def plan_out(plan: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in plan.items() if not k.startswith("_")}


# ── Applying it ───────────────────────────────────────────────────────────────


def _initial(batch: PrepaidVoucherBatch) -> Dict[str, Decimal]:
    """What a voucher of [batch] starts with: per product (goods), per group and "total" (groups)."""
    PV = _pv()
    if (batch.selection or "items") == "groups":
        from app.services import production_voucher_groups as PG

        return {k: Decimal(v) for k, v in PG.initial_remaining(batch.groups or [], batch.total_qty).items()}
    return {str(i.product_id): PV.qty(i.quantity) for i in batch.items}


def _used(db: Session, vouchers: List[PrepaidVoucher], groups: bool) -> Dict[str, Dict[str, Decimal]]:
    """
    What each voucher already used, from its redemptions (never the reversed ones) — the truth
    whatever contents it was on: per product (goods), per group and "total" (groups, in pieces),
    and the uses (`"uses"`, a discount).
    """
    PV = _pv()
    from app.services.production_voucher_reserve import _pieces

    out: Dict[str, Dict[str, Decimal]] = {str(v.id): {} for v in vouchers}
    if not vouchers:
        return out
    rows = (
        db.query(PrepaidVoucherRedemption)
        .filter(PrepaidVoucherRedemption.voucher_id.in_([v.id for v in vouchers]),
                PrepaidVoucherRedemption.reversed_at.is_(None))
        .all()
    )
    zero = Decimal(0)
    for r in rows:
        used = out.setdefault(str(r.voucher_id), {})
        used["uses"] = used.get("uses", zero) + Decimal(int(r.uses or 1))
        if groups:
            for u in r.units or []:
                if not isinstance(u, dict) or not u.get("groupKey"):
                    continue
                q = _pieces(PV.qty(u.get("quantity") or 1))
                used[f"g:{u['groupKey']}"] = used.get(f"g:{u['groupKey']}", zero) + q
                used["total"] = used.get("total", zero) + q
        else:
            for it in (r.items or r.units or []):
                if isinstance(it, dict) and it.get("productId"):
                    pid = str(it["productId"])
                    used[pid] = used.get(pid, zero) + PV.qty(it.get("quantity") or 0)
    return out


def _refit(db: Session, batch: PrepaidVoucherBatch, apply_partial: bool) -> Dict[str, int]:
    """
    The new contents onto the open vouchers: an unredeemed one starts again from them; a partly
    redeemed one (only with [apply_partial]) gets them less what it already used — never below 0.
    """
    PV = _pv()
    statuses = ["active", "partially_used"] if apply_partial else ["active"]
    rows = (
        db.query(PrepaidVoucher)
        .filter(PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.status.in_(statuses))
        .with_for_update()
        .all()
    )
    out = {"unredeemed": 0, "partial": 0}
    groups = (batch.selection or "items") == "groups"
    used_of = _used(db, rows, groups)
    discount = PV.is_discount(batch)
    new_initial = {} if discount else _initial(batch)
    zero = Decimal(0)
    for v in rows:
        used = used_of.get(str(v.id), {})
        out["partial" if v.status == "partially_used" else "unredeemed"] += 1
        if discount:
            v.uses_left = max(0, int(batch.uses_per_voucher or 1) - int(used.get("uses", zero)))
            nothing = v.uses_left == 0
        else:
            left = {k: max(zero, q - used.get(k, zero)) for k, q in new_initial.items()}
            # A new dict (JSON columns only notice reassignment); ints stay ints, a weight "0.25".
            v.remaining = {k: PV.qty_out(q) for k, q in left.items()}
            nothing = (left.get("total", zero) <= 0) if groups else not any(q > 0 for q in left.values())
        if nothing:
            v.status = "used"
        v.updated_at = PV._now()
    return out


def production_price_of(batch: PrepaidVoucherBatch, serial: int) -> Optional[int]:
    """The production price (agorot) a voucher of [batch] was issued at: the history by serial, else the batch's."""
    history = getattr(batch, "production_price_history", None) or []
    price = batch.production_price
    for h in sorted(history, key=lambda x: int(x.get("fromSerial") or 1)):
        if int(h.get("fromSerial") or 1) <= int(serial):
            price = h.get("priceAgorot")
    return price


def column_of(field: str) -> str:
    """"maxVouchersPerSale" → "max_vouchers_per_sale": the log's `fields`, as the batch's columns."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", field).lower()


def _jsonable(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def apply_edit(db: Session, user: User, tenant_id, batch: PrepaidVoucherBatch, body) -> Dict[str, Any]:
    """[plan_edit], then written: the columns, the goods, the vouchers' contents, more vouchers, the log."""
    PV = _pv()
    plan = plan_edit(db, user, tenant_id, batch, body)
    if not plan["changes"]:
        return plan
    cols = plan["_columns"]
    now = PV._now()
    if PRICE in plan["_categories"]:
        history = list(batch.production_price_history or [])
        if not history:
            history.append({"fromSerial": 1, "priceAgorot": batch.production_price, "at": PV._iso(batch.created_at)})
        start = int(batch.next_serial or 1)
        if history[-1].get("fromSerial") == start and len(history) > 1:
            history.pop()  # changed again before any voucher was issued at it: the last word stands
        history.append({"fromSerial": start, "priceAgorot": cols.get("production_price"),
                        "at": PV._iso(now), "by": PV._user_name(user)})
        batch.production_price_history = history
    for f, v in cols.items():
        if getattr(batch, f) != v:
            setattr(batch, f, v)
    if plan["_items"] is not None and any(c["field"] == "items" for c in plan["changes"]):
        for old in list(batch.items):
            db.delete(old)
        db.flush()
        batch.items = [
            PrepaidVoucherBatchItem(
                id=uuid.uuid4(), product_id=i.product_id, product_name=i.product_name, quantity=i.quantity,
                weighed=i.weighed, unit_label=i.unit_label, sort_order=n,
            )
            for n, i in enumerate(plan["_items"])
        ]
        db.flush()
    refit = None
    if plan["_refit"]:
        refit = _refit(db, batch, plan["_apply_partial"])
    issued: List[PrepaidVoucher] = []
    if plan["_issue"]:
        issued = PV._issue(db, batch, plan["_issue"], batch.group_size)
    assignment = plan["_assignment"]
    if assignment is not None and plan["_categories"] - {FREE}:
        # The device downloads the batch again (its version moved); what it redeemed meanwhile syncs as ever.
        assignment.version = int(assignment.version or 1) + 1
    batch.updated_at = now
    secret = {"productionPrice"}
    details = {
        "fields": sorted(column_of(c["field"]) for c in plan["changes"]),
        "changes": [
            {**{k: _jsonable(v) for k, v in c.items()}, **({"secret": "prices"} if c["field"] in secret else {})}
            for c in plan["changes"]
        ],
        "effects": plan["effects"],
        "applyToPartial": plan["_apply_partial"],
    }
    if refit is not None:
        details["refit"] = refit
    PV._event(db, batch, user, "update", details=details)
    if issued:
        PV._event(db, batch, user, "add", count=len(issued), details=PV._issued_details(issued, batch.group_size))
    db.flush()
    return plan


def strip_secret(details: Dict[str, Any]) -> Dict[str, Any]:
    """An "update" line's details for whoever may not see the production price: its values left out."""
    changes = details.get("changes")
    if not isinstance(changes, list):
        return details
    return {**details, "changes": [
        {k: v for k, v in c.items() if k not in ("before", "after")} if isinstance(c, dict) and c.get("secret") else c
        for c in changes
    ]}
