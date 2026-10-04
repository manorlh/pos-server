"""
A remote close of a shift the cloud has not seen yet (review H1).

The till reports its open shift on every heartbeat, and the open event itself may still
be queued offline. A Z run or a standalone close request for that till names the
*claimed* shift — which is not in `shifts`, so writing it into a foreign key column was a
500 on Postgres. The claim now lives in `claimed_shift_id` (no key); the keyed column is
filled in when the shift lands, and matching by the request id keeps working.

The SQLite world runs with foreign keys ON (tests/shift_world.py), so a claim written into
a keyed column fails here exactly as it did on Postgres.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.shift_close_request import ShiftCloseRequestStatus as S
from app.models.z_run import ZRunItemStatus, ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionIn
from app.services import ably_notify, remote_close
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from app.services.shifts import report_shift_open
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(
        ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a)
    )
    return world


def _close_body(request_id, **extra):
    return ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "transactionIds": [], "unattended": True,
        "closeRequestId": str(request_id),
        "businessDate": str(TODAY), "openedAt": (NOW - timedelta(hours=5)).isoformat(),
        "sequenceNumber": 1, **extra,
    })


def _close(w, till, shift_id, body):
    return sync_router.post_shift_close(
        machine_id=str(till.id), shift_id=shift_id, body=body, machine=till, approval=None, db=w.db
    )


class TestAZRunForAnUnseenShift:
    def test_the_claim_is_kept_without_a_foreign_key_and_sent_to_the_till(self, w):
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen

        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)
        w.db.flush()  # would raise FOREIGN KEY constraint failed before the fix

        item = r.items[0]
        assert item.close_shift_id is None and item.claimed_shift_id == unseen
        assert ZR.take_pending_close_shift(w.db, till, now=NOW)["shiftId"] == str(unseen)
        assert ZR.run_to_out(w.db, r, now=NOW)["items"][0]["closeShiftId"] == unseen

    def test_the_open_event_landing_links_the_claim(self, w):
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)

        report_shift_open(w.db, till, ShiftOpenIn.model_validate({
            "id": str(unseen), "businessDate": str(TODAY), "openedAt": NOW.isoformat(), "sequenceNumber": 1,
        }))

        assert r.items[0].close_shift_id == unseen

    def test_a_document_creating_the_shift_links_the_claim(self, w):
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)

        upsert_transactions(w.db, till, [TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "1", "status": "completed", "documentType": 320,
            "paymentMethod": "cash", "totalAmount": "5.00", "shiftId": str(unseen),
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "items": [],
        })])

        assert r.items[0].close_shift_id == unseen

    def test_the_close_matched_by_request_id_makes_it_ready_and_builds(self, w):
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)

        out = _close(w, till, unseen, _close_body(r.items[0].id))

        assert out.status == "accepted"
        assert r.status == ZRunStatus.COMPLETED
        assert r.items[0].close_shift_id == unseen and r.items[0].through_shift_id == unseen

    def test_the_close_matched_by_the_claim_without_a_request_id(self, w):
        till = w.tills[0]
        closed_before = w.shift(till, 1)
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)

        body = ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "transactionIds": [],
            "businessDate": str(TODAY), "openedAt": (NOW - timedelta(hours=1)).isoformat(), "sequenceNumber": 2,
        })
        _close(w, till, unseen, body)

        assert r.items[0].status == ZRunItemStatus.READY
        assert r.status == ZRunStatus.COMPLETED
        assert w.db.get(Shift, closed_before.id).z_report_id == r.z_report_id

    def test_an_ack_naming_an_unseen_shift_is_kept_as_a_claim(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=NOW)
        item = r.items[0]
        item.close_shift_id = None  # as if the cloud had known of none
        acked = uuid.uuid4()

        ZR.apply_close_shift_ack(w.db, till, request_id=item.id, phase="received", shift_id=acked)
        w.db.flush()

        assert item.close_shift_id is None and item.claimed_shift_id == acked


class TestACloseRequestForAnUnseenShift:
    def test_the_request_is_created_and_completed_by_the_close(self, w):
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        till.last_heartbeat_at = NOW  # online for the real-clock check is irrelevant here

        req, created = SCR.request_close(w.db, w.admin, till, now=NOW)
        w.db.flush()
        assert created and req.shift_id is None and req.claimed_shift_id == unseen
        assert SCR.request_to_out(w.db, req, now=NOW)["shiftId"] == unseen
        assert remote_close.take_pending_close_shift(w.db, till, now=NOW)["shiftId"] == str(unseen)

        _close(w, till, unseen, _close_body(req.id))

        assert req.status == S.COMPLETED and req.shift_id == unseen

    def test_an_ack_naming_an_unseen_shift_is_kept_as_a_claim(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        req, _ = SCR.request_close(w.db, w.admin, till, now=NOW)
        req.shift_id = None
        acked = uuid.uuid4()

        SCR.apply_ack(w.db, till, request_id=req.id, phase="received", shift_id=acked, now=NOW)
        w.db.flush()

        assert req.shift_id is None and req.claimed_shift_id == acked
