"""
Weighed products: the flag has to reach the till, on both sync paths.

There are two product serialisers — one for machine-local / tenant-level rows and one
for a shop's merged assortment — and a machine with a `shop_id` only ever sees the
second. A flag added to one of them is a flag half the fleet never receives, which is
the same trap `is_open_price` had to be threaded through.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.services.sync import _serialize_merged_product, _serialize_product


def _ts() -> datetime:
    return datetime(2026, 8, 28, 9, 0, tzinfo=timezone.utc)


def _product(**kw) -> MagicMock:
    p = MagicMock()
    p.id = uuid.uuid4()
    p.global_product_id = None
    p.catalog_level = "global"
    p.is_local_override = False
    p.company_id = None
    p.shop_id = None
    p.pos_machine_id = None
    p.category_id = uuid.uuid4()
    p.name = "עגבניות שרי"
    p.description = None
    p.price = Decimal("14.90")
    p.sku = "SKU-1"
    p.global_sku = None
    p.image_url = None
    p.in_stock = True
    p.is_available = True
    p.stock_quantity = 0
    p.barcode = None
    p.tax_rate = None
    p.voucher_id = None
    p.category = None
    p.track_stock = False
    p.is_open_price = kw.get("is_open_price", False)
    p.is_weighed = kw.get("is_weighed", True)
    p.unit_label = kw.get("unit_label", 'ק"ג')
    p.created_at = _ts()
    p.updated_at = _ts()
    return p


def test_local_serializer_ships_the_weighed_flag() -> None:
    row = _serialize_product(_product())
    assert row["isWeighed"] is True
    assert row["unitLabel"] == 'ק"ג'


def test_merged_serializer_ships_the_weighed_flag() -> None:
    # The path a machine with a shop_id actually takes.
    global_p = _product()
    row = _serialize_merged_product(global_p, None, None, uuid.uuid4(), None)
    assert row is not None
    assert row["isWeighed"] is True
    assert row["unitLabel"] == 'ק"ג'


def test_merged_serializer_takes_the_flag_from_the_global_row() -> None:
    # A shop override carries price and availability, never what the thing *is* or how
    # it is measured. A shop selling the same SKU by the piece is a different product.
    global_p = _product(is_weighed=True, unit_label='ק"ג')
    local = _product(is_weighed=False, unit_label=None)
    override = MagicMock()
    override.price = Decimal("12.00")
    override.is_listed = True
    override.is_available = True
    override.updated_at = _ts()

    row = _serialize_merged_product(global_p, local, override, uuid.uuid4(), None)
    assert row["isWeighed"] is True
    assert row["unitLabel"] == 'ק"ג'


def test_unweighed_products_serialize_as_false_not_null() -> None:
    row = _serialize_product(_product(is_weighed=False, unit_label=None))
    assert row["isWeighed"] is False
    assert row["unitLabel"] is None


# ── Schemas ──────────────────────────────────────────────────────────────────

def test_create_defaults_to_not_weighed() -> None:
    data = ProductCreate.model_validate(
        {"name": "Cola", "price": "6.00", "sku": "C-1", "categoryId": str(uuid.uuid4())}
    )
    assert data.is_weighed is False
    assert data.unit_label is None


def test_create_accepts_the_camel_case_aliases() -> None:
    data = ProductCreate.model_validate(
        {
            "name": "עגבניות",
            "price": "14.90",
            "sku": "T-1",
            "categoryId": str(uuid.uuid4()),
            "isWeighed": True,
            "unitLabel": 'ק"ג',
        }
    )
    assert data.is_weighed is True
    assert data.unit_label == 'ק"ג'


def test_update_leaves_the_flags_alone_when_omitted() -> None:
    data = ProductUpdate.model_validate({"price": "15.90"})
    assert "is_weighed" not in data.model_dump(exclude_unset=True)
    assert "unit_label" not in data.model_dump(exclude_unset=True)


def test_response_exposes_both_fields_by_alias() -> None:
    payload = ProductResponse.model_validate(
        {
            "id": uuid.uuid4(),
            "catalogLevel": "global",
            "isLocalOverride": False,
            "name": "עגבניות שרי",
            "description": None,
            "price": Decimal("14.90"),
            "sku": "SKU-1",
            "categoryId": uuid.uuid4(),
            "inStock": True,
            "isAvailable": True,
            "stockQuantity": 0,
            "barcode": None,
            "isWeighed": True,
            "unitLabel": 'ק"ג',
            "createdAt": _ts(),
            "updatedAt": _ts(),
        }
    ).model_dump(by_alias=True)
    assert payload["isWeighed"] is True
    assert payload["unitLabel"] == 'ק"ג'


def test_weighed_and_open_price_are_allowed_together() -> None:
    # A deliberate decision, not an oversight: they describe different halves of a cart
    # line. isWeighed governs the quantity the cashier enters, isOpenPrice governs the
    # amount. Loose goods weighed on a scale the till cannot read — the cashier types
    # the money the scale printed — is exactly both at once, and that is a deli
    # counter, not a corner case.
    data = ProductCreate.model_validate(
        {
            "name": "גבינות במשקל",
            "price": "0",
            "sku": "D-1",
            "categoryId": str(uuid.uuid4()),
            "isWeighed": True,
            "isOpenPrice": True,
            "unitLabel": 'ק"ג',
        }
    )
    assert data.is_weighed and data.is_open_price

    row = _serialize_product(_product(is_weighed=True, is_open_price=True))
    assert row["isWeighed"] is True
    assert row["isOpenPrice"] is True


@pytest.mark.parametrize("label", ['ק"ג', "ליטר", "יח'", "מטר"])
def test_unit_label_is_free_text_not_an_enum(label) -> None:
    # The merchant's own label is what appears on the shelf and the receipt, and a
    # closed list would need a migration for the first shop that sells by the מטר.
    data = ProductUpdate.model_validate({"unitLabel": label})
    assert data.unit_label == label


def test_unit_label_is_length_capped_to_the_column() -> None:
    with pytest.raises(Exception):
        ProductUpdate.model_validate({"unitLabel": "x" * 17})
