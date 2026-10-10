"""
Moving a till to another shop releases its offline voucher assignments (fix/voucher-print's
follow-up, register_number.set_machine_shop), and that release never fails the move
(decision 09.10):

* it runs once the till is settled in its new shop: the release flushes, and a flush of a
  half-moved till (the new shop with the old shop's register number) broke
  uq_pos_machines_shop_pos_number whenever the new shop already had that number — the move
  then failed;
* it runs in a SAVEPOINT: a failure inside it rolls back to the savepoint, the release's own
  writes go, and the move's transaction stays usable. On Postgres a failed statement aborts the
  whole transaction otherwise — the opt-in check at the end runs it there (on a scratch
  database, inside a transaction that is rolled back).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from app.models.prepaid_voucher import PrepaidVoucherOfflineAssignment
from app.services import document_prefix, prepaid_voucher_offline, register_number
from app.services.register_number import set_machine_shop
from test_prepaid_vouchers import w  # noqa: F401 — `w` is the fixture
from test_production_voucher_offline import assign, batch


@pytest.fixture
def numbers(monkeypatch):
    """The register number's own rules are Postgres SQL (a regex), not this test's: a fixed next number."""
    def assign_number(db, machine):
        if machine.shop_id is not None and machine.pos_number is None:
            machine.pos_number = "9"
        return machine.pos_number

    monkeypatch.setattr(register_number, "assign_register_number", assign_number)
    monkeypatch.setattr(document_prefix, "settle_default", lambda db, m: None)


def _assignment(w) -> PrepaidVoucherOfflineAssignment:
    return w.db.query(PrepaidVoucherOfflineAssignment).one()


def test_a_till_moves_into_a_shop_that_already_has_its_number(w, numbers):
    till = w.tills[0]
    assign(w, batch(w), till)
    w.other_till.pos_number = till.pos_number           # the new shop's till 1 too
    w.db.commit()

    set_machine_shop(w.db, till, w.other_shop.id)
    w.db.commit()
    w.db.refresh(till)
    assert (till.shop_id, till.pos_number) == (w.other_shop.id, "9")
    a = _assignment(w)
    assert (a.status, a.forced) == ("released", True)


def test_a_failing_release_never_fails_the_move(w, numbers, monkeypatch):
    till = w.tills[0]
    assign(w, batch(w), till)
    w.db.commit()

    def broken_release(db, machine):
        a = db.query(PrepaidVoucherOfflineAssignment).one()
        a.status = "released"                              # written, then the release fails
        db.flush()
        db.execute(text("SELECT no_such_column FROM no_such_table"))

    monkeypatch.setattr(prepaid_voucher_offline, "released_on_machine_move", broken_release)
    # Recorded here rather than through caplog: another test's logging setup may stop propagation.
    logged = []
    monkeypatch.setattr(register_number.logger, "exception", lambda msg, *args, **kw: logged.append(msg % args))
    set_machine_shop(w.db, till, w.other_shop.id)
    w.db.execute(text("SELECT 1"))                         # the transaction is still usable
    w.db.commit()
    w.db.refresh(till)
    assert (till.shop_id, till.pos_number) == (w.other_shop.id, "9")
    assert _assignment(w).status == "active"               # the release's write went with its savepoint
    assert len(logged) == 1 and "offline assignments were not released" in logged[0]


def test_a_till_that_stays_in_its_shop_releases_nothing(w, numbers, monkeypatch):
    till = w.tills[0]
    calls = []
    monkeypatch.setattr(prepaid_voucher_offline, "released_on_machine_move", lambda db, m: calls.append(m.id))
    set_machine_shop(w.db, till, till.shop_id)
    assert calls == []


@pytest.mark.skipif(
    os.environ.get("RUN_PG_MACHINE_MOVE_CHECK") != "1" or not os.environ.get("DATABASE_URL", "").startswith("postgresql"),
    reason="opt-in: RUN_PG_MACHINE_MOVE_CHECK=1 with a scratch Postgres DATABASE_URL",
)
def test_postgres_a_failing_release_leaves_the_move_transaction_usable(monkeypatch):
    """On Postgres, inside one transaction that is rolled back at the end (nothing is kept)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.database import Base
    from app.models.company import Company
    from app.models.pos_machine import PairingStatus, POSMachine
    from app.models.shop import Shop
    from app.models.tenant import Tenant
    from app.models.user import User, UserRole

    engine = create_engine(os.environ["DATABASE_URL"])
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        Base.metadata.create_all(conn)                     # inside the transaction: rolled back too
        tag = uuid.uuid4().hex[:10]
        tenant = Tenant(id=uuid.uuid4(), name="T", slug=f"t-{tag}", timezone="Asia/Jerusalem")
        db.add(tenant)
        db.flush()
        company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="Acme", vat_number="515151515")
        db.add(company)
        db.flush()
        shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="Center", settings={})
        north = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="North", settings={})
        db.add_all([shop, north])
        db.flush()
        admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email=f"a-{tag}@x",
                     username=f"admin-{tag}")
        db.add(admin)
        db.flush()

        def till(name, s, number):
            m = POSMachine(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=s.id, distributor_id=admin.id, name=name,
                           machine_code=f"M-{tag}-{name}", pos_number=number, is_active=True,
                           pairing_status=PairingStatus.ASSIGNED, last_heartbeat_at=datetime.now(timezone.utc))
            db.add(m)
            return m

        moving = till("Center 1", shop, "1")
        till("North 1", north, "1")                         # the new shop has its number too
        db.flush()

        def broken_release(session, machine):
            session.execute(text("SELECT 1/0"))             # aborts a Postgres transaction without a savepoint

        monkeypatch.setattr(prepaid_voucher_offline, "released_on_machine_move", broken_release)
        set_machine_shop(db, moving, north.id)              # the real register number and prefix rules
        db.flush()
        assert db.execute(text("SELECT 1")).scalar() == 1   # still usable: the failure stayed in its savepoint
        db.refresh(moving)
        assert moving.shop_id == north.id and moving.pos_number not in (None, "1")
    finally:
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()
