"""
"חסימות ואזל" — blocks on a product for a scope, for a while (app/services/sold_out.py).

Dashboard (section `item_blocks`: view for reads, edit for writes; the roles and org scope of the
machine admins — a super admin, a distributor, a company manager over their companies' shops, a
shop manager over their shop — app/services/kiosk_control.py `check_*_scope`):

GET    /item-blocks                ?companyId=&shopId=&productId=&categoryId=&areaId=&target=&channel=&includeEnded= → [Block]
GET    /item-blocks/targets        ?shopId= → what the scope picker offers
GET    /item-blocks/resolve        ?shopId=&channel=&productIds=a,b&areaId= → {product id: {appears, state, …}}
POST   /item-blocks/end-preview    {mode, minutes?, at?, shopId?} → {until, rolled}
POST   /item-blocks                {productId | categoryId, kind, channels? | target?, kioskDisplay?,
                                    note?, targets: [{scope, scopeId}], duration} → [Block]
POST   /item-blocks/{id}/extend    {minutes} → Block
DELETE /item-blocks/{id}           → Block ("בטל עכשיו")
POST   /item-blocks/clear          {productId | categoryId, shopId?, companyId?} → {cleared} (every block of the item)

"חסימות מהקופה" (P:/specs/item-block-control.md; app/services/item_block_control.py) — the tills' roles:

GET    /item-blocks/control        ?level=company|shop|area|machine&id= → {own, inherited, inheritedFrom,
                                    defaults, canWrite, mainTill?, tills?, areas?, till?}
PUT    /item-blocks/control        {level, id, values | null} → as GET (the level's own `itemBlocks`)
PUT    /item-blocks/control/managing  {shopId, areaId?, all, machineIds} → as GET ("קופה מנהלת", several or all)
POST   /item-blocks/control/machines/{id}/managing  {managing} → as GET (the till card's switch)

"חסימה מהירה" (§4), by the shop's `quickDefaults`:

GET    /item-blocks/quick          ?shopId=&q= → {shop, quickDefaults, items: [{productId, name, state, blocks…}]}
POST   /item-blocks/quick          {productId, shopId, state: available | sold_out | blocked} → {item, quickDefaults}

`channels` — any of "pos" ("קופה"), "kiosk" ("קיוסק"), "online" ("הזמנות אונליין"), "menu" ("תפריט
דיגיטלי"); omitted: all four — on top of each target's level (specs/item-blocks-targets.md). A
client that sends `target` instead ("all" / "kiosks" / "tills") means pos + kiosk / kiosk / pos. An
older `kiosks` / `kiosk` scope still works and is written as shop / machine + kiosk.

Devices (`till_router`, the till's own token; a till, a kiosk's staff screen, a controlling till's
kiosk panel — specs/item-blocks-targets.md §4):

GET  /sync/{m}/item-blocks                 ?kioskId=&productId=&categoryId= → {blocks, context, areaDevices, events,
                                            presets…, itemBlocks?, allowed?}
POST /sync/{m}/item-blocks                 {productId | categoryId, kind, channels | target, level, levelId?,
                                            kioskDisplay?, note?, duration, kioskId?} → {block, until, rolled}
POST /sync/{m}/item-blocks/{id}/clear      ?kioskId= → Block

The approver is the till user named in `X-Pos-User-Id` (the operator acting alone, or the manager
who typed their code on the device): active, of the device's shop, with "חסימת פריט / אזל"
(ITEM_BLOCK) allowed by the cloud's roster — 403 `item_block_requires_manager` otherwise. A device
writes inside its shop only: the shop, its own point of sale (or the controlled kiosk's), itself, a
device of that point of sale, a kiosk it controls, an event of the shop. A kiosk — and a till acting
for a kiosk it controls — blocks for kiosks only. A till acting for itself also within its role
("חסימות מהקופה"), and beyond its local caps only with an approver holding ITEM_BLOCK_WIDE — 403
`block_scope_not_allowed` otherwise, for a block and for a release alike.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import or_
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
Channel = Literal["pos", "kiosk", "online", "menu"]
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
    #: Where at every target's level: "קופה" / "קיוסק" / "הזמנות אונליין" / "תפריט דיגיטלי"; omitted: all four.
    channels: Optional[List[Channel]] = Field(None, min_length=1, max_length=4)
    #: Before channels: "קופות וקיוסקים" / "קיוסקים בלבד" / "קופות בלבד" (used when `channels` is omitted).
    target: Optional[Reach] = None
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
    target: Annotated[Optional[Literal["all", "kiosks", "tills", "none"]], Query()] = None,
    channel: Annotated[Optional[Channel], Query()] = None,
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
        include_ended=include_ended, category_id=category_id, area_id=area_id, target=target, channel=channel,
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
        r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None))
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
        # The full form's defaults on the phone (P:/specs/item-block-control.md §4).
        "quickDefaults": _control().quick_defaults_for_shop(db, shop),
    }


@router.get("/resolve")
def resolve_channel(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    channel: Channel = Query(...),
    product_ids: str = Query(..., alias="productIds", max_length=20000),
    area_id: Annotated[Optional[uuid.UUID], Query(alias="areaId")] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The resolver for one channel (specs/item-blocks-targets.md): per product, whether it appears on
    the channel ("מופיע ב") and what the blocks in force reaching that channel at the shop decide.
    Online ordering and the digital menu call app/services/sold_out.py `resolve_channel` directly.
    """
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, current_user, shop, active_tenant_id)
    ids = [p.strip() for p in product_ids.split(",") if p.strip()][:500]
    return svc.resolve_channel(
        db, tenant_id=active_tenant_id, shop_id=shop.id, channel=channel, product_ids=ids, area_id=area_id,
    )


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
            reach=body.target, channels=body.channels, display=body.kiosk_display, origin="dashboard",
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


# ── "חסימות מהקופה": the tills' roles, per level (P:/specs/item-block-control.md §2, §5) ──


def _control():
    from app.services import item_block_control

    return item_block_control


ControlLevel = Literal["company", "shop", "area", "machine"]


class ControlIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    level: ControlLevel
    id: uuid.UUID
    #: The level's own `itemBlocks` — the whole of it; null or {} = nothing of its own (it inherits).
    values: Optional[Dict[str, Any]] = None


class ManagingIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    #: A point of sale's tills instead of the whole shop's.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    #: "כל הקופות": `role = managing` at the shop (or the point of sale).
    all: bool = False
    #: The tills that are managing; any other till of the shop (point of sale) is not.
    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds", max_length=500)


class MachineManagingIn(BaseModel):
    managing: bool


def _control_entity(db: Session, level: str, ident: uuid.UUID, tenant_id) -> tuple:
    """`(entity, shop)` of a level, this tenant's; 404 otherwise."""
    from app.models.shop_area import ShopArea as _Area

    entity = {"company": Company, "shop": Shop, "area": _Area, "machine": POSMachine}[level]
    row = db.get(entity, ident)
    if row is None or (getattr(row, "archived_at", None) is not None) or (
        tenant_id is not None and getattr(row, "tenant_id", None) is not None and str(row.tenant_id) != str(tenant_id)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{level}_not_found")
    if level == "company":
        return row, None
    if level == "shop":
        return row, row
    shop = db.get(Shop, row.shop_id) if row.shop_id else None
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shop_not_found")
    return row, shop


def _check_control(db: Session, user: User, level: str, entity: Any, shop: Optional[Shop], tenant_id, *, write: bool) -> None:
    """Read: the level's scope. Write: also never a whole shop or the company for a manager of points of sale."""
    if level == "company":
        kiosk_control.check_company_scope(db, user, entity, tenant_id)
    else:
        kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    if not write:
        return
    narrow = _narrowing(db, user)
    if narrow is not None and (level in ("company", "shop") or not _covers(db, narrow, level, entity.id)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")


def _layers_above(db: Session, level: str, entity: Any, shop: Optional[Shop]) -> list:
    """The settings layers above a level, least specific first."""
    from app.models.shop_area import ShopArea as _Area
    from app.models.tenant import Tenant

    C = _control()
    if level == "company":
        tenant = db.get(Tenant, entity.tenant_id) if entity.tenant_id else None
        return [("tenant", getattr(tenant, "settings", None))]
    above = C.layers_above_shop(db, shop)
    if level == "shop":
        return above
    above = above + [("shop", shop.settings)]
    if level == "area":
        return above
    area = db.get(_Area, entity.area_id) if getattr(entity, "area_id", None) else None
    return above + [("area", getattr(area, "settings", None))]


def _shop_tills(db: Session, shop: Shop, area_id: Any = None) -> List[POSMachine]:
    """The shop's active tills (kiosks and non-fiscal screens aside), the lowest number first."""
    from app.services.main_till import till_order

    q = db.query(POSMachine).filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
    if area_id is not None:
        q = q.filter(POSMachine.area_id == area_id)
    machines = [m for m in q.all() if getattr(m, "is_fiscal", True) is not False]
    kiosks = svc._kiosk_ids(db, [m.id for m in machines])
    return sorted([m for m in machines if m.id not in kiosks], key=till_order)


def _main_till_id(db: Session, shop: Shop):
    from app.services import main_till

    main = main_till.main_till_of_shop(db, shop.id)
    return main.id if main is not None else None


def _till_row(db: Session, machine: POSMachine, main_id, areas: Dict[Any, str]) -> Dict[str, Any]:
    C = _control()
    rules = C.rules_for_machine(db, machine, main_till_id=main_id)
    own = C.own_of(machine.settings)
    return {
        "id": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "areaId": str(machine.area_id) if machine.area_id else None,
        "areaName": areas.get(machine.area_id),
        "isMainTill": main_id is not None and str(main_id) == str(machine.id),
        "ownRole": own.get("role"),
        "role": rules.role,
        "roleSource": rules.sources.get("role"),
        "itemBlocks": rules.out(),
    }


def _area_names(db: Session, shop: Shop) -> Dict[Any, str]:
    return {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.shop_id == shop.id).all()}


def _control_view(db: Session, user: User, level: str, entity: Any, shop: Optional[Shop], tenant_id) -> Dict[str, Any]:
    C = _control()
    inherited, inherited_from = C.merged(_layers_above(db, level, entity, shop))
    own = C.own_of(entity.settings)
    try:
        _check_control(db, user, level, entity, shop, tenant_id, write=True)
        can_write = True
    except HTTPException:
        can_write = False
    out: Dict[str, Any] = {
        "level": level,
        "id": str(entity.id),
        "name": getattr(entity, "name", None),
        "own": own,
        "inherited": inherited,
        "inheritedFrom": inherited_from,
        "defaults": {**C.DEFAULTS, "quickDefaults": C.QUICK_DEFAULTS},
        "canWrite": can_write,
    }
    if shop is not None:
        main_id = _main_till_id(db, shop)
        areas = _area_names(db, shop)
        main = db.get(POSMachine, main_id) if main_id is not None else None
        out["mainTill"] = (
            {"id": str(main.id), "name": main.name, "posNumber": main.pos_number} if main is not None else None
        )
        if level == "machine":
            out["till"] = _till_row(db, entity, main_id, areas)
        else:
            tills = _shop_tills(db, shop, entity.id if level == "area" else None)
            out["tills"] = [_till_row(db, m, main_id, areas) for m in tills]
            if level == "shop":
                out["areas"] = [
                    {"id": str(a.id), "name": a.name, "ownRole": C.own_of(a.settings).get("role")}
                    for a in db.query(ShopArea)
                    .filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
                    .order_by(ShopArea.sort_order, ShopArea.name)
                    .all()
                ]
    return out


def _write_own(entity: Any, values: Optional[Dict[str, Any]], now: datetime) -> bool:
    """The level's own `itemBlocks` replaced (None: removed). True when it changed."""
    from app.services.settings_merge import patch_settings_json

    C = _control()
    before = (entity.settings or {}).get(C.SETTINGS_KEY) if isinstance(entity.settings, dict) else None
    if (before or None) == (values or None):
        return False
    entity.settings = patch_settings_json(entity.settings, {C.SETTINGS_KEY: values or None})
    if hasattr(entity, "settings_updated_at"):
        entity.settings_updated_at = now
    return True


def _set_own_role(entity: Any, role: Optional[str], now: datetime) -> bool:
    C = _control()
    own = dict(C.own_of(entity.settings))
    if role is None:
        own.pop("role", None)
    else:
        own["role"] = role
    return _write_own(entity, own or None, now)


def _notify_parameters(db: Session, background_tasks: BackgroundTasks, scopes: List[tuple]) -> None:
    from app.services import till_parameters as TPS

    targets: set = set()
    for scope_type, scope_id in scopes:
        targets.update(TPS.notify_targets_for_scope(db, scope_type, scope_id))
    if targets:
        background_tasks.add_task(TPS.publish_parameters_notify, sorted(targets))


@router.get("/control")
def get_control(
    level: ControlLevel = Query(...),
    ident: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"חסימות מהקופה" at one level: its own values, what it inherits and from where, and (a shop, a
    point of sale, a till) the tills with their role."""
    entity, shop = _control_entity(db, level, ident, active_tenant_id)
    _check_control(db, current_user, level, entity, shop, active_tenant_id, write=False)
    return _control_view(db, current_user, level, entity, shop, active_tenant_id)


@router.put("/control")
def put_control(
    body: ControlIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The level's own values, the whole of them (422 a value that is not one); the tills under it re-pull."""
    C = _control()
    entity, shop = _control_entity(db, body.level, body.id, active_tenant_id)
    _check_control(db, current_user, body.level, entity, shop, active_tenant_id, write=True)
    try:
        values = C.clean(body.values)
    except C.ItemBlockSettingsError as exc:
        raise HTTPException(status_code=422, detail={"code": "item_blocks_invalid", "message": str(exc)}) from exc
    if _write_own(entity, values, _now()):
        db.commit()
        _notify_parameters(db, background_tasks, [(body.level, body.id)])
    return _control_view(db, current_user, body.level, entity, shop, active_tenant_id)


def _set_managing(db: Session, machine: POSMachine, managing: bool, now: datetime, main_id) -> bool:
    """
    One till managing or not, the least written: its own role cleared when what it inherits already
    says so, else set ("managing" / "local"); a till set "none" stays so unless made managing.
    """
    C = _control()
    values, sources = C.merged(C.layers_for_machine(db, machine)[:-1])
    inherited = C.rules_of(values, sources, is_main_till=main_id is not None and str(main_id) == str(machine.id)).role
    own = C.own_of(machine.settings).get("role")
    if managing:
        return _set_own_role(machine, None if inherited == C.MANAGING else C.MANAGING, now)
    if inherited == C.MANAGING:
        return _set_own_role(machine, C.NONE if own == C.NONE else C.LOCAL, now)
    return _set_own_role(machine, None, now) if own == C.MANAGING else False


@router.put("/control/managing")
def put_managing_tills(
    body: ManagingIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "קופה מנהלת" picker for a shop or one of its points of sale (§2, the owner 13.10: several tills or
    all): `all` sets `role = managing` at that level (or clears it); then each till there is managing
    exactly when it is in `machineIds` — written at the till only where what it inherits differs.
    """
    C = _control()
    now = _now()
    level, ident = ("area", body.area_id) if body.area_id is not None else ("shop", body.shop_id)
    entity, shop = _control_entity(db, level, ident, active_tenant_id)
    if str(shop.id) != str(body.shop_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="area_not_found")
    _check_control(db, current_user, level, entity, shop, active_tenant_id, write=True)
    tills = _shop_tills(db, shop, body.area_id)
    wanted = {str(i) for i in body.machine_ids}
    unknown = wanted - {str(m.id) for m in tills}
    if unknown:
        raise HTTPException(status_code=422, detail={"code": "not_a_till_here", "message": "קופה שלא שייכת לסניף או לנקודת המכירה."})
    own = dict(C.own_of(entity.settings))
    if body.all:
        own["role"] = C.MANAGING
    elif own.get("role") == C.MANAGING:
        own.pop("role")
    changed = _write_own(entity, own or None, now)
    db.flush()
    main_id = _main_till_id(db, shop)
    for m in tills:
        changed = _set_managing(db, m, str(m.id) in wanted, now, main_id) or changed
    if changed:
        db.commit()
        _notify_parameters(db, background_tasks, [(level, ident)])
    return _control_view(db, current_user, level, entity, shop, active_tenant_id)


@router.post("/control/machines/{machine_id}/managing")
def post_machine_managing(
    machine_id: uuid.UUID,
    body: MachineManagingIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The till card's switch "קופה מנהלת לחסימות": this till managing or not (§5)."""
    entity, shop = _control_entity(db, "machine", machine_id, active_tenant_id)
    _check_control(db, current_user, "machine", entity, shop, active_tenant_id, write=True)
    if _set_managing(db, entity, body.managing, _now(), _main_till_id(db, shop)):
        db.commit()
        _notify_parameters(db, background_tasks, [("machine", machine_id)])
    return _control_view(db, current_user, "machine", entity, shop, active_tenant_id)


# ── "חסימה מהירה" from the phone (P:/specs/item-block-control.md §4) ──


QuickState = Literal["available", "sold_out", "blocked"]


class QuickIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    shop_id: uuid.UUID = Field(..., alias="shopId")
    state: QuickState


def _quick_shop(db: Session, user: User, shop_id: uuid.UUID, tenant_id) -> Shop:
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    return shop


def _quick_rows(db: Session, shop: Shop, products: List[Any], quick: Dict[str, Any], now: datetime) -> List[Dict[str, Any]]:
    """Per product: its state on the quick channels at the shop, and its blocks in force there."""
    if not products:
        return []
    channels = set(quick["channels"])
    blocks = svc.list_blocks(
        db, tenant_id=shop.tenant_id, shop_ids=[shop.id], company_ids=[shop.company_id] if shop.company_id else [],
        now=now,
    )
    chains = svc.product_category_chains(db, [p.id for p in products])
    categories = {}
    cids = list({p.category_id for p in products if p.category_id})
    if cids:
        from app.models.category import Category

        categories = {c.id: c.name for c in db.query(Category).filter(Category.id.in_(cids)).all()}
    out = []
    for p in products:
        chain = chains.get(str(p.id), [])
        mine = [
            b for b in blocks
            if (b.get("productId") == str(p.id) and b.get("itemType") == "product")
            or (b.get("itemType") == "category" and b.get("categoryId") in chain)
        ]
        here = [b for b in mine if channels & set(b.get("channels") or [])]
        state = "blocked" if any(b["kind"] == "blocked" for b in here) else (
            "sold_out" if here else "available"
        )
        deciding = next((b for b in here if b["kind"] == state), None)
        out.append({
            "productId": str(p.id),
            "name": p.name,
            "sku": p.sku,
            "imageUrl": p.image_url,
            "categoryName": categories.get(p.category_id),
            "state": state,
            "until": deciding.get("until") if deciding else None,
            "scopeLevel": deciding.get("level") if deciding else None,
            "scopeName": deciding.get("scopeName") if deciding else None,
            "blocks": [
                {
                    "id": b["id"], "kind": b["kind"], "level": b["level"], "scopeName": b.get("scopeName"),
                    "channels": b.get("channels"), "until": b.get("until"), "by": b.get("by"),
                    "source": b.get("source"), "itemType": b.get("itemType"), "note": b.get("note"),
                }
                for b in mine
            ],
        })
    return out


def _quick_products(db: Session, shop: Shop, q: Optional[str], product_id: Any = None, limit: int = 40) -> List[Any]:
    from sqlalchemy import or_ as _or

    from app.models.product import Product
    from app.models.shop_product_override import ShopProductOverride

    query = (
        db.query(Product)
        .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            ShopProductOverride.is_listed.is_(True),
            Product.pos_machine_id.is_(None),
        )
        .distinct()
    )
    if product_id is not None:
        query = query.filter(Product.id == product_id)
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        query = query.filter(_or(Product.name.ilike(like), Product.sku.ilike(like), Product.barcode.ilike(like)))
    return query.order_by(Product.name).limit(limit).all()


@router.get("/quick")
def get_quick(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    q: Annotated[Optional[str], Query(max_length=100)] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "חסימה מהירה": the shop's products matching `q` (name, SKU, barcode) — with no `q`, what is blocked
    now first — each "זמין" / "אזל" / "חסום" on the quick channels, and the quick defaults.
    """
    now = _now()
    shop = _quick_shop(db, current_user, shop_id, active_tenant_id)
    quick = _control().quick_defaults_for_shop(db, shop)
    products = _quick_products(db, shop, q)
    rows = _quick_rows(db, shop, products, quick, now)
    if not (q or "").strip():
        rows.sort(key=lambda r: (r["state"] == "available", r["name"] or ""))
    return {"shop": {"id": str(shop.id), "name": shop.name}, "quickDefaults": quick, "items": rows}


@router.post("/quick")
def post_quick(
    body: QuickIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    One tap: "זמין" removes the product's blocks in force at the shop on the quick channels (a company's
    only when the quick level is the company; a category's never — it stops more than this product);
    "אזל" / "חסום" sets one at the quick level, on the quick channels, for the quick duration (the
    other kind there, same channels, removed). Answers the product's row.
    """
    now = _now()
    shop = _quick_shop(db, current_user, body.shop_id, active_tenant_id)
    quick = _control().quick_defaults_for_shop(db, shop)
    product = svc.global_product(db, body.product_id, active_tenant_id)
    channels = set(quick["channels"])
    if quick["level"] == "company" and shop.company_id:
        target = svc.resolve_target(db, "company", shop.company_id, active_tenant_id)
    else:
        target = svc.resolve_target(db, "shop", shop.id, active_tenant_id)
    _check_target(db, current_user, target, active_tenant_id)
    marks = (
        db.query(SoldOutMark)
        .filter(SoldOutMark.product_id == product.id, SoldOutMark.tenant_id == active_tenant_id, svc.in_force_filter(now))
        .all()
    )

    def ours(mark: SoldOutMark) -> bool:
        if svc.level_of(mark) == "company":
            return target.scope == "company" and str(mark.scope_id) == str(target.scope_id)
        return mark.shop_id is not None and str(mark.shop_id) == str(shop.id)

    touched = []
    for mark in marks:
        if not ours(mark) or not set(svc.channels_of(mark)) <= channels:
            continue
        if body.state != "available" and not (
            mark.source == "manual" and mark.kind != body.state
            and svc.level_of(mark) == target.scope and str(mark.scope_id) == str(target.scope_id)
        ):
            continue
        try:
            _check_mark(db, current_user, mark, active_tenant_id)
        except HTTPException:
            continue
        svc.clear(db, mark, user=current_user, now=now)
        touched.append(mark)
    if body.state != "available":
        duration = DurationIn(**quick["duration"])
        end = _end(db, active_tenant_id, shop.id, duration, now)
        row = svc.block(
            db, tenant_id=active_tenant_id, product=product, target=target, kind=body.state,
            until=end.until, until_mode=end.mode, user=current_user, now=now,
            channels=list(quick["channels"]), origin="dashboard",
        )
        touched.append(row)
    db.commit()
    for mark in touched:
        if mark.kiosk_display == "hide":
            _wake_kiosks_of(db, mark)
    rows = _quick_rows(db, shop, [product], quick, now)
    return {"item": rows[0] if rows else None, "quickDefaults": quick}


# ── Devices: a till, a kiosk's staff screen, a controlling till's kiosk panel ──


class DeviceBlockIn(_ItemIn):
    kind: Literal["sold_out", "blocked"] = "sold_out"
    #: "קופה" / "קיוסק" / "הזמנות אונליין" / "תפריט דיגיטלי"; omitted: `target`'s, else all four.
    channels: Optional[List[Channel]] = Field(None, min_length=1, max_length=4)
    target: Optional[Reach] = None
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


#: "שחרר" is not offered: the explanation instead (P:/specs/item-block-control.md §1).
_HINT_AUTO = "משתחרר כשהמלאי מתעדכן, או מהענן"
_HINT_NO_PERMISSION = "אין לעובד הרשאה לשחרר חסימה כזו"


def _list_user(db: Session, machine: POSMachine, pos_user_id: Optional[str]):
    """The signed-in till user a device names when it lists (no refusal: an unknown one is ignored)."""
    from app.models.pos_user import PosUser

    ident = svc._uuid(pos_user_id)
    user = db.get(PosUser, ident) if ident is not None else None
    if user is None or not user.is_active or machine.shop_id is None or str(user.shop_id) != str(machine.shop_id):
        return None
    return user


def _release_of(db: Session, machine: POSMachine, mark: SoldOutMark, rules, user) -> Dict[str, Any]:
    """`{releasable, releaseNeeds, releaseHint}` of one block for this till (and its user, if named)."""
    from app.services import item_block_control as control

    if not device_may_clear(machine, mark):
        hint = _HINT_AUTO if mark.source == "auto" else control.HINT_CLOUD
        return {"releasable": False, "releaseNeeds": None, "releaseHint": hint}
    if rules is None:  # a kiosk's staff screen, a controlling till's kiosk panel: today's rule
        return {"releasable": True, "releaseNeeds": control.NARROW, "releaseHint": None}
    level = control.mark_level(db, machine, mark)
    if level is None:
        return {"releasable": False, "releaseNeeds": None, "releaseHint": control.HINT_CLOUD}
    verdict = control.release_verdict(rules, machine, level, svc.channels_of(mark))
    if not verdict.ok:
        return {"releasable": False, "releaseNeeds": None, "releaseHint": verdict.message}
    if user is not None and control.DENY in (
        control.permission_state(user, control.NARROW), control.permission_state(user, verdict.needs),
    ):
        return {"releasable": False, "releaseNeeds": None, "releaseHint": _HINT_NO_PERMISSION}
    return {"releasable": True, "releaseNeeds": verdict.needs, "releaseHint": None}


def _device_rows(
    db: Session, machine: POSMachine, home: POSMachine, now: datetime, *,
    rules=None, user=None, product_id=None, category_id=None,
) -> List[dict]:
    """
    "חסומים כעת" on a device: every block in force reaching its point of sale (or, with none, itself) —
    of one product (its category's too) or one category when named — each with whether this device
    (and its user) may release it. `rules`: the till's (app/services/item_block_control.py); None for
    a kiosk or a controlling till's kiosk panel, which keep today's rule.
    """
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    if shop is None:
        return []
    company_ids = [shop.company_id] if shop.company_id else []
    if home.area_id is not None:
        rows = svc.list_blocks(
            db, tenant_id=machine.tenant_id, shop_ids=[shop.id], company_ids=company_ids, area_id=home.area_id,
            now=now, product_id=product_id, category_id=category_id,
        )
    else:
        ctx = svc.device_context(db, home)
        till = ctx.till()
        q = db.query(SoldOutMark).filter(SoldOutMark.tenant_id == machine.tenant_id, svc._scope_filter(ctx), svc.in_force_filter(now))
        if product_id is not None:
            chain = svc.product_category_chains(db, [product_id]).get(str(product_id), [])
            item = SoldOutMark.product_id == product_id
            if chain:
                item = or_(item, SoldOutMark.category_id.in_([svc._uuid(c) for c in chain]))
            q = q.filter(item)
        if category_id is not None:
            q = q.filter(SoldOutMark.category_id == category_id)
        marks = q.order_by(SoldOutMark.created_at.desc()).limit(500).all()
        # Its own level, whatever the target: a till sees the kiosks-only blocks of its shop too.
        rows = svc.views(db, [m for m in marks if svc.rules.level_covers(svc.level_of(m), str(m.scope_id), till)], now)
    by_id = {m.id: m for m in db.query(SoldOutMark).filter(SoldOutMark.id.in_([uuid.UUID(r["id"]) for r in rows])).all()} if rows else {}
    out = []
    for r in rows:
        mark = by_id.get(uuid.UUID(r["id"]))
        release = (
            _release_of(db, machine, mark, rules, user) if mark is not None
            else {"releasable": False, "releaseNeeds": None, "releaseHint": None}
        )
        out.append({**r, **release, "removable": release["releasable"]})
    return out


def _till_rules(db: Session, machine: POSMachine, origin: str):
    """The till's block rules when it acts for itself; None for a kiosk or a controlling till's kiosk panel."""
    from app.services import item_block_control as control

    return control.rules_for_machine(db, machine) if origin == "till" else None


@till_router.get("/{machine_id}/item-blocks")
def device_blocks(
    machine_id: str,
    kiosk_id: Annotated[Optional[uuid.UUID], Query(alias="kioskId")] = None,
    product_id: Annotated[Optional[uuid.UUID], Query(alias="productId")] = None,
    category_id: Annotated[Optional[uuid.UUID], Query(alias="categoryId")] = None,
    pos_user_id: Annotated[Optional[str], Header(alias=POS_USER_HEADER)] = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    "חסומים כעת" for the device's point of sale — of one product (with its category's) or one category
    when named — and what its block sheet offers. A till acting for itself also gets its rules
    (`itemBlocks`, `allowed`) and, per block, whether it (and the signed-in user, `X-Pos-User-Id`) may
    release it (P:/specs/item-block-control.md §6, §8).
    """
    from app.services import item_block_control as control

    now = _now()
    home, origin, kiosks_only = _home(db, machine, kiosk_id)
    rules = _till_rules(db, machine, origin)
    user = _list_user(db, machine, pos_user_id)
    if product_id is not None:
        try:
            product_id = svc.global_product(db, product_id, machine.tenant_id).id
        except HTTPException:
            product_id = uuid.uuid4()  # not this tenant's: nothing of it is listed
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
        "blocks": _device_rows(
            db, machine, home, now, rules=rules, user=user, product_id=product_id, category_id=category_id,
        ),
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
    if rules is not None:
        out["itemBlocks"] = rules.out()
        out["allowed"] = control.allowed_out(rules, machine)
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
    """
    "חסום / אזל" from a device, approved by a till user with ITEM_BLOCK. One block. A till acting for
    itself writes within its role (P:/specs/item-block-control.md §2): 403 `block_scope_not_allowed`
    beyond it, or beyond the local caps without ITEM_BLOCK_WIDE (`needs`).
    """
    now = _now()
    rules = None
    try:
        approver = _device_approver(db, machine, pos_user_id)
        home, origin, kiosks_only = _home(db, machine, body.kiosk_id)
        rules = _till_rules(db, machine, origin)
        if rules is not None:
            body = _with_till_defaults(body, rules, machine)
        target = _device_level(db, machine, home, body)
        if rules is not None:
            _check_till_write(machine, rules, approver, target, body)
    except HTTPException as refused:
        return JSONResponse(status_code=refused.status_code, content={"detail": refused.detail})
    product, category = _item(db, body, machine.tenant_id)
    end = _end(db, machine.tenant_id, machine.shop_id, body.duration, now)
    row = svc.block(
        db, tenant_id=machine.tenant_id, product=product, category=category, target=target, kind=body.kind,
        until=end.until, until_mode=end.mode, note=body.note, by_name=_approver_name(machine, approver), now=now,
        reach=None if kiosks_only else body.target,
        # A kiosk (or a till acting for one) blocks for the kiosks alone.
        channels=["kiosk"] if kiosks_only else body.channels,
        display=body.kiosk_display, origin=origin,
    )
    db.commit()
    if "kiosk" in svc.channels_of(row):
        _wake_kiosks_of(db, row)
    view = _view(db, [row], now)[0]
    release = _release_of(db, machine, row, rules, approver)
    return {
        "block": {**view, **release, "removable": release["releasable"]},
        "until": end.until.isoformat() if end.until else None,
        "rolled": end.rolled,
    }


def _scope_refusal(message: str, needs: Optional[str] = None) -> HTTPException:
    detail: Dict[str, Any] = {"code": "block_scope_not_allowed", "message": message}
    if needs:
        detail["needs"] = needs
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


_WIDE_MESSAGE = (
    "חסימה מעבר לקופה (קיוסק, הזמנות אונליין, תפריט דיגיטלי, או היקף רחב מנקודת המכירה) דורשת אישור של "
    "מנהל עם הרשאת \"חסימה מעבר לקופה\"."
)


def _with_till_defaults(body: DeviceBlockIn, rules, machine: POSMachine) -> DeviceBlockIn:
    """What a till leaves out — the channels, the level — is the narrowest its role allows (§8.7)."""
    from app.services import item_block_control as control

    defaults = control.allowed_out(rules, machine).get("defaults")
    if not defaults:
        return body
    changes: Dict[str, Any] = {}
    if body.channels is None and body.target is None:
        changes["channels"] = list(defaults["channels"])
    if "level" not in body.model_fields_set and body.level_id is None:
        changes["level"] = defaults["level"]
    return body.model_copy(update=changes) if changes else body


def _requested_channels(body: DeviceBlockIn) -> List[str]:
    if body.channels is not None:
        return list(body.channels)
    if body.target is not None:
        return list(svc.rules.TARGET_CHANNELS[body.target])
    return list(svc.rules.CHANNELS)


def _check_till_write(machine: POSMachine, rules, approver: Any, target: svc.Target, body: DeviceBlockIn) -> None:
    """The till's role, then the approver's ITEM_BLOCK_WIDE beyond the local caps: 403 otherwise."""
    from app.services import item_block_control as control
    from app.services.till_roles import pos_user_allows

    level = control.target_level(machine, target.scope, target.scope_id, target.area_id)
    if level is None:
        raise _scope_refusal(control.HINT_MANAGING)
    verdict = control.write_verdict(rules, machine, level, _requested_channels(body))
    if not verdict.ok:
        raise _scope_refusal(verdict.message or "")
    if verdict.needs == control.WIDE and not pos_user_allows(approver, control.WIDE):
        raise _scope_refusal(_WIDE_MESSAGE, needs=control.WIDE)


def _check_till_release(db: Session, machine: POSMachine, rules, approver: Any, mark: SoldOutMark) -> None:
    from app.services import item_block_control as control
    from app.services.till_roles import pos_user_allows

    level = control.mark_level(db, machine, mark)
    if level is None:
        raise _scope_refusal(control.HINT_CLOUD)
    verdict = control.release_verdict(rules, machine, level, svc.channels_of(mark))
    if not verdict.ok:
        raise _scope_refusal(verdict.message or "")
    if verdict.needs == control.WIDE and not pos_user_allows(approver, control.WIDE):
        raise _scope_refusal(_WIDE_MESSAGE, needs=control.WIDE)


@till_router.post("/{machine_id}/item-blocks/{block_id}/clear", dependencies=FISCAL_SYNC_PATH)
def device_clear(
    machine_id: str,
    block_id: uuid.UUID,
    pos_user_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
    kiosk_id: Annotated[Optional[uuid.UUID], Query(alias="kioskId")] = None,
):
    """
    "שחרר" from a device: a hand block of its own shop. A till acting for itself releases within its
    role (P:/specs/item-block-control.md §3): 403 `block_scope_not_allowed` otherwise; a controlling
    till's kiosk panel (`kioskId`) and a kiosk keep today's rule.
    """
    now = _now()
    try:
        approver = _device_approver(db, machine, pos_user_id)
        _home_device, origin, _kiosks_only = _home(db, machine, kiosk_id)
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
    rules = _till_rules(db, machine, origin)
    if rules is not None and kiosk_id is None and mark.origin == "controller" and svc.level_of(mark) == "machine":
        # A kiosk panel that does not name its kiosk: a block it set on a kiosk this till controls.
        try:
            kiosk_control.controller_target(db, machine, mark.scope_id)
            rules = None
        except HTTPException:
            pass
    if rules is not None:
        try:
            _check_till_release(db, machine, rules, approver, mark)
        except HTTPException as refused:
            return JSONResponse(status_code=refused.status_code, content={"detail": refused.detail})
    svc.clear(db, mark, by_name=_approver_name(machine, approver), now=now)
    db.commit()
    if "kiosk" in svc.channels_of(mark):
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
