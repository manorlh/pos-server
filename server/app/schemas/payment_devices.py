"""
"מכשירי תשלום" from the dashboard (app/services/payment_devices.py).

The fields are loosely typed on purpose: the service validates each one and answers 422 with a
machine-readable `detail.code` and the field it is about, in Hebrew — rather than pydantic's
generic list. The secret is `Any` so that no validation error can ever echo one back.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class PaymentDeviceIn(BaseModel):
    """
    `POST /shops/{shop_id}/payment-devices` (nickname and kind required) and
    `PUT /payment-devices/{id}` (only the fields sent change).

    `config` — the kind's fields (see the service): agamento_lan `{host, port?, path?, https?,
    mac?, terminalNumber?}`; zcredit_pinpad `{pinpadId}` (the terminal number, mode and password
    are the branch's Z-Credit settings — anything else sent is dropped); synqpay `{model,
    connection, host? (lan), protocol?, port?, tls?, usbDevice?, serialNumber?, terminalNumber?}`.
    `synqpayApiKey`: a string sets, `null` / "" removes, the mask "••••" keeps; dropped for
    another kind. A device belongs to its shop: which till uses it is the till's settings
    (`machineIds`, `zcreditPassword` and other unknown fields are ignored).
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    nickname: Optional[Any] = None
    kind: Optional[Any] = None
    config: Optional[Dict[str, Any]] = None
    active: Optional[Any] = None
    sort_order: Optional[Any] = Field(None, alias="sortOrder")
    synqpay_api_key: Optional[Any] = Field(None, alias="synqpayApiKey", exclude=True, repr=False)


class PaymentDeviceHostIn(BaseModel):
    """
    `PUT /sync/{machine_id}/payment-devices/{device_id}/host` — an Agamento LAN handheld found by
    the till at a new address (app/services/payment_devices.py `relink_device_host`). The fields
    of the till's `PinpadHostRequest` (`PUT /sync/{m}/pinpad-host`); `terminal` and `from` are
    read as `terminalNumber` and `previousHost`.
    """

    model_config = ConfigDict(populate_by_name=True)

    host: str = Field(..., max_length=300)
    #: SPICy's port; absent = unchanged.
    port: Optional[int] = Field(None, ge=1, le=65535)
    #: "relocated" (found by the till itself, the default) | "technician" (picked by hand).
    reason: Optional[str] = Field(None, max_length=16)
    #: The terminal number the handheld at [host] said it is (`getRetailerInfo`).
    terminal_number: Optional[str] = Field(
        None, validation_alias=AliasChoices("terminalNumber", "terminal", "terminal_number"), max_length=20
    )
    serial: Optional[str] = Field(None, max_length=60)
    #: The address the till used before, as it held it.
    previous_host: Optional[str] = Field(
        None, validation_alias=AliasChoices("previousHost", "from", "previous_host"), max_length=300
    )
    #: The handheld's MAC when Android let the till read it (a hint only).
    mac: Optional[str] = Field(None, max_length=32)
