import uuid
from unittest.mock import MagicMock

from app.routers.catalog import _copy_category_to_machine, _copy_product_to_machine


def test_copy_product_to_machine_sets_tenant_id() -> None:
    tenant_id = uuid.uuid4()
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()
    machine.tenant_id = tenant_id

    global_product = MagicMock()
    global_product.merchant_id = uuid.uuid4()
    global_product.company_id = None
    global_product.category_id = uuid.uuid4()
    global_product.id = uuid.uuid4()
    global_product.tenant_id = tenant_id
    global_product.name = "Test"
    global_product.description = None
    global_product.price = 10
    global_product.sku = "SKU1"
    global_product.image_url = None
    global_product.in_stock = True
    global_product.stock_quantity = 5
    global_product.barcode = None
    global_product.tax_rate = None

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    local = _copy_product_to_machine(global_product, machine, db)

    assert local.tenant_id == tenant_id
    db.add.assert_called_once_with(local)


def test_copy_category_to_machine_sets_tenant_id() -> None:
    tenant_id = uuid.uuid4()
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()
    machine.tenant_id = tenant_id

    global_cat = MagicMock()
    global_cat.merchant_id = uuid.uuid4()
    global_cat.company_id = None
    global_cat.tenant_id = tenant_id
    global_cat.name = "Drinks"
    global_cat.description = None
    global_cat.color = "#fff"
    global_cat.image_url = None
    global_cat.is_active = True
    global_cat.sort_order = 0

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    local = _copy_category_to_machine(global_cat, machine, db)

    assert local.tenant_id == tenant_id
    db.add.assert_called_once_with(local)
