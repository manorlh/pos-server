"""
Server findings of the 2026-09-29 end-to-end run (docs/SHIFTS_API.md).

* **Per-document rejection** — one document the model refuses (productId "p12") was a
  422 for the whole batch, and the till retried it forever. Now it alone is `rejected`,
  with the field and the message, and the rest of the batch lands.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import inspect
import json
import uuid

import pytest
from pydantic import ValidationError

from app.models.shift import ShiftStatus
from app.models.sync_log import SyncLog, SyncStatus
from app.models.transaction import Transaction
from app.routers import sync as sync_router
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify
from app.services.transactions import validate_documents
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


def _doc(shift_id=None, total="10.00", **extra) -> dict:
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": total,
        "paymentMethod": "cash",
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return body


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id),
        body=TransactionsBatchEnvelope(transactions=docs),
        machine=till,
        db=w.db,
    )


# ── 1. Per-document rejection ────────────────────────────────────────────────


class TestOneBadDocumentDoesNotJamTheBatch:
    def test_the_bad_document_is_rejected_and_the_rest_is_stored(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        good = _doc(shift.id, "25.00")
        bad = _doc(shift.id, "12.00", items=[{
            "id": str(uuid.uuid4()), "productId": "p12", "quantity": 1,
            "unitPrice": 12, "totalPrice": 12,
        }])
        after = _doc(shift.id, "7.00")

        response = _push(w, till, [good, bad, after])

        assert [(str(r.id), r.status) for r in response.results] == [
            (good["id"], "accepted"), (bad["id"], "rejected"), (after["id"], "accepted"),
        ]
        reason = response.results[1].reason
        assert reason.startswith("items[0].productId: Input should be a valid UUID")
        stored = {str(t.id) for t in w.db.query(Transaction).all()}
        assert stored == {good["id"], after["id"]}
        assert response.unidentified is None

    def test_the_rejection_is_in_the_sync_log(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        bad = _doc(shift.id, totalAmount="lots")

        _push(w, till, [bad])

        log = w.db.query(SyncLog).one()
        assert str(log.entity_id) == bad["id"] and log.status == SyncStatus.FAILED
        assert log.conflict_note.startswith("totalAmount: ")

    def test_every_error_of_a_document_is_named(self, w):
        bad = _doc(totalAmount="lots", createdAt="yesterday")

        _valid, refused, _none = validate_documents([bad])

        reason = refused[0][1].reason
        assert "totalAmount: " in reason and "createdAt: " in reason and "; " in reason

    def test_a_document_whose_id_is_not_a_uuid_is_answered_by_that_id(self, w):
        till = w.tills[0]
        bad = _doc(id="local-17")

        response = _push(w, till, [bad])

        assert response.results[0].id == "local-17"
        assert response.results[0].status == "rejected"
        assert response.results[0].reason.startswith("id: ")
        log = w.db.query(SyncLog).one()
        assert log.entity_id is None and "local-17" in log.conflict_note

    def test_a_document_with_no_id_is_answered_by_its_position_not_in_results(self, w):
        """A shipped till decodes `results[].id` as a non-null string: never a null there."""
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        good = _doc(shift.id)
        no_id = {k: v for k, v in _doc().items() if k != "id"}

        response = _push(w, till, [no_id, "not a document", good])

        assert [(str(r.id), r.status) for r in response.results] == [(good["id"], "accepted")]
        assert [(u.index, u.status) for u in response.unidentified] == [(0, "rejected"), (1, "rejected")]
        assert response.unidentified[0].reason.startswith("id: Field required")
        assert response.unidentified[1].reason == "document: a document must be a JSON object"
        body = json.loads(response.model_dump_json(by_alias=True))
        assert all(isinstance(r["id"], str) for r in body["results"])

    def test_a_valid_batch_answers_as_before(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _doc(shift.id)

        first = _push(w, till, [doc])
        again = _push(w, till, [doc])

        assert [r.status for r in first.results] == ["accepted"]
        assert [r.status for r in again.results] == ["duplicate"]
        body = json.loads(first.model_dump_json(by_alias=True))
        assert set(body) == {"serverTime", "results", "unidentified"}
        assert body["unidentified"] is None
        assert body["results"][0]["id"] == doc["id"]

    def test_a_shift_conflict_still_refuses_the_whole_batch(self, w):
        till = w.tills[0]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()

        response = _push(w, till, [_doc(uuid.uuid4()), _doc(uuid.uuid4(), totalAmount="x")])

        assert response.status_code == 409
        assert w.db.query(Transaction).count() == 0

    def test_only_the_envelope_is_validated_by_the_route(self):
        assert inspect.signature(sync_router.post_transactions).parameters["body"].annotation is (
            TransactionsBatchEnvelope
        )
        TransactionsBatchEnvelope.model_validate({"transactions": [{"id": "x"}, 5]})
        with pytest.raises(ValidationError):
            TransactionsBatchEnvelope.model_validate({"transactions": "not a list"})
        with pytest.raises(ValidationError):
            TransactionsBatchEnvelope.model_validate({})
