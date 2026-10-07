"""
"הרשאות דשבורד" — the super admin's per-user dashboard permissions (app/services/dashboard_access.py).

GET  /dashboard-access/me                    → what I may open ("מה אני רשאי לראות"), anyone signed in
GET  /dashboard-access/catalog               → the sections and the templates
GET  /dashboard-access/users                 → each user of the active organization: their profile
GET  /dashboard-access/users/{user_id}       → one user's profile, organizations, org options, history
PUT  /dashboard-access/users/{user_id}       → set it (sections, org scope, organizations)
GET  /dashboard-access/templates             → "פרופילי הרשאות" (built-in and the super admin's)
POST /dashboard-access/templates             → a new one
PUT  /dashboard-access/templates/{id}        → rename / change its sections (users keep what they got)
DELETE /dashboard-access/templates/{id}
GET  /dashboard-access/audit                 → the change history (?userId=)

Everything but `/me` is the super admin's. Not "תפקידים והרשאות בקופה" (till users).
"""
from __future__ import annotations

import uuid
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_super_admin, get_current_user
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessAudit, DashboardAccessProfile, DashboardAccessTemplate
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.schemas.dashboard_access import AccessScopeIn, ProfileIn, TemplateIn
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS

router = APIRouter(prefix="/dashboard-access", tags=["dashboard-access"])


def _error(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ── Resolving what was asked ──────────────────────────────────────────────────


def _template_choice(db: Session, raw: Optional[str]):
    """(full_access, sections, template_id, builtin_key) for a template name, or None."""
    if not raw:
        return None
    if raw in DS.BUILTIN_TEMPLATES:
        spec = DS.BUILTIN_TEMPLATES[raw]
        return bool(spec["fullAccess"]), dict(spec["sections"]), None, raw
    try:
        tid = uuid.UUID(str(raw))
    except ValueError:
        raise _error("unknown_template", "פרופיל ההרשאות לא נמצא.")
    template = db.get(DashboardAccessTemplate, tid)
    if template is None:
        raise _error("unknown_template", "פרופיל ההרשאות לא נמצא.")
    return False, DS.clean_sections(template.sections), template.id, None


def resolve_access(db: Session, target: User, body: AccessScopeIn, *, tenant_ids: List[uuid.UUID]) -> dict:
    """
    Validate an access request for `target` and return the values to save.

    Org scope is a company-level manager's (only that role is scoped by company here): a
    shop-level role's world is its own shop, a distributor's its tills — for them a scope is
    refused rather than stored and silently ignored.
    """
    choice = _template_choice(db, body.template)
    full_access = body.full_access
    sections = body.sections
    template_id = builtin = None
    if choice is not None:
        t_full, t_sections, template_id, builtin = choice
        if full_access is None:
            full_access = t_full
        if sections is None:
            sections = t_sections
    if full_access is None:
        full_access = False
    if sections is not None:
        unknown = [k for k, v in sections.items() if k not in DS.SECTION_IDS or v not in DS.LEVELS]
        if unknown:
            raise _error("unknown_section", f"לשונית לא מוכרת: {', '.join(sorted(map(str, unknown)))}")
    sections = DS.clean_sections(sections or {})

    narrowing = body.org_wide or body.company_ids or body.shop_ids
    if narrowing and target.role != UserRole.COMPANY_MANAGER:
        raise _error(
            "org_scope_needs_company_manager",
            "בחירת ארגון שלם, חברות או סניפים אפשרית למנהל חברה / מנהל ארגון. "
            "למנהל סניף ולקופאי ההיקף הוא הסניף שלו.",
        )

    companies = {
        c.id: c for c in db.query(Company).filter(Company.tenant_id.in_(tenant_ids)).all()
    } if tenant_ids else {}
    for cid in body.company_ids:
        if cid not in companies:
            raise _error("company_out_of_organization", "אחת החברות אינה בארגון של המשתמש.")
    shops = {s.id: s for s in db.query(Shop).filter(Shop.tenant_id.in_(tenant_ids)).all()} if tenant_ids else {}
    covered = None
    if body.company_ids and not body.org_wide:
        from app.services.company_hierarchy import descendant_company_ids

        covered = set()
        for cid in body.company_ids:
            covered |= set(descendant_company_ids(db, cid))
    for sid in body.shop_ids:
        shop = shops.get(sid)
        if shop is None:
            raise _error("shop_out_of_organization", "אחד הסניפים אינו בארגון של המשתמש.")
        if covered is not None and shop.company_id not in covered:
            raise _error("shop_out_of_companies", "אחד הסניפים אינו באחת החברות שנבחרו.")

    # Keep `users.company_id` inside the scope: the code that reads it directly (the default
    # company of a new product, the fast path of `user_covers_company`) must agree with it.
    primary = target.company_id
    if target.role == UserRole.COMPANY_MANAGER:
        if body.company_ids and not body.org_wide:
            if primary not in (covered or set()):
                primary = body.company_ids[0]
        elif body.org_wide and primary not in companies:
            roots = [c for c in companies.values() if c.parent_company_id is None and c.tenant_id == target.tenant_id]
            roots.sort(key=lambda c: (c.created_at is None, c.created_at, c.name or ""))
            primary = roots[0].id if roots else (next(iter(companies)) if companies else primary)
        if body.shop_ids and not body.org_wide and not body.company_ids:
            # Shops only: they must sit under the manager's own company scope.
            from app.services.company_hierarchy import descendant_company_ids

            own = set(descendant_company_ids(db, primary)) if primary else set()
            if any(shops[s].company_id not in own for s in body.shop_ids):
                raise _error("shop_out_of_companies", "אחד הסניפים אינו בחברה של המשתמש.")

    return {
        "full_access": bool(full_access),
        "sections": sections,
        "org_wide": bool(body.org_wide),
        "company_ids": list(body.company_ids),
        "shop_ids": list(body.shop_ids),
        "template_id": template_id,
        "builtin_template": builtin,
        "primary_company_id": primary,
    }


def _tenant_ids_of(db: Session, user: User) -> List[uuid.UUID]:
    return DA.user_tenant_ids(db, user)


def _target(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _set_memberships(db: Session, actor: User, user: User, wanted: List[uuid.UUID]) -> None:
    """The user's organizations: add the missing, remove the rest — never the home one."""
    wanted_set = set(wanted)
    if user.tenant_id is not None:
        wanted_set.add(user.tenant_id)
    existing = {m.tenant_id: m for m in db.query(TenantMembership).filter(TenantMembership.user_id == user.id).all()}
    known = {t.id for t in db.query(Tenant.id).filter(Tenant.id.in_(wanted_set)).all()} if wanted_set else set()
    missing = wanted_set - known
    if missing:
        raise _error("unknown_organization", "אחד הארגונים לא נמצא.")
    member_role = (
        TenantMembershipRole.TENANT_ADMIN
        if user.role in (UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER)
        else TenantMembershipRole.TENANT_MEMBER
    )
    for tid in sorted(wanted_set - set(existing), key=str):
        db.add(TenantMembership(tenant_id=tid, user_id=user.id, role=member_role, is_default=(tid == user.tenant_id)))
        DA.record(db, actor=actor, action="membership.add", user_id=user.id, after={"tenantId": str(tid)})
    for tid, membership in existing.items():
        if tid not in wanted_set:
            db.delete(membership)
            DA.record(db, actor=actor, action="membership.remove", user_id=user.id, before={"tenantId": str(tid)})
    db.flush()


def _audit_out(rows: List[DashboardAccessAudit], names: Dict[uuid.UUID, str]) -> List[dict]:
    return [
        {
            "id": str(r.id),
            "action": r.action,
            "userId": str(r.user_id) if r.user_id else None,
            "templateId": str(r.template_id) if r.template_id else None,
            "actor": names.get(r.actor_user_id) if r.actor_user_id else None,
            "before": r.before,
            "after": r.after,
            "at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def _names(db: Session, ids) -> Dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(User).filter(User.id.in_(ids)).all()}


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/me")
def my_access(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """What I may open, with names — the dashboard's "מה אני רשאי לראות"."""
    out = DA.summary_for(db, current_user)
    company_ids = [uuid.UUID(c) for c in out["companyIds"]]
    shop_ids = [uuid.UUID(s) for s in out["shopIds"]]
    out["companies"] = [
        {"id": str(c.id), "name": c.name} for c in db.query(Company).filter(Company.id.in_(company_ids)).all()
    ] if company_ids else []
    out["shops"] = [
        {"id": str(s.id), "name": s.name} for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()
    ] if shop_ids else []
    out["sectionList"] = DS.sections_summary(out["sections"].items())
    tenants = DA.user_tenant_ids(db, current_user)
    out["organizations"] = [
        {"id": str(t.id), "name": t.name} for t in db.query(Tenant).filter(Tenant.id.in_(tenants)).all()
    ] if tenants and current_user.role != UserRole.SUPER_ADMIN else []
    return out


@router.get("/catalog")
def catalog(current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    custom = db.query(DashboardAccessTemplate).order_by(DashboardAccessTemplate.name).all()
    return {
        "sections": DS.catalogue(),
        "levels": list(DS.LEVELS),
        "defaultTemplate": DS.ORG_MANAGER_TEMPLATE,
        "templates": DA.builtin_templates_out() + [DA.template_out(t) for t in custom],
    }


@router.get("/users")
def list_profiles(
    current_user: User = Depends(get_current_super_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The profile of every user of the active organization (for the users page's badges)."""
    users = db.query(User).filter(User.tenant_id == active_tenant_id).all()
    profiles = {
        p.user_id: p
        for p in db.query(DashboardAccessProfile).filter(DashboardAccessProfile.user_id.in_([u.id for u in users])).all()
    } if users else {}
    templates = {t.id: t.name for t in db.query(DashboardAccessTemplate).all()}
    out = []
    for u in users:
        p = profiles.get(u.id)
        row = {"userId": str(u.id), **DA.profile_out(p)}
        row["templateName"] = (
            DS.BUILTIN_TEMPLATES[p.builtin_template]["label"] if p is not None and p.builtin_template in DS.BUILTIN_TEMPLATES
            else templates.get(p.template_id) if p is not None and p.template_id else None
        )
        out.append(row)
    return out


@router.get("/users/{user_id}")
def get_profile(user_id: uuid.UUID, current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    user = _target(db, user_id)
    profile = db.get(DashboardAccessProfile, user.id)
    tenant_ids = _tenant_ids_of(db, user)
    tenants = db.query(Tenant).filter(Tenant.id.in_(tenant_ids)).all() if tenant_ids else []
    companies = db.query(Company).filter(Company.tenant_id.in_(tenant_ids)).order_by(Company.name).all() if tenant_ids else []
    shops = db.query(Shop).filter(Shop.tenant_id.in_(tenant_ids)).order_by(Shop.name).all() if tenant_ids else []
    audit = (
        db.query(DashboardAccessAudit)
        .filter(DashboardAccessAudit.user_id == user.id)
        .order_by(DashboardAccessAudit.created_at.desc())
        .limit(50)
        .all()
    )
    return {
        "user": {
            "id": str(user.id), "username": user.username, "email": user.email, "role": user.role.value,
            "tenantId": str(user.tenant_id) if user.tenant_id else None,
            "companyId": str(user.company_id) if user.company_id else None,
            "shopId": str(user.shop_id) if user.shop_id else None,
        },
        "profile": DA.profile_out(profile),
        "orgScopeAllowed": user.role == UserRole.COMPANY_MANAGER,
        "organizations": [
            {"id": str(t.id), "name": t.name, "home": t.id == user.tenant_id} for t in tenants
        ],
        "companies": [
            {"id": str(c.id), "name": c.name, "tenantId": str(c.tenant_id) if c.tenant_id else None,
             "parentCompanyId": str(c.parent_company_id) if c.parent_company_id else None}
            for c in companies
        ],
        "shops": [
            {"id": str(s.id), "name": s.name, "companyId": str(s.company_id), "tenantId": str(s.tenant_id) if s.tenant_id else None}
            for s in shops
        ],
        "audit": _audit_out(audit, _names(db, [r.actor_user_id for r in audit])),
    }


@router.put("/users/{user_id}")
def put_profile(
    user_id: uuid.UUID,
    body: ProfileIn,
    current_user: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    user = _target(db, user_id)
    if user.role == UserRole.SUPER_ADMIN:
        raise _error("super_admin_unrestricted", "למנהל מערכת יש גישה לכל — אין לו הרשאות לשנות.")
    if body.tenant_ids is not None:
        _set_memberships(db, current_user, user, body.tenant_ids)
    values = resolve_access(db, user, body, tenant_ids=_tenant_ids_of(db, user))
    primary = values.pop("primary_company_id")
    if primary != user.company_id:
        DA.record(
            db, actor=current_user, action="profile.company", user_id=user.id,
            before={"companyId": str(user.company_id) if user.company_id else None},
            after={"companyId": str(primary) if primary else None},
        )
        user.company_id = primary
    DA.save_profile(db, user, actor=current_user, **values)
    db.commit()
    return get_profile(user_id, current_user=current_user, db=db)


@router.get("/templates")
def list_templates(current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    custom = db.query(DashboardAccessTemplate).order_by(DashboardAccessTemplate.name).all()
    return DA.builtin_templates_out() + [DA.template_out(t) for t in custom]


def _clean_template(db: Session, body: TemplateIn, *, current: Optional[DashboardAccessTemplate] = None) -> dict:
    name = body.name.strip()
    if not name:
        raise _error("template_name_required", "יש לתת שם לפרופיל ההרשאות.")
    if name in {spec["label"] for spec in DS.BUILTIN_TEMPLATES.values()}:
        raise _error("template_name_taken", "השם שמור לפרופיל מובנה.")
    clash = db.query(DashboardAccessTemplate).filter(DashboardAccessTemplate.name == name).first()
    if clash is not None and (current is None or clash.id != current.id):
        raise _error("template_name_taken", "כבר קיים פרופיל הרשאות בשם הזה.")
    unknown = [k for k, v in body.sections.items() if k not in DS.SECTION_IDS or v not in DS.LEVELS]
    if unknown:
        raise _error("unknown_section", f"לשונית לא מוכרת: {', '.join(sorted(map(str, unknown)))}")
    return {"name": name, "description": (body.description or "").strip() or None, "sections": DS.clean_sections(body.sections)}


@router.post("/templates", status_code=status.HTTP_201_CREATED)
def create_template(body: TemplateIn, current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    values = _clean_template(db, body)
    template = DashboardAccessTemplate(created_by_user_id=current_user.id, **values)
    db.add(template)
    db.flush()
    DA.record(db, actor=current_user, action="template.create", template_id=template.id, after=DA.template_out(template))
    db.commit()
    return DA.template_out(template)


@router.put("/templates/{template_id}")
def update_template(
    template_id: uuid.UUID, body: TemplateIn,
    current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db),
):
    template = db.get(DashboardAccessTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    before = DA.template_out(template)
    for key, value in _clean_template(db, body, current=template).items():
        setattr(template, key, value)
    db.flush()
    DA.record(db, actor=current_user, action="template.update", template_id=template.id, before=before, after=DA.template_out(template))
    db.commit()
    return DA.template_out(template)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: uuid.UUID, current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    template = db.get(DashboardAccessTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    before = DA.template_out(template)
    # Users keep the sections they were given; only the link to the template goes.
    db.query(DashboardAccessProfile).filter(DashboardAccessProfile.template_id == template.id).update(
        {DashboardAccessProfile.template_id: None}, synchronize_session=False
    )
    db.delete(template)
    DA.record(db, actor=current_user, action="template.delete", template_id=template_id, before=before)
    db.commit()


@router.get("/audit")
def audit(
    user_id: Optional[uuid.UUID] = Query(None, alias="userId"),
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    query = db.query(DashboardAccessAudit)
    if user_id is not None:
        query = query.filter(DashboardAccessAudit.user_id == user_id)
    rows = query.order_by(DashboardAccessAudit.created_at.desc()).limit(limit).all()
    return _audit_out(rows, _names(db, [r.actor_user_id for r in rows]))
