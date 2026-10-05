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
        assert body["zNumber"] == 1 and body["nextNumber"] == 2
        assert w.db.get(Shift, s2.id).z_report_id is None
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 1
        assert w.db.get(MachineZSequence, w.till.id).last_number == 1

    def test_a_jump_is_accepted_and_reported(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])

        code, body = upload(w, offline_body(s, 3))

        assert code == 201, body
        assert w.db.get(MachineZSequence, w.till.id).last_number == 3
        z = w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).one()
        assert {"key": "machineSequenceNumber", "till": 3, "cloud": 1} in z.offline_discrepancies
        (row,) = exceptions_of(w, "offline_z_gap")
        assert row.details["zNumber"] == 3

    def test_a_hole_below_the_counter_is_filled_and_the_counter_stays(self, w):
        s1 = closed_shift(w, w.till, 1, [dict(total="10.00")])
        assert upload(w, offline_body(s1, 3))[0] == 201
        s2 = closed_shift(w, w.till, 2, [dict(total="10.00")])

        code, _ = upload(w, offline_body(s2, 2))

        assert code == 201
        assert w.db.get(MachineZSequence, w.till.id).last_number == 3

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

    def test_a_shift_already_in_another_z_is_a_conflict(self, w):
        s = closed_shift(w, w.till, 1, [dict(total="10.00")])
        created(w, through=s)

        code, body = upload(w, offline_body(s, 2))

        assert (code, body["detail"]) == (409, "offline_z_shift_in_another_z")
        assert body["shiftId"] == str(s.id)

    def test_a_shift_not_closed_in_the_cloud_yet_waits(self, w):
        s = w.shift(w.till, 1, status=ShiftStatus.OPEN)
        w.db.commit()

        code, body = upload(w, offline_body(s, 1))

        assert (code, body["detail"]) == (409, "shift_not_closed")
        assert "shift_not_closed" in TZ.OFFLINE_RETRY_DETAILS

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
