"""
"מכשיר מזומן" — what the devices call (P:/specs/cash-paylink.md §11.2, §11.8, §11.9; app/services/cash_stations.py).

GET  /sync/{machine_id}/cash                               → a kiosk / till: `role: "client"` (its station, the
                                                             host's LAN address, its own secret, the settings);
                                                             a cash host: `role: "host"` (its secret, stations,
                                                             commands, settings, LAN alert targets). ETag /
                                                             If-None-Match → 304
POST /sync/{host_id}/cash/journal                          {entries: [tx | movement]} → {accepted, rejected} —
                                                             a cash host only
POST /sync/{host_id}/cash/commands/{command_id}/ack        {status: done|refused|failed, message, movementId} —
                                                             a cash host only
GET  /sync/{till_id}/cash/owed                             → {items: [...]} — the tills of `cashAlertTills`
POST /sync/{till_id}/cash/owed/{owed_id}/pay               {movementId, shiftId, userId, userName, amountAgorot}
                                                             → {ok, item}; the same movementId again → the same;
                                                             409 already_resolved {resolvedBy, resolvedAt}
GET  /sync/{m}/cash/credits/{code}                         → {credit} — a till / kiosk of the credit's company (§11.15א)
POST /sync/{m}/cash/credits/{code}/redeem                  {redemptionId, amountAgorot, documentId?} → {ok, redemption,
                                                             credit}; the same redemptionId → the same; 409 credit_used /
                                                             amount_exceeds / redemption_conflict, 400 amount, 404
POST /sync/{m}/cash/credits/redemptions/{id}/release       → {ok, credit}; repeats harmlessly; 409 confirmed
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    CASH_HOST_MACHINE_TOKEN,
    FISCAL_MACHINE_TOKEN,
    get_pos_machine_for_sync_path,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.services import cash_stations as CS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["cash-stations"])


class JournalIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Each entry as the host keeps it: `{"type": "tx", …§11.5}` / `{"type": "movement", …}` — checked one by one,
    #: never a 422 for one bad entry.
    entries: List[Any] = Field(default_factory=list, max_length=CS.JOURNAL_MAX)


class CommandAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str = Field(..., max_length=16)
    message: Optional[str] = Field(None, max_length=1000)
    movement_id: Optional[str] = Field(None, alias="movementId", max_length=64)


class CreditRedeemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    redemption_id: Optional[str] = Field(None, alias="redemptionId", max_length=64)
    amount_agorot: Optional[int] = Field(None, alias="amountAgorot")
    document_id: Optional[str] = Field(None, alias="documentId", max_length=64)


class OwedPayIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    movement_id: uuid.UUID = Field(..., alias="movementId")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    user_id: Optional[str] = Field(None, alias="userId", max_length=100)
    user_name: Optional[str] = Field(None, alias="userName", max_length=200)
    amount_agorot: Optional[int] = Field(None, alias="amountAgorot", ge=0)


def _tags(request: Optional[Request]) -> List[str]:
    raw = request.headers.get("if-none-match") if request is not None else None
    return [t.strip().strip('"').removeprefix("W/").strip('"') for t in (raw or "").split(",") if t.strip()]


@router.get("/{machine_id}/cash")
def get_cash(
    machine_id: str,
    request: Request = None,
    response: Response = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """§11.2: the device's cash view. Pulled with the parameters (~25 s) and at start; 304 when unchanged."""
    body = CS.view_for(db, machine)
    tag = CS.etag_of(body)
    if tag in _tags(request):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": f'"{tag}"'})
    if response is not None:
        response.headers["ETag"] = f'"{tag}"'
    return body


@router.post("/{machine_id}/cash/journal", dependencies=CASH_HOST_MACHINE_TOKEN)
def post_cash_journal(
    machine_id: str,
    body: JournalIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§11.9: the host's transactions and drawer movements. Idempotent by id; a transaction only with a higher seq."""
    out = CS.apply_journal(db, machine, body.entries)
    db.commit()
    return out


@router.post("/{machine_id}/cash/commands/{command_id}/ack", dependencies=CASH_HOST_MACHINE_TOKEN)
def post_cash_command_ack(
    machine_id: str,
    command_id: str,
    body: CommandAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§11.2: a command the host carried out (or refused / failed) — once; a repeat answers as it stands."""
    out = CS.ack_command(db, machine, command_id, body.model_dump(by_alias=True))
    db.commit()
    return out


@router.get("/{machine_id}/cash/owed")
def get_cash_owed(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """§11.8: change owed and credits held, for a till of the stations' `cashAlertTills` (empty for any other)."""
    return {"api": CS.API, "items": CS.owed_items_for_till(db, machine)}


@router.post("/{machine_id}/cash/owed/{owed_id}/pay", dependencies=FISCAL_MACHINE_TOKEN)
def post_cash_owed_pay(
    machine_id: str,
    owed_id: str,
    body: OwedPayIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    §11.8 "שולם ללקוח": the till paid it out of its drawer (online only — the till then records its own
    `cash_out` with the same movementId). Idempotent by movementId.
    """
    payload: Dict[str, Any] = {
        "movementId": str(body.movement_id),
        "shiftId": str(body.shift_id) if body.shift_id else None,
        "userId": body.user_id,
        "userName": body.user_name,
        "amountAgorot": body.amount_agorot,
    }
    out = CS.pay_owed(db, machine, owed_id, payload)
    db.commit()
    return out


@router.get("/{machine_id}/cash/credits/{code}", dependencies=FISCAL_MACHINE_TOKEN)
def get_cash_credit(
    machine_id: str,
    code: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§11.15א: a cash credit ("זיכוי להזמנה הבאה") by its code — what is left of it."""
    return {"api": CS.API, **CS.lookup_credit(db, machine, code)}


@router.post("/{machine_id}/cash/credits/{code}/redeem", dependencies=FISCAL_MACHINE_TOKEN)
def post_cash_credit_redeem(
    machine_id: str,
    code: str,
    body: CreditRedeemIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§11.15א: part (or all) of a cash credit taken for an order, by the device's own redemption id."""
    out = CS.redeem_credit(db, machine, code, body.model_dump(by_alias=True))
    db.commit()
    return {"api": CS.API, **out}


@router.post("/{machine_id}/cash/credits/redemptions/{redemption_id}/release", dependencies=FISCAL_MACHINE_TOKEN)
def post_cash_credit_release(
    machine_id: str,
    redemption_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§11.15א: the order was not paid — the amount back on the credit."""
    out = CS.release_redemption(db, machine, redemption_id)
    db.commit()
    return {"api": CS.API, **out}
