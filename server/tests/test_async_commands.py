"""
"פקודות שנשלחו" — every command the dashboard sends to a device is fire-and-forget
(app/services/command_idempotency.py; the owner: "שליחת פקודה תשלח פקודה ותקרא ברקע").

Each test names a way it could look fine and still fail the owner:

* a send that waits for the device (the dashboard would block on "ממתין לתגובה מהקופה");
* a status that never moves in the background read (נשלח → התקבל במכשיר → בוצע / נכשל / פג תוקף);
* a retry ("נסה שוב", a dropped connection, a double click) that sends the command twice;
* a key reused for another request, or another user's key, answered with someone else's command;
* the background read showing a command of a device the user may not control;
* card recovery ("בדוק במסוף" / "אשר והכנס" / "בטל"): a retry making a second command, or the
  key bypassing a rule — the mismatch confirmation, one pending command per attempt, who may act.
"""
from __future__ import annotations

import time
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException, Response

from app.database import Base
from app.models.card_attempt_command import CardAttemptCommand
from app.models.command_request_key import CommandRequestKey
from app.models.device_command import DeviceCommand
from app.routers import device_commands as R
from app.routers import failed_payments as FP
from app.schemas.failed_payment import CardCommandIn
from app.services import command_idempotency as idem
from app.services import device_commands as svc

from test_card_attempt_commands import answer, cw, unresolved  # noqa: F401
from test_device_commands import d  # noqa: F401
from test_kitchen_printers import k  # noqa: F401
from test_product_availability import world  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _keys_table(db):
    if not db.get_bind().dialect.has_table(db.connection(), "command_request_keys"):
        Base.metadata.tables["command_request_keys"].create(db.get_bind())


@pytest.fixture
def dk(d):  # noqa: F811
    _keys_table(d.db)
    return d


@pytest.fixture
def ck(cw):  # noqa: F811
    _keys_table(cw.db)
    return cw


def send(w, action, user=None, key=None, response=None, **kw):
    body = R.CommandIn(action=action, **kw)
    return R.create_commands(
        body, current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
        response=response, idempotency_key=key,
    )


def status_of(w, ids, user=None):
    return R.get_commands_status(
        ids=[uuid.UUID(i) for i in ids], current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db,
    )["items"]


def code_of(e):
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


# ── Device commands: fire-and-forget ─────────────────────────────────────────


class TestDeviceCommandsAreFireAndForget:
    def test_a_send_returns_at_once_with_the_id_and_sent(self, dk):
        started = time.monotonic()
        out = send(dk, "sync_now", machineIds=[dk.h1.id], key="k-sync-000001")
        assert time.monotonic() - started < 2.0
        assert len(out) == 1 and out[0]["id"] and out[0]["status"] == "pending"
        # The device is only woken; nothing was delivered or answered on its behalf.
        assert dk.woken == [str(dk.h1.id)]
        row = dk.db.get(DeviceCommand, uuid.UUID(out[0]["id"]))
        assert row.status == "pending" and row.delivered_at is None and row.done_at is None

    def test_the_background_read_follows_every_step(self, dk):
        (cmd,) = send(dk, "restart_app", machineIds=[dk.h1.id])
        assert [c["status"] for c in status_of(dk, [cmd["id"]])] == ["pending"]
        svc.pull(dk.db, dk.h1)
        dk.db.commit()
        assert [c["status"] for c in status_of(dk, [cmd["id"]])] == ["delivered"]
        R.till_ack(str(dk.h1.id), cmd["id"], R.AckIn(status="done"), machine=dk.h1, db=dk.db)
        (done,) = status_of(dk, [cmd["id"]])
        assert done["status"] == "done" and done["doneAt"]

    def test_a_refusal_and_an_expiry_reach_the_background_read(self, dk):
        (a,) = send(dk, "install_update", machineIds=[dk.h1.id])
        (b,) = send(dk, "sync_now", machineIds=[dk.h2.id])
        svc.pull(dk.db, dk.h1)
        dk.db.commit()
        R.till_ack(str(dk.h1.id), a["id"], R.AckIn(status="refused", detail="sale_in_progress"), machine=dk.h1, db=dk.db)
        row = dk.db.get(DeviceCommand, uuid.UUID(b["id"]))
        row.expires_at = row.created_at - timedelta(seconds=1)
        dk.db.commit()
        got = {c["id"]: (c["status"], c["detail"]) for c in status_of(dk, [a["id"], b["id"]])}
        assert got == {a["id"]: ("refused", "sale_in_progress"), b["id"]: ("expired", None)}

    def test_several_commands_at_once_to_the_same_device_and_others(self, dk):
        first = send(dk, "sync_now", machineIds=[dk.h1.id])
        second = send(dk, "refresh_catalog", machineIds=[dk.h1.id, dk.h2.id])
        ids = [c["id"] for c in first + second]
        assert len(set(ids)) == 3
        assert {c["status"] for c in status_of(dk, ids)} == {"pending"}

    def test_the_background_read_leaves_out_another_shops_devices(self, dk):
        (cmd,) = send(dk, "sync_now", machineIds=[dk.h1.id])
        assert status_of(dk, [cmd["id"]], user=dk.users.a_shop_manager) == []
        assert [c["id"] for c in status_of(dk, [cmd["id"]], user=dk.users.h_shop_manager)] == [cmd["id"]]

    def test_the_background_read_is_a_device_control_view(self):
        from app.services import dashboard_sections as DS

        rule = DS.rule_for("GET", "/device-commands/status")
        assert rule.sections == ("device_control",) and rule.needed_level("GET") == "view"


# ── Device commands: never twice ─────────────────────────────────────────────


class TestDeviceCommandsNeverTwice:
    def test_a_retry_with_the_same_key_gets_the_same_commands(self, dk):
        resp = Response()
        first = send(dk, "sync_now", shopId=dk.h_shop.id, key="retry-key-0001")
        again = send(dk, "sync_now", shopId=dk.h_shop.id, key="retry-key-0001", response=resp)
        assert [c["id"] for c in again] == [c["id"] for c in first]
        assert resp.headers.get(idem.REPLAY_HEADER) == "true"
        assert dk.db.query(DeviceCommand).count() == len(first)
        # Woken once only, for the first request.
        assert sorted(dk.woken) == sorted(c["machineId"] for c in first)

    def test_without_a_key_each_request_is_its_own_command(self, dk):
        send(dk, "sync_now", machineIds=[dk.h1.id])
        send(dk, "sync_now", machineIds=[dk.h1.id])
        assert dk.db.query(DeviceCommand).count() == 2

    def test_a_key_reused_for_another_request_is_refused(self, dk):
        send(dk, "sync_now", machineIds=[dk.h1.id], key="reuse-key-0001")
        e = refused(send, dk, "restart_app", machineIds=[dk.h1.id], key="reuse-key-0001")
        assert (e.status_code, code_of(e)) == (422, "idempotency_key_reused")
        assert dk.db.query(DeviceCommand).count() == 1

    def test_another_users_key_is_never_answered_with_this_ones(self, dk):
        send(dk, "sync_now", machineIds=[dk.h1.id], key="shared-key-001")
        e = refused(send, dk, "sync_now", user=dk.users.h_shop_manager, machineIds=[dk.h1.id], key="shared-key-001")
        assert (e.status_code, code_of(e)) == (409, "idempotency_key_in_use")
        assert dk.db.query(DeviceCommand).count() == 1

    def test_a_malformed_key_is_refused_before_anything_is_sent(self, dk):
        e = refused(send, dk, "sync_now", machineIds=[dk.h1.id], key="bad key!")
        assert (e.status_code, code_of(e)) == (422, "idempotency_key_invalid")
        assert dk.db.query(DeviceCommand).count() == 0

    def test_permissions_come_first_a_key_never_lets_anyone_through(self, dk):
        e = refused(send, dk, "lock", user=dk.users.a_shop_manager, machineIds=[dk.h1.id], key="perm-key-0001")
        assert e.status_code == 403
        assert dk.db.query(DeviceCommand).count() == 0 and dk.db.query(CommandRequestKey).count() == 0

    def test_a_racing_twin_is_rolled_back_and_answered_with_the_first(self, dk, monkeypatch):
        first = send(dk, "sync_now", machineIds=[dk.h1.id], key="race-key-0001")
        real_find = idem.find
        calls = {"n": 0}

        def miss_once(*a, **k):
            calls["n"] += 1
            return None if calls["n"] == 1 else real_find(*a, **k)

        # The twin did not see the first request's key (it was not committed yet when it looked).
        monkeypatch.setattr(idem, "find", miss_once)
        again = send(dk, "sync_now", machineIds=[dk.h1.id], key="race-key-0001")
        assert [c["id"] for c in again] == [c["id"] for c in first]
        assert dk.db.query(DeviceCommand).count() == 1

    def test_an_old_key_is_forgotten_after_a_day(self, dk):
        send(dk, "sync_now", machineIds=[dk.h1.id], key="old-key-00001")
        row = dk.db.query(CommandRequestKey).one()
        row.created_at = row.created_at - idem.KEEP_FOR - timedelta(minutes=1)
        dk.db.commit()
        send(dk, "sync_now", machineIds=[dk.h1.id], key="old-key-00001")
        assert dk.db.query(DeviceCommand).count() == 2


# ── Card recovery: the waiting changes, the money rules do not ────────────────


def card_send(w, a, action="check", user=None, confirm=False, key=None, response=None):
    return FP.create_card_command(
        a.id, CardCommandIn(action=action, confirmMismatch=confirm), **_ctx(w, user),
        response=response, idempotency_key=key,
    )


def card_status(w, ids, user=None):
    return FP.get_card_commands_status(ids=[uuid.UUID(i) for i in ids], **_ctx(w, user))["items"]


class TestCardCommands:
    def test_a_check_returns_at_once_and_its_answer_arrives_in_the_background(self, ck):
        till = ck.tills[0]
        a = unresolved(ck, till)
        started = time.monotonic()
        out = card_send(ck, a, "check", key="card-key-0001")
        assert time.monotonic() - started < 2.0
        assert out["status"] == "pending" and out["statusLabel"] == "נשלח לקופה"
        (before,) = card_status(ck, [out["id"]])
        assert before["status"] == "pending" and before["answeredAt"] is None
        answer(ck, till, out["id"], status="done", outcome="approved", details={"verdict": "approved", "checkedAt": "2026-10-09T08:00:00+00:00"})
        (after,) = card_status(ck, [out["id"]])
        assert (after["status"], after["verdict"]) == ("done", "approved")

    def test_a_retry_never_makes_a_second_card_command(self, ck):
        a = unresolved(ck, ck.tills[0])
        resp = Response()
        first = card_send(ck, a, "check", key="card-retry-001")
        again = card_send(ck, a, "check", key="card-retry-001", response=resp)
        assert again["id"] == first["id"] and resp.headers.get(idem.REPLAY_HEADER) == "true"
        assert ck.db.query(CardAttemptCommand).count() == 1
        # Woken once only.
        assert len(ck.woken) == 1

    def test_without_a_key_the_one_pending_rule_still_refuses_a_second(self, ck):
        a = unresolved(ck, ck.tills[0])
        card_send(ck, a, "check")
        assert code_of(refused(card_send, ck, a, "check")) == "card_command_pending"
        # A new key is a new request: the same rule refuses it.
        assert code_of(refused(card_send, ck, a, "check", key="card-new-0001")) == "card_command_pending"
        assert ck.db.query(CardAttemptCommand).count() == 1

    def test_the_mismatch_confirmation_is_still_required_with_a_key(self, ck):
        a = unresolved(ck, ck.tills[0])
        e = refused(card_send, ck, a, "mark_approved", key="card-decide-01")
        assert (e.status_code, code_of(e)) == (409, "card_decision_mismatch")
        assert ck.db.query(CardAttemptCommand).count() == 0 and ck.db.query(CommandRequestKey).count() == 0
        # The confirmed decision is another request: its own key.
        out = card_send(ck, a, "mark_approved", user=ck.manager, confirm=True, key="card-decide-02")
        assert out["mismatchConfirmed"] is True and out["status"] == "pending"
        # Reusing the first key for the confirmed request is refused, never silently replayed.
        e = refused(card_send, ck, a, "mark_approved", confirm=True, key="card-decide-01")
        assert code_of(e) in ("card_command_pending", "idempotency_key_reused")
        assert ck.db.query(CardAttemptCommand).count() == 1

    def test_who_may_act_is_unchanged(self, ck):
        a = unresolved(ck, ck.tills[0])
        assert refused(card_send, ck, a, user=ck.north_manager, key="card-north-01").status_code in (403, 404)
        assert ck.db.query(CardAttemptCommand).count() == 0 and ck.db.query(CommandRequestKey).count() == 0

    def test_the_background_read_leaves_out_attempts_the_user_does_not_see(self, ck):
        a = unresolved(ck, ck.tills[0])
        out = card_send(ck, a, "check")
        assert card_status(ck, [out["id"]], user=ck.north_manager) == []
        assert [c["id"] for c in card_status(ck, [out["id"]], user=ck.manager)] == [out["id"]]

    def test_the_background_read_is_a_reports_view(self):
        from app.services import dashboard_sections as DS

        rule = DS.rule_for("GET", "/failed-payments/card-commands/status")
        assert "reports" in rule.sections and rule.needed_level("GET") == "view"


# ── Review fixes: housekeeping, read-only polls, replays as they are now ─────


class TestReviewFixes:
    def test_a_failing_prune_never_loses_the_command_or_its_key(self, dk, monkeypatch):
        from sqlalchemy.exc import OperationalError

        def boom(*a, **k):
            raise OperationalError("DELETE FROM command_request_keys", {}, Exception("prune failed"))

        monkeypatch.setattr(idem, "prune", boom)
        (cmd,) = send(dk, "sync_now", machineIds=[dk.h1.id], key="prune-key-001")
        dk.db.expire_all()
        row = dk.db.get(DeviceCommand, uuid.UUID(cmd["id"]))
        assert row is not None and row.status == "pending"
        assert dk.db.query(CommandRequestKey).count() == 1
        assert dk.woken == [str(dk.h1.id)]
        # And the key still protects: a retry gets the same command.
        again = send(dk, "sync_now", machineIds=[dk.h1.id], key="prune-key-001")
        assert [c["id"] for c in again] == [cmd["id"]] and dk.db.query(DeviceCommand).count() == 1

    def test_old_keys_are_pruned_after_the_commit(self, dk):
        send(dk, "sync_now", machineIds=[dk.h1.id], key="ancient-key-01")
        old = dk.db.query(CommandRequestKey).one()
        old.created_at = old.created_at - 3 * idem.KEEP_FOR
        dk.db.commit()
        send(dk, "sync_now", machineIds=[dk.h2.id], key="fresh-key-0001")
        assert [r.key for r in dk.db.query(CommandRequestKey).all()] == ["fresh-key-0001"]

    def test_the_status_read_writes_nothing(self, dk):
        (late,) = send(dk, "sync_now", machineIds=[dk.h1.id])
        (other,) = send(dk, "sync_now", machineIds=[dk.h2.id])
        for ident in (late["id"], other["id"]):
            row = dk.db.get(DeviceCommand, uuid.UUID(ident))
            row.expires_at = row.created_at - timedelta(seconds=1)
        dk.db.commit()
        (read,) = status_of(dk, [late["id"]])
        assert read["status"] == "expired"
        dk.db.expire_all()
        # Not written: neither the one asked about, nor another device's.
        assert dk.db.get(DeviceCommand, uuid.UUID(late["id"])).status == "pending"
        assert dk.db.get(DeviceCommand, uuid.UUID(other["id"])).status == "pending"

    def test_a_poll_never_overwrites_the_devices_answer(self, dk):
        (cmd,) = send(dk, "restart_app", machineIds=[dk.h1.id])
        svc.pull(dk.db, dk.h1)
        dk.db.commit()
        row = dk.db.get(DeviceCommand, uuid.UUID(cmd["id"]))
        row.delivered_at = row.delivered_at - timedelta(minutes=11)  # past restart's 10 minutes
        dk.db.commit()
        assert [(c["status"], c["detail"]) for c in status_of(dk, [cmd["id"]])] == [("expired", "not_answered")]
        # The till's late "done" still lands (the poll wrote nothing to race it).
        R.till_ack(str(dk.h1.id), cmd["id"], R.AckIn(status="done"), machine=dk.h1, db=dk.db)
        assert [c["status"] for c in status_of(dk, [cmd["id"]])] == ["done"]

    def test_a_replay_reads_the_commands_as_they_are_now(self, dk):
        (cmd,) = send(dk, "sync_now", machineIds=[dk.h1.id], key="replay-now-001")
        svc.pull(dk.db, dk.h1)
        dk.db.commit()
        R.till_ack(str(dk.h1.id), cmd["id"], R.AckIn(status="done"), machine=dk.h1, db=dk.db)
        (again,) = send(dk, "sync_now", machineIds=[dk.h1.id], key="replay-now-001")
        assert (again["id"], again["status"]) == (cmd["id"], "done")

    def test_the_key_always_has_a_tenant_and_kiosks_need_no_key(self):
        assert CommandRequestKey.__table__.c.tenant_id.nullable is False
        assert "kiosk_command" not in idem.KINDS

    def test_a_card_status_read_writes_nothing(self, ck):
        a = unresolved(ck, ck.tills[0])
        out = card_send(ck, a, "check")
        row = ck.db.get(CardAttemptCommand, uuid.UUID(out["id"]))
        row.expires_at = row.requested_at - timedelta(seconds=1)
        ck.db.commit()
        (read,) = card_status(ck, [out["id"]])
        assert read["status"] == "expired"
        ck.db.expire_all()
        assert ck.db.get(CardAttemptCommand, uuid.UUID(out["id"])).status == "pending"

    def test_a_card_replay_reads_the_command_as_it_is_now(self, ck):
        till = ck.tills[0]
        a = unresolved(ck, till)
        first = card_send(ck, a, "check", key="card-now-0001")
        answer(ck, till, first["id"], status="done", outcome="approved",
               details={"verdict": "approved", "checkedAt": "2026-10-09T08:00:00+00:00"})
        again = card_send(ck, a, "check", key="card-now-0001")
        assert (again["id"], again["status"], again["verdict"]) == (first["id"], "done", "approved")
        assert ck.db.query(CardAttemptCommand).count() == 1


class TestPrinterTest:
    def test_a_retry_never_prints_a_second_test_page_and_reads_the_jobs_now(self, k):  # noqa: F811
        from fastapi import BackgroundTasks

        from app.models.printers import KitchenPrintJob
        from app.routers import printers as PR
        from test_kitchen_printers import create

        _keys_table(k.db)
        printer = create(k, name="Kitchen")["id"]
        first = PR.test_printer(uuid.UUID(printer), BackgroundTasks(), **_ctx(k), response=None, idempotency_key="print-key-0001")
        count = k.db.query(KitchenPrintJob).count()
        job = k.db.get(KitchenPrintJob, uuid.UUID(first["jobs"][0]["id"]))
        job.status = "done"
        k.db.commit()
        tasks = BackgroundTasks()
        again = PR.test_printer(uuid.UUID(printer), tasks, **_ctx(k), response=None, idempotency_key="print-key-0001")
        assert [j["id"] for j in again["jobs"]] == [j["id"] for j in first["jobs"]]
        assert again["jobs"][0]["status"] == "done"
        assert k.db.query(KitchenPrintJob).count() == count and tasks.tasks == []


# ── Till messages: never twice ───────────────────────────────────────────────


class TestTillMessages:
    def _send(self, w, key, body="מבצע היום!", user=None):
        from fastapi import BackgroundTasks

        from app.routers import till_messages as TMR
        from app.schemas.till_message import TillMessageCreate

        tasks = BackgroundTasks()
        out = TMR.send_till_message(
            TillMessageCreate(body=body, targetLevel="shop", targetId=w.shop.id),
            tasks, **_ctx(w, user), response=None, idempotency_key=key,
        )
        return out, len(tasks.tasks)

    def test_a_retry_never_sends_the_message_twice(self, w):  # noqa: F811
        from app.models.till_message import TillMessage

        _keys_table(w.db)
        first, woke = self._send(w, "msg-key-00001")
        again, woke_again = self._send(w, "msg-key-00001")
        assert again["id"] == first["id"] and w.db.query(TillMessage).count() == 1
        assert (woke, woke_again) == (1, 0)
        other, _ = self._send(w, "msg-key-00002")
        assert other["id"] != first["id"] and w.db.query(TillMessage).count() == 2


# ── The migration ────────────────────────────────────────────────────────────


def test_the_migration_is_a_unique_revision_on_the_single_head():
    import pathlib
    import re

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    revision = "c8a1e5f3d9b7"
    declaring = [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]
    assert declaring == [f"{revision}_command_request_keys.py"]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
