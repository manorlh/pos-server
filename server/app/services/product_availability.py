"""Whether a till may sell a product: the one place the availability rule lives.

"Unavailable" means **locked**, not hidden — the till still shows the product and will
not add it to a cart. Hiding is `shop_product_overrides.is_listed` and is not part of
this module.

Four levels, nearest wins:

    machine  →  shop  →  the shop's own company  →  the product's own `is_available`

Each of the first three is tri-state — ``None`` (not set: inherit), ``True``
(available), ``False`` (locked) — so a shop can unlock what its company locked and a
till can unlock or lock what its shop decided. The product's own flag is the floor and
is always a plain bool.

**No inheritance between companies.** The company consulted is the shop's own
`company_id` and nothing else — not the product's company, not any ancestor. A lock a
parent company sets applies to the parent's own shops only; it never reaches a
sub-company's shop, even when the parent's product is sold there through "include
sub-companies". `company_level_company_id` is the only place that choice is made.

Everything that needs an answer — the till sync, the catalog watermark, the dashboard's
availability picture, the assortment page — calls into here. Nobody else combines the
levels.
"""
from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.pos_machine import POSMachine
from app.models.product_availability_override import (
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.services.catalog_notify import notify_machine_catalog_changed, notify_machines_for_shop


class Level(str, enum.Enum):
    """Where a resolved value came from, farthest first."""

    PRODUCT = "product"
    COMPANY = "company"
    SHOP = "shop"
    MACHINE = "machine"


#: Farthest to nearest. The order *is* the precedence.
_ORDER = (Level.PRODUCT, Level.COMPANY, Level.SHOP, Level.MACHINE)


@dataclass(frozen=True)
class Resolved:
    available: bool
    #: The level whose setting decided it.
    source: Level


# ── The rule ─────────────────────────────────────────────────────────────────


def resolve_levels(
    product_available,
    company: Optional[bool] = None,
    shop: Optional[bool] = None,
    machine: Optional[bool] = None,
) -> Dict[Level, Resolved]:
    """
    The effective value at every level, top down.

    ``result[Level.SHOP]`` is what a till in that shop gets when the till itself sets
    nothing; ``result[Level.MACHINE]`` is what the till actually gets. What a level
    *inherits* is the entry above it, which is how the dashboard marks a level that
    overrides its parent without knowing the rule.
    """
    current = Resolved(bool(product_available), Level.PRODUCT)
    out: Dict[Level, Resolved] = {Level.PRODUCT: current}
    for level, value in ((Level.COMPANY, company), (Level.SHOP, shop), (Level.MACHINE, machine)):
        if value is not None:
            current = Resolved(bool(value), level)
        out[level] = current
    return out


def resolve(
    product_available,
    company: Optional[bool] = None,
    shop: Optional[bool] = None,
    machine: Optional[bool] = None,
) -> Resolved:
    """The value a till gets: nearest level that is set, else the product's own flag."""
    return resolve_levels(product_available, company, shop, machine)[Level.MACHINE]


def level_above(level: Level) -> Level:
    """The level `level` inherits from."""
    return _ORDER[max(0, _ORDER.index(level) - 1)]


def company_level_company_id(shop) -> Optional[uuid.UUID]:
    """
    The one company whose setting applies in `shop`: the shop's own company.

    Deliberately not the product's company and not an ancestor. Each company has its
    own products; a parent's lock stays in the parent's own shops.
    """
    if shop is None:
        return None
    return shop.company_id


# ── Reading the stored levels ────────────────────────────────────────────────


def _key(value) -> str:
    return str(value)


def _value(row) -> Optional[bool]:
    return None if row is None else row.is_available


def company_overrides(
    db: Session, company_id, product_ids: Iterable
) -> Dict[str, CompanyProductOverride]:
    """`{str(product_id): row}` for one company."""
    ids = list(product_ids)
    if company_id is None or not ids:
        return {}
    rows = (
        db.query(CompanyProductOverride)
        .filter(
            CompanyProductOverride.company_id == company_id,
            CompanyProductOverride.product_id.in_(ids),
        )
        .all()
    )
    return {_key(r.product_id): r for r in rows}


def machine_overrides(
    db: Session, machine_id, product_ids: Iterable
) -> Dict[str, MachineProductOverride]:
    """`{str(product_id): row}` for one till."""
    ids = list(product_ids)
    if machine_id is None or not ids:
        return {}
    rows = (
        db.query(MachineProductOverride)
        .filter(
            MachineProductOverride.machine_id == machine_id,
            MachineProductOverride.product_id.in_(ids),
        )
        .all()
    )
    return {_key(r.product_id): r for r in rows}


def resolve_rows(
    product,
    company_row: Optional[CompanyProductOverride] = None,
    shop_row: Optional[ShopProductOverride] = None,
    machine_row: Optional[MachineProductOverride] = None,
) -> Dict[Level, Resolved]:
    """`resolve_levels` over stored rows; a missing row is "not set"."""
    return resolve_levels(
        product.is_available, _value(company_row), _value(shop_row), _value(machine_row)
    )


def effective_availability(db: Session, product, machine) -> bool:
    """May `machine` sell `product`? One product, one till — see the module docstring."""
    shop_row = None
    company_row = None
    shop_id = getattr(machine, "shop_id", None)
    if shop_id is not None:
        shop = db.query(Shop).filter(Shop.id == shop_id).first()
        shop_row = (
            db.query(ShopProductOverride)
            .filter(
                ShopProductOverride.shop_id == shop_id,
                ShopProductOverride.global_product_id == product.id,
            )
            .first()
        )
        company_row = company_overrides(db, company_level_company_id(shop), [product.id]).get(
            _key(product.id)
        )
    machine_row = machine_overrides(db, machine.id, [product.id]).get(_key(product.id))
    return resolve_rows(product, company_row, shop_row, machine_row)[Level.MACHINE].available


# ── Writing a level ──────────────────────────────────────────────────────────
#
# `value` is True, False, or None for "clear back to inherit". Clearing keeps the row
# with a NULL and a fresh `updated_at`: the tills pull by delta and the catalog
# watermark reads `max(updated_at)`, and neither can see a deleted row. `updated_at`
# is stamped explicitly so that re-sending the same value still counts as a change.


def set_company_availability(
    db: Session, company_id, product_id, value: Optional[bool]
) -> CompanyProductOverride:
    row = (
        db.query(CompanyProductOverride)
        .filter(
            CompanyProductOverride.company_id == company_id,
            CompanyProductOverride.product_id == product_id,
        )
        .first()
    )
    if row is None:
        row = CompanyProductOverride(company_id=company_id, product_id=product_id)
        db.add(row)
    row.is_available = value
    row.updated_at = func.now()
    return row


def set_shop_availability(row: ShopProductOverride, value: Optional[bool]) -> ShopProductOverride:
    row.is_available = value
    row.updated_at = func.now()
    return row


def set_machine_availability(
    db: Session, machine_id, product_id, value: Optional[bool]
) -> MachineProductOverride:
    row = (
        db.query(MachineProductOverride)
        .filter(
            MachineProductOverride.machine_id == machine_id,
            MachineProductOverride.product_id == product_id,
        )
        .first()
    )
    if row is None:
        row = MachineProductOverride(machine_id=machine_id, product_id=product_id)
        db.add(row)
    row.is_available = value
    row.updated_at = func.now()
    return row


# ── Waking the tills a change reaches ────────────────────────────────────────


def machines_reached_by_company(db: Session, company_id, product_id) -> List[POSMachine]:
    """
    Active tills a company-level change reaches: those in the company's **own** shops
    that sell the product. A sub-company's shops are not among them, by the rule.
    """
    return (
        db.query(POSMachine)
        .join(Shop, Shop.id == POSMachine.shop_id)
        .join(
            ShopProductOverride,
            and_(
                ShopProductOverride.shop_id == Shop.id,
                ShopProductOverride.global_product_id == product_id,
            ),
        )
        .filter(Shop.company_id == company_id, POSMachine.is_active.is_(True))
        .all()
    )


def notify_company_change(db: Session, company_id, product_id) -> None:
    for machine in machines_reached_by_company(db, company_id, product_id):
        if machine.tenant_id:
            notify_machine_catalog_changed(
                str(machine.tenant_id), str(machine.id), reason="product_availability"
            )


def notify_shop_change(db: Session, shop_id) -> None:
    notify_machines_for_shop(db, str(shop_id), reason="product_availability")


def notify_machine_change(machine) -> None:
    if machine.tenant_id:
        notify_machine_catalog_changed(
            str(machine.tenant_id), str(machine.id), reason="product_availability"
        )
