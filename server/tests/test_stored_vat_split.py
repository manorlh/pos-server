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


def _tx(net=None, vat=None, document_discount=None, items=None):
    return SimpleNamespace(
        net_amount=Decimal(net) if net is not None else None,
        vat_amount=Decimal(vat) if vat is not None else None,
        vat_rate=None,
        document_discount=Decimal(document_discount) if document_discount is not None else None,
        items=items if items is not None else [_item("100.00")],
    )


class TestTheFilingStaysOnTheGrossConvention:
    """
    The stored split is deliberately *not* wired into the OpenFormat export.

    That block's fields are gross with the discount carried separately: `totalAmount`
    becomes C100 field 1223, `subtotal` becomes 1219 and 1220/1221 subtract the discount
    from it, and D120 leg amounts are scaled to `totalAmount` so the payment records sum
    to the document record. Feeding the post-discount split in would subtract the
    discount twice and desynchronise D120 from C100 — a corrupted legal filing.

    These tests exist so that "obvious improvement" is not made by accident. Changing
    what a filing declares needs the owner's accountant.
    """

    def test_the_document_total_is_the_gross_line_sum_not_the_stored_split(self):
        cart = _build_cart_from_items(
            _tx(net="8.47", vat="1.53", document_discount="2.00",
                items=[_item("12.00")]).items,
            global_tax_rate=18.0,
        )

        assert cart["totalAmount"] == 12.00
        assert round(cart["subtotal"], 2) == 10.17
        assert round(cart["taxAmount"], 2) == 1.83

    def test_the_discount_is_carried_by_c100_not_folded_into_the_cart(self):
        """`discountAmount` stays 0 here; fields 1220/1221 apply `documentDiscount`."""
        cart = _build_cart_from_items(
            _tx(document_discount="2.00", items=[_item("12.00")]).items,
            global_tax_rate=18.0,
        )

        assert cart["discountAmount"] == 0

    def test_subtotal_and_tax_still_sum_to_the_document_total(self):
        cart = _build_cart_from_items(_tx(items=[_item("118.00")]).items, global_tax_rate=18.0)

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
