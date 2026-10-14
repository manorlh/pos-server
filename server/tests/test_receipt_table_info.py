"""
"מספר שולחן על החשבונית" (P:/specs/receipt-table-number.md; app/services/receipt_table_info.py).

* `receiptTableInfo` is built in, empty by default (no line, as before), stored as the till reads it
  (table / zone / guests / waiter in the line's order, or `none`); anything else is refused on every route.
* The line — "שולחן 12 · גן · 4 סועדים · מלצר: דנה" — by every combination of the list, pinned by the
  fixture shared byte for byte with pos-android (receipt_table_line_cases.json).
* The till design's "שולחנות ומפה" card edits it per level (`/till-design/table-display`).
* The cloud's copy of a document (`GET /transactions/{id}/print-document?kind=invoice`) carries the line
  under its title for a table's document — its sale, a part paid on its own, a credit note of either —
  and none for a quick sale, or while the list is empty.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.till_parameter import TillParameter
from app.routers import till_design as R
from app.routers.transactions import get_print_document
from app.services import receipt_table_info as RT
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

FIXTURE = Path(__file__).parent / "fixtures" / "receipt_table_line_cases.json"
#: The LF-normalised SHA-256 of the fixture — pos-android's ReceiptTableInfoTest pins the same.
FIXTURE_SHA256 = "fa5e72fd3eb1b8e7202df857d3ede597bb84e3c6efa559420fac6edef64850d3"

ALL = "table,zone,guests,waiter"
LINE = "שולחן 12 · גן · 4 סועדים · מלצר: דנה"


def _cases() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8").replace("\r\n", "\n"))


def _facts(raw):
    return None if raw is None else RT.TableFacts(**raw)


# ── The rule, as the till's ──────────────────────────────────────────────────────


def test_the_fixture_is_the_till_s_byte_for_byte():
    text = FIXTURE.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == FIXTURE_SHA256


def test_the_value_is_read_as_the_till_reads_it():
    for case in _cases()["parse"]:
        assert RT.parse_fields(case["value"]) == case["fields"], case


def test_every_combination_of_the_list_and_the_empty_one_prints_nothing():
    combos = _cases()["combinations"]
    assert len(combos) == 16
    for case in combos:
        assert RT.table_line(case["fields"], _facts(case["facts"])) == case["line"], case["fields"]
    assert RT.table_line([], _facts(combos[-1]["facts"])) is None


def test_the_named_cases():
    for case in _cases()["lines"]:
        assert RT.table_line(case["fields"], _facts(case["facts"])) == case["line"], case["name"]


# ── The parameter ───────────────────────────────────────────────────────────────


def test_built_in_empty_by_default_with_hebrew_words():
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == "receiptTableInfo")
    assert spec.value_type == "string" and spec.default_value is None and not spec.admin_only
    assert any("\u0590" <= ch <= "\u05ff" for ch in spec.label)
    assert all(code in spec.description for code in RT.FIELDS) and RT.NONE in spec.description


@pytest.mark.parametrize(
    "value, stored",
    [
        ("waiter, table", "table,waiter"),
        ("TABLE,Zone,guests,waiter", ALL),
        ("guests,guests", "guests"),
        ("", "none"),
        ("none", "none"),
    ],
)
def test_stored_as_the_till_reads_it(value, stored):
    assert TP.validate_keyed_value("receiptTableInfo", value) == stored


@pytest.mark.parametrize("value", ["table,bogus", "שולחן", "table;zone"])
def test_anything_else_is_refused(value):
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value("receiptTableInfo", value)


# ── The world: a table, its order, its documents ─────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **kw: None)
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


def _set(w, value, level="company", entity=None):
    param = w.db.query(TillParameter).filter(TillParameter.key == "receiptTableInfo").one()
    stored = None if value is None else TP.validate_keyed_value("receiptTableInfo", value)
    TP.write_value(w.db, param, level, (entity or w.company).id, stored, user=w.admin, now=w.tills[0].last_heartbeat_at)
    w.db.flush()


def _order(w, sale=None, *, number=12, name=None, guests=4, waiter="דנה", opener="יוסי", partials=()):
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="גן", layout="grid")
    w.db.add(zone)
    w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number)
    w.db.add(table)
    w.db.flush()
    extras = {"sent": {}, "notes": {}}
    if partials:
        extras["partials"] = [{"tx": str(p.id), "no": p.transaction_number, "amount": 5000} for p in partials]
    order = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=zone.id,
        table_number=number, table_name=name, status="paid", source="synced", total=Decimal("120.00"),
        guests=guests, opened_by_pos_user_name=opener, waiter_pos_user_name=waiter,
        transaction_id=str(sale.id) if sale is not None else None, extras_json=json.dumps(extras),
        opened_at=w.tills[0].last_heartbeat_at,
    )
    w.db.add(order)
    w.db.flush()
    return order


def _copy(w, tx):
    doc = get_print_document(
        transaction_id=tx.id, kind="invoice", payment_id=None,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return doc


def _credit_of(w, original):
    credit = w.doc(w.tills[0], None, "50.00", credit_note=True)
    credit.refund_of_transaction_id = original.id
    w.db.flush()
    return credit


def test_the_table_s_invoice_copy_says_which_table_under_its_title(w):
    _set(w, ALL)
    sale = w.doc(w.tills[0], None, "120.00")
    _order(w, sale)
    doc = _copy(w, sale)
    assert doc.table_line == LINE
    assert doc.model_dump(by_alias=True)["tableLine"] == LINE


def test_a_part_paid_on_its_own_and_the_credit_notes_of_both(w):
    _set(w, ALL)
    part = w.doc(w.tills[0], None, "50.00")
    sale = w.doc(w.tills[0], None, "70.00")
    _order(w, sale, partials=[part])
    assert _copy(w, part).table_line == LINE
    assert _copy(w, _credit_of(w, sale)).table_line == LINE
    assert _copy(w, _credit_of(w, part)).table_line == LINE


def test_a_quick_sale_has_no_line(w):
    _set(w, ALL)
    _order(w, w.doc(w.tills[0], None, "120.00"))  # someone else's table
    quick = w.doc(w.tills[0], None, "30.00")
    assert _copy(w, quick).table_line is None
    assert _copy(w, _credit_of(w, quick)).table_line is None


def test_nothing_asked_no_line_as_before(w):
    sale = w.doc(w.tills[0], None, "120.00")
    _order(w, sale)
    assert _copy(w, sale).table_line is None
    _set(w, "none")
    assert _copy(w, sale).table_line is None


def test_the_till_s_own_level_wins_and_the_line_follows_the_list(w):
    _set(w, ALL)
    _set(w, "waiter,table", level="machine", entity=w.tills[0])
    sale = w.doc(w.tills[0], None, "120.00")
    _order(w, sale, name="VIP 1", waiter=None, opener="יוסי")
    # No waiter handed over: whoever opened the table.
    assert _copy(w, sale).table_line == "שולחן 12 · VIP 1 · מלצר: יוסי"


def test_the_tills_get_it_in_their_parameters(w):
    from app.services.till_parameters import till_parameters_for_machine

    assert "receiptTableInfo" not in till_parameters_for_machine(w.db, w.tills[0]).parameters
    _set(w, "table,guests")
    assert till_parameters_for_machine(w.db, w.tills[0]).parameters["receiptTableInfo"] == "table,guests"


# ── The till design's card ───────────────────────────────────────────────────────


def test_the_till_design_card_edits_it_per_level(w):
    got = R.get_table_display(level="shop", scope_id=w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    by_key = {p["key"]: p for p in got["parameters"]}
    assert by_key["receiptTableInfo"]["group"] == "receiptTable"
    assert {"key": "receiptTable", "label": RT.TILL_DESIGN_GROUP_LABEL} in got["groups"]
    assert "receiptTableInfo" not in got["inherited"]  # empty by default
    out = R.put_table_display(
        body=R.TableDisplayIn(values={"receiptTableInfo": "guests, table"}), level="shop", scope_id=w.shop.id,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["own"]["receiptTableInfo"] == "table,guests"
    with pytest.raises(Exception) as refused:
        R.put_table_display(
            body=R.TableDisplayIn(values={"receiptTableInfo": "table,phone"}), level="shop", scope_id=w.shop.id,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
    assert getattr(refused.value, "status_code", None) == 422
