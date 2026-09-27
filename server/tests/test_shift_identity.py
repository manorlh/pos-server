"""
Which shift a document lands in.

The rule is "by the shift's own id, never by adoption". Two bugs are pinned:

* the old `(machine_id, day_date)` key, under which an evening shift resolved to the
  morning's closed day and its Z came back a duplicate the till read as success;
* the "adopt the open day" fallback, under which the documents of shift N+1 — sent
  after an offline close of shift N that had not reached the cloud yet — silently
  landed in shift N. The outbox is ordered open(N) → documents(N) → close(N) →
  open(N+1) → documents(N+1); a document naming an unknown shift while another shift
  of the till is open means close(N) is still in flight, and the answer is a retryable
  conflict with nothing written.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.models.shift import Shift, ShiftStatus
from app.services.shifts import (
    ShiftConflict,
    precheck_document_shifts,
    resolve_shift_for_document,
)
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _resolve(w, till, shift_id, business_date=TODAY):
    return resolve_shift_for_document(
        w.db, till, shift_id=shift_id, business_date=business_date, opened_at=NOW
    )


class TestResolution:
    def test_a_known_id_is_returned_and_nothing_is_created(self, w):
        till = w.tills[0]
        existing = w.shift(till, 1, status=ShiftStatus.OPEN)

        got = _resolve(w, till, existing.id)

        assert got.id == existing.id
        assert w.db.query(Shift).count() == 1

    def test_a_known_closed_shift_is_still_the_documents_shift(self, w):
        """A late re-push of a closed shift's document stays in that shift."""
        till = w.tills[0]
        closed = w.shift(till, 1)

        assert _resolve(w, till, closed.id).id == closed.id

    def test_an_unknown_id_with_nothing_open_creates_that_exact_shift_open(self, w):
        """The sale beat the open event to the cloud."""
        till = w.tills[0]
        wanted = uuid.uuid4()

        got = _resolve(w, till, wanted)

        assert got.id == wanted
        assert got.status == ShiftStatus.OPEN
        assert got.business_date == TODAY

    def test_a_second_shift_on_the_same_date_does_not_resolve_to_the_first(self, w):
        """The original bug, as behaviour: same date, its own id, its own shift."""
        till = w.tills[0]
        morning = w.shift(till, 1)
        evening_id = uuid.uuid4()

        got = _resolve(w, till, evening_id, business_date=morning.business_date)

        assert got.id == evening_id
        assert got.id != morning.id

    def test_an_unknown_id_while_another_shift_is_open_is_a_conflict_not_adoption(self, w):
        """
        The bug the adopt fallback caused. Shift N is still open on the cloud because its
        close is queued; the till has already opened N+1 and is selling into it.
        """
        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        n_plus_1 = uuid.uuid4()

        with pytest.raises(ShiftConflict) as e:
            _resolve(w, till, n_plus_1)

        assert e.value.open_shift_id == n.id
        assert e.value.unknown_shift_ids == [n_plus_1]
        assert w.db.query(Shift).filter(Shift.id == n_plus_1).first() is None

    def test_another_tills_open_shift_does_not_block_this_till(self, w):
        w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
        wanted = uuid.uuid4()

        assert _resolve(w, w.tills[0], wanted).id == wanted

    def test_a_document_with_no_shift_id_joins_the_open_shift(self, w):
        """Legacy payloads only. Never a phantom shift beside the real one."""
        till = w.tills[0]
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        assert _resolve(w, till, None).id == open_shift.id

    def test_a_document_with_no_shift_id_and_nothing_open_still_gets_one(self, w):
        got = _resolve(w, w.tills[0], None)

        assert got.status == ShiftStatus.OPEN


class TestTheBatchIsCheckedBeforeAnythingIsWritten:
    def test_known_shifts_pass(self, w):
        till = w.tills[0]
        s = w.shift(till, 1, status=ShiftStatus.OPEN)

        precheck_document_shifts(w.db, till, [s.id, s.id, None])

    def test_one_unknown_shift_with_nothing_open_passes(self, w):
        precheck_document_shifts(w.db, w.tills[0], [uuid.uuid4()])

    def test_an_unknown_shift_while_another_is_open_refuses_the_batch(self, w):
        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        stranger = uuid.uuid4()

        with pytest.raises(ShiftConflict) as e:
            precheck_document_shifts(w.db, till, [n.id, stranger])

        assert e.value.body() == {
            "detail": "another_shift_open",
            "openShiftId": str(n.id),
            "unknownShiftIds": [str(stranger)],
        }

    def test_two_unknown_shifts_in_one_batch_are_refused(self, w):
        """Only one of them could be opened, and which one is not a guess to make."""
        with pytest.raises(ShiftConflict) as e:
            precheck_document_shifts(w.db, w.tills[0], [uuid.uuid4(), uuid.uuid4()])

        assert e.value.open_shift_id is None


class TestTheUpsertRaisesTheConflictRatherThanRejectingDocuments:
    def test_the_conflict_escapes_the_per_document_savepoint(self, w, monkeypatch):
        """
        A per-document `rejected` is terminal on the till — it marks the row failed and
        stops retrying. A shift conflict is retryable, so it must reach the router as a
        conflict for the whole batch, not be swallowed as one bad document.
        """
        from unittest.mock import MagicMock

        import app.services.transactions as T

        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = MagicMock()
        doc.id = uuid.uuid4()
        doc.shift_id = uuid.uuid4()

        with pytest.raises(ShiftConflict):
            T.upsert_transactions(w.db, till, [doc])


class TestTheRouterAnswers409:
    def test_post_transactions_returns_409_with_the_open_shift(self, w):
        from unittest.mock import MagicMock

        from app.routers import sync as sync_router

        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        doc = MagicMock()
        doc.id = uuid.uuid4()
        doc.shift_id = uuid.uuid4()
        body = MagicMock()
        body.transactions = [doc]

        response = sync_router.post_transactions(
            machine_id=str(till.id), body=body, machine=till, db=w.db
        )

        assert response.status_code == 409
        import json

        payload = json.loads(response.body)
        assert payload["detail"] == "another_shift_open"
        assert payload["openShiftId"] == str(n.id)
