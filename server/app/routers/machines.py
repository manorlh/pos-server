import logging
from decimal import Decimal
import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, ConfigDict, Field
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session, object_session, selectinload
from sqlalchemy import or_, and_
from sqlalchemy.exc import IntegrityError
from app.services import licenses
from app.services import access
from app.database import get_db
from app.schemas.pos_machine import POSMachineUpdate, POSMachineResponse, MachineHeartbeatBody
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
from app.schemas.transmission import ReplacementCodeBody
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
        # The till's shop and company by number: "חברה #N · סניף #M · קופה #K".
        "shopNumber": machine.shop.shop_number if machine.shop is not None else None,
        "companyNumber": (
            machine.shop.company.company_number
            if machine.shop is not None and machine.shop.company is not None
            else None
        ),
        "distributorId": machine.distributor_id,
        "mqttClientId": machine.mqtt_client_id,
        "pairingStatus": machine.pairing_status,
        "deviceInfo": machine.device_info,
        "deviceModel": machine.device_model,
        "hasPrinter": machine.has_printer,
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
        # "לקוח זמני": the license end this till keeps (app/services/licenses.py).
        # Called directly (a test), `db` is its Depends default: the machine's own session.
        "license": licenses.effective_license(
            db if isinstance(db, Session) else object_session(machine), machine
        ),
        # "Z סניפי" or "Z לכל קופה" (its point of sale's, shop's or organization's mode):
        # under the latter every till closes its own Z, and the shift becomes the Z.
        "zScope": _z_scope(db if isinstance(db, Session) else object_session(machine), machine),
        **machine_realtime_refresh_info(machine=machine),
    }


@router.post("/me/heartbeat")
def post_my_heartbeat(
    body: MachineHeartbeatBody | None = None,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
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
    pending_transmit = transmit_requests.take_pending(db, machine)
    through = z_reported_through_sequence(db, machine.id)
    recent = recent_shift_zs(db, machine.id)
    # A shop Z is about (the master till's "סגירת Z סניפי" is open, or a run is waiting):
    # beat every few seconds, so its close reaches this till at once without realtime.
    fast_beat = shop_z_fast_beat(db, machine)
    db.commit()

    response = {
        "ok": True,
        "serverTime": datetime.now(timezone.utc).isoformat(),
        # Drives the till's purge: documents of shifts at or below it are in a Z.
        "zReportedThroughSequence": through,
        # So a reprint of an older shift's X can carry the Z number it ended up in.
        "recentShiftZs": recent,
        # A temporary customer's license end, every beat — a change reaches the till at once.
        "license": licenses.effective_license(db, machine),
        "zScope": _z_scope(db, machine),
    }
    if fast_beat:
        response["fastBeat"] = True
    if pending is not None:
        response["pendingCloseShift"] = pending
    if pending_transmit is not None:
        response["pendingTransmit"] = pending_transmit
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


def _z_scope(db: Session, machine: POSMachine) -> str:
    """The till's Z mode; "shop" for a till with no shop or when it cannot be read."""
    if db is None or machine.shop_id is None:
        return "shop"
    from app.services import z_runs as ZR

    try:
        return ZR.z_scope_of_machine(db, machine)
    except Exception:  # noqa: BLE001 - a heartbeat never fails on it
        return "shop"


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
    # "לקוח קבוע / זמני" for this till: the super admin's only; leaves `update_data`.
    licenses.apply_license(current_user, machine, update_data)

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

    for field, value in update_data.items():
        setattr(machine, field, value)

    area_changed = str(area_before) != str(machine.area_id)
    db.commit()
    db.refresh(machine)
    if area_changed:
        areas.notify_tills([machine])
    return machine


def _machine_has_history(db: Session, machine_id: str) -> bool:
    if db.query(Transaction.id).filter(Transaction.machine_id == machine_id).first():
        return True
    if db.query(ZReport.id).filter(ZReport.machine_id == machine_id).first():
        return True
    if db.query(Shift.id).filter(Shift.machine_id == machine_id).first():
        return True
    if db.query(SyncLog.id).filter(SyncLog.machine_id == machine_id).first():
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
    return {
        "code": code.code,
        "expiresAt": code.expires_at,
        "replacesMachineId": str(machine.id),
        "machineCode": machine.machine_code,
        "untransmittedAcknowledged": bool(acknowledged),
    }
