import logging
from decimal import Decimal
import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, ConfigDict, Field
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session, object_session, selectinload
from sqlalchemy import or_, and_
from sqlalchemy.exc import IntegrityError
from app.services import licenses
from app.services import access
from app.services import device_profile
from app.services import display_devices
from app.services import device_identity
from app.services import device_management
from app.services import document_prefix
from app.services import lan_server
from app.services import support_z, till_reset
from app.database import get_db
from app.schemas.pos_machine import POSMachineUpdate, POSMachineResponse, MachineHeartbeatBody
from app.schemas.device_profile import DeviceProfileIn
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.user import User, UserRole
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.models.shift import Shift, ShiftStatus
from app.models.tenant import Tenant
from app.models.sync_log import SyncLog
from app.models.pairing_code import PairingCode
from app.models.device_pairing_request import DevicePairingRequest
from app.models.product import Product
from app.models.category import Category
from app.middleware.auth import (
    get_current_user,
    get_current_distributor,
    get_current_machine_admin,
    get_pos_machine_from_machine_token,
    get_active_tenant_id,
    ensure_same_tenant,
)
from app.services.sync import (
    update_machine_sync_timestamp,
    update_machine_heartbeat,
    get_catalog_change_watermark_for_machine,
)
from app.services.catalog_notify import notify_machine_catalog_changed
from app.routers.shops import _check_shop_access
from app.services.company_hierarchy import user_covers_company, visible_shop_ids
from app.services.shop_validation import shop_belongs_to_company
from app.services.realtime_info import (
    machine_realtime_connection_info,
    machine_realtime_refresh_info,
)
from app.services.machine_health import apply_printer_block
from app.services.machine_status import StatusInput, resolve_status
from app.services.administrative_close import close_shift_administratively
from app.services.pairing import create_pairing_code
from app.services.register_number import set_machine_shop
from app.services import areas, machine_catalog
from app.services.permission_matrix import SHOP_SCOPED_ROLES
from app.services.shifts import (
    find_open_shift,
    is_foreign_shift,
    open_shifts_for_machines,
    orphan_documents_by_machine,
    recent_shift_zs,
    refuse_leaving_shop_with_shifts,
    shift_to_out,
    z_reported_through_sequence,
)
from app.schemas.shift_close_request import ShiftCloseRequestOut
from app.services import shift_close_requests as close_requests
from app.services.remote_close import (
    close_shift_pending_machine_ids,
    pending_close_sources,
    take_pending_close_shift,
)
from app.services.z_runs import _reported_open_is_live, shop_z_fast_beat
from app.services import transmissions, transmit_requests
from app.services.terminal_status import (
    TerminalSettings,
    apply_terminal_block,
    machine_terminal_fields,
    terminal_settings_for,
)
from app.services import till_z, z_mode_policy
from app.schemas.till_z import MachineTillZIn, TillZRequestOut
from app.services.z_sequence import last_machine_z_number
from app.schemas.transmission import ReplacementCodeBody
from fastapi.responses import JSONResponse
from sqlalchemy import func

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/machines", tags=["machines"])


def _scope_machines_by_tenant(query, current_user: User, active_tenant_id):
    """Include legacy paired machines with null tenant_id for their pairing distributor."""
    if current_user.role == UserRole.DISTRIBUTOR:
        return query.filter(
            or_(
                POSMachine.tenant_id == active_tenant_id,
                and_(
                    POSMachine.tenant_id.is_(None),
                    POSMachine.distributor_id == current_user.id,
                ),
            )
        )
    return query.filter(POSMachine.tenant_id == active_tenant_id)


def _awaiting_z_by_machine(db: Session, machine_ids: List[uuid_mod.UUID]) -> Dict[uuid_mod.UUID, tuple]:
    """Per till: (count, oldest business date) of closed shifts no Z has taken yet."""
    if not machine_ids:
        return {}
    rows = (
        db.query(Shift.machine_id, func.count(Shift.id), func.min(Shift.business_date))
        .filter(
            Shift.machine_id.in_(machine_ids),
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
        )
        .group_by(Shift.machine_id)
        .all()
    )
    return {r[0]: (int(r[1]), r[2]) for r in rows}


def _tenant_timezones(db: Session, machines: List[POSMachine]) -> Dict[Any, Optional[str]]:
    ids = {m.tenant_id for m in machines if m.tenant_id is not None}
    if not ids:
        return {}
    return {
        t.id: t.timezone
        for t in db.query(Tenant).filter(Tenant.id.in_(list(ids))).all()
    }


def _enrich_machine_status(
    machine: POSMachine,
    db: Session,
    *,
    open_shifts_by_machine: Optional[Dict[uuid_mod.UUID, Shift]] = None,
    pending_close: Optional[Dict[uuid_mod.UUID, tuple]] = None,
    awaiting_z: Optional[Dict[uuid_mod.UUID, tuple]] = None,
    timezones: Optional[Dict[Any, Optional[str]]] = None,
    orphans: Optional[Dict[uuid_mod.UUID, int]] = None,
    untransmitted: Optional[Dict[uuid_mod.UUID, tuple]] = None,
    latest_transmissions: Optional[Dict[uuid_mod.UUID, dict]] = None,
    pending_transmit: Optional[Dict[uuid_mod.UUID, uuid_mod.UUID]] = None,
    terminal_settings: Optional[Dict[uuid_mod.UUID, TerminalSettings]] = None,
    kiosks: Optional[Dict[uuid_mod.UUID, Any]] = None,
) -> Dict[str, Any]:
    last_catalog_change_at = get_catalog_change_watermark_for_machine(db, machine)
    last_sync_at = machine.last_sync_at
    catalog_pull_stale = False
    if last_catalog_change_at is not None:
        if last_sync_at is None:
            catalog_pull_stale = True
        else:
            catalog_pull_stale = (last_sync_at + timedelta(seconds=5)) < last_catalog_change_at

    if open_shifts_by_machine is not None:
        open_td = open_shifts_by_machine.get(machine.id)
    else:
        open_td = find_open_shift(db, machine.id)

    if pending_close is None:
        pending_close = pending_close_sources(db, [machine.id])
    close_source, close_run_id = pending_close.get(machine.id, (None, None))
    close_shift_pending = close_source is not None

    if awaiting_z is None:
        awaiting_z = _awaiting_z_by_machine(db, [machine.id])
    awaiting_count, oldest_awaiting = awaiting_z.get(machine.id, (0, None))
    if timezones is None:
        timezones = _tenant_timezones(db, [machine])
    tz_name = timezones.get(machine.tenant_id)

    result: Dict[str, Any] = {
        "id": machine.id,
        "name": machine.name,
        "machineCode": machine.machine_code,
        "tenantId": machine.tenant_id,
        "shopId": machine.shop_id,
        "areaId": machine.area_id,
        "areaName": machine.area_name,
        "posNumber": machine.pos_number,
        # "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): its own, and the one in force.
        "documentPrefix": machine.document_prefix,
        "effectiveDocumentPrefix": machine.effective_document_prefix,
        # The till's shop and company by number: "חברה #N · סניף #M · קופה #K".
        "shopNumber": machine.shop.shop_number if machine.shop is not None else None,
        "companyNumber": (
            machine.shop.company.company_number
            if machine.shop is not None and machine.shop.company is not None
            else None
        ),
        "zMode": till_z.z_mode_of(machine),
        # Zs the till closed with no connection and has not uploaded, as it last said, and
        # whether one is held in a conflict for support (docs/SPEC_OFFLINE_TILL_Z.md §4.4).
        "offlineTillZPending": getattr(machine, "offline_till_z_pending", None),
        "offlineTillZConflict": bool(getattr(machine, "offline_till_z_conflict", False)),
        # Support produced this till's Z from the cloud (offline till Z §4.6), or null.
        "supportZ": getattr(machine, "support_z", None),
        # The last reset of the till's data support ordered from the cloud (§4.7), or null.
        "tillReset": getattr(machine, "till_reset", None),
        # "הוחלפה קופה" — every replacement of the till's device (offline till Z §4.6.2).
        "replacements": getattr(machine, "replacements", None) or [],
        # "קופה עצמאית" (docs/SPEC_INDEPENDENT_TILL.md).
        "independentTill": bool(getattr(machine, "independent_till", False)),
        "distributorId": machine.distributor_id,
        "mqttClientId": machine.mqtt_client_id,
        "pairingStatus": machine.pairing_status,
        "deviceInfo": machine.device_info,
        "deviceModel": machine.device_model,
        "hasPrinter": machine.has_printer,
        # False for a P18: it charges on a Nayax pinpad on the network (`pinpad*` below).
        "hasBuiltinTerminal": machine.has_builtin_terminal,
        # "סוג מכשיר" (docs/SPEC_DEVICE_ROLE_MODEL.md): till / kiosk, the model the dashboard
        # chose and the one the device named, the drawer port and "בקרוב" for LANDI / Feitian.
        **device_profile.machine_fields(
            machine,
            (kiosks if kiosks is not None else device_profile.kiosk_devices_by_machine(db, [machine.id])).get(machine.id),
        ),
        "isActive": machine.is_active,
        "lastHeartbeatAt": machine.last_heartbeat_at,
        "mqttConnected": machine.mqtt_connected,
        "appVersion": machine.app_version,
        "lastSyncAt": machine.last_sync_at,
        "serialNumber": machine.serial_number,
        # Passed through untouched. A null battery reading means the device could
        # not read it and must render as unknown, not as 0%.
        "batteryPercent": machine.battery_percent,
        "batteryStatus": machine.battery_status,
        "clockSkewMs": machine.clock_skew_ms,
        "lastHealthReportAt": machine.last_health_report_at,
        "lastCatalogChangeAt": last_catalog_change_at,
        "catalogPullStale": catalog_pull_stale,
        "shiftStatus": "open" if open_td is not None else "none",
        "openShiftId": open_td.id if open_td else None,
        "openShiftSequence": open_td.sequence_number if open_td else None,
        "businessDate": open_td.business_date if open_td else None,
        "openedAt": open_td.opened_at if open_td else None,
        "openedBy": open_td.opened_by if open_td else None,
        "closeShiftPending": close_shift_pending,
        # What is waiting for this till's close: a Z run (and which) or a standalone request.
        "pendingCloseSource": close_source,
        "pendingZRunId": close_run_id,
        "closedShiftsAwaitingZ": awaiting_count,
        # Only a claim a close could still answer: not a shift the cloud holds closed, and
        # not another till's (the same rule as the Z candidates).
        "reportedOpenShiftId": (
            machine.reported_open_shift_id
            if getattr(machine, "reported_open_shift_id", None) is not None
            and _reported_open_is_live(db, machine)
            else None
        ),
        "orphanDocuments": (
            orphans if orphans is not None else orphan_documents_by_machine(db, [machine.id])
        ).get(machine.id, 0),
        "createdAt": machine.created_at,
        "updatedAt": machine.updated_at,
    }

    # Card transmission (docs/SHIFTS_API.md §4.6): the till's reading beside our records.
    if untransmitted is None:
        untransmitted = transmissions.untransmitted_summary(db, [machine.id])
    if latest_transmissions is None:
        latest_transmissions = transmissions.latest_by_machine(db, [machine.id])
    if pending_transmit is None:
        pending_transmit = transmit_requests.pending_by_machine(db, [machine.id])
    tx_state = transmissions.machine_transmission(
        machine, untransmitted.get(machine.id), latest_transmissions.get(machine.id)
    )
    result.update(transmissions.machine_fields(tx_state))
    result["transmissionReportedAt"] = machine.transmission_reported_at
    result["transmissionSource"] = machine.transmission_source
    # Informational only (§4.2): the till assumes these went, the terminal never said.
    result["assumedTransmissionCount"] = machine.transmission_assumed_count
    result["transmitPending"] = machine.id in pending_transmit
    result["pendingTransmitRequestId"] = pending_transmit.get(machine.id)
    # The printer (docs/SHIFTS_API.md §1.6a), as the till last reported it.
    result["printerStatus"] = machine.printer_status
    result["printerErrorCode"] = machine.printer_error_code
    result["printerMessage"] = machine.printer_message
    result["printerStatusAt"] = machine.printer_status_at
    result["printerLastOkAt"] = machine.printer_last_ok_at
    result["printerReportedAt"] = machine.printer_reported_at
    # Device identity (app/services/device_identity.py): serial source, SIMs, addresses.
    result.update(device_identity.machine_fields(machine))
    # "עדכון שקט": device owner, update path, kiosk lock; the "הפעל מחדש" request.
    result.update(device_management.machine_fields(machine))
    # The card terminal: what Agamento reports beside the number the settings expect.
    if terminal_settings is None:
        terminal_settings = terminal_settings_for(db, [machine])
    result.update(
        machine_terminal_fields(machine, terminal_settings.get(machine.id) or TerminalSettings())
    )

    # Resolved server-side so the dashboard, the close-day gate and anything added later
    # all read one definition. The raw fields above stay, because a detail panel still
    # wants the underlying readings.
    resolved = resolve_status(
        StatusInput(
            is_active=bool(machine.is_active),
            pairing_status=(
                machine.pairing_status.value
                if hasattr(machine.pairing_status, "value")
                else machine.pairing_status
            ),
            last_heartbeat_at=machine.last_heartbeat_at,
            shift_open=open_td is not None,
            business_date=open_td.business_date if open_td else None,
            close_shift_pending=close_shift_pending,
            oldest_awaiting_z_date=oldest_awaiting,
            timezone_name=tz_name,
            pending_documents=machine.pending_documents,
            pending_count=machine.pending_count,
            pending_count_at=machine.pending_count_at,
            catalog_pull_stale=catalog_pull_stale,
            clock_skew_ms=machine.clock_skew_ms,
            battery_percent=machine.battery_percent,
            mqtt_connected=machine.mqtt_connected,
            transmission_pending=tx_state.anything_pending,
            transmission_oldest_pending_at=tx_state.oldest_pending_at,
            transmission_last_success_at=tx_state.last_transmission_at,
            transmission_tracking_started_at=tx_state.tracking_started_at,
            printer_status=machine.printer_status,
        )
    )
    result["status"] = resolved.status
    if resolved.status == "no_open_shift" and not display_devices.is_fiscal(machine):
        # A display device (a KDS / the board) has no shifts: it is up or down.
        result["status"] = "online" if resolved.online else "offline"
    result["online"] = resolved.online
    result["statusFlags"] = resolved.flags
    result["pendingDocuments"] = resolved.pending_documents
    result["pendingAsOf"] = resolved.pending_as_of
    return result


def _enrich_machines_batch(machines: List[POSMachine], db: Session) -> List[Dict[str, Any]]:
    if not machines:
        return []
    ids = [m.id for m in machines]
    open_shifts = open_shifts_for_machines(db, ids)
    pending = pending_close_sources(db, ids)
    awaiting = _awaiting_z_by_machine(db, ids)
    timezones = _tenant_timezones(db, machines)
    orphans = orphan_documents_by_machine(db, ids)
    untransmitted = transmissions.untransmitted_summary(db, ids)
    latest = transmissions.latest_by_machine(db, ids)
    pending_transmit = transmit_requests.pending_by_machine(db, ids)
    # Before the terminal settings: a kiosk has no built-in terminal (its pinpad is external),
    # and priming tells every machine at once rather than one lookup each.
    kiosks = device_profile.prime_kiosks(db, machines)
    terminal = terminal_settings_for(db, machines)
    return [
        _enrich_machine_status(
            m,
            db,
            open_shifts_by_machine=open_shifts,
            pending_close=pending,
            awaiting_z=awaiting,
            timezones=timezones,
            orphans=orphans,
            untransmitted=untransmitted,
            latest_transmissions=latest,
            pending_transmit=pending_transmit,
            terminal_settings=terminal,
            kiosks=kiosks,
        )
        for m in machines
    ]


def _check_machine_list_access(current_user: User, machine: POSMachine, db: Session) -> bool:
    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if current_user.role == UserRole.COMPANY_MANAGER and machine.shop_id:
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
        return shop is not None and user_covers_company(db, current_user, shop.company_id)
    if current_user.role in SHOP_SCOPED_ROLES:
        return machine.shop_id == current_user.shop_id
    return False


@router.get("", response_model=List[POSMachineResponse])
def list_machines(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    tenant_id: Optional[str] = Query(None, alias="tenantId"),
    distributor_id: Optional[str] = Query(None, alias="distributorId"),
    include_inactive: bool = Query(
        False,
        description="Include decommissioned (is_active=false) machines.",
    ),
    area_id: Optional[str] = Query(
        None,
        alias="areaId",
        description="An area's id, or `none` for machines in no area.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List machines (filtered by shop/tenant/role/distributor/area)."""
    area_filter = areas.parse_area_filter(area_id)
    query = db.query(POSMachine).options(selectinload(POSMachine.area))
    scope_tid = active_tenant_id
    if tenant_id:
        try:
            scope_tid = uuid_mod.UUID(str(tenant_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid tenantId")
    query = _scope_machines_by_tenant(query, current_user, scope_tid)

    if not include_inactive:
        query = query.filter(POSMachine.is_active.is_(True))

    if current_user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == current_user.id)
    elif current_user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, current_user)))
    elif current_user.role in SHOP_SCOPED_ROLES:
        query = query.filter(POSMachine.shop_id == current_user.shop_id)
    elif current_user.role != UserRole.SUPER_ADMIN:
        return []

    if shop_id:
        query = query.filter(POSMachine.shop_id == shop_id)
    if distributor_id:
        query = query.filter(POSMachine.distributor_id == distributor_id)
    query = areas.filter_on_column(query, POSMachine.area_id, area_filter)

    machines = query.offset(skip).limit(limit).all()
    return _enrich_machines_batch(machines, db)


@router.get("/unassigned", response_model=List[POSMachineResponse])
def list_unassigned_machines(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List unassigned paired machines (distributor/super_admin only)."""
    query = db.query(POSMachine).filter(
        POSMachine.pairing_status == PairingStatus.PAIRED,
        POSMachine.shop_id.is_(None),
    )
    query = _scope_machines_by_tenant(query, current_user, active_tenant_id)

    if current_user.role != UserRole.SUPER_ADMIN:
        query = query.filter(POSMachine.distributor_id == current_user.id)

    return query.all()


@router.get("/document-prefix-conflicts")
def list_document_prefix_conflicts(
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "קידומות מסמכים כפולות בעסק" (docs/SPEC_DOCUMENT_PREFIX.md §5): the active tills of the
    business — every shop of the company (`companyId`), or of the shop's company
    (`shopId`), and of companies under the same VAT number — whose prefix in force would
    repeat another document's number in the business's one open-format file. Each row
    names who else holds the prefix and the free prefix it would get
    (`POST /machines/{id}/document-prefix/assign-free`). A shop's own staff see their
    shop's tills only.
    """
    from app.models.company import Company
    from app.routers.companies import _check_company_access

    if shop_id:
        try:
            sid = uuid_mod.UUID(str(shop_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid shopId")
        shop = db.query(Shop).filter(Shop.id == sid).first()
        if not shop:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
        ensure_same_tenant(shop.tenant_id, active_tenant_id)
        _check_shop_access(current_user, shop, db)
        shop_ids = document_prefix.business_shop_ids(db, shop)
    elif company_id:
        try:
            cid = uuid_mod.UUID(str(company_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid companyId")
        company = db.query(Company).filter(Company.id == cid).first()
        if not company:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, active_tenant_id)
        _check_company_access(current_user, company, db)
        shop_ids = document_prefix.company_business_shop_ids(db, company)
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="companyId or shopId is required")
    rows = document_prefix.conflicts_in_shops(db, shop_ids)
    if current_user.role in SHOP_SCOPED_ROLES:
        rows = [r for r in rows if r["shopId"] == str(current_user.shop_id)]
    return {"conflicts": rows, "businessShopCount": len(shop_ids)}


@router.get("/me/ably-auth")
def get_my_ably_auth(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
):
    """POS desktop: Ably token (subscribe-only on this machine's channel)."""
    from app.services.ably_notify import create_token_request_for_machine, is_enabled

    if not is_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Realtime notify is not configured",
        )
    try:
        return create_token_request_for_machine(machine)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/me")
def get_my_machine(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """POS desktop: resolve shop/tenant and realtime (Ably) endpoint using machine JWT only."""
    shop = machine.shop
    company = shop.company if shop is not None else None
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        # Who and where the till is, for its menu header: the till's own name and
        # register number, and the names of its shop and that shop's company.
        "machineName": machine.name,
        "posNumber": machine.pos_number,
        # "קידומת מסמכים" in force (docs/SPEC_DOCUMENT_PREFIX.md): the till freezes it on
        # every document it issues and prints the prefix and the number padded to 7 digits. Null: none (no shop).
        "documentPrefix": machine.effective_document_prefix,
        "shopName": shop.name if shop is not None else None,
        "companyName": company.name if company is not None else None,
        # By number as well, for "חברה #N · סניף #M · קופה #K"; null without a shop.
        "shopNumber": shop.shop_number if shop is not None else None,
        "companyNumber": company.company_number if company is not None else None,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        # Shown beside the till's name and printed on its X (docs/AREAS_API.md §3).
        "area": areas.area_ref(machine.area),
        "pairingStatus": machine.pairing_status.value if hasattr(machine.pairing_status, "value") else machine.pairing_status,
        "mqttClientId": machine.mqtt_client_id,
        # The hardware, as the dashboard recorded it: "N55F" | "MODO" | null. A till with
        # `hasPrinter` false (a Modo) must not try to print; null reads as a 55F.
        "deviceModel": machine.device_model,
        "hasPrinter": machine.has_printer,
        # False (a P18): the till has no card terminal of its own and charges on a Nayax
        # pinpad on the network, at the address its settings carry (`nayaxDeviceHost`).
        "hasBuiltinTerminal": machine.has_builtin_terminal,
        # Whether the till opens a drawer on a port of its own (no model does today): false
        # leaves the built-in printer without a drawer; a receipt printer's stays.
        "hasCashDrawerPort": machine.has_cash_drawer_port,
        # "סוג מכשיר (תפקיד)" (docs/SPEC_DEVICE_ROLE_MODEL.md): the mode the till opens in —
        # "kiosk" for an enabled kiosk, else "till"; "kds" / "order_status_board" for a
        # display device. Read right after pairing, so a device added as a kiosk asks
        # `kiosk/sync` at once rather than on its 2-minute poll.
        "deviceRole": device_profile.effective_role(
            db if isinstance(db, Session) else object_session(machine), machine
        ),
        # False for a display device (a KDS / the "מוכן / לא מוכן" board): not a till — no
        # sales, shifts, Z or payments; every fiscal endpoint answers it 403 `device_not_fiscal`.
        "fiscal": display_devices.is_fiscal(machine),
        # "android" | "windows" (docs/SPEC_DEVICE_ROLE_MODEL.md §2.3).
        "platform": display_devices.platform_of(machine),
        # "לקוח זמני": the license end this till keeps (app/services/licenses.py).
        # Called directly (a test), `db` is its Depends default: the machine's own session.
        "license": licenses.effective_license(
            db if isinstance(db, Session) else object_session(machine), machine
        ),
        # "מצב הדרכה" (docs/SPEC_TRAINING_MODE.md): the shop's tills sell for practice.
        "trainingMode": bool(shop is not None and getattr(shop, "training_mode", False)),
        "trainingStartedAt": (
            shop.training_started_at.isoformat()
            if shop is not None and getattr(shop, "training_mode", False) and shop.training_started_at
            else None
        ),
        **machine_realtime_refresh_info(machine=machine),
    }


def _till_z_run(db: Session, machine: POSMachine) -> Dict[str, Any]:
    from app.services.z_sequence import current_machine_epoch

    epoch, started = current_machine_epoch(db, machine.id)
    return {"tillZEpoch": epoch, "tillZEpochStartedAt": started.isoformat() if started is not None else None}


@router.post("/me/heartbeat")
def post_my_heartbeat(
    body: MachineHeartbeatBody | None = None,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
    request: Request = None,
):
    """
    Till / POS desktop: periodic online signal over HTTP (replaces MQTT heartbeat publish).

    Also the channel for device health — serial, battery, clock skew — because it is
    the one call every terminal already makes on a timer whether or not anything has
    happened. Every field in the body is optional: an older till build sends a subset
    and must not be turned away.
    """
    update_machine_heartbeat(
        db,
        str(machine.id),
        mqtt_connected=body.mqtt_connected if body is not None else None,
        app_version=body.app_version if body is not None else None,
        serial_number=body.serial_number if body is not None else None,
        battery_percent=body.battery_percent if body is not None else None,
        battery_status=body.battery_status if body is not None else None,
        clock_skew_ms=body.clock_skew_ms if body is not None else None,
        pending_count=body.pending_count if body is not None else None,
        pending_documents=body.pending_documents if body is not None else None,
    )
    # "סוללה חלשה" (app/services/battery_alerts.py): a threshold crossed, cleared, routed to the tills.
    if body is not None and (body.battery_percent is not None or body.battery_status is not None):
        try:
            from app.services import battery_alerts

            battery_alerts.on_heartbeat(db, machine)
            db.commit()
        except Exception:  # noqa: BLE001 - a battery alert never fails a heartbeat
            logger.exception("battery alert failed for %s", machine.id)
            db.rollback()
    # The till's own account of its open shift, refreshed every beat. Absent means
    # "none open": the till's JSON encoder drops null fields, so a till with no shift
    # open sends no `openShiftId` at all. (A pre-shift build also sends none; it cannot
    # have a shift, so reading that as "none open" is also true.)
    if body is not None and body.open_shift_id_unreadable:
        # An `openShiftId` that could not be read says nothing: the stored claim stays
        # (wiping it would read as "no shift open" and hide a shift the cloud has not seen).
        logger.warning("machine %s sent an unreadable openShiftId; claim left as it was", machine.id)
    elif body is not None:
        claimed = body.open_shift_id
        if is_foreign_shift(db, machine, claimed):
            # Another till's shift (this till was re-paired as a new machine while it
            # was open). Not this till's open shift: kept, it would sit in the Z wizard
            # as "open, not in the cloud yet" forever, and a remote close for it could
            # never be accepted (its close is 403).
            logger.warning(
                "machine %s reported open shift %s, which belongs to another machine; ignored",
                machine.id, claimed,
            )
            claimed = None
        machine.reported_open_shift_id = claimed
        machine.reported_open_shift_opened_at = (
            body.open_shift_opened_at if claimed else None
        )
    # The pull half of a remote shift close. Every till calls this on a timer, so it is
    # the one channel that does not care whether the terminal was reachable when the
    # manager started the Z — a till that was off finds the instruction when it comes
    # back. Ably notifies an awake till instantly; this makes a missed notification a
    # delay rather than a close that never happens.
    pending = take_pending_close_shift(db, machine)
    # The till's card transmission state (docs/SHIFTS_API.md §4.2): a snapshot, replaced
    # whole when the beat carries one. And the pull half of "transmit now" (§4.4).
    if body is not None and body.transmission is not None:
        transmissions.apply_heartbeat_block(machine, body.transmission)
    # The till's printer (§1.6a), the same kind of snapshot.
    if body is not None and body.printer is not None:
        apply_printer_block(machine, body.printer)
    # The card terminal (Agamento), the same kind of snapshot.
    if body is not None and body.terminal is not None:
        apply_terminal_block(machine, body.terminal)
    # "עקיפת בדיקת מספר מסוף" as the till applies it (the dashboard shows it beside the cloud's).
    if body is not None and body.terminal_number_check_bypass is not None:
        from app.services.terminal_check_bypass import apply_heartbeat as _apply_bypass

        _apply_bypass(machine, body.terminal_number_check_bypass)
    # The serial's source, the SIMs and the address the beat came from (device search).
    device_identity.apply_heartbeat(machine, body, request)
    # Device owner and silent updates (app/services/device_management.py); never fails a beat.
    device_management.apply_heartbeat(machine, body)
    # The dashboard's "הפעל מחדש", while it waits (a device-owner till only; the till decides when).
    pending_reboot = device_management.take_pending_reboot(machine)
    # Zs closed at the till with no connection, not uploaded yet (offline till Z §4.4).
    if body is not None and body.offline_till_z is not None:
        till_z.apply_offline_report(machine, body.offline_till_z)
    # The till's document counters per series (offline till Z §4.6), for a replacement.
    if body is not None and body.document_counters:
        counters = {
            k: int(v) for k, v in body.document_counters.items()
            if k in ("320", "330", "400") and v is not None and 0 <= int(v) <= 10**18
        }
        if counters:
            # Never down (§4.7): per series, the highest the till ever said.
            held = getattr(machine, "reported_document_counters", None) or {}
            for series, value in held.items():
                try:
                    if series in counters and int(value) > counters[series]:
                        counters[series] = int(value)
                    elif series not in counters and series in ("320", "330", "400"):
                        counters[series] = int(value)
                except (TypeError, ValueError):
                    continue
            machine.reported_document_counters = counters
            machine.document_counters_reported_at = datetime.now(timezone.utc)
    pending_transmit = transmit_requests.take_pending(db, machine)
    # The pull half of "produce your Z" (§5.3), for a till in `zMode = till`.
    pending_till_z = till_z.take_pending(db, machine)
    # "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the ids of this till's pending credit
    # requests — the pull half; the till fetches them whole. Never fails a heartbeat.
    pending_remote_credits = None
    try:
        from app.services import remote_credits

        with db.begin_nested():
            pending_remote_credits = remote_credits.take_pending(db, machine)
    except Exception:  # noqa: BLE001
        logger.exception("remote credit hand-over failed for %s", machine.id)
    # Local mode: the dashboard asked the shop's main till for the shop Z
    # (docs/SPEC_INDEPENDENT_TILL.md §8) — to the main till only.
    from app.services.local_shop_z import take_pending_for_main

    # The shop Zs this main till made that the cloud has not yet: what a handover of the
    # shop's Z production waits for (docs/SPEC_INDEPENDENT_TILL.md §8.10).
    if body is not None and body.local_shop_z is not None:
        from app.services.local_shop_z import note_heartbeat

        note_heartbeat(db, machine, body.local_shop_z)
    # The local server's sync lag (docs/SPEC_LAN_MODE.md §6): what the cloud copy still lacks.
    if body is not None and body.lan_sync is not None:
        lan_server.note_sync(machine, body.lan_sync)
    # Local shop Zs of this shop still waiting for their tills' shifts and documents
    # (docs/SPEC_INDEPENDENT_TILL.md §8.12): what arrived is linked, and a Z is verified once
    # everything it names is here. Never fails a heartbeat.
    if machine.shop_id is not None:
        from app.services.local_shop_z import verify_pending

        try:
            with db.begin_nested():
                verify_pending(db, machine.shop_id)
        except Exception:  # noqa: BLE001
            logger.exception("local shop Z verification failed for shop %s", machine.shop_id)
    pending_shop_z = take_pending_for_main(db, machine)
    # A participant off the LAN: the main till asked the cloud to close it (§8.14).
    from app.services.local_shop_z import take_pending_remote_part

    pending_shop_z_part = take_pending_remote_part(db, machine)
    # Support ordered a reset of this till's data (offline till Z §4.7): the only way.
    pending_reset = till_reset.take_pending(db, machine)
    through = z_reported_through_sequence(db, machine.id)
    recent = recent_shift_zs(db, machine.id)
    # A shop Z is about (the master till's "סגירת Z סניפי" is open, or a run is waiting):
    # beat every few seconds, so its close reaches this till at once without realtime.
    fast_beat = shop_z_fast_beat(db, machine)
    if not fast_beat:
        # A kiosk asked to close its shift / produce its Z, held by a customer: runs the moment they are done.
        from app.services import kiosk_z

        fast_beat = kiosk_z.fast_beat(db, machine)
    db.commit()

    response = {
        "ok": True,
        "serverTime": datetime.now(timezone.utc).isoformat(),
        # Drives the till's purge: documents of shifts at or below it are in a Z.
        "zReportedThroughSequence": through,
        # So a reprint of an older shift's X can carry the Z number it ended up in.
        # A till Z's shifts are here exactly like a cloud Z's (§5.6).
        "recentShiftZs": recent,
        # A temporary customer's license end, every beat — a change reaches the till at once.
        "license": licenses.effective_license(db, machine),
        # Who produces this till's Z (§5.1), on every beat: the till takes its mode from here.
        "zMode": till_z.z_mode_of(machine),
        # "קופה עצמאית" (docs/SPEC_INDEPENDENT_TILL.md): its own Z, never in the shop Z, and
        # outside the shop's LAN group (no main till, tables host or print server for it).
        "independentTill": bool(getattr(machine, "independent_till", False)),
        # "לא משמש כשרת מקומי" (docs/SPEC_LAN_MODE.md §3): never the shop's local server — the
        # till then starts no LAN host of its own (tables, any later one), whatever its
        # technician set; it still serves its own printers, and stays in the shop Z.
        "lanServerExcluded": lan_server.is_excluded(db, machine),
        # The last number of the till's own Z run (0: none yet), so a till in `zMode =
        # till` can number a Z it closes with no connection (docs/SPEC_OFFLINE_TILL_Z.md §4).
        "lastTillZNumber": last_machine_z_number(db, machine.id),
        # Its run (SPEC_INDEPENDENT_TILL §3.1): made independent, a till starts again at Z 1.
        **_till_z_run(db, machine),
        # "מצב הדרכה", every beat too: the till switches at its next shift boundary.
        "trainingMode": bool(machine.shop is not None and getattr(machine.shop, "training_mode", False)),
    }
    # Support produced this till's Z from the cloud (offline till Z §4.6): the till makes
    # nothing for that period and keeps its data of it read-only.
    support = support_z.heartbeat_block(machine)
    if support is not None:
        response["supportZ"] = support
    if fast_beat:
        response["fastBeat"] = True
    if pending is not None:
        response["pendingCloseShift"] = pending
    if pending_transmit is not None:
        response["pendingTransmit"] = pending_transmit
    if pending_till_z is not None:
        response["pendingTillZ"] = pending_till_z
    if pending_shop_z is not None:
        response["pendingShopZ"] = pending_shop_z
    if pending_shop_z_part is not None:
        response["pendingShopZPart"] = pending_shop_z_part
    if pending_reset is not None:
        response["pendingReset"] = pending_reset
    if pending_reboot is not None:
        response["pendingReboot"] = pending_reboot
    if pending_remote_credits:
        response["pendingRemoteCredits"] = pending_remote_credits
    return response


@router.get("/{machine_id}", response_model=POSMachineResponse)
def get_machine(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get machine details."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return _enrich_machine_status(machine, db)


@router.put("/{machine_id}", response_model=POSMachineResponse)
def update_machine(
    machine_id: str,
    machine_data: POSMachineUpdate,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Update machine."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    update_data = machine_data.model_dump(exclude_unset=True, by_alias=False)
    # "דגם מכשיר" (docs/SPEC_DEVICE_ROLE_MODEL.md §5): a change only over a clean break, the
    # same rules as `PUT /machines/{id}/device-profile`. First, so a refusal changes nothing.
    if "device_model" in update_data:
        new_model = update_data.pop("device_model")
        try:
            device_profile.check_model_change(db, machine, new_model)
        except device_profile.DeviceProfileRefused as refused:
            db.rollback()
            return JSONResponse(status_code=refused.status_code, content=refused.body)
        device_profile.change_model(machine, new_model)
    # Who produces its Z (§5.1): first, so a refused switch changes nothing else either.
    # An explicit null is no change.
    z_mode = update_data.pop("z_mode", None)
    # A display device (a KDS / the board, app/services/display_devices.py) makes no Z and
    # issues no documents: no Z mode to switch, no document prefix (409 `device_not_fiscal`).
    if not display_devices.is_fiscal(machine) and (
        (z_mode is not None and z_mode != till_z.z_mode_of(machine))
        or (update_data.get("document_prefix") or "").strip()
    ):
        db.rollback()
        return display_devices.not_fiscal_response(machine)
    if z_mode is not None:
        try:
            # The owner's rules: the super admin alone, the till's shift closed first.
            z_mode_policy.check_switch(db, current_user, machine, z_mode)
            till_z.set_z_mode(db, machine, z_mode)
        except till_z.TillZRefused as refused:
            db.rollback()
            return JSONResponse(status_code=refused.status_code, content=refused.body)
    # "לקוח קבוע / זמני" for this till: the super admin's only; leaves `update_data`.
    licenses.apply_license(current_user, machine, update_data)
    # "קידומת מסמכים": set after the shop below (a move gives the old one up), checked
    # against the till's shop — never through the plain setattr loop.
    prefix_sent = "document_prefix" in update_data
    prefix_requested = update_data.pop("document_prefix", None)

    # Leaving its shop, or being retired, with shifts that belong to it: refused (409).
    leaving = "shop_id" in update_data and str(update_data["shop_id"]) != str(machine.shop_id)
    if leaving:
        # "העברת מכשיר לסניף אחר": the super admin may have taken it from this role.
        access.require_feature(db, current_user, access.MOVE_DEVICES)
    retiring = update_data.get("is_active") is False and machine.is_active
    if leaving or retiring:
        refuse_leaving_shop_with_shifts(db, machine)
    area_before = machine.area_id

    if "shop_id" in update_data:
        sid = update_data["shop_id"]
        if sid is not None:
            shop = db.query(Shop).filter(Shop.id == sid).first()
            if not shop:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shop not found")
            ensure_same_tenant(shop.tenant_id, active_tenant_id)
            # Only into a shop the caller manages. This used to check company managers
            # alone, so a shop manager — who passes the machine check above for a till
            # in their own shop — could seat that till in any shop of the tenant,
            # another company's included, and draw that shop's register number.
            if current_user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
                _check_shop_access(current_user, shop, db)
            if not shop_belongs_to_company(db, sid, shop.company_id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="shopId does not belong to its company",
                )
            machine.tenant_id = shop.tenant_id or machine.tenant_id
            machine.pairing_status = PairingStatus.ASSIGNED
        # Not a plain setattr: changing shop gives up this shop's register number
        # and draws the new shop's next one.
        previous_shop_id = machine.shop_id
        set_machine_shop(db, machine, update_data.pop("shop_id"))
        # A list chosen out of the old shop's catalog means nothing in the new one.
        if str(previous_shop_id) != str(machine.shop_id):
            machine_catalog.reset_for_new_shop(db, machine)

    # After the shop: an area sent with a new shop must be one of the new shop's, and a
    # shop change without one has already cleared the old area (`set_machine_shop`).
    if "area_id" in update_data:
        areas.assign_machine_area(db, machine, update_data.pop("area_id"))
    if retiring:
        # A retired till stands in no area: an area counts and closes active tills only,
        # and an archived area must not be left holding one that is later reactivated.
        areas.set_machine_area(machine, None)

    if prefix_sent:
        # 400 for a malformed prefix, 409 when another till of the shop / branch holds it
        # (or its documents carry it). Documents already issued keep theirs.
        try:
            machine.document_prefix = document_prefix.check_prefix(db, machine, prefix_requested)
        except document_prefix.DocumentPrefixRefused as refused:
            db.rollback()
            return JSONResponse(
                status_code=refused.status_code,
                content={"detail": refused.detail, "code": refused.code},
            )

    for field, value in update_data.items():
        setattr(machine, field, value)

    area_changed = str(area_before) != str(machine.area_id)
    db.commit()
    db.refresh(machine)
    if area_changed:
        areas.notify_tills([machine])
    return machine


@router.get("/{machine_id}/document-prefix")
def get_machine_document_prefix(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The till's "קידומת מסמכים" against its business (docs/SPEC_DOCUMENT_PREFIX.md §5):
    `prefix` in force, `ownPrefix` (else the register number), `uniqueInBusiness`, and when
    not, `heldBy` (who else, in Hebrew `text`) and `suggestedPrefix`.
    """
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    return document_prefix.prefix_status(db, machine)


@router.post("/{machine_id}/document-prefix/assign-free")
def assign_free_document_prefix(
    machine_id: str,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שיוך קידומת פנויה": give a till whose prefix collides in its business the lowest free
    prefix of the business. Its future documents only — what it issued keeps the prefix
    frozen on it; the till learns the new one on its next `GET /machines/me`. A till whose
    prefix is already unique is left alone (`changed: false`). The same roles as
    `PUT /machines/{id}`.
    """
    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    refused_display = display_devices.not_fiscal_response(machine)  # no documents, no prefix
    if refused_display is not None:
        return refused_display
    try:
        assigned = document_prefix.assign_free_prefix(db, machine)
    except document_prefix.DocumentPrefixRefused as refused:
        db.rollback()
        return JSONResponse(
            status_code=refused.status_code,
            content={"detail": refused.detail, "code": refused.code},
        )
    db.commit()
    db.refresh(machine)
    return {
        "changed": assigned is not None,
        "documentPrefix": machine.document_prefix,
        "effectiveDocumentPrefix": machine.effective_document_prefix,
        "status": document_prefix.prefix_status(db, machine),
    }


def _machine_has_history(db: Session, machine_id: str) -> bool:
    if db.query(Transaction.id).filter(Transaction.machine_id == machine_id).first():
        return True
    if db.query(ZReport.id).filter(ZReport.machine_id == machine_id).first():
        return True
    if db.query(Shift.id).filter(Shift.machine_id == machine_id).first():
        return True
    if db.query(SyncLog.id).filter(SyncLog.machine_id == machine_id).first():
        return True
    # Its Z run, even with no Z on file, and what the device said it numbered: a hard
    # delete would lose where the run is, and a till recreated in its place would start
    # it again (docs/SPEC_OFFLINE_TILL_Z.md §4.7). Kept, as a soft delete.
    from app.models.machine_z_sequence import MachineZSequence

    if db.query(MachineZSequence.machine_id).filter(
        MachineZSequence.machine_id == machine_id, MachineZSequence.last_number > 0
    ).first():
        return True
    if db.query(POSMachine.id).filter(
        POSMachine.id == machine_id,
        (POSMachine.offline_till_z_last_number > 0) | POSMachine.reported_document_counters.isnot(None),
    ).first():
        return True
    return False


@router.delete("/{machine_id}")
def delete_machine(
    machine_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Remove a POS device (hard or soft delete depending on history)."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    # "הסרת מכשירים": the super admin may have taken it from this role.
    access.require_feature(db, current_user, access.REMOVE_DEVICES)

    # Before anything is touched: an open shift or shifts awaiting a Z keep the till.
    refuse_leaving_shop_with_shifts(db, machine)
    # And Zs it may hold, closed with no connection, not in the cloud yet: removed, it
    # could never send them (docs/SPEC_OFFLINE_TILL_Z.md §4.4, §4.7).
    try:
        till_z.refuse_while_producing_offline(db, machine)
    except till_z.TillZRefused as refused:
        return JSONResponse(status_code=refused.status_code, content=refused.body)

    db.query(PairingCode).filter(PairingCode.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )
    # Detach transient pairing requests so the FK doesn't block a hard delete.
    # These are pairing artifacts, not sales history, so clearing the reference
    # is safe (the column is nullable).
    db.query(DevicePairingRequest).filter(
        DevicePairingRequest.pos_machine_id == machine_id
    ).update({DevicePairingRequest.pos_machine_id: None}, synchronize_session=False)
    db.query(Product).filter(Product.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )
    db.query(Category).filter(Category.pos_machine_id == machine_id).delete(
        synchronize_session=False
    )

    def _soft_delete() -> Dict[str, Any]:
        machine.is_active = False
        machine.pairing_status = PairingStatus.UNPAIRED
        # Leaves the shop, so it gives up its register number. The number is not
        # handed to anyone else: the shop's counter has already moved past it.
        set_machine_shop(db, machine, None)
        machine.mqtt_client_id = None
        # Machine tokens do not expire, so unpairing is the revocation. Bumping the
        # version kills every token this terminal was ever issued, for good: if the
        # row is later reactivated and re-paired, it mints at the new version and
        # the old ones stay dead.
        machine.token_version = (machine.token_version or 1) + 1
        db.commit()
        return {"deleted": True, "mode": "soft", "machineId": str(machine.id)}

    if _machine_has_history(db, machine_id):
        return _soft_delete()

    db.delete(machine)
    try:
        db.commit()
    except IntegrityError:
        # Another table still references this machine (e.g. issued vouchers,
        # stock movements). Fall back to a soft delete instead of 500ing.
        db.rollback()
        machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
        if not machine:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
        return _soft_delete()
    return {"deleted": True, "mode": "hard", "machineId": machine_id}


@router.post("/{machine_id}/sync", status_code=status.HTTP_200_OK)
def trigger_sync(
    machine_id: str,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Trigger manual sync for a machine."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    if machine.pairing_status != PairingStatus.ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a shop before syncing",
        )

    if not machine.shop_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine is not assigned to a shop",
        )

    if not machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine tenant context required for sync",
        )

    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    update_machine_sync_timestamp(db, str(machine.id))
    notify_machine_catalog_changed(
        str(machine.tenant_id),
        str(machine.id),
        reason="manual_sync",
    )

    return {
        "message": "Catalog change notification sent; POS should pull via GET /sync/{machineId}/catalog",
    }


def check_shift_admin_access(db: Session, machine: POSMachine, current_user: User, active_tenant_id) -> None:
    """
    May `current_user` act on this till's shift from the cloud (close it remotely, close
    it administratively)? The caller has already required a machine admin role; this
    narrows it to the till: a distributor's own terminals, a company manager's company
    tree, a shop manager's shop.
    """
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def machine_for_shift_admin(db: Session, machine_id, current_user: User, active_tenant_id) -> POSMachine:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    check_shift_admin_access(db, machine, current_user, active_tenant_id)
    return machine


@router.post(
    "/{machine_id}/close-shift",
    response_model=ShiftCloseRequestOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def request_remote_shift_close(
    machine_id: uuid_mod.UUID,
    response: Response,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Ask this till to close its open shift, without producing a Z (docs/SHIFTS_API.md §2.14).

    The till gets the same `close-shift` instruction a Z run sends (Ably now if it is
    online, the heartbeat otherwise) and closes unattended; the request completes when
    that close is accepted with every document. `201` with a new request, `200` with the
    one already pending. `409 no_open_shift`, `409 machine_not_assigned`,
    `409 z_run_in_progress:<runId>` (a Z run is already closing this till's shift).
    Progress: `GET /shift-close-requests/{id}`.
    """
    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    req, created = close_requests.request_close(db, current_user, machine)
    db.commit()
    db.refresh(req)
    if not created:
        response.status_code = status.HTTP_200_OK
    return close_requests.request_to_out(db, req)


@router.post(
    "/{machine_id}/till-z",
    response_model=TillZRequestOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def request_till_z(
    machine_id: uuid_mod.UUID,
    body: Optional[MachineTillZIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Ask this till (`zMode = till`) to produce its own Z now (docs/SHIFTS_API.md §5.4).

    The till gets the `till-z` Ably event if online and `pendingTillZ` on its heartbeat
    either way; it closes its open shift unattended, asks for its Z and prints it. A till
    with a request pending gets that one back. `422 machine_not_till_z` for a `cloud`
    till, `409 machine_not_assigned`. Same roles as a remote shift close. Progress:
    `GET /till-z-requests/{id}`.
    """
    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    refused_display = display_devices.not_fiscal_response(machine)  # a display device makes no Z
    if refused_display is not None:
        return refused_display
    try:
        req, _created = till_z.request_for_machine(
            db, current_user, machine, force=bool(body.force) if body is not None else False
        )
    except till_z.TillZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    db.commit()
    db.refresh(req)
    return till_z.request_to_out(db, req)


# ── Card transmission (docs/SHIFTS_API.md §4) ─────────────────────────────────


def _machine_for_read(db: Session, machine_id, current_user: User, active_tenant_id) -> POSMachine:
    """Whoever may read the machine detail may read its transmissions."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return machine


@router.post("/{machine_id}/transmit", status_code=status.HTTP_201_CREATED)
def request_transmit(
    machine_id: uuid_mod.UUID,
    response: Response,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Ask this till to transmit its card batch to Shva now (docs/SHIFTS_API.md §4.4).

    The till gets the `transmit` Ably event if it is online and `pendingTransmit` on its
    heartbeat either way. `201` with a new request, `200` with the one already pending.
    `409 machine_not_assigned`. Same roles as a remote shift close. Progress:
    `GET /transmit-requests/{id}`.
    """
    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    refused_display = display_devices.not_fiscal_response(machine)  # no card payments on a display device
    if refused_display is not None:
        return refused_display
    req, created = transmit_requests.request_transmit(db, current_user, machine)
    db.commit()
    db.refresh(req)
    if not created:
        response.status_code = status.HTTP_200_OK
    return transmit_requests.request_to_out(db, req)


@router.get("/{machine_id}/transmissions")
def list_machine_transmissions(
    machine_id: uuid_mod.UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """This till's transmission reports, newest first (docs/SHIFTS_API.md §4.7)."""
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    return transmissions.list_for_machine(db, machine, limit=limit, offset=offset)


@router.get("/{machine_id}/transmissions/{transmission_id}")
def get_machine_transmission(
    machine_id: uuid_mod.UUID,
    transmission_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One report, with its terminal ids and the terminal's printed report."""
    from app.models.card_transmission import CardTransmission

    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    row = (
        db.query(CardTransmission)
        .filter(CardTransmission.id == transmission_id, CardTransmission.machine_id == machine.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transmission not found")
    return transmissions.transmission_to_out(db, row, detail=True)


@router.get("/{machine_id}/untransmitted")
def list_untransmitted_card_sales(
    machine_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Card sales of this till in no successful transmission, from our records
    (docs/SHIFTS_API.md §4.8) — the list a shop takes to the card company when a terminal
    dies with its batch. Only sales after the till's tracking start.
    """
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    items = transmissions.untransmitted_items(db, machine)
    total = sum((Decimal(i["amount"]) for i in items if i["amount"] is not None), Decimal("0.00"))
    reported = machine.transmission_reported_at is not None
    return {
        "machineId": str(machine.id),
        "trackingStartedAt": machine.transmission_tracking_started_at,
        "count": len(items),
        "amount": transmissions.money(total),
        "tillPendingCount": machine.transmission_pending_count if reported else None,
        "tillReportedAt": machine.transmission_reported_at,
        "items": items,
    }


class AdministrativeCloseBody(BaseModel):
    """Options for closing a dead till's shift from the cloud."""

    model_config = ConfigDict(populate_by_name=True)

    #: Skip the "terminal has been silent long enough" guard, for a unit known to be
    #: unusable (smashed, stolen, returned). Recorded in the reconstruction basis.
    force: bool = False
    #: Free text kept with the shift — why this was done, in the operator's words.
    note: Optional[str] = Field(None, max_length=500)


@router.post("/{machine_id}/shifts/{shift_id}/administrative-close")
def administrative_close_shift(
    machine_id: uuid_mod.UUID,
    shift_id: uuid_mod.UUID,
    body: AdministrativeCloseBody | None = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Close a shift whose till can no longer close it (dead-till recovery).

    Builds the shift's X from the documents the cloud holds, marked `reconstructed` and
    `unattended`, uncounted, attributed to the caller. The shift is then an ordinary
    candidate for the shop's next Z. Refused while the till is online or was seen in
    the last two hours, unless `force`. Idempotent. See
    `app/services/administrative_close.py`.
    """
    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)

    shift = (
        db.query(Shift)
        .filter(Shift.id == shift_id, Shift.machine_id == machine.id)
        .first()
    )
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")

    options = body or AdministrativeCloseBody()
    shift, created = close_shift_administratively(
        db,
        machine,
        shift,
        current_user,
        force=options.force,
        note=options.note,
    )
    db.commit()
    db.refresh(shift)
    return {
        "created": created,
        "shift": shift_to_out(
            shift,
            machine_name=machine.name,
            shop_name=shift.shop.name if shift.shop is not None else None,
        ).model_dump(by_alias=True, mode="json"),
    }


@router.post("/{machine_id}/trading-day/reconstruct-close", status_code=status.HTTP_410_GONE)
def reconstruct_close_removed(
    machine_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_machine_admin),
):
    """Removed: `POST /machines/{id}/shifts/{shiftId}/administrative-close`."""
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="upgrade_required")


class SupportZBody(BaseModel):
    """`POST /machines/{id}/support-z` — "הפקת Z מהענן ע״י התמיכה"."""

    model_config = ConfigDict(populate_by_name=True)

    #: destroyed | lost | permanent_failure (`support_z.REASONS`).
    reason: str = Field(..., max_length=32)
    note: Optional[str] = Field(None, max_length=500)
    #: "אני מאשר שהנתונים בענן הם הנתונים הקיימים" — required while the state warns (§4.6.1).
    confirm_data: bool = Field(False, alias="confirmData")


@router.get("/{machine_id}/support-z")
def get_support_z_preview(
    machine_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    What "הפקת Z מהענן ע״י התמיכה" would do for this till: the shifts it closes, the
    documents and totals, the Z number, the numbers skipped, the document counters' gaps,
    when the till was last seen (docs/SPEC_OFFLINE_TILL_Z.md §4.6). Support alone.
    """
    support_z.check_permission(current_user)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    return support_z.preview(db, machine)


@router.post("/{machine_id}/support-z")
def post_support_z(
    machine_id: uuid_mod.UUID,
    body: SupportZBody,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "הפקת Z מהענן ע״י התמיכה" — a till destroyed, lost or permanently broken: its shifts
    closed and its Z produced from the documents the cloud holds, the machine marked, all
    recorded (docs/SPEC_OFFLINE_TILL_Z.md §4.6). Support alone (`403 super_admin_only`);
    `409 terminal_is_online` while the till can do it itself.
    """
    support_z.check_permission(current_user)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    result = support_z.produce(
        db, current_user, machine, reason=body.reason, note=body.note, confirm_data=body.confirm_data,
    )
    db.commit()
    return result


class TillResetBody(BaseModel):
    """`POST /machines/{id}/till-reset` — "איפוס נתוני קופה (תמיכה)"."""

    model_config = ConfigDict(populate_by_name=True)

    #: transactions ("מחיקת תנועות מקומיות") | full ("איפוס מלא") — `till_reset.KINDS`.
    kind: str = Field(..., max_length=32)
    reason: str = Field(..., max_length=500)


@router.get("/{machine_id}/till-reset")
def get_till_reset_preview(
    machine_id: uuid_mod.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    What a reset of this till's data would meet: what the till still holds unsynced, the
    Zs it keeps, the counters that stay, a command already waiting
    (docs/SPEC_OFFLINE_TILL_Z.md §4.7). Support alone.
    """
    till_reset.check_permission(current_user)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    out = till_reset.preview(db, machine)
    db.commit()
    return out


@router.post("/{machine_id}/till-reset")
def post_till_reset(
    machine_id: uuid_mod.UUID,
    body: TillResetBody,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "איפוס נתוני קופה (תמיכה)" — the only reset of a till's data there is (the owner:
    "איפוס זדים קורה רק מהענן ובאמצעות סופר אדמין בתמיכה"). Sent to the till on its heartbeat
    (`pendingReset`); the till carries it out under its guards or refuses, and reports.
    Support alone (`403 super_admin_only`); `422 invalid_kind | reason_required`; `409
    machine_not_assigned | reset_pending`. Recorded as a `till_reset` exception.
    """
    till_reset.check_permission(current_user)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    result = till_reset.request(db, current_user, machine, kind=body.kind, reason=body.reason)
    db.commit()
    return result


@router.post("/{machine_id}/replacement-code")
def create_replacement_pairing_code(
    machine_id: uuid_mod.UUID,
    body: ReplacementCodeBody | None = None,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A pairing code that hands this terminal's identity to a replacement device.

    The new unit adopts the same machine row — same id, same `machine_code`, same shop
    and register number — so documents already filed against it still point at the till
    the shop knows, and the day's reporting does not split across two machines. Pairing
    bumps `token_version`, which kills whatever token the old unit still holds.

    Refuses while the terminal has an open shift: the replacement has none of that
    shift's records, and its close would declare a fraction of what was taken. Close the
    shift first with `administrative-close`.

    Refuses too while the till holds card sales it has not transmitted
    (`409 untransmitted_card_sales`, docs/SHIFTS_API.md §4.9): the new device's card
    application has none of them, so nobody would ever transmit them. For a terminal that
    is dead with its batch, `{"acknowledgeUntransmitted": true}` creates the code anyway
    and records who accepted that.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)

    # Checked here as well as at redemption so the operator is told now, while they are
    # looking at the screen, rather than when the engineer is standing at the counter
    # with a new terminal in their hand.
    if find_open_shift(db, machine.id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="open_shift — close this terminal's shift before replacing it.",
        )
    # A replacement starts numbering from the cloud's last Z: never while the old unit may
    # hold Zs it closed with no connection (docs/SPEC_OFFLINE_TILL_Z.md §4.4) — two
    # devices would print the same numbers.
    try:
        till_z.refuse_while_producing_offline(db, machine)
    except till_z.TillZRefused as refused:
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    acknowledged = body is not None and body.acknowledge_untransmitted
    if not acknowledged and transmissions.has_untransmitted(db, machine):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="untransmitted_card_sales")

    code = create_pairing_code(
        db,
        current_user.id,
        tenant_id=machine.tenant_id,
        company_id=None,
        shop_id=None,
        target_machine_id=machine.id,
        untransmitted_acknowledged_by=current_user.id if acknowledged else None,
        # The replacement unit's hardware; none keeps the till's recorded model.
        device_model=body.device_model if body is not None else None,
    )
    # Why — kept in "הוחלפה קופה" when a device redeems the code (offline till Z §4.6.2).
    if body is not None and body.reason and body.reason.strip():
        code.replacement_reason = body.reason.strip()[:500]
        db.commit()
    return {
        "code": code.code,
        "expiresAt": code.expires_at,
        "replacesMachineId": str(machine.id),
        "machineCode": machine.machine_code,
        "untransmittedAcknowledged": bool(acknowledged),
    }


# ── "סוג מכשיר": role and model (docs/SPEC_DEVICE_ROLE_MODEL.md) ──────────────


@router.put("/{machine_id}/device-profile", response_model=POSMachineResponse)
def update_device_profile(
    machine_id: uuid_mod.UUID,
    body: DeviceProfileIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Change the machine's role ("till" ↔ "kiosk") and / or model, from the machine page.

    The same roles as any machine edit (`PUT /machines/{id}`); a change of role also goes
    through the kiosks page's scope check. Each change only over a clean break — no Z under
    way, no open shift, no documents the till reported unsynced, no Zs closed offline and
    not uploaded; a kiosk never the shop's main till and always seated in a shop; a model
    without a terminal not while card sales wait for transmission. `409` / `422` with
    `{"detail": code, "message": Hebrew}`. Becoming a kiosk takes `kiosk` (name,
    controlling tills, device lock) exactly as "הפוך קופה לקיוסק" does.
    """
    from app.services import kiosk_control

    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    if current_user.role == UserRole.DISTRIBUTOR:
        if machine.distributor_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    elif not _check_machine_list_access(current_user, machine, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    sent = body.model_dump(exclude_unset=True, by_alias=False)
    changed = device_profile.RoleChange()
    try:
        if "device_model" in sent:
            device_profile.check_model_change(db, machine, body.device_model)
            device_profile.change_model(machine, body.device_model)
        if body.device_role is not None:
            # A display device's too ("kds" / "order_status_board"): a till never becomes one,
            # nor back — 409 `device_role_change_requires_pairing` (app/services/display_devices.py).
            current_role = device_profile.current_role(db, machine)
            if body.device_role != current_role:
                kiosk_control.check_machine_scope(db, current_user, machine, active_tenant_id)
                device_profile.check_role_switch(db, machine, body.device_role)
                changed = device_profile.change_role(
                    db, current_user, machine, body.device_role, body.kiosk, body.kds
                )
        db.commit()
    except device_profile.DeviceProfileRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    except IntegrityError:
        db.rollback()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"detail": "already_kiosk", "message": "המכשיר כבר קיוסק."},
        )
    if changed.lock:
        kiosk_control.notify_device_lock(machine)
    if changed.pinpad:
        device_profile.notify_settings(db, machine)
    db.refresh(machine)
    return _enrich_machine_status(machine, db)
