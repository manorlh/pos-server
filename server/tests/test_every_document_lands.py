"""
"כל מסמך שבוצע במכשירים חייב לעלות לענן ולהיות חלק מהזד והאיקס/משמרת" (the owner, 2026-10-07).

* Nothing about a document's content refuses it: an approver nobody here knows, tenders
  that do not add up, a refund link to another tenant's document — each lands in its
  shift with a quiet `ingest_notes` entry.
* The F20 case: a document issued while the till belonged to one business and approved by
  that business's till manager, pushed after the till was re-paired to another business
  as a new machine. It was refused every hour as `approver_unknown_or_inactive`; it lands.
* What is still refused (not a document at all) is recorded in `document_refusals`
  ("מסמך שנדחה בענן"): first / last seen, attempts, payload — and marked landed when the
  same document is later stored. The reconciliation report lists it (check
  `refused_documents`), and so does the transmissions report.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.models.document_refusal import DocumentRefusal
from app.models.pos_user import PosUser, PosUserRole
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.transaction import Transaction
from app.routers import sync as sync_router
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import reconciliation as REC
from app.services.reports import resolve_report_window
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


@pytest.fixture
def shift(w):
    return w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)


def _doc(shift_id=None, **extra):
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": "10.00",
        "paymentMethod": "cash", "businessDate": str(TODAY),
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return body


def _push(w, docs, till=None):
    till = till or w.tills[0]
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _codes(tx):
    return [n["code"] for n in (tx.ingest_notes or [])]


def _rival_till_manager(w):
    rival = Tenant(id=uuid.uuid4(), name="Ran Lahagani", slug="rl", timezone="Asia/Jerusalem")
    w.db.add(rival)
    w.db.flush()
    rival_shop = Shop(id=uuid.uuid4(), tenant_id=rival.id, company_id=w.company.id, name="סניף מרכז", settings={})
    w.db.add(rival_shop)
    w.db.flush()
    manager = PosUser(
        id=uuid.uuid4(), tenant_id=rival.id, shop_id=rival_shop.id, username="default",
        first_name="Default", last_name="Cashier", pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
    )
    w.db.add(manager)
    w.db.flush()
    return manager


# ── The F20 case ─────────────────────────────────────────────────────────────


class TestTheRePairedTillsDocument:
    def test_it_lands_with_the_approver_kept_as_sent(self, w, shift):
        till = w.tills[0]
        till.created_at = NOW  # paired as this machine at NOW …
        w.db.flush()
        old_manager = _rival_till_manager(w)  # … the approval was given under the previous business
        issued = NOW - timedelta(hours=4)
        doc = _doc(
            documentType=330, approvedByPosUserId=str(old_manager.id),
            createdAt=issued.isoformat(), updatedAt=issued.isoformat(), transactionNumber="80",
        )

        (result,) = _push(w, [doc]).results

        assert result.status == "accepted"  # the till clears it from its outbox
        stored = w.db.get(Transaction, uuid.UUID(doc["id"]))
        assert stored is not None and stored.transaction_number == "80"
        assert stored.approved_by_pos_user_id is None  # never linked to another tenant's person
        assert stored.claimed_approver_pos_user_id == old_manager.id
        # No re-pair link here (no shared device serial): kept under the till that sent it,
        # in its shift covering the issue time (docs/SHIFTS_API.md §1.2c-bis).
        assert set(_codes(stored)) == {"approver_not_known", "issued_before_pairing", "filed_by_time"}
        assert stored.shift_id == shift.id
        assert w.db.query(DocumentRefusal).count() == 0

    def test_a_document_of_this_pairing_gets_no_pairing_note(self, w, shift):
        w.tills[0].created_at = NOW - timedelta(days=30)
        w.db.flush()
        (result,) = _push(w, [_doc(shift.id)]).results
        stored = w.db.query(Transaction).one()
        assert result.status == "accepted" and "issued_before_pairing" not in _codes(stored)


# ── Content never refuses ────────────────────────────────────────────────────


class TestContentNeverRefuses:
    def test_tenders_that_do_not_add_up_land_in_their_shift_with_a_note(self, w, shift):
        doc = _doc(shift.id, payments=[
            {"id": str(uuid.uuid4()), "sequence": 1, "method": "cash", "amount": "4.00"},
        ])

        (result,) = _push(w, [doc]).results

        assert result.status == "accepted"
        stored = w.db.get(Transaction, uuid.UUID(doc["id"]))
        assert stored.shift_id == shift.id
        assert "tenders_do_not_reconcile" in _codes(stored)
        note = next(n for n in stored.ingest_notes if n["code"] == "tenders_do_not_reconcile")
        assert "reconcile" in note["detail"]

    def test_an_ordinary_document_carries_no_notes(self, w, shift):
        w.tills[0].created_at = NOW - timedelta(days=30)
        w.db.flush()
        doc = _doc(shift.id)
        (result,) = _push(w, [doc]).results
        assert result.status == "accepted"
        assert w.db.get(Transaction, uuid.UUID(doc["id"])).ingest_notes is None


# ── The refusal record ───────────────────────────────────────────────────────


class TestTheRefusalRecord:
    def test_a_refused_document_is_recorded_and_counted_on_every_retry(self, w):
        bad = _doc(totalAmount="lots", transactionNumber="81")

        for _ in range(2):
            (result,) = _push(w, [bad]).results
            assert result.status == "rejected"

        (row,) = w.db.query(DocumentRefusal).all()
        assert row.machine_id == w.tills[0].id
        assert row.document_id == uuid.UUID(bad["id"])
        assert row.document_number == "81"
        assert row.attempts == 2
        assert "totalAmount" in row.reason
        assert row.payload["totalAmount"] == "lots"
        assert row.first_seen_at <= row.last_seen_at
        assert row.landed_at is None

    def test_a_document_with_no_id_is_recorded_by_its_position(self, w):
        _push(w, [{"transactionNumber": "5", "totalAmount": "1.00"}])
        (row,) = w.db.query(DocumentRefusal).all()
        assert row.document_ref == "batch-index:0" and row.document_id is None

    def test_the_same_document_landing_later_closes_the_refusal(self, w, shift):
        doc = _doc(shift.id, totalAmount="lots")
        _push(w, [doc])
        fixed = {**doc, "totalAmount": "10.00"}

        (result,) = _push(w, [fixed]).results

        assert result.status == "accepted"
        (row,) = w.db.query(DocumentRefusal).all()
        assert row.landed_at is not None

    def test_recording_never_fails_the_push(self, w, shift, monkeypatch):
        from app.services import document_refusals as DR

        def boom(*a, **k):
            raise RuntimeError("log down")

        monkeypatch.setattr(DR, "record", boom)
        good, bad = _doc(shift.id), _doc(shift.id, totalAmount="lots")

        results = _push(w, [good, bad]).results

        assert [r.status for r in results] == ["accepted", "rejected"]
        assert w.db.get(Transaction, uuid.UUID(good["id"])) is not None


# ── Where it shows ───────────────────────────────────────────────────────────


def _window(w):
    return resolve_report_window(
        w.db, w.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1),
        tz="Asia/Jerusalem",
    )


class TestShownInTheReports:
    def test_the_reconciliation_lists_a_refused_document(self, w):
        bad = _doc(totalAmount="lots", transactionNumber="80")
        _push(w, [bad])

        out = REC.build_reconciliation(
            w.db, w.admin, w.tenant.id, _window(w), machine_ids=[w.tills[0].id], checks=("refused_documents",),
            now=NOW + timedelta(hours=1),
        )

        (row,) = [r for r in out["rows"] if r["check"] == "refused_documents"]
        assert row["status"] == "missing" and row["statusLabel"] == "חסר"
        assert row["subject"].startswith("מסמך שנדחה בענן · מסמך 80")
        assert "totalAmount" in row["reason"] and row["attempts"] == 1
        assert out["checks"] == [{"key": "refused_documents", "label": "מסמכים שנדחו בענן"}]
        assert out["summary"]["refused_documents"]["missing"] == 1

    def test_a_refused_document_that_landed_is_history(self, w, shift):
        doc = _doc(shift.id, totalAmount="lots")
        _push(w, [doc])
        _push(w, [{**doc, "totalAmount": "10.00"}])
        # The record keeps the wall clock; put it in the world's window.
        row = w.db.query(DocumentRefusal).one()
        row.first_seen_at = row.last_seen_at = NOW
        w.db.flush()

        out = REC.build_reconciliation(
            w.db, w.admin, w.tenant.id, _window(w), machine_ids=[w.tills[0].id], checks=("refused_documents",),
            now=NOW + timedelta(hours=1),
        )

        (row,) = out["rows"]
        assert row["status"] == "match" and "נקלט בענן" in row["reason"]
        assert row["transactionId"] == doc["id"]

    def test_a_gap_names_the_open_refusal_and_forgets_a_landed_one(self, w):
        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        for n in ("79", "81"):
            w.doc(t1, s1, "1.00", number=n)
        _push(w, [_doc(totalAmount="lots", transactionNumber="80")])

        out = REC.build_reconciliation(
            w.db, w.admin, w.tenant.id, _window(w), machine_ids=[t1.id], checks=("document_numbers",),
            now=NOW + timedelta(hours=1),
        )

        row = [r for r in out["rows"] if r["check"] == "document_numbers" and r.get("series") == 320][0]
        assert "הענן דחה מסמכים מהקופה" in row["reason"] and "totalAmount ×1" in row["reason"]

    def test_the_transmissions_report_lists_it(self, w):
        from app.routers import report_center as RC

        _push(w, [_doc(totalAmount="lots", transactionNumber="80")])

        out = RC.get_transmissions(
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1), tz="Asia/Jerusalem",
            shop_id=None, shop_ids=None, machine_id=w.tills[0].id, machine_ids=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

        (row,) = out["refusedDocuments"]
        assert row["documentNumber"] == "80" and row["landedAt"] is None
        assert row["machineName"] == w.tills[0].name and row["attempts"] == 1
