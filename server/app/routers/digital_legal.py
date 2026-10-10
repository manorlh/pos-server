"""
"משפטי ונגישות" — the legal pages and consent of the public digital channels
(P:\\specs\\digital-menu-ordering-cards-plan.md §17, §21; app/services/digital_legal/).

Dashboard (section `digital_legal`; company managers and up for a company, a shop's manager for
their shop's overrides):

GET    /digital-legal/catalog                         → the kinds, their fields and Hebrew templates
GET    /digital-legal/documents?companyId=&shopId=    → per kind: draft, published, history, what applies
POST   /digital-legal/documents?companyId=&shopId=    → {kind, start: template|published|inherited} → the draft
PUT    /digital-legal/documents/{id}                  → save the draft {title?, body?, fields?, editSeq}
POST   /digital-legal/documents/{id}/publish          → {confirmReviewed: true, editSeq, reviewNote?}
DELETE /digital-legal/documents/{id}                  → discard a draft
POST   /digital-legal/preview                         → {kind, body, fields} → rendered + problems (a read)
GET    /digital-legal/publication-check?companyId=&shopId=&product=menu|online|card
POST   /digital-legal/theme-check                     → {theme} → WCAG contrast per pair (a read)

Public (no login; throttled; only published versions):

GET    /public/v1/legal/{companyId}?shopId=&lang=          → the published pages (for the footer) + cookie policy version
GET    /public/v1/legal/{companyId}/{slug}?shopId=&lang=   → one page (accessibility|privacy|terms|cookies)
POST   /public/v1/consents                                 → log a cookie choice {companyId, anonId, choices, policyVersion, action, surface}

Errors: `{"detail": {"code", "userMessage", "retryable", "correlationId", …}}`.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.middleware.rate_limit import check_rate_limit
from app.models.company import Company
from app.models.digital_legal import LegalDocument
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.club.scope import error
from app.services.company_hierarchy import user_covers_company, user_covers_shop
from app.services.digital_legal import consent as CONSENT
from app.services.digital_legal import contrast as C
from app.services.digital_legal import documents as D
from app.services.digital_legal import gate as G
from app.services.digital_legal import templates as T

router = APIRouter(tags=["digital-legal"])
public_router = APIRouter(tags=["digital-legal-public"])

MESSAGES: Dict[str, str] = {
    "forbidden": "אין לך הרשאה לדפים המשפטיים של העסק הזה.",
    "company_not_found": "החברה לא נמצאה.",
    "shop_not_found": "הסניף לא נמצא.",
    "not_found": "המסמך לא נמצא.",
    "kind_invalid": "סוג מסמך לא מוכר.",
    "lang_unsupported": "השפה עדיין לא נתמכת בדפים המשפטיים.",
    "start_invalid": "נקודת התחלה לא מוכרת.",
    "nothing_to_copy": "אין גרסה מפורסמת להעתיק ממנה.",
    "not_a_draft": "אפשר לערוך רק טיוטה. גרסה שפורסמה אינה משתנה — פתחו טיוטה חדשה.",
    "edit_conflict": "המסמך נשמר בינתיים במקום אחר. רעננו ונסו שוב.",
    "title_too_long": "הכותרת ארוכה מדי.",
    "body_too_long": "הטקסט ארוך מדי.",
    "fields_invalid": "ערכי השדות אינם תקינים.",
    "publish_invalid": "אי אפשר לפרסם: חסרים פרטי חובה או שיש ערכים לא תקינים.",
    "review_required": 'יש לאשר "נבדק" (לאחר בדיקה עם עורך דין) לפני פרסום.',
    "product_invalid": "ערוץ לא מוכר.",
    "page_unavailable": "הדף אינו זמין.",
    "too_many_requests": "בוצעו יותר מדי בקשות. נסו שוב בעוד דקה.",
    "anon_id_invalid": "מזהה לא תקין.",
    "action_invalid": "פעולה לא מוכרת.",
    "policy_version_invalid": "גרסת מדיניות לא תקינה.",
}

ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


def _fail(code: str, status: int = 400, **extra: Any) -> HTTPException:
    return error(code, status, MESSAGES.get(code), retryable=status in (429, 503), **extra)


def _raise(exc: D.LegalError) -> HTTPException:
    return _fail(exc.code, exc.status, **exc.extra)


def _uuid(value: Any, code: str = "not_found", status: int = 404) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise _fail(code, status) from None


def _scope(db: Session, user: User, tenant_id: Any, company_id: Any, shop_id: Any = None):
    """The company (and shop) named — of the active tenant, and within the caller's reach."""
    company = db.get(Company, _uuid(company_id, "company_not_found"))
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _fail("company_not_found", 404)
    shop: Optional[Shop] = None
    if shop_id:
        shop = db.get(Shop, _uuid(shop_id, "shop_not_found"))
        if shop is None or str(shop.company_id) != str(company.id):
            raise _fail("shop_not_found", 404)
    role = user.role
    if role in ADMIN_ROLES:
        return company, shop
    if role == UserRole.COMPANY_MANAGER:
        ok = user_covers_shop(db, user, shop) if shop is not None else user_covers_company(db, user, company.id)
    elif role == UserRole.SHOP_MANAGER:
        ok = shop is not None and user.shop_id is not None and str(user.shop_id) == str(shop.id)
    else:
        ok = False
    if not ok:
        raise _fail("forbidden", 403)
    return company, shop


def _document(db: Session, user: User, tenant_id: Any, document_id: str) -> LegalDocument:
    doc = db.get(LegalDocument, _uuid(document_id))
    if doc is None or str(doc.tenant_id) != str(tenant_id):
        raise _fail("not_found", 404)
    _scope(db, user, tenant_id, doc.company_id, doc.shop_id)
    return doc


# ── Dashboard ────────────────────────────────────────────────────────────────


@router.get("/digital-legal/catalog")
def legal_catalog(user: User = Depends(get_current_user)):
    return {
        "kinds": T.catalogue(),
        "draftBanner": T.DRAFT_BANNER,
        "disclaimer": T.DISCLAIMER,
        "languages": list(T.LANGS),
        "requiredKinds": {p: list(k) for p, k in G.REQUIRED_KINDS.items()},
    }


@router.get("/digital-legal/documents")
def legal_documents(
    company_id: str = Query(..., alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    lang: str = Query("he"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company, shop = _scope(db, user, tenant_id, company_id, shop_id)
    if lang not in T.LANGS:
        raise _fail("lang_unsupported", 422)
    return D.overview(db, company=company, shop=shop, lang=lang)


@router.post("/digital-legal/documents")
def legal_create_draft(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company, shop = _scope(db, user, tenant_id, company_id, shop_id)
    try:
        doc, created = D.create_draft(
            db, company=company, shop=shop, kind=str(body.get("kind") or ""), lang=str(body.get("lang") or "he"),
            start=str(body.get("start") or "template"), user_id=user.id,
        )
    except D.LegalError as exc:
        db.rollback()
        raise _raise(exc) from None
    db.commit()
    out = D.serialize(doc)
    out["created"] = created
    return out


@router.put("/digital-legal/documents/{document_id}")
def legal_save_draft(
    document_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    doc = _document(db, user, tenant_id, document_id)
    title, text = body.get("title"), body.get("body")
    if (title is not None and not isinstance(title, str)) or (text is not None and not isinstance(text, str)):
        raise _fail("fields_invalid", 422)
    try:
        D.update_draft(db, doc, title=title, body=text, fields=body.get("fields"), edit_seq=body.get("editSeq"), user_id=user.id)
    except D.LegalError as exc:
        db.rollback()
        raise _raise(exc) from None
    db.commit()
    out = D.serialize(doc)
    out["problems"] = T.problems(doc.kind, doc.title, doc.body, doc.fields)
    out["preview"] = T.render(doc.kind, doc.body, doc.fields, preview=True)
    return out


@router.post("/digital-legal/documents/{document_id}/publish")
def legal_publish(
    document_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    doc = _document(db, user, tenant_id, document_id)
    try:
        D.publish(
            db, doc, confirm_reviewed=body.get("confirmReviewed") is True, edit_seq=body.get("editSeq"),
            review_note=body.get("reviewNote") if isinstance(body.get("reviewNote"), str) else None, user_id=user.id,
        )
    except D.LegalError as exc:
        db.rollback()
        raise _raise(exc) from None
    db.commit()
    return D.serialize(doc)


@router.delete("/digital-legal/documents/{document_id}")
def legal_discard_draft(
    document_id: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    doc = _document(db, user, tenant_id, document_id)
    try:
        D.discard_draft(db, doc)
    except D.LegalError as exc:
        db.rollback()
        raise _raise(exc) from None
    db.commit()
    return {"discarded": True}


@router.post("/digital-legal/preview")
def legal_preview(body: Dict[str, Any] = Body(...), user: User = Depends(get_current_user)):
    kind = str(body.get("kind") or "")
    if kind not in T.KINDS:
        raise _fail("kind_invalid", 422)
    text = body.get("body") if isinstance(body.get("body"), str) else ""
    title = body.get("title") if isinstance(body.get("title"), str) else T.kind_def(kind).title
    fields = body.get("fields") if isinstance(body.get("fields"), dict) else {}
    return {
        "preview": T.render(kind, text, fields, preview=True),
        "published": T.render(kind, text, fields),
        "problems": T.problems(kind, title, text, fields),
    }


@router.get("/digital-legal/publication-check")
def legal_publication_check(
    company_id: str = Query(..., alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    product: str = Query(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company, shop = _scope(db, user, tenant_id, company_id, shop_id)
    try:
        return G.check_publication(db, company_id=company.id, shop_id=shop.id if shop else None, product=product)
    except D.LegalError as exc:
        raise _raise(exc) from None


@router.post("/digital-legal/theme-check")
def legal_theme_check(body: Dict[str, Any] = Body(...), user: User = Depends(get_current_user)):
    theme = body.get("theme") if isinstance(body.get("theme"), dict) else {}
    return C.check_theme(theme)


# ── Public ───────────────────────────────────────────────────────────────────


def _throttle(request: Request, key: str, max_calls: int) -> None:
    try:
        check_rate_limit(request, key, max_calls, 60)
    except HTTPException:
        exc = _fail("too_many_requests", 429)
        exc.detail["retryAfterSeconds"] = 60
        exc.headers = {"Retry-After": "60"}
        raise exc from None


def _client_ip(request: Request) -> Optional[str]:
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else None)


def _public_company(db: Session, company_id: str, shop_id: Optional[str]):
    try:
        cid = uuid.UUID(str(company_id))
    except (TypeError, ValueError):
        raise _fail("page_unavailable", 404) from None
    company = db.get(Company, cid)
    if company is None or not company.is_active:
        raise _fail("page_unavailable", 404)
    sid = None
    if shop_id:
        try:
            sid = uuid.UUID(str(shop_id))
        except (TypeError, ValueError):
            raise _fail("page_unavailable", 404) from None
        shop = db.get(Shop, sid)
        if shop is None or str(shop.company_id) != str(company.id):
            raise _fail("page_unavailable", 404)
    return company, sid


@public_router.get("/public/v1/legal/{company_id}")
def public_legal_index(
    company_id: str,
    request: Request,
    shop_id: Optional[str] = Query(None, alias="shopId"),
    lang: str = Query("he"),
    db: Session = Depends(get_db),
):
    _throttle(request, "public_legal", 120)
    company, sid = _public_company(db, company_id, shop_id)
    lang = lang if lang in T.LANGS else "he"
    docs = D.published_kinds(db, company_id=company.id, shop_id=sid, lang=lang)
    return {
        "businessName": company.name,
        "lang": lang,
        "documents": {
            kind: {
                "title": doc.title,
                "slug": T.kind_def(kind).slug,
                "version": doc.version,
                "publishedAt": D._iso(doc.published_at),
            }
            for kind, doc in docs.items()
        },
        "cookiePolicyVersion": int(docs["cookies"].version) if "cookies" in docs else 0,
    }


@public_router.get("/public/v1/legal/{company_id}/{slug}")
def public_legal_page(
    company_id: str,
    slug: str,
    request: Request,
    shop_id: Optional[str] = Query(None, alias="shopId"),
    lang: str = Query("he"),
    db: Session = Depends(get_db),
):
    _throttle(request, "public_legal", 120)
    kind = T.KIND_BY_SLUG.get(slug)
    if kind is None:
        raise _fail("page_unavailable", 404)
    company, sid = _public_company(db, company_id, shop_id)
    page = D.public_page(db, company=company, shop_id=sid, kind=kind, lang=lang if lang in T.LANGS else "he")
    if page is None:
        raise _fail("page_unavailable", 404)
    return page


@public_router.post("/public/v1/consents", status_code=201)
def public_record_consent(request: Request, body: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    _throttle(request, "public_consent", 30)
    company, _ = _public_company(db, str(body.get("companyId") or ""), None)
    try:
        row = CONSENT.record(
            db, company=company, anon_id=body.get("anonId"), choices=body.get("choices"),
            policy_version=body.get("policyVersion"), action=body.get("action"), surface=body.get("surface"),
            ip=_client_ip(request),
        )
    except D.LegalError as exc:
        db.rollback()
        raise _raise(exc) from None
    db.commit()
    return {"id": str(row.id), "recordedAt": D._iso(row.created_at), "choices": row.choices}
