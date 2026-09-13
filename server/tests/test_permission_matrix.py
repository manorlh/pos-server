"""
The permission grid.

Two jobs. First, prove the consolidation changed nobody's access: the sets below are the
tuples that were previously retyped in each router, written out longhand so that a change
to the grid has to be a deliberate change here too. Second, prove the grid denies by
default — a missing entry must lock a door, not open one.

Note what these tests do *not* cover: which rows a caller may see. That is
`scope_query_by_user`, tested separately, and passing a role check says nothing about
whether the record in hand belongs to the caller's company.
"""
from __future__ import annotations

import pytest

from app.models.user import UserRole
from app.services.permission_matrix import Action, Resource, may, roles_for

ALL_ROLES = set(UserRole)

#: Exactly what each router's constant contained before the consolidation.
BEFORE = {
    (Resource.CATALOG, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
    },
    (Resource.CUSTOMER, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
    },
    (Resource.STOCK, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
    },
    (Resource.IMAGE, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER,
    },
    (Resource.BRANDING, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
    },
    (Resource.COMPANY_TREE, Action.WRITE): {
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
    },
}


class TestNobodyGainedOrLostAccess:
    @pytest.mark.parametrize("key", list(BEFORE))
    def test_the_permitted_set_is_unchanged(self, key):
        assert set(roles_for(*key)) == BEFORE[key]

    @pytest.mark.parametrize("key", list(BEFORE))
    def test_every_other_role_is_still_refused(self, key):
        """
        The half that matters. Asserting who is allowed cannot catch a set that has
        quietly widened; asserting who is refused can.
        """
        for role in ALL_ROLES - BEFORE[key]:
            assert may(role, *key) is False, f"{role} gained {key}"

    def test_a_cashier_can_write_nothing_in_the_dashboard(self):
        for resource in Resource:
            assert may(UserRole.CASHIER, resource, Action.WRITE) is False

    def test_a_shop_manager_may_price_a_product_but_not_replace_its_photograph(self):
        """A photograph is chain artwork; pricing is a branch decision."""
        assert may(UserRole.SHOP_MANAGER, Resource.CATALOG, Action.WRITE) is True
        assert may(UserRole.SHOP_MANAGER, Resource.IMAGE, Action.WRITE) is False

    def test_nobody_inside_a_company_may_rearrange_the_group(self):
        """Re-parenting changes who can see whose takings."""
        assert may(UserRole.COMPANY_MANAGER, Resource.COMPANY_TREE, Action.WRITE) is False
        assert may(UserRole.SHOP_MANAGER, Resource.COMPANY_TREE, Action.WRITE) is False


class TestTheGridDeniesByDefault:
    def test_an_unlisted_pair_denies_rather_than_allows(self):
        """
        So a typo in a resource name locks a door instead of opening one. The opposite
        default would make a rename silently grant everyone everything.
        """
        assert roles_for(Resource.BRANDING, Action.WRITE) != frozenset()
        for role in ALL_ROLES:
            assert may(role, Resource.COMPANY_TREE, "nonexistent-action") is False

    def test_super_admin_is_not_implicitly_privileged(self):
        """
        There is no wildcard. Super admin appears in every set because it was written
        there, so removing it from one is a visible edit rather than a silent exception.
        """
        assert may(UserRole.SUPER_ADMIN, Resource.CATALOG, "nonexistent-action") is False


class TestTheRoutersUseTheGrid:
    """The grid is only worth having if the routers actually read it."""

    @pytest.mark.parametrize(
        "module,name,expected",
        [
            ("app.routers.products", "_CATALOG_ROLES", (Resource.CATALOG, Action.WRITE)),
            ("app.routers.categories", "_CATALOG_ROLES", (Resource.CATALOG, Action.WRITE)),
            ("app.routers.vouchers", "_CATALOG_ROLES", (Resource.CATALOG, Action.WRITE)),
            ("app.routers.customers", "_CATALOG_ROLES", (Resource.CUSTOMER, Action.WRITE)),
            ("app.routers.images", "_IMAGE_ROLES", (Resource.IMAGE, Action.WRITE)),
            ("app.routers.images", "_BRANDING_ROLES", (Resource.BRANDING, Action.WRITE)),
            ("app.routers.stock", "_STOCK_WRITE_ROLES", (Resource.STOCK, Action.WRITE)),
            ("app.routers.companies", "_REPARENT_ROLES", (Resource.COMPANY_TREE, Action.WRITE)),
        ],
    )
    def test_each_router_constant_comes_from_the_grid(self, module, name, expected):
        import importlib

        mod = importlib.import_module(module)
        assert set(getattr(mod, name)) == set(roles_for(*expected))
