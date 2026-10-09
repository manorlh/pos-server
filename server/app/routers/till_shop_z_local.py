"""
The shop Z in local mode, from the main till (docs/SPEC_INDEPENDENT_TILL.md §8,
app/services/local_shop_z.py) — with the till's own token:

GET  /sync/{machine_id}/shop-z/history?days=31 → what the main till keeps to number and
                                                 print the shop Z with no internet: the
                                                 last shop Z number, a month of the shop's
                                                 Zs, the participants, the local mode
POST /sync/{machine_id}/shop-z/local           → a shop Z the main till produced (closed the
                                                 tills over the LAN, numbered, printed):
                                                 201 created / 200 duplicate; 409
                                                 `offline_z_out_of_sequence` /
                                                 `offline_z_number_taken` /
                                                 `not_shop_z_producer` — the Z is kept as
                                                 printed as a conflict for support (never
                                                 renumbered; `conflictRecorded: true`),
                                                 `shift_not_closed` / `shift_unknown` (wait:
                                                 a till's close has not reached the cloud)
GET  /sync/{machine_id}/shop-z/shift-guard     → "חסימת Z כשיש משמרות פתוחות": on? and the
                                                 tills blocking the shop Z (app/services/z_shift_guard.py)

A participant off the LAN, closed through the cloud (§8.14):
POST /sync/{machine_id}/shop-z/remote-close     → the main till asks: `{roundId, requests:
                                                 [{machineId, requestId, force}]}`
GET  /sync/{machine_id}/shop-z/remote-parts     → the main till pulls the round's answers
POST /sync/{machine_id}/shop-z/remote-part      → the remote machine answers (the LAN close's
                                                 report, with its section and manifest)
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.services import local_shop_z as LZ

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_SYNC_PATH

router = APIRouter(tags=["till-shop-z-local"])


def _machine(machine_id: str, machine: POSMachine) -> POSMachine:
    if str(machine.id) != str(machine_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="machine_mismatch")
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    return machine


@router.get("/sync/{machine_id}/shop-z/history")
def till_shop_z_history(
    machine_id: str,
    days: int = Query(LZ.HISTORY_DAYS, ge=1, le=366),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    out = LZ.history(db, machine, days=days)
    db.commit()
    return out


@router.get("/sync/{machine_id}/shop-z/shift-guard")
def till_shop_z_shift_guard(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    "חסימת Z כשיש משמרות פתוחות" (app/services/z_shift_guard.py), asked by the main till before
    its local shop Z: `{required, blockers: [{machineId, name, posNumber, status, online, words}]}`
    — the shop's tills (not this one) with a shift open or closed and not yet accepted here. The
    till refuses the Z while any; it can never force (only a super admin, in the cloud).
    """
    from app.models.shop import Shop
    from app.services import z_shift_guard as G

    machine = _machine(machine_id, machine)
    shop = db.get(Shop, machine.shop_id)
    required = G.required(db, shop)
    blockers = [b for b in G.shop_blockers(db, shop) if b["machineId"] != str(machine.id)] if required else []
    return {"required": required, "blockers": blockers}


class LocalShopZAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: str = Field(..., alias="requestId", max_length=64)
    phase: Literal["received", "failed"]
    message: Optional[str] = Field(None, max_length=500)


@router.post("/sync/{machine_id}/shop-z/local-request/ack", dependencies=FISCAL_SYNC_PATH)
def till_shop_z_local_request_ack(
    machine_id: str,
    body: LocalShopZAckIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The main till on the dashboard's request: running it, or why the Z is blocked."""
    machine = _machine(machine_id, machine)
    try:
        out = LZ.ack_request(db, machine, body.request_id, body.phase, body.message)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    db.commit()
    return out


@router.post("/sync/{machine_id}/shop-z/local", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_SYNC_PATH)
def till_shop_z_local_upload(
    machine_id: str,
    body: LZ.LocalShopZIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    try:
        z, outcome = LZ.upload(db, machine, body)
    except LZ.LocalShopZRefused as refused:
        if refused.keep:
            # A number that cannot be filed as printed: the Z is kept as a conflict for
            # support (never renumbered) — that record is committed.
            db.commit()
        else:
            db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    out = LZ.upload_out(z, outcome)
    db.commit()
    if outcome == "duplicate":
        return JSONResponse(status_code=status.HTTP_200_OK, content=out)
    # "סגירה יחד עם ה-Z הסניפי": the shop's kiosks set so, and not in this local Z (an
    # independent kiosk has no LAN), close and make their own Z (app/services/kiosk_ops.py).
    try:
        from app.services import kiosk_ops

        kiosk_ops.on_local_shop_z(db, machine.shop_id, z)
        db.commit()
    except Exception:  # noqa: BLE001 - never fails the Z's upload
        db.rollback()
    return out


# ── A participant off the LAN, closed through the cloud (§8.14) ────────────────


class RemoteCloseRequestIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: str = Field(..., alias="machineId", max_length=64)
    request_id: str = Field(..., alias="requestId", min_length=1, max_length=64)
    force: bool = True


class RemoteCloseIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    round_id: str = Field(..., alias="roundId", min_length=1, max_length=64)
    requests: list[RemoteCloseRequestIn] = Field(default_factory=list, max_length=200)


def _refused(refused: "LZ.RemotePartRefused") -> JSONResponse:
    return JSONResponse(status_code=refused.status_code, content=refused.body)


@router.post("/sync/{machine_id}/shop-z/remote-close", dependencies=FISCAL_SYNC_PATH)
def till_shop_z_remote_close(
    machine_id: str,
    body: RemoteCloseIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The main till asks the cloud to close its remote participants for a round."""
    machine = _machine(machine_id, machine)
    try:
        out = LZ.request_remote_parts(
            db, machine, body.round_id,
            [{"machineId": r.machine_id, "requestId": r.request_id, "force": r.force} for r in body.requests],
        )
    except LZ.RemotePartRefused as refused:
        db.rollback()
        return _refused(refused)
    db.commit()
    return out


@router.get("/sync/{machine_id}/shop-z/remote-parts")
def till_shop_z_remote_parts(
    machine_id: str,
    round_id: str = Query(..., alias="roundId", min_length=1, max_length=64),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The main till pulls its round's remote answers — each the LAN close's report, as sent."""
    machine = _machine(machine_id, machine)
    out = LZ.remote_parts(db, machine, round_id)
    db.commit()
    return out


@router.post("/sync/{machine_id}/shop-z/remote-part", dependencies=FISCAL_SYNC_PATH)
def till_shop_z_remote_part(
    machine_id: str,
    body: dict,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """A remote participant's answer to the main till's close: its report, section and manifest."""
    machine = _machine(machine_id, machine)
    try:
        out = LZ.report_remote_part(db, machine, body)
    except LZ.RemotePartRefused as refused:
        db.rollback()
        return _refused(refused)
    db.commit()
    return out
