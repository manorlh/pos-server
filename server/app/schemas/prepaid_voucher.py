"""Prepaid vouchers ("שוברי הפקה"): the dashboard's batch form and the till's lookup/redeem bodies."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_MAX = 200
TEXT_MAX = 1000
#: A batch is printed and handed out by hand; thousands is already a lot of paper.
MAX_VOUCHERS_PER_BATCH = 5000
MAX_ITEMS_PER_VOUCHER = 30
MAX_ITEM_QUANTITY = 100
#: A group ("קבוצה", an envelope of 10 / 20 / any size); at most the whole run.
MAX_GROUP_SIZE = MAX_VOUCHERS_PER_BATCH
BARCODE_TYPES = ("qr", "code128")
REF_MAX = 100


def _barcode(value):
    if value is None:
        return None
    value = str(value).strip().lower()
    if value not in BARCODE_TYPES:
        raise ValueError(f"one of {', '.join(BARCODE_TYPES)}")
    return value


def _clean_text(value, limit: int, *, required: bool = False):
    if value is None:
        if required:
            raise ValueError("required")
        return None
    if not isinstance(value, str):
        raise ValueError("must be text")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"at most {limit} characters")
    if required and not value:
        raise ValueError("required")
    return value or None


class PrepaidVoucherItemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    quantity: int = Field(..., ge=1, le=MAX_ITEM_QUANTITY)


class PrepaidVoucherBatchCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    company_id: uuid.UUID = Field(..., alias="companyId")
    #: Null or empty: every shop of the company.
    shop_ids: Optional[List[uuid.UUID]] = Field(None, alias="shopIds")
    event_name: Optional[str] = Field(None, alias="eventName")
    logo_url: Optional[str] = Field(None, alias="logoUrl")
    free_text: Optional[str] = Field(None, alias="freeText")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    split_allowed: bool = Field(False, alias="splitAllowed")
    items: List[PrepaidVoucherItemIn]
    count: int = Field(..., ge=1, le=MAX_VOUCHERS_PER_BATCH)
    #: Production in groups of this size (10, 20 or any); null: one run, no groups.
    group_size: Optional[int] = Field(None, alias="groupSize", ge=1, le=MAX_GROUP_SIZE)
    #: Print the voucher's code under its barcode.
    show_code: bool = Field(False, alias="showCode")
    #: "qr" (default) or "code128".
    barcode_type: str = Field("qr", alias="barcodeType")
    customer_name: Optional[str] = Field(None, alias="customerName")
    order_ref: Optional[str] = Field(None, alias="orderRef")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, NAME_MAX, required=True)

    @field_validator("barcode_type", mode="before")
    @classmethod
    def _barcode_type(cls, value):
        return _barcode(value) or "qr"

    @field_validator("customer_name", mode="before")
    @classmethod
    def _customer(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("order_ref", mode="before")
    @classmethod
    def _order(cls, value):
        return _clean_text(value, REF_MAX)

    @field_validator("event_name", mode="before")
    @classmethod
    def _event(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("free_text", mode="before")
    @classmethod
    def _free(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo(cls, value):
        return _clean_text(value, 500)

    @model_validator(mode="after")
    def _check(self):
        if not self.items:
            raise ValueError("at least one item")
        if len(self.items) > MAX_ITEMS_PER_VOUCHER:
            raise ValueError(f"at most {MAX_ITEMS_PER_VOUCHER} items")
        if len({i.product_id for i in self.items}) != len(self.items):
            raise ValueError("each product at most once")
        if self.valid_from and self.valid_until and self.valid_until <= self.valid_from:
            raise ValueError("validUntil must be after validFrom")
        return self


class PrepaidVoucherBatchUpdate(BaseModel):
    """What may change after printing: the texts that are not on paper yet, and validity."""

    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = None
    event_name: Optional[str] = Field(None, alias="eventName")
    logo_url: Optional[str] = Field(None, alias="logoUrl")
    free_text: Optional[str] = Field(None, alias="freeText")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    # Print settings: they only change what the next print looks like.
    show_code: Optional[bool] = Field(None, alias="showCode")
    barcode_type: Optional[str] = Field(None, alias="barcodeType")
    customer_name: Optional[str] = Field(None, alias="customerName")
    order_ref: Optional[str] = Field(None, alias="orderRef")

    @field_validator("name", "event_name", "customer_name", mode="before")
    @classmethod
    def _names(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("order_ref", mode="before")
    @classmethod
    def _order(cls, value):
        return _clean_text(value, REF_MAX)

    @field_validator("barcode_type", mode="before")
    @classmethod
    def _barcode_type(cls, value):
        return _barcode(value)

    @field_validator("free_text", mode="before")
    @classmethod
    def _free(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo(cls, value):
        return _clean_text(value, 500)


class PrepaidVoucherAddIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    count: int = Field(..., ge=1, le=MAX_VOUCHERS_PER_BATCH)
    #: In groups of this size (a new group first); null: the batch's own size, if any.
    group_size: Optional[int] = Field(None, alias="groupSize", ge=1, le=MAX_GROUP_SIZE)


class PrepaidVoucherGroupsIn(BaseModel):
    """Split the vouchers that have no group yet into groups of this size."""

    model_config = ConfigDict(populate_by_name=True)

    group_size: int = Field(..., alias="groupSize", ge=1, le=MAX_GROUP_SIZE)


class PrepaidVoucherCancelIn(BaseModel):
    """Why a voucher / a group / the batch is cancelled ("המעטפה אבדה"); kept in the audit trail."""

    reason: Optional[str] = None

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, value):
        return _clean_text(value, TEXT_MAX)


class PrepaidVoucherNoteIn(BaseModel):
    """A voucher's free-text note; blank or null clears it."""

    note: Optional[str] = None

    @field_validator("note", mode="before")
    @classmethod
    def _note(cls, value):
        return _clean_text(value, TEXT_MAX)


# ── Till ──────────────────────────────────────────────────────────────────────


class PrepaidVoucherLookupIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The code as scanned or typed: "PV:" prefix, dashes, spaces and case are ignored.
    code: str = Field(..., min_length=1, max_length=100)


class PrepaidVoucherRedeemItemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The till's product id or the global product id — either is understood.
    product_id: str = Field(..., alias="productId", min_length=1, max_length=100)
    quantity: int = Field(..., ge=1, le=10_000)


class PrepaidVoucherRedeemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str = Field(..., min_length=1, max_length=100)
    items: List[PrepaidVoucherRedeemItemIn]
    #: Makes a retry safe: the same id from the same till returns the first answer.
    client_request_id: str = Field(..., alias="clientRequestId", min_length=1, max_length=100)
    #: One-time ("חד-פעמי") voucher, part of it taken: the cashier confirmed the rest is
    #: given up. Ignored for a voucher that may be redeemed in parts.
    forfeit_rest: bool = Field(False, alias="forfeitRest")
    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)
    #: The till's sale document for these goods (client-generated id), if it made one.
    transaction_id: Optional[str] = Field(None, alias="transactionId", max_length=100)

    @field_validator("pos_user_id", mode="before")
    @classmethod
    def _uid(cls, value):
        if isinstance(value, (int, float)):
            return str(value)
        return value

    @model_validator(mode="after")
    def _check(self):
        if not self.items:
            raise ValueError("at least one item")
        return self
