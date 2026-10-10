"""
The public landing page's view of a club (§23, §25): resolved from the opaque source
token in the QR — never from a company id the browser sends. Only what the page needs:
names, wording, the active document versions, which fields to ask. A token that is
unknown, switched off or expired, an inactive club, an unpublished page or a club without
active terms + privacy all look the same from outside: `page_unavailable`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.club import (
    DOC_MARKETING_EMAIL,
    DOC_MARKETING_SMS,
    DOC_PRIVACY,
    DOC_TERMS,
    ClubLandingPage,
    ClubProgram,
    ClubSourceToken,
)
from app.models.company import Company
from app.models.shop import Shop
from app.services.club import otp as OTP
from app.services.club.registration import active_documents


class PageUnavailable(Exception):
    pass


@dataclass
class PublicContext:
    source: ClubSourceToken
    club: ClubProgram
    landing: ClubLandingPage


def resolve(db: Session, token: Any, now: Optional[datetime] = None) -> PublicContext:
    now = now or datetime.now(timezone.utc)
    text = str(token or "").strip()
    if not (8 <= len(text) <= 64) or not text.replace("-", "").replace("_", "").isalnum():
        raise PageUnavailable()
    source = db.query(ClubSourceToken).filter(ClubSourceToken.token == text).first()
    if source is None or not source.is_active:
        raise PageUnavailable()
    if source.expires_at is not None:
        expires = source.expires_at if source.expires_at.tzinfo else source.expires_at.replace(tzinfo=timezone.utc)
        if now >= expires:
            raise PageUnavailable()
    club = db.get(ClubProgram, source.club_id)
    if club is None or not club.is_active or club.tenant_id != source.tenant_id:
        raise PageUnavailable()
    landing = db.query(ClubLandingPage).filter(ClubLandingPage.club_id == club.id).first()
    if landing is None or not landing.is_published:
        raise PageUnavailable()
    docs = active_documents(db, club.id)
    if DOC_TERMS not in docs or DOC_PRIVACY not in docs:
        raise PageUnavailable()
    return PublicContext(source, club, landing)


def brand_of(db: Session, ctx: PublicContext) -> str:
    if ctx.landing.business_name:
        return ctx.landing.business_name
    company = db.get(Company, ctx.club.company_id)
    return (company.name if company is not None else None) or ctx.club.name


def page_config(db: Session, ctx: PublicContext) -> Dict[str, Any]:
    docs = active_documents(db, ctx.club.id)
    landing = ctx.landing

    def doc(kind: str) -> Optional[Dict[str, Any]]:
        row = docs.get(kind)
        if row is None:
            return None
        return {"id": str(row.id), "version": row.version, "title": row.title, "body": row.body, "url": row.url}

    shop_name = None
    if ctx.source.shop_id:
        shop = db.get(Shop, ctx.source.shop_id)
        shop_name = shop.name if shop is not None else None
    return {
        "businessName": brand_of(db, ctx),
        "clubName": ctx.club.name,
        "logoUrl": landing.logo_url,
        "headline": landing.headline or "מצטרפים למועדון",
        "intro": landing.intro,
        # Only the business's own wording; nothing is invented when it is empty.
        "benefits": [str(b)[:120] for b in (landing.benefits or []) if str(b).strip()][:8],
        "shopName": shop_name,
        "fields": {
            "lastName": bool(landing.last_name_enabled),
            "email": bool(landing.email_enabled),
            "birthday": bool(landing.birthday_enabled),
        },
        "documents": {
            "terms": doc(DOC_TERMS),
            "privacy": doc(DOC_PRIVACY),
            "marketingSms": doc(DOC_MARKETING_SMS),
            "marketingEmail": doc(DOC_MARKETING_EMAIL) if landing.email_enabled else None,
        },
        "signupBenefit": (
            {"title": landing.signup_benefit_title}
            if landing.signup_benefit_enabled and landing.signup_benefit_title
            else None
        ),
        "successMessage": landing.success_message,
        "otp": {
            "codeLength": OTP.CODE_DIGITS,
            "expiresInSeconds": int(OTP.CODE_TTL.total_seconds()),
            "resendAfterSeconds": int(OTP.RESEND_GAP.total_seconds()),
            "maxAttempts": OTP.MAX_ATTEMPTS,
        },
    }
