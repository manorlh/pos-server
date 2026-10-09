"""
The redemption record (the production vouchers contract §5): what each redemption was — its
accounting mode and pricing, its value, the units with their names, quantities and list values,
the voucher's number, its type / production / batch names. And the migration that adds it, the
goods holds, the override audit and the groups.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib

from app.models.prepaid_voucher import PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from test_prepaid_voucher_types import batch_from, make_type
from test_prepaid_vouchers import _ctx, first_code, make_batch, redeem, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]


class TestTheRecord:
    def test_a_list_price_redemption(self, w):
        b = make_batch(w, count=1)  # payment, cover: hotdog ×1, drink ×2
        out = redeem(w, first_code(w, b), [(w.hotdog, 1), (w.drink, 2)])
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.redemption_accounting, r.pricing, r.serial, r.batch_name) == ("payment", "cover", 1, "הפקה — פסטיבל")
        assert (r.list_value_agorot, r.value_agorot, r.covered_agorot, r.top_up_agorot) == (4900, 4900, 4900, 0)
        assert sorted((u["productName"], u["quantity"], u["listValueAgorot"]) for u in r.units) == [
            ("נקניקייה", 1, 2500), ("שתייה", 2, 2400)]
        hist = R.get_prepaid_voucher(out["voucher"]["voucherId"], **_ctx(w))["redemptions"][0]
        assert (hist["accounting"], hist["value"], hist["listValue"]) == ("payment", 49.0, 49.0)
        assert [u["productName"] for u in hist["units"]] == ["נקניקייה", "שתייה"]

    def test_a_fixed_value_is_held_then_confirmed_and_the_names(self, w):
        import uuid as _uuid

        import pytest
        from fastapi import HTTPException

        from app.schemas.prepaid_voucher import PrepaidVoucherConfirmIn, PrepaidVoucherReserveIn
        from app.services import prepaid_vouchers as PV

        t = make_type(w, tillValue=80)  # hotdog ×1 + drink ×1, ₪80, a deduction
        b = batch_from(w, t["id"], customerName="קייטרינג אלון")
        # Never the immediate redeem: no cap, no top-up, no override there (review 09.10).
        with pytest.raises(HTTPException) as e:
            redeem(w, first_code(w, b), [(w.hotdog, 1), (w.drink, 1)], features=["accounting", "reserve_goods"])
        assert e.value.detail == PV.RESERVE_REQUIRED
        till = w.tills[0]
        units = [{"productId": str(p.id), "productName": p.name, "quantity": 1, "listPriceAgorot": price}
                 for p, price in ((w.hotdog, 2500), (w.drink, 1200))]
        held = R.reserve_prepaid_voucher(str(till.id), PrepaidVoucherReserveIn(
            code=first_code(w, b), clientRequestId=str(_uuid.uuid4()), saleRef="s1", units=units,
            features=["accounting", "reserve_goods"]), machine=till, db=w.db)
        R.confirm_prepaid_reservation(str(till.id), held["reservationId"], PrepaidVoucherConfirmIn(
            transactionId="tx-1", amountAgorot=held["coveredAgorot"]), machine=till, db=w.db)
        r = w.db.query(PrepaidVoucherRedemption).one()
        assert (r.redemption_accounting, r.pricing, r.value_agorot, r.list_value_agorot) == ("discount", "fixed", 8000, 3700)
        assert (r.type_name, r.production_name) == ("שובר ארוחה", "קייטרינג אלון")


def test_the_migration():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = ROOT / "alembic" / "versions" / "a3f7c2d9e614_production_vouchers_record_groups.py"
    spec = importlib.util.spec_from_file_location("migration_a3f7c2d9e614", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "8b5e2f4c9a17"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        for ddl in (
            "CREATE TABLE tenants (id CHAR(32) PRIMARY KEY)",
            "CREATE TABLE prepaid_voucher_redemptions (id CHAR(32) PRIMARY KEY, items JSON)",
            "CREATE TABLE prepaid_voucher_reservations (id CHAR(32) PRIMARY KEY)",
            "CREATE TABLE prepaid_voucher_types (id CHAR(32) PRIMARY KEY)",
            "CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY)",
            "INSERT INTO prepaid_voucher_batches VALUES ('b1')",
            "INSERT INTO prepaid_voucher_redemptions VALUES ('r1', '[]')",
        ):
            conn.execute(sa.text(ddl))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        insp = sa.inspect(conn)
        assert {"value_agorot", "units", "serial", "type_name", "offline", "approved_by_pos_user_name"} <= {
            c["name"] for c in insp.get_columns("prepaid_voucher_redemptions")}
        assert "goods" in {c["name"] for c in insp.get_columns("prepaid_voucher_reservations")}
        assert insp.has_table("prepaid_voucher_override_audits")
        assert conn.execute(sa.text("SELECT selection, catalog_mode FROM prepaid_voucher_batches")).one() == ("items", "frozen")
        assert conn.execute(sa.text("SELECT offline FROM prepaid_voucher_redemptions")).one()[0] in (0, False)
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    sql = buf.getvalue()
    assert "CREATE TABLE prepaid_voucher_override_audits" in sql
    assert "ALTER TABLE prepaid_voucher_batches ADD COLUMN selection VARCHAR(8) DEFAULT 'items' NOT NULL" in sql
