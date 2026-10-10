"""
"כפה סגירה" — remote control's close / Z forced by default (app/services/remote_close_force.py; the
owner, 09.10.2026: "ברירת המחדל לכפות סגירה מרגע ששלח המנהל. אפשר לבטל בפרמטרים").

As scenarios: the parameter `remoteCloseForceByDefault` (on by default, company → shop → area → till);
a request forced by default and its wire (`remoteForce` beside `waitForRest`, never §9's `force`); the
parameter off — waiting as before; the manager's tick for one request, both ways; a pending request asked
again; the shop's and an area's day close per till; the area's shift close; kiosks; what the dialog shows;
the request's lifecycle words ("נסגר בכפייה מרחוק ע״י …", "ממתין למסמכים שטרם נכתבו בקופה") and the
log — the till's `forced_z_close` event resolved to the manager.
"""
from __future__ import annotations

import uuid

from starlette.responses import Response

from app.models.audit_exception import AuditException
from app.models.kiosk import KioskDevice
from app.models.shift_close_request import ShiftCloseRequest, ShiftCloseRequestStatus
from app.models.till_z_request import TillZRequest, TillZRequestStatus
from app.routers import device_commands as R
from app.routers import exceptions as exceptions_router
from app.schemas.audit_exception import TillEventIn
from app.services import remote_close
from app.services import remote_close_force as F
from app.services import remote_till_z as svc
from app.services import shift_close_requests as close_requests
from app.services import till_parameters as TP
from app.services import till_z
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401
from test_remote_close_matrix import area_of
from test_remote_shop_close import _ctx, item_of, selling, start, till_closes, z  # noqa: F401

FORCED = "נסגר בכפייה מרחוק ע״י admin"


def ask(z, till, **kw):
    """The manager confirms the till's figures and sends (the route's own path, now fixed)."""
    key = svc.preview(z.db, till, now=NOW)["totalsKey"]
    out = svc.request(z.db, z.admin, till, totals_key=key, now=NOW, **kw)
    z.db.commit()
    return out


def capable(*tills):
    for t in tills:
        t.capabilities = ["remote_close_v2", F.CAPABILITY]


# ── The parameter ─────────────────────────────────────────────────────────────


def test_the_parameter_is_a_builtin_on_by_default_with_hebrew_words(z):
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == F.KEY)
    assert spec.value_type == "boolean" and spec.default_value is True
    assert spec.label == "כפיית סגירה מרחוק כברירת מחדל"
    assert "מרגע השליחה" in spec.description and "עסקת אשראי" in spec.description
    assert F.default_on(z.db, z.t1) is True


def test_the_parameter_resolves_company_shop_area_till(z):
    a = area_of(z, z.t1)
    set_param(z, F.KEY, "company", z.shop.company_id, False)
    assert (F.default_on(z.db, z.t1), F.default_on(z.db, z.t2)) == (False, False)
    set_param(z, F.KEY, "shop", z.shop.id, True)
    assert (F.default_on(z.db, z.t1), F.default_on(z.db, z.t2)) == (True, True)
    set_param(z, F.KEY, "area", a.id, False)
    assert (F.default_on(z.db, z.t1), F.default_on(z.db, z.t2)) == (False, True)
    set_param(z, F.KEY, "machine", z.t1.id, True)
    assert F.default_on(z.db, z.t1) is True


# ── One till ──────────────────────────────────────────────────────────────────


def test_default_forced_the_close_carries_remote_force_beside_wait_for_rest(z):
    selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1)
    assert out["remoteForce"] is True
    req = z.db.query(ShiftCloseRequest).one()
    assert (req.wait_for_rest, req.remote_force) == (True, True)
    beat = remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)
    assert beat["waitForRest"] is True and beat["remoteForce"] is True
    assert "force" not in beat, "never section 9's force: an old build waits for rest"
    assert z.sent[-1]["remote_force"] is True and z.sent[-1]["wait_for_rest"] is True and not z.sent[-1].get("force")


def test_parameter_off_waits_for_rest_as_before(z):
    set_param(z, F.KEY, "shop", z.shop.id, False)
    selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1)
    assert out["remoteForce"] is False
    req = z.db.query(ShiftCloseRequest).one()
    assert (req.wait_for_rest, req.remote_force) == (True, False)
    assert "remoteForce" not in remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)
    assert z.sent[-1]["remote_force"] is False


def test_the_tick_overrides_the_parameter_both_ways(z):
    selling(z, z.t1, 1, "10.00")
    assert ask(z, z.t1, force=False)["remoteForce"] is False  # on by default, unticked for this one
    assert z.db.query(ShiftCloseRequest).one().remote_force is False

    set_param(z, F.KEY, "machine", z.t2.id, False)
    selling(z, z.t2, 1, "20.00")
    assert ask(z, z.t2, force=True)["remoteForce"] is True    # off, ticked for this one
    req = z.db.query(ShiftCloseRequest).filter_by(machine_id=z.t2.id).one()
    assert req.remote_force is True


def test_the_route_takes_the_tick(z):
    selling(z, z.t1, 1, "10.00")
    key = R.get_close_preview(z.t1.id, **_ctx(z))["totalsKey"]
    R.post_remote_close(R.RemoteCloseIn(machineId=z.t1.id, totalsKey=key, force=False), **_ctx(z))
    assert z.db.query(ShiftCloseRequest).one().remote_force is False


def test_asked_again_the_latest_word_stands_and_the_till_hears_it(z):
    selling(z, z.t1, 1, "10.00")
    ask(z, z.t1, force=False)
    sent = len(z.sent)
    out = ask(z, z.t1, force=True)
    assert out["created"] is False and out["remoteForce"] is True
    assert z.db.query(ShiftCloseRequest).one().remote_force is True
    assert len(z.sent) == sent + 1 and z.sent[-1]["remote_force"] is True


def test_a_till_with_its_own_z_forced_by_default(z, monkeypatch):
    from app.services import ably_notify

    sent = []
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: sent.append(k))
    z.t1.z_mode = till_z.Z_MODE_TILL
    selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1)
    assert out["kind"] == "till_z" and out["remoteForce"] is True
    req = z.db.query(TillZRequest).one()
    assert (req.wait_for_rest, req.remote_force, req.force_close) == (True, True, False)
    pending = till_z.take_pending(z.db, z.t1, now=NOW)
    assert pending["remoteForce"] is True and pending["waitForRest"] is True and "force" not in pending
    assert sent[-1]["remote_force"] is True
    # Unticked: as before.
    req.status = TillZRequestStatus.CANCELLED
    z.db.commit()
    ask(z, z.t1, force=False)
    assert "remoteForce" not in till_z.take_pending(z.db, z.t1, now=NOW)


def test_a_plain_close_from_the_machines_page_is_never_forced(z):
    selling(z, z.t1, 1, "10.00")
    req, _ = close_requests.request_close(z.db, z.admin, z.t1, remote_force=True)
    assert req.remote_force is False, "only remote control's close (wait_for_rest) is forced"


# ── What the dialog shows ─────────────────────────────────────────────────────


def test_the_preview_shows_the_mode_and_whether_the_build_can(z):
    selling(z, z.t1, 1, "10.00")
    p = svc.preview(z.db, z.t1, now=NOW)
    assert p["force"]["forceByDefault"] is True and p["force"]["label"] == "כפה סגירה"
    assert p["force"]["supported"] is False
    assert "תמתין" in p["force"]["note"]
    capable(z.t1)
    p = svc.preview(z.db, z.t1, now=NOW)
    assert p["force"]["supported"] is True and p["force"]["note"] is None
    set_param(z, F.KEY, "machine", z.t1.id, False)
    assert svc.preview(z.db, z.t1, now=NOW)["force"]["forceByDefault"] is False


# ── The shop's / an area's day close ──────────────────────────────────────────


def test_the_day_close_forces_each_till_by_its_own_parameter(z):
    a = area_of(z, z.t2)
    set_param(z, F.KEY, "area", a.id, False)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    rows = {r["machineId"]: r for r in svc.shop_preview(z.db, z.shop, now=NOW)["inShopZ"]}
    assert rows[str(z.t1.id)]["force"]["forceByDefault"] is True
    assert rows[str(z.t2.id)]["force"]["forceByDefault"] is False
    run = start(z)
    assert (item_of(run, z.t1).remote_force, item_of(run, z.t2).remote_force) == (True, False)
    assert remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)["remoteForce"] is True
    assert "remoteForce" not in remote_close.take_pending_close_shift(z.db, z.t2, now=NOW)
    progress = svc.run_progress(z.db, run, now=NOW)
    assert {i["machineId"]: i["remoteForce"] for i in progress["items"]} == {z.t1.id: True, z.t2.id: False}


def test_the_day_close_tick_applies_to_every_till(z):
    set_param(z, F.KEY, "machine", z.t2.id, False)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    run = start(z, force=True)
    assert (item_of(run, z.t1).remote_force, item_of(run, z.t2).remote_force) == (True, True)


def test_the_day_close_unticked_waits_for_rest_everywhere(z):
    selling(z, z.t1, 1, "10.00")
    run = start(z, force=False)
    assert item_of(run, z.t1).remote_force is False
    assert "remoteForce" not in remote_close.take_pending_close_shift(z.db, z.t1, now=NOW)


def test_the_area_day_close_and_the_area_shift_close(z):
    a = area_of(z, z.t1, z.t2)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    key = svc.shop_preview(z.db, z.shop, now=NOW, area_id=a.id)["totalsKey"]
    run = svc.shop_request(z.db, z.admin, z.tenant.id, z.shop, totals_key=key, confirm_cloud_data=True,
                           area_id=a.id, now=NOW)
    assert all(i.remote_force for i in run.items if i.include_open_shift)
    run.status = "cancelled"
    for i in run.items:
        i.status = "cancelled"
    z.db.commit()

    shifts = svc.area_shift_preview(z.db, z.shop, a.id, now=NOW)
    assert all(r["force"]["forceByDefault"] is True for r in shifts["tills"])
    keys = {r["machineId"]: r["totalsKey"] for r in shifts["tills"] if r["canRequest"]}
    out = svc.area_shift_request(z.db, z.admin, z.shop, a.id, keys, force=False, now=NOW)
    assert all(r["ok"] for r in out["results"]), out
    assert {r.remote_force for r in z.db.query(ShiftCloseRequest).all()} == {False}


def test_a_kiosk_in_the_run_is_asked_by_its_own_parameter_and_said_its_rules(z):
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    z.db.commit()
    rows = {r["machineId"]: r for r in svc.shop_preview(z.db, z.shop, now=NOW)["inShopZ"]}
    assert rows[str(z.t2.id)]["force"]["note"].startswith("קיוסק — לפי כללי הקיוסק")


# ── The lifecycle and the log ─────────────────────────────────────────────────


def test_a_forced_close_done_reads_who_forced_it(z):
    s1 = selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1)
    req = z.db.get(ShiftCloseRequest, uuid.UUID(str(out["request"]["id"])))
    assert close_requests.request_to_out(z.db, req)["forcedWords"] is None, "not before it is done"
    till_closes(z, z.t1, s1)
    z.db.refresh(req)
    assert req.status == ShiftCloseRequestStatus.COMPLETED
    done = close_requests.request_to_out(z.db, req)
    assert done["remoteForce"] is True and done["forcedWords"] == FORCED


def test_an_unforced_close_done_reads_as_before(z):
    s1 = selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1, force=False)
    till_closes(z, z.t1, s1)
    req = z.db.get(ShiftCloseRequest, uuid.UUID(str(out["request"]["id"])))
    assert close_requests.request_to_out(z.db, req)["forcedWords"] is None


def test_the_run_says_the_till_closed_by_force_and_the_documents_wait(z):
    s1 = selling(z, z.t1, 1, "10.00")
    s2 = selling(z, z.t2, 1, "20.00")
    run = start(z)
    remote_close.apply_close_shift_ack(z.db, z.t2, request_id=item_of(run, z.t2).id, phase="deferred",
                                       shift_id=s2.id, error_code=F.DOCUMENTS_PENDING_CODE,
                                       error_message="1 document(s) pending")
    till_closes(z, z.t1, s1)
    progress = svc.run_progress(z.db, run, now=NOW)
    words = {i["machineId"]: i["words"] for i in progress["items"]}
    assert words == {z.t1.id: FORCED, z.t2.id: "ממתין למסמכים שטרם נכתבו בקופה"}
    command = next(c for c in progress["commands"] if c["machineId"] == str(z.t1.id))
    assert command["status"] == "done" and command["detail"] == FORCED


def test_the_tills_forced_event_is_logged_with_the_managers_name(z):
    selling(z, z.t1, 1, "10.00")
    out = ask(z, z.t1)
    body = TillEventIn(
        id=uuid.uuid4(), type="forced_z_close", occurredAt=NOW, posUserId=None,
        details={"requestId": str(out["request"]["id"]), "kind": "z_run", "remote": True, "heldSalesCarried": 2,
                 "paymentAbandoned": True,
                 "parked": {"heldSaleId": "h-1", "name": "נשמרה בסגירה מרחוק", "lines": 3, "amount": 42.0}},
    )
    exceptions_router.post_till_event(str(z.t1.id), body, Response(), machine=z.t1, db=z.db)
    (row,) = z.db.query(AuditException).filter(AuditException.exception_type == "forced_z_close").all()
    assert row.details["requestKind"] == "close_shift"
    assert row.details["forcedBy"] == "admin"
    assert row.details["summary"].startswith(FORCED)
    assert "2 מכירות מושהות נשארו למשמרת הבאה" in row.details["summary"]
    assert "מסך התשלום בוטל" in row.details["summary"]
