"""Tips report schemas."""
from decimal import Decimal
from typing import List, Literal, Optional
import uuid

from pydantic import BaseModel, Field


class TipCashierRow(BaseModel):
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    cashier_name: Optional[str] = Field(None, alias="cashierName")
    worker_number: Optional[str] = Field(None, alias="workerNumber")
    tips_collected: Decimal = Field(..., alias="tipsCollected")
    cash_tips: Decimal = Field(..., alias="cashTips")
    card_tips: Decimal = Field(..., alias="cardTips")
    sales_total: Decimal = Field(..., alias="salesTotal")
    transaction_count: int = Field(..., alias="transactionCount")
    amount_owed: Decimal = Field(..., alias="amountOwed")

    class Config:
        populate_by_name = True


class TipsReportResponse(BaseModel):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    distribution: Literal["direct", "equal_pool", "by_sales"]
    from_date: Optional[str] = Field(None, alias="fromDate")
    to_date: Optional[str] = Field(None, alias="toDate")
    total_tips: Decimal = Field(..., alias="totalTips")
    total_cash_tips: Decimal = Field(..., alias="totalCashTips")
    total_card_tips: Decimal = Field(..., alias="totalCardTips")
    total_sales: Decimal = Field(..., alias="totalSales")
    cashiers: List[TipCashierRow]

    class Config:
        populate_by_name = True
