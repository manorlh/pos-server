"""
"אזל" / "חסום" — the rule a till and the cloud share, pure (no database).

A product may carry several blocks at once ("חסימות"), each for a scope. The cloud sends a till,
on each product row of its catalog, the blocks in force that cover it (`blocks`); the till runs
`decide` over them with its own clock and its own stock. The cloud runs the same function for
the dashboard's quick stock screen. Pinned on both sides by the golden cases in
tests/fixtures/sold_out_golden.json (pos-android keeps the same bytes in app/src/test/resources;
its `SoldOutRules` must agree case by case). The owner's options and precedence:
specs/item-blocks-targets.md.

**Two axes.** A block has a **level** (`scope` / `scopeId`) and a **target** — whom at that level:

* `all` (the default) — "קופות וקיוסקים": every device the level reaches;
* `kiosks` — "קיוסקים בלבד": only the devices that are kiosks — the tills keep selling;
* `tills` — "קופות בלבד": only the devices that are not kiosks — the kiosks keep selling.

**Levels** (`scope`):

* `company` — the company's shops; `shop` — the shop (`scopeId` = the shop);
* `area` — the devices standing in that point of sale;
* `machine` — one device; `event` — the devices of an event ("אירועים");
* `group` — a group of devices (`machine_groups`);
* the two older scopes stay readable: `kiosks` = `shop` + target `kiosks`, `kiosk` = `machine` +
  target `kiosks` (an older scope with target `tills` contradicts itself and covers nobody).

**What** — a block names a product (`productId`) or a category (`categoryId`, every product in it
or below it). A row the cloud sent on one product's catalog row is that product's already; `item`
lets a caller check it (`applies`), and a block naming neither (an older till's stored form)
applies to the row it came on.

**In force** from when it was set until `until` (exclusive), or until removed when it has none.

**The answer**, for one device and one product:

1. any block in force of kind `blocked` covers it → **blocked** ("חסום"), never sold by the till;
2. else any of kind `sold_out` → **sold out** ("אזל"); a manager may approve a sale with the
   manager code (`overridable`);
3. else, with `autoSoldOutAtZero` on (unless a layer turns it off), a product that tracks stock
   and has none where the till sells from (on hand ≤ 0; a missing level is 0) → **sold out**,
   reason `stock`;
4. else available.

The block shown (and its reason / end) is the nearest level among those of the deciding kind,
then a product's own block before its category's, then the newest. **On a kiosk** (`display`):
any block in force asking `hide` hides it; else any asking `grey` shows it greyed "אזל" even
where `general.soldOutMode` hides sold-out items; else that setting decides.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, List, Mapping, Optional, Sequence

SETTING_AUTO = "autoSoldOutAtZero"

AVAILABLE, SOLD_OUT, BLOCKED = "available", "sold_out", "blocked"
KINDS = (SOLD_OUT, BLOCKED)
MANUAL, AUTO, STOCK = "manual", "auto", "stock"

#: Whom at the level: "קופות וקיוסקים" / "קיוסקים בלבד" / "קופות בלבד".
TARGET_ALL, TARGET_KIOSKS, TARGET_TILLS = "all", "kiosks", "tills"
TARGETS = (TARGET_ALL, TARGET_KIOSKS, TARGET_TILLS)
#: A kiosk's own look for one block: "הסתר" / "הצג כאזל"; None = `general.soldOutMode`.
DISPLAY_HIDE, DISPLAY_GREY = "hide", "grey"
DISPLAYS = (DISPLAY_HIDE, DISPLAY_GREY)

#: Nearest first: the block a till shows when several of one kind cover it.
SCOPE_ORDER: Sequence[str] = ("machine", "kiosk", "area", "group", "event", "kiosks", "shop", "company")
SCOPES = tuple(SCOPE_ORDER)
#: The levels a new block is written at (the two older scopes fold into `shop` / `machine`).
LEVELS = ("company", "shop", "event", "group", "area", "machine")
#: The two older scopes: their level, and the target they always meant.
LEGACY_SCOPES = {"kiosks": ("shop", TARGET_KIOSKS), "kiosk": ("machine", TARGET_KIOSKS)}


@dataclass(frozen=True)
class Till:
    """Who a till is, for `covers`."""

    company_id: Optional[str] = None
    shop_id: Optional[str] = None
    area_id: Optional[str] = None
    machine_id: Optional[str] = None
    is_kiosk: bool = False
    event_ids: Sequence[str] = field(default_factory=tuple)
    group_ids: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class Item:
    """The product a block is checked against: its id, and its category with every one above it."""

    product_id: Optional[str] = None
    category_ids: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class Decision:
    state: str
    #: manual | auto | stock (sold out); the block's reason text (blocked) is on `block`.
    reason: Optional[str] = None
    #: The block shown (a mapping as given), None for the stock rule or available.
    block: Optional[Mapping[str, Any]] = None
    until: Optional[datetime] = None
    #: On a kiosk: "hide" / "grey" asked by a block in force, None = `general.soldOutMode`.
    display: Optional[str] = None

    @property
    def sold_out(self) -> bool:
        return self.state == SOLD_OUT

    @property
    def blocked(self) -> bool:
        return self.state == BLOCKED

    @property
    def sellable(self) -> bool:
        return self.state == AVAILABLE

    @property
    def overridable(self) -> bool:
        """A manager may approve a sale anyway (manager code on the till)."""
        return self.state == SOLD_OUT


def parse_time(value: Any) -> Optional[datetime]:
    """An ISO-8601 instant (a trailing Z is UTC; no zone is UTC), or None."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def auto_on(setting: Any) -> bool:
    """`autoSoldOutAtZero` as stored in a settings layer: on unless explicitly off."""
    if setting is None:
        return True
    if isinstance(setting, bool):
        return setting
    if isinstance(setting, str):
        return setting.strip().lower() not in ("false", "0", "no", "off")
    if isinstance(setting, (int, float)):
        return setting != 0
    return True


def in_force(until: Any, now: datetime) -> bool:
    """A block with this `until` is still in force at `now`."""
    end = parse_time(until)
    return end is None or now < end


_ATTRS = {
    "scopeId": "scope_id", "createdAt": "created_at", "productId": "product_id",
    "categoryId": "category_id", "kioskDisplay": "kiosk_display",
}


def _get(block: Any, key: str) -> Any:
    if isinstance(block, Mapping):
        return block.get(key)
    return getattr(block, _ATTRS.get(key, key), None)


def _str(value: Any) -> Optional[str]:
    return None if value is None or value == "" else str(value)


def kind_of(block: Any) -> str:
    return BLOCKED if _get(block, "kind") == BLOCKED else SOLD_OUT


def target_of(block: Any) -> str:
    """The block's target as written (`all` when it has none — every block before targets)."""
    target = _get(block, "target")
    return TARGET_ALL if target is None or target == "" else str(target)


def level_of(block: Any) -> tuple:
    """`(level, target)`: an older `kiosks` / `kiosk` block read as `shop` / `machine` + kiosks."""
    scope = _get(block, "scope")
    target = target_of(block)
    legacy = LEGACY_SCOPES.get(scope)
    if legacy is not None:
        level, implied = legacy
        # "All the shop's kiosks" for the tills only: a contradiction, never a wider block.
        return (level, implied if target in (TARGET_ALL, TARGET_KIOSKS) else None)
    return (scope, target)


def normalize(scope: str, target: Optional[str]) -> tuple:
    """What a new block is written as: an older scope folded into its level + target kiosks."""
    target = target or TARGET_ALL
    legacy = LEGACY_SCOPES.get(scope)
    if legacy is not None:
        if target == TARGET_TILLS:
            raise ValueError("target_conflict")
        return legacy
    return (scope, target)


def target_reaches(target: Optional[str], is_kiosk: bool) -> bool:
    """Whom a target reaches: a kiosk, or a device that is not one."""
    if target == TARGET_ALL:
        return True
    if target == TARGET_KIOSKS:
        return bool(is_kiosk)
    if target == TARGET_TILLS:
        return not is_kiosk
    return False


def level_covers(level: Any, sid: str, till: Till) -> bool:
    if level == "company":
        return till.company_id is not None and sid == str(till.company_id)
    if level == "shop":
        return till.shop_id is not None and sid == str(till.shop_id)
    if level == "area":
        return till.area_id is not None and sid == str(till.area_id)
    if level == "machine":
        return till.machine_id is not None and sid == str(till.machine_id)
    if level == "event":
        return sid in {str(e) for e in till.event_ids}
    if level == "group":
        return sid in {str(g) for g in till.group_ids}
    return False


def covers(block: Any, till: Till) -> bool:
    """Whether `block` reaches this device: its level covers it, and its target is for it."""
    level, target = level_of(block)
    return target_reaches(target, till.is_kiosk) and level_covers(level, str(_get(block, "scopeId")), till)


def applies(block: Any, item: Optional[Item]) -> bool:
    """Whether `block` is about this product: itself, or its category (or one above it)."""
    if item is None:
        return True
    product = _str(_get(block, "productId"))
    category = _str(_get(block, "categoryId"))
    if product is not None:
        return item.product_id is not None and product == str(item.product_id)
    if category is not None:
        return category in {str(c) for c in item.category_ids}
    # Neither named (an older stored form): it came on this product's own row.
    return True


def _rank(block: Any) -> int:
    scope = _get(block, "scope")
    return SCOPE_ORDER.index(scope) if scope in SCOPE_ORDER else len(SCOPE_ORDER)


def _category_rank(block: Any) -> int:
    """A product's own block before its category's."""
    return 1 if _str(_get(block, "productId")) is None and _str(_get(block, "categoryId")) is not None else 0


def _created(block: Any) -> datetime:
    try:
        return parse_time(_get(block, "createdAt")) or datetime.min.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def nearest(blocks: Iterable[Any]) -> Optional[Any]:
    """The block shown among these: the nearest level, then the product's own, then the newest."""
    best = None
    for b in blocks:
        if best is None:
            best = b
            continue
        key_b = (_rank(b), _category_rank(b))
        key_best = (_rank(best), _category_rank(best))
        if key_b < key_best or (key_b == key_best and _created(b) > _created(best)):
            best = b
    return best


def active_covering(
    blocks: Iterable[Any], till: Optional[Till], now: datetime, item: Optional[Item] = None,
) -> List[Any]:
    """The blocks in force at `now` that reach the till (`till` None: already filtered for it) and the item."""
    return [
        b for b in blocks
        if in_force(_get(b, "until"), now) and (till is None or covers(b, till)) and applies(b, item)
    ]


def display_of(live: Iterable[Any]) -> Optional[str]:
    """A kiosk's own look among blocks in force: "hide" wins, then "grey", else None (the setting)."""
    asked = {_get(b, "kioskDisplay") for b in live}
    if DISPLAY_HIDE in asked:
        return DISPLAY_HIDE
    if DISPLAY_GREY in asked:
        return DISPLAY_GREY
    return None


def decide(
    blocks: Iterable[Any],
    now: datetime,
    *,
    till: Optional[Till] = None,
    setting: Any = None,
    track_stock: bool = False,
    stock: Optional[float] = None,
    item: Optional[Item] = None,
) -> Decision:
    """What the till shows and allows for one product — see the module docstring."""
    live = active_covering(blocks, till, now, item)
    display = display_of(live)
    hard = [b for b in live if kind_of(b) == BLOCKED]
    if hard:
        shown = nearest(hard)
        return Decision(BLOCKED, None, shown, parse_time(_get(shown, "until")), display)
    soft = [b for b in live if kind_of(b) == SOLD_OUT]
    if soft:
        shown = nearest(soft)
        reason = AUTO if _get(shown, "source") == AUTO else MANUAL
        return Decision(SOLD_OUT, reason, shown, parse_time(_get(shown, "until")), display)
    if auto_on(setting) and track_stock and (stock if stock is not None else 0.0) <= 0:
        return Decision(SOLD_OUT, STOCK, None, None, None)
    return Decision(AVAILABLE)
