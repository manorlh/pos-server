"""
Prepaid vouchers redeemed without the internet ("מימוש ללא אינטרנט", `offline_allowed`) — the
production vouchers contract §7:

* **assign** a batch to one till (`machine`) or to its shop's LAN host (`lan_host`: the shop's main
  till) — refused unless the batch allows it; one active assignment per batch (the same target
  again answers it);
* while assigned, the cloud and every other machine refuse the batch's vouchers
  (`prepaid_voucher_assigned_offline`, "השובר משויך לעבודה ללא אינטרנט ב{device}");
* the device **downloads** what is assigned to it: the batch's terms (the lookup's names) and its
  vouchers by code **hash** (lowercase hex SHA-256 of the normalized code) — never a code;
* the device **syncs** what it redeemed, idempotently by its own id; a redemption beyond what the
  cloud has left is recorded and flagged (`over_use`), never refused — it is a fiscal fact;
* **release** only once the device synced with nothing pending after its last download, or by force
  with a reason (audited).
"""
from __future__ import annotations

import hashlib
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherOfflineAssignment,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.models.user import User

OFFLINE_NOT_ALLOWED = "prepaid_voucher_offline_not_allowed"
OFFLINE_PENDING = "prepaid_voucher_offline_pending"
OFFLINE_ASSIGNED = "prepaid_voucher_offline_assigned"
ASSIGNED_OFFLINE = "prepaid_voucher_assigned_offline"
NO_MAIN_TILL = "prepaid_voucher_offline_no_main_till"
REASON_REQUIRED = "prepaid_voucher_offline_reason_required"
#: A device of a shop the batch is not valid in (or that the user does not see).
WRONG_SHOP = "prepaid_voucher_offline_wrong_shop"
TARGETS = ("machine", "lan_host")
ASSIGNED_TEXT = "השובר משויך לעבודה ללא אינטרנט ב{device}"
#: The device the batch is assigned to asks the cloud: it redeems the batch from its local copy only.
ASSIGNED_HERE_TEXT = "השובר משויך לעבודה ללא אינטרנט בקופה זו — יש לממש אותו מהשיוך המקומי"
#: A batch held by an open sale cannot be handed to a device meanwhile.
HOLDS_LIVE = "prepaid_voucher_offline_holds_live"
#: `active`, or `releasing` until the device acknowledges the release (two steps, review 09.10).
LIVE = ("active", "releasing")


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def code_hash(code: str) -> str:
    """Lowercase hex SHA-256 of the normalized code (upper-case, no `PV:`, no dashes)."""
    return hashlib.sha256(_pv().normalize_code(code).encode("utf-8")).hexdigest()


def active_of(db: Session, batch_id) -> Optional[PrepaidVoucherOfflineAssignment]:
    return (
        db.query(PrepaidVoucherOfflineAssignment)
        .filter(PrepaidVoucherOfflineAssignment.batch_id == batch_id, PrepaidVoucherOfflineAssignment.status.in_(LIVE))
        .first()
    )


def refuse_if_assigned(db: Session, batch: PrepaidVoucherBatch) -> None:
    """A batch cannot stop allowing offline redemption while it is assigned somewhere."""
    if active_of(db, batch.id) is not None:
        raise _pv()._http(status.HTTP_409_CONFLICT, OFFLINE_ASSIGNED)


def assigned_elsewhere(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch) -> Optional[str]:
    """
    While [batch] is assigned (active or releasing) the cloud redeems none of its vouchers — not for
    another machine (the device's name), nor for the device itself, which redeems them from its local
    copy only (review 09.10). None: not assigned.
    """
    if not getattr(batch, "offline_allowed", False):
        return None
    a = active_of(db, batch.id)
    if a is None:
        return None
    if a.machine_id == machine.id:
        return ""  # this very device: ASSIGNED_HERE_TEXT
    return db.query(POSMachine.name).filter(POSMachine.id == a.machine_id).scalar() or "קופה אחרת"


def assigned_text(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch) -> str:
    device = assigned_elsewhere(db, machine, batch)
    return ASSIGNED_HERE_TEXT if device == "" else ASSIGNED_TEXT.format(device=device or "")


def _out(db: Session, a: Optional[PrepaidVoucherOfflineAssignment]) -> Optional[Dict[str, Any]]:
    if a is None:
        return None
    PV = _pv()
    name = db.query(POSMachine.name).filter(POSMachine.id == a.machine_id).scalar()
    return {
        "id": str(a.id), "batchId": str(a.batch_id), "target": a.target, "machineId": str(a.machine_id),
        "machineName": name, "shopId": str(a.shop_id) if a.shop_id else None, "status": a.status,
        "version": int(a.version or 1), "assignedAt": PV._iso(a.assigned_at), "lastDownloadAt": PV._iso(a.last_download_at),
        "lastSyncAt": PV._iso(a.last_sync_at), "lastSyncPending": a.last_sync_pending,
        "releasedAt": PV._iso(a.released_at), "forced": bool(a.forced), "releaseReason": a.release_reason,
    }


# ── Dashboard ─────────────────────────────────────────────────────────────────


def _eligible_shops(db: Session, user: User, tenant_id, batch: PrepaidVoucherBatch) -> List[str]:
    """The shops a device holding [batch] may be in: the batch's own (else its company's), that [user] sees."""
    PV = _pv()
    visible = PV._visible_shop_ids(db, user, tenant_id)
    if batch.shop_ids:
        shops = [str(s) for s in batch.shop_ids]
    else:
        group = PV._company_group(db, batch.company_id)
        shops = [str(s) for (s, c) in db.query(Shop.id, Shop.company_id).filter(Shop.tenant_id == tenant_id) if str(c) in group]
    return [s for s in shops if s in visible]


def targets(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    """
    Where [batch] may be assigned: the active tills of its shops the user sees (kiosks never — they
    sell, they do not redeem offline), and per shop its LAN host (the main till), when it has one.
    """
    from app.services.main_till import main_till_of_shop
    from app.services.printers import shop_machines

    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    out_shops = []
    for sid in _eligible_shops(db, user, tenant_id, batch):
        shop = db.get(Shop, PV._as_uuid(sid))
        if shop is None:
            continue
        main = main_till_of_shop(db, shop.id)
        tills = [m for m in shop_machines(db, shop.id) if not getattr(m, "is_kiosk", False)]
        out_shops.append({
            "shopId": sid, "shopName": shop.name,
            "lanHost": {"machineId": str(main.id), "name": main.name} if main is not None else None,
            "machines": [{"machineId": str(m.id), "name": m.name, "posNumber": m.pos_number} for m in tills],
        })
    return {"offlineAllowed": bool(getattr(batch, "offline_allowed", False)), "shops": out_shops}


def assign(db: Session, user: User, tenant_id, batch_id, target: str, machine_id: Optional[str] = None,
           shop_id: Optional[str] = None) -> Dict[str, Any]:
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    # The batch's lock: two assigns at once never both pass the "one live assignment" check.
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == batch.id).with_for_update().one()
    if not getattr(batch, "offline_allowed", False):
        raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_NOT_ALLOWED)
    if target not in TARGETS:
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, "target must be machine or lan_host")
    eligible = set(_eligible_shops(db, user, tenant_id, batch))
    if target == "machine":
        machine = db.query(POSMachine).filter(POSMachine.id == PV._as_uuid(machine_id)).first() if machine_id else None
        if machine is None or str(machine.tenant_id) != str(tenant_id):
            raise PV._http(status.HTTP_404_NOT_FOUND, "machine_not_found")
        # Only an active till of a shop the batch is valid in — and one the user sees; never a kiosk.
        if str(machine.shop_id) not in eligible or not machine.is_active or getattr(machine, "is_kiosk", False):
            raise PV._http(status.HTTP_409_CONFLICT, WRONG_SHOP)
    else:
        if shop_id and str(PV._as_uuid(shop_id)) not in eligible:
            raise PV._http(status.HTTP_409_CONFLICT, WRONG_SHOP)
        from app.services.main_till import main_till_of_shop

        shop = PV._as_uuid(shop_id) or (PV._as_uuid(batch.shop_ids[0]) if batch.shop_ids and len(batch.shop_ids) == 1 else None)
        if shop is not None and str(shop) not in eligible:
            raise PV._http(status.HTTP_409_CONFLICT, WRONG_SHOP)
        machine = main_till_of_shop(db, shop) if shop else None
        if machine is None:
            raise PV._http(status.HTTP_409_CONFLICT, NO_MAIN_TILL)
    from app.services.prepaid_voucher_controls import offline_assign_check  # §18 hook (helper): test / paused

    offline_assign_check(db, batch, machine)
    current = active_of(db, batch.id)
    if current is not None:
        if current.status == "active" and current.machine_id == machine.id and current.target == target:
            return _out(db, current)  # the same target again: the assignment as it is
        # Another device's — or this one's on its way out (`releasing`): never handed back as new.
        raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_ASSIGNED)
    # A voucher held by an open sale (any till): the device would not know of the hold.
    live = [
        r for r in db.query(PrepaidVoucherReservation).filter(
            PrepaidVoucherReservation.batch_id == batch.id, PrepaidVoucherReservation.status == "held")
        if PV._reservation_live(r, PV._now())
    ]
    if live:
        raise PV._http(status.HTTP_409_CONFLICT, HOLDS_LIVE)
    a = PrepaidVoucherOfflineAssignment(
        id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, target=target, machine_id=machine.id,
        shop_id=machine.shop_id, status="active", version=1, assigned_by=getattr(user, "id", None), assigned_at=PV._now(),
    )
    db.add(a)
    PV._event(db, batch, user, "offline_assign", details={"target": target, "machineId": str(machine.id)})
    db.flush()
    return _out(db, a)


def release(db: Session, user: User, tenant_id, batch_id, force: bool = False, reason: Optional[str] = None) -> Dict[str, Any]:
    """
    Two steps (review 09.10): the release is requested (`releasing`) and completes when the device
    acknowledges it on a sync with nothing pending (`releaseAck`). A device that never downloaded the
    batch has nothing to give back: released at once. `force` with a reason releases at once (audited).
    """
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    a = active_of(db, batch.id)
    if a is None:
        return {"assignment": None}
    if force:
        if not (reason or "").strip():
            raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, REASON_REQUIRED)
        _complete(db, batch, a, user, forced=True, reason=reason)
        return {"assignment": _out(db, a)}
    if a.last_download_at is None:
        _complete(db, batch, a, user, forced=False, reason=None)
        return {"assignment": _out(db, a)}
    if a.status != "releasing":
        a.status = "releasing"
        a.version = int(a.version or 1) + 1
        a.released_by = getattr(user, "id", None)
        PV._event(db, batch, user, "offline_release_requested", details={"assignmentId": str(a.id)})
        db.flush()
    return {"assignment": _out(db, a)}


def _complete(db: Session, batch: PrepaidVoucherBatch, a: PrepaidVoucherOfflineAssignment, user, *, forced: bool,
              reason: Optional[str]) -> None:
    PV = _pv()
    a.status = "released"
    a.released_at = PV._now()
    a.released_by = getattr(user, "id", None) or a.released_by
    a.forced = bool(forced)
    a.release_reason = (reason or "").strip() or None
    PV._event(db, batch, user, "offline_force_release" if forced else "offline_release",
              reason=a.release_reason, details={"assignmentId": str(a.id), "pending": a.last_sync_pending})
    db.flush()


def history(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    rows = (
        db.query(PrepaidVoucherOfflineAssignment)
        .filter(PrepaidVoucherOfflineAssignment.batch_id == batch.id)
        .order_by(PrepaidVoucherOfflineAssignment.assigned_at.desc())
        .all()
    )
    active = next((r for r in rows if r.status in LIVE), None)
    return {"assignment": _out(db, active), "history": [_out(db, r) for r in rows]}


# ── The device ────────────────────────────────────────────────────────────────


def _snapshot(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch, voucher_sample) -> Dict[str, Any]:
    """The batch's terms under the lookup's names (one voucher's view, its own fields dropped)."""
    PV = _pv()
    view = PV.till_view(db, machine, voucher_sample) if voucher_sample is not None else {}
    keep = (
        "kind", "typeName", "typeCode", "tillValueAgorot", "pricing", "allowTopUp", "redemptionAccounting",
        "productionName", "wholeAtOnce", "discountBlockPolicy", "includeExtras", "stacking", "maxVouchersPerSale",
        "selection", "groups", "totalMax", "catalogMode", "benefit", "usesPerVoucher", "maxUsesPerSale", "maxUsesPerDay",
    )
    out = {k: view.get(k) for k in keep if k in view}
    if out.get("groups"):
        stored = {g["key"]: g for g in (batch.groups or [])}
        for g in out["groups"]:
            s = stored.get(g["key"], {})
            g["frozenIds"] = s.get("frozenProductIds") or []
            # The selection itself, for a device that checks a product the catalog gained (`live`).
            g.update({k: s.get(k) for k in ("allItems", "categoryIds", "includeSubcategories", "excludeProductIds",
                                            "excludeCategoryIds")})
    out.update({
        "batchId": str(batch.id),
        "batchName": batch.name,
        "eventName": batch.event_name,
        "validFrom": PV._iso(batch.valid_from),
        "validUntil": PV._iso(batch.valid_until),
        "shopIds": list(batch.shop_ids) if batch.shop_ids else None,
        "companyId": str(batch.company_id),
        "items": [
            {"productId": i["productId"], "tillProductId": i.get("tillProductId"), "name": i["name"],
             "quantity": i["quantity"], "weighed": i.get("weighed"), "unitLabel": i.get("unitLabel")}
            for i in view.get("items", [])
        ],
    })
    from app.services.prepaid_voucher_controls import offline_snapshot_fields  # §18 hook (helper)

    out.update(offline_snapshot_fields(db, batch))  # isTest, paused, quota
    return out


def still_valid(db: Session, machine: POSMachine, a: PrepaidVoucherOfflineAssignment,
                batch: Optional[PrepaidVoucherBatch]) -> bool:
    """
    The assignment still fits its device: the same tenant, the shop it was made in, a shop the
    batch is valid in, the device active. A device moved to another shop or tenant loses it
    (released by the cloud, audited) — it never downloads vouchers it may not redeem.
    """
    if batch is None or str(batch.tenant_id) != str(machine.tenant_id) or str(a.tenant_id) != str(machine.tenant_id):
        return False
    if a.shop_id is not None and str(a.shop_id) != str(machine.shop_id):
        return False
    if not machine.is_active:
        return False
    if batch.shop_ids:
        return str(machine.shop_id) in {str(s) for s in batch.shop_ids}
    company = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).scalar() if machine.shop_id else None
    return company is not None and str(company) in _pv()._company_group(db, batch.company_id)


def _drop_moved(db: Session, machine: POSMachine) -> None:
    """[machine]'s live assignments that no longer fit it: released (`offline_auto_release`)."""
    PV = _pv()
    for a in db.query(PrepaidVoucherOfflineAssignment).filter(
        PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status.in_(LIVE),
    ):
        batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == a.batch_id).first()
        if still_valid(db, machine, a, batch):
            continue
        a.status, a.released_at, a.forced = "released", PV._now(), True
        a.release_reason = "המכשיר עבר לסניף או לחשבון אחר"
        if batch is not None:
            PV._event(db, batch, None, "offline_force_release", reason=a.release_reason,
                      details={"assignmentId": str(a.id), "auto": True})
    db.flush()


def released_on_machine_move(db: Session, machine: POSMachine) -> None:
    """Called when a machine's shop or tenant changes: its assignments that no longer fit go."""
    _drop_moved(db, machine)


def assignments_out(db: Session, machine: POSMachine) -> List[Dict[str, Any]]:
    """Every assignment of [machine] not released: what the sync answers (the release's first step)."""
    return [
        {"assignmentId": str(a.id), "batchId": str(a.batch_id), "status": a.status, "version": int(a.version or 1)}
        for a in db.query(PrepaidVoucherOfflineAssignment).filter(
            PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status.in_(LIVE))
    ]


def download(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """What is assigned to [machine]: the batches' terms and their vouchers by code hash."""
    PV = _pv()
    now = PV._now()
    _drop_moved(db, machine)
    out = []
    for a in db.query(PrepaidVoucherOfflineAssignment).filter(
        PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status.in_(LIVE),
    ):
        batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == a.batch_id).first()
        if batch is None:
            continue
        vouchers = db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial).all()
        from app.services import production_voucher_reserve as PVRG

        out.append({
            "assignmentId": str(a.id),
            "batchId": str(batch.id),
            "target": a.target,
            # `releasing`: stop redeeming, sync what is left, acknowledge (`releaseAck`).
            "status": a.status,
            "version": int(a.version or 1),
            "snapshot": _snapshot(db, machine, batch, vouchers[0] if vouchers else None),
            "vouchers": [
                {
                    "voucherId": str(v.id), "serial": int(v.serial), "codeHash": code_hash(v.code), "status": v.status,
                    "remaining": dict(v.remaining or {}), "usesLeft": v.uses_left,
                    "valueLeftAgorot": PVRG.value_left(db, v),
                    "unitsLeft": _units_left(v),
                }
                for v in vouchers
            ],
        })
        a.last_download_at = now
    db.flush()
    return {"serverTime": PV._iso(now), "assignments": out}


def _units_left(v: PrepaidVoucher) -> int:
    rem = v.remaining or {}
    if "total" in rem:
        return int(Decimal(str(rem["total"])))
    total = Decimal(0)
    for q in rem.values():
        d = Decimal(str(q))
        total += d if d == d.to_integral_value() else (Decimal(1) if d > 0 else Decimal(0))
    return int(total)


def sync(db: Session, machine: POSMachine, body) -> Dict[str, Any]:
    """
    What the device redeemed (idempotent by its own id). A redemption beyond what the cloud has left
    is recorded and flagged `over_use`; a `reversedAt` gives its units back. Never refused but for
    what is not this device's.
    """
    PV = _pv()
    now = PV._now()
    results = []
    touched: Dict[str, PrepaidVoucherOfflineAssignment] = {}
    _drop_moved(db, machine)
    for e in body.redemptions or []:
        rid = str(e.id).strip()
        # The device's own id, of this device (another device may well use the same).
        existing = (
            db.query(PrepaidVoucherRedemption)
            .filter(
                PrepaidVoucherRedemption.tenant_id == machine.tenant_id,
                PrepaidVoucherRedemption.machine_id == machine.id,
                PrepaidVoucherRedemption.client_redemption_id == rid,
            )
            .first()
        )
        a = db.query(PrepaidVoucherOfflineAssignment).filter(
            PrepaidVoucherOfflineAssignment.id == PV._as_uuid(e.assignment_id)).first() if e.assignment_id else None
        if a is None or a.machine_id != machine.id or str(a.tenant_id) != str(machine.tenant_id):
            results.append({"id": rid, "status": "rejected", "reason": "assignment_not_found"})
            continue
        touched[str(a.id)] = a
        voucher = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == PV._as_uuid(e.voucher_id)).with_for_update().first()
        if voucher is None or voucher.batch_id != a.batch_id:
            results.append({"id": rid, "status": "rejected", "reason": "voucher_not_found"})
            continue
        if existing is not None:
            if existing.voucher_id != voucher.id:
                # The same id for another voucher: never the stored row's to change.
                results.append({"id": rid, "status": "rejected", "reason": "id_conflict"})
                continue
            if e.reversed_at is not None and existing.reversed_at is None:
                _give_back(voucher, existing)
                existing.reversed_at = e.reversed_at
            if e.transaction_id and not existing.transaction_id:
                existing.transaction_id = str(e.transaction_id)[:100]
            results.append({"id": rid, "status": "duplicate"})
            continue
        batch = voucher.batch
        units = [u.model_dump(by_alias=True) if hasattr(u, "model_dump") else dict(u) for u in (e.units or [])]
        units = [{k: v for k, v in u.items() if k != "takenQuantity"} for u in units]  # the cloud's to say
        flags: List[str] = []
        reversed_at = e.reversed_at
        grouped = (getattr(batch, "selection", None) or "items") == "groups"
        if reversed_at is None:
            # What it really takes: never below 0; a unit cut short records it (`takenQuantity`).
            from app.services.production_voucher_reserve import take_units

            remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
            if take_units(remaining, units, grouped) or voucher.status in ("used", "cancelled"):
                flags.append("over_use")
            voucher.remaining = {k: PV.qty_out(v) for k, v in remaining.items()}
            left = [v for k, v in remaining.items() if k != "total"]
            if voucher.status == "cancelled":
                flags.append("cancelled")  # recorded (a fiscal fact), the voucher stays cancelled
            else:
                voucher.status = "used" if (not any(v > 0 for v in left) or remaining.get("total", Decimal(1)) <= 0) else "partially_used"
            voucher.first_redeemed_at = voucher.first_redeemed_at or e.redeemed_at or now
            voucher.last_redeemed_at = e.redeemed_at or now
        else:
            # Synced already undone: nothing was taken, nothing comes back.
            for u in units:
                u["takenQuantity"] = 0
        if e.sale_ref and reversed_at is None:
            others = (
                db.query(PrepaidVoucherRedemption)
                .filter(PrepaidVoucherRedemption.machine_id == machine.id, PrepaidVoucherRedemption.sale_ref == e.sale_ref,
                        PrepaidVoucherRedemption.reversed_at.is_(None), PrepaidVoucherRedemption.voucher_id != voucher.id)
                .all()
            )
            if others:
                ins = [PV._in_sale(o.voucher) for o in others if o.voucher is not None]
                if PV.RULES.stacking_refusal(ins, PV._in_sale(voucher)):
                    flags.append("stacking")  # a fiscal fact by now: recorded, flagged
        if a.status == "released":
            flags.append("after_release")  # a fiscal fact made before the device learned: recorded, flagged
        approval = e.approval
        if approval is not None and not PV.approval_valid(db, machine, approval):
            flags.append("approval_invalid")
        from app.services.prepaid_voucher_controls import redemption_flags as controls_flags  # §18 hook (helper)

        flags += controls_flags(db, machine, voucher, now, at=e.redeemed_at or now) if reversed_at is None else []
        r = PrepaidVoucherRedemption(
            id=uuid.uuid4(), tenant_id=voucher.tenant_id, voucher_id=voucher.id, batch_id=batch.id, machine_id=machine.id,
            shop_id=machine.shop_id, pos_user_id=(str(e.pos_user_id) if e.pos_user_id is not None else None),
            pos_user_name=e.pos_user_name, client_request_id=f"offline:{rid}", transaction_id=(e.transaction_id or None),
            sale_ref=e.sale_ref, items=[{"productId": u.get("productId"), "name": u.get("productName"),
                                          "quantity": u.get("quantity")} for u in units],
            redeemed_at=e.redeemed_at or now, reversed_at=reversed_at, flags=flags or None,
            redemption_accounting=e.redemption_accounting or getattr(batch, "redemption_accounting", None),
            pricing=getattr(batch, "pricing", None), units=units,
            value_agorot=sum(int(u.get("valueAgorot") or 0) for u in units) or None,
            covered_agorot=int(e.covered_agorot or 0), top_up_agorot=int(e.top_up_agorot or 0),
            list_value_agorot=sum(int(u.get("listValueAgorot") or 0) for u in units) or None,
            serial=int(voucher.serial), type_name=PV._type_name_of(db, batch), production_name=batch.customer_name,
            batch_name=batch.name, offline=True, assignment_id=a.id, client_redemption_id=rid,
            approved_by_pos_user_id=(approval.pos_user_id if approval else None),
            approved_by_pos_user_name=(approval.pos_user_name if approval else None),
        )
        r.flags = flags or None
        db.add(r)
        results.append({"id": rid, "status": "accepted", **({"flags": flags} if flags else {})})
    for a in touched.values():
        a.last_sync_at = now
        a.last_sync_pending = int(body.pending or 0)
    for a in db.query(PrepaidVoucherOfflineAssignment).filter(
        PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status.in_(LIVE),
    ):
        a.last_sync_at = now
        a.last_sync_pending = int(body.pending or 0)
    # The release's second step: the device acknowledges with nothing left to send.
    acks = {str(x).strip() for x in (getattr(body, "release_ack", None) or [])}
    for a in db.query(PrepaidVoucherOfflineAssignment).filter(
        PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status == "releasing",
    ):
        if str(a.id) in acks and int(body.pending or 0) == 0:
            batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == a.batch_id).first()
            if batch is not None:
                _complete(db, batch, a, None, forced=False, reason=None)
    db.flush()
    return {"results": results, "pending": int(body.pending or 0), "assignments": assignments_out(db, machine)}


def _give_back(voucher: PrepaidVoucher, r: PrepaidVoucherRedemption) -> None:
    """Only what [r] really took goes back (prepaid_vouchers.give_back); a cancelled voucher stays cancelled."""
    PV = _pv()
    PV.give_back(voucher, r)
    if voucher.status == "used":
        voucher.status = "partially_used"
