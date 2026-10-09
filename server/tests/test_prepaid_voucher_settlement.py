"""
Production vouchers — settlement with the production and its external invoices (the spec's §14;
app/services/prepaid_voucher_settlement.py, the contract's section H):

* **The spec's example** — 100 meal vouchers, ₪60 to the production, ₪80 at the till, 70 redeemed in
  full (210 units): by delivery 100 → ₪6,000; by redemption 70 → ₪4,200; the till value ₪5,600 either way,
  shown beside the amount, never added to it. A package voucher is one voucher (never 3).
* **Cancelled and replaced vouchers** — by the agreement's policies (excluded / charged; a replacement and
  its original one voucher, or two).
* **Invoices** — partial invoices; a batch's vouchers never on two invoices (refused with what is left);
  voided not deleted (the quantities free again); duplicates refused; the gap per invoice and per
  agreement; corrections after an invoice; a file.
* **Deliveries** — serial ranges, never overlapping, voided with a reason.
* **Who** — the settlement section; amounts only with the prices section; the agreement's scope.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.models.dashboard_access import DashboardAccessProfile
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.routers import prepaid_voucher_extras as X
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate
from app.schemas.prepaid_voucher_extras import (
    DeliveryIn,
    ReasonIn,
    ReplacementIn,
    SettlementAgreementIn,
    SettlementAgreementUpdate,
    SettlementInvoiceIn,
    SettlementInvoiceUpdate,
)
from app.services import prepaid_voucher_settlement as ST
from test_prepaid_voucher_types import company_manager
from test_prepaid_vouchers import _ctx, redeem, refused, vouchers, w  # noqa: F401 — `w` is the fixture

FEATURES = ["accounting", "override"]


def meal_batch(w, *, count=100, name="ארוחות", customer="קייטרינג אלון", event="פסטיבל הקיץ", price=60, value=80, **extra):
    """A meal voucher: a hot dog and two drinks (3 units), ₪80 at the till, ₪60 to the production."""
    body = PrepaidVoucherBatchCreate(
        name=name, companyId=w.company.id, customerName=customer, eventName=event, count=count,
        items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        tillValue=value, productionPrice=price, pricing="fixed", redemptionAccounting="payment", **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def codes(w, b):
    return [v["code"] for v in vouchers(w, b)]


def redeem_all(w, code):
    return redeem(w, code, [(w.hotdog, 1), (w.drink, 2)], features=FEATURES)


def agreement(w, user=None, **kw):
    body = {"name": "קייטרינג אלון — פסטיבל הקיץ", "companyId": w.company.id, "productionName": "קייטרינג אלון",
            "eventName": "פסטיבל הקיץ", **kw}
    return X.create_settlement_agreement(SettlementAgreementIn(**body), **_ctx(w, user))


def patch(w, a, user=None, **kw):
    return X.update_settlement_agreement(a["id"], SettlementAgreementUpdate(**kw), **_ctx(w, user))


def get(w, a, user=None):
    return X.get_settlement_agreement(a["id"], **_ctx(w, user))


def deliver(w, b, lo, hi, *, chargeable=True, when=None):
    return X.add_prepaid_voucher_delivery(
        b["id"], DeliveryIn(serialFrom=lo, serialTo=hi, chargeable=chargeable, deliveredAt=when, recipient="דני"),
        **_ctx(w),
    )


def invoice(w, a, number, amount, lines, user=None, system="חשבשבת"):
    body = SettlementInvoiceIn(number=number, invoiceDate=date(2026, 10, 9), system=system, amount=amount,
                               lines=[{"batchId": bid, "quantity": q} for bid, q in lines])
    return X.add_settlement_invoice(a["id"], body, **_ctx(w, user))


@pytest.fixture
def festival(w):
    """The spec's example: 100 meal vouchers, 70 redeemed in full."""
    b = meal_batch(w)
    for code in codes(w, b)[:70]:
        redeem_all(w, code)
    return b


# ── The spec's example (§14) ──────────────────────────────────────────────────


class TestTheSpecsExample:
    def test_by_delivery_100_vouchers_come_to_6000(self, w, festival):
        deliver(w, festival, 1, 100)
        a = agreement(w, billingBasis="delivery")
        t = a["totals"]
        assert (t["issued"], t["delivered"], t["redeemed"], t["chargeable"]) == (100, 100, 70, 100)
        assert t["amountAgorot"] == 600_000
        assert t["tillValueAgorot"] == 560_000  # ₪5,600 at the till — beside it, never added
        assert a["batches"][0]["productionPriceAgorot"] == 6000

    def test_by_redemption_70_vouchers_come_to_4200(self, w, festival):
        deliver(w, festival, 1, 100)
        a = agreement(w)
        assert a["billingBasis"] == "redemption"  # the default
        t = a["totals"]
        assert (t["chargeable"], t["amountAgorot"], t["tillValueAgorot"]) == (70, 420_000, 560_000)

    def test_a_package_of_three_is_one_voucher(self, w, festival):
        t = agreement(w)["totals"]
        # 70 vouchers of 3 units: 210 units in the product report, 70 vouchers charged — never 210.
        assert (t["units"], t["redemptions"], t["chargeable"]) == (210, 70, 70)

    def test_the_basis_is_switched_on_the_agreement_and_logged(self, w, festival):
        deliver(w, festival, 1, 100)
        a = agreement(w)
        assert patch(w, a, billingBasis="delivery")["totals"]["amountAgorot"] == 600_000
        from app.models.prepaid_voucher_extras import PrepaidVoucherExtraEvent as E

        ev = w.db.query(E).filter(E.action == "agreement_update").one()
        assert (ev.details["before"]["billingBasis"], ev.details["after"]["billingBasis"]) == ("redemption", "delivery")

    def test_per_type_and_per_batch(self, w, festival):
        second = meal_batch(w, count=10, name="ארוחות — יום ב׳", price=50)
        for code in codes(w, second)[:4]:
            redeem_all(w, code)
        a = agreement(w)
        rows = {r["batchName"]: (r["chargeable"], r["amountAgorot"]) for r in a["batches"]}
        assert rows == {"ארוחות": (70, 420_000), "ארוחות — יום ב׳": (4, 20_000)}
        assert a["totals"]["amountAgorot"] == 440_000
        assert len(a["types"]) == 2  # each batch made without a type has a type of its own

    def test_each_voucher_at_the_price_it_was_issued_at(self, w):
        """"ערוך סדרה" changed the production price for the vouchers issued after (the core's history by serial)."""
        from app.models.prepaid_voucher import PrepaidVoucherBatch
        from app.schemas.prepaid_voucher import PrepaidVoucherAddIn

        b = meal_batch(w, count=3)  # serials 1–3 at ₪60
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        row.production_price = 7000
        row.production_price_history = [{"fromSerial": 1, "priceAgorot": 6000}, {"fromSerial": 4, "priceAgorot": 7000}]
        w.db.commit()
        R.add_prepaid_vouchers(b["id"], PrepaidVoucherAddIn(count=2), **_ctx(w))  # serials 4–5 at ₪70
        for c in codes(w, b):
            redeem_all(w, c)
        a = agreement(w)
        r = a["batches"][0]
        assert (r["chargeable"], r["amountAgorot"], r["productionPriceAgorot"], r["pricesMixed"]) == (5, 32_000, None, True)
        # Invoices take the vouchers in serial order, each at its own price: 4 = 3 × ₪60 + ₪70.
        a = invoice(w, a, "INV-1", 250, [(b["id"], 4)])
        line = a["invoices"][0]["lines"][0]
        assert (line["amountAgorot"], line["unitPriceAgorot"]) == (25_000, None)
        assert (a["totals"]["uninvoiced"], a["totals"]["uninvoicedAmountAgorot"]) == (1, 7_000)
        a = invoice(w, a, "INV-2", 70, [(b["id"], 1)])
        assert a["invoices"][1]["lines"][0] == {**a["invoices"][1]["lines"][0], "amountAgorot": 7_000, "unitPriceAgorot": 7_000}
        assert a["totals"]["invoicedAmountAgorot"] == 32_000

    def test_a_redeemed_voucher_counts_in_the_period_of_its_first_redemption(self, w):
        b = meal_batch(w, count=3)
        out = [redeem_all(w, c) for c in codes(w, b)]
        old = datetime.now(timezone.utc) - timedelta(days=40)
        w.db.query(PrepaidVoucherRedemption).filter(
            PrepaidVoucherRedemption.id == uuid.UUID(out[0]["redemptionId"])).update({"redeemed_at": old})
        w.db.commit()
        a = agreement(w, periodFrom=(datetime.now(timezone.utc) - timedelta(days=7)).date())
        assert a["totals"]["chargeable"] == 2

    def test_a_reversed_redemption_is_not_charged(self, w):
        b = meal_batch(w, count=2)
        first = redeem_all(w, codes(w, b)[0])
        redeem_all(w, codes(w, b)[1])
        R.reverse_prepaid_redemption(str(w.tills[0].id), first["redemptionId"], machine=w.tills[0], db=w.db)
        w.db.commit()
        assert agreement(w)["totals"]["chargeable"] == 1


# ── Cancelled and replaced vouchers ───────────────────────────────────────────


class TestCancelledAndReplaced:
    def test_by_delivery_a_cancelled_unredeemed_voucher_is_excluded_or_charged(self, w, festival):
        deliver(w, festival, 1, 100)
        for v in vouchers(w, festival)[95:]:
            R.cancel_prepaid_voucher(v["id"], **_ctx(w))
        a = agreement(w, billingBasis="delivery")
        assert (a["totals"]["chargeable"], a["totals"]["cancelled"]) == (95, 5)
        a = patch(w, a, cancelledPolicy="charge")
        assert (a["totals"]["chargeable"], a["totals"]["cancelledCharged"]) == (100, 5)
        assert any("בוטל" in line for line in a["rules"])

    def test_a_redeemed_then_cancelled_voucher_stays_charged(self, w):
        b = meal_batch(w, count=2, splitAllowed=True)
        code = codes(w, b)[0]
        redeem(w, code, [(w.hotdog, 1)], features=FEATURES)
        R.cancel_prepaid_voucher(vouchers(w, b)[0]["id"], **_ctx(w))
        assert agreement(w)["totals"]["chargeable"] == 1

    def test_a_replacement_and_its_original_are_one_voucher_by_default(self, w, festival):
        deliver(w, festival, 1, 100)
        lost = vouchers(w, festival)[90]
        out = X.replace_prepaid_voucher(lost["id"], ReplacementIn(reasonKind="lost", reason="אבד בדרך"), **_ctx(w))
        a = agreement(w, billingBasis="delivery")
        assert (a["totals"]["issued"], a["totals"]["replacements"], a["totals"]["chargeable"]) == (100, 1, 100)
        # The replacement redeemed: by redemption it is the one voucher of the pair.
        redeem_all(w, out["voucher"]["code"])
        a = patch(w, a, billingBasis="redemption")
        assert a["totals"]["chargeable"] == 71

    def test_a_replacement_charged_on_its_own_when_the_agreement_says(self, w, festival):
        deliver(w, festival, 1, 100)
        lost = vouchers(w, festival)[90]
        X.replace_prepaid_voucher(lost["id"], ReplacementIn(reasonKind="lost", reason="אבד בדרך"), **_ctx(w))
        a = agreement(w, billingBasis="delivery", replacementPolicy="charge")
        assert (a["totals"]["chargeable"], a["totals"]["replacementsCharged"]) == (101, 1)
        assert a["totals"]["amountAgorot"] == 101 * 6000


# ── Invoices ──────────────────────────────────────────────────────────────────


class TestInvoices:
    def test_partial_invoices_never_take_the_same_vouchers_twice(self, w, festival):
        a = agreement(w)
        bid = festival["id"]
        a = invoice(w, a, "INV-1", 3000, [(bid, 50)])
        assert (a["totals"]["invoiced"], a["totals"]["uninvoiced"]) == (50, 20)
        e = refused(invoice, w, a, "INV-2", 1800, [(bid, 30)])
        assert (e.status_code, e.detail) == (409, f"{ST.OVER_INVOICED}:{bid}:20")
        a = invoice(w, a, "INV-2", 1200, [(bid, 20)])
        assert (a["totals"]["invoiced"], a["totals"]["uninvoiced"], a["totals"]["uninvoicedAmountAgorot"]) == (70, 0, 0)
        assert a["totals"]["invoicesAmountAgorot"] == 420_000
        assert a["totals"]["gapAgorot"] == 0
        e = refused(invoice, w, a, "INV-3", 60, [(bid, 1)])
        assert e.detail == f"{ST.OVER_INVOICED}:{bid}:0"

    def test_a_line_keeps_the_price_and_the_gap_is_explained(self, w, festival):
        a = agreement(w)
        a = invoice(w, a, "INV-1", 3100, [(festival["id"], 50)])
        inv = a["invoices"][0]
        assert inv["lines"][0]["unitPriceAgorot"] == 6000
        assert (inv["linesAmountAgorot"], inv["amountAgorot"], inv["gapAgorot"]) == (300_000, 310_000, 10_000)
        a = X.update_settlement_invoice(inv["id"], SettlementInvoiceUpdate(gapNote="דמי טיפול"), **_ctx(w))
        assert a["invoices"][0]["gapNote"] == "דמי טיפול"
        a = patch(w, a, gapNote="החשבונית כוללת דמי טיפול")
        assert (a["gapNote"], a["totals"]["gapAgorot"]) == ("החשבונית כוללת דמי טיפול", 310_000 - 420_000)

    def test_voiding_frees_the_quantities_and_keeps_the_reference(self, w, festival):
        a = agreement(w)
        a = invoice(w, a, "INV-1", 4200, [(festival["id"], 70)])
        inv_id = a["invoices"][0]["id"]
        e = refused(X.void_settlement_invoice, inv_id, ReasonIn(reason=" "), **_ctx(w))
        assert e.detail == ST.REASON_REQUIRED
        a = X.void_settlement_invoice(inv_id, ReasonIn(reason="נשלחה בטעות"), **_ctx(w))
        assert (a["totals"]["invoiced"], a["totals"]["uninvoiced"], a["totals"]["invoices"]) == (0, 70, 0)
        assert a["invoices"][0]["voided"] and a["invoices"][0]["voidReason"] == "נשלחה בטעות"
        assert {"kind": "invoice_voided"}.items() <= a["corrections"][0].items()
        # The same number may be used again once the first is voided.
        assert invoice(w, a, "INV-1", 4200, [(festival["id"], 70)])["totals"]["invoiced"] == 70

    def test_the_same_number_twice_is_refused(self, w, festival):
        a = agreement(w)
        invoice(w, a, "INV-1", 600, [(festival["id"], 10)])
        e = refused(invoice, w, a, "INV-1", 600, [(festival["id"], 10)])
        assert (e.status_code, e.detail) == (409, ST.DUPLICATE_INVOICE)
        # Another system's invoice may carry the same number.
        assert invoice(w, a, "INV-1", 600, [(festival["id"], 10)], system="ריווחית")["totals"]["invoiced"] == 20

    def test_a_batch_outside_the_agreement_and_a_currency_other_than_shekels(self, w, festival):
        other = meal_batch(w, count=2, customer="הפקות דנה")
        a = agreement(w)
        e = refused(invoice, w, a, "X", 10, [(other["id"], 1)])
        assert e.detail == f"{ST.BATCH_NOT_IN_AGREEMENT}:{other['id']}"
        body = SettlementInvoiceIn(number="Y", invoiceDate=date(2026, 10, 9), amount=1, currency="USD")
        assert refused(X.add_settlement_invoice, a["id"], body, **_ctx(w)).detail == ST.CURRENCY

    def test_a_closed_agreement_takes_no_invoice(self, w, festival):
        a = agreement(w)
        patch(w, a, status="closed")
        e = refused(invoice, w, a, "INV-9", 60, [(festival["id"], 1)])
        assert (e.status_code, e.detail) == (409, ST.CLOSED)

    def test_agreements_by_period_never_invoice_the_same_vouchers_twice(self, w):
        b = meal_batch(w, count=3)
        out = [redeem_all(w, c) for c in codes(w, b)]
        old = datetime.now(timezone.utc) - timedelta(days=40)
        for o in out[:2]:
            w.db.query(PrepaidVoucherRedemption).filter(
                PrepaidVoucherRedemption.id == uuid.UUID(o["redemptionId"])).update({"redeemed_at": old})
        w.db.commit()
        today = datetime.now(timezone.utc).date()
        october = agreement(w, name="אוקטובר", periodTo=today - timedelta(days=20))
        october = invoice(w, october, "OCT", 120, [(b["id"], 2)])
        assert (october["totals"]["chargeable"], october["totals"]["uninvoiced"]) == (2, 0)
        patch(w, october, status="closed")
        november = agreement(w, name="נובמבר", periodFrom=today - timedelta(days=7))
        # October's invoice is October's: November has its one voucher to invoice.
        assert (november["totals"]["chargeable"], november["totals"]["invoiced"], november["totals"]["uninvoiced"]) == (1, 0, 1)
        november = invoice(w, november, "NOV", 60, [(b["id"], 1)])
        assert november["totals"]["uninvoiced"] == 0
        patch(w, november, status="closed")
        # An agreement over all time sees 3 charged, none on its own invoices — but every voucher was invoiced
        # (by the other two): nothing is left, as the invoice form says too.
        ever = agreement(w, name="הכול")
        row = ever["batches"][0]
        assert (ever["totals"]["chargeable"], ever["totals"]["uninvoiced"], row["invoicedElsewhere"]) == (3, 0, 3)
        e = refused(invoice, w, ever, "ALL", 60, [(b["id"], 1)])
        assert e.detail == f"{ST.OVER_INVOICED}:{b['id']}:0"

    def test_the_terms_are_fixed_once_an_invoice_is_linked(self, w, festival):
        a = agreement(w)
        a = invoice(w, a, "INV-1", 600, [(festival["id"], 10)])
        e = refused(patch, w, a, billingBasis="delivery")
        assert (e.status_code, e.detail) == (409, ST.HAS_INVOICES)
        # The same value again, the name and the notes are fine.
        assert patch(w, a, billingBasis="redemption", name="שם חדש", notes="x")["name"] == "שם חדש"
        X.void_settlement_invoice(a["invoices"][0]["id"], ReasonIn(reason="בטעות"), **_ctx(w))
        assert patch(w, a, billingBasis="delivery")["billingBasis"] == "delivery"

    def test_corrections_after_an_invoice(self, w):
        b = meal_batch(w, count=3)
        out = [redeem_all(w, c) for c in codes(w, b)[:2]]
        a = agreement(w)
        a = invoice(w, a, "INV-1", 120, [(b["id"], 2)])
        R.reverse_prepaid_redemption(str(w.tills[0].id), out[0]["redemptionId"], machine=w.tills[0], db=w.db)
        R.cancel_prepaid_voucher(vouchers(w, b)[0]["id"], **_ctx(w))
        a = get(w, a)
        kinds = {c["kind"]: c for c in a["corrections"]}
        assert kinds["over_invoiced"]["quantity"] == 1
        assert kinds["cancelled_after_invoice"]["serial"] == 1
        assert a["totals"]["overInvoiced"] == 1
        # The invoice itself is untouched.
        assert a["invoices"][0]["quantity"] == 2 and not a["invoices"][0]["voided"]

    def test_the_file(self, w, festival):
        a = agreement(w)
        a = invoice(w, a, "INV-1", 600, [(festival["id"], 10)])
        inv_id = a["invoices"][0]["id"]
        ST.put_invoice_file(w.db, w.admin, w.tenant.id, inv_id, "חשבונית.pdf", "application/pdf", b"%PDF-1.4 x")
        w.db.commit()
        assert get(w, a)["invoices"][0]["file"] == {"name": "חשבונית.pdf", "type": "application/pdf", "size": 10}
        resp = X.get_settlement_invoice_file(inv_id, **_ctx(w))
        assert resp.body == b"%PDF-1.4 x"
        e = refused(ST.put_invoice_file, w.db, w.admin, w.tenant.id, inv_id, "a.exe", "application/x-msdownload", b"MZ")
        assert e.detail == ST.FILE_TYPE


# ── The agreement ─────────────────────────────────────────────────────────────


class TestAgreement:
    def test_a_batch_is_in_one_active_agreement(self, w, festival):
        agreement(w)
        e = refused(agreement, w, name="כפול", eventName=None)
        assert e.status_code == 409 and e.detail.startswith(ST.OVERLAP)

    def test_closing_an_agreement_frees_its_batches(self, w, festival):
        a = agreement(w)
        patch(w, a, status="closed")
        assert agreement(w, name="חדש")["totals"]["chargeable"] == 70

    def test_explicit_batches_and_the_candidates(self, w, festival):
        other = meal_batch(w, count=2, name="דנה", customer="הפקות דנה", event="ערב גאלה")
        a = agreement(w, name="רק דנה", productionName=None, eventName=None, batchIds=[other["id"]])
        assert [r["batchName"] for r in a["batches"]] == ["דנה"]
        c = X.settlement_candidates(company_id=str(w.company.id), production_name="קייטרינג אלון", event_name=None,
                                    report_event_id=None, batch_ids=None, **_ctx(w))
        assert [i["name"] for i in c["items"]] == ["ארוחות"]

    def test_the_scope_is_required_and_the_period_checked(self, w):
        e = refused(agreement, w, productionName=None, eventName=None)
        assert e.detail == ST.SCOPE_REQUIRED
        e = refused(agreement, w, periodFrom=date(2026, 10, 9), periodTo=date(2026, 10, 1))
        assert e.detail == ST.PERIOD
        e = refused(agreement, w, billingBasis="weekly")
        assert e.detail == ST.BAD_VALUE

    def test_the_list(self, w, festival):
        agreement(w)
        out = X.list_settlement_agreements(company_id=None, status_filter=None, **_ctx(w))
        assert [(a["name"], a["totals"]["chargeable"]) for a in out["items"]] == [("קייטרינג אלון — פסטיבל הקיץ", 70)]
        assert out["pricesVisible"] and out["editable"]


# ── Deliveries ────────────────────────────────────────────────────────────────


class TestDeliveries:
    def test_ranges_never_overlap_and_void_frees_them(self, w):
        b = meal_batch(w, count=10)
        out = deliver(w, b, 1, 4)
        assert (out["delivered"], out["undelivered"]) == (4, [{"from": 5, "to": 10}])
        out = deliver(w, b, 5, 6, chargeable=False)
        assert (out["delivered"], out["deliveredFree"]) == (4, 2)
        e = refused(deliver, w, b, 4, 8)
        assert (e.status_code, e.detail) == (409, f"{ST.DELIVERY_OVERLAP}:1-4")
        assert refused(deliver, w, b, 9, 11).detail == ST.DELIVERY_RANGE
        future = datetime.now(timezone.utc) + timedelta(days=2)
        assert refused(deliver, w, b, 9, 10, when=future).detail == ST.DELIVERY_FUTURE
        first = out["items"][0]["id"]
        out = X.void_prepaid_voucher_delivery(first, ReasonIn(reason="נרשם בטעות"), **_ctx(w))
        assert out["delivered"] == 0 and out["items"][0]["voided"]
        assert deliver(w, b, 1, 4)["delivered"] == 4

    def test_a_free_delivery_is_not_charged(self, w):
        b = meal_batch(w, count=10)
        deliver(w, b, 1, 6)
        deliver(w, b, 7, 10, chargeable=False)
        assert agreement(w, billingBasis="delivery")["totals"]["chargeable"] == 6

    def test_a_replacement_is_never_part_of_a_delivery(self, w):
        b = meal_batch(w, count=3)
        X.replace_prepaid_voucher(vouchers(w, b)[0]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        out = deliver(w, b, 1, 4)  # 4 is the replacement
        assert (out["delivered"], out["replacementSerials"]) == (3, [4])
        a = agreement(w, billingBasis="delivery")
        assert a["totals"]["chargeable"] == 3  # the lost one and its replacement are one voucher

    def test_deliveries_are_the_settlement_sections(self, w):
        b = meal_batch(w, count=3)
        cm = restricted(w, {"prepaid_vouchers": "edit", "prepaid_voucher_settlement": "view"})
        e = refused(X.add_prepaid_voucher_delivery, b["id"], DeliveryIn(serialFrom=1, serialTo=2), **_ctx(w, cm))
        assert e.status_code == 403
        assert X.list_prepaid_voucher_deliveries(b["id"], **_ctx(w, cm))["delivered"] == 0

    def test_a_delivery_in_the_batchs_audit_trail(self, w):
        b = meal_batch(w, count=5)
        deliver(w, b, 1, 5)
        ev = R.prepaid_voucher_events(b["id"], **_ctx(w))["items"]
        assert any(e["action"] == "deliver" and e["count"] == 5 for e in ev)


# ── Who ───────────────────────────────────────────────────────────────────────


def restricted(w, sections):
    cm = company_manager(w)
    w.db.add(DashboardAccessProfile(user_id=cm.id, full_access=False, sections=sections))
    w.db.commit()
    return cm


class TestWho:
    def test_the_settlement_section_is_needed(self, w, festival):
        a = agreement(w)
        cm = restricted(w, {"prepaid_vouchers": "edit"})
        e = refused(X.list_settlement_agreements, company_id=None, status_filter=None, **_ctx(w, cm))
        assert (e.status_code, e.detail) == (403, "prepaid_settlement_forbidden")
        assert refused(get, w, a, cm).status_code == 403

    def test_amounts_only_with_the_prices(self, w, festival):
        a = agreement(w)
        cm = restricted(w, {"prepaid_vouchers": "edit", "prepaid_voucher_settlement": "edit"})
        out = get(w, a, cm)
        assert (out["pricesVisible"], out["totals"]["chargeable"], out["totals"]["amountAgorot"]) == (False, 70, None)
        assert out["batches"][0]["productionPriceAgorot"] is None
        e = refused(invoice, w, a, "INV-1", 600, [(festival["id"], 10)], cm)
        assert (e.status_code, e.detail) == (403, ST.PRICES_REQUIRED)

    def test_view_only_cannot_edit(self, w, festival):
        a = agreement(w)
        cm = restricted(w, {"prepaid_vouchers": "edit", "prepaid_voucher_settlement": "view", "prepaid_voucher_prices": "view"})
        assert get(w, a, cm)["editable"] is False
        assert refused(patch, w, a, cm, notes="x").status_code == 403
