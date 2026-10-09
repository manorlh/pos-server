"""
Production vouchers ("שוברי הפקה") after redemption — settlement, deliveries, replacement vouchers,
the §15 reports, the §18 controls and the simulator. Dashboard only (user JWT); every path is under
`/prepaid-vouchers/` (the `prepaid_vouchers` section at the door, the finer sections inside — see
app/services/prepaid_voucher_extras_access.py). The contract: P:\\specs\\production-vouchers-api.md,
section "Helper: settlement, reports and §18".

Settlement (§14):
GET    /prepaid-vouchers/settlement/agreements                  → agreements with their totals
POST   /prepaid-vouchers/settlement/agreements                  → a new agreement
GET    /prepaid-vouchers/settlement/agreements/{id}             → the settlement: batches, types, invoices, gap, corrections
PATCH  /prepaid-vouchers/settlement/agreements/{id}             → terms, status, notes, the gap's explanation
GET    /prepaid-vouchers/settlement/candidates                  → the batches an agreement would cover
POST   /prepaid-vouchers/settlement/agreements/{id}/invoices    → link an external invoice (quantities per batch)
PATCH  /prepaid-vouchers/settlement/invoices/{id}               → its notes / the gap's explanation
POST   /prepaid-vouchers/settlement/invoices/{id}/void          → void it (with a reason)
PUT    /prepaid-vouchers/settlement/invoices/{id}/file          → attach its file (PDF / image)
GET    /prepaid-vouchers/settlement/invoices/{id}/file          → the file

Deliveries ("מסירה להפקה"):
GET    /prepaid-vouchers/batches/{id}/deliveries                → the batch's deliveries and what is not delivered
POST   /prepaid-vouchers/batches/{id}/deliveries                → record one (a serial range)
POST   /prepaid-vouchers/deliveries/{id}/void                   → void one (with a reason)

Replacement (§16):
POST   /prepaid-vouchers/vouchers/{id}/replace                  → a replacement linked to the original
GET    /prepaid-vouchers/vouchers/{id}/replacements             → the voucher's chain
GET    /prepaid-vouchers/replacements                           → replacements under the filters

Reports (§15), on the vouchers' filter model:
GET    /prepaid-vouchers/reports/settlement | exceptions | overrides | catalog

Controls (§18):
GET/POST /prepaid-vouchers/controls/pauses, POST …/pauses/{id}/resume
GET/POST /prepaid-vouchers/controls/quotas, PATCH …/quotas/{id}
GET/POST /prepaid-vouchers/controls/test-batches, POST/DELETE …/test-batches/{batchId}
GET    /prepaid-vouchers/controls/batches/{id}                  → a batch's test flag, pause and quotas
GET    /prepaid-vouchers/controls/events                        → the audit trail
POST   /prepaid-vouchers/simulate                               → the simulator (read-only)
"""
from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.routers.prepaid_vouchers import _given, _scope, voucher_scope
from app.schemas.prepaid_voucher_extras import (
    DeliveryIn,
    PauseIn,
    QuotaIn,
    QuotaUpdate,
    ReasonIn,
    ReplacementIn,
    ResumeIn,
    SettlementAgreementIn,
    SettlementAgreementUpdate,
    SettlementInvoiceIn,
    SettlementInvoiceUpdate,
    SimulateIn,
    StaffTestBatchIn,
    StaffTestMarkIn,
)
from app.services import prepaid_voucher_analytics as PVA
from app.services import prepaid_voucher_controls as CTL
from app.services import prepaid_voucher_extra_reports as REP
from app.services import prepaid_voucher_replacement as RPL
from app.services import prepaid_voucher_settlement as ST
from app.services import prepaid_voucher_simulator as SIM

router = APIRouter(tags=["prepaid-vouchers"])


# ── Settlement (§14) ──────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/settlement/agreements")
def list_settlement_agreements(
    company_id: Optional[str] = Query(None, alias="companyId"),
    status_filter: Optional[str] = Query(None, alias="status", description="active | closed"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The agreements with each one's totals (chargeable, amount, invoiced, balance)."""
    return ST.list_agreements(db, current_user, active_tenant_id, company_id=_given(company_id),
                              status_filter=_given(status_filter))


@router.post("/prepaid-vouchers/settlement/agreements", status_code=status.HTTP_201_CREATED)
def create_settlement_agreement(
    body: SettlementAgreementIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    a = ST.create_agreement(db, current_user, active_tenant_id, body)
    db.commit()
    return ST.agreement_out(db, current_user, a)


@router.get("/prepaid-vouchers/settlement/candidates")
def settlement_candidates(
    company_id: str = Query(..., alias="companyId"),
    production_name: Optional[str] = Query(None, alias="productionName"),
    production_id: Optional[str] = Query(None, alias="productionId"),
    event_name: Optional[str] = Query(None, alias="eventName"),
    report_event_id: Optional[str] = Query(None, alias="reportEventId"),
    batch_ids: Optional[List[str]] = Query(None, alias="batchId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The batches an agreement with these terms would cover (test batches never)."""
    return ST.candidates(db, current_user, active_tenant_id, company_id=company_id,
                         production_name=_given(production_name), production_id=_given(production_id),
                         event_name=_given(event_name),
                         report_event_id=_given(report_event_id), batch_ids=_given(batch_ids))


@router.get("/prepaid-vouchers/settlement/agreements/{agreement_id}")
def get_settlement_agreement(
    agreement_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    ST._require(db, current_user, "view")
    return ST.agreement_out(db, current_user, ST.get_agreement(db, current_user, active_tenant_id, agreement_id))


@router.patch("/prepaid-vouchers/settlement/agreements/{agreement_id}")
def update_settlement_agreement(
    agreement_id: str,
    body: SettlementAgreementUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    a = ST.update_agreement(db, current_user, active_tenant_id, agreement_id, body)
    db.commit()
    return ST.agreement_out(db, current_user, a)


@router.post("/prepaid-vouchers/settlement/agreements/{agreement_id}/invoices", status_code=status.HTTP_201_CREATED)
def add_settlement_invoice(
    agreement_id: str,
    body: SettlementInvoiceIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """409 `prepaid_settlement_over_invoiced:<batchId>:<left>` — never the same vouchers on two invoices."""
    ST.add_invoice(db, current_user, active_tenant_id, agreement_id, body)
    db.commit()
    return ST.agreement_out(db, current_user, ST.get_agreement(db, current_user, active_tenant_id, agreement_id))


@router.patch("/prepaid-vouchers/settlement/invoices/{invoice_id}")
def update_settlement_invoice(
    invoice_id: str,
    body: SettlementInvoiceUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    inv = ST.update_invoice(db, current_user, active_tenant_id, invoice_id, body)
    db.commit()
    return ST.agreement_out(db, current_user, ST.get_agreement(db, current_user, active_tenant_id, inv.agreement_id))


@router.post("/prepaid-vouchers/settlement/invoices/{invoice_id}/void")
def void_settlement_invoice(
    invoice_id: str,
    body: ReasonIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    inv = ST.void_invoice(db, current_user, active_tenant_id, invoice_id, body.reason)
    db.commit()
    return ST.agreement_out(db, current_user, ST.get_agreement(db, current_user, active_tenant_id, inv.agreement_id))


@router.put("/prepaid-vouchers/settlement/invoices/{invoice_id}/file")
async def put_settlement_invoice_file(
    invoice_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    data = await file.read(ST.FILE_MAX + 1)
    inv = ST.put_invoice_file(db, current_user, active_tenant_id, invoice_id, file.filename or "invoice",
                              file.content_type or "", data)
    db.commit()
    return {"ok": True, "file": {"name": inv.file_name, "type": inv.file_type, "size": inv.file_size}}


@router.get("/prepaid-vouchers/settlement/invoices/{invoice_id}/file")
def get_settlement_invoice_file(
    invoice_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    inv, data = ST.invoice_file(db, current_user, active_tenant_id, invoice_id)
    name = inv.file_name or "invoice"
    return Response(content=data, media_type=inv.file_type or "application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename=\"invoice\"; filename*=UTF-8''{quote(name)}"})


# ── Deliveries ────────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/batches/{batch_id}/deliveries")
def list_prepaid_voucher_deliveries(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return ST.list_deliveries(db, current_user, active_tenant_id, batch_id)


@router.post("/prepaid-vouchers/batches/{batch_id}/deliveries", status_code=status.HTTP_201_CREATED)
def add_prepaid_voucher_delivery(
    batch_id: str,
    body: DeliveryIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """409 `prepaid_voucher_delivery_overlap:<from>-<to>` — a voucher is handed over once."""
    ST.add_delivery(db, current_user, active_tenant_id, batch_id, body)
    db.commit()
    return ST.list_deliveries(db, current_user, active_tenant_id, batch_id)


@router.post("/prepaid-vouchers/deliveries/{delivery_id}/void")
def void_prepaid_voucher_delivery(
    delivery_id: str,
    body: ReasonIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    d = ST.void_delivery(db, current_user, active_tenant_id, delivery_id, body.reason)
    db.commit()
    return ST.list_deliveries(db, current_user, active_tenant_id, d.batch_id)


# ── Replacement (§16) ─────────────────────────────────────────────────────────


@router.post("/prepaid-vouchers/vouchers/{voucher_id}/replace", status_code=status.HTTP_201_CREATED)
def replace_prepaid_voucher(
    voucher_id: str,
    body: ReplacementIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The original is cancelled; the replacement (same batch, next serial, new code) inherits what it had left."""
    out = RPL.replace_voucher(db, current_user, active_tenant_id, voucher_id, body)
    db.commit()
    return out


@router.get("/prepaid-vouchers/vouchers/{voucher_id}/replacements")
def prepaid_voucher_replacement_chain(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return RPL.voucher_chain(db, current_user, active_tenant_id, voucher_id)


@router.get("/prepaid-vouchers/replacements")
def list_prepaid_voucher_replacements(
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batches = PVA.scoped_batches(db, current_user, active_tenant_id, _scope(scope), by_redemption=False)
    return RPL.list_replacements(db, current_user, active_tenant_id, batch_ids=[b.id for b in batches])


# ── Reports (§15) ─────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/reports/settlement")
def prepaid_voucher_settlement_report(
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return REP.settlement_report(db, current_user, active_tenant_id, _scope(scope))


@router.get("/prepaid-vouchers/reports/exceptions")
def prepaid_voucher_exceptions_report(
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return REP.exceptions_report(db, current_user, active_tenant_id, _scope(scope))


@router.get("/prepaid-vouchers/reports/overrides")
def prepaid_voucher_overrides_report(
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return REP.overrides_report(db, current_user, active_tenant_id, _scope(scope))


@router.get("/prepaid-vouchers/reports/catalog")
def prepaid_voucher_catalog_report(
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return REP.catalog_report(db, current_user, active_tenant_id, _scope(scope))


# ── Controls (§18) ────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/controls/pauses")
def list_prepaid_voucher_pauses(
    active: bool = Query(False),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CTL.list_pauses(db, current_user, active_tenant_id, active_only=bool(_given(active)))


@router.post("/prepaid-vouchers/controls/pauses", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_pause(
    body: PauseIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    p = CTL.create_pause(db, current_user, active_tenant_id, body)
    db.commit()
    return CTL.pause_out(db, p)


@router.post("/prepaid-vouchers/controls/pauses/{pause_id}/resume")
def resume_prepaid_voucher_pause(
    pause_id: str,
    body: Optional[ResumeIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    p = CTL.resume_pause(db, current_user, active_tenant_id, pause_id, body.note if body else None)
    db.commit()
    return CTL.pause_out(db, p)


@router.get("/prepaid-vouchers/controls/quotas")
def list_prepaid_voucher_quotas(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CTL.list_quotas(db, current_user, active_tenant_id)


@router.post("/prepaid-vouchers/controls/quotas", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_quota(
    body: QuotaIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    q = CTL.create_quota(db, current_user, active_tenant_id, body)
    db.commit()
    return CTL.quota_out(db, q)


@router.patch("/prepaid-vouchers/controls/quotas/{quota_id}")
def update_prepaid_voucher_quota(
    quota_id: str,
    body: QuotaUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    q = CTL.update_quota(db, current_user, active_tenant_id, quota_id, body)
    db.commit()
    return CTL.quota_out(db, q)


@router.get("/prepaid-vouchers/controls/test-batches")
def list_prepaid_voucher_test_batches(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CTL.list_test_batches(db, current_user, active_tenant_id)


@router.post("/prepaid-vouchers/controls/test-batches", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_test_batch(
    body: StaffTestBatchIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A new batch of staff test vouchers ("שוברי בדיקה"): the batch form's body (+ `testNote`)."""
    from app.services import prepaid_vouchers as PV

    batch = CTL.create_test_batch(db, current_user, active_tenant_id, body)
    db.commit()
    return PV.batch_out(db, batch, user=current_user)


@router.post("/prepaid-vouchers/controls/test-batches/{batch_id}")
def mark_prepaid_voucher_test_batch(
    batch_id: str,
    body: Optional[StaffTestMarkIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Mark a batch nothing real happened to yet (no redemption, delivery or invoice) as test."""
    CTL.mark_test(db, current_user, active_tenant_id, batch_id, body.note if body else None)
    db.commit()
    return CTL.list_test_batches(db, current_user, active_tenant_id)


@router.delete("/prepaid-vouchers/controls/test-batches/{batch_id}")
def unmark_prepaid_voucher_test_batch(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    CTL.unmark_test(db, current_user, active_tenant_id, batch_id)
    db.commit()
    return CTL.list_test_batches(db, current_user, active_tenant_id)


@router.get("/prepaid-vouchers/controls/batches/{batch_id}")
def prepaid_voucher_batch_controls(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CTL.batch_status(db, current_user, active_tenant_id, batch_id)


@router.get("/prepaid-vouchers/controls/events")
def prepaid_voucher_control_events(
    batch_id: Optional[str] = Query(None, alias="batchId"),
    limit: int = Query(200, ge=1, le=1000),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CTL.events(db, current_user, active_tenant_id, batch_id=_given(batch_id), limit=_given(limit) or 200)


# ── Simulator (§18.1) ─────────────────────────────────────────────────────────


@router.post("/prepaid-vouchers/simulate")
def simulate_prepaid_voucher(
    body: SimulateIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """How a redemption of a type / batch would go on a sample basket — read-only, nothing issued or used."""
    out = SIM.simulate(db, current_user, active_tenant_id, body)
    db.rollback()
    return out
