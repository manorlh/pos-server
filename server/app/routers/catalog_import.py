"""
A company's menu as a spreadsheet ("ייבוא פריטים מאקסל") - the template a dealer sends a
customer, the current catalog for editing, and importing either back. The rules are in
app/services/catalog_import.py.

Dashboard (user JWT; a super admin, a distributor, or a company manager of the company):

GET  /catalog-import/summary?companyId=              → the company: counts, its printers
GET  /catalog-import/template?companyId=&withData=false|true&format=xlsx|csv
                                                      → the blank template (pre-filled with the
                                                        company's categories and printers), or
                                                        the current catalog in the same sheets
POST /catalog-import/preview?companyId=              (multipart `file`: xlsx or csv)
                                                      → row by row: create / update / unchanged
                                                        / error, warnings, a summary and a token
POST /catalog-import/commit?companyId=               (multipart `file`, `token`, `skipErrors`)
                                                      → downloads the pictures given by link,
                                                        applies it in one transaction and wakes
                                                        the tills (catalog delta - with the
                                                        add-on layer and menus - and printers)

The sheets: הוראות, מחלקות, פריטים, קבוצות תוספות, אפשרויות, הערות מהירות, מדפסות
(app/services/catalog_sheet.py; the add-on layer: app/services/catalog_import_menu.py).
POST /catalog-import/share-link?companyId=           → a signed, 7-day link to the blank template

Public, no login - the link's signature is the credential, and it can only download:

GET  /public/catalog-template/{token}                → the blank template, built at download time

Errors carry `{"code", "msg"}` with a Hebrew `msg` the dashboard shows as it is.
"""
from __future__ import annotations

import html
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.middleware.rate_limit import check_rate_limit
from app.models.company import Company
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership
from app.models.user import User, UserRole
from app.services import catalog_import as svc
from app.services import catalog_sheet as S
from app.services import printers as K
from app.services.catalog_template import XLSX_MEDIA_TYPE, build_csv, build_workbook
from app.services.company_hierarchy import user_covers_company

router = APIRouter(prefix="/catalog-import", tags=["catalog-import"])
public_router = APIRouter(tags=["catalog-import"])

#: Who imports and exports a company's catalog: the roles that manage a company's menu.
#: A shop manager may edit only their own shop's rows (`_check_product_access`), which a
#: company-wide sheet is not.
IMPORT_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER})


def _error(code: int, key: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=code, detail={"code": key, "msg": message, **extra})


def _company(db: Session, user: User, tenant_id, company_id: Optional[str]) -> Company:
    """The company the sheet is for, after checking the caller may manage its catalog."""
    if user.role not in IMPORT_ROLES:
        raise _error(status.HTTP_403_FORBIDDEN, "forbidden", "ייבוא וייצוא הקטלוג זמינים למפיץ ולמנהל החברה")
    if company_id:
        try:
            ident = uuid.UUID(str(company_id))
        except ValueError:
            raise _error(status.HTTP_400_BAD_REQUEST, "bad_company", "חברה לא תקינה")
        company = db.query(Company).filter(Company.id == ident).first()
    elif user.role == UserRole.COMPANY_MANAGER and user.company_id is not None:
        company = db.query(Company).filter(Company.id == user.company_id).first()
    else:
        companies = (
            db.query(Company).filter(Company.tenant_id == tenant_id, Company.is_active.is_(True)).limit(2).all()
        )
        if len(companies) != 1:
            raise _error(status.HTTP_400_BAD_REQUEST, "company_required", "בחרו חברה")
        company = companies[0]
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _error(status.HTTP_404_NOT_FOUND, "company_not_found", "החברה לא נמצאה")
    if user.role == UserRole.COMPANY_MANAGER and not user_covers_company(db, user, company.id):
        raise _error(status.HTTP_403_FORBIDDEN, "forbidden", "אין לך הרשאה לקטלוג של החברה הזו")
    return company


def _read_upload(file: UploadFile) -> bytes:
    data = file.file.read(S.MAX_FILE_BYTES + 1)
    if len(data) > S.MAX_FILE_BYTES:
        raise _error(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large", "הקובץ גדול מדי (עד 5MB)")
    if not data:
        raise _error(status.HTTP_400_BAD_REQUEST, "empty", "הקובץ ריק")
    return data


def _parse(data: bytes, filename: Optional[str]) -> S.RawFile:
    try:
        return S.read_file(data, filename or "")
    except S.SheetError as exc:
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "unreadable", str(exc))


def _tz(db: Session, tenant_id) -> ZoneInfo:
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    try:
        return ZoneInfo((tenant.timezone if tenant else None) or "Asia/Jerusalem")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _attachment(name: str, fallback: str) -> Dict[str, str]:
    return {
        "Content-Disposition": f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}",
        "Cache-Control": "no-store",
    }


def _file_name(company: Company, with_data: bool, extension: str) -> str:
    safe = "".join(ch for ch in company.name if ch not in '\\/:*?"<>|').strip() or "company"
    return f"{'קטלוג' if with_data else 'טמפלט פריטים'} - {safe}.{extension}"


@router.get("/summary")
def get_summary(
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, current_user, active_tenant_id, company_id)
    return svc.company_summary(svc.load_context(db, active_tenant_id, company, current_user))


@router.get("/template")
def get_template(
    with_data: bool = Query(False, alias="withData"),
    fmt: str = Query("xlsx", alias="format", pattern="^(xlsx|csv)$"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The blank template (examples, the company's categories and printers), or with
    `withData` the current catalog - in the sheets the import reads back."""
    company = _company(db, current_user, active_tenant_id, company_id)
    ctx = svc.load_context(db, active_tenant_id, company, current_user)
    view = svc.template_view(ctx, with_data=with_data, tz=_tz(db, active_tenant_id))
    if fmt == "csv":
        return Response(
            content=build_csv(view), media_type="text/csv; charset=utf-8",
            headers=_attachment(_file_name(company, with_data, "csv"), "catalog.csv"),
        )
    return Response(
        content=build_workbook(view), media_type=XLSX_MEDIA_TYPE,
        headers=_attachment(_file_name(company, with_data, "xlsx"), "catalog.xlsx"),
    )


@router.post("/preview")
def preview_import(
    file: UploadFile = File(...),
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What importing the file would do, row by row. Writes nothing."""
    company = _company(db, current_user, active_tenant_id, company_id)
    data = _read_upload(file)
    raw = _parse(data, file.filename)
    plan = svc.build_plan(svc.load_context(db, active_tenant_id, company, current_user), raw)
    out = svc.preview_out(plan)
    out["fileName"] = file.filename
    out["token"] = svc.make_preview_token(
        active_tenant_id, company.id, current_user.id, svc.file_hash(data), plan.fingerprint
    )
    db.rollback()
    return out


@router.post("/commit")
def commit_import(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    token: Optional[str] = Form(None),
    skip_errors: bool = Form(False, alias="skipErrors"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Apply the file in one transaction. With the preview's `token` it must be the same file,
    by the same user, and the catalog must still give the same plan - otherwise 409 with
    the fresh preview. Rows with errors refuse the whole import unless `skipErrors`.
    """
    company = _company(db, current_user, active_tenant_id, company_id)
    data = _read_upload(file)
    raw = _parse(data, file.filename)
    claims = None
    if token:
        try:
            claims = svc.read_preview_token(token)
        except svc.TokenError as exc:
            if exc.reason == "expired":
                raise _error(status.HTTP_409_CONFLICT, "token_expired", "עבר זמן רב מאז הבדיקה - בדקו את הקובץ שוב")
            raise _error(status.HTTP_409_CONFLICT, "token_invalid", "אסמכתת הבדיקה לא תקינה - בדקו את הקובץ שוב")
        if (claims.get("t"), claims.get("c"), claims.get("u")) != (
            str(active_tenant_id), str(company.id), str(current_user.id)
        ):
            raise _error(status.HTTP_409_CONFLICT, "token_mismatch", "הבדיקה נעשתה לחברה אחרת - בדקו את הקובץ שוב")
        if claims.get("h") != svc.file_hash(data):
            raise _error(status.HTTP_409_CONFLICT, "file_changed", "הקובץ שונה מהקובץ שנבדק - בדקו אותו שוב")

    svc.lock_tenant(db, active_tenant_id)
    plan = svc.build_plan(svc.load_context(db, active_tenant_id, company, current_user), raw)
    if claims is not None and claims.get("f") != plan.fingerprint:
        fresh = svc.preview_out(plan)
        fresh["fileName"] = file.filename
        fresh["token"] = svc.make_preview_token(
            active_tenant_id, company.id, current_user.id, svc.file_hash(data), plan.fingerprint
        )
        db.rollback()
        raise _error(status.HTTP_409_CONFLICT, "plan_changed",
                     "הקטלוג השתנה מאז הבדיקה - הנה הבדיקה המעודכנת", preview=fresh)
    if plan.fatal:
        first = next(i.text for i in plan.issues if i.level == "error")
        db.rollback()
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "file_errors", first)
    if plan.error_rows() and not skip_errors:
        db.rollback()
        raise _error(status.HTTP_422_UNPROCESSABLE_ENTITY, "row_errors",
                     f"יש בקובץ {plan.error_rows()} שורות עם שגיאות - תקנו אותן או ייבאו בלי השורות השגויות")

    try:
        result = svc.apply_plan(db, plan, current_user)
        catalog_targets = svc.catalog_targets(db, active_tenant_id) if result.catalog_changed else []
        route_targets: List = []
        for shop_id in sorted(result.route_shop_ids):
            route_targets.extend(K.shop_targets(db, shop_id))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _error(status.HTTP_409_CONFLICT, "conflict", "הקטלוג השתנה תוך כדי הייבוא - נסו שוב")
    except Exception:
        db.rollback()
        raise
    if catalog_targets:
        background_tasks.add_task(svc.publish_catalog_notify, catalog_targets)
    if route_targets:
        background_tasks.add_task(K.publish_config_notify, route_targets)
    out = result.out()
    out["machinesNotified"] = len({machine for _, machine in [*catalog_targets, *route_targets]})
    return out


@router.post("/share-link")
def create_share_link(
    request: Request,
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A link to send the customer: downloads the blank template for 7 days, without a login.
    It reveals the company's category, add-on group, catalog menu and printer names and
    nothing else (no products, prices or option prices), and accepts no upload. It stops
    working when it expires or when the issuer loses access.
    """
    company = _company(db, current_user, active_tenant_id, company_id)
    token, expires_at = svc.make_share_token(active_tenant_id, company.id, current_user.id)
    path = f"/public/catalog-template/{token}"
    base = str(request.base_url).rstrip("/")
    if request.headers.get("x-forwarded-proto") == "https" and base.startswith("http://"):
        base = "https://" + base[len("http://"):]
    return {
        "token": token,
        "path": path,
        "url": f"{base}{get_settings().api_v1_prefix}{path}",
        "expiresAt": expires_at.isoformat(),
        "companyName": company.name,
    }


def _page(status_code: int, title: str, message: str) -> HTMLResponse:
    """What a customer's browser shows instead of the file."""
    body = (
        '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex">'
        f"<title>{html.escape(title)}</title><style>"
        "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
        "background:#F2F2F7;color:#1C1C1E;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Rubik,Arial,sans-serif}"
        "main{background:#fff;border-radius:22px;padding:28px;margin:16px;max-width:420px;text-align:center;"
        "box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04)}"
        "h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#6D6D72;line-height:1.5}"
        "@media (prefers-color-scheme:dark){body{background:#000;color:#fff}main{background:#1C1C1E}p{color:#8E8E93}}"
        f"</style></head><body><main><h1>{html.escape(title)}</h1><p>{html.escape(message)}</p></main></body></html>"
    )
    return HTMLResponse(body, status_code=status_code, headers={"Cache-Control": "no-store"})


@public_router.get("/public/catalog-template/{token}", include_in_schema=True)
def download_shared_template(token: str, request: Request, db: Session = Depends(get_db)):
    """The blank template behind a share link: read-only, built from the catalog as it is now."""
    check_rate_limit(request, "catalog_template_public", max_calls=30, window_seconds=60)
    try:
        tenant_id, company_id, user_id, _expires = svc.read_share_token(token)
    except svc.TokenError as exc:
        if exc.reason == "expired":
            return _page(status.HTTP_410_GONE, "הקישור פג תוקף", "בקשו מהמשווק קישור חדש להורדת הטמפלט.")
        return _page(status.HTTP_404_NOT_FOUND, "הקישור לא נמצא", "ודאו שהעתקתם את הקישור במלואו.")
    inactive = _page(status.HTTP_404_NOT_FOUND, "הקישור אינו פעיל", "בקשו מהמשווק קישור חדש להורדת הטמפלט.")
    issuer = db.query(User).filter(User.id == user_id).first()
    company = db.query(Company).filter(Company.id == company_id).first()
    if issuer is None or not issuer.is_active or company is None or not company.is_active:
        return inactive
    if str(company.tenant_id) != str(tenant_id) or issuer.role not in IMPORT_ROLES:
        return inactive
    # The issuer must still reach the company: a link dies with its issuer's access.
    if issuer.role != UserRole.SUPER_ADMIN:
        member = (
            db.query(TenantMembership.id)
            .filter(TenantMembership.user_id == issuer.id, TenantMembership.tenant_id == tenant_id)
            .first()
        )
        if member is None and str(issuer.tenant_id) != str(tenant_id):
            return inactive
        if issuer.role == UserRole.COMPANY_MANAGER and not user_covers_company(db, issuer, company.id):
            return inactive
    ctx = svc.load_context(db, tenant_id, company, issuer)
    content = build_workbook(svc.template_view(ctx, with_data=False, tz=_tz(db, tenant_id)))
    db.rollback()
    headers = _attachment(_file_name(company, False, "xlsx"), "catalog-template.xlsx")
    headers["X-Robots-Tag"] = "noindex"
    return Response(content=content, media_type=XLSX_MEDIA_TYPE, headers=headers)
