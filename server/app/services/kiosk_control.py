"""
The self-order kiosk: devices, status, orders, commands, controllers and settings layers.

* **Devices.** A kiosk is a paired, assigned till with a `kiosk_devices` row. Converting
  needs an active till assigned to a shop (409 `machine_not_assigned`), not already a kiosk
  (409 `already_kiosk`). Deleting the row makes it a regular till again; its orders and
  the command audit stay. `enabled: false` keeps the kiosk's settings but the till is told
  `kiosk: false` on its sync, i.e. it works as a regular till until enabled again.
* **Controllers.** Tills that may pause / resume / close / Z a kiosk from their own screen:
  same tenant and company, active, never the kiosk itself, never another kiosk — else
  422 `invalid_controller:<id>`. A till not in the list gets 403 `not_kiosk_controller`
  (across tenants too).
* **Status.** The kiosk reports on `POST /sync/{id}/kiosk/sync`; the cleaned snapshot is
  kept on the device row (replaced whole, like the heartbeat's printer block).
* **Orders.** Upserted by (machine, localId). The snapshot is written once; afterwards only
  `bon_status`, `bon_detail`, `receipt_status`, `status` (and a `transaction_id` /
  `transaction_number` the first post did not have yet) change.
* **Commands.** pause / resume apply at once. close_shift and till_z go through the
  EXISTING channels — `shift_close_requests.request_close` and
  `till_z.request_for_machine` (Ably now, the heartbeat otherwise) — and their refusals
  pass through as the answer. Every command, refused or not, is audited (`kiosk_commands`).
* **Scope** (dashboard): read and write by a super admin, a distributor (own tills), a
  company manager (company tree), a shop manager (own shop); never a cashier or a shift
  supervisor.
"""
from __future__ import annotations

import types
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.kiosk import KioskCommand, KioskDevice, KioskOrder, KioskSettings
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.kiosk import KioskOrderIn
from app.services import kiosk_config as cfgsvc
from app.services.company_hierarchy import user_covers_company, user_may_use_machine, visible_shop_ids
from app.services.machine_status import is_online, local_today

#: Every dashboard role that may see (and, being a machine admin, change) kiosks.
KIOSK_ROLES = frozenset({
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.SHOP_MANAGER,
})
#: Who sees a customer's phone in full on the orders list.
FULL_PHONE_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.COMPANY_MANAGER})

FLOW_STATES = ("attract", "ordering", "paying", "success", "paused", "closed", "admin")
BON_PRINTER_STATES = ("ok", "warn", "error", "none")

NOT_KIOSK_CONTROLLER = "not_kiosk_controller"
KIOSK_NOT_FOUND = "kiosk_not_found"
NOT_A_KIOSK = "not_a_kiosk"


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _forbidden(detail: str = "Access denied") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def user_name(user: Any) -> str:
    return getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))


# ── Dashboard scope ──────────────────────────────────────────────────────────


def require_kiosk_role(user: User) -> None:
    if getattr(user, "role", None) not in KIOSK_ROLES:
        raise _forbidden()


def _same_tenant(entity_tenant_id, tenant_id) -> None:
    if entity_tenant_id is not None and tenant_id is not None and str(entity_tenant_id) != str(tenant_id):
        raise _forbidden("tenant_forbidden")


def check_machine_scope(db: Session, user: User, machine: POSMachine, tenant_id) -> None:
    """The machines page's rule: a distributor's own tills, a company manager's tree, a shop manager's shop."""
    require_kiosk_role(user)
    _same_tenant(machine.tenant_id, tenant_id)
    if user.role == UserRole.DISTRIBUTOR:
        if str(machine.distributor_id) != str(user.id):
            raise _forbidden()
    elif not user_may_use_machine(db, user, machine):
        raise _forbidden()


def check_shop_scope(db: Session, user: User, shop: Shop, tenant_id) -> None:
    require_kiosk_role(user)
    _same_tenant(shop.tenant_id, tenant_id)
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, shop.company_id):
        return
    if user.role == UserRole.SHOP_MANAGER and str(shop.id) == str(user.shop_id):
        return
    raise _forbidden()


def check_company_scope(db: Session, user: User, company: Company, tenant_id) -> None:
    require_kiosk_role(user)
    _same_tenant(company.tenant_id, tenant_id)
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, company.id):
        return
    raise _forbidden()


def _scoped_machine_query(db: Session, user: User, tenant_id):
    query = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
    if user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == user.id)
    elif user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, user)))
    elif user.role == UserRole.SHOP_MANAGER:
        query = query.filter(POSMachine.shop_id == user.shop_id)
    elif user.role != UserRole.SUPER_ADMIN:
        raise _forbidden()
    return query


# ── Devices ──────────────────────────────────────────────────────────────────


def get_device(db: Session, machine_id: Any) -> Optional[KioskDevice]:
    mid = _uuid(machine_id)
    return db.get(KioskDevice, mid) if mid is not None else None


def is_kiosk(db: Session, machine: POSMachine) -> bool:
    return get_device(db, machine.id) is not None


def kiosk_for_dashboard(db: Session, user: User, machine_id: Any, tenant_id) -> Tuple[POSMachine, KioskDevice]:
    """The kiosk at `machine_id`, if this user may reach it: 404 `kiosk_not_found`, 403 out of scope."""
    mid = _uuid(machine_id)
    machine = db.get(POSMachine, mid) if mid is not None else None
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=KIOSK_NOT_FOUND)
    check_machine_scope(db, user, machine, tenant_id)
    device = get_device(db, machine.id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=KIOSK_NOT_FOUND)
    return machine, device


def _company_of(db: Session, machine: POSMachine) -> Optional[uuid.UUID]:
    shop = machine.shop if machine.shop_id is not None else None
    return shop.company_id if shop is not None else None


def _clean_name(name: Optional[str], fallback: str) -> str:
    cleaned = " ".join((name or "").split())
    return (cleaned or fallback or "קיוסק")[:100]


def validate_controllers(db: Session, kiosk_machine: POSMachine, ids: Optional[Sequence[Any]]) -> List[str]:
    """
    The controlling tills, deduped, as id strings: same tenant and company, active, not
    the kiosk itself, not another kiosk. Else 422 `invalid_controller:<id>`.
    """
    out: List[str] = []
    kiosk_company = _company_of(db, kiosk_machine)
    for raw in ids or []:
        mid = _uuid(raw)
        bad = HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid_controller:{raw}"
        )
        if mid is None or mid == kiosk_machine.id:
            raise bad
        till = db.get(POSMachine, mid)
        if (
            till is None
            or not till.is_active
            or till.shop_id is None
            or str(till.tenant_id) != str(kiosk_machine.tenant_id)
            or kiosk_company is None
            or str(_company_of(db, till)) != str(kiosk_company)
            or get_device(db, till.id) is not None
        ):
            raise bad
        if str(mid) not in out:
            out.append(str(mid))
    return out


def convert(
    db: Session,
    user: User,
    machine: POSMachine,
    *,
    name: Optional[str] = None,
    controller_ids: Optional[Sequence[Any]] = None,
    lock_device: bool = False,
    now: Optional[datetime] = None,
) -> KioskDevice:
    """Make this till a self-order kiosk. The caller commits (and notifies, see `lock_device_targets`)."""
    if get_device(db, machine.id) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="already_kiosk")
    if (
        not machine.is_active
        or machine.pairing_status != PairingStatus.ASSIGNED
        or machine.shop_id is None
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    controllers = validate_controllers(db, machine, controller_ids)
    device = KioskDevice(
        machine_id=machine.id,
        tenant_id=machine.tenant_id,
        shop_id=machine.shop_id,
        company_id=_company_of(db, machine),
        name=_clean_name(name, machine.name),
        enabled=True,
        paused=False,
        controller_machine_ids=controllers,
        created_at=_now(now),
        created_by_user_id=getattr(user, "id", None),
    )
    db.add(device)
    # A kiosk controls nothing: drop it from every other kiosk's controllers.
    for other in db.query(KioskDevice).filter(
        KioskDevice.tenant_id == machine.tenant_id, KioskDevice.machine_id != machine.id
    ).all():
        ids = [i for i in (other.controller_machine_ids or []) if str(i) != str(machine.id)]
        if ids != list(other.controller_machine_ids or []):
            other.controller_machine_ids = ids
    if lock_device:
        set_device_lock(db, machine, now=now)
    db.flush()
    return device


def update(
    db: Session,
    machine: POSMachine,
    device: KioskDevice,
    *,
    name: Optional[str] = None,
    enabled: Optional[bool] = None,
    controller_ids: Optional[Sequence[Any]] = None,
) -> KioskDevice:
    if controller_ids is not None:
        device.controller_machine_ids = validate_controllers(db, machine, controller_ids)
    if name is not None:
        device.name = _clean_name(name, machine.name)
    if enabled is not None:
        device.enabled = bool(enabled)
    db.flush()
    return device


def remove(db: Session, device: KioskDevice) -> None:
    """Back to a regular till. Orders, the audit and the settings layer stay."""
    db.delete(device)
    db.flush()


def set_device_lock(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> None:
    """
    The Android device lock for this till: the machine-level value `kioskMode = true` of
    the existing till parameter (app/services/till_parameters.py). The caller commits and
    then notifies the till (`lock_device_targets`).
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == "kioskMode").first()
    if parameter is None:  # pragma: no cover - created just above
        return
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        )
        .first()
    )
    if row is None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine.id, value=True,
        ))
    else:
        row.value = True
    # Moves the tills' parameters watermark, so the till pulls it on its next sync.
    parameter.updated_at = _now(now)


def notify_device_lock(machine: POSMachine) -> None:
    """After the commit: tell the till its parameters changed (Ably; a no-op without it)."""
    from app.services.till_parameters import publish_parameters_notify

    if machine.tenant_id:
        try:
            publish_parameters_notify([(str(machine.tenant_id), str(machine.id))])
        except Exception:  # noqa: BLE001 - the till's next sync pulls it anyway
            pass


# ── Business date ────────────────────────────────────────────────────────────


def business_today(db: Session, tenant_id, *, now: Optional[datetime] = None) -> date:
    """Today where the tenant is (`resolve_report_timezone`); UTC for a zone that cannot be read."""
    from app.services.reports import resolve_report_timezone

    return local_today(resolve_report_timezone(db, tenant_id, None), now=now)


# ── Summaries ────────────────────────────────────────────────────────────────


def _status_of(device: KioskDevice) -> Dict[str, Any]:
    return device.status if isinstance(device.status, dict) else {}


def summaries(db: Session, devices: Sequence[KioskDevice], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """KioskSummary for each device (contract §2.2), batched."""
    from app.services import till_z
    from app.services.shifts import open_shifts_for_machines

    devices = list(devices)
    if not devices:
        return []
    ids = [d.machine_id for d in devices]
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()}
    shop_ids = {m.shop_id for m in machines.values() if m.shop_id is not None}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}

    today_by_tenant: Dict[Any, date] = {}
    for d in devices:
        tid = machines[d.machine_id].tenant_id if d.machine_id in machines else d.tenant_id
        if tid not in today_by_tenant:
            today_by_tenant[tid] = business_today(db, tid, now=now)
    ids_by_date: Dict[date, List[uuid.UUID]] = {}
    for d in devices:
        tid = machines[d.machine_id].tenant_id if d.machine_id in machines else d.tenant_id
        ids_by_date.setdefault(today_by_tenant[tid], []).append(d.machine_id)
    today_totals: Dict[uuid.UUID, Tuple[int, int]] = {}
    for day, day_ids in ids_by_date.items():
        for mid, count, total in (
            db.query(KioskOrder.machine_id, func.count(KioskOrder.id), func.coalesce(func.sum(KioskOrder.total_agorot), 0))
            .filter(KioskOrder.machine_id.in_(day_ids), KioskOrder.business_date == day)
            .group_by(KioskOrder.machine_id)
            .all()
        ):
            today_totals[mid] = (int(count), int(total or 0))
    last_order = dict(
        db.query(KioskOrder.machine_id, func.max(KioskOrder.paid_at))
        .filter(KioskOrder.machine_id.in_(ids))
        .group_by(KioskOrder.machine_id)
        .all()
    )
    open_shifts = open_shifts_for_machines(db, ids)

    controller_ids = {
        _uuid(c) for d in devices for c in (d.controller_machine_ids or []) if _uuid(c) is not None
    }
    controller_names = (
        {m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(list(controller_ids))).all()}
        if controller_ids
        else {}
    )

    out = []
    for d in devices:
        machine = machines.get(d.machine_id)
        if machine is None:  # pragma: no cover - FK
            continue
        shop = shops.get(machine.shop_id)
        st = _status_of(d)
        cfg = cfgsvc.effective_config(db, machine)
        version = cfgsvc.config_version(cfg)
        count, total = today_totals.get(d.machine_id, (0, 0))
        if isinstance(st.get("shiftOpen"), bool):
            shift_open = st["shiftOpen"]
        else:
            shift_open = d.machine_id in open_shifts or machine.reported_open_shift_id is not None
        controllers = [str(c) for c in (d.controller_machine_ids or [])]
        out.append({
            "machineId": str(machine.id),
            "name": d.name,
            "machineName": machine.name,
            "posNumber": machine.pos_number,
            "shopId": str(machine.shop_id) if machine.shop_id else None,
            "shopName": shop.name if shop is not None else None,
            "companyId": str(shop.company_id) if shop is not None else (str(d.company_id) if d.company_id else None),
            "enabled": bool(d.enabled),
            "online": is_online(machine.last_heartbeat_at, now=now),
            "lastSeenAt": _iso(machine.last_heartbeat_at),
            "lastKioskSyncAt": _iso(d.last_kiosk_sync_at),
            "appliedConfigVersion": d.applied_config_version,
            "configVersion": version,
            "configUpToDate": d.applied_config_version == version,
            "fulfillmentMode": cfg["general"]["fulfillmentMode"],
            "paused": bool(d.paused),
            "pauseMessage": d.pause_message,
            "pausedAt": _iso(d.paused_at),
            "pausedBy": d.paused_by,
            "flowState": st.get("flowState"),
            "shiftOpen": bool(shift_open),
            "zMode": till_z.z_mode_of(machine),
            "printerStatus": machine.printer_status,
            "bonPrinter": st.get("bonPrinter"),
            "mediaReady": st.get("mediaReady"),
            "mediaMissing": st.get("mediaMissing"),
            "ordersToday": count,
            "salesTodayAgorot": total,
            "lastOrderAt": _iso(last_order.get(d.machine_id)) or st.get("lastOrderAt"),
            "unprintedBons": st.get("unprintedBons"),
            "pendingOrders": st.get("pendingOrders"),
            "controllerMachineIds": controllers,
            "controllers": [
                {"machineId": c, "name": controller_names.get(_uuid(c))} for c in controllers
            ],
        })
    return out


def summary(db: Session, device: KioskDevice, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    return summaries(db, [device], now=now)[0]


def list_kiosks(
    db: Session, user: User, tenant_id, *, company_id=None, shop_id=None, now: Optional[datetime] = None
) -> List[Dict[str, Any]]:
    require_kiosk_role(user)
    machine_ids = _scoped_machine_query(db, user, tenant_id).with_entities(POSMachine.id)
    if shop_id is not None:
        machine_ids = machine_ids.filter(POSMachine.shop_id == shop_id)
    if company_id is not None:
        machine_ids = machine_ids.filter(POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id == company_id)))
    devices = (
        db.query(KioskDevice)
        .filter(KioskDevice.machine_id.in_(machine_ids))
        .order_by(KioskDevice.name, KioskDevice.machine_id)
        .all()
    )
    return summaries(db, devices, now=now)


def candidates(db: Session, user: User, tenant_id, *, shop_id=None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Tills that could become a kiosk: assigned, active, in scope, not a kiosk already."""
    require_kiosk_role(user)
    query = (
        _scoped_machine_query(db, user, tenant_id)
        .filter(
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.shop_id.isnot(None),
            ~POSMachine.id.in_(db.query(KioskDevice.machine_id)),
        )
    )
    if shop_id is not None:
        query = query.filter(POSMachine.shop_id == shop_id)
    machines = query.order_by(POSMachine.shop_id, POSMachine.pos_number, POSMachine.name).all()
    shop_ids = {m.shop_id for m in machines}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
    return [
        {
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "shopId": str(m.shop_id),
            "shopName": shops[m.shop_id].name if m.shop_id in shops else None,
            "online": is_online(m.last_heartbeat_at, now=now),
        }
        for m in machines
    ]


# ── The kiosk's sync ─────────────────────────────────────────────────────────


def _clean_int(value: Any, lo: int = 0, hi: int = 10**12) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = int(value)
    return value if lo <= value <= hi else None


def _clean_str(value: Any, max_len: int) -> Optional[str]:
    return value[:max_len] if isinstance(value, str) else None


def clean_status(raw: Any) -> Dict[str, Any]:
    """
    The kiosk's status report, cleaned: known keys only, wrong types dropped, an unknown
    enum value stored as "unknown" (a status is never a reason to refuse the sync).
    """
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}

    def enum(key: str, values: Sequence[str]) -> None:
        if key in raw and raw[key] is not None:
            out[key] = raw[key] if raw[key] in values else "unknown"

    def boolean(key: str) -> None:
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]

    def integer(key: str) -> None:
        v = _clean_int(raw.get(key))
        if v is not None:
            out[key] = v

    def string(key: str, max_len: int) -> None:
        v = _clean_str(raw.get(key), max_len)
        if v is not None:
            out[key] = v

    enum("flowState", FLOW_STATES)
    boolean("shiftOpen")
    string("appliedConfigVersion", 32)
    boolean("mediaReady")
    integer("mediaMissing")
    integer("mediaBytes")
    enum("bonPrinter", BON_PRINTER_STATES)
    string("receiptPrinter", 32)
    integer("ordersToday")
    integer("salesTodayAgorot")
    if raw.get("lastOrderAt") is None and "lastOrderAt" in raw:
        out["lastOrderAt"] = None
    else:
        v = _clean_str(raw.get("lastOrderAt"), 40)
        if v is not None:
            out["lastOrderAt"] = v
    integer("pendingOrders")
    integer("unprintedBons")
    string("appVersion", 64)
    return out


def controlled_devices(db: Session, till: POSMachine) -> List[KioskDevice]:
    """The kiosks this till may control (its id in their controllers, same tenant)."""
    if till.tenant_id is None:
        return []
    devices = (
        db.query(KioskDevice)
        .join(POSMachine, POSMachine.id == KioskDevice.machine_id)
        .filter(KioskDevice.tenant_id == till.tenant_id, POSMachine.is_active.is_(True))
        .order_by(KioskDevice.name, KioskDevice.machine_id)
        .all()
    )
    return [d for d in devices if str(till.id) in {str(c) for c in (d.controller_machine_ids or [])}]


def state_of(device: KioskDevice) -> Dict[str, Any]:
    return {
        "paused": bool(device.paused),
        "message": device.pause_message if device.paused else None,
        "since": _iso(device.paused_at) if device.paused else None,
        "by": device.paused_by if device.paused else None,
    }


def kiosk_sync(db: Session, machine: POSMachine, raw_status: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`POST /sync/{id}/kiosk/sync`: every till may call it; a non-kiosk gets `kiosk: false`. The caller commits."""
    now = _now(now)
    device = get_device(db, machine.id)
    if device is not None:
        if raw_status is not None:
            cleaned = clean_status(raw_status)
            device.status = cleaned
            if cleaned.get("appliedConfigVersion"):
                device.applied_config_version = cleaned["appliedConfigVersion"]
        device.last_kiosk_sync_at = now
        # The machine row is the authority on where the kiosk stands.
        if machine.shop_id is not None and device.shop_id != machine.shop_id:
            device.shop_id = machine.shop_id
            device.company_id = _company_of(db, machine)
        db.flush()
    controls = summaries(db, controlled_devices(db, machine), now=now)
    if device is None or not device.enabled:
        return {"kiosk": False, "serverTime": _iso(now), "controls": controls}
    bundle = cfgsvc.effective_bundle(db, machine)
    return {
        "kiosk": True,
        "serverTime": _iso(now),
        "machineId": str(machine.id),
        "name": device.name,
        "configVersion": bundle["configVersion"],
        "config": bundle["config"],
        "font": bundle["font"],
        "media": bundle["media"],
        "state": state_of(device),
        "kdsAvailable": cfgsvc.kds_available(),
        "controls": controls,
    }


def require_kiosk_device(db: Session, machine: POSMachine) -> KioskDevice:
    device = get_device(db, machine.id)
    if device is None:
        raise _forbidden(NOT_A_KIOSK)
    return device


# ── Orders ───────────────────────────────────────────────────────────────────

#: The columns a re-post may change; everything else is the snapshot of the first insert.
ORDER_MUTABLE = ("bon_status", "bon_detail", "receipt_status", "status")


def _reason(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "invalid"
    loc = ".".join(str(part) for part in errors[0].get("loc", ()) if part != "__root__")
    return f"invalid:{loc}" if loc else "invalid"


def upsert_orders(
    db: Session, machine: POSMachine, items: Iterable[Any], *, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """Upsert by (machine, localId). The caller commits."""
    now = _now(now)
    accepted: List[str] = []
    rejected: List[Dict[str, Any]] = []
    for raw in items:
        local_id = raw.get("localId") if isinstance(raw, dict) else None
        try:
            order = KioskOrderIn.model_validate(raw)
        except ValidationError as exc:
            rejected.append({"localId": local_id if isinstance(local_id, str) else None, "reason": _reason(exc)})
            continue
        row = (
            db.query(KioskOrder)
            .filter(KioskOrder.machine_id == machine.id, KioskOrder.local_id == order.local_id)
            .first()
        )
        if row is None:
            db.add(KioskOrder(
                id=uuid.uuid4(),
                tenant_id=machine.tenant_id,
                machine_id=machine.id,
                shop_id=machine.shop_id,
                local_id=order.local_id,
                transaction_id=order.transaction_id,
                transaction_number=order.transaction_number,
                pickup_number=order.pickup_number,
                pickup_label=order.pickup_label,
                business_date=order.business_date,
                service_type=order.service_type,
                table_ref=order.table_ref,
                fulfillment_mode=order.fulfillment_mode,
                config_version=order.config_version,
                customer_name=order.customer_name,
                customer_phone=order.customer_phone,
                item_count=order.item_count,
                total_agorot=order.total_agorot,
                tip_agorot=order.tip_agorot,
                paid_at=order.paid_at,
                bon_status=order.bon_status,
                bon_detail=order.bon_detail,
                receipt_status=order.receipt_status,
                status=order.status,
                created_at=now,
                updated_at=now,
            ))
        else:
            row.bon_status = order.bon_status
            row.bon_detail = order.bon_detail
            row.receipt_status = order.receipt_status
            row.status = order.status
            # The sale document may have reached the kiosk after its first post.
            if row.transaction_id is None and order.transaction_id:
                row.transaction_id = order.transaction_id
            if row.transaction_number is None and order.transaction_number:
                row.transaction_number = order.transaction_number
            row.updated_at = now
        db.flush()
        accepted.append(order.local_id)
    return {"accepted": accepted, "rejected": rejected}


def _mask_phone(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return phone
    return "*" * max(len(phone) - 3, 0) + phone[-3:]


def order_out(row: KioskOrder, *, full_phone: bool) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "localId": row.local_id,
        "machineId": str(row.machine_id),
        "shopId": str(row.shop_id) if row.shop_id else None,
        "transactionId": row.transaction_id,
        "transactionNumber": row.transaction_number,
        "pickupNumber": row.pickup_number,
        "pickupLabel": row.pickup_label,
        "businessDate": row.business_date.isoformat() if row.business_date else None,
        "serviceType": row.service_type,
        "tableRef": row.table_ref,
        "fulfillmentMode": row.fulfillment_mode,
        "configVersion": row.config_version,
        "customerName": row.customer_name,
        "customerPhone": row.customer_phone if full_phone else _mask_phone(row.customer_phone),
        "itemCount": row.item_count,
        "totalAgorot": row.total_agorot,
        "tipAgorot": row.tip_agorot,
        "paidAt": _iso(row.paid_at),
        "bonStatus": row.bon_status,
        "bonDetail": row.bon_detail,
        "receiptStatus": row.receipt_status,
        "status": row.status,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


def list_orders(db: Session, user: User, machine: POSMachine, day: Optional[date]) -> List[Dict[str, Any]]:
    day = day or business_today(db, machine.tenant_id)
    rows = (
        db.query(KioskOrder)
        .filter(KioskOrder.machine_id == machine.id, KioskOrder.business_date == day)
        .order_by(KioskOrder.paid_at.desc(), KioskOrder.local_id.desc())
        .all()
    )
    full = getattr(user, "role", None) in FULL_PHONE_ROLES
    return [order_out(r, full_phone=full) for r in rows]


# ── Commands ─────────────────────────────────────────────────────────────────


def controller_target(db: Session, till: POSMachine, kiosk_machine_id: Any) -> Tuple[POSMachine, KioskDevice]:
    """The kiosk a controlling till names: 404 `kiosk_not_found`, 403 `not_kiosk_controller`."""
    device = get_device(db, kiosk_machine_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=KIOSK_NOT_FOUND)
    allowed = {str(c) for c in (device.controller_machine_ids or [])}
    if (
        till.tenant_id is None
        or str(device.tenant_id) != str(till.tenant_id)
        or str(till.id) not in allowed
    ):
        raise _forbidden(NOT_KIOSK_CONTROLLER)
    kiosk_machine = db.get(POSMachine, device.machine_id)
    if kiosk_machine is None or not kiosk_machine.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=KIOSK_NOT_FOUND)
    return kiosk_machine, device


def till_actor(till: POSMachine, kiosk_machine: POSMachine, pos_user_name: Optional[str]) -> Any:
    """Who a till's command is filed under in the existing channels (they need a user-shaped actor)."""
    name = till.name if not pos_user_name else f"{till.name} · {pos_user_name}"
    return types.SimpleNamespace(id=kiosk_machine.distributor_id, username=name, email=None)


class CommandResult:
    """The audit row, and the refusal to answer with (an HTTPException or a TillZRefused) if any."""

    def __init__(self, command: KioskCommand, error: Optional[Exception] = None):
        self.command = command
        self.error = error


def run_command(
    db: Session,
    *,
    kiosk_machine: POSMachine,
    device: KioskDevice,
    action: str,
    message: Optional[str],
    force: bool,
    source: str,
    actor: Any,
    requested_by_user_id=None,
    requested_by_machine_id=None,
    requested_by_name: Optional[str] = None,
    now: Optional[datetime] = None,
) -> CommandResult:
    """
    Apply one command and audit it. A refusal of the existing channels rolls their work
    back, is audited as "refused" and handed back in `error`. The caller commits, then
    answers the refusal (if any) as it is.
    """
    from app.services import shift_close_requests, till_z

    now = _now(now)
    kiosk_id, tenant_id = kiosk_machine.id, kiosk_machine.tenant_id
    message = (message or "").strip() or None

    def audit(status_value: str, request_id=None, detail: Optional[str] = None) -> KioskCommand:
        row = KioskCommand(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            kiosk_machine_id=kiosk_id,
            action=action,
            message=message,
            force=bool(force),
            source=source,
            requested_by_user_id=requested_by_user_id,
            requested_by_machine_id=requested_by_machine_id,
            requested_by_name=(requested_by_name or None) and requested_by_name[:200],
            status=status_value,
            request_id=request_id,
            detail=detail,
            created_at=now,
        )
        db.add(row)
        db.flush()
        return row

    if action == "pause":
        device.paused = True
        device.pause_message = message
        device.paused_at = now
        device.paused_by = (requested_by_name or None) and requested_by_name[:200]
        return CommandResult(audit("applied"))
    if action == "resume":
        device.paused = False
        device.pause_message = None
        device.paused_at = None
        device.paused_by = None
        return CommandResult(audit("applied"))
    if action not in ("close_shift", "till_z"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_action")

    try:
        if action == "close_shift":
            req, created = shift_close_requests.request_close(db, actor, kiosk_machine, now=now)
        else:
            req, created = till_z.request_for_machine(db, actor, kiosk_machine, force=bool(force), now=now)
    except HTTPException as exc:
        db.rollback()
        return CommandResult(audit("refused", detail=str(exc.detail)), exc)
    except till_z.TillZRefused as refused:
        if refused.keep:
            db.commit()
        else:
            db.rollback()
        return CommandResult(audit("refused", detail=str(refused.body.get("detail"))), refused)
    return CommandResult(audit("requested", request_id=req.id, detail=None if created else "already_pending"))


def command_out(row: KioskCommand) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "action": row.action,
        "status": row.status,
        "requestId": str(row.request_id) if row.request_id else None,
        "detail": row.detail,
        "createdAt": _iso(row.created_at),
        "source": row.source,
        "requestedByName": row.requested_by_name,
    }


def list_commands(db: Session, kiosk_machine_id, limit: int = 20) -> List[Dict[str, Any]]:
    rows = (
        db.query(KioskCommand)
        .filter(KioskCommand.kiosk_machine_id == kiosk_machine_id)
        .order_by(KioskCommand.created_at.desc(), KioskCommand.id.desc())
        .limit(limit)
        .all()
    )
    return [command_out(r) for r in rows]


# ── Settings layers ──────────────────────────────────────────────────────────


class SettingsScope:
    """One layer's place: the entity, its tenant, and the ids along its path."""

    def __init__(self, level: str, entity, tenant_id, company_id=None, shop_id=None, machine_id=None):
        self.level, self.entity, self.tenant_id = level, entity, tenant_id
        self.company_id, self.shop_id, self.machine_id = company_id, shop_id, machine_id

    @property
    def entity_id(self):
        return {"company": self.company_id, "shop": self.shop_id, "machine": self.machine_id}[self.level]


def settings_scope(db: Session, user: User, level: str, scope_id: Any, tenant_id) -> SettingsScope:
    """Resolve `?level=&id=` and check this user may reach it (404 / 403)."""
    eid = _uuid(scope_id)
    if level == "company":
        company = db.get(Company, eid) if eid else None
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        check_company_scope(db, user, company, tenant_id)
        return SettingsScope("company", company, company.tenant_id, company_id=company.id)
    if level == "shop":
        shop = db.get(Shop, eid) if eid else None
        if shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
        check_shop_scope(db, user, shop, tenant_id)
        return SettingsScope("shop", shop, shop.tenant_id, company_id=shop.company_id, shop_id=shop.id)
    if level == "machine":
        machine, _device = kiosk_for_dashboard(db, user, eid, tenant_id)
        return SettingsScope(
            "machine", machine, machine.tenant_id,
            company_id=_company_of(db, machine), shop_id=machine.shop_id, machine_id=machine.id,
        )
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_level")


def _parent_layers(db: Session, scope: SettingsScope) -> List[Dict[str, Any]]:
    layers = cfgsvc.layers_for(db, company_id=scope.company_id, shop_id=scope.shop_id, machine_id=scope.machine_id)
    if scope.level == "company":
        return []
    if scope.level == "shop":
        return [layers.company]
    return [layers.company, layers.shop]


def settings_view(db: Session, scope: SettingsScope) -> Dict[str, Any]:
    row = cfgsvc.layer_row(db, scope.level, scope.entity_id)
    parents = _parent_layers(db, scope)
    overrides = cfgsvc.sanitize_stored_layer(row.overrides if row is not None else {})
    inherited = cfgsvc.resolve(*parents)
    effective = cfgsvc.resolve(*parents, overrides)
    updated_by = None
    if row is not None and row.updated_by_user_id is not None:
        user = db.get(User, row.updated_by_user_id)
        updated_by = user_name(user) if user is not None else None
    return {
        "level": scope.level,
        "id": str(scope.entity_id),
        "overrides": overrides,
        "inherited": inherited,
        "effective": effective,
        "configVersion": cfgsvc.config_version(effective),
        "updatedAt": _iso(row.updated_at) if row is not None else None,
        "updatedBy": updated_by,
        "updatedByUserId": str(row.updated_by_user_id) if row is not None and row.updated_by_user_id else None,
    }


def save_settings(
    db: Session, user: User, scope: SettingsScope, overrides: Any, *, now: Optional[datetime] = None
) -> KioskSettings:
    """
    Replace this level's layer. Validated on (parents ⊕ the new layer), so the cross-field
    rules hold on what a kiosk would get. Raises `KioskConfigInvalid`. The caller commits.
    """
    cleaned, errors = cfgsvc.validate_layer(overrides)
    merged = cfgsvc.merge(cfgsvc.resolve(*_parent_layers(db, scope)), cleaned)
    errors = cfgsvc._dedupe(list(errors) + cfgsvc.validate_config(merged))
    if errors:
        raise cfgsvc.KioskConfigInvalid(errors)
    row = cfgsvc.layer_row(db, scope.level, scope.entity_id)
    if row is None:
        row = KioskSettings(
            id=uuid.uuid4(),
            tenant_id=scope.tenant_id,
            level=scope.level,
            company_id=scope.company_id if scope.level == "company" else None,
            shop_id=scope.shop_id if scope.level == "shop" else None,
            machine_id=scope.machine_id if scope.level == "machine" else None,
        )
        db.add(row)
    row.overrides = cleaned
    row.updated_at = _now(now)
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    return row
