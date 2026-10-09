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
    # "חובה לסגור את כל הקופות" is what holds it: nothing for support's force (it passes the open-shifts
    # rule only); the setting keeps its own meaning and paths.
    assert e.value.status_code == 409 and e.value.detail["code"] == "force_not_applicable"
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert e.value.detail["code"] == "all_tills_required"
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
    # The advisory lock only — the shop's Z counter row is not held through the start (only a build takes it).
    assert "pg_advisory_xact_lock" in src and "with_for_update" not in src
    key = ZR.shop_z_start_key(z.shop.id)
    assert -(2 ** 63) <= key < 2 ** 63


def test_the_start_lock_comes_before_the_expiry_sweep(z, monkeypatch):
    order = []
    monkeypatch.setattr(ZR, "lock_shop_z_start", lambda db, shop_id: order.append("lock"))
    original = ZR.expire_overdue_runs
    monkeypatch.setattr(ZR, "expire_overdue_runs", lambda db, now=None: order.append("sweep") or original(db, now=now))
    selling(z, z.t1, 1, "10.00")
    start(z)
    assert order[:2] == ["lock", "sweep"]


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


# ── 6. Tills without the remote-close capability ──────────────────────────────


def test_a_till_without_the_remote_close_capability_is_never_asked(z, monkeypatch):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.t2.capabilities = None  # an older build says nothing
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
    # Not a version count: any version name, the capability decides.
    z.t2.app_version = "0.1.999+abc-device"
    assert svc.needs_update(z.t2)
    z.t2.capabilities = ["something_else", svc.REMOTE_CLOSE_CAPABILITY]
    z.t2.app_version = "0.1.12+abc-device"
    assert not svc.needs_update(z.t2)
    assert svc.REMOTE_CLOSE_CAPABILITY == "remote_close_v2"
    assert z.sent == []


def test_the_optional_floor_is_a_number_or_refused_loudly(z, monkeypatch):
    z.t1.capabilities = [svc.REMOTE_CLOSE_CAPABILITY]
    z.t1.app_version = "0.1.350+abc-device"
    monkeypatch.delenv(svc.MIN_VERSION_ENV, raising=False)
    assert svc.min_version_code() is None and not svc.needs_update(z.t1)
    monkeypatch.setenv(svc.MIN_VERSION_ENV, "352")
    assert svc.needs_update(z.t1)
    monkeypatch.setenv(svc.MIN_VERSION_ENV, "350")
    assert not svc.needs_update(z.t1)
    # The verifier's probe: a version name is not silently ignored — the server refuses to start.
    monkeypatch.setenv(svc.MIN_VERSION_ENV, "0.1.340")
    with pytest.raises(ValueError):
        svc.check_config()
    with pytest.raises(ValueError):
        svc.min_version_code()
    from app import main

    with pytest.raises(ValueError):
        main.check_remote_till_z_config()


def test_a_kiosk_without_the_capability_never_holds_the_day_close(z):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.t2.capabilities = None  # a Windows kiosk: its own Z path, no capability
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    z.db.flush()
    p = preview(z)
    assert p["shopClose"]["available"] is True
    kiosk = next(r for r in p["inShopZ"] if r["machineId"] == str(z.t2.id))
    assert "needsUpdate" not in kiosk and kiosk["action"]["whyNot"] == "קיוסק — מלשונית הקיוסקים"


def test_the_heartbeat_stores_what_the_build_can_do(z):
    from app.routers import machines as machines_router
    from app.schemas.pos_machine import MachineHeartbeatBody

    z.t1.capabilities = None
    machines_router.post_my_heartbeat(
        MachineHeartbeatBody.model_validate({"capabilities": ["remote_close_v2", 7, ""]}), machine=z.t1, db=z.db,
    )
    assert z.t1.capabilities == ["remote_close_v2"]
    # A build that no longer says it (a downgrade) is no longer asked; junk never 422s.
    machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate({}), machine=z.t1, db=z.db)
    assert z.t1.capabilities is None
    machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate({"capabilities": "x"}), machine=z.t1, db=z.db)
    assert z.t1.capabilities is None


# ── 7. Fail closed ─────────────────────────────────────────────────────────────


def test_an_unreadable_rule_reads_as_on(z, monkeypatch):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    set_param(z, G.KEY, "shop", z.shop.id, False)
    run = start(z)
    till_closes(z, z.t1, s1)

    def broken(*a, **k):
        raise RuntimeError("db hiccup")

    import app.services.till_parameters as TPmod

    monkeypatch.setattr(TPmod, "till_parameters_for_machine", broken)
    assert G.till_required(z.db, z.t2) is True and G.required(z.db, z.shop) is True
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
    z.t2.last_heartbeat_at = None  # never reported: its state is unknown
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


# ── The offline-till rule (the coordinator, 09.10): block only when the state is unknown ──


def test_offline_since_a_report_of_no_shift_open_does_not_block_and_is_warned_and_recorded(z):
    from app.routers import till_shop_z_local as LR

    s1 = selling(z, z.t1, 1, "10.00")
    # Till 2's last report: no shift open, nothing pending; it went offline after that.
    z.t2.reported_open_shift_id = None
    z.t2.pending_documents = 0
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=8)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=8)
    z.db.flush()

    p = preview(z)
    assert [b["machineId"] for b in p["shiftGuard"]["blockers"]] == [str(z.t1.id)]  # only the till selling
    (oc,) = p["shiftGuard"]["offlineClosed"]
    assert oc["machineId"] == str(z.t2.id) and oc["words"] == "לא מחובר — המשמרת האחרונה סגורה"
    assert oc["blocks"] is False
    assert p["shopClose"]["available"] is True
    # The main till is not held by it either.
    assert [b["machineId"] for b in LR.till_shop_z_shift_guard(str(z.t1.id), machine=z.t1, db=z.db)["blockers"]] == []

    run = start(z)
    progress = svc.run_progress(z.db, run, now=NOW)
    assert progress["warnings"] == [f"{z.t2.name}: {G.OFFLINE_CLOSED_WARNING}"]
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    # Recorded on the Z itself.
    zr = z.db.get(ZReport, run.z_report_id)
    (left,) = zr.header["openTillsLeftOut"]["tills"]
    assert left["id"] == str(z.t2.id) and left["reason"] == "offline_last_closed" and left["openShiftId"] is None


def test_offline_with_an_open_shift_or_never_reported_blocks(z):
    from app.models.shift import Shift as ShiftRow

    selling(z, z.t1, 1, "10.00")
    # Its last report had a shift open (the cloud has not seen it): blocks, as an open shift.
    z.t2.reported_open_shift_id = uuid.uuid4()
    z.t2.last_heartbeat_at = NOW - timedelta(hours=8)
    z.db.flush()
    (b,) = [b for b in preview(z)["shiftGuard"]["blockers"] if b["machineId"] == str(z.t2.id)]
    assert b["status"] == G.STATUS_OPEN and b["words"] == "מנותקת · משמרת פתוחה"
    assert preview(z)["shiftGuard"]["offlineClosed"] == []

    # Its last report had a shift open that the cloud holds closed — what is open now is unknown.
    closed = till_closes(z, z.t2, selling(z, z.t2, 1, "5.00"))
    z.t2.reported_open_shift_id = closed.id
    z.t2.last_heartbeat_at = NOW - timedelta(hours=8)
    z.db.flush()
    assert z.db.get(ShiftRow, closed.id) is not None
    (b,) = [b for b in preview(z)["shiftGuard"]["blockers"] if b["machineId"] == str(z.t2.id)]
    assert b["status"] == G.STATUS_UNKNOWN and b["words"] == "מצב לא ידוע — ייתכן שיש משמרת פתוחה"
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run(ZRunCreateIn(shopId=z.shop.id, machines=[{"machineId": str(z.t1.id)}],
                                              confirmCloudData=True), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE

    # Never reported at all: unknown, blocks; only a super admin starts anyway, with a reason.
    z.t2.reported_open_shift_id = None
    z.t2.last_heartbeat_at = None
    z.db.flush()
    p = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)
    assert p["shopClose"]["available"] is False and p["shopClose"]["forceStartAllowed"] is True
    run = svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=p["totalsKey"], confirm_cloud_data=True,
                           force_reason="הקופה לא הותקנה עדיין", now=NOW)
    assert isinstance(run, ZRun)


# ── The verification's findings (09.10, second round) ───────────────────────────


def test_the_pushes_go_only_after_the_commit_and_never_after_a_rollback(z, monkeypatch):
    from app.services import till_z

    selling(z, z.t1, 1, "10.00")
    z.db.commit()
    p = svc.preview(z.db, z.t1, now=NOW)
    svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"], now=NOW)
    assert z.sent == []  # not yet committed: a till hearing it would find no such request
    z.db.rollback()
    z.db.commit()
    assert z.sent == []  # rolled back: never sent
    p = svc.preview(z.db, z.t1, now=NOW)
    svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"], now=NOW)
    z.db.commit()
    assert len(z.sent) == 1 and z.sent[0].get("wait_for_rest") is True
    # A till Z request too (its own push).
    sent = []
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: sent.append(k))
    z.t2.z_mode = "till"
    selling(z, z.t2, 1, "5.00")
    z.db.flush()
    till_z.request_for_machine(z.db, z.admin, z.t2, wait_for_rest=True, now=NOW)
    assert sent == []
    z.db.commit()
    assert len(sent) == 1


def test_probe_v1_an_offline_closed_till_the_run_takes_is_not_listed_left_out(z):
    from app.models.shift import Shift

    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "25.00")
    till_closes(z, z.t2, s2)  # closed and accepted while online
    z.t2.reported_open_shift_id = None
    z.t2.pending_documents = 0
    z.t2.reported_open_shift_claimed_at = NOW + timedelta(hours=1)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=8)
    z.db.flush()
    run = start(z)
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    zr = z.db.get(ZReport, run.z_report_id)
    assert z.db.get(Shift, s2.id).z_report_id == zr.id  # taken by this Z ...
    assert not (zr.header.get("openTillsLeftOut") or {}).get("tills")  # ... so never "left out"


def test_the_offline_closed_tills_print_on_their_own_line_without_approval(z):
    from app.services import z_print

    s1 = selling(z, z.t1, 1, "10.00")
    z.t2.reported_open_shift_id = None
    z.t2.pending_documents = 0
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=8)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=8)
    z.db.flush()
    run = start(z)
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    footer = z_print._footer_notes(z.db.get(ZReport, run.z_report_id))
    line = next(f for f in footer if f.startswith("קופות לא מחוברות"))
    assert line == f"קופות לא מחוברות (משמרת אחרונה סגורה): {z.t2.pos_number}"
    assert not any("אושר ע״י" in f for f in footer)


def test_probe_v3_offline_with_documents_still_pending_is_unknown_and_blocks(z):
    selling(z, z.t1, 1, "10.00")
    z.t2.reported_open_shift_id = None
    z.t2.pending_documents = 3
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=2)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=2)
    z.db.flush()
    (b,) = [b for b in preview(z)["shiftGuard"]["blockers"] if b["machineId"] == str(z.t2.id)]
    assert b["status"] == G.STATUS_UNKNOWN
    # Did not say how many: unknown too.
    z.t2.pending_documents = None
    z.t2.pending_count = None
    z.db.flush()
    assert [b["status"] for b in preview(z)["shiftGuard"]["blockers"] if b["machineId"] == str(z.t2.id)] == [G.STATUS_UNKNOWN]


def test_a_closed_claim_counts_only_when_the_till_said_it_after_its_last_shift(z):
    from app.services.administrative_close import close_shift_administratively

    s2 = selling(z, z.t2, 1, "20.00")
    z.t2.reported_open_shift_id = s2.id
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=1)
    z.t2.pending_documents = 0
    z.t2.last_heartbeat_at = NOW - timedelta(hours=1)
    z.db.flush()
    # Support closes it administratively: the till's claim is not wiped ...
    close_shift_administratively(z.db, z.t2, s2, z.admin, force=True, now=NOW)
    assert z.t2.reported_open_shift_id == s2.id
    (b,) = [b for b in G.shop_blockers(z.db, z.shop, now=NOW) if b["machineId"] == str(z.t2.id)]
    assert b["status"] == G.STATUS_UNKNOWN  # it may still be selling offline into it
    # ... and a "none open" from before the cloud's last shift of it says nothing either.
    z.t2.reported_open_shift_id = None
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=1)
    z.db.flush()
    assert [b["status"] for b in G.shop_blockers(z.db, z.shop, now=NOW) if b["machineId"] == str(z.t2.id)] == [G.STATUS_UNKNOWN]
    # Said by the till after it: trusted.
    z.t2.reported_open_shift_claimed_at = NOW + timedelta(days=1)
    z.db.flush()
    assert [b for b in G.shop_blockers(z.db, z.shop, now=NOW) if b["machineId"] == str(z.t2.id)] == []


def test_only_the_tills_own_readable_report_writes_the_claims_time(z):
    from app.routers import machines as machines_router
    from app.schemas.pos_machine import MachineHeartbeatBody

    z.t1.reported_open_shift_claimed_at = None
    machines_router.post_my_heartbeat(None, machine=z.t1, db=z.db)  # no body: says nothing
    assert z.t1.reported_open_shift_claimed_at is None
    body = MachineHeartbeatBody.model_validate({"openShiftId": "not-a-uuid"})
    if getattr(body, "open_shift_id_unreadable", False):
        machines_router.post_my_heartbeat(body, machine=z.t1, db=z.db)  # unreadable: the claim stays as it was
        assert z.t1.reported_open_shift_claimed_at is None
    machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate({}), machine=z.t1, db=z.db)
    assert z.t1.reported_open_shift_claimed_at is not None


def test_the_force_is_offered_only_when_the_open_shifts_rule_is_what_blocks(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    till_closes(z, z.t1, s1)
    assert svc.run_progress(z.db, run, now=NOW, user=z.admin)["forceAllowed"] is True
    set_param(z, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", z.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
    assert svc.run_progress(z.db, run, now=NOW, user=z.admin)["forceAllowed"] is False
    z.db.commit()
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert e.value.detail["canForce"] is False


def test_a_kiosks_late_done_after_a_cancel_keeps_the_cancellation(z, monkeypatch):
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
    R.post_shop_close_cancel(run.id, **_ctx(z))
    kiosk_ops.apply_close_result(z.db, z.t2, {"id": str(req.id), "state": "done", "zNumber": 7})
    z.db.refresh(req)
    assert req.state == "cancelled"
    assert req.result["detail"] == "בוצע לאחר ביטול" and req.result["afterCancel"] is True and req.result["zNumber"] == 7


def test_a_close_shift_ack_sweeps_expired_requests_first(z):
    from app.models.shift_close_request import ShiftCloseRequest

    selling(z, z.t1, 1, "10.00")
    p = svc.preview(z.db, z.t1, now=NOW)
    out = svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"], now=NOW)
    z.db.commit()
    req = z.db.get(ShiftCloseRequest, uuid.UUID(str(out["request"]["id"])))
    req.expires_at = NOW - timedelta(minutes=1)  # overdue, not swept yet
    z.db.commit()
    status_after = remote_close.apply_close_shift_ack(z.db, z.t1, request_id=req.id, phase="received")
    assert status_after == "expired"


def test_a_claim_the_cloud_holds_closed_is_not_read_as_open_anywhere(z):
    """An administrative close keeps the till's claim; readers take it only while it may still be open."""
    from app.services import remote_credits
    from app.services.administrative_close import close_shift_administratively

    s2 = selling(z, z.t2, 1, "20.00")
    z.t2.reported_open_shift_id = s2.id
    z.db.flush()
    assert remote_credits.open_shift_of(z.db, z.t2)["id"] == str(s2.id)
    close_shift_administratively(z.db, z.t2, s2, z.admin, force=True, now=NOW)
    assert z.t2.reported_open_shift_id == s2.id  # kept as the till reported it
    assert remote_credits.open_shift_of(z.db, z.t2) is None  # but not read as open
