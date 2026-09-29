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

    def test_a_document_with_no_shift_id_is_never_given_the_open_shift(self, w):
        """Joining the open shift would be adoption again."""
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)

        assert _resolve(w, till, None) is None

    def test_a_document_with_no_shift_id_creates_no_shift(self, w):
        """The phantom it used to create had a random id and no sequence."""
        assert _resolve(w, w.tills[0], None) is None
        assert w.db.query(Shift).count() == 0


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
        from app.routers import sync as sync_router
        from app.schemas.transaction import TransactionsBatchEnvelope

        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        body = TransactionsBatchEnvelope(transactions=[{
            "id": str(uuid.uuid4()), "transactionNumber": "1", "shiftId": str(uuid.uuid4()),
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        }])

        response = sync_router.post_transactions(
            machine_id=str(till.id), body=body, machine=till, db=w.db
        )

        assert response.status_code == 409
        import json

        payload = json.loads(response.body)
        assert payload["detail"] == "another_shift_open"
        assert payload["openShiftId"] == str(n.id)


# ── A document that names no shift is an orphan, not a phantom shift ─────────


def _tx_in(shift_id=None, total="15.00", **extra):
    from app.schemas.transaction import TransactionIn

    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "totalAmount": total, "paymentMethod": "cash", "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return TransactionIn.model_validate(body)


class TestOrphanDocuments:
    def test_orphan_then_a_real_shift_then_close_then_z(self, w, monkeypatch):
        """
        The exact sequence that used to break: a document with no shiftId while nothing
        is open made a phantom open shift; the till's real open then got 409
        another_shift_open, and the phantom (no sequence, sorts first) blocked every Z.
        """
        from app.models.transaction import Transaction
        from app.models.z_report import ZReport
        from app.routers import sync as sync_router
        from app.routers import z_runs as zr_router
        from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
        from app.services import ably_notify
        from app.services import z_runs as ZR
        from app.services.transactions import upsert_transactions

        monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
        till = w.tills[0]

        orphan = _tx_in()
        assert [r.status for r in upsert_transactions(w.db, till, [orphan])] == ["accepted"]
        assert w.db.get(Transaction, orphan.id).shift_id is None
        assert w.db.query(Shift).count() == 0

        shift_id = uuid.uuid4()
        opened = sync_router.post_shift_open(
            machine_id=str(till.id),
            data=ShiftOpenIn.model_validate({
                "id": str(shift_id), "businessDate": str(TODAY), "sequenceNumber": 1,
                "openedAt": NOW.isoformat(), "openingCash": "100.00",
            }),
            machine=till, db=w.db,
        )
        assert opened.status == "open"

        sale = _tx_in(shift_id, "40.00")
        upsert_transactions(w.db, till, [sale])
        closed = sync_router.post_shift_close(
            machine_id=str(till.id), shift_id=shift_id,
            body=ShiftCloseIn.model_validate({"closedAt": NOW.isoformat(), "transactionIds": [str(sale.id)]}),
            machine=till, approval=None, db=w.db,
        )
        assert closed.status == "accepted"
        w.db.commit()

        cands = zr_router.get_z_candidates(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        mine = next(m for m in cands.machines if m.machine_id == till.id)
        assert mine.orphan_documents == 1
        assert [s.id for s in mine.closed_shifts] == [shift_id]

        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)
        z = w.db.get(ZReport, r.z_report_id)
        assert r.status == "completed"
        assert z.total_sales == 40  # the orphan is in no shift, so in no Z
        assert w.db.get(Transaction, orphan.id).shift_id is None

    def test_a_repush_without_a_shift_id_keeps_the_document_in_its_shift(self, w):
        from app.models.transaction import Transaction
        from app.services.transactions import upsert_transactions

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _tx_in(shift.id)
        upsert_transactions(w.db, till, [doc])

        again = _tx_in(None, id=str(doc.id), transactionNumber=doc.transaction_number,
                       updatedAt=(NOW + timedelta(minutes=1)).replace(tzinfo=None).isoformat())
        upsert_transactions(w.db, till, [again])

        assert w.db.get(Transaction, doc.id).shift_id == shift.id

    def test_the_machines_list_counts_orphans(self, w):
        from unittest.mock import patch

        from app.routers import machines as machines_router
        from app.services.transactions import upsert_transactions

        upsert_transactions(w.db, w.tills[0], [_tx_in(), _tx_in()])

        with patch.object(machines_router, "get_catalog_change_watermark_for_machine", return_value=None):
            rows = {r["id"]: r for r in machines_router._enrich_machines_batch(w.tills, w.db)}

        assert rows[w.tills[0].id]["orphanDocuments"] == 2
        assert rows[w.tills[1].id]["orphanDocuments"] == 0
