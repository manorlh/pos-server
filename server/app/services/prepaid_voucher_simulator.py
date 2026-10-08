"""
Production vouchers — the simulator before issue (the spec's §18.1). Read-only: nothing is issued,
held, redeemed or written.

The manager picks a voucher type (or an issued batch) and a sample basket — products from the
catalog, quantities, and optionally the shop / till whose prices count — and sees, per unit, what a
redemption would do, by the same rules the cloud redeems with (`production_voucher_rules`, the
golden-pinned engine; `prepaid_voucher_rules` for discount kinds):

1. **Eligibility** — on the voucher or not; can the product still be handed over (the general item,
   another company …, `usability`), and why not.
2. **Assignment** — each unit to a part of the voucher (`assign_units`): taken, not eligible, its part
   full, the voucher full, or ambiguous (the cashier would be asked).
3. **Selection** — the redemption as a whole (`check_selection`): one of N, a part over, a package
   incomplete ("חסר משקה להשלמת…") with `wholeAtOnce`.
4. **Price** — `fixed`: the value split between the units to the agora (`split_value`), each unit's
   reduction and whether it is forced on a "לא מקבל הנחות" product under the policy (`override_check`,
   with or without a manager's approval); `cover`: what the voucher pays and the customer's top-up
   (`cover`); a discount kind: what it takes off (`discount_for`).
5. **Booking** — what the document would show in the voucher's accounting mode (deduction / tender / ₪0).
6. **Now** — for a batch: whether it is paused, at its quota, or a test batch.

A type / batch with groups (`selection` groups) is simulated by its groups (a batch's frozen lists, a
type's selection against the catalog of now, each group's fixed value per unit); a fixed list makes each
product a part of its own with its quantity (min = max, or min 0 when the voucher may be redeemed in
parts). The production price is never part of a simulation.
"""
from __future__ import annotations

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional, Tuple

from fastapi import status
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User
from app.services import prepaid_voucher_extras_access as ACC
from app.services import production_voucher_rules as PR

NEED_TERMS = "prepaid_voucher_simulate_terms_required"
NO_LINES = "prepaid_voucher_simulate_no_lines"
PRODUCT_UNKNOWN = "prepaid_voucher_simulate_product_unknown"

UNIT_TEXT = {
    "assigned": "נכלל בשובר",
    PR.UNIT_NOT_ELIGIBLE: "הפריט אינו כלול בשובר זה",
    PR.UNIT_GROUP_FULL: "החלק הזה של השובר כבר מלא",
    PR.UNIT_TOTAL_FULL: "השובר כבר מלא",
    "ambiguous": "הפריט מתאים לכמה חלקים — הקופאי יתבקש לבחור",
    "unusable": "לא ניתן למסור את הפריט בשובר",
}
BOOKING_TEXT = {
    "discount": "קיזוז מהחשבונית (כמו הנחה)",
    "payment": "אמצעי תשלום \"שובר הפקה\"",
    "zero": "שורות ₪0 עם הצגת שווי",
}


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _agorot(value) -> int:
    return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _terms(db: Session, user: User, tenant_id, body):
    """The type or batch to simulate, and whether it is an issued batch."""
    PV = _pv()
    if body.batch_id is not None:
        return PV.get_batch(db, user, tenant_id, body.batch_id), True
    if body.type_id is not None:
        from app.services import prepaid_voucher_types as PVT

        return PVT.get_type(db, user, tenant_id, body.type_id), False
    raise ACC.http(status.HTTP_400_BAD_REQUEST, NEED_TERMS)


def _shop(db: Session, tenant_id, body) -> Optional[uuid.UUID]:
    if body.machine_id is not None:
        m = db.query(POSMachine).filter(POSMachine.id == body.machine_id, POSMachine.tenant_id == tenant_id).first()
        return m.shop_id if m is not None else None
    if body.shop_id is not None:
        s = db.query(Shop.id).filter(Shop.id == body.shop_id, Shop.tenant_id == tenant_id).scalar()
        return s
    return None


def _ancestors(db: Session, tenant_id, category_id) -> Tuple[str, ...]:
    parents = {str(c): str(p) if p else None for c, p in db.query(Category.id, Category.parent_id).filter(
        Category.tenant_id == tenant_id)}
    out: List[str] = []
    cur = str(category_id) if category_id else None
    while cur and cur not in out:
        out.append(cur)
        cur = parents.get(cur)
    return tuple(out)


def _policy(terms) -> PR.OverridePolicy:
    scope = getattr(terms, "override_scope", None) or None
    return PR.OverridePolicy(
        mode=getattr(terms, "discount_block_policy", None) or "honour",
        max_amount=getattr(terms, "override_max_amount", None),
        max_percent=getattr(terms, "override_max_percent", None),
        max_total=getattr(terms, "override_max_total", None),
        scope_product_ids=tuple(str(p) for p in (scope or {}).get("productIds") or []) if scope else None,
        scope_category_ids=tuple(str(c) for c in (scope or {}).get("categoryIds") or []) if scope else None,
    )


def _refusal(r: Optional[PR.Refusal]) -> Optional[Dict[str, Any]]:
    return {"code": r.code, "text": r.text, "groupKey": r.group_key} if r is not None else None


def simulate(db: Session, user: User, tenant_id, body) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    terms, is_batch = _terms(db, user, tenant_id, body)
    if not body.lines:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, NO_LINES)
    shop_id = _shop(db, tenant_id, body)
    ids = [line.product_id for line in body.lines]
    products = {str(p.id): p for p in db.query(Product).filter(Product.id.in_(ids), Product.tenant_id == tenant_id)}
    if len({str(i) for i in ids} - set(products)):
        raise ACC.http(status.HTTP_400_BAD_REQUEST, PRODUCT_UNKNOWN)
    overrides = {
        str(o.global_product_id): o for o in db.query(ShopProductOverride).filter(
            ShopProductOverride.shop_id == shop_id, ShopProductOverride.global_product_id.in_(ids))
    } if shop_id else {}

    def price_of(line) -> int:
        if line.price is not None:
            return _agorot(line.price)
        o = overrides.get(str(line.product_id))
        if o is not None and o.price is not None:
            return _agorot(o.price)
        p = products[str(line.product_id)]
        return _agorot(p.price or 0)

    kind = getattr(terms, "kind", None) or "items"
    accounting = "discount" if kind != "items" else (getattr(terms, "redemption_accounting", None) or "zero")
    controls = None
    if is_batch:
        from app.services import prepaid_voucher_controls as CTL

        if CTL.tables_ready(db):
            p = CTL.active_pause(db, terms)
            q = CTL.reached_quota(db, terms, None, lock=False)
            controls = {
                "test": CTL.is_test(db, terms.id),
                "paused": CTL.pause_text(db, p) if p is not None else None,
                "quota": CTL.quota_text(db, q) if q is not None else None,
            }
    head = {
        "source": "batch" if is_batch else "type",
        "id": str(terms.id),
        "name": terms.name,
        "kind": kind,
        "pricing": getattr(terms, "pricing", None) or "cover",
        "tillValueAgorot": getattr(terms, "till_value", None),
        "allowTopUp": getattr(terms, "allow_top_up", None) is not False,
        "redemptionAccounting": accounting,
        "bookingText": BOOKING_TEXT.get(accounting),
        "policy": _policy(terms).mode,
        "wholeAtOnce": not bool(getattr(terms, "split_allowed", False)),
        "controls": controls,
        "shopId": str(shop_id) if shop_id else None,
    }
    if kind != "items":
        return {**head, **_simulate_discount(db, terms, body, products, price_of)}
    return {**head, **_simulate_goods(db, terms, body, products, price_of, accounting)}


def _simulate_discount(db: Session, terms, body, products, price_of) -> Dict[str, Any]:
    from app.services import prepaid_voucher_rules as RULES

    PV = _pv()
    base = RULES.benefit_of(terms)
    cats = PV._expanded_categories(db, terms.tenant_id, (terms.targets or {}).get("categoryIds") or [])
    benefit = RULES.Benefit(**{**base.__dict__, "category_ids": frozenset(cats)})
    lines = []
    for n, line in enumerate(body.lines):
        p = products[str(line.product_id)]
        unit = price_of(line)
        lines.append(RULES.BasketLine(
            id=f"l{n + 1}", product_ids=(str(p.id),), category_ids=(str(p.category_id),) if p.category_id else (),
            quantity=float(line.quantity), gross=int(round(unit * float(line.quantity))),
            promotion=_agorot(line.promotion) if line.promotion else 0,
            discountable=not bool(getattr(p, "no_discount", False)),
            weighed=bool(getattr(p, "is_weighed", False)),
            general=bool(getattr(p, "is_general", False)),
        ))
    result = RULES.discount_for(benefit, lines, 1)
    shares = dict(result.shares)
    skipped = dict(result.skipped)
    units = []
    for n, line in enumerate(body.lines):
        lid = f"l{n + 1}"
        p = products[str(line.product_id)]
        units.append({
            "ref": lid, "productId": str(p.id), "productName": p.name, "quantity": float(line.quantity),
            "listPriceAgorot": price_of(line), "deductionAgorot": int(shares.get(lid, 0)),
            "status": "skipped" if lid in skipped else ("assigned" if shares.get(lid) else "none"),
            "reason": skipped.get(lid),
        })
    refusal = {"code": result.refusal, "text": None} if result.refusal else None
    return {
        "ok": refusal is None, "refusal": refusal, "units": units, "groups": [],
        "totals": {"listValueAgorot": sum(int(l.gross) for l in lines), "coveredAgorot": int(result.amount or 0),
                   "topUpAgorot": 0, "reductionAgorot": int(result.amount or 0)},
        "document": {"coveredAgorot": int(result.amount or 0), "tender": None, "deduction": "voucher_discount"},
        "dropPromotion": list(result.drop_promotion),
    }


def _simulate_goods(db: Session, terms, body, products, price_of, accounting: str) -> Dict[str, Any]:
    PV = _pv()
    split = bool(getattr(terms, "split_allowed", False))
    groups: List[PR.Group] = []
    caps: List[PR.GroupCap] = []
    group_values: Dict[str, Optional[int]] = {}
    stored = list(getattr(terms, "groups", None) or [])
    if (getattr(terms, "selection", None) or "items") == "groups" and stored:
        # The type's / batch's groups (the core's production_voucher_groups): a batch's frozen list,
        # a type's selection against the catalog of now.
        from app.services import production_voucher_groups as PG

        catalog = PG.catalog_of(db, terms.tenant_id, terms.company_id)
        for g in stored:
            ids = (PG.eligible(db, terms, g, catalog) if g.get("frozenProductIds") is not None
                   else PR.eligible_products(PG.selection_of(g), catalog))
            n = int(g.get("maxQty") or 1)
            groups.append(PR.Group(key=g["key"], name=g.get("name") or "", min_qty=int(g.get("minQty") or 0), max_qty=n,
                                   remaining=n, product_ids=tuple(ids), allow_repeat=bool(g.get("allowRepeat", True)),
                                   excluded_ids=tuple(g.get("excludeProductIds") or ())))
            caps.append(PR.GroupCap(key=g["key"], product_ids=tuple(ids), remaining=n))
            group_values[g["key"]] = g.get("valueAgorot")
        total = PG.total_max(stored, getattr(terms, "total_qty", None))
    else:
        # A fixed list: each product a part of its own, with its quantity.
        for it in terms.items:
            q = PV.qty(it.quantity)
            n = int(q) if q == q.to_integral_value() else 1
            key = str(it.product_id)
            groups.append(PR.Group(key=key, name=it.product_name, min_qty=0 if split else n, max_qty=n, remaining=n,
                                   product_ids=(key,), allow_repeat=True))
            caps.append(PR.GroupCap(key=key, product_ids=(key,), remaining=n))
        total = sum(g.max_qty for g in groups)
    # Which products can still be handed over (the redemption's own re-check).
    related = PV._related_companies(db, terms.company_id)
    group_set = PV._company_group(db, terms.company_id)
    unusable: Dict[str, Optional[str]] = {}
    for pid, p in products.items():
        facts = {"owner": PV._owner_shop(db, p)} if PV._is_own_product(p) else {}
        reason = PV.usability(p, tenant_id=terms.tenant_id, company_id=terms.company_id, related=related,
                              group=group_set, shop_ids=getattr(terms, "shop_ids", None), facts=facts)["goods"]
        unusable[pid] = reason if reason in PV._REDEMPTION_BLOCKS else None

    # Units: a line of 3 is three units; a weighed line one.
    units: List[Dict[str, Any]] = []
    for n, line in enumerate(body.lines):
        p = products[str(line.product_id)]
        q = Decimal(str(line.quantity))
        count = int(q) if q == q.to_integral_value() else 1
        unit_price = price_of(line) if q == q.to_integral_value() else int(round(price_of(line) * float(q)))
        for k in range(count):
            units.append({
                "ref": f"l{n + 1}#{k + 1}", "productId": str(p.id), "productName": p.name,
                "quantity": 1 if q == q.to_integral_value() else float(q),
                "listPriceAgorot": unit_price, "noDiscount": bool(getattr(p, "no_discount", False)),
                "categoryIds": _ancestors(db, terms.tenant_id, p.category_id),
            })
    eligible_units = [u for u in units if not unusable.get(u["productId"])]
    assignment = PR.assign_units(caps, [(u["ref"], u["productId"]) for u in eligible_units], total)
    names = {g.key: g.name for g in groups}
    for u in units:
        if unusable.get(u["productId"]):
            u.update(status="unusable", reason=unusable[u["productId"]])
        elif u["ref"] in assignment.assigned:
            key = assignment.assigned[u["ref"]]
            u.update(status="assigned", groupKey=key, groupName=names.get(key), reason=None)
        else:
            why = dict(assignment.unassigned).get(u["ref"])
            amb = dict(assignment.ambiguous).get(u["ref"])
            u.update(status="ambiguous" if amb else why, reason=why, groupKeys=list(amb) if amb else None)
        u["statusText"] = UNIT_TEXT.get(u["status"], u["status"])
    taken = [u for u in units if u["status"] == "assigned"]
    chosen: Dict[Tuple[str, str], int] = {}
    for u in taken:
        chosen[(u["productId"], u["groupKey"])] = chosen.get((u["productId"], u["groupKey"]), 0) + 1
    refusal = PR.check_selection(
        groups, [(pid, key, q) for (pid, key), q in chosen.items()], total_max=total, total_remaining=total,
        whole_at_once=not split, type_name=getattr(terms, "type_name", None) or terms.name,
    )
    pricing = getattr(terms, "pricing", None) or "cover"
    value = getattr(terms, "till_value", None)
    note = None
    covered = top_up = reduction_total = 0
    needs_approval = False
    if taken:
        lists = [int(u["listPriceAgorot"]) for u in taken]
        if pricing == "fixed" and value is not None:
            share = PR.fixed_share(int(value), len(taken), total) if split else int(value)
            values = PR.split_value(share, [(lp, group_values.get(u.get("groupKey"))) for u, lp in zip(taken, lists)])
            if values is None:
                refusal = refusal or PR.Refusal(PR.VALUE_MISMATCH, PR.TEXT[PR.VALUE_MISMATCH])
                values = lists
            check = PR.override_check(_policy(terms), [
                PR.PricedUnit(ref=u["ref"], product_id=u["productId"], category_ids=tuple(u["categoryIds"]),
                              no_discount=u["noDiscount"], list_price=int(u["listPriceAgorot"]), value=int(v))
                for u, v in zip(taken, values)
            ], bool(body.approved))
            per = {ref: (red, forced) for ref, red, forced in check.units}
            needs_approval = check.needs_approval
            refusal = refusal or check.refusal
            for u, v in zip(taken, values):
                red, forced = per.get(u["ref"], (0, False))
                u.update(valueAgorot=int(v), reductionAgorot=int(red), forced=bool(forced))
                u["coveredAgorot"] = int(v) if accounting == "payment" else (int(u["listPriceAgorot"]) if accounting == "discount" else 0)
            covered = sum(u["coveredAgorot"] for u in taken)
            reduction_total = sum(u["reductionAgorot"] for u in taken)
        else:
            c = PR.cover(value, lists, getattr(terms, "allow_top_up", None) is not False)
            refusal = refusal or c.refusal
            note = c.note
            for u, part in zip(taken, c.per_unit):
                u.update(valueAgorot=int(part), reductionAgorot=0, forced=False,
                         coveredAgorot=int(part) if accounting != "zero" else 0)
            covered = c.covered if accounting != "zero" else 0
            top_up = c.top_up
    for u in units:
        u.pop("categoryIds", None)
    return {
        "ok": refusal is None and bool(taken),
        "refusal": _refusal(refusal) or (None if taken else {"code": PR.NOTHING_CHOSEN, "text": PR.TEXT[PR.NOTHING_CHOSEN], "groupKey": None}),
        "needsApproval": needs_approval,
        "note": note,
        "groups": [
            {"key": g.key, "name": g.name, "minQty": g.min_qty, "maxQty": g.max_qty,
             "taken": sum(q for (pid, key), q in chosen.items() if key == g.key)}
            for g in groups
        ],
        "totalMax": total,
        "units": units,
        "totals": {
            "listValueAgorot": sum(int(u["listPriceAgorot"]) for u in taken),
            "valueAgorot": sum(int(u.get("valueAgorot") or 0) for u in taken),
            "coveredAgorot": covered,
            "topUpAgorot": top_up,
            "reductionAgorot": reduction_total,
        },
        "document": {
            "coveredAgorot": covered,
            "tender": "production_voucher" if accounting == "payment" else None,
            "deduction": "production_voucher" if accounting == "discount" else None,
        },
    }
