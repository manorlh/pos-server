"""
"דו״ח Z — גרסה 2" (app/services/z_sections.py): the owner's sections on every Z, presentation only.

* The golden fixture is shared with pos-android (`app/src/test/resources/`, the same bytes) and
  read by the dashboard's unit test: every case computes to its `expected` sections and to its
  paper `lines` — so the till's X and Z, the cloud Z and the dashboard print one thing.
* Reconciliation, on every case: the order types add up to the sales total, the card brands to
  the card payments plus the card tips, the employees to the payments and the tips.
* The owner's example through a real Z: the sections frozen on the Z and its till's section,
  the count hidden when counting is not required (and shown when it is), the print document in
  the owner's order — and nothing fiscal moved.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timezone
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.pos_user import PosUser
from app.models.shift import ShiftStatus
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.transaction import TransactionStatus
from app.models.transaction_item import TransactionItem
from app.routers import z_reports as zr_router
from app.schemas.shift import ShiftCloseIn
from app.services import till_parameters as TP
from app.services import z_print
from app.services import z_sections as Z
from app.services.shifts import apply_shift_close
from app.services.z_builder import build_z
from shift_world import NOW, accept_str_uuids, make_world

GOLDEN = Path(__file__).parent / "fixtures" / "z_report_v2_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: ZReportSectionsTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "799c6258a374311cfff0058cd968d13f46b2da552297edc9fc60f0f832d2f72c"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _cases():
    return json.loads(_text(GOLDEN))["cases"]


def _computed(case, by_name):
    if "merge" in case:
        return Z.merge(by_name[n] for n in case["merge"])
    i = case["input"]
    return Z.compute(
        i["documents"], drawer=i["drawer"], transmission=i["transmission"],
        show_employees=i["showEmployees"], count_required=i["countRequired"],
    )


def _all_computed():
    by_name = {}
    for case in _cases():
        by_name[case["name"]] = _computed(case, by_name)
    return by_name


# ── The shared fixture ─────────────────────────────────────────────────────────


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    assert _text(SIBLING) == _text(GOLDEN)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_case_computes_to_its_sections(case):
    assert _all_computed()[case["name"]] == case["expected"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_case_prints_its_lines(case):
    blocks = Z.lines(case["expected"], exempt=case.get("exempt", False))
    assert [[t, [[l, v, b] for l, v, b in rows]] for t, rows in blocks] == case["lines"]


def test_the_owners_example():
    s = _all_computed()["golden"]
    assert s["sales"]["total"] == "15.00"
    assert (s["vat"]["base"], s["vat"]["vat"]) == ("12.71", "2.29")
    pay = {r["method"]: r["amount"] for r in s["payments"]["rows"]}
    assert (pay["cash"], pay["card"]) == ("5.00", "10.00")
    assert s["tips"]["card"] == "10.00"
    assert s["receipts"]["total"] == "25.00"
    assert s["drawer"]["expected"] == "505.00"
    types = {r["type"]: (r["count"], r["total"]) for r in s["orderTypes"]["rows"]}
    assert types == {"tables": (1, "10.00"), "quick": (1, "5.00")}
    assert s["orderTypes"]["average"] == s["sold"]["average"] == "7.50"
    assert s["cardBrands"]["rows"] == [{"brand": "other", "count": 1, "sale": "10.00", "tip": "10.00", "amount": "20.00"}]
    # Counting not required, nothing counted: the count is not on the paper at all.
    assert s["drawer"]["showCount"] is False
    drawer = dict(Z.lines(s))[Z.LABELS_HE["drawer"]]
    assert [label for label, _v, _b in drawer] == ["קופה פותחת", "תקבולי מזומן כולל טיפ", "מזומן צפוי"]


# ── Reconciliation ─────────────────────────────────────────────────────────────


def _ag(v):
    return Z.agorot(v) or 0


@pytest.mark.parametrize("name", [c["name"] for c in _cases()])
def test_every_section_reconciles(name):
    s = _all_computed()[name]
    total = _ag(s["sales"]["total"])
    pay = {r["method"]: _ag(r["amount"]) for r in s["payments"]["rows"]}
    tips = s["tips"]
    card_tips = _ag(tips["card"]) - _ag(tips["cardRefunds"])
    cash_tips = _ag(tips["cash"]) - _ag(tips["cashRefunds"])

    assert _ag(s["payments"]["total"]) == sum(pay.values()) == total
    assert _ag(s["receipts"]["total"]) == total + _ag(tips["net"])
    # Order types add up to the sales total; their sales to the documents.
    assert sum(_ag(r["total"]) for r in s["orderTypes"]["rows"]) == _ag(s["orderTypes"]["total"]) == total
    assert sum(r["count"] for r in s["orderTypes"]["rows"]) == s["sold"]["documents"]
    # Card brands add up to the card payments plus the card tips.
    brands = s["cardBrands"]
    assert sum(_ag(r["sale"]) for r in brands["rows"]) == _ag(brands["sale"]) == pay.get("card", 0)
    assert sum(_ag(r["tip"]) for r in brands["rows"]) == _ag(brands["tip"]) == card_tips
    assert sum(_ag(r["amount"]) for r in brands["rows"]) == _ag(brands["amount"]) == pay.get("card", 0) + card_tips
    # Employees add up to the payments and the tips.
    if s["employees"] is not None:
        rows = s["employees"]
        assert sum(_ag(e["cash"]) for e in rows) == pay.get("cash", 0)
        assert sum(_ag(e["card"]) for e in rows) == pay.get("card", 0)
        assert sum(_ag(e["other"]) for e in rows) == total - pay.get("cash", 0) - pay.get("card", 0)
        assert sum(_ag(e["cashTip"]) for e in rows) == cash_tips
        assert sum(_ag(e["cardTip"]) for e in rows) == card_tips
        assert sum(_ag(e["total"]) for e in rows) == _ag(s["receipts"]["total"])
    if s["vat"]["known"]:
        assert _ag(s["vat"]["base"]) + _ag(s["vat"]["vat"]) == _ag(s["vat"]["total"]) == total
    if s["drawer"] is not None:
        assert _ag(s["drawer"]["cashReceipts"]) == pay.get("cash", 0) + cash_tips
        # Every line of the drawer adds up to its expected cash ("Z — מזומן צפוי כולל הפקדות ותנועות
        # מזומן": with the parameter on a Z prints the movements too; off, it has none).
        d = s["drawer"]
        assert (
            _ag(d["opening"]) + _ag(d["cashReceipts"]) - _ag(d["tipsPaidFromDrawer"]) + _ag(d["betweenShifts"])
            + _ag(d["cashIn"]) - _ag(d["expenses"]) - _ag(d["safeDrop"])
        ) == _ag(d["expected"])


def test_the_z_drawer_on_and_off_cases_differ_only_in_the_movements():
    by_name = _all_computed()
    on = by_name["z drawer, parameter on: the movements are in the expected cash"]["drawer"]
    off = by_name["z drawer, parameter off: the same day, the deposit reads as a shortage"]["drawer"]
    # The same day, the same documents: the sales and the cash receipts do not move …
    assert on["cashReceipts"] == off["cashReceipts"] == "40.00"
    assert (on["opening"], off["opening"]) == ("100.00", "100.00")
    # … only the expected cash does, by the movements: +20 − 10 − 90.
    assert (on["expected"], off["expected"]) == ("60.00", "140.00")
    assert (on["cashIn"], on["expenses"], on["safeDrop"]) == ("20.00", "10.00", "90.00")
    assert (off["cashIn"], off["expenses"], off["safeDrop"]) == (None, None, None)
    # The count (60) is what the till held: right against the one, an 80 shortage against the other.
    assert (on["gap"], off["gap"]) == ("0.00", "-80.00")
    # Nothing but the drawer differs: the sales, the VAT, the payments and the receipts are one story.
    a = by_name["z drawer, parameter on: the movements are in the expected cash"]
    b = by_name["z drawer, parameter off: the same day, the deposit reads as a shortage"]
    assert {k: v for k, v in a.items() if k != "drawer"} == {k: v for k, v in b.items() if k != "drawer"}


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_line_fits_58mm_paper(case):
    for title, rows in case["lines"]:
        assert len(title) <= 32, title
        for label, value, _bold in rows:
            assert len(label) <= z_print.LABEL_MAX, label
            # 384 dots at the paper's type: a label and its value side by side.
            assert len(label) + len(value) <= 36, (label, value)


def test_the_terminal_shows_its_last_four_digits_only():
    assert Z.mask_terminal("0881234567") == "****4567"
    assert Z.mask_terminal(" 088 123 4567 ") == "****4567"
    assert Z.mask_terminal(None) is None and Z.mask_terminal("  ") is None
    busy = _all_computed()["busy"]
    raw = json.dumps(busy)
    assert "0881234567" not in raw and "088 123 4567" not in raw and "12345678" not in raw


def test_rates_and_units():
    assert Z.rate_key("0.18") == Z.rate_key("18") == Z.rate_key(Decimal("18.0000")) == "18"
    assert Z.rate_key("0.175") == "17.5" and Z.rate_key(None) is None and Z.rate_key("0") == "0"
    assert Z.units_text(2000) == "2" and Z.units_text(10500) == "10.5" and Z.units_text(0) == "0"


def test_a_merge_of_nothing_is_none():
    assert Z.merge([]) is None and Z.merge([None, {"version": 99}]) is None


# ── The parameter ──────────────────────────────────────────────────────────────


def test_the_per_employee_parameter_is_built_in_off():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == Z.SHOW_PER_EMPLOYEE_KEY]
    assert spec.value_type == "boolean" and spec.default_value is False
    assert "עובד" in spec.label and spec.description


# ── A real Z ───────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    return world


def _pos_user(w, first):
    pu = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=first, first_name=first,
                 pin_hash="x", role="cashier", is_active=True)
    w.db.add(pu)
    w.db.flush()
    return pu


def _item(w, tx, quantity="1"):
    w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=tx.id, product_name="x", quantity=Decimal(quantity),
                             unit_price=tx.total_amount, total_price=tx.total_amount))
    w.db.flush()


def _set_param(w, till, key, value, value_type="boolean"):
    p = w.db.query(TillParameter).filter(TillParameter.key == key).first()
    if p is None:
        p = TillParameter(id=uuid.uuid4(), key=key, label=key, value_type=value_type, default_value=False, is_active=True)
        w.db.add(p)
        w.db.flush()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=p.id, scope_type="machine", scope_id=till.id, value=value))
    w.db.flush()


def _owners_day(w, *, counted=None):
    """The owner's example on Till 1: cola by card at waiter A's table, ice pop in cash by cashier B."""
    till = w.tills[0]
    waiter, cashier = _pos_user(w, "מלצר א"), _pos_user(w, "קופאי ב")
    shift = w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="500.00")
    cola = w.doc(till, shift, "10.00", method="card", tip="10.00", tip_method="card", vat="1.53")
    pop = w.doc(till, shift, "5.00", method="cash", vat="0.76")
    cola.vat_rate = pop.vat_rate = Decimal("0.18")
    cola.cashier_id, pop.cashier_id = str(waiter.id), str(cashier.id)
    _item(w, cola)
    _item(w, pop)
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם", layout="grid")
    w.db.add(zone)
    w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=4)
    w.db.add(table)
    w.db.flush()
    w.db.add(TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, table_number=4,
        status="paid", source="synced", total=Decimal("10.00"), guests=2, opened_at=NOW,
        opened_by_pos_user_id=str(waiter.id), opened_by_pos_user_name="מלצר א",
        waiter_pos_user_id=str(waiter.id), waiter_pos_user_name="מלצר א", transaction_id=str(cola.id),
    ))
    w.db.flush()
    body = {"closedAt": NOW.isoformat()}
    if counted is not None:
        body["countedCash"] = counted
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return till, shift


def _golden_expected():
    return next(c for c in _cases() if c["name"] == "golden")["expected"]


class TestTheOwnersExampleThroughAZ:
    def test_frozen_on_the_z_and_its_section_as_the_fixture_says(self, w):
        till, shift = _owners_day(w)
        _set_param(w, till, Z.SHOW_PER_EMPLOYEE_KEY, True)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        whole = z.header["reportSections"]
        golden = _golden_expected()
        for key in ("sales", "vat", "payments", "tips", "receipts", "drawer", "sold", "orderTypes", "cardBrands"):
            assert whole[key] == golden[key], key
        assert [(e["name"], e["total"]) for e in whole["employees"]] == [("מלצר א", "20.00"), ("קופאי ב", "5.00")]
        assert z.per_machine[0]["reportSections"] == whole
        # Presentation only: the Z's own figures are what they always were.
        assert (z.total_sales, z.total_cash_sales, z.total_card_sales) == (Decimal("15.00"), Decimal("5.00"), Decimal("10.00"))
        assert (z.total_card_tips, z.vat_total, z.expected_cash) == (Decimal("10.00"), Decimal("2.29"), Decimal("505.00"))

    def test_without_the_parameter_there_is_no_employee_section(self, w):
        till, shift = _owners_day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert z.header["reportSections"]["employees"] is None
        titles = [s["title"] for s in z_print.build_print_document(z, timezone.utc)["sections"]]
        assert Z.LABELS_HE["employees"] not in titles

    def test_the_print_document_in_the_owners_order(self, w):
        till, shift = _owners_day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        doc = z_print.build_print_document(z, timezone.utc)
        titles = [s["title"] for s in doc["sections"]]
        L = Z.LABELS_HE
        owner = ["פרטי התקופה", L["sales"], L["vat"], L["payments"], L["tips"], L["receipts"], L["drawer"]]
        assert titles[: len(owner)] == owner
        assert titles.index(L["sold"]) > titles.index(L["drawer"])
        assert L["orderTypes"] in titles and L["cardBrands"] in titles
        drawer = next(s for s in doc["sections"] if s["title"] == L["drawer"])
        labels = [r["label"] for r in drawer["rows"]]
        assert "מזומן שנספר" not in labels and "פער" not in labels
        assert {r["label"]: r["value"] for r in drawer["rows"]}["מזומן צפוי"] == "₪505.00"
        # The till's own part prints the same blocks.
        part = z_print.build_till_document(z, till.id, timezone.utc)
        assert [s["title"] for s in part["sections"]][1:7] == owner[1:]

    def test_counting_required_shows_the_count_even_when_none_was_made(self, w):
        till, shift = _owners_day(w)
        _set_param(w, till, Z.BLIND_COUNT_KEY, True)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        d = z.header["reportSections"]["drawer"]
        assert (d["countRequired"], d["showCount"], d["counted"], d["gap"]) == (True, True, None, None)
        rows = dict((l, v) for l, v, _b in dict(Z.lines(z.header["reportSections"]))[Z.LABELS_HE["drawer"]])
        assert rows["מזומן שנספר"] == "לא נספר" and rows["פער"] == "לא חושב"

    def test_a_count_made_anyway_is_shown(self, w):
        till, shift = _owners_day(w, counted="503.00")
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        d = z.header["reportSections"]["drawer"]
        assert (d["countRequired"], d["showCount"], d["counted"], d["gap"]) == (False, True, "503.00", "-2.00")

    def test_the_dashboard_detail_carries_them(self, w):
        till, shift = _owners_day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        out = zr_router.z_detail_out(w.db, z).model_dump(by_alias=True, mode="json")
        assert out["reportSectionsSource"] == "stored"
        assert out["reportSections"]["sales"]["total"] == "15.00"

    def test_a_z_built_before_them_reads_them_from_its_documents_and_prints_as_before(self, w):
        till, shift = _owners_day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        z.header = {k: v for k, v in z.header.items() if k != "reportSections"}
        z.per_machine = [{k: v for k, v in s.items() if k != "reportSections"} for s in z.per_machine]
        w.db.flush()
        out = zr_router.z_detail_out(w.db, z).model_dump(by_alias=True, mode="json")
        assert out["reportSectionsSource"] == "documents"
        assert out["reportSections"]["receipts"]["total"] == "25.00"
        titles = [s["title"] for s in z_print.build_print_document(z, timezone.utc)["sections"]]
        assert titles[:3] == ["תקופה", "מכירות", "מע״מ"]

    def test_a_failure_leaves_the_z_without_them_never_without_a_z(self, w, monkeypatch):
        till, shift = _owners_day(w)

        def boom(*_a, **_k):
            raise RuntimeError("presentation bug")

        monkeypatch.setattr(Z, "document_facts", boom)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert z.total_sales == Decimal("15.00")
        assert "reportSections" not in z.header and "reportSections" not in z.per_machine[0]


class TestABusyZReconcilesWithItsOwnFigures:
    def test_the_sections_add_up_to_the_zs_columns(self, w):
        from app.models.transaction_payment import TransactionPayment

        till = w.tills[0]
        _set_param(w, till, Z.SHOW_PER_EMPLOYEE_KEY, True)
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="200.00")
        card = w.doc(till, shift, "100.00", method="card", tip="12.00", tip_method="card", vat="15.25")
        split = w.doc(till, shift, "50.00", method="card", legs=[("cash", "30.00"), ("card", "20.00")], vat="7.63")
        w.doc(till, shift, "15.00", method="cash", credit_note=True, vat="2.29")
        w.doc(till, shift, "50.00", discount="5.00", method="cash", vat="6.86")
        w.doc(till, shift, "40.00", method="cash", status=TransactionStatus.CANCELLED)
        for tx, brand in ((card, "visa"), (split, "mastercard")):
            for leg in w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id):
                if leg.method == "card":
                    leg.card_brand = brand
        w.db.flush()
        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        s = z.header["reportSections"]

        def d(v):
            return Decimal(str(v))

        assert d(s["sales"]["total"]) == z.total_sales - z.total_refunds
        assert d(s["sales"]["gross"]) == z.total_sales + z.discounts_total
        pay = {r["method"]: d(r["amount"]) for r in s["payments"]["rows"]}
        assert (pay["cash"], pay["card"]) == (z.total_cash_sales, z.total_card_sales)
        assert d(s["tips"]["card"]) == z.total_card_tips and d(s["tips"]["cash"]) == z.total_cash_tips
        assert d(s["vat"]["vat"]) == z.vat_total
        assert sum(d(r["total"]) for r in s["orderTypes"]["rows"]) == z.total_sales - z.total_refunds
        assert sum(d(r["amount"]) for r in s["cardBrands"]["rows"]) == z.total_card_sales + z.total_card_tips
        assert {r["brand"] for r in s["cardBrands"]["rows"]} == {"visa", "mastercard"}
        assert sum(d(e["cash"]) for e in s["employees"]) == z.total_cash_sales
        assert sum(d(e["card"]) for e in s["employees"]) == z.total_card_sales
        assert sum(d(e["cardTip"]) for e in s["employees"]) == z.total_card_tips
        assert d(s["drawer"]["expected"]) == z.expected_cash
        assert s["sold"]["documents"] == 3


class TestALocalShopZKeepsThemAsPrinted:
    def test_the_printed_sections_are_the_ones_stored(self, w):
        from app.services.local_shop_z import LocalShopZIn, apply_printed
        from app.models.z_report import ZOrigin, ZReport

        till = w.tills[0]
        golden = _golden_expected()
        z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, origin=ZOrigin.CLOUD,
                    business_date=NOW.date(), closed_at=NOW, header={"businessName": "Acme"}, shop_sequence_number=1)
        body = LocalShopZIn.model_validate({
            "id": str(z.id), "clientRequestId": str(uuid.uuid4()), "shopSequenceNumber": 1, "closedAt": NOW.isoformat(),
            "report": {"gross": "15.00", "transactions": 2, "reportSections": golden},
            "tills": [{"machineId": str(till.id), "shiftIds": [str(uuid.uuid4())], "report": {"reportSections": golden}}],
        })
        apply_printed(z, body, till)
        assert z.header["reportSections"] == golden
        assert z.per_machine[0]["reportSections"] == golden
        assert z_print.report_sections_of(z) == golden
