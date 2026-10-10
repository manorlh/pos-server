"""Bodies of "זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11)."""
from __future__ import annotations

import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.remote_credit import RemoteCreditLineIn


class CloudCardRefundCreateIn(BaseModel):
    #: The request id, minted by the dashboard: the same id is the same refund. Required — a
    #: refund without one could not be told apart from a second refund after a lost answer.
    id: uuid.UUID
    transaction_id: uuid.UUID = Field(..., alias="transactionId")
    #: The Z-Credit card leg refunded.
    payment_id: uuid.UUID = Field(..., alias="paymentId")
    #: The till asked to issue the credit note.
    machine_id: uuid.UUID = Field(..., alias="machineId")
    #: Everything still creditable; `lines` is ignored then.
    full: bool = False
    lines: List[RemoteCreditLineIn] = Field(default_factory=list, max_length=500)
    reason: Optional[str] = Field(None, max_length=1000)
    reason_code: Optional[str] = Field(None, alias="reasonCode", max_length=32)

    class Config:
        populate_by_name = True


class CloudCardRefundResolveIn(BaseModel):
    """An operator's record of an unknown refund, after checking Z-Credit's report."""

    outcome: Literal["refunded", "not_refunded"]
    note: str = Field(..., max_length=1000)


class CloudCardRefundResendIn(BaseModel):
    machine_id: uuid.UUID = Field(..., alias="machineId")
    #: Move a credit note still waiting at a till (confirmed by the user).
    force: bool = False

    class Config:
        populate_by_name = True


class CloudCardRefundReleaseIn(BaseModel):
    """A super admin lets the next Z of the note's till go without it — with a typed reason."""

    reason: str = Field(..., max_length=300)
