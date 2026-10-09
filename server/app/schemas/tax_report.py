"""Tax report API schemas."""

from datetime import date
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TaxOpenFormatPreviewResponse(BaseModel):
    transaction_count: int = Field(..., alias="transactionCount")
    record_counts: Dict[str, int] = Field(..., alias="recordCounts")
    business_info: Dict[str, Any] = Field(..., alias="businessInfo")
    global_tax_rate: float = Field(..., alias="globalTaxRate")
    date_range: Dict[str, Any] = Field(..., alias="dateRange")
    #: A000 1006–1010 as the file writes them (`/system/open-format`).
    software: Optional[Dict[str, Any]] = None
    #: The software fields still written as placeholders, for the owner to fill in.
    placeholders: List[str] = Field(default_factory=list)
    #: Documents whose payment records were not the till's tenders as sent (their tenders
    #: did not add up — `tenders_do_not_reconcile`): apportioned to the document's total.
    flagged_documents: List[Dict[str, Any]] = Field(default_factory=list, alias="flaggedDocuments")
    #: Duplicate copies in the window, left out of the file (counted once, SHIFTS_API §1.2d).
    excluded_duplicate_copies: int = Field(0, alias="excludedDuplicateCopies")

    class Config:
        populate_by_name = True
