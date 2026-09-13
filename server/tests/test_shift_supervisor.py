"""
The shift supervisor role (אחמ"ש).

A senior cashier: may authorise a refund, a discount, or closing the day at the register,
and may administer nothing from a desk. The tests below mostly assert what it *cannot* do,
because that is the half a widening change breaks silently — a role that gains a right it
should not have still passes every test that only checks the rights it should.
"""
from __future__ import annotations

import pytest

from app.models.user import UserRole
from app.routers.users import CREATABLE_ROLES, ROLE_LEVEL, USER_READ_ROLES
from app.services.permission_matrix import (
    SHOP_SCOPED_ROLES,
    Action,
    Resource,
    may,
)
from app.services.permissions import (
    PER_ACTION_SCOPES,
    Scope,
    parse_scopes,
    requires_per_action_reauth,
    till_grantable_scopes,
)

SUP = UserRole.SHIFT_SUPERVISOR


class TestWhatItMayAuthoriseAtTheTill:
    def test_it_may_authorise_the_three_money_decisions(self):
        assert till_grantable_scopes(SUP) == frozenset(
            {Scope.REFUND, Scope.DISCOUNT, Scope.DAY_CLOSE}
        )

    def test_it_may_not_edit_the_catalog(self):
        """
        The line that defines the role: a supervisor covers the floor, a manager decides
        what the shop sells.
        """
        assert Scope.CATALOG_WRITE not in till_grantable_scopes(SUP)

    def test_a_cashier_may_still_authorise_nothing(self):
        assert till_grantable_scopes(UserRole.CASHIER) == frozenset()

    def test_a_shop_manager_may_authorise_everything_a_supervisor_can_and_more(self):
        manager = till_grantable_scopes(UserRole.SHOP_MANAGER)

        assert till_grantable_scopes(SUP) < manager
        assert Scope.CATALOG_WRITE in manager


class TestPerActionReauthorisation:
    def test_the_three_new_scopes_each_need_their_own_pin(self):
        """
        A session-length grant would let one PIN cover an afternoon of refunds — the
        supervisor walks away and the till keeps their authority.
        """
        for scope in (Scope.REFUND, Scope.DISCOUNT, Scope.DAY_CLOSE):
            assert requires_per_action_reauth(scope) is True

    def test_catalog_editing_is_deliberately_not_per_action(self):
        """A PIN per product is the friction the sliding window exists to avoid."""
        assert requires_per_action_reauth(Scope.CATALOG_WRITE) is False

    def test_every_money_scope_is_covered(self):
        """
        Guards the reverse mistake: adding a money scope later and forgetting to list it
        here, which would silently make it session-length.
        """
        assert PER_ACTION_SCOPES == {Scope.REFUND, Scope.DISCOUNT, Scope.DAY_CLOSE}


class TestScopeStringsAreWireContract:
    """
    A paired till sends these strings by name. Renaming one stops elevation working on
    every terminal in the field, silently, because an unknown scope is dropped rather
    than rejected.
    """

    @pytest.mark.parametrize(
        "scope,wire",
        [
            (Scope.CATALOG_WRITE, "catalog:write"),
            (Scope.REFUND, "refund"),
            (Scope.DISCOUNT, "discount"),
            (Scope.DAY_CLOSE, "day:close"),
        ],
    )
    def test_the_wire_name_is_pinned(self, scope, wire):
        assert scope.value == wire

    def test_the_till_can_request_them_by_name(self):
        assert parse_scopes(["refund", "discount", "day:close"]) == [
            Scope.REFUND,
            Scope.DISCOUNT,
            Scope.DAY_CLOSE,
        ]

    def test_an_unknown_scope_is_dropped_not_fatal(self):
        """A newer till asking for something this server lacks still gets a session."""
        assert parse_scopes(["refund", "teleport"]) == [Scope.REFUND]


class TestItAdministersNothing:
    @pytest.mark.parametrize("resource", list(Resource))
    def test_it_has_no_dashboard_write_access_at_all(self, resource):
        assert may(SUP, resource, Action.WRITE) is False

    def test_it_cannot_create_users(self):
        assert CREATABLE_ROLES[SUP] == set()

    def test_it_cannot_read_the_staff_list(self):
        assert SUP not in USER_READ_ROLES


class TestWhereItSitsInTheHierarchy:
    def test_it_outranks_a_cashier_and_is_outranked_by_a_manager(self):
        assert ROLE_LEVEL[UserRole.CASHIER] < ROLE_LEVEL[SUP] < ROLE_LEVEL[UserRole.SHOP_MANAGER]

    def test_the_ranking_is_still_strictly_ordered(self):
        """A duplicated level would make two roles compare equal and break the guards."""
        levels = list(ROLE_LEVEL.values())

        assert len(levels) == len(set(levels))

    def test_a_shop_manager_may_staff_their_own_shop_with_supervisors(self):
        """Routing this through head office would leave a branch unable to cover a shift."""
        assert SUP in CREATABLE_ROLES[UserRole.SHOP_MANAGER]

    def test_everyone_above_a_shop_manager_may_create_one_too(self):
        for role in (UserRole.COMPANY_MANAGER, UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN):
            assert SUP in CREATABLE_ROLES[role], role

    def test_a_cashier_still_cannot_promote_anyone(self):
        assert CREATABLE_ROLES[UserRole.CASHIER] == set()


class TestItIsScopedToOneShop:
    def test_it_belongs_to_the_shop_scoped_set(self):
        """
        `role in (SHOP_MANAGER, CASHIER)` was written out in twelve places. A new role
        missing from that set does not raise — it falls through to whatever branch comes
        next, which is broader. This is the test that catches it.
        """
        assert SUP in SHOP_SCOPED_ROLES

    def test_the_set_is_exactly_the_three_shop_level_roles(self):
        assert SHOP_SCOPED_ROLES == {
            UserRole.SHOP_MANAGER,
            SUP,
            UserRole.CASHIER,
        }

    def test_company_level_roles_are_not_shop_scoped(self):
        for role in (UserRole.COMPANY_MANAGER, UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN):
            assert role not in SHOP_SCOPED_ROLES
