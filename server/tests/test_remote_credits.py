"""
"זיכוי מרחוק" — a credit asked for from the dashboard, issued by a till (docs/SPEC_REMOTE_CREDIT.md).

What each class pins:

* **Arithmetic** — the till's refund rule, ported: a line's money less its own discounts
  and its share of the basket discount (largest remainder); cumulative rounding; the
  mirrored tender split.
* **Eligibility** — only tills (not kiosks, not display devices) with an open shift, of the
  same company or VAT number, not in training, that the user may act on; the original's
  own till first.
* **Validation** — a sale only (not a credit, not refunded, not cancelled); within what is
  left after earlier credit notes AND pending requests; a reason is required.
* **Idempotency** — the same command id with the same content is one request; with other
  content a 409. The till's acks are idempotent; a completion always lands.
* **Lifecycle** — queued → sent (heartbeat / pull) → received → completed / failed;
  cancel while pending; expiry (36 h for mode 1, the till parameter for mode 2); a credit
  document naming its request completes it; the audit trail.
* **Permissions** — owner / manager roles only; a manager's own shop; documents in scope.
* **Totals** — a no-money credit leg is its own bucket in the X/Z split unless it cancels a
  sale of its own shift; the drawer never expects it.
* **Wiring** — routes mounted, parameters registered, migration on the single head.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response

from app.middleware.auth import get_current_machine_admin
from app.models.company import Company
from app.models.remote_credit import RemoteCreditEvent, RemoteCreditRequest
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.routers import remote_credits as R
from app.schemas.remote_credit import RemoteCreditAckIn, RemoteCreditCancelIn, RemoteCreditCreateIn
from app.services import remote_credits as svc
from app.services.shift_totals import compute_totals
from app.services.till_parameters import ensure_builtin_parameters
from shift_world import NOW
from test_shop_areas import _ctx, refused, w  # noqa: F401


# ── helpers ──────────────────────────────────────────────────────────────────


def sale(w, till, shift, lines, *, discount="0", legs=None, status=TransactionStatus.COMPLETED):
    """A 320 with `lines` = [(name, qty, unit price)] and its tender legs."""
    total = sum(Decimal(str(q)) * Decimal(p) for _, q, p in lines)
    tx = w.doc(till, shift, str(total.quantize(Decimal("0.01"))), discount=discount, legs=legs, status=status)
    for name, qty, price in lines:
        w.db.add(
            TransactionItem(
                id=uuid.uuid4(),
                transaction_id=tx.id,
                product_name=name,
                quantity=Decimal(str(qty)),
                unit_price=Decimal(price),
                total_price=(Decimal(str(qty)) * Decimal(price)).quantize(Decimal("0.01")),
            )
        )
    w.db.flush()
    return tx


def items_of(w, tx):
    return sorted(
        w.db.query(TransactionItem).filter(TransactionItem.transaction_id == tx.id).all(),
        key=lambda i: i.product_name,
    )


def credit_note(w, till, shift, original, lines, method="cash"):
    """A 330 crediting `lines` = [(item, qty, amount)] of `original`."""
    total = sum(Decimal(a) for _, _, a in lines)
    tx = w.doc(till, shift, str(total), credit_note=True, method=method)
    tx.refund_of_transaction_id = original.id
    for item, qty, amount in lines:
        w.db.add(
            TransactionItem(
                id=uuid.uuid4(),
                transaction_id=tx.id,
                product_name=item.product_name,
                quantity=Decimal(str(qty)),
                unit_price=item.unit_price,
                total_price=Decimal(amount),
                refund_of_item_id=item.id,
            )
        )
    w.db.flush()
    return tx


def open_shift(w, till, seq=1):
    return w.shift(till, seq, status=ShiftStatus.OPEN)


def body(original, till, **over) -> RemoteCreditCreateIn:
    data = {
        "transactionId": str(original.id),
        "machineId": str(till.id),
        "mode": "no_money",
        "full": True,
        "lines": [],
        "reasonCode": "declined_at_terminal",
    }
    data.update(over)
    return RemoteCreditCreateIn.model_validate(data)


def create(w, original, till, user=None, **over):
    response = Response()
    out = R.create_remote_credit(body(original, till, **over), response, **_ctx(w, user))
    return response.status_code, out


@pytest.fixture
def world(w, monkeypatch):
    """Till 1 and North 1 have open shifts; Till 2 has none. A sale on Till 1."""
    from app.services import ably_notify

    w.published = []
    monkeypatch.setattr(ably_notify, "is_enabled", lambda: True)
    monkeypatch.setattr(
        ably_notify, "publish_remote_credit_notify", lambda *a, **k: w.published.append((a, k))
    )
    w.shift1 = open_shift(w, w.tills[0])
    w.north_shift = open_shift(w, w.other_till)
    w.original = sale(
        w, w.tills[0], w.shift1, [("Beer", 2, "30.00"), ("Chips", 1, "15.00")],
        legs=[("cash", "25.00"), ("card", "50.00")],
    )
    w.db.commit()
    return w


def request_row(w, out) -> RemoteCreditRequest:
    return w.db.get(RemoteCreditRequest, uuid.UUID(out["id"]))


# ── Arithmetic ───────────────────────────────────────────────────────────────


class TestArithmetic:
    def test_a_basket_discount_is_shared_by_value_with_the_leftover_to_the_largest_remainder(self, world):
        w = world
        tx = sale(w, w.tills[0], w.shift1, [("A", 1, "10.00"), ("B", 1, "10.00"), ("C", 1, "10.00")], discount="1.00")
        a, b, c = items_of(w, tx)
        got = svc.collected_per_line([a, b, c], tx.document_discount)
        # 100 agorot over three equal lines: 34 / 33 / 33 — the lines add up to what was collected.
        assert sorted(got.values()) == [966, 967, 967]
        assert sum(got.values()) == 2900

    def test_crediting_a_line_in_pieces_credits_exactly_what_was_paid(self):
        paid = 1000  # ₪10 for three units
        pieces = [svc.credit_for(paid, Decimal(3), Decimal(k), Decimal(1)) for k in range(3)]
        assert pieces == [333, 334, 333] and sum(pieces) == paid

    def test_the_mirrored_tender_is_split_in_proportion_and_adds_up(self):
        assert svc.split_over([("cash", 2500), ("card", 5000)], 3000) == [
            {"method": "cash", "amount": "10.00"},
            {"method": "card", "amount": "20.00"},
        ]
        legs = svc.split_over([("cash", 1), ("card", 1), ("voucher", 1)], 100)
        assert sum(Decimal(l["amount"]) for l in legs) == Decimal("1.00")
        assert svc.split_over([], 100) == [] and svc.split_over([("cash", 0)], 100) == []


# ── Eligibility ──────────────────────────────────────────────────────────────


class TestTargets:
    def prepare(self, w, user=None, original=None):
        return R.prepare_remote_credit(transaction_id=(original or w.original).id, **_ctx(w, user))

    def test_only_tills_with_an_open_shift_and_the_originals_own_till_first(self, world):
        out = self.prepare(world)
        ids = [t["machineId"] for t in out["targets"]]
        assert ids == [str(world.tills[0].id), str(world.other_till.id)]  # Till 2 has no shift
        assert out["targets"][0]["isOriginalTill"] is True
        assert out["targets"][0]["openShift"]["id"] == str(world.shift1.id)
        assert out["creditable"] is True
        assert out["remainingAmount"] == "75.00"
        assert [l["remaining"] for l in out["lines"]] == [2.0, 1.0]

    def test_a_shift_the_heartbeat_claims_makes_a_till_eligible(self, world):
        world.tills[1].reported_open_shift_id = uuid.uuid4()
        world.db.commit()
        assert str(world.tills[1].id) in [t["machineId"] for t in self.prepare(world)["targets"]]

    def test_kiosks_and_display_devices_are_never_offered(self, world):
        from app.models.kiosk import KioskDevice
        from app.models.pos_machine import _KIOSK_CACHE

        w = world
        w.db.add(KioskDevice(machine_id=w.other_till.id, tenant_id=w.tenant.id, shop_id=w.other_shop.id, name="K", enabled=True))
        w.other_till.__dict__.pop(_KIOSK_CACHE, None)
        w.db.commit()
        assert str(w.other_till.id) not in [t["machineId"] for t in self.prepare(w)["targets"]]
        assert svc.target_refusal(w.db, w.original, w.other_till).detail["code"] == "target_not_a_till"

        w.tills[0].is_fiscal = False
        w.db.commit()
        assert svc.target_refusal(w.db, w.original, w.tills[0]).detail["code"] == "target_not_a_till"

    def test_another_business_is_refused_but_the_same_vat_number_is_one_business(self, world):
        w = world
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other Ltd", vat_number="999")
        w.db.add(other)
        w.db.flush()
        w.other_shop.company_id = other.id
        w.db.commit()
        assert svc.target_refusal(w.db, w.original, w.other_till).detail["code"] == "target_other_business"
        assert str(w.other_till.id) not in [t["machineId"] for t in self.prepare(w)["targets"]]

        other.vat_number = w.company.vat_number  # a second company row of the same עוסק
        w.db.commit()
        assert svc.target_refusal(w.db, w.original, w.other_till) is None
        assert str(w.other_till.id) in [t["machineId"] for t in self.prepare(w)["targets"]]

    def test_a_shop_in_training_is_not_offered(self, world):
        world.other_shop.training_mode = True
        world.db.commit()
        assert svc.target_refusal(world.db, world.original, world.other_till).detail["code"] == "target_in_training"

    def test_a_manager_is_offered_only_the_tills_of_their_shop(self, world):
        ids = [t["machineId"] for t in self.prepare(world, world.manager)["targets"]]
        assert ids == [str(world.tills[0].id)]


# ── Validation ───────────────────────────────────────────────────────────────


class TestValidation:
    def test_full_credit_takes_everything_left_and_mirrors_the_tenders(self, world):
        code, out = create(world, world.original, world.tills[0])
        assert code == 201
        assert out["amount"] == "75.00" and out["fullCredit"] is True
        assert [(l["productName"], l["quantity"], l["amount"]) for l in out["lines"]] == [
            ("Beer", 2.0, "60.00"), ("Chips", 1.0, "15.00"),
        ]
        assert out["tenders"] == [{"method": "cash", "amount": "25.00"}, {"method": "card", "amount": "50.00"}]
        assert out["reason"] == "העסקה נדחתה במסוף"

    def test_earlier_credit_notes_and_pending_requests_are_taken_off(self, world):
        w = world
        beer, chips = items_of(w, w.original)
        credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")])
        w.db.commit()
        e = refused(create, w, w.original, w.tills[0], full=False, lines=[{"itemId": str(beer.id), "quantity": 2}])
        assert e.status_code == 409 and e.detail["code"] == "over_credit"

        code, first = create(w, w.original, w.tills[0], full=False, mode="prepared",
                             lines=[{"itemId": str(beer.id), "quantity": 1}])
        assert code == 201 and first["amount"] == "30.00"
        # The beer left is held by the pending request: only the chips remain.
        code, second = create(w, w.original, w.other_till)
        assert [l["productName"] for l in second["lines"]] == ["Chips"] and second["amount"] == "15.00"
        e = refused(create, w, w.original, w.tills[0])
        assert e.detail["code"] == "nothing_to_credit"

    def test_a_credit_note_a_refunded_or_a_cancelled_document_is_refused(self, world):
        w = world
        beer, _ = items_of(w, w.original)
        cn = credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")])
        cancelled = sale(w, w.tills[0], w.shift1, [("X", 1, "5.00")], status=TransactionStatus.CANCELLED)
        w.db.commit()
        assert refused(create, w, cn, w.tills[0]).detail["code"] == "not_a_sale"
        assert refused(create, w, cancelled, w.tills[0]).detail["code"] == "not_a_completed_sale"
        w.original.status = TransactionStatus.REFUNDED
        w.db.commit()
        assert refused(create, w, w.original, w.tills[0]).detail["code"] == "already_refunded"

    def test_a_reason_is_required_and_a_quick_reason_gives_its_words(self, world):
        e = refused(create, world, world.original, world.tills[0], reasonCode=None, reason="  ")
        assert e.status_code == 422 and e.detail["code"] == "reason_required"
        e = refused(create, world, world.original, world.tills[0], reasonCode="other", reason=None)
        assert e.detail["code"] == "reason_required"
        e = refused(create, world, world.original, world.tills[0], reasonCode="nope")
        assert e.detail["code"] == "unknown_reason"
        _, out = create(world, world.original, world.tills[0], reasonCode="other", reason="  הלקוח   ביטל  ")
        assert out["reason"] == "הלקוח ביטל"

    def test_a_line_of_another_document_is_refused(self, world):
        e = refused(create, world, world.original, world.tills[0], full=False,
                    lines=[{"itemId": str(uuid.uuid4()), "quantity": 1}])
        assert e.status_code == 422 and e.detail["code"] == "unknown_line"

    def test_a_till_without_an_open_shift_is_refused(self, world):
        e = refused(create, world, world.original, world.tills[1])
        assert e.detail["code"] == "target_no_open_shift"

    def test_a_document_paid_only_by_exchange_cannot_be_credited_without_money(self, world):
        w = world
        tx = sale(w, w.tills[0], w.shift1, [("A", 1, "10.00")], legs=[("exchange", "10.00")])
        w.db.commit()
        assert refused(create, w, tx, w.tills[0]).detail["code"] == "no_tender_to_mirror"
        code, _ = create(w, tx, w.tills[0], mode="prepared")
        assert code == 201


# ── Idempotency ──────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_the_same_command_id_is_one_request(self, world):
        rid = str(uuid.uuid4())
        code1, a = create(world, world.original, world.tills[0], id=rid)
        code2, b = create(world, world.original, world.tills[0], id=rid)
        assert (code1, code2) == (201, 200) and a["id"] == b["id"] == rid
        assert world.db.query(RemoteCreditRequest).count() == 1

    def test_the_same_id_with_other_content_is_a_conflict(self, world):
        rid = str(uuid.uuid4())
        create(world, world.original, world.tills[0], id=rid)
        e = refused(create, world, world.original, world.other_till, id=rid)
        assert e.detail["code"] == "remote_credit_id_conflict"

    def test_a_repeated_completion_changes_nothing_and_a_second_credit_is_flagged(self, world):
        w = world
        _, out = create(w, w.original, w.tills[0])
        rid = uuid.UUID(out["id"])
        credit = uuid.uuid4()
        for _ in range(2):
            svc.apply_ack(w.db, w.tills[0], rid, phase="completed", credit_transaction_id=credit,
                          credit_document_number="10000001", credit_document_type=330)
        req = w.db.get(RemoteCreditRequest, rid)
        assert req.status == "completed" and req.credit_transaction_id == credit
        completions = w.db.query(RemoteCreditEvent).filter_by(request_id=rid, action="completed").count()
        assert completions == 1
        svc.apply_ack(w.db, w.tills[0], rid, phase="completed", credit_transaction_id=uuid.uuid4())
        assert req.credit_transaction_id == credit
        assert w.db.query(RemoteCreditEvent).filter_by(request_id=rid, action="duplicate_credit").count() == 1


# ── Lifecycle ────────────────────────────────────────────────────────────────


class TestLifecycle:
    def test_offline_it_is_queued_and_the_heartbeat_hands_it_over(self, world):
        w = world
        _, out = create(w, w.original, w.tills[0])  # NOW is in the past: the till reads offline
        assert out["status"] == "queued" and w.published == []
        assert svc.take_pending(w.db, w.tills[0]) == [out["id"]]
        assert request_row(w, out).status == "sent"
        assert svc.take_pending(w.db, w.tills[1]) is None

    def test_online_the_realtime_event_goes_out_at_once(self, world):
        w = world
        w.tills[0].last_heartbeat_at = datetime.now(timezone.utc)
        w.db.commit()
        _, out = create(w, w.original, w.tills[0])
        assert out["status"] == "sent" and len(w.published) == 1
        assert w.published[0][0][2] == out["id"]

    def test_the_till_gets_the_original_whole_with_what_was_credited_before(self, world):
        w = world
        beer, chips = items_of(w, w.original)
        credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")])
        w.db.commit()
        _, out = create(w, w.original, w.other_till)
        pulled = R.till_remote_credits(str(w.other_till.id), machine=w.other_till, db=w.db)
        (req,) = pulled["requests"]
        assert req["requestId"] == out["id"] and req["mode"] == "no_money"
        assert req["amount"] == 45.0 and [t["method"] for t in req["tenders"]] == ["cash", "card"]
        original = req["original"]
        assert original["id"] == str(w.original.id) and original["documentType"] == 320
        assert {i["productName"]: i["credited"] for i in original["items"]} == {"Beer": 1.0, "Chips": 0.0}
        assert [p["method"] for p in original["payments"]] == ["cash", "card"]

    def test_received_then_completed(self, world):
        w = world
        _, out = create(w, w.original, w.tills[0])
        rid = uuid.UUID(out["id"])
        R.till_remote_credit_ack(str(w.tills[0].id), rid, RemoteCreditAckIn(phase="received"), machine=w.tills[0], db=w.db)
        assert request_row(w, out).status == "received"
        credit = uuid.uuid4()
        res = R.till_remote_credit_ack(
            str(w.tills[0].id), rid,
            RemoteCreditAckIn.model_validate({
                "phase": "completed", "creditTransactionId": str(credit), "creditDocumentNumber": "10000007",
                "creditDocumentType": 330, "creditAmount": "75.00",
            }),
            machine=w.tills[0], db=w.db,
        )
        assert res["requestStatus"] == "completed"
        got = R.get_remote_credit(rid, **_ctx(w))
        assert got["creditDocumentNumber"] == "10000007" and got["creditAmount"] == "75.00"
        assert [e["action"] for e in got["events"]] == ["created", "received", "completed"]
        assert got["events"][0]["by"] == "admin"

    def test_a_refusal_by_the_till_fails_it_with_its_reason(self, world):
        _, out = create(world, world.original, world.tills[0])
        svc.apply_ack(world.db, world.tills[0], uuid.UUID(out["id"]), phase="failed",
                      error_code="no_open_shift", error_message="אין משמרת פתוחה")
        row = request_row(world, out)
        assert (row.status, row.error_code, row.error_message) == ("failed", "no_open_shift", "אין משמרת פתוחה")
        # Ended: a late "received" changes nothing.
        svc.apply_ack(world.db, world.tills[0], row.id, phase="received")
        assert row.status == "failed"

    def test_another_tills_ack_is_a_404(self, world):
        _, out = create(world, world.original, world.tills[0])
        e = refused(svc.apply_ack, world.db, world.other_till, uuid.UUID(out["id"]), phase="received")
        assert e.status_code == 404

    def test_cancel_while_pending_frees_the_quantity_and_tells_the_till(self, world):
        w = world
        w.tills[0].last_heartbeat_at = datetime.now(timezone.utc)
        w.db.commit()
        _, out = create(w, w.original, w.tills[0])
        got = R.cancel_remote_credit(uuid.UUID(out["id"]), RemoteCreditCancelIn(reason="טעות"), **_ctx(w))
        assert got["status"] == "cancelled" and got["cancelReason"] == "טעות" and got["cancelledBy"] == "admin"
        assert w.published[-1][1] == {"cancelled": True}
        assert svc.take_pending(w.db, w.tills[0]) is None
        e = refused(R.cancel_remote_credit, uuid.UUID(out["id"]), None, **_ctx(w))
        assert e.detail["code"] == "request_not_pending"
        code, again = create(w, w.original, w.tills[0])
        assert code == 201 and again["amount"] == "75.00"

    def test_a_credit_issued_after_the_cancel_still_completes_it(self, world):
        _, out = create(world, world.original, world.tills[0])
        R.cancel_remote_credit(uuid.UUID(out["id"]), None, **_ctx(world))
        svc.apply_ack(world.db, world.tills[0], uuid.UUID(out["id"]), phase="completed", credit_transaction_id=uuid.uuid4())
        row = request_row(world, out)
        assert row.status == "completed" and row.error_code == "completed_after_cancelled"

    def test_mode_one_expires_after_36_hours_and_mode_two_after_the_till_parameter(self, world):
        w = world
        ensure_builtin_parameters(w.db)
        param = w.db.query(TillParameter).filter_by(key="remoteCreditExpiryHours").one()
        assert param.default_value == 24
        w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=param.id, scope_type="machine",
                                    scope_id=w.tills[0].id, value=6))
        w.db.commit()
        beer, chips = items_of(w, w.original)
        _, one = create(w, w.original, w.tills[0], full=False, lines=[{"itemId": str(beer.id), "quantity": 1}])
        _, two = create(w, w.original, w.tills[0], full=False, mode="prepared",
                        lines=[{"itemId": str(chips.id), "quantity": 1}])
        r1, r2 = request_row(w, one), request_row(w, two)
        assert round((r1.expires_at - r1.created_at).total_seconds() / 3600) == 36
        assert round((r2.expires_at - r2.created_at).total_seconds() / 3600) == 6
        assert svc.expire_overdue(w.db, now=r2.created_at + timedelta(hours=7)) == 1
        assert (r1.status, r2.status) == ("queued", "expired")
        assert svc.expire_overdue(w.db, now=r1.created_at + timedelta(hours=37)) == 1
        assert r1.status == "expired"

    def test_the_expiry_parameter_is_clamped(self, world):
        w = world
        ensure_builtin_parameters(w.db)
        param = w.db.query(TillParameter).filter_by(key="remoteCreditExpiryHours").one()
        w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=param.id, scope_type="machine",
                                    scope_id=w.tills[0].id, value=9999))
        w.db.commit()
        assert svc.prepared_ttl_hours(w.db, w.tills[0]) == 168
        assert svc.prepared_ttl_hours(w.db, w.other_till) == 24

    def test_the_credit_document_naming_its_request_completes_it(self, world):
        w = world
        _, out = create(w, w.original, w.tills[0])
        credit = credit_note(w, w.tills[0], w.shift1, w.original, [(items_of(w, w.original)[0], 2, "60.00")])
        credit.remote_credit_request_id = uuid.UUID(out["id"])
        w.db.flush()
        svc.on_documents(w.db, w.other_till, [credit.id])  # not the request's till: ignored
        assert request_row(w, out).status == "queued"
        svc.on_documents(w.db, w.tills[0], [credit.id])
        row = request_row(w, out)
        assert row.status == "completed" and row.credit_transaction_id == credit.id
        assert row.credit_document_number == credit.document_number

    def test_the_list_of_a_document(self, world):
        create(world, world.original, world.tills[0], full=False, mode="prepared",
               lines=[{"itemId": str(items_of(world, world.original)[1].id), "quantity": 1}])
        listed = R.list_remote_credits(transaction_id=world.original.id, machine_id=None, pending_only=True,
                                       limit=50, **_ctx(world))
        assert len(listed["items"]) == 1 and listed["items"][0]["mode"] == "prepared"


# ── Permissions ──────────────────────────────────────────────────────────────


class TestPermissions:
    def test_only_owner_and_manager_roles(self, world):
        for fn in (R.create_remote_credit, R.prepare_remote_credit, R.cancel_remote_credit, R.list_remote_credits,
                   R.get_remote_credit):
            assert inspect.signature(fn).parameters["current_user"].default.dependency is get_current_machine_admin
        assert refused(get_current_machine_admin, current_user=world.cashier).status_code == 403
        assert get_current_machine_admin(current_user=world.manager) is world.manager
        assert get_current_machine_admin(current_user=world.company_manager) is world.company_manager

    def test_a_manager_cannot_send_to_a_till_of_another_shop(self, world):
        e = refused(create, world, world.original, world.other_till, world.manager)
        assert e.status_code == 403
        code, _ = create(world, world.original, world.tills[0], world.manager)
        assert code == 201

    def test_a_document_out_of_scope_is_a_404(self, world):
        e = refused(create, world, world.original, world.other_till, world.north_manager)
        assert e.status_code == 404

    def test_the_company_manager_reaches_every_shop_of_the_company(self, world):
        code, out = create(world, world.original, world.other_till, world.company_manager)
        assert code == 201 and out["machineId"] == str(world.other_till.id)


# ── Totals ───────────────────────────────────────────────────────────────────


def _no_money_credit(w, till, shift, original, amount, method):
    cn = credit_note(w, till, shift, original, [(items_of(w, original)[0], 1, amount)], method=method)
    cn.no_money_movement = True
    for leg in w.db.query(TransactionPayment).filter_by(transaction_id=cn.id):
        leg.no_money_movement = True
    w.db.flush()
    return cn


class TestTotals:
    def test_a_no_money_credit_of_another_shift_is_its_own_bucket_and_never_the_drawer(self, world):
        w = world
        old = w.shift(w.tills[0], 0, status=ShiftStatus.CLOSED)
        original = sale(w, w.tills[0], old, [("Wine", 1, "40.00")], legs=[("cash", "40.00")])
        _no_money_credit(w, w.tills[0], w.shift1, original, "40.00", "cash")
        t = compute_totals(w.db, [w.shift1.id])
        assert t.total_refunds == Decimal("40.00")  # fiscal: a credit like any other
        assert t.payment_breakdown["no_money"] == Decimal("-40.00")
        assert t.total_cash == Decimal("25.00")  # only the sale of this shift
        assert t.total_card == Decimal("50.00")

    def test_against_a_sale_of_the_same_shift_it_cancels_that_sales_tender(self, world):
        w = world
        _no_money_credit(w, w.tills[0], w.shift1, w.original, "25.00", "cash")
        t = compute_totals(w.db, [w.shift1.id])
        assert "no_money" not in t.payment_breakdown
        assert t.total_cash == Decimal("0.00")

    def test_a_no_money_card_credit_stays_out_of_the_card_brand_split(self, world):
        w = world
        old = w.shift(w.tills[0], 0, status=ShiftStatus.CLOSED)
        original = sale(w, w.tills[0], old, [("Wine", 1, "40.00")], legs=[("card", "40.00")])
        _no_money_credit(w, w.tills[0], w.shift1, original, "40.00", "card")
        t = compute_totals(w.db, [w.shift1.id])
        assert t.total_card == Decimal("50.00")
        assert sum(r["refundsCount"] for r in t.card_brands_json()) == 0


# ── Wiring ───────────────────────────────────────────────────────────────────


def test_the_till_parameters_are_registered():
    from app.services.till_parameters import BUILTIN_PARAMETERS

    by_key = {p.key: p for p in BUILTIN_PARAMETERS}
    assert by_key["remoteCreditPrint"].value_type == "boolean" and by_key["remoteCreditPrint"].default_value is True
    assert by_key["remoteCreditExpiryHours"].value_type == "integer"
    assert by_key["remoteCreditExpiryHours"].default_value == 24


def test_the_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for route in (
        ("GET", "/api/v1/remote-credits/prepare"),
        ("POST", "/api/v1/remote-credits"),
        ("GET", "/api/v1/remote-credits"),
        ("GET", "/api/v1/remote-credits/{request_id}"),
        ("POST", "/api/v1/remote-credits/{request_id}/cancel"),
        ("GET", "/api/v1/sync/{machine_id}/remote-credits"),
        ("POST", "/api/v1/sync/{machine_id}/remote-credits/{request_id}/ack"),
    ):
        assert route in mounted


def test_the_documents_carry_the_marking_in_and_out():
    from app.schemas.transaction import TransactionIn, TransactionListItem, TransactionOut, TransactionPaymentOut

    assert "remote_credit_request_id" in TransactionIn.model_fields
    assert TransactionIn.model_fields["remote_credit_request_id"].alias == "remoteCreditRequestId"
    for model in (TransactionOut, TransactionListItem):
        assert model.model_fields["no_money_movement"].alias == "noMoneyMovement"
    assert TransactionPaymentOut.model_fields["no_money_movement"].alias == "noMoneyMovement"


def test_the_migration_is_on_the_single_head():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "7e3a5c9b1d24" in {r.revision for r in script.walk_revisions("base", heads[0])}
