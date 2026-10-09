"""
"שליטה מרחוק בקיוסקים" — what the dashboard's live panel changes on the kiosks now, without
touching their settings:

* **A banner** ("הודעה על המסך") on one kiosk's screens while it keeps selling, until a time or
  until removed (`kiosk_devices.banner_*`).
* **Quick hides** — a product or a category hidden on every kiosk of a shop, "הגריל סגור", until
  a time or until shown again. Since specs/item-blocks-targets.md a quick hide IS a block
  (`sold_out_marks`, app/services/sold_out.py): shop level, target "kiosks", kind "חסום", look
  "hide" — one list with every other block. Its rows from before (`kiosk_quick_hides`) were copied
  by the migration under the same ids and are no longer read. The panel lists every hand block in
  force of the shop that reaches its kiosks.

Both reach every kiosk the same way, with no change on any of them: `overlay` adds them to the
effective config (app/services/kiosk_config.py `effective_config`) — the banner as one more
`messages` entry of kind "banner" (with its `endsAt`), and every block in force reaching this kiosk
that asks to hide (`sold_out.kiosk_hidden`) to `catalog.hiddenProducts` / `catalog.hiddenCategories`
— which the Android, web and Windows kiosks already apply. The config's version changes with them,
so each kiosk takes them on its next kiosk sync (every ~15 s), and an end is applied by the server
on the first sync after it (the banner's `endsAt` also by the kiosk's own clock).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.kiosk_live import KIOSK_HIDE_KINDS
from app.models.sold_out import SoldOutMark

BANNER_ID = "live-banner"
BANNER_SCREENS = ["attract", "service", "catalog", "cart", "pay", "success"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ── The banner ───────────────────────────────────────────────────────────────


def banner_active(device: KioskDevice, now: datetime) -> bool:
    if not device.banner_message:
        return False
    until = _aware(device.banner_until)
    return until is None or now < until


def banner_out(device: KioskDevice, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    now = now or utc_now()
    if not banner_active(device, now):
        return None
    return {
        "message": device.banner_message,
        "since": _iso(device.banner_at),
        "by": device.banner_by,
        "until": _iso(device.banner_until),
    }


def set_banner(device: KioskDevice, message: Optional[str], until: Optional[datetime], by: Optional[str], now: Optional[datetime] = None) -> None:
    """Set (or, with no message, remove) the kiosk's banner. The caller commits."""
    now = now or utc_now()
    text = (message or "").strip()[:300]
    if not text:
        device.banner_message = None
        device.banner_at = None
        device.banner_by = None
        device.banner_until = None
        return
    until = _aware(until)
    if until is not None and until <= now:
        raise _bad("until_passed", "שעת הסיום כבר עברה")
    device.banner_message = text
    device.banner_at = now
    device.banner_by = (by or None) and by[:200]
    device.banner_until = until


# ── Quick hides: blocks that reach the kiosks ─────────────────────────────────


def active_hides(db: Session, shop_ids: Sequence[Any], now: Optional[datetime] = None) -> List[SoldOutMark]:
    """The hand blocks in force of these shops that reach their kiosks (target all or kiosks), newest first."""
    from app.services import sold_out

    now = now or utc_now()
    ids = [s for s in shop_ids if s is not None]
    if not ids or not sold_out.tables_ready(db):
        return []
    marks = (
        db.query(SoldOutMark)
        .filter(SoldOutMark.shop_id.in_(ids), SoldOutMark.source == "manual", sold_out.in_force_filter(now))
        .order_by(SoldOutMark.created_at.desc())
        .all()
    )
    return [m for m in marks if sold_out.target_of(m) in ("all", "kiosks")]


def hides_out(db: Session, rows: Sequence[SoldOutMark], now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The panel's rows: the old shape (kind = product / category, itemId, itemName) and the block's own."""
    from app.services import sold_out

    now = now or utc_now()
    out = []
    for view in sold_out.views(db, list(rows), now):
        is_category = view.get("itemType") == "category"
        out.append({
            **view,
            "kind": "category" if is_category else "product",
            "itemId": view["categoryId"] if is_category else view["productId"],
            "itemName": view.get("itemName"),
            "blockKind": view.get("kind"),
        })
    return out


def hide_out(db: Session, row: SoldOutMark, now: Optional[datetime] = None) -> Dict[str, Any]:
    return hides_out(db, [row], now)[0]


def hide(
    db: Session, *, tenant_id: Any, shop_id: Any, kind: str, item_id: Any, until: Optional[datetime],
    note: Optional[str], user: Any = None, now: Optional[datetime] = None,
) -> SoldOutMark:
    """
    "מוסתר בקיוסקים": hide a product / category on the shop's kiosks — a shop-level, kiosks-only
    "חסום" that hides (an active one of the same item is updated). The caller commits.
    """
    from app.services import sold_out

    now = now or utc_now()
    if kind not in KIOSK_HIDE_KINDS:
        raise _bad("invalid_kind", "סוג לא מוכר")
    try:
        ident = uuid.UUID(str(item_id))
    except (TypeError, ValueError):
        raise _bad("item_not_found", "הפריט לא נמצא", status.HTTP_404_NOT_FOUND)
    try:
        if kind == "product":
            product, category = sold_out.global_product(db, ident, tenant_id), None
        else:
            product, category = None, sold_out.tenant_category(db, ident, tenant_id)
    except HTTPException:
        raise _bad("item_not_found", "הפריט לא נמצא", status.HTTP_404_NOT_FOUND)
    target = sold_out.resolve_target(db, "shop", shop_id, tenant_id)
    return sold_out.block(
        db, tenant_id=tenant_id, product=product, category=category, target=target, kind="blocked",
        until=until, note=note, user=user, now=now, reach="kiosks", display="hide", origin="dashboard",
    )


def show(db: Session, row: SoldOutMark, *, user: Any = None, now: Optional[datetime] = None) -> SoldOutMark:
    """"הצג שוב": the block removed (the caller commits)."""
    from app.services import sold_out

    return sold_out.clear(db, row, user=user, now=now)


# ── What the kiosks get ──────────────────────────────────────────────────────


def overlay(db: Session, machine: Any, cfg: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """The effective config with the shop's quick hides and the kiosk's banner in (a new dict)."""
    from app.services import sold_out

    now = now or utc_now()
    try:
        hidden_products, hidden_categories = sold_out.kiosk_hidden(db, machine, now)
        device = db.get(KioskDevice, machine.id) if getattr(machine, "id", None) is not None else None
    except Exception:  # noqa: BLE001 - a missing table (an older test world) changes nothing
        return cfg
    banner = device is not None and banner_active(device, now)
    hides = hidden_products or hidden_categories
    if not hides and not banner:
        return cfg
    out = dict(cfg)
    if hides:
        catalog = dict(out.get("catalog") or {})
        for extra, key in ((hidden_products, "hiddenProducts"), (hidden_categories, "hiddenCategories")):
            if extra:
                have = list(catalog.get(key) or [])
                catalog[key] = have + [i for i in extra if i not in have]
        out["catalog"] = catalog
    if banner:
        messages = [m for m in (out.get("messages") or []) if not (isinstance(m, dict) and m.get("id") == BANNER_ID)]
        messages.insert(0, {
            "id": BANNER_ID,
            "kind": "banner",
            "enabled": True,
            "title": "",
            "body": device.banner_message,
            "image": None,
            "screens": list(BANNER_SCREENS),
            "style": "warning",
            "productId": None,
            "startsAt": None,
            "endsAt": _iso(device.banner_until),
        })
        out["messages"] = messages
    return out
