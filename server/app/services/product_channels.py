"""
"מופיע ב" — the channels a product appears in: `pos` ("קופה"), `kiosk` ("קיוסק"), `online`
("הזמנות אונליין") and `menu` ("תפריט דיגיטלי") — the same four a block speaks of
(app/services/sold_out_rules.py `CHANNELS`, specs/item-blocks-targets.md).

Stored on the global product as `products.appears_in` (a list). A product that never had it set
(NULL) appears where it always did: at the tills and the kiosk as "היכן הפריט נמכר" says
(`sales_channel`, app/services/sales_channel.py), and not online nor in the digital menu — those
channels start OFF until the product is published there.

The tills and the kiosks still read `salesChannel`; it is kept in step with the pos / kiosk part
(`sales_channel_for`), and a product in neither is sent to each device as the other one's only
(`device_sales_channel`), so every device that exists hides it. Online ordering and the digital
menu ask `appears` (and the blocks' resolver, app/services/sold_out.py `resolve_channel`).
"""
from __future__ import annotations

from typing import Any, Iterable, Optional, Sequence, Tuple

from app.services import sales_channel as SC
from app.services import sold_out_rules as rules

CHANNELS: Tuple[str, ...] = rules.CHANNELS
POS, KIOSK, ONLINE, MENU = rules.CH_POS, rules.CH_KIOSK, rules.CH_ONLINE, rules.CH_MENU

#: The Hebrew of each channel (the dashboard and the till carry the same words).
LABELS_HE = {POS: "קופה", KIOSK: "קיוסק", ONLINE: "הזמנות אונליין", MENU: "תפריט דיגיטלי"}


class ChannelsInvalid(ValueError):
    """A channel the server does not know."""


def clean(values: Optional[Iterable[Any]]) -> Optional[Tuple[str, ...]]:
    """The list as stored: known channels in their order, each once; None stays None. Raises on an unknown one."""
    if values is None:
        return None
    named = []
    for v in values:
        code = str(v).strip().lower()
        if code not in CHANNELS:
            raise ChannelsInvalid(f"unknown channel {v!r}")
        named.append(code)
    return tuple(c for c in CHANNELS if c in set(named))


def from_sales_channel(code: Any) -> Tuple[str, ...]:
    """What "היכן הפריט נמכר" meant, as channels (never online, never the menu)."""
    value = SC.out(code)
    if value == SC.POS_ONLY:
        return (POS,)
    if value == SC.KIOSK_ONLY:
        return (KIOSK,)
    return (POS, KIOSK)


def appears_in(product: Any) -> Tuple[str, ...]:
    """The channels the product appears in (its own list, else `sales_channel`'s)."""
    own = rules.channels_in(getattr(product, "appears_in", None))
    if own is not None:
        return own
    return from_sales_channel(getattr(product, "sales_channel", None))


def appears(product: Any, channel: str) -> bool:
    return channel in appears_in(product)


def sales_channel_for(channels: Sequence[str]) -> str:
    """The `sales_channel` the pos / kiosk part means (in neither: "all", never read — see `device_sales_channel`)."""
    named = set(channels)
    if POS in named and KIOSK not in named:
        return SC.POS_ONLY
    if KIOSK in named and POS not in named:
        return SC.KIOSK_ONLY
    return SC.ALL


def device_sales_channel(product: Any, is_kiosk: bool) -> str:
    """
    `salesChannel` as a device gets it: the code its "מופיע ב" means — and for a product at
    neither the tills nor the kiosk, the other device kind's only, so this one hides it.
    """
    named = set(appears_in(product))
    if POS not in named and KIOSK not in named:
        return SC.POS_ONLY if is_kiosk else SC.KIOSK_ONLY
    return sales_channel_for(tuple(named))


def apply(product: Any, *, appears: Optional[Sequence[str]] = None, sales_channel_changed: bool = False) -> None:
    """
    After a write: a new "מופיע ב" sets `sales_channel` to match; a new `sales_channel` alone (an
    older form, the till's product dialog, an import) moves the pos / kiosk part of a product that
    has its own list, keeping online and the menu as they were.
    """
    if appears is not None:
        product.appears_in = list(appears)
        product.sales_channel = sales_channel_for(appears)
        return
    if sales_channel_changed and getattr(product, "appears_in", None) is not None:
        others = [c for c in (rules.channels_in(product.appears_in) or ()) if c in (ONLINE, MENU)]
        base = from_sales_channel(product.sales_channel)
        product.appears_in = [c for c in CHANNELS if c in set(base) | set(others)]
