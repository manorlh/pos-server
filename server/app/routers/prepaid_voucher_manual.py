"""
"מימוש ידני מהענן" — see app/services/prepaid_voucher_manual.py.

POST   /prepaid-vouchers/manual-redeem               → redeem one voucher (by kind: items / units / uses /
                                                       everything left); idempotent by `clientRequestId`
                                                       or `Idempotency-Key`
POST   /prepaid-vouchers/manual-redeem/bulk          → many vouchers (≤ 500), each fully, per voucher
                                                       redeemed / refused with the reason
POST   /prepaid-vouchers/manual-redeem/preview       → per voucher what is left and what would refuse it
                                                       (read only)
POST   /prepaid-vouchers/redemptions/{id}/reverse    → undo a manual redemption, with a reason

Every route needs the `prepaid_voucher_redeem` section ("מימוש ידני של שוברים") or edit on
`prepaid_vouchers` (app/services/dashboard_sections.py), and the batch's own scope.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.schemas.prepaid_voucher_manual import (
    ManualRedeemBulkIn,
    ManualRedeemIn,
    ManualRedeemPreviewIn,
    ManualReverseIn,
)
from app.services import prepaid_voucher_manual as PVM

router = APIRouter(tags=["prepaid-vouchers"])


@router.post("/prepaid-vouchers/manual-redeem")
def manual_redeem_prepaid_voucher(
    body: ManualRedeemIn,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    out = PVM.manual_redeem(db, current_user, active_tenant_id, body, idempotency_key)
    db.commit()
    return out


@router.post("/prepaid-vouchers/manual-redeem/bulk")
def manual_redeem_prepaid_vouchers_bulk(
    body: ManualRedeemBulkIn,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    out = PVM.manual_redeem_bulk(db, current_user, active_tenant_id, body, idempotency_key)
    db.commit()
    return out


@router.post("/prepaid-vouchers/manual-redeem/preview")
def manual_redeem_prepaid_vouchers_preview(
    body: ManualRedeemPreviewIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PVM.preview(db, current_user, active_tenant_id, body)


@router.post("/prepaid-vouchers/redemptions/{redemption_id}/reverse")
def reverse_manual_prepaid_redemption(
    redemption_id: str,
    body: ManualReverseIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    out = PVM.reverse(db, current_user, active_tenant_id, redemption_id, body.reason)
    db.commit()
    return out
