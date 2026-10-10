"""
"סדר תצוגה" — the one ordering model of the four channels, pure (no database).
specs/digital-menu-ordering-cards-plan.md §5; the database half is app/services/display_ordering.py.

An **ordering** ("סידור") is:

    {"categories": [category ids],                 # the categories' manual order ([] = the catalog's)
     "products": {category id: [product ids]},     # each category's manual order
     "pinned": {"categories": [ids], "products": {category id: [ids]}},   # first, in this order
     "newItems": "end" | "by_name"}                # where an item with no position goes

**Positions are kept for every id**, hidden or blocked ones too: `arrange` orders first and filters
after, so the relative order of what is shown never moves and an item that comes back comes back to
its place. Pinned first (in their own order), then the manual positions, then the items with none
(`newItems`: after them in the catalog's order, or by name). A sort mode (price ↑↓, best sellers)
never rewrites the manual order: ties fall back to the manual position, then the id; pinned stay first.

**Today's keys** (what the tills and kiosks read, unchanged):

* the tills — `productOrder`: one flat list of product ids, and `categoryOrder`, in the settings
  layers (tenant / company / shop / area / till). `import_pos` reads the flat list per category,
  keeping the order inside each (a till's grid shows one category at a time); the flat list itself
  is kept (`legacyFlat`) and `pos_legacy` writes back by re-slotting each category's products into
  the places that category held in it — exactly the till's own `mergeShownOrder` — so an unchanged
  ordering writes back the same list, interleaving and all.
* the kiosks — `catalog.categoryOrder` and `catalog.productOrder` (a map), in the kiosk layers
  (company / shop / machine): `import_kiosk` / `kiosk_legacy`, one to one.

Pinned items have no key of their own on the devices: they are written as the first positions.

**Inheritance** (`effective_along`): along a target's chain, most specific first — the categories of
the nearest ordering that has them; the products as the channel's devices merge them: the tills
take the nearest flat list whole (`pos`), the kiosks and the web per category.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

NEW_END, NEW_BY_NAME = "end", "by_name"
NEW_ITEMS = (NEW_END, NEW_BY_NAME)
SORT_MANUAL, SORT_PRICE_ASC, SORT_PRICE_DESC, SORT_BEST = "manual", "price_asc", "price_desc", "best_sellers"
SORTS = (SORT_MANUAL, SORT_PRICE_ASC, SORT_PRICE_DESC, SORT_BEST)
#: The most ids one list holds (the till's own limit for `productOrder`).
MAX_IDS = 5000


def _ids(raw: Any, limit: int = MAX_IDS) -> List[str]:
    """A list of ids as strings, each once, in order; anything else is dropped."""
    out: List[str] = []
    seen: Set[str] = set()
    if isinstance(raw, (list, tuple)):
        for v in raw:
            if v is None or isinstance(v, (bool, dict, list)):
                continue
            s = str(v).strip()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
            if len(out) >= limit:
                break
    return out


def _map(raw: Any) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    if isinstance(raw, Mapping):
        for k, v in raw.items():
            key = str(k).strip()
            ids = _ids(v)
            if key and ids:
                out[key] = ids
    return out


def empty() -> Dict[str, Any]:
    return {"categories": [], "products": {}, "pinned": {"categories": [], "products": {}}, "newItems": NEW_END}


def clean(raw: Any) -> Dict[str, Any]:
    """An ordering as stored / sent, normalised (unknown keys dropped)."""
    raw = raw if isinstance(raw, Mapping) else {}
    pinned = raw.get("pinned") if isinstance(raw.get("pinned"), Mapping) else {}
    new_items = raw.get("newItems")
    return {
        "categories": _ids(raw.get("categories")),
        "products": _map(raw.get("products")),
        "pinned": {"categories": _ids(pinned.get("categories")), "products": _map(pinned.get("products"))},
        "newItems": new_items if new_items in NEW_ITEMS else NEW_END,
    }


def is_empty(content: Mapping[str, Any]) -> bool:
    c = clean(content)
    return not c["categories"] and not c["products"] and not c["pinned"]["categories"] and not c["pinned"]["products"]


# ── Pinned first ─────────────────────────────────────────────────────────────


def _pinned_first(pinned: Sequence[str], manual: Sequence[str]) -> List[str]:
    pins = list(dict.fromkeys(pinned))
    pin_set = set(pins)
    return pins + [i for i in manual if i not in pin_set]


def effective(content: Mapping[str, Any]) -> Dict[str, Any]:
    """The manual order with the pinned ones first: `{"categories": [...], "products": {cat: [...]}}`."""
    c = clean(content)
    cats = _pinned_first(c["pinned"]["categories"], c["categories"]) if c["categories"] or c["pinned"]["categories"] else []
    products: Dict[str, List[str]] = {}
    for cid in list(c["products"]) + [k for k in c["pinned"]["products"] if k not in c["products"]]:
        products[cid] = _pinned_first(c["pinned"]["products"].get(cid, []), c["products"].get(cid, []))
    return {"categories": cats, "products": products}


# ── Arranging a catalog ──────────────────────────────────────────────────────


def arrange(
    content: Mapping[str, Any],
    categories: Sequence[Mapping[str, Any]],
    products: Sequence[Mapping[str, Any]],
    *,
    hidden: Iterable[str] = (),
    sort: str = SORT_MANUAL,
    rank: Optional[Mapping[str, float]] = None,
) -> Dict[str, Any]:
    """
    The catalog in this ordering: `{"categories": [ids], "products": {category id: [ids]}}`.

    `categories`: `[{"id", "sortOrder"?, "name"?}]` (the catalog's order: sortOrder, then name, then id);
    `products`: `[{"id", "categoryId", "name"?, "price"?}]`. `hidden` ids (products or categories) are
    left out *after* ordering. `sort`: manual (default) / price_asc / price_desc / best_sellers (`rank`:
    product id → a number, higher sells more). An empty category is left out.
    """
    c = clean(content)
    eff = effective(c)
    hide = {str(h) for h in hidden}

    def cat_key(cat: Mapping[str, Any]) -> Tuple:
        return (cat.get("sortOrder") or 0, str(cat.get("name") or ""), str(cat.get("id")))

    catalog_cats = [str(cat.get("id")) for cat in sorted(categories, key=cat_key)]
    known_cats = set(catalog_cats)
    manual_cats = [i for i in eff["categories"] if i in known_cats]
    placed = set(manual_cats)
    rest = [i for i in catalog_cats if i not in placed]
    if c["newItems"] == NEW_BY_NAME:
        names = {str(cat.get("id")): str(cat.get("name") or "") for cat in categories}
        rest = sorted(rest, key=lambda i: (names.get(i, ""), i))
    ordered_cats = manual_cats + rest

    by_cat: Dict[str, List[Mapping[str, Any]]] = {}
    for p in products:
        by_cat.setdefault(str(p.get("categoryId")), []).append(p)

    out_products: Dict[str, List[str]] = {}
    for cid in ordered_cats:
        members = by_cat.get(cid, [])
        if not members:
            continue
        names = {str(p.get("id")): str(p.get("name") or "") for p in members}
        catalog_order = [str(p.get("id")) for p in sorted(members, key=lambda p: (str(p.get("name") or ""), str(p.get("id"))))]
        known = set(catalog_order)
        manual = [i for i in eff["products"].get(cid, []) if i in known]
        placed_p = set(manual)
        rest_p = [i for i in catalog_order if i not in placed_p]
        if c["newItems"] == NEW_BY_NAME:
            rest_p = sorted(rest_p, key=lambda i: (names.get(i, ""), i))
        order = manual + rest_p
        pins = [i for i in c["pinned"]["products"].get(cid, []) if i in known]
        if sort != SORT_MANUAL:
            position = {pid: n for n, pid in enumerate(order)}
            prices = {str(p.get("id")): p.get("price") for p in members}
            pin_set = set(pins)
            free = [i for i in order if i not in pin_set]

            def key(pid: str):
                if sort == SORT_BEST:
                    v = -(float((rank or {}).get(pid, 0) or 0))
                else:
                    price = prices.get(pid)
                    v = float(price) if price is not None else float("inf")
                    if sort == SORT_PRICE_DESC:
                        v = -v if price is not None else float("inf")
                return (v, position[pid], pid)

            order = pins + sorted(free, key=key)
        shown = [i for i in order if i not in hide]
        if shown:
            out_products[cid] = shown
    # Pinned categories are first already (through `effective`), whatever the sort.
    final_cats = [cid for cid in ordered_cats if cid in out_products and cid not in hide]
    return {"categories": final_cats, "products": {cid: out_products[cid] for cid in final_cats}}


# ── Today's keys ─────────────────────────────────────────────────────────────


def merge_shown(full: Sequence[str], shown: Sequence[str]) -> List[str]:
    """
    The whole order after the ids in `shown` were rearranged: they take, in their new order, the
    places they held in `full`; every other id keeps its place; ids `full` did not know go at the
    end. The till's own rule (pos-android domain/ProductOrder.kt `mergeShownOrder`).
    """
    shown_list = list(shown)
    shown_set = set(shown_list)
    it = iter(shown_list)
    out: List[str] = []
    remaining = len(shown_list)
    for i in full:
        if i in shown_set and remaining > 0:
            out.append(next(it))
            remaining -= 1
        else:
            out.append(i)
    out.extend(it)
    return list(dict.fromkeys(out))


def import_pos(
    product_order: Any, category_order: Any, category_of: Mapping[str, Optional[str]],
) -> Dict[str, Any]:
    """
    A till layer's `productOrder` / `categoryOrder` as an ordering: the flat list per category (the
    order inside each kept), the categories as listed. `legacyFlat` keeps the list itself.
    """
    flat = _ids(product_order)
    products: Dict[str, List[str]] = {}
    for pid in flat:
        cid = category_of.get(pid)
        if cid:
            products.setdefault(str(cid), []).append(pid)
    out = empty()
    out["categories"] = _ids(category_order)
    out["products"] = products
    out["legacyFlat"] = flat
    return out


def pos_legacy(
    content: Mapping[str, Any], legacy_flat: Any, category_of: Mapping[str, Optional[str]],
) -> Dict[str, Optional[List[str]]]:
    """
    The till keys for this ordering: `{"productOrder": [...] | None, "categoryOrder": [...] | None}`
    (None = the key is not set). Each category's products re-slotted into the places that category
    held in the flat list (`merge_shown`), then those it did not hold, in the categories' order.
    """
    eff = effective(content)
    flat = _ids(legacy_flat)
    # The categories in their order first (a list never written before lays them out that way).
    cats = [c for c in eff["categories"] if c in eff["products"]] + [c for c in eff["products"] if c not in eff["categories"]]
    for cid in cats:
        flat = merge_shown(flat, eff["products"][cid])
    # Ids that left their category in the ordering's view keep their old place; an id the
    # ordering no longer lists under any category stays where it was (a deleted product, a till's own).
    return {
        "productOrder": flat or None,
        "categoryOrder": list(eff["categories"]) or None,
    }


def import_kiosk(catalog: Any) -> Dict[str, Any]:
    """A kiosk layer's `catalog.categoryOrder` / `catalog.productOrder` as an ordering."""
    catalog = catalog if isinstance(catalog, Mapping) else {}
    out = empty()
    out["categories"] = _ids(catalog.get("categoryOrder"))
    out["products"] = _map(catalog.get("productOrder"))
    return out


def kiosk_legacy(content: Mapping[str, Any]) -> Dict[str, Any]:
    """The kiosk keys for this ordering: `{"categoryOrder": [...] | None, "productOrder": {...} | None}`."""
    eff = effective(content)
    products = {cid: ids for cid, ids in eff["products"].items() if ids}
    return {"categoryOrder": list(eff["categories"]) or None, "productOrder": products or None}


def keys_hash(keys: Mapping[str, Any]) -> str:
    """The hash of a level's device keys (`{"productOrder", "categoryOrder"}` as stored), to notice a write elsewhere."""
    import hashlib
    import json

    return hashlib.sha256(json.dumps(dict(keys or {}), sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def legacy_of(channel: str, content: Mapping[str, Any], legacy_flat: Any = None, category_of=None) -> Dict[str, Any]:
    if channel == "pos":
        return pos_legacy(content, legacy_flat, category_of or {})
    if channel == "kiosk":
        return kiosk_legacy(content)
    return {}


# ── Inheritance ──────────────────────────────────────────────────────────────


def effective_along(channel: str, contents: Sequence[Optional[Mapping[str, Any]]]) -> Dict[str, Any]:
    """
    The ordering a target gets from its chain's orderings, most specific first (None where a level
    has none): the categories of the nearest that has them, the pinned likewise; the products as
    the channel's devices merge them — the tills the nearest flat list whole, the others per category.
    """
    out = empty()
    cleaned = [clean(c) for c in contents if c is not None]
    for c in cleaned:
        if c["categories"] or c["pinned"]["categories"]:
            out["categories"] = c["categories"]
            out["pinned"]["categories"] = c["pinned"]["categories"]
            break
    if channel == "pos":
        for c in cleaned:
            if c["products"] or c["pinned"]["products"]:
                out["products"] = dict(c["products"])
                out["pinned"]["products"] = dict(c["pinned"]["products"])
                break
    else:
        for c in reversed(cleaned):
            out["products"].update(c["products"])
            out["pinned"]["products"].update(c["pinned"]["products"])
    for c in cleaned:
        if c["newItems"] != NEW_END:
            out["newItems"] = c["newItems"]
            break
    return out


def nearest(chain: Sequence[Tuple[str, str]], bound: Mapping[Tuple[str, str], Any]) -> Optional[Tuple[str, str, Any]]:
    """The first `(level, target)` of the chain (most specific first) with a binding: `(level, target, value)`."""
    for level, target in chain:
        hit = bound.get((level, str(target)))
        if hit is not None:
            return (level, str(target), hit)
    return None
