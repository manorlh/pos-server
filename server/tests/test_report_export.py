"""
Report export (P:/specs/reports-upgrade.md §2ב, §2ד, §4.3–§4.6):

* the company's default export columns per report (`report_export_defaults`) — who may read and
  set them, the parent company's filling in, the audit, the migration;
* each user's visible columns (`users.preferences.reportColumns`);
* the report PDF drawn on the server — real text in Heebo, Hebrew in visual order, ₪ money,
  repeated headers, totals, "עמוד X מתוך Y", the row limit (413) and sign-in;
* the reports that had no export carry what an Excel export needs.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import re
import uuid
import zlib

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.company import Company
from app.models.report_export_default import ReportExportDefault, ReportExportDefaultAudit
from app.models.user import User, UserRole
from app.routers import report_export_defaults as defaults_router
from app.routers import report_pdf as pdf_router
from app.routers import users as users_router
from app.schemas.user import UserPreferencesUpdate
from app.services import report_pdf as P
from app.services import user_preferences as UP
from test_shop_areas import _ctx, w  # noqa: F401

ROOT = pathlib.Path(__file__).absolute().parents[1]


def _user(w, role, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:8]}@x",
             username=uuid.uuid4().hex[:10], **kw)
    w.db.add(u)
    w.db.commit()
    return u


def put(w, user, key, columns, company=None):
    body = defaults_router.ExportDefaultIn(companyId=(company or w.company).id, columns=columns)
    return defaults_router.put_export_default(key, body, **_ctx(w, user))


def get(w, user, company=None):
    return defaults_router.get_export_defaults(company_id=(company.id if company else None), **_ctx(w, user))


# ── Company export defaults ──────────────────────────────────────────────────


class TestExportDefaults:
    def test_a_company_manager_sets_it_and_everyone_in_the_company_reads_it(self, w):
        out = put(w, w.company_manager, "product-sales", ["productName", "net", "net", "unitsNet"])
        assert out["columns"] == ["productName", "net", "unitsNet"]  # each once, in order
        assert out["inherited"] is False and out["updatedBy"]["id"] == str(w.company_manager.id)

        read = get(w, w.manager)  # a shop manager: their shop's company, by default
        assert read["companyId"] == str(w.company.id)
        assert read["canEdit"] is False
        (row,) = read["defaults"]
        assert (row["reportKey"], row["columns"], row["inherited"]) == ("product-sales", ["productName", "net", "unitsNet"], False)
        assert get(w, w.company_manager, w.company)["canEdit"] is True

    def test_only_a_manager_a_distributor_or_a_super_admin_may_set_it(self, w):
        for user in (w.manager, w.cashier, _user(w, UserRole.SHIFT_SUPERVISOR, shop_id=w.shop.id)):
            with pytest.raises(HTTPException) as e:
                put(w, user, "tips", ["tipsTotal"])
            assert e.value.status_code == 403
        distributor = _user(w, UserRole.DISTRIBUTOR)
        assert put(w, distributor, "tips", ["tipsTotal"])["columns"] == ["tipsTotal"]
        assert put(w, w.admin, "tips", ["tipsCash"])["columns"] == ["tipsCash"]

    def test_another_companys_manager_is_refused(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other Ltd", vat_number="9")
        w.db.add(other)
        w.db.commit()
        stranger = _user(w, UserRole.COMPANY_MANAGER, company_id=other.id)
        with pytest.raises(HTTPException) as e:
            put(w, stranger, "tips", ["tipsTotal"])
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            get(w, stranger, w.company)
        assert e.value.status_code == 403

    def test_another_tenants_company_is_not_found(self, w):
        foreign = Company(id=uuid.uuid4(), tenant_id=w.foreign_shop.tenant_id, name="Far", vat_number="8")
        w.db.add(foreign)
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            put(w, w.admin, "tips", ["tipsTotal"], company=foreign)
        assert e.value.status_code == 404

    def test_an_empty_list_removes_it_and_every_change_is_audited(self, w):
        put(w, w.company_manager, "cashier-sales", ["cashierName", "net"])
        put(w, w.company_manager, "cashier-sales", ["cashierName", "net"])  # no change: no audit
        put(w, w.company_manager, "cashier-sales", ["net"])
        out = put(w, w.company_manager, "cashier-sales", [])
        assert out["columns"] == [] and out["updatedAt"] is None
        assert w.db.query(ReportExportDefault).count() == 0
        log = defaults_router.get_export_defaults_audit(company_id=w.company.id, report_key=None, **_ctx(w, w.company_manager))
        assert [(i["action"], i["before"], i["after"]) for i in log["items"]][::-1] == [
            ("set", None, ["cashierName", "net"]),
            ("set", ["cashierName", "net"], ["net"]),
            ("clear", ["net"], None),
        ]
        assert all(i["actorName"] for i in log["items"])
        with pytest.raises(HTTPException) as e:
            defaults_router.get_export_defaults_audit(company_id=w.company.id, report_key=None, **_ctx(w, w.manager))
        assert e.value.status_code == 403

    def test_a_subsidiary_reads_its_parents_until_it_sets_its_own(self, w):
        sub = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="North Ltd", vat_number="2", parent_company_id=w.company.id)
        w.db.add(sub)
        w.db.commit()
        put(w, w.admin, "hourly-sales", ["hour", "net"])
        (row,) = get(w, w.admin, sub)["defaults"]
        assert row["inherited"] is True and row["companyId"] == str(w.company.id)
        put(w, w.admin, "hourly-sales", ["net"], company=sub)
        (row,) = get(w, w.admin, sub)["defaults"]
        assert (row["inherited"], row["columns"]) == (False, ["net"])
        # The parent's own is untouched.
        assert get(w, w.admin, w.company)["defaults"][0]["columns"] == ["hour", "net"]

    @pytest.mark.parametrize("key,columns", [
        ("Bad Key", ["a"]),
        ("../x", ["a"]),
        ("ok-key", ["has space"]),
        ("ok-key", ["x" * 65]),
        ("ok-key", [f"c{i}" for i in range(101)]),
    ])
    def test_keys_are_validated(self, w, key, columns):
        with pytest.raises(HTTPException) as e:
            put(w, w.admin, key, columns)
        assert e.value.status_code == 422

    def test_the_body_takes_no_unknown_fields(self, w):
        with pytest.raises(ValidationError):
            defaults_router.ExportDefaultIn.model_validate({"companyId": str(w.company.id), "columns": [], "x": 1})

    def test_the_routes_are_mounted_for_signed_in_users(self):
        from test_reports_router_auth import _auth_dependencies

        for path in ("/api/v1/report-export-defaults", "/api/v1/report-export-defaults/{report_key}",
                     "/api/v1/report-export-defaults/audit", "/api/v1/reports/pdf"):
            assert {"get_current_user", "get_active_tenant_id"} <= _auth_dependencies(path)
        from app.services.dashboard_sections import rule_for

        assert rule_for("POST", "/reports/pdf").kind == "reference"
        assert rule_for("GET", "/report-export-defaults").kind == "reference"
        assert rule_for("PUT", "/report-export-defaults/{}").describe("PUT") == "reports:edit"


class TestMigration:
    def _module(self):
        path = ROOT / "alembic" / "versions" / "f3b8d1e6a2c9_report_export_defaults.py"
        spec = importlib.util.spec_from_file_location("migration_f3b8d1e6a2c9", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_and_offline(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == ("f3b8d1e6a2c9", "c7e4a2f9d1b6")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("companies", "users"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            cols = {c["name"] for c in insp.get_columns("report_export_defaults")}
            assert cols == {"id", "company_id", "report_key", "columns", "updated_by", "updated_at"}
            assert insp.has_table("report_export_default_audit")
            uniques = insp.get_unique_constraints("report_export_defaults")
            assert any(set(u["column_names"]) == {"company_id", "report_key"} for u in uniques)
        # Tables the API's create_all made first (from the models): only what is missing is added.
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("companies", "users"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            ReportExportDefault.__table__.create(conn)
            ReportExportDefaultAudit.__table__.create(conn)
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "CREATE TABLE report_export_defaults" in sql and "JSONB" in sql
        assert "CREATE TABLE report_export_default_audit" in sql
        assert "uq_report_export_defaults_company_report" in sql

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
        heads = script.get_heads()
        assert len(heads) == 1
        assert "f3b8d1e6a2c9" in {r.revision for r in script.walk_revisions("base", heads[0])}


# ── Each user's visible columns ──────────────────────────────────────────────


class TestReportColumnsPreference:
    def update(self, w, user, **kw):
        return users_router.update_my_preferences(UserPreferencesUpdate(**kw), current_user=user, db=w.db)

    def test_set_merge_per_report_and_remove(self, w):
        out = self.update(w, w.manager, reportColumns={"product-sales": {"visible": ["name", "net"], "order": ["net", "name", "sku"]}})
        assert out.report_columns == {"product-sales": {"visible": ["name", "net"], "order": ["net", "name", "sku"]}}
        # Another report merges in; the first stays.
        out = self.update(w, w.manager, reportColumns={"tips": {"visible": ["tipsTotal"], "order": []}})
        assert set(out.report_columns) == {"product-sales", "tips"}
        # Other preferences are untouched by it, and it by them.
        out = self.update(w, w.manager, homePage="compare")
        assert out.home_page == "compare" and set(out.report_columns) == {"product-sales", "tips"}
        out = self.update(w, w.manager, reportColumns={"tips": None})
        assert set(out.report_columns) == {"product-sales"}
        w.db.expire_all()
        me = users_router.get_my_preferences(current_user=w.manager, db=w.db).model_dump(by_alias=True)
        assert me["reportColumns"]["product-sales"]["visible"] == ["name", "net"]
        out = self.update(w, w.manager, reportColumns=None)
        assert out.report_columns == {}
        assert "reportColumns" not in (w.manager.preferences or {})

    def test_bad_values_are_refused_and_bad_stored_ones_read_as_none(self, w):
        for bad in ({"Bad Key": {"visible": [], "order": []}}, {"ok": {"visible": ["has space"], "order": []}},
                    {"ok": {"visible": [f"c{i}" for i in range(101)], "order": []}}):
            with pytest.raises(HTTPException) as e:
                self.update(w, w.manager, reportColumns=bad)
            assert e.value.status_code == 422
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({"reportColumns": {"ok": {"visible": [], "hidden": []}}})
        w.manager.preferences = {"reportColumns": {"ok": {"visible": ["a", 3, "b c"]}, "Bad": {}, "x": "y"}}
        assert UP.read_preferences(w.manager)["reportColumns"] == {"ok": {"visible": ["a"], "order": []}}

    def test_at_most_200_reports(self, w):
        many = {f"r{i}": {"visible": ["a"], "order": []} for i in range(201)}
        with pytest.raises(HTTPException) as e:
            self.update(w, w.manager, reportColumns=many)
        assert e.value.status_code == 422


# ── The PDF ──────────────────────────────────────────────────────────────────

COLUMNS = [
    {"key": "name", "label": "שם מוצר"},
    {"key": "units", "label": "יחידות", "kind": "number"},
    {"key": "net", "label": "נטו", "kind": "money"},
    {"key": "share", "label": "אחוז", "kind": "percent"},
]


def _rows(n):
    return [{"name": f"קפה הפוך {i}", "units": i, "net": 12.5 * i, "share": 1.5} for i in range(n)]


def _pdf(w, user=None, **kw):
    body = dict(title="מכירות לפי מוצר", columns=COLUMNS, rows=_rows(5))
    body.update(kw)
    resp = pdf_router.post_report_pdf(pdf_router.ReportPdfIn.model_validate(body), **_ctx(w, user))
    return resp


def _streams(data: bytes):
    """Every stream of the file, inflated when Flate-compressed."""
    out = []
    for m in re.finditer(rb"<<(.*?)>>\nstream\n", data, re.S):
        length = int(re.search(rb"/Length (\d+)", m.group(1)).group(1))
        raw = data[m.end(): m.end() + length]
        out.append(zlib.decompress(raw) if b"/FlateDecode" in m.group(1) else raw)
    return out


class TestPdfText:
    def test_hebrew_is_put_in_visual_order_and_numbers_stay_left_to_right(self):
        assert P.visual("שלום") == "םולש"
        assert P.visual("קופה 12") == "12 הפוק"
        assert P.visual("עמוד 3 מתוך 12") == "12 ךותמ 3 דומע"
        assert P.visual("Croissant חמאה") == "האמח Croissant"
        # Latin only: exactly as typed, its parentheses too.
        assert P.visual("Cola (1L)") == "Cola (1L)"
        # Bidi marks and newlines never reach the page.
        assert P.visual("א\u200fב\nג") == "ג בא"

    def test_money_number_percent_and_date(self):
        assert P.format_money(1234.5) == "₪ 1,234.50"
        assert P.format_money("-12.3") == "₪ -12.30"
        assert P.format_money(-0.001) == "₪ 0.00"
        assert P.format_money(None) == "—"
        assert P.format_number(3) == "3" and P.format_number(1234.5) == "1,234.5" and P.format_number(0.125) == "0.125"
        assert P.format_percent(12.5) == "12.5%" and P.format_percent(100) == "100%"
        assert P.format_date("2026-10-13") == "13.10.2026"
        # A UTC instant is shown in the business's time (IDT, +3).
        assert P.format_date("2026-10-13T09:15:00+00:00") == "13.10.2026 12:15"
        assert P.format_cell(True, "text") == "כן" and P.format_cell(None, "text") == "—"
        # The dashboard's `datetime` kind too.
        assert P.format_cell("2026-10-13T21:05:00Z", "datetime") == "14.10.2026 00:05"
        assert pdf_router.PdfColumn(key="at", kind="datetime").kind == "datetime"

    def test_the_font_draws_hebrew_and_the_shekel_sign(self):
        regular = P._Font(P._truetype(False), "F1")
        for ch in "אבגדהוזחטיכלמנסעפצקרשתךםןףץ₪0123456789.,-%()":
            assert regular.glyph(ch) != 0, ch
        assert regular.width("שלום", 10) > 0


class TestPdf:
    def test_a_pdf_with_its_header_columns_totals_and_page_numbers(self, w):
        resp = _pdf(w, subtitleLines=["Acme — סניף מרכז", "01.10.2026 – 13.10.2026"], filterLines=["קופאי: דנה"],
                    totals={"units": 10, "net": 125})
        data = resp.body
        assert data.startswith(b"%PDF-") and data.rstrip().endswith(b"%%EOF")
        assert resp.media_type == "application/pdf"
        assert "filename*=UTF-8''" in resp.headers["content-disposition"]
        assert P.page_count(data) == 1
        assert b"/FontFile2" in data and b"/Identity-H" in data and b"/ToUnicode" in data
        content = b"\n".join(_streams(data))
        regular = P._Font(P._truetype(False), "F1")
        bold = P._Font(P._truetype(True), "F2")
        # The title, the totals' label and the page number are drawn in visual order.
        assert bold.encode(P.visual("מכירות לפי מוצר", "R")).encode() in content
        assert bold.encode(P.visual(P.TOTAL_LABEL)).encode() in content
        assert regular.encode(P.visual("עמוד 1 מתוך 1", "R")).encode() in content
        assert bold.encode("₪ 125.00").encode() in content
        # The ToUnicode map knows the Hebrew letters (searchable text).
        assert b"<05DE>" in content  # מ

    def test_more_rows_more_pages_each_with_the_headers(self, w):
        one = _pdf(w, rows=_rows(10)).body
        many = _pdf(w, rows=_rows(500)).body
        assert P.page_count(one) == 1
        pages = P.page_count(many)
        assert pages > 5
        content = _streams(many)
        bold = P._Font(P._truetype(True), "F2")
        regular = P._Font(P._truetype(False), "F1")
        header = bold.encode(P.visual("נטו")).encode()
        title = bold.encode(P.visual("מכירות לפי מוצר", "R")).encode()
        # The column headers and the report's header on every page but the cover (more than
        # three pages: P:/specs/reports-designed-pdf.md §5), and each page numbered.
        assert len([s for s in content if header in s and title in s]) == pages - 1
        for n in (1, pages):
            assert any(regular.encode(P.visual(f"עמוד {n} מתוך {pages}", "R")).encode() in s for s in content)

    def test_orientation(self, w):
        eight = [{"key": f"c{i}", "label": f"עמודה {i}"} for i in range(8)]
        assert b"/MediaBox [0 0 841.89 595.28]" in _pdf(w, columns=eight, rows=[{}]).body
        assert b"/MediaBox [0 0 595.28 841.89]" in _pdf(w).body
        assert b"/MediaBox [0 0 841.89 595.28]" in _pdf(w, orientation="landscape").body
        assert b"/MediaBox [0 0 595.28 841.89]" in _pdf(w, columns=eight, rows=[{}], orientation="portrait").body

    def test_no_rows_still_makes_a_page(self, w):
        data = _pdf(w, rows=[]).body
        assert P.page_count(data) == 1

    def test_rows_may_be_arrays_in_column_order(self, w):
        data = _pdf(w, rows=[["תה", 2, 9.5, 10]]).body
        regular = P._Font(P._truetype(False), "F1")
        assert regular.encode("₪ 9.50").encode() in b"\n".join(_streams(data))

    def test_over_the_row_limit_is_a_413_in_hebrew(self, w):
        with pytest.raises(HTTPException) as e:
            _pdf(w, rows=[{}] * (P.MAX_ROWS + 1))
        assert e.value.status_code == 413
        assert "20,000" in e.value.detail and "שורות" in e.value.detail

    def test_the_body_is_validated(self, w):
        for bad in ({"columns": []}, {"columns": [{"key": "a", "kind": "image"}]}, {"title": ""},
                    {"orientation": "sideways"}, {"columns": [{"key": f"c{i}"} for i in range(41)]}):
            body = dict(title="x", columns=COLUMNS, rows=[])
            body.update(bad)
            with pytest.raises(ValidationError):
                pdf_router.ReportPdfIn.model_validate(body)
        with pytest.raises(HTTPException) as e:
            _pdf(w, columns=[{"key": "a"}, {"key": "a"}])
        assert e.value.status_code == 422

    def test_the_business_logo_of_a_company_the_caller_sees(self, w, monkeypatch):
        from PIL import Image

        w.company.settings = {"brandLogoUrl": "https://cdn.example.com/logo.png"}
        w.db.commit()
        seen = []

        def fake_logo(url):
            seen.append(url)
            return Image.new("RGB", (200, 80), "navy")

        monkeypatch.setattr(P, "load_logo", fake_logo)
        data = _pdf(w, companyId=str(w.company.id)).body
        assert seen == ["https://cdn.example.com/logo.png"]
        assert b"/Subtype /Image" in data and b"/DCTDecode" in data
        # Without a company: no logo, nothing fetched.
        seen.clear()
        assert b"/Subtype /Image" not in _pdf(w).body and seen == []
        # A company outside the caller's scope: 403.
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other Ltd", vat_number="9")
        w.db.add(other)
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            _pdf(w, user=w.manager, companyId=str(other.id))
        assert e.value.status_code == 403

    def test_a_logo_url_that_is_not_https_or_our_media_is_never_fetched(self, monkeypatch):
        import app.services.prepaid_voucher_pdf as V

        monkeypatch.setattr(V, "load_logo", lambda url: pytest.fail("fetched"))
        assert P.load_logo("http://169.254.169.254/latest") is None
        assert P.load_logo("file:///etc/passwd") is None

    def test_only_a_signed_in_user_may_call_it(self):
        from fastapi.testclient import TestClient

        from app.main import app

        resp = TestClient(app).post("/api/v1/reports/pdf", json={"title": "x", "columns": [{"key": "a"}], "rows": []})
        assert resp.status_code in (401, 403)

    def test_twenty_thousand_rows_fit(self):
        rows = [{"name": f"מוצר {i}", "units": i, "net": i * 1.5, "share": 0.1} for i in range(P.MAX_ROWS)]
        report = P.build_report(title="גדול", columns=COLUMNS, rows=rows, totals={"net": 1})
        data = P.render(report)
        assert data.startswith(b"%PDF-")
        assert P.page_count(data) > 200
        assert len(data) < 8_000_000


# ── The reports that had no export ───────────────────────────────────────────


class TestExportFields:
    def test_drawer_rows_carry_the_register_number(self, w):
        from types import SimpleNamespace

        from app.services import cash_drawer as svc

        till = w.tills[0]
        labels = {"shops": {w.shop.id: "Center"}, "machines": {till.id: till}}
        event = SimpleNamespace(**{c: None for c in (
            "id", "category", "event_type", "permission", "decision", "result", "result_reason", "drawer_name",
            "device_id", "shift_id", "employee_id", "employee_name", "employee_role", "approver_id", "approver_name",
            "table_id", "sale_id", "payment_id", "original_sale_id", "reason", "reason_note", "movement_id",
            "cash_movement_type", "amount", "expected_balance", "offline", "occurred_at")})
        event.shop_id, event.machine_id = w.shop.id, till.id
        out = svc.event_out(event, labels, {})
        assert (out["machineName"], out["posNumber"], out["shopName"]) == (till.name, till.pos_number, "Center")

    def test_targets_carry_the_shop_name(self, w):
        from decimal import Decimal

        from app.models.sales_target import SalesTarget
        from app.services import sales_targets as svc

        t = SalesTarget(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, scope="shop", period="day",
                        amount=Decimal("1000"))
        w.db.add(t)
        w.db.commit()
        assert svc.target_out(w.db, t)["shopName"] == "Center"

    def test_zcredit_items_carry_the_shop_name(self):
        from types import SimpleNamespace

        from app.routers.zcredit_reconciliation import item_out

        shop_id = uuid.uuid4()
        item = SimpleNamespace(
            id=uuid.uuid4(), run_id=uuid.uuid4(), category="matched", reason=None, zc_deal_type="1", zc_source=None,
            payment_id=uuid.uuid4(), transaction_id=None, machine_id=None, shop_id=shop_id, document_number="7",
            document_type=320, our_amount_agorot=1250, our_status="completed", our_card_last4="1234",
            our_created_at=None, our_transmitted=True, our_batch=None, related=[], handled_at=None,
        )
        out = item_out(item, {}, {str(shop_id): "Center"})
        assert out["ours"]["shopName"] == "Center" and out["ours"]["amount"] == 12.5
