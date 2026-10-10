"""
Customer details on an invoice ("פרטי לקוח לחשבונית") and the re-issue in a customer's name
("הפק חשבונית על שם לקוח") — docs/SPEC_CUSTOMER_INVOICE.md, P:/specs/customer-details-invoice.md.

* The till sends the buyer's ח.פ. / ע.מ. and email beside the name, phone and address it already
  sent; they are stored as printed, trimmed and cut, never a reason to refuse.
* The uniform file's C100 names the buyer the document printed: 1207 name, 1208 street, 1214 phone,
  1215 the number as entered (never a recomputed check digit).
* A re-issue is a credit note for the original and a new invoice, both naming the original
  (`reissueOfTransactionId`), their legs mirroring its legs with no money moving. On the X / Z the
  pair nets to nothing in every tender — in the original's shift and in a later one.
* The dashboard shows the details and the pair, and its search finds a document by the buyer's
  name or number.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.customer import Customer
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.routers import sync as sync_router
from app.routers.transactions import _search_filters, get_transaction
from app.schemas.transaction import TransactionIn, TransactionsBatchEnvelope
from app.services import ably_notify
from app.services.open_format.israeli_tax_id import customer_vat_field, is_valid_israeli_id
from app.services.open_format.tax_report_generator import generate_tax_report
from app.services.shift_totals import compute_totals
from app.services.tax_reports import load_base_documents, transform_transaction_for_open_format
from app.services.tenders import NO_MONEY_BUCKET
from app.services import till_parameters as TP
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


_numbers = iter(range(70000, 10**6))


def _line(total, **extra):
    line = {
        "id": str(uuid.uuid4()), "productName": "Item", "sku": "SKU-1",
        "quantity": "1", "unitPrice": total, "totalPrice": total,
    }
    line.update(extra)
    return line


def _doc(shift_id, total, *legs, doc_type=320, minutes=0, items=None, **extra):
    at = (NOW + timedelta(minutes=minutes)).isoformat()
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(next(_numbers)),
        "status": "completed", "documentType": doc_type, "totalAmount": total,
        "createdAt": at, "updatedAt": at, "businessDate": str(TODAY), "shiftId": str(shift_id),
        "items": items if items is not None else [_line(total)],
        "payments": [
            {"id": str(uuid.uuid4()), "sequence": i, "method": m, "amount": a, **({"noMoneyMovement": True} if nm else {})}
            for i, (m, a, nm) in enumerate(((leg + (False,))[:3] for leg in legs), start=1)
        ],
    }
    body.update(extra)
    return body


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _get(w, doc) -> Transaction:
    w.db.expire_all()
    return w.db.get(Transaction, uuid.UUID(str(doc["id"])))


def _open(w, till, seq=1):
    return w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash="100.00")


def _report(w, rows):
    bases = load_base_documents(w.db, w.tenant.id, rows)
    dicts = [transform_transaction_for_open_format(tx, 18.0, bases) for tx in rows]
    return generate_tax_report(
        dicts, {"vatNumber": "515151515", "companyName": "Acme"},
        {"start": NOW - timedelta(days=1), "end": NOW + timedelta(days=1)},
        global_tax_rate=18.0,
    )


def _c100(w, rows):
    return [line for line in _report(w, rows).bkmv_content if line.startswith("C100")]


def _reissue(original, shift_id, *, minutes=5, **customer):
    """The pair a till writes: a credit of every line and a new invoice, legs mirrored, no money."""
    legs = [(p["method"], p["amount"], True) for p in original["payments"]]
    credit = _doc(
        shift_id, original["totalAmount"], *legs, doc_type=330, minutes=minutes,
        items=[_line(i["totalPrice"], refundOfItemId=i["id"]) for i in original["items"]],
        refundOfTransactionId=original["id"], reissueOfTransactionId=original["id"],
    )
    invoice = _doc(
        shift_id, original["totalAmount"], *legs, doc_type=320, minutes=minutes,
        items=[_line(i["totalPrice"]) for i in original["items"]],
        reissueOfTransactionId=original["id"], **customer,
    )
    return credit, invoice


# ── The check digit ───────────────────────────────────────────────────────────


class TestTheNumber:
    @pytest.mark.parametrize("value", ["515151512", "000000018", "18", "513-570-200", "123456782"])
    def test_valid_numbers_pass(self, value):
        assert is_valid_israeli_id(value)

    @pytest.mark.parametrize("value", ["515151516", "000000000", "", "abc", "1234567890", "12345678x"])
    def test_invalid_numbers_fail(self, value):
        assert not is_valid_israeli_id(value)

    def test_the_c100_field_is_the_number_as_entered_padded_never_repaired(self):
        assert customer_vat_field("515151516") == "515151516"
        assert customer_vat_field("18") == "000000018"
        assert customer_vat_field("51-515-1515") == "515151515"
        assert customer_vat_field(None) == "000000000"
        assert customer_vat_field("12345678901") == "000000000"


# ── Ingest ────────────────────────────────────────────────────────────────────


class TestIngest:
    def test_the_details_are_stored_as_printed(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        sale = _doc(shift.id, "117.00", ("cash", "117.00"), customerName=" Acme Ltd ",
                    customerVatNumber=" 515-151-512 ", customerEmail="books@acme.example",
                    customerPhone="03-5555555", customerAddress="Herzl 1")

        assert _push(w, till, [sale]).results[0].status == "accepted"
        stored = _get(w, sale)
        assert (stored.customer_name, stored.customer_vat_number, stored.customer_email) == (
            "Acme Ltd", "515151512", "books@acme.example")
        assert stored.customer_phone == "03-5555555"

    def test_an_odd_number_is_kept_never_refused(self):
        tx = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "1", "createdAt": NOW.isoformat(),
            "updatedAt": NOW.isoformat(), "customerVatNumber": "FR 12 345 678 901 " + "9" * 30,
            "customerEmail": "x" * 400,
        })
        assert tx.customer_vat_number == ("FR12345678901" + "9" * 30)[:20]
        assert len(tx.customer_email) == 255

    def test_a_reissue_link_to_another_tenants_document_is_dropped_with_a_note(self, w):
        from app.models.tenant import Tenant

        till = w.tills[0]
        shift = _open(w, till)
        other = Tenant(id=uuid.uuid4(), name="Other", slug="o-cust", timezone="Asia/Jerusalem")
        w.db.add(other)
        w.db.flush()
        foreign = w.doc(till, shift, "5.00")
        foreign.tenant_id = other.id
        w.db.flush()
        invoice = _doc(shift.id, "5.00", ("cash", "5.00", True), reissueOfTransactionId=str(foreign.id))

        assert _push(w, till, [invoice]).results[0].status == "accepted"
        stored = _get(w, invoice)
        assert stored.reissue_of_transaction_id is None
        assert any(n["code"] == "reissue_of_other_tenant" for n in stored.ingest_notes)


# ── The re-issue ──────────────────────────────────────────────────────────────


class TestTheReissue:
    def test_the_pair_names_the_original_and_settles_it(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _doc(shift.id, "100.00", ("cash", "60.00"), ("card", "40.00"))
        _push(w, till, [original])
        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")

        assert [r.status for r in _push(w, till, [credit, invoice]).results] == ["accepted", "accepted"]
        assert _get(w, original).status == TransactionStatus.REFUNDED
        assert _get(w, credit).reissue_of_transaction_id == uuid.UUID(original["id"])
        assert _get(w, invoice).reissue_of_transaction_id == uuid.UUID(original["id"])
        assert _get(w, invoice).refund_of_transaction_id is None

    def test_in_the_originals_shift_the_pair_nets_to_nothing_in_each_tender(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _doc(shift.id, "100.00", ("cash", "60.00"), ("card", "40.00"))
        _push(w, till, [original])
        _push(w, till, list(_reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")))

        totals = compute_totals(w.db, [shift.id])
        assert totals.payment_breakdown.get("cash") == Decimal("60.00")
        assert totals.payment_breakdown.get("card") == Decimal("40.00")
        assert totals.payment_breakdown.get(NO_MONEY_BUCKET, Decimal("0")) == Decimal("0")
        # The documents are what they are: the original, its credit, the new invoice.
        assert (totals.sales_count, totals.credit_notes_count) == (2, 1)
        assert totals.total_sales - totals.total_refunds == Decimal("100.00")

    def test_in_a_later_shift_the_pair_stays_out_of_cash_and_card(self, w):
        till = w.tills[0]
        first = w.shift(till, 1)
        original = _doc(first.id, "100.00", ("cash", "100.00"), minutes=-120)
        _push(w, till, [original])
        later = w.shift(till, 2, status=ShiftStatus.OPEN, opening_cash="0.00")
        _push(w, till, list(_reissue(original, later.id, customerName="Acme", customerVatNumber="515151512")))

        totals = compute_totals(w.db, [later.id])
        assert totals.payment_breakdown.get("cash", Decimal("0")) == Decimal("0")
        assert totals.payment_breakdown.get(NO_MONEY_BUCKET) == Decimal("0")
        assert totals.total_sales - totals.total_refunds == Decimal("0")

    def test_the_z_sections_file_the_pair_in_one_bucket_in_a_later_shift(self, w):
        from app.services import z_sections

        till = w.tills[0]
        first = w.shift(till, 1)
        original = _doc(first.id, "100.00", ("cash", "100.00"), minutes=-120)
        _push(w, till, [original])
        later = w.shift(till, 2, status=ShiftStatus.OPEN, opening_cash="0.00")
        credit, invoice = _reissue(original, later.id, customerName="Acme", customerVatNumber="515151512")
        _push(w, till, [credit, invoice])

        facts = {
            f["id"]: f
            for f in z_sections.document_facts(w.db, z_sections.documents_of(w.db, [later.id]), till.shop_id)
        }
        # Both in the no-money bucket: the credit alone there would leave the invoice's cash standing.
        assert [p["method"] for p in facts[credit["id"]]["payments"]] == [z_sections.NO_MONEY]
        assert [p["method"] for p in facts[invoice["id"]]["payments"]] == [z_sections.NO_MONEY]

    def test_in_the_originals_shift_the_z_sections_keep_the_real_tender(self, w):
        from app.services import z_sections

        till = w.tills[0]
        shift = _open(w, till)
        original = _doc(shift.id, "100.00", ("cash", "100.00"))
        _push(w, till, [original])
        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")
        _push(w, till, [credit, invoice])

        facts = {
            f["id"]: f
            for f in z_sections.document_facts(w.db, z_sections.documents_of(w.db, [shift.id]), till.shop_id)
        }
        assert [p["method"] for p in facts[credit["id"]]["payments"]] == ["cash"]
        assert [p["method"] for p in facts[invoice["id"]]["payments"]] == ["cash"]

    def test_a_no_money_leg_on_an_ordinary_sale_still_counts_in_its_tender(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        _push(w, till, [_doc(shift.id, "10.00", ("cash", "10.00", True))])

        assert compute_totals(w.db, [shift.id]).payment_breakdown.get("cash") == Decimal("10.00")


# ── Production vouchers and a mixed basket's document ─────────────────────────


def _voucher_entry(item_id, amount="40.00"):
    """A production voucher's deduction as a till sends it (the contract's §4.1), with its holds."""
    return {
        "kind": "production_voucher", "voucherId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()),
        "redemptionId": str(uuid.uuid4()), "reservationId": str(uuid.uuid4()), "serial": 8, "uses": 1,
        "amount": amount, "lines": [{"itemId": item_id, "amount": amount}],
    }


class TestVouchersAndBaskets:
    """
    The owner, 10.10.2026: "שוברי הפקה הם לא חלק מההכנסה" - a document paid with them is re-issued like
    any other, the voucher legs mirrored as no-money legs and the vouchers themselves never redeemed,
    confirmed or released again; a mixed basket's document is re-issued on its own.
    """

    @pytest.fixture
    def spies(self, monkeypatch):
        from app.services import prepaid_vouchers as PV

        calls = []
        monkeypatch.setattr(PV, "confirm", lambda *a, **k: calls.append("confirm"))
        monkeypatch.setattr(PV, "confirm_from_document", lambda *a, **k: calls.append("confirm_from_document") or [])
        monkeypatch.setattr(PV, "link_deductions", lambda *a, **k: calls.append("link_deductions"))
        return calls

    def _voucher_sale(self, shift, **extra):
        item = _line("100.00")
        return _doc(
            shift.id, "100.00", ("cash", "60.00"), ("production_voucher", "40.00"), items=[item],
            voucherDiscounts=[_voucher_entry(item["id"])], **extra,
        )

    def test_the_invoice_of_a_reissue_never_redeems_confirms_or_stores_a_voucher(self, w, spies):
        from app.models.prepaid_voucher import TransactionVoucherDiscount

        till = w.tills[0]
        shift = _open(w, till)
        original = self._voucher_sale(shift)
        _push(w, till, [original])
        # Control: an ordinary sale carrying voucher data does link and confirm (the spies see it).
        assert spies
        before = list(spies)

        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")
        # An older or foreign till that sends the vouchers on the new invoice: every one of them is ignored.
        invoice["voucherDiscounts"] = [_voucher_entry(invoice["items"][0]["id"])]
        invoice["payments"][1]["reservationId"] = str(uuid.uuid4())
        invoice["items"][0].update(prepaidDeduction="40.00", voucherDiscount="5.00", voucherMemoValueAgorot=900,
                                   voucherReservationId=str(uuid.uuid4()), voucherRedemptionId=str(uuid.uuid4()))
        result = _push(w, till, [credit, invoice])

        assert [r.status for r in result.results] == ["accepted", "accepted"]
        assert spies == before, "no hold confirmed, no redemption linked, for the credit or the new invoice"
        stored = _get(w, invoice)
        assert w.db.query(TransactionVoucherDiscount).filter(TransactionVoucherDiscount.transaction_id == stored.id).count() == 0
        # The original keeps its own row; the invoice keeps no share of a voucher on its lines.
        assert w.db.query(TransactionVoucherDiscount).filter(
            TransactionVoucherDiscount.transaction_id == uuid.UUID(original["id"])).count() == 1
        line = stored.items[0]
        assert (line.prepaid_deduction, line.voucher_discount, line.voucher_memo_value, line.voucher_redemption_id) == (None, None, None, None)

    def test_a_voucher_leg_nets_in_the_originals_shift(self, w, spies):
        till = w.tills[0]
        shift = _open(w, till)
        original = self._voucher_sale(shift)
        _push(w, till, [original])
        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")
        _push(w, till, [credit, invoice])

        breakdown = compute_totals(w.db, [shift.id]).payment_breakdown
        assert breakdown.get("cash") == Decimal("60.00")
        # The credit takes the voucher leg out, the invoice puts it back: the original's own figure.
        assert breakdown.get("production_voucher") == Decimal("40.00")
        assert breakdown.get(NO_MONEY_BUCKET, Decimal("0")) == Decimal("0")

    def test_in_a_later_shift_the_voucher_leg_is_apart_with_the_pair(self, w, spies):
        till = w.tills[0]
        first = w.shift(till, 1)
        original = self._voucher_sale(first, minutes=-120)
        _push(w, till, [original])
        later = w.shift(till, 2, status=ShiftStatus.OPEN, opening_cash="0.00")
        credit, invoice = _reissue(original, later.id, customerName="Acme", customerVatNumber="515151512")
        _push(w, till, [credit, invoice])

        totals = compute_totals(w.db, [later.id])
        assert totals.payment_breakdown.get("cash", Decimal("0")) == Decimal("0")
        assert totals.payment_breakdown.get("production_voucher", Decimal("0")) == Decimal("0")
        assert totals.payment_breakdown.get(NO_MONEY_BUCKET) == Decimal("0")
        assert totals.production_voucher_deductions_total == Decimal("0")

    def test_the_uniform_file_of_a_voucher_pair_adds_up_and_nets(self, w, spies):
        from test_open_format_131 import _check_document, c100

        till = w.tills[0]
        shift = _open(w, till)
        original = self._voucher_sale(shift)
        _push(w, till, [original])
        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512")
        _push(w, till, [credit, invoice])

        rows = [_get(w, d) for d in (original, credit, invoice)]
        documents = _check_document(_report(w, rows))  # every total adds up; no D120 under the credit note
        heads = {h["1203"]: h for h, _ in documents if h["1203"] == "330"}
        sales = [h for h, _ in documents if h["1203"] == "320"]
        assert len(documents) == 3 and len(sales) == 2
        # The credit cancels exactly what the new invoice restates, which is what the original said.
        credit_head = heads["330"]
        assert abs(credit_head["1223"]) == sales[0]["1223"] == sales[1]["1223"]
        # The voucher leg is a D120 of the invoice like any other leg of a 320.
        result = _report(w, rows)
        assert len([l for l in result.bkmv_content if l.startswith("D120")]) == 4

    def test_a_baskets_320_is_reissued_alone_with_its_exchange_leg(self, w, spies):
        from app.models.transaction import Transaction as T

        till = w.tills[0]
        shift = _open(w, till)
        basket = str(uuid.uuid4())
        older = _doc(shift.id, "80.00", ("cash", "80.00"), minutes=-30)
        sale = _doc(shift.id, "100.00", ("cash", "20.00"), ("exchange", "80.00"), basketId=basket)
        returns = _doc(
            shift.id, "80.00", ("exchange", "80.00"), doc_type=330, basketId=basket,
            refundOfTransactionId=older["id"], items=[_line("80.00", refundOfItemId=older["items"][0]["id"])],
        )
        _push(w, till, [older, sale, returns])
        sibling = {
            "status": _get(w, returns).status, "updated": _get(w, returns).updated_at, "basket": _get(w, returns).basket_id,
            "older_status": _get(w, older).status,
        }

        credit, invoice = _reissue(sale, shift.id, customerName="Acme", customerVatNumber="515151512")
        assert _push(w, till, [credit, invoice]).results[0].status == "accepted"

        # Neither document of the pair joins the basket, and the basket's other documents are as they were.
        assert _get(w, credit).basket_id is None and _get(w, invoice).basket_id is None
        again = _get(w, returns)
        assert {"status": again.status, "updated": again.updated_at, "basket": again.basket_id,
                "older_status": _get(w, older).status} == sibling
        assert _get(w, sale).status == TransactionStatus.REFUNDED
        # The shift is what it was: cash and the basket's exchange, with the pair adding nothing.
        breakdown = compute_totals(w.db, [shift.id]).payment_breakdown
        assert breakdown.get("cash") == Decimal("100.00")  # older 80 + the sale's 20
        assert breakdown.get("exchange") == Decimal("0.00")  # 80 in on the sale, 80 out on the returns
        assert breakdown.get(NO_MONEY_BUCKET, Decimal("0")) == Decimal("0")


# ── The uniform file ──────────────────────────────────────────────────────────


class TestTheUniformFile:
    def test_c100_names_the_buyer_the_invoice_printed(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        sale = _doc(shift.id, "117.00", ("cash", "117.00"), customerName="Acme Ltd",
                    customerVatNumber="515151512", customerPhone="03-5555555", customerAddress="Herzl 1")
        _push(w, till, [sale])

        c100 = _c100(w, [_get(w, sale)])[0]
        assert c100[57:107].strip() == "Acme Ltd"        # 1207
        assert c100[107:157].strip() == "Herzl 1"        # 1208
        assert c100[237:252].strip() == "035555555"      # 1214
        assert c100[252:261] == "515151512"              # 1215

    def test_the_document_wins_over_the_linked_customer(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        linked = Customer(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Master Name", vat_number="513570200",
                          address="Master St", address_number="7", city="Haifa")
        w.db.add(linked)
        w.db.flush()
        sale = _doc(shift.id, "50.00", ("cash", "50.00"), customerId=str(linked.id),
                    customerName="Printed Name", customerVatNumber="515151512")
        _push(w, till, [sale])

        c100 = _c100(w, [_get(w, sale)])[0]
        assert c100[57:107].strip() == "Printed Name"
        assert c100[252:261] == "515151512"
        # The document printed no address: the linked customer's fills it, as it does for any linked customer.
        assert c100[107:157].strip() == "Master St"
        assert c100[167:197].strip() == "Haifa"          # 1210

    def test_a_walk_in_is_still_the_general_customer_with_zeros(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        sale = _doc(shift.id, "20.00", ("cash", "20.00"))
        _push(w, till, [sale])

        c100 = _c100(w, [_get(w, sale)])[0]
        assert c100[57:107].strip() == "לקוח כללי"
        assert c100[252:261] == "000000000"


# ── The dashboard ─────────────────────────────────────────────────────────────


class TestTheDashboard:
    def test_the_detail_shows_the_details_and_the_pair(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _doc(shift.id, "30.00", ("cash", "30.00"))
        _push(w, till, [original])
        credit, invoice = _reissue(original, shift.id, customerName="Acme", customerVatNumber="515151512",
                                   customerEmail="a@b.example")
        _push(w, till, [credit, invoice])

        def detail(doc):
            return get_transaction(
                transaction_id=uuid.UUID(doc["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
            )

        on_original = detail(original)
        assert {d.id for d in on_original.reissue_documents} == {uuid.UUID(credit["id"]), uuid.UUID(invoice["id"])}
        on_invoice = detail(invoice)
        assert [d.id for d in on_invoice.reissue_documents] == [uuid.UUID(credit["id"])]
        assert on_invoice.reissue_of_transaction_number is not None
        body = on_invoice.model_dump(by_alias=True, mode="json")
        assert (body["customerVatNumber"], body["customerEmail"]) == ("515151512", "a@b.example")
        assert body["reissueOfTransactionId"] == original["id"]

    @pytest.fixture
    def found(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1)
        a = w.doc(till, shift, "10.00", number="2001")
        a.customer_name, a.customer_vat_number = "אקמי בע״מ", "515151512"
        b = w.doc(till, shift, "20.00", number="2002")
        linked = Customer(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Beta Ltd", vat_number="513570200")
        w.db.add(linked)
        w.db.flush()
        b.customer_ref_id = linked.id
        w.doc(till, shift, "51.51", number="2003")
        w.db.flush()

        def numbers(q):
            return sorted(t.transaction_number for t in _search_filters(w.db.query(Transaction), q=q).all())

        return numbers

    def test_search_by_name_on_the_document_or_the_linked_customer(self, found):
        assert found("אקמי") == ["2001"]
        assert found("beta") == ["2002"]

    def test_search_by_number_on_the_document_or_the_linked_customer(self, found):
        assert found("515151512") == ["2001"]
        assert found("513-570") == ["2002"]

    def test_a_short_number_is_still_the_number_or_amount_search(self, found):
        assert found("2003") == ["2003"]
        assert found("51.5") == ["2003"]

    def test_a_nine_digit_number_is_both_a_document_number_and_a_business_number(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1)
        # `515151512` read as a document number: number 5151512 under prefix 51.
        by_number = w.doc(till, shift, "10.00", number="5151512")
        by_number.document_prefix = "51"
        by_buyer = w.doc(till, shift, "20.00", number="3001")
        by_buyer.customer_vat_number = "515151512"
        w.doc(till, shift, "30.00", number="3002")
        w.db.flush()

        found = sorted(t.transaction_number for t in _search_filters(w.db.query(Transaction), q="515151512").all())
        assert found == ["3001", "5151512"]

    def test_the_export_carries_the_number_the_document_printed_else_the_linked_customers(self, w):
        from app.services.transactions_export import export_rows

        till = w.tills[0]
        shift = w.shift(till, 1)
        printed = w.doc(till, shift, "10.00", number="4001")
        printed.customer_name, printed.customer_vat_number = "אקמי", "515151512"
        linked_doc = w.doc(till, shift, "20.00", number="4002")
        linked = Customer(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Beta", vat_number="513570200")
        w.db.add(linked)
        w.db.flush()
        linked_doc.customer_ref_id = linked.id
        walk_in = w.doc(till, shift, "30.00", number="4003")
        w.db.flush()

        rows = {r["documentNumber"][-4:]: r for r in export_rows(w.db, [printed, linked_doc, walk_in])}
        assert rows["4001"]["customerVatNumber"] == "515151512"
        assert rows["4002"]["customerVatNumber"] == "513570200"
        assert rows["4003"]["customerVatNumber"] is None


# ── The till parameters ───────────────────────────────────────────────────────


def test_the_till_parameters_are_built_in_and_off_by_default():
    by_key = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    required = by_key["invoiceCustomerRequiredAbove"]
    days = by_key["invoiceReissueMaxDays"]
    assert (required.value_type, required.default_value) == ("decimal", None)
    assert (days.value_type, days.default_value) == ("integer", None)


def test_the_migration_is_the_single_head():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert heads == ["a1eece573e4e"]
    assert script.get_revision("a1eece573e4e").down_revision == "31958d027cef"
