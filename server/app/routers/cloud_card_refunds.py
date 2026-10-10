"""
"זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds a card sale
charged through Z-Credit, and a till issues the credit note (remote-credit mode `card_refunded`).

Dashboard only (Clerk user; the roles of a remote credit — `get_current_machine_admin` — for a
document the user sees, and a till they may act on):

    GET  /cloud-card-refunds/prepare?transactionId=   the legs, what is left, the tills
    POST /cloud-card-refunds                          refund (idempotent by `id`)
    GET  /cloud-card-refunds?transactionId=|attention= the refunds, newest first
    GET  /cloud-card-refunds/{id}                     one refund, with its audit trail
    POST /cloud-card-refunds/{id}/check               an unknown outcome: ask Z-Credit again
    POST /cloud-card-refunds/{id}/resolve             an unknown outcome: what the operator found
    POST /cloud-card-refunds/{id}/resend              the credit note to (another) till

The logic lives in `app.services.cloud_card_refunds`; the till's side is the remote credit's.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
from app.models.cloud_card_refund import CloudCardRefund
from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.models.user import User
from app.routers.remote_credits import _may_use, _original_or_404
from app.schemas.cloud_card_refund import (
    CloudCardRefundCreateIn,
    CloudCardRefundReleaseIn,
    CloudCardRefundResendIn,
    CloudCardRefundResolveIn,
)
from app.services import cloud_card_refunds as svc
from app.services import remote_credits as rc
from app.services.scoping import scope_query_by_user, scope_transactions_by_user

router = APIRouter(prefix="/cloud-card-refunds", tags=["cloud-card-refunds"])


def _target_or_404(db: Session, machine_id, user: User, tenant_id) -> POSMachine:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None or machine.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    from app.routers.machines import check_shift_admin_access

    check_shift_admin_access(db, machine, user, tenant_id)
    return machine


def _refund_or_404(db: Session, refund_id, user: User, tenant_id) -> CloudCardRefund:
    row = (
        db.query(CloudCardRefund)
        .filter(CloudCardRefund.id == refund_id, CloudCardRefund.tenant_id == tenant_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card refund not found")
    seen = scope_transactions_by_user(
        db.query(Transaction.id).filter(
            Transaction.id == row.original_transaction_id, Transaction.tenant_id == tenant_id
        ),
        user,
        db,
    )
    if seen is None or seen.first() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card refund not found")
    return row


@router.get("/prepare")
def prepare_cloud_card_refund(
    transaction_id: uuid.UUID = Query(..., alias="transactionId"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The document's legs (which are Z-Credit, what is left on each), the lines, the tills."""
    original = _original_or_404(db, transaction_id, current_user, active_tenant_id)
    if rc.expire_overdue(db):
        db.commit()
    return svc.prepare_out(db, original, _may_use(db, current_user, active_tenant_id))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_cloud_card_refund(
    body: CloudCardRefundCreateIn,
    response: Response,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Refund the card through Z-Credit, then ask the till for the credit note. 201: the refund
    was made now — its `status` says how it went (`refunded`, `declined`, `unknown`); 200: the
    same `id` again (nothing is sent twice). 409 `{code, message}` before anything is sent:
    cloud_refunds_disabled, not_zcredit, no_gateway_reference, over_card_leg, over_credit,
    target_no_open_shift, zcredit_password_missing, card_refund_id_conflict… 422 reason_required.
    """
    original = _original_or_404(db, body.transaction_id, current_user, active_tenant_id)
    target = _target_or_404(db, body.machine_id, current_user, active_tenant_id)
    row, created = svc.create(
        db,
        current_user,
        original,
        target,
        svc.NewCardRefund(
            refund_id=body.id,
            original_id=original.id,
            payment_id=body.payment_id,
            machine_id=target.id,
            full=body.full,
            lines=[(l.item_id, l.quantity) for l in body.lines],
            reason=body.reason,
            reason_code=body.reason_code,
        ),
    )
    db.commit()
    db.refresh(row)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return svc.refund_to_out(db, row, events=True)


@router.get("")
def list_cloud_card_refunds(
    transaction_id: Optional[uuid.UUID] = Query(None, alias="transactionId"),
    attention: bool = Query(False, description="Only those that still need a person."),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The refunds, newest first: of one document, or every one the user sees."""
    if rc.expire_overdue(db):
        db.commit()
    query = db.query(CloudCardRefund).filter(CloudCardRefund.tenant_id == active_tenant_id)
    if transaction_id is not None:
        _original_or_404(db, transaction_id, current_user, active_tenant_id)
        query = query.filter(CloudCardRefund.original_transaction_id == transaction_id)
    else:
        query = scope_query_by_user(
            query, current_user, db,
            shop_column=CloudCardRefund.shop_id, machine_column=CloudCardRefund.original_machine_id,
        )
        if query is None:
            return {"items": []}
    rows = query.order_by(CloudCardRefund.created_at.desc(), CloudCardRefund.id.desc()).limit(limit).all()
    if attention:
        rows = svc.needs_attention(db, rows)
    return {"items": [svc.refund_to_out(db, r) for r in rows]}


@router.get("/{refund_id}")
def get_cloud_card_refund(
    refund_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The refund, its credit note's progress, and the audit trail. Never calls Z-Credit."""
    row = _refund_or_404(db, refund_id, current_user, active_tenant_id)
    if rc.expire_overdue(db):
        db.commit()
        db.refresh(row)
    return svc.refund_to_out(db, row, events=True)


@router.post("/{refund_id}/check")
def check_cloud_card_refund(
    refund_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"בדוק שוב": one status query for a refund whose outcome is unknown. Never refunds again."""
    row = _refund_or_404(db, refund_id, current_user, active_tenant_id)
    svc.check(db, row, current_user)
    db.commit()
    db.refresh(row)
    return svc.refund_to_out(db, row, events=True)


@router.post("/{refund_id}/resolve")
def resolve_cloud_card_refund(
    refund_id: uuid.UUID,
    body: CloudCardRefundResolveIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """An unknown outcome, as the operator found it in Z-Credit's report (audited, note required)."""
    row = _refund_or_404(db, refund_id, current_user, active_tenant_id)
    svc.resolve_manually(db, row, current_user, outcome=body.outcome, note=body.note)
    db.commit()
    db.refresh(row)
    return svc.refund_to_out(db, row, events=True)


@router.post("/{refund_id}/resend")
def resend_cloud_card_refund(
    refund_id: uuid.UUID,
    body: CloudCardRefundResendIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The credit note of a refunded card to (another) till: refused, expired, or moved (`force`)."""
    row = _refund_or_404(db, refund_id, current_user, active_tenant_id)
    target = _target_or_404(db, body.machine_id, current_user, active_tenant_id)
    svc.resend(db, row, current_user, target, force=body.force)
    db.commit()
    db.refresh(row)
    return svc.refund_to_out(db, row, events=True)


@router.post("/{refund_id}/release-z")
def release_cloud_card_refund_from_z(
    refund_id: uuid.UUID,
    body: CloudCardRefundReleaseIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Support's force past "זיכוי באשראי מהענן — חובה לפני ה-Z הבא" (app/services/cloud_refund_z_gate.py):
    a super admin, a typed reason — the next Z of the note's till goes ahead without it (recorded on
    the refund and as an exception), and the note goes into the Z after. 403 for anyone else, 422
    without a reason. A cloud Z run that waited only for it is built now.
    """
    from app.services import cloud_refund_z_gate as G

    row = _refund_or_404(db, refund_id, current_user, active_tenant_id)
    svc.release_z(db, row, current_user, body.reason)
    db.flush()
    G.retry_runs_of(db, [row.target_machine_id])
    db.commit()
    db.refresh(row)
    return svc.refund_to_out(db, row, events=True)
