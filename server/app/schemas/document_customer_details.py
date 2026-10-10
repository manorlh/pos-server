"""
"הדפס העתק עם פרטי לקוח" (docs/SPEC_CUSTOMER_INVOICE.md §3.5): the customer's details a till added to a
copy of a document after it was issued — in from the till (the document's detail reads them back
through `CustomerDetailsAddedOut` in schemas/transaction.py).
"""
import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.transaction import customer_vat_text, cut_text


class DocumentCustomerDetailsIn(BaseModel):
    """One time details were added to a document's copy. Client id; a resend is a no-op."""

    id: uuid.UUID
    transaction_id: uuid.UUID = Field(..., alias="transactionId")
    customer_name: str = Field(..., alias="customerName", min_length=1)
    customer_vat_number: str = Field(..., alias="customerVatNumber", min_length=1)
    customer_address: Optional[str] = Field(None, alias="customerAddress")
    customer_phone: Optional[str] = Field(None, alias="customerPhone")
    customer_email: Optional[str] = Field(None, alias="customerEmail")
    added_by_id: Optional[str] = Field(None, alias="addedById", max_length=100)
    added_by_name: Optional[str] = Field(None, alias="addedByName", max_length=200)
    added_at: datetime = Field(..., alias="addedAt")

    class Config:
        populate_by_name = True

    @field_validator("customer_name", mode="before")
    @classmethod
    def _name(cls, value):
        return cut_text(value, 255) or ""

    @field_validator("customer_vat_number", mode="before")
    @classmethod
    def _vat(cls, value):
        # As printed: trimmed, spaces and dashes out, cut to the column; never repaired.
        return customer_vat_text(value) or ""

    @field_validator("customer_address", mode="before")
    @classmethod
    def _address(cls, value):
        return cut_text(value, 500)

    @field_validator("customer_phone", mode="before")
    @classmethod
    def _phone(cls, value):
        return cut_text(value, 30)

    @field_validator("customer_email", mode="before")
    @classmethod
    def _email(cls, value):
        return cut_text(value, 255)


class DocumentCustomerDetailsIngestOut(BaseModel):
    id: uuid.UUID
    status: Literal["accepted", "duplicate"]
