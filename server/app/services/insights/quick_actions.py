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

from app.models.category import Category
from app.models.insight_quick_action import QUICK_ACTION_TARGETS, InsightQuickAction
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.product_cost import ProductCost
from app.models.promotion import Promotion, TransactionPromotion
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.services import promotion_announcements as PA
from app.services import promotion_schedule as PS
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
SOURCES = ("slow", "dead", "declining", "anomaly", "adhoc", "happy_hour", "manual")
#: A happy hour runs this many weeks unless told (1–12).
HAPPY_HOUR_WEEKS = 4
MAX_HAPPY_HOUR_WEEKS = 12

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
CATEGORY_NOT_FOUND = "quick_action_category_not_found"
BAD_SUBJECT = "quick_promo_bad_subject"
BAD_SCHEDULE = "quick_promo_bad_schedule"
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


# ── What a promotion is on: a product, a category, the whole basket ───────────


@dataclass
class Subject:
    """"מבצע מזדמן": one product, a category (and its sub-categories), or everything."""

    kind: str  # product | category | all
    product: Optional[Product] = None
    category: Optional[Category] = None

    @property
    def name(self) -> str:
        if self.product is not None:
            return self.product.name
        if self.category is not None:
            return self.category.name
        return "כל המוצרים"

    def group(self) -> Dict[str, Any]:
        """The promotion's target group (the promotions' schema)."""
        if self.product is not None:
            return {"productIds": [str(self.product.id)]}
        if self.category is not None:
            return {"categoryIds": [str(self.category.id)]}
        return {"all": True}


def subject_of(db: Session, tenant_id, body: Dict[str, Any]) -> Subject:
    """`productId`, else `categoryId`, else `all: true`."""
    if body.get("productId"):
        return Subject("product", product=global_product(db, tenant_id, body["productId"]))
    if body.get("categoryId"):
        ident = _uuid(body["categoryId"])
        category = db.get(Category, ident) if ident is not None else None
        if category is None or category.tenant_id != tenant_id:
            raise _bad(CATEGORY_NOT_FOUND, status.HTTP_404_NOT_FOUND)
        return Subject("category", category=category)
    if body.get("all") is True:
        return Subject("all")
    raise _bad(BAD_SUBJECT)


def _category_ids(db: Session, tenant_id, root: uuid.UUID) -> List[uuid.UUID]:
    """The category and every sub-category under it (as the tills expand it)."""
    children: Dict[uuid.UUID, List[uuid.UUID]] = {}
    for cid, parent in db.query(Category.id, Category.parent_id).filter(Category.tenant_id == tenant_id).all():
        if parent is not None:
            children.setdefault(parent, []).append(cid)
    out, stack = [], [root]
    while stack:
        current = stack.pop()
        if current in out:
            continue
        out.append(current)
        stack.extend(children.get(current, []))
    return out


@dataclass(frozen=True)
class Item:
    product_id: uuid.UUID
    name: str
    pricing: Pricing


def group_items(db: Session, tenant_id, subject: Subject, shop_ids: Set[uuid.UUID]) -> List[Item]:
    """
    The products to check an offer on. A product: itself (cost known or not). A category or
    the whole basket: its global products **with a known cost** — one without cannot be
    shown to be below it — priced at the lowest price among the target's shops.
    """
    if subject.product is not None:
        return [Item(subject.product.id, subject.product.name, product_pricing(db, tenant_id, subject.product, shop_ids))]
    query = (
        db.query(Product, ProductCost.cost)
        .join(ProductCost, and_(ProductCost.product_id == Product.id, ProductCost.tenant_id == tenant_id))
        .filter(
            Product.tenant_id == tenant_id,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
            Product.is_general.is_(False),
        )
    )
    if subject.category is not None:
        query = query.filter(Product.category_id.in_(_category_ids(db, tenant_id, subject.category.id)))
    rows = query.all()
    if not rows:
        return []
    overrides: Dict[Tuple[uuid.UUID, uuid.UUID], int] = {}
    if shop_ids:
        for r in db.query(ShopProductOverride.global_product_id, ShopProductOverride.shop_id, ShopProductOverride.price).filter(
            ShopProductOverride.global_product_id.in_([p.id for p, _ in rows]),
            ShopProductOverride.shop_id.in_(list(shop_ids)),
            ShopProductOverride.price.isnot(None),
        ):
            overrides[(r.global_product_id, r.shop_id)] = to_agorot(r.price)
    items = []
    for product, cost in rows:
        base = to_agorot(product.price)
        prices = [overrides.get((product.id, s), base) for s in shop_ids] or [base]
        rate = float(product.tax_rate) / 100.0 if product.tax_rate is not None else DEFAULT_VAT_RATE
        items.append(Item(product.id, product.name, Pricing(price=base, min_price=min(prices), cost=to_agorot(cost), vat_rate=rate)))
    return items


def check_group(subject: Subject, kind: str, value, items: Sequence[Item]) -> Dict[str, Any]:
    """An offer over the subject's products: a product's own check, or every costed product's."""
    if subject.product is not None:
        return check_offer(kind, value, items[0].pricing)
    if kind == "fixed_price":
        raise _bad(BAD_OFFER)  # one price for a whole group means nothing
    probe = Pricing(price=10_000, min_price=10_000, cost=None)
    head = check_offer(kind, value, probe)
    offenders = []
    for item in items:
        checked = check_offer(kind, value, item.pricing)
        if checked["belowCost"]:
            offenders.append({"productId": str(item.product_id), "name": item.name, "floor": checked["floor"],
                              "lowestUnitPrice": checked["lowestUnitPrice"]})
    return {
        "kind": kind,
        "value": head["value"],
        "effectivePct": head["effectivePct"],
        "belowCost": bool(offenders),
        "offenders": offenders[:5],
        "offendersCount": len(offenders),
        "checked": len(items),
    }


def suggest_group(subject: Subject, items: Sequence[Item]) -> Optional[Dict[str, Any]]:
    """A product: `suggest_offer`. A group: the largest % that keeps half of every costed margin."""
    if subject.product is not None:
        return suggest_offer(items[0].pricing)
    if not items:
        return check_group(subject, "percent", DEFAULT_PERCENT, items)
    margins = [i.pricing.margin_pct for i in items]
    if any(m is None or m <= 0 for m in margins):
        return None
    for pct in sorted(PERCENT_CHOICES, reverse=True):
        if all(pct <= m * KEEP_MARGIN_SHARE for m in margins):
            return check_group(subject, "percent", pct, items)
    for pct in (10, 5):
        offer = check_group(subject, "percent", pct, items)
        if not offer["belowCost"]:
            return offer
    return None


def group_options(subject: Subject, items: Sequence[Item]) -> List[Dict[str, Any]]:
    if subject.product is not None:
        return offer_options(items[0].pricing)
    return [check_group(subject, "percent", pct, items) for pct in PERCENT_CHOICES] + [check_group(subject, "second_half", None, items)]


def promotion_body(subject: Subject, offer: Dict[str, Any], items: Sequence[Item]) -> Tuple[str, Dict[str, Any]]:
    """The promotion type and config for an offer on the subject."""
    if subject.product is not None:
        return promotion_config(subject.product.id, offer, items[0].pricing)
    target = subject.group()
    if offer["kind"] == "percent":
        return "discount", {"target": target, "discountKind": "percent", "discountValue": offer["value"]}
    return "buy_x_get_y", {"target": target, "buyQuantity": 1, "getQuantity": 1, "getDiscountPercent": 50}


def _below_cost(offer: Dict[str, Any]) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={
        "code": BELOW_COST, "floor": offer.get("floor"), "lowestUnitPrice": offer.get("lowestUnitPrice"),
        "offenders": offer.get("offenders"),
    })


# ── Writes ────────────────────────────────────────────────────────────────────


def _action(
    db: Session, user: User, tenant_id, *, kind: str, product: Optional[Product], target: Target,
    params: Dict[str, Any], source: Optional[str], starts_at: datetime, ends_at: Optional[datetime],
    till_message_ids: Optional[List[str]] = None, promotion_id: Optional[uuid.UUID] = None,
    category: Optional[Category] = None,
) -> InsightQuickAction:
    action = InsightQuickAction(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        kind=kind,
        product_id=product.id if product is not None else None,
        product_name=product.name if product is not None else None,
        category_id=category.id if category is not None else None,
        category_name=category.name if category is not None else None,
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


def _create_promotion(db: Session, user: User, tenant_id, fields: Dict[str, Any]) -> Promotion:
    from app.schemas.promotion import PromotionIn

    return P.create_promotion(db, user, tenant_id, PromotionIn.model_validate(fields))


def create_quick_promotion(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> Tuple[InsightQuickAction, List[POSMachine]]:
    """
    A promotion for the target's tills, ending by itself, never below cost: on a product
    (a slow mover's "מבצע מהיר"), or — "מבצע מזדמן" — on any product, a category or the
    whole basket. `body`: productId | categoryId | all, targetLevel, targetId, offer {kind,
    value}, duration, announce? {enabled, text, endEnabled, endText}, source?.
    Returns the action and the tills an announcement reached now.
    """
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    subject = subject_of(db, tenant_id, body)
    target = resolve_target(db, user, tenant_id, body.get("targetLevel"), body.get("targetId"))
    if not target.machines:
        raise _bad(NO_TILLS)
    announce = PA.clean_settings(body.get("announce"))
    if announce and announce.get("enabled"):
        PA.require_messaging(db, user)
    items = group_items(db, tenant_id, subject, target.shop_ids)
    raw_offer = body.get("offer") or {}
    offer = check_group(subject, raw_offer.get("kind"), raw_offer.get("value"), items)
    if offer["belowCost"]:
        raise _below_cost(offer)
    now = _now()
    _tz_name, tz = _zone(db, tenant_id)
    window = resolve_window(now, tz, body.get("duration") or {}, day_start_hour=_day_start_hour(body))
    promo_type, config = promotion_body(subject, offer, items)
    label = offer_label(offer) if subject.product is not None or offer["kind"] != "fixed_price" else ""
    title = "מבצע מהיר" if body.get("source") in ("slow", "dead", "declining") else "מבצע מזדמן"
    promotion = _create_promotion(db, user, tenant_id, {
        "name": f"{title} · {subject.name} · {label}"[:120],
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
    woken = PA.plan(db, user, promotion, settings=announce, now=now) if announce else []
    pricing = items[0].pricing if subject.product is not None else None
    action = _action(
        db, user, tenant_id, kind="promotion", product=subject.product, category=subject.category, target=target,
        params={
            "subject": subject.kind, "offer": offer, "label": label,
            "price": pricing.price if pricing else None, "minPrice": pricing.min_price if pricing else None,
            "cost": pricing.cost if pricing else None, "vatRate": pricing.vat_rate if pricing else None,
            "duration": body.get("duration") or {"kind": "end_of_day"},
            "promotionName": promotion.name, "validFrom": window.valid_from.isoformat(),
            "validTo": window.valid_to.isoformat(), "startTime": window.start_time, "endTime": window.end_time,
            "announce": PA.settings_out(promotion) if announce else None,
        },
        source=body.get("source") or "adhoc", starts_at=now, ends_at=window.ends_at, promotion_id=promotion.id,
    )
    return action, woken


# ── Happy hour (docs/SPEC_INSIGHTS.md §10.3) ──────────────────────────────────

WEEKDAY_SHORT = ("א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳")


def _days_label(days: Sequence[int]) -> str:
    return ", ".join(WEEKDAY_SHORT[d] for d in sorted(set(days)))


def _hour_windows(db: Session, tenant_id, now: datetime) -> List[Promotion]:
    """The tenant's running and coming promotions that have an hour window (other happy hours)."""
    from app.services.promotions import tenant_today

    today = tenant_today(db, tenant_id)
    return (
        db.query(Promotion)
        .filter(
            Promotion.tenant_id == tenant_id,
            Promotion.is_paused.is_(False),
            Promotion.start_time.isnot(None),
            (Promotion.valid_to.is_(None)) | (Promotion.valid_to >= today),
        )
        .all()
    )


def schedule_overlaps(db: Session, tenant_id, schedule: PS.Schedule, tz, now: datetime) -> List[Dict[str, Any]]:
    """The promotions with an hour window that run at the same time as `schedule`."""
    out = []
    for promotion in _hour_windows(db, tenant_id, now):
        hit = PS.overlaps(schedule, PS.Schedule.of(promotion), tz, now=now)
        if hit is not None:
            out.append({"id": str(promotion.id), "name": promotion.name, "at": hit[0].isoformat(),
                        "weekdays": promotion.weekdays, "startTime": promotion.start_time, "endTime": promotion.end_time})
    return out


def happy_hour_suggestions(ctx, heatmap: Dict[str, Any]) -> Dict[str, Any]:
    """
    The weakest weekday × hour slots of the heat map (each ≥ 40% under its hour's usual, over
    open days only) as happy-hour windows: one weekday, an hour window, four weeks from
    today. Hours after midnight run on the calendar day they fall on (the promotions' rule),
    so a weak 01:00 of Friday's business day is Saturday 01:00. Each says which other
    hour-window promotions it would overlap.
    """
    tz = PS_zone(ctx.clock.tz_name)
    now = ctx.clock.now
    today = now.astimezone(tz).date()
    spans = []
    for slot in heatmap.get("weak") or []:
        lo, hi = int(slot["fromHour"]), int(slot["toHour"])
        if hi <= lo:
            hi += 24
        spans.append((int(slot["weekday"]), lo, hi, slot))
    out = []
    merged = PS.merge_spans((w, lo, hi) for w, lo, hi, _ in spans)
    for weekday, lo, hi in merged:
        source = [s for w, a, b, s in spans if w == weekday and lo <= a < hi]
        promo_weekday = (weekday + 1) % 7 if lo < ctx.clock.day_start_hour else weekday
        start_hour = lo % 24
        end_hour = hi % 24
        schedule = PS.schedule_of_slot([promo_weekday], start_hour, end_hour, today, HAPPY_HOUR_WEEKS)
        deviation = min((s.get("deviationPct") or 0) for s in source) if source else None
        out.append({
            "id": f"{weekday}-{lo}",
            "weekday": weekday,
            "weekdays": [promo_weekday],
            "fromHour": start_hour,
            "toHour": end_hour,
            "startTime": schedule.start_time,
            "endTime": schedule.end_time,
            "deviationPct": deviation,
            "gapPerWeek": sum(int(s.get("gapPerWeek") or 0) for s in source),
            "typicalNet": sum(int(s.get("typicalNet") or 0) for s in source),
            "usual": sum(int(s.get("usual") or 0) for s in source),
            "overlaps": schedule_overlaps(ctx.db, ctx.scope.tenant_id, schedule, tz, now),
        })
    out.sort(key=lambda s: -s["gapPerWeek"])
    return {"suggestions": out[:6], "weeks": HAPPY_HOUR_WEEKS, "maxWeeks": MAX_HAPPY_HOUR_WEEKS}


def PS_zone(name: str):
    from app.services.reports import _load_zoneinfo

    return _load_zoneinfo(name)


def _hhmm(value: Any) -> str:
    text = str(value or "").strip()[:5]
    try:
        hour, minute = (int(x) for x in text.split(":"))
    except (TypeError, ValueError):
        raise _bad(BAD_SCHEDULE)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise _bad(BAD_SCHEDULE)
    return f"{hour:02d}:{minute:02d}"


def create_happy_hour(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> Tuple[InsightQuickAction, List[POSMachine]]:
    """
    "Happy hour מתוזמן": a promotion on these weekdays in this hour window, for `weeks` weeks
    from today, on a category or the whole basket (or one product), never below cost.
    `body`: weekdays [0..6], startTime, endTime, weeks?, offer, categoryId | all | productId,
    targetLevel, targetId, announce?. Returns the action (its `params.overlaps`: the other
    hour-window promotions it runs alongside — a warning, not a refusal) and the tills woken.
    """
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    try:
        days = sorted({int(d) for d in body.get("weekdays") or []})
    except (TypeError, ValueError):
        raise _bad(BAD_SCHEDULE)
    if not days or any(d < 0 or d > 6 for d in days):
        raise _bad(BAD_SCHEDULE)
    start, end = _hhmm(body.get("startTime")), _hhmm(body.get("endTime"))
    if start == end:
        raise _bad(BAD_SCHEDULE)
    weeks = body.get("weeks", HAPPY_HOUR_WEEKS)
    if not isinstance(weeks, int) or not 1 <= weeks <= MAX_HAPPY_HOUR_WEEKS:
        raise _bad(BAD_SCHEDULE)
    subject = subject_of(db, tenant_id, body)
    target = resolve_target(db, user, tenant_id, body.get("targetLevel"), body.get("targetId"))
    if not target.machines:
        raise _bad(NO_TILLS)
    announce = PA.clean_settings(body.get("announce"))
    if announce and announce.get("enabled"):
        PA.require_messaging(db, user)
    items = group_items(db, tenant_id, subject, target.shop_ids)
    raw_offer = body.get("offer") or {}
    offer = check_group(subject, raw_offer.get("kind"), raw_offer.get("value"), items)
    if offer["belowCost"]:
        raise _below_cost(offer)
    now = _now()
    _tz_name, tz = _zone(db, tenant_id)
    today = now.astimezone(tz).date()
    schedule = PS.Schedule(valid_from=today, valid_to=today + timedelta(days=7 * weeks - 1),
                           weekdays=tuple(days), start_time=start, end_time=end)
    overlapping = schedule_overlaps(db, tenant_id, schedule, tz, now)
    promo_type, config = promotion_body(subject, offer, items)
    label = offer_label(offer) if offer["kind"] != "fixed_price" or subject.product is not None else ""
    promotion = _create_promotion(db, user, tenant_id, {
        "name": f"Happy hour · {_days_label(days)} {start}–{end} · {subject.name} · {label}"[:120],
        "description": f"הופעל מהתובנות ע״י {_who(user) or '—'}",
        "type": promo_type,
        "config": config,
        "scopes": target.promotion_scopes(),
        "validFrom": schedule.valid_from.isoformat(),
        "validTo": schedule.valid_to.isoformat(),
        "weekdays": days,
        "startTime": start,
        "endTime": end,
        "priority": 0,
    })
    woken = PA.plan(db, user, promotion, settings=announce, now=now) if announce else []
    nxt = PS.current_or_next(schedule, tz, now)
    action = _action(
        db, user, tenant_id, kind="promotion", product=subject.product, category=subject.category, target=target,
        params={
            "subject": subject.kind, "offer": offer, "label": label, "happyHour": True,
            "weekdays": days, "startTime": start, "endTime": end, "weeks": weeks,
            "validFrom": schedule.valid_from.isoformat(), "validTo": schedule.valid_to.isoformat(),
            "nextStart": nxt[0].isoformat() if nxt else None, "overlaps": overlapping,
            "promotionName": promotion.name,
            "announce": PA.settings_out(promotion) if announce else None,
        },
        source="happy_hour", starts_at=now, ends_at=PS.final_end(schedule, tz), promotion_id=promotion.id,
    )
    return action, woken


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


def cancel_quick_promotion(db: Session, user: User, tenant_id, action_id) -> Tuple[InsightQuickAction, List[POSMachine]]:
    """"בטל מבצע": pause the promotion now (kept for the reports), its announcement down; idempotent."""
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    action = get_action(db, tenant_id, action_id, "promotion")
    woken: List[POSMachine] = []
    if action.promotion_id is not None:
        try:
            promotion = P.get_promotion(db, tenant_id, action.promotion_id)
        except HTTPException:
            promotion = None  # deleted on the promotions page since: nothing left to stop
        if promotion is not None:
            P.set_paused(db, user, tenant_id, promotion, True)
            woken = PA.plan(db, user, promotion)
    _cancelled(db, user, action)
    return action, woken


def _cancelled(db: Session, user: User, action: InsightQuickAction) -> None:
    if action.cancelled_at is None:
        action.cancelled_at = _now()
        action.cancelled_by_user_id = user.id
        db.flush()
        logger.info("insights quick %s %s cancelled by user %s", action.kind, action.id, user.id)


# ── Reads: the suggestion, the list and the result ────────────────────────────


def promotion_suggestion(db: Session, user: User, tenant_id, body: Dict[str, Any]) -> Dict[str, Any]:
    """
    For a product, a category or the whole basket (`productId` | `categoryId` | `all`): the
    price and cost (a product), the offers and whether each keeps every unit above cost, the
    suggested one, and whether the user may create it.
    """
    subject = subject_of(db, tenant_id, body)
    shop_ids: Set[uuid.UUID] = set()
    if body.get("targetLevel") and body.get("targetId"):
        shop_ids = resolve_target(db, user, tenant_id, body["targetLevel"], body["targetId"]).shop_ids
    items = group_items(db, tenant_id, subject, shop_ids)
    pricing = items[0].pricing if subject.product is not None else None
    return {
        "subject": {
            "kind": subject.kind,
            "id": str((subject.product or subject.category).id) if subject.kind != "all" else None,
            "name": subject.name,
        },
        "product": {"id": str(subject.product.id), "name": subject.product.name} if subject.product is not None else None,
        "price": pricing.price if pricing else None,
        "minPrice": pricing.min_price if pricing else None,
        "cost": pricing.cost if pricing else None,
        "vatRate": pricing.vat_rate if pricing else None,
        "floor": pricing.floor if pricing else None,
        "marginPct": None if pricing is None or pricing.margin_pct is None else round(pricing.margin_pct, 1),
        "costedProducts": len(items) if subject.product is None else None,
        "options": group_options(subject, items),
        "suggested": suggest_group(subject, items),
        "canCreate": user.role in PROMOTION_ROLES,
        "canAnnounce": PA.may_message(db, user),
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


def _subject_products(db: Session, tenant_id, action: InsightQuickAction) -> Optional[List[uuid.UUID]]:
    """What the result counts: the product, the category's products, or (None) every sale."""
    if action.product_id is not None:
        return [action.product_id]
    if action.category_id is not None:
        cats = _category_ids(db, tenant_id, action.category_id)
        return [r[0] for r in db.query(Product.id).filter(Product.tenant_id == tenant_id, Product.category_id.in_(cats)).all()]
    if action.kind == "promotion" and (action.params or {}).get("subject") == "all":
        return None
    return []


def _product_sums(db: Session, user: User, tenant_id, action: InsightQuickAction,
                  windows: Dict[str, Tuple[datetime, datetime]], products: Optional[List[uuid.UUID]]) -> Dict[str, Dict[str, Any]]:
    """The subject's units and net on the action's tills, per window — one grouped query."""
    empty = {name: {"units": 0.0, "net": 0} for name in windows}
    ids = [_uuid(m) for m in action.machine_ids or [] if _uuid(m) is not None]
    if not ids or products == []:
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
    query = (
        db.query(*columns)
        .select_from(TransactionItem)
        .join(tx, tx.c.tx_id == TransactionItem.transaction_id)
        .outerjoin(Product, Product.id == TransactionItem.product_id)
    )
    if products is not None:
        query = query.filter(key.in_(products))
    row = query.one()
    return {
        name: {"units": round(float(getattr(row, f"{name}__units") or 0), 3), "net": to_agorot(getattr(row, f"{name}__net"))}
        for name in windows
    }


def _change(a: float, b: float) -> Optional[float]:
    """The change from b to a in %; None when there was nothing before to compare with."""
    if b == 0:
        return None
    return round((a - b) / abs(b) * 100, 1)


def action_result(db: Session, user: User, tenant_id, action: InsightQuickAction, now: datetime) -> Optional[Dict[str, Any]]:
    """
    The subject's sales on the action's tills since it started (to its end, its cancellation
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
    products = _subject_products(db, tenant_id, action)
    if products == [] or span.total_seconds() <= 0:
        return out
    sums = _product_sums(db, user, tenant_id, action, {
        "since": (start, end),
        "before": (start - span, start),
        "lastWeek": (start - timedelta(days=7), end - timedelta(days=7)),
    }, products)
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
        "categoryId": str(action.category_id) if action.category_id else None,
        "categoryName": action.category_name,
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
