"""
"שליטה מרחוק בקיוסקים" — what the dashboard's live panel changes on the kiosks now, without
touching their settings:

* **A banner** ("הודעה על המסך") on one kiosk's screens while it keeps selling, until a time or
  until removed (`kiosk_devices.banner_*`).
* **Quick hides** — a product or a category hidden on every kiosk of a shop, "הגריל סגור", until
  a time or until shown again (`kiosk_quick_hides`).

Both reach every kiosk the same way, with no change on any of them: `overlay` adds them to the
effective config (app/services/kiosk_config.py `effective_config`) — the banner as one more
`messages` entry of kind "banner" (with its `endsAt`), the hides to `catalog.hiddenProducts` /
`catalog.hiddenCategories` — which the Android, web and Windows kiosks already apply. The config's
version changes with them, so each kiosk takes them on its next kiosk sync (every ~15 s), and an
end is applied by the server on the first sync after it (the banner's `endsAt` also by the kiosk's
own clock).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.kiosk_live import KIOSK_HIDE_KINDS, KioskQuickHide

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


# ── Quick hides ──────────────────────────────────────────────────────────────


def _in_force(now: datetime):
    return (KioskQuickHide.cleared_at.is_(None)) & (or_(KioskQuickHide.until.is_(None), KioskQuickHide.until > now))


def active_hides(db: Session, shop_ids: Sequence[Any], now: Optional[datetime] = None) -> List[KioskQuickHide]:
    now = now or utc_now()
    ids = [s for s in shop_ids if s is not None]
    if not ids:
        return []
    return (
        db.query(KioskQuickHide)
        .filter(KioskQuickHide.shop_id.in_(ids), _in_force(now))
        .order_by(KioskQuickHide.created_at.desc())
        .all()
    )


def hide_out(row: KioskQuickHide, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    until = _aware(row.until)
    return {
        "id": str(row.id),
        "shopId": str(row.shop_id),
        "kind": row.kind,
        "itemId": str(row.item_id),
        "itemName": row.item_name,
        "until": _iso(row.until),
        "secondsLeft": int((until - now).total_seconds()) if until is not None else None,
        "note": row.note,
        "by": row.created_by_name,
        "createdAt": _iso(row.created_at),
    }


def hide(
    db: Session, *, tenant_id: Any, shop_id: Any, kind: str, item_id: Any, until: Optional[datetime],
    note: Optional[str], user: Any = None, now: Optional[datetime] = None,
) -> KioskQuickHide:
    """Hide a product / category on the shop's kiosks (an active hide of the same item is updated). The caller commits."""
    from app.models.category import Category
    from app.models.product import Product

    now = now or utc_now()
    if kind not in KIOSK_HIDE_KINDS:
        raise _bad("invalid_kind", "סוג לא מוכר")
    until = _aware(until)
    if until is not None and until <= now:
        raise _bad("until_passed", "שעת הסיום כבר עברה")
    model = Product if kind == "product" else Category
    try:
        ident = uuid.UUID(str(item_id))
    except (TypeError, ValueError):
        raise _bad("item_not_found", "הפריט לא נמצא", status.HTTP_404_NOT_FOUND)
    item = db.get(model, ident)
    if item is None or str(item.tenant_id) != str(tenant_id):
        raise _bad("item_not_found", "הפריט לא נמצא", status.HTTP_404_NOT_FOUND)
    who = getattr(user, "username", None) or getattr(user, "email", None)
    row = (
        db.query(KioskQuickHide)
        .filter(KioskQuickHide.shop_id == shop_id, KioskQuickHide.kind == kind, KioskQuickHide.item_id == ident, _in_force(now))
        .first()
    )
    if row is None:
        row = KioskQuickHide(
            id=uuid.uuid4(), tenant_id=tenant_id, shop_id=shop_id, kind=kind, item_id=ident,
            item_name=getattr(item, "name", None), created_by_user_id=getattr(user, "id", None),
            created_by_name=(who or None) and who[:200], created_at=now,
        )
        db.add(row)
    row.until = until
    row.note = (note or "").strip()[:200] or None
    row.updated_at = now
    db.flush()
    return row


def show(db: Session, row: KioskQuickHide, *, user: Any = None, now: Optional[datetime] = None) -> KioskQuickHide:
    now = now or utc_now()
    if row.cleared_at is None:
        who = getattr(user, "username", None) or getattr(user, "email", None)
        row.cleared_at = now
        row.cleared_by_name = (who or None) and who[:200]
        row.updated_at = now
        db.flush()
    return row


# ── What the kiosks get ──────────────────────────────────────────────────────


def overlay(db: Session, machine: Any, cfg: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """The effective config with the shop's quick hides and the kiosk's banner in (a new dict)."""
    now = now or utc_now()
    shop_id = getattr(machine, "shop_id", None)
    try:
        hides = active_hides(db, [shop_id], now) if shop_id is not None else []
        device = db.get(KioskDevice, machine.id) if getattr(machine, "id", None) is not None else None
    except Exception:  # noqa: BLE001 - a missing table (an older test world) changes nothing
        return cfg
    banner = device is not None and banner_active(device, now)
    if not hides and not banner:
        return cfg
    out = dict(cfg)
    if hides:
        catalog = dict(out.get("catalog") or {})
        for kind, key in (("product", "hiddenProducts"), ("category", "hiddenCategories")):
            extra = [str(h.item_id) for h in hides if h.kind == kind]
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
