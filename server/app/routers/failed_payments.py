"""
"עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md): the till's push of a failed payment
attempt (`POST /sync/{machine_id}/failed-payments`) and the dashboard's list
(`GET /failed-payments`). The logic lives in `app.services.failed_payments`.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.failed_payment import FailedPaymentIn, FailedPaymentListResponse, FailedPaymentUpsertOut
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
