"""
"שליטה מרחוק בקופות וקיוסקים" — remote commands with delivery and acknowledgement
(app/services/device_commands.py, app/routers/device_commands.py), and the kiosks' live panel:
a banner and quick hides over the effective config (app/services/kiosk_live.py).

Each test names a way it could look fine and still fail the owner:

* a lock that a till which missed the push never applies (the lock is a state, not just a message);
* a stale lock command re-locking a till after "שחרר";
* a command whose status never moves ("נשלח" forever), or a second answer overwriting the first;
* a manager of one shop locking another shop's tills;
* a quick hide or a banner that reaches no kiosk, or outlives its end.

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.database import Base
from app.models.device_command import DeviceCommand
from app.models.kiosk import KioskDevice
from app.models.sold_out import SoldOutMark
from app.routers import device_commands as R
from app.services import device_commands as svc
from app.services import kiosk_config as cfgsvc
from app.services import kiosk_live

from test_product_availability import world  # noqa: F401


@pytest.fixture
def d(world, monkeypatch):  # noqa: F811
    db = world.db
    for name in ("device_commands", "device_remote_states", "kiosk_devices", "kiosk_settings", "kiosk_quick_hides",
                 "machine_groups", "machine_group_members", "sold_out_marks", "report_events", "report_event_machines"):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    world.woken = []
    monkeypatch.setattr(svc, "wake", lambda machines: world.woken.extend(str(m.id) for m in machines))
    return world


def _send(w, action, user=None, **kw):
    body = R.CommandIn(action=action, **kw)
    return R.create_commands(body, current_user=user or w.users.admin, active_tenant_id=w.tid, db=w.db)


class TestCommands:
    def test_a_lock_is_a_state_the_till_finds_even_after_missing_the_push(self, d):
        out = _send(d, "lock", machineIds=[d.h1.id], message="הקופה נעולה — פנו למנהל")
        assert out[0]["status"] == "pending" and d.woken == [str(d.h1.id)]
        pulled = svc.pull(d.db, d.h1)
        d.db.commit()
        assert pulled["state"]["locked"] is True and pulled["state"]["message"] == "הקופה נעולה — פנו למנהל"
        assert [c["status"] for c in pulled["commands"]] == ["delivered"]

    def test_unlock_overtakes_a_lock_still_waiting(self, d):
        _send(d, "lock", machineIds=[d.h1.id])
        _send(d, "unlock", machineIds=[d.h1.id])
        rows = d.db.query(DeviceCommand).order_by(DeviceCommand.created_at).all()
        assert [(r.action, r.status) for r in rows] == [("lock", "cancelled"), ("unlock", "pending")]
        assert svc.pull(d.db, d.h1)["state"]["locked"] is False

    def test_the_answer_is_kept_once(self, d):
        cmd = _send(d, "restart_app", machineIds=[d.h1.id])[0]
        svc.pull(d.db, d.h1)
        R.till_ack(str(d.h1.id), cmd["id"], R.AckIn(status="refused", detail="sale_in_progress"), machine=d.h1, db=d.db)
        again = R.till_ack(str(d.h1.id), cmd["id"], R.AckIn(status="done"), machine=d.h1, db=d.db)
        assert (again["status"], again["detail"]) == ("refused", "sale_in_progress")

    def test_a_till_cannot_answer_another_tills_command(self, d):
        cmd = _send(d, "sync_now", machineIds=[d.h1.id])[0]
        with pytest.raises(HTTPException) as refused:
            R.till_ack(str(d.h2.id), cmd["id"], R.AckIn(status="done"), machine=d.h2, db=d.db)
        assert refused.value.status_code == 404

    def test_a_manager_code_on_the_till_unlocks_and_is_audited(self, d):
        _send(d, "lock", machineIds=[d.h1.id])
        locked_at = svc.pull(d.db, d.h1)["state"]["lockedAt"]
        # No lock named: nothing released (never "whatever is locked now").
        out = R.till_unlocked(str(d.h1.id), R.UnlockedIn(posUserName="דנה"), machine=d.h1, db=d.db)
        assert out["state"]["locked"] is True and out["command"] is None
        # The same instant written another way ("Z", no microseconds lost) is the same lock.
        as_z = locked_at.replace("+00:00", "Z")
        out = R.till_unlocked(str(d.h1.id), R.UnlockedIn(posUserName="דנה", lockedAt=as_z), machine=d.h1, db=d.db)
        assert out["state"]["locked"] is False
        rows = {(r.action, r.status, r.source) for r in d.db.query(DeviceCommand).all()}
        assert ("unlock", "done", "till") in rows and ("lock", "done", "dashboard") in rows

    def test_a_late_release_never_unlocks_a_newer_lock(self, d):
        _send(d, "lock", machineIds=[d.h1.id])
        first = svc.pull(d.db, d.h1)["state"]["lockedAt"]
        # The till released the first lock offline; the dashboard locked it again before the report came.
        later = datetime.now(timezone.utc) + timedelta(seconds=5)
        svc.create(d.db, [d.h1], "lock", user=d.users.admin, now=later)
        d.db.commit()
        out = R.till_unlocked(str(d.h1.id), R.UnlockedIn(posUserName="דנה", lockedAt=first), machine=d.h1, db=d.db)
        assert out["state"]["locked"] is True and out["command"] is None
        current = out["state"]["lockedAt"]
        out = R.till_unlocked(str(d.h1.id), R.UnlockedIn(posUserName="דנה", lockedAt=current), machine=d.h1, db=d.db)
        assert out["state"]["locked"] is False

    def test_a_whole_shop_in_one_batch(self, d):
        out = _send(d, "refresh_catalog", shopId=d.h_shop.id)
        assert {c["machineId"] for c in out} == {str(d.h1.id), str(d.h2.id)}
        assert len({c["batchId"] for c in out}) == 1 and out[0]["batchId"] is not None

    def test_a_manager_of_another_shop_is_refused(self, d):
        with pytest.raises(HTTPException) as refused:
            _send(d, "lock", user=d.users.a_shop_manager, machineIds=[d.h1.id])
        assert refused.value.status_code == 403
        assert d.db.query(DeviceCommand).count() == 0

    def test_a_shop_manager_naming_a_shop_gets_only_their_own_devices(self, d):
        out = _send(d, "sync_now", user=d.users.h_shop_manager, shopId=d.h_shop.id)
        assert {c["machineId"] for c in out} == {str(d.h1.id), str(d.h2.id)}
        with pytest.raises(HTTPException):
            _send(d, "sync_now", user=d.users.h_shop_manager, shopId=d.a_shop.id)

    def test_a_device_group_reaches_its_members_and_each_is_checked_against_the_sender(self, d):
        """A group (feat/menu-groups' model, app/services/device_groups.py): its active members only —
        across shops for whoever covers them; a shop's manager gets the members in their own shop."""
        from app.models.machine_group import MachineGroup, MachineGroupMember

        g = MachineGroup(id=uuid.uuid4(), tenant_id=d.tid, company_id=d.H.id, name="עמדות אירוע")
        d.db.add(g)
        d.db.flush()
        for m in (d.h1, d.a1):
            d.db.add(MachineGroupMember(group_id=g.id, machine_id=m.id))
        d.db.commit()
        out = _send(d, "sync_now", groupId=g.id)
        assert {c["machineId"] for c in out} == {str(d.h1.id), str(d.a1.id)}, "never h2, not in the group"
        mine = _send(d, "sync_now", user=d.users.h_shop_manager, groupId=g.id)
        assert {c["machineId"] for c in mine} == {str(d.h1.id)}, "a1 stands in another shop"
        with pytest.raises(HTTPException) as refused:
            _send(d, "sync_now", groupId=uuid.uuid4())
        assert refused.value.status_code == 404 and refused.value.detail["code"] == "group_not_found"

    def test_cancel_before_delivery_only(self, d):
        cmd = _send(d, "sign_out", machineIds=[d.h1.id])[0]
        cancelled = R.cancel_command(uuid.UUID(cmd["id"]), current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        assert cancelled["status"] == "cancelled"
        cmd = _send(d, "sign_out", machineIds=[d.h1.id])[0]
        svc.pull(d.db, d.h1)
        with pytest.raises(HTTPException) as refused:
            R.cancel_command(uuid.UUID(cmd["id"]), current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        assert refused.value.status_code == 409

    def test_cancelling_an_unlock_puts_back_the_very_lock_the_till_knows(self, d):
        _send(d, "lock", machineIds=[d.h1.id], message="ספירת קופה — חכו")
        known = svc.pull(d.db, d.h1)["state"]
        unlock = _send(d, "unlock", machineIds=[d.h1.id])[0]
        R.cancel_command(uuid.UUID(unlock["id"]), current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        state = svc.pull(d.db, d.h1)["state"]
        assert (state["locked"], state["message"], state["lockedAt"]) == (True, "ספירת קופה — חכו", known["lockedAt"])

    def test_cancelling_a_lock_the_till_never_saw_puts_the_lock_back(self, d):
        cmd = _send(d, "lock", machineIds=[d.h1.id])[0]
        assert cmd["detail"] is None  # what it remembers is not shown
        R.cancel_command(uuid.UUID(cmd["id"]), current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        assert svc.pull(d.db, d.h1)["state"]["locked"] is False
        # Locked, then an unlock and a lock still waiting: cancelling the last restores "locked".
        _send(d, "lock", machineIds=[d.h1.id])
        svc.pull(d.db, d.h1)
        _send(d, "unlock", machineIds=[d.h1.id])
        last = _send(d, "lock", machineIds=[d.h1.id])[0]
        R.cancel_command(uuid.UUID(last["id"]), current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        assert svc.pull(d.db, d.h1)["state"]["locked"] is True

    def test_a_restart_taken_but_never_answered_lapses_in_minutes(self, d):
        restart = _send(d, "restart_app", machineIds=[d.h1.id])[0]
        sync = _send(d, "install_update", machineIds=[d.h1.id])[0]
        svc.pull(d.db, d.h1)  # both delivered; the till restarted mid-way and never answered
        later = datetime.now(timezone.utc) + timedelta(minutes=11)
        open_ids = [c["id"] for c in svc.pull(d.db, d.h1, now=later)["commands"]]
        assert restart["id"] not in open_ids and sync["id"] in open_ids
        row = d.db.get(DeviceCommand, uuid.UUID(restart["id"]))
        assert (row.status, row.detail) == ("expired", "not_answered")
        much_later = datetime.now(timezone.utc) + svc.EXPIRES_AFTER + timedelta(minutes=1)
        assert svc.pull(d.db, d.h1, now=much_later)["commands"] == []

    def test_an_answer_just_after_expiry_is_kept_a_late_one_not(self, d):
        cmd = _send(d, "restart_app", machineIds=[d.h1.id])[0]
        svc.pull(d.db, d.h1)
        expired_at = datetime.now(timezone.utc) + timedelta(minutes=11)
        svc.expire_old(d.db, machine_id=d.h1.id, now=expired_at)
        row = d.db.get(DeviceCommand, uuid.UUID(cmd["id"]))
        assert row.status == "expired"
        # The till restarted and said so 5 minutes later: what happened is kept.
        svc.ack(d.db, d.h1, cmd["id"], "done", None, now=row.updated_at + timedelta(minutes=5))
        assert row.status == "done"
        other = _send(d, "sign_out", machineIds=[d.h1.id])[0]
        svc.pull(d.db, d.h1)
        svc.expire_old(d.db, machine_id=d.h1.id, now=expired_at + timedelta(minutes=11))
        late = d.db.get(DeviceCommand, uuid.UUID(other["id"]))
        svc.ack(d.db, d.h1, other["id"], "done", None, now=late.updated_at + timedelta(hours=1))
        assert late.status == "expired", "an hour late: still expired"

    def test_an_old_builds_pending_lock_cancels_by_its_detail(self, d):
        _send(d, "lock", machineIds=[d.h1.id])
        svc.pull(d.db, d.h1)  # locked, delivered
        row = DeviceCommand(
            id=uuid.uuid4(), tenant_id=d.tid, shop_id=d.h_shop.id, machine_id=d.h1.id, action="unlock",
            status="pending", detail=svc.WAS_LOCKED, source="dashboard", created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        d.db.add(row)
        svc.state_of(d.db, d.h1.id).locked = False  # what that unlock had set
        d.db.commit()
        R.cancel_command(row.id, current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        assert svc.pull(d.db, d.h1)["state"]["locked"] is True

    def test_a_command_nobody_picked_up_expires(self, d):
        _send(d, "install_update", machineIds=[d.h1.id])
        later = datetime.now(timezone.utc) + svc.EXPIRES_AFTER + timedelta(minutes=1)
        assert svc.pull(d.db, d.h1, now=later)["commands"] == []
        assert d.db.query(DeviceCommand).one().status == "expired"

    def test_the_panel_rows_carry_the_state_and_the_open_commands(self, d):
        _send(d, "lock", machineIds=[d.h1.id])
        rows = R.list_devices(None, d.h_shop.id, None, current_user=d.users.admin, active_tenant_id=d.tid, db=d.db)
        row = next(r for r in rows if r["machineId"] == str(d.h1.id))
        assert row["state"]["locked"] is True and [c["action"] for c in row["open"]] == ["lock"]


class TestKioskLive:
    @pytest.fixture
    def k(self, d):
        d.db.add(KioskDevice(machine_id=d.h2.id, tenant_id=d.tid, shop_id=d.h_shop.id, name="Kiosk", enabled=True))
        d.db.commit()
        return d

    def test_remote_control_alone_pauses_a_kiosk_but_never_reaches_its_z(self, k):
        from app.models.dashboard_access import DashboardAccessProfile
        from app.routers import kiosks as KR
        from app.services import dashboard_access as DA

        if not k.db.get_bind().dialect.has_table(k.db.connection(), "dashboard_access_profiles"):
            Base.metadata.tables["dashboard_access_profiles"].create(k.db.get_bind())
        user = k.users.h_shop_manager
        k.db.add(DashboardAccessProfile(user_id=user.id, full_access=False, sections={"device_control": "edit"}))
        k.db.commit()
        DA.forget(k.db)
        for action in ("pause", "resume"):
            KR.check_kiosk_action(k.db, user, action)
        for action in ("till_z", "close_shift", "schedule", "bon_print"):
            with pytest.raises(HTTPException) as refused:
                KR.check_kiosk_action(k.db, user, action)
            assert refused.value.status_code == 403, action
        # The Z section (or the kiosks section) still produces a kiosk's Z, as before.
        k.db.query(DashboardAccessProfile).filter(DashboardAccessProfile.user_id == user.id).update({"sections": {"z": "edit"}})
        k.db.commit()
        DA.forget(k.db)
        KR.check_kiosk_action(k.db, user, "till_z")

    def test_a_kiosk_is_never_locked_or_signed_out_remotely(self, k):
        with pytest.raises(HTTPException) as refused:
            _send(k, "lock", machineIds=[k.h2.id])
        assert refused.value.detail["code"] == "kiosk_use_pause"
        # A whole shop's lock reaches its tills only; a sync reaches the kiosk too.
        assert {c["machineId"] for c in _send(k, "lock", shopId=k.h_shop.id)} == {str(k.h1.id)}
        assert {c["machineId"] for c in _send(k, "sync_now", shopId=k.h_shop.id)} == {str(k.h1.id), str(k.h2.id)}

    def test_a_quick_hide_reaches_the_kiosks_of_the_shop_through_their_config(self, k):
        row = kiosk_live.hide(k.db, tenant_id=k.tid, shop_id=k.h_shop.id, kind="product", item_id=k.P.id, until=None, note="הגריל סגור")
        k.db.commit()
        cfg = cfgsvc.effective_config(k.db, k.h2)
        assert str(k.P.id) in cfg["catalog"]["hiddenProducts"]
        other = cfgsvc.effective_config(k.db, k.a1)
        assert str(k.P.id) not in (other["catalog"].get("hiddenProducts") or []), "another shop's kiosks"
        kiosk_live.show(k.db, row)
        k.db.commit()
        assert str(k.P.id) not in (cfgsvc.effective_config(k.db, k.h2)["catalog"].get("hiddenProducts") or [])

    def test_a_hide_ends_by_itself_and_changes_the_config_version(self, k):
        before = cfgsvc.config_version(cfgsvc.effective_config(k.db, k.h2))
        kiosk_live.hide(
            k.db, tenant_id=k.tid, shop_id=k.h_shop.id, kind="category", item_id=k.P.category_id,
            until=datetime.now(timezone.utc) + timedelta(minutes=30), note=None,
        )
        k.db.commit()
        during = cfgsvc.effective_config(k.db, k.h2)
        assert str(k.P.category_id) in during["catalog"]["hiddenCategories"]
        assert cfgsvc.config_version(during) != before
        # A quick hide is a block now (specs/item-blocks-targets.md): its end is the block's.
        k.db.query(SoldOutMark).update({SoldOutMark.until: datetime.now(timezone.utc) - timedelta(seconds=1)})
        k.db.commit()
        assert cfgsvc.config_version(cfgsvc.effective_config(k.db, k.h2)) == before

    def test_a_banner_without_pausing(self, k):
        device = k.db.get(KioskDevice, k.h2.id)
        until = datetime.now(timezone.utc) + timedelta(minutes=20)
        kiosk_live.set_banner(device, "הגריל ייפתח שוב ב-14:00", until, "admin")
        k.db.commit()
        cfg = cfgsvc.effective_config(k.db, k.h2)
        banner = cfg["messages"][0]
        assert (banner["id"], banner["kind"], banner["body"]) == ("live-banner", "banner", "הגריל ייפתח שוב ב-14:00")
        assert banner["endsAt"] is not None and device.paused is False
        kiosk_live.set_banner(device, None, None, None)
        k.db.commit()
        assert all(m.get("id") != "live-banner" for m in cfgsvc.effective_config(k.db, k.h2)["messages"])

    def test_a_hide_of_another_tenants_item_is_refused(self, k):
        with pytest.raises(HTTPException):
            kiosk_live.hide(k.db, tenant_id=uuid.uuid4(), shop_id=k.h_shop.id, kind="product", item_id=k.P.id, until=None, note=None)
