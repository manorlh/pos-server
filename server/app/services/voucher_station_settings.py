"""Production vouchers: closing on their own, and the voucher station — the owner's spec of 11.10.2026
(P:/specs/voucher-station-and-autoclose.md §1–§3, and §5 of 12.10.2026).

Two flat keys, set or inherited per layer (tenant -> company -> shop -> point of sale -> till, the
deepest wins) like `voucherRedeemFlow` (app/services/voucher_redeem_settings.py):

    voucherAutoClose   "on"  — "סגירה אוטומטית כשהשובר מכסה הכל": vouchers that cover the whole sale
                               close it by themselves and the till goes on to a new order (today's
                               behaviour, the default)
                       "off" — the green card with "סגור עסקה וממש שובר" stays; the sale closes on
                               that press
    voucherStation     "off" — the usual sale screen (the default)
                       "on"  — "עמדת שובר": a scan-only screen (and typing the code when
                               payVoucherManualEnabled), then only what the voucher can redeem, with
                               its terms; a voucher that covers the whole sale closes it by itself
                               only while voucherAutoClose is "on", otherwise on a press of
                               "סגור עסקה וממש שובר" (the owner, 12.10.2026: the station respects
                               voucherAutoClose)

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

And one more, added 12.10.2026 ("מימוש אוטומטי בסריקת שובר"), set and inherited the same way:

    voucherAutoApply  "on"  — "מימוש אוטומטי בסריקת שובר": a voucher scanned with items already in the
                              cart is applied at once to the matching cart lines, with no redeem sheet
                              and no "מימוש" press, when no choice is needed; the sheet opens only when
                              one is (the default)
                      "off" — the redeem sheet opens as before

And two more, added 12.10.2026 (the green success screen after a voucher redemption), set and
inherited the same way:

    voucherSuccessScreen   "always"     — "מסך הצלחה במימוש שובר": a large green screen after every
                                          sale in which a voucher was redeemed (the default)
                           "auto_close" — only when the voucher closed the sale by itself
                           "off"        — the usual end-of-sale screen only
    voucherSuccessSeconds  1–10         — "משך מסך ההצלחה (שניות)": how long it stays (default 3);
                                          an integer outside 1–10 is a 422 on write, and anything
                                          but such an integer reads as 3

And one more, added 13.10.2026 (P:/specs/voucher-fast-mode.md §0 item 11, "פיצ'ר דינמי"), set and
inherited the same way:

    voucherSuccessDismiss  "auto"    — "סגירת מסך 'שובר מומש'": the green screen closes by itself after
                                       voucherSuccessSeconds, or on a touch (the default)
                           "confirm" — it stays until the cashier presses a large "אישור", so they know
                                       the voucher went through; a new scan counts as that press and
                                       goes on to the next voucher, so the queue never stalls
    It applies to every voucher success screen: the usual till (the auto apply's too) and the station.

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

And nine more, added 13.10.2026 (P:/specs/voucher-fast-mode.md §0, "מצב מהיר כשהעובד לא צריך לבחור
פריט" — "המכשיר עובר להיות בקר סריקה"), set and inherited the same way:

    voucherFastMode             "off"     — "מצב מהיר: מימוש בלי בחירה כשהשובר ברור": as before
                                "station" — only on the voucher station screen (the default): a clear
                                            voucher (no choice for the cashier — §1) is redeemed on
                                            the scan, no redeem sheet, its own sale, the green screen
                                "all"     — on the usual order screen too (the spec's §3)
    voucherFastAutoClose        "on"      — "סגירה לבד במצב מהיר": in fast mode a sale the clear voucher
                                            covers (₪0 left) closes and is saved by itself with the green
                                            screen (the default; voucherAutoClose rules the usual flow only)
                                "off"     — the cashier presses "סגור עסקה וממש שובר"
    voucherStationCamera        "off"     — "מצלמה בעמדת שובר": the scanner head / keyboard scanner only
                                "always"  — a live camera on the station screen; the same code within 3
                                            seconds is ignored; off while paying, on leaving the screen
                                            or with the screen off
                                "tap"     — opened by a tap (the default)
    voucherStationCameraFacing  "back" | "front" — "איזו מצלמה בעמדת שובר" (default "back"; "front"
                                            for a fixed station the customer shows the voucher to)
    voucherVibrate              "off" | "approve" | "reject" | "both" — "רטט במימוש שובר" (default
                                            "both"): a short buzz on approve, three long ones on reject;
                                            only a device with a vibrator (hasVibrator()) does anything
    voucherSoundBoost           "on"      — "הגברת צליל שובר לעוצמה מקסימלית": the notification volume up
                                            to the maximum for the voucher sound, back right after (the
                                            default)
                                "off"     — the device's volume as is
    voucherStationCatalogSwitch "off" | "manager" | "free" — "מעבר מעמדת שובר לקטלוג רגיל": never,
                                            with a manager's code (the default, as before), or freely
    voucherStationHeader        "logo" | "text" | "both" | "none" — "כותרת במסך עמדת שובר" (default
                                            "logo": the shop's or company's brand logo, the receipt's and
                                            the kiosk's)
    voucherStationTitle         free text — "כיתוב בראש עמדת שובר": up to 40 characters, whitespace
                                            collapsed and trimmed on write (blank = reset to inherit);
                                            longer is a 422 in Hebrew; unset, blank or junk reads as
                                            "עמדת מימוש שוברים"

They go to the till always resolved (GET /sync/{id}/settings, `settings.<key>`): anything but a known
value counts as unset. A change is written to the till parameters' change log
(voucher_redeem_settings.audit_patch).
"""
from __future__ import annotations

import unicodedata
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

#: 12.10.2026: a voucher scanned over a cart is applied to the matching lines with no redeem sheet.
VOUCHER_AUTO_APPLY_KEY = "voucherAutoApply"
AUTO_APPLY_VALUES: Tuple[str, ...] = (ON, OFF)
#: Unset everywhere: applied at once when no choice is needed.
DEFAULT_AUTO_APPLY = ON

VOUCHER_AUTO_APPLY_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_AUTO_APPLY_KEY,)

#: 12.10.2026: the green success screen after a voucher redemption, and how long it stays.
VOUCHER_SUCCESS_SCREEN_KEY = "voucherSuccessScreen"
VOUCHER_SUCCESS_SECONDS_KEY = "voucherSuccessSeconds"
SUCCESS_ALWAYS = "always"
SUCCESS_AUTO_CLOSE = "auto_close"
SUCCESS_SCREEN_VALUES: Tuple[str, ...] = (SUCCESS_ALWAYS, SUCCESS_AUTO_CLOSE, OFF)
SUCCESS_SECONDS_MIN = 1
SUCCESS_SECONDS_MAX = 10
#: Unset everywhere: the screen after every voucher sale, for 3 seconds.
DEFAULT_SUCCESS_SCREEN = SUCCESS_ALWAYS
DEFAULT_SUCCESS_SECONDS = 3

VOUCHER_SUCCESS_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_SUCCESS_SCREEN_KEY, VOUCHER_SUCCESS_SECONDS_KEY)

#: 13.10.2026 (P:/specs/voucher-fast-mode.md §0 item 11): how the green "שובר מומש" screen closes.
VOUCHER_SUCCESS_DISMISS_KEY = "voucherSuccessDismiss"
SUCCESS_DISMISS_AUTO = "auto"
SUCCESS_DISMISS_CONFIRM = "confirm"
SUCCESS_DISMISS_VALUES: Tuple[str, ...] = (SUCCESS_DISMISS_AUTO, SUCCESS_DISMISS_CONFIRM)
#: Unset everywhere: by itself after voucherSuccessSeconds (or on a touch).
DEFAULT_SUCCESS_DISMISS = SUCCESS_DISMISS_AUTO

VOUCHER_SUCCESS_DISMISS_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_SUCCESS_DISMISS_KEY,)

#: 12.10.2026: the strong approve / reject sounds when a voucher is redeemed.
VOUCHER_SOUND_APPROVE_KEY = "voucherSoundApprove"
VOUCHER_SOUND_REJECT_KEY = "voucherSoundReject"
SOUND_VALUES: Tuple[str, ...] = (ON, OFF)
#: Unset everywhere: both sounds play.
DEFAULT_SOUND_APPROVE = ON
DEFAULT_SOUND_REJECT = ON

VOUCHER_SOUND_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_SOUND_APPROVE_KEY, VOUCHER_SOUND_REJECT_KEY)

#: 13.10.2026 (P:/specs/voucher-fast-mode.md §0): the voucher fast mode — "המכשיר עובר להיות בקר סריקה".
VOUCHER_FAST_MODE_KEY = "voucherFastMode"
VOUCHER_FAST_AUTO_CLOSE_KEY = "voucherFastAutoClose"
VOUCHER_STATION_CAMERA_KEY = "voucherStationCamera"
VOUCHER_STATION_CAMERA_FACING_KEY = "voucherStationCameraFacing"
VOUCHER_VIBRATE_KEY = "voucherVibrate"
VOUCHER_SOUND_BOOST_KEY = "voucherSoundBoost"
VOUCHER_STATION_CATALOG_SWITCH_KEY = "voucherStationCatalogSwitch"
VOUCHER_STATION_HEADER_KEY = "voucherStationHeader"
VOUCHER_STATION_TITLE_KEY = "voucherStationTitle"

FAST_MODE_VALUES: Tuple[str, ...] = (OFF, "station", "all")
FAST_AUTO_CLOSE_VALUES: Tuple[str, ...] = (ON, OFF)
STATION_CAMERA_VALUES: Tuple[str, ...] = (OFF, "always", "tap")
STATION_CAMERA_FACING_VALUES: Tuple[str, ...] = ("back", "front")
VIBRATE_VALUES: Tuple[str, ...] = (OFF, "approve", "reject", "both")
SOUND_BOOST_VALUES: Tuple[str, ...] = (ON, OFF)
STATION_CATALOG_SWITCH_VALUES: Tuple[str, ...] = (OFF, "manager", "free")
STATION_HEADER_VALUES: Tuple[str, ...] = ("logo", "text", "both", "none")
#: "כיתוב בראש עמדת שובר": "טקסט חופשי עד 40 תווים".
STATION_TITLE_MAX = 40

#: Unset everywhere — the owner's defaults (§0): fast at the station only, closing by itself, the
#: camera on a tap, the back one, both buzzes, the boost on, the catalog behind a manager's code, the
#: logo on top and "עמדת מימוש שוברים" as the title.
DEFAULT_FAST_MODE = "station"
DEFAULT_FAST_AUTO_CLOSE = ON
DEFAULT_STATION_CAMERA = "tap"
DEFAULT_STATION_CAMERA_FACING = "back"
DEFAULT_VIBRATE = "both"
DEFAULT_SOUND_BOOST = ON
DEFAULT_STATION_CATALOG_SWITCH = "manager"
DEFAULT_STATION_HEADER = "logo"
DEFAULT_STATION_TITLE = "עמדת מימוש שוברים"

#: The eight choices: key -> (the values it takes, its default). The title is free text, apart.
VOUCHER_FAST_CHOICES: Dict[str, Tuple[Tuple[str, ...], str]] = {
    VOUCHER_FAST_MODE_KEY: (FAST_MODE_VALUES, DEFAULT_FAST_MODE),
    VOUCHER_FAST_AUTO_CLOSE_KEY: (FAST_AUTO_CLOSE_VALUES, DEFAULT_FAST_AUTO_CLOSE),
    VOUCHER_STATION_CAMERA_KEY: (STATION_CAMERA_VALUES, DEFAULT_STATION_CAMERA),
    VOUCHER_STATION_CAMERA_FACING_KEY: (STATION_CAMERA_FACING_VALUES, DEFAULT_STATION_CAMERA_FACING),
    VOUCHER_VIBRATE_KEY: (VIBRATE_VALUES, DEFAULT_VIBRATE),
    VOUCHER_SOUND_BOOST_KEY: (SOUND_BOOST_VALUES, DEFAULT_SOUND_BOOST),
    VOUCHER_STATION_CATALOG_SWITCH_KEY: (STATION_CATALOG_SWITCH_VALUES, DEFAULT_STATION_CATALOG_SWITCH),
    VOUCHER_STATION_HEADER_KEY: (STATION_HEADER_VALUES, DEFAULT_STATION_HEADER),
}

VOUCHER_FAST_MODE_SETTING_KEYS: Tuple[str, ...] = (*VOUCHER_FAST_CHOICES, VOUCHER_STATION_TITLE_KEY)

#: `code` of the 422 for a title over STATION_TITLE_MAX characters.
STATION_TITLE_TOO_LONG = "voucher_station_title_too_long"


def station_title_too_long_message(length: int) -> str:
    return f"לא ניתן לשמור כיתוב של {length} תווים: הכיתוב בראש עמדת שובר יכול להיות עד {STATION_TITLE_MAX} תווים."


def normalize_station_title(value: str) -> str:
    """One line as the till shows it: control characters as spaces, runs of whitespace as one, trimmed."""
    return " ".join("".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in value).split())


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


def resolve_auto_apply(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherAutoApply` resolved from a merged settings dict; unknown or missing = "on". A view only."""
    auto_apply = merged.get(VOUCHER_AUTO_APPLY_KEY)
    return {
        VOUCHER_AUTO_APPLY_KEY: auto_apply
        if isinstance(auto_apply, str) and auto_apply in AUTO_APPLY_VALUES
        else DEFAULT_AUTO_APPLY,
    }


def _success_seconds(value: Any) -> int:
    """An int (not a bool) in 1–10 as is; anything else = 3."""
    if isinstance(value, int) and not isinstance(value, bool) and SUCCESS_SECONDS_MIN <= value <= SUCCESS_SECONDS_MAX:
        return value
    return DEFAULT_SUCCESS_SECONDS


def resolve_voucher_success(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherSuccessScreen` / `voucherSuccessSeconds` resolved from a merged settings dict; unknown or
    missing = "always" / 3. A view only."""
    screen = merged.get(VOUCHER_SUCCESS_SCREEN_KEY)
    return {
        VOUCHER_SUCCESS_SCREEN_KEY: screen
        if isinstance(screen, str) and screen in SUCCESS_SCREEN_VALUES
        else DEFAULT_SUCCESS_SCREEN,
        VOUCHER_SUCCESS_SECONDS_KEY: _success_seconds(merged.get(VOUCHER_SUCCESS_SECONDS_KEY)),
    }


def resolve_voucher_success_dismiss(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """`voucherSuccessDismiss` resolved from a merged settings dict; unknown or missing = "auto". A view only."""
    dismiss = merged.get(VOUCHER_SUCCESS_DISMISS_KEY)
    return {
        VOUCHER_SUCCESS_DISMISS_KEY: dismiss
        if isinstance(dismiss, str) and dismiss in SUCCESS_DISMISS_VALUES
        else DEFAULT_SUCCESS_DISMISS,
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


def resolve_voucher_fast_mode(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """The fast mode's nine keys resolved from a merged settings dict: a choice outside its values, or
    missing, = its default; the title a non-blank string of at most 40 characters (normalized as on
    write), else "עמדת מימוש שוברים". A view only."""
    out: Dict[str, Any] = {}
    for key, (values, default) in VOUCHER_FAST_CHOICES.items():
        value = merged.get(key)
        out[key] = value if isinstance(value, str) and value in values else default
    title = merged.get(VOUCHER_STATION_TITLE_KEY)
    title = normalize_station_title(title) if isinstance(title, str) else ""
    out[VOUCHER_STATION_TITLE_KEY] = title if title and len(title) <= STATION_TITLE_MAX else DEFAULT_STATION_TITLE
    return out
