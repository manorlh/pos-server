"""
Who may see and manage which stock locations (and block which devices): the existing dashboard
roles and org scope, narrowed further by a profile's points of sale or devices.

* The role and org scope, as everywhere (app/services/kiosk_control.py `check_*_scope`): a super
  admin and a distributor — the tenant; a company manager — their companies' shops; a shop manager —
  their shop.
* **"מנהל נקודת מכירה"** — `dashboard_access_profiles.area_ids` (and `machine_ids`, the narrowest): a
  user scoped to points of sale or devices sees and manages only those locations and what is under
  them — an area's devices — and nothing above or beside them (not the shop's stock, not another
  area). Added to the profile for this; nothing else reads them yet. Set from the dashboard's user
  permissions like the shops are.

A user "covers" a location when the location is one of their nodes or lies under one of them.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, List, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import UserRole
from app.services import stock_locations as L
from app.services.stock_locations import Location, Path


def _uuids(raw: Any) -> Set[uuid.UUID]:
    out: Set[uuid.UUID] = set()
    if isinstance(raw, (list, tuple)):
        for v in raw:
            try:
                out.add(uuid.UUID(str(v)))
            except (TypeError, ValueError):
                continue
    return out


@dataclass
class UserStockScope:
    """The narrowest nodes a user manages; empty sets = no narrowing at that level."""

    area_ids: Set[uuid.UUID] = field(default_factory=set)
    machine_ids: Set[uuid.UUID] = field(default_factory=set)

    @property
    def narrowed(self) -> bool:
        return bool(self.area_ids or self.machine_ids)

    def covers_path(self, path: Path) -> bool:
        """The node at `path` is one of the user's points of sale / devices, or under one."""
        if not self.narrowed:
            return True
        if path.machine_id is not None and path.machine_id in self.machine_ids:
            return True
        if path.area_id is not None and path.area_id in self.area_ids and path.node_level in ("area", "machine", "group"):
            return True
        return False


def scope_of(db: Session, user: Any) -> UserStockScope:
    try:
        from app.models.dashboard_access import DashboardAccessProfile

        profile = db.get(DashboardAccessProfile, getattr(user, "id", None))
    except Exception:  # noqa: BLE001 - no profiles table (an older test world): no narrowing
        return UserStockScope()
    if profile is None:
        return UserStockScope()
    return UserStockScope(
        area_ids=_uuids(getattr(profile, "area_ids", None)),
        machine_ids=_uuids(getattr(profile, "machine_ids", None)),
    )


def stock_scope_of(db: Session, user: Any) -> UserStockScope:
    """The narrowing for the stock screens: none while stock locations are off (shop stock only —
    a manager of points of sale keeps their role's shops, as before)."""
    if not L.locations_enabled():
        return UserStockScope()
    return scope_of(db, user)


def _forbidden(detail: str = "Access denied") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def check_path(db: Session, user: Any, path: Path, tenant_id: Any) -> None:
    """403 unless the user's role, org scope and points of sale cover the node at `path`."""
    from app.models.company import Company
    from app.models.shop import Shop
    from app.services import kiosk_control

    if path.node_level == "company":
        company = db.get(Company, path.company_id)
        if company is None:
            raise HTTPException(status_code=404, detail="Company not found")
        kiosk_control.check_company_scope(db, user, company, tenant_id)
    else:
        shop = db.get(Shop, path.shop_id) if path.shop_id is not None else None
        if shop is None:
            raise HTTPException(status_code=404, detail="Shop not found")
        kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    if not stock_scope_of(db, user).covers_path(path):
        raise _forbidden("outside_your_points_of_sale")


def check_location(db: Session, user: Any, loc: Location, tenant_id: Any) -> Path:
    try:
        path = L.location_path(db, loc)
    except LookupError:
        raise HTTPException(status_code=404, detail="location_not_found")
    check_path(db, user, path, tenant_id)
    return path


def may(db: Session, user: Any, path: Path, tenant_id: Any) -> bool:
    try:
        check_path(db, user, path, tenant_id)
        return True
    except HTTPException:
        return False


def is_writer(user: Any) -> bool:
    return getattr(user, "role", None) in (
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
    )
