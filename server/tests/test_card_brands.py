"""
Card brands (מותג), acquirers (חברת סליקה) and issuers (מנפיק): reading them, storing
them, and where they show — the Z, the clearing report, and the accounting export split
per acquirer / brand with its fallback; plus the export level (company / shop) and the
company → shop account inheritance.

The reply below is the shape of a real Agamento 01.06.94 sale stored on a leg (the till
flattens its meta to strings, so `result` arrives as a JSON string).
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.transaction_payment import TransactionPayment
from app.routers import accounting as acc_router
from app.routers import sales_reports
from app.routers import z_reports as z_router
from app.schemas.accounting import AccountingSettingsIn, AccountingSettingsPut, ExportRequest
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionPaymentIn
from app.services import card_brands as cb
from app.services import z_print
from app.services.accounting import movein
from app.services.accounting.journal import ZFacts, build_entries, build_lines
from app.services.accounting.settings import merge
from app.services.shifts import apply_shift_close
from app.services.transactions import _leg_card_brand
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world

D = Decimal

REAL_RESULT = {
    "statusCode": 0, "statusMessage": "העסקה אושרה", "amount": 1680,
    "mutag": 1, "mutagName": "Mastercard", "manpik": 1, "solek": 6,
    "cardNumber": "542386***7407", "cardNumberOriginalLength": "542386******7407",
    "cardName": "MASTERCARD", "uid": "26100318440018077700371", "issuerAuthNum": "0107544",
}


def till_meta(result=REAL_RESULT, **extra):
    """A leg's meta as the till sends it: flat strings, `result` a JSON string."""
    return {"uid": "u1", "authNum": "0107544", "cardLast4": "7407", "result": json.dumps(result), **extra}


# ── Derivation ───────────────────────────────────────────────────────────────


class TestDerive:
    def test_a_real_reply_names_brand_acquirer_and_issuer(self):
        assert cb.derive(till_meta()) == ("mastercard", "max", "isracard")

    def test_result_as_an_object_reads_the_same(self):
        assert cb.derive({"result": REAL_RESULT}) == ("mastercard", "max", "isracard")

    @pytest.mark.parametrize("mutag,brand", [
        (1, "mastercard"), (2, "visa"), (3, "maestro"), (4, "amex"), (5, "isracard"),
        (6, "jcb"), (7, "discover"), (8, "diners"),
    ])
    def test_brand_codes(self, mutag, brand):
        assert cb.derive({"result": {"mutag": mutag}})[0] == brand

    @pytest.mark.parametrize("solek,acquirer", [
        (1, "isracard"), (2, "cal"), (3, "diners"), (4, "amex"), (6, "max"), (9, "other"),
    ])
    def test_acquirer_codes(self, solek, acquirer):
        assert cb.derive({"result": {"solek": str(solek)}})[1] == acquirer

    def test_foreign_issuer_and_private_label(self):
        assert cb.derive({"result": {"manpik": 0}})[2] == "foreign"
        assert cb.derive({"result": {"mutag": 0, "manpik": 1}})[0] == "isracard"
        assert cb.derive({"result": {"mutag": 0, "manpik": 2}})[0] == "other"

    def test_the_explicit_code_wins_over_the_name_and_the_bin(self):
        meta = {"result": {"mutag": 2, "mutagName": "Mastercard", "cardNumber": "542386***7407"}}
        assert cb.derive(meta)[0] == "visa"

    def test_a_name_when_there_is_no_code(self):
        assert cb.derive({"result": {"cardName": "DEBIT MASTERCARD"}})[0] == "mastercard"
        assert cb.derive({"result": {"mutagName": "American Express"}})[0] == "amex"

    @pytest.mark.parametrize("pan,brand", [
        ("411111***1111", "visa"),
        ("542386***7407", "mastercard"),
        ("222100***0000", "mastercard"),
        ("272099***0000", "mastercard"),
        ("371449***8431", "amex"),
        ("341111***1111", "amex"),
        ("301234***1234", "diners"),
        ("361234***1234", "diners"),
        ("601100***1234", "discover"),
        ("651234***1234", "discover"),
        ("353011***1234", "jcb"),
        ("675912***1234", "maestro"),
        ("620000***1234", "other"),
    ])
    def test_bin_ranges_when_the_reply_says_nothing(self, pan, brand):
        assert cb.derive({"maskedCard": pan}) == (brand, None, None)

    def test_an_israeli_local_card_by_its_length(self):
        assert cb.brand_from_pan("12***678", 8) == "isracard"
        assert cb.derive({"result": {"cardNumberOriginalLength": "1234*5678"}})[0] == "isracard"

    def test_nothing_to_go_on(self):
        assert cb.derive({"cardLast4": "1234"}) == (None, None, None)
        assert cb.derive(None) == (None, None, None)
        assert cb.derive({"result": "not json"}) == (None, None, None)

    def test_what_the_till_sent_wins_when_it_is_a_code(self):
        assert cb.resolve(till_meta(), brand="visa", acquirer="cal") == ("visa", "cal", "isracard")
        assert cb.resolve(till_meta(), brand="bogus") == ("mastercard", "max", "isracard")
        assert cb.derive(till_meta(cardBrand="amex"))[0] == "amex"


class TestIngest:
    def leg(self, **kw):
        return TransactionPaymentIn.model_validate(
            {"id": str(uuid.uuid4()), "method": "card", "amount": "16.80", **kw}
        )

    def test_an_old_till_gets_its_brand_from_the_reply(self):
        assert _leg_card_brand(self.leg(nayaxMeta=json.dumps(till_meta()))) == {
            "card_brand": "mastercard", "card_acquirer": "max", "card_issuer": "isracard",
        }

    def test_a_new_till_sends_them_and_an_odd_value_never_rejects_the_document(self):
        leg = self.leg(nayaxMeta=till_meta(), cardBrand="visa", cardAcquirer=12, cardIssuer="  ")
        assert leg.card_acquirer is None and leg.card_issuer is None
        assert _leg_card_brand(leg)["card_brand"] == "visa"
        assert _leg_card_brand(leg)["card_acquirer"] == "max"

    def test_a_cash_leg_has_none(self):
        assert _leg_card_brand(self.leg(method="cash")) == {}


# ── A world with card sales ──────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def card(w, till, shift, total, brand, acquirer, *, credit_note=False, vat="0.00"):
    tx = w.doc(till, shift, total, method="card", credit_note=credit_note, vat=vat)
    leg = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id).one()
    leg.card_brand, leg.card_acquirer = brand, acquirer
    w.db.flush()
    return tx


def trade(w, till, shift):
    card(w, till, shift, "100.00", "visa", "cal")
    card(w, till, shift, "50.00", "visa", "cal")
    card(w, till, shift, "30.00", "visa", "cal", credit_note=True)
    card(w, till, shift, "80.00", "mastercard", "max")
    card(w, till, shift, "20.00", "amex", "amex")
    card(w, till, shift, "5.00", None, None)  # an old reply that said nothing
    w.doc(till, shift, "10.00", vat="0.00")  # cash


def close_and_z(w, till, shift, shop):
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
    z = build_z(w.db, tenant_id=w.tenant.id, shop_id=shop.id, selections=[(till, shift.id)])
    w.db.commit()
    return z


@pytest.fixture
def z(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    trade(w, till, shift)
    return close_and_z(w, till, shift, w.shop)


def rows_by(rows, *keys):
    return {tuple(r[k] for k in keys): r for r in rows}


class TestZ:
    def test_each_section_freezes_the_split_with_refunds_apart(self, w, z):
        rows = rows_by(z.per_machine[0]["cardBrands"], "brand", "acquirer")
        visa = rows[("visa", "cal")]
        assert (visa["salesCount"], visa["salesAmount"], visa["refundsCount"], visa["refundsAmount"], visa["net"]) == (
            2, "150.00", 1, "30.00", "120.00"
        )
        assert rows[("other", "unknown")]["net"] == "5.00"
        # The split adds up to the Z's card total.
        assert sum(D(r["net"]) for r in rows.values()) == D(z.payment_breakdown["card"])

    def test_the_detail_sums_the_sections_and_the_print_has_both_blocks(self, w, z):
        out = z_router.get_z_report(z.id, **ctx(w))
        assert out.card_brands_source == "stored"
        assert {(r["brand"], r["acquirer"]) for r in out.card_brands} >= {("visa", "cal"), ("mastercard", "max")}
        doc = z_print.build_print_document(z, None)
        titles = [s["title"] for s in doc["sections"]]
        assert "אשראי לפי מותג" in titles and "אשראי לפי חברת סליקה" in titles
        by_brand = next(s for s in doc["sections"] if s["title"] == "אשראי לפי מותג")
        assert by_brand["rows"][0]["label"].startswith("ויזה (3)")
        assert by_brand["rows"][0]["value"] == "₪120.00"
        acq = next(s for s in doc["sections"] if s["title"] == "אשראי לפי חברת סליקה")
        assert any(r["label"].startswith("מקס") for r in acq["rows"])

    def test_a_z_built_before_the_split_reads_its_documents(self, w, z):
        # Built before the split — and so before the owner's sections ("דו״ח Z — גרסה 2") too.
        z.per_machine = [{k: v for k, v in s.items() if k not in ("cardBrands", "reportSections")} for s in z.per_machine]
        z.header = {k: v for k, v in (z.header or {}).items() if k != "reportSections"}
        w.db.commit()
        out = z_router.get_z_report(z.id, **ctx(w))
        assert out.card_brands_source == "documents"
        assert rows_by(out.card_brands, "brand", "acquirer")[("visa", "cal")]["net"] == "120.00"
        assert not any(s["title"] == "אשראי לפי מותג" for s in z_print.build_print_document(z, None)["sections"])


class TestClearingReport:
    def test_per_brand_and_acquirer_with_refunds_apart(self, w, z):
        out = sales_reports.get_card_brands_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
            shop_id=None, machine_id=None, cashier_id=None, **ctx(w),
        )
        brand = {t.key: t for t in out.by_brand}
        assert (brand["visa"].sales_count, brand["visa"].sales_amount, brand["visa"].refunds_count,
                brand["visa"].refunds_amount, brand["visa"].net) == (2, 150.0, 1, 30.0, 120.0)
        acq = {t.key: t.net for t in out.by_acquirer}
        assert acq == {"cal": 120.0, "max": 80.0, "amex": 20.0, "unknown": 5.0}
        assert out.net == 225.0 and out.refunds_amount == 30.0
        assert sum(t.share for t in out.by_brand) == pytest.approx(100, abs=0.05)
        # The card net is the payment-methods report's card total.
        pm = sales_reports.get_payment_methods_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
            shop_id=None, machine_id=None, cashier_id=None, **ctx(w),
        )
        assert {t.method: t.amount for t in pm.totals}["card"] == out.net


# ── Accounting ───────────────────────────────────────────────────────────────

ACCOUNTS = {
    "cash": "1001", "card": "1200", "incomeTaxable": "4000", "incomeExempt": "4100",
    "vatOutput": "2400", "rounding": "6990", "cashOverShort": "6900", "tips": "2500",
}
SETTINGS = {"movementType": "ZZ1", "branchCode": "7", "accounts": ACCOUNTS}


def facts(**kw) -> ZFacts:
    from datetime import date

    base = dict(
        z_id=uuid.uuid4(), z_number=3, business_date=date(2026, 9, 27), shop_id=None, shop_name="מרכז",
        breakdown={"card": D("225.00")}, vat_total=D("0"), net=D("225.00"),
        card_legs={("visa", "cal"): D("120.00"), ("mastercard", "max"): D("80.00"),
                   ("amex", "amex"): D("20.00"), ("other", "unknown"): D("5.00")},
    )
    base.update(kw)
    return ZFacts(**base)


def amount(lines, key):
    return sum((l.signed for l in lines if l.key == key), D("0"))


class TestJournalSplit:
    def test_acquirer_mapping_wins_then_brand_then_the_generic_card_account(self):
        s = dict(SETTINGS, cardAcquirers={"cal": "1220"}, cardBrands={"visa": "1201", "mastercard": "1202"})
        lines, problems = build_lines(facts(), s)
        assert problems == []
        assert amount(lines, "cardAcquirer:cal") == D("120.00")
        assert next(l for l in lines if l.key == "cardAcquirer:cal").account == "1220"
        assert next(l for l in lines if l.key == "cardAcquirer:cal").label == "אשראי כאל"
        assert amount(lines, "card:visa") == 0  # its legs went to the acquirer
        assert amount(lines, "card:mastercard") == D("80.00")
        assert next(l for l in lines if l.key == "card:mastercard").label == "אשראי מאסטרקארד"
        assert amount(lines, "card") == D("25.00")  # amex + unknown fall back
        assert sum(l.signed for l in lines) == 0

    def test_no_mapping_keeps_everything_on_the_card_account(self):
        lines, _ = build_lines(facts(), SETTINGS)
        assert amount(lines, "card") == D("225.00")
        assert not any(":" in l.key for l in lines)


@pytest.fixture
def two_shops(w):
    zs = []
    for till, shop, seq in ((w.tills[0], w.shop, 1), (w.other_till, w.other_shop, 1)):
        shift = w.shift(till, seq, status=ShiftStatus.OPEN)
        trade(w, till, shift)
        zs.append(close_and_z(w, till, shift, shop))
    return zs


def put(w, settings, shop=None):
    return acc_router.put_accounting_settings(
        AccountingSettingsPut(
            companyId=w.company.id, shopId=shop.id if shop else None,
            settings=AccountingSettingsIn.model_validate(settings),
        ),
        **ctx(w),
    )


def req(w, zs, **kw):
    return ExportRequest(companyId=w.company.id, zReportIds=[z.id for z in zs], **kw)


class TestExportFromDocuments:
    def test_the_export_splits_real_legs_per_acquirer(self, w, z):
        put(w, dict(SETTINGS, cardAcquirers={"cal": "1220", "max": "1260"}))
        out = acc_router.preview_accounting_export(req(w, [z]), **ctx(w))
        assert out.problems == []
        by = {l.key: (l.account, l.amount) for l in out.entries[0].lines}
        assert by["cardAcquirer:cal"] == ("1220", D("120.00"))
        assert by["cardAcquirer:max"] == ("1260", D("80.00"))
        assert by["card"] == ("1200", D("25.00"))


class TestExportLevels:
    def test_a_shop_inherits_company_accounts_unless_it_overrides_them(self, w):
        put(w, dict(SETTINGS, cardAcquirers={"cal": "1220"}, exportLevel="shop"))
        out = put(w, {"accounts": {"cash": "1009"}, "cardAcquirers": {"max": "1261"},
                      "costCenter": "N1", "exportLevel": "company"}, shop=w.other_shop)
        eff = out.effective
        assert eff["accounts"]["cash"] == "1009" and eff["accounts"]["card"] == "1200"
        assert eff["cardAcquirers"] == {"cal": "1220", "max": "1261"}
        assert eff["costCenter"] == "N1"
        # How to export is the company's choice; a shop row cannot change it.
        assert eff["exportLevel"] == "shop"
        assert merge({"exportLevel": "bogus"}, None)["exportLevel"] == "company"

    def test_per_shop_writes_a_batch_per_shop_with_each_shops_accounts(self, w, two_shops):
        put(w, dict(SETTINGS, exportLevel="shop"))
        put(w, {"accounts": {"cash": "1009"}, "branchCode": "9"}, shop=w.other_shop)
        out = acc_router.create_accounting_export(req(w, two_shops), **ctx(w))
        assert out.level == "shop"
        assert len(out.group_batches) == 2
        assert {b.shop_id for b in out.group_batches} == {w.shop.id, w.other_shop.id}
        assert all("_shop_" in b.file_name for b in out.group_batches)

        listed = acc_router.list_accounting_exports(company_id=w.company.id, shop_id=None, limit=10, **ctx(w))
        assert all(b.level == "shop" and b.z_count == 1 for b in listed.items)
        north = next(b for b in listed.items if b.shop_id == w.other_shop.id)
        dat = zipfile.ZipFile(io.BytesIO(acc_router.download_accounting_export(north.id, **ctx(w)).body)).read("MOVEIN.DAT")
        records = dat.split(b"\r\n")[1:-1]
        start, end = movein.positions(movein.FLEXIBLE_FIELDS)["debitAccount"]
        debit_accounts = {r[start - 1:end].strip() for r in records}
        assert b"1009" in debit_accounts and b"1001" not in debit_accounts

        bundle = acc_router.download_accounting_export_bundle(
            ids=",".join(str(b.id) for b in out.group_batches), **ctx(w)
        )
        names = sorted(zipfile.ZipFile(io.BytesIO(bundle.body)).namelist())
        assert names == sorted(b.file_name for b in out.group_batches)

    def test_company_level_consolidates_shops_with_a_cost_centre_per_line(self, w, two_shops):
        put(w, dict(SETTINGS, exportLevel="company", consolidate=True))
        put(w, {"costCenter": "C1"}, shop=w.shop)
        put(w, {"branchCode": "22"}, shop=w.other_shop)
        out = acc_router.preview_accounting_export(req(w, two_shops, grouping="day"), **ctx(w))
        assert out.problems == []
        (entry,) = out.entries
        assert entry.shop_id is None and entry.shop_name == "Acme" and entry.branch == "7"
        assert entry.total_debit == entry.total_credit
        cash_lines = [l for l in entry.lines if l.key == "card"]
        assert {l.branch for l in cash_lines} == {"C1", "22"}
        batch = acc_router.create_accounting_export(req(w, two_shops, grouping="day"), **ctx(w))
        assert batch.level == "company" and batch.z_count == 2 and len(batch.group_batches) == 1

    def test_a_z_exported_at_one_level_is_locked_at_the_other(self, w, two_shops):
        put(w, SETTINGS)
        first = acc_router.create_accounting_export(req(w, two_shops, level="company"), **ctx(w))
        with pytest.raises(HTTPException) as e:
            acc_router.create_accounting_export(req(w, two_shops[:1], level="shop"), **ctx(w))
        assert e.value.status_code == 409
        assert e.value.detail["batches"] == [
            {"batchNumber": first.batch_number, "level": "company", "shopId": None}
        ]
        again = acc_router.create_accounting_export(
            req(w, two_shops[:1], level="shop", confirmReexport=True), **ctx(w)
        )
        assert again.is_reexport and again.level == "shop"
        listed = acc_router.list_accounting_z_reports(
            company_id=w.company.id, shop_id=w.shop.id, from_date=None, to_date=None,
            only_unexported=False, **ctx(w),
        )
        assert [r.level for r in listed.items[0].exported] == ["company", "shop"]

    def test_consolidated_mapping_gaps_name_the_shop(self, w, two_shops):
        put(w, {"movementType": "ZZ1", "exportLevel": "company", "consolidate": True,
                "accounts": {k: v for k, v in ACCOUNTS.items() if k != "card"}})
        put(w, {"accounts": {"card": "1200"}}, shop=w.shop)
        out = acc_router.preview_accounting_export(req(w, two_shops, grouping="day"), **ctx(w))
        gaps = {(p.shop_name, p.detail) for p in out.problems if p.code == "missing_mapping"}
        assert gaps == {("North", "accounts.card")}


def test_consolidation_needs_a_period():
    """grouping "z" keeps an entry per Z (a Z is one shop) even when consolidating."""
    f1, f2 = facts(shop_id=uuid.uuid4()), facts(shop_id=uuid.uuid4())
    s = {f1.shop_id: SETTINGS, f2.shop_id: SETTINGS}
    assert len(build_entries([f1, f2], s, grouping="z", consolidate=True, company_settings=SETTINGS)) == 2
    assert len(build_entries([f1, f2], s, grouping="day", consolidate=True, company_settings=SETTINGS)) == 1
