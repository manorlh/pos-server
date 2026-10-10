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
"""
from __future__ import annotations

from typing import Any, Dict, Literal, Optional, Tuple

ALL = "all"
KIOSK_ONLY = "kiosk_only"
POS_ONLY = "pos_only"

#: Every code, in the order the forms offer them.
SALES_CHANNELS: Tuple[str, ...] = (ALL, KIOSK_ONLY, POS_ONLY)

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
    if word in SALES_CHANNELS:
        return word
    for code, label in SALES_CHANNEL_LABELS_HE.items():
        if word == _word(label):
            return code
    return _ALIASES.get(word)


def out(value: Any) -> str:
    """The stored code as the API sends it: a missing or unknown one is ``all``."""
    if isinstance(value, str) and value in SALES_CHANNELS:
        return value
    return ALL


def label(value: Any) -> str:
    return SALES_CHANNEL_LABELS_HE[out(value)]


def on_pos(value: Any) -> bool:
    """Sold at the tills (shown on the sell screen)."""
    return out(value) != KIOSK_ONLY


def on_kiosk(value: Any) -> bool:
    """Sold at the self-order kiosk."""
    return out(value) != POS_ONLY
