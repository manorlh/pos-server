"""Dashboard tax reports — Israeli OPEN FORMAT export."""

from datetime import date
from typing import Literal, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User
from app.routers.companies import _check_company_access
from app.routers.shops import _check_shop_access
from app.schemas.tax_report import TaxOpenFormatPreviewResponse
from app.services.tax_reports import (
    build_tax_open_format_export,
    resolve_export_context,
)

router = APIRouter(prefix="/reports/tax", tags=["tax-reports"])


def _get_company_or_404(db: Session, company_id: str, active_tenant_id) -> Company:
    try:
        cid = uuid.UUID(company_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid companyId")
    company = db.query(Company).filter(Company.id == cid).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    return company


def _get_shop_or_404(db: Session, shop_id: str, active_tenant_id) -> Shop:
    try:
        sid = uuid.UUID(shop_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid shopId")
    shop = db.query(Shop).filter(Shop.id == sid).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return shop


def _resolve_scope_entities(
    db: Session,
    scope: Literal["shop", "company"],
    *,
    shop_id: Optional[str],
    company_id: Optional[str],
    active_tenant_id,
    current_user: User,
) -> tuple[Company, Optional[Shop], Optional[uuid.UUID], Optional[uuid.UUID]]:
    if scope == "shop":
        if not shop_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="shopId is required when scope=shop")
        shop = _get_shop_or_404(db, shop_id, active_tenant_id)
        _check_shop_access(current_user, shop, db)
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if not company:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found for shop")
        return company, shop, None, shop.id

    if not company_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="companyId is required when scope=company")
    company = _get_company_or_404(db, company_id, active_tenant_id)
    # Permission follows the company tree (a group manager may pull a subsidiary's
    # file). Attribution does not: `company.id` is passed straight through, so the
    # export still contains only the shops of *that* company — the one whose ח.פ. is
    # on the documents. A group's file must never absorb a subsidiary's invoices.
    _check_company_access(current_user, company, db)
    return company, None, company.id, None


@router.get("/openformat/preview", response_model=TaxOpenFormatPreviewResponse, response_model_by_alias=True)
def preview_tax_open_format(
    scope: Literal["shop", "company"] = Query(...),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    mode: Literal["date-range", "year"] = Query("date-range"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    year: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company, shop, cid, sid = _resolve_scope_entities(
        db, scope, shop_id=shop_id, company_id=company_id,
        active_tenant_id=active_tenant_id, current_user=current_user,
    )
    ctx = resolve_export_context(
        db, company=company, shop=shop, mode=mode,
        from_date=from_date, to_date=to_date, year=year,
    )
    result, tx_dicts, _ = build_tax_open_format_export(
        db, active_tenant_id, ctx, company_id=cid, shop_id=sid,
    )

    dr: dict = {}
    if "year" in ctx.date_range:
        dr = {"year": ctx.date_range["year"]}
    else:
        dr = {
            "from": ctx.start.date().isoformat(),
            "to": ctx.end.date().isoformat(),
        }

    from app.services.open_format import software

    return TaxOpenFormatPreviewResponse(
        transaction_count=len(tx_dicts),
        record_counts=dict(result.record_counts),
        business_info=dict(ctx.business_info),
        global_tax_rate=ctx.global_tax_rate,
        date_range=dr,
        software=software.get_settings(db)["effective"],
        # The A000 software fields still written as placeholders (not configured).
        placeholders=software.placeholders(db),
    )


@router.get("/openformat")
def download_tax_open_format(
    scope: Literal["shop", "company"] = Query(...),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    mode: Literal["date-range", "year"] = Query("date-range"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    year: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company, shop, cid, sid = _resolve_scope_entities(
        db, scope, shop_id=shop_id, company_id=company_id,
        active_tenant_id=active_tenant_id, current_user=current_user,
    )
    ctx = resolve_export_context(
        db, company=company, shop=shop, mode=mode,
        from_date=from_date, to_date=to_date, year=year,
    )
    result, _, zip_bytes = build_tax_open_format_export(
        db, active_tenant_id, ctx, company_id=cid, shop_id=sid,
    )

    vat8 = (ctx.business_info.get("vatNumber") or "00000000")[:8].zfill(8)
    from datetime import datetime
    # MMDDhhmm of the production, local time — the same moment as A000 1026/1027.
    produced = result.process_date or datetime.now(ctx.zone)
    ts = produced.strftime("%m%d%H%M")
    filename = f"OPENFRMT-{vat8}-{ts}.zip"

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
