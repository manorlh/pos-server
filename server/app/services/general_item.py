"""The built-in general item ("פריט כללי"): the product the till's calculator sells.

The till's calculator tab adds a typed amount to the cart as a line of one product, so
that calculator lines and catalog lines share one cart, one checkout and one set of
documents. That product is not something a merchant sets up: **every company has
exactly one**, created with the company (and, for companies that predate it, by
migration e7f8a9b0c1d2), and it cannot be deleted.

What it is, and the guards below keep it that way:

* ``is_general = true`` — the one flag the till looks for (`isGeneral` in the sync
  payload). A partial unique index allows one per company.
* ``is_open_price = true``, base price 0 — the cashier's amount is the price.
* No ``tax_rate`` of its own, so the till applies the shop's standard VAT rate.
* Not weighed, no stock tracking, no voucher: a calculator line is an amount, nothing
  else, and any of those would change what the calculator's "+" does.
* Sold in **every active shop of its own company, including shops opened later**, and
  never in a sub-company's shops (each has its own). That is exactly the product shop
  scope's company rule with ``include_subcompanies = false``
  (app/services/product_shop_scope.py), so the existing shop hooks keep it on every
  new or reactivated shop and nothing here has to.

What stays the merchant's: its name, image, category, description, barcode, the
suggested price, per-shop prices, and availability locks at every level — a locked
general item is locked like any product.

`ensure_general_item` is the only place one is created. The routers call the `refuse_*`
/ `check_*` guards; each raises a 400 with a message saying what is fixed and why.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Mapping, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.product import CatalogLevel, Product
from app.services import product_shop_scope as scope_svc
from app.services.sku_sequence import allocate_sku

GENERAL_ITEM_NAME = "פריט כללי"
#: The category a new general item is filed under, when its company has none by that
#: name. The model has no "default category", and `products.category_id` is NOT NULL.
GENERAL_CATEGORY_NAME = "כללי"

#: Fields the general item must keep, with the only value each may hold. A request
#: that sends the same value (a dashboard echoing the whole product back) is not a
#: change and is allowed.
LOCKED_FIELDS: Mapping[str, Any] = {
    "is_general": True,
    "is_open_price": True,
    "tax_rate": None,
    "is_weighed": False,
    "track_stock": False,
    "voucher_id": None,
}

_LOCKED_REASON = {
    "is_general": "the general item is built in and stays the company's general item",
    "is_open_price": "the general item is always open price: the cashier types the amount",
    "tax_rate": "the general item has no VAT rate of its own; the shop's standard rate applies",
    "is_weighed": "the general item is sold by amount, never by weight",
    "track_stock": "the general item has no stock to track",
    "voucher_id": "the general item cannot issue a voucher",
}


def is_general(product) -> bool:
    """Strict: only a real `True`, so a half-built test double never reads as general."""
    return getattr(product, "is_general", False) is True


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


# ── Finding and creating it ──────────────────────────────────────────────────


def find_general_item(db: Session, company_id) -> Optional[Product]:
    if company_id is None:
        return None
    return (
        db.query(Product)
        .filter(Product.company_id == company_id, Product.is_general.is_(True))
        .first()
    )


def _general_category(db: Session, company) -> Category:
    """
    The company's own active top-level "כללי" category if it has one, else a new one.

    Reused by name so a company that already filed things under "כללי" does not get a
    second tab of that name on its tills. A new one goes last in the tenant's order
    rather than jumping to the front of every till's category row.
    """
    existing = (
        db.query(Category)
        .filter(
            Category.tenant_id == company.tenant_id,
            Category.company_id == company.id,
            Category.catalog_level == CategoryCatalogLevel.GLOBAL,
            Category.shop_id.is_(None),
            Category.pos_machine_id.is_(None),
            Category.parent_id.is_(None),
            Category.is_active.is_(True),
            Category.name == GENERAL_CATEGORY_NAME,
        )
        .order_by(Category.sort_order, Category.created_at, Category.id)
        .first()
    )
    if existing is not None:
        return existing
    last = (
        db.query(func.max(Category.sort_order))
        .filter(
            Category.tenant_id == company.tenant_id,
            Category.catalog_level == CategoryCatalogLevel.GLOBAL,
            Category.pos_machine_id.is_(None),
        )
        .scalar()
    )
    category = Category(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        catalog_level=CategoryCatalogLevel.GLOBAL,
        name=GENERAL_CATEGORY_NAME,
        is_active=True,
        sort_order=(last or 0) + 1,
    )
    db.add(category)
    db.flush()
    return category


@dataclass
class Ensured:
    product: Optional[Product]
    created: bool = False
    #: Shops that gained a row for it — whose tills should re-pull.
    shop_ids: Set[str] = field(default_factory=set)


def ensure_general_item(db: Session, company) -> Ensured:
    """
    The company's general item, created (with its category and shop rows) if missing.

    The only place a general item is made. Idempotent: an existing one is returned
    untouched. Flushes, never commits — the caller owns the transaction. A company with
    no tenant gets none (a SKU is unique per tenant, so there is nothing to allocate
    it in); the caller learns that from `product is None`.

    Two callers racing for the same company meet the partial unique index
    `uq_products_general_per_company`: the loser's flush raises IntegrityError, and it
    is the caller's to roll back.
    """
    if company is None or company.tenant_id is None:
        return Ensured(product=None)
    existing = find_general_item(db, company.id)
    if existing is not None:
        return Ensured(product=existing)

    category = _general_category(db, company)
    product = Product(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        shop_id=None,
        pos_machine_id=None,
        category_id=category.id,
        global_product_id=None,
        catalog_level=CatalogLevel.GLOBAL,
        is_local_override=False,
        name=GENERAL_ITEM_NAME,
        description=None,
        price=Decimal("0"),
        sku=allocate_sku(db, company.tenant_id),
        # No tenant-wide global SKU: that exists for searching one product across
        # merchants, and every company's general item is its own.
        global_sku=None,
        sku_auto_assigned=True,
        in_stock=True,
        is_available=True,
        stock_quantity=0,
        tax_rate=None,
        voucher_id=None,
        track_stock=False,
        is_open_price=True,
        is_weighed=False,
        unit_label=None,
        is_general=True,
    )
    scope_svc.set_scope_fields(product, scope_svc.MODE_COMPANY, company.id, False)
    db.add(product)
    db.flush()
    shop_ids = scope_svc.apply_rule(db, product)
    db.flush()
    return Ensured(product=product, created=True, shop_ids=shop_ids)


# ── Guards ───────────────────────────────────────────────────────────────────


def _same(value, required) -> bool:
    # Every locked value is either None or a bool (see LOCKED_FIELDS).
    if required is None:
        return value is None
    return isinstance(value, bool) and value is required


def check_general_item_update(product, updates: Mapping[str, Any]) -> None:
    """
    400 if `updates` (column name -> value) would change what the general item is.

    Also refuses turning any *other* product into a general item: a company's general
    item is the one created for it, never one a merchant picks.
    """
    # `null` is "not sent", as for every other optional field of the update.
    if updates.get("is_general") is not None and bool(updates["is_general"]) != is_general(product):
        raise _bad_request(
            "isGeneral cannot be changed: every company has exactly one built-in general "
            "item, and no other product can become it"
        )
    if not is_general(product):
        return
    for name, required in LOCKED_FIELDS.items():
        if name in updates and not _same(updates[name], required):
            raise _bad_request(f"Cannot change this on the general item: {_LOCKED_REASON[name]}")


def check_general_item_create(data) -> None:
    """A general item is never created by request — only by `ensure_general_item`."""
    if getattr(data, "is_general", None) is True:
        raise _bad_request(
            "A general item cannot be created: every company already has one built in"
        )


def check_general_item_scope(product, scope) -> None:
    """The general item's scope is its own company's rule, without sub-companies."""
    if not is_general(product) or scope is None:
        return
    if (
        scope.mode == scope_svc.MODE_COMPANY
        and scope.company_id is not None
        and str(scope.company_id) == str(product.company_id)
        and not scope.include_subcompanies
    ):
        return
    raise _bad_request(
        "The general item is sold in every shop of its own company, including shops "
        "opened later; where it is sold cannot be changed"
    )


def refuse_general_item_delete(product) -> None:
    if is_general(product):
        raise _bad_request(
            "The general item cannot be deleted: the till's calculator sells through it. "
            "To hide the calculator, switch it off in the sell-screen settings"
        )


def refuse_general_item_unlist(product) -> None:
    """Taking it off one shop's till, by unlisting or unassigning the shop's row."""
    if is_general(product):
        raise _bad_request(
            "The general item stays in every shop of its company. To stop a shop selling "
            "it, lock it there, or switch the calculator off in the sell-screen settings"
        )


def refuse_general_item_in_foreign_shop(product, shop) -> None:
    """Only its own company's shops: a sub-company's shops have their own general item."""
    if is_general(product) and str(product.company_id) != str(shop.company_id):
        raise _bad_request(
            "A company's general item is sold only in that company's own shops; this "
            "shop's company has its own general item"
        )


# ── Going with its company ───────────────────────────────────────────────────


def remove_general_item_with_company(db: Session, company) -> None:
    """
    Delete a company's general item because the company itself is being deleted.

    The one way a general item is ever deleted. Left behind, deleting the company would
    null its `company_id` and turn it into an undeletable tenant-wide product. Its
    category goes too when it is the "כללי" one and nothing else is filed there.

    Refused (422) if it was ever sold: a document line points at it, and fiscal
    history is never what a delete takes with it. (A company with sales has shops,
    which already block deleting it, so this is a second fence, not the first.)
    """
    from app.models.transaction_item import TransactionItem

    product = find_general_item(db, getattr(company, "id", None))
    if product is None:
        return
    if db.query(TransactionItem).filter(TransactionItem.product_id == product.id).count():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The company's general item has been sold; the company cannot be deleted",
        )
    category = db.query(Category).filter(Category.id == product.category_id).first()
    db.delete(product)
    db.flush()
    if (
        category is not None
        and category.name == GENERAL_CATEGORY_NAME
        and str(category.company_id) == str(company.id)
        and not db.query(Product).filter(Product.category_id == category.id).count()
        and not db.query(Category).filter(Category.parent_id == category.id).count()
    ):
        db.delete(category)
        db.flush()
