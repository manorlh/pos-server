"""
"מכשירי תשלום" from the dashboard (app/services/payment_devices.py).

The fields are loosely typed on purpose: the service validates each one and answers 422 with a
machine-readable `detail.code` and the field it is about, in Hebrew — rather than pydantic's
generic list. The secret is `Any` so that no validation error can ever echo one back.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field


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
