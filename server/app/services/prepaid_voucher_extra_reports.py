"""
Production vouchers — the reports of the spec's §15 that the module did not have yet, on the core's
filter model (`prepaid_voucher_analytics.make_scope` / `scoped_batches` / `redemption_rows`), so every
report filters alike:

* **Settlement** ("דוח להתחשבנות") — per agreement: basis, chargeable vouchers, production price,
  amount, invoice references and the balance not yet invoiced; and the batches no agreement covers
  yet. Needs `prepaid_voucher_settlement`; amounts only with `prepaid_voucher_prices`.
* **Exceptions** ("דוח חריגים") — one list of what went against the rules: the flags the cloud's
  re-check recorded on a redemption (`late`, `over_use`, `over_daily`, `over_sale`, `stacking`,
  `promotion`, `over_use` offline …), a redemption after the validity ended, reversed redemptions,
  cancelled vouchers and batches, replacements, and forced discounts. Refused scans are not recorded
  by the cloud (the till shows them), so they are not here.
* **Overrides** ("דוח הנחות וכפייה") — every forced unit from the core's override audit
  (`VoucherDiscountOverrideAudit`, contract §5 — `prepaid_voucher_override_audits`), read when the
  core records it; until then `recorded: false` and no rows, never a made-up 0. The gap between the
  production price and the till value is never a product discount and never shown here.
* **Catalog** ("דוח קטלוג") — per batch: what it gives (or discounts), each product's state now
  (no discounts, can it still be handed over and why not, notes), the discount-block policy and its
  scope, and how the list is kept (`frozen` for a fixed list).

Test batches ("שוברי בדיקה") are left out of the settlement and marked (`test`) elsewhere.
"""
from __future__ import annotations

import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
)
from app.models.prepaid_voucher_extras import PrepaidSettlementAgreement, PrepaidVoucherReplacement
from app.models.product import Product
from app.models.user import User
from app.services import prepaid_voucher_extras_access as ACC

KIND_TEXT = {
    "late": "אישור מאוחר (השמירה פקעה)",
    "over_use": "מימוש מעבר למה שנותר",
    "over_daily": "חריגה מהמגבלה היומית",
    "over_sale": "חריגה מהמימושים בעסקה",
    "stacking": "חריגה מכמות השוברים בעסקה",
    "promotion": "כפל עם מבצע בניגוד למדיניות",
    "after_validity": "מימוש אחרי סוף התוקף",
    "reversed": "מימוש שבוטל",
    "cancelled": "שובר שבוטל",
    "cancel_group": "קבוצה שבוטלה",
    "cancel_batch": "סדרה שבוטלה",
    "replaced": "שובר שהוחלף בשובר חלופי",
    "override": "כפיית הנחה",
    "test_real": "שובר בדיקה שמומש בקופה שאינה במצב הדרכה",
    "paused": "מימוש בזמן השהיה",
    "over_quota": "מימוש מעבר למכסה",
    "after_release": "מימוש לא מקוון אחרי שחרור השיוך",
    "approval_invalid": "אישור מנהל לא תקין",
}


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _pva():
    from app.services import prepaid_voucher_analytics as PVA

    return PVA


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def _in(moment, start, end) -> bool:
    m = _utc(moment)
    return m is not None and (start is None or m >= start) and (end is None or m < end)


# ── Settlement ────────────────────────────────────────────────────────────────


def _sum_or_none(values) -> Optional[int]:
    total = 0
    for v in values:
        if v is None:
            return None
        total += int(v)
    return total


def settlement_report(db: Session, user: User, tenant_id, scope) -> Dict[str, Any]:
    from app.services import prepaid_voucher_settlement as ST
    from app.services.prepaid_voucher_controls import test_batch_ids

    PV, PVA = _pv(), _pva()
    PV._require_role(user)
    ACC.require(db, user, ACC.SETTLEMENT_SECTION, "view", ACC.SETTLEMENT_FORBIDDEN)
    prices = ACC.prices_visible(db, user)
    agreements = [
        a for a in db.query(PrepaidSettlementAgreement).filter(
            PrepaidSettlementAgreement.tenant_id == tenant_id, PrepaidSettlementAgreement.status == "active"
        ).order_by(PrepaidSettlementAgreement.created_at)
        if PV._covers_company(db, user, a.company_id)
    ]
    if scope.company_id:
        agreements = [a for a in agreements if str(a.company_id) == str(scope.company_id)]
    if scope.customers:
        agreements = [a for a in agreements if (a.production_name or "") in scope.customers]
    if scope.events:
        agreements = [a for a in agreements if (a.event_name or "") in scope.events]
    rows = [ST.agreement_out(db, user, a, full=False) for a in agreements]
    # The totals count each batch once — under the agreement made first — even where two active agreements
    # came to share a batch issued after both (each agreement's own view warns of it).
    covered: set = set()
    unique: List[Dict[str, Any]] = []
    for a in agreements:
        for r in ST.agreement_out(db, user, a)["batches"]:
            if r["batchId"] not in covered:
                covered.add(r["batchId"])
                unique.append(r)
    tests = test_batch_ids(db, tenant_id)
    zone = PVA.zone_of(db, tenant_id)
    batches = PVA.scoped_batches(db, user, tenant_id, scope, zone=zone, by_redemption=False)
    loose = [b for b in batches if str(b.id) not in covered and str(b.id) not in tests]
    stats = PV._stats(db, [b.id for b in loose]) if loose else {}
    return {
        "pricesVisible": prices,
        "items": rows,
        "totals": {
            "chargeable": sum(r["chargeable"] for r in unique),
            # Null when a batch has no production price (never a partial sum that looks whole).
            "amountAgorot": _sum_or_none(r["amountAgorot"] for r in unique) if prices else None,
            "invoicesAmountAgorot": _sum_or_none(r["totals"]["invoicesAmountAgorot"] for r in rows) if prices else None,
            "uninvoiced": sum(r["uninvoiced"] for r in unique),
            "uninvoicedAmountAgorot": _sum_or_none(r["uninvoicedAmountAgorot"] for r in unique) if prices else None,
        },
        # Batches under the filters that no active agreement covers (nothing is charged for them yet).
        "unassigned": [
            {"batchId": str(b.id), "name": b.name, "typeName": b.type_name, "productionName": b.customer_name,
             "eventName": b.event_name, "issued": int((stats.get(str(b.id)) or {}).get("total", 0)),
             "used": int((stats.get(str(b.id)) or {}).get("used", 0)) + int((stats.get(str(b.id)) or {}).get("partiallyUsed", 0)),
             "productionPriceAgorot": b.production_price if prices else None}
            for b in loose
        ],
    }


# ── Exceptions ────────────────────────────────────────────────────────────────


def _override_model():
    """The core's override audit model, once it exists (contract §5)."""
    try:
        from app.models import prepaid_voucher as M
    except Exception:  # noqa: BLE001
        return None
    for name in ("PrepaidVoucherOverrideAudit", "VoucherDiscountOverrideAudit", "PrepaidOverrideAudit"):
        model = getattr(M, name, None)
        if model is not None:
            return model
    return None


def _first(obj, *names, default=None):
    for n in names:
        if hasattr(obj, n):
            v = getattr(obj, n)
            if v is not None:
                return v
    return default


def _override_rows(db: Session, batches: Dict[str, PrepaidVoucherBatch], start, end, scope) -> Optional[List[Dict[str, Any]]]:
    model = _override_model()
    if model is None or not batches:
        return None
    PV = _pv()
    try:
        with db.begin_nested():  # a table not migrated yet must not abort the request's transaction
            rows = db.query(model).filter(getattr(model, "batch_id").in_([uuid.UUID(b) for b in batches])).all()
    except Exception:  # noqa: BLE001 — a table not migrated yet: not recorded
        return None
    out = []
    for r in rows:
        at = _first(r, "created_at", "approved_at", "redeemed_at")
        if not _in(at, start, end):
            continue
        machine_id = _first(r, "machine_id")
        if scope.machine_ids and str(machine_id) not in scope.machine_ids:
            continue
        employee = _first(r, "pos_user_name", "cashier_name")
        if scope.employees and employee not in scope.employees and str(_first(r, "pos_user_id")) not in scope.employees:
            continue
        b = batches.get(str(_first(r, "batch_id")))
        list_price = _first(r, "list_price_agorot", "list_price")
        value = _first(r, "value_agorot", "value")
        reduction = _first(r, "reduction_agorot", "reduction")
        out.append({
            "at": PV._iso(at),
            "batchId": str(_first(r, "batch_id")),
            "batchName": b.name if b else None,
            "typeName": _first(r, "type_name") or (b.type_name if b else None),
            "typeVersion": _first(r, "type_version"),
            "voucherId": str(_first(r, "voucher_id")) if _first(r, "voucher_id") else None,
            "productId": str(_first(r, "product_id")) if _first(r, "product_id") else None,
            "productName": _first(r, "product_name"),
            "categoryName": _first(r, "category_name"),
            "listPriceAgorot": list_price,
            "valueAgorot": value,
            "reductionAgorot": reduction,
            "reductionBp": _first(r, "reduction_bp", "percent_bp"),
            "policy": _first(r, "policy", "mode"),
            "preset": _first(r, "policy", "mode") == "auto",
            "approvedBy": _first(r, "approved_by_name", "approver_name", "approved_by_pos_user_name"),
            "employeeName": employee,
            "machineId": str(machine_id) if machine_id else None,
            "transactionId": _first(r, "transaction_id"),
        })
    out.sort(key=lambda x: x["at"] or "")
    return out


def overrides_report(db: Session, user: User, tenant_id, scope) -> Dict[str, Any]:
    PV, PVA = _pv(), _pva()
    zone = PVA.zone_of(db, tenant_id)
    start, end = PVA._range(scope.date_from, scope.date_to, zone)
    batches = {str(b.id): b for b in PVA.scoped_batches(db, user, tenant_id, scope, zone=zone, by_redemption=False)}
    rows = _override_rows(db, batches, start, end, scope)
    machines = PVA._machine_names(db, {r["machineId"] for r in rows or [] if r["machineId"]})
    for r in rows or []:
        r["machineName"] = (machines.get(r["machineId"]) or (None,))[0] if r["machineId"] else None
    return {
        "recorded": rows is not None,
        "items": rows or [],
        "totals": {
            "units": len(rows or []),
            "reductionAgorot": sum(int(r["reductionAgorot"] or 0) for r in rows or []),
            "preset": sum(1 for r in rows or [] if r["preset"]),
            "approved": sum(1 for r in rows or [] if r["approvedBy"]),
        } if rows is not None else None,
    }


def exceptions_report(db: Session, user: User, tenant_id, scope, *, limit: int = 5000) -> Dict[str, Any]:
    from app.services.prepaid_voucher_controls import test_batch_ids

    PV, PVA = _pv(), _pva()
    zone = PVA.zone_of(db, tenant_id)
    start, end = PVA._range(scope.date_from, scope.date_to, zone)
    batches = {str(b.id): b for b in PVA.scoped_batches(db, user, tenant_id, scope, zone=zone, by_redemption=False)}
    tests = test_batch_ids(db, tenant_id)
    if not batches:
        return {"items": [], "counts": {}, "total": 0, "kinds": KIND_TEXT}
    ids = [uuid.UUID(b) for b in batches]
    R = PrepaidVoucherRedemption
    items: List[Dict[str, Any]] = []

    def base(batch_id, voucher_id, at, kind, **more):
        b = batches.get(str(batch_id))
        return {"at": PV._iso(at), "kind": kind, "kindText": KIND_TEXT.get(kind, kind), "batchId": str(batch_id),
                "batchName": b.name if b else None, "typeName": b.type_name if b else None,
                "voucherId": str(voucher_id) if voucher_id else None, "test": str(batch_id) in tests, **more}

    rq = db.query(R).filter(R.batch_id.in_(ids))
    if scope.machine_ids:
        rq = rq.filter(R.machine_id.in_([ACC.as_uuid(m) for m in scope.machine_ids if ACC.as_uuid(m)] or [uuid.uuid4()]))
    if scope.employees:
        rq = rq.filter((R.pos_user_id.in_(scope.employees)) | (R.pos_user_name.in_(scope.employees)))
    for r in rq:
        b = batches[str(r.batch_id)]
        common = {"machineId": str(r.machine_id) if r.machine_id else None, "employeeName": r.pos_user_name,
                  "transactionId": r.transaction_id, "redemptionId": str(r.id)}
        if r.reversed_at is not None and _in(r.reversed_at, start, end):
            items.append(base(r.batch_id, r.voucher_id, r.reversed_at, "reversed", **common))
        if r.reversed_at is None and _in(r.redeemed_at, start, end):
            flags = list(r.flags or [])
            for f in flags:
                items.append(base(r.batch_id, r.voucher_id, r.redeemed_at, f, **common))
            if "late" not in flags and b.valid_until is not None and _utc(r.redeemed_at) > _utc(b.valid_until):
                items.append(base(r.batch_id, r.voucher_id, r.redeemed_at, "after_validity", **common))
    # Cancelled vouchers (a replaced one is "replaced", below), groups and batches — not about a till.
    if not scope.machine_ids and not scope.employees:
        replaced = {
            str(o) for (o,) in db.query(PrepaidVoucherReplacement.original_voucher_id).filter(
                PrepaidVoucherReplacement.batch_id.in_(ids))
        }
        for v in db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id.in_(ids), PrepaidVoucher.status == "cancelled"):
            if str(v.id) in replaced or not _in(v.cancelled_at, start, end):
                continue
            items.append(base(v.batch_id, v.id, v.cancelled_at, "cancelled", serial=int(v.serial)))
        for ev in db.query(PrepaidVoucherEvent).filter(
            PrepaidVoucherEvent.batch_id.in_(ids), PrepaidVoucherEvent.action.in_(("cancel_group", "cancel_batch"))
        ):
            if _in(ev.created_at, start, end):
                items.append(base(ev.batch_id, None, ev.created_at, ev.action, count=ev.count, groupNo=ev.group_no,
                                  reason=ev.reason, userName=ev.user_name))
        for rep in db.query(PrepaidVoucherReplacement).filter(PrepaidVoucherReplacement.batch_id.in_(ids)):
            if _in(rep.created_at, start, end):
                d = rep.details or {}
                items.append(base(rep.batch_id, rep.original_voucher_id, rep.created_at, "replaced",
                                  serial=d.get("originalSerial"), replacementSerial=d.get("replacementSerial"),
                                  reason=rep.reason, reasonKind=rep.reason_kind, userName=rep.user_name))
    for o in _override_rows(db, batches, start, end, scope) or []:
        items.append(base(o["batchId"], o["voucherId"], None, "override", machineId=o["machineId"],
                          employeeName=o["employeeName"], transactionId=o["transactionId"],
                          productName=o["productName"], reductionAgorot=o["reductionAgorot"],
                          approvedBy=o["approvedBy"]) | {"at": o["at"]})
    # Serials and tills, by name.
    vids = {uuid.UUID(i["voucherId"]) for i in items if i.get("voucherId") and "serial" not in i}
    serials = {str(v): int(s) for v, s in db.query(PrepaidVoucher.id, PrepaidVoucher.serial).filter(
        PrepaidVoucher.id.in_(vids))} if vids else {}
    machines = PVA._machine_names(db, {i["machineId"] for i in items if i.get("machineId")})
    for i in items:
        if "serial" not in i:
            i["serial"] = serials.get(i.get("voucherId") or "")
        if i.get("machineId"):
            i["machineName"] = (machines.get(i["machineId"]) or (None,))[0]
    items.sort(key=lambda x: x["at"] or "", reverse=True)
    counts = Counter(i["kind"] for i in items)
    return {"items": items[:max(1, int(limit))], "counts": dict(counts), "total": len(items), "kinds": KIND_TEXT,
            "overridesRecorded": _override_model() is not None}


# ── Catalog / eligibility ─────────────────────────────────────────────────────


def catalog_report(db: Session, user: User, tenant_id, scope) -> Dict[str, Any]:
    from app.services.prepaid_voucher_controls import test_batch_ids

    PV, PVA = _pv(), _pva()
    zone = PVA.zone_of(db, tenant_id)
    batches = PVA.scoped_batches(db, user, tenant_id, scope, zone=zone, by_redemption=False)
    tests = test_batch_ids(db, tenant_id)
    product_ids = set()
    for b in batches:
        product_ids |= {i.product_id for i in b.items}
        for pid in (b.targets or {}).get("productIds") or []:
            if ACC.as_uuid(pid):
                product_ids.add(ACC.as_uuid(pid))
    products = {str(p.id): p for p in db.query(Product).filter(Product.id.in_(product_ids))} if product_ids else {}
    cat_ids = {p.category_id for p in products.values() if p.category_id}
    for b in batches:
        for c in (b.targets or {}).get("categoryIds") or []:
            if ACC.as_uuid(c):
                cat_ids.add(ACC.as_uuid(c))
    cats = {str(c.id): c.name for c in db.query(Category).filter(Category.id.in_(cat_ids))} if cat_ids else {}
    rows: List[Dict[str, Any]] = []
    out_batches = []
    for b in batches:
        related = PV._related_companies(db, b.company_id)
        group = PV._company_group(db, b.company_id)
        policy = PV._policy_out(b)
        entries = []
        if not PV.is_discount(b):
            for it in b.items:
                p = products.get(str(it.product_id))
                use = PV.usability(p, tenant_id=b.tenant_id, company_id=b.company_id, related=related, group=group,
                                   shop_ids=b.shop_ids, facts={"owner": PV._owner_shop(db, p)} if p is not None and PV._is_own_product(p) else {}) if p else None
                entries.append({
                    "role": "item",
                    "productId": str(it.product_id),
                    "productName": it.product_name,
                    "nameNow": p.name if p else None,
                    "categoryName": cats.get(str(p.category_id)) if p else None,
                    "quantity": PV.qty_out(it.quantity),
                    "priceNow": float(p.price) if p is not None and p.price is not None else None,
                    "noDiscount": bool(getattr(p, "no_discount", False)) if p else None,
                    "usable": p is not None and use["goods"] is None,
                    "blockReason": (use["goods"] if use else "missing"),
                    "notes": use["notes"] if use else [],
                    # A fixed reduction on a "לא מקבל הנחות" product goes through the policy (§7).
                    "overrideApplies": bool(getattr(p, "no_discount", False)) and (b.pricing or "cover") == "fixed",
                })
        else:
            t = b.targets or {}
            for pid in t.get("productIds") or []:
                p = products.get(str(pid))
                entries.append({"role": "target_product", "productId": str(pid), "productName": p.name if p else None,
                                "categoryName": cats.get(str(p.category_id)) if p else None,
                                "noDiscount": bool(getattr(p, "no_discount", False)) if p else None,
                                "usable": p is not None and not bool(getattr(p, "no_discount", False)),
                                "blockReason": None if p is not None and not getattr(p, "no_discount", False)
                                else ("no_discount" if p else "missing"), "notes": []})
            for cid in t.get("categoryIds") or []:
                entries.append({"role": "target_category", "categoryId": str(cid), "categoryName": cats.get(str(cid)),
                                "includeSubcategories": True, "usable": True, "blockReason": None, "notes": []})
        item = {
            "batchId": str(b.id), "batchName": b.name, "typeName": b.type_name, "kind": b.kind or "items",
            "status": b.status, "pricing": b.pricing, "test": str(b.id) in tests,
            # A fixed list is kept as issued ("רשימה קפואה"); categories of a discount are read live.
            "catalogMode": "live" if PV.is_discount(b) else "frozen",
            "selection": "items", "exclusions": [],
            "policy": policy, "entries": entries,
        }
        out_batches.append(item)
        for e in entries:
            rows.append({"batchId": item["batchId"], "batchName": b.name, "typeName": b.type_name, "kind": item["kind"],
                         "catalogMode": item["catalogMode"], "policyMode": policy.get("mode") if isinstance(policy, dict) else None,
                         **e})
    return {"batches": out_batches, "rows": rows,
            "totals": {"batches": len(out_batches), "entries": len(rows),
                       "blocked": sum(1 for r in rows if not r.get("usable")),
                       "noDiscount": sum(1 for r in rows if r.get("noDiscount"))}}
