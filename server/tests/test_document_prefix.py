"""
"קידומת מסמכים" — every till prints and exports its document numbers under its own prefix
(docs/SPEC_DOCUMENT_PREFIX.md).

* The rule: digits, 1–3; shown as `<prefix>-<number>`. The default is the register number.
* Unique among the tills of the whole business — every shop of the company, whatever its
  branch code — and never again once another till's documents carry it. A Hebrew 409
  otherwise. (More in test_document_prefix_business.py.)
* Frozen at issue: the till sends the prefix with the document; the cloud stores it and a
  re-push never changes it. A document without one reads as its register number.
* Everywhere a number is shown: the dashboard reads, the cloud reprint (with "קופה N"),
  the Z's document range, the till-facing shop list, and the lookup `20000057`.
* The format (owner: "ללא מקף"): the prefix and the number padded to 7 digits; above
  9,999,999 `<prefix>-<number>`, never an ambiguous pad.
* One number series per document type (owner: "רצף מספרים נפרד לכל מסמך"): 320, 330, 400
  (-400 in 400); unique per machine, series and number; ranges and the highest number
  per series.
* Branch codes are mandatory (owner: "חייב שלסניף יהיה קוד"): digits 1–7, unique in the
  company; the export refuses a shop without one.
* The tax export files `<prefix>-<number>` in every record of a document, so two tills'
  #57 are two different, consistent documents.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from fastapi.responses import JSONResponse

from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.routers import machines as machines_router
from app.routers.transactions import _search_filters, get_print_document
from app.schemas.pos_machine import POSMachineResponse, POSMachineUpdate
from app.schemas.transaction import BasketDocumentOut, TransactionIn, TransactionListItem, TransactionOut
from app.services import document_prefix as DP
from app.services.open_format.tax_report_generator import DOCUMENT_NUMBER_WIDTH, generate_tax_report
from app.services.shift_totals import compute_totals
from app.services.tax_reports import load_base_documents, transform_transaction_for_open_format
from app.services.till_z import _same_document_number
from app.services.transactions import _serialize_tx_for_upsert
from shift_world import NOW, accept_str_uuids, make_world

BUSINESS = {
    "vatNumber": "034567891",
    "companyName": "קפה דנה",
    "companyAddress": "הרצל",
    "companyAddressNumber": "1",
    "companyCity": "חיפה",
    "companyZip": "",
    "companyRegNumber": "",
    "withholdingFileNumber": "000000000",
    "hasBranches": False,
}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
    # Committed: a refused PUT rolls its session back, as it does in the API.
    world.db.commit()
    return world


def _doc(w, till, number, *, prefix=None, pos_number="__till__", document_type=320, total="11.80",
         refund_of=None, shift_id=None, created_at=NOW):
    """A document of [till] as the ingest stores it: its register stamped, its prefix frozen."""
    tx = Transaction(
        id=uuid.uuid4(),
        tenant_id=till.tenant_id,
        machine_id=till.id,
        shop_id=till.shop_id,
        shift_id=shift_id,
        transaction_number=number,
        document_prefix=prefix,
        pos_number=till.pos_number if pos_number == "__till__" else pos_number,
        status=TransactionStatus.COMPLETED,
        document_type=document_type,
        payment_method="cash",
        total_amount=D(total),
        document_discount=D("0"),
        net_amount=D("10.00"),
        vat_amount=D("1.80"),
        vat_rate=D("0.18"),
        refund_of_transaction_id=refund_of,
        created_at=created_at,
        updated_at=created_at,
        server_received_at=created_at,
    )
    w.db.add(tx)
    w.db.flush()
    w.db.add(
        TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_name="קפה", sku="1",
            quantity=D("1"), unit_price=D(total), total_price=D(total), transaction_type=2,
        )
    )
    w.db.flush()
    w.db.refresh(tx)
    return tx


def _put(w, till, **body):
    return machines_router.update_machine(
        machine_id=str(till.id),
        machine_data=POSMachineUpdate(**body),
        current_user=w.admin,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )


def _refused(result) -> tuple:
    assert isinstance(result, JSONResponse), result
    import json

    return result.status_code, json.loads(result.body)


# ── The rule ──────────────────────────────────────────────────────────────────


class TestRule:
    def test_the_format_has_no_dash(self):
        assert DP.format_document_number("2", "57") == "20000057"
        assert DP.format_document_number("101", "57") == "1010000057"
        assert DP.format_document_number("2", "9999999") == "29999999"
        assert DP.format_document_number(None, "57") == "57"
        assert DP.format_document_number(" ", "57") == "57"
        # Only a plain counter takes a prefix: never twice, never on a training number.
        assert DP.format_document_number("2", "ה-12") == "ה-12"

    def test_the_number_is_always_the_last_seven_digits(self):
        for prefix in ("1", "12", "123"):
            for number in (1, 57, 1234567, 9999999):
                text = DP.format_document_number(prefix, str(number))
                assert text == prefix + f"{number:07d}"
                q = DP.parse_document_query(text)
                assert (q.prefix, q.number) == (prefix, str(number))

    def test_above_9999999_is_never_an_ambiguous_pad(self):
        # Padded to 7, prefix 2 and number 12345678 would read as prefix 21's 2345678.
        assert DP.format_document_number("2", "12345678") == "2-12345678"
        assert DP.format_document_number("21", "2345678") == "212345678"
        assert DP.format_document_number("2", "12345678") != DP.format_document_number("21", "2345678")
        q = DP.parse_document_query("2-12345678")
        assert (q.prefix, q.number) == ("2", "12345678")

    @pytest.mark.parametrize("value, ok", [
        ("1", True), ("12", True), ("123", True), ("007", True),
        ("", False), ("1234", False), ("A1", False), ("1-", False), (" 2 ", True), (None, False),
    ])
    def test_digits_one_to_three(self, value, ok):
        assert DP.is_valid_prefix(value) is ok

    def test_the_default_is_the_register_number(self):
        till = SimpleNamespace(pos_number="2", document_prefix=None)
        assert DP.effective_prefix(till) == "2"
        till.document_prefix = "7"
        assert DP.effective_prefix(till) == "7"
        # A register "number" that is not 1–3 digits gives no default: the bare number.
        assert DP.effective_prefix(SimpleNamespace(pos_number="1000", document_prefix=None)) is None
        assert DP.effective_prefix(SimpleNamespace(pos_number=None, document_prefix=None)) is None

    def test_a_document_reads_its_frozen_prefix_else_its_register(self):
        assert DP.prefix_from("7", "2") == "7"
        assert DP.prefix_from(None, "2") == "2"
        # A shopless machine's documents carry its machine code: no prefix.
        assert DP.prefix_from(None, "M-ABC123") is None

    @pytest.mark.parametrize("text, expected", [
        ("20000057", DP.DocumentQuery("2", "57", "20000057")),
        (" 1010000057 ", DP.DocumentQuery("101", "57", "1010000057")),
        ("57", DP.DocumentQuery(None, "57")),
        ("1234567", DP.DocumentQuery(None, "1234567")),
        ("2-10000000", DP.DocumentQuery("2", "10000000")),
        ("2–10000000", DP.DocumentQuery("2", "10000000")),
        ("12345678901", DP.DocumentQuery(None, "12345678901")),
        ("1234-5", None),
        ("abc", None),
        ("", None),
    ])
    def test_the_lookup_reads_the_full_number(self, text, expected):
        assert DP.parse_document_query(text) == expected

    @pytest.mark.parametrize("document_type, refund_of, series", [
        (320, None, 320), (330, None, 330), (400, None, 400), (-400, "x", 400),
        (None, None, 320), (None, "x", 330),
    ])
    def test_the_series_of_a_type(self, document_type, refund_of, series):
        assert DP.document_series_of(document_type, refund_of) == series


# ── Setting it, and uniqueness ────────────────────────────────────────────────


class TestSetting:
    def test_every_till_starts_on_its_register_number(self, w):
        dumped = POSMachineResponse.model_validate(w.tills[1]).model_dump(by_alias=True)
        assert dumped["documentPrefix"] is None
        assert dumped["effectiveDocumentPrefix"] == w.tills[1].pos_number

    def test_a_free_prefix_is_taken_and_null_goes_back_to_the_default(self, w):
        till = w.tills[0]
        out = POSMachineResponse.model_validate(_put(w, till, documentPrefix="12"))
        assert (out.document_prefix, out.effective_document_prefix) == ("12", "12")
        _put(w, till, documentPrefix=None)
        assert till.document_prefix is None and till.effective_document_prefix == till.pos_number
        _put(w, till, documentPrefix="13")
        _put(w, till, documentPrefix="")
        assert till.document_prefix is None

    def test_omitted_leaves_it(self, w):
        till = w.tills[0]
        _put(w, till, documentPrefix="12")
        _put(w, till, name="Renamed")
        assert till.document_prefix == "12"

    @pytest.mark.parametrize("bad", ["1234", "A", "1-2", "٣"])
    def test_a_malformed_prefix_is_a_hebrew_400(self, w, bad):
        status, body = _refused(_put(w, w.tills[0], documentPrefix=bad))
        assert status == 400 and body["code"] == "invalid_document_prefix"
        assert "ספרות בלבד" in body["detail"]
        assert w.tills[0].document_prefix is None

    def test_another_tills_register_number_is_taken(self, w):
        one, two = w.tills
        status, body = _refused(_put(w, one, documentPrefix=two.pos_number))
        assert status == 409 and body["code"] == "document_prefix_in_use"
        assert f"קופה {two.pos_number}" in body["detail"] and "כבר בשימוש" in body["detail"]
        assert one.document_prefix is None

    def test_another_tills_chosen_prefix_is_taken(self, w):
        one, two = w.tills
        _put(w, two, documentPrefix="50")
        status, _ = _refused(_put(w, one, documentPrefix="50"))
        assert status == 409

    def test_going_back_to_a_default_someone_else_took_is_refused(self, w):
        one, two = w.tills
        _put(w, one, documentPrefix="50")
        # Till 2 takes till 1's register number as its prefix — free, since till 1 is on 50.
        _put(w, two, documentPrefix=one.pos_number)
        status, body = _refused(_put(w, one, documentPrefix=None))
        assert status == 409 and "ברירת המחדל" in body["detail"]
        assert one.document_prefix == "50"

    def test_a_prefix_on_another_tills_documents_is_never_reused(self, w):
        one, two = w.tills
        _put(w, two, documentPrefix="50")
        _doc(w, two, "57", prefix="50")
        _put(w, two, documentPrefix="60")
        # 50 is free as a setting, but 50-57 is already printed by till 2.
        status, body = _refused(_put(w, one, documentPrefix="50"))
        assert status == 409 and "מסמכים" in body["detail"]
        # An old document with no frozen prefix holds its register number the same way.
        _doc(w, two, "58", prefix=None)
        _put(w, two, documentPrefix="61")
        status, _ = _refused(_put(w, one, documentPrefix=two.pos_number))
        assert status == 409

    def test_a_till_may_go_back_to_a_prefix_of_its_own_documents(self, w):
        one = w.tills[0]
        _put(w, one, documentPrefix="50")
        _doc(w, one, "57", prefix="50")
        _put(w, one, documentPrefix="60")
        assert POSMachineResponse.model_validate(_put(w, one, documentPrefix="50")).document_prefix == "50"

    def test_another_shop_of_the_business_is_the_same_series(self, w):
        # The open-format file is one per business: branch codes do not tell two
        # branches' `20000057` apart (the Tax Authority's simulator refuses the pair).
        w.shop.branch_id = "1"
        w.other_shop.branch_id = "2"
        w.db.commit()
        status, body = _refused(_put(w, w.other_till, documentPrefix=w.tills[1].pos_number))
        assert status == 409 and body["code"] == "document_prefix_in_use"
        assert w.shop.name in body["detail"] and "בכל הסניפים" in body["detail"]
        assert w.other_till.document_prefix is None

    def test_a_new_till_whose_register_number_is_held_gets_a_free_prefix(self, w):
        one, two = w.tills
        # A third till of the shop draws register number 3 — the default the other shop's
        # till 3 issues under: it would print 30000001… like that till does now.
        from app.models.pos_machine import PairingStatus, POSMachine

        three = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
            name="Till 3", machine_code="M-NEW", pos_number="3", is_active=True,
            pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(three)
        w.db.flush()
        # The lowest prefix free in the business: 1 and 2 are tills 1–2's, 3 the other
        # shop's till's.
        assert DP.settle_default(w.db, three) == "4"
        assert three.effective_document_prefix == "4"
        # A till whose default is free keeps it.
        assert DP.settle_default(w.db, two) is None and two.document_prefix is None


class TestMachineMe:
    def test_the_till_is_told_the_prefix_in_force(self, w):
        till = w.tills[1]
        me = machines_router.get_my_machine(machine=till, db=w.db)
        assert me["documentPrefix"] == till.pos_number
        till.document_prefix = "12"
        assert machines_router.get_my_machine(machine=till, db=w.db)["documentPrefix"] == "12"


# ── Frozen at issue ───────────────────────────────────────────────────────────


def _incoming(**extra) -> TransactionIn:
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": "57", "status": "completed",
        "documentType": 320, "totalAmount": "11.80",
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), **extra,
    })


class TestIngest:
    def test_the_prefix_the_till_sent_is_stored(self, w):
        till = w.tills[1]
        till.document_prefix = "9"  # changed in the cloud since: the document keeps the till's
        row = _serialize_tx_for_upsert(_incoming(documentPrefix="2"), till, None)
        assert row["document_prefix"] == "2"
        assert row["pos_number"] == till.pos_number

    def test_an_older_till_sends_none_and_none_is_invented(self, w):
        row = _serialize_tx_for_upsert(_incoming(), w.tills[1], None)
        assert row["document_prefix"] is None

    def test_it_is_trimmed_and_cut_never_refused(self):
        assert _incoming(documentPrefix=" 2 ").document_prefix == "2"
        assert _incoming(documentPrefix=12).document_prefix == "12"
        assert _incoming(documentPrefix="x" * 40).document_prefix == "x" * 10
        assert _incoming(documentPrefix="").document_prefix is None

    def test_a_reprefix_of_the_till_does_not_touch_its_documents(self, w):
        till = w.tills[1]
        tx = _doc(w, till, "57", prefix="2")
        _put(w, till, documentPrefix="12")
        w.db.refresh(tx)
        assert tx.document_number == "20000057"


# ── Shown everywhere ─────────────────────────────────────────────────────────


class TestDisplay:
    def test_the_dashboard_reads_show_the_full_number(self, w):
        tx = _doc(w, w.tills[1], "57", prefix="2")
        old = _doc(w, w.tills[0], "57")  # before the prefix: reads as its register
        for schema in (TransactionOut, TransactionListItem, BasketDocumentOut):
            assert schema.model_validate(tx).model_dump(by_alias=True)["documentNumber"] == "20000057"
            assert schema.model_validate(old).model_dump(by_alias=True)["documentNumber"] == f"{w.tills[0].pos_number}0000057"
        assert TransactionOut.model_validate(old).model_dump(by_alias=True)["documentPrefix"] is None

    def test_the_cloud_reprint_and_its_credit_reference(self, w):
        till = w.tills[1]
        sale = _doc(w, till, "57", prefix="2")
        credit = _doc(w, till, "58", prefix="2", document_type=330, refund_of=sale.id)
        doc = get_print_document(
            transaction_id=credit.id, kind="invoice", payment_id=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        rows = {r.label: r.value for s in doc.sections for r in s.rows}
        assert rows["מס׳ מסמך"] == "20000058"
        assert rows["זיכוי עבור מסמך"] == "20000057"
        assert rows["קופה"].startswith(till.pos_number)
        assert doc.title.endswith("20000058")

    def test_the_dashboard_detail_names_the_original_as_printed(self, w):
        from app.routers.transactions import get_transaction

        till = w.tills[1]
        sale = _doc(w, till, "57", prefix="2")
        credit = _doc(w, till, "58", prefix="2", document_type=330, refund_of=sale.id)
        out = get_transaction(
            transaction_id=credit.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert (out.document_number, out.refund_of_transaction_number) == ("20000058", "20000057")

    def test_the_z_range_is_shown_as_printed(self, w):
        till = w.tills[1]
        shift = w.shift(till, 1)
        for n in ("9", "10", "11"):
            _doc(w, till, n, prefix="2", shift_id=shift.id)
        totals = compute_totals(w.db, [shift.id])
        assert (totals.first_transaction_number, totals.last_transaction_number) == ("20000009", "20000011")

    def test_the_z_ranges_are_per_document_type(self, w):
        till = w.tills[1]
        shift = w.shift(till, 1)
        for n in ("1", "2", "3"):
            _doc(w, till, n, prefix="2", shift_id=shift.id)
        _doc(w, till, "1", prefix="2", document_type=330, shift_id=shift.id)
        _doc(w, till, "2", prefix="2", document_type=330, shift_id=shift.id)
        totals = compute_totals(w.db, [shift.id])
        assert totals.document_ranges == [
            {"documentType": 320, "first": "20000001", "last": "20000003", "count": 3},
            {"documentType": 330, "first": "20000001", "last": "20000002", "count": 2},
        ]
        # The one "document range" is the tax invoices', not a mix of the series.
        assert (totals.first_transaction_number, totals.last_transaction_number) == ("20000001", "20000003")
        from app.services.z_print import _document_rows

        section = {"documentRanges": totals.document_ranges}
        assert [(r["label"], r["value"]) for r in _document_rows(section)] == [
            ("חשבוניות מס קבלה", "20000001–20000003"), ("חשבוניות זיכוי", "20000001–20000002"),
        ]

    def test_an_exempt_dealers_receipts_and_refunds_are_one_range(self, w):
        till = w.tills[1]
        shift = w.shift(till, 1)
        _doc(w, till, "1", prefix="2", document_type=400, shift_id=shift.id)
        _doc(w, till, "2", prefix="2", document_type=-400, shift_id=shift.id)
        totals = compute_totals(w.db, [shift.id])
        assert totals.document_ranges == [{"documentType": 400, "first": "20000001", "last": "20000002", "count": 2}]

    def test_an_older_tills_z_range_is_not_a_discrepancy(self):
        assert _same_document_number("20000057", "20000057")
        assert _same_document_number("57", "20000057")  # a till build from before the prefix
        assert _same_document_number("2-57", "20000057")  # the first prefix build
        assert not _same_document_number("30000057", "20000057")
        assert not _same_document_number("58", "20000057")
        assert not _same_document_number("57", None)


# ── Lookup ────────────────────────────────────────────────────────────────────


class TestLookup:
    def _search(self, w, q):
        query = w.db.query(Transaction).filter(Transaction.tenant_id == w.tenant.id)
        return sorted(t.document_number for t in _search_filters(query, q=q).all())

    def test_the_full_number_finds_that_tills_document_only(self, w):
        one, two = w.tills
        _doc(w, one, "57", prefix=one.pos_number)
        _doc(w, two, "57", prefix=two.pos_number)
        _doc(w, two, "157", prefix=two.pos_number)
        full = f"{two.pos_number}0000057"
        assert self._search(w, full) == [full]
        # The bare number is still the substring search, over every till.
        assert len(self._search(w, "57")) == 3

    def test_an_old_document_is_found_by_its_register_number(self, w):
        two = w.tills[1]
        _doc(w, two, "57", prefix=None)
        full = f"{two.pos_number}0000057"
        assert self._search(w, full) == [full]

    def test_a_number_of_two_types_finds_both_for_the_reader_to_pick(self, w):
        two = w.tills[1]
        _doc(w, two, "57", prefix="2")
        _doc(w, two, "57", prefix="2", document_type=330)
        query = w.db.query(Transaction).filter(Transaction.tenant_id == w.tenant.id)
        found = _search_filters(query, q="20000057").all()
        assert sorted(t.document_type for t in found) == [320, 330]
        assert {TransactionListItem.model_validate(t).document_type for t in found} == {320, 330}


# ── The tax export ───────────────────────────────────────────────────────────


def _records(result, kind):
    return [line for line in result.bkmv_content if line.startswith(kind)]


#: Where the document number sits in each record (after the record type, the record
#: number, the VAT number and the document type): 4 + 9 + 9 + 3.
NUMBER_AT = 25


def _number(line: str) -> str:
    return line[NUMBER_AT:NUMBER_AT + DOCUMENT_NUMBER_WIDTH]


class TestTaxExport:
    def test_two_tills_57_are_two_documents_and_every_record_agrees(self, w):
        one, two = w.tills
        a = _doc(w, one, "57", prefix="1")
        b = _doc(w, two, "57", prefix="2")
        credit = _doc(w, two, "58", prefix="2", document_type=330, total="11.80", refund_of=b.id)
        rows = [a, b, credit]
        bases = load_base_documents(w.db, w.tenant.id, rows)
        result = generate_tax_report(
            [transform_transaction_for_open_format(t, 18.0, bases) for t in rows],
            BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        c100 = [_number(line) for line in _records(result, "C100")]
        assert c100 == ["10000057".ljust(20), "20000057".ljust(20), "20000058".ljust(20)]
        assert len(set(c100)) == 3
        # Every line and every payment carries its header's number, in the same order. The
        # credit note has no payment record (D120 only under a receipt, 1.31 §4.5).
        assert [_number(line) for line in _records(result, "D110")] == c100
        assert [_number(line) for line in _records(result, "D120")] == c100[:2]
        # The credit note's line names its base document as printed: D110 1256/1257.
        credit_line = _records(result, "D110")[2]
        base_at = NUMBER_AT + DOCUMENT_NUMBER_WIDTH + 4  # after the line number (1255)
        assert credit_line[base_at:base_at + 3] == "320"
        assert credit_line[base_at + 3:base_at + 23] == "20000057".ljust(20)

    def test_an_original_outside_the_export_is_named_the_same_way(self, w):
        two = w.tills[1]
        original = _doc(w, two, "57", prefix="2", created_at=datetime(2025, 12, 31, tzinfo=timezone.utc))
        credit = _doc(w, two, "58", prefix="2", document_type=330, refund_of=original.id)
        bases = load_base_documents(w.db, w.tenant.id, [credit])
        tx = transform_transaction_for_open_format(credit, 18.0, bases)
        assert tx["transactionNumber"] == "20000058"
        assert tx["baseDocument"]["transactionNumber"] == "20000057"

    def test_documents_from_before_the_prefix_file_under_their_register(self, w):
        one, two = w.tills
        rows = [_doc(w, one, "57"), _doc(w, two, "57")]
        result = generate_tax_report(
            [transform_transaction_for_open_format(t, 18.0) for t in rows],
            BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        assert [_number(line).strip() for line in _records(result, "C100")] == [
            f"{one.pos_number}0000057", f"{two.pos_number}0000057",
        ]

    def test_the_longest_number_fits_the_field(self):
        assert len(DP.format_document_number("999", "9999999")) == 10 <= DOCUMENT_NUMBER_WIDTH
        assert len(DP.format_document_number("999", "9" * 16)) == DOCUMENT_NUMBER_WIDTH

    def test_a_320_and_a_330_of_one_number_are_two_documents_by_type(self, w):
        two = w.tills[1]
        rows = [_doc(w, two, "57", prefix="2"), _doc(w, two, "57", prefix="2", document_type=330)]
        result = generate_tax_report(
            [transform_transaction_for_open_format(t, 18.0) for t in rows],
            BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        c100 = _records(result, "C100")
        assert [(line[22:25], _number(line).strip()) for line in c100] == [("320", "20000057"), ("330", "20000057")]


# ── One series per document type ─────────────────────────────────────────────


class TestSeries:
    def test_the_database_computes_the_series_from_the_type(self, w):
        till = w.tills[1]
        cases = [(320, None), (330, None), (400, None), (-400, None), (None, None)]
        for n, (document_type, _) in enumerate(cases, start=1):
            tx = _doc(w, till, str(n), document_type=document_type)
            assert tx.document_series == DP.document_series_of(document_type, None)
        credit = _doc(w, till, "99", document_type=None, refund_of=uuid.uuid4())
        assert credit.document_series == 330

    def test_a_320_and_a_330_may_share_a_number_a_400_and_a_minus_400_may_not(self, w):
        from sqlalchemy.exc import IntegrityError

        till = w.tills[1]
        _doc(w, till, "57")
        _doc(w, till, "57", document_type=330)  # its own series: fine
        _doc(w, till, "57", document_type=400)
        with pytest.raises(IntegrityError):
            _doc(w, till, "57", document_type=-400)  # the 400 series again
        w.db.rollback()

    def test_the_highest_number_is_per_series(self, w):
        from app.services.shifts import highest_transaction_number, highest_transaction_numbers, last_closed_shift

        till = w.tills[1]
        for n in ("5", "12"):
            _doc(w, till, n)
        _doc(w, till, "3", document_type=330)
        _doc(w, till, "7", document_type=400)
        _doc(w, till, "8", document_type=-400)
        assert highest_transaction_numbers(w.db, till.id) == {"320": 12, "330": 3, "400": 8}
        assert highest_transaction_number(w.db, till.id) == 12
        dumped = last_closed_shift(w.db, till.id).model_dump(by_alias=True)
        assert dumped["highestTransactionNumbers"] == {"320": 12, "330": 3, "400": 8}
        assert dumped["highestTransactionNumber"] == 12  # what an older till reads


# ── Branch codes ──────────────────────────────────────────────────────────────


class TestBranchCodes:
    @pytest.fixture
    def shops(self, w, monkeypatch):
        from app.routers import shops as shops_router

        monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda *a, **k: None)
        monkeypatch.setattr(shops_router, "reconcile_shops", lambda *a, **k: set())
        monkeypatch.setattr(shops_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
        return shops_router

    def _create(self, w, shops, **body):
        from app.schemas.shop import ShopCreate

        return shops.create_shop(
            ShopCreate.model_validate({"name": "חדש", "companyId": str(w.company.id), **body}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def _update(self, w, shops, shop, **body):
        from app.schemas.shop import ShopUpdate

        return shops.update_shop(
            str(shop.id), ShopUpdate.model_validate(body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )

    def _refused(self, fn, *args, **kwargs):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as e:
            fn(*args, **kwargs)
        return e.value

    def test_a_new_shop_needs_a_code(self, w, shops):
        e = self._refused(self._create, w, shops)
        assert e.status_code == 400 and "קוד סניף הוא שדה חובה" in e.detail
        e = self._refused(self._create, w, shops, branchId="  ")
        assert e.status_code == 400

    @pytest.mark.parametrize("bad", ["A1", "12345678", "1-2", "١"])
    def test_digits_one_to_seven(self, w, shops, bad):
        e = self._refused(self._create, w, shops, branchId=bad)
        assert e.status_code == 400 and "ספרות בלבד" in e.detail

    def test_unique_in_the_company(self, w, shops):
        w.shop.branch_id = "5"
        w.db.commit()
        e = self._refused(self._create, w, shops, branchId="5")
        assert e.status_code == 409 and w.shop.name in e.detail
        assert self._create(w, shops, branchId="1234567").branch_id == "1234567"

    def test_another_company_may_use_the_same_code(self, w, shops):
        from app.models.company import Company
        from app.schemas.shop import ShopCreate

        w.shop.branch_id = "5"
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.commit()
        made = shops.create_shop(
            ShopCreate.model_validate({"name": "אחר", "companyId": str(other.id), "branchId": "5"}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert made.branch_id == "5"

    def test_an_update_may_change_it_never_clear_it_and_confirms_an_assigned_one(self, w, shops):
        w.shop.branch_id = "1"
        w.shop.branch_id_auto_assigned = True
        w.other_shop.branch_id = "2"
        w.db.commit()
        e = self._refused(self._update, w, shops, w.shop, branchId=None)
        assert e.status_code == 400
        e = self._refused(self._update, w, shops, w.shop, branchId="2")
        assert e.status_code == 409
        out = self._update(w, shops, w.shop, name="מרכז")
        assert out.branch_id_auto_assigned is True  # not saved: still to check
        out = self._update(w, shops, w.shop, branchId="1")
        assert (out.branch_id, out.branch_id_auto_assigned) == ("1", False)
        from app.schemas.shop import ShopResponse

        assert ShopResponse.model_validate(out).model_dump(by_alias=True)["branchIdAutoAssigned"] is False

    def test_the_shops_own_code_wins_over_a_settings_override(self, w):
        from app.services.settings_merge import build_business_info

        w.company.settings = {"businessInfo": {"branchId": "999"}}
        w.shop.branch_id = "3"
        assert build_business_info(w.company, w.shop).branch_id == "3"
        w.shop.branch_id = None
        assert build_business_info(w.company, w.shop).branch_id == "999"

    def test_the_lowest_free_code(self):
        from app.services.branch_code import lowest_free_code

        assert lowest_free_code([]) == "1"
        assert lowest_free_code(["1", "2", "4"]) == "3"
        assert lowest_free_code(["2", None]) == "1"


class TestExportBranches:
    def test_a_shop_without_a_code_stops_the_export(self, w):
        from fastapi import HTTPException

        from app.services.tax_reports import refuse_shops_without_branch_code

        tx = _doc(w, w.tills[1], "57", prefix="2")
        w.shop.branch_id = None
        w.db.flush()
        with pytest.raises(HTTPException) as e:
            refuse_shops_without_branch_code(w.db, [tx])
        assert e.value.status_code == 400 and w.shop.name in e.value.detail
        w.shop.branch_id = "1"
        w.db.flush()
        refuse_shops_without_branch_code(w.db, [tx])  # no error
        # A shop export covers its shop even with no documents in the window.
        w.other_shop.branch_id = None
        with pytest.raises(HTTPException):
            refuse_shops_without_branch_code(w.db, [], w.other_shop)

    def test_a_document_with_no_branch_files_under_its_shops_code(self, w):
        from app.services.tax_reports import document_branch_id

        w.shop.branch_id = "7"
        w.db.flush()
        old = _doc(w, w.tills[1], "57", prefix="2")  # stamped with none
        assert document_branch_id(old) == "7"
        old.branch_id = "3"
        assert document_branch_id(old) == "3"  # what the till stamped wins
        assert transform_transaction_for_open_format(old, 18.0)["branchId"] == "3"
