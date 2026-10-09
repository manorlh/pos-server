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
    """
    Which unknown shifts of a batch must wait (docs/SHIFTS_API.md §1.2c-bis). Since
    2026-10-07 nothing is refused for it: the documents naming them wait in the till's
    "documents waiting for a shift" and the rest of the batch lands.
    """

    def test_known_shifts_pass(self, w):
        till = w.tills[0]
        s = w.shift(till, 1, status=ShiftStatus.OPEN)

        assert precheck_document_shifts(w.db, till, [s.id, s.id, None]) == (set(), None)

    def test_one_unknown_shift_with_nothing_open_passes(self, w):
        assert precheck_document_shifts(w.db, w.tills[0], [uuid.uuid4()]) == (set(), None)

    def test_an_unknown_shift_while_another_is_open_waits(self, w):
        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        stranger = uuid.uuid4()

        assert precheck_document_shifts(w.db, till, [n.id, stranger]) == ({stranger}, n.id)

    def test_two_unknown_shifts_in_one_batch_both_wait(self, w):
        """Only one of them could be opened, and which one is not a guess to make."""
        a, b = uuid.uuid4(), uuid.uuid4()
        assert precheck_document_shifts(w.db, w.tills[0], [a, b]) == ({a, b}, None)


class TestAnUnknownShiftWhileAnotherIsOpenNeverBlocksTheBatch:
    def test_the_document_waits_and_the_rest_of_the_batch_lands(self, w):
        """
        Gap 3 (2026-10-07): one document naming a shift the cloud has not seen while
        another shift of the till is open used to make the whole batch a 409. Now the
        document is stored in the till's waiting bucket with the shift it named, and the
        others land in their own shift.
        """
        from app.models.transaction import Transaction
        from app.services.document_filing import WAITING_KIND, is_waiting
        from app.services.transactions import upsert_transactions

        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        stranger = uuid.uuid4()
        own, waiting = _tx_in(n.id), _tx_in(stranger)

        results = upsert_transactions(w.db, till, [own, waiting])

        assert [r.status for r in results] == ["accepted", "accepted"]
        assert any("waiting" in x for x in results[1].warnings or [])
        assert w.db.get(Transaction, own.id).shift_id == n.id
        stored = w.db.get(Transaction, waiting.id)
        bucket = w.db.get(Shift, stored.shift_id)
        assert is_waiting(bucket) and bucket.reconstruction_basis["kind"] == WAITING_KIND
        assert bucket.status == ShiftStatus.CLOSED and bucket.z_report_id is None
        assert stored.claimed_shift_id == stranger
        assert "waiting_for_shift" in [x["code"] for x in stored.ingest_notes]
        # Never created open beside the open one (that is the adoption bug in reverse).
        assert w.db.query(Shift).filter(Shift.id == stranger).first() is None

    def test_when_its_shift_arrives_the_document_moves_in(self, w):
        from app.models.transaction import Transaction
        from app.schemas.shift import ShiftOpenIn
        from app.services.shifts import apply_shift_close, report_shift_open
        from app.schemas.shift import ShiftCloseIn
        from app.services.transactions import upsert_transactions

        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN, close_now=False)
        n_plus_1 = uuid.uuid4()
        doc = _tx_in(n_plus_1, "25.00")
        upsert_transactions(w.db, till, [doc])
        bucket_id = w.db.get(Transaction, doc.id).shift_id

        # close(N) and open(N+1) arrive: the document is taken into N+1, the bucket is gone.
        apply_shift_close(w.db, till, n.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat(), "transactionIds": []}))
        report_shift_open(w.db, till, ShiftOpenIn.model_validate({
            "id": str(n_plus_1), "businessDate": str(TODAY), "sequenceNumber": 2, "openedAt": NOW.isoformat(),
        }))

        assert w.db.get(Transaction, doc.id).shift_id == n_plus_1
        assert w.db.get(Shift, bucket_id) is None
        assert "waiting_for_shift" not in [x["code"] for x in w.db.get(Transaction, doc.id).ingest_notes or []]


class TestTheRouterAnswers200:
    def test_post_transactions_accepts_the_batch_with_a_warning(self, w):
        from app.routers import sync as sync_router
        from app.schemas.transaction import TransactionsBatchEnvelope

        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        body = TransactionsBatchEnvelope(transactions=[{
            "id": str(uuid.uuid4()), "transactionNumber": "1", "shiftId": str(uuid.uuid4()),
            "totalAmount": "5.00", "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        }])

        response = sync_router.post_transactions(
            machine_id=str(till.id), body=body, machine=till, db=w.db
        )

        (result,) = response.results
        assert result.status == "accepted"
        assert any("unknown_shift_while_open" in x for x in result.warnings or [])


# ── A document that names no shift: never a phantom shift, never in no shift ──


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


class TestDocumentsWithNoShift:
    def test_no_shift_and_nothing_covering_waits_then_the_next_z_takes_it(self, w, monkeypatch):
        """
        The exact sequence that used to break: a document with no shiftId while nothing
        is open made a phantom open shift; the till's real open then got 409
        another_shift_open, and the phantom (no sequence, sorts first) blocked every Z.
        Then it became an orphan in no Z at all. Now (2026-10-07) it waits in the till's
        "documents waiting for a shift" bucket — closed, cloud-built — and the till's next
        Z takes it, in a section of its own.
        """
        from app.models.transaction import Transaction
        from app.models.z_report import ZReport
        from app.routers import sync as sync_router
        from app.routers import z_runs as zr_router
        from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
        from app.services import ably_notify
        from app.services import z_runs as ZR
        from app.services.document_filing import is_waiting
        from app.services.transactions import upsert_transactions

        monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
        till = w.tills[0]

        stray = _tx_in(transactionNumber="1")
        assert [r.status for r in upsert_transactions(w.db, till, [stray])] == ["accepted"]
        bucket = w.db.get(Shift, w.db.get(Transaction, stray.id).shift_id)
        assert is_waiting(bucket)
        assert w.db.query(Shift).filter(Shift.status == ShiftStatus.OPEN).count() == 0

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

        sale = _tx_in(shift_id, "40.00", transactionNumber="2")
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
        assert mine.orphan_documents == 0
        assert [s.id for s in mine.closed_shifts] == [bucket.id, shift_id]

        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)
        z = w.db.get(ZReport, r.z_report_id)
        assert r.status == "completed"
        assert z.total_sales == 55  # the waiting document is in the Z, once
        assert [s["shiftId"] for s in z.header["documentsAwaitingShift"]] == [str(bucket.id)]
        assert w.db.get(Shift, bucket.id).z_report_id == z.id

    def test_no_shift_is_filed_in_the_shift_covering_its_time(self, w):
        from app.models.transaction import Transaction
        from app.services.transactions import upsert_transactions

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _tx_in()
        upsert_transactions(w.db, till, [doc])

        stored = w.db.get(Transaction, doc.id)
        assert stored.shift_id == shift.id
        assert "filed_by_time" in [x["code"] for x in stored.ingest_notes]

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

        stored = w.db.get(Transaction, doc.id)
        assert stored.shift_id == shift.id
        assert stored.claimed_shift_id == shift.id  # a push naming none never wipes the claim

    def test_the_machines_list_counts_only_documents_stored_before_the_rule(self, w):
        from unittest.mock import patch

        from app.routers import machines as machines_router
        from app.services.transactions import upsert_transactions

        upsert_transactions(w.db, w.tills[0], [_tx_in(), _tx_in()])  # filed: a waiting bucket
        w.doc(w.tills[0], None, "5.00")  # an orphan stored before the rule (shift_id null)

        with patch.object(machines_router, "get_catalog_change_watermark_for_machine", return_value=None):
            rows = {r["id"]: r for r in machines_router._enrich_machines_batch(w.tills, w.db)}

        assert rows[w.tills[0].id]["orphanDocuments"] == 1
        assert rows[w.tills[1].id]["orphanDocuments"] == 0
