"""
"היכן הפריט נמכר" (docs/SPEC_PRODUCT_CHANNELS.md): where a product is sold — at the tills,
at the self-order kiosk, or both. One code on the global product (`products.sales_channel`),
sent to every till and kiosk as `salesChannel`:

* ``all`` — "קופות וקיוסק": every product that predates this, and the default;
* ``kiosk_only`` — "קיוסק בלבד": the till's sell screen hides it (grid and search);
* ``pos_only`` — "קופות בלבד": the kiosk hides it.

The cloud only stores and carries the code; the till and the kiosk apply it, and hide a
category left with nothing to sell on their channel. A code the server does not know is
refused on the way in (422) and read as ``all`` on the way out, so a stray value can never
hide a product from everywhere.

**Four channels** ("מופיע ב", app/services/product_channels.py): the code is now the (pos, kiosk)
pair of four switches, and may also be ``none`` — neither the tills nor the kiosks (a product
only on the web channels). ``none`` is stored and shown to the dashboard, never sent to a
device: every device gets one of the three older codes (`product_channels.device_code`), so a
till or kiosk of any version reads exactly what it read before.
"""
from __future__ import annotations

from typing import Any, Dict, Literal, Optional, Tuple

ALL = "all"
KIOSK_ONLY = "kiosk_only"
POS_ONLY = "pos_only"
#: Neither the tills nor the kiosks (stored; a device is never sent it).
NONE = "none"

#: Every code a till or a form of the older shape may send, in the order the forms offer them.
SALES_CHANNELS: Tuple[str, ...] = (ALL, KIOSK_ONLY, POS_ONLY)
#: Every code that may be stored.
STORED_CODES: Tuple[str, ...] = SALES_CHANNELS + (NONE,)

#: The type of the API field (`salesChannel`).
SalesChannel = Literal["all", "kiosk_only", "pos_only"]

#: The codes in Hebrew — the Excel sheet and the import's preview. The dashboard
#: (he.json `products.salesChannel*`) and the till (`strings_product_channel.xml`) carry
#: the same words.
SALES_CHANNEL_LABELS_HE: Dict[str, str] = {
    ALL: "קופות וקיוסק",
    KIOSK_ONLY: "קיוסק בלבד",
    POS_ONLY: "קופות בלבד",
}
#: Every stored code in Hebrew: the three above, and a product only on the web channels
#: ("מופיע ב" — online / digital menu). The sheet writes it, and reads it back as itself.
STORED_LABELS_HE: Dict[str, str] = {
    **SALES_CHANNEL_LABELS_HE,
    NONE: "לא בקופות ולא בקיוסק",
}

#: Other ways a sheet may write a channel (compared after `_word`).
_ALIASES: Dict[str, str] = {
    "הכל": ALL,
    "הכול": ALL,
    "שניהם": ALL,
    "קופה וקיוסק": ALL,
    "קופות וקיוסקים": ALL,
    "both": ALL,
    "all": ALL,
    "קיוסק": KIOSK_ONLY,
    "קיוסקים": KIOSK_ONLY,
    "רק קיוסק": KIOSK_ONLY,
    "kiosk": KIOSK_ONLY,
    "kiosk only": KIOSK_ONLY,
    "kiosk_only": KIOSK_ONLY,
    "קופה": POS_ONLY,
    "קופות": POS_ONLY,
    "קופה בלבד": POS_ONLY,
    "רק קופה": POS_ONLY,
    "רק קופות": POS_ONLY,
    "pos": POS_ONLY,
    "pos only": POS_ONLY,
    "pos_only": POS_ONLY,
    "till": POS_ONLY,
    "none": NONE,
    "רק אונליין": NONE,
    "אף אחד": NONE,
}


def _word(value: Any) -> str:
    return " ".join(str(value).replace("‏", "").replace("‎", "").split()).strip().lower()


def code_of(value: Any) -> Optional[str]:
    """A code or a Hebrew label (any case, spaces around) as its code; None if unknown."""
    if value is None:
        return None
    word = _word(value)
    if not word:
        return None
    if word in STORED_CODES:
        return word
    for code, label in STORED_LABELS_HE.items():
        if word == _word(label):
            return code
    return _ALIASES.get(word)


def out(value: Any) -> str:
    """
    The stored code as the dashboard's API sends it: a missing or unknown one is ``all``.
    ``none`` is the dashboard's only — a device's payload goes through
    `product_channels.device_code`, never through this.
    """
    if isinstance(value, str) and value in STORED_CODES:
        return value
    return ALL


def label(value: Any) -> str:
    return STORED_LABELS_HE[out(value)]


def on_pos(value: Any) -> bool:
    """Sold at the tills (shown on the sell screen)."""
    return out(value) in (ALL, POS_ONLY)


def on_kiosk(value: Any) -> bool:
    """Sold at the self-order kiosk."""
    return out(value) in (ALL, KIOSK_ONLY)


def code_of_pair(pos: bool, kiosk: bool) -> str:
    """The stored code of the (tills, kiosks) pair of "מופיע ב"."""
    if pos and kiosk:
        return ALL
    if kiosk:
        return KIOSK_ONLY
    if pos:
        return POS_ONLY
    return NONE
