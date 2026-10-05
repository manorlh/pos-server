"""
Reprints from the cloud: `GET /transactions/{id}/print-document`.

* `kind=invoice` is a copy of the tax document — whatever type it is — with the
  business header, its lines, VAT, tenders, tip and change, and always "העתק".
* `kind=card_slip` is the card voucher of each card payment, built only from the
  acquirer reply the till synced; `paymentId` picks one.
* Same scoping as the detail read: another tenant's document is a 404. A cash-only
  document has no voucher: 404 with a detail that says so.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.pos_user import PosUser
from app.models.tenant import Tenant
from app.models.transaction import TransactionStatus
from app.models.transaction_item import TransactionItem
from app.routers.transactions import get_print_document
from app.schemas.print_document import PrintDocumentListOut, PrintDocumentOut
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _print(w, tx, kind, payment_id=None, tenant_id=None):
    return get_print_document(
        transaction_id=tx.id, kind=kind, payment_id=payment_id,
        current_user=w.admin, active_tenant_id=tenant_id or w.tenant.id, db=w.db,
    )


def _rows(doc: PrintDocumentOut) -> dict:
    return {r.label: r.value for s in doc.sections for r in s.rows}


def _card_meta(last4="4242", auth="0424242", uid="UID-1", **extra):
    meta = {
        "vuid": "6220000000001", "uid": uid, "authNum": auth, "cardLast4": last4,
        "statusCode": 0, "outcome": "approved", "keyed": False,
        "result": {"statusCode": 0, "uid": uid, "issuerAuthNum": auth,
                   "cardNumber": f"************{last4}", "mutag": 2, "transactionId": "0000000000042"},
    }
    meta.update(extra)
    return meta


def _with_card_meta(w, tx, *metas):
    card_legs = [p for p in tx.payments if p.method == "card"]
    for leg, meta in zip(card_legs, metas):
        leg.nayax_meta = meta
        leg.terminal_uid = meta.get("uid")
    w.db.flush()


def _sale(w, total="117.00", **kw):
    tx = w.doc(w.tills[0], None, total, **kw)
    tx.net_amount = Decimal("99.15")
    tx.vat_amount = Decimal("17.85")
    tx.vat_rate = Decimal("0.18")
    w.db.add(TransactionItem(
        id=uuid.uuid4(), transaction_id=tx.id, product_name="Coffee",
        quantity=Decimal("2"), unit_price=Decimal("58.50"), total_price=Decimal(total),
    ))
    w.db.flush()
    w.db.refresh(tx)
    return tx


class TestInvoiceCopy:
    def test_it_is_a_marked_copy_of_the_tax_document(self, w):
        cashier = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id,
                          username="dana", first_name="Dana", last_name="Levi", pin_hash="x")
        w.db.add(cashier)
        tx = _sale(w, method="card", tip="5.00", tip_method="card")
        tx.cashier_id = str(cashier.id)
        _with_card_meta(w, tx, _card_meta())

        doc = _print(w, tx, "invoice")

        assert isinstance(doc, PrintDocumentOut)
        assert doc.copy_mark == "העתק"
        assert doc.title == f"חשבונית מס/קבלה {tx.transaction_number}"
        assert doc.business_name == "Acme"
        assert any("515151515" in line for line in doc.subtitle)
        rows = _rows(doc)
        assert rows["מס׳ מסמך"] == tx.transaction_number
        assert rows["קופאי/ת"] == "Dana Levi"
        assert rows["קופה"].startswith("1")
        assert rows["Coffee ×2"] == "₪117.00"
        assert rows['מע"מ 18%'] == "₪17.85"
        assert rows['סה"כ לפני מע"מ'] == "₪99.15"
        assert rows['סה"כ לתשלום'] == "₪117.00"
        assert rows["כרטיס אשראי ****4242"] == "₪117.00"
        assert rows["תשר (כרטיס אשראי)"] == "₪5.00"
        assert any("העתק" in line for line in doc.footer)
        body = doc.model_dump(by_alias=True)
        assert {"title", "copyMark", "businessName", "subtitle", "sections", "footer"} <= set(body)
        assert set(body["sections"][0]["rows"][0]) == {"label", "value", "emphasis"}

    def test_discount_and_cash_change(self, w):
        tx = _sale(w, "120.00", discount="3.00", method="cash")
        tx.amount_tendered = Decimal("200.00")
        tx.change_amount = Decimal("83.00")
        w.db.flush()

        rows = _rows(_print(w, tx, "invoice"))

        assert rows['סה"כ פריטים'] == "₪120.00"
        assert rows["הנחה"] == "-₪3.00"
        assert rows['סה"כ לתשלום'] == "₪117.00"
        assert rows["מזומן"] == "₪117.00"
        assert rows["התקבל"] == "₪200.00"
        assert rows["עודף"] == "₪83.00"

    def test_a_credit_note_is_titled_as_one(self, w):
        original = _sale(w)
        credit = w.doc(w.tills[0], None, "40.00", credit_note=True, method="cash")
        credit.refund_of_transaction_id = original.id
        w.db.flush()

        doc = _print(w, credit, "invoice")

        assert doc.title.startswith("חשבונית זיכוי")
        rows = _rows(doc)
        assert rows["סכום זיכוי"] == "₪40.00"
        assert rows["זיכוי עבור מסמך"] == original.transaction_number


class TestCardSlip:
    def test_one_voucher_per_card_payment(self, w):
        tx = _sale(w, legs=[("cash", "17.00"), ("card", "60.00"), ("card", "40.00")])
        w.tills[0].terminal_number = "0882345"
        w.tills[0].terminal_merchant_name = "ACME COFFEE"
        _with_card_meta(
            w, tx,
            _card_meta(last4="1111", auth="111", uid="U-1"),
            _card_meta(last4="2222", auth="222", uid="U-2", creditPayments=3, firstPaymentAmount=1334),
        )

        out = _print(w, tx, "card_slip")

        assert isinstance(out, PrintDocumentListOut)
        assert len(out.documents) == 2
        first, second = out.documents
        assert first.copy_mark == "העתק" and first.title == "שובר אשראי"
        assert first.business_name == "ACME COFFEE"
        a, b = _rows(first), _rows(second)
        assert a["כרטיס"] == "ויזה ****1111"
        assert a["סכום"] == "₪60.00"
        assert a["מס׳ אישור"] == "111"
        assert a["מס׳ שובר (UID)"] == "U-1"
        assert a["מס׳ מסוף"] == "0882345"
        assert a["סוג עסקה"] == "חיוב (מכירה)"
        assert a["אופן ביצוע"] == "כרטיס נוכח"
        assert a["תשלום"] == "1 מתוך 2"
        assert b["סכום"] == "₪40.00"
        assert b["מס׳ תשלומים"] == "3"
        assert b["תשלום ראשון"] == "₪13.34"
        assert any(line.startswith("חתימת הלקוח:") for line in first.footer)

    def test_payment_id_selects_one(self, w):
        tx = _sale(w, legs=[("card", "60.00"), ("card", "57.00")])
        _with_card_meta(w, tx, _card_meta(uid="U-1"), _card_meta(uid="U-2", authNum="999"))
        second = [p for p in tx.payments if p.sequence == 2][0]

        doc = _print(w, tx, "card_slip", payment_id=second.id)

        assert isinstance(doc, PrintDocumentOut)
        assert _rows(doc)["מס׳ אישור"] == "999"

    def test_a_refund_voucher(self, w):
        credit = w.doc(w.tills[0], None, "40.00", credit_note=True, method="card")
        _with_card_meta(w, credit, _card_meta())

        doc = _print(w, credit, "card_slip").documents[0]

        assert doc.title == "שובר זיכוי אשראי"
        assert _rows(doc)["סוג עסקה"] == "זיכוי"

    def test_only_synced_fields_are_printed(self, w):
        tx = _sale(w, method="card")
        _with_card_meta(w, tx, {"authNum": "77"})

        rows = _rows(_print(w, tx, "card_slip").documents[0])

        assert rows["מס׳ אישור"] == "77"
        for missing in ("כרטיס", "מס׳ מסוף", "אופן ביצוע", "מס׳ שובר (UID)", "מס׳ תשלומים"):
            assert missing not in rows

    def test_a_cash_only_document_has_no_voucher(self, w):
        tx = _sale(w, method="cash")

        with pytest.raises(HTTPException) as exc:
            _print(w, tx, "card_slip")

        assert exc.value.status_code == 404
        assert "no card payment" in exc.value.detail

    def test_a_declined_tap_has_no_voucher(self, w):
        tx = _sale(w, method="card", status=TransactionStatus.CANCELLED)

        with pytest.raises(HTTPException) as exc:
            _print(w, tx, "card_slip")

        assert exc.value.status_code == 404

    def test_an_unknown_payment_id_is_404(self, w):
        tx = _sale(w, method="card")

        with pytest.raises(HTTPException) as exc:
            _print(w, tx, "card_slip", payment_id=uuid.uuid4())

        assert exc.value.status_code == 404


class TestTheWireShape:
    def test_the_route_serialises_both_shapes_by_alias(self, w):
        """What FastAPI does with the route's Union response model."""
        from typing import Union

        from pydantic import TypeAdapter

        tx = _sale(w, legs=[("card", "60.00"), ("card", "57.00")])
        _with_card_meta(w, tx, _card_meta(uid="U-1"), _card_meta(uid="U-2"))
        adapter = TypeAdapter(Union[PrintDocumentOut, PrintDocumentListOut])

        many = adapter.dump_python(adapter.validate_python(_print(w, tx, "card_slip")), by_alias=True)
        one = adapter.dump_python(adapter.validate_python(_print(w, tx, "invoice")), by_alias=True)

        assert len(many["documents"]) == 2 and many["documents"][0]["copyMark"] == "העתק"
        assert one["copyMark"] == "העתק" and "documents" not in one


class TestScoping:
    @pytest.mark.parametrize("kind", ["invoice", "card_slip"])
    def test_another_tenants_document_is_404(self, w, kind):
        tx = _sale(w, method="card")
        other = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
        w.db.add(other)
        w.db.flush()

        with pytest.raises(HTTPException) as exc:
            _print(w, tx, kind, tenant_id=other.id)

        assert exc.value.status_code == 404
        assert exc.value.detail == "Transaction not found"
