"""
A kiosk's shift and Z by its Z mode (app/services/kiosk_z.py, docs/SPEC_KIOSK.md §25).

The owner: a kiosk in the shop Z is offered "סגירת משמרת" (its shift then goes into the shop's
next Z), an independent one "הפקת Z" (its own Z in its own run) — from the controlling till
and from the cloud. What each test pins:

* **The mode per device** — the shop's mode, overridden per machine on the "קופות בזד הסניפי"
  card (a kiosk is listed there like any till): `shop` / `independent` / `own`, its label
  and its one action on the kiosk's summary.
* **Shop-Z kiosk: the remote shift close** — from a controlling till and from the dashboard,
  through the existing request; the states the screens show (sent, waiting for a payment /
  a customer, closing, closed) and its closed shift a candidate of the shop's next Z.
* **Offline** — queued, said so.
* **Never mid-payment** — the kiosk's deferral and its own report both read "waiting".
* **Wrong action per mode** — refused with why, audited.
* **Independent kiosk: the Z** — from the dashboard and from a till (a manager's approval),
  its own run from Z 1, the next Z 2, nothing renumbered; the state with the Z's number.
* **Where the Z prints** — the controlling till of the kiosk's shop when it asked so.
* **Fast beat** while a request waits; **permissions** of the dashboard.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse

from app.models.kiosk import KioskCommand
from app.models.pos_machine import POSMachine
from app.models.shift import ShiftStatus
from app.models.shift_close_request import ShiftCloseRequest
from app.models.till_z_request import TillZRequest
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import kiosks as R
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.routers import z_participation as ZP
from app.schemas.kiosk import KioskCommandIn, KioskCreateIn, KioskSyncIn
from app.schemas.shift import ShiftCloseIn
from app.schemas.till_z import TillZIn
from app.services import ably_notify
from app.services import kiosk_z as KZ
from app.services import remote_close
from app.services import till_parameters as TP
from app.services import till_z
from app.services.shifts import apply_shift_close
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("publish_settings_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.kiosk, world.till = world.tills  # "Till 1" becomes the kiosk, "Till 2" controls it
    for m in world.tills + [world.other_till]:
        m.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north-mgr", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    body = KioskCreateIn(machineId=world.kiosk.id, name="קיוסק כניסה", controllerMachineIds=[str(world.till.id)])
    R.create_kiosk(body=body, current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db)
    world.db.commit()
    return world


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _pos_manager(w, shop=None):
    from app.models.pos_user import PosUser, PosUserRole

    u = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, username=f"u-{uuid.uuid4().hex[:6]}",
        first_name="דנה", pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
    )
    w.db.add(u)
    w.db.flush()
    return u


class _Tasks:
    def add_task(self, *a, **k):
        pass


def participation(w, *, independent=(), participants=()):
    return ZP.put_z_participation(
        w.shop.id,
        ZP.ZParticipationIn.model_validate({
            "participants": [str(m.id) for m in participants],
            "independent": [str(m.id) for m in independent],
        }),
        background_tasks=_Tasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def till_command(w, action, till=None, **extra):
    response = Response()
    till = till or w.till
    out = R.post_till_kiosk_command(
        machine_id=str(till.id), kiosk_machine_id=str(w.kiosk.id),
        body=KioskCommandIn(action=action, **extra), response=response, machine=till, db=w.db,
    )
    return out, response.status_code


def dashboard_command(w, action, user=None, **extra):
    response = Response()
    out = R.post_kiosk_command(
        machine_id=w.kiosk.id, body=KioskCommandIn(action=action, **extra), response=response,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return out, response.status_code


def summary(w, user=None):
    rows = R.list_kiosks(company_id=None, shop_id=None, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)
    return next(r for r in rows if r["machineId"] == str(w.kiosk.id))


def body_of(answer):
    assert isinstance(answer, JSONResponse), answer
    return answer.status_code, json.loads(answer.body)


def open_shift(w, seq=1):
    shift = w.shift(w.kiosk, seq, status=ShiftStatus.OPEN)
    w.db.commit()
    return shift


def accept_close(w, shift, request_id=None):
    """The kiosk's close reaches the cloud (every document in), as the sync router does it."""
    doc = w.doc(w.kiosk, shift, "25.00")
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "transactionIds": [str(doc.id)],
        **({"closeRequestId": str(request_id)} if request_id else {}),
    })
    closed, outcome = apply_shift_close(w.db, w.kiosk, shift.id, body)
    assert outcome == "accepted"
    remote_close.on_shift_close_accepted(w.db, w.kiosk, closed)
    w.db.commit()
    return closed


def ack_close(w, request_id, phase, code=None):
    remote_close.apply_close_shift_ack(
        w.db, w.kiosk, request_id=uuid.UUID(str(request_id)), phase=phase,
        error_code=code, error_message="a customer is paying" if code else None,
    )


def ask_z(w, request_id=None):
    """The kiosk asks for its Z (after its close was accepted): the answer."""
    payload = {"clientRequestId": str(uuid.uuid4())}
    if request_id is not None:
        payload["tillZRequestId"] = str(request_id)
    resp = sync_router.post_till_z(
        machine_id=str(w.kiosk.id), body=TillZIn.model_validate(payload), machine=w.kiosk, db=w.db,
    )
    assert resp.status_code == 201, resp.body
    return json.loads(resp.body)


def make_independent(w):
    participation(w, independent=[w.kiosk])
    w.db.refresh(w.kiosk)


# ── The mode, per device ─────────────────────────────────────────────────────


def test_the_mode_is_decided_per_device_and_the_override_is_on_the_card(w):
    s = summary(w)
    assert (s["zKind"], s["zKindLabel"], s["zAction"], s["independentTill"]) == ("shop", "Z סניפי", "close_shift", False)
    # The card lists the kiosk like any till, as a kiosk.
    card = ZP.get_z_participation(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    row = next(t for t in card["tills"] if t["machineId"] == str(w.kiosk.id))
    assert row["kiosk"] is True and row["role"] == "shop_z"
    # Overridden ("לדרוס") on the card: this kiosk alone is independent; the till next to it is not.
    make_independent(w)
    s = summary(w)
    assert (s["zKind"], s["zKindLabel"], s["zAction"], s["independentTill"]) == ("independent", "Z עצמאי", "till_z", True)
    assert KZ.kind_of(w.till) == "shop"
    card = ZP.get_z_participation(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert next(t for t in card["tills"] if t["machineId"] == str(w.kiosk.id))["role"] == "independent"
    # Back into the shop Z; then the shop's "Z לכל קופה" (z_mode = till, not independent): its own Z too.
    participation(w, participants=[w.kiosk])
    w.db.refresh(w.kiosk)
    assert KZ.kind_of(w.kiosk) == "shop"
    till_z.set_z_mode(w.db, w.kiosk, "till")
    w.db.commit()
    s = summary(w)
    assert (s["zKind"], s["zKindLabel"], s["zAction"]) == ("own", "Z לכל קופה", "till_z")


def test_the_controlling_till_gets_the_same_mode_on_its_kiosk_sync(w):
    out = R.kiosk_sync(machine_id=str(w.till.id), body=None, machine=w.till, db=w.db)
    control = next(c for c in out["controls"] if c["machineId"] == str(w.kiosk.id))
    assert (control["zKind"], control["zAction"]) == ("shop", "close_shift")
    make_independent(w)
    out = R.kiosk_sync(machine_id=str(w.till.id), body=None, machine=w.till, db=w.db)
    control = next(c for c in out["controls"] if c["machineId"] == str(w.kiosk.id))
    assert (control["zKind"], control["zAction"]) == ("independent", "till_z")


# ── Shop-Z kiosk: "סגירת משמרת" ──────────────────────────────────────────────


def test_a_shop_z_kiosk_closes_its_shift_from_the_till_and_it_joins_the_next_shop_z(w):
    from app.services import z_runs as ZR

    shift = open_shift(w)
    out, code = till_command(w, "close_shift", posUserName="דנה")
    assert code == 201 and out["status"] == "requested"
    req = w.db.query(ShiftCloseRequest).one()
    assert req.machine_id == w.kiosk.id and req.shift_id == shift.id
    state = summary(w)["shiftClose"]
    assert state["id"] == str(req.id) and state["pending"] is True
    assert state["state"] in ("sent", "queued")
    # The kiosk has it but a customer is paying: it waits, and every screen says so.
    ack_close(w, req.id, "deferred", "kiosk_paying")
    state = summary(w)["shiftClose"]
    assert (state["state"], state["message"]) == ("waiting_payment", "ממתין לסיום תשלום בקיוסק")
    ack_close(w, req.id, "deferred", "kiosk_ordering")
    assert summary(w)["shiftClose"]["state"] == "waiting_customer"
    ack_close(w, req.id, "received")
    assert summary(w)["shiftClose"]["state"] == "closing"
    # The close reaches the cloud: done, and the shift waits for the shop's next Z.
    closed = accept_close(w, shift, req.id)
    state = summary(w)["shiftClose"]
    assert (state["state"], state["pending"], state["shiftId"]) == ("closed", False, str(shift.id))
    assert "Z הסניפי הבא" in state["message"]
    assert closed.z_report_id is None and closed.status == ShiftStatus.CLOSED
    assert shift.id in {s.id for s in ZR.till_candidates(w.db, w.kiosk, w.shop.id).closed}
    # Nothing produced a Z for the kiosk.
    assert w.db.query(ZReport).filter(ZReport.machine_id == w.kiosk.id).count() == 0
    assert w.db.query(TillZRequest).count() == 0


def test_the_dashboard_closes_a_shop_z_kiosks_shift_through_the_same_request(w):
    open_shift(w)
    out, code = dashboard_command(w, "close_shift", user=w.manager)
    assert code == 201 and out["status"] == "requested" and out["source"] == "dashboard"
    assert w.db.query(ShiftCloseRequest).count() == 1
    # Asked again while pending: the same request.
    again, _ = dashboard_command(w, "close_shift")
    assert again["requestId"] == out["requestId"] and again["detail"] == "already_pending"


def test_an_offline_kiosk_gets_it_queued_and_the_screens_say_so(w):
    open_shift(w)
    w.kiosk.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=2)
    w.db.commit()
    out, code = dashboard_command(w, "close_shift")
    assert code == 201
    state = summary(w)["shiftClose"]
    assert state["state"] == "queued" and "לא מחובר" in state["message"]
    # It comes back: the heartbeat hands it the request (and beats fast meanwhile).
    w.kiosk.last_heartbeat_at = datetime.now(timezone.utc)
    w.db.commit()
    beat = machines_router.post_my_heartbeat(None, machine=w.kiosk, db=w.db)
    assert beat["pendingCloseShift"]["requestId"] == out["requestId"]
    assert beat.get("fastBeat") is True


def test_a_customer_paying_on_the_kiosk_shows_as_waiting_before_the_kiosk_answers(w):
    open_shift(w)
    R.kiosk_sync(machine_id=str(w.kiosk.id), body=KioskSyncIn(status={"flowState": "paying"}), machine=w.kiosk, db=w.db)
    w.db.commit()
    dashboard_command(w, "close_shift")
    assert summary(w)["shiftClose"]["state"] == "waiting_payment"
    R.kiosk_sync(machine_id=str(w.kiosk.id), body=KioskSyncIn(status={"flowState": "attract"}), machine=w.kiosk, db=w.db)
    w.db.commit()
    assert summary(w)["shiftClose"]["state"] in ("sent", "queued")


def test_a_failed_close_says_why(w):
    open_shift(w)
    out, _ = dashboard_command(w, "close_shift")
    ack_close(w, out["requestId"], "failed", "open_tables")
    state = summary(w)["shiftClose"]
    assert (state["state"], state["detail"]) == ("failed", "יש שולחנות פתוחים בקיוסק")
    assert state["message"].startswith("לא נסגרה")


# ── The wrong action for the mode ────────────────────────────────────────────


def test_a_shop_z_kiosk_is_never_offered_a_z_and_says_why(w):
    open_shift(w)
    status_code, body = body_of(dashboard_command(w, "till_z")[0])
    assert status_code == 422 and body["detail"] == "machine_not_till_z"
    assert "Z הסניפי" in body["message"] and "סגירת משמרת" in body["message"]
    status_code, body = body_of(till_command(w, "till_z")[0])
    assert body["detail"] == "machine_not_till_z"
    rows = w.db.query(KioskCommand).filter(KioskCommand.action == "till_z").all()
    assert [r.status for r in rows] == ["refused", "refused"]
    assert w.db.query(TillZRequest).count() == 0


def test_an_independent_kiosk_is_never_offered_a_bare_shift_close(w):
    make_independent(w)
    open_shift(w)
    status_code, body = body_of(dashboard_command(w, "close_shift")[0])
    assert status_code == 409 and body["detail"] == "kiosk_makes_own_z"
    assert "הפקת Z" in body["message"]
    status_code, body = body_of(till_command(w, "close_shift")[0])
    assert body["detail"] == "kiosk_makes_own_z"
    assert w.db.query(ShiftCloseRequest).count() == 0
    row = w.db.query(KioskCommand).filter(KioskCommand.action == "close_shift").first()
    assert (row.status, row.detail) == ("refused", "kiosk_makes_own_z")


# ── Independent kiosk: "הפקת Z" ──────────────────────────────────────────────


def test_an_independent_kiosks_z_from_the_dashboard_in_its_own_run(w):
    make_independent(w)
    shift = open_shift(w)
    out, code = dashboard_command(w, "till_z", user=w.manager)
    assert code == 201 and out["status"] == "requested"
    req = w.db.query(TillZRequest).one()
    state = summary(w)["tillZRequest"]
    assert state["id"] == str(req.id) and state["pending"] is True and state["printOn"] == "kiosk"
    # A customer is ordering: the kiosk holds it and says so.
    till_z.apply_ack(w.db, w.kiosk, request_id=req.id, phase="deferred", error_code="kiosk_ordering")
    w.db.commit()
    assert summary(w)["tillZRequest"]["state"] == "waiting_customer"
    till_z.apply_ack(w.db, w.kiosk, request_id=req.id, phase="deferred", error_code="kiosk_paying")
    w.db.commit()
    assert summary(w)["tillZRequest"]["state"] == "waiting_payment"
    till_z.apply_ack(w.db, w.kiosk, request_id=req.id, phase="received")
    w.db.commit()
    assert summary(w)["tillZRequest"]["state"] == "producing"
    # Then: its shift closed, its Z asked — Z 1 of its new run.
    accept_close(w, shift)
    answer = ask_z(w, req.id)
    assert "printOn" not in answer
    z = w.db.get(ZReport, uuid.UUID(answer["zReport"]["id"]))
    assert (z.machine_sequence_number, z.machine_sequence_epoch, z.shop_sequence_number) == (1, 1, None)
    state = summary(w)["tillZRequest"]
    assert (state["state"], state["zNumber"], state["zReportId"]) == ("done", 1, str(z.id))
    assert state["message"] == "Z מס׳ 1 הופק ✓"
    # The next one is Z 2; Z 1 stays Z 1.
    second_shift = open_shift(w, 2)
    out, _ = dashboard_command(w, "till_z")
    accept_close(w, second_shift)
    answer = ask_z(w, out["requestId"])
    assert answer["zReport"]["machineSequenceNumber"] == 2
    w.db.refresh(z)
    assert z.machine_sequence_number == 1
    assert summary(w)["tillZRequest"]["zNumber"] == 2


def test_from_the_controlling_till_a_z_needs_a_manager(w):
    make_independent(w)
    open_shift(w)
    status_code, body = body_of(till_command(w, "till_z", posUserName="קופאי")[0])
    assert status_code == 403 and body["detail"] == "kiosk_control_requires_manager"
    assert "הפקת Z" in body["message"]
    assert w.db.query(TillZRequest).count() == 0
    manager = _pos_manager(w)
    out, code = till_command(w, "till_z", posUserId=str(manager.id), posUserName="דנה")
    assert code == 201 and out["source"] == "till" and out["requestedByName"] == "Till 2 · דנה"
    assert w.db.query(TillZRequest).count() == 1
    # A manager of another shop is no manager here.
    stranger = _pos_manager(w, shop=w.other_shop)
    status_code, _ = body_of(till_command(w, "till_z", posUserId=str(stranger.id))[0])
    assert status_code == 403
    assert KZ.requires_manager(w.kiosk, "till_z") and not KZ.requires_manager(w.kiosk, "close_shift")


def test_the_controlling_till_of_the_kiosks_shop_may_print_the_z_itself(w):
    make_independent(w)
    shift = open_shift(w)
    manager = _pos_manager(w)
    out, _ = till_command(w, "till_z", posUserId=str(manager.id), message=KZ.PRINT_ON_CONTROLLER)
    state = summary(w)["tillZRequest"]
    assert (state["printOn"], state["printOnMachineId"]) == ("controller", str(w.till.id))
    accept_close(w, shift)
    answer = ask_z(w, out["requestId"])
    assert (answer["printOn"], answer["printOnMachineId"]) == ("controller", str(w.till.id))


def test_a_controlling_till_of_another_shop_cannot_take_the_print(w):
    # The kiosk's controllers may be any till of the company — but only one of its own shop
    # can read its Z, so the kiosk keeps printing it.
    from app.services import kiosk_control as S

    device = S.get_device(w.db, w.kiosk.id)
    device.controller_machine_ids = [str(w.till.id), str(w.other_till.id)]
    w.db.commit()
    make_independent(w)
    shift = open_shift(w)
    manager = _pos_manager(w, shop=w.other_shop)
    out, code = till_command(w, "till_z", till=w.other_till, posUserId=str(manager.id), message=KZ.PRINT_ON_CONTROLLER)
    assert code == 201
    assert summary(w)["tillZRequest"]["printOn"] == "kiosk"
    accept_close(w, shift)
    assert "printOn" not in ask_z(w, out["requestId"])


# ── Fast beat, permissions ───────────────────────────────────────────────────


def test_the_kiosk_beats_fast_only_while_a_request_waits(w):
    beat = machines_router.post_my_heartbeat(None, machine=w.kiosk, db=w.db)
    assert not beat.get("fastBeat")
    shift = open_shift(w)
    out, _ = dashboard_command(w, "close_shift")
    assert KZ.fast_beat(w.db, w.kiosk) is True
    # A regular till with a request of its own is not hurried by this rule.
    w.shift(w.till, 1, status=ShiftStatus.OPEN)
    from app.services import shift_close_requests

    shift_close_requests.request_close(w.db, w.admin, w.till)
    w.db.commit()
    assert KZ.fast_beat(w.db, w.till) is False
    accept_close(w, shift, out["requestId"])
    assert KZ.fast_beat(w.db, w.kiosk) is False


def test_dashboard_permissions(w):
    open_shift(w)
    # A cashier never; another shop's manager not this kiosk.
    with pytest.raises(HTTPException) as caught:
        dashboard_command(w, "close_shift", user=w.cashier)
    assert caught.value.status_code == 403
    with pytest.raises(HTTPException) as caught:
        dashboard_command(w, "close_shift", user=w.north_manager)
    assert caught.value.status_code == 403
    assert w.db.query(ShiftCloseRequest).count() == 0
    # The kiosk's own shop manager and the super admin may.
    out, code = dashboard_command(w, "close_shift", user=w.manager)
    assert code == 201
    # Making a kiosk independent is the super admin's alone (the card's rule).
    with pytest.raises(HTTPException) as caught:
        ZP.put_z_participation(
            w.shop.id, ZP.ZParticipationIn.model_validate({"independent": [str(w.kiosk.id)]}),
            background_tasks=_Tasks(), current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db,
        )
    assert caught.value.status_code == 403


def test_switching_a_kiosk_with_an_open_shift_is_refused_with_why(w):
    open_shift(w)
    answer = participation(w, independent=[w.kiosk])
    status_code, body = body_of(answer)
    assert status_code == 409 and body["detail"] == "independent_switch_open_shift"
    w.db.rollback()
    assert KZ.kind_of(w.db.get(POSMachine, w.kiosk.id)) == "shop"
