"""
"מספר הזמנה: עם אות (A-17) / מספר בלבד (17)" — the kiosk's pickup label format, and finding an
order by its pickup number (the owner, 09.10.2026).

* The format (`pickup.labelFormat`, layered company → shop → machine): `prefixed` (default,
  today's "A-17") or `number` ("17"); the label function on and off.
* Uniqueness: the number alone always comes from the shop's shared daily counter — `repair`
  forces `scope: "shop"` whatever a layer says — so two kiosks never both say "17" that day.
  A label already given stays (idempotent per order key).
* Search: "17", "A17", "A-17", "a-17" (spaces and dashes dropped, any case) find the order —
  in the dashboard's transactions (with `kioskPickup` and `matchedBy`), in the till's shop
  search (`/reports/{m}/shop-transactions`) and in the kiosk's orders list (over 30 business
  days, each row with its date). A bare number still finds documents by number as before.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.kiosk import KioskOrder
from app.routers import kiosks as R
from app.routers import transactions as TR
from app.services import kiosk_config as C
from app.services import kiosk_control as S
from app.services import kiosk_pickup as P
from app.services import reports as REP
from test_kiosks import _till, convert, pickup, put, w  # noqa: F401


# ── The label function ───────────────────────────────────────────────────────


def test_the_label_with_its_letter_and_without():
    assert P.pickup_label("A", 17) == "A-17"                    # the default: today's label
    assert P.pickup_label("A", 17, "prefixed") == "A-17"
    assert P.pickup_label("", 17, "prefixed") == "17"
    assert P.pickup_label("A", 17, "number") == "17"            # "מספר בלבד"
    assert P.pickup_label("", 17, "number") == "17"
    assert P.pickup_label(None, 5, None) == "5"


# ── The setting ──────────────────────────────────────────────────────────────


def test_the_setting_defaults_to_the_letter_and_takes_two_values():
    assert C.DEFAULT_CONFIG["pickup"]["labelFormat"] == "prefixed"
    assert C.limits()["enums"]["pickupLabelFormat"] == ["prefixed", "number"]
    cfg = C.default_config()
    cfg["pickup"]["labelFormat"] = "number"
    assert C.validate_config(cfg) == []
    cfg["pickup"]["labelFormat"] = "letters"
    assert {e.path for e in C.validate_config(cfg)} == {"pickup.labelFormat"}
    _, issues = C.validate_layer({"pickup": {"labelFormat": "number"}})
    assert issues == []


def test_the_number_alone_always_takes_the_shops_counter():
    assert C.resolve({"pickup": {"labelFormat": "number"}})["pickup"]["scope"] == "shop"
    # A lower layer that asks for the kiosk's own sequence cannot undo it …
    assert C.resolve({"pickup": {"labelFormat": "number"}}, {}, {"pickup": {"scope": "kiosk"}})["pickup"]["scope"] == "shop"
    # … and with its letter the scope is as set (today's behaviour).
    assert C.resolve({"pickup": {"scope": "kiosk"}})["pickup"]["scope"] == "kiosk"
    assert C.resolve({})["pickup"] == {"scope": "kiosk", "prefix": "", "start": 1, "max": 999, "labelFormat": "prefixed"}


def test_layered_like_every_kiosk_setting(w):
    convert(w, controllers=[])
    put(w, "company", w.company.id, {"pickup": {"prefix": "A"}})
    put(w, "shop", w.shop.id, {"pickup": {"labelFormat": "number"}})
    eff = C.effective_config(w.db, w.kiosk)["pickup"]
    assert (eff["labelFormat"], eff["scope"], eff["prefix"]) == ("number", "shop", "A")
    put(w, "machine", w.kiosk.id, {"pickup": {"labelFormat": "prefixed", "scope": "kiosk"}})
    eff = C.effective_config(w.db, w.kiosk)["pickup"]
    assert (eff["labelFormat"], eff["scope"]) == ("prefixed", "kiosk")


# ── Uniqueness under "מספר בלבד" ─────────────────────────────────────────────


def test_two_kiosks_never_both_say_17(w):
    convert(w, controllers=[])
    second = _till(w, "Kiosk 2", w.shop)
    convert(w, second, controllers=[])
    # Each kiosk its own letter and — as asked — its own sequence; the number alone overrides that.
    put(w, "machine", w.kiosk.id, {"pickup": {"prefix": "A", "scope": "kiosk", "labelFormat": "number"}})
    put(w, "machine", second.id, {"pickup": {"prefix": "B", "scope": "kiosk", "labelFormat": "number"}})

    labels = []
    for i in range(40):
        kiosk = w.kiosk if i % 2 == 0 else second
        out = pickup(w, kiosk, f"{kiosk.id}-o{i}")
        assert out["label"] == str(out["number"])          # no letter
        labels.append(out["label"])
    assert len(set(labels)) == 40                          # unique across both kiosks that day
    assert sorted(int(x) for x in labels) == list(range(1, 41))
    # Idempotent per order key; a new business day starts again at `start`.
    assert pickup(w, w.kiosk, f"{w.kiosk.id}-o0") == {"number": 1, "label": "1"}
    assert pickup(w, second, "next-day", day=date(2026, 10, 7)) == {"number": 1, "label": "1"}


def test_a_label_already_given_is_kept_when_the_format_changes(w):
    convert(w, controllers=[])
    put(w, "shop", w.shop.id, {"pickup": {"scope": "shop", "prefix": "A"}})
    assert pickup(w, w.kiosk, "o1") == {"number": 1, "label": "A-1"}
    put(w, "shop", w.shop.id, {"pickup": {"scope": "shop", "prefix": "A", "labelFormat": "number"}})
    assert pickup(w, w.kiosk, "o1") == {"number": 1, "label": "A-1"}   # the slip already says A-1
    assert pickup(w, w.kiosk, "o2") == {"number": 2, "label": "2"}     # the next one, the number alone


def test_the_allocation_unit_shares_one_counter_whatever_the_format():
    """kiosk_pickup.allocate itself: the label follows the format, the number the shop's counter."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.models.kiosk import KioskPickupAllocation, KioskPickupCounter

    engine = create_engine("sqlite://")
    KioskPickupCounter.__table__.create(engine)
    KioskPickupAllocation.__table__.create(engine)
    db = sessionmaker(bind=engine)()
    shop, day = uuid.uuid4(), date(2026, 10, 9)
    a = P.allocate(db, shop_id=shop, business_date=day, order_key="a", start=1, max_number=999, prefix="A")
    b = P.allocate(db, shop_id=shop, business_date=day, order_key="b", start=1, max_number=999, prefix="B", label_format="number")
    c = P.allocate(db, shop_id=shop, business_date=day, order_key="c", start=1, max_number=999, prefix="A", label_format="prefixed")
    assert [(x.number, x.label) for x in (a, b, c)] == [(1, "A-1"), (2, "2"), (3, "A-3")]


# ── Search normalisation ─────────────────────────────────────────────────────


@pytest.mark.parametrize("typed,key,number,digits_only", [
    ("17", "17", 17, True),
    ("A17", "A17", 17, False),
    ("A-17", "A17", 17, False),
    ("a-17", "A17", 17, False),
    (" a - 17 ", "A17", 17, False),
    ("A–17", "A17", 17, False),       # an en dash
    ("#17", "17", 17, True),
    ("AL-17", "AL17", 17, False),     # a number the kiosk drew offline
    ("א-17", "א17", 17, False),
    ("9999", "9999", 9999, True),
])
def test_what_the_box_reads_as_a_pickup_number(typed, key, number, digits_only):
    q = P.parse_pickup_query(typed)
    assert (q.key, q.number, q.digits_only) == (key, number, digits_only)


@pytest.mark.parametrize("typed", ["", "  ", "A", "המבורגר", "20000057", "12345", "17.50", "A-17-B"])
def test_what_is_not_a_pickup_number(typed):
    assert P.parse_pickup_query(typed) is None


def test_a_bare_number_matches_any_letter_a_letter_only_its_own():
    assert P.parse_pickup_query("17").matches("A-17", 17)
    assert P.parse_pickup_query("17").matches("17", 17)
    assert P.parse_pickup_query("17").matches("BL-17", 17)
    assert P.parse_pickup_query("a-17").matches("A-17", 17)
    assert not P.parse_pickup_query("A17").matches("B-17", 17)
    assert not P.parse_pickup_query("A17").matches("17", 17)
    assert not P.parse_pickup_query("17").matches("A-170", 170)


# ── The search, everywhere ───────────────────────────────────────────────────


@pytest.fixture
def shop_day(w):
    """
    The kiosk's sale A-17 (yesterday's 17 too, B-17 of another kiosk, the number alone on a third
    day), a till's sale numbered 1017, and one of no kiosk order.
    """
    convert(w, controllers=[])
    today = S.business_today(w.db, w.tenant.id)
    now = datetime.now(timezone.utc)
    second = _till(w, "Kiosk 2", w.shop)
    docs = {}

    def doc(name, till, number, total, *, label=None, pickup_no=None, day=None):
        tx = w.doc(till, None, total, number=number)
        tx.created_at = now - timedelta(minutes=5)
        docs[name] = tx
        if label:
            w.db.add(KioskOrder(
                id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
                local_id=f"local-{name}", transaction_id=str(tx.id), transaction_number=f"4000{number.zfill(4)}",
                pickup_number=pickup_no, pickup_label=label, business_date=day or today,
                fulfillment_mode="BON", item_count=1, total_agorot=int(Decimal(total) * 100), tip_agorot=0,
                paid_at=now, bon_status="sent", receipt_status="printed", status="paid",
            ))
        return tx

    doc("a17", w.kiosk, "57", "45.00", label="A-17", pickup_no=17)
    doc("a17_yesterday", w.kiosk, "40", "30.00", label="A-17", pickup_no=17, day=today - timedelta(days=1))
    doc("b17", second, "58", "12.00", label="B-17", pickup_no=17)
    doc("n17", w.kiosk, "60", "8.00", label="17", pickup_no=17, day=today - timedelta(days=2))
    doc("a18", w.kiosk, "59", "20.00", label="A-18", pickup_no=18)
    doc("till_1017", w.tills[1], "1017", "99.00")
    w.db.flush()
    w.docs, w.today = docs, today
    return w


def _numbers(rows):
    return sorted(r.transaction_number for r in rows)


class TestTheDashboardsTransactions:
    def _list(self, w, q):
        out = TR.list_transactions(
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, page=1, page_size=200, q=q,
            from_date=w.today - timedelta(days=5), to_date=w.today + timedelta(days=1),
        )
        return {i.transaction_number: i for i in out.items}

    @pytest.mark.parametrize("typed", ["A17", "A-17", "a-17", " a 17 "])
    def test_the_letter_finds_that_kiosks_orders(self, shop_day, typed):
        rows = self._list(shop_day, typed)
        assert set(rows) == {"57", "40"}                       # today's A-17 and yesterday's
        assert rows["57"].matched_by == ["pickup"]
        assert rows["57"].kiosk_pickup.label == "A-17"
        assert rows["57"].kiosk_pickup.business_date == shop_day.today
        assert rows["40"].kiosk_pickup.business_date == shop_day.today - timedelta(days=1)

    def test_the_number_finds_every_17_and_still_the_document_numbers(self, shop_day):
        rows = self._list(shop_day, "17")
        assert set(rows) == {"57", "40", "58", "60", "1017"}
        assert rows["1017"].matched_by == ["document"] and rows["1017"].kiosk_pickup is None
        assert rows["58"].matched_by == ["pickup"] and rows["58"].kiosk_pickup.label == "B-17"
        assert rows["60"].kiosk_pickup.label == "17"

    def test_without_a_search_the_pickup_is_still_shown(self, shop_day):
        rows = self._list(shop_day, None)
        assert rows["59"].kiosk_pickup.label == "A-18" and rows["59"].matched_by is None
        assert rows["1017"].kiosk_pickup is None

    def test_a_document_number_is_searched_as_before(self, shop_day):
        rows = self._list(shop_day, "1017")
        assert set(rows) == {"1017"} and rows["1017"].matched_by == ["document"]

    def test_the_search_filter_alone(self, shop_day):
        from app.models.transaction import Transaction

        q = TR._search_filters(shop_day.db.query(Transaction), q="b-17")
        assert _numbers(q.all()) == ["58"]


class TestTheTillsShopSearch:
    """`GET /reports/{m}/shop-transactions?q=` — the till's "whole shop" search."""

    def test_finds_by_the_label_with_its_date(self, shop_day):
        rows, _ = REP.load_shop_transactions_for_machine(shop_day.db, shop_day.tills[1], hours=24, q="a-17")
        assert sorted((r.transaction_number, r.pickup_label, tuple(r.matched_by)) for r in rows) == [
            ("40", "A-17", ("pickup",)), ("57", "A-17", ("pickup",)),
        ]
        dates = {r.transaction_number: r.pickup_business_date for r in rows}
        assert dates["57"] == shop_day.today.isoformat()
        assert dates["40"] == (shop_day.today - timedelta(days=1)).isoformat()

    def test_a_bare_number_labels_both_kinds_of_hits(self, shop_day):
        rows, _ = REP.load_shop_transactions_for_machine(shop_day.db, shop_day.tills[1], hours=24, q="17")
        by = {r.transaction_number: r.matched_by for r in rows}
        assert by["1017"] == ["document"] and by["57"] == ["pickup"] and by["58"] == ["pickup"]

    def test_no_search_no_reason(self, shop_day):
        rows, _ = REP.load_shop_transactions_for_machine(shop_day.db, shop_day.tills[1], hours=24)
        assert all(r.matched_by is None for r in rows)
        assert {r.transaction_number: r.pickup_label for r in rows}["59"] == "A-18"


class TestTheKiosksOrdersList:
    def _orders(self, w, q, day=None):
        return R.get_kiosk_orders(machine_id=w.kiosk.id, day=day, q=q, current_user=w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)

    @pytest.mark.parametrize("typed", ["17", "A17", "a-17"])
    def test_over_the_last_days_each_with_its_date(self, shop_day, typed):
        rows = self._orders(shop_day, typed, day=shop_day.today)
        expected = ["A-17", "A-17"] if typed != "17" else ["A-17", "A-17", "17"]
        assert [r["pickupLabel"] for r in rows] == expected        # newest business day first
        assert rows[0]["businessDate"] == shop_day.today.isoformat()
        assert rows[1]["businessDate"] == (shop_day.today - timedelta(days=1)).isoformat()
        assert all(r["matchedBy"] == ["pickup"] for r in rows)

    def test_by_the_document_number(self, shop_day):
        rows = self._orders(shop_day, "40000057", day=shop_day.today)
        assert [(r["pickupLabel"], r["matchedBy"]) for r in rows] == [("A-17", ["document"])]

    def test_without_a_search_the_days_list_as_before(self, shop_day):
        rows = self._orders(shop_day, None, day=shop_day.today)
        assert sorted(r["pickupLabel"] for r in rows) == ["A-17", "A-18"]
        assert all("matchedBy" not in r for r in rows)
