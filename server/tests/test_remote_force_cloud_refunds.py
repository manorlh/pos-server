"""
"כפה סגירה" (feat/remote-close-force-default) beside "זיכוי באשראי מהענן — חובה לפני ה-Z הבא"
(feat/cloud-refund-next-z), merged at the integration (10.10.2026): the two things the merge must keep.

* A forced remote close / Z (the parameter `remoteCloseForceByDefault`, on by default, or the manager's
  tick) only changes HOW a till is told to close (parks an open basket instead of waiting for rest); it
  never lifts the cloud-refund gate: a Z the cloud refund's credit note would miss is still refused
  (409 `pending_cloud_card_refund` / `shop_close_unavailable` with its message), forced or not, and only a
  super admin's typed reason passes it.
* The heartbeat keeps every capability of every branch: remote_close_v2, card_refund_next_shift,
  device_logs_v1 and remote_close_force_v1 (both cleaners, no whitelist drops one).
"""
from __future__ import annotations

from app.models.z_run import ZRun, ZRunStatus
from app.services import cloud_refund_z_gate as G
from app.services import device_logs
from app.services import remote_close_force as F
from app.services import remote_till_z as svc
from shift_world import NOW
from test_cloud_refund_z_gate import MESSAGE, closed, g, owed, refused  # noqa: F401
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, item_of, preview, selling, start, till_closes, z  # noqa: F401

ALL_CAPABILITIES = ["remote_close_v2", "card_refund_next_shift", "device_logs_v1", "remote_close_force_v1"]


def test_every_capability_of_every_branch_survives_both_cleaners():
    assert G.NEXT_SHIFT_CAPABILITY == "card_refund_next_shift"
    assert svc.REMOTE_CLOSE_CAPABILITY == "remote_close_v2"
    assert F.CAPABILITY == "remote_close_force_v1"
    assert device_logs.CAPABILITY == "device_logs_v1"
    assert sorted(svc.clean_capabilities(ALL_CAPABILITIES)) == sorted(ALL_CAPABILITIES)
    assert device_logs.clean_capabilities(ALL_CAPABILITIES) == sorted(ALL_CAPABILITIES)


def _forced_tills(g):
    for t in g.tills:
        t.capabilities = list(ALL_CAPABILITIES)
    g.db.commit()
    return g


def test_a_forced_shop_close_is_still_held_by_an_owed_cloud_refund(g):
    _forced_tills(g)
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    p = svc.shop_preview(g.db, g.shop, user=g.admin, now=NOW)
    assert p["shopClose"]["available"] is False and p["shopClose"]["whyNot"] == MESSAGE
    # by the till's default (on), and by the manager's tick: neither passes the gate
    for force in (None, True):
        e = refused(svc.shop_request, g.db, g.admin, g.tenant.id, g.shop, totals_key=p["totalsKey"],
                    confirm_cloud_data=True, force=force, now=NOW)
        assert e.detail["code"] == "shop_close_unavailable" and e.detail["message"] == MESSAGE


def test_a_super_admins_reason_passes_the_gate_and_the_run_is_forced(g):
    _forced_tills(g)
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    p = svc.shop_preview(g.db, g.shop, user=g.admin, now=NOW)
    run = svc.shop_request(g.db, g.admin, g.tenant.id, g.shop, totals_key=p["totalsKey"], confirm_cloud_data=True,
                           force=True, force_cloud_refund_reason="ה-Z נדרש היום", now=NOW)
    assert isinstance(run, ZRun) and run.status == ZRunStatus.COMPLETED


def test_a_forced_run_waiting_for_a_note_still_holds_the_build(g):
    _forced_tills(g)
    s1 = selling(g, g.t1, 1, "100.00")
    s2 = selling(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    run = start(g, force=True)  # the tills are asked forced; the cloud refund is owed by Till 1
    assert all(bool(i.remote_force) for i in run.items)
    till_closes(g, g.t1, s1)
    till_closes(g, g.t2, s2)
    from app.routers import device_commands as R

    progress = R.get_shop_close(run.id, **_ctx(g))
    # the note lands in the shift the close closes (the till issues it first), or the build waits — never a Z without it
    assert progress["status"] in ("waiting", "completed")
    if progress["status"] == "waiting":
        assert progress["cloudRefundsHold"] is True


def test_a_forced_till_z_request_is_still_refused_for_an_owed_note(g):
    _forced_tills(g)
    g.t1.z_mode = "till"
    g.db.commit()
    closed(g, g.t1, 1, "100.00")
    owed(g, g.t1)
    p = svc.preview(g.db, g.t1, now=NOW)
    assert p["canRequest"] is False and p["whyNot"] == MESSAGE
    for force in (None, True):
        e = refused(svc.request, g.db, g.admin, g.t1, totals_key=p["totalsKey"], force=force, now=NOW)
        assert e.status_code == 409 and e.detail["message"] == MESSAGE
