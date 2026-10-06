"""
"קידומת מסמכים" — every till prints and exports its document numbers under its own prefix
(docs/SPEC_DOCUMENT_PREFIX.md).

* The rule: digits, 1–3; shown as `<prefix>-<number>`. The default is the register number.
* Unique among the tills of a shop (and of shops filed under the same branch code), and
  never again once another till's documents carry it. A Hebrew 409 otherwise.
* Frozen at issue: the till sends the prefix with the document; the cloud stores it and a
  re-push never changes it. A document without one reads as its register number.
* Everywhere a number is shown: the dashboard reads, the cloud reprint (with "קופה N"),
  the Z's document range, the till-facing shop list, and the lookup `2-57`.
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
    def test_the_format(self):
        assert DP.format_document_number("2", "57") == "2-57"
        assert DP.format_document_number(None, "57") == "57"
        assert DP.format_document_number(" ", "57") == "57"
        # Only a plain counter takes a prefix: never twice, never on a training number.
        assert DP.format_document_number("2", "2-57") == "2-57"
        assert DP.format_document_number("2", "ה-12") == "ה-12"

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
        ("2-57", DP.DocumentQuery("2", "57")),
        (" 2 - 57 ", DP.DocumentQuery("2", "57")),
        ("2–57", DP.DocumentQuery("2", "57")),
        ("57", DP.DocumentQuery(None, "57")),
        ("1234-5", None),
        ("abc", None),
        ("", None),
    ])
    def test_the_lookup_reads_prefix_dash_number(self, text, expected):
        assert DP.parse_document_query(text) == expected


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

    def test_another_shop_is_another_series(self, w):
        status = _put(w, w.other_till, documentPrefix=w.tills[1].pos_number)
        assert not isinstance(status, JSONResponse)

    def test_shops_filed_under_one_branch_code_share_the_rule(self, w):
        w.shop.branch_id = "001"
        w.other_shop.branch_id = "001"
        w.db.commit()
        status, _ = _refused(_put(w, w.other_till, documentPrefix=w.tills[1].pos_number))
        assert status == 409
        w.other_shop.branch_id = "002"
        w.db.commit()
        assert not isinstance(_put(w, w.other_till, documentPrefix=w.tills[1].pos_number), JSONResponse)

    def test_a_new_till_whose_register_number_is_held_gets_a_free_prefix(self, w):
        one, two = w.tills
        _put(w, one, documentPrefix="3")
        # A third till drawing register number 3 would print 3-1, 3-2… like till 1 does now.
        from app.models.pos_machine import PairingStatus, POSMachine

        three = POSMachine(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
            name="Till 3", machine_code="M-NEW", pos_number="3", is_active=True,
            pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(three)
        w.db.flush()
        assert DP.settle_default(w.db, three) == str(DP.AUTO_PREFIX_START)
        assert three.effective_document_prefix == str(DP.AUTO_PREFIX_START)
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
        assert tx.document_number == "2-57"


# ── Shown everywhere ─────────────────────────────────────────────────────────


class TestDisplay:
    def test_the_dashboard_reads_show_prefix_dash_number(self, w):
        tx = _doc(w, w.tills[1], "57", prefix="2")
        old = _doc(w, w.tills[0], "57")  # before the prefix: reads as its register
        for schema in (TransactionOut, TransactionListItem, BasketDocumentOut):
            assert schema.model_validate(tx).model_dump(by_alias=True)["documentNumber"] == "2-57"
            assert schema.model_validate(old).model_dump(by_alias=True)["documentNumber"] == f"{w.tills[0].pos_number}-57"
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
        assert rows["מס׳ מסמך"] == "2-58"
        assert rows["זיכוי עבור מסמך"] == "2-57"
        assert rows["קופה"].startswith(till.pos_number)
        assert doc.title.endswith("2-58")

    def test_the_dashboard_detail_names_the_original_as_printed(self, w):
        from app.routers.transactions import get_transaction

        till = w.tills[1]
        sale = _doc(w, till, "57", prefix="2")
        credit = _doc(w, till, "58", prefix="2", document_type=330, refund_of=sale.id)
        out = get_transaction(
            transaction_id=credit.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert (out.document_number, out.refund_of_transaction_number) == ("2-58", "2-57")

    def test_the_z_range_is_shown_as_printed(self, w):
        till = w.tills[1]
        shift = w.shift(till, 1)
        for n in ("9", "10", "11"):
            _doc(w, till, n, prefix="2", shift_id=shift.id)
        totals = compute_totals(w.db, [shift.id])
        assert (totals.first_transaction_number, totals.last_transaction_number) == ("2-9", "2-11")

    def test_an_older_tills_z_range_is_not_a_discrepancy(self):
        assert _same_document_number("2-57", "2-57")
        assert _same_document_number("57", "2-57")  # a till build from before the prefix
        assert not _same_document_number("2-57", "3-57")
        assert not _same_document_number("58", "2-57")
        assert not _same_document_number("57", None)


# ── Lookup ────────────────────────────────────────────────────────────────────


class TestLookup:
    def _search(self, w, q):
        query = w.db.query(Transaction).filter(Transaction.tenant_id == w.tenant.id)
        return sorted(t.document_number for t in _search_filters(query, q=q).all())

    def test_prefix_dash_number_finds_that_tills_document_only(self, w):
        one, two = w.tills
        _doc(w, one, "57", prefix=one.pos_number)
        _doc(w, two, "57", prefix=two.pos_number)
        _doc(w, two, "157", prefix=two.pos_number)
        assert self._search(w, f"{two.pos_number}-57") == [f"{two.pos_number}-57"]
        # The bare number is still the substring search, over every till.
        assert len(self._search(w, "57")) == 3

    def test_an_old_document_is_found_by_its_register_number(self, w):
        two = w.tills[1]
        _doc(w, two, "57", prefix=None)
        assert self._search(w, f"{two.pos_number}-57") == [f"{two.pos_number}-57"]


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
        assert c100 == ["1-57".ljust(20), "2-57".ljust(20), "2-58".ljust(20)]
        assert len(set(c100)) == 3
        # Every line and every payment carries its header's number, in the same order.
        assert [_number(line) for line in _records(result, "D110")] == c100
        assert [_number(line) for line in _records(result, "D120")] == c100
        # The credit note's line names its base document as printed: D110 1256/1257.
        credit_line = _records(result, "D110")[2]
        base_at = NUMBER_AT + DOCUMENT_NUMBER_WIDTH + 4  # after the line number (1255)
        assert credit_line[base_at:base_at + 3] == "320"
        assert credit_line[base_at + 3:base_at + 23] == "2-57".ljust(20)

    def test_an_original_outside_the_export_is_named_the_same_way(self, w):
        two = w.tills[1]
        original = _doc(w, two, "57", prefix="2", created_at=datetime(2025, 12, 31, tzinfo=timezone.utc))
        credit = _doc(w, two, "58", prefix="2", document_type=330, refund_of=original.id)
        bases = load_base_documents(w.db, w.tenant.id, [credit])
        tx = transform_transaction_for_open_format(credit, 18.0, bases)
        assert tx["transactionNumber"] == "2-58"
        assert tx["baseDocument"]["transactionNumber"] == "2-57"

    def test_documents_from_before_the_prefix_file_under_their_register(self, w):
        one, two = w.tills
        rows = [_doc(w, one, "57"), _doc(w, two, "57")]
        result = generate_tax_report(
            [transform_transaction_for_open_format(t, 18.0) for t in rows],
            BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        assert [_number(line).strip() for line in _records(result, "C100")] == [
            f"{one.pos_number}-57", f"{two.pos_number}-57",
        ]

    def test_the_longest_number_fits_the_field(self):
        assert len(DP.format_document_number("999", "9" * 16)) == DOCUMENT_NUMBER_WIDTH
