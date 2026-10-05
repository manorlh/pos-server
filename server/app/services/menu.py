"""
The menu layer ("תוספות ושינויים", docs/SPEC_MENU_MODIFIERS.md): definitions, the till's
copy of them, what a sold line was ordered with, and the reports.

* **Who** — written by the catalog roles. Something placed on a company is written by
  whoever covers that company; something for the whole organization (`company_id` null)
  by a super admin or distributor only. A product's or category's own lists are written
  by whoever may edit it. Listed to anyone whose catalog reaches it.
* **Inheritance** — a product's own modifier groups (or note chips) replace its
  category's; a category without its own inherits its parent's; an explicit "none" stops
  the inheritance. The same rule as the kitchen printers' routes (`resolve_groups`).
* **The till's copy** — one `menu` block in `GET /sync/{m}/catalog` (`menu_block`), sent
  whole: on every full pull, and on a delta pull when the organization's menu changed
  after `since` (`menu_sync_state`, bumped by every write, deletes included). The till
  applies it offline.
* **Sold lines** — `transaction_items.details` as the till sent it, never checked against
  the definitions (a fiscal document is never refused over the menu), and taken apart
  into `transaction_item_parts` for the reports, with a meal's money allocated to its
  components exactly (`allocate_meal`).
"""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.company import Company
from app.models.menu import (
    ALLERGENS,
    PRE_MODIFIERS,
    MealSlot,
    MealSlotOption,
    MenuCourse,
    MenuSyncState,
    ModifierGroup,
    ModifierLink,
    ModifierOption,
    PrepNotePreset,
    TransactionItemPart,
    UpsellRule,
    UpsellStat,
)
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.schemas.menu import (
    CategoryMenuIn,
    CoursesIn,
    GroupIn,
    LinksIn,
    MealIn,
    NotesIn,
    ProductMenuIn,
    UpsellIn,
    UpsellStatsIn,
)
from app.services.company_hierarchy import ancestor_company_ids, catalog_company_ids, user_covers_company
from app.services.permission_matrix import Action, Resource, roles_for

logger = logging.getLogger(__name__)

#: `reason` on the catalog notify that makes the tills pull the menu now.
NOTIFY_REASON = "menu_updated"

#: 4xx details.
NOT_FOUND = "menu_not_found"
FORBIDDEN = "menu_forbidden"
WHOLE_ORG_FORBIDDEN = "menu_whole_org_forbidden"
UNKNOWN_COMPANY = "menu_unknown_company"
UNKNOWN_PRODUCT = "menu_unknown_product"
UNKNOWN_CATEGORY = "menu_unknown_category"
UNKNOWN_GROUP = "menu_unknown_group"
UNKNOWN_COURSE = "menu_unknown_course"
MEAL_IN_MEAL = "menu_meal_in_meal"

WRITE_ROLES = roles_for(Resource.CATALOG, Action.WRITE)
TENANT_WIDE_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)

#: A sold line's details are kept as sent up to this size; a bigger one is dropped (the
#: line itself is kept — a document is never refused over its details).
DETAILS_MAX_BYTES = 32_000

CENT = Decimal("0.01")


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _s(value) -> Optional[str]:
    return str(value) if value is not None else None


def _money(value) -> float:
    return float(Decimal(str(value or 0)).quantize(CENT))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


# ── Who may do what ───────────────────────────────────────────────────────────


def _require_writer(user: User) -> None:
    if user.role not in WRITE_ROLES:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)


def check_company_write(db: Session, user: User, tenant_id, company_id) -> None:
    """403 unless `user` may write something placed on `company_id` (null: the organization)."""
    _require_writer(user)
    if company_id is None:
        if user.role not in TENANT_WIDE_ROLES:
            raise _bad(WHOLE_ORG_FORBIDDEN, status.HTTP_403_FORBIDDEN)
        return
    company = db.query(Company).filter(Company.id == company_id).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _bad(UNKNOWN_COMPANY)
    if user.role in TENANT_WIDE_ROLES:
        return
    if not user_covers_company(db, user, company_id):
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)


def may_write_company(db: Session, user: User, tenant_id, company_id) -> bool:
    try:
        check_company_write(db, user, tenant_id, company_id)
    except HTTPException:
        return False
    return True


def _visible_company_ids(db: Session, user: User) -> Optional[Set[str]]:
    """Companies whose menu rows the user sees; None: every one."""
    ids = catalog_company_ids(db, user)
    return None if ids is None else {str(i) for i in ids}


def _visible(row, visible: Optional[Set[str]]) -> bool:
    company = getattr(row, "company_id", None)
    return visible is None or company is None or str(company) in visible


def check_target_write(db: Session, user: User, target) -> None:
    """A product's or category's own menu lists: whoever may edit the row."""
    _require_writer(user)
    if user.role in TENANT_WIDE_ROLES:
        return
    company = getattr(target, "company_id", None)
    if company is not None and user_covers_company(db, user, company):
        return
    raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)


# ── Change tracking ───────────────────────────────────────────────────────────


def bump(db: Session, tenant_id) -> None:
    """The organization's menu changed: the next delta pull of each till carries it."""
    now = _now()
    row = db.query(MenuSyncState).filter(MenuSyncState.tenant_id == tenant_id).first()
    if row is None:
        db.add(MenuSyncState(tenant_id=tenant_id, changed_at=now))
    else:
        row.changed_at = now
    db.flush()


def menu_changed_at(db: Session, tenant_id) -> Optional[datetime]:
    if tenant_id is None:
        return None
    row = db.query(MenuSyncState.changed_at).filter(MenuSyncState.tenant_id == tenant_id).first()
    if row is None or row[0] is None:
        return None
    value = row[0]
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def notify_targets(db: Session, tenant_id) -> List[Tuple[str, str]]:
    return [
        (str(m.tenant_id), str(m.id))
        for m in db.query(POSMachine)
        .filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
        .all()
        if m.tenant_id
    ]


def publish_menu_notify(targets: Iterable[Tuple[str, str]]) -> None:
    from app.services.ably_notify import publish_catalog_notify

    for tenant_id, machine_id in targets:
        try:
            publish_catalog_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
        except Exception:  # pragma: no cover - best effort, the till also pulls on sync
            pass


# ── Lookups ───────────────────────────────────────────────────────────────────


def get_product(db: Session, tenant_id, product_id) -> Product:
    ident = _as_uuid(product_id)
    row = (
        db.query(Product).filter(Product.id == ident, Product.tenant_id == tenant_id).first()
        if ident is not None
        else None
    )
    if row is None:
        raise _bad(UNKNOWN_PRODUCT, status.HTTP_404_NOT_FOUND)
    return row


def get_category(db: Session, tenant_id, category_id) -> Category:
    ident = _as_uuid(category_id)
    row = (
        db.query(Category).filter(Category.id == ident, Category.tenant_id == tenant_id).first()
        if ident is not None
        else None
    )
    if row is None:
        raise _bad(UNKNOWN_CATEGORY, status.HTTP_404_NOT_FOUND)
    return row


def _check_products(db: Session, tenant_id, ids: Iterable) -> Dict[str, Product]:
    wanted = {i for i in (_as_uuid(x) for x in ids) if i is not None}
    if not wanted:
        return {}
    rows = db.query(Product).filter(Product.id.in_(wanted), Product.tenant_id == tenant_id).all()
    if len(rows) != len(wanted):
        raise _bad(UNKNOWN_PRODUCT)
    return {str(p.id): p for p in rows}


def _check_categories(db: Session, tenant_id, ids: Iterable) -> Dict[str, Category]:
    wanted = {i for i in (_as_uuid(x) for x in ids) if i is not None}
    if not wanted:
        return {}
    rows = db.query(Category).filter(Category.id.in_(wanted), Category.tenant_id == tenant_id).all()
    if len(rows) != len(wanted):
        raise _bad(UNKNOWN_CATEGORY)
    return {str(c.id): c for c in rows}


def category_chain(db: Session, category_id) -> List[uuid.UUID]:
    """The category and its ancestors, nearest first. Stops on a loop."""
    out: List[uuid.UUID] = []
    current = _as_uuid(category_id)
    while current is not None and current not in out:
        out.append(current)
        row = db.query(Category.parent_id).filter(Category.id == current).first()
        current = row[0] if row else None
    return out


# ── Modifier groups ───────────────────────────────────────────────────────────


def get_group(db: Session, tenant_id, group_id) -> ModifierGroup:
    ident = _as_uuid(group_id)
    row = (
        db.query(ModifierGroup)
        .filter(ModifierGroup.id == ident, ModifierGroup.tenant_id == tenant_id)
        .first()
        if ident is not None
        else None
    )
    if row is None:
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return row


def _options_by_group(db: Session, group_ids: Sequence) -> Dict[str, List[ModifierOption]]:
    out: Dict[str, List[ModifierOption]] = defaultdict(list)
    if not group_ids:
        return out
    for o in (
        db.query(ModifierOption)
        .filter(ModifierOption.group_id.in_(list(group_ids)))
        .order_by(ModifierOption.sort_order, ModifierOption.name)
        .all()
    ):
        out[str(o.group_id)].append(o)
    return out


def option_out(o: ModifierOption) -> Dict[str, Any]:
    return {
        "id": str(o.id),
        "name": o.name,
        "kitchenName": o.kitchen_name,
        "price": _money(o.price),
        "isDefault": bool(o.is_default),
        "allergens": [a for a in (o.allergens or []) if a in ALLERGENS],
        "linkedProductId": _s(o.linked_product_id),
        "maxQty": o.max_qty,
        "sortOrder": o.sort_order or 0,
        "isActive": bool(o.is_active),
    }


def group_out(
    g: ModifierGroup,
    options: List[ModifierOption],
    *,
    category_ids: Optional[List[str]] = None,
    product_count: int = 0,
    company_name: Optional[str] = None,
    can_edit: bool = False,
) -> Dict[str, Any]:
    return {
        "id": str(g.id),
        "name": g.name,
        "companyId": _s(g.company_id),
        "companyName": company_name,
        "kind": g.kind,
        "minSelect": g.min_select or 0,
        "maxSelect": g.max_select,
        "freeCount": g.free_count or 0,
        "allowQuantity": bool(g.allow_quantity),
        "allowPre": bool(g.allow_pre),
        "sortOrder": g.sort_order or 0,
        "isActive": bool(g.is_active),
        "options": [option_out(o) for o in options],
        "categoryIds": category_ids or [],
        "productCount": product_count,
        "canEdit": can_edit,
        "updatedAt": _iso(g.updated_at),
    }


def _group_usage(db: Session, tenant_id, group_ids: Sequence) -> Tuple[Dict[str, List[str]], Dict[str, int]]:
    cats: Dict[str, List[str]] = defaultdict(list)
    prods: Dict[str, int] = defaultdict(int)
    if not group_ids:
        return cats, prods
    for link in (
        db.query(ModifierLink)
        .filter(ModifierLink.tenant_id == tenant_id, ModifierLink.group_id.in_(list(group_ids)))
        .all()
    ):
        if link.target_type == "category":
            cats[str(link.group_id)].append(str(link.target_id))
        else:
            prods[str(link.group_id)] += 1
    return cats, prods


def _company_names(db: Session, ids: Iterable) -> Dict[str, str]:
    wanted = {i for i in (_as_uuid(x) for x in ids) if i is not None}
    if not wanted:
        return {}
    return {str(c.id): c.name for c in db.query(Company).filter(Company.id.in_(wanted)).all()}


def list_groups(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    visible = _visible_company_ids(db, user)
    rows = [
        g
        for g in db.query(ModifierGroup)
        .filter(ModifierGroup.tenant_id == tenant_id)
        .order_by(ModifierGroup.sort_order, ModifierGroup.name)
        .all()
        if _visible(g, visible)
    ]
    ids = [g.id for g in rows]
    options = _options_by_group(db, ids)
    cats, prods = _group_usage(db, tenant_id, ids)
    names = _company_names(db, [g.company_id for g in rows])
    return {
        "items": [
            group_out(
                g, options.get(str(g.id), []),
                category_ids=cats.get(str(g.id)), product_count=prods.get(str(g.id), 0),
                company_name=names.get(str(g.company_id)) if g.company_id else None,
                can_edit=may_write_company(db, user, tenant_id, g.company_id),
            )
            for g in rows
        ],
        "canCreate": user.role in WRITE_ROLES,
    }


def one_group_out(db: Session, user: User, tenant_id, g: ModifierGroup) -> Dict[str, Any]:
    cats, prods = _group_usage(db, tenant_id, [g.id])
    names = _company_names(db, [g.company_id])
    return group_out(
        g, _options_by_group(db, [g.id]).get(str(g.id), []),
        category_ids=cats.get(str(g.id)), product_count=prods.get(str(g.id), 0),
        company_name=names.get(str(g.company_id)) if g.company_id else None,
        can_edit=may_write_company(db, user, tenant_id, g.company_id),
    )


def _apply_group(db: Session, tenant_id, g: ModifierGroup, body: GroupIn) -> None:
    linked = [o.linked_product_id for o in body.options if o.linked_product_id is not None]
    _check_products(db, tenant_id, linked)
    g.name = body.name
    g.company_id = body.company_id
    g.kind = body.kind
    g.min_select = body.min_select
    g.max_select = body.max_select
    g.free_count = body.free_count
    g.allow_quantity = body.allow_quantity
    g.allow_pre = body.allow_pre
    g.is_active = body.is_active
    g.updated_at = _now()
    db.flush()

    existing = {str(o.id): o for o in db.query(ModifierOption).filter(ModifierOption.group_id == g.id).all()}
    kept: Set[str] = set()
    for index, opt in enumerate(body.options):
        # An existing option keeps its id (sold lines and reports name it); an id that is
        # not this group's is ignored and the option is created afresh.
        row = existing.get(str(opt.id)) if opt.id is not None else None
        if row is None:
            row = ModifierOption(id=uuid.uuid4(), group_id=g.id)
            db.add(row)
        kept.add(str(row.id))
        row.name = opt.name
        row.kitchen_name = opt.kitchen_name
        row.price = opt.price
        row.is_default = opt.is_default
        row.allergens = list(opt.allergens) or None
        row.linked_product_id = opt.linked_product_id
        row.max_qty = opt.max_qty
        row.sort_order = index
        row.is_active = opt.is_active
    for key, row in existing.items():
        if key not in kept:
            db.delete(row)
    db.flush()


def _category_own_group_ids(db: Session, tenant_id, category_id) -> Tuple[str, List[str]]:
    rows = _own_rows(db, tenant_id, "category", category_id)
    return _links_state(rows)


def _assign_to_categories(db: Session, user: User, tenant_id, g: ModifierGroup, category_ids: List[uuid.UUID]) -> None:
    """
    The group editor's "which categories get it": the group joins (or leaves) each
    category's own list. A category that only inherited gets its own list seeded with what
    it inherited, so assigning one group never silently drops the others it had.
    """
    wanted = {str(c) for c in category_ids}
    cats = _check_categories(db, tenant_id, wanted)
    current = {
        str(link.target_id)
        for link in db.query(ModifierLink).filter(
            ModifierLink.tenant_id == tenant_id,
            ModifierLink.target_type == "category",
            ModifierLink.group_id == g.id,
        )
    }
    for cid in sorted(wanted - current):
        category = cats[cid]
        check_target_write(db, user, category)
        mode, own = _category_own_group_ids(db, tenant_id, cid)
        if mode == "groups":
            ids = own + [str(g.id)]
        elif mode == "none":
            ids = [str(g.id)]
        else:
            inherited, _src = resolve_category_groups(db, tenant_id, category.parent_id) if category.parent_id else ([], None)
            ids = [i for i in inherited if i != str(g.id)] + [str(g.id)]
        _write_links(db, tenant_id, "category", category.id, "groups", ids)
    for cid in sorted(current - wanted):
        category = db.query(Category).filter(Category.id == _as_uuid(cid)).first()
        if category is None:
            continue
        check_target_write(db, user, category)
        mode, own = _category_own_group_ids(db, tenant_id, cid)
        rest = [i for i in own if i != str(g.id)]
        _write_links(db, tenant_id, "category", category.id, "groups" if rest else "inherit", rest)


def create_group(db: Session, user: User, tenant_id, body: GroupIn) -> ModifierGroup:
    check_company_write(db, user, tenant_id, body.company_id)
    top = db.query(func.max(ModifierGroup.sort_order)).filter(ModifierGroup.tenant_id == tenant_id).scalar()
    g = ModifierGroup(id=uuid.uuid4(), tenant_id=tenant_id, sort_order=(top or 0) + 1, name=body.name)
    db.add(g)
    db.flush()
    _apply_group(db, tenant_id, g, body)
    if body.category_ids is not None:
        _assign_to_categories(db, user, tenant_id, g, body.category_ids)
    bump(db, tenant_id)
    return g


def update_group(db: Session, user: User, tenant_id, g: ModifierGroup, body: GroupIn) -> ModifierGroup:
    check_company_write(db, user, tenant_id, g.company_id)
    check_company_write(db, user, tenant_id, body.company_id)
    _apply_group(db, tenant_id, g, body)
    if body.category_ids is not None:
        _assign_to_categories(db, user, tenant_id, g, body.category_ids)
    bump(db, tenant_id)
    return g


def delete_group(db: Session, user: User, tenant_id, g: ModifierGroup) -> None:
    """The group, its options and every link to it go. Sold lines keep their names."""
    check_company_write(db, user, tenant_id, g.company_id)
    db.query(ModifierLink).filter(ModifierLink.group_id == g.id).delete(synchronize_session=False)
    db.query(ModifierOption).filter(ModifierOption.group_id == g.id).delete(synchronize_session=False)
    db.delete(g)
    db.flush()
    bump(db, tenant_id)


def reorder_groups(db: Session, user: User, tenant_id, ids: List[uuid.UUID]) -> None:
    _require_writer(user)
    if not ids:
        return
    rows = {
        str(g.id): g
        for g in db.query(ModifierGroup).filter(ModifierGroup.tenant_id == tenant_id, ModifierGroup.id.in_(ids))
    }
    for index, ident in enumerate(ids):
        g = rows.get(str(ident))
        if g is not None and may_write_company(db, user, tenant_id, g.company_id):
            g.sort_order = index
            g.updated_at = _now()
    db.flush()
    bump(db, tenant_id)


# ── Links: which groups a category / product gets ────────────────────────────


def _own_rows(db: Session, tenant_id, target_type: str, target_id) -> List[ModifierLink]:
    return (
        db.query(ModifierLink)
        .filter(
            ModifierLink.tenant_id == tenant_id,
            ModifierLink.target_type == target_type,
            ModifierLink.target_id == _as_uuid(target_id),
        )
        .order_by(ModifierLink.sort_order)
        .all()
    )


def _links_state(rows: List[ModifierLink]) -> Tuple[str, List[str]]:
    """("inherit", []) with no rows; ("none", []) for the explicit none; else ("groups", ids)."""
    if not rows:
        return "inherit", []
    ids = [str(r.group_id) for r in rows if r.group_id is not None]
    if not ids:
        return "none", []
    return "groups", ids


def _write_links(db: Session, tenant_id, target_type: str, target_id, mode: str, group_ids: List[str]) -> None:
    db.query(ModifierLink).filter(
        ModifierLink.tenant_id == tenant_id,
        ModifierLink.target_type == target_type,
        ModifierLink.target_id == _as_uuid(target_id),
    ).delete(synchronize_session=False)
    if mode == "none":
        db.add(ModifierLink(id=uuid.uuid4(), tenant_id=tenant_id, target_type=target_type,
                            target_id=_as_uuid(target_id), group_id=None, sort_order=0))
    elif mode == "groups":
        for index, gid in enumerate(group_ids):
            db.add(ModifierLink(id=uuid.uuid4(), tenant_id=tenant_id, target_type=target_type,
                                target_id=_as_uuid(target_id), group_id=_as_uuid(gid), sort_order=index))
    db.flush()


def set_links(db: Session, user: User, tenant_id, target_type: str, target, body: LinksIn) -> None:
    check_target_write(db, user, target)
    if body.mode == "groups":
        visible = _visible_company_ids(db, user)
        found = {
            str(g.id): g
            for g in db.query(ModifierGroup).filter(
                ModifierGroup.tenant_id == tenant_id, ModifierGroup.id.in_(body.group_ids)
            )
        }
        if len(found) != len(set(body.group_ids)) or not all(_visible(g, visible) for g in found.values()):
            raise _bad(UNKNOWN_GROUP)
    _write_links(db, tenant_id, target_type, target.id, body.mode, [str(i) for i in body.group_ids])


def resolve_category_groups(db: Session, tenant_id, category_id) -> Tuple[List[str], Optional[str]]:
    """What a category resolves to through its chain: (group ids, the category they come from)."""
    for cid in category_chain(db, category_id):
        mode, ids = _links_state(_own_rows(db, tenant_id, "category", cid))
        if mode == "inherit":
            continue
        return ids, str(cid)
    return [], None


def resolve_groups(db: Session, tenant_id, product: Product) -> Tuple[List[str], Optional[str]]:
    """
    The groups a product is ordered with, in order, and where they come from: "product",
    or a category id. The product's own list wins (an explicit none included); otherwise
    the nearest category up the tree that has one.
    """
    mode, ids = _links_state(_own_rows(db, tenant_id, "product", product.id))
    if mode != "inherit":
        return ids, "product"
    return resolve_category_groups(db, tenant_id, product.category_id)


def links_out(db: Session, tenant_id, target_type: str, target) -> Dict[str, Any]:
    mode, ids = _links_state(_own_rows(db, tenant_id, target_type, target.id))
    if target_type == "product":
        inherited, source = resolve_category_groups(db, tenant_id, target.category_id)
    else:
        inherited, source = (
            resolve_category_groups(db, tenant_id, target.parent_id) if target.parent_id else ([], None)
        )
    source_name = None
    if source:
        row = db.query(Category.name).filter(Category.id == _as_uuid(source)).first()
        source_name = row[0] if row else None
    return {
        "mode": mode,
        "groupIds": ids,
        "inheritedGroupIds": inherited,
        "inheritedFromId": source,
        "inheritedFromName": source_name,
    }


# ── Prep-note chips ───────────────────────────────────────────────────────────


def note_out(n: PrepNotePreset) -> Dict[str, Any]:
    return {"id": str(n.id), "text": n.text, "isImportant": bool(n.is_important), "sortOrder": n.sort_order or 0}


def _own_notes(db: Session, tenant_id, target_type: str, target_id, company_id=None) -> List[PrepNotePreset]:
    q = db.query(PrepNotePreset).filter(
        PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type == target_type
    )
    if target_type == "all":
        q = q.filter(
            PrepNotePreset.company_id.is_(None)
            if company_id is None
            else PrepNotePreset.company_id == _as_uuid(company_id)
        )
    else:
        q = q.filter(PrepNotePreset.target_id == _as_uuid(target_id))
    return q.order_by(PrepNotePreset.sort_order).all()


def _write_notes(db: Session, tenant_id, target_type: str, target_id, notes, company_id=None) -> None:
    for row in _own_notes(db, tenant_id, target_type, target_id, company_id):
        db.delete(row)
    db.flush()
    seen: Set[str] = set()
    for index, n in enumerate(notes):
        key = n.text.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        db.add(PrepNotePreset(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=_as_uuid(company_id),
            target_type=target_type, target_id=_as_uuid(target_id) if target_type != "all" else None,
            text=n.text, is_important=n.is_important, sort_order=index,
        ))
    db.flush()


def set_target_notes(db: Session, user: User, tenant_id, target_type: str, target, body: NotesIn) -> None:
    check_target_write(db, user, target)
    notes = body.notes if body.mode == "own" else []
    _write_notes(db, tenant_id, target_type, target.id, notes)


def set_global_notes(db: Session, user: User, tenant_id, body: NotesIn) -> None:
    """The chips every dish gets, for the organization or one company."""
    check_company_write(db, user, tenant_id, body.company_id)
    _write_notes(db, tenant_id, "all", None, body.notes, company_id=body.company_id)
    bump(db, tenant_id)


def list_global_notes(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    visible = _visible_company_ids(db, user)
    rows = [
        n for n in db.query(PrepNotePreset)
        .filter(PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type == "all")
        .order_by(PrepNotePreset.sort_order)
        .all()
        if _visible(n, visible)
    ]
    by_company: Dict[Optional[str], List[Dict[str, Any]]] = defaultdict(list)
    for n in rows:
        by_company[_s(n.company_id)].append(note_out(n))
    names = _company_names(db, [k for k in by_company if k])
    return {
        "groups": [
            {
                "companyId": k,
                "companyName": names.get(k) if k else None,
                "notes": v,
                "canEdit": may_write_company(db, user, tenant_id, _as_uuid(k)),
            }
            for k, v in by_company.items()
        ],
    }


def resolve_category_notes(db: Session, tenant_id, category_id) -> Tuple[List[PrepNotePreset], Optional[str]]:
    for cid in category_chain(db, category_id):
        rows = _own_notes(db, tenant_id, "category", cid)
        if rows:
            return rows, str(cid)
    return [], None


def notes_out(db: Session, tenant_id, target_type: str, target) -> Dict[str, Any]:
    own = _own_notes(db, tenant_id, target_type, target.id)
    if target_type == "product":
        inherited, source = resolve_category_notes(db, tenant_id, target.category_id)
    else:
        inherited, source = resolve_category_notes(db, tenant_id, target.parent_id) if target.parent_id else ([], None)
    source_name = None
    if source:
        row = db.query(Category.name).filter(Category.id == _as_uuid(source)).first()
        source_name = row[0] if row else None
    return {
        "mode": "own" if own else "inherit",
        "notes": [note_out(n) for n in own],
        "inherited": [note_out(n) for n in inherited],
        "inheritedFromId": source,
        "inheritedFromName": source_name,
    }


# ── Meals ─────────────────────────────────────────────────────────────────────


def _slots_by_product(db: Session, product_ids: Sequence) -> Dict[str, List[Tuple[MealSlot, List[MealSlotOption]]]]:
    out: Dict[str, List[Tuple[MealSlot, List[MealSlotOption]]]] = defaultdict(list)
    if not product_ids:
        return out
    slots = (
        db.query(MealSlot)
        .filter(MealSlot.product_id.in_(list(product_ids)))
        .order_by(MealSlot.sort_order)
        .all()
    )
    options: Dict[str, List[MealSlotOption]] = defaultdict(list)
    if slots:
        for o in (
            db.query(MealSlotOption)
            .filter(MealSlotOption.slot_id.in_([s.id for s in slots]))
            .order_by(MealSlotOption.sort_order)
            .all()
        ):
            options[str(o.slot_id)].append(o)
    for s in slots:
        out[str(s.product_id)].append((s, options.get(str(s.id), [])))
    return out


def meal_out(db: Session, product_id) -> Dict[str, Any]:
    slots = _slots_by_product(db, [_as_uuid(product_id)]).get(str(product_id), [])
    pids = {str(o.product_id) for _, opts in slots for o in opts}
    names = (
        {str(p.id): (p.name, p.price) for p in db.query(Product).filter(Product.id.in_([_as_uuid(i) for i in pids]))}
        if pids
        else {}
    )
    return {
        "slots": [
            {
                "id": str(s.id),
                "name": s.name,
                "quantity": s.quantity or s.max_select,
                "minSelect": s.min_select,
                "maxSelect": s.max_select,
                "allowRepeat": bool(s.allow_repeat),
                "deferred": bool(s.deferred),
                "refillable": bool(s.refillable),
                "maxRefills": s.max_refills,
                "options": [
                    {
                        "productId": str(o.product_id),
                        "productName": names.get(str(o.product_id), (None, None))[0],
                        "productPrice": _money(names.get(str(o.product_id), (None, 0))[1]),
                        "upcharge": _money(o.upcharge),
                        "isDefault": bool(o.is_default),
                    }
                    for o in opts
                ],
            }
            for s, opts in slots
        ],
    }


def meal_product_ids(db: Session, tenant_id) -> Set[str]:
    return {str(r[0]) for r in db.query(MealSlot.product_id).filter(MealSlot.tenant_id == tenant_id).distinct()}


def set_meal(db: Session, user: User, tenant_id, product: Product, body: MealIn) -> None:
    """
    The meal's slots, replacing what was there. A component cannot itself be a meal, and
    a product that is a component of some meal cannot become one: a meal inside a meal
    would need its own slots inside a slot.
    """
    check_target_write(db, user, product)
    component_ids = {str(o.product_id) for s in body.slots for o in s.options}
    _check_products(db, tenant_id, component_ids)
    meals = meal_product_ids(db, tenant_id) - {str(product.id)}
    if str(product.id) in component_ids or component_ids & meals:
        raise _bad(MEAL_IN_MEAL)
    if body.slots:
        used = (
            db.query(MealSlotOption.id)
            .join(MealSlot, MealSlot.id == MealSlotOption.slot_id)
            .filter(MealSlotOption.product_id == product.id, MealSlot.product_id != product.id)
            .first()
        )
        if used is not None:
            raise _bad(MEAL_IN_MEAL)
    existing = {str(s.id): s for s in db.query(MealSlot).filter(MealSlot.product_id == product.id).all()}
    kept: Set[str] = set()
    for index, slot in enumerate(body.slots):
        row = existing.get(str(slot.id)) if slot.id is not None else None
        if row is None:
            row = MealSlot(id=uuid.uuid4(), tenant_id=tenant_id, product_id=product.id)
            db.add(row)
        kept.add(str(row.id))
        row.name = slot.name
        row.quantity = slot.quantity
        row.min_select = slot.min_select
        row.max_select = slot.max_select
        row.allow_repeat = slot.allow_repeat
        row.deferred = slot.deferred
        row.refillable = slot.refillable
        row.max_refills = slot.max_refills
        row.sort_order = index
        db.flush()
        db.query(MealSlotOption).filter(MealSlotOption.slot_id == row.id).delete(synchronize_session=False)
        for oi, opt in enumerate(slot.options):
            db.add(MealSlotOption(
                id=uuid.uuid4(), slot_id=row.id, product_id=opt.product_id,
                upcharge=opt.upcharge, is_default=opt.is_default, sort_order=oi,
            ))
    for key, row in existing.items():
        if key not in kept:
            db.query(MealSlotOption).filter(MealSlotOption.slot_id == row.id).delete(synchronize_session=False)
            db.delete(row)
    db.flush()


# ── Courses ───────────────────────────────────────────────────────────────────


def course_out(c: MenuCourse) -> Dict[str, Any]:
    return {"id": str(c.id), "name": c.name, "sortOrder": c.sort_order or 0, "isActive": bool(c.is_active),
            "companyId": _s(c.company_id)}


def list_courses(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    visible = _visible_company_ids(db, user)
    rows = [
        c for c in db.query(MenuCourse).filter(MenuCourse.tenant_id == tenant_id)
        .order_by(MenuCourse.sort_order, MenuCourse.name).all()
        if _visible(c, visible)
    ]
    by_company: Dict[Optional[str], List[Dict[str, Any]]] = defaultdict(list)
    for c in rows:
        by_company[_s(c.company_id)].append(course_out(c))
    names = _company_names(db, [k for k in by_company if k])
    return {
        "items": [course_out(c) for c in rows],
        "groups": [
            {"companyId": k, "companyName": names.get(k) if k else None, "courses": v,
             "canEdit": may_write_company(db, user, tenant_id, _as_uuid(k))}
            for k, v in by_company.items()
        ],
    }


def replace_courses(db: Session, user: User, tenant_id, body: CoursesIn) -> None:
    check_company_write(db, user, tenant_id, body.company_id)
    q = db.query(MenuCourse).filter(MenuCourse.tenant_id == tenant_id)
    q = q.filter(MenuCourse.company_id.is_(None) if body.company_id is None else MenuCourse.company_id == body.company_id)
    existing = {str(c.id): c for c in q.all()}
    kept: Set[str] = set()
    for index, course in enumerate(body.courses):
        row = existing.get(str(course.id)) if course.id is not None else None
        if row is None:
            row = MenuCourse(id=uuid.uuid4(), tenant_id=tenant_id, company_id=body.company_id)
            db.add(row)
        kept.add(str(row.id))
        row.name = course.name
        row.is_active = course.is_active
        row.sort_order = index
        row.updated_at = _now()
    for key, row in existing.items():
        if key not in kept:
            db.delete(row)
    db.flush()
    bump(db, tenant_id)


def _check_course(db: Session, tenant_id, course_id) -> None:
    if course_id is None:
        return
    found = db.query(MenuCourse.id).filter(MenuCourse.id == course_id, MenuCourse.tenant_id == tenant_id).first()
    if found is None:
        raise _bad(UNKNOWN_COURSE)


# ── The product / category form sections ─────────────────────────────────────


def product_menu_out(db: Session, user: User, tenant_id, product: Product) -> Dict[str, Any]:
    meals_using = (
        db.query(Product.name)
        .join(MealSlot, MealSlot.product_id == Product.id)
        .join(MealSlotOption, MealSlotOption.slot_id == MealSlot.id)
        .filter(MealSlotOption.product_id == product.id)
        .distinct()
        .all()
    )
    return {
        "productId": str(product.id),
        "allergens": [a for a in (product.allergens or []) if a in ALLERGENS],
        "courseId": _s(product.course_id),
        "links": links_out(db, tenant_id, "product", product),
        "notes": notes_out(db, tenant_id, "product", product),
        "meal": meal_out(db, product.id),
        "componentOf": sorted({r[0] for r in meals_using}),
        "maxPerOrder": getattr(product, "max_per_order", None),
        "refillable": bool(getattr(product, "refillable", False)),
        "maxRefills": getattr(product, "max_refills", None),
        "canEdit": _may_target(db, user, product),
    }


def _may_target(db: Session, user: User, target) -> bool:
    try:
        check_target_write(db, user, target)
    except HTTPException:
        return False
    return True


def set_product_menu(db: Session, user: User, tenant_id, product: Product, body: ProductMenuIn) -> None:
    check_target_write(db, user, product)
    touched = False
    if body.allergens is not None:
        product.allergens = list(body.allergens) or None
        touched = True
    if body.set_course:
        _check_course(db, tenant_id, body.course_id)
        product.course_id = body.course_id
        touched = True
    if body.set_limits:
        product.max_per_order = body.max_per_order
        product.refillable = body.refillable
        product.max_refills = body.max_refills if body.refillable else None
        touched = True
    if body.links is not None:
        set_links(db, user, tenant_id, "product", product, body.links)
    if body.notes is not None:
        set_target_notes(db, user, tenant_id, "product", product, body.notes)
    if body.meal is not None:
        set_meal(db, user, tenant_id, product, body.meal)
    if touched:
        # The product row itself carries allergens and the course: a delta pull resends it.
        product.updated_at = _now()
    db.flush()
    bump(db, tenant_id)


def category_menu_out(db: Session, user: User, tenant_id, category: Category) -> Dict[str, Any]:
    return {
        "categoryId": str(category.id),
        "courseId": _s(category.course_id),
        "links": links_out(db, tenant_id, "category", category),
        "notes": notes_out(db, tenant_id, "category", category),
        "canEdit": _may_target(db, user, category),
    }


def set_category_menu(db: Session, user: User, tenant_id, category: Category, body: CategoryMenuIn) -> None:
    check_target_write(db, user, category)
    if body.set_course:
        _check_course(db, tenant_id, body.course_id)
        category.course_id = body.course_id
        category.updated_at = _now()
    if body.links is not None:
        set_links(db, user, tenant_id, "category", category, body.links)
    if body.notes is not None:
        set_target_notes(db, user, tenant_id, "category", category, body.notes)
    db.flush()
    bump(db, tenant_id)


# ── Upsell rules ──────────────────────────────────────────────────────────────


def get_upsell(db: Session, tenant_id, rule_id) -> UpsellRule:
    ident = _as_uuid(rule_id)
    row = (
        db.query(UpsellRule).filter(UpsellRule.id == ident, UpsellRule.tenant_id == tenant_id).first()
        if ident is not None
        else None
    )
    if row is None:
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return row


def upsell_options(r: UpsellRule) -> List[Dict[str, str]]:
    """
    What the rule offers, in order: `[{"type": "product" | "category", "id"}]`. A rule
    from before options offers its one product.
    """
    out = []
    for o in r.options or []:
        if isinstance(o, dict) and o.get("type") in ("product", "category") and o.get("id"):
            out.append({"type": o["type"], "id": str(o["id"])})
    if not out and r.product_id is not None:
        out.append({"type": "product", "id": str(r.product_id)})
    return out


def upsell_out(r: UpsellRule, names: Dict[str, str], can_edit: bool) -> Dict[str, Any]:
    options = upsell_options(r)
    return {
        "id": str(r.id),
        "name": r.name,
        "companyId": _s(r.company_id),
        "triggerType": r.trigger_type,
        "triggerIds": [str(i) for i in (r.trigger_ids or [])],
        "triggerNames": [names.get(str(i)) for i in (r.trigger_ids or [])],
        "action": r.action,
        "productId": _s(r.product_id),
        "productName": names.get(str(r.product_id)) if r.product_id is not None else None,
        "options": [{**o, "name": names.get(o["id"])} for o in options],
        "prompt": r.prompt,
        "display": r.display or "card",
        "where": r.place or "both",
        "skipIfPresent": True if r.skip_if_present is None else bool(r.skip_if_present),
        "oncePerOrder": bool(r.once_per_order),
        "message": r.message,
        "showPrice": bool(r.show_price),
        "startTime": r.start_time,
        "endTime": r.end_time,
        "weekdays": r.weekdays,
        "priority": r.priority or 0,
        "isActive": bool(r.is_active),
        "canEdit": can_edit,
        "updatedAt": _iso(r.updated_at),
    }


def _upsell_names(db: Session, rules: List[UpsellRule]) -> Dict[str, str]:
    product_ids: Set[uuid.UUID] = set()
    category_ids: Set[uuid.UUID] = set()
    for r in rules:
        if r.product_id is not None:
            product_ids.add(r.product_id)
        for i in r.trigger_ids or []:
            ident = _as_uuid(i)
            if ident is None:
                continue
            (product_ids if r.trigger_type == "product" else category_ids).add(ident)
        for o in upsell_options(r):
            ident = _as_uuid(o["id"])
            if ident is not None:
                (product_ids if o["type"] == "product" else category_ids).add(ident)
    names: Dict[str, str] = {}
    if product_ids:
        names.update({str(p.id): p.name for p in db.query(Product).filter(Product.id.in_(product_ids))})
    if category_ids:
        names.update({str(c.id): c.name for c in db.query(Category).filter(Category.id.in_(category_ids))})
    return names


def list_upsells(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    visible = _visible_company_ids(db, user)
    rows = [
        r for r in db.query(UpsellRule).filter(UpsellRule.tenant_id == tenant_id)
        .order_by(UpsellRule.priority.desc(), UpsellRule.name).all()
        if _visible(r, visible)
    ]
    names = _upsell_names(db, rows)
    return {
        "items": [upsell_out(r, names, may_write_company(db, user, tenant_id, r.company_id)) for r in rows],
        "canCreate": user.role in WRITE_ROLES,
    }


def one_upsell_out(db: Session, user: User, tenant_id, r: UpsellRule) -> Dict[str, Any]:
    return upsell_out(r, _upsell_names(db, [r]), may_write_company(db, user, tenant_id, r.company_id))


def _apply_upsell(db: Session, tenant_id, r: UpsellRule, body: UpsellIn) -> None:
    options = body.options or []
    _check_products(db, tenant_id, [o.id for o in options if o.type == "product"])
    _check_categories(db, tenant_id, [o.id for o in options if o.type == "category"])
    if body.trigger_type == "product":
        _check_products(db, tenant_id, body.trigger_ids)
    elif body.trigger_type == "category":
        _check_categories(db, tenant_id, body.trigger_ids)
    r.name = body.name
    r.company_id = body.company_id
    r.trigger_type = body.trigger_type
    r.trigger_ids = [str(i) for i in body.trigger_ids]
    r.action = body.action
    r.product_id = body.product_id
    # A rule of one product keeps `options` null: exactly what it was before options.
    legacy = len(options) == 1 and options[0].type == "product"
    r.options = None if legacy else [{"type": o.type, "id": str(o.id)} for o in options]
    r.prompt = body.prompt
    r.display = body.display
    r.place = body.where
    r.skip_if_present = body.skip_if_present
    r.once_per_order = body.once_per_order
    r.message = body.message
    r.show_price = body.show_price
    r.start_time = body.start_time
    r.end_time = body.end_time
    r.weekdays = body.weekdays
    r.priority = body.priority
    r.is_active = body.is_active
    r.updated_at = _now()


def create_upsell(db: Session, user: User, tenant_id, body: UpsellIn) -> UpsellRule:
    check_company_write(db, user, tenant_id, body.company_id)
    r = UpsellRule(id=uuid.uuid4(), tenant_id=tenant_id)
    _apply_upsell(db, tenant_id, r, body)
    db.add(r)
    db.flush()
    bump(db, tenant_id)
    return r


def update_upsell(db: Session, user: User, tenant_id, r: UpsellRule, body: UpsellIn) -> UpsellRule:
    check_company_write(db, user, tenant_id, r.company_id)
    check_company_write(db, user, tenant_id, body.company_id)
    _apply_upsell(db, tenant_id, r, body)
    db.flush()
    bump(db, tenant_id)
    return r


def delete_upsell(db: Session, user: User, tenant_id, r: UpsellRule) -> None:
    check_company_write(db, user, tenant_id, r.company_id)
    db.delete(r)
    db.flush()
    bump(db, tenant_id)


# ── The till's copy (`menu` in the catalog pull) ─────────────────────────────


def _till_companies(db: Session, machine: POSMachine) -> Set[str]:
    """The till's shop's company and every company above it."""
    if machine.shop_id is None:
        return set()
    row = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).first()
    company_id = row[0] if row else None
    if company_id is None:
        return set()
    return {str(company_id)} | {str(c) for c in ancestor_company_ids(db, company_id)}


def _reaches(row, companies: Set[str]) -> bool:
    company = getattr(row, "company_id", None)
    return company is None or str(company) in companies


def include_menu(db: Session, machine: POSMachine, since: Optional[datetime]) -> bool:
    """A full pull always carries the menu; a delta pull when it changed after `since`."""
    if since is None:
        return True
    changed = menu_changed_at(db, machine.tenant_id)
    if changed is None:
        return False
    since_utc = since if since.tzinfo is not None else since.replace(tzinfo=timezone.utc)
    return changed > since_utc


def menu_block(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """
    Everything the till needs to take an order, whole (`docs/SPEC_MENU_MODIFIERS.md` §10.1):
    groups with their options, the category / product links (`[]` = explicit none; absent
    = inherit), note chips, meals, upsells (category triggers already expanded to their
    sub-categories) and courses — limited to what reaches the till's company.
    """
    tenant_id = machine.tenant_id
    companies = _till_companies(db, machine)
    groups = [
        g for g in db.query(ModifierGroup)
        .filter(ModifierGroup.tenant_id == tenant_id, ModifierGroup.is_active.is_(True))
        .order_by(ModifierGroup.sort_order, ModifierGroup.name)
        .all()
        if _reaches(g, companies)
    ]
    group_ids = {str(g.id) for g in groups}
    options = _options_by_group(db, [g.id for g in groups])

    links: Dict[str, Dict[str, List[str]]] = {"categories": {}, "products": {}}
    rows = (
        db.query(ModifierLink)
        .filter(ModifierLink.tenant_id == tenant_id)
        .order_by(ModifierLink.target_type, ModifierLink.target_id, ModifierLink.sort_order)
        .all()
    )
    for link in rows:
        bucket = links["categories" if link.target_type == "category" else "products"]
        ids = bucket.setdefault(str(link.target_id), [])
        if link.group_id is not None and str(link.group_id) in group_ids:
            ids.append(str(link.group_id))

    notes: Dict[str, Any] = {"all": [], "categories": {}, "products": {}}
    for n in (
        db.query(PrepNotePreset)
        .filter(PrepNotePreset.tenant_id == tenant_id)
        .order_by(PrepNotePreset.target_type, PrepNotePreset.sort_order)
        .all()
    ):
        chip = {"text": n.text, "important": bool(n.is_important)}
        if n.target_type == "all":
            if _reaches(n, companies):
                notes["all"].append(chip)
        else:
            bucket = notes["categories" if n.target_type == "category" else "products"]
            bucket.setdefault(str(n.target_id), []).append(chip)

    meals: Dict[str, List[Dict[str, Any]]] = {}
    meal_ids = [r[0] for r in db.query(MealSlot.product_id).filter(MealSlot.tenant_id == tenant_id).distinct()]
    for pid, slots in _slots_by_product(db, meal_ids).items():
        meals[pid] = [
            {
                "id": str(s.id),
                "name": s.name,
                "quantity": s.quantity or s.max_select,
                "minSelect": s.min_select,
                "maxSelect": s.max_select,
                "allowRepeat": bool(s.allow_repeat),
                "deferred": bool(s.deferred),
                "refillable": bool(s.refillable),
                "maxRefills": s.max_refills,
                "options": [
                    {"productId": str(o.product_id), "upcharge": _money(o.upcharge), "isDefault": bool(o.is_default)}
                    for o in opts
                ],
            }
            for s, opts in slots
        ]

    from app.services.promotions import _category_tree, _with_descendants

    children = _category_tree(db, tenant_id)
    upsells = []
    for r in (
        db.query(UpsellRule)
        .filter(UpsellRule.tenant_id == tenant_id, UpsellRule.is_active.is_(True))
        .order_by(UpsellRule.priority.desc(), UpsellRule.name)
        .all()
    ):
        if not _reaches(r, companies):
            continue
        triggers = [str(i) for i in (r.trigger_ids or [])]
        if r.trigger_type == "category":
            triggers = _with_descendants(triggers, children)
        display = "popup" if r.trigger_type == "order" else (r.display or "card")
        place = r.place or "both"
        # A till that predates "חלון בחירה" reads `productId` only: it gets the rules it
        # can honour as they are (one product, the card, both places, a product or
        # category trigger) and skips the rest (a null productId).
        legacy = (
            r.product_id is not None and display == "card" and place == "both"
            and r.trigger_type in ("product", "category")
        )
        upsells.append({
            "id": str(r.id),
            "name": r.name,
            "triggerType": r.trigger_type,
            "triggerIds": triggers,
            "action": r.action,
            "productId": str(r.product_id) if legacy else None,
            "message": r.message,
            "showPrice": bool(r.show_price),
            "startTime": r.start_time,
            "endTime": r.end_time,
            "weekdays": r.weekdays,
            "priority": r.priority or 0,
            # A category option arrives with its sub-categories, as the triggers do.
            "options": [
                {**o, "categoryIds": _with_descendants([o["id"]], children)} if o["type"] == "category" else o
                for o in upsell_options(r)
            ],
            "prompt": r.prompt,
            "display": display,
            "where": place,
            "skipIfPresent": True if r.skip_if_present is None else bool(r.skip_if_present),
            "oncePerOrder": bool(r.once_per_order),
        })

    # Order limits and refills per product (§3.9), only for the products that have one —
    # also on the product rows, but here so a till keeps them with the rest of the menu.
    limits = {
        str(p.id): {
            "maxPerOrder": p.max_per_order,
            "refillable": bool(p.refillable),
            "maxRefills": p.max_refills,
        }
        for p in db.query(Product)
        .filter(
            Product.tenant_id == tenant_id,
            or_(Product.max_per_order.isnot(None), Product.refillable.is_(True)),
        )
        .all()
    }

    courses = [
        {"id": str(c.id), "name": c.name, "sortOrder": c.sort_order or 0}
        for c in db.query(MenuCourse)
        .filter(MenuCourse.tenant_id == tenant_id, MenuCourse.is_active.is_(True))
        .order_by(MenuCourse.sort_order, MenuCourse.name)
        .all()
        if _reaches(c, companies)
    ]

    return {
        "updatedAt": _iso(menu_changed_at(db, tenant_id)),
        "groups": [
            {
                "id": str(g.id),
                "name": g.name,
                "kind": g.kind,
                "minSelect": g.min_select or 0,
                "maxSelect": g.max_select,
                "freeCount": g.free_count or 0,
                "allowQuantity": bool(g.allow_quantity),
                "allowPre": bool(g.allow_pre),
                "options": [
                    {
                        "id": str(o.id),
                        "name": o.name,
                        "kitchenName": o.kitchen_name,
                        "price": _money(o.price),
                        "isDefault": bool(o.is_default),
                        "allergens": [a for a in (o.allergens or []) if a in ALLERGENS],
                        "linkedProductId": _s(o.linked_product_id),
                        "maxQty": o.max_qty,
                    }
                    for o in options.get(str(g.id), [])
                    if o.is_active
                ],
            }
            for g in groups
        ],
        "links": links,
        "notes": notes,
        "meals": meals,
        "upsells": upsells,
        "courses": courses,
        "productLimits": limits,
    }


# ── Choosing: validation and price (the till's rules, mirrored for tests) ────


@dataclass
class Pick:
    option_id: str
    qty: int = 1
    pre: Optional[str] = None


@dataclass
class GroupRules:
    min_select: int = 0
    max_select: Optional[int] = None
    free_count: int = 0
    allow_quantity: bool = False
    allow_pre: bool = False
    #: option id → price in agorot
    prices: Dict[str, int] = field(default_factory=dict)
    #: option id → the most of it in one dish (absent: no limit of its own)
    limits: Dict[str, int] = field(default_factory=dict)

    @classmethod
    def of(cls, g: ModifierGroup, options: Sequence[ModifierOption]) -> "GroupRules":
        return cls(
            min_select=g.min_select or 0,
            max_select=g.max_select,
            free_count=g.free_count or 0,
            allow_quantity=bool(g.allow_quantity),
            allow_pre=bool(g.allow_pre),
            prices={str(o.id): _agorot(o.price) for o in options if o.is_active},
            limits={str(o.id): o.max_qty for o in options if o.is_active and o.max_qty},
        )


def _agorot(value) -> int:
    try:
        return int((Decimal(str(value or 0)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return 0


def validate_picks(rules: GroupRules, picks: Sequence[Pick]) -> List[str]:
    """Why these choices do not answer the group; [] when they do."""
    errors: List[str] = []
    seen: Set[str] = set()
    units = 0
    per_option: Dict[str, int] = defaultdict(int)
    for p in picks:
        if p.option_id in rules.prices and p.qty > 0:
            per_option[p.option_id] += p.qty
    for option_id, total in per_option.items():
        limit = rules.limits.get(option_id)
        if limit is not None and total > limit:
            errors.append("option_above_max")
    for p in picks:
        if p.option_id not in rules.prices:
            errors.append("unknown_option")
            continue
        if p.qty < 1:
            errors.append("bad_quantity")
            continue
        if p.qty > 1 and not rules.allow_quantity:
            errors.append("quantity_not_allowed")
        if p.option_id in seen and not rules.allow_quantity:
            errors.append("duplicate_option")
        seen.add(p.option_id)
        if p.pre is not None and (not rules.allow_pre or p.pre not in PRE_MODIFIERS):
            errors.append("pre_not_allowed")
        units += p.qty
    if units < rules.min_select:
        errors.append("below_min")
    if rules.max_select is not None and units > rules.max_select:
        errors.append("above_max")
    return errors


def price_picks(rules: GroupRules, picks: Sequence[Pick]) -> List[int]:
    """
    What each pick costs per unit of the dish, in agorot. "הרבה" doubles a unit's price;
    the group's `free_count` units are free — the cheapest units, whatever order they
    were picked in (ties: the earlier pick), so editing a line never changes its price.
    """
    units: List[Tuple[int, int, int]] = []  # (price, pick index, unit index)
    for i, p in enumerate(picks):
        price = rules.prices.get(p.option_id, 0) * (2 if p.pre == "extra" else 1)
        for u in range(max(p.qty, 0)):
            units.append((price, i, u))
    free = set()
    for unit in sorted(units, key=lambda t: (t[0], t[1], t[2]))[: max(rules.free_count, 0)]:
        free.add(unit)
    charged = [0] * len(picks)
    for unit in units:
        if unit not in free:
            charged[unit[1]] += unit[0]
    return charged


# ── Sold lines: details and parts ────────────────────────────────────────────


def clean_details(details: Any) -> Optional[Dict[str, Any]]:
    """The details as stored: an object of bounded size, else nothing (the line is kept)."""
    if not isinstance(details, dict) or not details:
        return None
    try:
        raw = json.dumps(details, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None
    if len(raw.encode("utf-8")) > DETAILS_MAX_BYTES:
        logger.warning("line details dropped: %d bytes", len(raw.encode("utf-8")))
        return None
    return json.loads(raw)


def largest_remainder(total: int, weights: Sequence[int]) -> List[int]:
    """
    `total` agorot split by `weights`, exactly: each its floor share, then the agorot left
    to the largest fractions (ties: the earlier one). No positive weight: equal shares.
    """
    n = len(weights)
    if n == 0:
        return []
    if total == 0:
        return [0] * n
    sign = 1 if total > 0 else -1
    remaining = abs(total)
    w = [max(int(x), 0) for x in weights]
    if sum(w) <= 0:
        w = [1] * n
    whole = sum(w)
    shares = [remaining * x // whole for x in w]
    fractions = [remaining * x % whole for x in w]
    left = remaining - sum(shares)
    for i in sorted(range(n), key=lambda k: (-fractions[k], k))[:left]:
        shares[i] += 1
    return [sign * s for s in shares]


@dataclass
class ComponentShare:
    gross: int
    discount: int


def allocate_meal(
    gross: int,
    discount: int,
    quantity: Decimal,
    components: Sequence[Dict[str, Any]],
) -> List[ComponentShare]:
    """
    A meal line's money over its components, in agorot (docs/SPEC_MENU_MODIFIERS.md §5.2):
    what a component's own upcharge and paid modifiers came to goes to it whole; the rest —
    the meal's base price — is split by the components' list prices; the line's discount
    by the gross shares. The components always add up to the line exactly.
    """
    extras: List[int] = []
    weights: List[int] = []
    for c in components:
        qty = _dec(c.get("qty"), Decimal("1"))
        per_unit = _dec(c.get("upcharge"), Decimal("0")) + sum(
            (_dec(m.get("charged"), Decimal("0")) for m in _list(c.get("modifiers"))), Decimal("0")
        )
        extras.append(_agorot(per_unit * qty * quantity))
        weights.append(_agorot(_dec(c.get("listPrice"), Decimal("0")) * qty))
    base = gross - sum(extras)
    if base < 0:
        # The line came to less than its extras (a hand-entered price, say): split it all
        # by what each component would have cost.
        shares = largest_remainder(gross, [w + e for w, e in zip(weights, extras)])
    else:
        shares = [b + e for b, e in zip(largest_remainder(base, weights), extras)]
    discounts = largest_remainder(discount, shares)
    return [ComponentShare(g, d) for g, d in zip(shares, discounts)]


def _dec(value, default: Decimal) -> Decimal:
    if value is None:
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return default


def _list(value) -> List[Dict[str, Any]]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def _cents(agorot: int) -> Decimal:
    return (Decimal(agorot) / 100).quantize(CENT)


def _modifier_parts(
    transaction_id, item_id, base_product_id, modifiers, line_qty: Decimal, unit_qty: Decimal,
    component_index: Optional[int],
) -> List[TransactionItemPart]:
    out: List[TransactionItemPart] = []
    for m in modifiers:
        qty = _dec(m.get("qty"), Decimal("1"))
        units = qty * unit_qty * line_qty
        charged = _dec(m.get("charged"), _dec(m.get("price"), Decimal("0")) * qty)
        out.append(TransactionItemPart(
            id=uuid.uuid4(),
            transaction_id=transaction_id,
            item_id=item_id,
            kind="modifier",
            component_index=component_index,
            product_id=_as_uuid(m.get("linkedProductId")),
            base_product_id=_as_uuid(base_product_id),
            group_id=_as_uuid(m.get("groupId")),
            group_name=(str(m.get("groupName"))[:100] if m.get("groupName") else None),
            option_id=_as_uuid(m.get("optionId")),
            name=(str(m.get("name"))[:255] if m.get("name") else None),
            modifier_kind=(str(m.get("kind"))[:16] if m.get("kind") else None),
            pre=(str(m.get("pre"))[:16] if m.get("pre") else None),
            quantity=units.quantize(Decimal("0.001")),
            unit_price=_dec(m.get("price"), Decimal("0")).quantize(CENT),
            gross=_cents(_agorot(charged * unit_qty * line_qty)),
            discount=None,
        ))
    return out


def parts_for_item(transaction_id, item) -> List[TransactionItemPart]:
    """
    One sold line taken apart: its modifiers, and — on a meal — its components with the
    line's gross and discounts allocated to them, and their own modifiers.
    """
    details = getattr(item, "details", None)
    if not isinstance(details, dict):
        return []
    line_qty = _dec(getattr(item, "quantity", None), Decimal("1"))
    out = _modifier_parts(
        transaction_id, item.id, getattr(item, "product_id", None),
        _list(details.get("modifiers")), line_qty, Decimal("1"), None,
    )
    meal = details.get("meal")
    components = _list(meal.get("components")) if isinstance(meal, dict) else []
    if components:
        gross = _agorot(getattr(item, "total_price", 0))
        discount = _agorot(getattr(item, "discount", None) or 0) + _agorot(
            getattr(item, "promotion_discount", None) or 0
        )
        shares = allocate_meal(gross, discount, line_qty, components)
        for index, (c, share) in enumerate(zip(components, shares)):
            qty = _dec(c.get("qty"), Decimal("1"))
            out.append(TransactionItemPart(
                id=uuid.uuid4(),
                transaction_id=transaction_id,
                item_id=item.id,
                kind="component",
                component_index=index,
                product_id=_as_uuid(c.get("productId")),
                base_product_id=_as_uuid(getattr(item, "product_id", None)),
                name=(str(c.get("name"))[:255] if c.get("name") else None),
                quantity=(qty * line_qty).quantize(Decimal("0.001")),
                unit_price=_dec(c.get("upcharge"), Decimal("0")).quantize(CENT),
                gross=_cents(share.gross),
                discount=_cents(share.discount),
            ))
            out.extend(_modifier_parts(
                transaction_id, item.id, c.get("productId"), _list(c.get("modifiers")),
                line_qty, qty, index,
            ))
    return out


def replace_item_parts(db: Session, transaction_id, items) -> None:
    """A re-push is the whole document: its parts are rebuilt like its lines."""
    db.query(TransactionItemPart).filter(
        TransactionItemPart.transaction_id == transaction_id
    ).delete(synchronize_session=False)
    rows: List[TransactionItemPart] = []
    for item in items or []:
        try:
            rows.extend(parts_for_item(transaction_id, item))
        except Exception:  # pragma: no cover - a report detail never fails a document
            logger.exception("line parts skipped item=%s", getattr(item, "id", None))
    if rows:
        db.bulk_save_objects(rows)


# ── Upsell statistics from the tills ─────────────────────────────────────────


def record_upsell_stats(db: Session, machine: POSMachine, body: UpsellStatsIn) -> Dict[str, Any]:
    """
    The till's counts per rule and local day, as totals so far: stored as the larger of
    what is held and what came, so a retried or late report never counts twice.
    """
    saved = 0
    for s in body.stats:
        try:
            day = date.fromisoformat(s.day)
        except ValueError:
            continue
        row = (
            db.query(UpsellStat)
            .filter(UpsellStat.machine_id == machine.id, UpsellStat.rule_id == s.rule_id, UpsellStat.day == day)
            .first()
        )
        if row is None:
            row = UpsellStat(
                id=uuid.uuid4(), tenant_id=machine.tenant_id, machine_id=machine.id,
                shop_id=machine.shop_id, rule_id=s.rule_id, day=day, shown=0, accepted=0, dismissed=0,
                declined=0,
            )
            db.add(row)
        row.shown = max(row.shown or 0, s.shown)
        row.accepted = max(row.accepted or 0, s.accepted)
        row.dismissed = max(row.dismissed or 0, s.dismissed)
        row.declined = max(row.declined or 0, s.declined)
        if s.accepted_options:
            merged = dict(row.accepted_options or {})
            for key, count in s.accepted_options.items():
                merged[key] = max(int(merged.get(key) or 0), count)
            row.accepted_options = merged
        row.updated_at = _now()
        saved += 1
    db.flush()
    return {"saved": saved}


# ── Reports ───────────────────────────────────────────────────────────────────


def _empty(window) -> Dict[str, Any]:
    return {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": _now().isoformat(),
    }


def _scoped_tx(db: Session, user: User, tenant_id, window, shop_id=None, machine_id=None):
    from app.services.reports import _is_refund_condition, build_scoped_transaction_query

    tx_q = build_scoped_transaction_query(db, user, tenant_id, window, shop_id=shop_id, machine_id=machine_id)
    if tx_q is None:
        return None
    return tx_q.with_entities(
        Transaction.id.label("tx_id"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()


def build_modifier_sales_report(db: Session, user: User, tenant_id, window, *, shop_id=None, machine_id=None) -> Dict[str, Any]:
    """דוח מכירות תוספות: how often each option was chosen and what it brought in."""
    out = _empty(window)
    out.update({"totals": {"units": 0.0, "revenue": 0.0, "refunds": 0.0, "net": 0.0, "removals": 0.0}, "rows": []})
    tx = _scoped_tx(db, user, tenant_id, window, shop_id, machine_id)
    if tx is None:
        return out
    P = TransactionItemPart
    is_refund = tx.c.is_refund
    rows = (
        db.query(
            P.group_id, P.group_name, P.option_id, P.name, P.modifier_kind,
            func.coalesce(func.sum(case((is_refund.is_(False), P.quantity), else_=0)), 0).label("sold"),
            func.coalesce(func.sum(case((is_refund.is_(True), P.quantity), else_=0)), 0).label("refunded"),
            func.coalesce(func.sum(case((is_refund.is_(False), P.gross), else_=0)), 0).label("revenue"),
            func.coalesce(func.sum(case((is_refund.is_(True), P.gross), else_=0)), 0).label("refunds"),
            func.count(func.distinct(P.item_id)).label("lines"),
        )
        .join(tx, tx.c.tx_id == P.transaction_id)
        .filter(P.kind == "modifier")
        .group_by(P.group_id, P.group_name, P.option_id, P.name, P.modifier_kind)
        .all()
    )
    merged: Dict[str, Dict[str, Any]] = {}
    for gid, gname, oid, name, kind, sold, refunded, revenue, refunds, lines in rows:
        key = str(oid) if oid is not None else f"{gname}|{name}"
        row = merged.setdefault(key, {
            "groupId": _s(gid), "groupName": gname, "optionId": _s(oid), "name": name, "kind": kind,
            "unitsSold": 0.0, "unitsRefunded": 0.0, "revenue": 0.0, "refunds": 0.0, "lines": 0,
        })
        row["unitsSold"] += float(sold or 0)
        row["unitsRefunded"] += float(refunded or 0)
        row["revenue"] += float(revenue or 0)
        row["refunds"] += float(refunds or 0)
        row["lines"] += int(lines or 0)
    # Current names over the snapshot, where the option still exists.
    live = {}
    option_ids = [_as_uuid(r["optionId"]) for r in merged.values() if r["optionId"]]
    if option_ids:
        for o, g in (
            db.query(ModifierOption, ModifierGroup)
            .join(ModifierGroup, ModifierGroup.id == ModifierOption.group_id)
            .filter(ModifierOption.id.in_(option_ids))
        ):
            live[str(o.id)] = (o.name, g.name, g.kind)
    totals = out["totals"]
    result = []
    for row in merged.values():
        if row["optionId"] in live:
            row["name"], row["groupName"], row["kind"] = live[row["optionId"]]
        row["unitsNet"] = row["unitsSold"] - row["unitsRefunded"]
        row["net"] = round(row["revenue"] - row["refunds"], 2)
        row["revenue"] = round(row["revenue"], 2)
        row["refunds"] = round(row["refunds"], 2)
        totals["units"] += row["unitsSold"]
        totals["revenue"] += row["revenue"]
        totals["refunds"] += row["refunds"]
        if row["kind"] == "removal":
            totals["removals"] += row["unitsSold"]
        result.append(row)
    totals["net"] = round(totals["revenue"] - totals["refunds"], 2)
    totals["revenue"] = round(totals["revenue"], 2)
    totals["refunds"] = round(totals["refunds"], 2)
    result.sort(key=lambda r: (-r["unitsSold"], r["name"] or ""))
    out["rows"] = result
    return out


def build_meal_sales_report(db: Session, user: User, tenant_id, window, *, shop_id=None, machine_id=None) -> Dict[str, Any]:
    """דוח ארוחות: each meal, and what it was made of with the money allocated to each part."""
    out = _empty(window)
    out.update({
        "totals": {"units": 0.0, "gross": 0.0, "discounts": 0.0, "refunds": 0.0, "net": 0.0, "unredeemed": 0.0},
        "rows": [],
    })
    tx = _scoped_tx(db, user, tenant_id, window, shop_id, machine_id)
    if tx is None:
        return out
    P = TransactionItemPart
    is_refund = tx.c.is_refund
    # A meal line is one whose details carry a meal — read here rather than in SQL, as
    # the JSON is not queryable the same way on every database, and a meal whose items
    # are all still to be taken has no component parts to find it by.
    lines = (
        db.query(
            TransactionItem.product_id, TransactionItem.product_name, TransactionItem.quantity,
            TransactionItem.total_price, TransactionItem.discount, TransactionItem.promotion_discount,
            is_refund, TransactionItem.details,
        )
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .filter(TransactionItem.details.isnot(None))
        .all()
    )
    rows: Dict[str, Dict[str, Any]] = {}
    for pid, pname, qty, total, discount, promo, refund, details in lines:
        if not isinstance(details, dict) or not isinstance(details.get("meal"), dict):
            continue
        key = str(pid) if pid is not None else f"name:{pname}"
        row = rows.setdefault(key, {
            "productId": _s(pid), "name": pname, "unitsSold": 0.0, "unitsRefunded": 0.0,
            "gross": 0.0, "discounts": 0.0, "refunds": 0.0, "components": {},
        })
        if refund:
            row["unitsRefunded"] += float(qty or 0)
            row["refunds"] += float(total or 0)
        else:
            row["unitsSold"] += float(qty or 0)
            row["gross"] += float(total or 0)
            row["discounts"] += float(discount or 0) + float(promo or 0)
    parts = (
        db.query(
            P.base_product_id, P.product_id, P.name,
            func.coalesce(func.sum(case((is_refund.is_(False), P.quantity), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), P.gross), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), P.discount), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), P.unit_price * P.quantity), else_=0)), 0),
        )
        .join(tx, tx.c.tx_id == P.transaction_id)
        .filter(P.kind == "component")
        .group_by(P.base_product_id, P.product_id, P.name)
        .all()
    )
    for meal_id, pid, name, units, gross, discount, upcharges in parts:
        row = rows.get(str(meal_id)) if meal_id is not None else None
        if row is None:
            continue
        comp = row["components"].setdefault(str(pid) if pid else f"name:{name}", {
            "productId": _s(pid), "name": name, "units": 0.0, "gross": 0.0, "discounts": 0.0, "upcharges": 0.0,
        })
        comp["units"] += float(units or 0)
        comp["gross"] += float(gross or 0)
        comp["discounts"] += float(discount or 0)
        comp["upcharges"] += float(upcharges or 0)
    # What the meals included and nobody took (the till writes each meal line's
    # entitlements when the document is written), and what was taken later or refilled
    # (lines of their own that name their meal) — docs/SPEC_MENU_MODIFIERS.md §3.9.
    sale_items = (
        db.query(TransactionItem.product_id, TransactionItem.quantity, TransactionItem.details)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .filter(tx.c.is_refund.is_(False), TransactionItem.details.isnot(None))
        .all()
    )
    for pid, quantity, details in sale_items:
        if not isinstance(details, dict):
            continue
        row = rows.get(str(pid)) if pid is not None else None
        if row is not None:
            for e in _list(details.get("entitlements")):
                remaining = _dec(e.get("remaining"), Decimal("0"))
                if remaining > 0:
                    key = str(e.get("slotName") or e.get("slotId") or "")
                    row.setdefault("unredeemed", {})
                    row["unredeemed"][key] = row["unredeemed"].get(key, 0.0) + float(remaining)
        ref = details.get("mealRef")
        if isinstance(ref, dict):
            meal_row = rows.get(str(ref.get("mealProductId") or ""))
            if meal_row is not None:
                field_name = "refills" if ref.get("kind") == "refill" else "takenLater"
                meal_row[field_name] = meal_row.get(field_name, 0.0) + float(quantity or 0)
    names = {}
    ids = [_as_uuid(r["productId"]) for r in rows.values() if r["productId"]]
    ids += [_as_uuid(c["productId"]) for r in rows.values() for c in r["components"].values() if c["productId"]]
    ids = [i for i in ids if i is not None]
    if ids:
        names = {str(p.id): p.name for p in db.query(Product).filter(Product.id.in_(ids))}
    totals = out["totals"]
    result = []
    for row in rows.values():
        row["name"] = names.get(row["productId"] or "", row["name"])
        row["unitsNet"] = row["unitsSold"] - row["unitsRefunded"]
        row["net"] = round(row["gross"] - row["discounts"] - row["refunds"], 2)
        comps = []
        for c in row["components"].values():
            c["name"] = names.get(c["productId"] or "", c["name"])
            c["net"] = round(c["gross"] - c["discounts"], 2)
            for k in ("gross", "discounts", "upcharges"):
                c[k] = round(c[k], 2)
            comps.append(c)
        comps.sort(key=lambda c: -c["gross"])
        row["components"] = comps
        row["unredeemed"] = [
            {"slotName": k, "count": v} for k, v in sorted(row.get("unredeemed", {}).items())
        ]
        row.setdefault("takenLater", 0.0)
        row.setdefault("refills", 0.0)
        totals["unredeemed"] = totals.get("unredeemed", 0.0) + sum(u["count"] for u in row["unredeemed"])
        for k in ("gross", "discounts", "refunds"):
            row[k] = round(row[k], 2)
            totals[k] += row[k]
        totals["units"] += row["unitsSold"]
        result.append(row)
    totals["net"] = round(totals["gross"] - totals["discounts"] - totals["refunds"], 2)
    for k in ("gross", "discounts", "refunds"):
        totals[k] = round(totals[k], 2)
    result.sort(key=lambda r: -r["net"])
    out["rows"] = result
    return out


def build_upsell_report(db: Session, user: User, tenant_id, window, *, shop_id=None, machine_id=None) -> Dict[str, Any]:
    """
    דוח הגדלות מכירה: per rule — shown, taken, dismissed ("לא, תודה" / ✕), declined
    ("הלקוח סירב"), the rate, what the taken lines sold for, and which options were taken.
    """
    from app.services.overview import _visible_shops_query

    out = _empty(window)
    totals = {
        "shown": 0, "accepted": 0, "dismissed": 0, "declined": 0, "acceptanceRate": None,
        "revenue": 0.0, "lines": 0,
    }
    out.update({"totals": totals, "rows": []})
    shops = _visible_shops_query(db, user, tenant_id)
    if shops is None:
        return out
    stats_q = db.query(
        UpsellStat.rule_id,
        func.coalesce(func.sum(UpsellStat.shown), 0),
        func.coalesce(func.sum(UpsellStat.accepted), 0),
        func.coalesce(func.sum(UpsellStat.dismissed), 0),
        func.coalesce(func.sum(UpsellStat.declined), 0),
    ).filter(
        UpsellStat.tenant_id == tenant_id,
        UpsellStat.day >= window.from_date,
        UpsellStat.day <= window.to_date,
    )
    if user.role not in TENANT_WIDE_ROLES:
        visible_shops = [r[0] for r in shops.with_entities(Shop.id).all()]
        stats_q = stats_q.filter(UpsellStat.shop_id.in_(visible_shops or [uuid.uuid4()]))
    if shop_id is not None:
        stats_q = stats_q.filter(UpsellStat.shop_id == shop_id)
    if machine_id is not None:
        stats_q = stats_q.filter(UpsellStat.machine_id == machine_id)
    rows: Dict[str, Dict[str, Any]] = {}

    def row_for(rule_id) -> Dict[str, Any]:
        return rows.setdefault(str(rule_id), {
            "ruleId": str(rule_id), "name": None, "action": None, "productName": None,
            "shown": 0, "accepted": 0, "dismissed": 0, "declined": 0, "revenue": 0.0, "lines": 0,
            "optionsTaken": [],
        })

    for rule_id, shown, accepted, dismissed, declined in stats_q.group_by(UpsellStat.rule_id).all():
        r = row_for(rule_id)
        r["shown"] += int(shown or 0)
        r["accepted"] += int(accepted or 0)
        r["dismissed"] += int(dismissed or 0)
        r["declined"] += int(declined or 0)

    # Which options were taken, per rule (the tills' per-option counts, summed).
    per_option: Dict[str, Dict[str, int]] = {}
    for rule_id, taken in stats_q.with_entities(UpsellStat.rule_id, UpsellStat.accepted_options).filter(
        UpsellStat.accepted_options.isnot(None)
    ).all():
        bucket = per_option.setdefault(str(rule_id), {})
        for key, count in (taken or {}).items():
            bucket[str(key)] = bucket.get(str(key), 0) + int(count or 0)

    tx = _scoped_tx(db, user, tenant_id, window, shop_id, machine_id)
    if tx is not None:
        for rule_id, revenue, count in (
            db.query(
                TransactionItem.upsell_rule_id,
                func.coalesce(func.sum(
                    TransactionItem.total_price
                    - func.coalesce(TransactionItem.discount, 0)
                    - func.coalesce(TransactionItem.promotion_discount, 0)
                ), 0),
                func.count(TransactionItem.id),
            )
            .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
            .filter(TransactionItem.upsell_rule_id.isnot(None), tx.c.is_refund.is_(False))
            .group_by(TransactionItem.upsell_rule_id)
            .all()
        ):
            r = row_for(rule_id)
            r["revenue"] += float(revenue or 0)
            r["lines"] += int(count or 0)

    rule_ids = [_as_uuid(k) for k in rows]
    rules = {str(r.id): r for r in db.query(UpsellRule).filter(UpsellRule.id.in_([i for i in rule_ids if i]))} if rule_ids else {}
    names = _upsell_names(db, list(rules.values()))
    taken_ids = {_as_uuid(k) for b in per_option.values() for k in b} - {None}
    if taken_ids:
        names.update({str(p.id): p.name for p in db.query(Product).filter(Product.id.in_(taken_ids))})
    result = []
    for key, r in rows.items():
        rule = rules.get(key)
        if rule is not None:
            r["name"] = rule.name
            r["action"] = rule.action
            r["productName"] = (
                names.get(str(rule.product_id)) if rule.product_id is not None
                else ", ".join(n for n in (names.get(o["id"]) for o in upsell_options(rule)) if n) or None
            )
        r["optionsTaken"] = sorted(
            ({"productId": pid, "name": names.get(pid), "count": n} for pid, n in per_option.get(key, {}).items() if n),
            key=lambda o: (-o["count"], o["name"] or ""),
        )
        r["acceptanceRate"] = round(r["accepted"] / r["shown"], 4) if r["shown"] else None
        r["revenue"] = round(r["revenue"], 2)
        for k in ("shown", "accepted", "dismissed", "declined", "lines"):
            totals[k] += r[k]
        totals["revenue"] += r["revenue"]
        result.append(r)
    totals["revenue"] = round(totals["revenue"], 2)
    totals["acceptanceRate"] = round(totals["accepted"] / totals["shown"], 4) if totals["shown"] else None
    result.sort(key=lambda r: (-r["accepted"], -r["shown"]))
    out["rows"] = result
    return out
