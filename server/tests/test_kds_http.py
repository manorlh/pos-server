"""
The KDS contract with the Android till (docs/SPEC_KDS.md §8): the JSON exactly as the till
builds it (domain/KdsRelease.kt, ui/kds/KdsViewModel.kt) — camelCase, the till's ISO
times ("…Z"), null notes, an empty `held`, the screen's private `_stations` key (ignored)
— parsed by the same models FastAPI uses, and every answer serializable the way FastAPI
returns it (and read back by the till's KdsBoard.parse).

(Not through TestClient: the SQLite test world's in-memory connection cannot cross into
the server thread.)
"""
from __future__ import annotations

import json
import uuid

from fastapi.encoders import jsonable_encoder

from app.routers import kds as R
from app.schemas.kds import KdsActionIn, KdsReleaseIn
from test_kds import kd  # noqa: F401
from test_kitchen_printers import k  # noqa: F401
from test_shop_areas import w  # noqa: F401


def _wire(out):
    """What FastAPI would send: encoded and through JSON."""
    return json.loads(json.dumps(jsonable_encoder(out)))


def test_a_release_and_actions_as_the_till_sends_them(kd):
    w = kd
    raw = {
        "id": str(uuid.uuid4()), "source": "table", "sourceRef": "order-77", "trigger": "send", "paid": False,
        "fallbackPrinted": False, "occurredAt": "2026-10-06T10:00:00.000Z", "actorName": "דנה",
        "displayRef": "שולחן 12", "tableRef": "שולחן 12", "guests": 4, "waiterName": "דנה",
        "items": [
            {"lineKey": "l1:0", "productId": str(w.steak.id), "categoryId": str(w.steak.category_id), "name": "סטייק",
             "quantity": 2.0, "notes": "בלי בצל", "mods": ["מדיום"], "allergies": ["בוטנים"], "seat": "סועד 2"},
        ],
        "held": [],
        "noteUpdates": [{"lineKey": "l9:0", "notes": None}],
    }
    body = KdsReleaseIn.model_validate(json.loads(json.dumps(raw)))
    first = _wire(R.post_kds_release(str(w.waiter.id), body, machine=w.waiter, db=w.db))
    assert first["tasksCreated"] == 1 and first["accepted"] is True
    again = _wire(R.post_kds_release(str(w.waiter.id), body, machine=w.waiter, db=w.db))
    assert again["replayed"] is True

    board = _wire(R.get_kds_board(str(w.grill_screen.id), since=None, machine=w.grill_screen, db=w.db))
    assert board["syncType"] == "full" and board["shopName"] == w.shop.name
    order = board["orders"][0]
    assert order["displayRef"] == "שולחן 12" and order["tableRef"] == "שולחן 12"
    task = order["tasks"][0]
    assert task["mods"] == ["מדיום"] and task["seat"] == "סועד 2" and task["activeQty"] == 2.0
    assert isinstance(task["version"], int) and task["release"] == "released" and task["state"] == "queued"

    action = KdsActionIn.model_validate({
        "id": str(uuid.uuid4()), "type": "item_ready", "taskId": task["id"], "qty": 2.0,
        "occurredAt": "2026-10-06T10:05:00.000Z", "actorName": "גריל", "_stations": [w.grill],
    })
    out = _wire(R.post_kds_action(str(w.grill_screen.id), action, machine=w.grill_screen, db=w.db))
    assert out["outcome"] == "applied" and out["order"]["groupState"] == "ready_for_pickup"

    device = _wire(R.get_kds_device(str(w.grill_screen.id), machine=w.grill_screen, db=w.db))
    assert device["device"]["role"] == "station" and device["device"]["stations"][0]["id"] == w.grill
    assert device["workflow"]["enabled"] is True and len(device["workflow"]["configVersion"]) == 12

    states = _wire(R.get_kds_order_states(str(w.waiter.id), source="table", refs="order-77", machine=w.waiter, db=w.db))
    assert states["orders"]["order-77"]["ready"] == 1


def test_a_paid_sale_as_the_till_reports_it(kd):
    w = kd
    raw = {
        "id": str(uuid.uuid4()), "source": "quick", "sourceRef": "tx-1", "trigger": "payment", "paid": True,
        "fallbackPrinted": False, "serviceType": "take_away", "pickupName": "דנה", "transactionNumber": "1043",
        "items": [{"lineKey": "a:0", "productId": str(w.cola.id), "name": "קולה", "quantity": 1.0}],
        "noteUpdates": [],
    }
    out = _wire(R.post_kds_release(str(w.waiter.id), KdsReleaseIn.model_validate(raw), machine=w.waiter, db=w.db))
    assert out["pickupNumber"] == 1
    pickup = _wire(R.get_kds_board(str(w.pickup_screen.id), since=None, machine=w.pickup_screen, db=w.db))["pickup"]
    assert pickup["preparing"][0]["number"] == "1"
