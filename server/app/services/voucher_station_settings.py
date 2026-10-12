"""Production vouchers: closing on their own, and the voucher station — the owner's spec of 11.10.2026
(P:/specs/voucher-station-and-autoclose.md §1–§3, and §5 of 12.10.2026).

Two flat keys, set or inherited per layer (tenant -> company -> shop -> point of sale -> till, the
deepest wins) like `voucherRedeemFlow` (app/services/voucher_redeem_settings.py):

    voucherAutoClose   "on"  — "סגירה אוטומטית כשהשובר מכסה הכל": vouchers that cover the whole sale
                               close it by themselves and the till goes on to a new order (today's
                               behaviour, the default)
                       "off" — the green card with "סגור עסקה" stays; the sale closes on that press
    voucherStation     "off" — the usual sale screen (the default)
                       "on"  — "עמדת שובר": a scan-only screen (and typing the code when
                               payVoucherManualEnabled), then only what the voucher can redeem, with
                               its terms; it always closes as if voucherAutoClose were "on"

And one more, added 12.10.2026 (the spec's §5), set and inherited the same way:

    voucherStationPaidItems  "off" — the station redeems vouchers only, as in §2 (the default)
                             "on"  — "רכישה נוספת בתשלום בעמדת שובר": after "הוסף למימוש" the
                                     customer can add items at the regular price to the same sale
                                     and pay for them with the till's payment options (pay*Enabled);
                                     with none of them on the till shows no such button

And one more, added 13.10.2026 (P:/specs/voucher-one-per-group.md, "כרטיס אוטומטי"), set and inherited
the same way:

    voucherShowEntitlement  "on"  — "הצג לקופאי מה מגיע ללקוח בסריקת שובר": every scan opens a small
                                    card with what the voucher gives and what is left; it never stops
                                    the redemption (the default)
                            "off" — the till behaves as before

And two more, added 12.10.2026 ("צליל אישור חזק וצליל סירוב חזק, אפשר לבטל אותם בפרמטרים — לגבי
השוברים במימוש"), set and inherited the same way:

    voucherSoundApprove  "on"  — "צליל אישור במימוש שובר": a short loud rising double beep once when a
                                 voucher is accepted at the scan and once when its redemption is
                                 done ("השובר מומש"), per voucher (the default)
                         "off" — silent
    voucherSoundReject   "on"  — "צליל סירוב במימוש שובר": a lower, longer buzz once for every refusal
                                 shown in red — used, cancelled, expired, not yet valid, another shop,
                                 nothing eligible in the basket, stacking, the per-sale limit, no
                                 connection, the test-mode mix, a second scan in the same sale (the
                                 default)
                         "off" — silent
    The till never plays either over a card payment in progress.

They go to the till always resolved (GET /sync/{id}/settings, `settings.<key>`): anything but a known
value counts as unset. A change is written to the till parameters' change log
(voucher_redeem_settings.audit_patch).
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Tuple

VOUCHER_AUTO_CLOSE_KEY = "voucherAutoClose"
VOUCHER_STATION_KEY = "voucherStation"

ON = "on"
OFF = "off"
#: The values each key takes; the Android till reads the same.
AUTO_CLOSE_VALUES: Tuple[str, ...] = (ON, OFF)
STATION_VALUES: Tuple[str, ...] = (OFF, ON)

#: Unset everywhere: close on their own (today), and the usual sale screen.
DEFAULT_AUTO_CLOSE = ON
DEFAULT_STATION = OFF

VOUCHER_STATION_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_AUTO_CLOSE_KEY, VOUCHER_STATION_KEY)

#: §5: items paid for at the regular price, added at the station after the voucher is redeemed.
VOUCHER_STATION_PAID_ITEMS_KEY = "voucherStationPaidItems"
STATION_PAID_ITEMS_VALUES: Tuple[str, ...] = (OFF, ON)
#: Unset everywhere: the station redeems vouchers only.
DEFAULT_STATION_PAID_ITEMS = OFF

VOUCHER_STATION_PAID_ITEMS_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_STATION_PAID_ITEMS_KEY,)

#: 13.10.2026: the cashier's "מה מגיע ללקוח" card on every voucher scan.
VOUCHER_SHOW_ENTITLEMENT_KEY = "voucherShowEntitlement"
SHOW_ENTITLEMENT_VALUES: Tuple[str, ...] = (ON, OFF)
#: Unset everywhere: the card is shown.
DEFAULT_SHOW_ENTITLEMENT = ON

VOUCHER_SHOW_ENTITLEMENT_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_SHOW_ENTITLEMENT_KEY,)

#: 12.10.2026: the strong approve / reject sounds when a voucher is redeemed.
VOUCHER_SOUND_APPROVE_KEY = "voucherSoundApprove"
VOUCHER_SOUND_REJECT_KEY = "voucherSoundReject"
SOUND_VALUES: Tuple[str, ...] = (ON, OFF)
#: Unset everywhere: both sounds play.
DEFAULT_SOUND_APPROVE = ON
DEFAULT_SOUND_REJECT = ON

VOUCHER_SOUND_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_SOUND_APPROVE_KEY, VOUCHER_SOUND_REJECT_KEY)


def resolve_voucher_station(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """Both keys resolved from a merged settings dict; an unknown or missing value = the default. A view only."""
    auto_close = merged.get(VOUCHER_AUTO_CLOSE_KEY)
    station = merged.get(VOUCHER_STATION_KEY)
    return {
        VOUCHER_AUTO_CLOSE_KEY: auto_close if isinstance(auto_close, str) and auto_close in AUTO_CLOSE_VALUES else DEFAULT_AUTO_CLOSE,
        VOUCHER_STATION_KEY: station if isinstance(station, str) and station in STATION_VALUES else DEFAULT_STATION,
    }


def resolve_station_paid_items(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherStationPaidItems` resolved from a merged settings dict; unknown or missing = "off". A view only.

    Only the key: whether the till has a payment option to take the money with is the till's call
    (pay*Enabled, also sent resolved), so "on" with none of them simply shows no button.
    """
    paid = merged.get(VOUCHER_STATION_PAID_ITEMS_KEY)
    return {
        VOUCHER_STATION_PAID_ITEMS_KEY: paid
        if isinstance(paid, str) and paid in STATION_PAID_ITEMS_VALUES
        else DEFAULT_STATION_PAID_ITEMS,
    }


def resolve_show_entitlement(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherShowEntitlement` resolved from a merged settings dict; unknown or missing = "on". A view only."""
    show = merged.get(VOUCHER_SHOW_ENTITLEMENT_KEY)
    return {
        VOUCHER_SHOW_ENTITLEMENT_KEY: show
        if isinstance(show, str) and show in SHOW_ENTITLEMENT_VALUES
        else DEFAULT_SHOW_ENTITLEMENT,
    }


def resolve_voucher_sounds(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherSoundApprove` / `voucherSoundReject` resolved from a merged settings dict; unknown or
    missing = "on". A view only."""
    approve = merged.get(VOUCHER_SOUND_APPROVE_KEY)
    reject = merged.get(VOUCHER_SOUND_REJECT_KEY)
    return {
        VOUCHER_SOUND_APPROVE_KEY: approve if isinstance(approve, str) and approve in SOUND_VALUES else DEFAULT_SOUND_APPROVE,
        VOUCHER_SOUND_REJECT_KEY: reject if isinstance(reject, str) and reject in SOUND_VALUES else DEFAULT_SOUND_REJECT,
    }
