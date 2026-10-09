"""
The independent review of remote Z / the shop day close / "חסימת Z כשיש משמרות פתוחות" (09.10.2026):
"enable after fixes". Each fix with the reviewer's probe where there was one (the probes'
expectations are inverted: they showed the hole, these show it closed).
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.kiosk_ops import KioskCloseRequest
from app.models.shift import ShiftStatus
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunStatus
from app.routers import device_commands as R
from app.routers import z_runs as z_runs_router
from app.schemas.z_run import ZRunCreateIn
from app.services import ably_notify
from app.services import remote_close
from app.services import remote_till_z as svc
from app.services import till_parameters as TP
from app.services import z_runs as ZR
from app.services import z_shift_guard as G
from app.services.z_sequence import last_shop_z_number
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, item_of, preview, selling, start, till_closes, z  # noqa: F401


def supervisor_with_full_access(w):
    from app.models.dashboard_access import DashboardAccessProfile
    from app.services import dashboard_access as DA

    sup = User(id=uuid.uuid4(), role=UserRole.SHIFT_SUPERVISOR, tenant_id=w.tenant.id, email="s@x", username="sup",
               shop_id=w.shop.id)
    w.db.add(sup)
    w.db.flush()
    w.db.add(DashboardAccessProfile(user_id=sup.id, full_access=True, sections={}))
    w.db.flush()
    DA.forget(w.db)
    return sup


# ── 1. A cashier / shift supervisor never asks a till for a remote close or Z ────


def test_probe_a_shift_supervisor_with_full_access_is_refused_every_remote_z_route(z):
    sup = supervisor_with_full_access(z)
    selling(z, z.t1, 1, "10.00")
    z.db.commit()
    ctx = dict(current_user=sup, active_tenant_id=z.tenant.id, db=z.db)
    for call in (
        lambda: R.get_close_preview(z.t1.id, **ctx),
        lambda: R.post_remote_close(R.RemoteCloseIn(machineId=z.t1.id, totalsKey="x"), **ctx),
        lambda: R.get_shop_close_preview(shop_id=z.shop.id, **ctx),
        lambda: R.post_shop_close(R.ShopCloseIn(shopId=z.shop.id, totalsKey="x"), **ctx),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 403
    assert z.sent == [] and z.db.query(ZRun).count() == 0
    # The routes' dependency is the machine admins' too.
    import inspect

    for fn in (R.get_close_preview, R.post_remote_close):
        assert "get_current_machine_admin" in inspect.getsource(fn)


# ── 2. Flag off: exactly as before ─────────────────────────────────────────────


def test_probe_flag_off_the_force_is_refused_and_block_keeps_its_meaning(w, monkeypatch, z_activity_unchecked):  # noqa: F811
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED", raising=False)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    w.issued = {}
    t1, t2 = w.tills
    s1 = selling(w, t1, 1, "10.00")
    selling(w, t2, 1, "20.00")
    set_param(w, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", w.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
    w.db.commit()
    out = z_runs_router.post_z_run(
        ZRunCreateIn(shopId=w.shop.id, machines=[{"machineId": str(t1.id)}, {"machineId": str(t2.id)}], confirmCloudData=True),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    run_id = uuid.UUID(str(out["id"]))
    till_closes(w, t1, s1)
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run_proceed(run_id, z_runs_router.ZRunProceedIn(excludeMachineIds=[t2.id]),
                                         current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.detail["code"] == "all_tills_required"
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run_force(run_id, z_runs_router.ZRunForceIn(excludeMachineIds=[t2.id], reason="probe reason"),
                                       current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 404 and e.value.detail["code"] == "remote_till_z_off"
    run = w.db.get(ZRun, run_id)
    assert run.status == ZRunStatus.WAITING and run.z_report_id is None
    # Off, the rule reads as off: the tills get false and nothing is required.
    assert G.required(w.db, w.shop) is False
    assert TP.till_parameters_for_machine(w.db, t1).parameters[G.KEY] is False


def test_the_force_passes_only_the_open_shifts_rule_never_block_or_local(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    set_param(z, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", z.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
    run = start(z)
    till_closes(z, z.t1, s1)
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_force(run.id, R.ShopCloseForceIn(excludeMachineIds=[z.t2.id], reason="המכשיר לא נדלק"), **_ctx(z))
    # The open-shifts rule is forced past; "חובה לסגור את כל הקופות" still holds as always.
    assert e.value.status_code == 409 and e.value.detail["code"] == "all_tills_required"
    z.db.refresh(run)
    assert run.status == ZRunStatus.WAITING
    # The open-shifts rule off, "block" alone: nothing to force.
    set_param(z, G.KEY, "shop", z.shop.id, False)
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_force(run.id, R.ShopCloseForceIn(excludeMachineIds=[z.t2.id], reason="המכשיר לא נדלק"), **_ctx(z))
    assert e.value.detail["code"] == "force_not_applicable"


# ── 3. A ready till still waiting for documents is leaving too ─────────────────


def test_probe_rule_on_a_ready_till_waiting_for_documents_is_not_left_out_quietly(z):
    s1 = z.shift(z.t1, 1, status=ShiftStatus.OPEN)
    z.doc(z.t1, s1, "10.00", number="10001")
    z.doc(z.t1, s1, "10.00", number="10003")  # 10002 missing
    s2 = selling(z, z.t2, 1, "20.00")
    z.db.flush()
    run = start(z)
    till_closes(z, z.t1, s1)
    till_closes(z, z.t2, s2)
    z.db.refresh(run)
    assert run.status == ZRunStatus.WAITING and G.required(z.db, z.shop) is True
    before = last_shop_z_number(z.db, z.shop.id)
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t1.id]), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE and e.value.detail["machineIds"] == [str(z.t1.id)]
    z.db.refresh(run)
    assert run.status == ZRunStatus.WAITING and last_shop_z_number(z.db, z.shop.id) == before
    # The master till's typed "סגור" is the same proceed: refused too.
    with pytest.raises(HTTPException) as e:
        ZR.proceed_without(z.db, run, [z.t1.id], deferred_by="דנה")
    assert e.value.detail["code"] == G.REFUSED_CODE
    # Rule off: today's behaviour — the till is left for the next Z.
    set_param(z, G.KEY, "shop", z.shop.id, False)
    z.db.commit()
    run = z.db.get(ZRun, run.id)
    out = R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t1.id]), **_ctx(z))
    assert out["status"] == ZRunStatus.COMPLETED and out["zNumber"] == before + 1


# ── 4. One start at a time per shop ────────────────────────────────────────────


def test_a_start_takes_the_shops_lock_before_the_run_in_progress_check(z, monkeypatch):
    order = []
    monkeypatch.setattr(ZR, "lock_shop_z_start", lambda db, shop_id: order.append(("lock", shop_id)))
    original = ZR._live_items
    monkeypatch.setattr(ZR, "_live_items", lambda db, ids: order.append(("live", None)) or original(db, ids))
    selling(z, z.t1, 1, "10.00")
    start(z)
    assert order[:2] == [("lock", z.shop.id), ("live", None)]


def test_the_lock_is_postgres_advisory_and_a_no_op_elsewhere(z):
    # SQLite (this world): nothing to do, nothing raised.
    ZR.lock_shop_z_start(z.db, z.shop.id)
    import inspect

    src = inspect.getsource(ZR.lock_shop_z_start)
    assert "pg_advisory_xact_lock" in src and "with_for_update" in src


# ── 5. Who decided ─────────────────────────────────────────────────────────────


def test_who_left_a_till_out_and_who_cancelled_are_recorded(z):
    set_param(z, G.KEY, "shop", z.shop.id, False)
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    till_closes(z, z.t1, s1)
    out = R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    zr = z.db.get(ZReport, uuid.UUID(str(out["zReportId"])))
    (left,) = zr.header["openTillsLeftOut"]["tills"]
    assert left["id"] == str(z.t2.id) and left["confirmedBy"] == "admin"

    # The wizard's proceed records the user too.
    s3 = selling(z, z.t1, 2, "5.00")
    run2 = start(z)
    till_closes(z, z.t1, s3)
    out2 = z_runs_router.post_z_run_proceed(run2.id, z_runs_router.ZRunProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert out2.status == ZRunStatus.COMPLETED if hasattr(out2, "status") else out2["status"] == ZRunStatus.COMPLETED
    zr2 = z.db.get(ZReport, z.db.get(ZRun, run2.id).z_report_id)
    assert zr2.header["openTillsLeftOut"]["tills"][0]["confirmedBy"] == "admin"

    # Cancelled: by whom, on the run.
    selling(z, z.t1, 3, "7.00")
    run3 = start(z)
    cancelled = R.post_shop_close_cancel(run3.id, **_ctx(z))
    assert cancelled["errorMessage"] == "בוטל ע״י admin"


# ── 6. Tills too old for `waitForRest` ─────────────────────────────────────────


def test_a_till_too_old_for_wait_for_rest_is_never_asked(z, monkeypatch):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.t2.app_version = "0.1.320+aaaaaaa-device"
    z.db.flush()
    p = preview(z)
    assert p["shopClose"]["available"] is False and p["shopClose"]["whyNot"].startswith(svc.TOO_OLD_TEXT)
    row = next(r for r in p["inShopZ"] if r["machineId"] == str(z.t2.id))
    assert row["action"]["whyNot"] == "הקופה צריכה עדכון גרסה לפני סגירה מרחוק"
    till = svc.preview(z.db, z.t2, now=NOW)
    assert till["canRequest"] is False and till["whyNot"] == svc.TOO_OLD_TEXT
    with pytest.raises(HTTPException):
        svc.request(z.db, z.admin, z.t2, totals_key=till["totalsKey"], now=NOW)
    with pytest.raises(HTTPException) as e:
        svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=p["totalsKey"], now=NOW)
    assert e.value.detail["code"] == "shop_close_unavailable"
    # A version never reported is too old as well; the release build can raise the floor.
    z.t2.app_version = None
    assert svc.too_old(z.t2)
    z.t2.app_version = "0.1.334+c21f40d-device"
    assert not svc.too_old(z.t2)
    monkeypatch.setenv("REMOTE_TILL_Z_MIN_TILL_VERSION", "340")
    assert svc.too_old(z.t2)
    assert z.sent == []


# ── 7. Fail closed ─────────────────────────────────────────────────────────────


def test_an_unreadable_rule_reads_as_on(z, monkeypatch):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    set_param(z, G.KEY, "shop", z.shop.id, False)
    run = start(z)
    till_closes(z, z.t1, s1)

    def broken(*a, **k):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(G, "_value", broken)
    assert G.required(z.db, z.shop) is True
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE
    # Everything unreadable: still on, never off — the expiry builds nothing without the till.
    monkeypatch.setattr(ZR, "open_tills_rule", broken)
    assert ZR._all_tills_required(z.db, z.db.get(ZRun, run.id)) == "shifts"
    ZR.expire_overdue_runs(z.db, now=NOW + timedelta(hours=40))
    assert z.db.get(ZRun, run.id).z_report_id is None


# ── 8. A cancelled day close withdraws the kiosks asked to close with it ───────


def test_cancel_withdraws_the_kiosks_close_with_the_shop_z(z, monkeypatch):
    from app.services import kiosk_config as KC
    from app.services import kiosk_ops

    z.t2.z_mode = "till"
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    monkeypatch.setattr(KC, "effective_config", lambda db, m: {"operations": {"closeWithShopZ": True}})
    monkeypatch.setattr(kiosk_ops, "wake_machine", lambda *a, **k: None)
    selling(z, z.t1, 1, "10.00")
    z.db.flush()
    run = start(z)
    (req,) = z.db.query(KioskCloseRequest).all()
    assert req.state == "pending" and req.source_ref == str(run.id)
    R.post_shop_close_cancel(run.id, **_ctx(z))
    z.db.refresh(req)
    assert req.state == "cancelled"
    # Never handed to the kiosk again.
    assert kiosk_ops.pending_close_for_kiosk(z.db, z.t2) is None


# ── 9. The nits ────────────────────────────────────────────────────────────────


def test_a_till_the_cloud_cannot_see_is_unknown_and_holds_the_start_unless_support_forces(z):
    from app.models.audit_exception import AuditException

    selling(z, z.t1, 1, "10.00")
    z.t2.last_heartbeat_at = NOW - timedelta(hours=5)  # off since, no shift the cloud knows of
    z.db.flush()
    p = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)
    (b,) = [b for b in p["shiftGuard"]["blockers"] if b["machineId"] == str(z.t2.id)]
    assert b["status"] == "unknown" and b["words"] == "מצב לא ידוע — ייתכן שיש משמרת פתוחה"
    assert p["shopClose"]["available"] is False and p["shopClose"]["forceStartAllowed"] is True
    # A manager: no start, and no force.
    mgr = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=z.tenant.id, email="m@x", username="mgr",
               shop_id=z.shop.id)
    z.db.add(mgr)
    z.db.flush()
    assert svc.shop_preview(z.db, z.shop, now=NOW, user=mgr)["shopClose"]["forceStartAllowed"] is False
    with pytest.raises(HTTPException) as e:
        svc.shop_request(z.db, mgr, z.tenant.id, z.shop, totals_key=p["totalsKey"], confirm_cloud_data=True,
                         force_reason="לא נדלקת", now=NOW)
    assert e.value.status_code == 409
    # The wizard's start: the same rule, at the run itself.
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run(ZRunCreateIn(shopId=z.shop.id, machines=[{"machineId": str(z.t1.id)}],
                                              confirmCloudData=True), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE and e.value.detail["tills"][0]["status"] == "unknown"
    # Support forces the start with a reason: started, and recorded on its own.
    run = svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=p["totalsKey"], confirm_cloud_data=True,
                           force_reason="הקופה מושבתת לתיקון", now=NOW)
    assert isinstance(run, ZRun)
    (rec,) = z.db.query(AuditException).filter(AuditException.exception_type == G.EXCEPTION_TYPE).all()
    assert rec.details["kind"] == "forced_start_unknown_tills" and rec.details["reason"] == "הקופה מושבתת לתיקון"


def test_the_forced_record_does_not_depend_on_the_tenants_rules(z):
    from app.models.audit_exception import AuditException, ExceptionRuleValue

    z.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=z.tenant.id, scope_type="tenant", scope_id=z.tenant.id,
                                exception_type=G.EXCEPTION_TYPE, enabled=False))
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    till_closes(z, z.t1, s1)
    R.post_shop_close_force(run.id, R.ShopCloseForceIn(excludeMachineIds=[z.t2.id], reason="המכשיר לא נדלק"), **_ctx(z))
    (rec,) = z.db.query(AuditException).filter(AuditException.exception_type == G.EXCEPTION_TYPE).all()
    assert rec.details["kind"] == "forced_past_open_shifts"
    from app.services.exception_alerts.catalog import kind_spec

    assert kind_spec(G.EXCEPTION_TYPE).label == "Z סניפי הופק בכפייה בלי קופות שלא נסגרו"


def test_one_till_per_z_the_rule_holds_for_the_zs_own_till(z):
    z.tenant.settings = {**(z.tenant.settings or {}), "zScope": "machine"}
    selling(z, z.t1, 1, "10.00")
    z.db.flush()
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run(ZRunCreateIn(shopId=z.shop.id, machines=[
            {"machineId": str(z.t1.id), "includeOpenShift": False}], confirmCloudData=True), **_ctx(z))
    assert e.value.detail["code"] == "open_tills_block_z"


def test_no_z_mode_switch_while_remote_controls_shift_close_is_pending(z):
    from app.services import till_z

    selling(z, z.t1, 1, "10.00")
    p = svc.preview(z.db, z.t1, now=NOW)
    svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"], now=NOW)
    with pytest.raises(till_z.TillZRefused) as e:
        till_z.set_z_mode(z.db, z.t1, "till", now=NOW)
    assert e.value.body["detail"] == "remote_close_pending"


def test_a_forced_till_z_request_is_never_handed_to_remote_control(z):
    from app.services import till_z

    z.t1.z_mode = "till"
    selling(z, z.t1, 1, "10.00")
    z.db.flush()
    monkeypatched = []
    till_z.request_for_machine(z.db, z.admin, z.t1, force=True, now=NOW)
    p = svc.preview(z.db, z.t1, now=NOW)
    assert p["canRequest"] is False and p["whyNot"] == svc.FORCED_PENDING_TEXT
    with pytest.raises(HTTPException):
        svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"], now=NOW)
    assert monkeypatched == []


def test_the_preview_counts_what_the_build_takes_besides(z, monkeypatch):
    from app.services import document_filing

    selling(z, z.t1, 1, "10.00")
    other = selling(z, z.t2, 1, "25.00")
    z.t2.z_mode = "till"
    z.db.flush()
    monkeypatch.setattr(document_filing, "shop_leftovers", lambda db, shop_id, exclude=(), lock=False: [(z.t2, [other])])
    p = preview(z)
    assert p["leftovers"] == [{"machineId": str(z.t2.id), "name": z.t2.name, "posNumber": z.t2.pos_number,
                               "shifts": 1, "net": 25.0}]
    assert p["totals"]["totalSales"] == 35.0
