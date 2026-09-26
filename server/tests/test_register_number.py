"""
Per-shop register numbers.

A document says which register it was issued on, and that has to keep naming one
physical till for as long as the document exists. So the properties tested here are
the ones that make the number trustworthy: consecutive within a shop, independent across
shops, never handed out twice — not after the top till is retired, removed or moved —
belonging to the machine's *current* shop, stable across re-assignment and replacement,
and not consumed by a pairing form that merely asks what the next one would be.

The suite has no database, so the session below is a small in-memory stand-in that
answers exactly the queries the service makes. The same behaviours were also run
against a throwaway Postgres (see the branch report); what cannot be reached here is the
database's own enforcement of the unique constraint and of `FOR UPDATE`, so those are
pinned by the DDL and SQL they compile to.
"""
from __future__ import annotations

import io
import os
import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateTable
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import BinaryExpression, BindParameter

from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.shop_register_sequence import ShopRegisterSequence
from app.models.user import UserRole
from app.routers import machines as machines_router
from app.routers import pairing_mobile as mobile_router
from app.routers import shops as shops_router
from app.schemas.pos_machine import POSMachineResponse, POSMachineUpdate
from app.services import pairing as P
from app.services import pairing_mobile as PM
from app.services.register_number import (
    assign_register_number,
    peek_next_register_number,
    set_machine_shop,
)

DIZENGOFF = uuid.UUID("00000000-0000-0000-0000-00000000a000")
RAMAT_AVIV = uuid.UUID("00000000-0000-0000-0000-00000000b000")
TENANT = uuid.UUID("00000000-0000-0000-0000-0000000000e1")


# ── Harness ──────────────────────────────────────────────────────────────────

def _equalities(criteria) -> Dict[str, Any]:
    """`Column == value` criteria as {"table.column": value}; everything else ignored."""
    found: Dict[str, Any] = {}
    for c in criteria:
        if isinstance(c, BinaryExpression) and c.operator is operators.eq:
            left, right = c.left, c.right
            if isinstance(right, BindParameter) and hasattr(left, "table"):
                found[f"{left.table.name}.{left.key}"] = right.value
    return found


def _numeric(value: Optional[str]) -> Optional[int]:
    return int(value) if value is not None and value.isdigit() and len(value) <= 9 else None


class _Query:
    def __init__(self, db: "_Db", entity: Any):
        self._db = db
        self._entity = entity
        self._eq: Dict[str, Any] = {}
        self._locked = False

    def filter(self, *criteria):
        self._eq.update(_equalities(criteria))
        return self

    def join(self, *_a, **_k):
        return self

    def with_for_update(self):
        self._locked = True
        self._db.locks += 1
        return self

    def _counter(self):
        shop = self._eq.get("shop_register_sequences.shop_id")
        return self._db.counters.get(str(shop))

    def first(self):
        e = self._entity
        if e is ShopRegisterSequence:
            return self._counter()
        if e is POSMachine:
            wanted = self._eq.get("pos_machines.id")
            return next((m for m in self._db.machines if str(m.id) == str(wanted)), None)
        if e is Shop:
            wanted = self._eq.get("shops.id")
            return next((s for s in self._db.shops if str(s.id) == str(wanted)), None)
        if e is PairingCode:
            return self._db.pairing_code
        return None  # trading days, companies, …: "none open", "not found"

    def one(self):
        row = self.first()
        assert row is not None, "one() found nothing"
        return row

    def scalar(self):
        """`max(cast(pos_number AS BIGINT))` over machines or documents in one shop."""
        text = str(self._entity)
        if "pos_machines.pos_number" in text:
            shop = self._eq.get("pos_machines.shop_id")
            rows = [m.pos_number for m in self._db.machines if str(m.shop_id) == str(shop)]
        elif "transactions.pos_number" in text:
            shop = self._eq.get("transactions.shop_id")
            rows = [t.pos_number for t in self._db.documents if str(t.shop_id) == str(shop)]
        else:
            raise AssertionError(f"unexpected scalar query {text}")
        numbers = [n for n in map(_numeric, rows) if n is not None]
        return max(numbers) if numbers else None

    def delete(self, **_):
        return 0

    def update(self, *_a, **_k):
        return 0

    def count(self):
        return 0


class _Db:
    """The rows the service reads, and a record of what it did to them."""

    def __init__(self):
        self.machines: List[POSMachine] = []
        self.documents: List[SimpleNamespace] = []
        self.shops: List[SimpleNamespace] = []
        self.counters: Dict[str, ShopRegisterSequence] = {}
        self.pairing_code = None
        self.locks = 0
        self.inserts: List[str] = []

    # the rows
    def shop(self, shop_id=None, tenant_id=TENANT):
        s = SimpleNamespace(id=shop_id or uuid.uuid4(), tenant_id=tenant_id,
                            company_id=uuid.uuid4(), name="shop", machines=[])
        self.shops.append(s)
        return s

    def machine(self, shop_id=None, pos_number=None, **kw):
        m = POSMachine(
            id=uuid.uuid4(),
            tenant_id=TENANT,
            distributor_id=uuid.uuid4(),
            name=kw.pop("name", "Nova 55F"),
            machine_code=f"MACHINE-{uuid.uuid4().hex[:8].upper()}",
            pairing_status=kw.pop("pairing_status", PairingStatus.ASSIGNED),
            is_active=kw.pop("is_active", True),
            token_version=1,
            shop_id=shop_id,
            pos_number=pos_number,
            **kw,
        )
        self.machines.append(m)
        return m

    def counter(self, shop_id) -> Optional[int]:
        row = self.counters.get(str(shop_id))
        return None if row is None else int(row.next_value)

    def set_counter(self, shop_id, next_value):
        self.counters[str(shop_id)] = ShopRegisterSequence(shop_id=shop_id, next_value=next_value)

    # the session
    def query(self, *entities):
        return _Query(self, entities[0])

    def execute(self, stmt):
        compiled = stmt.compile(dialect=postgresql.dialect())
        self.inserts.append(str(compiled))
        params = compiled.params
        key = str(params["shop_id"])
        if key not in self.counters:  # ON CONFLICT DO NOTHING
            self.set_counter(params["shop_id"], params["next_value"])

    def add(self, obj):
        if isinstance(obj, POSMachine) and obj not in self.machines:
            self.machines.append(obj)

    def delete(self, obj):
        if obj in self.machines:
            self.machines.remove(obj)

    def flush(self):
        pass

    def commit(self):
        pass

    def refresh(self, _obj):
        pass

    def rollback(self):
        pass


def _into(db: _Db, shop_id, n: int) -> List[POSMachine]:
    """Pair `n` fresh tills into `shop_id`, in order."""
    out = []
    for _ in range(n):
        m = db.machine(shop_id=None, pairing_status=PairingStatus.PAIRED)
        set_machine_shop(db, m, shop_id)
        out.append(m)
    return out


# ── Allocation ───────────────────────────────────────────────────────────────

class TestConsecutivePerShop:
    def test_a_shops_tills_are_numbered_one_two_three(self):
        db = _Db()
        assert [m.pos_number for m in _into(db, DIZENGOFF, 3)] == ["1", "2", "3"]

    def test_each_shop_runs_its_own_sequence(self):
        """Dizengoff 1, 2, 3 and Ramat Aviv 1, 2 — interleaved, and still independent."""
        db = _Db()
        a1, = _into(db, DIZENGOFF, 1)
        b1, = _into(db, RAMAT_AVIV, 1)
        a2, a3 = _into(db, DIZENGOFF, 2)
        b2, = _into(db, RAMAT_AVIV, 1)

        assert [a1.pos_number, a2.pos_number, a3.pos_number] == ["1", "2", "3"]
        assert [b1.pos_number, b2.pos_number] == ["1", "2"]
        assert db.counter(DIZENGOFF) == 4 and db.counter(RAMAT_AVIV) == 3

    def test_a_shopless_machine_has_no_number(self):
        db = _Db()
        m = db.machine(shop_id=None)

        assert assign_register_number(db, m) is None
        assert m.pos_number is None
        assert db.counters == {}

    def test_the_counter_row_is_locked_before_it_is_read(self):
        """Two tills paired at once must serialise, or both read the same number."""
        db = _Db()
        db.set_counter(DIZENGOFF, 5)
        m = db.machine(shop_id=DIZENGOFF)

        assign_register_number(db, m)

        assert db.locks == 1
        assert m.pos_number == "5" and db.counter(DIZENGOFF) == 6

    def test_the_lock_compiles_to_select_for_update(self):
        session = sessionmaker()()
        sql = str(
            session.query(ShopRegisterSequence)
            .filter(ShopRegisterSequence.shop_id == uuid.uuid4())
            .with_for_update()
            .statement.compile(dialect=postgresql.dialect())
        )
        assert "FOR UPDATE" in sql


# ── Never reused ─────────────────────────────────────────────────────────────

class TestNeverReused:
    def test_a_retired_top_till_keeps_its_number_out_of_circulation(self):
        db = _Db()
        _, _, top = _into(db, DIZENGOFF, 3)
        top.is_active = False

        new, = _into(db, DIZENGOFF, 1)

        assert top.pos_number == "3"
        assert new.pos_number == "4"

    def test_a_removed_top_till_does_not_hand_its_number_on(self):
        """
        The case `max(pos_number) + 1` gets wrong. Once register 3 is deleted the highest
        number left in the shop is 2, so max+1 issues 3 again — and every document that
        says "register 3" now names two machines. The counter has already moved past it.
        """
        db = _Db()
        _, _, top = _into(db, DIZENGOFF, 3)
        db.delete(top)

        new, = _into(db, DIZENGOFF, 1)

        assert new.pos_number == "4"

    def test_a_top_till_that_left_the_shop_does_not_hand_its_number_on(self):
        db = _Db()
        _, _, top = _into(db, DIZENGOFF, 3)
        set_machine_shop(db, top, RAMAT_AVIV)

        new, = _into(db, DIZENGOFF, 1)

        assert new.pos_number == "4"

    def test_a_soft_deleted_till_gives_up_its_number_but_the_run_moves_on(self):
        """`DELETE /machines/{id}` on a till with history clears its shop."""
        db = _Db()
        _, _, top = _into(db, DIZENGOFF, 3)
        set_machine_shop(db, top, None)

        new, = _into(db, DIZENGOFF, 1)

        assert top.pos_number is None
        assert new.pos_number == "4"


# ── Moving shop ──────────────────────────────────────────────────────────────

class TestMovingShop:
    def test_a_moved_till_takes_the_new_shops_next_number(self):
        db = _Db()
        _into(db, RAMAT_AVIV, 2)
        a1, a2 = _into(db, DIZENGOFF, 2)

        set_machine_shop(db, a2, RAMAT_AVIV)

        assert a2.shop_id == RAMAT_AVIV
        assert a2.pos_number == "3"

    def test_its_old_number_stays_spent_in_the_old_shop(self):
        db = _Db()
        a1, a2 = _into(db, DIZENGOFF, 2)
        set_machine_shop(db, a2, RAMAT_AVIV)

        assert db.counter(DIZENGOFF) == 3
        assert _into(db, DIZENGOFF, 1)[0].pos_number == "3"

    def test_moving_back_is_a_new_number_not_the_old_one(self):
        """The old number may be on documents from the other till that used it since."""
        db = _Db()
        a1, a2 = _into(db, DIZENGOFF, 2)
        set_machine_shop(db, a2, RAMAT_AVIV)
        set_machine_shop(db, a2, DIZENGOFF)

        assert a2.pos_number == "3"


# ── Idempotent ───────────────────────────────────────────────────────────────

class TestIdempotent:
    def test_a_numbered_machine_keeps_its_number(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        assert assign_register_number(db, m) == "1"
        assert assign_register_number(db, m) == "1"
        assert db.counter(DIZENGOFF) == 2

    def test_setting_the_shop_it_is_already_in_changes_nothing(self):
        """Callers pass the shop id as a UUID or as text; both are the same shop."""
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        set_machine_shop(db, m, DIZENGOFF)
        set_machine_shop(db, m, str(DIZENGOFF).upper())

        assert m.pos_number == "1"
        assert db.counter(DIZENGOFF) == 2


# ── Peek ─────────────────────────────────────────────────────────────────────

class TestPeek:
    def test_peeking_does_not_consume_a_number(self):
        db = _Db()
        _into(db, DIZENGOFF, 2)

        assert peek_next_register_number(db, DIZENGOFF) == 3
        assert peek_next_register_number(db, DIZENGOFF) == 3
        assert db.counter(DIZENGOFF) == 3
        assert _into(db, DIZENGOFF, 1)[0].pos_number == "3"

    def test_peeking_takes_no_lock_and_creates_no_counter(self):
        """A pairing dialog opened and cancelled must leave no trace at all."""
        db = _Db()
        db.machine(shop_id=DIZENGOFF, pos_number="4")

        assert peek_next_register_number(db, DIZENGOFF) == 5
        assert db.locks == 0
        assert db.inserts == []
        assert db.counters == {}

    def test_a_shop_with_nothing_yet_peeks_at_one(self):
        assert peek_next_register_number(_Db(), DIZENGOFF) == 1

    def test_the_peek_endpoint_does_not_allocate(self):
        db = _Db()
        db.shop(DIZENGOFF)
        _into(db, DIZENGOFF, 2)
        user = SimpleNamespace(role=UserRole.SUPER_ADMIN)

        body = shops_router.get_next_register_number(
            str(DIZENGOFF), current_user=user, active_tenant_id=TENANT, db=db
        )
        shops_router.get_next_register_number(
            str(DIZENGOFF), current_user=user, active_tenant_id=TENANT, db=db
        )

        assert body == {"shopId": str(DIZENGOFF), "nextRegisterNumber": 3}
        assert db.counter(DIZENGOFF) == 3

    def test_the_field_install_peek_is_scoped_to_the_sessions_tenant(self):
        db = _Db()
        db.shop(DIZENGOFF, tenant_id=uuid.uuid4())
        session = SimpleNamespace(tenant_id=TENANT)

        with pytest.raises(HTTPException) as e:
            mobile_router.mobile_next_register_number(
                DIZENGOFF, session_user=(session, None), db=db
            )
        assert e.value.status_code == 404

    def test_the_field_install_peek_does_not_allocate(self):
        db = _Db()
        db.shop(DIZENGOFF)
        _into(db, DIZENGOFF, 1)
        session = SimpleNamespace(tenant_id=TENANT)

        body = mobile_router.mobile_next_register_number(
            DIZENGOFF, session_user=(session, None), db=db
        )

        assert body["nextRegisterNumber"] == 2
        assert db.counter(DIZENGOFF) == 2


# ── A shop with no counter row yet ───────────────────────────────────────────

class TestCounterCreation:
    def test_starts_at_one(self):
        db = _Db()
        assert _into(db, DIZENGOFF, 1)[0].pos_number == "1"

    def test_continues_above_numbers_already_on_machines(self):
        """A counter row lost in a restore must not restart the run at 1."""
        db = _Db()
        db.machine(shop_id=DIZENGOFF, pos_number="7")

        assert _into(db, DIZENGOFF, 1)[0].pos_number == "8"

    def test_continues_above_numbers_already_on_documents(self):
        """The till that was register 9 has moved away, but its receipts still say 9."""
        db = _Db()
        db.documents.append(SimpleNamespace(shop_id=DIZENGOFF, pos_number="9"))
        db.documents.append(SimpleNamespace(shop_id=DIZENGOFF, pos_number="MACHINE-AB12"))

        assert _into(db, DIZENGOFF, 1)[0].pos_number == "10"

    def test_the_row_is_created_so_that_a_concurrent_creator_does_not_fail(self):
        db = _Db()
        _into(db, DIZENGOFF, 1)

        assert len(db.inserts) == 1
        assert "ON CONFLICT (shop_id) DO NOTHING" in db.inserts[0]


# ── Every place a machine gets a shop ────────────────────────────────────────

class TestCallSites:
    def test_assigning_a_paired_machine_to_a_shop(self):
        """`POST /pairing/machines/{id}/assign`, and the two flows below, land here."""
        db = _Db()
        db.shop(DIZENGOFF)
        _into(db, DIZENGOFF, 1)
        m = db.machine(shop_id=None, pairing_status=PairingStatus.PAIRED)

        assigned = P.assign_machine_to_shop(db, m.id, DIZENGOFF)

        assert assigned.pos_number == "2"

    def test_pairing_with_a_code_pre_assigned_to_a_shop(self):
        from datetime import datetime, timedelta, timezone

        db = _Db()
        db.shop(DIZENGOFF)
        db.pairing_code = SimpleNamespace(
            is_used=False, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            tenant_id=TENANT, distributor_id=uuid.uuid4(), target_machine_id=None,
            shop_id=DIZENGOFF, used_at=None, pos_machine_id=None,
        )
        fresh = db.machine(shop_id=None, pairing_status=PairingStatus.PAIRED)

        with patch.object(P, "create_pos_machine", return_value=fresh):
            machine = P.validate_pairing_code(db, "ABCD1234", {}, "Nova 55F")

        assert machine.shop_id == DIZENGOFF
        assert machine.pos_number == "1"

    def test_field_install_claim(self):
        db = _Db()
        shop = db.shop(DIZENGOFF)
        company = SimpleNamespace(id=shop.company_id, tenant_id=TENANT, name="co")
        request = SimpleNamespace(
            status=PM.DevicePairingStatus.WAITING, expires_at=PM._utcnow().replace(year=2999),
            device_info={}, machine_name=None,
        )
        fresh = db.machine(shop_id=None, pairing_status=PairingStatus.PAIRED)
        session = SimpleNamespace(id=uuid.uuid4(), tenant_id=TENANT, machines_paired_count=0)

        real_query = db.query

        def query(entity, *rest):
            if entity is PM.DevicePairingRequest:
                q = MagicMock()
                q.filter.return_value.first.return_value = request
                return q
            if entity is PM.Company:
                q = MagicMock()
                q.filter.return_value.first.return_value = company
                return q
            return real_query(entity, *rest)

        db.query = query
        with patch.object(PM, "resolve_pairing_assignment", return_value=(company.id, DIZENGOFF)), \
             patch.object(PM, "create_pos_machine", return_value=fresh), \
             patch.object(PM, "build_machine_credentials_payload", return_value={}):
            _row, machine, _c, _s = PM.claim_device_pairing(
                db, session, SimpleNamespace(id=uuid.uuid4()), "nonce", company.id, DIZENGOFF,
                machine_name="קופה 1",
            )

        assert machine.pos_number == "1"

    def _admin(self):
        return SimpleNamespace(role=UserRole.SUPER_ADMIN, id=uuid.uuid4())

    def test_changing_a_machines_shop_from_the_dashboard(self):
        db = _Db()
        db.shop(DIZENGOFF)
        db.shop(RAMAT_AVIV)
        _into(db, RAMAT_AVIV, 2)
        m, = _into(db, DIZENGOFF, 1)

        with patch.object(machines_router, "shop_belongs_to_company", return_value=True):
            machines_router.update_machine(
                str(m.id), POSMachineUpdate(shopId=RAMAT_AVIV),
                current_user=self._admin(), active_tenant_id=TENANT, db=db,
            )

        assert m.shop_id == RAMAT_AVIV
        assert m.pos_number == "3"

    def test_clearing_a_machines_shop_from_the_dashboard(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        machines_router.update_machine(
            str(m.id), POSMachineUpdate(shopId=None),
            current_user=self._admin(), active_tenant_id=TENANT, db=db,
        )

        assert m.shop_id is None and m.pos_number is None

    def test_renaming_a_machine_keeps_its_number(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        machines_router.update_machine(
            str(m.id), POSMachineUpdate(name="by the door"),
            current_user=self._admin(), active_tenant_id=TENANT, db=db,
        )

        assert m.pos_number == "1" and db.counter(DIZENGOFF) == 2

    def test_removing_a_machine_with_history(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        with patch.object(machines_router, "_machine_has_history", return_value=True):
            machines_router.delete_machine(
                str(m.id), current_user=self._admin(), active_tenant_id=TENANT, db=db,
            )

        assert m.shop_id is None and m.pos_number is None
        assert _into(db, DIZENGOFF, 1)[0].pos_number == "2"

    def test_deleting_a_shop_clears_its_machines_numbers(self):
        db = _Db()
        shop = db.shop(DIZENGOFF)
        shop.machines = _into(db, DIZENGOFF, 2)
        db.delete = lambda obj: None

        shops_router.delete_shop(
            str(DIZENGOFF), current_user=self._admin(), active_tenant_id=TENANT, db=db
        )

        assert [(m.shop_id, m.pos_number) for m in shop.machines] == [(None, None)] * 2


# ── Dead-till replacement ────────────────────────────────────────────────────

class TestReplacement:
    def test_the_replacement_is_the_same_register(self):
        """
        `adopt_machine` hands the new device the existing row, so the number survives
        without being copied — and the shop's run does not advance for it.
        """
        db = _Db()
        _, dead, _ = _into(db, DIZENGOFF, 3)

        adopted = P.adopt_machine(db, dead.id, device_info={"model": "new"}, machine_name="F21")

        assert adopted is dead
        assert adopted.pos_number == "2"
        assert db.counter(DIZENGOFF) == 4

    def test_a_replacement_code_carries_no_shop_so_the_number_is_not_redrawn(self):
        """The code minted for a replacement has `shop_id=None`; see the machines router."""
        from datetime import datetime, timedelta, timezone

        db = _Db()
        _, dead, _ = _into(db, DIZENGOFF, 3)
        db.pairing_code = SimpleNamespace(
            is_used=False, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            tenant_id=TENANT, distributor_id=uuid.uuid4(), target_machine_id=dead.id,
            shop_id=None, used_at=None, pos_machine_id=None,
        )

        machine = P.validate_pairing_code(db, "ABCD1234", {"model": "new"}, "F21")

        assert machine is dead and machine.pos_number == "2"
        assert db.counter(DIZENGOFF) == 4


# ── Uniqueness ───────────────────────────────────────────────────────────────

class TestUniqueConstraint:
    def test_two_tills_in_one_shop_cannot_share_a_number(self):
        """
        Enforced by Postgres, which this suite cannot reach — so pinned by the DDL.
        A plain UNIQUE is "unique where both are non-null": NULLs compare distinct.
        """
        ddl = str(CreateTable(POSMachine.__table__).compile(dialect=postgresql.dialect()))
        assert "CONSTRAINT uq_pos_machines_shop_pos_number UNIQUE (shop_id, pos_number)" in ddl

    def test_the_counter_goes_with_its_shop(self):
        ddl = str(CreateTable(ShopRegisterSequence.__table__).compile(dialect=postgresql.dialect()))
        assert "REFERENCES shops (id) ON DELETE CASCADE" in ddl


# ── API ──────────────────────────────────────────────────────────────────────

class TestApi:
    def test_machine_responses_carry_the_register_number(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)
        m.created_at = m.updated_at = PM._utcnow()

        out = POSMachineResponse.model_validate(m).model_dump(by_alias=True)

        assert out["posNumber"] == "1"

    def test_the_enriched_listing_carries_the_register_number(self):
        db = _Db()
        m, = _into(db, DIZENGOFF, 1)

        with patch.object(machines_router, "get_catalog_change_watermark_for_machine", return_value=None):
            row = machines_router._enrich_machine_status(
                m, db, open_trading_days={}, pending_close_ids=set()
            )

        assert row["posNumber"] == "1"


# ── Migration ────────────────────────────────────────────────────────────────

class TestMigration:
    """
    The suite cannot run a migration, but it can render one: `alembic upgrade --sql`
    needs no database. Executing it (ordering, idempotent re-run, the duplicate guard)
    was done against a throwaway Postgres, not here.
    """

    @pytest.fixture(scope="class")
    def sql(self) -> str:
        from alembic import command
        from alembic.config import Config

        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        buf = io.StringIO()
        cfg = Config(os.path.join(here, "alembic.ini"), output_buffer=buf)
        cfg.set_main_option("script_location", os.path.join(here, "alembic"))
        command.upgrade(cfg, "b4c5d6e7f8a9:c5d6e7f8a9b0", sql=True)
        return " ".join(buf.getvalue().split())

    def test_it_is_the_only_head_and_follows_a3b4c5d6e7f8(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cfg = Config(os.path.join(here, "alembic.ini"))
        cfg.set_main_option("script_location", os.path.join(here, "alembic"))
        script = ScriptDirectory.from_config(cfg)

        # One head, and this revision on its line. It stopped being the head itself when
        # the product-availability revision (d6e7f8a9b0c1) was chained onto it.
        heads = script.get_heads()
        assert len(heads) == 1
        assert "c5d6e7f8a9b0" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("c5d6e7f8a9b0").down_revision == "b4c5d6e7f8a9"

    def test_backfill_numbers_per_shop_in_creation_order_with_id_tiebreak(self, sql):
        assert "PARTITION BY m.shop_id ORDER BY m.created_at, m.id" in sql

    def test_backfill_includes_retired_machines(self, sql):
        """Their numbers must be spent, not left for the next till."""
        backfill = sql[sql.index("WITH top AS"):sql.index("INSERT INTO shop_register_sequences")]
        assert "is_active" not in backfill
        assert "WHERE m.pos_number IS NULL" in backfill

    def test_a_rerun_continues_above_the_counter_not_just_the_machines(self, sql):
        """
        On a re-run the counter remembers numbers whose machines have since gone;
        continuing from the machines alone would reissue one of them.
        """
        assert "LEFT JOIN shop_register_sequences q ON q.shop_id = m.shop_id" in sql
        assert "COALESCE(MAX(q.next_value) - 1, 0)" in sql

    def test_counters_are_seeded_past_the_backfill_and_never_lowered(self, sql):
        assert "MAX(pos_number::bigint) + 1" in sql
        assert "GREATEST(shop_register_sequences.next_value, EXCLUDED.next_value)" in sql

    def test_the_constraint_comes_after_the_backfill(self, sql):
        assert sql.index("UPDATE pos_machines p") < sql.index(
            "ADD CONSTRAINT uq_pos_machines_shop_pos_number UNIQUE (shop_id, pos_number)"
        )
