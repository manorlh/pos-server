"""
A till Z closed with no connection to the cloud, the card transmission at a Z, and the
forced remote Z close (docs/SPEC_OFFLINE_TILL_Z.md).

What each class pins, and how it could look fine while doing damage:

* **Numbering** — the till's number is taken when it is the next one, or at least not
  taken; a taken one is a 409 that writes nothing (two papers with one number); a
  re-upload is the same Z, never a second one; the counter only rises.
* **Figures** — built here from the documents with the same builder; every difference
  from the till's paper is kept on the Z and reported as an exception, never overwritten.
* **Guards** — the mode (`zMode = till`), shifts already in a Z, shifts not closed yet.
* **The parameter** — `tillZOffline` is a built-in boolean, off by default, and says it
  applies to the per-till Z only.
* **Card transmission** — kept on the Z; a failed one is an exception.
* **Force** — carried from the dashboard to the till on both channels; the till's
  forced-close event becomes the "סגירת Z כפויה" exception with who forced it.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from starlette.responses import Response

from app.models.audit_exception import AuditException
from app.models.machine_z_sequence import MachineZSequence
from app.models.shift import Shift, ShiftStatus
from app.models.till_z_request import TillZRequest
from app.models.z_report import ZReport
from app.routers import exceptions as exceptions_router
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.routers import till_z_requests as tz_router
from app.schemas.audit_exception import TillEventIn
from app.schemas.till_z import MachineTillZIn, ShopTillZIn, TillZIn
from app.services import till_parameters as TP
from app.services import till_z as TZ
from app.services import z_runs as ZR
from shift_world import NOW
from test_till_z import beat, closed_shift, created, w  # noqa: F401


# ── Helpers ──────────────────────────────────────────────────────────────────


def offline_body(shifts, number, *, cid=None, zid=None, till=None, report=None, first=None, last=None, **extra):
    shifts = shifts if isinstance(shifts, (list, tuple)) else [shifts]
    payload = {
        "clientRequestId": str(cid or uuid.uuid4()),
        "throughShiftId": str(shifts[-1].id),
        "createdByName": "דנה",
        "offline": {
            "id": str(zid or uuid.uuid4()),
            "machineSequenceNumber": number,
            "closedAt": (NOW + timedelta(hours=6)).isoformat(),
            "businessDate": str(shifts[0].business_date),
            "shiftIds": [str(s.id) for s in shifts],
            "firstDocumentNumber": first,
            "lastDocumentNumber": last,
            "report": report,
        },
        **extra,
    }
    if till is not None:
        payload["till"] = till
    return payload


def upload(w, payload, machine=None):
    machine = machine or w.till
    # What came before is committed, as it is for a real request: a refusal rolls back.
    w.db.commit()
    resp = sync_router.post_till_z(
        machine_id=str(machine.id), body=TillZIn.model_validate(payload), machine=machine, db=w.db
    )
    return resp.status_code, json.loads(resp.body)


def exceptions_of(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


#: The till's own §3.3 figures over one ₪100 cash sale and one ₪50 card sale.
TILL_FIGURES = {
    "totalSales": 150.0, "totalDiscounts": 0.0, "totalRefunds": 0.0, "totalCash": 100.0,
    "totalCard": 50.0, "totalTips": 0.0, "vatTotal": 21.79, "transactionsCount": 2,
}
SALES = [
    dict(total="100.00", vat="14.53", number="11"),
    dict(total="50.00", method="card", vat="7.26", number="12"),
]


# ── Numbering ────────────────────────────────────────────────────────────────


class TestNumbering:
    def test_the_next_number_is_taken_as_the_tills(self, w):
        s = closed_shift(w, w.till, 1, SALES)
        zid = uuid.uuid4()

        code, body = upload(w, offline_body(s, 1, zid=zid, till=TILL_FIGURES, first="11", last="12"))

        assert code == 201, body
        z = w.db.get(ZReport, zid)
        assert z is not None and z.machine_sequence_number == 1
        assert z.built_offline is True and z.uploaded_at is not None
        assert z.offline_discrepancies is None
        assert body["zReport"]["builtOffline"] is True
        assert body["zReport"]["machineSequenceNumber"] == 1
        assert body["shiftIds"] == [str(s.id)]
        assert w.db.get(Shift, s.id).z_report_id == zid
        assert w.db.get(MachineZSequence, w.till.id).last_number == 1
        assert exceptions_of(w, "offline_z_gap") == []

    def test_after_an_online_z_the_next_offline_number_follows_it(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        code, body = upload(w, offline_body(s2, 2))

        assert code == 201, body
        assert w.db.get(MachineZSequence, w.till.id).last_number == 2

    def test_a_number_already_taken_is_refused_and_writes_nothing(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        code, body = upload(w, offline_body(s2, 1))

        assert code == 409
        assert body["detail"] == "offline_z_number_taken"
        assert body["zNumber"] == 1 and body["expectedNumber"] == 2
        assert body["takenByZReportId"]
        (row,) = exceptions_of(w, "offline_z_conflict")
        assert row.details["takenByZReportId"] == body["takenByZReportId"]
        assert w.db.get(Shift, s2.id).z_report_id is None
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 1
        assert w.db.get(MachineZSequence, w.till.id).last_number == 1

    def test_a_jump_is_a_conflict_that_enters_no_z_into_the_run(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])

        code, body = upload(w, offline_body(s, 3))

        assert code == 409
        assert body == {"detail": "offline_z_out_of_sequence", "zNumber": 3, "expectedNumber": 1}
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 0
        assert w.db.get(Shift, s.id).z_report_id is None
        seq = w.db.get(MachineZSequence, w.till.id)
        assert seq is None or seq.last_number == 0

    def test_a_conflict_is_recorded_for_support_with_the_z_as_printed(self, w):
        """Never renumbered ("אין דבר כזה זד שממוספר מחדש"): kept as printed, recorded, alerted."""
        s = closed_shift(w, w.till, 1, SALES)
        zid = uuid.uuid4()
        payload = offline_body(s, 3, zid=zid, till=TILL_FIGURES, first="11", last="12")

        assert upload(w, payload)[0] == 409

        (row,) = exceptions_of(w, "offline_z_conflict")
        assert row.severity == "high"
        assert row.details["zNumber"] == 3 and row.details["expectedNumber"] == 1
        assert row.details["zId"] == str(zid)
        assert row.details["conflict"] == "offline_z_out_of_sequence"
        assert row.details["till"]["totalSales"] == 150.0
        assert row.details["shiftIds"] == [str(s.id)]
        assert "פנו לתמיכה" in row.details["summary"]
        w.db.refresh(w.till)
        assert w.till.offline_till_z_conflict is True
        # Sent again unchanged, after support looked: the same refusal, one exception.
        code, body = upload(w, payload)
        assert (code, body["zNumber"]) == (409, 3)
        assert len(exceptions_of(w, "offline_z_conflict")) == 1

    def test_the_cloud_never_takes_another_number_for_the_same_z(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        payload = offline_body(s, 3)
        assert upload(w, payload)[0] == 409

        # Whatever arrives, a Z the till printed as 3 is never filed as 1.
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 0
        assert w.db.query(ZReport).filter(ZReport.client_request_id == uuid.UUID(payload["clientRequestId"])).first() is None

    def test_a_number_below_the_counter_is_refused_even_when_free(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        created(w, through=closed_shift(w, w.till, 2, [dict(total="10.00")]))
        # A hole in the run from before strict numbering (or a lost row) is never filled
        # out of order: the next Z is always last + 1.
        w.db.query(ZReport).filter(ZReport.machine_sequence_number == 1).one().machine_sequence_number = None
        w.db.commit()
        s3 = closed_shift(w, w.till, 3, [dict(total="10.00")])

        code, body = upload(w, offline_body(s3, 1))

        assert (code, body["detail"], body["expectedNumber"]) == (409, "offline_z_out_of_sequence", 3)

    def test_the_run_has_no_gap_after_online_and_offline_zs(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        assert upload(w, offline_body(closed_shift(w, w.till, 2, [dict(total="10.00")]), 2))[0] == 201
        assert upload(w, offline_body(closed_shift(w, w.till, 3, [dict(total="10.00")]), 3))[0] == 201
        created(w, through=closed_shift(w, w.till, 4, [dict(total="10.00")]))

        numbers = [z.machine_sequence_number for z in
                   w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).order_by(ZReport.machine_sequence_number)]
        assert numbers == [1, 2, 3, 4]

    def test_the_claim_backstop_refuses_anything_but_the_next(self, w):
        from app.services.z_sequence import ZNumberOutOfSequence, claim_machine_z_number

        with pytest.raises(ZNumberOutOfSequence):
            claim_machine_z_number(w.db, w.till.id, 2)
        assert claim_machine_z_number(w.db, w.till.id, 1) == 0

    def test_a_reupload_after_later_zs_is_still_the_same_z(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        payload = offline_body(s, 1)
        assert upload(w, payload)[0] == 201
        created(w, through=closed_shift(w, w.till, 2, [dict(total="10.00")]))

        code, body = upload(w, payload)

        assert (code, body["status"], body["zReport"]["machineSequenceNumber"]) == (200, "duplicate", 1)

    def test_a_reupload_is_the_same_z(self, w):
        s = closed_shift(w, w.till, 1, SALES)
        payload = offline_body(s, 1, till=TILL_FIGURES)

        first = upload(w, payload)
        again = upload(w, payload)

        assert first[0] == 201 and again[0] == 200
        assert again[1]["status"] == "duplicate"
        assert again[1]["zReport"]["id"] == first[1]["zReport"]["id"]
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 1
        assert w.db.get(MachineZSequence, w.till.id).last_number == 1

    def test_the_heartbeat_tells_the_till_its_last_number(self, w):
        assert beat(w)["lastTillZNumber"] == 0
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        assert beat(w)["lastTillZNumber"] == 1


# ── Prevention: nothing in the cloud while the till may be producing (§4.4) ────


def beat_with(w, till=None, **offline):
    from app.schemas.pos_machine import MachineHeartbeatBody

    body = MachineHeartbeatBody.model_validate({"offlineTillZ": offline})
    return machines_router.post_my_heartbeat(body=body, machine=till or w.till, db=w.db)


def put_mode(w, till, mode):
    from app.schemas.pos_machine import POSMachineUpdate

    return machines_router.update_machine(
        str(till.id), POSMachineUpdate.model_validate({"zMode": mode}), w.admin, w.tenant.id, w.db
    )


def set_param(w, key, till, value):
    from app.models.till_parameter import TillParameter, TillParameterValue

    TP.ensure_builtin_parameters(w.db)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=till.id, value=value,
    ))
    w.db.commit()


def refused_body(out):
    return out.status_code, json.loads(out.body)


class TestPrevention:
    def test_the_heartbeat_says_what_the_till_holds(self, w):
        beat_with(w, pending=2, conflict=False, lastNumber=7)
        w.db.refresh(w.till)
        assert (w.till.offline_till_z_pending, w.till.offline_till_z_conflict) == (2, False)
        assert w.till.offline_till_z_reported_at is not None

    def test_no_mode_switch_while_the_till_holds_unsynced_zs(self, w):
        beat_with(w, pending=1)

        code, body = refused_body(put_mode(w, w.till, "cloud"))

        assert (code, body["detail"], body["reason"], body["pending"]) == (409, "till_offline_zs_unsynced", "pending", 1)
        assert "סונכרנו" in body["message"]
        w.db.refresh(w.till)
        assert w.till.z_mode == "till"

    def test_no_mode_switch_while_a_conflict_is_held(self, w):
        beat_with(w, pending=0, conflict=True)
        code, body = refused_body(put_mode(w, w.till, "cloud"))
        assert (code, body["detail"]) == (409, "till_offline_zs_unsynced")

    def test_a_till_that_may_close_offline_and_is_not_seen_may_be_producing(self, w):
        set_param(w, "tillZOffline", w.till, True)
        w.till.last_heartbeat_at = w.now - timedelta(hours=3)
        w.db.commit()

        code, body = refused_body(put_mode(w, w.till, "cloud"))

        assert (code, body["reason"]) == (409, "not_seen")

    def test_without_the_parameter_a_till_not_seen_is_not_producing(self, w):
        w.till.last_heartbeat_at = w.now - timedelta(hours=3)
        w.db.commit()

        assert TZ.may_be_producing_offline(w.db, w.till) is None
        out = put_mode(w, w.till, "cloud")
        assert getattr(out, "status_code", 200) == 200
        w.db.refresh(w.till)
        assert w.till.z_mode == "cloud"

    def test_switching_back_once_synced(self, w):
        beat_with(w, pending=1)
        assert refused_body(put_mode(w, w.till, "cloud"))[0] == 409
        beat_with(w, pending=0, conflict=False)
        put_mode(w, w.till, "cloud")
        w.db.refresh(w.till)
        assert w.till.z_mode == "cloud"

    def test_no_replacement_device_while_the_till_holds_unsynced_zs(self, w):
        beat_with(w, pending=3)
        out = machines_router.create_replacement_pairing_code(
            machine_id=w.till.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        code, body = refused_body(out)
        assert (code, body["detail"]) == (409, "till_offline_zs_unsynced")

    def test_an_accepted_upload_counts_down_what_waits(self, w):
        beat_with(w, pending=2)
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        assert upload(w, offline_body(s, 1))[0] == 201
        w.db.refresh(w.till)
        assert w.till.offline_till_z_pending == 1

    def test_a_cloud_z_run_never_takes_a_till_z_till(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        with pytest.raises(TZ.TillZRefused) as refused:
            ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=w.till.id)])
        assert refused.value.body["detail"] == "machine_issues_its_own_z"

    def test_the_dashboard_asks_the_till_it_never_makes_the_z_itself(self, w):
        closed_shift(w, w.till, 1, [dict(total="10.00")])
        machines_router.request_till_z(
            machine_id=w.till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        # A request for the till to act on; no Z, no number, until the till asks itself.
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 0
        assert beat(w)["lastTillZNumber"] == 0


# ── History (§4.3) ───────────────────────────────────────────────────────────


def history(w, days=31):
    return sync_router.get_till_z_history(machine_id=str(w.till.id), days=days, machine=w.till, db=w.db)


class TestHistory:
    def test_a_new_till_gets_its_last_month_with_the_last_number(self, w):
        for seq in (1, 2, 3):
            created(w, through=closed_shift(w, w.till, seq, [dict(total="10.00")]))
        # The first one is two months old.
        first = w.db.query(ZReport).filter(ZReport.machine_sequence_number == 1).one()
        first.closed_at = first.closed_at - timedelta(days=60)
        w.db.commit()

        out = history(w)

        assert out["lastTillZNumber"] == 3
        assert [i["zReport"]["machineSequenceNumber"] for i in out["items"]] == [2, 3]
        item = out["items"][-1]
        assert item["status"] == "history" and item["shiftIds"]
        assert item["zReport"]["perMachine"][0]["totalSales"] is not None

    def test_the_newest_comes_however_old(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        z.closed_at = z.closed_at - timedelta(days=90)
        w.db.commit()

        out = history(w)

        assert [i["zReport"]["machineSequenceNumber"] for i in out["items"]] == [1]

    def test_only_this_tills_own_zs(self, w):
        other = w.tills[1]
        other.z_mode = "till"
        created(w, other, through=closed_shift(w, other, 1, [dict(total="10.00")]))

        out = history(w)

        assert out == {**out, "lastTillZNumber": 0, "items": []}


# ── Figures ──────────────────────────────────────────────────────────────────


class TestFigures:
    def test_a_difference_is_kept_and_reported_never_overwritten(self, w):
        s = closed_shift(w, w.till, 1, SALES)
        wrong = {**TILL_FIGURES, "totalSales": 170.0, "totalCash": 120.0}

        code, body = upload(w, offline_body(s, 1, till=wrong, first="11", last="13"))

        assert code == 201, body
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        # The Z's figures are the cloud's, from the documents.
        assert z.total_cash_sales == Decimal("100.00")
        keys = {d["key"]: d for d in z.offline_discrepancies}
        assert keys["totalSales"]["till"] == 170.0 and Decimal(keys["totalSales"]["cloud"]) == Decimal("150.00")
        assert keys["totalCash"]["till"] == 120.0
        assert keys["lastDocumentNumber"] == {"key": "lastDocumentNumber", "till": "13", "cloud": "12"}
        assert "firstDocumentNumber" not in keys
        # What the till printed is kept beside it.
        assert z.offline_report["till"]["totalSales"] == 170.0
        (row,) = exceptions_of(w, "offline_z_gap")
        assert row.severity == "high" and row.machine_id == w.till.id
        assert {d["key"] for d in row.details["discrepancies"]} >= {"totalSales", "totalCash", "lastDocumentNumber"}

    def test_a_shift_the_till_left_out_is_a_difference(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")])
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])
        payload = offline_body(s2, 1)

        code, _ = upload(w, payload)

        assert code == 201
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        assert w.db.get(Shift, s1.id).z_report_id == z.id  # no gap in the till's shifts
        assert any(d["key"] == "shiftIds" for d in z.offline_discrepancies)

    def test_an_empty_set_is_not_refused_the_paper_exists(self, w):
        s = closed_shift(w, w.till, 1, [])

        code, body = upload(w, offline_body(s, 1))

        assert code == 201, body

    def test_the_pure_comparison_ignores_what_the_till_did_not_send(self):
        section = {"grossSales": "10.00", "totalCash": "10.00", "firstDocumentNumber": "1", "lastDocumentNumber": "1"}
        assert TZ.offline_discrepancies(
            number=1, counter_before=0, till_totals={"totalSales": 10.004}, till_report=None,
            till_shift_ids=["a"], cloud_shift_ids=["a"], till_first_document=None,
            till_last_document="1", section=section,
        ) == []


# ── Guards ───────────────────────────────────────────────────────────────────


class TestGuards:
    def test_a_till_not_in_the_per_till_mode_is_refused(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        w.till.z_mode = "cloud"
        w.db.commit()

        code, body = upload(w, offline_body(s, 1))

        assert (code, body["detail"]) == (409, "till_z_disabled")
        assert w.db.get(Shift, s.id).z_report_id is None
        # Printed already: a conflict for support, never dropped quietly.
        assert len(exceptions_of(w, "offline_z_conflict")) == 1

    def test_a_shift_already_in_another_z_is_a_conflict(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)

        code, body = upload(w, offline_body(s, 2))

        assert (code, body["detail"]) == (409, "offline_z_shift_in_another_z")
        assert body["shiftId"] == str(s.id)
        assert len(exceptions_of(w, "offline_z_conflict")) == 1

    def test_a_shift_not_closed_in_the_cloud_yet_waits(self, w):
        s = w.shift(w.till, 1, status=ShiftStatus.OPEN)
        w.db.commit()

        code, body = upload(w, offline_body(s, 1))

        assert (code, body["detail"]) == (409, "shift_not_closed")
        assert "shift_not_closed" in TZ.OFFLINE_RETRY_DETAILS
        # A wait, not a conflict.
        assert exceptions_of(w, "offline_z_conflict") == []

    def test_an_id_held_by_another_z_is_a_conflict(self, w):
        first = created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        code, body = upload(w, offline_body(s2, 2, zid=uuid.UUID(first["zReport"]["id"])))

        assert (code, body["detail"]) == (409, "offline_z_id_conflict")


# ── The parameter ────────────────────────────────────────────────────────────


class TestParameter:
    def test_tillZOffline_is_a_builtin_boolean_off_by_default(self):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == "tillZOffline"]
        assert spec.value_type == "boolean" and spec.default_value is False
        assert "Z לכל קופה" in spec.label
        assert "Z סניפי" in spec.description and "נקודת מכירה" in spec.description

    def test_it_is_created_with_the_others(self, w):
        from app.models.till_parameter import TillParameter

        TP.ensure_builtin_parameters(w.db)
        row = w.db.query(TillParameter).filter(TillParameter.key == "tillZOffline").one()
        assert row.value_type == "boolean" and row.is_active


# ── Card transmission at the Z ───────────────────────────────────────────────


class TestCardTransmission:
    def test_it_is_kept_on_the_z(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        report = {"outcome": "success", "batchNumber": "77", "transactionCount": 2, "amount": "130.00",
                  "byBrand": [{"brand": "visa", "count": 2, "amount": "130.00"}]}

        body = created(w, through=s, cardTransmission=report)

        assert body["zReport"]["cardTransmission"]["batchNumber"] == "77"
        assert exceptions_of(w, "z_transmission_failed") == []

    def test_a_failed_one_closed_on_confirmation_is_an_exception(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        report = {"outcome": "failed", "statusCode": 3, "statusMessage": "אין תקשורת לשב\"א",
                  "confirmedFailure": True, "confirmedByName": "דנה"}

        body = created(w, through=s, cardTransmission=report)

        (row,) = exceptions_of(w, "z_transmission_failed")
        assert row.details["statusMessage"] == report["statusMessage"]
        assert row.details["zNumber"] == body["zReport"]["machineSequenceNumber"]

    def test_an_offline_z_carries_it_too(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        code, _ = upload(w, offline_body(s, 1, cardTransmission={"outcome": "unknown", "error": "timeout"}))
        assert code == 201
        assert len(exceptions_of(w, "z_transmission_failed")) == 1

    def test_the_z_close_trigger_is_accepted(self):
        from app.schemas.transmission import TransmissionReportIn as TransmissionIn

        field = TransmissionIn.model_fields["trigger"]
        assert "z_close" in str(field.annotation)


# ── Force ────────────────────────────────────────────────────────────────────


class TestForce:
    def test_a_forced_till_z_request_reaches_the_till_with_force(self, w):
        out = machines_router.request_till_z(
            machine_id=w.till.id, body=MachineTillZIn(force=True), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        req = w.db.get(TillZRequest, out["id"])
        assert req.force_close is True and out["force"] is True
        assert beat(w)["pendingTillZ"]["force"] is True

    def test_without_force_nothing_changes(self, w):
        machines_router.request_till_z(
            machine_id=w.till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert "force" not in beat(w)["pendingTillZ"]

    def test_asking_again_with_force_makes_the_pending_one_forced(self, w):
        first = machines_router.request_till_z(
            machine_id=w.till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        again = machines_router.request_till_z(
            machine_id=w.till.id, body=MachineTillZIn(force=True), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert again["id"] == first["id"] and again["force"] is True

    def test_a_shop_request_carries_force(self, w):
        out = tz_router.request_shop_till_z(
            shop_id=w.shop.id, body=ShopTillZIn(force=True), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert all(r["force"] for r in out)

    def test_a_forced_z_run_hands_force_with_the_close(self, w):
        till = w.tills[1]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        w.doc(till, shift, "10.00")
        w.db.commit()

        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], force=True)
        w.db.commit()

        assert run.force_close is True
        handed = beat(w, till)["pendingCloseShift"]
        assert handed["force"] is True

    def test_the_tills_forced_close_event_is_the_forced_exception_with_who(self, w):
        out = machines_router.request_till_z(
            machine_id=w.till.id, body=MachineTillZIn(force=True), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        body = TillEventIn(
            id=uuid.uuid4(), type="forced_z_close", occurredAt=NOW, posUserId=None,
            details={"requestId": str(out["id"]), "kind": "till_z",
                     "parked": {"name": "הושהתה בסגירת Z מרחוק", "lines": 2, "amount": 42.0}},
        )

        exceptions_router.post_till_event(str(w.till.id), body, Response(), machine=w.till, db=w.db)

        (row,) = exceptions_of(w, "forced_z_close")
        assert row.severity == "high"
        assert row.details["forcedBy"] == w.admin.username or row.details["forcedBy"] == w.admin.email
        assert row.details["requestKind"] == "till_z"
        assert row.details["parked"]["lines"] == 2


# ── "טיפ באשראי משולם מהמזומן": the drawer of an offline Z with card tips paid from it ─────


def _closed_paying_tips(w, *, counted, till_figures):
    """50 in cash and 50 on a card with a 10 card tip, closed with the till's frozen figure."""
    from app.schemas.shift import ShiftCloseIn
    from app.services.shifts import apply_shift_close

    shift = w.shift(w.till, 1, status=ShiftStatus.OPEN, opening_cash="100.00")
    made = [
        w.doc(w.till, shift, total="50.00", number="11"),
        w.doc(w.till, shift, total="50.00", method="card", tip="10.00", tip_method="card", number="12"),
    ]
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "countedCash": counted,
        "transactionIds": [str(d.id) for d in made],
        "till": till_figures,
    })
    shift, outcome = apply_shift_close(w.db, w.till, shift.id, body)
    assert outcome == "accepted"
    return shift


#: What the till printed: float 100 + cash 50 − card tips 10 = 140; the drawer's own cash 40.
DRAWER_PRINTED = {
    "openingCash": 100.0, "expectedCash": 140.0, "countedCash": 140.0, "overShort": 0.0,
    "cardTipsFromDrawer": 10.0, "drawerCash": 40.0,
}


class TestCardTipsPaidFromTheDrawer:
    def test_the_till_and_the_cloud_agree_nothing_is_flagged(self, w):
        s = _closed_paying_tips(w, counted=140, till_figures={"cardTipsFromDrawer": 10})

        code, body = upload(w, offline_body(s, 1, report=DRAWER_PRINTED, first="11", last="12"))

        assert code == 201, body
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        assert z.offline_discrepancies is None
        assert (z.expected_cash, z.discrepancy) == (Decimal("140.00"), Decimal("0.00"))
        assert (z.per_machine[0]["cardTipsFromDrawer"], z.per_machine[0]["drawerCash"]) == ("10.00", "40.00")
        assert exceptions_of(w, "offline_z_gap") == []

    def test_a_drawer_that_differs_is_still_flagged(self, w):
        s = _closed_paying_tips(w, counted=140, till_figures={"cardTipsFromDrawer": 10})
        printed = {**DRAWER_PRINTED, "cardTipsFromDrawer": 15.0, "drawerCash": 35.0, "expectedCash": 135.0}

        code, _ = upload(w, offline_body(s, 1, report=printed, first="11", last="12"))

        assert code == 201
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        keys = {d["key"]: d for d in z.offline_discrepancies}
        assert set(keys) == {"expectedCash", "cardTipsFromDrawer", "drawerCash"}
        assert keys["drawerCash"]["cloud"] == "40.00"

    def test_without_the_figure_the_drawer_is_as_before(self, w):
        s = _closed_paying_tips(w, counted=150, till_figures=None)
        printed = {"openingCash": 100.0, "expectedCash": 150.0, "countedCash": 150.0, "overShort": 0.0}

        code, _ = upload(w, offline_body(s, 1, report=printed, first="11", last="12"))

        assert code == 201
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        assert z.offline_discrepancies is None
        assert "cardTipsFromDrawer" not in z.per_machine[0]

    def test_the_pure_comparison_takes_the_two_figures(self):
        section = {"expectedCash": "140.00", "cardTipsFromDrawer": "10.00", "drawerCash": "40.00"}
        common = dict(
            number=1, counter_before=0, till_totals=None, till_shift_ids=["a"], cloud_shift_ids=["a"],
            till_first_document=None, till_last_document=None, section=section,
        )
        same = {"expectedCash": 140, "cardTipsFromDrawer": 10, "drawerCash": 40}
        assert TZ.offline_discrepancies(till_report=same, **common) == []
        assert TZ.offline_discrepancies(till_report={**same, "drawerCash": 50}, **common) == [
            {"key": "drawerCash", "till": 50, "cloud": "40.00"},
        ]
        # What the till did not send is not compared.
        assert TZ.offline_discrepancies(till_report={"expectedCash": 140}, **common) == []
