"""
Offline card authorization (Agamento `authorizePendingTransactions`).

What each class pins, and how it could look fine while doing damage:

* **Reports** — idempotent by the till's id, another till's id refused. A run stored
  twice would count nothing twice (the Z matches by uid), but a run of one till under
  another's id would move its declines to the wrong till.
* **The block** — a leg is declined or approved by its uid, per till; a uid declined by
  any run is declined. Another till's run with the same uid must not touch this till.
* **Z / X** — the Z freezes the block per till and sums it on the read; a Z with no
  offline activity carries zeros, and a Z built before the block reads as null.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.offline_authorization import OfflineAuthorization, OfflineAuthorizationItem
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.routers import shifts as shifts_router
from app.routers import sync as sync_router
from app.routers import z_reports as z_router
from app.schemas.offline_authorization import OfflineAuthorizationIn
from app.services import offline_authorizations as O
from app.services import transmissions as T
from app.services.z_builder import build_z
from shift_world import accept_str_uuids, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.now = datetime.now(timezone.utc)
    return world


# ── builders ────────────────────────────────────────────────────────────────


def card_doc(w, till, uid, amount="50.00", *, shift=None, at=None, number=None):
    at = at or (w.now - timedelta(hours=1))
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        shift_id=shift.id if shift else None,
        transaction_number=number or str(uuid.uuid4().int % 10**9),
        status=TransactionStatus.COMPLETED, document_type=320, payment_method="card",
        total_amount=Decimal(amount), document_discount=Decimal("0"), tip_amount=Decimal("0"),
        created_at=at, updated_at=at, server_received_at=at,
    )
    w.db.add(tx)
    w.db.flush()
    meta = {"uid": uid, "result": {"uid": uid}} if uid else {}
    leg = TransactionPayment(
        id=uuid.uuid4(), transaction_id=tx.id, sequence=1, method="card",
        amount=Decimal(amount), nayax_meta=meta, terminal_uid=T.leg_terminal_uid("card", meta),
    )
    w.db.add(leg)
    w.db.flush()
    return tx, leg


def run_body(**kw):
    base = {
        "id": str(uuid.uuid4()),
        "authorizedAt": datetime.now(timezone.utc).isoformat(),
        "statusCode": 0,
        "approved": [],
        "declined": [],
        "totalAmount": 0,
        "totalCount": 0,
    }
    base.update(kw)
    return OfflineAuthorizationIn.model_validate(base)


def post_run(w, till, body):
    resp = sync_router.post_offline_authorization(
        machine_id=str(till.id), body=body, machine=till, db=w.db
    )
    return resp.status_code, json.loads(resp.body)


# ── Reports ─────────────────────────────────────────────────────────────────


class TestReports:
    def test_first_time_201_then_200_and_nothing_twice(self, w):
        till = w.tills[0]
        body = run_body(approved=["A", "B"], declined=["C"], totalAmount=12345, totalCount=2)
        code, out = post_run(w, till, body)
        assert code == 201 and out["ok"] is True and out["created"] is True
        assert out["authorizationId"] == str(body.id)

        code, out = post_run(w, till, body)
        assert code == 200 and out["ok"] is True and out["created"] is False

        assert w.db.query(OfflineAuthorization).count() == 1
        row = w.db.query(OfflineAuthorization).one()
        assert row.machine_id == till.id and row.tenant_id == till.tenant_id
        assert row.shop_id == till.shop_id
        assert row.total_amount_agorot == 12345 and row.total_count == 2 and row.status_code == 0
        items = {i.terminal_uid: i.outcome for i in w.db.query(OfflineAuthorizationItem).all()}
        assert items == {"A": "approved", "B": "approved", "C": "declined"}

    def test_another_tills_id_is_409(self, w):
        body = run_body(declined=["C"])
        post_run(w, w.tills[0], body)
        with pytest.raises(HTTPException) as e:
            post_run(w, w.tills[1], body)
        assert e.value.status_code == 409 and e.value.detail == "offline_authorization_id_conflict"
        assert w.db.query(OfflineAuthorizationItem).count() == 1

    def test_a_uid_in_both_lists_is_declined_once(self, w):
        post_run(w, w.tills[0], run_body(approved=["A", " A ", ""], declined=["A"]))
        items = w.db.query(OfflineAuthorizationItem).all()
        assert [(i.terminal_uid, i.outcome) for i in items] == [("A", "declined")]

    def test_unreadable_extras_are_not_a_422(self):
        body = run_body(statusCode="x", totalAmount="lots", totalCount=-1, approved="A", declined=None)
        assert body.status_code is None and body.total_amount is None and body.total_count is None
        assert body.approved == [] and body.declined == []


# ── The block ───────────────────────────────────────────────────────────────


class TestBlock:
    def test_counts_declined_and_approved_by_uid(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.CLOSED, opened_at=w.now - timedelta(hours=6))
        card_doc(w, till, "A", "10.00", shift=shift)
        tx_b, _ = card_doc(w, till, "B", "25.50", shift=shift, number="7001")
        card_doc(w, till, "C", "5.00", shift=shift)  # online: in no run
        card_doc(w, till, None, "7.00", shift=shift)  # no uid: never matched
        post_run(w, till, run_body(approved=["A", "B"]))
        post_run(w, till, run_body(declined=["B"]))  # a later run declined it
        post_run(w, till, run_body(approved=["Z"]))  # matches nothing of the shift
        # Another till's run with this till's uid: not this till's.
        post_run(w, w.tills[1], run_body(declined=["A"]))

        block = O.offline_block(w.db, till, [shift])
        assert block["authorizationCount"] == 2
        assert block["approvedCount"] == 1 and block["approvedAmount"] == "10.00"
        assert block["declinedCount"] == 1 and block["declinedAmount"] == "25.50"
        assert block["declined"] == [
            {
                "transactionId": str(tx_b.id),
                "documentNumber": "7001",
                # A number names a document only with its type (docs/SPEC_DOCUMENT_PREFIX.md).
                "documentType": 320,
                "amount": "25.50",
                "terminalUid": "B",
                "at": block["declined"][0]["at"],
            }
        ]
        assert block["declined"][0]["at"] is not None

    def test_no_offline_data_is_zeros(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1)
        card_doc(w, till, "A", shift=shift)
        assert O.offline_block(w.db, till, [shift]) == {
            "authorizationCount": 0,
            "approvedCount": 0, "approvedAmount": "0.00",
            "declinedCount": 0, "declinedAmount": "0.00",
            "declined": [],
        }


# ── Z / X ───────────────────────────────────────────────────────────────────


def read_z(w, z):
    return z_router.get_z_report(
        z_report_id=z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


class TestZAndX:
    def test_the_z_freezes_the_block_per_till_and_sums_it(self, w):
        t1, t2 = w.tills
        s1 = w.shift(t1, 1, opened_at=w.now - timedelta(hours=6))
        s2 = w.shift(t2, 1, opened_at=w.now - timedelta(hours=6))
        card_doc(w, t1, "A", "10.00", shift=s1)
        card_doc(w, t1, "B", "20.00", shift=s1)
        card_doc(w, t2, "C", "30.00", shift=s2)
        card_doc(w, t2, "D", "40.00", shift=s2)
        post_run(w, t1, run_body(approved=["A"], declined=["B"]))
        post_run(w, t2, run_body(approved=["C", "D"]))

        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    selections=[(t1, s1.id), (t2, s2.id)])
        by_till = {s["machineId"]: s["offline"] for s in z.per_machine}
        assert by_till[str(t1.id)]["declinedCount"] == 1
        assert by_till[str(t1.id)]["declinedAmount"] == "20.00"
        assert by_till[str(t2.id)]["approvedCount"] == 2
        assert by_till[str(t2.id)]["declinedCount"] == 0
        json.dumps(z.per_machine)  # stored as JSON: must serialise as is

        out = read_z(w, z).model_dump(by_alias=True)
        assert out["offlineAuthorizationCount"] == 2
        assert out["offlineApprovedCount"] == 3
        assert out["offlineDeclinedCount"] == 1
        assert out["offlineDeclinedAmount"] == Decimal("20.00")

    def test_a_z_without_offline_data_carries_zeros(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, opened_at=w.now - timedelta(hours=6))
        card_doc(w, till, "A", shift=shift)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        block = z.per_machine[0]["offline"]
        assert block["authorizationCount"] == 0 and block["declinedCount"] == 0
        out = read_z(w, z)
        assert out.offline_declined_count == 0 and out.offline_declined_amount == Decimal("0")

    def test_a_z_built_before_the_block_reads_as_null(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, opened_at=w.now - timedelta(hours=6))
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        z.per_machine = [{k: v for k, v in s.items() if k != "offline"} for s in z.per_machine]
        w.db.flush()
        out = read_z(w, z)
        assert out.offline_declined_count is None and out.offline_authorization_count is None

    def test_the_x_detail_carries_the_block(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=w.now - timedelta(hours=5))
        card_doc(w, till, "A", "12.00", shift=shift)
        post_run(w, till, run_body(declined=["A"]))
        out = shifts_router.get_shift(
            shift_id=shift.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        assert out.offline["declinedCount"] == 1 and out.offline["declinedAmount"] == "12.00"


def test_the_migration_is_the_single_head_on_till_parameters():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert len(heads) == 1
    assert "d0e1f2a3b4c5" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("d0e1f2a3b4c5").down_revision == "c9d0e1f2a3b4"


# ── The report (`GET /reports/offline-authorizations`) ───────────────────────


def report(w, user=None, **kw):
    from app.routers import reports as reports_router

    params = dict(from_date=None, to_date=None, tz="UTC", shop_id=None, machine_id=None)
    params.update(kw)
    return reports_router.get_offline_authorizations_report(
        **params, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


def shop_manager(w, shop):
    from app.models.user import User, UserRole

    user = User(
        id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=shop.id,
        email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8],
    )
    w.db.add(user)
    w.db.flush()
    return user


class TestReport:
    def test_runs_with_their_declines_matched_and_totals(self, w):
        till = w.tills[0]
        tx_b, _ = card_doc(w, till, "B", "25.50", number="7001", at=w.now - timedelta(hours=3))
        card_doc(w, till, "A", "10.00")
        body = run_body(approved=["A"], declined=["B", "GHOST"], totalAmount=1000, totalCount=1)
        post_run(w, till, body)

        out = report(w).model_dump(by_alias=True)
        assert out["totals"]["authorizationCount"] == 1
        assert out["totals"]["approvedCount"] == 1
        assert out["totals"]["approvedAmount"] == Decimal("10.00")
        assert out["totals"]["declinedCount"] == 2
        assert out["totals"]["declinedAmount"] == Decimal("25.50")
        assert out["totals"]["declinedUnmatchedCount"] == 1
        row = out["items"][0]
        assert row["machineName"] == "Till 1" and row["shopName"] == "Center"
        by_uid = {d["terminalUid"]: d for d in row["declined"]}
        assert by_uid["B"]["matched"] is True and by_uid["B"]["documentNumber"] == "7001"
        assert by_uid["B"]["transactionId"] == tx_b.id and by_uid["B"]["amount"] == Decimal("25.50")
        assert by_uid["GHOST"]["matched"] is False and by_uid["GHOST"]["amount"] is None

    def test_another_tills_leg_with_the_uid_is_not_matched(self, w):
        card_doc(w, w.tills[1], "B", "99.00")
        post_run(w, w.tills[0], run_body(declined=["B"]))
        row = report(w).items[0]
        assert row.declined[0].matched is False and row.declined_amount == Decimal("0")

    def test_the_date_range_is_on_the_run(self, w):
        till = w.tills[0]
        post_run(w, till, run_body(authorizedAt=(w.now - timedelta(days=5)).isoformat()))
        post_run(w, till, run_body())
        today = w.now.date()
        assert len(report(w, from_date=today, to_date=today).items) == 1
        old = (w.now - timedelta(days=5)).date()
        assert len(report(w, from_date=old, to_date=old).items) == 1
        assert len(report(w).items) == 2  # default: the last 30 days

    def test_shop_and_machine_filters(self, w):
        post_run(w, w.tills[0], run_body())
        post_run(w, w.tills[1], run_body())
        post_run(w, w.other_till, run_body())
        assert len(report(w, shop_id=w.shop.id).items) == 2
        assert [r.machine_id for r in report(w, machine_id=w.tills[1].id).items] == [w.tills[1].id]

    def test_a_shop_manager_sees_only_their_shop(self, w):
        post_run(w, w.tills[0], run_body(declined=["X"]))
        post_run(w, w.other_till, run_body(declined=["Y"]))
        out = report(w, user=shop_manager(w, w.other_shop))
        assert [r.machine_id for r in out.items] == [w.other_till.id]
        assert out.totals.declined_count == 1

    def test_another_tenants_runs_are_not_listed(self, w):
        post_run(w, w.tills[0], run_body())
        from app.routers import reports as reports_router

        out = reports_router.get_offline_authorizations_report(
            from_date=None, to_date=None, tz="UTC", shop_id=None, machine_id=None,
            current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db,
        )
        assert out.items == []


# ── Shifts, documents, day summary ─────────────────────────────────────────


class TestElsewhere:
    def test_the_shift_list_carries_declined_per_shift(self, w):
        till = w.tills[0]
        s1 = w.shift(till, 1, opened_at=w.now - timedelta(hours=10))
        s2 = w.shift(till, 2, opened_at=w.now - timedelta(hours=5))
        card_doc(w, till, "A", "10.00", shift=s1)
        card_doc(w, till, "B", "20.00", shift=s1)
        card_doc(w, till, "C", "30.00", shift=s2)
        post_run(w, till, run_body(approved=["C"], declined=["A", "B"]))
        post_run(w, till, run_body(declined=["A"]))  # declined twice: still one leg

        out = shifts_router.list_shifts(
            shop_id=None, machine_id=None, status_=None, awaiting_z=None, from_date=None,
            to_date=None, area_id=None, page=1, page_size=50, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        by_id = {i.id: i for i in out.items}
        assert by_id[s1.id].offline_declined_count == 2
        assert by_id[s1.id].offline_declined_amount == Decimal("30.00")
        assert by_id[s2.id].offline_declined_count == 0

    def test_documents_carry_their_offline_outcome(self, w):
        from app.routers import transactions as tx_router

        till = w.tills[0]
        tx_a, _ = card_doc(w, till, "A")
        tx_b, _ = card_doc(w, till, "B")
        tx_c, _ = card_doc(w, till, "C")
        tx_d, _ = card_doc(w, w.tills[1], "A")  # same uid, another till: not answered
        post_run(w, till, run_body(approved=["A", "B"]))
        post_run(w, till, run_body(declined=["B"]))

        out = tx_router.list_transactions(
            machine_id=None, shop_id=None, basket_id=None, from_date=None, to_date=None,
            page=1, page_size=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        by_id = {i.id: i.offline_outcome for i in out.items}
        assert by_id[tx_a.id] == "approved" and by_id[tx_b.id] == "declined"
        assert by_id[tx_c.id] is None and by_id[tx_d.id] is None

        one = tx_router.get_transaction(
            transaction_id=tx_b.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        assert one.offline_outcome == "declined"

    def test_the_day_summary_sums_the_zs_declines(self, w):
        from app.services import reports as R

        till = w.tills[0]
        shift = w.shift(till, 1, opened_at=w.now - timedelta(hours=6))
        card_doc(w, till, "A", "12.00", shift=shift)
        post_run(w, till, run_body(declined=["A"]))
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])

        window = R.resolve_report_window(
            w.db, w.tenant.id, from_date=z.business_date, to_date=z.business_date, tz="UTC"
        )
        out = R.build_day_summary_report(w.db, w.admin, w.tenant.id, window)
        assert out.totals.offline_declined_count == 1
        assert out.totals.offline_declined_amount == 12.0
        assert out.days[0].contributors[0].offline_declined_count == 1
