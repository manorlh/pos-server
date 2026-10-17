"""
A tap on a dish's card at the kiosk (owner 17.10): straight into the basket, or the dish's window.

* **The kiosk's "הוספה מהירה"** (`layout.quickAdd`, app/services/kiosk_layout.py): `off` — the window;
  `no_choices` (the default) — straight in only when the dish has no choices and no add-ons at all (no option
  group, required or optional; not a meal); `no_required` — straight in when nothing must be chosen;
  `always` — also when the options' defaults answer every required choice.
* **Notes**: a dish that offers a note at this kiosk ("הערה בקיוסק", app/services/kiosk_notes.py, with the
  kiosk's switches on) opens its window — the note must be reachable — unless the dish says "direct".
* **Per dish — "בקיוסק: פתיחת חלון"** (`products.kiosk_open` / `categories.kiosk_open`; NULL inherits, the
  product's own wins): `window` — always its window; `direct` — straight in when nothing must be chosen
  (a required choice without a default still opens it). Sent to the kiosks in the menu block (`kioskOpen`,
  explicit values only).
* **The "+"** on a card is an add: straight in when nothing must be chosen (quickAdd `always`: also on the
  defaults), else the window; a dish set to `window` opens its window from the "+" too.

The dashboard's lib/kioskLayout.ts `tapPathOf` and the Android kiosk's KioskLayouts.tapPath are this rule;
the shared golden server/tests/fixtures/kiosk_tap_golden.json (generated from `tap_path` here).
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Iterable, Optional

OPEN_VALUES = ("window", "direct")
QUICK_ADDS = ("off", "no_choices", "no_required", "always")


def open_for(
    block: Optional[Dict[str, Any]],
    product_ids: Iterable[str],
    category_id: Optional[str],
    parent_of: Callable[[str], Optional[str]],
) -> Optional[str]:
    """The dish's "בקיוסק: פתיחת חלון": its own, else the nearest category's up the tree; None — as the kiosk."""
    if not isinstance(block, dict):
        return None
    products = block.get("products") if isinstance(block.get("products"), dict) else {}
    categories = block.get("categories") if isinstance(block.get("categories"), dict) else {}
    for pid in product_ids:
        own = products.get(str(pid))
        if own in OPEN_VALUES:
            return own
    seen = set()
    current = str(category_id) if category_id else None
    while current and current not in seen:
        seen.add(current)
        value = categories.get(current)
        if value in OPEN_VALUES:
            return value
        current = parent_of(current)
    return None


def tap_path(
    *,
    quick_add: str,
    plus: bool,
    sold_out: bool,
    add_path: str,
    meal: bool,
    defaults_answer: bool,
    has_choices: bool,
    kiosk_open: Optional[str],
    notes_on: bool,
) -> str:
    """
    "direct" | "sheet" | "none". [add_path]: "direct" — nothing must be chosen and not a meal; "sheet" — a meal
    or a required choice; "none" — not sellable. [defaults_answer]: the options' defaults answer every required
    choice. [has_choices]: any option group at all. [notes_on]: the dish offers a note at this kiosk.
    """
    if sold_out or add_path == "none":
        return "none"
    on_defaults = not meal and (add_path == "direct" or (add_path == "sheet" and defaults_answer))
    if kiosk_open == "window":
        return "sheet"
    if plus:
        if add_path == "direct":
            return "direct"
        return "direct" if quick_add == "always" and on_defaults else "sheet"
    if kiosk_open == "direct":
        return "direct" if on_defaults else "sheet"
    if notes_on:
        return "sheet"
    mode = quick_add if quick_add in QUICK_ADDS else "no_choices"
    if mode == "off":
        return "sheet"
    if mode == "no_choices":
        return "direct" if add_path == "direct" and not has_choices and not meal else "sheet"
    if mode == "no_required":
        return "direct" if add_path == "direct" else "sheet"
    return "direct" if on_defaults else "sheet"


def block(db, tenant_id) -> Dict[str, Dict[str, str]]:
    """The menu block's `kioskOpen`: every explicit value of the organization's products and categories."""
    from app.models.category import Category
    from app.models.product import Product

    products = {
        str(pid): v
        for pid, v in db.query(Product.id, Product.kiosk_open)
        .filter(Product.tenant_id == tenant_id, Product.kiosk_open.in_(OPEN_VALUES))
        .all()
    }
    categories = {
        str(cid): v
        for cid, v in db.query(Category.id, Category.kiosk_open)
        .filter(Category.tenant_id == tenant_id, Category.kiosk_open.in_(OPEN_VALUES))
        .all()
    }
    return {"categories": categories, "products": products}
