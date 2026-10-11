"""
"תוספת" — a product's add-on role (`products.addon_role`, sent to every till and kiosk as `addonRole`):

* ``none`` — "פריט רגיל": an ordinary item, as every product that predates this;
* ``addon_only`` — "תוספת בלבד": never in a sell catalog (tills, kiosks, the web kiosk, online
  ordering and the digital menu), but usable as a modifier option's linked product
  (`modifier_options.linked_product_id`) and as a meal slot's component;
* ``both`` — "גם וגם": sold on its own and used as an add-on.

The cloud stores and carries the code; the devices hide `addon_only` from their catalogs, and the
cloud's own catalogs (app/services/digital_effective.py, the kiosk basket check, the menus' preview)
leave it out. An unknown code is refused on the way in (422) and read as ``none`` on the way out.
"""
from __future__ import annotations

from typing import Any, Dict, Literal, Tuple

NONE = "none"
ADDON_ONLY = "addon_only"
BOTH = "both"

#: Every code, in the order the forms offer them.
ADDON_ROLES: Tuple[str, ...] = (NONE, ADDON_ONLY, BOTH)

#: The type of the API field (`addonRole`).
AddonRole = Literal["none", "addon_only", "both"]

LABELS_HE: Dict[str, str] = {
    NONE: "פריט רגיל",
    ADDON_ONLY: "תוספת בלבד",
    BOTH: "גם וגם",
}


def out(value: Any) -> str:
    """The code as sent: a stored value the server does not know (or none) is ``none``."""
    return value if value in ADDON_ROLES else NONE


def of(product: Any) -> str:
    """A product's code — a model row, or a serialized row (`addonRole`)."""
    if isinstance(product, dict):
        return out(product.get("addonRole"))
    return out(getattr(product, "addon_role", None))


def is_addon_only(product: Any) -> bool:
    """Never in a sell catalog ("תוספת בלבד")."""
    return product is not None and of(product) == ADDON_ONLY
