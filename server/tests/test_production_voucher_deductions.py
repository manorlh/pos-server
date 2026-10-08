"""
A production voucher booked as a document deduction ("קיזוז מהחשבונית", the contract's §4.1) —
`voucherDiscounts[]` with `kind: "production_voucher"`:

* stored whole (the kind was cut to 16 characters), with its redemption, type name and the units
  it covered; the redemption learns its document;
* every management report leaves it out of "discounts" and shows it as "שוברי הפקה": the cashier
  and area reports, the report center, the shift totals and the Z document, the discounts report;
* the document copy prints "קיזוז שוברי הפקה −₪40" and each voucher (number, type, units) under
  "סה"כ פריטים", the regular discount apart;
* the uniform file still carries the whole document discount — the document as issued.

The owner's test: a sale with a regular discount and a voucher deduction — the discount totals
exclude the voucher, the voucher category has it, the uniform file carries the whole discount.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION, PrepaidVoucherRedemption, TransactionVoucherDiscount
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.routers import promotions as promotions_router
from app.routers import reports as reports_router
from app.schemas.transaction import TransactionIn
from app.services import print_documents as PD
from app.services import z_print
from app.services.shift_totals import compute_totals
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_prepaid_voucher_kinds import _ctx, codes, make, w  # noqa: F401 — `w` is the fixture
from test_prepaid_vouchers import redeem


def sale(w, shift, *, redemption_id=None, regular="5.00", voucher="40.00", number="8001"):
    """₪50 of goods: a ₪5 regular discount and a ₪40 production voucher deduction, ₪5 cash."""
    item_id = str(uuid.uuid4())
    paid = Decimal("50.00") - Decimal(regular) - Decimal(voucher)
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": "50.00", "documentDiscount": str(Decimal(regular) + Decimal(voucher)), "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": str(paid)}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": [{"id": item_id, "productName": "המבורגר", "quantity": 1, "unitPrice": "50.00", "totalPrice": "50.00"}],
        "voucherDiscounts": [{
            "kind": "production_voucher", "voucherId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()),
            "redemptionId": redemption_id, "serial": 8, "batchName": "הפקה — פסטיבל", "typeName": "שובר ארוחה",
            "uses": 1, "amount": voucher, "lines": [{"itemId": item_id, "amount": voucher}],
            "units": [{"productName": "המבורגר", "groupName": "מנה", "quantity": 1},
                      {"productName": "שתייה קלה", "groupName": "שתייה", "quantity": 1}],
        }],
    })


@pytest.fixture
def booked(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    b = make(w, kind="items", count=1, redemptionAccounting="discount")
    out = redeem(w, codes(w, b)[0], [(w.hotdog, 1)], features=["accounting"])
    doc = sale(w, shift, redemption_id=out["redemptionId"])
    assert [r.status for r in upsert_transactions(w.db, till, [doc])] == ["accepted"]
    w.db.commit()
    w.booked_id = doc.id
    w.redemption_id = out["redemptionId"]
    w.booked_shift = shift
    return w


def report_args(**extra):
    base = dict(from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
                machine_id=None)
    base.update(extra)
    return base


class TestStored:
    def test_whole_with_its_redemption_type_and_units(self, booked):
        w = booked
        row = w.db.query(TransactionVoucherDiscount).one()
        assert (row.kind, row.type_name, row.discount_amount) == (PRODUCTION_VOUCHER_DEDUCTION, "שובר ארוחה", Decimal("40.00"))
        assert str(row.redemption_id) == w.redemption_id
        assert [u["productName"] for u in row.units] == ["המבורגר", "שתייה קלה"]
        red = w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == uuid.UUID(w.redemption_id)).one()
        assert red.transaction_id == str(w.booked_id)


class TestReports:
    def test_the_cashier_report(self, booked):
        # The till's X for the same sale: gross ₪10 (the ₪40 the voucher covered is no sale of the
        # till's), discounts ₪5, net ₪5 — and "שוברי הפקה" ₪40 apart.
        out = reports_router.get_cashier_sales_report(**report_args(area_id=None), **_ctx(booked)).totals
        assert (out.gross, out.discounts, out.production_voucher_deductions, out.net) == (10.0, 5.0, 40.0, 5.0)
        assert out.gross - out.discounts - out.refunds == out.net

    def test_the_area_report(self, booked):
        w = booked
        out = reports_router.get_sales_by_area_report(
            shop_id=w.shop.id, date_from=TODAY, date_to=TODAY, from_date=None, to_date=None, from_hour=None,
            to_hour=None, tz="Asia/Jerusalem", **_ctx(w),
        ).totals
        assert (out.gross, out.discounts, out.production_voucher_deductions, out.net) == (10.0, 5.0, 40.0, 5.0)

    def test_the_discounts_report(self, booked):
        out = promotions_router.get_discounts_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz="Asia/Jerusalem", shop_id=None,
            machine_id=None, **_ctx(booked),
        )
        assert out["vouchers"]["totals"]["amount"] == 0.0
        assert out["productionVouchers"]["totals"] == {"count": 1, "uses": 1, "amount": 40.0, "documents": 1}

    def test_the_shift_totals_and_the_z_document(self, booked):
        w = booked
        totals = compute_totals(w.db, [w.booked_shift.id])
        # As the till's X: the deduction in neither the gross nor the discounts; the net the same.
        assert (totals.gross_sales, totals.discounts_total, totals.net_sales) == (Decimal("10.00"), Decimal("5.00"), Decimal("5.00"))
        assert totals.production_voucher_deductions_total == Decimal("40.00")
        assert totals.voucher_discounts_total == Decimal("0")

        class Z:
            total_sales = Decimal("5.00")
            total_refunds = Decimal("0")
            discounts_total = Decimal("5.00")
            transactions_count = 1
            header = {"productionVoucherDeductionsTotal": "40.00"}

        rows = {r["label"]: r["value"] for r in z_print._sales_rows(Z()) if r}
        assert (rows["מכירות ברוטו"], rows["הנחות"], rows["סה״כ נטו"]) == ("₪10.00", "-₪5.00", "₪5.00")
        (vouchers,) = z_print._voucher_sections(Z())
        assert (vouchers["title"], vouchers["rows"]) == ("שוברי הפקה", [{"label": "קיזוז שוברי הפקה", "value": "-₪40.00", "emphasis": False}])
        assert z_print._voucher_sections(type("Z0", (), {"header": {}})()) == []


def test_the_document_copy(booked):
    w = booked
    tx = w.db.query(Transaction).filter(Transaction.id == w.booked_id).one()
    doc = PD.build_invoice_copy(w.db, tx)
    section = {s.title: s.rows for s in doc.sections}
    labels = [(r.label, r.value) for r in section["סיכום"]]
    assert ('סה"כ פריטים', "₪50.00") in labels
    assert ("הנחה", "-₪5.00") in labels
    assert ("קיזוז שוברי הפקה", "-₪40.00") in labels
    i = [label for label, _v in labels].index("קיזוז שוברי הפקה")
    assert [label for label, _v in labels][i + 1:i + 4] == ["  שובר מס׳ 0008 · שובר ארוחה", "    1× המבורגר", "    1× שתייה קלה"]
    assert labels[-1] == ('סה"כ לתשלום', "₪5.00")
    # Not among the discount lines under the items.
    assert not any("שובר" in (r.label or "") for r in section.get("פריטים", []))


def test_the_uniform_file_carries_the_whole_discount(booked):
    from app.services import tax_reports as TR
    from test_open_format_131 import _check_document, c100, records

    w = booked
    w.shop.branch_id = "1"
    w.other_shop.branch_id = "2"
    w.db.flush()
    ctx = TR.resolve_export_context(w.db, company=w.company, shop=None, mode="date-range", from_date=TODAY, to_date=TODAY)
    result, _dicts, _zip = TR.build_tax_open_format_export(w.db, w.tenant.id, ctx, company_id=w.company.id, shop_id=None)
    (head, _rows), = _check_document(result)  # Σ D110 = 1219, 1219 + 1220 = 1221, Σ D120 = 1223
    # 1223 is the money settled (₪5); 1220, the document's discount before VAT, is the whole
    # ₪45 — the regular ₪5 and the voucher's ₪40 — as issued, never the voucher left out.
    assert head["1223"] == 500
    assert abs(head["1220"] + round(4500 / 1.18)) <= 1
    assert len(records(result, "D120")) == 1


def test_the_migration():
    import importlib.util
    import io
    import pathlib

    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / "8b5e2f4c9a17_production_voucher_deductions.py"
    spec = importlib.util.spec_from_file_location("migration_8b5e2f4c9a17", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "5d8a3c1e7b92"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE transaction_voucher_discounts (id CHAR(32) PRIMARY KEY, transaction_id CHAR(32), "
                             "kind VARCHAR(16), discount_amount NUMERIC(12, 2))"))
        conn.execute(sa.text("INSERT INTO transaction_voucher_discounts VALUES ('a', 't', 'order_discount', 30)"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        cols = {c["name"] for c in sa.inspect(conn).get_columns("transaction_voucher_discounts")}
        assert {"redemption_id", "type_name", "units"} <= cols
        assert conn.execute(sa.text("SELECT kind, discount_amount FROM transaction_voucher_discounts")).one() == ("order_discount", 30)
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    sql = buf.getvalue()
    assert "ALTER TABLE transaction_voucher_discounts ALTER COLUMN kind TYPE VARCHAR(32)" in sql
    assert "ADD COLUMN redemption_id UUID" in sql and "ADD COLUMN units JSON" in sql


class TestMemoLines:
    """`zero` mode (§4.3): ₪0 lines with the value as a memo — no unit sold, a memo-only document no document."""

    def test_out_of_the_counts_as_on_the_till(self, w):
        from app.models.transaction_item import TransactionItem

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        memo = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "8101", "status": "completed", "documentType": 320,
            "totalAmount": "0.00", "documentDiscount": "0", "paymentMethod": "cash", "payments": [],
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(shift.id), "businessDate": str(TODAY),
            "voucherMemo": True,
            "items": [{"id": str(uuid.uuid4()), "productId": str(w.hotdog.id), "productName": "נקניקייה", "quantity": 2,
                       "unitPrice": "0", "totalPrice": "0", "voucherMemoValueAgorot": 5000, "voucherRedemptionId": "r-1"}],
        })
        sold = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "8102", "status": "completed", "documentType": 320,
            "totalAmount": "25.00", "documentDiscount": "0", "paymentMethod": "cash",
            "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": "25.00"}],
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(shift.id), "businessDate": str(TODAY),
            "items": [{"id": str(uuid.uuid4()), "productId": str(w.hotdog.id), "productName": "נקניקייה", "quantity": 1,
                       "unitPrice": "25.00", "totalPrice": "25.00"}],
        })
        assert [r.status for r in upsert_transactions(w.db, till, [memo, sold])] == ["accepted", "accepted"]
        w.db.commit()
        line = w.db.query(TransactionItem).filter(TransactionItem.voucher_memo_value.isnot(None)).one()
        assert (line.voucher_memo_value, line.voucher_redemption_id) == (5000, "r-1")
        totals = compute_totals(w.db, [shift.id])
        assert (totals.transactions_count, totals.sales_count, totals.voucher_memo_documents) == (1, 1, 1)
        products = reports_router.get_product_sales_report(
            **report_args(), cashier_id=None, limit=50, area_id=None, meals="components", **_ctx(w))
        row = next(r for r in products.rows if r.product_name == "נקניקייה")
        assert row.units_sold == 1.0  # the memo line's 2 are no sale


def test_the_memo_migration():
    import importlib.util
    import io
    import pathlib

    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / "e2b6d9f41c83_production_voucher_memo_lines.py"
    spec = importlib.util.spec_from_file_location("migration_e2b6d9f41c83", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "c8e1f5a3b702"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE transactions (id CHAR(32) PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE transaction_items (id CHAR(32) PRIMARY KEY)"))
        conn.execute(sa.text("INSERT INTO transactions VALUES ('t1')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        assert {"prepaid_deduction", "voucher_memo_value", "voucher_redemption_id"} <= {
            c["name"] for c in sa.inspect(conn).get_columns("transaction_items")}
        assert conn.execute(sa.text("SELECT voucher_memo FROM transactions")).one()[0] in (0, False)
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    assert "ALTER TABLE transactions ADD COLUMN voucher_memo BOOLEAN DEFAULT false NOT NULL" in buf.getvalue()
