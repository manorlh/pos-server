"""
"מימוש ידני מהענן" (app/services/prepaid_voucher_manual.py): the dashboard's manual redemption of
production vouchers, one, many, and its undo.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Bulk: at most this many vouchers per request.
MAX_BULK = 500


class ManualRedeemItemIn(BaseModel):
    """One line of what was handed over: a product (and how many), or a group's units without a product."""

    model_config = ConfigDict(populate_by_name=True)

    product_id: Optional[str] = Field(None, alias="productId", max_length=100)
    group_key: Optional[str] = Field(None, alias="groupKey", max_length=100)
    quantity: Decimal = Field(Decimal(1), gt=0, le=10000)


class _Common(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Where it happened. Optional only when the batch is valid in exactly one shop.
    shop_id: Optional[str] = Field(None, alias="shopId", max_length=100)
    machine_id: Optional[str] = Field(None, alias="machineId", max_length=100)
    #: When it happened (default now): never in the future, never outside the batch's validity.
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")
    #: Why (3–200 characters); blank on a one-click redemption → "מימוש ידני".
    reason: Optional[str] = Field(None, max_length=200)
    #: "סמן כמומש": everything left, no details, the default reason.
    one_click: bool = Field(False, alias="oneClick")
    #: A super admin only: past expiry, not-yet-valid and another shop ("כפייה").
    force: bool = False
    client_request_id: Optional[str] = Field(None, alias="clientRequestId", max_length=64)


class ManualRedeemIn(_Common):
    code: Optional[str] = Field(None, max_length=100)
    voucher_id: Optional[str] = Field(None, alias="voucherId", max_length=100)
    #: Everything left on the voucher (any kind).
    full: bool = False
    #: Goods / groups: what was handed over.
    items: Optional[List[ManualRedeemItemIn]] = Field(None, max_length=500)
    #: A punch card (item groups): how many units.
    units: Optional[int] = Field(None, gt=0, le=10000)
    #: An item / order discount: how many uses (default 1).
    uses: Optional[int] = Field(None, gt=0, le=10000)
    #: A one-time voucher taken in part: the rest is given up.
    forfeit_rest: bool = Field(False, alias="forfeitRest")


class ManualRedeemBulkIn(_Common):
    codes: Optional[List[str]] = Field(None, max_length=MAX_BULK)
    voucher_ids: Optional[List[str]] = Field(None, alias="voucherIds", max_length=MAX_BULK)
    #: Always everything left (the only bulk mode).
    full: bool = True

    @field_validator("codes", "voucher_ids", mode="before")
    @classmethod
    def _strings(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return []
        return [str(v).strip() for v in value if v is not None and str(v).strip()]


class ManualRedeemPreviewIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    codes: Optional[List[str]] = Field(None, max_length=MAX_BULK)
    voucher_ids: Optional[List[str]] = Field(None, alias="voucherIds", max_length=MAX_BULK)
    shop_id: Optional[str] = Field(None, alias="shopId", max_length=100)
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")

    @field_validator("codes", "voucher_ids", mode="before")
    @classmethod
    def _strings(cls, value):
        return ManualRedeemBulkIn._strings(value)


class ManualReverseIn(BaseModel):
    reason: str = Field(..., min_length=3, max_length=200)
