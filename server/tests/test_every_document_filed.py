"""
Every document filed under the till that issued it, in a shift, in exactly one Z of the kind
its till was in when it was issued (the owner, 2026-10-07: "כל מסמך שבוצע במכשירים חייב
לעלות לענן ולהיות חלק מהזד והאיקס/משמרת וכל מה שמשתמע" · "אם למשמרת של הקופה, לזד עצמאי").

docs/SHIFTS_API.md §1.2c-bis, §1.2d, §2.6-bis; app/services/document_filing.py,
z_completeness.py, z_adjustments.py. End to end with the till's push shapes
(`POST /sync/{id}/transactions`), on the in-memory SQLite world of tests/shift_world.py.

1. A till re-paired as a new machine: what it issued as the old one is filed under the old one.
2. No shift / another till's shift: the covering shift, else "documents waiting for a shift".
3. An unknown shift while another is open never blocks the batch (tests/test_shift_identity.py).
4. Late documents: a correction of a document a Z counted is an adjustment in the next Z; a
   local shop Z detects documents it did not name and no longer counts named ones late.
5. No Z with missing documents.
6. Same number, different id: both kept, flagged, a duplicate copy counted once.
7. The open-format export keeps its payment records consistent for a noted document.
+  The container: shop Z or the till's own Z, by the mode at issue time.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.tenant import Tenant
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.models.z_run import ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import document_filing as F
from app.services import reconciliation as REC
from app.services import z_runs as ZR
from app.services.reports import resolve_report_window
from app.services.shift_totals import compute_totals
from app.services.shifts import apply_shift_close
from shift_world import NOW, TODAY, accept_str_uuids, freeze_z_run_clock, make_world

SERIAL = "F2003183A700375"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    from app.services import ably_notify

    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: None)
    for till in world.tills + [world.other_till]:
        till.z_mode = "cloud"
        till.created_at = NOW - timedelta(days=30)
    world.db.commit()
    return world


# ── The till's push shapes ───────────────────────────────────────────────────


def _doc(shift_id=None, total="10.00", *, number=None, at=NOW, **extra):
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": number or str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": total, "paymentMethod": "cash",
        "businessDate": str(TODAY), "createdAt": at.isoformat(), "updatedAt": at.isoformat(),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return body


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _close(w, till, shift, docs=(), *, till_figures=None, at=None):
    body = ShiftCloseIn.model_validate({
        "closedAt": (at or (NOW + timedelta(hours=1))).isoformat(),
        "transactionIds": [str(d["id"] if isinstance(d, dict) else d.id) for d in docs],
        "till": till_figures,
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def _codes(tx):
    return [n["code"] for n in (tx.ingest_notes or [])]


def _stored(w, doc):
    w.db.expire_all()
    return w.db.get(Transaction, uuid.UUID(doc["id"]))


def _run(w, *tills):
    return ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=t.id) for t in tills], now=NOW)


def _recon(w, checks=REC.CHECKS, days=(-3, 1)):
    window = resolve_report_window(
        w.db, w.tenant.id, from_date=(NOW + timedelta(days=days[0])).date(), to_date=(NOW + timedelta(days=days[1])).date(),
    )
    return REC.build_reconciliation(w.db, w.admin, w.tenant.id, window, checks=checks, now=NOW + timedelta(hours=2))


# ── 1. A till re-paired as a new machine ─────────────────────────────────────


def _repaired(w):
    """
    The F20 case: till `old` (tenant A, its shift open) is re-paired with an ordinary code as
    a NEW machine of another tenant, while documents it issued are still in its outbox.
    """
    old = w.tills[1]
    old.serial_number = SERIAL
    old.pending_documents = 2
    old.pending_count_at = NOW - timedelta(hours=1)
    old_shift = w.shift(old, 10, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=8))
    other = Tenant(id=uuid.uuid4(), name="רויאל ספיריט", slug="royal", timezone="Asia/Jerusalem")
    w.db.add(other)
    w.db.flush()
    other_shop = Shop(id=uuid.uuid4(), tenant_id=other.id, company_id=w.company.id, name="רויאל", settings={})
    w.db.add(other_shop)
    w.db.flush()
    from app.services.pairing import create_pos_machine

    new = create_pos_machine(
        w.db, distributor_id=w.admin.id, tenant_id=other.id, device_info={"serial": SERIAL, "model": "F20"},
        machine_name="קופה 2",
    )
    new.created_at = NOW
    new.shop_id = other_shop.id
    new.pairing_status = PairingStatus.ASSIGNED
    new.pos_number = "2"
    new.z_mode = "cloud"
    w.db.commit()
    return old, old_shift, new


class TestRule1TheIssuingTill:
    def test_the_re_pair_is_linked_and_what_the_old_till_owed_is_kept(self, w):
        old, old_shift, new = _repaired(w)
        assert new.predecessor_machine_id == old.id
        handover = new.repair_handover
        assert handover["openShiftId"] == str(old_shift.id)
        assert handover["pendingDocuments"] == 2 and handover["clean"] is False

    def test_a_document_issued_before_the_re_pair_is_filed_under_the_till_that_issued_it(self, w):
        old, old_shift, new = _repaired(w)
        issued = NOW - timedelta(hours=3)
        # The current till build sends a retired (foreign) shift's documents with no shiftId.
        doc = _doc(None, "40.00", number="80", at=issued)

        (result,) = _push(w, new, [doc]).results

        assert result.status == "accepted"
        stored = _stored(w, doc)
        assert (stored.machine_id, stored.tenant_id, stored.shop_id) == (old.id, old.tenant_id, old.shop_id)
        assert stored.shift_id == old_shift.id  # its shift covering the issue time
        assert stored.pushed_by_machine_id == new.id
        assert "filed_under_issuing_till" in _codes(stored)
        assert "issued_before_pairing" not in _codes(stored)
        assert compute_totals(w.db, [old_shift.id]).total_sales == Decimal("40.00")

    def test_one_naming_the_old_tills_shift_goes_into_that_shift(self, w):
        old, old_shift, new = _repaired(w)
        doc = _doc(old_shift.id, "15.00", at=NOW - timedelta(hours=2))
        _push(w, new, [doc])
        stored = _stored(w, doc)
        assert stored.machine_id == old.id and stored.shift_id == old_shift.id
        assert stored.claimed_shift_id == old_shift.id

    def test_a_document_issued_after_the_re_pair_is_the_new_tills(self, w):
        old, _old_shift, new = _repaired(w)
        mine = w.shift(new, 1, status=ShiftStatus.OPEN, opened_at=NOW + timedelta(minutes=5))
        doc = _doc(mine.id, at=NOW + timedelta(minutes=30))
        _push(w, new, [doc])
        assert _stored(w, doc).machine_id == new.id

    def test_a_document_stored_under_the_new_till_before_the_link_is_re_filed_on_its_next_push(self, w):
        old, old_shift, new = _repaired(w)
        new.predecessor_machine_id = None
        w.db.commit()
        doc = _doc(None, "12.00", number="77", at=NOW - timedelta(hours=4))
        _push(w, new, [doc])
        assert _stored(w, doc).machine_id == new.id  # no link: kept where it was sent

        new.predecessor_machine_id = old.id
        w.db.commit()
        again = {**doc, "updatedAt": (NOW + timedelta(minutes=1)).isoformat()}
        (result,) = _push(w, new, [again]).results

        assert result.status in ("accepted", "duplicate")
        stored = _stored(w, doc)
        assert (stored.machine_id, stored.shift_id) == (old.id, old_shift.id)

    def test_refile_document_moves_a_stored_document_with_its_approver_relinked(self, w):
        from app.models.pos_user import PosUser, PosUserRole

        old, old_shift, new = _repaired(w)
        manager = PosUser(
            id=uuid.uuid4(), tenant_id=old.tenant_id, shop_id=old.shop_id, username="default",
            first_name="Default", last_name="Cashier", pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
        )
        w.db.add(manager)
        stray = w.doc(new, None, "9.00", number="81")
        stray.created_at = NOW - timedelta(hours=2)
        stray.claimed_approver_pos_user_id = manager.id
        w.db.commit()

        F.refile_document(w.db, stray, old, new)
        w.db.commit()

        assert (stray.machine_id, stray.tenant_id, stray.shift_id) == (old.id, old.tenant_id, old_shift.id)
        assert stray.approved_by_pos_user_id == manager.id
        assert "filed_under_issuing_till" in _codes(stray)

    def test_without_a_device_link_another_tills_shift_never_takes_the_document(self, w):
        """Security: a shift id alone (no shared serial) never files a document under another till."""
        stranger = w.tills[1]
        theirs = w.shift(stranger, 4, status=ShiftStatus.OPEN)
        doc = _doc(theirs.id, at=NOW - timedelta(hours=1))
        _push(w, w.tills[0], [doc])
        stored = _stored(w, doc)
        assert stored.machine_id == w.tills[0].id
        assert compute_totals(w.db, [theirs.id]).transactions_count == 0

    def test_the_reconciliation_says_what_the_old_till_owes_and_what_to_do(self, w):
        old, old_shift, new = _repaired(w)
        _push(w, new, [_doc(None, "40.00", at=NOW - timedelta(hours=3)), _doc(None, "5.00", at=NOW - timedelta(hours=2))])
        w.db.commit()

        rows = [r for r in _recon(w, checks=("repaired_tills", "documents_z"))["rows"] if r["machineId"] == str(old.id)]

        open_row = next(r for r in rows if r["gapType"] == "repaired_open_shift")
        assert open_row["status"] == "missing" and open_row["count"] == 2
        assert open_row["action"]["href"] == f"/dashboard/machines/{old.id}"
        assert "סגירה מנהלית" in open_row["action"]["label"]
        pending = next(r for r in rows if r["gapType"] == "repaired_pending_documents")
        assert pending["status"] == "match"  # both reported unsent have arrived
        docs_row = next(r for r in rows if r["check"] == "documents_z" and r["gapType"] == "open_shift_repaired")
        assert docs_row["status"] == "missing" and docs_row["container"] == F.CONTAINER_LABELS["cloud"]


# ── 2. No shift: the covering shift, else the waiting bucket ─────────────────


class TestRule2AlwaysInAShift:
    def test_waiting_documents_are_in_the_next_z_in_their_own_section(self, w):
        till = w.tills[0]
        stray = _doc(None, "7.00", number="1")
        _push(w, till, [stray])
        bucket = w.db.get(Shift, _stored(w, stray).shift_id)
        assert F.is_waiting(bucket) and bucket.reconstruction_basis["zMode"] == "cloud"

        s = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=NOW + timedelta(minutes=1))
        sale = _doc(s.id, "20.00", number="2", at=NOW + timedelta(minutes=2))
        _push(w, till, [sale])
        _close(w, till, s, [sale], at=NOW + timedelta(minutes=30))
        w.db.commit()

        run = _run(w, till)
        assert run.status == ZRunStatus.COMPLETED, (run.items[0].error_code, run.items[0].error_message)
        z = w.db.get(ZReport, run.z_report_id)
        assert z.total_sales == Decimal("27.00")
        (section,) = z.header["documentsAwaitingShift"]
        assert section["documents"] == 1 and section["zMode"] == "cloud"

    def test_a_waiting_document_moves_into_its_shift_when_the_close_creates_it(self, w):
        till = w.tills[0]
        n = w.shift(till, 1, status=ShiftStatus.OPEN)
        later = uuid.uuid4()
        doc = _doc(later, "6.00")
        _push(w, till, [doc])
        assert F.is_waiting(w.db.get(Shift, _stored(w, doc).shift_id))

        _close(w, till, n)
        body = ShiftCloseIn.model_validate({
            "closedAt": (NOW + timedelta(hours=2)).isoformat(), "transactionIds": [doc["id"]],
            "businessDate": str(TODAY), "openedAt": (NOW + timedelta(hours=1)).isoformat(), "sequenceNumber": 2,
        })
        shift, outcome = apply_shift_close(w.db, till, later, body)  # its open never arrived
        assert outcome == "accepted"
        assert _stored(w, doc).shift_id == later
        assert shift.transactions_count == 1


# ── 4. Late documents ────────────────────────────────────────────────────────


class TestACorrectionOfACountedDocumentIsAnAdjustmentInTheNextZ:
    def test_the_difference_is_carried_once_and_the_source_z_says_where(self, w):
        till = w.tills[0]
        s1 = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _doc(s1.id, "10.00", number="1")
        _push(w, till, [doc])
        _close(w, till, s1, [doc])
        w.db.commit()
        z1 = w.db.get(ZReport, _run(w, till).z_report_id)
        assert z1.total_sales == Decimal("10.00")

        corrected = {**doc, "totalAmount": "15.00", "updatedAt": (NOW + timedelta(hours=3)).isoformat()}
        _push(w, till, [corrected])
        w.db.commit()
        w.db.refresh(till)
        (pending,) = till.pending_z_adjustments
        assert pending["sourceZReportId"] == str(z1.id)
        assert Decimal(pending["delta"]["total_sales"]) == Decimal("5.00")

        s2 = w.shift(till, 2, status=ShiftStatus.OPEN, opened_at=NOW + timedelta(hours=4))
        sale = _doc(s2.id, "3.00", number="2", at=NOW + timedelta(hours=4))
        _push(w, till, [sale])
        _close(w, till, s2, [sale], at=NOW + timedelta(hours=5))
        w.db.commit()
        z2 = w.db.get(ZReport, _run(w, till).z_report_id)

        assert z2.total_sales == Decimal("8.00")  # its own 3 + the correction's 5
        assert z2.header["adjustments"]["items"][0]["documentId"] == doc["id"]
        assert z2.per_machine[0]["adjustments"]["count"] == 1
        w.db.refresh(z1)
        assert z1.header["adjustmentsCarried"][0]["intoZReportId"] == str(z2.id)
        w.db.refresh(till)
        assert not till.pending_z_adjustments
        # The reconciliation: Z2 agrees with its documents plus what it carried.
        rows = [r for r in _recon(w, checks=("z_totals",))["rows"] if r["zReportId"] == str(z2.id)]
        assert rows and all(r["status"] == "match" for r in rows)


# ── 5. No Z with missing documents ───────────────────────────────────────────


class TestNoZWithMissingDocuments:
    def _shift_with_numbers(self, w, till, *numbers, seq=1):
        s = w.shift(till, seq, status=ShiftStatus.OPEN)
        docs = [_doc(s.id, "10.00", number=str(n)) for n in numbers]
        _push(w, till, docs)
        _close(w, till, s, docs)
        w.db.commit()
        return s, docs

    def test_a_number_gap_keeps_the_z_waiting_until_the_document_arrives(self, w):
        till = w.tills[0]
        s, _docs = self._shift_with_numbers(w, till, 1, 2, 4)

        run = _run(w, till)
        assert run.status == ZRunStatus.WAITING
        (item,) = run.items
        assert item.error_code == "waiting_documents" and "3" in item.error_message

        # Another Z of the shop meanwhile: refused — the waiting Z keeps its turn and number.
        with pytest.raises(Exception) as e:
            _run(w, w.tills[1])
        assert "z_waiting_for_documents" in str(getattr(e.value, "detail", e.value))

        # The missing document lands (late, into the closed shift): the Z builds by itself.
        _push(w, till, [_doc(s.id, "10.00", number="3", at=NOW + timedelta(minutes=5))])
        w.db.commit()
        w.db.refresh(run)
        assert run.status == ZRunStatus.COMPLETED
        assert w.db.get(ZReport, run.z_report_id).transactions_count == 4

    def test_confirming_the_cloud_data_does_not_pass_missing_documents(self, w):
        from app.routers import z_runs as zr_router
        from app.schemas.z_run import ZRunCreateIn

        till = w.tills[0]
        self._shift_with_numbers(w, till, 1, 2, 4)
        till.last_heartbeat_at = NOW - timedelta(days=1)
        till.pending_documents = 1
        w.db.commit()

        out = zr_router.post_z_run(
            ZRunCreateIn.model_validate({
                "shopId": str(w.shop.id), "machines": [{"machineId": str(till.id)}], "confirmCloudData": True,
            }),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["status"] == ZRunStatus.WAITING
        assert out["items"][0]["errorCode"] == "waiting_documents"

    def test_a_close_with_an_empty_list_is_still_checked(self, w):
        till = w.tills[0]
        s = w.shift(till, 1, status=ShiftStatus.OPEN)
        _close(w, till, s, [], till_figures={"transactionsCount": 2, "totalSales": "20.00"})
        w.doc(till, w.shift(till, 0, status=ShiftStatus.CLOSED), "1.00", number="9")  # some activity
        w.db.commit()

        run = _run(w, till)
        assert run.status == ZRunStatus.WAITING
        assert "2" in run.items[0].error_message

    def test_the_operator_may_build_without_the_till_and_its_shifts_wait(self, w):
        till, other = w.tills
        self._shift_with_numbers(w, till, 1, 3)
        self._shift_with_numbers(w, other, 7, 8)
        run = _run(w, till, other)
        assert run.status == ZRunStatus.WAITING

        ZR.proceed_without(w.db, run, [till.id], now=NOW)
        w.db.commit()
        assert run.status == ZRunStatus.COMPLETED
        assert w.db.get(ZReport, run.z_report_id).transactions_count == 2


# ── 6. Same number, different id ─────────────────────────────────────────────


class TestSameNumberDifferentId:
    def test_both_are_kept_a_different_one_counts_a_copy_counts_once(self, w):
        till = w.tills[0]
        s = w.shift(till, 1, status=ShiftStatus.OPEN)
        first = _doc(s.id, "10.00", number="57")
        other_sale = _doc(s.id, "25.00", number="57", at=NOW + timedelta(minutes=9))
        copy = {**_doc(s.id, "10.00", number="57"), "createdAt": first["createdAt"], "updatedAt": first["updatedAt"]}

        results = _push(w, till, [first, other_sale, copy]).results

        assert [r.status for r in results] == ["accepted", "accepted", "accepted"]
        a, b, c = (_stored(w, d) for d in (first, other_sale, copy))
        assert a.number_conflict_of is None
        assert (b.number_conflict_of, b.duplicate_copy) == (a.id, False)
        assert (c.number_conflict_of, c.duplicate_copy) == (a.id, True)
        assert "numbering_conflict" in _codes(b) and "numbering_conflict" in _codes(c)
        totals = compute_totals(w.db, [s.id])
        assert totals.transactions_count == 2 and totals.total_sales == Decimal("35.00")

        rows = [r for r in _recon(w, checks=("numbering_conflicts",))["rows"]]
        assert {r["gapType"] for r in rows} == {"numbering_conflict", "numbering_duplicate_copy"}
        assert all(r["status"] == "missing" for r in rows)

    def test_the_export_leaves_a_duplicate_copy_out(self, w):
        from app.services.tax_reports import count_duplicate_copies, load_transactions_for_tax_export

        till = w.tills[0]
        s = w.shift(till, 1, status=ShiftStatus.OPEN)
        first = _doc(s.id, "10.00", number="58")
        copy = {**_doc(s.id, "10.00", number="58"), "createdAt": first["createdAt"], "updatedAt": first["updatedAt"]}
        _push(w, till, [first, copy])
        w.db.commit()

        rows = load_transactions_for_tax_export(
            w.db, w.tenant.id, shop_id=w.shop.id, start=NOW - timedelta(days=1), end=NOW + timedelta(days=1),
        )
        assert [str(r.id) for r in rows] == [first["id"]]
        assert count_duplicate_copies(
            w.db, w.tenant.id, company_id=None, shop_id=w.shop.id, start=NOW - timedelta(days=1), end=NOW + timedelta(days=1),
        ) == 1


# ── 7. The open-format export reads the ingest notes ─────────────────────────


class TestOpenFormatPaymentRecords:
    def _tx(self, legs, total=100.0, noted=True):
        return {
            "id": str(uuid.uuid4()), "transactionNumber": "20000057", "documentType": 320, "status": "completed",
            "paymentMethod": "mixed", "cart": {"totalAmount": total},
            "payments": [{"method": m, "amount": a} for m, a in legs],
            "ingestNotes": ["tenders_do_not_reconcile"] if noted else [],
        }

    def test_a_noted_document_never_writes_a_payment_record_against_its_direction(self):
        from app.services.open_format.tax_report_generator import resolve_payment_legs

        legs = resolve_payment_legs(self._tx([("cash", 150.0), ("card", -50.0)]))
        assert legs == [("cash", None)]  # the one leg of its direction, for the whole document
        split = resolve_payment_legs(self._tx([("cash", 60.0), ("card", 30.0), ("cash", -5.0)]))
        assert all(a > 0 for _m, a in split) and round(sum(a for _m, a in split), 2) == 100.0

    def test_an_unnoted_document_is_filed_exactly_as_before(self):
        from app.services.open_format.tax_report_generator import resolve_payment_legs

        assert resolve_payment_legs(self._tx([("cash", 60.0), ("card", 40.0)], noted=False)) == [
            ("cash", 60.0), ("card", 40.0),
        ]

    def test_the_export_lists_the_documents_it_apportioned(self):
        from app.services.tax_reports import flagged_documents

        noted = self._tx([("cash", 60.0), ("card", 30.0)])
        clean = self._tx([("cash", 60.0), ("card", 40.0)], noted=False)
        (flag,) = flagged_documents([noted, clean])
        assert flag["transactionId"] == noted["id"] and flag["code"] == "tenders_do_not_reconcile"


# ── The container: the Z kind at issue time ──────────────────────────────────


class TestTheContainerIsTheZKindAtIssueTime:
    def _own_z(self, w, till):
        from app.schemas.till_z import TillZIn

        resp = sync_router.post_till_z(
            machine_id=str(till.id), body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
            machine=till, db=w.db,
        )
        return resp.status_code, json.loads(resp.body)

    def test_a_per_till_z_till_s_waiting_documents_go_to_its_own_z(self, w):
        till = w.tills[0]
        till.z_mode = "till"
        w.db.commit()
        _push(w, till, [_doc(None, "4.00", number="1")])
        bucket = next(s for s in w.db.query(Shift).filter(Shift.machine_id == till.id).all() if F.is_waiting(s))
        assert bucket.reconstruction_basis["zMode"] == "till"
        s = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=NOW + timedelta(minutes=1))
        sale = _doc(s.id, "6.00", number="2", at=NOW + timedelta(minutes=2))
        _push(w, till, [sale])
        _close(w, till, s, [sale], at=NOW + timedelta(minutes=30))
        w.db.commit()

        code, body = self._own_z(w, till)
        assert code == 201, body
        z = w.db.get(ZReport, uuid.UUID(body["zReport"]["id"]))
        assert z.origin == "till" and z.total_sales == Decimal("10.00")
        assert w.db.get(Shift, bucket.id).z_report_id == z.id

    def test_an_independent_till_override_is_its_own_z_too(self, w):
        from app.services import independent_till as IT

        till = w.tills[0]
        assert IT.set_independent(w.db, till, True, now=NOW)
        w.db.commit()
        assert F.mode_at(till, NOW - timedelta(hours=1)) == "cloud"  # before the switch: the shop Z
        assert F.mode_at(till, NOW + timedelta(hours=1)) == "till"
        assert till.z_mode_history[-1]["to"] == "till"
        # A document issued after the switch with no shift waits for the till's own Z.
        _push(w, till, [_doc(None, "4.00", number="1", at=NOW + timedelta(hours=1))])
        bucket = next(s for s in w.db.query(Shift).filter(Shift.machine_id == till.id).all() if F.is_waiting(s))
        assert bucket.reconstruction_basis["zMode"] == "till"
        assert F.taken_by(bucket, "till")

    def test_a_switch_later_never_moves_what_was_issued_before_it(self, w):
        from app.services.till_z import set_z_mode

        till, other = w.tills
        # Issued under the shop Z …
        issued = NOW - timedelta(hours=2)
        # … the till then makes its own Z.
        set_z_mode(w.db, till, "till", now=NOW - timedelta(hours=1))
        w.db.commit()
        assert F.mode_at(till, issued) == "cloud" and F.mode_at(till, NOW) == "till"
        doc = _doc(None, "5.00", number="1", at=issued)
        _push(w, till, [doc])
        bucket = w.db.get(Shift, _stored(w, doc).shift_id)
        assert bucket.reconstruction_basis["zMode"] == "cloud"

        # The till's own Z does not take it …
        s = w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=NOW + timedelta(minutes=1))
        sale = _doc(s.id, "8.00", number="2", at=NOW + timedelta(minutes=2))
        _push(w, till, [sale])
        _close(w, till, s, [sale], at=NOW + timedelta(minutes=30))
        w.db.commit()
        code, body = self._own_z(w, till)
        assert code == 201, body
        assert w.db.get(ZReport, uuid.UUID(body["zReport"]["id"])).total_sales == Decimal("8.00")
        assert w.db.get(Shift, bucket.id).z_report_id is None

        # … the shop's next Z does, in a section of the till.
        so = w.shift(other, 1, status=ShiftStatus.OPEN)
        osale = _doc(so.id, "2.00", number="70")
        _push(w, other, [osale])
        _close(w, other, so, [osale])
        w.db.commit()
        run = _run(w, other)
        z = w.db.get(ZReport, run.z_report_id)
        assert z.origin == "cloud" and w.db.get(Shift, bucket.id).z_report_id == z.id
        assert z.total_sales == Decimal("7.00")
        assert {s["machineId"] for s in z.per_machine} == {str(till.id), str(other.id)}

        # The reconciliation names each document's container, and both are where they belong.
        rows = [r for r in _recon(w, checks=("documents_z",))["rows"] if r.get("container")]
        assert {r["zMode"] for r in rows if r["machineId"] == str(till.id)} == {"cloud", "till"}
        assert all(r["status"] == "match" for r in rows)
