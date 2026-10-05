"""
Item tickets ("שוברים"): the per-category / per-product print mode reaching the till.

The till prints from the product's `ticketMode` as it is sent, so the resolution
(product's own value, else its category's, else off) has to happen here, on both
product serialisers, and a category change has to reach products through delta sync.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from app.database import Base
from app.models.category import Category
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate
from app.schemas.product import ProductCreate, ProductUpdate
from app.services import item_ticket as T
from app.services import sync as S

from test_product_availability import OLD, SINCE, world  # noqa: F401


# ── Resolution ───────────────────────────────────────────────────────────────


def _p(own=None, cat=None, has_category=True):
    category = SimpleNamespace(ticket_mode=cat) if has_category else None
    return SimpleNamespace(ticket_mode=own, category=category)


@pytest.mark.parametrize(
    "own, cat, expected",
    [
        (None, None, "off"),
        (None, "per_unit", "per_unit"),
        (None, "per_sale", "per_sale"),
        ("per_line", None, "per_line"),
        ("per_line", "per_unit", "per_line"),  # product wins
        ("off", "per_unit", "off"),  # an explicit off on the product wins too
        ("inherit", "per_line", "per_line"),  # never stored, but harmless if it is
        ("garbage", "per_sale", "per_sale"),
        (" PER_UNIT ", None, "per_unit"),
    ],
)
def test_effective_mode(own, cat, expected):
    assert T.effective_mode(_p(own, cat)) == expected


def test_effective_mode_without_category_is_off():
    assert T.effective_mode(_p(None, None, has_category=False)) == "off"
    assert T.category_mode(None) == "off"


def test_normalize_maps_inherit_to_null():
    assert T.normalize("inherit") is None
    assert T.normalize(None) is None
    assert T.normalize("per_sale") == "per_sale"


# ── Schemas ──────────────────────────────────────────────────────────────────


def test_product_schema_accepts_modes_and_inherit():
    base = {"name": "נקניקיה", "price": "12", "sku": "H-1", "categoryId": str(uuid.uuid4())}
    assert ProductCreate.model_validate(base).ticket_mode is None
    assert ProductCreate.model_validate({**base, "ticketMode": "per_unit"}).ticket_mode == "per_unit"
    assert ProductUpdate.model_validate({"ticketMode": "inherit"}).ticket_mode == "inherit"
    with pytest.raises(ValidationError):
        ProductCreate.model_validate({**base, "ticketMode": "per_banana"})


def test_category_schema_accepts_modes_but_not_inherit():
    assert CategoryCreate.model_validate({"name": "Grill", "ticketMode": "per_line"}).ticket_mode == "per_line"
    assert CategoryUpdate.model_validate({"ticketMode": "off"}).ticket_mode == "off"
    with pytest.raises(ValidationError):
        CategoryUpdate.model_validate({"ticketMode": "inherit"})


# ── Serialisers (no DB) ──────────────────────────────────────────────────────


def test_serializers_ship_the_resolved_mode():
    p = MagicMock()
    p.price = 1
    p.tax_rate = None
    p.voucher_id = None
    p.ticket_mode = None
    p.category = SimpleNamespace(ticket_mode="per_unit", voucher_id=None)
    assert S._serialize_product(p)["ticketMode"] == "per_unit"

    row = S._serialize_merged_product(p, None, None, uuid.uuid4(), None)
    assert row["ticketMode"] == "per_unit"

    p.ticket_mode = "off"
    assert S._serialize_merged_product(p, None, None, uuid.uuid4(), None)["ticketMode"] == "off"


# ── The real sync path (SQLite world) ────────────────────────────────────────


@pytest.fixture
def w(world):  # noqa: F811
    for name in ("shop_category_overrides",):
        Base.metadata.tables[name].create(world.db.get_bind())
    return world


def _row(w, product, since=None):
    rows = S.get_products_for_sync(w.db, str(w.tid), str(w.h1.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


def test_catalog_payload_resolves_product_over_category(w):
    category = w.db.get(Category, w.P.category_id)
    category.ticket_mode = "per_sale"
    w.Q.ticket_mode = "per_unit"
    w.db.commit()

    assert _row(w, w.P)["ticketMode"] == "per_sale"  # inherits
    assert _row(w, w.Q)["ticketMode"] == "per_unit"  # its own

    cats = S.get_categories_for_sync(w.db, str(w.tid), str(w.h1.id))
    mine = [c for c in cats if c["id"] == str(category.id)]
    assert mine and mine[0]["ticketMode"] == "per_sale"


def test_unset_everywhere_is_off(w):
    assert _row(w, w.P)["ticketMode"] == "off"
    cats = S.get_categories_for_sync(w.db, str(w.tid), str(w.h1.id))
    assert all(c["ticketMode"] == "off" for c in cats)


def test_category_change_reaches_products_by_delta(w):
    """The till pulls deltas; a category edit must re-send the products that inherit it."""
    from app.routers import categories as R

    assert _row(w, w.P, since=SINCE) is None  # nothing changed since

    R.update_category(
        str(w.P.category_id),
        CategoryUpdate.model_validate({"ticketMode": "per_line"}),
        current_user=w.users.admin,
        active_tenant_id=w.tid,
        db=w.db,
    )
    row = _row(w, w.P, since=SINCE)
    assert row is not None and row["ticketMode"] == "per_line"


def test_category_response_carries_the_mode():
    c = SimpleNamespace(
        id=uuid.uuid4(), tenant_id=None, company_id=None, shop_id=None, catalog_level="global",
        name="Grill", description=None, color=None, image_url=None, parent_id=None,
        voucher_id=None, ticket_mode="per_unit", is_active=True, sort_order=0,
        created_at=OLD, updated_at=OLD, children=None,
    )
    dumped = CategoryResponse.model_validate(c).model_dump(by_alias=True)
    assert dumped["ticketMode"] == "per_unit"
