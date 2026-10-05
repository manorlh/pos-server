"""
A print document: a till slip described as data, rendered by the dashboard at 80 mm.

The server decides what is on the paper (and in which words); the client only lays it
out. So a reprint reads the same whichever screen asks for it, and a test can assert
the content without a browser.
"""
from typing import List

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

    class Config:
        populate_by_name = True


class PrintDocumentListOut(BaseModel):
    """Every card voucher of a document, when no single payment was asked for."""

    documents: List[PrintDocumentOut] = Field(default_factory=list)
