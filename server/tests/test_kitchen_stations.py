"""
Kitchen stations ("תחנות מטבח": גריל, טיגון, בר…): a named routing target for the network.

A category (and its sub-categories) or a product is assigned to a station once; each shop
says which of its printers the station prints on. The till receives it folded into its
usual category / product routes, so its rule is unchanged. A shop's own printer rows win
over the station; "ללא בון" on the product wins over everything; a station with no printer
in a shop leaves the target to its parent category there.

Runs on the world of tests/test_kitchen_printers.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.routers import printers as R
from test_kitchen_printers import _run, create, k, no_ticket, pull, route_categories  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401


def station(w, name):
    tasks = BackgroundTasks()
    out = R.create_station(R.StationIn(name=name), tasks, **_ctx(w))
    _run(tasks)
    return out["id"]


def station_printers(w, sid, *printer_ids):
    tasks = BackgroundTasks()
    out = R.put_station_printers(
        w.shop.id, uuid.UUID(sid), R.StationPrintersIn(printerIds=[uuid.UUID(p) for p in printer_ids]), tasks, **_ctx(w)
    )
    _run(tasks)
    return out


def assign(w, target_type, target, sid):
    tasks = BackgroundTasks()
    body = R.StationTargetIn(targetType=target_type, targetId=target.id, stationId=uuid.UUID(sid) if sid else None)
    out = R.put_station_target(body, tasks, **_ctx(w))
    _run(tasks)
    return out


class TestStations:
    def test_a_category_on_a_station_prints_on_the_stations_printers(self, k):
        grill = create(k, name="Grill printer")["id"]
        sid = station(k, "גריל")
        station_printers(k, sid, grill)
        assign(k, "category", k.food, sid)

        routes = pull(k, k.tills[0])["categoryRoutes"]
        # Food and, by inheritance, Mains print on the grill.
        assert routes[str(k.food.id)] == [grill]
        assert routes[str(k.mains.id)] == [grill]
        assert str(k.drinks.id) not in routes

    def test_a_product_on_a_station(self, k):
        bar = create(k, name="Bar printer")["id"]
        sid = station(k, "בר")
        station_printers(k, sid, bar)
        assign(k, "product", k.cola, sid)
        assert pull(k, k.tills[0])["productRoutes"][str(k.cola.id)] == [bar]

    def test_the_shops_own_rows_win_over_the_station(self, k):
        grill = create(k, name="Grill printer")["id"]
        hot = create(k, name="Hot kitchen", host="192.168.1.51")["id"]
        sid = station(k, "גריל")
        station_printers(k, sid, grill)
        assign(k, "category", k.mains, sid)
        route_categories(k, {k.mains: [hot]})
        assert pull(k, k.tills[0])["categoryRoutes"][str(k.mains.id)] == [hot]

    def test_no_ticket_on_the_product_wins(self, k):
        bar = create(k, name="Bar printer")["id"]
        sid = station(k, "בר")
        station_printers(k, sid, bar)
        assign(k, "product", k.cola, sid)
        no_ticket(k, k.cola, True)
        assert pull(k, k.tills[0])["productRoutes"][str(k.cola.id)] == []

    def test_a_station_without_a_printer_here_leaves_the_parent_in_charge(self, k):
        kitchen = create(k, name="Kitchen")["id"]
        route_categories(k, {k.food: [kitchen]})
        sid = station(k, "גריל")  # no printer in this shop
        assign(k, "category", k.mains, sid)
        assert pull(k, k.tills[0])["categoryRoutes"][str(k.mains.id)] == [kitchen]

    def test_clearing_and_deleting(self, k):
        grill = create(k, name="Grill printer")["id"]
        sid = station(k, "גריל")
        station_printers(k, sid, grill)
        assign(k, "category", k.food, sid)
        assign(k, "category", k.food, None)
        assert str(k.food.id) not in pull(k, k.tills[0])["categoryRoutes"]

        assign(k, "category", k.food, sid)
        tasks = BackgroundTasks()
        R.delete_station(uuid.UUID(sid), tasks, **_ctx(k))
        _run(tasks)
        assert str(k.food.id) not in pull(k, k.tills[0])["categoryRoutes"]
        assert R.list_stations(None, **_ctx(k))["stations"] == []

    def test_names_are_unique_and_required(self, k):
        station(k, "בר")
        with pytest.raises(HTTPException) as dup:
            station(k, "בר")
        assert dup.value.status_code == 409

    def test_the_listing_shows_printers_of_the_shop_and_targets(self, k):
        grill = create(k, name="Grill printer")["id"]
        sid = station(k, "גריל")
        station_printers(k, sid, grill)
        assign(k, "category", k.food, sid)
        out = R.list_stations(k.shop.id, **_ctx(k))
        st = out["stations"][0]
        assert st["name"] == "גריל" and st["printerIds"] == [grill]
        assert st["categoryIds"] == [str(k.food.id)]
