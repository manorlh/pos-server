"""The four ways a till takes payment, and which of them a merchant lets it offer.

This is the one place the payment options and their settings rule are defined.
The dashboard views and the till sync both read resolved values from here; the
Android till carries the same rule in Kotlin, pinned to the same parity table
(tests/test_payment_options.py), so a change here is a change there too.

An option is an *entry path* on the till, not a tender. A document stored from
any of them still says `paymentMethod` "cash" or "card" — nothing fiscal moves:

    fastCash   one tap, cash at exactly the amount due       -> cash
    cash       cash keypad, another amount, change computed  -> cash
    fastCard   one tap, card, single payment                 -> card
    card       card, instalments picker first                -> card

Each option has two flat top-level setting keys, one saying whether the till
offers it and one saying whether it asks for a tip. Flat rather than one nested
object because the tenant -> company -> shop merge and the dashboard's
inherited/overridden badges both work per top-level key, and the till keeps
settings as a flat string key/value table.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Literal, Mapping, Optional, Tuple


@dataclass(frozen=True)
class PaymentOption:
    name: str
    tender: Literal["cash", "card"]
    allowed_key: str
    tips_key: str


FAST_CASH = PaymentOption("fastCash", "cash", "payFastCashEnabled", "payFastCashTips")
CASH = PaymentOption("cash", "cash", "payCashEnabled", "payCashTips")
FAST_CARD = PaymentOption("fastCard", "card", "payFastCardEnabled", "payFastCardTips")
CARD = PaymentOption("card", "card", "payCardEnabled", "payCardTips")

PAYMENT_OPTIONS: Tuple[PaymentOption, ...] = (FAST_CASH, CASH, FAST_CARD, CARD)

PAYMENT_OPTION_ALLOWED_KEYS: Tuple[str, ...] = tuple(o.allowed_key for o in PAYMENT_OPTIONS)
PAYMENT_OPTION_SETTING_KEYS: Tuple[str, ...] = tuple(
    key for o in PAYMENT_OPTIONS for key in (o.allowed_key, o.tips_key)
)


def _stored_bool(merged: Mapping[str, Any], key: str) -> Optional[bool]:
    """The stored value if it is a real JSON bool, else None (= not set).

    The PATCH schema only admits bools, but JSONB takes whatever a script or a
    hand edit puts there. Coercing a string "true" or a 1 here would need the
    till's Kotlin copy of this rule to coerce identically; treating anything
    but a bool as unset is the one behaviour both sides can match exactly.
    """
    value = merged.get(key)
    return value if isinstance(value, bool) else None


def is_allowed(merged: Mapping[str, Any], option: PaymentOption) -> bool:
    # Unset means offered: every tenant that predates these keys keeps all four.
    stored = _stored_bool(merged, option.allowed_key)
    return True if stored is None else stored


def _legacy_asks_for_tip(merged: Mapping[str, Any], option: PaymentOption) -> bool:
    # Before per-option keys there were two switches: tipsEnabled for tips at all,
    # and cashTipsEnabled narrowing it for cash. cashTipsEnabled alone never
    # turned tips on, so it is only read under tipsEnabled here too.
    tips_on = merged.get("tipsEnabled") is True
    if option.tender == "cash":
        return tips_on and merged.get("cashTipsEnabled") is True
    return tips_on


def asks_for_tip(merged: Mapping[str, Any], option: PaymentOption) -> bool:
    """Whether the till asks for a tip on this option. A hidden option never does."""
    if not is_allowed(merged, option):
        return False
    stored = _stored_bool(merged, option.tips_key)
    return _legacy_asks_for_tip(merged, option) if stored is None else stored


def resolve_payment_options(
    merged: Mapping[str, Any], *, effective: bool = True
) -> Dict[str, bool]:
    """All eight payment option keys, each a real bool, from a merged settings dict.

    `merged` is the tenant -> company -> shop merge (later wins). This is a view:
    never write the result back into stored settings, or every layer would look as
    though it had overridden every key.

    With `effective` (the till's view) the tips keys are already false for an option
    that is not offered. Without it (the dashboard's inherited preview) they carry
    the tips choice itself, hidden option or not. The preview needs the choice: a
    company that hides cash while keeping cash tips on would otherwise show a shop
    "tips off" for cash, and the shop that re-allows cash would then get the tips
    its own screen said it would not.
    """
    out: Dict[str, bool] = {}
    for option in PAYMENT_OPTIONS:
        out[option.allowed_key] = is_allowed(merged, option)
        if effective:
            out[option.tips_key] = asks_for_tip(merged, option)
        else:
            stored = _stored_bool(merged, option.tips_key)
            out[option.tips_key] = (
                _legacy_asks_for_tip(merged, option) if stored is None else stored
            )
    return out


def legacy_tip_flags(resolved: Mapping[str, bool]) -> Dict[str, bool]:
    """tipsEnabled / cashTipsEnabled derived from resolved options, for older APKs.

    A till that predates the per-option keys reads only these two. Deriving them
    from the resolved options (rather than passing the stored values through)
    means a merchant who turns tips on for one option through the new keys alone
    still gets tips on the old till, and one who hides every cash path does not
    get cash tips there. It is lossy by nature: two switches cannot say "tips on
    cash but not on card", so an old till in that case asks on card as well.
    """
    cash_tips = any(resolved[o.tips_key] for o in PAYMENT_OPTIONS if o.tender == "cash")
    return {
        "tipsEnabled": any(resolved[o.tips_key] for o in PAYMENT_OPTIONS),
        "cashTipsEnabled": cash_tips,
    }


def any_allowed(merged: Mapping[str, Any]) -> bool:
    return any(is_allowed(merged, o) for o in PAYMENT_OPTIONS)
