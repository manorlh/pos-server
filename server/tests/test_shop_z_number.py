"""
Per-shop Z numbering.

A Z had only a UUID, which no bookkeeper can check against the previous report. Each
shop now has a run of Z numbers, and the properties that make that run worth anything
are the ones tested here: it must be gapless and it must continue rather than restart
when the counter row is absent. That building a Z allocates exactly once (and a retried
or failed build burns nothing) is covered with the Z builder in test_z_run.py.
"""
from __future__ import annotations

import uuid
from typing import Any, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker

from app.models.shop_z_sequence import ShopZSequence
from app.services.z_sequence import allocate_shop_z_number


# ── Harness ──────────────────────────────────────────────────────────────────

class _Query:
    """Records what it was asked and returns a scripted answer."""

    def __init__(self, session: "_Db", entity: Any):
        self._session = session
        self._entity = entity
        self.locked = False

    def filter(self, *_):
        return self

    def order_by(self, *_):
        return self

    def with_for_update(self):
        self.locked = True
        self._session.locked_queries += 1
        return self

    def first(self):
        name = getattr(self._entity, "__name__", str(self._entity))
        if "ShopZSequence" in str(self._entity) or name == "ShopZSequence":
            return self._session.sequence_row
        # ZReport.shop_sequence_number scalar lookup for the continuation path
        return self._session.highest_row


class _Db:
    def __init__(self, sequence_row=None, highest_row=None):
        self.sequence_row = sequence_row
        self.highest_row = highest_row
        self.added: List[Any] = []
        self.flushes = 0
        self.locked_queries = 0

    def query(self, *entities):
        return _Query(self, entities[0])

    def add(self, obj):
        self.added.append(obj)
        if isinstance(obj, ShopZSequence):
            self.sequence_row = obj

    def flush(self):
        self.flushes += 1


# ── Allocation ───────────────────────────────────────────────────────────────

class TestAllocation:
    def test_numbers_run_consecutively_for_a_shop(self):
        shop = uuid.uuid4()
        db = _Db(sequence_row=ShopZSequence(shop_id=shop, next_value=1))

        assert [allocate_shop_z_number(db, shop) for _ in range(4)] == [1, 2, 3, 4]

    def test_the_counter_is_advanced_by_exactly_one_per_close(self):
        shop = uuid.uuid4()
        row = ShopZSequence(shop_id=shop, next_value=7)
        db = _Db(sequence_row=row)

        assert allocate_shop_z_number(db, shop) == 7
        assert row.next_value == 8

    def test_two_shops_number_independently(self):
        a, b = uuid.uuid4(), uuid.uuid4()
        db_a = _Db(sequence_row=ShopZSequence(shop_id=a, next_value=1))
        db_b = _Db(sequence_row=ShopZSequence(shop_id=b, next_value=1))

        assert allocate_shop_z_number(db_a, a) == 1
        assert allocate_shop_z_number(db_b, b) == 1

    def test_a_shopless_terminal_gets_no_number_rather_than_a_failure(self):
        """
        `shop_id` is nullable on pos_machines. An unassigned terminal must still be able
        to close its day — it is identified by the Z's id, just not by a shop number.
        """
        db = _Db()

        assert allocate_shop_z_number(db, None) is None
        assert db.added == []

    def test_the_row_is_locked_before_it_is_read(self):
        """
        Gaplessness depends on this. Two tills closing at once must serialise, or both
        read the same next_value and one number gets issued twice.
        """
        shop = uuid.uuid4()
        db = _Db(sequence_row=ShopZSequence(shop_id=shop, next_value=1))

        allocate_shop_z_number(db, shop)

        assert db.locked_queries == 1

    def test_the_lock_compiles_to_select_for_update(self):
        """The ORM call above is only as good as the SQL it produces."""
        session = sessionmaker()()
        sql = str(
            session.query(ShopZSequence)
            .filter(ShopZSequence.shop_id == uuid.uuid4())
            .with_for_update()
            .statement.compile(dialect=postgresql.dialect())
        )

        assert "FOR UPDATE" in sql


# ── Creating the counter row ─────────────────────────────────────────────────

class TestCounterCreation:
    def test_a_shop_with_no_counter_and_no_history_starts_at_one(self):
        shop = uuid.uuid4()
        db = _Db(sequence_row=None, highest_row=None)

        assert allocate_shop_z_number(db, shop) == 1
        assert isinstance(db.added[0], ShopZSequence)

    def test_a_missing_counter_continues_from_the_highest_number_already_issued(self):
        """
        The migration backfills existing Z reports and seeds the counters, but a counter
        row could also be absent after a restore that missed it. Restarting at 1 would
        reissue numbers already printed against other closes, so the highest existing
        number is read back instead.
        """
        shop = uuid.uuid4()
        db = _Db(sequence_row=None, highest_row=(12,))

        assert allocate_shop_z_number(db, shop) == 13

    def test_a_history_of_nulls_does_not_read_as_zero(self):
        """A shop whose Z reports all predate the column still starts at 1, not at 1+0."""
        shop = uuid.uuid4()
        db = _Db(sequence_row=None, highest_row=(None,))

        assert allocate_shop_z_number(db, shop) == 1
