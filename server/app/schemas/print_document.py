"""
A print document: a till slip described as data, rendered by the dashboard at 80 mm.

The server decides what is on the paper (and in which words); the client only lays it
out. So a reprint reads the same whichever screen asks for it, and a test can assert
the content without a browser.
"""
from typing import List, Optional

from pydantic import BaseModel, Field


class PrintRow(BaseModel):
    label: str
    value: str = ""
    emphasis: bool = False


class PrintSection(BaseModel):
    title: str = ""
    rows: List[PrintRow] = Field(default_factory=list)


class PrintDocumentOut(BaseModel):
    title: str
    #: Always set on a reprint from the cloud: it is never presented as an original.
    copy_mark: str = Field(..., alias="copyMark")
    business_name: str = Field(..., alias="businessName")
    subtitle: List[str] = Field(default_factory=list)
    sections: List[PrintSection] = Field(default_factory=list)
    footer: List[str] = Field(default_factory=list)
    #: "שולחן 12 · גן · 4 סועדים · מלצר: דנה" under the title of a table's document (`receiptTableInfo`,
    #: app/services/receipt_table_info.py); None — none asked, or no table's.
    table_line: Optional[str] = Field(None, alias="tableLine")

    class Config:
        populate_by_name = True


class PrintDocumentListOut(BaseModel):
    """Every card voucher of a document, when no single payment was asked for."""

    documents: List[PrintDocumentOut] = Field(default_factory=list)
