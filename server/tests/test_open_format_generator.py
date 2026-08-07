"""Unit tests for OPEN FORMAT tax report generator (parity with pos-desktop vitest)."""

from datetime import datetime, timezone

import pytest

from app.services.open_format.defaults import SoftwareInfo, TaxReportConfig
from app.services.open_format.tax_report_generator import (
    build_a100_record,
    build_b110_record,
    build_c100_record,
    build_d110_record,
    build_d120_record,
    build_m100_record,
    build_summary_record,
    build_z900_record,
    collect_unique_products_for_m100,
    format_amount,
    format_amount12,
    format_date,
    format_open_format_link_id,
    format_quantity_signed,
    format_time,
    generate_tax_report,
    pad_left,
    pad_right,
)

NOW = datetime(2026, 3, 27, 14, 0, 0, tzinfo=timezone.utc)

BUSINESS_INFO = {
    "vatNumber": "123456789",
    "companyName": "Test Company",
    "companyAddress": "Main Street",
    "companyAddressNumber": "10",
    "companyCity": "Tel Aviv",
    "companyZip": "6100000",
    "companyRegNumber": "514000000",
    "withholdingFileNumber": "000000000",
    "hasBranches": False,
}

SOFTWARE_INFO = SoftwareInfo(
    name="POS Desktop",
    version="1.0.0",
    registration_number="12345678",
    manufacturer_id="987654321",
    manufacturer_name="Dev Co",
    software_type="multi-year",
)

TAX_REPORT_CONFIG = TaxReportConfig(
    system_code="&OF1.31&",
    accounting_type="1",
    balancing_required=False,
    language_code="0",
    charset="1",
    compression_software="zip",
    default_currency="ILS",
)


def make_cart(items, tax_rate=0.18):
    total_with_tax = sum(i["totalPrice"] for i in items)
    subtotal = total_with_tax / (1 + tax_rate)
    tax_amount = total_with_tax - subtotal
    return {
        "id": "cart-1",
        "items": items,
        "subtotal": subtotal,
        "taxAmount": tax_amount,
        "discountAmount": 0,
        "totalAmount": total_with_tax,
    }


def make_transaction(**overrides):
    item1 = {
        "id": "item-1",
        "productId": "p1",
        "product": {"id": "p1", "sku": "TST-001", "name": "Widget A"},
        "quantity": 1,
        "unitPrice": 59.0,
        "totalPrice": 59.0,
        "transactionType": 2,
    }
    item2 = {
        "id": "item-2",
        "productId": "p2",
        "product": {"id": "p2", "sku": "TST-002", "name": "Widget B"},
        "quantity": 1,
        "unitPrice": 29.5,
        "totalPrice": 29.5,
        "transactionType": 2,
    }
    cart = make_cart([item1, item2])
    base = {
        "id": "tx-1",
        "transactionNumber": "INV260327000001",
        "cart": cart,
        "status": "completed",
        "cashier": {"id": "user-1", "name": "Cashier"},
        "createdAt": NOW.isoformat(),
        "documentType": 320,
        "documentProductionDate": NOW.isoformat(),
    }
    base.update(overrides)
    return base


class TestFormattingHelpers:
    def test_pad_right(self):
        assert pad_right("AB", 5) == "AB   "
        assert pad_right("ABCDEF", 4) == "ABCD"

    def test_pad_left(self):
        assert pad_left("42", 5) == "00042"

    def test_format_amount(self):
        assert len(format_amount(0)) == 15
        assert format_amount(56.98) == "+00000000005698"
        assert format_amount(-12.50) == "-00000000001250"
        assert format_amount(0) == "+00000000000000"

    def test_format_amount12(self):
        assert len(format_amount12(0)) == 12
        assert format_amount12(42.50) == "+00000004250"

    def test_format_quantity_signed(self):
        assert len(format_quantity_signed(0)) == 17
        assert format_quantity_signed(1) == "+0000000000010000"

    def test_format_date(self):
        assert format_date(datetime(2026, 3, 27)) == "20260327"

    def test_format_time(self):
        assert format_time(datetime(2026, 3, 27, 14, 5)) == "1405"

    def test_format_open_format_link_id(self):
        assert format_open_format_link_id(1) == "0000001"


class TestRecordLengths:
    def test_lengths(self):
        vat = "123456789"
        uid = "000000000000001"
        tx = make_transaction()
        link = "0000001"
        assert len(build_a100_record(vat, uid, 1)) == 95
        assert len(build_b110_record(vat, 2, BUSINESS_INFO)) == 376
        assert len(build_c100_record(tx, vat, 3, link)) == 444
        assert len(build_d110_record(tx, tx["cart"]["items"][0], 1, vat, 4, 18, link)) == 339
        assert len(build_d120_record(tx, 1, vat, 5, link)) == 222
        assert len(build_m100_record(vat, 6, {"sku": "TST-001", "name": "Widget"})) == 298
        assert len(build_z900_record(vat, uid, 10, 7)) == 110


class TestC100Arithmetic:
    def _parse(self, record):
        return {
            "f1219": record[287:302],
            "f1220": record[302:317],
            "f1221": record[317:332],
            "f1222": record[332:347],
            "f1223": record[347:362],
        }

    def _signed(self, s):
        sign = -1 if s[0] == "-" else 1
        return sign * int(s[1:])

    def test_math_holds(self):
        tx = make_transaction()
        record = build_c100_record(tx, "123456789", 1, "0000001", global_tax_rate=18)
        f = self._parse(record)
        v1219 = self._signed(f["f1219"])
        v1220 = self._signed(f["f1220"])
        v1221 = self._signed(f["f1221"])
        v1222 = self._signed(f["f1222"])
        v1223 = self._signed(f["f1223"])
        assert v1221 == v1219 + v1220
        assert v1223 == v1221 + v1222


class TestGenerateTaxReport:
    def test_record_ordering(self):
        txs = [
            make_transaction(id="tx-1", transactionNumber="INV001"),
            make_transaction(id="tx-2", transactionNumber="INV002"),
        ]
        result = generate_tax_report(
            txs,
            BUSINESS_INFO,
            {"year": 2026},
            global_tax_rate=18,
            software_info=SOFTWARE_INFO,
            tax_report_config=TAX_REPORT_CONFIG,
            process_date=NOW,
        )
        codes = [line[:4] for line in result.bkmv_content]
        assert codes[0] == "A100"
        assert codes[1] == "B110"
        assert codes[-1] == "Z900"
        assert result.record_counts["C100"] == 2

    def test_refund_doc_type(self):
        sale = make_transaction(id="tx-sale", transactionNumber="INV001")
        refund = make_transaction(
            id="tx-refund",
            transactionNumber="RFD001",
            refundOfTransactionId="tx-sale",
        )
        result = generate_tax_report(
            [sale, refund],
            BUSINESS_INFO,
            {"year": 2026},
            global_tax_rate=18,
            software_info=SOFTWARE_INFO,
            tax_report_config=TAX_REPORT_CONFIG,
            process_date=NOW,
        )
        c100 = [l for l in result.bkmv_content if l.startswith("C100")]
        assert c100[0][22:25] == "320"
        assert c100[1][22:25] == "330"


class TestCollectM100:
    def test_skips_cancelled(self):
        tx1 = make_transaction(id="tx-1", status="completed")
        tx2 = make_transaction(id="tx-2", status="cancelled")
        products = collect_unique_products_for_m100([tx1, tx2])
        assert len(products) == 2


class TestSummaryRecord:
    def test_format(self):
        assert build_summary_record("C100", 42) == "C100000000000000042"
        assert len(build_summary_record("C100", 42)) == 19
