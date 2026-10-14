"""
"עיצוב קופה" — the till design (app/services/till_design.py, docs/SPEC_TILL_DESIGN.md).

Till (`get_pos_machine_for_sync_path`: the machine token, path machine = token machine):

GET  /sync/{machine_id}/till-design     the effective design (company → shop → area → till),
                                        `{schemaVersion, configVersion, config, updatedAt,
                                        orderNumberPrefix}`; ETag = configVersion (with the
                                        till's order-number prefix, when it has one), 304 on
                                        If-None-Match

Dashboard (Clerk; read and write: super admin, distributor (own tills), company manager
(company tree), shop manager (own shop, its points of sale and tills) — never a cashier or a
shift supervisor; the company layer is not a shop manager's):

GET  /till-design/defaults              `{defaults, catalog, phase2MinVersion}` (vocabularies,
                                        templates, profiles; the first till version that shows
                                        phase 2's templates)
GET  /till-design/targets?shopId=       the shop's points of sale and tills, for the level pickers
                                        (each till's version and whether it shows phase 2)
GET  /till-design/settings?level=company|shop|area|machine&id=
PUT  /till-design/settings?level=&id=   `{overrides}` — replaces that level's partial layer
GET  /till-design/category-display?level=&id=
PUT  /till-design/category-display?level=&id=   `{values: {categoryColors?, categoryImages?,
                                        categoryImageSize?}}` (null inherits) — "צבע ותמונה
                                        למחלקה": three till parameters at that level
                                        (app/services/category_display.py), with the same
                                        access as the design; the tills get them with their
                                        parameters (Ably `till_parameters_updated`)
GET  /till-design/table-display?level=&id=   "שולחנות ומפה" (P:/specs/till-design-tables.md §5): the
                                        tables' look and the map's display — till parameters
                                        (app/services/table_tile_look.py, table_map_display.py) —
                                        what the level sets, inherits, the definitions, `canEdit`
PUT  /till-design/table-display?level=&id=   `{values: {key: value|null}}` — null inherits again;
                                        the same access as the design; the tills under the level
                                        pull their parameters (`till_parameters_updated`)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.till_design import TillDesignSettings
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User
from app.services import kiosk_control as access
from app.services import till_design as design
from app.services.till_parameters import TillScopeChain, resolve_till_parameters

till_router = APIRouter(prefix="/sync", tags=["till-design"])
router = APIRouter(prefix="/till-design", tags=["till-design"])

#: The Ably `settings` notify reason a design save sends each affected till.
NOTIFY_REASON = "till_design_updated"


class TillDesignSettingsIn(BaseModel):
    """`PUT /till-design/settings`: the whole partial layer of that level (replaces the stored one)."""

    overrides: Dict[str, Any] = Field(default_factory=dict)


class CategoryDisplayIn(BaseModel):
    """`PUT /till-design/category-display`: key → code, null to inherit; a key left out stays as it is."""

    values: Dict[str, Any] = Field(default_factory=dict)


class TableDisplayIn(BaseModel):
    """`PUT /till-design/table-display`: key → value; null clears this level's own value (it inherits)."""

    values: Dict[str, Any] = Field(default_factory=dict)


# ── The till ─────────────────────────────────────────────────────────────────


@till_router.get("/{machine_id}/till-design")
def get_till_design_sync(
    machine_id: str,
    request: Request,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    This till's design, resolved company → shop → area → till over the defaults (which are
    today's screens). Pulled with the parameters (start, sync cycle, heartbeat, an Ably
    `settings` notify with reason `till_design_updated`); a bare 304 when unchanged.
    """
    from app.services import sync_versions

    bundle = design.sync_bundle(db, machine)
    etag = design.bundle_etag(bundle)
    # "מצב סנכרון" (app/services/sync_versions.py): the same ETag, as the `settings.design` key.
    headers = {"ETag": etag, sync_versions.HEADER: sync_versions.header_value({"settings.design": etag})}
    if request is not None and request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(content=bundle, headers=headers)


# ── Dashboard scope ──────────────────────────────────────────────────────────


class Scope:
    """One layer's place: the level, its entity, its tenant and the ids along its path."""

    def __init__(self, level: str, entity, tenant_id, *, company_id=None, shop_id=None, area_id=None, machine_id=None):
        self.level, self.entity, self.tenant_id = level, entity, tenant_id
        self.company_id, self.shop_id, self.area_id, self.machine_id = company_id, shop_id, area_id, machine_id

    @property
    def entity_id(self):
        return {"company": self.company_id, "shop": self.shop_id, "area": self.area_id, "machine": self.machine_id}[self.level]


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _company_id_of_shop(db: Session, shop_id) -> Optional[uuid.UUID]:
    if shop_id is None:
        return None
    row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
    return row[0] if row else None


def resolve_scope(db: Session, user: User, level: str, scope_id: Any, tenant_id) -> Scope:
    """`?level=&id=` → the scope, after the kiosk settings' access rules (404 / 403)."""
    eid = _uuid(scope_id)
    if level == "company":
        company = db.get(Company, eid) if eid else None
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        access.check_company_scope(db, user, company, tenant_id)
        return Scope("company", company, company.tenant_id, company_id=company.id)
    if level == "shop":
        shop = db.get(Shop, eid) if eid else None
        if shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
        access.check_shop_scope(db, user, shop, tenant_id)
        return Scope("shop", shop, shop.tenant_id, company_id=shop.company_id, shop_id=shop.id)
    if level == "area":
        area = db.get(ShopArea, eid) if eid else None
        shop = db.get(Shop, area.shop_id) if area is not None else None
        if area is None or shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
        access.check_shop_scope(db, user, shop, tenant_id)
        return Scope("area", area, area.tenant_id, company_id=shop.company_id, shop_id=shop.id, area_id=area.id)
    if level == "machine":
        machine = db.get(POSMachine, eid) if eid else None
        if machine is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
        access.check_machine_scope(db, user, machine, tenant_id)
        return Scope(
            "machine", machine, machine.tenant_id,
            company_id=_company_id_of_shop(db, machine.shop_id), shop_id=machine.shop_id,
            area_id=getattr(machine, "area_id", None), machine_id=machine.id,
        )
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_level")


def _layers(db: Session, scope: Scope) -> design.Layers:
    return design.layers_for(
        db, company_id=scope.company_id, shop_id=scope.shop_id, area_id=scope.area_id, machine_id=scope.machine_id,
    )


def parent_layers(db: Session, scope: Scope) -> List[Dict[str, Any]]:
    """The stored layers above this level, in order."""
    ordered = _layers(db, scope).ordered()
    return ordered[: design.LEVELS.index(scope.level)]


def _legacy(db: Session, scope: Scope) -> Dict[str, Any]:
    """The overlapping till parameters as they resolve AT this level (its parents included)."""
    keep = design.LEVELS.index(scope.level)
    chain = TillScopeChain(
        machine_id=scope.machine_id if keep >= 3 else None,
        area_id=scope.area_id if keep >= 2 else None,
        shop_id=scope.shop_id if keep >= 1 else None,
        company_id=scope.company_id,
    )
    keys = sorted({k for ks in design.LEGACY_MAP.values() for k in ks})
    parameters = db.query(TillParameter).filter(TillParameter.key.in_(keys)).all()
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
        for kind, ident in chain.scopes()
    ]
    values = db.query(TillParameterValue).filter(or_(*on_chain)).all() if on_chain else []
    resolved = resolve_till_parameters(parameters, values, chain).parameters
    return design.legacy_view(resolved)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def settings_view(db: Session, scope: Scope) -> Dict[str, Any]:
    row = design.layer_row(db, scope.level, scope.entity_id)
    parents = parent_layers(db, scope)
    overrides = design.sanitize_stored_layer(row.overrides if row is not None else {})
    effective = design.resolve(*parents, overrides)
    updated_by = None
    if row is not None and row.updated_by_user_id is not None:
        user = db.get(User, row.updated_by_user_id)
        updated_by = access.user_name(user) if user is not None else None
    return {
        "level": scope.level,
        "id": str(scope.entity_id),
        "overrides": overrides,
        "inherited": design.resolve(*parents),
        "inheritedLayers": design.explicit_layers(*parents),
        "effective": effective,
        "configVersion": design.config_version(effective),
        "legacy": _legacy(db, scope),
        "updatedAt": _iso(row.updated_at) if row is not None else None,
        "updatedBy": updated_by,
        "updatedByUserId": str(row.updated_by_user_id) if row is not None and row.updated_by_user_id else None,
    }


def save_settings(db: Session, user: User, scope: Scope, overrides: Any) -> TillDesignSettings:
    """
    Replace this level's layer, validated as a layer and on (parents ⊕ the new layer), so a
    till never receives a config that does not validate. Raises `TillDesignInvalid`; the
    caller commits.
    """
    cleaned, errors = design.validate_layer(overrides)
    merged = design.merge(design.resolve(*parent_layers(db, scope)), cleaned)
    errors = design._dedupe(list(errors) + design.validate_config(merged))
    if errors:
        raise design.TillDesignInvalid(errors)
    row = design.layer_row(db, scope.level, scope.entity_id)
    if row is None:
        row = TillDesignSettings(
            id=uuid.uuid4(),
            tenant_id=scope.tenant_id,
            level=scope.level,
            company_id=scope.company_id if scope.level == "company" else None,
            shop_id=scope.shop_id if scope.level == "shop" else None,
            area_id=scope.area_id if scope.level == "area" else None,
            machine_id=scope.machine_id if scope.level == "machine" else None,
        )
        db.add(row)
    row.overrides = cleaned
    row.updated_at = datetime.now(timezone.utc)
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    return row


def notify_targets(db: Session, scope: Scope) -> List[tuple]:
    """`(tenant_id, machine_id)` of every active till the layer applies to."""
    from app.services.till_parameters import notify_targets_for_scope

    return list(notify_targets_for_scope(db, scope.level, scope.entity_id))


def publish_design_notify(targets) -> None:
    from app.services.ably_notify import publish_settings_notify

    for tenant_id, machine_id in targets:
        publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)


# ── Dashboard routes ─────────────────────────────────────────────────────────


@router.get("/defaults")
def get_defaults(current_user: User = Depends(get_current_user)):
    access.require_kiosk_role(current_user)
    return {
        "defaults": design.default_config(),
        "catalog": design.catalog(),
        "phase2MinVersion": design.phase2_min_version(),
    }


@router.get("/targets")
def get_targets(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The shop's points of sale (not archived) and active tills, for the area / till pickers —
    each till with its version (`appVersion`, as it reported it) and `phase2Templates`: whether
    it shows phase 2's templates (false: it shows "נקי" until it updates; null: unknown).
    """
    scope = resolve_scope(db, current_user, "shop", shop_id, active_tenant_id)
    areas = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id == scope.shop_id, ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
    )
    names = {a.id: a.name for a in areas}
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == scope.shop_id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.name)
        .all()
    )
    return {
        "areas": [{"id": str(a.id), "name": a.name} for a in areas],
        "machines": [
            {
                "id": str(m.id),
                "name": m.name,
                "areaId": str(m.area_id) if getattr(m, "area_id", None) else None,
                "areaName": names.get(getattr(m, "area_id", None)),
                "deviceModel": getattr(m, "device_model", None),
                "appVersion": getattr(m, "app_version", None),
                "phase2Templates": design.shows_phase2(m),
            }
            for m in machines
        ],
    }


@router.get("/settings")
def get_settings(
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    return settings_view(db, scope)


@router.put("/settings")
def put_settings(
    body: TillDesignSettingsIn,
    background_tasks: BackgroundTasks,
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Replace this level's partial layer. 422 `{"detail": {"code": "invalid_till_design",
    "errors": [{path, code, message}]}}`, validated on the parents ⊕ this layer. Each till
    the layer reaches gets an Ably `settings` notify (`till_design_updated`).
    """
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    try:
        try:
            save_settings(db, current_user, scope, body.overrides)
            db.commit()
        except IntegrityError:
            # Two first saves of one level at once: the other created the row; update it.
            db.rollback()
            save_settings(db, current_user, scope, body.overrides)
            db.commit()
    except design.TillDesignInvalid as invalid:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=invalid.detail())
    if background_tasks is not None:
        background_tasks.add_task(publish_design_notify, notify_targets(db, scope))
    return settings_view(db, scope)


# ── "צבע ותמונה למחלקה": three till parameters, edited with the design ─────────

#: Who may write a level here — the design's own writers (`get_current_machine_admin`).
_DESIGN_WRITERS = ("super_admin", "distributor", "company_manager", "shop_manager")


def category_display_view(db: Session, user: User, scope: Scope) -> Dict[str, Any]:
    from app.services import category_display

    view = category_display.level_view(db, scope.level, scope.entity_id)
    role = getattr(getattr(user, "role", None), "value", getattr(user, "role", None))
    return {"level": scope.level, "id": str(scope.entity_id), "canEdit": role in _DESIGN_WRITERS, **view}


@router.get("/category-display")
def get_category_display(
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    `categoryColors`, `categoryImages` and `categoryImageSize` at one level: what it sets itself
    (`own`), what it inherits (`inherited`: the levels above, else the default), the definitions with
    each code's Hebrew (`enumLabels`), and `canEdit`. The same access as `GET /till-design/settings`.
    """
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    return category_display_view(db, current_user, scope)


@router.put("/category-display")
def put_category_display(
    body: CategoryDisplayIn,
    background_tasks: BackgroundTasks,
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set (or, with null, clear) this level's own values — each change in `till_parameter_changes`, as on
    the parameters page. 422 `{"detail": {"code": "invalid_category_display", "message"}}` on a key
    that is not one of the three or a code the till does not know; nothing is written then. Each till
    the level reaches gets an Ably `settings` notify (`till_parameters_updated`) and pulls its
    parameters. The same access as `PUT /till-design/settings`.
    """
    from app.services import category_display
    from app.services.till_parameters import TillParameterValueError, publish_parameters_notify

    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    try:
        targets = category_display.save_values(db, scope.level, scope.entity_id, body.values, user=current_user)
    except TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_category_display", "message": str(exc)},
        )
    db.commit()
    if background_tasks is not None and targets:
        background_tasks.add_task(publish_parameters_notify, targets)
    return category_display_view(db, current_user, scope)


# ── "שולחנות ומפה": the tables' look and the map's display (till parameters) ──


def table_display_view(db: Session, scope: Scope, *, can_edit: bool) -> Dict[str, Any]:
    from app.services import table_restore, table_tile_look

    view = table_restore.level_view(db, scope.level, scope.entity_id, groups=table_tile_look.till_design_groups())
    view["canEdit"] = can_edit
    return view


@router.get("/table-display")
def get_table_display(
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שולחנות ומפה" at one level (P:/specs/till-design-tables.md §5): `tableTileStyle`, `tableTileInfo`,
    `tableStateColors`, `tableOverdueMinutes`, `tableNumberSize`, then `mapDecor`, `mapLegend`,
    `mapSymbolLabels`, `mapSymbolScale` — what the level sets (`own`), what it inherits, the
    definitions in their groups. Read and written by whoever reads and writes the till design.
    """
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    view = table_display_view(db, scope, can_edit=getattr(current_user, "role", None) in access.KIOSK_ROLES)
    db.commit()  # `ensure_builtin_parameters` may have created them
    return view


@router.put("/table-display")
def put_table_display(
    body: TableDisplayIn,
    level: Literal["company", "shop", "area", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set or clear (null) the card's parameters at one level, each with its change-log row. 422
    `{"code": "invalid_value", "message"}` on a value the till could not parse or a key not on the
    card; nothing is written then. Every till under the level pulls its parameters.
    """
    from app.services import table_restore, table_tile_look
    from app.services.till_parameters import TillParameterValueError, publish_parameters_notify

    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    try:
        targets = table_restore.save_values(
            db, scope.level, scope.entity_id, body.values,
            user=current_user, groups=table_tile_look.till_design_groups(),
        )
    except TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_value", "message": str(exc)},
        )
    db.commit()
    publish_parameters_notify(targets)
    return table_display_view(db, scope, can_edit=True)
