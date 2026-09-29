"""
One till basket that mixes sold and returned lines (docs/SHIFTS_API.md §1.2a).

A basket is committed as several documents sharing a `basketId`: a 320 for the sold
lines, one 330 per original receipt credited (`refundOfTransactionId`, lines naming
their original line by `refundOfItemId`) and one unlinked 330 for returns picked from
the catalogue. The offset between them is paid with `exchange` legs; only the net goes
through a real tender.

* `exchange` is its own bucket: in neither cash nor card, so never in the drawer, and it
  nets to zero over a complete basket — on the X, on the Z and on each Z section.
* Sales, refunds and VAT are what they always were: the 320 is a sale, each 330 a refund.
* An original is settled per line when its credit notes name the lines.
* A credit note that reaches the cloud before its original is stored, and the original
  is settled when it arrives.
* The OpenFormat export files `exchange` as payment type 6 and names each returned
  line's base document (D110 1256/1257), even when the original is outside the window;
  an unlinked 330 is filed as a 330, and the dashboard counts it as a refund.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.routers import sync as sync_router
from app.routers.transactions import get_transaction
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify
from app.services.dashboard_stats import compute_breakdown, compute_sales_summary
from app.services.open_format.tax_report_generator import (
    build_d120_record,
    generate_tax_report,
    payment_type_code,
)
from app.services.shift_totals import compute_totals
from app.services.shifts import apply_shift_close
from app.services.tax_reports import load_base_documents, transform_transaction_for_open_format
from app.services.tenders import derive_payment_method, normalize_tender
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


# ── builders ──────────────────────────────────────────────────────────────────

_numbers = iter(range(5000, 10**6))


def _line(total, qty="1", refund_of_item=None, **extra):
    line = {
        "id": str(uuid.uuid4()), "productName": "Item", "sku": "SKU-1",
        "quantity": qty, "unitPrice": str(Decimal(total) / Decimal(qty)), "totalPrice": total,
    }
    if refund_of_item is not None:
        line["refundOfItemId"] = str(refund_of_item)
    line.update(extra)
    return line


def _legs(*legs):
    return [
        {"id": str(uuid.uuid4()), "sequence": i, "method": m, "amount": a}
        for i, (m, a) in enumerate(legs, start=1)
    ]


def _document(shift_id, total, *, doc_type=320, legs=(), items=None, basket=None,
              refund_of=None, minutes=0, **extra):
    at = (NOW + timedelta(minutes=minutes)).isoformat()
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(next(_numbers)),
        "status": "completed", "documentType": doc_type, "totalAmount": total,
        "createdAt": at, "updatedAt": at, "businessDate": str(TODAY),
        "items": items if items is not None else [_line(total)],
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    if legs:
        body["payments"] = _legs(*legs)
    if basket is not None:
        body["basketId"] = str(basket)
    if refund_of is not None:
        body["refundOfTransactionId"] = str(refund_of)
    body.update(extra)
    return body


def _sale(shift_id, total, *legs, **kw):
    return _document(shift_id, total, doc_type=320, legs=legs, **kw)


def _credit(shift_id, total, *legs, **kw):
    return _document(shift_id, total, doc_type=330, legs=legs, **kw)


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id),
        body=TransactionsBatchEnvelope(transactions=docs),
        machine=till,
        db=w.db,
    )


def _get(w, doc) -> Transaction:
    w.db.expire_all()
    return w.db.get(Transaction, uuid.UUID(str(doc["id"])))


def _stranger(w) -> uuid.UUID:
    """Another tenant's id (a real row: the world enforces foreign keys)."""
    from app.models.tenant import Tenant

    other = Tenant(id=uuid.uuid4(), name="Other", slug=f"o-{uuid.uuid4().hex[:6]}", timezone="Asia/Jerusalem")
    w.db.add(other)
    w.db.flush()
    return other.id


def _open(w, till=None, opening="100.00") -> Shift:
    return w.shift(till or w.tills[0], 1, status=ShiftStatus.OPEN, opening_cash=opening)


def _close(w, till, shift):
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))


def _z(w, till, shift):
    _close(w, till, shift)
    return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])


def _original(w, till, shift, *lines, method="cash", minutes=-60):
    """A receipt already on the cloud, with the given line totals (qty 1 unless a tuple)."""
    items = [
        _line(spec[0], spec[1]) if isinstance(spec, tuple) else _line(spec) for spec in lines
    ]
    total = str(sum(Decimal(i["totalPrice"]) for i in items))
    doc = _sale(shift.id, total, (method, total), items=items, minutes=minutes)
    assert [r.status for r in _push(w, till, [doc]).results] == ["accepted"]
    return doc


# ── The tender ────────────────────────────────────────────────────────────────


class TestTheExchangeTender:
    def test_it_is_a_bucket_of_its_own(self):
        assert normalize_tender("exchange") == "exchange"
        assert normalize_tender(" Exchange ") == "exchange"
        assert normalize_tender("voucher") == "other"

    @pytest.mark.parametrize(
        "methods,summary",
        [
            (["cash", "exchange"], "cash"),
            (["card", "exchange"], "card"),
            (["exchange"], "exchange"),
            (["exchange", "exchange"], "exchange"),
            (["cash", "card", "exchange"], "mixed"),
            (["cash", "card"], "mixed"),
        ],
    )
    def test_the_documents_summary_tender_leaves_exchange_out(self, methods, summary):
        assert derive_payment_method(methods) == summary

    def test_openformat_files_it_as_an_exchange_voucher(self):
        assert payment_type_code("exchange") == 6
        assert payment_type_code("card") == 3
        assert payment_type_code("cash") == 1
        assert payment_type_code("voucher") == 1


# ── Baskets on the X and the Z ────────────────────────────────────────────────


class TestABasketOnTheXAndZ:
    def test_net_positive_the_customer_pays_the_difference(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "40.00")
        basket = uuid.uuid4()
        sale = _sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"), basket=basket)
        credit = _credit(
            shift.id, "40.00", ("exchange", "40.00"), basket=basket, refund_of=original["id"],
            items=[_line("40.00", refund_of_item=original["items"][0]["id"])],
        )

        response = _push(w, till, [sale, credit])

        assert [r.status for r in response.results] == ["accepted", "accepted"]
        assert _get(w, sale).payment_method == "cash"
        assert _get(w, credit).payment_method == "exchange"
        assert _get(w, sale).basket_id == basket == _get(w, credit).basket_id
        t = compute_totals(w.db, [shift.id])
        assert t.total_sales == Decimal("140.00")          # the original 40 + the basket's 100
        assert t.total_refunds == Decimal("40.00")
        assert t.total_cash == Decimal("100.00")           # 40 original + 60 of the basket
        assert t.total_card == Decimal("0")
        assert t.total_exchange == Decimal("0")
        assert (t.sales_count, t.credit_notes_count) == (2, 1)
        assert t.as_x()["total_exchange"] == Decimal("0")

    def test_net_zero_is_settled_by_exchange_alone(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        sale = _sale(shift.id, "40.00", ("exchange", "40.00"), basket=basket)
        credit = _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket)

        _push(w, till, [sale, credit])

        t = compute_totals(w.db, [shift.id])
        assert (t.total_sales, t.total_refunds) == (Decimal("40.00"), Decimal("40.00"))
        assert t.total_cash == t.total_card == t.total_exchange == Decimal("0")
        assert t.net_sales == Decimal("0")
        z = _z(w, till, shift)
        assert z.expected_cash == Decimal("100.00")        # the float, and nothing else
        assert z.total_exchange == Decimal("0")

    @pytest.mark.parametrize("payout", ["cash", "card"])
    def test_net_negative_pays_the_customer_out(self, w, payout):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        sale = _sale(shift.id, "30.00", ("exchange", "30.00"), basket=basket)
        credit = _credit(shift.id, "50.00", ("exchange", "30.00"), (payout, "20.00"), basket=basket)

        response = _push(w, till, [sale, credit])

        assert [r.status for r in response.results] == ["accepted", "accepted"]
        assert _get(w, credit).payment_method == payout
        t = compute_totals(w.db, [shift.id])
        assert (t.total_sales, t.total_refunds) == (Decimal("30.00"), Decimal("50.00"))
        assert t.payment_breakdown.get(payout) == Decimal("-20.00")
        other = "card" if payout == "cash" else "cash"
        assert t.payment_breakdown.get(other, Decimal("0")) == Decimal("0")
        assert t.total_exchange == Decimal("0")

        z = _z(w, till, shift)
        section = z.per_machine[0]
        assert section["totalExchange"] == "0.00"
        assert section["totalRefunds"] == "50.00" and section["totalSales"] == "30.00"
        # The drawer: the float, less the cash paid out (a card payout leaves it alone).
        assert z.expected_cash == (Decimal("80.00") if payout == "cash" else Decimal("100.00"))
        assert section["expectedCash"] == str(z.expected_cash)
        assert z.payment_breakdown["exchange"] == "0.00"

    def test_a_receipt_return_and_a_catalogue_return_in_one_basket(self, w):
        """A 320, a linked 330 and an unlinked 330; the net 10 is paid by card."""
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "25.00")
        basket = uuid.uuid4()
        docs = [
            _sale(shift.id, "50.00", ("card", "10.00"), ("exchange", "40.00"), basket=basket),
            _credit(
                shift.id, "25.00", ("exchange", "25.00"), basket=basket, refund_of=original["id"],
                items=[_line("25.00", refund_of_item=original["items"][0]["id"])],
            ),
            _credit(shift.id, "15.00", ("exchange", "15.00"), basket=basket),
        ]

        _push(w, till, docs)

        t = compute_totals(w.db, [shift.id])
        assert t.total_sales == Decimal("75.00")
        assert t.total_refunds == Decimal("40.00")
        assert t.total_card == Decimal("10.00")
        assert t.total_cash == Decimal("25.00")            # the original's
        assert t.total_exchange == Decimal("0")
        assert t.credit_notes_count == 2

    def test_a_basket_half_on_the_cloud_shows_its_exchange(self, w):
        """Only the 320 has arrived: the exchange is not zero, and not in cash or card."""
        till = w.tills[0]
        shift = _open(w, till)
        _push(w, till, [_sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"),
                              basket=uuid.uuid4())])

        t = compute_totals(w.db, [shift.id])
        assert t.total_exchange == Decimal("40.00")
        assert t.total_cash == Decimal("60.00")

    def test_the_tip_on_a_basket_rides_on_its_real_tender(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        _push(w, till, [
            _sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"), basket=basket,
                  tipAmount="5.00"),
            _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket),
        ])

        t = compute_totals(w.db, [shift.id])
        assert t.total_cash_tips == Decimal("5.00")

    def test_the_tills_x_is_compared_on_exchange_when_it_sends_it(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        _push(w, till, [_sale(shift.id, "40.00", ("exchange", "40.00"), basket=basket),
                        _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket)])

        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(
            {"closedAt": NOW.isoformat(), "till": {"totalExchange": "0.00", "totalCash": "0"}}
        ))
        assert w.db.get(Shift, shift.id).totals_mismatch is False
        assert w.db.get(Shift, shift.id).total_exchange == Decimal("0")


# ── Settling the original per line ────────────────────────────────────────────


class TestSettlingPerLine:
    def test_every_line_credited_in_full_is_refunded(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, ("20.00", "2"), "10.00")
        a, b = (i["id"] for i in original["items"])

        _push(w, till, [_credit(shift.id, "20.00", ("cash", "20.00"), refund_of=original["id"],
                                items=[_line("20.00", "2", refund_of_item=a)], minutes=1)])
        assert _get(w, original).status == TransactionStatus.PARTIAL_REFUND

        _push(w, till, [_credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"],
                                items=[_line("10.00", refund_of_item=b)], minutes=2)])
        assert _get(w, original).status == TransactionStatus.REFUNDED

    def test_one_line_credited_twice_is_not_the_whole_receipt(self, w):
        """By amount the receipt is fully credited; by line, B was never returned."""
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00", "10.00")
        a = original["items"][0]["id"]
        first = _credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"],
                        items=[_line("10.00", refund_of_item=a)], minutes=1)
        second = _credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"],
                         items=[_line("10.00", refund_of_item=a)], minutes=2)

        response = _push(w, till, [first, second])

        assert [r.status for r in response.results] == ["accepted", "accepted"]
        assert _get(w, original).status == TransactionStatus.PARTIAL_REFUND
        assert _get(w, first).over_credited is False
        assert _get(w, second).over_credited is True

    def test_a_credit_note_without_line_links_is_settled_by_amount(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00", "10.00")
        a = original["items"][0]["id"]
        _push(w, till, [
            _credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"],
                    items=[_line("10.00", refund_of_item=a)], minutes=1),
            # An older build: the doc-level link only.
            _credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"], minutes=2),
        ])

        assert _get(w, original).status == TransactionStatus.REFUNDED

    def test_a_line_link_alone_settles_the_original(self, w):
        """A 330 naming an original only through its lines still settles it."""
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00", "10.00")
        a = original["items"][0]["id"]

        _push(w, till, [_credit(shift.id, "10.00", ("cash", "10.00"),
                                items=[_line("10.00", refund_of_item=a)], minutes=1)])

        assert _get(w, original).status == TransactionStatus.PARTIAL_REFUND

    def test_another_tenants_line_is_dropped_with_a_warning(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00")
        foreign = w.db.get(Transaction, uuid.UUID(original["id"]))
        foreign.tenant_id = _stranger(w)
        w.db.flush()
        credit = _credit(shift.id, "10.00", ("cash", "10.00"),
                         items=[_line("10.00", refund_of_item=original["items"][0]["id"])])

        response = _push(w, till, [credit])

        assert response.results[0].status == "accepted"
        assert response.results[0].warnings == [
            f"items[0].refundOfItemId: unknown '{original['items'][0]['id']}', stored without the link"
        ]
        line = w.db.query(TransactionItem).filter(TransactionItem.transaction_id == uuid.UUID(credit["id"])).one()
        assert line.refund_of_item_id is None

    def test_an_unknown_line_is_kept_for_the_original_to_arrive(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        later = uuid.uuid4()
        credit = _credit(shift.id, "10.00", ("cash", "10.00"), items=[_line("10.00", refund_of_item=later)])

        response = _push(w, till, [credit])

        assert response.results[0].status == "accepted" and response.results[0].warnings is None
        line = w.db.query(TransactionItem).filter(TransactionItem.transaction_id == uuid.UUID(credit["id"])).one()
        assert line.refund_of_item_id == later

    def test_unreadable_links_are_dropped_not_refused(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        credit = _credit(shift.id, "10.00", ("cash", "10.00"),
                         items=[_line("10.00", refundOfItemId="line-7")], basketId="b-1")

        response = _push(w, till, [credit])

        assert response.results[0].status == "accepted"
        assert response.results[0].warnings == [
            "basketId: unreadable 'b-1', stored without the link",
            "items[0].refundOfItemId: unreadable 'line-7', stored without the link",
        ]


# ── A credit note before its original ─────────────────────────────────────────


class TestACreditNoteBeforeItsOriginal:
    def test_it_is_stored_and_the_original_is_settled_on_arrival(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        item_id = uuid.uuid4()
        original = _sale(shift.id, "30.00", ("cash", "30.00"), minutes=-5,
                         items=[_line("30.00", id=str(item_id))])
        credit = _credit(shift.id, "30.00", ("cash", "30.00"), refund_of=original["id"],
                         items=[_line("30.00", refund_of_item=item_id)])

        first = _push(w, till, [credit])
        assert [r.status for r in first.results] == ["accepted"]
        assert _get(w, credit).refund_of_transaction_id == uuid.UUID(original["id"])

        second = _push(w, till, [original])
        assert [r.status for r in second.results] == ["accepted"]
        assert _get(w, original).status == TransactionStatus.REFUNDED

    def test_both_in_one_batch_credit_note_first(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _sale(shift.id, "30.00", ("cash", "30.00"), minutes=-5)
        credit = _credit(shift.id, "12.00", ("cash", "12.00"), refund_of=original["id"])

        response = _push(w, till, [credit, original])

        assert [r.status for r in response.results] == ["accepted", "accepted"]
        assert _get(w, original).status == TransactionStatus.PARTIAL_REFUND


# ── Buyer details ─────────────────────────────────────────────────────────────


class TestTheBuyerDetails:
    def test_they_are_stored_trimmed_and_cut_never_refused(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        credit = _credit(shift.id, "10.00", ("cash", "10.00"), customerName="  Dana Levi ",
                         customerPhone="050-1234567" + "9" * 40, customerAddress="Herzl 1, Tel Aviv")

        assert _push(w, till, [credit]).results[0].status == "accepted"
        stored = _get(w, credit)
        assert stored.customer_name == "Dana Levi"
        assert stored.customer_phone == ("050-1234567" + "9" * 40)[:30]
        assert stored.customer_address == "Herzl 1, Tel Aviv"

    def test_the_export_names_the_buyer_on_the_document(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        credit = _credit(shift.id, "10.00", ("cash", "10.00"), customerName="Dana Levi",
                         customerPhone="050-1234567", customerAddress="Herzl 1")
        _push(w, till, [credit])

        c100 = _export(w, [_get(w, credit)])[0]["C100"][0]
        assert c100[57:107].strip() == "Dana Levi"
        assert c100[107:157].strip() == "Herzl 1"


# ── OpenFormat ────────────────────────────────────────────────────────────────


def _export(w, rows):
    """The BKMV records of `rows`, by record type — the export's own path, minus the zip."""
    bases = load_base_documents(w.db, w.tenant.id, rows)
    dicts = [transform_transaction_for_open_format(tx, 18.0, bases) for tx in rows]
    result = generate_tax_report(
        dicts, {"vatNumber": "515151515", "companyName": "Acme"},
        {"start": NOW - timedelta(days=1), "end": NOW + timedelta(days=1)},
        global_tax_rate=18.0,
    )
    by_type = {}
    for line in result.bkmv_content:
        by_type.setdefault(line[:4], []).append(line)
    return by_type, dicts


def _d110_base(record):
    return record[49:52], record[52:72].strip()


class TestOpenFormat:
    def test_exchange_legs_are_payment_type_6(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        sale = _sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"), basket=basket)
        credit = _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket)
        _push(w, till, [sale, credit])

        records, _ = _export(w, [_get(w, sale), _get(w, credit)])

        types = [(r[22:25], r[49]) for r in records["D120"]]
        assert types == [("320", "1"), ("320", "6"), ("330", "6")]

    def test_a_single_exchange_leg_document_is_type_6_too(self):
        tx = {"documentType": 330, "paymentMethod": "exchange", "transactionNumber": "1",
              "createdAt": NOW.isoformat(), "cart": {"totalAmount": 40}}
        assert build_d120_record(tx, 1, "515151515", 1, "0000001")[49] == "6"

    def test_each_line_names_its_base_document_even_outside_the_window(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        first = _original(w, till, shift, "10.00", minutes=-60 * 24 * 40)
        second = _original(w, till, shift, "20.00", minutes=-60 * 24 * 40)
        basket = uuid.uuid4()
        credit_first = _credit(
            shift.id, "10.00", ("exchange", "10.00"), basket=basket, refund_of=first["id"],
            items=[_line("10.00", refund_of_item=first["items"][0]["id"])],
        )
        credit_second = _credit(
            shift.id, "20.00", ("exchange", "20.00"), basket=basket, refund_of=second["id"],
            items=[_line("20.00", refund_of_item=second["items"][0]["id"])],
        )
        catalogue = _credit(shift.id, "5.00", ("exchange", "5.00"), basket=basket)
        _push(w, till, [credit_first, credit_second, catalogue])

        # Only the credit notes are exported: their originals are 40 days older.
        records, _ = _export(w, [_get(w, credit_first), _get(w, credit_second), _get(w, catalogue)])

        assert [_d110_base(r) for r in records["D110"]] == [
            ("320", first["transactionNumber"]),
            ("320", second["transactionNumber"]),
            ("000", ""),
        ]

    def test_a_line_link_names_the_base_even_without_a_document_link(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00")
        credit = _credit(shift.id, "10.00", ("cash", "10.00"),
                         items=[_line("10.00", refund_of_item=original["items"][0]["id"])])
        _push(w, till, [credit])

        records, _ = _export(w, [_get(w, credit)])

        assert _d110_base(records["D110"][0]) == ("320", original["transactionNumber"])

    def test_another_tenants_original_is_never_named(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "10.00")
        credit = _credit(shift.id, "10.00", ("cash", "10.00"), refund_of=original["id"])
        _push(w, till, [credit])
        w.db.get(Transaction, uuid.UUID(original["id"])).tenant_id = _stranger(w)
        w.db.flush()

        records, _ = _export(w, [_get(w, credit)])

        assert _d110_base(records["D110"][0]) == ("000", "")

    def test_an_unlinked_credit_note_is_filed_as_a_credit_note(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        credit = _credit(shift.id, "15.00", ("cash", "15.00"))
        _push(w, till, [credit])

        records, _ = _export(w, [_get(w, credit)])

        assert records["C100"][0][22:25] == "330"
        assert records["D110"][0][22:25] == "330"
        assert records["D120"][0][22:25] == "330"


# ── Dashboard ─────────────────────────────────────────────────────────────────


class TestTheDashboard:
    def _summary(self, w):
        q = w.db.query(Transaction).filter(Transaction.tenant_id == w.tenant.id)
        return compute_sales_summary(w.db, q, NOW - timedelta(days=1), NOW + timedelta(days=1))

    def test_an_unlinked_credit_note_is_a_refund_not_a_sale(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        _push(w, till, [_sale(shift.id, "100.00", ("cash", "100.00")),
                        _credit(shift.id, "15.00", ("cash", "15.00"))])

        s = self._summary(w)

        assert s.gross_revenue == 100.0
        assert s.transactions_count == 1
        assert (s.refunds_count, s.refunds_amount) == (1, 15.0)
        assert s.net_revenue == 85.0
        rows = compute_breakdown(
            w.db, w.db.query(Transaction).filter(Transaction.tenant_id == w.tenant.id),
            NOW - timedelta(days=1), NOW + timedelta(days=1), "shop",
        )
        assert [(r.gross_revenue, r.net_revenue, r.transactions_count) for r in rows] == [(100.0, 85.0, 1)]

    def test_a_legacy_document_with_no_type_is_still_a_sale(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        doc = w.doc(till, shift, "20.00")
        doc.document_type = None
        w.db.flush()

        assert self._summary(w).gross_revenue == 20.0

    def test_a_cancelled_credit_note_is_no_refund(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        _push(w, till, [_credit(shift.id, "15.00", ("card", "15.00"), status="cancelled")])

        assert self._summary(w).refunds_count == 0

    def test_exchange_is_neither_cash_nor_card(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        _push(w, till, [_sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"), basket=basket),
                        _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket)])

        s = self._summary(w)
        assert (s.payment_cash, s.payment_card) == (60.0, 0.0)

    def test_the_detail_links_the_basket(self, w):
        till = w.tills[0]
        shift = _open(w, till)
        original = _original(w, till, shift, "40.00")
        basket = uuid.uuid4()
        sale = _sale(shift.id, "100.00", ("cash", "60.00"), ("exchange", "40.00"), basket=basket)
        credit = _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket,
                         refund_of=original["id"], minutes=1,
                         items=[_line("40.00", refund_of_item=original["items"][0]["id"])])
        _push(w, till, [sale, credit])
        # Another tenant's document naming the same basket id is never a sibling.
        stranger = w.doc(till, shift, "5.00")
        stranger.basket_id = basket
        stranger.tenant_id = _stranger(w)
        w.db.flush()

        out = get_transaction(
            transaction_id=uuid.UUID(credit["id"]), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )

        assert out.basket_id == basket
        assert [(d.id, d.document_type) for d in out.basket_documents] == [(uuid.UUID(sale["id"]), 320)]
        assert out.refund_of_transaction_number == original["transactionNumber"]
        assert out.items[0].refund_of_item_id == uuid.UUID(original["items"][0]["id"])
        body = out.model_dump(by_alias=True, mode="json")
        assert body["basketDocuments"][0]["transactionNumber"] == sale["transactionNumber"]
        assert {p["method"] for p in body["payments"]} == {"exchange"}


class TestTheShopFeed:
    def test_it_carries_the_basket(self, w):
        """The feed reads the real clock (its window is "the last hours"), so these do too."""
        from app.services.reports import load_shop_transactions_for_machine

        till = w.tills[0]
        shift = _open(w, till)
        basket = uuid.uuid4()
        now = datetime.now(timezone.utc).isoformat()
        sale = _sale(shift.id, "40.00", ("exchange", "40.00"), basket=basket, createdAt=now, updatedAt=now)
        credit = _credit(shift.id, "40.00", ("exchange", "40.00"), basket=basket, createdAt=now, updatedAt=now)
        plain = _sale(shift.id, "5.00", ("cash", "5.00"), createdAt=now, updatedAt=now)
        _push(w, till, [sale, credit, plain])

        rows, _ = load_shop_transactions_for_machine(w.db, w.tills[1], hours=24)

        by_id = {r.id: r for r in rows}
        assert by_id[sale["id"]].basket_id == by_id[credit["id"]].basket_id == str(basket)
        assert by_id[plain["id"]].basket_id is None
        assert by_id[sale["id"]].model_dump(by_alias=True)["basketId"] == str(basket)


def test_the_migration_is_the_single_head_on_top_of_shop_areas():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    assert script.get_heads() == ["d9e0f1a2b3c4"]
    assert script.get_revision("d9e0f1a2b3c4").down_revision == "c8d9e0f1a2b3"
