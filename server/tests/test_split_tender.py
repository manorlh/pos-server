"""
Split tender: what the legs must add up to, and what happens when they do not.

Everything here is arithmetic and one ingest decision, which is exactly the part a
database cannot check for us. Style matches the rest of tests/: no DB fixtures, and
the report SQL is compiled against the Postgres dialect rather than executed.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Query, sessionmaker

from app.models.user import User, UserRole
from app.schemas.transaction import TransactionIn
from app.services import reports as R
from app.services import transactions as T
from app.services.open_format.tax_report_generator import (
    build_d120_record,
    resolve_payment_legs,
)
from app.services.tenders import (
    MIXED_PAYMENT_METHOD,
    derive_payment_method,
    expected_tender_total,
    reconciliation_error,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _tx(**overrides) -> TransactionIn:
    base = dict(
        id=uuid.uuid4(),
        transactionNumber="1001",
        documentType=320,
        totalAmount=Decimal("100.00"),
        createdAt=datetime(2026, 8, 28, 9, 0, tzinfo=timezone.utc),
        updatedAt=datetime(2026, 8, 28, 9, 0, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return TransactionIn.model_validate(base)


def _leg(method: str, amount: str, sequence: int = 1) -> dict:
    return {"id": str(uuid.uuid4()), "sequence": sequence, "method": method, "amount": amount}


# ── The reconciliation target ────────────────────────────────────────────────

def test_sale_target_is_net_of_the_document_discount() -> None:
    # total_amount is the GROSS of the line totals; document_discount carries the sum
    # of the line discounts. The money the customer handed over is the difference.
    assert expected_tender_total(
        total_amount=Decimal("100.00"),
        document_discount=Decimal("10.00"),
        document_type=320,
        refund_of_transaction_id=None,
    ) == Decimal("90.00")


def test_credit_note_target_does_not_subtract_the_discount_again() -> None:
    # A credit note's total_amount is ALREADY the money handed back, and its
    # document_discount repeats the apportioned share. Subtracting it would ask the
    # tills to account for less cash than they gave out.
    assert expected_tender_total(
        total_amount=Decimal("40.00"),
        document_discount=Decimal("5.00"),
        document_type=330,
        refund_of_transaction_id=None,
    ) == Decimal("40.00")


def test_a_credit_note_is_recognised_by_its_back_link_too() -> None:
    # Legacy rows can have a null document_type; the back-link is the other signal.
    assert expected_tender_total(
        total_amount=Decimal("40.00"),
        document_discount=Decimal("5.00"),
        document_type=None,
        refund_of_transaction_id=uuid.uuid4(),
    ) == Decimal("40.00")


def test_tips_are_outside_the_target() -> None:
    # A ₪100 sale with a ₪12 tip is still ₪100 of tender legs. The tip stays on the
    # document — folding it into a leg would put money in the OpenFormat payment
    # records that the document record does not claim.
    tx = _tx(tipAmount=Decimal("12.00"), payments=[_leg("card", "100.00")])
    assert T._tender_rejection_reason(tx) is None

    tipped_into_the_leg = _tx(tipAmount=Decimal("12.00"), payments=[_leg("card", "112.00")])
    assert T._tender_rejection_reason(tipped_into_the_leg) is not None


# ── Reconciliation ───────────────────────────────────────────────────────────

def test_legs_that_sum_to_the_document_reconcile() -> None:
    tx = _tx(payments=[_leg("cash", "50.00", 1), _leg("card", "50.00", 2)])
    assert T._tender_rejection_reason(tx) is None


def test_legs_that_do_not_sum_are_rejected_with_the_numbers_in_the_reason() -> None:
    tx = _tx(payments=[_leg("cash", "50.00", 1), _leg("card", "40.00", 2)])
    reason = T._tender_rejection_reason(tx)
    assert reason is not None
    assert "90" in reason and "100" in reason


def test_one_agora_of_rounding_per_leg_is_tolerated() -> None:
    # Splitting ₪100.01 "in half" is the case this exists for.
    assert reconciliation_error(
        Decimal("100.01"), [Decimal("50.00"), Decimal("50.00")]
    ) is None
    # Three agorot across two legs is not rounding.
    assert reconciliation_error(
        Decimal("100.03"), [Decimal("50.00"), Decimal("50.00")]
    ) is not None


def test_a_till_that_sends_no_payments_is_never_rejected() -> None:
    # The legacy contract: only `paymentMethod`. There is nothing to reconcile,
    # because the single leg is synthesised from the document's own amount.
    assert T._tender_rejection_reason(_tx(paymentMethod="cash")) is None


# ── Synthesising the legacy single leg ───────────────────────────────────────

def test_legacy_push_synthesises_one_leg_for_the_collectable_amount() -> None:
    tx = _tx(paymentMethod="cash", documentDiscount=Decimal("10.00"))
    legs = T._normalized_payment_legs(tx)
    assert len(legs) == 1
    assert legs[0].method == "cash"
    assert legs[0].amount == Decimal("90.00")
    assert legs[0].sequence == 1


def test_synthesised_leg_id_is_stable_across_retries() -> None:
    # Pushes are idempotent on the document id and legs are replaced on every push, so
    # a random id would mint a new primary key on each retry of the same document.
    tx = _tx(paymentMethod="card")
    first = T._normalized_payment_legs(tx)[0].id
    second = T._normalized_payment_legs(tx)[0].id
    assert first == second


def test_a_leg_with_no_named_tender_falls_back_to_other() -> None:
    # `method` is NOT NULL, and "other" is already where normalize_tender sends an
    # unrecognised value, so nothing downstream learns a new case.
    legs = T._normalized_payment_legs(_tx(paymentMethod=None))
    assert legs[0].method == "other"


def test_legs_are_persisted_in_sequence_order() -> None:
    tx = _tx(payments=[_leg("card", "40.00", 2), _leg("cash", "60.00", 1)])
    legs = T._normalized_payment_legs(tx)
    assert [leg.method for leg in legs] == ["cash", "card"]


# ── What payment_method says ─────────────────────────────────────────────────

def test_a_single_tender_document_keeps_its_own_method() -> None:
    assert derive_payment_method(["cash"]) == "cash"


def test_two_legs_on_the_same_tender_are_not_a_mixed_document() -> None:
    # Two notes taken on two swipes of the cash key is an ordinary cash sale, and
    # calling it mixed would push it out of the cash bucket of every legacy report.
    assert derive_payment_method(["cash", "cash"]) == "cash"


def test_two_tenders_make_the_document_mixed() -> None:
    assert derive_payment_method(["cash", "card"]) == MIXED_PAYMENT_METHOD


def test_mixed_falls_into_the_existing_other_bucket_not_cash_or_card() -> None:
    # The reason "mixed" is safe for readers that have not been taught about split
    # tender: it shows as unclassified rather than inflating cash or card.
    assert R.normalize_tender(MIXED_PAYMENT_METHOD) == "other"


def test_no_legs_at_all_leaves_the_tills_value_alone() -> None:
    assert derive_payment_method([], fallback="cash") == "cash"


# ── Ingest: a rejected document writes nothing ───────────────────────────────

def _machine() -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.tenant_id = uuid.uuid4()
    m.shop_id = uuid.uuid4()
    return m


def test_unbalanced_document_is_rejected_and_nothing_is_written() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    tx = _tx(payments=[_leg("cash", "50.00", 1), _leg("card", "40.00", 2)])

    results = T.upsert_transactions(db, _machine(), [tx])

    assert [r.status for r in results] == ["rejected"]
    assert "reconcile" in (results[0].reason or "")
    # The check runs before the trading day is resolved, so a rejected document does
    # not even leave an auto-opened day behind.
    db.execute.assert_not_called()
    db.add.assert_not_called()
    db.bulk_save_objects.assert_not_called()


def test_stored_leg_methods_are_canonicalised() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    db.query.return_value.filter.return_value.first.return_value = MagicMock()
    saved: list = []
    db.bulk_save_objects.side_effect = lambda rows, *a, **k: saved.extend(rows)

    tx = _tx(payments=[_leg(" Cash ", "60.00", 1), _leg("CARD", "40.00", 2)])
    T.upsert_transactions(db, _machine(), [tx])

    methods = [r.method for r in saved if hasattr(r, "method")]
    assert methods == ["cash", "card"]


def test_one_bad_document_does_not_take_the_batch_down() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    db.query.return_value.filter.return_value.first.return_value = MagicMock()
    good = _tx(payments=[_leg("cash", "100.00")])
    bad = _tx(payments=[_leg("cash", "1.00")])

    results = T.upsert_transactions(db, _machine(), [bad, good])
    assert [r.status for r in results] == ["rejected", "accepted"]


# ── The reports read the legs, not the document's tender ─────────────────────

def _window() -> R.ReportWindow:
    return R.ReportWindow(
        from_date=date(2026, 8, 1),
        to_date=date(2026, 8, 27),
        from_hour=None,
        to_hour=None,
        tz_name="Asia/Jerusalem",
        start=datetime(2026, 7, 31, 21, tzinfo=timezone.utc),
        end=datetime(2026, 8, 27, 21, tzinfo=timezone.utc),
    )


def _cashier_report_statements() -> list[str]:
    """Every statement `build_cashier_sales_report` tries to run, compiled not executed."""
    sql: list[str] = []

    def _all(query):
        sql.append(str(query.statement.compile(dialect=postgresql.dialect())))
        return []

    db = sessionmaker()()
    user = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN)
    with patch.object(Query, "all", _all), patch.object(Query, "first", lambda q: None):
        R.build_cashier_sales_report(db, user, uuid.uuid4(), _window())
    return sql


def test_cashier_tender_split_groups_by_the_leg_method() -> None:
    document_q, tender_q = _cashier_report_statements()

    assert "LEFT OUTER JOIN transaction_payments" in tender_q
    assert tender_q.rstrip().endswith(
        "GROUP BY transactions.cashier_id, coalesce(transaction_payments.method, transactions.payment_method)"
    )
    # The document-level figures must NOT be grouped by tender any more: a two-leg
    # document would otherwise count its gross, discounts and tips once per leg.
    assert document_q.rstrip().endswith("GROUP BY transactions.cashier_id")
    assert "transaction_payments" not in document_q


def test_cashier_tender_split_falls_back_for_documents_with_no_legs() -> None:
    # An OUTER join, never an inner one: a document written before split tender
    # existed still has to contribute its money, or cashNet + cardNet + otherNet
    # silently stops summing to net for every historical day.
    _document_q, tender_q = _cashier_report_statements()
    assert "coalesce(transaction_payments.amount" in tender_q
    assert "INNER JOIN transaction_payments" not in tender_q


# ── OpenFormat: one payment record per leg ───────────────────────────────────

def _of_tx(payments=None, total="100.00") -> dict:
    tx = {
        "id": str(uuid.uuid4()),
        "transactionNumber": "1001",
        "documentType": 320,
        "paymentMethod": "cash",
        "createdAt": "2026-08-28T09:00:00+00:00",
        "documentProductionDate": "2026-08-28T09:00:00+00:00",
        "cart": {"totalAmount": float(total), "items": []},
    }
    if payments is not None:
        tx["payments"] = payments
    return tx


def test_a_single_tender_document_still_produces_exactly_one_payment_record() -> None:
    one_leg = _of_tx(payments=[{"method": "cash", "amount": 100.0, "sequence": 1}])
    assert resolve_payment_legs(one_leg) == [(None, None)]
    # None/None means "use the document-level values", i.e. the pre-split output.
    assert build_d120_record(one_leg, 1, "123456789", 7, "0000001") == build_d120_record(
        _of_tx(), 1, "123456789", 7, "0000001"
    )


def test_split_tender_produces_one_payment_record_per_leg() -> None:
    tx = _of_tx(
        payments=[
            {"method": "cash", "amount": 40.0, "sequence": 1},
            {"method": "card", "amount": 60.0, "sequence": 2},
        ]
    )
    legs = resolve_payment_legs(tx)
    assert [m for m, _ in legs] == ["cash", "card"]
    assert [a for _, a in legs] == [40.0, 60.0]


def test_payment_records_still_sum_to_the_document_total_when_discounted() -> None:
    # D120 has always carried the same gross figure C100 declares (field 1223), and
    # the legs carry the money collected, which is net of the document discount.
    # Writing raw leg amounts would make the payment records stop summing to the
    # document record — a whole-file validation risk on a legal filing — so they are
    # apportioned to the total C100 already declares.
    tx = _of_tx(
        total="100.00",
        payments=[
            {"method": "cash", "amount": 30.0, "sequence": 1},
            {"method": "card", "amount": 60.0, "sequence": 2},
        ],
    )
    amounts = [a for _, a in resolve_payment_legs(tx)]
    assert round(sum(amounts), 2) == 100.00


def test_each_leg_gets_its_own_payment_type_code() -> None:
    # This is the actual fix in the export: card money is coded 3 and cash money 1 on
    # the same document, instead of the whole document taking one code.
    cash = build_d120_record(
        _of_tx(), 1, "123456789", 7, "0000001", payment_method="cash", payment_amount_override=40.0
    )
    card = build_d120_record(
        _of_tx(), 2, "123456789", 8, "0000001", payment_method="card", payment_amount_override=60.0
    )
    # Field 1251 (payment type) sits after the 4-char code, 9-char record number,
    # 9-char VAT, 3-char doc type, 20-char doc number and 4-char line number.
    offset = 4 + 9 + 9 + 3 + 20 + 4
    assert cash[offset] == "1"
    assert card[offset] == "3"


def test_unrecognised_tenders_keep_landing_on_the_cash_code() -> None:
    # Deliberate: the מבנה אחיד table has codes for cheque and bank transfer, but
    # mapping new tender strings onto tax codes is a filing decision, not a refactor.
    record = build_d120_record(
        _of_tx(), 1, "123456789", 7, "0000001", payment_method="bit", payment_amount_override=10.0
    )
    offset = 4 + 9 + 9 + 3 + 20 + 4
    assert record[offset] == "1"


@pytest.mark.parametrize("legs", [None, [], [{"method": "cash", "amount": 0.0}]])
def test_documents_without_usable_legs_fall_back_to_the_document_record(legs) -> None:
    assert resolve_payment_legs(_of_tx(payments=legs)) == [(None, None)]
