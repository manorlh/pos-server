"""
SUNMI hardware (docs/SPEC_SUNMI.md): the SUNMI models a till may be, what each one has, and
how a device names one by itself (`Build.MANUFACTURER` / `Build.BRAND` = SUNMI and
`Build.MODEL`).

Pure data with no imports from the app: `app.models.pos_machine` builds its capability sets
from it. The till holds the same table (pos-android `hardware/sunmi/SunmiModels.kt`, device
flavour); both are pinned by one fixture, `tests/fixtures/sunmi_models_golden.json` here and
`app/src/test/resources/sunmi_models_golden.json` in pos-android — the same bytes.

What the till really prints on is decided on the device, from the SUNMI print service
(PrinterX, else the legacy InnerPrinter AIDL): whether a head answers, and its width. This
table is what the dashboard shows for a model and what `machines/me` answers before the
till has said anything — so a 58 mm variant of a desktop (T2 mini, D2 mini) still prints
right, at the width its own service reports.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class SunmiModel:
    #: `pos_machines.device_model` (String(16)).
    id: str
    #: `Build.MODEL` as `normalize_sunmi_model` leaves it; the longest matching prefix wins.
    prefixes: Tuple[str, ...]
    #: A thermal head of its own.
    printer: bool
    #: The paper it is sold with: 58 (384 dots) or 80 (576 dots); None without a printer.
    paper_mm: Optional[int]
    #: An auto-cutter on the head.
    cutter: bool
    #: An RJ-11/RJ-12 cash drawer port driven by the print service (desktops).
    drawer_port: bool
    #: A laser / imager scan head (not the camera) — broadcast to the till.
    scanner: bool
    #: SUNMI's own EMV reader (P-series). The till does not drive it (no SUNMI PayHardware
    #: driver, no Israeli certification): the model still charges on an external pinpad.
    payment_hw: bool = False


#: The id of a SUNMI the table does not know (a model newer than this build): it prints if
#: its print service answers; no drawer, no terminal of its own.
SUNMI_GENERIC = "SUNMI"

SUNMI_MODELS: Tuple[SunmiModel, ...] = (
    # ── Handhelds: 58 mm (the V2s PLUS: 80 mm), no drawer port ─────────────────
    SunmiModel("SUNMI_V1", ("V1", "V1S"), True, 58, False, False, False),
    SunmiModel("SUNMI_V2", ("V2",), True, 58, False, False, False),
    SunmiModel("SUNMI_V2_PRO", ("V2PRO",), True, 58, False, False, True),
    SunmiModel("SUNMI_V2S", ("V2S",), True, 58, False, False, False),
    SunmiModel("SUNMI_V2S_PLUS", ("V2SPLUS",), True, 80, False, False, True),
    SunmiModel("SUNMI_V3", ("V3",), True, 58, False, False, True),
    SunmiModel("SUNMI_P1", ("P1",), True, 58, False, False, False, payment_hw=True),
    SunmiModel("SUNMI_P2", ("P2",), True, 58, False, False, False, payment_hw=True),
    SunmiModel("SUNMI_P3", ("P3",), True, 58, False, False, False, payment_hw=True),
    # ── No printer: PDAs and tablets ─────────────────────────────────────────
    SunmiModel("SUNMI_L2", ("L2", "L3"), False, None, False, False, True),
    SunmiModel("SUNMI_M2", ("M2", "M3", "FLEX"), False, None, False, False, False),
    # ── Desktops: drawer port; 80 mm with a cutter, the minis 58 mm ──────────
    SunmiModel("SUNMI_T1", ("T1",), True, 80, True, True, False),
    SunmiModel("SUNMI_T2", ("T2",), True, 80, True, True, False),
    SunmiModel("SUNMI_T2_MINI", ("T2MINI",), True, 80, True, True, False),
    SunmiModel("SUNMI_T2S", ("T2S",), True, 80, True, True, False),
    SunmiModel("SUNMI_T3", ("T3",), True, 80, True, True, False),
    SunmiModel("SUNMI_D2_MINI", ("D2MINI",), True, 58, False, True, False),
    SunmiModel("SUNMI_D2S", ("D2S",), True, 58, False, True, False),
    SunmiModel("SUNMI_D2S_PLUS", ("D2SPLUS", "D2SCOMBO"), True, 80, True, True, False),
    SunmiModel("SUNMI_D3", ("D3",), True, 80, True, True, False),
    SunmiModel("SUNMI_D3_MINI", ("D3MINI",), True, 58, False, True, False),
    # ── Kiosk: 80 mm with a cutter, a scan head, no drawer ───────────────────
    SunmiModel("SUNMI_K2", ("K2",), True, 80, True, False, True),
    # ── Not in the table: whatever its print service says ────────────────────
    SunmiModel(SUNMI_GENERIC, (), True, None, False, False, False),
)

SUNMI_MODEL_IDS: Tuple[str, ...] = tuple(m.id for m in SUNMI_MODELS)

_BY_ID = {m.id: m for m in SUNMI_MODELS}

#: Region / batch suffixes SUNMI appends to `Build.MODEL` ("T1-G", "V1-B18", "V1s-G").
_SUFFIX = re.compile(r"[\s_-]+(G|GL|EU|US|CN|B\d+)$")


def sunmi_model(model_id) -> Optional[SunmiModel]:
    """The table's row for a `device_model`, or None for a model that is not a SUNMI."""
    return _BY_ID.get(model_id) if isinstance(model_id, str) else None


def is_sunmi(manufacturer, brand=None) -> bool:
    """`Build.MANUFACTURER` or `Build.BRAND` is SUNMI (any case, any spacing)."""
    return any(isinstance(v, str) and v.strip().upper() == "SUNMI" for v in (manufacturer, brand))


def normalize_sunmi_model(model) -> str:
    """
    `Build.MODEL` without what varies between units of one model: upper case, no "SUNMI"
    in front, no region suffix, no spaces / dashes / underscores — "V2_PRO" and "V2 Pro"
    are both "V2PRO", "T1-G" is "T1", "T2s_LITE" is "T2SLITE".
    """
    if not isinstance(model, str):
        return ""
    s = model.strip().upper()
    s = re.sub(r"^SUNMI[\s_-]*", "", s)
    s = _SUFFIX.sub("", s)
    return re.sub(r"[^A-Z0-9]", "", s)


def sunmi_model_of(model) -> SunmiModel:
    """
    The row whose prefix is the longest one `model` starts with ("V2SPLUS" before "V2S"
    before "V2"); the generic SUNMI row when none does.
    """
    key = normalize_sunmi_model(model)
    best: Optional[SunmiModel] = None
    best_len = 0
    if key:
        for row in SUNMI_MODELS:
            for prefix in row.prefixes:
                if key.startswith(prefix) and len(prefix) > best_len:
                    best, best_len = row, len(prefix)
    return best or _BY_ID[SUNMI_GENERIC]


def detect_sunmi(device_info) -> Optional[str]:
    """The SUNMI model a device's `device_info` names, or None when it is not a SUNMI."""
    if not isinstance(device_info, dict):
        return None
    if not is_sunmi(device_info.get("manufacturer"), device_info.get("brand")):
        return None
    return sunmi_model_of(device_info.get("model")).id
