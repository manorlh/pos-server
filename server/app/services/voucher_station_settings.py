"""Production vouchers: closing on their own, and the voucher station — the owner's spec of 11.10.2026
(P:/specs/voucher-station-and-autoclose.md §1–§3).

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


def resolve_voucher_station(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """Both keys resolved from a merged settings dict; an unknown or missing value = the default. A view only."""
    auto_close = merged.get(VOUCHER_AUTO_CLOSE_KEY)
    station = merged.get(VOUCHER_STATION_KEY)
    return {
        VOUCHER_AUTO_CLOSE_KEY: auto_close if isinstance(auto_close, str) and auto_close in AUTO_CLOSE_VALUES else DEFAULT_AUTO_CLOSE,
        VOUCHER_STATION_KEY: station if isinstance(station, str) and station in STATION_VALUES else DEFAULT_STATION,
    }
