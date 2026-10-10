"""
"הדפס העתק עם פרטי לקוח" (docs/SPEC_CUSTOMER_INVOICE.md §3.5): the customer's details a till added to a
COPY of an issued document. The owner, 10.10.2026: printing a copy with the details, without changing
the recorded document, is allowed.

* the till's annotation lands once (idempotent), is the till's own, and is never another business's;
* the recorded document is not changed by it - the same row, lines and legs, the same uniform file;
* the dashboard shows it, labelled as added after issue, with who and when - oldest first, none lost;
* the document copy printed from the dashboard says so apart from the document's own details.
"""
from __future__ import annotations

import re
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException, Response

from app.models.tenant import Tenant
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.transaction import Transaction
from app.models.transaction_customer_details import TransactionCustomerDetails
from app.routers.document_customer_details import post_document_customer_details
from app.routers.transactions import get_transaction
from app.schemas.audit_exception import TillEventIn
from app.schemas.document_customer_details import DocumentCustomerDetailsIn
from app.services import print_documents as PD
from app.services import till_parameters as TP
from app.services.exceptions import TILL_EVENT_TYPES
from shift_world import NOW
from test_customer_invoice import _doc, _get, _open, _push, _report, w  # noqa: F401 — `w` is the fixture


def _body(transaction_id, *, id=None, minutes=0, **extra):
    data = {
        "id": str(id or uuid.uuid4()), "transactionId": str(transaction_id), "customerName": " אקמי בע״מ ",
        "customerVatNumber": "515-151-512", "customerAddress": "הרצל 1, תל אביב", "customerPhone": "03-5555555",
        "customerEmail": "books@acme.example", "addedById": "pos-user-7", "addedByName": "דנה",
        "addedAt": (NOW + timedelta(minutes=minutes)).isoformat(),
    }
    data.update(extra)
    return DocumentCustomerDetailsIn.model_validate(data)


def _post(w, till, body):
    response = Response()
    out = post_document_customer_details(machine_id=str(till.id), body=body, response=response, machine=till, db=w.db)
    return out, response.status_code


def _option(w, on=True, scope_type="shop", scope_id=None):
    """`invoiceCopyWithCustomerDetails` at one level of company -> shop -> area -> till."""
    TP.ensure_builtin_parameters(w.db)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "invoiceCopyWithCustomerDetails").one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type,
        scope_id=scope_id or w.shop.id, value=on,
    ))
    w.db.commit()


def _copy_rows(w, doc):
    w.db.expire_all()
    copy = PD.build_invoice_copy(w.db, _get(w, doc))
    return [(r.label, r.value) for s in copy.sections for r in s.rows]


def _row_of(db, model, key):
    """Every column of one row, as stored."""
    row = db.get(model, key)
    return {c.name: getattr(row, c.name) for c in model.__table__.columns}


def _snapshot(w, doc):
    """The recorded document as stored: its row, its lines and its legs, every column."""
    w.db.expire_all()
    tx = w.db.get(Transaction, uuid.UUID(doc["id"]))
    return (
        {c.name: getattr(tx, c.name) for c in Transaction.__table__.columns},
        sorted(({c.name: getattr(i, c.name) for c in i.__table__.columns} for i in tx.items), key=lambda r: str(r["id"])),
        sorted(({c.name: getattr(p, c.name) for c in p.__table__.columns} for p in tx.payments), key=lambda r: str(r["id"])),
    )


def _stable(result):
    """
    The file as filed, minus the one thing that is different on every run: the primary identifier the
    generator draws for each file (in A100, repeated in Z900 and in the INI).
    """
    ident = re.match(r"A100\d{18}(\d{15})", result.bkmv_content[0]).group(1)
    mask = lambda lines: [line.replace(ident, "<ID>") for line in lines]  # noqa: E731
    return mask(result.bkmv_content), mask(result.ini_content)


@pytest.fixture
def sale(w):
    till = w.tills[0]
    shift = _open(w, till)
    doc = _doc(shift.id, "117.00", ("cash", "60.00"), ("card", "57.00"))
    _push(w, till, [doc])
    return doc


class TestIngest:
    def test_it_lands_once_and_a_resend_is_a_no_op(self, w, sale):
        till = w.tills[0]
        body = _body(sale["id"])
        out, code = _post(w, till, body)
        assert (out.status, code) == ("accepted", 201)
        out, code = _post(w, till, body)
        assert (out.status, code) == ("duplicate", 200)
        assert w.db.query(TransactionCustomerDetails).count() == 1

    def test_it_is_stored_as_printed_with_who_and_when(self, w, sale):
        _post(w, w.tills[0], _body(sale["id"]))
        row = w.db.query(TransactionCustomerDetails).one()
        assert (row.customer_name, row.customer_vat_number) == ("אקמי בע״מ", "515151512")
        assert (row.customer_address, row.customer_phone, row.customer_email) == (
            "הרצל 1, תל אביב", "03-5555555", "books@acme.example")
        assert (row.added_by_id, row.added_by_name) == ("pos-user-7", "דנה")
        assert row.added_at is not None and row.machine_id == w.tills[0].id and row.tenant_id == w.tenant.id

    def test_a_number_is_never_repaired(self, w, sale):
        _post(w, w.tills[0], _body(sale["id"], customerVatNumber="515151516"))
        assert w.db.query(TransactionCustomerDetails).one().customer_vat_number == "515151516"

    def test_a_name_and_a_number_are_required(self):
        with pytest.raises(Exception):
            _body(uuid.uuid4(), customerName="  ")
        with pytest.raises(Exception):
            _body(uuid.uuid4(), customerVatNumber=" - ")

    def test_another_tills_id_is_a_conflict(self, w, sale):
        first, second = w.tills[0], w.tills[1]
        body = _body(sale["id"])
        _post(w, first, body)
        with pytest.raises(HTTPException) as refused:
            _post(w, second, body)
        assert (refused.value.status_code, refused.value.detail) == (409, "annotation_id_conflict")

    def test_another_businesses_document_is_a_conflict_and_a_later_one_is_fine(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        other = Tenant(id=uuid.uuid4(), name="Other", slug="o-details", timezone="Asia/Jerusalem")
        w.db.add(other)
        w.db.flush()
        foreign = w.doc(till, shift, "5.00")
        foreign.tenant_id = other.id
        w.db.flush()
        with pytest.raises(HTTPException) as refused:
            _post(w, till, _body(foreign.id))
        assert (refused.value.status_code, refused.value.detail) == (409, "document_not_yours")
        # A document that has not arrived yet: the annotation names it by id and may land first.
        out, code = _post(w, till, _body(uuid.uuid4()))
        assert (out.status, code) == ("accepted", 201)

    def test_the_till_event_and_the_parameter_exist(self):
        TillEventIn.model_validate({
            "id": str(uuid.uuid4()), "type": "document_customer_details", "occurredAt": NOW.isoformat(),
            "posUserId": "pos-user-7", "transactionId": str(uuid.uuid4()), "details": {"name": "אקמי"},
        })
        assert "document_customer_details" in TILL_EVENT_TYPES
        by_key = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        param = by_key["invoiceCopyWithCustomerDetails"]
        assert (param.value_type, param.default_value) == ("boolean", False)
        assert param.label == "הדפסת העתק עם פרטי לקוח (בלי שינוי המסמך)"


class TestTheRecordedDocumentIsNotChanged:
    def test_the_same_row_lines_and_legs_before_and_after(self, w, sale):
        before = _snapshot(w, sale)
        _post(w, w.tills[0], _body(sale["id"]))
        _post(w, w.tills[0], _body(sale["id"], minutes=30, customerName="עסק אחר", customerVatNumber="513570200"))
        after = _snapshot(w, sale)
        assert after == before
        # Nothing of the buyer reached the document: its own customer columns stay empty.
        row = _get(w, sale)
        assert (row.customer_name, row.customer_vat_number, row.customer_email) == (None, None, None)

    def test_the_uniform_file_is_the_same_with_and_without_the_annotation(self, w, sale):
        # The records are built from the document alone: none of them reads the annotation.
        without = _report(w, [_get(w, sale)])
        _post(w, w.tills[0], _body(sale["id"], customerVatNumber="123456782"))
        _post(w, w.tills[0], _body(sale["id"], minutes=5, customerName="עסק אחר", customerVatNumber="987654324"))
        with_annotation = _report(w, [_get(w, sale)])
        assert _stable(with_annotation) == _stable(without)
        c100 = [l for l in with_annotation.bkmv_content if l.startswith("C100")][0]
        assert c100[57:107].strip() == "לקוח כללי" and c100[252:261] == "000000000"  # 1207 and 1215: the walk-in, as issued
        assert not any(t in l for l in with_annotation.bkmv_content for t in ("123456782", "987654324", "אקמי", "עסק אחר"))

    def test_a_document_that_names_a_buyer_files_that_buyer_not_the_annotation(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        doc = _doc(shift.id, "50.00", ("cash", "50.00"), customerName="Printed", customerVatNumber="513570200")
        _push(w, till, [doc])
        without = _report(w, [_get(w, doc)])
        _post(w, till, _body(doc["id"]))
        assert _stable(_report(w, [_get(w, doc)])) == _stable(without)
        c100 = [l for l in without.bkmv_content if l.startswith("C100")][0]
        assert c100[57:107].strip() == "Printed" and c100[252:261] == "513570200"


class TestTheDashboard:
    def _detail(self, w, doc):
        return get_transaction(
            transaction_id=uuid.UUID(doc["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def test_the_detail_lists_every_time_with_who_and_when_oldest_first(self, w, sale):
        assert self._detail(w, sale).customer_details_added == []
        _post(w, w.tills[0], _body(sale["id"], minutes=30, addedByName="יוסי", customerName="עסק שני"))
        _post(w, w.tills[0], _body(sale["id"], minutes=0))
        added = self._detail(w, sale).model_dump(by_alias=True, mode="json")["customerDetailsAdded"]
        assert [a["customerName"] for a in added] == ["אקמי בע״מ", "עסק שני"]
        assert [a["addedByName"] for a in added] == ["דנה", "יוסי"]
        assert added[0]["customerVatNumber"] == "515151512" and added[0]["addedAt"] and added[0]["receivedAt"]

    def test_the_documents_own_details_are_apart_from_them(self, w, sale):
        _post(w, w.tills[0], _body(sale["id"]))
        detail = self._detail(w, sale).model_dump(by_alias=True, mode="json")
        assert detail["customerName"] is None and detail["customerVatNumber"] is None
        assert detail["customerDetailsAdded"][0]["customerName"] == "אקמי בע״מ"

    def test_the_copy_says_they_were_added_after_issue_and_by_whom(self, w, sale):
        _option(w)
        assert not any("נוספו" in (label or "") for label, _ in _copy_rows(w, sale))
        _post(w, w.tills[0], _body(sale["id"]))
        rows = _copy_rows(w, sale)
        heading = [label for label, _ in rows if label.startswith("פרטי לקוח נוספו בתאריך")]
        assert len(heading) == 1 and heading[0].endswith("ע״י דנה")
        assert ("  שם הלקוח", "אקמי בע״מ") in rows and ("  ח.פ. / ע.מ. לקוח", "515151512") in rows
        # Apart from the document's own: it printed no customer of its own.
        assert ("שם הלקוח", "אקמי בע״מ") not in rows

    def test_the_copy_follows_the_tills_parameter_off_by_default_and_the_most_specific_level_wins(self, w, sale):
        till = w.tills[0]
        _post(w, till, _body(sale["id"]))
        # Recorded, but the option was never turned on: a copy prints none of it.
        assert not any("נוספו" in (label or "") for label, _ in _copy_rows(w, sale))
        _option(w, True)
        assert any((label or "").startswith("פרטי לקוח נוספו בתאריך") for label, _ in _copy_rows(w, sale))
        # Off at the till itself, over the shop's on: the till's own level is the more specific.
        _option(w, False, scope_type="machine", scope_id=till.id)
        assert not any("נוספו" in (label or "") for label, _ in _copy_rows(w, sale))
        # ... and the dashboard's detail still lists it: the audit does not depend on the option.
        added = get_transaction(
            transaction_id=uuid.UUID(sale["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        ).customer_details_added
        assert len(added) == 1

    def test_a_credit_note_never_carries_them(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        sale = _doc(shift.id, "30.00", ("cash", "30.00"))
        credit = _doc(shift.id, "30.00", ("cash", "30.00"), doc_type=330, minutes=5, refundOfTransactionId=sale["id"])
        _push(w, till, [sale, credit])
        _option(w)
        _post(w, till, _body(credit["id"]))
        copy = PD.build_invoice_copy(w.db, _get(w, credit))
        assert not any("נוספו" in (r.label or "") for s in copy.sections for r in s.rows)
