"""
"עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md): the till's push of a failed payment
attempt (`POST /sync/{machine_id}/failed-payments`) and the dashboard's list
(`GET /failed-payments`). The logic lives in `app.services.failed_payments`.

"תשלום לא מוכרע" (app/services/card_attempt_commands.py) — an `unresolved` attempt:

    GET  /failed-payments/{attemptId}/card-commands          the manager's commands, newest first
    POST /failed-payments/{attemptId}/card-commands          {action: check | mark_approved |
                                                             mark_not_approved} → the command (201,
                                                             fire-and-forget; Idempotency-Key)
    GET  /failed-payments/card-commands/status?ids=          the background status read
    POST /failed-payments/card-commands/{commandId}/cancel   withdraw one not answered yet
    POST /sync/{machineId}/card-commands/{commandId}/result  the till's answer (machine token)

The heartbeat carries the pending ones (`pendingCardCommands`, app/routers/machines.py).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.failed_payment import (
    CardCommandIn,
    CardCommandResultIn,
    FailedPaymentIn,
    FailedPaymentListResponse,
    FailedPaymentUpsertOut,
)
from app.services import command_idempotency as idem
from app.services import failed_payments as svc

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_MACHINE_TOKEN

router = APIRouter(prefix="/failed-payments", tags=["failed-payments"])
till_router = APIRouter(prefix="/sync", tags=["failed-payments"])


# ── Till ─────────────────────────────────────────────────────────────────────


@till_router.post("/{machine_id}/failed-payments", response_model=FailedPaymentUpsertOut, dependencies=FISCAL_MACHINE_TOKEN)
def post_failed_payment(
    machine_id: str,
    body: FailedPaymentIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One failed or aborted payment attempt. Idempotent upsert by `id`: 201 `accepted` the
    first time; 200 `updated` when its content changed and `updatedAt` is not older than
    the stored row; 200 `duplicate` otherwise. 409 `failed_payment_id_conflict` for
    another till's id, 409 `machine_not_assigned` for a till with no shop.
    """
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    # "מצב הדרכה": a training attempt is quarantined (app/services/training_mode.py) and
    # answered like a real one — it never reaches a real report.
    from app.services import training_mode as TM

    decision = svc.training_route(db, machine, body)
    if decision != TM.REAL:
        outcome = svc.divert_training(db, machine, body, decision)
        db.commit()
        response.status_code = status.HTTP_201_CREATED if outcome == "accepted" else status.HTTP_200_OK
        return FailedPaymentUpsertOut(id=body.id, status=outcome)
    try:
        row, outcome = svc.upsert(db, machine, body)
    except svc.IdConflict:
        db.rollback()
        # Another till's id: nothing to overwrite, nothing to tell.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="failed_payment_id_conflict")
    db.commit()
    response.status_code = status.HTTP_201_CREATED if outcome == "accepted" else status.HTTP_200_OK
    return FailedPaymentUpsertOut(id=row.id, status=outcome)


# ── Dashboard ────────────────────────────────────────────────────────────────


@router.get("", response_model=FailedPaymentListResponse, response_model_by_alias=True)
def list_failed_payments(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    shift_id: Optional[uuid.UUID] = Query(None, alias="shiftId"),
    z_report_id: Optional[uuid.UUID] = Query(None, alias="zReportId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    outcome: Optional[str] = Query(None, max_length=200, description="Comma-separated outcomes"),
    card_last4: Optional[str] = Query(None, alias="cardLast4", pattern=r"^\d{4}$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=svc.PAGE_SIZE_MAX, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Failed payment attempts, newest first, scoped like `GET /transactions`, with the
    summary (sales and payouts apart) and the cancelled sales no attempt accounts for.

    `zReportId`: every shift, till and window the Z covers (a shop Z: every till's; each
    item carries its till's name and number). Without a shift, a Z or dates: the last
    30 days, like the transactions.
    """
    try:
        filters = svc.filters_for(
            db,
            active_tenant_id,
            machine_id=machine_id,
            shop_id=shop_id,
            shift_id=shift_id,
            z_report_id=z_report_id,
            from_date=from_date,
            to_date=to_date,
            outcome=outcome,
            card_last4=card_last4,
        )
    except svc.ZNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z-report not found")
    return FailedPaymentListResponse.model_validate(
        svc.list_response(db, current_user, active_tenant_id, filters, page=page, page_size=page_size)
    )


# ── "תשלום לא מוכרע": the manager's commands to the till (app/services/card_attempt_commands.py) ──


def _attempt_or_404(db: Session, attempt_id, user: User, active_tenant_id):
    attempt = svc.attempt_for_user(db, active_tenant_id, user, attempt_id)
    if attempt is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Failed payment attempt not found")
    return attempt


@router.get("/{attempt_id}/card-commands")
def list_card_commands(
    attempt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Every command a manager sent about this attempt, newest first, with what the till answered."""
    from app.services import card_attempt_commands as CC

    attempt = _attempt_or_404(db, attempt_id, current_user, active_tenant_id)
    CC.expire_overdue(db, machine_id=attempt.machine_id)
    db.commit()
    return {"attemptId": str(attempt.id), "items": [CC.command_out(c) for c in CC.for_attempt(db, attempt.id)]}


@router.get("/card-commands/status")
def get_card_commands_status(
    ids: List[uuid.UUID] = Query(..., max_length=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The background status read of "פקודות שנשלחו" for card commands: these commands as they are
    now, each only when its attempt is one the user sees (the list's own scope); others left out.
    """
    from app.models.card_attempt_command import CardAttemptCommand
    from app.services import card_attempt_commands as CC

    rows = db.query(CardAttemptCommand).filter(CardAttemptCommand.id.in_(list(ids))).all()
    visible: dict = {}
    mine = []
    for cmd in rows:
        if cmd.tenant_id is not None and cmd.tenant_id != active_tenant_id:
            continue
        attempt_id = cmd.failed_payment_attempt_id
        if attempt_id is None:
            continue
        if attempt_id not in visible:
            visible[attempt_id] = svc.attempt_for_user(db, active_tenant_id, current_user, attempt_id) is not None
        if visible[attempt_id]:
            mine.append(cmd)
    # Read only: a check past its end reads `expired` without writing (a poll never races the till).
    now = datetime.now(timezone.utc)
    return {"items": [_card_as_of(c, now) for c in mine]}


def _card_as_of(cmd, now: datetime) -> dict:
    """A card command as it stands at [now]: a pending check past its `expires_at` reads `expired`."""
    from app.services import card_attempt_commands as CC

    out = CC.command_out(cmd)
    expires = cmd.expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if cmd.status == CC.STATUS_PENDING and expires is not None and expires <= now:
        out["status"] = "expired"
        out["statusLabel"] = CC.STATUS_LABELS_HE["expired"]
    return out


@router.post("/{attempt_id}/card-commands", status_code=status.HTTP_201_CREATED)
def create_card_command(
    attempt_id: uuid.UUID,
    body: CardCommandIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
    response: Response = None,
    idempotency_key: Annotated[Optional[str], Header(alias="Idempotency-Key")] = None,
):
    """
    "בדוק במסוף" (`check`) / "סמן כאושר" (`mark_approved`) / "סמן כלא אושר" (`mark_not_approved`)
    for an `unresolved` attempt, sent to the till that made it — said on its heartbeat
    (`pendingCardCommands`) until it answers, and at once by the realtime event `card-command`
    when it is online. The people of a remote credit: owner / manager roles who may act on that
    till. `404` · `403` · `409 attempt_not_unresolved | attempt_without_vuid | card_command_pending`.
    """
    from app.models.card_attempt_command import CardAttemptCommand
    from app.routers.machines import check_shift_admin_access
    from app.services import card_attempt_commands as CC

    attempt = _attempt_or_404(db, attempt_id, current_user, active_tenant_id)
    machine = db.get(POSMachine, attempt.machine_id)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    check_shift_admin_access(db, machine, current_user, active_tenant_id)
    # Fire-and-forget (the till answers later — `GET /failed-payments/card-commands/status`).
    # `Idempotency-Key`: a retry of this very request gets this command back — never a second
    # command, and never a 409 for its own first try. Every rule of `CC.create` is unchanged.
    made: dict = {}

    def run():
        made["cmd"] = CC.create(db, attempt, machine, body.action, current_user, confirm_mismatch=body.confirm_mismatch)
        return CC.command_out(made["cmd"])

    def wake(_out):
        CC.notify(machine, made["cmd"])
        db.commit()

    out, replayed = idem.once(
        db, tenant_id=active_tenant_id, kind="card_command", key=idempotency_key, user=current_user,
        request={"attemptId": str(attempt_id), **body.model_dump(mode="json", by_alias=True)},
        run=run, after_commit=wake,
        # A replay: the same command re-read by id (its status now), never a second one.
        refresh=lambda first: CC.command_out(db.get(CardAttemptCommand, uuid.UUID(str(first["id"])))) or first,
    )
    if replayed:
        if response is not None:
            response.headers[idem.REPLAY_HEADER] = "true"
        return out
    return CC.command_out(made["cmd"])


@router.post("/card-commands/{command_id}/cancel")
def cancel_card_command(
    command_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Withdraw a command the till has not answered yet (`409 card_command_not_pending`)."""
    from app.models.card_attempt_command import CardAttemptCommand
    from app.routers.machines import check_shift_admin_access
    from app.services import card_attempt_commands as CC

    cmd = db.get(CardAttemptCommand, command_id)
    if cmd is None or (cmd.tenant_id is not None and cmd.tenant_id != active_tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card command not found")
    machine = db.get(POSMachine, cmd.machine_id)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    check_shift_admin_access(db, machine, current_user, active_tenant_id)
    CC.cancel(db, cmd, current_user)
    db.commit()
    return CC.command_out(cmd)


@till_router.post("/{machine_id}/card-commands/{command_id}/result", dependencies=FISCAL_MACHINE_TOKEN)
def post_card_command_result(
    machine_id: str,
    command_id: str,
    body: CardCommandResultIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The till's answer to a `pendingCardCommands` item: `{status: done | failed | not_found | busy,
    outcome?: approved | not_charged | unknown, message?}`. Sets the command's status (a repeated
    answer keeps the first); the attempt row itself comes with the till's normal upload.
    `404 unknown_command` for a command not given to this till.
    """
    from app.services import card_attempt_commands as CC

    cmd = CC.apply_result(
        db, machine, command_id, result_status=body.status, outcome=body.outcome, message=body.message,
        details=body.details.stored() if body.details is not None else None,
    )
    db.commit()
    return {
        "commandId": str(cmd.id),
        "status": cmd.status,
        "outcome": cmd.result_outcome,
        "answeredAt": cmd.answered_at.isoformat() if cmd.answered_at else None,
    }
