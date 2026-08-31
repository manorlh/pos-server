"""Cover for nested companies: the descendant rule, and the guard rails in its SQL.

Style matches the rest of tests/: no database. The recursive CTE cannot be executed
here, so what is asserted instead is (a) the pure-Python contract around it — role
gating, the memo, the "root is always covered" invariant — and (b) that the SQL it
compiles to still carries the depth cap and the tenant boundary, which are the two
properties that turn bad data into a bounded query instead of a hang or a leak.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.models.user import User, UserRole
from app.routers import companies as companies_router
from app.schemas.company import CompanyUpdate
from app.services import company_hierarchy as ch


class _FakeSession:
    """Just enough Session: a real `.info` dict and a scripted `.execute`."""

    def __init__(self, rows):
        self.info: dict = {}
        self._rows = rows
        self.execute_calls = 0

    def execute(self, _statement):
        self.execute_calls += 1
        return _FakeResult(self._rows)


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)

    def all(self):
        return list(self._rows)


def _user(role: UserRole, **kw) -> User:
    u = MagicMock(spec=User)
    u.role = role
    for k, v in kw.items():
        setattr(u, k, v)
    return u


# ── The descendant set ───────────────────────────────────────────────────────

def test_a_group_covers_itself_and_everything_under_it() -> None:
    group, sub_a, sub_b, leaf = (uuid.uuid4() for _ in range(4))
    db = _FakeSession([(group, 0), (sub_a, 1), (sub_b, 1), (leaf, 2)])
    assert ch.descendant_company_ids(db, group) == [group, sub_a, sub_b, leaf]


def test_the_root_is_covered_even_when_the_row_is_missing() -> None:
    # Otherwise a dangling company_id would make this *narrower* than the flat equality
    # check it replaced, and lock a manager out of their own company.
    root = uuid.uuid4()
    db = _FakeSession([])
    assert ch.descendant_company_ids(db, root) == [root]


def test_a_repeated_row_is_returned_once() -> None:
    root, child = uuid.uuid4(), uuid.uuid4()
    db = _FakeSession([(root, 0), (child, 1), (child, 2)])
    assert ch.descendant_company_ids(db, root) == [root, child]


def test_an_unresolvable_company_id_covers_nothing() -> None:
    db = _FakeSession([(uuid.uuid4(), 0)])
    assert ch.descendant_company_ids(db, None) == []
    assert ch.descendant_company_ids(db, "not-a-uuid") == []
    assert db.execute_calls == 0


def test_the_tree_is_resolved_once_per_request() -> None:
    # This runs on nearly every request; two guards in one handler must not mean two
    # recursive CTEs.
    root = uuid.uuid4()
    db = _FakeSession([(root, 0), (uuid.uuid4(), 1)])
    ch.descendant_company_ids(db, root)
    ch.descendant_company_ids(db, root)
    ch.subtree_height(db, root)
    assert db.execute_calls == 1


def test_reparenting_drops_the_memo() -> None:
    root = uuid.uuid4()
    db = _FakeSession([(root, 0)])
    ch.descendant_company_ids(db, root)
    ch.invalidate_company_hierarchy_cache(db)
    ch.descendant_company_ids(db, root)
    assert db.execute_calls == 2


def test_depth_helpers_read_the_tree() -> None:
    root, mid, leaf = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    assert ch.subtree_height(_FakeSession([(root, 0), (mid, 1), (leaf, 2)]), root) == 2
    assert ch.subtree_height(_FakeSession([(root, 0)]), root) == 0
    assert ch.company_depth(_FakeSession([(leaf, 0), (mid, 1), (root, 2)]), leaf) == 2


# ── Role gating ──────────────────────────────────────────────────────────────

def test_only_a_company_manager_reaches_subsidiaries() -> None:
    group, sub = uuid.uuid4(), uuid.uuid4()
    rows = [(group, 0), (sub, 1)]

    manager = _user(UserRole.COMPANY_MANAGER, company_id=group)
    assert ch.company_scope_ids(_FakeSession(rows), manager) == [group, sub]

    # A shop manager and a cashier are scoped to one shop; their company_id exists so
    # they can read the name and VAT number on their receipts, not to walk a group.
    for role in (UserRole.SHOP_MANAGER, UserRole.CASHIER):
        db = _FakeSession(rows)
        assert ch.company_scope_ids(db, _user(role, company_id=group)) == [group]
        assert db.execute_calls == 0


def test_a_manager_covers_a_subsidiary_but_not_a_sibling() -> None:
    group, sub, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    rows = [(group, 0), (sub, 1)]
    manager = _user(UserRole.COMPANY_MANAGER, company_id=group)
    assert ch.user_covers_company(_FakeSession(rows), manager, sub) is True
    assert ch.user_covers_company(_FakeSession(rows), manager, stranger) is False


def test_covering_your_own_company_costs_no_query() -> None:
    own = uuid.uuid4()
    db = _FakeSession([])
    assert ch.user_covers_company(db, _user(UserRole.CASHIER, company_id=own), own) is True
    assert db.execute_calls == 0


def test_a_shop_manager_does_not_reach_past_its_own_company() -> None:
    group, sub = uuid.uuid4(), uuid.uuid4()
    db = _FakeSession([(group, 0), (sub, 1)])
    assert ch.user_covers_company(db, _user(UserRole.SHOP_MANAGER, company_id=group), sub) is False
    assert db.execute_calls == 0


# ── The guard rails, read off the compiled SQL ───────────────────────────────

def _compiled(fn) -> str:
    captured = {}

    class _CapturingSession:
        info: dict = {}

        def execute(self, statement):
            captured["sql"] = str(
                statement.compile(
                    dialect=postgresql.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
            )
            return _FakeResult([])

    fn(_CapturingSession(), uuid.uuid4())
    return captured["sql"]


def test_the_traversal_is_depth_capped_and_tenant_bounded() -> None:
    for sql in (_compiled(ch.descendant_company_ids), _compiled(ch.ancestor_company_ids)):
        assert "WITH RECURSIVE" in sql
        # A cycle from a manual UPDATE or a restored dump must not spin forever.
        assert f"depth < {ch.MAX_COMPANY_DEPTH}" in sql
        # A parent and a child must never straddle tenants, so the walk refuses to.
        assert "tenant_id IS NOT DISTINCT FROM" in sql


# ── The write guards on companies.parent_company_id ──────────────────────────
#
# The descendant walk itself is covered above; these are about the *policy* the write
# path applies, so the three resolvers are stubbed and the decisions are what is read.


class _ParentLookup:
    """A session whose only job is to return one company row by id."""

    def __init__(self, parent, children: int = 0):
        self.info: dict = {}
        self._parent = parent
        self._children = children

    def query(self, *_entities):
        return self

    def filter(self, *_criteria):
        return self

    def first(self):
        return self._parent

    def count(self):
        return self._children


def _company(tenant_id, **kw):
    c = MagicMock()
    c.id = kw.pop("id", uuid.uuid4())
    c.tenant_id = tenant_id
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def _stub_tree(monkeypatch, *, descendants=(), height=0, depth=0):
    monkeypatch.setattr(companies_router, "descendant_company_ids", lambda *_: list(descendants))
    monkeypatch.setattr(companies_router, "subtree_height", lambda *_: height)
    monkeypatch.setattr(companies_router, "company_depth", lambda *_: depth)


def _http_error(fn, *args, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*args, **kw)
    return e.value


def test_a_company_cannot_be_its_own_parent(monkeypatch) -> None:
    tenant = uuid.uuid4()
    company = _company(tenant)
    _stub_tree(monkeypatch, descendants=[company.id])
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(company),
        company.id,
        tenant,
        company=company,
    )
    assert err.status_code == 400
    assert err.detail == "Circular reference detected"


def test_a_company_cannot_adopt_its_own_descendant(monkeypatch) -> None:
    # A → B today; making B the parent of A would orphan the whole group from every
    # query and spin any walk that is not depth-capped.
    tenant = uuid.uuid4()
    company = _company(tenant)
    child = _company(tenant)
    _stub_tree(monkeypatch, descendants=[company.id, child.id])
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(child),
        child.id,
        tenant,
        company=company,
    )
    assert err.status_code == 400
    assert err.detail == "Circular reference detected"


def test_a_parent_from_another_tenant_is_refused(monkeypatch) -> None:
    _stub_tree(monkeypatch)
    tenant, other = uuid.uuid4(), uuid.uuid4()
    company = _company(tenant)
    foreign_parent = _company(other)
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(foreign_parent),
        foreign_parent.id,
        tenant,
        company=company,
    )
    assert err.status_code == 403  # ensure_same_tenant
    assert err.detail == "tenant_forbidden"


def test_a_legacy_null_tenant_parent_is_refused(monkeypatch) -> None:
    # ensure_same_tenant tolerates a null entity tenant. Such an edge would be silently
    # unwalkable (the CTE is tenant-bounded), which is worse than a rejection.
    _stub_tree(monkeypatch)
    tenant = uuid.uuid4()
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(_company(None)),
        uuid.uuid4(),
        tenant,
        company=_company(tenant),
    )
    assert err.status_code == 400
    assert err.detail == "Parent company belongs to a different tenant"


def test_a_missing_parent_is_refused(monkeypatch) -> None:
    _stub_tree(monkeypatch)
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(None),
        uuid.uuid4(),
        uuid.uuid4(),
    )
    assert err.status_code == 400
    assert err.detail == "Parent company not found"


def test_the_depth_limit_counts_the_moved_subtree_too(monkeypatch) -> None:
    # Attaching a 2-deep group under a company that is already 3 deep would make the
    # chain 6 companies long. It is the resulting depth that is capped, not the parent's.
    tenant = uuid.uuid4()
    company = _company(tenant)
    parent = _company(tenant)
    _stub_tree(monkeypatch, descendants=[company.id], height=2, depth=ch.MAX_COMPANY_DEPTH - 2)
    err = _http_error(
        companies_router._resolve_parent_company,
        _ParentLookup(parent),
        parent.id,
        tenant,
        company=company,
    )
    assert err.status_code == 400
    assert "levels" in err.detail

    # One tier shallower is fine.
    _stub_tree(monkeypatch, descendants=[company.id], height=1, depth=ch.MAX_COMPANY_DEPTH - 2)
    assert companies_router._resolve_parent_company(
        _ParentLookup(parent), parent.id, tenant, company=company
    ) is parent


def test_only_a_distributor_may_move_a_company_in_the_tree() -> None:
    # A company manager may edit their company's profile, but reparenting hands the new
    # parent's managers every shop, till and transaction underneath it.
    assert companies_router._REPARENT_ROLES == frozenset(
        {UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR}
    )
    src = inspect.getsource(companies_router.update_company)
    assert "_REPARENT_ROLES" in src
    assert "_resolve_parent_company" in src


def test_deleting_a_parent_with_children_is_refused() -> None:
    # Not cascaded (that would delete subsidiaries and their shops' FK parent) and not
    # detached (that would silently reorganise the group).
    tenant = uuid.uuid4()
    company = _company(tenant)
    db = _ParentLookup(company, children=2)
    err = _http_error(
        companies_router.delete_company, str(company.id), _user(UserRole.DISTRIBUTOR), tenant, db
    )
    assert err.status_code == 422
    assert err.detail == "Company has child companies"


def test_echoing_the_current_parent_is_not_a_reparent() -> None:
    # The dashboard PUTs the whole company object back. `parentCompanyId` unchanged is
    # not a restructure, and 403-ing a company manager for it would break every
    # profile edit they make.
    parent_id = uuid.uuid4()
    assert companies_router._same_parent(parent_id, parent_id) is True
    assert companies_router._same_parent(str(parent_id), parent_id) is True
    assert companies_router._same_parent(None, None) is True
    assert companies_router._same_parent(parent_id, None) is False
    assert companies_router._same_parent(None, parent_id) is False


def test_a_company_manager_may_still_edit_a_company_that_has_a_parent(monkeypatch) -> None:
    tenant = uuid.uuid4()
    parent_id = uuid.uuid4()
    company = _company(tenant, parent_company_id=parent_id, settings={}, name="before")
    _stub_tree(monkeypatch, descendants=[company.id])

    class _Db(_ParentLookup):
        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    monkeypatch.setattr(
        companies_router, "notify_machines_for_company_settings", lambda *a, **k: None
    )
    data = CompanyUpdate.model_validate(
        {"name": "after", "parentCompanyId": str(parent_id)}
    )
    result = companies_router.update_company(
        str(company.id),
        data,
        _user(UserRole.COMPANY_MANAGER, company_id=company.id),
        tenant,
        _Db(company),
    )
    assert result.name == "after"


def test_moving_a_company_is_refused_to_a_company_manager(monkeypatch) -> None:
    tenant = uuid.uuid4()
    company = _company(tenant, parent_company_id=None, settings={})
    _stub_tree(monkeypatch, descendants=[company.id])
    err = _http_error(
        companies_router.update_company,
        str(company.id),
        CompanyUpdate.model_validate({"parentCompanyId": str(uuid.uuid4())}),
        _user(UserRole.COMPANY_MANAGER, company_id=company.id),
        tenant,
        _ParentLookup(company),
    )
    assert err.status_code == 403
    assert err.detail == "Only a distributor can change a company's parent"
