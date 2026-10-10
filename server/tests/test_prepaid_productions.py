"""
Productions ("הפקות", the production vouchers contract §13) and a batch's event (the existing
report events): a company's production with its contact and billing basis; a batch names it (its
name becomes the batch's `customerName`, a rename reaches the batches) and an event (the printed
event name defaults to it); the filters take either's id as well as the legacy text; "ערוך סדרה"
changes both as free settings; the migration moves every customer name into a production.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.prepaid_voucher import PrepaidProduction, PrepaidVoucherBatch
from app.models.report_event import ReportEvent
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidProductionCreate,
    PrepaidProductionUpdate,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
)
from app.services import prepaid_productions as PPR
from app.services import prepaid_voucher_analytics as A
from test_prepaid_vouchers import _ctx, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def production(w, name="הפקות כהן", **kw):
    return R.create_prepaid_production(PrepaidProductionCreate(companyId=w.company.id, name=name, **kw), **_ctx(w))


def batch(w, **kw):
    body = {"name": "פסטיבל", "companyId": w.company.id, "count": 1, "redemptionAccounting": "payment",
            "items": [{"productId": w.hotdog.id, "quantity": 1}], **kw}
    return R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(**body), **_ctx(w))


def event(w, name="פסטיבל הקיץ"):
    now = datetime.now(timezone.utc)
    ev = ReportEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id, name=name,
                     starts_at=now, ends_at=now + timedelta(days=2))
    w.db.add(ev)
    w.db.commit()
    return ev


def listed(w, **scope):
    return A.list_batches(w.db, w.admin, w.tenant.id, A.make_scope(**scope))["items"]


class TestProductions:
    def test_created_listed_and_one_name_per_company(self, w):
        p = production(w, contactName="יעל", contactPhone="050-1234567", billingBasis="delivery")
        assert (p["name"], p["contactName"], p["billingBasis"], p["active"], p["batchCount"]) == (
            "הפקות כהן", "יעל", "delivery", True, 0)
        assert refused(production, w, name="  הפקות כהן ").detail == PPR.PRODUCTION_NAME_TAKEN
        assert production(w, name="Acme")["name"] == "Acme"
        assert refused(production, w, name="ACME").detail == PPR.PRODUCTION_NAME_TAKEN
        batch(w, productionId=p["id"])
        rows = {r["name"]: r for r in R.list_prepaid_productions(company_id=None, include_inactive=False, **_ctx(w))["items"]}
        assert (rows["הפקות כהן"]["id"], rows["הפקות כהן"]["batchCount"], rows["Acme"]["batchCount"]) == (p["id"], 1, 0)

    def test_a_rename_reaches_its_batches_and_inactive_ones_take_no_new_batch(self, w):
        p = production(w)
        b = batch(w, productionId=p["id"], customerName="ignored")
        assert (b["customerName"], b["production"]["name"]) == ("הפקות כהן", "הפקות כהן")
        R.update_prepaid_production(p["id"], PrepaidProductionUpdate(name="כהן הפקות"), **_ctx(w))
        assert w.db.query(PrepaidVoucherBatch).one().customer_name == "כהן הפקות"
        R.update_prepaid_production(p["id"], PrepaidProductionUpdate(active=False), **_ctx(w))
        assert refused(batch, w, productionId=p["id"]).detail == PPR.PRODUCTION_INACTIVE
        assert R.list_prepaid_productions(company_id=None, include_inactive=False, **_ctx(w))["items"] == []

    def test_another_companys_production_is_refused(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="512345678")
        w.db.add(other)
        w.db.add(PrepaidProduction(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="זרה"))
        w.db.commit()
        foreign = w.db.query(PrepaidProduction).filter(PrepaidProduction.name == "זרה").one()
        assert refused(batch, w, productionId=foreign.id).detail == PPR.PRODUCTION_OTHER_COMPANY
        assert refused(batch, w, productionId=uuid.uuid4()).detail == PPR.PRODUCTION_NOT_FOUND


class TestEvents:
    def test_a_batch_names_a_report_event_and_its_name_is_printed_by_default(self, w):
        ev = event(w)
        b = batch(w, reportEventId=ev.id)
        assert (b["eventName"], b["reportEvent"]["name"], b["reportEvent"]["id"]) == ("פסטיבל הקיץ", "פסטיבל הקיץ", str(ev.id))
        assert batch(w, reportEventId=ev.id, eventName="שם מודפס אחר")["eventName"] == "שם מודפס אחר"
        assert refused(batch, w, reportEventId=uuid.uuid4()).detail == PPR.EVENT_INVALID
        # A shop manager names only an event of a shop they see.
        north = ReportEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.other_shop.id,
                            name="צפון", starts_at=ev.starts_at, ends_at=ev.ends_at)
        w.db.add(north)
        w.db.commit()
        body = PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, redemptionAccounting="payment",
                                         shopIds=[w.shop.id], items=[{"productId": w.hotdog.id, "quantity": 1}], reportEventId=north.id)
        assert refused(R.create_prepaid_voucher_batch, body, **_ctx(w, w.manager)).detail == PPR.EVENT_INVALID
        assert [e["name"] for e in R.list_prepaid_voucher_events(company_id=None, **_ctx(w, w.manager))["items"]] == ["פסטיבל הקיץ"]
        # The admin sees both, newest first; each with its shop.
        rows = {e["id"]: e["shopName"] for e in R.list_prepaid_voucher_events(company_id=None, **_ctx(w))["items"]}
        assert rows == {str(ev.id): w.shop.name, str(north.id): w.other_shop.name}


class TestFiltersAndEdit:
    def test_the_filters_take_an_id_or_the_legacy_text(self, w):
        p = production(w)
        ev = event(w)
        linked = batch(w, productionId=p["id"], reportEventId=ev.id)
        legacy = batch(w, customerName="קייטרינג אלון", eventName="ישן")
        assert [b["id"] for b in listed(w, customer=[p["id"]])] == [linked["id"]]
        assert [b["id"] for b in listed(w, customer=["קייטרינג אלון"])] == [legacy["id"]]
        assert [b["id"] for b in listed(w, event=[str(ev.id)])] == [linked["id"]]
        assert [b["id"] for b in listed(w, event=["ישן"])] == [legacy["id"]]

    def test_ערוך_סדרה_changes_both_freely(self, w):
        p = production(w)
        ev = event(w)
        b = batch(w, customerName="ישן")
        plan = R.preview_prepaid_voucher_batch_edit(
            b["id"], PrepaidVoucherBatchUpdate(productionId=p["id"], reportEventId=ev.id), **_ctx(w))
        assert plan["confirm"] is False
        changes = {c["field"]: c for c in plan["changes"]}
        assert changes["productionId"]["after"] == {"id": p["id"], "name": "הפקות כהן"}
        assert changes["reportEventId"]["after"] == {"id": str(ev.id), "name": "פסטיבל הקיץ"}
        assert (changes["customerName"]["before"], changes["customerName"]["after"]) == ("ישן", "הפקות כהן")
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(productionId=p["id"], reportEventId=ev.id), **_ctx(w))
        assert (out["production"]["id"], out["reportEvent"]["id"], out["customerName"]) == (p["id"], str(ev.id), "הפקות כהן")
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(productionId=None), **_ctx(w))
        assert (out["production"], out["customerName"]) == (None, "הפקות כהן")


def test_the_migration_moves_every_customer_name_into_a_production():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = ROOT / "alembic" / "versions" / "a7d4e9c2b158_prepaid_productions.py"
    spec = importlib.util.spec_from_file_location("migration_a7d4e9c2b158", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "f3a9c1d7e520"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY, tenant_id CHAR(32), "
                             "company_id CHAR(32), customer_name VARCHAR(200))"))
        # Review 09.10: names that differ only in case or spaces are one production.
        conn.execute(sa.text("INSERT INTO prepaid_voucher_batches VALUES ('b1', 't', 'c', 'כהן'), ('b2', 't', 'c', 'כהן '), "
                             "('b3', 't', 'c', 'אלון'), ('b4', 't', 'c2', 'כהן'), ('b5', 't', 'c', NULL), "
                             "('b6', 't', 'c', 'Acme'), ('b7', 't', 'c', 'ACME')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent: nothing more
        rows = conn.execute(sa.text("SELECT company_id, name FROM prepaid_productions ORDER BY company_id, name")).all()
        assert [tuple(r) for r in rows] == [("c", "Acme"), ("c", "אלון"), ("c", "כהן"), ("c2", "כהן")]
        linked = dict(conn.execute(sa.text(
            "SELECT b.id, p.name FROM prepaid_voucher_batches b LEFT JOIN prepaid_productions p ON p.id = b.production_id")).all())
        assert linked == {"b1": "כהן", "b2": "כהן", "b3": "אלון", "b4": "כהן", "b5": None, "b6": "Acme", "b7": "Acme"}
        # The batches carry their production's name; the index refuses a name differing in case only.
        assert conn.execute(sa.text("SELECT customer_name FROM prepaid_voucher_batches WHERE id = 'b7'")).scalar() == "Acme"
        with pytest.raises(sa.exc.IntegrityError):
            conn.execute(sa.text("INSERT INTO prepaid_productions (id, tenant_id, company_id, name, billing_basis, active) "
                                 "VALUES ('x', 't', 'c', 'acme', 'redemption', 1)"))
        assert "report_event_id" in {c["name"] for c in sa.inspect(conn).get_columns("prepaid_voucher_batches")}
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    sql = buf.getvalue()
    assert "CREATE TABLE prepaid_productions" in sql and "ON CONFLICT (tenant_id, company_id, lower(name)) DO NOTHING" in sql
    assert "CREATE UNIQUE INDEX ux_prepaid_productions_name ON prepaid_productions (tenant_id, company_id, lower(name))" in sql
    assert "ON DELETE SET NULL" in sql
    assert "ALTER TABLE prepaid_voucher_batches ADD COLUMN report_event_id UUID" in sql
