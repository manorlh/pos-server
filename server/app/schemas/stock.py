from datetime import datetime
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field, ConfigDict


class StockLevelOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    product_name: Optional[str] = Field(None, alias="productName")
    sku: Optional[str] = None
    quantity: Decimal
    reorder_min: Optional[int] = Field(None, alias="reorderMin")
    reorder_max: Optional[int] = Field(None, alias="reorderMax")
    reorder_opt: Optional[int] = Field(None, alias="reorderOpt")
    updated_at: datetime = Field(..., alias="updatedAt")


class StockMovementIn(BaseModel):
    """Single movement from POS (uploaded with transaction batch)."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    product_id: uuid.UUID = Field(..., alias="productId")
    delta: Decimal
    reason: Literal["sale", "refund", "goods_receipt", "adjustment", "stocktake", "wastage"]
    transaction_item_id: Optional[uuid.UUID] = Field(None, alias="transactionItemId")
    occurred_at: datetime = Field(..., alias="occurredAt")
    note: Optional[str] = None


class GoodsReceiptRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    quantity: Decimal = Field(..., gt=0)
    note: Optional[str] = None


class AdjustmentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    delta: Decimal = Field(..., description="Signed adjustment (+/-)")
    note: Optional[str] = None


class StocktakeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    quantity: Decimal = Field(..., ge=0)
    note: Optional[str] = None


class StockSyncResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    sync_type: Literal["full", "delta", "unchanged"] = Field(..., alias="syncType")
    server_time: datetime = Field(..., alias="serverTime")
    stock_updated_at: datetime = Field(..., alias="stockUpdatedAt")
    levels: List[StockLevelOut] = Field(default_factory=list)
