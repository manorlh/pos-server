"""
Insights ("תובנות") — the arithmetic, kept free of the database and of the wall clock.

Everything here takes plain values — money as **integer agorot**, business dates, counts —
and returns plain dicts, so every formula is pinned by a test without a world around it
(tests/test_insights.py). The loaders (`data.py`) feed it; `feed.py` turns its results into
the cards the dashboard shows; docs/SPEC_INSIGHTS.md gives the why of every threshold.

Conventions:

* Weekdays are 0 = Sunday … 6 = Saturday, the Israeli week and the hourly report's.
* A **business day** starts at `day_start_hour` local time (04:00 by default), so a bar's
  01:30 sale belongs to the evening it was part of. Hours are the local wall-clock hour;
  a "slot" is an hour's position inside the business day (04:00 → 0 … 03:00 → 23).
* Percentages are 0–100 floats; shares inside the arithmetic are 0–1.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from statistics import median
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# ── Money and small helpers ──────────────────────────────────────────────────


def to_agorot(value) -> int:
    """Shekels (Decimal / float / str / None) → integer agorot, half-up."""
    if value is None:
        return 0
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def pct(part: float, whole: float) -> Optional[float]:
    """part / whole × 100, or None when there is no whole to divide by."""
    if not whole:
        return None
    return part / whole * 100.0


def change_pct(current: float, previous: float) -> Optional[float]:
    """The change from `previous` to `current` in percent; None without a base."""
    if not previous:
        return None
    return (current - previous) / abs(previous) * 100.0


def r1(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 1)


def weekday_of(day: date) -> int:
    """0 = Sunday … 6 = Saturday."""
    return (day.weekday() + 1) % 7


def days_between(start: date, end: date) -> List[date]:
    """Every day from `start` to `end`, both included."""
    out = []
    current = start
    while current <= end:
        out.append(current)
        current += timedelta(days=1)
    return out


def weekday_occurrences(start: date, end: date) -> List[int]:
    """How many times each weekday occurs in `start`..`end`."""
    counts = [0] * 7
    for day in days_between(start, end):
        counts[weekday_of(day)] += 1
    return counts


# ── The business clock ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class BusinessClock:
    """The report timezone, where a business day starts, and "now"."""

    tz_name: str
    day_start_hour: int
    now: datetime

    @property
    def tzinfo(self):
        from zoneinfo import ZoneInfo

        return ZoneInfo(self.tz_name)

    def local(self, moment: datetime) -> datetime:
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(self.tzinfo)

    def business_date(self, moment: datetime) -> date:
        """The shared rule ("שעת סיום יום עסקי", app/services/business_day.py)."""
        from app.services.business_day import business_day_of_local

        return business_day_of_local(self.local(moment), self.day_start_hour)

    def hour(self, moment: datetime) -> int:
        return self.local(moment).hour

    @property
    def today(self) -> date:
        return self.business_date(self.now)

    def day_start(self, day: date) -> datetime:
        """The UTC instant business day `day` begins (the shared rule, app/services/business_day.py)."""
        from app.services.business_day import business_day_start

        return business_day_start(day, self.tz_name, self.day_start_hour)

    def slot(self, hour: int) -> int:
        """An hour's position inside the business day (the start hour is 0)."""
        return (hour - self.day_start_hour) % 24

    def now_slot(self) -> Tuple[int, float]:
        """The current slot and how much of it has passed (0–1)."""
        local = self.local(self.now)
        return self.slot(local.hour), local.minute / 60.0


def slot_hour(slot: int, day_start_hour: int) -> int:
    return (slot + day_start_hour) % 24


# ── ABC (Pareto) ─────────────────────────────────────────────────────────────

A_CUT = 0.80
B_CUT = 0.95


def abc_classes(values: Sequence[Tuple[str, int]], *, a_cut: float = A_CUT, b_cut: float = B_CUT) -> dict:
    """
    ABC classes over net revenue (agorot): sorted from the biggest earner, an item is A
    while the revenue *before* it is under `a_cut` of the total (so the item that crosses
    80% is still A), B while under `b_cut`, C after. An item that earned nothing (or less,
    after refunds) is C. The three classes' shares add up to 100%.
    """
    positive = sorted(((k, v) for k, v in values if v > 0), key=lambda kv: (-kv[1], kv[0]))
    total = sum(v for _, v in positive)
    items: Dict[str, dict] = {}
    classes = {c: {"count": 0, "net": 0, "share": 0.0, "itemShare": 0.0} for c in "ABC"}
    running = 0
    for key, value in positive:
        before = running / total
        cls = "A" if before < a_cut else "B" if before < b_cut else "C"
        running += value
        items[key] = {
            "class": cls,
            "share": value / total * 100.0,
            "cumShare": running / total * 100.0,
        }
        classes[cls]["count"] += 1
        classes[cls]["net"] += value
    for key, value in values:
        if value <= 0:
            items[key] = {"class": "C", "share": 0.0, "cumShare": 100.0 if total else 0.0}
            classes["C"]["count"] += 1
    n = len(values)
    for cls in "ABC":
        classes[cls]["share"] = classes[cls]["net"] / total * 100.0 if total else 0.0
        classes[cls]["itemShare"] = classes[cls]["count"] / n * 100.0 if n else 0.0
    return {"total": total, "items": items, "classes": classes}


# ── Menu engineering (Kasavana & Smith) ──────────────────────────────────────

POPULARITY_FACTOR = 0.70
DEFAULT_VAT_RATE = 0.18
#: Cost mode needs costs for at least this share of the analysed items.
MIN_COST_COVERAGE = 0.5

QUADRANTS = ("star", "plowhorse", "puzzle", "dog")


@dataclass
class MenuItemIn:
    key: str
    name: str
    units: float
    #: Net takings incl. VAT, agorot.
    net: int
    #: Cost per unit excl. VAT, agorot; None when unknown.
    cost: Optional[int] = None
    vat_rate: float = DEFAULT_VAT_RATE
    category_id: Optional[str] = None
    category_name: Optional[str] = None
    product_id: Optional[str] = None


def quadrant_of(popular: bool, profitable: bool) -> str:
    if popular and profitable:
        return "star"
    if popular:
        return "plowhorse"
    if profitable:
        return "puzzle"
    return "dog"


#: A category with fewer sold items than this is judged against the whole menu instead.
MIN_GROUP_ITEMS = 3
WHOLE_MENU = "__all__"


def _price_ex_vat(item: MenuItemIn) -> float:
    return item.net / item.units / (1.0 + (item.vat_rate or 0.0))


def _thresholds(members: Sequence[MenuItemIn], mode: str, factor: float) -> dict:
    """One group's popularity threshold (share) and weighted-average value (agorot)."""
    total_units = sum(i.units for i in members)
    placed = [i for i in members if mode == "price" or i.cost is not None]
    placed_units = sum(i.units for i in placed)

    def value(i: MenuItemIn) -> float:
        return _price_ex_vat(i) - i.cost if mode == "cost" else _price_ex_vat(i)

    return {
        "n": len(members),
        "units": total_units,
        "popularity": factor / len(members) if members else None,
        "value": sum(value(i) * i.units for i in placed) / placed_units if placed_units else None,
    }


def menu_matrix(
    items: Sequence[MenuItemIn],
    *,
    factor: float = POPULARITY_FACTOR,
    min_cost_coverage: float = MIN_COST_COVERAGE,
    by_category: bool = True,
) -> dict:
    """
    Kasavana & Smith's matrix: popularity (menu mix) × contribution margin.

    * Judged **within each category** by default (drinks against drinks, mains against
      mains), as the method intends; a category with fewer than `MIN_GROUP_ITEMS` sold
      items is judged against the whole menu. `by_category=False` judges everything
      against the whole menu.
    * Menu mix MM% = units / the group's units. Popular when MM% ≥ (1 / N) × 70%, N = the
      group's items sold in the period.
    * Contribution margin CM = average realised price excl. VAT − cost. Profitable when CM
      ≥ the group's units-weighted average CM (Σ CM × units / Σ units, not a plain mean).
    * **Price mode** — when fewer than `min_cost_coverage` of the items have a cost, the
      vertical axis is the average price excl. VAT instead (against its weighted average)
      and the response says so: popularity × price, not profit. In cost mode an item
      without a cost is listed apart, not placed.
    * Each row carries `popIndex` = MM% / its threshold and `valueIndex` = value / its
      group's average, so every group's quadrant lines fall at 1 × 1 on one chart.
    """
    sold = [i for i in items if i.units > 0 and i.net > 0]
    n = len(sold)
    if n == 0:
        return {
            "mode": None, "n": 0, "byCategory": by_category, "popularityThreshold": None,
            "valueThreshold": None, "items": [], "missingCost": [], "counts": {q: 0 for q in QUADRANTS},
            "groups": [],
        }
    with_cost = [i for i in sold if i.cost is not None]
    mode = "cost" if with_cost and len(with_cost) >= math.ceil(min_cost_coverage * n) else "price"

    whole = _thresholds(sold, mode, factor)
    group_of: Dict[str, str] = {}
    groups: Dict[str, dict] = {WHOLE_MENU: whole}
    if by_category:
        by_cat: Dict[Optional[str], List[MenuItemIn]] = {}
        for item in sold:
            by_cat.setdefault(item.category_id, []).append(item)
        for cat, members in by_cat.items():
            if cat is not None and len(members) >= MIN_GROUP_ITEMS:
                groups[cat] = _thresholds(members, mode, factor)
                for i in members:
                    group_of[i.key] = cat

    rows, missing = [], []
    counts = {q: 0 for q in QUADRANTS}
    for item in sold:
        g = group_of.get(item.key, WHOLE_MENU)
        t = groups[g]
        mm = item.units / t["units"] if t["units"] else 0.0
        price_ex = _price_ex_vat(item)
        if mode == "cost" and item.cost is None:
            missing.append(_menu_row(item, mm, price_ex, None, None, g, t))
            continue
        value = price_ex - item.cost if mode == "cost" else price_ex
        popular = mm >= t["popularity"]
        profitable = t["value"] is not None and value >= t["value"]
        quadrant = quadrant_of(popular, profitable)
        counts[quadrant] += 1
        rows.append(_menu_row(item, mm, price_ex, value, quadrant, g, t))
    rows.sort(key=lambda r: (QUADRANTS.index(r["quadrant"]), -r["units"], r["name"] or ""))
    missing.sort(key=lambda r: -r["units"])
    return {
        "mode": mode,
        "n": n,
        "byCategory": by_category,
        "popularityThreshold": whole["popularity"] * 100.0,
        "valueThreshold": round(whole["value"]) if whole["value"] is not None else None,
        "items": rows,
        "missingCost": missing,
        "counts": counts,
        "groups": [
            {
                "group": g,
                "items": t["n"],
                "popularityThreshold": t["popularity"] * 100.0 if t["popularity"] else None,
                "valueThreshold": round(t["value"]) if t["value"] is not None else None,
            }
            for g, t in groups.items()
        ],
    }


def _menu_row(
    item: MenuItemIn,
    mm: float,
    price_ex: float,
    value: Optional[float],
    quadrant: Optional[str],
    group: str,
    t: dict,
) -> dict:
    food_cost = pct(item.cost, price_ex) if item.cost is not None and price_ex > 0 else None
    pop_index = mm / t["popularity"] if t["popularity"] else None
    value_index = value / t["value"] if value is not None and t["value"] and t["value"] > 0 else None
    return {
        "key": item.key,
        "productId": item.product_id,
        "name": item.name,
        "categoryId": item.category_id,
        "categoryName": item.category_name,
        "group": group,
        "units": round(item.units, 3),
        "net": item.net,
        "menuMix": mm * 100.0,
        "popularityThreshold": t["popularity"] * 100.0 if t["popularity"] else None,
        "popIndex": round(pop_index, 3) if pop_index is not None else None,
        "avgPrice": round(item.net / item.units) if item.units else 0,
        "avgPriceExVat": round(price_ex),
        "cost": item.cost,
        "margin": round(price_ex - item.cost) if item.cost is not None else None,
        "foodCostPct": r1(food_cost),
        "value": round(value) if value is not None else None,
        "valueThreshold": round(t["value"]) if t["value"] is not None else None,
        "valueIndex": round(value_index, 3) if value_index is not None else None,
        "totalMargin": round((price_ex - item.cost) * item.units) if item.cost is not None else None,
        "quadrant": quadrant,
    }


# ── Slow movers, dead items, declines ────────────────────────────────────────

DEAD_DAYS = 21
NEW_ITEM_DAYS = 14
SLOW_SHARE = 0.25
DECLINE_RATIO = 0.40
DECLINE_MIN_UNITS = 10.0
SLOW_MIN_ITEMS = 5


@dataclass
class ProductIn:
    key: str
    name: str
    #: Net units sold in the period (sold − refunded), and in the period before it.
    units: float = 0.0
    units_prev: float = 0.0
    net: int = 0
    last_sold: Optional[date] = None
    first_seen: Optional[date] = None
    #: On sale now somewhere in the scope.
    listed: bool = False
    is_general: bool = False
    track_stock: bool = False
    on_hand: Optional[float] = None
    price: Optional[int] = None
    cost: Optional[int] = None
    category_name: Optional[str] = None
    product_id: Optional[str] = None


def _old_enough(item: ProductIn, today: date, days: int) -> bool:
    return item.first_seen is None or (today - item.first_seen).days >= days


def slow_movers(
    items: Sequence[ProductIn],
    *,
    today: date,
    period_days: int,
    lookback_days: int,
    dead_days: int = DEAD_DAYS,
    new_days: int = NEW_ITEM_DAYS,
    slow_share: float = SLOW_SHARE,
    decline_ratio: float = DECLINE_RATIO,
    decline_min_units: float = DECLINE_MIN_UNITS,
) -> dict:
    """
    Three lists, the general item never in any:

    * **dead** — on sale (or holding stock) and not sold for `dead_days` days or more,
      or not at all within the look-back; an item newer than `dead_days` is not judged.
    * **slow** — sold, but its menu mix is under `slow_share` of a fair share (1 / N of
      the items sold): the long tail. Needs `SLOW_MIN_ITEMS` sold items to mean anything;
      items newer than `new_days` are left alone.
    * **declining** — sold at least `decline_min_units` in the period before, and
      `decline_ratio` (40%) less now.
    """
    candidates = [i for i in items if not i.is_general]
    dead, slow, declining = [], [], []
    dead_keys = set()
    for item in candidates:
        has_stock = (item.on_hand or 0) > 0
        if not (item.listed or has_stock):
            continue
        if not _old_enough(item, today, dead_days):
            continue
        days = (today - item.last_sold).days if item.last_sold is not None else None
        if days is None or days >= dead_days:
            dead_keys.add(item.key)
            stock_value = round(item.on_hand * item.cost) if has_stock and item.cost is not None else None
            dead.append({
                **_product_ref(item),
                "daysSinceSale": days,
                "never": days is None,
                "lookbackDays": lookback_days,
                "lastSold": item.last_sold.isoformat() if item.last_sold else None,
                "onHand": item.on_hand,
                "stockValue": stock_value,
                "action": "sell_off_dont_reorder" if has_stock else "dont_reorder",
            })

    sold = [i for i in candidates if i.units > 0]
    n = len(sold)
    total_units = sum(i.units for i in sold)
    if n >= SLOW_MIN_ITEMS and total_units > 0:
        fair = 1.0 / n
        for item in sold:
            if item.key in dead_keys or not _old_enough(item, today, new_days):
                continue
            mm = item.units / total_units
            if mm < slow_share * fair:
                slow.append({
                    **_product_ref(item),
                    "units": round(item.units, 3),
                    "net": item.net,
                    "menuMix": mm * 100.0,
                    "fairShare": fair * 100.0,
                    "perWeek": round(item.units / period_days * 7, 2) if period_days else None,
                    "onHand": item.on_hand,
                    "action": "order_less" if item.track_stock else "promote_or_remove",
                })
    for item in candidates:
        if item.key in dead_keys or item.units_prev < decline_min_units:
            continue
        if item.units <= item.units_prev * (1.0 - decline_ratio):
            declining.append({
                **_product_ref(item),
                "units": round(item.units, 3),
                "unitsPrev": round(item.units_prev, 3),
                "changePct": r1(change_pct(item.units, item.units_prev)),
            })

    # Stock sitting on the shelf first (money stuck), then the longest dead — never sold
    # within the look-back counts as the longest.
    dead.sort(key=lambda r: (
        0 if (r["onHand"] or 0) > 0 else 1,
        -(r["stockValue"] or 0),
        -(r["daysSinceSale"] if r["daysSinceSale"] is not None else 100_000),
        r["name"] or "",
    ))
    slow.sort(key=lambda r: (r["menuMix"], r["name"] or ""))
    declining.sort(key=lambda r: (r["changePct"] if r["changePct"] is not None else 0, r["name"] or ""))
    return {"dead": dead, "slow": slow, "declining": declining}


def _product_ref(item: ProductIn) -> dict:
    return {
        "key": item.key,
        "productId": item.product_id,
        "name": item.name,
        "categoryName": item.category_name,
    }


# ── Stock: days of cover and stock-out risk ──────────────────────────────────

VELOCITY_DAYS = 28
LEAD_DAYS = 2
TARGET_COVER_DAYS = 7
OVERSTOCK_DAYS = 60


@dataclass
class StockIn:
    key: str
    name: str
    shop_id: Optional[str]
    shop_name: Optional[str]
    on_hand: float
    #: Net units sold in the shop over the last `VELOCITY_DAYS` days.
    units: float
    reorder_min: Optional[float] = None
    reorder_max: Optional[float] = None
    cost: Optional[int] = None
    product_id: Optional[str] = None


STOCK_STATUS_ORDER = ("out", "critical", "low", "below_min", "dead", "overstock", "ok")


def stock_risk(
    rows: Sequence[StockIn],
    *,
    velocity_days: int = VELOCITY_DAYS,
    lead_days: int = LEAD_DAYS,
    target_days: int = TARGET_COVER_DAYS,
    overstock_days: int = OVERSTOCK_DAYS,
) -> List[dict]:
    """
    Days of cover = on hand / average daily sales (last `velocity_days`). Out when nothing
    is left of an item that sells; critical under the lead time; low under the target
    cover; below the shop's own reorder minimum; dead stock when it does not sell at all;
    overstock beyond `overstock_days`. The suggested order brings cover to lead time +
    target (or up to the reorder maximum when one is set).
    """
    out = []
    for row in rows:
        velocity = max(row.units, 0.0) / velocity_days if velocity_days else 0.0
        cover = row.on_hand / velocity if velocity > 0 else None
        if row.on_hand <= 0 and velocity > 0:
            status = "out"
        elif cover is not None and cover < lead_days:
            status = "critical"
        elif cover is not None and cover < target_days:
            status = "low"
        elif row.reorder_min is not None and row.on_hand <= row.reorder_min:
            status = "below_min"
        elif velocity == 0 and row.on_hand > 0:
            status = "dead"
        elif cover is not None and cover > overstock_days:
            status = "overstock"
        else:
            status = "ok"
        suggest = None
        if status in ("out", "critical", "low", "below_min"):
            if row.reorder_max is not None and row.reorder_max > row.on_hand:
                suggest = math.ceil(row.reorder_max - row.on_hand)
            else:
                suggest = max(0, math.ceil(velocity * (lead_days + target_days) - row.on_hand))
        out.append({
            "key": row.key,
            "productId": row.product_id,
            "name": row.name,
            "shopId": row.shop_id,
            "shopName": row.shop_name,
            "onHand": round(row.on_hand, 3),
            "perDay": round(velocity, 2),
            "daysOfCover": round(cover, 1) if cover is not None else None,
            # Shopify's sell-through: sold / (sold + what is left), over the velocity window.
            "sellThroughPct": r1(pct(max(row.units, 0.0), max(row.units, 0.0) + max(row.on_hand, 0.0))) if (row.units > 0 or row.on_hand > 0) else None,
            "status": status,
            "suggestedOrder": suggest,
            "reorderMin": row.reorder_min,
            "reorderMax": row.reorder_max,
            "stockValue": round(row.on_hand * row.cost) if row.cost is not None and row.on_hand > 0 else None,
        })
    out.sort(key=lambda r: (STOCK_STATUS_ORDER.index(r["status"]), r["daysOfCover"] if r["daysOfCover"] is not None else 1e9, r["name"] or ""))
    return out


# ── Day × hour ───────────────────────────────────────────────────────────────

WEAK_RATIO = 0.60
PEAK_RATIO = 1.40
#: A weekday-hour counts as open when it sold on at least this share of its weekdays.
OPEN_SHARE = 0.5
#: A slot is worth a card only when its usual takings are this share of an average day.
SLOT_MIN_DAY_SHARE = 0.03


@dataclass
class Cell:
    """
    One business day's one hour (or a whole day, summed): net = what sales collected less
    what credit notes paid back; docs = every document; sales = sale documents only (the
    baskets an average check is taken over). The rest feed the headline figures.
    """

    net: int = 0
    docs: int = 0
    sales: int = 0
    gross: int = 0
    discounts: int = 0
    refunds: int = 0
    refunds_count: int = 0
    tips: int = 0

    def add(self, other: "Cell") -> None:
        self.net += other.net
        self.docs += other.docs
        self.sales += other.sales
        self.gross += other.gross
        self.discounts += other.discounts
        self.refunds += other.refunds
        self.refunds_count += other.refunds_count
        self.tips += other.tips


def heatmap(
    cells: Mapping[Tuple[date, int], Cell],
    start: date,
    end: date,
    *,
    day_start_hour: int = 4,
    weak_ratio: float = WEAK_RATIO,
    peak_ratio: float = PEAK_RATIO,
    min_occurrences: int = 2,
) -> dict:
    """
    Weekday × hour over the business days `start`..`end`.

    * A day the shop sold nothing at all (closed: Shabbat, a holiday) is left out; a
      weekday that is always closed shows as closed, not as weak.
    * A cell's **typical** figure is the median over the open occurrences of its weekday
      (a zero hour on an open day counts) — one odd week (a holiday eve, a war week) does
      not move it; the mean is given beside it.
    * Weak and peak slots are judged against the mean of the same hour over the weekdays
      open at that hour (μₕ, at least three): weak at ≤ 60% of μₕ, peak at ≥ 140%. A
      weekday's opening span is its first to last hour that sold on at least half of its
      open days, so Friday afternoon (closed for Shabbat) is not "weak" while a dead
      Tuesday 16:00 inside the day is. Consecutive hours merge into one range; a range
      worth less than 3% of an average day is left out.
    """
    days = days_between(start, end)
    day_docs: Dict[date, int] = {}
    for (day, _hour), cell in cells.items():
        if start <= day <= end:
            day_docs[day] = day_docs.get(day, 0) + cell.docs
    open_days = [d for d in days if day_docs.get(d, 0) > 0]
    by_weekday: Dict[int, List[date]] = {w: [] for w in range(7)}
    for d in open_days:
        by_weekday[weekday_of(d)].append(d)
    occ = [len(by_weekday[w]) for w in range(7)]

    def values(w: int, h: int) -> List[int]:
        return [cells[(d, h)].net if (d, h) in cells else 0 for d in by_weekday[w]]

    def typical(w: int, h: int) -> float:
        v = values(w, h)
        return float(median(v)) if v else 0.0

    def mean(w: int, h: int) -> float:
        v = values(w, h)
        return sum(v) / len(v) if v else 0.0

    def active(w: int, h: int) -> float:
        ds = by_weekday[w]
        return sum(1 for d in ds if (d, h) in cells and cells[(d, h)].docs > 0) / len(ds) if ds else 0.0

    spans: Dict[int, Optional[Tuple[int, int]]] = {}
    for w in range(7):
        slots = [((h - day_start_hour) % 24) for h in range(24) if active(w, h) >= OPEN_SHARE]
        spans[w] = (min(slots), max(slots)) if slots else None

    def is_open(w: int, h: int) -> bool:
        span = spans[w]
        if span is None:
            return False
        s = (h - day_start_hour) % 24
        return span[0] <= s <= span[1]

    mu: Dict[int, Optional[float]] = {}
    for h in range(24):
        vals = [typical(w, h) for w in range(7) if is_open(w, h)]
        mu[h] = sum(vals) / len(vals) if len(vals) >= 3 else None

    sold_hours = {h for (d, h), c in cells.items() if start <= d <= end and c.docs}
    hours_present = sorted(sold_hours | {h for w in range(7) for h in range(24) if is_open(w, h)}, key=lambda h: (h - day_start_hour) % 24)
    open_cells = [typical(w, h) for w in range(7) for h in range(24) if is_open(w, h)]
    overall = sum(open_cells) / len(open_cells) if open_cells else 0.0
    out_cells = []
    for w in range(7):
        for h in hours_present:
            t = typical(w, h)
            docs = [cells[(d, h)].docs if (d, h) in cells else 0 for d in by_weekday[w]]
            out_cells.append({
                "weekday": w,
                "hour": h,
                "typicalNet": round(t),
                "avgNet": round(mean(w, h)),
                "avgDocs": round(sum(docs) / len(docs), 2) if docs else 0.0,
                "open": is_open(w, h),
                "index": round(t / overall, 3) if overall else 0.0,
                "vsHour": round(t / mu[h], 3) if mu.get(h) else None,
            })

    avg_day = sum(c.net for (d, _), c in cells.items() if start <= d <= end) / len(open_days) if open_days else 0.0

    def ranges(predicate) -> List[dict]:
        found = []
        for w in range(7):
            if occ[w] < min_occurrences:
                continue
            run: List[int] = []
            ordered = sorted((h for h in range(24) if is_open(w, h)), key=lambda h: (h - day_start_hour) % 24)
            for h in ordered + [None]:
                hit = h is not None and bool(mu.get(h)) and predicate(typical(w, h), mu[h])
                if hit:
                    if run and ((h - day_start_hour) % 24) != ((run[-1] - day_start_hour) % 24) + 1:
                        found.append(_slot_range(w, run, typical, mu, occ))
                        run = []
                    run.append(h)
                elif run:
                    found.append(_slot_range(w, run, typical, mu, occ))
                    run = []
        return [r for r in found if avg_day and r["usual"] >= SLOT_MIN_DAY_SHARE * avg_day]

    weak = ranges(lambda a, m: a <= weak_ratio * m)
    peak = ranges(lambda a, m: a >= peak_ratio * m)
    weak.sort(key=lambda r: -r["gapPerWeek"])
    peak.sort(key=lambda r: -r["gapPerWeek"])
    return {
        "occurrences": occ,
        "openDays": len(open_days),
        "closedDays": len(days) - len(open_days),
        "hours": hours_present,
        "cells": out_cells,
        "hourMeans": [{"hour": h, "avgNet": round(mu[h])} for h in hours_present if mu.get(h) is not None],
        "averageDay": round(avg_day),
        "weak": weak,
        "peak": peak,
        "spans": [
            {"weekday": w, "from": slot_hour(s[0], day_start_hour), "to": (slot_hour(s[1], day_start_hour) + 1) % 24} if s else {"weekday": w, "from": None, "to": None}
            for w, s in ((w, spans[w]) for w in range(7))
        ],
    }


def _slot_range(w: int, run: List[int], typical, mu, occ) -> dict:
    actual = sum(typical(w, h) for h in run)
    usual = sum(mu[h] for h in run)
    return {
        "weekday": w,
        "fromHour": run[0],
        "toHour": (run[-1] + 1) % 24,
        "typicalNet": round(actual),
        "usual": round(usual),
        "deviationPct": r1(change_pct(actual, usual)),
        # Per occurrence of the weekday, i.e. per week: what it is short of (or above) usual.
        "gapPerWeek": round(abs(usual - actual)),
        "occurrences": occ[w],
    }


def open_hours_by_weekday(spans: Sequence[dict]) -> List[int]:
    """Hours open per weekday, from `heatmap()['spans']` (0 for a closed weekday)."""
    out = []
    for s in spans:
        if s["from"] is None:
            out.append(0)
        else:
            out.append((s["to"] - s["from"]) % 24 or 24)
    return out


# ── Daily series, trends and anomalies ───────────────────────────────────────

BASELINE_WEEKS = 4
WOW_MIN_CHANGE = 10.0
ANOMALY_PCT = 25.0
PACE_PCT = 25.0
#: The pace is judged once this share of a usual day has been taken.
PACE_MIN_DAY_SHARE = 0.20
PRODUCT_TREND_PCT = 15.0
PRODUCT_TREND_MIN_UNITS = 20.0


def daily_totals(cells: Mapping[Tuple[date, int], Cell]) -> Dict[date, Cell]:
    days: Dict[date, Cell] = {}
    for (day, _hour), cell in cells.items():
        days.setdefault(day, Cell()).add(cell)
    return days


def same_weekday_samples(
    day: date,
    *,
    before: date,
    history_start: Optional[date],
    weeks: int = BASELINE_WEEKS,
    max_back: int = 12,
) -> List[date]:
    """The `weeks` most recent same-weekday dates before `before` (and not before history)."""
    out = []
    j = 1
    while len(out) < weeks and j <= max_back:
        candidate = day - timedelta(days=7 * j)
        j += 1
        if candidate >= before:
            continue
        if history_start is None or candidate < history_start:
            break
        out.append(candidate)
    return out


def baseline(daily: Mapping[date, Cell], day: date, *, history_start: Optional[date], weeks: int = BASELINE_WEEKS) -> Tuple[Optional[float], int]:
    """
    The median of the same weekday over the previous `weeks` weeks: one holiday or one
    bad week among four does not move it (an average would).
    """
    samples = same_weekday_samples(day, before=day, history_start=history_start, weeks=weeks)
    if not samples:
        return None, 0
    values = [daily[d].net if d in daily else 0 for d in samples]
    return float(median(values)), len(values)


def trend_series(
    daily: Mapping[date, Cell],
    start: date,
    end: date,
    *,
    history_start: Optional[date],
) -> List[dict]:
    out = []
    for day in days_between(start, end):
        cell = daily.get(day, Cell())
        base, n = baseline(daily, day, history_start=history_start)
        out.append({
            "date": day.isoformat(),
            "weekday": weekday_of(day),
            "net": cell.net,
            "docs": cell.docs,
            "baseline": round(base) if base is not None else None,
            "baselineWeeks": n,
            "deviationPct": r1(change_pct(cell.net, base)) if base else None,
        })
    return out


def window_sum(daily: Mapping[date, Cell], start: date, end: date) -> Cell:
    acc = Cell()
    for day in days_between(start, end):
        cell = daily.get(day)
        if cell is not None:
            acc.add(cell)
    return acc


def week_over_week(daily: Mapping[date, Cell], today: date, *, history_start: Optional[date]) -> Optional[dict]:
    """The last 7 complete business days against the 7 before them."""
    cur = window_sum(daily, today - timedelta(days=7), today - timedelta(days=1))
    if history_start is None or history_start > today - timedelta(days=14):
        return None
    prev = window_sum(daily, today - timedelta(days=14), today - timedelta(days=8))
    avg_cur = cur.net / cur.sales if cur.sales else 0
    avg_prev = prev.net / prev.sales if prev.sales else 0
    return {
        "from": (today - timedelta(days=7)).isoformat(),
        "to": (today - timedelta(days=1)).isoformat(),
        "net": cur.net,
        "netPrev": prev.net,
        "netChangePct": r1(change_pct(cur.net, prev.net)),
        "sales": cur.sales,
        "salesPrev": prev.sales,
        "salesChangePct": r1(change_pct(cur.sales, prev.sales)),
        "avgCheck": round(avg_cur),
        "avgCheckPrev": round(avg_prev),
        "avgCheckChangePct": r1(change_pct(avg_cur, avg_prev)),
    }


#: A day is judged only when its usual takings are at least this share of a usual day.
ANOMALY_MIN_DAY_SHARE = 0.25


def day_anomaly(daily: Mapping[date, Cell], day: date, *, history_start: Optional[date], threshold: float = ANOMALY_PCT) -> Optional[dict]:
    """
    A complete day against the median of its weekday's last four (at least three of
    them): flagged at ±25%, and only for a day that usually matters — its baseline at least
    a quarter of the median open day of the last four weeks (a quiet Saturday morning
    falling from ₪100 to ₪60 is not news).
    """
    base, n = baseline(daily, day, history_start=history_start)
    if base is None or n < 3 or base <= 0:
        return None
    recent = [c.net for d, c in daily.items() if day - timedelta(days=28) <= d < day and c.docs]
    if recent and base < ANOMALY_MIN_DAY_SHARE * median(recent):
        return None
    actual = daily[day].net if day in daily else 0
    dev = change_pct(actual, base)
    if dev is None or abs(dev) < threshold:
        return None
    return {"date": day.isoformat(), "weekday": weekday_of(day), "net": actual, "baseline": round(base), "deviationPct": r1(dev), "weeks": n}


@dataclass
class TrendItemIn:
    key: str
    name: str
    units: float
    units_prev: float
    net: int
    net_prev: int
    product_id: Optional[str] = None
    category_name: Optional[str] = None


def product_trends(
    items: Sequence[TrendItemIn],
    *,
    threshold: float = PRODUCT_TREND_PCT,
    min_units: float = PRODUCT_TREND_MIN_UNITS,
    limit: int = 8,
) -> dict:
    """
    This week against last week, per product: rising / falling when units moved by
    `threshold`% or more and the two weeks together sold at least `min_units` (so a
    product going from 1 to 2 is not "up 100%").
    """
    rising, falling = [], []
    for item in items:
        if item.units + item.units_prev < min_units or item.units_prev <= 0:
            continue
        change = change_pct(item.units, item.units_prev)
        if change is None:
            continue
        row = {
            "key": item.key,
            "productId": item.product_id,
            "name": item.name,
            "categoryName": item.category_name,
            "units": round(item.units, 3),
            "unitsPrev": round(item.units_prev, 3),
            "changePct": r1(change),
            "net": item.net,
            "netPrev": item.net_prev,
            "netChange": item.net - item.net_prev,
        }
        if change >= threshold:
            rising.append(row)
        elif change <= -threshold:
            falling.append(row)
    rising.sort(key=lambda r: (-r["netChange"], -r["changePct"]))
    falling.sort(key=lambda r: (r["netChange"], r["changePct"]))
    return {"rising": rising[:limit], "falling": falling[:limit]}


# ── Forecast ─────────────────────────────────────────────────────────────────

FORECAST_WEIGHTS = (4, 3, 2, 1)
OUTLIER_BAND = 0.5
BACKTEST_DAYS = 14


def _kept_samples(values: List[Tuple[date, int]]) -> List[Tuple[date, int]]:
    """Drops a sample more than 50% away from the median (a holiday, a closure)."""
    if len(values) < 3:
        return values
    med = median(v for _, v in values)
    if med <= 0:
        return values
    kept = [(d, v) for d, v in values if abs(v - med) <= OUTLIER_BAND * med]
    return kept if len(kept) >= 2 else values


def _weighted(values: Sequence[float]) -> float:
    weights = FORECAST_WEIGHTS[: len(values)]
    return sum(v * w for v, w in zip(values, weights)) / sum(weights)


def forecast_day(
    daily: Mapping[date, Cell],
    target: date,
    *,
    today: date,
    history_start: Optional[date],
) -> dict:
    """
    Seasonal naive, smoothed: the weighted average (4-3-2-1, most recent first) of the
    same weekday over the last four complete weeks, after dropping a week more than 50%
    off their median. With no same-weekday history, the average day of the last 14 days
    (low confidence).
    """
    samples = same_weekday_samples(target, before=today, history_start=history_start)
    values = [(d, daily[d].net if d in daily else 0) for d in samples]
    kept = _kept_samples(values)
    if kept:
        net = _weighted([v for _, v in kept])
        docs_values = [daily[d].docs if d in daily else 0 for d, _ in kept]
        docs = _weighted(docs_values)
        nets = [v for _, v in kept]
        low, high = (min(nets), max(nets)) if len(nets) >= 2 else (net * 0.75, net * 1.25)
        confidence = "high" if len(kept) >= 4 else "medium" if len(kept) >= 2 else "low"
        basis = [d.isoformat() for d, _ in kept]
    else:
        recent = [d for d in days_between(today - timedelta(days=14), today - timedelta(days=1)) if history_start is not None and d >= history_start]
        if not recent:
            return {"date": target.isoformat(), "weekday": weekday_of(target), "net": None, "docs": None, "low": None, "high": None, "confidence": "none", "basis": []}
        net = sum(daily[d].net if d in daily else 0 for d in recent) / len(recent)
        docs = sum(daily[d].docs if d in daily else 0 for d in recent) / len(recent)
        low, high = net * 0.7, net * 1.3
        confidence = "low"
        basis = []
    return {
        "date": target.isoformat(),
        "weekday": weekday_of(target),
        "net": round(net),
        "docs": round(docs, 1),
        "low": round(low),
        "high": round(high),
        "confidence": confidence,
        "basis": basis,
    }


def backtest(daily: Mapping[date, Cell], *, today: date, history_start: Optional[date], days: int = BACKTEST_DAYS) -> dict:
    """
    How the method did over the last `days` complete days, each forecast from its own past
    only: WAPE = Σ|forecast − actual| / Σ actual (unlike MAPE it survives a closed day), and
    accuracy = 100 − WAPE.
    """
    abs_error, actual_sum, n = 0.0, 0.0, 0
    for day in days_between(today - timedelta(days=days), today - timedelta(days=1)):
        actual = daily[day].net if day in daily else 0
        f = forecast_day(daily, day, today=day, history_start=history_start)
        if f["net"] is None or f["confidence"] in ("none", "low"):
            continue
        abs_error += abs(f["net"] - actual)
        actual_sum += max(actual, 0)
        n += 1
    if not n or actual_sum <= 0:
        return {"wape": None, "accuracy": None, "days": n}
    wape = abs_error / actual_sum * 100.0
    return {"wape": r1(wape), "accuracy": r1(max(0.0, 100.0 - wape)), "days": n}


def hourly_profile(
    hourly: Mapping[Tuple[date, int], Cell],
    daily: Mapping[date, Cell],
    sample_days: Sequence[str],
    *,
    day_start_hour: int,
    total: Optional[float],
) -> List[dict]:
    """
    Tomorrow by the hour: the day's forecast spread by the sample days' hourly shares
    (weighted like the forecast, most recent first), so the hours add up to the day.
    """
    days = [date.fromisoformat(d) for d in sample_days]
    if not days or not total:
        return []
    weights = FORECAST_WEIGHTS[: len(days)]
    day_sum = sum(w * (daily[d].net if d in daily else 0) for d, w in zip(days, weights))
    if day_sum <= 0:
        return []
    out = []
    for slot in range(24):
        hour = slot_hour(slot, day_start_hour)
        share = sum(w * (hourly[(d, hour)].net if (d, hour) in hourly else 0) for d, w in zip(days, weights)) / day_sum
        docs = _weighted([hourly[(d, hour)].docs if (d, hour) in hourly else 0 for d in days])
        if share <= 0 and docs <= 0:
            continue
        out.append({"hour": hour, "net": round(total * share), "share": round(share * 100.0, 1), "docs": round(docs, 1)})
    return out


def forecast(
    daily: Mapping[date, Cell],
    hourly: Mapping[Tuple[date, int], Cell],
    *,
    today: date,
    history_start: Optional[date],
    day_start_hour: int,
    horizon: int = 7,
) -> dict:
    days = [forecast_day(daily, today + timedelta(days=k), today=today, history_start=history_start) for k in range(1, horizon + 1)]
    tomorrow = days[0] if days else None
    known = [d["net"] for d in days if d["net"] is not None]
    week_total = sum(known) if len(known) == len(days) else None
    last_week = window_sum(daily, today - timedelta(days=7), today - timedelta(days=1)).net
    return {
        "today": today.isoformat(),
        "days": days,
        "tomorrowHourly": hourly_profile(hourly, daily, tomorrow["basis"], day_start_hour=day_start_hour, total=tomorrow["net"]) if tomorrow else [],
        "nextWeekTotal": week_total,
        "lastWeekTotal": last_week,
        "nextWeekChangePct": r1(change_pct(week_total, last_week)) if week_total is not None else None,
        "accuracy": backtest(daily, today=today, history_start=history_start),
    }


def today_pace(
    hourly: Mapping[Tuple[date, int], Cell],
    daily: Mapping[date, Cell],
    *,
    today: date,
    now_slot: int,
    now_fraction: float,
    history_start: Optional[date],
    day_start_hour: int,
) -> Optional[dict]:
    """
    Today so far against the same weekday of the last four weeks up to the same minute
    of the business day (hour slots, the current hour pro-rated). None without history.
    """
    samples = same_weekday_samples(today, before=today, history_start=history_start)
    if not samples:
        return None
    actual = sum(c.net for (d, _h), c in hourly.items() if d == today)
    expected_parts, full = [], []
    for s in samples:
        so_far = 0.0
        for slot in range(now_slot + 1):
            cell = hourly.get((s, slot_hour(slot, day_start_hour)))
            if cell is None:
                continue
            so_far += cell.net * (now_fraction if slot == now_slot else 1.0)
        expected_parts.append(so_far)
        full.append(daily[s].net if s in daily else 0)
    # The median when there are enough weeks for it to shrug off a holiday.
    expected = float(median(expected_parts)) if len(expected_parts) >= 3 else sum(expected_parts) / len(expected_parts)
    expected_full = float(median(full)) if len(full) >= 3 else sum(full) / len(full)
    projected = expected_full * (actual / expected) if expected > 0 else float(actual)
    return {
        "date": today.isoformat(),
        "weekday": weekday_of(today),
        "actual": actual,
        "expectedSoFar": round(expected),
        "lowSoFar": round(min(expected_parts)),
        "highSoFar": round(max(expected_parts)),
        "expectedFull": round(expected_full),
        "projected": round(projected),
        "pacePct": r1(change_pct(actual, expected)) if expected > 0 else None,
        "weeks": len(samples),
        "judgeable": expected_full > 0 and expected >= PACE_MIN_DAY_SHARE * expected_full and len(samples) >= 2,
        "asOfHour": slot_hour(now_slot, day_start_hour),
    }


# ── Baskets ──────────────────────────────────────────────────────────────────

PAIR_MIN_COUNT = 10
PAIR_MIN_SUPPORT = 0.005
PAIR_MIN_CONFIDENCE = 0.15
PAIR_MIN_LIFT = 1.2


def pair_min_count(baskets: int) -> int:
    """At least 10 baskets together, and at least 0.5% of all baskets."""
    return max(PAIR_MIN_COUNT, math.ceil(PAIR_MIN_SUPPORT * baskets))


def pair_metrics(
    pairs: Iterable[Tuple[str, str, int]],
    item_baskets: Mapping[str, int],
    baskets: int,
    *,
    names: Mapping[str, str],
    min_count: Optional[int] = None,
    min_confidence: float = PAIR_MIN_CONFIDENCE,
    min_lift: float = PAIR_MIN_LIFT,
    limit: int = 12,
) -> List[dict]:
    """
    Market-basket pairs: support = both / baskets; confidence(a→b) = both / baskets with a;
    lift = confidence(a→b) / support(b) — above 1, bought together more than chance.

    Kept from `min_count` baskets together, 15% confidence and a lift of 1.2 — the lift is
    what keeps out the item nearly everyone buys (coffee in half the baskets "goes with"
    everything at a lift near 1). Ranked by the baskets beyond chance, together − expected
    (expected = baskets(a) × baskets(b) / baskets): volume and strength in one number.
    """
    if baskets <= 0:
        return []
    floor = pair_min_count(baskets) if min_count is None else min_count
    out = []
    for a, b, together in pairs:
        ia, ib = item_baskets.get(a, 0), item_baskets.get(b, 0)
        if together < floor or not ia or not ib:
            continue
        lift = together * baskets / (ia * ib)
        # The stronger direction reads better: "x% of the X buyers also took Y".
        conf_ab, conf_ba = together / ia, together / ib
        first, second, conf = (a, b, conf_ab) if conf_ab >= conf_ba else (b, a, conf_ba)
        if lift < min_lift or conf < min_confidence:
            continue
        expected = ia * ib / baskets
        out.append({
            "a": first,
            "b": second,
            "aName": names.get(first, first),
            "bName": names.get(second, second),
            "together": together,
            "support": together / baskets * 100.0,
            "confidence": conf * 100.0,
            "lift": round(lift, 2),
            "excess": round(together - expected, 1),
        })
    out.sort(key=lambda r: (-r["excess"], -r["lift"], r["aName"]))
    return out[:limit]


def basket_sizes(distinct_items_per_basket: Iterable[Tuple[int, int]]) -> dict:
    """(distinct items in a basket, how many baskets) → buckets 1, 2, 3, 4, 5+."""
    buckets = {"1": 0, "2": 0, "3": 0, "4": 0, "5+": 0}
    total = 0
    for size, count in distinct_items_per_basket:
        if size <= 0:
            continue
        key = str(size) if size < 5 else "5+"
        buckets[key] += count
        total += count
    return {
        "buckets": [{"size": k, "baskets": v, "share": v / total * 100.0 if total else 0.0} for k, v in buckets.items()],
        "baskets": total,
        "singleItemShare": buckets["1"] / total * 100.0 if total else None,
    }


# ── Cashiers: discounts, refunds, voids ──────────────────────────────────────

CASHIER_MIN_SALES = 20
CASHIER_RATIO = 2.0
#: At this multiple of the team's rate a flag is "high".
CASHIER_HIGH_RATIO = 3.0
CASHIER_FLOORS = {"discount": 3.0, "refund": 1.0, "void": 1.5}


@dataclass
class CashierIn:
    cashier_id: Optional[str]
    name: Optional[str]
    sales: int = 0
    gross: int = 0
    #: Taken off by hand (the document's discount less what promotions took).
    discounts: int = 0
    promotions: int = 0
    refunds_count: int = 0
    refunds: int = 0
    voids_count: int = 0
    voids: int = 0
    cancels_count: int = 0
    cancels: int = 0


def _cashier_rates(c: CashierIn) -> Dict[str, Optional[float]]:
    """Discounts over gross sales; refunds and voids over net sales (Toast's void %)."""
    net_sales = c.gross - c.discounts - c.promotions
    return {
        "discount": pct(c.discounts, c.gross),
        "refund": pct(c.refunds, net_sales) if net_sales > 0 else None,
        "void": pct(c.voids, net_sales) if net_sales > 0 else None,
    }


def cashier_rates(
    rows: Sequence[CashierIn],
    *,
    min_sales: int = CASHIER_MIN_SALES,
    ratio: float = CASHIER_RATIO,
    floors: Mapping[str, float] = CASHIER_FLOORS,
) -> dict:
    """
    Each employee's manual-discount, refund and void rates against the team's (weighted).
    Flagged when the rate is at least `ratio` × the team's **and** above an absolute floor
    (3% discounts, 1% refunds, 1.5% voids — below those it is normal business whatever
    the team does) **and** the employee rang `min_sales` sales; "high" from 3×. An
    outlier worth a look in the exceptions, never a verdict.
    """
    team = CashierIn(cashier_id=None, name=None)
    for c in rows:
        team.sales += c.sales
        team.gross += c.gross
        team.discounts += c.discounts
        team.promotions += c.promotions
        team.refunds_count += c.refunds_count
        team.refunds += c.refunds
        team.voids_count += c.voids_count
        team.voids += c.voids
        team.cancels_count += c.cancels_count
        team.cancels += c.cancels
    team_rates = _cashier_rates(team)
    out = []
    for c in rows:
        rates = _cashier_rates(c)
        flags = []
        if c.sales >= min_sales:
            for metric in ("discount", "refund", "void"):
                rate, base = rates[metric], team_rates[metric]
                if rate is None or rate < floors[metric]:
                    continue
                if base and rate >= ratio * base:
                    flags.append({
                        "metric": metric, "rate": r1(rate), "team": r1(base), "times": round(rate / base, 1),
                        "level": "high" if rate >= CASHIER_HIGH_RATIO * base else "elevated",
                    })
        out.append({
            "cashierId": c.cashier_id,
            "name": c.name,
            "sales": c.sales,
            "gross": c.gross,
            "discounts": c.discounts,
            "promotions": c.promotions,
            "refundsCount": c.refunds_count,
            "refunds": c.refunds,
            "voidsCount": c.voids_count,
            "voids": c.voids,
            "cancelsCount": c.cancels_count,
            "cancels": c.cancels,
            "discountPct": r1(rates["discount"]),
            "refundPct": r1(rates["refund"]),
            "voidPct": r1(rates["void"]),
            "flags": flags,
        })
    out.sort(key=lambda r: (-len(r["flags"]), -r["gross"]))
    return {
        "team": {
            "sales": team.sales,
            "gross": team.gross,
            "discounts": team.discounts,
            "promotions": team.promotions,
            "refunds": team.refunds,
            "voids": team.voids,
            "discountPct": r1(team_rates["discount"]),
            "refundPct": r1(team_rates["refund"]),
            "voidPct": r1(team_rates["void"]),
        },
        "rows": out,
        "minSales": min_sales,
        "ratio": ratio,
        "floors": dict(floors),
    }


# ── Tables ───────────────────────────────────────────────────────────────────

#: An open table is "long" past max(this, twice the usual seated time).
LONG_OPEN_MINUTES = 120
#: Seating times beyond this are an order left open, not a meal; not averaged.
MAX_SEATED_MINUTES = 12 * 60


@dataclass
class OpenTableIn:
    table_id: str
    number: Optional[int]
    name: Optional[str]
    zone_name: Optional[str]
    shop_id: Optional[str]
    shop_name: Optional[str]
    guests: Optional[int]
    total: int
    opened_at: Optional[datetime]
    state: str = "occupied"
    seats: Optional[int] = None
    opened_by: Optional[str] = None


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def minutes_between(start: Optional[datetime], end: Optional[datetime]) -> Optional[float]:
    start, end = _aware(start), _aware(end)
    if start is None or end is None or end < start:
        return None
    return (end - start).total_seconds() / 60.0


def tables_live(
    orders: Sequence[OpenTableIn],
    *,
    tables_total: int,
    seats_total: int,
    now: datetime,
    usual_minutes: Optional[float] = None,
    limit: int = 12,
) -> dict:
    """Open tables now: how many, guests, the open amount, the longest seated, occupancy."""
    long_after = max(LONG_OPEN_MINUTES, 2 * usual_minutes) if usual_minutes else LONG_OPEN_MINUTES
    rows = []
    for o in orders:
        minutes = minutes_between(o.opened_at, now)
        rows.append({
            "tableId": o.table_id,
            "number": o.number,
            "name": o.name,
            "zoneName": o.zone_name,
            "shopId": o.shop_id,
            "shopName": o.shop_name,
            "guests": o.guests,
            "total": o.total,
            "openedAt": _aware(o.opened_at).isoformat() if o.opened_at else None,
            "minutesOpen": int(minutes) if minutes is not None else None,
            "state": o.state,
            "seats": o.seats,
            "openedBy": o.opened_by,
            "long": minutes is not None and minutes >= long_after,
        })
    rows.sort(key=lambda r: -(r["minutesOpen"] or 0))
    guests = sum(o.guests or 0 for o in orders)
    minutes_list = [r["minutesOpen"] for r in rows if r["minutesOpen"] is not None]
    by_shop: Dict[Optional[str], dict] = {}
    for r in rows:
        s = by_shop.setdefault(r["shopId"], {"shopId": r["shopId"], "shopName": r["shopName"], "openTables": 0, "guests": 0, "openAmount": 0})
        s["openTables"] += 1
        s["guests"] += r["guests"] or 0
        s["openAmount"] += r["total"]
    return {
        "openTables": len(orders),
        "guests": guests,
        "openAmount": sum(o.total for o in orders),
        "tablesTotal": tables_total,
        "seatsTotal": seats_total,
        "occupancyPct": r1(pct(len(orders), tables_total)),
        "seatUsePct": r1(pct(guests, seats_total)),
        "awaitingPayment": sum(1 for o in orders if o.state == "awaiting_payment"),
        "avgMinutesOpen": round(sum(minutes_list) / len(minutes_list)) if minutes_list else None,
        "longest": rows[0] if rows else None,
        "longAfterMinutes": round(long_after),
        "longOpen": sum(1 for r in rows if r["long"]),
        "byShop": sorted(by_shop.values(), key=lambda s: -s["openTables"]),
        "tables": rows[:limit],
    }


@dataclass
class PaidTableIn:
    table_id: Optional[str]
    opened_at: Optional[datetime]
    closed_at: Optional[datetime]
    guests: Optional[int]
    amount: int


PARTY_BUCKETS = (("1-2", 1, 2), ("3-4", 3, 4), ("5-6", 5, 6), ("7+", 7, 10_000))


def tables_period(
    orders: Sequence[PaidTableIn],
    *,
    tables_total: int,
    seats_total: int,
    days: int,
    open_hours: Optional[float] = None,
) -> dict:
    """
    The tables over a period, paid orders by when they were paid: covers (guests), average
    spend per cover (orders that recorded guests only), average per table order, seated
    time (opened → paid; a table left open over 12 h is not a meal and is not averaged),
    turnover (orders per table per day) and revenue per seat per day.

    With the hours the place was open over the period (`open_hours`, from the heat map's
    opening spans): RevPASH = revenue / (seats × open hours), and seat occupancy =
    Σ guests × hours seated / (seats × open hours).
    """
    n = len(orders)
    revenue = sum(o.amount for o in orders)
    with_guests = [o for o in orders if (o.guests or 0) > 0]
    covers = sum(o.guests for o in with_guests)
    revenue_with_guests = sum(o.amount for o in with_guests)
    minutes = []
    guest_hours = 0.0
    for o in orders:
        m = minutes_between(o.opened_at, o.closed_at)
        if m is not None and 0 < m <= MAX_SEATED_MINUTES:
            minutes.append(m)
            guest_hours += (o.guests or 0) * m / 60.0
    seat_hours = seats_total * open_hours if seats_total and open_hours else None
    buckets = []
    for label, lo, hi in PARTY_BUCKETS:
        group = [o for o in with_guests if lo <= o.guests <= hi]
        if not group:
            continue
        gm = [m for m in (minutes_between(o.opened_at, o.closed_at) for o in group) if m is not None and 0 < m <= MAX_SEATED_MINUTES]
        g_covers = sum(o.guests for o in group)
        buckets.append({
            "party": label,
            "orders": len(group),
            "avgMinutes": round(sum(gm) / len(gm)) if gm else None,
            "spendPerCover": round(sum(o.amount for o in group) / g_covers) if g_covers else None,
        })
    return {
        "orders": n,
        "revenue": revenue,
        "covers": covers,
        "spendPerCover": round(revenue_with_guests / covers) if covers else None,
        "avgPerOrder": round(revenue / n) if n else None,
        "avgSeatedMinutes": round(sum(minutes) / len(minutes)) if minutes else None,
        "medianSeatedMinutes": round(median(minutes)) if minutes else None,
        "turnover": round(n / tables_total / days, 2) if tables_total and days else None,
        "revenuePerSeatDay": round(revenue / seats_total / days) if seats_total and days else None,
        "revPash": round(revenue / seat_hours) if seat_hours else None,
        "seatOccupancyPct": r1(guest_hours / seat_hours * 100.0) if seat_hours else None,
        "openHours": round(open_hours, 1) if open_hours else None,
        "guestsRecordedPct": r1(pct(len(with_guests), n)),
        "byParty": buckets,
    }


# ── Customers ────────────────────────────────────────────────────────────────


def customers_summary(rows: Sequence[Tuple[str, int, int]], *, sales: int, net: int) -> Optional[dict]:
    """(customer, documents, net agorot) per identified customer → repeat figures."""
    if not rows:
        return None
    identified_docs = sum(d for _, d, _ in rows)
    repeat = [r for r in rows if r[1] >= 2]
    return {
        "customers": len(rows),
        "identifiedDocs": identified_docs,
        "identifiedPct": r1(pct(identified_docs, sales)),
        "repeatCustomers": len(repeat),
        "repeatPct": r1(pct(len(repeat), len(rows))),
        "repeatNet": sum(r[2] for r in repeat),
        "repeatNetPct": r1(pct(sum(r[2] for r in repeat), net)),
        "visitsPerCustomer": round(identified_docs / len(rows), 2),
    }
