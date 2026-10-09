"""
"תשלום לא מוכרע" — a card attempt whose result is unknown (app/services/card_attempt_commands.py,
app/services/failed_payments.py).

What each class pins:

* **The two new outcomes** — `unresolved` ("לא הוכרע") and `approved_late` ("אושר בבדיקה") are
  accepted, labelled, filterable; an unresolved row is replaced by its final outcome on a later
  upload; `unresolved` counts as an open, not-completed attempt and is listed first;
  `approved_late` is in no count or total — the dashboard's summary, the Z's paper, the kiosk
  insights, the exceptions log.
* **Commands** — only for an unresolved attempt with a vuid, to the till that made it; the
  people of a remote credit (a manager of that till; not another shop's, not a cashier); one
  pending at a time; withdrawn; who asked is kept and shown on the row.
* **The till** — the heartbeat's `pendingCardCommands` `[{commandId, vuid, action, requestedBy,
  requestedAt}]` (absent when none, only this till's, said until answered); the realtime wake-up;
  `POST /sync/{m}/card-commands/{id}/result`; 24 h expiry.
* **The migration** — a unique revision on the single head.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.card_attempt_command import CardAttemptCommand
from app.models.failed_payment import FailedPaymentAttempt
from app.routers import failed_payments as R
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.schemas.failed_payment import CardCommandIn, CardCommandResultIn
from app.services import ably_notify
from app.services import card_attempt_commands as CC
from app.services import failed_payments as svc
from shift_world import NOW
from test_failed_payments import FROM, TO, attempt, body, listed, push, section_of, z_of
from test_shop_areas import _ctx, refused, w  # noqa: F401

UNRESOLVED = dict(outcome="unresolved", resolvedAt=None, reasonMessage="Nayax bar: no answer", vuid="VU-77")


@pytest.fixture
def cw(w, monkeypatch):
    """The world, its tills online, the realtime wake-ups recorded."""
    w.woken = []
    monkeypatch.setattr(ably_notify, "is_enabled", lambda: True)
    monkeypatch.setattr(
        ably_notify, "publish_card_command_notify",
        lambda tenant_id, machine_id, command: w.woken.append((machine_id, command)),
    )
    now = datetime.now(timezone.utc)
    for till in (*w.tills, w.other_till):
        till.last_heartbeat_at = now - timedelta(seconds=10)
    w.db.commit()
    return w


def unresolved(w, till, **over):
    return attempt(w, till, **{**UNRESOLVED, **over})


def send(w, a, action="check", user=None, confirm=False):
    return R.create_card_command(
        a.id, CardCommandIn(action=action, confirmMismatch=confirm), **_ctx(w, user)
    )


def checked(w, till, a, verdict, **details):
    """A check sent and answered by the till with the terminal's [verdict]."""
    out = send(w, a)
    outcome = {"approved": "approved", "cancelled": "not_charged", "not_found": "not_charged"}.get(verdict, "unknown")
    answer(w, till, out["id"], status="done", outcome=outcome,
           details={"verdict": verdict, "checkedAt": datetime.now(timezone.utc).isoformat(), **details})
    return out


def beat(w, till):
    return machines_router.post_my_heartbeat(body=None, machine=till, db=w.db)


def answer(w, till, command_id, **data):
    return R.post_card_command_result(
        str(till.id), str(command_id), CardCommandResultIn.model_validate(data), machine=till, db=w.db
    )


def code_of(e):
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


def overrides(w):
    from app.models.audit_exception import AuditException

    w.db.expire_all()
    return w.db.query(AuditException).filter(AuditException.exception_type == "card_decision_override").all()


# ── The two new outcomes ─────────────────────────────────────────────────────


class TestOutcomes:
    def test_labels_and_the_explanation(self):
        assert svc.outcome_label("unresolved") == "לא הוכרע"
        assert svc.outcome_label("approved_late") == "אושר בבדיקה"
        assert svc.UNRESOLVED_EXPLANATION.startswith("תוצאת התשלום באשראי לא ידועה — ייתכן שהלקוח חויב.")

    def test_an_unresolved_row_is_replaced_by_its_final_outcome(self, cw):
        till = cw.tills[0]
        payload = body(**UNRESOLVED)
        code, out = push(cw, till, payload)
        assert (code, out.status) == (201, "accepted")
        row = cw.db.get(FailedPaymentAttempt, out.id)
        assert row.outcome == "unresolved" and row.resolved_at is None and row.vuid == "VU-77"
        sale = cw.doc(till, None, "140.00", method="card")
        cw.db.commit()
        later = (NOW + timedelta(minutes=5)).isoformat()
        code, out = push(cw, till, dict(
            payload, outcome="approved_late", resolvedAt=later, paidByTransactionId=str(sale.id),
            paidByMethod="card", paidAt=later, updatedAt=later,
        ))
        assert (code, out.status) == (200, "updated")
        cw.db.expire_all()
        row = cw.db.get(FailedPaymentAttempt, out.id)
        assert (row.outcome, row.paid_by_transaction_id, row.paid_by_method) == ("approved_late", sale.id, "card")
        assert cw.db.query(FailedPaymentAttempt).count() == 1

    def test_unresolved_counts_and_comes_first_approved_late_counts_nowhere(self, cw):
        till = cw.tills[0]
        s = cw.shift(till, 1)
        old = (NOW - timedelta(hours=2)).isoformat()
        stuck = unresolved(cw, till, shiftId=str(s.id), amountAgorot=5000, occurredAt=old, updatedAt=old)
        attempt(cw, till, shiftId=str(s.id), amountAgorot=14000)  # declined, newer
        attempt(cw, till, shiftId=str(s.id), amountAgorot=9900, outcome="approved_late",
                paidByTransactionId=str(uuid.uuid4()), paidByMethod="card")
        out = listed(cw, shift_id=s.id)
        assert out.items[0].id == stuck.id and out.items[0].outcome == "unresolved"
        summary = out.summary
        assert (summary.count, summary.total_agorot) == (2, 19000)
        assert summary.paid_later_count == 0
        assert (summary.unresolved_count, summary.unresolved_total_agorot) == (1, 5000)
        assert summary.approved_late_count == 1
        # The filter.
        only = listed(cw, shift_id=s.id, outcome="unresolved")
        assert [i.id for i in only.items] == [stuck.id]
        assert listed(cw, shift_id=s.id, outcome="approved_late").total == 1

    def test_the_z_paper_leaves_approved_late_out(self, cw):
        t1, t2 = cw.tills
        s1, s2 = cw.shift(t1, 1), cw.shift(t2, 1)
        z = z_of(cw, [t1, t2], [s1, s2])
        unresolved(cw, t1, shiftId=str(s1.id), amountAgorot=5000)
        attempt(cw, t1, shiftId=str(s1.id), amountAgorot=9900, outcome="approved_late",
                paidByTransactionId=str(uuid.uuid4()), paidByMethod="card")
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=cw.db)
        rows = [(r["label"], r["value"]) for r in section_of(doc, "עסקאות שלא הושלמו")["rows"]]
        assert rows[1] == ("מספר / סה״כ", "1 / ₪50.00")
        assert any("לא הוכרע" in label for label, _ in rows)
        assert not any("אושר בבדיקה" in label for label, _ in rows)

    def test_only_approved_late_means_no_section(self, cw):
        t1, t2 = cw.tills
        s1, s2 = cw.shift(t1, 1), cw.shift(t2, 1)
        z = z_of(cw, [t1, t2], [s1, s2])
        attempt(cw, t1, shiftId=str(s1.id), outcome="approved_late", paidByTransactionId=str(uuid.uuid4()), paidByMethod="card")
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=cw.db)
        assert section_of(doc, "עסקאות שלא הושלמו") is None

    def test_the_exceptions_log(self, cw):
        from app.services.exception_alerts import sources as SRC

        till = cw.tills[0]
        stuck = unresolved(cw, till)
        ctx = SRC.Ctx(cw.db)
        (spec,) = SRC.by_name("failed_payment").build(ctx, stuck)
        assert spec.severity == "high" and spec.summary.startswith("לא הוכרע")
        late = attempt(cw, till, outcome="approved_late", paidByTransactionId=str(uuid.uuid4()), paidByMethod="card")
        assert SRC.by_name("failed_payment").build(ctx, late) == []

    def test_the_all_in_one_summary(self, cw):
        from app.services.all_in_one import failed_payments_section  # noqa: F401 - uses svc.summarize

        till = cw.tills[0]
        attempt(cw, till, outcome="approved_late", paidByTransactionId=str(uuid.uuid4()), paidByMethod="card")
        q = svc.attempts_query(cw.db, cw.tenant.id, None, svc.Filters(from_date=FROM, to_date=TO))
        assert svc.summarize(q)["count"] == 0 and svc.summarize(q)["approvedLateCount"] == 1


# ── Commands from the dashboard ──────────────────────────────────────────────


class TestCommands:
    def test_a_manager_sends_a_check_to_the_till_of_the_row(self, cw):
        till = cw.tills[0]
        a = unresolved(cw, till)
        out = send(cw, a, "check", user=cw.manager)
        assert out["action"] == "check" and out["status"] == "pending" and out["statusLabel"] == "נשלח לקופה"
        assert out["machineId"] == str(till.id) and out["vuid"] == "VU-77"
        assert out["requestedByName"] == "manager" and out["requestedAt"]
        cmd = cw.db.get(CardAttemptCommand, uuid.UUID(out["id"]))
        assert cmd.requested_by_user_id == cw.manager.id and cmd.failed_payment_attempt_id == a.id
        # Woken at once (online), with the heartbeat's item.
        assert cw.woken == [(str(till.id), {
            "commandId": out["id"], "vuid": "VU-77", "action": "check",
            "requestedBy": "manager", "requestedAt": out["requestedAt"],
        })]
        cw.db.expire_all()
        assert cw.db.get(CardAttemptCommand, cmd.id).delivered_at is not None
        # Shown on the row.
        row = listed(cw, from_date=FROM, to_date=TO).items[0]
        assert row.card_command["id"] == out["id"] and row.card_command["requestedByName"] == "manager"

    @pytest.mark.parametrize("action,verdict,label", [
        ("mark_approved", "approved", "אשר והכנס את העסקה"),
        ("mark_not_approved", "cancelled", "בטל"),
        ("mark_not_approved", "not_found", "בטל"),
    ])
    def test_a_decision_that_agrees_with_the_check_goes_straight(self, cw, action, verdict, label):
        till = cw.tills[0]
        a = unresolved(cw, till)
        check = checked(cw, till, a, verdict)
        out = send(cw, a, action, user=cw.company_manager)
        assert (out["action"], out["actionLabel"], out["isDecision"]) == (action, label, True)
        assert (out["status"], out["statusLabel"]) == ("pending", "ממתין לקופה")
        assert (out["verdictAtDecision"], out["checkCommandId"], out["mismatchConfirmed"]) == (verdict, check["id"], False)
        assert out["expiresAt"] is None
        assert overrides(cw) == []

    @pytest.mark.parametrize("action,verdict", [
        ("mark_approved", "cancelled"),
        ("mark_approved", "not_found"),
        ("mark_approved", "unknown"),
        ("mark_not_approved", "approved"),
        ("mark_not_approved", "unknown"),
        ("mark_approved", None),
        ("mark_not_approved", None),
    ])
    def test_a_decision_against_the_check_needs_the_managers_confirmation(self, cw, action, verdict):
        till = cw.tills[0]
        a = unresolved(cw, till)
        check = checked(cw, till, a, verdict, terminalUid="UID-9") if verdict else None
        e = refused(send, cw, a, action)
        assert (e.status_code, code_of(e)) == (409, "card_decision_mismatch")
        assert e.detail["verdict"] == (verdict or "not_checked")
        assert e.detail["verdictLabel"] == CC.VERDICT_LABELS_HE[verdict or "not_checked"]
        assert e.detail["checkCommandId"] == (check["id"] if check else None)
        if check:
            assert e.detail["details"]["terminalUid"] == "UID-9"
        assert cw.db.query(CardAttemptCommand).filter(CardAttemptCommand.action != "check").count() == 0
        out = send(cw, a, action, user=cw.manager, confirm=True)
        assert out["mismatchConfirmed"] is True and out["verdictAtDecision"] == (verdict or "not_checked")
        # Kept in the exceptions log too: who, when, the verdict, the decision.
        (ae,) = overrides(cw)
        assert ae.machine_id == till.id and ae.severity == "high" and ae.amount == Decimal("140.00")
        assert ae.details["commandId"] == out["id"] and ae.details["requestedByName"] == "manager"
        assert ae.details["verdict"] == (verdict or "not_checked") and ae.details["action"] == action
        assert "בניגוד לבדיקה במסוף" in ae.details["summary"]

    def test_the_latest_answered_check_counts(self, cw):
        till = cw.tills[0]
        a = unresolved(cw, till)
        checked(cw, till, a, "unknown")
        checked(cw, till, a, "approved")
        assert send(cw, a, "mark_approved")["mismatchConfirmed"] is False

    def test_a_decision_replaces_a_pending_check(self, cw):
        till = cw.tills[0]
        a = unresolved(cw, till)
        check = send(cw, a)
        out = send(cw, a, "mark_not_approved", user=cw.manager, confirm=True)
        cw.db.expire_all()
        assert cw.db.get(CardAttemptCommand, uuid.UUID(check["id"])).status == "cancelled"
        assert [i["commandId"] for i in beat(cw, till)["pendingCardCommands"]] == [out["id"]]
        # A pending decision blocks another command until withdrawn.
        assert code_of(refused(send, cw, a)) == "card_command_pending"
        assert code_of(refused(send, cw, a, "mark_approved", confirm=True)) == "card_command_pending"

    def test_only_reports_edit_may_check_or_decide(self):
        """"הרשאות דשבורד": the decision and the check are edits of "דוחות" (`reports`); reading is the list's."""
        from app.services import dashboard_sections as DS

        for path in ("/failed-payments/{attempt_id}/card-commands", "/failed-payments/card-commands/{command_id}/cancel"):
            rule = DS.rule_for("POST", path)
            assert (rule.kind, rule.sections, rule.needed_level("POST")) == ("section", ("reports",), "edit")
        rule = DS.rule_for("GET", "/failed-payments/{attempt_id}/card-commands")
        # Reading is the list's: whoever reads `GET /failed-payments` (reports, Z — and since the
        # cockpit's review fixes, "הניהול שלי") reads a payment's commands, at view.
        listing = DS.rule_for("GET", "/failed-payments")
        assert (rule.sections, rule.needed_level("GET")) == (listing.sections, "view")
        assert {"reports", "z"} <= set(rule.sections)

    def test_only_an_unresolved_attempt_with_a_vuid(self, cw):
        till = cw.tills[0]
        declined = attempt(cw, till)
        e = refused(send, cw, declined)
        assert (e.status_code, code_of(e)) == (409, "attempt_not_unresolved")
        late = attempt(cw, till, outcome="approved_late")
        assert code_of(refused(send, cw, late)) == "attempt_not_unresolved"
        blind = unresolved(cw, till, vuid=None)
        assert code_of(refused(send, cw, blind)) == "attempt_without_vuid"
        assert cw.db.query(CardAttemptCommand).count() == 0

    def test_who_may(self, cw):
        a = unresolved(cw, cw.tills[0])
        assert refused(send, cw, a, user=cw.north_manager).status_code in (403, 404)
        # A cashier never gets past the route's role dependency (owner / manager roles).
        from app.middleware.auth import get_current_machine_admin

        assert refused(get_current_machine_admin, cw.cashier).status_code == 403
        assert get_current_machine_admin(cw.manager) is cw.manager
        assert refused(R.create_card_command, uuid.uuid4(), CardCommandIn(action="check"), **_ctx(cw)).status_code == 404
        assert cw.db.query(CardAttemptCommand).count() == 0

    def test_one_pending_at_a_time_and_withdrawing_it(self, cw):
        a = unresolved(cw, cw.tills[0])
        first = send(cw, a)
        e = refused(send, cw, a, "check")
        assert (e.status_code, code_of(e)) == (409, "card_command_pending")
        gone = R.cancel_card_command(uuid.UUID(first["id"]), **_ctx(cw, cw.manager))
        assert gone["status"] == "cancelled" and gone["cancelledByName"] == "manager"
        assert code_of(refused(R.cancel_card_command, uuid.UUID(first["id"]), **_ctx(cw))) == "card_command_not_pending"
        second = send(cw, a, "mark_not_approved", confirm=True)
        # A pending decision may be withdrawn too.
        assert R.cancel_card_command(uuid.UUID(second["id"]), **_ctx(cw))["status"] == "cancelled"
        second = send(cw, a, "mark_not_approved", confirm=True)
        history = R.list_card_commands(a.id, **_ctx(cw))["items"]
        assert [c["id"] for c in history][0] == second["id"] and history[-1]["id"] == first["id"]
        assert len(history) == 3
        assert refused(R.cancel_card_command, uuid.UUID(second["id"]), **_ctx(cw, cw.north_manager)).status_code in (403, 404)

    def test_an_offline_till_is_not_woken_but_gets_it_on_its_beat(self, cw):
        till = cw.tills[0]
        till.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=3)
        cw.db.commit()
        send(cw, unresolved(cw, till))
        assert cw.woken == []
        assert len(beat(cw, till)["pendingCardCommands"]) == 1


# ── The till ─────────────────────────────────────────────────────────────────


class TestTill:
    def test_the_heartbeat_says_it_until_answered(self, cw):
        t1, t2 = cw.tills
        assert "pendingCardCommands" not in beat(cw, t1)
        out = send(cw, unresolved(cw, t1))
        items = beat(cw, t1)["pendingCardCommands"]
        assert items == [{
            "commandId": out["id"], "vuid": "VU-77", "action": "check",
            "requestedBy": "admin", "requestedAt": out["requestedAt"],
        }]
        # Only to that till.
        assert "pendingCardCommands" not in beat(cw, t2)
        assert beat(cw, t1)["pendingCardCommands"] == items
        res = answer(cw, t1, out["id"], status="done", outcome="approved", message="אושר במסוף 123456")
        assert res["status"] == "done" and res["outcome"] == "approved" and res["answeredAt"]
        assert "pendingCardCommands" not in beat(cw, t1)
        row = listed(cw, from_date=FROM, to_date=TO).items[0].card_command
        assert (row["status"], row["statusLabel"], row["resultOutcome"], row["resultLabel"]) == ("done", "בוצע", "approved", "אושר")
        assert row["resultMessage"] == "אושר במסוף 123456"

    def test_a_repeated_answer_keeps_the_first(self, cw):
        till = cw.tills[0]
        out = send(cw, unresolved(cw, till))
        answer(cw, till, out["id"], status="busy", message="באמצע עסקה")
        again = answer(cw, till, out["id"], status="done", outcome="not_charged")
        assert again["status"] == "busy"

    def test_another_tills_command_is_unknown(self, cw):
        t1, t2 = cw.tills
        out = send(cw, unresolved(cw, t1))
        e = refused(answer, cw, t2, out["id"], status="done")
        assert (e.status_code, code_of(e)) == (404, "unknown_command")
        assert code_of(refused(answer, cw, t1, uuid.uuid4(), status="done")) == "unknown_command"
        with pytest.raises(Exception):
            CardCommandResultIn.model_validate({"status": "pending"})
        with pytest.raises(Exception):
            CardCommandResultIn.model_validate({"status": "done", "outcome": "maybe"})

    def test_a_pending_check_expires_after_a_day(self, cw):
        till = cw.tills[0]
        out = send(cw, unresolved(cw, till))
        cmd = cw.db.get(CardAttemptCommand, uuid.UUID(out["id"]))
        assert CC.TTL_HOURS == 24
        assert out["expiresAt"] is not None
        cmd.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        cw.db.commit()
        assert "pendingCardCommands" not in beat(cw, till)
        cw.db.expire_all()
        assert cw.db.get(CardAttemptCommand, cmd.id).status == "expired"
        # The till's late answer is still taken: it may have acted before it heard.
        assert answer(cw, till, out["id"], status="done", outcome="not_charged")["status"] == "done"

    def test_a_decision_waits_for_an_offline_till_however_long(self, cw):
        till = cw.tills[0]
        till.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(days=3)
        cw.db.commit()
        a = unresolved(cw, till)
        out = send(cw, a, "mark_approved", user=cw.manager, confirm=True)
        cmd = cw.db.get(CardAttemptCommand, uuid.UUID(out["id"]))
        assert cmd.expires_at is None and cw.woken == []
        # A week later, nothing expired it.
        cmd.requested_at = datetime.now(timezone.utc) - timedelta(days=7)
        cw.db.commit()
        CC.expire_overdue(cw.db)
        row = listed(cw, from_date=FROM, to_date=TO).items[0].card_command
        assert (row["status"], row["statusLabel"], row["deliveredAt"]) == ("pending", "ממתין לקופה", None)
        # The till comes back: it takes it on its beat, does it, and says so.
        assert [i["action"] for i in beat(cw, till)["pendingCardCommands"]] == ["mark_approved"]
        answer(cw, till, out["id"], status="done", outcome="approved", message="נקלט כמכירה")
        row = listed(cw, from_date=FROM, to_date=TO).items[0].card_command
        assert (row["status"], row["statusLabel"]) == ("done", "בוצע")
        assert row["requestedByName"] == "manager" and row["requestedAt"] and row["answeredAt"] and row["deliveredAt"]

    def test_a_checks_details_are_stored_and_shown(self, cw):
        till = cw.tills[0]
        a = unresolved(cw, till)
        out = send(cw, a)
        answer(cw, till, out["id"], status="done", outcome="approved", details={
            "verdict": "approved", "terminalUid": "  25081612345678901 ", "at": "2026-10-08T09:41:00+03:00",
            "amountAgorot": 14000, "last4": "4580", "authNumber": "0123456", "brand": "visa",
            "checkedAt": "2026-10-08T10:00:00Z", "pan": "4580123412341234",
        })
        cmd = cw.db.get(CardAttemptCommand, uuid.UUID(out["id"]))
        assert cmd.details == {
            "verdict": "approved", "terminalUid": "25081612345678901", "at": "2026-10-08T09:41:00+03:00",
            "amountAgorot": 14000, "last4": "4580", "authNumber": "0123456", "brand": "visa",
            "checkedAt": "2026-10-08T10:00:00Z",
        }
        item = listed(cw, from_date=FROM, to_date=TO).items[0]
        for shown in (item.card_command, item.card_check):
            assert shown["id"] == out["id"] and shown["verdict"] == "approved"
            assert shown["verdictLabel"] == "אושר במסוף" and shown["details"]["amountAgorot"] == 14000
        # A decision after it: the row keeps showing the check.
        decision = send(cw, a, "mark_approved")
        item = listed(cw, from_date=FROM, to_date=TO).items[0]
        assert item.card_command["id"] == decision["id"] and item.card_check["id"] == out["id"]
        # Of the card only the last four digits.
        assert CardCommandResultIn.model_validate(
            {"status": "done", "details": {"verdict": "cancelled", "last4": "12345"}}
        ).details.stored() == {"verdict": "cancelled"}
        with pytest.raises(Exception):
            CardCommandResultIn.model_validate({"status": "done", "details": {"verdict": "maybe"}})

    def test_the_route_is_a_guarded_till_write(self):
        from app.main import app

        paths = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set())}
        assert ("POST", "/api/v1/sync/{machine_id}/card-commands/{command_id}/result") in paths
        assert ("POST", "/api/v1/failed-payments/{attempt_id}/card-commands") in paths


# ── The migration ────────────────────────────────────────────────────────────


def test_the_migration_is_a_unique_revision_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    revision = "5e1c9b7d3a80"
    declaring = [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]
    assert declaring == [f"{revision}_card_attempt_commands.py"]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision(revision).down_revision == "3b8f6d2a9c41"
    text = (root / "alembic" / "versions" / f"{revision}_card_attempt_commands.py").read_text(encoding="utf-8")
    assert "has_table(TABLE)" in text and "ck_card_attempt_commands_status" in text
    # The cloud's decision: the check's answer, decisions that wait, the confirmation.
    later = "8c4a2f6e1b93"
    assert [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{later}['\"]", p.read_text(encoding="utf-8"), re.M)
    ] == [f"{later}_card_decision_in_the_cloud.py"]
    assert later in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision(later).down_revision == revision
    text = (root / "alembic" / "versions" / f"{later}_card_decision_in_the_cloud.py").read_text(encoding="utf-8")
    for column in ("details", "verdict_at_decision", "check_command_id", "mismatch_confirmed"):
        assert f"'{column}'" in text
    assert "nullable=True" in text and "if name not in columns" in text
