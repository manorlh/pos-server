"""
Prepaid vouchers ("שוברי הפקה") — see app/services/prepaid_vouchers.py for the rules.

Dashboard (user JWT, the catalog's writers, scoped by company / shop):

GET    /prepaid-vouchers/products                     → the products a batch of a company may carry
GET    /prepaid-vouchers/batches                      → batches with their counts
POST   /prepaid-vouchers/batches                      → make a batch and its vouchers
GET    /prepaid-vouchers/batches/{id}                 → one batch
PATCH  /prepaid-vouchers/batches/{id}                 → texts, logo, validity
POST   /prepaid-vouchers/batches/{id}/vouchers        → issue more vouchers (next serials)
POST   /prepaid-vouchers/batches/{id}/cancel          → cancel the batch and its open vouchers
GET    /prepaid-vouchers/batches/{id}/vouchers        → its vouchers (codes for printing)
GET    /prepaid-vouchers/batches/{id}/file            → PDF / ZIP (a PDF per voucher, or per group
                                                        with cover sheets) / CSV manifest
GET    /prepaid-vouchers/batches/{id}/groups          → per group: serials and how many redeemed
POST   /prepaid-vouchers/batches/{id}/groups          → split the vouchers with no group into groups
POST   /prepaid-vouchers/batches/{id}/groups/{n}/cancel → cancel a whole group (a lost envelope)
GET    /prepaid-vouchers/batches/{id}/events          → the batch's audit trail
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
    PrepaidVoucherCancelIn,
    PrepaidVoucherGroupsIn,
    PrepaidVoucherLookupIn,
    PrepaidVoucherNoteIn,
    PrepaidVoucherRedeemIn,
)
from app.services import prepaid_vouchers as PV
from app.services import prepaid_voucher_reports as PVR

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_MACHINE_TOKEN

router = APIRouter(tags=["prepaid-vouchers"])


# ── Dashboard ─────────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/products")
def list_prepaid_voucher_products(
    company_id: str = Query(..., alias="companyId"),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return {"items": PV.eligible_products(db, current_user, active_tenant_id, company_id, search, limit)}


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
    batch = PV.add_vouchers(db, current_user, active_tenant_id, batch_id, body.count, body.group_size)
    db.commit()
    return PV.batch_out(db, batch)


@router.post("/prepaid-vouchers/batches/{batch_id}/cancel")
def cancel_prepaid_voucher_batch(
    batch_id: str,
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.cancel_batch(db, current_user, active_tenant_id, batch_id, (body.reason if body else None))
    db.commit()
    return PV.batch_out(db, batch)


@router.get("/prepaid-vouchers/batches/{batch_id}/groups")
def prepaid_voucher_groups(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Per group: its serials, its vouchers and how many are unused / partly used / used / cancelled."""
    return PV.batch_groups(db, current_user, active_tenant_id, batch_id)


@router.post("/prepaid-vouchers/batches/{batch_id}/groups")
def assign_prepaid_voucher_groups(
    batch_id: str,
    body: PrepaidVoucherGroupsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Split the vouchers that have no group yet into groups of `groupSize` (409 when none is left)."""
    batch = PV.assign_groups(db, current_user, active_tenant_id, batch_id, body.group_size)
    db.commit()
    return PV.batch_out(db, batch)


@router.post("/prepaid-vouchers/batches/{batch_id}/groups/{group_no}/cancel")
def cancel_prepaid_voucher_group(
    batch_id: str,
    group_no: int,
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Cancel a whole group in one action (an envelope lost): its open vouchers are refused
    at every till from now on; used ones stay used. Logged with the reason.
    """
    out = PV.cancel_group(db, current_user, active_tenant_id, batch_id, group_no, (body.reason if body else None))
    db.commit()
    return out


@router.get("/prepaid-vouchers/batches/{batch_id}/events")
def prepaid_voucher_events(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The batch's audit trail, newest first: made, issued, grouped, cancelled — by whom and why."""
    return PV.batch_events(db, current_user, active_tenant_id, batch_id)


@router.get("/prepaid-vouchers/batches/{batch_id}/vouchers")
def list_prepaid_vouchers(
    batch_id: str,
    status_filter: Optional[str] = Query(None, alias="status"),
    serial: Optional[int] = Query(None, ge=1),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    group: Optional[int] = Query(None, ge=1),
    code: Optional[str] = Query(None, max_length=100, description="The code under the barcode, or 4+ characters of it"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PV.list_vouchers(
        db, current_user, active_tenant_id, batch_id,
        status_filter=status_filter, serial=serial, limit=limit, offset=offset,
        group_no=_given(group), code=_given(code),
    )


def _given(value):
    """A query parameter's value; None for the declaration itself (a direct call that left it out)."""
    from fastapi.params import Param

    return None if isinstance(value, Param) else value


@router.get("/prepaid-vouchers/batches/{batch_id}/file")
def prepaid_vouchers_file(
    batch_id: str,
    fmt: str = Query("pdf", alias="format", pattern="^(pdf|zip|groups|csv)$"),
    layout: str = Query("ticket80x50"),
    width: Optional[float] = Query(None, ge=30, le=300),
    height: Optional[float] = Query(None, ge=30, le=300),
    voucher_id: Optional[str] = Query(None, alias="voucherId"),
    include_used: bool = Query(True, alias="includeUsed"),
    group: Optional[int] = Query(None, ge=1),
    covers: bool = Query(True),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The vouchers as a file, drawn on the server (see app/services/prepaid_voucher_pdf.py):

    * `format=pdf` — one PDF, a page per voucher (or a sheet of several for `a4grid`);
      `group=n` narrows it to that group, opened by its cover sheet (`covers`).
    * `format=zip` — a ZIP with a PDF per voucher.
    * `format=groups` — production in groups: a ZIP with a PDF per group ("1000 in tens" is
      100 files of 10), each opened by its cover sheet, and the CSV manifest. 409
      `prepaid_voucher_not_grouped` for a batch with no groups.
    * `format=csv` — the manifest: every voucher of the batch (any status) with its code.

    `voucherId` narrows it to one voucher. Cancelled vouchers are never printed.
    """
    from fastapi import HTTPException

    from app.models.prepaid_voucher import PrepaidVoucher
    from app.services import prepaid_voucher_pdf as PDF
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    group = _given(group)
    covers = True if _given(covers) is None else covers
    batch = PV.get_batch(db, current_user, active_tenant_id, batch_id)
    pdf_name, zip_name = PDF.file_names(batch)
    base = pdf_name[:-4]

    if fmt == "csv":
        everything = (
            db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial).all()
        )
        return _attachment(PDF.manifest_csv(batch, everything), f"{base}_רשימת-קודים.csv", "text/csv; charset=utf-8", "csv")

    q = db.query(PrepaidVoucher).filter(
        PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.status != "cancelled"
    )
    if voucher_id:
        q = q.filter(PrepaidVoucher.id == PV._as_uuid(voucher_id))
    if not include_used:
        q = q.filter(PrepaidVoucher.status != "used")
    if group is not None:
        q = q.filter(PrepaidVoucher.group_no == group)
    vouchers = q.order_by(PrepaidVoucher.serial).all()
    groups_total = PV._last_group(db, batch.id)
    if fmt == "groups" and groups_total == 0:
        raise HTTPException(status_code=409, detail=PV.NOT_GROUPED)
    if not vouchers:
        raise HTTPException(status_code=404, detail="no_vouchers")

    zone = _load_zoneinfo(resolve_report_timezone(db, batch.tenant_id, None))
    opts = PDF.options_for(batch, zone)
    made = PDF._local_day(batch.created_at, zone)
    g = PDF.geometry(layout, width, height)
    logo = PDF.load_logo(batch.logo_url)
    issued = {r["group"]: (r["fromSerial"], r["toSerial"], r["total"]) for r in PV.groups_report(db, batch) if r["group"]}

    if fmt == "groups":
        everything = (
            db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial).all()
        )
        data, _ = PDF.render_groups_zip(
            batch, vouchers, g, groups_total=groups_total, group_ranges=issued, logo=logo, opts=opts,
            covers=covers, made=made, manifest=PDF.manifest_csv(batch, everything),
        )
        return _attachment(data, f"{base}_קבוצות.zip", "application/zip", "zip")
    if fmt == "zip":
        return _attachment(PDF.render_zip(batch, vouchers, g, logo=logo, opts=opts), zip_name, "application/zip", "zip")

    cover = None
    if group is not None and group in issued:
        low, high, total = issued[group]
        if covers:
            cover = PDF.GroupInfo(group=group, groups=groups_total, low=low, high=high, count=len(vouchers), issued=total)
        pdf_name = PDF.group_file_name(base, group, groups_total, low, high)
    elif voucher_id:
        pdf_name = f"{base}-{str(vouchers[0].serial).zfill(4)}.pdf"
    data = PDF.render_pdf(batch, vouchers, g, logo=logo, opts=opts, cover=cover, made=made)
    return _attachment(data, pdf_name, "application/pdf", "pdf")


def _attachment(data: bytes, name: str, media: str, ext: str):
    from fastapi.responses import Response
    from urllib.parse import quote

    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f"attachment; filename=\"vouchers.{ext}\"; filename*=UTF-8''{quote(name)}"},
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
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.cancel_voucher(db, current_user, active_tenant_id, voucher_id, (body.reason if body else None))
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


@router.post("/sync/{machine_id}/prepaid-vouchers/lookup", dependencies=FISCAL_MACHINE_TOKEN)
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


@router.post("/sync/{machine_id}/prepaid-vouchers/redeem", dependencies=FISCAL_MACHINE_TOKEN)
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


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/reverse", dependencies=FISCAL_MACHINE_TOKEN)
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


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/transaction", dependencies=FISCAL_MACHINE_TOKEN)
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
