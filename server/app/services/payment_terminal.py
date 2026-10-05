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
