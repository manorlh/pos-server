"""
"בהיסטוריית עסקאות תוסיף גם חיפוש לפי מספר שולחן" (the owner, 14.10.2026;
P:/specs/history-table-search.md) — app/services/table_documents.py and its two readers.

* The box: "ש12", "ש 12", "ש-12", "שולחן 12", "t12", "table 12" ask for table 12 and only
  for it; with the "שולחן" chip / `table` filter the digits alone are a table number and other
  text a table's name; text with a letter ("VIP 1", "בר 3") may also be a table's name; digits
  alone without the chip are not a table search (the document number / amount search as before).
* A document's table: its order's sale, a part paid on its own, a payment given back inside the
  table, and a credit note of any of those — with the number and name the order froze, the order
  and when it was opened.
* The till's shop list (`/reports/{m}/shop-transactions`): the four fields on every row; `table`
  and `q` filter to the table's documents — both orders of a table opened twice that day, each
  with its own `tableOrderId` — never another shop's, never a document numbered "112".
* The dashboard's transactions list: the same fields, the `table` filter and the same search.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.tables import DiningTable, TableOrder, TableZone
from app.routers import transactions as TR
from app.services import reports as REP
from app.services import table_documents as T
from shift_world import accept_str_uuids, make_world


# ── The box ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("typed", [
    "ש12", "ש 12", "ש-12", "ש־12", "  ש   12 ", "שולחן 12", "שולחן12", "t12", "T 12", "table 12", "Table12", "ש#12",
])
def test_the_explicit_forms_ask_for_table_12_only(typed):
    tq = T.parse_table_query(typed)
    assert (tq.number, tq.explicit, tq.name_whole) == (12, True, True)
    assert tq.name == " ".join(typed.split())      # "ש-12" is also a restored table's name


@pytest.mark.parametrize("typed", ["VIP 1", "בר 3", "vip", "המבורגר"])
def test_text_with_a_letter_may_be_a_tables_name(typed):
    tq = T.parse_table_query(typed)
    assert (tq.number, tq.name, tq.explicit, tq.name_whole) == (None, typed, False, False)


@pytest.mark.parametrize("typed", ["", "   ", "12", "20000057", "17.50", None])
def test_digits_and_amounts_are_not_a_table_search_without_the_chip(typed):
    assert T.parse_table_query(typed) is None


def test_with_the_chip_digits_are_a_table_number_and_text_a_name():
    assert T.parse_table_query("12", chip=True) == T.TableQuery(number=12, name=None, explicit=True)
    assert T.parse_table_query(" 12 ", chip=True).number == 12
    assert T.parse_table_query("VIP 1", chip=True) == T.TableQuery(number=None, name="VIP 1", explicit=True)
    assert T.parse_table_query("ש-12", chip=True) == T.TableQuery(number=12, name="ש-12", explicit=True, name_whole=True)
    assert T.parse_table_query("123456", chip=True) == T.TableQuery(number=None, name="123456", explicit=True)
    assert T.parse_table_query("", chip=True) is None


def test_an_order_matches_by_number_or_by_name():
    assert T.parse_table_query("ש12").matches(12, "שולחן 12")
    assert T.parse_table_query("ש-12").matches(9012, "ש-12")     # a restored table, by its label
    assert not T.parse_table_query("ש12").matches(9012, "ש-12")  # "ש12" is not the label "ש-12"
    assert not T.parse_table_query("ש12").matches(112, None)
    assert T.parse_table_query("vip").matches(31, "VIP 1")
    assert T.parse_table_query("בר 3").matches(3, "בר 3")
    assert not T.parse_table_query("בר 3").matches(3, None)


def test_the_explicit_form_matches_a_name_as_a_whole():
    """It starts the name and does not go on with a digit; any other name search is a substring."""
    q = T.parse_table_query("ש-12")
    assert q.matches(9012, "ש-12") and q.matches(9112, "ש-12 (2)") and q.matches(9013, "  ש-12  ")
    assert not q.matches(9120, "ש-120")
    assert not q.matches(9200, "גן ש-12")                      # inside the name: not the explicit form
    assert not T.parse_table_query("שולחן 1").matches(10, "שולחן 10")
    assert T.parse_table_query("שולחן 10").matches(None, "שולחן 10")
    assert T.parse_table_query("t1").matches(None, "T1 bar")
    assert T.parse_table_query("vip", chip=True).matches(31, "the VIP 1")   # the chip's text: a substring
    assert T.parse_table_query("VIP 1").matches(31, "VIP 10")               # a letter search: a substring


# ── The shop's day ───────────────────────────────────────────────────────────


@pytest.fixture
def day(monkeypatch):
    """
    Table 12 twice today: the first order paid in a part (Till 2) and the rest (Till 1), a payment
    given back inside the table, and later a credit note of the rest; the second order one sale.
    A restored table "ש-12" (number 9012), "VIP 1" (31), "בר 3" (3), a counter sale numbered 112,
    and table 12 of the other shop.
    """
    accept_str_uuids(monkeypatch)
    w = make_world()
    now = datetime.now(timezone.utc)
    zones = {}

    def zone(shop):
        if shop.id not in zones:
            zones[shop.id] = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, name="אולם")
            w.db.add(zones[shop.id])
            w.db.flush()
        return zones[shop.id]

    def doc(name, till, total, minutes_ago, *, credit_of=None):
        tx = w.doc(till, None, total, number=name, credit_note=credit_of is not None)
        tx.created_at = now - timedelta(minutes=minutes_ago)
        if credit_of is not None:
            tx.refund_of_transaction_id = credit_of.id
        w.db.flush()
        return tx

    tables = {}

    def order(shop, number, name, opened_minutes_ago, sale, *, parts=(), given_back=()):
        table = tables.get((shop.id, number))
        if table is None:
            table = tables[(shop.id, number)] = DiningTable(
                id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, zone_id=zone(shop).id, number=number,
            )
            w.db.add(table)
            w.db.flush()
        extras = {}
        if parts:
            extras["partials"] = [{"tx": str(p.id), "no": p.transaction_number, "amount": 1000} for p in parts]
        if given_back:
            extras["reversals"] = [{"tx": str(orig.id), "credit": str(c.id), "no": c.transaction_number, "amount": 500}
                                   for orig, c in given_back]
        o = TableOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, table_id=table.id, table_number=number,
            table_name=name, status="paid", guests=2, opened_at=now - timedelta(minutes=opened_minutes_ago),
            closed_at=now - timedelta(minutes=opened_minutes_ago - 30),
            transaction_id=str(sale.id) if sale is not None else None,
            extras_json=json.dumps(extras) if extras else None,
        )
        w.db.add(o)
        w.db.flush()
        return o

    t1, t2 = w.tills
    part = doc("100", t2, "40.00", 200)
    given = doc("108", t2, "5.00", 195, credit_of=None)          # given back inside the table
    given.document_type = 330
    rest = doc("101", t1, "60.00", 170)
    w.first = order(w.shop, 12, None, 240, rest, parts=[part], given_back=[(part, given)])
    doc("102", t1, "10.00", 30, credit_of=rest)                   # a credit note of the rest, later
    w.second = order(w.shop, 12, None, 90, doc("103", t1, "25.00", 60))
    w.restored = order(w.shop, 9012, "ש-12", 50, doc("104", t2, "33.00", 20))
    order(w.shop, 31, "VIP 1", 45, doc("105", t1, "80.00", 15))
    order(w.shop, 3, "בר 3", 40, doc("106", t1, "12.00", 10))
    doc("112", t1, "12.00", 5)                                    # a counter sale numbered 112
    order(w.other_shop, 12, None, 100, doc("107", w.other_till, "50.00", 70))
    w.db.commit()
    w.now, w.add_doc, w.add_order = now, doc, order
    return w


def _shop(w, **kw):
    rows, _ = REP.load_shop_transactions_for_machine(w.db, w.tills[0], hours=24, **kw)
    return {r.transaction_number: r for r in rows}


def test_a_documents_table_sale_part_given_back_and_credit_note(day):
    from app.models.transaction import Transaction

    docs = day.db.query(Transaction).filter(Transaction.shop_id == day.shop.id).all()
    tables = T.tables_by_transaction(day.db, day.shop.id, docs)
    number = {str(d.id): d.transaction_number for d in docs}
    by_number = {number[k]: v for k, v in tables.items()}
    first = str(day.first.id)
    assert {n for n, v in by_number.items() if v["tableOrderId"] == first} == {"100", "101", "102", "108"}
    assert by_number["103"]["tableOrderId"] == str(day.second.id)
    assert by_number["101"]["tableNumber"] == 12 and by_number["101"]["tableName"] is None
    assert by_number["101"]["tableOpenedAt"] == day.first.opened_at.isoformat()
    assert (by_number["104"]["tableNumber"], by_number["104"]["tableName"]) == (9012, "ש-12")
    assert "112" not in by_number


class TestTheTillsShopList:
    def test_every_row_says_its_table_searched_or_not(self, day):
        rows = _shop(day)
        assert set(rows) == {"100", "101", "102", "103", "104", "105", "106", "108", "112"}   # not the other shop's
        assert (rows["103"].table_number, rows["103"].table_order_id) == (12, str(day.second.id))
        assert rows["105"].table_name == "VIP 1"
        assert rows["112"].table_number is None and rows["112"].table_order_id is None
        assert all(r.matched_by is None for r in rows.values())
        dumped = rows["101"].model_dump(by_alias=True)
        assert {"tableNumber", "tableName", "tableOrderId", "tableOpenedAt"} <= set(dumped)

    @pytest.mark.parametrize("kw", [{"table": "12"}, {"q": "ש12"}, {"q": "ש 12"}, {"q": "שולחן 12"}, {"q": "t12"}])
    def test_table_12_both_orders_of_the_day_and_nothing_else(self, day, kw):
        rows = _shop(day, **kw)
        assert set(rows) == {"100", "101", "102", "103", "108"}       # not 112, not the other shop's 107
        assert {r.table_order_id for r in rows.values()} == {str(day.first.id), str(day.second.id)}
        assert all(r.matched_by == ["table"] for r in rows.values())

    def test_the_restored_tables_label(self, day):
        rows = _shop(day, q="ש-12")
        # "ש-12" is table 12 and the restored table named "ש-12" (number 9012).
        assert set(rows) == {"100", "101", "102", "103", "108", "104"}
        assert rows["104"].table_name == "ש-12"
        assert set(_shop(day, table="ש-12")) == set(rows)

    def test_a_tables_name_alongside_the_usual_search(self, day):
        rows = _shop(day, q="VIP 1")
        assert set(rows) == {"105"} and rows["105"].matched_by == ["table"]
        assert set(_shop(day, q="בר 3")) == {"106"}
        assert set(_shop(day, table="vip")) == {"105"}

    def test_digits_without_the_chip_stay_the_document_and_amount_search(self, day):
        rows = _shop(day, q="112")
        assert set(rows) == {"112"} and rows["112"].matched_by == ["document"]

    def test_the_explicit_form_finds_a_name_as_a_whole(self, day):
        day.add_order(day.shop, 9112, "ש-12 (2)", 30, day.add_doc("120", day.tills[0], "7.00", 8))
        day.add_order(day.shop, 9120, "ש-120", 30, day.add_doc("121", day.tills[0], "8.00", 7))
        day.add_order(day.shop, 10, "שולחן 10", 30, day.add_doc("122", day.tills[0], "9.00", 6))
        day.db.commit()
        assert set(_shop(day, q="ש-12")) == {"100", "101", "102", "103", "108", "104", "120"}   # not ש-120's
        assert set(_shop(day, table="ש-12")) == {"100", "101", "102", "103", "108", "104", "120"}
        assert "122" not in _shop(day, q="שולחן 1")
        assert set(_shop(day, q="שולחן 10")) == {"122"}

    def test_the_chip_and_the_search_together(self, day):
        assert set(_shop(day, table="12", q="103")) == {"103"}


class TestTheDashboardsList:
    def _list(self, w, **kw):
        out = TR.list_transactions(
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, page=1, page_size=200,
            from_date=(w.now - timedelta(days=1)).date(), to_date=(w.now + timedelta(days=1)).date(), **kw,
        )
        return {i.transaction_number: i for i in out.items}

    def test_the_table_filter(self, day):
        rows = self._list(day, table="12", shop_id=day.shop.id)
        assert set(rows) == {"100", "101", "102", "103", "108"}
        assert {r.table_order_id for r in rows.values()} == {str(day.first.id), str(day.second.id)}
        assert all(r.matched_by == ["table"] for r in rows.values())
        # Over the whole tenant: the other shop's table 12 too, with its own table.
        everywhere = self._list(day, table="12")
        assert set(everywhere) == {"100", "101", "102", "103", "108", "107"}
        assert everywhere["107"].table_number == 12

    def test_the_search_box(self, day):
        assert set(self._list(day, q="ש12", shop_id=day.shop.id)) == {"100", "101", "102", "103", "108"}
        rows = self._list(day, q="VIP 1")
        assert set(rows) == {"105"} and rows["105"].matched_by == ["table"]
        assert set(self._list(day, q="112")) == {"112"}

    def test_the_explicit_form_finds_a_name_as_a_whole(self, day):
        day.add_order(day.shop, 9112, "ש-12 (2)", 30, day.add_doc("120", day.tills[0], "7.00", 8))
        day.add_order(day.shop, 9120, "ש-120", 30, day.add_doc("121", day.tills[0], "8.00", 7))
        day.add_order(day.shop, 10, "שולחן 10", 30, day.add_doc("122", day.tills[0], "9.00", 6))
        day.db.commit()
        found = self._list(day, q="ש-12", shop_id=day.shop.id)
        assert "120" in found and "121" not in found
        assert "122" not in self._list(day, q="שולחן 1", shop_id=day.shop.id)
        assert set(self._list(day, table="שולחן 10", shop_id=day.shop.id)) == {"122"}

    def test_every_row_says_its_table(self, day):
        rows = self._list(day)
        assert (rows["104"].table_number, rows["104"].table_name) == (9012, "ש-12")
        assert rows["104"].model_dump(by_alias=True)["tableOpenedAt"] == day.restored.opened_at.isoformat()
        assert rows["112"].table_number is None and rows["112"].matched_by is None

    def test_the_export_takes_the_filter(self, day):
        out = TR.export_transactions(
            current_user=day.admin, active_tenant_id=day.tenant.id, db=day.db, table="12", shop_id=day.shop.id,
            from_date=(day.now - timedelta(days=1)).date(), to_date=(day.now + timedelta(days=1)).date(),
        )
        assert out["total"] == 5
