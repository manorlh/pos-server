"""
"סגירת יום סניפית" from remote control (app/services/remote_till_z.py shop_preview / shop_request,
the /device-commands/shop-close* routes) — behind REMOTE_TILL_Z_ENABLED.

The configuration matrix, as the owner put it ("תלוי בתצורות העבודה — שיהיו את כל האופציות לפי
מה שהוגדר במערכת"): nothing is decided here, everything follows what is configured —

* every till in the shop Z, produced in the cloud: one action, the existing Z run, each till
  closing at rest (`waitForRest`), the Z numbered strictly next;
* the shop Z produced by the main till (`shopZFrom` = main only with the main till online, or
  local mode): shown with its source, "לא זמין עדיין" with why — never a broken path;
* every till with its own Z: no shop close; each till its own remote Z, its own next number;
* mixed: the shop close takes exactly the tills of the shop Z;
* kiosks: in the run when in the shop Z, their own Z (and "close with the shop Z") otherwise;
* a till offline: the run waits for it; leaving it out only where the existing flow allows;
* a sale open: the till defers, the progress says so; cancel mid-way: no Z, no number taken;
* numbering continuity across the wizard's runs and remote control's.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.models.z_run import ZRun, ZRunStatus
from app.routers import device_commands as R
from app.routers import z_runs as z_runs_router
from app.schemas.shift import ShiftCloseIn
from app.schemas.z_run import ZRunCreateIn
from app.services import ably_notify
from app.services import main_till as MT
from app.services import remote_close
from app.services import remote_till_z as svc
from app.services import till_parameters as TP
from app.services.shifts import apply_shift_close
from app.services.z_sequence import last_machine_z_number, last_shop_z_number
from shift_world import NOW
from test_main_till import make_main, outside_local_mode, set_param
from test_main_till import w  # noqa: F401


@pytest.fixture
def z(w, monkeypatch):  # noqa: F811
    monkeypatch.setenv("REMOTE_TILL_Z_ENABLED", "true")
    w.sent = []
    w.issued = {}
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: w.sent.append(k))
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: None)
    w.t1, w.t2 = w.tills
    for t in w.tills:
        t.last_heartbeat_at = NOW - timedelta(seconds=10)
        t.app_version = "0.1.400+abcdef0-device"  # a build that honours waitForRest
        t.capabilities = ["remote_close_v2"]  # a build with every remote-close safeguard
    w.db.commit()
    return w


def _ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def selling(w, till, seq, *amounts):
    """A till with an open shift and sales in it."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    for amount in amounts:
        # Each till's own unbroken document numbers (a gap reads as documents still missing).
        w.issued[till.id] = w.issued.get(till.id, 0) + 1
        w.doc(till, shift, amount, number=str(int(till.pos_number) * 10000 + w.issued[till.id]))
    w.db.flush()
    return shift


def till_closes(w, till, shift):
    """The till closes the shift the cloud asked for, and the cloud accepts it (the sync road)."""
    docs = w.db.query(Transaction).filter(Transaction.shift_id == shift.id).all()
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(d.id) for d in docs],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    remote_close.on_shift_close_accepted(w.db, till, shift)
    w.db.commit()  # as the sync route does
    return shift


def item_of(run, till):
    return next(i for i in run.items if i.machine_id == till.id)


def preview(w):
    return svc.shop_preview(w.db, w.shop, now=NOW)


def start(w, **kw):
    key = preview(w)["totalsKey"]
    run = svc.shop_request(w.db, w.admin, w.tenant.id, w.shop, totals_key=key, confirm_cloud_data=True, now=NOW, **kw)
    assert isinstance(run, ZRun), run
    w.db.commit()  # as the route does: a refusal later rolls back to here, never past the run
    return run


# ── Off ───────────────────────────────────────────────────────────────────────


def test_off_by_default_nothing_reaches_a_till(z, monkeypatch):
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED", raising=False)
    selling(z, z.t1, 1, "10.00")
    for call in (
        lambda: R.get_shop_close_preview(shop_id=z.shop.id, **_ctx(z)),
        lambda: R.post_shop_close(R.ShopCloseIn(shopId=z.shop.id, totalsKey="x"), **_ctx(z)),
        lambda: R.post_shop_close_cancel(uuid.uuid4(), **_ctx(z)),
        lambda: R.post_shop_close_proceed(uuid.uuid4(), R.ShopCloseProceedIn(), **_ctx(z)),
    ):
        with pytest.raises(HTTPException) as off:
            call()
        assert off.value.status_code == 404 and off.value.detail["code"] == "remote_till_z_off"
    assert z.sent == [] and z.db.query(ZRun).count() == 0


# ── Every till in the shop Z, produced in the cloud ───────────────────────────


def test_cloud_source_one_action_each_till_at_rest_and_the_next_number(z):
    s1 = selling(z, z.t1, 1, "100.00", "40.00")
    s2 = selling(z, z.t2, 1, "60.00")
    before = last_shop_z_number(z.db, z.shop.id)

    out = preview(z)
    assert out["source"] == {"kind": "cloud", "label": "יופק בענן", "machineId": None, "available": True, "whyNot": None}
    assert [r["machineId"] for r in out["inShopZ"]] == [str(z.t1.id), str(z.t2.id)] and out["ownZ"] == []
    assert out["totals"]["totalSales"] == 200.0 and out["totals"]["transactions"] == 3
    assert [r["net"] for r in out["inShopZ"]] == [140.0, 60.0]
    assert out["nextShopZNumber"] == before + 1
    assert out["shopClose"] == {"label": "סגירת יום סניפית", "available": True, "whyNot": None, "forceStartAllowed": False,
                                "forceCloudRefundAllowed": False}

    run = start(z)
    assert run.wait_for_rest is True and run.force_close is False
    # Each till asked through the existing push and heartbeat — at rest only, never forced.
    assert len(z.sent) == 2 and all(k.get("wait_for_rest") is True and not k.get("force") for k in z.sent)
    beat = remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)
    assert beat["requestId"] == str(item_of(run, z.t1).id) and beat["waitForRest"] is True and "force" not in beat

    # A sale open on till 2: it defers, and the manager reads why.
    remote_close.apply_close_shift_ack(z.db, z.t2, request_id=item_of(run, z.t2).id, phase="deferred",
                                       shift_id=s2.id, error_code="sale_open", error_message="a sale is open")
    till_closes(z, z.t1, s1)
    progress = svc.run_progress(z.db, run, now=NOW)
    words = {i["machineId"]: i["words"] for i in progress["items"]}
    # Forced by default ("כפה סגירה", remote_close_force.py): the closed till reads who forced it.
    assert words == {z.t1.id: "נסגר בכפייה מרחוק ע״י admin", z.t2.id: "ממתין למכירה פתוחה"}
    assert progress["status"] == ZRunStatus.WAITING and progress["words"] == "ממתין לקופות"
    # The heartbeat keeps offering it until the sale is done.
    assert remote_close.take_pending_close_shift(z.db, z.t2, now=NOW)["waitForRest"] is True
    # While it runs, the shop shows it and offers no second one.
    assert preview(z)["shopClose"]["available"] is False and preview(z)["run"]["id"] == run.id

    till_closes(z, z.t2, s2)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    done = svc.run_progress(z.db, run, now=NOW)
    assert done["zNumber"] == before + 1 and done["words"] == f"הושלם — Z סניפי מס' {before + 1}"


def test_numbering_continues_across_the_wizard_and_remote_control(z):
    s = selling(z, z.t1, 1, "10.00")
    till_closes(z, z.t1, s)
    # The wizard's own run first.
    z_runs_router.post_z_run(
        ZRunCreateIn(shopId=z.shop.id, machines=[{"machineId": str(z.t1.id)}], confirmCloudData=True), **_ctx(z)
    )
    first = last_shop_z_number(z.db, z.shop.id)

    s2 = selling(z, z.t1, 2, "20.00")
    s3 = selling(z, z.t2, 1, "30.00")
    assert preview(z)["nextShopZNumber"] == first + 1
    run = start(z)
    till_closes(z, z.t1, s2)
    till_closes(z, z.t2, s3)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED and svc.run_progress(z.db, run)["zNumber"] == first + 1

    s4 = selling(z, z.t1, 3, "5.00")
    run = start(z)
    till_closes(z, z.t1, s4)
    z.db.refresh(run)
    p = svc.run_progress(z.db, run)
    assert p["zNumber"] == first + 2 == last_shop_z_number(z.db, z.shop.id), (
        p["status"], p["errorCode"], p["errorMessage"], [(i["status"], i["errorCode"]) for i in p["items"]])


def test_a_sale_since_the_preview_refuses_and_nothing_is_asked(z):
    s = selling(z, z.t1, 1, "10.00")
    key = preview(z)["totalsKey"]
    z.doc(z.t1, s, "5.00", number="10002")
    z.db.flush()
    with pytest.raises(HTTPException) as e:
        svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=key, confirm_cloud_data=True, now=NOW)
    assert e.value.status_code == 409 and e.value.detail["code"] == "totals_changed"
    assert z.sent == [] and z.db.query(ZRun).count() == 0


def test_the_wizards_confirmations_are_asked_as_the_wizard_asks_them(z):
    """Tills whose data did not all reach the cloud: the same 409 the wizard gets, then confirmed."""
    import app.routers.z_runs as ZRR

    selling(z, z.t1, 1, "10.00")
    key = preview(z)["totalsKey"]
    flagged = [{"machineId": str(z.t1.id), "warnings": ["x"]}]
    original = ZRR.z_state.states
    ZRR.z_state.states = lambda db, machines: flagged
    try:
        with pytest.raises(HTTPException) as e:
            svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=key, now=NOW)
        assert e.value.detail["code"] == "cloud_data_confirmation_required"
        run = svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=key, confirm_cloud_data=True, now=NOW)
        assert run.cloud_data_confirmation["by"] == "admin"
    finally:
        ZRR.z_state.states = original


# ── A till offline ────────────────────────────────────────────────────────────


def test_an_offline_till_is_waited_for_and_left_out_only_where_the_flow_allows(z):
    # "חסימת Z כשיש משמרות פתוחות" off: today's rules (on: tests/test_z_shift_guard.py).
    set_param(z, "zRequireAllShiftsClosed", "shop", z.shop.id, False)
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.t2.last_heartbeat_at = NOW - timedelta(hours=3)
    z.db.flush()

    out = preview(z)
    assert [r["online"] for r in out["inShopZ"]] == [True, False]
    run = start(z)
    till_closes(z, z.t1, s1)
    progress = svc.run_progress(z.db, run, now=NOW)
    assert {i["machineId"]: i["words"] for i in progress["items"]}[z.t2.id] == "לא מחובר — ממתין שיתחבר"
    assert progress["leaveOutAllowed"] is True and progress["leaveOutWhyNot"] is None

    # "חובה לסגור את כל הקופות": no leaving it out — the existing refusal, said in the progress.
    set_param(z, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", z.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
    progress = svc.run_progress(z.db, run, now=NOW)
    assert progress["leaveOutAllowed"] is False and "חובה לסגור את כל הקופות" in progress["leaveOutWhyNot"]
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert e.value.detail["code"] == "all_tills_required"

    # The rule lifted: built without it; its shift waits for the next Z (no gap).
    set_param(z, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", z.shop.id, TP.SHOP_Z_OPEN_TILLS_CONFIRM)
    before = last_shop_z_number(z.db, z.shop.id)
    done = R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert done["status"] == ZRunStatus.COMPLETED and done["zNumber"] == before + 1


# ── Cancel mid-way ────────────────────────────────────────────────────────────


def test_cancel_mid_way_takes_no_number_and_asks_no_more(z):
    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "20.00")
    before = last_shop_z_number(z.db, z.shop.id)
    run = start(z)
    till_closes(z, z.t1, s1)
    remote_close.apply_close_shift_ack(z.db, z.t2, request_id=item_of(run, z.t2).id, phase="deferred",
                                       shift_id=s2.id, error_code="sale_open")

    out = R.post_shop_close_cancel(run.id, **_ctx(z))
    assert out["status"] == ZRunStatus.CANCELLED and out["words"] == "בוטל" and out["zNumber"] is None
    assert last_shop_z_number(z.db, z.shop.id) == before
    # Till 2 is asked no more: its deferred close is gone from the heartbeat.
    assert remote_close.take_pending_close_shift(z.db, z.t2, now=NOW) is None
    # Till 1's closed shift waits for the next Z — which takes the very next number.
    assert preview(z)["shopClose"]["available"] is True
    run2 = start(z)
    till_closes(z, z.t2, s2)
    z.db.refresh(run2)
    assert run2.status == ZRunStatus.COMPLETED and svc.run_progress(z.db, run2)["zNumber"] == before + 1


# ── The shop Z produced by the main till ─────────────────────────────────────


def test_shop_z_from_the_main_till_only_is_shown_and_not_offered(z):
    selling(z, z.t1, 1, "10.00")
    make_main(z, z.t1)
    outside_local_mode(z, z.t2)
    z.t1.last_heartbeat_at = datetime.now(timezone.utc)  # the main till is up
    z.db.flush()
    assert MT.dashboard_z_refusal(z.db, z.shop) is not None

    out = preview(z)
    assert out["source"]["kind"] == "main_till" and out["source"]["label"] == "יופק בקופה הראשית: Till 1 (1)"
    assert out["source"]["machineId"] == str(z.t1.id)
    assert out["shopClose"]["available"] is False and out["shopClose"]["whyNot"] == out["source"]["whyNot"]
    assert out["shopClose"]["whyNot"].startswith("לא זמין עדיין")
    with pytest.raises(HTTPException) as e:
        svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=out["totalsKey"], now=NOW)
    assert e.value.detail["code"] == "shop_close_unavailable"
    assert z.sent == [] and z.db.query(ZRun).count() == 0


def test_a_main_till_the_cloud_lost_does_not_hold_the_day_close(z):
    """The existing rule: with the main till offline the dashboard may produce the shop Z."""
    s = selling(z, z.t1, 1, "10.00")
    make_main(z, z.t2)
    outside_local_mode(z, z.t1)
    z.t2.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=2)
    z.db.flush()
    out = preview(z)
    assert out["source"]["kind"] == "cloud" and out["shopClose"]["available"] is True
    run = start(z)
    till_closes(z, z.t1, s)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED


def test_local_mode_is_not_yet_available_from_remote_control(z):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    make_main(z, z.t1)
    z.shop.local_network = True
    z.db.flush()

    out = preview(z)
    assert out["source"]["kind"] == "main_till" and out["source"]["available"] is False
    assert out["source"]["whyNot"].startswith("לא זמין עדיין")
    assert out["shopClose"]["available"] is False
    # A till's own shift close goes over the LAN in local mode: not yet from here either.
    assert all(r["action"]["whyNot"] == svc.LOCAL_MODE_SHIFT_TEXT for r in out["inShopZ"])
    till = svc.preview(z.db, z.t2, now=NOW)
    assert till["canRequest"] is False and till["whyNot"] == svc.LOCAL_MODE_SHIFT_TEXT
    with pytest.raises(HTTPException):
        svc.request(z.db, z.admin, z.t2, totals_key=till["totalsKey"], now=NOW)
    assert z.sent == []


# ── Tills with their own Z, and mixed shops ───────────────────────────────────


def test_every_till_with_its_own_z_no_shop_close_each_till_its_own_next_number(z):
    for t in z.tills:
        t.z_mode = "till"
    selling(z, z.t1, 1, "10.00")
    z.db.flush()

    out = preview(z)
    assert out["inShopZ"] == [] and out["shopClose"]["available"] is False
    assert out["shopClose"]["whyNot"] == "אין בסניף קופות ב-Z הסניפי (כל הקופות מפיקות Z משלהן)"
    rows = {r["machineId"]: r["action"] for r in out["ownZ"]}
    assert rows[str(z.t1.id)] == {"kind": "till_z", "label": "הפקת Z לקופה", "available": True, "whyNot": None}
    assert rows[str(z.t2.id)]["available"] is False  # nothing to put in a Z
    till = svc.preview(z.db, z.t1, now=NOW)
    assert till["kind"] == "till_z" and till["nextZNumber"] == last_machine_z_number(z.db, z.t1.id) + 1


def test_mixed_the_shop_close_takes_exactly_the_tills_of_the_shop_z(z):
    z.t2.z_mode = "till"
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "99.00")
    z.db.flush()

    out = preview(z)
    assert [r["machineId"] for r in out["inShopZ"]] == [str(z.t1.id)]
    assert [r["machineId"] for r in out["ownZ"]] == [str(z.t2.id)] and out["totals"]["totalSales"] == 10.0
    run = start(z)
    assert [i.machine_id for i in run.items] == [z.t1.id] and len(z.sent) == 1
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    # Till 2's own shift was never touched; its own Z stays its own.
    assert remote_close.take_pending_close_shift(z.db, z.t2, now=NOW) is None
    own = svc.preview(z.db, z.t2, now=NOW)
    assert own["canRequest"] is True
    # Its own remote Z, at rest — and read as a sent command like any other.
    sent = svc.request(z.db, z.admin, z.t2, totals_key=own["totalsKey"], now=NOW)
    assert sent["kind"] == "till_z" and sent["request"]["force"] is False
    assert sent["command"]["action"] == "till_z" and sent["command"]["status"] == "pending"
    assert sent["command"]["machineId"] == str(z.t2.id)


# ── Kiosks ────────────────────────────────────────────────────────────────────


def test_kiosks_in_the_shop_z_close_with_it_and_their_own_z_stays_theirs(z):
    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "20.00")
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    z.db.flush()

    out = preview(z)
    kiosk = next(r for r in out["inShopZ"] if r["machineId"] == str(z.t2.id))
    assert kiosk["isKiosk"] is True and kiosk["kindLabel"] == "Z סניפי"
    assert kiosk["action"]["available"] is False and kiosk["action"]["whyNot"] == "קיוסק — מלשונית הקיוסקים"
    run = start(z)
    assert {i.machine_id for i in run.items} == {z.t1.id, z.t2.id}
    till_closes(z, z.t1, s1)
    till_closes(z, z.t2, s2)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED


def test_a_kiosk_with_its_own_z_is_shown_with_its_close_with_the_shop_z_setting(z, monkeypatch):
    from app.services import kiosk_config as KC

    z.t2.z_mode = "till"
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    selling(z, z.t1, 1, "10.00")
    z.db.flush()
    monkeypatch.setattr(KC, "effective_config", lambda db, m: {"operations": {"closeWithShopZ": True}})
    out = preview(z)
    kiosk = out["ownZ"][0]
    assert kiosk["isKiosk"] is True and kiosk["kindLabel"] == "Z לכל קופה" and kiosk["closesWithShopZ"] is True
    assert kiosk["action"]["available"] is False
    run = start(z)
    assert [i.machine_id for i in run.items] == [z.t1.id]


# ── A business with one till per Z, and who may ───────────────────────────────


def test_one_till_per_z_business_is_not_yet_available(z):
    z.tenant.settings = {**(z.tenant.settings or {}), "zScope": "machine"}
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.db.flush()
    out = preview(z)
    assert out["shopClose"]["available"] is False and out["shopClose"]["whyNot"].startswith("לא זמין עדיין")


def test_a_manager_of_some_points_of_sale_only_is_refused(z, monkeypatch):
    selling(z, z.t1, 1, "10.00")
    monkeypatch.setattr(R, "_narrowing", lambda db, user: object())
    with pytest.raises(HTTPException) as e:
        R.get_shop_close_preview(shop_id=z.shop.id, **_ctx(z))
    assert e.value.status_code == 403 and e.value.detail["code"] == "shop_close_needs_whole_shop"


def test_the_routes_preview_start_and_read_progress(z):
    from datetime import datetime, timezone

    for t in z.tills:  # the routes read the wall clock: the tills heard just now
        t.last_heartbeat_at = datetime.now(timezone.utc)
    s = selling(z, z.t1, 1, "10.00")
    out = R.get_shop_close_preview(shop_id=z.shop.id, **_ctx(z))
    run = R.post_shop_close(R.ShopCloseIn(shopId=z.shop.id, totalsKey=out["totalsKey"], confirmCloudData=True), **_ctx(z))
    assert run["waitForRest"] is True and run["status"] == ZRunStatus.WAITING
    till_closes(z, z.t1, s)
    z.db.commit()
    progress = R.get_shop_close(run["id"], **_ctx(z))
    assert progress["status"] == ZRunStatus.COMPLETED and progress["items"][0]["words"] == "נסגר בכפייה מרחוק ע״י admin"


def test_each_till_reads_as_a_sent_command_for_the_shared_status_chip(z):
    """The same shape as the remote commands (device_commands.command_out): one per till, the run its batch."""
    from app.models.device_command import DeviceCommand
    from app.services import device_commands as DC

    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    remote_close.apply_close_shift_ack(z.db, z.t2, request_id=item_of(run, z.t2).id, phase="deferred", error_code="sale_open")
    till_closes(z, z.t1, s1)
    commands = {c["machineId"]: c for c in svc.run_progress(z.db, run, now=NOW)["commands"]}
    shape = DC.command_out(DeviceCommand(id=uuid.uuid4(), machine_id=z.t1.id, action="lock", status="pending", source="dashboard"))
    assert all(set(c) == set(shape) for c in commands.values())
    one, two = commands[str(z.t1.id)], commands[str(z.t2.id)]
    assert one["action"] == two["action"] == "shop_close" and one["batchId"] == two["batchId"] == str(run.id)
    assert one["status"] == "done" and one["doneAt"] is not None
    assert two["status"] == "delivered" and two["detail"] == "sale_open" and two["createdBy"] == "admin"
    R.post_shop_close_cancel(run.id, **_ctx(z))
    z.db.refresh(run)
    assert {c["machineId"]: c["status"] for c in svc.run_progress(z.db, run)["commands"]}[str(z.t2.id)] == "cancelled"
