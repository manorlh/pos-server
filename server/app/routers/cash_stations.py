"""
"עמדות מזומן" on the dashboard (P:/specs/cash-paylink.md §12; app/services/cash_station_admin.py).

GET    /cash-stations?shopId=&companyId=&includeInactive=   → {stations: [...]} (host, serial, assigned kiosks,
                                                              state, change, alerts, open owed)
POST   /cash-stations                                       {shopId, name, location?, serial?, hostMachineId?,
                                                              settings?, isActive?} → the station
GET    /cash-stations/{id}                                  → the station in detail (denominations, cashbox,
                                                              queue, active tx, settings, alert tills, commands)
PUT    /cash-stations/{id}                                  {name?, location?, serial?, hostMachineId?, settings?,
                                                              isActive?} → the station
PUT    /cash-stations/{id}/clients/{machineId}              {assigned: true|false} — the device's own cashEnabled
                                                              (+ cashStation) → the station (detail)
DELETE /cash-stations/{id}                                  → taken out of use (its journal and drawer stay)
GET    /cash-stations/{id}/journal?from=&to=&state=&outcome=&owed=&limit=&offset=
GET    /cash-stations/{id}/movements?from=&to=&kind=&limit=&offset=
GET    /cash-stations/{id}/owed?status=open|resolved|all     → change owed and credits held
POST   /cash-stations/{id}/owed/{txId}/resolve              {resolution: paid_out|applied|written_off, note?}
POST   /cash-stations/{id}/commands                         {op: refill|count|collect|dump|deliver_pending|float,
                                                              args?} → the command (delivered with the host's pull)
GET    /cash-stations/{id}/drawer?from=&to=                 → the period's drawer, the reconciliation, the
                                                              balance, and the Zs that took it
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services import cash_station_admin as A
from app.services import cash_station_drawer as D
from app.services import cash_stations as CS

router = APIRouter(prefix="/cash-stations", tags=["cash-stations"])


class StationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    name: Optional[str] = Field(None, max_length=200)
    location: Optional[str] = Field(None, max_length=200)
    serial: Optional[str] = Field(None, max_length=64)
    host_machine_id: Optional[uuid.UUID] = Field(None, alias="hostMachineId")
    #: The station's own overrides of the §11.10 station parameters (null value: inherit).
    settings: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = Field(None, alias="isActive")


class ClientIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    assigned: bool


class ResolveIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    resolution: str = Field(..., max_length=20)
    note: Optional[str] = Field(None, max_length=1000)


class CommandIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    op: str = Field(..., max_length=20)
    args: Optional[Dict[str, Any]] = None


def _body(model: BaseModel) -> Dict[str, Any]:
    out = model.model_dump(by_alias=True, exclude_unset=True)
    for key in ("shopId", "hostMachineId"):
        if out.get(key) is not None:
            out[key] = str(out[key])
    return out


@router.get("")
def list_cash_stations(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    include_inactive: bool = Query(False, alias="includeInactive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return A.list_stations(db, current_user, active_tenant_id, shop_id=shop_id, company_id=company_id,
                           include_inactive=include_inactive)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_cash_station(
    body: StationIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        station = A.create_station(db, current_user, active_tenant_id, _body(body))
        out = A.station_out(db, station, detail=True)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return out


@router.get("/{station_id}")
def get_cash_station(
    station_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    return A.station_out(db, station, detail=True)


@router.put("/{station_id}")
def put_cash_station(
    station_id: uuid.UUID,
    body: StationIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    try:
        A.update_station(db, current_user, station, _body(body))
        out = A.station_out(db, station, detail=True)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return out


@router.delete("/{station_id}")
def delete_cash_station(
    station_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    out = A.remove_station(db, current_user, station)
    db.commit()
    return out


@router.put("/{station_id}/clients/{machine_id}")
def put_cash_station_client(
    station_id: uuid.UUID,
    machine_id: uuid.UUID,
    body: ClientIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A kiosk (or a till) of the station's shop assigned to it (`cashEnabled` true + `cashStation` = the station, at
    the device's own level) or taken off cash (`cashEnabled` false). Answers the station; the device re-pulls.
    """
    from app.services import till_parameters as TP

    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    try:
        targets = A.assign_client(db, current_user, station, machine_id, body.assigned)
        db.commit()
    except Exception:
        db.rollback()
        raise
    if targets:
        background_tasks.add_task(TP.publish_parameters_notify, targets)
    return A.station_out(db, station, detail=True)


@router.get("/{station_id}/journal")
def get_cash_station_journal(
    station_id: uuid.UUID,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    state: Optional[str] = None,
    outcome: Optional[str] = None,
    owed: Optional[str] = None,
    limit: int = Query(50, ge=1, le=A.PAGE_MAX),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    return A.journal(
        db, station, date_from=A.parse_moment(date_from, "from"), date_to=A.parse_moment(date_to, "to"),
        state=state, outcome=outcome, owed=owed, limit=limit, offset=offset,
    )


@router.get("/{station_id}/movements")
def get_cash_station_movements(
    station_id: uuid.UUID,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    kind: Optional[str] = None,
    limit: int = Query(50, ge=1, le=A.PAGE_MAX),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    return A.movements(db, station, date_from=A.parse_moment(date_from, "from"), date_to=A.parse_moment(date_to, "to"),
                       kind=kind, limit=limit, offset=offset)


@router.get("/{station_id}/owed")
def get_cash_station_owed(
    station_id: uuid.UUID,
    which: str = Query("open", alias="status"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    return A.owed(db, station, which=which)


@router.post("/{station_id}/owed/{tx_id}/resolve")
def post_cash_station_owed_resolve(
    station_id: uuid.UUID,
    tx_id: str,
    body: ResolveIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    try:
        out = A.resolve(db, current_user, station, tx_id, body.model_dump(by_alias=True))
    except Exception:
        db.rollback()
        raise
    db.commit()
    return out


@router.post("/{station_id}/commands", status_code=status.HTTP_201_CREATED)
def post_cash_station_command(
    station_id: uuid.UUID,
    body: CommandIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    try:
        row = CS.create_command(db, current_user, station, body.op, body.args)
        out = CS.command_out(row)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return out


@router.get("/{station_id}/drawer")
def get_cash_station_drawer(
    station_id: uuid.UUID,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    station = A.station_in_scope(db, current_user, station_id, active_tenant_id)
    return D.drawer(db, station, date_from=A.parse_moment(date_from, "from"), date_to=A.parse_moment(date_to, "to"))
