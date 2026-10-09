"""
מבנה אחיד 1.31 — the export, field by field, against the Tax Authority's own text
("הוראות להפקת קבצים במבנה אחיד", version 1.31, 01/05/2009):

* A000 1034 — "1 - בעסק יש סניפים/ענפים": set from the shops the business has, not from
  whether the one shop exported has a code; every branch field filled, B110 per branch.
* Every date and time is the business's local time (Asia/Jerusalem), across midnight and
  across both daylight-saving changes; the export's days are local days.
* ISO-8859-8-i (§2.4ח): Hebrew punctuation and anything else the set lacks is written as
  an ASCII equivalent, never `?`, and every record keeps its fixed width.
* B110: credit notes are the cash account's credit side, never added to its debit.
* D110 1267 — "הכמות בשורה * מחיר ליח' ללא מע"מ בניכוי הנחת השורה" — after the line's
  discount, for 320 and 330 alike, and the lines add up to the header exactly.
* D120 1313/1314/1315 from the card leg the terminal answered.
* 330 amounts positive (§2.4יב, הבהרה 1).
* A000 1006–1012 from the platform setting `openFormat`; 1015 zeros when there is none.
* C100 1233 — "שם המשתמש של מבצע הפעולה": the till user's user name.
"""
from __future__ import annotations

import random
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal as D
from zoneinfo import ZoneInfo

import pytest

from app.models.app_release import AppRelease
from app.models.company import Company
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.services import tax_reports as TR
from app.services.open_format import software as SW
from app.services.open_format.defaults import SoftwareInfo
from app.services.open_format.tax_report_generator import (
    allocate_cents,
    build_a000_record,
    build_b110_record,
    build_c100_record,
    build_d110_record,
    build_d120_record,
    card_fields,
    charset_text,
    encode_open_format_lines,
    generate_tax_report,
    pad_right,
)
from app.services.open_format.defaults import DEFAULT_TAX_REPORT_CONFIG
from shift_world import accept_str_uuids, make_world

IL = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc

BUSINESS = {
    "vatNumber": "123456782",
    "companyName": "רויאל בר",
    "companyAddress": "דיזנגוף",
    "companyAddressNumber": "99",
    "companyCity": "תל אביב-יפו",
    "companyZip": "6433222",
    "companyRegNumber": "",
    "withholdingFileNumber": "000000000",
    "hasBranches": False,
}


# ── Field slices (0-based), from the 1.31 record tables ───────────────────────────────

def c100(line):
    return {
        "1203": line[22:25], "1204": line[25:45].strip(), "1205": line[45:53], "1206": line[53:57],
        "1216": line[261:269], "1219": int(line[287:302]), "1220": int(line[302:317]),
        "1221": int(line[317:332]), "1222": int(line[332:347]), "1223": int(line[347:362]),
        "1230": line[400:408], "1231": line[408:415].strip(), "1233": line[415:424].strip(),
    }


def d110(line):
    return {
        "1253": line[22:25], "1254": line[25:45].strip(), "1260": line[93:123].strip(),
        "1264": int(line[223:240]), "1265": int(line[240:255]), "1266": int(line[255:270]),
        "1267": int(line[270:285]), "1268": line[285:289], "1270": line[289:296].strip(),
        "1272": line[296:304],
    }


def d120(line):
    return {
        "1306": line[49], "1312": int(line[103:118]), "1313": line[118], "1314": line[119:139].strip(),
        "1315": line[139], "1320": line[140:147].strip(), "1322": line[147:155],
    }


def b110(line):
    return {
        "key": line[22:37], "name": line[37:87].strip(), "open": int(line[277:292]),
        "debit": int(line[292:307]), "credit": int(line[307:322]), "1421": line[335:342].strip(),
    }


def a000(line):
    return {
        "1006": line[56:64], "1007": line[64:84].strip(), "1008": line[84:104].strip(),
        "1009": line[104:113], "1010": line[113:133].strip(), "1012": line[134:184].strip(),
        "1015": line[186:195], "1024": line[366:374], "1025": line[374:382], "1026": line[382:390],
        "1027": line[390:394], "1034": line[419],
    }


def records(result, code):
    return [line for line in result.bkmv_content if line.startswith(code)]


def item(sku, name, qty, unit, total, discount=None, **extra):
    return {
        "id": f"i-{sku}-{name}", "productId": sku, "product": {"id": sku, "sku": sku, "name": name},
        "quantity": qty, "unitPrice": unit, "totalPrice": total, "discount": discount,
        "lineDiscount": -discount if discount else None, "transactionType": 2, **extra,
    }


def tx(id_, number, *, when, items, net, vat, doc_type=320, discount=0.0, basket=None, payments=None,
       branch="1", refund_of=None, vat_rate=0.18, cashier="dana", method="cash"):
    cart = {"items": items, "subtotal": net, "taxAmount": vat, "totalAmount": round(net + vat, 2)}
    if basket is not None:
        cart["basketDiscount"] = basket
    return {
        "id": id_, "transactionNumber": number, "status": "completed", "documentType": doc_type,
        "documentProductionDate": when.isoformat(), "createdAt": when.isoformat(),
        "documentDiscount": discount, "branchId": branch, "refundOfTransactionId": refund_of,
        "payments": payments or [], "paymentMethod": method, "cashier": {"name": cashier},
        "customer": {"name": "לקוח כללי"}, "cart": cart, "vatRate": vat_rate,
    }


def simple(id_, number, when, *, branch="1", gross=11.80, doc_type=320, refund_of=None, method="cash", payments=None):
    net = round(gross / 1.18, 2)
    return tx(id_, number, when=when, items=[item("1", "קפה", 1, gross, gross)], net=net, vat=round(gross - net, 2),
              branch=branch, doc_type=doc_type, refund_of=refund_of, method=method, payments=payments)


def report(txs, business=None, **kw):
    return generate_tax_report(
        txs, {**BUSINESS, **(business or {})}, {"start": datetime(2026, 1, 1, tzinfo=IL), "end": datetime(2026, 12, 31, 23, 59, tzinfo=IL)},
        global_tax_rate=18.0, process_date=datetime(2026, 10, 6, 12, 26, tzinfo=UTC), **kw,
    )


# ── 1. Branches ───────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.shop.branch_id = "1"
    world.other_shop.branch_id = "2"
    world.db.flush()
    return world


def _doc(w, till, number, *, when, total="11.80", document_type=320, refund_of=None, cashier_id=None,
         payment=("cash", None, None, None), prefix=None):
    t = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=number, document_prefix=prefix, pos_number="1",
        status=TransactionStatus.COMPLETED, document_type=document_type, payment_method=payment[0],
        total_amount=D(total), document_discount=D("0"), net_amount=(D(total) / D("1.18")).quantize(D("0.01")),
        vat_amount=D(total) - (D(total) / D("1.18")).quantize(D("0.01")), vat_rate=D("0.18"),
        refund_of_transaction_id=refund_of, cashier_id=cashier_id,
        created_at=when, updated_at=when, document_production_date=when, server_received_at=when,
    )
    w.db.add(t)
    w.db.flush()
    w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=t.id, product_name="צ׳יפס", sku="7",
                             quantity=D("1"), unit_price=D(total), total_price=D(total), transaction_type=2))
    method, acquirer, brand, instalments = payment
    w.db.add(TransactionPayment(id=uuid.uuid4(), transaction_id=t.id, sequence=1, method=method, amount=D(total),
                                card_acquirer=acquirer, card_brand=brand,
                                nayax_meta={"creditPayments": instalments} if instalments else None))
    w.db.flush()
    w.db.refresh(t)
    return t


def _export(w, *, company=None, shop=None, day=date(2026, 9, 27), to=None):
    company = company or w.company
    ctx = TR.resolve_export_context(w.db, company=company, shop=shop, mode="date-range",
                                    from_date=day, to_date=to or day)
    result, dicts, _zip = TR.build_tax_open_format_export(
        w.db, w.tenant.id, ctx, company_id=None if shop else company.id, shop_id=shop.id if shop else None,
    )
    return result, ctx


class TestBranches:
    def test_a_company_with_two_shops_has_branches(self, w):
        noon = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        _doc(w, w.tills[0], "1", when=noon)
        # The other shop's till under its own prefix (unique in the business,
        # docs/SPEC_DOCUMENT_PREFIX.md §5): the same counter, another document number.
        _doc(w, w.other_till, "1", when=noon, prefix="3")
        result, ctx = _export(w)
        assert a000(result.ini_content[0])["1034"] == "1"
        assert ctx.business_info["hasBranches"] is True
        heads = [c100(line) for line in records(result, "C100")]
        # (type, number) is unique in the whole file — branch codes do not tell two
        # documents apart (the simulator: "נמצאה יותר מרשומה אחת עם אותו מס אסמכתא").
        assert len({(h["1203"], h["1204"]) for h in heads}) == 2
        assert {h["1231"].strip() for h in heads} == {"1", "2"}
        assert all(d110(line)["1270"] for line in records(result, "D110"))
        assert all(d120(line)["1320"] for line in records(result, "D120"))

    def test_with_branches_there_is_a_cash_account_per_branch(self, w):
        noon = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        _doc(w, w.tills[0], "1", when=noon, total="118.00")
        _doc(w, w.other_till, "1", when=noon, total="59.00", prefix="3")
        result, _ = _export(w)
        accounts = [b110(line) for line in records(result, "B110")]
        assert [a["1421"] for a in accounts] == ["1", "2"]
        assert len({a["key"] for a in accounts}) == 2
        assert [a["debit"] for a in accounts] == [11800, 5900]
        assert result.record_counts["B110"] == 2

    def test_a_shop_export_of_a_company_with_several_shops_has_branches(self, w):
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC))
        result, _ = _export(w, shop=w.shop)
        assert a000(result.ini_content[0])["1034"] == "1"

    def test_a_single_shop_business_has_no_branches(self, w):
        company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Solo", vat_number="123456782")
        w.db.add(company)
        w.db.flush()
        shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=company.id, name="Only", branch_id="1", settings={})
        w.db.add(shop)
        w.db.flush()
        w.other_till.shop_id = shop.id
        w.db.flush()
        _doc(w, w.other_till, "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC))
        result, _ = _export(w, company=company, shop=shop)
        assert a000(result.ini_content[0])["1034"] == "0"
        assert [b110(line)["1421"] for line in records(result, "B110")] == [""]

    def test_a_setting_cannot_turn_branches_off_for_a_business_with_two_shops(self, w):
        w.company.settings = {"businessInfo": {"hasBranches": False}}
        w.db.flush()
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC))
        result, _ = _export(w)
        assert a000(result.ini_content[0])["1034"] == "1"


# ── 2. Local time ─────────────────────────────────────────────────────────────────────


class TestLocalTime:
    @pytest.mark.parametrize(
        "utc, local_date, local_time",
        [
            # Summer (IDT, +3), across midnight: a 00:30 sale is the next day's, as printed.
            (datetime(2026, 9, 30, 21, 30, tzinfo=UTC), "20261001", "0030"),
            (datetime(2026, 10, 1, 8, 5, tzinfo=UTC), "20261001", "1105"),
            # DST ends 2026-10-25 02:00 IDT → 01:00 IST: 01:30 happens twice.
            (datetime(2026, 10, 24, 22, 30, tzinfo=UTC), "20261025", "0130"),
            (datetime(2026, 10, 24, 23, 30, tzinfo=UTC), "20261025", "0130"),
            (datetime(2026, 10, 25, 12, 0, tzinfo=UTC), "20261025", "1400"),
            # Winter (IST, +2).
            (datetime(2026, 12, 1, 22, 15, tzinfo=UTC), "20261202", "0015"),
            # DST starts 2026-03-27 02:00 IST → 03:00 IDT.
            (datetime(2026, 3, 26, 23, 30, tzinfo=UTC), "20260327", "0130"),
            (datetime(2026, 3, 27, 0, 30, tzinfo=UTC), "20260327", "0330"),
        ],
    )
    def test_every_date_and_time_in_the_file_is_local(self, utc, local_date, local_time):
        result = report([simple("t1", "10000001", utc, method="card",
                                payments=[{"method": "card", "amount": 11.8, "cardAcquirer": "cal"}])])
        head = c100(records(result, "C100")[0])
        assert (head["1205"], head["1206"]) == (local_date, local_time)
        assert head["1216"] == head["1230"] == local_date
        assert d110(records(result, "D110")[0])["1272"] == local_date
        assert d120(records(result, "D120")[0])["1322"] == local_date

    def test_a_naive_timestamp_is_utc(self):
        result = report([simple("t1", "10000001", datetime(2026, 9, 30, 21, 30))])
        assert c100(records(result, "C100")[0])["1205"] == "20261001"

    def test_the_process_date_is_local(self):
        record = build_a000_record(BUSINESS, SoftwareInfo(), DEFAULT_TAX_REPORT_CONFIG, 3, "1" * 15,
                                   {"year": 2026}, "", datetime(2026, 10, 6, 21, 30, tzinfo=UTC))
        assert (a000(record)["1026"], a000(record)["1027"]) == ("20261007", "0030")

    @pytest.mark.parametrize(
        "day, start_utc, end_utc",
        [
            (date(2026, 10, 1), datetime(2026, 9, 30, 21, 0, tzinfo=UTC), datetime(2026, 10, 1, 21, 0, tzinfo=UTC)),
            # The 25-hour day DST ends on.
            (date(2026, 10, 25), datetime(2026, 10, 24, 21, 0, tzinfo=UTC), datetime(2026, 10, 25, 22, 0, tzinfo=UTC)),
            # The 23-hour day DST starts on.
            (date(2026, 3, 27), datetime(2026, 3, 26, 22, 0, tzinfo=UTC), datetime(2026, 3, 27, 21, 0, tzinfo=UTC)),
            (date(2026, 12, 1), datetime(2026, 11, 30, 22, 0, tzinfo=UTC), datetime(2026, 12, 1, 22, 0, tzinfo=UTC)),
        ],
    )
    def test_the_export_days_are_local_days(self, day, start_utc, end_utc):
        start, end, _ = TR.parse_date_range("date-range", from_date=day, to_date=day)
        assert start == start_utc
        # The last microsecond of the local day: everything before the next local midnight.
        assert end + timedelta(microseconds=1) == end_utc

    def test_a_year_is_a_local_year(self):
        start, end, _ = TR.parse_date_range("year", year=2026)
        assert start == datetime(2025, 12, 31, 22, 0, tzinfo=UTC)
        assert end + timedelta(microseconds=1) == datetime(2026, 12, 31, 22, 0, tzinfo=UTC)

    def test_a_sale_after_midnight_is_exported_with_its_own_day(self, w):
        after_midnight = datetime(2026, 9, 30, 21, 30, tzinfo=UTC)  # 2026-10-01 00:30 local
        _doc(w, w.tills[0], "1", when=after_midnight)
        oct1, _ = _export(w, day=date(2026, 10, 1))
        sep30, _ = _export(w, day=date(2026, 9, 30))
        assert [c100(line)["1205"] for line in records(oct1, "C100")] == ["20261001"]
        assert records(sep30, "C100") == []


# ── 3. Character set ──────────────────────────────────────────────────────────────────


class TestCharset:
    @pytest.mark.parametrize(
        "text, written",
        [
            ("צ׳יפס", "צ'יפס"),
            ("קפה ״הפוך״", 'קפה "הפוך"'),
            ("ראנר פרוייקטים בע״מ", 'ראנר פרוייקטים בע"מ'),
            ("ללא־גלוטן", "ללא-גלוטן"),
            ("קולה – זירו — גדול", "קולה - זירו - גדול"),
            ("“מבצע” ‘שבוע’", "\"מבצע\" 'שבוע'"),
            ("שָׁלוֹם", "שלום"),
            ("café", "cafe"),
            ("₪5…", "NIS5..."),
            ("בירה 🍺", "בירה "),
        ],
    )
    def test_characters_outside_the_set_get_an_ascii_equivalent(self, text, written):
        assert charset_text(text) == written
        encoded = encode_open_format_lines([pad_right(text, 30)])
        assert b"?" not in encoded
        assert encoded.decode("iso-8859-8").rstrip("\r\n").rstrip() == written.rstrip()

    def test_records_keep_their_width_and_carry_no_question_marks(self):
        names = ["צ׳יפס", "קפה ״הפוך״", "בירה ללא־אלכוהול – 330 מ״ל", "שֶׁקֶל … ₪"]
        txs = [
            tx(f"t{i}", f"1000000{i}", when=datetime(2026, 9, 27, 9, i, tzinfo=UTC),
               items=[item(str(i), n, 1, 11.8, 11.8)], net=10.0, vat=1.8)
            for i, n in enumerate(names)
        ]
        result = report(txs, business={"companyName": "רויאל ״בר״"})
        data = encode_open_format_lines(result.bkmv_content)
        assert b"?" not in data
        widths = {"A100": 95, "B110": 376, "C100": 444, "D110": 339, "D120": 222, "M100": 298, "Z900": 110}
        for line in data.decode("iso-8859-8").split("\r\n")[:-1]:
            assert len(line) == widths[line[:4]]
        assert [d110(line)["1260"] for line in records(result, "D110")] == [
            "צ'יפס", 'קפה "הפוך"', 'בירה ללא-אלכוהול - 330 מ"ל', "שקל ... NIS",
        ]


# ── 4. B110: credit notes reduce the cash account ─────────────────────────────────────


class TestCashAccount:
    def test_a_credit_note_is_on_the_credit_side(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        result = report([
            simple("s", "10000001", when, gross=118.0),
            simple("c", "10000001", when, gross=59.0, doc_type=330, refund_of="s"),
        ])
        account = b110(records(result, "B110")[0])
        assert (account["open"], account["debit"], account["credit"]) == (0, 11800, 5900)
        # Never the old Σ|1223| = 177.00 on the debit side.
        assert account["debit"] != 17700

    def test_the_record_keeps_its_length(self):
        assert len(build_b110_record("123456782", 2, BUSINESS, period_sales_total=1, period_credit_total=2, branch_id="12")) == 376


# ── 5. Line totals: after the line discount, adding up to the header exactly ──────────


def _check_document(result):
    """Σ1267 = 1219, 1219 + 1220 = 1221, 1221 + 1222 = 1223, Σ1312 = 1223 — exactly."""
    lines = [l for l in result.bkmv_content]
    out = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("C100"):
            head = c100(lines[i])
            j = i + 1
            body, pays = [], []
            while j < len(lines) and lines[j][:4] in ("D110", "D120"):
                (body if lines[j].startswith("D110") else pays).append(lines[j])
                j += 1
            rows = [d110(x) for x in body]
            assert sum(r["1267"] for r in rows) == head["1219"]
            assert head["1219"] + head["1220"] == head["1221"]
            assert head["1221"] + head["1222"] == head["1223"]
            if head["1203"] == "330":
                assert pays == []  # no payment records under a credit note
            else:
                assert sum(d120(x)["1312"] for x in pays) == head["1223"]
            out.append((head, rows))
            i = j
        else:
            i += 1
    return out


class TestLineTotals:
    def test_a_discounted_sale_line_is_after_its_discount(self):
        # 2 × 30.00 = 60.00, 20% off the line (12.00) → 48.00 paid.
        line = item("1", "נגרוני", 2, 30.0, 60.0, discount=12.0)
        result = report([tx("t", "10000001", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), items=[line],
                            net=40.68, vat=7.32, discount=12.0)])
        (head, rows), = _check_document(result)
        row = rows[0]
        assert (row["1265"], row["1266"], row["1267"]) == (2542, -1017, 4068)
        assert row["1264"] * row["1265"] // 10000 + row["1266"] == 4067  # within an agora
        assert head["1220"] == 0  # the line's discount is the line's, not the document's

    def test_a_credit_note_line_has_the_same_definition(self):
        # The credited line: totalPrice already after its 2.40 share, discount = the share.
        line = item("1", "נגרוני", 1, 30.0, 27.6, discount=2.4)
        result = report([tx("c", "10000001", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), items=[line],
                            net=23.39, vat=4.21, doc_type=330, refund_of="x", discount=0.0)])
        (head, rows), = _check_document(result)
        row = rows[0]
        assert (row["1265"], row["1266"], row["1267"]) == (2542, -203, 2339)
        assert abs(row["1265"] + row["1266"] - row["1267"]) <= 1

    def test_a_basket_discount_is_the_documents(self):
        lines = [item("1", "a", 1, 33.0, 33.0), item("2", "b", 3, 14.0, 42.0)]
        # 75.00, 10% basket = 7.50 → 67.50 paid: net 57.20, VAT 10.30.
        result = report([tx("t", "10000001", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), items=lines,
                            net=57.20, vat=10.30, discount=7.5, basket=7.5)])
        (head, rows), = _check_document(result)
        assert head["1220"] == -636  # 7.50 / 1.18
        assert head["1219"] == 5720 + 636

    def test_the_lines_always_add_up_to_the_header(self):
        rng = random.Random(131)
        docs = []
        for n in range(300):
            lines, gross_after = [], 0
            for k in range(rng.randint(1, 5)):
                unit = rng.randint(500, 6000)
                qty = rng.choice([1, 1, 2, 3])
                gross = unit * qty
                disc = gross * rng.choice([0, 0, 0, 10, 20, 25]) // 100
                lines.append(item(f"{n}-{k}", "x", qty, unit / 100, gross / 100, discount=disc / 100 or None))
                gross_after += gross - disc
            basket = gross_after * rng.choice([0, 0, 5, 10, 15]) // 100
            total = gross_after - basket
            net = round(total / 1.18)
            docs.append(tx(f"t{n}", f"1{n:07d}", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), items=lines,
                           net=net / 100, vat=(total - net) / 100,
                           discount=(sum(l["discount"] or 0 for l in lines) + basket / 100), basket=basket / 100))
        checked = _check_document(report(docs))
        assert len(checked) == 300
        for _head, rows in checked:
            for r in rows:
                qty = r["1264"] / 10000
                # Each line within its rounding: half an agora per unit, half on the
                # discount, two on the allocation.
                assert abs(qty * r["1265"] + r["1266"] - r["1267"]) <= qty / 2 + 3

    def test_allocation_is_exact_and_proportional(self):
        assert allocate_cents(1001, [1, 1, 1]) == [334, 334, 333]
        assert sum(allocate_cents(9999, [7, 13, 29, 51])) == 9999
        assert allocate_cents(500, [0, 0]) == [0, 500]
        assert allocate_cents(0, []) == []

    def test_a_line_built_alone_follows_the_spec_too(self):
        t = tx("t", "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), items=[], net=0, vat=0)
        row = d110(build_d110_record(t, item("1", "x", 2, 30.0, 60.0, discount=12.0), 1, "123456782", 3, 18.0, "0000001"))
        assert row["1267"] == 4068


# ── 6. Card fields ────────────────────────────────────────────────────────────────────


class TestCardFields:
    @pytest.mark.parametrize(
        "acquirer, code", [("isracard", 1), ("cal", 2), ("diners", 3), ("amex", 4), ("max", 6), ("other", 0), (None, 0)],
    )
    def test_the_clearing_company(self, acquirer, code):
        assert card_fields({"cardAcquirer": acquirer})[0] == code

    @pytest.mark.parametrize("instalments, code", [(1, 1), (3, 2), (None, 0), ("x", 0)])
    def test_the_credit_type(self, instalments, code):
        assert card_fields({"creditPayments": instalments})[2] == code

    def test_the_card_name_is_the_brand(self):
        assert card_fields({"cardBrand": "visa"})[1] == "ויזה"
        assert card_fields({"cardBrand": "other"})[1] == ""

    def test_a_card_leg_carries_them_and_a_cash_leg_does_not(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        legs = [
            {"method": "cash", "amount": 5.0, "sequence": 1},
            {"method": "card", "amount": 6.8, "sequence": 2, "cardAcquirer": "max", "cardBrand": "mastercard",
             "creditPayments": 3},
        ]
        result = report([simple("t", "10000001", when, method="mixed", payments=legs)])
        cash, card = [d120(line) for line in records(result, "D120")]
        assert (cash["1306"], cash["1313"], cash["1314"], cash["1315"]) == ("1", "0", "", "0")
        assert (card["1306"], card["1313"], card["1314"], card["1315"]) == ("3", "6", "מאסטרקארד", "2")

    def test_a_single_card_leg_document(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        result = report([simple("t", "10000001", when, method="card",
                                payments=[{"method": "card", "amount": 11.8, "cardAcquirer": "cal",
                                           "cardBrand": "visa", "creditPayments": 1}])])
        leg = d120(records(result, "D120")[0])
        assert (leg["1313"], leg["1314"], leg["1315"]) == ("2", "ויזה", "1")

    def test_a_record_built_without_card_data_is_unchanged(self):
        t = simple("t", "10000001", datetime(2026, 9, 27, 9, 0, tzinfo=UTC), method="card")
        leg = d120(build_d120_record(t, 1, "123456782", 3, "0000001"))
        assert (leg["1306"], leg["1313"], leg["1314"], leg["1315"]) == ("3", "0", "", "0")

    def test_the_export_reads_them_off_the_stored_leg(self, w):
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC),
             payment=("card", "isracard", "amex", 1))
        result, _ = _export(w)
        leg = d120(records(result, "D120")[0])
        assert (leg["1313"], leg["1314"], leg["1315"]) == ("1", "אמריקן אקספרס", "1")


# ── 7. Credit notes are positive ──────────────────────────────────────────────────────


def test_a_credit_note_is_filed_with_positive_amounts():
    """1.31 §2.4יב / הבהרה 1: "חשבונית זיכוי בערך חיובי תגרום להקטנת הכנסה"."""
    when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
    result = report([simple("s", "10000001", when), simple("c", "10000001", when, doc_type=330, refund_of="s")])
    credit = c100(records(result, "C100")[1])
    assert credit["1203"] == "330"
    assert all(credit[f] > 0 for f in ("1219", "1221", "1222", "1223"))
    assert all(d120(line)["1312"] > 0 for line in records(result, "D120"))


# ── 8. Software details from configuration; 1015 ──────────────────────────────────────


class TestSoftwareSettings:
    OWNER = {
        "softwareName": "R2M POS", "manufacturerName": "ראנר פרוייקטים בע״מ",
        "manufacturerVatNumber": "515396687", "registrationNumber": None, "outputDrive": "c:",
    }

    def test_the_file_names_the_configured_software(self, w):
        SW.set_settings(w.db, w.admin, self.OWNER)
        w.db.add(AppRelease(id=uuid.uuid4(), version_code=207, version_name="0.1.207+d1cf2d9.dev10061046-device",
                            sha256="0" * 64, size_bytes=1, file_path="x", is_active=True))
        w.db.flush()
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC))
        result, _ = _export(w)
        head = a000(result.ini_content[0])
        assert head["1007"] == "R2M POS"
        assert head["1008"] == "0.1.207"
        assert head["1009"] == "515396687"
        assert head["1010"] == 'ראנר פרוייקטים בע"מ'
        assert head["1006"] == "00000000"  # no certificate number configured
        produced = result.process_date
        # 1.31 §2.2: <drive>\OPENFRMT\<8 digits of the business number>.<YY>\<MMDDhhmm>.
        assert head["1012"] == f"C:\\OPENFRMT\\51515151.{produced:%y}\\{produced:%m%d%H%M}"
        assert (head["1026"], head["1027"]) == (f"{produced:%Y%m%d}", f"{produced:%H%M}")
        assert b"?" not in encode_open_format_lines(result.ini_content)
        assert SW.placeholders(w.db) == ["registrationNumber"]

    def test_unset_fields_are_placeholders(self, w):
        assert set(SW.placeholders(w.db)) >= {"registrationNumber", "softwareName", "manufacturerVatNumber", "outputDrive"}
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC))
        result, _ = _export(w)
        head = a000(result.ini_content[0])
        assert head["1012"] == ""
        assert head["1015"] == "000000000"  # never the made-up 000000018

    @pytest.mark.parametrize(
        "body, field",
        [
            ({"registrationNumber": "515396687"}, "registrationNumber"),  # 9 digits: 1006 is 9(8)
            # Zeros are the placeholder; the simulator: "ערך השדה לא ולידי / השדה מאופס".
            ({"registrationNumber": "00000000"}, "registrationNumber"),
            ({"manufacturerVatNumber": "515396688"}, "manufacturerVatNumber"),  # bad check digit
            ({"softwareName": "x" * 21}, "softwareName"),
            ({"outputDrive": "C:\\files"}, "outputDrive"),
        ],
    )
    def test_invalid_values_are_refused(self, w, body, field):
        with pytest.raises(SW.SoftwareSettingsError) as e:
            SW.set_settings(w.db, w.admin, body)
        assert e.value.field == field

    def test_a_registrar_number_is_written_when_the_business_has_one(self):
        record = build_a000_record({**BUSINESS, "companyRegNumber": "515396687"}, SoftwareInfo(), DEFAULT_TAX_REPORT_CONFIG,
                                   3, "1" * 15, {"year": 2026}, "", datetime(2026, 10, 6, 9, 0, tzinfo=UTC))
        assert a000(record)["1015"] == "515396687"

    def test_a_too_long_certificate_number_is_never_cut(self):
        with pytest.raises(ValueError):
            build_a000_record(BUSINESS, SoftwareInfo(registration_number="515396687"), DEFAULT_TAX_REPORT_CONFIG,
                              3, "1" * 15, {"year": 2026}, "", datetime(2026, 10, 6, 9, 0, tzinfo=UTC))


# ── 9. C100 1233: the operator's user name ────────────────────────────────────────────


class TestOperator:
    def test_a_till_user_is_written_by_user_name(self, w):
        user = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana.k",
                       pin_hash="x", is_active=True)
        w.db.add(user)
        w.db.flush()
        _doc(w, w.tills[0], "1", when=datetime(2026, 9, 27, 9, 0, tzinfo=UTC), cashier_id=str(user.id))
        _doc(w, w.tills[0], "2", when=datetime(2026, 9, 27, 9, 1, tzinfo=UTC), cashier_id=str(uuid.uuid4()))
        _doc(w, w.tills[0], "3", when=datetime(2026, 9, 27, 9, 2, tzinfo=UTC), cashier_id="7")
        result, _ = _export(w)
        assert [c100(line)["1233"] for line in records(result, "C100")] == ["dana.k", "", "7"]


# ── 10. D110 1274 with branches (the simulator: "שדה חובה, חייב להכיל ערך") ───────────


def d110_1274(line):
    return line[311:318].strip()


class TestBaseBranch:
    """1274 "מספר הסניף/ענף של מ. בסיס … חובה כאשר ערך שדה 1034 = 1" (1.31 §4.4, הבהרות 3, 6)."""

    def test_with_branches_every_line_has_it(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        sale = simple("s", "10000001", when, branch="1")
        other = simple("o", "10000001", when, branch="2")
        credit = simple("c", "10000001", when, branch="1", doc_type=330, refund_of="s")
        result = report([sale, other, credit], business={"hasBranches": True})
        lines = records(result, "D110")
        assert [d110_1274(line) for line in lines] == ["1", "2", "1"]
        # A sale line names its own document's branch, the same as 1270.
        assert all(d110_1274(line) == d110(line)["1270"] for line in lines)

    def test_a_credit_note_names_its_base_documents_branch(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        credit = simple("c", "10000001", when, branch="2", doc_type=330, refund_of="elsewhere")
        credit["baseDocument"] = {"documentType": 320, "transactionNumber": "10000057", "branchId": "1"}
        line = records(report([credit], business={"hasBranches": True}), "D110")[0]
        assert d110_1274(line) == "1" and d110(line)["1270"] == "2"

    def test_a_base_document_with_no_known_branch_falls_back_to_its_own(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        credit = simple("c", "10000001", when, branch="2", doc_type=330, refund_of="elsewhere")
        credit["baseDocument"] = {"documentType": 320, "transactionNumber": "10000057", "branchId": None}
        assert d110_1274(records(report([credit], business={"hasBranches": True}), "D110")[0]) == "2"

    def test_without_branches_a_sale_line_leaves_it_blank(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        result = report([simple("s", "10000001", when, branch="1")])
        assert d110_1274(records(result, "D110")[0]) == ""

    def test_the_export_fills_it_on_every_line(self, w):
        noon = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        sale = _doc(w, w.tills[0], "1", when=noon)
        _doc(w, w.other_till, "1", when=noon, prefix="3")
        _doc(w, w.tills[0], "1", when=noon + timedelta(minutes=5), document_type=330, refund_of=sale.id)
        result, _ = _export(w)
        assert a000(result.ini_content[0])["1034"] == "1"
        assert [d110_1274(line) for line in records(result, "D110")] == ["1", "2", "1"]


# ── 11. D120 only under a receipt (the simulator: "לא נמצאה רשומת כותרת מסמך") ────────


def _headers_of_payments(result):
    """The C100 type each D120 sits under."""
    current, out = None, []
    for line in result.bkmv_content:
        if line.startswith("C100"):
            current = line[22:25]
        elif line.startswith("D120"):
            out.append((current, line[22:25]))
    return out


class TestPaymentRecords:
    def test_a_credit_note_has_no_payment_records(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        sale = simple("s", "10000001", when, gross=118.0, method="card",
                      payments=[{"method": "card", "amount": 118.0, "cardAcquirer": "cal"}])
        credit = simple("c", "10000001", when, gross=59.0, doc_type=330, refund_of="s", method="card",
                        payments=[{"method": "card", "amount": 59.0, "cardAcquirer": "cal"}])
        result = report([sale, credit])
        assert _headers_of_payments(result) == [("320", "320")]
        assert result.record_counts["D120"] == 1
        # The refund's money is still accounted for: the cash account's credit side.
        account = b110(records(result, "B110")[0])
        assert (account["debit"], account["credit"]) == (11800, 5900)
        # And the credit note's header still states its money, consistently.
        head = c100(records(result, "C100")[1])
        assert head["1219"] + head["1220"] == head["1221"]
        assert head["1221"] + head["1222"] == head["1223"] == 5900
        # Counts: INI and Z900 agree with the records actually written.
        assert int(records(result, "Z900")[0][46:61]) == len(result.bkmv_content)
        assert "D120000000000000001" in result.ini_content

    def test_an_unlinked_credit_note_too(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        result = report([simple("c", "10000001", when, doc_type=330)])
        assert records(result, "D120") == []
        assert result.record_counts["D120"] == 0
        assert not any(line.startswith("D120") for line in result.ini_content)

    def test_receipts_keep_theirs_and_a_receipt_refund_is_a_negative_400(self):
        when = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)
        receipt = tx("r", "1", when=when, items=[], net=50.0, vat=0.0, doc_type=400, vat_rate=0.0)
        refund = tx("b", "2", when=when, items=[], net=20.0, vat=0.0, doc_type=-400, refund_of="r", vat_rate=0.0)
        result = report([receipt, refund])
        assert _headers_of_payments(result) == [("400", "400"), ("400", "400")]
        assert [d120(line)["1312"] for line in records(result, "D120")] == [5000, -2000]

    @pytest.mark.parametrize("filed, carries", [(320, True), (400, True), (405, True), (420, True),
                                                 (330, False), (305, False), (100, False), (None, False)])
    def test_which_types_carry_them(self, filed, carries):
        from app.services.open_format.tax_report_generator import carries_payment_records

        assert carries_payment_records(filed) is carries
