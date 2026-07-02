"""Dashboard KPI response schemas."""
from datetime import datetime
from typing import List, Literal
import uuid

from pydantic import BaseModel, Field, ConfigDict


class DashboardStatsResponse(BaseModel):
    gross_revenue: float = Field(..., alias="grossRevenue")
    net_revenue: float = Field(..., alias="netRevenue")
    transactions_count: int = Field(..., alias="transactionsCount")
    average_basket: float = Field(..., alias="averageBasket")
    items_sold: float = Field(..., alias="itemsSold")
    refunds_count: int = Field(..., alias="refundsCount")
    refunds_amount: float = Field(..., alias="refundsAmount")
    tips_cash: float = Field(..., alias="tipsCash")
    tips_card: float = Field(..., alias="tipsCard")
    payment_cash: float = Field(..., alias="paymentCash")
    payment_card: float = Field(..., alias="paymentCard")
    from_: datetime = Field(..., alias="from")
    to: datetime = Field(..., alias="to")
    generated_at: datetime = Field(..., alias="generatedAt")

    model_config = ConfigDict(populate_by_name=True)


class DashboardBreakdownRow(BaseModel):
    id: uuid.UUID
    name: str
    gross_revenue: float = Field(..., alias="grossRevenue")
    net_revenue: float = Field(..., alias="netRevenue")
    transactions_count: int = Field(..., alias="transactionsCount")

    model_config = ConfigDict(populate_by_name=True)


class DashboardBreakdownResponse(BaseModel):
    group_by: Literal["company", "shop"] = Field(..., alias="groupBy")
    rows: List[DashboardBreakdownRow]
    from_: datetime = Field(..., alias="from")
    to: datetime = Field(..., alias="to")

    model_config = ConfigDict(populate_by_name=True)
