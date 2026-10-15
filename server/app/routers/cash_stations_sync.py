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

The cloud relay (§14.4, app/services/cash_relay.py) — for a client whose `cashRoute` is cloud / auto:
POST /sync/{client_id}/cash/relay                          {requestId, stationId, method, path, client, ts, nonce, sig,
                                                             body, waitMs} → {api, requestId, state: pending | done |
                                                             expired | lost, reply?: {status, body, hostTime}}; 403
                                                             not_assigned, 409 cloud_route_off / no_host / relay_conflict,
                                                             422 bad_request
GET  /sync/{client_id}/cash/relay/{request_id}?waitMs=     → the same answer; 404 relay_not_found
POST /sync/{host_id}/cash/relay/poll                       {replies: [{requestId, status, body, hostTime}], waitMs} →
                                                             {api, relay, requests: [...]} — a cash host or a host kiosk;
                                                             a long poll (the Windows app has no realtime channel)
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
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
from app.services import cash_relay as CRL
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


# ── The cloud relay (§14.4) ────────────────────────────────────────────────────


class RelayIn(BaseModel):
    """A client's LAN call as it signed it (§11.3) — checked by app/services/cash_relay.py `submit`."""

    model_config = ConfigDict(populate_by_name=True)

    request_id: Optional[str] = Field(None, alias="requestId", max_length=64)
    station_id: Optional[str] = Field(None, alias="stationId", max_length=64)
    method: Optional[str] = Field(None, max_length=8)
    path: Optional[str] = Field(None, max_length=300)
    client: Optional[str] = Field(None, max_length=64)
    ts: Optional[Union[int, str]] = None
    nonce: Optional[str] = Field(None, max_length=64)
    sig: Optional[str] = Field(None, max_length=64)
    #: The exact JSON text signed ('' — none).
    body: Optional[str] = Field(None, max_length=2 * CRL.BODY_MAX)
    wait_ms: Optional[int] = Field(None, alias="waitMs")


class RelayPollIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The answers to the calls taken last time: [{requestId, status, body, hostTime}] — checked one by one.
    replies: List[Any] = Field(default_factory=list, max_length=CRL.REPLIES_MAX)
    wait_ms: Optional[int] = Field(None, alias="waitMs")


def _relay_submit(db: Session, machine: POSMachine, raw: Dict[str, Any]) -> uuid.UUID:
    try:
        row = CRL.submit(db, machine, raw)
        ident = row.id
        db.commit()
        return ident
    except Exception:
        db.rollback()
        raise


def _relay_look(db: Session, machine: POSMachine, request_id: Any):
    """The call's state now (a fresh read), lapses marked; the connection back to the pool between looks."""
    db.rollback()
    try:
        row = CRL.get_for_client(db, machine, request_id)
        if CRL.settle(row):
            db.commit()
            row = CRL.get_for_client(db, machine, request_id)
        body = CRL.out(row)
        return body, body["state"] in ("done", "expired", "lost")
    finally:
        db.rollback()


async def _relay_wait(db: Session, machine: POSMachine, request_id: Any, wait_ms: int) -> Dict[str, Any]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_ms / 1000
    while True:
        body, final = await run_in_threadpool(_relay_look, db, machine, request_id)
        left = deadline - loop.time()
        if final or left <= 0:
            return body
        await asyncio.sleep(min(CRL.CLIENT_CHECK_S, left))


@router.post("/{machine_id}/cash/relay", dependencies=FISCAL_MACHINE_TOKEN)
async def post_cash_relay(
    machine_id: str,
    body: RelayIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    §14.4: a client's LAN call for its station's host, kept by its `requestId`, and its answer awaited up to `waitMs`
    (`pending` — asked again by GET). The same `requestId` again is the same call.
    """
    raw = body.model_dump(by_alias=True)
    wait = CRL.wait_ms_of(raw.pop("waitMs", None), CRL.CLIENT_WAIT_DEFAULT_MS, CRL.CLIENT_WAIT_MAX_MS)
    request_id = await run_in_threadpool(_relay_submit, db, machine, raw)
    return await _relay_wait(db, machine, request_id, wait)


@router.get("/{machine_id}/cash/relay/{request_id}", dependencies=FISCAL_MACHINE_TOKEN)
async def get_cash_relay(
    machine_id: str,
    request_id: str,
    wait_ms: Optional[int] = Query(None, alias="waitMs"),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """§14.4: the call's state, its answer awaited up to `waitMs`."""
    wait = CRL.wait_ms_of(wait_ms, CRL.CLIENT_WAIT_DEFAULT_MS, CRL.CLIENT_WAIT_MAX_MS)
    return await _relay_wait(db, machine, request_id, wait)


def _poll_begin(db: Session, host: POSMachine, replies: List[Any]):
    """The host's answers stored, old rows purged; whether it should listen at all, and how often to look."""
    try:
        CRL.store_replies(db, host, replies)
        CRL.purge(db)
        db.commit()
        return CRL.relay_wanted(db, host), CRL.host_active(db, host)
    finally:
        db.rollback()


def _poll_take(db: Session, host: POSMachine) -> List[Dict[str, Any]]:
    db.rollback()
    try:
        rows = CRL.take(db, host)
        now = CRL._now()
        out = [CRL.request_out(r, now) for r in rows]
        db.commit()
        return out
    except Exception:
        db.rollback()
        raise


@router.post("/{machine_id}/cash/relay/poll", dependencies=CASH_HOST_MACHINE_TOKEN)
async def post_cash_relay_poll(
    machine_id: str,
    body: RelayPollIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    §14.4, a cash host / a host kiosk: its answers to the calls it took, then the calls waiting for its stations —
    each handed over once — or a wait for one up to `waitMs` (a long poll). `relay: false` — no client of its
    stations routes through the cloud: it stops listening.
    """
    wait = CRL.wait_ms_of(body.wait_ms, 0, CRL.HOST_WAIT_MAX_MS)
    wanted, active = await run_in_threadpool(_poll_begin, db, machine, body.replies)
    every = CRL.HOST_CHECK_ACTIVE_S if active else CRL.HOST_CHECK_IDLE_S
    loop = asyncio.get_running_loop()
    deadline = loop.time() + (wait / 1000 if wanted else 0)
    while True:
        requests = await run_in_threadpool(_poll_take, db, machine)
        left = deadline - loop.time()
        if requests or left <= 0:
            return {"api": CRL.API, "relay": wanted, "requests": requests}
        await asyncio.sleep(min(every, left))
