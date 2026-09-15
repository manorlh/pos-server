"""
Who can see which catalog rows.

A tenant-wide product carries no company at all, and the scoping filtered on company
*membership* — so `NULL` matched nothing and every global row was invisible to every
merchant-side role. Measured against the production database before the fix: a company
manager saw 1 product of 8, and a shop manager, shift supervisor and cashier saw none,
while the permission grid said a shop manager may *edit* the catalog. Authorised to
change a catalog they could not see.

The other half of these tests is the half the fix could break: widening visibility must
not let one company see another's products.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.models.user import User, UserRole
from app.services import company_hierarchy as H


def _user(role, *, company_id=None, shop_id=None):
    u = User()
    u.role = role
    u.company_id = company_id
    u.shop_id = shop_id
    return u


class _Db:
    """Resolves a shop to its company; nothing else is queried."""

    def __init__(self, shop_company=None):
        self._shop_company = shop_company

    def query(self, *_):
        return self

    def filter(self, *_):
        return self

    def first(self):
        return (self._shop_company,) if self._shop_company is not None else None


class TestTenantLevelRoles:
    def test_a_distributor_gets_no_company_filter_at_all(self):
        """`None` means "do not filter", which is not the same as "filter to nothing"."""
        assert H.catalog_company_ids(_Db(), _user(UserRole.DISTRIBUTOR)) is None

    def test_a_super_admin_likewise(self):
        assert H.catalog_company_ids(_Db(), _user(UserRole.SUPER_ADMIN)) is None


class TestACompanyManager:
    def test_they_get_their_subtree_and_their_ancestors(self):
        """
        Subtree because they manage downwards; ancestors because a catalog is inherited
        downwards, so a product defined on the holding company is one their branches sell.
        """
        own, child, parent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        with patch.object(H, "descendant_company_ids", return_value=[own, child]), \
             patch.object(H, "ancestor_company_ids", return_value=[parent]):
            ids = H.catalog_company_ids(_Db(), _user(UserRole.COMPANY_MANAGER, company_id=own))

        assert set(ids) == {own, child, parent}

    def test_a_sibling_company_is_in_neither_direction(self):
        """The isolation that actually matters: X must not see Y."""
        own, sibling = uuid.uuid4(), uuid.uuid4()

        with patch.object(H, "descendant_company_ids", return_value=[own]), \
             patch.object(H, "ancestor_company_ids", return_value=[]):
            ids = H.catalog_company_ids(_Db(), _user(UserRole.COMPANY_MANAGER, company_id=own))

        assert sibling not in ids


class TestAShopLevelRole:
    @pytest.mark.parametrize(
        "role", [UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR, UserRole.CASHIER]
    )
    def test_they_get_their_shops_company_and_its_ancestors(self, role):
        """
        A shop user has no company of their own; theirs is the one their shop sits in.
        They see the whole company catalog, not just their branch's slice — which shop
        actually sells what is the assortment's job, not the catalog's.
        """
        company, parent = uuid.uuid4(), uuid.uuid4()

        with patch.object(H, "ancestor_company_ids", return_value=[parent]):
            ids = H.catalog_company_ids(
                _Db(shop_company=company), _user(role, shop_id=uuid.uuid4())
            )

        assert set(ids) == {company, parent}

    def test_a_user_with_no_shop_sees_no_company_rows(self):
        """Empty list, not None — "filter to nothing" rather than "do not filter"."""
        assert H.catalog_company_ids(_Db(), _user(UserRole.CASHIER)) == []

    def test_a_shop_with_no_company_likewise(self):
        ids = H.catalog_company_ids(_Db(shop_company=None), _user(UserRole.CASHIER, shop_id=uuid.uuid4()))

        assert ids == []


class TestTheEmptyAndNoneDistinction:
    """
    The distinction the callers turn into SQL, and getting it backwards is a tenant-wide
    leak in one direction and an empty catalog in the other.
    """

    def test_none_and_empty_are_different_answers(self):
        no_filter = H.catalog_company_ids(_Db(), _user(UserRole.SUPER_ADMIN))
        nothing = H.catalog_company_ids(_Db(), _user(UserRole.CASHIER))

        assert no_filter is None
        assert nothing == []
        assert no_filter != nothing

    def test_ids_are_deduplicated_and_ordered(self):
        """A company that is both its own ancestor-chain root and subtree root appears once."""
        own = uuid.uuid4()

        with patch.object(H, "descendant_company_ids", return_value=[own]), \
             patch.object(H, "ancestor_company_ids", return_value=[own]):
            ids = H.catalog_company_ids(_Db(), _user(UserRole.COMPANY_MANAGER, company_id=own))

        assert ids == [own]


class TestThePredicateTheRoutersActuallyApply:
    """
    The half that escaped the first pass.

    Removing the `company_id IS NULL` term — which *is* the original bug — passed every
    test above, because those cover the id list and nothing covered the predicate built
    from it. These compile the real clause and read it.
    """

    def _sql(self, user, db=None):
        from sqlalchemy.dialects import postgresql

        from app.models.product import Product

        clause = H.catalog_visibility_filter(db or _Db(), user, Product)
        if clause is None:
            return None
        return str(clause.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))

    def test_a_global_row_is_always_included(self):
        """Without this term every tenant-wide product is invisible to the merchant."""
        own = uuid.uuid4()

        with patch.object(H, "descendant_company_ids", return_value=[own]), \
             patch.object(H, "ancestor_company_ids", return_value=[]):
            sql = self._sql(_user(UserRole.COMPANY_MANAGER, company_id=own))

        assert "IS NULL" in sql
        assert "IN" in sql

    def test_a_tenant_level_role_gets_no_predicate_at_all(self):
        assert self._sql(_user(UserRole.SUPER_ADMIN)) is None

    def test_a_user_with_nothing_of_their_own_sees_globals_only(self):
        """
        Globals only — never everything. Returning no predicate here would show one
        tenant's whole catalog to a user with no company at all.
        """
        sql = self._sql(_user(UserRole.CASHIER))

        assert "IS NULL" in sql
        assert " IN " not in sql

    def test_products_and_categories_get_the_same_shape(self):
        """
        They must agree: a product visible under a category that is not would render
        grouped beneath nothing.
        """
        from app.models.category import Category
        from app.models.product import Product

        u = _user(UserRole.CASHIER)
        p = H.catalog_visibility_filter(_Db(), u, Product)
        c = H.catalog_visibility_filter(_Db(), u, Category)

        assert type(p) is type(c)
        assert str(p).replace("products", "X") == str(c).replace("categories", "X")
