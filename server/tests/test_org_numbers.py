"""
Company and shop numbers: companies 1, 2, 3 per tenant, shops 1, 2 per company.

* Consecutive per owner, drawn at creation, never reused — a deleted company or shop
  leaves its number spent (the counter only moves forward).
* A shop moved to another company draws that company's next number.
* The migration numbers existing rows in creation order and seeds the counters past them.
* `GET /machines/me` and the machines list carry `companyNumber` and `shopNumber`.
"""
from __future__ import annotations

import importlib.util
import pathlib
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from app.models.company import Company
from app.models.org_number_sequence import KIND_COMPANY, KIND_SHOP, OrgNumberSequence
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.routers import machines as machines_router
from app.services import org_numbers as N
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _company(w, name, tenant=None, created=None) -> Company:
    c = Company(
        id=uuid.uuid4(), tenant_id=(tenant or w.tenant).id, name=name,
        **({"created_at": created} if created else {}),
    )
    w.db.add(c)
    w.db.flush()
    return c


def _shop(w, company, name, created=None) -> Shop:
    s = Shop(
        id=uuid.uuid4(), tenant_id=company.tenant_id, company_id=company.id, name=name,
        settings={}, **({"created_at": created} if created else {}),
    )
    w.db.add(s)
    w.db.flush()
    return s


class TestCompanyNumbers:
    def test_consecutive_per_tenant(self, w):
        # The world's own company has no number yet; it is first in line.
        numbers = [N.assign_company_number(w.db, c) for c in (w.company, _company(w, "B"), _company(w, "C"))]
        assert numbers == [1, 2, 3]

    def test_each_tenant_has_its_own_run(self, w):
        other = Tenant(id=uuid.uuid4(), name="O", slug="o", timezone="Asia/Jerusalem")
        w.db.add(other)
        w.db.flush()
        N.assign_company_number(w.db, w.company)
        assert N.assign_company_number(w.db, _company(w, "X", tenant=other)) == 1

    def test_a_number_is_kept(self, w):
        N.assign_company_number(w.db, w.company)
        assert N.assign_company_number(w.db, w.company) == 1
        assert N.assign_company_number(w.db, _company(w, "B")) == 2

    def test_never_reused_after_delete(self, w):
        N.assign_company_number(w.db, w.company)
        doomed = _company(w, "Doomed")
        assert N.assign_company_number(w.db, doomed) == 2
        w.db.delete(doomed)
        w.db.flush()
        assert N.assign_company_number(w.db, _company(w, "Next")) == 3

    def test_a_company_without_a_tenant_has_none(self, w):
        c = Company(id=uuid.uuid4(), tenant_id=None, name="Loose")
        w.db.add(c)
        w.db.flush()
        assert N.assign_company_number(w.db, c) is None

    def test_a_run_without_a_counter_continues_past_numbers_already_given(self, w):
        w.company.company_number = 7
        w.db.flush()
        assert N.assign_company_number(w.db, _company(w, "B")) == 8


class TestShopNumbers:
    def test_consecutive_per_company(self, w):
        assert [N.assign_shop_number(w.db, s) for s in (w.shop, w.other_shop, _shop(w, w.company, "C"))] == [1, 2, 3]

    def test_each_company_has_its_own_run(self, w):
        N.assign_shop_number(w.db, w.shop)
        other = _company(w, "Other")
        assert N.assign_shop_number(w.db, _shop(w, other, "First")) == 1

    def test_never_reused_after_delete(self, w):
        N.assign_shop_number(w.db, w.shop)
        doomed = _shop(w, w.company, "Doomed")
        assert N.assign_shop_number(w.db, doomed) == 2
        w.db.delete(doomed)
        w.db.flush()
        assert N.assign_shop_number(w.db, _shop(w, w.company, "Next")) == 3

    def test_a_shop_moved_to_another_company_draws_that_companys_next(self, w):
        N.assign_shop_number(w.db, w.shop)
        N.assign_shop_number(w.db, w.other_shop)
        other = _company(w, "Other")
        N.assign_shop_number(w.db, _shop(w, other, "Theirs"))

        assert N.set_shop_company(w.db, w.other_shop, other.id) == 2
        # Its old number stays spent in the old company.
        assert N.assign_shop_number(w.db, _shop(w, w.company, "New")) == 3

    def test_moving_to_the_same_company_changes_nothing(self, w):
        N.assign_shop_number(w.db, w.shop)
        assert N.set_shop_company(w.db, w.shop, w.company.id) == 1

    def test_the_peek_takes_nothing(self, w):
        N.assign_shop_number(w.db, w.shop)
        assert N.peek_next_shop_number(w.db, w.company.id) == 2
        assert N.peek_next_shop_number(w.db, w.company.id) == 2
        assert N.assign_shop_number(w.db, w.other_shop) == 2


class TestTheBackfill:
    def _upgrade(self, w, monkeypatch):
        path = next(
            pathlib.Path(__file__).resolve().parents[1].glob(
                "alembic/versions/f0a1b2c3d4eb_*.py"
            )
        )
        spec = importlib.util.spec_from_file_location("org_numbers_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "context", SimpleNamespace(is_offline_mode=lambda: False))

        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        w.db.flush()
        conn = w.db.connection()
        # SQLite spells Postgres' GREATEST as a two-argument max.
        conn.connection.driver_connection.create_function("GREATEST", 2, max)
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
        w.db.expire_all()

    def test_numbers_in_creation_order_and_seeds_the_counters(self, w, monkeypatch):
        t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        # Created out of name order, so creation order is what is being tested.
        w.company.created_at = t0 + timedelta(days=2)
        first = _company(w, "Zeta", created=t0)
        second = _company(w, "Alpha", created=t0 + timedelta(days=1))
        w.shop.created_at = t0 + timedelta(days=5)
        w.other_shop.created_at = t0 + timedelta(days=3)
        theirs = _shop(w, first, "Only", created=t0)

        self._upgrade(w, monkeypatch)

        assert [first.company_number, second.company_number, w.company.company_number] == [1, 2, 3]
        assert [w.other_shop.shop_number, w.shop.shop_number] == [1, 2]
        assert theirs.shop_number == 1
        counters = {
            (r.kind, r.owner_id): r.next_value for r in w.db.query(OrgNumberSequence).all()
        }
        assert counters[(KIND_COMPANY, w.tenant.id)] == 4
        assert counters[(KIND_SHOP, w.company.id)] == 3
        assert counters[(KIND_SHOP, first.id)] == 2

    def test_a_rerun_continues_above_the_counter(self, w, monkeypatch):
        self._upgrade(w, monkeypatch)
        # A company created and deleted since: its number is spent in the counter only.
        N.assign_company_number(w.db, _company(w, "Gone"))
        gone = w.db.query(Company).filter(Company.name == "Gone").one()
        w.db.delete(gone)
        late = _company(w, "Late")

        self._upgrade(w, monkeypatch)

        assert late.company_number == 3


class TestTheTillSeesThem:
    def test_machines_me(self, w):
        N.assign_company_number(w.db, w.company)
        N.assign_shop_number(w.db, w.shop)
        out = machines_router.get_my_machine(machine=w.tills[0])
        assert (out["companyNumber"], out["shopNumber"], out["posNumber"]) == (1, 1, "1")

    def test_a_shopless_till_has_neither(self, w):
        till = w.tills[0]
        till.shop_id = None
        w.db.flush()
        w.db.refresh(till)
        out = machines_router.get_my_machine(machine=till)
        assert (out["companyNumber"], out["shopNumber"]) == (None, None)

    def test_the_machines_list(self, w):
        N.assign_company_number(w.db, w.company)
        N.assign_shop_number(w.db, w.shop)
        row = machines_router._enrich_machines_batch([w.tills[0]], w.db)[0]
        assert (row["companyNumber"], row["shopNumber"]) == (1, 1)
