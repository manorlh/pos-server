"""
`POST /reports/pdf` — a report as a designed PDF file (P:/specs/reports-designed-pdf.md §7.1;
first P:/specs/reports-upgrade.md §2ד, §4.5) — and `POST /reports/insights`, the same body's
summary as JSON (§7.2: the Excel export's first sheet, "סיכום ותובנות").

The dashboard sends the table it shows (title, sub-titles, filters, the columns chosen for the
export, rows, totals) and, optionally, the report's type, its KPI cards, a chart, the compared
period's rows and the columns to group by; the server makes the insights and draws it all
(app/services/report_document.py → report_design.py). A body of the old shape is still a
report, in the new design. Signed-in dashboard users only (`get_current_user` refuses a till's
token); nothing is read but the business's branding, and only of a company the caller sees.
Over `MAX_ROWS` rows is a 413 in Hebrew.
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
Number = Optional[float]


class PdfColumn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=200)
    align: Optional[Literal["start", "end", "center", "left", "right"]] = None
    kind: Literal["text", "money", "number", "percent", "date", "datetime", "trend"] = "text"
    #: A percent column: a small bar under the value (default true).
    bar: Optional[bool] = None
    #: A group's subtotal row: "sum" or "none" (default: sum for money / number).
    agg: Optional[Literal["sum", "none"]] = None
    #: A trend column: which way is good.
    better: Optional[Literal["up", "down"]] = None


class PdfCompare(BaseModel):
    model_config = ConfigDict(extra="ignore")

    value: Number = None
    label: str = Field("", max_length=60)


class PdfKpi(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=80)
    value: Union[float, int, str, None] = None
    kind: Literal["money", "number", "percent", "text", "duration"] = "number"
    compare: Union[float, PdfCompare, None] = None
    compare_label: Optional[str] = Field(None, alias="compareLabel", max_length=60)
    spark: Optional[List[Number]] = Field(None, max_length=31)
    better: Optional[Literal["up", "down"]] = None
    icon: Optional[str] = Field(None, max_length=20)
    #: The card's small grey line under the number ("70.9%", "18 קופות").
    sub: Optional[str] = Field(None, max_length=80)


class PdfFact(BaseModel):
    """One of the header band's key facts ("תאריך", "שעות", "קופות")."""
    model_config = ConfigDict(extra="ignore")

    label: str = Field("", max_length=40)
    value: str = Field("", max_length=120)


class PdfReconCard(BaseModel):
    model_config = ConfigDict(extra="ignore")

    label: str = Field(..., min_length=1, max_length=60)
    value: Union[float, int, str, None] = None
    kind: Literal["money", "number", "percent", "text"] = "money"
    sub: str = Field("", max_length=80)
    icon: Optional[str] = Field(None, max_length=20)


class PdfReconCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")

    label: str = Field(..., min_length=1, max_length=60)
    status: Literal["match", "mismatch", "pending", "none"] = "none"
    #: What the pill says after the label (default by the status: תואם / פער / ממתין / אין נתונים).
    text: str = Field("", max_length=60)


class PdfReconcile(BaseModel):
    """The same money in two to four layers, and whether they agree (§9.2)."""
    model_config = ConfigDict(extra="ignore")

    title: str = Field("", max_length=80)
    note: str = Field("", max_length=300)
    cards: List[PdfReconCard] = Field(..., min_length=1, max_length=4)
    checks: List[PdfReconCheck] = Field(default_factory=list, max_length=4)


class PdfSeries(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field("", max_length=40)
    values: List[Number] = Field(default_factory=list, max_length=48)


class PdfChart(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["bar", "hbar", "donut", "line"]
    title: str = Field("", max_length=120)
    labels: List[Annotated[str, StringConstraints(max_length=60)]] = Field(default_factory=list, max_length=48)
    series: List[PdfSeries] = Field(default_factory=list, max_length=3)
    kind: Literal["money", "number", "percent"] = "number"


class PdfInsight(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["leader", "up", "down", "alert", "tip"] = "tip"
    text: str = Field(..., min_length=1, max_length=300)


class PdfInsightKeys(BaseModel):
    model_config = ConfigDict(extra="ignore")

    label: Optional[str] = Field(None, max_length=64)
    value: Optional[str] = Field(None, max_length=64)
    count: Optional[str] = Field(None, max_length=64)
    hour: Optional[str] = Field(None, max_length=64)
    employee: Optional[str] = Field(None, max_length=64)
    id: Optional[str] = Field(None, max_length=64)


Row = Union[Dict[str, Any], List[Any]]


class ReportPdfIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    title: str = Field(..., min_length=1, max_length=200)
    subtitle_lines: List[Line] = Field(default_factory=list, alias="subtitleLines", max_length=10)
    filter_lines: List[Line] = Field(default_factory=list, alias="filterLines", max_length=30)
    columns: List[PdfColumn] = Field(..., min_length=1, max_length=pdf.MAX_COLUMNS)
    rows: List[Row] = Field(default_factory=list)
    totals: Optional[Union[Dict[str, Any], List[Any]]] = None
    orientation: Literal["portrait", "landscape", "auto"] = "auto"
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    file_name: Optional[str] = Field(None, alias="fileName", max_length=200)
    # ── The designed report (§7.1) ──
    report_type: Optional[str] = Field(None, alias="reportType", max_length=80)
    period: Optional[str] = Field(None, max_length=200)
    scope: Optional[str] = Field(None, max_length=300)
    generated_by: Optional[str] = Field(None, alias="generatedBy", max_length=120)
    kpis: List[PdfKpi] = Field(default_factory=list, max_length=8)
    chart: Union[PdfChart, List[PdfChart], None] = None
    previous_rows: Optional[List[Row]] = Field(None, alias="previousRows")
    previous_label: Optional[str] = Field(None, alias="previousLabel", max_length=80)
    group_by: Union[Annotated[str, StringConstraints(max_length=64)], List[Annotated[str, StringConstraints(max_length=64)]], None] = Field(
        None, alias="groupBy"
    )
    insight_keys: Optional[PdfInsightKeys] = Field(None, alias="insightKeys")
    insights: List[PdfInsight] = Field(default_factory=list, max_length=5)
    no_insights: bool = Field(False, alias="noInsights")
    cover: Literal["auto", "always", "never"] = "auto"
    # ── The light design (§9) ──
    #: The header band's key facts, right to left; none: the period, the scope and the rows.
    facts: List[PdfFact] = Field(default_factory=list, max_length=6)
    #: A reconciliation section: equal cards and a ✓ / פער pill per check.
    reconcile: Optional[PdfReconcile] = None


def too_many_rows(count: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        detail=(
            f"הדוח גדול מדי לקובץ PDF: {count:,} שורות (עד {pdf.MAX_ROWS:,}). "
            "צמצמו את טווח התאריכים או את הסינון, או ייצאו ל-Excel."
        ),
    )


def _check(body: ReportPdfIn) -> None:
    if len(body.rows) > pdf.MAX_ROWS:
        raise too_many_rows(len(body.rows))
    if body.previous_rows is not None and len(body.previous_rows) > pdf.MAX_ROWS:
        raise too_many_rows(len(body.previous_rows))
    if isinstance(body.chart, list) and len(body.chart) > 3:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="chart: at most 3")
    if isinstance(body.group_by, list) and len(body.group_by) > 3:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="groupBy: at most 3 columns")
    keys = [c.key for c in body.columns]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="columns: each key once")


def _branding(db: Session, user: User, tenant_id, company_id: Optional[uuid.UUID]) -> Dict[str, Any]:
    """The business's logo, accent and name — of the company asked for, and only one the caller sees."""
    if company_id is None:
        return {}
    from app.services import report_export_defaults as access

    company = access.resolve_company(db, user, tenant_id, company_id)
    access.require_read(db, user, company)
    return pdf.company_branding(db, company)


def _document(body: ReportPdfIn, current_user: User, active_tenant_id, db: Session):
    from app.services import report_document
    from app.services.reports import resolve_report_timezone

    _check(body)
    branding = _branding(db, current_user, active_tenant_id, body.company_id)
    tz_name = resolve_report_timezone(db, active_tenant_id, None)
    return report_document.build(
        body, tz_name=tz_name, branding=branding, user_name=getattr(current_user, "username", "") or "",
    )


def pdf_response(data: bytes, name: str) -> Response:
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{quote(pdf.file_name(name))}",
            "Cache-Control": "no-store",
        },
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
    The report as a designed PDF (§7.1, light §9): the navy → blue header band with the title,
    the key facts and the business's and R2M's logos, section bars, the KPI cards, a
    reconciliation when sent, the server's insights for the report's type as pastel callouts, a
    chart, the table (navy header, zebra, group subtotals, totals, share bars, trend arrows),
    "עמוד X מתוך Y" — and a cover page past three pages. `orientation: auto` is landscape above 7
    columns. Money prints as `₪ 1,234.50`.
    """
    from app.services import report_design

    doc, _summary = _document(body, current_user, active_tenant_id, db)
    return pdf_response(report_design.render_document(doc), body.file_name or body.title)


@router.post("/insights")
def post_report_insights(
    body: ReportPdfIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """
    What the PDF of the same body would say (§7.2): `reportType`, `family`, `insights`
    (`[{type, text}]`, empty when there is nothing to say), the KPI cards with their change
    (`changePct`, `direction`, `good`) and the chart — for the Excel export's "סיכום ותובנות".
    """
    _doc, summary = _document(body, current_user, active_tenant_id, db)
    return summary
