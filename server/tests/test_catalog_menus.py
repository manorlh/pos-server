"""
"תפריטים" — named sales menus by schedule (docs/SPEC_MENUS.md).

What each class pins, and how it could look fine while doing damage:

* **Golden** — the rules are one computation here and on the till (pos-android
  `domain/CatalogMenus.kt`): every shared case gives the same answer, and the file is the
  same bytes in both repositories. A rule changed on one side alone would make a till sell
  another menu, at other prices, than the dashboard says.
* **Schedule** — the edges by hand: end exclusive, hours after midnight belong to the day
  (and the date) the range started, 00:00–00:00 is the whole day, dates bound "always",
  no weekdays is never, unreadable hours are never — not all day.
* **Clocks moving** — evaluated on the shop's wall clock: across the autumn change the
  repeated hour is in a range twice, across the spring one a range inside the skipped hour
  never starts.
* **Precedence** — till > point of sale > shop > company > the company above; a level
  counts only when one of its menus is active; priority within a level, then the name.
  Fallback per level, the most specific that says; channel.
* **Sync** — the till is sent only what is assigned along its own chain, its local copy's
  ids, no names; a delta pull carries the block only when it changed (or the till moved).
* **Review mode** — a shop that reviews menu changes serves its tills the published menus:
  a new menu waits for "אישור ושידור", shows in the review, and goes out with it; a shop
  without menus keeps its fingerprint.
* **CRUD and who may** — a company's menus by whoever covers it; assigning at a target the
  user manages, only a menu placed on the target's company or above.
* **Lines and the report** — each sold line keeps the menu and its price's source.
* **What is active / the simulator** — the dashboard's answers come from the same rules,
  with what the menu sells there, blocked items marked.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.catalog_menu import CatalogMenuAssignment, CatalogMenuFallback
from app.models.category import Category
from app.models.company import Company
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import MachineProductOverride
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import catalog_menus as R
from app.routers import sync as sync_router
from app.schemas.catalog_menu import MenuIn, TargetAssignmentsIn
from app.schemas.transaction import TransactionIn
from app.services import catalog_menu_rules as RULES
from app.services import catalog_menus as CM
from app.services import menu_broadcast as B
from app.services import till_parameters as TP
from app.services.reports import resolve_report_window
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, refused, w  # noqa: F401

GOLDEN = Path(__file__).parent / "fixtures" / "catalog_menus_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: CatalogMenusTest. Change the fixtures in both repositories, and both constants, together.
GOLDEN_SHA256 = "7170719785b59a7785790b0c5a4242871f9cba2906aa8efdb31c7c6ff2809bea"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name

OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)
TUESDAY = date(2026, 10, 6)


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _golden():
    return json.loads(_text(GOLDEN))


def local(text: str) -> datetime:
    return datetime.fromisoformat(text)


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


# ── The world ────────────────────────────────────────────────────────────────


@pytest.fixture
def mw(w, monkeypatch):  # noqa: F811
    """
    The group "Group" over the company "Acme" (shops Center and North). Center sells eggs,
    a burger, pasta, cola and beer (Hot, Mains, Drinks); North only cola. Till 1 stands in
    the point of sale "Bar" and holds its own local copy of the cola.
    """
    monkeypatch.setattr(sync_router, "_ensure_shop_general_item", lambda *_a: None)
    db = w.db
    TP.ensure_builtin_parameters(db)
    w.group = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Group", vat_number="2")
    db.add(w.group)
    db.flush()
    w.company.parent_company_id = w.group.id
    w.rival = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Rival", vat_number="3")
    db.add(w.rival)
    db.flush()

    def category(name, sort):
        c = Category(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name, sort_order=sort,
            updated_at=OLD, created_at=OLD,
        )
        db.add(c)
        db.flush()
        return c

    def product(name, cat, price, shops=None):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=cat.id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=Decimal(price), sku=f"sku-{name}",
            is_available=True, updated_at=OLD, created_at=OLD,
        )
        db.add(p)
        db.flush()
        for shop in shops or [w.shop]:
            db.add(ShopProductOverride(
                id=uuid.uuid4(), shop_id=shop.id, global_product_id=p.id, is_listed=True,
                updated_at=OLD, created_at=OLD,
            ))
        return p

    w.hot = category("Hot", 1)
    w.mains = category("Mains", 2)
    w.drinks = category("Drinks", 3)
    w.eggs = product("eggs", w.hot, "42.00")
    w.burger = product("burger", w.mains, "52.00")
    w.pasta = product("pasta", w.mains, "46.00")
    w.cola = product("cola", w.drinks, "12.00", shops=[w.shop, w.other_shop])
    w.beer = product("beer", w.drinks, "28.00")
    w.t1, w.t2 = w.tills
    w.bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    db.add(w.bar)
    db.flush()
    w.t1.area_id = w.bar.id
    w.t1.area_changed_at = OLD
    w.t2.area_changed_at = OLD
    w.other_till.area_changed_at = OLD
    w.cola_local = Product(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=w.drinks.id,
        catalog_level=CatalogLevel.LOCAL, name="cola", price=Decimal("12.00"), sku="sku-cola-local",
        pos_machine_id=w.t1.id, global_product_id=w.cola.id, in_stock=True, is_available=True,
        updated_at=OLD, created_at=OLD,
    )
    db.add(w.cola_local)
    db.commit()
    return w


def body(**over):
    base = {"name": "צהריים", "channel": "both", "always": True}
    base.update(over)
    return MenuIn.model_validate(base)


def create(w, user=None, **over):
    out = R.create_catalog_menu(body(**over), BackgroundTasks(), **_ctx(w, user))
    return out


def assign(w, level, target, *menus, fallback=None, user=None):
    """`menus`: (menu, priority) pairs or menus."""
    rows = []
    for m in menus:
        menu, priority = m if isinstance(m, tuple) else (m, 0)
        rows.append({"menuId": menu["id"], "priority": priority})
    payload = {"level": level, "targetId": str(target.id), "menus": rows, "fallback": fallback}
    return R.set_catalog_menu_target(TargetAssignmentsIn.model_validate(payload), BackgroundTasks(), **_ctx(w, user))


def active(w, till, at_utc, surface="pos"):
    return CM.resolve_at(w.db, till, at_utc, surface)


def pull(w, till, since=None):
    out = sync_router.get_catalog_sync(
        str(till.id), since=since.isoformat() if isinstance(since, datetime) else since, machine=till, db=w.db,
    )
    return out.model_dump(by_alias=True)


# ── Golden: one computation here and on the till ─────────────────────────────


def test_the_fixtures_are_the_pinned_ones():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixtures():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    assert _text(SIBLING) == _text(GOLDEN)


@pytest.mark.parametrize("case", _golden()["cases"], ids=lambda c: c["name"][:60])
def test_every_golden_case(case):
    golden = _golden()
    block = golden["blocks"][case["block"]]
    got = RULES.sellable(block, local(case["at"]), case["surface"], golden["products"])
    assert got == case["expected"]


def test_the_golden_cases_say_what_their_names_say():
    """The expected values are the rules' own output — so pin the important ones by hand too."""
    cases = {c["name"]: c["expected"] for c in _golden()["cases"]}

    def find(fragment):
        return next(v for k, v in cases.items() if fragment in k)

    hh = find("happy hour at the shop beats lunch")
    assert hh["resolution"]["menuId"] == "m-happy" and hh["resolution"]["level"] == "shop"
    assert hh["applied"]["products"] == [
        {"id": "p-beer", "categoryId": "c-drinks", "price": "15.00", "priceSource": "menu"},
        {"id": "p-cola", "categoryId": "c-drinks", "price": "8.50", "priceSource": "menu"},
    ]
    lunch = find("lunch at 12:00")
    assert [p["id"] for p in lunch["applied"]["products"]] == [
        "p-burger", "p-schnitzel", "p-cola", "p-coffee", "p-water", "p-beer",
    ]
    assert find("Saturday 01:30")["resolution"]["menuId"] == "m-night"
    assert find("Sunday 01:00")["resolution"]["mode"] == "catalog"
    assert find("fallback none - no menu")["resolution"]["mode"] == "none"
    assert find("by name")["resolution"]["menuId"] == "m-alef"
    assert find("the kiosk at 12:00")["resolution"]["menuId"] == "m-kiosk"


# ── Schedule edges, by hand ───────────────────────────────────────────────────


class TestSchedule:
    def test_end_exclusive_start_inclusive(self):
        s = {"ranges": [["07:00", "11:30"]]}
        assert RULES.schedule_active(s, local("2026-10-06T07:00"))
        assert RULES.schedule_active(s, local("2026-10-06T11:29"))
        assert not RULES.schedule_active(s, local("2026-10-06T11:30"))
        assert not RULES.schedule_active(s, local("2026-10-06T06:59"))

    def test_after_midnight_belongs_to_the_day_and_date_it_started(self):
        friday_nights = {"days": [5], "ranges": [["22:00", "02:00"]], "to": "2026-10-09"}
        # Saturday 01:00 is Friday 2026-10-09's night: a Friday, and within the dates.
        assert RULES.schedule_active(friday_nights, local("2026-10-10T01:00"))
        # Friday 01:00 is Thursday's: not a night day.
        assert not RULES.schedule_active(friday_nights, local("2026-10-09T01:00"))
        # The next Saturday's small hours are Friday 2026-10-16's — after the last date.
        assert not RULES.schedule_active(friday_nights, local("2026-10-17T01:00"))
        starting = {"days": [5], "ranges": [["22:00", "02:00"]], "from": "2026-10-10"}
        # Saturday 2026-10-10 01:00 started on Friday 10-09, before the first date.
        assert not RULES.schedule_active(starting, local("2026-10-10T01:00"))

    def test_whole_day_and_24_hours(self):
        monday = {"days": [1], "ranges": [["00:00", "00:00"]]}
        assert RULES.schedule_active(monday, local("2026-10-05T00:00"))
        assert RULES.schedule_active(monday, local("2026-10-05T23:59"))
        assert not RULES.schedule_active(monday, local("2026-10-06T00:00"))
        from_six = {"days": [1], "ranges": [["06:00", "06:00"]]}
        assert not RULES.schedule_active(from_six, local("2026-10-05T05:59"))
        assert RULES.schedule_active(from_six, local("2026-10-06T05:59"))
        assert not RULES.schedule_active(from_six, local("2026-10-06T06:00"))
        assert RULES.schedule_active({"days": [2]}, local("2026-10-06T03:00"))

    def test_always_is_bounded_by_its_dates(self):
        s = {"always": True, "from": "2026-12-24", "to": "2026-12-26", "days": [], "ranges": [["01:00", "02:00"]]}
        assert RULES.schedule_active(s, local("2026-12-24T00:00"))
        assert RULES.schedule_active(s, local("2026-12-26T23:59"))
        assert not RULES.schedule_active(s, local("2026-12-27T00:00"))
        assert RULES.schedule_active({"always": True}, local("2031-01-01T03:33"))

    def test_no_weekdays_and_unreadable_hours_are_never(self):
        assert not RULES.schedule_active({"days": []}, local("2026-10-06T12:00"))
        assert not RULES.schedule_active({"ranges": [["25:00", "26:00"]]}, local("2026-10-06T12:00"))
        assert not RULES.schedule_active({"ranges": [["7:5", "8:00"]]}, local("2026-10-06T07:30"))
        assert RULES.schedule_active({"ranges": [["bad", "x"], ["07:00", "08:00"]]}, local("2026-10-06T07:30"))

    def test_weekday_numbering_is_sunday_zero(self):
        assert RULES.weekday(date(2026, 10, 4)) == 0  # Sunday
        assert RULES.weekday(date(2026, 10, 10)) == 6  # Saturday

    def test_next_change_walks_to_the_next_edge(self):
        block = {
            "menus": [{"id": "m", "name": "בוקר", "channel": "both", "schedule": {"ranges": [["07:00", "11:30"]]},
                       "categories": [], "products": []}],
            "assignments": [{"menuId": "m", "level": "shop", "depth": 0, "priority": 0}],
        }
        nxt = RULES.next_change(block, local("2026-10-06T08:00"))
        assert nxt["at"] == local("2026-10-06T11:30") and nxt["mode"] == "catalog"
        nxt = RULES.next_change(block, local("2026-10-06T12:00"))
        assert nxt["at"] == local("2026-10-07T07:00") and nxt["menuId"] == "m"
        assert RULES.next_change({"menus": [], "assignments": []}, local("2026-10-06T08:00")) is None


# ── Clocks moving (Asia/Jerusalem) ────────────────────────────────────────────


class TestClocksMoving:
    def test_the_repeated_autumn_hour_is_in_a_range_twice(self, mw):
        menu = create(mw, name="לילה", always=False, ranges=[{"start": "01:00", "end": "01:30"}])
        assign(mw, "shop", mw.shop, menu)
        # 2026-10-25 02:00 IDT → 01:00 IST: local 01:10 happens at 22:10 and at 23:10 UTC.
        assert active(mw, mw.t2, utc("2026-10-24T22:10"))["menuId"] == menu["id"]
        assert active(mw, mw.t2, utc("2026-10-24T23:10"))["menuId"] == menu["id"]
        assert active(mw, mw.t2, utc("2026-10-24T23:40"))["mode"] == "catalog"

    def test_a_range_inside_the_skipped_spring_hour_never_starts(self, mw):
        skipped = create(mw, name="חלון שנבלע", always=False, ranges=[{"start": "02:00", "end": "02:30"}])
        around = create(mw, name="מסביב", always=False, ranges=[{"start": "01:30", "end": "03:30"}])
        assign(mw, "shop", mw.shop, (skipped, 5))
        assign(mw, "machine", mw.t2, around)
        # 2026-03-27 02:00 IST → 03:00 IDT (00:00 UTC). 02:00–02:30 never exists that night.
        for minute in range(-30, 40, 5):
            at = utc("2026-03-27T00:00") + timedelta(minutes=minute)
            assert active(mw, mw.t1, at)["menuId"] != skipped["id"], at
        # The range around the jump is cut to wall-clock time: 01:45 IST, 03:20 IDT, not 03:31.
        assert active(mw, mw.t2, utc("2026-03-26T23:45"))["menuId"] == around["id"]
        assert active(mw, mw.t2, utc("2026-03-27T00:20"))["menuId"] == around["id"]
        assert active(mw, mw.t2, utc("2026-03-27T00:31"))["mode"] == "catalog"


# ── Precedence, fallback, channel ─────────────────────────────────────────────


class TestPrecedence:
    def test_the_most_specific_level_wins(self, mw):
        at = utc("2026-10-06T09:00")
        group = create(mw, name="קבוצה", companyId=str(mw.group.id))
        company = create(mw, name="חברה", companyId=str(mw.company.id))
        shop = create(mw, name="סניף", companyId=str(mw.company.id))
        area = create(mw, name="בר", companyId=str(mw.company.id))
        till = create(mw, name="קופה 2", companyId=str(mw.company.id))
        assign(mw, "company", mw.group, (group, 99))
        assert active(mw, mw.t1, at)["menuId"] == group["id"]
        assert active(mw, mw.t1, at)["depth"] == 1
        assign(mw, "company", mw.company, company)
        assert active(mw, mw.t1, at)["menuId"] == company["id"]
        assign(mw, "shop", mw.shop, shop)
        assert active(mw, mw.t1, at)["menuId"] == shop["id"]
        assign(mw, "area", mw.bar, area)
        assert active(mw, mw.t1, at)["menuId"] == area["id"]
        assert active(mw, mw.t2, at)["menuId"] == shop["id"]
        assign(mw, "machine", mw.t2, till)
        assert active(mw, mw.t2, at)["menuId"] == till["id"]
        # The other shop of the company: the company's menu.
        assert active(mw, mw.other_till, at)["menuId"] == company["id"]

    def test_a_level_counts_only_while_one_of_its_menus_is_active(self, mw):
        company = create(mw, name="כל היום")
        happy = create(mw, name="הפי האוור", always=False, days=[2], ranges=[{"start": "18:00", "end": "20:00"}])
        assign(mw, "company", mw.company, company)
        assign(mw, "shop", mw.shop, happy)
        assert active(mw, mw.t1, utc("2026-10-06T09:00"))["menuId"] == company["id"]  # 12:00 local
        assert active(mw, mw.t1, utc("2026-10-06T15:30"))["menuId"] == happy["id"]  # 18:30 local
        assert active(mw, mw.t1, utc("2026-10-07T15:30"))["menuId"] == company["id"]  # Wednesday

    def test_within_a_level_priority_then_name(self, mw):
        b = create(mw, name="ב תפריט")
        a = create(mw, name="א תפריט")
        assign(mw, "shop", mw.shop, b, a)
        assert active(mw, mw.t1, utc("2026-10-06T09:00"))["menuId"] == a["id"]
        assign(mw, "shop", mw.shop, (b, 3), a)
        assert active(mw, mw.t1, utc("2026-10-06T09:00"))["menuId"] == b["id"]

    def test_an_inactive_menu_is_never_active(self, mw):
        off = create(mw, name="כבוי", isActive=False)
        assign(mw, "shop", mw.shop, off)
        assert active(mw, mw.t1, utc("2026-10-06T09:00"))["mode"] == "catalog"
        assert pull(mw, mw.t1)["catalogMenus"]["menus"] == []

    def test_the_fallback_of_the_most_specific_level_that_sets_one(self, mw):
        lunch = create(mw, name="צהריים", always=False, ranges=[{"start": "12:00", "end": "15:00"}])
        assign(mw, "company", mw.company, lunch, fallback="none")
        evening = utc("2026-10-06T16:00")
        assert active(mw, mw.t1, evening)["mode"] == "none"
        assert active(mw, mw.t1, utc("2026-10-06T10:00"))["menuId"] == lunch["id"]
        assign(mw, "shop", mw.shop, fallback="catalog")
        assert active(mw, mw.t1, evening)["mode"] == "catalog"
        assign(mw, "machine", mw.t2, fallback="none")
        assert active(mw, mw.t2, evening)["mode"] == "none"
        assert active(mw, mw.t1, evening)["mode"] == "catalog"
        assert active(mw, mw.other_till, evening)["mode"] == "none"

    def test_the_channel(self, mw):
        kiosk = create(mw, name="קיוסק", channel="kiosk")
        tills = create(mw, name="קופות", channel="pos")
        assign(mw, "shop", mw.shop, (kiosk, 1), tills)
        at = utc("2026-10-06T09:00")
        assert active(mw, mw.t1, at, "pos")["menuId"] == tills["id"]
        assert active(mw, mw.t1, at, "kiosk")["menuId"] == kiosk["id"]


# ── The till's copy ───────────────────────────────────────────────────────────


class TestSync:
    def test_a_full_pull_carries_only_the_tills_own_chain(self, mw):
        lunch = create(
            mw, name="צהריים", always=False, days=[0, 1, 2, 3, 4], ranges=[{"start": "11:30", "end": "17:00"}],
            categories=[{"categoryId": str(mw.mains.id), "allProducts": False}, {"categoryId": str(mw.drinks.id)}],
            products=[{"productId": str(mw.burger.id), "price": "48.00"}, {"productId": str(mw.cola.id)}],
        )
        north = create(mw, name="צפון")
        bar = create(mw, name="בר")
        assign(mw, "company", mw.company, lunch)
        assign(mw, "shop", mw.other_shop, north)
        assign(mw, "area", mw.bar, (bar, 2), fallback="none")
        block = pull(mw, mw.t1)["catalogMenus"]
        assert {m["id"] for m in block["menus"]} == {lunch["id"], bar["id"]}
        assert block["fallback"] == "none"
        assert block["assignments"] == [
            {"menuId": bar["id"], "level": "area", "depth": 0, "priority": 2},
            {"menuId": lunch["id"], "level": "company", "depth": 0, "priority": 0},
        ]
        wire = next(m for m in block["menus"] if m["id"] == lunch["id"])
        assert wire == {
            "id": lunch["id"], "name": "צהריים", "channel": "both",
            "schedule": {"always": False, "days": [0, 1, 2, 3, 4], "ranges": [["11:30", "17:00"]], "from": None, "to": None},
            "categories": [{"id": str(mw.mains.id), "all": False}, {"id": str(mw.drinks.id), "all": True}],
            # Till 1 holds its own copy of the cola: named by the copy's id, as its rows are.
            "products": [{"id": str(mw.burger.id), "price": 48.0}, {"id": str(mw.cola_local.id)}],
        }
        # Till 2 (no area, no copy): the company's menu only, the global id.
        other = pull(mw, mw.t2)["catalogMenus"]
        assert [m["id"] for m in other["menus"]] == [lunch["id"]]
        assert other["menus"][0]["products"][1] == {"id": str(mw.cola.id)}
        assert other["fallback"] == "catalog"
        assert [m["id"] for m in pull(mw, mw.other_till)["catalogMenus"]["menus"]] == sorted([lunch["id"], north["id"]])

    def test_a_till_with_nothing_gets_an_empty_block_on_a_full_pull(self, mw):
        block = pull(mw, mw.t1)["catalogMenus"]
        assert block["menus"] == [] and block["assignments"] == [] and block["fallback"] == "catalog"

    def test_a_delta_carries_it_only_when_it_changed_or_the_till_moved(self, mw):
        menu = create(mw, name="בוקר")
        assign(mw, "shop", mw.shop, menu)
        first = pull(mw, mw.t2)
        since = datetime.fromisoformat(first["serverTime"])
        assert pull(mw, mw.t2, since)["catalogMenus"] is None
        R.update_catalog_menu(menu["id"], body(name="בוקר מעודכן"), BackgroundTasks(), **_ctx(mw))
        changed = pull(mw, mw.t2, since)["catalogMenus"]
        assert changed["menus"][0]["name"] == "בוקר מעודכן"
        later = datetime.now(timezone.utc) + timedelta(seconds=1)
        assert pull(mw, mw.t2, later)["catalogMenus"] is None
        mw.t2.area_id = mw.bar.id
        mw.t2.area_changed_at = later + timedelta(seconds=1)
        mw.db.commit()
        assert pull(mw, mw.t2, later)["catalogMenus"] is not None

    def test_the_watermark_moves_with_the_menus(self, mw):
        from app.services.sync import get_catalog_change_watermark_for_machine

        before = get_catalog_change_watermark_for_machine(mw.db, mw.t1)
        create(mw, name="חדש")
        after = get_catalog_change_watermark_for_machine(mw.db, mw.t1)
        assert after is not None and (before is None or after > before)


# ── Review mode ("שידור תפריט") ───────────────────────────────────────────────


def _tables_on(w):
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = w.db.query(TillParameter).filter(TillParameter.key == "tablesMode").one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type="shop", scope_id=w.shop.id, value="קופה אחת",
    ))
    w.db.commit()


class TestReviewMode:
    def test_a_shop_without_menus_keeps_its_fingerprint(self, mw):
        snap = B.build_snapshot(mw.db, mw.shop)
        assert "catalogMenus" not in snap
        assert "catalogMenus" not in B.content_of(snap)

    def test_menus_wait_for_the_broadcast_and_show_in_the_review(self, mw):
        breakfast = create(mw, name="בוקר")
        assign(mw, "shop", mw.shop, breakfast)
        _tables_on(mw)
        # Entering review mode: the first publication is the live state — nothing changes.
        assert [m["id"] for m in pull(mw, mw.t2)["catalogMenus"]["menus"]] == [breakfast["id"]]
        happy = create(mw, name="הפי האוור", products=[{"productId": str(mw.beer.id), "price": "15"}],
                       categories=[{"categoryId": str(mw.drinks.id), "allProducts": False}])
        assign(mw, "shop", mw.shop, breakfast, (happy, 5))
        # A draft: not on the till, full pull or not.
        assert [m["id"] for m in pull(mw, mw.t2)["catalogMenus"]["menus"]] == [breakfast["id"]]
        assert CM.simulate(mw.db, mw.admin, mw.tenant.id, level="machine", target_id=mw.t2.id,
                           at="2026-10-06T12:00")["resolution"]["menuId"] == breakfast["id"]
        review = B.preview(mw.db, mw.shop)
        items = [i for i in review["sections"]["menu"] if i.get("detail", "").startswith("catalog_menu")]
        assert {(i["type"], i["detail"], i["name"]) for i in items} == {
            ("added", "catalog_menu", "הפי האוור"),
            ("changed", "catalog_menu_assignment", "Center"),
        }
        assert review["hasChanges"]
        B.broadcast(mw.db, mw.shop, mw.admin, expected_fingerprint=review["fingerprint"], notify=False)
        assert {m["id"] for m in pull(mw, mw.t2)["catalogMenus"]["menus"]} == {breakfast["id"], happy["id"]}
        assert active(mw, mw.t2, utc("2026-10-06T09:00"))["menuId"] == happy["id"]

    def test_a_price_change_is_a_reviewed_change(self, mw):
        hh = create(mw, name="הפי האוור", products=[{"productId": str(mw.beer.id), "price": "15"}],
                    categories=[{"categoryId": str(mw.drinks.id), "allProducts": False}])
        assign(mw, "shop", mw.shop, hh)
        _tables_on(mw)
        pull(mw, mw.t2)
        R.update_catalog_menu(hh["id"], body(
            name="הפי האוור", products=[{"productId": str(mw.beer.id), "price": "14"}],
            categories=[{"categoryId": str(mw.drinks.id), "allProducts": False}],
        ), BackgroundTasks(), **_ctx(mw))
        assert pull(mw, mw.t2)["catalogMenus"]["menus"][0]["products"] == [{"id": str(mw.beer.id), "price": 15.0}]
        items = [i for i in B.preview(mw.db, mw.shop)["sections"]["menu"] if i.get("detail") == "catalog_menu"]
        assert items[0]["changes"] == [{"field": "price", "before": 15.0, "after": 14.0, "label": "beer"}]


# ── CRUD and who may ──────────────────────────────────────────────────────────


class TestCrud:
    def test_create_read_update_delete(self, mw):
        menu = create(
            mw, name="בוקר", companyId=str(mw.company.id), always=False, days=[0, 1, 2],
            ranges=[{"start": "07:00", "end": "11:30"}], validFrom="2026-10-01", color="#f59e0b",
            categories=[{"categoryId": str(mw.hot.id)}, {"categoryId": str(mw.drinks.id), "allProducts": False}],
            products=[{"productId": str(mw.cola.id), "price": "9.90"}, {"productId": str(mw.beer.id)}],
        )
        assert menu["companyName"] == "Acme" and menu["color"] == "#F59E0B"
        assert [c["name"] for c in menu["categories"]] == ["Hot", "Drinks"]
        assert menu["products"] == [
            {"productId": str(mw.cola.id), "name": "cola", "categoryId": str(mw.drinks.id), "price": 9.9, "catalogPrice": 12.0},
            {"productId": str(mw.beer.id), "name": "beer", "categoryId": str(mw.drinks.id), "price": None, "catalogPrice": 28.0},
        ]
        updated = R.update_catalog_menu(menu["id"], body(
            name="בוקר", products=[{"productId": str(mw.beer.id)}, {"productId": str(mw.cola.id)}],
        ), BackgroundTasks(), **_ctx(mw))
        assert [p["name"] for p in updated["products"]] == ["beer", "cola"] and updated["categories"] == []
        assign(mw, "shop", mw.shop, updated)
        assert R.get_catalog_menu(menu["id"], **_ctx(mw))["assignments"][0]["targetName"] == "Center"
        R.delete_catalog_menu(menu["id"], BackgroundTasks(), **_ctx(mw))
        assert mw.db.query(CatalogMenuAssignment).count() == 0
        assert R.list_catalog_menus(**_ctx(mw))["menus"] == []

    def test_what_is_refused(self, mw):
        assert refused(create, mw, categories=[{"categoryId": str(uuid.uuid4())}]).detail == CM.UNKNOWN_CATEGORY
        assert refused(create, mw, products=[{"productId": str(mw.cola_local.id)}]).detail == CM.UNKNOWN_PRODUCT
        with pytest.raises(ValidationError):
            body(days=[])
        with pytest.raises(ValidationError):
            body(ranges=[{"start": "7:00", "end": "08:00"}])
        with pytest.raises(ValidationError):
            body(validFrom="2026-10-10", validTo="2026-10-01")
        with pytest.raises(ValidationError):
            body(products=[{"productId": str(mw.cola.id)}, {"productId": str(mw.cola.id)}])

    def test_who_may_write_a_menu(self, mw):
        assert create(mw, user=mw.company_manager, companyId=str(mw.company.id))["canEdit"]
        assert refused(create, mw, user=mw.company_manager).status_code == 403  # the whole organization
        assert refused(create, mw, user=mw.cashier, companyId=str(mw.company.id)).status_code == 403
        rival = create(mw, name="יריב", companyId=str(mw.rival.id))
        assert refused(
            R.update_catalog_menu, rival["id"], body(companyId=str(mw.rival.id)), BackgroundTasks(),
            **_ctx(mw, mw.company_manager),
        ).status_code in (403, 404)

    def test_who_may_assign_what_where(self, mw):
        mine = create(mw, name="של החברה", companyId=str(mw.company.id))
        group = create(mw, name="של הקבוצה", companyId=str(mw.group.id))
        rival = create(mw, name="יריב", companyId=str(mw.rival.id))
        assign(mw, "shop", mw.shop, mine, group, user=mw.manager)
        assert refused(assign, mw, "shop", mw.other_shop, mine, user=mw.manager).status_code == 403
        assert refused(assign, mw, "shop", mw.shop, rival).detail == CM.OUT_OF_REACH
        assert refused(assign, mw, "machine", mw.t1, mine, user=mw.cashier).status_code == 403
        assign(mw, "area", mw.bar, fallback="none", user=mw.manager)
        assert mw.db.query(CatalogMenuFallback).one().mode == "none"
        assign(mw, "area", mw.bar, user=mw.manager)
        assert mw.db.query(CatalogMenuFallback).count() == 0
        targets = R.get_catalog_menu_targets(company_id=None, shop_id=None, **_ctx(mw))
        levels = {(t["level"], t["name"]) for t in targets["targets"]}
        assert {("company", "Acme"), ("shop", "Center"), ("area", "Bar"), ("machine", "Till 1")} <= levels
        assert {(a["level"], a["menuId"]) for a in targets["assignments"]} == {("shop", mine["id"]), ("shop", group["id"])}
        narrowed = R.get_catalog_menu_targets(company_id=None, shop_id=mw.shop.id, **_ctx(mw))
        assert {t["name"] for t in narrowed["targets"] if t["level"] == "company"} == {"Acme", "Group"}
        assert {t["name"] for t in narrowed["targets"] if t["level"] == "shop"} == {"Center"}


# ── The dashboard: what is active, the simulator ──────────────────────────────


class TestDashboard:
    def test_the_simulator_says_which_why_and_what_it_sells(self, mw):
        lunch = create(mw, name="צהריים", channel="pos", always=False, ranges=[{"start": "11:30", "end": "17:00"}])
        happy = create(
            mw, name="הפי האוור", always=False, days=[2], ranges=[{"start": "16:00", "end": "19:00"}],
            categories=[{"categoryId": str(mw.drinks.id), "allProducts": True}],
            products=[{"productId": str(mw.beer.id), "price": "15"}],
        )
        assign(mw, "company", mw.company, lunch)
        assign(mw, "shop", mw.shop, happy)
        mw.db.add(MachineProductOverride(
            id=uuid.uuid4(), machine_id=mw.t2.id, product_id=mw.cola.id, is_available=False,
        ))
        mw.db.commit()
        out = CM.simulate(mw.db, mw.admin, mw.tenant.id, level="machine", target_id=mw.t2.id, at="2026-10-06T16:30")
        assert out["weekday"] == 2 and out["surface"] == "pos" and out["source"] == "live"
        assert out["resolution"]["menuId"] == happy["id"] and out["resolution"]["level"] == "shop"
        assert out["resolution"]["next"] == {"at": "2026-10-06T19:00", "mode": "catalog", "menuId": None, "menuName": None}
        assert {(c["menuName"], c["activeNow"], c["chosen"]) for c in out["candidates"]} == {
            ("צהריים", True, False), ("הפי האוור", True, True),
        }
        drinks = out["preview"]["categories"][0]
        assert [(p["name"], p["price"], p["priceSource"], p["blocked"]) for p in drinks["products"]] == [
            ("beer", 15.0, "menu", False), ("cola", 12.0, "catalog", True),
        ]
        kiosk = CM.simulate(mw.db, mw.admin, mw.tenant.id, level="machine", target_id=mw.t2.id,
                            at="2026-10-06T13:00", surface="kiosk")
        assert kiosk["resolution"]["mode"] == "catalog"  # lunch is the tills only
        # An instant with an offset is the shop's local time once converted: 10:00Z = 13:00.
        assert CM.simulate(mw.db, mw.admin, mw.tenant.id, level="shop", target_id=mw.shop.id,
                           at="2026-10-06T10:00:00Z", preview=False)["at"] == "2026-10-06T13:00"

    def test_now_lists_every_shop_area_and_till(self, mw):
        lunch = create(mw, name="צהריים", always=False, ranges=[{"start": "11:30", "end": "17:00"}])
        bar = create(mw, name="בר", channel="kiosk")
        assign(mw, "company", mw.company, lunch)
        assign(mw, "area", mw.bar, bar)
        out = R.get_catalog_menus_now(company_id=None, shop_id=None, at="2026-10-06T12:00", **_ctx(mw))
        rows = {(r["level"], r["name"]): r for r in out["rows"]}
        assert rows[("shop", "Center")]["pos"]["menuName"] == "צהריים"
        assert rows[("shop", "Center")]["pos"]["next"]["at"] == "2026-10-06T17:00"
        assert rows[("area", "Bar")]["kiosk"]["menuName"] == "בר"
        assert rows[("machine", "Till 1")]["kiosk"]["menuName"] == "בר"
        assert rows[("machine", "Till 2")]["kiosk"]["menuName"] == "צהריים"
        assert rows[("machine", "North 1")]["pos"]["menuName"] == "צהריים"


# ── Sold lines and the report ─────────────────────────────────────────────────


def _line(product, price, **extra):
    line = {"id": str(uuid.uuid4()), "productId": str(product.id), "productName": product.name,
            "quantity": 1, "unitPrice": price, "totalPrice": price}
    line.update(extra)
    return line


def _doc(shift, items, number):
    total = sum(Decimal(str(i["totalPrice"])) for i in items)
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": str(total), "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": str(total)}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY), "items": items,
    })


class TestLines:
    def test_each_line_keeps_its_menu_and_price_source(self, mw):
        menu = create(mw, name="הפי האוור")
        shift = mw.shift(mw.t1, 1, status=ShiftStatus.OPEN)
        doc = _doc(shift, [
            _line(mw.beer, "15.00", menuId=menu["id"], menuName="הפי האוור", priceSource="menu"),
            _line(mw.cola, "12.00", menuId=menu["id"], menuName="הפי האוור", priceSource="catalog"),
            _line(mw.eggs, "42.00"),
            _line(mw.pasta, "46.00", menuId="not-a-uuid", menuName="x" * 200, priceSource="menu"),
        ], "9001")
        assert [r.status for r in upsert_transactions(mw.db, mw.t1, [doc])] == ["accepted"]
        rows = {i.product_name: i for i in mw.db.query(TransactionItem).all()}
        assert (str(rows["beer"].menu_id), rows["beer"].price_source) == (menu["id"], "menu")
        assert rows["cola"].price_source == "catalog" and rows["cola"].menu_name == "הפי האוור"
        assert rows["eggs"].menu_id is None and rows["eggs"].price_source is None
        assert rows["pasta"].menu_id is None and len(rows["pasta"].menu_name) == 80

        window = resolve_report_window(mw.db, mw.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1))
        report = R.get_menu_sales_report(
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1), from_hour=None, to_hour=None,
            tz=None, shop_id=None, machine_id=None, **_ctx(mw),
        )
        direct = CM.menu_sales_report(mw.db, mw.admin, mw.tenant.id, window)
        assert report["rows"] == direct["rows"] and report["totals"] == direct["totals"]
        by_menu = {r["menuName"]: r for r in report["rows"]}
        hh = by_menu["הפי האוור"]
        assert (hh["unitsSold"], hh["gross"], hh["menuPricedUnits"], hh["menuPricedGross"]) == (2.0, 27.0, 1.0, 15.0)
        assert report["totals"]["gross"] == 115.0
        assert report["rows"][-1]["menuId"] is None  # "no menu" last
