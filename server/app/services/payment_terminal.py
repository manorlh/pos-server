"""
The till's external card terminal: a Nayax pinpad on the shop's network.

A till without a card terminal of its own (a Nebullar P18 tablet, see
`device_has_builtin_terminal` in app/models/pos_machine.py) charges on a Nayax pinpad, a
Nova C4 running Agamento, over the network: TweezerComm JSON-RPC posted to
`https://<host>:<port><path>`. That is the transport the desktop till already uses, through
the same settings (`nayaxEnabled`, `nayaxDeviceHost`, `nayaxDevicePort`, `nayaxSpicyPath`,
merged tenant → company → shop → area → till). A till whose merged `nayaxEnabled` is true
charges there too, whatever hardware it is.

This module validates the address a manager types at the till
(`PUT /sync/{machine_id}/payment-terminal`) and says, per till, whether it still needs one,
for the dashboard's machines page.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any, Dict, Optional

#: Where Agamento's SPICy server listens on a Nayax terminal (Nayax's TweezerComm docs).
DEFAULT_PORT = 8080
DEFAULT_PATH = "/SPICy"

HOST_MAX = 253
PATH_MAX = 100

#: One DNS label (RFC 1123): letters, digits and inner hyphens, at most 63 characters.
_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
#: A URL path the till can post to as it is, with no query, fragment or escapes.
_PATH = re.compile(r"^/[A-Za-z0-9._~/-]*$")


class PinpadAddressError(ValueError):
    """An address the till must not be sent. [code] is the API's `detail`."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def clean_pinpad_host(value: Any) -> str:
    """
    An IPv4 address or a host name, trimmed (a name lower-cased); `PinpadAddressError`
    otherwise. No scheme, no port and no path: those have fields of their own, and an
    address that smuggles one in is a typo the till would only fail on later.
    """
    if not isinstance(value, str) or not value.strip():
        raise PinpadAddressError("host_required")
    text = value.strip()
    if len(text) > HOST_MAX:
        raise PinpadAddressError("host_invalid")
    labels = text.split(".")
    # All digits is an IPv4 address or nothing: "192.168.1.300" must not pass as a name.
    if all(label.isdigit() for label in labels):
        try:
            return str(ipaddress.IPv4Address(text))
        except ValueError:
            raise PinpadAddressError("host_invalid") from None
    if not all(_LABEL.match(label) for label in labels):
        raise PinpadAddressError("host_invalid")
    return text.lower()


def clean_pinpad_port(value: Any) -> int:
    """1–65535; none given is SPICy's own port, 8080."""
    if value is None:
        return DEFAULT_PORT
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise PinpadAddressError("port_invalid")
    return value


def clean_pinpad_path(value: Any) -> str:
    """A plain absolute path; none given (or blank) is "/SPICy"."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return DEFAULT_PATH
    if not isinstance(value, str):
        raise PinpadAddressError("path_invalid")
    text = value.strip()
    if len(text) > PATH_MAX or not _PATH.match(text):
        raise PinpadAddressError("path_invalid")
    return text


def pinpad_settings_patch(host: str, port: int, path: str) -> Dict[str, Any]:
    """
    The till's own settings layer for a pinpad at this address. The port is stored as
    text, as the dashboard's settings form stores it (`nayaxDevicePort` is a string in
    `PosSettingsV1Patch`), so both writers leave the same shape behind.
    """
    return {
        "nayaxEnabled": True,
        "nayaxDeviceHost": host,
        "nayaxDevicePort": str(port),
        "nayaxSpicyPath": path,
    }


def merged_pinpad_host(merged: Dict[str, Any]) -> Optional[str]:
    """The merged `nayaxDeviceHost`, or None when no level sets a usable one."""
    host = merged.get("nayaxDeviceHost")
    return host.strip() if isinstance(host, str) and host.strip() else None


def pinpad_required(has_builtin_terminal: bool, nayax_enabled: bool) -> bool:
    """A till charges on a network pinpad when it has no terminal of its own, or is told to."""
    return (not has_builtin_terminal) or nayax_enabled


# ── "קישור מסופון מחדש": the till moves its own pinpad to a new address ─────────

#: Why the till moved it: picked on the kiosk's technician screen ("חיפוש מסופון ברשת"), or
#: found by itself at a new address with the same terminal identity (a DHCP change).
RELINK_TECHNICIAN = "technician"
RELINK_RELOCATED = "relocated"
RELINK_REASONS = (RELINK_TECHNICIAN, RELINK_RELOCATED)

#: The till event that records each move (`till_events.event_type`).
PINPAD_HOST_EVENT = "pinpad_host_set"


class PinpadRelinkRefused(Exception):
    """A move the cloud does not make. [code] is the API's `detail`, [status_code] its status."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message


def same_terminal(a: Any, b: Any) -> bool:
    """Two terminal numbers are one when equal but for leading zeros ("01730030" is 1730030)."""

    def norm(v: Any) -> Optional[str]:
        text = str(v).strip() if v is not None else ""
        return (text.lstrip("0") or "0") if text else None

    return norm(a) is not None and norm(a) == norm(b)


def relink_pinpad(
    db: Any,
    machine: Any,
    *,
    host: Any,
    port: Any = None,
    reason: str,
    terminal_number: Optional[str] = None,
    serial: Optional[str] = None,
    previous_host: Optional[str] = None,
    mac: Optional[str] = None,
    now: Any = None,
) -> Dict[str, Any]:
    """
    `PUT /sync/{machine_id}/pinpad-host` — the till's own pinpad, at a new address on its LAN.

    Narrow by design, so a till (with only its machine token: nobody at a kiosk is a
    manager) can move its pinpad and nothing else:

    * only `nayaxDeviceHost` (and `nayaxDevicePort` when given) on **this machine's own**
      settings layer — never `nayaxEnabled`, the path, another key or another till;
    * only for a till that already charges on a network Nayax pinpad with an address
      (409 `pinpad_not_in_use`): it moves a pinpad, it never sets one up — that stays the
      manager's `PUT /payment-terminal` and the dashboard's;
    * only a private IPv4 address (422 `host_not_private`): the pinpad is on the shop's LAN,
      where the till searched for it;
    * a move the till made by itself (`relocated`) names the terminal it found there, and
      it must be the till's expected terminal when one is set (409 `terminal_mismatch`) —
      never another business's pinpad. A technician's pick is recorded with what it said.

    Nothing is ever sent to the pinpad from here. Every move is a till event
    (`pinpad_host_set`: from, to, why, the terminal) and a log line. The caller commits
    and notifies the till's settings.
    """
    import ipaddress
    import logging
    import uuid
    from datetime import datetime, timezone

    from app.models.audit_exception import TillEvent
    from app.services import payment_integration
    from app.services.settings_merge import patch_settings_json
    from app.services.terminal_status import terminal_settings_for

    if reason not in RELINK_REASONS:
        raise PinpadRelinkRefused(422, "reason_invalid", "סיבה לא מוכרת")
    try:
        clean_host = clean_pinpad_host(host)
        clean_port = clean_pinpad_port(port) if port is not None else None
    except PinpadAddressError as exc:
        raise PinpadRelinkRefused(422, exc.code, "כתובת המסופון אינה תקינה") from None
    try:
        private = ipaddress.IPv4Address(clean_host).is_private
    except ValueError:
        private = False
    if not private:
        raise PinpadRelinkRefused(422, "host_not_private", "המסופון חייב להיות בכתובת IP פרטית ברשת המקומית")
    settings = terminal_settings_for(db, [machine]).get(machine.id)
    integration = getattr(getattr(settings, "integration", None), "integration", None)
    current = settings.pinpad_host if settings is not None else None
    if settings is None or current is None or integration != payment_integration.NAYAX_LAN:
        raise PinpadRelinkRefused(
            409, "pinpad_not_in_use",
            "הקופה לא מוגדרת לסליקה במסופון ברשת — כתובת מסופון נקבעת בהגדרות הקופה",
        )
    expected = settings.expected
    number = (terminal_number or "").strip() or None
    if reason == RELINK_RELOCATED:
        if number is None:
            raise PinpadRelinkRefused(422, "terminal_number_required", "חסר מספר המסוף שנמצא בכתובת החדשה")
        if expected is not None and not same_terminal(expected, number):
            raise PinpadRelinkRefused(
                409, "terminal_mismatch",
                f"המסופון שנמצא (מסוף {number}) אינו המסוף שהוגדר לקופה ({expected})",
            )
    current_port = settings.pinpad_port
    held_port = int(current_port) if (current_port or "").isdigit() else DEFAULT_PORT
    unchanged = current == clean_host and (clean_port is None or clean_port == held_port)
    out = {
        "host": clean_host,
        "port": clean_port if clean_port is not None else held_port,
        "previousHost": current,
        "reason": reason,
        "terminalMatches": same_terminal(expected, number) if expected is not None and number is not None else None,
        "unchanged": unchanged,
    }
    if unchanged:
        return out
    patch: Dict[str, Any] = {"nayaxDeviceHost": clean_host}
    if clean_port is not None:
        patch["nayaxDevicePort"] = str(clean_port)
    moment = now or datetime.now(timezone.utc)
    machine.settings = patch_settings_json(machine.settings, patch)
    machine.settings_updated_at = moment
    db.add(TillEvent(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        event_type=PINPAD_HOST_EVENT,
        occurred_at=moment,
        details={
            "from": current,
            "fromPort": current_port,
            "to": clean_host,
            "toPort": out["port"],
            "reason": reason,
            "terminalNumber": number,
            "expectedTerminalNumber": expected,
            "serial": (serial or "").strip()[:60] or None,
            "mac": (mac or "").strip()[:32] or None,
            "tillPreviousHost": (previous_host or "").strip()[:300] or None,
        },
    ))
    logging.getLogger(__name__).info(
        "pinpad of till %s moved %s:%s -> %s:%s (%s, terminal %s, expected %s)",
        machine.id, current, current_port, clean_host, out["port"], reason, number, expected,
    )
    return out
