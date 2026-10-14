"""
The designed report (P:/specs/reports-designed-pdf.md §1, §5, contract §7): `POST /reports/pdf`
and `POST /reports/insights`, the insight generator (app/services/report_insights.py), the day
summary v2 (`GET /reports/day-summary?date=`, `/pdf`) and products by day (§8).

What must never go wrong:

* every report type the dashboard sends draws a valid PDF — Hebrew in visual order, its KPI
  cards, a chart, the table across pages with the cover past three — and a body of the old
  shape still does;
* an insight is said only when the figures carry it: an empty or flat report has no box;
* the day summary's figures are the documents' (the reports' rules), against the right days,
  and its scope only narrows — a company with no shop picked is that company, not everything.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
import zlib
from datetime import timedelta
from decimal import Decimal

import pytest

import day_summary_world as DW
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import report_pdf as pdf_router
from app.routers import reports as reports_router
from app.services import day_summary as DS
from app.services import products_by_day as PB
from app.services import report_design as D
from app.services import report_insights as I
from app.services import report_pdf as P
from shift_world import NOW, TODAY, make_world

REG = P._Font(P._truetype(False), "F1")
BOLD = P._Font(P._truetype(True), "F2")
ROOT = pathlib.Path(__file__).resolve().parents[2]


def _ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def _streams(data: bytes):
    out = []
    for m in re.finditer(rb"<<(.*?)>>\nstream\n", data, re.S):
        length = int(re.search(rb"/Length (\d+)", m.group(1)).group(1))
        raw = data[m.end(): m.end() + length]
        out.append(zlib.decompress(raw) if b"/FlateDecode" in m.group(1) else raw)
    return out


def _pages(data: bytes):
    """The page content streams (not the fonts', the logo's or the R2M form's)."""
    return [s for s in _streams(data) if b" Tf " in s and b"beginbfchar" not in s]


def _has(content: bytes, text: str, *, bold: bool = False) -> bool:
    font = BOLD if bold else REG
    return font.encode(P.visual(text)).encode() in content


def _valid(data: bytes) -> None:
    assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF")
    assert b"/FontFile2" in data and b"/ToUnicode" in data and b"/Identity-H" in data
    assert P.page_count(data) >= 1


@pytest.fixture(scope="module")
def world():
    return make_world()


def _post(w, body, user=None):
    return pdf_router.post_report_pdf(pdf_router.ReportPdfIn.model_validate(body), **_ctx(w, user))


def _insights(w, body, user=None):
    return pdf_router.post_report_insights(pdf_router.ReportPdfIn.model_validate(body), **_ctx(w, user))


# ── Bodies per family ────────────────────────────────────────────────────────


def body_for(report_type, family, rows=8):
    if family == I.HOURLY:
        columns = [{"key": "hour", "label": "שעה"}, {"key": "net", "label": "מכירות נטו", "kind": "money"},
                   {"key": "documents", "label": "עסקאות", "kind": "number"}]
        data = [[f"{h:02d}:00", 100 + (h - 8) * 37 % 300, 3 + h % 5] for h in range(8, 8 + max(rows, 4))]
    elif family == I.TIMELINE:
        columns = [{"key": "day", "label": "יום", "kind": "date"}, {"key": "net", "label": "מכירות נטו", "kind": "money"},
                   {"key": "documents", "label": "עסקאות", "kind": "number"}]
        data = [[(TODAY - timedelta(days=i)).isoformat(), 1000 + i * 113 % 700, 40 + i] for i in range(rows)]
    elif family == I.PEOPLE:
        columns = [{"key": "cashierName", "label": "קופאי"}, {"key": "net", "label": "נטו", "kind": "money"},
                   {"key": "refunds", "label": "זיכויים", "kind": "money"}, {"key": "documents", "label": "מסמכים", "kind": "number"}]
        data = [[f"עובד {i}", 900 + i * 70, 10 + (300 if i == 2 else 0), 30 + i] for i in range(rows)]
    elif family == I.RISK:
        columns = [{"key": "name", "label": "קופה"}, {"key": "amount", "label": "סכום", "kind": "money"},
                   {"key": "variance", "label": "הפרש", "kind": "money"}]
        data = [[f"קופה {i}", 500 + i * 40, (-80 if i == 1 else 2)] for i in range(rows)]
    elif family == I.MIX:
        columns = [{"key": "method", "label": "אמצעי תשלום"}, {"key": "amount", "label": "סכום", "kind": "money"},
                   {"key": "share", "label": "%", "kind": "percent"}]
        data = [[n, v, v / 50] for n, v in (("אשראי", 3100), ("מזומן", 1200), ("שובר", 400), ("ביט", 300))]
    else:
        columns = [{"key": "productName", "label": "מוצר"}, {"key": "unitsNet", "label": "כמות", "kind": "number"},
                   {"key": "net", "label": "נטו", "kind": "money"}, {"key": "share", "label": "% מהמכירות", "kind": "percent"}]
        data = [[f"מוצר {i}", 50 - i * 3, 2400 / (i + 1), 30 / (i + 1)] for i in range(rows)]
    body = {"title": "דוח בדיקה", "subtitleLines": ["01.10.2026 – 14.10.2026", "Acme › סניף מרכז"],
            "columns": columns, "rows": data}
    if report_type is not None:
        body["reportType"] = report_type
    return body


ALL_TYPES = sorted(I.FAMILY_OF)


class TestEveryReportType:
    @pytest.mark.parametrize("report_type", ALL_TYPES + [None, "something-unknown"])
    def test_a_valid_hebrew_pdf_with_its_chart(self, world, report_type):
        rtype, family = I.resolve_type(report_type)
        body = body_for(report_type, family)
        resp = _post(world, body)
        data = resp.body
        _valid(data)
        content = b"\n".join(_pages(data))
        assert _has(content, "דוח בדיקה", bold=True)
        assert _has(content, "עמוד 1 מתוך 1")
        summary = _insights(world, body)
        assert summary["reportType"] == rtype and summary["family"] == family
        assert summary["chart"] is not None, report_type
        assert _has(content, summary["chart"]["title"], bold=True)
        assert all(i["type"] in D.INSIGHT_TYPES and i["text"] for i in summary["insights"])

    def test_every_type_the_dashboard_sends_resolves(self):
        fixture = json.loads((pathlib.Path(__file__).parent / "fixtures" / "report_types_client.json").read_text("utf-8"))
        names = list(fixture["reportKeys"]) + list(fixture["reportTypes"])
        live = ROOT / "client" / "src" / "lib" / "reportPages.ts"
        if live.exists():  # once the dashboard's list is beside this server, it is read too
            for m in re.finditer(r"reportKeys:\s*\[([^\]]*)\]", live.read_text("utf-8")):
                names += re.findall(r"'([^']+)'", m.group(1))
        unresolved = [n for n in names if I.resolve_type(n)[1] == I.GENERIC]
        assert unresolved == []

    def test_types_resolve_exactly_by_alias_by_sub_type_and_else_generic(self):
        assert I.resolve_type("product-sales") == ("product-sales", I.RANKING)
        assert I.resolve_type("promotions-report") == ("promotions", I.RANKING)
        assert I.resolve_type("menu-reports.modifiers") == ("menu-reports", I.RANKING)
        assert I.resolve_type("prepaid-vouchers.settlement") == ("prepaid-vouchers", I.RANKING)
        assert I.resolve_type("prepaid-vouchers-reports.settlement") == ("prepaid-vouchers", I.RANKING)
        assert I.resolve_type("Cashier-Sales") == ("cashier-sales", I.PEOPLE)
        assert I.resolve_type(None) == ("generic", I.GENERIC)
        assert I.resolve_type("nonsense") == ("generic", I.GENERIC)


class TestTheDesign:
    def test_kpis_insights_chart_and_table_on_the_first_page(self, world):
        body = body_for("product-sales", I.RANKING, rows=12)
        body.update(
            kpis=[{"key": "net", "label": "מכירות נטו", "value": 23410.5, "kind": "money", "compare": 21000,
                   "compareLabel": "שבוע שעבר", "spark": [1, 2, 3, 2, 4, 5, 6]},
                  {"key": "refunds", "label": "זיכויים", "value": 400, "kind": "money", "compare": {"value": 100}}],
            totals={"net": 9000},
        )
        data = _post(world, body).body
        first = _pages(data)[0]
        assert _has(first, "מכירות נטו") and _has(first, "₪ 23,410", bold=True)
        assert _has(first, "11.5%", bold=True)  # the change chip
        assert _has(first, "תובנות", bold=True)
        assert _has(first, "מוצר", bold=True)  # the table's header
        assert b"/R2M" in first  # the R2M pixel logo, in the band and the footer
        summary = _insights(world, body)
        net, refunds = summary["kpis"]
        assert (net["changePct"], net["direction"], net["good"]) == (11.48, "up", True)
        # Refunds are better down: up is bad news.
        assert (refunds["direction"], refunds["good"]) == ("up", False)
        assert any(i["type"] == "alert" and "זיכויים" in i["text"] for i in summary["insights"])

    def test_a_chart_null_is_no_chart_and_an_absent_one_is_the_default(self, world):
        body = body_for("product-sales", I.RANKING)
        default = _insights(world, body)["chart"]
        assert default["type"] == "hbar"
        body_null = dict(body, chart=None)
        assert _insights(world, body_null)["chart"] is None
        assert not _has(b"\n".join(_pages(_post(world, body_null).body)), default["title"], bold=True)
        given = dict(body, chart={"type": "donut", "title": "פילוח שלי", "labels": ["א", "ב"],
                                  "series": [{"values": [3, 1]}], "kind": "number"})
        assert _insights(world, given)["chart"]["title"] == "פילוח שלי"
        assert _has(b"\n".join(_pages(_post(world, given).body)), "פילוח שלי", bold=True)

    def test_more_than_three_pages_get_a_cover(self, world):
        body = body_for("product-sales", I.RANKING, rows=400)
        body["totals"] = {"net": 1, "unitsNet": 2}
        data = _post(world, body).body
        pages = _pages(data)
        assert P.page_count(data) == len(pages) > 4
        cover = pages[0]
        assert _has(cover, "דוח בדיקה", bold=True) and _has(cover, "עיקרי הדוח", bold=True)
        assert not _has(cover, "% מהמכירות", bold=True)  # no table on the cover
        n = len(pages)
        assert _has(cover, f"עמוד 1 מתוך {n}") and _has(pages[-1], f"עמוד {n} מתוך {n}")
        # The column headers again on every table page.
        assert all(_has(p, "% מהמכירות", bold=True) for p in pages[1:])
        assert P.page_count(_post(world, dict(body, cover="never")).body) == n - 1

    def test_group_subtotals_trend_and_percent_bars(self, world):
        body = {
            "title": "לפי סניף", "reportType": "area-sales", "groupBy": ["shop"],
            "columns": [{"key": "shop", "label": "סניף"}, {"key": "area", "label": "נקודת מכירה"},
                        {"key": "net", "label": "נטו", "kind": "money"}, {"key": "share", "label": "%", "kind": "percent"},
                        {"key": "trend", "label": "מגמה", "kind": "trend"}],
            "rows": [["מרכז", "בר", 100, 40, 12.5], ["צפון", "ראשי", 50, 20, -3], ["מרכז", "טרסה", 100, 40, 0]],
        }
        cells, styles = D.grouped_rows([P.column_of(c) for c in body["columns"]],
                                       [[P.format_cell(v, c["kind"] if "kind" in c else "text") for v, c in zip(r, body["columns"])]
                                        for r in body["rows"]], ["shop"])
        assert styles == ["row", "row", "sub", "row", "sub"]
        assert cells[1][0] == "" and cells[2][0] == "סה״כ מרכז" and cells[2][2] == "₪ 200.00"
        content = b"\n".join(_pages(_post(world, body).body))
        assert _has(content, "סה״כ מרכז", bold=True) and _has(content, "₪ 200.00", bold=True)
        assert _has(content, "12.5%") and _has(content, "3%")  # the trend, its sign as an arrow

    def test_previous_rows_add_a_trend_column_and_the_change_sentences(self, world):
        body = body_for("product-sales", I.RANKING, rows=6)
        body["previousRows"] = [[f"מוצר {i}", 40, 2400 / (i + 1) * (0.5 if i == 3 else 1.1), 1] for i in range(6)]
        body["previousLabel"] = "שבוע שעבר"
        summary = _insights(world, body)
        texts = " | ".join(i["text"] for i in summary["insights"])
        assert "העלייה הגדולה: מוצר 3" in texts
        content = b"\n".join(_pages(_post(world, body).body))
        assert _has(content, "מגמה", bold=True)

    def test_the_business_branding_colours_the_report(self, world, monkeypatch):
        from PIL import Image

        world.company.settings = {"brandLogoUrl": "https://cdn.example.com/l.png", "brandPrimaryColor": "#E11D48"}
        world.db.commit()
        monkeypatch.setattr(P, "load_logo", lambda url: Image.new("RGB", (100, 40), "white"))
        data = _post(world, dict(body_for("generic", I.GENERIC), companyId=str(world.company.id))).body
        assert b"/Subtype /Image" in data
        assert b"0.882 0.114 0.282 rg" in b"\n".join(_pages(data))  # the accent stripe
        world.company.settings = {}
        world.db.commit()


class TestBackwardCompatible:
    def test_the_old_body_still_makes_its_report(self, world):
        body = {"title": "מכירות לפי מוצר", "subtitleLines": ["x"], "filterLines": ["קופאי: דנה"],
                "columns": [{"key": "name", "label": "שם"}, {"key": "net", "label": "נטו", "kind": "money"}],
                "rows": [{"name": "תה", "net": 9.5}, {"name": "קפה", "net": 12}], "totals": {"net": 21.5},
                "orientation": "auto", "fileName": "x", "somethingNew": 1}
        resp = _post(world, body)
        _valid(resp.body)
        content = b"\n".join(_pages(resp.body))
        assert _has(content, "₪ 21.50", bold=True)  # the totals row (and its card)
        assert _has(content, "קופאי: דנה")

    def test_validation_and_limits(self, world):
        from fastapi import HTTPException
        from pydantic import ValidationError

        base = body_for(None, I.GENERIC)
        for bad in ({"kpis": [{"key": "k"}] * 9}, {"chart": {"type": "pie"}}, {"cover": "maybe"},
                    {"insights": [{"type": "boast", "text": "x"}]}, {"columns": [{"key": "a", "kind": "image"}]}):
            with pytest.raises(ValidationError):
                pdf_router.ReportPdfIn.model_validate({**base, **bad})
        with pytest.raises(HTTPException) as e:
            _post(world, {**base, "groupBy": ["a", "b", "c", "d"]})
        assert e.value.status_code == 422
        with pytest.raises(HTTPException) as e:
            _post(world, {**base, "previousRows": [[1]] * (P.MAX_ROWS + 1)})
        assert e.value.status_code == 413

    def test_the_new_routes_are_for_signed_in_users(self):
        from fastapi.testclient import TestClient

        from app.main import app

        client = TestClient(app)
        assert client.post("/api/v1/reports/insights", json={"title": "x", "columns": [{"key": "a"}]}).status_code in (401, 403)
        for path in ("/api/v1/reports/day-summary/pdf", "/api/v1/reports/products-by-day?from=2026-10-01&to=2026-10-02"):
            assert client.get(path).status_code in (401, 403)


# ── The insight generator ────────────────────────────────────────────────────


def _cols(*specs):
    return [P.column_of({"key": k, "label": l, "kind": kind}) for k, l, kind in specs]


PRODUCTS = _cols(("name", "מוצר", "text"), ("units", "כמות", "number"), ("net", "נטו", "money"))


class TestInsights:
    def test_nothing_to_say_is_nothing(self):
        assert I.table_insights("product-sales", PRODUCTS, []) == []
        assert I.table_insights("product-sales", PRODUCTS, [["קפה", 1, 10]]) == []
        assert I.table_insights(None, PRODUCTS, [["קפה", 0, 0], ["תה", 0, 0]]) == []
        # A KPI that did not move is no sentence either.
        flat = D.Kpi("net", "מכירות", 100, "money", compare=101)
        assert I.table_insights(None, PRODUCTS, [], kpis=[flat]) == []

    def test_no_box_in_the_pdf_when_nothing_is_said(self, world):
        body = {"title": "ריק", "columns": [{"key": "a", "label": "א"}], "rows": []}
        assert _insights(world, body)["insights"] == []
        assert not _has(b"\n".join(_pages(_post(world, body).body)), "תובנות", bold=True)

    def test_the_leader_and_its_share(self):
        rows = [["קפה", 10, 600], ["תה", 5, 300], ["מאפה", 2, 100]]
        out = I.table_insights("product-sales", PRODUCTS, rows)
        assert out[0].type == "leader" and out[0].text == "במקום הראשון: קפה — ₪ 600, 60% מהסה״כ"

    def test_concentration_of_the_top_fifth(self):
        rows = [["א", 1, 800]] + [[f"פריט {i}", 1, 25] for i in range(8)]
        texts = [i.text for i in I.table_insights("product-sales", PRODUCTS, rows)]
        assert any(t.startswith("ריכוזיות: 2 מתוך 9 הפריטים (20% המובילים) מביאים 82% מהמכירות") for t in texts)

    def test_risers_fallers_and_the_total_against_the_previous_period(self):
        rows = [["קפה", 10, 600], ["תה", 5, 100], ["מאפה", 2, 300]]
        prev = [["קפה", 10, 400], ["תה", 5, 300], ["מאפה", 2, 300]]
        texts = [i.text for i in I.table_insights("product-sales", PRODUCTS, rows, previous_rows=prev, previous_label="שבוע שעבר")]
        assert "העלייה הגדולה: קפה — מ-₪ 400 ל-₪ 600 (50%)" in texts
        assert "הירידה הגדולה: תה — מ-₪ 300 ל-₪ 100 (67%)" in texts
        # 1,000 against 1,000: no total sentence.
        assert not any(t.startswith("סה״כ") for t in texts)
        gone = I.table_insights("product-sales", PRODUCTS, [["קפה", 1, 50], ["תה", 1, 40]],
                                previous_rows=[["קפה", 1, 50], ["תה", 1, 40], ["סלט", 1, 90]])
        assert any(i.type == "alert" and i.text.startswith("ללא מכירות הפעם: סלט") for i in gone)

    def test_an_outlier_by_the_median_and_its_absolute_deviation(self):
        cols = _cols(("cashier", "קופאי", "text"), ("net", "נטו", "money"))
        rows = [["דנה", 1000], ["יוסי", 1050], ["מיכל", 980], ["אבי", 1020], ["רוני", 4000]]
        out = I.table_insights("cashier-sales", cols, rows)
        assert any(i.type == "alert" and i.text == "חריג: רוני — ₪ 4,000, מול חציון של ₪ 1,020" for i in out)
        # Within the usual spread: no outlier.
        calm = [["דנה", 1000], ["יוסי", 1100], ["מיכל", 950], ["אבי", 1020], ["רוני", 1080]]
        assert not any(i.text.startswith("חריג") for i in I.table_insights("cashier-sales", cols, calm))

    def test_peak_and_low_hours(self):
        cols = _cols(("hour", "שעה", "text"), ("net", "נטו", "money"))
        rows = [["08:00", 100], ["12:00", 900], ["13:00", 500], ["21:00", 40]]
        texts = [i.text for i in I.table_insights("hourly-sales", cols, rows)]
        assert "שעת השיא: 12:00–13:00 — ₪ 900 (58% מהמכירות)" in texts[0]
        assert "השעה החלשה: 21:00–22:00 — ₪ 40" in texts

    def test_risks_above_the_reports_own_rate_and_untransmitted(self):
        cols = _cols(("cashier", "קופאי", "text"), ("net", "נטו", "money"), ("refunds", "זיכויים", "money"))
        rows = [["דנה", 1000, 10], ["יוסי", 1000, 12], ["מיכל", 1000, 200]]
        out = I.table_insights("cashier-sales", cols, rows)
        assert any(i.type == "alert" and i.text.startswith("מיכל: זיכויים ₪ 200 — 20% מהמכירות") for i in out)
        cols2 = _cols(("till", "קופה", "text"), ("net", "נטו", "money"), ("untransmitted", "אשראי לא משודר", "money"))
        out2 = I.table_insights("transmissions", cols2, [["1", 100, 0], ["2", 100, 35]])
        assert out2[0].type == "alert" and out2[0].text == "אשראי לא משודר: ₪ 35 — יש לבדוק"

    def test_targets_met(self):
        cols = _cols(("name", "יעד", "text"), ("target", "יעד ₪", "money"), ("achieved", "עמידה ביעד", "percent"))
        out = I.table_insights("targets", cols, [["מרכז", 1000, 120], ["צפון", 1000, 60], ["דרום", 1000, 100]])
        texts = [i.text for i in out]
        assert "2 מתוך 3 עמדו ביעד" in texts and "הכי רחוק מהיעד: צפון — 60%" in texts

    def test_at_most_seven_best_first(self):
        cols = _cols(("cashier", "קופאי", "text"), ("net", "נטו", "money"), ("refunds", "זיכויים", "money"),
                     ("discounts", "הנחות", "money"))
        rows = [[f"עובד {i}", 1000 + i, 5, 5] for i in range(10)] + [["חריג", 9000, 900, 900]]
        kpis = [D.Kpi("net", "נטו", 200, "money", compare=100), D.Kpi("refunds", "זיכויים", 300, "money", compare=100)]
        out = I.table_insights("cashier-sales", cols, rows, kpis=kpis)
        assert 3 <= len(out) <= I.MAX_INSIGHTS


# ── The day summary v2 ───────────────────────────────────────────────────────


@pytest.fixture
def dw():
    return DW.build()


def _day(dw, user=None, **scope):
    return DS.build(dw.db, user or dw.admin, dw.tenant.id, day=TODAY, tz="Asia/Jerusalem",
                    scope=DS.Scope(**scope) if scope else DS.Scope(company_id=dw.company.id))


def _kpi(data, key):
    return next(k for k in data["kpis"] if k["key"] == key)


def _user(dw, role, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=dw.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
             username=uuid.uuid4().hex[:8], **kw)
    dw.db.add(u)
    dw.db.commit()
    return u


class TestDaySummaryFigures:
    def test_the_kpis_are_the_documents_of_the_business_day(self, dw):
        data = _day(dw)
        assert data["version"] == 2 and data["date"] == TODAY.isoformat() and not data["empty"]
        figures = {k["key"]: k["value"] for k in data["kpis"]}
        # 216 gross − 22 discounts − 38 refunds; 02:30 is still the day, 04:30 the next one;
        # the cancelled sale and Beta's shop count nowhere.
        assert figures == {
            "net": 156.0, "gross": 216.0, "documents": 6, "averageTicket": 32.33, "items": 16.0, "covers": 3,
            "perCover": 20.0, "refunds": 38.0, "voids": 9.0, "discounts": 22.0, "oth": 14.0, "tips": 5.0,
        }
        assert [_kpi(data, k)["count"] for k in ("refunds", "voids", "discounts", "oth")] == [1, 1, 2, 1]
        start = data["businessDay"]
        assert (start["startHour"], start["start"]) == (4, "2026-09-27T01:00:00+00:00")

    def test_against_last_week_and_the_four_weeks_average(self, dw):
        data = _day(dw)
        net = _kpi(data, "net")
        assert data["compare"] == {"lastWeek": "2026-09-20", "weeks": ["2026-09-20", "2026-09-13", "2026-09-06", "2026-08-30"]}
        # Last week 48 + 14; the four weeks: 62, 120 (60 − 20 + 80), 72 (76 − 4), 140.
        assert (net["lastWeek"], net["avg4w"], net["changePct"], net["changePctAvg"]) == (62.0, 98.5, 151.61, 58.38)
        assert net["spark"] == [0, 0, 0, 0, 0, 0, 156.0] and net["sparkDays"][-1] == TODAY.isoformat()
        assert _kpi(data, "documents")["avg4w"] == 1.5
        assert _kpi(data, "refunds")["better"] == "down"

    def test_hours_against_last_week_in_business_day_order(self, dw):
        hours = _day(dw)["hourly"]
        assert [h["hour"] for h in hours[:2]] == [4, 5] and hours[-1]["hour"] == 3 and len(hours) == 24
        got = {h["hour"]: (h["net"], h["lastWeekNet"]) for h in hours if h["net"] or h["lastWeekNet"]}
        assert got == {10: (38.0, 0.0), 11: (0.0, 48.0), 12: (28.0, 14.0), 13: (112.0, 0.0), 20: (-38.0, 0.0), 2: (16.0, 0.0)}

    def test_shop_point_of_sale_till_adds_up(self, dw):
        tree = _day(dw)["hierarchy"]
        assert [(r["level"], r["name"], r["net"]) for r in tree] == [
            ("shop", "סניף מרכז", 128.0), ("area", "בר", 52.0), ("till", "קופה ראשית (1)", 52.0),
            ("area", "טרסה", 76.0), ("till", "קופת טרסה (2)", 76.0), ("shop", "סניף צפון", 28.0),
            ("till", "קופה צפון (3)", 28.0),
        ]
        assert sum(r["net"] for r in tree if r["level"] == "shop") == 156.0
        center = tree[0]
        assert (center["share"], center["lastWeekNet"], center["changePct"]) == (82.05, 48.0, 166.67)

    def test_payments_departments_items_and_movers(self, dw):
        data = _day(dw)
        assert [(p["label"], p["amount"], p["documents"]) for p in data["paymentMethods"]] == [("אשראי", 112.0, 3), ("מזומן", 44.0, 4)]
        assert [(d["name"], d["units"], d["net"]) for d in data["departments"]] == [("שתייה", 10.0, 128.0), ("מאפים", 3.0, 28.0)]
        assert [(i["name"], i["units"], i["net"], i["lastWeekNet"]) for i in data["topItems"]] == [
            ("קפה הפוך", 6.0, 72.0, 48.0), ("מיץ תפוזים", 4.0, 56.0, 0.0), ("קרואסון חמאה", 3.0, 28.0, 14.0)]
        assert [m["name"] for m in data["risers"]] == ["מיץ תפוזים", "קפה הפוך", "קרואסון חמאה"] and data["fallers"] == []

    def test_tables_staff_and_risks(self, dw):
        data = _day(dw)
        t = data["tables"]
        assert {k: t[k] for k in ("opened", "paid", "cancelled", "stillOpen", "guests", "averageSeatedMinutes",
                                  "averagePerTable", "averagePerCover")} == {
            "opened": 3, "paid": 1, "cancelled": 1, "stillOpen": 1, "guests": 7, "averageSeatedMinutes": 90.0,
            "averagePerTable": 60.0, "averagePerCover": 20.0}
        assert t["open"][0]["name"] == "שולחן 2" and t["open"][0]["waiter"] == "יוסי לוי"
        staff = {s["name"]: (s["net"], s["hours"]) for s in data["staff"]}
        assert staff == {"יוסי לוי": (76.0, None), "דנה כהן": (52.0, 8.0), "מיכל פרץ": (28.0, None)}
        r = data["risks"]
        people = {p["name"]: p for p in r["byEmployee"]}
        dana = people["דנה כהן"]
        assert (dana["refunds"], dana["refundsCount"], dana["discounts"], dana["oth"], dana["tableCancels"], dana["drawerOpens"]) == (
            38.0, 1, 22.0, 14.0, 1, 1)
        assert (people["יוסי לוי"]["voids"], people["יוסי לוי"]["voidsCount"]) == (9.0, 1)
        assert (r["untransmittedCard"]["count"], r["untransmittedCard"]["amount"]) == (1, 12.0)
        assert r["drawerOpensNoSale"] == 1 and r["cancelledDocuments"] == {"count": 1, "amount": 126.0}
        assert {(e["type"], e["count"]) for e in r["exceptions"]} == {("discount", 1), ("refund", 1)}
        assert data["kiosks"] is None

    def test_the_days_insights(self, dw):
        texts = [i["text"] for i in _day(dw)["insights"]]
        assert "עסקת אשראי אחת לא שודרה (₪ 12) — יש לשדר מהקופה" in texts
        assert "שולחן אחד נשאר פתוח בסוף היום" in texts
        assert "מכירות נטו: עלייה של 152% מול שבוע שעבר (מ-₪ 62 ל-₪ 156)" in texts
        assert len(texts) <= I.MAX_INSIGHTS

    def test_a_day_with_nothing_is_empty_and_says_nothing(self, dw):
        data = DS.build(dw.db, dw.admin, dw.tenant.id, day=TODAY + timedelta(days=40), tz="Asia/Jerusalem",
                        scope=DS.Scope(company_id=dw.company.id))
        assert data["empty"] and data["insights"] == [] and _kpi(data, "net")["value"] == 0.0


class TestDaySummaryScope:
    def test_a_company_with_no_shop_picked_is_that_company(self, dw):
        assert _kpi(_day(dw), "net")["value"] == 156.0
        everything = DS.build(dw.db, dw.admin, dw.tenant.id, day=TODAY, tz="Asia/Jerusalem", scope=DS.Scope())
        assert _kpi(everything, "net")["value"] == 216.0
        beta = _day(dw, company_id=dw.beta.id)
        assert _kpi(beta, "net")["value"] == 60.0 and [r["name"] for r in beta["hierarchy"]] == ["סניף דרום", "קופה דרום (9)"]

    def test_shops_areas_and_tills_narrow(self, dw):
        north, (till1, till2) = dw.other_shop, dw.tills
        assert _kpi(_day(dw, company_id=dw.company.id, shop_ids=[north.id]), "net")["value"] == 28.0
        assert _kpi(_day(dw, company_id=dw.company.id, area_ids=[dw.bar.id]), "net")["value"] == 52.0
        assert _kpi(_day(dw, company_id=dw.company.id, area_ids=["none"]), "net")["value"] == 28.0
        assert _kpi(_day(dw, company_id=dw.company.id, machine_ids=[till2.id]), "net")["value"] == 76.0
        contradiction = _day(dw, shop_ids=[north.id], machine_ids=[till1.id])
        assert contradiction["empty"] and _kpi(contradiction, "net")["value"] == 0.0

    def test_the_role_bounds_it_and_a_filter_never_widens_it(self, dw):
        manager = _user(dw, UserRole.SHOP_MANAGER, shop_id=dw.shop.id)
        assert _kpi(DS.build(dw.db, manager, dw.tenant.id, day=TODAY, scope=DS.Scope()), "net")["value"] == 128.0
        assert _kpi(DS.build(dw.db, manager, dw.tenant.id, day=TODAY, scope=DS.Scope(shop_ids=[dw.other_shop.id])),
                    "net")["value"] == 0.0
        cm = _user(dw, UserRole.COMPANY_MANAGER, company_id=dw.company.id)
        assert _kpi(DS.build(dw.db, cm, dw.tenant.id, day=TODAY, scope=DS.Scope()), "net")["value"] == 156.0
        assert _kpi(DS.build(dw.db, cm, dw.tenant.id, day=TODAY, scope=DS.Scope(company_id=dw.beta.id)), "net")["value"] == 0.0

    def test_the_route_answers_v2_with_a_date_and_the_z_roll_up_with_from_to(self, dw):
        args = dict(tz="Asia/Jerusalem", company_id=dw.company.id, shop_ids=None, area_ids=None, machine_ids=None)
        v2 = reports_router.get_day_summary_report(day=TODAY, from_date=None, to_date=None, **args, **_ctx(dw))
        assert v2["version"] == 2 and _kpi(v2, "net")["value"] == 156.0
        for shop, machine, net in ((dw.shop, dw.tills[0], "300"), (dw.south, dw.south_till, "500")):
            dw.db.add(ZReport(id=uuid.uuid4(), tenant_id=dw.tenant.id, shop_id=shop.id, machine_id=machine.id,
                              business_date=TODAY, closed_at=NOW, total_sales=Decimal(net), total_refunds=Decimal("0"),
                              transactions_count=3))
        dw.db.commit()
        legacy = reports_router.get_day_summary_report(day=None, from_date=TODAY, to_date=TODAY, **args, **_ctx(dw))
        # The company's Z only — not "everything the role sees" — with no shop picked.
        assert legacy.totals.sales == 300.0
        args["company_id"] = None
        assert reports_router.get_day_summary_report(day=None, from_date=TODAY, to_date=TODAY, **args, **_ctx(dw)).totals.sales == 800.0

    def test_the_pdf(self, dw, monkeypatch):
        resp = reports_router.get_day_summary_pdf(
            day=TODAY, tz="Asia/Jerusalem", company_id=dw.company.id, shop_ids=None, area_ids=None, machine_ids=None,
            **_ctx(dw),
        )
        data = resp.body
        _valid(data)
        assert "filename*=UTF-8''" in resp.headers["content-disposition"]
        pages = _pages(data)
        assert P.page_count(data) == len(pages) >= 4
        all_text = b"\n".join(pages)
        assert _has(pages[0], "סיכום יום", bold=True) and _has(pages[0], "עיקרי הדוח", bold=True)  # the cover
        for title in ("מדדי היום", "תובנות היום", "מכירות לפי שעה", "אמצעי תשלום", "השוואות", "מחלקות", "שולחנות",
                      "עובדים", "סיכונים", "לפי עובד"):
            assert _has(all_text, title, bold=True), title
        assert _has(all_text, "סניף מרכז", bold=True)  # a shop row of the tree, bold
        assert _has(all_text, "Acme קפה בע״מ")  # the scope


# ── Products by day ──────────────────────────────────────────────────────────


def _window(dw, back, end=TODAY):
    from app.services.reports import resolve_report_window

    return resolve_report_window(dw.db, dw.tenant.id, from_date=end - timedelta(days=back), to_date=end, tz="Asia/Jerusalem")


class TestProductsByDay:
    def test_the_days_and_the_summary_equal_the_product_report(self, dw):
        from app.services.reports import build_product_sales_report

        w = _window(dw, 7)
        data = PB.build(dw.db, dw.admin, dw.tenant.id, w, scope=DS.Scope(company_id=dw.company.id))
        assert [d["date"] for d in data["days"]][0] == (TODAY - timedelta(days=7)).isoformat() and len(data["days"]) == 8
        by_date = {d["date"]: d for d in data["days"]}
        # Calendar days, as the product report: 02:30 after the day is the next calendar day.
        assert by_date[TODAY.isoformat()]["net"] == 140.0 and by_date[(TODAY - timedelta(days=7)).isoformat()]["net"] == 62.0
        report = build_product_sales_report(dw.db, dw.admin, dw.tenant.id, w, company_id=dw.company.id)
        assert data["summary"]["totals"]["net"] == round(report.totals.net, 2)
        assert data["summary"]["totals"]["units"] == round(report.totals.units_net, 3)
        today = by_date[TODAY.isoformat()]
        assert [p["name"] for p in today["products"]][0] == "קפה הפוך"  # by quantity
        assert round(sum(p["share"] for p in today["products"]), 1) == 100.0
        coffee = next(p for p in data["summary"]["products"] if p["name"] == "קפה הפוך")
        assert (coffee["daysSold"], coffee["averagePerDay"]) == (2, round(coffee["units"] / 8, 2))
        assert data["matrix"]["grouping"] == "day" and len(data["matrix"]["columns"]) == 8
        # Against the day before — which sold nothing: no percentage from zero.
        assert by_date[TODAY.isoformat()]["changePct"] is None

    def test_options_departments_amounts_hidden_days_and_weeks(self, dw):
        w = _window(dw, 20)
        data = PB.build(dw.db, dw.admin, dw.tenant.id, w, scope=DS.Scope(company_id=dw.company.id),
                        category_ids=[dw.drinks.id], amounts=False, hide_empty_days=True, sort="amount")
        names = {p["name"] for p in data["summary"]["products"]}
        assert names == {"קפה הפוך", "מיץ תפוזים"}
        assert all(d["items"] or d["documents"] for d in data["days"]) and len(data["days"]) < 21
        assert "net" not in {k["key"] for k in data["kpis"]}
        assert data["matrix"]["grouping"] == "day"  # the shown days are under 15
        weekly = PB.build(dw.db, dw.admin, dw.tenant.id, w, scope=DS.Scope(company_id=dw.company.id))
        assert weekly["matrix"]["grouping"] == "week" and len(weekly["days"]) == 21
        assert weekly["matrix"]["columns"][0]["label"].count("–") == 1

    def test_nothing_sold_says_nothing(self, dw):
        w = _window(dw, 5, end=TODAY + timedelta(days=60))
        data = PB.build(dw.db, dw.admin, dw.tenant.id, w, scope=DS.Scope(company_id=dw.company.id))
        assert data["insights"] == [] and data["summary"]["products"] == []

    def test_the_pdf_a_section_per_day_and_the_summary(self, dw):
        resp = reports_router.get_products_by_day_pdf(
            from_date=TODAY - timedelta(days=14), to_date=TODAY, tz="Asia/Jerusalem", company_id=dw.company.id,
            shop_ids=None, area_ids=None, machine_ids=None, category_ids=None, amounts=True, hide_empty_days=False,
            sort="qty", meals="components", **_ctx(dw),
        )
        _valid(resp.body)
        text = b"\n".join(_pages(resp.body))
        for title in ("מכירות לפי יום", "סיכום כל הימים יחד", "מוצר × שבוע (כמויות)"):
            assert _has(text, title, bold=True), title
        assert _has(text, PB.day_label(TODAY), bold=True)
        assert P.page_count(resp.body) > 3

    def test_from_and_to_are_required(self, dw):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as e:
            reports_router.get_products_by_day(
                from_date=None, to_date=TODAY, tz=None, company_id=None, shop_ids=None, area_ids=None, machine_ids=None,
                category_ids=["bad"], amounts=True, hide_empty_days=False, sort="qty", meals="components", **_ctx(dw),
            )
        assert e.value.status_code == 400
