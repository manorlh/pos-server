"""
"חסימת Z כשיש משמרות פתוחות" (app/services/z_shift_guard.py) — the owner: "פרמטר: אם כל המשמרות
לא נסגרו — אל תאפשר לסגור זד. לתמיכה: לאפשר לסופר אדמין לכפות סגירה, ואז המשמרת הבאה תיכנס לזד
הבא (אם המכשיר לא נדלק וכו')".

On (the default, with REMOTE_TILL_Z_ENABLED): no shop Z while a till has a shift open or not yet
accepted — not leaving it out at the start, not "build without", not the expiry; the dashboard
sees which tills and why; the main till asks before its local shop Z. Only a super admin forces
past it, with a typed reason: recorded on the Z and as an exception, the till's shifts in the next
Z, the numbering unbroken. Off: today's behaviour.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.shop_area import ShopArea
from app.models.shift import Shift
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.routers import device_commands as R
from app.routers import till_shop_z_local as LR
from app.routers import z_runs as z_runs_router
from app.schemas.z_run import ZRunCreateIn
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


def manager(w):
    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="m@x", username="manager",
             shop_id=w.shop.id)
    w.db.add(u)
    w.db.flush()
    return u


def off(w, scope="shop", scope_id=None):
    set_param(w, G.KEY, scope, scope_id or w.shop.id, False)


# ── The parameter ─────────────────────────────────────────────────────────────


def test_registered_on_by_default_and_only_with_the_flag(z, monkeypatch):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == G.KEY]
    assert spec.label == "חסימת Z כשיש משמרות פתוחות" and spec.value_type == "boolean" and spec.default_value is True
    assert G.required(z.db, z.shop) is True
    assert TP.till_parameters_for_machine(z.db, z.t1).parameters[G.KEY] is True
    # Off with the flag: nothing applies, and the tills read it as off.
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED")
    assert G.required(z.db, z.shop) is False
    assert TP.till_parameters_for_machine(z.db, z.t1).parameters[G.KEY] is False


def test_company_shop_and_area_levels(z):
    area = ShopArea(id=uuid.uuid4(), tenant_id=z.tenant.id, shop_id=z.shop.id, name="Bar")
    z.db.add(area)
    z.db.flush()
    off(z, "company", z.shop.company_id)
    assert G.required(z.db, z.shop) is False
    set_param(z, G.KEY, "shop", z.shop.id, True)
    assert G.required(z.db, z.shop) is True
    off(z, "area", area.id)
    assert G.required(z.db, z.shop, area_id=area.id) is False and G.required(z.db, z.shop) is True


# ── On: the Z waits for every till ───────────────────────────────────────────


def test_on_a_till_cannot_be_left_out_at_the_start(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    till_closes(z, z.t1, s1)
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run(
            ZRunCreateIn(shopId=z.shop.id, machines=[{"machineId": str(z.t1.id)}], confirmCloudData=True,
                         confirmOpenTills=True), **_ctx(z))
    assert e.value.status_code == 409 and e.value.detail["code"] == "open_tills_block_z"
    assert [t["id"] for t in e.value.detail["tills"]] == [str(z.t2.id)]


def test_on_the_dashboard_sees_the_blocking_tills_and_build_without_is_refused(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.t2.last_heartbeat_at = NOW - timedelta(hours=3)
    z.db.flush()

    guard = preview(z)["shiftGuard"]
    assert guard["required"] is True and guard["label"] == G.LABEL
    assert {b["machineId"]: b["words"] for b in guard["blockers"]} == {
        str(z.t1.id): "משמרת פתוחה", str(z.t2.id): "מנותקת · משמרת פתוחה",
    }
    run = start(z)
    till_closes(z, z.t1, s1)
    assert [b["machineId"] for b in preview(z)["shiftGuard"]["blockers"]] == [str(z.t2.id)]

    progress = svc.run_progress(z.db, run, now=NOW, user=manager(z))
    assert progress["leaveOutAllowed"] is False and "חסימת Z כשיש משמרות פתוחות" in progress["leaveOutWhyNot"]
    assert progress["forceAllowed"] is False
    assert svc.run_progress(z.db, run, now=NOW, user=z.admin)["forceAllowed"] is True
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE and e.value.detail["canForce"] is True
    # Nor does the expiry build without it.
    ZR.expire_overdue_runs(z.db, now=NOW + timedelta(hours=40))
    z.db.refresh(run)
    assert run.status != ZRunStatus.COMPLETED and run.z_report_id is None


def test_a_till_closed_and_not_yet_accepted_blocks_as_waiting_for_acceptance(z):
    s = selling(z, z.t1, 1, "10.00")
    # The till closed it and opened another; the cloud has not accepted the first close yet.
    z.t1.reported_open_shift_id = uuid.uuid4()
    z.db.flush()
    (b,) = [b for b in G.shop_blockers(z.db, z.shop, now=NOW) if b["machineId"] == str(z.t1.id)]
    assert b["status"] == G.STATUS_PENDING and b["words"] == "ממתין לקבלה"
    z.t1.reported_open_shift_id = s.id
    z.db.flush()
    (b,) = [b for b in G.shop_blockers(z.db, z.shop, now=NOW) if b["machineId"] == str(z.t1.id)]
    assert b["status"] == G.STATUS_OPEN


def test_off_today_behaviour(z):
    off(z)
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    assert preview(z)["shiftGuard"] == {"label": G.LABEL, "required": False, "blockers": []}
    run = start(z)
    till_closes(z, z.t1, s1)
    assert svc.run_progress(z.db, run, now=NOW)["leaveOutAllowed"] is True
    done = R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert done["status"] == ZRunStatus.COMPLETED


# ── The super admin's force ───────────────────────────────────────────────────


def test_only_a_super_admin_and_only_with_a_reason(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    till_closes(z, z.t1, s1)
    with pytest.raises(HTTPException) as e:
        G.force_without(z.db, run, manager(z), [z.t2.id], "the till burnt")
    assert e.value.status_code == 403 and e.value.detail["code"] == "force_super_admin_only"
    with pytest.raises(HTTPException) as e:
        R.post_shop_close_force(run.id, R.ShopCloseForceIn(excludeMachineIds=[z.t2.id], reason="  "), **_ctx(z))
    assert e.value.status_code == 422 and e.value.detail["code"] == "force_reason_required"
    z.db.refresh(run)
    assert run.status == ZRunStatus.WAITING


def test_forced_the_z_says_who_and_why_and_the_tills_shifts_go_into_the_next_z(z):
    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "20.00")
    before = last_shop_z_number(z.db, z.shop.id)
    run = start(z)
    till_closes(z, z.t1, s1)

    out = R.post_shop_close_force(
        run.id, R.ShopCloseForceIn(excludeMachineIds=[z.t2.id], reason="המכשיר לא נדלק"), **_ctx(z))
    assert out["status"] == ZRunStatus.COMPLETED and out["zNumber"] == before + 1
    first = z.db.get(ZReport, uuid.UUID(str(out["zReportId"])))
    (left,) = first.header["openTillsLeftOut"]["tills"]
    assert left["id"] == str(z.t2.id) and left["forced"] is True and left["forcedReason"] == "המכשיר לא נדלק"
    assert left["confirmedBy"] == "admin (תמיכה)"
    # Audited: one exception with who, why and the tills.
    (record,) = z.db.query(AuditException).filter(AuditException.exception_type == G.EXCEPTION_TYPE).all()
    assert record.details["kind"] == "forced_past_open_shifts" and record.details["reason"] == "המכשיר לא נדלק"
    assert record.details["forcedBy"] == "admin" and record.details["tills"][0]["machineId"] == str(z.t2.id)
    assert z.db.get(Shift, s2.id).z_report_id is None  # not lost: waiting

    # The till comes back and closes: the next Z takes its shift, with the very next number.
    run2 = start(z)
    till_closes(z, z.t2, s2)
    z.db.refresh(run2)
    assert run2.status == ZRunStatus.COMPLETED
    second = z.db.get(ZReport, run2.z_report_id)
    assert second.shop_sequence_number == before + 2 == last_shop_z_number(z.db, z.shop.id)
    assert z.db.get(Shift, s2.id).z_report_id == second.id


def test_the_wizards_force_route_is_the_same_force(z):
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z)
    till_closes(z, z.t1, s1)
    with pytest.raises(HTTPException) as e:
        z_runs_router.post_z_run_force(run.id, z_runs_router.ZRunForceIn(excludeMachineIds=[z.t2.id], reason="x"),
                                       **_ctx(z, manager(z)))
    assert e.value.status_code in (403, 422)
    out = z_runs_router.post_z_run_force(
        run.id, z_runs_router.ZRunForceIn(excludeMachineIds=[z.t2.id], reason="לא נדלק מאז אתמול"), **_ctx(z))
    assert out["status"] == ZRunStatus.COMPLETED


# ── The main till asks before its local shop Z ────────────────────────────────


def test_the_main_till_is_told_which_other_tills_block_its_local_shop_z(z, monkeypatch):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    out = LR.till_shop_z_shift_guard(str(z.t1.id), machine=z.t1, db=z.db)
    assert out["required"] is True and [b["machineId"] for b in out["blockers"]] == [str(z.t2.id)]  # never itself
    off(z)
    assert LR.till_shop_z_shift_guard(str(z.t1.id), machine=z.t1, db=z.db) == {"required": False, "blockers": []}
    set_param(z, G.KEY, "shop", z.shop.id, True)
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED")
    assert LR.till_shop_z_shift_guard(str(z.t1.id), machine=z.t1, db=z.db) == {"required": False, "blockers": []}
