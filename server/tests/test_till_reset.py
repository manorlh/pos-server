"""
"איפוס נתוני קופה (תמיכה)" — a reset of a till's data happens only from the cloud, by
support (docs/SPEC_OFFLINE_TILL_Z.md §4.7). The owner: "איפוס זדים קורה רק מהענן ובאמצעות
סופר אדמין בתמיכה".

* **Support alone** — every other role is 403; a kind from the list and a reason.
* **The command** rides the heartbeat until the till answers (or 36 h pass); one at a time.
* **The till's answer** — done, or refused with why (unsynced) — is kept on the machine and
  in the one exception that audits it; a second answer changes nothing.
* **Counters never go down** — the last Z number and the document counters the till
  reports, and no delete takes a Z run with it.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.machine_z_sequence import MachineZSequence
from app.models.pos_machine import POSMachine
from app.models.shop_z_sequence import ShopZSequence
from app.models.user import UserRole
from app.routers import machines as machines_router
from app.routers import shops as shops_router
from app.routers import sync as sync_router
from app.services import till_reset as TR
from test_support_z import beat_with, user_of
from test_till_z import closed_shift, created, w  # noqa: F401


def order(w, kind="full", reason="נתונים פגומים בקופה", user=None, till=None):
    return machines_router.post_till_reset(
        machine_id=(till or w.till).id, body=machines_router.TillResetBody(kind=kind, reason=reason),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def preview(w, user=None):
    return machines_router.get_till_reset_preview(
        machine_id=w.till.id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def answer(w, command_id, status="done", **extra):
    body = sync_router.TillResetResultIn.model_validate({"commandId": command_id, "status": status, **extra})
    return sync_router.post_till_reset_result(machine_id=str(w.till.id), body=body, machine=w.till, db=w.db)


def resets(w):
    return w.db.query(AuditException).filter(AuditException.exception_type == "till_reset").all()


class TestSupportAlone:
    @pytest.mark.parametrize(
        "role", [UserRole.SHOP_MANAGER, UserRole.COMPANY_MANAGER, UserRole.DISTRIBUTOR, UserRole.SHIFT_SUPERVISOR]
    )
    def test_any_other_role_is_403(self, w, role):
        someone = user_of(w, role)
        with pytest.raises(HTTPException) as refused:
            order(w, user=someone)
        assert refused.value.status_code == 403 and refused.value.detail == "super_admin_only"
        with pytest.raises(HTTPException) as refused:
            preview(w, user=someone)
        assert refused.value.status_code == 403
        w.db.refresh(w.till)
        assert w.till.till_reset is None and resets(w) == []

    def test_a_kind_from_the_list_and_a_reason(self, w):
        with pytest.raises(HTTPException) as refused:
            order(w, kind="everything")
        assert (refused.value.status_code, refused.value.detail) == (422, "invalid_kind")
        with pytest.raises(HTTPException) as refused:
            order(w, reason="  ")
        assert (refused.value.status_code, refused.value.detail) == (422, "reason_required")


class TestTheCommand:
    def test_it_rides_the_heartbeat_until_the_till_answers(self, w):
        out = order(w, kind="transactions")

        assert out["status"] == "pending" and out["kindText"] == "מחיקת תנועות מקומיות"
        assert out["by"] == w.admin.username and out["reason"] == "נתונים פגומים בקופה"
        beat = beat_with(w)
        assert beat["pendingReset"] == {
            "commandId": out["id"], "kind": "transactions", "reason": "נתונים פגומים בקופה",
            "requestedBy": w.admin.username, "requestedAt": out["requestedAt"],
        }
        assert "pendingReset" in beat_with(w)  # again, until answered
        (row,) = resets(w)
        assert row.details["status"] == "pending" and row.severity == "high"

    def test_one_at_a_time(self, w):
        first = order(w)
        with pytest.raises(HTTPException) as refused:
            order(w)
        assert refused.value.status_code == 409 and refused.value.detail["code"] == "reset_pending"
        assert refused.value.detail["commandId"] == first["id"]

    def test_unanswered_it_expires(self, w):
        out = order(w)
        record = dict(w.till.till_reset)
        record["expiresAt"] = (w.now - timedelta(minutes=1)).isoformat()
        w.till.till_reset = record
        w.db.commit()

        assert "pendingReset" not in beat_with(w)
        w.db.refresh(w.till)
        assert w.till.till_reset["status"] == "expired" and w.till.till_reset["id"] == out["id"]
        assert order(w)["status"] == "pending"  # a new one may be ordered

    def test_the_preview_says_what_is_unsynced_what_is_kept_and_that_counters_stay(self, w):
        created(w, through=closed_shift(w, w.till, 1, [dict(total="10.00")]))
        beat_with(w, pendingCount=3, pendingDocuments=2, offlineTillZ={"pending": 1, "lastNumber": 2},
                  documentCounters={"320": 41})
        out = preview(w)
        assert out["unsynced"]["outbox"] == 3 and out["unsynced"]["documents"] == 2
        assert out["unsynced"]["offlineTillZs"] == 1
        assert out["warnings"] == ["outbox_not_empty", "offline_zs_kept"]
        assert out["keptZs"]["days"] == 31 and out["keptZs"]["numbers"] == [1]
        assert out["keptZs"]["awaitingOnTill"] == 1
        assert out["counters"]["stay"] is True and out["counters"]["lastTillZNumber"] == 1
        assert out["counters"]["reportedLastZNumber"] == 2
        assert out["counters"]["documentCounters"]["reported"] == {"320": 41}


class TestTheTillsAnswer:
    def test_done_is_kept_and_audited_once(self, w):
        out = order(w)
        counters = {"before": {"z": 4, "320": 120, "330": 7}, "after": {"z": 4, "320": 120, "330": 7}}
        answer(w, out["id"], transactionsDeleted=12, keptZs=3, keptZNumbers=[2, 3, 4], counters=counters,
               outboxPending=0, executedAt=w.now.isoformat())

        w.db.refresh(w.till)
        record = w.till.till_reset
        assert record["status"] == "done" and record["completedAt"]
        assert record["result"]["transactionsDeleted"] == 12 and record["result"]["keptZNumbers"] == [2, 3, 4]
        assert record["result"]["countersLowered"] == []
        assert "pendingReset" not in beat_with(w)
        (row,) = resets(w)
        assert row.details["status"] == "done" and "בוצע בקופה" in row.details["summary"]

        # Said twice: nothing changes.
        answer(w, out["id"], status="failed", code="failed")
        w.db.refresh(w.till)
        assert w.till.till_reset["status"] == "done"

    def test_the_till_refuses_when_unsynced_and_says_why(self, w):
        out = order(w)
        answer(w, out["id"], status="refused", code="outbox_not_empty", outboxPending=5,
               message="יש בקופה 5 פריטים שלא סונכרנו")

        w.db.refresh(w.till)
        assert w.till.till_reset["status"] == "refused"
        assert w.till.till_reset["result"]["code"] == "outbox_not_empty"
        assert w.till.till_reset["result"]["outboxPending"] == 5
        (row,) = resets(w)
        assert row.details["status"] == "refused" and "outbox_not_empty" in row.details["summary"]
        assert "pendingReset" not in beat_with(w)

    def test_a_command_it_was_never_given_is_404(self, w):
        order(w)
        with pytest.raises(HTTPException) as refused:
            answer(w, str(uuid.uuid4()))
        assert (refused.value.status_code, refused.value.detail) == (404, "unknown_command")

    def test_a_counter_that_went_down_is_flagged(self, w):
        out = order(w)
        answer(w, out["id"], counters={"before": {"z": 4, "320": 120}, "after": {"z": 4, "320": 1}})
        w.db.refresh(w.till)
        assert w.till.till_reset["result"]["countersLowered"] == [{"counter": "320", "before": 120, "after": 1}]
        (row,) = resets(w)
        assert "מונה ירד" in row.details["summary"]


class TestCountersNeverGoDown:
    def test_the_last_z_number_the_till_reports(self, w):
        beat_with(w, offlineTillZ={"pending": 0, "lastNumber": 5})
        beat_with(w, offlineTillZ={"pending": 0, "lastNumber": 3})
        w.db.refresh(w.till)
        assert w.till.offline_till_z_last_number == 5

    def test_the_document_counters_the_till_reports(self, w):
        beat_with(w, documentCounters={"320": 100, "330": 9})
        beat_with(w, documentCounters={"320": 50, "400": 2})
        w.db.refresh(w.till)
        assert w.till.reported_document_counters == {"320": 100, "330": 9, "400": 2}

    def test_a_machine_with_a_z_run_is_never_hard_deleted(self, w):
        till = w.tills[1]
        w.db.add(MachineZSequence(machine_id=till.id, last_number=2))
        w.db.commit()
        out = machines_router.delete_machine(str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id,
                                             db=w.db)
        assert out["mode"] == "soft"
        assert w.db.get(MachineZSequence, till.id).last_number == 2
        assert w.db.get(POSMachine, till.id) is not None

    def test_a_till_that_may_hold_unsynced_zs_is_not_deleted(self, w):
        beat_with(w, offlineTillZ={"pending": 1, "lastNumber": 1})
        resp = machines_router.delete_machine(str(w.till.id), current_user=w.admin, active_tenant_id=w.tenant.id,
                                              db=w.db)
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "till_offline_zs_unsynced"
        w.db.refresh(w.till)
        assert w.till.is_active

    def test_a_shop_with_a_z_run_is_not_deleted(self, w):
        w.db.add(ShopZSequence(shop_id=w.shop.id, next_value=8))
        w.db.commit()
        with pytest.raises(HTTPException) as refused:
            shops_router.delete_shop(str(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert refused.value.status_code == 409 and refused.value.detail["code"] == "shop_has_z_history"
        assert w.db.get(ShopZSequence, w.shop.id).next_value == 8

    def test_pure_rule(self):
        assert TR.counters_lowered({"z": 3, "320": 9}, {"z": 3, "320": 10}) == []
        assert TR.counters_lowered({"z": 3}, {"z": 2}) == [{"counter": "z", "before": 3, "after": 2}]
        assert TR.counters_lowered(None, {"z": 1}) == []
