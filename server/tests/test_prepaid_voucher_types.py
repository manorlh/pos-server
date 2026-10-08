"""
Prepaid voucher types ("סוגי שוברי הפקה", the production vouchers spec §2–3, §5, §19.1).

What each class pins:

* **Types** — a type says what each voucher gives, its till value and its production price, how
  a redemption is priced and recorded; codes are unique among a company's active types; a change
  of terms is a new version, a change of name / code / active is not; every change is audited.
* **Batches from a type** — a batch copies the type (terms, goods, prices, version); a later
  change of the type never touches it; an inactive type or another company's issues nothing.
* **No voucher without a type** — a batch that names none gets one of its own (`origin` batch),
  priced as the tills already redeem (`payment` / `cover`, or `fixed` with a value).
* **The production price** — shown and set only with the `prepaid_voucher_prices` section; never
  reaches a till, never printed. The type's name and (when asked) the till value are printed.
* **The migration** — every existing batch gets a `legacy` type of its own; nothing it does changes.

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import re
import uuid

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucherBatch, PrepaidVoucherType
from app.models.user import User, UserRole
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherBatchCreate,
    PrepaidVoucherTypeCreate,
    PrepaidVoucherTypeUpdate,
)
from app.services import prepaid_voucher_pdf as PDF
from app.services import prepaid_voucher_types as PVT
from test_prepaid_vouchers import _ctx, first_code, lookup, refused, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]


def make_type(w, user=None, **extra):
    body = {
        "companyId": w.company.id, "name": "שובר ארוחה", "code": "meal",
        "items": [{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 1}],
        "tillValue": 80, "productionPrice": 60, **extra,
    }
    return R.create_prepaid_voucher_type(PrepaidVoucherTypeCreate(**body), **_ctx(w, user))


def batch_from(w, type_id, user=None, **extra):
    body = PrepaidVoucherBatchCreate(
        name="פסטיבל — יום א׳", companyId=w.company.id, typeId=type_id, eventName="פסטיבל הקיץ", count=2, **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w, user))


def patch(w, type_id, user=None, **fields):
    return R.update_prepaid_voucher_type(type_id, PrepaidVoucherTypeUpdate(**fields), **_ctx(w, user))


def company_manager(w):
    u = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, email="cm@x",
             username="cm", company_id=w.company.id)
    w.db.add(u)
    w.db.commit()
    return u


class TestTypes:
    def test_a_type_says_what_it_gives_and_its_two_prices(self, w):
        t = make_type(w)
        assert (t["code"], t["name"], t["origin"], t["version"], t["active"]) == ("MEAL", "שובר ארוחה", "manual", 1, True)
        assert [i["name"] for i in t["items"]] == ["נקניקייה", "שתייה"]
        assert (t["tillValue"], t["productionPrice"], t["pricesVisible"]) == (80.0, 60.0, True)
        # New types: a fixed value, a payment at the till, a package redeemed whole, online only,
        # the discount block honoured.
        assert (t["pricing"], t["redemptionAccounting"], t["allowTopUp"], t["splitAllowed"]) == ("fixed", "discount", False, False)
        assert (t["offlineAllowed"], t["discountBlockPolicy"]["mode"]) == (False, "honour")
        listed = R.list_prepaid_voucher_types(company_id=None, include_inactive=True, include_one_off=False, **_ctx(w))
        assert [x["id"] for x in listed["items"]] == [t["id"]]

    def test_a_fixed_value_needs_a_value_cover_does_not(self, w):
        with pytest.raises(ValueError):
            PrepaidVoucherTypeCreate(companyId=w.company.id, name="x", items=[{"productId": w.hotdog.id, "quantity": 1}])
        t = make_type(w, code="ANY", tillValue=None, productionPrice=None, pricing="cover")
        assert (t["pricing"], t["tillValue"], t["allowTopUp"]) == ("cover", None, True)

    def test_codes_are_unique_among_active_types(self, w):
        make_type(w)
        e = refused(make_type, w, name="אחר")
        assert (e.status_code, e.detail) == (409, PVT.TYPE_CODE_TAKEN)
        other = make_type(w, code="DRINK", name="שובר משקה")
        assert refused(patch, w, other["id"], code="meal").detail == PVT.TYPE_CODE_TAKEN

    def test_terms_make_a_new_version_names_do_not(self, w):
        t = make_type(w)
        out = patch(w, t["id"], name="שובר ארוחה גדולה")
        assert (out["name"], out["version"]) == ("שובר ארוחה גדולה", 1)
        out = patch(w, t["id"], tillValue=90)
        assert (out["tillValue"], out["version"]) == (90.0, 2)
        out = patch(w, t["id"], items=[{"productId": w.hotdog.id, "quantity": 2}])
        assert out["version"] == 3 and [i["quantity"] for i in out["items"]] == [2]
        events = R.prepaid_voucher_type_events(t["id"], **_ctx(w))["items"]
        assert [e["action"] for e in events] == ["update", "update", "update", "create"]
        assert events[1]["details"]["before"]["till_value"] == 8000 and events[1]["details"]["after"]["till_value"] == 9000
        out = patch(w, t["id"], active=False)
        assert out["active"] is False
        assert R.prepaid_voucher_type_events(t["id"], **_ctx(w))["items"][0]["action"] == "deactivate"

    def test_a_bad_change_of_terms_is_refused_whole(self, w):
        t = make_type(w)
        e = refused(patch, w, t["id"], tillValue=None, pricing="fixed")
        assert e.status_code == 422
        assert R.get_prepaid_voucher_type(t["id"], **_ctx(w))["tillValue"] == 80.0


class TestBatchesFromAType:
    def test_a_batch_copies_the_type(self, w):
        t = make_type(w)
        b = batch_from(w, t["id"])
        assert b["type"]["id"] == t["id"] and b["type"]["version"] == 1 and b["type"]["code"] == "MEAL"
        assert b["typeName"] == "שובר ארוחה"
        assert [i["name"] for i in b["items"]] == ["נקניקייה", "שתייה"]
        assert (b["tillValue"], b["productionPrice"], b["pricing"], b["redemptionAccounting"]) == (80.0, 60.0, "fixed", "discount")
        assert b["stats"]["total"] == 2

    def test_a_later_change_of_the_type_never_touches_the_batch(self, w):
        t = make_type(w)
        b1 = batch_from(w, t["id"])
        patch(w, t["id"], tillValue=95, items=[{"productId": w.drink.id, "quantity": 3}])
        again = R.get_prepaid_voucher_batch(b1["id"], **_ctx(w))
        assert (again["tillValue"], again["type"]["version"], again["type"]["currentVersion"]) == (80.0, 1, 2)
        assert [i["name"] for i in again["items"]] == ["נקניקייה", "שתייה"]
        b2 = batch_from(w, t["id"])
        assert (b2["tillValue"], b2["type"]["version"]) == (95.0, 2)
        assert [(i["name"], i["quantity"]) for i in b2["items"]] == [("שתייה", 3)]

    def test_what_the_body_says_besides_is_not_the_batchs(self, w):
        t = make_type(w)
        b = batch_from(w, t["id"], items=[{"productId": w.drink.id, "quantity": 5}], splitAllowed=True, tillValue=5)
        assert [i["quantity"] for i in b["items"]] == [1, 1]
        assert (b["splitAllowed"], b["tillValue"]) == (False, 80.0)

    def test_an_inactive_type_issues_nothing(self, w):
        t = make_type(w)
        patch(w, t["id"], active=False)
        assert refused(batch_from, w, t["id"]).detail == PVT.TYPE_INACTIVE

    def test_another_companys_type_issues_nothing(self, w):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="1")
        w.db.add(other)
        w.db.commit()
        t = make_type(w)
        body = PrepaidVoucherBatchCreate(name="x", companyId=other.id, typeId=t["id"], count=1)
        assert refused(R.create_prepaid_voucher_batch, body, **_ctx(w)).detail == PVT.TYPE_OTHER_COMPANY

    def test_the_till_reads_the_type_and_how_it_is_priced_never_the_production_price(self, w):
        t = make_type(w)
        b = batch_from(w, t["id"])
        out = lookup(w, first_code(w, b))
        assert (out["typeName"], out["typeCode"], out["tillValueAgorot"]) == ("שובר ארוחה", "MEAL", 8000)
        assert (out["pricing"], out["redemptionAccounting"], out["allowTopUp"], out["wholeAtOnce"]) == ("fixed", "discount", False, True)
        assert out["discountBlockPolicy"] == {"mode": "honour", "maxAmountAgorot": None, "maxPercentBp": None,
                                              "maxTotalAgorot": None, "scopeProductIds": None, "scopeCategoryIds": None}
        assert out["offline"]["allowed"] is False
        assert "productionPrice" not in str(out)


class TestEveryVoucherHasAType:
    def test_a_batch_without_a_type_gets_its_own(self, w):
        body = PrepaidVoucherBatchCreate(
            name="הפקה", companyId=w.company.id, items=[{"productId": w.hotdog.id, "quantity": 1}], count=1,
        )
        b = R.create_prepaid_voucher_batch(body, **_ctx(w))
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        t = w.db.get(PrepaidVoucherType, row.type_id)
        assert (t.origin, t.name, [i.product_name for i in t.items]) == ("batch", "הפקה", ["נקניקייה"])
        assert b["type"]["origin"] == "batch" and b["typeName"] is None
        # A new batch without a type: a payment at the goods' price (cover, no value).
        assert (b["pricing"], b["redemptionAccounting"], b["tillValue"]) == ("cover", "discount", None)
        # Not in the types screen by default; with the one-off types, there.
        listed = R.list_prepaid_voucher_types(company_id=None, include_inactive=True, include_one_off=True, **_ctx(w))
        assert [x["origin"] for x in listed["items"]] == ["batch"]

    def test_with_a_value_it_is_a_fixed_value(self, w):
        body = PrepaidVoucherBatchCreate(
            name="הפקה", companyId=w.company.id, items=[{"productId": w.hotdog.id, "quantity": 1}], count=1, tillValue=30,
        )
        b = R.create_prepaid_voucher_batch(body, **_ctx(w))
        assert (b["pricing"], b["redemptionAccounting"], b["tillValue"], b["allowTopUp"]) == ("fixed", "discount", 30.0, False)


class TestProductionPrice:
    def test_hidden_and_not_settable_without_the_section(self, w):
        cm = company_manager(w)
        assert PVT.prices_visible(w.db, cm) is False and PVT.prices_visible(w.db, w.admin) is True
        e = refused(make_type, w, cm)
        assert (e.status_code, e.detail) == (403, PVT.PRICES_FORBIDDEN)
        t = make_type(w, cm, productionPrice=None)
        assert (t["productionPrice"], t["pricesVisible"]) == (None, False)
        by_admin = make_type(w, code="DRINK", name="משקה")
        seen = R.get_prepaid_voucher_type(by_admin["id"], **_ctx(w, cm))
        assert seen["productionPrice"] is None and seen["tillValue"] == 80.0
        b = batch_from(w, by_admin["id"], cm)
        assert b["productionPrice"] is None
        assert R.get_prepaid_voucher_batch(b["id"], **_ctx(w))["productionPrice"] == 60.0

    def test_with_the_section_it_is_shown(self, w):
        from app.models.dashboard_access import DashboardAccessProfile

        cm = company_manager(w)
        w.db.add(DashboardAccessProfile(user_id=cm.id, full_access=False,
                                        sections={"prepaid_vouchers": "edit", "prepaid_voucher_prices": "edit"}))
        w.db.commit()
        t = make_type(w, cm)
        assert t["productionPrice"] == 60.0


class TestPaper:
    def test_the_type_name_and_the_till_value_when_asked(self, w):
        t = make_type(w, printTillValue=True)
        b = batch_from(w, t["id"])
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        content = PDF.card_content(row, row.vouchers[0], PDF.options_for(row))
        assert (content.kicker, content.value_line) == ("שובר ארוחה", "שווי השובר: ₪80")
        row.pricing = "cover"
        assert PDF.value_line(row) == "השובר מכסה עד ₪80"
        row.print_till_value = False
        assert PDF.value_line(row) is None
        # Never the production price.
        assert "60" not in " ".join(filter(None, [content.kicker, content.value_line, content.title]))


class TestMigration:
    def test_a_unique_revision_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        revision = "2c7e9a4f1d38"
        declaring = [
            p.name for p in (ROOT / "alembic" / "versions").glob("*.py")
            if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
        ]
        assert declaring == [f"{revision}_prepaid_voucher_types.py"]
        config = Config(str(ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision(revision).down_revision == "6b1e9d4f2a87"

    def test_every_existing_batch_gets_a_legacy_type_and_nothing_changes(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        path = ROOT / "alembic" / "versions" / "2c7e9a4f1d38_prepaid_voucher_types.py"
        spec = importlib.util.spec_from_file_location("migration_2c7e9a4f1d38", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for ddl in (
                "CREATE TABLE tenants (id CHAR(32) PRIMARY KEY)",
                "CREATE TABLE companies (id CHAR(32) PRIMARY KEY)",
                "CREATE TABLE users (id CHAR(32) PRIMARY KEY)",
                "CREATE TABLE products (id CHAR(32) PRIMARY KEY)",
                """CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY, tenant_id CHAR(32), company_id CHAR(32),
                    name VARCHAR, kind VARCHAR, split_allowed BOOLEAN, include_extras BOOLEAN, discount_type VARCHAR,
                    discount_value INTEGER, min_purchase INTEGER, max_discount INTEGER, max_units INTEGER, targets JSON,
                    stacking VARCHAR, promotion_policy VARCHAR, uses_per_voucher INTEGER, max_uses_per_sale INTEGER,
                    max_uses_per_day INTEGER, created_by CHAR(32), created_at TIMESTAMP)""",
                """CREATE TABLE prepaid_voucher_batch_items (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), product_id CHAR(32),
                    product_name VARCHAR, quantity NUMERIC(10,3), weighed BOOLEAN, unit_label VARCHAR, sort_order INTEGER)""",
                """INSERT INTO prepaid_voucher_batches VALUES ('b1', 't', 'c', 'הפקה ישנה', 'items', 1, 0, NULL, NULL, NULL,
                    NULL, NULL, NULL, 'unlimited', 'exclude', 1, 1, NULL, NULL, '2026-08-01 10:00:00')""",
                "INSERT INTO prepaid_voucher_batch_items VALUES ('i1', 'b1', 'p1', 'נקניקייה', 2, 0, NULL, 0)",
            ):
                conn.execute(sa.text(ddl))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            t = conn.execute(sa.text(
                "SELECT id, name, origin, kind, pricing, redemption_accounting, split_allowed, stacking, till_value, "
                "discount_block_policy, offline_allowed FROM prepaid_voucher_types")).all()
            assert [tuple(r) for r in t] == [
                ("b1", "הפקה ישנה", "legacy", "items", "cover", "zero", 1, "unlimited", None, "honour", 0)]
            items = conn.execute(sa.text("SELECT type_id, product_id, product_name FROM prepaid_voucher_type_items")).all()
            assert [tuple(r) for r in items] == [("b1", "p1", "נקניקייה")]
            b = conn.execute(sa.text(
                "SELECT type_id, type_version, pricing, redemption_accounting, allow_top_up, discount_block_policy, "
                "offline_allowed FROM prepaid_voucher_batches")).one()
            # The owner: legacy batches are "₪0 עם הצגת שווי" (editable per batch).
            assert tuple(b) == ("b1", 1, "cover", "zero", 1, "honour", 0)
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "CREATE TABLE prepaid_voucher_types" in sql and "INSERT INTO prepaid_voucher_types" in sql
        assert "ALTER TABLE prepaid_voucher_batches ALTER COLUMN type_id SET NOT NULL" in sql


class TestToggles:
    """`redemption_accounting`, `discount_block_policy`, `offline_allowed` — set at setup, editable after issue."""

    def test_an_override_policy_needs_its_section(self, w):
        cm = company_manager(w)
        policy = {"mode": "auto", "maxAmount": 10, "maxPercent": 25, "maxTotal": 30}
        e = refused(make_type, w, cm, productionPrice=None, discountBlockPolicy=policy)
        assert (e.status_code, e.detail) == (403, PVT.OVERRIDE_FORBIDDEN)
        t = make_type(w, discountBlockPolicy=policy)
        assert t["discountBlockPolicy"] == {"mode": "auto", "maxAmount": 10.0, "maxPercent": 25.0, "maxTotal": 30.0, "scope": None}
        b = batch_from(w, t["id"])
        out = lookup(w, first_code(w, b))
        assert (out["discountBlockPolicy"]["maxAmountAgorot"], out["discountBlockPolicy"]["maxPercentBp"],
                out["discountBlockPolicy"]["maxTotalAgorot"]) == (1000, 2500, 3000)

    def test_a_scope_of_the_tenants_products_and_categories(self, w):
        policy = {"mode": "manager", "scope": {"productIds": [str(w.hotdog.id)], "categoryIds": []}}
        t = make_type(w, discountBlockPolicy=policy)
        assert t["discountBlockPolicy"]["scope"] == {"productIds": [str(w.hotdog.id)], "categoryIds": []}
        bad = {"mode": "auto", "scope": {"productIds": [str(uuid.uuid4())], "categoryIds": []}}
        assert refused(make_type, w, code="X2", discountBlockPolicy=bad).status_code == 400

    def test_honour_drops_the_caps(self, w):
        t = make_type(w, discountBlockPolicy={"mode": "honour", "maxAmount": 10})
        assert t["discountBlockPolicy"]["maxAmount"] is None

    def test_editable_on_a_batch_after_issue_and_logged(self, w):
        from app.schemas.prepaid_voucher import PrepaidVoucherBatchUpdate

        t = make_type(w)
        b = batch_from(w, t["id"])
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(
            redemptionAccounting="payment", offlineAllowed=True, discountBlockPolicy={"mode": "auto"}), **_ctx(w))
        assert (out["redemptionAccounting"], out["offlineAllowed"], out["discountBlockPolicy"]["mode"]) == ("payment", True, "auto")
        events = R.prepaid_voucher_events(b["id"], **_ctx(w))["items"]
        assert set(events[0]["details"]["fields"]) >= {"redemption_accounting", "offline_allowed", "discount_block_policy"}
        # A null never clears a toggle.
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(redemptionAccounting=None), **_ctx(w))
        assert out["redemptionAccounting"] == "payment"
        # The type is untouched by its batch.
        assert R.get_prepaid_voucher_type(t["id"], **_ctx(w))["redemptionAccounting"] == "discount"

    def test_a_discount_voucher_is_never_a_payment(self, w):
        t = make_type(w, code="D", name="הנחה", items=[], kind="order_discount", discountType="fixed", discountValue=30,
                      tillValue=None, productionPrice=None)
        assert t["redemptionAccounting"] == "discount"


class TestRedemptionAccounting:
    """How the till books a redemption: discount (default) / payment / zero (legacy)."""

    def test_the_three_modes(self, w):
        t = make_type(w)
        assert (t["redemptionAccounting"], t["showValidity"]) == ("discount", True)
        for n, mode in enumerate(("payment", "zero")):
            x = make_type(w, code=f"M{n}", name=f"סוג {n}", redemptionAccounting=mode)
            assert x["redemptionAccounting"] == mode
            b = batch_from(w, x["id"])
            assert b["redemptionAccounting"] == mode
            assert lookup(w, first_code(w, b))["redemptionAccounting"] == mode

    def test_an_unknown_mode_is_refused(self, w):
        with pytest.raises(ValueError):
            PrepaidVoucherTypeCreate(companyId=w.company.id, name="x", items=[{"productId": w.hotdog.id, "quantity": 1}],
                                     tillValue=10, redemptionAccounting="exempt")

    def test_the_till_reads_the_production_name(self, w):
        t = make_type(w)
        b = batch_from(w, t["id"], customerName="קייטרינג אלון")
        assert lookup(w, first_code(w, b))["productionName"] == "קייטרינג אלון"
