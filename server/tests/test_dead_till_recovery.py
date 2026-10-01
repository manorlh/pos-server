"""
Recovering from a till that died holding an open shift.

Two capabilities, and the tests concentrate on what must *not* happen:

* a shift closed from the cloud must never look like one its till closed, never claim a
  cash count nobody took, and never be closed twice; and it files no Z — it becomes an
  ordinary candidate for the shop's next Z (covered in test_z_run.py);
* a replacement device must never adopt a till that still has an open shift, because
  it has none of that shift's records.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.services import administrative_close as AC
from app.services import pairing as P
from app.services.shift_totals import DocumentTotals

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
        # Adoption reads it (the replacement keeps the till's register number).
        pos_number="2",
        is_active=True,
        pairing_status=None,
        pending_count=0,
        # Card transmission (docs/SHIFTS_API.md §4.9): a till that never reported.
        transmission_pending_count=None,
        transmission_tracking_started_at=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _shift(**kw):
    base = dict(
        id=uuid.uuid4(),
        status=ShiftStatus.OPEN,
        business_date=NOW.date(),
        opening_cash=Decimal("200.00"),
        closed_at=None,
        expected_cash=None,
        counted_cash=Decimal("999.00"),
        discrepancy=Decimal("1.00"),
        closed_by=None,
        z_report_id=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _user():
    return SimpleNamespace(id=uuid.uuid4(), username="manager", email="m@example.com")


class _Db:
    def __init__(self):
        self.added = []
        self.flushes = 0

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        self.flushes += 1


def _totals():
    t = DocumentTotals(transactions_count=5, sales_count=5, total_sales=Decimal("300.00"))
    t.payment_breakdown = {"cash": Decimal("120.00"), "card": Decimal("180.00")}
    t.total_tips = Decimal("10.00")
    t.total_cash_tips = Decimal("10.00")
    return t


def _close(db=None, machine=None, shift=None, **kw):
    db = db or _Db()
    shift = shift or _shift()
    # The remote-close hook reads the database; this fake has none (it is tested on the
    # SQLite world in tests/test_z_run_lifecycle.py).
    with patch.object(AC, "compute_totals", return_value=_totals()), patch(
        "app.services.remote_close.on_shift_close_accepted"
    ):
        return AC.close_shift_administratively(
            db, machine or _machine(), shift, _user(), now=NOW, **kw
        )


# ── The close must say what it is ────────────────────────────────────────────

class TestTheCloseIsHonest:
    def test_it_is_marked_as_reconstructed_and_closed(self):
        shift, created = _close()

        assert created is True
        assert shift.reconstructed is True
        assert shift.status == ShiftStatus.CLOSED

    def test_no_cash_count_is_claimed(self):
        """
        Nobody opened a drawer. Setting these to the expected figure would assert a
        variance of zero that no one verified — the exact lie `unattended` exists to stop.
        """
        shift, _ = _close()

        assert shift.counted_cash is None
        assert shift.discrepancy is None

    def test_it_is_also_flagged_unattended(self):
        """So the Z's cash summary withholds its over/short without a new rule."""
        shift, _ = _close()

        assert shift.unattended is True

    def test_the_x_is_built_from_the_cloud_documents(self):
        shift, _ = _close()

        assert shift.total_sales == Decimal("300.00")
        assert shift.total_cash == Decimal("120.00")
        assert shift.total_card == Decimal("180.00")
        assert shift.transactions_count == 5
        # opening + cash takings + cash tips
        assert shift.expected_cash == Decimal("330.00")

    def test_the_person_who_authorised_it_is_named(self):
        shift, _ = _close()

        assert shift.reconstructed_by == "manager"
        assert shift.closed_by == "manager"

    def test_the_basis_records_how_complete_it_is(self):
        """
        "The cloud held N documents and the terminal reported nothing outstanding" is a
        very different statement from "...and it was holding 7 it never sent".
        """
        shift, _ = _close(machine=_machine(pending_documents=7))

        basis = shift.reconstruction_basis
        assert basis["lastReportedPendingDocuments"] == 7
        assert basis["lastHeartbeatAt"] is not None
        assert basis["documentsOnCloud"] == 5
        assert basis["forced"] is False

    def test_a_forced_close_says_so_in_the_basis(self):
        shift, _ = _close(machine=_machine(last_heartbeat_at=NOW), force=True)

        assert shift.reconstruction_basis["forced"] is True

    def test_an_operator_note_is_kept_with_the_shift(self):
        shift, _ = _close(note="terminal dropped, returned to distributor")

        assert shift.reconstruction_basis["note"] == "terminal dropped, returned to distributor"

    def test_it_files_no_z(self):
        """The Z is built later, over this shift and the shop's others."""
        shift, _ = _close()

        assert shift.z_report_id is None
        assert not hasattr(AC, "allocate_shop_z_number")


# ── Guards ───────────────────────────────────────────────────────────────────

class TestGuards:
    def test_a_live_terminal_is_refused(self):
        """A shift closed under a working till leaves the cashier selling into it."""
        with pytest.raises(HTTPException) as e:
            _close(machine=_machine(last_heartbeat_at=NOW - timedelta(seconds=10)))

        assert e.value.status_code == 409
        assert "online" in e.value.detail

    def test_a_terminal_seen_recently_is_refused_even_though_offline(self):
        """Offline for ten minutes is a network blip, not a dead terminal."""
        with pytest.raises(HTTPException) as e:
            _close(machine=_machine(last_heartbeat_at=NOW - timedelta(minutes=10)))

        assert e.value.status_code == 409
        assert "recently_seen" in e.value.detail

    def test_force_overrides_the_silence_guard(self):
        shift, created = _close(machine=_machine(last_heartbeat_at=NOW), force=True)

        assert created is True
        assert shift.reconstructed is True

    def test_a_long_dead_terminal_passes_the_guard(self):
        _shift_, created = _close(machine=_machine(last_heartbeat_at=NOW - timedelta(days=3)))

        assert created is True


# ── Idempotency ──────────────────────────────────────────────────────────────

class TestIdempotency:
    def test_a_closed_shift_is_returned_untouched(self):
        """A double click must not rewrite a close."""
        closed = _shift(status=ShiftStatus.CLOSED, counted_cash=Decimal("50.00"))
        db = _Db()

        shift, created = _close(db=db, shift=closed)

        assert created is False
        assert shift is closed
        assert shift.counted_cash == Decimal("50.00")
        assert db.flushes == 0

    def test_a_closed_shift_is_returned_even_for_a_live_terminal(self):
        """The idempotency check runs before the guards; nothing is being changed."""
        closed = _shift(status=ShiftStatus.CLOSED)
        _shift_, created = _close(shift=closed, machine=_machine(last_heartbeat_at=NOW))

        assert created is False


# ── Replacement pairing ──────────────────────────────────────────────────────

class TestAdoption:
    def _adopt(self, machine, open_shift=None):
        db = MagicMock()
        # First query resolves the machine; second the open shift.
        db.query.return_value.filter.return_value.first.side_effect = [machine, open_shift]
        return P.adopt_machine(db, machine.id, device_info={"model": "new"}, machine_name="F21")

    def test_the_replacement_keeps_the_identity(self):
        """
        Same row, so every document already filed still points at the till the shop
        knows, and its shifts and Zs do not split across two machines.
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

    def test_an_open_shift_blocks_the_adoption(self):
        """
        The replacement has none of that shift's records, and its close would list a
        fraction of the documents the shift actually holds.
        """
        m = _machine()

        with pytest.raises(P.PairingAssignmentError) as e:
            self._adopt(m, open_shift=_shift())

        assert "open shift" in str(e.value)

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


# ── The replacement code is refused at the dashboard too ─────────────────────

class TestReplacementCode:
    def test_refused_while_the_till_has_an_open_shift(self, monkeypatch):
        from shift_world import accept_str_uuids, make_world

        from app.routers import machines as machines_router

        accept_str_uuids(monkeypatch)
        w = make_world()
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        issued = []
        monkeypatch.setattr(machines_router, "create_pairing_code", lambda *a, **k: issued.append(a))

        with pytest.raises(HTTPException) as e:
            machines_router.create_replacement_pairing_code(
                till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
            )

        assert e.value.status_code == 409
        assert e.value.detail.startswith("open_shift")
        assert issued == []

    def test_issued_once_the_shift_is_closed(self, monkeypatch):
        from shift_world import NOW as WNOW, accept_str_uuids, make_world

        from app.routers import machines as machines_router

        accept_str_uuids(monkeypatch)
        w = make_world()
        till = w.tills[0]
        w.shift(till, 1)  # closed
        monkeypatch.setattr(
            machines_router, "create_pairing_code",
            lambda *a, **k: SimpleNamespace(code="ABCD1234", expires_at=WNOW),
        )

        out = machines_router.create_replacement_pairing_code(
            till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

        assert out["code"] == "ABCD1234"


class TestTheAdministrativeCloseEndpoint:
    def _world(self, monkeypatch):
        from shift_world import accept_str_uuids, make_world

        accept_str_uuids(monkeypatch)
        return make_world()

    def test_a_silent_tills_shift_is_closed_and_returned(self, monkeypatch):
        from app.routers import machines as machines_router
        from shift_world import NOW as WNOW

        w = self._world(monkeypatch)
        till = w.tills[0]
        till.last_heartbeat_at = WNOW - timedelta(days=2)
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.doc(till, shift, "25.00")

        out = machines_router.administrative_close_shift(
            till.id, shift.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

        assert out["created"] is True
        assert out["shift"]["status"] == "closed"
        assert out["shift"]["reconstructed"] is True
        assert out["shift"]["countedCash"] is None
        assert out["shift"]["serverTotals"]["totalSales"] == "25.00"

    def test_another_tills_shift_is_404(self, monkeypatch):
        from app.routers import machines as machines_router

        w = self._world(monkeypatch)
        theirs = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            machines_router.administrative_close_shift(
                w.tills[0].id, theirs.id, body=None, current_user=w.admin,
                active_tenant_id=w.tenant.id, db=w.db,
            )

        assert e.value.status_code == 404

    def test_the_old_reconstruct_route_is_gone(self):
        from app.routers import machines as machines_router

        with pytest.raises(HTTPException) as e:
            machines_router.reconstruct_close_removed(uuid.uuid4(), current_user=None)

        assert e.value.status_code == 410
