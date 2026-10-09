"""
"מועדון לקוחות" — dashboard, till and public sign-up API (docs/SPEC_NOTIFICATIONS_CLUB.md part ג).

Dashboard (company managers and up, per company):

GET    /club?companyId=                      → the club, its page, documents, QR sources, counts
PUT    /club?companyId=                      → create / rename / switch the club on or off
PUT    /club/landing?companyId=              → the public page's settings (publish needs terms + privacy)
POST   /club/documents?companyId=            → a new draft version of terms / privacy / a consent text
POST   /club/documents/{id}/publish          → it becomes the active version (the previous is archived)
POST   /club/sources?companyId=              → a new opaque QR source token (shop / till / poster…)
POST   /club/sources/{id}/deactivate
GET    /club/members?companyId=&q=           → members, phones masked
GET    /club/members/{id}                    → one member: consents, benefits, audit
POST   /club/members/{id}/reveal-phone       → the full number (reason, audited)
POST   /club/members/{id}/status             → suspend / reactivate / close (reason, audited)

Till (machine JWT): GET /sync/{machine_id}/club/lookup?phone=… | ?qr=… — minimal.

Public (no login; throttled; the club is resolved from the QR's opaque token only):

GET    /public/club/{token}                  → the page's safe configuration
POST   /public/club/{token}/otp/start        → {phone, clientSession?} → code sent
POST   /public/club/{token}/otp/resend       → {challengeId, clientSession}
POST   /public/club/{token}/otp/verify       → {challengeId, clientSession, code} → registrationToken
POST   /public/club/{token}/register         → the form + registrationToken → member
GET    /public/club/unsubscribe/{token}      → is this link valid (marketing opt-out only)
POST   /public/club/unsubscribe/{token}      → opt out of marketing SMS

Errors: `{"detail": {"code", "userMessage", "retryable", "correlationId", …}}`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal, get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_from_sync_machine_token
from app.middleware.rate_limit import check_rate_limit, check_rate_limit_by_key
from app.models.club import (
    DOC_KINDS,
    MEMBERSHIP_ACTIVE,
    MEMBERSHIP_CLOSED,
    MEMBERSHIP_SUSPENDED,
    ClubBenefitGrant,
    ClubAuditEvent,
    ClubConsentEvent,
    ClubCustomer,
    ClubDocumentVersion,
    ClubLandingPage,
    ClubMembership,
    ClubProgram,
    ClubSourceToken,
    ClubSuppression,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services.club import lookup as LK
from app.services.club import otp as OTP
from app.services.club import public as PUB
from app.services.club import registration as REG
from app.services.club.scope import CLUB_ADMIN_ROLES, audit, error, require_role, resolve_company
from app.services.notifications import worker as W
from app.services.notifications.crypto import decrypt_text, random_token
from app.services.notifications.phone import PhoneError, normalize_phone, phone_hash

router = APIRouter(tags=["club"])
till_router = APIRouter(tags=["club"])
public_router = APIRouter(tags=["club-public"])

#: Public messages (Hebrew) per error code — never revealing membership.
PUBLIC_MESSAGES = {
    "page_unavailable": "הדף אינו זמין כרגע.",
    "phone_empty": "נא להזין מספר טלפון.",
    "phone_invalid": "מספר הטלפון אינו תקין.",
    "phone_not_mobile": "יש להזין מספר טלפון נייד.",
    "phone_foreign_unsupported": "כרגע ניתן להירשם עם מספר נייד ישראלי בלבד.",
    "too_many_requests": "בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר.",
    "provider_unavailable": "לא ניתן לשלוח קוד כרגע. נסו שוב בעוד מספר דקות.",
    "challenge_invalid": "הקוד אינו תקף יותר. בקשו קוד חדש.",
    "code_expired": "תוקף הקוד פג. בקשו קוד חדש.",
    "too_many_attempts": "יותר מדי ניסיונות שגויים. בקשו קוד חדש.",
    "wrong_code": "הקוד שגוי.",
    "challenge_used": "הקוד כבר נוצל.",
    "resend_too_soon": "אפשר לבקש קוד חדש בעוד מספר שניות.",
    "too_many_sends": "נשלחו יותר מדי קודים. התחילו מחדש מאוחר יותר.",
    "registration_invalid": "פג תוקף האימות. התחילו מחדש.",
    "registration_expired": "פג תוקף האימות. התחילו מחדש.",
    "field_required": "שדה חובה.",
    "field_invalid": "ערך לא תקין.",
    "terms_required": "יש לאשר את תנאי המועדון ומדיניות הפרטיות.",
    "terms_version_stale": "התנאים עודכנו. רעננו את הדף ואשרו מחדש.",
    "unsubscribe_invalid": "הקישור אינו תקף.",
}


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    value = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _uuid(value: Any) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise error("not_found", 404) from None


def _public_error(code: str, status: int, *, retry_after: Optional[int] = None, **extra: Any):
    exc = error(code, status, PUBLIC_MESSAGES.get(code), retryable=status in (429, 503), **extra)
    if retry_after:
        exc.detail["retryAfterSeconds"] = retry_after
        exc.headers = {"Retry-After": str(retry_after)}
    return exc


def _throttle(request: Request, key: str, max_calls: int) -> None:
    """The in-process per-IP limit, answered in the structured public error shape."""
    try:
        check_rate_limit(request, key, max_calls, 60)
    except HTTPException:
        raise _public_error("too_many_requests", 429, retry_after=60) from None


def _client_ip(request: Request) -> Optional[str]:
    # Fly's edge sets Fly-Client-IP; elsewhere the socket peer (X-Forwarded-For is spoofable).
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else None)


def join_url(token: str) -> str:
    settings = get_settings()
    base = (settings.club_join_base_url or "").strip().rstrip("/")
    if not base:
        base = settings.pairing_mobile_app_base_url.rstrip("/") + "/join"
    return f"{base}/{token}"


# ── Dashboard ────────────────────────────────────────────────────────────────


def _club_of(db: Session, company_id: Any) -> Optional[ClubProgram]:
    return db.query(ClubProgram).filter(ClubProgram.company_id == company_id).first()


def _landing_out(landing: Optional[ClubLandingPage]) -> Optional[Dict[str, Any]]:
    if landing is None:
        return None
    return {
        "isPublished": bool(landing.is_published),
        "businessName": landing.business_name,
        "logoUrl": landing.logo_url,
        "headline": landing.headline,
        "intro": landing.intro,
        "benefits": list(landing.benefits or []),
        "emailEnabled": bool(landing.email_enabled),
        "birthdayEnabled": bool(landing.birthday_enabled),
        "lastNameEnabled": bool(landing.last_name_enabled),
        "signupBenefitEnabled": bool(landing.signup_benefit_enabled),
        "signupBenefitTitle": landing.signup_benefit_title,
        "signupBenefitValidDays": landing.signup_benefit_valid_days,
        "successMessage": landing.success_message,
        "updatedAt": _iso(landing.updated_at),
    }


def _doc_out(d: ClubDocumentVersion) -> Dict[str, Any]:
    return {
        "id": str(d.id),
        "kind": d.kind,
        "version": d.version,
        "status": d.status,
        "title": d.title,
        "body": d.body,
        "url": d.url,
        "publishedAt": _iso(d.published_at),
        "createdAt": _iso(d.created_at),
    }


def _source_out(db: Session, s: ClubSourceToken) -> Dict[str, Any]:
    shop = db.get(Shop, s.shop_id) if s.shop_id else None
    return {
        "id": str(s.id),
        "token": s.token,
        "url": join_url(s.token),
        "label": s.label,
        "sourceKind": s.source_kind,
        "shopId": str(s.shop_id) if s.shop_id else None,
        "shopName": shop.name if shop is not None else None,
        "isActive": bool(s.is_active),
        "createdAt": _iso(s.created_at),
        "signups": db.query(func.count(ClubMembership.id)).filter(ClubMembership.source_token_id == s.id).scalar() or 0,
    }


@router.get("/club")
def get_club(
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    company = resolve_company(db, user, tenant_id, company_id)
    club = _club_of(db, company.id)
    if club is None:
        return {"club": None, "companyName": company.name}
    landing = db.query(ClubLandingPage).filter(ClubLandingPage.club_id == club.id).first()
    docs = (
        db.query(ClubDocumentVersion)
        .filter(ClubDocumentVersion.club_id == club.id)
        .order_by(ClubDocumentVersion.kind, ClubDocumentVersion.version.desc())
        .all()
    )
    sources = (
        db.query(ClubSourceToken)
        .filter(ClubSourceToken.club_id == club.id)
        .order_by(ClubSourceToken.created_at.desc())
        .all()
    )
    members = db.query(ClubMembership.status, func.count(ClubMembership.id)).filter(
        ClubMembership.club_id == club.id
    ).group_by(ClubMembership.status).all()
    return {
        "companyName": company.name,
        "club": {"id": str(club.id), "name": club.name, "isActive": bool(club.is_active)},
        "landing": _landing_out(landing),
        "documents": [_doc_out(d) for d in docs],
        "sources": [_source_out(db, s) for s in sources],
        "counts": {status: count for status, count in members},
    }


@router.put("/club")
def put_club(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    company = resolve_company(db, user, tenant_id, company_id)
    club = _club_of(db, company.id)
    name = str(body.get("name") or "").strip()[:120]
    if club is None:
        club = ClubProgram(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, name=name or company.name, is_active=True
        )
        db.add(club)
        db.flush()
        db.add(
            ClubLandingPage(
                id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, club_id=club.id, is_published=False,
                business_name=company.name, headline="מצטרפים למועדון", benefits=[], updated_by=user.id,
            )
        )
    else:
        if name:
            club.name = name
        if "isActive" in body:
            club.is_active = bool(body["isActive"])
    audit(db, tenant_id=tenant_id, company_id=company.id, domain="club", subject_type="club", subject_id=club.id,
          action="club_updated", actor_user_id=user.id)
    db.commit()
    return get_club(company_id=str(company.id), user=user, tenant_id=tenant_id, db=db)


def _require_club(db: Session, user: User, tenant_id: Any, company_id: Any) -> ClubProgram:
    company = resolve_company(db, user, tenant_id, company_id)
    club = _club_of(db, company.id)
    if club is None:
        raise error("club_not_found", 404)
    return club


@router.put("/club/landing")
def put_landing(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    club = _require_club(db, user, tenant_id, company_id)
    landing = db.query(ClubLandingPage).filter(ClubLandingPage.club_id == club.id).first()
    for key, attr, cap in (
        ("businessName", "business_name", 120), ("logoUrl", "logo_url", 500), ("headline", "headline", 120),
        ("intro", "intro", 500), ("signupBenefitTitle", "signup_benefit_title", 120),
        ("successMessage", "success_message", 300),
    ):
        if key in body:
            value = str(body.get(key) or "").strip()[:cap]
            if key == "logoUrl" and value and not value.startswith("https://"):
                raise error("logo_url_invalid", 422)
            setattr(landing, attr, value or None)
    for key, attr in (
        ("emailEnabled", "email_enabled"), ("birthdayEnabled", "birthday_enabled"),
        ("lastNameEnabled", "last_name_enabled"), ("signupBenefitEnabled", "signup_benefit_enabled"),
    ):
        if key in body:
            setattr(landing, attr, bool(body[key]))
    if "benefits" in body:
        raw = body.get("benefits")
        if not isinstance(raw, list):
            raise error("benefits_invalid", 422)
        landing.benefits = [str(b).strip()[:120] for b in raw if str(b).strip()][:8]
    if "signupBenefitValidDays" in body:
        days = body.get("signupBenefitValidDays")
        if days in (None, ""):
            landing.signup_benefit_valid_days = None
        else:
            try:
                landing.signup_benefit_valid_days = max(1, min(3650, int(days)))
            except (TypeError, ValueError):
                raise error("signupBenefitValidDays_invalid", 422) from None
    if landing.signup_benefit_enabled and not landing.signup_benefit_title:
        raise error("signup_benefit_title_required", 422)
    if "isPublished" in body:
        publish = bool(body["isPublished"])
        if publish:
            docs = REG.active_documents(db, club.id)
            if "terms" not in docs or "privacy" not in docs:
                raise error("documents_missing", 409, "יש לפרסם תנאי מועדון ומדיניות פרטיות לפני פרסום הדף")
        landing.is_published = publish
    landing.updated_by = user.id
    audit(db, tenant_id=tenant_id, company_id=club.company_id, domain="club", subject_type="club", subject_id=club.id,
          action="landing_updated", actor_user_id=user.id)
    db.commit()
    return _landing_out(landing)


@router.post("/club/documents", status_code=201)
def create_document(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    club = _require_club(db, user, tenant_id, company_id)
    kind = str(body.get("kind") or "")
    if kind not in DOC_KINDS:
        raise error("kind_invalid", 422)
    title = str(body.get("title") or "").strip()[:200]
    text = str(body.get("body") or "").strip()
    url = str(body.get("url") or "").strip()[:500] or None
    if not title or not text:
        raise error("document_text_required", 422)
    if len(text) > 20000:
        raise error("document_too_long", 422)
    if url and not url.startswith("https://"):
        raise error("document_url_invalid", 422)
    last = (
        db.query(func.max(ClubDocumentVersion.version))
        .filter(ClubDocumentVersion.club_id == club.id, ClubDocumentVersion.kind == kind)
        .scalar()
    )
    doc = ClubDocumentVersion(
        id=uuid.uuid4(), tenant_id=tenant_id, club_id=club.id, kind=kind, version=(last or 0) + 1, status="draft",
        title=title, body=text, url=url, created_by=user.id,
    )
    db.add(doc)
    db.commit()
    return _doc_out(doc)


@router.post("/club/documents/{document_id}/publish")
def publish_document(
    document_id: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The version becomes the one shown and consented to; the previous one is archived (kept)."""
    require_role(user, CLUB_ADMIN_ROLES)
    doc = db.get(ClubDocumentVersion, _uuid(document_id))
    if doc is None or doc.tenant_id != tenant_id:
        raise error("not_found", 404)
    club = db.get(ClubProgram, doc.club_id)
    resolve_company(db, user, tenant_id, club.company_id)
    if doc.status != "draft":
        raise error("document_not_draft", 409)
    for other in db.query(ClubDocumentVersion).filter(
        ClubDocumentVersion.club_id == doc.club_id, ClubDocumentVersion.kind == doc.kind,
        ClubDocumentVersion.status == "active",
    ):
        other.status = "archived"
    doc.status = "active"
    doc.published_at = datetime.now(timezone.utc)
    audit(db, tenant_id=tenant_id, company_id=club.company_id, domain="club", subject_type="document",
          subject_id=doc.id, action="document_published", actor_user_id=user.id,
          details={"kind": doc.kind, "version": doc.version})
    db.commit()
    return _doc_out(doc)


@router.post("/club/sources", status_code=201)
def create_source(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    club = _require_club(db, user, tenant_id, company_id)
    kind = str(body.get("sourceKind") or "link")
    if kind not in ("receipt", "till", "kiosk", "poster", "link"):
        raise error("source_kind_invalid", 422)
    shop_id = None
    if body.get("shopId"):
        shop = db.get(Shop, _uuid(body["shopId"]))
        if shop is None or shop.tenant_id != tenant_id:
            raise error("shop_not_found", 404)
        resolve_company(db, user, tenant_id, shop.company_id)
        shop_id = shop.id
    source = ClubSourceToken(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=club.company_id, club_id=club.id,
        token=random_token(18), shop_id=shop_id, source_kind=kind,
        label=(str(body.get("label") or "").strip()[:120] or None), is_active=True, created_by=user.id,
    )
    db.add(source)
    db.commit()
    return _source_out(db, source)


@router.post("/club/sources/{source_id}/deactivate")
def deactivate_source(
    source_id: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    source = db.get(ClubSourceToken, _uuid(source_id))
    if source is None or source.tenant_id != tenant_id:
        raise error("not_found", 404)
    resolve_company(db, user, tenant_id, source.company_id)
    source.is_active = False
    db.commit()
    return _source_out(db, source)


def _member_row(m: ClubMembership, c: ClubCustomer, shop_names: Optional[Dict[Any, str]] = None) -> Dict[str, Any]:
    return {
        "membershipId": str(m.id),
        "customerId": str(c.id),
        "memberNumber": m.member_number,
        "firstName": c.first_name,
        "lastName": c.last_name,
        "phone": c.phone_masked,
        "phoneVerifiedAt": _iso(c.phone_verified_at),
        "status": m.status,
        "joinedAt": _iso(m.joined_at),
        "sourceShopId": str(m.source_shop_id) if m.source_shop_id else None,
        "sourceShopName": (shop_names or {}).get(m.source_shop_id),
    }


def _shop_names(db: Session, ids) -> Dict[Any, str]:
    wanted = {i for i in ids if i}
    if not wanted:
        return {}
    return {sid: name for sid, name in db.query(Shop.id, Shop.name).filter(Shop.id.in_(wanted)).all()}


@router.get("/club/members")
def list_members(
    company_id: str = Query(..., alias="companyId"),
    q: Optional[str] = Query(None, max_length=60),
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Phones masked. `q`: a member number, a full phone number (exact) or a first-name prefix."""
    require_role(user, CLUB_ADMIN_ROLES)
    club = _require_club(db, user, tenant_id, company_id)
    query = (
        db.query(ClubMembership, ClubCustomer)
        .join(ClubCustomer, ClubCustomer.id == ClubMembership.customer_id)
        .filter(ClubMembership.club_id == club.id)
    )
    if status:
        query = query.filter(ClubMembership.status == status)
    if q:
        text = q.strip()
        if text.isdigit() and len(text) <= 7:
            query = query.filter(ClubMembership.member_number == int(text))
        else:
            try:
                query = query.filter(ClubCustomer.phone_hash == phone_hash(normalize_phone(text)))
            except PhoneError:
                query = query.filter(ClubCustomer.first_name.ilike(f"{text}%"))
    total = query.count()
    rows = query.order_by(ClubMembership.created_at.desc()).offset(offset).limit(limit).all()
    names = _shop_names(db, [m.source_shop_id for m, _c in rows])
    return {"items": [_member_row(m, c, names) for m, c in rows], "total": total}


def _own_member(db: Session, user: User, tenant_id: Any, membership_id: Any):
    m = db.get(ClubMembership, _uuid(membership_id))
    if m is None or m.tenant_id != tenant_id:
        raise error("not_found", 404)
    resolve_company(db, user, tenant_id, m.company_id)
    return m, db.get(ClubCustomer, m.customer_id)


@router.get("/club/members/{membership_id}")
def member_detail(
    membership_id: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    m, c = _own_member(db, user, tenant_id, membership_id)
    out = _member_row(m, c, _shop_names(db, [m.source_shop_id]))
    out["email"] = c.email
    out["birthday"] = f"{c.birth_day}/{c.birth_month}" if c.birth_day and c.birth_month else None
    consents = (
        db.query(ClubConsentEvent)
        .filter(ClubConsentEvent.customer_id == c.id)
        .order_by(ClubConsentEvent.occurred_at.desc())
        .all()
    )
    current: Dict[str, Any] = {}
    for e in consents:
        current.setdefault(e.kind, {"granted": e.granted, "version": e.document_version, "at": _iso(e.occurred_at)})
    out["consents"] = current
    out["consentHistory"] = [
        {"kind": e.kind, "granted": e.granted, "version": e.document_version, "source": e.source,
         "at": _iso(e.occurred_at)}
        for e in consents[:50]
    ]
    out["benefits"] = [
        {"id": str(g.id), "title": g.title, "status": g.status, "kind": g.kind, "validUntil": _iso(g.valid_until)}
        for g in db.query(ClubBenefitGrant).filter(ClubBenefitGrant.membership_id == m.id).all()
    ]
    audit_rows = (
        db.query(ClubAuditEvent)
        .filter(ClubAuditEvent.subject_id == m.id)
        .order_by(ClubAuditEvent.created_at.desc())
        .limit(30)
        .all()
    )
    user_names = {
        uid: name for uid, name in db.query(User.id, User.username).filter(
            User.id.in_({a.actor_user_id for a in audit_rows if a.actor_user_id} or {uuid.uuid4()})
        ).all()
    }
    machine_names = {
        mid: name for mid, name in db.query(POSMachine.id, POSMachine.name).filter(
            POSMachine.id.in_({a.actor_machine_id for a in audit_rows if a.actor_machine_id} or {uuid.uuid4()})
        ).all()
    }
    out["audit"] = [
        {"action": a.action, "at": _iso(a.created_at), "byUser": str(a.actor_user_id) if a.actor_user_id else None,
         "byUserName": user_names.get(a.actor_user_id),
         "byMachine": str(a.actor_machine_id) if a.actor_machine_id else None,
         "byMachineName": machine_names.get(a.actor_machine_id), "reason": a.reason}
        for a in audit_rows
    ]
    out["marketingSuppressed"] = (
        db.query(ClubSuppression.id)
        .filter(ClubSuppression.tenant_id == tenant_id, ClubSuppression.phone_hash == c.phone_hash,
                ClubSuppression.lifted_at.is_(None))
        .first()
        is not None
    )
    return out


@router.post("/club/members/{membership_id}/reveal-phone")
def reveal_member_phone(
    membership_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    reason = str(body.get("reason") or "").strip()
    if not reason:
        raise error("reason_required", 422)
    m, c = _own_member(db, user, tenant_id, membership_id)
    audit(db, tenant_id=tenant_id, company_id=m.company_id, domain="club", subject_type="membership",
          subject_id=m.id, action="phone_revealed", actor_user_id=user.id, reason=reason)
    db.commit()
    return {"phone": decrypt_text(c.phone_ciphertext)}


@router.post("/club/members/{membership_id}/status")
def set_member_status(
    membership_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    target = str(body.get("status") or "")
    reason = str(body.get("reason") or "").strip()
    if target not in (MEMBERSHIP_ACTIVE, MEMBERSHIP_SUSPENDED, MEMBERSHIP_CLOSED):
        raise error("status_invalid", 422)
    if not reason:
        raise error("reason_required", 422)
    m, c = _own_member(db, user, tenant_id, membership_id)
    if m.status == MEMBERSHIP_CLOSED and target != MEMBERSHIP_CLOSED:
        raise error("membership_closed", 409)
    before = m.status
    m.status = target
    m.status_reason = reason[:200]
    m.status_changed_at = datetime.now(timezone.utc)
    audit(db, tenant_id=tenant_id, company_id=m.company_id, domain="club", subject_type="membership",
          subject_id=m.id, action="status_changed", actor_user_id=user.id, reason=reason,
          details={"from": before, "to": target})
    db.commit()
    return _member_row(m, c)


# ── Till ─────────────────────────────────────────────────────────────────────


@till_router.get("/sync/{machine_id}/club/lookup")
def till_member_lookup(
    machine_id: str,
    phone: Optional[str] = Query(None, max_length=30),
    qr: Optional[str] = Query(None, max_length=300),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The member for this sale — minimal (name, status, number, benefits). Audited."""
    check_rate_limit_by_key(f"club-lookup:{machine.id}", 30, 60)
    try:
        out = LK.lookup(db, machine, phone=phone, qr=qr)
    except LK.LookupError_ as exc:
        raise error(exc.code, exc.status) from None
    db.commit()
    return out


# ── Public ───────────────────────────────────────────────────────────────────


def _ctx(db: Session, token: str) -> PUB.PublicContext:
    try:
        return PUB.resolve(db, token)
    except PUB.PageUnavailable:
        raise _public_error("page_unavailable", 404) from None


@public_router.get("/public/club/unsubscribe/{token}")
def unsubscribe_info(token: str, request: Request, db: Session = Depends(get_db)):
    _throttle(request, "club-unsub", 30)
    m = db.query(ClubMembership).filter(ClubMembership.unsubscribe_token == str(token)[:64]).first()
    if m is None:
        raise _public_error("unsubscribe_invalid", 404)
    club = db.get(ClubProgram, m.club_id)
    return {"clubName": club.name if club else None}


@public_router.post("/public/club/unsubscribe/{token}")
def unsubscribe(token: str, request: Request, db: Session = Depends(get_db)):
    """Marketing SMS opt-out — immediate, no password / OTP (§29). Service messages unaffected."""
    _throttle(request, "club-unsub", 30)
    m = db.query(ClubMembership).filter(ClubMembership.unsubscribe_token == str(token)[:64]).first()
    if m is None:
        raise _public_error("unsubscribe_invalid", 404)
    c = db.get(ClubCustomer, m.customer_id)
    now = datetime.now(timezone.utc)
    db.add(ClubConsentEvent(
        id=uuid.uuid4(), tenant_id=m.tenant_id, company_id=m.company_id, customer_id=c.id, membership_id=m.id,
        kind="marketing_sms", granted=False, source="unsubscribe_link", occurred_at=now,
    ))
    exists = (
        db.query(ClubSuppression.id)
        .filter(ClubSuppression.tenant_id == m.tenant_id, ClubSuppression.phone_hash == c.phone_hash,
                ClubSuppression.reason == "unsubscribe", ClubSuppression.lifted_at.is_(None))
        .first()
    )
    if exists is None:
        db.add(ClubSuppression(
            id=uuid.uuid4(), tenant_id=m.tenant_id, company_id=m.company_id, phone_hash=c.phone_hash,
            channel="sms", scope="marketing", reason="unsubscribe", source="link", created_at=now,
        ))
    audit(db, tenant_id=m.tenant_id, company_id=m.company_id, domain="club", subject_type="membership",
          subject_id=m.id, action="unsubscribed")
    db.commit()
    return {"ok": True}


@public_router.get("/public/club/{token}")
def public_page(token: str, request: Request, db: Session = Depends(get_db)):
    _throttle(request, "club-page", 60)
    ctx = _ctx(db, token)
    return PUB.page_config(db, ctx)


def _otp_call(db: Session, fn, *, keep_changes: bool = False):
    try:
        return fn()
    except OTP.OtpError as exc:
        if keep_changes:
            # verify: the counted attempt, a lock or an expiry stand even when the answer is an error.
            db.commit()
        else:
            # start / resend: nothing half-done (no challenge whose code never went out).
            db.rollback()
        raise _public_error(exc.code, exc.status, retry_after=exc.retry_after, **exc.extra) from None


@public_router.post("/public/club/{token}/otp/start")
def public_otp_start(
    token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    body: Dict[str, Any] = Body(...),
    db: Session = Depends(get_db),
):
    """Always the same answer shape — it never says whether the number is a member."""
    _throttle(request, "club-otp-start", 10)
    ctx = _ctx(db, token)
    started = _otp_call(db, lambda: OTP.start(
        db, club=ctx.club, source=ctx.source, phone_raw=body.get("phone"),
        client_session=body.get("clientSession"), ip=_client_ip(request), brand=PUB.brand_of(db, ctx),
    ))
    db.commit()
    background_tasks.add_task(W.process_now, SessionLocal, started.notification_id)
    return {
        "challengeId": str(started.challenge.id),
        "clientSession": started.client_session,
        "expiresInSeconds": int(OTP.CODE_TTL.total_seconds()),
        "resendAfterSeconds": int(OTP.RESEND_GAP.total_seconds()),
        "sendsLeft": max(0, OTP.MAX_SENDS - started.challenge.send_count),
    }


@public_router.post("/public/club/{token}/otp/resend")
def public_otp_resend(
    token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    body: Dict[str, Any] = Body(...),
    db: Session = Depends(get_db),
):
    _throttle(request, "club-otp-resend", 10)
    ctx = _ctx(db, token)
    challenge = _otp_call(db, lambda: OTP.resend(
        db, club=ctx.club, challenge_id=body.get("challengeId"), client_session=body.get("clientSession"),
        brand=PUB.brand_of(db, ctx),
    ))
    db.commit()
    background_tasks.add_task(W.process_now, SessionLocal, challenge.notification_id)
    return {
        "challengeId": str(challenge.id),
        "expiresInSeconds": int(OTP.CODE_TTL.total_seconds()),
        "resendAfterSeconds": int(OTP.RESEND_GAP.total_seconds()),
        "sendsLeft": max(0, OTP.MAX_SENDS - challenge.send_count),
    }


@public_router.post("/public/club/{token}/otp/verify")
def public_otp_verify(token: str, request: Request, body: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    _throttle(request, "club-otp-verify", 20)
    ctx = _ctx(db, token)
    registration_token = _otp_call(db, lambda: OTP.verify(
        db, club=ctx.club, challenge_id=body.get("challengeId"), client_session=body.get("clientSession"),
        code=body.get("code"),
    ), keep_changes=True)
    db.commit()
    return {"registrationToken": registration_token, "expiresInSeconds": int(OTP.REGISTRATION_TTL.total_seconds())}


@public_router.post("/public/club/{token}/register")
def public_register(token: str, request: Request, body: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    _throttle(request, "club-register", 10)
    ctx = _ctx(db, token)
    try:
        out = REG.register(
            db, club=ctx.club, landing=ctx.landing, source=ctx.source, challenge_id=body.get("challengeId"),
            client_session=body.get("clientSession"), registration_token=body.get("registrationToken"),
            form=body, ip=_client_ip(request),
        )
    except REG.RegistrationError as exc:
        db.rollback()
        raise _public_error(exc.code, exc.status, field=exc.field) from None
    except OTP.OtpError as exc:
        db.rollback()
        raise _public_error(exc.code, exc.status) from None
    db.commit()
    return out
