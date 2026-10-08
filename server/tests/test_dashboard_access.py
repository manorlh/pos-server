"""
"הרשאות דשבורד" — per dashboard (cloud) user: sections ("לשוניות") at view / edit, and the org
scope (app/services/dashboard_access.py, app/services/dashboard_sections.py).

What is pinned, and how each could look fine while leaking:

* **The route registry** — every route that accepts a dashboard token has a rule (a new route
  without one fails here), every rule is still used, and the whole route → section map is
  pinned in tests/fixtures/dashboard_route_sections.txt, so a route cannot land in another
  section unnoticed. Regenerate it with UPDATE_DASHBOARD_ROUTE_MAP=1 after a deliberate change.
* **Every protected route refuses an ungranted section** — generated from `app.routes`: each
  section route through the real app with a restricted user who has no sections (403
  `section_forbidden`), and the rule itself at every level for every route.
* **The default** — a new user is "מנהל ארגון": reports (view), products (edit), Z (view).
* **Org scope** — the whole organization, a list of companies, a list of shops: lists, access
  checks and scoped queries all follow it.
* **Nobody loses anything** — the super admin is never checked; a user with `full_access` (the
  migration's mapping of every existing user) keeps the role's access. A user with no profile
  row gets the default, never more.
* **Granting only what you hold** — a manager other than the super admin gives a user they
  manage only sections they have, at most at their level; full access only if they have it;
  never organizations.
* **The migration** — every existing user (not the super admin) gets `full_access`; idempotent.

Runs on an in-memory SQLite database (one connection, so the app's threads share it), through
the real app with real (legacy) user tokens.
"""
from __future__ import annotations

import difflib
import importlib.util
import os
import pathlib
import re
import uuid
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from shift_world import accept_str_uuids  # (and JSONB on SQLite)
from app.database import Base, get_db
from app.main import app
from app.middleware import auth as auth_mw
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessAudit, DashboardAccessProfile
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.services import company_hierarchy as CH
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services.auth import create_access_token
from app.services.scoping import scope_query_by_user

ROOT = pathlib.Path(__file__).parents[1]  # not resolve(): the short P: path keeps alembic under MAX_PATH
FIXTURE = ROOT / "tests" / "fixtures" / "dashboard_route_sections.txt"
USER_DEPENDENCIES = {auth_mw.get_current_user, auth_mw.get_current_user_flexible, auth_mw.get_pos_machine_for_sync_path}


# ── The world ────────────────────────────────────────────────────────────────


class World(SimpleNamespace):
    pass


def _make_world() -> World:
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    for table in Base.metadata.sorted_tables:
        table.create(engine)
    db = sessionmaker(bind=engine)()
    w = World(db=db)
    w.tenant = Tenant(id=uuid.uuid4(), name="Royal", slug="royal", timezone="Asia/Jerusalem")
    w.other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    db.add_all([w.tenant, w.other_tenant])
    db.flush()

    def company(name, tenant, parent=None):
        c = Company(id=uuid.uuid4(), tenant_id=tenant.id, name=name, parent_company_id=parent.id if parent else None)
        db.add(c)
        db.flush()
        return c

    def shop(name, c):
        s = Shop(id=uuid.uuid4(), tenant_id=c.tenant_id, company_id=c.id, name=name, settings={})
        db.add(s)
        db.flush()
        return s

    w.a = company("A", w.tenant)
    w.a_sub = company("A-sub", w.tenant, parent=w.a)
    w.b = company("B", w.tenant)
    w.c = company("C", w.other_tenant)
    w.a_shop1, w.a_shop2 = shop("A1", w.a), shop("A2", w.a)
    w.sub_shop = shop("Sub", w.a_sub)
    w.b_shop = shop("B1", w.b)
    w.c_shop = shop("C1", w.c)

    w.admin = _user(db, "admin", UserRole.SUPER_ADMIN, w.tenant)
    w.machines = {}
    for s in (w.a_shop1, w.a_shop2, w.sub_shop, w.b_shop, w.c_shop):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=s.tenant_id, shop_id=s.id, distributor_id=w.admin.id, name=f"till {s.name}",
            machine_code=f"M-{s.name}", pos_number="1", is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        db.add(m)
        w.machines[s.name] = m
    db.flush()
    db.commit()
    return w


def _user(db, username, role, tenant, *, company=None, shop=None) -> User:
    u = User(
        id=uuid.uuid4(), username=username, email=f"{username}@example.com", role=role, tenant_id=tenant.id,
        company_id=company.id if company else None, shop_id=shop.id if shop else None, is_active=True,
    )
    db.add(u)
    db.flush()
    if role != UserRole.SUPER_ADMIN:
        db.add(TenantMembership(tenant_id=tenant.id, user_id=u.id, role=TenantMembershipRole.TENANT_MEMBER, is_default=True))
        db.flush()
    return u


def _profile(db, user, *, full=False, sections=None, org_wide=False, companies=(), shops=()):
    db.add(DashboardAccessProfile(
        user_id=user.id, full_access=full, sections=dict(sections or {}), org_wide=org_wide,
        company_ids=[str(c.id) for c in companies] or None, shop_ids=[str(s.id) for s in shops] or None,
    ))
    db.flush()
    DA.forget(db)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)  # before the engine caches its UUID binding
    world = _make_world()
    # Legacy (username) tokens only: no Clerk round trip from the tests.
    monkeypatch.setattr(auth_mw, "verify_clerk_token", lambda _token: None)

    def _db():
        yield world.db

    app.dependency_overrides[get_db] = _db
    world.client = TestClient(app, raise_server_exceptions=False)
    yield world
    app.dependency_overrides.pop(get_db, None)
    world.db.close()


def _headers(user, tenant=None) -> dict:
    out = {"Authorization": f"Bearer {create_access_token({'sub': user.username})}"}
    if tenant is not None:
        out["X-Tenant-Id"] = str(tenant.id)
    return out


def _is_section_refusal(response) -> bool:
    if response.status_code != 403:
        return False
    detail = response.json().get("detail")
    return isinstance(detail, dict) and detail.get("code") == DA.SECTION_FORBIDDEN


# ── The route registry ───────────────────────────────────────────────────────


def _accepts_user(route: APIRoute) -> bool:
    stack = list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call in USER_DEPENDENCIES:
            return True
        stack.extend(dep.dependencies)
    return False


def _dashboard_routes():
    for route in app.routes:
        if isinstance(route, APIRoute) and _accepts_user(route):
            for method in sorted(route.methods):
                yield method, route


def route_map_lines():
    lines = {
        f"{method} {DA._api_path(route.path)} -> {DA.classify(route, method).describe(method)}"
        for method, route in _dashboard_routes()
    }
    return sorted(lines, key=lambda line: (line.split(" ")[1], line.split(" ")[0]))


def test_every_dashboard_route_has_a_rule():
    """A route that accepts a dashboard token and has no section is refused to a restricted
    user at runtime — and here, before it ships."""
    missing = [f"{m} {r.path}" for m, r in _dashboard_routes() if DA.classify(r, m).kind == "unmapped"]
    assert not missing, (
        "Routes without a dashboard section — add them to ROUTE_RULES in "
        "app/services/dashboard_sections.py:\n" + "\n".join(missing)
    )


def test_every_rule_is_used():
    used = set()
    for method, route in _dashboard_routes():
        index = DS.rule_index_for(method, DA._api_path(route.path))
        if index is not None:
            used.add(index)
    stale = [f"{m} {p}" for i, (m, p, _r) in enumerate(DS.ROUTE_RULES) if i not in used]
    assert not stale, "Rules no route uses any more:\n" + "\n".join(stale)


def test_the_route_map_is_pinned():
    lines = route_map_lines()
    if os.environ.get("UPDATE_DASHBOARD_ROUTE_MAP") == "1":
        FIXTURE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    pinned = FIXTURE.read_text(encoding="utf-8").splitlines()
    diff = "\n".join(difflib.unified_diff(pinned, lines, "pinned", "now", lineterm=""))
    assert lines == pinned, (
        "The dashboard route → section map changed. If deliberate, run the tests with "
        "UPDATE_DASHBOARD_ROUTE_MAP=1 and commit tests/fixtures/dashboard_route_sections.txt.\n" + diff
    )


def test_the_dashboard_catalogue_is_the_same_section_list():
    """client/src/lib/dashboardAccess.ts names exactly these sections, in this order."""
    source = (ROOT.parent / "client" / "src" / "lib" / "dashboardAccess.ts").read_text(encoding="utf-8")
    block = source[source.index("export const DASHBOARD_SECTIONS"):]
    block = block[: block.index("];")]
    ids = re.findall(r"id: '([a-z_]+)'", block)
    assert ids == [s.id for s in DS.SECTIONS]
    for section in DS.SECTIONS:
        for page in section.pages:
            assert f"'{page}'" in block, (section.id, page)


@pytest.mark.parametrize("method,route", list(_dashboard_routes()), ids=lambda v: v if isinstance(v, str) else v.path)
def test_each_rule_refuses_without_its_section_and_allows_with_it(method, route):
    rule = DA.classify(route, method)
    nothing = DA.EffectiveAccess(restricted=True, has_profile=True, full_access=False)
    if rule.kind in ("self", "reference"):
        assert DA.check_rule(nothing, rule, method) is None
        return
    assert DA.check_rule(nothing, rule, method).status_code == 403
    if rule.kind == "section":
        needed = rule.needed_level(method)
        for section in rule.sections:
            granted = DA.EffectiveAccess(restricted=True, sections={section: needed}, has_profile=True, full_access=False)
            assert DA.check_rule(granted, rule, method) is None
            if needed == DS.EDIT:
                view_only = DA.EffectiveAccess(restricted=True, sections={section: DS.VIEW}, has_profile=True, full_access=False)
                assert DA.check_rule(view_only, rule, method).status_code == 403
        others = {s.id: DS.EDIT for s in DS.SECTIONS if s.id not in rule.sections}
        everything_else = DA.EffectiveAccess(restricted=True, sections=others, has_profile=True, full_access=False)
        assert DA.check_rule(everything_else, rule, method).status_code == 403
    # Never the super admin, never a full-access user.
    assert DA.check_rule(DA.UNRESTRICTED, rule, method) is None


def _url(route: APIRoute) -> str:
    return re.sub(r"\{[^}]+\}", lambda _m: str(uuid.uuid4()), route.path)


def test_every_protected_route_refuses_a_user_without_its_section(w):
    """Through the app: a restricted user with no sections is refused on every section,
    till and super-admin route — before the route does anything."""
    nobody = _user(w.db, "nobody", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, nobody, sections={})
    w.db.commit()
    headers = _headers(nobody, w.tenant)
    leaked = []
    for method, route in _dashboard_routes():
        rule = DA.classify(route, method)
        if rule.kind in ("self", "reference"):
            continue
        response = w.client.request(method, _url(route), headers=headers, json={} if method not in ("GET", "HEAD", "DELETE") else None)
        if method == "HEAD" or rule.kind == "till":
            # A till's path may refuse a dashboard token outright (`machine_token_required`).
            refused = response.status_code == 403
        else:
            refused = _is_section_refusal(response)
        if not refused:
            leaked.append(f"{method} {route.path} → {response.status_code} {response.text[:120]}")
    assert not leaked, "Reachable without the section:\n" + "\n".join(leaked)


def test_self_and_lookups_stay_open_to_a_user_without_sections(w):
    nobody = _user(w.db, "nobody", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, nobody, sections={})
    w.db.commit()
    headers = _headers(nobody, w.tenant)
    for path in ("/api/v1/users/me", "/api/v1/tenants/mine", "/api/v1/dashboard-access/me", "/api/v1/shops", "/api/v1/companies"):
        response = w.client.get(path, headers=headers)
        assert response.status_code == 200, (path, response.text)


# ── The default: "מנהל ארגון" ──────────────────────────────────────────────────


#: The owner's 07.10 default (reports, products, Z) plus the cockpit's quick actions (09.10 integration).
ORG_MANAGER_DEFAULT = {"products": "edit", "quick_actions": "edit", "reports": "view", "z": "view"}


def test_the_default_opens_reports_products_z_and_quick_actions_only(w):
    manager = _user(w.db, "org", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    DA.create_default_profile(w.db, manager)
    w.db.commit()
    access = DA.effective_access(w.db, manager)
    assert access.restricted and access.sections == ORG_MANAGER_DEFAULT

    headers = _headers(manager, w.tenant)
    allowed = [
        ("GET", "/api/v1/products"), ("GET", "/api/v1/categories"), ("GET", "/api/v1/z-reports"),
        ("GET", "/api/v1/shifts"), ("GET", "/api/v1/transactions"), ("GET", "/api/v1/reports/products"),
        ("POST", "/api/v1/products"),
    ]
    for method, path in allowed:
        response = w.client.request(method, path, headers=headers, json={} if method == "POST" else None)
        assert not _is_section_refusal(response), (method, path, response.text)
    refused = [
        ("GET", "/api/v1/users"), ("POST", "/api/v1/shops"), ("GET", "/api/v1/machines/unassigned"),
        ("PATCH", f"/api/v1/shops/{w.a_shop1.id}/settings"), ("POST", "/api/v1/z-runs"),
        ("POST", "/api/v1/report-events"), ("GET", "/api/v1/attendance/live"), ("GET", "/api/v1/kiosks"),
        ("GET", f"/api/v1/shops/{w.a_shop1.id}/pos-users"), ("GET", "/api/v1/promotions"),
    ]
    for method, path in refused:
        response = w.client.request(method, path, headers=headers, json={} if method != "GET" else None)
        assert _is_section_refusal(response), (method, path, response.status_code, response.text)
        assert response.json()["detail"]["message"]  # Hebrew, for the toast


def test_me_says_what_the_user_may_open(w):
    manager = _user(w.db, "org", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    DA.create_default_profile(w.db, manager, org_wide=True)
    w.db.commit()
    me = w.client.get("/api/v1/users/me", headers=_headers(manager)).json()
    assert me["dashboardAccess"]["restricted"] is True
    assert me["dashboardAccess"]["sections"] == ORG_MANAGER_DEFAULT
    assert me["dashboardAccess"]["orgWide"] is True
    mine = w.client.get("/api/v1/dashboard-access/me", headers=_headers(manager)).json()
    assert [s["label"] for s in mine["sectionList"]] == ["מוצרים וקטלוג", "פעולות מהירות", "דוחות", "זדים ומשמרות"]
    assert [o["name"] for o in mine["organizations"]] == ["Royal"]


def test_a_user_created_from_the_users_page_starts_as_org_manager(w):
    legacy = _user(w.db, "legacy", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, legacy, full=True)
    w.db.commit()
    response = w.client.post(
        "/api/v1/users", headers=_headers(legacy, w.tenant),
        json={"email": "shopmgr@example.com", "role": "shop_manager", "companyId": str(w.a.id), "shopId": str(w.a_shop1.id)},
    )
    assert response.status_code == 201, response.text
    created = w.db.get(User, uuid.UUID(response.json()["id"]))
    profile = w.db.get(DashboardAccessProfile, created.id)
    assert profile.full_access is False and profile.builtin_template == "org_manager"
    assert DS.clean_sections(profile.sections) == ORG_MANAGER_DEFAULT
    # A manager with full access may give full access — what they hold themselves.
    response = w.client.post(
        "/api/v1/users", headers=_headers(legacy, w.tenant),
        json={"email": "cashier@example.com", "role": "cashier", "companyId": str(w.a.id), "shopId": str(w.a_shop1.id),
              "access": {"template": "full"}},
    )
    assert response.status_code == 201, response.text
    assert w.db.get(DashboardAccessProfile, uuid.UUID(response.json()["id"])).full_access is True
    audit = w.db.query(DashboardAccessAudit).filter(DashboardAccessAudit.user_id == created.id).all()
    assert [a.action for a in audit] == ["profile.create"]


def _restricted_manager(w, sections, **kw):
    manager = _user(w.db, kw.pop("name", "mgr"), UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, manager, sections=sections, **kw)
    w.db.commit()
    w.client.get("/api/v1/tenants/mine", headers=_headers(manager))
    return manager


def test_a_restricted_creator_gives_at_most_what_they_hold(w):
    manager = _restricted_manager(w, {"users": "edit", "reports": "view", "products": "view"})
    headers = _headers(manager, w.tenant)
    shop_user = {"role": "shop_manager", "companyId": str(w.a.id), "shopId": str(w.a_shop1.id)}
    # The default, capped: products only at view, no Z.
    response = w.client.post("/api/v1/users", headers=headers, json={"email": "a@example.com", **shop_user})
    assert response.status_code == 201, response.text
    profile = w.db.get(DashboardAccessProfile, uuid.UUID(response.json()["id"]))
    assert DS.clean_sections(profile.sections) == {"products": "view", "reports": "view"}
    # An explicit grant beyond what they hold is refused (and nothing is created).
    for access in ({"sections": {"devices": "view"}}, {"sections": {"reports": "edit"}}, {"template": "full"}):
        response = w.client.post("/api/v1/users", headers=headers, json={"email": "b@example.com", **shop_user, "access": access})
        assert response.status_code == 403 and response.json()["detail"]["code"] == "grant_exceeds_own", response.text
    assert w.db.query(User).filter(User.email == "b@example.com").first() is None
    response = w.client.post(
        "/api/v1/users", headers=headers,
        json={"email": "c@example.com", **shop_user, "access": {"sections": {"reports": "view", "users": "view"}}},
    )
    assert response.status_code == 201, response.text


def test_a_restricted_manager_edits_permissions_only_within_their_own(w):
    manager = _restricted_manager(w, {"users": "edit", "reports": "view", "products": "edit"})
    target = _user(w.db, "t", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    # The super admin had given them devices; the manager does not hold it.
    _profile(w.db, target, sections={"reports": "view", "devices": "view"})
    peer = _user(w.db, "peer", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    w.db.commit()
    headers = _headers(manager, w.tenant)
    url = f"/api/v1/dashboard-access/users/{target.id}"

    detail = w.client.get(url, headers=headers).json()
    assert detail["grantable"] == {"products": "edit", "reports": "view", "users": "edit"}
    assert detail["canGrantFull"] is False and detail["canEditOrganizations"] is False

    # Keep what they had (devices too), add what the manager holds: fine.
    ok = w.client.put(url, headers=headers, json={"sections": {"reports": "view", "devices": "view", "products": "edit"}})
    assert ok.status_code == 200, ok.text
    # Raising beyond the manager's own level, or a section they do not hold: refused.
    for sections in ({"reports": "edit"}, {"devices": "edit"}, {"kiosks": "view"}):
        bad = w.client.put(url, headers=headers, json={"sections": sections})
        assert bad.status_code == 403 and bad.json()["detail"]["code"] == "grant_exceeds_own", (sections, bad.text)
    # Lowering is always allowed.
    assert w.client.put(url, headers=headers, json={"sections": {"reports": "view"}}).status_code == 200
    # Never full access, never organizations, never a peer or themselves.
    assert w.client.put(url, headers=headers, json={"fullAccess": True}).json()["detail"]["code"] == "grant_exceeds_own"
    response = w.client.put(url, headers=headers, json={"sections": {}, "tenantIds": [str(w.tenant.id), str(w.other_tenant.id)]})
    assert response.json()["detail"]["code"] == "organizations_super_admin_only"
    assert w.client.get(f"/api/v1/dashboard-access/users/{peer.id}", headers=headers).status_code == 403
    assert w.client.get(f"/api/v1/dashboard-access/users/{manager.id}", headers=headers).status_code == 403


def test_a_manager_gives_an_org_scope_only_inside_their_own(w):
    manager = _restricted_manager(w, {"users": "edit", "reports": "view"}, companies=[w.a])
    lower = _user(w.db, "lower", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop2)
    w.db.commit()
    headers = _headers(manager, w.tenant)
    # Org scope belongs to company-level users; a shop manager keeps their shop.
    response = w.client.put(f"/api/v1/dashboard-access/users/{lower.id}", headers=headers, json={"sections": {}, "orgWide": True})
    assert response.json()["detail"]["code"] == "org_scope_needs_company_manager"
    # The options offered are the manager's own companies only.
    detail = w.client.get(f"/api/v1/dashboard-access/users/{lower.id}", headers=headers).json()
    assert {c["name"] for c in detail["companies"]} == {"A", "A-sub"}
    assert detail["canGrantOrgWide"] is False


def test_the_super_admin_creates_an_org_manager_for_the_whole_organization(w):
    response = w.client.post(
        "/api/v1/users", headers=_headers(w.admin, w.tenant),
        json={"email": "boss@example.com", "role": "company_manager", "access": {"template": "org_manager", "orgWide": True}},
    )
    assert response.status_code == 201, response.text
    boss = w.db.get(User, uuid.UUID(response.json()["id"]))
    w.client.get("/api/v1/tenants/mine", headers=_headers(boss))  # the dashboard's first call: membership
    profile = w.db.get(DashboardAccessProfile, boss.id)
    assert profile.org_wide and not profile.full_access
    # A primary company inside the organization, so code reading `company_id` agrees.
    assert boss.company_id in {w.a.id, w.b.id}
    assert _shop_names(w, boss) == {"A1", "A2", "Sub", "B1"}  # every shop of the organization, none of another
    # Only a scope chosen: the sections are still the default ones.
    response = w.client.post(
        "/api/v1/users", headers=_headers(w.admin, w.tenant),
        json={"email": "boss2@example.com", "role": "company_manager", "companyId": str(w.b.id), "access": {"orgWide": True}},
    )
    profile = w.db.get(DashboardAccessProfile, uuid.UUID(response.json()["id"]))
    assert DS.clean_sections(profile.sections) == DS.ORG_MANAGER_SECTIONS


def test_a_new_super_admin_is_never_restricted(w):
    response = w.client.post(
        "/api/v1/users", headers=_headers(w.admin, w.tenant), json={"email": "root2@example.com", "role": "super_admin"},
    )
    assert response.status_code == 201, response.text
    assert w.db.get(DashboardAccessProfile, uuid.UUID(response.json()["id"])) is None


# ── Nobody loses anything ────────────────────────────────────────────────────


def test_the_super_admin_and_full_access_users_are_not_checked(w):
    legacy = _user(w.db, "legacy", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, legacy, full=True)
    w.db.commit()
    for user in (w.admin, legacy):
        for method, path in (("GET", "/api/v1/users"), ("GET", "/api/v1/promotions"), ("GET", "/api/v1/attendance/live")):
            response = w.client.request(method, path, headers=_headers(user, w.tenant))
            assert not _is_section_refusal(response), (user.username, path, response.text)
    assert not DA.effective_access(w.db, legacy).restricted


def test_a_user_with_no_profile_row_gets_the_default_never_more(w):
    bare = _user(w.db, "bare", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)  # no profile row at all
    w.db.commit()
    access = DA.effective_access(w.db, bare)
    assert access.restricted and access.sections == DS.ORG_MANAGER_SECTIONS
    headers = _headers(bare, w.tenant)
    assert not _is_section_refusal(w.client.get("/api/v1/products", headers=headers))
    assert _is_section_refusal(w.client.get("/api/v1/users", headers=headers))
    me = w.client.get("/api/v1/users/me", headers=headers).json()
    assert me["dashboardAccess"]["restricted"] is True and me["dashboardAccess"]["template"] == "org_manager"
    # Its org scope is the role's own (no narrowing from a profile that does not exist).
    assert _shop_names(w, bare) == {"A1", "A2", "Sub"}


def test_a_till_path_refuses_a_restricted_dashboard_token_only(w):
    manager = _user(w.db, "org", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    DA.create_default_profile(w.db, manager)
    legacy = _user(w.db, "legacy", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, legacy, full=True)
    w.db.commit()
    path = f"/api/v1/sync/{w.machines['A1'].id}/settings"
    assert _is_section_refusal(w.client.get(path, headers=_headers(manager)))
    assert not _is_section_refusal(w.client.get(path, headers=_headers(legacy)))


# ── Org scope ────────────────────────────────────────────────────────────────


def _shop_names(w, user):
    response = w.client.get("/api/v1/shops", headers=_headers(user, w.tenant))
    assert response.status_code == 200, response.text
    return {s["name"] for s in response.json()}


def test_org_scope_whole_organization_companies_and_shops(w):
    whole = _user(w.db, "whole", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, whole, sections={"reports": "view"}, org_wide=True)
    some = _user(w.db, "some", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, some, sections={"reports": "view"}, companies=[w.a])
    one = _user(w.db, "one", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, one, sections={"reports": "view"}, companies=[w.a], shops=[w.a_shop2])
    plain = _user(w.db, "plain", UserRole.COMPANY_MANAGER, w.tenant, company=w.b)
    _profile(w.db, plain, full=True)
    w.db.commit()

    assert _shop_names(w, whole) == {"A1", "A2", "Sub", "B1"}
    assert _shop_names(w, some) == {"A1", "A2", "Sub"}  # A and its subsidiary
    assert _shop_names(w, one) == {"A2"}
    assert _shop_names(w, plain) == {"B1"}  # the role's own scope, as before

    assert set(CH.company_scope_ids(w.db, whole)) == {w.a.id, w.a_sub.id, w.b.id}
    assert CH.user_covers_company(w.db, whole, w.b.id) and not CH.user_covers_company(w.db, whole, w.c.id)
    assert not CH.user_covers_company(w.db, some, w.b.id)
    assert CH.user_covers_shop(w.db, one, w.a_shop2) and not CH.user_covers_shop(w.db, one, w.a_shop1)
    assert CH.user_may_use_machine(w.db, one, w.machines["A2"])
    assert not CH.user_may_use_machine(w.db, one, w.machines["A1"])
    assert not CH.user_may_use_machine(w.db, whole, w.machines["C1"])

    machines = scope_query_by_user(
        w.db.query(POSMachine), one, w.db, shop_column=POSMachine.shop_id, machine_column=POSMachine.id
    ).all()
    assert {m.id for m in machines} == {w.machines["A2"].id}
    # Access checks by id follow it too: a shop outside the list is refused.
    assert w.client.get(f"/api/v1/shops/{w.a_shop1.id}", headers=_headers(one, w.tenant)).status_code == 403
    assert w.client.get(f"/api/v1/shops/{w.a_shop2.id}", headers=_headers(one, w.tenant)).status_code == 200


def test_another_organization_stays_out(w):
    whole = _user(w.db, "whole", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, whole, sections={"reports": "view"}, org_wide=True)
    w.db.commit()
    response = w.client.get("/api/v1/shops", headers=_headers(whole, w.other_tenant))
    assert response.status_code == 403  # not a member of it


# ── The super admin's endpoints ──────────────────────────────────────────────


def test_the_super_admin_sets_sections_scope_and_organizations_with_history(w):
    user = _user(w.db, "u", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    DA.create_default_profile(w.db, user)
    w.db.commit()
    url = f"/api/v1/dashboard-access/users/{user.id}"
    body = {
        "sections": {"reports": "edit", "devices": "view", "z": "view"},
        "companyIds": [str(w.b.id)], "shopIds": [str(w.b_shop.id)],
        "tenantIds": [str(w.tenant.id), str(w.other_tenant.id)],
    }
    response = w.client.put(url, headers=_headers(w.admin, w.tenant), json=body)
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["profile"]["sections"] == {"devices": "view", "reports": "edit", "z": "view"}
    assert out["profile"]["companyIds"] == [str(w.b.id)] and out["profile"]["shopIds"] == [str(w.b_shop.id)]
    assert {o["name"] for o in out["organizations"]} == {"Royal", "Other"}
    w.db.expire_all()
    assert w.db.get(User, user.id).company_id == w.b.id  # moved inside the scope
    actions = [a["action"] for a in out["audit"]]
    assert "profile.update" in actions and "membership.add" in actions and "profile.company" in actions
    update = next(a for a in out["audit"] if a["action"] == "profile.update")
    assert update["actor"] == "admin" and update["before"]["sections"] == DS.ORG_MANAGER_SECTIONS

    # Organizations: removing one drops the membership, the home one always stays.
    response = w.client.put(url, headers=_headers(w.admin, w.tenant), json={**body, "companyIds": [], "shopIds": [], "tenantIds": []})
    assert {o["name"] for o in response.json()["organizations"]} == {"Royal"}

    # Full access again.
    response = w.client.put(url, headers=_headers(w.admin, w.tenant), json={"template": "full"})
    assert response.json()["profile"]["fullAccess"] is True


@pytest.mark.parametrize(
    "body,code",
    [
        ({"sections": {"flying": "view"}}, "unknown_section"),
        ({"sections": {"reports": "admin"}}, "unknown_section"),
        ({"companyIds": ["C"]}, "company_out_of_organization"),
        ({"shopIds": ["C1"]}, "shop_out_of_organization"),
        ({"companyIds": ["A"], "shopIds": ["B1"]}, "shop_out_of_companies"),
        ({"template": str(uuid.UUID(int=7))}, "unknown_template"),
    ],
)
def test_bad_profiles_are_refused(w, body, code):
    user = _user(w.db, "u", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    w.db.commit()
    ids = {"A": w.a.id, "B1": w.b_shop.id, "C": w.c.id, "C1": w.c_shop.id}
    body = {k: ([str(ids[x]) for x in v] if k in ("companyIds", "shopIds") else v) for k, v in body.items()}
    response = w.client.put(f"/api/v1/dashboard-access/users/{user.id}", headers=_headers(w.admin, w.tenant), json=body)
    assert response.status_code == 422 and response.json()["detail"]["code"] == code, response.text


def test_org_scope_is_a_company_managers(w):
    cashier = _user(w.db, "cash", UserRole.CASHIER, w.tenant, company=w.a, shop=w.a_shop1)
    w.db.commit()
    response = w.client.put(
        f"/api/v1/dashboard-access/users/{cashier.id}", headers=_headers(w.admin, w.tenant),
        json={"sections": {"reports": "view"}, "orgWide": True},
    )
    assert response.json()["detail"]["code"] == "org_scope_needs_company_manager"
    response = w.client.put(
        f"/api/v1/dashboard-access/users/{cashier.id}", headers=_headers(w.admin, w.tenant),
        json={"sections": {"reports": "view"}},
    )
    assert response.status_code == 200


def test_templates_and_the_audit_are_the_super_admins_and_nobody_edits_themselves(w):
    legacy = _user(w.db, "legacy", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, legacy, full=True)
    cashier = _user(w.db, "cash", UserRole.CASHIER, w.tenant, company=w.a, shop=w.a_shop1)
    _profile(w.db, cashier, full=True)
    w.db.commit()
    for method, path in (
        ("GET", f"/api/v1/dashboard-access/users/{legacy.id}"), ("PUT", f"/api/v1/dashboard-access/users/{legacy.id}"),
        ("POST", "/api/v1/dashboard-access/templates"), ("GET", "/api/v1/dashboard-access/audit"),
    ):
        response = w.client.request(method, path, headers=_headers(legacy, w.tenant), json={} if method != "GET" else None)
        assert response.status_code == 403, (method, path, response.text)
    # Reading the catalogue and the templates: whoever manages users.
    assert w.client.get("/api/v1/dashboard-access/catalog", headers=_headers(legacy, w.tenant)).status_code == 200
    assert w.client.get("/api/v1/dashboard-access/templates", headers=_headers(legacy, w.tenant)).status_code == 200
    # A role that manages nobody manages nobody's permissions.
    response = w.client.get(f"/api/v1/dashboard-access/users/{legacy.id}", headers=_headers(cashier, w.tenant))
    assert response.status_code == 403


def test_templates_are_defined_applied_and_deleted(w):
    headers = _headers(w.admin, w.tenant)
    response = w.client.post(
        "/api/v1/dashboard-access/templates", headers=headers,
        json={"name": "מנהל משמרת", "sections": {"z": "edit", "reports": "view", "nope": "view"}},
    )
    assert response.status_code == 422  # an unknown section is refused, not dropped silently
    response = w.client.post(
        "/api/v1/dashboard-access/templates", headers=headers, json={"name": "מנהל משמרת", "sections": {"z": "edit", "reports": "view"}},
    )
    assert response.status_code == 201, response.text
    template = response.json()
    assert w.client.post("/api/v1/dashboard-access/templates", headers=headers, json={"name": "מנהל משמרת"}).status_code == 422
    assert w.client.post("/api/v1/dashboard-access/templates", headers=headers, json={"name": "מנהל ארגון"}).status_code == 422

    user = _user(w.db, "u", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    w.db.commit()
    response = w.client.put(f"/api/v1/dashboard-access/users/{user.id}", headers=headers, json={"template": template["id"]})
    assert response.json()["profile"]["sections"] == {"reports": "view", "z": "edit"}
    assert response.json()["profile"]["templateId"] == template["id"]

    # Changing the template later does not reach the user silently.
    w.client.put(f"/api/v1/dashboard-access/templates/{template['id']}", headers=headers, json={"name": "מנהל משמרת", "sections": {}})
    DA.forget(w.db)
    assert DA.effective_access(w.db, user).sections == {"reports": "view", "z": "edit"}

    names = [t["name"] for t in w.client.get("/api/v1/dashboard-access/templates", headers=headers).json()]
    assert names[:2] == ["מנהל ארגון", "גישה מלאה לפי תפקיד"] and "מנהל משמרת" in names
    assert w.client.delete(f"/api/v1/dashboard-access/templates/{template['id']}", headers=headers).status_code == 204
    w.db.expire_all()
    assert w.db.get(DashboardAccessProfile, user.id).template_id is None
    actions = [a["action"] for a in w.client.get("/api/v1/dashboard-access/audit", headers=headers).json()]
    assert {"template.create", "template.update", "template.delete", "profile.create"} <= set(actions)


def test_the_users_page_reads_every_profile_of_the_organization(w):
    user = _user(w.db, "u", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    DA.create_default_profile(w.db, user)
    _user(w.db, "elsewhere", UserRole.COMPANY_MANAGER, w.other_tenant, company=w.c)
    w.db.commit()
    rows = w.client.get("/api/v1/dashboard-access/users", headers=_headers(w.admin, w.tenant)).json()
    by_id = {r["userId"]: r for r in rows}
    assert by_id[str(user.id)]["templateName"] == "מנהל ארגון"
    assert by_id[str(w.admin.id)]["hasProfile"] is False and by_id[str(w.admin.id)]["templateName"] is None
    assert len(rows) == 2



# ── Self-service sign-up: the owner of a new organization ────────────────────


def _clerk(w, monkeypatch, *, email, clerk_id):
    """Sign-in as a Clerk user `clerk_id` with `email`, self-service sign-up on."""
    from app.services import clerk_provision
    from app.services.clerk_profile import ClerkProfile

    # The world's super admin has claimed its own Clerk account (else the first sign-in would).
    w.admin.clerk_user_id = "user_root"
    w.db.commit()

    monkeypatch.setattr(auth_mw, "verify_clerk_token", lambda token: clerk_id if token == f"clerk:{clerk_id}" else None)
    monkeypatch.setattr(
        clerk_provision, "fetch_clerk_profile",
        lambda cid: ClerkProfile(clerk_user_id=cid, email=email, first_name="Dana", last_name="Cohen", clerk_username=None),
    )
    monkeypatch.setattr(auth_mw.settings, "allow_self_service_signup", True)
    return {"Authorization": f"Bearer clerk:{clerk_id}"}


def test_a_self_service_sign_up_owns_its_new_organization_with_full_access(w, monkeypatch):
    headers = _clerk(w, monkeypatch, email="dana@example.com", clerk_id="user_dana")
    # The dashboard's first call provisions the account and its own new organization.
    tenants = w.client.get("/api/v1/tenants/mine", headers=headers)
    assert tenants.status_code == 200, tenants.text
    owner = w.db.query(User).filter(User.clerk_user_id == "user_dana").one()
    assert owner.role == UserRole.DISTRIBUTOR and [t["id"] for t in tenants.json()] == [str(owner.tenant_id)]
    profile = w.db.get(DashboardAccessProfile, owner.id)
    assert profile.full_access is True and profile.builtin_template == "full"
    assert not DA.effective_access(w.db, owner).restricted
    audit = w.db.query(DashboardAccessAudit).filter(DashboardAccessAudit.user_id == owner.id).all()
    assert [(a.action, a.actor_user_id) for a in audit] == [("profile.create", None)]

    # It can do what an owner has to: pair devices, manage its people.
    headers["X-Tenant-Id"] = str(owner.tenant_id)
    for method, path in (("GET", "/api/v1/machines/unassigned"), ("GET", "/api/v1/users"), ("GET", "/api/v1/pairing/codes")):
        response = w.client.request(method, path, headers=headers)
        assert not _is_section_refusal(response), (path, response.text)
    assert w.client.get("/api/v1/users/me", headers=headers).json()["dashboardAccess"]["restricted"] is False

    # Signing in again changes nothing: one profile, still full.
    w.client.get("/api/v1/tenants/mine", headers=headers)
    assert w.db.query(DashboardAccessProfile).filter(DashboardAccessProfile.user_id == owner.id).count() == 1

    # A user the owner then creates in that organization starts with the default.
    response = w.client.post(
        "/api/v1/users", headers=headers, json={"email": "staff@example.com", "role": "company_manager"},
    )
    assert response.status_code == 201, response.text
    staff = w.db.get(DashboardAccessProfile, uuid.UUID(response.json()["id"]))
    assert staff.full_access is False and DS.clean_sections(staff.sections) == DS.ORG_MANAGER_SECTIONS


def test_an_invited_user_claiming_their_account_keeps_the_default(w, monkeypatch):
    # Created inside an existing organization, from the users page, before they ever signed in.
    response = w.client.post(
        "/api/v1/users", headers=_headers(w.admin, w.tenant),
        json={"email": "invited@example.com", "role": "company_manager", "companyId": str(w.a.id)},
    )
    assert response.status_code == 201, response.text
    invited_id = uuid.UUID(response.json()["id"])
    headers = _clerk(w, monkeypatch, email="invited@example.com", clerk_id="user_invited")
    me = w.client.get("/api/v1/users/me", headers=headers)
    assert me.status_code == 200 and me.json()["id"] == str(invited_id)  # claimed, not a new organization
    assert me.json()["dashboardAccess"]["restricted"] is True
    assert w.db.get(DashboardAccessProfile, invited_id).full_access is False
    assert w.db.query(Tenant).count() == 2  # no organization was opened for them


# ── `require_section`, stated on a route ─────────────────────────────────────


def test_require_section_on_a_route_is_enforced_and_read_by_the_registry(w):
    probe = FastAPI()

    @probe.post("/probe", dependencies=[Depends(auth_mw.require_section("stock", "edit"))])
    def _probe(current_user: User = Depends(auth_mw.get_current_user)):
        return {"ok": True}

    probe.dependency_overrides[get_db] = app.dependency_overrides[get_db]
    route = next(r for r in probe.routes if getattr(r, "path", None) == "/probe")
    assert DA.classify(route, "POST").describe("POST") == "stock:edit"

    viewer = _user(w.db, "viewer", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, viewer, sections={"stock": "view"})
    editor = _user(w.db, "editor", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    _profile(w.db, editor, sections={"stock": "edit"})
    w.db.commit()
    client = TestClient(probe)
    assert _is_section_refusal(client.post("/probe", headers=_headers(viewer)))
    assert client.post("/probe", headers=_headers(editor)).json() == {"ok": True}


# ── The migration ────────────────────────────────────────────────────────────


def _migrate(w):
    path = next(ROOT.glob("alembic/versions/d4a8c2e6f0b1_*.py"))
    spec = importlib.util.spec_from_file_location("dashboard_access_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    w.db.flush()
    conn = w.db.connection()
    with Operations.context(MigrationContext.configure(conn)):
        module.upgrade()
    w.db.expire_all()
    DA.forget(w.db)


def test_the_migration_keeps_every_existing_user_as_they_were(w):
    manager = _user(w.db, "m", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    cashier = _user(w.db, "c", UserRole.CASHIER, w.tenant, company=w.a, shop=w.a_shop1)
    already = _user(w.db, "already", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    _profile(w.db, already, sections={"reports": "view"})
    w.db.commit()

    _migrate(w)
    _migrate(w)  # idempotent

    for user in (manager, cashier):
        profile = w.db.get(DashboardAccessProfile, user.id)
        assert profile.full_access is True and profile.builtin_template == "full"
        assert not DA.effective_access(w.db, user).restricted
    assert w.db.get(DashboardAccessProfile, already.id).full_access is False  # kept as it was
    assert w.db.get(DashboardAccessProfile, w.admin.id) is None  # never the super admin
    assert w.db.query(DashboardAccessProfile).count() == 3


def test_the_migration_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    # Not resolve(): under the dev box's short P: path the versions stay under MAX_PATH.
    root = pathlib.Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    # One head, and this revision on its line (the merges 7c3e9a1d5b20 and e4b7d1a9c3f6 join
    # it to main's; later ones chain on top).
    heads = script.get_heads()
    assert len(heads) == 1
    on_line = {r.revision for r in script.walk_revisions("base", heads[0])}
    assert {"d4a8c2e6f0b1", "7c3e9a1d5b20", "e4b7d1a9c3f6", "a1f0b62029f1"} <= on_line
    assert script.get_revision("d4a8c2e6f0b1").down_revision == "e9a3c7f1b5d2"
    assert set(script.get_revision("7c3e9a1d5b20").down_revision) == {"1dbac9d07adb", "d4a8c2e6f0b1"}
    assert set(script.get_revision("e4b7d1a9c3f6").down_revision) == {"7c3e9a1d5b20", "a1f0b62029f1"}
