"""
"מחייב אישור מנהל במכירה" — products and categories sold only on a manager's code.

The owner: "תוסיף אופציה בהגדרה לסיסמה לקטגוריה או לפריט מסויים שחייב סיסמת מנהל, תבנה את זה
בהרשאות" — in every sale (quick keys, search, a scan, a table, a held order…), and nothing to
do with vouchers.

**The flag.** `products.requires_manager_approval` and `categories.requires_manager_approval`.
A product is *restricted* when its own flag is set, or its category's, or that of any category
above it (`restricted_category_ids`). The cloud stores and ships the two flags as they are
(`requiresManagerApproval` on every product and category row of the till's catalog); the till
resolves the tree itself, so a category switched on reaches every product under it without
any product row changing.

**At the till.** Whoever holds `SELL_RESTRICTED_ITEMS` ("מכירת פריט המחייב אישור מנהל",
app/services/till_permissions.py) is never asked; anyone else adds a restricted product only
after a manager's code — someone who holds the permission — per sale line. The till records
who approved it as a till event (`restricted_item_approved`, app/services/till_events.py).

**On a kiosk.** Never: a kiosk has nobody to type a code. A restricted product is left out of
every kiosk menu, and a restricted category disappears with everything beneath it
(`kiosk_catalog`), here for the menus the cloud builds and again on the device.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

#: The wire name of the flag, on products and categories alike.
FIELD = "requiresManagerApproval"

#: The till permission whose holders are never asked (app/services/till_permissions.py).
PERMISSION = "SELL_RESTRICTED_ITEMS"

#: The till's elevation scope for it (the manager-code pad).
SCOPE = "sale:restricted"

#: How deep a category tree is followed — a guard against a cycle in bad data.
_MAX_DEPTH = 64


def _key(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def restricted_category_ids(categories: Iterable[Tuple[Any, Any, Any]]) -> Set[str]:
    """
    The ids of every category that is restricted — flagged itself, or beneath a flagged one.

    `categories` is `(id, parent_id, flagged)` per category, in any order. A parent that is
    not in the list ends the walk up (its flag is unknown here, so it adds nothing); a cycle
    ends it too.
    """
    parent: Dict[str, Optional[str]] = {}
    flagged: Set[str] = set()
    for cid, pid, flag in categories:
        key = _key(cid)
        if key is None:
            continue
        parent[key] = _key(pid)
        if flag:
            flagged.add(key)
    if not flagged:
        return set()
    out: Set[str] = set()
    for start in parent:
        seen: Set[str] = set()
        cur: Optional[str] = start
        depth = 0
        while cur is not None and cur not in seen and depth < _MAX_DEPTH:
            if cur in flagged or cur in out:
                out.add(start)
                break
            seen.add(cur)
            cur = parent.get(cur)
            depth += 1
    return out


def is_restricted(own_flag: Any, category_id: Any, restricted_categories: Set[str]) -> bool:
    """A product: its own flag, or its category is restricted (itself or above)."""
    return bool(own_flag) or (_key(category_id) in restricted_categories)


def restricted_ids_of_rows(rows: Iterable[Mapping[str, Any]]) -> Set[str]:
    """[restricted_category_ids] over sync-payload category rows (`id`, `parentId`, the flag)."""
    return restricted_category_ids((r.get("id"), r.get("parentId"), r.get(FIELD)) for r in rows)


def restricted_category_ids_in_tenant(db: Any, tenant_id: Any) -> Set[str]:
    """[restricted_category_ids] over every category of the tenant (one query)."""
    from app.models.category import Category

    if tenant_id is None:
        return set()
    rows = (
        db.query(Category.id, Category.parent_id, Category.requires_manager_approval)
        .filter(Category.tenant_id == tenant_id)
        .all()
    )
    return restricted_category_ids(rows)


def kiosk_catalog(
    products: List[Dict[str, Any]],
    categories: List[Dict[str, Any]],
    *,
    extra_categories: Iterable[Mapping[str, Any]] = (),
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    A kiosk's catalog payload without what needs a manager's code: every restricted product
    and every restricted category (flagged, or beneath a flagged one).

    `extra_categories` are rows that complete the tree without being sent (a delta pull
    carries only the categories that changed, while a product's parents may be older).
    Rows are left as they are otherwise; a product whose category is gone is gone with it.
    """
    restricted = restricted_ids_of_rows(list(categories) + list(extra_categories))
    kept_products = [
        p for p in products
        if not is_restricted(p.get(FIELD), p.get("categoryId"), restricted)
    ]
    kept_categories = [c for c in categories if _key(c.get("id")) not in restricted]
    return kept_products, kept_categories
