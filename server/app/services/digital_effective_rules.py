"""
The effective state of a product in a digital channel — pure (no database). One rule for the public
pages, the editor's preview and the server's validation of an order
(specs/digital-menu-ordering-cards-plan.md §4.4 / §8; the database half is
app/services/digital_effective.py; pinned by tests/fixtures/digital_effective_state_golden.json).

Four conditions, then what they mean:

1. **active** — the catalog sells it here: the product exists and is available (its own flag and the
   company / shop / point-of-sale locks), the shop lists it, its category is on;
2. **channelAllowed** — the product's "מופיע ב" names this channel (item-blocks' model:
   `products.appears_in`, app/services/product_channels.py `appears`);
3. **inProfile** — the profile selects it (`select`), a time menu offered on this channel includes it
   when one is active, and — for a published revision — it was exposed at publication (or its
   category takes future products automatically);
4. **available** — the blocks' own rule says so for this channel at this place: item-blocks'
   `sold_out_rules.decide` with a `Till` of the web channel (`sold_out_marks.channels`; "חסום" before
   "אזל"; tracked stock at 0 with "אזל אוטומטי" on) — and, to order, the profile takes orders now for
   this service.

**display**: `hide` when 1–3 fail, or when 4 fails and a block in force asks to hide ("הסתר") or the
profile hides that state; else `label` (shown with "אזל" / "לא זמין") when 4 fails; else `show`. **orderable** only in the online channel,
only `show`, only while orders are taken. `reasons` are for the dashboard (codes); `publicReason`
is the only text a customer is sent — never a block's internal note.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

SHOW, LABEL, HIDE = "show", "label", "hide"
MENU, ONLINE, POS, KIOSK = "menu", "online", "pos", "kiosk"
WEB_CHANNELS = (MENU, ONLINE)

SELECTION_MODES = ("independent", "inherit_add", "inherit_full", "kiosk")

#: The reasons, in the order the dashboard lists them.
R_INACTIVE = "inactive"                 # the catalog: unavailable / locked here
R_NOT_IN_SHOP = "not_in_shop"           # the shop does not list it
R_CATEGORY_OFF = "category_off"
R_CHANNEL_OFF = "channel_off"           # "מופיע ב" off for this channel here
R_NOT_SELECTED = "not_selected"         # the profile does not select it
R_EXCLUDED = "excluded"                 # selected by its category, excluded by hand
R_NOT_PUBLISHED = "not_published"       # new since the publication: waits for the next one
R_MENU_INACTIVE = "menu_inactive"       # a time menu is active here and does not include it
R_NO_MENU = "no_menu"                   # no time menu active and the fallback sells nothing
R_BLOCKED = "blocked"
R_SOLD_OUT = "sold_out"
R_STOCK = "stock"
R_CLOSED = "closed"                     # outside the order hours (browsing goes on)
R_VIEW_ONLY = "view_only"               # the digital menu takes no orders
R_SERVICE = "service_unavailable"       # the profile does not offer this service type

#: The only words a customer is shown (by language; the dashboard has its own for every reason).
PUBLIC_TEXT = {
    R_SOLD_OUT: {"he": "אזל", "en": "Sold out"},
    R_STOCK: {"he": "אזל", "en": "Sold out"},
    R_BLOCKED: {"he": "לא זמין כרגע", "en": "Currently unavailable"},
    R_CLOSED: {"he": "לא מתקבלות הזמנות כרגע", "en": "Not taking orders right now"},
}


# ── Selection ────────────────────────────────────────────────────────────────


def _ids(raw: Any) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    if isinstance(raw, (list, tuple)):
        for v in raw:
            if isinstance(v, Mapping):
                v = v.get("id")
            if v is None or isinstance(v, (bool, list, dict)):
                continue
            s = str(v).strip()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
    return out


def clean_selection(raw: Any) -> Dict[str, Any]:
    """
    A profile's selection: `{"mode", "categories": [{"id", "includeFuture"}], "products": [ids],
    "excludes": [ids], "excludeCategories": [ids], "source"?}`.
    """
    raw = raw if isinstance(raw, Mapping) else {}
    mode = raw.get("mode") if raw.get("mode") in SELECTION_MODES else "independent"
    cats = []
    seen: Set[str] = set()
    for c in raw.get("categories") or []:
        cid = str(c.get("id")).strip() if isinstance(c, Mapping) and c.get("id") else (str(c).strip() if isinstance(c, str) else "")
        if cid and cid not in seen:
            seen.add(cid)
            cats.append({"id": cid, "includeFuture": bool(c.get("includeFuture")) if isinstance(c, Mapping) else False})
    out: Dict[str, Any] = {
        "mode": mode,
        "categories": cats,
        "products": _ids(raw.get("products")),
        "excludes": _ids(raw.get("excludes")),
        "excludeCategories": _ids(raw.get("excludeCategories")),
    }
    source = raw.get("source")
    if mode == "kiosk" and isinstance(source, Mapping) and source.get("level") and source.get("targetId"):
        out["source"] = {"level": str(source["level"]), "targetId": str(source["targetId"])}
    return out


@dataclass(frozen=True)
class Selected:
    selected: bool
    #: R_NOT_SELECTED / R_EXCLUDED when not.
    reason: Optional[str] = None
    #: Its category (or one above it) takes future products automatically.
    include_future: bool = False


def select(
    selection: Mapping[str, Any],
    product_id: str,
    category_chain: Sequence[str],
    *,
    parent: Optional[Selected] = None,
    kiosk_hidden: Optional[Tuple[Set[str], Set[str]]] = None,
) -> Selected:
    """
    Whether the selection takes this product: by hand, or through its category (or one above it).
    `parent` is the parent profile's answer (inherit modes); `kiosk_hidden` the kiosk's
    `(hidden products, hidden categories)` ("כמו הקיוסק"). Exclusions always win.
    """
    s = clean_selection(selection)
    pid = str(product_id)
    chain = [str(c) for c in category_chain]
    if pid in s["excludes"] or any(c in s["excludeCategories"] for c in chain):
        return Selected(False, R_EXCLUDED)
    future_cats = {c["id"] for c in s["categories"] if c["includeFuture"]}
    own_by_hand = pid in s["products"]
    own_cat = next((c for c in chain if c in {x["id"] for x in s["categories"]}), None)
    own = own_by_hand or own_cat is not None
    own_future = own_cat is not None and any(c in future_cats for c in chain)
    mode = s["mode"]
    if mode == "kiosk":
        hidden_p, hidden_c = kiosk_hidden or (set(), set())
        if pid in hidden_p or any(c in hidden_c for c in chain):
            return Selected(False, R_NOT_SELECTED)
        return Selected(True, None, True)
    if mode == "inherit_full":
        return parent if parent is not None else Selected(False, R_NOT_SELECTED)
    if mode == "inherit_add":
        if own:
            return Selected(True, None, own_future)
        return parent if parent is not None else Selected(False, R_NOT_SELECTED)
    if own:
        return Selected(True, None, own_future)
    return Selected(False, R_NOT_SELECTED)


# ── Blocks: item-blocks' rule, for a channel with no device ─────────────────


def availability(
    blocks: Sequence[Any],
    now: Any,
    *,
    channel: str,
    company_id: Optional[str],
    shop_id: Optional[str],
    area_id: Optional[str],
    product_id: str,
    category_chain: Sequence[str],
    track_stock: bool = False,
    stock: Optional[float] = None,
    auto_setting: Any = None,
):
    """item-blocks' decision (`sold_out_rules.decide`) for this channel at this place — the canonical rule."""
    from app.services import sold_out_rules as rules

    from datetime import datetime, timezone

    till = rules.Till(company_id=company_id, shop_id=shop_id, area_id=area_id, channel=channel)
    moment = rules.parse_time(now) or datetime.now(timezone.utc)
    return rules.decide(
        blocks, moment, till=till, setting=auto_setting, track_stock=track_stock, stock=stock,
        item=rules.Item(product_id, tuple(category_chain)),
    )


# ── The decision ─────────────────────────────────────────────────────────────


@dataclass
class Facts:
    """What the database half gathered about one product in one context."""

    product_id: str
    category_chain: Sequence[str] = ()
    exists: bool = True
    available: bool = True          # the catalog flag and the company / shop / area locks
    listed: bool = True             # the shop's assortment lists it (and it is sold there)
    category_active: bool = True
    channel_allowed: bool = True    # "מופיע ב" names the channel (product_channels.appears)
    selected: Selected = field(default_factory=lambda: Selected(True))
    exposed: bool = True            # in the published exposure (or a future-taking category)
    menu: Optional[str] = None      # None (no time menu) | "in" | "out" | "none" (fallback sells nothing)
    blocks: Sequence[Any] = ()      # blocks in force at this place (sold_out_marks rows / their mappings)
    track_stock: bool = False
    stock: Optional[float] = None
    auto_setting: Any = None        # "אזל אוטומטי" as stored (None: on)


@dataclass
class Context:
    channel: str = ONLINE
    service: Optional[str] = None
    services: Sequence[str] = ()    # the profile's service types
    order_open: bool = True         # the profile's order hours at `now`
    published: bool = True          # a public request (exposure applies); a draft preview: False
    sold_out_display: str = LABEL   # the profile's default for "אזל"
    blocked_display: str = LABEL    # … and for "חסום"
    lang: str = "he"
    now: Any = None                 # the instant (ISO-8601 or aware datetime) the blocks are read at
    company_id: Optional[str] = None
    shop_id: Optional[str] = None
    area_id: Optional[str] = None


@dataclass
class Decision:
    display: str
    orderable: bool
    reasons: List[str]
    public_reason: Optional[str]
    #: The block that decided (internal), or None.
    block: Optional[Any] = None


def _public(reason: Optional[str], lang: str) -> Optional[str]:
    if reason is None:
        return None
    words = PUBLIC_TEXT.get(reason)
    if words is None:
        return None
    return words.get(lang) or words.get("he")


def decide(f: Facts, ctx: Context) -> Decision:
    reasons: List[str] = []
    # 1. active
    if not f.exists or not f.available:
        reasons.append(R_INACTIVE)
    if not f.listed:
        reasons.append(R_NOT_IN_SHOP)
    if not f.category_active:
        reasons.append(R_CATEGORY_OFF)
    # 2. the channel
    if not f.channel_allowed:
        reasons.append(R_CHANNEL_OFF)
    # 3. the profile
    if not f.selected.selected:
        reasons.append(f.selected.reason or R_NOT_SELECTED)
    elif ctx.published and not f.exposed and not f.selected.include_future:
        reasons.append(R_NOT_PUBLISHED)
    if f.menu == "out":
        reasons.append(R_MENU_INACTIVE)
    elif f.menu == "none":
        reasons.append(R_NO_MENU)
    hidden = bool(reasons)

    # 4. available: item-blocks' own rule, for this channel at this place.
    d = availability(
        f.blocks, ctx.now, channel=ctx.channel, company_id=ctx.company_id, shop_id=ctx.shop_id,
        area_id=ctx.area_id, product_id=f.product_id, category_chain=f.category_chain,
        track_stock=f.track_stock, stock=f.stock, auto_setting=f.auto_setting,
    )
    unavailable = None
    if d.state == "blocked":
        unavailable = R_BLOCKED
    elif d.state == "sold_out":
        unavailable = R_STOCK if d.reason == "stock" else R_SOLD_OUT
    if unavailable is not None:
        reasons.append(unavailable)

    if hidden:
        return Decision(HIDE, False, reasons, None, d.block)
    if unavailable is not None:
        default = ctx.blocked_display if unavailable == R_BLOCKED else ctx.sold_out_display
        # A block's own "הסתר" (its kiosk look, "hide") hides it on the web too.
        display = HIDE if d.display == "hide" or default == HIDE else LABEL
        return Decision(display, False, reasons, _public(unavailable, ctx.lang) if display == LABEL else None, d.block)

    # Shown: may it be ordered now?
    if ctx.channel != ONLINE:
        reasons.append(R_VIEW_ONLY)
        return Decision(SHOW, False, reasons, None)
    if ctx.service is not None and ctx.services and ctx.service not in ctx.services:
        reasons.append(R_SERVICE)
        return Decision(SHOW, False, reasons, None)
    if not ctx.order_open:
        reasons.append(R_CLOSED)
        return Decision(SHOW, False, reasons, _public(R_CLOSED, ctx.lang))
    return Decision(SHOW, True, reasons, None)
