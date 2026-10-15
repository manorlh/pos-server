"""
The menu layer ("תוספות ושינויים", docs/SPEC_MENU_MODIFIERS.md).

Dashboard (Clerk/user JWT; writes by the catalog roles, see app/services/menu.py):

GET    /menu/groups                     → modifier groups with their options and usage
POST   /menu/groups                     → create (`categoryIds` assigns it to categories)
PUT    /menu/groups/{id}                → replace (options matched by id)
DELETE /menu/groups/{id}
PUT    /menu/groups-order               → `{"ids": [...]}`, the drag order
GET    /menu/products/{id}              → the product form's section: allergens, course,
                                          groups (own / inherited), note chips, meal
PUT    /menu/products/{id}              → any of those, in one save
GET    /menu/categories/{id}            → course, groups, note chips
PUT    /menu/categories/{id}
GET    /menu/notes                      → the chips every dish gets, per company
PUT    /menu/notes                      → `{"companyId", "notes": [...]}`
POST   /menu/modifier-options/{id}/image → the option's picture (multipart `file`; the background
                                          removed as a product's, `?keepBackground=true` keeps it)
DELETE /menu/modifier-options/{id}/image → removed (the linked product's picture shows)
POST   /menu/notes/{id}/image           → a note chip's picture (the same pipeline)
DELETE /menu/notes/{id}/image
GET    /menu/upsells | POST | PUT /{id} | DELETE /{id}   → upsell rules ("הגדלות מכירה")
GET    /menu/courses | PUT              → the course list, per company
GET    /menu/courses/quick-setup?companyId= → "הגדרה מהירה לשלבי הגשה": suggestions, levels, the
                                          tab's status line, whether there is a setup to undo
POST   /menu/courses/quick-setup        → apply (courses, category mapping, `coursesEnabled` at a level)
POST   /menu/courses/quick-setup/undo   → put back what the quick setup changed
PUT    /menu/courses/enabled            → the status line's switch (`{"companyId", "on"}`)
GET    /reports/modifier-sales          → options chosen and their revenue
GET    /reports/meal-sales              → meals and their components, money allocated
GET    /reports/upsells                 → shown / taken / dismissed / revenue per rule

Till (machine JWT):

POST   /sync/{machine_id}/upsell-stats  → the till's counts per rule and day (totals)

The till receives the definitions in the catalog pull (`menu`, app/routers/sync.py). Every
write wakes the organization's tills after the commit (catalog notify, reason
`menu_updated`), best effort.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.courses_quick_setup import CoursesSwitchIn, QuickCompanyIn, QuickSetupIn
from app.schemas.menu import (
    CategoryMenuIn,
    CoursesIn,
    GroupIn,
    GroupOrderIn,
    NotesIn,
    ProductMenuIn,
    UpsellIn,
    UpsellStatsIn,
)
from app.services import menu as M
from app.services.reports import resolve_report_window

router = APIRouter(tags=["menu"])


def _changed(db: Session, tenant_id, background_tasks: BackgroundTasks) -> None:
    targets = M.notify_targets(db, tenant_id)
    db.commit()
    background_tasks.add_task(M.publish_menu_notify, targets)


# ── Modifier groups ───────────────────────────────────────────────────────────


@router.get("/menu/groups")
def list_groups(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return M.list_groups(db, current_user, active_tenant_id)


@router.post("/menu/groups", status_code=status.HTTP_201_CREATED)
def create_group(
    body: GroupIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = M.create_group(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.one_group_out(db, current_user, active_tenant_id, group)


@router.put("/menu/groups/{group_id}")
def update_group(
    group_id: str,
    body: GroupIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = M.get_group(db, active_tenant_id, group_id)
    M.update_group(db, current_user, active_tenant_id, group, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.one_group_out(db, current_user, active_tenant_id, group)


@router.delete("/menu/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(
    group_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    group = M.get_group(db, active_tenant_id, group_id)
    M.delete_group(db, current_user, active_tenant_id, group)
    _changed(db, active_tenant_id, background_tasks)


@router.put("/menu/groups-order")
def reorder_groups(
    body: GroupOrderIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    M.reorder_groups(db, current_user, active_tenant_id, body.ids)
    _changed(db, active_tenant_id, background_tasks)
    return M.list_groups(db, current_user, active_tenant_id)


# ── Product / category sections ───────────────────────────────────────────────


@router.get("/menu/products/{product_id}")
def get_product_menu(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = M.get_product(db, active_tenant_id, product_id)
    return M.product_menu_out(db, current_user, active_tenant_id, product)


@router.put("/menu/products/{product_id}")
def put_product_menu(
    product_id: str,
    body: ProductMenuIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = M.get_product(db, active_tenant_id, product_id)
    M.set_product_menu(db, current_user, active_tenant_id, product, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.product_menu_out(db, current_user, active_tenant_id, product)


@router.get("/menu/categories/{category_id}")
def get_category_menu(
    category_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    category = M.get_category(db, active_tenant_id, category_id)
    return M.category_menu_out(db, current_user, active_tenant_id, category)


@router.put("/menu/categories/{category_id}")
def put_category_menu(
    category_id: str,
    body: CategoryMenuIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    category = M.get_category(db, active_tenant_id, category_id)
    M.set_category_menu(db, current_user, active_tenant_id, category, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.category_menu_out(db, current_user, active_tenant_id, category)


# ── Note chips for every dish ─────────────────────────────────────────────────


@router.get("/menu/notes")
def list_global_notes(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return M.list_global_notes(db, current_user, active_tenant_id)


@router.put("/menu/notes")
def put_global_notes(
    body: NotesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    M.set_global_notes(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.list_global_notes(db, current_user, active_tenant_id)


# ── Pictures: an option's, a note chip's ──────────────────────────────────────
# The product pipeline (app/routers/images.py): the same type and size checks, the background
# cut out (app/services/product_image_processing.py), the same storage, the upload kept beside it.


def _picture_out(upload, **row) -> dict:
    out = upload.model_dump(by_alias=True) if upload is not None else {}
    out.update(row)
    return out


@router.post("/menu/modifier-options/{option_id}/image", status_code=status.HTTP_201_CREATED)
async def upload_option_image(
    option_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    keep_background: bool = Query(False, alias="keepBackground"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.routers import images

    images._check_image_role(current_user)
    option, group = M.get_option(db, active_tenant_id, option_id)
    M.check_company_write(db, current_user, active_tenant_id, group.company_id)
    contents = await images.read_checked_upload(file)
    upload = await images.store_upload(contents, active_tenant_id, "products", keep_background)
    M.set_option_image(db, current_user, active_tenant_id, option, group, upload.url)
    _changed(db, active_tenant_id, background_tasks)
    return _picture_out(upload, option=M.option_out(option))


@router.delete("/menu/modifier-options/{option_id}/image")
def delete_option_image(
    option_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    option, group = M.get_option(db, active_tenant_id, option_id)
    M.set_option_image(db, current_user, active_tenant_id, option, group, None)
    _changed(db, active_tenant_id, background_tasks)
    return {"option": M.option_out(option)}


@router.post("/menu/notes/{note_id}/image", status_code=status.HTTP_201_CREATED)
async def upload_note_image(
    note_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    keep_background: bool = Query(False, alias="keepBackground"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.routers import images

    images._check_image_role(current_user)
    note = M.get_note(db, active_tenant_id, note_id)
    M.check_note_write(db, current_user, active_tenant_id, note)
    contents = await images.read_checked_upload(file)
    upload = await images.store_upload(contents, active_tenant_id, "products", keep_background)
    M.set_note_image(db, current_user, active_tenant_id, note, upload.url)
    _changed(db, active_tenant_id, background_tasks)
    return _picture_out(upload, note=M.note_out(note))


@router.delete("/menu/notes/{note_id}/image")
def delete_note_image(
    note_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    note = M.get_note(db, active_tenant_id, note_id)
    M.set_note_image(db, current_user, active_tenant_id, note, None)
    _changed(db, active_tenant_id, background_tasks)
    return {"note": M.note_out(note)}


# ── Upsell rules ──────────────────────────────────────────────────────────────


@router.get("/menu/upsells")
def list_upsells(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return M.list_upsells(db, current_user, active_tenant_id)


@router.post("/menu/upsells", status_code=status.HTTP_201_CREATED)
def create_upsell(
    body: UpsellIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule = M.create_upsell(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.one_upsell_out(db, current_user, active_tenant_id, rule)


@router.put("/menu/upsells/{rule_id}")
def update_upsell(
    rule_id: str,
    body: UpsellIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule = M.get_upsell(db, active_tenant_id, rule_id)
    M.update_upsell(db, current_user, active_tenant_id, rule, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.one_upsell_out(db, current_user, active_tenant_id, rule)


@router.delete("/menu/upsells/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upsell(
    rule_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule = M.get_upsell(db, active_tenant_id, rule_id)
    M.delete_upsell(db, current_user, active_tenant_id, rule)
    _changed(db, active_tenant_id, background_tasks)


# ── Courses ───────────────────────────────────────────────────────────────────


@router.get("/menu/courses")
def list_courses(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return M.list_courses(db, current_user, active_tenant_id)


@router.put("/menu/courses")
def put_courses(
    body: CoursesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    M.replace_courses(db, current_user, active_tenant_id, body)
    _changed(db, active_tenant_id, background_tasks)
    return M.list_courses(db, current_user, active_tenant_id)


# ── "הגדרה מהירה לשלבי הגשה" (app/services/courses_quick_setup.py) ──────────────


def _quick_done(db: Session, tenant_id, background_tasks: BackgroundTasks, out: dict) -> None:
    """Commit, then wake the tills: the menu (catalog notify) and the parameters of the levels written."""
    from app.services.till_parameters import publish_parameters_notify

    targets = out.pop("notify", None) or []
    if out.pop("menuChanged", True):
        _changed(db, tenant_id, background_tasks)
    else:
        db.commit()
    if targets:
        background_tasks.add_task(publish_parameters_notify, targets)


@router.get("/menu/courses/quick-setup")
def get_courses_quick_setup(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import courses_quick_setup as Q

    company = Q.company_of(db, active_tenant_id, company_id)
    Q.check_readable(db, current_user, active_tenant_id, company)
    out = Q.view(db, current_user, active_tenant_id, company)
    db.commit()  # `ensure_builtin_parameters` may have created them
    return out


@router.post("/menu/courses/quick-setup")
def post_courses_quick_setup(
    body: QuickSetupIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import courses_quick_setup as Q

    company = Q.company_of(db, active_tenant_id, body.company_id)
    try:
        out = Q.apply(db, current_user, active_tenant_id, company, body)
    except Exception:
        db.rollback()
        raise
    _quick_done(db, active_tenant_id, background_tasks, out)
    return {"changes": out, "view": Q.view(db, current_user, active_tenant_id, company)}


@router.post("/menu/courses/quick-setup/undo")
def undo_courses_quick_setup(
    body: QuickCompanyIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import courses_quick_setup as Q

    company = Q.company_of(db, active_tenant_id, body.company_id)
    try:
        out = Q.undo(db, current_user, active_tenant_id, company)
    except Exception:
        db.rollback()
        raise
    _quick_done(db, active_tenant_id, background_tasks, out)
    return {"result": out, "view": Q.view(db, current_user, active_tenant_id, company)}


@router.put("/menu/courses/enabled")
def put_courses_enabled(
    body: CoursesSwitchIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import courses_quick_setup as Q
    from app.services.till_parameters import publish_parameters_notify

    company = Q.company_of(db, active_tenant_id, body.company_id)
    try:
        out = Q.set_enabled(db, current_user, active_tenant_id, company, body.on)
    except Exception:
        db.rollback()
        raise
    db.commit()
    if out.get("notify"):
        background_tasks.add_task(publish_parameters_notify, out["notify"])
    return {"levels": out["levels"], "view": Q.view(db, current_user, active_tenant_id, company)}


# ── Reports ───────────────────────────────────────────────────────────────────


def _window(db, tenant_id, from_date, to_date, from_hour, to_hour, tz):
    return resolve_report_window(
        db, tenant_id, from_date=from_date, to_date=to_date, from_hour=from_hour, to_hour=to_hour, tz=tz
    )


@router.get("/reports/modifier-sales")
def get_modifier_sales_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """דוח מכירות תוספות: per option — units sold and refunded, revenue, removals counted apart."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return M.build_modifier_sales_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )


@router.get("/reports/meal-sales")
def get_meal_sales_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """דוח ארוחות: per meal — units and money, and its components with the money allocated."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return M.build_meal_sales_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )


@router.get("/reports/upsells")
def get_upsell_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    from_hour: Optional[int] = Query(None, alias="fromHour"),
    to_hour: Optional[int] = Query(None, alias="toHour"),
    tz: Optional[str] = Query(None),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """דוח הגדלות מכירה: per rule — shown, taken, dismissed, acceptance rate, revenue."""
    window = _window(db, active_tenant_id, from_date, to_date, from_hour, to_hour, tz)
    return M.build_upsell_report(
        db, current_user, active_tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )


# ── The till's side ───────────────────────────────────────────────────────────


@router.post("/sync/{machine_id}/upsell-stats")
def post_upsell_stats(
    machine_id: str,
    body: UpsellStatsIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """`{"stats": [{"ruleId", "day": "YYYY-MM-DD", "shown", "accepted", "dismissed"}]}` — totals so far."""
    out = M.record_upsell_stats(db, machine, body)
    db.commit()
    return out
