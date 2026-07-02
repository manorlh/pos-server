"""Tips ingest serialization and dashboard report aggregation."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from app.models.company import Company
from app.models.pos_user import PosUser
from app.models.tenant import Tenant
from app.models.transaction import Transaction
from app.schemas.transaction import TransactionIn
from app.services.tips import build_tips_report
from app.services.transactions import _serialize_tx_for_upsert


def _now() -> datetime:
    return datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)


def _make_tx_in(**kwargs) -> TransactionIn:
    base = {
        "id": uuid.uuid4(),
        "transactionNumber": "TX-1",
        "status": "completed",
        "totalAmount": Decimal("100"),
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    base.update(kwargs)
    return TransactionIn.model_validate(base)


def test_serialize_tx_for_upsert_maps_tip_fields() -> None:
    machine = MagicMock()
    machine.tenant_id = uuid.uuid4()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()
    td_id = uuid.uuid4()

    tx = _make_tx_in(
        totalAmount=Decimal("88.50"),
        tipAmount=Decimal("10"),
        tipPaymentMethod="cash",
        amountTendered=Decimal("100"),
        changeAmount=Decimal("1.50"),
    )
    row = _serialize_tx_for_upsert(tx, machine, td_id)

    assert row["total_amount"] == Decimal("88.50")
    assert row["tip_amount"] == Decimal("10")
    assert row["tip_payment_method"] == "cash"
    assert row["amount_tendered"] == Decimal("100")


def _mock_db_for_tips(transactions: list, distribution: str = "direct"):
    shop = MagicMock()
    shop.id = uuid.uuid4()
    shop.company_id = uuid.uuid4()
    shop.tenant_id = None

    company = MagicMock()

    def query_side_effect(model):
        q = MagicMock()
        if model is Transaction:
            q.filter.return_value = q
            q.all.return_value = transactions
        elif model is Company:
            q.filter.return_value.first.return_value = company
        elif model is Tenant:
            q.filter.return_value.first.return_value = None
        elif model is PosUser:
            q.filter.return_value.all.return_value = []
        return q

    db = MagicMock()
    db.query.side_effect = query_side_effect
    return db, shop, distribution


def _row(cashier_id: uuid.UUID, tip: str, sales: str, payment: str = "cash") -> MagicMock:
    tx = MagicMock()
    tx.cashier_id = str(cashier_id)
    tx.tip_amount = Decimal(tip)
    tx.total_amount = Decimal(sales)
    tx.tip_payment_method = payment
    tx.payment_method = payment
    return tx


@patch("app.services.tips.merge_all_settings_layers")
def test_build_tips_report_direct(mock_merge) -> None:
    mock_merge.return_value = {"tipDistribution": "direct"}
    c1, c2 = uuid.uuid4(), uuid.uuid4()
    db, shop, _ = _mock_db_for_tips(
        [
            _row(c1, "10", "100"),
            _row(c2, "5", "50"),
        ]
    )
    report = build_tips_report(db, shop, from_date=None, to_date=None)
    assert report.distribution == "direct"
    assert report.total_tips == Decimal("15")
    by_id = {str(r.cashier_id): r for r in report.cashiers}
    assert by_id[str(c1)].amount_owed == Decimal("10.00")
    assert by_id[str(c2)].amount_owed == Decimal("5.00")


@patch("app.services.tips.merge_all_settings_layers")
def test_build_tips_report_equal_pool(mock_merge) -> None:
    mock_merge.return_value = {"tipDistribution": "equal_pool"}
    c1, c2 = uuid.uuid4(), uuid.uuid4()
    db, shop, _ = _mock_db_for_tips(
        [
            _row(c1, "12", "100"),
            _row(c2, "8", "80"),
        ]
    )
    report = build_tips_report(db, shop)
    assert report.total_tips == Decimal("20")
    for row in report.cashiers:
        assert row.amount_owed == Decimal("10.00")


@patch("app.services.tips.merge_all_settings_layers")
def test_build_tips_report_by_sales(mock_merge) -> None:
    mock_merge.return_value = {"tipDistribution": "by_sales"}
    c1, c2 = uuid.uuid4(), uuid.uuid4()
    db, shop, _ = _mock_db_for_tips(
        [
            _row(c1, "10", "100"),
            _row(c2, "10", "50"),
        ]
    )
    report = build_tips_report(db, shop)
    assert report.total_tips == Decimal("20")
    by_id = {str(r.cashier_id): r for r in report.cashiers}
    # 20 * (100/150) ≈ 13.33, 20 * (50/150) ≈ 6.67
    assert by_id[str(c1)].amount_owed == Decimal("13.33")
    assert by_id[str(c2)].amount_owed == Decimal("6.67")
