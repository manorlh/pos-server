"""
A standalone remote shift close, as the dashboard follows it (docs/SHIFTS_API.md §2.14).

Created by `POST /machines/{id}/close-shift`; same roles and till access as creating it.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
from app.models.user import User
from app.routers.machines import check_shift_admin_access
from app.schemas.shift_close_request import ShiftCloseRequestOut
from app.services import shift_close_requests as close_requests

router = APIRouter(prefix="/shift-close-requests", tags=["shift-close-requests"])


def _request_or_404(db: Session, request_id: uuid.UUID, user: User, tenant_id):
    req = close_requests.get_request(db, request_id, tenant_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Close request not found")
    check_shift_admin_access(db, req.machine, user, tenant_id)
    return req


@router.get("/{request_id}", response_model=ShiftCloseRequestOut, response_model_by_alias=True)
def get_shift_close_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Progress. Also sweeps expiry, and completes it if the shift is already closed."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    changed = close_requests.expire_overdue(db)
    changed = close_requests.reconcile(db, req) or changed
    if changed:
        db.commit()
        db.refresh(req)
    return close_requests.request_to_out(db, req)


@router.post("/{request_id}/cancel", response_model=ShiftCloseRequestOut, response_model_by_alias=True)
def cancel_shift_close_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Stop offering it to the till. `409 request_not_pending` once it has ended."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    close_requests.cancel(db, req)
    db.commit()
    db.refresh(req)
    return close_requests.request_to_out(db, req)
