"""
"הפניית מדפסות לפי אזור שולחנות" — the per-zone printer redirect (app/services/printer_zones.py,
docs/SPEC_PRINT_BY_ZONE.md).

What each class pins:

* **The dashboard** — a zone's redirect is written whole; both printers kitchen printers of
  the zone's shop, never one to itself; a zone of another shop, or archived, is not found;
  the shop's tills are told; only the shop's managers write.
* **The till's pull** — `zoneRedirects` for the zones the till sees, only to active
  kitchen printers; a target out of the till's scope is listed (`inScope: false`), because
  the zone rule wins; the routing itself is untouched; the ETag moves.
* **Lifetime** — deleting a printer takes its redirects.
* **The rule** — each printer to its redirect, deduplicated (the till's, mirrored).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import BackgroundTasks

from app.models.printers import KitchenZoneRedirect
from app.models.shop_area import ShopArea
from app.models.tables import TableZone
from app.routers import printer_zones as RZ
from app.routers import printers as R
from app.schemas.kitchen_printers import PrinterIn
from app.schemas.printer_discovery import ZoneRedirectsIn
from app.services.printer_zones import apply_redirect
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


@pytest.fixture
def z(w):
    """Two areas (hall, garden), a zone per area and a shop-wide one, and a bar in each area."""
    db = w.db
    w.hall = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Hall")
    w.garden = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Garden")
    db.add_all([w.hall, w.garden])
    db.flush()
    w.tills[0].area_id = w.hall.id
    w.tills[1].area_id = w.garden.id

    def zone(name, area=None, shop=None):
        row = TableZone(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, name=name,
            area_id=area.id if area else None,
        )
        db.add(row)
        return row

    w.inside = zone("פנים", w.hall)
    w.yard = zone("גינה", w.garden)
    w.terrace = zone("מרפסת")
    w.far_zone = zone("צפון", shop=w.other_shop)
    db.commit()
    w.main_bar = printer(w, name="בר ראשי", host="192.168.1.10", areaId=str(w.hall.id))
    w.garden_bar = printer(w, name="בר גינה", host="192.168.1.11", areaId=str(w.garden.id))
    w.kitchen = printer(w, name="מטבח", host="192.168.1.12")
    w.receipt = printer(w, name="חשבוניות", host="192.168.1.13", purpose="receipt")
    w.notified.clear()
    return w


def printer(w, shop=None, **over):
    base = {"name": "P", "connectionType": "network", "host": "192.168.1.50"}
    base.update(over)
    tasks = BackgroundTasks()
    return R.create_printer((shop or w.shop).id, PrinterIn.model_validate(base), tasks, **_ctx(w))["id"]


def put(w, zone, redirects, user=None):
    tasks = BackgroundTasks()
    body = ZoneRedirectsIn(redirects={uuid.UUID(a): uuid.UUID(b) for a, b in redirects.items()})
    out = RZ.put_zone_redirects(w.shop.id, zone.id, body, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def get(w, user=None):
    return RZ.get_zone_redirects(w.shop.id, **_ctx(w, user))


def pull(w, till, etag=None):
    return R.get_own_printers(str(till.id), etag=etag, machine=till, db=w.db)


# ── The dashboard ─────────────────────────────────────────────────────────────


class TestDashboard:
    def test_a_zones_redirect_is_written_whole(self, z):
        out = put(z, z.yard, {z.main_bar: z.garden_bar, z.kitchen: z.garden_bar})
        yard = next(row for row in out["zones"] if row["id"] == str(z.yard.id))
        assert yard["areaName"] == "Garden"
        assert {(r["fromPrinterId"], r["toPrinterId"]) for r in yard["redirects"]} == {
            (z.main_bar, z.garden_bar), (z.kitchen, z.garden_bar),
        }
        out = put(z, z.yard, {z.kitchen: z.main_bar})
        yard = next(row for row in out["zones"] if row["id"] == str(z.yard.id))
        assert yard["redirects"] == [{"fromPrinterId": z.kitchen, "toPrinterId": z.main_bar}]
        put(z, z.yard, {})
        assert z.db.query(KitchenZoneRedirect).count() == 0

    def test_the_section_lists_the_live_zones_and_the_kitchen_printers(self, z):
        z.terrace.archived_at = datetime.now(timezone.utc)
        z.db.commit()
        out = get(z)
        assert [row["name"] for row in out["zones"]] == ["גינה", "פנים"]
        assert {p["name"] for p in out["printers"]} == {"בר ראשי", "בר גינה", "מטבח"}  # no receipt printer

    def test_refusals_change_nothing(self, z):
        put(z, z.yard, {z.main_bar: z.garden_bar})
        foreign = printer(z, shop=z.other_shop, name="צפון", host="192.168.2.10")
        for redirects, detail in (
            ({z.main_bar: z.main_bar}, "redirect_to_itself"),
            ({z.main_bar: foreign}, "printer_not_in_shop"),
            ({foreign: z.main_bar}, "printer_not_in_shop"),
            ({z.main_bar: z.receipt}, "printer_not_kitchen"),
        ):
            e = refused(put, z, z.yard, redirects)
            assert (e.status_code, e.detail) == (422, detail)
        assert z.db.query(KitchenZoneRedirect).one().to_printer_id == uuid.UUID(z.garden_bar)

    def test_a_zone_of_another_shop_or_archived_is_not_found(self, z):
        assert refused(put, z, z.far_zone, {}).detail == "zone_not_found"
        z.terrace.archived_at = datetime.now(timezone.utc)
        z.db.commit()
        assert refused(put, z, z.terrace, {}).detail == "zone_not_found"

    def test_the_shops_tills_are_told(self, z):
        put(z, z.yard, {z.main_bar: z.garden_bar})
        assert {m for m, reason in z.notified if reason == "printers_updated"} == {str(t.id) for t in z.tills}

    def test_only_the_shops_managers(self, z):
        assert refused(put, z, z.yard, {}, z.cashier).status_code == 403
        assert refused(get, z, z.cashier).status_code == 403
        assert refused(put, z, z.yard, {}, z.north_manager).status_code == 403
        put(z, z.yard, {z.main_bar: z.garden_bar}, z.manager)
        assert get(z, z.company_manager)["zones"]


# ── The till's pull ───────────────────────────────────────────────────────────


class TestPull:
    def test_a_target_out_of_scope_is_listed_because_the_zone_wins(self, z):
        # The hall's handheld serves the terrace (a shop-wide zone): its drinks go to the garden bar.
        put(z, z.terrace, {z.main_bar: z.garden_bar})
        out = pull(z, z.tills[0])
        assert out["zoneRedirects"] == {str(z.terrace.id): {z.main_bar: z.garden_bar}}
        listed = {p["id"]: p for p in out["printers"]}
        assert listed[z.main_bar]["inScope"] is True
        assert listed[z.garden_bar]["inScope"] is False
        assert listed[z.garden_bar]["host"] == "192.168.1.11"

    def test_only_the_zones_the_till_sees(self, z):
        put(z, z.yard, {z.main_bar: z.garden_bar})
        put(z, z.inside, {z.kitchen: z.main_bar})
        hall = pull(z, z.tills[0])
        assert set(hall["zoneRedirects"]) == {str(z.inside.id)}
        assert z.garden_bar not in {p["id"] for p in hall["printers"]}
        garden = pull(z, z.tills[1])
        assert garden["zoneRedirects"] == {str(z.yard.id): {z.main_bar: z.garden_bar}}

    def test_an_inactive_target_is_left_out(self, z):
        put(z, z.terrace, {z.main_bar: z.garden_bar})
        tasks = BackgroundTasks()
        R.update_printer(
            uuid.UUID(z.garden_bar),
            PrinterIn.model_validate({
                "name": "בר גינה", "connectionType": "network", "host": "192.168.1.11",
                "areaId": str(z.garden.id), "isActive": False,
            }),
            tasks, **_ctx(z),
        )
        out = pull(z, z.tills[0])
        assert out["zoneRedirects"] == {}
        assert z.garden_bar not in {p["id"] for p in out["printers"]}

    def test_the_routing_itself_is_untouched_and_the_etag_moves(self, z):
        before = pull(z, z.tills[0])
        put(z, z.terrace, {z.main_bar: z.garden_bar})
        after = pull(z, z.tills[0], etag=before["etag"])
        assert after["syncType"] == "full"
        assert (after["categoryRoutes"], after["productRoutes"]) == (before["categoryRoutes"], before["productRoutes"])
        assert pull(z, z.tills[0], etag=after["etag"])["syncType"] == "unchanged"

    def test_a_till_with_no_redirects_gets_an_empty_map(self, z):
        assert pull(z, z.tills[0])["zoneRedirects"] == {}


# ── Lifetime ──────────────────────────────────────────────────────────────────


class TestLifetime:
    def test_deleting_a_printer_takes_its_redirects(self, z):
        put(z, z.yard, {z.main_bar: z.garden_bar, z.kitchen: z.main_bar})
        tasks = BackgroundTasks()
        R.delete_printer(uuid.UUID(z.garden_bar), tasks, **_ctx(z))
        rows = z.db.query(KitchenZoneRedirect).all()
        assert [(str(r.from_printer_id), str(r.to_printer_id)) for r in rows] == [(z.kitchen, z.main_bar)]


# ── The rule ──────────────────────────────────────────────────────────────────


class TestRule:
    def test_each_printer_to_its_redirect_deduplicated(self):
        assert apply_redirect(["bar", "kitchen"], {"bar": "garden"}) == ["garden", "kitchen"]
        assert apply_redirect(["bar", "garden"], {"bar": "garden"}) == ["garden"]
        assert apply_redirect(["bar"], None) == ["bar"]
        assert apply_redirect([], {"bar": "garden"}) == []
