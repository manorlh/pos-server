"""
Regression cover for five authorization holes, each verified present before the fix.

These assert the *guards*, not the handlers. Every one of them is a single line or a
single function reference that someone could delete during an unrelated edit and
nothing else in the suite would notice — which is how four of the five got there.

Style matches the rest of tests/: no database, no client. The dependency each endpoint
declares and the role sets the guards compare against are read directly, because that
is where the decision actually lives.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.middleware.auth import get_current_distributor, get_current_machine_admin, get_current_user
from app.models.tenant_membership import TenantMembershipRole
from app.models.user import User, UserRole
from app.routers import z_runs as z_runs_router
from app.routers import machines as machines_router
from app.routers import companies as companies_router
from app.routers import shops as shops_router
from app.routers import tenants as tenants_router
from app.routers import vouchers as vouchers_router


def _declared_dependency(func, param_name: str = "current_user"):
    """The dependency callable an endpoint declares for its caller identity."""
    param = inspect.signature(func).parameters[param_name]
    return param.default.dependency


def _user(role: UserRole, **kw) -> User:
    u = MagicMock(spec=User)
    u.role = role
    for k, v in kw.items():
        setattr(u, k, v)
    return u


# ── 1. POST /tenants ─────────────────────────────────────────────────────────

def test_creating_a_tenant_requires_a_distributor() -> None:
    # Was get_current_user: any authenticated identity, down to a cashier. The caller
    # is then inserted as TENANT_OWNER, which grants tenant-wide settings writes.
    dep = _declared_dependency(tenants_router.create_tenant)
    assert dep is get_current_distributor
    assert dep is not get_current_user


# ── 5. Membership auto-grant ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    "role,expected",
    [
        (UserRole.SUPER_ADMIN, TenantMembershipRole.TENANT_ADMIN),
        (UserRole.DISTRIBUTOR, TenantMembershipRole.TENANT_ADMIN),
        (UserRole.COMPANY_MANAGER, TenantMembershipRole.TENANT_ADMIN),
        # The fix: a single shop's manager is a member, not an admin.
        (UserRole.SHOP_MANAGER, TenantMembershipRole.TENANT_MEMBER),
        (UserRole.CASHIER, TenantMembershipRole.TENANT_MEMBER),
    ],
)
def test_home_tenant_membership_role_by_user_role(role, expected) -> None:
    db = MagicMock()
    # Two sequential lookups: "membership already exists?" (must be None so a row gets
    # created) then "does the tenant exist?" (must be found, or it returns early).
    db.query.return_value.filter.return_value.first.side_effect = [None, MagicMock()]
    added = []
    db.add.side_effect = added.append

    tenants_router._ensure_membership_for_user_home_tenant(db, _user(role, tenant_id="t1", id="u1"))

    assert len(added) == 1, "expected exactly one membership row"
    assert added[0].role == expected


def test_a_shop_manager_with_only_member_standing_cannot_administer_the_tenant() -> None:
    # The consequence being guarded: tenant_admin carries PATCH /tenants/{id} and
    # tenant-wide POS settings, which fan out to every machine in every shop.
    #
    # _can_manage_tenant asks the database for an owner/admin membership, so "no such
    # row" is what a member looks like to it. Together with the parametrised test
    # above — which pins a shop_manager to TENANT_MEMBER — this closes the loop.
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    assert tenants_router._can_manage_tenant(
        _user(UserRole.SHOP_MANAGER, id="u1"), uuid.uuid4(), db
    ) is False


def test_a_super_admin_still_manages_the_tenant_without_a_membership_row() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    assert tenants_router._can_manage_tenant(
        _user(UserRole.SUPER_ADMIN, id="u1"), uuid.uuid4(), db
    ) is True


# ── 3a. Voucher reads ────────────────────────────────────────────────────────

def test_cashier_is_excluded_from_catalog_roles() -> None:
    assert UserRole.CASHIER not in vouchers_router._CATALOG_ROLES
    # …and the roles that may read are the same ones that may write, deliberately.
    assert UserRole.SHOP_MANAGER in vouchers_router._CATALOG_ROLES


@pytest.mark.parametrize("endpoint", ["list_vouchers", "get_voucher"])
def test_voucher_reads_are_gated_on_catalog_roles(endpoint) -> None:
    # The filter was tenant-only, so a cashier could enumerate every voucher template
    # in the tenant while all three write siblings were gated.
    src = inspect.getsource(getattr(vouchers_router, endpoint))
    assert "_CATALOG_ROLES" in src, f"{endpoint} must gate on _CATALOG_ROLES"


# ── 3b. Producing a Z ─────────────────────────────────────────────────────────
#
# Producing a Z needs the roles that could close a day before (machine admins:
# company manager, shop manager, distributor, super admin). A cashier or a shift
# supervisor may close their own shift at the till, never produce the shop's Z.


@pytest.mark.parametrize(
    "endpoint",
    [
        z_runs_router.post_z_run,
        z_runs_router.post_z_run_proceed,
        z_runs_router.post_z_run_cancel,
        z_runs_router.get_z_run,
        z_runs_router.get_z_candidates,
        machines_router.administrative_close_shift,
    ],
)
def test_producing_a_z_needs_a_machine_admin(endpoint) -> None:
    assert _declared_dependency(endpoint) is get_current_machine_admin


@pytest.mark.parametrize("role", [UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR])
def test_a_cashier_or_supervisor_is_not_a_machine_admin(role) -> None:
    with pytest.raises(HTTPException) as e:
        get_current_machine_admin(_user(role))
    assert e.value.status_code == 403


def test_every_z_run_endpoint_checks_the_shop() -> None:
    """The role alone would let a shop manager run another shop's Z."""
    for fn in (z_runs_router.post_z_run, z_runs_router.get_z_candidates):
        assert "_shop_for(" in inspect.getsource(fn)
    assert "_shop_for(" in inspect.getsource(z_runs_router._run_or_404)


# ── 3c. PUT /shops ───────────────────────────────────────────────────────────

def test_editing_a_shop_uses_the_write_helper_not_the_read_helper() -> None:
    src = inspect.getsource(shops_router.update_shop)
    assert "_check_shop_override_write" in src
    assert "_check_shop_access(" not in src, "read helper admits CASHIER"


def test_shop_write_helper_denies_a_cashier_and_admits_a_shop_manager() -> None:
    shop = MagicMock(id="s1", company_id="c1")
    with pytest.raises(HTTPException) as e:
        shops_router._check_shop_override_write(_user(UserRole.CASHIER, shop_id="s1"), shop, MagicMock())
    assert e.value.status_code == 403
    # Not a blanket denial — the role above it still works.
    shops_router._check_shop_override_write(_user(UserRole.SHOP_MANAGER, shop_id="s1"), shop, MagicMock())


# ── 3d. PUT /companies ───────────────────────────────────────────────────────

def test_editing_a_company_uses_the_write_helper() -> None:
    src = inspect.getsource(companies_router.update_company)
    assert "_check_company_write" in src
    assert "_check_company_access(" not in src


def test_company_write_helper_denies_a_cashier_and_admits_a_shop_manager() -> None:
    company = MagicMock(id="c1")
    with pytest.raises(HTTPException) as e:
        companies_router._check_company_write(
            _user(UserRole.CASHIER, company_id="c1"), company, MagicMock()
        )
    assert e.value.status_code == 403
    companies_router._check_company_write(
        _user(UserRole.SHOP_MANAGER, company_id="c1"), company, MagicMock()
    )


def test_company_reads_still_admit_a_cashier() -> None:
    # The fix must not lock a cashier out of reading its own company; every receipt
    # shows the company name and VAT number.
    companies_router._check_company_access(
        _user(UserRole.CASHIER, company_id="c1"), MagicMock(id="c1"), MagicMock()
    )


def test_company_access_on_your_own_company_costs_no_query() -> None:
    # The company guards take a Session now because a group manager's reach follows
    # companies.parent_company_id. The overwhelmingly common case — acting on your own
    # company — must still be answered without touching the database, or every request
    # in the system grows a recursive CTE.
    db = MagicMock()
    companies_router._check_company_access(
        _user(UserRole.COMPANY_MANAGER, company_id="c1"), MagicMock(id="c1"), db
    )
    db.execute.assert_not_called()
    db.query.assert_not_called()
