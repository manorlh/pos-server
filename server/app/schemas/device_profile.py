"""Request bodies for a device's role and model (docs/SPEC_DEVICE_ROLE_MODEL.md)."""
from __future__ import annotations

import uuid
from typing import List, Literal, Optional

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
    #: "מסופון חיצוני ברשת — חובה לקיוסק": a kiosk charges on an external Nayax pinpad, never
    #: a built-in terminal. Its address, written to the machine's own settings layer — the
    #: same keys the till and the per-till settings already use (`nayaxEnabled`,
    #: `nayaxDeviceHost`, `nayaxDevicePort`). Optional: a level above may set it, or it is
    #: typed later (per-till settings, or at the till before its first card payment).
    pinpad_host: Optional[str] = Field(None, alias="pinpadHost", max_length=300)
    pinpad_port: Optional[int] = Field(None, alias="pinpadPort")


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
