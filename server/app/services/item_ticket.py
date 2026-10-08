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


# ── "שוברי פריט" — the device's level above the product (the owner, 07.10.2026) ─────────
#
# A till parameter (company → shop → point of sale → till, `till_parameters`), read by the till,
# the Android kiosk and the Windows kiosk (their parameters sync): "לפי הפריט" — each product's own
# mode, as before; "כבוי" — this device prints no item tickets; or one mode that replaces the
# product's for every product whose tickets are on (a product with tickets off never gets them
# from here). The devices' rule: pos-android domain/ItemTicket.kt `ItemTicketPrinting.modeFor`,
# kiosk-desktop core/itemTickets.ts — pinned by kiosk-desktop/test/fixtures/item_ticket_cases.json.

DEVICE_PARAMETER_KEY = "itemTicketMode"
DEVICE_BY_PRODUCT = "לפי הפריט"
DEVICE_OFF = "כבוי"
DEVICE_PER_UNIT = "שובר לכל יחידה"
DEVICE_PER_LINE = "שובר לכל פריט"
DEVICE_PER_SALE = "שובר אחד לעסקה"
DEVICE_OPTIONS = (DEVICE_BY_PRODUCT, DEVICE_OFF, DEVICE_PER_UNIT, DEVICE_PER_LINE, DEVICE_PER_SALE)
#: The parameter's word → the mode it puts on a product whose tickets are on (None: the product's own).
DEVICE_MODES = {
    DEVICE_BY_PRODUCT: None, DEVICE_OFF: OFF, DEVICE_PER_UNIT: PER_UNIT, DEVICE_PER_LINE: PER_LINE, DEVICE_PER_SALE: PER_SALE,
}


def device_mode(product_mode: Optional[str], setting: Optional[str]) -> str:
    """A product's mode on a device whose "שוברי פריט" is `setting` (unknown or unset: by the product)."""
    mode = normalize(product_mode) or OFF
    word = (setting or "").strip()
    if word == DEVICE_OFF:
        return OFF
    override = DEVICE_MODES.get(word)
    return mode if override is None or mode == OFF else override


ITEM_TICKET_PARAMETER_SPECS = (
    dict(
        key=DEVICE_PARAMETER_KEY,
        label="שוברי פריט",
        value_type="enum",
        enum_options=DEVICE_OPTIONS,
        default_value=DEVICE_BY_PRODUCT,
        description=(
            "שוברי הפריט (\"שוברים\") שהמכשיר מדפיס אחרי מכירה — מעל הגדרת הפריט. "
            f"«{DEVICE_BY_PRODUCT}» (ברירת המחדל) — כל מוצר לפי ההגדרה שלו או של המחלקה שלו, כמו קודם; "
            f"«{DEVICE_OFF}» — הקופה / הקיוסק הזה לא מדפיס שוברי פריט בכלל; "
            f"«{DEVICE_PER_UNIT}», «{DEVICE_PER_LINE}», «{DEVICE_PER_SALE}» — במקום ההגדרה של המוצר, לכל מוצר "
            "שהשוברים שלו פועלים (מוצר ששוברים כבויים בו לא מקבל שובר מכאן). חל על הקופה, על הקיוסק באנדרואיד "
            "ועל הקיוסק ב-Windows. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)
