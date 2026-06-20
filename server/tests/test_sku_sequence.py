import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.merchant_sku_sequence import DEFAULT_SKU_SEQUENCE_START
from app.services.sku_sequence import (
    compute_initial_next_value,
    resolve_sku_for_create,
)


def test_compute_initial_next_value_empty_merchant() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    assert compute_initial_next_value(db, uuid.uuid4()) == DEFAULT_SKU_SEQUENCE_START


def test_compute_initial_next_value_from_numeric_skus() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [("100005",), ("100010",)]
    assert compute_initial_next_value(db, uuid.uuid4()) == 100011


def test_resolve_sku_for_create_auto_allocates() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    with patch("app.services.sku_sequence.allocate_sku", return_value="100001") as mock_alloc:
        sku, auto = resolve_sku_for_create(db, uuid.uuid4(), None)

    assert sku == "100001"
    assert auto is True
    mock_alloc.assert_called_once()


def test_resolve_sku_for_create_manual() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    sku, auto = resolve_sku_for_create(db, uuid.uuid4(), "  MY-SKU  ")

    assert sku == "MY-SKU"
    assert auto is False


def test_resolve_sku_for_create_duplicate_raises() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = uuid.uuid4()

    with pytest.raises(HTTPException) as exc:
        resolve_sku_for_create(db, uuid.uuid4(), "DUPE")

    assert exc.value.status_code == 409


def test_resolve_sku_for_create_empty_string_is_auto() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    with patch("app.services.sku_sequence.allocate_sku", return_value="100002") as mock_alloc:
        sku, auto = resolve_sku_for_create(db, uuid.uuid4(), "   ")

    assert sku == "100002"
    assert auto is True
    mock_alloc.assert_called_once()
