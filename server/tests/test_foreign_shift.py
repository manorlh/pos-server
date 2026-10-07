"""
A shift is one till's: another till's shift id is never used for this one.

The production case: a physical till was re-paired as a NEW machine while its local
shift was open. In the cloud that shift stays the OLD machine's (inactive, unpaired),
but the till keeps naming it — on its sales, its close, its open and its heartbeat.
Before this was checked, a sale naming it was attached to the old machine's shift, so
another till's X and a future Z would take it. Now:

* a document naming it is filed on the pushing till by rule 2 (its covering shift, else its
  "documents waiting for a shift", docs/SHIFTS_API.md §1.2c-bis) and accepted — never in no
  shift (2026-10-07); with a re-pair link it is filed under the till that issued it;
* its open and close are `403 {"detail": "shift_belongs_to_another_machine"}` — the
  close too when it lists documents, never the 409 missing-ids loop first;
* the heartbeat's claim of it is dropped, so the Z wizard shows no phantom open shift;
* nothing moves a document into, or recomputes, another till's shift;
* a document already held under another till's shift is in neither till's X or Z.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from fastapi.exception_handlers import http_exception_handler

from app.models.pos_machine import PairingStatus
from app.models.shift import Shift, ShiftStatus
from app.models.shift_close_request import ShiftCloseRequest, ShiftCloseRequestStatus
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.shift import ShiftCloseAckIn, ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionIn
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from app.services.shift_totals import compute_totals
from app.services.shifts import (
    SHIFT_BELONGS_TO_ANOTHER_MACHINE,
    orphan_documents_by_machine,
    precheck_document_shifts,
)
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    from app.services import ably_notify

    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    # tills[0] is the till re-paired as a new machine; `old` is what it was before.
    world.new = world.tills[0]
    world.old = world.tills[1]
    world.old.is_active = False
    world.old.pairing_status = PairingStatus.UNPAIRED
    world.db.flush()
    return world


def _tx_in(shift_id=None, total="10.00", **extra):
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "totalAmount": total, "paymentMethod": "cash", "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return TransactionIn.model_validate(body)


def _later(tx, minutes=1, **changes):
    """The same document, re-pushed (SQLite hands timestamps back naive)."""
    data = tx.model_dump(by_alias=True, mode="json")
    data["updatedAt"] = (NOW + timedelta(minutes=minutes)).replace(tzinfo=None).isoformat()
    data.update(changes)
    return TransactionIn.model_validate(data)


def _body_of(exc: HTTPException) -> dict:
    """The response FastAPI sends for it (the app registers no HTTPException handler)."""
    response = asyncio.run(http_exception_handler(None, exc))
    return json.loads(response.body)


def _close(w, till, shift_id, transaction_ids=()):
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "countedCash": "100.00", "expectedCash": "100.00",
        "transactionIds": [str(t) for t in transaction_ids],
        "businessDate": str(TODAY), "openedAt": NOW.isoformat(), "sequenceNumber": 7,
    })
    return sync_router.post_shift_close(
        machine_id=str(till.id), shift_id=shift_id, body=body, machine=till, approval=None, db=w.db
    )


def _open(w, till, shift_id):
    return sync_router.post_shift_open(
        machine_id=str(till.id),
        data=ShiftOpenIn.model_validate({
            "id": str(shift_id), "businessDate": str(TODAY), "sequenceNumber": 7,
            "openedAt": NOW.isoformat(), "openingCash": "100.00",
        }),
        machine=till, db=w.db,
    )


# ── Documents ────────────────────────────────────────────────────────────────


class TestADocumentNamingAnotherTillsShift:
    """
    No link between the two tills here (no shared device serial): the document is the
    pushing till's, filed by rule 2 (docs/SHIFTS_API.md §1.2c-bis) — its shift covering the
    issue time, else its "documents waiting for a shift" — never in no shift (2026-10-07).
    """

    def test_it_is_accepted_and_filed_on_the_pushing_till_never_in_no_shift(self, w):
        from app.services.document_filing import is_waiting

        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        sale = _tx_in(theirs.id, "40.00")

        results = upsert_transactions(w.db, w.new, [sale])

        assert [r.status for r in results] == ["accepted"]
        stored = w.db.get(Transaction, sale.id)
        assert stored.machine_id == w.new.id
        assert is_waiting(w.db.get(Shift, stored.shift_id))  # the new till has no shift: it waits
        assert stored.claimed_shift_id == theirs.id
        assert orphan_documents_by_machine(w.db, [w.new.id, w.old.id]) == {}
        # The old till's shift took nothing.
        assert compute_totals(w.db, [theirs.id]).transactions_count == 0

    def test_it_is_not_a_conflict_while_the_new_till_has_a_shift_open(self, w):
        """Known to the cloud, just not this till's: filed in this till's open shift, never a 409."""
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        mine = w.shift(w.new, 1, status=ShiftStatus.OPEN)

        assert precheck_document_shifts(w.db, w.new, [theirs.id]) == (set(), None)
        sale = _tx_in(theirs.id)
        assert [r.status for r in upsert_transactions(w.db, w.new, [sale])] == ["accepted"]
        stored = w.db.get(Transaction, sale.id)
        assert stored.shift_id == mine.id
        assert "filed_by_time" in [n["code"] for n in stored.ingest_notes]

    def test_a_closed_foreign_shift_is_neither_recomputed_nor_counted_late(self, w):
        theirs = w.shift(w.old, 7)
        w.doc(w.old, theirs, "25.00")
        theirs.total_sales = Decimal("25.00")
        theirs.transactions_count = 1
        w.db.flush()

        upsert_transactions(w.db, w.new, [_tx_in(theirs.id, "40.00")])

        w.db.refresh(theirs)
        assert int(theirs.late_documents or 0) == 0
        assert theirs.total_sales == Decimal("25.00")
        assert theirs.transactions_count == 1

    def test_a_repush_naming_another_tills_shift_never_moves_the_document_there(self, w):
        mine = w.shift(w.new, 1, status=ShiftStatus.OPEN)
        theirs = w.shift(w.old, 7)
        sale = _tx_in(mine.id)
        upsert_transactions(w.db, w.new, [sale])

        upsert_transactions(w.db, w.new, [_later(sale, shiftId=str(theirs.id))])

        # Named another till's shift = named none: it stays in the one it is in.
        w.db.expire_all()
        assert w.db.get(Transaction, sale.id).shift_id == mine.id
        assert compute_totals(w.db, [theirs.id]).transactions_count == 0

    def test_the_z_candidates_show_the_waiting_bucket_and_no_open_shift(self, w):
        from app.routers import z_runs as zr_router

        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        sale = _tx_in(theirs.id)
        upsert_transactions(w.db, w.new, [sale])
        w.db.commit()

        cands = zr_router.get_z_candidates(
            w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        mine = next(m for m in cands.machines if m.machine_id == w.new.id)
        assert mine.orphan_documents == 0
        assert mine.open_shift is None
        assert [s.id for s in mine.closed_shifts] == [w.db.get(Transaction, sale.id).shift_id]


class TestADocumentAnotherTillAlreadyHolds:
    def test_it_is_left_untouched_and_reported_as_a_duplicate(self, w):
        """The old machine pushed it before the re-pair; the new one must not rewrite it."""
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        mine = w.shift(w.new, 1, status=ShiftStatus.OPEN)
        sale = _tx_in(theirs.id, "25.00")
        upsert_transactions(w.db, w.old, [sale])

        results = upsert_transactions(
            w.db, w.new, [_later(sale, shiftId=str(mine.id), totalAmount="99.00")]
        )

        assert [(r.status, r.reason) for r in results] == [("duplicate", "held_by_another_machine")]
        w.db.expire_all()
        stored = w.db.get(Transaction, sale.id)
        assert (stored.machine_id, stored.shift_id) == (w.old.id, theirs.id)
        assert stored.total_amount == Decimal("25.00")
        assert compute_totals(w.db, [mine.id]).transactions_count == 0


class TestADocumentAlreadyMisfiledUnderAnotherTillsShift:
    """What the bug left behind: the new till's sale, held under the old till's shift."""

    def _misfiled(self, w):
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        w.doc(w.old, theirs, "25.00")
        stray = w.doc(w.new, theirs, "40.00")
        w.db.expire_all()  # read back as SQLite stores it (naive), like a pushed one
        return theirs, stray

    def test_it_is_in_no_x_and_shown_as_an_orphan(self, w):
        theirs, _ = self._misfiled(w)

        assert compute_totals(w.db, [theirs.id]).transactions_count == 1
        assert compute_totals(w.db, [theirs.id]).gross_sales == Decimal("25.00")
        assert orphan_documents_by_machine(w.db, [w.new.id, w.old.id]) == {w.new.id: 1}

    def test_a_repush_files_it_on_its_own_till(self, w):
        """Out of the other till's shift (no Z took it) and into this till's — here, its waiting bucket."""
        from app.services.document_filing import is_waiting

        theirs, stray = self._misfiled(w)
        tx = _tx_in(theirs.id, "40.00", id=str(stray.id), transactionNumber=stray.transaction_number)

        assert [r.status for r in upsert_transactions(w.db, w.new, [_later(tx)])] == ["accepted"]

        w.db.expire_all()  # the upsert is a Core statement
        stored = w.db.get(Transaction, stray.id)
        assert is_waiting(w.db.get(Shift, stored.shift_id))
        assert orphan_documents_by_machine(w.db, [w.new.id]) == {}

    def test_a_close_of_the_new_tills_own_shift_moves_it_home(self, w):
        theirs, stray = self._misfiled(w)
        mine = w.shift(w.new, 1, status=ShiftStatus.OPEN)

        first = _close(w, w.new, mine.id, [stray.id])
        assert first.status_code == 409
        assert json.loads(first.body)["staleIds"] == [str(stray.id)]

        tx = _tx_in(mine.id, "40.00", id=str(stray.id), transactionNumber=stray.transaction_number)
        upsert_transactions(w.db, w.new, [_later(tx)])
        closed = _close(w, w.new, mine.id, [stray.id])

        assert closed.status == "accepted"
        assert closed.server_totals.gross_sales == Decimal("40.00")


# ── Open and close ──────────────────────────────────────────────────────────


class TestOpenAndCloseOfAnotherTillsShiftAre403:
    def test_the_open(self, w):
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            _open(w, w.new, theirs.id)

        assert e.value.status_code == 403
        assert _body_of(e.value) == {"detail": "shift_belongs_to_another_machine"}

    def test_the_close_with_nothing_listed(self, w):
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            _close(w, w.new, theirs.id)

        assert e.value.status_code == 403
        assert _body_of(e.value) == {"detail": SHIFT_BELONGS_TO_ANOTHER_MACHINE}

    def test_the_close_listing_documents_is_403_not_the_missing_ids_409(self, w):
        """
        The listed documents are the old till's (missing for the new one) and the new
        till's orphans (stale): either would be a 409 the till could never clear.
        """
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        old_sale = w.doc(w.old, theirs, "25.00")
        new_sale = _tx_in(theirs.id)
        upsert_transactions(w.db, w.new, [new_sale])

        with pytest.raises(HTTPException) as e:
            _close(w, w.new, theirs.id, [old_sale.id, new_sale.id, uuid.uuid4()])

        assert e.value.status_code == 403
        assert _body_of(e.value) == {"detail": "shift_belongs_to_another_machine"}
        w.db.refresh(theirs)
        assert theirs.status == ShiftStatus.OPEN

    def test_the_close_of_a_closed_foreign_shift_is_403_not_a_duplicate(self, w):
        theirs = w.shift(w.old, 7)

        with pytest.raises(HTTPException) as e:
            _close(w, w.new, theirs.id)

        assert e.value.status_code == 403


# ── Heartbeat and the Z wizard ──────────────────────────────────────────────


def _beat(w, till, shift_id):
    body = MachineHeartbeatBody.model_validate(
        {"openShiftId": str(shift_id), "openShiftOpenedAt": NOW.isoformat()}
    )
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)


class TestTheHeartbeatDropsAnotherTillsShift:
    def test_a_foreign_open_shift_is_not_stored_as_this_tills(self, w):
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        w.new.reported_open_shift_id = theirs.id  # stored before the heartbeat checked

        _beat(w, w.new, theirs.id)

        assert w.new.reported_open_shift_id is None
        assert w.new.reported_open_shift_opened_at is None

    def test_an_unknown_or_own_shift_is_still_stored(self, w):
        unseen = uuid.uuid4()
        _beat(w, w.new, unseen)
        assert w.new.reported_open_shift_id == unseen

        mine = w.shift(w.new, 1, status=ShiftStatus.OPEN)
        _beat(w, w.new, mine.id)
        assert w.new.reported_open_shift_id == mine.id

    def test_a_stored_foreign_claim_asks_for_no_close(self, w):
        """A claim stored before the heartbeat dropped it: no run waits for a 403 forever."""
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        w.new.reported_open_shift_id = theirs.id
        w.db.flush()

        assert ZR._reported_open_is_live(w.db, w.new) is False
        with pytest.raises(HTTPException) as e:
            ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=w.new.id)], now=NOW)
        assert e.value.detail == "nothing_to_report"


class TestRemoteCloseBookkeepingIgnoresAnotherTillsShift:
    def _request(self, w, shift_id=None, status=ShiftCloseRequestStatus.WAITING_CLOSE):
        req = ShiftCloseRequest(
            id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.new.id, shop_id=w.shop.id,
            shift_id=shift_id, created_by_user_id=w.admin.id, status=status,
            expires_at=NOW + timedelta(hours=12),
        )
        w.db.add(req)
        w.db.flush()
        return req

    def test_an_ack_naming_it_does_not_pin_the_request_to_it(self, w):
        theirs = w.shift(w.old, 7, status=ShiftStatus.OPEN)
        req = self._request(w)

        sync_router.post_shift_close_ack(
            machine_id=str(w.new.id),
            body=ShiftCloseAckIn.model_validate(
                {"requestId": str(req.id), "phase": "received", "shiftId": str(theirs.id)}
            ),
            machine=w.new, db=w.db,
        )

        w.db.refresh(req)
        assert req.shift_id is None

    def test_another_tills_closed_shift_does_not_complete_the_request(self, w):
        theirs = w.shift(w.old, 7)
        req = self._request(w, shift_id=theirs.id)

        assert SCR.reconcile(w.db, req, now=NOW) is False
        assert req.status == ShiftCloseRequestStatus.WAITING_CLOSE
