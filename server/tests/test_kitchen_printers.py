"""
Kitchen / bar ticket printers ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4).

What each class pins:

* **Resolution** — a category inherits its parent's printers unless it has its own (or an
  explicit "none"); a product's own list replaces its category's; a line may print on
  several printers.
* **Printers** — each connection type keeps what it needs and drops the rest; every
  reference (area, till, host till, routed printer) must be the shop's own.
* **The till's pull** — what reaches which till: narrowed printers, inactive ones left
  out, routes narrowed to the till's printers, a local copy of a routed product, the
  options from the till parameters, a host's own cloud printer, the ETag answer.
* **The relay** — create (idempotent) → handed to the host → leased → acknowledged;
  expiry after 30 minutes; only the host acknowledges, only the sender reads statuses.
* **Test prints** — to the host of a cloud printer, to every till of a local one.
* **Scope** — only the shop's managers read or write.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.category import Category
from app.models.printers import KitchenPrintJob
from app.models.product import Product
from app.models.shop_area import ShopArea
from app.routers import printers as R
from app.schemas.kitchen_printers import (
    CategoryRoutesIn,
    KitchenOptionsIn,
    KitchenPrintersPatch,
    PrinterIn,
    PrintJobAckIn,
    PrintJobIn,
    PrintHostReportIn,
    ProductNoTicketIn,
    ProductRouteIn,
)
from app.services import ably_notify
from app.services import printers as K
from test_shop_areas import _ctx, refused, w  # noqa: F401


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


@pytest.fixture
def k(w, monkeypatch):
    """The world, with a menu (Food › Mains, Drinks) and a print-job notify recorder."""
    w.jobs_notified = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant_id, machine_id, event, body: w.jobs_notified.append((machine_id, event)),
    )
    food = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Food")
    drinks = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Drinks")
    w.db.add_all([food, drinks])
    w.db.flush()
    mains = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Mains", parent_id=food.id)
    w.db.add(mains)
    w.db.flush()

    def product(name, category):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=category.id,
            name=name, price=Decimal("10.00"), sku=f"sku-{name}",
        )
        w.db.add(p)
        return p

    w.steak = product("steak", mains)
    w.cola = product("cola", drinks)
    w.salad = product("salad", food)
    w.food, w.drinks, w.mains = food, drinks, mains
    w.db.commit()
    return w


def printer_in(**over):
    base = {"name": "Kitchen", "connectionType": "network", "host": "192.168.1.50"}
    base.update(over)
    return PrinterIn.model_validate(base)


def create(w, user=None, shop=None, **over):
    tasks = BackgroundTasks()
    out = R.create_printer((shop or w.shop).id, printer_in(**over), tasks, **_ctx(w, user))
    _run(tasks)
    return out


def pull(w, till, etag=None):
    return R.get_own_printers(str(till.id), etag=etag, machine=till, db=w.db)


def route_categories(w, routes, user=None):
    tasks = BackgroundTasks()
    body = CategoryRoutesIn(routes={c.id: [uuid.UUID(p) for p in ps] for c, ps in routes.items()})
    out = R.put_category_routes(w.shop.id, body, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def route_product(w, product, mode, printers=(), user=None):
    tasks = BackgroundTasks()
    body = ProductRouteIn(mode=mode, printerIds=[uuid.UUID(p) for p in printers])
    return R.put_product_route(w.shop.id, product.id, body, tasks, **_ctx(w, user))


def ticket(**over):
    base = {
        "source": "table", "tableName": "12", "createdAt": "2026-10-04T12:00:00+03:00",
        "lines": [{"productId": "p", "name": "סטייק", "quantity": 2, "notes": "בלי בצל"}],
    }
    base.update(over)
    return base


def send_job(w, sender, printer_id, job_id=None):
    tasks = BackgroundTasks()
    body = PrintJobIn.model_validate({"id": str(job_id or uuid.uuid4()), "printerId": printer_id, "ticket": ticket()})
    out = R.post_print_job(str(sender.id), body, tasks, machine=sender, db=w.db)
    _run(tasks)
    return out


def pending(w, till):
    return R.get_pending_print_jobs(str(till.id), machine=till, db=w.db)["jobs"]


def ack(w, till, job_id, status="done", error=None):
    return R.ack_print_job(str(till.id), job_id, PrintJobAckIn(status=status, error=error), machine=till, db=w.db)


def statuses(w, till, *ids):
    return {j["id"]: j for j in R.get_print_job_statuses(str(till.id), ids=",".join(ids), machine=till, db=w.db)["jobs"]}


# ── Resolution ────────────────────────────────────────────────────────────────


class TestResolution:
    def test_a_category_inherits_from_its_nearest_routed_ancestor(self):
        parents = {"food": None, "mains": "food", "steaks": "mains", "drinks": None}
        own = {"food": ["kitchen"], "drinks": ["bar"]}
        out = K.resolve_category_routes(parents, own)
        assert out == {"food": ["kitchen"], "mains": ["kitchen"], "steaks": ["kitchen"], "drinks": ["bar"]}

    def test_own_rows_and_an_explicit_none_stop_the_inheritance(self):
        parents = {"food": None, "mains": "food", "desserts": "food"}
        own = {"food": ["kitchen"], "mains": ["kitchen", "grill"], "desserts": []}
        out = K.resolve_category_routes(parents, own)
        assert out["mains"] == ["kitchen", "grill"]
        assert "desserts" not in out

    def test_a_cycle_does_not_hang(self):
        assert K.resolve_category_routes({"a": "b", "b": "a"}, {}) == {}

    def test_a_product_list_replaces_its_category_and_may_be_several_or_none(self):
        categories = {"mains": ["kitchen"]}
        products = {"steak": ["kitchen", "grill"], "bread": []}
        assert K.printers_for_line("steak", "mains", products, categories) == ["kitchen", "grill"]
        assert K.printers_for_line("bread", "mains", products, categories) == []
        assert K.printers_for_line("soup", "mains", products, categories) == ["kitchen"]
        assert K.printers_for_line("soup", None, products, categories) == []


# ── Printers ──────────────────────────────────────────────────────────────────


class TestPrinters:
    def test_a_network_printer_gets_port_9100_and_drops_other_fields(self):
        p = printer_in(port=None, btAddress="aa-bb-cc-dd-ee-ff", hostMachineId=str(uuid.uuid4()))
        assert (p.port, p.bt_address, p.host_machine_id) == (9100, None, None)

    def test_each_type_requires_what_it_needs(self):
        with pytest.raises(ValidationError):
            printer_in(host=None)
        with pytest.raises(ValidationError):
            printer_in(connectionType="cloud")
        with pytest.raises(ValidationError):
            printer_in(connectionType="bluetooth", btAddress="nope")
        with pytest.raises(ValidationError):
            printer_in(port=70000)
        with pytest.raises(ValidationError):
            printer_in(paperWidth=72)
        bt = printer_in(connectionType="bluetooth", btAddress="aa-bb-cc-dd-ee-0f", btName=" Bar BT ")
        assert (bt.bt_address, bt.bt_name, bt.host) == ("AA:BB:CC:DD:EE:0F", "Bar BT", None)
        # A Bluetooth printer may leave the MAC to the till.
        assert printer_in(connectionType="bluetooth", host=None).bt_address is None
        cloud = printer_in(connectionType="cloud", hostMachineId=str(uuid.uuid4()), host=None)
        assert cloud.host_connection == "till" and cloud.host is None

    def test_create_list_update_delete(self, k):
        out = create(k, name="Kitchen", copies=2, cutPaper=False, beep=True, paperWidth=58)
        assert out["connectionType"] == "network" and out["port"] == 9100
        assert (out["copies"], out["cutPaper"], out["beep"], out["paperWidth"]) == (2, False, True, 58)
        # Every till of the shop is told to pull again.
        assert {m for m, reason in k.notified if reason == K.NOTIFY_REASON} == {str(t.id) for t in k.tills}

        page = R.list_printers(k.shop.id, **_ctx(k))
        assert [p["name"] for p in page["printers"]] == ["Kitchen"]
        assert page["canEdit"] is True
        assert {m["id"] for m in page["machines"]} == {str(t.id) for t in k.tills}

        tasks = BackgroundTasks()
        updated = R.update_printer(
            uuid.UUID(out["id"]),
            printer_in(name="Bar", connectionType="cloud", hostMachineId=str(k.tills[1].id), host=None),
            tasks, **_ctx(k),
        )
        assert updated["connectionType"] == "cloud" and updated["hostMachineName"].endswith("Till 2")
        assert updated["host"] is None and updated["port"] is None

        R.delete_printer(uuid.UUID(out["id"]), BackgroundTasks(), **_ctx(k))
        assert R.list_printers(k.shop.id, **_ctx(k))["printers"] == []

    def test_references_must_be_the_shops_own(self, k):
        assert refused(create, k, machineId=str(k.other_till.id)).detail == "machine_not_in_shop"
        assert refused(
            create, k, connectionType="cloud", hostMachineId=str(k.other_till.id), host=None
        ).detail == "host_machine_not_in_shop"
        north_area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.other_shop.id, name="N")
        k.db.add(north_area)
        k.db.commit()
        assert refused(create, k, areaId=str(north_area.id)).detail == "area_not_in_shop"
        north_printer = create(k, shop=k.other_shop, name="North")
        assert refused(route_categories, k, {k.food: [north_printer["id"]]}).detail == "printer_not_in_shop"

    def test_deleting_a_printer_drops_its_routes(self, k):
        kitchen = create(k, name="Kitchen")
        route_product(k, k.steak, "printers", [kitchen["id"]])
        R.delete_printer(uuid.UUID(kitchen["id"]), BackgroundTasks(), **_ctx(k))
        assert R.get_routing(k.shop.id, **_ctx(k))["products"] == []


# ── The till's pull ───────────────────────────────────────────────────────────


class TestTheTillsPull:
    def test_multi_printer_category_routes_inheritance_and_product_override(self, k):
        kitchen = create(k, name="Kitchen")
        bar = create(k, name="Bar", host="10.0.0.9")
        route_categories(k, {k.food: [kitchen["id"]], k.drinks: [bar["id"], kitchen["id"]]})
        route_product(k, k.steak, "printers", [kitchen["id"], bar["id"]])
        route_product(k, k.salad, "none")

        out = pull(k, k.tills[0])
        assert out["syncType"] == "full"
        assert {p["name"] for p in out["printers"]} == {"Kitchen", "Bar"}
        cats = out["categoryRoutes"]
        assert cats[str(k.food.id)] == [kitchen["id"]]
        assert cats[str(k.mains.id)] == [kitchen["id"]]  # inherited
        assert set(cats[str(k.drinks.id)]) == {bar["id"], kitchen["id"]}
        prods = out["productRoutes"]
        assert set(prods[str(k.steak.id)]) == {kitchen["id"], bar["id"]}
        assert prods[str(k.salad.id)] == []  # explicit "no ticket"
        assert str(k.cola.id) not in prods  # follows its category

        line = lambda p: K.printers_for_line(str(p.id), str(p.category_id), prods, cats)  # noqa: E731
        assert set(line(k.steak)) == {kitchen["id"], bar["id"]}
        assert set(line(k.cola)) == {kitchen["id"], bar["id"]}
        assert line(k.salad) == []

        # The routing page reads back the same.
        routing = R.get_routing(k.shop.id, **_ctx(k))
        assert routing["effectiveCategoryRoutes"][str(k.mains.id)] == [kitchen["id"]]
        assert str(k.mains.id) not in routing["categoryRoutes"]
        modes = {row["productId"]: row["mode"] for row in routing["products"]}
        assert modes == {str(k.steak.id): "printers", str(k.salad.id): "none"}

        # Back to the category.
        route_product(k, k.steak, "inherit")
        assert str(k.steak.id) not in pull(k, k.tills[0])["productRoutes"]

    def test_narrowed_and_inactive_printers_reach_only_their_tills(self, k):
        t1, t2 = k.tills
        bar_area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name="Bar")
        k.db.add(bar_area)
        k.db.flush()
        t2.area_id = bar_area.id
        k.db.commit()
        shopwide = create(k, name="Kitchen")
        in_bar = create(k, name="Bar", areaId=str(bar_area.id))
        only_t1 = create(k, name="T1", machineId=str(t1.id))
        create(k, name="Off", isActive=False)
        route_categories(k, {k.drinks: [in_bar["id"], shopwide["id"], only_t1["id"]]})

        one = pull(k, t1)
        two = pull(k, t2)
        assert {p["name"] for p in one["printers"]} == {"Kitchen", "T1"}
        assert {p["name"] for p in two["printers"]} == {"Kitchen", "Bar"}
        assert set(one["categoryRoutes"][str(k.drinks.id)]) == {shopwide["id"], only_t1["id"]}
        assert set(two["categoryRoutes"][str(k.drinks.id)]) == {shopwide["id"], in_bar["id"]}
        assert pull(k, k.other_till)["printers"] == []

    def test_each_printer_says_where_it_is_set_so_a_tills_own_receipt_printer_wins(self, k):
        """The Royal kiosk (07.10.2026): the shop's receipt printer and the kiosk's own USB one both
        reach it; `scope` lets the till prefer the one set to it (receiptPrinterRank)."""
        t1, t2 = k.tills
        bar_area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name="Bar")
        k.db.add(bar_area)
        k.db.flush()
        t1.area_id = bar_area.id
        k.db.commit()
        create(k, name="מדפסת חשבוניות", purpose="receipt", host="192.168.0.223")
        create(k, name="Bar receipts", purpose="receipt", host="192.168.0.224", areaId=str(bar_area.id))
        create(k, name="T1 USB", purpose="receipt", connectionType="usb", host=None, machineId=str(t1.id))
        scopes = {p["name"]: p["scope"] for p in pull(k, t1)["printers"]}
        assert scopes == {"מדפסת חשבוניות": "shop", "Bar receipts": "area", "T1 USB": "machine"}
        assert {p["name"]: p["scope"] for p in pull(k, t2)["printers"]} == {"מדפסת חשבוניות": "shop"}

    def test_a_machine_local_copy_of_a_routed_product_routes_too(self, k):
        kitchen = create(k, name="Kitchen")
        route_product(k, k.steak, "printers", [kitchen["id"]])
        local = Product(
            id=uuid.uuid4(), tenant_id=k.tenant.id, company_id=k.company.id, category_id=k.mains.id,
            name="steak", price=Decimal("12.00"), sku="sku-steak-l", pos_machine_id=k.tills[0].id,
            global_product_id=k.steak.id,
        )
        k.db.add(local)
        k.db.commit()
        assert pull(k, k.tills[0])["productRoutes"][str(local.id)] == [kitchen["id"]]

    def test_the_host_sees_its_cloud_printer_and_its_scope(self, k):
        t1, t2 = k.tills
        cloud = create(
            k, name="Bar (relay)", connectionType="cloud", hostMachineId=str(t2.id), host=None,
            machineId=str(t1.id),
        )
        one, two = pull(k, t1), pull(k, t2)
        assert one["printers"][0]["isHost"] is False and one["printers"][0]["inScope"] is True
        assert two["printers"][0]["isHost"] is True and two["printers"][0]["inScope"] is False
        assert (one["hostsRelay"], two["hostsRelay"]) == (False, True)
        assert two["printers"][0]["id"] == cloud["id"]

    def test_options_come_from_the_till_parameters_by_level(self, k):
        t1, t2 = k.tills
        assert pull(k, t1)["options"] == {"kitchenTicketsOnSale": False, "kitchenTicketsOnTill": False}

        def put(scope_type, scope_id, **values):
            body = KitchenOptionsIn.model_validate({"scopeType": scope_type, "scopeId": str(scope_id), **values})
            tasks = BackgroundTasks()
            out = R.put_options(k.shop.id, body, tasks, **_ctx(k))
            _run(tasks)
            return out

        out = put("shop", k.shop.id, kitchenTicketsOnSale=True)
        assert out["shop"] == {"kitchenTicketsOnSale": True}
        put("machine", t2.id, kitchenTicketsOnSale=False, kitchenTicketsOnTill=True)
        assert pull(k, t1)["options"] == {"kitchenTicketsOnSale": True, "kitchenTicketsOnTill": False}
        assert pull(k, t2)["options"] == {"kitchenTicketsOnSale": False, "kitchenTicketsOnTill": True}
        # An explicit null removes the till's value; the omitted key stays.
        out = put("machine", t2.id, kitchenTicketsOnSale=None)
        assert out["machines"][str(t2.id)] == {"kitchenTicketsOnTill": True}
        assert pull(k, t2)["options"]["kitchenTicketsOnSale"] is True
        assert refused(put, "machine", k.other_till.id, kitchenTicketsOnSale=True).detail == "scope_not_in_shop"

    def test_the_printing_settings_by_shop_point_of_sale_and_till(self, k):
        from app.services.till_parameters import PRINTERS_PAGE_KEYS, managed_on, till_parameters_for_machine

        t1, t2 = k.tills
        area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name="Bar")
        k.db.add(area)
        t2.area_id = area.id
        k.db.commit()

        def put(scope_type, scope_id, values):
            body = KitchenOptionsIn.model_validate(
                {"scopeType": scope_type, "scopeId": str(scope_id), "values": values}
            )
            tasks = BackgroundTasks()
            out = R.put_options(k.shop.id, body, tasks, **_ctx(k))
            _run(tasks)
            return out

        page = R.list_printers(k.shop.id, **_ctx(k))["options"]
        assert [p["key"] for p in page["parameters"]] == list(K.SETTING_KEYS)
        # "אוטומטי" (docs/SPEC_KIOSK.md §14.7): a USB printer plugged in, else the till's own.
        assert page["inherited"]["receiptPrinter"] == "אוטומטי"
        assert set(K.SETTING_KEYS) < set(PRINTERS_PAGE_KEYS)
        assert managed_on("cashDrawer") == "printers" and managed_on("fastCash") is None

        put("shop", k.shop.id, {"askBeforePrint": True, "cashDrawer": "בתשלום מזומן"})
        put("area", area.id, {"receiptPrinter": "רשת (IP)", "receiptPrinterAddress": "192.168.1.60"})
        out = put("machine", t2.id, {"askBeforePrint": False})
        assert out["shop"] == {"askBeforePrint": True, "cashDrawer": "בתשלום מזומן"}
        assert out["areas"][str(area.id)] == {"receiptPrinter": "רשת (IP)", "receiptPrinterAddress": "192.168.1.60"}
        assert out["machines"][str(t2.id)] == {"askBeforePrint": False}

        one = till_parameters_for_machine(k.db, t1).parameters
        two = till_parameters_for_machine(k.db, t2).parameters
        assert (one["askBeforePrint"], two["askBeforePrint"]) == (True, False)
        assert two["receiptPrinter"] == "רשת (IP)" and one.get("receiptPrinter") != "רשת (IP)"
        assert two["cashDrawer"] == "בתשלום מזומן"

        # null removes the level's value; the till inherits the area's again.
        out = put("area", area.id, {"receiptPrinterAddress": None})
        assert out["areas"][str(area.id)] == {"receiptPrinter": "רשת (IP)"}
        assert refused(put, "shop", k.shop.id, {"fastCash": False}).detail == "unknown_setting:fastCash"
        assert refused(put, "shop", k.shop.id, {"cashDrawer": "תמיד"}).detail.startswith("invalid_value:cashDrawer")
        assert refused(put, "shop", k.shop.id, {"askBeforePrint": "yes"}).detail.startswith("invalid_value:")

    def test_the_etag_answers_unchanged_until_something_changes(self, k):
        create(k, name="Kitchen")
        first = pull(k, k.tills[0])
        assert pull(k, k.tills[0], etag=first["etag"])["syncType"] == "unchanged"
        route_categories(k, {k.food: [first["printers"][0]["id"]]})
        assert pull(k, k.tills[0], etag=first["etag"])["syncType"] == "full"


# ── The relay ─────────────────────────────────────────────────────────────────


class TestRelay:
    @pytest.fixture
    def relay(self, k):
        t1, t2 = k.tills
        k.cloud = create(k, name="Bar", connectionType="cloud", hostMachineId=str(t2.id),
                         hostConnection="network", host="10.0.0.5")
        return k

    def test_the_lifecycle(self, relay):
        k = relay
        t1, t2 = k.tills
        job_id = str(uuid.uuid4())
        out = send_job(k, t1, k.cloud["id"], job_id)
        assert out["status"] == "pending" and out["targetMachineId"] == str(t2.id)
        assert (str(t2.id), K.PRINT_JOB_EVENT) in k.jobs_notified
        # A retried upload is the same job, and wakes nobody again.
        k.jobs_notified.clear()
        assert send_job(k, t1, k.cloud["id"], job_id)["id"] == job_id
        assert k.jobs_notified == []
        assert k.db.query(KitchenPrintJob).count() == 1

        # Nobody but the host is handed it.
        assert pending(k, t1) == []
        handed = pending(k, t2)
        assert [j["id"] for j in handed] == [job_id]
        job = handed[0]
        assert job["ticket"]["lines"][0]["notes"] == "בלי בצל"
        assert job["ticket"]["sourceName"].endswith("Till 1")
        assert job["printer"]["connection"] == "network" and job["printer"]["host"] == "10.0.0.5"
        assert statuses(k, t1, job_id)[job_id]["status"] == "printing"
        # Leased: not handed out again at once…
        assert pending(k, t2) == []
        # …but again once the lease is over without an ack.
        row = k.db.get(KitchenPrintJob, uuid.UUID(job_id))
        row.delivered_at = datetime.now(timezone.utc) - K.JOB_LEASE - timedelta(seconds=1)
        k.db.commit()
        assert [j["id"] for j in pending(k, t2)] == [job_id]
        assert k.db.get(KitchenPrintJob, uuid.UUID(job_id)).deliveries == 2

        # Only the host acknowledges.
        assert refused(ack, k, t1, job_id).status_code == 404
        assert ack(k, t2, job_id)["status"] == "done"
        assert statuses(k, t1, job_id)[job_id]["status"] == "done"
        # A repeated or contrary ack keeps the first answer.
        assert ack(k, t2, job_id, "failed", "late")["status"] == "done"
        assert pending(k, t2) == []

    def test_a_failure_reaches_the_sender_with_its_reason(self, relay):
        k = relay
        t1, t2 = k.tills
        job_id = send_job(k, t1, k.cloud["id"])["id"]
        pending(k, t2)
        ack(k, t2, job_id, "failed", "printer offline")
        status = statuses(k, t1, job_id)[job_id]
        assert (status["status"], status["error"]) == ("failed", "printer offline")
        # Statuses are the sender's own.
        assert statuses(k, t2, job_id) == {}

    def test_a_job_nobody_printed_expires(self, relay):
        k = relay
        t1, t2 = k.tills
        job_id = send_job(k, t1, k.cloud["id"])["id"]
        row = k.db.get(KitchenPrintJob, uuid.UUID(job_id))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        k.db.commit()
        assert pending(k, t2) == []
        assert statuses(k, t1, job_id)[job_id]["status"] == "expired"
        # A late print still counts.
        assert ack(k, t2, job_id)["status"] == "done"

    def test_only_a_cloud_printer_of_the_senders_shop_relays(self, relay):
        k = relay
        t1 = k.tills[0]
        local = create(k, name="Kitchen")
        assert refused(send_job, k, t1, local["id"]).detail == "printer_not_relayed"
        assert refused(send_job, k, k.other_till, k.cloud["id"]).status_code == 404
        job_id = send_job(k, t1, k.cloud["id"])["id"]
        assert refused(send_job, k, k.tills[1], k.cloud["id"], job_id).detail == "print_job_id_taken"


class TestTestPrints:
    def test_a_cloud_printer_tests_on_its_host_a_local_one_on_every_till(self, k):
        t1, t2 = k.tills
        cloud = create(k, name="Relay", connectionType="cloud", hostMachineId=str(t2.id), host=None)
        local = create(k, name="Kitchen")

        def test(printer):
            tasks = BackgroundTasks()
            out = R.test_printer(uuid.UUID(printer["id"]), tasks, **_ctx(k))
            _run(tasks)
            return out["jobs"]

        jobs = test(cloud)
        assert [j["targetMachineId"] for j in jobs] == [str(t2.id)]
        assert (str(t2.id), K.PRINT_JOB_EVENT) in k.jobs_notified
        handed = pending(k, t2)
        assert handed[0]["kind"] == "test" and handed[0]["ticket"]["source"] == "test"
        ack(k, t2, handed[0]["id"])

        jobs = test(local)
        assert {j["targetMachineId"] for j in jobs} == {str(t1.id), str(t2.id)}
        listed = R.list_test_jobs(uuid.UUID(local["id"]), **_ctx(k))["jobs"]
        assert {j["status"] for j in listed} == {"pending"}
        assert R.list_test_jobs(uuid.UUID(cloud["id"]), **_ctx(k))["jobs"][0]["status"] == "done"

    def test_a_printer_no_till_uses_cannot_be_tested(self, k):
        off = create(k, name="Off", isActive=False)
        e = refused(R.test_printer, uuid.UUID(off["id"]), BackgroundTasks(), **_ctx(k))
        assert e.detail == "printer_has_no_till"


# ── Scope ─────────────────────────────────────────────────────────────────────


class TestScope:
    def test_the_shops_managers_edit_others_are_refused(self, k):
        assert create(k, user=k.manager, name="By manager")["name"] == "By manager"
        assert create(k, user=k.company_manager, name="By company")["name"] == "By company"
        assert refused(create, k, user=k.cashier).status_code == 403
        assert refused(create, k, user=k.north_manager).status_code == 403
        assert refused(R.list_printers, k.shop.id, **_ctx(k, k.cashier)).status_code == 403
        assert refused(R.get_routing, k.shop.id, **_ctx(k, k.north_manager)).status_code == 403
        printer = create(k, name="Kitchen")
        assert refused(
            R.update_printer, uuid.UUID(printer["id"]), printer_in(), BackgroundTasks(), **_ctx(k, k.north_manager)
        ).status_code == 403
        assert refused(route_product, k, k.steak, "none", user=k.cashier).status_code == 403

    def test_another_tenants_shop_is_forbidden(self, k):
        assert refused(R.list_printers, k.foreign_shop.id, **_ctx(k)).detail == "tenant_forbidden"
        assert refused(create, k, shop=k.foreign_shop).detail == "tenant_forbidden"


# ── The routing model (whole categories; the product's current category) ──────


def _line(w, till, product):
    """Where a line of `product` prints from `till`, as the till resolves it now."""
    out = pull(w, till)
    w.db.refresh(product)
    return set(K.printers_for_line(str(product.id), str(product.category_id), out["productRoutes"], out["categoryRoutes"]))


class TestRoutingModel:
    @pytest.fixture
    def routed(self, k):
        k.kitchen = create(k, name="Kitchen")["id"]
        k.bar = create(k, name="Bar", host="10.0.0.9")["id"]
        route_categories(k, {k.food: [k.kitchen], k.drinks: [k.bar, k.kitchen]})
        return k

    def test_a_product_added_to_a_routed_category_later_prints_there(self, routed):
        k = routed
        late = Product(
            id=uuid.uuid4(), tenant_id=k.tenant.id, company_id=k.company.id, category_id=k.drinks.id,
            name="lemonade", price=Decimal("9.00"), sku="sku-lemonade",
        )
        k.db.add(late)
        k.db.commit()
        assert _line(k, k.tills[0], late) == {k.bar, k.kitchen}
        # Nothing was copied onto the product.
        assert str(late.id) not in pull(k, k.tills[0])["productRoutes"]

    def test_a_product_moved_to_another_category_follows_it(self, routed):
        k = routed
        assert _line(k, k.tills[0], k.salad) == {k.kitchen}
        k.salad.category_id = k.drinks.id
        k.db.commit()
        assert _line(k, k.tills[0], k.salad) == {k.bar, k.kitchen}

    def test_a_sub_category_inherits_until_it_sets_its_own(self, routed):
        k = routed
        deep = Category(id=uuid.uuid4(), tenant_id=k.tenant.id, name="Steaks", parent_id=k.mains.id)
        k.db.add(deep)
        k.db.flush()
        k.steak.category_id = deep.id
        k.db.commit()
        assert _line(k, k.tills[0], k.steak) == {k.kitchen}  # Food > Mains > Steaks
        tasks = BackgroundTasks()
        R.put_category_route(
            k.shop.id, k.mains.id, KitchenPrintersPatch(mode="printers", printerIds=[k.bar]), tasks, **_ctx(k),
        )
        assert _line(k, k.tills[0], k.steak) == {k.bar}
        R.put_category_route(k.shop.id, k.mains.id, KitchenPrintersPatch(mode="inherit"), tasks, **_ctx(k))
        assert _line(k, k.tills[0], k.steak) == {k.kitchen}

    def test_a_product_override_wins_and_clearing_it_returns_to_the_category(self, routed):
        k = routed
        route_product(k, k.cola, "printers", [k.kitchen])
        assert _line(k, k.tills[0], k.cola) == {k.kitchen}
        route_product(k, k.cola, "none")
        assert _line(k, k.tills[0], k.cola) == set()
        route_product(k, k.cola, "inherit")
        assert _line(k, k.tills[0], k.cola) == {k.bar, k.kitchen}

    def test_the_form_shows_what_a_product_inherits_now(self, routed):
        k = routed
        out = R.get_product_route(k.shop.id, k.cola.id, **_ctx(k))
        assert out["mode"] == "inherit" and out["printerIds"] == []
        assert set(out["inheritedPrinterIds"]) == {k.bar, k.kitchen}
        assert out["inheritedFromName"] == "Drinks"
        assert {p["name"] for p in out["printers"]} == {"Kitchen", "Bar"}
        route_product(k, k.cola, "none")
        assert R.get_product_route(k.shop.id, k.cola.id, **_ctx(k))["mode"] == "none"
        sub = R.get_category_route(k.shop.id, k.mains.id, **_ctx(k))
        assert (sub["mode"], sub["inheritedPrinterIds"], sub["inheritedFromName"]) == ("inherit", [k.kitchen], "Food")


class TestTheTillWritesPrinters:
    """The till's product / category dialogs write through the existing till PUTs."""

    def test_product_and_category_puts_carry_kitchen_printers(self, k):
        from types import SimpleNamespace

        from app.routers import sync as sync_router
        from app.schemas.category import CategoryUpdate
        from app.schemas.product import ProductUpdate

        actor = SimpleNamespace(user_id=None, pos_user_id=None)
        till = k.tills[0]
        kitchen = create(k, name="Kitchen")["id"]
        bar = create(k, name="Bar", host="10.0.0.9")["id"]

        seen = R.get_till_product_printers(str(till.id), k.steak.id, machine=till, db=k.db)
        assert seen["mode"] == "inherit" and {p["id"] for p in seen["printers"]} == {kitchen, bar}

        sync_router.machine_update_cloud_product(
            str(till.id), str(k.steak.id),
            ProductUpdate.model_validate({"kitchenPrinters": {"mode": "printers", "printerIds": [kitchen, bar]}}),
            machine=till, actor=actor, db=k.db,
        )
        assert _line(k, till, k.steak) == {kitchen, bar}
        sync_router.machine_update_cloud_category(
            str(till.id), str(k.drinks.id),
            CategoryUpdate.model_validate({"kitchenPrinters": {"mode": "printers", "printerIds": [bar]}}),
            machine=till, actor=actor, db=k.db,
        )
        assert _line(k, till, k.cola) == {bar}
        assert R.get_till_category_printers(str(till.id), k.drinks.id, machine=till, db=k.db)["printerIds"] == [bar]
        # Back to the category (Mains > Food: nothing routed there).
        sync_router.machine_update_cloud_product(
            str(till.id), str(k.steak.id),
            ProductUpdate.model_validate({"kitchenPrinters": {"mode": "inherit"}}),
            machine=till, actor=actor, db=k.db,
        )
        assert _line(k, till, k.steak) == set()

    def test_the_field_never_reaches_the_product_row(self):
        from app.schemas.product import ProductUpdate

        body = ProductUpdate.model_validate({"price": 3, "kitchenPrinters": {"mode": "none"}})
        assert "kitchen_printers" not in body.model_dump(exclude_unset=True)
        assert body.kitchen_printers.mode == "none"


# ── The shop's print server ("שרת הדפסות", till parameter printHostTill) ───────


def make_print_host(w, till, on=True):
    """Set `printHostTill` at the till's own level, as the dashboard would."""
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(w.db)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "printHostTill").one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=till.id, value=on,
    ))
    w.db.commit()


class TestPrintServer:
    def test_off_by_default(self, k):
        create(k, name="Kitchen")
        out = pull(k, k.tills[0])
        assert out["printHost"] is None and out["hostsLan"] is False
        # Without a print server a network printer is not relayed.
        assert refused(send_job, k, k.tills[0], out["printers"][0]["id"]).detail == "printer_not_relayed"

    def test_the_shop_learns_its_print_server_and_where_it_listens(self, k):
        t1, t2 = k.tills
        kitchen = create(k, name="Kitchen")["id"]
        bar_area = ShopArea(id=uuid.uuid4(), tenant_id=k.tenant.id, shop_id=k.shop.id, name="Bar")
        k.db.add(bar_area)
        k.db.commit()
        # Narrowed to the bar, where the print server does not stand: it still prints it.
        bar = create(k, name="Bar", host="10.0.0.9", areaId=str(bar_area.id))["id"]
        make_print_host(k, t2)

        one = pull(k, t1)
        assert one["printHost"] == {
            "machineId": str(t2.id), "name": "2 · Till 2", "isSelf": False, "lanAddress": None, "port": 8399,
        }
        assert one["hostsLan"] is False
        two = pull(k, t2)
        assert two["printHost"]["isSelf"] is True and two["hostsLan"] is True and two["hostsRelay"] is True
        served = {p["id"]: p for p in two["printers"]}
        assert served[kitchen]["isHost"] is True and served[kitchen]["inScope"] is True
        assert served[bar]["isHost"] is True and served[bar]["inScope"] is False
        assert one["printSecret"] == two["printSecret"]

        # The server reports its LAN address; the others see it, and a repeat moves no ETag.
        R.report_print_host(str(t2.id), PrintHostReportIn(lanAddress="192.168.1.20"), machine=t2, db=k.db)
        seen = pull(k, t1)
        assert (seen["printHost"]["lanAddress"], seen["printHost"]["port"]) == ("192.168.1.20", 8399)
        R.report_print_host(str(t2.id), PrintHostReportIn(lanAddress="192.168.1.20"), machine=t2, db=k.db)
        assert pull(k, t1, etag=seen["etag"])["syncType"] == "unchanged"

    def test_the_cloud_is_the_fallback_to_the_print_server(self, k):
        t1, t2 = k.tills
        kitchen = create(k, name="Kitchen")["id"]
        own = create(k, name="Own", connectionType="till", host=None)["id"]
        make_print_host(k, t2)
        out = send_job(k, t1, kitchen)
        assert out["targetMachineId"] == str(t2.id)
        handed = pending(k, t2)
        assert handed[0]["printer"]["connection"] == "network" and handed[0]["printer"]["host"] == "192.168.1.50"
        # A till's own printer is never relayed.
        assert refused(send_job, k, t1, own).detail == "printer_not_relayed"
        # The test print goes to the one that prints it for everyone.
        jobs = R.test_printer(uuid.UUID(kitchen), BackgroundTasks(), **_ctx(k))["jobs"]
        assert [j["targetMachineId"] for j in jobs] == [str(t2.id)]

    def test_several_marked_the_lowest_register_number_wins(self, k):
        t1, t2 = k.tills
        make_print_host(k, t2)
        make_print_host(k, t1)
        assert pull(k, t2)["printHost"]["machineId"] == str(t1.id)
        # Not a till of the shop: the other shop has none.
        assert pull(k, k.other_till)["printHost"] is None

    def test_the_dashboard_picks_one_till_by_number(self, k):
        from app.schemas.kitchen_printers import PrintHostIn

        t1, t2 = k.tills

        def pick(till, user=None):
            tasks = BackgroundTasks()
            out = R.put_print_host(k.shop.id, PrintHostIn(machineId=till.id if till else None), tasks, **_ctx(k, user))
            _run(tasks)
            return out["printHost"]

        assert pick(t2, user=k.manager)["machineId"] == str(t2.id)
        assert pull(k, t1)["printHost"]["machineId"] == str(t2.id)
        # Moving it takes it off the other till.
        assert pick(t1)["machineId"] == str(t1.id)
        assert pull(k, t2)["printHost"]["machineId"] == str(t1.id)
        page = R.list_printers(k.shop.id, **_ctx(k))
        assert page["printHost"]["name"] == "1 · Till 1"
        assert pick(None) is None
        assert pull(k, t1)["printHost"] is None
        assert refused(pick, k.other_till).detail == "machine_not_in_shop"
        assert refused(pick, t1, user=k.cashier).status_code == 403


# ── The product itself, in every shop ("ללא בון", "אפס להגדרת המחלקה") ─────────


def no_ticket(w, product, on, user=None, shop=None):
    tasks = BackgroundTasks()
    out = R.put_product_no_ticket(
        product.id, ProductNoTicketIn(noTicket=on), tasks, shop_id=(shop.id if shop else None), **_ctx(w, user)
    )
    _run(tasks)
    return out


def reset(w, product, user=None, shop=None):
    tasks = BackgroundTasks()
    out = R.reset_product_kitchen(product.id, tasks, shop_id=(shop.id if shop else None), **_ctx(w, user))
    _run(tasks)
    return out


def route_in(w, shop, routes):
    body = CategoryRoutesIn(routes={c.id: [uuid.UUID(p) for p in ps] for c, ps in routes.items()})
    R.put_category_routes(shop.id, body, BackgroundTasks(), **_ctx(w))


def product_in(w, shop, product, mode, printers=()):
    body = ProductRouteIn(mode=mode, printerIds=[uuid.UUID(p) for p in printers])
    return R.put_product_route(shop.id, product.id, body, BackgroundTasks(), **_ctx(w))


def till_put(w, till, product, mode):
    from types import SimpleNamespace

    from app.routers import sync as sync_router
    from app.schemas.product import ProductUpdate

    return sync_router.machine_update_cloud_product(
        str(till.id), str(product.id),
        ProductUpdate.model_validate({"kitchenPrinters": {"mode": mode}}),
        machine=till, actor=SimpleNamespace(user_id=None, pos_user_id=None), db=w.db,
    )


class TestTheProductEverywhere:
    @pytest.fixture
    def two_shops(self, k):
        k.kitchen = create(k, name="Kitchen")["id"]
        k.bar = create(k, name="Bar", host="10.0.0.9")["id"]
        k.north = create(k, shop=k.other_shop, name="North", host="10.0.1.5")["id"]
        route_in(k, k.shop, {k.drinks: [k.bar, k.kitchen], k.food: [k.kitchen]})
        route_in(k, k.other_shop, {k.drinks: [k.north]})
        return k

    def test_no_ticket_reaches_every_shop_and_off_returns_to_the_category(self, two_shops):
        k = two_shops
        product_in(k, k.shop, k.cola, "printers", [k.kitchen])
        product_in(k, k.other_shop, k.cola, "printers", [k.north])
        k.notified.clear()

        out = no_ticket(k, k.cola, True, shop=k.shop)
        assert out["noTicket"] is True and out["overrideShops"] == []
        assert out["effective"] == {"source": "no_ticket", "printerIds": [], "printerNames": []}
        # Both shops' tills: no ticket for it; its own rows in both shops are gone.
        assert _line(k, k.tills[0], k.cola) == set()
        assert _line(k, k.other_till, k.cola) == set()
        assert pull(k, k.other_till)["productRoutes"][str(k.cola.id)] == []
        # Every till of the tenant is told, not only this shop's.
        told = {m for m, reason in k.notified if reason == K.NOTIFY_REASON}
        assert told >= {str(t.id) for t in k.tills} | {str(k.other_till.id)}

        # Off: by the category again, in each shop.
        out = no_ticket(k, k.cola, False, shop=k.shop)
        assert out["noTicket"] is False and out["effective"]["source"] == "category"
        assert set(out["effective"]["printerNames"]) == {"Bar", "Kitchen"}
        assert _line(k, k.tills[0], k.cola) == {k.bar, k.kitchen}
        assert _line(k, k.other_till, k.cola) == {k.north}
        # Idempotent both ways.
        assert no_ticket(k, k.cola, False)["noTicket"] is False
        no_ticket(k, k.cola, True)
        assert no_ticket(k, k.cola, True)["noTicket"] is True

    def test_no_ticket_also_stops_a_till_with_no_printer_of_its_own(self, k):
        # The other shop has no printer: its till prints a counter sale's lines on itself…
        before = pull(k, k.other_till)
        assert before["printers"] == [] and str(k.cola.id) not in before["productRoutes"]
        # …but not a "ללא בון" product's.
        no_ticket(k, k.cola, True)
        assert pull(k, k.other_till)["productRoutes"][str(k.cola.id)] == []

    def test_reset_clears_every_shop_and_says_how_many_there_were(self, two_shops):
        k = two_shops
        product_in(k, k.shop, k.steak, "printers", [k.bar])
        product_in(k, k.other_shop, k.steak, "none")
        state = R.get_product_kitchen(k.steak.id, shop_id=None, **_ctx(k))
        assert [s["shopName"] for s in state["overrideShops"]] == ["Center", "North"]
        assert state["overrideShops"][0]["printerNames"] == ["Bar"]
        assert state["overrideShops"][1]["mode"] == "none"
        assert state["canEditProduct"] is True and "effective" not in state
        row = next(r for r in R.get_routing(k.shop.id, **_ctx(k))["products"] if r["productId"] == str(k.steak.id))
        assert (row["overrideShopCount"], row["canEditProduct"]) == (2, True)

        out = reset(k, k.steak, shop=k.shop)
        assert out["overrideShops"] == [] and out["noTicket"] is False
        assert out["effective"]["source"] == "category"
        assert _line(k, k.tills[0], k.steak) == {k.kitchen}  # Mains inherits Food's
        assert str(k.steak.id) not in pull(k, k.other_till)["productRoutes"]
        # A reset also takes "ללא בון" off.
        no_ticket(k, k.steak, True)
        assert reset(k, k.steak)["noTicket"] is False
        assert _line(k, k.tills[0], k.steak) == {k.kitchen}

    def test_printers_for_one_shop_are_refused_while_no_ticket_is_on(self, two_shops):
        k = two_shops
        no_ticket(k, k.cola, True)
        assert refused(product_in, k, k.shop, k.cola, "printers", [k.kitchen]).detail == "product_no_ticket"
        product_in(k, k.shop, k.cola, "inherit")  # harmless
        assert K.is_no_ticket(k.db, k.cola.id)

    def test_the_routing_page_lists_a_no_ticket_product_in_every_shop(self, two_shops):
        k = two_shops
        no_ticket(k, k.salad, True)
        rows = {r["productId"]: r for r in R.get_routing(k.shop.id, **_ctx(k))["products"]}
        row = rows[str(k.salad.id)]
        assert (row["mode"], row["noTicket"], row["printerIds"], row["overrideShopCount"]) == (
            "no_ticket", True, [], 0,
        )
        assert str(k.salad.id) in {r["productId"] for r in R.get_routing(k.other_shop.id, **_ctx(k))["products"]}

    def test_where_it_prints_now_and_why(self, two_shops):
        k = two_shops

        def eff(product, till=None):
            if till is None:
                return R.get_product_route(k.shop.id, product.id, **_ctx(k))["effective"]
            return R.get_till_product_printers(str(till.id), product.id, machine=till, db=k.db)["effective"]

        assert eff(k.cola)["source"] == "category" and set(eff(k.cola)["printerNames"]) == {"Bar", "Kitchen"}
        product_in(k, k.shop, k.cola, "printers", [k.bar])
        assert (eff(k.cola)["source"], eff(k.cola)["printerNames"]) == ("product", ["Bar"])
        product_in(k, k.shop, k.cola, "none")
        assert eff(k.cola)["source"] == "product_none"
        no_ticket(k, k.cola, True)
        assert eff(k.cola)["source"] == "no_ticket"
        # As a till sees it: only the printers it uses.
        no_ticket(k, k.cola, False)
        till2_only = create(k, name="Till 2 only", host="10.0.0.7", machineId=str(k.tills[1].id))["id"]
        product_in(k, k.shop, k.cola, "printers", [k.kitchen, till2_only])
        assert eff(k.cola, k.tills[0])["printerIds"] == [k.kitchen]
        assert set(eff(k.cola, k.tills[1])["printerIds"]) == {k.kitchen, till2_only}

    def test_the_till_one_taps_through_its_product_put(self, two_shops):
        from types import SimpleNamespace

        from app.routers import sync as sync_router
        from app.schemas.category import CategoryUpdate

        k = two_shops
        till = k.tills[0]
        product_in(k, k.other_shop, k.cola, "printers", [k.north])

        till_put(k, till, k.cola, "no_ticket")
        assert K.is_no_ticket(k.db, k.cola.id)
        assert _line(k, k.other_till, k.cola) == set()
        info = R.get_till_product_printers(str(till.id), k.cola.id, machine=till, db=k.db)
        assert info["noTicket"] is True and info["effective"]["source"] == "no_ticket"

        till_put(k, till, k.cola, "ticket")
        assert _line(k, till, k.cola) == {k.bar, k.kitchen}

        product_in(k, k.shop, k.cola, "printers", [k.bar])
        product_in(k, k.other_shop, k.cola, "printers", [k.north])
        assert len(R.get_till_product_printers(str(till.id), k.cola.id, machine=till, db=k.db)["overrideShops"]) == 2
        till_put(k, till, k.cola, "reset")
        assert R.get_till_product_printers(str(till.id), k.cola.id, machine=till, db=k.db)["overrideShops"] == []
        assert _line(k, k.other_till, k.cola) == {k.north}

        # A category has no product-wide modes.
        e = refused(
            sync_router.machine_update_cloud_category,
            str(till.id), str(k.drinks.id),
            CategoryUpdate.model_validate({"kitchenPrinters": {"mode": "reset"}}),
            machine=till, actor=SimpleNamespace(user_id=None, pos_user_id=None), db=k.db,
        )
        assert e.detail == "mode_is_for_products"

    def test_a_machine_local_copy_names_its_global_product(self, two_shops):
        k = two_shops
        till = k.tills[0]
        local = Product(
            id=uuid.uuid4(), tenant_id=k.tenant.id, company_id=k.company.id, category_id=k.drinks.id,
            name="cola", price=Decimal("9.00"), sku="sku-cola-local", pos_machine_id=till.id,
            global_product_id=k.cola.id,
        )
        k.db.add(local)
        k.db.commit()
        till_put(k, till, local, "no_ticket")
        assert K.is_no_ticket(k.db, k.cola.id) and not K.is_no_ticket(k.db, local.id)
        routes = pull(k, till)["productRoutes"]
        assert routes[str(local.id)] == [] and routes[str(k.cola.id)] == []
        assert R.get_till_product_printers(str(till.id), local.id, machine=till, db=k.db)["productId"] == str(k.cola.id)

    def test_only_who_may_edit_the_product_changes_it_everywhere(self, two_shops):
        k = two_shops
        assert refused(no_ticket, k, k.cola, True, user=k.cashier).status_code == 403
        # A shop manager sets their shop's routing, not a chain product's.
        assert refused(no_ticket, k, k.cola, True, user=k.manager).status_code == 403
        assert refused(reset, k, k.cola, user=k.north_manager).status_code == 403
        assert refused(R.get_product_kitchen, k.cola.id, shop_id=None, **_ctx(k, k.manager)).status_code == 403
        assert no_ticket(k, k.cola, True, user=k.company_manager)["noTicket"] is True
        # The shop manager still sees it on their shop's pages, without the product-wide switch.
        state = R.get_product_route(k.shop.id, k.cola.id, **_ctx(k, k.manager))
        assert state["noTicket"] is True and state["canEditProduct"] is False
        mine = R.get_product_kitchen(k.cola.id, shop_id=k.shop.id, **_ctx(k, k.manager))
        assert mine["effective"]["source"] == "no_ticket"
        row = next(r for r in R.get_routing(k.shop.id, **_ctx(k, k.manager))["products"] if r["productId"] == str(k.cola.id))
        assert row["canEditProduct"] is False
        # Another tenant's shop is not this product's business.
        assert refused(R.get_product_kitchen, k.cola.id, shop_id=k.foreign_shop.id, **_ctx(k)).detail == "tenant_forbidden"

    def test_the_routing_pull_moves_with_it(self, two_shops):
        k = two_shops
        first = pull(k, k.other_till)
        no_ticket(k, k.cola, True)
        second = pull(k, k.other_till, etag=first["etag"])
        assert second["syncType"] == "full"
        assert pull(k, k.other_till, etag=second["etag"])["syncType"] == "unchanged"


# ── Receipt printers ("מדפסות חשבוניות") ──────────────────────────────────────


class TestReceiptPrinters:
    def test_a_receipt_printer_is_reached_directly_and_may_have_a_drawer(self, k):
        out = create(k, name="קופה ראשית BTP-880", purpose="receipt", cashDrawer=True)
        assert out["purpose"] == "receipt" and out["cashDrawer"] is True
        with pytest.raises(ValidationError):
            printer_in(name="x", purpose="receipt", connectionType="cloud", hostMachineId=str(uuid.uuid4()))
        with pytest.raises(ValidationError):
            printer_in(name="x", purpose="receipt", connectionType="till")
        # USB hangs on one till.
        with pytest.raises(ValidationError):
            printer_in(name="x", purpose="receipt", connectionType="usb")
        usb = create(k, name="USB", purpose="receipt", connectionType="usb", machineId=str(k.tills[0].id))
        assert usb["connectionType"] == "usb" and usb["machineName"]
        # A kitchen printer has no drawer and no USB.
        assert printer_in(name="k", cashDrawer=True).cash_drawer is False
        with pytest.raises(ValidationError):
            printer_in(name="k", connectionType="usb", machineId=str(uuid.uuid4()))

    def test_the_tills_get_it_but_no_ticket_routes_there(self, k):
        kitchen = create(k, name="Kitchen")
        receipt = create(k, name="Counter", purpose="receipt", host="192.168.1.60", cashDrawer=True)
        with pytest.raises(Exception) as e:
            route_categories(k, {k.food: [receipt["id"]]})
        assert getattr(e.value, "detail", None) == "printer_not_kitchen"
        route_categories(k, {k.food: [kitchen["id"]]})
        out = pull(k, k.tills[0])
        by_id = {p["id"]: p for p in out["printers"]}
        assert by_id[receipt["id"]]["purpose"] == "receipt" and by_id[receipt["id"]]["cashDrawer"] is True
        assert by_id[receipt["id"]]["inScope"] is False
        assert by_id[kitchen["id"]]["purpose"] == "kitchen" and by_id[kitchen["id"]]["inScope"] is True
        assert all(receipt["id"] not in ids for ids in out["categoryRoutes"].values())

    def test_the_print_server_does_not_take_receipt_printers(self, k):
        t1, t2 = k.tills
        make_print_host(k, t1)
        receipt = create(k, name="Counter", purpose="receipt", host="192.168.1.60")
        kitchen = create(k, name="Kitchen")
        host_view = {p["id"]: p for p in pull(k, t1)["printers"]}
        assert host_view[kitchen["id"]]["isHost"] is True
        assert host_view[receipt["id"]]["isHost"] is False
        # Not relayed through the cloud either: the till prints it itself.
        with pytest.raises(Exception) as e:
            send_job(k, t2, receipt["id"])
        assert getattr(e.value, "detail", None) == "printer_not_relayed"


def test_a_relayed_ticket_expires_in_minutes_not_half_an_hour():
    assert K.JOB_TTL <= timedelta(minutes=5)
