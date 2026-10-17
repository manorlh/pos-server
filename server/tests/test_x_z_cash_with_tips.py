"""
"מזומן במגירה כולל טיפים" on the cloud (P:/specs/x-z-cash-with-tips.md).

* §2 — the shift close's frozen keys (`cardTipsFromDrawer` = paid, `cardTipsUnpaid`, `cardTipsShortfall`):
  stored as sent; a Z's header and every till section carry `cardTipsUnpaid` (Σ; null / absent when no
  close froze the parameter, 0 for an older close), its sections' tips block `unpaidFromDrawer`.
* §1 — the block's total is the Z's expected cash, whatever the policy.
* §3 — a shop Z: per drawer, one till's cash never pays another till's tips; the table and the day's
  unpaid card tips. The shop X previews an open shift's payout from the parameter.
* §4 — the fiscal part is identical with the parameter off / partial / negative; the accounting entry
  takes the paid amount off `D cash` and `C tips` and still balances.
* The parameter `cashDrawer.cardTipsShortfall`: built in, enum, default partial, its Hebrew.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import z_reports as zr_router
from app.schemas.shift import ShiftCloseIn
from app.services import cash_drawer as CD
from app.services import cash_with_tips as CWT
from app.services import shop_x as SX
from app.services import till_parameters as TP
from app.services import z_print
from app.services.accounting.journal import ZFacts, build_lines, load_z_facts
from app.services.shifts import apply_shift_close
from app.services.z_builder import build_z
from shift_world import NOW, accept_str_uuids, make_world

D = Decimal


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


# 50 sold in cash, 50 on a card with an 80 card tip: the drawer holds 50, the card tips are 80.
SHORT_DAY = [
    dict(total="50.00", method="cash"),
    dict(total="50.00", method="card", tip="80.00", tip_method="card"),
]

PARTIAL = {"cardTipsFromDrawer": 50, "cardTipsUnpaid": 30, "cardTipsShortfall": "partial"}
NEGATIVE = {"cardTipsFromDrawer": 80, "cardTipsUnpaid": 0, "cardTipsShortfall": "negative"}

FISCAL = (
    "total_sales", "total_refunds", "discounts_total", "total_cash_sales", "total_card_sales", "total_exchange",
    "total_tips", "total_cash_tips", "total_card_tips", "vat_total", "transactions_count",
)
SECTION_FISCAL = (
    "totalSales", "grossSales", "netSales", "totalRefunds", "discountsTotal", "vatTotal", "totalCash", "totalCard",
    "totalExchange", "paymentBreakdown", "totalTips", "totalCashTips", "totalCardTips", "transactionsCount",
    "salesCount", "creditNotesCount",
)


def _closed(w, till, seq, docs, *, till_figures=None, counted=None, opening="0.00"):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    for spec in docs:
        w.doc(till, shift, **spec)
    body = {"closedAt": NOW.isoformat()}
    if counted is not None:
        body["countedCash"] = counted
    if till_figures is not None:
        body["till"] = till_figures
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return shift


def _z(w, *pairs):
    return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=list(pairs))


def _block_total(z) -> Decimal:
    block = z_print.cash_with_tips_of(z)
    return Decimal(block["total"])


# ── §2 the close and the Z ────────────────────────────────────────────────────


class TestFrozenOnTheCloseAndTheZ:
    def test_partial_the_drawer_pays_what_it_holds_the_rest_is_owed(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        assert shift.till_totals["cardTipsUnpaid"] == 30 and shift.till_totals["cardTipsShortfall"] == "partial"

        z = _z(w, (till, shift.id))

        assert (z.expected_cash, z.discrepancy) == (D("0.00"), D("0.00"))  # 50 − 50 paid
        section = z.per_machine[0]
        assert (section["cardTipsFromDrawer"], section["cardTipsUnpaid"]) == ("50.00", "30.00")
        assert (z.header["cardTipsFromDrawer"], z.header["cardTipsUnpaid"]) == ("50.00", "30.00")
        # drawerCash keeps its old meaning: cash sales + cash tips − paid.
        assert section["drawerCash"] == z.header["drawerCash"] == "0.00"
        tips = z.header["reportSections"]["tips"]
        assert (tips["paidFromDrawer"], tips["unpaidFromDrawer"]) == ("50.00", "30.00")
        assert section["reportSections"]["tips"]["unpaidFromDrawer"] == "30.00"
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert (Decimal(out["cardTipsFromDrawer"]), Decimal(out["cardTipsUnpaid"])) == (D("50"), D("30"))
        assert _block_total(z) == z.expected_cash

    def test_negative_pays_everything_and_the_drawer_goes_below_zero(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, SHORT_DAY, counted=0, till_figures=NEGATIVE)
        z = _z(w, (till, shift.id))
        assert z.expected_cash == D("-30.00")
        assert (z.header["cardTipsFromDrawer"], z.header["cardTipsUnpaid"]) == ("80.00", "0.00")
        block = z_print.cash_with_tips_of(z)
        assert block["total"] == "-30.00" and block["short"] is True
        assert [l["key"] for l in block["lines"]][-2:] == ["total", "short"]
        assert "cardTipsUnpaid" not in [l["key"] for l in block["lines"]]

    def test_an_older_close_reads_paid_only_unpaid_zero(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, SHORT_DAY, counted=0, till_figures={"cardTipsFromDrawer": 50})
        z = _z(w, (till, shift.id))
        assert (z.per_machine[0]["cardTipsUnpaid"], z.header["cardTipsUnpaid"]) == ("0.00", "0.00")
        assert z.header["reportSections"]["tips"]["unpaidFromDrawer"] == "0.00"

    def test_off_nothing_new_but_the_block(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, SHORT_DAY, counted=50)
        z = _z(w, (till, shift.id))
        assert "cardTipsUnpaid" not in z.per_machine[0] and "cardTipsUnpaid" not in z.header
        assert "unpaidFromDrawer" not in z.header["reportSections"]["tips"]
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert out["cardTipsUnpaid"] is None
        block = z_print.cash_with_tips_of(z)
        assert [l["key"] for l in block["lines"]] == ["opening", "cashSales", "cashTips", "total"]
        assert block["total"] == "50.00" == z_print.money(z.expected_cash).replace("₪", "")

    def test_back_to_back_shifts_sum_and_the_block_is_the_expected(self, w):
        till = w.tills[0]
        one = _closed(w, till, 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        # Shift 2 opens on 5 (a carried surplus of 5): a between-shift line.
        two = _closed(w, till, 2, [dict(total="20.00", method="card", tip="10.00", tip_method="card"),
                                   dict(total="30.00")], counted=25, opening="5.00",
                      till_figures={"cardTipsFromDrawer": 10, "cardTipsUnpaid": 0, "cardTipsShortfall": "partial"})
        z = _z(w, (till, two.id))
        assert one.z_report_id == z.id
        assert (z.header["cardTipsFromDrawer"], z.header["cardTipsUnpaid"]) == ("60.00", "30.00")
        block = z_print.cash_with_tips_of(z)
        keys = [l["key"] for l in block["lines"]]
        assert "between" in keys
        assert Decimal(block["total"]) == z.expected_cash


# ── §4 the fiscal part never moves ──────────────────────────────────────────────


class TestFiscalUnchanged:
    def test_off_partial_negative_give_identical_fiscal_totals(self, w):
        from app.models.pos_machine import POSMachine

        third = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
            name="Till 9", machine_code="M-XZ9", pos_number="9", is_active=True, pairing_status=w.tills[0].pairing_status,
        )
        w.db.add(third)
        w.db.flush()
        off = _closed(w, w.tills[0], 1, SHORT_DAY, counted=50)
        partial = _closed(w, w.tills[1], 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        negative = _closed(w, third, 1, SHORT_DAY, counted=0, till_figures=NEGATIVE)
        zs = [_z(w, (w.tills[0], off.id)), _z(w, (w.tills[1], partial.id)), _z(w, (third, negative.id))]
        assert [z.expected_cash for z in zs] == [D("50.00"), D("0.00"), D("-30.00")]
        for z in zs[1:]:
            assert [getattr(z, k) for k in FISCAL] == [getattr(zs[0], k) for k in FISCAL]
            assert z.payment_breakdown == zs[0].payment_breakdown
            assert [z.per_machine[0].get(k) for k in SECTION_FISCAL] == [zs[0].per_machine[0].get(k) for k in SECTION_FISCAL]
            for part in ("sales", "vat", "payments", "receipts", "cardBrands"):
                assert z.header["reportSections"][part] == zs[0].header["reportSections"][part], part
            # The card total as charged, tips included.
            assert z.total_card_sales + z.total_card_tips == D("130.00")


# ── §3 per drawer ─────────────────────────────────────────────────────────────


class TestShopZPerDrawer:
    def test_one_tills_cash_never_pays_another_tills_tips(self, w):
        rich = _closed(w, w.tills[0], 1, [dict(total="500.00"), dict(total="10.00", method="card", tip="40.00", tip_method="card")],
                       counted=460, opening="0.00",
                       till_figures={"cardTipsFromDrawer": 40, "cardTipsUnpaid": 0, "cardTipsShortfall": "partial"})
        poor = _closed(w, w.tills[1], 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        z = _z(w, (w.tills[0], rich.id), (w.tills[1], poor.id))
        assert z.expected_cash == D("460.00")
        assert (z.header["cardTipsFromDrawer"], z.header["cardTipsUnpaid"]) == ("90.00", "30.00")
        block = z_print.cash_with_tips_of(z)
        assert Decimal(block["total"]) == z.expected_cash
        table = block["table"]
        by_till = {r["till"]: r for r in table["rows"]}
        one, two = (f"קופה {w.tills[0].pos_number}", f"קופה {w.tills[1].pos_number}")
        assert (by_till[one]["cardTipsPaid"], by_till[one]["cardTipsUnpaid"], by_till[one]["drawerCash"]) == ("40.00", "0.00", "460.00")
        assert (by_till[two]["cardTipsPaid"], by_till[two]["cardTipsUnpaid"], by_till[two]["drawerCash"]) == ("50.00", "30.00", "0.00")
        assert table["totals"]["drawerCash"] == "460.00" and table["unpaidTotal"] == "30.00"
        doc = z_print.build_print_document(z, None)
        titles = [s["title"] for s in doc["sections"]]
        assert "פירוט לפי קופה" in titles and z_print.SUMMARY_TITLE in titles
        s = table["summary"]
        # 460 + 40 paid and 0 + 50 paid: 550 in the drawers before payouts; tips 90 paid; 30 owed → 430.
        assert (s["totalCash"], s["tips"], s["unpaid"], s["netCash"]) == ("550.00", "90.00", "30.00", "430.00")

    def test_summary_only_is_a_print_setting(self, w):
        rich = _closed(w, w.tills[0], 1, [dict(total="500.00")], counted=500)
        poor = _closed(w, w.tills[1], 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        z = _z(w, (w.tills[0], rich.id), (w.tills[1], poor.id))
        assert z_print.per_till_cash_of(w.db, z) is True
        for till in w.tills:
            _set(w, "zPrintPerTillCash", till, "summary_only")
        assert z_print.per_till_cash_of(w.db, z) is False
        titles = [s["title"] for s in z_print.build_print_document(z, None, per_till_cash=False)["sections"]]
        assert z_print.SUMMARY_TITLE in titles and "פירוט לפי קופה" not in titles

    def test_a_single_till_z_has_the_block_only(self, w):
        shift = _closed(w, w.tills[0], 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        z = _z(w, (w.tills[0], shift.id))
        assert z_print.cash_with_tips_of(z)["table"] is None


# ── §4 accounting ─────────────────────────────────────────────────────────────

ACCOUNTS = {"movementType": "ZZ1", "accounts": {
    "cash": "1001", "card": "1200", "incomeTaxable": "4000", "incomeExempt": "4010", "vatOutput": "2400",
    "tips": "2600", "cashOverShort": "6900", "rounding": "6990", "cardDeclined": "1250", "vouchers": "1300",
    "otherTenders": "1400", "voucherSales": "2700",
}}


def _signed(lines, key):
    return sum((l.signed for l in lines if l.key == key), D("0"))


class TestAccounting:
    def _facts(self, **kw):
        base = dict(
            z_id=uuid.uuid4(), z_number=1, business_date=date(2026, 10, 17), shop_id=None, shop_name="מרכז",
            breakdown={"cash": D("50.00"), "card": D("50.00")}, vat_total=D("15.25"), card_tips=D("80.00"),
        )
        base.update(kw)
        f = ZFacts(**base)
        f.net = sum(f.breakdown.values(), D("0"))
        return f

    def test_paid_from_the_drawer_comes_off_cash_and_tips_and_the_entry_balances(self):
        before, _ = build_lines(self._facts(), ACCOUNTS)
        after, problems = build_lines(self._facts(card_tips_paid_from_drawer=D("50.00")), ACCOUNTS)
        assert problems == []
        assert _signed(after, "cash") == _signed(before, "cash") - D("50.00") == D("0.00")
        assert _signed(after, "tips") == _signed(before, "tips") + D("50.00") == D("-30.00")
        # Income, VAT and the card never move.
        for key in ("incomeTaxable", "vatOutput", "card"):
            assert _signed(after, key) == _signed(before, key), key
        assert sum(l.signed for l in after) == 0 and not any(l.key == "rounding" for l in after)

    def test_the_paid_amount_is_the_zs_frozen_one(self, w):
        shift = _closed(w, w.tills[0], 1, SHORT_DAY, counted=0, till_figures=PARTIAL)
        z = _z(w, (w.tills[0], shift.id))
        facts = load_z_facts(w.db, z)
        assert facts.card_tips_paid_from_drawer == D("50.00")
        lines, problems = build_lines(facts, ACCOUNTS)
        # The test documents declare no VAT (one income line then): never a balance problem.
        assert [p.code for p in problems if p.code != "vat_unknown"] == [] and sum(l.signed for l in lines) == 0
        # D cash: 50 takings − 50 paid out = 0; C tips: 80 card tips − 50 paid = 30 still owed.
        assert _signed(lines, "cash") == D("0.00") and _signed(lines, "tips") == D("-30.00")

    def test_off_the_entry_is_as_before(self, w):
        shift = _closed(w, w.tills[0], 1, SHORT_DAY, counted=50)
        facts = load_z_facts(w.db, _z(w, (w.tills[0], shift.id)))
        assert facts.card_tips_paid_from_drawer == D("0")


# ── The shop X previews an open shift ───────────────────────────────────────────


def _set(w, key, machine, value):
    param = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=param.id, scope_type="machine", scope_id=machine.id, value=value))
    w.db.flush()


def _open(w, till, docs, opening="0.00"):
    shift = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=2), opening_cash=opening)
    for spec in docs:
        w.doc(till, shift, **spec)
    w.db.flush()
    return shift


class TestShopX:
    @pytest.mark.parametrize("policy,paid,unpaid,total,needs", [
        ("partial", "50.00", "30.00", "0.00", False),
        ("negative", "80.00", "0.00", "-30.00", False),
        ("ask", "50.00", "30.00", "0.00", True),
    ])
    def test_an_open_shift_is_previewed_by_the_parameter(self, w, policy, paid, unpaid, total, needs):
        till, other = w.tills
        _set(w, CD.CARD_TIPS_FROM_DRAWER_KEY, till, True)
        _set(w, CD.CARD_TIPS_SHORTFALL_KEY, till, policy)
        _open(w, till, SHORT_DAY)
        _open(w, other, [dict(total="100.00")], opening="20.00")
        report = SX.build(w.db, w.shop, settings=SX.Settings(), now=NOW)
        drawer = report["summary"]["drawer"]
        assert (drawer["cardTipsFromDrawer"], drawer["cardTipsUnpaid"]) == (paid, unpaid)
        block = report["summary"]["cashWithTips"]
        assert block["total"] == drawer["expected"]
        assert block["needsChoice"] is needs
        rows = {r["till"]: r for r in block["table"]["rows"]}
        mine = rows[f"קופה {till.pos_number}"]
        assert (mine["cardTipsPaid"], mine["cardTipsUnpaid"], mine["drawerCash"]) == (paid, unpaid, total)
        assert rows[f"קופה {other.pos_number}"]["cardTipsPaid"] is None
        assert block["table"]["unpaidTotal"] == unpaid
        section = next(s for s in report["tills"] if s["machineId"] == str(till.id))
        assert section.get("cardTipsNeedsChoice", False) is needs
        doc = SX.print_document(w.db, report, w.shop, tzinfo=None, now=NOW)
        titles = [s["title"] for s in doc["sections"]]
        assert "מזומן במגירה" in titles and "פירוט לפי קופה" in titles and z_print.SUMMARY_TITLE in titles
        assert block["table"]["summary"]["unpaid"] == unpaid

    def test_off_no_preview(self, w):
        till, _other = w.tills
        _open(w, till, SHORT_DAY)
        report = SX.build(w.db, w.shop, settings=SX.Settings(), now=NOW)
        assert report["summary"]["drawer"]["cardTipsFromDrawer"] is None
        assert report["summary"]["cashWithTips"]["total"] == report["summary"]["drawer"]["expected"] == "50.00"


# ── The parameter ─────────────────────────────────────────────────────────────


def test_the_print_setting_is_built_in():
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == "zPrintPerTillCash")
    assert spec.value_type == "enum" and spec.default_value == "with_per_till"
    assert tuple(spec.enum_options) == ("summary_only", "with_per_till")
    assert spec.enum_labels["summary_only"] == "סיכום בלבד"


def test_the_shortfall_parameter_is_built_in():
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == "cashDrawer.cardTipsShortfall")
    assert spec.value_type == "enum" and spec.default_value == "partial"
    assert spec.label == "כשאין מספיק מזומן לטיפים באשראי"
    assert tuple(spec.enum_options) == ("partial", "negative", "ask")
    assert set(spec.enum_labels) == {"partial", "negative", "ask"}
    assert CD.CARD_TIPS_SHORTFALL_KEY == CWT.SHORTFALL_KEY in CD.LEVEL_KEYS
    assert CD.LEVEL_KEYS.index(CD.CARD_TIPS_SHORTFALL_KEY) == CD.LEVEL_KEYS.index(CD.CARD_TIPS_FROM_DRAWER_KEY) + 1
