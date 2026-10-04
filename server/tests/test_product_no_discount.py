"""
"לא מקבל הנחות" (`no_discount`): the flag is stored, edited, and reaches the till on both
catalog serialisers (a machine with a shop only ever takes the merged one). The till
enforces it — no line discount, no basket-discount share, no promotion.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from app.schemas.product import ProductCreate, ProductUpdate
from app.services.sync import _serialize_merged_product, _serialize_product
from test_product_weighed import _product


def test_both_serialisers_ship_the_flag() -> None:
    p = _product(is_weighed=False, unit_label=None)
    p.no_discount = True
    assert _serialize_product(p)["noDiscount"] is True
    merged = _serialize_merged_product(p, None, None, uuid.uuid4(), None)
    assert merged is not None and merged["noDiscount"] is True


def test_it_is_taken_from_the_global_row() -> None:
    global_p = _product(is_weighed=False, unit_label=None)
    global_p.no_discount = False
    local = _product(is_weighed=False, unit_label=None)
    local.no_discount = True
    row = _serialize_merged_product(global_p, local, None, uuid.uuid4(), None)
    assert row["noDiscount"] is False


def test_schemas_default_off_and_take_the_alias() -> None:
    base = {"name": "Cola", "price": "6.00", "sku": "C-1", "categoryId": str(uuid.uuid4())}
    assert ProductCreate.model_validate(base).no_discount is False
    assert ProductCreate.model_validate({**base, "noDiscount": True}).no_discount is True
    assert "no_discount" not in ProductUpdate.model_validate({"price": "7"}).model_dump(exclude_unset=True)
    assert ProductUpdate.model_validate({"noDiscount": True}).no_discount is True


def test_the_router_stores_it(monkeypatch) -> None:
    from shift_world import accept_str_uuids, make_world

    from app.models.category import Category
    from app.models.product import Product
    from app.routers import products as R

    accept_str_uuids(monkeypatch)
    w = make_world()
    monkeypatch.setattr(R, "_trigger_catalog_notify", lambda *a, **k: None)
    # The SKU counters use a Postgres-only regex; not what is under test here.
    monkeypatch.setattr(R, "allocate_global_sku", lambda *a, **k: "100001")
    monkeypatch.setattr(R, "resolve_sku_for_create", lambda db, tenant, sku: (sku, False))
    cat = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Drinks")
    w.db.add(cat)
    w.db.commit()
    created = R.create_product(
        ProductCreate.model_validate({
            "name": "Cola", "price": "6.00", "sku": "C-1", "categoryId": str(cat.id),
            "companyId": str(w.company.id), "noDiscount": True,
        }),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert created.no_discount is True
    R.update_product(
        str(created.id), ProductUpdate.model_validate({"noDiscount": False}),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert w.db.get(Product, created.id).no_discount is False
    assert Decimal(str(w.db.get(Product, created.id).price)) == Decimal("6.00")
