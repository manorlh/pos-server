"""
Messages to tills ("הודעות לקופות"): a manager sends, each targeted till shows it until
its signed-in employee taps "קראתי".

What each class pins:

* **Targeting** — a company (with its group), a shop, an area or one till expands to
  the active tills in it that the sender can see, fixed at send time.
* **Scoping** — a shop manager can message their shop, its areas and tills and nothing
  else; nobody reaches another tenant; the list shows only tills the reader can see.
* **The till's contract** — `GET /sync/{id}/messages` is unacknowledged and unexpired,
  oldest first, and marks delivery; `POST …/ack` is idempotent and 404s for a message
  not addressed to that till.
* **Expiry, cancel, resend** — an expired or cancelled message leaves the tills; resend
  wakes only those that have not acknowledged.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.middleware.auth import get_current_machine_admin
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop_area import ShopArea
from app.models.till_message import TillMessage, TillMessageReceipt
from app.models.user import User, UserRole
from app.routers import till_messages as R
from app.schemas.till_message import TillMessageAckIn, TillMessageCreate
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def send(w, level, target, body="חברים למכור יותר זה הזמן!", *, user=None, title=None, expires_at=None):
    tasks = BackgroundTasks()
    out = R.send_till_message(
        TillMessageCreate(
            title=title, body=body, targetLevel=level,
            targetId=target.id if hasattr(target, "id") else target, expiresAt=expires_at,
        ),
        tasks,
        **_ctx(w, user),
    )
    _run(tasks)
    return out


def listed(w, user=None):
    return R.list_till_messages(limit=30, offset=0, **_ctx(w, user))


def pull(w, till):
    return R.get_own_till_messages(str(till.id), machine=till, db=w.db)["items"]


def ack(w, till, message_id, user_id="pu-1", name="דנה"):
    return R.ack_own_till_message(
        str(till.id), str(message_id),
        TillMessageAckIn(posUserId=user_id, posUserName=name),
        machine=till, db=w.db,
    )


def receipts(w, message_id):
    return {
        r.machine_id: r
        for r in w.db.query(TillMessageReceipt).filter(
            TillMessageReceipt.message_id == uuid.UUID(str(message_id))
        )
    }


@pytest.fixture
def bar(w):
    a = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(a)
    w.db.flush()
    w.tills[0].area_id = a.id
    w.db.commit()
    return a


class TestTargeting:
    def test_a_company_reaches_every_active_till_of_its_shops(self, w):
        out = send(w, "company", w.company)
        assert set(receipts(w, out["id"])) == {w.tills[0].id, w.tills[1].id, w.other_till.id}
        assert out["counts"] == {"total": 3, "delivered": 0, "acknowledged": 0}
        assert out["targetName"] == "Acme" and out["status"] == "active"

    def test_a_shop_an_area_and_a_till(self, w, bar):
        assert set(receipts(w, send(w, "shop", w.shop)["id"])) == {t.id for t in w.tills}
        assert set(receipts(w, send(w, "area", bar)["id"])) == {w.tills[0].id}
        assert set(receipts(w, send(w, "machine", w.other_till)["id"])) == {w.other_till.id}

    def test_a_decommissioned_till_is_not_reached(self, w):
        w.tills[1].is_active = False
        w.db.commit()
        assert set(receipts(w, send(w, "shop", w.shop)["id"])) == {w.tills[0].id}

    def test_the_audience_is_fixed_at_send_time(self, w):
        out = send(w, "shop", w.shop)
        late = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
            name="Late", machine_code="M-late", pos_number="9", is_active=True,
            pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(late)
        w.db.commit()
        assert pull(w, late) == []
        assert late.id not in receipts(w, out["id"])

    def test_an_empty_target_is_refused(self, w):
        empty = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Empty")
        w.db.add(empty)
        w.db.commit()
        assert refused(send, w, "area", empty).detail == "till_message_no_tills"
        assert w.db.query(TillMessage).count() == 0

    def test_tills_are_woken_after_the_commit(self, w):
        send(w, "shop", w.shop)
        assert sorted(w.notified) == sorted(
            (str(t.id), "till_message") for t in w.tills
        )

    def test_the_body_is_required_and_the_title_optional(self):
        with pytest.raises(ValidationError):
            TillMessageCreate(body="   ", targetLevel="shop", targetId=uuid.uuid4())
        with pytest.raises(ValidationError):
            TillMessageCreate(body="x", targetLevel="tenant", targetId=uuid.uuid4())
        ok = TillMessageCreate(title="  ", body=" hi ", targetLevel="shop", targetId=uuid.uuid4())
        assert (ok.title, ok.body) == (None, "hi")

    def test_an_expiry_in_the_past_is_refused(self, w):
        past = datetime.now(timezone.utc) - timedelta(minutes=1)
        assert refused(send, w, "shop", w.shop, expires_at=past).detail == "till_message_expiry_in_past"


class TestScoping:
    def test_a_shop_manager_messages_their_shop_area_and_tills(self, w, bar):
        assert send(w, "shop", w.shop, user=w.manager)["counts"]["total"] == 2
        assert send(w, "area", bar, user=w.manager)["counts"]["total"] == 1
        assert send(w, "machine", w.tills[1], user=w.manager)["counts"]["total"] == 1

    def test_a_shop_manager_cannot_reach_another_shop_or_the_company(self, w):
        assert refused(send, w, "shop", w.other_shop, user=w.manager).status_code == 403
        assert refused(send, w, "machine", w.other_till, user=w.manager).status_code == 403
        assert refused(send, w, "company", w.company, user=w.manager).status_code == 403

    def test_a_company_manager_reaches_their_company(self, w):
        assert send(w, "company", w.company, user=w.company_manager)["counts"]["total"] == 3

    def test_another_tenants_target_is_not_found(self, w):
        assert refused(send, w, "shop", w.foreign_shop).status_code == 404
        assert refused(send, w, "area", w.foreign_area).status_code == 404
        assert refused(send, w, "shop", uuid.uuid4()).status_code == 404

    def test_a_cashier_is_not_a_till_manager(self, w):
        with pytest.raises(HTTPException) as e:
            get_current_machine_admin(w.cashier)
        assert e.value.status_code == 403

    def test_a_distributor_reaches_only_the_tills_they_placed(self, w):
        dist = User(
            id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=w.tenant.id,
            email="d@x", username="dist",
        )
        w.db.add(dist)
        w.tills[1].distributor_id = dist.id
        w.db.commit()
        out = send(w, "shop", w.shop, user=dist)
        assert set(receipts(w, out["id"])) == {w.tills[1].id}

    def test_the_list_shows_only_tills_the_reader_can_see(self, w):
        send(w, "company", w.company)
        send(w, "machine", w.other_till)
        mine = listed(w, user=w.manager)
        assert mine["total"] == 1
        (item,) = mine["items"]
        assert {t["machineId"] for t in item["tills"]} == {t.id for t in w.tills}
        # The company-wide message is not theirs to cancel.
        assert item["canManage"] is False
        assert listed(w)["total"] == 2

    def test_a_shop_manager_cannot_cancel_a_company_message(self, w):
        out = send(w, "company", w.company)
        e = refused(R.cancel_till_message, str(out["id"]), BackgroundTasks(), **_ctx(w, w.manager))
        assert e.status_code == 403


class TestTillContract:
    def test_pending_messages_oldest_first_and_delivery_marked_once(self, w):
        first = send(w, "shop", w.shop, title="שלום", body="first")
        second = send(w, "machine", w.tills[0], body="second")
        till = w.tills[0]
        items = pull(w, till)
        assert [i["id"] for i in items] == [str(first["id"]), str(second["id"])]
        assert set(items[0]) == {"id", "title", "body", "sentAt", "senderName"}
        assert (items[0]["title"], items[0]["body"], items[0]["senderName"]) == ("שלום", "first", "admin")
        assert datetime.fromisoformat(items[0]["sentAt"]).tzinfo is not None

        delivered = receipts(w, first["id"])[till.id].delivered_at
        assert delivered is not None
        pull(w, till)
        assert receipts(w, first["id"])[till.id].delivered_at == delivered
        assert receipts(w, first["id"])[w.tills[1].id].delivered_at is None

        row = next(i for i in listed(w)["items"] if i["id"] == first["id"])
        assert row["counts"] == {"total": 2, "delivered": 1, "acknowledged": 0}

    def test_an_acknowledged_message_leaves_the_till_and_records_who(self, w):
        out = send(w, "shop", w.shop)
        till = w.tills[0]
        assert ack(w, till, out["id"]) == {"ok": True}
        assert pull(w, till) == []
        assert len(pull(w, w.tills[1])) == 1
        r = receipts(w, out["id"])[till.id]
        assert (r.acknowledged_by_pos_user_id, r.acknowledged_by_pos_user_name) == ("pu-1", "דנה")
        assert r.delivered_at is not None and r.acknowledged_at is not None
        status = {t["machineId"]: t for t in listed(w)["items"][0]["tills"]}
        assert status[till.id]["status"] == "acknowledged"
        assert status[till.id]["acknowledgedByName"] == "דנה"
        assert status[w.tills[1].id]["status"] == "delivered"

    def test_ack_is_idempotent_and_the_first_one_stands(self, w):
        out = send(w, "machine", w.tills[0])
        ack(w, w.tills[0], out["id"], user_id="pu-1", name="דנה")
        first = receipts(w, out["id"])[w.tills[0].id].acknowledged_at
        assert ack(w, w.tills[0], out["id"], user_id="pu-2", name="יוסי") == {"ok": True}
        r = receipts(w, out["id"])[w.tills[0].id]
        assert (r.acknowledged_at, r.acknowledged_by_pos_user_name) == (first, "דנה")

    def test_another_tills_message_is_404(self, w):
        out = send(w, "machine", w.tills[0])
        e = refused(ack, w, w.tills[1], out["id"])
        assert e.status_code == 404
        assert refused(ack, w, w.tills[0], uuid.uuid4()).status_code == 404
        assert refused(ack, w, w.tills[0], "not-a-uuid").status_code == 404

    def test_an_ack_with_no_body_and_a_numeric_user_id(self, w):
        out = send(w, "machine", w.tills[0])
        assert R.ack_own_till_message(
            str(w.tills[0].id), str(out["id"]), None, machine=w.tills[0], db=w.db
        ) == {"ok": True}
        assert TillMessageAckIn.model_validate({"posUserId": 17}).pos_user_id == "17"

    def test_the_routes_are_mounted(self):
        from app.main import app

        mounted = {
            (method, route.path)
            for route in app.routes
            for method in (getattr(route, "methods", None) or ())
        }
        assert ("GET", "/api/v1/sync/{machine_id}/messages") in mounted
        assert ("POST", "/api/v1/sync/{machine_id}/messages/{message_id}/ack") in mounted
        assert ("POST", "/api/v1/till-messages") in mounted


class TestExpiryCancelResend:
    def test_an_expired_message_leaves_the_tills(self, w):
        out = send(w, "shop", w.shop, expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
        assert len(pull(w, w.tills[0])) == 1
        row = w.db.get(TillMessage, uuid.UUID(str(out["id"])))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        w.db.commit()
        assert pull(w, w.tills[0]) == []
        assert listed(w)["items"][0]["status"] == "expired"
        # A late ack of what it showed is still recorded.
        assert ack(w, w.tills[0], out["id"]) == {"ok": True}

    def test_cancel_expires_it_now_and_is_idempotent(self, w):
        out = send(w, "shop", w.shop)
        w.notified.clear()
        tasks = BackgroundTasks()
        cancelled = R.cancel_till_message(str(out["id"]), tasks, **_ctx(w))
        _run(tasks)
        assert cancelled["status"] == "cancelled" and cancelled["canManage"] is False
        assert pull(w, w.tills[0]) == []
        assert len(w.notified) == 2
        again = R.cancel_till_message(str(out["id"]), BackgroundTasks(), **_ctx(w))
        assert again["cancelledAt"] == cancelled["cancelledAt"]

    def test_resend_wakes_only_the_tills_that_have_not_acknowledged(self, w):
        out = send(w, "shop", w.shop)
        ack(w, w.tills[0], out["id"])
        w.notified.clear()
        tasks = BackgroundTasks()
        again = R.resend_till_message(str(out["id"]), tasks, **_ctx(w))
        _run(tasks)
        assert again["notified"] == 1
        assert w.notified == [(str(w.tills[1].id), "till_message")]

    def test_resend_after_cancel_is_refused(self, w):
        out = send(w, "shop", w.shop)
        R.cancel_till_message(str(out["id"]), BackgroundTasks(), **_ctx(w))
        e = refused(R.resend_till_message, str(out["id"]), BackgroundTasks(), **_ctx(w))
        assert (e.status_code, e.detail) == (409, "till_message_closed")

    def test_another_tenants_message_is_not_found(self, w):
        out = send(w, "shop", w.shop)
        e = refused(
            R.cancel_till_message, str(out["id"]), BackgroundTasks(),
            current_user=w.admin, active_tenant_id=w.foreign_shop.tenant_id, db=w.db,
        )
        assert e.status_code == 404
