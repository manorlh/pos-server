"""
"הפקת Z מהענן ע״י התמיכה" — support produces a dead till's Z from the cloud
(docs/SPEC_OFFLINE_TILL_Z.md §4.6). The owner: no manual entry, ever; the cloud's data.

* **Online-normal** — a till that worked online: its open shift closed, its Z the next
  number, nothing skipped.
* **Printed offline, never sent** — the numbers between the cloud's last and the last the
  till reported are recorded and never reused; support's Z comes after them.
* **Shop Z mode** — no till Z: the shifts are closed, and the shop Z (a cloud run, or the
  main till in local mode, handed the section) takes them.
* **The till comes back** — told, refused for that period, its late documents and Zs noted.
* **Document counters** — a replacement starts after the device's last reported counters.
* **Permissions and unblocking.**
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.machine_z_sequence import MachineZSequence
from app.models.shift import Shift, ShiftStatus
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.services import support_z as SZ
from app.services import till_z as TZ
from app.services import z_runs as ZR
from app.services.shifts import last_closed_shift, note_documents_after_close
from test_offline_till_z import offline_body, put_mode, refused_body, upload
from test_till_z import ask, beat, closed_shift, created, w  # noqa: F401


def beat_with(w, till=None, **body):
    return machines_router.post_my_heartbeat(
        body=MachineHeartbeatBody.model_validate(body), machine=till or w.till, db=w.db,
    )


def dead(w, till=None, hours=3):
    till = till or w.till
    till.last_heartbeat_at = w.now - timedelta(hours=hours)
    w.db.commit()


def open_shift_with_sales(w, till, seq, *totals, numbers=None):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    for i, total in enumerate(totals):
        w.doc(till, shift, total, number=(numbers or [None] * len(totals))[i])
    w.db.commit()
    return shift


def produce(w, till=None, user=None, reason="destroyed", note=None):
    out = machines_router.post_support_z(
        machine_id=(till or w.till).id, body=machines_router.SupportZBody(reason=reason, note=note),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return out


def support_exception(w):
    return w.db.query(AuditException).filter(AuditException.exception_type == "support_z_produced").all()


def user_of(w, role):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{role.value}@x", username=role.value,
             shop_id=w.shop.id)
    w.db.add(u)
    w.db.commit()
    return u


# ── Per-till Z mode ──────────────────────────────────────────────────────────


class TestTillMode:
    def test_online_normal_closes_the_shift_and_takes_the_next_number(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        created(w, through=closed_shift(w, w.till, 2, [dict(total="10.00")]))
        beat_with(w, offlineTillZ={"pending": 0, "lastNumber": 2})
        shift = open_shift_with_sales(w, w.till, 3, "40.00", "60.00")
        dead(w)

        before = machines_router.get_support_z_preview(
            machine_id=w.till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert before["zNumber"] == 3 and before["skippedNumbers"] == []
        assert [s["willClose"] for s in before["shifts"]] == [True]
        assert before["documents"]["count"] == 2 and before["documents"]["totalSales"] == "100.00"

        out = produce(w, note="נשבר")

        assert out["zNumber"] == 3 and out["skippedNumbers"] == []
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.machine_sequence_number == 3 and z.origin == "till"
        assert z.total_sales == Decimal("100.00")
        assert z.header["producedBySupport"]["reason"] == "destroyed"
        s = w.db.get(Shift, shift.id)
        assert s.status == ShiftStatus.CLOSED and s.reconstructed and s.z_report_id == z.id
        assert w.db.get(MachineZSequence, w.till.id).last_number == 3
        (row,) = support_exception(w)
        assert row.details["zNumber"] == 3 and row.details["by"] == w.admin.username
        assert row.details["reasonText"] == "המכשיר הושמד" and row.details["note"] == "נשבר"
        assert row.details["basis"]["documentsOnCloud"] == 2
        w.db.refresh(w.till)
        assert w.till.support_z["zNumber"] == 3 and w.till.support_z_at is not None

    def test_numbers_printed_offline_and_never_sent_are_recorded_and_never_reused(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        created(w, through=closed_shift(w, w.till, 2, [dict(total="10.00")]))
        beat_with(w, offlineTillZ={"pending": 2, "conflict": False, "lastNumber": 4})
        closed_shift(w, w.till, 3, [dict(total="15.00")])
        open_shift_with_sales(w, w.till, 4, "25.00")
        dead(w)

        out = produce(w, reason="lost")

        assert out["skippedNumbers"] == [3, 4]
        assert out["zNumber"] == 5
        numbers = sorted(z.machine_sequence_number for z in w.db.query(ZReport).filter(ZReport.machine_id == w.till.id))
        assert numbers == [1, 2, 5]
        (row,) = support_exception(w)
        assert row.details["skippedLabel"] == "הודפסו במכשיר ללא חיבור ולא הגיעו לענן"
        assert "3, 4" in row.details["summary"]
        # Never reused: the run continues after support's Z.
        assert beat(w)["lastTillZNumber"] == 5

    def test_an_empty_till_is_closed_with_no_z_on_zero(self, w):
        open_shift_with_sales(w, w.till, 1)
        dead(w)

        out = produce(w, reason="permanent_failure")

        assert out["zReportId"] is None and out["closedShiftIds"]
        assert w.db.query(ZReport).filter(ZReport.machine_id == w.till.id).count() == 0


# ── Shop Z mode ──────────────────────────────────────────────────────────────


class TestShopMode:
    def test_the_cloud_shop_z_proceeds_with_the_dead_tills_shift(self, w):
        till = w.tills[1]
        shift = open_shift_with_sales(w, till, 1, "70.00")
        run = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)])
        w.db.commit()
        assert run.z_report_id is None
        dead(w, till)

        out = produce(w, till)

        assert out["zReportId"] is None and out["zMode"]["kind"] == "shop"
        w.db.refresh(run)
        assert run.z_report_id is not None
        z = w.db.get(ZReport, run.z_report_id)
        assert z.shop_sequence_number is not None and z.total_sales == Decimal("70.00")
        assert w.db.get(Shift, shift.id).z_report_id == z.id

    def test_in_local_mode_the_main_till_is_handed_the_section(self, w):
        from app.services.local_shop_z import _participant

        till = w.tills[1]
        open_shift_with_sales(w, till, 1, "70.00", "30.00")
        dead(w, till)
        assert "supportClosed" not in _participant(w.db, till)

        produce(w, till)

        section = _participant(w.db, till)["supportClosed"]
        assert section["machineId"] == str(till.id) and len(section["shiftIds"]) == 1
        assert section["till"]["totalSales"] == 100.0 and section["till"]["transactionsCount"] == 2
        assert section["report"]["shiftIds"] == section["shiftIds"]
        assert section["closedBySupport"]["by"] == w.admin.username


# ── The till comes back ──────────────────────────────────────────────────────


class TestTheTillComesBack:
    def test_it_is_told_on_its_next_contact_and_makes_nothing_for_that_period(self, w):
        shift = open_shift_with_sales(w, w.till, 1, "20.00")
        dead(w)
        out = produce(w)

        told = beat(w)["supportZ"]

        assert told["zNumber"] == out["zNumber"] and told["shiftIds"] == [str(shift.id)]
        code, body, _ = ask(w)
        assert (code, body["detail"]) == (409, "nothing_to_report")

    def test_its_late_documents_and_old_zs_are_noted_in_supports_record(self, w):
        shift = open_shift_with_sales(w, w.till, 1, "20.00")
        dead(w)
        produce(w)

        w.doc(w.till, w.db.get(Shift, shift.id), "5.00")
        note_documents_after_close(w.db, {shift.id: 1}, machine_id=w.till.id)
        code, body = upload(w, offline_body(w.db.get(Shift, shift.id), 1))

        assert code == 409
        (row,) = support_exception(w)
        w.db.refresh(row)
        assert row.details["lateDocuments"] == 1 and row.details["lateShiftIds"] == [str(shift.id)]
        assert row.details["returnedZs"][0]["zNumber"] == 1


# ── Document counters ────────────────────────────────────────────────────────


class TestDocumentCounters:
    def test_a_replacement_starts_after_the_devices_last_reported_counters(self, w):
        open_shift_with_sales(w, w.till, 1, "10.00", numbers=["100"])
        beat_with(w, documentCounters={"320": 120, "330": 4, "bogus": 9})
        w.db.refresh(w.till)
        assert w.till.reported_document_counters == {"320": 120, "330": 4}

        last = last_closed_shift(w.db, w.till.id)

        assert last.highest_transaction_numbers["320"] == 120
        assert last.highest_transaction_numbers["330"] == 4
        assert last.highest_transaction_number == 120

    def test_the_gap_is_recorded_with_supports_z(self, w):
        open_shift_with_sales(w, w.till, 1, "10.00", numbers=["100"])
        beat_with(w, documentCounters={"320": 120})
        dead(w)

        out = produce(w)

        gaps = out["documentCounters"]["gaps"]
        assert gaps == [{"series": "320", "cloudMax": 100, "reported": 120, "from": 101, "to": 120, "count": 20}]
        (row,) = support_exception(w)
        assert "101–120" in row.details["summary"]

    def test_the_pure_rules(self):
        assert SZ.skipped_numbers(2, 4) == [3, 4]
        assert SZ.skipped_numbers(4, 4) == [] and SZ.skipped_numbers(4, None) == []
        assert SZ.counter_gaps({"400": 9}, {"400": 9, "330": "x"}) == []


# ── Permissions and unblocking ───────────────────────────────────────────────


class TestPermissionsAndUnblocking:
    @pytest.mark.parametrize("role", [UserRole.SHOP_MANAGER, UserRole.COMPANY_MANAGER, UserRole.DISTRIBUTOR])
    def test_support_alone(self, w, role):
        dead(w)
        someone = user_of(w, role)
        with pytest.raises(HTTPException) as refused:
            produce(w, user=someone)
        assert refused.value.status_code == 403
        with pytest.raises(HTTPException) as refused:
            machines_router.get_support_z_preview(
                machine_id=w.till.id, current_user=someone, active_tenant_id=w.tenant.id, db=w.db,
            )
        assert refused.value.status_code == 403
        w.db.refresh(w.till)
        assert w.till.support_z is None

    def test_not_while_the_till_is_online(self, w):
        with pytest.raises(HTTPException) as refused:
            produce(w)
        assert refused.value.status_code == 409 and refused.value.detail["code"] == "terminal_is_online"

    def test_a_reason_from_the_list(self, w):
        dead(w)
        with pytest.raises(HTTPException) as refused:
            produce(w, reason="bored")
        assert refused.value.status_code == 422

    def test_support_unblocks_switching_and_replacement(self, w):
        beat_with(w, offlineTillZ={"pending": 2, "lastNumber": 3})
        dead(w)
        assert refused_body(put_mode(w, w.till, "cloud"))[0] == 409

        produce(w)

        assert TZ.may_be_producing_offline(w.db, w.till) is None
        code = machines_router.create_replacement_pairing_code(
            machine_id=w.till.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert "code" in code
