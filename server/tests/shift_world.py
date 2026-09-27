"""
An in-memory SQLite world for the shift and Z tests.

Local, private to each test, never the configured database (the suite runs with the
`no_real_db` plugin, which also turns `create_all` into a no-op — so the tables a test
needs are created one by one here, as tests/test_product_availability.py does).

SQLite differs from Postgres in two ways that matter here and are handled: JSONB is
compiled to JSON, and the one-open-shift partial index carries a `sqlite_where` so the
rule is enforced here too. `FOR UPDATE` is accepted and ignored by SQLite, so the
locking itself is asserted on compiled Postgres SQL rather than exercised.
"""
from __future__ import annotations

import itertools
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional

from sqlalchemy import create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker

from app.database import Base
import app.models  # noqa: F401  (every mapper, so relationships resolve)
from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.user import User, UserRole


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


TABLES = [
    "tenants", "users", "companies", "shops", "pos_users", "pos_machines",
    "categories", "vouchers", "products", "customers",
    "z_reports", "shifts", "transactions", "transaction_items", "transaction_payments",
    "issued_vouchers", "shop_z_sequences", "sync_logs",
    "close_day_requests", "close_day_request_items",
    "z_runs", "z_run_items",
]

NOW = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
TODAY = date(2026, 9, 27)


@dataclass
class World:
    db: Session
    tenant: Tenant
    company: Company
    shop: Shop
    other_shop: Shop
    tills: List[POSMachine]
    other_till: POSMachine
    admin: User
    _numbers: "itertools.count" = field(default_factory=lambda: itertools.count(1001))

    # ── builders ──────────────────────────────────────────────────────────────

    def shift(
        self,
        till: POSMachine,
        seq: Optional[int],
        *,
        status: ShiftStatus = ShiftStatus.CLOSED,
        business_date: date = TODAY,
        opened_at: Optional[datetime] = None,
        opening_cash: Optional[str] = "100.00",
        counted_cash: Optional[str] = None,
        unattended: bool = False,
        close_now: bool = True,
    ) -> Shift:
        opened = opened_at or (NOW - timedelta(hours=10) + timedelta(minutes=seq or 0))
        s = Shift(
            id=uuid.uuid4(),
            tenant_id=till.tenant_id,
            machine_id=till.id,
            shop_id=till.shop_id,
            business_date=business_date,
            sequence_number=seq,
            opened_at=opened,
            opening_cash=Decimal(opening_cash) if opening_cash is not None else None,
            status=status,
            unattended=unattended,
            counted_cash=Decimal(counted_cash) if counted_cash is not None else None,
        )
        if status == ShiftStatus.CLOSED and close_now:
            s.closed_at = opened + timedelta(hours=4)
            s.close_accepted_at = s.closed_at
        self.db.add(s)
        self.db.flush()
        return s

    def doc(
        self,
        till: POSMachine,
        shift: Optional[Shift],
        total: str,
        *,
        discount: str = "0",
        method: str = "cash",
        legs: Optional[list] = None,
        credit_note: bool = False,
        tip: str = "0",
        tip_method: Optional[str] = None,
        vat: Optional[str] = None,
        status: TransactionStatus = TransactionStatus.COMPLETED,
        number: Optional[str] = None,
    ) -> Transaction:
        tx = Transaction(
            id=uuid.uuid4(),
            tenant_id=till.tenant_id,
            machine_id=till.id,
            shop_id=till.shop_id,
            shift_id=shift.id if shift is not None else None,
            transaction_number=number or str(next(self._numbers)),
            status=status,
            document_type=330 if credit_note else 320,
            payment_method=method,
            total_amount=Decimal(total),
            document_discount=Decimal(discount),
            tip_amount=Decimal(tip),
            tip_payment_method=tip_method,
            vat_amount=Decimal(vat) if vat is not None else None,
            created_at=NOW,
            updated_at=NOW,
            server_received_at=NOW,
        )
        self.db.add(tx)
        self.db.flush()
        collected = Decimal(total) if credit_note else Decimal(total) - Decimal(discount)
        for i, (leg_method, amount) in enumerate(legs or [(method, str(collected))], start=1):
            self.db.add(
                TransactionPayment(
                    id=uuid.uuid4(),
                    transaction_id=tx.id,
                    sequence=i,
                    method=leg_method,
                    amount=Decimal(amount),
                )
            )
        self.db.flush()
        return tx


def accept_str_uuids(monkeypatch) -> None:
    """
    Routers pass ids as strings, which Postgres casts and SQLite's UUID binding does not.
    Teach this test's binding to accept a string id the way Postgres does.
    """
    from sqlalchemy.sql import sqltypes

    original_bind = sqltypes.Uuid.bind_processor

    def _bind_accepting_str(self, dialect):
        inner = original_bind(self, dialect)
        if inner is None:
            return None
        return lambda v: inner(uuid.UUID(v) if isinstance(v, str) else v)

    monkeypatch.setattr(sqltypes.Uuid, "bind_processor", _bind_accepting_str)


def make_world() -> World:
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _fk_off(dbapi_connection, _record):  # pragma: no cover - wiring
        dbapi_connection.execute("PRAGMA foreign_keys=OFF")

    for name in TABLES:
        if name in Base.metadata.tables:
            Base.metadata.tables[name].create(engine)
    db = sessionmaker(bind=engine)()

    tenant = Tenant(id=uuid.uuid4(), name="T", slug="t", timezone="Asia/Jerusalem")
    db.add(tenant)
    db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="Acme", vat_number="515151515")
    db.add(company)
    db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="Center", settings={})
    other_shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="North", settings={})
    db.add_all([shop, other_shop])
    db.flush()
    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email="a@x", username="admin")
    db.add(admin)
    db.flush()

    codes = itertools.count(1)

    def till(name, s):
        n = next(codes)
        m = POSMachine(
            id=uuid.uuid4(),
            tenant_id=tenant.id,
            shop_id=s.id,
            distributor_id=admin.id,
            name=name,
            machine_code=f"M-{n}",
            pos_number=str(n),
            is_active=True,
            pairing_status=PairingStatus.ASSIGNED,
            last_heartbeat_at=NOW - timedelta(seconds=10),
        )
        db.add(m)
        return m

    tills = [till("Till 1", shop), till("Till 2", shop)]
    other = till("North 1", other_shop)
    db.flush()
    return World(
        db=db, tenant=tenant, company=company, shop=shop, other_shop=other_shop,
        tills=tills, other_till=other, admin=admin,
    )
