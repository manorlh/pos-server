"""
מבנה אחיד 1.31 — the gaps the certification test file found (P:\\tax\\open-format-test):

* §2.6 the production report ("דוח הפקה"): per document type the count and Σ 1223, per
  record type the count, the path, the period and the business — of the downloaded file.
* C100 1228 "מסמך מבוטל": a cancelled document is filed, but without payment records (D120
  is "פרטי קבלה", §4.5 — a cancelled document received no money).
* D120 1306: cheque 2, bank transfer 4, and 9 "אחר" (never 1, cash) for an unknown tender.
* A000 1023 blank for multi-year software; C100 1225 the customer's key; D110 1263 "יחידה".
"""
from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal as D

from app.models.customer import Customer
from app.models.transaction import TransactionStatus
from app.routers import tax_reports as tax_router
from app.services.open_format.defaults import SoftwareInfo
from app.services.open_format.production_report import build_production_report
from app.services.open_format.tax_report_generator import UNIT_OF_MEASURE, build_c100_record
from test_open_format_131 import (  # noqa: F401
    _check_document, _doc, _export, a000, b110, c100, d110, d120, records, report, simple, tx, item, w,
)

UTC = timezone.utc
WHEN = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)


def _cancelled(id_, number, **kw):
    t = simple(id_, number, WHEN, method="card",
               payments=[{"method": "card", "amount": 11.8, "sequence": 1}], **kw)
    t["status"] = "cancelled"
    return t


def _1228(line):
    return line[399]


class TestCancelledDocuments:
    def test_a_cancelled_sale_is_filed_without_payment_records(self):
        sale = simple("s", "10000001", WHEN, method="cash", payments=[{"method": "cash", "amount": 11.8}])
        result = report([sale, _cancelled("x", "10000002")])
        heads = records(result, "C100")
        assert [_1228(h) for h in heads] == ["0", "1"]
        # The cancelled document still states its money (the document as issued) …
        assert c100(heads[1])["1223"] == 1180
        # … but only the live sale has a payment record.
        assert result.record_counts["D120"] == 1
        assert [d120(x)["1312"] for x in records(result, "D120")] == [1180]
        # And the cash account counts the live sale only, as before.
        assert b110(records(result, "B110")[0])["debit"] == 1180

    def test_its_lines_are_still_written(self):
        result = report([_cancelled("x", "10000002")])
        assert result.record_counts["D110"] == 1
        assert records(result, "D120") == []
        assert not any(line.startswith("D120") for line in result.ini_content)


class TestPaymentTypeCodes:
    def _code(self, method):
        result = report([simple("t", "10000001", WHEN, method=method, payments=[{"method": method, "amount": 11.8}])])
        return d120(records(result, "D120")[0])["1306"], result

    def test_cheque_and_bank_transfer(self):
        assert self._code("check")[0] == "2"
        assert self._code("transfer")[0] == "4"

    def test_an_unknown_tender_is_other_and_logged(self, caplog):
        with caplog.at_level(logging.WARNING, logger="app.services.open_format.tax_report_generator"):
            code, result = self._code("crypto")
        assert code == "9"
        assert result.unmapped_tenders == {"crypto": 1}
        assert "crypto" in caplog.text
        assert result.payment_totals == {9: {"count": 1, "totalAgorot": 1180}}

    def test_no_tender_at_all_is_other_too(self):
        t = simple("t", "10000001", WHEN, method=None)
        result = report([t])
        assert d120(records(result, "D120")[0])["1306"] == "9"
        assert result.unmapped_tenders == {"(none)": 1}


class TestSmallFields:
    def test_a000_1023_is_blank_for_multi_year_software(self):
        result = report([simple("t", "10000001", WHEN)])
        line = result.ini_content[0]
        assert line[362:366] == "    "
        assert a000(line)["1024"] == "20260101"

    def test_a000_1023_is_the_year_for_single_year_software(self):
        sw = SoftwareInfo(registration_number="12345678", software_type="single-year")
        result = report([simple("t", "10000001", WHEN)], software_info=sw)
        assert result.ini_content[0][362:366] == "2026"

    def test_c100_1225_is_the_customer_key(self):
        t = simple("t", "10000001", WHEN)
        t["customer"] = {"name": "חברה בע\"מ", "vatNumber": "515396687", "key": "1f0e2d3c4b5a69788796a5b4c3d2e1f0"}
        line = build_c100_record(t, "123456782", 99, "0000001")
        assert line[374:389] == "1F0E2D3C4B5A697"
        assert len(line) == 444

    def test_c100_1225_is_blank_for_the_general_customer(self):
        line = build_c100_record(simple("t", "10000001", WHEN), "123456782", 99, "0000001")
        assert line[374:389] == " " * 15

    def test_d110_1263_is_the_unit(self):
        result = report([simple("t", "10000001", WHEN)])
        line = records(result, "D110")[0]
        assert line[203:223].strip() == UNIT_OF_MEASURE == "יחידה"
        assert d110(line)["1264"] == 10000  # the fields after it did not move
        assert len(line) == 339


class TestCustomerKeyFromTheExport:
    def test_a_linked_customer_and_a_walk_in(self, w):
        customer = Customer(id=uuid.uuid4(), tenant_id=w.tenant.id, name="לקוח עסקי", vat_number="515396687")
        w.db.add(customer)
        linked = _doc(w, w.tills[0], "1", when=WHEN)
        linked.customer_ref_id = customer.id
        _doc(w, w.tills[0], "2", when=WHEN)
        w.db.flush()
        w.db.expire_all()
        result, _ctx = _export(w)
        keys = sorted(line[374:389] for line in records(result, "C100"))
        assert keys == [" " * 15, customer.id.hex[:15].upper()]


class TestProductionReport:
    def _result(self):
        sale = simple("s", "10000001", WHEN, gross=118.0, method="card",
                      payments=[{"method": "card", "amount": 118.0, "cardAcquirer": "cal"}])
        credit = simple("c", "20000001", WHEN, gross=59.0, doc_type=330, refund_of="s")
        mixed = simple("m", "10000002", WHEN, gross=50.0, method="mixed",
                       payments=[{"method": "voucher", "amount": 40.0, "sequence": 1},
                                 {"method": "cash", "amount": 10.0, "sequence": 2}])
        return report([sale, credit, mixed, _cancelled("x", "10000003")], output_path="C:\\OPENFRMT\\12345678.26\\10061526")

    def test_the_totals_are_the_files(self):
        result = self._result()
        assert result.document_totals == {
            320: {"count": 3, "totalAgorot": 11800 + 5000 + 1180, "cancelledCount": 1, "cancelledAgorot": 1180},
            330: {"count": 1, "totalAgorot": 5900, "cancelledCount": 0, "cancelledAgorot": 0},
        }
        # Σ 1223 per type straight off the C100 records.
        by_type: dict = {}
        for line in records(result, "C100"):
            head = c100(line)
            by_type[int(head["1203"])] = by_type.get(int(head["1203"]), 0) + head["1223"]
        assert by_type == {k: v["totalAgorot"] for k, v in result.document_totals.items()}
        assert result.payment_totals == {
            1: {"count": 1, "totalAgorot": 1000}, 3: {"count": 1, "totalAgorot": 11800}, 5: {"count": 1, "totalAgorot": 4000},
        }
        assert (result.period_start, result.period_end) == (date(2026, 1, 1), date(2026, 10, 6))

    def test_the_report(self):
        result = self._result()
        rep = build_production_report(
            result, {"vatNumber": "123456782", "companyName": "רויאל בר", "companyAddress": "דיזנגוף",
                     "companyAddressNumber": "99", "companyCity": "תל אביב-יפו"},
            SoftwareInfo(registration_number="12345678", name="R2M POS", version="0.1.820"),
            {"start": None, "end": None}, file_name="OPENFRMT-12345678-10061526.zip",
        )
        assert rep["documents"] == [
            {"code": 320, "name": "חשבונית מס קבלה", "count": 3, "total": "179.80", "cancelledCount": 1, "cancelledTotal": "11.80"},
            {"code": 330, "name": "חשבונית מס זיכוי", "count": 1, "total": "59.00", "cancelledCount": 0, "cancelledTotal": "0.00"},
        ]
        assert rep["documentsCount"] == 4
        assert {r["code"]: r["count"] for r in rep["records"]} == {k: v for k, v in result.record_counts.items() if v}
        assert rep["recordsTotal"] == len(result.bkmv_content) == int(records(result, "Z900")[0][46:61])
        assert rep["records"][0] == {"code": "A100", "name": "רשומת פתיחה", "count": 1}
        assert rep["primaryId"] == result.unique_id == result.bkmv_content[0][22:37]
        assert rep["outputPath"] == "C:\\OPENFRMT\\12345678.26\\10061526" == a000(result.ini_content[0])["1012"]
        assert (rep["periodFrom"], rep["periodTo"]) == ("2026-01-01", "2026-10-06")
        assert (rep["producedDate"], rep["producedTime"]) == ("2026-10-06", "15:26")
        assert rep["business"]["address"] == "דיזנגוף 99"
        assert rep["software"]["registrationNumber"] == "12345678"
        assert [p["code"] for p in rep["payments"]] == [1, 3, 5]
        assert rep["unmappedTenders"] == []

    def test_the_download_carries_the_report_of_its_own_file(self, w):
        _doc(w, w.tills[0], "1", when=WHEN)
        cancelled = _doc(w, w.tills[0], "2", when=WHEN, payment=("card", None, None, None))
        cancelled.status = TransactionStatus.CANCELLED
        w.db.flush()
        response = tax_router.download_tax_open_format(
            scope="company", shop_id=None, company_id=str(w.company.id), mode="date-range",
            from_date=date(2026, 9, 27), to_date=date(2026, 9, 27), year=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        rep = json.loads(base64.b64decode(response.headers[tax_router.PRODUCTION_REPORT_HEADER]).decode("utf-8"))
        assert rep["fileName"] in response.headers["content-disposition"]
        assert rep["documents"] == [
            {"code": 320, "name": "חשבונית מס קבלה", "count": 2, "total": "23.60", "cancelledCount": 1, "cancelledTotal": "11.80"},
        ]
        assert {r["code"]: r["count"] for r in rep["records"]}["D120"] == 1
        assert (rep["periodFrom"], rep["periodTo"]) == ("2026-09-27", "2026-09-27")

    def test_the_preview_has_one_too(self, w):
        _doc(w, w.tills[0], "1", when=WHEN)
        out = tax_router.preview_tax_open_format(
            scope="company", shop_id=None, company_id=str(w.company.id), mode="date-range",
            from_date=date(2026, 9, 27), to_date=date(2026, 9, 27), year=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out.production_report["documentsCount"] == 1
        assert out.model_dump(by_alias=True)["productionReport"]["records"][0]["code"] == "A100"
