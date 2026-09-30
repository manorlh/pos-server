"""
A "transmit now" request, as the dashboard follows it (docs/SHIFTS_API.md §4.4).

Created by `POST /machines/{id}/transmit`; same roles and till access as creating it.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
from app.models.user import User
from app.routers.machines import check_shift_admin_access
from app.services import transmit_requests

router = APIRouter(prefix="/transmit-requests", tags=["transmit-requests"])


def _request_or_404(db: Session, request_id: uuid.UUID, user: User, tenant_id):
    req = transmit_requests.get_request(db, request_id, tenant_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transmit request not found")
    check_shift_admin_access(db, req.machine, user, tenant_id)
    return req


@router.get("/{request_id}")
def get_transmit_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Progress. Also sweeps expiry."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    if transmit_requests.expire_overdue(db):
        db.commit()
        db.refresh(req)
    return transmit_requests.request_to_out(db, req)


@router.post("/{request_id}/cancel")
def cancel_transmit_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Stop offering it to the till. `409 request_not_pending` once it has ended."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    transmit_requests.cancel(db, req)
    db.commit()
    db.refresh(req)
    return transmit_requests.request_to_out(db, req)
