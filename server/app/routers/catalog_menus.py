"""
"תפריטים" (docs/SPEC_MENUS.md) — named sales menus by schedule.

Dashboard (Clerk/user JWT; the rules in app/services/catalog_menus.py):

GET    /catalog-menus                    → the menus the user sees, with items and assignments
POST   /catalog-menus                    → create
GET    /catalog-menus/{id}
PUT    /catalog-menus/{id}               → replace (categories and products in their order)
DELETE /catalog-menus/{id}
PUT    /catalog-menus-order              → `{"ids": [...]}`, the list's drag order
GET    /catalog-menus-targets            → companies, shops, points of sale and tills, with
                                           their menus, priorities and fallback
PUT    /catalog-menus-targets            → one target's menus and fallback, replaced
GET    /catalog-menus-now                → what is active now (or `at`) on every shop, point
                                           of sale and till in scope, and when it changes
GET    /catalog-menus-simulate           → "what is active for X at T": the menu, why, and
                                           what it sells there
GET    /reports/menu-sales               → sales by the menu that was active

The till receives its menus in the catalog pull (`catalogMenus`, app/routers/sync.py) and
works out which is active on its own clock. Every write wakes the organization's tills
after the commit (catalog notify, reason `catalog_menus_updated`), best effort.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.schemas.catalog_menu import MenuIn, MenuOrderIn, TargetAssignmentsIn
from app.services import catalog_menus as CM
from app.services.reports import resolve_report_window

router = APIRouter(tags=["catalog-menus"])


def _changed(db: Session, tenant_id, background_tasks: BackgroundTasks) -> None:
    targets = CM.notify_targets(db, tenant_id)
    db.commit()
    background_tasks.add_task(CM.publish_notify, targets)


@router.get("/catalog-menus")
def list_catalog_menus(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CM.list_menus(db, current_user, active_tenant_id)


@router.post("/catalog-menus", status_code=status.HTTP_201_CREATED)
def create_catalog_menu(
    body: MenuIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    menu = CM.create_menu(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return CM.one_menu_out(db, current_user, menu)


@router.get("/catalog-menus/{menu_id}")
def get_catalog_menu(
    menu_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CM.one_menu_out(db, current_user, CM.get_menu(db, current_user, active_tenant_id, menu_id))


@router.put("/catalog-menus/{menu_id}")
def update_catalog_menu(
    menu_id: str,
    body: MenuIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    menu = CM.get_menu(db, current_user, active_tenant_id, menu_id)
    CM.update_menu(db, current_user, active_tenant_id, menu, body)
    _changed(db, active_tenant_id, background_tasks)
    return CM.one_menu_out(db, current_user, menu)


@router.delete("/catalog-menus/{menu_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_catalog_menu(
    menu_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    menu = CM.get_menu(db, current_user, active_tenant_id, menu_id)
    CM.delete_menu(db, current_user, active_tenant_id, menu)
    _changed(db, active_tenant_id, background_tasks)


@router.put("/catalog-menus-order")
def reorder_catalog_menus(
    body: MenuOrderIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    CM.reorder_menus(db, current_user, active_tenant_id, body.ids)
    db.commit()
    return {"ok": True}


@router.get("/catalog-menus-targets")
def get_catalog_menu_targets(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CM.targets_overview(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)


@router.put("/catalog-menus-targets")
def set_catalog_menu_target(
    body: TargetAssignmentsIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    CM.set_target(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return {"ok": True}


@router.get("/catalog-menus-now")
def get_catalog_menus_now(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    at: Optional[str] = Query(None, description="ISO time; without an offset: the shop's local time"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CM.now_overview(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id, at=at)


@router.get("/catalog-menus-simulate")
def simulate_catalog_menus(
    level: str = Query(..., description="company | shop | area | machine"),
    target_id: uuid.UUID = Query(..., alias="targetId"),
    at: Optional[str] = Query(None, description="ISO time; without an offset: the shop's local time"),
    channel: Optional[str] = Query(None, description="pos | kiosk (a till: by what it is)"),
    preview: bool = Query(True),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return CM.simulate(
        db, current_user, active_tenant_id, level=level, target_id=target_id, at=at,
        surface=channel, preview=preview,
    )


@router.get("/reports/menu-sales")
def get_menu_sales_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    day_basis: Optional[str] = Query(
        None, alias="dayBasis",
        description="`business` (default): the business day (\"שעת סיום יום עסקי\"); `document`: the calendar date.",
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """דוח מכירות לפי תפריט: per menu active when the lines were added — units, money, menu-priced share."""
    from app.services.business_day import basis_of, scope_of

    window = resolve_report_window(
        db, active_tenant_id, from_date=from_date, to_date=to_date, from_hour=from_hour, to_hour=to_hour, tz=tz,
        day_basis=basis_of(day_basis), scope=scope_of(shop_id=shop_id, machine_id=machine_id),
    )
    return CM.menu_sales_report(db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id)
