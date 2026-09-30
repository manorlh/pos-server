"""
Card transaction transmission to Shva (docs/SHIFTS_API.md §4).

What each class pins, and how it could look fine while doing damage:

* **Reports** — idempotent by the till's id, an `unknown` upgraded by a later `success`,
  another till's id refused. A report stored twice would count a batch twice.
* **Leg marking** — a success marks exactly this till's card legs it carried, including a
  leg whose document lands later and a document re-pushed after the mark. A leg marked by
  a failed batch, or another till's leg with the same uid, would hide money never paid.
* **Heartbeat** — the block is a snapshot, never a 422, and the first one starts tracking.
* **Transmit requests** — the wire (Ably + heartbeat), acks, reports naming the request,
  expiry, cancel, and who may ask.
* **Flags** — the 24 h / 4 day thresholds, and that they never change the colour.
* **Recovery list** — our records after the tracking start, only the last four digits.
* **Replacement** — refused while card sales are untransmitted, unless acknowledged.
* **X / Z** — informational blocks; a Z is built whatever is pending.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError

from app.models.card_transmission import (
    CardTransmission,
    TransmitRequest,
    TransmitRequestStatus as S,
)
from app.models.pairing_code import PairingCode
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.routers import shifts as shifts_router
from app.routers import sync as sync_router
from app.routers import transmit_requests as requests_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.transaction import TransactionIn
from app.schemas.transmission import ReplacementCodeBody, TransmissionReportIn, TransmitAckIn
from app.services import ably_notify
from app.services import pairing as P
from app.services import transmissions as T
from app.services import transmit_requests as TR
from app.services.machine_status import MachineFlag, StatusInput, resolve_status
from app.services.transactions import upsert_transactions
from app.services.z_builder import build_z
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(
        ably_notify, "publish_transmit_notify", lambda *a, **k: world.sent.append(a)
    )
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    world.now = datetime.now(timezone.utc)
    for till in world.tills + [world.other_till]:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
    return world


# ── builders ────────────────────────────────────────────────────────────────


def track(w, till, since=None):
    till.transmission_tracking_started_at = since or (w.now - timedelta(days=10))
    w.db.flush()


def card_doc(w, till, uid, amount="50.00", *, shift=None, at=None, status=TransactionStatus.COMPLETED,
             meta=None, method="card"):
    at = at or (w.now - timedelta(hours=1))
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        shift_id=shift.id if shift else None, transaction_number=str(uuid.uuid4().int % 10**9),
        status=status, document_type=320, payment_method=method,
        total_amount=Decimal(amount), document_discount=Decimal("0"), tip_amount=Decimal("0"),
        created_at=at, updated_at=at, server_received_at=at,
    )
    w.db.add(tx)
    w.db.flush()
    meta = meta if meta is not None else {
        "vuid": "our-vuid", "uid": uid, "authNum": "0123456", "cardLast4": "4580",
        "creditPayments": 1, "result": {"uid": uid, "issuerAuthNum": "0123456"},
    }
    leg = TransactionPayment(
        id=uuid.uuid4(), transaction_id=tx.id, sequence=1, method=method,
        amount=Decimal(amount), nayax_meta=meta,
        terminal_uid=T.leg_terminal_uid(method, meta),
    )
    w.db.add(leg)
    w.db.flush()
    return tx, leg


def report_body(**kw):
    base = {
        "id": str(uuid.uuid4()), "trigger": "shift_close",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "status": "success", "statusCode": 0, "statusMessage": "ok",
        "batchNumber": "23346317", "transactionCount": 1, "amount": "50.00",
        "terminalTransactionIds": [], "reportText": "Z", "error": None,
    }
    base.update(kw)
    return TransmissionReportIn.model_validate(base)


def post_report(w, till, body):
    resp = sync_router.post_transmission_report(machine_id=str(till.id), body=body, machine=till, db=w.db)
    import json

    return resp.status_code, json.loads(resp.body)


def ack(w, till, request_id, phase, **kw):
    body = TransmitAckIn.model_validate({"requestId": str(request_id), "phase": phase, **kw})
    return sync_router.post_transmit_ack(machine_id=str(till.id), body=body, machine=till, db=w.db)


def ask(w, till, user=None):
    response = Response()
    response.status_code = None
    out = machines_router.request_transmit(
        machine_id=till.id, response=response, current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )
    return out, response.status_code or 201


def beat(w, till, payload=None):
    body = MachineHeartbeatBody.model_validate(payload) if payload is not None else None
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)


def detail(w, till):
    return machines_router.get_machine(
        machine_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


def user(w, role, shop=None):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4()}@x",
             username=f"{role.value}-{uuid.uuid4().hex[:6]}", shop_id=shop.id if shop else None)
    w.db.add(u)
    w.db.flush()
    return u


# ── Reading the acquirer reply ───────────────────────────────────────────────


class TestTheTerminalUid:
    def test_it_is_the_uid_not_our_vuid(self):
        assert T.terminal_uid_of({"vuid": "ours", "uid": "2407171140"}) == "2407171140"

    def test_the_result_objects_uid_stands_in(self):
        assert T.terminal_uid_of({"vuid": "ours", "result": {"uid": "X1"}}) == "X1"

    def test_no_uid_no_match(self):
        assert T.terminal_uid_of({"vuid": "ours"}) is None
        assert T.terminal_uid_of({"uid": "  ", "result": "garbage"}) is None
        assert T.terminal_uid_of("not an object") is None
        assert T.terminal_uid_of(None) is None

    def test_only_card_legs_carry_one(self):
        assert T.leg_terminal_uid("cash", {"uid": "X"}) is None
        assert T.leg_terminal_uid(" Card ", {"uid": "X"}) == "X"

    def test_only_the_last_four_digits_ever_leave(self):
        assert T.card_last4_of({"maskedCard": "458012******1234"}) == "1234"
        assert T.card_last4_of({"result": {"cardNumber": "4580123412341234"}}) == "1234"
        assert T.card_last4_of({"cardLast4": "4580"}) == "4580"
        assert T.card_last4_of({}) is None

    def test_ingest_stores_the_uid_on_the_leg(self, w):
        till = w.tills[0]
        tx = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "501", "status": "completed",
            "totalAmount": "20.00", "paymentMethod": "card", "reprintCount": 0,
            "createdAt": w.now.isoformat(), "updatedAt": w.now.isoformat(),
            "nayaxMeta": '{"vuid": "v", "uid": "U-501", "authNum": "77"}',
        })
        upsert_transactions(w.db, till, [tx])
        leg = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id).one()
        assert leg.terminal_uid == "U-501"


# ── Reports ─────────────────────────────────────────────────────────────────


class TestReports:
    def test_the_first_report_is_201_and_stored(self, w):
        till = w.tills[0]
        code, out = post_report(w, till, report_body(terminalTransactionIds=["A", "B"]))

        assert code == 201
        assert out["created"] is True and out["status"] == "success"
        row = w.db.query(CardTransmission).one()
        assert row.machine_id == till.id and row.shop_id == till.shop_id
        assert row.tenant_id == w.tenant.id and row.terminal_transaction_count == 2

    def test_a_repeat_is_200_and_changes_nothing(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A")
        body = report_body(terminalTransactionIds=["A"])
        post_report(w, till, body)

        code, out = post_report(w, till, body)

        assert code == 200 and out["created"] is False and out["legsMarked"] == 0
        assert w.db.query(CardTransmission).count() == 1
        assert leg.transmission_id == body.id

    def test_an_unknown_is_upgraded_by_a_later_success_with_the_same_id(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A")
        tid = str(uuid.uuid4())
        post_report(w, till, report_body(id=tid, status="unknown", terminalTransactionIds=["A"]))
        assert leg.transmission_id is None

        code, out = post_report(w, till, report_body(id=tid, status="success", terminalTransactionIds=["A"]))

        assert code == 200 and out["status"] == "success" and out["legsMarked"] == 1
        assert leg.transmission_id == uuid.UUID(tid)

    def test_a_success_is_never_downgraded(self, w):
        till = w.tills[0]
        tid = str(uuid.uuid4())
        post_report(w, till, report_body(id=tid, status="success"))
        _code, out = post_report(w, till, report_body(id=tid, status="failed"))

        assert out["status"] == "success"

    def test_another_tills_id_is_409(self, w):
        tid = str(uuid.uuid4())
        post_report(w, w.tills[0], report_body(id=tid))

        with pytest.raises(HTTPException) as e:
            post_report(w, w.tills[1], report_body(id=tid))
        assert e.value.status_code == 409 and e.value.detail == "transmission_id_conflict"

    def test_a_report_starts_tracking(self, w):
        till = w.tills[0]
        assert till.transmission_tracking_started_at is None
        post_report(w, till, report_body())
        assert till.transmission_tracking_started_at is not None

    @pytest.mark.parametrize("bad", [
        {"id": "not-a-uuid"}, {"trigger": "whenever"}, {"status": "maybe"}, {"startedAt": "yesterday"},
    ])
    def test_an_unreadable_key_field_is_a_422(self, bad):
        with pytest.raises(ValidationError):
            report_body(**bad)

    def test_everything_else_is_read_leniently(self):
        body = report_body(
            amount="NaN", statusCode="x", transactionCount=-3, finishedAt="garbage",
            requestId="nope", batchNumber=23346317, statusMessage="m" * 900,
            terminalTransactionIds=["A", " ", None, "A", "B" * 100, {"x": 1}, 7],
        )
        assert body.amount is None and body.status_code is None and body.transaction_count is None
        assert body.finished_at is None and body.request_id is None
        assert body.batch_number == "23346317" and len(body.status_message) == 500
        assert body.terminal_transaction_ids == ["A", "B" * 64, "7"]

    def test_money_is_rounded_and_out_of_range_is_null(self):
        assert report_body(amount="12.345").amount == Decimal("12.35")
        assert report_body(amount=1e11).amount is None
        assert report_body(amount="Infinity").amount is None

    def test_a_non_list_of_ids_is_none(self):
        assert report_body(terminalTransactionIds="A,B").terminal_transaction_ids == []

    def test_user_tokens_are_refused_on_the_route(self):
        """Machine token only, like the shift writes."""
        from app.middleware.auth import get_pos_machine_from_sync_machine_token
        from app.main import app

        for path in ("/api/v1/sync/{machine_id}/transmissions", "/api/v1/sync/{machine_id}/transmit/ack"):
            route = next(r for r in app.routes if getattr(r, "path", None) == path)
            deps = {d.call for d in route.dependant.dependencies}
            assert get_pos_machine_from_sync_machine_token in deps


# ── Leg marking ─────────────────────────────────────────────────────────────


class TestLegMarking:
    def test_a_success_marks_this_tills_card_legs_it_carried(self, w):
        till = w.tills[0]
        _a, leg_a = card_doc(w, till, "A")
        _b, leg_b = card_doc(w, till, "B")
        _c, leg_c = card_doc(w, till, "C")

        _code, out = post_report(w, till, report_body(batchNumber="777", terminalTransactionIds=["A", "B", "Z"]))

        assert out["legsMarked"] == 2
        assert leg_a.transmitted_batch == "777" and leg_b.transmission_id is not None
        assert leg_c.transmission_id is None

    def test_another_tills_leg_with_the_same_uid_is_not_marked(self, w):
        _mine, mine = card_doc(w, w.tills[0], "A")
        _theirs, theirs = card_doc(w, w.tills[1], "A")

        post_report(w, w.tills[0], report_body(terminalTransactionIds=["A"]))

        assert mine.transmission_id is not None and theirs.transmission_id is None

    @pytest.mark.parametrize("status", ["failed", "unknown"])
    def test_a_batch_that_did_not_succeed_marks_nothing(self, w, status):
        _tx, leg = card_doc(w, w.tills[0], "A")
        _code, out = post_report(w, w.tills[0], report_body(status=status, terminalTransactionIds=["A"]))
        assert out["legsMarked"] == 0 and leg.transmission_id is None

    def test_a_leg_already_marked_keeps_its_first_batch(self, w):
        till = w.tills[0]
        _tx, leg = card_doc(w, till, "A")
        first = report_body(batchNumber="1", terminalTransactionIds=["A"])
        post_report(w, till, first)
        post_report(w, till, report_body(batchNumber="2", terminalTransactionIds=["A"]))
        assert leg.transmission_id == first.id and leg.transmitted_batch == "1"

    def _push(self, w, till, tx_id, uid, updated=None):
        tx = TransactionIn.model_validate({
            "id": str(tx_id), "transactionNumber": "9001", "status": "completed",
            "totalAmount": "30.00", "paymentMethod": "card", "reprintCount": 0,
            "createdAt": w.now.isoformat(), "updatedAt": (updated or w.now).isoformat(),
            "payments": [{"id": str(uuid.uuid4()), "sequence": 1, "method": "card", "amount": "30.00",
                          "nayaxMeta": {"uid": uid, "authNum": "9"}}],
        })
        upsert_transactions(w.db, till, [tx])
        w.db.expire_all()
        return w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx_id).one()

    def test_a_document_landing_after_the_report_is_marked_on_ingest(self, w):
        till = w.tills[0]
        body = report_body(batchNumber="55", terminalTransactionIds=["LATE"])
        post_report(w, till, body)

        leg = self._push(w, till, uuid.uuid4(), "LATE")

        assert leg.transmission_id == body.id and leg.transmitted_batch == "55"

    def test_a_late_document_of_another_till_is_not_marked(self, w):
        post_report(w, w.tills[0], report_body(terminalTransactionIds=["LATE"]))
        leg = self._push(w, w.tills[1], uuid.uuid4(), "LATE")
        assert leg.transmission_id is None

    def test_a_repush_keeps_the_mark(self, w):
        till = w.tills[0]
        tx_id = uuid.uuid4()
        self._push(w, till, tx_id, "RP")
        body = report_body(terminalTransactionIds=["RP"])
        post_report(w, till, body)

        leg = self._push(w, till, tx_id, "RP", updated=w.now + timedelta(minutes=1))

        assert leg.transmission_id == body.id


# ── Heartbeat ───────────────────────────────────────────────────────────────


class TestHeartbeat:
    def test_the_block_is_stored_and_starts_tracking(self, w):
        till = w.tills[0]
        oldest = (w.now - timedelta(hours=3)).isoformat()
        beat(w, till, {"transmission": {
            "pendingCount": 4, "pendingAmount": "310.00", "oldestPendingAt": oldest,
            "lastSuccessAt": (w.now - timedelta(hours=20)).isoformat(),
            "lastAttemptAt": w.now.isoformat(), "lastError": "timeout", "source": "terminal",
        }})

        assert till.transmission_pending_count == 4
        assert till.transmission_pending_amount == Decimal("310.00")
        assert till.transmission_last_error == "timeout" and till.transmission_source == "terminal"
        assert till.transmission_reported_at is not None
        assert till.transmission_tracking_started_at is not None

    def test_it_is_a_snapshot_an_absent_field_clears(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 2, "lastError": "timeout"}})
        beat(w, till, {"transmission": {"pendingCount": 0}})
        assert till.transmission_pending_count == 0 and till.transmission_last_error is None

    def test_a_beat_without_the_block_leaves_it(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 2}})
        beat(w, till, {"appVersion": "1.0"})
        beat(w, till)
        assert till.transmission_pending_count == 2

    @pytest.mark.parametrize("block", ["garbage", 5, ["x"], True])
    def test_a_block_that_is_not_an_object_is_ignored_never_a_422(self, w, block):
        till = w.tills[0]
        body = MachineHeartbeatBody.model_validate({"transmission": block, "appVersion": "2.0"})
        assert body.transmission is None and body.app_version == "2.0"
        beat(w, till, {"transmission": block})
        assert till.transmission_reported_at is None

    def test_unreadable_fields_are_null_never_a_422(self):
        body = MachineHeartbeatBody.model_validate({"transmission": {
            "pendingCount": -1, "pendingAmount": "abc", "oldestPendingAt": "soon",
            "lastSuccessAt": 12, "lastError": {"a": 1}, "source": "s" * 99,
        }})
        t = body.transmission
        assert t.pending_count is None and t.pending_amount is None and t.oldest_pending_at is None
        assert t.last_error is None and t.source == "s" * 32
        assert MachineHeartbeatBody.model_validate(
            {"transmission": {"pendingCount": 2**31, "pendingAmount": "1e12", "lastError": "e" * 900}}
        ).transmission.pending_count is None

    @pytest.mark.parametrize("raw,stored", [
        ("terminal", "terminal"), ("local", "local"), (" Local ", "local"),
        ("agamento", "agamento"), ("", None), (7, "7"), (["x"], None),
    ])
    def test_the_source_is_terminal_or_local_and_never_refused(self, raw, stored):
        t = MachineHeartbeatBody.model_validate({"transmission": {"source": raw}}).transmission
        assert t.source == stored

    def test_the_assumed_count_is_stored_and_shown_never_a_flag(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=6))
        beat(w, till, {"transmission": {
            "pendingCount": 0, "assumedCount": 3,
            "lastSuccessAt": (w.now - timedelta(hours=1)).isoformat(),
        }})
        assert till.transmission_assumed_count == 3
        row = detail(w, till)
        assert row["assumedTransmissionCount"] == 3
        assert not [f for f in row["statusFlags"] if f.startswith("transmission")]
        # A snapshot like the rest: absent clears it.
        beat(w, till, {"transmission": {"pendingCount": 0}})
        assert detail(w, till)["assumedTransmissionCount"] is None

    @pytest.mark.parametrize("raw", [-1, "x", 2**31, 1.5, True])
    def test_an_unreadable_assumed_count_is_null(self, raw):
        t = MachineHeartbeatBody.model_validate({"transmission": {"assumedCount": raw}}).transmission
        assert t.assumed_count is None

    def test_long_error_is_cut(self):
        t = MachineHeartbeatBody.model_validate({"transmission": {"lastError": "e" * 900}}).transmission
        assert len(t.last_error) == 500

    def test_the_route_answers_with_a_bad_block(self, monkeypatch):
        """Through FastAPI: the body is parsed there, so this is where a 422 would come from."""
        from unittest.mock import MagicMock

        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.main import app
        from app.middleware.auth import get_pos_machine_from_machine_token

        seen = []
        monkeypatch.setattr(machines_router, "update_machine_heartbeat", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "take_pending_close_shift", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "z_reported_through_sequence", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "recent_shift_zs", lambda *a, **k: [])
        monkeypatch.setattr(machines_router, "is_foreign_shift", lambda *a, **k: False)
        monkeypatch.setattr(machines_router.transmit_requests, "take_pending", lambda *a, **k: None)
        monkeypatch.setattr(
            machines_router.transmissions, "apply_heartbeat_block", lambda m, block: seen.append(block)
        )
        app.dependency_overrides[get_db] = lambda: MagicMock()
        app.dependency_overrides[get_pos_machine_from_machine_token] = lambda: MagicMock()
        try:
            client = TestClient(app)
            r = client.post("/api/v1/machines/me/heartbeat", json={
                "transmission": {"pendingCount": "many", "oldestPendingAt": [1], "pendingAmount": {"x": 1},
                                 "lastSuccessAt": "2026-09-30T10:00:00+03:00"},
            })
            r2 = client.post("/api/v1/machines/me/heartbeat", json={"transmission": "nope"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200 and r2.status_code == 200
        assert len(seen) == 1 and seen[0].pending_count is None
        assert seen[0].last_success_at is not None


# ── Transmit requests ───────────────────────────────────────────────────────


class TestTransmitRequests:
    def test_an_online_till_is_pushed_transmit(self, w):
        till = w.tills[0]
        out, code = ask(w, till)

        assert code == 201 and out["status"] == S.WAITING
        assert w.sent == [(str(w.tenant.id), str(till.id), out["id"], "admin")]
        assert out["sentAt"] is not None

    def test_a_second_click_returns_the_pending_one(self, w):
        till = w.tills[0]
        first, _ = ask(w, till)
        second, code = ask(w, till)
        assert code == 200 and second["id"] == first["id"] and len(w.sent) == 1

    def test_an_offline_till_collects_it_on_every_beat(self, w):
        till = w.tills[0]
        till.last_heartbeat_at = w.now - timedelta(hours=2)
        out, _ = ask(w, till)
        assert w.sent == []

        assert beat(w, till)["pendingTransmit"] == {"requestId": out["id"]}
        ack(w, till, out["id"], "received")
        assert beat(w, till)["pendingTransmit"] == {"requestId": out["id"]}

    def test_no_request_no_field(self, w):
        assert "pendingTransmit" not in beat(w, w.tills[0])

    def test_acks_move_it(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)

        assert ack(w, till, out["id"], "received")["requestStatus"] == S.TRANSMITTING
        ack(w, till, out["id"], "deferred", errorCode="card_in_flight")
        req = w.db.get(TransmitRequest, uuid.UUID(out["id"]))
        assert req.status == S.TRANSMITTING and req.error_code == "card_in_flight"

        tid = uuid.uuid4()
        assert ack(w, till, out["id"], "completed", transmissionId=str(tid))["requestStatus"] == S.COMPLETED
        assert req.transmission_id == tid and req.error_code is None
        assert "pendingTransmit" not in beat(w, till)

    def test_a_failed_ack_fails_it(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)
        assert ack(w, till, out["id"], "failed", errorCode="terminal_busy")["requestStatus"] == S.FAILED

    def test_an_ack_after_the_end_changes_nothing(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)
        ack(w, till, out["id"], "failed")
        assert ack(w, till, out["id"], "completed")["requestStatus"] == S.FAILED

    def test_an_ack_for_an_unknown_or_another_tills_request_is_404(self, w):
        out, _ = ask(w, w.tills[0])
        for till, rid in ((w.tills[0], uuid.uuid4()), (w.tills[1], out["id"])):
            with pytest.raises(HTTPException) as e:
                ack(w, till, rid, "received")
            assert e.value.status_code == 404 and e.value.detail == "transmit_request_not_found"

    def test_a_report_naming_the_request_finishes_it(self, w):
        till = w.tills[0]
        ok, _ = ask(w, till)
        body = report_body(requestId=ok["id"], trigger="remote")
        post_report(w, till, body)
        got = requests_router.get_transmit_request(
            request_id=uuid.UUID(ok["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        assert got["status"] == S.COMPLETED and got["transmissionId"] == str(body.id)
        assert got["transmission"]["id"] == str(body.id)

    def test_a_failed_report_naming_it_fails_it_and_unknown_leaves_it(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)
        post_report(w, till, report_body(requestId=out["id"], status="unknown"))
        req = w.db.get(TransmitRequest, uuid.UUID(out["id"]))
        assert req.status == S.WAITING
        post_report(w, till, report_body(requestId=out["id"], status="failed", error="timeout"))
        assert req.status == S.FAILED and req.error_message == "timeout"

    def test_it_expires_after_36_hours(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)
        req = w.db.get(TransmitRequest, uuid.UUID(out["id"]))
        assert req.expires_at - req.created_at == timedelta(hours=36)
        TR.expire_overdue(w.db, now=w.now + timedelta(hours=37))
        assert req.status == S.EXPIRED
        assert "pendingTransmit" not in beat(w, till)

    def test_cancel(self, w):
        till = w.tills[0]
        out, _ = ask(w, till)
        got = requests_router.cancel_transmit_request(
            request_id=uuid.UUID(out["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        assert got["status"] == S.CANCELLED
        assert "pendingTransmit" not in beat(w, till)
        with pytest.raises(HTTPException) as e:
            requests_router.cancel_transmit_request(
                request_id=uuid.UUID(out["id"]), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
            )
        assert e.value.status_code == 409 and e.value.detail == "request_not_pending"

    def test_an_unassigned_till_is_409(self, w):
        till = w.tills[0]
        till.shop_id = None
        with pytest.raises(HTTPException) as e:
            ask(w, till)
        assert e.value.status_code == 409 and e.value.detail == "machine_not_assigned"

    def test_another_tenants_request_is_404(self, w):
        out, _ = ask(w, w.tills[0])
        with pytest.raises(HTTPException) as e:
            requests_router.get_transmit_request(
                request_id=uuid.UUID(out["id"]), current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db
            )
        assert e.value.status_code == 404

    def test_machines_list_shows_it_pending(self, w):
        out, _ = ask(w, w.tills[0])
        row = detail(w, w.tills[0])
        assert row["transmitPending"] is True and str(row["pendingTransmitRequestId"]) == out["id"]


class TestWhoMayAsk:
    def test_a_shop_manager_of_the_shop_may(self, w):
        _out, code = ask(w, w.tills[0], user(w, UserRole.SHOP_MANAGER, w.shop))
        assert code == 201

    def test_a_shop_manager_of_another_shop_may_not(self, w):
        with pytest.raises(HTTPException) as e:
            ask(w, w.tills[0], user(w, UserRole.SHOP_MANAGER, w.other_shop))
        assert e.value.status_code == 403

    def test_another_distributors_till_is_refused(self, w):
        with pytest.raises(HTTPException) as e:
            ask(w, w.tills[0], user(w, UserRole.DISTRIBUTOR))
        assert e.value.status_code == 403

    def test_the_tills_own_distributor_may(self, w):
        _out, code = ask(w, w.tills[0], w.admin)  # distributor_id is the admin in the world
        assert code == 201

    def test_the_routes_need_a_machine_admin(self):
        from app.main import app
        from app.middleware.auth import get_current_machine_admin

        for method, path in (
            ("POST", "/api/v1/machines/{machine_id}/transmit"),
            ("GET", "/api/v1/transmit-requests/{request_id}"),
            ("POST", "/api/v1/transmit-requests/{request_id}/cancel"),
        ):
            route = next(
                r for r in app.routes
                if getattr(r, "path", None) == path and method in getattr(r, "methods", set())
            )
            assert get_current_machine_admin in {d.call for d in route.dependant.dependencies}

    def test_reads_are_for_whoever_sees_the_till(self, w):
        other = user(w, UserRole.SHOP_MANAGER, w.other_shop)
        mine = user(w, UserRole.SHOP_MANAGER, w.shop)
        for fn in (machines_router.list_untransmitted_card_sales,):
            assert fn(machine_id=w.tills[0].id, current_user=mine, active_tenant_id=w.tenant.id, db=w.db)
            with pytest.raises(HTTPException) as e:
                fn(machine_id=w.tills[0].id, current_user=other, active_tenant_id=w.tenant.id, db=w.db)
            assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            machines_router.list_machine_transmissions(
                machine_id=w.tills[0].id, limit=50, offset=0, current_user=other,
                active_tenant_id=w.tenant.id, db=w.db,
            )
        assert e.value.status_code == 403


# ── History ─────────────────────────────────────────────────────────────────


class TestHistory:
    def test_newest_first_with_matches_and_a_detail(self, w):
        till = w.tills[0]
        card_doc(w, till, "A")
        old = report_body(startedAt=(w.now - timedelta(days=1)).isoformat(), status="failed", error="timeout")
        new = report_body(terminalTransactionIds=["A", "Q"])
        post_report(w, till, old)
        post_report(w, till, new)
        post_report(w, w.tills[1], report_body())

        out = machines_router.list_machine_transmissions(
            machine_id=till.id, limit=50, offset=0, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        assert out["total"] == 2
        assert [i["id"] for i in out["items"]] == [str(new.id), str(old.id)]
        assert out["items"][0]["legsMatched"] == 1 and out["items"][0]["terminalTransactionCount"] == 2
        assert "reportText" not in out["items"][0]
        assert out["items"][0]["amount"] == "50.00"

        one = machines_router.get_machine_transmission(
            machine_id=till.id, transmission_id=new.id, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        assert one["terminalTransactionIds"] == ["A", "Q"] and one["reportText"] == "Z"
        with pytest.raises(HTTPException):
            machines_router.get_machine_transmission(
                machine_id=w.tills[1].id, transmission_id=new.id, current_user=w.admin,
                active_tenant_id=w.tenant.id, db=w.db,
            )


# ── Machines list fields and flags ──────────────────────────────────────────


def flags_at(**kw):
    now = kw.pop("now", datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc))
    data = StatusInput(is_active=True, pairing_status="assigned", last_heartbeat_at=now, **kw)
    return resolve_status(data, now=now), now


NOW30 = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


class TestFlags:
    def test_nothing_pending_no_flag_however_old_the_last_success(self):
        r, _ = flags_at(transmission_pending=False, transmission_last_success_at=NOW30 - timedelta(days=9))
        assert "transmission_overdue" not in r.flags

    def test_23_hours_is_not_overdue_25_is(self):
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(hours=23),
                        transmission_last_success_at=NOW30 - timedelta(hours=2))
        assert r.flags == []
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(hours=25),
                        transmission_last_success_at=NOW30 - timedelta(hours=2))
        assert r.flags == [MachineFlag.TRANSMISSION_OVERDUE]

    def test_no_success_for_24_hours_with_something_pending_is_overdue(self):
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(hours=1),
                        transmission_last_success_at=NOW30 - timedelta(hours=30))
        assert r.flags == [MachineFlag.TRANSMISSION_OVERDUE]

    def test_never_succeeded_counts_from_the_tracking_start(self):
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(hours=1),
                        transmission_tracking_started_at=NOW30 - timedelta(hours=2))
        assert r.flags == []
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(hours=1),
                        transmission_tracking_started_at=NOW30 - timedelta(hours=26))
        assert r.flags == [MachineFlag.TRANSMISSION_OVERDUE]

    def test_over_4_days_is_critical_and_overdue(self):
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(days=3, hours=23))
        assert MachineFlag.TRANSMISSION_CRITICAL not in r.flags
        r, _ = flags_at(transmission_pending=True, transmission_oldest_pending_at=NOW30 - timedelta(days=4, hours=1))
        assert r.flags == [MachineFlag.TRANSMISSION_OVERDUE, MachineFlag.TRANSMISSION_CRITICAL]

    def test_an_unknown_oldest_falls_back_on_the_last_success(self):
        r, _ = flags_at(transmission_pending=True, transmission_last_success_at=NOW30 - timedelta(days=5))
        assert MachineFlag.TRANSMISSION_CRITICAL in r.flags

    def test_flags_never_change_the_colour(self):
        calm, _ = flags_at(shift_open=True, transmission_pending=False)
        alarmed, _ = flags_at(shift_open=True, transmission_pending=True,
                              transmission_oldest_pending_at=NOW30 - timedelta(days=6))
        assert calm.status == alarmed.status
        assert MachineFlag.TRANSMISSION_CRITICAL in alarmed.flags


class TestMachineFields:
    def test_a_till_that_never_reported(self, w):
        row = detail(w, w.tills[0])
        assert row["pendingTransmissionCount"] is None and row["pendingTransmissionAmount"] is None
        assert row["untransmittedCardLegs"] == 0 and row["transmissionTrackingStartedAt"] is None
        assert row["transmitPending"] is False
        assert not [f for f in row["statusFlags"] if f.startswith("transmission")]

    def test_the_tills_reading_and_our_records(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {
            "pendingCount": 3, "pendingAmount": "90.00",
            "oldestPendingAt": (w.now - timedelta(hours=30)).isoformat(),
            "lastSuccessAt": (w.now - timedelta(hours=40)).isoformat(),
        }})
        till.transmission_tracking_started_at = w.now - timedelta(days=3)
        card_doc(w, till, "A", "20.00", at=w.now - timedelta(hours=50))

        row = detail(w, till)

        assert row["pendingTransmissionCount"] == 3 and row["pendingTransmissionAmount"] == "90.00"
        assert row["untransmittedCardLegs"] == 1 and row["untransmittedCardAmount"] == "20.00"
        # The earlier of the two accounts.
        assert row["oldestPendingTransmissionAt"] == (w.now - timedelta(hours=50))
        assert row["transmissionSource"] is None and row["transmissionReportedAt"] is not None
        assert "transmission_overdue" in row["statusFlags"]

    def test_our_records_stand_in_when_the_till_sent_no_reading(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=1))
        card_doc(w, till, "A", "20.00")
        row = detail(w, till)
        assert row["pendingTransmissionCount"] == 1 and row["pendingTransmissionAmount"] == "20.00"

    def test_last_transmission_and_its_error(self, w):
        till = w.tills[0]
        ok = report_body(startedAt=(w.now - timedelta(hours=5)).isoformat(),
                         finishedAt=(w.now - timedelta(hours=5)).isoformat())
        post_report(w, till, ok)
        post_report(w, till, report_body(status="failed", error="no line",
                                         startedAt=(w.now - timedelta(hours=1)).isoformat(),
                                         finishedAt=(w.now - timedelta(hours=1)).isoformat()))
        row = detail(w, till)
        assert row["lastTransmissionAt"] == (w.now - timedelta(hours=5))
        assert row["lastTransmissionError"] == "no line"

        post_report(w, till, report_body())
        assert detail(w, till)["lastTransmissionError"] is None

    def test_the_list_carries_it_too(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=6))
        card_doc(w, till, "A", at=w.now - timedelta(days=5))
        rows = machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
            include_inactive=False, area_id=None, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        mine = next(r for r in rows if r["id"] == till.id)
        other = next(r for r in rows if r["id"] == w.tills[1].id)
        assert "transmission_critical" in mine["statusFlags"]
        assert mine["untransmittedCardLegs"] == 1
        assert other["untransmittedCardLegs"] == 0


# ── Recovery list ───────────────────────────────────────────────────────────


class TestUntransmitted:
    def _list(self, w, till):
        return machines_router.list_untransmitted_card_sales(
            machine_id=till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )

    def test_empty_until_the_till_reports(self, w):
        till = w.tills[0]
        card_doc(w, till, "A")
        out = self._list(w, till)
        assert out["trackingStartedAt"] is None and out["count"] == 0 and out["items"] == []

    def test_only_after_tracking_start_with_a_uid_in_no_successful_batch(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=2))
        card_doc(w, till, "OLD", at=w.now - timedelta(days=3))                  # before tracking
        card_doc(w, till, "GONE")                                                # transmitted below
        card_doc(w, till, "X", status=TransactionStatus.CANCELLED)               # cancelled
        card_doc(w, till, None, meta={"vuid": "v"})                              # no uid
        card_doc(w, till, "CASH", method="cash")                                 # not card
        refunded, _ = card_doc(w, till, "R", "15.00", status=TransactionStatus.REFUNDED,
                               at=w.now - timedelta(hours=3))
        kept, _ = card_doc(w, till, "KEEP", "35.00", at=w.now - timedelta(hours=2),
                           meta={"uid": "KEEP", "authNum": "555", "maskedCard": "458012******9876"})
        card_doc(w, w.tills[1], "KEEP")                                          # another till
        post_report(w, till, report_body(terminalTransactionIds=["GONE"]))

        out = self._list(w, till)

        assert out["count"] == 2 and out["amount"] == "50.00"
        assert [i["transactionId"] for i in out["items"]] == [str(refunded.id), str(kept.id)]
        item = out["items"][1]
        assert item["terminalTransactionId"] == "KEEP" and item["approvalNumber"] == "555"
        assert item["cardLast4"] == "9876"
        assert "458012" not in str(out)

    def test_the_tills_reading_is_alongside(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 5}})
        out = self._list(w, till)
        assert out["tillPendingCount"] == 5 and out["tillReportedAt"] is not None


# ── Replacement ─────────────────────────────────────────────────────────────


class TestReplacement:
    def _code(self, w, till, ack=False):
        return machines_router.create_replacement_pairing_code(
            machine_id=till.id, body=ReplacementCodeBody(acknowledgeUntransmitted=ack),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def test_a_clean_till_gets_its_code(self, w):
        out = self._code(w, w.tills[0])
        assert out["code"] and out["untransmittedAcknowledged"] is False

    def test_refused_while_the_till_reports_pending(self, w):
        beat(w, w.tills[0], {"transmission": {"pendingCount": 1}})
        with pytest.raises(HTTPException) as e:
            self._code(w, w.tills[0])
        assert e.value.status_code == 409 and e.value.detail == "untransmitted_card_sales"

    def test_refused_while_our_records_show_untransmitted_legs(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 0}})
        till.transmission_tracking_started_at = w.now - timedelta(days=1)
        card_doc(w, till, "A")
        with pytest.raises(HTTPException) as e:
            self._code(w, till)
        assert e.value.detail == "untransmitted_card_sales"

    def test_historical_sales_before_tracking_do_not_block(self, w):
        till = w.tills[0]
        card_doc(w, till, "A", at=w.now - timedelta(days=30))
        track(w, till, w.now - timedelta(days=1))
        assert self._code(w, till)["code"]

    @pytest.fixture(autouse=True)
    def _naive_pairing_clock(self, monkeypatch):
        """SQLite hands `expires_at` back without its zone; compare it naive, as stored."""
        class _Naive(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(timezone.utc).replace(tzinfo=None)

        monkeypatch.setattr(P, "datetime", _Naive)

    def _redeem(self, w, code):
        from app.schemas.pairing_code import PairingCodeValidate

        return pairing_router.validate_pairing(
            pairing_data=PairingCodeValidate.model_validate({"code": code, "deviceInfo": {"m": "new"}}),
            db=w.db,
        )

    def test_the_adoption_is_refused_with_409_too(self, w, monkeypatch):
        till = w.tills[0]
        code = self._code(w, till)["code"]
        # The old device reports a pending batch after the code was made.
        beat(w, till, {"transmission": {"pendingCount": 2}})

        with pytest.raises(HTTPException) as e:
            self._redeem(w, code)
        assert e.value.status_code == 409 and e.value.detail == "untransmitted_card_sales"
        assert w.db.query(PairingCode).filter(PairingCode.code == code).one().is_used is False

    def test_an_acknowledged_code_is_adopted_and_tracking_restarts(self, w, monkeypatch):
        monkeypatch.setattr(pairing_router, "machine_realtime_connection_info", lambda **kw: kw)
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 2, "pendingAmount": "40.00", "assumedCount": 1}})
        out = self._code(w, till, ack=True)
        row = w.db.query(PairingCode).filter(PairingCode.code == out["code"]).one()
        assert out["untransmittedAcknowledged"] is True
        assert row.untransmitted_acknowledged_by_user_id == w.admin.id
        assert row.untransmitted_acknowledged_at is not None

        self._redeem(w, out["code"])

        w.db.refresh(till)
        assert till.transmission_pending_count is None
        assert till.transmission_assumed_count is None
        assert till.transmission_tracking_started_at is None
        assert till.transmission_reported_at is None

    def test_the_adoption_service_refuses_unless_acknowledged(self, w):
        till = w.tills[0]
        beat(w, till, {"transmission": {"pendingCount": 1}})
        with pytest.raises(P.AdoptionRefused):
            P.adopt_machine(w.db, till.id)
        assert P.adopt_machine(w.db, till.id, untransmitted_acknowledged=True) is till


# ── X and Z ─────────────────────────────────────────────────────────────────


class TestXAndZ:
    def test_the_x_detail_carries_the_block(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=1))
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=w.now - timedelta(hours=5))
        card_doc(w, till, "A", "10.00", shift=shift)
        card_doc(w, till, "B", "15.00", shift=shift)
        body = report_body(batchNumber="B1", terminalTransactionIds=["A"],
                           startedAt=(w.now - timedelta(hours=1)).isoformat())
        post_report(w, till, body)
        post_report(w, w.tills[1], report_body())  # another till's batch: not here

        out = shifts_router.get_shift(
            shift_id=shift.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
        block = out.transmission
        assert block["cardLegs"] == 2 and block["transmittedLegs"] == 1
        assert block["untransmittedLegs"] == 1 and block["untransmittedAmount"] == "15.00"
        assert [b["batchNumber"] for b in block["batches"]] == ["B1"]
        assert block["batches"][0]["legsInPeriod"] == 1
        assert out.model_dump(by_alias=True)["transmission"]["cardLegs"] == 2

    def test_legs_before_tracking_are_untracked_not_untransmitted(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=w.now - timedelta(hours=5))
        card_doc(w, till, "A", shift=shift)
        block = T.period_block(w.db, till, [shift])
        assert block["untrackedLegs"] == 1 and block["untransmittedLegs"] == 0

    def test_a_batch_after_the_shift_closed_that_carried_its_sale_is_on_it(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=1))
        shift = w.shift(till, 1, status=ShiftStatus.CLOSED, opened_at=w.now - timedelta(hours=10))
        card_doc(w, till, "A", shift=shift, at=w.now - timedelta(hours=9))
        post_report(w, till, report_body(terminalTransactionIds=["A"]))  # now: after the close
        block = T.period_block(w.db, till, [shift])
        assert len(block["batches"]) == 1 and block["transmittedLegs"] == 1

    def test_the_z_is_built_whatever_is_pending_and_freezes_the_block(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(days=1))
        beat(w, till, {"transmission": {"pendingCount": 1, "pendingAmount": "10.00"}})
        shift = w.shift(till, 1, status=ShiftStatus.CLOSED, opened_at=w.now - timedelta(hours=6))
        card_doc(w, till, "A", "10.00", shift=shift, at=w.now - timedelta(minutes=30))

        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])

        section = z.per_machine[0]
        assert section["transmission"]["untransmittedLegs"] == 1
        assert section["transmission"]["tillPendingCount"] == 1
        assert section["transmission"]["tillPendingAmount"] == "10.00"
        assert section["transmission"]["asOf"] is not None
        import json

        json.dumps(section)  # stored as JSON: must serialise as is


# ── Migration ───────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_shop_areas():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert len(heads) == 1
    assert "e0f1a2b3c4d5" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("e0f1a2b3c4d5").down_revision == "d9e0f1a2b3c4"


# ── The till's elevation scope ───────────────────────────────────────────────


class TestTransmitScope:
    """`transmit`: a cashier asks a manager's PIN for "שדר עסקאות עכשיו"."""

    def test_the_wire_name_is_pinned_and_parsed(self):
        from app.services.permissions import Scope, parse_scopes

        assert Scope.TRANSMIT.value == "transmit"
        assert parse_scopes(["transmit", "refund"]) == [Scope.TRANSMIT, Scope.REFUND]

    @pytest.mark.parametrize("role", [
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER, UserRole.SHIFT_SUPERVISOR,
    ])
    def test_the_roles_that_may_transmit_remotely_and_the_supervisor_hold_it(self, role):
        from app.services.permissions import Scope, till_grantable_scopes

        assert Scope.TRANSMIT in till_grantable_scopes(role)

    def test_a_cashier_does_not(self):
        from app.services.permissions import Scope, till_grantable_scopes

        assert Scope.TRANSMIT not in till_grantable_scopes(UserRole.CASHIER)

    def test_a_till_shop_manager_holds_it_a_till_cashier_does_not(self):
        from app.models.pos_user import PosUserRole
        from app.services.permissions import Scope, pos_user_till_scopes

        assert Scope.TRANSMIT in pos_user_till_scopes(PosUserRole.SHOP_MANAGER)
        assert Scope.TRANSMIT not in pos_user_till_scopes(PosUserRole.CASHIER)

    def test_one_pin_per_transmission(self):
        from app.services.permissions import Scope, requires_per_action_reauth

        assert requires_per_action_reauth(Scope.TRANSMIT) is True
