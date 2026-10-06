"""
Importing a company's menu from Excel / CSV ("ייבוא פריטים מאקסל"), and exporting it to
the same sheet so it round-trips.

The flow, as the dashboard drives it:

1. **Template** - `template_view` reads the company's categories (with their printer
   routing) and its printers, and app/services/catalog_template.py draws the workbook. With
   `with_data` the products are written too: edit and re-import.
2. **Preview** - `read_file` (app/services/catalog_sheet.py) turns the upload into raw rows;
   `build_plan` matches them against the catalog and says, row by row, what would happen:
   create, update (with each change), unchanged, or an error - plus warnings. Nothing is
   written. A preview token binds the file and the plan to the user who saw it.
3. **Commit** - the plan is built again from the same file (the catalog may have moved
   since) and, when a preview token is presented, must be the plan that was previewed;
   `apply_plan` writes it in the caller's one transaction.

The rules, in one place:

* **The company's catalog** is what its shops may sell: products and categories of the
  company or of a company above it, and tenant-wide ones (no company). In a tenant with
  several companies a tenant-wide product counts only if it is sold (or ruled to be sold)
  in this company's shops, or nowhere at all. The built-in general item and machine-local
  copies are never part of it.
* **Matching** an existing product: by barcode, then by SKU, then by exact name within
  the same category. A category: by name (a name used twice is told apart by its parent;
  a product cell then writes "אב > בן").
* **An empty cell keeps** the current value of an existing row; a new row gets the
  default. Nothing absent from the file is deleted. Importing the same file twice changes
  nothing the second time.
* **New products** belong to the company and are sold in every active shop of it (the
  product shop scope's company rule, as the dashboard's product form defaults to).
* **Printers** are a shop's, and so is routing. A "מדפסות" cell names printers; in every
  shop of the company that has a printer by such a name the row is routed to it, and a
  shop with none of the names is left as it is. "ללא" is an explicit "no ticket",
  "ירושה" drops the row's own setting (inherit). Unknown names are a warning and skipped.
* **Permissions** are those of the single-row endpoints: placing new rows in the company
  (`_check_catalog_placement`), editing a product / category (`_check_product_access`,
  the categories router's `_check_access`), assortment rows in the company's shops
  (`_require_shop_writes`) and a shop's routing (`printers.can_edit`).
* **Cost** ("עלות") is the insights' `product_costs` row: per unit, excluding VAT.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException
from sqlalchemy import or_, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.category import CatalogLevel as CategoryLevel
from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenPrinterRoute
from app.models.product import CatalogLevel, Product
from app.models.product_cost import ProductCost
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User
from app.services import catalog_sheet as S
from app.services import dietary
from app.services import item_ticket
from app.services import printers as K
from app.services import product_shop_scope as scope_svc
from app.services.catalog_template import PrinterRef, TemplateView, ticket_label
from app.services.company_hierarchy import ancestor_company_ids, descendant_company_ids

PRODUCTS = "products"
CATEGORIES = "categories"

#: A routing cell that leaves a shop as it is.
_KEEP = object()
#: An explicit "no ticket" row (`printer_id` NULL) in a set of own printers.
_NO_TICKET = "none"

CONNECTION_LABELS = {
    "network": "רשת",
    "bluetooth": "בלוטות׳",
    "cloud": "ענן (דרך קופה)",
    "till": "מדפסת הקופה",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _chunks(items: Sequence[Any], size: int = 500) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


# ── Permissions (the single-row endpoints' rules, as yes / no) ────────────────


def _allowed(check: Callable, *args) -> bool:
    try:
        check(*args)
        return True
    except HTTPException:
        return False


def may_edit_product(db: Session, user: Optional[User], product: Product) -> bool:
    if user is None:
        return False
    from app.routers.products import _check_product_access

    return _allowed(_check_product_access, user, product, db)


def may_edit_category(db: Session, user: Optional[User], category: Category) -> bool:
    if user is None:
        return False
    from app.routers.categories import _check_access

    return _allowed(_check_access, user, category, db)


# ── The company's catalog ─────────────────────────────────────────────────────


@dataclass
class Context:
    db: Session
    user: Optional[User]
    tenant_id: uuid.UUID
    company: Company
    #: The company and the companies above it: whose catalog its shops inherit.
    up_ids: List[uuid.UUID]
    categories: List[Category]
    products: List[Product]
    #: product id → its cost (product_costs).
    costs: Dict[str, Decimal]
    #: The active shops of the company (and the companies under it) whose routing the
    #: caller may edit; `locked_shops` are the rest.
    shops: List[Shop]
    locked_shops: List[Shop]
    printers: List[KitchenPrinter]
    routes: List[KitchenPrinterRoute]
    #: Shops a new product is sold in (the company rule: its active shops).
    scope_shop_ids: List[uuid.UUID]
    areas: Dict[str, str] = field(default_factory=dict)
    machines: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.category_by_id: Dict[str, Category] = {str(c.id): c for c in self.categories}
        self.printers_by_shop: Dict[str, List[KitchenPrinter]] = {}
        for printer in self.printers:
            self.printers_by_shop.setdefault(str(printer.shop_id), []).append(printer)
        grouped: Dict[Tuple[str, str, str], Set[str]] = {}
        for route in self.routes:
            key = (route.target_type, str(route.target_id), str(route.shop_id))
            grouped.setdefault(key, set()).add(str(route.printer_id) if route.printer_id else _NO_TICKET)
        #: (target type, target id, shop id) → its own rows: printer ids, or {"none"}.
        self.own_routes: Dict[Tuple[str, str, str], FrozenSet[str]] = {k: frozenset(v) for k, v in grouped.items()}
        self.printer_by_id: Dict[str, KitchenPrinter] = {str(p.id): p for p in self.printers}
        self.labels = category_labels(self.categories)


def _company_shops(db: Session, tenant_id, company: Company) -> List[Shop]:
    subtree = descendant_company_ids(db, company.id)
    return (
        db.query(Shop)
        .filter(Shop.tenant_id == tenant_id, Shop.company_id.in_(subtree))
        .order_by(Shop.name)
        .all()
    )


def _company_products(db: Session, tenant_id, company: Company, up_ids: List[uuid.UUID],
                      shop_ids: Set[str], single_company: bool) -> List[Product]:
    rows = (
        db.query(Product)
        .filter(
            Product.tenant_id == tenant_id,
            Product.pos_machine_id.is_(None),
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.is_general.is_(False),
            or_(Product.company_id.in_(up_ids), Product.company_id.is_(None)),
        )
        .order_by(Product.name)
        .all()
    )
    if single_company:
        return rows
    # Several companies: a tenant-wide product is this company's if it is sold, or ruled
    # to be sold, in its shops - or is not sold anywhere yet.
    tenant_wide = [p.id for p in rows if p.company_id is None]
    placed: Dict[str, Set[str]] = {}
    for chunk in _chunks(tenant_wide):
        for product_id, shop_id in db.query(
            ShopProductOverride.global_product_id, ShopProductOverride.shop_id
        ).filter(ShopProductOverride.global_product_id.in_(list(chunk))):
            placed.setdefault(str(product_id), set()).add(str(shop_id))
    ups = {str(c) for c in up_ids}

    def ours(p: Product) -> bool:
        if p.company_id is not None:
            return True
        shops = placed.get(str(p.id), set())
        if shops & shop_ids:
            return True
        if p.shop_scope_mode == scope_svc.MODE_COMPANY and p.shop_scope_company_id is not None:
            ruled = str(p.shop_scope_company_id)
            return ruled == str(company.id) or (ruled in ups and bool(p.shop_scope_include_subcompanies))
        return not shops and not p.shop_scope_mode

    return [p for p in rows if ours(p)]


def _company_categories(db: Session, tenant_id, up_ids: List[uuid.UUID], shop_ids: Set[str],
                        products: List[Product]) -> List[Category]:
    rows = (
        db.query(Category)
        .filter(
            Category.tenant_id == tenant_id,
            Category.pos_machine_id.is_(None),
            Category.catalog_level == CategoryLevel.GLOBAL,
            or_(Category.company_id.in_(up_ids), Category.company_id.is_(None)),
        )
        .all()
    )
    out = [c for c in rows if c.shop_id is None or str(c.shop_id) in shop_ids]
    # A product of this catalog filed under some other category still needs its name,
    # and a category's parent its place in the tree.
    have = {str(c.id) for c in out}
    wanted = list({p.category_id for p in products if str(p.category_id) not in have})
    while wanted:
        found: List[Category] = []
        for chunk in _chunks(wanted):
            found.extend(db.query(Category).filter(Category.id.in_(list(chunk)), Category.tenant_id == tenant_id).all())
        out.extend(found)
        have |= {str(c.id) for c in found}
        wanted = list({c.parent_id for c in found if c.parent_id and str(c.parent_id) not in have})
    missing_parents = list({c.parent_id for c in out if c.parent_id and str(c.parent_id) not in have})
    while missing_parents:
        found = db.query(Category).filter(Category.id.in_(missing_parents), Category.tenant_id == tenant_id).all()
        out.extend(found)
        have |= {str(c.id) for c in found}
        missing_parents = list({c.parent_id for c in found if c.parent_id and str(c.parent_id) not in have})
    return _tree_order(out)


def _tree_order(categories: List[Category]) -> List[Category]:
    """Parents before children, siblings by sort order then name."""
    by_parent: Dict[Optional[str], List[Category]] = {}
    ids = {str(c.id) for c in categories}
    for c in categories:
        parent = str(c.parent_id) if c.parent_id and str(c.parent_id) in ids else None
        by_parent.setdefault(parent, []).append(c)
    for siblings in by_parent.values():
        siblings.sort(key=lambda c: (c.sort_order or 0, c.name or ""))
    out: List[Category] = []
    seen: Set[str] = set()

    def walk(parent: Optional[str], depth: int) -> None:
        for c in by_parent.get(parent, []):
            if str(c.id) in seen or depth > 50:
                continue
            seen.add(str(c.id))
            out.append(c)
            walk(str(c.id), depth + 1)

    walk(None, 0)
    # Anything left (a cycle in bad data) still goes out.
    out.extend(c for c in categories if str(c.id) not in seen)
    return out


def load_context(db: Session, tenant_id, company: Company, user: Optional[User] = None) -> Context:
    up_ids = [company.id] + ancestor_company_ids(db, company.id)
    all_shops = _company_shops(db, tenant_id, company)
    active = [s for s in all_shops if s.is_active]
    if user is None:
        shops, locked = active, []
    else:
        shops = [s for s in active if K.can_edit(db, user, s)]
        locked = [s for s in active if s not in shops]
    shop_ids = [s.id for s in shops]
    printers = (
        db.query(KitchenPrinter)
        .filter(KitchenPrinter.shop_id.in_(shop_ids))
        .order_by(KitchenPrinter.sort_order, KitchenPrinter.name)
        .all()
        if shop_ids
        else []
    )
    routes = (
        db.query(KitchenPrinterRoute).filter(KitchenPrinterRoute.shop_id.in_(shop_ids)).all() if shop_ids else []
    )
    companies = db.query(Company.id).filter(Company.tenant_id == tenant_id).count()
    all_shop_ids = {str(s.id) for s in all_shops}
    products = _company_products(db, tenant_id, company, up_ids, all_shop_ids, companies <= 1)
    categories = _company_categories(db, tenant_id, up_ids, all_shop_ids, products)
    costs: Dict[str, Decimal] = {}
    for chunk in _chunks([p.id for p in products]):
        for product_id, cost in db.query(ProductCost.product_id, ProductCost.cost).filter(
            ProductCost.tenant_id == tenant_id, ProductCost.product_id.in_(list(chunk))
        ):
            costs[str(product_id)] = Decimal(cost).quantize(S.CENT)
    probe = SimpleNamespace(id=None, tenant_id=tenant_id, company_id=company.id)
    scope_shops = scope_svc.shops_for_company_scope(db, probe, company.id, False, active_only=True)
    area_ids = list({p.area_id for p in printers if p.area_id})
    machine_ids = list({p.machine_id for p in printers if p.machine_id})
    areas = {str(a.id): a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(area_ids))} if area_ids else {}
    machines = (
        {str(m.id): K.machine_label(m) for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids))}
        if machine_ids
        else {}
    )
    return Context(
        db=db, user=user, tenant_id=tenant_id, company=company, up_ids=up_ids,
        categories=categories, products=products, costs=costs, shops=shops, locked_shops=locked,
        printers=printers, routes=routes, scope_shop_ids=[s.id for s in scope_shops],
        areas=areas, machines=machines,
    )


# ── Category names ────────────────────────────────────────────────────────────


def category_labels(categories: Sequence[Category]) -> Dict[str, str]:
    """id → how the sheet names it: the name, or "אב > בן" when the name is used twice."""
    by_id = {str(c.id): c for c in categories}
    counts: Dict[str, int] = {}
    for c in categories:
        key = S.normalize_name(c.name)
        counts[key] = counts.get(key, 0) + 1
    out: Dict[str, str] = {}
    for c in categories:
        if counts[S.normalize_name(c.name)] == 1:
            out[str(c.id)] = c.name
            continue
        parent = by_id.get(str(c.parent_id)) if c.parent_id else None
        out[str(c.id)] = f"{parent.name if parent else '—'}{S.PATH_SEPARATOR}{c.name}"
    return out


def _split_path(text_value: str) -> Tuple[Optional[str], str]:
    """"אב > בן" → (parent key, child key); a plain name → (None, its key)."""
    if ">" in text_value:
        parent, _, child = text_value.rpartition(">")
        parent_key = S.normalize_name(parent)
        return ("" if parent_key == "—" else parent_key), S.normalize_name(child)
    return None, S.normalize_name(text_value)


class CategoryIndex:
    """Finding an existing category by what a cell says."""

    def __init__(self, ctx: Context):
        self.company_id = str(ctx.company.id)
        self.by_id = ctx.category_by_id
        self.by_name: Dict[str, List[Category]] = {}
        for c in ctx.categories:
            self.by_name.setdefault(S.normalize_name(c.name), []).append(c)

    def parent_key(self, category: Category) -> str:
        parent = self.by_id.get(str(category.parent_id)) if category.parent_id else None
        return S.normalize_name(parent.name) if parent is not None else ""

    def preferred(self, hits: List[Category]) -> Category:
        def rank(c: Category):
            return (
                0 if str(c.company_id) == self.company_id else (1 if c.company_id is None else 2),
                0 if c.shop_id is None else 1,
                c.sort_order or 0,
                str(c.id),
            )

        return sorted(hits, key=rank)[0]

    def named(self, name_key: str, parent_key: Optional[str] = None) -> List[Category]:
        hits = list(self.by_name.get(name_key, []))
        if parent_key is not None:
            hits = [c for c in hits if self.parent_key(c) == parent_key]
        return hits

    def find(self, text_value: str) -> Tuple[Optional[Category], bool]:
        """(category, ambiguous). "אב > בן" narrows a name used twice."""
        parent_key, name_key = _split_path(text_value)
        if not name_key:
            return None, False
        hits = self.named(name_key, parent_key)
        if len(hits) == 1:
            return hits[0], False
        if len(hits) > 1:
            return self.preferred(hits), True
        return None, False


# ── The plan ──────────────────────────────────────────────────────────────────


@dataclass
class Issue:
    level: str  # "error" | "warning" | "info"
    #: As a list of messages shows it: "שורה 7: מחיר חסר".
    text: str
    sheet: Optional[str] = None
    row: Optional[int] = None
    #: The same without the row ("מחיר חסר"), for a view that shows the row by itself.
    message: str = ""

    def out(self) -> Dict[str, Any]:
        return {"level": self.level, "text": self.text, "message": self.message or self.text,
                "sheet": self.sheet, "row": self.row}


def _display(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return S.YES if value else S.NO
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    return value


@dataclass
class Change:
    field: str
    label: str
    before: Any
    after: Any

    def out(self) -> Dict[str, Any]:
        return {"field": self.field, "label": self.label, "before": _display(self.before), "after": _display(self.after)}


@dataclass
class CategoryPlan:
    ref: str
    name: str
    row: Optional[int]
    existing: Optional[Category] = None
    #: The parent to set (a ref; None = top level). `set_parent` False keeps the current one.
    parent_ref: Optional[str] = None
    set_parent: bool = False
    parent_text: str = ""
    sort: Optional[int] = None
    active: Optional[bool] = None
    routing: Optional[S.RoutingSpec] = None
    action: str = "create"
    changes: List[Change] = field(default_factory=list)
    issues: List[Issue] = field(default_factory=list)
    #: Created because a cell of this row (products or categories sheet) names it.
    implicit_from: Optional[int] = None

    @property
    def has_error(self) -> bool:
        return any(i.level == "error" for i in self.issues)


@dataclass
class ProductPlan:
    row: int
    name: str = ""
    category_ref: Optional[str] = None
    category_label: str = ""
    barcode: Optional[str] = None
    sku: Optional[str] = None
    price: Optional[Decimal] = None
    existing: Optional[Product] = None
    matched_by: Optional[str] = None
    #: A new product: every column's value. An update: the changed columns only.
    values: Dict[str, Any] = field(default_factory=dict)
    #: The cost to set (None = keep).
    cost: Optional[Decimal] = None
    routing: Optional[S.RoutingSpec] = None
    action: str = "create"
    changes: List[Change] = field(default_factory=list)
    issues: List[Issue] = field(default_factory=list)

    @property
    def ref(self) -> str:
        return f"id:{self.existing.id}" if self.existing is not None else f"row:{self.row}"

    @property
    def has_error(self) -> bool:
        return any(i.level == "error" for i in self.issues)


@dataclass
class RouteChange:
    target_type: str  # "category" | "product"
    target_ref: str
    shop_id: uuid.UUID
    before: Optional[FrozenSet[str]]
    #: None: drop the own rows (inherit).
    after: Optional[FrozenSet[str]]


@dataclass
class Plan:
    ctx: Context
    categories: List[CategoryPlan]
    products: List[ProductPlan]
    routes: List[RouteChange]
    issues: List[Issue]
    examples_skipped: int
    file_kind: str
    fingerprint: str = ""

    @property
    def fatal(self) -> bool:
        return any(i.level == "error" for i in self.issues)

    def error_rows(self) -> int:
        return sum(1 for x in [*self.categories, *self.products] if x.has_error)

    def warning_count(self) -> int:
        rows = sum(sum(1 for i in x.issues if i.level == "warning") for x in [*self.categories, *self.products])
        return rows + sum(1 for i in self.issues if i.level == "warning")


def _row_issue(level: str, sheet: str, row: Optional[int], message: str) -> Issue:
    prefix = f"שורה {row}: " if row else ""
    return Issue(level, prefix + message, sheet, row, message)


def _ref(category: Category) -> str:
    return f"id:{category.id}"


def _new_ref(name: str, parent_key: str = "") -> str:
    return f"new:{parent_key}/{S.normalize_name(name)}"


class _Planner:
    def __init__(self, ctx: Context, raw: S.RawFile):
        self.ctx = ctx
        self.raw = raw
        self.index = CategoryIndex(ctx)
        self.issues: List[Issue] = []
        self.examples = 0
        self.categories: List[CategoryPlan] = []
        #: The categories sheet's rows by normalized name (a name may appear under two parents).
        self.file_categories: Dict[str, List[CategoryPlan]] = {}
        #: ref → plan, for every category the import creates or touches.
        self.by_ref: Dict[str, CategoryPlan] = {}
        self.products: List[ProductPlan] = []
        self.routes: List[RouteChange] = []
        self.known_printers = {S.normalize_name(p.name) for p in ctx.printers}

    # ── categories ──

    def _implicit(self, name: str, source_row: int, sheet: str) -> Tuple[str, bool]:
        """A top-level category to create because a cell names it: (ref, made now)."""
        ref = _new_ref(name)
        if ref in self.by_ref:
            return ref, False
        where = "בגיליון הפריטים" if sheet == PRODUCTS else "בגיליון המחלקות"
        plan = CategoryPlan(ref=ref, name=name, row=None, set_parent=True, parent_ref=None, implicit_from=source_row)
        plan.issues.append(Issue("info", f"תיווצר כי שורה {source_row} {where} מציינת אותה", CATEGORIES, None))
        self.by_ref[ref] = plan
        self.categories.append(plan)
        return ref, True

    def _file_parent_key(self, plan: CategoryPlan) -> str:
        """The parent a categories-sheet row ends up under, as a name key ("" = top)."""
        if plan.parent_text and S.normalize_name(plan.parent_text) != S.normalize_name(S.PARENT_NONE):
            return S.normalize_name(plan.parent_text)
        if not plan.parent_text and plan.existing is not None:
            return self.index.parent_key(plan.existing)
        return ""

    def _read_category_rows(self) -> None:
        sheet = self.raw.categories
        if sheet is None:
            return
        for raw_row in sheet.rows:
            cells = raw_row.cells
            if S.is_marked(cells.get("marker")):
                self.examples += 1
                continue
            n = raw_row.number
            plan = CategoryPlan(ref="", name="", row=n)
            err = lambda message: plan.issues.append(_row_issue("error", CATEGORIES, n, message))  # noqa: E731
            name = S.parse_text(cells.get("name"), "שם המחלקה", S.NAME_MAX)
            if name.error:
                err(name.error)
            elif not name.value:
                err("חסר שם מחלקה")
            elif ">" in name.value:
                err("שם מחלקה לא יכול לכלול '>'")
            plan.name = name.value or ""
            plan.parent_text = S.clean_text(cells.get("parent"))
            printers = S.parse_printers(cells.get("printers"))
            sort = S.parse_int(cells.get("sort"), "סדר", -100000, 100000)
            active = S.parse_bool(cells.get("active"), "פעיל")
            for parsed in (printers, sort, active):
                if parsed.error:
                    err(parsed.error)
            plan.routing, plan.sort, plan.active = printers.value, sort.value, active.value
            if plan.name:
                self.file_categories.setdefault(S.normalize_name(plan.name), []).append(plan)
            self.categories.append(plan)

    def _match_category_rows(self) -> None:
        none_key = S.normalize_name(S.PARENT_NONE)
        for plan in [c for c in self.categories if c.row is not None]:
            if plan.has_error:
                continue
            name_key = S.normalize_name(plan.name)
            hits = self.index.named(name_key)
            if len(hits) > 1 and plan.parent_text:
                parent_key = "" if S.normalize_name(plan.parent_text) == none_key else S.normalize_name(plan.parent_text)
                narrowed = [c for c in hits if self.index.parent_key(c) == parent_key]
                if narrowed:
                    hits = narrowed
            if len(hits) > 1:
                plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                              f"יש כמה מחלקות בשם '{plan.name}' - ציינו את מחלקת האב כדי לזהות אותה"))
                continue
            if hits:
                plan.existing = hits[0]
                plan.ref = _ref(hits[0])
            else:
                plan.ref = _new_ref(plan.name, self._file_parent_key(plan))
            if plan.ref in self.by_ref:
                other = self.by_ref[plan.ref]
                plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                              f"המחלקה '{plan.name}' מופיעה גם בשורה {other.row}"))
                continue
            self.by_ref[plan.ref] = plan

    def _resolve_parents(self) -> None:
        for plan in [c for c in self.categories if c.row is not None and not c.has_error]:
            text_value = plan.parent_text
            if not text_value:
                # A new category is a top-level one; an existing one keeps its parent.
                plan.set_parent = plan.existing is None
                plan.parent_ref = None
                continue
            plan.set_parent = True
            if S.normalize_name(text_value) == S.normalize_name(S.PARENT_NONE):
                plan.parent_ref = None
                continue
            ref, label, issue = self.resolve_category(text_value, plan.row or 0, CATEGORIES)
            if issue is not None:
                if issue.level == "error":
                    plan.issues.append(issue)
                    continue
                plan.issues.append(_row_issue("warning", CATEGORIES, plan.row,
                                              f"מחלקת האב '{text_value}' לא קיימת - תיווצר"))
            plan.parent_ref = ref
            if plan.parent_ref == plan.ref:
                plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                              "מחלקה לא יכולה להיות מחלקת האב של עצמה"))

    def plan_categories(self) -> None:
        self._read_category_rows()
        self._match_category_rows()
        self._resolve_parents()
        self._check_cycles()
        self._propagate_parent_errors()

    def _propagate_parent_errors(self) -> None:
        """A row whose parent row is refused is refused too, rather than landing at the top."""
        changed = True
        while changed:
            changed = False
            for plan in self.categories:
                if plan.has_error or not plan.set_parent or plan.parent_ref is None:
                    continue
                parent = self.by_ref.get(plan.parent_ref)
                if parent is not None and parent.has_error:
                    plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                                  f"מחלקת האב '{parent.name}' שגויה (שורה {parent.row})"))
                    changed = True

    def _parent_of(self, ref: str) -> Optional[str]:
        plan = self.by_ref.get(ref)
        if plan is not None and (plan.set_parent or plan.existing is None):
            return plan.parent_ref
        if ref.startswith("id:"):
            category = self.ctx.category_by_id.get(ref[3:])
            if category is not None and category.parent_id:
                return f"id:{category.parent_id}"
        return None

    def _check_cycles(self) -> None:
        for plan in self.categories:
            if plan.has_error or not plan.set_parent or plan.parent_ref is None:
                continue
            chain = [plan.ref]
            current: Optional[str] = plan.parent_ref
            while current is not None and len(chain) < 60:
                if current == plan.ref:
                    names = [self._name_of(r) for r in chain] + [plan.name]
                    plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                                  "מחלקת האב יוצרת מעגל: " + S.PATH_SEPARATOR.join(names)))
                    break
                if current in chain:
                    break
                chain.append(current)
                current = self._parent_of(current)

    def _name_of(self, ref: Optional[str]) -> str:
        if ref is None:
            return ""
        plan = self.by_ref.get(ref)
        if plan is not None:
            return plan.name
        category = self.ctx.category_by_id.get(ref[3:]) if ref.startswith("id:") else None
        return category.name if category is not None else ""

    def category_changes(self) -> None:
        """What each row changes on its existing category; where the new ones go in the order."""
        top = max([c.sort_order or 0 for c in self.ctx.categories] or [0])
        for plan in self.categories:
            if plan.has_error:
                plan.action = "error"
                continue
            if plan.existing is None:
                plan.action = "create"
                if plan.sort is None:
                    top += 1
                    plan.sort = top
                continue
            c = plan.existing
            changes: List[Change] = []
            if plan.set_parent:
                current = f"id:{c.parent_id}" if c.parent_id else None
                if plan.parent_ref != current:
                    changes.append(Change("parent", "מחלקת אב", self._name_of(current), self._name_of(plan.parent_ref)))
            if plan.sort is not None and plan.sort != (c.sort_order or 0):
                changes.append(Change("sort", "סדר", c.sort_order or 0, plan.sort))
            if plan.active is not None and plan.active != bool(c.is_active):
                changes.append(Change("active", "פעיל", bool(c.is_active), plan.active))
            plan.changes = changes
            plan.action = "update" if changes else "unchanged"
            if changes and not may_edit_category(self.ctx.db, self.ctx.user, c):
                plan.issues.append(_row_issue("error", CATEGORIES, plan.row,
                                              f"אין לך הרשאה לעדכן את המחלקה '{c.name}'"))
                plan.action = "error"

    def resolve_category(self, text_value: str, row: int, sheet: str) -> Tuple[Optional[str], str, Optional[Issue]]:
        """A "מחלקה" / "מחלקת אב" cell → (ref, label, issue); an unknown name is made."""
        parent_key, name_key = _split_path(text_value)
        in_file = [
            c for c in self.file_categories.get(name_key, [])
            if parent_key is None or self._file_parent_key(c) == parent_key
        ]
        good = [c for c in in_file if not c.has_error and c.ref]
        if len(good) == 1:
            return good[0].ref, good[0].name if parent_key is None else text_value, None
        if len(good) > 1:
            return None, text_value, _row_issue(
                "error", sheet, row,
                f"יש כמה מחלקות בשם '{text_value}' בגיליון המחלקות - כתבו 'מחלקת אב > {text_value}'")
        found, ambiguous = self.index.find(text_value)
        if found is not None:
            if ambiguous:
                return None, text_value, _row_issue(
                    "error", sheet, row,
                    f"יש כמה מחלקות בשם '{text_value}' - כתבו למשל '{self.ctx.labels[str(found.id)]}'")
            return _ref(found), self.ctx.labels[str(found.id)], None
        if in_file:
            return None, text_value, _row_issue(
                "error", sheet, row, f"המחלקה '{text_value}' שגויה בגיליון המחלקות (שורה {in_file[0].row})")
        if parent_key is not None:
            return None, text_value, _row_issue("error", sheet, row, f"המחלקה '{text_value}' לא נמצאה")
        ref, made = self._implicit(text_value, row, sheet)
        issue = _row_issue("warning", sheet, row, f"מחלקה '{text_value}' לא קיימת - תיווצר") if made else None
        return ref, text_value, issue

    # ── products ──

    def plan_products(self) -> None:
        sheet = self.raw.products
        if sheet is None:
            return
        ctx = self.ctx
        self.by_barcode: Dict[str, List[Product]] = {}
        self.by_sku: Dict[str, Product] = {}
        self.by_name: Dict[Tuple[str, str], List[Product]] = {}
        for p in ctx.products:
            if p.barcode:
                self.by_barcode.setdefault(p.barcode.replace(" ", ""), []).append(p)
            self.by_sku[p.sku] = p
            self.by_name.setdefault((S.normalize_name(p.name), str(p.category_id)), []).append(p)
        self.candidate_ids = {str(p.id) for p in ctx.products}

        rows = []
        for raw_row in sheet.rows:
            if S.is_marked(raw_row.cells.get("marker")):
                self.examples += 1
            else:
                rows.append(raw_row)

        # Who already holds each SKU in the organization: a SKU is unique per tenant.
        wanted = sorted({s for s in (S.parse_code(r.cells.get("sku"), "מק״ט").value for r in rows) if s})
        self.tenant_skus: Dict[str, Tuple[str, str]] = {}
        for chunk in _chunks(wanted):
            for sku, pid, name in ctx.db.query(Product.sku, Product.id, Product.name).filter(
                Product.tenant_id == ctx.tenant_id, Product.sku.in_(list(chunk))
            ):
                self.tenant_skus[sku] = (str(pid), name)

        seen_barcodes: Dict[str, int] = {}
        seen_skus: Dict[str, int] = {}
        seen_products: Dict[str, int] = {}
        seen_new: Dict[Tuple[str, str], int] = {}
        for raw_row in rows:
            plan = self._product_row(raw_row)
            n = plan.row
            if not plan.has_error:
                for value, seen, label in ((plan.barcode, seen_barcodes, "הברקוד"), (plan.sku, seen_skus, "המק״ט")):
                    if value and value in seen:
                        plan.issues.append(_row_issue("error", PRODUCTS, n, f"{label} {value} מופיע גם בשורה {seen[value]}"))
                    elif value:
                        seen[value] = n
                if plan.existing is not None:
                    pid = str(plan.existing.id)
                    if pid in seen_products:
                        plan.issues.append(_row_issue(
                            "error", PRODUCTS, n,
                            f"השורה מתאימה לאותו פריט כמו שורה {seen_products[pid]} ('{plan.existing.name}')"))
                    else:
                        seen_products[pid] = n
                elif not plan.barcode and not plan.sku and plan.category_ref:
                    key = (S.normalize_name(plan.name), plan.category_ref)
                    if key in seen_new:
                        plan.issues.append(_row_issue(
                            "error", PRODUCTS, n,
                            f"הפריט '{plan.name}' במחלקה '{plan.category_label}' מופיע גם בשורה {seen_new[key]}"))
                    else:
                        seen_new[key] = n
            if plan.has_error:
                plan.action = "error"
            self.products.append(plan)

    _PARSERS: Dict[str, Callable[[Any], S.Parsed]] = {
        "name": lambda v: S.parse_text(v, "שם הפריט", S.NAME_MAX),
        "category": lambda v: S.parse_text(v, "המחלקה", S.NAME_MAX),
        "price": lambda v: S.parse_money(v, "מחיר"),
        "barcode": lambda v: S.parse_code(v, "ברקוד", strip_spaces=True),
        "sku": lambda v: S.parse_code(v, "מק״ט"),
        "cost": lambda v: S.parse_money(v, "עלות", S.COST_MAX),
        "open_price": lambda v: S.parse_bool(v, "מחיר פתוח"),
        "weighed": lambda v: S.parse_bool(v, "נמכר במשקל"),
        "unit": lambda v: S.parse_text(v, "יחידה", S.UNIT_MAX),
        "no_discount": lambda v: S.parse_bool(v, "ללא הנחה"),
        "printers": S.parse_printers,
        "ticket": lambda v: S.parse_ticket(v, "שובר פריט"),
        "entries": lambda v: S.parse_int(v, "כרטיס כניסה", 1, S.ENTRIES_MAX, allow_clear=True),
        "active": lambda v: S.parse_bool(v, "פעיל"),
        "description": lambda v: S.parse_text(v, "תיאור", S.DESCRIPTION_MAX),
        "dietary": S.parse_dietary,
    }

    def _product_row(self, raw_row: S.RawRow) -> ProductPlan:
        n = raw_row.number
        plan = ProductPlan(row=n)
        err = lambda message: plan.issues.append(_row_issue("error", PRODUCTS, n, message))  # noqa: E731
        warn = lambda message: plan.issues.append(_row_issue("warning", PRODUCTS, n, message))  # noqa: E731

        values: Dict[str, Any] = {}
        for key, parse in self._PARSERS.items():
            parsed = parse(raw_row.cells.get(key))
            if parsed.error:
                err(parsed.error)
                continue
            if parsed.warning:
                warn(parsed.warning)
            values[key] = parsed.value
        plan.name = values.get("name") or S.clean_text(raw_row.cells.get("name"))
        plan.price, plan.routing = values.get("price"), values.get("printers")
        plan.barcode, plan.sku = values.get("barcode"), values.get("sku")
        if not plan.name:
            err("חסר שם פריט")
        if values.get("category"):
            plan.category_ref, plan.category_label, issue = self.resolve_category(values["category"], n, PRODUCTS)
            if issue is not None:
                plan.issues.append(issue)

        match, matched_by = self._match(plan, err)
        plan.existing, plan.matched_by = match, matched_by
        if plan.has_error:
            return plan
        if match is None:
            self._new_product(plan, values, warn, err)
        else:
            self._update_product(plan, values, warn, err)
        return plan

    def _match(self, plan: ProductPlan, err) -> Tuple[Optional[Product], Optional[str]]:
        """By barcode, then SKU, then the exact name in the same category."""
        barcode, sku = plan.barcode, plan.sku
        match: Optional[Product] = None
        how: Optional[str] = None
        if barcode and barcode in self.by_barcode:
            hits = self.by_barcode[barcode]
            if len(hits) > 1:
                narrowed = [h for h in hits if sku and h.sku == sku] or [
                    h for h in hits
                    if plan.category_ref == f"id:{h.category_id}" and S.normalize_name(h.name) == S.normalize_name(plan.name)
                ]
                hits = narrowed if len(narrowed) == 1 else hits
            if len(hits) == 1:
                match, how = hits[0], "barcode"
            else:
                names = ", ".join(h.name for h in hits[:3])
                err(f"הברקוד {barcode} משויך לכמה פריטים ({names}) - הוסיפו מק״ט כדי לזהות")
                return None, None
        if match is None and sku:
            hit = self.by_sku.get(sku)
            if hit is not None:
                match, how = hit, "sku"
            elif sku in self.tenant_skus:
                err(f"המק״ט {sku} כבר בשימוש בפריט אחר בארגון ('{self.tenant_skus[sku][1]}')")
                return None, None
        if match is None and plan.category_ref and plan.category_ref.startswith("id:") and plan.name:
            hits = self.by_name.get((S.normalize_name(plan.name), plan.category_ref[3:]), [])
            if len(hits) == 1:
                match, how = hits[0], "name"
            elif len(hits) > 1:
                err(f"יש כמה פריטים בשם '{plan.name}' במחלקה '{plan.category_label}' - הוסיפו ברקוד או מק״ט כדי לזהות")
                return None, None
        if match is not None and sku and sku != match.sku:
            owner = self.by_sku.get(sku)
            if owner is not None and owner.id != match.id:
                err(f"הברקוד שייך לפריט '{match.name}' אבל המק״ט {sku} שייך לפריט '{owner.name}'")
                return None, None
            if sku in self.tenant_skus and self.tenant_skus[sku][0] != str(match.id):
                err(f"המק״ט {sku} כבר בשימוש בפריט אחר בארגון ('{self.tenant_skus[sku][1]}')")
                return None, None
        return match, how

    def _new_product(self, plan: ProductPlan, values: Dict[str, Any], warn, err) -> None:
        if not plan.category_ref:
            err("חסרה מחלקה")
        if plan.price is None:
            err("מחיר חסר")
        if plan.has_error:
            return
        weighed = values.get("weighed")
        unit = values.get("unit")
        if weighed is None and S.is_weight_unit(unit):
            weighed = True
            warn(f"הפריט יוגדר כנמכר במשקל לפי היחידה '{unit}'")
        open_price = bool(values.get("open_price"))
        if plan.price == 0 and not open_price:
            warn("מחיר 0 - הפריט יימכר בחינם")
        ticket = values.get("ticket")
        entries = values.get("entries")
        plan.values = {
            "name": plan.name,
            "description": values.get("description"),
            "price": plan.price,
            "barcode": plan.barcode,
            "sku": plan.sku,
            "is_open_price": open_price,
            "is_weighed": bool(weighed),
            "unit_label": unit,
            "no_discount": bool(values.get("no_discount")),
            "ticket_mode": None if ticket in (None, S.TICKET_INHERIT) else item_ticket.normalize(ticket),
            "ticket_entries": entries if isinstance(entries, int) else None,
            "is_available": True if values.get("active") is None else bool(values.get("active")),
            "dietary_tags": list(values.get("dietary") or ()) or None,
        }
        plan.cost = values.get("cost")
        plan.action = "create"

    def _update_product(self, plan: ProductPlan, values: Dict[str, Any], warn, err) -> None:
        p = plan.existing
        changes: List[Change] = []
        out: Dict[str, Any] = {}

        def change(key: str, label: str, column_name: str, current: Any, new: Any) -> None:
            if new is None or new == current:
                return
            out[column_name] = new
            changes.append(Change(key, label, current, new))

        change("name", "שם", "name", p.name, plan.name or None)
        if plan.category_ref and plan.category_ref != f"id:{p.category_id}":
            out["category_id"] = plan.category_ref
            changes.append(Change("category", "מחלקה", self.ctx.labels.get(str(p.category_id), ""), plan.category_label))
        current_price = Decimal(p.price).quantize(S.CENT) if p.price is not None else None
        change("price", "מחיר", "price", current_price, plan.price)
        change("barcode", "ברקוד", "barcode", p.barcode, plan.barcode)
        if plan.sku and plan.sku != p.sku:
            if p.sku_auto_assigned:
                warn(f"המק״ט {p.sku} הוקצה אוטומטית ולא ישתנה")
            else:
                change("sku", "מק״ט", "sku", p.sku, plan.sku)
        cost = values.get("cost")
        current_cost = self.ctx.costs.get(str(p.id))
        if cost is not None and cost != current_cost:
            plan.cost = cost
            changes.append(Change("cost", "עלות", current_cost, cost))
        change("open_price", "מחיר פתוח", "is_open_price", bool(p.is_open_price), values.get("open_price"))
        change("weighed", "נמכר במשקל", "is_weighed", bool(p.is_weighed), values.get("weighed"))
        change("unit", "יחידה", "unit_label", p.unit_label, values.get("unit"))
        change("no_discount", "ללא הנחה", "no_discount", bool(p.no_discount), values.get("no_discount"))
        ticket = values.get("ticket")
        if ticket is not None:
            wanted = None if ticket == S.TICKET_INHERIT else item_ticket.normalize(ticket)
            current = item_ticket.normalize(p.ticket_mode)
            if wanted != current:
                out["ticket_mode"] = wanted
                inherit = S.TICKET_LABELS[S.TICKET_INHERIT]
                changes.append(Change("ticket", "שובר פריט", ticket_label(current) or inherit, ticket_label(wanted) or inherit))
        entries = values.get("entries")
        if entries is not None:
            wanted_entries = entries if isinstance(entries, int) else None
            if wanted_entries != p.ticket_entries:
                out["ticket_entries"] = wanted_entries
                changes.append(Change("entries", "כרטיס כניסה", p.ticket_entries, wanted_entries))
        change("active", "פעיל", "is_available", bool(p.is_available), values.get("active"))
        change("description", "תיאור", "description", p.description, values.get("description"))
        wanted_tags = values.get("dietary")
        if wanted_tags is not None:
            current_tags = dietary.tags_out(p.dietary_tags)
            if list(wanted_tags) != current_tags:
                out["dietary_tags"] = list(wanted_tags) or None
                changes.append(Change(
                    "dietary", "סימוני תזונה",
                    ", ".join(dietary.labels(current_tags)), ", ".join(dietary.labels(wanted_tags)),
                ))

        if out.get("is_open_price") is False:
            price = plan.price if plan.price is not None else current_price
            if price is None or price <= 0:
                err("ביטול 'מחיר פתוח' דורש מחיר גדול מ-0")
                return
        plan.values = out
        plan.changes = changes
        plan.action = "update" if changes else "unchanged"
        if changes and not may_edit_product(self.ctx.db, self.ctx.user, p):
            err(f"אין לך הרשאה לעדכן את הפריט '{p.name}'")
            plan.action = "error"

    # ── routing ──

    def _desired(self, spec: S.RoutingSpec, shop_id: str):
        printers = self.ctx.printers_by_shop.get(shop_id, [])
        if spec.mode == "inherit":
            return None
        if spec.mode == "none":
            return frozenset({_NO_TICKET}) if printers else _KEEP
        keys = {S.normalize_name(n) for n in spec.names}
        matched = frozenset(str(p.id) for p in printers if S.normalize_name(p.name) in keys)
        return matched if matched else _KEEP

    def _route_text(self, own: Optional[FrozenSet[str]], inherit_label: str) -> str:
        if own is None:
            return inherit_label
        if own == frozenset({_NO_TICKET}):
            return S.PRINTERS_NONE
        names = sorted({self.ctx.printer_by_id[p].name for p in own if p in self.ctx.printer_by_id})
        return ", ".join(names)

    def plan_routes(self) -> None:
        targets: List[Tuple[str, Any, str, Optional[str], str]] = []
        for c in self.categories:
            if c.routing is not None and not c.has_error:
                targets.append(("category", c, c.ref, str(c.existing.id) if c.existing is not None else None, CATEGORIES))
        for p in self.products:
            if p.routing is not None and not p.has_error:
                targets.append(("product", p, p.ref, str(p.existing.id) if p.existing is not None else None, PRODUCTS))
        if not targets:
            return
        if self.ctx.locked_shops:
            names = ", ".join(s.name for s in self.ctx.locked_shops[:5])
            self.issues.append(Issue("warning", f"אין לך הרשאה לשנות ניתוב מדפסות בסניפים: {names} - שם לא ישתנה דבר"))
        if not self.ctx.printers:
            self.issues.append(Issue("warning", "לא הוגדרו מדפסות בסניפי החברה - עמודות 'מדפסות' יידלגו"))
            return
        for target_type, plan, ref, existing_id, sheet in targets:
            spec: S.RoutingSpec = plan.routing
            if spec.mode == "names":
                for name in spec.names:
                    if S.normalize_name(name) not in self.known_printers:
                        plan.issues.append(_row_issue("warning", sheet, plan.row, f"מדפסת '{name}' לא מוגדרת - השיוך יידלג"))
            befores: List[Optional[FrozenSet[str]]] = []
            for shop in self.ctx.shops:
                shop_id = str(shop.id)
                desired = self._desired(spec, shop_id)
                if desired is _KEEP:
                    continue
                current = self.ctx.own_routes.get((target_type, existing_id, shop_id)) if existing_id else None
                if desired == current:
                    continue
                befores.append(current)
                self.routes.append(RouteChange(target_type, ref, shop.id, current, desired))
            if befores:
                inherit_label = "לפי המחלקה" if target_type == "product" else "לפי מחלקת האב"
                before = " / ".join(sorted({self._route_text(b, inherit_label) for b in befores}))
                after = inherit_label if spec.mode == "inherit" else spec.text()
                plan.changes.append(Change("printers", "מדפסות", before, after))
                if plan.action == "unchanged":
                    plan.action = "update"

    # ── the whole ──

    def build(self) -> Plan:
        for note in self.raw.notes:
            self.issues.append(Issue("warning", note))
        for sheet, title in ((self.raw.products, "הפריטים"), (self.raw.categories, "המחלקות")):
            if sheet is not None:
                for header in sheet.unknown_headers:
                    self.issues.append(Issue("warning", f"העמודה '{header}' בגיליון {title} לא מוכרת ותידלג"))
        if self.raw.products is not None:
            missing = [c.title for c in S.PRODUCT_COLUMNS if c.required and c.key not in self.raw.products.headers]
            if missing:
                self.issues.append(Issue("error", f"בגיליון הפריטים חסרות העמודות: {', '.join(missing)}"))
        self.plan_categories()
        if not any(i.level == "error" for i in self.issues):
            self.plan_products()
        self.category_changes()
        self.plan_routes()
        plan = Plan(
            ctx=self.ctx, categories=self.categories, products=self.products, routes=self.routes,
            issues=self.issues, examples_skipped=self.examples, file_kind=self.raw.kind,
        )
        plan.fingerprint = fingerprint(plan)
        return plan


def build_plan(ctx: Context, raw: S.RawFile) -> Plan:
    return _Planner(ctx, raw).build()


def fingerprint(plan: Plan) -> str:
    """What applying the plan would do, as a short hash - the preview token carries it."""
    items: List[Any] = []
    for c in plan.categories:
        items.append(["c", c.row, c.ref, c.action, c.set_parent, c.parent_ref, c.sort, c.active,
                      [[ch.field, str(ch.after)] for ch in c.changes]])
    for p in plan.products:
        items.append(["p", p.row, p.ref, p.action, p.category_ref,
                      sorted([k, str(v)] for k, v in p.values.items()), str(p.cost),
                      [[ch.field, str(ch.after)] for ch in p.changes]])
    for r in plan.routes:
        items.append(["r", r.target_type, r.target_ref, str(r.shop_id),
                      sorted(r.after) if r.after is not None else None])
    raw = json.dumps(items, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# ── The preview, as the dashboard shows it ────────────────────────────────────


def _status(action: str, issues: List[Issue]) -> str:
    if action == "error" or any(i.level == "error" for i in issues):
        return "error"
    return action


def summary(plan: Plan) -> Dict[str, Any]:
    def count(rows, action):
        return sum(1 for r in rows if _status(r.action, r.issues) == action)

    return {
        "productsNew": count(plan.products, "create"),
        "productsUpdated": count(plan.products, "update"),
        "productsUnchanged": count(plan.products, "unchanged"),
        "categoriesNew": count(plan.categories, "create"),
        "categoriesUpdated": count(plan.categories, "update"),
        "categoriesUnchanged": count(plan.categories, "unchanged"),
        "routingChanges": len({(r.target_type, r.target_ref) for r in plan.routes}),
        "routingShops": len({str(r.shop_id) for r in plan.routes}),
        "errors": plan.error_rows() + sum(1 for i in plan.issues if i.level == "error"),
        "warnings": plan.warning_count(),
        "examplesSkipped": plan.examples_skipped,
    }


def preview_out(plan: Plan) -> Dict[str, Any]:
    products = []
    for p in plan.products:
        price = p.price if p.price is not None else (Decimal(p.existing.price) if p.existing is not None else None)
        products.append({
            "row": p.row,
            "status": _status(p.action, p.issues),
            "name": p.name,
            "category": p.category_label or (plan.ctx.labels.get(str(p.existing.category_id), "") if p.existing else ""),
            "price": f"{price:.2f}" if price is not None else None,
            "matchedBy": p.matched_by,
            "productId": str(p.existing.id) if p.existing is not None else None,
            "changes": [c.out() for c in p.changes],
            "messages": [i.out() for i in p.issues],
        })
    categories = []
    for c in plan.categories:
        categories.append({
            "row": c.row,
            "status": _status(c.action, c.issues),
            "name": c.name,
            "parent": c.parent_text,
            "implicitFrom": c.implicit_from,
            "categoryId": str(c.existing.id) if c.existing is not None else None,
            "changes": [ch.out() for ch in c.changes],
            "messages": [i.out() for i in c.issues],
        })
    actionable = any(_status(x.action, x.issues) in ("create", "update") for x in [*plan.products, *plan.categories])
    return {
        "companyId": str(plan.ctx.company.id),
        "companyName": plan.ctx.company.name,
        "fileKind": plan.file_kind,
        "summary": summary(plan),
        "issues": [i.out() for i in plan.issues],
        "products": products,
        "categories": categories,
        "canCommit": not plan.fatal and actionable,
    }


# ── Applying ──────────────────────────────────────────────────────────────────


@dataclass
class ApplyResult:
    products_created: int = 0
    products_updated: int = 0
    categories_created: int = 0
    categories_updated: int = 0
    costs_updated: int = 0
    routing_changes: int = 0
    skipped_error_rows: int = 0
    catalog_changed: bool = False
    route_shop_ids: Set[str] = field(default_factory=set)

    def out(self) -> Dict[str, Any]:
        return {
            "productsCreated": self.products_created,
            "productsUpdated": self.products_updated,
            "categoriesCreated": self.categories_created,
            "categoriesUpdated": self.categories_updated,
            "costsUpdated": self.costs_updated,
            "routingChanges": self.routing_changes,
            "skippedErrorRows": self.skipped_error_rows,
        }


def lock_tenant(db: Session, tenant_id) -> None:
    """One import at a time per organization, so two commits cannot both create a row."""
    if db.get_bind().dialect.name != "postgresql":
        return
    digest = hashlib.sha256(f"catalog-import:{tenant_id}".encode("utf-8")).digest()
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": int.from_bytes(digest[:8], "big", signed=True)})


def _allocate(db: Session, row, taken: Callable[[List[str]], Set[str]], count: int) -> List[str]:
    """`count` numbers from a locked sequence row, skipping any already used."""
    out: List[str] = []
    while len(out) < count:
        need = count - len(out)
        candidates = [str(row.next_value + i) for i in range(need)]
        row.next_value = row.next_value + need
        used = taken(candidates)
        out.extend(c for c in candidates if c not in used)
    db.flush()
    return out


def allocate_skus(db: Session, tenant_id, count: int) -> List[str]:
    """The SKU series of `app.services.sku_sequence`, `count` at a time."""
    if count <= 0:
        return []
    from app.services.sku_sequence import _get_or_create_sequence_row

    return _allocate(
        db, _get_or_create_sequence_row(db, tenant_id),
        lambda c: {s for (s,) in db.query(Product.sku).filter(Product.tenant_id == tenant_id, Product.sku.in_(c))},
        count,
    )


def allocate_global_skus(db: Session, tenant_id, count: int) -> List[str]:
    """The global SKU series of `app.services.tenant_sku_sequence`, `count` at a time."""
    if count <= 0:
        return []
    from app.services.tenant_sku_sequence import _get_or_create_tenant_sequence_row

    return _allocate(
        db, _get_or_create_tenant_sequence_row(db, tenant_id),
        lambda c: {
            s for (s,) in db.query(Product.global_sku).filter(
                Product.tenant_id == tenant_id, Product.catalog_level == CatalogLevel.GLOBAL, Product.global_sku.in_(c)
            )
        },
        count,
    )


def apply_plan(db: Session, plan: Plan, user: User) -> ApplyResult:
    """Write the plan's error-free rows. The caller commits (one transaction) or rolls back."""
    from app.routers.products import _check_catalog_placement, _require_shop_writes

    ctx = plan.ctx
    tenant_id, company_id = ctx.tenant_id, ctx.company.id
    result = ApplyResult(skipped_error_rows=plan.error_rows())
    #: The ids of the rows this import creates, by ref; an existing row's ref is its id.
    ids: Dict[str, uuid.UUID] = {}

    def resolve(ref: Optional[str]) -> Optional[uuid.UUID]:
        if ref is None:
            return None
        if ref.startswith("id:"):
            return uuid.UUID(ref[3:])
        return ids.get(ref)

    new_categories = [c for c in plan.categories if c.action == "create" and not c.has_error]
    new_products = [p for p in plan.products if p.action == "create" and not p.has_error]
    if new_categories or new_products:
        _check_catalog_placement(db, user, tenant_id, company_id=company_id)
    if new_products and ctx.scope_shop_ids:
        _require_shop_writes(db, user, ctx.scope_shop_ids)

    # Categories: every new one gets its id first, so a child can name a new parent; they
    # are inserted a level at a time, parents first.
    for c in new_categories:
        ids[c.ref] = uuid.uuid4()
    by_ref = {c.ref: c for c in new_categories}

    def depth(c: CategoryPlan) -> int:
        d, ref = 0, c.parent_ref
        while ref is not None and ref in by_ref and d < 60:
            d += 1
            ref = by_ref[ref].parent_ref
        return d

    levels: Dict[int, List[CategoryPlan]] = {}
    for c in new_categories:
        levels.setdefault(depth(c), []).append(c)
    for level in sorted(levels):
        for c in levels[level]:
            db.add(Category(
                id=ids[c.ref], tenant_id=tenant_id, company_id=company_id, shop_id=None, pos_machine_id=None,
                catalog_level=CategoryLevel.GLOBAL, name=c.name, parent_id=resolve(c.parent_ref),
                is_active=True if c.active is None else c.active, sort_order=c.sort or 0,
            ))
            result.categories_created += 1
        db.flush()
    for c in plan.categories:
        if c.action != "update" or c.has_error or c.existing is None:
            continue
        touched = False
        for change in c.changes:
            if change.field == "parent":
                c.existing.parent_id = resolve(c.parent_ref)
                touched = True
            elif change.field == "sort":
                c.existing.sort_order = c.sort
                touched = True
            elif change.field == "active":
                c.existing.is_active = c.active
                touched = True
        if touched:
            result.categories_updated += 1

    # Products.
    auto_skus = iter(allocate_skus(db, tenant_id, sum(1 for p in new_products if not p.values.get("sku"))))
    global_skus = iter(allocate_global_skus(db, tenant_id, len(new_products)))
    costs: List[Tuple[uuid.UUID, Decimal]] = []
    for p in new_products:
        v = p.values
        sku = v.get("sku") or next(auto_skus)
        product = Product(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, shop_id=None, pos_machine_id=None,
            category_id=resolve(p.category_ref), global_product_id=None, catalog_level=CatalogLevel.GLOBAL,
            is_local_override=False, name=v["name"], description=v.get("description"), price=v["price"],
            sku=sku, global_sku=next(global_skus), sku_auto_assigned=not v.get("sku"), image_url=None,
            in_stock=True, is_available=v["is_available"], stock_quantity=0, barcode=v.get("barcode"),
            tax_rate=None, voucher_id=None, ticket_mode=v.get("ticket_mode"), ticket_entries=v.get("ticket_entries"),
            track_stock=False, is_open_price=v["is_open_price"], is_weighed=v["is_weighed"],
            unit_label=v.get("unit_label"), no_discount=v["no_discount"], is_general=False,
            dietary_tags=v.get("dietary_tags"),
        )
        db.add(product)
        # Sold in every active shop of the company: the product form's default rule.
        scope_svc.set_scope_fields(product, scope_svc.MODE_COMPANY, company_id, False)
        scope_svc.execute_plan(db, product, scope_svc.ScopePlan(create=list(ctx.scope_shop_ids)))
        ids[p.ref] = product.id
        result.products_created += 1
        if p.cost is not None:
            costs.append((product.id, p.cost))

    for p in plan.products:
        if p.action != "update" or p.has_error or p.existing is None:
            continue
        product = p.existing
        for key, value in p.values.items():
            setattr(product, key, resolve(value) if key == "category_id" else value)
        cost_changed = p.cost is not None and any(ch.field == "cost" for ch in p.changes)
        if cost_changed:
            costs.append((product.id, p.cost))
        if p.values or cost_changed:
            result.products_updated += 1
    db.flush()

    if costs:
        existing = {}
        for chunk in _chunks([pid for pid, _ in costs]):
            for row in db.query(ProductCost).filter(ProductCost.tenant_id == tenant_id, ProductCost.product_id.in_(list(chunk))):
                existing[str(row.product_id)] = row
        for product_id, cost in costs:
            row = existing.get(str(product_id))
            if row is None:
                db.add(ProductCost(tenant_id=tenant_id, product_id=product_id, cost=cost, updated_by_user_id=user.id))
            else:
                row.cost = cost
                row.updated_by_user_id = user.id
            result.costs_updated += 1

    # Routing, per (target, shop): the target's own rows become exactly the plan's.
    for r in plan.routes:
        target_id = resolve(r.target_ref)
        if target_id is None:
            continue
        db.query(KitchenPrinterRoute).filter(
            KitchenPrinterRoute.shop_id == r.shop_id,
            KitchenPrinterRoute.target_type == r.target_type,
            KitchenPrinterRoute.target_id == target_id,
        ).delete(synchronize_session=False)
        for printer in sorted(r.after or ()):
            db.add(KitchenPrinterRoute(
                id=uuid.uuid4(), tenant_id=tenant_id, shop_id=r.shop_id, target_type=r.target_type,
                target_id=target_id, printer_id=None if printer == _NO_TICKET else uuid.UUID(printer),
            ))
        result.route_shop_ids.add(str(r.shop_id))
    result.routing_changes = len({(r.target_type, r.target_ref) for r in plan.routes})
    # A category placed or moved under another inherits that one's printers: the tills'
    # resolved routes change although no route row did.
    moved = any(c.parent_ref for c in new_categories) or any(
        ch.field == "parent" for c in plan.categories if c.action == "update" and not c.has_error for ch in c.changes
    )
    if moved:
        result.route_shop_ids |= {str(s.id) for s in ctx.shops if ctx.printers_by_shop.get(str(s.id))}
    db.flush()

    result.catalog_changed = bool(
        result.products_created or result.categories_created or result.categories_updated
        or any(p.action == "update" and not p.has_error and p.values for p in plan.products)
    )
    return result


# ── Export: the workbook's contents ───────────────────────────────────────────


def routing_cell(ctx: Context, target_type: str, target_id: str) -> Tuple[str, Optional[str]]:
    """
    A row's own routing as one "מדפסות" cell that, imported back, changes nothing - or ""
    and a note when the shops differ in a way one cell cannot say.
    """
    shops = [s for s in ctx.shops if ctx.printers_by_shop.get(str(s.id))]
    own = {str(s.id): ctx.own_routes.get((target_type, target_id, str(s.id))) for s in shops}
    if all(v is None for v in own.values()):
        return "", None
    none = frozenset({_NO_TICKET})
    if all(v == none for v in own.values()):
        return S.PRINTERS_NONE, None
    names: List[str] = []
    keys: Set[str] = set()
    for shop in shops:
        current = own[str(shop.id)] or frozenset()
        for printer in ctx.printers_by_shop[str(shop.id)]:
            if str(printer.id) in current and S.normalize_name(printer.name) not in keys:
                keys.add(S.normalize_name(printer.name))
                names.append(printer.name)
    faithful = bool(names)
    for shop in shops:
        matched = frozenset(str(p.id) for p in ctx.printers_by_shop[str(shop.id)] if S.normalize_name(p.name) in keys)
        if matched and matched != own[str(shop.id)]:
            faithful = False
            break
    if faithful:
        return ", ".join(names), None
    parts = []
    for shop in shops:
        current = own[str(shop.id)]
        if current is None:
            value = S.PRINTERS_INHERIT
        elif current == none:
            value = S.PRINTERS_NONE
        else:
            value = ", ".join(sorted(ctx.printer_by_id[p].name for p in current if p in ctx.printer_by_id))
        parts.append(f"{shop.name}: {value}")
    return "", "הניתוב שונה בין הסניפים (" + "; ".join(parts) + ") - ערכו אותו במסך 'מדפסות בונים'"


def _yes_no(value: Any) -> str:
    return S.YES if value else S.NO


def template_view(ctx: Context, *, with_data: bool, now: Optional[datetime] = None, tz=None) -> TemplateView:
    moment = now or _now()
    if tz is not None:
        moment = moment.astimezone(tz)
    view = TemplateView(company_name=ctx.company.name, generated_at=moment.replace(tzinfo=None), with_data=with_data)
    shop_names = {str(s.id): s.name for s in ctx.shops}
    seen_names: Set[str] = set()
    for printer in ctx.printers:
        narrowed = ""
        if printer.machine_id:
            narrowed = ctx.machines.get(str(printer.machine_id), "")
        elif printer.area_id:
            narrowed = ctx.areas.get(str(printer.area_id), "")
        view.printers.append(PrinterRef(
            name=printer.name, shop=shop_names.get(str(printer.shop_id), ""), active=bool(printer.is_active),
            narrowed=narrowed or "כל הסניף",
            connection=CONNECTION_LABELS.get(printer.connection_type, printer.connection_type),
        ))
        if S.normalize_name(printer.name) not in seen_names:
            seen_names.add(S.normalize_name(printer.name))
            view.printer_choices.append(printer.name)

    for c in ctx.categories:
        parent = ctx.category_by_id.get(str(c.parent_id)) if c.parent_id else None
        printers, note = routing_cell(ctx, "category", str(c.id))
        row: Dict[str, Any] = {
            "name": c.name,
            "parent": ctx.labels[str(parent.id)] if parent else "",
            "printers": printers,
            "sort": c.sort_order or 0,
            "active": _yes_no(c.is_active),
        }
        if note:
            row["notes"] = {"printers": note}
            view.has_mixed_routing = True
        view.categories.append(row)

    if with_data:
        order = {str(c.id): i for i, c in enumerate(ctx.categories)}
        for p in sorted(ctx.products, key=lambda p: (order.get(str(p.category_id), 10**6), p.name or "")):
            printers, note = routing_cell(ctx, "product", str(p.id))
            row = {
                "name": p.name,
                "category": ctx.labels.get(str(p.category_id), ""),
                "price": Decimal(p.price).quantize(S.CENT) if p.price is not None else None,
                "barcode": p.barcode or "",
                "sku": p.sku or "",
                "cost": ctx.costs.get(str(p.id)),
                "open_price": _yes_no(p.is_open_price),
                "weighed": _yes_no(p.is_weighed),
                "unit": p.unit_label or "",
                "no_discount": _yes_no(p.no_discount),
                "printers": printers,
                "ticket": ticket_label(item_ticket.normalize(p.ticket_mode)),
                "entries": p.ticket_entries,
                "active": _yes_no(p.is_available),
                "description": p.description or "",
                "dietary": ", ".join(dietary.labels(p.dietary_tags)),
            }
            if note:
                row["notes"] = {"printers": note}
                view.has_mixed_routing = True
            view.products.append(row)
    return view


def company_summary(ctx: Context) -> Dict[str, Any]:
    shop_names = {str(s.id): s.name for s in ctx.shops}
    return {
        "companyId": str(ctx.company.id),
        "companyName": ctx.company.name,
        "products": len(ctx.products),
        "categories": len(ctx.categories),
        "shops": len(ctx.shops),
        "printers": [
            {"name": p.name, "shopName": shop_names.get(str(p.shop_id), ""), "isActive": bool(p.is_active)}
            for p in ctx.printers
        ],
    }


# ── Tokens ────────────────────────────────────────────────────────────────────

PREVIEW_TTL = timedelta(hours=2)
SHARE_TTL = timedelta(days=7)


class TokenError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason  # "invalid" | "expired"


def _key(purpose: str) -> bytes:
    """A key per purpose, derived from the server secret: neither token is a JWT, or the other."""
    secret = (get_settings().jwt_secret_key or "").encode("utf-8")
    return hmac.new(secret, f"catalog-import:{purpose}".encode("utf-8"), hashlib.sha256).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:32]


def make_preview_token(tenant_id, company_id, user_id, digest: str, plan_fingerprint: str,
                       now: Optional[datetime] = None) -> str:
    expires = int(((now or _now()) + PREVIEW_TTL).timestamp())
    payload = json.dumps(
        {"v": 1, "t": str(tenant_id), "c": str(company_id), "u": str(user_id), "h": digest,
         "f": plan_fingerprint, "e": expires},
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hmac.new(_key("preview"), payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(signature)}"


def read_preview_token(token: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    try:
        body, signature = token.split(".")
        payload = _unb64(body)
        expected = hmac.new(_key("preview"), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(signature)):
            raise TokenError("invalid")
        claims = json.loads(payload)
    except TokenError:
        raise
    except Exception:  # noqa: BLE001 - any malformed token is simply invalid
        raise TokenError("invalid")
    if int(claims.get("e", 0)) < int((now or _now()).timestamp()):
        raise TokenError("expired")
    return claims


def make_share_token(tenant_id, company_id, user_id, now: Optional[datetime] = None) -> Tuple[str, datetime]:
    """A short signed token (92 characters): version, tenant, company, issuer, expiry."""
    expires_at = ((now or _now()) + SHARE_TTL).replace(microsecond=0)
    body = (
        bytes([1])
        + uuid.UUID(str(tenant_id)).bytes
        + uuid.UUID(str(company_id)).bytes
        + uuid.UUID(str(user_id)).bytes
        + int(expires_at.timestamp()).to_bytes(4, "big")
    )
    signature = hmac.new(_key("share"), body, hashlib.sha256).digest()[:16]
    return _b64(body + signature), expires_at


def read_share_token(token: str, now: Optional[datetime] = None) -> Tuple[uuid.UUID, uuid.UUID, uuid.UUID, datetime]:
    try:
        raw = _unb64(token)
    except Exception:  # noqa: BLE001
        raise TokenError("invalid")
    if len(raw) != 69 or raw[0] != 1:
        raise TokenError("invalid")
    body, signature = raw[:53], raw[53:]
    if not hmac.compare_digest(hmac.new(_key("share"), body, hashlib.sha256).digest()[:16], signature):
        raise TokenError("invalid")
    tenant_id = uuid.UUID(bytes=body[1:17])
    company_id = uuid.UUID(bytes=body[17:33])
    user_id = uuid.UUID(bytes=body[33:49])
    expires_at = datetime.fromtimestamp(int.from_bytes(body[49:53], "big"), tz=timezone.utc)
    if expires_at <= (now or _now()):
        raise TokenError("expired")
    return tenant_id, company_id, user_id, expires_at


# ── Notify (after the commit) ─────────────────────────────────────────────────


def catalog_targets(db: Session, tenant_id) -> List[Tuple[str, str]]:
    machines = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True)).all()
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id]


def publish_catalog_notify(targets: Iterable[Tuple[str, str]]) -> None:
    """The tills' catalog signal (their delta pull), as the products router sends it."""
    from app.services import ably_notify

    for tenant_id, machine_id in targets:
        try:
            ably_notify.publish_catalog_notify(tenant_id, machine_id, reason="catalog_import")
        except Exception:  # pragma: no cover - best effort; the tills also pull on their own
            pass
