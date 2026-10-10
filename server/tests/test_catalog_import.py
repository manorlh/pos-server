"""
Importing a company's menu from Excel ("ייבוא פריטים מאקסל") - app/services/catalog_import.py.

What each class pins, and how it could look fine while doing damage:

* **Template** - the four sheets, right-to-left, frozen styled headers with "*" on the
  required columns, the dropdowns and number checks, grey "דוגמה" rows the import skips,
  the company's printers (read-only) and categories pre-filled; with data, the catalog
  itself, which imports back as "no change".
* **Parsing** - prices with ₪ and commas read and reported, a missing price is an error
  with its row number, duplicate barcodes in the file, CSV in UTF-8 and Windows-1255.
* **Matching** - barcode, then SKU, then the exact name in the category; conflicts and a
  SKU of another company refused rather than overwritten; empty cells keep values.
* **Categories** - parents in any order, unknown ones made (with a warning), cycles refused.
* **Routing** - a printer name routes in every shop that has a printer by that name; a
  product's "ללא" / "ירושה"; unknown names warned and skipped.
* **Commit** - one transaction, the tills told, the same file twice changes nothing, the
  preview token binds the file and the plan, error rows block unless skipped.
* **Permissions and the share link** - who may import; a public link that only downloads,
  expires, and dies with its issuer.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import io
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import openpyxl
import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from starlette.requests import Request

from app.models.category import Category
from app.models.company import Company
from app.models.printers import KitchenPrinter, KitchenPrinterRoute
from app.models.product import Product
from app.models.product_cost import ProductCost
from app.models.shop_product_override import ShopProductOverride
from app.models.tenant_local_sku_sequence import TenantLocalSkuSequence
from app.models.tenant_membership import TenantMembership
from app.models.tenant_sku_sequence import TenantSkuSequence
from app.models.user import User, UserRole
from app.routers import catalog_import as R
from app.services import ably_notify
from app.services import catalog_import as I
from app.services import catalog_sheet as S
from shift_world import accept_str_uuids, make_world


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    # The SKU series exist, so allocation skips the Postgres-only `~` first-use query.
    db.add(TenantLocalSkuSequence(tenant_id=world.tenant.id, next_value=1000))
    db.add(TenantSkuSequence(tenant_id=world.tenant.id, next_value=500000))

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.distributor = user(UserRole.DISTRIBUTOR, "dist")
    db.add(TenantMembership(id=uuid.uuid4(), tenant_id=world.tenant.id, user_id=world.distributor.id))
    world.manager = user(UserRole.COMPANY_MANAGER, "cm", company_id=world.company.id)
    world.shop_manager = user(UserRole.SHOP_MANAGER, "sm", shop_id=world.shop.id, company_id=world.company.id)
    world.cashier = user(UserRole.CASHIER, "cashier", shop_id=world.shop.id)

    # Printers: the center has a kitchen and a bar, the north branch a kitchen only.
    def printer(shop, name, sort=0):
        p = KitchenPrinter(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=shop.id, name=name,
                           connection_type="network", host="10.0.0.9", port=9100, sort_order=sort)
        db.add(p)
        return p

    world.kitchen = printer(world.shop, "מטבח", 0)
    world.bar = printer(world.shop, "בר", 1)
    world.north_kitchen = printer(world.other_shop, "מטבח", 0)

    # A menu: Drinks (routed to the bar), Food › Burgers.
    world.drinks = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
                            name="שתייה", sort_order=1)
    world.food = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
                          name="אוכל", sort_order=2)
    db.add_all([world.drinks, world.food])
    db.flush()
    world.burgers = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
                             name="המבורגרים", parent_id=world.food.id, sort_order=3)
    db.add(world.burgers)
    db.add(KitchenPrinterRoute(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id,
                               target_type="category", target_id=world.drinks.id, printer_id=world.bar.id))

    def product(name, category, price, **kw):
        p = Product(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
                    category_id=category.id, name=name, price=Decimal(price), **kw)
        db.add(p)
        return p

    world.cola = product("קולה", world.drinks, "12.00", sku="2001", barcode="7290000000017")
    world.water = product("מים", world.drinks, "8.00", sku="2002")
    world.classic = product("המבורגר קלאסי", world.burgers, "58.00", sku="1001", sku_auto_assigned=True)
    db.commit()

    world.catalog = []
    world.settings = []
    monkeypatch.setattr(ably_notify, "publish_catalog_notify",
                        lambda tenant_id, machine_id, reason=None: world.catalog.append((machine_id, reason)))
    monkeypatch.setattr(ably_notify, "publish_settings_notify",
                        lambda tenant_id, machine_id, reason=None: world.settings.append((machine_id, reason)))
    return world


PRODUCT_HEADERS = [c.header for c in S.PRODUCT_COLUMNS]
CATEGORY_HEADERS = [c.header for c in S.CATEGORY_COLUMNS]


def workbook(products=(), categories=None) -> bytes:
    """A filled-in sheet: rows as {column key: value}."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = S.SHEET_PRODUCTS
    ws.append(PRODUCT_HEADERS)
    for row in products:
        ws.append([row.get(c.key) for c in S.PRODUCT_COLUMNS])
    if categories is not None:
        cs = wb.create_sheet(S.SHEET_CATEGORIES)
        cs.append(CATEGORY_HEADERS)
        for row in categories:
            cs.append([row.get(c.key) for c in S.CATEGORY_COLUMNS])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def plan_for(w, data: bytes, user=None, name="menu.xlsx") -> I.Plan:
    ctx = I.load_context(w.db, w.tenant.id, w.company, user or w.distributor)
    return I.build_plan(ctx, S.read_file(data, name))


def preview(w, data: bytes, user=None, company_id=None, name="menu.xlsx"):
    return R.preview_import(
        file=UploadFile(file=io.BytesIO(data), filename=name), company_id=company_id,
        current_user=user or w.distributor, active_tenant_id=w.tenant.id, db=w.db,
    )


def commit(w, data: bytes, user=None, token=None, skip_errors=False, company_id=None, name="menu.xlsx"):
    tasks = BackgroundTasks()
    out = R.commit_import(
        background_tasks=tasks, file=UploadFile(file=io.BytesIO(data), filename=name), token=token,
        skip_errors=skip_errors, company_id=company_id, current_user=user or w.distributor,
        active_tenant_id=w.tenant.id, db=w.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def template(w, with_data=False, user=None, fmt="xlsx") -> bytes:
    response = R.get_template(with_data=with_data, fmt=fmt, company_id=None, current_user=user or w.distributor,
                              active_tenant_id=w.tenant.id, db=w.db)
    return response.body


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def messages(rows):
    return [m["text"] for r in rows for m in r["messages"]]


def products_named(w, name):
    return w.db.query(Product).filter(Product.tenant_id == w.tenant.id, Product.name == name).all()


def request(client="1.2.3.4") -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b"",
        "scheme": "http", "server": ("testserver", 80), "root_path": "", "client": (client, 5000),
    })


# ── Template ──────────────────────────────────────────────────────────────────


class TestTemplate:
    def test_the_sheets_right_to_left_with_frozen_styled_headers(self, w):
        wb = openpyxl.load_workbook(io.BytesIO(template(w)))
        assert wb.sheetnames[:7] == [S.SHEET_INSTRUCTIONS, S.SHEET_CATEGORIES, S.SHEET_PRODUCTS, S.SHEET_GROUPS,
                                     S.SHEET_OPTIONS, S.SHEET_NOTES, S.SHEET_PRINTERS]
        assert wb[S.SHEET_LISTS].sheet_state == "hidden"
        for ws in wb.worksheets:
            assert ws.sheet_view.rightToLeft is True
        products = wb[S.SHEET_PRODUCTS]
        assert [c.value for c in products[1]] == PRODUCT_HEADERS
        assert products.freeze_panes == "C2"
        assert products["B1"].font.bold and products["B1"].fill.fgColor.rgb.endswith("007AFF")
        assert products.column_dimensions["B"].width >= 25
        assert wb[S.SHEET_CATEGORIES].freeze_panes == "C2"

    def test_required_columns_end_with_a_star_and_every_header_explains_itself(self, w):
        products = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_PRODUCTS]
        required = {c.value for c in products[1] if c.value.endswith("*")}
        assert required == {"שם פריט*", "מחלקה*", "מחיר*"}
        assert all(c.comment is not None and c.comment.text for c in products[1])

    def test_dropdowns_and_number_checks(self, w):
        products = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_PRODUCTS]
        by_column = {}
        for dv in products.data_validations.dataValidation:
            for ref in str(dv.sqref).split():
                by_column.setdefault(re.match(r"[A-Z]+", ref).group(0), []).append(dv)
        letter = {c.key: openpyxl.utils.get_column_letter(i) for i, c in enumerate(S.PRODUCT_COLUMNS, start=1)}
        yes_no = by_column[letter["open_price"]][0]
        assert yes_no.type == "list" and S.SHEET_LISTS in yes_no.formula1
        assert by_column[letter["active"]][0] is yes_no
        assert by_column[letter["category"]][0].formula1.startswith(f"'{S.SHEET_CATEGORIES}'!$B$2")
        assert by_column[letter["printers"]][0].showErrorMessage is False  # several names are allowed
        assert by_column[letter["price"]][0].type == "decimal"
        assert by_column[letter["entries"]][0].type == "whole"
        assert by_column[letter["unit"]][0].type == "list"
        # The units and the yes/no words the lists offer.
        lists = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_LISTS]
        column_values = {lists.cell(1, c).value: [lists.cell(r, c).value for r in range(2, 8) if lists.cell(r, c).value]
                         for c in range(1, 5)}
        assert column_values["yes_no"] == ["כן", "לא"]
        assert column_values["units"][:2] == ["יח׳", "ק״ג"]
        assert column_values["printers"] == ["מטבח", "בר", "ללא", "ירושה"]

    def test_examples_are_grey_marked_rows_the_import_skips(self, w):
        data = template(w)
        products = openpyxl.load_workbook(io.BytesIO(data))[S.SHEET_PRODUCTS]
        assert [products.cell(r, 1).value for r in (2, 3, 4)] == ["דוגמה"] * 3
        assert products["B2"].font.color.rgb.endswith("8E8E93")
        out = preview(w, data)
        # 3 categories, 3 products, 3 groups, 8 options and 3 quick notes.
        assert out["summary"]["examplesSkipped"] == 20
        assert out["summary"]["productsNew"] == 0 and out["summary"]["errors"] == 0
        assert out["products"] == [] and out["groups"] == [] and out["options"] == [] and out["notes"] == []

    def test_printers_sheet_lists_each_shops_printers_read_only(self, w):
        ws = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_PRINTERS]
        rows = {(ws.cell(r, 1).value, ws.cell(r, 2).value) for r in range(4, 8) if ws.cell(r, 1).value}
        assert rows == {("מטבח", "Center"), ("בר", "Center"), ("מטבח", "North")}
        assert ws.protection.sheet is True

    def test_blank_template_is_prefilled_with_the_categories_and_their_routing(self, w):
        ws = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_CATEGORIES]
        rows = {ws.cell(r, 2).value: (ws.cell(r, 3).value, ws.cell(r, 4).value)
                for r in range(5, 9) if ws.cell(r, 2).value}
        assert rows == {"שתייה": (None, "בר"), "אוכל": (None, None), "המבורגרים": ("אוכל", None)}

    def test_the_current_catalog_exports_and_imports_back_as_no_change(self, w):
        w.db.add(ProductCost(tenant_id=w.tenant.id, product_id=w.cola.id, cost=Decimal("3.10")))
        w.db.commit()
        data = template(w, with_data=True)
        ws = openpyxl.load_workbook(io.BytesIO(data))[S.SHEET_PRODUCTS]
        exported = {ws.cell(r, 2).value: [ws.cell(r, c).value for c in range(1, 17)] for r in range(2, 5)}
        assert set(exported) == {"קולה", "מים", "המבורגר קלאסי"}
        cola = exported["קולה"]
        assert cola[2] == "שתייה" and cola[3] == 12 and cola[4] == "7290000000017" and cola[5] == "2001"
        assert cola[6] == pytest.approx(3.10)
        out = preview(w, data)
        assert out["summary"]["productsUnchanged"] == 3 and out["summary"]["categoriesUnchanged"] == 3
        assert out["canCommit"] is False
        assert out["summary"]["errors"] == 0 and out["summary"]["warnings"] == 0

    def test_typed_codes_stay_text_and_a_row_added_far_below_still_imports(self, w):
        wb = openpyxl.load_workbook(io.BytesIO(template(w)))
        products = wb[S.SHEET_PRODUCTS]
        letter = {c.key: openpyxl.utils.get_column_letter(i) for i, c in enumerate(S.PRODUCT_COLUMNS, start=1)}
        # The format is the column's: no empty cell is created, so the used range stays short.
        assert products.column_dimensions[letter["barcode"]].number_format == "@"
        assert products.column_dimensions[letter["price"]].number_format == "#,##0.00"
        assert products.max_row == 4
        for key, value in (("name", "טוסט"), ("category", "אוכל"), ("price", 31), ("barcode", "0012345")):
            products[f"{letter[key]}1500"] = value
        products.append([None, "בייגל", "אוכל", 14])
        out = io.BytesIO()
        wb.save(out)
        plan = plan_for(w, out.getvalue())
        assert [(p.row, p.name, p.barcode) for p in plan.products] == [(1500, "טוסט", "0012345"), (1501, "בייגל", None)]

    def test_csv_export_is_the_products_sheet(self, w):
        body = template(w, with_data=True, fmt="csv").decode("utf-8-sig")
        assert body.splitlines()[0].split(",")[:4] == ["סימון", "שם פריט*", "מחלקה*", "מחיר*"]
        assert "7290000000017" in body


# ── Parsing ───────────────────────────────────────────────────────────────────


class TestParsing:
    def test_prices_with_shekel_signs_and_commas_are_read_and_reported(self, w):
        data = workbook([
            {"name": "א", "category": "שתייה", "price": "₪1,234.50"},
            {"name": "ב", "category": "שתייה", "price": "12,5"},
            {"name": "ג", "category": "שתייה", "price": 9.9},
        ])
        plan = plan_for(w, data)
        assert [p.values["price"] for p in plan.products] == [Decimal("1234.50"), Decimal("12.50"), Decimal("9.90")]
        texts = [i.text for p in plan.products for i in p.issues]
        assert "שורה 2: מחיר '₪1,234.50' נקרא כ-1234.50" in texts
        assert "שורה 3: מחיר '12,5' נקרא כ-12.50" in texts
        assert not any(i.level == "error" for p in plan.products for i in p.issues)

    def test_a_missing_or_bad_price_is_an_error_with_its_row(self, w):
        out = preview(w, workbook([
            {"name": "עוגה", "category": "שתייה"},
            {"name": "עוגה 2", "category": "שתייה", "price": "זול"},
            {"name": "עוגה 3", "category": "שתייה", "price": -4},
        ]))
        assert [r["status"] for r in out["products"]] == ["error"] * 3
        assert "שורה 2: מחיר חסר" in messages(out["products"])
        assert "שורה 3: מחיר לא תקין ('זול')" in messages(out["products"])
        assert out["summary"]["errors"] == 3 and out["canCommit"] is False

    def test_yes_no_ticket_and_entries_are_checked(self, w):
        plan = plan_for(w, workbook([
            {"name": "א", "category": "שתייה", "price": 5, "open_price": "אולי"},
            {"name": "ב", "category": "שתייה", "price": 5, "ticket": "כל יום"},
            {"name": "ג", "category": "שתייה", "price": 5, "entries": 70},
            {"name": "ד", "category": "שתייה", "price": 5, "no_discount": "v", "ticket": "לכל יחידה", "entries": 3,
             "active": "לא", "weighed": "כן", "unit": "ק״ג"},
        ]))
        assert [p.has_error for p in plan.products] == [True, True, True, False]
        good = plan.products[3].values
        assert (good["no_discount"], good["ticket_mode"], good["ticket_entries"], good["is_available"],
                good["is_weighed"], good["unit_label"]) == (True, "per_unit", 3, False, True, "ק״ג")

    def test_duplicate_barcodes_and_skus_in_the_file(self, w):
        out = preview(w, workbook([
            {"name": "א", "category": "שתייה", "price": 5, "barcode": "111"},
            {"name": "ב", "category": "שתייה", "price": 5, "sku": "S-1"},
            {"name": "ג", "category": "שתייה", "price": 5, "barcode": "111"},
            {"name": "ד", "category": "שתייה", "price": 5, "sku": "S-1"},
        ]))
        assert [r["status"] for r in out["products"]] == ["create", "create", "error", "error"]
        assert "שורה 4: הברקוד 111 מופיע גם בשורה 2" in messages(out["products"])
        assert "שורה 5: המק״ט S-1 מופיע גם בשורה 3" in messages(out["products"])

    def test_a_barcode_excel_turned_into_scientific_notation_is_refused(self, w):
        plan = plan_for(w, workbook([{"name": "א", "category": "שתייה", "price": 5, "barcode": "7.29E+12"}]))
        assert plan.products[0].has_error
        assert "פורמט מדעי" in plan.products[0].issues[0].text

    def test_csv_in_utf8_and_in_windows_1255_with_semicolons(self, w):
        text = "שם פריט;מחלקה;מחיר;ברקוד\nבירה;שתייה;₪24;\nקפה;שתייה;9.5;\n"
        for data in (("﻿" + text.replace(";", ",")).encode("utf-8"), text.encode("cp1255")):
            plan = plan_for(w, data, name="menu.csv")
            assert plan.file_kind == "csv"
            assert [(p.name, p.values.get("price")) for p in plan.products] == [
                ("בירה", Decimal("24.00")), ("קפה", Decimal("9.50"))]

    def test_headers_are_matched_leniently_and_unknown_ones_warned(self, w):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "גיליון1"
        ws.append(["הערה פנימית"])
        ws.append(["קטגוריה", 'מק"ט', "שם", "מחיר (₪)", "ספק"])
        ws.append(["שתייה", "9", "סודה", 7, "טמפו"])
        out = io.BytesIO()
        wb.save(out)
        plan = plan_for(w, out.getvalue())
        assert [(p.name, p.sku, p.row) for p in plan.products] == [("סודה", "9", 3)]
        assert any("'ספק'" in i.text for i in plan.issues)

    def test_unreadable_files_are_refused_in_hebrew(self, w):
        for data, name in ((b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"0" * 50, "old.xls"), (b"PK\x03\x04broken", "x.xlsx"),
                           (b"just,some,text\n1,2,3\n", "x.csv")):
            error = refused(preview, w, data, name=name)
            assert error.status_code == 422 and error.detail["code"] == "unreadable"


# ── Matching ──────────────────────────────────────────────────────────────────


class TestMatching:
    def test_by_barcode_then_sku_then_name_in_the_category(self, w):
        plan = plan_for(w, workbook([
            {"name": "קוקה קולה", "category": "שתייה", "price": 13, "barcode": "7290000000017"},
            {"name": "מים מינרליים", "category": "שתייה", "price": 9, "sku": "2002"},
            {"name": "המבורגר קלאסי", "category": "המבורגרים", "price": 62},
            {"name": "המבורגר קלאסי", "category": "שתייה", "price": 62},
        ]))
        by = [(p.existing.name if p.existing else None, p.matched_by, p.action) for p in plan.products]
        assert by == [("קולה", "barcode", "update"), ("מים", "sku", "update"),
                      ("המבורגר קלאסי", "name", "update"), (None, None, "create")]
        assert [(c.field, c.before, c.after) for c in plan.products[0].changes] == [
            ("name", "קולה", "קוקה קולה"), ("price", Decimal("12.00"), Decimal("13.00"))]

    def test_a_barcode_of_one_product_and_a_sku_of_another_is_refused(self, w):
        plan = plan_for(w, workbook([{"name": "קולה", "category": "שתייה", "price": 12,
                                      "barcode": "7290000000017", "sku": "2002"}]))
        assert plan.products[0].has_error
        assert "שייך לפריט 'קולה' אבל המק״ט 2002 שייך לפריט 'מים'" in plan.products[0].issues[-1].text

    def test_a_sku_held_by_another_companys_product_is_refused(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Beta", vat_number="2")
        w.db.add(other)
        w.db.flush()
        w.db.add(Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, category_id=w.drinks.id,
                         name="של בטא", price=Decimal("1"), sku="B-77"))
        w.db.commit()
        plan = plan_for(w, workbook([{"name": "חדש", "category": "שתייה", "price": 5, "sku": "B-77"}]))
        assert plan.products[0].has_error
        assert "כבר בשימוש בפריט אחר בארגון ('של בטא')" in plan.products[0].issues[0].text

    def test_empty_cells_keep_what_an_existing_product_has(self, w):
        plan = plan_for(w, workbook([{"name": "קולה", "category": "", "barcode": "7290000000017"}]))
        assert (plan.products[0].action, plan.products[0].changes) == ("unchanged", [])

    def test_an_auto_assigned_sku_is_kept_with_a_warning(self, w):
        plan = plan_for(w, workbook([{"name": "המבורגר קלאסי", "category": "המבורגרים", "price": 58, "sku": "X-1"}]))
        p = plan.products[0]
        assert p.action == "unchanged" and "sku" not in p.values
        assert "הוקצה אוטומטית ולא ישתנה" in p.issues[0].text

    def test_two_rows_for_one_product_are_refused(self, w):
        plan = plan_for(w, workbook([
            {"name": "קולה", "category": "שתייה", "price": 12, "barcode": "7290000000017"},
            {"name": "x", "category": "שתייה", "price": 12, "sku": "2001"},
        ]))
        assert "מתאימה לאותו פריט כמו שורה 2" in plan.products[1].issues[-1].text


# ── Categories ────────────────────────────────────────────────────────────────


class TestCategories:
    def test_parents_in_any_order_unknown_ones_made_and_cycles_refused(self, w):
        data = workbook(
            [{"name": "טירמיסו", "category": "עוגות", "price": 32}, {"name": "סורבה", "category": "גלידות", "price": 22}],
            [
                {"name": "עוגות", "parent": "קינוחים", "printers": "מטבח"},
                {"name": "קינוחים", "sort": 9},
                {"name": "שייקים", "parent": "משקאות קרים"},
                {"name": "א", "parent": "ב"},
                {"name": "ב", "parent": "א"},
                {"name": "ג", "parent": "א"},
            ],
        )
        out = preview(w, data)
        status = {c["name"]: c["status"] for c in out["categories"]}
        assert status == {"עוגות": "create", "קינוחים": "create", "שייקים": "create", "א": "error",
                          "ב": "error", "ג": "error", "משקאות קרים": "create", "גלידות": "create"}
        assert "שורה 7: מחלקת האב 'א' שגויה (שורה 5)" in messages(out["categories"])
        texts = messages(out["categories"]) + messages(out["products"])
        assert "שורה 4: מחלקת האב 'משקאות קרים' לא קיימת - תיווצר" in texts
        assert "שורה 3: מחלקה 'גלידות' לא קיימת - תיווצר" in texts
        assert any(t.startswith("שורה 5: מחלקת האב יוצרת מעגל") for t in texts)

        commit(w, data, skip_errors=True)
        made = {c.name: c for c in w.db.query(Category).filter(Category.tenant_id == w.tenant.id)}
        assert made["עוגות"].parent_id == made["קינוחים"].id and made["קינוחים"].parent_id is None
        assert made["קינוחים"].sort_order == 9 and made["קינוחים"].company_id == w.company.id
        assert "א" not in made and "ב" not in made
        assert products_named(w, "טירמיסו")[0].category_id == made["עוגות"].id

    def test_an_existing_category_is_moved_and_switched_off(self, w):
        data = workbook([], [{"name": "המבורגרים", "parent": "ללא", "active": "לא", "sort": 3}])
        row = preview(w, data)["categories"][0]
        assert row["status"] == "update"
        assert [(c["field"], c["before"], c["after"]) for c in row["changes"]] == [
            ("parent", "אוכל", ""), ("active", "כן", "לא")]
        assert commit(w, data)["categoriesUpdated"] == 1
        burgers = w.db.get(Category, w.burgers.id)
        assert (burgers.parent_id, burgers.is_active, burgers.sort_order) == (None, False, 3)
        # Moved out from under its parent, it no longer inherits that parent's printers:
        # every till with printers re-reads its routing, as well as its catalog.
        tills = {str(t.id) for t in w.tills} | {str(w.other_till.id)}
        assert {m for m, _ in w.settings} == tills and {m for m, _ in w.catalog} == tills


# ── Routing ───────────────────────────────────────────────────────────────────


def own(w, target_type, target_id, shop):
    rows = w.db.query(KitchenPrinterRoute).filter(
        KitchenPrinterRoute.shop_id == shop.id, KitchenPrinterRoute.target_type == target_type,
        KitchenPrinterRoute.target_id == target_id,
    ).all()
    return sorted(str(r.printer_id) if r.printer_id else "none" for r in rows)


class TestRouting:
    def test_a_printer_name_routes_in_every_shop_that_has_one(self, w):
        data = workbook([], [{"name": "אוכל", "printers": "מטבח"}, {"name": "שתייה", "printers": "בר, מטבח"}])
        out = commit(w, data)
        assert out["routingChanges"] == 2
        assert own(w, "category", w.food.id, w.shop) == [str(w.kitchen.id)]
        assert own(w, "category", w.food.id, w.other_shop) == [str(w.north_kitchen.id)]
        assert own(w, "category", w.drinks.id, w.shop) == sorted([str(w.kitchen.id), str(w.bar.id)])
        # The north branch has no bar: its kitchen alone.
        assert own(w, "category", w.drinks.id, w.other_shop) == [str(w.north_kitchen.id)]
        assert {m for m, reason in w.settings} == {str(t.id) for t in w.tills} | {str(w.other_till.id)}

    def test_an_unknown_printer_is_warned_and_skipped(self, w):
        out = preview(w, workbook([{"name": "קולה", "category": "שתייה", "price": 12, "printers": "בר חיצוני"}]))
        assert out["products"][0]["status"] == "unchanged"
        assert "שורה 2: מדפסת 'בר חיצוני' לא מוגדרת - השיוך יידלג" in messages(out["products"])

    def test_a_product_override_none_then_inherit(self, w):
        commit(w, workbook([{"name": "מים", "category": "שתייה", "price": 8, "printers": "ללא"}]))
        assert own(w, "product", w.water.id, w.shop) == ["none"]
        assert own(w, "product", w.water.id, w.other_shop) == ["none"]
        out = commit(w, workbook([{"name": "מים", "category": "שתייה", "price": 8, "printers": "ירושה"}]))
        assert out["routingChanges"] == 1
        assert own(w, "product", w.water.id, w.shop) == [] and own(w, "product", w.water.id, w.other_shop) == []

    def test_a_new_product_routed_to_the_bar_overrides_its_category(self, w):
        commit(w, workbook([{"name": "מוחיטו", "category": "אוכל", "price": 42, "printers": "בר"}]))
        mojito = products_named(w, "מוחיטו")[0]
        assert own(w, "product", mojito.id, w.shop) == [str(w.bar.id)]
        assert own(w, "product", mojito.id, w.other_shop) == []  # no bar there: left alone

    def test_routing_one_cell_can_say_is_exported_as_names(self, w):
        # The bar in the center, "no ticket" in the north (which has no bar): "בר" says it.
        w.db.add(KitchenPrinterRoute(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id,
                                     target_type="category", target_id=w.drinks.id, printer_id=None))
        w.db.commit()
        ctx = I.load_context(w.db, w.tenant.id, w.company, w.distributor)
        assert I.routing_cell(ctx, "category", str(w.drinks.id)) == ("בר", None)

    def test_routing_that_differs_between_shops_is_exported_blank_with_a_note(self, w):
        # The bar in the center, the kitchen in the north: "בר, מטבח" would change both.
        w.db.add(KitchenPrinterRoute(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id,
                                     target_type="category", target_id=w.drinks.id, printer_id=w.north_kitchen.id))
        w.db.commit()
        ws = openpyxl.load_workbook(io.BytesIO(template(w)))[S.SHEET_CATEGORIES]
        drinks = next(r for r in range(2, 10) if ws.cell(r, 2).value == "שתייה" and ws.cell(r, 1).value is None)
        assert ws.cell(drinks, 4).value is None
        assert "הניתוב שונה בין הסניפים" in ws.cell(drinks, 4).comment.text


# ── Commit ────────────────────────────────────────────────────────────────────


class TestCommit:
    def test_creates_updates_sells_in_every_shop_and_tells_the_tills(self, w):
        data = workbook([
            {"name": "שניצל", "category": "אוכל", "price": "54", "cost": 14.2, "barcode": "123"},
            {"name": "קולה", "category": "שתייה", "price": 13, "barcode": "7290000000017"},
        ])
        out = commit(w, data)
        assert (out["productsCreated"], out["productsUpdated"], out["costsUpdated"]) == (1, 1, 1)
        schnitzel = products_named(w, "שניצל")[0]
        assert schnitzel.company_id == w.company.id and schnitzel.sku == "1000" and schnitzel.sku_auto_assigned
        assert schnitzel.global_sku == "500000"
        assert (schnitzel.shop_scope_mode, schnitzel.shop_scope_company_id) == ("company", w.company.id)
        rows = w.db.query(ShopProductOverride).filter(ShopProductOverride.global_product_id == schnitzel.id).all()
        assert {r.shop_id for r in rows} == {w.shop.id, w.other_shop.id} and all(r.assigned_by_rule for r in rows)
        cost = w.db.query(ProductCost).filter(ProductCost.product_id == schnitzel.id).one()
        assert cost.cost == Decimal("14.20") and cost.updated_by_user_id == w.distributor.id
        assert w.db.get(Product, w.cola.id).price == Decimal("13.00")
        assert {reason for _, reason in w.catalog} == {"catalog_import"}
        assert len(w.catalog) == 3 and out["machinesNotified"] == 3

    def test_the_same_file_twice_changes_nothing_the_second_time(self, w):
        data = workbook(
            [{"name": "פיצה", "category": "מאפים", "price": 45, "printers": "מטבח"},
             {"name": "קולה", "category": "שתייה", "price": 14, "barcode": "7290000000017", "cost": 3}],
            [{"name": "מאפים", "parent": "אוכל", "printers": "מטבח"}],
        )
        commit(w, data)
        pizza = products_named(w, "פיצה")[0]
        stamp = (pizza.updated_at, w.db.get(Product, w.cola.id).updated_at)
        w.catalog.clear()
        w.settings.clear()
        out = preview(w, data)
        assert out["summary"]["productsUnchanged"] == 2 and out["summary"]["categoriesUnchanged"] == 1
        assert out["summary"]["routingChanges"] == 0 and out["canCommit"] is False
        again = commit(w, data)
        assert again == {**again, "productsCreated": 0, "productsUpdated": 0, "categoriesCreated": 0,
                         "categoriesUpdated": 0, "costsUpdated": 0, "routingChanges": 0, "machinesNotified": 0}
        assert w.catalog == [] and w.settings == []
        assert len(products_named(w, "פיצה")) == 1
        assert (products_named(w, "פיצה")[0].updated_at, w.db.get(Product, w.cola.id).updated_at) == stamp

    def test_the_preview_token_binds_the_file_and_the_plan(self, w):
        data = workbook([{"name": "קולה", "category": "שתייה", "price": 15, "barcode": "7290000000017"}])
        token = preview(w, data)["token"]
        other = workbook([{"name": "קולה", "category": "שתייה", "price": 16, "barcode": "7290000000017"}])
        assert refused(commit, w, other, token=token).detail["code"] == "file_changed"
        assert refused(commit, w, data, token=token, user=w.manager).detail["code"] == "token_mismatch"
        # The catalog moved since the preview: refused, with the fresh preview.
        w.db.get(Product, w.cola.id).price = Decimal("15.00")
        w.db.commit()
        error = refused(commit, w, data, token=token)
        assert error.status_code == 409 and error.detail["code"] == "plan_changed"
        assert error.detail["preview"]["summary"]["productsUnchanged"] == 1
        assert refused(commit, w, data, token=token + "x").detail["code"] == "token_invalid"

    def test_the_previewed_plan_commits(self, w):
        data = workbook([{"name": "לימונדה", "category": "שתייה", "price": 11}])
        token = preview(w, data)["token"]
        assert commit(w, data, token=token)["productsCreated"] == 1

    def test_rows_with_errors_block_the_import_unless_skipped(self, w):
        data = workbook([{"name": "טוב", "category": "שתייה", "price": 5}, {"name": "רע", "category": "שתייה"}])
        error = refused(commit, w, data)
        assert error.status_code == 422 and error.detail["code"] == "row_errors"
        assert products_named(w, "טוב") == []
        out = commit(w, data, skip_errors=True)
        assert (out["productsCreated"], out["skippedErrorRows"]) == (1, 1)

    def test_a_failure_writes_nothing(self, w, monkeypatch):
        data = workbook([{"name": "חדש", "category": "חדשה", "price": 5}])

        def boom(*a, **k):
            raise RuntimeError("disk on fire")

        monkeypatch.setattr(I, "allocate_global_skus", boom)
        with pytest.raises(RuntimeError):
            commit(w, data)
        assert products_named(w, "חדש") == []
        assert w.db.query(Category).filter(Category.name == "חדשה").count() == 0


# ── Permissions ───────────────────────────────────────────────────────────────


class TestPermissions:
    def test_shop_staff_are_refused(self, w):
        for user in (w.shop_manager, w.cashier):
            assert refused(preview, w, workbook([]), user=user).status_code == 403

    def test_a_company_manager_imports_into_their_company_only(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Beta", vat_number="2")
        w.db.add(other)
        w.db.commit()
        assert preview(w, workbook([{"name": "x", "category": "שתייה", "price": 1}]), user=w.manager)["canCommit"]
        assert refused(preview, w, workbook([]), user=w.manager, company_id=str(other.id)).status_code == 403
        # Two companies, no company given: the distributor must choose.
        assert refused(preview, w, workbook([])).detail["code"] == "company_required"

    def test_a_company_manager_cannot_update_a_tenant_wide_product(self, w):
        shared = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=None, category_id=w.drinks.id,
                         name="סודה", price=Decimal("6"), sku="3001")
        w.db.add(shared)
        w.db.commit()
        out = preview(w, workbook([{"name": "סודה", "category": "שתייה", "price": 7, "sku": "3001"}]), user=w.manager)
        assert out["products"][0]["status"] == "error"
        assert "אין לך הרשאה לעדכן את הפריט 'סודה'" in messages(out["products"])[0]


# ── The share link ────────────────────────────────────────────────────────────


def share(w, user=None):
    return R.create_share_link(request=request(), company_id=None, current_user=user or w.distributor,
                               active_tenant_id=w.tenant.id, db=w.db)


class TestShareLink:
    def test_the_link_downloads_the_blank_template_without_a_login(self, w):
        link = share(w)
        assert link["url"] == f"http://testserver/api/v1{link['path']}" and len(link["token"]) < 100
        expires = datetime.fromisoformat(link["expiresAt"])
        assert timedelta(days=6, hours=23) < expires - datetime.now(timezone.utc) <= timedelta(days=7)
        response = R.download_shared_template(link["token"], request(), db=w.db)
        assert response.status_code == 200 and response.media_type.startswith("application/vnd.openxmlformats")
        wb = openpyxl.load_workbook(io.BytesIO(response.body))
        assert wb[S.SHEET_PRODUCTS].cell(2, 1).value == "דוגמה"
        assert wb[S.SHEET_PRODUCTS].max_row < 1100 and wb[S.SHEET_PRODUCTS].cell(5, 2).value is None
        assert {wb[S.SHEET_PRINTERS].cell(r, 1).value for r in (4, 5, 6)} == {"מטבח", "בר"}

    def test_an_expired_or_altered_link_does_not_download(self, w):
        token, _ = I.make_share_token(w.tenant.id, w.company.id, w.distributor.id,
                                      now=datetime.now(timezone.utc) - timedelta(days=8))
        assert R.download_shared_template(token, request("5.5.5.5"), db=w.db).status_code == 410
        good = share(w)["token"]
        altered = good[:-2] + ("AA" if not good.endswith("AA") else "BB")
        assert R.download_shared_template(altered, request("5.5.5.6"), db=w.db).status_code == 404
        assert R.download_shared_template("nonsense", request("5.5.5.7"), db=w.db).status_code == 404

    def test_a_link_dies_with_its_issuers_access(self, w):
        token = share(w, user=w.manager)["token"]
        w.manager.company_id = None
        w.db.commit()
        assert R.download_shared_template(token, request("6.6.6.6"), db=w.db).status_code == 404
        w.manager.company_id = w.company.id
        w.manager.is_active = False
        w.db.commit()
        assert R.download_shared_template(token, request("6.6.6.7"), db=w.db).status_code == 404

    def test_tokens_are_not_interchangeable(self, w):
        token, _ = I.make_share_token(w.tenant.id, w.company.id, w.distributor.id)
        with pytest.raises(I.TokenError):
            I.read_preview_token(token)
        preview_token = I.make_preview_token(w.tenant.id, w.company.id, w.distributor.id, "h", "f")
        with pytest.raises(I.TokenError):
            I.read_share_token(preview_token)
        from app.services.auth import decode_jwt_payload

        assert decode_jwt_payload(token) is None and decode_jwt_payload(preview_token) is None
