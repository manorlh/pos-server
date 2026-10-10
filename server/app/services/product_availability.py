"""Whether a till may sell a product: the one place the availability rule lives.

"Unavailable" means **locked**, not hidden — the till still shows the product and will
not add it to a cart. Hiding is `shop_product_overrides.is_listed` and is not part of
this module.

Five levels, nearest wins:

    machine  →  area  →  shop  →  the shop's own company  →  the product's own `is_available`

Each of the first four is tri-state — ``None`` (not set: inherit), ``True``
(available), ``False`` (locked) — so a shop can unlock what its company locked, an area
(the point of sale a till stands in, `pos_machines.area_id`) can decide for its tills,
and a till can unlock or lock what its area or shop decided. The product's own flag is
the floor and is always a plain bool. A till in no area simply has no area level.

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
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.pos_machine import POSMachine
from app.models.product_availability_override import (
    AreaProductOverride,
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
    AREA = "area"
    MACHINE = "machine"


#: Farthest to nearest. The order *is* the precedence.
_ORDER = (Level.PRODUCT, Level.COMPANY, Level.SHOP, Level.AREA, Level.MACHINE)


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
    *,
    area: Optional[bool] = None,
) -> Dict[Level, Resolved]:
    """
    The effective value at every level, top down.

    ``result[Level.SHOP]`` is what a till in that shop gets when neither its area nor
    the till itself sets anything; ``result[Level.MACHINE]`` is what the till actually
    gets. What a level *inherits* is the entry above it, which is how the dashboard
    marks a level that overrides its parent without knowing the rule.

    `area` is keyword-only because it came last: the positional order every caller
    already used (company, shop, machine) stays valid.
    """
    current = Resolved(bool(product_available), Level.PRODUCT)
    out: Dict[Level, Resolved] = {Level.PRODUCT: current}
    for level, value in (
        (Level.COMPANY, company),
        (Level.SHOP, shop),
        (Level.AREA, area),
        (Level.MACHINE, machine),
    ):
        if value is not None:
            current = Resolved(bool(value), level)
        out[level] = current
    return out


def resolve(
    product_available,
    company: Optional[bool] = None,
    shop: Optional[bool] = None,
    machine: Optional[bool] = None,
    *,
    area: Optional[bool] = None,
) -> Resolved:
    """The value a till gets: nearest level that is set, else the product's own flag."""
    return resolve_levels(product_available, company, shop, machine, area=area)[Level.MACHINE]


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


def area_overrides(
    db: Session, area_id, product_ids: Iterable
) -> Dict[str, AreaProductOverride]:
    """`{str(product_id): row}` for one area; nothing (and no query) for a till in none."""
    ids = list(product_ids)
    if area_id is None or not ids:
        return {}
    rows = (
        db.query(AreaProductOverride)
        .filter(
            AreaProductOverride.area_id == area_id,
            AreaProductOverride.product_id.in_(ids),
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
    *,
    area_row: Optional[AreaProductOverride] = None,
) -> Dict[Level, Resolved]:
    """`resolve_levels` over stored rows; a missing row is "not set"."""
    return resolve_levels(
        product.is_available,
        _value(company_row),
        _value(shop_row),
        _value(machine_row),
        area=_value(area_row),
    )


#: The levels a Z may reopen (app/services/availability_reopen.py): no Z closes a company's
#: day, and the product's own flag is the catalog's.
REOPENABLE = (Level.SHOP, Level.AREA, Level.MACHINE)


def lock_info(levels: Dict[Level, Resolved], rows: Dict[Level, object]) -> Optional[Dict]:
    """
    The lock that decides a till's value, as the till is sent it (`availabilityLock`), so
    that a Z the till closes with no connection can reopen it there and then
    (docs/SPEC_AVAILABILITY.md): its level, "חסימה קבועה", when it began, and what the till
    gets without it (`inherited`, the level above). None when the product is available, or
    when the deciding level is one no Z reopens.

    `levels` is `resolve_levels`' answer; `rows` the stored row of each level, by level.
    """
    final = levels[Level.MACHINE]
    if final.available or final.source not in REOPENABLE:
        return None
    row = rows.get(final.source)
    blocked_at = getattr(row, "blocked_at", None)
    return {
        "level": final.source.value,
        "permanent": bool(getattr(row, "block_permanent", False)),
        "blockedAt": blocked_at.isoformat() if blocked_at is not None else None,
        "inherited": levels[level_above(final.source)].available,
    }


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
    area_row = area_overrides(db, getattr(machine, "area_id", None), [product.id]).get(
        _key(product.id)
    )
    machine_row = machine_overrides(db, machine.id, [product.id]).get(_key(product.id))
    return resolve_rows(product, company_row, shop_row, machine_row, area_row=area_row)[
        Level.MACHINE
    ].available


# ── Writing a level ──────────────────────────────────────────────────────────
#
# `value` is True, False, or None for "clear back to inherit". Clearing keeps the row
# with a NULL and a fresh `updated_at`: the tills pull by delta and the catalog
# watermark reads `max(updated_at)`, and neither can see a deleted row. `updated_at`
# is stamped explicitly so that re-sending the same value still counts as a change.
#
# The shop, area and till levels also carry "חסימה קבועה" (`block_permanent`) and when
# the lock began (`blocked_at`), for "פתיחת פריטים אוטומטית אחרי Z"
# (app/services/availability_reopen.py) — see `mark_lock`. The company level has
# neither: no Z closes a company's day.


def mark_lock(
    row,
    was_locked: bool,
    value: Optional[bool],
    permanent: Optional[bool] = None,
    at: Optional[datetime] = None,
) -> None:
    """
    Keep `blocked_at` / `block_permanent` in step with a level's new value.

    A new lock begins now — or at `at`, when a till queued it with no connection and says
    when its manager set it (never later than now) — and is temporary unless `permanent`
    says otherwise: the default for a till's "sold out" and for the dashboard alike. A lock
    that stays a lock keeps when it began, and its flag unless `permanent` is given.
    Anything else is no lock.
    """
    if value is False:
        if not was_locked:
            now = datetime.now(timezone.utc)
            began = None
            if at is not None:
                began = at if at.tzinfo is not None else at.replace(tzinfo=timezone.utc)
            row.blocked_at = began if began is not None and began <= now else now
            row.block_permanent = bool(permanent)
        elif permanent is not None:
            row.block_permanent = bool(permanent)
    else:
        row.blocked_at = None
        row.block_permanent = False


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


def set_shop_availability(
    row: ShopProductOverride,
    value: Optional[bool],
    permanent: Optional[bool] = None,
    at: Optional[datetime] = None,
) -> ShopProductOverride:
    mark_lock(row, row.is_available is False, value, permanent, at)
    row.is_available = value
    row.updated_at = func.now()
    return row


def set_area_availability(
    db: Session,
    area_id,
    product_id,
    value: Optional[bool],
    permanent: Optional[bool] = None,
    at: Optional[datetime] = None,
) -> AreaProductOverride:
    row = (
        db.query(AreaProductOverride)
        .filter(
            AreaProductOverride.area_id == area_id,
            AreaProductOverride.product_id == product_id,
        )
        .first()
    )
    if row is None:
        row = AreaProductOverride(area_id=area_id, product_id=product_id)
        db.add(row)
    mark_lock(row, row.is_available is False, value, permanent, at)
    row.is_available = value
    row.updated_at = func.now()
    return row


def set_machine_availability(
    db: Session,
    machine_id,
    product_id,
    value: Optional[bool],
    permanent: Optional[bool] = None,
    at: Optional[datetime] = None,
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
    mark_lock(row, row.is_available is False, value, permanent, at)
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


def area_machines(db: Session, area_id) -> List[POSMachine]:
    """Active tills standing in the area: whom an area-level change reaches."""
    return (
        db.query(POSMachine)
        .filter(POSMachine.area_id == area_id, POSMachine.is_active.is_(True))
        .all()
    )


def notify_area_change(db: Session, area_id, reason: str = "product_availability") -> None:
    for machine in area_machines(db, area_id):
        if machine.tenant_id:
            notify_machine_catalog_changed(str(machine.tenant_id), str(machine.id), reason=reason)


def notify_machine_change(machine) -> None:
    if machine.tenant_id:
        notify_machine_catalog_changed(
            str(machine.tenant_id), str(machine.id), reason="product_availability"
        )
