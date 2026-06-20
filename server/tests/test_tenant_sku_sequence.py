import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.product import CatalogLevel
from app.models.tenant_sku_sequence import DEFAULT_GLOBAL_SKU_SEQUENCE_START
from app.services.tenant_sku_sequence import (
    allocate_global_sku,
    compute_initial_global_next_value,
)


def test_compute_initial_global_next_value_empty_tenant() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    assert compute_initial_global_next_value(db, uuid.uuid4()) == DEFAULT_GLOBAL_SKU_SEQUENCE_START


def test_compute_initial_global_next_value_from_existing() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [("100010",), ("100005",)]
    assert compute_initial_global_next_value(db, uuid.uuid4()) == 100011


def test_allocate_global_sku() -> None:
    db = MagicMock()
    row = MagicMock()
    row.next_value = 100001
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = row
    db.query.return_value.filter.return_value.first.return_value = None

    sku = allocate_global_sku(db, uuid.uuid4())

    assert sku == "100001"
    assert row.next_value == 100002


def test_allocate_global_sku_collision_retries() -> None:
    db = MagicMock()
    row = MagicMock()
    row.next_value = 100001
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = row
    # First candidate taken, second free
    db.query.return_value.filter.return_value.first.side_effect = [uuid.uuid4(), None]

    sku = allocate_global_sku(db, uuid.uuid4())

    assert sku == "100002"
    assert row.next_value == 100003
