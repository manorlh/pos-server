"""
The dashboard asking tills in `zMode = till` for their own Z (docs/SHIFTS_API.md §5.4).

Same roles as producing a Z (`get_current_machine_admin`), narrowed to the shop and, per
till, as a remote shift close is (`check_shift_admin_access`: a distributor's own
terminals, a company manager's company tree, a shop manager's shop). One till's request
is `POST /machines/{id}/till-z` (app/routers/machines.py).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
from app.models.pos_machine import POSMachine
from app.models.till_z_request import TillZRequest
from app.models.user import User
from app.routers.machines import check_shift_admin_access
from app.routers.z_runs import _is_distributor, _shop_for
from app.schemas.till_z import ShopTillZIn, TillZRequestOut
from app.services import till_z
from app.services.scoping import scope_query_by_user

router = APIRouter(tags=["till-z"])

#: A list is the newest requests; the dashboard follows one by id after that.
LIST_LIMIT = 200
LIST_DAYS = 7


@router.post(
    "/shops/{shop_id}/till-z",
    response_model=List[TillZRequestOut],
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def request_shop_till_z(
    shop_id: uuid.UUID,
    body: Optional[ShopTillZIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "Z לכל הקופות" for the shop's `till`-mode tills: ask each for its own Z.

    `machineIds` omitted = every assigned, active `till`-mode till of the shop (a
    distributor: their own). A till with a request pending returns that one. A `cloud`
    till in the list is `422 {"detail": "machine_not_till_z", "machineId"}` — its Z is the
    shop's Z run (`POST /z-runs`) — and nothing is asked of any till.
    """
    shop = _shop_for(db, shop_id, current_user, active_tenant_id)
    wanted = body.machine_ids if body is not None else None
    if wanted is None:
        machines = till_z.shop_till_z_machines(db, shop)
        if _is_distributor(current_user):
            machines = [m for m in machines if str(m.distributor_id) == str(current_user.id)]
    else:
        ids = list(dict.fromkeys(wanted))
        found = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()} if ids else {}
        missing = [i for i in ids if i not in found]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=f"machine_not_in_shop:{missing[0]}"
            )
        machines = [found[i] for i in ids]
    for machine in machines:
        check_shift_admin_access(db, machine, current_user, active_tenant_id)
    try:
        requests = till_z.request_for_shop(db, current_user, shop, machines)
    except till_z.TillZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    db.commit()
    for req in requests:
        db.refresh(req)
    return [till_z.request_to_out(db, req) for req in requests]


def _request_or_404(db: Session, request_id: uuid.UUID, user: User, tenant_id) -> TillZRequest:
    req = till_z.get_request(db, request_id, tenant_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Till Z request not found")
    check_shift_admin_access(db, req.machine, user, tenant_id)
    return req


@router.get(
    "/till-z-requests",
    response_model=List[TillZRequestOut],
    response_model_by_alias=True,
)
def list_till_z_requests(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    status_: Optional[str] = Query(
        None,
        alias="status",
        pattern="^(waiting|in_progress|completed|failed|expired|cancelled)$",
    ),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Requests in the caller's reach, newest first: at most 200, and without a `status`
    filter only the last 7 days (a pending one is never older than 36 h). Sweeps expiry.
    """
    if till_z.expire_overdue(db):
        db.commit()
    query = db.query(TillZRequest).filter(TillZRequest.tenant_id == active_tenant_id)
    if not isinstance(status_, str):
        query = query.filter(
            TillZRequest.created_at >= datetime.now(timezone.utc) - timedelta(days=LIST_DAYS)
        )
    query = scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=TillZRequest.shop_id,
        machine_column=TillZRequest.machine_id,
    )
    if query is None:
        return []
    # (`isinstance`: a direct call leaves the Query defaults in place.)
    if isinstance(shop_id, uuid.UUID):
        query = query.filter(TillZRequest.shop_id == shop_id)
    if isinstance(machine_id, uuid.UUID):
        query = query.filter(TillZRequest.machine_id == machine_id)
    if isinstance(status_, str):
        query = query.filter(TillZRequest.status == status_)
    rows = query.order_by(TillZRequest.created_at.desc()).limit(LIST_LIMIT).all()
    return [till_z.request_to_out(db, req) for req in rows]


@router.get(
    "/till-z-requests/{request_id}",
    response_model=TillZRequestOut,
    response_model_by_alias=True,
)
def get_till_z_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Progress. Also sweeps expiry."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    if till_z.expire_overdue(db):
        db.commit()
        db.refresh(req)
    return till_z.request_to_out(db, req)


@router.post(
    "/till-z-requests/{request_id}/cancel",
    response_model=TillZRequestOut,
    response_model_by_alias=True,
)
def cancel_till_z_request(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Stop offering it to the till. `409 request_not_pending` once it has ended."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    till_z.expire_overdue(db)
    till_z.cancel(db, req)
    db.commit()
    db.refresh(req)
    return till_z.request_to_out(db, req)
