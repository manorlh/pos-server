"""
Terminal configuration is never inherited onto an external pinpad (docs/SPEC_KIOSK.md §16).

The tills write three settings into the card terminal on sync: `clearingServer` (Agamento's
`ashraitServer` — Shva / Pelecard) and the forced terminal number (`forceTerminalNumber` +
`expectedTerminalNumber`, a `doEstablishment`). A value set at the shop or the company is
meant for the tills whose terminal is their own. A kiosk — and any till that charges on an
external network pinpad (a P18, a till with `nayaxEnabled`, a Z-Credit PinPad) — shares a
pinpad that is set up on its own: on 06.10.2026 the kiosk "קיוסק רויאל" was about to move its
pinpad from SHVA to PELECARD because the shop's `clearingServer` (meant for another till's
terminal) reached it.

So for such a machine the sync sends these keys **only when the machine's own layer sets
them**; an inherited value is left out (`forceTerminalNumber` goes out as `false`). Every
sync also says where each of these keys comes from (`terminalConfigSources`), so the till
applies a write only over a machine-level value — its own backstop
(`TerminalInfoRepository.applyCloud*` on the till).
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Sequence, Tuple

#: The settings the till writes into the card terminal.
TERMINAL_CONFIG_KEYS = ("clearingServer", "expectedTerminalNumber", "forceTerminalNumber")

#: The level name of the machine's own layer in `settings_sources`.
MACHINE_LEVEL = "machine"


def _as_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def charges_on_external_pinpad(machine: Any, merged: Dict[str, Any]) -> bool:
    """
    A kiosk, a till with no terminal of its own, a till told to charge on the network pinpad
    (`nayaxEnabled`), on a Z-Credit PinPad, a SynqPay terminal or a Nayax C4 on its USB: its
    terminal is not its own to configure from an inherited value.
    """
    # Real booleans only: a row that cannot say is a till with its own terminal, as before.
    if getattr(machine, "is_kiosk", False) is True:
        return True
    if getattr(machine, "has_builtin_terminal", True) is False:
        return True
    if merged.get("nayaxEnabled") is True:
        return True
    # Z-Credit, SynqPay (docs/SPEC_SYNQPAY.md) and a Nayax C4 on the till's USB (`nayax_usb`)
    # are external terminals too.
    return str(merged.get("paymentIntegration") or "").strip().lower() in ("zcredit", "synqpay", "nayax_usb")


def sources(layers: Sequence[Tuple[str, Any]]) -> Dict[str, str]:
    """Per terminal-config key that some layer sets, the level it comes from (the deepest)."""
    out: Dict[str, str] = {}
    for level, stored in layers:
        for key in TERMINAL_CONFIG_KEYS:
            if key in _as_dict(stored) and _as_dict(stored).get(key) is not None:
                out[key] = level
    return out


def guard(
    effective: Dict[str, Any],
    *,
    machine: Any,
    merged: Dict[str, Any],
    layers: Sequence[Tuple[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """
    The settings as sent to [machine]: for one on an external pinpad, every terminal-config
    key not set on the machine's own layer is dropped (`forceTerminalNumber` → `false`).
    Returns the settings and the sources map. Pure; [effective] is not changed in place.
    """
    out = dict(effective)
    where = sources(layers)
    if not charges_on_external_pinpad(machine, merged):
        return out, where
    for key in TERMINAL_CONFIG_KEYS:
        if where.get(key) == MACHINE_LEVEL:
            continue
        if key == "forceTerminalNumber":
            out[key] = False
        else:
            out.pop(key, None)
    return out, where


def layers_of(tenant: Any, company: Any, shop: Any, area: Any, machine: Any) -> Sequence[Tuple[str, Any]]:
    """The stored layers least specific first, as `merge_all_settings_layers` merges them."""
    return [
        ("tenant", getattr(tenant, "settings", None) if tenant is not None else None),
        ("company", getattr(company, "settings", None) if company is not None else None),
        ("shop", getattr(shop, "settings", None) if shop is not None else None),
        ("area", getattr(area, "settings", None) if area is not None else None),
        (MACHINE_LEVEL, getattr(machine, "settings", None) if machine is not None else None),
    ]


def machine_level_value(machine: Any, key: str) -> Optional[Any]:
    """The machine's own value for [key], or None."""
    return _as_dict(getattr(machine, "settings", None)).get(key)
