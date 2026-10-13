"""How a till enters the redemption of a production voucher ("שובר הפקה") — the owner's spec of 11.10.2026, §2 and §8.

Two flat keys, each set or inherited per layer (tenant -> company -> shop -> point of sale -> till,
the deepest wins) like the voucher's payment switches (`payVoucherEnabled`, payment_options.py):

    voucherRedeemFlow        "items_first"   — "בחירת פריטים תחילה": the cashier picks the goods, then
                                               scans the voucher and it is matched to them
                             "voucher_first" — "סריקת שובר תחילה": a scan on the order screen (an empty
                                               order too) opens "בחירת פריטים למימוש שובר" with only
                                               the voucher's eligible goods
                             "both"          — "שתי הדרכים": either way in, on the same till — a scan on
                                               an empty order opens the voucher's item picker at once,
                                               a scan with items in the order goes to the payment
    voucherShowUnavailable   true  — an eligible item that is not for sale now is shown blocked, with
                                     the reason, in the voucher's item picker ("הצג כחסומים")
                             false — it is hidden there ("הסתר")

Unset at every level: "both" and true (the owner, 13.10.2026 — "items_first" until then made a "one
from each group" voucher scanned on an empty order go round twice: its goods in, "השלימו את
הבחירה… ואז סרקו את השובר שוב"). A level that sets "items_first" keeps it: only the unset default
moved. They go to the till always resolved (GET /sync/{id}/settings, `settings.<key>`), so the
till never decides what a missing key means; anything but a known value counts as unset (the PATCH
schema admits only those, but JSONB takes whatever a script puts there). They steer the till's
screens only: eligibility, quotas and the redemption itself are the same rules on both ways in.

Who changed them is written to the till parameters' change log (`till_parameter_changes`,
app/services/till_parameter_audit.py) with the level and the old and new value, in the same
transaction as the change; the voucher's two payment switches are logged there the same way.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, Mapping, Optional, Tuple

VOUCHER_REDEEM_FLOW_KEY = "voucherRedeemFlow"
VOUCHER_SHOW_UNAVAILABLE_KEY = "voucherShowUnavailable"

ITEMS_FIRST = "items_first"
VOUCHER_FIRST = "voucher_first"
BOTH = "both"
#: The values `voucherRedeemFlow` takes; the Android till reads the same three.
REDEEM_FLOWS: Tuple[str, ...] = (ITEMS_FIRST, VOUCHER_FIRST, BOTH)

#: What an unset key means: both ways in, and unavailable items shown blocked.
DEFAULT_REDEEM_FLOW = BOTH
DEFAULT_SHOW_UNAVAILABLE = True

VOUCHER_FLOW_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_REDEEM_FLOW_KEY, VOUCHER_SHOW_UNAVAILABLE_KEY)


def resolve_voucher_flow(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """Both keys resolved from a merged settings dict; an unknown or missing value = the default.

    A view, like resolve_voucher_options: never write it back into a layer.
    """
    flow = merged.get(VOUCHER_REDEEM_FLOW_KEY)
    show = merged.get(VOUCHER_SHOW_UNAVAILABLE_KEY)
    return {
        VOUCHER_REDEEM_FLOW_KEY: flow if isinstance(flow, str) and flow in REDEEM_FLOWS else DEFAULT_REDEEM_FLOW,
        VOUCHER_SHOW_UNAVAILABLE_KEY: show if isinstance(show, bool) else DEFAULT_SHOW_UNAVAILABLE,
    }


def _audited_keys() -> Tuple[str, ...]:
    from app.services.payment_options import VOUCHER_SETTING_KEYS
    from app.services.voucher_balance_check import VOUCHER_BALANCE_SETTING_KEYS
    from app.services.voucher_station_settings import (
        VOUCHER_SHOW_ENTITLEMENT_SETTING_KEYS,
        VOUCHER_SOUND_SETTING_KEYS,
        VOUCHER_STATION_PAID_ITEMS_SETTING_KEYS,
        VOUCHER_STATION_SETTING_KEYS,
    )

    return (
        *VOUCHER_FLOW_SETTING_KEYS,
        *VOUCHER_SETTING_KEYS,
        *VOUCHER_BALANCE_SETTING_KEYS,
        *VOUCHER_STATION_SETTING_KEYS,
        *VOUCHER_STATION_PAID_ITEMS_SETTING_KEYS,
        *VOUCHER_SHOW_ENTITLEMENT_SETTING_KEYS,
        *VOUCHER_SOUND_SETTING_KEYS,
    )


def audit_patch(db, level: str, entity: Any, patch: Mapping[str, Any], user: Any) -> int:
    """
    One change-log row per voucher key [patch] changes on [entity]'s own layer (call it before the
    layer is written; the caller commits). `null` in the patch is a reset to inherit ("clear").
    Returns how many rows were added.
    """
    from app.services import till_parameter_audit as AUDIT

    stored = getattr(entity, "settings", None)
    stored = stored if isinstance(stored, dict) else {}
    n = 0
    for key in _audited_keys():
        if key not in patch:
            continue
        old: Optional[Any] = stored.get(key)
        new = patch[key]
        if old == new:
            continue
        AUDIT.record_change(
            db,
            parameter=SimpleNamespace(id=None, key=key),
            scope_type=level,
            scope_id=getattr(entity, "id", None),
            action=AUDIT.CLEAR if new is None else AUDIT.SET,
            old_value=old,
            new_value=new,
            user=user,
        )
        n += 1
    return n
