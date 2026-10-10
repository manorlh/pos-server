"""
Android POS models whose own receipt printer the till reaches by itself, with NO vendor SDK
("מדפסת מובנית" with zero configuration — the support matrix in specs/android-builtin-printers.md):
iMin (Falcon 1 / 2 / 2 Max, D4, D1, M2, Swift, Swan 2), LANDI, and Feitian tablets in their
printer docks.

* Detection: `Build.MANUFACTURER` or `Build.BRAND` names the maker, then `Build.MODEL` the model
  (longest prefix); a model of the maker no prefix names is the maker's generic row, if it has
  one (iMin). Nothing else is claimed — the F20 stays a 55F, a SUNMI / PAX / Urovo keep their
  own tables (app/models/sunmi.py, app/models/vendor_devices.py), which are asked first.
* Routes, best first, decided on the device: an inner USB printer (`usb:VVVV:PPPP`, or any
  printer-class device `usb:class`), a print service through its published AIDL (`aidl:imin2`,
  the till's own stub), the unit's virtual Bluetooth printer (`bt:NAME`). Raw ESC/POS on every
  route; the drawer through the head.
* `support`: "auto" prints and drives the drawer by itself; "partial" prints, but something
  (the drawer, a route not confirmed on a unit) needs the vendor SDK; "sdk" — only the vendor's
  SDK reaches the head: the till does not print there (no printer for the cloud, "בקרוב") until
  the owner approves it.
* `dock`: the head is in a dock the tablet sits in (Falcon 2, a Feitian tablet) — the till prints
  on it only while docked; `fallback: "ft"` — when no route answers, the FT POS service prints
  through the FT SDK the app already carries for the F20.
* No card terminal of their own (no Agamento): they charge on a network pinpad / Z-Credit.

Pure data with no imports from the app: `app.models.pos_machine` builds its sets from it. The
till holds the same table (pos-android `hardware/builtin/BuiltinPrinterModels.kt`, main source
set); both are pinned by one fixture, `tests/fixtures/builtin_printers_golden.json` here and
`app/src/test/resources/builtin_printers_golden.json` in pos-android — the same bytes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple

SUPPORT_AUTO = "auto"
SUPPORT_PARTIAL = "partial"
SUPPORT_SDK = "sdk"


@dataclass(frozen=True)
class BuiltinPrinterModel:
    #: `pos_machines.device_model` (String(16)).
    id: str
    label: str
    #: `Build.MANUFACTURER` / `Build.BRAND`, upper case, letters and digits only.
    makers: Tuple[str, ...]
    #: `Build.MODEL` as `normalize_builtin_model` leaves it; the longest matching prefix wins.
    prefixes: Tuple[str, ...]
    #: The maker's row for a model of it no prefix names.
    generic: bool
    #: 58 (384 dots) or 80 (576 dots).
    paper_mm: int
    cutter: bool
    #: A drawer port the till opens through the head.
    drawer_port: bool
    customer_display: bool
    #: The head lives in a dock the tablet sits in.
    dock: bool
    #: "auto" | "partial" | "sdk".
    support: str
    #: The routes, best first ("usb:class", "usb:0519:2013", "aidl:imin2", "bt:InnerPrinter").
    routes: Tuple[str, ...]
    #: "ft": the FT POS service prints when no route answers; None: nothing.
    fallback: Optional[str]
    #: The vendor SDK the model needs for what its routes do not do; None when nothing.
    sdk: Optional[str]

    @property
    def prints(self) -> bool:
        """The till prints on the head itself (a model only the vendor SDK reaches does not)."""
        return self.support != SUPPORT_SDK

    @property
    def driver_pending(self) -> bool:
        """The head is there, the SDK that reaches it is not in the app: "בקרוב"."""
        return self.support == SUPPORT_SDK

    @property
    def till_drawer_port(self) -> bool:
        """The till opens a drawer on a port of the model's own, through its head."""
        return self.drawer_port and self.prints


_IMIN = ("IMIN",)
_LANDI = ("LANDI",)
_FEITIAN = ("FEITIAN", "FTSAFE")

#: iMin on Android 13+ (Printer SDK 2.0): its printer service, then its virtual Bluetooth printer.
_IMIN_V2 = ("aidl:imin2", "bt:InnerPrinter", "bt:BluetoothPrinter")
#: iMin on Android 11 (Printer SDK 1.0, the head on USB): a printer-class USB head, then Bluetooth.
_IMIN_V1 = ("usb:class", "bt:BluetoothPrinter", "bt:InnerPrinter")

_IMIN_LIBS = "iMin IminLibs (IminSDKManager.opencashBox) — the drawer is the board's GPIO, not the head's"
_LANDI_USDK = "LANDI USDK (com.usdk.apiservice AIDL: UPrinter, UCashBox) — from LANDI, not public"
_FT_SDK = "Feitian FT SDK (com.ftpos.apiservice) — already in the app for the F20"


def _row(id, label, makers, prefixes, paper_mm, cutter, drawer_port, customer_display, dock, support, routes, sdk,
         generic=False, fallback=None) -> BuiltinPrinterModel:
    return BuiltinPrinterModel(
        id, label, tuple(makers), tuple(prefixes), generic, paper_mm, cutter, drawer_port, customer_display, dock,
        support, tuple(routes), fallback, sdk,
    )


BUILTIN_PRINTER_MODELS: Tuple[BuiltinPrinterModel, ...] = (
    # ── iMin, Android 13+ (Printer SDK 2.0: the printer service, the till's own AIDL stub) ──
    _row("IMIN_FALCON2", "iMin Falcon 2", _IMIN, ("FALCON2", "TF2"), 80, True, True, True, True, SUPPORT_AUTO, _IMIN_V2, None),
    _row("IMIN_FALCON2_58", "iMin Falcon 2 (58 mm dock)", _IMIN, (), 58, False, True, True, True, SUPPORT_AUTO, _IMIN_V2, None),
    _row("IMIN_FALCON2MAX", "iMin Falcon 2 Max", _IMIN, ("FALCON2MAX",), 80, True, True, False, True, SUPPORT_AUTO, _IMIN_V2, None),
    _row("IMIN_D4_PRO", "iMin D4 Pro", _IMIN, ("D4PRO", "D4503PRO", "D4504PRO", "D4505PRO"), 80, True, True, True, False,
         SUPPORT_AUTO, _IMIN_V2, None),
    _row("IMIN_SWAN2", "iMin Swan 2 (Printer)", _IMIN, ("SWAN2", "I23M02", "DS2"), 80, True, True, True, False, SUPPORT_AUTO, _IMIN_V2, None),
    _row("IMIN_SWIFT2", "iMin Swift 2", _IMIN, ("SWIFT2", "MS2"), 58, False, False, False, False, SUPPORT_AUTO, _IMIN_V2, None),
    # ── iMin, Android 11 (Printer SDK 1.0): the drawer is the board's GPIO (IminLibs) ──
    _row("IMIN_FALCON1", "iMin Falcon 1", _IMIN, ("FALCON1", "I22T01", "TF111"), 80, True, False, True, False, SUPPORT_PARTIAL,
         _IMIN_V1, _IMIN_LIBS),
    _row("IMIN_D4", "iMin D4", _IMIN, ("D4",), 80, True, False, True, False, SUPPORT_PARTIAL, _IMIN_V1, _IMIN_LIBS),
    _row("IMIN_D1", "iMin D1 / D1 Pro", _IMIN, ("D1",), 58, False, False, True, False, SUPPORT_PARTIAL, _IMIN_V1, _IMIN_LIBS),
    _row("IMIN_M2", "iMin M2", _IMIN, ("M2",), 58, False, False, False, False, SUPPORT_AUTO, _IMIN_V1, None),
    _row("IMIN_SWIFT1", "iMin Swift 1", _IMIN, ("SWIFT1", "I22M01", "MS111"), 58, False, False, False, False, SUPPORT_AUTO, _IMIN_V1, None),
    _row("IMIN", "iMin", _IMIN, (), 58, False, False, False, False, SUPPORT_AUTO, _IMIN_V2 + ("usb:class",), None, generic=True),
    # ── LANDI: the C20 Pro desktop tried on a printer-class USB head; the rest need USDK ──
    _row("LANDI_C20_PRO", "LANDI C20 Pro", _LANDI, ("C20PRO",), 80, True, True, True, False, SUPPORT_PARTIAL, ("usb:class",), _LANDI_USDK),
    _row("LANDI_M20", "LANDI M20", _LANDI, ("M20",), 58, False, False, False, False, SUPPORT_SDK, (), _LANDI_USDK),
    _row("LANDI_P20", "LANDI P20 / P30", _LANDI, ("P20", "P30"), 58, False, False, False, False, SUPPORT_SDK, (), _LANDI_USDK),
    _row("LANDI_APOS_A8", "LANDI / Ingenico APOS A8", _LANDI + ("INGENICO",), ("APOSA8", "A8"), 58, False, False, False, False,
         SUPPORT_SDK, (), _LANDI_USDK),
    # ── Feitian tablets in their printer docks: a printer-class USB head while docked, else FT ──
    _row("FEITIAN_M60", "Feitian M60 + printer dock", _FEITIAN, ("M60",), 80, True, True, True, True, SUPPORT_PARTIAL,
         ("usb:class",), _FT_SDK, fallback="ft"),
    _row("FEITIAN_F360", "Feitian F360 + printer dock", _FEITIAN, ("F360",), 58, False, True, True, True, SUPPORT_PARTIAL,
         ("usb:class",), _FT_SDK, fallback="ft"),
    _row("FEITIAN_F310", "Feitian F310 + printer module", _FEITIAN, ("F310",), 58, False, True, False, True, SUPPORT_PARTIAL,
         ("usb:class",), _FT_SDK, fallback="ft"),
    _row("FEITIAN_M500", "Feitian M500", _FEITIAN, ("M500",), 80, True, True, True, False, SUPPORT_PARTIAL,
         ("usb:class",), _FT_SDK, fallback="ft"),
)

BUILTIN_PRINTER_MODEL_IDS: Tuple[str, ...] = tuple(m.id for m in BUILTIN_PRINTER_MODELS)

_BY_ID = {m.id: m for m in BUILTIN_PRINTER_MODELS}

_NOT_ALNUM = re.compile(r"[^A-Z0-9]")


def builtin_printer_model(model_id) -> Optional[BuiltinPrinterModel]:
    """The table's row for a `device_model`, or None for a model that is not one of these."""
    return _BY_ID.get(model_id) if isinstance(model_id, str) else None


def maker_of(value) -> str:
    """A maker as the table keeps it: upper case, letters and digits only ("iMin" -> "IMIN")."""
    return _NOT_ALNUM.sub("", value.upper()) if isinstance(value, str) else ""


def normalize_builtin_model(model, makers: Tuple[str, ...] = ()) -> str:
    """
    `Build.MODEL` upper case, letters and digits only, without a maker's name in front:
    "iMin Falcon 2" and "FALCON-2" are both "FALCON2", "LANDI C20 Pro" is "C20PRO".
    """
    if not isinstance(model, str):
        return ""
    s = _NOT_ALNUM.sub("", model.upper())
    for maker in makers:
        if s.startswith(maker) and len(s) > len(maker):
            return s[len(maker):]
    return s


def _makes(row: BuiltinPrinterModel, device_info: dict) -> bool:
    makers = {maker_of(device_info.get("manufacturer")), maker_of(device_info.get("brand"))} - {""}
    return bool(makers & set(row.makers))


def detect_builtin_printer_model(device_info) -> Optional[str]:
    """The model a device's `device_info` names, or None when the table does not know it."""
    if not isinstance(device_info, dict):
        return None
    best: Optional[BuiltinPrinterModel] = None
    best_len = 0
    for row in BUILTIN_PRINTER_MODELS:
        if not _makes(row, device_info):
            continue
        key = normalize_builtin_model(device_info.get("model"), row.makers)
        for prefix in row.prefixes:
            if key.startswith(prefix) and len(prefix) > best_len:
                best, best_len = row, len(prefix)
    if best is None:
        best = next((row for row in BUILTIN_PRINTER_MODELS if row.generic and _makes(row, device_info)), None)
    return best.id if best else None


def choice_refines(detected, chosen) -> bool:
    """
    Whether a model chosen on the dashboard names the unit more closely than the device can
    itself: both rows of this table, of the same maker — a Falcon 2 on its 58 mm dock, a model
    whose `Build.MODEL` the table does not know. The till prints by the chosen row then.
    """
    a, b = builtin_printer_model(detected), builtin_printer_model(chosen)
    return a is not None and b is not None and a.id != b.id and bool(set(a.makers) & set(b.makers))
