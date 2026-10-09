"""
"סגירת משמרת / הפקת Z מרחוק" from remote control (app/services/remote_till_z.py, the
/device-commands/close-preview and /device-commands/close routes) — behind REMOTE_TILL_Z_ENABLED.

The owner's safeguards, as scenarios: off unless the flag says on; the manager confirms the till's
current totals and a sale since then refuses the request; the request is the till's existing Z or
shift close, marked to wait for rest (never forced); a till in the shop's Z gets a shift close, a
till with its own Z a Z with its next sequential number; kiosks and someone without the Z section
never.

Runs on the world of tests/test_shop_areas.py (documents at 21:00 Israel time on 27.09.2026).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.shift_close_request import ShiftCloseRequest
from app.models.till_z_request import TillZRequest
from app.routers import device_commands as R
from app.services import ably_notify
from app.services import remote_till_z as svc
from app.services import shift_close_requests as close_requests
from app.services import till_z
from test_shop_areas import open_shift, w  # noqa: F401


@pytest.fixture
def z(w, monkeypatch):  # noqa: F811
    monkeypatch.setenv("REMOTE_TILL_Z_ENABLED", "true")
    w.sent = []
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: w.sent.append(("close-shift", k)))
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: w.sent.append(("till-z", k)))
    w.till = w.tills[0]
    w.shift = open_shift(w, w.till, 1)
    w.doc(w.till, w.shift, "100.00")
    w.doc(w.till, w.shift, "40.00", method="card")
    w.db.commit()
    return w


def _ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def test_off_by_default(w, monkeypatch):  # noqa: F811
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED", raising=False)
    assert R.get_features(current_user=w.admin) == {"remoteTillZ": False}
    with pytest.raises(HTTPException) as off:
        R.get_close_preview(w.tills[0].id, **_ctx(w))
    assert off.value.status_code == 404 and off.value.detail["code"] == "remote_till_z_off"
    with pytest.raises(HTTPException):
        R.post_remote_close(R.RemoteCloseIn(machineId=w.tills[0].id, totalsKey="x"), **_ctx(w))



@pytest.mark.parametrize("flag", [None, "", "false", "0", "no", "off", "FALSE"])
def test_flag_off_is_truly_off_nothing_ever_reaches_a_till(w, monkeypatch, flag):  # noqa: F811
    """
    REMOTE_TILL_Z_ENABLED off (unset, empty or any "off" spelling) — the integration's proof before
    the feature's own review (09.10.2026): both routes refuse with remote_till_z_off, and nothing is
    queued for any till — no shift-close or Z request, no realtime wake, nothing in the till's
    pulls — while the generic remote control has no close / Z action at all.
    """
    from app.models.device_command import DEVICE_ACTIONS
    from app.services import remote_close

    if flag is None:
        monkeypatch.delenv("REMOTE_TILL_Z_ENABLED", raising=False)
    else:
        monkeypatch.setenv("REMOTE_TILL_Z_ENABLED", flag)
    sent = []
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: sent.append("close-shift"))
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: sent.append("till-z"))
    till = w.tills[0]
    shift = open_shift(w, till, 1)
    w.doc(till, shift, "100.00")
    w.db.commit()

    assert svc.enabled() is False
    assert R.get_features(current_user=w.admin) == {"remoteTillZ": False}
    with pytest.raises(HTTPException) as preview:
        R.get_close_preview(till.id, **_ctx(w))
    assert preview.value.status_code == 404 and preview.value.detail["code"] == "remote_till_z_off"
    with pytest.raises(HTTPException) as close:
        R.post_remote_close(R.RemoteCloseIn(machineId=till.id, totalsKey="anything"), **_ctx(w))
    assert close.value.status_code == 404 and close.value.detail["code"] == "remote_till_z_off"

    # Nothing queued: no request rows, no wake, nothing for the till to take.
    assert w.db.query(ShiftCloseRequest).count() == 0
    assert w.db.query(TillZRequest).count() == 0
    assert sent == []
    assert remote_close.take_pending_close_shift(w.db, till) is None
    assert till_z.take_pending(w.db, till) is None
    # The generic remote control never carried a close or a Z.
    assert not {"close_shift", "till_z", "z", "shift_close"} & set(DEVICE_ACTIONS)
    for action in ("close_shift", "till_z"):
        with pytest.raises(Exception):
            R.CommandIn(action=action, machineIds=[till.id])

class TestShopZTill:
    def test_the_manager_sees_the_totals_then_a_shift_close_waits_for_rest(self, z):
        preview = R.get_close_preview(z.till.id, **_ctx(z))
        assert preview["kind"] == "close_shift" and preview["kindLabel"] == "סגירת משמרת"
        assert preview["totals"]["transactions"] == 2 and preview["totals"]["net"] == 140.0
        assert preview["totals"]["byTender"] == {"card": 40.0, "cash": 100.0}
        assert preview["openShift"]["id"] == str(z.shift.id) and preview["canRequest"] is True
        out = R.post_remote_close(R.RemoteCloseIn(machineId=z.till.id, totalsKey=preview["totalsKey"]), **_ctx(z))
        assert out["kind"] == "close_shift" and out["created"] is True
        req = z.db.query(ShiftCloseRequest).one()
        assert req.wait_for_rest is True
        # On the heartbeat too: the till holds it while a sale is open.
        from app.services import remote_close

        assert remote_close.take_pending_close_shift(z.db, z.till)["waitForRest"] is True

    def test_a_sale_since_the_confirmation_refuses_with_the_new_figures(self, z):
        preview = R.get_close_preview(z.till.id, **_ctx(z))
        z.doc(z.till, z.shift, "25.00")
        z.db.commit()
        with pytest.raises(HTTPException) as changed:
            R.post_remote_close(R.RemoteCloseIn(machineId=z.till.id, totalsKey=preview["totalsKey"]), **_ctx(z))
        assert changed.value.status_code == 409 and changed.value.detail["code"] == "totals_changed"
        assert changed.value.detail["preview"]["totals"]["net"] == 165.0
        assert z.db.query(ShiftCloseRequest).count() == 0, "nothing asked of the till"

    def test_never_forced_and_a_plain_request_is_unchanged(self, z):
        req, _ = close_requests.request_close(z.db, z.admin, z.till)
        z.db.commit()
        assert req.wait_for_rest is False, "the machines page's close as before"


class TestOwnZTill:
    def test_a_till_with_its_own_z_gets_its_next_number_and_waits_for_rest(self, z):
        z.till.z_mode = till_z.Z_MODE_TILL
        z.db.commit()
        preview = R.get_close_preview(z.till.id, **_ctx(z))
        assert preview["kind"] == "till_z" and preview["nextZNumber"] == preview["lastZNumber"] + 1
        R.post_remote_close(R.RemoteCloseIn(machineId=z.till.id, totalsKey=preview["totalsKey"]), **_ctx(z))
        req = z.db.query(TillZRequest).one()
        assert (req.wait_for_rest, req.force_close) == (True, False)
        assert till_z.take_pending(z.db, z.till)["waitForRest"] is True
        assert "force" not in till_z.take_pending(z.db, z.till)


class TestWhoAndWhat:
    def test_a_kiosk_never(self, z):
        z.db.add(KioskDevice(machine_id=z.till.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
        z.db.commit()
        with pytest.raises(HTTPException) as refused:
            R.get_close_preview(z.till.id, **_ctx(z))
        assert refused.value.detail["code"] == "kiosk_use_kiosks"

    def test_without_the_z_section_never(self, z):
        from app.database import Base
        from app.models.dashboard_access import DashboardAccessProfile
        from app.services import dashboard_access as DA

        if not z.db.get_bind().dialect.has_table(z.db.connection(), "dashboard_access_profiles"):
            Base.metadata.tables["dashboard_access_profiles"].create(z.db.get_bind())
        z.db.add(DashboardAccessProfile(user_id=z.manager.id, full_access=False, sections={"device_control": "edit"}))
        z.db.commit()
        DA.forget(z.db)
        with pytest.raises(HTTPException) as refused:
            R.get_close_preview(z.till.id, **_ctx(z, z.manager))
        assert refused.value.status_code == 403

    def test_nothing_to_close(self, z):
        z.db.delete(z.shift)
        z.db.commit()
        other = z.tills[1]
        preview = R.get_close_preview(other.id, **_ctx(z))
        assert preview["canRequest"] is False and preview["whyNot"] == "אין משמרת פתוחה בקופה"
        with pytest.raises(HTTPException) as refused:
            R.post_remote_close(R.RemoteCloseIn(machineId=other.id, totalsKey=preview["totalsKey"]), **_ctx(z))
        assert refused.value.status_code == 409
