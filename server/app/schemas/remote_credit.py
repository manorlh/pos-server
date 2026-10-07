"""Bodies of "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md)."""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class RemoteCreditLineIn(BaseModel):
    item_id: uuid.UUID = Field(..., alias="itemId")
    quantity: Decimal = Field(..., gt=0, le=Decimal("1000000"))

    class Config:
        populate_by_name = True


class RemoteCreditCreateIn(BaseModel):
    #: The command id, minted by the dashboard so a double submit is one request. Optional.
    id: Optional[uuid.UUID] = None
    transaction_id: uuid.UUID = Field(..., alias="transactionId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    mode: Literal["no_money", "prepared"]
    #: Everything still creditable; `lines` is ignored then.
    full: bool = False
    lines: List[RemoteCreditLineIn] = Field(default_factory=list, max_length=500)
    reason: Optional[str] = Field(None, max_length=1000)
    reason_code: Optional[str] = Field(None, alias="reasonCode", max_length=32)

    class Config:
        populate_by_name = True


class RemoteCreditCancelIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=300)


class RemoteCreditAckIn(BaseModel):
    """The till's answer (POST /sync/{m}/remote-credits/{id}/ack)."""

    phase: Literal["received", "deferred", "waiting", "completed", "failed"]
    credit_transaction_id: Optional[uuid.UUID] = Field(None, alias="creditTransactionId")
    credit_document_number: Optional[str] = Field(None, alias="creditDocumentNumber", max_length=40)
    credit_document_type: Optional[int] = Field(None, alias="creditDocumentType")
    credit_amount: Optional[Decimal] = Field(None, alias="creditAmount")
    error_code: Optional[str] = Field(None, alias="errorCode", max_length=64)
    error_message: Optional[str] = Field(None, alias="errorMessage", max_length=1000)

    class Config:
        populate_by_name = True
