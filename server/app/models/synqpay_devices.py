"""
SynqPay terminals as till hardware (docs/SPEC_SYNQPAY.md §1.5): the till app runs ON the
terminal and charges on its own card reader through SynqPay's Local Mode — "like an F20" —
so each is a model with a terminal of its own.

* Named by the till at pairing: `device_info["synqpay"]` ("true" when SynqPay's payment app,
  `com.synqpay.pos`, is installed), then `device_info["model"]` for which one. An Ingenico
  without SynqPay is not one of these.
* The models are those SynqPay's docs name (getDeviceInfo's example, the changelog); what each
  reports as `Build.MODEL` is not documented — an unrecognised one is the generic `SYNQPAY`.
* Printing: SynqPay prints its own card slips; the till's receipts on the terminal's head need
  SynqPay's PAL, which only its Android SDK carries (not bundled) — so no model prints yet, and
  each is "בקרוב" (driver pending), like a LANDI. No drawer API is documented.

Pure data with no imports from the app: `app.models.pos_machine` builds its sets from it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class SynqPayDeviceModel:
    #: `pos_machines.device_model` (String(16)).
    id: str
    #: `synqpayDeviceModel` (app/services/payment_integration.py SYNQPAY_MODELS).
    synqpay_model: str
    #: Upper-case letters and digits a reported `Build.MODEL` contains.
    markers: Tuple[str, ...]
    #: A maker that alone names it (Verifone: no model is documented).
    maker: Optional[str] = None


SYNQPAY_GENERIC = "SYNQPAY"

SYNQPAY_DEVICE_MODELS: Tuple[SynqPayDeviceModel, ...] = (
    SynqPayDeviceModel("SYNQPAY_DX8000", "dx8000", ("DX8000",)),
    SynqPayDeviceModel("SYNQPAY_DX6000", "dx6000", ("DX6000",)),
    SynqPayDeviceModel("SYNQPAY_EX8000", "ex8000", ("EX8000",)),
    SynqPayDeviceModel("SYNQPAY_RX5000", "rx5000", ("RX5000",)),
    SynqPayDeviceModel("SYNQPAY_S1P2", "s1p2", ("S1P2",)),
    SynqPayDeviceModel("SYNQPAY_S1U2_M4", "s1u2_m4", ("S1U2",)),
    SynqPayDeviceModel("SYNQPAY_VERIFONE", "verifone", (), maker="verifone"),
    SynqPayDeviceModel(SYNQPAY_GENERIC, "other", ()),
)

SYNQPAY_DEVICE_MODEL_IDS: Tuple[str, ...] = tuple(m.id for m in SYNQPAY_DEVICE_MODELS)

_BY_ID = {m.id: m for m in SYNQPAY_DEVICE_MODELS}


def synqpay_device_model(model_id) -> Optional[SynqPayDeviceModel]:
    """The row for a `device_model`, or None when it is not a SynqPay terminal."""
    return _BY_ID.get(model_id) if isinstance(model_id, str) else None


def reports_synqpay(device_info) -> bool:
    """The till said SynqPay's payment app is on it (`"synqpay": "true"`)."""
    if not isinstance(device_info, dict):
        return False
    v = device_info.get("synqpay")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def synqpay_model_of(manufacturer, model) -> str:
    """The row a reported maker / model names; the generic SynqPay terminal when none does."""
    key = re.sub(r"[^A-Z0-9]", "", model.upper()) if isinstance(model, str) else ""
    maker = manufacturer.strip().lower() if isinstance(manufacturer, str) else ""
    for row in SYNQPAY_DEVICE_MODELS:
        if any(marker in key for marker in row.markers):
            return row.id
    for row in SYNQPAY_DEVICE_MODELS:
        if row.maker and row.maker in maker:
            return row.id
    return SYNQPAY_GENERIC


def detect_synqpay(device_info) -> Optional[str]:
    """The SynqPay model a device's `device_info` names, or None when it is not a SynqPay terminal."""
    if not reports_synqpay(device_info):
        return None
    return synqpay_model_of(device_info.get("manufacturer"), device_info.get("model"))
