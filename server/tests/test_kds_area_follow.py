"""
"תצוגה לפי נקודת המכירה של המסך" — a KDS / board screen shows the orders of the point of sale its own
device stands in (P:/specs/area-coverage-audit.md, KDS row):

* a new screen of a device in a point of sale follows it by default; the dialog's explicit choice
  (lists, the whole shop, `followArea: false`) always wins;
* a screen with no scope of its own starts following when its device is moved into a point of sale
  (pairing, the areas page, the device page) — an explicit scope is never touched;
* a point of sale with no till / kiosk never empties the screen: the whole shop, warned;
* every screen and the dashboard get the words: "מציג: נקודת מכירה X" / "מציג: כל הסניף", and a
  warning when the shop has points of sale and the screen shows the whole shop.

Runs on the world of tests/test_kds.py (SQLite).
"""
from __future__ import annotations

import uuid

from app.models.kds import KdsDevice
from app.models.shop_area import ShopArea
from app.routers import kds as R
from app.schemas.kds import KdsDeviceIn
from app.services import areas as AREAS
from app.services import display_devices as DD
from app.services import kds as KDS
from test_kds import _till, board, item, kd, release  # noqa: F401
from test_kitchen_printers import k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401


def _areas(kd):
    bar = ShopArea(id=uuid.uuid4(), tenant_id=kd.tenant.id, shop_id=kd.shop.id, name="בר")
    kitchen = ShopArea(id=uuid.uuid4(), tenant_id=kd.tenant.id, shop_id=kd.shop.id, name="מטבח")
    terrace = ShopArea(id=uuid.uuid4(), tenant_id=kd.tenant.id, shop_id=kd.shop.id, name="מרפסת")
    kd.db.add_all([bar, kitchen, terrace])
    kd.db.flush()
    kd.bar_till = _till(kd, "קופת בר")
    kd.bar_till.area_id = bar.id
    kd.terrace_till = _till(kd, "קופת מרפסת")
    kd.terrace_till.area_id = terrace.id
    kd.db.flush()
    return bar, kitchen, terrace


def _new_screen(kd, name, area=None, **body):
    """A machine of the shop made a screen on the KDS page (a new kds_devices row)."""
    m = _till(kd, name)
    m.area_id = area.id if area is not None else None
    kd.db.flush()
    payload = {"role": "expo", "name": name, **body}
    out = R.put_kds_device(kd.shop.id, m.id, KdsDeviceIn.model_validate(payload), **_ctx(kd))
    return m, out


def _orders(kd, screen):
    return {o["id"] for o in board(kd, screen)["orders"]}


class TestNewScreen:
    def test_a_new_screen_in_a_point_of_sale_follows_it_by_default(self, kd):
        bar, _, _ = _areas(kd)
        screen, out = _new_screen(kd, "מסך בר", bar)
        assert out["scopeSetting"]["followArea"] is True
        assert out["scopeSource"] == "area" and out["scope"] == {"areaIds": [str(bar.id)], "machineIds": []}
        assert out["scopeLabel"] == "מציג: נקודת מכירה בר" and out["scopeWarning"] is None
        mine = release(kd, till=kd.bar_till, ref="bar-1", items=[item("l1:0", kd.steak)])
        other = release(kd, till=kd.terrace_till, ref="ter-1", items=[item("l1:0", kd.steak)])
        seen = _orders(kd, screen)
        assert mine["orderId"] in seen and other["orderId"] not in seen
        # The screen itself gets the words (Android, Windows, the browser show them).
        assert board(kd, screen)["device"]["scopeLabel"] == "מציג: נקודת מכירה בר"

    def test_an_older_dashboard_saving_empty_lists_still_follows(self, kd):
        bar, _, _ = _areas(kd)
        _, out = _new_screen(kd, "מסך", bar, scope={"areaIds": [], "machineIds": []})
        assert out["scopeSource"] == "area"

    def test_the_whole_shop_chosen_explicitly_is_kept_and_warned(self, kd):
        bar, _, _ = _areas(kd)
        screen, out = _new_screen(kd, "מסך", bar, scope={"areaIds": [], "machineIds": [], "followArea": False})
        assert out["scopeSetting"]["followArea"] is False
        assert out["scopeSource"] == "shop" and out["scopeLabel"] == "מציג: כל הסניף"
        assert out["scopeWarning"] == "whole_shop_with_areas" and "כל הסניף" in out["scopeWarningText"]
        other = release(kd, till=kd.terrace_till, ref="ter-1", items=[item("l1:0", kd.steak)])
        assert other["orderId"] in _orders(kd, screen)

    def test_explicit_lists_win(self, kd):
        bar, _, terrace = _areas(kd)
        _, out = _new_screen(kd, "מסך", bar, scope={"areaIds": [str(terrace.id)]})
        assert out["scopeSource"] == "own" and out["scope"]["areaIds"] == [str(terrace.id)]
        assert out["scopeLabel"] == "מציג: נקודת מכירה מרפסת"

    def test_a_screen_in_no_point_of_sale_shows_the_whole_shop(self, kd):
        _areas(kd)
        _, out = _new_screen(kd, "מסך")
        assert out["scopeSource"] == "shop" and out["scopeWarning"] == "whole_shop_with_areas"

    def test_a_shop_without_points_of_sale_has_no_warning(self, kd):
        _, out = _new_screen(kd, "מסך")
        assert out["scopeSource"] == "shop" and out["scopeWarning"] is None and out["scopeLabel"] == "מציג: כל הסניף"


class TestEmptyArea:
    def test_a_point_of_sale_with_no_till_never_empties_the_screen(self, kd):
        _, kitchen, _ = _areas(kd)
        screen, out = _new_screen(kd, "מסך מטבח", kitchen)
        assert out["scopeSetting"]["followArea"] is True
        assert out["scopeSource"] == "shop" and out["scopeWarning"] == "area_has_no_sellers"
        order = release(kd, till=kd.bar_till, ref="bar-1", items=[item("l1:0", kd.steak)])
        assert order["orderId"] in _orders(kd, screen)

    def test_a_till_joining_that_point_of_sale_narrows_it(self, kd):
        bar, kitchen, _ = _areas(kd)
        screen, _ = _new_screen(kd, "מסך מטבח", kitchen)
        AREAS.assign_machine_area(kd.db, kd.bar_till, kitchen.id)
        kd.db.flush()
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        eff = KDS.effective_scope(kd.db, dev)
        assert eff["source"] == "area" and eff["areaIds"] == [str(kitchen.id)]


class TestMove:
    def test_moving_a_screen_with_no_scope_into_a_point_of_sale_makes_it_follow(self, kd):
        bar, _, terrace = _areas(kd)
        screen, out = _new_screen(kd, "מסך")
        assert out["scopeSource"] == "shop"
        before = board(kd, screen)["version"]
        AREAS.assign_machine_area(kd.db, screen, bar.id)
        kd.db.flush()
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        assert dev.scope == {"areaIds": [], "machineIds": [], "followArea": True}
        # Every screen reads its scope again.
        assert board(kd, screen)["version"] != before
        assert board(kd, screen)["device"]["scopeLabel"] == "מציג: נקודת מכירה בר"
        # Moved again: it follows.
        AREAS.assign_machine_area(kd.db, screen, terrace.id)
        kd.db.flush()
        assert board(kd, screen)["device"]["scopeLabel"] == "מציג: נקודת מכירה מרפסת"

    def test_an_explicit_scope_is_never_touched_by_a_move(self, kd):
        bar, _, terrace = _areas(kd)
        screen, _ = _new_screen(kd, "מסך", None, scope={"areaIds": [str(terrace.id)]})
        AREAS.assign_machine_area(kd.db, screen, bar.id)
        kd.db.flush()
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        assert dev.scope == {"areaIds": [str(terrace.id)], "machineIds": []}

    def test_said_no_stays_no(self, kd):
        bar, _, _ = _areas(kd)
        screen, _ = _new_screen(kd, "מסך", None, scope={"areaIds": [], "machineIds": [], "followArea": False})
        AREAS.assign_machine_area(kd.db, screen, bar.id)
        kd.db.flush()
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        assert dev.scope.get("followArea") is False
        assert KDS.effective_scope(kd.db, dev)["source"] == "shop"

    def test_the_areas_page_membership_moves_screens_too(self, kd):
        bar, _, _ = _areas(kd)
        screen, _ = _new_screen(kd, "מסך")
        area = kd.db.get(ShopArea, bar.id)
        AREAS.set_membership(kd.db, area, [kd.bar_till.id, screen.id])
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        assert dev.scope.get("followArea") is True

    def test_a_non_screen_move_does_nothing_but_never_fails(self, kd):
        bar, _, terrace = _areas(kd)
        assert AREAS.assign_machine_area(kd.db, kd.bar_till, terrace.id) is True
        assert KDS.follow_area_on_move(kd.db, kd.bar_till) is False


class TestDevicePage:
    def test_the_device_page_shows_the_words(self, kd):
        bar, _, _ = _areas(kd)
        screen, _ = _new_screen(kd, "מסך בר", bar)
        dev = kd.db.query(KdsDevice).filter(KdsDevice.machine_id == screen.id).one()
        out = DD.kds_screen_fields(dev)
        assert out["scopeLabel"] == "מציג: נקודת מכירה בר" and out["scopeWarningText"] is None


class TestPairing:
    def test_a_kds_paired_into_a_point_of_sale_follows_it(self, kd):
        """Pairing puts the area first (apply_area_on_pairing), then the screen row (display_devices)."""
        bar, _, _ = _areas(kd)
        m = _till(kd, "KDS חדש")
        m.area_id = bar.id
        kd.db.flush()
        body = KdsDeviceIn.model_validate({"name": "KDS חדש", "role": "expo", "isActive": True})
        dev = KDS.save_device(kd.db, kd.shop, m.id, body)
        assert dev.scope == {"areaIds": [], "machineIds": [], "followArea": True}
        assert KDS.effective_scope(kd.db, dev)["source"] == "area"
