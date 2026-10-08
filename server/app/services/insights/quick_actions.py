"""
Quick actions from the insights ("פעולות מהירות", docs/SPEC_INSIGHTS.md §10.2): one tap on a
product that barely sells, or a till that stands out, and the tills act on it.

* **Quick message** ("הודעה מהירה") — a line to the cashiers of the target's tills, through
  the till messages (`app/services/till_messages.py`) as a **banner** (the non-blocking
  specials strip; its chip adds the product to the order), ending by itself. Who may: the
  till messages' own rule (the machine-admin roles, the target theirs).
* **Quick promotion** ("מבצע מהיר") — a promotion on the one product, through the
  promotions (`app/services/promotions.py`), which the tills pull on their next sync and
  which ends by itself (dates and an hour window, as any promotion). Who may: the
  promotions' own rule (the catalog roles, every scope entry theirs). The offer is checked
  against the product's unit cost when it is known: **no unit is ever sold below cost**.

The target is a company, shop, area or till (the till messages' levels) — or a report event
(docs/SPEC_EVENTS.md), which means its tills, each named. Every action is a row of
`insight_quick_actions` (written with the message / promotion, in the same transaction) and
a line in the log: the audit, and the anchor of its result — the product's sales on the
tills it reached since it started, against the same hours before it (and a week before).
"""
from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from app.models.insight_quick_action import QUICK_ACTION_TARGETS, InsightQuickAction
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.promotion import TransactionPromotion
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.services import promotions as P
from app.services import till_messages as TM
from app.services.reports import ReportWindow, _is_refund_condition, build_scoped_transaction_query

from .analytics import to_agorot

logger = logging.getLogger("app.audit.insights")

#: The till messages' writers (`get_current_machine_admin`).
MESSAGE_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER})
#: The promotions' writers.
PROMOTION_ROLES = P.WRITE_ROLES

DURATION_KINDS = ("end_of_day", "hours", "until")
MAX_HOURS = 12
MAX_UNTIL_DAYS = 30
TEXT_MAX = 500
DEFAULT_COLOR = "amber"
SOURCES = ("slow", "dead", "declining", "anomaly", "manual")

#: The offers a quick promotion makes.
OFFER_KINDS = ("percent", "second_half", "fixed_price")
PERCENT_CHOICES = (10, 15, 20)
#: Without a known cost.
DEFAULT_PERCENT = 10
#: With a cost, keep at least this share of the margin.
KEEP_MARGIN_SHARE = 0.5
DEFAULT_VAT_RATE = 0.18

#: 4xx details.
NOT_FOUND = "quick_action_not_found"
PRODUCT_NOT_FOUND = "quick_action_product_not_found"
NO_TILLS = "quick_action_no_tills"
BAD_TARGET = "quick_action_bad_target"
BAD_DURATION = "quick_action_bad_duration"
BAD_TEXT = "quick_action_bad_text"
BAD_OFFER = "quick_promo_bad_offer"
BELOW_COST = "quick_promo_below_cost"
FORBIDDEN = "quick_action_forbidden"
ALREADY_CANCELLED = "quick_action_cancelled"


def _now() -> datetime:
    """The wall clock; a test freezes it here."""
    return datetime.now(timezone.utc)


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def _zone(db: Session, tenant_id):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    name = resolve_report_timezone(db, tenant_id, None)
    return name, _load_zoneinfo(name)


def _who(user: User) -> Optional[str]:
    return (getattr(user, "username", None) or getattr(user, "email", None) or None)


# ── The target ────────────────────────────────────────────────────────────────


@dataclass
class Target:
    level: str
    id: uuid.UUID
    name: Optional[str]
    machines: List[POSMachine]
    shop_ids: Set[uuid.UUID] = field(default_factory=set)
    event: Any = None

    def promotion_scopes(self) -> List[Dict[str, str]]:
        """An event's tills one by one (a promotion has no event level); else the target itself."""
        if self.level == "event":
            return [{"type": "machine", "id": str(m.id)} for m in self.machines]
        return [{"type": self.level, "id": str(self.id)}]


def resolve_target(db: Session, user: User, tenant_id, level: str, target_id) -> Target:
    """
    The target, when the user may act on it (the till messages' rule; an event: its shop's
    access), and its active tills the user can see. 404 unknown, 403 not theirs.
    """
    if level not in QUICK_ACTION_TARGETS or _uuid(target_id) is None:
        raise _bad(BAD_TARGET)
    if level == "event":
        from app.services.report_events.crud import load_event

        event = load_event(db, user, tenant_id, target_id)
        ids = [row.machine_id for row in event.machines]
        visible = TM.visible_machines_query(db, user, tenant_id)
        machines = visible.filter(POSMachine.id.in_(ids)).all() if (visible is not None and ids) else []
        return Target("event", event.id, event.name, machines, {event.shop_id}, event)
    entity = TM.resolve_target(db, user, tenant_id, level, target_id)
    machines = TM.target_machines(db, user, tenant_id, level, target_id)
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    return Target(level, entity.id, getattr(entity, "name", None), machines, shop_ids)


# ── When it ends ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Window:
    """When an action ends, and the same as a promotion's dates and hours."""

    ends_at: datetime
    valid_from: date
    valid_to: date
    start_time: Optional[str]
    end_time: Optional[str]


def _business_day(local: datetime, day_start_hour: int) -> date:
    return (local - timedelta(hours=day_start_hour)).date()


def resolve_window(
    now: datetime,
    tz,
    duration: Dict[str, Any],
    *,
    day_start_hour: int = 4,
) -> Window:
    """
    `{"kind": "end_of_day"}` — to the end of today's business day (04:00 the next morning);
    `{"kind": "hours", "hours": 1..12}`; `{"kind": "until", "date": "YYYY-MM-DD"}` — whole
    days to the end of that business day (today .. today + 30). Pure.
    """
    kind = (duration or {}).get("kind") or "end_of_day"
    if kind not in DURATION_KINDS:
        raise _bad(BAD_DURATION)
    local = now.astimezone(tz)
    today = _business_day(local, day_start_hour)
    if kind == "until":
        try:
            last = date.fromisoformat(str(duration.get("date")))
        except (TypeError, ValueError):
            raise _bad(BAD_DURATION)
        if not today <= last <= today + timedelta(days=MAX_UNTIL_DAYS):
            raise _bad(BAD_DURATION)
        ends = datetime.combine(last + timedelta(days=1), dtime(day_start_hour), tzinfo=tz)
        return Window(ends.astimezone(timezone.utc), local.date(), last, None, None)
    if kind == "hours":
        try:
            hours = int(duration.get("hours"))
        except (TypeError, ValueError):
            raise _bad(BAD_DURATION)
        if not 1 <= hours <= MAX_HOURS:
            raise _bad(BAD_DURATION)
        # Real hours, added in UTC: wall-clock arithmetic on an aware local time would make
        # "4 hours" five across the night the clocks go back.
        ends_local = (now.astimezone(timezone.utc) + timedelta(hours=hours)).astimezone(tz)
    else:
        ends_local = datetime.combine(today + timedelta(days=1), dtime(day_start_hour), tzinfo=tz)
    start_hhmm = local.strftime("%H:%M")
    end_hhmm = ends_local.astimezone(tz).strftime("%H:%M")
    if end_hhmm == start_hhmm:
        # A full turn of the clock would read as "no time" — stop a minute short.
        end_hhmm = (ends_local - timedelta(minutes=1)).astimezone(tz).strftime("%H:%M")
    # An hour window that crosses midnight belongs to the day it started (the promotions'
    # rule), so both dates are the local calendar day it starts on.
    return Window(ends_local.astimezone(timezone.utc), local.date(), local.date(), start_hhmm, end_hhmm)


# ── The product, its price and cost ───────────────────────────────────────────


def global_product(db: Session, tenant_id, product_id) -> Product:
    """The tenant's product, as its global product (a till's local copy resolves to it)."""
    ident = _uuid(product_id)
    product = db.get(Product, ident) if ident is not None else None
    if product is None or product.tenant_id != tenant_id:
        raise _bad(PRODUCT_NOT_FOUND, status.HTTP_404_NOT_FOUND)
    if product.global_product_id is not None:
        product = db.get(Product, product.global_product_id) or product
    return product


@dataclass(frozen=True)
class Pricing:
    """Money in agorot: `price` and `min_price` incl. VAT; `cost` excl. VAT (None: unknown)."""

    price: int
    min_price: int
    cost: Optional[int]
    vat_rate: float = DEFAULT_VAT_RATE

    @property
    def floor(self) -> Optional[int]:
        """The lowest unit price (incl. VAT) that is not below cost."""
        if self.cost is None:
            return None
        return int(math.ceil(self.cost * (1 + self.vat_rate) - 1e-9))

    @property
    def margin_pct(self) -> Optional[float]:
        """What the cheapest shop keeps of its price, before any promotion (excl. VAT)."""
        if self.floor is None or self.min_price <= 0:
            return None
        return (1 - self.floor / self.min_price) * 100


def product_pricing(db: Session, tenant_id, product: Product, shop_ids: Set[uuid.UUID]) -> Pricing:
    """
    The product's price — a single shop's own price when the target is one shop with one —
    the lowest price among the target's shops (a promotion must hold everywhere it runs),
    its unit cost and its VAT rate.
    """
    base = to_agorot(product.price)
    prices = {base}
    reference = base
    if shop_ids:
        overrides = {
            r.shop_id: to_agorot(r.price)
            for r in db.query(ShopProductOverride.shop_id, ShopProductOverride.price).filter(
                ShopProductOverride.global_product_id == product.id,
                ShopProductOverride.shop_id.in_(list(shop_ids)),
                ShopProductOverride.price.isnot(None),
            )
        }
        prices = {overrides.get(s, base) for s in shop_ids}
        if len(shop_ids) == 1:
            reference = next(iter(prices))
    cost_row = db.query(ProductCost.cost).filter(ProductCost.tenant_id == tenant_id, ProductCost.product_id == product.id).first()
    rate = float(product.tax_rate) / 100.0 if product.tax_rate is not None else DEFAULT_VAT_RATE
    return Pricing(
        price=reference,
        min_price=min(prices) if prices else reference,
        cost=to_agorot(cost_row[0]) if cost_row is not None else None,
        vat_rate=rate,
    )


def check_offer(kind: str, value: Optional[float], pricing: Pricing) -> Dict[str, Any]:
    """
    What an offer does to the price, and whether it keeps every unit at or above cost. Pure.

    * `percent` (`value` 1–90): every unit `value`% off.
    * `second_half`: the second of two at 50% off — the cheapest unit sold is half price,
      the pair on average 25% off.
    * `fixed_price` (`value` agorot, below the price): each unit at that price — taken off
      as an amount, so the lowest-priced shop is checked at its own price less that amount.
    """
    if kind not in OFFER_KINDS:
        raise _bad(BAD_OFFER)
    price, low = pricing.price, pricing.min_price
    if kind == "percent":
        if value is None or not 1 <= float(value) <= 90:
            raise _bad(BAD_OFFER)
        pct = float(value)
        new_price = round(price * (1 - pct / 100))
        lowest = round(low * (1 - pct / 100))
        effective = pct
    elif kind == "second_half":
        pct = 50.0
        new_price = round(price * 0.75)
        lowest = round(low * 0.5)
        effective = 25.0
    else:
        if value is None or not 0 < float(value) < price:
            raise _bad(BAD_OFFER)
        new_price = int(round(float(value)))
        lowest = low - (price - new_price)
        effective = (1 - new_price / price) * 100 if price else 0.0
    floor = pricing.floor
    below = floor is not None and lowest < floor
    return {
        "kind": kind,
        "value": None if kind == "second_half" else (int(round(float(value))) if kind == "fixed_price" else float(value)),
        "newPrice": new_price,
        "lowestUnitPrice": lowest,
        "effectivePct": round(effective, 1),
        "belowCost": below,
        "floor": floor,
        "marginAfterPct": None if floor is None or lowest <= 0 else round((1 - floor / lowest) * 100, 1),
    }


def suggest_offer(pricing: Pricing) -> Optional[Dict[str, Any]]:
    """
    The suggested offer: without a cost, 10% off. With one, the largest of 20 / 15 / 10%
    that keeps at least half the margin; else the largest of 10 / 5% still above cost; else
    nothing (the price is too close to cost for a promotion). Pure.
    """
    if pricing.cost is None:
        return check_offer("percent", DEFAULT_PERCENT, pricing)
    margin = pricing.margin_pct
    if margin is None or margin <= 0:
        return None
    for pct in sorted(PERCENT_CHOICES, reverse=True):
        if pct <= margin * KEEP_MARGIN_SHARE:
            return check_offer("percent", pct, pricing)
    for pct in (10, 5):
        offer = check_offer("percent", pct, pricing)
        if not offer["belowCost"]:
            return offer
    return None


def offer_options(pricing: Pricing) -> List[Dict[str, Any]]:
    """The menu the dialog shows: 10 / 15 / 20%, the second at half price, a fixed price."""
    out = [check_offer("percent", pct, pricing) for pct in PERCENT_CHOICES]
    out.append(check_offer("second_half", None, pricing))
    fixed = int(math.ceil(pricing.price * 0.85 / 100.0)) * 100  # 15% off, up to a whole shekel
    if pricing.floor is not None:
        fixed = max(fixed, int(math.ceil(pricing.floor / 100.0)) * 100)
    if 0 < fixed < pricing.price:
        out.append(check_offer("fixed_price", fixed, pricing))
    return out


def promotion_config(product_id: uuid.UUID, offer: Dict[str, Any], pricing: Pricing) -> Tuple[str, Dict[str, Any]]:
    """The promotion type and config (the promotions' schema) for an offer on one product."""
    target = {"productIds": [str(product_id)]}
    if offer["kind"] == "percent":
        return "discount", {"target": target, "discountKind": "percent", "discountValue": offer["value"]}
    if offer["kind"] == "second_half":
        return "buy_x_get_y", {"target": target, "buyQuantity": 1, "getQuantity": 1, "getDiscountPercent": 50}
    amount = (pricing.price - offer["newPrice"]) / 100.0
    return "discount", {"target": target, "discountKind": "amount", "discountValue": round(amount, 2)}


def offer_label(offer: Dict[str, Any]) -> str:
    if offer["kind"] == "percent":
        return f"{offer['value']:g}% הנחה"
    if offer["kind"] == "second_half":
        return "השני ב-50%"
    return f"₪{offer['newPrice'] / 100:g} ליחידה"


# ── Writes ────────────────────────────────────────────────────────────────────


def _action(
    db: Session, user: User, tenant_id, *, kind: str, product: Optional[Product], target: Target,
    params: Dict[str, Any], source: Optional[str], starts_at: datetime, ends_at: Optional[datetime],
    till_message_ids: Optional[List[str]] = None, promotion_id: Optional[uuid.UUID] = None,
) -> InsightQuickAction:
    action = InsightQuickAction(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        kind=kind,
        product_id=product.id if product is not None else None,
        product_name=product.name if product is not None else None,
        target_level=target.level,
        target_id=target.id,
        target_name=(target.name or None),
        machine_ids=[str(m.id) for m in target.machines],
        till_message_ids=till_message_ids,
        promotion_id=promotion_id,
        params=params,
        source=source if source in SOURCES else "manual",
        starts_at=starts_at,
        ends_at=ends_at,
        created_by_user_id=user.id,
        created_by_name=_who(user),
        created_at=starts_at,
    )
    db.add(action)
    db.flush()
    logger.info(
        "insights quick %s %s by user %s: product=%s target=%s:%s tills=%d ends=%s params=%s",
        kind, action.id, user.id, action.product_id, target.level, target.id, len(target.machines),
        ends_at.isoformat() if ends_at else None, params,
    )
    return action


def send_quick_message(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> Tuple[InsightQuickAction, List[POSMachine]]:
    """
    A banner (or, asked for, a full-screen message) to the target's tills, ending by itself.
    `body`: text, targetLevel, targetId, duration, productId?, display?, color?, source?.
    Returns the action and the tills to wake.
    """
    if user.role not in MESSAGE_ROLES:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)
    text = (body.get("text") or "").strip()
    if not text or len(text) > TEXT_MAX:
        raise _bad(BAD_TEXT)
    display = body.get("display") or "banner"
    if display not in ("banner", "fullscreen"):
        raise _bad(BAD_TEXT)
    product = global_product(db, tenant_id, body["productId"]) if body.get("productId") else None
    target = resolve_target(db, user, tenant_id, body.get("targetLevel"), body.get("targetId"))
    if not target.machines:
        raise _bad(NO_TILLS)
    now = _now()
    tz_name, tz = _zone(db, tenant_id)
    window = resolve_window(now, tz, body.get("duration") or {}, day_start_hour=_day_start_hour(body))
    banner = display == "banner"
    color = (body.get("color") or DEFAULT_COLOR) if banner else None

    def send(level: str, target_id) -> str:
        message = TM.send_message(
            db, user, tenant_id, title=None, body=text, target_level=level, target_id=target_id,
            expires_at=window.ends_at, display=display,
            product_id=product.id if (banner and product is not None) else None, color=color,
        )
        return str(message.id)

    if target.level == "event":
        ids = [send("machine", m.id) for m in target.machines]
    else:
        ids = [send(target.level, target.id)]
    action = _action(
        db, user, tenant_id, kind="message", product=product, target=target,
        params={"text": text, "display": display, "color": color, "duration": body.get("duration") or {"kind": "end_of_day"}},
        source=body.get("source"), starts_at=now, ends_at=window.ends_at, till_message_ids=ids,
    )
    return action, target.machines


def _day_start_hour(body: Dict[str, Any]) -> int:
    value = body.get("dayStartHour")
    return value if isinstance(value, int) and 0 <= value <= 8 else 4


def create_quick_promotion(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> InsightQuickAction:
    """
    A promotion on one product for the target's tills, ending by itself, never below cost.
    `body`: productId, targetLevel, targetId, offer {kind, value}, duration, source?.
    """
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    product = global_product(db, tenant_id, body.get("productId"))
    target = resolve_target(db, user, tenant_id, body.get("targetLevel"), body.get("targetId"))
    if not target.machines:
        raise _bad(NO_TILLS)
    pricing = product_pricing(db, tenant_id, product, target.shop_ids)
    raw_offer = body.get("offer") or {}
    offer = check_offer(raw_offer.get("kind"), raw_offer.get("value"), pricing)
    if offer["belowCost"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={
            "code": BELOW_COST, "floor": offer["floor"], "lowestUnitPrice": offer["lowestUnitPrice"],
        })
    now = _now()
    _tz_name, tz = _zone(db, tenant_id)
    window = resolve_window(now, tz, body.get("duration") or {}, day_start_hour=_day_start_hour(body))
    promo_type, config = promotion_config(product.id, offer, pricing)
    label = offer_label(offer)
    from app.schemas.promotion import PromotionIn

    promotion_in = PromotionIn.model_validate({
        "name": f"מבצע מהיר · {product.name} · {label}"[:120],
        "description": f"הופעל מהתובנות ע״י {_who(user) or '—'}",
        "type": promo_type,
        "config": config,
        "scopes": target.promotion_scopes(),
        "validFrom": window.valid_from.isoformat(),
        "validTo": window.valid_to.isoformat(),
        "startTime": window.start_time,
        "endTime": window.end_time,
        "priority": 0,
    })
    promotion = P.create_promotion(db, user, tenant_id, promotion_in)
    return _action(
        db, user, tenant_id, kind="promotion", product=product, target=target,
        params={
            "offer": offer, "label": label, "price": pricing.price, "minPrice": pricing.min_price,
            "cost": pricing.cost, "vatRate": pricing.vat_rate, "duration": body.get("duration") or {"kind": "end_of_day"},
            "promotionName": promotion.name, "validFrom": window.valid_from.isoformat(),
            "validTo": window.valid_to.isoformat(), "startTime": window.start_time, "endTime": window.end_time,
        },
        source=body.get("source"), starts_at=now, ends_at=window.ends_at, promotion_id=promotion.id,
    )


def get_action(db: Session, tenant_id, action_id, kind: str) -> InsightQuickAction:
    ident = _uuid(action_id)
    action = (
        db.query(InsightQuickAction)
        .filter(InsightQuickAction.id == ident, InsightQuickAction.tenant_id == tenant_id, InsightQuickAction.kind == kind)
        .first()
        if ident is not None
        else None
    )
    if action is None:
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return action


def cancel_quick_message(db: Session, user: User, tenant_id, action_id) -> Tuple[InsightQuickAction, List[POSMachine]]:
    """Take the banner(s) down now; idempotent. The till messages' own manage rule applies."""
    if user.role not in MESSAGE_ROLES:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)
    action = get_action(db, tenant_id, action_id, "message")
    machines: List[POSMachine] = []
    for message_id in action.till_message_ids or []:
        try:
            message = TM.get_message(db, tenant_id, message_id)
        except HTTPException:
            continue
        TM.cancel_message(db, user, tenant_id, message)
        machines += TM.unacknowledged_machines(db, message)
    _cancelled(db, user, action)
    return action, machines


def cancel_quick_promotion(db: Session, user: User, tenant_id, action_id) -> InsightQuickAction:
    """"בטל מבצע": pause the promotion now (kept for the reports); idempotent."""
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    action = get_action(db, tenant_id, action_id, "promotion")
    if action.promotion_id is not None:
        try:
            promotion = P.get_promotion(db, tenant_id, action.promotion_id)
        except HTTPException:
            promotion = None  # deleted on the promotions page since: nothing left to stop
        if promotion is not None:
            P.set_paused(db, user, tenant_id, promotion, True)
    _cancelled(db, user, action)
    return action


def _cancelled(db: Session, user: User, action: InsightQuickAction) -> None:
    if action.cancelled_at is None:
        action.cancelled_at = _now()
        action.cancelled_by_user_id = user.id
        db.flush()
        logger.info("insights quick %s %s cancelled by user %s", action.kind, action.id, user.id)


# ── Reads: the suggestion, the list and the result ────────────────────────────


def promotion_suggestion(db: Session, user: User, tenant_id, product_id, target_level=None, target_id=None) -> Dict[str, Any]:
    """The product's price and cost, the offers, the suggested one, and whether the user may create it."""
    product = global_product(db, tenant_id, product_id)
    shop_ids: Set[uuid.UUID] = set()
    if target_level and target_id:
        shop_ids = resolve_target(db, user, tenant_id, target_level, target_id).shop_ids
    pricing = product_pricing(db, tenant_id, product, shop_ids)
    suggested = suggest_offer(pricing)
    return {
        "product": {"id": str(product.id), "name": product.name},
        "price": pricing.price,
        "minPrice": pricing.min_price,
        "cost": pricing.cost,
        "vatRate": pricing.vat_rate,
        "floor": pricing.floor,
        "marginPct": None if pricing.margin_pct is None else round(pricing.margin_pct, 1),
        "options": offer_options(pricing),
        "suggested": suggested,
        "canCreate": user.role in PROMOTION_ROLES,
        "maxHours": MAX_HOURS,
        "maxUntilDays": MAX_UNTIL_DAYS,
    }


def _status(action: InsightQuickAction, now: datetime) -> str:
    if action.cancelled_at is not None:
        return "cancelled"
    ends = _utc(action.ends_at)
    if ends is not None and ends <= now:
        return "ended"
    return "active"


def _product_sums(db: Session, user: User, tenant_id, action: InsightQuickAction, windows: Dict[str, Tuple[datetime, datetime]]) -> Dict[str, Dict[str, Any]]:
    """The product's units and net on the action's tills, per window — one grouped query."""
    empty = {name: {"units": 0.0, "net": 0} for name in windows}
    ids = [_uuid(m) for m in action.machine_ids or [] if _uuid(m) is not None]
    if not ids or action.product_id is None:
        return empty
    start = min(s for s, _ in windows.values())
    end = max(e for _, e in windows.values())
    if end <= start:
        return empty
    window = ReportWindow(from_date=start.date(), to_date=end.date(), from_hour=None, to_hour=None, tz_name="UTC", start=start, end=end)
    query = build_scoped_transaction_query(db, user, tenant_id, window)
    if query is None:
        return empty
    tx = query.filter(Transaction.machine_id.in_(ids)).with_entities(
        Transaction.id.label("tx_id"),
        Transaction.created_at.label("at"),
        case((_is_refund_condition(), True), else_=False).label("refund"),
    ).subquery()
    key = func.coalesce(Product.global_product_id, TransactionItem.product_id)
    disc = func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0) + func.coalesce(TransactionItem.voucher_discount, 0)
    columns = []
    for name, (w_start, w_end) in windows.items():
        inside = and_(tx.c.at >= w_start, tx.c.at < w_end)
        sale, ref = and_(inside, tx.c.refund.is_(False)), and_(inside, tx.c.refund.is_(True))
        columns += [
            func.coalesce(func.sum(case((sale, TransactionItem.quantity), (ref, -TransactionItem.quantity), else_=0)), 0).label(f"{name}__units"),
            func.coalesce(func.sum(case((sale, TransactionItem.total_price - disc), (ref, -TransactionItem.total_price), else_=0)), 0).label(f"{name}__net"),
        ]
    row = (
        db.query(*columns)
        .select_from(TransactionItem)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
        .filter(key == action.product_id)
        .one()
    )
    return {
        name: {"units": round(float(getattr(row, f"{name}__units") or 0), 3), "net": to_agorot(getattr(row, f"{name}__net"))}
        for name in windows
    }


def _change(a: float, b: float) -> Optional[float]:
    if b == 0:
        return None if a == 0 else None
    return round((a - b) / abs(b) * 100, 1)


def action_result(db: Session, user: User, tenant_id, action: InsightQuickAction, now: datetime) -> Optional[Dict[str, Any]]:
    """
    The product's sales on the action's tills since it started (to its end, its cancellation
    or now) against the same length of time just before it, and the same hours a week before.
    `dataArrived`: a document of those tills has been received since it started.
    """
    start = _utc(action.starts_at)
    end = min(x for x in (now, _utc(action.ends_at), _utc(action.cancelled_at)) if x is not None)
    span = max(end - start, timedelta(0))
    ids = [_uuid(m) for m in action.machine_ids or [] if _uuid(m) is not None]
    last_doc = None
    if ids:
        last_doc = (
            db.query(func.max(Transaction.created_at))
            .filter(Transaction.tenant_id == tenant_id, Transaction.machine_id.in_(ids), Transaction.created_at >= start)
            .scalar()
        )
    out: Dict[str, Any] = {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "hours": round(span.total_seconds() / 3600, 1),
        "dataArrived": last_doc is not None,
        "lastDocumentAt": _utc(last_doc).isoformat() if last_doc is not None else None,
    }
    if action.product_id is None or span.total_seconds() <= 0:
        return out
    sums = _product_sums(db, user, tenant_id, action, {
        "since": (start, end),
        "before": (start - span, start),
        "lastWeek": (start - timedelta(days=7), end - timedelta(days=7)),
    })
    out.update(sums)
    out["changePct"] = _change(sums["since"]["units"], sums["before"]["units"])
    out["changePctLastWeek"] = _change(sums["since"]["units"], sums["lastWeek"]["units"])
    if action.kind == "promotion" and action.promotion_id is not None:
        applied = (
            db.query(func.coalesce(func.sum(TransactionPromotion.applications), 0), func.coalesce(func.sum(TransactionPromotion.discount_amount), 0))
            .join(Transaction, Transaction.id == TransactionPromotion.transaction_id)
            .filter(TransactionPromotion.promotion_id == action.promotion_id, Transaction.tenant_id == tenant_id)
            .one()
        )
        out["applications"] = int(applied[0] or 0)
        out["discount"] = to_agorot(applied[1])
    return out


def action_out(action: InsightQuickAction, now: datetime, result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "id": str(action.id),
        "kind": action.kind,
        "status": _status(action, now),
        "productId": str(action.product_id) if action.product_id else None,
        "productName": action.product_name,
        "target": {"level": action.target_level, "id": str(action.target_id), "name": action.target_name},
        "tills": len(action.machine_ids or []),
        "machineIds": list(action.machine_ids or []),
        "promotionId": str(action.promotion_id) if action.promotion_id else None,
        "tillMessageIds": list(action.till_message_ids or []),
        "params": action.params or {},
        "source": action.source,
        "startsAt": _utc(action.starts_at).isoformat(),
        "endsAt": _utc(action.ends_at).isoformat() if action.ends_at else None,
        "cancelledAt": _utc(action.cancelled_at).isoformat() if action.cancelled_at else None,
        "createdBy": action.created_by_name,
        "result": result,
    }


def list_quick_actions(
    db: Session, user: User, tenant_id, *, product_id=None, limit: int = 30, with_results: bool = True,
) -> Dict[str, Any]:
    """The recent actions that reached a till the user can see, newest first, with their result."""
    now = _now()
    query = db.query(InsightQuickAction).filter(InsightQuickAction.tenant_id == tenant_id)
    if product_id is not None:
        query = query.filter(InsightQuickAction.product_id == _uuid(product_id))
    visible = TM.visible_machines_query(db, user, tenant_id)
    seen = {str(r[0]) for r in visible.with_entities(POSMachine.id).all()} if visible is not None else set()
    items = []
    for action in query.order_by(InsightQuickAction.created_at.desc()).limit(limit * 3).all():
        if not seen.intersection(action.machine_ids or []):
            continue
        result = action_result(db, user, tenant_id, action, now) if with_results else None
        items.append(action_out(action, now, result))
        if len(items) >= limit:
            break
    return {
        "items": items,
        "generatedAt": now.isoformat(),
        "canMessage": user.role in MESSAGE_ROLES,
        "canPromote": user.role in PROMOTION_ROLES,
    }
