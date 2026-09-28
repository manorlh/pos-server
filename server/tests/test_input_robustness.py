"""
Inputs that must never become a 500 the till retries forever (review R1, R2).

* Heartbeat backlog counts beyond the INTEGER column are dropped (unknown), never a
  failed write; an unreadable `openShiftId` leaves the stored claim as it was (R2) —
  only an absent/null one means "none open".
* An acquirer reply (`nayaxMeta`) over 16 KB, nested past the parser, or carrying
  NaN / Infinity (which JSONB refuses) is kept as `{"raw": …}`; an instalment count
  that overflows is dropped.
* Shift open/close money is rounded to the cent and bounded to NUMERIC(12, 2), and the
  sequence to INTEGER: an impossible value is a 422 (the till parks it), never a 500.
  The till's own X with NaN in it is stored as text and reads as a mismatch.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import META_MAX_CHARS, TransactionPaymentIn, meta_as_dict
from app.services.shift_totals import DocumentTotals, till_totals_mismatch
from shift_world import accept_str_uuids, make_world


class TestHeartbeatNumbers:
    @pytest.mark.parametrize("field", ["pendingCount", "pendingDocuments"])
    def test_a_count_beyond_the_column_is_unknown(self, field):
        body = MachineHeartbeatBody.model_validate({field: 2**31})
        assert getattr(body, "pending_count" if field == "pendingCount" else "pending_documents") is None

    def test_the_largest_count_that_fits_is_kept(self):
        assert MachineHeartbeatBody.model_validate({"pendingCount": 2**31 - 1}).pending_count == 2**31 - 1

    def test_an_absurd_clock_skew_is_unknown(self):
        assert MachineHeartbeatBody.model_validate({"clockSkewMs": 2**70}).clock_skew_ms is None


class TestHeartbeatClaim:
    @pytest.fixture
    def w(self, monkeypatch):
        accept_str_uuids(monkeypatch)
        world = make_world()
        monkeypatch.setattr(machines_router, "update_machine_heartbeat", lambda *a, **k: None)
        return world

    def _beat(self, w, till, body):
        return machines_router.post_my_heartbeat(MachineHeartbeatBody.model_validate(body), machine=till, db=w.db)

    def test_an_unreadable_open_shift_id_leaves_the_claim(self, w):
        till = w.tills[0]
        claim = uuid.uuid4()
        till.reported_open_shift_id = claim

        self._beat(w, till, {"openShiftId": "not-a-uuid"})

        assert till.reported_open_shift_id == claim

    def test_an_absent_one_still_means_none_open(self, w):
        till = w.tills[0]
        till.reported_open_shift_id = uuid.uuid4()
        self._beat(w, till, {})
        assert till.reported_open_shift_id is None

    def test_a_readable_one_replaces_it(self, w):
        till = w.tills[0]
        till.reported_open_shift_id = uuid.uuid4()
        new = uuid.uuid4()
        self._beat(w, till, {"openShiftId": str(new)})
        assert till.reported_open_shift_id == new

    def test_the_flag_is_not_set_for_a_good_or_null_id(self):
        assert not MachineHeartbeatBody.model_validate({"openShiftId": None}).open_shift_id_unreadable
        assert not MachineHeartbeatBody.model_validate({"openShiftId": str(uuid.uuid4())}).open_shift_id_unreadable
        assert MachineHeartbeatBody.model_validate({"openShiftId": 12}).open_shift_id_unreadable


class TestAcquirerMeta:
    def test_nan_and_infinity_are_kept_raw(self):
        for text in ('{"amount": NaN}', '{"amount": Infinity}', '{"amount": -Infinity}'):
            assert meta_as_dict(text) == {"raw": text}

    def test_an_object_with_nan_is_kept_raw(self):
        out = meta_as_dict({"amount": float("nan")})
        assert set(out) == {"raw"} and "nan" in out["raw"]
        json.dumps(out, allow_nan=False)  # storable

    def test_an_oversized_reply_is_cut(self):
        out = meta_as_dict('{"x": "' + "a" * (META_MAX_CHARS + 10) + '"}')
        assert out["truncated"] is True and len(out["raw"]) == META_MAX_CHARS

    def test_a_deeply_nested_reply_is_kept_raw(self):
        text = "[" * 5000 + "]" * 5000
        out = meta_as_dict('{"a": ' + text + "}")
        assert "raw" in out

    def test_an_ordinary_reply_is_parsed(self):
        assert meta_as_dict('{"approval": "123"}') == {"approval": "123"}

    @pytest.mark.parametrize("value", [1e999, float("inf"), 2**40, -1])
    def test_an_impossible_instalment_count_is_dropped(self, value):
        leg = TransactionPaymentIn.model_validate(
            {"id": str(uuid.uuid4()), "method": "card", "amount": "1.00", "creditPayments": value}
        )
        assert leg.credit_payments is None


class TestShiftInputsAreBounded:
    def test_a_float_with_noise_is_rounded_to_the_cent(self):
        body = ShiftCloseIn.model_validate({"closedAt": "2026-09-27T10:00:00Z", "countedCash": 12.300000000000001})
        assert body.counted_cash == Decimal("12.30")

    @pytest.mark.parametrize("value", [1e12, "NaN", "Infinity", "abc"])
    def test_money_that_cannot_fit_is_refused(self, value):
        with pytest.raises(ValidationError):
            ShiftCloseIn.model_validate({"closedAt": "2026-09-27T10:00:00Z", "expectedCash": value})

    def test_a_sequence_beyond_the_column_is_refused(self):
        with pytest.raises(ValidationError):
            ShiftOpenIn.model_validate({
                "id": str(uuid.uuid4()), "businessDate": "2026-09-27", "openedAt": "2026-09-27T10:00:00Z",
                "sequenceNumber": 2**31,
            })

    def test_the_float_on_open_is_bounded_too(self):
        with pytest.raises(ValidationError):
            ShiftOpenIn.model_validate({
                "id": str(uuid.uuid4()), "businessDate": "2026-09-27", "openedAt": "2026-09-27T10:00:00Z",
                "openingCash": "12345678901.00",
            })

    def test_the_tills_x_with_nan_is_stored_as_text_and_mismatches(self):
        body = ShiftCloseIn.model_validate({"closedAt": "2026-09-27T10:00:00Z", "till": {"totalSales": float("nan")}})
        json.dumps(body.till, allow_nan=False)
        assert till_totals_mismatch(body.till, DocumentTotals()) is True

    def test_a_refused_close_is_a_422_on_the_route(self):
        from fastapi.testclient import TestClient

        from app.main import app
        from app.middleware.auth import get_pos_machine_for_sync_path, get_pos_machine_from_sync_machine_token

        app.dependency_overrides[get_pos_machine_from_sync_machine_token] = lambda: None
        app.dependency_overrides[get_pos_machine_for_sync_path] = lambda: None
        try:
            client = TestClient(app)
            r = client.post(
                f"/api/v1/sync/{uuid.uuid4()}/shifts/{uuid.uuid4()}/close",
                json={"closedAt": "2026-09-27T10:00:00Z", "countedCash": 1e15},
                headers={"Authorization": "Bearer x"},
            )
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 422
