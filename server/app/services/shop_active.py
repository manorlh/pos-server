"""
"סניף לא פעיל" — a shop turned off locks all its devices (P:/specs/shop-code-and-inactive.md §3).

Owner: "אפשר להפוך לסניף לא פעיל, והפיכה כזו גם תנעל את המכשירים (הרשאה לסופר אדמין)".
Approved 13.10.2026 with the spec's recommendations: a locked till may still close its shift
and Z with a manager code (1); a manager code at the till does **not** lift a shop lock — only
the super admin turning the shop back on in the cloud does (2); KDS screens and customer
displays lock too (4).

**Who.** The super admin only (`set_active`): the "סניף פעיל" switch is shown to everyone,
and anyone else changing `isActive` is answered 403 `shop_active_super_admin_only`. Every
change needs a reason (422 `shop_active_reason_required`) and is logged — who, when, why —
in `shop_active_log` ("כל שינוי נרשם, עם מי, מתי והסיבה").

**The devices** read `shopActive` beside `trainingMode`, in the same three places: `GET
/machines/me`, the heartbeat's reply and the settings sync (`GET /sync/{m}/settings`: a
top-level `shopActive` on every answer, "unchanged" included, and `settings.shopActive` on a
full / delta pull). A change moves the shop's settings watermark and sends the shop's devices
a realtime `settings` signal (reason `shop_active`, `NOTIFY_REASON`), so a connected device
locks at once and one that was offline on its next pull. The lock itself is the device's: it
takes effect once the sale in progress ends, never in the middle of a payment.

**What the cloud does not block.** Documents, shifts and Zs a device of an inactive shop
uploads are accepted as ever — a sale made before the lock must never be lost ("מסמך שנוצר
בקופה לפני הנעילה חייב להתקבל"). What the cloud refuses is **pairing** a device into an
inactive shop (`refuse_pairing`, 409 `shop_inactive`): a code made for it, a code redeemed
for it, a QR claim, a replacement unit, and assigning or moving a machine into it.

Turning a shop back on releases its devices; a till locked by hand ("נעל קופה") stays locked —
the two locks are separate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.shop import Shop
from app.models.shop_active_log import ShopActiveLog
from app.models.user import User, UserRole

#: 409 `detail.code` when a device would be paired into an inactive shop.
SHOP_INACTIVE = "shop_inactive"
#: 403 `detail.code` when someone other than the super admin changes `isActive`.
SUPER_ADMIN_ONLY = "shop_active_super_admin_only"
#: 422 `detail.code` when the change comes without a reason.
REASON_REQUIRED = "shop_active_reason_required"

#: The realtime `settings` signal's reason when the flag moves.
NOTIFY_REASON = "shop_active"

REASON_MAX_LEN = 500

INACTIVE_MESSAGE = "הסניף אינו פעיל — אי אפשר לצמד אליו מכשיר. רק מנהל-על יכול להפעיל אותו מחדש."
SUPER_ADMIN_MESSAGE = "רק מנהל-על יכול להפוך סניף לפעיל או ללא פעיל."
REASON_MESSAGE = "יש לכתוב סיבה לשינוי מצב הסניף — היא נרשמת ביומן."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def is_active(shop: Any) -> bool:
    """
    `shopActive` as the devices read it. A device in no shop (not assigned yet) is not
    locked; only a shop whose flag is false is.
    """
    return shop is None or getattr(shop, "is_active", True) is not False


def refuse_pairing(shop: Any) -> None:
    """409 `shop_inactive` (Hebrew `message`) when a device would be paired into [shop]."""
    if shop is not None and not is_active(shop):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": SHOP_INACTIVE, "message": INACTIVE_MESSAGE, "shopId": str(shop.id)},
        )


def clean_reason(reason: Any) -> Optional[str]:
    text = str(reason).strip() if reason is not None else ""
    return text[:REASON_MAX_LEN] or None


def check_change(user: User, reason: Any) -> str:
    """The super admin only (403), with a reason (422). Returns the reason, cleaned."""
    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": SUPER_ADMIN_ONLY, "message": SUPER_ADMIN_MESSAGE},
        )
    text = clean_reason(reason)
    if text is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": REASON_REQUIRED, "message": REASON_MESSAGE},
        )
    return text


def log(db: Session, shop: Shop, user: Optional[User], active: bool, reason: Optional[str]) -> None:
    db.add(ShopActiveLog(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        active=bool(active),
        reason=reason,
        user_id=getattr(user, "id", None),
        created_at=_now(),
    ))


def set_active(db: Session, shop: Shop, user: User, active: bool, reason: Any) -> bool:
    """
    Turn [shop] off or back on: the super admin only, with a reason; logged, and the shop's
    settings watermark moves so every device's next pull carries `shopActive`. Returns
    whether anything changed — the same state again changes nothing and needs no reason.
    The caller commits, then sends the signal (`notify`).
    """
    active = bool(active)
    if bool(shop.is_active) == active:
        return False
    text = check_change(user, reason)
    now = _now()
    shop.is_active = active
    shop.settings_updated_at = now
    log(db, shop, user, active, text)
    db.flush()
    return True


def notify(db: Session, shop_id: Any) -> None:
    """After the commit: every device of the shop pulls its settings, so it locks or unlocks."""
    from app.services.settings_notify import notify_machines_for_shop_settings

    notify_machines_for_shop_settings(db, str(shop_id), reason=NOTIFY_REASON)


def log_out(db: Session, shop: Shop, *, limit: int = 50) -> List[Dict[str, Any]]:
    """The shop's log, newest first: `{id, active, reason, at, userId, userName}`."""
    rows = (
        db.query(ShopActiveLog)
        .filter(ShopActiveLog.shop_id == shop.id)
        .order_by(ShopActiveLog.created_at.desc())
        .limit(limit)
        .all()
    )
    user_ids = {r.user_id for r in rows if r.user_id is not None}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    out = []
    for r in rows:
        who = users.get(r.user_id)
        out.append({
            "id": str(r.id),
            "active": bool(r.active),
            "reason": r.reason,
            "at": _iso(r.created_at),
            "userId": str(r.user_id) if r.user_id is not None else None,
            "userName": (who.username or who.email) if who is not None else None,
        })
    return out
