"""
Producing a Z in the cloud: Z runs and the Z builder (shifts-plan §4.5).

What each class pins, and the way it could look fine while doing damage:

* **Totals golden** — a Z over two tills and three shifts equals the documents, per till
  and overall, with the till's own figures ignored.
* **Contiguity (D4)** — a Z takes a till's shifts oldest first with no gaps; skipping an
  older shift, or including one whose close is not accepted, is refused.
* **Double claim** — no shift is ever in two Zs, whether two runs race or one retries.
* **Remote close** — a till's open shift is closed by instruction, and its item becomes
  ready only when the close is accepted with every document.
* **Proceed / expiry / cancel** — a stuck till can be left out without a gap for it.
* **z_scope = machine** — one till per Z when the accountant says so.
* **Numbering** — one number per Z, and a refused build burns none.

Runs on the in-memory SQLite world of tests/shift_world.py. SQLite ignores `FOR UPDATE`,
so the lock is asserted on compiled Postgres SQL rather than exercised.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.shift import Shift, ShiftStatus
from app.models.shop_z_sequence import ShopZSequence
from app.models.transaction import TransactionStatus
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunItem, ZRunItemStatus, ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import z_runs as ZR
from app.services.administrative_close import close_shift_administratively
from app.services.shifts import apply_shift_close, z_reported_through_sequence
from app.services.z_builder import ZBuildRefused, build_z, included_shifts
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(
        ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a)
    )
    return world


# ── Helpers ──────────────────────────────────────────────────────────────────


def closed_shift(w, till, seq, docs, *, opening="100.00", counted=None, business_date=TODAY, unattended=False):
    """Open a shift, issue `docs` into it, and close it through the real close path."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening, business_date=business_date)
    made = [w.doc(till, shift, **spec) for spec in docs]
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "countedCash": counted,
        "unattended": unattended,
        "transactionIds": [str(d.id) for d in made],
        "till": {"totalSales": "1.00"},  # deliberately wrong: the Z must not read it
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def sel(machine, through=None, include_open=None):
    return ZR.MachineSelection(machine_id=machine.id, through_shift_id=through, include_open_shift=include_open)


def run(w, *selections, business_date=None, tenant=None, now=NOW):
    return ZR.create_z_run(
        w.db, w.admin, tenant or w.tenant, w.shop, list(selections), business_date=business_date, now=now
    )


def z_of(w, r) -> ZReport:
    assert r.status == ZRunStatus.COMPLETED, (r.status, r.error_code, r.error_message)
    return w.db.get(ZReport, r.z_report_id)


def golden(w):
    t1, t2 = w.tills
    s1 = closed_shift(w, t1, 1, [
        dict(total="100.00", vat="15.25", number="1"),
        dict(total="50.00", discount="5.00", method="card", vat="6.86", number="2"),
        dict(total="20.00", credit_note=True, vat="3.05", number="3"),
    ], opening="100.00", counted="190.00")
    s2 = closed_shift(w, t1, 2, [
        dict(total="30.00", tip="5.00", tip_method="cash", vat="4.58", number="4"),
    ], opening="50.00", counted="80.00")
    t = closed_shift(w, t2, 1, [
        dict(total="200.00", legs=[("cash", "50.00"), ("card", "150.00")], vat="30.51", number="1"),
        dict(total="999.00", method="card", status=TransactionStatus.CANCELLED, number="2"),
    ], opening="0.00", counted=None)
    return s1, s2, t


# ── Totals golden ────────────────────────────────────────────────────────────


class TestMultiTillTotalsGolden:
    def test_the_z_equals_the_documents(self, w):
        golden(w)
        z = z_of(w, run(w, sel(w.tills[0]), sel(w.tills[1])))

        assert z.machine_id is None
        assert z.shop_id == w.shop.id
        assert (z.shift_count, z.machine_count) == (3, 2)
        assert z.total_sales == Decimal("375.00")
        assert z.total_refunds == Decimal("20.00")
        assert z.discounts_total == Decimal("5.00")
        assert z.total_cash_sales == Decimal("160.00")
        assert z.total_card_sales == Decimal("195.00")
        assert z.total_tips == Decimal("5.00") and z.total_cash_tips == Decimal("5.00")
        assert z.vat_total == Decimal("54.15")
        assert z.transactions_count == 5
        assert z.payment_breakdown == {"card": "195.00", "cash": "160.00"}
        assert z.opening_cash == Decimal("150.00")
        assert z.expected_cash == Decimal("315.00")
        # Till 2 was not counted: the Z's count and over/short are unknown, not partial.
        assert z.actual_cash is None and z.discrepancy is None

    def test_each_till_has_its_own_section(self, w):
        golden(w)
        z = z_of(w, run(w, sel(w.tills[0]), sel(w.tills[1])))

        one, two = sorted(z.per_machine, key=lambda s: s["machineName"])
        assert one["machineName"] == "Till 1" and one["posNumber"] == "1"
        assert (one["shiftCount"], one["firstShiftSequence"], one["lastShiftSequence"]) == (2, 1, 2)
        assert (one["firstDocumentNumber"], one["lastDocumentNumber"]) == ("1", "4")
        assert one["totalSales"] == "175.00" and one["totalRefunds"] == "20.00"
        assert one["discountsTotal"] == "5.00"
        assert one["totalCash"] == "110.00" and one["totalCard"] == "45.00"
        assert one["vatTotal"] == "23.64"
        assert one["creditNotesCount"] == 1 and one["salesCount"] == 3
        assert one["openingCash"] == "150.00"
        assert one["expectedCash"] == "265.00"
        assert one["countedCash"] == "270.00"
        assert one["overShort"] == "5.00"

        assert two["totalSales"] == "200.00"
        assert two["paymentBreakdown"] == {"card": "150.00", "cash": "50.00"}
        assert two["nonSaleDocumentsCount"] == 1
        # The declined tap still carries a number the register issued.
        assert (two["firstDocumentNumber"], two["lastDocumentNumber"]) == ("1", "2")
        assert two["countedCash"] is None and two["overShort"] is None
        assert two["uncountedShiftCount"] == 1

    def test_the_tills_own_figures_are_never_read(self, w):
        """`closed_shift` sends totalSales=1.00 on every close; the Z ignores it."""
        golden(w)
        z = z_of(w, run(w, sel(w.tills[0]), sel(w.tills[1])))

        assert z.total_sales == Decimal("375.00")
        assert all(s.totals_mismatch for s in w.db.query(Shift).all())

    def test_every_included_shift_points_at_the_z(self, w):
        s1, s2, t = golden(w)
        z = z_of(w, run(w, sel(w.tills[0]), sel(w.tills[1])))

        for shift in (s1, s2, t):
            assert w.db.get(Shift, shift.id).z_report_id == z.id
        assert z_reported_through_sequence(w.db, w.tills[0].id) == 2

    def test_business_date_defaults_to_the_latest_shift_and_can_be_given(self, w):
        closed_shift(w, w.tills[0], 1, [], business_date=TODAY - timedelta(days=1))
        closed_shift(w, w.tills[0], 2, [])
        assert z_of(w, run(w, sel(w.tills[0]))).business_date == TODAY

        closed_shift(w, w.tills[0], 3, [])
        chosen = date(2026, 9, 1)
        assert z_of(w, run(w, sel(w.tills[0]), business_date=chosen)).business_date == chosen

    def test_the_detail_endpoint_shows_sections_shifts_and_header(self, w):
        from app.routers import z_reports as zr_router

        golden(w)
        z = z_of(w, run(w, sel(w.tills[0]), sel(w.tills[1])))
        w.db.commit()

        out = zr_router.get_z_report(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert len(out.per_machine) == 2
        assert len(out.shifts) == 3
        assert all(s.z_number == z.shop_sequence_number for s in out.shifts)
        assert out.business.business_name == "Acme"
        assert out.business.vat_number == "515151515"
        assert out.legacy is False


# ── Contiguity (D4) ──────────────────────────────────────────────────────────


class TestContiguity:
    def test_through_a_middle_shift_takes_every_older_one_and_leaves_the_newer(self, w):
        till = w.tills[0]
        a, b, c = (closed_shift(w, till, n, []) for n in (1, 2, 3))

        z = z_of(w, run(w, sel(till, through=b.id)))

        assert {s.id for s in z.shifts} == {a.id, b.id}
        assert w.db.get(Shift, c.id).z_report_id is None

        nxt = z_of(w, run(w, sel(till)))
        assert {s.id for s in nxt.shifts} == {c.id}
        assert nxt.shop_sequence_number == z.shop_sequence_number + 1

    def test_the_order_falls_back_to_opening_time(self, w):
        till = w.tills[0]
        old = w.shift(till, None, opened_at=NOW - timedelta(days=2))
        new = w.shift(till, None, opened_at=NOW - timedelta(days=1))

        got = included_shifts(w.db, till.id, new.id)

        assert [s.id for s in got] == [old.id, new.id]

    def test_a_through_shift_that_is_not_a_candidate_is_refused(self, w):
        till = w.tills[0]
        closed_shift(w, till, 1, [])
        stranger = closed_shift(w, w.tills[1], 1, [])

        with pytest.raises(HTTPException) as e:
            run(w, sel(till, through=stranger.id))

        assert e.value.status_code == 400
        assert e.value.detail.startswith("through_shift_not_candidate")

    def test_an_open_shift_before_the_through_is_a_gap_and_refused(self, w):
        """Shift 1 is still open on the cloud (its close queued); 2 closed via lost-open."""
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        two = w.shift(till, 2)

        with pytest.raises(ZBuildRefused) as e:
            build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, two.id)])

        assert e.value.code == "open_shift_before_through"
        assert w.db.query(ZReport).count() == 0

    def test_the_candidates_offer_only_shifts_before_an_open_one(self, w):
        till = w.tills[0]
        before = closed_shift(w, till, 1, [])
        w.shift(till, 2, status=ShiftStatus.OPEN)

        cand = ZR.till_candidates(w.db, till)

        assert [s.id for s in cand.closed] == [before.id]
        assert cand.open_shift.sequence_number == 2


# ── Double claim ─────────────────────────────────────────────────────────────


class TestNoShiftIsInTwoZs:
    def test_a_second_run_for_a_till_with_a_live_run_is_refused(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        first = run(w, sel(till))

        with pytest.raises(HTTPException) as e:
            run(w, sel(till))

        assert e.value.status_code == 409
        assert e.value.detail == f"z_run_in_progress:{first.id}"

    def test_a_second_build_over_the_same_shifts_is_refused_under_the_lock(self, w):
        """Two builds that both passed their checks before either wrote: the second sees z_report_id set."""
        till = w.tills[0]
        s = closed_shift(w, till, 1, [dict(total="10.00")])
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, s.id)])

        with pytest.raises(ZBuildRefused) as e:
            build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, s.id)])

        assert e.value.code == "through_shift_unavailable"
        assert w.db.query(ZReport).count() == 1

    def test_the_shift_and_counter_reads_lock_for_update(self):
        """What the in-memory world cannot exercise, the compiled SQL shows."""
        from sqlalchemy.dialects import postgresql
        from sqlalchemy.orm import sessionmaker

        session = sessionmaker()()
        shifts = (
            session.query(Shift)
            .filter(Shift.machine_id == uuid.uuid4(), Shift.z_report_id.is_(None))
            .with_for_update()
        )
        counter = session.query(ShopZSequence).filter(ShopZSequence.shop_id == uuid.uuid4()).with_for_update()
        for q in (shifts, counter):
            assert "FOR UPDATE" in str(q.statement.compile(dialect=postgresql.dialect()))

    def test_the_builder_asks_for_the_locks(self, w, monkeypatch):
        import app.services.z_builder as B

        seen = []
        original = B.unreported_shifts

        def spy(db, machine_id, *, lock=False):
            seen.append(lock)
            return original(db, machine_id, lock=lock)

        monkeypatch.setattr(B, "unreported_shifts", spy)
        s = closed_shift(w, w.tills[0], 1, [])
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.tills[0], s.id)])

        assert seen == [True]


# ── Remote close of an open shift ────────────────────────────────────────────


def _till_closes(w, till, shift, request_id, docs=()):
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(d.id) for d in docs], "closeRequestId": str(request_id),
    })
    return sync_router.post_shift_close(
        machine_id=str(till.id), shift_id=shift.id, body=body, machine=till, approval=None, db=w.db
    )


class TestRemoteClose:
    def test_an_open_shift_is_asked_to_close_and_the_z_waits(self, w):
        till = w.tills[0]
        older = closed_shift(w, till, 1, [dict(total="10.00")])
        open_shift = w.shift(till, 2, status=ShiftStatus.OPEN)

        r = run(w, sel(till))

        item = r.items[0]
        assert r.status == ZRunStatus.WAITING
        assert item.status == ZRunItemStatus.WAITING_CLOSE
        assert item.close_shift_id == open_shift.id
        assert w.sent and w.sent[0][2] == str(item.id) and w.sent[0][3] == str(open_shift.id)
        assert w.db.get(Shift, older.id).z_report_id is None

    def test_an_offline_till_is_not_pushed_but_collects_it_on_its_heartbeat(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=3)
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        r = run(w, sel(till))

        assert w.sent == []
        handed = ZR.take_pending_close_shift(w.db, till, now=NOW)
        assert handed == {"requestId": str(r.items[0].id), "shiftId": str(open_shift.id)}

    def test_acks_move_the_item_but_never_make_it_ready(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))
        item = r.items[0]

        ZR.apply_close_shift_ack(w.db, till, request_id=item.id, phase="received")
        assert item.status == ZRunItemStatus.CLOSING

        ZR.apply_close_shift_ack(w.db, till, request_id=item.id, phase="deferred", error_code="card_in_flight")
        assert item.status == ZRunItemStatus.CLOSING
        assert item.error_code == "card_in_flight"

        ZR.apply_close_shift_ack(w.db, till, request_id=item.id, phase="completed")
        assert item.status == ZRunItemStatus.CLOSING
        assert r.status == ZRunStatus.WAITING

    def test_an_ack_from_another_till_is_404(self, w):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        item = run(w, sel(w.tills[0])).items[0]

        with pytest.raises(HTTPException) as e:
            ZR.apply_close_shift_ack(w.db, w.tills[1], request_id=item.id, phase="received")

        assert e.value.status_code == 404

    def test_the_accepted_close_makes_it_ready_and_builds_the_z(self, w):
        till = w.tills[0]
        older = closed_shift(w, till, 1, [dict(total="10.00")])
        open_shift = w.shift(till, 2, status=ShiftStatus.OPEN)
        doc = w.doc(till, open_shift, "25.00")
        r = run(w, sel(till))

        out = _till_closes(w, till, open_shift, r.items[0].id, docs=[doc])

        assert out.status == "accepted"
        assert r.status == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, r.z_report_id)
        assert {s.id for s in z.shifts} == {older.id, open_shift.id}
        assert z.total_sales == Decimal("35.00")
        # The till learns the number from its close's answer.
        assert out.z_report_id == z.id and out.z_number == z.shop_sequence_number

    def test_a_close_still_missing_documents_does_not_make_it_ready(self, w):
        till = w.tills[0]
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))
        body = ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "transactionIds": [str(uuid.uuid4())],
            "closeRequestId": str(r.items[0].id),
        })

        response = sync_router.post_shift_close(
            machine_id=str(till.id), shift_id=open_shift.id, body=body, machine=till, approval=None, db=w.db
        )

        assert response.status_code == 409
        assert r.items[0].status == ZRunItemStatus.WAITING_CLOSE
        assert r.status == ZRunStatus.WAITING

    def test_a_shift_the_cloud_had_not_seen_is_matched_by_the_request_id(self, w):
        """The till reported it on its heartbeat; the open event was still queued."""
        till = w.tills[0]
        unseen = uuid.uuid4()
        till.reported_open_shift_id = unseen
        r = run(w, sel(till))
        assert r.items[0].close_shift_id == unseen

        body = ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "transactionIds": [], "closeRequestId": str(r.items[0].id),
            "businessDate": str(TODAY), "openedAt": (NOW - timedelta(hours=5)).isoformat(),
            "sequenceNumber": 1,
        })
        sync_router.post_shift_close(
            machine_id=str(till.id), shift_id=unseen, body=body, machine=till, approval=None, db=w.db
        )

        assert r.status == ZRunStatus.COMPLETED
        assert till.reported_open_shift_id is None

    def test_a_stale_claim_for_a_shift_already_closed_is_ignored(self, w):
        till = w.tills[0]
        done = closed_shift(w, till, 1, [])
        till.reported_open_shift_id = done.id  # the heartbeat has not caught up

        r = run(w, sel(till))

        assert r.items[0].status == ZRunItemStatus.READY
        assert r.status == ZRunStatus.COMPLETED

    def test_a_multi_till_run_waits_for_the_last_close(self, w):
        t1, t2 = w.tills
        closed_shift(w, t1, 1, [dict(total="10.00")])
        open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(t1), sel(t2))
        assert r.status == ZRunStatus.WAITING
        assert {i.machine_id: i.status for i in r.items} == {
            t1.id: ZRunItemStatus.READY, t2.id: ZRunItemStatus.WAITING_CLOSE,
        }

        _till_closes(w, t2, open_shift, next(i for i in r.items if i.machine_id == t2.id).id)

        assert r.status == ZRunStatus.COMPLETED
        assert w.db.get(ZReport, r.z_report_id).machine_count == 2

    def test_include_open_false_takes_only_the_closed_shifts(self, w):
        till = w.tills[0]
        closed = closed_shift(w, till, 1, [])
        open_shift = w.shift(till, 2, status=ShiftStatus.OPEN)

        z = z_of(w, run(w, sel(till, include_open=False)))

        assert {s.id for s in z.shifts} == {closed.id}
        assert w.db.get(Shift, open_shift.id).status == ShiftStatus.OPEN
        assert w.sent == []

    def test_a_through_shift_with_include_open_is_refused(self, w):
        till = w.tills[0]
        closed = closed_shift(w, till, 1, [])
        w.shift(till, 2, status=ShiftStatus.OPEN)

        with pytest.raises(HTTPException) as e:
            run(w, sel(till, through=closed.id, include_open=True))

        assert e.value.detail == "through_shift_with_open_shift"

    def test_the_status_light_shows_the_pending_close(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        run(w, sel(till))

        assert ZR.close_shift_pending_machine_ids(w.db, [till.id, w.tills[1].id]) == {till.id}


# ── Proceed without, expiry, cancel ──────────────────────────────────────────


class TestProceedWithout:
    def _stuck(self, w):
        t1, t2 = w.tills
        ready = closed_shift(w, t1, 1, [dict(total="10.00")])
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        stuck_old = None
        return ready, run(w, sel(t1), sel(t2))

    def test_building_without_the_stuck_till(self, w):
        ready, r = self._stuck(w)

        ZR.proceed_without(w.db, r, [w.tills[1].id])

        z = z_of(w, r)
        assert {s.id for s in z.shifts} == {ready.id}
        assert z.machine_count == 1
        stuck_item = next(i for i in r.items if i.machine_id == w.tills[1].id)
        assert stuck_item.status == ZRunItemStatus.EXCLUDED

    def test_the_left_out_till_keeps_its_shifts_for_the_next_z(self, w):
        _ready, r = self._stuck(w)
        ZR.proceed_without(w.db, r, [w.tills[1].id])

        open_shift = w.db.query(Shift).filter(Shift.machine_id == w.tills[1].id).one()
        assert open_shift.z_report_id is None
        # And the till is free for the next run.
        assert ZR.close_shift_pending_machine_ids(w.db, [w.tills[1].id]) == set()

    def test_proceeding_with_a_till_not_ready_is_refused(self, w):
        _ready, r = self._stuck(w)

        with pytest.raises(HTTPException) as e:
            ZR.proceed_without(w.db, r, [])

        assert e.value.status_code == 409
        assert e.value.detail == {"code": "items_not_ready", "machineIds": [str(w.tills[1].id)]}

    def test_excluding_everyone_is_nothing_to_report(self, w):
        _ready, r = self._stuck(w)

        with pytest.raises(HTTPException) as e:
            ZR.proceed_without(w.db, r, [m.id for m in w.tills])

        assert e.value.detail == "nothing_to_report"

    def test_a_finished_run_cannot_proceed_again(self, w):
        _ready, r = self._stuck(w)
        ZR.proceed_without(w.db, r, [w.tills[1].id])

        with pytest.raises(HTTPException) as e:
            ZR.proceed_without(w.db, r, [])

        assert e.value.detail == "run_not_waiting"


class TestExpiry:
    def test_a_waiting_till_expires_after_36h_and_can_be_left_out(self, w):
        t1, t2 = w.tills
        ready = closed_shift(w, t1, 1, [])
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(t1), sel(t2))
        later = NOW + timedelta(hours=37)
        r.expires_at = NOW + timedelta(hours=36)

        ZR.expire_overdue_runs(w.db, now=later)

        stuck = next(i for i in r.items if i.machine_id == t2.id)
        assert stuck.status == ZRunItemStatus.EXPIRED
        assert r.status == ZRunStatus.WAITING
        assert ZR.take_pending_close_shift(w.db, t2, now=later) is None

        ZR.proceed_without(w.db, r, [t2.id], now=later)
        assert {s.id for s in z_of(w, r).shifts} == {ready.id}

    def test_a_run_with_nothing_ready_expires_whole(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))
        r.expires_at = NOW

        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(seconds=1))

        assert r.status == ZRunStatus.EXPIRED
        # The till is free for a new run.
        assert run(w, sel(till)).status == ZRunStatus.WAITING

    def test_a_run_is_given_the_36h_ttl(self, w):
        w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
        r = run(w, sel(w.tills[0]))

        assert ZR.Z_RUN_TTL_HOURS == 36
        assert r.expires_at > r.created_at if r.created_at else True


class TestCancel:
    def test_cancel_frees_the_till_and_later_acks_change_nothing(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))

        ZR.cancel_run(w.db, r)

        assert r.status == ZRunStatus.CANCELLED
        assert r.items[0].status == ZRunItemStatus.EXCLUDED
        item = ZR.apply_close_shift_ack(w.db, till, request_id=r.items[0].id, phase="received")
        assert item.status == ZRunItemStatus.EXCLUDED
        assert ZR.take_pending_close_shift(w.db, till) is None

    def test_a_close_after_cancel_builds_nothing(self, w):
        till = w.tills[0]
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))
        ZR.cancel_run(w.db, r)

        assert _till_closes(w, till, open_shift, r.items[0].id).status == "accepted"
        assert w.db.query(ZReport).count() == 0


# ── Creation edges ───────────────────────────────────────────────────────────


class TestCreation:
    def test_nothing_to_report_is_409(self, w):
        with pytest.raises(HTTPException) as e:
            run(w, sel(w.tills[0]))

        assert e.value.status_code == 409 and e.value.detail == "nothing_to_report"

    def test_a_till_with_nothing_is_excluded_beside_one_with_shifts(self, w):
        closed_shift(w, w.tills[0], 1, [])

        r = run(w, sel(w.tills[0]), sel(w.tills[1]))

        idle = next(i for i in r.items if i.machine_id == w.tills[1].id)
        assert idle.status == ZRunItemStatus.EXCLUDED and idle.error_code == "nothing_to_report"
        assert z_of(w, r).machine_count == 1

    def test_a_till_of_another_shop_is_refused(self, w):
        closed_shift(w, w.other_till, 1, [])

        with pytest.raises(HTTPException) as e:
            run(w, sel(w.other_till))

        assert e.value.status_code == 400
        assert e.value.detail == f"machine_not_in_shop:{w.other_till.id}"

    def test_no_machines_is_400(self, w):
        with pytest.raises(HTTPException) as e:
            run(w)

        assert e.value.detail == "no_machines"


class TestZScopeMachine:
    def test_one_till_per_z_is_enforced(self, w):
        w.tenant.settings = {"zScope": "machine"}
        closed_shift(w, w.tills[0], 1, [])
        closed_shift(w, w.tills[1], 1, [])

        with pytest.raises(HTTPException) as e:
            run(w, sel(w.tills[0]), sel(w.tills[1]))

        assert e.value.status_code == 422 and e.value.detail == "z_scope_machine_one_till"
        assert z_of(w, run(w, sel(w.tills[0]))).machine_count == 1

    def test_the_default_is_per_shop(self, w):
        assert ZR.z_scope_of(w.tenant) == "shop"
        assert ZR.z_scope_of(SimpleNamespace(settings={"zScope": "nonsense"})) == "shop"


# ── Numbering ────────────────────────────────────────────────────────────────


class TestNumbering:
    def test_each_z_takes_the_next_shop_number(self, w):
        closed_shift(w, w.tills[0], 1, [])
        first = z_of(w, run(w, sel(w.tills[0])))
        closed_shift(w, w.tills[1], 1, [])
        second = z_of(w, run(w, sel(w.tills[1])))

        assert (first.shop_sequence_number, second.shop_sequence_number) == (1, 2)

    def test_a_refused_build_burns_no_number(self, w):
        """A hole in the run must mean a missing Z, never a failed attempt."""
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        two = w.shift(till, 2)
        r = ZRun(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id,
                 created_by_user_id=w.admin.id, status=ZRunStatus.WAITING, expires_at=NOW + timedelta(hours=1))
        w.db.add(r)
        w.db.add(ZRunItem(id=uuid.uuid4(), run_id=r.id, machine_id=till.id,
                          through_shift_id=two.id, status=ZRunItemStatus.READY))
        w.db.flush()

        assert ZR.finalise_if_ready(w.db, r) is False
        assert r.status == ZRunStatus.FAILED and r.error_code == "open_shift_before_through"
        assert w.db.query(ZReport).count() == 0

        closed_shift(w, w.tills[1], 1, [])
        assert z_of(w, run(w, sel(w.tills[1]))).shop_sequence_number == 1

    def test_reading_a_completed_run_does_not_build_again(self, w):
        closed_shift(w, w.tills[0], 1, [])
        r = run(w, sel(w.tills[0]))

        assert ZR.finalise_if_ready(w.db, r) is False
        assert w.db.query(ZReport).count() == 1


# ── A dead till's shift becomes an ordinary candidate ───────────────────────


class TestDeadTill:
    def test_an_administratively_closed_shift_is_taken_by_the_next_z(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(days=1)
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.doc(till, shift, "40.00")
        close_shift_administratively(w.db, till, shift, w.admin)

        z = z_of(w, run(w, sel(till)))

        assert z.reconstructed is True and z.unattended is True
        assert z.total_sales == Decimal("40.00")
        assert z.per_machine[0]["reconstructedShiftCount"] == 1
        assert z.actual_cash is None


# ── The router ───────────────────────────────────────────────────────────────


class TestTheRouter:
    def test_create_and_read_back(self, w):
        from app.routers import z_runs as router
        from app.schemas.z_run import ZRunCreateIn

        closed_shift(w, w.tills[0], 1, [dict(total="12.00")])
        w.db.commit()

        created = router.post_z_run(
            ZRunCreateIn.model_validate({"shopId": str(w.shop.id), "machines": [{"machineId": str(w.tills[0].id)}]}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert created["status"] == "completed" and created["zNumber"] == 1

        again = router.get_z_run(created["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert again["zReportId"] == created["zReportId"]

    def test_candidates(self, w):
        from app.routers import z_runs as router

        closed_shift(w, w.tills[0], 1, [dict(total="12.00")])
        w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
        w.db.commit()

        out = router.get_z_candidates(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        by_name = {m.machine_name: m for m in out.machines}
        assert out.z_scope == "shop"
        assert len(by_name["Till 1"].closed_shifts) == 1
        assert by_name["Till 1"].closed_shifts[0].server_totals.total_sales == Decimal("12.00")
        assert by_name["Till 2"].open_shift is not None
        assert "North 1" not in by_name


class TestTheRunIsSerialised:
    def test_finalising_and_the_accepted_close_lock_the_run_first(self, w, monkeypatch):
        """Two closes completing one run at once must not both skip, nor both build."""
        locked = []
        original = ZR.lock_run
        monkeypatch.setattr(ZR, "lock_run", lambda db, r: locked.append(r.id) or original(db, r))
        till = w.tills[0]
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        r = run(w, sel(till))
        locked.clear()

        _till_closes(w, till, open_shift, r.items[0].id)

        assert r.status == ZRunStatus.COMPLETED
        assert locked and set(locked) == {r.id}

    def test_the_run_lock_is_select_for_update(self):
        from sqlalchemy.dialects import postgresql
        from sqlalchemy.orm import sessionmaker

        q = sessionmaker()().query(ZRun).filter(ZRun.id == uuid.uuid4()).with_for_update()
        assert "FOR UPDATE" in str(q.statement.compile(dialect=postgresql.dialect()))


# ── Progress detail ──────────────────────────────────────────────────────────


class TestProgressDetail:
    def test_a_waiting_item_says_what_the_till_reported_and_the_cloud_holds(self, w):
        till = w.tills[0]
        till.pending_documents = 4
        till.pending_count_at = NOW - timedelta(minutes=2)
        open_shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.doc(till, open_shift, "10.00")
        w.doc(till, open_shift, "12.00", status=TransactionStatus.CANCELLED)

        out = ZR.run_to_out(w.db, run(w, sel(till)), now=NOW)

        item = out["items"][0]
        assert item["status"] == ZRunItemStatus.WAITING_CLOSE
        assert item["pendingDocuments"] == 4
        assert item["pendingAsOf"] == till.pending_count_at
        assert item["online"] is True
        # Every document of the shift counts, a declined tap too: the close lists them all.
        assert item["documentsOnCloud"] == 2

    def test_a_ready_item_carries_the_backlog_but_no_count(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = NOW - timedelta(hours=3)
        closed_shift(w, till, 1, [dict(total="10.00")])
        r = run(w, sel(till, include_open=False))
        # Keep the run waiting so the item is reported as ready rather than built.
        r.status = ZRunStatus.WAITING

        item = ZR.run_to_out(w.db, r, now=NOW)["items"][0]

        assert item["status"] == ZRunItemStatus.READY
        assert item["online"] is False
        assert item["pendingDocuments"] is None
        assert item["documentsOnCloud"] is None

    def test_the_router_serialises_them(self, w):
        from datetime import datetime, timezone

        from app.routers import z_runs as zr_router
        from app.schemas.z_run import ZRunOut

        till = w.tills[0]
        till.pending_documents = 1
        w.shift(till, 1, status=ShiftStatus.OPEN)
        # The router sweeps expiry on the real clock.
        r = run(w, sel(till), now=datetime.now(timezone.utc))
        w.db.commit()

        out = zr_router.get_z_run(r.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        dumped = ZRunOut.model_validate(out).model_dump(by_alias=True, mode="json")["items"][0]
        assert dumped["pendingDocuments"] == 1
        assert dumped["documentsOnCloud"] == 0
        assert "online" in dumped and "pendingAsOf" in dumped
