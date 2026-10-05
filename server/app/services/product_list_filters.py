"""The products page's search and filters, as SQL over `products`.

`GET /products` stays one query: every filter here returns a condition on `Product`
(correlated sub-selects where it needs another table), never a list of ids fetched
first. Three things live here:

* **Search** — Hebrew-normalized the way the dashboard's sidebar search is
  (`normalizeNavText` in `client/src/lib/navigation.ts`): niqqud and cantillation are
  dropped, and so are quote marks, so `מק"ט`, `מק״ט` and `מקט` are the same word. Every
  word of the query must match one of name / SKU / global SKU / barcode.
* **Categories** — any of a list, and/or "uncategorized": a row whose category is gone
  or belongs to another tenant (the column itself is NOT NULL).
* **"Available at"** — whether the product is effectively available at one company,
  shop, point of sale (area) or till. The rule is `app/services/product_availability.py`
  (nearest set level wins, the only company consulted is the shop's own); this is the
  same `coalesce` from the till upwards, written as SQL so it can filter a page.
"""
from __future__ import annotations

import re
import unicodedata
from typing import List, Optional, Sequence

from sqlalchemy import and_, exists, false, func, literal, not_, or_, select, true
from sqlalchemy.sql.elements import ColumnElement

from app.models.category import Category
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.product import Product
from app.models.product_availability_override import (
    AreaProductOverride,
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.services import machine_catalog

# Hebrew points and cantillation (U+0591–U+05C7), as in the client helper.
_NIQQUD = re.compile("[֑-ׇ]")
# Quote marks people type inside Hebrew abbreviations: " ' ` ׳ ״ and the curly ones.
_QUOTES = "\"'`׳״‘’“”"
_QUOTES_RE = re.compile("[" + re.escape(_QUOTES) + "]")
_SPACES = re.compile(r"\s+")

#: Statuses the list filters by.
STATUS_ACTIVE = "active"
STATUS_INACTIVE = "inactive"
STATUSES = (STATUS_ACTIVE, STATUS_INACTIVE)

#: Levels "available at" accepts, nearest last.
SCOPE_LEVELS = ("company", "shop", "area", "machine")


def normalize_search(text: Optional[str]) -> str:
    """The query as it is matched: no niqqud, no quote marks, single spaces, lower case."""
    if not text:
        return ""
    out = unicodedata.normalize("NFKD", text)
    out = _NIQQUD.sub("", out)
    out = _QUOTES_RE.sub("", out)
    # NFKD splits accented Latin letters; dropping the marks keeps "café" ~ "cafe".
    out = "".join(ch for ch in out if not unicodedata.combining(ch))
    return _SPACES.sub(" ", out).strip().lower()


def search_terms(text: Optional[str]) -> List[str]:
    """The query's words. Empty for a blank query."""
    normalized = normalize_search(text)
    return normalized.split(" ") if normalized else []


def _without_quotes(column) -> ColumnElement:
    """`lower(column)` with every quote mark stripped, on Postgres and SQLite alike."""
    expr = func.lower(func.coalesce(column, ""))
    for ch in _QUOTES:
        expr = func.replace(expr, ch, "")
    return expr


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_condition(text: Optional[str]) -> Optional[ColumnElement]:
    """Every word in name, SKU, global SKU or barcode. None for a blank query."""
    terms = search_terms(text)
    if not terms:
        return None
    columns = (Product.name, Product.sku, Product.global_sku, Product.barcode)
    per_word = []
    for term in terms:
        pattern = f"%{_escape_like(term)}%"
        per_word.append(
            or_(*(_without_quotes(c).like(pattern, escape="\\") for c in columns))
        )
    return and_(*per_word)


def category_condition(
    category_ids: Sequence[str], uncategorized: bool, tenant_id
) -> Optional[ColumnElement]:
    """In any of `category_ids`, or (with `uncategorized`) in no live category of the tenant."""
    parts = []
    if category_ids:
        parts.append(Product.category_id.in_(list(category_ids)))
    if uncategorized:
        parts.append(
            or_(
                Product.category_id.is_(None),
                not_(
                    exists().where(
                        Category.id == Product.category_id,
                        Category.tenant_id == tenant_id,
                    )
                ),
            )
        )
    if not parts:
        return None
    return or_(*parts)


# ── Availability ─────────────────────────────────────────────────────────────
#
# Every level's value is read *inside* an EXISTS over the shop's assortment row, so the
# lookups key on that row's product column: a sub-select two levels down does not
# correlate to the outer `products` and would quietly read any product's row.

_ROW_PRODUCT = ShopProductOverride.global_product_id



def _company_value(company_id_expr):
    return (
        select(CompanyProductOverride.is_available)
        .where(
            CompanyProductOverride.company_id == company_id_expr,
            CompanyProductOverride.product_id == _ROW_PRODUCT,
        )
        .limit(1)
        .scalar_subquery()
    )


def _area_value(area_id):
    return (
        select(AreaProductOverride.is_available)
        .where(
            AreaProductOverride.area_id == area_id,
            AreaProductOverride.product_id == _ROW_PRODUCT,
        )
        .limit(1)
        .scalar_subquery()
    )


def _machine_value(machine_id):
    return (
        select(MachineProductOverride.is_available)
        .where(
            MachineProductOverride.machine_id == machine_id,
            MachineProductOverride.product_id == _ROW_PRODUCT,
        )
        .limit(1)
        .scalar_subquery()
    )


def _is_true(expr) -> ColumnElement:
    return expr == true()


def _in_shop(shop_id, *conditions) -> ColumnElement:
    """The shop's assortment row for this product exists (and meets `conditions`)."""
    return exists().where(
        ShopProductOverride.shop_id == shop_id,
        ShopProductOverride.global_product_id == Product.id,
        *conditions,
    )


def _active_in_shop(shop, *nearer) -> ColumnElement:
    """
    Listed in `shop`, and the nearest set value — `nearer` (till, then area), the shop's
    own row, the shop's company, the product — is available.
    """
    effective = func.coalesce(
        *nearer,
        ShopProductOverride.is_available,
        _company_value(literal(shop.company_id)),
        Product.is_available,
    )
    return _in_shop(shop.id, ShopProductOverride.is_listed == true(), _is_true(effective))


def scope_conditions(level: str, target, *, shop=None, machine=None):
    """
    `(sold_there, active_there)` for one target. `target` is the company, shop, area or
    till row; `shop` is the shop an area or till belongs to (required for those).

    *Sold there* is the assortment row (for a company: in any of its **own** shops).
    *Active there* is listed and effectively available — for a till also on the till's
    own catalog when it shows "selected products only".
    """
    if level == "company":
        own_shop = select(Shop.id).where(
            Shop.company_id == target.id, Shop.tenant_id == target.tenant_id
        )
        sold = exists().where(
            ShopProductOverride.global_product_id == Product.id,
            ShopProductOverride.shop_id.in_(own_shop),
        )
        effective = func.coalesce(
            ShopProductOverride.is_available,
            _company_value(literal(target.id)),
            Product.is_available,
        )
        active = exists().where(
            ShopProductOverride.global_product_id == Product.id,
            ShopProductOverride.shop_id.in_(own_shop),
            ShopProductOverride.is_listed == true(),
            _is_true(effective),
        )
        return sold, active
    if level == "shop":
        return _in_shop(target.id), _active_in_shop(target)
    if level == "area":
        return _in_shop(shop.id), _active_in_shop(shop, _area_value(literal(target.id)))
    if level == "machine":
        nearer = [_machine_value(literal(target.id))]
        if target.area_id is not None:
            nearer.append(_area_value(literal(target.area_id)))
        active = _active_in_shop(shop, *nearer)
        if machine_catalog.mode_of(target) == machine_catalog.MODE_SELECTED:
            on_list = exists().where(
                MachineCatalogItem.machine_id == target.id,
                MachineCatalogItem.product_id == Product.id,
                MachineCatalogItem.is_included == true(),
            )
            active = and_(active, or_(Product.is_general == true(), on_list))
        return _in_shop(shop.id), active
    raise ValueError(f"unknown level {level!r}")


def locked_anywhere() -> ColumnElement:
    """The product's own flag is off, or any company, shop, area or till locks it."""
    return or_(
        Product.is_available == false(),
        exists().where(
            CompanyProductOverride.product_id == Product.id,
            CompanyProductOverride.is_available == false(),
        ),
        exists().where(
            ShopProductOverride.global_product_id == Product.id,
            ShopProductOverride.is_available == false(),
        ),
        exists().where(
            AreaProductOverride.product_id == Product.id,
            AreaProductOverride.is_available == false(),
        ),
        exists().where(
            MachineProductOverride.product_id == Product.id,
            MachineProductOverride.is_available == false(),
        ),
    )


def status_condition(status: Optional[str], scope=None) -> Optional[ColumnElement]:
    """
    Without a scope: "active" = not locked anywhere, "inactive" = locked somewhere.
    With one (`scope_conditions`' pair): active there, or sold there and not active.
    A scope with no status means "active there" — what "available at" asks.
    """
    if scope is not None:
        sold, active = scope
        if status == STATUS_INACTIVE:
            return and_(sold, not_(active))
        return active
    if status == STATUS_ACTIVE:
        return not_(locked_anywhere())
    if status == STATUS_INACTIVE:
        return locked_anywhere()
    return None
