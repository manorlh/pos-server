"""
Item tickets ("שוברים") — operational slips the till prints after a sale.

Not to be confused with value vouchers (`vouchers` / `issued_vouchers`): an item
ticket has no serial, no value and no expiry; it is "5 נקניקיות" on paper, handed
over the counter and exchanged for the goods.

Modes:
- "per_unit"  one ticket per unit sold (5 hot dogs → 5 tickets)
- "per_line"  one ticket per cart line, quantity combined ("5 נקניקיות")
- "per_sale"  every per_sale line of the sale on one combined ticket
- "off"       no ticket

A category holds a mode (NULL = off). A product holds a mode or NULL, which inherits
its category's. The product's own value always wins, "off" included.
"""

from typing import Any, Literal, Optional

OFF = "off"
PER_UNIT = "per_unit"
PER_LINE = "per_line"
PER_SALE = "per_sale"
#: Accepted from the API on a product only; stored as NULL.
INHERIT = "inherit"

MODES = (OFF, PER_UNIT, PER_LINE, PER_SALE)

TicketMode = Literal["off", "per_unit", "per_line", "per_sale"]
ProductTicketMode = Literal["inherit", "off", "per_unit", "per_line", "per_sale"]


def normalize(mode: Optional[str]) -> Optional[str]:
    """A stored value: a known mode, or None for anything else (inherit / unset)."""
    if mode is None:
        return None
    mode = str(mode).strip().lower()
    return mode if mode in MODES else None


def category_mode(category: Any) -> str:
    """The category's mode; unset is "off"."""
    if category is None:
        return OFF
    return normalize(getattr(category, "ticket_mode", None)) or OFF


def effective_mode(product: Any) -> str:
    """The product's own mode if it has one, otherwise its category's."""
    own = normalize(getattr(product, "ticket_mode", None))
    if own is not None:
        return own
    return category_mode(getattr(product, "category", None))
