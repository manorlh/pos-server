"""Request bodies for a device's role and model (docs/SPEC_DEVICE_ROLE_MODEL.md)."""
from __future__ import annotations

import uuid
from typing import List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.pos_machine import DeviceModel, DeviceRole


class KioskOptionsIn(BaseModel):
    """
    A kiosk's options when a device is added as one, or a till is made one from the machine
    page — the same three the kiosks page's "הפוך קופה לקיוסק" asks for (`KioskCreateIn`).
    """

    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = Field(None, max_length=100)
    #: Tills of the same company that may pause / resume / close / Z the kiosk.
    controller_machine_ids: List[str] = Field(default_factory=list, alias="controllerMachineIds", max_length=50)
    #: "נעל את המכשיר (מצב קיוסק)": the till parameter `kioskMode` at the machine's level.
    lock_device: bool = Field(False, alias="lockDevice")
    #: "שליטה מקופות" (app/services/kiosk_controllers.py), set on the kiosk itself; absent — it inherits.
    controller_source: Optional[Literal["list", "area", "both"]] = Field(None, alias="controllerSource")
    #: An older dashboard's kiosk pinpad (today's dialog sends "מסופון אשראי" as the pairing request's
    #: `terminal`, app/services/device_terminal.py, which wins over these). A Nayax pinpad's
    #: address, written to the machine's own settings layer — the
    #: same keys the till and the per-till settings already use (`nayaxEnabled`,
    #: `nayaxDeviceHost`, `nayaxDevicePort`). Optional: a level above may set it, or it is
    #: typed later (per-till settings, or at the till before its first card payment).
    pinpad_host: Optional[str] = Field(None, alias="pinpadHost", max_length=300)
    pinpad_port: Optional[int] = Field(None, alias="pinpadPort")


class DeviceTerminalIn(BaseModel):
    """
    "מסופון אשראי" chosen in the add-device dialog for a till or a kiosk (app/services/device_terminal.py):
    the type — `paymentIntegration` ("auto" = לפי הגדרות הסניף, writes nothing) — and that type's
    non-secret fields, the same keys the per-till settings take. Written to the machine's own settings
    layer as it pairs. No secret is taken here (a Z-Credit password, a merchant code, a SynqPay key stay
    on the payment settings page): an unknown key is a 422.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    payment_integration: str = Field(..., alias="paymentIntegration", max_length=32)
    nayax_device_host: Optional[str] = Field(None, alias="nayaxDeviceHost", max_length=300)
    nayax_device_port: Optional[Union[int, str]] = Field(None, alias="nayaxDevicePort")
    nayax_usb_device: Optional[str] = Field(None, alias="nayaxUsbDevice", max_length=32)
    zcredit_terminal_number: Optional[str] = Field(None, alias="zcreditTerminalNumber", max_length=32)
    zcredit_pinpad_id: Optional[str] = Field(None, alias="zcreditPinpadId", max_length=64)
    zcredit_mode: Optional[str] = Field(None, alias="zcreditMode", max_length=16)
    synqpay_device_model: Optional[str] = Field(None, alias="synqpayDeviceModel", max_length=32)
    synqpay_connection: Optional[str] = Field(None, alias="synqpayConnection", max_length=16)
    synqpay_host: Optional[str] = Field(None, alias="synqpayHost", max_length=300)
    synqpay_protocol: Optional[str] = Field(None, alias="synqpayProtocol", max_length=8)
    synqpay_port: Optional[Union[int, str]] = Field(None, alias="synqpayPort")
    synqpay_tls: Optional[bool] = Field(None, alias="synqpayTls")
    synqpay_usb_device: Optional[str] = Field(None, alias="synqpayUsbDevice", max_length=32)
    tap_to_pay_tpn: Optional[str] = Field(None, alias="tapToPayTpn", max_length=32)
    tap_to_pay_environment: Optional[str] = Field(None, alias="tapToPayEnvironment", max_length=16)


class KdsScreenOptionsIn(BaseModel):
    """
    A KDS device's screen when it is added (or a board made a KDS on the machine page): the
    KDS page's own fields (`KdsDeviceIn`). "station" needs at least one station; the board
    is always the KDS module's "pickup" screen and takes only `name`.
    """

    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = Field(None, max_length=100)
    screen_role: Literal["station", "expo", "manager"] = Field("expo", alias="screenRole")
    station_ids: List[uuid.UUID] = Field(default_factory=list, alias="stationIds", max_length=30)
    #: "מסך לקוח" (P:/specs/customer-display.md §4): the till a customer display mirrors. Optional —
    #: chosen later on the customer-display page. Ignored for a KDS / board.
    till_machine_id: Optional[uuid.UUID] = Field(None, alias="tillMachineId")


class DeviceProfileIn(BaseModel):
    """
    `PUT /machines/{id}/device-profile`: change the role, the model, or both. Omitted (or
    the value it has) is no change. The safety checks are in app/services/device_profile.py.
    """

    model_config = ConfigDict(populate_by_name=True)

    device_role: Optional[DeviceRole] = Field(None, alias="deviceRole")
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")
    #: Used when the role becomes "kiosk"; ignored otherwise (an existing kiosk's options
    #: are edited on the kiosks page).
    kiosk: Optional[KioskOptionsIn] = None
    #: Used when a board becomes a KDS (its screen); ignored otherwise. A till never becomes
    #: a display device here, nor back (409 `device_role_change_requires_pairing`).
    kds: Optional[KdsScreenOptionsIn] = None
    #: "סוג רישיון" with the change (P:/specs/device-license-type.md §2): a super admin / the device's
    #: distributor only (403); the new role must fit it (409 `license_product_role_mismatch`).
    license_product: Optional[str] = Field(None, alias="licenseProduct", max_length=32)


class LicenseProductIn(BaseModel):
    """`PUT /machines/{id}/license-product`: "till" | "kiosk" | "kiosk_till" (app/services/device_license.py)."""

    model_config = ConfigDict(populate_by_name=True)

    license_product: Optional[str] = Field(None, alias="licenseProduct", max_length=32)
