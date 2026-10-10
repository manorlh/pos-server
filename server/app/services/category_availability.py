"""Whether a category is active on a till: the one place that rule lives.

The category's own `categories.is_active` is tenant-wide and is the floor — switched off
there, it is off on every till, and nothing below can switch it back on. Below it, three
tri-state levels (`category_availability_overrides`), nearest wins:

    machine  →  area  →  shop

``None`` is "not set: inherit", so a till can switch back on what its area or shop
switched off. A till in no area has no area level. What a till is sent as `isActive`
(`get_categories_for_sync`) is `resolve(category.is_active, ...)` for that till.

Unlike products, categories have no company level: a category is placed on the tenant,
a company or a shop already, and the dashboard's own `is_active` covers the tenant.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.pos_machine import POSMachine
from app.services.catalog_notify import notify_machine_catalog_changed, notify_machines_for_shop

SHOP = "shop"
AREA = "area"
MACHINE = "machine"

#: Farthest to nearest. The order *is* the precedence.
LEVELS = (SHOP, AREA, MACHINE)

#: `reason` on the catalog notification a till gets.
NOTIFY_REASON = "category_availability"


# ── The rule ─────────────────────────────────────────────────────────────────


def resolve(
    category_active,
    shop: Optional[bool] = None,
    area: Optional[bool] = None,
    machine: Optional[bool] = None,
) -> bool:
    """The tenant flag, and then the nearest level that is set."""
    if not category_active:
        return False
    for value in (machine, area, shop):
        if value is not None:
            return bool(value)
    return True


# ── Whose rows apply to a till ───────────────────────────────────────────────


def machine_targets(machine) -> List[Tuple[str, uuid.UUID]]:
    """`(level, target_id)` for every level that applies to this till, farthest first."""
    out: List[Tuple[str, uuid.UUID]] = []
    if getattr(machine, "shop_id", None) is not None:
        out.append((SHOP, machine.shop_id))
    if getattr(machine, "area_id", None) is not None:
        out.append((AREA, machine.area_id))
    out.append((MACHINE, machine.id))
    return out


def _targets_filter(machine):
    return or_(
        *(
            and_(
                CategoryAvailabilityOverride.level == level,
                CategoryAvailabilityOverride.target_id == target,
            )
            for level, target in machine_targets(machine)
        )
    )


def overrides_for_machine(
    db: Session, machine, category_ids: Optional[Iterable] = None
) -> Dict[str, Dict[str, CategoryAvailabilityOverride]]:
    """`{str(category_id): {level: row}}` — every row that applies to this till."""
    query = db.query(CategoryAvailabilityOverride).filter(_targets_filter(machine))
    if category_ids is not None:
        ids = list(category_ids)
        if not ids:
            return {}
        query = query.filter(CategoryAvailabilityOverride.category_id.in_(ids))
    out: Dict[str, Dict[str, CategoryAvailabilityOverride]] = {}
    for row in query.all():
        out.setdefault(str(row.category_id), {})[row.level] = row
    return out


def resolve_rows(category, rows: Optional[Dict[str, CategoryAvailabilityOverride]]) -> bool:
    """`resolve` over stored rows; a missing row is "not set"."""
    rows = rows or {}

    def value(level):
        row = rows.get(level)
        return None if row is None else row.is_active

    return resolve(category.is_active, value(SHOP), value(AREA), value(MACHINE))


def lock_info(category_active, rows: Optional[Dict[str, CategoryAvailabilityOverride]]) -> Optional[Dict]:
    """
    The switch-off that decides a category on a till, as the till is sent it
    (`activeLock`, docs/SPEC_AVAILABILITY.md): its level, "חסימה קבועה", when it began and
    what the till gets without it. None when the category is active, or when the tenant's
    own flag is what switched it off (no Z reopens that).
    """
    if not category_active:
        return None
    rows = rows or {}

    def value(level):
        row = rows.get(level)
        return None if row is None else row.is_active

    for i, level in enumerate((MACHINE, AREA, SHOP)):
        if value(level) is None:
            continue
        if value(level):
            return None
        row = rows[level]
        above = [value(lv) for lv in (MACHINE, AREA, SHOP)[i + 1:]]
        inherited = next((bool(v) for v in above if v is not None), True)
        return {
            "level": level,
            "permanent": bool(getattr(row, "block_permanent", False)),
            "blockedAt": row.blocked_at.isoformat() if getattr(row, "blocked_at", None) else None,
            "inherited": inherited,
        }
    return None


def latest_change(rows: Optional[Dict[str, CategoryAvailabilityOverride]]) -> Optional[datetime]:
    """The newest `updated_at` among a category's rows for one till."""
    stamps = [r.updated_at for r in (rows or {}).values() if r.updated_at is not None]
    if not stamps:
        return None
    return max(_as_utc(s) for s in stamps)


def changed_since(
    overrides: Dict[str, Dict[str, CategoryAvailabilityOverride]], since: datetime
) -> List[uuid.UUID]:
    """Ids of the categories whose setting for this till changed after `since`."""
    out = []
    for category_id, rows in overrides.items():
        stamp = latest_change(rows)
        if stamp is not None and stamp > _as_utc(since):
            out.append(uuid.UUID(category_id))
    return out


def effective_active(db: Session, category, machine) -> bool:
    """Is `category` active on `machine`? One category, one till."""
    rows = overrides_for_machine(db, machine, [category.id]).get(str(category.id))
    return resolve_rows(category, rows)


def last_change(db: Session, machine) -> Optional[datetime]:
    """Newest change to any row that applies to this till — for the catalog watermark."""
    return (
        db.query(func.max(CategoryAvailabilityOverride.updated_at))
        .filter(_targets_filter(machine))
        .scalar()
    )


# ── Writing a level ──────────────────────────────────────────────────────────


def set_override(
    db: Session,
    level: str,
    target_id,
    category_id,
    value: Optional[bool],
    permanent: Optional[bool] = None,
    at: Optional[datetime] = None,
) -> CategoryAvailabilityOverride:
    """
    Set (True / False) or clear (None) one level. Clearing keeps the row with a NULL and
    a fresh `updated_at`: the delta pull and the watermark cannot see a deleted row.
    Stamped explicitly so re-sending the same value still counts as a change.

    A switch-off also carries "חסימה קבועה" and when it began (`mark_lock`): temporary
    unless `permanent` says otherwise, for "פתיחת פריטים אוטומטית אחרי Z".
    """
    from app.services.product_availability import mark_lock

    if level not in LEVELS:
        raise ValueError(f"unknown category level {level!r}")
    row = (
        db.query(CategoryAvailabilityOverride)
        .filter(
            CategoryAvailabilityOverride.level == level,
            CategoryAvailabilityOverride.target_id == target_id,
            CategoryAvailabilityOverride.category_id == category_id,
        )
        .first()
    )
    if row is None:
        row = CategoryAvailabilityOverride(level=level, target_id=target_id, category_id=category_id)
        db.add(row)
    mark_lock(row, row.is_active is False, value, permanent, at)
    row.is_active = value
    row.updated_at = datetime.now(timezone.utc)
    return row


# ── Waking the tills a change reaches ────────────────────────────────────────


def notify_level(db: Session, level: str, target_id, *, machine=None, reason: str = NOTIFY_REASON) -> None:
    """Wake every active till a change at `level` reaches. Call after the commit."""
    if level == SHOP:
        notify_machines_for_shop(db, str(target_id), reason=reason)
        return
    if level == AREA:
        machines = (
            db.query(POSMachine)
            .filter(POSMachine.area_id == target_id, POSMachine.is_active.is_(True))
            .all()
        )
    else:
        machines = [machine] if machine is not None else (
            db.query(POSMachine).filter(POSMachine.id == target_id).all()
        )
    for m in machines:
        if m.tenant_id:
            notify_machine_catalog_changed(str(m.tenant_id), str(m.id), reason=reason)


# ── The dashboard's list ─────────────────────────────────────────────────────


def inactive_targets(db: Session, category_ids: Iterable) -> Dict[str, List[CategoryAvailabilityOverride]]:
    """`{str(category_id): [rows switched off]}` — for "not active at …" on the list."""
    ids = list(category_ids)
    if not ids:
        return {}
    rows = (
        db.query(CategoryAvailabilityOverride)
        .filter(
            CategoryAvailabilityOverride.category_id.in_(ids),
            CategoryAvailabilityOverride.is_active.is_(False),
        )
        .all()
    )
    out: Dict[str, List[CategoryAvailabilityOverride]] = {}
    for row in rows:
        out.setdefault(str(row.category_id), []).append(row)
    return out


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
