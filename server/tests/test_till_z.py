"""
Z on the till — `zMode = till` (docs/SHIFTS_API.md §5).

A till in this mode asks for its own Z; the cloud builds it with the cloud Z's builder
and numbers it in the till's own run. What each class pins, and how it could look fine
while doing damage:

* **Numbering** — gapless per till from 1, independent of the shop's run, never reset; a
  retried `clientRequestId` gets the same Z, never a second number; a refusal burns none.
* **Inclusion** — oldest first, no gaps, up to `throughShiftId`; every 409/403 of §5.2.
* **Same builder** — a till Z's figures and section equal a cloud Z's over the same
  shifts: two code paths would drift, and the till's paper would disagree with the shop's.
* **Mode switching** — refused while a shift waits for a Z of the old mode, or a Z is
  under way; otherwise a shift could be stranded between the two runs.
* **The till's channel** — heartbeat `zMode` / `pendingTillZ`, `recentShiftZs` and the
  purge watermark see a till Z exactly as a cloud Z (the till deletes on them).
* **Requests** — the dashboard's ask: create, ack phases, completion only from the Z,
  nothing to report, expiry, cancel.
* **The cloud never takes such a till** — `POST /z-runs` refuses it, and so does the
  builder on every other road.
* **Consumers** — Z list/detail, day summary and the tax export with a till Z present.

Runs on the in-memory SQLite world of tests/shift_world.py. SQLite ignores `FOR UPDATE`,
so the counter lock is asserted on compiled Postgres SQL (and was exercised for real on
a throwaway Postgres when this was written, see the PR).
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from app.models.machine_z_sequence import MachineZSequence
from app.models.shift import Shift, ShiftStatus
from app.models.till_z_request import TillZRequest, TillZRequestStatus as S
from app.models.transaction import TransactionStatus
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunItem, ZRunItemStatus, ZRunStatus
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.routers import till_z_requests as tz_router
from app.routers import z_reports as zr_router
from app.routers import z_runs as z_runs_router
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.shift import ShiftCloseIn
from app.schemas.till_z import ShopTillZIn, TillZAckIn, TillZIn
from app.schemas.z_run import ZRunCreateIn
from app.services import ably_notify
from app.services import till_z as TZ
from app.services import z_runs as ZR
from app.services.shifts import (
    apply_shift_close,
    recent_shift_zs,
    z_number_of,
    z_reported_through_sequence,
)
from app.services.z_builder import ZBuildRefused, build_z
from shift_world import TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.sent = []
    world.till_z_sent = []
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a))
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: world.till_z_sent.append(a))
    # The services read the real clock (expiry, the Z's closedAt); keep the tills "just seen".
    world.now = datetime.now(timezone.utc)
    for till in world.tills + [world.other_till]:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
        till.z_mode = "cloud"
    world.till = world.tills[0]
    world.till.z_mode = "till"
    # Committed: a refusal rolls the request's transaction back, and must not take the
    # world with it.
    world.db.commit()
    return world


# ── Helpers ──────────────────────────────────────────────────────────────────


def closed_shift(w, till, seq, docs=(), *, opening="100.00", counted=None, business_date=TODAY, unattended=False):
    """Open a shift, issue `docs` into it, and close it through the real close path."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening, business_date=business_date)
    made = [w.doc(till, shift, **spec) for spec in docs]
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "countedCash": counted,
        "unattended": unattended,
        "transactionIds": [str(d.id) for d in made],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def ask(w, till=None, *, cid=None, through=None, request_id=None, till_figures=None, **extra):
    """POST /sync/{id}/till-z, as the till calls it. Returns (status, body, cid)."""
    cid = cid or uuid.uuid4()
    payload = {"clientRequestId": str(cid), **extra}
    if through is not None:
        payload["throughShiftId"] = str(through.id if hasattr(through, "id") else through)
    if request_id is not None:
        payload["tillZRequestId"] = str(request_id)
    if till_figures is not None:
        payload["till"] = till_figures
    till = till or w.till
    resp = sync_router.post_till_z(
        machine_id=str(till.id), body=TillZIn.model_validate(payload), machine=till, db=w.db
    )
    return resp.status_code, json.loads(resp.body), cid


def created(w, till=None, **kw):
    code, body, cid = ask(w, till, **kw)
    assert code == 201, body
    return body


def zs(w, till=None):
    till = till or w.till
    return (
        w.db.query(ZReport)
        .filter(ZReport.machine_id == till.id)
        .order_by(ZReport.machine_sequence_number)
        .all()
    )


def request(w, till=None, user=None):
    """POST /machines/{id}/till-z, as the dashboard calls it."""
    out = machines_router.request_till_z(
        machine_id=(till or w.till).id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db
    )
    if hasattr(out, "status_code") and hasattr(out, "body"):
        return out.status_code, json.loads(out.body)
    return 201, out


def ack(w, request_id, phase, code=None, till=None):
    body = TillZAckIn.model_validate({"requestId": str(request_id), "phase": phase, "errorCode": code})
    return sync_router.post_till_z_ack(machine_id=str((till or w.till).id), body=body, machine=till or w.till, db=w.db)


def put_mode(w, till, mode):
    return machines_router.update_machine(
        str(till.id), POSMachineUpdate.model_validate({"zMode": mode}), w.admin, w.tenant.id, w.db
    )


def beat(w, till=None):
    return machines_router.post_my_heartbeat(body=None, machine=till or w.till, db=w.db)


def cloud_run(w, till):
    return ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])


SALES = [
    dict(total="100.00", vat="15.25", number="1"),
    dict(total="50.00", discount="5.00", method="card", vat="6.86", number="2"),
    dict(total="20.00", credit_note=True, vat="3.05", number="3"),
    dict(total="30.00", tip="5.00", tip_method="cash", vat="4.58", number="4"),
    dict(total="200.00", legs=[("cash", "50.00"), ("card", "150.00")], vat="30.51", number="5"),
    dict(total="999.00", method="card", status=TransactionStatus.CANCELLED, number="6"),
]


# ── Numbering ────────────────────────────────────────────────────────────────


class TestNumbering:
    def test_the_first_till_z_is_number_1_of_its_till(self, w):
        s = closed_shift(w, w.till, 1, SALES[:2])

        body = created(w, through=s)

        z = body["zReport"]
        assert body["status"] == "created"
        assert z["origin"] == "till"
        assert z["machineSequenceNumber"] == 1
        assert z["shopSequenceNumber"] is None
        assert z["machineId"] == str(w.till.id)
        assert z["machineName"] == w.till.name
        assert body["shiftIds"] == [str(s.id)]
        assert w.db.get(Shift, s.id).z_report_id == uuid.UUID(z["id"])

    def test_numbers_are_gapless_per_till(self, w):
        for seq in (1, 2, 3):
            s = closed_shift(w, w.till, seq, [dict(total="10.00")])
            created(w, through=s)
        assert [z.machine_sequence_number for z in zs(w)] == [1, 2, 3]
        assert w.db.get(MachineZSequence, w.till.id).last_number == 3

    def test_each_till_has_its_own_run(self, w):
        other = w.tills[1]
        other.z_mode = "till"
        a = closed_shift(w, w.till, 1, [dict(total="10.00")])
        b = closed_shift(w, other, 1, [dict(total="10.00")])

        assert created(w, through=a)["zReport"]["machineSequenceNumber"] == 1
        assert created(w, other, through=b)["zReport"]["machineSequenceNumber"] == 1

    def test_the_shops_run_is_untouched(self, w):
        """A cloud Z of the other till is the shop's Z 1, whatever the till Zs did."""
        a = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=a)
        closed_shift(w, w.tills[1], 1, [dict(total="10.00")])

        run = cloud_run(w, w.tills[1])

        z = w.db.get(ZReport, run.z_report_id)
        assert (z.origin, z.shop_sequence_number, z.machine_sequence_number) == ("cloud", 1, None)

    def test_a_retry_with_the_same_client_request_id_is_the_same_z(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        first = created(w, through=s)
        cid = uuid.UUID(first["zReport"]["id"])  # not the key; the key is below
        code, again, _ = ask(w, through=s, cid=uuid.UUID(str(w.db.get(ZReport, cid).client_request_id)))

        assert code == 200
        assert again["status"] == "duplicate"
        assert again["zReport"]["id"] == first["zReport"]["id"]
        assert again["zReport"]["machineSequenceNumber"] == 1
        assert again["shiftIds"] == first["shiftIds"]
        assert len(zs(w)) == 1
        assert w.db.get(MachineZSequence, w.till.id).last_number == 1

    def test_a_retry_after_another_shift_closed_still_answers_the_first_z(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")])
        _code, first, cid = ask(w, through=s1)
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        code, again, _ = ask(w, through=s2, cid=cid)

        assert (code, again["zReport"]["id"]) == (200, first["zReport"]["id"])
        assert w.db.get(Shift, s2.id).z_report_id is None  # waits for the next Z

    def test_a_retry_after_the_till_was_switched_to_cloud_still_answers(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        _code, first, cid = ask(w, through=s)
        put_mode(w, w.till, "cloud")

        code, again, _ = ask(w, through=s, cid=cid)

        assert (code, again["status"]) == (200, "duplicate")

    def test_another_tills_client_request_id_is_a_conflict(self, w):
        other = w.tills[1]
        other.z_mode = "till"
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        o = closed_shift(w, other, 1, [dict(total="10.00")])
        _c, _b, cid = ask(w, through=s)

        code, body, _ = ask(w, other, through=o, cid=cid)

        assert (code, body) == (409, {"detail": "client_request_id_conflict"})
        assert w.db.get(Shift, o.id).z_report_id is None

    def test_a_refusal_burns_no_number(self, w):
        code, body, _ = ask(w)
        assert (code, body["detail"]) == (409, "nothing_to_report")
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])

        assert created(w, through=s)["zReport"]["machineSequenceNumber"] == 1

    def test_the_run_never_resets_across_a_mode_switch(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s1)
        put_mode(w, w.till, "cloud")
        closed_shift(w, w.till, 2, [dict(total="10.00")])
        run = cloud_run(w, w.till)
        assert w.db.get(ZReport, run.z_report_id).shop_sequence_number == 1
        put_mode(w, w.till, "till")
        s3 = closed_shift(w, w.till, 3, [dict(total="10.00")])

        assert created(w, through=s3)["zReport"]["machineSequenceNumber"] == 2

    def test_a_lost_counter_row_continues_from_the_zs_on_file(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s1)
        w.db.query(MachineZSequence).delete()
        w.db.flush()
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        assert created(w, through=s2)["zReport"]["machineSequenceNumber"] == 2

    def test_the_counter_row_is_locked_for_update(self, w, monkeypatch):
        """Concurrent requests of one till serialise on this lock (and the second reads
        the first's Z): SQLite ignores the clause, so the statement is checked as compiled."""
        from sqlalchemy.dialects import postgresql

        statements = []
        original = w.db.query

        def spy(*entities, **kw):
            q = original(*entities, **kw)
            if entities and entities[0] is MachineZSequence:
                statements.append(q)
            return q

        monkeypatch.setattr(w.db, "query", spy)
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)

        sql = [
            str(q.with_for_update().statement.compile(dialect=postgresql.dialect())) for q in statements
        ]
        assert statements and all("FOR UPDATE" in s for s in sql)

    def test_two_zs_of_one_till_cannot_share_a_number(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)
        twin = ZReport(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.till.id,
            origin="till", machine_sequence_number=1, business_date=TODAY, closed_at=w.now,
        )
        w.db.add(twin)
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()

    def test_one_client_request_id_names_one_z(self, w):
        cid = uuid.uuid4()
        for n in (1, 2):
            w.db.add(ZReport(
                id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.till.id,
                origin="till", machine_sequence_number=n, client_request_id=cid,
                business_date=TODAY, closed_at=w.now,
            ))
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()


# ── Inclusion ────────────────────────────────────────────────────────────────


class TestInclusion:
    def test_oldest_first_up_to_the_through_shift(self, w):
        s1, s2, s3 = (closed_shift(w, w.till, n, [dict(total="10.00")]) for n in (1, 2, 3))

        first = created(w, through=s2)
        second = created(w, through=s3)

        assert first["shiftIds"] == [str(s1.id), str(s2.id)]
        assert second["shiftIds"] == [str(s3.id)]
        assert first["zReport"]["shiftCount"] == 2

    def test_no_through_shift_takes_every_closed_one(self, w):
        s1, s2 = (closed_shift(w, w.till, n, [dict(total="10.00")]) for n in (1, 2))
        open_ = w.shift(w.till, 3, status=ShiftStatus.OPEN)

        body = created(w)

        assert body["shiftIds"] == [str(s1.id), str(s2.id)]
        assert w.db.get(Shift, open_.id).z_report_id is None

    def test_a_business_day_is_filed_under_its_first_shift(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")], business_date=date(2026, 9, 26))
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")], business_date=date(2026, 9, 27))

        body = created(w, through=s2)

        assert body["zReport"]["businessDate"] == "2026-09-26"
        assert body["zReport"]["periodStart"].startswith(s1.opened_at.date().isoformat())

    def test_an_open_shift_before_the_through_shift_is_refused(self, w):
        s1 = w.shift(w.till, 1, status=ShiftStatus.OPEN)
        s2 = w.shift(w.till, 2)  # closed (one open shift per till: built directly)
        w.db.commit()

        code, body, _ = ask(w, through=s2)

        assert (code, body) == (409, {"detail": "shift_not_closed", "shiftId": str(s1.id)})
        assert w.db.get(Shift, s2.id).z_report_id is None

    def test_an_open_through_shift_is_not_closed(self, w):
        s = w.shift(w.till, 1, status=ShiftStatus.OPEN)

        code, body, _ = ask(w, through=s)

        assert (code, body) == (409, {"detail": "shift_not_closed", "shiftId": str(s.id)})

    def test_an_unknown_through_shift(self, w):
        code, body, _ = ask(w, through=uuid.uuid4())
        assert (code, body) == (409, {"detail": "shift_unknown"})

    def test_another_tills_shift_is_403(self, w):
        theirs = closed_shift(w, w.tills[1], 1, [dict(total="10.00")])

        with pytest.raises(HTTPException) as exc:
            ask(w, through=theirs)

        assert (exc.value.status_code, exc.value.detail) == (403, "shift_belongs_to_another_machine")

    def test_nothing_to_report(self, w):
        assert ask(w)[:2] == (409, {"detail": "nothing_to_report"})
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)
        # The through shift is in a Z already: a new attempt has nothing to add.
        assert ask(w, through=s)[:2] == (409, {"detail": "nothing_to_report"})

    def test_a_cloud_till_cannot_ask(self, w):
        s = closed_shift(w, w.tills[1], 1, [dict(total="10.00")])

        code, body, _ = ask(w, w.tills[1], through=s)

        assert (code, body) == (409, {"detail": "till_z_disabled"})
        assert zs(w, w.tills[1]) == []

    def test_a_live_z_run_holding_the_till_refuses(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        run = ZRun(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, created_by_user_id=w.admin.id,
            status=ZRunStatus.WAITING, expires_at=w.now + timedelta(hours=36),
        )
        w.db.add(run)
        w.db.flush()
        w.db.add(ZRunItem(id=uuid.uuid4(), run_id=run.id, machine_id=w.till.id,
                          status=ZRunItemStatus.READY, through_shift_id=s.id))
        w.db.flush()

        code, body, _ = ask(w, through=s)

        assert (code, body) == (409, {"detail": f"z_run_in_progress:{run.id}"})

    def test_an_old_till_still_gets_410_on_the_removed_z_report(self, w):
        with pytest.raises(HTTPException) as exc:
            sync_router.post_z_report_removed(machine_id=str(w.till.id), machine=w.till)
        assert (exc.value.status_code, exc.value.detail) == (410, "upgrade_required")


# ── The same builder ─────────────────────────────────────────────────────────


#: Section keys that name the till rather than describe its figures.
IDENTITY_KEYS = {"machineId", "machineName", "posNumber", "machineCode", "shiftIds", "transmission"}
Z_FIGURES = (
    "total_sales", "total_refunds", "discounts_total", "total_cash_sales", "total_card_sales",
    "total_exchange", "total_tips", "total_cash_tips", "total_card_tips", "vat_total",
    "transactions_count", "payment_breakdown", "opening_cash", "expected_cash", "actual_cash",
    "discrepancy", "shift_count", "machine_count", "unattended", "reconstructed", "business_date",
)


class TestTheSameBuilderAsACloudZ:
    def test_a_till_z_equals_a_cloud_z_over_the_same_shifts(self, w):
        """Two tills with identical shifts: one produces its own Z, the other is taken
        into a cloud Z. Every figure and the whole section but the till's name agree."""
        twin = w.tills[1]
        for till in (w.till, twin):
            closed_shift(w, till, 1, SALES[:3], opening="100.00", counted="190.00")
            closed_shift(w, till, 2, SALES[3:], opening="190.00", counted="260.00")

        till_z = w.db.get(ZReport, uuid.UUID(created(w)["zReport"]["id"]))
        cloud_z = w.db.get(ZReport, cloud_run(w, twin).z_report_id)

        for column in Z_FIGURES:
            assert getattr(till_z, column) == getattr(cloud_z, column), column
        (ours,), (theirs,) = till_z.per_machine, cloud_z.per_machine
        assert {k: v for k, v in ours.items() if k not in IDENTITY_KEYS} == {
            k: v for k, v in theirs.items() if k not in IDENTITY_KEYS
        }
        assert till_z.header == {**cloud_z.header, "capturedAt": till_z.header["capturedAt"]}
        assert till_z.total_sales == Decimal("375.00")

    def test_the_response_is_the_z_detail_with_one_section(self, w):
        closed_shift(w, w.till, 1, SALES[:2], counted="145.00")

        body = created(w, createdByName="דנה", createdByUserId="pos-user-7")

        z = body["zReport"]
        assert len(z["perMachine"]) == 1
        assert z["perMachine"][0]["machineId"] == str(w.till.id)
        assert z["perMachine"][0]["posNumber"] == w.till.pos_number
        assert z["posNumber"] == w.till.pos_number
        assert z["business"]["vatNumber"] == "515151515"
        assert [s["zNumber"] for s in z["shifts"]] == [1]
        assert z["createdByName"] == "דנה"
        assert z["unattended"] is False
        assert z["legacy"] is False
        assert body["totalsMismatch"] is False
        assert "serverTime" in body
        assert w.db.get(ZReport, uuid.UUID(z["id"])).created_by_pos_user_id == "pos-user-7"

    def test_the_tills_own_figures_are_compared_never_used(self, w):
        closed_shift(w, w.till, 1, [dict(total="100.00", vat="15.25")])

        agree = created(w, till_figures={"totalSales": 100.0, "vatTotal": "15.25", "transactionsCount": 1})
        assert agree["totalsMismatch"] is False and agree["zReport"]["totalsMismatch"] is False

        closed_shift(w, w.till, 2, [dict(total="100.00", vat="15.25")])
        differ = created(w, till_figures={"totalSales": 99.0, "totalCash": float("nan")})

        assert differ["totalsMismatch"] is True
        assert differ["zReport"]["totalSales"] == "100.00"
        stored = w.db.get(ZReport, uuid.UUID(differ["zReport"]["id"]))
        assert stored.totals_mismatch is True
        assert stored.till_totals == {"totalSales": 99.0, "totalCash": "nan"}

    def test_an_unattended_z_says_so(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])

        assert created(w, unattended=True)["zReport"]["unattended"] is True

    def test_on_a_till_z_unattended_means_produced_remotely_only(self, w):
        """A cashier's Z over a shift closed remotely is not "הופק מרחוק": the shift's own
        flag stays on its section."""
        closed_shift(w, w.till, 1, [dict(total="10.00")], unattended=True)

        z = created(w, createdByName="דנה")["zReport"]

        assert z["unattended"] is False
        assert z["perMachine"][0]["unattendedShiftCount"] == 1


# ── The till's channel: heartbeat, recentShiftZs, purge watermark ────────────


class TestTheTillSeesItsZ:
    def test_recent_shift_zs_and_the_watermark_include_till_zs(self, w):
        s1, s2 = (closed_shift(w, w.till, n, [dict(total="10.00")]) for n in (1, 2))
        z1 = created(w, through=s1)["zReport"]
        z2 = created(w, through=s2)["zReport"]

        recent = recent_shift_zs(w.db, w.till.id)

        assert recent == [
            {"shiftId": str(s2.id), "zReportId": z2["id"], "zNumber": 2},
            {"shiftId": str(s1.id), "zReportId": z1["id"], "zNumber": 1},
        ]
        assert z_reported_through_sequence(w.db, w.till.id) == 2
        assert z_number_of(w.db, w.db.get(Shift, s1.id)) == 1

    def test_the_heartbeat_carries_them_and_z_mode(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        z = created(w, through=s)["zReport"]

        out = beat(w)

        assert out["zMode"] == "till"
        assert out["zReportedThroughSequence"] == 1
        assert out["recentShiftZs"] == [{"shiftId": str(s.id), "zReportId": z["id"], "zNumber": 1}]
        assert "pendingTillZ" not in out
        assert beat(w, w.tills[1])["zMode"] == "cloud"

    def test_a_duplicate_close_carries_the_till_z_number(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)
        body = ShiftCloseIn.model_validate({"closedAt": w.now.isoformat(), "transactionIds": []})

        out = sync_router.post_shift_close(
            machine_id=str(w.till.id), shift_id=s.id, body=body, machine=w.till, approval=None, db=w.db
        )

        assert (out.status, out.z_number) == ("duplicate", 1)


# ── The setting (§5.1) ───────────────────────────────────────────────────────


class TestModeSwitching:
    def test_switching_with_nothing_waiting(self, w):
        out = put_mode(w, w.tills[1], "till")

        assert out.z_mode == "till"
        assert w.db.get(type(w.tills[1]), w.tills[1].id).z_mode == "till"

    def test_the_same_value_is_a_no_op(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])  # would block a real switch

        out = put_mode(w, w.till, "till")

        assert out.z_mode == "till"

    def test_unreported_closed_shifts_refuse_it_with_their_count(self, w):
        for n in (1, 2):
            closed_shift(w, w.tills[1], n, [dict(total="10.00")])

        out = put_mode(w, w.tills[1], "till")

        assert out.status_code == 409
        assert json.loads(out.body) == {"detail": "unreported_shifts", "count": 2}
        assert w.tills[1].z_mode == "cloud"

    def test_an_open_shift_does_not_block(self, w):
        w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)

        assert put_mode(w, w.tills[1], "till").z_mode == "till"

    def test_a_live_z_run_blocks_it(self, w):
        w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
        run = cloud_run(w, w.tills[1])
        assert run.status == ZRunStatus.WAITING

        out = put_mode(w, w.tills[1], "till")

        assert (out.status_code, json.loads(out.body)) == (409, {"detail": "z_in_progress"})

    def test_a_pending_till_z_request_blocks_it(self, w):
        request(w)

        out = put_mode(w, w.till, "cloud")

        assert (out.status_code, json.loads(out.body)) == (409, {"detail": "z_in_progress"})

    def test_an_unknown_mode_is_a_422(self):
        with pytest.raises(ValidationError):
            POSMachineUpdate.model_validate({"zMode": "both"})

    def test_machines_show_it(self, w):
        detail = machines_router.get_machine(
            str(w.till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        listed = machines_router._enrich_machines_batch([w.till, w.tills[1]], w.db)

        assert detail["zMode"] == "till"
        assert [m["zMode"] for m in listed] == ["till", "cloud"]

    def test_a_till_mode_till_still_flags_closed_shifts_awaiting_z(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")], business_date=TODAY - timedelta(days=30))

        out = machines_router._enrich_machines_batch([w.till], w.db)[0]

        assert out["closedShiftsAwaitingZ"] == 1
        assert "closed_shifts_awaiting_z" in out["statusFlags"]


# ── Dashboard requests (§5.3–§5.4) ───────────────────────────────────────────


class TestRequests:
    def test_an_online_till_is_pushed_till_z(self, w):
        code, out = request(w)

        assert code == 201
        assert out["status"] == S.WAITING
        assert out["initiatedBy"] == "admin"
        assert out["online"] is True
        assert w.till_z_sent == [(str(w.tenant.id), str(w.till.id), str(out["id"]), "admin")]
        assert out["sentAt"] is not None

    def test_an_offline_till_collects_it_on_its_heartbeat(self, w):
        w.till.last_heartbeat_at = w.now - timedelta(hours=3)
        _code, out = request(w)
        assert w.till_z_sent == []

        handed = beat(w)["pendingTillZ"]

        assert handed["requestId"] == str(out["id"])
        assert handed["initiatedBy"] == "admin"
        assert handed["createdAt"]
        assert w.db.get(TillZRequest, out["id"]).sent_at is not None
        assert beat(w)["pendingTillZ"]["requestId"] == handed["requestId"]  # every beat

    def test_a_second_ask_returns_the_pending_one(self, w):
        _c, first = request(w)
        _c, second = request(w)

        assert second["id"] == first["id"]
        assert w.db.query(TillZRequest).count() == 1

    def test_a_cloud_till_is_422(self, w):
        code, body = request(w, w.tills[1])

        assert (code, body) == (422, {"detail": "machine_not_till_z", "machineId": str(w.tills[1].id)})

    def test_the_shop_asks_every_till_mode_till_by_default(self, w):
        out = tz_router.request_shop_till_z(
            w.shop.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

        assert [r["machineId"] for r in out] == [w.till.id]

    def test_the_shop_refuses_a_cloud_till_in_the_list_and_asks_nobody(self, w):
        out = tz_router.request_shop_till_z(
            w.shop.id,
            body=ShopTillZIn.model_validate({"machineIds": [str(w.till.id), str(w.tills[1].id)]}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

        assert out.status_code == 422
        assert json.loads(out.body) == {"detail": "machine_not_till_z", "machineId": str(w.tills[1].id)}
        assert w.db.query(TillZRequest).count() == 0

    def test_the_shop_refuses_another_shops_till(self, w):
        w.other_till.z_mode = "till"
        with pytest.raises(HTTPException) as exc:
            tz_router.request_shop_till_z(
                w.shop.id,
                body=ShopTillZIn.model_validate({"machineIds": [str(w.other_till.id)]}),
                current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
            )
        assert exc.value.detail == f"machine_not_in_shop:{w.other_till.id}"

    def test_the_till_z_completes_the_request_it_names(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        _c, req = request(w)

        body = created(w, request_id=req["id"], unattended=True)

        out = tz_router.get_till_z_request(req["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["status"] == S.COMPLETED
        assert out["zReportId"] == uuid.UUID(body["zReport"]["id"])
        assert out["machineSequenceNumber"] == 1
        z = w.db.get(ZReport, out["zReportId"])
        # Who asked: the dashboard user; nobody pressed it at the till.
        assert (z.created_by_user_id, z.created_by_name, z.unattended) == (w.admin.id, None, True)
        assert "pendingTillZ" not in beat(w)

    def test_a_till_z_pressed_at_the_till_answers_a_pending_request_too(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        _c, req = request(w)

        body = created(w, createdByName="דנה")

        stored = w.db.get(TillZRequest, req["id"])
        assert (stored.status, str(stored.z_report_id)) == (S.COMPLETED, body["zReport"]["id"])

    def test_nothing_to_report_completes_the_request_without_a_z(self, w):
        _c, req = request(w)

        code, body, _ = ask(w, request_id=req["id"], unattended=True)

        assert (code, body) == (409, {"detail": "nothing_to_report"})
        w.db.expire_all()  # what was committed
        stored = w.db.get(TillZRequest, req["id"])
        assert (stored.status, stored.error_code, stored.z_report_id) == (S.COMPLETED, "nothing_to_report", None)

    def test_ack_phases(self, w):
        _c, req = request(w)

        assert ack(w, req["id"], "received") == {"ok": True, "status": S.IN_PROGRESS}
        assert ack(w, req["id"], "deferred", "card_in_flight")["status"] == S.IN_PROGRESS
        assert w.db.get(TillZRequest, req["id"]).error_code == "card_in_flight"
        # `completed` never comes from an ack.
        assert ack(w, req["id"], "completed")["status"] == S.IN_PROGRESS
        assert ack(w, req["id"], "failed", "printer_error")["status"] == S.FAILED
        # Ended: an ack changes nothing.
        assert ack(w, req["id"], "received")["status"] == S.FAILED

    def test_a_failed_ack_with_nothing_to_report_is_that_answer(self, w):
        _c, req = request(w)

        assert ack(w, req["id"], "failed", "nothing_to_report")["status"] == S.COMPLETED

    def test_an_ack_for_another_tills_request_is_404(self, w):
        _c, req = request(w)
        with pytest.raises(HTTPException) as exc:
            ack(w, req["id"], "received", till=w.tills[1])
        assert (exc.value.status_code, exc.value.detail) == (404, "till_z_request_not_found")

    def test_a_request_nobody_answers_expires_after_36_hours(self, w):
        _c, req = request(w)
        stored = w.db.get(TillZRequest, req["id"])
        stored.created_at = stored.created_at - timedelta(hours=37)
        stored.expires_at = w.now - timedelta(hours=1)
        w.db.flush()

        out = tz_router.get_till_z_request(req["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert (out["status"], out["errorCode"]) == (S.EXPIRED, "expired")
        assert "pendingTillZ" not in beat(w)
        # Expired, it no longer holds the till.
        assert put_mode(w, w.till, "cloud").z_mode == "cloud"

    def test_cancel(self, w):
        _c, req = request(w)

        out = tz_router.cancel_till_z_request(req["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert out["status"] == S.CANCELLED
        assert "pendingTillZ" not in beat(w)
        with pytest.raises(HTTPException) as exc:
            tz_router.cancel_till_z_request(req["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (exc.value.status_code, exc.value.detail) == (409, "request_not_pending")

    def test_a_cancelled_request_is_not_completed_by_a_later_z(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        _c, req = request(w)
        tz_router.cancel_till_z_request(req["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        created(w, request_id=req["id"])

        assert w.db.get(TillZRequest, req["id"]).status == S.CANCELLED

    def test_the_list_filters(self, w):
        _c, a = request(w)
        tz_router.cancel_till_z_request(a["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        _c, b = request(w)

        def listed(**kw):
            args = dict(shop_id=None, machine_id=None, status_=None)
            args.update(kw)
            return [r["id"] for r in tz_router.list_till_z_requests(
                **args, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
            )]

        assert listed() == [b["id"], a["id"]]
        assert listed(status_="waiting") == [b["id"]]
        assert listed(machine_id=w.till.id) == [b["id"], a["id"]]
        assert listed(machine_id=w.tills[1].id) == []
        assert listed(shop_id=w.other_shop.id) == []

        old = w.db.get(TillZRequest, a["id"])
        old.created_at = w.now - timedelta(days=8)
        w.db.flush()
        # Without a status filter, the last 7 days; a status filter reaches further.
        assert listed() == [b["id"]]
        assert listed(status_="cancelled") == [a["id"]]


# ── The cloud never takes such a till ────────────────────────────────────────


class TestTheCloudZLeavesItAlone:
    def test_post_z_runs_refuses_it(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])

        out = z_runs_router.post_z_run(
            ZRunCreateIn.model_validate({"shopId": str(w.shop.id), "machines": [{"machineId": str(w.till.id)}]}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

        assert out.status_code == 422
        assert json.loads(out.body) == {"detail": "machine_issues_its_own_z", "machineId": str(w.till.id)}
        assert w.db.query(ZRun).count() == 0

    def test_the_candidates_say_which_tills_produce_their_own(self, w):
        out = z_runs_router.get_z_candidates(
            w.shop.id, area_id=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

        assert {m.machine_id: m.z_mode for m in out.machines} == {w.till.id: "till", w.tills[1].id: "cloud"}
        assert out.model_dump(by_alias=True)["machines"][0]["zMode"] in ("till", "cloud")

    def test_the_builder_refuses_it_on_every_other_road(self, w):
        """A run that already held the till (a switch that raced it): finishing it —
        by a close, expiry or proceed — fails the run and takes none of its shifts."""
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        with pytest.raises(ZBuildRefused) as exc:
            build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.till, s.id)])
        assert (exc.value.code, exc.value.machine_id) == ("machine_issues_its_own_z", w.till.id)

        run = ZRun(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, created_by_user_id=w.admin.id,
            status=ZRunStatus.WAITING, expires_at=w.now + timedelta(hours=36),
        )
        w.db.add(run)
        w.db.flush()
        w.db.add(ZRunItem(id=uuid.uuid4(), run_id=run.id, machine_id=w.till.id,
                          status=ZRunItemStatus.READY, through_shift_id=s.id))
        w.db.flush()

        assert ZR.finalise_if_ready(w.db, run) is False

        assert (run.status, run.error_code) == (ZRunStatus.FAILED, "machine_issues_its_own_z")
        assert w.db.get(Shift, s.id).z_report_id is None


# ── Consumers ────────────────────────────────────────────────────────────────


class TestConsumers:
    def _list(self, w, **kw):
        args = dict(
            machine_id=None, machine_ids=None, shop_id=None, from_date=None, to_date=None,
            closed_from=None, closed_to=None, area_id=None, origin=None, page=1, page_size=50,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        args.update(kw)
        return zr_router.list_z_reports(**args).model_dump(by_alias=True, mode="json")["items"]

    def _both(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        till_z = created(w, createdByName="דנה")["zReport"]
        closed_shift(w, w.tills[1], 1, [dict(total="20.00")])
        cloud = w.db.get(ZReport, cloud_run(w, w.tills[1]).z_report_id)
        return till_z, cloud

    def test_the_z_list_shows_till_zs_among_the_shops(self, w):
        till_z, cloud = self._both(w)

        items = {i["id"]: i for i in self._list(w, shop_id=w.shop.id)}

        assert set(items) == {till_z["id"], str(cloud.id)}
        mine = items[till_z["id"]]
        assert (mine["origin"], mine["machineSequenceNumber"], mine["shopSequenceNumber"]) == ("till", 1, None)
        assert (mine["machineId"], mine["machineName"], mine["posNumber"]) == (
            str(w.till.id), w.till.name, w.till.pos_number,
        )
        assert (mine["createdByName"], mine["totalsMismatch"], mine["legacy"]) == ("דנה", False, False)
        theirs = items[str(cloud.id)]
        assert (theirs["origin"], theirs["machineSequenceNumber"], theirs["machineId"]) == ("cloud", None, None)

    def test_the_z_list_filters_on_origin_and_machine(self, w):
        till_z, cloud = self._both(w)

        assert [i["id"] for i in self._list(w, origin="till")] == [till_z["id"]]
        assert [i["id"] for i in self._list(w, origin="cloud")] == [str(cloud.id)]
        assert [i["id"] for i in self._list(w, machine_id=w.till.id)] == [till_z["id"]]

    def test_the_z_detail(self, w):
        till_z, _cloud = self._both(w)

        out = zr_router.get_z_report(
            uuid.UUID(till_z["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        ).model_dump(by_alias=True, mode="json")

        # The till got exactly what the dashboard shows (the detail is one function).
        assert out == {**till_z, "tillTotals": None}
        assert [s["zNumber"] for s in out["shifts"]] == [1]
        assert len(out["perMachine"]) == 1

    def test_the_shifts_list_names_the_till_z_number(self, w):
        from app.routers import shifts as shifts_router

        till_z, _cloud = self._both(w)
        out = shifts_router.list_shifts(
            shop_id=None, machine_id=w.till.id, status_=None, awaiting_z=None, from_date=None,
            to_date=None, area_id=None, page=1, page_size=50,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

        assert [(str(s.z_report_id), s.z_number) for s in out.items] == [(till_z["id"], 1)]

    def test_the_day_summary_counts_a_till_z_as_one_tills_z(self, w):
        from app.services import reports as R

        till_z, cloud = self._both(w)
        window = R.ReportWindow(
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1), tz_name="Asia/Jerusalem",
            start=datetime(2026, 9, 26, tzinfo=timezone.utc), end=datetime(2026, 9, 29, tzinfo=timezone.utc),
            from_hour=None, to_hour=None,
        )

        out = R.build_day_summary_report(w.db, w.admin, w.tenant.id, window)

        day = out.days[0]
        assert (day.z_report_count, day.machine_count) == (2, 2)
        assert day.totals.sales == 30.0
        by_z = {str(c.z_report_id): c for c in day.contributors}
        mine = by_z[till_z["id"]]
        assert (mine.origin, mine.machine_sequence_number, mine.shop_sequence_number) == ("till", 1, None)
        assert (mine.machine_id, mine.pos_number) == (w.till.id, w.till.pos_number)
        assert (by_z[str(cloud.id)].origin, by_z[str(cloud.id)].shop_sequence_number) == ("cloud", 1)

    def test_the_tax_export_reads_documents_not_zs(self, w):
        """OpenFormat is built from the documents: a till Z neither adds nor hides one."""
        from app.services.tax_reports import load_transactions_for_tax_export

        self._both(w)

        docs = load_transactions_for_tax_export(
            w.db, w.tenant.id, shop_id=w.shop.id,
            start=datetime(2026, 9, 1, tzinfo=timezone.utc), end=datetime(2026, 10, 30, tzinfo=timezone.utc),
        )

        assert sorted(str(d.total_amount) for d in docs) == ["10.00", "20.00"]


# ── Migration ────────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "a2b3c4d5e6f7" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("a2b3c4d5e6f7").down_revision == "f1a2b3c4d5e6"
