"""
The effective state of a product in a digital channel — pure (no database). One rule for the public
pages, the editor's preview and the server's validation of an order
(specs/digital-menu-ordering-cards-plan.md §4.4 / §8; the database half is
app/services/digital_effective.py; pinned by tests/fixtures/digital_effective_state_golden.json).

Four conditions, then what they mean:

1. **active** — the catalog sells it here: the product exists and is available (its own flag and the
   company / shop / point-of-sale locks), the shop lists it, its category is on;
2. **channelAllowed** — "מופיע ב" for this channel at this shop / point of sale
   (app/services/product_channels.py);
3. **inProfile** — the profile selects it (`select`), a time menu offered on this channel includes it
   when one is active, and — for a published revision — it was exposed at publication (or its
   category takes future products automatically);
4. **available** — no block in force reaches it in this channel ("חסום" / "אזל", their 4-channel
   targets), stock (when tracked, with "אזל אוטומטי" on) is above 0, and — to order — the profile
   takes orders now for this service.

**display**: `hide` when 1–3 fail or a block asks to hide; else `label` (shown with "אזל" / "לא
זמין") when 4 fails for stock or a block; else `show`. **orderable** only in the online channel,
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


# ── Blocks in four channels ──────────────────────────────────────────────────


def block_channels(block: Any) -> Set[str]:
    """
    The channels a block covers: its own `channels` when it has them; else its target read as
    the devices it was written for — "all" → tills and kiosks, "kiosks" → kiosks, "tills" → tills
    (no block written before the web channels reaches them: no inheritance between channels).
    An automatic "אזל" (stock reached 0) is every channel's.
    """
    raw = block.get("channels") if isinstance(block, Mapping) else getattr(block, "channels", None)
    source = block.get("source") if isinstance(block, Mapping) else getattr(block, "source", None)
    if source == "auto":
        # "אזל אוטומטי": the stock ran out — every channel selling from that stock.
        return {POS, KIOSK, ONLINE, MENU}
    if isinstance(raw, (list, tuple)) and raw:
        return {str(c) for c in raw if c in (POS, KIOSK, ONLINE, MENU)}
    target = (block.get("target") if isinstance(block, Mapping) else getattr(block, "target", None)) or "all"
    scope = block.get("scope") if isinstance(block, Mapping) else getattr(block, "scope", None)
    if scope in ("kiosks", "kiosk"):
        return {KIOSK}
    if target == "kiosks":
        return {KIOSK}
    if target == "tills":
        return {POS}
    return {POS, KIOSK}


def web_display_of(block: Any) -> Optional[str]:
    """A block's own look on the web: "hide" / "label", or None (the profile's default)."""
    raw = block.get("webDisplay") if isinstance(block, Mapping) else getattr(block, "web_display", None)
    if raw in (HIDE, LABEL):
        return raw
    kiosk = block.get("kioskDisplay") if isinstance(block, Mapping) else getattr(block, "kiosk_display", None)
    return HIDE if kiosk == "hide" else None


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
    channel_allowed: bool = True
    selected: Selected = field(default_factory=lambda: Selected(True))
    exposed: bool = True            # in the published exposure (or a future-taking category)
    menu: Optional[str] = None      # None (no time menu) | "in" | "out" | "none" (fallback sells nothing)
    blocks: Sequence[Any] = ()      # blocks in force reaching this place (any channel)
    track_stock: bool = False
    stock: Optional[float] = None
    auto_sold_out: bool = True


@dataclass
class Context:
    channel: str = ONLINE
    service: Optional[str] = None
    services: Sequence[str] = ()    # the profile's service types
    order_open: bool = True         # the profile's order hours at `at`
    published: bool = True          # a public request (exposure applies); a draft preview: False
    sold_out_display: str = LABEL   # the profile's default for "אזל"
    blocked_display: str = LABEL    # … and for "חסום"
    lang: str = "he"


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

    # 4. available: the blocks reaching this channel; "חסום" before "אזל".
    live = [b for b in f.blocks if ctx.channel in block_channels(b)]
    hard = [b for b in live if (b.get("kind") if isinstance(b, Mapping) else getattr(b, "kind", None)) == "blocked"]
    soft = [b for b in live if b not in hard]
    decided_by = None
    unavailable = None
    if hard:
        unavailable, decided_by = R_BLOCKED, hard[0]
        reasons.append(R_BLOCKED)
    elif soft:
        unavailable, decided_by = R_SOLD_OUT, soft[0]
        reasons.append(R_SOLD_OUT)
    elif f.auto_sold_out and f.track_stock and (f.stock if f.stock is not None else 0.0) <= 0:
        unavailable = R_STOCK
        reasons.append(R_STOCK)

    if hidden:
        return Decision(HIDE, False, reasons, None, decided_by)
    if unavailable is not None:
        asked = [web_display_of(b) for b in (hard or soft)]
        default = ctx.blocked_display if unavailable == R_BLOCKED else ctx.sold_out_display
        display = HIDE if HIDE in asked or default == HIDE else LABEL
        return Decision(display, False, reasons, _public(unavailable, ctx.lang) if display == LABEL else None, decided_by)

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
