"""
"מכירות מושהות" at a remote close / Z / day close (app/services/held_sales_close.py) — the server's half.

The till warns, lists, pays or cancels (pos-android); the cloud: the parameter
`allowCloseWithHeldSales` (company → shop → area, default off), the deferral `held_sales` shown as
"ממתין — מכירות מושהות (N)", the manager's "סגור בכל זאת — המכירות המושהות יישמרו" (the parameter,
or a super admin with a reason; recorded), the `keepHeldSales` the till then hears, and the till event
`held_sale_cancelled` accepted for the audit trail.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException, TillEvent
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.models.z_run import ZRunStatus
from app.routers import device_commands as R
from app.schemas.audit_exception import TillEventIn
from app.services import held_sales_close as H
from app.services import remote_close
from app.services import remote_till_z as svc
from app.services import till_parameters as TP
from app.services.exceptions import record_till_event
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, item_of, selling, start, till_closes, z  # noqa: F401


def manager(w):
    """A shop manager with the Z section (a full-access profile)."""
    from app.models.dashboard_access import DashboardAccessProfile
    from app.services import dashboard_access as DA

    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="mh@x", username="mgr",
             shop_id=w.shop.id)
    w.db.add(u)
    w.db.flush()
    w.db.add(DashboardAccessProfile(user_id=u.id, full_access=True, sections={}))
    w.db.flush()
    DA.forget(w.db)
    return u


def held(z, run, till, n):
    """The till defers its close: it holds `n` held sales."""
    remote_close.apply_close_shift_ack(z.db, till, request_id=item_of(run, till).id, phase="deferred",
                                       error_code=H.DEFER_CODE, error_message=str(n))


def test_the_parameter_is_off_by_default_at_company_shop_and_area(z):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == H.KEY]
    assert spec.value_type == "boolean" and spec.default_value is False and spec.label == "סגירה עם מכירות מושהות"
    assert H.allowed(z.db, z.t1) is False
    set_param(z, H.KEY, "company", z.shop.company_id, True)
    assert H.allowed(z.db, z.t1) is True
    set_param(z, H.KEY, "shop", z.shop.id, False)
    assert H.allowed(z.db, z.t1) is False
    area = ShopArea(id=uuid.uuid4(), tenant_id=z.tenant.id, shop_id=z.shop.id, name="Bar")
    z.db.add(area)
    z.db.flush()
    z.t1.area_id = area.id
    set_param(z, H.KEY, "area", area.id, True)
    assert H.allowed(z.db, z.t1) is True and H.allowed(z.db, z.t2) is False


def test_a_till_holding_sales_defers_and_the_dashboard_says_how_many(z):
    s1 = selling(z, z.t1, 1, "10.00")
    run = start(z)
    held(z, run, z.t1, 3)
    progress = svc.run_progress(z.db, run, now=NOW, user=manager(z))
    (item,) = [i for i in progress["items"] if str(i["machineId"]) == str(z.t1.id)]
    assert item["words"] == "ממתין — מכירות מושהות (3)" and item["heldSales"] == 3
    assert item["keepHeldSales"]["allowed"] is False  # parameter off, not support
    (cmd,) = [c for c in progress["commands"] if c["machineId"] == str(z.t1.id)]
    assert cmd["status"] == "delivered" and cmd["detail"] == "held_sales"
    # Resolved on the till (paid or cancelled): it closes on the next ask, the run goes on.
    assert remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)["requestId"] == str(item_of(run, z.t1).id)
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED


def test_keep_them_only_where_the_shop_allows_or_support_with_a_reason(z):
    selling(z, z.t1, 1, "10.00")
    run = start(z)
    held(z, run, z.t1, 2)
    mgr = manager(z)
    body = R.KeepHeldSalesIn(machineId=z.t1.id, runId=run.id)
    with pytest.raises(HTTPException) as e:
        R.post_keep_held_sales(body, **_ctx(z, mgr))
    assert e.value.status_code == 403 and e.value.detail["code"] == "keep_held_sales_not_allowed"
    # Support: only with a typed reason.
    with pytest.raises(HTTPException) as e:
        R.post_keep_held_sales(body, **_ctx(z))
    assert e.value.status_code == 422
    z.sent.clear()
    from datetime import datetime, timezone

    z.t1.last_heartbeat_at = datetime.now(timezone.utc)  # online: told at once, not only on its next beat
    R.post_keep_held_sales(R.KeepHeldSalesIn(machineId=z.t1.id, runId=run.id, reason="סוף יום, המכירות יטופלו מחר"), **_ctx(z))
    item = item_of(run, z.t1)
    z.db.refresh(item)
    assert item.keep_held_sales is True
    # The till hears it — on the push (after the commit) and on its heartbeat.
    assert z.sent and z.sent[-1].get("keep_held_sales") is True
    assert remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)["keepHeldSales"] is True
    (rec,) = z.db.query(AuditException).filter(AuditException.exception_type == H.EXCEPTION_TYPE).all()
    assert rec.details["reason"] == "סוף יום, המכירות יטופלו מחר" and rec.details["byParameter"] is False


def test_with_the_parameter_on_a_manager_keeps_them_without_a_reason(z):
    # The wall clock here: a till's ack sweeps expired requests by it (as the till Z's does).
    set_param(z, H.KEY, "shop", z.shop.id, True)
    selling(z, z.t1, 1, "10.00")
    p = svc.preview(z.db, z.t1)
    svc.request(z.db, z.admin, z.t1, totals_key=p["totalsKey"])
    z.db.commit()
    pending = svc.preview(z.db, z.t1)["pending"]
    remote_close.apply_close_shift_ack(z.db, z.t1, request_id=uuid.UUID(pending["id"]), phase="deferred",
                                       error_code=H.DEFER_CODE, error_message="4")
    assert svc.preview(z.db, z.t1)["pending"]["heldSales"] == 4
    mgr = manager(z)
    out = R.post_keep_held_sales(R.KeepHeldSalesIn(machineId=z.t1.id), **_ctx(z, mgr))
    assert out["kind"] == "ShiftCloseRequest"
    beat = remote_close.take_pending_close_shift(z.db, z.t1)
    assert beat["keepHeldSales"] is True and beat["waitForRest"] is True
    rec = z.db.query(AuditException).filter(AuditException.exception_type == H.EXCEPTION_TYPE).one()
    assert rec.details["byParameter"] is True and rec.details["by"] == "mgr"


def test_flag_off_no_keep_route(z, monkeypatch):
    monkeypatch.delenv("REMOTE_TILL_Z_ENABLED", raising=False)
    with pytest.raises(HTTPException) as e:
        R.post_keep_held_sales(R.KeepHeldSalesIn(machineId=z.t1.id), **_ctx(z))
    assert e.value.status_code == 404


def test_a_held_sale_cancelled_at_a_close_is_kept_for_the_audit(z):
    body = TillEventIn.model_validate({
        "id": str(uuid.uuid4()), "type": "held_sale_cancelled", "occurredAt": (NOW - timedelta(minutes=3)).isoformat(),
        "posUserId": "u-7", "amount": "42.50",
        "details": {"reason": "לקוח עזב", "approvedBy": "מנהלת", "items": [{"name": "קפה", "quantity": 2}], "total": "42.50"},
    })
    event, created = record_till_event(z.db, z.t1, body)
    z.db.flush()
    assert created and z.db.get(TillEvent, event.id).event_type == "held_sale_cancelled"
    assert z.db.get(TillEvent, event.id).details["reason"] == "לקוח עזב"


# ── "בטל מכירות מושהות וסגור" (the owner: "אפשר לכפות סגירה ולבטל עסקאות מושהות מהענן") ──────


HELD = [
    {"id": "h-1", "at": "2026-09-27T17:40:00Z", "cashier": "דנה", "itemCount": 2, "total": "42.50", "items": ["קפה", "עוגה"]},
    {"id": "h-2", "at": "2026-09-27T17:55:00Z", "cashier": "רון", "itemCount": 1, "total": "18.00", "items": ["מיץ"]},
]


def defer_with_list(z, run, till, sales):
    """The till's own ack, through the sync route: deferred on held sales, with its list."""
    from app.routers import sync as sync_router
    from app.schemas.shift import ShiftCloseAckIn

    sync_router.post_shift_close_ack(
        str(till.id),
        ShiftCloseAckIn.model_validate({"requestId": str(item_of(run, till).id), "phase": "deferred",
                                        "errorCode": H.DEFER_CODE, "errorMessage": str(len(sales)), "heldSales": sales}),
        machine=till, db=z.db,
    )


def test_remote_cancel_is_on_by_default_and_follows_the_levels(z):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == H.REMOTE_CANCEL_KEY]
    assert spec.default_value is True and spec.label == "ביטול מכירות מושהות מהענן בסגירה מרחוק"
    assert H.remote_cancel_on(z.db, z.t1) is True
    set_param(z, H.REMOTE_CANCEL_KEY, "company", z.shop.company_id, False)
    assert H.remote_cancel_on(z.db, z.t1) is False
    set_param(z, H.REMOTE_CANCEL_KEY, "shop", z.shop.id, True)
    assert H.remote_cancel_on(z.db, z.t1) is True
    area = ShopArea(id=uuid.uuid4(), tenant_id=z.tenant.id, shop_id=z.shop.id, name="Terrace")
    z.db.add(area)
    z.db.flush()
    z.t1.area_id = area.id
    set_param(z, H.REMOTE_CANCEL_KEY, "area", area.id, False)
    assert H.remote_cancel_on(z.db, z.t1) is False and H.remote_cancel_on(z.db, z.t2) is True


def test_the_dashboard_sees_the_list_and_a_manager_cancels_exactly_it_with_a_reason(z):
    selling(z, z.t1, 1, "10.00")
    run = start(z)
    defer_with_list(z, run, z.t1, HELD)
    mgr = manager(z)
    progress = svc.run_progress(z.db, run, now=NOW, user=mgr)
    (item,) = [i for i in progress["items"] if str(i["machineId"]) == str(z.t1.id)]
    assert item["words"] == "ממתין — מכירות מושהות (2)"
    assert [s["id"] for s in item["heldSalesList"]] == ["h-1", "h-2"] and item["heldSalesList"][0]["cashier"] == "דנה"
    assert item["cancelHeldSales"] == {"allowed": True, "needsReason": True}  # the remote close's own permission
    # A reason is required.
    with pytest.raises(HTTPException) as e:
        R.post_cancel_held_sales(R.CancelHeldSalesIn(machineId=z.t1.id, runId=run.id, saleIds=["h-1", "h-2"], reason=" "),
                                 **_ctx(z, mgr))
    assert e.value.status_code == 422
    # Only ids from the list the till reported.
    with pytest.raises(HTTPException) as e:
        R.post_cancel_held_sales(R.CancelHeldSalesIn(machineId=z.t1.id, runId=run.id, saleIds=["h-1", "h-9"],
                                                     reason="סוף יום"), **_ctx(z, mgr))
    assert e.value.detail["code"] == "held_sales_list_changed"
    out = R.post_cancel_held_sales(R.CancelHeldSalesIn(machineId=z.t1.id, runId=run.id, saleIds=["h-1", "h-2"],
                                                       reason="לקוחות עזבו"), **_ctx(z, mgr))
    assert out["ids"] == ["h-1", "h-2"]
    beat = remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)
    assert beat["cancelHeldSales"] == {"ids": ["h-1", "h-2"], "reason": "לקוחות עזבו", "by": "mgr"}
    assert beat["waitForRest"] is True  # an open sale still waits: never closed over
    assert "keepHeldSales" not in beat


def test_the_tills_cancel_events_are_the_runs_log(z):
    s1 = selling(z, z.t1, 1, "10.00")
    run = start(z)
    defer_with_list(z, run, z.t1, HELD[:1])
    item_id = str(item_of(run, z.t1).id)
    body = TillEventIn.model_validate({
        "id": str(uuid.uuid4()), "type": "held_sale_cancelled", "occurredAt": NOW.isoformat(), "amount": "42.50",
        "details": {"heldSaleId": "h-1", "source": "remote", "reason": "לקוחות עזבו", "by": "mgr",
                    "requestId": item_id, "items": [{"name": "קפה", "quantity": 1}], "total": "42.50"},
    })
    record_till_event(z.db, z.t1, body)
    z.db.flush()
    progress = svc.run_progress(z.db, run, now=NOW)
    (item,) = [i for i in progress["items"] if str(i["machineId"]) == str(z.t1.id)]
    assert item["heldSalesCancelled"] == [{"heldSaleId": "h-1", "reason": "לקוחות עזבו", "by": "mgr", "total": "42.50",
                                          "items": [{"name": "קפה", "quantity": 1}], "at": None}]
    # Then the till closes, and the run goes on.
    till_closes(z, z.t1, s1)
    z.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED


def test_remote_cancel_off_is_not_offered_and_refused(z):
    set_param(z, H.REMOTE_CANCEL_KEY, "shop", z.shop.id, False)
    selling(z, z.t1, 1, "10.00")
    run = start(z)
    defer_with_list(z, run, z.t1, HELD)
    (item,) = [i for i in svc.run_progress(z.db, run, now=NOW, user=z.admin)["items"]
               if str(i["machineId"]) == str(z.t1.id)]
    assert item["cancelHeldSales"]["allowed"] is False
    assert item["cancelHeldSales"]["whyNot"] == 'בסניף כבוי "ביטול מכירות מושהות מהענן בסגירה מרחוק"'
    with pytest.raises(HTTPException) as e:
        R.post_cancel_held_sales(R.CancelHeldSalesIn(machineId=z.t1.id, runId=run.id, saleIds=["h-1"],
                                                     reason="ניסיון"), **_ctx(z))
    assert e.value.status_code == 409 and e.value.detail["code"] == "remote_cancel_held_sales_off"
    assert "cancelHeldSales" not in remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)


def test_a_supervisor_never_cancels_held_sales(z):
    from test_remote_z_review_fixes import supervisor_with_full_access

    selling(z, z.t1, 1, "10.00")
    run = start(z)
    defer_with_list(z, run, z.t1, HELD)
    sup = supervisor_with_full_access(z)
    with pytest.raises(HTTPException) as e:
        R.post_cancel_held_sales(R.CancelHeldSalesIn(machineId=z.t1.id, runId=run.id, saleIds=["h-1"],
                                                     reason="ניסיון של אחמ״ש"), **_ctx(z, sup))
    assert e.value.status_code == 403
