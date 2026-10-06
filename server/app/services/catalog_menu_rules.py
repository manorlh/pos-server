"""
"תפריטים" — the rules, pure (docs/SPEC_MENUS.md §3).

The one computation of which menu is active and what it sells. The till and the kiosk run
the same computation on their own clock (pos-android `domain/CatalogMenus.kt`), offline;
the shared golden fixtures (`tests/fixtures/catalog_menus_golden.json`, the same bytes in
pos-android's test resources) pin both to the same answers. Change one, change both.

Everything here works on the `catalogMenus` block exactly as the catalog pull carries it
(app/services/catalog_menus.py builds it):

    {
      "fallback": "catalog" | "none",
      "menus": [{"id", "name", "channel": "pos" | "kiosk" | "both",
                 "schedule": {"always", "days": [0..6] | null, "ranges": [["HH:MM", "HH:MM"]],
                              "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null},
                 "categories": [{"id", "all": bool}], "products": [{"id", "price"?}]}],
      "assignments": [{"menuId", "level": "machine" | "area" | "shop" | "company",
                       "depth": int, "priority": int}]
    }

**When** (`schedule_active`) — on the local wall clock (the shop's): a weekday (0 = Sunday)
and a minute. A range `[start, end)` with `end` <= `start` crosses midnight, and the hours
after midnight belong to the day it started — its weekday and its date (`00:00–00:00` is
the whole day). No ranges: the whole day (ranges none of which reads: never). `days` null:
every day; empty: never. `always`: any hour of any day; the date range still applies. On
the night clocks move, the wall clock is what counts: a range inside the skipped hour never
starts, and the repeated hour is in a range twice.

**Which** (`resolve`) — among the assigned menus that are active now and offered on this
surface (`pos` — the sell screen; `kiosk` — the self-order kiosk): the most specific level
wins (till > point of sale > shop > the till's company > the company above it…); within a
level the higher priority; then the name, then the id — so two tills never disagree. None
active: the fallback ("catalog" — the catalog as without menus; "none" — nothing to sell).

**What** (`apply`) — the menu over the till's catalog: the menu's categories in its order
(then those of products it lists from a category it does not), each with the listed
products first in the menu's order and then — for a category with all of its products —
the rest in the till's own order. A listed price replaces the catalog's while the menu is
active ("menu"); every other product keeps the catalog's ("catalog"). A category left with
nothing is dropped. Availability is not this function's: a blocked or sold-out product
stays in the list, blocked, exactly as without menus.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

SURFACE_POS = "pos"
SURFACE_KIOSK = "kiosk"
SURFACES = (SURFACE_POS, SURFACE_KIOSK)

MODE_MENU = "menu"
MODE_CATALOG = "catalog"
MODE_NONE = "none"

PRICE_MENU = "menu"
PRICE_CATALOG = "catalog"

#: The levels, most specific first; a company's `depth` is how far above the till's own.
LEVEL_RANK = {"machine": 3, "area": 2, "shop": 1, "company": 0}


# ── Reading the block ────────────────────────────────────────────────────────


def minutes(value: Any) -> Optional[int]:
    """`"HH:MM"` (exactly two digits each) → minutes after midnight (0–1439); anything else → None."""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    hh, mm = value[:2], value[3:]
    if not (hh.isascii() and hh.isdigit() and mm.isascii() and mm.isdigit()):
        return None
    h, m = int(hh), int(mm)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def _date(value: Any) -> Optional[date]:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def weekday(d: date) -> int:
    """0 = Sunday (א׳) … 6 = Saturday (ש׳)."""
    return (d.weekday() + 1) % 7


def _ranges(schedule: Dict[str, Any]) -> List[Tuple[int, int]]:
    out = []
    for r in schedule.get("ranges") or []:
        if isinstance(r, dict):
            start, end = minutes(r.get("start")), minutes(r.get("end"))
        elif isinstance(r, (list, tuple)) and len(r) == 2:
            start, end = minutes(r[0]), minutes(r[1])
        else:
            continue
        if start is not None and end is not None:
            out.append((start, end))
    return out


def channel_accepts(channel: Any, surface: str) -> bool:
    """A menu's channel offered on `surface` ("pos" / "kiosk"). Unknown: both."""
    c = (channel or "both") if isinstance(channel, str) else "both"
    if c == "pos":
        return surface == SURFACE_POS
    if c == "kiosk":
        return surface == SURFACE_KIOSK
    return True


# ── When ─────────────────────────────────────────────────────────────────────


def schedule_active(schedule: Optional[Dict[str, Any]], at: datetime) -> bool:
    """Whether a menu with `schedule` is active at the local wall-clock moment `at`."""
    schedule = schedule or {}
    day = at.date()
    t = at.hour * 60 + at.minute
    days = schedule.get("days")
    day_set = None if days is None else {int(d) for d in days if isinstance(d, int) or str(d).isdigit()}
    start_date, end_date = _date(schedule.get("from")), _date(schedule.get("to"))

    def date_ok(d: date) -> bool:
        return (start_date is None or d >= start_date) and (end_date is None or d <= end_date)

    def day_ok(d: date) -> bool:
        return (day_set is None or weekday(d) in day_set) and date_ok(d)

    if schedule.get("always"):
        return date_ok(day)
    ranges = _ranges(schedule)
    if not ranges:
        # No ranges: the whole day. Ranges none of which reads: never (not all day).
        return day_ok(day) and not schedule.get("ranges")
    yesterday = day - timedelta(days=1)
    for start, end in ranges:
        if end > start:
            if start <= t < end and day_ok(day):
                return True
        else:
            # Crosses midnight: from `start` to the end of the day it started, and on to
            # `end` the next morning — which still belongs to that day.
            if t >= start and day_ok(day):
                return True
            if t < end and day_ok(yesterday):
                return True
    return False


# ── Which ────────────────────────────────────────────────────────────────────


def rank(assignment: Dict[str, Any]) -> int:
    level = LEVEL_RANK.get(assignment.get("level"), -1)
    depth = assignment.get("depth") or 0
    try:
        depth = max(0, min(99, int(depth)))
    except (TypeError, ValueError):
        depth = 0
    return level * 100 - depth


def _priority(assignment: Dict[str, Any]) -> int:
    try:
        return int(assignment.get("priority") or 0)
    except (TypeError, ValueError):
        return 0


def fallback_of(block: Optional[Dict[str, Any]]) -> str:
    mode = (block or {}).get("fallback")
    return MODE_NONE if mode == MODE_NONE else MODE_CATALOG


def resolve(block: Optional[Dict[str, Any]], at: datetime, surface: str = SURFACE_POS) -> Dict[str, Any]:
    """
    The menu active at local `at` on `surface`:
    `{"mode": "menu" | "catalog" | "none", "menuId", "menuName", "level", "depth", "priority"}`.
    """
    block = block or {}
    menus = {m.get("id"): m for m in block.get("menus") or [] if isinstance(m, dict) and m.get("id")}
    candidates = []
    for a in block.get("assignments") or []:
        if not isinstance(a, dict):
            continue
        m = menus.get(a.get("menuId"))
        if m is None or not channel_accepts(m.get("channel"), surface):
            continue
        if not schedule_active(m.get("schedule"), at):
            continue
        candidates.append((-rank(a), -_priority(a), m.get("name") or "", m.get("id") or "", a, m))
    if not candidates:
        return {
            "mode": fallback_of(block), "menuId": None, "menuName": None,
            "level": None, "depth": None, "priority": None,
        }
    candidates.sort(key=lambda c: c[:4])
    _, _, _, _, a, m = candidates[0]
    return {
        "mode": MODE_MENU,
        "menuId": m.get("id"),
        "menuName": m.get("name"),
        "level": a.get("level"),
        "depth": a.get("depth") or 0,
        "priority": _priority(a),
    }


def menu_by_id(block: Optional[Dict[str, Any]], menu_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not menu_id:
        return None
    found = None
    # The last one of an id, as `resolve` reads them.
    for m in (block or {}).get("menus") or []:
        if isinstance(m, dict) and m.get("id") == menu_id:
            found = m
    return found


def boundaries(block: Optional[Dict[str, Any]], start: datetime, days: int = 8) -> List[datetime]:
    """
    Every local moment after `start` (within `days`) at which some menu of the block may
    start or stop: each range's edges, and midnight. Between two of them nothing changes.
    """
    marks = {0}
    for m in (block or {}).get("menus") or []:
        for s, e in _ranges((m or {}).get("schedule") or {}):
            marks.add(s)
            marks.add(e)
    base = datetime(start.year, start.month, start.day)
    out = []
    for i in range(days + 1):
        d = base + timedelta(days=i)
        for mark in sorted(marks):
            moment = d + timedelta(minutes=mark)
            if moment > start:
                out.append(moment)
    return out


def next_change(
    block: Optional[Dict[str, Any]], at: datetime, surface: str = SURFACE_POS, days: int = 8,
) -> Optional[Dict[str, Any]]:
    """When what `resolve` says next changes, within `days`: `{"at", **resolution}`; None if never."""
    now = resolve(block, at, surface)
    key = (now["mode"], now["menuId"])
    for moment in boundaries(block, at, days):
        then = resolve(block, moment, surface)
        if (then["mode"], then["menuId"]) != key:
            return {"at": moment, **then}
    return None


# ── What ─────────────────────────────────────────────────────────────────────


def _money(value: Any) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    try:
        # HALF_UP, as the till turns shekels into agorot (core/Money.kt).
        return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return None


def apply(menu: Optional[Dict[str, Any]], products: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """
    `menu` over the till's `products` (`[{"id", "categoryId", "price"}]`, in the till's own
    order): `{"categories": [ids in order], "products": [{"id", "categoryId", "price",
    "priceSource"}] in order}`. Prices are strings with two decimals (to the agora).
    """
    menu = menu or {}
    order: List[str] = []
    all_of: Dict[str, bool] = {}
    for c in menu.get("categories") or []:
        cid = (c or {}).get("id")
        if cid and cid not in all_of:
            order.append(cid)
            all_of[cid] = bool(c.get("all", True))
    listed: Dict[str, int] = {}
    prices: Dict[str, Optional[Decimal]] = {}
    for i, p in enumerate(menu.get("products") or []):
        pid = (p or {}).get("id")
        if pid and pid not in listed:
            listed[pid] = i
            prices[pid] = _money(p.get("price"))

    by_category: Dict[str, List[Dict[str, Any]]] = {}
    for p in products:
        by_category.setdefault(p.get("categoryId"), []).append(p)
    # A product listed from a category the menu does not name brings its category, after.
    for p in sorted((p for p in products if p.get("id") in listed), key=lambda p: listed[p["id"]]):
        cid = p.get("categoryId")
        if cid and cid not in all_of:
            order.append(cid)
            all_of[cid] = False

    out_categories: List[str] = []
    out_products: List[Dict[str, Any]] = []
    for cid in order:
        inside = by_category.get(cid) or []
        first = sorted((p for p in inside if p.get("id") in listed), key=lambda p: listed[p["id"]])
        rest = [p for p in inside if p.get("id") not in listed] if all_of[cid] else []
        chosen = first + rest
        if not chosen:
            continue
        out_categories.append(cid)
        for p in chosen:
            own = prices.get(p.get("id"))
            price = own if own is not None else (_money(p.get("price")) or Decimal("0.00"))
            out_products.append({
                "id": p.get("id"),
                "categoryId": cid,
                "price": f"{price:.2f}",
                "priceSource": PRICE_MENU if own is not None else PRICE_CATALOG,
            })
    return {"categories": out_categories, "products": out_products}


def sellable(
    block: Optional[Dict[str, Any]], at: datetime, surface: str, products: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    What the till offers at `at` on `surface`: the resolution, and the menu applied —
    or, with no menu, the catalog as it is ("catalog") or nothing ("none").
    """
    r = resolve(block, at, surface)
    if r["mode"] == MODE_MENU:
        applied = apply(menu_by_id(block, r["menuId"]), products)
    elif r["mode"] == MODE_NONE:
        applied = {"categories": [], "products": []}
    else:
        applied = None
    return {"resolution": r, "applied": applied}


def iter_menu_product_ids(block: Optional[Dict[str, Any]]) -> Iterable[str]:
    for m in (block or {}).get("menus") or []:
        for p in (m or {}).get("products") or []:
            if (p or {}).get("id"):
                yield p["id"]
