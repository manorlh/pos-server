"""
`POST /reports/pdf` — a report as a real PDF file (P:/specs/reports-upgrade.md §2ד, §4.5).

The dashboard sends the table it shows (title, sub-titles, filters, the columns chosen for the
export, rows, totals); the file is drawn by app/services/report_pdf.py. Signed-in dashboard
users only (`get_current_user` refuses a till's token); nothing is read but the business's
logo, and only of a company the caller sees. Over `MAX_ROWS` rows is a 413 in Hebrew.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Literal, Optional, Union
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.orm import Session
from typing_extensions import Annotated

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services import report_pdf as pdf

router = APIRouter(prefix="/reports", tags=["reports"])

Line = Annotated[str, StringConstraints(max_length=500)]


class PdfColumn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=200)
    align: Optional[Literal["start", "end", "center", "left", "right"]] = None
    kind: Literal["text", "money", "number", "percent", "date"] = "text"


class ReportPdfIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    title: str = Field(..., min_length=1, max_length=200)
    subtitle_lines: List[Line] = Field(default_factory=list, alias="subtitleLines", max_length=10)
    filter_lines: List[Line] = Field(default_factory=list, alias="filterLines", max_length=30)
    columns: List[PdfColumn] = Field(..., min_length=1, max_length=pdf.MAX_COLUMNS)
    rows: List[Union[Dict[str, Any], List[Any]]] = Field(default_factory=list)
    totals: Optional[Union[Dict[str, Any], List[Any]]] = None
    orientation: Literal["portrait", "landscape", "auto"] = "auto"
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    file_name: Optional[str] = Field(None, alias="fileName", max_length=200)


def too_many_rows(count: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        detail=(
            f"הדוח גדול מדי לקובץ PDF: {count:,} שורות (עד {pdf.MAX_ROWS:,}). "
            "צמצמו את טווח התאריכים או את הסינון, או ייצאו ל-Excel."
        ),
    )


@router.post(
    "/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}, "description": "The report as a PDF file."}},
)
def post_report_pdf(
    body: ReportPdfIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The report as a PDF: a header on every page (logo, title, sub-titles, filters), the column
    headers repeated, the totals row, "עמוד X מתוך Y". `orientation: auto` is landscape above
    7 columns. Money prints as `₪ 1,234.50`; see §4.5 for every kind.
    """
    if len(body.rows) > pdf.MAX_ROWS:
        raise too_many_rows(len(body.rows))
    keys = [c.key for c in body.columns]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="columns: each key once")

    logo = None
    if body.company_id is not None:
        from app.services import report_export_defaults as access

        company = access.resolve_company(db, current_user, active_tenant_id, body.company_id)
        access.require_read(db, current_user, company)
        logo = pdf.company_logo(db, company)

    from app.services.reports import resolve_report_timezone

    tz_name = resolve_report_timezone(db, active_tenant_id, None)
    report = pdf.build_report(
        title=body.title,
        columns=[c.model_dump() for c in body.columns],
        rows=body.rows,
        totals=body.totals,
        subtitle_lines=body.subtitle_lines,
        filter_lines=body.filter_lines,
        orientation=body.orientation,
        tz_name=tz_name,
        logo=logo,
    )
    data = pdf.render(report)
    name = pdf.file_name(body.file_name or body.title)
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store",
        },
    )
