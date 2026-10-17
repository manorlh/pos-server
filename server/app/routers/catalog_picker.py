"""
The catalog as the dashboard's product & category picker reads it — one lean answer for the
two-pane picker (client `components/dashboard/catalog/product-category-picker.tsx`) used by the
menus, the promotions and the production vouchers' screens. A chain with 2,000+ products is
one request of a few hundred KB instead of ten pages of full products.

GET /catalog-picker → {"categories": [...], "products": [...], "total": n, "truncated": bool}

* The organization's catalog (global level, never a till's local copy), with the visibility
  rule of `GET /products` and `GET /categories` — the same two, or a product shows under a
  category the user cannot see.
* Per product: its category, base price, SKU, `isActive` ("פעיל" as the product list says it:
  not switched off anywhere), `inStock` and its tags (`dietary_tags`).
* Read only. At most `PICKER_MAX` products (by name); `truncated` says when there were more.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.category import Category
from app.models.product import CatalogLevel, Product
from app.models.user import User
from app.services import product_list_filters as list_filters
from app.services.company_hierarchy import catalog_visibility_filter

router = APIRouter(tags=["catalog-picker"])

#: The most products one answer carries.
PICKER_MAX = 20000


def _tags(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(t) for t in value if isinstance(t, (str, int)) and str(t).strip()][:20]
    return []


def catalog_for_picker(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    categories_q = db.query(Category).filter(
        Category.tenant_id == tenant_id,
        Category.pos_machine_id.is_(None),
        Category.catalog_level == CatalogLevel.GLOBAL,
    )
    visible = catalog_visibility_filter(db, user, Category)
    if visible is not None:
        categories_q = categories_q.filter(visible)
    categories = categories_q.order_by(Category.sort_order, Category.name).all()

    base = [
        Product.tenant_id == tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
    ]
    visible = catalog_visibility_filter(db, user, Product)
    if visible is not None:
        base.append(visible)
    total = db.query(Product.id).filter(*base).count()
    columns = (
        Product.id, Product.name, Product.category_id, Product.price, Product.sku,
        Product.in_stock, Product.dietary_tags,
    )
    rows = db.query(*columns).filter(*base).order_by(Product.name).limit(PICKER_MAX).all()
    locked = {str(r[0]) for r in db.query(Product.id).filter(*base, list_filters.locked_anywhere()).all()}
    return {
        "categories": [
            {
                "id": str(c.id),
                "name": c.name,
                "parentId": str(c.parent_id) if c.parent_id else None,
                "isActive": bool(c.is_active),
                "sortOrder": c.sort_order or 0,
            }
            for c in categories
        ],
        "products": [
            {
                "id": str(pid),
                "name": name or "",
                "categoryId": str(category_id) if category_id else None,
                "price": float(price or 0),
                "sku": sku,
                "isActive": str(pid) not in locked,
                "inStock": bool(in_stock) if in_stock is not None else True,
                "tags": _tags(tags),
            }
            for pid, name, category_id, price, sku, in_stock, tags in rows
        ],
        "total": total,
        "truncated": total > len(rows),
    }


@router.get("/catalog-picker")
def get_catalog_picker(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return catalog_for_picker(db, current_user, active_tenant_id)
