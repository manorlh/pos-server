"""Dashboard close-day endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
from app.models.user import User
from app.schemas.close_day import (
    CloseDayCreateIn,
    CloseDayCreateResponse,
    CloseDayRequestOut,
)
from app.services.close_day import (
    create_close_day_request,
    create_response_out,
    get_close_day_request,
    request_to_out,
    resolve_machines_for_close_day,
)

router = APIRouter(tags=["close-day"])


@router.post(
    "/machines/close-day",
    response_model=CloseDayCreateResponse,
    response_model_by_alias=True,
)
def post_close_day(
    body: CloseDayCreateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machines = resolve_machines_for_close_day(
        db,
        current_user,
        active_tenant_id,
        machine_ids=body.machine_ids,
        shop_id=body.shop_id,
    )
    request = create_close_day_request(
        db,
        current_user,
        active_tenant_id,
        machines,
        shop_id=body.shop_id,
    )
    return create_response_out(request)


@router.get(
    "/close-day-requests/{request_id}",
    response_model=CloseDayRequestOut,
    response_model_by_alias=True,
)
def get_close_day_request_detail(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    request = get_close_day_request(db, request_id, active_tenant_id)
    if request is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
    return request_to_out(request)
