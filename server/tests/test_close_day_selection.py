"""
Which tills a bulk close-day request actually targets.

"Close the Dizengoff branch" means "close what is open there". Queuing an item for every
till in the shop produced a request that reported four failures and two successes on a
six-till shop behaving perfectly, and a result screen that cries wolf is one people stop
reading.

The distinction these tests protect is between a till reached *through a shop* and one the
operator ticked *by name*. The first should not appear when it has nothing to close; the
second should, because the operator pointed at it and "no open day" is the answer they
were looking for.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.services import close_day as CD


def _machine(name):
    return SimpleNamespace(id=uuid.uuid4(), name=name)


def _filter(machines, named=None, open_ids=()):
    with patch.object(
        CD, "get_open_trading_days_for_machines",
        return_value={m.id: object() for m in machines if m.id in open_ids},
    ):
        return CD._drop_shop_machines_without_an_open_day(None, machines, named)


class TestShopSelection:
    def test_a_closed_till_is_left_out(self):
        open_till, closed_till = _machine("open"), _machine("closed")

        kept = _filter([open_till, closed_till], named=None, open_ids={open_till.id})

        assert [m.name for m in kept] == ["open"]

    def test_all_open_tills_are_kept(self):
        a, b = _machine("a"), _machine("b")

        kept = _filter([a, b], named=None, open_ids={a.id, b.id})

        assert {m.name for m in kept} == {"a", "b"}

    def test_a_shop_with_nothing_open_yields_nothing(self):
        """The caller then raises, rather than filing a request that does nothing."""
        assert _filter([_machine("a")], named=None, open_ids=set()) == []


class TestNamedTills:
    def test_a_till_ticked_by_name_is_kept_even_with_no_open_day(self):
        """
        The operator pointed at this terminal. Dropping it silently answers nothing; the
        `no_open_day` item is what tells them why it did not close.
        """
        till = _machine("named")

        kept = _filter([till], named=[till.id], open_ids=set())

        assert [m.name for m in kept] == ["named"]

    def test_naming_one_till_does_not_rescue_a_shops_closed_tills(self):
        """The two rules apply per till, not per request."""
        named, shop_closed, shop_open = _machine("named"), _machine("shopClosed"), _machine("shopOpen")

        kept = _filter(
            [named, shop_closed, shop_open], named=[named.id], open_ids={shop_open.id}
        )

        assert {m.name for m in kept} == {"named", "shopOpen"}

    def test_a_request_of_only_named_tills_is_untouched(self):
        """No shop was chosen, so there is nothing to filter and no query to make."""
        a, b = _machine("a"), _machine("b")

        kept = _filter([a, b], named=[a.id, b.id], open_ids=set())

        assert {m.name for m in kept} == {"a", "b"}


class TestTheRequestIsRefusedWhenNothingIsOpen:
    def test_a_shop_with_every_till_closed_is_a_clear_error(self):
        user = User()
        user.role = UserRole.SUPER_ADMIN

        class _Q:
            def filter(self, *_): return self
            def all(self): return [_machine("closed")]

        class _Db:
            def query(self, *_): return _Q()

        with patch.object(CD, "get_open_trading_days_for_machines", return_value={}), \
             pytest.raises(HTTPException) as e:
            CD.resolve_machines_for_close_day(
                _Db(), user, uuid.uuid4(), machine_ids=None,
                shop_id=uuid.uuid4(), shop_ids=None,
            )

        assert e.value.status_code == 400
        assert "open trading day" in e.value.detail
