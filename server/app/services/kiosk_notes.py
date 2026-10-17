"""
"הערה בקיוסק" (owner 17.10: "הערות זה פר פריט"): whether the kiosk offers a note on a dish — the free
"הוספת הערה" field and the quick-note chips.

* **Per dish.** `products.kiosk_notes` true / false wins; NULL inherits its category's
  (`categories.kiosk_notes`), and a category without one its parent's, up the tree. Nothing set
  anywhere: **no note** (the default).
* **The kiosk's switches stay the masters.** `general.notesEnabled` (the field) and
  `general.quickNotesEnabled` (the chips) still turn each off for the whole kiosk; a dish shows a note
  only where its kiosk's switch is on AND the dish allows it.
* **To the kiosks** in the `menu` block (`kioskNotes`: the explicit values only — `categories` and
  `products`, id → bool), so the tills keep it with the rest of the menu, offline; a write bumps the menu
  (`menu.bump`). A kiosk whose menu has no `kioskNotes` (an older cloud) offers notes as before.

The same rule in the dashboard (client/src/lib/kioskNotes.ts `kioskNotesAllowed`) and the Android kiosk
(domain/Menu.kt `kioskNotesAllowed`); the shared golden server/tests/fixtures/kiosk_notes_golden.json.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Iterable, Optional

#: Nothing set on the dish or up its category tree: no note.
DEFAULT = False


def allowed(
    block: Optional[Dict[str, Any]],
    product_ids: Iterable[str],
    category_id: Optional[str],
    parent_of: Callable[[str], Optional[str]],
) -> bool:
    """The dish ([product_ids] — any of its ids) offers a note under [block] (the menu's `kioskNotes`)."""
    if not isinstance(block, dict):
        return True  # An older cloud: notes as before (the kiosk's switches decide).
    products = block.get("products") if isinstance(block.get("products"), dict) else {}
    categories = block.get("categories") if isinstance(block.get("categories"), dict) else {}
    for pid in product_ids:
        own = products.get(str(pid))
        if isinstance(own, bool):
            return own
    seen = set()
    current = str(category_id) if category_id else None
    while current and current not in seen:
        seen.add(current)
        value = categories.get(current)
        if isinstance(value, bool):
            return value
        current = parent_of(current)
    return DEFAULT


def block(db, tenant_id) -> Dict[str, Dict[str, bool]]:
    """The menu block's `kioskNotes`: every explicit value of the organization's products and categories."""
    from app.models.category import Category
    from app.models.product import Product

    products = {
        str(pid): bool(v)
        for pid, v in db.query(Product.id, Product.kiosk_notes)
        .filter(Product.tenant_id == tenant_id, Product.kiosk_notes.isnot(None))
        .all()
    }
    categories = {
        str(cid): bool(v)
        for cid, v in db.query(Category.id, Category.kiosk_notes)
        .filter(Category.tenant_id == tenant_id, Category.kiosk_notes.isnot(None))
        .all()
    }
    return {"categories": categories, "products": products}
