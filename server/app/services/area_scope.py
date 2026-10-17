"""
"מנהל נקודת מכירה" across the dashboard (P:/specs/chain-areas.md §4): the one place every dashboard read and
write asks which points of sale and devices a user may reach below their shops.

`dashboard_access_profiles.area_ids` / `machine_ids` narrow a user to some points of sale (`shop_areas`) or
devices of the shops their role and org scope already reach. Until 17.10 only the stock and block screens read
them (app/services/stock_scope.py); now the central helpers every router goes through read them too:

* `scoping.scope_query_by_user` (transactions, Z reports, every per-machine row) — `filter_machine_column`;
* `company_hierarchy.user_may_use_machine` (the machine RBAC and the till's elevation) — `machine_ok`;
* the machine / kiosk / KDS / area lists and the area-level writes — `check_machine`, `check_area`;
* a write at the whole shop or above (shop availability, shop Z, shop settings) — `refuse_shop_level`.

**Reach** = the profile's points of sale, every device standing in one of them now, and the profile's own
devices. Empty = not narrowed (the whole shops of the role) — every user before this, and a super admin always.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, FrozenSet, Iterable, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import UserRole

#: 403 detail for anything outside the user's points of sale (the stock / block screens' own word).
OUTSIDE = "outside_your_points_of_sale"
#: 403 detail for a whole-shop (or wider) write by a manager of points of sale.
NEEDS_SHOP = "needs_whole_shop_scope"

_MEMO_KEY = "area_scope_memo"


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _uuids(raw: Any) -> FrozenSet[uuid.UUID]:
    out: Set[uuid.UUID] = set()
    if isinstance(raw, (list, tuple, set, frozenset)):
        for v in raw:
            parsed = _uuid(v)
            if parsed is not None:
                out.add(parsed)
    return frozenset(out)


@dataclass(frozen=True)
class AreaReach:
    """A user's points of sale and devices; both empty = not narrowed."""

    area_ids: FrozenSet[uuid.UUID] = field(default_factory=frozenset)
    machine_ids: FrozenSet[uuid.UUID] = field(default_factory=frozenset)
    #: Every device reachable: the profile's own and those standing in its points of sale (computed once).
    reachable_machine_ids: FrozenSet[uuid.UUID] = field(default_factory=frozenset)
    #: The shops of the points of sale and devices above.
    shop_ids: FrozenSet[uuid.UUID] = field(default_factory=frozenset)

    @property
    def narrowed(self) -> bool:
        return bool(self.area_ids or self.machine_ids)

    @property
    def visible_area_ids(self) -> FrozenSet[uuid.UUID]:
        """Points of sale the user sees: their own, and those their devices stand in (read-only beside them)."""
        return self.area_ids

    def covers_machine(self, machine: Any) -> bool:
        if not self.narrowed:
            return True
        mid = _uuid(getattr(machine, "id", None))
        if mid is not None and mid in self.machine_ids:
            return True
        aid = _uuid(getattr(machine, "area_id", None))
        return aid is not None and aid in self.area_ids

    def covers_machine_id(self, machine_id: Any) -> bool:
        if not self.narrowed:
            return True
        mid = _uuid(machine_id)
        return mid is not None and mid in self.reachable_machine_ids

    def covers_area(self, area_id: Any) -> bool:
        if not self.narrowed:
            return True
        aid = _uuid(area_id)
        return aid is not None and aid in self.area_ids

    def covers_shop(self, shop_id: Any) -> bool:
        """The shop holds one of the user's points of sale or devices (or the user is not narrowed)."""
        if not self.narrowed:
            return True
        sid = _uuid(shop_id)
        return sid is not None and sid in self.shop_ids


NOT_NARROWED = AreaReach()


def _memo(db: Session) -> Optional[dict]:
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return None
    return info.setdefault(_MEMO_KEY, {})


def forget(db: Session) -> None:
    info = getattr(db, "info", None)
    if isinstance(info, dict):
        info.pop(_MEMO_KEY, None)


def reach_of(db: Session, user: Any) -> AreaReach:
    """The user's points of sale and devices, memoised for the request's session."""
    if user is None or getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return NOT_NARROWED
    user_id = getattr(user, "id", None)
    if user_id is None or not isinstance(db, Session):
        return NOT_NARROWED
    memo = _memo(db)
    if memo is not None and user_id in memo:
        return memo[user_id]
    reach = _load(db, user_id)
    if memo is not None:
        memo[user_id] = reach
    return reach


def _load(db: Session, user_id) -> AreaReach:
    try:
        from app.models.dashboard_access import DashboardAccessProfile

        profile = db.get(DashboardAccessProfile, user_id)
    except Exception:  # noqa: BLE001 - no profiles table (an older test world): no narrowing
        return NOT_NARROWED
    if profile is None:
        return NOT_NARROWED
    areas = _uuids(getattr(profile, "area_ids", None))
    machines = _uuids(getattr(profile, "machine_ids", None))
    if not areas and not machines:
        return NOT_NARROWED
    from app.models.pos_machine import POSMachine
    from app.models.shop_area import ShopArea

    reachable: Set[uuid.UUID] = set(machines)
    shops: Set[uuid.UUID] = set()
    if areas:
        for mid, sid in db.query(POSMachine.id, POSMachine.shop_id).filter(POSMachine.area_id.in_(list(areas))).all():
            reachable.add(mid)
        for (sid,) in db.query(ShopArea.shop_id).filter(ShopArea.id.in_(list(areas))).all():
            shops.add(sid)
    if machines:
        for (sid,) in db.query(POSMachine.shop_id).filter(POSMachine.id.in_(list(machines))).all():
            if sid is not None:
                shops.add(sid)
    return AreaReach(
        area_ids=areas,
        machine_ids=machines,
        reachable_machine_ids=frozenset(reachable),
        shop_ids=frozenset(shops),
    )


# ── Checks ───────────────────────────────────────────────────────────────────


def _forbidden(detail: str = OUTSIDE) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def narrowed(db: Session, user: Any) -> bool:
    return reach_of(db, user).narrowed


def machine_ok(db: Session, user: Any, machine: Any) -> bool:
    return reach_of(db, user).covers_machine(machine)


def area_ok(db: Session, user: Any, area_id: Any) -> bool:
    return reach_of(db, user).covers_area(area_id)


def check_machine(db: Session, user: Any, machine: Any) -> None:
    """403 `outside_your_points_of_sale` for a device outside the user's points of sale."""
    if not machine_ok(db, user, machine):
        raise _forbidden()


def check_machine_ids(db: Session, user: Any, machine_ids: Iterable[Any]) -> None:
    reach = reach_of(db, user)
    if not reach.narrowed:
        return
    for mid in machine_ids or ():
        if not reach.covers_machine_id(mid):
            raise _forbidden()


def check_area(db: Session, user: Any, area_id: Any) -> None:
    """403 for a point of sale that is not the user's. `None` (the whole shop) is a shop-level ask."""
    if area_id is None:
        refuse_shop_level(db, user)
        return
    if not area_ok(db, user, area_id):
        raise _forbidden()


def refuse_shop_level(db: Session, user: Any) -> None:
    """A write (or a read) about the whole shop or wider: never for a manager of points of sale."""
    if narrowed(db, user):
        raise _forbidden(NEEDS_SHOP)


def check_shop_read(db: Session, user: Any, shop_id: Any) -> None:
    """A manager of points of sale reads only the shops that hold one of theirs."""
    if not reach_of(db, user).covers_shop(shop_id):
        raise _forbidden()


# ── Query filters ────────────────────────────────────────────────────────────


def machine_filter(db: Session, user: Any, column):
    """`column IN (reachable devices)` for a narrowed user, else None."""
    reach = reach_of(db, user)
    if not reach.narrowed:
        return None
    ids = list(reach.reachable_machine_ids)
    if not ids:
        return column.in_([uuid.uuid4()])  # nothing reachable — never "everything"
    return column.in_(ids)


def filter_machine_column(query, db: Session, user: Any, column):
    """`query` narrowed to the user's devices (unchanged for everyone else)."""
    clause = machine_filter(db, user, column)
    return query if clause is None else query.filter(clause)


def area_filter(db: Session, user: Any, column):
    """`column IN (their points of sale)` for a narrowed user, else None."""
    reach = reach_of(db, user)
    if not reach.narrowed:
        return None
    ids = list(reach.area_ids)
    return column.in_(ids or [uuid.uuid4()])


def allowed_machine_ids(db: Session, user: Any) -> Optional[Set[uuid.UUID]]:
    """Every device the user reaches, or None (not narrowed)."""
    reach = reach_of(db, user)
    return set(reach.reachable_machine_ids) if reach.narrowed else None


def allowed_area_ids(db: Session, user: Any) -> Optional[Set[uuid.UUID]]:
    reach = reach_of(db, user)
    return set(reach.area_ids) if reach.narrowed else None


def default_area_ids_for_new(db: Session, user: Any, shop_id: Any) -> Optional[list]:
    """What a manager of points of sale creates is theirs: their points of sale of this shop, else None."""
    reach = reach_of(db, user)
    if not reach.area_ids:
        return None
    from app.models.shop_area import ShopArea

    sid = _uuid(shop_id)
    rows = db.query(ShopArea.id).filter(ShopArea.id.in_(list(reach.area_ids)), ShopArea.shop_id == sid).all()
    return [str(r[0]) for r in rows] or None


def is_writer(user: Any) -> bool:
    return getattr(user, "role", None) in (
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
    )
