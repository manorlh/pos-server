"""
"סדר תצוגה" — the one ordering model of the four channels: storage, inheritance, linking and the
write-through to what the tills and kiosks read today (specs/digital-menu-ordering-cards-plan.md §5).
The rule itself is pure: app/services/display_ordering_rules.py.

* **Where an order comes from** (`resolve_view`): for a channel at a target, the target's chain, most
  specific first — profile (web), device, point of sale, shop, company and the companies above it,
  the tenant — each level either *bound* (`display_ordering_bindings`) or, for the tills and the
  kiosks, holding today's keys without a binding yet ("implicit": read from those keys, exactly
  what the devices read). The effective order merges them as the devices do (rules.effective_along).
* **Linked / independent / copied once.** A binding points at an ordering; several bindings on one
  ordering move together ("מקושר"). `unlink` gives a binding a copy of what it showed — positions
  unchanged. `copy_from` gives it a snapshot of another target's effective order, with no link after.
* **Write-through.** Saving an ordering writes, for each of its tills' and kiosks' bindings, the keys
  those devices read (`productOrder` / `categoryOrder` in the settings layer; `catalog.categoryOrder`
  / `catalog.productOrder` in the kiosk layer) and wakes them. The devices are unchanged.
* **The older write points** — a till's "עריכת מסך" (`PUT /sync/{m}/product-order`), the kiosk's menu
  editor and the dashboard's kiosk catalog — still write those keys themselves; after them the
  ordering of a bound level is read back from the keys (`after_pos_write` / `after_kiosk_write`) and
  written through to the levels linked with it. A level whose keys were cleared lets go of its binding.
* **Nothing is migrated by writing.** The migration only records, for each level that holds keys
  today, an independent binding of an ordering read from them (`materialize_legacy`): nothing a till
  or a kiosk reads changes.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.display_ordering import BINDING_CHANNELS, DisplayOrdering, DisplayOrderingBinding
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services import display_ordering_rules as R

POS, KIOSK, ONLINE, MENU = "pos", "kiosk", "online", "menu"
DEVICE_CHANNELS = (POS, KIOSK)

#: The levels each channel has, widest first (a kiosk layer has no point of sale; the web has profiles).
CHANNEL_LEVELS: Dict[str, Tuple[str, ...]] = {
    POS: ("tenant", "company", "shop", "area", "machine"),
    KIOSK: ("company", "shop", "machine"),
    ONLINE: ("tenant", "company", "shop", "area", "profile"),
    MENU: ("tenant", "company", "shop", "area", "profile"),
}

#: The channels' names in Hebrew, for "מקושר ל…".
CHANNEL_LABELS_HE = {POS: "קופה", KIOSK: "קיוסק", ONLINE: "הזמנות אונליין", MENU: "תפריט דיגיטלי"}
LEVEL_LABELS_HE = {
    "tenant": "ארגון", "company": "חברה", "shop": "סניף", "area": "נקודת מכירה", "machine": "מכשיר", "profile": "פרופיל",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


_READY: "weakref.WeakKeyDictionary" = None  # type: ignore[assignment]


def tables_ready(db: Session) -> bool:
    """Whether the orderings' tables exist (the in-memory test worlds of other features lack them)."""
    global _READY
    import weakref

    from sqlalchemy import inspect as sa_inspect

    if _READY is None:
        _READY = weakref.WeakKeyDictionary()
    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001
        return False
    if _READY.get(engine):
        return True
    try:
        known = bool(sa_inspect(db.connection()).has_table(DisplayOrderingBinding.__tablename__))
    except Exception:  # noqa: BLE001
        return False
    if known:
        _READY[engine] = True
    return known


# ── Targets ──────────────────────────────────────────────────────────────────


@dataclass
class Target:
    level: str
    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    company_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    area_id: Optional[uuid.UUID] = None
    machine_id: Optional[uuid.UUID] = None
    entity: Any = None


def resolve_target(db: Session, level: str, target_id: Any, tenant_id: Any) -> Target:
    """The level's entity, this tenant's; 404 / 422 otherwise."""
    ident = _uuid(target_id)
    if ident is None:
        raise _bad("target_required", "חסר יעד")

    def mine(entity_tenant) -> None:
        if tenant_id is not None and str(entity_tenant) != str(tenant_id):
            raise _bad("target_not_found", "היעד לא נמצא", status.HTTP_404_NOT_FOUND)

    if level == "tenant":
        t = db.get(Tenant, ident)
        if t is None:
            raise _bad("target_not_found", "הארגון לא נמצא", status.HTTP_404_NOT_FOUND)
        mine(t.id)
        return Target(level, t.id, t.id, t.name or "", entity=t)
    if level == "company":
        c = db.get(Company, ident)
        if c is None:
            raise _bad("target_not_found", "החברה לא נמצאה", status.HTTP_404_NOT_FOUND)
        mine(c.tenant_id)
        return Target(level, c.id, c.tenant_id, c.name or "", company_id=c.id, entity=c)
    if level == "shop":
        s = db.get(Shop, ident)
        if s is None:
            raise _bad("target_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
        mine(s.tenant_id)
        return Target(level, s.id, s.tenant_id, s.name or "", company_id=s.company_id, shop_id=s.id, entity=s)
    if level == "area":
        a = db.get(ShopArea, ident)
        if a is None or getattr(a, "archived_at", None) is not None:
            raise _bad("target_not_found", "נקודת המכירה לא נמצאה", status.HTTP_404_NOT_FOUND)
        mine(a.tenant_id)
        shop = db.get(Shop, a.shop_id)
        return Target(level, a.id, a.tenant_id, a.name or "", company_id=shop.company_id if shop else None,
                      shop_id=a.shop_id, area_id=a.id, entity=a)
    if level == "machine":
        m = db.get(POSMachine, ident)
        if m is None or m.shop_id is None:
            raise _bad("target_not_found", "המכשיר לא נמצא", status.HTTP_404_NOT_FOUND)
        mine(m.tenant_id)
        shop = db.get(Shop, m.shop_id)
        return Target(level, m.id, m.tenant_id, m.name or "", company_id=shop.company_id if shop else None,
                      shop_id=m.shop_id, area_id=getattr(m, "area_id", None), machine_id=m.id, entity=m)
    if level == "profile":
        try:
            from app.services import presentation_profiles as PP
        except ImportError:  # pragma: no cover - profiles not in this build
            PP = None
        profile = PP.profile_row(db, ident) if PP is not None and PP.tables_ready(db) else None
        if profile is None:
            raise _bad("target_not_found", "הפרופיל לא נמצא", status.HTTP_404_NOT_FOUND)
        mine(profile.tenant_id)
        return Target(level, profile.id, profile.tenant_id, profile.internal_name or "",
                      company_id=profile.company_id, shop_id=profile.shop_id, area_id=profile.area_id, entity=profile)
    raise _bad("invalid_level", "רמה לא מוכרת")


def check_channel_level(channel: str, level: str) -> None:
    if channel not in BINDING_CHANNELS:
        raise _bad("invalid_channel", "ערוץ לא מוכר")
    if level not in CHANNEL_LEVELS[channel]:
        raise _bad("invalid_level", "לערוץ הזה אין סידור ברמה הזו")


def chain(db: Session, channel: str, target: Target) -> List[Tuple[str, str]]:
    """`[(level, id)]` from the target up, most specific first — only the channel's levels."""
    from app.services.company_hierarchy import ancestor_company_ids

    out: List[Tuple[str, str]] = []
    if target.level == "profile":
        out.append(("profile", str(target.id)))
    if target.machine_id is not None:
        out.append(("machine", str(target.machine_id)))
    if target.area_id is not None:
        out.append(("area", str(target.area_id)))
    if target.shop_id is not None:
        out.append(("shop", str(target.shop_id)))
    if target.company_id is not None:
        out.append(("company", str(target.company_id)))
        out += [("company", str(c)) for c in ancestor_company_ids(db, target.company_id)]
    out.append(("tenant", str(target.tenant_id)))
    allowed = CHANNEL_LEVELS[channel]
    seen = set()
    result = []
    for level, ident in out:
        if level in allowed and (level, ident) not in seen:
            seen.add((level, ident))
            result.append((level, ident))
    return result


# ── Today's keys (the tills' settings layers, the kiosks' layers) ────────────


_POS_MODELS = {"tenant": Tenant, "company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}


def _pos_row(db: Session, level: str, target_id: Any):
    model = _POS_MODELS.get(level)
    return db.get(model, _uuid(target_id)) if model is not None else None


def _kiosk_row(db: Session, level: str, target_id: Any):
    from app.services import kiosk_config as cfgsvc

    if level not in ("company", "shop", "machine"):
        return None
    try:
        return cfgsvc.layer_row(db, level, _uuid(target_id))
    except Exception:  # noqa: BLE001 - kiosks absent in a test world
        return None


def pos_keys(db: Session, level: str, target_id: Any) -> Dict[str, Any]:
    row = _pos_row(db, level, target_id)
    settings = row.settings if row is not None and isinstance(getattr(row, "settings", None), dict) else {}
    return {k: settings.get(k) for k in ("productOrder", "categoryOrder") if settings.get(k) is not None}


def kiosk_keys(db: Session, level: str, target_id: Any) -> Dict[str, Any]:
    row = _kiosk_row(db, level, target_id)
    overrides = row.overrides if row is not None and isinstance(row.overrides, dict) else {}
    catalog = overrides.get("catalog") if isinstance(overrides.get("catalog"), dict) else {}
    return {k: catalog.get(k) for k in ("categoryOrder", "productOrder") if catalog.get(k) is not None}


keys_hash = R.keys_hash


def category_of(db: Session, product_ids: Iterable[Any]) -> Dict[str, Optional[str]]:
    ids = [i for i in (_uuid(p) for p in product_ids) if i is not None]
    out: Dict[str, Optional[str]] = {}
    for start in range(0, len(ids), 500):
        for pid, cid in db.query(Product.id, Product.category_id).filter(Product.id.in_(ids[start:start + 500])).all():
            out[str(pid)] = str(cid) if cid is not None else None
    return out


def legacy_content(db: Session, channel: str, level: str, target_id: Any) -> Optional[Dict[str, Any]]:
    """Today's keys at this level as an ordering, or None when the level sets none."""
    if channel == POS:
        keys = pos_keys(db, level, target_id)
        if not keys:
            return None
        flat = R._ids(keys.get("productOrder"))
        return R.import_pos(flat, keys.get("categoryOrder"), category_of(db, flat))
    if channel == KIOSK:
        keys = kiosk_keys(db, level, target_id)
        if not keys:
            return None
        return R.import_kiosk(keys)
    return None


# ── Bindings and orderings ───────────────────────────────────────────────────


def binding_at(db: Session, tenant_id: Any, level: str, target_id: Any, channel: str) -> Optional[DisplayOrderingBinding]:
    if not tables_ready(db):
        return None
    return (
        db.query(DisplayOrderingBinding)
        .filter(
            DisplayOrderingBinding.tenant_id == _uuid(tenant_id),
            DisplayOrderingBinding.level == level,
            DisplayOrderingBinding.target_id == _uuid(target_id),
            DisplayOrderingBinding.channel == channel,
        )
        .first()
    )


def bindings_of(db: Session, ordering_id: Any) -> List[DisplayOrderingBinding]:
    return (
        db.query(DisplayOrderingBinding)
        .filter(DisplayOrderingBinding.ordering_id == _uuid(ordering_id))
        .order_by(DisplayOrderingBinding.channel, DisplayOrderingBinding.level, DisplayOrderingBinding.created_at)
        .all()
    )


def content_of(ordering: Optional[DisplayOrdering]) -> Dict[str, Any]:
    if ordering is None:
        return R.empty()
    return R.clean({
        "categories": ordering.categories, "products": ordering.products,
        "pinned": ordering.pinned, "newItems": ordering.new_items,
    })


def _set_content(ordering: DisplayOrdering, content: Mapping[str, Any]) -> None:
    c = R.clean(content)
    ordering.categories = c["categories"]
    ordering.products = c["products"]
    ordering.pinned = c["pinned"]
    ordering.new_items = c["newItems"]


def _user_name(user: Any) -> Optional[str]:
    name = getattr(user, "username", None) or getattr(user, "email", None) if user is not None else None
    return name[:200] if name else None


def new_ordering(db: Session, tenant_id: Any, content: Mapping[str, Any], *, company_id: Any = None,
                 legacy_flat: Any = None, user: Any = None, name: Optional[str] = None,
                 now: Optional[datetime] = None) -> DisplayOrdering:
    now = now or _now()
    row = DisplayOrdering(
        id=uuid.uuid4(), tenant_id=_uuid(tenant_id), company_id=_uuid(company_id), name=(name or None) and name[:120],
        legacy_flat=R._ids(legacy_flat) or None, version=1,
        updated_by_user_id=getattr(user, "id", None), updated_by_name=_user_name(user), created_at=now, updated_at=now,
    )
    _set_content(row, content)
    db.add(row)
    db.flush()
    return row


def bind(db: Session, target: Target, channel: str, ordering: DisplayOrdering, *, user: Any = None,
         copied_from: Any = None, now: Optional[datetime] = None) -> DisplayOrderingBinding:
    now = now or _now()
    row = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if row is None:
        row = DisplayOrderingBinding(
            id=uuid.uuid4(), tenant_id=target.tenant_id, level=target.level, target_id=target.id, channel=channel,
            ordering_id=ordering.id, created_at=now,
        )
        db.add(row)
    row.ordering_id = ordering.id
    row.copied_from_ordering_id = _uuid(copied_from)
    row.copied_at = now if copied_from is not None else None
    row.updated_at = now
    row.updated_by_name = _user_name(user)
    db.flush()
    return row


def materialize(db: Session, target: Target, channel: str, *, user: Any = None) -> DisplayOrderingBinding:
    """The binding at this level — made from today's keys (or empty) when there is none yet."""
    row = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if row is not None:
        return row
    content = legacy_content(db, channel, target.level, target.id) or R.empty()
    ordering = new_ordering(
        db, target.tenant_id, content, company_id=target.company_id, legacy_flat=content.get("legacyFlat"), user=user,
    )
    row = bind(db, target, channel, ordering, user=user)
    if channel in DEVICE_CHANNELS:
        row.legacy_hash = keys_hash(pos_keys(db, target.level, target.id) if channel == POS else kiosk_keys(db, target.level, target.id))
    return row


def materialize_legacy(db: Session, tenant_id: Any = None) -> int:
    """
    The migration: an independent binding for every level that holds today's keys and has no binding
    yet (tills: tenant / company / shop / area / device settings; kiosks: company / shop / device
    layers). Writes nothing a device reads. Returns how many were made.
    """
    from app.models.kiosk import KioskSettings

    made = 0
    for level, model in _POS_MODELS.items():
        q = db.query(model)
        if tenant_id is not None and level != "tenant":
            q = q.filter(model.tenant_id == _uuid(tenant_id))
        elif tenant_id is not None:
            q = q.filter(model.id == _uuid(tenant_id))
        for row in q.all():
            settings = row.settings if isinstance(getattr(row, "settings", None), dict) else {}
            if settings.get("productOrder") is None and settings.get("categoryOrder") is None:
                continue
            try:
                target = resolve_target(db, level, row.id, None)
            except HTTPException:
                continue
            if binding_at(db, target.tenant_id, level, row.id, POS) is None:
                materialize(db, target, POS)
                made += 1
    q = db.query(KioskSettings)
    if tenant_id is not None:
        q = q.filter(KioskSettings.tenant_id == _uuid(tenant_id))
    for row in q.all():
        catalog = (row.overrides or {}).get("catalog") if isinstance(row.overrides, dict) else None
        if not isinstance(catalog, dict) or (catalog.get("categoryOrder") is None and catalog.get("productOrder") is None):
            continue
        ident = {"company": row.company_id, "shop": row.shop_id, "machine": row.machine_id}.get(row.level)
        try:
            target = resolve_target(db, row.level, ident, None)
        except HTTPException:
            continue
        if binding_at(db, target.tenant_id, row.level, ident, KIOSK) is None:
            materialize(db, target, KIOSK)
            made += 1
    return made


# ── What a target shows ──────────────────────────────────────────────────────


def _level_content(db: Session, tenant_id: Any, channel: str, level: str, target_id: str):
    """`(content, source)` of one level: its binding's ordering, else today's keys, else None."""
    b = binding_at(db, tenant_id, level, target_id, channel)
    if b is not None:
        return content_of(db.get(DisplayOrdering, b.ordering_id)), "binding", b
    legacy = legacy_content(db, channel, level, target_id)
    if legacy is not None:
        return legacy, "legacy", None
    return None, None, None


def effective_for(db: Session, channel: str, target: Target) -> Dict[str, Any]:
    """`{"content", "source": {level, targetId, kind}}` — the effective ordering of a target."""
    contents = []
    source = None
    for level, ident in chain(db, channel, target):
        content, kind, _b = _level_content(db, target.tenant_id, channel, level, ident)
        contents.append(content)
        if content is not None and source is None:
            source = {"level": level, "targetId": ident, "kind": kind}
    return {
        "content": R.effective_along(channel, contents),
        "source": source or {"level": None, "targetId": None, "kind": "catalog"},
    }


def _target_name(db: Session, level: str, target_id: Any) -> Optional[str]:
    try:
        return resolve_target(db, level, target_id, None).name
    except HTTPException:
        return None


def linked_with(db: Session, binding: DisplayOrderingBinding) -> List[Dict[str, Any]]:
    """The other bindings of the same ordering ("מקושר ל…")."""
    return [
        {
            "channel": b.channel, "channelLabel": CHANNEL_LABELS_HE.get(b.channel),
            "level": b.level, "levelLabel": LEVEL_LABELS_HE.get(b.level),
            "targetId": str(b.target_id), "targetName": _target_name(db, b.level, b.target_id),
        }
        for b in bindings_of(db, binding.ordering_id)
        if b.id != binding.id
    ]


def linked_label(links: Sequence[Mapping[str, Any]]) -> Optional[str]:
    """"מקושר לקופה ולקיוסק" — the channels (and their targets) this order moves with."""
    if not links:
        return None
    parts = [f"{l['channelLabel']} ({l.get('targetName') or l['levelLabel']})" for l in links]
    if len(parts) == 1:
        return f"מקושר ל{parts[0]}"
    return "מקושר ל" + ", ".join(parts[:-1]) + " ול" + parts[-1]


def resolve_view(db: Session, channel: str, target: Target) -> Dict[str, Any]:
    check_channel_level(channel, target.level)
    b = binding_at(db, target.tenant_id, target.level, target.id, channel)
    eff = effective_for(db, channel, target)
    out: Dict[str, Any] = {
        "channel": channel,
        "level": target.level,
        "targetId": str(target.id),
        "targetName": target.name,
        "effective": eff["content"],
        "source": eff["source"],
        "binding": None,
        "ordering": None,
        "linkedWith": [],
        "linkedLabel": None,
        "diverged": False,
    }
    if b is not None:
        ordering = db.get(DisplayOrdering, b.ordering_id)
        links = linked_with(db, b)
        out["binding"] = {
            "id": str(b.id),
            "orderingId": str(b.ordering_id),
            "copiedFromOrderingId": str(b.copied_from_ordering_id) if b.copied_from_ordering_id else None,
            "copiedAt": b.copied_at.isoformat() if b.copied_at else None,
        }
        out["ordering"] = {**content_of(ordering), "id": str(ordering.id), "version": ordering.version,
                           "updatedBy": ordering.updated_by_name,
                           "updatedAt": ordering.updated_at.isoformat() if ordering.updated_at else None}
        out["linkedWith"] = links
        out["linkedLabel"] = linked_label(links)
        if channel in DEVICE_CHANNELS and b.legacy_hash is not None:
            keys = pos_keys(db, target.level, target.id) if channel == POS else kiosk_keys(db, target.level, target.id)
            out["diverged"] = keys_hash(keys) != b.legacy_hash
    else:
        legacy = legacy_content(db, channel, target.level, target.id)
        if legacy is not None:
            out["ordering"] = {**R.clean(legacy), "id": None, "version": 0, "implicit": True}
    return out


# ── Writing through to the devices ───────────────────────────────────────────


@dataclass
class Wake:
    """Who to wake after the commit."""

    pos: List[Tuple[str, str]]
    kiosks: List[Tuple[str, str]]


def _write_pos(db: Session, level: str, target_id: Any, ordering: DisplayOrdering, now: datetime) -> Optional[Dict[str, Any]]:
    from app.services.settings_merge import patch_settings_json

    row = _pos_row(db, level, target_id)
    if row is None:
        return None
    content = content_of(ordering)
    eff = R.effective(content)
    ids = [p for ids in eff["products"].values() for p in ids] + R._ids(ordering.legacy_flat)
    keys = R.pos_legacy(content, ordering.legacy_flat, category_of(db, ids))
    row.settings = patch_settings_json(row.settings, keys)
    if hasattr(row, "settings_updated_at"):
        row.settings_updated_at = now
    ordering.legacy_flat = keys["productOrder"]
    return pos_keys(db, level, target_id)


def _write_kiosk(db: Session, level: str, target_id: Any, ordering: DisplayOrdering, now: datetime) -> Optional[Dict[str, Any]]:
    from app.models.kiosk import KioskSettings

    if level not in ("company", "shop", "machine"):
        return None
    keys = R.kiosk_legacy(content_of(ordering))
    row = _kiosk_row(db, level, target_id)
    if row is None:
        if keys["categoryOrder"] is None and keys["productOrder"] is None:
            return {}
        target = resolve_target(db, level, target_id, None)
        row = KioskSettings(
            id=uuid.uuid4(), tenant_id=target.tenant_id, level=level,
            company_id=target.id if level == "company" else None,
            shop_id=target.id if level == "shop" else None,
            machine_id=target.id if level == "machine" else None,
            overrides={},
        )
        db.add(row)
    overrides = dict(row.overrides or {})
    catalog = dict(overrides.get("catalog") or {})
    for k, v in keys.items():
        if v is None:
            catalog.pop(k, None)
        else:
            catalog[k] = v
    if catalog:
        overrides["catalog"] = catalog
    else:
        overrides.pop("catalog", None)
    row.overrides = overrides
    row.updated_at = now
    db.flush()
    return kiosk_keys(db, level, target_id)


def write_through(db: Session, ordering: DisplayOrdering, *, skip: Optional[DisplayOrderingBinding] = None,
                  only: Optional[DisplayOrderingBinding] = None, now: Optional[datetime] = None) -> Wake:
    """
    Write the ordering into the keys of each of its tills' and kiosks' bindings (the caller commits) —
    or, with `only`, of that one binding (a level just linked or copied: the others hold it already).
    """
    now = now or _now()
    wake = Wake(pos=[], kiosks=[])
    for b in bindings_of(db, ordering.id):
        if skip is not None and b.id == skip.id:
            continue
        if only is not None and b.id != only.id:
            continue
        if b.channel == POS:
            keys = _write_pos(db, b.level, b.target_id, ordering, now)
            if keys is not None:
                b.legacy_hash = keys_hash(keys)
                wake.pos.append((b.level, str(b.target_id)))
        elif b.channel == KIOSK:
            keys = _write_kiosk(db, b.level, b.target_id, ordering, now)
            if keys is not None:
                b.legacy_hash = keys_hash(keys)
                wake.kiosks.append((b.level, str(b.target_id)))
    db.flush()
    return wake


def devices_of(db: Session, wake: Wake) -> List[Tuple[str, str]]:
    """`[(tenant id, machine id)]` — the active tills of each written settings layer, the kiosks of each kiosk layer."""
    out: Dict[Tuple[str, str], None] = {}
    active = POSMachine.is_active.is_(True)
    for level, ident in wake.pos:
        q = db.query(POSMachine.tenant_id, POSMachine.id).filter(active)
        if level == "machine":
            q = q.filter(POSMachine.id == _uuid(ident))
        elif level == "area":
            q = q.filter(POSMachine.area_id == _uuid(ident))
        elif level == "shop":
            q = q.filter(POSMachine.shop_id == _uuid(ident))
        elif level == "company":
            q = q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == _uuid(ident))
        elif level == "tenant":
            q = q.filter(POSMachine.tenant_id == _uuid(ident))
        else:
            continue
        for tid, mid in q.all():
            if tid is not None:
                out[(str(tid), str(mid))] = None
    if wake.kiosks:
        from app.models.kiosk import KioskDevice

        for level, ident in wake.kiosks:
            # A till's kiosk-mode row (home_role "till") is no kiosk: the tills are woken by their own layers.
            q = db.query(KioskDevice.tenant_id, KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None))
            if level == "machine":
                q = q.filter(KioskDevice.machine_id == _uuid(ident))
            elif level == "shop":
                q = q.filter(KioskDevice.shop_id == _uuid(ident))
            else:
                q = q.join(Shop, Shop.id == KioskDevice.shop_id).filter(Shop.company_id == _uuid(ident))
            for tid, mid in q.all():
                if tid is not None:
                    out[(str(tid), str(mid))] = None
    return list(out)


_PENDING = "display_ordering.wake"


def publish(tenant_id: str, machine_id: str, reason: str) -> None:
    """One device's settings signal (patched in tests)."""
    from app.services.ably_notify import publish_settings_notify

    publish_settings_notify(tenant_id, machine_id, reason=reason)


def _send(session) -> None:
    if session.in_nested_transaction():
        return
    for (tenant_id, machine_id) in sorted(session.info.pop(_PENDING, {})):
        try:
            publish(tenant_id, machine_id, "display_order")
        except Exception:  # noqa: BLE001 - a push never fails the save
            pass


def wake_after_commit(db: Session, wake: Wake) -> None:
    """The devices whose keys were written are woken once the transaction commits (dropped on a rollback)."""
    from sqlalchemy import event

    devices = devices_of(db, wake)
    if not devices:
        return
    pending = db.info.setdefault(_PENDING, {})
    for key in devices:
        pending[key] = None
    if not db.info.get(_PENDING + ".installed"):
        db.info[_PENDING + ".installed"] = True
        event.listen(db, "after_commit", _send)
        event.listen(db, "after_rollback", lambda s: s.info.pop(_PENDING, None))


# ── The editor's actions ─────────────────────────────────────────────────────


def save(db: Session, target: Target, channel: str, content: Mapping[str, Any], *, version: Optional[int],
         user: Any = None, now: Optional[datetime] = None) -> Wake:
    """
    Save the order at this level: the binding's ordering (every target linked to it moves too), or a
    new independent one. `version` is the ordering's as the editor read it (409 when it moved on).
    """
    check_channel_level(channel, target.level)
    now = now or _now()
    b = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if b is None:
        b = materialize(db, target, channel, user=user)
        ordering = db.get(DisplayOrdering, b.ordering_id)
    else:
        ordering = db.get(DisplayOrdering, b.ordering_id)
        if version is not None and version != ordering.version:
            raise _bad("ordering_changed", "הסדר השתנה מאז שנטען — טענו מחדש", status.HTTP_409_CONFLICT,
                       version=ordering.version)
    _set_content(ordering, content)
    ordering.version = (ordering.version or 0) + 1
    ordering.updated_at = now
    ordering.updated_by_user_id = getattr(user, "id", None)
    ordering.updated_by_name = _user_name(user)
    db.flush()
    return write_through(db, ordering, now=now)


def link(db: Session, target: Target, channel: str, source: Target, source_channel: str, *, user: Any = None) -> Wake:
    """"קשר": this level's channel uses the source's ordering from now on (the source made a binding if needed)."""
    check_channel_level(channel, target.level)
    check_channel_level(source_channel, source.level)
    if (target.level, str(target.id), channel) == (source.level, str(source.id), source_channel):
        raise _bad("link_self", "אי אפשר לקשר סידור לעצמו")
    src = materialize(db, source, source_channel, user=user)
    ordering = db.get(DisplayOrdering, src.ordering_id)
    row = bind(db, target, channel, ordering, user=user)
    # Only the level just linked takes the order: the source's levels hold it already.
    return write_through(db, ordering, only=row)


def unlink(db: Session, target: Target, channel: str, *, user: Any = None) -> Wake:
    """"נתק": this binding gets a copy of the ordering it shared — the positions do not move."""
    b = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if b is None:
        raise _bad("not_bound", "אין סידור ברמה הזו")
    ordering = db.get(DisplayOrdering, b.ordering_id)
    if len(bindings_of(db, ordering.id)) <= 1:
        return Wake(pos=[], kiosks=[])
    copy = new_ordering(db, target.tenant_id, content_of(ordering), company_id=ordering.company_id,
                        legacy_flat=ordering.legacy_flat, user=user)
    bind(db, target, channel, copy, user=user, copied_from=ordering.id)
    # Nothing a device reads changes: the copy holds the same positions.
    return Wake(pos=[], kiosks=[])


def copy_from(db: Session, target: Target, channel: str, source: Target, source_channel: str, *,
              user: Any = None) -> Wake:
    """"העתק סדר מ…": a snapshot of the source's effective order, independent from then on."""
    check_channel_level(channel, target.level)
    check_channel_level(source_channel, source.level)
    snap = effective_for(db, source_channel, source)["content"]
    src_binding = binding_at(db, source.tenant_id, source.level, source.id, source_channel)
    b = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if b is not None and len(bindings_of(db, b.ordering_id)) == 1:
        ordering = db.get(DisplayOrdering, b.ordering_id)
        _set_content(ordering, snap)
        ordering.version = (ordering.version or 0) + 1
        ordering.updated_by_name = _user_name(user)
        b.copied_from_ordering_id = src_binding.ordering_id if src_binding is not None else None
        b.copied_at = _now()
    else:
        ordering = new_ordering(db, target.tenant_id, snap, company_id=target.company_id, user=user)
        b = bind(db, target, channel, ordering, user=user,
                 copied_from=src_binding.ordering_id if src_binding is not None else None)
    return write_through(db, ordering, only=b)


def clear(db: Session, target: Target, channel: str, *, user: Any = None) -> Wake:
    """"חזרה לירושה": this level lets go of its order (its devices' keys too) and inherits."""
    from app.services.settings_merge import patch_settings_json

    b = binding_at(db, target.tenant_id, target.level, target.id, channel)
    if b is not None:
        db.delete(b)
    wake = Wake(pos=[], kiosks=[])
    now = _now()
    if channel == POS:
        row = _pos_row(db, target.level, target.id)
        if row is not None and pos_keys(db, target.level, target.id):
            row.settings = patch_settings_json(row.settings, {"productOrder": None, "categoryOrder": None})
            if hasattr(row, "settings_updated_at"):
                row.settings_updated_at = now
            wake.pos.append((target.level, str(target.id)))
    elif channel == KIOSK:
        row = _kiosk_row(db, target.level, target.id)
        if row is not None and kiosk_keys(db, target.level, target.id):
            overrides = dict(row.overrides or {})
            catalog = {k: v for k, v in (overrides.get("catalog") or {}).items() if k not in ("categoryOrder", "productOrder")}
            if catalog:
                overrides["catalog"] = catalog
            else:
                overrides.pop("catalog", None)
            row.overrides = overrides
            row.updated_at = now
            wake.kiosks.append((target.level, str(target.id)))
    db.flush()
    return wake


# ── After the older write points ─────────────────────────────────────────────


def _after_device_write(db: Session, tenant_id: Any, channel: str, level: str, target_id: Any) -> Wake:
    """A level's keys were written by an older path: its binding's ordering follows them, and the linked levels too."""
    if not tables_ready(db):
        return Wake(pos=[], kiosks=[])
    b = binding_at(db, tenant_id, level, target_id, channel)
    if b is None:
        return Wake(pos=[], kiosks=[])
    keys = pos_keys(db, level, target_id) if channel == POS else kiosk_keys(db, level, target_id)
    if not keys:
        # Cleared: the level inherits now; its binding goes (an ordering linked elsewhere stays).
        db.delete(b)
        db.flush()
        return Wake(pos=[], kiosks=[])
    if b.legacy_hash is not None and keys_hash(keys) == b.legacy_hash:
        # The keys are as the ordering last wrote / read them (a save of other settings): nothing moves.
        return Wake(pos=[], kiosks=[])
    content = legacy_content(db, channel, level, target_id) or R.empty()
    ordering = db.get(DisplayOrdering, b.ordering_id)
    previous = content_of(ordering)
    # Pins and the new-items rule are the ordering's own (today's keys hold neither).
    content["pinned"] = previous["pinned"]
    content["newItems"] = previous["newItems"]
    _set_content(ordering, content)
    if channel == POS:
        ordering.legacy_flat = content.get("legacyFlat")
    ordering.version = (ordering.version or 0) + 1
    ordering.updated_at = _now()
    b.legacy_hash = keys_hash(keys)
    db.flush()
    return write_through(db, ordering, skip=b)


def after_pos_write(db: Session, tenant_id: Any, written: Sequence[Tuple[str, Any]]) -> Wake:
    """After `PUT /sync/{m}/product-order`: each `(level, id)` it wrote or cleared."""
    wake = Wake(pos=[], kiosks=[])
    for level, ident in written:
        if ident is None:
            continue
        w = _after_device_write(db, tenant_id, POS, level, ident)
        wake.pos += w.pos
        wake.kiosks += w.kiosks
    return wake


def after_kiosk_write(db: Session, tenant_id: Any, written: Sequence[Tuple[str, Any]]) -> Wake:
    """After a kiosk layer was saved (the dashboard's kiosk settings, the kiosk's own menu editor)."""
    wake = Wake(pos=[], kiosks=[])
    for level, ident in written:
        if ident is None:
            continue
        w = _after_device_write(db, tenant_id, KIOSK, level, ident)
        wake.pos += w.pos
        wake.kiosks += w.kiosks
    return wake
