"""
An in-memory SQLite world for the notification service and club tests
(docs/SPEC_NOTIFICATIONS_CLUB.md).

Private to each test, never the configured database. Every table is created (foreign
keys on), JSONB compiles to JSON, and pysqlite is put in "autocommit off, explicit
BEGIN" mode so SAVEPOINTs (the services' `begin_nested` races) behave as in Postgres.
`FOR UPDATE SKIP LOCKED` is not rendered by SQLite: the claim's SQL is asserted on the
Postgres compiler instead.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, List, Optional

from sqlalchemy import create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.models  # noqa: F401  (every mapper)
from app.models.company import Company
from app.models.notifications import NotificationProviderConfig
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.services.notifications import adapter019 as A
from app.services.notifications import service as S

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - DDL only
    return "JSON"


class Clock:
    """A settable clock for the services under test."""

    def __init__(self, start: datetime = NOW):
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw: Any) -> datetime:
        self.now = self.now + timedelta(**kw)
        return self.now


@dataclass
class NWorld:
    db: Session
    factory: Callable[[], Session]
    tenant: Tenant
    company: Company
    shop: Shop
    till: POSMachine
    other_tenant: Tenant
    other_company: Company
    other_shop: Shop
    other_till: POSMachine
    admin: User
    clock: Clock
    mock: A.MockTransport
    configs: List[NotificationProviderConfig] = field(default_factory=list)

    def config(self, company: Optional[Company] = None, **kw: Any) -> NotificationProviderConfig:
        company = company or self.company
        c = S.default_config(company.tenant_id, company.id)
        c.sender = kw.pop("sender", "RunnerPOS")
        for k, v in kw.items():
            setattr(c, k, v)
        self.db.add(c)
        self.db.commit()
        self.configs.append(c)
        return c

    def adapter_factory(self, config, token):
        """Every mode on the in-process mock — no test ever reaches the network."""
        return A.Adapter019(
            mode=config.mode, username=config.account_username or "u", token=token or "t",
            sender=config.sender, transport=self.mock, live_allowed=True,
        )


_TEMPLATE = None


def _template_connection():
    """Every table, created once per test session; each world starts from a copy."""
    global _TEMPLATE
    if _TEMPLATE is None:
        import sqlite3

        _TEMPLATE = sqlite3.connect(":memory:", check_same_thread=False)
        engine = create_engine("sqlite://", creator=lambda: _TEMPLATE, poolclass=StaticPool)
        for table in Base.metadata.sorted_tables:
            table.create(engine)
    return _TEMPLATE


def make_engine():
    import sqlite3

    template = _template_connection()

    def creator():
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        template.backup(conn)
        return conn

    engine = create_engine("sqlite://", creator=creator, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection, _record):  # pragma: no cover - wiring
        dbapi_connection.isolation_level = None
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    @event.listens_for(engine, "begin")
    def _begin(conn):  # pragma: no cover - wiring
        conn.exec_driver_sql("BEGIN")

    return engine


def make_nworld() -> NWorld:
    engine = make_engine()
    factory = sessionmaker(bind=engine)
    db = factory()

    def tenant_tree(name: str):
        tenant = Tenant(id=uuid.uuid4(), name=name, slug=name.lower(), timezone="Asia/Jerusalem")
        db.add(tenant)
        db.flush()
        company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name=f"{name} בע\"מ", vat_number="515151515")
        db.add(company)
        db.flush()
        shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name=f"{name} מרכז", settings={})
        db.add(shop)
        db.flush()
        return tenant, company, shop

    tenant, company, shop = tenant_tree("Alpha")
    other_tenant, other_company, other_shop = tenant_tree("Beta")
    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email="a@x", username="admin")
    db.add(admin)
    db.flush()

    def till(t, s, n):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=t.id, shop_id=s.id, distributor_id=admin.id, name=f"Till {n}",
            machine_code=f"M-{n}", pos_number=str(n), is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        db.add(m)
        return m

    t1 = till(tenant, shop, 1)
    t2 = till(other_tenant, other_shop, 2)
    db.commit()
    mock = A.MockTransport()
    return NWorld(
        db=db, factory=factory, tenant=tenant, company=company, shop=shop, till=t1,
        other_tenant=other_tenant, other_company=other_company, other_shop=other_shop, other_till=t2,
        admin=admin, clock=Clock(), mock=mock,
    )
