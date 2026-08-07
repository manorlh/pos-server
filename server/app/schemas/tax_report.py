"""Tax report API schemas."""

from datetime import date
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class TaxOpenFormatPreviewResponse(BaseModel):
    transaction_count: int = Field(..., alias="transactionCount")
    record_counts: Dict[str, int] = Field(..., alias="recordCounts")
    business_info: Dict[str, Any] = Field(..., alias="businessInfo")
    global_tax_rate: float = Field(..., alias="globalTaxRate")
    date_range: Dict[str, Any] = Field(..., alias="dateRange")

    class Config:
        populate_by_name = True
