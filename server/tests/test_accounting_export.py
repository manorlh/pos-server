"""
Accounting export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2).

* **Byte layout** — `MOVEIN.DAT` / `MOVEIN.PRM`: every record exactly the record length
  plus CR+LF, each field at the position the PRM states, amounts `9.2` right-aligned,
  dates `dd/mm/yyyy`, Hebrew round-tripping through Windows-1255 and CP862.
* **The entry** — balanced by construction; refunds net inside each line and a negative
  line flips side; tips, declined offline card sales, over/short, VAT per rate; a
  remainder up to ₪1 is rounding, over it the export is refused; every missing mapping
  is listed at once.
* **Batches** — a Z built from real documents exports; exporting it again is a 409 until
  confirmed; the stored zip downloads byte for byte; a shop manager is kept out.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import io
import uuid
import zipfile
from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook

from app.models.shift import ShiftStatus
from app.models.user import User, UserRole
from app.routers import accounting as acc_router
from app.schemas.accounting import AccountingSettingsIn, AccountingSettingsPut, ExportRequest
from app.schemas.shift import ShiftCloseIn
from app.services.accounting import movein
from app.services.accounting.journal import (
    JournalEntry,
    JournalLine,
    JournalRefused,
    ZFacts,
    build_entries,
    build_lines,
)
from app.services.accounting.settings import merge, missing_core, normalize
from app.services.shifts import apply_shift_close
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world

D = Decimal

FULL_ACCOUNTS = {
    "cash": "1001", "card": "1200", "cardDeclined": "1250", "vouchers": "2300",
    "otherTenders": "1300", "incomeTaxable": "4000", "incomeExempt": "4100",
    "vatOutput": "2400", "tips": "2500", "voucherSales": "2300",
    "cashOverShort": "6900", "rounding": "6990",
}
SETTINGS = {"movementType": "ZZ1", "branchCode": "7", "accounts": FULL_ACCOUNTS}


def facts(**kw) -> ZFacts:
    base = dict(
        z_id=uuid.uuid4(), z_number=12, business_date=date(2026, 9, 27),
        shop_id=None, shop_name="מרכז", breakdown={"cash": D("100.00"), "card": D("136.00")},
        vat_total=D("36.00"),
    )
    base.update(kw)
    f = ZFacts(**base)
    if "net" not in kw:
        f.net = sum(f.breakdown.values(), D("0"))
    return f


def signed(lines, key):
    return sum((l.signed for l in lines if l.key == key), D("0"))


# ── Settings ────────────────────────────────────────────────────────────────


class TestSettings:
    def test_a_shop_overrides_key_by_key_and_cannot_blank_a_company_account(self):
        company = {"movementType": "ZZ1", "accounts": {"cash": "1001", "card": "1200"}, "encoding": "cp1255"}
        shop = {"branchCode": "7", "accounts": {"cash": "1002", "card": ""}, "encoding": "cp862"}
        m = merge(company, shop)
        assert m["accounts"] == {"cash": "1002", "card": "1200"}
        assert (m["branchCode"], m["encoding"], m["movementType"]) == ("7", "cp862", "ZZ1")

    def test_unknown_account_keys_are_dropped_and_brands_lower_cased(self):
        n = normalize({"accounts": {"cash": " 1 ", "bogus": "9"}, "cardBrands": {"VISA": "1201"}})
        assert n == {"accounts": {"cash": "1"}, "cardBrands": {"visa": "1201"}}

    def test_missing_core_lists_the_movement_type_and_core_accounts(self):
        assert missing_core(merge({}, None)) == [
            "movementType", "accounts.cash", "accounts.card", "accounts.incomeTaxable", "accounts.vatOutput",
        ]
        assert missing_core(merge(SETTINGS, None)) == []


# ── The entry ───────────────────────────────────────────────────────────────


class TestEntry:
    def test_a_plain_z_is_cash_and_card_against_income_and_vat(self):
        lines, problems = build_lines(facts(), SETTINGS)
        assert problems == []
        assert [(l.side, l.key, l.account, l.amount) for l in lines] == [
            ("D", "cash", "1001", D("100.00")),
            ("D", "card", "1200", D("136.00")),
            ("C", "incomeTaxable", "4000", D("200.00")),
            ("C", "vatOutput", "2400", D("36.00")),
        ]
        assert sum(l.signed for l in lines) == 0

    def test_tips_declined_and_over_short_keep_it_balanced(self):
        f = facts(cash_tips=D("5.00"), card_tips=D("7.00"), declined_amount=D("20.00"), variance=D("-3.50"))
        lines, problems = build_lines(f, SETTINGS)
        assert problems == []
        assert signed(lines, "cash") == D("101.50")  # 100 + 5 tips − 3.50 short
        assert signed(lines, "card") == D("123.00")  # 136 + 7 tips − 20 declined
        assert signed(lines, "cardDeclined") == D("20.00")
        assert signed(lines, "tips") == D("-12.00")
        # A shortage is a debit to over/short.
        assert signed(lines, "cashOverShort") == D("3.50")
        assert sum(l.signed for l in lines) == 0

    def test_a_negative_line_moves_to_the_other_side(self):
        # More cash refunded than taken: the cash line is a credit.
        f = facts(breakdown={"cash": D("-40.00"), "card": D("276.00")})
        lines, _ = build_lines(f, SETTINGS)
        cash = next(l for l in lines if l.key == "cash")
        assert (cash.side, cash.amount) == ("C", D("40.00"))
        assert sum(l.signed for l in lines) == 0

    def test_income_is_split_per_vat_rate_with_exempt_on_its_own_account(self):
        f = facts(
            breakdown={"cash": D("150.00"), "card": D("136.00")},
            income_by_rate={D("0.18"): (D("236.00"), D("36.00")), D("0"): (D("50.00"), D("0"))},
        )
        lines, problems = build_lines(f, SETTINGS)
        assert problems == []
        assert signed(lines, "incomeTaxable") == D("-200.00")
        assert signed(lines, "incomeExempt") == D("-50.00")
        assert signed(lines, "vatOutput") == D("-36.00")
        assert next(l for l in lines if l.key == "incomeTaxable").label == "הכנסות 18%"

    def test_vouchers_and_other_tenders_are_their_own_debits(self):
        f = facts(breakdown={"cash": D("50.00"), "card": D("136.00"), "voucher": D("30.00"), "bit": D("20.00")})
        lines, _ = build_lines(f, SETTINGS)
        assert signed(lines, "vouchers") == D("30.00")
        other = [l for l in lines if l.key == "otherTenders"]
        assert [(l.amount, l.label) for l in other] == [(D("20.00"), "אמצעי תשלום אחר bit")]

    def test_card_is_split_per_mapped_brand_and_the_rest_stays_on_card(self):
        s = dict(SETTINGS, cardBrands={"visa": "1201"})
        f = facts(card_by_brand={"visa": D("100.00"), "amex": D("36.00")})
        lines, _ = build_lines(f, s)
        brand = next(l for l in lines if l.key == "card:visa")
        assert (brand.account, brand.amount) == ("1201", D("100.00"))
        assert signed(lines, "card") == D("36.00")

    def test_voucher_sales_as_a_liability_come_out_of_income_and_vat(self):
        s = dict(SETTINGS, voucherSalesAsLiability=True)
        f = facts(voucher_sales=D("118.00"))
        lines, problems = build_lines(f, s)
        assert problems == []
        assert signed(lines, "voucherSales") == D("-118.00")
        assert signed(lines, "incomeTaxable") == D("-100.00")
        assert signed(lines, "vatOutput") == D("-18.00")
        assert sum(l.signed for l in lines) == 0

    def test_a_remainder_of_up_to_one_shekel_is_rounding(self):
        f = facts(breakdown={"cash": D("100.00"), "card": D("136.00"), "exchange": D("0.40")})
        f.net = D("236.40")
        lines, problems = build_lines(f, SETTINGS)
        assert problems == []
        # Income took the 0.40 the tenders did not: the debit side is short, rounding fills it.
        assert signed(lines, "rounding") == D("0.40")
        assert sum(l.signed for l in lines) == 0

    def test_more_than_one_shekel_off_refuses_rather_than_hides_it(self):
        f = facts(breakdown={"cash": D("100.00"), "card": D("136.00"), "exchange": D("5.00")})
        f.net = D("241.00")
        _lines, problems = build_lines(f, SETTINGS)
        assert [p.code for p in problems] == ["unbalanced"]

    def test_unknown_vat_is_a_problem(self):
        _lines, problems = build_lines(facts(vat_total=None), SETTINGS)
        assert "vat_unknown" in [p.code for p in problems]

    def test_every_missing_mapping_is_listed_at_once(self):
        f = facts(cash_tips=D("5.00"), variance=D("1.00"))
        with pytest.raises(JournalRefused) as e:
            build_entries([f], {None: {"accounts": {"cash": "1001"}}})
        details = sorted(p.detail for p in e.value.problems if p.code == "missing_mapping")
        assert details == [
            "accounts.card", "accounts.cashOverShort", "accounts.incomeTaxable",
            "accounts.tips", "accounts.vatOutput", "movementType",
        ]

    def test_one_entry_per_z_by_default_and_per_day_or_month_on_request(self):
        shop = uuid.uuid4()
        a = facts(shop_id=shop, z_number=12)
        b = facts(shop_id=shop, z_number=13)
        c = facts(shop_id=shop, z_number=14, business_date=date(2026, 9, 28))
        s = {shop: SETTINGS}
        per_z = build_entries([a, b, c], s)
        assert [e.reference1 for e in per_z] == [12, 13, 14]
        assert per_z[0].details == "Z 12 · מרכז"
        per_day = build_entries([a, b, c], s, grouping="day")
        assert [(e.reference1, e.details) for e in per_day] == [(12, "Z 12-13 · מרכז"), (14, "Z 14 · מרכז")]
        assert per_day[0].total_debit == D("472.00") == per_day[0].total_credit
        (month,) = build_entries([a, b, c], s, grouping="month")
        assert month.entry_date == date(2026, 9, 30)
        assert month.details == "Z 12-14 · 09/2026 · מרכז"
        assert month.total_debit == month.total_credit == D("708.00")


# ── Byte layout ─────────────────────────────────────────────────────────────


def entry(lines=None, details="Z 123 · סניף מרכז") -> JournalEntry:
    return JournalEntry(
        shop_id=None, shop_name="סניף מרכז", reference1=123, reference2="7",
        entry_date=date(2026, 9, 27), value_date=date(2026, 9, 27), details=details,
        branch="7", movement_type="ZZ1", z_ids=[],
        lines=lines or [
            JournalLine("D", "cash", "1001", D("1234.50"), "מזומן"),
            JournalLine("C", "incomeTaxable", "40000", D("1234.50"), "הכנסות"),
        ],
    )


def field(record: bytes, key: str, fields=movein.FLEXIBLE_FIELDS) -> bytes:
    start, end = movein.positions(fields)[key]
    return record[start - 1:end]


class TestFlexibleLayout:
    def test_the_prm_states_the_record_length_and_each_field_start_and_end(self):
        prm = movein.write_prm("flexible").decode("ascii").split("\r\n")
        assert prm[0] == "130"
        assert prm[1:12] == [
            "1 3", "4 12", "13 21", "22 31", "32 41", "42 71",
            "72 86", "87 101", "102 113", "114 125", "126 130",
        ]
        assert prm[12:] == [""]  # ends with CR+LF, nothing after

    def test_every_record_is_the_record_length_and_ends_with_crlf(self):
        dat = movein.write_dat([entry()])
        assert dat.endswith(b"\r\n")
        records = dat.split(b"\r\n")[:-1]
        assert len(records) == 3
        assert all(len(r) == 130 for r in records)
        assert b"\n" not in dat.replace(b"\r\n", b"")
        # The opening record carries the record length.
        assert records[0] == b"130".ljust(130)

    def test_the_fields_sit_where_the_prm_says_padded_as_specified(self):
        debit, credit = movein.write_dat([entry()]).split(b"\r\n")[1:3]
        assert field(debit, "movementType") == b"ZZ1"
        assert field(debit, "reference1") == b"      123"
        assert field(debit, "reference2") == b"        7"
        assert field(debit, "entryDate") == b"27/09/2026"
        assert field(debit, "valueDate") == b"27/09/2026"
        assert field(debit, "debitAccount") == b"1001".ljust(15)
        assert field(debit, "creditAccount") == b" " * 15
        assert field(debit, "debitAmount") == b"     1234.50"
        assert field(debit, "creditAmount") == b"        0.00"
        assert field(debit, "branch") == b"7    "
        assert field(credit, "debitAccount") == b" " * 15
        assert field(credit, "creditAccount") == b"40000".ljust(15)
        assert field(credit, "debitAmount") == b"        0.00"
        assert field(credit, "creditAmount") == b"     1234.50"

    @pytest.mark.parametrize("encoding", ["cp1255", "cp862"])
    def test_hebrew_round_trips_one_byte_per_letter_in_logical_order(self, encoding):
        debit = movein.write_dat([entry()], encoding=encoding).split(b"\r\n")[1]
        details = field(debit, "details")
        assert len(details) == 30
        # "·" is not in CP862 and is written "-" in both, so positions never depend on it.
        assert details.decode(encoding) == "Z 123 - סניף מרכז מזומן".ljust(30)
        assert "ס".encode(encoding) in details  # the letter itself, not "?"

    def test_text_is_cut_to_its_width_and_unknown_characters_become_question_marks(self):
        long = entry(details="א" * 40)
        details = field(movein.write_dat([long]).split(b"\r\n")[1], "details")
        assert details == "א".encode("cp1255") * 30
        assert movein.encode_text("a😀b", 5, "cp1255") == b"a?b  "

    def test_an_amount_too_wide_for_9_2_is_refused_not_cut(self):
        with pytest.raises(ValueError):
            movein.format_amount(D("1234567890.00"))
        assert movein.format_amount(D("999999999.99")) == "999999999.99"

    def test_the_detailed_method_is_180_bytes_with_ddmmyy_and_8_character_accounts(self):
        dat = movein.write_dat([entry()], method="detailed")
        records = dat.split(b"\r\n")[:-1]
        assert all(len(r) == 180 for r in records)
        debit = records[1]
        f = movein.DETAILED_FIELDS
        assert field(debit, "entryDate", f) == b"270926"
        assert field(debit, "debitAccount", f) == b"1001    "
        assert field(debit, "debitAmount", f) == b"     1234.50"
        assert movein.validate_accounts([entry()], "detailed") == []
        too_long = entry(lines=[JournalLine("D", "cash", "123456789", D("1"), "x"),
                                JournalLine("C", "rounding", "1", D("1"), "y")])
        assert movein.validate_accounts([too_long], "detailed") == ["123456789"]


# ── Batches, end to end ─────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        world.db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.company_manager = user(UserRole.COMPANY_MANAGER, "cm", company_id=world.company.id)
    world.db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def make_z(w, *, counted="300.00"):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="100.00")
    docs = [
        w.doc(till, shift, "118.00", vat="18.00"),
        w.doc(till, shift, "236.00", method="card", vat="36.00", tip="10.00", tip_method="card"),
        w.doc(till, shift, "59.00", credit_note=True, vat="9.00"),
        w.doc(till, shift, "50.00", vat="0.00"),
    ]
    for d, rate in zip(docs, ("0.18", "0.18", "0.18", "0")):
        d.vat_rate = D(rate)
    w.db.flush()
    apply_shift_close(
        w.db, till, shift.id,
        ShiftCloseIn.model_validate({"closedAt": NOW.isoformat(), "countedCash": counted}),
    )
    z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
    w.db.commit()
    return z


def put_settings(w, settings=SETTINGS, shop=None, user=None):
    return acc_router.put_accounting_settings(
        AccountingSettingsPut(
            companyId=w.company.id, shopId=shop.id if shop else None,
            settings=AccountingSettingsIn.model_validate(settings),
        ),
        **ctx(w, user),
    )


def request(w, z, **kw):
    return ExportRequest(companyId=w.company.id, zReportIds=[z.id], **kw)


def refusal(fn, *a, **k) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*a, **k)
    return e.value


class TestBatches:
    def test_settings_are_stored_per_level_and_merged(self, w):
        put_settings(w)
        out = put_settings(w, {"branchCode": "9", "accounts": {"cash": "1009"}}, shop=w.shop)
        assert out.shop == {"branchCode": "9", "accounts": {"cash": "1009"}}
        assert out.effective["accounts"]["cash"] == "1009"
        assert out.effective["accounts"]["card"] == "1200"
        assert out.missing == []

    def test_a_z_with_no_mapping_is_refused_with_the_list(self, w):
        z = make_z(w)
        e = refusal(acc_router.create_accounting_export, request(w, z), **ctx(w))
        assert e.status_code == 422
        codes = {p["detail"] for p in e.detail["problems"]}
        assert {"movementType", "accounts.cash", "accounts.card"} <= codes

    def test_preview_shows_a_balanced_entry_from_the_documents(self, w):
        put_settings(w)
        z = make_z(w)
        out = acc_router.preview_accounting_export(request(w, z), **ctx(w))
        assert out.problems == []
        (e,) = out.entries
        assert e.total_debit == e.total_credit
        by = {(l.side, l.key): l.amount for l in e.lines}
        # 118 + 50 − 59 = 109 cash taken; drawer counted 300 against 100 + 109 expected.
        # Cash posted is the takings plus the over (the opening float is not income).
        assert by[("D", "cash")] == D("200.00")
        assert by[("C", "cashOverShort")] == D("91.00")
        assert by[("D", "card")] == D("246.00")  # 236 + 10 tip
        assert by[("C", "tips")] == D("10.00")
        assert by[("C", "incomeTaxable")] == D("250.00")  # (118 + 236 − 59) − 45
        assert by[("C", "incomeExempt")] == D("50.00")
        assert by[("C", "vatOutput")] == D("45.00")
        assert e.reference1 == z.shop_sequence_number and e.branch == "7"

    def test_export_reexport_lock_and_download_again(self, w):
        put_settings(w)
        z = make_z(w)
        batch = acc_router.create_accounting_export(request(w, z), **ctx(w))
        assert (batch.batch_number, batch.z_count, batch.is_reexport) == (1, 1, False)
        assert batch.z_report_ids == [z.id]

        listed = acc_router.list_accounting_z_reports(
            company_id=w.company.id, shop_id=None, from_date=None, to_date=None,
            only_unexported=False, **ctx(w),
        )
        assert [r.batch_number for r in listed.items[0].exported] == [1]
        unexported = acc_router.list_accounting_z_reports(
            company_id=w.company.id, shop_id=None, from_date=None, to_date=None,
            only_unexported=True, **ctx(w),
        )
        assert unexported.items == []

        e = refusal(acc_router.create_accounting_export, request(w, z), **ctx(w))
        assert e.status_code == 409 and e.detail["batchNumbers"] == [1]
        again = acc_router.create_accounting_export(request(w, z, confirmReexport=True), **ctx(w))
        assert (again.batch_number, again.is_reexport) == (2, True)

        response = acc_router.download_accounting_export(batch.id, **ctx(w))
        zf = zipfile.ZipFile(io.BytesIO(response.body))
        assert sorted(zf.namelist()) == ["MOVEIN.DAT", "MOVEIN.PRM", "journal.xlsx"]
        dat = zf.read("MOVEIN.DAT")
        assert all(len(r) == 130 for r in dat.split(b"\r\n")[:-1])
        sheet = load_workbook(io.BytesIO(zf.read("journal.xlsx"))).active
        assert sheet.sheet_view.rightToLeft
        rows = list(sheet.iter_rows(min_row=2, values_only=True))
        assert rows[-1][3] == 'סה"כ' and rows[-1][4] == rows[-1][5]
        assert isinstance(rows[0][4], (int, float))  # a number, not text
        # Download again: the same bytes.
        assert acc_router.download_accounting_export(batch.id, **ctx(w)).body == response.body

        batches = acc_router.list_accounting_exports(company_id=w.company.id, shop_id=None, limit=10, **ctx(w))
        assert [b.batch_number for b in batches.items] == [2, 1]

    def test_the_excel_format_has_only_the_journal(self, w):
        put_settings(w)
        z = make_z(w)
        batch = acc_router.create_accounting_export(request(w, z, format="excel"), **ctx(w))
        body = acc_router.download_accounting_export(batch.id, **ctx(w)).body
        assert zipfile.ZipFile(io.BytesIO(body)).namelist() == ["journal.xlsx"]

    def test_a_shop_manager_is_kept_out_and_a_company_manager_let_in(self, w):
        put_settings(w)
        z = make_z(w)
        assert refusal(acc_router.preview_accounting_export, request(w, z), **ctx(w, w.manager)).status_code == 403
        assert refusal(put_settings, w, user=w.manager).status_code == 403
        out = acc_router.preview_accounting_export(request(w, z), **ctx(w, w.company_manager))
        assert len(out.entries) == 1

    def test_a_z_of_another_company_is_not_found(self, w):
        put_settings(w)
        z = make_z(w)
        other = ExportRequest(companyId=w.company.id, zReportIds=[z.id, uuid.uuid4()])
        assert refusal(acc_router.preview_accounting_export, other, **ctx(w)).status_code == 404
