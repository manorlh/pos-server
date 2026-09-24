"""
Recovering from a terminal that died holding an open trading day.

Two capabilities, and the tests concentrate on what must *not* happen:

* a day closed from the cloud must never look like one a terminal issued, never claim a
  cash count nobody took, and never be filed twice for one day;
* a replacement device must never adopt a terminal that still has an open day, because
  its Z would be computed from local records it does not have.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.trading_day import TradingDayStatus
from app.services import administrative_close as AC
from app.services import pairing as P

NOW = datetime(2026, 9, 13, 20, 0, 0, tzinfo=timezone.utc)


def _machine(**kw):
    base = dict(
        id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        shop_id=uuid.uuid4(),
        last_heartbeat_at=NOW - timedelta(hours=6),
        pending_documents=0,
        pending_count_at=NOW - timedelta(hours=6),
        token_version=1,
        name="F20",
        device_info=None,
        machine_code="MACHINE-AB12",
        # The row has always had this column; the fixture now carries it because
        # adoption reads it (the replacement keeps the till's register number).
        pos_number="2",
        is_active=True,
        pairing_status=None,
        pending_count=0,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _day(**kw):
    base = dict(
        id=uuid.uuid4(),
        status=TradingDayStatus.OPEN,
        day_date=NOW.date(),
        opening_cash=Decimal("200.00"),
        closed_at=None,
        expected_cash=None,
        closed_by=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _user():
    return SimpleNamespace(id=uuid.uuid4(), username="manager", email="m@example.com")


class _Db:
    """Returns a scripted existing-Z, records what was added."""

    def __init__(self, existing_z=None):
        self.existing_z = existing_z
        self.added = []

    def query(self, *_):
        return self

    def filter(self, *_):
        return self

    def join(self, *_, **__):
        return self

    def first(self):
        return self.existing_z

    def all(self):
        return []

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        pass


def _close(db=None, machine=None, day=None, **kw):
    db = db or _Db()
    with patch.object(AC, "allocate_shop_z_number", return_value=7):
        return AC.reconstruct_z_report(
            db, machine or _machine(), day or _day(), _user(), now=NOW, **kw
        )


# ── The document must say what it is ─────────────────────────────────────────

class TestTheDocumentIsHonest:
    def test_it_is_marked_as_reconstructed(self):
        z, created = _close()

        assert created is True
        assert z.reconstructed is True

    def test_no_cash_count_is_claimed(self):
        """
        Nobody opened a drawer. Setting these to the expected figure would assert a
        variance of zero that no one verified — the exact lie `unattended` exists to stop.
        """
        z, _ = _close()

        assert z.actual_cash is None
        assert z.discrepancy is None
        assert z.closing_cash is None

    def test_it_is_also_flagged_unattended(self):
        """
        So every consumer that already withholds a variance for an uncounted close — the
        day summary among them — does so here too, without being taught a new rule.
        """
        z, _ = _close()

        assert z.unattended is True

    def test_the_person_who_authorised_it_is_named(self):
        z, _ = _close()

        assert z.reconstructed_by == "manager"

    def test_the_basis_records_how_complete_it_is(self):
        """
        "The cloud held N documents and the terminal reported nothing outstanding" is a
        very different statement from "...and it was holding 7 it never sent". A reader
        judging whether to trust the figure needs to be able to tell them apart.
        """
        machine = _machine(pending_documents=7)
        z, _ = _close(machine=machine)

        assert z.reconstruction_basis["lastReportedPendingDocuments"] == 7
        assert z.reconstruction_basis["lastHeartbeatAt"] is not None
        assert z.reconstruction_basis["documentsOnCloud"] == 0
        assert z.reconstruction_basis["forced"] is False

    def test_a_forced_close_says_so_in_the_basis(self):
        z, _ = _close(machine=_machine(last_heartbeat_at=NOW), force=True)

        assert z.reconstruction_basis["forced"] is True

    def test_an_operator_note_is_kept_with_the_document(self):
        z, _ = _close(note="terminal dropped, returned to distributor")

        assert z.reconstruction_basis["note"] == "terminal dropped, returned to distributor"

    def test_it_takes_a_shop_z_number_like_any_other_close(self):
        """It is a real close in the shop's run; a gap there would mean a missing Z."""
        z, _ = _close()

        assert z.shop_sequence_number == 7


# ── Guards ───────────────────────────────────────────────────────────────────

class TestGuards:
    def test_a_live_terminal_is_refused(self):
        """
        Closing the day under a working till would leave the cashier selling into a day
        the cloud believes has ended.
        """
        with pytest.raises(HTTPException) as e:
            _close(machine=_machine(last_heartbeat_at=NOW - timedelta(seconds=10)))

        assert e.value.status_code == 409
        assert "online" in e.value.detail

    def test_a_terminal_seen_recently_is_refused_even_though_offline(self):
        """Offline for four minutes is a network blip, not a dead terminal."""
        with pytest.raises(HTTPException) as e:
            _close(machine=_machine(last_heartbeat_at=NOW - timedelta(minutes=4)))

        assert e.value.status_code == 409
        assert "recently_seen" in e.value.detail

    def test_force_overrides_the_silence_guard(self):
        z, created = _close(machine=_machine(last_heartbeat_at=NOW), force=True)

        assert created is True
        assert z.reconstructed is True

    def test_a_day_that_is_not_open_is_refused(self):
        with pytest.raises(HTTPException) as e:
            _close(day=_day(status=TradingDayStatus.CLOSED))

        assert e.value.status_code == 409

    def test_a_long_dead_terminal_passes_the_guard(self):
        _z, created = _close(machine=_machine(last_heartbeat_at=NOW - timedelta(days=3)))

        assert created is True


# ── Idempotency ──────────────────────────────────────────────────────────────

class TestIdempotency:
    def test_a_day_that_already_has_a_z_is_returned_untouched(self):
        """
        A double-click must not file two fiscal documents for one day, nor burn a second
        shop Z number.
        """
        already = SimpleNamespace(id=uuid.uuid4(), shop_sequence_number=3)
        db = _Db(existing_z=already)

        z, created = _close(db=db)

        assert created is False
        assert z is already
        assert db.added == []

    def test_an_existing_z_is_returned_even_for_a_live_terminal(self):
        """The idempotency check runs before the guards; nothing is being changed."""
        already = SimpleNamespace(id=uuid.uuid4())
        z, created = _close(db=_Db(existing_z=already), machine=_machine(last_heartbeat_at=NOW))

        assert created is False


# ── Replacement pairing ──────────────────────────────────────────────────────

class TestAdoption:
    def _adopt(self, machine, open_day=None):
        db = MagicMock()
        # First query resolves the machine; second the open trading day.
        db.query.return_value.filter.return_value.first.side_effect = [machine, open_day]
        return P.adopt_machine(db, machine.id, device_info={"model": "new"}, machine_name="F21")

    def test_the_replacement_keeps_the_identity(self):
        """
        Same row, so every document already filed still points at the till the shop
        knows, and the day's reporting does not split across two machines.
        """
        m = _machine()
        original_id, original_code = m.id, m.machine_code

        adopted = self._adopt(m)

        assert adopted.id == original_id
        assert adopted.machine_code == original_code

    def test_the_dead_units_tokens_are_revoked(self):
        """
        Machine tokens do not expire, so this is the revocation. A terminal that was lost
        rather than broken is a terminal in someone else's hands.
        """
        m = _machine(token_version=4)

        adopted = self._adopt(m)

        assert adopted.token_version == 5

    def test_the_dead_units_backlog_is_not_inherited(self):
        """Otherwise the new terminal shows as holding sales it has never seen."""
        m = _machine(pending_documents=7, pending_count=9)

        adopted = self._adopt(m)

        assert adopted.pending_documents is None
        assert adopted.pending_count is None
        assert adopted.pending_count_at is None

    def test_an_open_day_blocks_the_adoption(self):
        """
        The replacement has none of that day's records, and its Z — built from its own
        local rows — would declare a fraction of what the shop actually took.
        """
        m = _machine()

        with pytest.raises(P.PairingAssignmentError) as e:
            self._adopt(m, open_day=_day())

        assert "open trading day" in str(e.value)

    def test_the_hardware_details_are_refreshed(self):
        """The unit genuinely changed; keeping the old serial would misidentify it."""
        m = _machine()

        adopted = self._adopt(m)

        assert adopted.device_info == {"model": "new"}
        assert adopted.name == "F21"

    def test_an_unknown_machine_is_not_adopted(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None

        assert P.adopt_machine(db, uuid.uuid4()) is None
