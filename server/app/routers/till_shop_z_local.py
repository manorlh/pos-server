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


class LocalShopZAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: str = Field(..., alias="requestId", max_length=64)
    phase: Literal["received", "failed"]
    message: Optional[str] = Field(None, max_length=500)


@router.post("/sync/{machine_id}/shop-z/local-request/ack")
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


@router.post("/sync/{machine_id}/shop-z/local", status_code=status.HTTP_201_CREATED)
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
    return out
