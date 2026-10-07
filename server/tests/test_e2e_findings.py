"""
Server findings of the 2026-09-29 end-to-end run (docs/SHIFTS_API.md).

* **Per-document rejection** — one document the model refused (productId "p12") was a
  422 for the whole batch, and the till retried it forever. Now an unreadable reference
  link is dropped and the document stored with a warning; only a document that truly
  cannot be stored is `rejected`, alone, and the rest of the batch lands.
* **Z cash over back-to-back shifts** — a till's drawer is handed from shift to shift,
  so summing floats and expecteds counted the same banknotes once per shift (Z #1:
  opening 455, expected 540, for a drawer holding ~180).
* **A credit note settles its original** — the refunded sale stayed `completed` in the
  cloud, because the till pushes only the credit note.
* **shopName** on the shift of a close request.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import inspect
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.models.shift import ShiftStatus
from app.models.sync_log import SyncLog, SyncStatus
from app.models.transaction import Transaction, TransactionStatus
from app.routers import sync as sync_router
from app.routers import z_reports as ZRouter
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify
from app.services import reports as R
from app.services import shift_close_requests as SCR
from app.services import z_runs as ZR
from app.services.shift_totals import compute_totals
from app.services.shifts import apply_shift_close
from app.schemas.transaction import TransactionIn
from app.services.transactions import (
    drop_unreadable_references,
    settle_credited_originals,
    validate_documents,
)
from app.services.z_builder import till_cash_summary, z_cash_summary
from app.models.z_run import ZRunStatus
from app.models.z_report import ZReport
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


def _doc(shift_id=None, total="10.00", **extra) -> dict:
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": total,
        "paymentMethod": "cash",
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return body


def _credit(original_id, total, shift_id=None, minutes=1, **extra) -> dict:
    at = (NOW + timedelta(minutes=minutes)).isoformat()
    return _doc(
        shift_id, total, documentType=330, refundOfTransactionId=str(original_id),
        createdAt=at, updatedAt=at, **extra,
    )


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id),
        body=TransactionsBatchEnvelope(transactions=docs),
        machine=till,
        db=w.db,
    )


# ── 1. Per-document rejection ────────────────────────────────────────────────


class TestOneBadDocumentDoesNotJamTheBatch:
    def test_the_bad_document_is_rejected_and_the_rest_is_stored(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        good = _doc(shift.id, "25.00")
        bad = _doc(shift.id, "12.00", items=[{
            "id": str(uuid.uuid4()), "quantity": "one", "unitPrice": 12, "totalPrice": 12,
        }])
        after = _doc(shift.id, "7.00")

        response = _push(w, till, [good, bad, after])

        assert [(str(r.id), r.status) for r in response.results] == [
            (good["id"], "accepted"), (bad["id"], "rejected"), (after["id"], "accepted"),
        ]
        reason = response.results[1].reason
        assert reason.startswith("items[0].quantity: Input should be a valid decimal")
        stored = {str(t.id) for t in w.db.query(Transaction).all()}
        assert stored == {good["id"], after["id"]}
        assert response.unidentified is None

    def test_the_rejection_is_in_the_sync_log(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        bad = _doc(shift.id, totalAmount="lots")

        _push(w, till, [bad])

        log = w.db.query(SyncLog).one()
        assert str(log.entity_id) == bad["id"] and log.status == SyncStatus.FAILED
        assert log.conflict_note.startswith("totalAmount: ")

    def test_every_error_of_a_document_is_named(self, w):
        bad = _doc(totalAmount="lots", createdAt="yesterday")

        _valid, refused, _none = validate_documents([bad])

        reason = refused[0][1].reason
        assert "totalAmount: " in reason and "createdAt: " in reason and "; " in reason

    def test_an_unreadable_product_link_is_dropped_and_the_sale_kept(self, w):
        """The E2E case: productId "p12". The sale happened; only the link is lost."""
        from app.models.transaction_item import TransactionItem

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "12.00", items=[{
            "id": str(uuid.uuid4()), "productId": "p12", "productName": "Espresso", "sku": "12",
            "quantity": 1, "unitPrice": 12, "totalPrice": 12,
        }])

        response = _push(w, till, [sale])

        (result,) = response.results
        assert (str(result.id), result.status, result.reason) == (sale["id"], "accepted", None)
        assert result.warnings == ["items[0].productId: unreadable 'p12', stored without the link"]
        item = w.db.query(TransactionItem).one()
        assert item.product_id is None
        assert (item.product_name, item.sku, item.total_price) == ("Espresso", "12", Decimal("12.00"))
        log = w.db.query(SyncLog).one()
        assert log.status == SyncStatus.SUCCESS and "'p12'" in log.conflict_note

    def test_an_unknown_product_link_is_dropped_with_the_same_warning(self, w):
        """A well-formed UUID naming no product loses its link as "p12" does — and says so."""
        from app.models.category import Category
        from app.models.product import CatalogLevel, Product
        from app.models.transaction_item import TransactionItem

        till = w.tills[0]
        category = Category(id=uuid.uuid4(), tenant_id=till.tenant_id, name="Drinks")
        known = Product(
            id=uuid.uuid4(), tenant_id=till.tenant_id, category_id=category.id,
            catalog_level=CatalogLevel.GLOBAL, name="Cola", price=Decimal("8"), sku="COLA",
        )
        w.db.add_all([category, known])
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        unknown = uuid.uuid4()
        line = {"quantity": 1, "unitPrice": 8, "totalPrice": 8}
        sale = _doc(shift.id, "24.00", items=[
            {"id": str(uuid.uuid4()), "productId": "p12", "productName": "Espresso", **line},
            {"id": str(uuid.uuid4()), "productId": str(unknown), "productName": "Tea", **line},
            {"id": str(uuid.uuid4()), "productId": str(known.id), "productName": "Cola", **line},
        ])

        (result,) = _push(w, till, [sale]).results

        assert result.status == "accepted"
        assert result.warnings == [
            "items[0].productId: unreadable 'p12', stored without the link",
            f"items[1].productId: unknown '{unknown}', stored without the link",
        ]
        links = {i.product_name: i.product_id for i in w.db.query(TransactionItem).all()}
        assert links == {"Espresso": None, "Tea": None, "Cola": known.id}
        log = w.db.query(SyncLog).one()
        assert str(unknown) in log.conflict_note and "'p12'" in log.conflict_note

        (again,) = _push(w, till, [sale]).results
        assert again.status == "duplicate" and again.warnings == result.warnings

    def test_an_unknown_voucher_link_is_dropped_with_a_warning(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        voucher, product = uuid.uuid4(), uuid.uuid4()
        sale = _doc(shift.id, "50.00", issuedVouchers=[{
            "id": str(uuid.uuid4()), "voucherId": str(voucher), "productId": str(product),
            "productName": "Gift card", "quantity": 1, "unitValue": 50, "faceValue": 50,
            "issuedAt": NOW.isoformat(),
        }])

        (result,) = _push(w, till, [sale]).results

        assert result.status == "accepted", result.reason
        assert result.warnings == [
            f"issuedVouchers[0].voucherId: unknown '{voucher}', stored without the link",
            f"issuedVouchers[0].productId: unknown '{product}', stored without the link",
        ]

    def test_a_re_push_answers_the_warning_again(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "12.00", items=[{
            "id": str(uuid.uuid4()), "productId": 12, "quantity": 1, "unitPrice": 12, "totalPrice": 12,
        }])
        _push(w, till, [sale])

        (again,) = _push(w, till, [sale]).results

        assert again.status == "duplicate"
        assert again.warnings == ["items[0].productId: unreadable 12, stored without the link"]

    def test_voucher_links_and_stock_movements(self, w):
        doc, warnings = drop_unreadable_references(_doc(
            issuedVouchers=[{"id": str(uuid.uuid4()), "voucherId": "v-1", "productId": None,
                             "transactionItemId": "line-1", "issuedAt": NOW.isoformat()}],
            stockMovements=[
                {"id": str(uuid.uuid4()), "productId": "p12", "delta": -1, "reason": "sale",
                 "occurredAt": NOW.isoformat()},
                {"id": str(uuid.uuid4()), "productId": str(uuid.uuid4()), "delta": -1,
                 "reason": "sale", "transactionItemId": "line-1", "occurredAt": NOW.isoformat()},
            ],
        ))

        voucher = doc["issuedVouchers"][0]
        assert voucher["voucherId"] is None and voucher["transactionItemId"] is None
        assert len(doc["stockMovements"]) == 1
        assert doc["stockMovements"][0]["transactionItemId"] is None
        assert len(warnings) == 4
        assert "stockMovements[0].productId: unreadable 'p12', movement not applied" in warnings
        assert TransactionIn.model_validate(doc)

    @pytest.mark.parametrize("field,value", [
        ("shiftId", "shift-7"),
        ("refundOfTransactionId", "sale-3"),
        ("totalAmount", "lots"),
        ("createdAt", "yesterday"),
    ])
    def test_what_decides_the_money_is_still_refused(self, w, field, value):
        (_i, result), = validate_documents([_doc(**{field: value})])[1]

        assert result.status == "rejected" and result.reason.startswith(f"{field}: ")

    @pytest.mark.parametrize("field", ["approvedByUserId", "approvedByPosUserId"])
    def test_an_unreadable_approver_never_refuses_the_document(self, w, field):
        """An approver is informational since 2026-10-07 (docs/SHIFTS_API.md §1.2b)."""
        valid, refused, _unidentified = validate_documents([_doc(**{field: "manager"})])

        assert refused == []
        (_i, tx, warnings), = valid
        assert getattr(tx, "approved_by_user_id") is None and getattr(tx, "approved_by_pos_user_id") is None
        assert warnings == [f"{field}: unreadable 'manager', stored without the approver"]

    def test_a_valid_document_carries_no_warnings(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        body = json.loads(_push(w, till, [_doc(shift.id)]).model_dump_json(by_alias=True))

        assert body["results"][0]["warnings"] is None

    def test_a_document_whose_id_is_not_a_uuid_is_answered_by_that_id(self, w):
        till = w.tills[0]
        bad = _doc(id="local-17")

        response = _push(w, till, [bad])

        assert response.results[0].id == "local-17"
        assert response.results[0].status == "rejected"
        assert response.results[0].reason.startswith("id: ")
        log = w.db.query(SyncLog).one()
        assert log.entity_id is None and "local-17" in log.conflict_note

    def test_a_document_with_no_id_is_answered_by_its_position_not_in_results(self, w):
        """A shipped till decodes `results[].id` as a non-null string: never a null there."""
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        good = _doc(shift.id)
        no_id = {k: v for k, v in _doc().items() if k != "id"}

        response = _push(w, till, [no_id, "not a document", good])

        assert [(str(r.id), r.status) for r in response.results] == [(good["id"], "accepted")]
        assert [(u.index, u.status) for u in response.unidentified] == [(0, "rejected"), (1, "rejected")]
        assert response.unidentified[0].reason.startswith("id: Field required")
        assert response.unidentified[1].reason == "document: a document must be a JSON object"
        body = json.loads(response.model_dump_json(by_alias=True))
        assert all(isinstance(r["id"], str) for r in body["results"])

    def test_a_valid_batch_answers_as_before(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _doc(shift.id)

        first = _push(w, till, [doc])
        again = _push(w, till, [doc])

        assert [r.status for r in first.results] == ["accepted"]
        assert [r.status for r in again.results] == ["duplicate"]
        body = json.loads(first.model_dump_json(by_alias=True))
        assert set(body) == {"serverTime", "results", "unidentified"}
        assert body["unidentified"] is None
        assert body["results"][0]["id"] == doc["id"]

    def test_an_unknown_shift_no_longer_refuses_the_batch(self, w):
        """
        It used to be a 409 for the whole batch (`another_shift_open`). Since 2026-10-07 the
        readable document waits for its shift (docs/SHIFTS_API.md §1.2c-bis) and only the
        unreadable one is refused.
        """
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()

        response = _push(w, till, [_doc(uuid.uuid4()), _doc(uuid.uuid4(), totalAmount="x")])

        assert [r.status for r in response.results] == ["accepted", "rejected"]
        assert w.db.query(Transaction).count() == 1

    def test_only_the_envelope_is_validated_by_the_route(self):
        assert inspect.signature(sync_router.post_transactions).parameters["body"].annotation is (
            TransactionsBatchEnvelope
        )
        TransactionsBatchEnvelope.model_validate({"transactions": [{"id": "x"}, 5]})
        with pytest.raises(ValidationError):
            TransactionsBatchEnvelope.model_validate({"transactions": "not a list"})
        with pytest.raises(ValidationError):
            TransactionsBatchEnvelope.model_validate({})


# ── 2. Z cash over back-to-back shifts of one till ───────────────────────────


def _closed(w, till, seq, cash_sales, *, opening, counted):
    """A closed shift whose cash takings net to `cash_sales` (negative: a cash refund)."""
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    net = Decimal(cash_sales)
    docs = [w.doc(till, shift, str(abs(net)), credit_note=net < 0)] if net else []
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=1)).isoformat(),
        "countedCash": counted,
        "transactionIds": [str(d.id) for d in docs],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def _z(w, *tills) -> ZReport:
    r = ZR.create_z_run(
        w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=t.id) for t in tills], now=NOW
    )
    assert r.status == ZRunStatus.COMPLETED, (r.status, r.error_code, r.error_message)
    return w.db.get(ZReport, r.z_report_id)


def _e2e_shifts(w, till):
    """The E2E run: A float 100 → 180, counted 175; B 175 → 180 and C 180 → 185, uncounted."""
    return [
        _closed(w, till, 1, "80.00", opening="100.00", counted="175.00"),
        _closed(w, till, 2, "5.00", opening="175.00", counted=None),
        _closed(w, till, 3, "5.00", opening="180.00", counted=None),
    ]


def _assert_reconciles(section):
    """A counted till's over/short is exactly its count less its expected."""
    assert section["overShort"] is not None
    assert Decimal(section["countedCash"]) - Decimal(section["expectedCash"]) == Decimal(
        section["overShort"]
    )


class TestTheDrawerIsCarriedFromShiftToShift:
    def test_the_e2e_numbers(self, w):
        till = w.tills[0]
        _e2e_shifts(w, till)

        z = _z(w, till)

        # A's 5 short was carried into B's float: the period's expected is 100 + 90 cash
        # = 190, not C's 185 (which assumes A's missing 5 was never missing).
        (section,) = z.per_machine
        assert section["openingCash"] == "100.00"
        assert section["betweenShiftAdjustments"] == "0.00"
        assert section["expectedCash"] == "190.00"
        assert section["countedCash"] is None
        assert section["overShort"] is None
        assert section["uncountedShiftCount"] == 2
        assert section["cashSalesNet"] == "90.00"
        assert (z.opening_cash, z.expected_cash) == (Decimal("100.00"), Decimal("190.00"))
        assert z.actual_cash is None and z.discrepancy is None

    def test_the_count_is_the_last_shifts_and_over_short_every_shifts(self, w):
        till = w.tills[0]
        _closed(w, till, 1, "80.00", opening="100.00", counted="175.00")   # −5
        _closed(w, till, 2, "5.00", opening="175.00", counted="182.00")    # +2

        (section,) = _z(w, till).per_machine

        assert section["openingCash"] == "100.00"
        assert section["expectedCash"] == "185.00"
        assert section["countedCash"] == "182.00"
        assert section["overShort"] == "-3.00"
        _assert_reconciles(section)

    def test_z3_a_surplus_carried_into_the_next_float(self, w):
        """
        E2E Z #3: E float 180, +10 cash, expected 190, counted 192 (+2); F opened on the
        192 E left, −2 cash (a refund), expected 190, counted 189 (−1). The Z read
        expected 190, counted 189, over/short +1 — which does not add up. The drawer
        started at 180 and took 8: expected 188, and 189 − 188 = +1.
        """
        till = w.tills[0]
        e = _closed(w, till, 1, "10.00", opening="180.00", counted="192.00")
        f = _closed(w, till, 2, "-2.00", opening="192.00", counted="189.00")
        assert (e.total_cash, f.total_cash) == (Decimal("10.00"), Decimal("-2.00"))

        z = _z(w, till)

        (section,) = z.per_machine
        assert section["openingCash"] == "180.00"
        assert section["cashSalesNet"] == "8.00"
        assert section["betweenShiftAdjustments"] == "0.00"   # F's float is what E left
        assert section["expectedCash"] == "188.00"
        assert section["countedCash"] == "189.00"
        assert section["overShort"] == "1.00"
        _assert_reconciles(section)
        assert (z.opening_cash, z.expected_cash, z.actual_cash, z.discrepancy) == (
            Decimal("180.00"), Decimal("188.00"), Decimal("189.00"), Decimal("1.00"),
        )
        assert z.actual_cash - z.expected_cash == z.discrepancy

    def test_cash_moved_between_shifts_is_its_own_line(self, w):
        """E left 192; F opened on 150 (42 banked in between), took 5 and counted 154."""
        till = w.tills[0]
        _closed(w, till, 1, "10.00", opening="180.00", counted="192.00")   # +2
        _closed(w, till, 2, "5.00", opening="150.00", counted="154.00")    # −1

        z = _z(w, till)

        (section,) = z.per_machine
        assert section["betweenShiftAdjustments"] == "-42.00"
        assert section["expectedCash"] == "153.00"   # 180 + 15 − 42
        assert section["overShort"] == "1.00"
        _assert_reconciles(section)
        body = ZRouter.z_to_out(z)
        assert body.between_shift_adjustments == Decimal("-42.00")

    def test_the_period_expected_is_the_last_less_the_earlier_over_shorts(self, w):
        """The algebra in `till_cash_summary`: expected = expected_n − Σ_{i<n} d_i."""
        till = w.tills[0]
        shifts = [
            _closed(w, till, 1, "80.00", opening="100.00", counted="175.00"),  # −5
            _closed(w, till, 2, "5.00", opening="175.00", counted=None),       # d = 0
            _closed(w, till, 3, "7.00", opening="200.00", counted="210.00"),   # +3, 20 put in
            _closed(w, till, 4, "-4.00", opening="100.00", counted="95.00"),   # −1, 110 out
        ]
        summary = till_cash_summary(shifts)

        expected_n = shifts[-1].opening_cash + shifts[-1].total_cash
        earlier = sum(
            (s.counted_cash - (s.opening_cash + s.total_cash) for s in shifts[:-1] if s.counted_cash is not None),
            Decimal("0"),
        )
        assert summary["expected"] == expected_n - earlier == Decimal("98.00")
        assert summary["between_shifts"] == Decimal("-90.00")   # +20 − 110
        assert summary["over_short"] is None                    # shift 2 uncounted
        assert summary["counted"] - summary["expected"] == Decimal("-3.00")  # Σ known d_i, withheld

    def test_an_old_z_keeps_its_numbers(self, w):
        till = w.tills[0]
        _closed(w, till, 1, "10.00", opening="180.00", counted="192.00")
        z = _z(w, till)
        z.per_machine = [
            {k: v for k, v in section.items() if k != "betweenShiftAdjustments"}
            for section in z.per_machine
        ]
        assert ZRouter.z_to_out(z).between_shift_adjustments is None

    def test_an_earlier_uncounted_shift_withholds_over_short_but_not_the_count(self, w):
        till = w.tills[0]
        _closed(w, till, 1, "80.00", opening="100.00", counted=None)
        _closed(w, till, 2, "5.00", opening="180.00", counted="185.00")

        z = _z(w, till)

        (section,) = z.per_machine
        assert section["countedCash"] == "185.00" and section["overShort"] is None
        assert z.actual_cash == Decimal("185.00") and z.discrepancy is None

    def test_the_z_sums_the_tills(self, w):
        one, two = w.tills
        _e2e_shifts(w, one)
        _closed(w, two, 1, "40.00", opening="50.00", counted="90.00")

        z = _z(w, one, two)

        assert z.opening_cash == Decimal("150.00")      # 100 + 50
        assert z.expected_cash == Decimal("280.00")     # 190 + 90
        assert z.actual_cash is None and z.discrepancy is None  # till 1 uncounted

    def test_counted_everywhere_sums_counts_and_over_shorts(self, w):
        one, two = w.tills
        _closed(w, one, 1, "80.00", opening="100.00", counted="175.00")   # −5
        _closed(w, one, 2, "5.00", opening="175.00", counted="180.00")    # 0
        _closed(w, two, 1, "40.00", opening="50.00", counted="91.00")     # +1

        z = _z(w, one, two)

        assert z.expected_cash == Decimal("275.00")     # 185 + 90
        assert z.actual_cash == Decimal("271.00")
        assert z.discrepancy == Decimal("-4.00")
        assert z.actual_cash - z.expected_cash == z.discrepancy
        for section in z.per_machine:
            _assert_reconciles(section)

    def test_no_shifts_is_nothing(self):
        assert till_cash_summary([])["counted"] is None
        assert z_cash_summary([])["counted"] is None


class TestTheDaySummaryReadsTheZsOverShort:
    def test_variance_is_the_zs_discrepancy_not_counted_minus_expected(self, w):
        till = w.tills[0]
        _closed(w, till, 1, "80.00", opening="100.00", counted="175.00")   # −5
        _closed(w, till, 2, "5.00", opening="175.00", counted="180.00")    # 0
        z = _z(w, till)
        assert z.actual_cash - z.expected_cash == z.discrepancy == Decimal("-5.00")

        acc = R._Accumulator()
        acc.add(z)

        assert acc.to_totals().variance == -5.00

    def test_a_cloud_z_without_over_short_withholds_the_variance(self, w):
        till = w.tills[0]
        _closed(w, till, 1, "80.00", opening="100.00", counted=None)
        _closed(w, till, 2, "5.00", opening="180.00", counted="185.00")
        acc = R._Accumulator()
        acc.add(_z(w, till))

        totals = acc.to_totals()
        assert totals.variance is None and totals.uncounted_count == 1
        (contributor,) = R._contributors_of(w.db.query(ZReport).one())
        assert contributor.uncounted is True


# ── 3. A credit note settles its original ────────────────────────────────────


def _status(w, doc_id) -> TransactionStatus:
    w.db.expire_all()
    return w.db.get(Transaction, uuid.UUID(str(doc_id))).status


class TestACreditNoteSettlesItsOriginal:
    def test_partial_then_full(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00")
        _push(w, till, [sale])

        _push(w, till, [_credit(sale["id"], "40.00", shift.id, minutes=1)])
        assert _status(w, sale["id"]) == TransactionStatus.PARTIAL_REFUND

        _push(w, till, [_credit(sale["id"], "60.00", shift.id, minutes=2)])
        assert _status(w, sale["id"]) == TransactionStatus.REFUNDED

    def test_what_was_collected_is_the_measure(self, w):
        """A sale's collected amount is its total less the document discount."""
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00", documentDiscount="10.00")
        _push(w, till, [sale])

        _push(w, till, [_credit(sale["id"], "90.00", shift.id)])

        assert _status(w, sale["id"]) == TransactionStatus.REFUNDED

    def test_it_is_idempotent(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00")
        credit = _credit(sale["id"], "40.00", shift.id)
        _push(w, till, [sale, credit])

        again = _push(w, till, [credit])
        stale_original = _push(w, till, [sale])  # a retry of the original, still "completed"

        assert [r.status for r in again.results] == ["duplicate"]
        assert [r.status for r in stale_original.results] == ["duplicate"]
        assert _status(w, sale["id"]) == TransactionStatus.PARTIAL_REFUND
        assert w.db.get(Transaction, uuid.UUID(credit["id"])).over_credited is False

    def test_an_over_credit_is_stored_and_flagged(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00")
        first = _credit(sale["id"], "70.00", shift.id, minutes=1)
        second = _credit(sale["id"], "50.00", shift.id, minutes=2)
        _push(w, till, [sale, first])

        response = _push(w, till, [second])

        assert [r.status for r in response.results] == ["accepted"]
        w.db.expire_all()
        assert w.db.get(Transaction, uuid.UUID(first["id"])).over_credited is False
        assert w.db.get(Transaction, uuid.UUID(second["id"])).over_credited is True
        assert _status(w, sale["id"]) == TransactionStatus.REFUNDED

    def test_a_pending_credit_note_moves_nothing(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00")
        _push(w, till, [sale, _credit(sale["id"], "40.00", shift.id, status="pending")])

        assert _status(w, sale["id"]) == TransactionStatus.COMPLETED

    def test_a_cancelled_original_is_left_alone(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00", status="cancelled")
        _push(w, till, [sale, _credit(sale["id"], "40.00", shift.id)])

        assert _status(w, sale["id"]) == TransactionStatus.CANCELLED

    def test_another_tenants_document_is_never_restated(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = w.doc(till, shift, "100.00")
        w.doc(till, shift, "100.00", credit_note=True).refund_of_transaction_id = sale.id
        w.db.flush()

        settle_credited_originals(w.db, uuid.uuid4(), [sale.id])

        assert _status(w, sale.id) == TransactionStatus.COMPLETED

    def test_the_x_is_unchanged(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = _doc(shift.id, "100.00")
        credit = _credit(sale["id"], "40.00", shift.id)
        _push(w, till, [sale, credit])
        before = compute_totals(w.db, [shift.id]).as_x()

        w.db.get(Transaction, uuid.UUID(sale["id"])).status = TransactionStatus.COMPLETED
        w.db.flush()
        as_if_unsettled = compute_totals(w.db, [shift.id]).as_x()

        assert before == as_if_unsettled
        assert before["total_sales"] == Decimal("100.00")
        assert before["total_refunds"] == Decimal("40.00")
        assert before["total_cash"] == Decimal("60.00")


# ── 4. shopName on a close request's shift ───────────────────────────────────


class TestACloseRequestNamesTheShop:
    def test_the_shift_summary_carries_the_shop_name(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        till.last_heartbeat_at = NOW

        req, created = SCR.request_close(w.db, w.admin, till, now=NOW)
        w.db.flush()

        out = SCR.request_to_out(w.db, req, now=NOW)
        assert created and out["shift"].shop_name == "Center"
        assert out["shift"].machine_name == "Till 1"


# ── 5. The till's write answers are in the body log ──────────────────────────


class TestWhichResponseBodiesAreLogged:
    M = "899ed8da-aab0-4072-923e-94eecf487bb2"

    @pytest.mark.parametrize("path", [
        f"/api/v1/sync/{M}/transactions",
        f"/api/v1/sync/{M}/shifts",
        f"/api/v1/sync/{M}/shifts/{M}/close",
        f"/api/v1/sync/{M}/shift-close/ack",
    ])
    def test_the_tills_write_answers_are(self, path):
        from app.observability.body_logging import should_log_response_body

        assert should_log_response_body("POST", path, 200)

    @pytest.mark.parametrize("method,path", [
        ("GET", f"/api/v1/sync/{M}/catalog"),
        ("GET", f"/api/v1/sync/{M}/pos-users"),
        ("GET", f"/api/v1/sync/{M}/shifts/last-closed"),
        ("POST", "/api/v1/pairing/validate"),
        ("GET", "/api/v1/machines/me/ably-auth"),
        ("POST", f"/api/v1/sync/{M}/transactions/extra"),
    ])
    def test_nothing_else_that_succeeds_is(self, method, path):
        from app.observability.body_logging import should_log_response_body

        assert not should_log_response_body(method, path, 200)

    def test_every_error_still_is(self):
        from app.observability.body_logging import should_log_response_body

        assert should_log_response_body("GET", "/api/v1/machines/me/ably-auth", 503)
