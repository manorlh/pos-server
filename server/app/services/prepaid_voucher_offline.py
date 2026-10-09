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


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def code_hash(code: str) -> str:
    """Lowercase hex SHA-256 of the normalized code (upper-case, no `PV:`, no dashes)."""
    return hashlib.sha256(_pv().normalize_code(code).encode("utf-8")).hexdigest()


def active_of(db: Session, batch_id) -> Optional[PrepaidVoucherOfflineAssignment]:
    return (
        db.query(PrepaidVoucherOfflineAssignment)
        .filter(PrepaidVoucherOfflineAssignment.batch_id == batch_id, PrepaidVoucherOfflineAssignment.status == "active")
        .first()
    )


def refuse_if_assigned(db: Session, batch: PrepaidVoucherBatch) -> None:
    """A batch cannot stop allowing offline redemption while it is assigned somewhere."""
    if active_of(db, batch.id) is not None:
        raise _pv()._http(status.HTTP_409_CONFLICT, OFFLINE_ASSIGNED)


def assigned_elsewhere(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch) -> Optional[str]:
    """The device's name when [batch] is assigned to another machine than [machine]; None otherwise."""
    if not getattr(batch, "offline_allowed", False):
        return None
    a = active_of(db, batch.id)
    if a is None or a.machine_id == machine.id:
        return None
    return db.query(POSMachine.name).filter(POSMachine.id == a.machine_id).scalar() or "קופה אחרת"


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
    if not getattr(batch, "offline_allowed", False):
        raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_NOT_ALLOWED)
    if target not in TARGETS:
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, "target must be machine or lan_host")
    eligible = set(_eligible_shops(db, user, tenant_id, batch))
    if target == "machine":
        machine = db.query(POSMachine).filter(POSMachine.id == PV._as_uuid(machine_id)).first() if machine_id else None
        if machine is None or str(machine.tenant_id) != str(tenant_id):
            raise PV._http(status.HTTP_404_NOT_FOUND, "machine_not_found")
        # Only a device of a shop the batch is valid in — and one the user sees.
        if str(machine.shop_id) not in eligible:
            raise PV._http(status.HTTP_409_CONFLICT, WRONG_SHOP)
    else:
        if shop_id and str(PV._as_uuid(shop_id)) not in eligible:
            raise PV._http(status.HTTP_409_CONFLICT, WRONG_SHOP)
        from app.services.main_till import main_till_of_shop

        shop = PV._as_uuid(shop_id) or (PV._as_uuid(batch.shop_ids[0]) if batch.shop_ids and len(batch.shop_ids) == 1 else None)
        machine = main_till_of_shop(db, shop) if shop else None
        if machine is None:
            raise PV._http(status.HTTP_409_CONFLICT, NO_MAIN_TILL)
    current = active_of(db, batch.id)
    if current is not None:
        if current.machine_id == machine.id and current.target == target:
            return _out(db, current)  # the same target again: the assignment as it is
        raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_ASSIGNED)
    a = PrepaidVoucherOfflineAssignment(
        id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, target=target, machine_id=machine.id,
        shop_id=machine.shop_id, status="active", version=1, assigned_by=getattr(user, "id", None), assigned_at=PV._now(),
    )
    db.add(a)
    PV._event(db, batch, user, "offline_assign", details={"target": target, "machineId": str(machine.id)})
    db.flush()
    return _out(db, a)


def release(db: Session, user: User, tenant_id, batch_id, force: bool = False, reason: Optional[str] = None) -> Dict[str, Any]:
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    a = active_of(db, batch.id)
    if a is None:
        return {"assignment": None}
    synced = (
        a.last_download_at is None
        or (a.last_sync_at is not None and a.last_sync_at >= a.last_download_at and int(a.last_sync_pending or 0) == 0)
    )
    if not synced and not force:
        raise PV._http(status.HTTP_409_CONFLICT, OFFLINE_PENDING)
    if force and not synced and not (reason or "").strip():
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, REASON_REQUIRED)
    now = PV._now()
    a.status = "released"
    a.released_at = now
    a.released_by = getattr(user, "id", None)
    a.forced = bool(force and not synced)
    a.release_reason = (reason or "").strip() or None
    PV._event(db, batch, user, "offline_force_release" if a.forced else "offline_release",
              reason=a.release_reason, details={"assignmentId": str(a.id), "pending": a.last_sync_pending})
    db.flush()
    return {"assignment": _out(db, a)}


def history(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    rows = (
        db.query(PrepaidVoucherOfflineAssignment)
        .filter(PrepaidVoucherOfflineAssignment.batch_id == batch.id)
        .order_by(PrepaidVoucherOfflineAssignment.assigned_at.desc())
        .all()
    )
    active = next((r for r in rows if r.status == "active"), None)
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
        frozen = {g["key"]: g.get("frozenProductIds") or [] for g in (batch.groups or [])}
        for g in out["groups"]:
            g["frozenIds"] = frozen.get(g["key"], [])
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
    return out


def download(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """What is assigned to [machine]: the batches' terms and their vouchers by code hash."""
    PV = _pv()
    now = PV._now()
    out = []
    for a in db.query(PrepaidVoucherOfflineAssignment).filter(
        PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status == "active",
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
    for e in body.redemptions or []:
        rid = str(e.id).strip()
        existing = (
            db.query(PrepaidVoucherRedemption)
            .filter(PrepaidVoucherRedemption.tenant_id == machine.tenant_id, PrepaidVoucherRedemption.client_redemption_id == rid)
            .first()
        )
        a = db.query(PrepaidVoucherOfflineAssignment).filter(
            PrepaidVoucherOfflineAssignment.id == PV._as_uuid(e.assignment_id)).first() if e.assignment_id else None
        if a is None or a.machine_id != machine.id:
            results.append({"id": rid, "status": "rejected", "reason": "assignment_not_found"})
            continue
        touched[str(a.id)] = a
        voucher = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == PV._as_uuid(e.voucher_id)).with_for_update().first()
        if voucher is None or voucher.batch_id != a.batch_id:
            results.append({"id": rid, "status": "rejected", "reason": "voucher_not_found"})
            continue
        if existing is not None:
            if e.reversed_at is not None and existing.reversed_at is None:
                _give_back(voucher, existing)
                existing.reversed_at = e.reversed_at
            if e.transaction_id and not existing.transaction_id:
                existing.transaction_id = str(e.transaction_id)[:100]
            results.append({"id": rid, "status": "duplicate"})
            continue
        batch = voucher.batch
        units = [u.model_dump(by_alias=True) if hasattr(u, "model_dump") else dict(u) for u in (e.units or [])]
        flags: List[str] = []
        remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
        grouped = (getattr(batch, "selection", None) or "items") == "groups"
        for u in units:
            q = PV.qty(u.get("quantity") or 1)
            if grouped:
                pieces = q if q == q.to_integral_value() else Decimal(1)
                key = f"g:{u.get('groupKey')}"
                remaining[key] = remaining.get(key, Decimal(0)) - pieces
                remaining["total"] = remaining.get("total", Decimal(0)) - pieces
            else:
                pid = str(u.get("productId"))
                remaining[pid] = remaining.get(pid, Decimal(0)) - q
        if any(v < 0 for v in remaining.values()) or voucher.status in ("used", "cancelled"):
            flags.append("over_use")
        reversed_at = e.reversed_at
        if reversed_at is None:
            remaining = {k: max(Decimal(0), v) for k, v in remaining.items()}
            voucher.remaining = {k: PV.qty_out(v) for k, v in remaining.items()}
            left = [v for k, v in remaining.items() if k != "total"]
            voucher.status = "used" if (not any(v > 0 for v in left) or remaining.get("total", Decimal(1)) <= 0) else "partially_used"
            voucher.first_redeemed_at = voucher.first_redeemed_at or e.redeemed_at or now
            voucher.last_redeemed_at = e.redeemed_at or now
        approval = e.approval
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
        db.add(r)
        results.append({"id": rid, "status": "accepted", **({"flags": flags} if flags else {})})
    for a in touched.values():
        a.last_sync_at = now
        a.last_sync_pending = int(body.pending or 0)
    if not touched:
        for a in db.query(PrepaidVoucherOfflineAssignment).filter(
            PrepaidVoucherOfflineAssignment.machine_id == machine.id, PrepaidVoucherOfflineAssignment.status == "active",
        ):
            a.last_sync_at = now
            a.last_sync_pending = int(body.pending or 0)
    db.flush()
    return {"results": results, "pending": int(body.pending or 0)}


def _give_back(voucher: PrepaidVoucher, r: PrepaidVoucherRedemption) -> None:
    PV = _pv()
    remaining = {k: PV.qty(v) for k, v in (voucher.remaining or {}).items()}
    grouped = (getattr(voucher.batch, "selection", None) or "items") == "groups"
    for u in r.units or []:
        q = PV.qty(u.get("quantity") or 1)
        if grouped:
            pieces = q if q == q.to_integral_value() else Decimal(1)
            key = f"g:{u.get('groupKey')}"
            remaining[key] = remaining.get(key, Decimal(0)) + pieces
            remaining["total"] = remaining.get("total", Decimal(0)) + pieces
        else:
            pid = str(u.get("productId"))
            remaining[pid] = remaining.get(pid, Decimal(0)) + q
    voucher.remaining = {k: PV.qty_out(v) for k, v in remaining.items()}
    if voucher.status == "used":
        voucher.status = "partially_used"
