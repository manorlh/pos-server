"""
The net/VAT split is stored on the document instead of derived when it is read.

It used to be derived at export time from the gross and the rate configured *at the
moment of export*. That makes a rate change rewrite history: Israel moved 17% → 18% in
January 2025, so a filing produced after that date would have re-stated every document
issued before it, and disagreed with every receipt already in a customer's hands.
"""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.services.tax_reports import _build_cart_from_items
from app.services.transactions import _serialize_tx_for_upsert, _vat_split


def _item(total_price, unit_price=None, discount=None):
    return SimpleNamespace(
        id="i1",
        product_id=None,
        sku="s",
        product_name="p",
        quantity=Decimal("1"),
        unit_price=Decimal(unit_price if unit_price is not None else total_price),
        total_price=Decimal(total_price),
        discount=Decimal(discount) if discount is not None else None,
        line_discount=None,
        transaction_type=2,
    )


def _tx(net=None, vat=None, document_discount=None, items=None, document_type=320):
    return SimpleNamespace(
        document_type=document_type,
        refund_of_transaction_id=None,
        net_amount=Decimal(net) if net is not None else None,
        vat_amount=Decimal(vat) if vat is not None else None,
        vat_rate=None,
        document_discount=Decimal(document_discount) if document_discount is not None else None,
        items=items if items is not None else [_item("100.00")],
    )


class TestTheFilingUsesTheStoredSplit:
    """
    The export now uses the document's stored split.

    This class previously asserted the opposite — that the filing deliberately stayed on
    the pre-discount gross — as a guard against "improving" a tax export whose field
    semantics had not been checked against the spec. Reading the spec (מבנה אחיד 1.31,
    C100 section 4.3) settled it: 1221 is "לאחר הנחות ללא מע\"מ", 1222 is the document's
    VAT and 1223 is "כולל מע\"מ", so the gross reading was not a defensible convention,
    it was wrong. The guard did its job — it stopped the change being made blind — and
    the detailed identity tests now live in tests/test_open_format_discount.py.
    """

    def test_the_document_total_is_what_was_settled(self):
        cart = _build_cart_from_items(
            _tx(net="8.47", vat="1.53", document_discount="2.00", items=[_item("12.00")]),
            global_tax_rate=18.0,
        )

        assert cart["totalAmount"] == 10.00
        assert cart["subtotal"] == 8.47
        assert cart["taxAmount"] == 1.53

    def test_the_discount_is_carried_so_c100_can_rebuild_field_1219(self):
        cart = _build_cart_from_items(
            _tx(document_discount="2.00", items=[_item("12.00")]), global_tax_rate=18.0
        )

        assert cart["discountAmount"] == 2.00

    def test_subtotal_and_tax_still_sum_to_the_document_total(self):
        cart = _build_cart_from_items(_tx(items=[_item("118.00")]), global_tax_rate=18.0)

        assert round(cart["subtotal"] + cart["taxAmount"], 2) == cart["totalAmount"]


class TestVatSplitFromTheTill:
    def test_the_tills_figures_are_stored_as_sent(self):
        tx = SimpleNamespace(
            net_amount=Decimal("67.80"),
            vat_amount=Decimal("12.20"),
            vat_rate=Decimal("0.18"),
        )

        assert _vat_split(tx) == {
            "net_amount": Decimal("67.80"),
            "vat_amount": Decimal("12.20"),
            "vat_rate": Decimal("0.18"),
        }

    def test_an_older_till_gets_nulls_rather_than_a_server_guess(self):
        tx = SimpleNamespace(net_amount=None, vat_amount=None, vat_rate=None)

        assert _vat_split(tx) == {
            "net_amount": None,
            "vat_amount": None,
            "vat_rate": None,
        }

    def test_a_rate_without_the_amounts_is_not_enough_to_store_a_split(self):
        tx = SimpleNamespace(net_amount=None, vat_amount=None, vat_rate=Decimal("0.18"))

        assert _vat_split(tx)["vat_rate"] is None


class TestPosNumberOnTheDocument:
    def _serialize(self, machine):
        tx = SimpleNamespace(
            id="t1",
            transaction_number="1",
            status="completed",
            document_type=320,
            document_production_date=None,
            payment_method="cash",
            amount_tendered=None,
            change_amount=None,
            total_amount=Decimal("80.00"),
            net_amount=Decimal("67.80"),
            vat_amount=Decimal("12.20"),
            vat_rate=Decimal("0.18"),
            tip_amount=None,
            tip_payment_method=None,
            total_discount=None,
            document_discount=None,
            wht_deduction=None,
            customer_id=None,
            cashier_id="u1",
            branch_id=None,
            notes=None,
            refund_of_transaction_id=None,
            nayax_meta=None,
            created_at=None,
            updated_at=None,
        )
        return _serialize_tx_for_upsert(
            tx, machine, trading_day_id=None, payment_method="cash", customer_ref_id=None
        )

    def test_the_merchants_register_number_wins(self):
        machine = SimpleNamespace(
            id="m", tenant_id="t", shop_id="s", pos_number="3", machine_code="POS-AB12"
        )

        assert self._serialize(machine)["pos_number"] == "3"

    def test_the_pairing_code_stands_in_until_one_is_assigned(self):
        """
        Never empty. A document with no register on it is the failure this field exists
        to prevent, and `machine_code` does identify the terminal — just not in the
        numbering a bookkeeper uses.
        """
        machine = SimpleNamespace(
            id="m", tenant_id="t", shop_id="s", pos_number=None, machine_code="POS-AB12"
        )

        assert self._serialize(machine)["pos_number"] == "POS-AB12"

    def test_the_split_travels_with_the_document(self):
        machine = SimpleNamespace(
            id="m", tenant_id="t", shop_id="s", pos_number="3", machine_code="POS-AB12"
        )
        row = self._serialize(machine)

        assert row["net_amount"] == Decimal("67.80")
        assert row["vat_amount"] == Decimal("12.20")
        assert row["vat_rate"] == Decimal("0.18")
        assert row["net_amount"] + row["vat_amount"] == row["total_amount"]
