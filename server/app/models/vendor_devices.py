"""
Android POS terminals that charge on Nayax's Agamento (TweezerComm) like the F20 and print
through their vendor's own API: the PAX A77 and the Urovo i9100 (both Android 8.1).

* Card payments: Agamento with its TweezerComm (TC) service is on the device, as on the F20 —
  the till binds it exactly as it does there (`AgamentoEmvDevice`), so each model has a
  terminal of its own. "Like the F20, not by assumption": the till says at pairing whether
  Agamento is installed (`device_info["agamento"] == "true"`); a unit that paired without it
  charges on a network pinpad / Z-Credit (`machine_has_builtin_terminal`).
* Printing (the till's receipts, bons, Z): Urovo through `android.device.PrinterManager`,
  which the ROM carries (the till reaches it by reflection); PAX through the NeptuneLite SDK
  (`IPrinter`), which is not on Maven — the till prints there once the owner adds PAX's SDK
  file, and until then falls back to the shop's receipt printer. Agamento / TC has no print
  call for the till's documents (TweezerComm's methods are the card ones; Agamento prints only
  its own card slips).
* Detection: `Build.MANUFACTURER` or `Build.BRAND` names the maker (PAX; UROVO or UBX), then
  `Build.MODEL` the model (longest prefix). A PAX / Urovo the table does not know is not
  claimed (None): it keeps the model it was paired as.

Pure data with no imports from the app: `app.models.pos_machine` builds its sets from it. The
till holds the same table (pos-android `hardware/vendor/VendorDevices.kt`, device flavour);
both are pinned by one fixture, `tests/fixtures/vendor_devices_golden.json` here and
`app/src/test/resources/vendor_devices_golden.json` in pos-android — the same bytes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class VendorDeviceModel:
    #: `pos_machines.device_model` (String(16)).
    id: str
    #: `Build.MANUFACTURER` / `Build.BRAND`, upper case, that name the maker.
    makers: Tuple[str, ...]
    #: `Build.MODEL` as `normalize_vendor_model` leaves it; the longest matching prefix wins.
    prefixes: Tuple[str, ...]
    #: A thermal head of its own.
    printer: bool
    #: The paper it takes (58 mm = 384 dots).
    paper_mm: Optional[int]
    cutter: bool
    drawer_port: bool
    #: A scan head of its own (not the camera), broadcast to the till.
    scanner: bool
    #: Agamento / TweezerComm on the device, as on the F20.
    builtin_terminal: bool
    #: What the till prints with: "neptunelite" (PAX's SDK, from the owner) or
    #: "urovo_printermanager" (in the ROM).
    print_sdk: str


VENDOR_DEVICE_MODELS: Tuple[VendorDeviceModel, ...] = (
    VendorDeviceModel("PAX_A77", ("PAX",), ("A77",), True, 58, False, False, False, True, "neptunelite"),
    VendorDeviceModel(
        "UROVO_I9100", ("UROVO", "UBX"), ("I9100",), True, 58, False, False, True, True, "urovo_printermanager",
    ),
)

VENDOR_DEVICE_MODEL_IDS: Tuple[str, ...] = tuple(m.id for m in VENDOR_DEVICE_MODELS)

_BY_ID = {m.id: m for m in VENDOR_DEVICE_MODELS}


def vendor_device_model(model_id) -> Optional[VendorDeviceModel]:
    """The table's row for a `device_model`, or None for a model that is not one of these."""
    return _BY_ID.get(model_id) if isinstance(model_id, str) else None


def _maker(value) -> str:
    return value.strip().upper() if isinstance(value, str) else ""


def normalize_vendor_model(model, makers: Tuple[str, ...] = ()) -> str:
    """
    `Build.MODEL` upper case, letters and digits only, without the maker's name in front:
    "PAX A77" and "a77" are both "A77", "UROVO i9100" is "I9100".
    """
    if not isinstance(model, str):
        return ""
    s = re.sub(r"[^A-Z0-9]", "", model.upper())
    for maker in makers:
        if s.startswith(maker) and len(s) > len(maker):
            return s[len(maker):]
    return s


def detect_vendor_device(device_info) -> Optional[str]:
    """The PAX / Urovo model a device's `device_info` names, or None when it is not one we know."""
    if not isinstance(device_info, dict):
        return None
    makers = {_maker(device_info.get("manufacturer")), _maker(device_info.get("brand"))}
    best: Optional[VendorDeviceModel] = None
    best_len = 0
    for row in VENDOR_DEVICE_MODELS:
        if not makers & set(row.makers):
            continue
        key = normalize_vendor_model(device_info.get("model"), row.makers)
        for prefix in row.prefixes:
            if key.startswith(prefix) and len(prefix) > best_len:
                best, best_len = row, len(prefix)
    return best.id if best else None


def reports_agamento(device_info) -> Optional[bool]:
    """
    What the till said about Agamento at pairing: True when it is installed
    (`"agamento": "true"`), False when a till reported its hardware without it, None when
    nothing was reported (a machine added on the dashboard and not paired yet).
    """
    if not isinstance(device_info, dict) or not device_info:
        return None
    v = device_info.get("agamento")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def machine_has_builtin_terminal(device_model, device_info) -> Optional[bool]:
    """
    For a PAX / Urovo machine: its own terminal unless the till reported it has no Agamento.
    None for any other model (the model's own rule applies).
    """
    row = vendor_device_model(device_model)
    if row is None:
        return None
    return row.builtin_terminal and reports_agamento(device_info) is not False
