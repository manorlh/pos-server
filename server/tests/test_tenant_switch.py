"""
Switching organization (tenant) the way the dashboard does it: the same user, the
same token, a different `X-Tenant-Id` header.

The QA report "you cannot move between organizations" turned out to be the dashboard
reverting its own switch (see `client/src/lib/tenantSwitch.ts`); the server side was
right. These tests pin the server side so it stays right:

* who may send which tenant — a super admin any, everyone else only a tenant they hold
  a membership in, whatever their role;
* that switching back and forth never lets one tenant's rows answer for another.

Requests go through the real app and its real `get_active_tenant_id`; only the user
and the database are stand-ins. The database is an in-memory evaluator for the few
query shapes these handlers use, so a handler that dropped its tenant filter would
return the other tenant's rows here exactly as it would against Postgres.
"""
from __future__ import annotations

import operator
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm.attributes import InstrumentedAttribute
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import BinaryExpression, BindParameter, BooleanClauseList

from app.database import get_db
from app.main import app
from app.middleware.auth import get_current_user
from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant, TenantStatus
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import UserRole

API = "/api/v1"
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)


# ── An in-memory database, just enough for these handlers ────────────────────

def _norm(v):
    # Postgres compares a uuid column with a string parameter by value; so does this.
    return str(v) if isinstance(v, uuid.UUID) else v


def _value(side):
    if isinstance(side, BindParameter):
        v = side.value
        return [_norm(x) for x in v] if isinstance(v, (list, tuple, set)) else _norm(v)
    raise NotImplementedError(f"unsupported operand {side!r}")


def _matches(row, clause) -> bool:
    if isinstance(clause, BooleanClauseList):
        results = [_matches(row, c) for c in clause.clauses]
        return all(results) if clause.operator is operators.and_ else any(results)
    if isinstance(clause, BinaryExpression):
        actual = _norm(getattr(row, clause.left.key))
        if clause.operator is operators.in_op:
            return actual in set(_value(clause.right))
        if clause.operator is operators.is_:
            return actual is None
        ops = {operators.eq: operator.eq, operators.ne: operator.ne}
        if clause.operator in ops:
            return ops[clause.operator](actual, _value(clause.right))
    raise NotImplementedError(f"unsupported clause {clause!r}")


class _Query:
    def __init__(self, rows, project=None):
        self._rows = list(rows)
        self._project = project
        self._limit = None

    def filter(self, *clauses):
        q = _Query([r for r in self._rows if all(_matches(r, c) for c in clauses)], self._project)
        q._limit = self._limit
        return q

    def order_by(self, *_):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def _out(self):
        rows = self._rows if self._limit is None else self._rows[: self._limit]
        if self._project is None:
            return rows
        return [tuple(getattr(r, key) for key in self._project) for r in rows]

    def all(self):
        return self._out()

    def first(self):
        out = self._out()
        return out[0] if out else None


class _Db:
    def __init__(self, tables):
        self.tables = tables
        self.info: dict = {}

    def query(self, *entities):
        first = entities[0]
        if isinstance(first, InstrumentedAttribute):
            return _Query(self.tables.get(first.class_, []), project=[e.key for e in entities])
        return _Query(self.tables.get(first, []))

    def add(self, row):
        self.tables.setdefault(type(row), []).append(row)

    def flush(self):
        pass

    def commit(self):
        pass

    def close(self):
        pass


# ── Two organizations, and people who belong to them ─────────────────────────

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def _tenant(tid, name):
    return SimpleNamespace(
        id=tid, name=name, slug=name.lower(), status=TenantStatus.ACTIVE, timezone="Asia/Jerusalem",
        default_currency="ILS", locale="he-IL", settings=None, created_by_user_id=None,
        created_at=NOW, updated_at=NOW,
    )


def _company(tid, name):
    return SimpleNamespace(
        id=uuid.uuid4(), tenant_id=tid, parent_company_id=None, name=name, vat_number=None,
        address=None, city=None, is_active=True, created_at=NOW, updated_at=NOW,
    )


def _shop(tid, company, name):
    return SimpleNamespace(
        id=uuid.uuid4(), tenant_id=tid, company_id=company.id, name=name, branch_id=None,
        address=None, city=None, is_active=True, created_at=NOW, updated_at=NOW,
    )


def _user(role, home_tenant=TENANT_A):
    return SimpleNamespace(
        id=uuid.uuid4(), role=role, tenant_id=home_tenant, company_id=None, shop_id=None,
        is_active=True,
    )


def _membership(user, tid, *, default=False):
    return SimpleNamespace(
        id=uuid.uuid4(), user_id=user.id, tenant_id=tid, role=TenantMembershipRole.TENANT_OWNER,
        is_default=default, created_at=NOW,
    )


COMPANY_A = _company(TENANT_A, "Alpha Foods")
COMPANY_B = _company(TENANT_B, "Beta Coffee")
SHOP_A = _shop(TENANT_A, COMPANY_A, "Alpha Haifa")
SHOP_B = _shop(TENANT_B, COMPANY_B, "Beta Eilat")


def _client(user, memberships):
    db = _Db({
        Tenant: [_tenant(TENANT_A, "Alpha"), _tenant(TENANT_B, "Beta")],
        TenantMembership: list(memberships),
        Company: [COMPANY_A, COMPANY_B],
        Shop: [SHOP_A, SHOP_B],
    })
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def _get(client, path, tenant_id):
    headers = {"Authorization": "Bearer stand-in"}
    if tenant_id is not None:
        headers["X-Tenant-Id"] = str(tenant_id)
    return client.get(f"{API}{path}", headers=headers)


# ── Who may switch ───────────────────────────────────────────────────────────

def test_a_super_admin_switches_to_any_tenant_without_a_membership() -> None:
    admin = _user(UserRole.SUPER_ADMIN, home_tenant=None)
    client = _client(admin, memberships=[])
    for tid, company in ((TENANT_A, COMPANY_A), (TENANT_B, COMPANY_B)):
        res = _get(client, "/companies", tid)
        assert res.status_code == 200, res.text
        assert [c["id"] for c in res.json()] == [str(company.id)]


def test_a_super_admin_is_offered_every_tenant() -> None:
    admin = _user(UserRole.SUPER_ADMIN, home_tenant=None)
    res = _get(_client(admin, memberships=[]), "/tenants/mine", None)
    assert res.status_code == 200, res.text
    assert {t["id"] for t in res.json()} == {str(TENANT_A), str(TENANT_B)}


def test_a_distributor_switches_between_the_tenants_it_belongs_to() -> None:
    dist = _user(UserRole.DISTRIBUTOR)
    client = _client(dist, [_membership(dist, TENANT_A, default=True), _membership(dist, TENANT_B)])

    offered = _get(client, "/tenants/mine", None)
    assert offered.status_code == 200, offered.text
    assert [t["id"] for t in offered.json()] == [str(TENANT_A), str(TENANT_B)]

    # Home tenant, the other one, and back: each answers with its own rows only.
    for tid, shop in ((TENANT_A, SHOP_A), (TENANT_B, SHOP_B), (TENANT_A, SHOP_A)):
        res = _get(client, "/shops", tid)
        assert res.status_code == 200, res.text
        assert [s["id"] for s in res.json()] == [str(shop.id)]


def test_the_distributor_s_home_tenant_is_not_what_decides() -> None:
    """`user.tenant_id` is where the account was made, not a limit on where it works."""
    dist = _user(UserRole.DISTRIBUTOR, home_tenant=TENANT_A)
    client = _client(dist, [_membership(dist, TENANT_A, default=True), _membership(dist, TENANT_B)])
    res = _get(client, "/companies", TENANT_B)
    assert res.status_code == 200, res.text
    assert [c["id"] for c in res.json()] == [str(COMPANY_B.id)]


# ── Who may not ──────────────────────────────────────────────────────────────

_NOT_SUPER_ADMIN = [r for r in UserRole if r is not UserRole.SUPER_ADMIN]


@pytest.mark.parametrize("role", _NOT_SUPER_ADMIN, ids=lambda r: r.value)
def test_without_a_membership_no_role_can_switch_in(role) -> None:
    user = _user(role, home_tenant=TENANT_A)
    client = _client(user, [_membership(user, TENANT_A, default=True)])
    res = _get(client, "/companies", TENANT_B)
    assert res.status_code == 403
    assert res.json()["detail"] == "tenant_forbidden"


@pytest.mark.parametrize("role", _NOT_SUPER_ADMIN, ids=lambda r: r.value)
def test_a_tenant_is_not_offered_without_a_membership(role) -> None:
    user = _user(role, home_tenant=TENANT_A)
    res = _get(_client(user, [_membership(user, TENANT_A, default=True)]), "/tenants/mine", None)
    assert res.status_code == 200, res.text
    assert [t["id"] for t in res.json()] == [str(TENANT_A)]


def test_a_malformed_tenant_header_is_refused_not_ignored() -> None:
    admin = _user(UserRole.SUPER_ADMIN, home_tenant=None)
    res = _get(_client(admin, memberships=[]), "/companies", "not-a-uuid")
    assert res.status_code == 400


def test_several_tenants_and_no_header_is_refused_rather_than_guessed() -> None:
    dist = _user(UserRole.DISTRIBUTOR)
    client = _client(dist, [_membership(dist, TENANT_A, default=True), _membership(dist, TENANT_B)])
    res = _get(client, "/companies", None)
    assert res.status_code == 400
    assert res.json()["detail"] == "Missing X-Tenant-Id header"


# ── Nothing crosses over ─────────────────────────────────────────────────────

@pytest.mark.parametrize("role", [UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR], ids=lambda r: r.value)
def test_after_a_switch_the_old_tenant_s_rows_never_answer(role) -> None:
    user = _user(role)
    client = _client(user, [_membership(user, TENANT_A, default=True), _membership(user, TENANT_B)])

    for tid, own, other in (
        (TENANT_A, (COMPANY_A, SHOP_A), (COMPANY_B, SHOP_B)),
        (TENANT_B, (COMPANY_B, SHOP_B), (COMPANY_A, SHOP_A)),
        (TENANT_A, (COMPANY_A, SHOP_A), (COMPANY_B, SHOP_B)),
    ):
        companies = {c["id"] for c in _get(client, "/companies", tid).json()}
        shops = {s["id"] for s in _get(client, "/shops", tid).json()}
        assert companies == {str(own[0].id)}
        assert shops == {str(own[1].id)}
        assert str(other[0].id) not in companies
        assert str(other[1].id) not in shops


def test_an_old_tenant_s_company_named_after_a_switch_is_refused() -> None:
    """
    What the dashboard does when its URL still carries the previous tenant's
    company: the server refuses the id under the new tenant, and says so with
    `tenant_forbidden` — which is why the dashboard must not read that answer as
    "this tenant is not yours".
    """
    dist = _user(UserRole.DISTRIBUTOR)
    client = _client(dist, [_membership(dist, TENANT_A, default=True), _membership(dist, TENANT_B)])
    res = _get(client, f"/companies/{COMPANY_A.id}", TENANT_B)
    assert res.status_code == 403
    assert res.json()["detail"] == "tenant_forbidden"
    # …while the same tenant header is perfectly good for the tenant's own rows.
    assert _get(client, f"/companies/{COMPANY_B.id}", TENANT_B).status_code == 200
