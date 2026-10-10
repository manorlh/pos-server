"""
"Z — מזומן צפוי כולל הפקדות ותנועות מזומן" (the owner, 10.10.2026; app/services/z_expected_cash.py).

The till's X reckons the drawer with the shift's Cash In / Cash Out and safe deposits; the Z's
"מזומן צפוי" did not, so a deposit showed as a shortage in the Z's over/short. The till parameter
`cashDrawer.zExpectedCashMovements` (company → shop → area → till, **off** by default) makes the
Z do what the X does.

* **The rule, once per language**: `tests/fixtures/z_expected_cash_golden.json` — the same bytes
  as pos-android's `ZExpectedCashTest`, both pin its SHA-256; every case computes to the figures
  worked out by hand in its `about`.
* **Off is today, byte for byte**: no new key on the Z's header or sections, the expected cash and
  over/short as they always were — even when the closes carried the movements.
* **On**: the expected cash, the over/short, the `cashMovements` blocks (section and header), the
  owner's sections and the paper's drawer block all say the same thing; nothing fiscal moves.
* **Resolved per till** (till › area › shop › company › off) at the moment the Z is produced, and
  never again: a Z already produced keeps what it froze — a reprint, the detail and the day report
  read the Z, not the parameter. A kiosk never applies it.
* **A Z a till made itself** (closed with no connection; its part of a LAN shop Z) is stored as
  the till printed it: built with the value the till declared on its paper.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models.pos_machine import set_kiosk_cache
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.z_report import ZReport
from app.routers import z_reports as zr_router
from app.schemas.shift import ShiftCloseIn
from app.services import cash_drawer as CD
from app.services import local_shop_z as LZ
from app.services import z_expected_cash as ZEC
from app.services import z_print
from app.services import z_sections
from app.services.shifts import apply_shift_close
from app.services.till_parameters import BUILTIN_PARAMETERS, ensure_builtin_parameters
from app.services.z_builder import build_z, till_cash_summary, z_cash_summary
from shift_world import NOW, accept_str_uuids, make_world
from test_z_print_document import _tz
from test_till_z import w as till_z_world  # noqa: F401  (a world with a till in zMode = till)

GOLDEN = Path(__file__).parent / "fixtures" / "z_expected_cash_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: ZExpectedCashTest. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "e92f104749585a1eb43dfdff39d4832e77e4991999e0c0fd56cf2d56c2268ef0"
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


# ── The shared fixture: the rule, once per language ──────────────────────────────


def _d(value):
    return None if value is None else Decimal(value)


def _shift_of(i):
    till = {}
    if i["cardTipsFromDrawer"] is not None:
        till["cardTipsFromDrawer"] = float(i["cardTipsFromDrawer"])
    for key in ("cashIn", "cashOut", "deposits"):
        if i[key] is not None:
            till[key] = float(i[key])
    return SimpleNamespace(
        opening_cash=_d(i["opening"]), total_cash=_d(i["cash"]), total_cash_tips=_d(i["cashTips"]),
        counted_cash=_d(i["counted"]), till_totals=till or None,
    )


def _money(value):
    return None if value is None else str(Decimal(value).quantize(Decimal("0.01")))


def _drawer_of(summary):
    return {
        "opening": _money(summary["opening"]),
        "expected": _money(summary["expected"]),
        "counted": _money(summary["counted"]),
        "overShort": _money(summary["over_short"]),
        "betweenShifts": _money(summary["between_shifts"]),
        "cashMovements": None if summary["cash_movements"] is None else ZEC.block(summary["cash_movements"]),
    }


def _computed(case):
    per_till = [[_shift_of(i) for i in t["shifts"]] for t in case["tills"]]
    flags = [t["withMovements"] for t in case["tills"]]
    return {
        "tills": [_drawer_of(till_cash_summary(shifts, flag)) for shifts, flag in zip(per_till, flags)],
        "z": _drawer_of(z_cash_summary(per_till, flags)),
    }


def _cases():
    return json.loads(_text(GOLDEN))["cases"]


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    assert _text(SIBLING) == _text(GOLDEN)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_case_computes_to_its_figures(case):
    assert _computed(case) == case["expected"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_case_reconciles(case):
    """With every shift counted: counted − expected is the over/short, exactly (docs/SHIFTS_API.md §3.6)."""
    for t, out in zip(case["tills"], case["expected"]["tills"]):
        if any(i["counted"] is None for i in t["shifts"]):
            assert out["overShort"] is None
        else:
            assert Decimal(out["counted"]) - Decimal(out["expected"]) == Decimal(out["overShort"])


def test_the_golden_has_the_on_and_the_off_cases():
    flags = {t["withMovements"] for c in _cases() for t in c["tills"]}
    assert flags == {True, False}


# ── What is frozen on a close, and read from it ──────────────────────────────────


class TestTheClosesFigures:
    def test_the_three_keys_as_amounts(self):
        assert ZEC.movements_of_till({"cashIn": 30, "cashOut": 20.5, "deposits": "150"}) == (
            Decimal("30.00"), Decimal("20.50"), Decimal("150.00"),
        )

    def test_absent_is_none(self):
        assert ZEC.movements_of_till(None) == ZEC.NONE
        assert ZEC.movements_of_till({}) == ZEC.NONE
        assert ZEC.movements_of(SimpleNamespace(till_totals=None)) == ZEC.NONE

    @pytest.mark.parametrize("junk", ["ten", True, False, -5, None, "NaN", "Infinity", [], {}])
    def test_what_is_not_an_amount_is_no_claim(self, junk):
        assert ZEC.movements_of_till({"cashIn": junk, "cashOut": junk, "deposits": junk}) == ZEC.NONE

    def test_the_net_adds_cash_in_and_takes_off_the_rest(self):
        assert ZEC.net((Decimal("30"), Decimal("20"), Decimal("150"))) == Decimal("-140")

    def test_the_block_round_trips(self):
        moved = (Decimal("30"), Decimal("0"), Decimal("150.5"))
        assert ZEC.block(moved) == {"cashIn": "30.00", "cashOut": "0.00", "deposits": "150.50"}
        assert ZEC.movements_of_block(ZEC.block(moved)) == (Decimal("30.00"), Decimal("0.00"), Decimal("150.50"))
        assert ZEC.movements_of_block(None) is None and ZEC.movements_of_block("x") is None


# ── The parameter ─────────────────────────────────────────────────────────────


class TestTheParameter:
    def test_built_in_off_by_default_with_its_hebrew_label_and_help(self):
        spec = next(p for p in BUILTIN_PARAMETERS if p.key == "cashDrawer.zExpectedCashMovements")
        assert spec.value_type == "boolean" and spec.default_value is False
        assert spec.label == "Z — מזומן צפוי כולל הפקדות ותנועות מזומן"
        for word in ("הפקדה / ריקון חלקי", "הכנסת מזומן", "הוצאת מזומן", "X", "ברירת המחדל: כבוי", "קיוסק", "לא משתנים"):
            assert word in spec.description, word
        assert CD.Z_EXPECTED_CASH_MOVEMENTS_KEY == ZEC.KEY in CD.LEVEL_KEYS

    def test_it_is_in_the_drawers_level_editor_company_to_till(self):
        assert CD.SCOPE_TYPES == ("company", "shop", "area", "machine")


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


def _set(w, scope, scope_id, value):
    param = w.db.query(TillParameter).filter(TillParameter.key == ZEC.KEY).one()
    row = (
        w.db.query(TillParameterValue)
        .filter_by(parameter_id=param.id, scope_type=scope, scope_id=scope_id)
        .first()
    )
    if row is None:
        w.db.add(TillParameterValue(parameter_id=param.id, scope_type=scope, scope_id=scope_id, value=value))
    else:
        row.value = value
    w.db.flush()


class TestResolvedLikeEveryTillParameter:
    def test_off_with_no_value_anywhere(self, w):
        assert ZEC.applies(w.db, w.tills[0]) is False

    def test_a_company_value_reaches_every_till(self, w):
        _set(w, "company", w.company.id, True)
        assert [ZEC.applies(w.db, t) for t in w.tills + [w.other_till]] == [True, True, True]

    def test_company_then_shop_then_area_then_till(self, w):
        till = w.tills[0]
        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(area)
        w.db.flush()
        till.area_id = area.id
        w.db.flush()
        _set(w, "company", w.company.id, True)
        assert ZEC.applies(w.db, till) is True
        _set(w, "shop", w.shop.id, False)           # the shop is nearer than the company
        assert ZEC.applies(w.db, till) is False
        assert ZEC.applies(w.db, w.other_till) is True  # another shop keeps the company's
        _set(w, "area", area.id, True)              # the area is nearer than the shop
        assert ZEC.applies(w.db, till) is True
        assert ZEC.applies(w.db, w.tills[1]) is False   # not in the area: the shop's
        _set(w, "machine", till.id, False)          # the till itself is nearest
        assert ZEC.applies(w.db, till) is False

    def test_a_kiosk_never_applies_it(self, w):
        _set(w, "company", w.company.id, True)
        kiosk = w.tills[0]
        set_kiosk_cache(kiosk, True)
        assert ZEC.applies(w.db, kiosk) is False
        assert ZEC.applies(w.db, w.tills[1]) is True

    def test_not_registered_yet_is_off(self, w):
        _set(w, "company", w.company.id, True)
        w.db.query(TillParameterValue).delete()
        w.db.query(TillParameter).filter(TillParameter.key == ZEC.KEY).delete()
        w.db.flush()
        assert ZEC.applies(w.db, w.tills[0]) is False


# ── A real Z ───────────────────────────────────────────────────────────────────

#: A cash sale of 100 into a float of 200; the shift moved 30 in, 20 out and 150 to the safe.
SALE = [dict(total="100.00", method="cash")]
MOVED = {"cashIn": 30.0, "cashOut": 20.0, "deposits": 150.0}
FISCAL = (
    "total_sales", "total_refunds", "discounts_total", "total_cash_sales", "total_card_sales", "total_tips",
    "total_cash_tips", "total_card_tips", "vat_total", "transactions_count",
)


def _closed(w, till, seq, docs=SALE, *, opening="200.00", counted="160.00", figures=MOVED):
    """A shift closed the way a till closes it: its count and its own X figures."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    for spec in docs:
        w.doc(till, shift, **spec)
    body = {"closedAt": NOW.isoformat()}
    if counted is not None:
        body["countedCash"] = counted
    if figures is not None:
        body["till"] = figures
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return shift


def _z(w, *pairs, **kw):
    return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=list(pairs), **kw)


def _out(z):
    return zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")


class TestOffIsToday:
    def test_the_expected_cash_and_the_count_read_as_they_always_did(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))

        assert (z.opening_cash, z.expected_cash, z.actual_cash, z.discrepancy) == (
            Decimal("200.00"), Decimal("300.00"), Decimal("160.00"), Decimal("-140.00"),
        )
        section = z.per_machine[0]
        assert (section["expectedCash"], section["overShort"], section["betweenShiftAdjustments"]) == (
            "300.00", "-140.00", "0.00",
        )

    def test_no_new_key_anywhere_and_the_closes_figures_change_nothing(self, w):
        with_figures, without = w.tills
        z_with = _z(w, (with_figures, _closed(w, with_figures, 1).id))
        z_without = _z(w, (without, _closed(w, without, 1, figures=None).id))

        for z in (z_with, z_without):
            assert ZEC.BLOCK not in z.header
            assert ZEC.BLOCK not in z.per_machine[0]
            assert z_print.cash_movements_of(z) is None
            assert _out(z)["cashMovements"] is None
        # The same Z, whether or not the closes carried the movements: the sections, the header
        # keys, the columns, the owner's drawer — byte for byte.
        identity = ("machineId", "machineName", "posNumber", "machineCode", "shiftIds", "firstDocumentNumber",
                    "lastDocumentNumber", "documentRanges", "transmission")
        a, b = ({k: v for k, v in z.per_machine[0].items() if k not in identity} for z in (z_with, z_without))
        assert a == b
        assert sorted(z_with.header) == sorted(z_without.header)
        assert [getattr(z_with, k) for k in FISCAL] == [getattr(z_without, k) for k in FISCAL]
        assert (z_with.expected_cash, z_with.actual_cash, z_with.discrepancy) == (
            z_without.expected_cash, z_without.actual_cash, z_without.discrepancy,
        )
        drawer = z_with.header["reportSections"]["drawer"]
        assert (drawer["cashIn"], drawer["expenses"], drawer["safeDrop"]) == (None, None, None)

    def test_the_paper_has_no_movement_lines(self, w):
        till = w.tills[0]
        doc = z_print.build_print_document(_z(w, (till, _closed(w, till, 1).id)), _tz())
        labels = [r["label"] for s in doc["sections"] for r in s["rows"]]
        for label in (z_print.CASH_IN_LABEL, z_print.CASH_OUT_LABEL, z_print.DEPOSIT_LABEL):
            assert label not in labels


class TestOn:
    @pytest.fixture(autouse=True)
    def _on(self, w):
        _set(w, "company", w.company.id, True)

    def test_the_deposit_and_the_movements_are_in_the_expected_cash(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))

        # 200 float + 100 cash + 30 in − 20 out − 150 deposited = 160: the count is no gap.
        assert (z.opening_cash, z.expected_cash, z.actual_cash, z.discrepancy) == (
            Decimal("200.00"), Decimal("160.00"), Decimal("160.00"), Decimal("0.00"),
        )
        section = z.per_machine[0]
        assert (section["expectedCash"], section["countedCash"], section["overShort"]) == ("160.00", "160.00", "0.00")
        assert section[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert z.header[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}

    def test_nothing_fiscal_moves(self, w):
        on, off = w.tills
        _set(w, "machine", off.id, False)
        z_on = _z(w, (on, _closed(w, on, 1).id))
        z_off = _z(w, (off, _closed(w, off, 1).id))

        assert [getattr(z_on, k) for k in FISCAL] == [getattr(z_off, k) for k in FISCAL]
        assert z_on.payment_breakdown == z_off.payment_breakdown
        assert z_on.shop_sequence_number == z_off.shop_sequence_number - 1  # numbered as ever
        for key in ("totalSales", "grossSales", "netSales", "totalCash", "totalCard", "vatTotal", "cashSalesNet",
                    "totalTips", "transactionsCount", "paymentBreakdown"):
            assert z_on.per_machine[0][key] == z_off.per_machine[0][key], key
        ranges = [[(r["documentType"], r["count"]) for r in z.per_machine[0]["documentRanges"]] for z in (z_on, z_off)]
        assert ranges[0] == ranges[1]
        assert (z_on.expected_cash, z_off.expected_cash) == (Decimal("160.00"), Decimal("300.00"))

    def test_the_owners_sections_have_the_lines_and_they_add_up(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))

        for drawer in (z.header["reportSections"]["drawer"], z.per_machine[0]["reportSections"]["drawer"]):
            assert (drawer["cashIn"], drawer["expenses"], drawer["safeDrop"]) == ("30.00", "20.00", "150.00")
            assert drawer["expected"] == "160.00" and drawer["gap"] == "0.00"
            assert (
                Decimal(drawer["opening"]) + Decimal(drawer["cashReceipts"]) + Decimal(drawer["cashIn"])
                - Decimal(drawer["expenses"]) - Decimal(drawer["safeDrop"]) + Decimal(drawer["betweenShifts"])
            ) == Decimal(drawer["expected"])
        blocks = dict(z_sections.lines(z.header["reportSections"]))
        labels = [label for label, _v, _b in blocks[z_sections.LABELS_HE["drawer"]]]
        assert labels[:5] == ["קופה פותחת", "תקבולי מזומן כולל טיפ", "הכנסות מזומן", "הוצאות", "הפקדה לכספת"]

    def test_the_detail_and_the_print_documents_say_it(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))

        assert _out(z)["cashMovements"] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert Decimal(_out(z)["expectedCash"]) == Decimal("160")
        assert z_print.cash_movements_of(z) == (Decimal("30.00"), Decimal("20.00"), Decimal("150.00"))

    def test_the_legacy_layout_prints_them_above_the_expected_cash(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))
        # A Z whose owner's sections could not be built prints the older drawer block.
        z.header = {k: v for k, v in z.header.items() if k != "reportSections"}
        z.per_machine = [{k: v for k, v in s.items() if k != "reportSections"} for s in z.per_machine]
        for doc in (z_print.build_print_document(z, _tz()), z_print.build_summary_document(z, _tz())):
            cash = [(r["label"], r["value"]) for s in doc["sections"] if s["title"] == "קופה" for r in s["rows"]]
            labels = [label for label, _v in cash]
            assert labels.index(z_print.CASH_IN_LABEL) < labels.index(z_print.CASH_OUT_LABEL) < labels.index(
                z_print.DEPOSIT_LABEL) < labels.index("מזומן צפוי")
            rows = dict(cash)
            assert rows[z_print.CASH_IN_LABEL] == "+₪30.00"
            assert rows[z_print.CASH_OUT_LABEL] == "-₪20.00"
            assert rows[z_print.DEPOSIT_LABEL] == "-₪150.00"
            assert rows["מזומן צפוי"] == "₪160.00"
        part = z_print.build_till_document(z, till.id, _tz())
        assert dict((r["label"], r["value"]) for s in part["sections"] for r in s["rows"])[z_print.DEPOSIT_LABEL] == "-₪150.00"

    def test_the_labels_fit_80mm(self):
        for label in (z_print.CASH_IN_LABEL, z_print.CASH_OUT_LABEL, z_print.DEPOSIT_LABEL):
            assert len(label) <= z_print.LABEL_MAX

    def test_a_zero_is_no_line(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1, figures={"deposits": 150.0}, counted="150.00").id))
        z.header = {k: v for k, v in z.header.items() if k != "reportSections"}
        z.per_machine = [{k: v for k, v in s.items() if k != "reportSections"} for s in z.per_machine]
        doc = z_print.build_print_document(z, _tz())
        labels = [r["label"] for s in doc["sections"] for r in s["rows"]]
        assert z_print.DEPOSIT_LABEL in labels
        assert z_print.CASH_IN_LABEL not in labels and z_print.CASH_OUT_LABEL not in labels
        assert z.expected_cash == Decimal("150.00") and z.discrepancy == Decimal("0.00")

    def test_a_close_without_the_figures_is_none_and_the_z_says_it_applied(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1, figures=None, counted="300.00").id))
        assert z.expected_cash == Decimal("300.00") and z.discrepancy == Decimal("0.00")
        assert z.per_machine[0][ZEC.BLOCK] == {"cashIn": "0.00", "cashOut": "0.00", "deposits": "0.00"}
        # Nothing moved, so no line is printed.
        labels = [r["label"] for s in z_print.build_print_document(z, _tz())["sections"] for r in s["rows"]]
        assert z_print.DEPOSIT_LABEL not in labels

    @pytest.mark.parametrize("junk", ["ten", True, -5, None, "NaN"])
    def test_what_is_not_an_amount_is_no_claim(self, w, junk):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1, figures={"deposits": junk}, counted="300.00").id))
        assert z.expected_cash == Decimal("300.00")

    def test_with_the_card_tips_paid_from_the_drawer_too(self, w):
        till = w.tills[0]
        shift = _closed(
            w, till, 1, [dict(total="50.00", method="cash")], opening="0.00", counted="45.00",
            figures={"cardTipsFromDrawer": 10.0, "cashIn": 5.0},
        )
        z = _z(w, (till, shift.id))
        # 0 + 50 − 10 + 5 = 45
        assert (z.expected_cash, z.discrepancy) == (Decimal("45.00"), Decimal("0.00"))
        assert z.per_machine[0]["cardTipsFromDrawer"] == "10.00"

    def test_back_to_back_shifts_with_the_deposit_in_the_first(self, w):
        till = w.tills[0]
        one = _closed(w, till, 1, [dict(total="80.00")], opening="100.00", counted="80.00", figures={"deposits": 100.0})
        two = _closed(w, till, 2, [dict(total="20.00")], opening="80.00", counted="100.00", figures=None)
        z = _z(w, (till, two.id))
        section = z.per_machine[0]
        assert (section["expectedCash"], section["overShort"], section["betweenShiftAdjustments"]) == (
            "100.00", "0.00", "0.00",
        )
        assert z.actual_cash - z.expected_cash == z.discrepancy == Decimal("0.00")
        assert section[ZEC.BLOCK]["deposits"] == "100.00"
        assert one.z_report_id == z.id

    def test_an_uncounted_shift_closes_at_its_expected_with_the_movements(self, w):
        till = w.tills[0]
        _closed(w, till, 1, [dict(total="50.00")], opening="100.00", counted=None, figures={"deposits": 100.0})
        two = _closed(w, till, 2, [dict(total="20.00")], opening="50.00", counted="70.00", figures=None)
        section = _z(w, (till, two.id)).per_machine[0]
        assert (section["expectedCash"], section["betweenShiftAdjustments"], section["overShort"]) == (
            "70.00", "0.00", None,
        )


class TestPerTillAndFrozenWhenProduced:
    def test_a_shop_z_holds_tills_on_both_sides(self, w):
        on, off = w.tills
        _set(w, "machine", on.id, True)
        a = _closed(w, on, 1)
        b = _closed(w, off, 1)
        z = _z(w, (on, a.id), (off, b.id))

        by_till = {s["machineId"]: s for s in z.per_machine}
        assert by_till[str(on.id)]["expectedCash"] == "160.00" and ZEC.BLOCK in by_till[str(on.id)]
        assert by_till[str(off.id)]["expectedCash"] == "300.00" and ZEC.BLOCK not in by_till[str(off.id)]
        assert z.expected_cash == Decimal("460.00") and z.actual_cash == Decimal("320.00")
        assert z.discrepancy == Decimal("-140.00")
        # The header sums the tills the parameter applied to.
        assert z.header[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        drawer = z.header["reportSections"]["drawer"]
        assert (drawer["cashIn"], drawer["expenses"], drawer["safeDrop"], drawer["expected"]) == (
            "30.00", "20.00", "150.00", "460.00",
        )

    def test_a_kiosk_never_gets_it(self, w):
        _set(w, "company", w.company.id, True)
        kiosk = w.tills[0]
        set_kiosk_cache(kiosk, True)
        z = _z(w, (kiosk, _closed(w, kiosk, 1).id))
        assert z.expected_cash == Decimal("300.00") and ZEC.BLOCK not in z.per_machine[0]
        assert ZEC.BLOCK not in z.header

    def test_a_z_made_with_it_on_keeps_it_whatever_the_parameter_says_later(self, w):
        till = w.tills[0]
        _set(w, "company", w.company.id, True)
        z = _z(w, (till, _closed(w, till, 1).id))
        before = (_out(z), z_print.build_print_document(z, _tz(), printed_at=NOW), z.expected_cash, z.discrepancy)

        _set(w, "company", w.company.id, False)
        _set(w, "machine", till.id, False)

        after = (_out(z), z_print.build_print_document(z, _tz(), printed_at=NOW), z.expected_cash, z.discrepancy)
        assert after == before
        assert z_sections.sections_of_z(w.db, z)[0] == z.header["reportSections"]

    def test_a_z_made_with_it_off_keeps_it_when_it_is_turned_on_after(self, w):
        till = w.tills[0]
        z = _z(w, (till, _closed(w, till, 1).id))
        before = (_out(z), z_print.build_print_document(z, _tz(), printed_at=NOW), z.expected_cash, z.discrepancy)

        _set(w, "company", w.company.id, True)

        assert (_out(z), z_print.build_print_document(z, _tz(), printed_at=NOW), z.expected_cash, z.discrepancy) == before
        assert z.expected_cash == Decimal("300.00") and ZEC.BLOCK not in z.header

    def test_the_next_z_after_it_is_turned_on_follows_it(self, w):
        till = w.tills[0]
        first = _z(w, (till, _closed(w, till, 1).id))
        _set(w, "company", w.company.id, True)
        second = _z(w, (till, _closed(w, till, 2).id))
        assert (first.expected_cash, second.expected_cash) == (Decimal("300.00"), Decimal("160.00"))
        assert ZEC.BLOCK not in first.header and ZEC.BLOCK in second.header

    def test_the_owners_sections_read_from_the_documents_use_the_frozen_value(self, w):
        # A Z built before its sections existed has them read from its documents now: with the
        # value its sections froze, never the parameter as it stands.
        till = w.tills[0]
        _set(w, "company", w.company.id, True)
        z = _z(w, (till, _closed(w, till, 1).id))
        frozen = z.header["reportSections"]
        z.header = {k: v for k, v in z.header.items() if k != "reportSections"}
        z.per_machine = [{k: v for k, v in s.items() if k != "reportSections"} for s in z.per_machine]
        _set(w, "company", w.company.id, False)
        sections, source = z_sections.sections_of_z(w.db, z)
        assert source == "documents"
        assert sections["drawer"] == frozen["drawer"]


class TestAnOfflineTillZ:
    """The paper the till printed is the Z: built with the value the till declared on it."""

    @pytest.fixture
    def tw(self, till_z_world):
        ensure_builtin_parameters(till_z_world.db)
        till_z_world.db.flush()
        return till_z_world

    def _upload(self, tw, report, *, figures=MOVED, expected_columns=None):
        from test_offline_till_z import TILL_FIGURES, offline_body, upload

        shift = _closed(tw, tw.till, 1, [dict(total="100.00", vat="15.25", number="11")], figures=figures)
        status, body = upload(
            tw, offline_body(shift, 1, till={**TILL_FIGURES, "totalSales": 100.0, "totalCard": 0.0,
                                             "totalCash": 100.0, "vatTotal": 15.25, "transactionsCount": 1},
                             report=report),
        )
        assert status == 201, body
        z = tw.db.query(ZReport).filter(ZReport.machine_id == tw.till.id).one()
        return z

    def test_a_paper_without_movements_is_built_without_them_though_the_parameter_is_on(self, tw):
        _set(tw, "company", tw.company.id, True)
        z = self._upload(tw, {"openingCash": "200.00", "expectedCash": "300.00", "countedCash": "160.00",
                              "overShort": "-140.00"})
        assert z.expected_cash == Decimal("300.00") and ZEC.BLOCK not in z.per_machine[0]
        assert ZEC.BLOCK not in z.header
        assert not [d for d in (z.offline_discrepancies or []) if str(d["key"]).startswith(("expectedCash", "cashMovements"))]

    def test_a_paper_with_movements_is_built_with_them_though_the_parameter_is_off(self, tw):
        z = self._upload(tw, {
            "openingCash": "200.00", "expectedCash": "160.00", "countedCash": "160.00", "overShort": "0.00",
            ZEC.BLOCK: {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"},
        })
        assert z.expected_cash == Decimal("160.00") and z.discrepancy == Decimal("0.00")
        assert z.per_machine[0][ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert z.header[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert not z.offline_discrepancies

    def test_a_paper_that_disagrees_about_the_movements_is_reported_not_overwritten(self, tw):
        z = self._upload(tw, {
            "openingCash": "200.00", "expectedCash": "160.00",
            ZEC.BLOCK: {"cashIn": "30.00", "cashOut": "20.00", "deposits": "100.00"},
        })
        keys = {d["key"] for d in z.offline_discrepancies or []}
        assert f"{ZEC.BLOCK}.deposits" in keys
        assert z.per_machine[0][ZEC.BLOCK]["deposits"] == "150.00"

    def test_no_paper_to_read_resolves_the_parameter(self, tw):
        _set(tw, "company", tw.company.id, True)
        z = self._upload(tw, None)
        assert z.expected_cash == Decimal("160.00") and ZEC.BLOCK in z.per_machine[0]

    def test_the_declared_value(self):
        from app.services.till_z import _declared_movements

        assert _declared_movements(None) is None and _declared_movements({}) is None
        assert _declared_movements({"expectedCash": "1.00"}) is False
        assert _declared_movements({ZEC.BLOCK: {"cashIn": "0.00"}}) is True
        assert _declared_movements({ZEC.BLOCK: "yes"}) is False


class TestALocalShopZKeptAsPrinted:
    """The main till's paper becomes the Z (`local_shop_z.apply_printed`): its drawer stays one story."""

    def _apply(self, w, report, *, parameter_on):
        till = w.tills[0]
        if parameter_on:
            _set(w, "company", w.company.id, True)
        shift = _closed(w, till, 1)
        z = _z(w, (till, shift.id))
        body = LZ.LocalShopZIn.model_validate({
            "id": str(uuid.uuid4()), "clientRequestId": str(uuid.uuid4()), "shopSequenceNumber": 1,
            "closedAt": NOW.isoformat(),
            "tills": [{"machineId": str(till.id), "shiftIds": [str(shift.id)], "report": report}],
        })
        LZ.apply_printed(z, body, till)
        return z, _out(z)

    DRAWER = {"openingCash": "200.00", "countedCash": "160.00"}

    def test_a_printed_block_is_the_header_block_and_the_expected_cash_is_as_printed(self, w):
        z, out = self._apply(
            w, {**self.DRAWER, "expectedCash": "160.00", "overShort": "0.00",
                ZEC.BLOCK: {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}},
            parameter_on=False,
        )
        assert z.expected_cash == Decimal("160.00")
        assert z.header[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert out["cashMovements"] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}

    def test_a_paper_without_it_has_none_though_the_cloud_would_have_built_it_on(self, w):
        z, out = self._apply(w, {**self.DRAWER, "expectedCash": "300.00", "overShort": "-140.00"}, parameter_on=True)
        assert z.expected_cash == Decimal("300.00")
        assert ZEC.BLOCK not in z.header and out["cashMovements"] is None

    def test_tills_on_both_sides_sum_the_ones_that_have_it(self, w):
        on, off = w.tills
        a, b = _closed(w, on, 1), _closed(w, off, 1)
        z = _z(w, (on, a.id), (off, b.id))
        body = LZ.LocalShopZIn.model_validate({
            "id": str(uuid.uuid4()), "clientRequestId": str(uuid.uuid4()), "shopSequenceNumber": 1,
            "closedAt": NOW.isoformat(),
            "tills": [
                {"machineId": str(on.id), "shiftIds": [str(a.id)], "report": {
                    **self.DRAWER, "expectedCash": "160.00",
                    ZEC.BLOCK: {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}}},
                {"machineId": str(off.id), "shiftIds": [str(b.id)], "report": {
                    **self.DRAWER, "expectedCash": "300.00"}},
            ],
        })
        LZ.apply_printed(z, body, on)
        assert z.expected_cash == Decimal("460.00")
        assert z.header[ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}

    def test_a_paper_with_no_drawer_keeps_the_clouds_drawer_and_its_block(self, w):
        z, out = self._apply(w, {"totalCash": "100.00"}, parameter_on=True)
        assert z.expected_cash == Decimal("160.00")
        assert out["cashMovements"] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}


class TestASupportZPart:
    def test_the_part_the_cloud_builds_for_a_dead_till_follows_the_parameter(self, w):
        from app.services.shift_totals import compute_totals
        from app.services.support_z import lan_section_of_shifts

        till = w.tills[0]
        shift = _closed(w, till, 1)
        off = lan_section_of_shifts(w.db, till, [shift])
        _set(w, "company", w.company.id, True)
        on = lan_section_of_shifts(w.db, till, [shift])
        assert off["report"].get("expectedCash") == "300.00" and ZEC.BLOCK not in off["report"]
        assert on["report"].get("expectedCash") == "160.00"
        assert on["report"][ZEC.BLOCK] == {"cashIn": "30.00", "cashOut": "20.00", "deposits": "150.00"}
        assert compute_totals(w.db, [shift.id]).total_cash == Decimal("100.00")


# ── The algebra ─────────────────────────────────────────────────────────────────


class TestTheAlgebra:
    def test_a_counted_period_reconciles_with_and_without_the_movements(self):
        shifts = [
            SimpleNamespace(opening_cash=Decimal("100"), total_cash=Decimal("80"), total_cash_tips=Decimal("5"),
                            counted_cash=Decimal("-5") + Decimal("100") + Decimal("80") + Decimal("5") - Decimal("120"),
                            till_totals={"deposits": 120, "cashIn": 10, "cashOut": 5}),
            SimpleNamespace(opening_cash=Decimal("60"), total_cash=Decimal("20"), total_cash_tips=Decimal("0"),
                            counted_cash=Decimal("81"), till_totals={"cardTipsFromDrawer": 4}),
            SimpleNamespace(opening_cash=Decimal("50"), total_cash=Decimal("-3"), total_cash_tips=Decimal("1"),
                            counted_cash=Decimal("40"), till_totals={"deposits": 8}),
        ]
        for flag in (False, True):
            s = till_cash_summary(shifts, flag)
            assert s["over_short"] is not None
            assert s["counted"] - s["expected"] == s["over_short"], flag
        off, on = till_cash_summary(shifts, False), till_cash_summary(shifts, True)
        assert off["cash_movements"] is None and on["cash_movements"] == (Decimal("10"), Decimal("5"), Decimal("128"))

    def test_no_shifts_is_nothing(self):
        assert till_cash_summary([], True)["cash_movements"] == ZEC.NONE
        assert till_cash_summary([])["cash_movements"] is None
        assert z_cash_summary([], [])["cash_movements"] is None

    def test_the_default_is_off_for_every_till(self):
        shift = SimpleNamespace(opening_cash=Decimal("0"), total_cash=Decimal("10"), total_cash_tips=Decimal("0"),
                                counted_cash=None, till_totals={"deposits": 4})
        assert z_cash_summary([[shift]])["expected"] == Decimal("10")
        assert z_cash_summary([[shift]], [True])["expected"] == Decimal("6")


# ── What reads the Z reads what it froze ────────────────────────────────────────


class TestTheExportsAndReportsReadTheFrozenFigures:
    def test_the_z_table_the_day_variance_and_the_accounting_journal_follow_the_z(self, w):
        from app.services import z_table
        from app.services.reports import _z_variance

        on, off = w.tills
        _set(w, "machine", on.id, True)
        z_on = _z(w, (on, _closed(w, on, 1).id))
        z_off = _z(w, (off, _closed(w, off, 1).id))

        table = z_table.build_z_table(w.db, [z_on, z_off], _tz())
        by_id = {row["id"]: row for row in table["zs"]}
        assert (by_id[str(z_on.id)]["expectedCash"], by_id[str(z_on.id)]["discrepancy"]) == ("160.00", "0.00")
        assert (by_id[str(z_off.id)]["expectedCash"], by_id[str(z_off.id)]["discrepancy"]) == ("300.00", "-140.00")
        till_lines = {line["zReportId"]: line for line in table["tills"]}
        assert till_lines[str(z_on.id)]["expectedCash"] == "160.00" and till_lines[str(z_on.id)]["overShort"] == "0.00"
        # The day summary and the accounting journal's "הפרשי קופה" read the Z's own over/short.
        assert (_z_variance(z_on), _z_variance(z_off)) == (Decimal("0.00"), Decimal("-140.00"))

        # And turning the parameter off afterwards changes none of it: the Z is the document.
        _set(w, "machine", on.id, False)
        again = z_table.build_z_table(w.db, [z_on], _tz())
        assert again["zs"][0]["expectedCash"] == "160.00" and _z_variance(z_on) == Decimal("0.00")
