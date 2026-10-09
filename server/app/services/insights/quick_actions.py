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
from fractions import Fraction
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func, or_
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
#: The only percentages this route takes: the menu's, and 5% the suggestion may fall back to.
ALLOWED_PERCENTS = (5, 10, 15, 20)
#: No unit is ever sold for less than ₪1 (agorot), whatever its cost.
MIN_UNIT_PRICE = 100
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
    #: The active tills of the target the user can see (who a message reaches).
    machines: List[POSMachine]
    #: Every shop the target covers, whoever placed its tills — what a promotion on a
    #: company / shop / area reaches, so what its price checks must hold for.
    shop_ids: Set[uuid.UUID] = field(default_factory=set)
    event: Any = None
    #: Every till a promotion on the target reaches (its local product copies are priced too).
    reach_machine_ids: Set[uuid.UUID] = field(default_factory=set)

    def promotion_scopes(self) -> List[Dict[str, str]]:
        """An event's tills one by one (a promotion has no event level); else the target itself."""
        if self.level == "event":
            return [{"type": "machine", "id": str(m.id)} for m in self.machines]
        return [{"type": self.level, "id": str(self.id)}]


def _reach(db: Session, tenant_id, level: str, entity) -> Tuple[Set[uuid.UUID], Set[uuid.UUID]]:
    """The shops and active tills a promotion on this target reaches — all of them, not the caller's."""
    from app.models.shop import Shop
    from app.services.company_hierarchy import descendant_company_ids

    if level == "company":
        group = descendant_company_ids(db, entity.id)
        shop_ids = {r[0] for r in db.query(Shop.id).filter(Shop.tenant_id == tenant_id, Shop.company_id.in_(group)).all()}
    elif level in ("shop",):
        shop_ids = {entity.id}
    else:  # area / machine
        shop_ids = {entity.shop_id} if entity.shop_id is not None else set()
    query = db.query(POSMachine.id).filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
    if level == "machine":
        query = query.filter(POSMachine.id == entity.id)
    elif level == "area":
        query = query.filter(POSMachine.area_id == entity.id)
    elif shop_ids:
        query = query.filter(POSMachine.shop_id.in_(list(shop_ids)))
    else:
        return shop_ids, set()
    return shop_ids, {r[0] for r in query.all()}


def resolve_target(db: Session, user: User, tenant_id, level: str, target_id) -> Target:
    """
    The target, when the user may act on it (the till messages' rule; an event: its shop's
    access), its active tills the user can see, and everything a promotion on it reaches.
    404 unknown, 403 not theirs.
    """
    if level not in QUICK_ACTION_TARGETS or _uuid(target_id) is None:
        raise _bad(BAD_TARGET)
    if level == "event":
        from app.services.report_events.crud import load_event

        event = load_event(db, user, tenant_id, target_id)
        ids = [row.machine_id for row in event.machines]
        visible = TM.visible_machines_query(db, user, tenant_id)
        machines = visible.filter(POSMachine.id.in_(ids)).all() if (visible is not None and ids) else []
        # A promotion on an event names its (visible) tills one by one: that is its reach.
        return Target("event", event.id, event.name, machines, {event.shop_id}, event, {m.id for m in machines})
    entity = TM.resolve_target(db, user, tenant_id, level, target_id)
    machines = TM.target_machines(db, user, tenant_id, level, target_id)
    shop_ids, reach = _reach(db, tenant_id, level, entity)
    return Target(level, entity.id, getattr(entity, "name", None), machines, shop_ids, None, reach)


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
    business days, today's to that one's (today .. today + 30). Pure.

    "Until a date" is a promotion on the business days themselves: from today's business
    date to the last, each day's window running from the day's start (04:00) to a minute
    before the next (03:59) — a window that crosses midnight belongs to the day it started,
    which is the tills' rule — so at 01:30 the promotion is already "today's", and it ends
    when the tills stop applying it: 03:59 the morning after the last day.
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
        start = dtime(day_start_hour)
        if day_start_hour == 0:
            end = dtime(23, 59)
            ends = datetime.combine(last, end, tzinfo=tz)
        else:
            end = dtime(day_start_hour - 1, 59)
            ends = datetime.combine(last + timedelta(days=1), end, tzinfo=tz)
        return Window(ends.astimezone(timezone.utc), today, last, start.strftime("%H:%M"), end.strftime("%H:%M"))
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


#: "פריט כללי" and an open-price item ("מחיר פתוח") have no price a promotion can be checked
#: against: they are refused for a promotion of their own and left out of a group's.
UNSUPPORTED_PRODUCT = "quick_promo_unsupported_product"


def unsupported_reason(product: Product) -> Optional[str]:
    if product.is_general:
        return "general"
    if getattr(product, "is_open_price", False):
        return "open_price"
    return None


def _menu_prices(db: Session, tenant_id, product_ids: Sequence[uuid.UUID], shop_ids: Set[uuid.UUID]) -> Dict[uuid.UUID, List[int]]:
    """
    The prices active menus ("תפריטים") sell the products at in the target's shops: any menu
    that is on and not over, of the organization or of a company above one of the shops.
    Its schedule is not narrowed — the lowest such price is a price the till may charge.
    """
    from app.models.catalog_menu import CatalogMenu, CatalogMenuProduct
    from app.models.shop import Shop
    from app.services.company_hierarchy import ancestor_company_ids

    if not product_ids:
        return {}
    companies: Set[uuid.UUID] = set()
    for (company_id,) in db.query(Shop.company_id).filter(Shop.id.in_(list(shop_ids))).all() if shop_ids else []:
        if company_id is not None:
            companies.add(company_id)
            companies.update(ancestor_company_ids(db, company_id))
    from app.services.promotions import tenant_today

    today = tenant_today(db, tenant_id)
    rows = (
        db.query(CatalogMenuProduct.product_id, CatalogMenuProduct.price)
        .join(CatalogMenu, CatalogMenu.id == CatalogMenuProduct.menu_id)
        .filter(
            CatalogMenu.tenant_id == tenant_id,
            CatalogMenu.is_active.is_(True),
            (CatalogMenu.valid_to.is_(None)) | (CatalogMenu.valid_to >= today),
            or_(CatalogMenu.company_id.is_(None), CatalogMenu.company_id.in_(list(companies))) if companies else CatalogMenu.company_id.is_(None),
            CatalogMenuProduct.product_id.in_(list(product_ids)),
            CatalogMenuProduct.price.isnot(None),
        )
        .all()
    )
    out: Dict[uuid.UUID, List[int]] = {}
    for product_id, price in rows:
        out.setdefault(product_id, []).append(to_agorot(price))
    return out


def _local_copy_prices(db: Session, tenant_id, product_ids: Sequence[uuid.UUID], machine_ids: Set[uuid.UUID]) -> Dict[uuid.UUID, List[int]]:
    """A till's own copy of a global product may carry its own price."""
    if not product_ids or not machine_ids:
        return {}
    out: Dict[uuid.UUID, List[int]] = {}
    for global_id, price in db.query(Product.global_product_id, Product.price).filter(
        Product.tenant_id == tenant_id,
        Product.global_product_id.in_(list(product_ids)),
        Product.pos_machine_id.in_(list(machine_ids)),
    ):
        out.setdefault(global_id, []).append(to_agorot(price))
    return out


def _price_points(
    db: Session, tenant_id, products: Sequence[Product], shop_ids: Set[uuid.UUID], machine_ids: Set[uuid.UUID],
) -> Dict[uuid.UUID, Tuple[int, int]]:
    """
    Per product: (the reference price — a single shop's own when the target is one shop —,
    the lowest price anywhere the promotion runs): the catalog price, the target's shops' own
    prices, the active menus' prices and the tills' local copies'.
    """
    ids = [p.id for p in products]
    overrides: Dict[Tuple[uuid.UUID, uuid.UUID], int] = {}
    if shop_ids and ids:
        for r in db.query(ShopProductOverride.global_product_id, ShopProductOverride.shop_id, ShopProductOverride.price).filter(
            ShopProductOverride.global_product_id.in_(ids),
            ShopProductOverride.shop_id.in_(list(shop_ids)),
            ShopProductOverride.price.isnot(None),
        ):
            overrides[(r.global_product_id, r.shop_id)] = to_agorot(r.price)
    menus = _menu_prices(db, tenant_id, ids, shop_ids)
    copies = _local_copy_prices(db, tenant_id, ids, machine_ids)
    out: Dict[uuid.UUID, Tuple[int, int]] = {}
    for product in products:
        base = to_agorot(product.price)
        shop_prices = [overrides.get((product.id, s), base) for s in shop_ids] or [base]
        reference = shop_prices[0] if len(shop_ids) == 1 else base
        everything = shop_prices + menus.get(product.id, []) + copies.get(product.id, [])
        out[product.id] = (reference, min(everything))
    return out


def product_pricing(db: Session, tenant_id, product: Product, shop_ids: Set[uuid.UUID],
                    machine_ids: Optional[Set[uuid.UUID]] = None) -> Pricing:
    """
    The product's price (a single shop's own when the target is one shop), the lowest price
    it sells at anywhere the promotion runs (a promotion must hold everywhere), its unit cost
    and its VAT rate.
    """
    reference, lowest = _price_points(db, tenant_id, [product], shop_ids, machine_ids or set())[product.id]
    cost_row = db.query(ProductCost.cost).filter(ProductCost.tenant_id == tenant_id, ProductCost.product_id == product.id).first()
    rate = float(product.tax_rate) / 100.0 if product.tax_rate is not None else DEFAULT_VAT_RATE
    return Pricing(
        price=reference,
        min_price=lowest,
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
    try:
        number = None if value is None else Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        raise _bad(BAD_OFFER)
    # Never over-estimated: a unit's price after the offer is rounded *down* to the agora.
    if kind == "percent":
        if number is None or number not in ALLOWED_PERCENTS:
            raise _bad(BAD_OFFER)
        keep = (100 - number) / 100
        new_price = math.floor(price * keep)
        lowest = math.floor(low * keep)
        effective = float(number)
    elif kind == "second_half":
        new_price = math.floor(Fraction(price) * 3 / 4)
        lowest = math.floor(Fraction(low) / 2)
        effective = 25.0
    else:
        if number is None or not 0 < number < price:
            raise _bad(BAD_OFFER)
        new_price = math.floor(number)
        lowest = low - (price - new_price)
        effective = (1 - new_price / price) * 100 if price else 0.0
    floor = pricing.floor
    below = floor is not None and lowest < floor
    # Whatever the cost: no unit at nothing or less, and nothing under ₪1.
    too_low = lowest < MIN_UNIT_PRICE or new_price < MIN_UNIT_PRICE
    return {
        "kind": kind,
        "value": None if kind == "second_half" else (new_price if kind == "fixed_price" else float(number)),
        "newPrice": new_price,
        "lowestUnitPrice": lowest,
        "effectivePct": round(effective, 1),
        "belowCost": below,
        "tooLow": too_low,
        "refused": below or too_low,
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
        offer = check_offer("percent", DEFAULT_PERCENT, pricing)
        return None if offer["refused"] else offer
    margin = pricing.margin_pct
    if margin is None or margin <= 0:
        return None
    for pct in sorted(PERCENT_CHOICES, reverse=True):
        if pct <= margin * KEEP_MARGIN_SHARE:
            offer = check_offer("percent", pct, pricing)
            if not offer["refused"]:
                return offer
    for pct in (10, 5):
        offer = check_offer("percent", pct, pricing)
        if not offer["refused"]:
            return offer
    return None


def offer_options(pricing: Pricing) -> List[Dict[str, Any]]:
    """The menu the dialog shows: 10 / 15 / 20%, the second at half price, a fixed price."""
    out = [check_offer("percent", pct, pricing) for pct in PERCENT_CHOICES]
    out.append(check_offer("second_half", None, pricing))
    fixed = int(math.ceil(pricing.price * 0.85 / 100.0)) * 100  # 15% off, up to a whole shekel
    if pricing.floor is not None:
        fixed = max(fixed, int(math.ceil(pricing.floor / 100.0)) * 100)
    if MIN_UNIT_PRICE <= fixed < pricing.price:
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


def subject_of(db: Session, tenant_id, body: Dict[str, Any], *, for_promotion: bool = True) -> Subject:
    """
    `productId`, else `categoryId`, else `all: true`. A promotion on the general item or an
    open-price item is refused (400 `quick_promo_unsupported_product`): it has no price to hold.
    """
    if body.get("productId"):
        product = global_product(db, tenant_id, body["productId"])
        reason = unsupported_reason(product)
        if for_promotion and reason:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": UNSUPPORTED_PRODUCT, "reason": reason})
        return Subject("product", product=product)
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


def group_items(db: Session, tenant_id, subject: Subject, target: Target) -> List[Item]:
    """
    The products to check an offer on, priced everywhere the promotion runs (the target's
    shops, their active menus, the tills' own copies). A product: itself (cost known or not).
    A category or the whole basket: its global products **with a known cost** — one without
    cannot be shown to be below it — never the general item or an open-price item.
    """
    shop_ids, machine_ids = target.shop_ids, target.reach_machine_ids
    if subject.product is not None:
        return [Item(subject.product.id, subject.product.name, product_pricing(db, tenant_id, subject.product, shop_ids, machine_ids))]
    query = (
        db.query(Product, ProductCost.cost)
        .join(ProductCost, and_(ProductCost.product_id == Product.id, ProductCost.tenant_id == tenant_id))
        .filter(
            Product.tenant_id == tenant_id,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
            Product.is_general.is_(False),
            Product.is_open_price.is_(False),
        )
    )
    if subject.category is not None:
        query = query.filter(Product.category_id.in_(_category_ids(db, tenant_id, subject.category.id)))
    rows = query.all()
    if not rows:
        return []
    points = _price_points(db, tenant_id, [p for p, _ in rows], shop_ids, machine_ids)
    items = []
    for product, cost in rows:
        reference, lowest = points[product.id]
        rate = float(product.tax_rate) / 100.0 if product.tax_rate is not None else DEFAULT_VAT_RATE
        items.append(Item(product.id, product.name, Pricing(price=reference, min_price=lowest, cost=to_agorot(cost), vat_rate=rate)))
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
    too_low = False
    for item in items:
        checked = check_offer(kind, value, item.pricing)
        if checked["refused"]:
            too_low = too_low or checked["tooLow"]
            offenders.append({"productId": str(item.product_id), "name": item.name, "floor": checked["floor"],
                              "lowestUnitPrice": checked["lowestUnitPrice"], "tooLow": checked["tooLow"]})
    return {
        "kind": kind,
        "value": head["value"],
        "effectivePct": head["effectivePct"],
        "belowCost": any(not o["tooLow"] for o in offenders),
        "tooLow": too_low,
        "refused": bool(offenders),
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
            offer = check_group(subject, "percent", pct, items)
            if not offer["refused"]:
                return offer
    for pct in (10, 5):
        offer = check_group(subject, "percent", pct, items)
        if not offer["refused"]:
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


#: An offer that would sell a unit for nothing, or under ₪1.
BELOW_MINIMUM = "quick_promo_below_minimum"


def _below_cost(offer: Dict[str, Any]) -> HTTPException:
    code = BELOW_COST if offer.get("belowCost") else BELOW_MINIMUM
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={
        "code": code, "floor": offer.get("floor"), "lowestUnitPrice": offer.get("lowestUnitPrice"),
        "minimum": MIN_UNIT_PRICE, "offenders": offer.get("offenders"),
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
    if display == "fullscreen":
        # "פעולות מהירות" sends banners; a message every cashier must acknowledge is the
        # till messages' own ("הודעות לקופות" at edit).
        from app.services import dashboard_access

        dashboard_access.enforce_section(db, user, "till_messages", "edit")
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


BAD_PROMOTION = "quick_promo_invalid"


def _create_promotion(db: Session, user: User, tenant_id, fields: Dict[str, Any]) -> Promotion:
    from pydantic import ValidationError

    from app.schemas.promotion import PromotionIn

    try:
        body = PromotionIn.model_validate(fields)
    except ValidationError as bad:
        # Whatever the inputs, never a 500: say what the promotions' own rules refused.
        errors = [str(e.get("msg", "")) for e in bad.errors()][:3]
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": BAD_PROMOTION, "errors": errors})
    return P.create_promotion(db, user, tenant_id, body)


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
        PA.require_messaging(db, user, PA.QUICK_SECTIONS)
    items = group_items(db, tenant_id, subject, target)
    raw_offer = body.get("offer") or {}
    offer = check_group(subject, raw_offer.get("kind"), raw_offer.get("value"), items)
    if offer["refused"]:
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
    woken = PA.plan(db, user, promotion, settings=announce, now=now, sections=PA.QUICK_SECTIONS) if announce else []
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


def _chain(db: Session, machine_ids: Set[uuid.UUID]) -> Set[Tuple[str, str]]:
    """Every scope entry (till, area, shop, company and above) that reaches one of these tills."""
    chain: Set[Tuple[str, str]] = set()
    if not machine_ids:
        return chain
    for machine in db.query(POSMachine).filter(POSMachine.id.in_(list(machine_ids))).all():
        chain |= P._till_chain(db, machine)
    return chain


def schedule_overlaps(
    db: Session, user: User, tenant_id, schedule: PS.Schedule, tz, now: datetime, machine_ids: Set[uuid.UUID],
) -> List[Dict[str, Any]]:
    """
    The promotions with an hour window that run at the same time as `schedule` on the same
    tills (`machine_ids`), among those the user can see.
    """
    chain = _chain(db, machine_ids)
    if not chain:
        return []
    vis = P._visibility(db, user, tenant_id)
    out = []
    for promotion in _hour_windows(db, tenant_id, now):
        if not P.reaches_till(promotion, chain) or not P._reaches_visible(db, vis, promotion):
            continue
        hit = PS.overlaps(schedule, PS.Schedule.of(promotion), tz, now=now)
        if hit is not None:
            out.append({"id": str(promotion.id), "name": promotion.name, "at": hit[0].isoformat(),
                        "weekdays": promotion.weekdays, "startTime": promotion.start_time, "endTime": promotion.end_time})
    return out


def weak_windows(weak: Sequence[Dict[str, Any]], day_start_hour: int) -> List[Dict[str, Any]]:
    """
    The heat map's weak slots (business weekday, local hours) as calendar windows: slots of
    one business day that touch are merged, in the business day's own order (04:00 → 03:59),
    so a span is never merged across the day's start; the hours after midnight are on the
    calendar day after the business day's (a weak 01:00 of Friday is Saturday 01:00). Pure.
    """
    spans = []
    for slot in weak:
        lo, hi = int(slot["fromHour"]), int(slot["toHour"])
        length = (hi - lo) % 24 or 24
        start_b = (lo - day_start_hour) % 24  # hours since the business day began
        spans.append((int(slot["weekday"]), start_b, start_b + length, slot))
    out = []
    for weekday, lo_b, hi_b in PS.merge_spans((w, a, b) for w, a, b, _ in spans):
        source = [s for w, a, b, s in spans if w == weekday and lo_b <= a < hi_b]
        absolute = lo_b + day_start_hour  # hours from the business date's midnight
        out.append({
            "weekday": weekday,
            "calendarWeekday": (weekday + absolute // 24) % 7,
            "fromHour": absolute % 24,
            "toHour": (hi_b + day_start_hour) % 24,
            "source": source,
        })
    return out


def happy_hour_suggestions(ctx, heatmap: Dict[str, Any]) -> Dict[str, Any]:
    """
    The weakest weekday × hour slots of the heat map (each ≥ 40% under its hour's usual, over
    open days only) as happy-hour windows: one weekday, an hour window, four weeks from
    today (`weak_windows`). Each says which other hour-window promotions it would overlap on
    the scope's tills, among those the user can see.
    """
    from .till_stats import scope_machines

    tz = PS_zone(ctx.clock.tz_name)
    now = ctx.clock.now
    today = now.astimezone(tz).date()
    machine_ids = {m.id for m in scope_machines(ctx.db, ctx.scope)}
    out = []
    for w in weak_windows(heatmap.get("weak") or [], ctx.clock.day_start_hour):
        source = w["source"]
        schedule = PS.schedule_of_slot([w["calendarWeekday"]], w["fromHour"], w["toHour"], today, HAPPY_HOUR_WEEKS)
        deviation = min((s.get("deviationPct") or 0) for s in source) if source else None
        out.append({
            "id": f"{w['weekday']}-{w['fromHour']}",
            "weekday": w["weekday"],
            "weekdays": [w["calendarWeekday"]],
            "fromHour": w["fromHour"],
            "toHour": w["toHour"],
            "startTime": schedule.start_time,
            "endTime": schedule.end_time,
            "deviationPct": deviation,
            "gapPerWeek": sum(int(s.get("gapPerWeek") or 0) for s in source),
            "typicalNet": sum(int(s.get("typicalNet") or 0) for s in source),
            "usual": sum(int(s.get("usual") or 0) for s in source),
            "overlaps": schedule_overlaps(ctx.db, ctx.scope.user, ctx.scope.tenant_id, schedule, tz, now, machine_ids),
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
        PA.require_messaging(db, user, PA.QUICK_SECTIONS)
    items = group_items(db, tenant_id, subject, target)
    raw_offer = body.get("offer") or {}
    offer = check_group(subject, raw_offer.get("kind"), raw_offer.get("value"), items)
    if offer["refused"]:
        raise _below_cost(offer)
    now = _now()
    _tz_name, tz = _zone(db, tenant_id)
    today = now.astimezone(tz).date()
    schedule = PS.Schedule(valid_from=today, valid_to=today + timedelta(days=7 * weeks - 1),
                           weekdays=tuple(days), start_time=start, end_time=end)
    overlapping = schedule_overlaps(db, user, tenant_id, schedule, tz, now, target.reach_machine_ids)
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
    woken = PA.plan(db, user, promotion, settings=announce, now=now, sections=PA.QUICK_SECTIONS) if announce else []
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


def _may_act_on(db: Session, user: User, tenant_id, action: InsightQuickAction) -> None:
    """The action's target must still be one the user may act on (403; a vanished target: super admin only)."""
    try:
        resolve_target(db, user, tenant_id, action.target_level, action.target_id)
    except HTTPException as refused:
        if refused.status_code == status.HTTP_404_NOT_FOUND and user.role == UserRole.SUPER_ADMIN:
            return
        if refused.status_code == status.HTTP_404_NOT_FOUND:
            raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)
        raise


@dataclass
class Cancelled:
    action: InsightQuickAction
    woken: List[POSMachine]
    #: Messages the user may not take down (another's till of an event): left as they are.
    skipped: int = 0


def cancel_quick_message(db: Session, user: User, tenant_id, action_id) -> Cancelled:
    """
    Take the banner(s) down now; idempotent. Each message by the till messages' own manage
    rule: one the user may not manage (an event's till that is not theirs) is skipped and
    reported, the rest come down; when none may, 403.
    """
    if user.role not in MESSAGE_ROLES:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)
    action = get_action(db, tenant_id, action_id, "message")
    machines: List[POSMachine] = []
    done = skipped = 0
    for message_id in action.till_message_ids or []:
        try:
            message = TM.get_message(db, tenant_id, message_id)
        except HTTPException:
            continue  # gone already: nothing to take down
        try:
            TM.cancel_message(db, user, tenant_id, message)
        except HTTPException as refused:
            if refused.status_code != status.HTTP_403_FORBIDDEN:
                raise
            skipped += 1
            continue
        done += 1
        machines += TM.unacknowledged_machines(db, message)
    if skipped and not done:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)
    if not done:
        _may_act_on(db, user, tenant_id, action)
    if not skipped:
        _cancelled(db, user, action)
    return Cancelled(action, machines, skipped)


def cancel_quick_promotion(db: Session, user: User, tenant_id, action_id) -> Cancelled:
    """"בטל מבצע": pause the promotion now (kept for the reports), its announcement down; idempotent."""
    if user.role not in PROMOTION_ROLES:
        raise _bad(P.FORBIDDEN, status.HTTP_403_FORBIDDEN)
    action = get_action(db, tenant_id, action_id, "promotion")
    woken: List[POSMachine] = []
    promotion = None
    if action.promotion_id is not None:
        try:
            promotion = P.get_promotion(db, tenant_id, action.promotion_id)
        except HTTPException:
            promotion = None  # deleted on the promotions page since: nothing left to stop
    if promotion is not None:
        P.set_paused(db, user, tenant_id, promotion, True)  # the promotions' own edit rule
        woken = PA.plan(db, user, promotion, sections=PA.QUICK_SECTIONS)
    else:
        _may_act_on(db, user, tenant_id, action)
    _cancelled(db, user, action)
    return Cancelled(action, woken)


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
    price and cost (a product), the offers and whether each keeps every unit above cost and
    above ₪1, the suggested one, and whether the user may create it. The general item and an
    open-price item answer `unsupported` with no offers.
    """
    subject = subject_of(db, tenant_id, body, for_promotion=False)
    base = {
        "subject": {
            "kind": subject.kind,
            "id": str((subject.product or subject.category).id) if subject.kind != "all" else None,
            "name": subject.name,
        },
        "product": {"id": str(subject.product.id), "name": subject.product.name} if subject.product is not None else None,
        "canCreate": user.role in PROMOTION_ROLES,
        "canAnnounce": PA.may_message(db, user, PA.QUICK_SECTIONS),
        "maxHours": MAX_HOURS,
        "maxUntilDays": MAX_UNTIL_DAYS,
        "minimum": MIN_UNIT_PRICE,
    }
    reason = unsupported_reason(subject.product) if subject.product is not None else None
    if reason:
        return {**base, "unsupported": reason, "price": None, "minPrice": None, "cost": None, "vatRate": None,
                "floor": None, "marginPct": None, "costedProducts": None, "options": [], "suggested": None}
    if body.get("targetLevel") and body.get("targetId"):
        target = resolve_target(db, user, tenant_id, body["targetLevel"], body["targetId"])
    else:
        target = Target("tenant", uuid.UUID(int=0), None, [])
    items = group_items(db, tenant_id, subject, target)
    pricing = items[0].pricing if subject.product is not None else None
    return {
        **base,
        "unsupported": None,
        "price": pricing.price if pricing else None,
        "minPrice": pricing.min_price if pricing else None,
        "cost": pricing.cost if pricing else None,
        "vatRate": pricing.vat_rate if pricing else None,
        "floor": pricing.floor if pricing else None,
        "marginPct": None if pricing is None or pricing.margin_pct is None else round(pricing.margin_pct, 1),
        "costedProducts": len(items) if subject.product is None else None,
        "options": group_options(subject, items),
        "suggested": suggest_group(subject, items),
    }


def _status(action: InsightQuickAction, now: datetime) -> str:
    if action.cancelled_at is not None:
        return "cancelled"
    ends = _utc(action.ends_at)
    if ends is not None and ends <= now:
        return "ended"
    return "active"


class _CategoryTree:
    """The tenant's categories, read once per list."""

    def __init__(self, db: Session, tenant_id):
        self.db, self.tenant_id = db, tenant_id
        self._children: Optional[Dict[uuid.UUID, List[uuid.UUID]]] = None

    def products_of(self, root: uuid.UUID) -> List[uuid.UUID]:
        if self._children is None:
            self._children = {}
            for cid, parent in self.db.query(Category.id, Category.parent_id).filter(Category.tenant_id == self.tenant_id).all():
                if parent is not None:
                    self._children.setdefault(parent, []).append(cid)
        cats, stack = [], [root]
        while stack:
            current = stack.pop()
            if current in cats:
                continue
            cats.append(current)
            stack.extend(self._children.get(current, []))
        return [r[0] for r in self.db.query(Product.id).filter(Product.tenant_id == self.tenant_id, Product.category_id.in_(cats)).all()]


def _subject_products(action: InsightQuickAction, tree: _CategoryTree) -> Optional[List[uuid.UUID]]:
    """What the result counts: the product, the category's products, or (None) every sale."""
    if action.product_id is not None:
        return [action.product_id]
    if action.category_id is not None:
        return tree.products_of(action.category_id)
    if action.kind == "promotion" and (action.params or {}).get("subject") == "all":
        return None
    return []


def _scoped_docs(db: Session, user: User, tenant_id, start: datetime, end: datetime):
    """The viewer's reportable documents in [start, end) (the reports' own scope); None: none."""
    window = ReportWindow(from_date=start.date(), to_date=end.date(), from_hour=None, to_hour=None, tz_name="UTC", start=start, end=end)
    return build_scoped_transaction_query(db, user, tenant_id, window)


def _product_sums(db: Session, user: User, tenant_id, ids: List[uuid.UUID],
                  windows: Dict[str, Tuple[datetime, datetime]], products: Optional[List[uuid.UUID]]) -> Dict[str, Dict[str, Any]]:
    """The subject's units and net on these tills, per window — one grouped query, the viewer's scope."""
    empty = {name: {"units": 0.0, "net": 0} for name in windows}
    if not ids or products == []:
        return empty
    start = min(s for s, _ in windows.values())
    end = max(e for _, e in windows.values())
    if end <= start:
        return empty
    query = _scoped_docs(db, user, tenant_id, start, end)
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


def _span(action: InsightQuickAction, now: datetime) -> Tuple[datetime, datetime]:
    start = _utc(action.starts_at)
    end = min(x for x in (now, _utc(action.ends_at), _utc(action.cancelled_at)) if x is not None)
    return start, max(start, end)


def action_result(
    db: Session, user: User, tenant_id, action: InsightQuickAction, now: datetime, ids: List[uuid.UUID],
    *, last_docs: Dict[uuid.UUID, datetime], applied: Dict[uuid.UUID, Tuple[int, int]], tree: _CategoryTree,
) -> Dict[str, Any]:
    """
    The subject's sales on the action's tills (those the viewer sees) since it started — to
    its end, its cancellation or now — against the same length of time just before it, and
    the same hours a week before. `dataArrived`: a document of those tills has come in since.
    """
    start, end = _span(action, now)
    span = end - start
    last = max((last_docs[m] for m in ids if m in last_docs), default=None)
    if last is not None and last < start:
        last = None
    out: Dict[str, Any] = {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "hours": round(span.total_seconds() / 3600, 1),
        "dataArrived": last is not None,
        "lastDocumentAt": last.isoformat() if last is not None else None,
    }
    products = _subject_products(action, tree)
    if products == [] or span.total_seconds() <= 0:
        return out
    sums = _product_sums(db, user, tenant_id, ids, {
        "since": (start, end),
        "before": (start - span, start),
        "lastWeek": (start - timedelta(days=7), end - timedelta(days=7)),
    }, products)
    out.update(sums)
    out["changePct"] = _change(sums["since"]["units"], sums["before"]["units"])
    out["changePctLastWeek"] = _change(sums["since"]["units"], sums["lastWeek"]["units"])
    if action.kind == "promotion" and action.promotion_id is not None:
        times, discount = applied.get(action.promotion_id, (0, 0))
        out["applications"] = times
        out["discount"] = discount
    return out


def action_out(action: InsightQuickAction, now: datetime, result: Optional[Dict[str, Any]] = None,
               visible: Optional[List[str]] = None) -> Dict[str, Any]:
    """The action as the dashboard shows it; `visible`: the viewer's own tills of it (None: all)."""
    machine_ids = list(action.machine_ids or []) if visible is None else list(visible)
    return {
        "id": str(action.id),
        "kind": action.kind,
        "status": _status(action, now),
        "productId": str(action.product_id) if action.product_id else None,
        "productName": action.product_name,
        "categoryId": str(action.category_id) if action.category_id else None,
        "categoryName": action.category_name,
        "target": {"level": action.target_level, "id": str(action.target_id), "name": action.target_name},
        "tills": len(machine_ids),
        "machineIds": machine_ids,
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


def _visible(db: Session, user: User, tenant_id):
    """
    (an SQL condition on the actions whose target lies in what the user sees — None: all —,
    the ids of the tills the user sees — None: all).
    """
    from app.models.report_event import ReportEvent
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.services.company_hierarchy import ancestor_company_ids
    from app.services.overview import _visible_shops_query

    if user.role == UserRole.SUPER_ADMIN:
        return None, None
    shops = _visible_shops_query(db, user, tenant_id)
    machines_q = TM.visible_machines_query(db, user, tenant_id)
    if shops is None or machines_q is None:
        return InsightQuickAction.id.is_(None), set()
    rows = shops.with_entities(Shop.id, Shop.company_id).all()
    shop_ids = [r[0] for r in rows]
    companies: Set[uuid.UUID] = set()
    for _shop, company_id in rows:
        if company_id is not None and company_id not in companies:
            companies.add(company_id)
            companies.update(ancestor_company_ids(db, company_id))
    machine_ids = {r[0] for r in machines_q.with_entities(POSMachine.id).all()}
    areas = [r[0] for r in db.query(ShopArea.id).filter(ShopArea.shop_id.in_(shop_ids)).all()] if shop_ids else []
    events = [r[0] for r in db.query(ReportEvent.id).filter(ReportEvent.shop_id.in_(shop_ids)).all()] if shop_ids else []
    level, target = InsightQuickAction.target_level, InsightQuickAction.target_id
    condition = or_(
        and_(level == "machine", target.in_(list(machine_ids))),
        and_(level == "shop", target.in_(shop_ids)),
        and_(level == "area", target.in_(areas)),
        and_(level == "company", target.in_(list(companies))),
        and_(level == "event", target.in_(events)),
    )
    return condition, machine_ids


def list_quick_actions(
    db: Session, user: User, tenant_id, *, product_id=None, limit: int = 30, with_results: bool = True,
) -> Dict[str, Any]:
    """
    The recent actions whose target the user sees (filtered in SQL, before the limit), newest
    first, each with the tills of it the user sees and its result on them — the documents read
    in the user's own report scope, the last document and the promotions' applications for all
    the actions at once.
    """
    now = _now()
    query = db.query(InsightQuickAction).filter(InsightQuickAction.tenant_id == tenant_id)
    if product_id is not None:
        query = query.filter(InsightQuickAction.product_id == _uuid(product_id))
    condition, seen = _visible(db, user, tenant_id)
    if condition is not None:
        query = query.filter(condition)
    rows = []
    for action in query.order_by(InsightQuickAction.created_at.desc()).limit(limit).all():
        ids = [m for m in (action.machine_ids or []) if seen is None or _uuid(m) in seen]
        if ids:
            rows.append((action, ids))
    items = []
    if rows and with_results:
        all_ids = sorted({_uuid(m) for _a, ids in rows for m in ids if _uuid(m) is not None}, key=str)
        first = min(_utc(a.starts_at) for a, _ in rows)
        last_docs: Dict[uuid.UUID, datetime] = {}
        applied: Dict[uuid.UUID, Tuple[int, int]] = {}
        docs = _scoped_docs(db, user, tenant_id, first, now + timedelta(seconds=1))
        if docs is not None and all_ids:
            for machine_id, at in (
                docs.filter(Transaction.machine_id.in_(all_ids))
                .with_entities(Transaction.machine_id, func.max(Transaction.created_at))
                .group_by(Transaction.machine_id)
                .all()
            ):
                last_docs[machine_id] = _utc(at)
            promotion_ids = [a.promotion_id for a, _ in rows if a.promotion_id is not None]
            if promotion_ids:
                sub = docs.filter(Transaction.machine_id.in_(all_ids)).with_entities(Transaction.id.label("tx_id")).subquery()
                for promotion_id, times, amount in (
                    db.query(
                        TransactionPromotion.promotion_id,
                        func.coalesce(func.sum(TransactionPromotion.applications), 0),
                        func.coalesce(func.sum(TransactionPromotion.discount_amount), 0),
                    )
                    .join(sub, sub.c.tx_id == TransactionPromotion.transaction_id)
                    .filter(TransactionPromotion.promotion_id.in_(promotion_ids))
                    .group_by(TransactionPromotion.promotion_id)
                    .all()
                ):
                    applied[promotion_id] = (int(times or 0), to_agorot(amount))
        tree = _CategoryTree(db, tenant_id)
        for action, ids in rows:
            uids = [_uuid(m) for m in ids if _uuid(m) is not None]
            result = action_result(db, user, tenant_id, action, now, uids, last_docs=last_docs, applied=applied, tree=tree)
            items.append(action_out(action, now, result, ids))
    else:
        items = [action_out(action, now, None, ids) for action, ids in rows]
    return {
        "items": items,
        "generatedAt": now.isoformat(),
        "canMessage": user.role in MESSAGE_ROLES,
        "canPromote": user.role in PROMOTION_ROLES,
    }
