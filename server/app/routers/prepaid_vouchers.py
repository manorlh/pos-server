"""
Prepaid vouchers ("שוברי הפקה") — see app/services/prepaid_vouchers.py for the rules.

Dashboard (user JWT, the catalog's writers, scoped by company / shop):

GET    /prepaid-vouchers/batches                      → batches with their counts
POST   /prepaid-vouchers/batches                      → make a batch and its vouchers
GET    /prepaid-vouchers/batches/{id}                 → one batch
PATCH  /prepaid-vouchers/batches/{id}                 → texts, logo, validity
POST   /prepaid-vouchers/batches/{id}/vouchers        → issue more vouchers (next serials)
POST   /prepaid-vouchers/batches/{id}/cancel          → cancel the batch and its open vouchers
GET    /prepaid-vouchers/batches/{id}/vouchers        → its vouchers (codes for printing)
GET    /prepaid-vouchers/batches/{id}/report          → counts, goods taken, redemptions by
                                                        hour / day / shop / till / employee
GET    /prepaid-vouchers/vouchers/{id}                → one voucher with its redemptions
POST   /prepaid-vouchers/vouchers/{id}/cancel         → cancel one voucher
PUT    /prepaid-vouchers/vouchers/{id}/note           → its free-text note (blank clears)

Till (machine JWT only, online):

POST   /sync/{machine_id}/prepaid-vouchers/lookup     → the voucher as this till sees it
POST   /sync/{machine_id}/prepaid-vouchers/redeem     → take goods off it; atomic, idempotent
                                                        by `clientRequestId`
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.prepaid_voucher import (
    PrepaidVoucherAddIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherLookupIn,
    PrepaidVoucherNoteIn,
    PrepaidVoucherRedeemIn,
)
from app.services import prepaid_vouchers as PV
from app.services import prepaid_voucher_reports as PVR

router = APIRouter(tags=["prepaid-vouchers"])


# ── Dashboard ─────────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/batches")
def list_prepaid_voucher_batches(
    include_cancelled: bool = Query(True, alias="includeCancelled"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return {"items": PV.list_batches(db, current_user, active_tenant_id, include_cancelled=include_cancelled)}


@router.post("/prepaid-vouchers/batches", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_batch(
    body: PrepaidVoucherBatchCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.create_batch(db, current_user, active_tenant_id, body)
    db.commit()
    return PV.batch_out(db, batch)


@router.get("/prepaid-vouchers/batches/{batch_id}")
def get_prepaid_voucher_batch(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PV.batch_out(db, PV.get_batch(db, current_user, active_tenant_id, batch_id))


@router.patch("/prepaid-vouchers/batches/{batch_id}")
def update_prepaid_voucher_batch(
    batch_id: str,
    body: PrepaidVoucherBatchUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.update_batch(db, current_user, active_tenant_id, batch_id, body)
    db.commit()
    return PV.batch_out(db, batch)


@router.post("/prepaid-vouchers/batches/{batch_id}/vouchers", status_code=status.HTTP_201_CREATED)
def add_prepaid_vouchers(
    batch_id: str,
    body: PrepaidVoucherAddIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.add_vouchers(db, current_user, active_tenant_id, batch_id, body.count)
    db.commit()
    return PV.batch_out(db, batch)


@router.post("/prepaid-vouchers/batches/{batch_id}/cancel")
def cancel_prepaid_voucher_batch(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.cancel_batch(db, current_user, active_tenant_id, batch_id)
    db.commit()
    return PV.batch_out(db, batch)


@router.get("/prepaid-vouchers/batches/{batch_id}/vouchers")
def list_prepaid_vouchers(
    batch_id: str,
    status_filter: Optional[str] = Query(None, alias="status"),
    serial: Optional[int] = Query(None, ge=1),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PV.list_vouchers(
        db, current_user, active_tenant_id, batch_id,
        status_filter=status_filter, serial=serial, limit=limit, offset=offset,
    )


@router.get("/prepaid-vouchers/batches/{batch_id}/file")
def prepaid_vouchers_file(
    batch_id: str,
    fmt: str = Query("pdf", alias="format", pattern="^(pdf|zip)$"),
    layout: str = Query("ticket80x50"),
    width: Optional[float] = Query(None, ge=30, le=300),
    height: Optional[float] = Query(None, ge=30, le=300),
    voucher_id: Optional[str] = Query(None, alias="voucherId"),
    include_used: bool = Query(True, alias="includeUsed"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The vouchers as a file, drawn on the server (see app/services/prepaid_voucher_pdf.py):
    `format=pdf` — one PDF, a page per voucher (or a sheet of several for `a4grid`);
    `format=zip` — a ZIP with a PDF per voucher. `voucherId` narrows it to one voucher.
    Cancelled vouchers are never included.
    """
    from fastapi import HTTPException
    from fastapi.responses import Response
    from urllib.parse import quote

    from app.models.prepaid_voucher import PrepaidVoucher
    from app.services import prepaid_voucher_pdf as PDF

    batch = PV.get_batch(db, current_user, active_tenant_id, batch_id)
    q = db.query(PrepaidVoucher).filter(
        PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.status != "cancelled"
    )
    if voucher_id:
        q = q.filter(PrepaidVoucher.id == PV._as_uuid(voucher_id))
    if not include_used:
        q = q.filter(PrepaidVoucher.status != "used")
    vouchers = q.order_by(PrepaidVoucher.serial).all()
    if not vouchers:
        raise HTTPException(status_code=404, detail="no_vouchers")
    g = PDF.geometry(layout, width, height)
    logo = PDF.load_logo(batch.logo_url)
    pdf_name, zip_name = PDF.file_names(batch)
    if voucher_id:
        pdf_name = pdf_name[:-4] + f"-{str(vouchers[0].serial).zfill(4)}.pdf"
    if fmt == "zip":
        data, name, media = PDF.render_zip(batch, vouchers, g, logo=logo), zip_name, "application/zip"
    else:
        data, name, media = PDF.render_pdf(batch, vouchers, g, logo=logo), pdf_name, "application/pdf"
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f"attachment; filename=\"vouchers.{fmt}\"; filename*=UTF-8''{quote(name)}"},
    )


@router.get("/prepaid-vouchers/vouchers/{voucher_id}")
def get_prepaid_voucher(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.get_voucher(db, current_user, active_tenant_id, voucher_id)
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.post("/prepaid-vouchers/vouchers/{voucher_id}/cancel")
def cancel_prepaid_voucher(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.cancel_voucher(db, current_user, active_tenant_id, voucher_id)
    db.commit()
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.put("/prepaid-vouchers/vouchers/{voucher_id}/note")
def set_prepaid_voucher_note(
    voucher_id: str,
    body: PrepaidVoucherNoteIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.set_voucher_note(db, current_user, active_tenant_id, voucher_id, body.note)
    db.commit()
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.get("/prepaid-vouchers/batches/{batch_id}/report")
def prepaid_voucher_batch_report(
    batch_id: str,
    tz: Optional[str] = Query(None, description="IANA zone for hours and days; default the tenant's"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One batch over its life; reversed redemptions are left out everywhere."""
    return PVR.batch_report(db, current_user, active_tenant_id, batch_id, tz)


# ── Till ──────────────────────────────────────────────────────────────────────


@router.post("/sync/{machine_id}/prepaid-vouchers/lookup")
def lookup_prepaid_voucher(
    machine_id: str,
    body: PrepaidVoucherLookupIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The voucher as this till sees it: its goods with what is left, the till's own
    product ids, and whether it can be redeemed here now (`redeemable`, else `reason`).
    404 `prepaid_voucher_not_found` for an unknown code or another tenant's.
    """
    return PV.lookup(db, machine, body.code)


@router.post("/sync/{machine_id}/prepaid-vouchers/redeem")
def redeem_prepaid_voucher(
    machine_id: str,
    body: PrepaidVoucherRedeemIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Take goods off a voucher, atomically. The same `clientRequestId` from this till
    returns the first answer (`replayed: true`). 409 with the reason when refused
    (used, cancelled, expired, not yet valid, wrong shop, partial not allowed,
    more than is left); 404 for an unknown code.
    """
    out = PV.redeem(db, machine, body)
    db.commit()
    return out


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/reverse")
def reverse_prepaid_redemption(
    machine_id: str,
    redemption_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Undo a redemption this till took: the payment it was part of was abandoned, so the
    goods go back on the voucher. Idempotent. 404 for a redemption that is not this till's.
    """
    out = PV.reverse_redemption(db, machine, redemption_id)
    db.commit()
    return out


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/transaction")
def attach_prepaid_redemption_transaction(
    machine_id: str,
    redemption_id: str,
    body: dict,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Name the sale document a redemption paid towards: `{"transactionId": "…"}`."""
    from fastapi import HTTPException

    tx = str((body or {}).get("transactionId") or "").strip()
    if not tx:
        raise HTTPException(status_code=422, detail="transactionId required")
    PV.attach_transaction(db, machine, redemption_id, tx)
    db.commit()
    return {"ok": True}
