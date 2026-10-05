"""
"תפריט דמה" — loading a demo menu into a company, and removing exactly what was loaded
(docs/SPEC_TRAINING_MODE.md). The content is data: app/services/demo_menu_templates.py.

**Load** (`load`): into a company, products at the company level as the dashboard makes
them, each with a shop scope — `{"mode": "shops", "shopIds": [shop]}` when loaded for one
shop (the shop page's card), the company rule otherwise — because a global product
reaches a till only through its scope (`shop_product_overrides`): without one it would sit
in the catalog and appear on no till. Categories and products go through the dashboard's
own router functions (`app.routers.categories.create_category`,
`app.routers.products.create_product`: the same permissions, SKUs and scope), the menu
through the menu service the menu router calls (groups with removal / choice / addon,
`allowPre`, `allowQuantity`, `maxQty`, options linked to products; product menus with
note chips and meals; courses; upsells). The company's chips for every dish and its
courses are *added to* (by name), never replaced: what the company had stays untouched.

Every row a load creates is recorded in `demo_menu_items` (load id, template, entity type
and id), committed with the row itself. A load that fails half-way removes what it had
created. One load per scope: a shop that already has a demo menu (its own, or the
company's) is refused (409 `demo_menu_loaded`).

**Remove** (`remove`): deletes what the load recorded and nothing else, whatever was
edited since (prices…). Except:

* a product already sold in a **real** transaction is made inactive (`is_available`
  false) instead of deleted — training sales never reach `transaction_items`, so in
  training this does not happen; so is a product something not loaded still uses (a meal
  of the customer's own, an upsell of theirs) or that the database refuses to delete;
* a category that still holds a product (kept, or the customer's own) is made inactive;
* a group or course something not loaded still uses is kept.

Works with or without training mode. Who: as for training mode (the super admin, a
distributor, the company's manager).
"""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.company import Company
from app.models.menu import (
    MealSlot,
    MealSlotOption,
    MenuCourse,
    ModifierGroup,
    ModifierLink,
    ModifierOption,
    PrepNotePreset,
    UpsellRule,
)
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_category_override import ShopCategoryOverride
from app.models.shop_product_override import ShopProductOverride
from app.models.training import DemoMenuItem
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.services import demo_menu_templates as T

logger = logging.getLogger(__name__)

#: `demo_menu_items.entity_type`, in the order a removal goes through them.
UPSELL = "upsell"
MODIFIER_GROUP = "modifier_group"
PRODUCT = "product"
CATEGORY = "category"
COURSE = "course"
PREP_NOTE = "prep_note"
ENTITY_TYPES = (UPSELL, MODIFIER_GROUP, PRODUCT, CATEGORY, COURSE, PREP_NOTE)

#: The 409 / 422 codes (`detail.code`).
ALREADY_LOADED = "demo_menu_loaded"
UNKNOWN_TEMPLATE = "unknown_template"
UNKNOWN_LOAD = "unknown_load"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


# ── Permissions ───────────────────────────────────────────────────────────────


def can_manage(db: Session, user: User, company_id: Any) -> bool:
    from app.services.company_hierarchy import user_covers_company

    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if user.role == UserRole.COMPANY_MANAGER:
        return bool(user_covers_company(db, user, company_id))
    return False


def check_manage(db: Session, user: User, company_id: Any) -> None:
    if not can_manage(db, user, company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


# ── The plan: what a template creates ─────────────────────────────────────────


def _placeholder(name: str) -> uuid.UUID:
    """A stable stand-in id for a name, to validate the plan with the real schemas."""
    return uuid.uuid5(uuid.NAMESPACE_URL, f"demo-menu:{name}")


def plan(template: str) -> Dict[str, Any]:
    """
    Everything `template` creates, by name, already filtered to what it has — and checked
    with the same schemas the load uses, so a load never fails on its own data.
    """
    from app.schemas.menu import GroupIn, SlotIn

    spec = T.TEMPLATES.get(template)
    if spec is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": UNKNOWN_TEMPLATE})
    wanted = list(spec["categories"])
    categories = [c for c in T.CATEGORIES if c[0] in wanted]
    categories.sort(key=lambda c: wanted.index(c[0]))
    products = {name for _c, _color, items in categories for name, _p in items}
    category_names = {c[0] for c in categories}

    # Meals: each slot keeps the products the template has; a slot left invalid goes.
    meals: Dict[str, List[Dict[str, Any]]] = {}
    for meal, slots in T.MEALS.items():
        if meal not in products:
            continue
        kept_slots = []
        for slot in slots:
            options = [o for o in slot["options"] if o[0] in products]
            if not options:
                continue
            body = {k: v for k, v in slot.items() if k != "options"}
            body["options"] = options
            try:
                SlotIn.model_validate({
                    **{k: v for k, v in body.items() if k != "options"},
                    "options": [
                        {"productId": str(_placeholder(p)), "upcharge": str(up), "isDefault": d} for p, up, d in options
                    ],
                })
            except ValueError:
                continue
            kept_slots.append(body)
        if kept_slots:
            meals[meal] = kept_slots

    # Product menus, for the products the template has.
    menus: List[Dict[str, Any]] = []
    for entry in T.PRODUCT_MENUS:
        names = [p for p in entry["products"] if p in products]
        if names:
            menus.append({**entry, "products": names})

    # Groups: used by a category or a product menu of the template; linked options keep
    # only the products it has.
    used = {g for m in menus for g in (m.get("groups") or [])}
    groups: Dict[str, Dict[str, Any]] = {}
    for key, group in T.GROUPS.items():
        cats = [c for c in group.get("categories", []) if c in category_names]
        if not cats and key not in used:
            continue
        options = [o for o in group["options"] if o.get("linked") is None or o["linked"] in products]
        body = {k: v for k, v in group.items() if k not in ("options", "categories")}
        try:
            GroupIn.model_validate({
                **body,
                "options": [
                    {**{k: v for k, v in o.items() if k != "linked"},
                     **({"linkedProductId": str(_placeholder(o["linked"]))} if o.get("linked") else {})}
                    for o in options
                ],
            })
        except ValueError:
            continue
        if not options:
            continue
        groups[key] = {**body, "options": options, "categories": cats}
    for m in menus:
        if m.get("groups") is not None:
            m["groups"] = [g for g in m["groups"] if g in groups]
            if not m["groups"]:
                m.pop("groups")

    upsells = [
        u for u in T.UPSELLS
        if u["trigger"] in category_names and u["product"] in products
        and (u.get("templates") is None or template in u["templates"])
    ]
    category_courses = {c: course for c, course in T.CATEGORY_COURSES.items() if c in category_names}
    courses = [c for c in T.COURSES if c in set(category_courses.values())]
    return {
        "template": template,
        "name": spec["name"],
        "description": spec["description"],
        "categories": categories,
        "groups": groups,
        "menus": menus,
        "meals": meals,
        "notes": list(T.GLOBAL_NOTES),
        "courses": courses,
        "categoryCourses": category_courses,
        "upsells": upsells,
    }


def _plan_counts(p: Dict[str, Any]) -> Dict[str, int]:
    return {
        "categories": len(p["categories"]),
        "products": sum(len(items) for _c, _color, items in p["categories"]),
        "groups": len(p["groups"]),
        "meals": len(p["meals"]),
        "upsells": len(p["upsells"]),
        "notes": len(p["notes"]),
        "courses": len(p["courses"]),
    }


def templates_out() -> Dict[str, Any]:
    out = []
    for key in T.TEMPLATES:
        p = plan(key)
        out.append({"key": key, "name": p["name"], "description": p["description"], "counts": _plan_counts(p)})
    return {"templates": out}


# ── What is loaded ────────────────────────────────────────────────────────────


def _template_name(key: str) -> str:
    return T.TEMPLATES.get(key, {}).get("name", key)


def _loads(db: Session, rows: Sequence[DemoMenuItem]) -> List[Dict[str, Any]]:
    by_load: Dict[Any, List[DemoMenuItem]] = defaultdict(list)
    for r in rows:
        by_load[r.load_id].append(r)
    out = []
    for load_id, items in by_load.items():
        first = min(items, key=lambda r: r.created_at or _now())
        counts: Dict[str, int] = defaultdict(int)
        for r in items:
            counts[r.entity_type] += 1
        out.append({
            "loadId": str(load_id),
            "template": first.template,
            "templateName": _template_name(first.template),
            "companyId": str(first.company_id),
            "shopId": str(first.shop_id) if first.shop_id else None,
            "createdAt": _iso(first.created_at),
            "counts": dict(counts),
        })
    return sorted(out, key=lambda r: r["createdAt"] or "")


def loads_reaching(db: Session, company_id: Any, shop_id: Any = None) -> List[Dict[str, Any]]:
    """The loads of the company that reach `shop_id` (its own and the company's), or all."""
    q = db.query(DemoMenuItem).filter(DemoMenuItem.company_id == company_id)
    if shop_id is not None:
        q = q.filter((DemoMenuItem.shop_id == shop_id) | DemoMenuItem.shop_id.is_(None))
    return _loads(db, q.all())


def loads_for_shop(db: Session, shop: Shop) -> List[Dict[str, Any]]:
    return loads_reaching(db, shop.company_id, shop.id)


def status_out(db: Session, user: User, company_id: Any, shop_id: Any = None) -> Dict[str, Any]:
    loads = loads_reaching(db, company_id, shop_id)
    return {
        "companyId": str(company_id),
        "shopId": str(shop_id) if shop_id else None,
        "canManage": can_manage(db, user, company_id),
        "loaded": bool(loads),
        "loads": loads,
    }


# ── Load ──────────────────────────────────────────────────────────────────────


class _Loader:
    def __init__(self, db: Session, user: User, tenant_id, company: Company, shop: Optional[Shop], template: str):
        self.db = db
        self.user = user
        self.tenant_id = tenant_id
        self.company = company
        self.shop = shop
        self.template = template
        self.load_id = uuid.uuid4()
        self.counts: Dict[str, int] = defaultdict(int)

    def track(self, entity_type: str, entity_id: Any) -> None:
        self.db.add(DemoMenuItem(
            id=uuid.uuid4(),
            tenant_id=self.tenant_id,
            company_id=self.company.id,
            shop_id=self.shop.id if self.shop is not None else None,
            load_id=self.load_id,
            template=self.template,
            entity_type=entity_type,
            entity_id=entity_id if isinstance(entity_id, uuid.UUID) else uuid.UUID(str(entity_id)),
            created_by=getattr(self.user, "id", None),
            created_at=_now(),
        ))
        self.counts[entity_type] += 1

    def scope(self) -> Dict[str, Any]:
        if self.shop is not None:
            return {"mode": "shops", "shopIds": [str(self.shop.id)]}
        return {"mode": "company", "companyId": str(self.company.id)}

    def run(self, p: Dict[str, Any]) -> None:
        from app.routers import categories as RC
        from app.routers import products as RP
        from app.schemas.category import CategoryCreate
        from app.schemas.menu import CategoryMenuIn, GroupIn, ProductMenuIn, UpsellIn
        from app.schemas.product import ProductCreate
        from app.services import menu as M

        db, user, tenant_id, company_id = self.db, self.user, self.tenant_id, self.company.id
        top = db.query(func.max(Category.sort_order)).filter(
            Category.tenant_id == tenant_id, Category.company_id == company_id
        ).scalar() or 0

        # Categories and products: the dashboard's own endpoints (they commit each row;
        # the tracking row is committed right after, so nothing is ever left untracked).
        cat_ids: Dict[str, uuid.UUID] = {}
        prod: Dict[str, uuid.UUID] = {}
        for order, (cname, color, items) in enumerate(p["categories"], start=top + 1):
            c = RC.create_category(
                CategoryCreate(name=cname, color=color, sortOrder=order, companyId=company_id),
                current_user=user, active_tenant_id=tenant_id, db=db,
            )
            cat_ids[cname] = c.id
            self.track(CATEGORY, c.id)
            db.commit()
            for pname, price in items:
                product = RP.create_product(
                    ProductCreate.model_validate({
                        "name": pname, "price": str(price), "categoryId": str(c.id), "companyId": str(company_id),
                        # What puts a global product on the tills: without it, on none.
                        "shopScope": self.scope(),
                    }),
                    current_user=user, active_tenant_id=tenant_id, db=db,
                )
                prod[pname] = product.id
                self.track(PRODUCT, product.id)
                db.commit()

        # The menu, through the service the menu router calls — one transaction from here.
        group_ids: Dict[str, uuid.UUID] = {}
        for key, group in p["groups"].items():
            options = []
            for o in group["options"]:
                body = {k: v for k, v in o.items() if k != "linked"}
                if o.get("linked"):
                    body["linkedProductId"] = str(prod[o["linked"]])
                options.append(body)
            g = M.create_group(db, user, tenant_id, GroupIn.model_validate({
                **{k: v for k, v in group.items() if k not in ("options", "categories")},
                "companyId": str(company_id),
                "options": options,
                "categoryIds": [str(cat_ids[c]) for c in group["categories"]] or None,
            }))
            group_ids[key] = g.id
            self.track(MODIFIER_GROUP, g.id)

        products = {pid: db.get(Product, pid) for pid in prod.values()}
        for entry in p["menus"]:
            body: Dict[str, Any] = {}
            if entry.get("none"):
                body["links"] = {"mode": "none"}
            elif entry.get("groups"):
                body["links"] = {"mode": "groups", "groupIds": [str(group_ids[g]) for g in entry["groups"]]}
            if entry.get("notes"):
                body["notes"] = {"mode": "own", "notes": [{"text": t, "isImportant": i} for t, i in entry["notes"]]}
            if not body:
                continue
            for name in entry["products"]:
                M.set_product_menu(db, user, tenant_id, products[prod[name]], ProductMenuIn.model_validate(body))
        for meal, slots in p["meals"].items():
            M.set_product_menu(db, user, tenant_id, products[prod[meal]], ProductMenuIn.model_validate({"meal": {"slots": [
                {**{k: v for k, v in s.items() if k != "options"},
                 "options": [{"productId": str(prod[n]), "upcharge": str(up), "isDefault": d} for n, up, d in s["options"]]}
                for s in slots
            ]}}))

        # The chips for every dish and the courses: added to the company's, by name.
        have = {
            (n.text or "").strip().lower(): n
            for n in db.query(PrepNotePreset).filter(
                PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type == "all",
                PrepNotePreset.company_id == company_id,
            )
        }
        last = max((n.sort_order or 0 for n in have.values()), default=-1)
        for text, important in p["notes"]:
            if text.strip().lower() in have:
                continue
            last += 1
            note = PrepNotePreset(
                id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, target_type="all", target_id=None,
                text=text, is_important=important, sort_order=last,
            )
            db.add(note)
            self.track(PREP_NOTE, note.id)
        existing_courses = {
            (c.name or "").strip(): c
            for c in db.query(MenuCourse).filter(MenuCourse.tenant_id == tenant_id, MenuCourse.company_id == company_id)
        }
        last = max((c.sort_order or 0 for c in existing_courses.values()), default=-1)
        course_ids: Dict[str, uuid.UUID] = {}
        for name in p["courses"]:
            course = existing_courses.get(name)
            if course is None:
                last += 1
                course = MenuCourse(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, name=name,
                                    sort_order=last, is_active=True, updated_at=_now())
                db.add(course)
                self.track(COURSE, course.id)
            course_ids[name] = course.id
        db.flush()
        M.bump(db, tenant_id)
        for cname, course in p["categoryCourses"].items():
            category = db.get(Category, cat_ids[cname])
            M.set_category_menu(db, user, tenant_id, category, CategoryMenuIn.model_validate(
                {"courseId": str(course_ids[course]), "setCourse": True}
            ))

        for u in p["upsells"]:
            rule = M.create_upsell(db, user, tenant_id, UpsellIn.model_validate({
                "name": u["name"], "companyId": str(company_id), "triggerType": "category",
                "triggerIds": [str(cat_ids[u["trigger"]])], "action": "add", "productId": str(prod[u["product"]]),
                "message": u.get("message"),
            }))
            self.track(UPSELL, rule.id)
        db.flush()


def _company_and_shop(db: Session, tenant_id, company_id, shop_id) -> Tuple[Company, Optional[Shop]]:
    company = db.get(Company, company_id) if company_id else None
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    shop = None
    if shop_id is not None:
        shop = db.get(Shop, shop_id)
        if shop is None or str(shop.company_id) != str(company.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    return company, shop


def load(db: Session, user: User, tenant_id, company_id, shop_id, template: str) -> Dict[str, Any]:
    """
    Load `template` into the company (for one shop when `shop_id`). Commits. 409
    `demo_menu_loaded` when a demo menu already reaches that shop (or, for a company-wide
    load, the company already has one of its own); 422 `unknown_template`.
    """
    company, shop = _company_and_shop(db, tenant_id, company_id, shop_id)
    check_manage(db, user, company.id)
    p = plan(template)
    q = db.query(DemoMenuItem.load_id).filter(DemoMenuItem.company_id == company.id)
    if shop is not None:
        q = q.filter((DemoMenuItem.shop_id == shop.id) | DemoMenuItem.shop_id.is_(None))
    else:
        q = q.filter(DemoMenuItem.shop_id.is_(None))
    existing = q.first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": ALREADY_LOADED, "loadId": str(existing[0])},
        )

    loader = _Loader(db, user, tenant_id, company, shop, template)
    try:
        loader.run(p)
        db.commit()
    except Exception:
        # Whatever was committed before the failure is tracked: take it back out.
        db.rollback()
        logger.exception("Demo menu load %s (%s) failed; removing what it created", loader.load_id, template)
        try:
            remove(db, user, loader.load_id)
            db.commit()
        except Exception:  # pragma: no cover - best effort; the rows stay tracked
            db.rollback()
            logger.exception("Could not clean up demo menu load %s", loader.load_id)
        raise
    return {
        "loadId": str(loader.load_id),
        "template": template,
        "templateName": p["name"],
        "companyId": str(company.id),
        "shopId": str(shop.id) if shop is not None else None,
        "createdAt": _iso(_now()),
        "counts": dict(loader.counts),
    }


# ── Remove ────────────────────────────────────────────────────────────────────


def _rows_of(db: Session, load_id: Any) -> List[DemoMenuItem]:
    return db.query(DemoMenuItem).filter(DemoMenuItem.load_id == load_id).all()


def load_rows(db: Session, tenant_id, load_id: Any) -> List[DemoMenuItem]:
    rows = _rows_of(db, load_id)
    if not rows or str(rows[0].tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": UNKNOWN_LOAD})
    return rows


def _sold(db: Session, product_id: Any) -> bool:
    return db.query(TransactionItem.id).filter(TransactionItem.product_id == product_id).first() is not None


def _used_elsewhere(db: Session, product_id: Any, tracked_products: set, tracked_upsells: set) -> bool:
    """Something not loaded still names the product: a meal of theirs, an upsell of theirs."""
    meals = (
        db.query(MealSlot.product_id)
        .join(MealSlotOption, MealSlotOption.slot_id == MealSlot.id)
        .filter(MealSlotOption.product_id == product_id)
        .all()
    )
    if any(m[0] not in tracked_products for m in meals):
        return True
    rules = db.query(UpsellRule.id).filter(UpsellRule.product_id == product_id).all()
    return any(r[0] not in tracked_upsells for r in rules)


def _deactivate_product(p: Product) -> None:
    p.is_available = False
    p.updated_at = _now()


def _drop_menu_rows(db: Session, tenant_id, target_type: str, target_id: Any) -> None:
    """A product's or category's own links and chips (keyed by id, not by a foreign key)."""
    db.query(ModifierLink).filter(
        ModifierLink.tenant_id == tenant_id, ModifierLink.target_type == target_type, ModifierLink.target_id == target_id
    ).delete(synchronize_session=False)
    db.query(PrepNotePreset).filter(
        PrepNotePreset.tenant_id == tenant_id, PrepNotePreset.target_type == target_type,
        PrepNotePreset.target_id == target_id,
    ).delete(synchronize_session=False)


def remove(db: Session, user: Optional[User], load_id: Any) -> Dict[str, Any]:
    """Remove one load (see the module docstring). Does not commit."""
    from app.services import menu as M

    rows = _rows_of(db, load_id)
    deleted: Dict[str, int] = defaultdict(int)
    deactivated: Dict[str, int] = defaultdict(int)
    kept: Dict[str, int] = defaultdict(int)
    missing = 0
    if not rows:
        return {"deleted": {}, "deactivated": {}, "kept": {}, "missing": 0}
    tenant_id = rows[0].tenant_id
    ids: Dict[str, set] = defaultdict(set)
    for r in rows:
        ids[r.entity_type].add(r.entity_id)
    tracked_targets = ids[PRODUCT] | ids[CATEGORY]

    for rule_id in ids[UPSELL]:
        rule = db.get(UpsellRule, rule_id)
        if rule is None:
            missing += 1
            continue
        db.delete(rule)
        deleted[UPSELL] += 1
    db.flush()

    for group_id in ids[MODIFIER_GROUP]:
        group = db.get(ModifierGroup, group_id)
        if group is None:
            missing += 1
            continue
        foreign = [
            t for (t,) in db.query(ModifierLink.target_id).filter(ModifierLink.group_id == group_id)
            if t not in tracked_targets
        ]
        if foreign:
            kept[MODIFIER_GROUP] += 1
            continue
        db.query(ModifierLink).filter(ModifierLink.group_id == group_id).delete(synchronize_session=False)
        db.query(ModifierOption).filter(ModifierOption.group_id == group_id).delete(synchronize_session=False)
        db.delete(group)
        deleted[MODIFIER_GROUP] += 1
    db.flush()

    for product_id in ids[PRODUCT]:
        product = db.get(Product, product_id)
        if product is None:
            missing += 1
            continue
        if _sold(db, product_id) or _used_elsewhere(db, product_id, ids[PRODUCT], ids[UPSELL]):
            _deactivate_product(product)
            deactivated[PRODUCT] += 1
            continue
        try:
            with db.begin_nested():
                _drop_menu_rows(db, tenant_id, "product", product_id)
                # Its own meal (if it is one), and its place in the loaded meals.
                slot_ids = [s for (s,) in db.query(MealSlot.id).filter(MealSlot.product_id == product_id)]
                if slot_ids:
                    db.query(MealSlotOption).filter(MealSlotOption.slot_id.in_(slot_ids)).delete(synchronize_session=False)
                    db.query(MealSlot).filter(MealSlot.id.in_(slot_ids)).delete(synchronize_session=False)
                db.query(MealSlotOption).filter(MealSlotOption.product_id == product_id).delete(synchronize_session=False)
                db.query(ShopProductOverride).filter(
                    ShopProductOverride.global_product_id == product_id
                ).delete(synchronize_session=False)
                db.delete(product)
                db.flush()
        except IntegrityError:
            # Something else holds it (stock, a voucher…): inactive, not deleted.
            product = db.get(Product, product_id)
            if product is not None:
                _deactivate_product(product)
                deactivated[PRODUCT] += 1
            continue
        deleted[PRODUCT] += 1

    for category_id in ids[CATEGORY]:
        category = db.get(Category, category_id)
        if category is None:
            missing += 1
            continue
        holds = (
            db.query(Product.id).filter(Product.category_id == category_id).first() is not None
            or db.query(Category.id).filter(Category.parent_id == category_id).first() is not None
        )
        if not holds:
            try:
                with db.begin_nested():
                    _drop_menu_rows(db, tenant_id, "category", category_id)
                    db.query(ShopCategoryOverride).filter(
                        ShopCategoryOverride.category_id == category_id
                    ).delete(synchronize_session=False)
                    db.delete(category)
                    db.flush()
                deleted[CATEGORY] += 1
                continue
            except IntegrityError:
                category = db.get(Category, category_id)
        if category is not None:
            category.is_active = False
            category.updated_at = _now()
            deactivated[CATEGORY] += 1

    for course_id in ids[COURSE]:
        course = db.get(MenuCourse, course_id)
        if course is None:
            missing += 1
            continue
        in_use = (
            db.query(Category.id).filter(Category.course_id == course_id).first() is not None
            or db.query(Product.id).filter(Product.course_id == course_id).first() is not None
        )
        if in_use:
            kept[COURSE] += 1
            continue
        db.delete(course)
        deleted[COURSE] += 1

    for note_id in ids[PREP_NOTE]:
        note = db.get(PrepNotePreset, note_id)
        if note is None:
            missing += 1
            continue
        db.delete(note)
        deleted[PREP_NOTE] += 1

    db.query(DemoMenuItem).filter(DemoMenuItem.load_id == load_id).delete(synchronize_session=False)
    db.flush()
    M.bump(db, tenant_id)
    return {"deleted": dict(deleted), "deactivated": dict(deactivated), "kept": dict(kept), "missing": missing}


def remove_preview(db: Session, rows: Sequence[DemoMenuItem]) -> Dict[str, Any]:
    counts: Dict[str, int] = defaultdict(int)
    missing = 0
    sold = 0
    models = {
        UPSELL: UpsellRule, MODIFIER_GROUP: ModifierGroup, PRODUCT: Product,
        CATEGORY: Category, COURSE: MenuCourse, PREP_NOTE: PrepNotePreset,
    }
    for r in rows:
        model = models.get(r.entity_type)
        if model is None or db.get(model, r.entity_id) is None:
            missing += 1
            continue
        counts[r.entity_type] += 1
        if r.entity_type == PRODUCT and _sold(db, r.entity_id):
            sold += 1
    first = rows[0]
    return {
        "loadId": str(first.load_id),
        "template": first.template,
        "templateName": _template_name(first.template),
        "counts": dict(counts),
        "soldProducts": sold,
        "missing": missing,
    }


def remove_for_shop(db: Session, shop: Shop, user: Optional[User]) -> Optional[Dict[str, Any]]:
    """Every load that reaches the shop (the training wizard's "remove the demo menu")."""
    loads = loads_for_shop(db, shop)
    if not loads:
        return None
    total: Dict[str, Dict[str, int]] = {"deleted": defaultdict(int), "deactivated": defaultdict(int), "kept": defaultdict(int)}
    for entry in loads:
        result = remove(db, user, uuid.UUID(entry["loadId"]))
        for part in ("deleted", "deactivated", "kept"):
            for key, n in result[part].items():
                total[part][key] += n
    return {part: dict(v) for part, v in total.items()}


def catalog_targets(db: Session, tenant_id) -> List[Tuple[str, str]]:
    """The tills to wake after a load or a removal (catalog and menu), as the import does."""
    from app.services.catalog_import import catalog_targets as targets

    return targets(db, tenant_id)
