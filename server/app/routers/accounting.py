"""
Accounting export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2). Dashboard-only.

* `GET/PUT /accounting/settings` — the account mapping of a company, or a shop's override.
* `GET /accounting/z-reports` — Zs to choose from, each with the batches that carried it.
* `POST /accounting/preview` — the journal entries an export would write, or what stops it.
* `POST /accounting/exports` — write a batch (409 for an exported Z without confirmation,
  422 with the full list of problems — missing mappings first — when it cannot balance).
* `GET /accounting/exports`, `GET /accounting/exports/{id}/download` — batches, again;
  `GET /accounting/exports/bundle?ids=…` — several batches (a per-shop export) in one zip.

Export level (the company's `exportLevel`, or the request's `level`): **company** — one
batch for every chosen Z (optionally `consolidate`d into company entries, each line with
its shop's cost centre); **shop** — one batch per shop. A Z is locked once it is in any
batch, at either level: exporting it again — at the same level or the other — is a 409
naming the batches and their level until `confirmReexport`.

Who: a super admin, a distributor, or a company manager over the company. Account numbers
and journal files are the books; a shop manager and a cashier have no business here.
"""
from datetime import date, datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.accounting import AccountingExportBatch, AccountingExportItem, AccountingSettings
from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers.companies import _check_company_access
from app.routers.z_reports import _scope_by_user as _scope_z_by_user
from app.schemas.accounting import (
    AccountingSettingsOut,
    AccountingSettingsPut,
    AccountingZListResponse,
    AccountingZRow,
    ExportBatchListResponse,
    ExportBatchOut,
    ExportBatchRef,
    ExportedRef,
    ExportRequest,
    JournalEntryOut,
    JournalLineOut,
    PreviewResponse,
    ProblemOut,
)
from app.services.accounting import exports as svc
from app.services.accounting.settings import (
    ACCOUNT_KEYS,
    load_row,
    merge,
    missing_core,
    normalize,
)

router = APIRouter(prefix="/accounting", tags=["accounting"])

ACCOUNTING_ROLES = frozenset(
    {UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER, UserRole.MERCHANT_ADMIN}
)

#: Zs listed at once. A year of daily Zs for a dozen shops.
Z_LIST_MAX = 5000


def _company(db: Session, company_id: uuid.UUID, user: User, tenant_id) -> Company:
    if user.role not in ACCOUNTING_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    company = db.query(Company).filter(Company.id == company_id).first()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, tenant_id)
    _check_company_access(user, company, db)
    return company


def _shop_of(db: Session, company: Company, shop_id: Optional[uuid.UUID]) -> Optional[Shop]:
    if shop_id is None:
        return None
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None or shop.company_id != company.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found in this company")
    return shop


def _settings_out(db: Session, company: Company, shop: Optional[Shop]) -> AccountingSettingsOut:
    company_row = load_row(db, company.id, None)
    shop_row = load_row(db, company.id, shop.id) if shop is not None else None
    company_settings = normalize(company_row.settings if company_row else None)
    shop_settings = normalize(shop_row.settings if shop_row else None) if shop is not None else None
    effective = merge(company_settings, shop_settings)
    stamps = [r.updated_at for r in (company_row, shop_row) if r is not None and r.updated_at]
    return AccountingSettingsOut(
        company_id=company.id,
        shop_id=shop.id if shop else None,
        company=company_settings,
        shop=shop_settings,
        effective=effective,
        missing=missing_core(effective),
        account_keys=list(ACCOUNT_KEYS),
        updated_at=max(stamps) if stamps else None,
    )


@router.get("/settings", response_model=AccountingSettingsOut, response_model_by_alias=True)
def get_accounting_settings(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The company's mapping, the shop's own overrides, the merge, and what is missing."""
    company = _company(db, company_id, current_user, active_tenant_id)
    return _settings_out(db, company, _shop_of(db, company, shop_id))


@router.put("/settings", response_model=AccountingSettingsOut, response_model_by_alias=True)
def put_accounting_settings(
    body: AccountingSettingsPut,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Replace one level's own values (company, or the shop override). Empty = inherit."""
    company = _company(db, body.company_id, current_user, active_tenant_id)
    shop = _shop_of(db, company, body.shop_id)
    row = load_row(db, company.id, shop.id if shop else None)
    if row is None:
        row = AccountingSettings(
            id=uuid.uuid4(),
            tenant_id=company.tenant_id or active_tenant_id,
            company_id=company.id,
            shop_id=shop.id if shop else None,
        )
        db.add(row)
    row.settings = normalize(body.settings.stored())
    row.updated_by_user_id = current_user.id
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _settings_out(db, company, shop)


@router.get("/z-reports", response_model=AccountingZListResponse, response_model_by_alias=True)
def list_accounting_z_reports(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    only_unexported: bool = Query(False, alias="onlyUnexported"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The company's Zs by business date, oldest first, with the batches that carried each."""
    company = _company(db, company_id, current_user, active_tenant_id)
    shop = _shop_of(db, company, shop_id)
    query = _scope_z_by_user(
        db.query(ZReport).filter(ZReport.tenant_id == active_tenant_id), current_user, db
    )
    if query is None:
        return AccountingZListResponse(items=[])
    query = (
        query.options(joinedload(ZReport.shop))
        .join(Shop, Shop.id == ZReport.shop_id)
        .filter(Shop.company_id == company.id)
    )
    if shop is not None:
        query = query.filter(ZReport.shop_id == shop.id)
    if from_date is not None:
        query = query.filter(ZReport.business_date >= from_date)
    if to_date is not None:
        query = query.filter(ZReport.business_date <= to_date)
    if only_unexported:
        query = query.filter(
            ~ZReport.id.in_(db.query(AccountingExportItem.z_report_id))
        )
    rows = (
        query.order_by(ZReport.business_date, ZReport.shop_id, ZReport.shop_sequence_number)
        .limit(Z_LIST_MAX + 1)
        .all()
    )
    truncated = len(rows) > Z_LIST_MAX
    rows = rows[:Z_LIST_MAX]
    refs = svc.exported_refs(db, [z.id for z in rows])
    items = []
    for z in rows:
        net = None
        if z.total_sales is not None:
            net = float(z.total_sales) - float(z.total_refunds or 0)
        items.append(
            AccountingZRow(
                id=z.id,
                shop_id=z.shop_id,
                shop_name=z.shop.name if z.shop else None,
                # The number the Z is quoted by: its till's own run on a till Z (§5), else the shop's.
                shop_sequence_number=z.z_number,
                business_date=z.business_date,
                closed_at=z.closed_at,
                net_sales=net,
                vat_total=float(z.vat_total) if z.vat_total is not None else None,
                exported=[
                    ExportedRef(
                        batch_id=b.id, batch_number=b.batch_number, created_at=b.created_at,
                        level=b.level or "company",
                    )
                    for b in refs.get(z.id, [])
                ],
            )
        )
    return AccountingZListResponse(items=items, truncated=truncated)


def _prepare(body: ExportRequest, current_user: User, active_tenant_id, db: Session):
    company = _company(db, body.company_id, current_user, active_tenant_id)
    scoped = _scope_z_by_user(
        db.query(ZReport).filter(ZReport.tenant_id == active_tenant_id), current_user, db
    )
    if scoped is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Z reports not found")
    zs = svc.load_zs(db, company.id, body.z_report_ids, scoped)
    _level, consolidate = _level_of(db, company, body)
    entries, problems, company_settings = svc.prepare(
        db, company.id, zs, grouping=body.grouping, method=body.method,
        consolidate=consolidate, company_name=company.name or "",
    )
    already = svc.exported_refs(db, [z.id for z in zs])
    return company, zs, entries, problems, company_settings, already


def _level_of(db: Session, company: Company, body: ExportRequest):
    """(level, consolidate): the request's, else the company's own settings."""
    row = load_row(db, company.id, None)
    own = merge(row.settings if row is not None else None, None)
    level = body.level or own.get("exportLevel") or "company"
    consolidate = body.consolidate if body.consolidate is not None else bool(own.get("consolidate"))
    return level, bool(consolidate) and level == "company"


def _entry_out(e) -> JournalEntryOut:
    return JournalEntryOut(
        shop_id=e.shop_id,
        shop_name=e.shop_name,
        reference1=e.reference1,
        reference2=e.reference2,
        entry_date=e.entry_date,
        details=e.details,
        branch=e.branch,
        movement_type=e.movement_type,
        z_ids=e.z_ids,
        total_debit=e.total_debit,
        total_credit=e.total_credit,
        lines=[
            JournalLineOut(
                side=l.side, key=l.key, account=l.account, amount=l.amount, label=l.label,
                branch=l.branch, shop_name=l.shop_name,
            )
            for l in e.lines
        ],
    )


def _problem_out(p) -> ProblemOut:
    return ProblemOut(code=p.code, z_id=p.z_id, z_number=p.z_number, shop_name=p.shop_name, detail=p.detail)


@router.post("/preview", response_model=PreviewResponse, response_model_by_alias=True)
def preview_accounting_export(
    body: ExportRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What an export of these Zs would write. Writes nothing."""
    _company_row, _zs, entries, problems, _s, already = _prepare(body, current_user, active_tenant_id, db)
    return PreviewResponse(
        entries=[_entry_out(e) for e in entries],
        problems=[_problem_out(p) for p in problems],
        already_exported=list(already.keys()),
    )


def _batch_out(db: Session, b: AccountingExportBatch, with_zs: bool = False) -> ExportBatchOut:
    company = db.query(Company.name).filter(Company.id == b.company_id).first()
    shop = db.query(Shop.name).filter(Shop.id == b.shop_id).first() if b.shop_id else None
    user = db.query(User).filter(User.id == b.created_by_user_id).first() if b.created_by_user_id else None
    created_by = (user.username or user.email) if user is not None else None
    return ExportBatchOut(
        id=b.id,
        batch_number=b.batch_number,
        company_id=b.company_id,
        company_name=company[0] if company else None,
        shop_id=b.shop_id,
        shop_name=shop[0] if shop else None,
        format=b.format,
        method=b.method,
        encoding=b.encoding,
        grouping=b.grouping,
        level=b.level or "company",
        date_from=b.date_from,
        date_to=b.date_to,
        z_count=b.z_count,
        entry_count=b.entry_count,
        line_count=b.line_count,
        total_debit=b.total_debit,
        is_reexport=bool(b.is_reexport),
        file_name=b.file_name,
        created_by=created_by,
        created_at=b.created_at,
        z_report_ids=[i.z_report_id for i in b.items] if with_zs else [],
    )


@router.post(
    "/exports",
    response_model=ExportBatchOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def create_accounting_export(
    body: ExportRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Write a batch. Nothing is written when anything is refused."""
    company, zs, entries, problems, company_settings, already = _prepare(
        body, current_user, active_tenant_id, db
    )
    if problems:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "export_refused",
                "message": "The export cannot be written",
                "problems": [_problem_out(p).model_dump(by_alias=True, mode="json") for p in problems],
            },
        )
    if already and not body.confirm_reexport:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "already_exported",
                "message": "Some Z reports were already exported; confirm to export them again",
                "zReportIds": [str(z) for z in already],
                "batchNumbers": sorted({b.batch_number for bs in already.values() for b in bs}),
                # Per batch, the level it was written at: a Z exported with the company
                # must not quietly go again in a shop's file, nor the other way round.
                "batches": [
                    {"batchNumber": b.batch_number, "level": b.level or "company",
                     "shopId": str(b.shop_id) if b.shop_id else None}
                    for b in sorted(
                        {b.id: b for bs in already.values() for b in bs}.values(),
                        key=lambda b: b.batch_number,
                    )
                ],
            },
        )
    method = body.method or company_settings.get("method") or "flexible"
    encoding = body.encoding or company_settings.get("encoding") or "cp1255"
    level, _consolidate = _level_of(db, company, body)
    if level == "shop":
        # A batch per shop, each with its own shop's entries.
        parts = [
            (shop_zs, [e for e in entries if e.shop_id == shop_zs[0].shop_id])
            for shop_zs in svc.split_by_shop(zs)
        ]
    else:
        parts = [(list(zs), entries)]
    batches = [
        svc.create_batch(
            db,
            tenant_id=active_tenant_id,
            company_id=company.id,
            zs=part_zs,
            entries=part_entries,
            fmt=body.format,
            method=method,
            encoding=encoding,
            grouping=body.grouping,
            is_reexport=any(z.id in already for z in part_zs),
            user=current_user,
            level=level,
        )
        for part_zs, part_entries in parts
    ]
    db.commit()
    out = _batch_out(db, batches[0], with_zs=True)
    out.group_batches = [
        ExportBatchRef(
            id=b.id,
            batch_number=b.batch_number,
            shop_id=b.shop_id,
            shop_name=(part_zs[0].shop.name if part_zs and part_zs[0].shop else None),
            file_name=b.file_name,
        )
        for b, (part_zs, _e) in zip(batches, parts)
    ]
    return out


@router.get("/exports", response_model=ExportBatchListResponse, response_model_by_alias=True)
def list_accounting_exports(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    limit: int = Query(200, ge=1, le=1000),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, company_id, current_user, active_tenant_id)
    query = db.query(AccountingExportBatch).filter(
        AccountingExportBatch.tenant_id == active_tenant_id,
        AccountingExportBatch.company_id == company.id,
    )
    if shop_id is not None:
        query = query.filter(
            AccountingExportBatch.id.in_(
                db.query(AccountingExportItem.batch_id)
                .join(ZReport, ZReport.id == AccountingExportItem.z_report_id)
                .filter(ZReport.shop_id == shop_id)
            )
        )
    batches: List[AccountingExportBatch] = (
        query.order_by(AccountingExportBatch.batch_number.desc()).limit(limit).all()
    )
    return ExportBatchListResponse(items=[_batch_out(db, b, with_zs=True) for b in batches])


@router.get("/exports/bundle")
def download_accounting_export_bundle(
    ids: str = Query(..., description="Comma-separated batch ids"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Several stored batches (a per-shop export) in one zip, each zip unchanged inside."""
    try:
        wanted = list(dict.fromkeys(uuid.UUID(p.strip()) for p in ids.split(",") if p.strip()))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Bad batch id")
    if not wanted or len(wanted) > 200:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="1 to 200 batch ids")
    batches = (
        db.query(AccountingExportBatch)
        .filter(AccountingExportBatch.id.in_(wanted), AccountingExportBatch.tenant_id == active_tenant_id)
        .order_by(AccountingExportBatch.batch_number)
        .all()
    )
    if len(batches) != len(wanted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found")
    for company_id in {b.company_id for b in batches}:
        _company(db, company_id, current_user, active_tenant_id)
    numbers = [b.batch_number for b in batches]
    name = (
        f"accounting_batches_{numbers[0]}.zip" if len(numbers) == 1
        else f"accounting_batches_{numbers[0]}-{numbers[-1]}.zip"
    )
    return Response(
        content=svc.build_bundle(batches),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/exports/{batch_id}/download")
def download_accounting_export(
    batch_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The stored zip, byte for byte as first written."""
    batch = db.query(AccountingExportBatch).filter(AccountingExportBatch.id == batch_id).first()
    if batch is None or batch.tenant_id != active_tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found")
    _company(db, batch.company_id, current_user, active_tenant_id)
    return Response(
        content=bytes(batch.file_content),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{batch.file_name}"'},
    )
