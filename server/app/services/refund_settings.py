"""How the till handles returns (זיכוי), as two till settings.

Two flat boolean keys, each set or inherited per layer (tenant -> company -> shop,
later wins) like every other key:

    unlinkedCardCreditEnabled       a card credit (refund to a card) may be issued for a
                                    return with no original receipt — one picked from
                                    the catalogue (docs/SHIFTS_API.md §1.2a)
    refundCustomerDetailsRequired   the till asks for the buyer's name / phone /
                                    address before it issues a credit note, and sends
                                    them as customerName / customerPhone / customerAddress

Both are **on unless switched off**, and go to the till always resolved to a real bool
(unset or not a bool -> on), the rule the sell-screen switches follow
(`app/services/sell_screen.py`). They steer the till's return flow only; the server
accepts every credit note it is sent, whatever these say — a fiscal document the till
issued is never refused over a setting.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Tuple

UNLINKED_CARD_CREDIT_ENABLED = "unlinkedCardCreditEnabled"
REFUND_CUSTOMER_DETAILS_REQUIRED = "refundCustomerDetailsRequired"

REFUND_SETTING_KEYS: Tuple[str, ...] = (
    UNLINKED_CARD_CREDIT_ENABLED,
    REFUND_CUSTOMER_DETAILS_REQUIRED,
)

#: What an unset key means: on.
REFUND_SETTING_DEFAULT = True


def resolve_refund_settings(merged: Mapping[str, Any]) -> Dict[str, bool]:
    """Both return-flow keys, each a real bool, from a merged settings dict.

    Anything but a real JSON bool counts as unset (see `resolve_sell_screen`). A view:
    never write the result back into a layer's stored settings.
    """
    out: Dict[str, bool] = {}
    for key in REFUND_SETTING_KEYS:
        value = merged.get(key)
        out[key] = value if isinstance(value, bool) else REFUND_SETTING_DEFAULT
    return out
