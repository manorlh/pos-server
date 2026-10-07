"""
The menu sheet's restaurant layer ("ייבוא פריטים מאקסל", app/services/catalog_import.py):
add-on groups and their options, which groups a product or category gets, quick-note
chips, pictures by link, and catalog-menu prices - planned with the products and
categories of the same file and written in the same transaction.

The import's rules hold here too:

* **Matching** - a group by its name among the groups the company's catalog sees (its
  own, a company's above it, the organization's; the nearest wins). An option by its name
  within its group. A note by its text on its target. A menu by its name.
* **An empty cell keeps** the current value; a new row gets the default. **Nothing absent
  is deleted**: a group, an option, a chip or a menu row not in the file stays as it is
  (switch it off with "פעילה" = לא). Importing the same file twice changes nothing.
* **"קבוצות תוספות" of a product / category** is its own list, like its printers: the
  names in order, "ללא" (none - an explicit stop) or "ירושה" (drop the own list and
  follow the category). The rule of app/services/menu.py `resolve_groups`.
* **Quick notes** are added to the targets the row names. A product or category's own
  chips replace what it inherits, so a target that only inherited gets its own list seeded
  with what it inherited before the new chip is added - adding "בלי בצל" to one burger
  never takes the burger category's chips off it (as the group editor's
  `_assign_to_categories` does for groups).
* **Pictures** - see app/services/catalog_images.py: fetched at commit, stored as the
  dashboard stores an upload, the same link never twice.
* **Menu prices** - "מחיר בתפריט: <menu>" sets `catalog_menu_products.price` (the price
  while that menu is active; VAT follows the product, as the menu editor's). A product not
  yet in the menu is added to its product list; "ללא" clears the price back to the
  catalog's (the product stays in the menu).
* **Permissions** - the menu editor's: a group is written by whoever covers its company
  (`menu.check_company_write`), a product's or category's lists by whoever may edit it
  (`menu.check_target_write`), a catalog menu by whoever may write it
  (`catalog_menus.check_menu_write`).

Every write bumps the organization's menu (or catalog-menu) sync state, so the tills'
next catalog pull carries it.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy.orm import Session

from app.models.catalog_menu import CatalogMenu, CatalogMenuCategory, CatalogMenuProduct
from app.models.menu import ModifierGroup, ModifierLink, ModifierOption, PrepNotePreset
from app.schemas.menu import validate_group_rules
from app.services import catalog_images as IMG
from app.services import catalog_menus as CM
from app.services import catalog_sheet as S
from app.services import menu as M
from app.services.catalog_plan import Change, Issue, row_issue

PRODUCTS = "products"
CATEGORIES = "categories"
GROUPS = "groups"
OPTIONS = "options"
NOTES = "notes"

_CENT = Decimal("0.01")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _chunks(items: Sequence[Any], size: int = 500) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _allowed(check: Callable, *args) -> bool:
    from fastapi import HTTPException

    try:
        check(*args)
        return True
    except HTTPException:
        return False


def _key(text: Any) -> str:
    return S.normalize_name(text)


def _money(value: Any) -> Optional[Decimal]:
    return Decimal(value).quantize(_CENT) if value is not None else None


# ── What there is ─────────────────────────────────────────────────────────────


@dataclass
class MenuContext:
    #: The groups the company's catalog sees, in their order.
    groups: List[ModifierGroup]
    #: Every group of the organization: id → name (to show a link to one this company
    #: does not see).
    all_group_names: Dict[str, str]
    #: group id → its options, in order.
    options: Dict[str, List[ModifierOption]]
    #: (target type, target id) → ("inherit" | "none" | "groups", group ids) - own links.
    links: Dict[Tuple[str, str], Tuple[str, List[str]]]
    #: (target type, target id) → its own note chips, in order.
    notes: Dict[Tuple[str, str], List[PrepNotePreset]]
    #: The company's own "every dish" chips, and the ones it gets from above (read only).
    all_notes: List[PrepNotePreset]
    shared_all_notes: List[PrepNotePreset]
    #: The catalog menus the company's catalog sees.
    menus: List[CatalogMenu]
    #: (menu id, product id) → its row.
    menu_products: Dict[Tuple[str, str], CatalogMenuProduct]
    #: menu id → {category id: all products}.
    menu_categories: Dict[str, Dict[str, bool]]
    #: The company, then the companies above it: company id → nearness (0 = its own).
    up_rank: Dict[str, int]
    group_top_sort: int = 0

    def __post_init__(self) -> None:
        self.group_by_id: Dict[str, ModifierGroup] = {str(g.id): g for g in self.groups}
        self.groups_by_name: Dict[str, List[ModifierGroup]] = defaultdict(list)
        for g in self.groups:
            self.groups_by_name[_key(g.name)].append(g)
        self.menus_by_name: Dict[str, List[CatalogMenu]] = defaultdict(list)
        for m in self.menus:
            self.menus_by_name[_key(m.name)].append(m)

    def rank(self, company_id) -> int:
        """How near a row's company is: its own 0, …, the organization's last."""
        if company_id is None:
            return len(self.up_rank) + 1
        return self.up_rank.get(str(company_id), len(self.up_rank))

    def find_group(self, name: str) -> Tuple[Optional[ModifierGroup], bool]:
        """(the group by that name the company sees - the nearest one, ambiguous)."""
        hits = self.groups_by_name.get(_key(name), [])
        if not hits:
            return None, False
        best = min(self.rank(g.company_id) for g in hits)
        top = [g for g in hits if self.rank(g.company_id) == best]
        return top[0], len(top) > 1

    def find_menu(self, name: str) -> Tuple[Optional[CatalogMenu], bool]:
        hits = self.menus_by_name.get(_key(name), [])
        if not hits:
            return None, False
        best = min(self.rank(m.company_id) for m in hits)
        top = [m for m in hits if self.rank(m.company_id) == best]
        return top[0], len(top) > 1


def _links_state(rows: List[ModifierLink]) -> Tuple[str, List[str]]:
    if not rows:
        return "inherit", []
    ids = [str(r.group_id) for r in rows if r.group_id is not None]
    return ("groups", ids) if ids else ("none", [])


def load_menu_context(db: Session, tenant_id, up_ids: Sequence, categories: Sequence, products: Sequence) -> MenuContext:
    up = [str(i) for i in up_ids]
    every = (
        db.query(ModifierGroup)
        .filter(ModifierGroup.tenant_id == tenant_id)
        .order_by(ModifierGroup.sort_order, ModifierGroup.name)
        .all()
    )
    groups = [g for g in every if g.company_id is None or str(g.company_id) in up]
    options: Dict[str, List[ModifierOption]] = defaultdict(list)
    for chunk in _chunks([g.id for g in groups]):
        for o in (
            db.query(ModifierOption)
            .filter(ModifierOption.group_id.in_(list(chunk)))
            .order_by(ModifierOption.sort_order, ModifierOption.name)
        ):
            options[str(o.group_id)].append(o)

    target_ids = [c.id for c in categories] + [p.id for p in products]
    link_rows: Dict[Tuple[str, str], List[ModifierLink]] = defaultdict(list)
    note_rows: Dict[Tuple[str, str], List[PrepNotePreset]] = defaultdict(list)
    for chunk in _chunks(target_ids):
        for link in (
            db.query(ModifierLink)
            .filter(ModifierLink.tenant_id == tenant_id, ModifierLink.target_id.in_(list(chunk)))
            .order_by(ModifierLink.sort_order)
        ):
            link_rows[(link.target_type, str(link.target_id))].append(link)
        for note in (
            db.query(PrepNotePreset)
            .filter(PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type.in_(("category", "product")),
                    PrepNotePreset.target_id.in_(list(chunk)))
            .order_by(PrepNotePreset.sort_order)
        ):
            note_rows[(note.target_type, str(note.target_id))].append(note)
    all_notes: List[PrepNotePreset] = []
    shared: List[PrepNotePreset] = []
    for note in (
        db.query(PrepNotePreset)
        .filter(PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type == "all")
        .order_by(PrepNotePreset.sort_order)
    ):
        if up and str(note.company_id) == up[0]:
            all_notes.append(note)
        elif note.company_id is None or str(note.company_id) in up:
            shared.append(note)

    menus: List[CatalogMenu] = []
    menu_products: Dict[Tuple[str, str], CatalogMenuProduct] = {}
    menu_categories: Dict[str, Dict[str, bool]] = defaultdict(dict)
    if CM.tables_ready(db):
        menus = [
            m for m in db.query(CatalogMenu)
            .filter(CatalogMenu.tenant_id == tenant_id)
            .order_by(CatalogMenu.sort_order, CatalogMenu.name)
            .all()
            if m.company_id is None or str(m.company_id) in up
        ]
        menu_ids = [m.id for m in menus]
        for chunk in _chunks(menu_ids):
            for row in db.query(CatalogMenuProduct).filter(CatalogMenuProduct.menu_id.in_(list(chunk))):
                menu_products[(str(row.menu_id), str(row.product_id))] = row
            for row in db.query(CatalogMenuCategory).filter(CatalogMenuCategory.menu_id.in_(list(chunk))):
                menu_categories[str(row.menu_id)][str(row.category_id)] = bool(row.all_products)

    return MenuContext(
        groups=groups,
        all_group_names={str(g.id): g.name for g in every},
        options=options,
        links={k: _links_state(v) for k, v in link_rows.items()},
        notes=dict(note_rows),
        all_notes=all_notes,
        shared_all_notes=shared,
        menus=menus,
        menu_products=menu_products,
        menu_categories=dict(menu_categories),
        up_rank={company: index for index, company in enumerate(up)},
        group_top_sort=max([g.sort_order or 0 for g in every] or [0]),
    )


# ── The plan ──────────────────────────────────────────────────────────────────


@dataclass
class _Row:
    row: Optional[int]
    action: str = "create"
    changes: List[Change] = field(default_factory=list)
    issues: List[Issue] = field(default_factory=list)

    @property
    def has_error(self) -> bool:
        return any(i.level == "error" for i in self.issues)


@dataclass
class GroupPlan(_Row):
    name: str = ""
    ref: str = ""
    existing: Optional[ModifierGroup] = None
    #: A new group: every field. An update: the changed ones (model attribute → value).
    values: Dict[str, Any] = field(default_factory=dict)


@dataclass
class OptionPlan(_Row):
    group_label: str = ""
    group_ref: Optional[str] = None
    name: str = ""
    existing: Optional[ModifierOption] = None
    price: Optional[Decimal] = None
    values: Dict[str, Any] = field(default_factory=dict)


@dataclass
class NotePlan(_Row):
    text: str = ""
    targets: List[str] = field(default_factory=list)
    #: The targets the chip is added to / whose chip changes, as labels.
    added: List[str] = field(default_factory=list)
    updated: List[str] = field(default_factory=list)


@dataclass
class LinkWrite:
    target_type: str
    target_ref: str
    mode: str  # inherit | none | groups
    group_refs: List[str]


@dataclass
class NoteItem:
    text: str
    important: bool
    sort: int
    #: The stored chip; None: created by this import (new, or seeded from the inherited).
    row: Optional[PrepNotePreset] = None
    seeded: bool = False
    dirty: bool = False
    #: From the organization / a company above (an "every dish" chip): never written here.
    shared: bool = False
    #: The sheet row that adds / changes it - a row refused on another target writes nothing.
    source: Optional["NotePlan"] = None

    @property
    def live(self) -> bool:
        return self.source is None or not self.source.has_error


@dataclass
class NoteWrite:
    target_type: str  # all | category | product
    target_ref: Optional[str]
    item: NoteItem


@dataclass
class MenuPriceWrite:
    menu: CatalogMenu
    product_ref: str
    existing: Optional[CatalogMenuProduct]
    price: Optional[Decimal]
    sort: int = 0


@dataclass
class ImageWrite:
    target_type: str  # category | product
    target_ref: str
    sheet: str
    row: Optional[int]
    name: str
    #: The link to download; None with `direct` (our own media) or for a removal.
    source: Optional[str] = None
    direct: Optional[str] = None
    remove: bool = False

    @property
    def job(self) -> Optional[IMG.Job]:
        if self.source is None:
            return None
        return IMG.Job("categories" if self.target_type == "category" else "products", self.source)


@dataclass
class MenuPlan:
    groups: List[GroupPlan] = field(default_factory=list)
    options: List[OptionPlan] = field(default_factory=list)
    notes: List[NotePlan] = field(default_factory=list)
    links: List[LinkWrite] = field(default_factory=list)
    note_writes: List[NoteWrite] = field(default_factory=list)
    menu_prices: List[MenuPriceWrite] = field(default_factory=list)
    images: List[ImageWrite] = field(default_factory=list)
    #: group ref → its display name (new and existing).
    group_names: Dict[str, str] = field(default_factory=dict)

    def rows(self) -> List[_Row]:
        return [*self.groups, *self.options, *self.notes]

    def fingerprint_items(self) -> List[Any]:
        items: List[Any] = []
        for g in self.groups:
            items.append(["g", g.row, g.ref, g.action, sorted([k, str(v)] for k, v in g.values.items())])
        for o in self.options:
            items.append(["o", o.row, o.group_ref, o.action, sorted([k, str(v)] for k, v in o.values.items())])
        for n in self.notes:
            items.append(["n", n.row, n.action, sorted(n.added), sorted(n.updated)])
        for link in self.links:
            items.append(["l", link.target_type, link.target_ref, link.mode, link.group_refs])
        for w in self.note_writes:
            items.append(["nw", w.target_type, w.target_ref, w.item.text, w.item.important, w.item.sort,
                          str(w.item.row.id) if w.item.row is not None else None])
        for w in self.menu_prices:
            items.append(["mp", str(w.menu.id), w.product_ref, str(w.price), w.existing is not None])
        for w in self.images:
            items.append(["img", w.target_type, w.target_ref, w.source, w.direct, w.remove])
        return items

    def preview_rows(self, status: Callable[[str, List[Issue]], str]) -> Dict[str, Any]:
        def messages(row: _Row) -> List[Dict[str, Any]]:
            return [i.out() for i in row.issues]

        groups = []
        for g in self.groups:
            kind = g.values.get("kind") or (g.existing.kind if g.existing is not None else None)
            groups.append({
                "row": g.row, "status": status(g.action, g.issues), "name": g.name,
                "kind": S.GROUP_KIND_LABELS.get(kind or "", ""),
                "groupId": str(g.existing.id) if g.existing is not None else None,
                "changes": [c.out() for c in g.changes], "messages": messages(g),
            })
        options = []
        for o in self.options:
            options.append({
                "row": o.row, "status": status(o.action, o.issues), "group": o.group_label, "name": o.name,
                "price": f"{o.price:.2f}" if o.price is not None else None,
                "changes": [c.out() for c in o.changes], "messages": messages(o),
            })
        notes = []
        for n in self.notes:
            notes.append({
                "row": n.row, "status": status(n.action, n.issues), "text": n.text,
                "targets": ", ".join(n.targets), "changes": [c.out() for c in n.changes], "messages": messages(n),
            })
        return {"groups": groups, "options": options, "notes": notes}


#: app/schemas/menu.py `validate_group_rules` in the sheet's words.
_RULES_HE = {
    "minSelect cannot be more than maxSelect": "המינימום גדול מהמקסימום",
    "freeCount cannot be more than maxSelect": "'כמה בחינם' גדול מהמקסימום",
    "a required group needs at least one active option": "קבוצת חובה צריכה לפחות אפשרות פעילה אחת (בגיליון 'אפשרויות')",
    "minSelect is more than there are options to choose":
        "המינימום גדול ממספר האפשרויות הפעילות (או אפשרו 'כמות לאפשרות')",
    "more defaults than maxSelect allows": "יותר אפשרויות 'מסומנות מראש' ממה שמותר לבחור",
    "a removal group takes no quantities or pre-modifiers":
        "בקבוצת 'הסרה' אין 'כמות לאפשרות' ואין 'מעט / הרבה / בצד'",
    "two options with the same name": "שתי אפשרויות באותו שם",
    "an option's maxQty above 1 needs allowQuantity": "'מקסימום לאפשרות' מעל 1 דורש 'כמות לאפשרות' = כן בקבוצה",
    "an option's maxQty cannot be more than the group's maxSelect": "'מקסימום לאפשרות' גדול מהמקסימום של הקבוצה",
}

_GROUP_LABELS = {
    "name": "שם", "kind": "סוג", "min_select": "מינימום בחירות", "max_select": "מקסימום בחירות",
    "free_count": "כמה בחינם", "allow_quantity": "כמות לאפשרות", "allow_pre": "מעט / הרבה / בצד",
    "sort_order": "סדר", "is_active": "פעילה",
}
_OPTION_LABELS = {
    "name": "שם", "kitchen_name": "שם למטבח", "price": "מחיר", "is_default": "מסומנת מראש",
    "max_qty": "מקסימום לאפשרות", "sort_order": "סדר", "is_active": "פעילה",
}


def _shown(attr: str, value: Any) -> Any:
    if attr == "kind":
        return S.GROUP_KIND_LABELS.get(value or "", value or "")
    if attr in ("max_select", "max_qty") and value is None:
        return S.LIMIT_NONE
    if attr == "price":
        return _money(value)
    return value


# ── Planning ──────────────────────────────────────────────────────────────────


class MenuPlanner:
    def __init__(self, planner):
        #: catalog_import._Planner: the file, the context, its category and product rows.
        self.p = planner
        self.ctx = planner.ctx
        self.mc: MenuContext = planner.ctx.menu
        self.out = MenuPlan()
        #: Group sheet rows by name key (errors too: a reference to one is refused with it).
        self.file_groups: Dict[str, GroupPlan] = {}
        #: Names on rows marked "דוגמה" in the groups sheet.
        self.example_groups: Set[str] = set()
        self._may_cache: Dict[Tuple[str, str], bool] = {}

    # ── helpers ──

    def _issue(self, row: _Row, level: str, sheet: str, message: str) -> None:
        row.issues.append(row_issue(level, sheet, row.row, message))
        if level == "error":
            row.action = "error"

    def _may_write_company(self, company_id) -> bool:
        key = ("company", str(company_id))
        if key not in self._may_cache:
            user = self.ctx.user
            self._may_cache[key] = user is not None and M.may_write_company(self.ctx.db, user, self.ctx.tenant_id, company_id)
        return self._may_cache[key]

    def _may_write_menu(self, menu: CatalogMenu) -> bool:
        key = ("menu", str(menu.id))
        if key not in self._may_cache:
            user = self.ctx.user
            self._may_cache[key] = user is not None and _allowed(
                CM.check_menu_write, self.ctx.db, user, self.ctx.tenant_id, menu.company_id)
        return self._may_cache[key]

    def _may_target(self, target) -> bool:
        key = ("target", str(target.id))
        if key not in self._may_cache:
            user = self.ctx.user
            self._may_cache[key] = user is not None and _allowed(M.check_target_write, self.ctx.db, user, target)
        return self._may_cache[key]

    def _may_edit_row(self, target_type: str, existing) -> bool:
        """The products / categories rule for the row itself (a picture is the row's)."""
        from app.services import catalog_import as I

        key = (f"edit-{target_type}", str(existing.id))
        if key not in self._may_cache:
            check = I.may_edit_product if target_type == "product" else I.may_edit_category
            self._may_cache[key] = check(self.ctx.db, self.ctx.user, existing)
        return self._may_cache[key]

    def group_name(self, ref: str) -> str:
        if ref in self.out.group_names:
            return self.out.group_names[ref]
        if ref.startswith("gid:"):
            return self.mc.all_group_names.get(ref[4:], "")
        return ""

    def resolve_group(self, name: str, *, strict: bool = True) -> Tuple[Optional[str], Optional[str]]:
        """
        A group named in a cell → (ref, error message). A group whose row in the groups
        sheet is refused is refused here too - unless not `strict` and it exists already:
        a product may still be given the group as it is.
        """
        key = _key(name)
        plan = self.file_groups.get(key)
        group, ambiguous = self.mc.find_group(name)
        if plan is not None:
            if plan.has_error or not plan.ref:
                if not strict and group is not None and not ambiguous:
                    ref = f"gid:{group.id}"
                    self.out.group_names[ref] = group.name
                    return ref, None
                return None, f"הקבוצה '{name}' שגויה בגיליון '{S.SHEET_GROUPS}' (שורה {plan.row})"
            return plan.ref, None
        if group is not None:
            if ambiguous:
                return None, f"יש כמה קבוצות תוספות בשם '{name}' - שנו את השם של אחת מהן במסך 'תוספות ושינויים'"
            ref = f"gid:{group.id}"
            self.out.group_names[ref] = group.name
            return ref, None
        if key in self.example_groups:
            return None, (f"הקבוצה '{name}' מופיעה רק בשורת דוגמה בגיליון '{S.SHEET_GROUPS}' - מחקו את "
                          f"'{S.EXAMPLE_MARK}' בעמודה 'סימון' כדי שתיקלט")
        return None, f"קבוצת התוספות '{name}' לא קיימת - הוסיפו אותה בגיליון '{S.SHEET_GROUPS}'"

    # ── the whole ──

    def plan(self) -> MenuPlan:
        self._plan_groups()
        self._plan_options()
        self._validate_groups()
        self._finish_groups()
        self._plan_links()
        self._plan_images()
        self._plan_menu_prices()
        self._plan_notes()
        self._prune()
        return self.out

    def _prune(self) -> None:
        """A row refused by a later step (a picture, a menu price) writes none of its links etc."""
        refused = {c.ref for c in self.p.categories if c.has_error and c.ref} | \
                  {pp.ref for pp in self.p.products if pp.has_error}
        if not refused:
            return
        self.out.links = [w for w in self.out.links if w.target_ref not in refused]
        self.out.images = [w for w in self.out.images if w.target_ref not in refused]
        self.out.menu_prices = [w for w in self.out.menu_prices if w.product_ref not in refused]

    # ── groups ──

    def _plan_groups(self) -> None:
        sheet = self.p.raw.groups
        if sheet is None:
            return
        top = self.mc.group_top_sort
        for raw_row in sheet.rows:
            cells = raw_row.cells
            if S.is_marked(cells.get("marker")):
                self.p.examples += 1
                name = S.clean_text(cells.get("name"))
                if name:
                    self.example_groups.add(_key(name))
                continue
            plan = GroupPlan(row=raw_row.number)
            self.out.groups.append(plan)
            err = lambda message: self._issue(plan, "error", GROUPS, message)  # noqa: E731
            parsed = {
                "name": S.parse_text(cells.get("name"), "שם הקבוצה", S.GROUP_NAME_MAX),
                "kind": S.parse_kind(cells.get("kind")),
                "required": S.parse_bool(cells.get("required"), "חובה"),
                "min": S.parse_int(cells.get("min"), "מינימום בחירות", 0, S.SELECT_MAX),
                "max": S.parse_limit(cells.get("max"), "מקסימום בחירות", 1, S.SELECT_MAX),
                "free": S.parse_int(cells.get("free"), "כמה בחינם", 0, S.SELECT_MAX),
                "allow_quantity": S.parse_bool(cells.get("allow_quantity"), "כמות לאפשרות"),
                "allow_pre": S.parse_bool(cells.get("allow_pre"), "מעט / הרבה / בצד"),
                "sort": S.parse_int(cells.get("sort"), "סדר", S.SORT_MIN, S.SORT_MAX),
                "active": S.parse_bool(cells.get("active"), "פעילה"),
            }
            for value in parsed.values():
                if value.error:
                    err(value.error)
            v = {k: x.value for k, x in parsed.items()}
            plan.name = v["name"] or S.clean_text(cells.get("name"))
            if not plan.name:
                err("חסר שם קבוצה")
                continue
            key = _key(plan.name)
            if key in self.file_groups:
                err(f"הקבוצה '{plan.name}' מופיעה גם בשורה {self.file_groups[key].row}")
                continue
            self.file_groups[key] = plan
            required, minimum = v["required"], v["min"]
            if required is True and minimum == 0:
                err("'חובה' = כן דורש 'מינימום בחירות' 1 לפחות")
            if required is False and minimum:
                err("'מינימום בחירות' מעל 0 הופך את הקבוצה לחובה - כתבו 'חובה' = כן, או מחקו את המינימום")
            existing, ambiguous = self.mc.find_group(plan.name)
            if ambiguous:
                err(f"יש כמה קבוצות תוספות בשם '{plan.name}' - שנו את השם של אחת מהן במסך 'תוספות ושינויים'")
            if existing is None and "," in plan.name:
                err("שם קבוצה לא יכול לכלול פסיק (הפסיק מפריד בין קבוצות בעמודה 'קבוצות תוספות')")
            if plan.has_error:
                continue
            maximum = v["max"]
            if existing is None:
                if v["sort"] is None:
                    top += 1
                plan.ref = f"gnew:{key}"
                plan.values = {
                    "name": plan.name,
                    "kind": v["kind"] or "addon",
                    "min_select": minimum if minimum is not None else (1 if required else 0),
                    "max_select": maximum if isinstance(maximum, int) else None,
                    "free_count": v["free"] or 0,
                    "allow_quantity": bool(v["allow_quantity"]),
                    "allow_pre": bool(v["allow_pre"]),
                    "sort_order": v["sort"] if v["sort"] is not None else top,
                    "is_active": True if v["active"] is None else bool(v["active"]),
                }
                plan.action = "create"
                if not self._may_write_company(self.ctx.company.id):
                    err("אין לך הרשאה ליצור קבוצות תוספות בחברה")
            else:
                g = existing
                plan.existing, plan.ref = g, f"gid:{g.id}"
                current_min = g.min_select or 0
                if minimum is not None:
                    wanted_min = minimum
                elif required is True:
                    wanted_min = current_min if current_min >= 1 else 1
                elif required is False:
                    wanted_min = 0
                else:
                    wanted_min = None
                wanted = {
                    "name": plan.name if plan.name != S.clean_text(g.name) else None,
                    "kind": v["kind"],
                    "min_select": wanted_min,
                    "max_select": (None if maximum == "" else maximum) if maximum is not None else _KEEP,
                    "free_count": v["free"],
                    "allow_quantity": v["allow_quantity"],
                    "allow_pre": v["allow_pre"],
                    "sort_order": v["sort"],
                    "is_active": v["active"],
                }
                for attr, new in wanted.items():
                    if new is _KEEP or (new is None and attr != "max_select"):
                        continue
                    current = getattr(g, attr)
                    if attr in ("allow_quantity", "allow_pre", "is_active"):
                        current = bool(current)
                    elif attr in ("min_select", "free_count", "sort_order"):
                        current = current or 0
                    if new == current:
                        continue
                    plan.values[attr] = new
                    plan.changes.append(Change(attr, _GROUP_LABELS[attr], _shown(attr, current), _shown(attr, new)))
                plan.action = "update" if plan.changes else "unchanged"
                if plan.changes and not self._may_write_company(g.company_id):
                    err(f"אין לך הרשאה לעדכן את הקבוצה '{g.name}'")
            self.out.group_names[plan.ref] = plan.name

    # ── options ──

    def _plan_options(self) -> None:
        sheet = self.p.raw.options
        if sheet is None:
            return
        seen: Dict[Tuple[str, str], int] = {}
        next_sort: Dict[str, int] = {}
        for raw_row in sheet.rows:
            cells = raw_row.cells
            if S.is_marked(cells.get("marker")):
                self.p.examples += 1
                continue
            plan = OptionPlan(row=raw_row.number)
            self.out.options.append(plan)
            err = lambda message: self._issue(plan, "error", OPTIONS, message)  # noqa: E731
            warn = lambda message: self._issue(plan, "warning", OPTIONS, message)  # noqa: E731
            parsed = {
                "group": S.parse_text(cells.get("group"), "הקבוצה", S.GROUP_NAME_MAX),
                "name": S.parse_text(cells.get("name"), "שם האפשרות", S.OPTION_NAME_MAX),
                "price": S.parse_money(cells.get("price"), "מחיר", S.OPTION_PRICE_MAX, S.OPTION_PRICE_MIN),
                "kitchen_name": S.parse_clearable_text(cells.get("kitchen_name"), "שם למטבח", S.KITCHEN_NAME_MAX),
                "default": S.parse_bool(cells.get("default"), "מסומנת מראש"),
                "max_qty": S.parse_limit(cells.get("max_qty"), "מקסימום לאפשרות", 1, S.SELECT_MAX),
                "sort": S.parse_int(cells.get("sort"), "סדר", S.SORT_MIN, S.SORT_MAX),
                "active": S.parse_bool(cells.get("active"), "פעילה"),
            }
            for value in parsed.values():
                if value.error:
                    err(value.error)
                elif value.warning:
                    warn(value.warning)
            v = {k: x.value for k, x in parsed.items()}
            plan.name = v["name"] or S.clean_text(cells.get("name"))
            plan.group_label = v["group"] or S.clean_text(cells.get("group"))
            plan.price = v["price"]
            if not plan.group_label:
                err("חסרה קבוצה")
            if not plan.name:
                err("חסר שם אפשרות")
            if plan.has_error:
                continue
            ref, problem = self.resolve_group(plan.group_label)
            if problem:
                err(problem)
                continue
            plan.group_ref = ref
            plan.group_label = self.group_name(ref) or plan.group_label
            key = (ref, _key(plan.name))
            if key in seen:
                err(f"האפשרות '{plan.name}' מופיעה גם בשורה {seen[key]} באותה קבוצה")
                continue
            seen[key] = plan.row or 0
            group = self.mc.group_by_id.get(ref[4:]) if ref.startswith("gid:") else None
            existing_options = self.mc.options.get(str(group.id), []) if group is not None else []
            match = next((o for o in existing_options if _key(o.name) == _key(plan.name)), None)
            maximum = v["max_qty"]
            if match is None:
                if ref not in next_sort:
                    next_sort[ref] = max([o.sort_order or 0 for o in existing_options] or [-1]) + 1
                sort = v["sort"]
                if sort is None:
                    sort = next_sort[ref]
                    next_sort[ref] += 1
                plan.values = {
                    "name": plan.name,
                    "kitchen_name": v["kitchen_name"] or None,
                    "price": v["price"] if v["price"] is not None else Decimal("0.00"),
                    "is_default": bool(v["default"]),
                    "max_qty": maximum if isinstance(maximum, int) else None,
                    "sort_order": sort,
                    "is_active": True if v["active"] is None else bool(v["active"]),
                }
                plan.price = plan.values["price"]
                plan.action = "create"
            else:
                plan.existing = match
                if plan.price is None:
                    plan.price = _money(match.price)
                wanted = {
                    "name": plan.name if plan.name != S.clean_text(match.name) else None,
                    "kitchen_name": (v["kitchen_name"] or None) if v["kitchen_name"] is not None else _KEEP,
                    "price": v["price"],
                    "is_default": v["default"],
                    "max_qty": (None if maximum == "" else maximum) if maximum is not None else _KEEP,
                    "sort_order": v["sort"],
                    "is_active": v["active"],
                }
                for attr, new in wanted.items():
                    if new is _KEEP or (new is None and attr not in ("kitchen_name", "max_qty")):
                        continue
                    current = getattr(match, attr)
                    if attr == "price":
                        current = _money(current)
                    elif attr in ("is_default", "is_active"):
                        current = bool(current)
                    elif attr == "sort_order":
                        current = current or 0
                    if new == current:
                        continue
                    plan.values[attr] = new
                    plan.changes.append(Change(attr, _OPTION_LABELS[attr], _shown(attr, current), _shown(attr, new)))
                plan.action = "update" if plan.changes else "unchanged"
            if plan.action != "unchanged" and group is not None and not self._may_write_company(group.company_id):
                err(f"אין לך הרשאה לעדכן את הקבוצה '{group.name}'")

    # ── the groups as they will be ──

    def _validate_groups(self) -> None:
        group_plans = {g.ref: g for g in self.out.groups if g.ref and not g.has_error}
        option_plans: Dict[str, List[OptionPlan]] = defaultdict(list)
        for o in self.out.options:
            if o.group_ref and not o.has_error:
                option_plans[o.group_ref].append(o)
        touched = [ref for ref in dict.fromkeys([*group_plans, *option_plans])]
        for ref in touched:
            gp = group_plans.get(ref)
            ops = option_plans.get(ref, [])
            if (gp is None or gp.action == "unchanged") and all(o.action == "unchanged" for o in ops):
                continue
            existing = self.mc.group_by_id.get(ref[4:]) if ref.startswith("gid:") else None
            fields = {attr: getattr(existing, attr) if existing is not None else None
                      for attr in ("kind", "min_select", "max_select", "free_count", "allow_quantity", "allow_pre")}
            if gp is not None:
                fields.update({k: v for k, v in gp.values.items() if k in fields})
            by_id = {str(o.existing.id): o for o in ops if o.existing is not None}
            final_options = []
            for o in (self.mc.options.get(ref[4:], []) if existing is not None else []):
                plan = by_id.get(str(o.id))
                values = {"name": o.name, "is_active": bool(o.is_active), "is_default": bool(o.is_default),
                          "max_qty": o.max_qty}
                if plan is not None:
                    values.update({k: v for k, v in plan.values.items() if k in values})
                final_options.append(SimpleNamespace(**values))
            for o in ops:
                if o.existing is None:
                    final_options.append(SimpleNamespace(
                        name=o.values["name"], is_active=o.values["is_active"], is_default=o.values["is_default"],
                        max_qty=o.values["max_qty"]))
            group = SimpleNamespace(
                kind=fields["kind"] or "addon", min_select=fields["min_select"] or 0, max_select=fields["max_select"],
                free_count=fields["free_count"] or 0, allow_quantity=bool(fields["allow_quantity"]),
                allow_pre=bool(fields["allow_pre"]), options=final_options,
            )
            problem = None
            if len(final_options) > S.OPTIONS_MAX:
                problem = f"בקבוצה יותר מ-{S.OPTIONS_MAX} אפשרויות"
            else:
                try:
                    validate_group_rules(group)
                except ValueError as exc:
                    problem = _RULES_HE.get(str(exc), "הגדרות הקבוצה לא מסתדרות זו עם זו")
            if problem is None:
                continue
            name = self.group_name(ref)
            if gp is not None:
                self._issue(gp, "error", GROUPS, f"הקבוצה '{name}' לא תקינה: {problem}")
                for o in ops:
                    self._issue(o, "error", OPTIONS,
                                f"הקבוצה '{name}' לא תקינה (שורה {gp.row} בגיליון '{S.SHEET_GROUPS}')")
            else:
                for o in ops:
                    self._issue(o, "error", OPTIONS, f"הקבוצה '{name}' לא תקינה: {problem}")

    def _finish_groups(self) -> None:
        for plan in [*self.out.groups, *self.out.options]:
            if plan.has_error:
                plan.action = "error"

    # ── which groups a product / category gets ──

    def _links_text(self, mode: str, refs: List[str], target_type: str) -> str:
        if mode == "inherit":
            return "לפי המחלקה" if target_type == "product" else "לפי מחלקת האב"
        if mode == "none":
            return S.GROUPS_NONE
        return ", ".join(self.group_name(r) for r in refs)

    def _plan_links(self) -> None:
        for c in self.p.categories:
            if c.row is not None and not c.has_error and c.groups_spec is not None:
                self._link(c, "category", c.ref, c.existing, CATEGORIES)
        for pp in self.p.products:
            if not pp.has_error and pp.groups_spec is not None:
                self._link(pp, "product", pp.ref, pp.existing, PRODUCTS)

    def _link(self, plan, target_type: str, ref: str, existing, sheet: str) -> None:
        spec: S.RoutingSpec = plan.groups_spec
        before = self.mc.links.get((target_type, str(existing.id)), ("inherit", [])) if existing is not None \
            else ("inherit", [])
        before_refs = [f"gid:{i}" for i in before[1]]
        if spec.mode in ("inherit", "none"):
            after_mode, after_refs = spec.mode, []
        else:
            after_mode, after_refs = "groups", []
            for name in spec.names:
                group_ref, problem = self.resolve_group(name, strict=False)
                if problem:
                    plan.issues.append(row_issue("error", sheet, plan.row, problem))
                    plan.action = "error"
                elif group_ref not in after_refs:
                    after_refs.append(group_ref)
            if plan.has_error:
                return
        if (after_mode, after_refs) == (before[0], before_refs):
            return
        if existing is not None and not self._may_target(existing):
            plan.issues.append(row_issue("error", sheet, plan.row,
                                         f"אין לך הרשאה לשנות את קבוצות התוספות של '{existing.name}'"))
            plan.action = "error"
            return
        self.out.links.append(LinkWrite(target_type, ref, after_mode, after_refs))
        plan.changes.append(Change("groups", "קבוצות תוספות", self._links_text(before[0], before_refs, target_type),
                                   self._links_text(after_mode, after_refs, target_type)))
        if plan.action == "unchanged":
            plan.action = "update"

    # ── pictures ──

    def _plan_images(self) -> None:
        downloads = 0
        targets = [("category", c, CATEGORIES) for c in self.p.categories if c.row is not None] + \
                  [("product", pp, PRODUCTS) for pp in self.p.products]
        for target_type, plan, sheet in targets:
            if plan.has_error or plan.image_spec is None:
                continue
            existing = plan.existing
            current = existing.image_url if existing is not None else None
            spec = plan.image_spec
            write = ImageWrite(target_type, plan.ref, sheet, plan.row, plan.name)
            if spec == "":
                if not current:
                    continue
                write.remove = True
                change = Change("image", "תמונה", "יש תמונה", S.CLEAR_WORD)
            else:
                if current and (spec == current or IMG.came_from(current, spec)):
                    continue
                if IMG.is_own_media(spec):
                    write.direct = spec
                    change = Change("image", "תמונה", "יש תמונה" if current else "", IMG.short(spec))
                else:
                    downloads += 1
                    if downloads > IMG.MAX_PER_IMPORT:
                        plan.issues.append(row_issue(
                            "warning", sheet, plan.row,
                            f"יותר מ-{IMG.MAX_PER_IMPORT} תמונות חדשות בקובץ - התמונה הזו תיקלט בייבוא הבא של אותו קובץ"))
                        continue
                    write.source = spec
                    change = Change("image", "תמונה", "יש תמונה" if current else "", f"תורד מ-{IMG.short(spec)}")
            if existing is not None and not self._may_edit_row(target_type, existing):
                plan.issues.append(row_issue("error", sheet, plan.row, f"אין לך הרשאה לעדכן את '{existing.name}'"))
                plan.action = "error"
                continue
            self.out.images.append(write)
            plan.changes.append(change)
            if plan.action == "unchanged":
                plan.action = "update"

    # ── menu prices ──

    def _plan_menu_prices(self) -> None:
        keys = sorted({k for pp in self.p.products for k in pp.menu_prices})
        if not keys:
            return
        menus: Dict[str, CatalogMenu] = {}
        header_of = (self.p.raw.products.headers if self.p.raw.products is not None else {})
        for key in keys:
            name = key[5:]
            menu, ambiguous = self.mc.find_menu(name)
            header = header_of.get(key, f"{S.MENU_PRICE_PREFIX}: {name}")
            if menu is None:
                self.p.issues.append(Issue("warning", f"העמודה '{header}': אין תפריט בשם '{name}' - העמודה תידלג"))
            elif ambiguous:
                self.p.issues.append(Issue("warning", f"העמודה '{header}': יש כמה תפריטים בשם '{name}' - העמודה תידלג"))
            else:
                menus[key] = menu
        next_sort: Dict[str, int] = {}
        for pp in self.p.products:
            if pp.has_error:
                continue
            for key, value in pp.menu_prices.items():
                menu = menus.get(key)
                if menu is None:
                    continue
                menu_id = str(menu.id)
                row = self.mc.menu_products.get((menu_id, str(pp.existing.id))) if pp.existing is not None else None
                label = f"מחיר בתפריט '{menu.name}'"
                if value == "":
                    if row is None or row.price is None:
                        continue
                    write = MenuPriceWrite(menu, pp.ref, row, None, row.sort_order or 0)
                    change = Change("menu_price", label, _money(row.price), "מחיר הקטלוג")
                else:
                    if row is not None and row.price is not None and _money(row.price) == value:
                        continue
                    if row is None:
                        if menu_id not in next_sort:
                            next_sort[menu_id] = max([r.sort_order or 0 for (m, _), r in self.mc.menu_products.items()
                                                      if m == menu_id] or [-1]) + 1
                        write = MenuPriceWrite(menu, pp.ref, None, value, next_sort[menu_id])
                        next_sort[menu_id] += 1
                        change = Change("menu_price", label, "לא בתפריט", value)
                        self._menu_visibility_note(pp, menu)
                    else:
                        write = MenuPriceWrite(menu, pp.ref, row, value, row.sort_order or 0)
                        change = Change("menu_price", label, _money(row.price) if row.price is not None else "מחיר הקטלוג",
                                        value)
                if not self._may_write_menu(menu):
                    pp.issues.append(row_issue("error", PRODUCTS, pp.row, f"אין לך הרשאה לשנות את התפריט '{menu.name}'"))
                    pp.action = "error"
                    break
                self.out.menu_prices.append(write)
                pp.changes.append(change)
                if pp.action == "unchanged":
                    pp.action = "update"
            if pp.has_error:
                # A refused row writes none of its menu prices.
                self.out.menu_prices = [w for w in self.out.menu_prices if w.product_ref != pp.ref]

    def _menu_visibility_note(self, pp, menu: CatalogMenu) -> None:
        category_ref = pp.category_ref or (f"id:{pp.existing.category_id}" if pp.existing is not None else None)
        shown = self.mc.menu_categories.get(str(menu.id), {})
        all_products = shown.get(category_ref[3:]) if category_ref and category_ref.startswith("id:") else None
        if all_products is True:
            message = f"הפריט יתווסף לרשימת הפריטים של התפריט '{menu.name}' עם המחיר הזה"
            level = "info"
        elif all_products is False:
            message = f"הפריט יתווסף לתפריט '{menu.name}' (במחלקה שלו מוצגים בתפריט רק פריטים נבחרים)"
            level = "warning"
        else:
            message = f"הפריט יתווסף לתפריט '{menu.name}' וימכר בו גם אם המחלקה שלו לא בתפריט"
            level = "warning"
        pp.issues.append(row_issue(level, PRODUCTS, pp.row, message))

    # ── quick notes ──

    def _find_category(self, text: str) -> Tuple[Optional[str], str, Optional[str]]:
        """A category named in a notes cell → (ref, label, error). Never made here."""
        from app.services import catalog_import as I

        parent_key, name_key = I._split_path(text)
        in_file = [
            c for c in self.p.file_categories.get(name_key, [])
            if parent_key is None or self.p._file_parent_key(c) == parent_key
        ]
        good = [c for c in in_file if not c.has_error and c.ref]
        if len(good) == 1:
            return good[0].ref, good[0].name, None
        if len(good) > 1:
            return None, text, f"יש כמה מחלקות בשם '{text}' בגיליון המחלקות - כתבו 'מחלקת אב > {text}'"
        found, ambiguous = self.p.index.find(text)
        if found is not None:
            if ambiguous:
                return None, text, f"יש כמה מחלקות בשם '{text}' - כתבו למשל '{self.ctx.labels[str(found.id)]}'"
            return f"id:{found.id}", self.ctx.labels[str(found.id)], None
        implicit = self.p.by_ref.get(I._new_ref(text))
        if implicit is not None and not implicit.has_error:
            return implicit.ref, implicit.name, None
        if in_file:
            return None, text, f"המחלקה '{text}' שגויה בגיליון המחלקות (שורה {in_file[0].row})"
        return None, text, f"המחלקה '{text}' לא נמצאה - לא בגיליון '{S.SHEET_CATEGORIES}' ולא במערכת"

    def _product_index(self) -> None:
        if hasattr(self, "_by_name"):
            return
        self._by_name: Dict[str, List[Any]] = defaultdict(list)
        self._by_sku: Dict[str, Any] = {}
        self._by_barcode: Dict[str, List[Any]] = defaultdict(list)
        for product in self.ctx.products:
            self._by_name[_key(product.name)].append(product)
            if product.sku:
                self._by_sku[product.sku] = product
            if product.barcode:
                self._by_barcode[product.barcode.replace(" ", "")].append(product)

    def _find_product(self, text: str) -> Tuple[Optional[str], str, Optional[str], Any]:
        """A product named in a notes cell → (ref, label, error, the stored product or None)."""
        self._product_index()
        key = _key(text)
        code = text.replace(" ", "")
        in_file = [pp for pp in self.p.products if not pp.has_error and pp.action != "error" and (
            _key(pp.name) == key or (pp.sku and pp.sku == text) or (pp.barcode and pp.barcode == code))]
        refs = list(dict.fromkeys(pp.ref for pp in in_file))
        if len(refs) == 1:
            return refs[0], in_file[0].name, None, in_file[0].existing
        if len(refs) > 1:
            return None, text, f"יש כמה פריטים בשם '{text}' - כתבו את המק״ט במקום השם", None
        hit = self._by_sku.get(text)
        if hit is None:
            by_code = self._by_barcode.get(code, [])
            hit = by_code[0] if len(by_code) == 1 else None
        if hit is None:
            named = self._by_name.get(key, [])
            if len(named) > 1:
                return None, text, f"יש כמה פריטים בשם '{text}' - כתבו את המק״ט במקום השם", None
            hit = named[0] if named else None
        if hit is None:
            return None, text, f"הפריט '{text}' לא נמצא - לא בגיליון '{S.SHEET_PRODUCTS}' ולא במערכת", None
        return f"id:{hit.id}", hit.name, None, hit

    def _category_depth(self, ref: str) -> int:
        depth, current, seen = 0, self.p._parent_of(ref), {ref}
        while current is not None and current not in seen and depth < 60:
            seen.add(current)
            depth += 1
            current = self.p._parent_of(current)
        return depth

    def _plan_notes(self) -> None:
        sheet = self.p.raw.quick_notes
        if sheet is None:
            return
        #: (processing order, the row, (target type, ref, label, stored row), its cells).
        pending: List[Tuple[Tuple[int, int], NotePlan, Tuple[str, Optional[str], str, Any], Dict[str, Any]]] = []
        seen: Dict[Tuple[str, Optional[str], str], int] = {}
        for raw_row in sheet.rows:
            cells = raw_row.cells
            if S.is_marked(cells.get("marker")):
                self.p.examples += 1
                continue
            plan = NotePlan(row=raw_row.number)
            self.out.notes.append(plan)
            err = lambda message: self._issue(plan, "error", NOTES, message)  # noqa: E731
            parsed = {
                "text": S.parse_text(cells.get("name"), "ההערה", S.NOTE_TEXT_MAX),
                "all": S.parse_bool(cells.get("all"), "לכל המנות"),
                "categories": S.parse_names(cells.get("categories"), "מחלקות"),
                "products": S.parse_names(cells.get("products"), "פריטים"),
                "important": S.parse_bool(cells.get("important"), "חשובה"),
                "sort": S.parse_int(cells.get("sort"), "סדר", S.SORT_MIN, S.SORT_MAX),
            }
            for value in parsed.values():
                if value.error:
                    err(value.error)
            v = {k: x.value for k, x in parsed.items()}
            plan.text = v["text"] or S.clean_text(cells.get("name"))
            if not plan.text:
                err("חסר טקסט הערה")
            targets: List[Tuple[str, Optional[str], str, Any]] = []
            if v["all"]:
                targets.append(("all", None, "כל המנות", None))
            for name in v["categories"] or ():
                ref, label, problem = self._find_category(name)
                if problem:
                    err(problem)
                else:
                    stored = self.ctx.category_by_id.get(ref[3:]) if ref.startswith("id:") else None
                    targets.append(("category", ref, label, stored))
            for name in v["products"] or ():
                ref, label, problem, stored = self._find_product(name)
                if problem:
                    err(problem)
                else:
                    targets.append(("product", ref, label, stored))
            if not targets and not plan.has_error:
                err("ציינו על אילו מחלקות או פריטים ההערה חלה, או כתבו 'כן' בעמודה 'לכל המנות'")
            if plan.has_error:
                continue
            # One target named twice in a row (a name and its barcode) is one target.
            unique: Dict[Tuple[str, Optional[str]], Tuple[str, Optional[str], str, Any]] = {}
            for target in targets:
                unique.setdefault((target[0], target[1]), target)
            targets = list(unique.values())
            for target_type, ref, label, _stored in targets:
                dup = (target_type, ref, _key(plan.text))
                if dup in seen:
                    err(f"ההערה '{plan.text}' ל'{label}' מופיעה גם בשורה {seen[dup]}")
                seen[dup] = plan.row or 0
            if plan.has_error:
                continue
            plan.targets = [label for _t, _r, label, _s in targets]
            for target_type, ref, label, stored in targets:
                order = (0, 0) if target_type == "all" else (
                    (1, self._category_depth(ref)) if target_type == "category" else (2, 0))
                pending.append((order, plan, (target_type, ref, label, stored), v))
        self._final: Dict[Tuple[str, Optional[str]], List[NoteItem]] = {}
        self._seed_from: Dict[Tuple[str, Optional[str]], str] = {}
        self._seed_told: Set[Tuple[str, Optional[str]]] = set()
        for _order, plan, target, v in sorted(pending, key=lambda x: (x[0], x[1].row or 0)):
            self._note(plan, target, v)
        for plan in self.out.notes:
            if plan.has_error:
                plan.action = "error"
                continue
            plan.action = "create" if plan.added else ("update" if plan.updated else "unchanged")
            if plan.added:
                plan.changes.insert(0, Change("targets", "נוספת ל", "", ", ".join(plan.added)))
        for (target_type, ref), items in self._final.items():
            if not any(((i.row is None and not i.seeded) or i.dirty) and i.source is not None and i.live
                       for i in items):
                continue
            for item in items:
                if item.shared:
                    continue
                # The seeded ones go with the target's first own chip, whoever touched them.
                if item.seeded or ((item.row is None or item.dirty) and item.live):
                    self.out.note_writes.append(NoteWrite(target_type, ref, item))

    def _own_items(self, target_type: str, ref: Optional[str]) -> Optional[List[NoteItem]]:
        """A target's own chips as they are (None: it has none of its own)."""
        if target_type == "all":
            return [NoteItem(n.text, bool(n.is_important), n.sort_order or 0, row=n) for n in self.mc.all_notes] + \
                [NoteItem(n.text, bool(n.is_important), n.sort_order or 0, row=n, shared=True)
                 for n in self.mc.shared_all_notes]
        if ref is None or not ref.startswith("id:"):
            return None
        own = self.mc.notes.get((target_type, ref[3:]))
        if not own:
            return None
        return [NoteItem(n.text, bool(n.is_important), n.sort_order or 0, row=n) for n in own]

    def _category_of(self, product_ref: str) -> Optional[str]:
        for pp in self.p.products:
            if pp.ref == product_ref and not pp.has_error:
                if pp.category_ref:
                    return pp.category_ref
                break
        if product_ref.startswith("id:"):
            for product in self.ctx.products:
                if str(product.id) == product_ref[3:]:
                    return f"id:{product.category_id}"
        return None

    def _inherited(self, target_type: str, ref: Optional[str]) -> Tuple[List[NoteItem], Optional[str]]:
        """The chips a target shows without its own: the nearest category up its chain that has some."""
        current = self._category_of(ref) if target_type == "product" else self.p._parent_of(ref)
        seen: Set[str] = set()
        while current is not None and current not in seen and len(seen) < 60:
            seen.add(current)
            items = self._final.get(("category", current))
            if items is None:
                items = self._own_items("category", current) or []
            if items:
                return [NoteItem(i.text, i.important, i.sort, seeded=True) for i in items], self.p._name_of(current)
            current = self.p._parent_of(current)
        return [], None

    def _ensure(self, target_type: str, ref: Optional[str]) -> List[NoteItem]:
        key = (target_type, ref)
        if key not in self._final:
            items = self._own_items(target_type, ref)
            if items is None:
                items, source = self._inherited(target_type, ref)
                if items and source:
                    self._seed_from[key] = source
            self._final[key] = items
        return self._final[key]

    def _may_change_notes(self, plan: NotePlan, target_type: str, label: str, stored) -> bool:
        """Asked only when the row changes the target: an unchanged chip needs no permission."""
        if target_type == "all":
            allowed = self._may_write_company(self.ctx.company.id)
            message = "אין לך הרשאה לשנות את ההערות של כל המנות בחברה"
        else:
            allowed = stored is None or self._may_target(stored)
            message = f"אין לך הרשאה לשנות את ההערות של '{label}'"
        if not allowed:
            self._issue(plan, "error", NOTES, message)
        return allowed

    def _note(self, plan: NotePlan, target: Tuple[str, Optional[str], str, Any], v: Dict[str, Any]) -> None:
        target_type, ref, label, stored = target
        key = (target_type, ref)
        items = self._ensure(target_type, ref)
        found = next((i for i in items if _key(i.text) == _key(plan.text)), None)
        important, sort = v["important"], v["sort"]
        if found is not None:
            if found.shared:
                return
            wants_important = important is not None and important != found.important
            wants_sort = sort is not None and sort != found.sort
            if not (wants_important or wants_sort) or not self._may_change_notes(plan, target_type, label, stored):
                return
            if wants_important:
                plan.changes.append(Change("important", f"חשובה ({label})", found.important, important))
                found.important = important
            if wants_sort:
                plan.changes.append(Change("sort", f"סדר ({label})", found.sort, sort))
                found.sort = sort
            found.dirty, found.source = True, plan
            plan.updated.append(label)
            return
        if not self._may_change_notes(plan, target_type, label, stored):
            return
        own = [i for i in items if not i.shared]
        if len(own) >= S.NOTES_MAX:
            self._issue(plan, "error", NOTES, f"ל'{label}' כבר יש {S.NOTES_MAX} הערות - זה המקסימום")
            return
        if sort is None:
            sort = max([i.sort for i in own] or [-1]) + 1
        items.append(NoteItem(plan.text, bool(important), sort, source=plan))
        plan.added.append(label)
        source = self._seed_from.get(key)
        if source and key not in self._seed_told:
            self._seed_told.add(key)
            seeded = ", ".join(i.text for i in items if i.seeded)
            plan.issues.append(row_issue(
                "info", NOTES, plan.row,
                f"ל'{label}' לא היו הערות משלו: ההערות שקיבל מ'{source}' ({seeded}) יישמרו לו גם הן, כדי שלא ייעלמו"))


#: A cell that leaves a field as it is (where None itself is a value: "no limit").
_KEEP = object()


# ── Applying ──────────────────────────────────────────────────────────────────


def fetch_images(plan: Optional[MenuPlan], tenant_id) -> Dict[IMG.Job, IMG.Outcome]:
    if plan is None:
        return {}
    return IMG.materialize([w.job for w in plan.images if w.job is not None], tenant_id)


def apply(db: Session, plan: Optional[MenuPlan], ctx, user, resolve: Callable[[Optional[str]], Optional[uuid.UUID]],
          objects: Dict[str, Any], pictures: Dict[IMG.Job, IMG.Outcome], result) -> None:
    """Write the plan's error-free rows, after the products and categories of the same plan."""
    if plan is None:
        return
    tenant_id = ctx.tenant_id
    now = _now()
    menu_touched = False

    # Pictures.
    products_by_id = {str(p.id): p for p in ctx.products} if plan.images else {}
    for w in plan.images:
        target = objects.get(w.target_ref)
        if target is None and w.target_ref.startswith("id:"):
            stored = ctx.category_by_id if w.target_type == "category" else products_by_id
            target = stored.get(w.target_ref[3:])
        if target is None:
            continue
        if w.remove:
            target.image_url = None
            result.images_removed += 1
        elif w.direct:
            target.image_url = w.direct
            result.images_stored += 1
        else:
            outcome = pictures.get(w.job) if w.job is not None else None
            if outcome is None or not outcome.url:
                sheet_name = S.SHEET_CATEGORIES if w.target_type == "category" else S.SHEET_PRODUCTS
                message = (outcome.error if outcome is not None else None) or "התמונה לא נשמרה"
                result.image_failures.append({"sheet": w.sheet, "row": w.row, "name": w.name, "message": message,
                                              "text": f"{sheet_name}, שורה {w.row} ('{w.name}'): {message}"})
                continue
            target.image_url = outcome.url
            result.images_stored += 1

    # Groups, then their options.
    group_ids: Dict[str, uuid.UUID] = {}
    for g in plan.groups:
        if g.has_error:
            continue
        if g.action == "create":
            row = ModifierGroup(id=uuid.uuid4(), tenant_id=tenant_id, company_id=ctx.company.id, **g.values)
            db.add(row)
            group_ids[g.ref] = row.id
            result.groups_created += 1
            menu_touched = True
        elif g.action == "update" and g.existing is not None:
            for attr, value in g.values.items():
                setattr(g.existing, attr, value)
            g.existing.updated_at = now
            result.groups_updated += 1
            menu_touched = True
    db.flush()

    def group_id(ref: Optional[str]) -> Optional[uuid.UUID]:
        if ref is None:
            return None
        if ref.startswith("gid:"):
            return uuid.UUID(ref[4:])
        return group_ids.get(ref)

    touched_groups: Set[str] = set()
    for o in plan.options:
        if o.has_error or o.action not in ("create", "update"):
            continue
        gid = group_id(o.group_ref)
        if gid is None:
            continue
        if o.action == "create":
            db.add(ModifierOption(id=uuid.uuid4(), group_id=gid, **o.values))
            result.options_created += 1
        elif o.existing is not None:
            for attr, value in o.values.items():
                setattr(o.existing, attr, value)
            result.options_updated += 1
        touched_groups.add(str(gid))
        menu_touched = True
    for gid in touched_groups:
        existing = ctx.menu.group_by_id.get(gid) if ctx.menu is not None else None
        if existing is not None:
            existing.updated_at = now
    db.flush()

    # Which groups each product / category gets.
    for link in plan.links:
        target_id = resolve(link.target_ref)
        if target_id is None:
            continue
        ids = [str(i) for i in (group_id(r) for r in link.group_refs) if i is not None]
        if link.mode == "groups" and not ids:
            continue
        M._write_links(db, tenant_id, link.target_type, target_id, link.mode, ids)
        result.links_changed += 1
        menu_touched = True

    # Quick notes.
    for w in plan.note_writes:
        item = w.item
        if item.row is not None:
            item.row.is_important = item.important
            item.row.sort_order = item.sort
            result.notes_updated += 1
        else:
            target_id = None if w.target_type == "all" else resolve(w.target_ref)
            if w.target_type != "all" and target_id is None:
                continue
            db.add(PrepNotePreset(
                id=uuid.uuid4(), tenant_id=tenant_id,
                company_id=ctx.company.id if w.target_type == "all" else None,
                target_type=w.target_type, target_id=target_id, text=item.text,
                is_important=item.important, sort_order=item.sort,
            ))
            if not item.seeded:
                result.notes_created += 1
        menu_touched = True
    db.flush()
    if menu_touched:
        M.bump(db, tenant_id)
        result.menu_changed = True

    # Catalog-menu prices.
    menus_touched: Dict[str, CatalogMenu] = {}
    for w in plan.menu_prices:
        product_id = resolve(w.product_ref)
        if product_id is None:
            continue
        if w.existing is not None:
            w.existing.price = w.price
        else:
            db.add(CatalogMenuProduct(id=uuid.uuid4(), menu_id=w.menu.id, product_id=product_id,
                                      sort_order=w.sort, price=w.price))
        menus_touched[str(w.menu.id)] = w.menu
        result.menu_prices_changed += 1
    if menus_touched:
        for menu in menus_touched.values():
            menu.updated_at = now
        db.flush()
        CM.bump(db, tenant_id)
        result.catalog_menus_changed = True


# ── Export: the workbook's contents ───────────────────────────────────────────


def _yes_no(value: Any) -> str:
    return S.YES if value else S.NO


def _product_labels(ctx) -> Dict[str, str]:
    """id → how a notes cell names a product: its name, or its SKU when the name is not unique."""
    counts: Dict[str, int] = defaultdict(int)
    for p in ctx.products:
        counts[_key(p.name)] += 1
    return {str(p.id): (p.name if counts[_key(p.name)] == 1 or not p.sku else p.sku) for p in ctx.products}


def export_sheets(ctx, view, *, with_data: bool) -> None:
    """
    The groups sheet (always - like the categories, so a product can name them from the
    dropdown), with data the options and the quick notes, and the menus' price columns.
    The blank template is what the public share link serves: no option prices in it.
    """
    mc: Optional[MenuContext] = ctx.menu
    if mc is None:
        return
    view.menu_names.extend(_menu_names(mc))
    for g in mc.groups:
        # Two groups by one name cannot be told apart by name: shown, but marked "דלג" so
        # the file still imports back as it is.
        ambiguous = mc.find_group(g.name) != (g, False)
        skip: Dict[str, Any] = {
            "marker": S.SKIP_MARK,
            "notes": {"marker": f"יש יותר מקבוצה אחת בשם '{g.name}' - השורה לא תיקלט. כדי לערוך אותה מהקובץ, "
                                "שנו את השם של אחת הקבוצות במסך 'תוספות ושינויים' והורידו את הקובץ מחדש."},
        } if ambiguous else {}
        view.groups.append({
            **skip,
            "name": g.name,
            "kind": S.GROUP_KIND_LABELS.get(g.kind or "addon", g.kind),
            "required": _yes_no((g.min_select or 0) > 0),
            "min": g.min_select or 0,
            "max": g.max_select if g.max_select is not None else S.LIMIT_NONE,
            "free": g.free_count or 0,
            "allow_quantity": _yes_no(g.allow_quantity),
            "allow_pre": _yes_no(g.allow_pre),
            "sort": g.sort_order or 0,
            "active": _yes_no(g.is_active),
        })
        if not with_data:
            continue
        for o in mc.options.get(str(g.id), []):
            view.options.append({
                **skip,
                "group": g.name,
                "name": o.name,
                "price": _money(o.price),
                "kitchen_name": o.kitchen_name or "",
                "default": _yes_no(o.is_default),
                "max_qty": o.max_qty if o.max_qty is not None else "",
                "sort": o.sort_order or 0,
                "active": _yes_no(o.is_active),
            })
    if not with_data:
        return
    labels = _product_labels(ctx)
    rows: Dict[Tuple[str, bool], Dict[str, Any]] = {}
    order: List[Tuple[str, bool]] = []

    def add(note: PrepNotePreset, target: str, label: Optional[str]) -> None:
        key = (_key(note.text), bool(note.is_important))
        if key not in rows:
            rows[key] = {"name": note.text, "all": "", "categories": [], "products": [],
                         "important": _yes_no(note.is_important)}
            order.append(key)
        row = rows[key]
        if target == "all":
            row["all"] = S.YES
        elif label and label not in row[target]:
            row[target].append(label)

    for note in [*mc.all_notes, *mc.shared_all_notes]:
        add(note, "all", None)
    for c in ctx.categories:
        for note in mc.notes.get(("category", str(c.id)), []):
            add(note, "categories", ctx.labels.get(str(c.id), c.name))
    for p in ctx.products:
        for note in mc.notes.get(("product", str(p.id)), []):
            add(note, "products", labels.get(str(p.id), p.name))
    for key in order:
        row = rows[key]
        view.notes.append({**row, "categories": ", ".join(row["categories"]), "products": ", ".join(row["products"])})


def export_target(ctx, target_type: str, target, row: Dict[str, Any]) -> None:
    """A category's / product's own groups, its picture and (a product) its menu prices."""
    mc: Optional[MenuContext] = ctx.menu
    row["image"] = target.image_url or ""
    if mc is None:
        return
    mode, ids = mc.links.get((target_type, str(target.id)), ("inherit", []))
    if mode == "none":
        row["groups"] = S.GROUPS_NONE
    elif mode == "groups":
        names = []
        faithful = True
        for gid in ids:
            group = mc.group_by_id.get(gid)
            if group is None or mc.find_group(group.name) != (group, False) or "," in group.name:
                faithful = False
                break
            names.append(group.name)
        if faithful:
            row["groups"] = ", ".join(names)
        else:
            shown = ", ".join(mc.all_group_names.get(i, "?") for i in ids)
            row.setdefault("notes", {})["groups"] = (
                f"הקבוצות ({shown}) כוללות קבוצה של חברה אחרת או שם כפול - ערכו אותן במסך המוצר")
    if target_type != "product":
        return
    for name in _menu_names(mc):
        menu, _ambiguous = mc.find_menu(name)
        entry = mc.menu_products.get((str(menu.id), str(target.id))) if menu is not None else None
        row[f"menu:{name}"] = _money(entry.price) if entry is not None and entry.price is not None else None


def _menu_names(mc: MenuContext) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for m in mc.menus:
        if _key(m.name) not in seen and mc.find_menu(m.name) == (m, False):
            seen.add(_key(m.name))
            out.append(m.name)
    return out
