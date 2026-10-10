"""
Every kiosk's paid KDS-mode order reaches the kitchen engine (docs/SPEC_LAN_MODE.md §8).

The plan found that only the Android kiosk called `kds/release`. Now:

* **The Windows kiosk / the bridge** (kiosk-desktop, which issues its documents through its own
  ledger) sends the Android kiosk's release (`kiosk-desktop/src/main/kiosk/kdsRelease.ts`, its
  golden `tests/fixtures/kiosk_desktop/kds_release.json`): `source=kiosk`, after payment, its
  pickup number kept, idempotent by the document — a second send is the same release.
* **A browser kiosk's pay-at-till order** is released by the till that settles it, once, as a
  kiosk order with the kiosk's pickup number (pos-android KioskPayAtTill.afterPaid): the till is
  no kiosk, so the kiosk gate does not apply to it.
* A BON kiosk never appears on a kitchen screen.

Runs on the world of tests/test_kds.py.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from app.models.kds import KitchenOrder, KitchenTask
from app.routers import kiosks as KR
from app.schemas.kds import KdsReleaseIn
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.services import kds as KDS
from app.services import kiosk_config as C
from test_kds import _task, board, kd, k, w  # noqa: F401

FIXTURE = Path(__file__).parent / "fixtures" / "kiosk_desktop" / "kds_release.json"


@pytest.fixture
def ks(kd, monkeypatch):
    """The KDS world, with till 2 a self-order kiosk in KDS mode."""
    monkeypatch.setattr(C, "kds_available", lambda: True)
    kd.kiosk = kd.tills[1]
    KR.create_kiosk(
        body=KioskCreateIn(machineId=kd.kiosk.id, name="קיוסק Windows", controllerMachineIds=[str(kd.waiter.id)]),
        current_user=kd.admin, active_tenant_id=kd.tenant.id, db=kd.db,
    )
    KR.put_settings(
        body=KioskSettingsIn(overrides={"general": {"fulfillmentMode": "KDS"}}), level="machine", scope_id=kd.kiosk.id,
        current_user=kd.admin, active_tenant_id=kd.tenant.id, db=kd.db,
    )
    kd.db.commit()
    return kd


def windows_release(kd, **over):
    """The Windows kiosk's golden body, its lines on this world's menu."""
    body = json.loads(FIXTURE.read_text(encoding="utf-8"))
    body["items"] = [
        {**body["items"][0], "productId": str(kd.steak.id), "categoryId": str(kd.steak.category_id), "name": "steak"},
        {**body["items"][1], "productId": str(kd.cola.id), "categoryId": str(kd.cola.category_id), "name": "cola"},
    ]
    body.update(over)
    return KdsReleaseIn.model_validate(body)


class TestTheWindowsKiosk:
    def test_its_paid_order_reaches_the_stations_with_its_pickup_number(self, ks):
        out = KDS.release(ks.db, ks.kiosk, windows_release(ks))
        assert out["accepted"] is True and out["tasksCreated"] == 2 and out["pickupNumber"] == 17
        order = ks.db.query(KitchenOrder).one()
        assert (order.source, order.paid, order.display_ref) == ("kiosk", True, "40000057")
        assert order.contact_phone == "0501234567" and order.pickup_name == "דנה"
        assert _task(board(ks, ks.grill_screen), "steak")["state"] == "queued"
        # The pickup screen says what the slip says: "A-17" (the kiosk's label), not "17".
        assert [r["number"] for r in board(ks, ks.pickup_screen)["pickup"]["preparing"]] == ["A-17"]

    def test_sent_again_it_is_the_same_release(self, ks):
        first = KDS.release(ks.db, ks.kiosk, windows_release(ks))
        again = KDS.release(ks.db, ks.kiosk, windows_release(ks, occurredAt="2026-10-06T09:20:00.000Z"))
        assert again["replayed"] is True and again["dispatchId"] == first["dispatchId"]
        assert ks.db.query(KitchenTask).count() == 2

    def test_a_bon_kiosk_never_reaches_a_kitchen_screen(self, ks):
        KR.put_settings(
            body=KioskSettingsIn(overrides={"general": {"fulfillmentMode": "BON"}}), level="machine", scope_id=ks.kiosk.id,
            current_user=ks.admin, active_tenant_id=ks.tenant.id, db=ks.db,
        )
        assert KDS.release(ks.db, ks.kiosk, windows_release(ks)) == {"accepted": False, "reason": "kiosk_not_kds"}
        assert ks.db.query(KitchenOrder).count() == 0


class TestTheKiosksPickupLabel:
    """
    "מספר הזמנה: עם אות (A-17) / מספר בלבד (17)" (kiosk `pickup.labelFormat`): a kiosk's release
    carries the label its slip printed; the cards, the till's "הזמנות להכנה", the pickup screen and
    the ready message say it. An order without one answers exactly as before (no `pickupLabel` key).
    """

    def test_with_its_letter(self, ks):
        KDS.release(ks.db, ks.kiosk, windows_release(ks))
        assert ks.db.query(KitchenOrder).one().pickup_label == "A-17"
        card = board(ks, ks.grill_screen)["orders"][0]
        assert (card["pickupLabel"], card["pickupNumber"]) == ("A-17", 17)
        assert [r["number"] for r in board(ks, ks.pickup_screen)["pickup"]["preparing"]] == ["A-17"]
        listed = KDS.ready_orders(ks.db, ks.waiter)["orders"][0]
        assert (listed["pickupLabel"], listed["pickupNumber"]) == ("A-17", 17)

    def test_the_number_alone(self, ks):
        KDS.release(ks.db, ks.kiosk, windows_release(ks, pickupLabel="17"))
        assert board(ks, ks.grill_screen)["orders"][0]["pickupLabel"] == "17"
        assert [r["number"] for r in board(ks, ks.pickup_screen)["pickup"]["preparing"]] == ["17"]

    def test_without_a_label_nothing_changes(self, ks):
        body = windows_release(ks)
        body.pickup_label = None
        KDS.release(ks.db, ks.kiosk, body)
        assert "pickupLabel" not in board(ks, ks.grill_screen)["orders"][0]
        assert "pickupLabel" not in KDS.ready_orders(ks.db, ks.waiter)["orders"][0]
        assert [r["number"] for r in board(ks, ks.pickup_screen)["pickup"]["preparing"]] == ["17"]

    def test_the_ready_messages_contact_names_the_label(self, ks):
        from types import SimpleNamespace

        from app.services import kds_outbox

        KDS.release(ks.db, ks.kiosk, windows_release(ks))
        order = ks.db.query(KitchenOrder).one()
        event = SimpleNamespace(tenant_id=order.tenant_id, payload={"orderId": order.id, "groupId": None})
        contact = kds_outbox.order_contact(ks.db, event)
        assert (contact["pickupLabel"], contact["pickupNumber"]) == ("A-17", 17)


class TestPayAtTill:
    def test_the_till_that_settles_a_browser_kiosk_order_releases_it_once(self, ks):
        tx = str(uuid.uuid4())
        body = {
            "id": str(uuid.uuid4()), "source": "kiosk", "sourceRef": tx, "trigger": "payment", "paid": True,
            "pickupNumber": 42, "pickupName": "קיוסק · דנה", "transactionNumber": "10000003",
            "items": [{"lineKey": "a:0", "productId": str(ks.steak.id), "categoryId": str(ks.steak.category_id),
                       "name": "steak", "quantity": 1}],
        }
        out = KDS.release(ks.db, ks.waiter, KdsReleaseIn.model_validate(body))
        assert out["accepted"] is True and out["pickupNumber"] == 42
        assert KDS.release(ks.db, ks.waiter, KdsReleaseIn.model_validate(body))["replayed"] is True
        assert ks.db.query(KitchenTask).count() == 1
