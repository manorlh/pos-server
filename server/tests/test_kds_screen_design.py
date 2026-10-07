"""
The screens' design and the board's scope (docs/SPEC_KDS.md §14, §15).

* **The look, v2** (`kds_devices.display`, app/services/kds_display.py): layouts and options for
  the kitchen screen and the board, validated on the way in, cleaned on the way out; every key
  missing = today's look; a v1 board look still works; a v1 value on a kitchen screen is a board
  look only.
* **The shop's defaults** (`shops.settings.kdsDisplayDefaults`): a screen without its own look
  shows the default of its kind; "follow the shop" drops the screen's own; absent keeps, null
  removes; the screens hear it (the version moves); never in the tills' settings.
* **How long a number stays ready** (`readyMinutes`) and **the board's scope** (points of sale /
  machines, `kds_devices.scope`).
* **"הזמנות להכנה" on a till** (a shop with a board and no KDS): ready / handed over / back, the
  KDS's own transitions — the same board and the same one ReadyForPickup event; idempotent;
  never from a kiosk or a display device; never another shop's order.

Runs on the world of tests/test_kds.py (SQLite).
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from pydantic import ValidationError

from app.models.kds import FulfillmentGroup, KdsDevice
from app.models.shop_area import ShopArea
from app.routers import kds as R
from app.schemas.kds import KdsDeviceIn, KdsDisplayDefaultsIn, KdsReadyActionIn
from app.services import kds as KDS
from app.services import kds_display as D
from test_kds import _till, act, board, device, events, item, kd, refused, release  # noqa: F401
from test_kitchen_printers import k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401

TODAY_KDS = {
    "layout": "tickets", "columnsBy": "station", "density": "normal", "fontScale": 1.0, "ageColors": True,
    "warnMinutes": None, "lateMinutes": None, "clock": True, "counts": True,
    "fields": {f: True for f in D.FIELDS}, "sounds": {"new": "chime", "change": "knock", "late": "off"},
}
TODAY_BOARD = {"theme": "dark", "accent": None, "sound": True, "showPreparing": True, "title": None,
               "boardLayout": "columns", "readyMinutes": None, "media": [], "promoText": None}


def _save(w, screen, role, display=None, **extra):
    body = {"role": role, "name": f"{role} screen", **extra}
    if display is not None:
        body["display"] = display
    if role == "station":
        body.setdefault("stationIds", [w.grill])
    return R.put_kds_device(w.shop.id, screen.id, KdsDeviceIn.model_validate(body), **_ctx(w))


def _defaults(w, **body):
    return R.put_kds_display_defaults(w.shop.id, KdsDisplayDefaultsIn.model_validate(body), **_ctx(w))["displayDefaults"]


def _kiosk_order(w, ref, till=None):
    return release(w, till=till, source="kiosk", ref=ref, paid=True, trigger="payment", items=[item("l1:0", w.steak)])


def _ready(w, till, type_, order_id, aid=None):
    body = KdsReadyActionIn.model_validate({"id": aid or str(uuid.uuid4()), "type": type_, "orderId": str(order_id)})
    return R.post_kds_ready_action(str(till.id), body, machine=till, db=w.db)


def _ready_list(w, till):
    return R.get_kds_ready_orders(str(till.id), machine=till, db=w.db)


def _numbers(w, screen, column="ready"):
    return [n["number"] for n in board(w, screen)["pickup"][column]]


# ── The look, v2 ──────────────────────────────────────────────────────────────


class TestTheLook:
    def test_nothing_stored_is_null_and_every_missing_key_is_todays_look(self):
        assert D.display_out(None) is None
        out = D.display_out({})
        assert out["v"] == 2
        assert {k: out[k] for k in TODAY_KDS} == TODAY_KDS
        assert {k: out[k] for k in TODAY_BOARD} == TODAY_BOARD

    def test_a_full_kitchen_look_is_saved_cleaned_and_sent_with_the_screen(self, kd):
        look = {
            "theme": "contrast", "accent": "#FF8800", "layout": "columns", "columnsBy": "course", "density": "large",
            "fontScale": 1.234, "ageColors": True, "warnMinutes": 8, "lateMinutes": 12,
            "fields": {"waiter": False, "guests": False}, "sounds": {"new": "bell", "late": "beep"},
            "clock": False, "counts": True,
        }
        out = _save(kd, kd.expo_screen, "expo", look)
        d = out["display"]
        assert (d["theme"], d["accent"], d["layout"], d["columnsBy"], d["density"]) == ("contrast", "#ff8800", "columns", "course", "large")
        assert d["fontScale"] == 1.23 and (d["warnMinutes"], d["lateMinutes"]) == (8, 12)
        assert d["fields"]["waiter"] is False and d["fields"]["guests"] is False and d["fields"]["allergens"] is True
        assert d["sounds"] == {"new": "bell", "change": "knock", "late": "beep"}
        assert d["clock"] is False and out["displayOwn"] is True
        # The screen draws it within its next poll.
        assert board(kd, kd.expo_screen)["device"]["display"] == d
        assert R.get_kds_device(str(kd.expo_screen.id), machine=kd.expo_screen, db=kd.db)["device"]["display"] == d

    def test_a_board_look_with_its_media_and_promo(self, kd):
        media = [{"url": "https://cdn.example.com/kiosk/a.jpg", "kind": "image", "sha256": "A" * 64, "bytes": 1200, "durationSec": 12},
                 {"url": "https://cdn.example.com/kiosk/b.mp4", "kind": "video"}]
        out = _save(kd, kd.pickup_screen, "pickup", {"boardLayout": "split", "readyMinutes": 10, "media": media, "promoText": "  שתייה   ב-5  "})
        d = out["display"]
        assert d["boardLayout"] == "split" and d["readyMinutes"] == 10 and d["promoText"] == "שתייה ב-5"
        assert d["media"][0] == {"url": media[0]["url"], "kind": "image", "sha256": "a" * 64, "bytes": 1200, "durationSec": 12}
        assert d["media"][1]["kind"] == "video" and d["media"][1]["durationSec"] == 8 and d["media"][1]["sha256"] is None

    @pytest.mark.parametrize("bad", [
        {"layout": "mosaic"}, {"boardLayout": "carousel"}, {"density": "huge"}, {"fontScale": 2}, {"fontScale": 0.5},
        {"warnMinutes": 8}, {"lateMinutes": 12}, {"warnMinutes": 12, "lateMinutes": 12}, {"readyMinutes": 0},
        {"sounds": {"new": "siren"}}, {"media": [{"url": "ftp://x/y.jpg"}]}, {"media": [{"url": "https://x/y.jpg", "durationSec": 1}]},
        {"media": [{"url": f"https://x/{i}.jpg"} for i in range(13)]}, {"promoText": "x" * 141}, {"columnsBy": "zone"},
    ])
    def test_a_bad_value_is_refused(self, bad):
        with pytest.raises(ValidationError):
            KdsDeviceIn(role="expo", display=bad)

    def test_a_stored_value_is_cleaned_on_the_way_out(self):
        out = D.display_out({
            "v": 2, "layout": "x", "fontScale": "big", "warnMinutes": 12, "lateMinutes": 8, "density": None,
            "fields": {"notes": False, "x": 1, "table": "no"}, "sounds": {"new": "siren", "late": "bell"},
            "media": [{"url": "ftp://x"}, {"url": "https://a/b.jpg", "durationSec": 1, "kind": "gif"}, "junk"],
            "readyMinutes": 9999, "title": "   ", "clock": "yes",
        })
        assert (out["layout"], out["fontScale"], out["density"]) == ("tickets", 1.0, "normal")
        assert (out["warnMinutes"], out["lateMinutes"]) == (None, None)  # late before warn: the stations'
        assert out["fields"]["notes"] is False and out["fields"]["table"] is True and "x" not in out["fields"]
        assert out["sounds"] == {"new": "chime", "change": "knock", "late": "bell"}
        assert out["media"] == [{"url": "https://a/b.jpg", "kind": "image", "sha256": None, "bytes": None, "durationSec": 8}]
        assert out["readyMinutes"] is None and out["title"] is None and out["clock"] is True
        assert D.display_out({"fontScale": 9})["fontScale"] == 1.6

    def test_a_v1_value_is_a_board_look_only(self, kd):
        v1 = {"theme": "light", "accent": "#16a34a", "sound": False, "showPreparing": False, "title": "איסוף"}
        screen = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == kd.expo_screen.id).one()
        screen.display = dict(v1)
        pickup = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == kd.pickup_screen.id).one()
        pickup.display = dict(v1)
        kd.db.flush()
        # The board keeps drawing it (and today's layout); the kitchen screen ignores it.
        p = board(kd, kd.pickup_screen)["device"]["display"]
        assert (p["theme"], p["showPreparing"], p["boardLayout"]) == ("light", False, "columns")
        e = board(kd, kd.expo_screen)["device"]
        assert e["display"] is None and e["displayOwn"] is False


# ── The shop's defaults ───────────────────────────────────────────────────────


class TestShopDefaults:
    def test_a_screen_without_its_own_look_shows_the_default_of_its_kind(self, kd):
        out = _defaults(kd, kds={"layout": "list", "theme": "light"}, board={"boardLayout": "spotlight"})
        assert out["kds"]["layout"] == "list" and out["board"]["boardLayout"] == "spotlight"
        e = board(kd, kd.expo_screen)["device"]
        assert e["display"]["layout"] == "list" and e["display"]["theme"] == "light" and e["displayOwn"] is False
        assert board(kd, kd.pickup_screen)["device"]["display"]["boardLayout"] == "spotlight"
        overview = R.get_kds_shop(kd.shop.id, **_ctx(kd))
        assert overview["displayDefaults"]["kds"]["layout"] == "list"

    def test_the_screens_own_look_wins_and_follow_the_shop_drops_it(self, kd):
        _defaults(kd, kds={"layout": "list"})
        _save(kd, kd.expo_screen, "expo", {"layout": "big"})
        assert board(kd, kd.expo_screen)["device"]["display"]["layout"] == "big"
        # A save without `display` keeps it; `displayInherit` goes back to the shop's.
        _save(kd, kd.expo_screen, "expo")
        assert board(kd, kd.expo_screen)["device"]["display"]["layout"] == "big"
        out = _save(kd, kd.expo_screen, "expo", {"layout": "rail"}, displayInherit=True)
        assert out["display"]["layout"] == "list" and out["displayOwn"] is False

    def test_absent_keeps_null_removes_and_the_screens_hear_it(self, kd):
        _defaults(kd, kds={"layout": "list"}, board={"boardLayout": "grid"})
        first = board(kd, kd.expo_screen)
        out = _defaults(kd, board=None)
        assert out["kds"]["layout"] == "list" and out["board"] is None
        assert board(kd, kd.expo_screen, since=first["version"])["syncType"] == "full"
        assert _defaults(kd, kds=None) == {"kds": None, "board": None}
        assert "kdsDisplayDefaults" not in (kd.shop.settings or {})
        assert board(kd, kd.expo_screen)["device"]["display"] is None

    def test_never_in_the_tills_settings(self, kd):
        from app.services.settings_merge import merge_settings

        _defaults(kd, kds={"layout": "list"})
        assert "kdsDisplayDefaults" in kd.shop.settings
        assert "kdsDisplayDefaults" not in merge_settings(kd.company, kd.shop, kd.tenant)


# ── How long a number stays ready, and the board's scope ──────────────────────


class TestReadyMinutes:
    def test_a_ready_number_leaves_the_board_after_its_minutes(self, kd):
        a = _kiosk_order(kd, "r1")
        b = _kiosk_order(kd, "r2")
        for o in (a, b):
            act(kd, kd.grill_screen, "station_ready", orderId=o["orderId"])
        assert len(_numbers(kd, kd.pickup_screen)) == 2
        _save(kd, kd.pickup_screen, "pickup", {"readyMinutes": 5})
        group = kd.db.query(FulfillmentGroup).filter(FulfillmentGroup.order_id == uuid.UUID(a["orderId"])).one()
        group.ready_at = group.ready_at - timedelta(minutes=6)
        kd.db.flush()
        assert _numbers(kd, kd.pickup_screen) == [str(b["pickupNumber"])]
        # Without the option: until handed over, as before.
        _save(kd, kd.pickup_screen, "pickup", {"readyMinutes": None})
        assert len(_numbers(kd, kd.pickup_screen)) == 2


class TestBoardScope:
    def _areas(self, kd):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=kd.tenant.id, shop_id=kd.shop.id, name="בר")
        terrace = ShopArea(id=uuid.uuid4(), tenant_id=kd.tenant.id, shop_id=kd.shop.id, name="מרפסת")
        kd.db.add_all([bar, terrace])
        kd.db.flush()
        kd.bar_till = _till(kd, "קופת בר")
        kd.bar_till.area_id = bar.id
        kd.terrace_till = _till(kd, "קופת מרפסת")
        kd.terrace_till.area_id = terrace.id
        kd.kiosk = _till(kd, "קיוסק")
        kd.db.flush()
        return bar, terrace

    def test_only_the_orders_of_its_points_of_sale_or_machines(self, kd):
        bar, terrace = self._areas(kd)
        a = _kiosk_order(kd, "s1", till=kd.bar_till)
        b = _kiosk_order(kd, "s2", till=kd.terrace_till)
        c = _kiosk_order(kd, "s3", till=kd.kiosk)
        every = {str(o["pickupNumber"]) for o in (a, b, c)}
        assert set(_numbers(kd, kd.pickup_screen, "preparing")) == every
        out = _save(kd, kd.pickup_screen, "pickup", scope={"areaIds": [str(bar.id)]})
        assert out["scope"] == {"areaIds": [str(bar.id)], "machineIds": []}
        assert _numbers(kd, kd.pickup_screen, "preparing") == [str(a["pickupNumber"])]
        _save(kd, kd.pickup_screen, "pickup", scope={"areaIds": [str(bar.id)], "machineIds": [str(kd.kiosk.id)]})
        assert set(_numbers(kd, kd.pickup_screen, "preparing")) == {str(a["pickupNumber"]), str(c["pickupNumber"])}
        # A save without `scope` keeps it; an empty one is the whole shop again.
        _save(kd, kd.pickup_screen, "pickup")
        assert len(_numbers(kd, kd.pickup_screen, "preparing")) == 2
        out = _save(kd, kd.pickup_screen, "pickup", scope={"areaIds": [], "machineIds": []})
        assert out["scope"] == {"areaIds": [], "machineIds": []}
        assert set(_numbers(kd, kd.pickup_screen, "preparing")) == every

    def test_only_this_shops_areas_and_machines(self, kd):
        stranger = _till(kd, "קופה בסניף אחר", shop=kd.other_shop)
        e = refused(_save, kd, kd.pickup_screen, "pickup", scope={"machineIds": [str(stranger.id)]})
        assert e.status_code == 422 and e.detail["code"] == "machine_not_in_shop"
        e = refused(_save, kd, kd.pickup_screen, "pickup", scope={"areaIds": [str(uuid.uuid4())]})
        assert e.status_code == 422 and e.detail["code"] == "area_not_in_shop"

    def test_a_station_scoped_to_one_area_does_not_see_another_areas_tickets(self, kd):
        bar, terrace = self._areas(kd)
        mine = release(kd, till=kd.bar_till, ref="bar-1", items=[item("l1:0", kd.steak)])
        other = release(kd, till=kd.terrace_till, ref="terrace-1", items=[item("l1:0", kd.steak)])
        seen = lambda: {o["id"] for o in board(kd, kd.grill_screen)["orders"]}  # noqa: E731
        assert {mine["orderId"], other["orderId"]} <= seen()
        out = _save(kd, kd.grill_screen, "station", scope={"areaIds": [str(bar.id)]})
        assert out["scope"]["areaIds"] == [str(bar.id)]
        assert mine["orderId"] in seen() and other["orderId"] not in seen()
        # Its stations still apply: a drink of the bar's area never reaches the grill.
        drink = release(kd, till=kd.bar_till, ref="bar-2", items=[item("l1:0", kd.cola)])
        assert drink["orderId"] not in seen()

    def test_an_expo_scoped_to_the_kiosks_sees_only_kiosk_orders(self, kd):
        self._areas(kd)
        kiosk_order = _kiosk_order(kd, "kiosk-1", till=kd.kiosk)
        till_order = release(kd, till=kd.bar_till, ref="till-1", items=[item("l1:0", kd.steak)])
        _save(kd, kd.expo_screen, "expo", scope={"machineIds": [str(kd.kiosk.id)]})
        ids = {o["id"] for o in board(kd, kd.expo_screen)["orders"]}
        assert kiosk_order["orderId"] in ids and till_order["orderId"] not in ids
        # The whole shop again.
        _save(kd, kd.expo_screen, "expo", scope={"areaIds": [], "machineIds": []})
        assert till_order["orderId"] in {o["id"] for o in board(kd, kd.expo_screen)["orders"]}

    def test_the_kds_page_lists_the_areas_and_the_kiosks(self, kd):
        bar, _ = self._areas(kd)
        out = R.get_kds_shop(kd.shop.id, **_ctx(kd))
        assert {a["name"] for a in out["areas"]} >= {"בר", "מרפסת"}
        machines = {m["id"]: m for m in out["machines"]}
        assert machines[str(kd.bar_till.id)]["areaId"] == str(bar.id) and machines[str(kd.bar_till.id)]["kiosk"] is False


# ── "הזמנות להכנה" on a till ──────────────────────────────────────────────────


class TestTillReadyList:
    def test_ready_handed_over_and_back_move_the_board_like_the_kds(self, kd):
        a = _kiosk_order(kd, "t1")
        number = str(a["pickupNumber"])
        listed = _ready_list(kd, kd.waiter)
        row = next(o for o in listed["orders"] if o["orderId"] == a["orderId"])
        assert row["groupState"] == "waiting" and row["pickupNumber"] == a["pickupNumber"]
        assert row["items"] == [{"name": "steak", "qty": 1.0, "ready": False}]
        assert listed["hasKds"] is True and listed["hasBoard"] is True

        out = _ready(kd, kd.waiter, "ready", a["orderId"])
        assert out["outcome"] == "applied"
        assert _numbers(kd, kd.pickup_screen) == [number] and _numbers(kd, kd.pickup_screen, "preparing") == []
        assert len(events(kd)) == 1
        # The Expo sees it ready too.
        expo = next(o for o in board(kd, kd.expo_screen)["orders"] if o["id"] == a["orderId"])
        assert expo["groupState"] == "ready_for_pickup"

        assert _ready(kd, kd.waiter, "handover", a["orderId"])["outcome"] == "applied"
        assert _numbers(kd, kd.pickup_screen) == []
        assert next(o for o in _ready_list(kd, kd.waiter)["orders"] if o["orderId"] == a["orderId"])["groupState"] == "handed_over"
        assert _ready(kd, kd.waiter, "undo", a["orderId"])["outcome"] == "applied"
        assert _numbers(kd, kd.pickup_screen) == [number]
        assert _ready(kd, kd.waiter, "undo", a["orderId"])["outcome"] == "applied"
        assert _numbers(kd, kd.pickup_screen, "preparing") == [number]
        # Ready again: the same one event, pending again (no second ReadyForPickup).
        _ready(kd, kd.waiter, "ready", a["orderId"])
        assert len(events(kd)) == 1

    def test_a_retry_is_one_action(self, kd):
        a = _kiosk_order(kd, "t2")
        first = _ready(kd, kd.waiter, "ready", a["orderId"], aid="till-ready-0001")
        again = _ready(kd, kd.waiter, "ready", a["orderId"], aid="till-ready-0001")
        assert first["outcome"] == "applied" and again.get("replayed") is True
        assert _ready(kd, kd.waiter, "ready", a["orderId"])["outcome"] == "noop"

    def test_without_a_kds_the_shop_still_marks_its_orders(self, kd):
        for screen in (kd.grill_screen, kd.bar_screen, kd.expo_screen):
            R.delete_kds_device(kd.shop.id, screen.id, **_ctx(kd))
        a = _kiosk_order(kd, "t3")
        listed = _ready_list(kd, kd.waiter)
        assert listed["hasKds"] is False and listed["hasBoard"] is True
        _ready(kd, kd.waiter, "ready", a["orderId"])
        assert _numbers(kd, kd.pickup_screen) == [str(a["pickupNumber"])]

    def test_never_from_a_display_device_and_never_another_shops_order(self, kd):
        a = _kiosk_order(kd, "t4")
        e = refused(_ready_list, kd, kd.expo_screen)
        assert e.status_code == 403 and e.detail["code"] == "not_a_till"
        stranger = _till(kd, "קופה בסניף אחר", shop=kd.other_shop)
        e = refused(_ready, kd, stranger, "ready", a["orderId"])
        assert e.status_code == 404
        assert all(o["orderId"] != a["orderId"] for o in _ready_list(kd, stranger)["orders"])
