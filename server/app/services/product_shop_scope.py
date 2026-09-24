"""Where a global product is sold: the one place a product's shop scope is applied.

A global product reaches a shop's till only through a `shop_product_overrides` row for
(shop, product) — see `_products_merged_for_shop_machine` in `app/services/sync.py`. Those
rows used to be added one product x one shop at a time from the assortment page. A
product's *shop scope* adds them for you:

* ``mode = "company"`` is a **rule**, not a snapshot: "every active shop of company X",
  and, when `shop_scope_include_subcompanies` is set, of every company beneath X. It
  creates rows for today's shops, and a shop opened later — or moved into X's subtree —
  gets rows for every product whose rule covers it.
* ``mode = "shops"`` is an explicit list. Nothing is ever added on its own.
* ``mode = None`` is every product that predates this, managed by hand exactly as before.
  Nothing in this module touches such a product.

Rules this module keeps, and the tests pin:

* **The scope only touches its own rows** (`assigned_by_rule = True`). A row somebody
  added by hand is never listed, unlisted or deleted by a rule.
* **A price is never overwritten.** A row that exists is left with the price it has; a
  new row starts on the base price (`price = None`).
* **Leaving scope unlists, it never deletes.** The row stays, with its per-shop price, so
  a shop that comes back into scope picks up where it left off — and that is also why a
  rule row the rule itself unlisted is listed again when its shop is back in scope.
* **A deactivated shop is not "out of scope".** It gets no new rows, and the rows it has
  are left alone; reactivating it runs the rule for it again.
* **Sibling isolation.** A product may only ever be on a shop whose company is the
  product's company or a descendant of it (`product_allowed_in_shop`), whatever the
  scope says. A tenant-wide product (no company) may be on any shop of its tenant.

Permissions are the routers' business: this module plans a change (`ScopePlan`) without
writing anything, so a router can check every shop the plan touches and refuse the whole
request before a row moves. The hooks run on shop and company events apply rules without
a user check — the rule was authorised when it was set.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Set

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine, PairingStatus
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.services.company_hierarchy import ancestor_company_ids, descendant_company_ids

MODE_COMPANY = "company"
MODE_SHOPS = "shops"
MODES = frozenset({MODE_COMPANY, MODE_SHOPS})


def _key(value) -> Optional[str]:
    return None if value is None else str(value)


def _same(a, b) -> bool:
    return a is not None and b is not None and str(a) == str(b)


# ── Where a product may be sold at all ───────────────────────────────────────


def product_allowed_in_shop(db: Session, product, shop) -> bool:
    """
    May `product` be on `shop`'s till at all?

    A catalog is inherited *downwards*: a product defined on the holding company is sold
    by every branch beneath it (`catalog_company_ids` in company_hierarchy). So the shop's
    company must be the product's company or one of its descendants. A sibling company's
    product is neither, and is refused.
    """
    if _key(product.tenant_id) != _key(shop.tenant_id):
        return False
    if product.company_id is None:
        return True
    if _same(product.company_id, shop.company_id):
        return True  # the common case never touches the database
    return any(_same(cid, shop.company_id) for cid in descendant_company_ids(db, product.company_id))


def scope_company_allowed(db: Session, product, company_id) -> bool:
    """May a rule on `product` name `company_id`? Only a company its shops may sell it."""
    if company_id is None:
        return False
    if product.company_id is None:
        return True
    return any(_same(cid, company_id) for cid in descendant_company_ids(db, product.company_id))


# ── Which shops a scope covers ───────────────────────────────────────────────


def scope_company_ids(db: Session, company_id, include_subcompanies: bool) -> List[uuid.UUID]:
    """The companies a rule on `company_id` covers."""
    if company_id is None:
        return []
    if include_subcompanies:
        return descendant_company_ids(db, company_id)
    return [company_id]


def shops_for_company_scope(
    db: Session,
    product,
    company_id,
    include_subcompanies: bool,
    *,
    active_only: bool = True,
) -> List[Shop]:
    """Shops of the scope's companies, in the product's tenant, that may sell it."""
    company_ids = scope_company_ids(db, company_id, include_subcompanies)
    if not company_ids:
        return []
    q = db.query(Shop).filter(
        Shop.tenant_id == product.tenant_id,
        Shop.company_id.in_(company_ids),
    )
    if active_only:
        q = q.filter(Shop.is_active.is_(True))
    shops = q.order_by(Shop.name).all()
    return [s for s in shops if product_allowed_in_shop(db, product, s)]


def shops_in_scope(db: Session, product) -> List[Shop]:
    """The active shops `product`'s rule covers. Empty unless the product has a rule."""
    if product.shop_scope_mode != MODE_COMPANY or product.shop_scope_company_id is None:
        return []
    return shops_for_company_scope(
        db,
        product,
        product.shop_scope_company_id,
        bool(product.shop_scope_include_subcompanies),
        active_only=True,
    )


def machine_count(db: Session, shop_ids: Iterable) -> int:
    """Assigned, active tills in these shops — "on N tills" in the product form."""
    ids = [sid for sid in shop_ids if sid is not None]
    if not ids:
        return 0
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id.in_(ids),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.is_active.is_(True),
        )
        .count()
    )


# ── Planning a change ────────────────────────────────────────────────────────


@dataclass
class ScopePlan:
    """What applying a scope would do. Nothing is written until `execute_plan`."""

    create: List[uuid.UUID] = field(default_factory=list)          # shop ids
    relist: List[ShopProductOverride] = field(default_factory=list)
    unlist: List[ShopProductOverride] = field(default_factory=list)
    adopt: List[ShopProductOverride] = field(default_factory=list)  # explicit list only

    def shop_ids(self) -> Set[str]:
        out = {str(sid) for sid in self.create}
        for rows in (self.relist, self.unlist, self.adopt):
            out.update(str(r.shop_id) for r in rows)
        return out

    def is_empty(self) -> bool:
        return not (self.create or self.relist or self.unlist or self.adopt)


def _rows_for_product(db: Session, product) -> List[ShopProductOverride]:
    if product.id is None:
        return []
    return (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.global_product_id == product.id)
        .all()
    )


def _reconcile(
    rows: List[ShopProductOverride],
    add_ids: Iterable,
    keep_ids: Set[str],
    *,
    adopt_hand_rows: bool,
    only_shop_ids: Optional[Set[str]] = None,
) -> ScopePlan:
    """
    `add_ids`: shops that should sell the product. `keep_ids`: shops still inside the
    scope (a superset of `add_ids` — it also holds inactive shops, whose rows are left
    alone). Rule rows outside `keep_ids` are unlisted. `only_shop_ids` narrows the whole
    reconciliation to those shops, for the shop and company hooks.
    """
    plan = ScopePlan()
    by_shop = {str(r.shop_id): r for r in rows}

    def in_reach(sid: str) -> bool:
        return only_shop_ids is None or sid in only_shop_ids

    seen: Set[str] = set()
    for raw in add_ids:
        sid = str(raw)
        if sid in seen or not in_reach(sid):
            continue
        seen.add(sid)
        row = by_shop.get(sid)
        if row is None:
            plan.create.append(raw if isinstance(raw, uuid.UUID) else uuid.UUID(sid))
        elif row.assigned_by_rule:
            if not row.is_listed:
                plan.relist.append(row)
        elif adopt_hand_rows:
            # Chosen explicitly in "only these shops": the list owns the row from now
            # on, so taking the shop off the list later unlists it again.
            plan.adopt.append(row)
        # else: a hand-added row inside a rule's scope — never touched.

    for row in rows:
        sid = str(row.shop_id)
        if not in_reach(sid):
            continue
        if row.assigned_by_rule and sid not in keep_ids and row.is_listed:
            plan.unlist.append(row)
    return plan


def plan_rule(db: Session, product, *, only_shop_ids: Optional[Set[str]] = None) -> ScopePlan:
    """What the product's `company` rule would change. Empty for any other mode."""
    if product.shop_scope_mode != MODE_COMPANY:
        return ScopePlan()
    covered = []
    if product.shop_scope_company_id is not None:
        covered = shops_for_company_scope(
            db,
            product,
            product.shop_scope_company_id,
            bool(product.shop_scope_include_subcompanies),
            active_only=False,
        )
    keep = {str(s.id) for s in covered}
    add = [s.id for s in covered if s.is_active]
    return _reconcile(
        _rows_for_product(db, product),
        add,
        keep,
        adopt_hand_rows=False,
        only_shop_ids=only_shop_ids,
    )


def plan_explicit(db: Session, product, shop_ids: Iterable) -> ScopePlan:
    """What setting "only these shops" would change."""
    ids = list(shop_ids)
    return _reconcile(
        _rows_for_product(db, product),
        ids,
        {str(i) for i in ids},
        adopt_hand_rows=True,
    )


def execute_plan(db: Session, product, plan: ScopePlan) -> Set[str]:
    """Write a plan. Returns the ids of every shop whose tills should re-pull."""
    for shop_id in plan.create:
        db.add(
            ShopProductOverride(
                shop_id=shop_id,
                global_product_id=product.id,
                price=None,
                is_listed=True,
                is_available=True,
                assigned_by_rule=True,
            )
        )
    for row in plan.relist:
        row.is_listed = True
    for row in plan.unlist:
        # Unlisted, not deleted: the per-shop price survives the shop leaving scope.
        row.is_listed = False
    for row in plan.adopt:
        row.is_listed = True
        row.assigned_by_rule = True
    return plan.shop_ids()


def apply_rule(db: Session, product, *, only_shop_ids: Optional[Set[str]] = None) -> Set[str]:
    """Bring the product's rows in line with its `company` rule. Idempotent."""
    return execute_plan(db, product, plan_rule(db, product, only_shop_ids=only_shop_ids))


# ── Setting a scope on a product ─────────────────────────────────────────────


def set_scope_fields(product, mode: str, company_id=None, include_subcompanies: bool = False) -> None:
    if mode not in MODES:
        raise ValueError(f"unknown shop scope mode: {mode!r}")
    product.shop_scope_mode = mode
    if mode == MODE_COMPANY:
        product.shop_scope_company_id = company_id
        product.shop_scope_include_subcompanies = bool(include_subcompanies)
    else:
        product.shop_scope_company_id = None
        product.shop_scope_include_subcompanies = False


def plan_scope_change(db: Session, product, mode: str, *, shop_ids: Iterable = ()) -> ScopePlan:
    """The plan for the scope now set on `product` (see `set_scope_fields`)."""
    if mode == MODE_COMPANY:
        return plan_rule(db, product)
    return plan_explicit(db, product, shop_ids)


# ── Hooks: a shop appears, moves, or its company moves ───────────────────────


def _products_touching_shops(db: Session, shops: List[Shop]) -> List[Product]:
    """
    Products whose rule may need to change a row in these shops: rules naming one of
    the shops' companies or an ancestor of one (the rule itself decides whether its
    sub-companies count), plus any rule that already has a row there — which is how a
    shop leaving a rule's scope is found.
    """
    if not shops:
        return []
    tenant_ids = {_key(s.tenant_id) for s in shops}
    company_ids: List = []
    seen: Set[str] = set()
    shop_companies = {str(s.company_id): s.company_id for s in shops if s.company_id is not None}
    for own in shop_companies.values():  # one ancestor walk per company, not per shop
        for cid in [own] + ancestor_company_ids(db, own):
            if cid is not None and str(cid) not in seen:
                seen.add(str(cid))
                company_ids.append(cid)

    products: List[Product] = []
    picked: Set[str] = set()

    def take(rows):
        for p in rows:
            if str(p.id) in picked or _key(p.tenant_id) not in tenant_ids:
                continue
            picked.add(str(p.id))
            products.append(p)

    if company_ids:
        take(
            db.query(Product)
            .filter(
                Product.shop_scope_mode == MODE_COMPANY,
                Product.shop_scope_company_id.in_(company_ids),
            )
            .all()
        )

    rule_product_ids = [
        r.global_product_id
        for r in db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id.in_([s.id for s in shops]),
            ShopProductOverride.assigned_by_rule.is_(True),
        )
        .all()
    ]
    if rule_product_ids:
        take(
            db.query(Product)
            .filter(
                Product.id.in_(rule_product_ids),
                Product.shop_scope_mode == MODE_COMPANY,
            )
            .all()
        )
    return products


def reconcile_shops(db: Session, shops: List[Shop]) -> Set[str]:
    """
    Apply every relevant rule to these shops only. Run when a shop is created, is
    reactivated, moves company, or its company moves under a new parent. Returns the
    shop ids that changed.
    """
    shops = [s for s in shops if s is not None]
    if not shops:
        return set()
    only = {str(s.id) for s in shops}
    touched: Set[str] = set()
    for product in _products_touching_shops(db, shops):
        touched |= apply_rule(db, product, only_shop_ids=only)
    return touched


def reconcile_company_subtree(db: Session, company_id) -> Set[str]:
    """After `company_id` moved in the tree: re-run the rules for every shop beneath it."""
    company_ids = descendant_company_ids(db, company_id)
    if not company_ids:
        return set()
    shops = db.query(Shop).filter(Shop.company_id.in_(company_ids)).all()
    return reconcile_shops(db, shops)
