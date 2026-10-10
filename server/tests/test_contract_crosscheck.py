"""
Fixes from a cross-check of the server against what the Android till actually sends.

* A card leg's `nayaxMeta` arrives as a JSON *string*; typed as an object it made every
  card sale's batch a 422 — the whole outbox stuck on a charged sale.
* `creditPayments` (instalments) on a card leg is kept, beside the acquirer reply.
* The heartbeat never 422s: an over-long string is cut, an unreadable field is dropped.
* A duplicate re-push that moves a document between shifts recomputes the shift it left.
* The till's Ably token may read history, which its rewind attach needs.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.transaction_payment import TransactionPayment
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.transaction import TransactionIn, TransactionPaymentIn, TransactionsBatchRequest
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _card_sale(shift_id, meta, **leg_extra):
    leg = {"id": str(uuid.uuid4()), "sequence": 1, "method": "card", "amount": 50.0, "nayaxMeta": meta}
    leg.update(leg_extra)
    return {
        "id": str(uuid.uuid4()), "transactionNumber": "77", "status": "completed",
        "totalAmount": 50.0, "paymentMethod": "card", "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift_id), "businessDate": str(TODAY), "payments": [leg],
    }


class TestTheCardLegsMeta:
    def test_a_json_string_is_read_as_an_object(self):
        leg = TransactionPaymentIn.model_validate(
            {"id": str(uuid.uuid4()), "method": "card", "amount": 5,
             "nayaxMeta": json.dumps({"vuid": "V1", "authNumber": "0042"})}
        )
        assert leg.nayax_meta == {"vuid": "V1", "authNumber": "0042"}

    @pytest.mark.parametrize("raw", ["not json {", "[1, 2]", "17"])
    def test_anything_else_is_kept_raw_rather_than_rejected(self, raw):
        leg = TransactionPaymentIn.model_validate(
            {"id": str(uuid.uuid4()), "method": "card", "amount": 5, "nayaxMeta": raw}
        )
        assert leg.nayax_meta == {"raw": raw}

    def test_an_object_and_an_empty_string_still_work(self):
        base = {"id": str(uuid.uuid4()), "method": "card", "amount": 5}
        assert TransactionPaymentIn.model_validate({**base, "nayaxMeta": {"a": 1}}).nayax_meta == {"a": 1}
        assert TransactionPaymentIn.model_validate({**base, "nayaxMeta": ""}).nayax_meta is None

    def test_the_whole_till_batch_validates(self, w):
        """The shape the till sends (Dtos.kt TransactionPaymentPayload), end to end."""
        body = TransactionsBatchRequest.model_validate(
            {"transactions": [_card_sale(uuid.uuid4(), json.dumps({"vuid": "V1"}), creditPayments=3, createdAt=NOW.isoformat())]}
        )
        assert body.transactions[0].payments[0].credit_payments == 3

    def test_the_instalments_are_stored_with_the_acquirer_reply(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        tx = TransactionIn.model_validate(_card_sale(shift.id, json.dumps({"vuid": "V1"}), creditPayments=3))

        assert [r.status for r in upsert_transactions(w.db, till, [tx])] == ["accepted"]

        leg = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id).one()
        assert leg.nayax_meta == {"vuid": "V1", "creditPayments": 3}

    def test_an_unreadable_instalment_count_is_dropped_not_rejected(self):
        leg = TransactionPaymentIn.model_validate(
            {"id": str(uuid.uuid4()), "method": "card", "amount": 5, "creditPayments": "three"}
        )
        assert leg.credit_payments is None


class TestTheHeartbeatNever422s:
    def test_over_long_strings_are_cut(self):
        b = MachineHeartbeatBody.model_validate(
            {"appVersion": "1" * 100, "serialNumber": "S" * 100, "batteryStatus": "x" * 100}
        )
        assert (len(b.app_version), len(b.serial_number), len(b.battery_status)) == (64, 64, 32)

    def test_a_real_version_string_over_32_is_kept_whole(self):
        version = "0.1.105-debug+sha.0123456789abcdef"
        assert len(version) > 32
        assert MachineHeartbeatBody.model_validate({"appVersion": version}).app_version == version

    def test_unreadable_fields_are_dropped(self):
        b = MachineHeartbeatBody.model_validate({
            "pendingCount": -1, "pendingDocuments": "lots", "batteryPercent": "?",
            "openShiftId": "not-a-uuid", "openShiftOpenedAt": "yesterday", "clockSkewMs": 5,
        })
        assert (b.pending_count, b.pending_documents, b.battery_percent) == (None, None, None)
        assert (b.open_shift_id, b.open_shift_opened_at, b.clock_skew_ms) == (None, None, 5)

    def test_the_stored_version_is_cut_at_the_column_width(self):
        from app.models.pos_machine import POSMachine
        from app.services import sync as S

        row = POSMachine()
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = row
        S.update_machine_heartbeat(db, "m", app_version="v" * 80)

        assert row.app_version == "v" * 64
        assert POSMachine.__table__.columns["app_version"].type.length == 64


class TestADuplicateMoveRecomputesTheShiftItLeft:
    def test_the_old_closed_shift_loses_the_document_from_its_x(self, w):
        till = w.tills[0]
        old = w.shift(till, 1, status=ShiftStatus.OPEN)
        tx = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "5", "status": "completed",
            "totalAmount": "20.00", "paymentMethod": "cash", "reprintCount": 0,
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(old.id),
        })
        upsert_transactions(w.db, till, [tx])
        old.status = ShiftStatus.CLOSED
        old.total_sales = Decimal("20.00")
        old.transactions_count = 1
        new = w.shift(till, 2, status=ShiftStatus.OPEN)
        w.db.flush()

        # Same updated_at: a "duplicate", yet the row moves to the new shift.
        tx.shift_id = new.id
        tx.updated_at = NOW.replace(tzinfo=None)  # SQLite reads the stored value back naive
        results = upsert_transactions(w.db, till, [tx])

        assert [r.status for r in results] == ["duplicate"]
        stored = w.db.get(Shift, old.id)
        assert stored.total_sales == Decimal("0")
        assert stored.transactions_count == 0
        assert stored.late_documents == 0


class TestTheAblyToken:
    def test_the_till_may_subscribe_and_read_history(self, monkeypatch):
        from app.services import ably_notify

        captured = {}

        class _Auth:
            def create_token_request(self, params):
                captured.update(params)
                return MagicMock(to_dict=lambda: {"ok": True})

        monkeypatch.setattr(ably_notify, "_rest", lambda: MagicMock(auth=_Auth()))
        machine = MagicMock(tenant_id=uuid.uuid4(), id=uuid.uuid4(), mqtt_client_id=None)

        ably_notify.create_token_request_for_machine(machine)

        # Its own channel, and its shop's (the coalesced "tables" signal): read only, both.
        capabilities = captured["capability"]
        assert f"pos:{machine.tenant_id}:{machine.id}" in capabilities
        for capability in capabilities.values():
            assert sorted(capability) == ["history", "subscribe"]
