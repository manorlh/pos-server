"""
`POST /reports/pdf` and `POST /reports/insights` (P:/specs/reports-designed-pdf.md §7.1, §7.2): the
request as a designed document — the KPI cards, the server's insights, a chart and the table.

Backward compatible: a body with only the fields the export always sent (title, sub-titles,
filters, columns, rows, totals, orientation, companyId) is the same report in the new design —
its cards made from the totals, its insights the generic ones, its chart the main measure.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services import report_design as D
from app.services import report_insights as I
from app.services import report_pdf as P

MAX_CLIENT_INSIGHTS = 5
TREND_KEY = "_trend"


def raw_rows(columns: Sequence[P.Column], rows: Sequence[Any]) -> List[List[Any]]:
    """Each row as its raw values in column order (a row may be an object by key or an array)."""
    out: List[List[Any]] = []
    for row in rows or ():
        if isinstance(row, dict):
            out.append([row.get(c.key) for c in columns])
        elif isinstance(row, (list, tuple)):
            values = list(row)
            out.append([values[i] if i < len(values) else None for i in range(len(columns))])
    return out


def _trend_column(columns: List[P.Column], rows: List[List[Any]], previous: List[List[Any]],
                  hints: Optional[Dict[str, Any]]) -> Optional[List[Optional[float]]]:
    """Each row's change against the compared period (%), when the rows can be matched."""
    roles = I.detect_roles(columns, rows, hints)
    key_i = roles.id if roles.id is not None else roles.label
    vi = roles.value
    if key_i is None or vi is None or any(c.kind == "trend" for c in columns):
        return None
    prev: Dict[str, float] = {}
    for row in previous:
        v = I._f(row[vi])
        k = P.clean(row[key_i])
        if v is not None and k:
            prev[k] = prev.get(k, 0.0) + v
    out: List[Optional[float]] = []
    for row in rows:
        v = I._f(row[vi])
        p = prev.get(P.clean(row[key_i]))
        out.append(round((v - p) / abs(p) * 100, 1) if v is not None and p else None)
    return out


def build(body: Any, *, tz_name: str, branding: Optional[Dict[str, Any]] = None, user_name: str = "",
          now: Optional[datetime] = None) -> Tuple[D.Document, Dict[str, Any]]:
    """
    The document to draw, and what `POST /reports/insights` answers (`reportType`, `family`,
    `insights`, `kpis`, `chart`). `body` is the router's validated `ReportPdfIn`.
    """
    branding = branding or {}
    col_dicts = [c.model_dump(exclude_none=True) for c in body.columns]
    columns = [P.column_of(c) for c in col_dicts]
    rows = raw_rows(columns, body.rows)
    previous = raw_rows(columns, body.previous_rows or []) if body.previous_rows else []
    hints = body.insight_keys.model_dump(exclude_none=True) if body.insight_keys else None
    rtype, family = I.resolve_type(body.report_type)

    # A trend column from the compared period, when there is room and none was sent.
    table_cols = list(col_dicts)
    table_rows: List[List[Any]] = [list(r) for r in rows]
    if previous and len(columns) < P.MAX_COLUMNS:
        trend = _trend_column(columns, rows, previous, hints)
        if trend is not None and any(t is not None for t in trend):
            table_cols.append({"key": TREND_KEY, "label": "מגמה", "kind": "trend", "agg": "none"})
            for r, t in zip(table_rows, trend):
                r.append(t)
    totals = body.totals
    if isinstance(totals, list) and len(table_cols) > len(columns):
        totals = list(totals) + [None]
    report = P.build_report(
        title=body.title, columns=table_cols, rows=table_rows, totals=totals,
        subtitle_lines=body.subtitle_lines, filter_lines=body.filter_lines, orientation=body.orientation,
        tz_name=tz_name, logo=branding.get("logo"), now=now,
    )
    cells, styles = report.rows, None
    group_by = body.group_by if isinstance(body.group_by, list) else ([body.group_by] if body.group_by else [])
    if group_by:
        cells, styles = D.grouped_rows(report.columns, report.rows, group_by)

    kpis = [D.kpi_of(k.model_dump(by_alias=True, exclude_none=True)) for k in body.kpis] if body.kpis else []
    if not kpis:
        kpis = I.auto_kpis(columns, body.totals)

    insights: List[D.Insight] = []
    if not body.no_insights:
        insights = I.table_insights(
            rtype, columns, rows, previous_rows=previous or None, previous_label=body.previous_label or "",
            kpis=kpis, hints=hints,
        )
        for extra in (body.insights or [])[:MAX_CLIENT_INSIGHTS]:
            text = P.clean(extra.text).strip()
            if text:
                insights.append(D.Insight(extra.type, text))

    charts: List[D.Chart] = []
    if "chart" in body.model_fields_set:
        given = body.chart if isinstance(body.chart, list) else ([body.chart] if body.chart is not None else [])
        for ch in given[:3]:
            made = D.chart_of(ch.model_dump())
            if made is not None:
                charts.append(made)
    else:
        made = I.default_chart(rtype, columns, rows, hints=hints, previous_rows=previous or None,
                               previous_label=body.previous_label or "")
        if made is not None:
            charts.append(made)

    subs = list(report.subtitle_lines)
    period = P.clean(body.period or "") or (subs.pop(0) if subs else "")
    scope = P.clean(body.scope or "") or (subs.pop(0) if subs else "")
    recon = D.recon_of(body.reconcile.model_dump()) if body.reconcile else None
    # The chapters, as the owner's sample has them (§9): the picture, the checks, what to know,
    # then everything.
    blocks: List[Any] = []
    if kpis:
        blocks += [D.Section("תמונת מצב", "chart"), D.KpiBlock(kpis)]
    if recon is not None:
        blocks += [D.Section("בקרה והתאמות", "shield"), recon]
    if insights:
        blocks += [D.Section("תובנות — מה חשוב לדעת", "tip_bulb"), D.InsightBlock(insights)]
    if blocks:
        blocks.append(D.Section("הפירוט המלא", "list"))
    if charts:
        blocks.append(D.ChartBlock(charts))
    blocks.append(D.Table(columns=report.columns, rows=cells, styles=styles, totals=report.totals))
    facts = [(P.clean(f.label), P.clean(f.value)) for f in body.facts if P.clean(f.label) or P.clean(f.value)]
    if not facts:
        facts = [(label, value) for label, value in (("תקופה", period), ("היקף", scope)) if value]
        if facts:
            facts.append(("שורות", P.format_number(len(rows))))
    doc = D.Document(
        title=report.title,
        period=period,
        scope=scope,
        facts=facts[:6],
        extra_lines=subs,
        filter_lines=list(report.filter_lines),
        generated_at=report.generated.replace("הופק:", "").strip(),
        generated_by=P.clean(body.generated_by or user_name or ""),
        business_name=P.clean(branding.get("name") or ""),
        logo=branding.get("logo"),
        accent=branding.get("accent") or D.DEFAULT_ACCENT,
        orientation=body.orientation,
        cover=body.cover,
        blocks=blocks,
    )
    summary = {
        "reportType": rtype,
        "family": family,
        "insights": [i.as_json() for i in insights],
        "kpis": [k.as_json() for k in kpis],
        "chart": charts[0].as_json() if charts else None,
    }
    return doc, summary
