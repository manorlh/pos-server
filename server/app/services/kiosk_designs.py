"""
"עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md) — named kiosk designs and where they apply.

A design is a partial kiosk config layer (kiosk_config.SCHEMA) limited to the DESIGN groups it carries
(`GROUPS`: look, layout, landscape, attract, texts, motion, sizes, flow, ticker). Operational settings —
payment methods, printing, pickup, alerts, hours, the menu, timers — are never part of a design: whatever
else a client sends is dropped (`pick`).

Where it applies: any kiosk settings layer (company / shop / point of sale / kiosk) may assign one
(`kiosk_settings.design_id`) or say "ללא עיצוב" (`design_off`). Along one kiosk's path the NEAREST assignment
wins, and the design sits right before that level's own overrides:

    DEFAULTS ⊕ company ⊕ shop ⊕ area ⊕ [design] ⊕ machine            (assigned on the kiosk)
    DEFAULTS ⊕ company ⊕ [design] ⊕ shop ⊕ area ⊕ machine            (assigned on the shop)

and the layers ABOVE the design lose the design's group paths (`strip`): the design wins over every look it
inherits — an explicit value of a parent as well as a key the design leaves at its default — while the
assigning level's own overrides ("עריכה רק לקיוסק הזה") and every level below it win over the design.

The kiosks are not touched: they still receive one merged config (`kiosk_config.effective_config`), whose
configVersion is the hash of that config — a design change moves the version of exactly the kiosks that use
it, and its media enter their download manifests with the rest.
"""
from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.kiosk import KioskDevice, KioskSettings
from app.models.kiosk_design import KioskDesign, KioskDesignAudit
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import kiosk_config as cfgsvc
from app.services import kiosk_service_size as service_size

NAME_MAX = 80
DESIGNS_MAX = 200

DESIGN_IN_USE = "kiosk_design_in_use"
DESIGN_CHANGED = "kiosk_design_changed"
DESIGN_NOT_FOUND = "kiosk_design_not_found"
DESIGN_NAME_TAKEN = "kiosk_design_name_taken"
DESIGN_OUT_OF_SCOPE = "kiosk_design_out_of_scope"


@dataclass(frozen=True)
class Group:
    id: str
    label: str
    hint: str
    paths: Tuple[Tuple[str, ...], ...]


#: The design groups, in the order the dashboard lists them (client/src/lib/kioskDesigns.ts keeps the same).
GROUPS: Tuple[Group, ...] = (
    Group(
        "look", "מראה וצבעים", "סגנון ממשק, צבעים, גופן, רקע, לוגו, תמונות מסכים ותמונות מחלקות.",
        (
            ("theme",), ("screenImages",), ("payment", "waitLogo"),
            ("catalog", "categoryImages"), ("catalog", "categoryIconIds"), ("catalog", "categoryImagesFromCatalog"),
        ),
    ),
    Group("layout", "מבנה הקיוסק", "תבנית, תפריט, כרטיס מוצר, סל, הוספה מהירה ומסך סיום.", (("layout",),)),
    Group("landscape", "עיצוב לרוחב", "ההגדרות שחלות רק כשהמסך לרוחב.", (("landscape",),)),
    Group(
        "attract", "מסך פתיחה", "סרטונים ותמונות, כפתור \"הזמינו כאן\", ברוכים הבאים וזמן לכל שקופית.",
        (("attract",), ("timers", "attractSlideSec")),
    ),
    Group("texts", "טקסטים", "כל הטקסטים ללקוח בכל השפות והודעת הסיום.", (("texts",), ("textsByLang",), ("success",))),
    Group("motion", "הנפשות", "מנוע ההנפשות, מהירות ומעברים.", (("motion",),)),
    Group(
        "sizes", "גדלים", "גודל כרטיסי לקחת / לשבת.",
        tuple(("general", key) for key in service_size.KEYS),
    ),
    Group(
        "flow", "זרימה", "דילוג על הסל, מיקום ואופן בחירת לקחת / לשבת, חיפוש, מחלקה אחת בכל פעם ודילוג על בחירת אמצעי תשלום.",
        (
            ("general", "skipCart"), ("general", "servicePlacement"), ("general", "serviceSelect"),
            ("general", "searchEnabled"), ("catalog", "oneCategory"), ("payment", "paymentChooserSkip"),
        ),
    ),
    Group("ticker", "כיתוב רץ", "הכיתוב הרץ, מיקומו וצבעיו.", (("ticker",),)),
)
GROUP_IDS: Tuple[str, ...] = tuple(g.id for g in GROUPS)
GROUP_BY_ID: Dict[str, Group] = {g.id: g for g in GROUPS}
#: Ticked by default in "שמירה כעיצוב…".
DEFAULT_GROUPS: Tuple[str, ...] = ("look", "layout", "landscape", "attract", "texts", "motion", "sizes", "flow")


def groups_wire() -> List[Dict[str, Any]]:
    return [
        {"id": g.id, "label": g.label, "hint": g.hint, "paths": [".".join(p) for p in g.paths], "default": g.id in DEFAULT_GROUPS}
        for g in GROUPS
    ]


def clean_groups(groups: Any) -> List[str]:
    """The known group ids, deduped, in catalogue order."""
    wanted = {str(g) for g in groups} if isinstance(groups, (list, tuple)) else set()
    return [g for g in GROUP_IDS if g in wanted]


def paths_of(groups: Iterable[str]) -> List[Tuple[str, ...]]:
    return [p for gid in clean_groups(list(groups)) for p in GROUP_BY_ID[gid].paths]


def pick(layer: Any, groups: Iterable[str]) -> Dict[str, Any]:
    """Only the groups' paths of a layer (or a whole config), copied."""
    out: Dict[str, Any] = {}
    if not isinstance(layer, dict):
        return out
    for path in paths_of(groups):
        node: Any = layer
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if node is None:
            continue
        target = out
        for key in path[:-1]:
            target = target.setdefault(key, {})
        target[path[-1]] = copy.deepcopy(node)
    return out


def strip(layer: Any, groups: Iterable[str]) -> Dict[str, Any]:
    """A layer without the groups' paths (a copy); objects left empty are dropped."""
    if not isinstance(layer, dict):
        return {}
    out = copy.deepcopy(layer)
    for path in paths_of(groups):
        parents = [out]
        node: Any = out
        for key in path[:-1]:
            node = node.get(key) if isinstance(node, dict) else None
            if not isinstance(node, dict):
                break
            parents.append(node)
        else:
            if isinstance(node, dict):
                node.pop(path[-1], None)
            # Drop the objects the removal left empty, innermost first.
            for depth in range(len(path) - 1, 0, -1):
                holder, key = parents[depth - 1], path[depth - 1]
                if holder.get(key) == {}:
                    holder.pop(key, None)
    return out


def touches(layer: Any, groups: Iterable[str]) -> List[str]:
    """The dotted paths of the groups a layer sets ("עריכות שגוברות על העיצוב")."""
    picked = pick(layer, groups)
    out: List[str] = []

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, dict) and node and not ("url" in node and prefix):
            for key, value in node.items():
                walk(value, f"{prefix}.{key}" if prefix else key)
        else:
            out.append(prefix)

    walk(picked, "")
    return [p for p in out if p]


def validate_design_layer(overrides: Any, groups: Iterable[str]) -> Dict[str, Any]:
    """The design's layer: its groups only, validated alone and over the defaults. Raises KioskConfigInvalid."""
    cleaned, errors = cfgsvc.validate_layer(pick(overrides, groups))
    errors = cfgsvc._dedupe(list(errors) + cfgsvc.validate_config(cfgsvc.merge(cfgsvc.resolve(), cleaned)))
    if errors:
        raise cfgsvc.KioskConfigInvalid(errors)
    return cleaned


# ── Composition ──────────────────────────────────────────────────────────────


def _has_area() -> bool:
    """The point-of-sale layer (feat/area-management): present once `kiosk_settings.area_id` exists."""
    return hasattr(KioskSettings, "area_id")


def path_levels(*, company_id=None, shop_id=None, area_id=None, machine_id=None, upto: str = "machine") -> List[Tuple[str, Any]]:
    """The levels along a path, down to `upto` (inclusive)."""
    levels: List[Tuple[str, Any]] = [("company", company_id), ("shop", shop_id)]
    if _has_area():
        levels.append(("area", area_id))
    levels.append(("machine", machine_id))
    names = [name for name, _ in levels]
    return levels[: names.index(upto) + 1] if upto in names else levels


def _row(db: Session, level: str, entity_id) -> Optional[KioskSettings]:
    if entity_id is None:
        return None
    try:
        return cfgsvc.layer_row(db, level, entity_id)
    except Exception:  # noqa: BLE001 - a level this database does not have yet: no layer
        return None


@dataclass
class Applied:
    """The design a path ends up with (or none), and the level that chose it."""

    design: Optional[KioskDesign]
    level: Optional[str]
    entity_id: Any
    off: bool = False


@dataclass
class Composition:
    #: The stored layers in merge order (the design among them, the parents above it stripped).
    stack: List[Dict[str, Any]]
    applied: Applied


def compose_rows(db: Session, rows: Sequence[Tuple[str, Any, Optional[KioskSettings]]]) -> Composition:
    """The layers of `(level, entity_id, row)` (top first) with the nearest assigned design placed."""
    overrides = [row.overrides if row is not None and isinstance(row.overrides, dict) else {} for _, _, row in rows]
    chosen = None
    for index in range(len(rows) - 1, -1, -1):
        row = rows[index][2]
        if row is not None and (getattr(row, "design_off", False) or getattr(row, "design_id", None) is not None):
            chosen = index
            break
    if chosen is None:
        return Composition(stack=overrides, applied=Applied(None, None, None))
    level, entity_id, row = rows[chosen]
    if getattr(row, "design_off", False):
        return Composition(stack=overrides, applied=Applied(None, level, entity_id, off=True))
    design = db.get(KioskDesign, row.design_id)
    if design is None:
        return Composition(stack=overrides, applied=Applied(None, None, None))
    groups = clean_groups(design.groups)
    layer = pick(design.overrides if isinstance(design.overrides, dict) else {}, groups)
    stack = [strip(o, groups) for o in overrides[:chosen]] + [layer] + overrides[chosen:]
    return Composition(stack=stack, applied=Applied(design, level, entity_id))


def compose(db: Session, *, company_id=None, shop_id=None, area_id=None, machine_id=None, upto: str = "machine") -> Composition:
    levels = path_levels(company_id=company_id, shop_id=shop_id, area_id=area_id, machine_id=machine_id, upto=upto)
    return compose_rows(db, [(level, eid, _row(db, level, eid)) for level, eid in levels])


def machine_composition(db: Session, machine) -> Composition:
    shop = getattr(machine, "shop", None)
    return compose(
        db,
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
    )


def machine_stack(db: Session, machine) -> List[Dict[str, Any]]:
    """The stored layers a kiosk resolves, in order (kiosk_config.effective_config)."""
    return machine_composition(db, machine).stack


def scope_composition(db: Session, scope) -> Composition:
    """The layers down to a settings scope's own (kiosk_control.SettingsScope), its own last."""
    return compose(
        db,
        company_id=scope.company_id,
        shop_id=scope.shop_id,
        area_id=getattr(scope, "area_id", None),
        machine_id=scope.machine_id,
        upto=scope.level,
    )


def parent_stack(db: Session, scope) -> List[Dict[str, Any]]:
    """What a level inherits: the layers above it and the design it (or a parent) assigns — not its own."""
    return scope_composition(db, scope).stack[:-1]


# ── Scope and permissions ────────────────────────────────────────────────────


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _http(code: int, detail: Any) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _company(db: Session, company_id, tenant_id) -> Company:
    company = db.get(Company, _uuid(company_id)) if _uuid(company_id) else None
    if company is None or (tenant_id is not None and str(company.tenant_id) != str(tenant_id)):
        raise _http(status.HTTP_404_NOT_FOUND, "Company not found")
    return company


def _shop(db: Session, shop_id, tenant_id) -> Shop:
    shop = db.get(Shop, _uuid(shop_id)) if _uuid(shop_id) else None
    if shop is None or (tenant_id is not None and str(shop.tenant_id) != str(tenant_id)):
        raise _http(status.HTTP_404_NOT_FOUND, "Shop not found")
    return shop


def check_write(db: Session, user: User, tenant_id, *, company: Company, shop: Optional[Shop]) -> None:
    """A company design: the company's writers (company manager and above); a shop's own: that shop's too."""
    from app.services import kiosk_control as K

    if shop is not None:
        K.check_shop_scope(db, user, shop, tenant_id)
    else:
        K.check_company_scope(db, user, company, tenant_id)


def may_read(db: Session, user: User, tenant_id, design: KioskDesign) -> bool:
    from app.services import kiosk_control as K

    if tenant_id is not None and str(design.tenant_id) != str(tenant_id):
        return False
    company = db.get(Company, design.company_id)
    if company is None:
        return False
    try:
        K.check_company_scope(db, user, company, tenant_id)
        return True
    except HTTPException:
        pass
    # A shop's people see the company's designs and their own shop's.
    own_shop = db.get(Shop, user.shop_id) if getattr(user, "shop_id", None) else None
    if own_shop is None or str(own_shop.company_id) != str(design.company_id):
        return False
    if design.shop_id is not None and str(design.shop_id) != str(own_shop.id):
        return False
    try:
        K.check_shop_scope(db, user, own_shop, tenant_id)
        return True
    except HTTPException:
        return False


def get_design(db: Session, user: User, tenant_id, design_id, *, write: bool = False) -> KioskDesign:
    design = db.get(KioskDesign, _uuid(design_id)) if _uuid(design_id) else None
    if design is None or not may_read(db, user, tenant_id, design):
        raise _http(status.HTTP_404_NOT_FOUND, DESIGN_NOT_FOUND)
    if write:
        company = db.get(Company, design.company_id)
        shop = db.get(Shop, design.shop_id) if design.shop_id else None
        check_write(db, user, tenant_id, company=company, shop=shop)
    return design


# ── Audit ────────────────────────────────────────────────────────────────────


def audit(db: Session, user: Any, design: Optional[KioskDesign], action: str, detail: Optional[Dict[str, Any]] = None, *,
          tenant_id=None, company_id=None, now: Optional[datetime] = None) -> None:
    from app.services.kiosk_control import user_name

    db.add(KioskDesignAudit(
        id=uuid.uuid4(),
        tenant_id=design.tenant_id if design is not None else tenant_id,
        design_id=design.id if design is not None else None,
        company_id=design.company_id if design is not None else company_id,
        action=action,
        design_name=design.name if design is not None else None,
        user_id=getattr(user, "id", None),
        user_name=(user_name(user) if user is not None and getattr(user, "id", None) else None),
        detail=detail or None,
        created_at=_now(now),
    ))


def audit_out(row: KioskDesignAudit) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "action": row.action,
        "designName": row.design_name,
        "userName": row.user_name,
        "detail": row.detail,
        "at": row.created_at.isoformat() if row.created_at else None,
    }


def audit_list(db: Session, design: KioskDesign, limit: int = 30) -> List[Dict[str, Any]]:
    rows = (
        db.query(KioskDesignAudit)
        .filter(KioskDesignAudit.design_id == design.id)
        .order_by(KioskDesignAudit.created_at.desc())
        .limit(limit)
        .all()
    )
    return [audit_out(r) for r in rows]


# ── Usage ────────────────────────────────────────────────────────────────────


def _entity_name(db: Session, level: str, entity_id) -> Optional[str]:
    if level == "company":
        e = db.get(Company, entity_id)
        return getattr(e, "name", None)
    if level == "shop":
        e = db.get(Shop, entity_id)
        return getattr(e, "name", None)
    if level == "machine":
        device = db.get(KioskDevice, entity_id)
        if device is not None:
            return device.name
        e = db.get(POSMachine, entity_id)
        return getattr(e, "name", None)
    if level == "area":
        try:
            from app.models.shop_area import ShopArea  # feat/area-management

            e = db.get(ShopArea, entity_id)
            return getattr(e, "name", None)
        except Exception:  # noqa: BLE001
            return None
    return None


def _row_entity(row: KioskSettings):
    return {"company": row.company_id, "shop": row.shop_id, "machine": row.machine_id}.get(row.level, getattr(row, "area_id", None))


def assignments(db: Session, design: KioskDesign) -> List[Dict[str, Any]]:
    """The levels that assign this design."""
    rows = db.query(KioskSettings).filter(KioskSettings.design_id == design.id).all()
    out = []
    for row in rows:
        eid = _row_entity(row)
        out.append({"level": row.level, "id": str(eid) if eid else None, "name": _entity_name(db, row.level, eid)})
    order = {"company": 0, "shop": 1, "area": 2, "machine": 3}
    return sorted(out, key=lambda a: (order.get(a["level"], 9), a["name"] or ""))


def assignment_counts(db: Session, design_ids: Sequence[Any]) -> Dict[str, int]:
    if not design_ids:
        return {}
    out: Dict[str, int] = {}
    for (did,) in db.query(KioskSettings.design_id).filter(KioskSettings.design_id.in_(list(design_ids))).all():
        out[str(did)] = out.get(str(did), 0) + 1
    return out


def company_kiosks(db: Session, company_id, shop_id=None) -> List[POSMachine]:
    query = (
        db.query(POSMachine)
        .join(KioskDevice, KioskDevice.machine_id == POSMachine.id)
        .join(Shop, Shop.id == POSMachine.shop_id)
        .filter(Shop.company_id == company_id, POSMachine.is_active.is_(True))
    )
    if shop_id is not None:
        query = query.filter(POSMachine.shop_id == shop_id)
    return query.all()


def kiosks_using(db: Session, design: KioskDesign) -> List[Dict[str, Any]]:
    """The kiosks whose effective config this design is part of (their nearest assignment)."""
    out = []
    for machine in company_kiosks(db, design.company_id, design.shop_id):
        applied = machine_composition(db, machine).applied
        if applied.design is not None and applied.design.id == design.id:
            device = db.get(KioskDevice, machine.id)
            out.append({"machineId": str(machine.id), "name": device.name if device else machine.name, "via": applied.level})
    return sorted(out, key=lambda k: k["name"] or "")


# ── Read ─────────────────────────────────────────────────────────────────────


def design_out(db: Session, design: KioskDesign, *, uses: Optional[int] = None) -> Dict[str, Any]:
    from app.services.kiosk_control import user_name

    shop = db.get(Shop, design.shop_id) if design.shop_id else None
    updated_by = db.get(User, design.updated_by_user_id) if design.updated_by_user_id else None
    return {
        "id": str(design.id),
        "name": design.name,
        "companyId": str(design.company_id),
        "shopId": str(design.shop_id) if design.shop_id else None,
        "shopName": shop.name if shop is not None else None,
        "groups": clean_groups(design.groups),
        "overrides": cfgsvc.sanitize_stored_layer(design.overrides),
        "revision": design.revision,
        "archived": design.archived_at is not None,
        "archivedAt": design.archived_at.isoformat() if design.archived_at else None,
        "createdAt": design.created_at.isoformat() if design.created_at else None,
        "updatedAt": design.updated_at.isoformat() if design.updated_at else None,
        "updatedBy": user_name(updated_by) if updated_by is not None else None,
        "assignmentCount": uses if uses is not None else len(assignments(db, design)),
    }


def editor_view(design: KioskDesign) -> Dict[str, Any]:
    """The kiosk editor's settings shape for a design: it inherits the defaults alone."""
    overrides = pick(cfgsvc.sanitize_stored_layer(design.overrides), clean_groups(design.groups))
    effective = cfgsvc.resolve(overrides)
    return {
        "level": "design",
        "id": str(design.id),
        "overrides": overrides,
        "inherited": cfgsvc.resolve(),
        "inheritedLayers": {},
        "effective": effective,
        "configVersion": cfgsvc.config_version(effective),
        "menuVersion": None,
        "updatedAt": design.updated_at.isoformat() if design.updated_at else None,
        "updatedBy": None,
        "updatedByUserId": str(design.updated_by_user_id) if design.updated_by_user_id else None,
    }


def list_designs(db: Session, user: User, tenant_id, *, company_id=None, shop_id=None, archived: bool = False) -> Dict[str, Any]:
    """The company's designs and, with a shop, that shop's own; at a company, every shop's own too."""
    from app.services import kiosk_control as K

    if shop_id is not None:
        shop = _shop(db, shop_id, tenant_id)
        K.check_shop_scope(db, user, shop, tenant_id)
        company = _company(db, shop.company_id, tenant_id)
        query = db.query(KioskDesign).filter(
            KioskDesign.company_id == company.id,
            (KioskDesign.shop_id.is_(None)) | (KioskDesign.shop_id == shop.id),
        )
    elif company_id is not None:
        company = _company(db, company_id, tenant_id)
        K.check_company_scope(db, user, company, tenant_id)
        query = db.query(KioskDesign).filter(KioskDesign.company_id == company.id)
    else:
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, "companyId_or_shopId_required")
    if not archived:
        query = query.filter(KioskDesign.archived_at.is_(None))
    rows = query.order_by(KioskDesign.name).limit(DESIGNS_MAX).all()
    counts = assignment_counts(db, [r.id for r in rows])
    return {
        "companyId": str(company.id),
        "groups": groups_wire(),
        "designs": [design_out(db, r, uses=counts.get(str(r.id), 0)) for r in rows],
    }


def detail(db: Session, design: KioskDesign) -> Dict[str, Any]:
    return {
        **design_out(db, design),
        "assignments": assignments(db, design),
        "kiosks": kiosks_using(db, design),
        "settings": editor_view(design),
        "audit": audit_list(db, design),
        "groupsCatalog": groups_wire(),
    }


# ── Write ────────────────────────────────────────────────────────────────────


def _clean_name(name: Any) -> str:
    cleaned = " ".join(str(name or "").split())[:NAME_MAX]
    if not cleaned:
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "kiosk_design_name_required"})
    return cleaned


def _check_name_free(db: Session, company_id, shop_id, name: str, exclude=None) -> None:
    query = db.query(KioskDesign).filter(
        KioskDesign.company_id == company_id, KioskDesign.archived_at.is_(None),
    )
    query = query.filter(KioskDesign.shop_id.is_(None)) if shop_id is None else query.filter(KioskDesign.shop_id == shop_id)
    for row in query.all():
        if row.id != exclude and row.name.strip().casefold() == name.casefold():
            raise _http(status.HTTP_409_CONFLICT, {"code": DESIGN_NAME_TAKEN, "name": name})


def _free_name(db: Session, company_id, shop_id, wanted: str) -> str:
    name, n = wanted, 2
    while True:
        try:
            _check_name_free(db, company_id, shop_id, name)
            return name
        except HTTPException:
            suffix = f" ({n})"
            name = wanted[: NAME_MAX - len(suffix)] + suffix
            n += 1


def create(db: Session, user: User, tenant_id, *, company_id=None, shop_id=None, name: Any, groups: Any,
           overrides: Any = None, config: Any = None, now: Optional[datetime] = None) -> KioskDesign:
    """
    A new design. `config` (a whole config — "שמירה כעיצוב…" from what the editor shows) is cut to the groups;
    or `overrides`, a partial layer. The caller commits.
    """
    shop = _shop(db, shop_id, tenant_id) if shop_id is not None else None
    company = _company(db, shop.company_id if shop is not None else company_id, tenant_id)
    if shop is not None and company_id is not None and str(company_id) != str(shop.company_id):
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": DESIGN_OUT_OF_SCOPE})
    check_write(db, user, tenant_id, company=company, shop=shop)
    picked_groups = clean_groups(groups)
    if not picked_groups:
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "kiosk_design_groups_required"})
    clean = _clean_name(name)
    _check_name_free(db, company.id, shop.id if shop else None, clean)
    source = config if isinstance(config, dict) else overrides
    layer = validate_design_layer(source or {}, picked_groups)
    at = _now(now)
    design = KioskDesign(
        id=uuid.uuid4(), tenant_id=company.tenant_id, company_id=company.id, shop_id=shop.id if shop else None,
        name=clean, groups=picked_groups, overrides=layer, revision=1,
        created_at=at, updated_at=at, created_by_user_id=getattr(user, "id", None), updated_by_user_id=getattr(user, "id", None),
    )
    db.add(design)
    db.flush()
    audit(db, user, design, "create", {"groups": picked_groups, "from": "config" if isinstance(config, dict) else "layer"}, now=now)
    return design


def update(db: Session, user: User, design: KioskDesign, *, revision: Optional[int] = None, name: Any = None,
           groups: Any = None, overrides: Any = None, now: Optional[datetime] = None) -> KioskDesign:
    """Rename, change the groups and / or the layer. A stale `revision` → 409. The caller commits."""
    if revision is not None and int(revision) != int(design.revision):
        raise _http(status.HTTP_409_CONFLICT, {"code": DESIGN_CHANGED, "revision": design.revision})
    changed: Dict[str, Any] = {}
    if name is not None:
        clean = _clean_name(name)
        if clean != design.name:
            _check_name_free(db, design.company_id, design.shop_id, clean, exclude=design.id)
            changed["name"] = {"from": design.name, "to": clean}
            design.name = clean
    new_groups = clean_groups(design.groups)
    if groups is not None:
        new_groups = clean_groups(groups)
        if not new_groups:
            raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "kiosk_design_groups_required"})
        if new_groups != clean_groups(design.groups):
            changed["groups"] = {"from": clean_groups(design.groups), "to": new_groups}
    if overrides is not None or "groups" in changed:
        layer = validate_design_layer(overrides if overrides is not None else design.overrides, new_groups)
        if layer != design.overrides:
            changed["layer"] = True
        design.overrides = layer
        design.groups = new_groups
    if not changed:
        return design
    design.revision = int(design.revision or 1) + 1
    design.updated_at = _now(now)
    design.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    audit(db, user, design, "rename" if set(changed) == {"name"} else "update", changed if "layer" not in changed else {**changed, "layer": True}, now=now)
    return design


def duplicate(db: Session, user: User, tenant_id, design: KioskDesign, *, name: Any = None, shop_id: Any = "same",
              now: Optional[datetime] = None) -> KioskDesign:
    """A copy ("שכפול"), as the company's or a shop's own; named "<name> (עותק)" unless given."""
    target_shop = design.shop_id if shop_id == "same" else _uuid(shop_id)
    wanted = _clean_name(name) if name else f"{design.name} (עותק)"[:NAME_MAX]
    target_shop_row = _shop(db, target_shop, tenant_id) if target_shop else None
    if target_shop_row is not None and str(target_shop_row.company_id) != str(design.company_id):
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": DESIGN_OUT_OF_SCOPE})
    copy_ = create(
        db, user, tenant_id, company_id=design.company_id, shop_id=target_shop,
        name=_free_name(db, design.company_id, target_shop, wanted), groups=design.groups,
        overrides=design.overrides, now=now,
    )
    audit(db, user, copy_, "duplicate", {"fromId": str(design.id), "fromName": design.name}, now=now)
    return copy_


def set_archived(db: Session, user: User, design: KioskDesign, archived: bool, *, now: Optional[datetime] = None) -> KioskDesign:
    """Archive: hidden from the pickers; the levels that assign it keep it. Restore: back (a free name)."""
    if archived and design.archived_at is None:
        design.archived_at = _now(now)
        audit(db, user, design, "archive", now=now)
    elif not archived and design.archived_at is not None:
        design.name = _free_name(db, design.company_id, design.shop_id, design.name)
        design.archived_at = None
        audit(db, user, design, "restore", now=now)
    else:
        return design
    design.revision = int(design.revision or 1) + 1
    design.updated_at = _now(now)
    design.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    return design


def delete(db: Session, user: User, design: KioskDesign, *, now: Optional[datetime] = None) -> None:
    """Only a design no level assigns (else 409 `kiosk_design_in_use` with the levels — archive it instead)."""
    used = assignments(db, design)
    if used:
        raise _http(status.HTTP_409_CONFLICT, {"code": DESIGN_IN_USE, "assignments": used})
    audit(db, user, design, "delete", {"groups": clean_groups(design.groups)}, now=now)
    db.delete(design)
    db.flush()


# ── Assignment ───────────────────────────────────────────────────────────────


def check_assignable(db: Session, scope, design: KioskDesign) -> None:
    """A design of the scope's company; a shop's own only on that shop and below."""
    if str(design.tenant_id) != str(scope.tenant_id) or str(design.company_id) != str(scope.company_id):
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": DESIGN_OUT_OF_SCOPE})
    if design.shop_id is not None and (scope.level == "company" or str(design.shop_id) != str(scope.shop_id)):
        raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": DESIGN_OUT_OF_SCOPE})


def assign(db: Session, user: User, scope, *, design_id: Any = None, off: bool = False, clear_overlapping: bool = False,
           now: Optional[datetime] = None) -> KioskSettings:
    """
    "עיצוב: <שם>" on a level: a design, "ללא עיצוב" (`off`), or inherit (neither). `clear_overlapping` drops the
    level's own overrides in the design's groups (they would win over it). The caller commits.
    """
    design = None
    if design_id:
        design = db.get(KioskDesign, _uuid(design_id)) if _uuid(design_id) else None
        if design is None:
            raise _http(status.HTTP_404_NOT_FOUND, DESIGN_NOT_FOUND)
        check_assignable(db, scope, design)
        if design.archived_at is not None:
            row_now = cfgsvc.layer_row(db, scope.level, scope.entity_id)
            if row_now is None or row_now.design_id != design.id:
                raise _http(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "kiosk_design_archived"})
    row = cfgsvc.layer_row(db, scope.level, scope.entity_id)
    if row is None:
        row = KioskSettings(
            id=uuid.uuid4(), tenant_id=scope.tenant_id, level=scope.level,
            company_id=scope.company_id if scope.level == "company" else None,
            shop_id=scope.shop_id if scope.level == "shop" else None,
            machine_id=scope.machine_id if scope.level == "machine" else None,
            overrides={},
        )
        if scope.level == "area" and hasattr(KioskSettings, "area_id"):
            row.area_id = scope.area_id
        db.add(row)
    before = {"designId": str(row.design_id) if row.design_id else None, "off": bool(row.design_off)}
    row.design_id = design.id if design is not None else None
    row.design_off = bool(off) and design is None
    cleared: List[str] = []
    if design is not None and clear_overlapping:
        groups = clean_groups(design.groups)
        cleared = touches(row.overrides, groups)
        if cleared:
            row.overrides = strip(row.overrides, groups)
    row.updated_at = _now(now)
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    audit(
        db, user, design, "assign",
        {
            "level": scope.level, "id": str(scope.entity_id), "before": before,
            "after": {"designId": str(design.id) if design else None, "off": row.design_off},
            "cleared": cleared,
        },
        tenant_id=scope.tenant_id, company_id=scope.company_id, now=now,
    )
    return row


def assignment_view(db: Session, scope, own_overrides: Dict[str, Any]) -> Dict[str, Any]:
    """settings_view's `design`: what this level assigns, what it ends up with, and its own edits over it."""
    row = cfgsvc.layer_row(db, scope.level, scope.entity_id)
    own = None
    if row is not None and row.design_id is not None:
        d = db.get(KioskDesign, row.design_id)
        own = {"id": str(d.id), "name": d.name, "archived": d.archived_at is not None} if d is not None else None
    applied = scope_composition(db, scope).applied
    effective = None
    if applied.design is not None:
        effective = {
            "id": str(applied.design.id),
            "name": applied.design.name,
            "groups": clean_groups(applied.design.groups),
            "level": applied.level,
            "levelId": str(applied.entity_id) if applied.entity_id else None,
            "levelName": _entity_name(db, applied.level, applied.entity_id),
            "inherited": applied.level != scope.level,
        }
    over = touches(own_overrides, clean_groups(applied.design.groups)) if applied.design is not None else []
    return {
        "assigned": own,
        "off": bool(row.design_off) if row is not None else False,
        "effective": effective,
        "offAt": applied.level if applied.off else None,
        "overDesign": over,
    }
