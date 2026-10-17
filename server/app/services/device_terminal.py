"""
"מסופון אשראי" — the card terminal type chosen for one device in the add-device dialog (a till or a kiosk,
Android / Windows / the browser kiosk), and the fields of that type.

It is no store of its own: the choice is the till parameter the device already reads — "סוג אינטגרציית
אשראי" (`paymentIntegration`, app/services/payment_integration.py) and that integration's non-secret keys —
written to the new machine's own settings layer as it pairs (the level "this device"), exactly as the
per-till settings dialog writes them. Secrets (Z-Credit's password, Tap to Pay's merchant code, SynqPay's
key) are never taken here: they stay on the payment settings page (write-only there).

Which types a device may get, by platform and role (what each app really drives):

* Windows (the kiosk-desktop app, kiosk and till alike — src/main/payment/registry.ts: Nayax LAN, Nayax USB,
  SynqPay) and the browser kiosk (its card goes through a Windows bridge running the same service):
  `nayax_lan`, `nayax_usb`, `synqpay`, `none`.
* An Android kiosk (KioskTerminal.configured: Nayax LAN / USB, Z-Credit, SynqPay; never the built-in
  terminal, never Tap to Pay — 422 `tap_to_pay_not_on_kiosk`): `nayax_lan`, `nayax_usb`, `zcredit`,
  `synqpay`, `none`.
* An Android till: `agamento` ("מובנה במכשיר", only a model with a terminal of its own), `nayax_lan`,
  `nayax_usb`, `zcredit`, `synqpay`, `tap_to_pay` (not a model known to have no NFC), `none`.

`auto` ("לפי הגדרות הסניף") is offered to all of them and writes nothing — today's behaviour. `none` on a
kiosk is "ללא מסופון": the kiosk then offers "מזומן בקופה" by "קיוסק — כשאין מסופון אשראי"
(`kioskNoTerminalFallback`, default pay at till).
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from fastapi import status

from app.services import payment_integration as PI

PLATFORM_ANDROID = "android"
PLATFORM_WINDOWS = "windows"
PLATFORM_WEB = "web"

#: The roles a terminal is chosen for: the two that sell.
TERMINAL_ROLES: Tuple[str, ...] = ("till", "kiosk")

WINDOWS_TYPES: Tuple[str, ...] = (PI.AUTO, PI.NAYAX_LAN, PI.NAYAX_USB, PI.SYNQPAY, PI.NONE)
ANDROID_KIOSK_TYPES: Tuple[str, ...] = (PI.AUTO, PI.NAYAX_LAN, PI.NAYAX_USB, PI.ZCREDIT, PI.SYNQPAY, PI.NONE)
ANDROID_TILL_TYPES: Tuple[str, ...] = (
    PI.AUTO, PI.AGAMENTO, PI.NAYAX_LAN, PI.NAYAX_USB, PI.ZCREDIT, PI.SYNQPAY, PI.TAP_TO_PAY, PI.NONE,
)

#: The keys each type writes besides `paymentIntegration` (non-secret only), in the form's order.
TYPE_KEYS: Dict[str, Tuple[str, ...]] = {
    PI.AUTO: (),
    PI.AGAMENTO: (),
    PI.NONE: (),
    PI.NAYAX_LAN: ("nayaxDeviceHost", "nayaxDevicePort"),
    PI.NAYAX_USB: (PI.NAYAX_USB_DEVICE,),
    PI.ZCREDIT: (PI.ZCREDIT_TERMINAL_NUMBER, PI.ZCREDIT_PINPAD_ID, PI.ZCREDIT_MODE),
    PI.SYNQPAY: (
        PI.SYNQPAY_DEVICE_MODEL, PI.SYNQPAY_CONNECTION, PI.SYNQPAY_HOST, PI.SYNQPAY_PROTOCOL,
        PI.SYNQPAY_PORT, PI.SYNQPAY_TLS, PI.SYNQPAY_USB_DEVICE,
    ),
    PI.TAP_TO_PAY: (PI.TAP_TO_PAY_TPN, PI.TAP_TO_PAY_ENVIRONMENT),
}

UNSUPPORTED_CODE = "device_terminal_unsupported"
INVALID_CODE = "device_terminal_invalid"
NOT_FOR_ROLE_CODE = "device_terminal_not_for_role"

_PLATFORM_HE = {PLATFORM_WINDOWS: "Windows", PLATFORM_WEB: "דפדפן", PLATFORM_ANDROID: "Android"}


class DeviceTerminalRefused(Exception):
    """A 422 with `{detail, message, field?}` — answered as is, the dialog shows the Hebrew."""

    def __init__(self, code: str, message: str, field: Optional[str] = None):
        super().__init__(code)
        self.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        self.body: Dict[str, Any] = {"detail": code, "message": message, **({"field": field} if field else {})}


def types_for(role: Optional[str], platform: Optional[str], device_model: Optional[str] = None) -> Tuple[str, ...]:
    """The types a device of [role] on [platform] (and, on Android, of [device_model]) may be given."""
    if (role or "till") not in TERMINAL_ROLES:
        return ()
    kiosk = role == "kiosk"
    if (platform or PLATFORM_ANDROID) in (PLATFORM_WINDOWS, PLATFORM_WEB):
        return WINDOWS_TYPES
    if kiosk:
        return ANDROID_KIOSK_TYPES
    from app.models.pos_machine import device_has_builtin_terminal

    out = ANDROID_TILL_TYPES
    if device_model is not None and not device_has_builtin_terminal(device_model):
        out = tuple(t for t in out if t != PI.AGAMENTO)
    return out


def _unsupported(kind: str, role: Optional[str], platform: Optional[str]) -> DeviceTerminalRefused:
    label = PI.LABELS_HE.get(kind, kind)
    where = "קיוסק" if role == "kiosk" else "קופה"
    plat = _PLATFORM_HE.get(platform or PLATFORM_ANDROID, platform or "")
    if kind == PI.TAP_TO_PAY and role == "kiosk":
        return DeviceTerminalRefused(UNSUPPORTED_CODE, PI.TAP_TO_PAY_NOT_ON_KIOSK_DETAIL["msg"], "paymentIntegration")
    if kind == PI.AGAMENTO and (platform or PLATFORM_ANDROID) == PLATFORM_ANDROID and role != "kiosk":
        return DeviceTerminalRefused(UNSUPPORTED_CODE, PI.NEEDS_BUILTIN_DETAIL["msg"], "paymentIntegration")
    allowed = ", ".join(PI.LABELS_HE[t] for t in types_for(role, platform) if t != PI.AUTO)
    return DeviceTerminalRefused(
        UNSUPPORTED_CODE,
        f"{label} אינו נתמך ב{where} {plat}. אפשר לבחור: {allowed}.",
        "paymentIntegration",
    )


def _field(key: str, value: Any) -> Any:
    """[value] of [key] cleaned the way the settings PATCH cleans it; None for blank."""
    if key == "nayaxDeviceHost":
        from app.services.payment_terminal import PinpadAddressError, clean_pinpad_host

        if value is None or not str(value).strip():
            return None
        try:
            return clean_pinpad_host(value)
        except PinpadAddressError as exc:
            raise ValueError(exc.code) from exc
    if key == "nayaxDevicePort":
        from app.services.payment_terminal import PinpadAddressError, clean_pinpad_port

        if value is None or not str(value).strip():
            return None
        try:
            text = str(value).strip()
            return str(clean_pinpad_port(int(text) if text.isdigit() else text))
        except PinpadAddressError as exc:
            raise ValueError("port_invalid") from exc
    if key == PI.SYNQPAY_TLS:
        if value is None or value == "":
            return None
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1"):
            return True
        if text in ("false", "0"):
            return False
        raise ValueError("synqpayTls must be true or false")
    validators = {
        PI.NAYAX_USB_DEVICE: PI.validate_nayax_usb_device,
        PI.ZCREDIT_TERMINAL_NUMBER: PI.validate_terminal_number,
        PI.ZCREDIT_PINPAD_ID: PI.clean_pinpad_id,
        PI.ZCREDIT_MODE: PI.validate_mode,
        PI.SYNQPAY_DEVICE_MODEL: PI.validate_synqpay_model,
        PI.SYNQPAY_CONNECTION: PI.validate_synqpay_connection,
        PI.SYNQPAY_HOST: PI.validate_synqpay_host,
        PI.SYNQPAY_PROTOCOL: PI.validate_synqpay_protocol,
        PI.SYNQPAY_PORT: PI.validate_synqpay_port,
        PI.SYNQPAY_USB_DEVICE: PI.validate_synqpay_usb_device,
        PI.TAP_TO_PAY_TPN: PI.validate_tap_to_pay_tpn,
        PI.TAP_TO_PAY_ENVIRONMENT: PI.validate_tap_to_pay_environment,
    }
    return validators[key](value)


def clean_request(
    terminal: Any,
    *,
    role: Optional[str],
    platform: Optional[str],
    device_model: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    The settings patch a pairing code stores for [terminal] (the request's `terminal`, a dict of the setting
    keys), or None when there is nothing to write (absent, or `auto`). Raises DeviceTerminalRefused: a role
    that takes no terminal (a screen, a server), a type the device cannot charge on, or a field the settings
    PATCH would refuse. A Nayax pinpad on the network with an address also gets `nayaxEnabled` and the SPICy
    path, as the kiosk's pinpad always did (`payment_terminal.pinpad_settings_patch`).
    """
    if terminal is None:
        return None
    raw: Dict[str, Any] = terminal if isinstance(terminal, dict) else terminal.model_dump(by_alias=True, exclude_none=True)
    kind = PI.clean_integration(raw.get(PI.KEY)) or PI.AUTO
    if (role or "till") not in TERMINAL_ROLES:
        if kind == PI.AUTO:
            return None
        raise DeviceTerminalRefused(NOT_FOR_ROLE_CODE, "מסופון אשראי נבחר רק לקופה או לקיוסק.", "paymentIntegration")
    if kind not in types_for(role, platform, device_model):
        raise _unsupported(kind, role, platform)
    if kind == PI.AUTO:
        return None
    patch: Dict[str, Any] = {PI.KEY: kind}
    for key in TYPE_KEYS[kind]:
        try:
            value = _field(key, raw.get(key))
        except ValueError as exc:
            label = PI.FIELD_LABELS_HE.get(key) or ("פורט המסופון" if key == "nayaxDevicePort" else key)
            raise DeviceTerminalRefused(INVALID_CODE, f"{label}: הערך אינו תקין.", key) from exc
        if value is not None:
            patch[key] = value
    if kind == PI.NAYAX_LAN and patch.get("nayaxDeviceHost"):
        from app.services import payment_terminal

        port = int(patch.get("nayaxDevicePort") or payment_terminal.DEFAULT_PORT)
        patch.update(payment_terminal.pinpad_settings_patch(patch["nayaxDeviceHost"], port, payment_terminal.DEFAULT_PATH))
    if kind == PI.SYNQPAY and patch.get(PI.SYNQPAY_CONNECTION) != "lan":
        for key in (PI.SYNQPAY_HOST, PI.SYNQPAY_PROTOCOL, PI.SYNQPAY_PORT, PI.SYNQPAY_TLS):
            patch.pop(key, None)
    if kind == PI.SYNQPAY and patch.get(PI.SYNQPAY_CONNECTION) == "lan":
        patch.pop(PI.SYNQPAY_USB_DEVICE, None)
    return patch


def apply_on_pairing(db: Any, pairing_code: Any, machine: Any) -> bool:
    """
    Write the code's terminal choice to the machine's own settings layer, after its role is set (a kiosk is
    a kiosk by now). Never fails the pairing: a choice the machine cannot take after all (a model whose
    terminal the device's own word ruled out, `payment_integration.check_machine_choice`) is logged and
    left out — the layers above decide, as with no choice. True when written (and the till told).
    """
    import logging

    from fastapi import HTTPException

    from app.services.settings_merge import patch_settings_json, utc_now

    logger = logging.getLogger(__name__)
    patch = getattr(pairing_code, "terminal_options", None)
    if not isinstance(patch, dict) or not patch:
        return False
    if getattr(pairing_code, "target_machine_id", None) is not None:
        return False  # a replacement keeps the settings of the till it replaces
    try:
        PI.check_machine_choice(machine, patch)
    except HTTPException as exc:
        logger.warning("terminal choice of code %s not applied to machine %s (%s)", pairing_code.id, machine.id, exc.detail)
        return False
    try:
        machine.settings = patch_settings_json(machine.settings, dict(patch))
        machine.settings_updated_at = utc_now()
        db.commit()
    except Exception as exc:  # noqa: BLE001 - never fail the pairing
        db.rollback()
        logger.warning("terminal choice of code %s not written to machine %s (%s)", pairing_code.id, machine.id, exc)
        return False
    try:
        from app.services import settings_notify

        settings_notify.notify_machine_settings(db, machine, reason="payment_terminal")
    except Exception:  # noqa: BLE001 - the till's next settings pull takes it anyway
        logger.warning("settings notify for machine %s failed", machine.id)
    return True
