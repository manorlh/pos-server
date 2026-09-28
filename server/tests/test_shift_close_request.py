"""
Closing a till's shift remotely without a Z (docs/SHIFTS_API.md §2.14).

The till in the field must answer these without a change, so every test drives the
*till's* side through the endpoints it already calls — the heartbeat handover, the
`shift-close/ack`, and the close with `closeRequestId` — and checks the request the
dashboard reads. What each class pins, and how it could look fine while doing damage:

* **Wire** — the instruction is a Z run's instruction: same Ably event and heartbeat
  field, with the request id as `requestId`. A new field would be ignored by the till.
* **Completion** — only an accepted close (every document on the cloud) completes it;
  an ack never does, and no Z is built.
* **Z runs** — a Z run already closing the till refuses a request; a request pending
  when a Z run starts is resolved by the same close, and the Z is built.
* **Expiry / cancel** — a request nobody answers ends; a late close still closes the
  shift but changes nothing on an ended request.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response

from app.models.shift import Shift, ShiftStatus
from app.models.shift_close_request import ShiftCloseRequest, ShiftCloseRequestStatus as S
from app.models.user import User, UserRole
from app.models.z_run import ZRunItemStatus, ZRunStatus
from app.routers import machines as machines_router
from app.routers import shift_close_requests as requests_router
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseAckIn, ShiftCloseIn
from app.services import ably_notify
from app.services import remote_close
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from app.services.administrative_close import close_shift_administratively
from shift_world import TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(
        ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a)
    )
    # The routers read the real clock; keep the tills "just seen" on it.
    world.now = datetime.now(timezone.utc)
    for till in world.tills:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
    return world


def open_shift(w, till, seq=1):
    return w.shift(till, seq, status=ShiftStatus.OPEN, opened_at=w.now - timedelta(hours=2))


def ask(w, till, user=None):
    """POST /machines/{id}/close-shift, as the dashboard calls it."""
    response = Response()
    response.status_code = None  # as FastAPI injects it: unset = the route's 201
    out = machines_router.request_remote_shift_close(
        machine_id=till.id,
        response=response,
        current_user=user or w.admin,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )
    return out, response.status_code or 201


def ack(w, till, request_id, phase, shift_id=None, code=None):
    body = ShiftCloseAckIn.model_validate(
        {"requestId": str(request_id), "phase": phase, "shiftId": str(shift_id) if shift_id else None,
         "errorCode": code}
    )
    return sync_router.post_shift_close_ack(machine_id=str(till.id), body=body, machine=till, db=w.db)


def till_closes(w, till, shift, request_id=None, docs=()):
    body = ShiftCloseIn.model_validate({
        "closedAt": w.now.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(d.id) for d in docs],
        "closeRequestId": str(request_id) if request_id else None,
    })
    return sync_router.post_shift_close(
        machine_id=str(till.id), shift_id=shift.id, body=body, machine=till, approval=None, db=w.db
    )


def status_of(w, request_id):
    return requests_router.get_shift_close_request(
        request_id=request_id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


# ── Wire: the till's existing path ───────────────────────────────────────────


class TestTheTillGetsAZRunsInstruction:
    def test_an_online_till_is_pushed_close_shift_with_the_request_id(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)

        out, code = ask(w, till)

        assert code == 201
        assert out["status"] == S.WAITING_CLOSE
        assert out["shiftId"] == shift.id
        # (tenant, machine, requestId, shiftId, initiatedBy) — the Z run's event, unchanged.
        assert w.sent == [(str(w.tenant.id), str(till.id), str(out["id"]), str(shift.id), "admin")]
        assert out["sentAt"] is not None

    def test_an_offline_till_collects_it_on_its_heartbeat(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = w.now - timedelta(hours=3)
        shift = open_shift(w, till)

        out, _ = ask(w, till)

        assert w.sent == []
        handed = remote_close.take_pending_close_shift(w.db, till)
        assert handed == {"requestId": str(out["id"]), "shiftId": str(shift.id)}
        # Repeated on every beat until the close is accepted (the till dedupes).
        assert remote_close.take_pending_close_shift(w.db, till) == handed

    def test_the_heartbeat_response_carries_it_as_pending_close_shift(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)

        beat = machines_router.post_my_heartbeat(body=None, machine=till, db=w.db)

        assert beat["pendingCloseShift"] == {"requestId": str(out["id"]), "shiftId": str(shift.id)}

    def test_a_second_click_returns_the_pending_request(self, w):
        till = w.tills[0]
        open_shift(w, till)
        first, _ = ask(w, till)

        second, code = ask(w, till)

        assert code == 200
        assert second["id"] == first["id"]
        assert len(w.sent) == 1
        assert w.db.query(ShiftCloseRequest).count() == 1

    def test_a_shift_only_the_till_has_reported_is_named(self, w):
        till = w.tills[0]
        claimed = uuid.uuid4()
        till.reported_open_shift_id = claimed

        out, _ = ask(w, till)

        assert out["shiftId"] == claimed
        assert out["shift"] is None

    def test_no_open_shift_is_409(self, w):
        with pytest.raises(HTTPException) as e:
            ask(w, w.tills[0])
        assert (e.value.status_code, e.value.detail) == (409, "no_open_shift")

    def test_an_unassigned_till_is_409(self, w):
        till = w.tills[0]
        open_shift(w, till)
        till.shop_id = None

        with pytest.raises(HTTPException) as e:
            ask(w, till)
        assert e.value.detail == "machine_not_assigned"

    def test_the_status_light_shows_the_pending_close(self, w):
        till = w.tills[0]
        open_shift(w, till)
        ask(w, till)

        assert remote_close.close_shift_pending_machine_ids(w.db, [t.id for t in w.tills]) == {till.id}


# ── Acks and completion ──────────────────────────────────────────────────────


class TestCompletion:
    def test_acks_move_it_but_never_complete_it(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)

        assert ack(w, till, out["id"], "deferred", shift.id, code="card_in_flight").item_status == S.CLOSING
        assert status_of(w, out["id"])["errorCode"] == "card_in_flight"
        assert ack(w, till, out["id"], "received", shift.id).item_status == S.CLOSING
        assert ack(w, till, out["id"], "completed", shift.id).item_status == S.CLOSING

        read = status_of(w, out["id"])
        assert read["status"] == S.CLOSING and read["errorCode"] is None
        assert read["receivedAt"] is not None

    def test_the_accepted_close_completes_it_and_builds_no_z(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        docs = [w.doc(till, shift, "40.00"), w.doc(till, shift, "10.00", method="card")]
        out, _ = ask(w, till)
        ack(w, till, out["id"], "received", shift.id)

        res = till_closes(w, till, shift, out["id"], docs)

        assert res.status == "accepted" and res.z_report_id is None
        stored = w.db.get(Shift, shift.id)
        assert stored.status == ShiftStatus.CLOSED and stored.unattended
        assert stored.z_report_id is None
        assert stored.close_request_id == out["id"]
        assert stored.close_request_item_id is None
        read = status_of(w, out["id"])
        assert read["status"] == S.COMPLETED and read["completedAt"] is not None
        assert read["shift"].server_totals.total_sales == 50
        assert read["documentsOnCloud"] is None
        # The till is free again, and the closed shift waits for a Z like any other.
        assert remote_close.take_pending_close_shift(w.db, till) is None
        assert [s.id for s in ZR.till_candidates(w.db, till).closed] == [shift.id]

    def test_a_close_still_missing_documents_does_not_complete_it(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)
        ghost = type("Doc", (), {"id": uuid.uuid4()})()

        res = till_closes(w, till, shift, out["id"], [ghost])

        assert res.status_code == 409
        assert status_of(w, out["id"])["status"] == S.WAITING_CLOSE

    def test_a_cashier_closing_first_completes_it_too(self, w):
        """The till closed the shift before the instruction reached it: done all the same."""
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)

        till_closes(w, till, shift, request_id=None)

        assert status_of(w, out["id"])["status"] == S.COMPLETED
        assert w.db.get(Shift, shift.id).close_request_id is None

    def test_a_failed_ack_ends_it(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)

        assert ack(w, till, out["id"], "failed", shift.id, code="unknown_shift").item_status == S.FAILED
        assert remote_close.take_pending_close_shift(w.db, till) is None

    def test_an_ack_from_another_till_is_404(self, w):
        till, other = w.tills
        open_shift(w, till)
        out, _ = ask(w, till)

        with pytest.raises(HTTPException) as e:
            ack(w, other, out["id"], "received")
        assert e.value.status_code == 404

    def test_while_waiting_it_says_what_the_cloud_already_holds(self, w):
        till = w.tills[0]
        till.pending_documents = 3
        till.pending_count_at = w.now - timedelta(minutes=1)
        shift = open_shift(w, till)
        w.doc(till, shift, "5.00")
        w.doc(till, shift, "6.00")
        out, _ = ask(w, till)

        read = status_of(w, out["id"])

        assert read["documentsOnCloud"] == 2
        assert read["pendingDocuments"] == 3 and read["pendingAsOf"] is not None
        assert read["online"] is True

    def test_an_administrative_close_is_picked_up_on_read(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)
        till.last_heartbeat_at = w.now - timedelta(hours=5)
        close_shift_administratively(w.db, till, w.db.get(Shift, shift.id), w.admin)

        assert status_of(w, out["id"])["status"] == S.COMPLETED


class TestAnUnknownRequestIdOnTheClose:
    def test_is_kept_in_neither_column(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)

        res = till_closes(w, till, shift, uuid.uuid4())

        assert res.status == "accepted"
        stored = w.db.get(Shift, shift.id)
        assert stored.close_request_id is None and stored.close_request_item_id is None


# ── Beside Z runs ────────────────────────────────────────────────────────────


class TestWithZRuns:
    def test_a_z_run_already_closing_the_till_refuses_it(self, w):
        till = w.tills[0]
        open_shift(w, till)
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=w.now)

        with pytest.raises(HTTPException) as e:
            ask(w, till)
        assert e.value.detail == f"z_run_in_progress:{r.id}"

    def test_a_z_run_started_meanwhile_is_built_by_the_same_close(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        doc = w.doc(till, shift, "25.00")
        out, _ = ask(w, till)
        r = ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=till.id)], now=w.now)
        item = r.items[0]
        assert item.status == ZRunItemStatus.WAITING_CLOSE and item.close_shift_id == shift.id
        # The Z run's instruction is handed first; both name the same shift.
        assert remote_close.take_pending_close_shift(w.db, till)["requestId"] == str(item.id)

        # The till answered the standalone one.
        res = till_closes(w, till, shift, out["id"], [doc])

        assert status_of(w, out["id"])["status"] == S.COMPLETED
        w.db.refresh(r)
        assert r.status == ZRunStatus.COMPLETED
        assert res.z_report_id == r.z_report_id is not None
        assert remote_close.take_pending_close_shift(w.db, till) is None


# ── Expiry and cancel ────────────────────────────────────────────────────────


class TestExpiryAndCancel:
    def test_it_expires_after_36h(self, w):
        till = w.tills[0]
        open_shift(w, till)
        req, _ = SCR.request_close(w.db, w.admin, till, now=w.now)
        assert req.expires_at == w.now + timedelta(hours=36)

        assert SCR.expire_overdue(w.db, now=w.now + timedelta(hours=37)) == 1

        assert req.status == S.EXPIRED and req.error_code == "expired"
        assert remote_close.take_pending_close_shift(w.db, till, now=w.now + timedelta(hours=37)) is None

    def test_an_expired_request_does_not_block_a_new_one(self, w):
        till = w.tills[0]
        open_shift(w, till)
        old, _ = SCR.request_close(w.db, w.admin, till, now=w.now - timedelta(hours=40))

        new, created = SCR.request_close(w.db, w.admin, till, now=w.now)

        assert created and new.id != old.id and old.status == S.EXPIRED

    def test_cancel_stops_the_handover_and_a_late_close_changes_nothing(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        out, _ = ask(w, till)

        cancelled = requests_router.cancel_shift_close_request(
            request_id=out["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

        assert cancelled["status"] == S.CANCELLED
        assert remote_close.take_pending_close_shift(w.db, till) is None
        assert ack(w, till, out["id"], "received", shift.id).item_status == S.CANCELLED
        assert till_closes(w, till, shift, out["id"]).status == "accepted"
        assert status_of(w, out["id"])["status"] == S.CANCELLED
        with pytest.raises(HTTPException) as e:
            requests_router.cancel_shift_close_request(
                request_id=out["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
            )
        assert e.value.detail == "request_not_pending"


# ── Who may ──────────────────────────────────────────────────────────────────


class TestAccess:
    def _user(self, w, role, shop=None):
        u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4()}@x",
                 username=role.value, shop_id=shop.id if shop else None)
        w.db.add(u)
        w.db.flush()
        return u

    def test_a_shop_manager_of_the_shop_may(self, w):
        till = w.tills[0]
        open_shift(w, till)

        out, code = ask(w, till, self._user(w, UserRole.SHOP_MANAGER, w.shop))

        assert code == 201 and out["status"] == S.WAITING_CLOSE

    def test_a_shop_manager_of_another_shop_may_not(self, w):
        till = w.tills[0]
        open_shift(w, till)

        with pytest.raises(HTTPException) as e:
            ask(w, till, self._user(w, UserRole.SHOP_MANAGER, w.other_shop))
        assert e.value.status_code == 403

    def test_another_distributors_till_is_refused(self, w):
        till = w.tills[0]
        open_shift(w, till)

        with pytest.raises(HTTPException) as e:
            ask(w, till, self._user(w, UserRole.DISTRIBUTOR))
        assert e.value.status_code == 403

    def test_another_tenants_request_is_404(self, w):
        till = w.tills[0]
        open_shift(w, till)
        out, _ = ask(w, till)

        with pytest.raises(HTTPException) as e:
            requests_router.get_shift_close_request(
                request_id=out["id"], current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db
            )
        assert e.value.status_code == 404

    @pytest.mark.parametrize(
        "endpoint",
        [
            machines_router.request_remote_shift_close,
            requests_router.get_shift_close_request,
            requests_router.cancel_shift_close_request,
        ],
    )
    def test_the_endpoints_need_a_machine_admin(self, endpoint):
        import inspect

        from app.middleware.auth import get_current_machine_admin

        param = inspect.signature(endpoint).parameters["current_user"]
        assert param.default.dependency is get_current_machine_admin
