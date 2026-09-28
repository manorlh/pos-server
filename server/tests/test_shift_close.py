"""
Opening and closing a shift from the till (docs/SHIFTS_API.md §1).

What must hold, each tested as behaviour on a real (in-memory) session:

* a close is accepted only when every document it lists is on the cloud, under this
  shift — otherwise 409 with the ids to push, the loop the till Z used;
* the X is recomputed from the documents; the till's own figures are kept and compared,
  and a disagreement is flagged, never trusted;
* an unattended close stores no count, whatever the body says;
* a retried close is a duplicate that rewrites nothing;
* closing a shift files no Z;
* the open is idempotent and refuses a second open shift with 409;
* the heartbeat carries `zReportedThroughSequence` and stores the till's open shift;
* the pre-shift endpoints answer 410 `upgrade_required`.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.shift import Shift, ShiftStatus
from app.models.transaction import TransactionStatus
from app.models.z_report import ZReport
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionIn
from app.services.shifts import last_closed_shift, z_reported_through_sequence
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _close_body(docs, **kw):
    base = {
        "closedAt": NOW.isoformat(),
        "closedByUserId": "pos-user-7",
        "closedByName": "Dana",
        "countedCash": "215.00",
        "expectedCash": "210.00",
        "transactionIds": [str(d.id) for d in docs],
    }
    base.update(kw)
    return ShiftCloseIn.model_validate(base)


def _close(w, till, shift_id, body, approval=None):
    return sync_router.post_shift_close(
        machine_id=str(till.id),
        shift_id=shift_id,
        body=body,
        machine=till,
        approval=approval,
        db=w.db,
    )


def _json(response):
    return json.loads(response.body)


# ── Accepting a close ────────────────────────────────────────────────────────


class TestTheCloseIsAcceptedOnlyWithEveryDocument:
    def test_a_missing_document_sends_the_till_back_with_its_id(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        present = w.doc(till, shift, "10.00")
        absent = uuid.uuid4()

        response = _close(w, till, shift.id, _close_body([present], transactionIds=[str(present.id), str(absent)]))

        assert response.status_code == 409
        assert _json(response) == {
            "detail": "missing_transactions",
            "missingIds": [str(absent)],
            "staleIds": [],
        }
        assert w.db.get(Shift, shift.id).status == ShiftStatus.OPEN

    def test_a_document_held_under_another_shift_is_stale(self, w):
        """Re-pushing it (it carries this shift's id) moves it; then the close goes through."""
        till = w.tills[0]
        old = w.shift(till, 1, status=ShiftStatus.OPEN)
        misplaced = w.doc(till, old, "10.00")
        old.status = ShiftStatus.CLOSED
        new = w.shift(till, 2, status=ShiftStatus.OPEN)

        response = _close(w, till, new.id, _close_body([misplaced]))

        assert response.status_code == 409
        assert _json(response)["staleIds"] == [str(misplaced.id)]

    def test_another_tills_document_counts_as_missing(self, w):
        mine, theirs = w.tills
        shift = w.shift(mine, 1, status=ShiftStatus.OPEN)
        foreign = w.doc(theirs, w.shift(theirs, 1, status=ShiftStatus.OPEN), "5.00")

        response = _close(w, mine, shift.id, _close_body([foreign]))

        assert _json(response)["missingIds"] == [str(foreign.id)]

    def test_with_every_document_present_the_shift_closes(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        docs = [w.doc(till, shift, "10.00"), w.doc(till, shift, "20.00")]

        out = _close(w, till, shift.id, _close_body(docs))

        assert out.status == "accepted"
        stored = w.db.get(Shift, shift.id)
        assert stored.status == ShiftStatus.CLOSED
        assert stored.close_accepted_at is not None
        assert stored.closed_by == "Dana"
        assert stored.closed_by_pos_user_id == "pos-user-7"

    def test_closing_a_shift_files_no_z(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = w.doc(till, shift, "10.00")

        out = _close(w, till, shift.id, _close_body([doc]))

        assert out.z_report_id is None and out.z_number is None
        assert w.db.query(ZReport).count() == 0


# ── The X is the server's ───────────────────────────────────────────────────


class TestTheXIsRecomputed:
    def _shift_with_documents(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="100.00")
        docs = [
            # 100 gross, 10 discount → 90 collected, cash
            w.doc(till, shift, "100.00", discount="10.00", vat="13.73", tip="5.00", tip_method="cash"),
            # split tender 30 cash + 70 card
            w.doc(till, shift, "100.00", legs=[("cash", "30.00"), ("card", "70.00")], vat="15.25"),
            # a credit note of 20 back in cash
            w.doc(till, shift, "20.00", credit_note=True, vat="3.05"),
            # a declined card tap: not a sale, not counted
            w.doc(till, shift, "999.00", method="card", status=TransactionStatus.CANCELLED),
        ]
        return till, shift, docs

    def test_the_figures_come_from_the_documents(self, w):
        till, shift, docs = self._shift_with_documents(w)

        out = _close(w, till, shift.id, _close_body(docs))

        t = out.server_totals
        assert t.total_sales == Decimal("190.00")
        assert t.total_refunds == Decimal("20.00")
        assert t.total_cash == Decimal("100.00")  # 90 + 30 - 20
        assert t.total_card == Decimal("70.00")
        assert t.total_tips == Decimal("5.00")
        assert t.total_cash_tips == Decimal("5.00")
        assert t.vat_total == Decimal("25.93")  # 13.73 + 15.25 - 3.05
        assert t.transactions_count == 3
        assert t.first_transaction_number == "1001"
        # The declined tap was issued a number too; the register's last number counts it.
        assert t.last_transaction_number == "1004"

    def test_a_till_that_agrees_is_not_flagged(self, w):
        """The till's totalSales is its line totals: gross, before the 10.00 discount."""
        till, shift, docs = self._shift_with_documents(w)
        till_x = {
            "totalSales": 200, "totalDiscounts": "10.00", "totalRefunds": "20.00",
            "totalCash": 100.0, "totalCard": 70, "totalTips": 5, "vatTotal": 25.93,
            "transactionsCount": 3,
        }

        out = _close(w, till, shift.id, _close_body(docs, till=till_x))

        assert out.totals_mismatch is False
        assert w.db.get(Shift, shift.id).till_totals == till_x

    def test_a_discounted_shift_is_not_flagged_for_its_discount(self, w):
        """Comparing the till's gross with the server's net would flag every discount."""
        till, shift, docs = self._shift_with_documents(w)

        out = _close(w, till, shift.id, _close_body(docs, till={"totalSales": "200.00"}))

        assert out.totals_mismatch is False

    def test_a_till_that_disagrees_is_flagged_and_kept(self, w):
        till, shift, docs = self._shift_with_documents(w)
        till_x = {"totalSales": 210, "totalCash": 100}

        out = _close(w, till, shift.id, _close_body(docs, till=till_x))

        assert out.totals_mismatch is True
        stored = w.db.get(Shift, shift.id)
        assert stored.totals_mismatch is True
        assert stored.till_totals == till_x
        # The stored X is still the server's.
        assert stored.total_sales == Decimal("190.00")

    def test_a_cent_of_rounding_is_not_a_mismatch(self, w):
        till, shift, docs = self._shift_with_documents(w)

        out = _close(w, till, shift.id, _close_body(docs, till={"totalSales": "200.01"}))

        assert out.totals_mismatch is False

    def test_vat_is_unknown_when_a_document_declared_none(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        docs = [w.doc(till, shift, "10.00", vat="1.53"), w.doc(till, shift, "10.00")]

        out = _close(w, till, shift.id, _close_body(docs))

        assert out.server_totals.vat_total is None


# ── Cash ─────────────────────────────────────────────────────────────────────


class TestCash:
    def test_the_count_and_the_variance_are_stored(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = w.doc(till, shift, "10.00")

        _close(w, till, shift.id, _close_body([doc], countedCash="205.50", expectedCash="210.00"))

        stored = w.db.get(Shift, shift.id)
        assert stored.counted_cash == Decimal("205.50")
        assert stored.expected_cash == Decimal("210.00")
        assert stored.discrepancy == Decimal("-4.50")

    def test_not_counted_is_null_not_zero(self, w):
        """The till's encoder drops nulls, so "not counted" arrives as an absent field."""
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        body = {
            "closedAt": NOW.isoformat(), "expectedCash": "210.00", "transactionIds": [],
        }

        _close(w, till, shift.id, ShiftCloseIn.model_validate(body))

        stored = w.db.get(Shift, shift.id)
        assert stored.counted_cash is None
        assert stored.discrepancy is None

    def test_an_unattended_close_stores_no_count_whatever_the_body_says(self, w):
        """An older build sent expected-as-counted; that asserted a variance of zero."""
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        _close(w, till, shift.id, _close_body([], unattended=True, countedCash="210.00"))

        stored = w.db.get(Shift, shift.id)
        assert stored.unattended is True
        assert stored.counted_cash is None
        assert stored.discrepancy is None


# ── Idempotency and unknown shifts ──────────────────────────────────────────


class TestRetriesAndUnknownShifts:
    def test_a_retried_close_is_a_duplicate_that_rewrites_nothing(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = w.doc(till, shift, "10.00")
        _close(w, till, shift.id, _close_body([doc], countedCash="200.00"))

        again = _close(w, till, shift.id, _close_body([doc], countedCash="1.00"))

        assert again.status == "duplicate"
        assert w.db.get(Shift, shift.id).counted_cash == Decimal("200.00")

    def test_an_unknown_shift_with_its_open_fields_is_created_closed(self, w):
        """Its open event was lost; the close carries enough to record it."""
        till = w.tills[0]
        w.shift(till, 2, status=ShiftStatus.OPEN)  # the till has already moved on
        lost = uuid.uuid4()

        out = _close(w, till, lost, _close_body(
            [], businessDate=str(TODAY), openedAt=(NOW - timedelta(hours=3)).isoformat(),
            sequenceNumber=1, openingCash="50.00",
        ))

        assert out.status == "accepted"
        created = w.db.get(Shift, lost)
        assert created.status == ShiftStatus.CLOSED
        assert created.sequence_number == 1
        assert created.opening_cash == Decimal("50.00")

    def test_an_unknown_shift_without_them_is_409_shift_unknown(self, w):
        with pytest.raises(HTTPException) as e:
            _close(w, w.tills[0], uuid.uuid4(), _close_body([]))

        assert e.value.status_code == 409
        assert e.value.detail == "shift_unknown"

    def test_another_tills_shift_cannot_be_closed(self, w):
        theirs = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            _close(w, w.tills[0], theirs.id, _close_body([]))

        assert e.value.status_code == 403


# ── Documents after the fact ────────────────────────────────────────────────


def _tx_in(shift_id, number="77", total="10.00"):
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed",
        "totalAmount": total, "paymentMethod": "cash", "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift_id), "businessDate": str(TODAY),
    })


class TestRepushingMovesAStaleDocument:
    def test_the_close_goes_through_after_the_repush(self, w):
        till = w.tills[0]
        old = w.shift(till, 1, status=ShiftStatus.OPEN)
        tx = _tx_in(old.id)
        upsert_transactions(w.db, till, [tx])
        old.status = ShiftStatus.CLOSED
        new = w.shift(till, 2, status=ShiftStatus.OPEN)

        body = _close_body([], transactionIds=[str(tx.id)])
        assert _close(w, till, new.id, body).status_code == 409

        tx.shift_id = new.id
        # Naive only because SQLite hands the stored timestamp back naive.
        tx.updated_at = (NOW + timedelta(seconds=1)).replace(tzinfo=None)
        assert [r.status for r in upsert_transactions(w.db, till, [tx])] == ["accepted"]

        assert _close(w, till, new.id, body).status == "accepted"

    def test_a_document_already_in_a_z_is_not_moved(self, w):
        till = w.tills[0]
        old = w.shift(till, 1, status=ShiftStatus.OPEN)
        tx = _tx_in(old.id)
        upsert_transactions(w.db, till, [tx])
        z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id,
                    business_date=TODAY, closed_at=NOW)
        w.db.add(z)
        old.status = ShiftStatus.CLOSED
        old.z_report_id = z.id
        w.db.flush()
        new = w.shift(till, 2, status=ShiftStatus.OPEN)

        tx.shift_id = new.id
        tx.updated_at = (NOW + timedelta(seconds=1)).replace(tzinfo=None)
        assert [r.status for r in upsert_transactions(w.db, till, [tx])] == ["accepted"]

        from app.models.transaction import Transaction

        assert w.db.get(Transaction, tx.id).shift_id == old.id
        # And the close of the new shift is not told to push it again forever.
        assert _close(w, till, new.id, _close_body([], transactionIds=[str(tx.id)])).status == "accepted"


# ── Opening ──────────────────────────────────────────────────────────────────


def _open(w, till, shift_id=None, **kw):
    body = {
        "id": str(shift_id or uuid.uuid4()), "businessDate": str(TODAY), "sequenceNumber": 1,
        "openedAt": NOW.isoformat(), "openingCash": "300.00",
        "openedByUserId": "pos-user-1", "openedByName": "Avi",
    }
    body.update(kw)
    return sync_router.post_shift_open(
        machine_id=str(till.id), data=ShiftOpenIn.model_validate(body), machine=till, db=w.db
    )


class TestOpening:
    def test_an_open_is_recorded_with_its_float_and_opener(self, w):
        out = _open(w, w.tills[0])

        assert out.status == "open"
        assert out.opening_cash == Decimal("300.00")
        assert out.opened_by_name == "Avi"
        assert out.opened_by_user_id == "pos-user-1"

    def test_it_is_idempotent_and_corrects_what_a_sale_inferred(self, w):
        till = w.tills[0]
        inferred = w.shift(till, None, status=ShiftStatus.OPEN, opening_cash=None)

        out = _open(w, till, inferred.id, sequenceNumber=4)

        assert out.id == inferred.id
        assert out.opening_cash == Decimal("300.00")
        assert out.sequence_number == 4
        assert w.db.query(Shift).count() == 1

    def test_a_late_open_never_reopens_a_closed_shift(self, w):
        till = w.tills[0]
        closed = w.shift(till, 1)

        out = _open(w, till, closed.id)

        assert out.status == "closed"

    def test_a_second_open_shift_is_409_with_the_open_ones_id(self, w):
        till = w.tills[0]
        first = w.shift(till, 1, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            _open(w, till)

        assert e.value.status_code == 409
        assert e.value.detail == f"another_shift_open:{first.id}"

    def test_another_tills_shift_is_403(self, w):
        theirs = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            _open(w, w.tills[0], theirs.id)

        assert e.value.status_code == 403


# ── Last closed, purge watermark, heartbeat ─────────────────────────────────


class TestTillReads:
    def test_last_closed_is_all_null_for_a_till_that_never_closed(self, w):
        out = last_closed_shift(w.db, w.tills[0].id)

        assert out.shift_id is None and out.counted_cash is None and out.reconstructed is False

    def test_last_closed_is_the_latest_close(self, w):
        till = w.tills[0]
        w.shift(till, 1, counted_cash="100.00")
        latest = w.shift(till, 2, counted_cash="150.00")

        out = last_closed_shift(w.db, till.id)

        assert out.shift_id == latest.id
        assert out.counted_cash == Decimal("150.00")

    def test_the_purge_watermark_is_the_highest_shift_in_a_z(self, w):
        till = w.tills[0]
        z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id,
                    business_date=TODAY, closed_at=NOW)
        w.db.add(z)
        for seq in (1, 2):
            w.shift(till, seq).z_report_id = z.id
        w.shift(till, 3)  # closed, not in a Z yet
        w.db.flush()

        assert z_reported_through_sequence(w.db, till.id) == 2
        assert z_reported_through_sequence(w.db, w.tills[1].id) is None

    def test_the_heartbeat_reports_the_watermark_and_stores_the_open_shift(self, w):
        from app.routers import machines as machines_router
        from app.schemas.pos_machine import MachineHeartbeatBody

        till = w.tills[0]
        claimed = uuid.uuid4()
        body = MachineHeartbeatBody.model_validate(
            {"openShiftId": str(claimed), "openShiftOpenedAt": NOW.isoformat()}
        )

        response = machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)

        assert "zReportedThroughSequence" in response
        assert response["zReportedThroughSequence"] is None
        assert "pendingCloseDay" not in response
        assert till.reported_open_shift_id == claimed

    def test_a_heartbeat_without_the_field_means_no_shift_open(self, w):
        """The till's encoder drops nulls: "no shift open" arrives as an absent field."""
        from app.routers import machines as machines_router
        from app.schemas.pos_machine import MachineHeartbeatBody

        till = w.tills[0]
        till.reported_open_shift_id = uuid.uuid4()

        machines_router.post_my_heartbeat(
            body=MachineHeartbeatBody.model_validate({"appVersion": "1"}), machine=till, db=w.db
        )

        assert till.reported_open_shift_id is None
        assert till.reported_open_shift_opened_at is None


# ── The pre-shift endpoints are gone ────────────────────────────────────────


class TestOldEndpointsAnswerUpgradeRequired:
    @pytest.mark.parametrize(
        "handler",
        [
            sync_router.post_z_report_removed,
            sync_router.post_trading_day_removed,
            sync_router.get_trading_day_removed,
            sync_router.get_last_close_removed,
            sync_router.post_close_day_ack_removed,
        ],
    )
    def test_410_upgrade_required(self, handler):
        with pytest.raises(HTTPException) as e:
            handler(machine_id="m", machine=None)

        assert e.value.status_code == 410
        assert e.value.detail == "upgrade_required"

    def test_they_are_still_mounted_so_an_old_till_hears_410_not_404(self):
        from app.main import app

        mounted = {
            (m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())
        }
        for route in [
            ("POST", "/api/v1/sync/{machine_id}/z-report"),
            ("POST", "/api/v1/sync/{machine_id}/trading-day"),
            ("GET", "/api/v1/sync/{machine_id}/trading-day/current"),
            ("GET", "/api/v1/sync/{machine_id}/last-close"),
            ("POST", "/api/v1/sync/{machine_id}/close-day/ack"),
        ]:
            assert route in mounted


# ── The machines list carries the shift and the status light ────────────────


class TestTheMachinesListing:
    def _rows(self, w):
        from unittest.mock import patch

        from app.routers import machines as machines_router

        with patch.object(machines_router, "get_catalog_change_watermark_for_machine", return_value=None):
            return {r["id"]: r for r in machines_router._enrich_machines_batch(w.tills, w.db)}

    def test_an_open_shift_and_the_awaiting_z_count_are_listed(self, w):
        busy, idle = w.tills
        open_shift = w.shift(busy, 3, status=ShiftStatus.OPEN)
        w.shift(busy, 1, business_date=TODAY - timedelta(days=1))
        w.shift(busy, 2)

        rows = self._rows(w)

        assert rows[busy.id]["shiftStatus"] == "open"
        assert rows[busy.id]["openShiftId"] == open_shift.id
        # So the list can say "משמרת #3" without fetching the shift.
        assert rows[busy.id]["openShiftSequence"] == 3
        assert rows[busy.id]["closedShiftsAwaitingZ"] == 2
        assert "closed_shifts_awaiting_z" in rows[busy.id]["statusFlags"]
        assert rows[idle.id]["shiftStatus"] == "none"
        assert rows[idle.id]["openShiftSequence"] is None
        assert rows[idle.id]["status"] == "no_open_shift"
        assert rows[idle.id]["closedShiftsAwaitingZ"] == 0

    def test_the_status_light_reaches_the_response_model(self):
        """It was computed and then dropped: the response model had no such fields."""
        from app.schemas.pos_machine import POSMachineResponse

        for name in ("status", "online", "status_flags", "pending_documents", "pending_as_of",
                     "shift_status", "open_shift_id", "open_shift_sequence",
                     "closed_shifts_awaiting_z"):
            assert name in POSMachineResponse.model_fields


class TestAStandaloneCloseOnTheListing:
    def test_it_lights_close_shift_pending(self, w):
        from unittest.mock import patch

        from app.routers import machines as machines_router
        from app.services import shift_close_requests

        busy, idle = w.tills
        # The status light reads the real clock.
        now = datetime.now(timezone.utc)
        busy.last_heartbeat_at = now
        w.shift(busy, 1, status=ShiftStatus.OPEN)
        with patch("app.services.ably_notify.publish_close_shift_notify"):
            shift_close_requests.request_close(w.db, w.admin, busy, now=now)

        with patch.object(machines_router, "get_catalog_change_watermark_for_machine", return_value=None):
            rows = {r["id"]: r for r in machines_router._enrich_machines_batch(w.tills, w.db)}

        assert rows[busy.id]["closeShiftPending"] is True
        assert rows[busy.id]["status"] == "shift_close_pending"
        assert rows[idle.id]["closeShiftPending"] is False
