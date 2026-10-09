"""
"חסימות ואזל" — blocks on a product for a scope, for a while (app/services/sold_out.py).

Dashboard (section `item_blocks`: view for reads, edit for writes; the roles and org scope of the
machine admins — a super admin, a distributor, a company manager over their companies' shops, a
shop manager over their shop — app/services/kiosk_control.py `check_*_scope`):

GET    /item-blocks                ?companyId=&shopId=&productId=&categoryId=&areaId=&target=&includeEnded= → [Block]
GET    /item-blocks/targets        ?shopId= → what the scope picker offers
POST   /item-blocks/end-preview    {mode, minutes?, at?, shopId?} → {until, rolled}
POST   /item-blocks                {productId | categoryId, kind, target?, kioskDisplay?, note?,
                                    targets: [{scope, scopeId}], duration} → [Block]
POST   /item-blocks/{id}/extend    {minutes} → Block
DELETE /item-blocks/{id}           → Block ("בטל עכשיו")
POST   /item-blocks/clear          {productId | categoryId, shopId?, companyId?} → {cleared} (every block of the item)

`target` — "all" ("קופות וקיוסקים", the default) · "kiosks" ("קיוסקים בלבד") · "tills" ("קופות
בלבד"), on top of each target's level (specs/item-blocks-targets.md). An older `kiosks` / `kiosk`
scope still works and is written as shop / machine + kiosks.

Devices (`till_router`, the till's own token; a till, a kiosk's staff screen, a controlling till's
kiosk panel — specs/item-blocks-targets.md §4):

GET  /sync/{m}/item-blocks                 ?kioskId= → {blocks, context, areaDevices, events, presets…}
POST /sync/{m}/item-blocks                 {productId | categoryId, kind, target, level, levelId?,
                                            kioskDisplay?, note?, duration, kioskId?} → {block, until, rolled}
POST /sync/{m}/item-blocks/{id}/clear      → Block

The approver is the till user named in `X-Pos-User-Id` (the operator acting alone, or the manager
who typed their code on the device): active, of the device's shop, with "חסימת פריט / אזל"
(ITEM_BLOCK) allowed by the cloud's roster — 403 `item_block_requires_manager` otherwise. A device
writes inside its shop only: the shop, its own point of sale (or the controlled kiosk's), itself, a
device of that point of sale, a kiosk it controls, an event of the shop. A kiosk — and a till acting
for a kiosk it controls — blocks for kiosks only.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_SYNC_PATH, POS_USER_HEADER, get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path,
)
from app.models.company import Company
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.report_event import ReportEvent
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.sold_out import SoldOutMark
from app.models.user import User, UserRole
from app.services import block_durations, device_groups
from app.services import kiosk_control
from app.services import sold_out as svc
from app.services.company_hierarchy import visible_shop_ids

router = APIRouter(prefix="/item-blocks", tags=["item-blocks"])
till_router = APIRouter(prefix="/sync", tags=["item-blocks"])

Reach = Literal["all", "kiosks", "tills"]
Display = Literal["hide", "grey"]


class TargetIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scope: Literal["company", "shop", "kiosks", "area", "group", "event", "machine", "kiosk"]
    scope_id: uuid.UUID = Field(..., alias="scopeId")


class DurationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: Literal["none", "minutes", "time", "end_of_day"] = "none"
    minutes: Optional[int] = None
    at: Optional[str] = None


class _ItemIn(BaseModel):
    """A product or a category — exactly one."""

    model_config = ConfigDict(populate_by_name=True)

    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    category_id: Optional[uuid.UUID] = Field(None, alias="categoryId")

    @model_validator(mode="after")
    def _one_item(self):
        if (self.product_id is None) == (self.category_id is None):
            raise ValueError("exactly one of productId and categoryId")
        return self


class BlockIn(_ItemIn):
    kind: Literal["sold_out", "blocked"] = "sold_out"
    #: "קופות וקיוסקים" / "קיוסקים בלבד" / "קופות בלבד", on every target's level.
    target: Reach = "all"
    #: The kiosks' look for this block; None = their `general.soldOutMode`.
    kiosk_display: Optional[Display] = Field(None, alias="kioskDisplay")
    note: Optional[str] = Field(None, max_length=200)
    targets: List[TargetIn] = Field(..., min_length=1, max_length=200)
    duration: DurationIn = Field(default_factory=DurationIn)


class EndPreviewIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: Literal["none", "minutes", "time", "end_of_day"] = "none"
    minutes: Optional[int] = None
    at: Optional[str] = None
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


class ExtendIn(BaseModel):
    minutes: int = Field(..., ge=1, le=block_durations.MAX_MINUTES)


class ClearIn(_ItemIn):
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _shops_in_view(db: Session, user: User, tenant_id, *, company_id=None, shop_id=None) -> List[Any]:
    """The shops whose blocks this user may see, narrowed to a company or a shop."""
    kiosk_control.require_kiosk_role(user)
    q = db.query(Shop.id, Shop.company_id).filter(Shop.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(Shop.company_id == company_id)
    if shop_id is not None:
        q = q.filter(Shop.id == shop_id)
    rows = q.all()
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return [r[0] for r in rows]
    if user.role == UserRole.COMPANY_MANAGER:
        allowed = {str(s) for s in visible_shop_ids(db, user)}
        return [r[0] for r in rows if str(r[0]) in allowed]
    return [r[0] for r in rows if str(r[0]) == str(user.shop_id)]


def _narrowing(db: Session, user: User):
    """A manager of points of sale's areas / devices (app/services/stock_scope.py), or None."""
    from app.services import stock_scope

    scope = stock_scope.scope_of(db, user)
    return scope if scope.narrowed else None


def _covers(db: Session, scope, level: Optional[str], target_id) -> bool:
    """The node (`area` / `machine`) is one of theirs; a shop, the kiosks, an event, the company never."""
    from app.services import stock_locations as SL

    level = {"area": "area", "machine": "machine", "kiosk": "machine"}.get(level or "")
    if level is None or target_id is None:
        return False
    try:
        return scope.covers_path(SL.path_of(db, level, target_id))
    except LookupError:
        return False


def _check_target(db: Session, user: User, target: svc.Target, tenant_id) -> None:
    """
    The machine admins' scope rules: a company needs the company, anything else its shop; a manager
    of points of sale (app/services/stock_scope.py) only their areas and the devices in them — never
    a whole shop, the shop's kiosks, an event or the company.
    """
    from app.services import stock_locations as SL
    from app.services import stock_scope

    narrowed = stock_scope.scope_of(db, user)
    if target.scope == "company":
        company = db.get(Company, target.scope_id)
        kiosk_control.check_company_scope(db, user, company, tenant_id)
        if narrowed.narrowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
        return
    if target.scope == "group" and target.shop_id is None:
        # A device group across shops (app/services/device_groups.py): its company, like a company
        # target — and never a manager of points of sale (a group is not one of theirs).
        company = db.get(Company, target.company_id) if target.company_id is not None else None
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
        kiosk_control.check_company_scope(db, user, company, tenant_id)
        if narrowed.narrowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
        return
    shop = db.get(Shop, target.shop_id) if target.shop_id is not None else None
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    if narrowed.narrowed:
        level = {"area": "area", "machine": "machine", "kiosk": "machine"}.get(target.scope)
        if level is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
        try:
            path = SL.path_of(db, level, target.scope_id)
        except LookupError:  # the point of sale / device is gone (archived, deleted): 404, never a 500
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
        if not narrowed.covers_path(path):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")


def _check_mark(db: Session, user: User, mark: SoldOutMark, tenant_id) -> None:
    if str(mark.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="block_not_found")
    target = svc.Target(mark.scope, mark.scope_id, "", mark.company_id, mark.shop_id)
    _check_target(db, user, target, tenant_id)


def _zone_and_day_start(db: Session, tenant_id, shop_id) -> tuple:
    """The tenant's report zone and the system's one business-day start (04:00): no setting of a
    shop, point of sale or company can make blocks end at another hour than the reset and targets."""
    from app.services.reports import resolve_report_timezone

    return resolve_report_timezone(db, tenant_id, None), block_durations.business_day_start()


def _end(db: Session, tenant_id, shop_id, duration, now: datetime) -> block_durations.End:
    zone, day_start = _zone_and_day_start(db, tenant_id, shop_id)
    try:
        return block_durations.compute_end(
            duration.mode, now, zone_name=zone, minutes=duration.minutes, at=duration.at, day_start=day_start,
        )
    except block_durations.DurationRefused as refused:
        raise HTTPException(status_code=422, detail={"code": refused.code, "message": refused.message}) from refused


def _view(db: Session, marks: List[SoldOutMark], now: datetime) -> List[dict]:
    return svc.views(db, marks, now)


def _item(db: Session, body: _ItemIn, tenant_id) -> tuple:
    """`(product, category)` of the body, one of them None — the global product, the tenant's category."""
    if body.product_id is not None:
        return svc.global_product(db, body.product_id, tenant_id), None
    return None, svc.tenant_category(db, body.category_id, tenant_id)


@router.get("")
def list_blocks(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    product_id: Optional[uuid.UUID] = Query(None, alias="productId"),
    include_ended: bool = Query(False, alias="includeEnded"),
    category_id: Annotated[Optional[uuid.UUID], Query(alias="categoryId")] = None,
    area_id: Annotated[Optional[uuid.UUID], Query(alias="areaId")] = None,
    target: Annotated[Optional[Reach], Query()] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"חסומים כעת": `areaId` — what reaches a device of that point of sale; `target` — as the block means it."""
    shops = _shops_in_view(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)
    companies = None
    if shop_id is None:
        rows = db.query(Shop.company_id).filter(Shop.id.in_(shops)).distinct().all() if shops else []
        companies = [r[0] for r in rows if r[0] is not None]
    else:
        shop = db.get(Shop, shop_id)
        companies = [shop.company_id] if shop is not None and shop.company_id else []
    if product_id is not None:
        product_id = svc.global_product(db, product_id, active_tenant_id).id
    rows = svc.list_blocks(
        db, tenant_id=active_tenant_id, shop_ids=shops, company_ids=companies, product_id=product_id,
        include_ended=include_ended, category_id=category_id, area_id=area_id, target=target,
    )
    narrow = _narrowing(db, current_user)
    if narrow is not None:
        rows = [r for r in rows if _covers(db, narrow, r.get("scope"), r.get("scopeId"))]
    return rows


@router.get("/targets")
def list_targets(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What the scope picker offers for one shop: its company, the shop, its kiosks, areas, tills, events, groups."""
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, current_user, shop, active_tenant_id)
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    machines = [m for m in machines if getattr(m, "is_fiscal", True) is not False]
    kiosk_ids = {
        r[0] for r in db.query(KioskDevice.machine_id)
        .filter(KioskDevice.machine_id.in_([m.id for m in machines]), KioskDevice.enabled.is_(True)).all()
    } if machines else set()
    areas = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
    )
    events = (
        db.query(ReportEvent)
        .filter(ReportEvent.shop_id == shop.id, ReportEvent.status != "confirmed", ReportEvent.ends_at > _now())
        .order_by(ReportEvent.starts_at)
        .all()
    )
    company = db.get(Company, shop.company_id) if shop.company_id else None
    company_ok = False
    if company is not None:
        try:
            kiosk_control.check_company_scope(db, current_user, company, active_tenant_id)
            company_ok = True
        except HTTPException:
            company_ok = False
    # Device groups with a member here (app/services/device_groups.py): one inside this shop needs the
    # shop (checked above); one across shops needs its own company, as a company target does.
    groups = []
    company_scopes: dict = {}
    for g in device_groups.for_shop(db, shop):
        if g["shopId"] is None:
            key = str(g["companyId"])
            if key not in company_scopes:
                gc = db.get(Company, g["companyId"]) if g["companyId"] is not None else None
                try:
                    kiosk_control.check_company_scope(db, current_user, gc, active_tenant_id)
                    company_scopes[key] = gc is not None
                except HTTPException:
                    company_scopes[key] = False
            if not company_scopes[key]:
                continue
        groups.append(g)
    narrow = _narrowing(db, current_user)
    if narrow is not None:
        # A manager of points of sale picks among theirs only: no company, no event, no group.
        areas = [a for a in areas if _covers(db, narrow, "area", a.id)]
        machines = [m for m in machines if _covers(db, narrow, "machine", m.id)]
        events = []
        groups = []
        company_ok = False
    zone, day_start = _zone_and_day_start(db, active_tenant_id, shop.id)
    return {
        "company": {"id": str(company.id), "name": company.name} if company is not None and company_ok else None,
        "shop": {"id": str(shop.id), "name": shop.name},
        "areas": [{"id": str(a.id), "name": a.name} for a in areas],
        "tills": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "areaId": str(m.area_id) if m.area_id else None}
            for m in machines if m.id not in kiosk_ids
        ],
        "kiosks": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "areaId": str(m.area_id) if m.area_id else None}
            for m in machines if m.id in kiosk_ids
        ],
        "events": [
            {"id": str(e.id), "name": e.name, "startsAt": e.starts_at.isoformat(), "endsAt": e.ends_at.isoformat()}
            for e in events
        ],
        "groupsAvailable": device_groups.available(),
        "groups": [
            {"id": str(g["id"]), "name": g["name"], "machines": len(g["machineIds"]), "acrossShops": g["shopId"] is None}
            for g in groups
        ],
        "timezone": zone,
        "businessDayStart": day_start,
        "presets": list(block_durations.PRESET_MINUTES),
        "extendBy": list(block_durations.EXTEND_MINUTES),
    }


@router.post("/end-preview")
def end_preview(
    body: EndPreviewIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"חסום עד 14:35": the end the dialog's choice gives, in the shop's zone (a passed "עד שעה" rolls)."""
    kiosk_control.require_kiosk_role(current_user)
    end = _end(db, active_tenant_id, body.shop_id, body, _now())
    return {"until": end.until.isoformat() if end.until else None, "rolled": end.rolled, "mode": end.mode}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_blocks(
    body: BlockIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One block per target (same item, kind, reach, look, end and reason). All or nothing."""
    now = _now()
    product, category = _item(db, body, active_tenant_id)
    targets = []
    for t in body.targets:
        target = svc.resolve_target(db, t.scope, t.scope_id, active_tenant_id)
        _check_target(db, current_user, target, active_tenant_id)
        targets.append(target)
    first_shop = next((t.shop_id for t in targets if t.shop_id is not None), None)
    end = _end(db, active_tenant_id, first_shop, body.duration, now)
    rows = [
        svc.block(
            db, tenant_id=active_tenant_id, product=product, category=category, target=target, kind=body.kind,
            until=end.until, until_mode=end.mode, note=body.note, user=current_user, now=now,
            reach=body.target, display=body.kiosk_display, origin="dashboard",
        )
        for target in targets
    ]
    db.commit()
    for row in rows:
        # A block that hides rides on the kiosks' config too: they pull it at once.
        if row.kiosk_display == "hide":
            _wake_kiosks_of(db, row)
    out = _view(db, rows, now)
    return {"blocks": out, "until": end.until.isoformat() if end.until else None, "rolled": end.rolled}


@router.post("/clear")
def clear_product_blocks(
    body: ClearIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Every block in force of the product (or the category) in the shops (and companies) this user may manage."""
    now = _now()
    product, category = _item(db, body, active_tenant_id)
    shops = _shops_in_view(db, current_user, active_tenant_id, company_id=body.company_id, shop_id=body.shop_id)
    item = SoldOutMark.product_id == product.id if product is not None else SoldOutMark.category_id == category.id
    marks = (
        db.query(SoldOutMark)
        .filter(item, SoldOutMark.tenant_id == active_tenant_id, svc.in_force_filter(now))
        .all()
    )
    cleared = []
    for mark in marks:
        if mark.shop_id is not None and mark.shop_id not in shops:
            continue
        try:
            _check_mark(db, current_user, mark, active_tenant_id)
        except HTTPException:
            continue
        if mark.shop_id is None and body.shop_id is not None:
            continue
        svc.clear(db, mark, user=current_user, now=now)
        cleared.append(mark)
    db.commit()
    return {"cleared": len(cleared), "blocks": _view(db, cleared, now)}


def _mark_or_404(db: Session, block_id: uuid.UUID) -> SoldOutMark:
    mark = db.get(SoldOutMark, block_id)
    if mark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="block_not_found")
    return mark


@router.post("/{block_id}/extend")
def extend_block(
    block_id: uuid.UUID,
    body: ExtendIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    now = _now()
    mark = _mark_or_404(db, block_id)
    _check_mark(db, current_user, mark, active_tenant_id)
    svc.extend(db, mark, body.minutes, now=now)
    db.commit()
    if mark.kiosk_display == "hide":
        _wake_kiosks_of(db, mark)
    return _view(db, [mark], now)[0]


@router.delete("/{block_id}")
def clear_block(
    block_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    now = _now()
    mark = _mark_or_404(db, block_id)
    _check_mark(db, current_user, mark, active_tenant_id)
    svc.clear(db, mark, user=current_user, now=now)
    db.commit()
    if mark.kiosk_display == "hide":
        _wake_kiosks_of(db, mark)
    return _view(db, [mark], now)[0]


# ── Devices: a till, a kiosk's staff screen, a controlling till's kiosk panel ──


class DeviceBlockIn(_ItemIn):
    kind: Literal["sold_out", "blocked"] = "sold_out"
    target: Reach = "all"
    #: The level: the shop, a point of sale (the device's own by default), a device, an event.
    level: Literal["shop", "area", "machine", "event"] = "area"
    level_id: Optional[uuid.UUID] = Field(None, alias="levelId")
    kiosk_display: Optional[Display] = Field(None, alias="kioskDisplay")
    note: Optional[str] = Field(None, max_length=200)
    duration: DurationIn = Field(default_factory=DurationIn)
    #: A controlling till acting for this kiosk (its kiosk panel).
    kiosk_id: Optional[uuid.UUID] = Field(None, alias="kioskId")


def _refused(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _device_approver(db: Session, machine: POSMachine, pos_user_id: Optional[str]):
    """The till user who approves: active, of the device's shop, ITEM_BLOCK allowed (the cloud's roster)."""
    from app.models.pos_user import PosUser
    from app.services.till_roles import pos_user_allows

    ident = svc._uuid(pos_user_id)
    user = db.get(PosUser, ident) if ident is not None else None
    if (
        user is None
        or not user.is_active
        or machine.shop_id is None
        or str(user.shop_id) != str(machine.shop_id)
        or not pos_user_allows(user, "ITEM_BLOCK")
    ):
        raise _refused(
            status.HTTP_403_FORBIDDEN, "item_block_requires_manager",
            "נדרש אישור מנהל (הרשאת \"חסימת פריט / אזל\") כדי לחסום או לבטל חסימה.",
        )
    return user


def _approver_name(machine: POSMachine, user: Any) -> str:
    name = " ".join(p for p in (getattr(user, "first_name", None) or "", getattr(user, "last_name", None) or "") if p).strip()
    name = name or getattr(user, "username", None) or ""
    return f"{machine.name} · {name}" if name else (machine.name or "")


def _home(db: Session, machine: POSMachine, kiosk_id: Optional[uuid.UUID]) -> tuple:
    """`(home device, origin, kiosks only)`: the device itself, or the kiosk a controlling till names."""
    from app.services import kiosk_control

    if kiosk_id is not None and str(kiosk_id) != str(machine.id):
        kiosk_machine, _device = kiosk_control.controller_target(db, machine, kiosk_id)
        return kiosk_machine, "controller", True
    if svc.is_kiosk(db, machine):
        return machine, "kiosk", True
    return machine, "till", False


def _area_devices(db: Session, home: POSMachine) -> List[POSMachine]:
    if home.area_id is None:
        return [home]
    return (
        db.query(POSMachine)
        .filter(POSMachine.area_id == home.area_id, POSMachine.shop_id == home.shop_id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )


def _device_level(db: Session, machine: POSMachine, home: POSMachine, body: DeviceBlockIn) -> svc.Target:
    """The level a device may write at — inside its shop, around its own point of sale."""
    from app.services import kiosk_control

    if body.level == "shop":
        return svc.resolve_target(db, "shop", machine.shop_id, machine.tenant_id)
    if body.level == "area":
        area_id = body.level_id or home.area_id
        if area_id is None:
            raise _refused(422, "no_area", "המכשיר לא משויך לנקודת מכירה — בחרו סניף או מכשיר.")
        if home.area_id is None or str(area_id) != str(home.area_id):
            raise _refused(403, "outside_your_point_of_sale", "אפשר לחסום מכאן רק בנקודת המכירה של המכשיר.")
        target = svc.resolve_target(db, "area", area_id, machine.tenant_id)
    elif body.level == "machine":
        device_id = body.level_id or home.id
        device = db.get(POSMachine, device_id)
        if device is None or device.shop_id != machine.shop_id:
            raise _refused(404, "scope_not_found", "המכשיר לא נמצא")
        mine = {str(machine.id), str(home.id)}
        near = home.area_id is not None and device.area_id is not None and str(device.area_id) == str(home.area_id)
        controlled = False
        if str(device.id) not in mine and not near:
            try:
                kiosk_control.controller_target(db, machine, device.id)
                controlled = True
            except HTTPException:
                controlled = False
        if str(device.id) not in mine and not near and not controlled:
            raise _refused(403, "outside_your_point_of_sale", "אפשר לחסום מכאן רק מכשיר של נקודת המכירה.")
        target = svc.resolve_target(db, "machine", device.id, machine.tenant_id)
    else:
        if body.level_id is None:
            raise _refused(422, "scope_id_required", "בחרו אירוע")
        target = svc.resolve_target(db, "event", body.level_id, machine.tenant_id)
    if target.shop_id is None or str(target.shop_id) != str(machine.shop_id):
        raise _refused(403, "outside_your_shop", "אפשר לחסום מכאן רק בסניף של המכשיר.")
    return target


def device_may_clear(machine: POSMachine, mark: SoldOutMark) -> bool:
    """A device removes the hand blocks of its own shop — never a company's or a group across shops."""
    return (
        mark.source == "manual"
        and mark.shop_id is not None
        and str(mark.shop_id) == str(machine.shop_id)
        and svc.level_of(mark) != "company"
    )


def _device_rows(db: Session, machine: POSMachine, home: POSMachine, now: datetime) -> List[dict]:
    """"חסומים כעת" on a device: every block in force reaching its point of sale (or, with none, itself)."""
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    if shop is None:
        return []
    company_ids = [shop.company_id] if shop.company_id else []
    if home.area_id is not None:
        rows = svc.list_blocks(db, tenant_id=machine.tenant_id, shop_ids=[shop.id], company_ids=company_ids, area_id=home.area_id, now=now)
    else:
        ctx = svc.device_context(db, home)
        till = ctx.till()
        marks = (
            db.query(SoldOutMark)
            .filter(SoldOutMark.tenant_id == machine.tenant_id, svc._scope_filter(ctx), svc.in_force_filter(now))
            .order_by(SoldOutMark.created_at.desc())
            .limit(500)
            .all()
        )
        # Its own level, whatever the target: a till sees the kiosks-only blocks of its shop too.
        rows = svc.views(db, [m for m in marks if svc.rules.level_covers(svc.level_of(m), str(m.scope_id), till)], now)
    by_id = {m.id: m for m in db.query(SoldOutMark).filter(SoldOutMark.id.in_([uuid.UUID(r["id"]) for r in rows])).all()} if rows else {}
    out = []
    for r in rows:
        mark = by_id.get(uuid.UUID(r["id"]))
        out.append({**r, "removable": mark is not None and device_may_clear(machine, mark)})
    return out


@till_router.get("/{machine_id}/item-blocks")
def device_blocks(
    machine_id: str,
    kiosk_id: Annotated[Optional[uuid.UUID], Query(alias="kioskId")] = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """"חסומים כעת" for the device's point of sale, and what its block sheet offers."""
    now = _now()
    home, origin, kiosks_only = _home(db, machine, kiosk_id)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    area = db.get(ShopArea, home.area_id) if home.area_id else None
    kiosk_ids = svc._kiosk_ids(db, [m.id for m in _area_devices(db, home)])
    events = (
        db.query(ReportEvent)
        .filter(ReportEvent.shop_id == machine.shop_id, ReportEvent.status != "confirmed", ReportEvent.ends_at > now)
        .order_by(ReportEvent.starts_at)
        .all()
    ) if machine.shop_id else []
    zone, day_start = _zone_and_day_start(db, machine.tenant_id, machine.shop_id)
    out = {
        "blocks": _device_rows(db, machine, home, now),
        "context": {
            "shopId": str(shop.id) if shop else None,
            "shopName": shop.name if shop else None,
            "areaId": str(area.id) if area else None,
            "areaName": area.name if area else None,
            "machineId": str(home.id),
            "machineName": home.name,
            "isKiosk": bool(kiosks_only),
            "origin": origin,
            "kiosksOnly": bool(kiosks_only),
        },
        "areaDevices": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "isKiosk": m.id in kiosk_ids}
            for m in _area_devices(db, home)
        ],
        "events": [{"id": str(e.id), "name": e.name} for e in events],
        "timezone": zone,
        "businessDayStart": day_start,
        "presets": list(block_durations.PRESET_MINUTES),
        "serverTime": now.isoformat(),
    }
    db.commit()
    return out


# A write: fiscal devices only (a customer display or a KDS screen never blocks), as every till write.
@till_router.post("/{machine_id}/item-blocks", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_SYNC_PATH)
def device_block(
    machine_id: str,
    body: DeviceBlockIn,
    pos_user_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """"חסום / אזל" from a device, approved by a till user with ITEM_BLOCK. One block."""
    now = _now()
    try:
        approver = _device_approver(db, machine, pos_user_id)
        home, origin, kiosks_only = _home(db, machine, body.kiosk_id)
        target = _device_level(db, machine, home, body)
    except HTTPException as refused:
        return JSONResponse(status_code=refused.status_code, content={"detail": refused.detail})
    product, category = _item(db, body, machine.tenant_id)
    end = _end(db, machine.tenant_id, machine.shop_id, body.duration, now)
    row = svc.block(
        db, tenant_id=machine.tenant_id, product=product, category=category, target=target, kind=body.kind,
        until=end.until, until_mode=end.mode, note=body.note, by_name=_approver_name(machine, approver), now=now,
        reach="kiosks" if kiosks_only else body.target, display=body.kiosk_display, origin=origin,
    )
    db.commit()
    if kiosks_only or body.kiosk_display == "hide":
        _wake_kiosks_of(db, row)
    view = _view(db, [row], now)[0]
    return {"block": {**view, "removable": device_may_clear(machine, row)}, "until": end.until.isoformat() if end.until else None, "rolled": end.rolled}


@till_router.post("/{machine_id}/item-blocks/{block_id}/clear", dependencies=FISCAL_SYNC_PATH)
def device_clear(
    machine_id: str,
    block_id: uuid.UUID,
    pos_user_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """"בטל" from a device: a hand block of its own shop."""
    now = _now()
    try:
        approver = _device_approver(db, machine, pos_user_id)
    except HTTPException as refused:
        return JSONResponse(status_code=refused.status_code, content={"detail": refused.detail})
    mark = db.get(SoldOutMark, block_id)
    if mark is None or str(mark.tenant_id) != str(machine.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="block_not_found")
    if not device_may_clear(machine, mark):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": {"code": "not_from_here", "message": "חסימה של החברה או של סניף אחר — מבטלים אותה מהדשבורד."}},
        )
    svc.clear(db, mark, by_name=_approver_name(machine, approver), now=now)
    db.commit()
    if mark.kiosk_display == "hide" or svc.target_of(mark) != "tills":
        _wake_kiosks_of(db, mark)
    return {**_view(db, [mark], now)[0], "removable": False}


def _wake_kiosks_of(db: Session, mark: SoldOutMark) -> None:
    """The kiosks a block reaches pull their config at once (its "hide" rides on their config)."""
    from app.services import kiosk_menu

    try:
        kiosks = [m for m in svc.mark_devices(db, mark) if svc.is_kiosk(db, m)]
        if kiosks:
            kiosk_menu.wake_kiosks(mark.tenant_id, [str(m.id) for m in kiosks])
    except Exception:  # noqa: BLE001 - their next kiosk sync takes it anyway
        pass
