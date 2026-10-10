"""
Presentation profiles and their revisions — the digital menu's and the online ordering site's own
configuration (specs/digital-menu-ordering-cards-plan.md §6; the tables: app/models/presentation_profile.py).

* **A profile** has a kind (`menu` / `online`), a target (company / shop / point of sale), service
  types (dine-in / takeaway), a price-list context, languages, a priority, a status and a stable
  public slug. Its content lives in revisions.
* **Revisions.** One draft at most, edited with an optimistic `version` (409 with the current
  version when it moved on); "שמור" marks it saved; "פרסם" validates it and makes it the published
  revision atomically — that revision never changes again; the next edit starts a new draft from it.
  Rollback publishes a copy of an earlier published revision (its own number, audited).
* **Fields and inheritance.** Each editable field (`FIELDS`) has a state: `inherit` (the parent
  profile's *published* value — a parent's draft never leaks), `local` (this revision's own value,
  even an empty one) or `hidden` (explicitly not shown). The effective value records its source.
  The product selection declares its own mode instead (independent / inherit with additions /
  fully inherit / "כמו הקיוסק"): app/services/digital_effective_rules.py `select`.
* **Publication** freezes what is exposed: the products selected and allowed in the channel at that
  moment — so a product switched on for the web later waits for the next reviewed publication,
  unless its category takes future products automatically. Turning a channel off acts at once.
* **Overlap.** Two published profiles of one target and kind, at one priority, that could be active
  at the same time for the same service, are refused at publication.
* **Starting a profile**: new (defaults), "תואם קיוסק" (online: the kiosk's order linked, its
  selection derived live, the kiosk-like template) or "העתק מ…" (another profile's content, its
  order copied once).

Every write is audited (`presentation_audit`). Blocks, stock and availability are never here.
"""
from __future__ import annotations

import copy
import re
import secrets
import uuid
import weakref
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.presentation_profile import (
    PROFILE_KINDS, PROFILE_LEVELS, SERVICE_TYPES, PresentationAudit, PresentationProfile, PresentationRevision,
)
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.services import digital_effective_rules as ER

#: The editable fields with an inherit / local / hidden state.
FIELDS: Tuple[str, ...] = ("theme", "flow", "texts", "schedule", "productOverrides", "sections", "display")
INHERIT, LOCAL, HIDDEN = "inherit", "local", "hidden"
FIELD_STATES = (INHERIT, LOCAL, HIDDEN)
#: Templates (the editor of the next phase renders them; kiosk_match = the kiosk's own screens).
TEMPLATES = ("classic", "fast_list", "wolt", "kiosk_match", "photo_gallery", "chef", "category_first",
             "meal_builder", "event_express", "returning", "menu_and_cart")
LANGUAGES = ("he", "en", "ar", "ru")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$")
MAX_JSON_CHARS = 200_000

_TENANT_WIDE = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return (value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)).isoformat()


def _name(user: Any) -> Optional[str]:
    n = (getattr(user, "username", None) or getattr(user, "email", None)) if user is not None else None
    return n[:200] if n else None


_READY: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def tables_ready(db: Session) -> bool:
    from sqlalchemy import inspect as sa_inspect

    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001
        return False
    if _READY.get(engine):
        return True
    try:
        known = bool(sa_inspect(db.connection()).has_table(PresentationProfile.__tablename__))
    except Exception:  # noqa: BLE001
        return False
    if known:
        _READY[engine] = True
    return known


def profile_row(db: Session, profile_id: Any) -> Optional[PresentationProfile]:
    ident = _uuid(profile_id)
    return db.get(PresentationProfile, ident) if ident is not None else None


# ── Content ──────────────────────────────────────────────────────────────────


def default_content(kind: str) -> Dict[str, Any]:
    return {
        "theme": {"template": "classic" if kind == "menu" else "wolt", "tokens": {}},
        "flow": {"steps": [] if kind == "menu" else ["service", "products", "cart", "details", "confirm"],
                 "customerFields": {"name": "optional", "phone": "optional"}, "table": "off"},
        "texts": {},
        "schedule": {"access": None, "order": None, "exceptions": []},
        "selection": ER.clean_selection({}),
        "productOverrides": {},
        "sections": [],
        "display": {"soldOut": ER.LABEL, "blocked": ER.LABEL},
    }


def _dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _schedule_one(raw: Any) -> Optional[Dict[str, Any]]:
    """One schedule in the time menus' shape (catalog_menu_rules.schedule_active); None = always."""
    from app.services.catalog_menu_rules import minutes

    if raw is None:
        return None
    raw = _dict(raw)
    days = raw.get("days")
    ranges = []
    for r in raw.get("ranges") or []:
        pair = (r.get("start"), r.get("end")) if isinstance(r, Mapping) else (tuple(r) if isinstance(r, (list, tuple)) and len(r) == 2 else None)
        if pair and minutes(pair[0]) is not None and minutes(pair[1]) is not None:
            ranges.append([pair[0], pair[1]])
    return {
        "always": bool(raw.get("always")),
        "days": sorted({int(d) for d in days if str(d).isdigit() and 0 <= int(d) <= 6}) if isinstance(days, list) else None,
        "ranges": ranges,
        "from": raw.get("from") if isinstance(raw.get("from"), str) else None,
        "to": raw.get("to") if isinstance(raw.get("to"), str) else None,
    }


def clean_schedule(raw: Any) -> Dict[str, Any]:
    """`{"access": schedule | None, "order": schedule | {service: schedule} | None, "exceptions": [...]}`."""
    raw = _dict(raw)
    order = raw.get("order")
    if isinstance(order, Mapping) and any(k in order for k in SERVICE_TYPES):
        order_out: Any = {k: _schedule_one(order.get(k)) for k in SERVICE_TYPES if k in order}
    else:
        order_out = _schedule_one(order)
    exceptions = []
    for e in raw.get("exceptions") or []:
        e = _dict(e)
        if isinstance(e.get("date"), str) and len(e["date"]) == 10:
            exceptions.append({"date": e["date"], "closed": bool(e.get("closed", True)),
                               "ranges": (_schedule_one({"ranges": e.get("ranges")}) or {}).get("ranges", [])})
    return {"access": _schedule_one(raw.get("access")), "order": order_out, "exceptions": exceptions[:200]}


def clean_content(raw: Any, kind: str) -> Dict[str, Any]:
    """A revision's content as sent: known keys, each its shape (an unknown key is dropped)."""
    import json

    raw = _dict(raw)
    base = default_content(kind)
    out: Dict[str, Any] = {}
    for key in ("theme", "flow", "texts", "productOverrides", "display"):
        out[key] = _dict(raw.get(key)) if key in raw else base[key]
    out["sections"] = [s for s in (raw.get("sections") or []) if isinstance(s, Mapping)][:50] if "sections" in raw else base["sections"]
    out["schedule"] = clean_schedule(raw.get("schedule")) if "schedule" in raw else base["schedule"]
    out["selection"] = ER.clean_selection(raw.get("selection")) if "selection" in raw else base["selection"]
    template = _dict(out["theme"]).get("template")
    if template is not None and template not in TEMPLATES:
        raise _bad("invalid_template", "תבנית לא מוכרת")
    display = out["display"]
    for k in ("soldOut", "blocked"):
        if display.get(k) not in (None, ER.LABEL, ER.HIDE):
            raise _bad("invalid_display", "תצוגת אזל / חסום לא מוכרת")
    if len(json.dumps(out, ensure_ascii=False, default=str)) > MAX_JSON_CHARS:
        raise _bad("content_too_large", "התוכן גדול מדי")
    return out


def clean_field_states(raw: Any, has_parent: bool) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for k, v in _dict(raw).items():
        if k in FIELDS and v in FIELD_STATES:
            if v == INHERIT and not has_parent:
                raise _bad("no_parent", "אין ממה לרשת: לפרופיל אין תבנית אב")
            out[k] = v
    return out


def state_of(field: str, states: Mapping[str, str], has_parent: bool) -> str:
    """A field's state: as set; else inherit when there is a parent, local when not."""
    s = states.get(field)
    if s in FIELD_STATES:
        return s
    return INHERIT if has_parent else LOCAL


# ── Targets and reach ────────────────────────────────────────────────────────


@dataclass
class TargetInfo:
    level: str
    id: uuid.UUID
    name: str
    company_id: Optional[uuid.UUID]
    shop_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID]


def target_info(db: Session, level: str, target_id: Any, tenant_id: Any) -> TargetInfo:
    if level not in PROFILE_LEVELS:
        raise _bad("invalid_level", "יעד לא מוכר: חברה, סניף או נקודת מכירה")
    ident = _uuid(target_id)
    if ident is None:
        raise _bad("target_required", "חסר יעד")
    if level == "company":
        c = db.get(Company, ident)
        if c is None or str(c.tenant_id) != str(tenant_id):
            raise _bad("target_not_found", "החברה לא נמצאה", status.HTTP_404_NOT_FOUND)
        return TargetInfo(level, c.id, c.name or "", c.id, None, None)
    if level == "shop":
        s = db.get(Shop, ident)
        if s is None or str(s.tenant_id) != str(tenant_id):
            raise _bad("target_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
        return TargetInfo(level, s.id, s.name or "", s.company_id, s.id, None)
    a = db.get(ShopArea, ident)
    if a is None or str(a.tenant_id) != str(tenant_id) or getattr(a, "archived_at", None) is not None:
        raise _bad("target_not_found", "נקודת המכירה לא נמצאה", status.HTTP_404_NOT_FOUND)
    shop = db.get(Shop, a.shop_id)
    return TargetInfo(level, a.id, a.name or "", shop.company_id if shop else None, a.shop_id, a.id)


def covers(db: Session, user: User, company_id: Any, shop_id: Any) -> bool:
    """The user reaches this place: a company-level target needs the company; a shop's, the shop."""
    from app.services.company_hierarchy import user_covers_company
    from app.services.permission_matrix import SHOP_SCOPED_ROLES

    if user.role in _TENANT_WIDE:
        return True
    if user.role == UserRole.COMPANY_MANAGER:
        return company_id is not None and user_covers_company(db, user, company_id)
    if user.role in SHOP_SCOPED_ROLES:
        return shop_id is not None and str(shop_id) == str(getattr(user, "shop_id", None))
    return False


def check_reach(db: Session, user: User, profile: PresentationProfile, *, write: bool = False) -> None:
    from app.services.permission_matrix import Action, Resource, roles_for

    if write and user.role not in roles_for(Resource.CATALOG, Action.WRITE):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    if not covers(db, user, profile.company_id, profile.shop_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def get_profile(db: Session, user: User, tenant_id: Any, kind: str, profile_id: Any, *, write: bool = False) -> PresentationProfile:
    p = profile_row(db, profile_id)
    if p is None or str(p.tenant_id) != str(tenant_id) or p.kind != kind:
        raise _bad("profile_not_found", "הפרופיל לא נמצא", status.HTTP_404_NOT_FOUND)
    check_reach(db, user, p, write=write)
    return p


# ── Slugs ────────────────────────────────────────────────────────────────────


_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"


def new_slug(db: Session, kind: str, wanted: Optional[str] = None) -> str:
    if wanted:
        slug = wanted.strip().lower()
        if not SLUG_RE.match(slug):
            raise _bad("invalid_slug", "קישור לא תקין: אותיות באנגלית קטנות, ספרות ומקפים (3–60)")
        if db.query(PresentationProfile.id).filter(PresentationProfile.slug == slug).first() is not None:
            raise _bad("slug_taken", "הקישור תפוס", status.HTTP_409_CONFLICT)
        return slug
    for _ in range(20):
        slug = f"{'m' if kind == 'menu' else 'o'}-" + "".join(secrets.choice(_ALPHABET) for _ in range(8))
        if db.query(PresentationProfile.id).filter(PresentationProfile.slug == slug).first() is None:
            return slug
    raise _bad("slug_failed", "לא נמצא קישור פנוי", status.HTTP_500_INTERNAL_SERVER_ERROR)


# ── Audit ────────────────────────────────────────────────────────────────────


def audit(db: Session, profile: PresentationProfile, action: str, user: Any, *, before: Any = None, after: Any = None,
          revision_id: Any = None, reason: Optional[str] = None) -> None:
    db.add(PresentationAudit(
        id=uuid.uuid4(), tenant_id=profile.tenant_id, profile_id=profile.id, revision_id=_uuid(revision_id),
        action=action, actor_user_id=getattr(user, "id", None), actor_name=_name(user),
        before=before, after=after, reason=(reason or None) and reason[:300], created_at=_now(),
    ))


def _meta(p: PresentationProfile) -> Dict[str, Any]:
    return {
        "internalName": p.internal_name, "publicTitle": p.public_title, "slug": p.slug,
        "targetLevel": p.target_level, "targetId": str(p.target_id), "serviceTypes": p.service_types,
        "priceContext": p.price_context, "languages": p.languages, "defaultLanguage": p.default_language,
        "priority": p.priority, "status": p.status,
        "parentProfileId": str(p.parent_profile_id) if p.parent_profile_id else None,
    }


# ── Revisions ────────────────────────────────────────────────────────────────


def revision(db: Session, revision_id: Any) -> Optional[PresentationRevision]:
    ident = _uuid(revision_id)
    return db.get(PresentationRevision, ident) if ident is not None else None


def _next_number(db: Session, profile: PresentationProfile) -> int:
    from sqlalchemy import func

    top = db.query(func.max(PresentationRevision.number)).filter(PresentationRevision.profile_id == profile.id).scalar()
    return int(top or 0) + 1


def _new_revision(db: Session, profile: PresentationProfile, content: Mapping[str, Any], states: Mapping[str, str], *,
                  base: Any = None, user: Any = None, state: str = "draft", note: Optional[str] = None) -> PresentationRevision:
    now = _now()
    row = PresentationRevision(
        id=uuid.uuid4(), tenant_id=profile.tenant_id, profile_id=profile.id, number=_next_number(db, profile),
        state=state, base_revision_id=_uuid(base), content=copy.deepcopy(dict(content)), field_states=dict(states),
        version=1, note=note, created_by_name=_name(user), created_at=now, updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def draft_of(db: Session, profile: PresentationProfile, user: Any = None) -> PresentationRevision:
    """The draft — a new one from the published revision (or the defaults) when there is none."""
    d = revision(db, profile.draft_revision_id)
    if d is not None and d.state == "draft":
        return d
    pub = revision(db, profile.published_revision_id)
    if pub is not None:
        d = _new_revision(db, profile, pub.content, pub.field_states or {}, base=pub.id, user=user)
    else:
        d = _new_revision(db, profile, default_content(profile.kind), {}, user=user)
    profile.draft_revision_id = d.id
    db.flush()
    return d


def put_draft(db: Session, profile: PresentationProfile, *, content: Any, field_states: Any, version: Optional[int],
              user: Any = None) -> PresentationRevision:
    """Replace the draft's content (autosave). 409 `revision_changed` when `version` is not the draft's."""
    if profile.status == "archived":
        raise _bad("archived", "הפרופיל בארכיון")
    d = draft_of(db, profile, user)
    if version is not None and version != d.version:
        raise _bad("revision_changed", "הטיוטה השתנתה מאז שנטענה — טענו מחדש", status.HTTP_409_CONFLICT, version=d.version)
    has_parent = profile.parent_profile_id is not None
    cleaned = clean_content(content, profile.kind)
    states = clean_field_states(field_states, has_parent) if field_states is not None else dict(d.field_states or {})
    d.content = cleaned
    d.field_states = states
    d.version = (d.version or 0) + 1
    d.updated_at = _now()
    if profile.status == "saved":
        profile.status = "draft" if profile.published_revision_id is None else profile.status
    db.flush()
    return d


def save_draft(db: Session, profile: PresentationProfile, user: Any = None, version: Optional[int] = None) -> PresentationRevision:
    """"שמור": the draft is marked saved (a profile never published becomes "saved")."""
    d = draft_of(db, profile, user)
    if version is not None and version != d.version:
        raise _bad("revision_changed", "הטיוטה השתנתה מאז שנטענה — טענו מחדש", status.HTTP_409_CONFLICT, version=d.version)
    d.saved_at = _now()
    d.saved_by_name = _name(user)
    if profile.status == "draft":
        profile.status = "saved"
    audit(db, profile, "save", user, revision_id=d.id)
    db.flush()
    return d


# ── Inheritance ──────────────────────────────────────────────────────────────


def parent_chain(db: Session, profile: PresentationProfile) -> List[PresentationProfile]:
    """The profile's ancestors, nearest first (a loop is cut)."""
    out: List[PresentationProfile] = []
    seen = {profile.id}
    cur = profile_row(db, profile.parent_profile_id)
    while cur is not None and cur.id not in seen:
        out.append(cur)
        seen.add(cur.id)
        cur = profile_row(db, cur.parent_profile_id)
    return out


def effective_fields(db: Session, profile: PresentationProfile, rev: Optional[PresentationRevision]) -> Dict[str, Any]:
    """
    Each field's effective value with its state and source: `{field: {"value", "state", "source":
    {"profileId", "revision", "kind": "local" | "inherited" | "hidden" | "default"}}}`. Inherited values
    come from the ancestors' *published* revisions only.
    """
    has_parent = profile.parent_profile_id is not None
    content = (rev.content if rev is not None else None) or default_content(profile.kind)
    states = (rev.field_states if rev is not None else None) or {}
    defaults = default_content(profile.kind)
    out: Dict[str, Any] = {}
    for f in FIELDS:
        st = state_of(f, states, has_parent)
        if st == LOCAL:
            out[f] = {"value": content.get(f, defaults[f]), "state": st,
                      "source": {"profileId": str(profile.id), "revision": rev.number if rev else None, "kind": "local"}}
            continue
        if st == HIDDEN:
            out[f] = {"value": None, "state": st, "source": {"profileId": str(profile.id), "revision": rev.number if rev else None, "kind": "hidden"}}
            continue
        value, source = None, None
        for ancestor in parent_chain(db, profile):
            pub = revision(db, ancestor.published_revision_id)
            if pub is None:
                continue
            a_has_parent = ancestor.parent_profile_id is not None
            a_state = state_of(f, pub.field_states or {}, a_has_parent)
            if a_state == INHERIT:
                continue
            if a_state == HIDDEN:
                value, source = None, {"profileId": str(ancestor.id), "revision": pub.number, "kind": "hidden"}
            else:
                value = (pub.content or {}).get(f, defaults[f])
                source = {"profileId": str(ancestor.id), "revision": pub.number, "kind": "inherited"}
            break
        if source is None:
            value, source = defaults[f], {"profileId": None, "revision": None, "kind": "default"}
        out[f] = {"value": value, "state": st, "source": source}
    return out


# ── Publication ──────────────────────────────────────────────────────────────


def _week_slots() -> List[datetime]:
    """Every quarter hour of one reference week (local wall clock), for the overlap check."""
    start = datetime(2026, 1, 4)  # a Sunday
    return [start + timedelta(minutes=15 * i) for i in range(7 * 24 * 4)]


def _order_schedule(content: Mapping[str, Any], service: str) -> Optional[Dict[str, Any]]:
    order = _dict(content.get("schedule")).get("order")
    if isinstance(order, Mapping) and any(k in order for k in SERVICE_TYPES):
        return order.get(service)
    return order


def _access_schedule(content: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    return _dict(content.get("schedule")).get("access")


def schedules_overlap(a: Optional[Mapping[str, Any]], b: Optional[Mapping[str, Any]]) -> bool:
    from app.services.catalog_menu_rules import schedule_active

    if a is None or b is None:
        return True
    return any(schedule_active(dict(a), t) and schedule_active(dict(b), t) for t in _week_slots())


def overlapping(db: Session, profile: PresentationProfile, content: Mapping[str, Any]) -> List[PresentationProfile]:
    """Published profiles of the same target and kind at the same priority that may be active together."""
    others = db.query(PresentationProfile).filter(
        PresentationProfile.tenant_id == profile.tenant_id,
        PresentationProfile.kind == profile.kind,
        PresentationProfile.target_level == profile.target_level,
        PresentationProfile.target_id == profile.target_id,
        PresentationProfile.priority == profile.priority,
        PresentationProfile.status == "published",
        PresentationProfile.id != profile.id,
    ).all()
    out = []
    mine = set(profile.service_types or [])
    for o in others:
        pub = revision(db, o.published_revision_id)
        if pub is None:
            continue
        shared = mine & set(o.service_types or []) if profile.kind == "online" else {None}
        if profile.kind == "online" and not shared:
            continue
        if profile.kind == "menu":
            hit = schedules_overlap(_access_schedule(content), _access_schedule(pub.content or {}))
        else:
            hit = any(schedules_overlap(_order_schedule(content, s), _order_schedule(pub.content or {}, s)) for s in shared)
        if hit:
            out.append(o)
    return out


def validate(db: Session, profile: PresentationProfile, rev: PresentationRevision) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    """`(errors, warnings, exposure)` for publishing this revision."""
    from app.services import digital_effective as DE

    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    title = _dict(profile.public_title)
    if not (title.get(profile.default_language) or "").strip():
        errors.append({"code": "title_required", "message": "חסרה כותרת ציבורית בשפת ברירת המחדל"})
    if not profile.languages or profile.default_language not in (profile.languages or []):
        errors.append({"code": "languages_required", "message": "בחרו לפחות שפה אחת, כולל שפת ברירת המחדל"})
    if profile.kind == "online" and not profile.service_types:
        errors.append({"code": "service_required", "message": "באתר הזמנות יש לבחור לפחות סוג שירות אחד"})
    try:
        target_info(db, profile.target_level, profile.target_id, profile.tenant_id)
    except HTTPException:
        errors.append({"code": "target_missing", "message": "היעד של הפרופיל לא קיים יותר"})
    exposure = DE.exposure_for(db, profile, rev)
    if not exposure["products"] and not exposure["includeFuture"]:
        errors.append({"code": "nothing_exposed", "message": "אין אף מוצר שנבחר ומותר בערוץ — אין מה לפרסם"})
    if exposure.get("channelOff"):
        warnings.append({"code": "channel_off", "message": f"{len(exposure['channelOff'])} מוצרים שנבחרו כבויים בערוץ ולא יוצגו",
                         "count": len(exposure["channelOff"]), "sample": exposure["channelOff"][:10]})
    clash = overlapping(db, profile, rev.content or {})
    if clash:
        errors.append({"code": "overlap", "message": "פרופיל מפורסם אחר לאותו יעד, באותה עדיפות ובאותן שעות",
                       "profiles": [{"id": str(o.id), "name": o.internal_name} for o in clash]})
    return errors, warnings, exposure


def publish(db: Session, profile: PresentationProfile, user: Any = None, *, note: Optional[str] = None,
            version: Optional[int] = None) -> PresentationRevision:
    """Validate the draft and make it the published revision — atomically for this target (the caller commits)."""
    if profile.status == "archived":
        raise _bad("archived", "הפרופיל בארכיון")
    d = draft_of(db, profile, user)
    if version is not None and version != d.version:
        raise _bad("revision_changed", "הטיוטה השתנתה מאז שנטענה — טענו מחדש", status.HTTP_409_CONFLICT, version=d.version)
    errors, warnings, exposure = validate(db, profile, d)
    if errors:
        raise _bad("publish_refused", "אי אפשר לפרסם", errors=errors, warnings=warnings)
    now = _now()
    before = {"publishedRevision": _rev_number(db, profile.published_revision_id), "status": profile.status}
    old = revision(db, profile.published_revision_id)
    if old is not None and old.id != d.id:
        old.state = "retired"
    d.state = "published"
    d.exposure = exposure
    d.note = (note or d.note or None) and (note or d.note)[:300]
    d.published_at = now
    d.published_by_name = _name(user)
    profile.published_revision_id = d.id
    profile.draft_revision_id = None
    profile.status = "published"
    profile.published_at = now
    profile.updated_by_name = _name(user)
    audit(db, profile, "publish", user, before=before, after={"publishedRevision": d.number, "warnings": warnings},
          revision_id=d.id, reason=note)
    db.flush()
    return d


def _rev_number(db: Session, revision_id: Any) -> Optional[int]:
    r = revision(db, revision_id)
    return r.number if r is not None else None


def rollback(db: Session, profile: PresentationProfile, revision_id: Any, user: Any = None, *, reason: Optional[str] = None) -> PresentationRevision:
    """Publish again an earlier published revision — as a new revision (its own number, audited)."""
    old = revision(db, revision_id)
    if old is None or old.profile_id != profile.id or old.state not in ("published", "retired"):
        raise _bad("revision_not_found", "הרביזיה לא נמצאה או שלא פורסמה", status.HTTP_404_NOT_FOUND)
    draft = revision(db, profile.draft_revision_id)
    if draft is not None and draft.state == "draft":
        # The draft in progress is kept as it was, recorded in the audit; the copy becomes the draft to publish.
        audit(db, profile, "draft_replaced", user, before={"draftRevision": draft.number}, revision_id=draft.id)
        draft.state = "retired"
    copy_rev = _new_revision(db, profile, old.content, old.field_states or {}, base=old.id, user=user,
                             note=f"חזרה לרביזיה {old.number}")
    profile.draft_revision_id = copy_rev.id
    db.flush()
    pub = publish(db, profile, user, note=reason or f"חזרה לרביזיה {old.number}")
    audit(db, profile, "rollback", user, before={"to": old.number}, after={"publishedRevision": pub.number}, revision_id=pub.id, reason=reason)
    return pub


def set_status(db: Session, profile: PresentationProfile, action: str, user: Any = None, *, reason: Optional[str] = None) -> None:
    """pause / resume / archive / unarchive."""
    before = profile.status
    if action == "pause":
        if profile.status != "published":
            raise _bad("not_published", "רק פרופיל מפורסם אפשר להשהות")
        profile.status = "paused"
    elif action == "resume":
        if profile.status != "paused":
            raise _bad("not_paused", "הפרופיל אינו מושהה")
        pub = revision(db, profile.published_revision_id)
        if pub is not None and overlapping(db, profile, pub.content or {}):
            raise _bad("overlap", "פרופיל מפורסם אחר לאותו יעד, באותה עדיפות ובאותן שעות", status.HTTP_409_CONFLICT)
        profile.status = "published"
    elif action == "archive":
        if profile.status == "archived":
            return
        profile.status = "archived"
        profile.archived_at = _now()
    elif action == "unarchive":
        if profile.status != "archived":
            raise _bad("not_archived", "הפרופיל אינו בארכיון")
        profile.status = "paused" if profile.published_revision_id else "draft"
        profile.archived_at = None
    else:
        raise _bad("invalid_action", "פעולה לא מוכרת")
    profile.updated_by_name = _name(user)
    profile.version = (profile.version or 0) + 1
    audit(db, profile, action, user, before={"status": before}, after={"status": profile.status}, reason=reason)
    db.flush()


# ── Creating and editing a profile ───────────────────────────────────────────


def _clean_meta(body: Mapping[str, Any], kind: str, *, partial: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "internalName" in body or not partial:
        name = str(body.get("internalName") or "").strip()
        if not name:
            raise _bad("name_required", "חסר שם פנימי")
        out["internal_name"] = name[:120]
    if "publicTitle" in body:
        title = {k: str(v).strip()[:160] for k, v in _dict(body.get("publicTitle")).items() if k in LANGUAGES and v is not None}
        out["public_title"] = title
    if "serviceTypes" in body or not partial:
        raw = body.get("serviceTypes")
        types = [s for s in (raw if isinstance(raw, list) else (list(SERVICE_TYPES) if kind == "online" else [])) if s in SERVICE_TYPES]
        out["service_types"] = list(dict.fromkeys(types))
    if "languages" in body or not partial:
        langs = [l for l in (body.get("languages") or ["he"]) if l in LANGUAGES]
        out["languages"] = list(dict.fromkeys(langs)) or ["he"]
    if "defaultLanguage" in body or not partial:
        lang = body.get("defaultLanguage") or "he"
        if lang not in LANGUAGES:
            raise _bad("invalid_language", "שפה לא מוכרת")
        out["default_language"] = lang
    if "priority" in body:
        try:
            out["priority"] = max(-100, min(100, int(body.get("priority") or 0)))
        except (TypeError, ValueError):
            raise _bad("invalid_priority", "עדיפות לא תקינה")
    if "priceContext" in body or not partial:
        pc = _dict(body.get("priceContext")) or {"mode": "target"}
        if pc.get("mode") not in ("target", "catalog_menu"):
            raise _bad("invalid_price_context", "הקשר מחיר לא מוכר")
        if pc["mode"] == "catalog_menu" and not _uuid(pc.get("menuId")):
            raise _bad("invalid_price_context", "בחרו תפריט למחירים")
        out["price_context"] = {"mode": pc["mode"], **({"menuId": str(pc["menuId"])} if pc["mode"] == "catalog_menu" else {})}
    return out


def create(db: Session, user: User, tenant_id: Any, kind: str, body: Mapping[str, Any]) -> PresentationProfile:
    """A new profile with a first draft — "התחל חדש", "תואם קיוסק" or "העתק מ…" (`body["start"]`)."""
    from app.services import display_ordering as DO
    from app.services.permission_matrix import Action, Resource, roles_for

    if kind not in PROFILE_KINDS:
        raise _bad("invalid_kind", "סוג פרופיל לא מוכר")
    if user.role not in roles_for(Resource.CATALOG, Action.WRITE):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    target = target_info(db, str(body.get("targetLevel") or ""), body.get("targetId"), tenant_id)
    if not covers(db, user, target.company_id, target.shop_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    meta = _clean_meta(body, kind, partial=False)
    parent = None
    if body.get("parentProfileId"):
        parent = profile_row(db, body.get("parentProfileId"))
        if parent is None or str(parent.tenant_id) != str(tenant_id) or parent.kind != kind:
            raise _bad("parent_not_found", "תבנית האב לא נמצאה", status.HTTP_404_NOT_FOUND)
        if PROFILE_LEVELS.index(parent.target_level) >= PROFILE_LEVELS.index(target.level):
            raise _bad("parent_level", "תבנית אב חייבת להיות ברמה רחבה יותר (חברה ← סניף ← נקודה)")
    start = _dict(body.get("start")) or {"mode": "new"}
    mode = start.get("mode") or "new"
    if mode not in ("new", "match_kiosk", "copy"):
        raise _bad("invalid_start", "דרך התחלה לא מוכרת")
    now = _now()
    profile = PresentationProfile(
        id=uuid.uuid4(), tenant_id=_uuid(tenant_id), kind=kind, slug=new_slug(db, kind, body.get("slug")),
        target_level=target.level, target_id=target.id, company_id=target.company_id, shop_id=target.shop_id,
        area_id=target.area_id, priority=int(body.get("priority") or 0) if str(body.get("priority") or "0").lstrip("-").isdigit() else 0,
        status="draft", parent_profile_id=parent.id if parent is not None else None,
        public_title=meta.pop("public_title", {}) or {}, created_by_user_id=getattr(user, "id", None),
        created_by_name=_name(user), updated_by_name=_name(user), version=1, created_at=now, updated_at=now,
        **meta,
    )
    db.add(profile)
    db.flush()
    content = default_content(kind)
    states: Dict[str, str] = {}
    created_from: Dict[str, Any] = {"mode": mode}
    profile_target = DO.Target("profile", profile.id, profile.tenant_id, profile.internal_name,
                               company_id=profile.company_id, shop_id=profile.shop_id, area_id=profile.area_id)
    channel = kind
    if mode == "match_kiosk":
        src_level = start.get("level")
        if src_level not in ("company", "shop", "machine"):
            raise _bad("invalid_kiosk_source", "בחרו קיוסק, סניף או חברה להתאמה")
        source = DO.resolve_target(db, src_level, start.get("targetId"), tenant_id)
        if not covers(db, user, source.company_id, source.shop_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        content["theme"] = {"template": "kiosk_match", "tokens": {}, "source": {"level": src_level, "targetId": str(source.id)}}
        content["selection"] = ER.clean_selection({"mode": "kiosk", "source": {"level": src_level, "targetId": str(source.id)}})
        # The order: linked to the kiosk's — the same ordering, moving together, until unlinked.
        DO.link(db, profile_target, channel, source, "kiosk", user=user)
        created_from["source"] = {"level": src_level, "targetId": str(source.id), "name": source.name}
    elif mode == "copy":
        src = profile_row(db, start.get("profileId"))
        if src is None or str(src.tenant_id) != str(tenant_id):
            raise _bad("source_not_found", "הפרופיל להעתקה לא נמצא", status.HTTP_404_NOT_FOUND)
        check_reach(db, user, src)
        which = start.get("revision") or "published"
        src_rev = revision(db, src.published_revision_id) if which == "published" else revision(db, src.draft_revision_id)
        src_rev = src_rev or revision(db, src.draft_revision_id) or revision(db, src.published_revision_id)
        if src_rev is not None:
            content = clean_content(src_rev.content, kind)
            states = {k: v for k, v in (src_rev.field_states or {}).items() if k in FIELDS and (v != INHERIT or parent is not None)}
        src_target = DO.Target("profile", src.id, src.tenant_id, src.internal_name, company_id=src.company_id,
                               shop_id=src.shop_id, area_id=src.area_id)
        DO.copy_from(db, profile_target, channel, src_target, src.kind, user=user)
        created_from.update({"profileId": str(src.id), "name": src.internal_name,
                             "revision": src_rev.number if src_rev is not None else None})
    profile.created_from = created_from
    d = _new_revision(db, profile, content, states, user=user)
    profile.draft_revision_id = d.id
    audit(db, profile, "create", user, after={**_meta(profile), "createdFrom": created_from}, revision_id=d.id)
    db.flush()
    return profile


def update_meta(db: Session, profile: PresentationProfile, body: Mapping[str, Any], user: Any = None,
                *, version: Optional[int] = None) -> PresentationProfile:
    """The profile's own fields; `version` checked (409 `profile_changed`)."""
    if version is not None and version != profile.version:
        raise _bad("profile_changed", "הפרופיל השתנה מאז שנטען — טענו מחדש", status.HTTP_409_CONFLICT, version=profile.version)
    before = _meta(profile)
    meta = _clean_meta(body, profile.kind, partial=True)
    for k, v in meta.items():
        setattr(profile, k, v)
    if "slug" in body and body.get("slug") != profile.slug:
        if profile.published_revision_id is not None:
            raise _bad("slug_fixed", "הקישור קבוע אחרי פרסום (קישורים ו-QR כבר בשימוש)")
        profile.slug = new_slug(db, profile.kind, body.get("slug"))
    if "parentProfileId" in body:
        pid = body.get("parentProfileId")
        if pid:
            parent = profile_row(db, pid)
            if parent is None or parent.tenant_id != profile.tenant_id or parent.kind != profile.kind or parent.id == profile.id:
                raise _bad("parent_not_found", "תבנית האב לא נמצאה", status.HTTP_404_NOT_FOUND)
            if PROFILE_LEVELS.index(parent.target_level) >= PROFILE_LEVELS.index(profile.target_level):
                raise _bad("parent_level", "תבנית אב חייבת להיות ברמה רחבה יותר (חברה ← סניף ← נקודה)")
            if profile.id in {p.id for p in parent_chain(db, parent)}:
                raise _bad("parent_loop", "הירושה יוצרת מעגל")
            profile.parent_profile_id = parent.id
        else:
            profile.parent_profile_id = None
    profile.version = (profile.version or 0) + 1
    profile.updated_by_name = _name(user)
    profile.updated_at = _now()
    audit(db, profile, "update", user, before=before, after=_meta(profile))
    db.flush()
    return profile


# ── Reading ──────────────────────────────────────────────────────────────────


def revision_out(rev: Optional[PresentationRevision]) -> Optional[Dict[str, Any]]:
    if rev is None:
        return None
    return {
        "id": str(rev.id), "number": rev.number, "state": rev.state, "version": rev.version,
        "baseRevisionId": str(rev.base_revision_id) if rev.base_revision_id else None,
        "content": rev.content, "fieldStates": rev.field_states or {}, "note": rev.note,
        "savedAt": _iso(rev.saved_at), "savedBy": rev.saved_by_name,
        "publishedAt": _iso(rev.published_at), "publishedBy": rev.published_by_name,
        "exposedCount": len((rev.exposure or {}).get("products") or []) if rev.exposure else None,
        "createdAt": _iso(rev.created_at), "updatedAt": _iso(rev.updated_at),
    }


def _target_name(db: Session, profile: PresentationProfile) -> Optional[str]:
    try:
        return target_info(db, profile.target_level, profile.target_id, profile.tenant_id).name
    except HTTPException:
        return None


def profile_out(db: Session, profile: PresentationProfile, *, counts: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    pub = revision(db, profile.published_revision_id)
    draft = revision(db, profile.draft_revision_id)
    states = (draft or pub).field_states if (draft or pub) is not None else {}
    has_parent = profile.parent_profile_id is not None
    inherited = sum(1 for f in FIELDS if state_of(f, states or {}, has_parent) == INHERIT)
    return {
        "id": str(profile.id), "kind": profile.kind, "internalName": profile.internal_name,
        "publicTitle": profile.public_title or {}, "slug": profile.slug,
        "targetLevel": profile.target_level, "targetId": str(profile.target_id), "targetName": _target_name(db, profile),
        "companyId": str(profile.company_id) if profile.company_id else None,
        "shopId": str(profile.shop_id) if profile.shop_id else None,
        "areaId": str(profile.area_id) if profile.area_id else None,
        "serviceTypes": profile.service_types or [], "priceContext": profile.price_context or {"mode": "target"},
        "languages": profile.languages or [], "defaultLanguage": profile.default_language,
        "priority": profile.priority, "status": profile.status, "version": profile.version,
        "parentProfileId": str(profile.parent_profile_id) if profile.parent_profile_id else None,
        "createdFrom": profile.created_from,
        "publishedRevision": pub.number if pub is not None else None,
        "publishedAt": _iso(profile.published_at),
        "hasDraftChanges": draft is not None and draft.state == "draft" and (pub is None or draft.version > 1 or draft.content != pub.content),
        "draftRevision": draft.number if draft is not None and draft.state == "draft" else None,
        "inheritedFields": inherited, "localFields": len(FIELDS) - inherited,
        "updatedAt": _iso(profile.updated_at), "updatedBy": profile.updated_by_name,
        **({"counts": counts} if counts is not None else {}),
    }


def detail(db: Session, profile: PresentationProfile) -> Dict[str, Any]:
    pub = revision(db, profile.published_revision_id)
    draft = revision(db, profile.draft_revision_id)
    history = (
        db.query(PresentationRevision)
        .filter(PresentationRevision.profile_id == profile.id, PresentationRevision.state.in_(["published", "retired"]))
        .order_by(PresentationRevision.number.desc())
        .limit(50)
        .all()
    )
    return {
        "profile": profile_out(db, profile),
        "draft": revision_out(draft if draft is not None and draft.state == "draft" else None),
        "published": revision_out(pub),
        "effective": effective_fields(db, profile, draft if draft is not None and draft.state == "draft" else pub),
        "history": [
            {"id": str(r.id), "number": r.number, "state": r.state, "publishedAt": _iso(r.published_at),
             "publishedBy": r.published_by_name, "note": r.note}
            for r in history if r.published_at is not None
        ],
    }


def list_profiles(db: Session, user: User, tenant_id: Any, kind: str, *, company_id: Any = None, shop_id: Any = None,
                  area_id: Any = None, status_: Optional[str] = None, search: Optional[str] = None,
                  service: Optional[str] = None, language: Optional[str] = None, with_counts: bool = True) -> List[Dict[str, Any]]:
    from app.services import digital_effective as DE

    if not tables_ready(db):
        return []
    q = db.query(PresentationProfile).filter(
        PresentationProfile.tenant_id == _uuid(tenant_id), PresentationProfile.kind == kind,
    )
    if company_id:
        q = q.filter(PresentationProfile.company_id == _uuid(company_id))
    if shop_id:
        q = q.filter(PresentationProfile.shop_id == _uuid(shop_id))
    if area_id:
        q = q.filter(PresentationProfile.area_id == _uuid(area_id))
    if status_:
        q = q.filter(PresentationProfile.status == status_)
    elif status_ is None:
        q = q.filter(PresentationProfile.status != "archived")
    rows = q.order_by(PresentationProfile.target_level, PresentationProfile.internal_name).all()
    out = []
    for p in rows:
        if not covers(db, user, p.company_id, p.shop_id):
            continue
        if search and search.strip().lower() not in (p.internal_name or "").lower() and search.strip().lower() not in (p.slug or ""):
            continue
        if service and service not in (p.service_types or []):
            continue
        if language and language not in (p.languages or []):
            continue
        counts = DE.profile_counts(db, p) if with_counts else None
        out.append(profile_out(db, p, counts=counts))
    return out
