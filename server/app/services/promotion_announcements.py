"""
"שלח הודעה לעובדים" — a promotion announces itself to the cashiers of the tills it runs on.

Optional on every promotion (created, edited or activated on the promotions page, a quick
promotion, an ad-hoc one or a happy hour): a till message, as a **banner** (the
non-blocking specials strip), to the promotion's scope — one message per scope entry
(a company, shop, area or till), every top-level company for a promotion of the whole
organization:

* **at the start** — once, when the promotion starts: now if it is already running, else
  scheduled for its first occurrence (the till messages go out lazily, on the first fetch
  after they come due). It shows until that occurrence ends (an hour window), or to the
  promotion's last day, or — open-ended — until the promotion is paused or deleted.
* **at the end** (optional, "המבצע הסתיים") — once, when the last occurrence ends, for two hours.

The settings and the messages' ids live on the promotion (`promotions.announcement`):
`{"enabled", "text", "endEnabled", "endText", "startMessageIds", "endMessageIds",
"startAt", "endAt"}`. Every change re-plans: what has not gone out yet is withdrawn and
scheduled again from the promotion as it is now; a start that went out is not repeated.
Pausing, switching it off or deleting the promotion takes a live banner down too.

Who may: the till messages' writers, and — for a dashboard user with sections — the
"הודעות לקופות" section at edit, as on its own page. Someone else editing the promotion
never sends; withdrawing is always allowed.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.promotion import Promotion
from app.models.till_message import TillMessage
from app.models.user import User, UserRole
from app.services import till_messages as TM
from app.services.promotion_schedule import Schedule, current_or_next, final_end

logger = logging.getLogger("app.audit.promotions")

TEXT_MAX = 500
START_COLOR = "green"
END_COLOR = "dark"
#: How long the "it ended" banner shows.
END_SHOWS_FOR = timedelta(hours=2)
MESSAGE_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER})

FORBIDDEN = "promotion_announce_forbidden"
BAD_TEXT = "promotion_announce_bad_text"

SETTING_KEYS = ("enabled", "text", "endEnabled", "endText")


def _now() -> datetime:
    """The wall clock; a test freezes it here."""
    return datetime.now(timezone.utc)


def _uuid(value) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def clean_settings(raw: Any) -> Optional[Dict[str, Any]]:
    """The body's `announcement` (enabled, text, endEnabled, endText), validated; None: not sent."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=BAD_TEXT)
    out = {"enabled": bool(raw.get("enabled")), "endEnabled": bool(raw.get("endEnabled"))}
    for key in ("text", "endText"):
        value = raw.get(key)
        if value is None:
            out[key] = None
            continue
        if not isinstance(value, str) or len(value.strip()) > TEXT_MAX:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=BAD_TEXT)
        out[key] = value.strip() or None
    return out


#: The promotions page needs "הודעות לקופות" at edit; a quick action, "פעולות מהירות" (or that).
PAGE_SECTIONS = ("till_messages",)
QUICK_SECTIONS = ("quick_actions", "till_messages")


def may_message(db: Session, user: User, sections: Sequence[str] = PAGE_SECTIONS) -> bool:
    if user is None or user.role not in MESSAGE_ROLES:
        return False
    from app.services import dashboard_access

    access = dashboard_access.effective_access(db, user)
    return any(access.allows(s, "edit") for s in sections)


def require_messaging(db: Session, user: User, sections: Sequence[str] = PAGE_SECTIONS) -> None:
    if user is None or user.role not in MESSAGE_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)
    if not may_message(db, user, sections):
        from app.services import dashboard_access

        raise dashboard_access._refusal(sections[0], "edit")


# ── The words ─────────────────────────────────────────────────────────────────

WEEKDAY_SHORT = ("א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳")


def _offer_words(promotion: Promotion) -> str:
    c = promotion.config or {}
    kind = promotion.promo_type
    if kind == "discount":
        v = c.get("discountValue")
        return f"{v:g}% הנחה" if c.get("discountKind") == "percent" else f"₪{float(v or 0):g} הנחה ליחידה"
    if kind == "buy_x_get_y":
        pct = float(c.get("getDiscountPercent") or 100)
        get = "חינם" if pct >= 100 else f"ב-{pct:g}% הנחה"
        return f"קנו {c.get('buyQuantity', 1)} וקבלו {c.get('getQuantity', 1)} {get}"
    if kind == "bundle_price":
        return f"{c.get('quantity')} ב-₪{float(c.get('price') or 0):g}"
    if kind == "combo":
        return f"קומבו ב-₪{float(c.get('price') or 0):g}"
    return promotion.name


def _hours_words(promotion: Promotion) -> str:
    parts = []
    days = promotion.weekdays or []
    if days and len(days) < 7:
        parts.append("ימים " + ", ".join(WEEKDAY_SHORT[d] for d in sorted(days)))
    if promotion.start_time and promotion.end_time:
        parts.append(f"{promotion.start_time}–{promotion.end_time}")
    if promotion.valid_to:
        parts.append(f"עד {promotion.valid_to.strftime('%d/%m')}")
    return " · ".join(parts)


def default_text(db: Session, promotion: Promotion) -> str:
    """"מבצע: <שם> — <הצעה> על <מוצרים> · <שעות>" from the promotion itself."""
    ids = []
    target = (promotion.config or {}).get("target") or {}
    for raw in target.get("productIds") or []:
        ident = _uuid(raw)
        if ident is not None:
            ids.append(ident)
    names = [r[0] for r in db.query(Product.name).filter(Product.id.in_(ids)).limit(3).all()] if ids else []
    what = ", ".join(names) if names else ("כל המוצרים" if target.get("all") else "")
    text = f"מבצע: {promotion.name} — {_offer_words(promotion)}"
    if what:
        text += f" על {what}"
    hours = _hours_words(promotion)
    if hours:
        text += f" · {hours}"
    return text[:TEXT_MAX]


def default_end_text(promotion: Promotion) -> str:
    return f"המבצע הסתיים: {promotion.name}"[:TEXT_MAX]


# ── Where it goes ─────────────────────────────────────────────────────────────


def targets(db: Session, promotion: Promotion) -> List[Tuple[str, str]]:
    """The promotion's scope entries, as till message targets; the whole org: its top companies."""
    scopes = [
        (str(entry.get("type")), str(entry.get("id")))
        for entry in (promotion.scopes or [])
        if isinstance(entry, dict) and entry.get("type") in ("company", "shop", "area", "machine") and _uuid(entry.get("id"))
    ]
    if scopes:
        return scopes
    rows = db.query(Company.id).filter(Company.tenant_id == promotion.tenant_id, Company.parent_company_id.is_(None)).all()
    return [("company", str(r[0])) for r in rows]


def _banner_product(promotion: Promotion) -> Optional[uuid.UUID]:
    """The banner's chip adds the product to the order — only when the promotion is about one."""
    target = (promotion.config or {}).get("target") or {}
    ids = target.get("productIds") or []
    if len(ids) == 1 and not target.get("all") and not target.get("categoryIds"):
        return _uuid(ids[0])
    return None


def _messages(db: Session, tenant_id, ids: Optional[Sequence[str]]) -> List[TillMessage]:
    wanted = [i for i in (_uuid(x) for x in ids or []) if i is not None]
    if not wanted:
        return []
    return db.query(TillMessage).filter(TillMessage.tenant_id == tenant_id, TillMessage.id.in_(wanted)).all()


def _take_down(db: Session, user: User, tenant_id, message: TillMessage) -> List[POSMachine]:
    """Cancel a message (as its sender's rule allows; a promotion's editor always may withdraw)."""
    if message.cancelled_at is not None:
        return []
    now = TM._now()
    message.cancelled_at = now
    if TM.is_live(message, now):
        message.expires_at = now
    db.flush()
    return TM.unacknowledged_machines(db, message) if message.sent_at is not None else []


def _send(db: Session, user: User, promotion: Promotion, *, text: str, color: str,
          send_at: Optional[datetime], expires_at: Optional[datetime]) -> Tuple[List[str], List[POSMachine]]:
    ids: List[str] = []
    woken: List[POSMachine] = []
    product_id = _banner_product(promotion)
    for level, target_id in targets(db, promotion):
        try:
            message = TM.send_message(
                db, user, promotion.tenant_id, title=None, body=text, target_level=level, target_id=target_id,
                expires_at=expires_at, schedule_kind="scheduled" if send_at is not None else "now",
                send_at=send_at, display="banner", product_id=product_id, color=color,
            )
        except HTTPException as refused:
            # A scope entry with no till now (or no longer the user's): nothing to announce there.
            logger.info("promotion %s announcement to %s:%s skipped (%s)", promotion.id, level, target_id, refused.detail)
            continue
        ids.append(str(message.id))
        if send_at is None:
            woken += TM.unacknowledged_machines(db, message)
    return ids, woken


def plan(db: Session, user: User, promotion: Promotion, *, settings: Optional[Dict[str, Any]] = None,
         now: Optional[datetime] = None, sections: Sequence[str] = PAGE_SECTIONS) -> List[POSMachine]:
    """
    (Re)plan the promotion's announcements from what it is now, after `settings` (the body's,
    None: keep). Returns the tills to wake for what went out now.
    """
    now = now or _now()
    state = dict(promotion.announcement or {})
    if settings is not None:
        if settings.get("enabled") and not state.get("enabled"):
            require_messaging(db, user, sections)
        state.update(settings)
    if not state.get("enabled") and not state.get("startMessageIds") and not state.get("endMessageIds"):
        if settings is not None:
            promotion.announcement = state
        return []
    tenant_id = promotion.tenant_id
    woken: List[POSMachine] = []

    starts = _messages(db, tenant_id, state.get("startMessageIds"))
    went_out = [m for m in starts if m.sent_at is not None and m.cancelled_at is None]
    for m in starts:
        if m.sent_at is None:
            _take_down(db, user, tenant_id, m)  # not gone out yet: it is planned again below
    for m in _messages(db, tenant_id, state.get("endMessageIds")):
        if m.sent_at is None:
            _take_down(db, user, tenant_id, m)
    state["startMessageIds"] = [str(m.id) for m in went_out]
    state["endMessageIds"] = []
    state["endAt"] = None

    running = state.get("enabled") and not promotion.is_paused
    if not running:
        for m in went_out:
            woken += _take_down(db, user, tenant_id, m)
        state["startMessageIds"] = []
        state["startAt"] = None
        promotion.announcement = state
        return woken

    if not may_message(db, user, sections):
        promotion.announcement = state
        return woken

    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    tz = _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
    schedule = Schedule.of(promotion)
    last = final_end(schedule, tz)
    if not went_out:
        occurrence = current_or_next(schedule, tz, now)
        if occurrence is not None:
            begins, ends = occurrence
            send_at = begins if begins > now else None
            hour_window = bool(promotion.start_time and promotion.end_time)
            expires = ends if hour_window else last
            ids, sent_now = _send(db, user, promotion, text=state.get("text") or default_text(db, promotion),
                                  color=START_COLOR, send_at=send_at, expires_at=expires)
            state["startMessageIds"] = ids
            state["startAt"] = (send_at or now).isoformat() if ids else None
            woken += sent_now
        else:
            state["startAt"] = None
    if state.get("endEnabled") and last is not None and last > now:
        ids, _ = _send(db, user, promotion, text=state.get("endText") or default_end_text(promotion),
                       color=END_COLOR, send_at=last, expires_at=last + END_SHOWS_FOR)
        state["endMessageIds"] = ids
        state["endAt"] = last.isoformat() if ids else None
    promotion.announcement = state
    db.flush()
    logger.info("promotion %s announcements planned by user %s: start=%s end=%s", promotion.id, user.id,
                state.get("startAt"), state.get("endAt"))
    return woken


def withdraw(db: Session, user: User, promotion: Promotion) -> List[POSMachine]:
    """The promotion goes (deleted): every announcement of it comes down."""
    woken: List[POSMachine] = []
    state = dict(promotion.announcement or {})
    for key in ("startMessageIds", "endMessageIds"):
        for m in _messages(db, promotion.tenant_id, state.get(key)):
            woken += _take_down(db, user, promotion.tenant_id, m)
    return woken


def settings_out(promotion: Promotion) -> Dict[str, Any]:
    state = promotion.announcement or {}
    return {
        "enabled": bool(state.get("enabled")),
        "text": state.get("text"),
        "endEnabled": bool(state.get("endEnabled")),
        "endText": state.get("endText"),
        "startAt": state.get("startAt"),
        "endAt": state.get("endAt"),
        "messages": len(state.get("startMessageIds") or []) + len(state.get("endMessageIds") or []),
    }
