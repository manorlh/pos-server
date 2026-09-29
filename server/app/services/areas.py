"""
Shop areas: a shop's tills grouped into bar, kitchen, terrace (docs/AREAS_API.md).

An area is a **filter over one shop's tills, never a fiscal scope**. Three rules hold
everything else up, and each is easy to lose:

* **One shop.** `area.shop_id == machine.shop_id` for every till in an area.
  `set_machine_shop` clears a till's area whenever its shop changes, and nothing here
  seats a till in an area of another shop.
* **Stamped, not joined.** A shift copies its till's area when the cloud creates it
  (`app.services.shifts._new_shift`) and keeps it. Every area filter on shifts,
  documents and reports reads that stamp, so moving a till never moves a past total.
* **Archived, never deleted.** History points at areas; an archived one holds no till.

Membership is `pos_machines.area_id` and nothing else, so configuration per area can
later be a layer that reads the same column.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Union

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.services.machine_status import StatusInput, resolve_status, rollup_status

#: 409/400 details, split on the first `:` by the dashboard (docs/SHIFTS_API.md).
AREA_NAME_TAKEN = "area_name_taken"
AREA_ARCHIVED = "area_archived"
AREA_HAS_MACHINES = "area_has_machines"
AREA_NOT_IN_SHOP = "area_not_in_shop"
AREA_NOT_IN_MACHINE_SHOP = "area_not_in_machine_shop"
MACHINE_NOT_IN_SHOP = "machine_not_in_shop"
MACHINE_NOT_IN_AREA = "machine_not_in_area"

#: The value of an `areaId` filter that means "no area".
AREA_NONE = "none"

#: `reason` on the settings notification a till gets when its area changes.
AREA_NOTIFY_REASON = "area_changed"

AreaId = Union[uuid.UUID, str, None]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(moment: Optional[datetime]) -> Optional[datetime]:
    """A naive timestamp read as UTC, so stamps from any driver compare with each other."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def _as_uuid(value: AreaId) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


# ── Lookups ───────────────────────────────────────────────────────────────────


def get_area(db: Session, area_id: AreaId) -> Optional[ShopArea]:
    wanted = _as_uuid(area_id)
    if wanted is None:
        return None
    return db.query(ShopArea).filter(ShopArea.id == wanted).first()


def area_in_shop(db: Session, area_id: AreaId, shop_id, *, detail: str = AREA_NOT_IN_SHOP) -> ShopArea:
    """
    The area, when it is one of `shop_id`'s; otherwise 400 `detail`.

    An unknown id, and another shop's or another tenant's area, all read the same: the
    caller learns only that this is not an area of the shop it named.
    """
    area = get_area(db, area_id)
    if area is None or shop_id is None or str(area.shop_id) != str(shop_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
    return area


def refuse_archived(area: ShopArea) -> None:
    if area.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AREA_ARCHIVED)


def area_ref(area: Optional[ShopArea]) -> Optional[dict]:
    """`{id, name}` as a till reads it (`GET /machines/me`, the settings sync), or None."""
    if area is None:
        return None
    return {"id": str(area.id), "name": area.name}


def machine_area_for_sync(db: Session, machine: POSMachine):
    """
    The till's area as its settings sync sends it, and the stamps that move the
    settings watermark with it: when the till changed area, and when the area was last
    renamed. `(None, [])` for a till in no area.
    """
    area = get_area(db, getattr(machine, "area_id", None))
    stamps = [
        as_utc(stamp)
        for stamp in (
            getattr(machine, "area_changed_at", None),
            area.updated_at if area is not None else None,
        )
        if isinstance(stamp, datetime)
    ]
    return area_ref(area), stamps


# ── Names ─────────────────────────────────────────────────────────────────────


def _live_name_taken(db: Session, shop_id, name: str, *, exclude_id=None) -> bool:
    query = db.query(ShopArea.id).filter(
        ShopArea.shop_id == shop_id,
        ShopArea.archived_at.is_(None),
        func.lower(ShopArea.name) == name.lower(),
    )
    if exclude_id is not None:
        query = query.filter(ShopArea.id != exclude_id)
    return query.first() is not None


def _refuse_taken(db: Session, shop_id, name: str, *, exclude_id=None) -> None:
    if _live_name_taken(db, shop_id, name, exclude_id=exclude_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AREA_NAME_TAKEN)


def _flush_or_taken(db: Session) -> None:
    """
    Flush, turning the unique index's refusal into `409 area_name_taken`.

    The check before a write answers the ordinary case; the partial unique index is what
    decides two managers naming a "Bar" at the same moment.
    """
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AREA_NAME_TAKEN)


# ── Writes ────────────────────────────────────────────────────────────────────


def create_area(db: Session, shop: Shop, *, name: str, sort_order: Optional[int] = None) -> ShopArea:
    _refuse_taken(db, shop.id, name)
    now = _now()
    area = ShopArea(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        name=name,
        sort_order=sort_order or 0,
        created_at=now,
        updated_at=now,
    )
    db.add(area)
    _flush_or_taken(db)
    return area


def update_area(
    db: Session, area: ShopArea, *, name: Optional[str] = None, sort_order: Optional[int] = None
) -> bool:
    """Rename and/or reorder. Returns True when the name changed (the tills must hear)."""
    renamed = name is not None and name != area.name
    if renamed:
        # A rename of an archived area would change what its history is called while
        # it holds no till to show the new name on. Restore it first.
        refuse_archived(area)
        _refuse_taken(db, area.shop_id, name, exclude_id=area.id)
        area.name = name
    if sort_order is not None:
        area.sort_order = sort_order
    if renamed or sort_order is not None:
        area.updated_at = _now()
    _flush_or_taken(db)
    return renamed


def archive_area(db: Session, area: ShopArea) -> ShopArea:
    """Archive; idempotent. Refused while an active till stands in it."""
    if area.archived_at is not None:
        return area
    in_use = (
        db.query(POSMachine.id)
        .filter(POSMachine.area_id == area.id, POSMachine.is_active.is_(True))
        .first()
    )
    if in_use is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AREA_HAS_MACHINES)
    # A retired till still pointing here (from before retiring cleared it) leaves too:
    # an archived area holds no till, so a reactivated one comes back unassigned.
    for machine in db.query(POSMachine).filter(POSMachine.area_id == area.id).all():
        set_machine_area(machine, None)
    now = _now()
    area.archived_at = now
    area.updated_at = now
    db.flush()
    return area


def restore_area(db: Session, area: ShopArea) -> ShopArea:
    """Bring an archived area back; idempotent. Refused when a live area took its name."""
    if area.archived_at is None:
        return area
    _refuse_taken(db, area.shop_id, area.name, exclude_id=area.id)
    area.archived_at = None
    area.updated_at = _now()
    _flush_or_taken(db)
    return area


def set_machine_area(machine: POSMachine, area_id: AreaId) -> bool:
    """
    Put `machine` in `area_id` (or in none). Returns True when that changed anything.

    The one way `POSMachine.area_id` is written, so the settings watermark
    (`area_changed_at`) cannot be forgotten. Validation is the caller's: the area must be
    a live area of the machine's current shop.
    """
    wanted = _as_uuid(area_id)
    current = _as_uuid(machine.area_id)
    if current == wanted:
        return False
    machine.area_id = wanted
    machine.area_changed_at = _now()
    return True


def assign_machine_area(db: Session, machine: POSMachine, area_id: AreaId) -> bool:
    """
    `PUT /machines/{id}` `areaId`: validated against the machine's *current* shop.

    `None` clears. Returns True when the area changed.
    """
    if area_id is None:
        return set_machine_area(machine, None)
    area = area_in_shop(db, area_id, machine.shop_id, detail=AREA_NOT_IN_MACHINE_SHOP)
    refuse_archived(area)
    return set_machine_area(machine, area.id)


def set_membership(db: Session, area: ShopArea, machine_ids: Sequence[uuid.UUID]) -> List[POSMachine]:
    """
    Make the area's tills exactly `machine_ids`. Returns every till whose area changed.

    Listed tills join — from no area or from another area of the same shop. Tills in it
    now and not listed become unassigned. Every listed id must be an active till of the
    area's shop (`400 machine_not_in_shop:<id>`); nothing is written unless all are.
    """
    refuse_archived(area)
    wanted = list(dict.fromkeys(machine_ids))
    found = {
        m.id: m
        for m in (
            db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all() if wanted else []
        )
    }
    for machine_id in wanted:
        machine = found.get(machine_id)
        if (
            machine is None
            or not machine.is_active
            or str(machine.shop_id) != str(area.shop_id)
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{MACHINE_NOT_IN_SHOP}:{machine_id}",
            )

    changed: List[POSMachine] = []
    for machine in db.query(POSMachine).filter(POSMachine.area_id == area.id).all():
        if machine.id not in found and set_machine_area(machine, None):
            changed.append(machine)
    for machine_id in wanted:
        machine = found[machine_id]
        if set_machine_area(machine, area.id):
            changed.append(machine)
    db.flush()
    return changed


# ── Tills notified ────────────────────────────────────────────────────────────


def notify_tills(machines: Iterable[POSMachine]) -> None:
    """
    Tell each till its area changed, the way a settings change is told.

    The till then pulls `GET /sync/{id}/settings`, whose watermark has moved with the
    change (`area_changed_at`, or the area's `updated_at` on a rename). Call after the
    commit: a till that refetches before it would read the old area.
    """
    from app.services.ably_notify import publish_settings_notify

    for machine in machines:
        if machine.tenant_id and machine.is_active:
            publish_settings_notify(str(machine.tenant_id), str(machine.id), reason=AREA_NOTIFY_REASON)


def area_tills(db: Session, area_id) -> List[POSMachine]:
    return db.query(POSMachine).filter(POSMachine.area_id == area_id).all()


# ── Status roll-up and the area as the dashboard reads it ─────────────────────


def primary_statuses(db: Session, machines: Sequence[POSMachine]) -> Dict[uuid.UUID, str]:
    """
    Each till's primary status, from the same readings the machines page resolves.

    Only the inputs the primary status depends on are read; the flags (catalog, clock,
    battery) never change a colour, so the roll-up has no use for them.
    """
    from app.services.remote_close import pending_close_sources
    from app.services.shifts import open_shifts_for_machines

    ids = [m.id for m in machines]
    if not ids:
        return {}
    open_shifts = open_shifts_for_machines(db, ids)
    pending = pending_close_sources(db, ids)
    out: Dict[uuid.UUID, str] = {}
    for machine in machines:
        open_shift = open_shifts.get(machine.id)
        out[machine.id] = resolve_status(
            StatusInput(
                is_active=bool(machine.is_active),
                pairing_status=(
                    machine.pairing_status.value
                    if hasattr(machine.pairing_status, "value")
                    else machine.pairing_status
                ),
                last_heartbeat_at=machine.last_heartbeat_at,
                shift_open=open_shift is not None,
                business_date=open_shift.business_date if open_shift else None,
                close_shift_pending=machine.id in pending,
                pending_documents=machine.pending_documents,
                pending_count=machine.pending_count,
                pending_count_at=machine.pending_count_at,
            )
        ).status
    return out


def areas_out(db: Session, areas: Sequence[ShopArea]) -> List[dict]:
    """The areas as `GET /shops/{id}/areas` lists them: with their tills and roll-up."""
    if not areas:
        return []
    machines = (
        db.query(POSMachine)
        .filter(
            POSMachine.area_id.in_([a.id for a in areas]),
            POSMachine.is_active.is_(True),
        )
        .all()
    )
    statuses = primary_statuses(db, machines)
    by_area: Dict[uuid.UUID, List[POSMachine]] = {}
    for machine in machines:
        by_area.setdefault(machine.area_id, []).append(machine)
    out = []
    for area in areas:
        tills = sorted(by_area.get(area.id, []), key=lambda m: (m.pos_number or "", m.name or ""))
        out.append(
            {
                "id": area.id,
                "shopId": area.shop_id,
                "name": area.name,
                "sortOrder": area.sort_order or 0,
                "archivedAt": area.archived_at,
                "machineCount": len(tills),
                "status": rollup_status(statuses[m.id] for m in tills),
                "machines": [
                    {
                        "id": m.id,
                        "name": m.name,
                        "posNumber": m.pos_number,
                        "status": statuses[m.id],
                    }
                    for m in tills
                ],
                "createdAt": area.created_at,
                "updatedAt": area.updated_at,
            }
        )
    return out


def area_out(db: Session, area: ShopArea) -> dict:
    return areas_out(db, [area])[0]


def shop_areas(db: Session, shop_id, *, include_archived: bool = False) -> List[ShopArea]:
    query = db.query(ShopArea).filter(ShopArea.shop_id == shop_id)
    if not include_archived:
        query = query.filter(ShopArea.archived_at.is_(None))
    return query.order_by(ShopArea.sort_order, ShopArea.name).all()


# ── `areaId=<uuid|none>` filters ──────────────────────────────────────────────


def parse_area_filter(raw) -> Union[None, str, uuid.UUID]:
    """
    `None` (no filter), `AREA_NONE` ("no area"), or the area's id.

    Anything else is a 422, as a malformed UUID in a typed parameter would be.
    """
    # Not a string: no value was given (a handler called directly sees the `Query(...)`
    # default itself, which must read as "no filter", not as a malformed one).
    if not isinstance(raw, str) or raw == "":
        return None
    if raw.strip().lower() == AREA_NONE:
        return AREA_NONE
    parsed = _as_uuid(raw.strip())
    if parsed is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="areaId must be an area id or 'none'",
        )
    return parsed


def filter_on_column(query, column, area_filter):
    """Narrow `query` on an `area_id` column by a parsed `areaId` filter."""
    if area_filter is None:
        return query
    if area_filter == AREA_NONE:
        return query.filter(column.is_(None))
    return query.filter(column == area_filter)


def transaction_area_predicate(area_filter):
    """
    Documents whose **shift's stamped area** matches — never the till's current area.

    A document with no shift is "no area": it was never taken under one.
    """
    if area_filter is None:
        return None
    if area_filter == AREA_NONE:
        return or_(
            Transaction.shift_id.is_(None),
            Transaction.shift_id.in_(select(Shift.id).where(Shift.area_id.is_(None))),
        )
    return Transaction.shift_id.in_(select(Shift.id).where(Shift.area_id == area_filter))
