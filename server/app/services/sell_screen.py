"""Which optional tools the till's sell screen shows.

Two flat boolean keys, each set or inherited per layer (tenant -> company -> shop,
later wins) like every other key:

    sellSearchEnabled   the magnifier that opens search over the catalog
    sellScanEnabled     the barcode scan button, and the scan shortcut in the search row

Both are **on unless switched off**. A till that has never been sent them keeps the
screen it had, so adding these keys changes nothing for any existing shop.

They hide on-screen controls only. Nothing fiscal moves, and the Android till reads
the same rule (unset or not a bool -> shown) in `posSettingsOf`.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Tuple

SELL_SEARCH_ENABLED = "sellSearchEnabled"
SELL_SCAN_ENABLED = "sellScanEnabled"

SELL_SCREEN_SETTING_KEYS: Tuple[str, ...] = (SELL_SEARCH_ENABLED, SELL_SCAN_ENABLED)

#: What an unset key means: shown.
SELL_SCREEN_DEFAULT = True


def resolve_sell_screen(merged: Mapping[str, Any]) -> Dict[str, bool]:
    """Both sell-screen keys, each a real bool, from a merged settings dict.

    Anything but a real JSON bool counts as unset, for the same reason as the
    payment options (see payment_options._stored_bool): the PATCH schema admits only
    bools, but JSONB takes whatever a script puts there, and "not a bool -> default"
    is the one rule the till's Kotlin copy can match exactly.

    A view: never write the result back into a layer's stored settings, or every
    layer would look as though it had overridden both keys.
    """
    out: Dict[str, bool] = {}
    for key in SELL_SCREEN_SETTING_KEYS:
        value = merged.get(key)
        out[key] = value if isinstance(value, bool) else SELL_SCREEN_DEFAULT
    return out
