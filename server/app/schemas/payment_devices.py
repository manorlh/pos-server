"""
"מכשירי תשלום" from the dashboard (app/services/payment_devices.py).

The fields are loosely typed on purpose: the service validates each one and answers 422 with a
machine-readable `detail.code` and the field it is about, in Hebrew — rather than pydantic's
generic list. The secrets are `Any` so that no validation error can ever echo one back.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class PaymentDeviceIn(BaseModel):
    """
    `POST /shops/{shop_id}/payment-devices` (nickname and kind required) and
    `PUT /payment-devices/{id}` (only the fields sent change).

    `config` — the kind's fields (see the service): agamento_lan `{host, port?, path?, https?,
    mac?, terminalNumber?}`; zcredit_pinpad `{pinpadId, terminalNumber?, mode?}`; synqpay
    `{model, connection, host? (lan), protocol?, port?, tls?, usbDevice?, serialNumber?,
    terminalNumber?}`. `machineIds` — the shop's tills that use it; empty = all of them.
    Secrets: a string sets, `null` / "" removes, the mask "••••" keeps; a secret of another
    kind is dropped.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    nickname: Optional[Any] = None
    kind: Optional[Any] = None
    config: Optional[Dict[str, Any]] = None
    machine_ids: Optional[List[Any]] = Field(None, alias="machineIds")
    active: Optional[Any] = None
    sort_order: Optional[Any] = Field(None, alias="sortOrder")
    zcredit_password: Optional[Any] = Field(None, alias="zcreditPassword", exclude=True, repr=False)
    synqpay_api_key: Optional[Any] = Field(None, alias="synqpayApiKey", exclude=True, repr=False)
