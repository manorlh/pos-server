"""
"הרשאות דשבורד" — per dashboard user: which sections they may open (view / edit), and which
part of the organization their data comes from. Models in app/models/dashboard_access.py, the
section catalogue and the route → section table in app/services/dashboard_sections.py.

How it is enforced, server side:

* **Sections** — `enforce_route` runs inside `get_current_user` (and the sync paths' user
  branch), i.e. exactly where a dashboard user is identified, so no dashboard route can be
  reached without it. It looks the route up in `ROUTE_RULES` and refuses (403
  `section_forbidden`) a restricted user who lacks the section at the level the route needs.
  A route with no rule is refused for a restricted user (and fails the route-registry test).
* **Org scope** — the central scoping helpers (app/services/company_hierarchy.py:
  `company_scope_ids`, `user_covers_company`, `user_covers_shop`, `visible_shop_ids`,
  `user_may_use_machine`, `catalog_company_ids`; app/services/scoping.py) read `profile_scope`,
  so every list and every access check that already went through them follows the profile.
  The organizations themselves are the tenant memberships `get_active_tenant_id` checks.

Who is unaffected: the super admin, always; and a user whose profile is `full_access` (every
user that existed before this — the migration maps them so — and anyone given it). A new user
gets "מנהל ארגון": reports (view), products (edit), Z (view) — everything else is closed until
the super admin opens it. A user with no profile row at all (made by a path that writes none)
gets that same default (the owner, 08.10.2026), never more.

Who grants: the super admin anything; any other manager of users (the `users` section at edit,
over a user their role may manage) only what they hold themselves — a section at most at their
own level, "full access" only if they have it, an org scope only inside their own.

A section grant never widens what the role allows: it only lets the route's own role checks and
org scoping run. Nothing here is consulted for till tokens (machine JWTs) — till users are
"תפקידים והרשאות בקופה", a different thing.
"""
from __future__ import annotations

import uuid
import weakref
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.models.dashboard_access import DashboardAccessAudit, DashboardAccessProfile, DashboardAccessTemplate
from app.models.user import User, UserRole
from app.services import dashboard_sections as DS

SECTION_FORBIDDEN = "section_forbidden"

_MEMO_KEY = "dashboard_access_memo"
_ORG_COMPANIES_KEY = "dashboard_access_org_companies"


# ── Reading a user's access ──────────────────────────────────────────────────


@dataclass(frozen=True)
class EffectiveAccess:
    #: False: everything the role allows (super admin, full access, no profile).
    restricted: bool
    sections: Dict[str, str] = field(default_factory=dict)
    org_wide: bool = False
    company_ids: Tuple[uuid.UUID, ...] = ()
    shop_ids: Tuple[uuid.UUID, ...] = ()
    has_profile: bool = False
    full_access: bool = True
    template: Optional[str] = None

    @property
    def narrows_org(self) -> bool:
        return self.org_wide or bool(self.company_ids) or bool(self.shop_ids)

    def allows(self, section: str, level: str) -> bool:
        if not self.restricted:
            return True
        return DS.level_allows(self.sections.get(section), level)


UNRESTRICTED = EffectiveAccess(restricted=False)

#: A user with no profile row: "מנהל ארגון"'s sections, the role's own org scope.
DEFAULT_ACCESS = EffectiveAccess(
    restricted=True,
    sections=dict(DS.ORG_MANAGER_SECTIONS),
    has_profile=False,
    full_access=False,
    template=DS.ORG_MANAGER_TEMPLATE,
)

_TABLE_CACHE: "weakref.WeakKeyDictionary[Any, bool]" = weakref.WeakKeyDictionary()


def _has_profiles_table(db: Session) -> bool:
    """
    A database without the table has no profiles. Production always has it (the migration,
    and `create_all` at start-up); unit tests that build only the tables they need do not,
    and there every user simply keeps the role's access.
    """
    try:
        bind = db.get_bind()
    except Exception:  # noqa: BLE001 - a stand-in session without a bind
        return False
    engine = getattr(bind, "engine", bind)
    try:
        cached = _TABLE_CACHE.get(engine)
    except TypeError:
        cached = None
    if cached:
        return True
    try:
        # On the session's own connection: checking one out of the pool (and returning it,
        # which resets it) must not touch the transaction the request is in.
        present = sa_inspect(db.connection()).has_table(DashboardAccessProfile.__tablename__)
    except Exception:  # noqa: BLE001
        return False
    if present:
        try:
            _TABLE_CACHE[engine] = True
        except TypeError:
            pass
    return present


def _memo(db: Session) -> Optional[dict]:
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return None
    memo = info.get(_MEMO_KEY)
    if not isinstance(memo, dict):
        memo = {}
        info[_MEMO_KEY] = memo
    return memo


def forget(db: Session) -> None:
    """Drop the per-session memo after a write."""
    info = getattr(db, "info", None)
    if isinstance(info, dict):
        info.pop(_MEMO_KEY, None)
        info.pop(_ORG_COMPANIES_KEY, None)


def _uuids(raw) -> Tuple[uuid.UUID, ...]:
    out: List[uuid.UUID] = []
    for item in raw or []:
        try:
            parsed = item if isinstance(item, uuid.UUID) else uuid.UUID(str(item))
        except (TypeError, ValueError, AttributeError):
            continue
        if parsed not in out:
            out.append(parsed)
    return tuple(out)


def _from_profile(profile: Optional[DashboardAccessProfile]) -> EffectiveAccess:
    if profile is None:
        return DEFAULT_ACCESS
    template = profile.builtin_template or (str(profile.template_id) if profile.template_id else None)
    return EffectiveAccess(
        restricted=not bool(profile.full_access),
        sections=DS.clean_sections(profile.sections),
        org_wide=bool(profile.org_wide),
        company_ids=_uuids(profile.company_ids),
        shop_ids=_uuids(profile.shop_ids),
        has_profile=True,
        full_access=bool(profile.full_access),
        template=template,
    )


def profiles_available(db: Session) -> bool:
    """A real session on a database that has profiles (unit tests' stand-ins have neither)."""
    return isinstance(db, Session) and _has_profiles_table(db)


def load_profile(db: Session, user_id) -> Optional[DashboardAccessProfile]:
    if user_id is None or not profiles_available(db):
        return None
    try:
        key = user_id if isinstance(user_id, uuid.UUID) else uuid.UUID(str(user_id))
    except (TypeError, ValueError):
        return None
    return db.get(DashboardAccessProfile, key)


def effective_access(db: Session, user: Any) -> EffectiveAccess:
    """What `user` may open, memoised for the session (one request)."""
    if user is None or getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return UNRESTRICTED
    user_id = getattr(user, "id", None)
    if user_id is None:
        return UNRESTRICTED
    memo = _memo(db)
    if memo is not None and user_id in memo:
        return memo[user_id]
    if not profiles_available(db):
        # No profiles here at all (a unit test's stand-in session): the role decides.
        access = UNRESTRICTED
    else:
        # No row: the default, "מנהל ארגון" — never "everything".
        access = _from_profile(load_profile(db, user_id))
    if memo is not None:
        memo[user_id] = access
    return access


# ── Granting: only what you hold ─────────────────────────────────────────────

_RANK = {None: 0, DS.VIEW: 1, DS.EDIT: 2}


def grantable(access: EffectiveAccess) -> Dict[str, str]:
    """The highest level of each section this person may give someone else."""
    if not access.restricted:
        return {s.id: DS.EDIT for s in DS.SECTIONS}
    return dict(access.sections)


def cap_sections(sections: Dict[str, str], limit: Dict[str, str]) -> Dict[str, str]:
    """Each section at most at `limit`'s level (dropped where `limit` has none)."""
    out: Dict[str, str] = {}
    for sid, level in DS.clean_sections(sections).items():
        ceiling = limit.get(sid)
        if ceiling is None:
            continue
        out[sid] = level if _RANK[level] <= _RANK[ceiling] else ceiling
    return out


def sections_over(wanted: Dict[str, str], current: Dict[str, str], limit: Dict[str, str]) -> List[str]:
    """
    Sections `wanted` gives above both what the user already had and what the granter holds.
    Lowering or keeping is always allowed; raising only up to the granter's own level.
    """
    over = []
    for sid, level in DS.clean_sections(wanted).items():
        if _RANK[level] > max(_RANK[current.get(sid)], _RANK[limit.get(sid)]):
            over.append(sid)
    return over


# ── Org scope, for the central scoping helpers ───────────────────────────────


@dataclass(frozen=True)
class ProfileScope:
    org_wide: bool
    company_ids: Tuple[uuid.UUID, ...]
    shop_ids: Tuple[uuid.UUID, ...]


def profile_scope(db: Session, user: Any) -> Optional[ProfileScope]:
    """
    The org narrowing of a company-level manager's profile, or None (the role's own scope).

    Only company managers are scoped by company in this codebase, so only they read it: a
    shop-level role's world is its shop (`users.shop_id`), a distributor's its tills.
    """
    if getattr(user, "role", None) != UserRole.COMPANY_MANAGER:
        return None
    access = effective_access(db, user)
    if not access.has_profile or not access.narrows_org:
        return None
    return ProfileScope(access.org_wide, access.company_ids, access.shop_ids)


def user_tenant_ids(db: Session, user: Any) -> List[uuid.UUID]:
    """The user's organizations: their home tenant and every membership."""
    from app.models.tenant_membership import TenantMembership

    out: List[uuid.UUID] = []
    home = getattr(user, "tenant_id", None)
    if home is not None:
        out.append(home if isinstance(home, uuid.UUID) else uuid.UUID(str(home)))
    user_id = getattr(user, "id", None)
    if user_id is not None and isinstance(db, Session):
        for (tid,) in db.query(TenantMembership.tenant_id).filter(TenantMembership.user_id == user_id).all():
            if tid not in out:
                out.append(tid)
    return out


def org_company_ids(db: Session, user: Any) -> List[uuid.UUID]:
    """Every company of the user's organizations (an org-wide manager's company scope)."""
    from app.models.company import Company

    info = getattr(db, "info", None)
    key = (_ORG_COMPANIES_KEY, getattr(user, "id", None))
    if isinstance(info, dict) and key in info:
        return list(info[key])
    tenants = user_tenant_ids(db, user)
    ids = [cid for (cid,) in db.query(Company.id).filter(Company.tenant_id.in_(tenants)).order_by(Company.created_at).all()] if tenants else []
    if isinstance(info, dict):
        info[key] = list(ids)
    return ids


def shop_allowed(db: Session, user: Any, shop_id) -> bool:
    """False only when the profile lists shops and this is not one of them."""
    scope = profile_scope(db, user)
    if scope is None or not scope.shop_ids:
        return True
    if shop_id is None:
        return False
    try:
        parsed = shop_id if isinstance(shop_id, uuid.UUID) else uuid.UUID(str(shop_id))
    except (TypeError, ValueError):
        return False
    return parsed in scope.shop_ids


# ── Enforcement ──────────────────────────────────────────────────────────────


def _api_path(path: str) -> str:
    from app.config import get_settings

    prefix = get_settings().api_v1_prefix or ""
    if prefix and path.startswith(prefix):
        return path[len(prefix):] or "/"
    return path


_ROUTE_CACHE: Dict[Tuple[str, str, int], DS.RouteRule] = {}


def _explicit_section(route) -> Optional[DS.RouteRule]:
    """A `require_section(...)` dependency on the route (app/middleware/auth.py) wins over the table."""
    dependant = getattr(route, "dependant", None)
    stack = list(getattr(dependant, "dependencies", []) or [])
    while stack:
        dep = stack.pop()
        marker = getattr(getattr(dep, "call", None), "_dashboard_section", None)
        if marker is not None:
            return marker
        stack.extend(getattr(dep, "dependencies", []) or [])
    return None


def _requires_super_admin(route) -> bool:
    from app.middleware.auth import get_current_super_admin

    dependant = getattr(route, "dependant", None)
    stack = list(getattr(dependant, "dependencies", []) or [])
    while stack:
        dep = stack.pop()
        if getattr(dep, "call", None) is get_current_super_admin:
            return True
        stack.extend(getattr(dep, "dependencies", []) or [])
    return False


def classify(route, method: str) -> DS.RouteRule:
    """The rule for this route and method: explicit dependency, then the table, then super-admin-only."""
    path = _api_path(getattr(route, "path", "") or "")
    key = (method.upper(), path, id(route))
    hit = _ROUTE_CACHE.get(key)
    if hit is not None:
        return hit
    rule = _explicit_section(route)
    if rule is None:
        rule = DS.rule_for(method, path)
    if rule.kind == "unmapped" and _requires_super_admin(route):
        rule = DS.SUPER_ADMIN
    _ROUTE_CACHE[key] = rule
    return rule


def _refusal(section: Optional[str], level: str) -> HTTPException:
    label = DS.SECTION_BY_ID[section].label if section in DS.SECTION_BY_ID else None
    verb = "לערוך" if level == DS.EDIT else "לצפות"
    message = (
        f"אין לך הרשאה {verb} ב\"{label}\". מנהל המערכת יכול לפתוח לך את הלשונית."
        if label
        else "אין לך הרשאה לפעולה הזו. מנהל המערכת יכול לפתוח לך אותה."
    )
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": SECTION_FORBIDDEN, "section": section, "level": level, "message": message},
    )


def check_rule(access: EffectiveAccess, rule: DS.RouteRule, method: str) -> Optional[HTTPException]:
    """None when allowed, else the 403 to raise."""
    if not access.restricted:
        return None
    if rule.kind in ("self", "reference"):
        return None
    if rule.kind == "any_edit":
        if any(level == DS.EDIT for level in access.sections.values()):
            return None
        return _refusal(None, DS.EDIT)
    if rule.kind == "section":
        needed = rule.needed_level(method)
        if any(access.allows(section, needed) for section in rule.sections):
            return None
        return _refusal(rule.sections[0], needed)
    # till / super_admin / unmapped: not for a restricted dashboard user.
    return _refusal(None, rule.needed_level(method))


def enforce_route(request, db: Session, user: Any) -> None:
    """Refuse the request when `user` may not use this route (403 `section_forbidden`)."""
    if request is None or user is None or getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return
    scope = getattr(request, "scope", None)
    route = scope.get("route") if isinstance(scope, dict) else None
    if route is None:
        return
    access = effective_access(db, user)
    if not access.restricted:
        return
    method = getattr(request, "method", "GET") or "GET"
    refusal = check_rule(access, classify(route, method), method)
    if refusal is not None:
        raise refusal


def enforce_section(db: Session, user: Any, section: str, level: str) -> None:
    """For `require_section`: the same check, for one named section."""
    access = effective_access(db, user)
    if not access.allows(section, level):
        raise _refusal(section, level)


# ── Writing ──────────────────────────────────────────────────────────────────


def profile_out(profile: Optional[DashboardAccessProfile]) -> dict:
    """A profile on the wire; no row reads as the default it stands for ("מנהל ארגון")."""
    access = _from_profile(profile)
    return {
        "hasProfile": profile is not None,
        "fullAccess": access.full_access,
        "sections": dict(access.sections),
        "orgWide": access.org_wide,
        "companyIds": [str(c) for c in access.company_ids],
        "shopIds": [str(s) for s in access.shop_ids],
        "templateId": str(profile.template_id) if profile is not None and profile.template_id else None,
        "builtinTemplate": profile.builtin_template if profile is not None else DS.ORG_MANAGER_TEMPLATE,
        "updatedAt": profile.updated_at.isoformat() if profile is not None and profile.updated_at else None,
    }


def _audit(db: Session, *, actor, action: str, user_id=None, template_id=None, before=None, after=None) -> None:
    db.add(
        DashboardAccessAudit(
            user_id=user_id,
            template_id=template_id,
            actor_user_id=getattr(actor, "id", None),
            action=action,
            before=before,
            after=after,
        )
    )


def create_default_profile(db: Session, user: User, *, actor=None, org_wide: bool = False,
                           company_ids: Iterable = (), shop_ids: Iterable = ()) -> DashboardAccessProfile:
    """
    A new dashboard user: "מנהל ארגון" — reports (view), products (edit), Z (view). Made by
    someone other than the super admin, capped to what the maker holds (never more).
    """
    sections = dict(DS.ORG_MANAGER_SECTIONS)
    if actor is not None and getattr(actor, "role", None) != UserRole.SUPER_ADMIN:
        sections = cap_sections(sections, grantable(effective_access(db, actor)))
    profile = DashboardAccessProfile(
        user_id=user.id,
        full_access=False,
        sections=sections,
        org_wide=bool(org_wide),
        company_ids=[str(c) for c in _uuids(company_ids)] or None,
        shop_ids=[str(s) for s in _uuids(shop_ids)] or None,
        builtin_template=DS.ORG_MANAGER_TEMPLATE,
        updated_by_user_id=getattr(actor, "id", None),
    )
    db.add(profile)
    db.flush()
    _audit(db, actor=actor, action="profile.create", user_id=user.id, after=profile_out(profile))
    forget(db)
    return profile


def save_profile(
    db: Session,
    user: User,
    *,
    actor,
    full_access: bool,
    sections: Dict[str, str],
    org_wide: bool,
    company_ids: Iterable,
    shop_ids: Iterable,
    template_id=None,
    builtin_template: Optional[str] = None,
) -> DashboardAccessProfile:
    """Create or replace `user`'s profile, recording the change. Validation is the caller's."""
    profile = db.get(DashboardAccessProfile, user.id)
    before = profile_out(profile) if profile is not None else None
    if profile is None:
        profile = DashboardAccessProfile(user_id=user.id)
        db.add(profile)
    profile.full_access = bool(full_access)
    profile.sections = DS.clean_sections(sections)
    profile.org_wide = bool(org_wide)
    profile.company_ids = [str(c) for c in _uuids(company_ids)] or None
    profile.shop_ids = [str(s) for s in _uuids(shop_ids)] or None
    profile.template_id = template_id
    profile.builtin_template = builtin_template
    profile.updated_by_user_id = getattr(actor, "id", None)
    db.flush()
    after = profile_out(profile)
    _audit(
        db, actor=actor, action="profile.update" if before is not None else "profile.create",
        user_id=user.id, before=before, after=after,
    )
    forget(db)
    return profile


def template_out(template: DashboardAccessTemplate) -> dict:
    return {
        "id": str(template.id),
        "name": template.name,
        "description": template.description,
        "sections": DS.clean_sections(template.sections),
        "builtin": False,
        "fullAccess": False,
    }


def builtin_templates_out() -> List[dict]:
    return [
        {
            "id": key,
            "name": spec["label"],
            "description": None,
            "sections": dict(spec["sections"]),
            "builtin": True,
            "fullAccess": spec["fullAccess"],
        }
        for key, spec in DS.BUILTIN_TEMPLATES.items()
        # Not offered yet ("מנהל אזור" until dashboard users can be scoped to a point of sale).
        if not spec.get("hidden")
    ]


def record(db: Session, *, actor, action: str, user_id=None, template_id=None, before=None, after=None) -> None:
    _audit(db, actor=actor, action=action, user_id=user_id, template_id=template_id, before=before, after=after)


def summary_for(db: Session, user: Any) -> dict:
    """`/users/me` and `/dashboard-access/me`: what this person may open ("מה אני רשאי לראות")."""
    access = effective_access(db, user)
    return {
        "restricted": access.restricted,
        "sections": dict(access.sections) if access.restricted else {s.id: DS.EDIT for s in DS.SECTIONS},
        "orgWide": access.org_wide,
        "companyIds": [str(c) for c in access.company_ids],
        "shopIds": [str(s) for s in access.shop_ids],
        "template": access.template,
    }
