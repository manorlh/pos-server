"""
"שינוי מחירים מרוכז" and "שינוי מחירים מתוזמן" (P:/specs/chain-areas.md §9.5).

**What.** Products (picked, or whole categories) of one shop → a new price: a fixed price (`set`), plus / minus
₪X (`add`), plus / minus Y% (`pct`), then optionally rounded (`round`: "0.90" / "0.50" — up to that ending; "1" —
the nearest shekel; "0.10" — the nearest ten agorot).

**Where.** `areaIds` null — the shop's own price ("כל הנקודות"; the default when the top bar is on the whole shop):
every point of sale inherits it, but one with its own price keeps it unless `overrideAreas` ("גם לדרוס מחירים
מיוחדים בנקודות") clears those. A list — each of those points of sale's own price, computed from what it sells at
now.

**Preview first** (`preview`): one row per product × target — old → new, the points of sale whose own price is
kept or replaced, and the rows the chain's policy or the user's points of sale refuse (with the reason). `apply`
writes the rows that may be written (each logged in `price_changes`) and lists the rest.

**When.** No `startsAt` (or one already past): now. A later `startsAt`: a `price_schedules` row with the preview's
prices frozen, applied by the server's pass (`run_due`, every `INTERVAL_SECONDS`) at that time; with `endsAt`, put
back then — each price to what that level had before, unless someone changed it in between (that one is left and
noted). Devices get the new prices by the ordinary catalog pull, nudged at once (the shop's tills and kiosks).
"""
from __future__ import annotations

import logging
import math
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.price_policy import PriceSchedule
from app.models.product import Product
from app.models.product_availability_override import AreaProductOverride
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.services import area_scope
from app.services import price_policy as PP

logger = logging.getLogger(__name__)

OPS = ("set", "add", "pct")
ROUNDINGS = ("none", "0.90", "0.50", "1", "0.10")
MAX_PRODUCTS = 2000
INTERVAL_SECONDS = 30.0


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── The arithmetic ───────────────────────────────────────────────────────────


def compute(old: Decimal, op: str, value: Decimal, rounding: str = "none") -> Decimal:
    if op == "set":
        new = value
    elif op == "add":
        new = old + value
    elif op == "pct":
        new = old * (Decimal(100) + value) / Decimal(100)
    else:
        raise _bad("price_op")
    new = max(new, Decimal(0))
    if rounding in ("0.90", "0.50"):
        ending = Decimal(rounding)
        whole = Decimal(math.floor(new))
        candidate = whole + ending
        if candidate < new.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP):
            candidate += 1
        new = candidate
    elif rounding == "1":
        new = new.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    elif rounding == "0.10":
        new = new.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return PP.money(new)


# ── The request ──────────────────────────────────────────────────────────────


@dataclass
class Spec:
    shop: Shop
    products: List[Product]
    op: str
    value: Decimal
    rounding: str = "none"
    area_ids: Optional[List[uuid.UUID]] = None
    override_areas: bool = False
    raw: Dict[str, Any] = field(default_factory=dict)


def build_spec(db: Session, user: Any, shop: Shop, body: Dict[str, Any]) -> Spec:
    """From the request body (camelCase): `productIds`, `categoryIds`, `op`, `value`, `round`, `areaIds`, `overrideAreas`."""
    op = body.get("op")
    if op not in OPS:
        raise _bad("price_op")
    rounding = body.get("round") or "none"
    if rounding not in ROUNDINGS:
        raise _bad("price_round")
    try:
        value = Decimal(str(body.get("value")))
    except Exception:  # noqa: BLE001
        raise _bad("price_value")
    if op == "set" and value < 0:
        raise _bad("price_value")
    product_ids = [p for p in (_uuid(v) for v in body.get("productIds") or []) if p is not None]
    category_ids = [c for c in (_uuid(v) for v in body.get("categoryIds") or []) if c is not None]
    if not product_ids and not category_ids:
        raise _bad("no_products")
    q = (
        db.query(Product)
        .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
        .filter(
            ShopProductOverride.shop_id == shop.id,
            ShopProductOverride.is_listed.is_(True),
            Product.pos_machine_id.is_(None),
        )
    )
    from sqlalchemy import or_

    clauses = []
    if product_ids:
        clauses.append(Product.id.in_(product_ids))
    if category_ids:
        clauses.append(Product.category_id.in_(category_ids))
    products = q.filter(or_(*clauses)).order_by(Product.name).limit(MAX_PRODUCTS + 1).all()
    if len(products) > MAX_PRODUCTS:
        raise _bad("too_many_products")
    area_ids = body.get("areaIds")
    areas: Optional[List[uuid.UUID]] = None
    if area_ids is not None:
        areas = []
        live = {a.id: a for a in PA_live_areas(db, shop.id)}
        for raw in area_ids:
            aid = _uuid(raw)
            if aid is None or aid not in live:
                raise _bad(f"area_not_in_shop:{raw}")
            areas.append(aid)
        if not areas:
            raise _bad("no_areas")
    return Spec(
        shop=shop, products=products, op=op, value=value, rounding=rounding, area_ids=areas,
        override_areas=bool(body.get("overrideAreas")), raw=dict(body),
    )


def PA_live_areas(db: Session, shop_id: Any) -> List[ShopArea]:  # noqa: N802 - a re-export
    from app.services.product_areas import live_areas

    return live_areas(db, shop_id)


# ── Preview ──────────────────────────────────────────────────────────────────


def _rows(db: Session, user: Any, spec: Spec) -> List[Dict[str, Any]]:
    shop = spec.shop
    areas = PA_live_areas(db, shop.id)
    names = {a.id: a.name for a in areas}
    ids = [p.id for p in spec.products]
    shop_rows = {
        r.global_product_id: r
        for r in db.query(ShopProductOverride).filter(
            ShopProductOverride.shop_id == shop.id, ShopProductOverride.global_product_id.in_(ids or [uuid.uuid4()])
        )
    }
    area_rows: Dict[Tuple[uuid.UUID, uuid.UUID], AreaProductOverride] = {
        (r.area_id, r.product_id): r
        for r in db.query(AreaProductOverride).filter(
            AreaProductOverride.product_id.in_(ids or [uuid.uuid4()]),
            AreaProductOverride.area_id.in_([a.id for a in areas] or [uuid.uuid4()]),
        )
    }
    policy = PP.effective(db, shop_id=shop.id)
    reach = area_scope.reach_of(db, user)
    out: List[Dict[str, Any]] = []
    for p in spec.products:
        actor = PP.actor_level(db, user, p)
        srow = shop_rows.get(p.id)
        if spec.area_ids is None:
            old, _lvl = PP.resolve(p, srow, None)
            new = compute(PP.money(old), spec.op, spec.value, spec.rounding)
            refused = PP.refusal(policy, actor=actor, product=p, level=PP.SHOP, new_price=new)
            if refused is None and reach.narrowed:
                refused = HTTPException(403, {"message": "מחיר הסניף משתנה ע״י מנהל הסניף"})
            own = [
                {"areaId": str(a.id), "areaName": a.name, "price": float(area_rows[(a.id, p.id)].price)}
                for a in areas
                if (a.id, p.id) in area_rows and area_rows[(a.id, p.id)].price is not None
            ]
            out.append({
                "productId": str(p.id), "productName": p.name, "level": PP.SHOP, "targetId": str(shop.id),
                "targetName": shop.name, "oldPrice": float(old), "newPrice": float(new),
                "areaOverrides": own, "areaOverridesAction": ("replace" if spec.override_areas else "keep") if own else None,
                "refused": refused.detail.get("message") if refused is not None else None,
            })
        else:
            for aid in spec.area_ids:
                arow = area_rows.get((aid, p.id))
                old, _lvl = PP.resolve(p, srow, arow)
                new = compute(PP.money(old), spec.op, spec.value, spec.rounding)
                refused = PP.refusal(policy, actor=actor, product=p, level=PP.AREA, new_price=new)
                if refused is None and not reach.covers_area(aid):
                    refused = HTTPException(403, {"message": "נקודת מכירה שאינה באחריותך"})
                out.append({
                    "productId": str(p.id), "productName": p.name, "level": PP.AREA, "targetId": str(aid),
                    "targetName": names.get(aid), "oldPrice": float(old), "newPrice": float(new),
                    "areaOverrides": [], "areaOverridesAction": None,
                    "refused": refused.detail.get("message") if refused is not None else None,
                })
    return out


def preview(db: Session, user: Any, spec: Spec) -> Dict[str, Any]:
    rows = _rows(db, user, spec)
    return {
        "shopId": str(spec.shop.id),
        "rows": rows,
        "counts": {
            "rows": len(rows),
            "refused": sum(1 for r in rows if r["refused"]),
            "changed": sum(1 for r in rows if not r["refused"] and r["oldPrice"] != r["newPrice"]),
            "areaOverrides": sum(len(r["areaOverrides"]) for r in rows),
        },
    }


# ── Writing ──────────────────────────────────────────────────────────────────


def _write(
    db: Session, *, product: Product, level: str, target_id: uuid.UUID, price: Optional[Decimal], user: Any,
    source: str = "dashboard",
) -> Optional[Decimal]:
    """Set one level's own price (None = back to the level above); returns what it was. Logged."""
    if level == PP.SHOP:
        row = (
            db.query(ShopProductOverride)
            .filter(ShopProductOverride.shop_id == target_id, ShopProductOverride.global_product_id == product.id)
            .first()
        )
        if row is None:
            return None
        old = row.price
        row.price = PP.money(price)
    else:
        row = (
            db.query(AreaProductOverride)
            .filter(AreaProductOverride.area_id == target_id, AreaProductOverride.product_id == product.id)
            .first()
        )
        if row is None:
            if price is None:
                return None
            row = AreaProductOverride(area_id=target_id, product_id=product.id)
            db.add(row)
        old = row.price
        row.price = PP.money(price)
        row.updated_at = _now()
    PP.record(db, product=product, level=level, target_id=target_id, old=old, new=row.price, user=user, source=source)
    return old


def apply(db: Session, user: Any, spec: Spec) -> Dict[str, Any]:
    """Write the rows the preview allows; the rest are listed in `refused`. No commit."""
    rows = _rows(db, user, spec)
    products = {str(p.id): p for p in spec.products}
    areas = PA_live_areas(db, spec.shop.id)
    written, refused = 0, []
    for r in rows:
        if r["refused"]:
            refused.append({"productId": r["productId"], "targetId": r["targetId"], "reason": r["refused"]})
            continue
        product = products[r["productId"]]
        _write(db, product=product, level=r["level"], target_id=uuid.UUID(r["targetId"]),
               price=Decimal(str(r["newPrice"])), user=user)
        written += 1
        if r["level"] == PP.SHOP and spec.override_areas and r["areaOverrides"]:
            for o in r["areaOverrides"]:
                _write(db, product=product, level=PP.AREA, target_id=uuid.UUID(o["areaId"]), price=None, user=user)
    return {"written": written, "refused": refused, "areas": [str(a.id) for a in areas]}


def notify(db: Session, shop_id: Any) -> None:
    """The shop's tills and kiosks pull now (the realtime nudge every catalog change sends)."""
    try:
        from app.services.catalog_notify import notify_machines_for_shop

        notify_machines_for_shop(db, str(shop_id), reason="prices_changed")
    except Exception:  # noqa: BLE001 - the periodic pull still brings it
        logger.exception("price change: notify failed for shop %s", shop_id)


# ── Schedules ────────────────────────────────────────────────────────────────


def schedule(
    db: Session, user: Any, spec: Spec, *, starts_at: datetime, ends_at: Optional[datetime], label: Optional[str]
) -> PriceSchedule:
    """Freeze the preview's allowed rows into a schedule (no commit)."""
    starts_at = _aware(starts_at)
    ends_at = _aware(ends_at)
    if ends_at is not None and ends_at <= starts_at:
        raise _bad("ends_before_start")
    rows = _rows(db, user, spec)
    items = []
    for r in rows:
        if r["refused"]:
            continue
        items.append({"productId": r["productId"], "level": r["level"], "targetId": r["targetId"], "newPrice": r["newPrice"]})
        if r["level"] == PP.SHOP and spec.override_areas:
            for o in r["areaOverrides"]:
                items.append({"productId": r["productId"], "level": PP.AREA, "targetId": o["areaId"], "newPrice": None})
    if not items:
        raise _bad("nothing_to_schedule", status.HTTP_409_CONFLICT)
    row = PriceSchedule(
        tenant_id=spec.shop.tenant_id, shop_id=spec.shop.id, label=(label or "").strip()[:120] or None,
        starts_at=starts_at, ends_at=ends_at, status="pending",
        spec={k: v for k, v in spec.raw.items() if k in ("op", "value", "round", "areaIds", "overrideAreas", "productIds", "categoryIds")},
        items=items, created_by_user_id=getattr(user, "id", None),
        created_by_name=getattr(user, "username", None) or getattr(user, "email", None),
    )
    db.add(row)
    return row


def _creator(db: Session, sched: PriceSchedule) -> Any:
    from app.models.user import User

    return db.get(User, sched.created_by_user_id) if sched.created_by_user_id else None


def apply_schedule(db: Session, sched: PriceSchedule, *, now: Optional[datetime] = None) -> None:
    """Write the frozen prices (rechecked against today's policy for the one who scheduled it). No commit."""
    now = now or _now()
    user = _creator(db, sched)
    items = []
    errors = []
    for item in sched.items or []:
        product = db.get(Product, _uuid(item.get("productId")))
        target = _uuid(item.get("targetId"))
        if product is None or target is None:
            continue
        new = item.get("newPrice")
        if user is not None and new is not None:
            policy = PP.effective(db, shop_id=sched.shop_id)
            refused = PP.refusal(policy, actor=PP.actor_level(db, user, product), product=product,
                                 level=item.get("level"), new_price=new)
            if refused is not None:
                errors.append(f"{product.name}: {refused.detail.get('message')}")
                items.append({**item, "skipped": True})
                continue
        old = _write(db, product=product, level=item.get("level"), target_id=target,
                     price=Decimal(str(new)) if new is not None else None, user=user, source="schedule")
        items.append({**item, "oldPrice": float(old) if old is not None else None})
    sched.items = items
    sched.status = "applied"
    sched.applied_at = now
    sched.error = "; ".join(errors)[:500] or None


def revert_schedule(db: Session, sched: PriceSchedule, *, now: Optional[datetime] = None) -> None:
    """Each price back to what its level had — unless it no longer is the scheduled one (left, noted). No commit."""
    now = now or _now()
    user = _creator(db, sched)
    kept = []
    for item in sched.items or []:
        if item.get("skipped"):
            continue
        product = db.get(Product, _uuid(item.get("productId")))
        target = _uuid(item.get("targetId"))
        if product is None or target is None:
            continue
        current = _current(db, product, item.get("level"), target)
        if PP.money(current) != PP.money(item.get("newPrice")):
            kept.append(product.name)
            continue
        old = item.get("oldPrice")
        _write(db, product=product, level=item.get("level"), target_id=target,
               price=Decimal(str(old)) if old is not None else None, user=user, source="schedule")
    sched.status = "reverted"
    sched.reverted_at = now
    if kept:
        note = "לא הוחזרו (שונו בינתיים): " + ", ".join(sorted(set(kept)))
        sched.error = ((sched.error + "; ") if sched.error else "") + note
        sched.error = sched.error[:500]


def _current(db: Session, product: Product, level: str, target: uuid.UUID) -> Optional[Decimal]:
    if level == PP.SHOP:
        row = db.query(ShopProductOverride).filter_by(shop_id=target, global_product_id=product.id).first()
    else:
        row = db.query(AreaProductOverride).filter_by(area_id=target, product_id=product.id).first()
    return row.price if row is not None else None


def _locked(query, db: Session):
    bind = db.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") == "postgresql":
        return query.with_for_update(skip_locked=True)
    return query


def run_due(db: Session, *, now: Optional[datetime] = None) -> Dict[str, int]:
    """Apply the schedules whose time came and put back those whose end came. Commits per schedule."""
    now = now or _now()
    applied = reverted = 0
    due = _locked(
        db.query(PriceSchedule).filter(PriceSchedule.status == "pending", PriceSchedule.starts_at <= now), db
    ).all()
    for sched in due:
        try:
            apply_schedule(db, sched, now=now)
            db.commit()
            notify(db, sched.shop_id)
            applied += 1
        except Exception as exc:  # noqa: BLE001 - one bad schedule never stops the others
            db.rollback()
            logger.exception("price schedule %s failed", sched.id)
            sched.status = "failed"
            sched.error = str(exc)[:500]
            db.commit()
    ending = _locked(
        db.query(PriceSchedule).filter(
            PriceSchedule.status == "applied", PriceSchedule.ends_at.isnot(None), PriceSchedule.ends_at <= now
        ),
        db,
    ).all()
    for sched in ending:
        try:
            revert_schedule(db, sched, now=now)
            db.commit()
            notify(db, sched.shop_id)
            reverted += 1
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.exception("price schedule %s revert failed", sched.id)
            sched.error = (f"ההחזרה נכשלה: {exc}")[:500]
            db.commit()
    return {"applied": applied, "reverted": reverted}


def schedule_out(sched: PriceSchedule) -> Dict[str, Any]:
    return {
        "id": str(sched.id),
        "shopId": str(sched.shop_id),
        "label": sched.label,
        "startsAt": _aware(sched.starts_at).isoformat() if sched.starts_at else None,
        "endsAt": _aware(sched.ends_at).isoformat() if sched.ends_at else None,
        "status": sched.status,
        "spec": sched.spec,
        "itemCount": len(sched.items or []),
        "items": sched.items or [],
        "createdBy": sched.created_by_name,
        "appliedAt": _aware(sched.applied_at).isoformat() if sched.applied_at else None,
        "revertedAt": _aware(sched.reverted_at).isoformat() if sched.reverted_at else None,
        "error": sched.error,
    }


# ── The pass ─────────────────────────────────────────────────────────────────

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def run_once(session_factory: Callable[[], Session]) -> Dict[str, int]:
    db = session_factory()
    try:
        return run_due(db)
    except Exception:  # noqa: BLE001 - keep the loop alive
        db.rollback()
        logger.exception("price schedules pass failed")
        return {"applied": 0, "reverted": 0}
    finally:
        db.close()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return

    def loop() -> None:
        while not _stop.wait(interval):
            run_once(session_factory)

    _stop.clear()
    _thread = threading.Thread(target=loop, name="price-schedules", daemon=True)
    _thread.start()


def stop_background_worker() -> None:
    _stop.set()
