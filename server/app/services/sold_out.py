"""
Blocks on a product — "אזל" (sold out) and "חסום" (blocked) — for any scope, for a while.

* **The blocks** — `sold_out_marks` (app/models/sold_out.py): `scope` (an enum) + `scope_id`,
  `kind`, `until`, `source`. A block is in force from `created_at` until `until`, or until removed.
  Removing stamps `cleared_at` and `updated_at` and never deletes, so a till's delta pull sees it and
  the screen can say who did what. Several blocks may cover one product; any one in force that
  covers a device stops it there.
* **Scopes** — company · shop · kiosks (every kiosk of a shop) · area · group (device groups, through
  app/services/device_groups.py) · event · machine (a till or a kiosk) · kiosk (that device while it
  is a kiosk). Which devices a scope reaches: `devices_reached` (the cloud) and the shared
  `sold_out_rules.covers` (the cloud and the till, pinned by the golden fixture).
* **What a till gets** — each product row of its catalog (app/services/sync.py) carries the blocks in
  force that cover it (`blocks`), the catalog lock's own answer (`lockAvailable`) and `isAvailable` =
  not locked and not blocked. So an older till, the web kiosk and the Windows kiosk — which read
  `isAvailable` only — stop selling it at once (the kiosks grey it "אזל" or hide it by
  `general.soldOutMode`), and a current till runs `decide` over `blocks` with its own clock: "אזל"
  (a manager may approve a sale with the manager code) or "חסום" (refused).
* **Fast** — a block, its removal, an extension and an automatic block wake the devices it reaches
  with the catalog signal (Ably) after the commit; each pulls its catalog within seconds. A block that
  ends by its `until` needs no signal: every device lifts it by its own clock, offline too, and the
  product's next delta carries it (the row's `updatedAt` moves to `until`).
* **Automatic** — `autoSoldOutAtZero` (POS settings, tenant → company → shop → area; on unless a layer
  turns it off): stock that a product is sold from reaching 0 sets an automatic "אזל" for the devices
  that sell from it, and stock back above 0 clears it (`on_stock_crossing`, called by
  app/services/stock.py — today for the shop's stock). Hand blocks are never touched by stock.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.sold_out import SOLD_OUT_KINDS, SOLD_OUT_SCOPES, SoldOutMark
from app.services import device_groups
from app.services import sold_out_rules as rules

logger = logging.getLogger(__name__)

#: `reason` on the catalog signal the devices get.
NOTIFY_REASON = "sold_out"
SETTING_AUTO = rules.SETTING_AUTO
AUTO_BY = "מלאי אזל"
AUTO_CLEARED_BY = "מלאי חזר"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


_READY: "weakref.WeakKeyDictionary" = None  # type: ignore[assignment]


def tables_ready(db: Session) -> bool:
    """
    Whether `sold_out_marks` exists on this connection's database — always in production (the
    migration); the in-memory test worlds of other features create only the tables they test, and
    their catalog pulls must not fail over a feature they do not use. Asked once per engine.
    """
    global _READY
    import weakref

    if _READY is None:
        _READY = weakref.WeakKeyDictionary()
    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001 - an unbound session reads nothing
        return False
    known = _READY.get(engine)
    if known is None:
        from sqlalchemy import inspect as sa_inspect

        try:
            known = bool(sa_inspect(db.connection()).has_table(SoldOutMark.__tablename__))
        except Exception:  # noqa: BLE001
            known = False
        if known:
            _READY[engine] = True
    return bool(known)


def in_force_filter(now: datetime):
    """SQL: the block is in force at `now`."""
    return and_(
        SoldOutMark.cleared_at.is_(None),
        or_(SoldOutMark.until.is_(None), SoldOutMark.until > now),
    )


def is_in_force(mark: SoldOutMark, now: datetime) -> bool:
    return mark.cleared_at is None and rules.in_force(_aware(mark.until), now)


# ── Who a device is ──────────────────────────────────────────────────────────


def is_kiosk(db: Session, machine: POSMachine) -> bool:
    """A device converted to a self-order kiosk (and enabled as one)."""
    from app.models.kiosk import KioskDevice

    device = db.get(KioskDevice, machine.id)
    return device is not None and bool(device.enabled)


def event_ids_of(db: Session, machine_id: Any) -> List[Any]:
    """The events this device is in now (assigned and not released)."""
    if machine_id is None:
        return []
    rows = (
        db.query(ReportEventMachine.event_id)
        .filter(ReportEventMachine.machine_id == machine_id, ReportEventMachine.released_at.is_(None))
        .all()
    )
    return [r[0] for r in rows]


@dataclass
class DeviceContext:
    company_id: Any
    shop_id: Any
    area_id: Any
    machine_id: Any
    is_kiosk: bool = False
    event_ids: List[Any] = field(default_factory=list)
    group_ids: List[Any] = field(default_factory=list)

    def till(self) -> rules.Till:
        return rules.Till(
            company_id=str(self.company_id) if self.company_id else None,
            shop_id=str(self.shop_id) if self.shop_id else None,
            area_id=str(self.area_id) if self.area_id else None,
            machine_id=str(self.machine_id) if self.machine_id else None,
            is_kiosk=self.is_kiosk,
            event_ids=tuple(str(e) for e in self.event_ids),
            group_ids=tuple(str(g) for g in self.group_ids),
        )

    def scope_pairs(self) -> List[Tuple[str, Any]]:
        pairs: List[Tuple[str, Any]] = [("shop", self.shop_id), ("machine", self.machine_id)]
        if self.company_id is not None:
            pairs.append(("company", self.company_id))
        if self.area_id is not None:
            pairs.append(("area", self.area_id))
        if self.is_kiosk:
            pairs += [("kiosk", self.machine_id), ("kiosks", self.shop_id)]
        pairs += [("event", e) for e in self.event_ids]
        pairs += [("group", g) for g in self.group_ids]
        return pairs


def device_context(db: Session, machine: POSMachine) -> DeviceContext:
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    return DeviceContext(
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        is_kiosk=is_kiosk(db, machine),
        event_ids=event_ids_of(db, machine.id),
        group_ids=device_groups.groups_of(db, machine.id),
    )


def _scope_filter(ctx: DeviceContext):
    return or_(*[and_(SoldOutMark.scope == scope, SoldOutMark.scope_id == ident) for scope, ident in ctx.scope_pairs()])


# ── What a device is sent ────────────────────────────────────────────────────


@dataclass
class ProductBlocks:
    """The blocks of one product that reach one device."""

    #: In force now, covering the device.
    active: List[SoldOutMark] = field(default_factory=list)
    #: When what the device should show last changed (a block set, removed, extended or ended).
    changed_at: Optional[datetime] = None


def blocks_for_machine(
    db: Session,
    machine: POSMachine,
    product_ids: Optional[Sequence[Any]] = None,
    *,
    now: Optional[datetime] = None,
    since: Optional[datetime] = None,
    ctx: Optional[DeviceContext] = None,
) -> Dict[str, ProductBlocks]:
    """
    `{str(product_id): ProductBlocks}` for the products whose blocks reach this device: those in
    force, and — for a delta pull — those set, removed or ended since `since`.
    """
    if machine.shop_id is None or not tables_ready(db):
        return {}
    now = now or utc_now()
    ctx = ctx or device_context(db, machine)
    q = db.query(SoldOutMark).filter(_scope_filter(ctx))
    if product_ids is not None:
        ids = [i for i in product_ids if i is not None]
        if not ids:
            return {}
        q = q.filter(SoldOutMark.product_id.in_(ids))
    relevant = [in_force_filter(now)]
    if since is not None:
        relevant.append(SoldOutMark.updated_at > since)
        relevant.append(and_(SoldOutMark.until > since, SoldOutMark.until <= now))
    q = q.filter(or_(*relevant))
    till = ctx.till()
    grouped: Dict[str, List[SoldOutMark]] = {}
    sells_from: Dict[Any, Any] = {}
    for mark in q.all():
        if not rules.covers(mark, till):
            continue
        # An automatic "אזל" is about one stock location: it reaches only the devices that sell
        # the product from it (app/services/stock_locations.py `sell_from`).
        if mark.source == "auto" and not _sells_from(db, machine, mark, sells_from):
            continue
        grouped.setdefault(str(mark.product_id), []).append(mark)
    out: Dict[str, ProductBlocks] = {}
    for pid, marks in grouped.items():
        stamps: List[datetime] = []
        for m in marks:
            stamps.append(_aware(m.updated_at) or now)
            until = _aware(m.until)
            if until is not None and until <= now:
                stamps.append(until)
        out[pid] = ProductBlocks(
            active=[m for m in marks if is_in_force(m, now)],
            changed_at=max(stamps) if stamps else None,
        )
    return out


def _sells_from(db: Session, machine: POSMachine, mark: SoldOutMark, cache: Dict[Any, Any]) -> bool:
    """The automatic block's location is where this device sells the product from."""
    from app.services import stock_locations as SL

    if "path" not in cache:
        cache["path"] = SL.path_of_machine(db, machine)
        cache["book"] = SL.rulebook_for_path(db, cache["path"])
    key = mark.product_id
    if key not in cache:
        product = db.get(Product, mark.product_id)
        if product is None:
            cache[key] = None
        else:
            managed = cache["book"].managed(company_id=cache["path"].company_id, shop_id=cache["path"].shop_id, product=product)
            cache[key] = SL.sell_from(cache["path"], managed)
    loc = cache[key]
    return loc is not None and loc.level == mark.scope and str(loc.target_id) == str(mark.scope_id)


def block_out(mark: SoldOutMark) -> Dict[str, Any]:
    """One block as a device gets it (and the shared rule reads it)."""
    return {
        "id": str(mark.id),
        "scope": mark.scope,
        "scopeId": str(mark.scope_id),
        "kind": mark.kind or "sold_out",
        "source": mark.source,
        "until": _iso(mark.until),
        "createdAt": _iso(mark.created_at),
        "by": mark.created_by_name,
        "note": mark.note,
    }


# ── Whom a block reaches ─────────────────────────────────────────────────────


def _kiosk_ids(db: Session, machine_ids: Iterable[Any]) -> set:
    from app.models.kiosk import KioskDevice

    ids = [i for i in machine_ids if i is not None]
    if not ids:
        return set()
    return {
        r[0] for r in db.query(KioskDevice.machine_id)
        .filter(KioskDevice.machine_id.in_(ids), KioskDevice.enabled.is_(True)).all()
    }


def devices_reached(db: Session, scope: str, scope_id: Any) -> List[POSMachine]:
    """The active devices a block of this scope reaches now."""
    q = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if scope == "shop":
        return q.filter(POSMachine.shop_id == scope_id).all()
    if scope == "company":
        return q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == scope_id).all()
    if scope == "area":
        return q.filter(POSMachine.area_id == scope_id).all()
    if scope in ("machine", "kiosk"):
        rows = q.filter(POSMachine.id == scope_id).all()
        if scope == "kiosk":
            kiosks = _kiosk_ids(db, [m.id for m in rows])
            rows = [m for m in rows if m.id in kiosks]
        return rows
    if scope == "kiosks":
        rows = q.filter(POSMachine.shop_id == scope_id).all()
        kiosks = _kiosk_ids(db, [m.id for m in rows])
        return [m for m in rows if m.id in kiosks]
    if scope == "event":
        return (
            q.join(ReportEventMachine, ReportEventMachine.machine_id == POSMachine.id)
            .filter(ReportEventMachine.event_id == scope_id, ReportEventMachine.released_at.is_(None))
            .all()
        )
    if scope == "group":
        group = device_groups.group(db, scope_id)
        ids = list((group or {}).get("machineIds") or [])
        return q.filter(POSMachine.id.in_(ids)).all() if ids else []
    return []


def signal_after_commit(db: Session, devices: Iterable[POSMachine]) -> None:
    from app.services.commit_signals import catalog_signal_after_commit

    catalog_signal_after_commit(
        db, [(str(m.tenant_id), str(m.id)) for m in devices if m.tenant_id is not None], NOTIFY_REASON
    )


# ── The scope a block is written for ─────────────────────────────────────────


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@dataclass(frozen=True)
class Target:
    scope: str
    scope_id: uuid.UUID
    name: str
    company_id: Optional[uuid.UUID]
    shop_id: Optional[uuid.UUID]
    #: The point of sale it lies in (an area, or a device standing in one), for area-scoped managers.
    area_id: Optional[uuid.UUID] = None


def resolve_target(db: Session, scope: str, scope_id: Any, tenant_id: Any) -> Target:
    """The scope's entity, checked to be this tenant's; 422 / 404 otherwise."""
    if scope not in SOLD_OUT_SCOPES:
        raise _bad("invalid_scope", "היקף לא מוכר")
    ident = _uuid(scope_id)
    if ident is None:
        raise _bad("scope_id_required", "חסר מזהה להיקף")

    def same(entity_tenant) -> None:
        if tenant_id is not None and str(entity_tenant) != str(tenant_id):
            raise _bad("scope_not_found", "ההיקף לא נמצא", status.HTTP_404_NOT_FOUND)

    if scope == "company":
        company = db.get(Company, ident)
        if company is None:
            raise _bad("scope_not_found", "החברה לא נמצאה", status.HTTP_404_NOT_FOUND)
        same(company.tenant_id)
        return Target(scope, company.id, company.name, company.id, None)
    if scope in ("shop", "kiosks"):
        shop = db.get(Shop, ident)
        if shop is None:
            raise _bad("scope_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
        same(shop.tenant_id)
        return Target(scope, shop.id, shop.name, shop.company_id, shop.id)
    if scope == "area":
        area = db.get(ShopArea, ident)
        if area is None or area.archived_at is not None:
            raise _bad("scope_not_found", "נקודת המכירה לא נמצאה", status.HTTP_404_NOT_FOUND)
        same(area.tenant_id)
        shop = db.get(Shop, area.shop_id)
        return Target(scope, area.id, area.name, shop.company_id if shop else None, area.shop_id, area.id)
    if scope in ("machine", "kiosk"):
        machine = db.get(POSMachine, ident)
        if machine is None or machine.shop_id is None:
            raise _bad("scope_not_found", "המכשיר לא נמצא", status.HTTP_404_NOT_FOUND)
        same(machine.tenant_id)
        if scope == "kiosk" and not _kiosk_ids(db, [machine.id]):
            raise _bad("not_a_kiosk", "המכשיר אינו קיוסק")
        shop = db.get(Shop, machine.shop_id)
        return Target(scope, machine.id, machine.name, shop.company_id if shop else None, machine.shop_id, machine.area_id)
    if scope == "event":
        event = db.get(ReportEvent, ident)
        if event is None:
            raise _bad("scope_not_found", "האירוע לא נמצא", status.HTTP_404_NOT_FOUND)
        same(event.tenant_id)
        return Target(scope, event.id, event.name, event.company_id, event.shop_id)
    group = device_groups.group(db, ident)
    if group is None:
        raise _bad("groups_unavailable", "קבוצות מכשירים עדיין לא זמינות")
    shop = db.get(Shop, _uuid(group.get("shopId"))) if group.get("shopId") else None  # pragma: no cover - wired at merge
    return Target(  # pragma: no cover
        scope, ident, group.get("name") or "", shop.company_id if shop else None, shop.id if shop else None,
    )


def global_product(db: Session, product_id: Any, tenant_id: Any) -> Product:
    ident = _uuid(product_id)
    p = db.get(Product, ident) if ident is not None else None
    if p is not None and p.global_product_id:
        p = db.get(Product, p.global_product_id)
    if p is None or (tenant_id is not None and str(p.tenant_id) != str(tenant_id)):
        raise _bad("product_not_found", "המוצר לא נמצא", status.HTTP_404_NOT_FOUND)
    return p


def _user_name(user: Any) -> Optional[str]:
    if user is None:
        return None
    return getattr(user, "username", None) or getattr(user, "email", None)


# ── Writing ──────────────────────────────────────────────────────────────────


def block(
    db: Session,
    *,
    tenant_id: Any,
    product: Product,
    target: Target,
    kind: str = "sold_out",
    until: Optional[datetime] = None,
    until_mode: Optional[str] = None,
    note: Optional[str] = None,
    user: Any = None,
    by_name: Optional[str] = None,
    source: str = "manual",
    now: Optional[datetime] = None,
) -> SoldOutMark:
    """
    Block `product` for the target (the caller commits). A block in force of the same product,
    scope, kind and source is updated (new end, new reason) rather than doubled. 422 for an end
    that has passed already.
    """
    now = now or utc_now()
    if kind not in SOLD_OUT_KINDS:
        raise _bad("invalid_kind", "סוג חסימה לא מוכר")
    until = _aware(until)
    if until is not None and until <= now:
        raise _bad("until_passed", "שעת הסיום כבר עברה")
    existing = (
        db.query(SoldOutMark)
        .filter(
            SoldOutMark.product_id == product.id,
            SoldOutMark.scope == target.scope,
            SoldOutMark.scope_id == target.scope_id,
            SoldOutMark.kind == kind,
            SoldOutMark.source == source,
            in_force_filter(now),
        )
        .first()
    )
    who = by_name or _user_name(user)
    text = (note or "").strip()[:200] or None
    if existing is not None:
        existing.until = until
        existing.until_mode = until_mode
        existing.note = text
        existing.updated_at = now
        row = existing
    else:
        row = SoldOutMark(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            company_id=target.company_id,
            shop_id=target.shop_id,
            product_id=product.id,
            scope=target.scope,
            scope_id=target.scope_id,
            kind=kind,
            until=until,
            until_mode=until_mode,
            source=source,
            note=text,
            created_by_user_id=getattr(user, "id", None),
            created_by_name=(who or None) and who[:200],
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    db.flush()
    signal_after_commit(db, devices_reached(db, target.scope, target.scope_id))
    return row


def clear(db: Session, mark: SoldOutMark, *, user: Any = None, by_name: Optional[str] = None, now: Optional[datetime] = None) -> SoldOutMark:
    """Remove one block ("בטל עכשיו"; the caller commits)."""
    now = now or utc_now()
    if mark.cleared_at is None:
        who = by_name or _user_name(user)
        mark.cleared_at = now
        mark.cleared_by_user_id = getattr(user, "id", None)
        mark.cleared_by_name = (who or None) and who[:200]
        mark.updated_at = now
        db.flush()
        signal_after_commit(db, devices_reached(db, mark.scope, mark.scope_id))
    return mark


def extend(db: Session, mark: SoldOutMark, minutes: int, *, now: Optional[datetime] = None) -> SoldOutMark:
    """"הארך": the end moved by `minutes` (the caller commits). 422 for an open-ended or removed block."""
    from app.services import block_durations

    now = now or utc_now()
    if not is_in_force(mark, now):
        raise _bad("not_in_force", "החסימה כבר לא בתוקף")
    try:
        mark.until = block_durations.extend(_aware(mark.until), now, minutes)
    except block_durations.DurationRefused as refused:
        raise _bad(refused.code, refused.message) from refused
    mark.updated_at = now
    db.flush()
    signal_after_commit(db, devices_reached(db, mark.scope, mark.scope_id))
    return mark


def clear_product(
    db: Session,
    *,
    product: Product,
    scopes: Optional[Sequence[Tuple[str, Any]]] = None,
    shop_ids: Optional[Sequence[Any]] = None,
    sources: Sequence[str] = ("manual", "auto"),
    user: Any = None,
    by_name: Optional[str] = None,
    now: Optional[datetime] = None,
) -> List[SoldOutMark]:
    """Remove the blocks in force of a product — of these scopes, or of these shops. The caller commits."""
    now = now or utc_now()
    q = db.query(SoldOutMark).filter(
        SoldOutMark.product_id == product.id,
        SoldOutMark.source.in_(list(sources)),
        in_force_filter(now),
    )
    if scopes:
        q = q.filter(or_(*[and_(SoldOutMark.scope == s, SoldOutMark.scope_id == i) for s, i in scopes]))
    if shop_ids is not None:
        q = q.filter(SoldOutMark.shop_id.in_([s for s in shop_ids if s is not None]))
    rows = q.all()
    for row in rows:
        clear(db, row, user=user, by_name=by_name, now=now)
    return rows


# ── Automatic: stock reached 0, or came back ─────────────────────────────────


def auto_setting_on(db: Session, shop_id: Any, area_id: Any = None) -> bool:
    """`autoSoldOutAtZero` for the shop (or its point of sale): on unless a layer turns it off."""
    from types import SimpleNamespace

    from app.models.tenant import Tenant
    from app.services.settings_merge import merge_all_settings_layers

    shop = db.get(Shop, shop_id) if shop_id is not None else None
    if shop is None:
        return True
    company = db.get(Company, shop.company_id) if shop.company_id else None
    tenant = db.get(Tenant, shop.tenant_id) if shop.tenant_id else None
    area = db.get(ShopArea, area_id) if area_id is not None else None
    merged = merge_all_settings_layers(company or SimpleNamespace(settings={}), shop, tenant, None, area)
    return rules.auto_on(merged.get(SETTING_AUTO))


def on_stock_crossing(
    db: Session,
    *,
    tenant_id: Any,
    scope: str,
    scope_id: Any,
    product_id: Any,
    ran_out: bool,
    now: Optional[datetime] = None,
) -> Optional[str]:
    """
    The hook stock calls when a tracked product's stock that devices sell from crossed 0: `scope` /
    `scope_id` is that stock's place ("shop" + the shop today; any location level later). Ran out →
    an automatic "אזל" for it (the setting on, none already in force); came back → its automatic
    blocks removed. Returns "blocked" / "cleared" / None.
    """
    now = now or utc_now()
    product = db.get(Product, product_id)
    if product is None or not tables_ready(db):
        return None
    try:
        target = resolve_target(db, scope, scope_id, tenant_id)
    except HTTPException:
        return None
    if ran_out:
        shop_for_setting = target.shop_id
        area_for_setting = target.area_id if scope == "area" else None
        if not auto_setting_on(db, shop_for_setting, area_for_setting):
            return None
        existing = (
            db.query(SoldOutMark.id)
            .filter(
                SoldOutMark.product_id == product.id,
                SoldOutMark.scope == target.scope,
                SoldOutMark.scope_id == target.scope_id,
                SoldOutMark.source == "auto",
                in_force_filter(now),
            )
            .first()
        )
        if existing is not None:
            return None
        block(db, tenant_id=tenant_id, product=product, target=target, by_name=AUTO_BY, source="auto", now=now)
        return "blocked"
    cleared = clear_product(
        db, product=product, scopes=[(target.scope, target.scope_id)], sources=("auto",), by_name=AUTO_CLEARED_BY, now=now,
    )
    return "cleared" if cleared else None


# ── The dashboard ────────────────────────────────────────────────────────────


def _scope_names(db: Session, marks: Sequence[SoldOutMark]) -> Dict[Tuple[str, str], str]:
    names: Dict[Tuple[str, str], str] = {}
    by_scope: Dict[str, set] = {}
    for m in marks:
        by_scope.setdefault(m.scope, set()).add(m.scope_id)
    model = {
        "company": Company, "shop": Shop, "kiosks": Shop, "area": ShopArea,
        "machine": POSMachine, "kiosk": POSMachine, "event": ReportEvent,
    }
    for scope, ids in by_scope.items():
        cls = model.get(scope)
        if cls is None:
            for gid in ids:
                group = device_groups.group(db, gid)
                names[(scope, str(gid))] = (group or {}).get("name") or ""
            continue
        for row in db.query(cls).filter(cls.id.in_(list(ids))).all():
            names[(scope, str(row.id))] = getattr(row, "name", None) or ""
    return names


def mark_view(m: SoldOutMark, *, product: Optional[Product], names: Dict[Tuple[str, str], str], shops: Dict[Any, str], now: datetime) -> Dict[str, Any]:
    until = _aware(m.until)
    return {
        **block_out(m),
        "untilMode": m.until_mode,
        "productId": str(m.product_id),
        "productName": product.name if product is not None else None,
        "imageUrl": product.image_url if product is not None else None,
        "categoryId": str(product.category_id) if product is not None and product.category_id else None,
        "shopId": str(m.shop_id) if m.shop_id else None,
        "shopName": shops.get(m.shop_id),
        "companyId": str(m.company_id) if m.company_id else None,
        "scopeName": names.get((m.scope, str(m.scope_id))),
        "secondsLeft": int((until - now).total_seconds()) if until is not None else None,
        "inForce": is_in_force(m, now),
        "clearedAt": _iso(m.cleared_at),
        "clearedBy": m.cleared_by_name,
    }


def list_blocks(
    db: Session,
    *,
    tenant_id: Any,
    shop_ids: Optional[Sequence[Any]] = None,
    company_ids: Optional[Sequence[Any]] = None,
    product_id: Any = None,
    now: Optional[datetime] = None,
    include_ended: bool = False,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """
    The blocks in force (or, `include_ended`, also those removed or ended in the last day) of these
    shops — and of their companies (company-wide blocks) — newest first, with names.
    """
    now = now or utc_now()
    q = db.query(SoldOutMark).filter(SoldOutMark.tenant_id == tenant_id)
    places = []
    if shop_ids is not None:
        ids = [s for s in shop_ids if s is not None]
        places.append(SoldOutMark.shop_id.in_(ids) if ids else SoldOutMark.id.is_(None))
    if company_ids is not None:
        cids = [c for c in company_ids if c is not None]
        if cids:
            places.append(and_(SoldOutMark.scope == "company", SoldOutMark.company_id.in_(cids)))
    if places:
        q = q.filter(or_(*places))
    if product_id is not None:
        q = q.filter(SoldOutMark.product_id == product_id)
    if include_ended:
        from datetime import timedelta

        q = q.filter(or_(in_force_filter(now), SoldOutMark.updated_at > now - timedelta(days=1)))
    else:
        q = q.filter(in_force_filter(now))
    marks = q.order_by(SoldOutMark.created_at.desc()).limit(limit).all()
    names = _scope_names(db, marks)
    pids = list({m.product_id for m in marks})
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}
    sids = list({m.shop_id for m in marks if m.shop_id is not None})
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(sids)).all()} if sids else {}
    return [mark_view(m, product=products.get(m.product_id), names=names, shops=shops, now=now) for m in marks]
