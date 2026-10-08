"""
"צימוד מסוף SynqPay" from the till (docs/SPEC_SYNQPAY.md §2.2): the key the till got by pairing
with its terminal, and its report that the terminal refused the key it has.
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.payment_secrets import is_synqpay_api_key

_SERIAL = re.compile(r"^[A-Za-z0-9-]{4,32}$")


class SynqpayPairingIn(BaseModel):
    """
    `POST /sync/{m}/synqpay/pairing`. The key is SynqPay's `authenticate` answer (letters and
    digits, "1234abcd"); the serial number the terminal was paired by, when the till knows it.
    The key is checked by the router (422 `secret_invalid`), not here: a validation error
    would echo the value back in its `input`. `repr=False`: never in a log line.
    """

    model_config = ConfigDict(populate_by_name=True)

    synqpay_api_key: Optional[str] = Field(None, alias="synqpayApiKey", repr=False)
    serial_number: Optional[str] = Field(None, alias="serialNumber")
    #: "מכשירי תשלום": the key is that SynqPay device's (app/services/payment_devices.py), not
    #: the till's own integration's. Absent = today's behaviour.
    payment_device_id: Optional[uuid.UUID] = Field(None, alias="paymentDeviceId")

    def key_or_none(self) -> Optional[str]:
        """The key when it is one SynqPay hands out; None otherwise."""
        value = self.synqpay_api_key
        return value.strip() if isinstance(value, str) and is_synqpay_api_key(value) else None

    @field_validator("synqpay_api_key", mode="before")
    @classmethod
    def _key_is_text(cls, value):
        # Anything but text reads as no key (refused by the router, never echoed).
        return value if isinstance(value, str) else None

    @field_validator("serial_number", mode="before")
    @classmethod
    def _serial(cls, value):
        if value is None or (isinstance(value, str) and value.strip() == ""):
            return None
        if not isinstance(value, str) or not _SERIAL.match(value.strip()):
            raise ValueError("serialNumber must be 4–32 letters, digits or '-'")
        return value.strip()


class SynqpayKeyRejectedIn(BaseModel):
    """`POST /sync/{m}/synqpay/key-rejected`: what the terminal said, in the till's words (logged only)."""

    model_config = ConfigDict(populate_by_name=True)

    detail: Optional[str] = Field(None, max_length=200)
    #: The payment device whose key was refused; absent = the till's own integration's key.
    payment_device_id: Optional[uuid.UUID] = Field(None, alias="paymentDeviceId")
