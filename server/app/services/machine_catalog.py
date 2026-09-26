"""Which of its shop's products a till sells: the one place the per-till catalog rule lives.

A till is in one of two modes (`pos_machines.catalog_mode`):

* ``all`` — the shop's whole catalog. The default, and every till's behaviour before
  per-till catalogs existed.
* ``selected`` — only the products on the till's whitelist (`machine_catalog_items`
  rows with ``is_included``) that are **also** in the shop's catalog. A whitelisted
  product the shop stops selling is gone from the till too; a product the shop starts
  selling later is *not* added — that is what a whitelist is for.

Three things sit outside the rule on purpose:

* **Locks still apply on top.** A whitelisted product that is locked (see
  `product_availability`) is on the till, dimmed and unsellable, exactly as today.
  This module never touches availability, and availability never looks here.
* **The general item is exempt.** The calculator sells through it and the calculator
  setting decides whether it is offered; hiding it here would break the calculator
  on a till in "selected" mode. `set_machine_catalog` never stores it.
* **Machine-local rows** (legacy rows owned by the till itself) are the till's own
  and always on it.

How it reaches the till: every product row in the catalog payload carries
`inMachineCatalog` — whether it is on this till's list, *regardless of the mode* — and
the payload carries the mode once at the top (`machineCatalog`). The till applies the
rule. Carrying the list independently of the mode means a change of mode needs no
product rows re-sent, and a till has the whole shop catalog on hand for its manager
screen, which edits the list.

Everything that needs an answer — the till sync, the watermark, the dashboard's
machine catalog page, the product page's "which tills sell it" — calls into here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session, joinedload
from sqlalchemy.sql import func

from app.models.machine_catalog_item import MachineCatalogItem
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shop_product_override import ShopProductOverride
from app.services import general_item
from app.services.catalog_notify import notify_machine_catalog_changed

MODE_ALL = "all"
MODE_SELECTED = "selected"
MODES = (MODE_ALL, MODE_SELECTED)


# ── The rule ─────────────────────────────────────────────────────────────────


def mode_of(machine) -> str:
    """The till's mode. Anything unexpected is "all": failing open here only shows more."""
    value = getattr(machine, "catalog_mode", None)
    return MODE_SELECTED if value == MODE_SELECTED else MODE_ALL


def on_till(mode: str, included: bool, is_general: bool = False) -> bool:
    """
    Is a product *of the till's shop* on the till?

    The caller has already established that the shop sells it; this decides only the
    till's own filter. Mirrored on the till in `MachineCatalog.onThisTill`.
    """
    if is_general:
        return True
    if mode != MODE_SELECTED:
        return True
    return bool(included)


# ── Reading ──────────────────────────────────────────────────────────────────


def _key(value) -> str:
    return str(value)


def catalog_items(db: Session, machine_id, product_ids: Optional[Iterable] = None) -> Dict[str, MachineCatalogItem]:
    """`{str(product_id): row}` for one till, all of its rows or those of `product_ids`."""
    if machine_id is None:
        return {}
    q = db.query(MachineCatalogItem).filter(MachineCatalogItem.machine_id == machine_id)
    if product_ids is not None:
        ids = list(product_ids)
        if not ids:
            return {}
        q = q.filter(MachineCatalogItem.product_id.in_(ids))
    return {_key(r.product_id): r for r in q.all()}


def included_ids(db: Session, machine_id) -> Set[str]:
    """The till's whitelist as stored, whether or not the shop still sells each product."""
    return {k for k, r in catalog_items(db, machine_id).items() if r.is_included}


def shop_catalog(db: Session, machine) -> List[Tuple[ShopProductOverride, Product]]:
    """
    The products the till's shop sells: its assortment rows over global catalog
    products of the till's own tenant — the same set the catalog sync starts from.
    """
    if machine is None or machine.shop_id is None or machine.tenant_id is None:
        return []
    return (
        db.query(ShopProductOverride, Product)
        .join(Product, Product.id == ShopProductOverride.global_product_id)
        .options(joinedload(Product.category))
        .filter(
            ShopProductOverride.shop_id == machine.shop_id,
            Product.tenant_id == machine.tenant_id,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
        )
        .order_by(Product.name)
        .all()
    )


def is_on_till(db: Session, machine, product) -> bool:
    """One product, one till: is it in the shop's catalog and through the till's filter?"""
    if machine is None or machine.shop_id is None:
        return False
    in_shop = (
        db.query(ShopProductOverride.id)
        .filter(
            ShopProductOverride.shop_id == machine.shop_id,
            ShopProductOverride.global_product_id == product.id,
        )
        .first()
        is not None
    )
    if not in_shop:
        return False
    row = catalog_items(db, machine.id, [product.id]).get(_key(product.id))
    return on_till(mode_of(machine), bool(row and row.is_included), general_item.is_general(product))


def last_change(db: Session, machine) -> Optional[datetime]:
    """Newest change to this till's catalog filter: its mode or any list row."""
    item_max = (
        db.query(func.max(MachineCatalogItem.updated_at))
        .filter(MachineCatalogItem.machine_id == machine.id)
        .scalar()
    )
    points = [p for p in (item_max, getattr(machine, "catalog_mode_updated_at", None)) if p is not None]
    return max(points, key=_as_comparable) if points else None


def _as_comparable(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── Writing ──────────────────────────────────────────────────────────────────


class NotInShopCatalog(ValueError):
    """Some requested products are not in the till's shop's catalog (or not this tenant's)."""

    def __init__(self, product_ids: List[str]):
        super().__init__(", ".join(product_ids))
        self.product_ids = product_ids


@dataclass
class CatalogChange:
    mode_changed: bool = False
    added: Set[str] = field(default_factory=set)
    removed: Set[str] = field(default_factory=set)

    @property
    def changed(self) -> bool:
        return self.mode_changed or bool(self.added) or bool(self.removed)


def _set_row(db: Session, machine_id, product_id, included: bool, existing: Optional[MachineCatalogItem]):
    row = existing
    if row is None:
        row = MachineCatalogItem(machine_id=machine_id, product_id=product_id)
        db.add(row)
    row.is_included = included
    # Stamped explicitly, like the availability levels: the tills pull by delta.
    row.updated_at = func.now()
    return row


def set_machine_catalog(db: Session, machine, mode: str, product_ids: Iterable) -> CatalogChange:
    """
    Replace the till's mode and whitelist. Does not commit.

    Every id must be a product the till's shop sells (an assortment row of the till's
    shop, over a global product of the till's tenant); otherwise `NotInShopCatalog` is
    raised before anything is written. That single check is what confines the write:
    a product of another company or tenant has no assortment row in this shop.

    The general item is skipped: it is always on the till. Rows for products no longer
    requested are set to not-included rather than deleted (see the model). Rows that
    already say the right thing are left alone, so re-saving an unchanged list re-sends
    nothing to the till.
    """
    if mode not in MODES:
        raise ValueError(f"unknown catalog mode {mode!r}")
    requested = {_key(p) for p in product_ids}
    sellable = {_key(p.id): p for _, p in shop_catalog(db, machine)}
    unknown = sorted(requested - set(sellable))
    if unknown:
        raise NotInShopCatalog(unknown)
    wanted = {pid for pid in requested if not general_item.is_general(sellable[pid])}

    change = CatalogChange()
    if machine.catalog_mode != mode:
        change.mode_changed = True
        machine.catalog_mode = mode
        machine.catalog_mode_updated_at = func.now()

    rows = catalog_items(db, machine.id)
    for pid in wanted:
        row = rows.get(pid)
        if row is None or not row.is_included:
            _set_row(db, machine.id, sellable[pid].id, True, row)
            change.added.add(pid)
    for pid, row in rows.items():
        if row.is_included and pid not in wanted:
            _set_row(db, machine.id, row.product_id, False, row)
            change.removed.add(pid)
    return change


def include_product(db: Session, machine, product) -> bool:
    """
    Put one product on a "selected" till's list. Does not commit. True if it changed.

    For a product created *from* that till: without it, the product would vanish from
    the screen of the manager who just made it. A till in "all" mode needs nothing.
    """
    if mode_of(machine) != MODE_SELECTED or general_item.is_general(product):
        return False
    row = catalog_items(db, machine.id, [product.id]).get(_key(product.id))
    if row is not None and row.is_included:
        return False
    _set_row(db, machine.id, product.id, True, row)
    return True


def reset_for_new_shop(db: Session, machine) -> bool:
    """
    A till that changes shop goes back to "all", and its old list is cleared.

    The list was chosen out of the old shop's catalog; applied to the new shop it would
    show an arbitrary fraction of it (or nothing), which nobody chose. A till newly
    seated in a shop sells that shop's catalog, as every till did before this feature.
    Does not commit. True if anything changed.
    """
    changed = False
    if machine.catalog_mode != MODE_ALL:
        machine.catalog_mode = MODE_ALL
        machine.catalog_mode_updated_at = func.now()
        changed = True
    if machine.id is not None:
        # One UPDATE, not a row at a time: set to not-included rather than deleted,
        # with a fresh timestamp, like every other removal from a list.
        cleared = (
            db.query(MachineCatalogItem)
            .filter(
                MachineCatalogItem.machine_id == machine.id,
                MachineCatalogItem.is_included.is_(True),
            )
            .update(
                {MachineCatalogItem.is_included: False, MachineCatalogItem.updated_at: func.now()},
                synchronize_session="fetch",
            )
        )
        changed = changed or bool(cleared)
    return changed


def notify_change(machine) -> None:
    if machine.tenant_id:
        notify_machine_catalog_changed(str(machine.tenant_id), str(machine.id), reason="machine_catalog")
