"""
"אזל" / "חסום" — the rule a till and the cloud share, pure (no database).

A product may carry several blocks at once ("חסימות"), each for a scope. The cloud sends a till,
on each product row of its catalog, the blocks in force that cover it (`blocks`); the till runs
`decide` over them with its own clock and its own stock. The cloud runs the same function for
the dashboard's quick stock screen. Pinned on both sides by the golden cases in
tests/fixtures/sold_out_golden.json (pos-android keeps the same bytes in app/src/test/resources;
its `SoldOutRules` must agree case by case).

**Scopes** — whom a block covers:

* `company` — every till and kiosk of the company's shops;
* `shop`    — every till and kiosk of the shop (`scopeId` = the shop);
* `kiosks`  — every kiosk of the shop (`scopeId` = the shop) — the tills keep selling;
* `area`    — the tills (and kiosks) standing in that point of sale;
* `machine` — one till (or kiosk), `kiosk` — one kiosk (covers it only while it is a kiosk);
* `event`   — the tills of an event ("אירועים");
* `group`   — a group of devices (`machine_groups`, wired where that model exists).

**In force** from when it was set until `until` (exclusive), or until removed when it has none.

**The answer**, for one till:

1. any block in force of kind `blocked` covers it → **blocked** ("חסום"), never sold by the till;
2. else any of kind `sold_out` → **sold out** ("אזל"); a manager may approve a sale with the
   manager code (`overridable`);
3. else, with `autoSoldOutAtZero` on (unless a layer turns it off), a product that tracks stock
   and has none where the till sells from (on hand ≤ 0; a missing level is 0) → **sold out**,
   reason `stock`;
4. else available.

The block shown (and its reason / end) is the nearest scope among those of the deciding kind,
then the newest. Kiosks hide the product or grey it out (`general.soldOutMode`) either way.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, List, Mapping, Optional, Sequence

SETTING_AUTO = "autoSoldOutAtZero"

AVAILABLE, SOLD_OUT, BLOCKED = "available", "sold_out", "blocked"
KINDS = (SOLD_OUT, BLOCKED)
MANUAL, AUTO, STOCK = "manual", "auto", "stock"

#: Nearest first: the block a till shows when several of one kind cover it.
SCOPE_ORDER: Sequence[str] = ("machine", "kiosk", "area", "group", "event", "kiosks", "shop", "company")
SCOPES = tuple(SCOPE_ORDER)


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
class Decision:
    state: str
    #: manual | auto | stock (sold out); the block's reason text (blocked) is on `block`.
    reason: Optional[str] = None
    #: The block shown (a mapping as given), None for the stock rule or available.
    block: Optional[Mapping[str, Any]] = None
    until: Optional[datetime] = None

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


def _get(block: Any, key: str) -> Any:
    if isinstance(block, Mapping):
        return block.get(key)
    return getattr(block, {"scopeId": "scope_id", "createdAt": "created_at"}.get(key, key), None)


def kind_of(block: Any) -> str:
    return BLOCKED if _get(block, "kind") == BLOCKED else SOLD_OUT


def covers(block: Any, till: Till) -> bool:
    """Whether `block` reaches this till."""
    scope = _get(block, "scope")
    sid = str(_get(block, "scopeId"))
    if scope == "company":
        return till.company_id is not None and sid == str(till.company_id)
    if scope == "shop":
        return till.shop_id is not None and sid == str(till.shop_id)
    if scope == "kiosks":
        return till.is_kiosk and till.shop_id is not None and sid == str(till.shop_id)
    if scope == "area":
        return till.area_id is not None and sid == str(till.area_id)
    if scope == "machine":
        return till.machine_id is not None and sid == str(till.machine_id)
    if scope == "kiosk":
        return till.is_kiosk and till.machine_id is not None and sid == str(till.machine_id)
    if scope == "event":
        return sid in {str(e) for e in till.event_ids}
    if scope == "group":
        return sid in {str(g) for g in till.group_ids}
    return False


def _rank(block: Any) -> int:
    scope = _get(block, "scope")
    return SCOPE_ORDER.index(scope) if scope in SCOPE_ORDER else len(SCOPE_ORDER)


def _created(block: Any) -> datetime:
    try:
        return parse_time(_get(block, "createdAt")) or datetime.min.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def nearest(blocks: Iterable[Any]) -> Optional[Any]:
    """The block shown among these: the nearest scope, then the newest."""
    best = None
    for b in blocks:
        if best is None or _rank(b) < _rank(best) or (_rank(b) == _rank(best) and _created(b) > _created(best)):
            best = b
    return best


def active_covering(blocks: Iterable[Any], till: Optional[Till], now: datetime) -> List[Any]:
    """The blocks in force at `now` that reach the till (`till` None: already filtered for it)."""
    return [b for b in blocks if in_force(_get(b, "until"), now) and (till is None or covers(b, till))]


def decide(
    blocks: Iterable[Any],
    now: datetime,
    *,
    till: Optional[Till] = None,
    setting: Any = None,
    track_stock: bool = False,
    stock: Optional[float] = None,
) -> Decision:
    """What the till shows and allows for one product — see the module docstring."""
    live = active_covering(blocks, till, now)
    hard = [b for b in live if kind_of(b) == BLOCKED]
    if hard:
        shown = nearest(hard)
        return Decision(BLOCKED, None, shown, parse_time(_get(shown, "until")))
    soft = [b for b in live if kind_of(b) == SOLD_OUT]
    if soft:
        shown = nearest(soft)
        reason = AUTO if _get(shown, "source") == AUTO else MANUAL
        return Decision(SOLD_OUT, reason, shown, parse_time(_get(shown, "until")))
    if auto_on(setting) and track_stock and (stock if stock is not None else 0.0) <= 0:
        return Decision(SOLD_OUT, STOCK, None, None)
    return Decision(AVAILABLE)
