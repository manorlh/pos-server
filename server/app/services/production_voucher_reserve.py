"""
Reserve → confirm for goods vouchers (the production vouchers contract §3): the till holds the
voucher while the sale is open, the cloud records the redemption when the document is written.

The reserve checks what the till chose (a fixed list, or groups — assigned by the shared rules,
an ambiguous unit refused with its choices), values it (`fixed`: the voucher's value, or its share
when redeemed in parts, split between the units; `cover`: the list prices up to the value, the
rest a top-up), applies the discount-block policy to every unit priced below its list price
(`override`: honour / auto / manager, the caps, the approval) and answers, per accounting mode,
what the document books: `payment` the `production_voucher` tender, `discount` a deduction,
`zero` ₪0 lines. All of it is golden-pinned (`production_voucher_rules`).

The confirm books it: the voucher's units come off (per product, or per group and in all), the
redemption records everything (§5), and every forced unit goes to the override audit (§6).
Idempotent: the same request id renews the hold; the same reservation confirms once.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherOverrideAudit,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.services import production_voucher_groups as PG
from app.services import production_voucher_rules as PR

GROUP_AMBIGUOUS = "prepaid_voucher_group_ambiguous"


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _refuse(code: str, text: Optional[str] = None, **extra) -> HTTPException:
    """A 409 the till words: `detail` is the code; with the cloud's Hebrew (and choices) as an object."""
    if text is None and not extra:
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=code)
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, "message": text, **extra})


def _pieces(q: Decimal) -> Decimal:
    """Units counted as pieces: a weighed quantity is one unit."""
    return q if q == q.to_integral_value() else Decimal(1)


def _agorot(value) -> int:
    return int(Decimal(str(value or 0)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def value_left(db: Session, voucher: PrepaidVoucher) -> Optional[int]:
    """What is left of the voucher's value (agorot): its till value less what its redemptions were worth."""
    batch = voucher.batch
    if not getattr(batch, "till_value", None):
        return None
    used = 0
    for r in db.query(PrepaidVoucherRedemption).filter(
        PrepaidVoucherRedemption.voucher_id == voucher.id, PrepaidVoucherRedemption.reversed_at.is_(None),
    ):
        used += int(r.value_agorot if r.value_agorot is not None else (r.covered_agorot or 0))
    return max(0, int(batch.till_value) - used)


def _map_ids(db: Session, machine: POSMachine, globals_: List[str]) -> Dict[str, str]:
    """Every id a product goes by (the cloud's, the till's own copy's) → the cloud's."""
    PV = _pv()
    till = PV._till_products(db, machine, globals_)
    by_any = {g.lower(): g for g in globals_}
    for g, extra in till.items():
        copy = extra.get("tillProductId")
        if copy:
            by_any[str(copy).lower()] = g
    return by_any


def _units_in(body) -> List[Dict[str, Any]]:
    out = []
    for n, u in enumerate(getattr(body, "units", None) or []):
        out.append({
            "ref": u.ref or f"u{n + 1}",
            "productId": str(u.product_id).strip().lower(),
            "productName": u.product_name,
            "groupKey": u.group_key,
            "quantity": Decimal(str(u.quantity or 1)),
            "listPriceAgorot": int(u.list_price_agorot or 0),
            "listValueAgorot": int(u.list_value_agorot if u.list_value_agorot is not None else u.list_price_agorot or 0),
            "categoryIds": [str(c).lower() for c in (u.category_ids or [])],
            "noDiscount": bool(u.no_discount),
        })
    return out


def _choose_items(db, machine, batch, voucher, units, forfeit_rest) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Decimal]:
    """A fixed list: each unit on the voucher, no more than is left; whole at once unless forfeited."""
    PV = _pv()
    on_voucher = [str(i.product_id) for i in batch.items]
    names = {str(i.product_id): i.product_name for i in batch.items}
    weighed = {str(i.product_id) for i in batch.items if PV._item_weighed(i)}
    by_any = _map_ids(db, machine, on_voucher)
    remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
    wanted: Dict[str, Decimal] = {}
    for u in units:
        pid = by_any.get(u["productId"])
        if pid is None:
            raise _refuse(PR.NOT_IN_GROUP, PR.TEXT[PR.NOT_IN_GROUP])
        q = PV.qty(u["quantity"])
        if q != q.to_integral_value() and pid not in weighed:
            raise _refuse(PV.QUANTITY_FRACTION)
        u["productId"], u["productName"] = pid, u["productName"] or names.get(pid)
        wanted[pid] = wanted.get(pid, Decimal(0)) + q
    if not wanted:
        raise _refuse(PR.NOTHING_CHOSEN, PR.TEXT[PR.NOTHING_CHOSEN])
    for pid, q in wanted.items():
        if q > remaining.get(pid, Decimal(0)):
            raise _refuse(PV.INSUFFICIENT)
    left = {pid: remaining.get(pid, Decimal(0)) - wanted.get(pid, Decimal(0)) for pid in remaining}
    forfeited: List[Dict[str, Any]] = []
    if any(q > 0 for q in left.values()) and not batch.split_allowed:
        if not forfeit_rest:
            raise _refuse(PV.PARTIAL_NOT_ALLOWED)
        forfeited = [{"productId": pid, "name": names.get(pid), "quantity": PV.qty_out(q)} for pid, q in left.items() if q > 0]
    units_left = sum((_pieces(q) for q in remaining.values() if q > 0), Decimal(0))
    if forfeited:
        # The rest is given up: this redemption is the voucher's last, and takes all its value.
        units_left = sum((_pieces(q) for q in wanted.values()), Decimal(0))
    return units, forfeited, units_left


def _choose_groups(db, machine, batch, voucher, units, type_name) -> Tuple[List[Dict[str, Any]], Decimal]:
    """Groups: each unit to its group (as the till said, else the single clear match), then the selection rules."""
    groups = list(batch.groups or [])
    catalog = PG.catalog_of(db, batch.tenant_id, batch.company_id)
    eligible = {g["key"]: PG.eligible(db, batch, g, catalog) for g in groups}
    by_any = _map_ids(db, machine, sorted({p for ids in eligible.values() for p in ids}))
    left = PG.remaining_of(voucher, groups, batch.total_qty)
    unassigned = []
    for u in units:
        pid = by_any.get(u["productId"], u["productId"])
        u["productId"] = pid
        key = u.get("groupKey")
        if key:
            if key not in eligible:
                raise _refuse(PR.NOT_IN_GROUP, PR.TEXT[PR.NOT_IN_GROUP])
        else:
            unassigned.append(u)
    if unassigned:
        assignment = PR.assign_units(
            [PR.GroupCap(g["key"], tuple(eligible[g["key"]]), left[g["key"]]) for g in groups],
            [(u["ref"], u["productId"]) for u in unassigned],
            left[PG.TOTAL],
        )
        if assignment.ambiguous:
            names = {g["key"]: g.get("name") for g in groups}
            raise _refuse(GROUP_AMBIGUOUS, "יש לבחור לאיזו קבוצה שייך הפריט", units=[
                {"ref": ref, "groupKeys": list(keys), "groupNames": [names.get(k) for k in keys]}
                for ref, keys in assignment.ambiguous
            ])
        for u in unassigned:
            key = assignment.assigned.get(u["ref"])
            if key is None:
                why = dict(assignment.unassigned).get(u["ref"])
                if why == PR.UNIT_TOTAL_FULL:
                    raise _refuse(PR.TOTAL_OVER, PR.TEXT[PR.TOTAL_OVER].format(n=left[PG.TOTAL]))
                if why == PR.UNIT_GROUP_FULL:
                    raise _refuse(PR.GROUP_OVER)
                raise _refuse(PR.NOT_IN_GROUP, PR.TEXT[PR.NOT_IN_GROUP])
            u["groupKey"] = key
    rule_groups = [
        PR.Group(key=g["key"], name=g.get("name") or "", min_qty=int(g.get("minQty") or 0), max_qty=int(g.get("maxQty") or 1),
                 remaining=left[g["key"]], product_ids=tuple(eligible[g["key"]]), allow_repeat=bool(g.get("allowRepeat", True)),
                 excluded_ids=tuple(g.get("excludeProductIds") or ()))
        for g in groups
    ]
    chosen = [(u["productId"], u["groupKey"], int(_pieces(Decimal(str(u["quantity"]))))) for u in units]
    refusal = PR.check_selection(
        rule_groups, chosen, total_max=PG.total_max(groups, batch.total_qty), total_remaining=left[PG.TOTAL],
        whole_at_once=not batch.split_allowed, type_name=type_name,
    )
    if refusal is not None:
        raise _refuse(refusal.code, refusal.text, groupKey=refusal.group_key)
    names = {g["key"]: g.get("name") for g in groups}
    for u in units:
        u["groupName"] = names.get(u["groupKey"])
    return units, Decimal(left[PG.TOTAL])


def _policy(batch) -> PR.OverridePolicy:
    scope = getattr(batch, "override_scope", None) or None
    return PR.OverridePolicy(
        mode=getattr(batch, "discount_block_policy", None) or PR.POLICY_HONOUR,
        max_amount=getattr(batch, "override_max_amount", None),
        max_percent=getattr(batch, "override_max_percent", None),
        max_total=getattr(batch, "override_max_total", None),
        scope_product_ids=tuple(str(p).lower() for p in scope.get("productIds", [])) if scope else None,
        scope_category_ids=tuple(str(c).lower() for c in scope.get("categoryIds", [])) if scope else None,
    )


def value_units(db, batch, voucher, units, units_left: Decimal, approved: bool) -> Dict[str, Any]:
    """Each unit's value, what the document covers per accounting mode, the top-up and the override (golden rules)."""
    accounting = "discount" if _pv().is_discount(batch) else (getattr(batch, "redemption_accounting", None) or "zero")
    pricing = getattr(batch, "pricing", None) or "cover"
    lists = [int(u["listPriceAgorot"]) for u in units]
    left_value = value_left(db, voucher)
    top_up = 0
    note = None
    group_values = {g["key"]: g.get("valueAgorot") for g in (batch.groups or [])}
    if pricing == "fixed" and left_value is not None:
        units_now = sum((_pieces(Decimal(str(u["quantity"]))) for u in units), Decimal(0))
        share = PR.fixed_share(left_value, int(units_now), int(units_left))
        values = PR.split_value(share, [(lp, group_values.get(u.get("groupKey"))) for u, lp in zip(units, lists)])
        if values is None:
            raise _refuse(PR.VALUE_MISMATCH, PR.TEXT[PR.VALUE_MISMATCH])
    else:
        c = PR.cover(left_value, lists, bool(getattr(batch, "allow_top_up", True)))
        if c.refusal is not None:
            raise _refuse(c.refusal.code, c.refusal.text)
        values, top_up, note = list(c.per_unit), c.top_up, c.note
    priced = [
        PR.PricedUnit(ref=u["ref"], product_id=u["productId"], category_ids=tuple(u["categoryIds"]),
                      no_discount=u["noDiscount"], list_price=lp, value=v)
        for u, lp, v in zip(units, lists, values)
    ]
    override = PR.override_check(_policy(batch), priced, approved) if pricing == "fixed" else PR.OverrideResult(
        tuple((u["ref"], 0, False) for u in units), False, None)
    if override.refusal is not None:
        raise _refuse(override.refusal.code, override.refusal.text, needsApproval=override.needs_approval)
    by_ref = {ref: (red, forced) for ref, red, forced in override.units}
    out_units = []
    for u, lp, v in zip(units, lists, values):
        red, forced = by_ref.get(u["ref"], (0, False))
        if accounting == "zero":
            covered = 0
        elif accounting == "discount" and pricing == "fixed":
            covered = lp  # covered whole: the line keeps its price, the deduction takes it
        else:
            covered = v
        out_units.append({
            "ref": u["ref"], "productId": u["productId"], "productName": u.get("productName"),
            "groupKey": u.get("groupKey"), "groupName": u.get("groupName"),
            "quantity": _pv().qty_out(u["quantity"]), "listPriceAgorot": lp, "listValueAgorot": int(u["listValueAgorot"]),
            "valueAgorot": int(v), "coveredAgorot": int(covered), "forced": bool(forced), "reductionAgorot": int(red),
        })
    return {
        "redemptionAccounting": accounting,
        "pricing": pricing,
        "units": out_units,
        "valueAgorot": sum(u["valueAgorot"] for u in out_units),
        "listValueAgorot": sum(u["listValueAgorot"] for u in out_units),
        "coveredAgorot": sum(u["coveredAgorot"] for u in out_units),
        "topUpAgorot": int(top_up),
        "tender": "production_voucher" if accounting == "payment" else None,
        "deduction": {"kind": "production_voucher"} if accounting == "discount" else None,
        "needsApproval": bool(override.needs_approval),
        "note": note,
    }


def reserve_goods(db: Session, machine: POSMachine, body, voucher: PrepaidVoucher, prior, now: datetime, sale_ref: str) -> Dict[str, Any]:
    """A goods voucher held for one open sale (§3). The caller has locked the sale and the voucher."""
    PV = _pv()
    batch = voucher.batch
    features = set(getattr(body, "features", None) or []) | {"reserve_goods"}
    if PV.missing_features(db, batch, features):
        raise _refuse(PV.UPDATE_REQUIRED, PV.UPDATE_REQUIRED_MESSAGE)
    reason = PV.refusal_reason(db, machine, voucher, now)
    if reason is not None:
        raise _refuse(reason, PV.refusal_message(db, voucher, reason))
    # Held by another sale (any till): in use until it is confirmed, released or expires.
    others = db.query(PrepaidVoucherReservation).filter(
        PrepaidVoucherReservation.voucher_id == voucher.id,
        PrepaidVoucherReservation.status == "held",
        PrepaidVoucherReservation.id != (prior.id if prior is not None else uuid.uuid4()),
    ).all()
    if any(PV._reservation_live(o, now) for o in others):
        raise _refuse(PV.IN_USE)
    exclude = prior.id if prior is not None else None
    refusal = PV.RULES.stacking_refusal(
        PV._vouchers_in_sale(db, machine, sale_ref, exclude_reservation=exclude, reported=body.other_vouchers),
        PV._in_sale(voucher),
    )
    if refusal is not None:
        raise _refuse(refusal)
    units = _units_in(body)
    type_name = PV._type_name_of(db, batch)
    forfeited: List[Dict[str, Any]] = []
    if (getattr(batch, "selection", None) or "items") == "groups":
        units, units_left = _choose_groups(db, machine, batch, voucher, units, type_name)
    else:
        units, forfeited, units_left = _choose_items(db, machine, batch, voucher, units, bool(getattr(body, "forfeit_rest", False)))
    approval = getattr(body, "approval", None)
    answer = value_units(db, batch, voucher, units, units_left, approved=approval is not None)
    answer.update({
        "forfeited": forfeited,
        "serial": int(voucher.serial),
        "typeName": type_name,
        "productionName": getattr(batch, "customer_name", None),
        "batchName": batch.name,
        "approval": (
            {"posUserId": approval.pos_user_id, "posUserName": approval.pos_user_name, "method": approval.method}
            if approval is not None else None
        ),
    })
    expires = now + PV.RESERVATION_TTL
    if prior is not None:
        prior.goods = answer
        prior.amount = answer["coveredAgorot"]
        prior.status = "held"
        prior.expires_at = expires
        prior.updated_at = now
        r = prior
    else:
        r = PrepaidVoucherReservation(
            id=uuid.uuid4(), tenant_id=voucher.tenant_id, voucher_id=voucher.id, batch_id=batch.id,
            machine_id=machine.id, shop_id=machine.shop_id, client_request_id=body.client_request_id.strip(),
            sale_ref=sale_ref, uses=1, amount=answer["coveredAgorot"], status="held", expires_at=expires,
            pos_user_id=(str(body.pos_user_id) if body.pos_user_id is not None else None), pos_user_name=body.pos_user_name,
            goods=answer, created_at=now, updated_at=now,
        )
        db.add(r)
    db.flush()
    return reservation_out(db, machine, voucher, r, replayed=prior is not None)


def reservation_out(db: Session, machine: POSMachine, voucher: PrepaidVoucher, r, *, replayed: bool) -> Dict[str, Any]:
    PV = _pv()
    goods = dict(r.goods or {})
    return {
        "ok": True,
        "replayed": replayed,
        "reservationId": str(r.id),
        "status": r.status if r.status != "held" or PV._reservation_live(r, PV._now()) else "expired",
        "expiresAt": PV._iso(r.expires_at),
        **{k: goods.get(k) for k in (
            "redemptionAccounting", "pricing", "units", "listValueAgorot", "coveredAgorot", "topUpAgorot", "tender",
            "deduction", "serial", "typeName", "productionName", "needsApproval", "note",
        )},
        "voucher": PV.till_view(db, machine, voucher, exclude_reservation=r.id),
    }


def confirm_goods(db: Session, machine: POSMachine, r, voucher: PrepaidVoucher, transaction_id: str, units=None) -> Dict[str, Any]:
    """The sale was written (§3): take the units off the voucher and record the redemption. Idempotent."""
    PV = _pv()
    now = PV._now()
    if r.status == "confirmed":
        if r.transaction_id and r.transaction_id != transaction_id:
            raise _refuse(PV.RESERVATION_CONFLICT)
        redemption = db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == r.redemption_id).first()
        return _confirm_out(r, redemption, replayed=True)
    goods = dict(r.goods or {})
    taken = goods.get("units") or []
    if units:
        # The basket changed after the hold: the document's units (their values as the till booked them).
        by_ref = {u.get("ref"): u for u in taken}
        taken = [{**by_ref.get(u.ref, {}), **{k: v for k, v in {
            "ref": u.ref, "productId": str(u.product_id).lower(), "productName": u.product_name,
            "groupKey": u.group_key, "quantity": PV.qty_out(u.quantity or 1),
            "valueAgorot": u.value_agorot, "coveredAgorot": u.covered_agorot, "listValueAgorot": u.list_value_agorot,
        }.items() if v is not None}} for u in units]
    flags: List[str] = []
    if r.status != "held" or not PV._reservation_live(r, now):
        flags.append("late")
    batch = voucher.batch
    remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
    if (getattr(batch, "selection", None) or "items") == "groups":
        for u in taken:
            key = f"g:{u.get('groupKey')}"
            q = _pieces(PV.qty(u.get("quantity") or 1))
            remaining[key] = remaining.get(key, Decimal(0)) - q
            remaining[PG.TOTAL] = remaining.get(PG.TOTAL, Decimal(0)) - q
    else:
        for u in taken:
            pid = str(u.get("productId"))
            remaining[pid] = remaining.get(pid, Decimal(0)) - PV.qty(u.get("quantity") or 1)
        for f in goods.get("forfeited") or []:
            remaining[str(f.get("productId"))] = Decimal(0)
    if any(q < 0 for q in remaining.values()):
        flags.append("over_use")  # a fiscal fact by now: recorded and flagged, never refused
    remaining = {k: max(Decimal(0), q) for k, q in remaining.items()}
    voucher.remaining = {k: PV.qty_out(q) for k, q in remaining.items()}
    done = not any(q > 0 for k, q in remaining.items() if k != PG.TOTAL) or remaining.get(PG.TOTAL, Decimal(1)) <= 0
    voucher.status = "used" if done else "partially_used"
    voucher.first_redeemed_at = voucher.first_redeemed_at or now
    voucher.last_redeemed_at = now
    voucher.updated_at = now
    approval = goods.get("approval") or {}
    redemption = PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=voucher.tenant_id, voucher_id=voucher.id, batch_id=batch.id, machine_id=machine.id,
        shop_id=machine.shop_id, pos_user_id=r.pos_user_id, pos_user_name=r.pos_user_name,
        client_request_id=f"reservation:{r.id}", transaction_id=transaction_id, sale_ref=r.sale_ref,
        items=[{"productId": u.get("productId"), "name": u.get("productName"), "quantity": u.get("quantity")} for u in taken],
        forfeited=goods.get("forfeited") or None, redeemed_at=now, reservation_id=r.id, flags=flags or None,
        redemption_accounting=goods.get("redemptionAccounting"), pricing=goods.get("pricing"),
        value_agorot=sum(int(u.get("valueAgorot") or 0) for u in taken),
        covered_agorot=sum(int(u.get("coveredAgorot") or 0) for u in taken),
        top_up_agorot=int(goods.get("topUpAgorot") or 0),
        list_value_agorot=sum(int(u.get("listValueAgorot") or 0) for u in taken),
        units=taken, serial=goods.get("serial"), type_name=goods.get("typeName"),
        production_name=goods.get("productionName"), batch_name=goods.get("batchName"),
        approved_by_pos_user_id=approval.get("posUserId"), approved_by_pos_user_name=approval.get("posUserName"),
    )
    db.add(redemption)
    for u in taken:
        if not u.get("forced"):
            continue
        lp = int(u.get("listPriceAgorot") or 0)
        red = int(u.get("reductionAgorot") or 0)
        db.add(PrepaidVoucherOverrideAudit(
            id=uuid.uuid4(), tenant_id=voucher.tenant_id, redemption_id=redemption.id, voucher_id=voucher.id,
            batch_id=batch.id, type_id=getattr(batch, "type_id", None), type_version=getattr(batch, "type_version", None),
            product_id=u.get("productId"), product_name=u.get("productName"), quantity=PV.qty(u.get("quantity") or 1),
            list_price_agorot=lp, value_agorot=int(u.get("valueAgorot") or 0), reduction_agorot=red,
            reduction_bp=(red * 10_000 // lp) if lp else 0, policy=getattr(batch, "discount_block_policy", None) or "honour",
            approved_by_pos_user_id=approval.get("posUserId"), approved_by_pos_user_name=approval.get("posUserName"),
            machine_id=machine.id, pos_user_id=r.pos_user_id, pos_user_name=r.pos_user_name, created_at=now,
        ))
    r.status = "confirmed"
    r.transaction_id = transaction_id
    r.redemption_id = redemption.id
    r.confirmed_at = now
    r.updated_at = now
    db.flush()
    return _confirm_out(r, redemption, replayed=False)


def _confirm_out(r, redemption, *, replayed: bool) -> Dict[str, Any]:
    return {
        "ok": True,
        "replayed": replayed,
        "reservationId": str(r.id),
        "status": r.status,
        "redemptionId": str(redemption.id) if redemption is not None else None,
        "transactionId": r.transaction_id,
        "coveredAgorot": int(redemption.covered_agorot or 0) if redemption is not None else None,
        "flags": list(redemption.flags or []) if redemption is not None else [],
    }
