"""
"עמדות מזומן" on the dashboard (P:/specs/cash-paylink.md §12): the list of stations and each one's page —
its host, serial, assigned kiosks, state, change, alerts, journal, movements, owed items, drawer and the
commands to its host. The rules are the devices pages': a shop's managers (and above) in scope
(`kiosk_control.check_shop_scope`); the route → section map holds view vs edit (`devices`).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.cash_station import (
    MOVEMENT_KINDS,
    OUTCOMES,
    TX_STATES,
    CashCreditRedemption,
    CashHostCommand,
    CashStation,
    CashStationMovement,
    CashStationTx,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import cash_alerts as CA
from app.services import cash_params as CP
from app.services import cash_stations as CS
from app.services.cash_host import is_cash_host

#: A station's report older than this is shown "as of", not live.
STATUS_FRESH = timedelta(minutes=3)
PAGE_MAX = 200
RESOLVE_CHOICES = ("paid_out", "applied", "written_off")


def _refuse(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _who(user: Any) -> Dict[str, Any]:
    return {"userId": str(getattr(user, "id", "") or "") or None,
            "name": getattr(user, "username", None) or getattr(user, "email", None)}


# ── Scope ──────────────────────────────────────────────────────────────────────


def shop_in_scope(db: Session, user: User, shop_id: Any, tenant_id: Any) -> Shop:
    from app.services import kiosk_control

    ident = shop_id if isinstance(shop_id, uuid.UUID) else CS._uuid(shop_id)
    if ident is None:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "shop_required", "בחרו סניף לעמדה.")
    shop = db.get(Shop, ident)
    if shop is None or (tenant_id is not None and str(shop.tenant_id) != str(tenant_id)):
        raise _refuse(status.HTTP_404_NOT_FOUND, "shop_not_found", "הסניף לא נמצא.")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    return shop


def station_in_scope(db: Session, user: User, station_id: Any, tenant_id: Any) -> CashStation:
    station = CS.get_station(db, station_id)
    if station is None or (tenant_id is not None and str(station.tenant_id) != str(tenant_id)):
        raise _refuse(status.HTTP_404_NOT_FOUND, "station_not_found", "עמדת המזומן לא נמצאה.")
    shop_in_scope(db, user, station.shop_id, tenant_id)
    return station


def visible_shop_ids(db: Session, user: User, tenant_id: Any) -> Optional[List[Any]]:
    """The shops this user may see stations of; None — every shop of the tenant."""
    from app.services import kiosk_control
    from app.services.company_hierarchy import visible_shop_ids as company_shops

    kiosk_control.require_kiosk_role(user)
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return None
    if user.role == UserRole.COMPANY_MANAGER:
        return [row[0] for row in company_shops(db, user).all()]
    return [user.shop_id] if user.shop_id else []


# ── Shapes ─────────────────────────────────────────────────────────────────────


def host_out(db: Session, host: Optional[POSMachine], now: datetime) -> Optional[Dict[str, Any]]:
    if host is None:
        return None
    from app.services.machine_status import is_online

    report = CS.host_status(host) or {}
    return {
        "machineId": str(host.id),
        "name": host.name,
        "online": is_online(host.last_heartbeat_at, now=now),
        "lastHeartbeatAt": CS._iso(host.last_heartbeat_at),
        "lanAddress": report.get("lanAddress"),
        "port": report.get("port"),
        "version": report.get("version"),
        "reportedAt": CS._iso(getattr(host, "cash_status_at", None)),
    }


def status_out(host: Optional[POSMachine], station: CashStation, now: datetime, *, detail: bool) -> Optional[Dict[str, Any]]:
    report = CS.station_report(host, station.id)
    if report is None:
        return None
    at = CS._aware(getattr(host, "cash_status_at", None))
    out = {
        "state": report.get("state"),
        "ready": report.get("state") in ("ready", "busy"),
        "reason": report.get("reason"),
        "changeAvailableAgorot": report.get("changeAvailableAgorot"),
        "exactOnly": report.get("exactOnly"),
        "queue": report.get("queue"),
        "activeTxId": report.get("activeTxId"),
        "heldCount": report.get("heldCount"),
        "deviceSerial": report.get("deviceSerial"),
        "firmware": report.get("firmware"),
        "reportedAt": CS._iso(at),
        "stale": at is None or now - at >= STATUS_FRESH,
    }
    if detail:
        out.update({
            "denominations": report.get("denominations") or [],
            "cashbox": report.get("cashbox"),
            "driver": report.get("driver"),
            "des": report.get("des"),
            "alerts": report.get("alerts") or [],
        })
    return out


def station_out(db: Session, station: CashStation, *, detail: bool = False,
                clients: Optional[Dict[Any, List[POSMachine]]] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = CS._now(now)
    host = db.get(POSMachine, station.host_machine_id) if station.host_machine_id else None
    shop = db.get(Shop, station.shop_id)
    if clients is None:
        clients = CS.clients_by_station(db, station.shop_id)
    open_owed = (
        db.query(CashStationTx).filter(CashStationTx.station_id == station.id, CashStationTx.owed_status == "open").all()
    )
    out = {
        "stationId": str(station.id),
        "shopId": str(station.shop_id),
        "shopName": shop.name if shop is not None else None,
        "companyId": str(station.company_id) if station.company_id else None,
        "name": station.name,
        "location": station.location,
        "label": CS.station_label(station),
        "serial": station.serial or "",
        "isActive": bool(station.is_active),
        "host": host_out(db, host, now),
        "clients": [CS.client_ref(db, m) for m in clients.get(station.id, [])],
        "status": status_out(host, station, now, detail=detail),
        "alerts": CA.open_alerts_of(db, station),
        "owed": {"count": len(open_owed), "amountAgorot": sum(int(t.owed_agorot or 0) for t in open_owed)},
        "settings": CS.overrides_of(station),
        "createdAt": CS._iso(station.created_at),
        "updatedAt": CS._iso(station.updated_at),
    }
    if detail:
        out["effectiveSettings"] = CS.station_settings(db, station, CS.host_of(db, station))
        out["alertTills"] = [{"machineId": str(m.id), "name": m.name, "posNumber": m.pos_number}
                             for m in CS.alert_tills(db, station, out["effectiveSettings"])]
        out["commands"] = [CS.command_out(c) for c in (
            db.query(CashHostCommand).filter(CashHostCommand.station_id == station.id)
            .order_by(CashHostCommand.created_at.desc()).limit(20).all()
        )]
    return out


def tx_out(tx: CashStationTx, client_name: Optional[str] = None) -> Dict[str, Any]:
    return {
        "txId": str(tx.tx_id),
        "stationId": str(tx.station_id),
        "hostId": str(tx.host_machine_id) if tx.host_machine_id else None,
        "clientId": str(tx.client_machine_id) if tx.client_machine_id else None,
        "clientName": client_name,
        "state": tx.state,
        "outcome": tx.outcome,
        "amountAgorot": tx.amount_agorot, "dueAgorot": tx.due_agorot, "roundingAgorot": tx.rounding_agorot,
        "insertedAgorot": tx.inserted_agorot, "changeDueAgorot": tx.change_due_agorot,
        "changePaidAgorot": tx.change_paid_agorot, "changeOwedAgorot": tx.change_owed_agorot,
        "refundDueAgorot": tx.refund_due_agorot, "refundPaidAgorot": tx.refund_paid_agorot,
        "heldAgorot": tx.held_agorot, "heldReason": tx.held_reason, "cancelReason": tx.cancel_reason,
        # Stage 2 (§11.15): the customer's choice for change owed, a split's cash part.
        "changeOwedAsk": bool(tx.change_owed_ask), "changeOwedAs": tx.change_owed_as, "splitAgorot": int(tx.split_agorot or 0),
        "slipCode": tx.slip_code, "orderRef": tx.order_ref, "orderLabel": tx.order_label,
        "deviceSerial": tx.device_serial, "documentId": tx.document_id, "documentNumber": tx.document_number,
        "acked": bool(tx.acked), "seq": tx.seq,
        "inserted": (tx.data or {}).get("inserted") or [], "paidOut": (tx.data or {}).get("paidOut") or [],
        "error": (tx.data or {}).get("error"),
        "createdAt": CS._iso(tx.created_at), "doneAt": CS._iso(tx.done_at),
        "owed": None if tx.owed_status == "none" else {
            "status": tx.owed_status, "kind": tx.owed_kind, "amountAgorot": tx.owed_agorot,
            "openedAt": CS._iso(tx.owed_at), "resolvedAt": CS._iso(tx.resolved_at), "resolution": tx.resolution,
            "resolvedBy": CS.resolved_by_text(tx) if tx.owed_status == "resolved" else None,
            "note": tx.resolution_note,
            "movementId": str(tx.movement_id) if tx.movement_id else None,
        },
        "zReportId": str(tx.z_report_id) if tx.z_report_id else None,
    }


def movement_out(m: CashStationMovement) -> Dict[str, Any]:
    return {
        "id": str(m.id), "stationId": str(m.station_id), "kind": m.kind, "amountAgorot": m.amount_agorot,
        "expectedAgorot": m.expected_agorot, "countedAgorot": m.counted_agorot, "pieces": m.pieces or [],
        "by": m.by, "note": m.note, "at": CS._iso(m.at),
        "zReportId": str(m.z_report_id) if m.z_report_id else None,
    }


# ── List, create, update, remove ───────────────────────────────────────────────


def list_stations(db: Session, user: User, tenant_id: Any, *, shop_id: Any = None, company_id: Any = None,
                  include_inactive: bool = False) -> Dict[str, Any]:
    q = db.query(CashStation).filter(CashStation.tenant_id == tenant_id)
    if shop_id is not None:
        shop_in_scope(db, user, shop_id, tenant_id)
        q = q.filter(CashStation.shop_id == shop_id)
    if company_id is not None:
        q = q.filter(CashStation.shop_id.in_(db.query(Shop.id).filter(Shop.company_id == company_id)))
    visible = visible_shop_ids(db, user, tenant_id)
    if visible is not None:
        q = q.filter(CashStation.shop_id.in_(visible or [uuid.uuid4()]))
    if not include_inactive:
        q = q.filter(CashStation.is_active.is_(True))
    stations = q.order_by(CashStation.shop_id, CashStation.name, CashStation.id).all()
    by_shop: Dict[Any, Dict[Any, List[POSMachine]]] = {}
    out = []
    for station in stations:
        if station.shop_id not in by_shop:
            by_shop[station.shop_id] = CS.clients_by_station(db, station.shop_id)
        out.append(station_out(db, station, clients=by_shop[station.shop_id]))
    return {"stations": out}


def _check_host(db: Session, shop: Shop, host_id: Any) -> Optional[POSMachine]:
    if host_id in (None, ""):
        return None
    ident = CS._uuid(str(host_id))
    host = db.get(POSMachine, ident) if ident is not None else None
    if host is None or not host.is_active or host.shop_id != shop.id or not is_cash_host(host):
        raise _refuse(status.HTTP_409_CONFLICT, "not_a_cash_host", "המכשיר שנבחר אינו שרת מזומן פעיל של הסניף.")
    return host


def _check_serial(db: Session, host: Optional[POSMachine], serial: str, station_id: Any = None) -> None:
    if host is None:
        return
    for other in CS.stations_of_host(db, host.id):
        if other.id != station_id and (other.serial or "") == serial:
            raise _refuse(
                status.HTTP_409_CONFLICT, "serial_taken",
                f"לשרת המזומן כבר יש עמדה עם המספר הסידורי \"{serial or 'ברירת מחדל'}\" ({other.name}).",
            )


def _clean_name(value: Any) -> str:
    name = " ".join(str(value or "").split())[:100]
    if not name:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "name_required", "שם העמדה חובה.")
    return name


def _clean_serial(value: Any) -> str:
    return "".join(str(value or "").split())[:32]


def _clean_settings(raw: Any) -> Dict[str, Any]:
    try:
        return CP.clean_overrides(raw)
    except ValueError as exc:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_setting", str(exc)) from None


def create_station(db: Session, user: User, tenant_id: Any, body: Dict[str, Any]) -> CashStation:
    shop = shop_in_scope(db, user, body.get("shopId"), tenant_id)
    host = _check_host(db, shop, body.get("hostMachineId"))
    serial = _clean_serial(body.get("serial"))
    _check_serial(db, host, serial)
    station = CashStation(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id,
        host_machine_id=host.id if host is not None else None,
        name=_clean_name(body.get("name")),
        location=" ".join(str(body.get("location") or "").split())[:100] or None,
        serial=serial,
        settings=_clean_settings(body.get("settings")) or None,
        is_active=body.get("isActive") is not False,
        created_by=_who(user)["name"],
    )
    db.add(station)
    db.flush()
    CS.wake(host, "cash_stations")
    return station


def update_station(db: Session, user: User, station: CashStation, body: Dict[str, Any]) -> CashStation:
    shop = db.get(Shop, station.shop_id)
    before = CS.host_of(db, station)
    host = before
    if "hostMachineId" in body:
        host = _check_host(db, shop, body.get("hostMachineId"))
        station.host_machine_id = host.id if host is not None else None
    if "serial" in body:
        station.serial = _clean_serial(body.get("serial"))
    if "hostMachineId" in body or "serial" in body:
        _check_serial(db, host, station.serial or "", station.id)
    if "name" in body:
        station.name = _clean_name(body.get("name"))
    if "location" in body:
        station.location = " ".join(str(body.get("location") or "").split())[:100] or None
    if "settings" in body:
        station.settings = _clean_settings(body.get("settings")) or None
    if body.get("isActive") is not None:
        station.is_active = bool(body.get("isActive"))
    station.updated_at = CS._now()
    db.flush()
    CS.wake(host, "cash_stations")
    if before is not None and (host is None or before.id != host.id):
        CS.wake(before, "cash_stations")
    return station


def remove_station(db: Session, user: User, station: CashStation) -> Dict[str, Any]:
    """Taken out of use: no kiosk is given it, its host stops running it; its journal and drawer stay."""
    station.is_active = False
    station.updated_at = CS._now()
    db.flush()
    CS.wake(CS.host_of(db, station), "cash_stations")
    return {"ok": True, "stationId": str(station.id), "isActive": False}


# ── Journal, movements, owed ───────────────────────────────────────────────────


def _page(limit: Optional[int], offset: Optional[int]):
    limit = max(1, min(PAGE_MAX, int(limit or 50)))
    offset = max(0, int(offset or 0))
    return limit, offset


def journal(db: Session, station: CashStation, *, date_from=None, date_to=None, state=None, outcome=None,
            owed=None, limit=None, offset=None) -> Dict[str, Any]:
    q = db.query(CashStationTx).filter(CashStationTx.station_id == station.id)
    if date_from is not None:
        q = q.filter(CashStationTx.created_at >= date_from)
    if date_to is not None:
        q = q.filter(CashStationTx.created_at < date_to)
    if state:
        if state not in TX_STATES:
            raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_state", f"state: {', '.join(TX_STATES)}.")
        q = q.filter(CashStationTx.state == state)
    if outcome:
        if outcome not in OUTCOMES:
            raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_outcome", f"outcome: {', '.join(OUTCOMES)}.")
        q = q.filter(CashStationTx.outcome == outcome)
    if owed:
        if owed not in ("open", "resolved", "any"):
            raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_owed", "owed: open | resolved | any.")
        q = q.filter(CashStationTx.owed_status != "none") if owed == "any" else q.filter(CashStationTx.owed_status == owed)
    total = q.count()
    limit, offset = _page(limit, offset)
    rows = q.order_by(CashStationTx.created_at.desc(), CashStationTx.tx_id).offset(offset).limit(limit).all()
    names = CS._client_names(db, [r.client_machine_id for r in rows])
    return {"items": [tx_out(r, names.get(r.client_machine_id)) for r in rows], "total": total,
            "limit": limit, "offset": offset}


def movements(db: Session, station: CashStation, *, date_from=None, date_to=None, kind=None, limit=None,
              offset=None) -> Dict[str, Any]:
    q = db.query(CashStationMovement).filter(CashStationMovement.station_id == station.id)
    if date_from is not None:
        q = q.filter(CashStationMovement.at >= date_from)
    if date_to is not None:
        q = q.filter(CashStationMovement.at < date_to)
    if kind:
        if kind not in MOVEMENT_KINDS:
            raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_kind", f"kind: {', '.join(MOVEMENT_KINDS)}.")
        q = q.filter(CashStationMovement.kind == kind)
    total = q.count()
    limit, offset = _page(limit, offset)
    rows = q.order_by(CashStationMovement.at.desc(), CashStationMovement.id).offset(offset).limit(limit).all()
    return {"items": [movement_out(m) for m in rows], "total": total, "limit": limit, "offset": offset}


def owed(db: Session, station: CashStation, *, which: str = "open") -> Dict[str, Any]:
    q = db.query(CashStationTx).filter(CashStationTx.station_id == station.id)
    if which == "open":
        q = q.filter(CashStationTx.owed_status == "open")
    elif which == "resolved":
        q = q.filter(CashStationTx.owed_status == "resolved")
    elif which == "all":
        q = q.filter(CashStationTx.owed_status != "none")
    else:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_status", "status: open | resolved | all.")
    rows = q.order_by(CashStationTx.owed_at, CashStationTx.tx_id).limit(500).all()
    names = CS._client_names(db, [r.client_machine_id for r in rows])
    items = [CS.owed_item(r, station, names.get(r.client_machine_id)) for r in rows]
    # Credits for a next order (§11.15א): what is left of each and its redemptions.
    by_id = {str(r.tx_id): r for r in rows}
    for item in items:
        if item["kind"] == "change_credit":
            tx = by_id[item["id"]]
            item["credit"] = CS.credit_out(db, tx, station)
            item["redemptions"] = [
                CS.redemption_out(x)
                for x in db.query(CashCreditRedemption).filter(CashCreditRedemption.tx_id == tx.tx_id).order_by(CashCreditRedemption.created_at).all()
            ]
    return {
        "items": items,
        "changeOwed": [i for i in items if i["kind"] == "change_owed"],
        "heldCredit": [i for i in items if i["kind"] == "held_credit"],
        "credits": [i for i in items if i["kind"] == "change_credit"],
    }


def resolve(db: Session, user: User, station: CashStation, tx_id: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    """The dashboard closes an owed item: paid_out (paid by hand), applied (offset in an order), written_off."""
    resolution = body.get("resolution")
    if resolution not in RESOLVE_CHOICES:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_resolution",
                      "resolution: paid_out | applied | written_off.")
    ident = CS._uuid(str(tx_id))
    tx = db.get(CashStationTx, ident) if ident is not None else None
    if tx is None or tx.station_id != station.id or tx.owed_status == "none":
        raise _refuse(status.HTTP_404_NOT_FOUND, "owed_not_found", "החוב לא נמצא.")
    if tx.owed_status == "resolved":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "already_resolved", "message": "החוב כבר נסגר.",
            "resolvedBy": CS.resolved_by_text(tx), "resolvedAt": CS._iso(tx.resolved_at), "resolution": tx.resolution,
        })
    note = " ".join(str(body.get("note") or "").split())[:300] or None
    CS.resolve_owed(db, tx, resolution=resolution, user={**_who(user), "via": "dashboard"}, note=note,
                    paid_agorot=int(tx.owed_agorot or 0) if resolution == "paid_out" else None)
    for till in CS.alert_tills(db, station):
        CS.wake(till, "cash_owed")
    return {"ok": True, "item": CS.owed_item(tx, station, CS._client_names(db, [tx.client_machine_id]).get(tx.client_machine_id))}


def assign_client(db: Session, user: User, station: CashStation, machine_id: Any, assigned: bool) -> List[Any]:
    """
    "שיוך קיוסק לעמדה" from the station's page: the device's own till parameter values — `cashEnabled` true and
    `cashStation` this station, or `cashEnabled` false (its `cashStation` left as it is) — each with its row in the
    parameters' change log, as the parameters page writes them. Only an active kiosk or till of the station's shop
    (404 `client_not_found`). The tills to tell (`publish_parameters_notify` after the commit); the caller commits.
    """
    from app.services import till_parameters as TP
    from app.models.pos_machine import PairingStatus
    from app.models.till_parameter import TillParameter

    ident = machine_id if isinstance(machine_id, uuid.UUID) else CS._uuid(str(machine_id))
    machine = db.get(POSMachine, ident) if ident is not None else None
    if (
        machine is None or not machine.is_active or machine.shop_id != station.shop_id
        or machine.pairing_status != PairingStatus.ASSIGNED or getattr(machine, "is_fiscal", True) is False
    ):
        raise _refuse(status.HTTP_404_NOT_FOUND, "client_not_found", "הקיוסק לא נמצא בסניף של העמדה.")
    if assigned and not station.is_active:
        raise _refuse(status.HTTP_409_CONFLICT, "station_inactive", "העמדה לא פעילה.")
    TP.ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(
        TillParameter.key.in_([CP.ENABLED_KEY, CP.STATION_KEY])).all()}
    now = CS._now()
    changed = TP.write_value(db, params[CP.ENABLED_KEY], "machine", machine.id, bool(assigned), user=user, now=now)
    if assigned:
        changed = TP.write_value(
            db, params[CP.STATION_KEY], "machine", machine.id, str(station.id), user=user, now=now,
        ) or changed
    db.flush()
    if not changed:
        return []
    # Its host serves the new client list; a host the kiosk leaves hears it too.
    for host in {CS.host_of(db, s) for s in CS.stations_of_shop(db, station.shop_id)} - {None}:
        CS.wake(host, "cash_stations")
    active = [p for p in params.values() if p.is_active]
    return list(TP.notify_targets_for_scope(db, "machine", machine.id)) if active else []


def parse_moment(value: Optional[str], field: str) -> Optional[datetime]:
    """An ISO date or date-time (a bare date: its midnight, UTC)."""
    if value in (None, ""):
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_date", f"{field}: ISO date or date-time.") from None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)
