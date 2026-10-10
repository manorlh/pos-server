"""
"כרטיסי ביקור דיגיטליים" — digital business cards (spec §25–28, acceptance 23–24).

A card is a branded public page at `/c/<slug>` for a company, a branch (shop), a sales point
(shop area) or a person. It is independent of the menu and ordering design: publishing a card
never publishes a menu, and a card's menu / ordering buttons only link to profiles that exist.

* Document: client/src/lib/businessCards.ts `CardDoc` (fields with inherit / local / hidden and
  public / private, sections, fixed action types, design, enquiry form). The server keeps the
  draft (autosaved, optimistic `draft_version`) and immutable revisions; publication points the
  card at a revision. The public page shows only the published revision.
* Resolution: app/services/business_card_resolve.py (the editor's preview runs the TypeScript
  twin on the draft; one golden fixture pins both).
* Inheritance: company → branch → point (a person under either). A child reads its parent's
  *published* public values only; an unpublished or archived parent passes its own parent's
  values through. The organisation's records (names, address, brand logo, the club's active
  privacy policy) fill what no card supplies. Every effective value carries its source.
* Slugs: renaming keeps the old path as a redirect, and an old path is never given to another
  card. QR codes encode the live path.
* Enquiries: stored in `card_enquiries` (no CRM exists — "internal" delivery). The
  public answer says "saved" only after the commit. Validation, per-IP and per-card limits and
  dedupe run here, server-side.
* Measurement: first-party, cookie-free daily counters. A click on "Call" is a click, not a call.

Permissions: dashboard section `business_cards` (view / edit, app/services/dashboard_sections.py)
plus the organisation scope of the card's target (the kiosk roles' rules, kiosk_control).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.business_card import (
    BusinessCard,
    BusinessCardAuditEvent,
    BusinessCardDailyStat,
    BusinessCardEnquiry,
    BusinessCardRevision,
    BusinessCardSlug,
)
from app.models.club import ClubDocumentVersion, ClubProgram
from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.services import business_card_resolve as R
from app.services.company_hierarchy import company_scope_ids, visible_shop_ids
from app.services.kiosk_control import KIOSK_ROLES, check_company_scope, check_shop_scope

CARD_ROLES = KIOSK_ROLES
MAX_DOC_BYTES = 200_000
DEFAULT_TZ = "Asia/Jerusalem"

# Enquiry limits (durable, from the stored rows; the router adds an in-process per-IP limit).
ENQUIRY_PER_IP_10MIN = 3
ENQUIRY_PER_IP_DAY = 10
ENQUIRY_PER_CARD_HOUR = 60
ENQUIRY_DEDUPE_WINDOW = timedelta(hours=24)
ENQUIRY_MESSAGE_MAX = 2000

STAT_METRICS = ("view", "action", "share", "copy_link", "vcf", "enquiry")
#: What a visitor's browser may report (vcf and enquiry are counted by the server itself).
CLIENT_METRICS = ("view", "action", "share", "copy_link")

MESSAGES = {
    "card_not_found": "הכרטיס לא נמצא.",
    "forbidden": "אין הרשאה לכרטיס הזה.",
    "target_invalid": "יעד הכרטיס אינו תקין.",
    "type_invalid": "סוג כרטיס לא מוכר.",
    "template_invalid": "תבנית לא מוכרת.",
    "name_required": "יש לתת לכרטיס שם פנימי.",
    "parent_invalid": "הכרטיס שממנו יורשים אינו מתאים ליעד הזה.",
    "owner_invalid": "המשתמש שנבחר אינו בארגון.",
    "slug_invalid": "כתובת לא תקינה: 3–60 אותיות לטיניות קטנות, ספרות ומקפים.",
    "slug_taken": "הכתובת הזו תפוסה (או שימשה כרטיס אחר בעבר).",
    "draft_conflict": "מישהו אחר שמר שינויים בכרטיס בינתיים. טענו את הגרסה העדכנית לפני שממשיכים.",
    "draft_too_large": "הכרטיס גדול מדי.",
    "draft_invalid": "מבנה הכרטיס אינו תקין.",
    "publish_blocked": "לא ניתן לפרסם: יש לתקן את השגיאות.",
    "archived": "הכרטיס בארכיון. יש לשחזר אותו קודם.",
    "not_published": "הכרטיס עוד לא פורסם.",
    "state_invalid": "הפעולה אינה אפשרית במצב הנוכחי של הכרטיס.",
    "revision_not_found": "הגרסה לא נמצאה.",
    "enquiry_not_found": "הפנייה לא נמצאה.",
}


def error(code: str, http_status: int, message: Optional[str] = None, **extra: Any) -> HTTPException:
    return HTTPException(status_code=http_status, detail={"code": code, "message": message or MESSAGES.get(code, code), **extra})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def canonical(doc: Any) -> str:
    return json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def content_hash(doc: Any) -> str:
    return hashlib.sha256(canonical(doc).encode("utf-8")).hexdigest()


def business_today(db: Session, tenant_id) -> str:
    """The business-local date (YYYY-MM-DD) expiries are judged by — Israel unless set."""
    tz_name = DEFAULT_TZ
    tenant = db.get(Tenant, tenant_id) if tenant_id else None
    if tenant is not None and tenant.timezone and tenant.timezone != "UTC":
        tz_name = tenant.timezone
    try:
        tz = ZoneInfo(tz_name)
    except Exception:  # noqa: BLE001 - an unknown zone name falls back to Israel
        tz = ZoneInfo(DEFAULT_TZ)
    return _now().astimezone(tz).date().isoformat()


# ── Document normalisation (the server is the authority on structure) ────────

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _s(value: Any, max_len: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return _CONTROL.sub("", value)[:max_len]


def _text(value: Any, max_len: int) -> Optional[Dict[str, str]]:
    if not isinstance(value, dict):
        return None
    out = {}
    for lang in R.CARD_LANGS:
        s = _s(value.get(lang), max_len)
        if s is not None and s != "":
            out[lang] = s
    return out or None


def _int_or_none(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def normalize_value(key: str, raw: Any) -> Any:
    """Keep what the editor typed (an invalid phone stays visible to fix), within limits."""
    if raw is None:
        return None
    spec = R.FIELD_SPECS[key]
    kind = spec["kind"]
    if kind == "text":
        return _text(raw, spec.get("max", 600))
    if kind == "image":
        if not isinstance(raw, dict):
            return None
        url = _s(raw.get("url"), R.MAX_URL)
        if not url:
            return None
        out: Dict[str, Any] = {"url": url}
        alt = _text(raw.get("alt"), 200)
        if alt:
            out["alt"] = alt
        return out
    if kind == "phone":
        return _s(raw, 30)
    if kind == "email":
        return _s(raw, 254)
    if kind == "url":
        return _s(raw, R.MAX_URL)
    if kind == "navigation":
        return _s(raw, spec.get("max", 200))
    if kind == "hours":
        if not isinstance(raw, dict):
            return None
        rows = []
        for r in raw.get("rows") if isinstance(raw.get("rows"), list) else []:
            if not isinstance(r, dict):
                continue
            days = [d for d in (r.get("days") if isinstance(r.get("days"), list) else []) if _int_or_none(d) is not None and 0 <= d <= 6]
            rows.append({"days": sorted(set(days)), "open": _s(r.get("open"), 5) or "", "close": _s(r.get("close"), 5) or ""})
        return {"rows": rows[:14], "note": _text(raw.get("note"), 200)}
    if kind == "services":
        if not isinstance(raw, list):
            return None
        return [
            {"title": _text(it.get("title"), 120), "description": _text(it.get("description"), 300)}
            for it in raw[:24] if isinstance(it, dict)
        ]
    if kind == "social":
        if not isinstance(raw, list):
            return None
        return [
            {"platform": it.get("platform") if it.get("platform") in R.SOCIAL_PLATFORMS else "other", "url": _s(it.get("url"), R.MAX_URL) or ""}
            for it in raw[:12] if isinstance(it, dict)
        ]
    if kind == "files":
        if not isinstance(raw, list):
            return None
        return [
            {"title": _text(it.get("title"), 120), "url": _s(it.get("url"), R.MAX_URL) or "", "bytes": _int_or_none(it.get("bytes"))}
            for it in raw[:12] if isinstance(it, dict)
        ]
    if kind == "announcement":
        if not isinstance(raw, dict):
            return None
        return {"title": _text(raw.get("title"), 120), "body": _text(raw.get("body"), 600), "until": _s(raw.get("until"), 10)}
    if kind == "event":
        if not isinstance(raw, dict):
            return None
        return {
            "title": _text(raw.get("title"), 120),
            "venue": _text(raw.get("venue"), 200),
            "startsAt": _s(raw.get("startsAt"), 16),
            "endsAt": _s(raw.get("endsAt"), 16),
            "expiresAt": _s(raw.get("expiresAt"), 10),
        }
    if kind == "offer":
        if not isinstance(raw, dict):
            return None
        return {"title": _text(raw.get("title"), 120), "body": _text(raw.get("body"), 600), "validUntil": _s(raw.get("validUntil"), 10)}
    if kind == "support":
        if not isinstance(raw, dict):
            return None
        return {
            "phone": _s(raw.get("phone"), 30),
            "hours": _text(raw.get("hours"), 200),
            "note": _text(raw.get("note"), 300),
            "url": _s(raw.get("url"), R.MAX_URL),
        }
    return None


def normalize_doc(raw: Any, card_type: str) -> Dict[str, Any]:
    """A stored document: known keys only, every string bounded, no markup anywhere."""
    if not isinstance(raw, dict):
        raise error("draft_invalid", 422)
    if len(canonical(raw).encode("utf-8")) > MAX_DOC_BYTES:
        raise error("draft_too_large", 413)
    template = R.template_of(raw)
    fields_raw = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
    fields = {}
    for key in R.FIELD_KEYS:
        base = R.default_field(key, card_type)
        f = fields_raw.get(key) if isinstance(fields_raw.get(key), dict) else {}
        fields[key] = {
            "mode": f.get("mode") if f.get("mode") in R.FIELD_MODES else base["mode"],
            "visibility": f.get("visibility") if f.get("visibility") in R.FIELD_VISIBILITIES else base["visibility"],
            "value": normalize_value(key, f.get("value")),
        }
    actions = []
    for a in R.actions_of(raw):
        out = {"id": a["id"], "type": a["type"], "enabled": a["enabled"], "style": a["style"]}
        if a["label"]:
            out["label"] = a["label"]
        if a["type"] == "link":
            out["url"] = _s(a["url"], R.MAX_URL) or ""
            out["platform"] = a["platform"] or "other"
        if a["type"] == "file":
            out["fileUrl"] = _s(a["fileUrl"], R.MAX_URL) or ""
        if a["type"] == "whatsapp" and a["message"]:
            out["message"] = a["message"]
        if a["type"] == "navigate":
            out["navProvider"] = a["navProvider"]
        actions.append(out)
    enquiry = R.enquiry_of(raw)
    enq_out: Dict[str, Any] = {"mode": enquiry["mode"], "fields": enquiry["fields"], "topics": enquiry["topics"]}
    if enquiry["intro"]:
        enq_out["intro"] = enquiry["intro"]
    if enquiry["campaign"]:
        enq_out["campaign"] = enquiry["campaign"]
    seo = raw.get("seo") if isinstance(raw.get("seo"), dict) else {}
    return {
        "schema": 1,
        "languages": R.languages_of(raw),
        "template": template,
        "fields": fields,
        "sections": R.sections_of(raw, template),
        "actions": actions,
        "design": R.clean_design(raw.get("design"), template),
        "enquiry": enq_out,
        "seo": {"indexable": seo.get("indexable") is True},
        "expiresAt": raw.get("expiresAt") if R.is_ymd(raw.get("expiresAt")) else None,
    }


# ── Scope ─────────────────────────────────────────────────────────────────────


def require_role(user: User) -> None:
    if getattr(user, "role", None) not in CARD_ROLES:
        raise error("forbidden", 403)


def _check_target_scope(db: Session, user: User, tenant_id, card_type: str, company: Company, shop: Optional[Shop]) -> None:
    """The kiosk roles' org rules: company cards need the company; the rest their branch."""
    try:
        if card_type == "company" or shop is None:
            check_company_scope(db, user, company, tenant_id)
        else:
            check_shop_scope(db, user, shop, tenant_id)
    except HTTPException:
        raise error("forbidden", 403) from None


def resolve_target(db: Session, tenant_id, card_type: str, company_id, shop_id, area_id) -> Tuple[Company, Optional[Shop], Optional[ShopArea]]:
    """The organisation rows a card points at, checked for shape and tenant."""
    if card_type not in R.CARD_TYPES:
        raise error("type_invalid", 422)
    area = db.get(ShopArea, _uuid(area_id)) if _uuid(area_id) else None
    shop = db.get(Shop, _uuid(shop_id)) if _uuid(shop_id) else None
    if area is not None:
        if area.archived_at is not None or (shop is not None and shop.id != area.shop_id):
            raise error("target_invalid", 422)
        shop = shop or db.get(Shop, area.shop_id)
    company = db.get(Company, _uuid(company_id)) if _uuid(company_id) else None
    if shop is not None:
        if company is not None and company.id != shop.company_id:
            raise error("target_invalid", 422)
        company = company or db.get(Company, shop.company_id)
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise error("target_invalid", 422)
    if shop is not None and str(shop.tenant_id) != str(tenant_id):
        raise error("target_invalid", 422)
    if card_type == "company" and (shop is not None or area is not None):
        raise error("target_invalid", 422, "כרטיס חברה שייך לחברה בלבד (בלי סניף).")
    if card_type == "branch" and (shop is None or area is not None):
        raise error("target_invalid", 422, "כרטיס סניף צריך סניף (בלי נקודת מכירה).")
    if card_type == "point" and area is None:
        raise error("target_invalid", 422, "כרטיס נקודת מכירה צריך נקודת מכירה.")
    if card_type == "personal" and area is not None:
        raise error("target_invalid", 422, "כרטיס אישי שייך לחברה או לסניף.")
    return company, shop, area


def card_checked(db: Session, user: User, tenant_id, card_id) -> BusinessCard:
    require_role(user)
    card = db.get(BusinessCard, _uuid(card_id)) if _uuid(card_id) else None
    if card is None or str(card.tenant_id) != str(tenant_id):
        raise error("card_not_found", 404)
    company = db.get(Company, card.company_id)
    shop = db.get(Shop, card.shop_id) if card.shop_id else None
    _check_target_scope(db, user, tenant_id, card.card_type, company, shop)
    return card


def visible_cards_query(db: Session, user: User, tenant_id):
    require_role(user)
    q = db.query(BusinessCard).filter(BusinessCard.tenant_id == tenant_id)
    if user.role == UserRole.COMPANY_MANAGER:
        q = q.filter(
            BusinessCard.company_id.in_(company_scope_ids(db, user)),
            or_(
                BusinessCard.card_type == "company",
                BusinessCard.shop_id.is_(None),
                BusinessCard.shop_id.in_(visible_shop_ids(db, user)),
            ),
        )
    elif user.role == UserRole.SHOP_MANAGER:
        q = q.filter(BusinessCard.shop_id == user.shop_id)
    return q


# ── Audit ─────────────────────────────────────────────────────────────────────


def audit(db: Session, card: BusinessCard, user: Optional[User], action: str, revision_number: Optional[int] = None, **details: Any) -> None:
    db.add(BusinessCardAuditEvent(
        id=uuid.uuid4(),
        tenant_id=card.tenant_id,
        card_id=card.id,
        actor_user_id=getattr(user, "id", None),
        action=action,
        revision_number=revision_number,
        details=json.loads(canonical(details)) if details else {},
    ))


# ── Slugs ─────────────────────────────────────────────────────────────────────


def _slug_from_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    s = re.sub(r"-{2,}", "-", s)[:50].rstrip("-")
    return s if len(s) >= 3 and R.is_valid_slug(s) else ""


def _slug_free(db: Session, slug: str) -> bool:
    return db.get(BusinessCardSlug, slug) is None


def new_slug(db: Session, name: str) -> str:
    base = _slug_from_name(name)
    if base and _slug_free(db, base):
        return base
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    for _ in range(20):
        token = "".join(secrets.choice(alphabet) for _ in range(6))
        candidate = f"{base[:40]}-{token}" if base else f"card-{token}"
        if _slug_free(db, candidate):
            return candidate
    raise error("slug_taken", 409)  # pragma: no cover - 31^6 tokens


def rename_slug(db: Session, user: User, card: BusinessCard, slug: Any) -> BusinessCard:
    if not R.is_valid_slug(slug):
        raise error("slug_invalid", 422)
    if card.status == "archived":
        raise error("archived", 409)
    if slug == card.slug:
        return card
    now = _now()
    existing = db.get(BusinessCardSlug, slug)
    if existing is not None and existing.card_id != card.id:
        raise error("slug_taken", 409)
    current = db.get(BusinessCardSlug, card.slug)
    if current is not None:
        current.retired_at = now
    if existing is not None:
        existing.retired_at = None  # one of this card's own old paths, live again
    else:
        db.add(BusinessCardSlug(slug=slug, card_id=card.id, tenant_id=card.tenant_id))
    old = card.slug
    card.slug = slug
    audit(db, card, user, "slug", **{"from": old, "to": slug})
    return card


def slugs_of(db: Session, card: BusinessCard) -> List[Dict[str, Any]]:
    rows = db.query(BusinessCardSlug).filter(BusinessCardSlug.card_id == card.id).order_by(BusinessCardSlug.created_at).all()
    return [{"slug": r.slug, "live": r.retired_at is None, "createdAt": _iso(r.created_at), "retiredAt": _iso(r.retired_at)} for r in rows]


# ── Parents and organisation defaults ─────────────────────────────────────────


def _parent_allowed(card_type: str, company_id, shop_id, parent: BusinessCard) -> bool:
    if parent.card_type not in ("company", "branch") or str(parent.company_id) != str(company_id):
        return False
    if card_type == "company":
        return False
    if card_type == "branch":
        return parent.card_type == "company"
    if card_type == "point":
        return parent.card_type == "company" or str(parent.shop_id) == str(shop_id)
    # personal
    return parent.card_type == "company" or (shop_id is not None and str(parent.shop_id) == str(shop_id))


def check_parent(db: Session, tenant_id, card_type: str, company_id, shop_id, parent_id, self_id=None) -> Optional[BusinessCard]:
    if parent_id is None:
        return None
    parent = db.get(BusinessCard, _uuid(parent_id)) if _uuid(parent_id) else None
    if parent is None or str(parent.tenant_id) != str(tenant_id) or parent.status == "archived":
        raise error("parent_invalid", 422)
    if self_id is not None and str(parent.id) == str(self_id):
        raise error("parent_invalid", 422)
    if not _parent_allowed(card_type, company_id, shop_id, parent):
        raise error("parent_invalid", 422)
    return parent


def default_parent(db: Session, tenant_id, card_type: str, company_id, shop_id) -> Optional[BusinessCard]:
    """The nearest live card one level up: a branch card for a point / person of that branch, else the company's."""
    base = db.query(BusinessCard).filter(
        BusinessCard.tenant_id == tenant_id,
        BusinessCard.company_id == company_id,
        BusinessCard.status != "archived",
    )
    if card_type in ("point", "personal") and shop_id is not None:
        branch = base.filter(BusinessCard.card_type == "branch", BusinessCard.shop_id == shop_id).order_by(BusinessCard.created_at).first()
        if branch is not None:
            return branch
    if card_type == "company":
        return None
    return base.filter(BusinessCard.card_type == "company").order_by(BusinessCard.created_at).first()


def _address(row: Any) -> Optional[str]:
    parts = [p.strip() for p in (getattr(row, "address", None), getattr(row, "city", None)) if isinstance(p, str) and p.strip()]
    return ", ".join(parts) or None


def org_defaults(db: Session, card: BusinessCard) -> Dict[str, Any]:
    """What the organisation's own records supply, with the source of each value."""
    from app.services.settings_merge import merge_all_settings_layers

    company = db.get(Company, card.company_id)
    shop = db.get(Shop, card.shop_id) if card.shop_id else None
    area = db.get(ShopArea, card.area_id) if card.area_id else None
    tenant = db.get(Tenant, card.tenant_id)
    out: Dict[str, Any] = {"sources": {}}
    src = out["sources"]
    if card.card_type == "company":
        out["title"], src["title"] = company.name, "org:company"
    elif card.card_type == "branch" and shop is not None:
        out["title"], src["title"] = shop.name, "org:shop"
        out["orgLine"], src["orgLine"] = company.name, "org:company"
    elif card.card_type == "point" and area is not None:
        out["title"], src["title"] = area.name, "org:area"
        out["orgLine"], src["orgLine"] = (f"{shop.name} · {company.name}" if shop else company.name), "org:shop"
    elif card.card_type == "personal":
        out["orgLine"], src["orgLine"] = (f"{company.name} · {shop.name}" if shop else company.name), ("org:shop" if shop else "org:company")
    addr = _address(shop) if shop is not None else None
    if addr:
        out["address"], src["address"] = addr, "org:shop"
    elif _address(company):
        out["address"], src["address"] = _address(company), "org:company"
    try:
        merged = merge_all_settings_layers(company, shop, tenant, None, area)
    except Exception:  # noqa: BLE001 - a malformed settings layer must not break a card
        merged = {}
    if not isinstance(merged, dict):
        merged = {}
    logo = merged.get("brandLogoUrl")
    if R.is_safe_media_url(logo):
        out["logoUrl"], src["logoUrl"] = logo, "org:brand"
    # The public business profile in the settings layers (plan §18.2), when a level sets it:
    # the nearest level wins, and the source names that level.
    layers = [("tenant", getattr(tenant, "settings", None)), ("company", company.settings),
              ("shop", getattr(shop, "settings", None)), ("area", getattr(area, "settings", None))]
    for key, setting in PUBLIC_PROFILE_KEYS:
        value = merged.get(setting)
        if isinstance(value, str) and value.strip():
            level = next((name for name, layer in reversed(layers) if isinstance(layer, dict) and layer.get(setting)), "company")
            out[key], src[key] = value.strip(), f"org:{level}"
    if out.get("privacyUrl"):
        return out
    privacy = (
        db.query(ClubDocumentVersion.url)
        .join(ClubProgram, ClubProgram.id == ClubDocumentVersion.club_id)
        .filter(ClubProgram.company_id == card.company_id, ClubDocumentVersion.kind == "privacy", ClubDocumentVersion.status == "active")
        .order_by(ClubDocumentVersion.version.desc())
        .first()
    )
    if privacy is not None and R.is_safe_url(privacy[0]):
        out["privacyUrl"], src["privacyUrl"] = privacy[0], "org:club"
    return out


#: (card field, settings key) — the public business profile keys a card inherits when no card sets them.
PUBLIC_PROFILE_KEYS = (
    ("phone", "publicPhone"),
    ("whatsapp", "publicWhatsapp"),
    ("email", "publicEmail"),
    ("website", "publicWebsite"),
    ("accessibilityUrl", "publicAccessibilityUrl"),
    ("privacyUrl", "publicPrivacyUrl"),
)


def _meta(card: BusinessCard) -> Dict[str, Any]:
    return {"id": str(card.id), "slug": card.slug, "type": card.card_type, "name": card.name}


def published_doc(db: Session, card: BusinessCard) -> Optional[Dict[str, Any]]:
    if card.published_revision_id is None:
        return None
    rev = db.get(BusinessCardRevision, card.published_revision_id)
    return rev.content if rev is not None else None


def chain(db: Session, card: BusinessCard) -> List[Dict[str, Any]]:
    """The card's ancestors, root first, as their *published* documents (an unpublished or
    archived one is an empty document: it passes its own parent's values through)."""
    links: List[Dict[str, Any]] = []
    seen = {card.id}
    parent_id = card.parent_card_id
    while parent_id is not None and len(links) < 4:
        parent = db.get(BusinessCard, parent_id)
        if parent is None or parent.id in seen or str(parent.tenant_id) != str(card.tenant_id):
            break
        seen.add(parent.id)
        doc = published_doc(db, parent) if parent.status != "archived" else None
        links.append({"meta": _meta(parent), "doc": doc or {}, "org": org_defaults(db, parent), "published": doc is not None})
        parent_id = parent.parent_card_id
    links.reverse()
    return links


def menu_destinations(db: Session, card: BusinessCard) -> Dict[str, Any]:
    """The card's "Digital menu" / "Order online" targets: the published menu and ordering
    profiles of its target (spec §26). Those profiles do not exist yet (the digital-menu module,
    P:/specs/digital-menu-ordering-cards-plan.md), so there is none and both buttons stay hidden
    on the public card, with the reason shown in the editor. This is the one place to connect them."""
    return {}


def resolve_input(db: Session, card: BusinessCard, doc: Dict[str, Any], lang: str, today: Optional[str] = None) -> Dict[str, Any]:
    parents = chain(db, card)
    return {
        "card": {"meta": _meta(card), "doc": doc, "org": org_defaults(db, card)},
        "parents": [{"meta": p["meta"], "doc": p["doc"], "org": p["org"]} for p in parents],
        "destinations": menu_destinations(db, card),
        "lang": lang,
        "today": today or business_today(db, card.tenant_id),
    }


def editor_context(db: Session, card: BusinessCard) -> Dict[str, Any]:
    """Everything the editor's preview needs to run the same resolver on the unsaved draft."""
    parents = chain(db, card)
    return {
        "card": {"meta": _meta(card), "org": org_defaults(db, card)},
        "parents": parents,
        "destinations": menu_destinations(db, card),
        "today": business_today(db, card.tenant_id),
        "publicBaseUrl": public_base_url(),
    }


def public_base_url() -> str:
    from app.config import get_settings

    s = get_settings()
    explicit = (getattr(s, "business_card_base_url", "") or "").rstrip("/")
    if explicit:
        return explicit
    return (getattr(s, "pairing_mobile_app_base_url", "") or "http://localhost:3002").rstrip("/") + "/c"


# ── Output ────────────────────────────────────────────────────────────────────


def _names(db: Session, cards: Iterable[BusinessCard]) -> Dict[str, Dict[Any, str]]:
    cards = list(cards)
    company_ids = {c.company_id for c in cards}
    shop_ids = {c.shop_id for c in cards if c.shop_id}
    area_ids = {c.area_id for c in cards if c.area_id}
    parent_ids = {c.parent_card_id for c in cards if c.parent_card_id}
    out: Dict[str, Dict[Any, str]] = {"company": {}, "shop": {}, "area": {}, "card": {}}
    if company_ids:
        out["company"] = {r.id: r.name for r in db.query(Company.id, Company.name).filter(Company.id.in_(company_ids))}
    if shop_ids:
        out["shop"] = {r.id: r.name for r in db.query(Shop.id, Shop.name).filter(Shop.id.in_(shop_ids))}
    if area_ids:
        out["area"] = {r.id: r.name for r in db.query(ShopArea.id, ShopArea.name).filter(ShopArea.id.in_(area_ids))}
    if parent_ids:
        out["card"] = {r.id: r.name for r in db.query(BusinessCard.id, BusinessCard.name).filter(BusinessCard.id.in_(parent_ids))}
    return out


def _draft_title(card: BusinessCard, org: Optional[Dict[str, Any]] = None) -> Optional[str]:
    f = ((card.draft or {}).get("fields") or {}).get("title") or {}
    value = f.get("value") if isinstance(f, dict) else None
    if isinstance(f, dict) and f.get("mode") == "local" and isinstance(value, dict):
        return value.get("he") or value.get("en")
    return (org or {}).get("title") if org else None


def card_out(db: Session, card: BusinessCard, names: Optional[Dict[str, Dict[Any, str]]] = None,
             published: Optional[BusinessCardRevision] = None, stats: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    names = names or _names(db, [card])
    if published is None and card.published_revision_id is not None:
        published = db.get(BusinessCardRevision, card.published_revision_id)
    draft = card.draft or {}
    return {
        "id": str(card.id),
        "name": card.name,
        "slug": card.slug,
        "publicPath": f"/c/{card.slug}",
        "type": card.card_type,
        "status": card.status,
        "template": R.template_of(draft),
        "title": _draft_title(card),
        "companyId": str(card.company_id),
        "companyName": names["company"].get(card.company_id),
        "shopId": str(card.shop_id) if card.shop_id else None,
        "shopName": names["shop"].get(card.shop_id) if card.shop_id else None,
        "areaId": str(card.area_id) if card.area_id else None,
        "areaName": names["area"].get(card.area_id) if card.area_id else None,
        "parentCardId": str(card.parent_card_id) if card.parent_card_id else None,
        "parentName": names["card"].get(card.parent_card_id) if card.parent_card_id else None,
        "ownerUserId": str(card.owner_user_id) if card.owner_user_id else None,
        "draftVersion": card.draft_version,
        "draftUpdatedAt": _iso(card.draft_updated_at),
        "publishedRevision": {
            "id": str(published.id), "number": published.number, "publishedAt": _iso(published.published_at),
        } if published is not None else None,
        "hasUnpublishedChanges": published is None or published.content_hash != content_hash(draft),
        "publishedAt": _iso(card.published_at),
        "pausedAt": _iso(card.paused_at),
        "archivedAt": _iso(card.archived_at),
        "createdAt": _iso(card.created_at),
        "updatedAt": _iso(card.updated_at),
        "stats30d": stats,
    }


def card_detail(db: Session, card: BusinessCard) -> Dict[str, Any]:
    out = card_out(db, card)
    out["draft"] = card.draft or {}
    out["context"] = editor_context(db, card)
    out["slugs"] = slugs_of(db, card)
    out["children"] = [
        {"id": str(c.id), "name": c.name, "type": c.card_type, "status": c.status}
        for c in db.query(BusinessCard).filter(BusinessCard.parent_card_id == card.id, BusinessCard.status != "archived").order_by(BusinessCard.name)
    ]
    return out


def list_cards(db: Session, user: User, tenant_id, *, company_id=None, shop_id=None, area_id=None,
               card_type: Optional[str] = None, status_filter: Optional[str] = None, template: Optional[str] = None,
               q: Optional[str] = None, include_archived: bool = False) -> List[Dict[str, Any]]:
    query = visible_cards_query(db, user, tenant_id)
    if _uuid(company_id):
        query = query.filter(BusinessCard.company_id == _uuid(company_id))
    if _uuid(shop_id):
        query = query.filter(BusinessCard.shop_id == _uuid(shop_id))
    if _uuid(area_id):
        query = query.filter(BusinessCard.area_id == _uuid(area_id))
    if card_type in R.CARD_TYPES:
        query = query.filter(BusinessCard.card_type == card_type)
    if status_filter in R.CARD_STATUSES:
        query = query.filter(BusinessCard.status == status_filter)
    elif not include_archived:
        query = query.filter(BusinessCard.status != "archived")
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(func.lower(BusinessCard.name).like(like), func.lower(BusinessCard.slug).like(like)))
    cards = query.order_by(BusinessCard.updated_at.desc()).limit(500).all()
    if template in R.CARD_TEMPLATES:
        cards = [c for c in cards if R.template_of(c.draft or {}) == template]
    names = _names(db, cards)
    revs = {}
    rev_ids = [c.published_revision_id for c in cards if c.published_revision_id]
    if rev_ids:
        revs = {r.id: r for r in db.query(BusinessCardRevision).filter(BusinessCardRevision.id.in_(rev_ids))}
    stats = stats_totals(db, [c.id for c in cards], days=30)
    return [card_out(db, c, names, revs.get(c.published_revision_id), stats.get(c.id, {})) for c in cards]


# ── Lifecycle ─────────────────────────────────────────────────────────────────


def create_card(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> BusinessCard:
    require_role(user)
    card_type = body.get("type")
    template = body.get("template") or "cover"
    if template not in R.CARD_TEMPLATES:
        raise error("template_invalid", 422)
    name = (body.get("name") or "").strip()[:160]
    if not name:
        raise error("name_required", 422)
    company, shop, area = resolve_target(db, tenant_id, card_type, body.get("companyId"), body.get("shopId"), body.get("areaId"))
    _check_target_scope(db, user, tenant_id, card_type, company, shop)
    parent_raw = body.get("parentCardId", "auto")
    if parent_raw == "auto":
        parent = default_parent(db, tenant_id, card_type, company.id, shop.id if shop else None)
    else:
        parent = check_parent(db, tenant_id, card_type, company.id, shop.id if shop else None, parent_raw)
    owner = _owner_checked(db, tenant_id, body.get("ownerUserId")) if card_type == "personal" else None
    slug = body.get("slug")
    if slug is not None and slug != "":
        if not R.is_valid_slug(slug):
            raise error("slug_invalid", 422)
        if not _slug_free(db, slug):
            raise error("slug_taken", 409)
    else:
        slug = new_slug(db, name)
    doc = R.default_doc(card_type, template, has_parent=parent is not None)
    langs = body.get("languages")
    if isinstance(langs, list):
        doc["languages"] = R.languages_of({"languages": langs})
    if card_type == "personal" and owner is not None:
        person = (owner.full_name if hasattr(owner, "full_name") else None) or owner.username or ""
        if person.strip():
            doc["fields"]["title"] = {"mode": "local", "visibility": "public", "value": R.org_text(person)}
    now = _now()
    card = BusinessCard(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company.id,
        shop_id=shop.id if shop else None,
        area_id=area.id if area else None,
        card_type=card_type,
        name=name,
        slug=slug,
        status="draft",
        parent_card_id=parent.id if parent else None,
        owner_user_id=owner.id if owner else None,
        draft=normalize_doc(doc, card_type),
        draft_version=1,
        draft_updated_at=now,
        draft_updated_by=user.id,
        created_by_user_id=user.id,
    )
    db.add(card)
    db.flush()
    db.add(BusinessCardSlug(slug=slug, card_id=card.id, tenant_id=tenant_id))
    audit(db, card, user, "create", type=card_type, template=template)
    return card


def _owner_checked(db: Session, tenant_id, owner_id) -> Optional[User]:
    if owner_id in (None, ""):
        return None
    owner = db.get(User, _uuid(owner_id)) if _uuid(owner_id) else None
    if owner is None or str(owner.tenant_id) != str(tenant_id):
        raise error("owner_invalid", 422)
    return owner


def update_meta(db: Session, user: User, card: BusinessCard, body: Dict[str, Any]) -> BusinessCard:
    if card.status == "archived":
        raise error("archived", 409)
    before = {"name": card.name, "parentCardId": str(card.parent_card_id) if card.parent_card_id else None,
              "ownerUserId": str(card.owner_user_id) if card.owner_user_id else None}
    if "name" in body:
        name = (body.get("name") or "").strip()[:160]
        if not name:
            raise error("name_required", 422)
        card.name = name
    if "parentCardId" in body:
        parent = check_parent(db, card.tenant_id, card.card_type, card.company_id, card.shop_id, body.get("parentCardId"), self_id=card.id)
        # No cycles: the new parent must not descend from this card.
        p = parent
        hops = 0
        while p is not None and hops < 6:
            if p.id == card.id:
                raise error("parent_invalid", 422)
            p = db.get(BusinessCard, p.parent_card_id) if p.parent_card_id else None
            hops += 1
        card.parent_card_id = parent.id if parent else None
    if "ownerUserId" in body and card.card_type == "personal":
        owner = _owner_checked(db, card.tenant_id, body.get("ownerUserId"))
        card.owner_user_id = owner.id if owner else None
    after = {"name": card.name, "parentCardId": str(card.parent_card_id) if card.parent_card_id else None,
             "ownerUserId": str(card.owner_user_id) if card.owner_user_id else None}
    if before != after:
        audit(db, card, user, "meta", before=before, after=after)
    return card


def _expect_version(card: BusinessCard, expected: Any) -> None:
    if expected is None:
        return
    if not isinstance(expected, int) or isinstance(expected, bool) or expected != card.draft_version:
        raise error(
            "draft_conflict", 409,
            currentVersion=card.draft_version,
            updatedAt=_iso(card.draft_updated_at),
            updatedBy=str(card.draft_updated_by) if card.draft_updated_by else None,
        )


def update_draft(db: Session, user: User, card: BusinessCard, body: Dict[str, Any]) -> BusinessCard:
    if card.status == "archived":
        raise error("archived", 409)
    if not isinstance(body.get("expectedVersion"), int):
        raise error("draft_conflict", 409, "חסרה גרסת הטיוטה.", currentVersion=card.draft_version)
    _expect_version(card, body.get("expectedVersion"))
    doc = normalize_doc(body.get("draft"), card.card_type)
    if canonical(doc) != canonical(card.draft or {}):
        card.draft = doc
        card.draft_version = card.draft_version + 1
        card.draft_updated_at = _now()
        card.draft_updated_by = user.id
    return card


def _next_number(db: Session, card: BusinessCard) -> int:
    last = db.query(func.max(BusinessCardRevision.number)).filter(BusinessCardRevision.card_id == card.id).scalar()
    return int(last or 0) + 1


def _new_revision(db: Session, user: User, card: BusinessCard, kind: str, content: Dict[str, Any], note: Optional[str]) -> BusinessCardRevision:
    now = _now()
    rev = BusinessCardRevision(
        id=uuid.uuid4(),
        tenant_id=card.tenant_id,
        card_id=card.id,
        number=_next_number(db, card),
        kind=kind,
        content=content,
        content_hash=content_hash(content),
        note=(note or "").strip()[:300] or None,
        created_by_user_id=user.id,
        published_at=now if kind == "published" else None,
    )
    db.add(rev)
    db.flush()
    return rev


def save_revision(db: Session, user: User, card: BusinessCard, body: Dict[str, Any]) -> BusinessCardRevision:
    """"שמירה": a named checkpoint of the draft (the public page does not change)."""
    if card.status == "archived":
        raise error("archived", 409)
    _expect_version(card, body.get("expectedVersion"))
    rev = _new_revision(db, user, card, "saved", card.draft or {}, body.get("note"))
    if card.status == "draft":
        card.status = "saved"
    audit(db, card, user, "save", rev.number)
    return rev


def _field_diff(before: Optional[Dict[str, Any]], after: Dict[str, Any]) -> List[str]:
    """Top-level keys and field names that differ — the publication review's change list."""
    if before is None:
        return ["*"]
    changed: List[str] = []
    bf, af = before.get("fields") or {}, after.get("fields") or {}
    for key in R.FIELD_KEYS:
        if canonical(bf.get(key)) != canonical(af.get(key)):
            changed.append(f"fields.{key}")
    for key in ("languages", "template", "sections", "actions", "design", "enquiry", "seo"):
        if canonical(before.get(key)) != canonical(after.get(key)):
            changed.append(key)
    return changed


def publish_review(db: Session, card: BusinessCard, content: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    content = content if content is not None else (card.draft or {})
    inp = resolve_input(db, card, content, R.languages_of(content)[0])
    result = R.resolve_card(inp)
    issues = R.card_issues(inp, result)
    children = (
        db.query(BusinessCard)
        .filter(BusinessCard.parent_card_id == card.id, BusinessCard.status != "archived")
        .order_by(BusinessCard.name)
        .all()
    )
    return {
        "issues": issues,
        "blocked": any(i["level"] == "error" for i in issues),
        "changes": _field_diff(published_doc(db, card), content),
        "inheritingCards": [{"id": str(c.id), "name": c.name, "type": c.card_type, "status": c.status} for c in children],
        "unpublishedParents": [
            {"id": p["meta"]["id"], "name": p["meta"]["name"]} for p in chain(db, card) if not p["published"]
        ],
    }


def _publish_content(db: Session, user: User, card: BusinessCard, content: Dict[str, Any], note: Optional[str], action: str) -> BusinessCardRevision:
    review = publish_review(db, card, content)
    if review["blocked"]:
        raise error("publish_blocked", 422, issues=review["issues"])
    rev = _new_revision(db, user, card, "published", content, note)
    card.published_revision_id = rev.id
    card.published_at = rev.published_at
    if card.status in ("draft", "saved"):
        card.status = "published"
    audit(db, card, user, action, rev.number, changes=review["changes"])
    return rev


def publish(db: Session, user: User, card: BusinessCard, body: Dict[str, Any]) -> BusinessCardRevision:
    """Publish the draft as a new revision. Only this card changes: never a menu, never
    another card (children read the new values through inheritance)."""
    if card.status == "archived":
        raise error("archived", 409)
    _expect_version(card, body.get("expectedVersion"))
    return _publish_content(db, user, card, card.draft or {}, body.get("note"), "publish")


def revision_checked(db: Session, card: BusinessCard, revision_id) -> BusinessCardRevision:
    rev = db.get(BusinessCardRevision, _uuid(revision_id)) if _uuid(revision_id) else None
    if rev is None or rev.card_id != card.id:
        raise error("revision_not_found", 404)
    return rev


def publish_revision(db: Session, user: User, card: BusinessCard, rev: BusinessCardRevision, note: Optional[str] = None) -> BusinessCardRevision:
    """Rollback: an older revision becomes the public one again (as a new revision, so the
    history stays linear). The draft is left as it is."""
    if card.status == "archived":
        raise error("archived", 409)
    content = normalize_doc(rev.content, card.card_type)
    return _publish_content(db, user, card, content, note or f"שחזור גרסה {rev.number}", "rollback")


def restore_revision_to_draft(db: Session, user: User, card: BusinessCard, rev: BusinessCardRevision, expected: Any) -> BusinessCard:
    if card.status == "archived":
        raise error("archived", 409)
    _expect_version(card, expected)
    card.draft = normalize_doc(rev.content, card.card_type)
    card.draft_version += 1
    card.draft_updated_at = _now()
    card.draft_updated_by = user.id
    audit(db, card, user, "restore_draft", rev.number)
    return card


def revisions_out(db: Session, card: BusinessCard) -> List[Dict[str, Any]]:
    rows = db.query(BusinessCardRevision).filter(BusinessCardRevision.card_id == card.id).order_by(BusinessCardRevision.number.desc()).limit(200).all()
    return [{
        "id": str(r.id), "number": r.number, "kind": r.kind, "note": r.note,
        "createdAt": _iso(r.created_at), "publishedAt": _iso(r.published_at),
        "createdBy": str(r.created_by_user_id) if r.created_by_user_id else None,
        "isLive": r.id == card.published_revision_id,
        "template": R.template_of(r.content or {}),
    } for r in rows]


def set_state(db: Session, user: User, card: BusinessCard, action: str) -> BusinessCard:
    now = _now()
    if action == "pause":
        if card.status != "published":
            raise error("state_invalid", 409)
        card.status, card.paused_at = "paused", now
    elif action == "resume":
        if card.status != "paused":
            raise error("state_invalid", 409)
        card.status, card.paused_at = "published", None
    elif action == "archive":
        if card.status == "archived":
            return card
        card.status, card.archived_at = "archived", now
    elif action == "restore":
        if card.status != "archived":
            raise error("state_invalid", 409)
        # Back as paused when it had a public revision: restoring never republishes by itself.
        if card.published_revision_id is not None:
            card.status, card.paused_at = "paused", now
        else:
            has_rev = db.query(BusinessCardRevision.id).filter(BusinessCardRevision.card_id == card.id).first() is not None
            card.status = "saved" if has_rev else "draft"
        card.archived_at = None
    else:
        raise error("state_invalid", 422)
    audit(db, card, user, action)
    return card


def duplicate(db: Session, user: User, card: BusinessCard, body: Dict[str, Any]) -> BusinessCard:
    name = (body.get("name") or f"{card.name} (עותק)").strip()[:160]
    copy = BusinessCard(
        id=uuid.uuid4(),
        tenant_id=card.tenant_id,
        company_id=card.company_id,
        shop_id=card.shop_id,
        area_id=card.area_id,
        card_type=card.card_type,
        name=name,
        slug=new_slug(db, name),
        status="draft",
        parent_card_id=card.parent_card_id,
        owner_user_id=card.owner_user_id,
        draft=json.loads(canonical(card.draft or {})),
        draft_version=1,
        draft_updated_at=_now(),
        draft_updated_by=user.id,
        created_by_user_id=user.id,
    )
    db.add(copy)
    db.flush()
    db.add(BusinessCardSlug(slug=copy.slug, card_id=copy.id, tenant_id=copy.tenant_id))
    audit(db, copy, user, "duplicate", source=str(card.id))
    return copy


def audit_out(db: Session, card: BusinessCard, limit: int = 100) -> List[Dict[str, Any]]:
    rows = (
        db.query(BusinessCardAuditEvent, User.username)
        .outerjoin(User, User.id == BusinessCardAuditEvent.actor_user_id)
        .filter(BusinessCardAuditEvent.card_id == card.id)
        .order_by(BusinessCardAuditEvent.created_at.desc())
        .limit(limit)
        .all()
    )
    return [{
        "id": str(e.id), "action": e.action, "revisionNumber": e.revision_number, "details": e.details or {},
        "actor": username, "at": _iso(e.created_at),
    } for e, username in rows]


# ── Public ────────────────────────────────────────────────────────────────────


def public_lookup(db: Session, slug: str) -> Tuple[str, Optional[BusinessCard]]:
    """("card" | "redirect" | "paused" | "missing", card)."""
    if not isinstance(slug, str) or len(slug) > 64:
        return "missing", None
    row = db.get(BusinessCardSlug, slug)
    if row is None:
        return "missing", None
    card = db.get(BusinessCard, row.card_id)
    if card is None or card.status == "archived" or card.published_revision_id is None:
        return "missing", None
    if row.retired_at is not None:
        return "redirect", card
    if card.status == "paused":
        return "paused", card
    expires = (published_doc(db, card) or {}).get("expiresAt")
    if R.is_ymd(expires) and expires < business_today(db, card.tenant_id):
        return "paused", card  # an event / campaign card past its last day: neutral, like paused
    return "card", card


def public_model(db: Session, card: BusinessCard, lang: str) -> Tuple[Dict[str, Any], str]:
    """The visitor's card for the published revision, and an ETag over everything it reads
    (tenant, card, revision, the parents' revisions, language, business date)."""
    doc = published_doc(db, card) or {}
    inp = resolve_input(db, card, doc, lang)
    model = R.resolve_card(inp)["model"]
    rev = db.get(BusinessCardRevision, card.published_revision_id)
    model["revision"] = {"number": rev.number if rev else None, "publishedAt": _iso(rev.published_at) if rev else None}
    model["publicUrl"] = f"{public_base_url()}/{card.slug}"
    parent_revs = []
    for p in chain(db, card):
        pc = db.get(BusinessCard, uuid.UUID(p["meta"]["id"]))
        parent_revs.append(str(pc.published_revision_id) if pc and pc.published_revision_id else "-")
    tag_src = "|".join([str(card.tenant_id), str(card.id), str(card.published_revision_id), *parent_revs,
                        model["lang"], inp["today"], content_hash(inp["card"]["org"])])
    etag = hashlib.sha256(tag_src.encode("utf-8")).hexdigest()[:32]
    return model, etag


# ── VCF ───────────────────────────────────────────────────────────────────────


def vcard_escape(value: str) -> str:
    """RFC 6350 §3.4 text escaping: backslash, comma, semicolon, newlines."""
    return (
        value.replace("\\", "\\\\")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def vcard_fold(line: str) -> str:
    """Fold at 75 octets (RFC 6350 §3.2) without splitting a UTF-8 character."""
    out: List[str] = []
    current = ""
    current_len = 0
    limit = 75
    for ch in line:
        n = len(ch.encode("utf-8"))
        if current_len + n > limit:
            out.append(current)
            current, current_len, limit = " " + ch, 1 + n, 75
        else:
            current += ch
            current_len += n
    out.append(current)
    return "\r\n".join(out)


def build_vcard(model: Dict[str, Any]) -> str:
    """vCard 3.0 from the public model only — private fields are not in it to begin with."""
    header = model.get("header") or {}
    contact = model.get("contact") or {}

    def t(v: Optional[Dict[str, Any]]) -> Optional[str]:
        return v.get("text") if isinstance(v, dict) and v.get("text") else None

    title = t(header.get("title")) or model.get("slug") or ""
    role = t(header.get("role"))
    org_line = t(header.get("orgLine"))
    personal = model.get("type") == "personal"
    lines = ["BEGIN:VCARD", "VERSION:3.0"]
    if personal:
        lines.append(f"N;CHARSET=UTF-8:;{vcard_escape(title)};;;")
    else:
        lines.append("N:;;;;")
    lines.append(f"FN;CHARSET=UTF-8:{vcard_escape(title)}")
    if personal:
        if org_line:
            lines.append(f"ORG;CHARSET=UTF-8:{vcard_escape(org_line)}")
    elif org_line:
        lines.append(f"ORG;CHARSET=UTF-8:{vcard_escape(org_line)};{vcard_escape(title)}")
    else:
        lines.append(f"ORG;CHARSET=UTF-8:{vcard_escape(title)}")
    if role:
        lines.append(f"TITLE;CHARSET=UTF-8:{vcard_escape(role)}")
    phone = (contact.get("phone") or {}).get("e164")
    whatsapp = (contact.get("whatsapp") or {}).get("e164")
    if phone:
        lines.append(f"TEL;TYPE={'CELL' if personal else 'WORK'},VOICE:{phone}")
    if whatsapp and whatsapp != phone:
        lines.append(f"TEL;TYPE=CELL:{whatsapp}")
    if contact.get("email"):
        lines.append(f"EMAIL;TYPE=INTERNET:{vcard_escape(contact['email'])}")
    address = t(contact.get("address"))
    if address:
        lines.append(f"ADR;CHARSET=UTF-8;TYPE=WORK:;;{vcard_escape(address)};;;;")
    if contact.get("website"):
        lines.append(f"URL:{vcard_escape(contact['website'])}")
    if model.get("publicUrl"):
        lines.append(f"URL:{vcard_escape(model['publicUrl'])}")
    about = next((s for s in model.get("sections") or [] if s.get("kind") == "about"), None)
    if about and t(about.get("text")):
        lines.append(f"NOTE;CHARSET=UTF-8:{vcard_escape(t(about['text']))}")
    if not personal:
        lines.append("X-ABShowAs:COMPANY")
    lines.append("END:VCARD")
    return "\r\n".join(vcard_fold(line) for line in lines) + "\r\n"


def vcard_filename(model: Dict[str, Any]) -> Tuple[str, str]:
    """(ASCII filename, RFC 5987 UTF-8 filename*) for Content-Disposition."""
    from urllib.parse import quote

    title = ((model.get("header") or {}).get("title") or {}).get("text") or model.get("slug") or "contact"
    safe_title = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title).strip()[:80] or "contact"
    return f"{model.get('slug') or 'contact'}.vcf", quote(f"{safe_title}.vcf", safe="")


# ── Enquiries ─────────────────────────────────────────────────────────────────

_SUBMISSION_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def _clean_input(value: Any, max_len: int) -> str:
    return _CONTROL.sub("", value).strip()[:max_len] if isinstance(value, str) else ""


def _dedupe_key(card: BusinessCard, phone: Optional[str], email: Optional[str], topic: str, message: str) -> str:
    from app.services.notifications.crypto import keyed_hash

    norm_message = re.sub(r"\s+", " ", message).strip().lower()
    return keyed_hash("|".join([str(card.id), phone or "", (email or "").lower(), topic.lower(), norm_message]), label="bc_enquiry")


def ip_hash(ip: Optional[str]) -> Optional[str]:
    if not ip:
        return None
    from app.services.notifications.crypto import keyed_hash

    return keyed_hash(ip, label="ip")


def validate_enquiry(model: Dict[str, Any], body: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """The visitor's input against the card's published form: (clean values, field errors)."""
    cfg = model.get("enquiry") or {}
    fields = cfg.get("fields") or {}
    errors: Dict[str, str] = {}
    values: Dict[str, Any] = {}
    name = _clean_input(body.get("name"), 120)
    phone_raw = _clean_input(body.get("phone"), 30)
    email = _clean_input(body.get("email"), 254)
    topic = _clean_input(body.get("topic"), 120)
    message = _clean_input(body.get("message"), ENQUIRY_MESSAGE_MAX)
    for key, value in (("name", name), ("phone", phone_raw), ("email", email), ("topic", topic), ("message", message)):
        req = fields.get(key, "off")
        if req == "off":
            continue
        if req == "required" and not value:
            errors[key] = "required"
    phone = None
    if fields.get("phone", "off") != "off" and phone_raw:
        phone = R.normalize_phone(phone_raw)
        if phone is None:
            errors["phone"] = "invalid"
    if fields.get("email", "off") != "off" and email and not R.is_email(email):
        errors["email"] = "invalid"
    if not errors.get("phone") and not errors.get("email") and not phone and not email:
        errors["contact"] = "required"
    topics = [t.get("text") for t in cfg.get("topics") or [] if isinstance(t, dict)]
    if fields.get("topic", "off") != "off" and topic and topics and topic not in topics:
        errors["topic"] = "invalid"
    if body.get("consent") is not True:
        errors["consent"] = "required"
    values.update({
        "name": name or None,
        "phone": phone,
        "email": email or None,
        "topic": topic or None,
        "message": message or None,
    })
    return values, errors


def submit_enquiry(db: Session, card: BusinessCard, model: Dict[str, Any], body: Dict[str, Any], *, ip: Optional[str],
                   now: Optional[datetime] = None) -> Tuple[Dict[str, Any], int]:
    """Store one enquiry: ({status, enquiryId, duplicate}, http status). "saved" means committed."""
    now = now or _now()
    if not model.get("enquiry"):
        raise error("enquiry_unavailable", 409, "הכרטיס אינו מקבל פניות.")
    if _clean_input(body.get("website"), 200):
        # The honeypot field: invisible to people, filled by bots. Nothing is stored.
        raise error("rejected", 422, "הפנייה נדחתה.")
    submission_id = body.get("submissionId")
    if not isinstance(submission_id, str) or not _SUBMISSION_ID.fullmatch(submission_id):
        raise error("invalid", 422, "חסר מזהה שליחה.", fields={"submissionId": "invalid"})
    values, errors = validate_enquiry(model, body)
    if errors:
        raise error("invalid", 422, "יש לתקן את השדות המסומנים.", fields=errors)

    existing = db.query(BusinessCardEnquiry).filter(
        BusinessCardEnquiry.card_id == card.id, BusinessCardEnquiry.submission_id == submission_id
    ).first()
    if existing is not None:
        return {"status": "saved", "enquiryId": str(existing.id), "duplicate": True, "delivery": existing.delivery}, 200

    hashed_ip = ip_hash(ip)
    if hashed_ip:
        recent = db.query(func.count(BusinessCardEnquiry.id)).filter(
            BusinessCardEnquiry.card_id == card.id,
            BusinessCardEnquiry.ip_hash == hashed_ip,
            BusinessCardEnquiry.created_at >= now - timedelta(minutes=10),
        ).scalar() or 0
        daily = db.query(func.count(BusinessCardEnquiry.id)).filter(
            BusinessCardEnquiry.card_id == card.id,
            BusinessCardEnquiry.ip_hash == hashed_ip,
            BusinessCardEnquiry.created_at >= now - timedelta(days=1),
        ).scalar() or 0
        if recent >= ENQUIRY_PER_IP_10MIN or daily >= ENQUIRY_PER_IP_DAY:
            raise error("rate_limited", 429, "נשלחו יותר מדי פניות. נסו שוב מאוחר יותר.", retryAfter=600)
    card_hour = db.query(func.count(BusinessCardEnquiry.id)).filter(
        BusinessCardEnquiry.card_id == card.id, BusinessCardEnquiry.created_at >= now - timedelta(hours=1)
    ).scalar() or 0
    if card_hour >= ENQUIRY_PER_CARD_HOUR:
        raise error("rate_limited", 429, "נשלחו יותר מדי פניות. נסו שוב מאוחר יותר.", retryAfter=900)

    dedupe = _dedupe_key(card, values["phone"], values["email"], values["topic"] or "", values["message"] or "")
    dup = db.query(BusinessCardEnquiry).filter(
        BusinessCardEnquiry.card_id == card.id,
        BusinessCardEnquiry.dedupe_key == dedupe,
        BusinessCardEnquiry.created_at >= now - ENQUIRY_DEDUPE_WINDOW,
    ).first()
    if dup is not None:
        return {"status": "saved", "enquiryId": str(dup.id), "duplicate": True, "delivery": dup.delivery}, 200

    cfg = model.get("enquiry") or {}
    source = _clean_input(body.get("source"), 32) or None
    if source and not re.fullmatch(r"[a-z0-9_-]{1,32}", source):
        source = None
    campaign = _clean_input(body.get("campaign"), 60) or (card.draft or {}).get("enquiry", {}).get("campaign")
    row = BusinessCardEnquiry(
        id=uuid.uuid4(),
        tenant_id=card.tenant_id,
        card_id=card.id,
        revision_id=card.published_revision_id,
        company_id=card.company_id,
        shop_id=card.shop_id,
        area_id=card.area_id,
        submission_id=submission_id,
        name=values["name"],
        phone=values["phone"],
        email=values["email"],
        topic=values["topic"],
        message=values["message"],
        lang=model.get("lang"),
        source=source,
        campaign=campaign if isinstance(campaign, str) and campaign else None,
        consent_privacy_url=cfg.get("privacyUrl"),
        consent_text=_clean_input(body.get("consentText"), 300) or None,
        consented_at=now,
        dedupe_key=dedupe,
        ip_hash=hashed_ip,
        status="new",
        delivery="internal",
        created_at=now,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # The same submission landed twice at once: the first one is the answer.
        db.rollback()
        first = db.query(BusinessCardEnquiry).filter(
            BusinessCardEnquiry.card_id == card.id, BusinessCardEnquiry.submission_id == submission_id
        ).first()
        if first is None:
            raise
        return {"status": "saved", "enquiryId": str(first.id), "duplicate": True, "delivery": first.delivery}, 200
    record_stat(db, card, "enquiry", "", day=now.date())
    return {"status": "saved", "enquiryId": str(row.id), "duplicate": False, "delivery": "internal"}, 201


def enquiry_out(e: BusinessCardEnquiry, card_name: Optional[str] = None) -> Dict[str, Any]:
    return {
        "id": str(e.id), "cardId": str(e.card_id), "cardName": card_name,
        "name": e.name, "phone": e.phone, "phoneDisplay": R.display_phone(e.phone) if e.phone else None,
        "email": e.email, "topic": e.topic, "message": e.message, "lang": e.lang,
        "source": e.source, "campaign": e.campaign, "status": e.status, "delivery": e.delivery,
        "consentPrivacyUrl": e.consent_privacy_url, "consentedAt": _iso(e.consented_at),
        "handledAt": _iso(e.handled_at), "createdAt": _iso(e.created_at),
    }


def list_enquiries(db: Session, user: User, tenant_id, *, card_id=None, status_filter: Optional[str] = None,
                   q: Optional[str] = None, limit: int = 200) -> Dict[str, Any]:
    cards = visible_cards_query(db, user, tenant_id).with_entities(BusinessCard.id, BusinessCard.name).all()
    names = {c.id: c.name for c in cards}
    if not names:
        return {"items": [], "counts": {}}
    ids = list(names)
    if _uuid(card_id):
        ids = [i for i in ids if i == _uuid(card_id)]
    base = db.query(BusinessCardEnquiry).filter(BusinessCardEnquiry.card_id.in_(ids))
    counts = {s: n for s, n in db.query(BusinessCardEnquiry.status, func.count(BusinessCardEnquiry.id))
              .filter(BusinessCardEnquiry.card_id.in_(ids)).group_by(BusinessCardEnquiry.status)}
    query = base
    if status_filter in ("new", "handled", "archived"):
        query = query.filter(BusinessCardEnquiry.status == status_filter)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(
            func.lower(BusinessCardEnquiry.name).like(like),
            func.lower(BusinessCardEnquiry.email).like(like),
            BusinessCardEnquiry.phone.like(f"%{re.sub(r'[^0-9]', '', q)[-7:] or q.strip()}%"),
            func.lower(BusinessCardEnquiry.message).like(like),
        ))
    rows = query.order_by(BusinessCardEnquiry.created_at.desc()).limit(min(max(limit, 1), 500)).all()
    return {"items": [enquiry_out(e, names.get(e.card_id)) for e in rows], "counts": counts}


def update_enquiry(db: Session, user: User, tenant_id, enquiry_id, body: Dict[str, Any]) -> BusinessCardEnquiry:
    e = db.get(BusinessCardEnquiry, _uuid(enquiry_id)) if _uuid(enquiry_id) else None
    if e is None or str(e.tenant_id) != str(tenant_id):
        raise error("enquiry_not_found", 404)
    card = card_checked(db, user, tenant_id, e.card_id)
    new_status = body.get("status")
    if new_status not in ("new", "handled", "archived"):
        raise error("state_invalid", 422)
    if new_status != e.status:
        before = e.status
        e.status = new_status
        if new_status == "handled":
            e.handled_at, e.handled_by_user_id = _now(), user.id
        audit(db, card, user, "enquiry", enquiry=str(e.id), before=before, after=new_status)
    return e


# ── Counters ──────────────────────────────────────────────────────────────────


def record_stat(db: Session, card: BusinessCard, metric: str, dimension: str = "", *, day: Optional[date] = None, n: int = 1) -> None:
    """+n on (card, day, metric, dimension). Portable upsert: Postgres ON CONFLICT, else read-modify-write."""
    if metric not in STAT_METRICS:
        return
    day = day or _now().date()
    dimension = (dimension or "")[:32]
    bind = db.get_bind()
    values = {"card_id": card.id, "day": day, "metric": metric, "dimension": dimension, "tenant_id": card.tenant_id, "count": n}
    if bind is not None and bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = pg_insert(BusinessCardDailyStat).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["card_id", "day", "metric", "dimension"],
            set_={"count": BusinessCardDailyStat.count + n},
        )
        db.execute(stmt)
        return
    row = db.get(BusinessCardDailyStat, (card.id, day, metric, dimension))
    if row is None:
        db.add(BusinessCardDailyStat(**values))
        db.flush()
    else:
        row.count = (row.count or 0) + n


def stats_totals(db: Session, card_ids: List[uuid.UUID], days: int = 30) -> Dict[uuid.UUID, Dict[str, int]]:
    if not card_ids:
        return {}
    since = _now().date() - timedelta(days=days - 1)
    rows = (
        db.query(BusinessCardDailyStat.card_id, BusinessCardDailyStat.metric, func.sum(BusinessCardDailyStat.count))
        .filter(BusinessCardDailyStat.card_id.in_(card_ids), BusinessCardDailyStat.day >= since)
        .group_by(BusinessCardDailyStat.card_id, BusinessCardDailyStat.metric)
        .all()
    )
    out: Dict[uuid.UUID, Dict[str, int]] = {}
    for card_id, metric, total in rows:
        out.setdefault(card_id, {})[metric] = int(total or 0)
    return out


def card_stats(db: Session, card: BusinessCard, days: int = 30) -> Dict[str, Any]:
    days = min(max(int(days or 30), 1), 366)
    since = _now().date() - timedelta(days=days - 1)
    rows = (
        db.query(BusinessCardDailyStat)
        .filter(BusinessCardDailyStat.card_id == card.id, BusinessCardDailyStat.day >= since)
        .order_by(BusinessCardDailyStat.day)
        .all()
    )
    totals: Dict[str, int] = {m: 0 for m in STAT_METRICS}
    actions: Dict[str, int] = {}
    by_day: Dict[str, Dict[str, int]] = {}
    for r in rows:
        totals[r.metric] = totals.get(r.metric, 0) + r.count
        if r.metric == "action":
            actions[r.dimension] = actions.get(r.dimension, 0) + r.count
        by_day.setdefault(r.day.isoformat(), {}).setdefault(r.metric, 0)
        by_day[r.day.isoformat()][r.metric] += r.count
    return {
        "days": days,
        "since": since.isoformat(),
        "totals": totals,
        "actions": actions,
        "daily": [{"day": d, **v} for d, v in sorted(by_day.items())],
        # Counting is first-party and cookie-free: no visitor ids, so views are visits, not people.
        "method": "first_party_cookieless",
    }
