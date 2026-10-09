"""
"זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the dashboard asks a till to issue a credit for
a document; the till issues it in its own series and reports back.

Dashboard (Clerk user; owner / manager roles — `get_current_machine_admin` — and only for a
document the user sees and a till they may act on):

    GET  /remote-credits/prepare?transactionId=   what can be credited, the eligible tills
    POST /remote-credits                          the request (idempotent by `id`)
    GET  /remote-credits?transactionId=|machineId= the requests, newest first
    GET  /remote-credits/{id}                     one request, with its audit trail
    POST /remote-credits/{id}/cancel              while the till has not executed it

Till (machine JWT, fiscal devices only):

    GET  /sync/{machine_id}/remote-credits                 its pending requests, whole
    POST /sync/{machine_id}/remote-credits/{id}/ack        received | deferred | waiting |
                                                           completed | failed

The logic lives in `app.services.remote_credits`.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_MACHINE_TOKEN,
    get_active_tenant_id,
    get_current_machine_admin,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.remote_credit import PENDING_REMOTE_CREDIT_STATUSES, RemoteCreditRequest
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.remote_credit import RemoteCreditAckIn, RemoteCreditCancelIn, RemoteCreditCreateIn
from app.services import remote_credits as svc
from app.services.scoping import scope_query_by_user, scope_transactions_by_user

router = APIRouter(prefix="/remote-credits", tags=["remote-credits"])
till_router = APIRouter(prefix="/sync", tags=["remote-credits"])


# ── Access ────────────────────────────────────────────────────────────────────


def _original_or_404(db: Session, transaction_id, user: User, tenant_id) -> Transaction:
    query = scope_transactions_by_user(
        db.query(Transaction).filter(Transaction.id == transaction_id, Transaction.tenant_id == tenant_id),
        user,
        db,
    )
    tx = query.first() if query is not None else None
    if tx is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    return tx


def _may_use(db: Session, user: User, tenant_id):
    """A till this user may act on from the cloud (the remote close's rule)."""
    from app.routers.machines import check_shift_admin_access

    def check(machine: POSMachine) -> bool:
        try:
            check_shift_admin_access(db, machine, user, tenant_id)
        except HTTPException:
            return False
        return True

    return check


def _request_or_404(db: Session, request_id, user: User, tenant_id) -> RemoteCreditRequest:
    req = svc.get_request(db, request_id, tenant_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Remote credit request not found")
    # Seen through its original (the document scope) or its till.
    original_seen = scope_transactions_by_user(
        db.query(Transaction.id).filter(
            Transaction.id == req.original_transaction_id, Transaction.tenant_id == tenant_id
        ),
        user,
        db,
    )
    machine = db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    if (original_seen is None or original_seen.first() is None) and (
        machine is None or not _may_use(db, user, tenant_id)(machine)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Remote credit request not found")
    return req


# ── Dashboard ────────────────────────────────────────────────────────────────


@router.get("/prepare")
def prepare_remote_credit(
    transaction_id: uuid.UUID = Query(..., alias="transactionId"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The lines still creditable (earlier credits and pending requests taken off), the money, the original's tenders, and the tills that may issue it."""
    original = _original_or_404(db, transaction_id, current_user, active_tenant_id)
    if svc.expire_overdue(db):
        db.commit()
    targets = svc.eligible_targets(db, original, _may_use(db, current_user, active_tenant_id))
    return svc.prepare_out(db, original, targets)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_remote_credit(
    body: RemoteCreditCreateIn,
    response: Response,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Ask a till to issue a credit. 201 created; 200 the same request again (same `id`, same
    content). 409 `{code, message}`: over_credit, nothing_to_credit, target_no_open_shift,
    target_other_business, target_not_a_till, not_a_sale, already_refunded,
    remote_credit_id_conflict… 422: reason_required, unknown_line.
    """
    original = _original_or_404(db, body.transaction_id, current_user, active_tenant_id)
    machine = db.query(POSMachine).filter(POSMachine.id == body.machine_id).first()
    if machine is None or machine.tenant_id != active_tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    from app.routers.machines import check_shift_admin_access

    check_shift_admin_access(db, machine, current_user, active_tenant_id)
    req, created = svc.create(
        db,
        current_user,
        original,
        machine,
        svc.NewRequest(
            original_id=original.id,
            machine_id=machine.id,
            mode=body.mode,
            full=body.full,
            lines=[(l.item_id, l.quantity) for l in body.lines],
            reason=body.reason,
            reason_code=body.reason_code,
            request_id=body.id,
        ),
    )
    db.commit()
    db.refresh(req)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return svc.request_to_out(db, req, events=True)


@router.get("")
def list_remote_credits(
    transaction_id: Optional[uuid.UUID] = Query(None, alias="transactionId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    pending_only: bool = Query(False, alias="pendingOnly"),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The requests, newest first: of one document, of one till, or every one the user sees."""
    if svc.expire_overdue(db):
        db.commit()
    query = db.query(RemoteCreditRequest).filter(RemoteCreditRequest.tenant_id == active_tenant_id)
    if transaction_id is not None:
        _original_or_404(db, transaction_id, current_user, active_tenant_id)
        query = query.filter(RemoteCreditRequest.original_transaction_id == transaction_id)
    else:
        query = scope_query_by_user(
            query,
            current_user,
            db,
            shop_column=RemoteCreditRequest.shop_id,
            machine_column=RemoteCreditRequest.machine_id,
        )
        if query is None:
            return {"items": []}
    if machine_id is not None:
        query = query.filter(RemoteCreditRequest.machine_id == machine_id)
    if pending_only:
        query = query.filter(RemoteCreditRequest.status.in_(PENDING_REMOTE_CREDIT_STATUSES))
    rows = query.order_by(RemoteCreditRequest.created_at.desc(), RemoteCreditRequest.id.desc()).limit(limit).all()
    return {"items": [svc.request_to_out(db, r) for r in rows]}


@router.get("/{request_id}")
def get_remote_credit(
    request_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Progress and the audit trail. Also sweeps expiry."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    if svc.expire_overdue(db):
        db.commit()
        db.refresh(req)
    return svc.request_to_out(db, req, events=True)


@router.post("/{request_id}/cancel")
def cancel_remote_credit(
    request_id: uuid.UUID,
    body: Optional[RemoteCreditCancelIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Stop it while the till has not issued it. 409 `request_not_pending` once it has ended."""
    req = _request_or_404(db, request_id, current_user, active_tenant_id)
    svc.cancel(db, req, current_user, reason=body.reason if body is not None else None)
    db.commit()
    db.refresh(req)
    return svc.request_to_out(db, req, events=True)


# ── Till ─────────────────────────────────────────────────────────────────────


@till_router.get("/{machine_id}/remote-credits", dependencies=FISCAL_MACHINE_TOKEN)
def till_remote_credits(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Every pending request of this till, with the original document it credits."""
    out = svc.for_till(db, machine)
    db.commit()
    return out


@till_router.post("/{machine_id}/remote-credits/{request_id}/ack", dependencies=FISCAL_MACHINE_TOKEN)
def till_remote_credit_ack(
    machine_id: str,
    request_id: uuid.UUID,
    body: RemoteCreditAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The till's answer. Idempotent: an ended request accepts it and changes nothing — except
    `completed`, which always records the credit the till issued (a fiscal document exists).
    """
    req = svc.apply_ack(
        db,
        machine,
        request_id,
        phase=body.phase,
        credit_transaction_id=body.credit_transaction_id,
        credit_document_number=body.credit_document_number,
        credit_document_type=body.credit_document_type,
        credit_amount=body.credit_amount,
        error_code=body.error_code,
        error_message=body.error_message,
    )
    db.commit()
    return {"ok": True, "requestStatus": req.status, "cancelled": req.status == "cancelled"}
