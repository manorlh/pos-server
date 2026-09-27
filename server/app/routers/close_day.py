"""Removed: the dashboard's close-day. A Z is produced with a Z run (`app/routers/z_runs.py`)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.middleware.auth import get_current_machine_admin
from app.models.user import User

router = APIRouter(tags=["close-day"])


@router.post("/machines/close-day", status_code=status.HTTP_410_GONE)
def post_close_day(current_user: User = Depends(get_current_machine_admin)):
    """Removed: `POST /z-runs`."""
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="upgrade_required")


@router.get("/close-day-requests/{request_id}", status_code=status.HTTP_410_GONE)
def get_close_day_request_detail(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
):
    """Removed: `GET /z-runs/{id}`."""
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="upgrade_required")
