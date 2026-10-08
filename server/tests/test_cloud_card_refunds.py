"""
"זיכוי באשראי מהענן (Z-Credit)" — the cloud refunds a Z-Credit card sale, a till issues the credit
note (docs/SPEC_REMOTE_CREDIT.md §11).

**Only a fake gateway.** Every test here talks to `FakeGateway`; the real one refuses to be
built inside a test run, and its terminal numbers / passwords below are made up.

What each class pins:

* **Which legs** — only a card leg charged through Z-Credit (its reply says `provider: zcredit`
  and carries the reference); a shop with Z-Credit and another terminal ("גם וגם") keeps the
  other leg on the till's path. The credentials are the sale's till's, the most specific layer.
* **The money, once** — the sale's state is read first (voided / refunded / partly refunded
  outside / partial before the deposit → nothing is sent); the refund is sent once; a lost
  reply is resolved by the status query — refunded, not refunded (only once the gateway had
  time), or still unknown — and never sent again; a crash between the steps is recovered.
* **Idempotency** — the same id is the same refund; other content under it is a 409.
* **Never twice** — a refund holds its lines and its money until its credit note lands: no
  second cloud refund, no remote credit for the same lines; a till's own card credit counts.
* **The document** — a `card_refunded` remote-credit request to the till (the original's by
  default), its tender the refunded card leg (no `uid`: never waiting for a transmission); the
  till's ack / the landed note complete it; a refusal or expiry leaves "document missing" and
  the dashboard sends it to another till; it cannot be cancelled.
* **Audit, permissions, switch, reconciliation, wiring.**

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import Response

from app.middleware.auth import get_current_machine_admin
from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundEvent
from app.models.remote_credit import RemoteCreditRequest
from app.models.transaction import TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.routers import cloud_card_refunds as R
from app.routers import remote_credits as RCR
from app.schemas.cloud_card_refund import CloudCardRefundCreateIn, CloudCardRefundResendIn, CloudCardRefundResolveIn
from app.services import cloud_card_refunds as svc
from app.services import payment_secrets as PS
from app.services import remote_credits as rc
from app.services import zcredit_gateway as zg
from app.services.transmissions import terminal_uid_of
from test_remote_credits import credit_note, items_of, open_shift, sale
from test_shop_areas import _ctx, refused, w  # noqa: F401

#: Made-up terminals and passwords — never a real terminal's.
SHOP_TERMINAL = "0990000001"
TILL_TERMINAL = "0990000002"
SHOP_PASSWORD = "fake-shop-password"
TILL_PASSWORD = "fake-till-password"
SALE_REF = "77001234"


# ── The fake gateway ─────────────────────────────────────────────────────────


class FakeGateway:
    """
    Z-Credit as a dict: one sale per reference, its StatusCode and sum. `refund` either answers
    (and moves the sale's status), or raises a `GatewayError` after (`lose_reply`) or before
    (`no_connection`) "doing" it.
    """

    def __init__(self, sales=None):
        self.sales = dict(sales or {})  # reference -> {"status": int, "sum": agorot}
        self.calls = []
        self.refund_reply = None  # a Reply to answer instead of approving
        self.lose_reply = False  # the refund happens, the answer is lost
        self.lose_and_skip = False  # the answer is lost and the refund did NOT happen
        self.no_connection = False
        self.query_down = False
        self.next_reference = 99000001

    def status_by_reference(self, credentials, reference):
        self.calls.append(("status", credentials.terminal_number, credentials.password, reference))
        if self.query_down:
            raise zg.GatewayError("query down", maybe_sent=True)
        sale = self.sales.get(reference)
        if sale is None:
            return zg.Reply(has_error=True, return_code=-80, return_message="Transaction was not found")
        return zg.Reply(
            has_error=False, return_code=0, return_message="OK",
            reference_number=reference, status_code=sale["status"], transaction_agorot=sale["sum"],
        )

    def refund(self, credentials, reference, amount_agorot):
        self.calls.append(("refund", credentials.terminal_number, credentials.password, reference, amount_agorot))
        if self.no_connection:
            raise zg.GatewayError("connect refused", maybe_sent=False)
        if self.refund_reply is not None:
            return self.refund_reply
        sale = self.sales[reference]
        if not self.lose_and_skip:
            refunded = sale.setdefault("refunded", 0) + amount_agorot
            sale["refunded"] = refunded
            if sale["status"] == 1:
                sale["status"] = 3
            else:
                sale["status"] = 4 if refunded >= sale["sum"] else 6
        if self.lose_reply or self.lose_and_skip:
            raise zg.GatewayError("read timeout", maybe_sent=True)
        self.next_reference += 1
        return zg.Reply(
            has_error=False, return_code=0, return_message="העסקה בוצעה",
            reference_number=str(self.next_reference), approval_number="0123456", voucher_number="05001",
            card_last4="4580",
        )

    def refunds(self):
        return [c for c in self.calls if c[0] == "refund"]


# ── The world ────────────────────────────────────────────────────────────────


def zcredit_meta(reference=SALE_REF, last4="4580"):
    """A Z-Credit card leg's reply as the till stores it (pos-android cardSaleMeta + toAshraitJson)."""
    return {
        "vuid": "17",
        "uid": reference,
        "authNum": "0123456",
        "cardLast4": last4,
        "outcome": "approved",
        "result": {
            "provider": "zcredit",
            "statusCode": 0,
            "uid": reference,
            "transactionId": reference,
            "zcreditReferenceNumber": reference,
            "issuerAuthNum": "0123456",
            "cardNumber": "************" + last4,
            "mutag": 2,
            "solek": 6,
            "manpik": 6,
        },
    }


def agamento_meta():
    return {"vuid": "18", "uid": "A-555", "authNum": "777", "cardLast4": "1111",
            "result": {"uid": "A-555", "transactionId": "T-555", "issuerAuthNum": "777", "mutag": 1}}


def set_meta(w, tx, metas):
    """Give `tx`'s card legs, in order, these replies."""
    legs = (
        w.db.query(TransactionPayment)
        .filter_by(transaction_id=tx.id, method="card")
        .order_by(TransactionPayment.sequence)
        .all()
    )
    for leg, meta in zip(legs, metas):
        leg.nayax_meta = meta
        leg.card_brand = "visa" if meta.get("result", {}).get("provider") == "zcredit" else "mastercard"
    w.db.flush()
    return legs


@pytest.fixture
def world(w, monkeypatch):
    """
    Till 1 and North 1 have open shifts; Till 2 has none. Center's shop is on Z-Credit (terminal
    and password on the shop's layer). A ₪75 sale on Till 1: ₪50 Z-Credit card + ₪25 another
    terminal's card ("גם וגם").
    """
    from app.services import ably_notify

    w.published = []
    monkeypatch.setattr(ably_notify, "is_enabled", lambda: True)
    monkeypatch.setattr(ably_notify, "publish_remote_credit_notify", lambda *a, **k: w.published.append((a, k)))
    monkeypatch.setattr(svc, "enabled", lambda: True)
    w.gw = FakeGateway({SALE_REF: {"status": 2, "sum": 5000}})
    monkeypatch.setattr(svc, "gateway_factory", lambda: w.gw)
    monkeypatch.setattr(svc, "sleep", lambda s: None)

    w.shop.settings = {"paymentIntegration": "zcredit", "zcreditTerminalNumber": SHOP_TERMINAL}
    PS.apply_secret_patch(w.db, "shop", w.shop.id, {"zcreditPassword": SHOP_PASSWORD}, tenant_id=w.tenant.id)
    # Every till here runs a build that issues `card_refunded` credits (svc.MIN_CARD_REFUNDED_VERSION_CODE).
    for m in list(w.tills) + [w.other_till]:
        m.app_version = "0.1.248+test-device"
    w.shift1 = open_shift(w, w.tills[0])
    w.north_shift = open_shift(w, w.other_till)
    w.original = sale(
        w, w.tills[0], w.shift1, [("Beer", 2, "30.00"), ("Chips", 1, "15.00")],
        legs=[("card", "50.00"), ("card", "25.00")],
    )
    w.zleg, w.other_leg = set_meta(w, w.original, [zcredit_meta(), agamento_meta()])
    w.db.commit()
    return w


def body(w, *, leg=None, till=None, rid=None, **over) -> CloudCardRefundCreateIn:
    beer, _chips = items_of(w, w.original)
    data = {
        "id": str(rid or uuid.uuid4()),
        "transactionId": str(w.original.id),
        "paymentId": str((leg or w.zleg).id),
        "machineId": str((till or w.tills[0]).id),
        "full": False,
        "lines": [{"itemId": str(beer.id), "quantity": 1}],
        "reasonCode": "product_returned",
    }
    data.update(over)
    return CloudCardRefundCreateIn.model_validate(data)


def create(w, user=None, **over):
    response = Response()
    out = R.create_cloud_card_refund(body(w, **over), response, **_ctx(w, user))
    return response.status_code, out


def row_of(w, out) -> CloudCardRefund:
    w.db.expire_all()
    return w.db.get(CloudCardRefund, uuid.UUID(out["id"]))


def request_of(w, out) -> RemoteCreditRequest:
    return w.db.get(RemoteCreditRequest, uuid.UUID(out["document"]["requestId"]))


# ── Which legs ───────────────────────────────────────────────────────────────


class TestWhichLegs:
    def test_only_the_zcredit_leg_is_offered_the_other_terminal_keeps_the_tills_path(self, world):
        out = R.prepare_cloud_card_refund(transaction_id=world.original.id, **_ctx(world))
        by_id = {l["paymentId"]: l for l in out["legs"]}
        z, other = by_id[str(world.zleg.id)], by_id[str(world.other_leg.id)]
        assert z["zcredit"] is True and z["refundable"] is True and z["remainingAmount"] == "50.00"
        assert z["cardLast4"] == "4580" and z["provider"] == "zcredit"
        assert other["zcredit"] is False and other["refundable"] is False
        assert other["refusal"]["code"] == "not_zcredit"
        assert out["enabled"] is True and out["credentials"]["available"] is True
        assert out["credentials"]["terminal"] == "09******01" and out["credentials"]["source"] == "shop"
        assert [t["machineId"] for t in out["document"]["targets"]][0] == str(world.tills[0].id)
        assert {r["code"] for r in out["document"]["reasons"]} == svc.REASON_CODES

    def test_the_other_terminals_leg_is_refused(self, world):
        e = refused(create, world, leg=world.other_leg)
        assert e.status_code == 409 and e.detail["code"] == "not_zcredit"
        assert world.gw.calls == []

    def test_a_leg_without_a_reference_or_a_cash_leg_is_refused(self, world):
        meta = zcredit_meta()
        for key in ("uid", "transactionId", "zcreditReferenceNumber"):
            meta["result"].pop(key)
        meta.pop("uid")
        world.zleg.nayax_meta = meta
        world.db.commit()
        assert refused(create, world).detail["code"] == "no_gateway_reference"
        cash = sale(world, world.tills[0], world.shift1, [("Tea", 1, "8.00")], legs=[("cash", "8.00")])
        world.db.commit()
        leg = world.db.query(TransactionPayment).filter_by(transaction_id=cash.id).one()
        assert svc.leg_refusal(leg)[0] == "not_a_card_leg"

    def test_the_reference_and_provider_are_read_as_the_till_stores_them(self):
        assert svc.leg_reference({"result": {"zcreditReferenceNumber": "0"}, "uid": "123"}) == "123"
        assert svc.leg_reference({"result": {"transactionId": 4567}}) == "4567"
        assert svc.leg_provider({"result": {"provider": "ZCredit"}}) == "zcredit"
        assert svc.leg_provider({"uid": "1"}) is None


class TestCredentials:
    def test_the_tills_own_layer_wins_over_the_shops(self, world):
        w = world
        w.tills[0].settings = {"zcreditTerminalNumber": TILL_TERMINAL}
        PS.apply_secret_patch(w.db, "machine", w.tills[0].id, {"zcreditPassword": TILL_PASSWORD}, tenant_id=w.tenant.id)
        w.db.commit()
        creds, missing = svc.credentials_for(w.db, w.tills[0], w.original)
        assert missing is None and creds.terminal_number == TILL_TERMINAL and creds.source == "machine"
        assert TILL_PASSWORD not in repr(creds)

    def test_no_password_or_no_terminal_refuses_before_anything_is_sent(self, world):
        w = world
        PS.apply_secret_patch(w.db, "shop", w.shop.id, {"zcreditPassword": None}, tenant_id=w.tenant.id)
        w.db.commit()
        assert refused(create, w).detail["code"] == "zcredit_password_missing"
        w.shop.settings = {}
        w.db.commit()
        assert refused(create, w).detail["code"] == "zcredit_terminal_missing"
        assert w.gw.calls == []

    def test_a_sale_charged_on_another_terminal_is_refused(self, world):
        meta = zcredit_meta()
        meta["result"]["zcreditTerminalNumber"] = "0990000077"
        world.zleg.nayax_meta = meta
        world.db.commit()
        assert refused(create, world).detail["code"] == "terminal_changed"


# ── The money, once ──────────────────────────────────────────────────────────


class TestHappyPath:
    def test_a_refund_is_checked_sent_once_and_asks_the_original_till_for_the_credit_note(self, world):
        w = world
        code, out = create(w)
        assert code == 201 and out["status"] == "refunded" and out["amount"] == "30.00"
        assert [c[0] for c in w.gw.calls] == ["status", "refund"]
        _, terminal, password, ref, amount = w.gw.refunds()[0]
        assert (terminal, password, ref, amount) == (SHOP_TERMINAL, SHOP_PASSWORD, SALE_REF, 3000)
        assert out["refundReference"] == "99000002" and out["approvalNumber"] == "0123456"
        assert out["beforeStatusCode"] == 2 and out["voided"] is False and out["resolvedBy"] == "gateway"
        assert out["terminal"] == "09******01" and SHOP_PASSWORD not in str(out)
        assert out["attention"] == "document_pending"
        req = request_of(w, out)
        assert req.mode == "card_refunded" and req.machine_id == w.tills[0].id
        assert req.card_refund_id == uuid.UUID(out["id"]) and req.amount == Decimal("30.00")
        assert [(l["productName"], l["quantity"]) for l in req.lines] == [("Beer", 1.0)]
        assert [e["action"] for e in out["events"]] == [
            "created", "preflight", "sent", "refunded", "document_requested",
        ]
        assert out["events"][0]["by"] == "admin"

    def test_the_till_gets_the_card_leg_as_its_tender_never_waiting_for_a_transmission(self, world):
        w = world
        _, out = create(w)
        pulled = RCR.till_remote_credits(str(w.tills[0].id), machine=w.tills[0], db=w.db)
        (req,) = pulled["requests"]
        assert req["mode"] == "card_refunded" and req["amount"] == 30.0
        (tender,) = req["tenders"]
        assert tender["method"] == "card" and tender["amount"] == 30.0 and tender["cardBrand"] == "visa"
        meta = tender["nayaxMeta"]
        assert meta["cloudCardRefundId"] == out["id"] and meta["result"]["provider"] == "zcredit"
        assert meta["result"]["cloudRefund"] is True and meta["result"]["originalReferenceNumber"] == SALE_REF
        assert meta["result"]["zcreditReferenceNumber"] == "99000002" and meta["result"]["mutag"] == 2
        assert terminal_uid_of(meta) is None  # no batch of any till carries it
        assert req["cardRefund"]["id"] == out["id"] and req["cardRefund"]["cardLast4"] == "4580"
        assert req["original"]["id"] == str(w.original.id)
        # The dashboard's view of the request shows method and money only.
        got = RCR.get_remote_credit(uuid.UUID(req["requestId"]), **_ctx(w))
        assert got["tenders"] == [{"method": "card", "amount": "30.00"}] and got["cardRefundId"] == out["id"]

    def test_the_tills_ack_and_the_landed_note_complete_it(self, world):
        w = world
        _, out = create(w)
        req = request_of(w, out)
        beer, _ = items_of(w, w.original)
        note = credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")], method="card")
        note.remote_credit_request_id = req.id
        w.db.flush()
        rc.apply_ack(w.db, w.tills[0], req.id, phase="completed", credit_transaction_id=note.id,
                     credit_document_number="10000009", credit_document_type=330)
        rc.on_documents(w.db, w.tills[0], [note.id])
        w.db.commit()
        got = R.get_cloud_card_refund(uuid.UUID(out["id"]), **_ctx(w))
        assert got["document"]["creditTransactionId"] == str(note.id) and got["document"]["landed"] is True
        assert got["document"]["creditDocumentNumber"] == "10000009" and got["attention"] is None
        assert [e["action"] for e in got["events"]].count("document_issued") == 1
        # Landed: counted as a credit note now, no longer as a hold.
        state = rc.creditable(w.db, w.original).line(beer.id)
        assert (state.credited, state.pending) == (Decimal("1"), Decimal("0"))
        z = R.prepare_cloud_card_refund(transaction_id=w.original.id, **_ctx(w))["legs"][0]
        assert (z["refundedAmount"], z["tillCardCredits"], z["remainingAmount"]) == ("30.00", "0.00", "20.00")

    def test_a_full_refund_before_the_deposit_is_a_void(self, world):
        w = world
        w.gw.sales[SALE_REF]["status"] = 1
        sale2 = sale(w, w.tills[0], w.shift1, [("Wine", 1, "50.00")], legs=[("card", "50.00")])
        (leg,) = set_meta(w, sale2, [zcredit_meta("88001")])
        w.gw.sales["88001"] = {"status": 1, "sum": 5000}
        w.db.commit()
        response = Response()
        out = R.create_cloud_card_refund(
            CloudCardRefundCreateIn.model_validate({
                "id": str(uuid.uuid4()), "transactionId": str(sale2.id), "paymentId": str(leg.id),
                "machineId": str(w.tills[0].id), "full": True, "reasonCode": "order_cancelled",
            }),
            response, **_ctx(w),
        )
        assert out["status"] == "refunded" and out["voided"] is True and w.gw.sales["88001"]["status"] == 3


class TestNothingIsSentWhenTheGatewaySaysNo:
    @pytest.mark.parametrize(
        "status,code",
        [(3, "already_voided_at_gateway"), (4, "already_refunded_at_gateway"), (6, "refunded_outside_system"),
         (9, "gateway_status_unclear")],
    )
    def test_the_sales_state_at_the_gateway_is_read_first(self, world, status, code):
        world.gw.sales[SALE_REF]["status"] = status
        _, out = create(world)
        assert out["status"] == "declined" and out["errorCode"] == code
        assert world.gw.refunds() == [] and out["document"]["requestId"] is None

    def test_a_partial_refund_before_the_deposit_is_refused(self, world):
        world.gw.sales[SALE_REF]["status"] = 1
        _, out = create(world)
        assert out["errorCode"] == "partial_before_deposit" and world.gw.refunds() == []

    def test_a_sale_the_terminal_does_not_know_or_refused_credentials(self, world):
        world.gw.sales.pop(SALE_REF)
        _, out = create(world)
        assert out["errorCode"] == "original_not_found_at_gateway" and world.gw.refunds() == []

    def test_an_unreachable_gateway_refunds_nothing(self, world):
        world.gw.query_down = True
        _, out = create(world)
        assert out["status"] == "declined" and out["errorCode"] == "gateway_unreachable"
        assert world.gw.refunds() == []

    def test_a_refusal_by_the_gateway_is_declined_and_frees_the_lines(self, world):
        w = world
        w.gw.refund_reply = zg.Reply(has_error=True, return_code=-844, return_message="לא ניתן לזיכוי")
        _, out = create(w)
        assert out["status"] == "declined" and out["errorCode"] == "not_refundable"
        assert out["returnCode"] == -844 and out["document"]["requestId"] is None
        w.gw.refund_reply = None
        code, again = create(w)  # a new id: a new refund
        assert code == 201 and again["status"] == "refunded"

    def test_no_connection_at_all_is_not_sent(self, world):
        world.gw.no_connection = True
        _, out = create(world)
        assert out["status"] == "declined" and out["errorCode"] == "not_sent"


# ── Unknown outcomes ─────────────────────────────────────────────────────────


class TestLostReply:
    def test_a_lost_reply_is_resolved_by_the_status_query_and_never_sent_again(self, world):
        w = world
        w.gw.lose_reply = True
        _, out = create(w)
        assert out["status"] == "refunded" and out["resolvedBy"] == "status_query"
        assert len(w.gw.refunds()) == 1 and out["afterStatusCode"] == 6
        assert out["document"]["requestId"] is not None
        actions = [e["action"] for e in out["events"]]
        assert actions[:4] == ["created", "preflight", "sent", "unknown"] and "resolved" in actions

    def test_untouched_right_after_is_too_early_to_say_no(self, world):
        w = world
        w.gw.lose_and_skip = True
        _, out = create(w)
        assert out["status"] == "unknown" and out["attention"] == "unknown"
        assert len(w.gw.refunds()) == 1 and out["queryCount"] == 3
        # Later, once the gateway had time to settle: not refunded.
        row = row_of(w, out)
        row.refund_sent_at = datetime.now(timezone.utc) - svc.SETTLE_AFTER - timedelta(seconds=1)
        row.last_query_at = None
        w.db.commit()
        got = R.check_cloud_card_refund(row.id, **_ctx(w))
        assert got["status"] == "declined" and got["errorCode"] == "not_refunded_by_query"
        assert len(w.gw.refunds()) == 1

    def test_no_answer_to_the_queries_stays_unknown_until_checked_again(self, world):
        w = world
        w.gw.lose_reply = True

        real_status = w.gw.status_by_reference
        calls = {"n": 0}

        def flaky(creds, ref):
            calls["n"] += 1
            if calls["n"] > 1:  # the preflight answers; the queries after the loss do not
                raise zg.GatewayError("down", maybe_sent=True)
            return real_status(creds, ref)

        w.gw.status_by_reference = flaky
        _, out = create(w)
        assert out["status"] == "unknown" and out["queryCount"] == 3
        e = refused(R.check_cloud_card_refund, uuid.UUID(out["id"]), **_ctx(w))
        assert e.status_code == 429 and e.detail["code"] == "check_too_soon"
        w.gw.status_by_reference = real_status
        row = row_of(w, out)
        row.last_query_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        w.db.commit()
        got = R.check_cloud_card_refund(row.id, **_ctx(w))
        assert got["status"] == "refunded" and len(w.gw.refunds()) == 1
        assert got["document"]["requestId"] is not None

    def test_an_ambiguous_answer_waits_for_an_operator_who_records_the_outcome(self, world):
        w = world
        _, first = create(w)  # 30.00 refunded: the sale is now partially refunded (6)
        assert first["status"] == "refunded"
        chips = items_of(w, w.original)[1]
        w.gw.lose_and_skip = True
        _, out = create(w, lines=[{"itemId": str(chips.id), "quantity": 1}])
        assert out["status"] == "unknown"  # 6 before, 6 after: cannot tell
        e = refused(R.resolve_cloud_card_refund, uuid.UUID(out["id"]),
                    CloudCardRefundResolveIn(outcome="refunded", note=" "), **_ctx(w))
        assert e.detail["code"] == "note_required"
        got = R.resolve_cloud_card_refund(
            uuid.UUID(out["id"]), CloudCardRefundResolveIn(outcome="refunded", note="נמצא בדוח Z-Credit, אסמכתא 991"),
            **_ctx(w),
        )
        assert got["status"] == "refunded" and got["resolvedBy"] == "manual"
        assert got["resolutionNote"].startswith("נמצא") and got["document"]["requestId"] is not None
        assert "resolved_manually" in [e["action"] for e in got["events"]]
        assert len(w.gw.refunds()) == 2  # one per refund, none again
        e = refused(R.resolve_cloud_card_refund, uuid.UUID(out["id"]),
                    CloudCardRefundResolveIn(outcome="not_refunded", note="x y"), **_ctx(w))
        assert e.detail["code"] == "refund_not_unknown"

    def test_an_operator_may_record_that_nothing_happened(self, world):
        w = world
        w.gw.lose_and_skip = True
        _, out = create(w)
        got = R.resolve_cloud_card_refund(
            uuid.UUID(out["id"]), CloudCardRefundResolveIn(outcome="not_refunded", note="לא בדוח"), **_ctx(w),
        )
        assert got["status"] == "declined" and got["errorCode"] == "not_refunded_manual"
        code, again = create(w)  # the lines are free again
        assert code == 201


class TestCrash:
    def _crashed(self, w, *, sent: bool) -> CloudCardRefund:
        row, _creds = svc._start(w.db, w.admin, w.original, w.tills[0], svc.NewCardRefund(
            refund_id=uuid.uuid4(), original_id=w.original.id, payment_id=w.zleg.id, machine_id=w.tills[0].id,
            full=False, lines=[(items_of(w, w.original)[0].id, Decimal(1))], reason=None, reason_code="product_returned",
        ), now=datetime.now(timezone.utc) - timedelta(minutes=10))
        if sent:
            row.refund_sent_at = datetime.now(timezone.utc) - timedelta(minutes=9)
        w.db.commit()
        return row

    def test_a_row_that_never_sent_is_declined(self, world):
        row = self._crashed(world, sent=False)
        got = R.check_cloud_card_refund(row.id, **_ctx(world))
        assert got["status"] == "declined" and got["errorCode"] == "not_sent" and world.gw.refunds() == []

    def test_a_row_that_may_have_sent_is_resolved_by_a_query(self, world):
        row = self._crashed(world, sent=True)
        row.before_status_code = 2
        world.gw.sales[SALE_REF]["status"] = 6  # it went through before the crash
        world.db.commit()
        got = R.check_cloud_card_refund(row.id, **_ctx(world))
        assert got["status"] == "refunded" and got["resolvedBy"] == "status_query" and world.gw.refunds() == []

    def test_a_fresh_in_flight_row_is_not_touched(self, world):
        w = world
        row, _ = svc._start(w.db, w.admin, w.original, w.tills[0], svc.NewCardRefund(
            refund_id=uuid.uuid4(), original_id=w.original.id, payment_id=w.zleg.id, machine_id=w.tills[0].id,
            full=False, lines=[(items_of(w, w.original)[1].id, Decimal(1))], reason="x y", reason_code=None,
        ), now=None)
        w.db.commit()
        e = refused(R.check_cloud_card_refund, row.id, **_ctx(w))
        assert e.detail["code"] == "refund_in_progress"


# ── Idempotency ──────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_the_same_id_is_the_same_refund(self, world):
        rid = uuid.uuid4()
        c1, a = create(world, rid=rid)
        c2, b = create(world, rid=rid)
        assert (c1, c2) == (201, 200) and a["id"] == b["id"] == str(rid)
        assert len(world.gw.refunds()) == 1
        assert world.db.query(CloudCardRefund).count() == 1
        assert world.db.query(RemoteCreditRequest).count() == 1

    def test_the_same_id_with_other_content_is_a_conflict(self, world):
        rid = uuid.uuid4()
        create(world, rid=rid)
        e = refused(create, world, rid=rid, full=True)
        assert e.status_code == 409 and e.detail["code"] == "card_refund_id_conflict"

    def test_the_id_is_required(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            CloudCardRefundCreateIn.model_validate({
                "transactionId": str(uuid.uuid4()), "paymentId": str(uuid.uuid4()), "machineId": str(uuid.uuid4()),
            })


# ── Never twice ──────────────────────────────────────────────────────────────


class TestNeverTwice:
    def test_a_refund_holds_its_lines_until_its_note_lands(self, world):
        w = world
        create(w)  # one beer
        beer, chips = items_of(w, w.original)
        e = refused(create, w, lines=[{"itemId": str(beer.id), "quantity": 2}])
        assert e.detail["code"] == "over_credit"
        # Nor may a remote credit take that beer.
        e = refused(RCR.create_remote_credit, RCR.RemoteCreditCreateIn.model_validate({
            "transactionId": str(w.original.id), "machineId": str(w.tills[0].id), "mode": "prepared",
            "full": False, "lines": [{"itemId": str(beer.id), "quantity": 2}], "reasonCode": "other", "reason": "x y",
        }), Response(), **_ctx(w))
        assert e.detail["code"] == "over_credit"
        # Even once the till acked the note but before it reached the cloud.
        req = w.db.query(RemoteCreditRequest).one()
        rc.apply_ack(w.db, w.tills[0], req.id, phase="completed", credit_transaction_id=uuid.uuid4())
        w.db.commit()
        cr = rc.creditable(w.db, w.original)
        assert cr.line(beer.id).pending == Decimal("1")

    def test_the_card_leg_caps_the_refund(self, world):
        w = world
        e = refused(create, w, full=True)  # 75.00 of lines on a 50.00 card leg
        assert e.detail["code"] == "over_card_leg" and w.gw.calls == []
        create(w)  # 30.00
        beer, chips = items_of(w, w.original)
        e = refused(create, w, lines=[{"itemId": str(beer.id), "quantity": 1}, {"itemId": str(chips.id), "quantity": 1}])
        assert e.detail["code"] == "over_card_leg"  # 45.00 > the 20.00 left on the card

    def test_a_tills_own_card_credit_counts_against_the_leg(self, world):
        w = world
        _, chips = items_of(w, w.original)
        credit_note(w, w.tills[0], w.shift1, w.original, [(chips, 1, "15.00")], method="card")
        w.db.commit()
        out = R.prepare_cloud_card_refund(transaction_id=w.original.id, **_ctx(w))
        z = next(l for l in out["legs"] if l["paymentId"] == str(w.zleg.id))
        assert z["tillCardCredits"] == "15.00" and z["remainingAmount"] == "35.00"
        beer, _ = items_of(w, w.original)
        e = refused(create, w, lines=[{"itemId": str(beer.id), "quantity": 2}])
        assert e.detail["code"] == "over_card_leg"

    def test_a_refunded_or_cancelled_document_is_refused(self, world):
        world.original.status = TransactionStatus.REFUNDED
        world.db.commit()
        assert refused(create, world).detail["code"] == "already_refunded"


# ── The credit note ──────────────────────────────────────────────────────────


class TestTheDocument:
    def test_it_cannot_be_cancelled_only_moved(self, world):
        w = world
        _, out = create(w)
        req_id = uuid.UUID(out["document"]["requestId"])
        e = refused(RCR.cancel_remote_credit, req_id, None, **_ctx(w))
        assert e.detail["code"] == "card_refunded_not_cancellable"
        e = refused(R.resend_cloud_card_refund, uuid.UUID(out["id"]),
                    CloudCardRefundResendIn(machineId=w.other_till.id), **_ctx(w))
        assert e.detail["code"] == "document_request_pending"
        got = R.resend_cloud_card_refund(uuid.UUID(out["id"]),
                                         CloudCardRefundResendIn(machineId=w.other_till.id, force=True), **_ctx(w))
        assert got["targetMachineId"] == str(w.other_till.id) and got["document"]["requestId"] != str(req_id)
        assert w.db.get(RemoteCreditRequest, req_id).status == "cancelled"
        assert len(w.gw.refunds()) == 1

    def test_a_till_that_refuses_it_leaves_the_document_missing_until_sent_again(self, world):
        w = world
        _, out = create(w)
        req = request_of(w, out)
        # A till from before the mode refuses it ("unknown_mode").
        rc.apply_ack(w.db, w.tills[0], req.id, phase="failed", error_code="unknown_mode", error_message="מצב לא מוכר")
        w.db.commit()
        got = R.get_cloud_card_refund(uuid.UUID(out["id"]), **_ctx(w))
        assert got["attention"] == "document_missing" and got["document"]["requestStatus"] == "failed"
        assert "document_failed" in [e["action"] for e in got["events"]]
        listed = R.list_cloud_card_refunds(transaction_id=None, attention=True, limit=50, **_ctx(w))
        assert [r["id"] for r in listed["items"]] == [out["id"]]
        # Still holding its lines: the money moved.
        beer, _ = items_of(w, w.original)
        assert rc.creditable(w.db, w.original).line(beer.id).pending == Decimal("1")
        got = R.resend_cloud_card_refund(uuid.UUID(out["id"]),
                                         CloudCardRefundResendIn(machineId=w.other_till.id), **_ctx(w))
        assert got["attention"] == "document_pending" and got["targetMachineName"] == "North 1"
        assert "resent" in [e["action"] for e in got["events"]]

    def test_an_expired_ask_is_document_missing_too(self, world):
        w = world
        _, out = create(w)
        req = request_of(w, out)
        assert round((req.expires_at - req.created_at).total_seconds() / 3600) == rc.MAX_TTL_HOURS
        rc.expire_overdue(w.db, now=req.expires_at + timedelta(minutes=1))
        w.db.commit()
        assert R.get_cloud_card_refund(uuid.UUID(out["id"]), **_ctx(w))["attention"] == "document_missing"

    def test_an_earlier_till_issuing_it_after_all_cancels_the_later_ask(self, world):
        w = world
        _, out = create(w)
        first = request_of(w, out)
        rc.apply_ack(w.db, w.tills[0], first.id, phase="failed", error_code="no_open_shift")
        R.resend_cloud_card_refund(uuid.UUID(out["id"]), CloudCardRefundResendIn(machineId=w.other_till.id), **_ctx(w))
        second_id = row_of(w, out).remote_credit_request_id
        # The first till issued it offline after all.
        rc.apply_ack(w.db, w.tills[0], first.id, phase="completed", credit_transaction_id=uuid.uuid4(),
                     credit_document_number="10000010")
        w.db.commit()
        assert w.db.get(RemoteCreditRequest, second_id).status == "cancelled"
        assert row_of(w, out).credit_document_number == "10000010"

    def test_a_card_refunded_request_cannot_be_asked_for_directly(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            RCR.RemoteCreditCreateIn.model_validate({
                "transactionId": str(uuid.uuid4()), "machineId": str(uuid.uuid4()), "mode": "card_refunded",
            })

    def test_the_target_must_be_an_eligible_till(self, world):
        e = refused(create, world, till=world.tills[1])  # no open shift
        assert e.detail["code"] == "target_no_open_shift" and world.gw.calls == []


# ── Permissions and the switch ───────────────────────────────────────────────


class TestPermissions:
    def test_only_owner_and_manager_roles(self, world):
        for fn in (R.create_cloud_card_refund, R.prepare_cloud_card_refund, R.list_cloud_card_refunds,
                   R.get_cloud_card_refund, R.check_cloud_card_refund, R.resolve_cloud_card_refund,
                   R.resend_cloud_card_refund):
            assert inspect.signature(fn).parameters["current_user"].default.dependency is get_current_machine_admin
        assert refused(get_current_machine_admin, current_user=world.cashier).status_code == 403

    def test_a_manager_cannot_send_the_note_to_a_till_of_another_shop(self, world):
        e = refused(create, world, world.manager, till=world.other_till)
        assert e.status_code == 403 and world.gw.calls == []
        code, _ = create(world, world.manager)
        assert code == 201

    def test_a_document_out_of_scope_is_a_404(self, world):
        e = refused(create, world, world.north_manager, till=world.other_till)
        assert e.status_code == 404

    def test_switched_off_nothing_is_sent(self, world, monkeypatch):
        monkeypatch.setattr(svc, "enabled", lambda: False)
        e = refused(create, world)
        assert e.detail["code"] == "cloud_refunds_disabled" and world.gw.calls == []
        out = R.prepare_cloud_card_refund(transaction_id=world.original.id, **_ctx(world))
        assert out["enabled"] is False and "ZCREDIT_CLOUD_REFUNDS_ENABLED" in out["disabledMessage"]

    def test_off_by_default(self):
        from app.config import Settings

        assert Settings.model_fields["zcredit_cloud_refunds_enabled"].default is False

    def test_a_reason_is_required(self, world):
        e = refused(create, world, reasonCode=None, reason=" ")
        assert e.status_code == 422 and e.detail["code"] == "reason_required"
        e = refused(create, world, reasonCode="nope")
        assert e.detail["code"] == "unknown_reason"


# ── The real gateway, never called ───────────────────────────────────────────


class TestGatewayAdapter:
    def test_the_real_gateway_is_never_built_in_a_test(self):
        with pytest.raises(RuntimeError):
            zg.HttpZCreditGateway()

    def test_the_bodies_are_the_documented_ones(self):
        creds = zg.Credentials("0990000001", "pw")
        assert zg.refund_body(creds, " 123 ", 1035) == {
            "TerminalNumber": "0990000001", "Password": "pw",
            "TransactionIdToCancelOrRefund": "123", "TransactionSum": 10.35,
        }
        assert zg.status_body(creds, "123") == {"TerminalNumber": "0990000001", "Password": "pw", "ReferenceID": "123"}
        with pytest.raises(ValueError):
            zg.refund_body(creds, "", 100)
        assert "pw" not in repr(creds)

    def test_replies_are_read_tolerantly(self):
        r = zg.parse_reply('{"HasError": false, "ReturnCode": "0", "ReferenceNumber": 0, "StatusCode": "2",'
                           ' "TransactionSum": "50.00", "CardNumber": "458012******4580"}')
        assert r.ok and r.reference_number is None and r.status_code == 2 and r.transaction_agorot == 5000
        assert r.card_last4 == "4580"
        nf = zg.parse_reply({"HasError": True, "ReturnCode": -80, "ReturnMessage": "Transaction was not found"})
        assert nf.not_found and not nf.ok
        assert zg.parse_reply("not json") is None
        assert zg.parse_reply({"HasError": True, "ReturnCode": -3}).credentials_refused


# ── Reconciliation ───────────────────────────────────────────────────────────


class TestReconciliation:
    def _rows(self, w):
        from app.services import reconciliation as REC
        from app.services.reports import ReportWindow

        now = datetime.now(timezone.utc)
        window = ReportWindow(
            from_date=(now - timedelta(days=1)).date(), to_date=(now + timedelta(days=1)).date(),
            from_hour=None, to_hour=None, tz_name="Asia/Jerusalem",
            start=now - timedelta(days=1), end=now + timedelta(days=1),
        )
        ctx = REC._Ctx(w.db, window, [w.tills[0]], datetime.now(timezone.utc))
        return REC.check_cloud_card_refunds(ctx, [w.tills[0].id])

    def test_a_refund_without_its_note_is_a_gap_until_the_note_lands(self, world):
        w = world
        _, out = create(w)
        (row,) = self._rows(w)
        assert row["status"] == "pending" and row["gapType"] == "card_refund_document_pending"
        req = request_of(w, out)
        rc.apply_ack(w.db, w.tills[0], req.id, phase="failed", error_code="no_open_shift", error_message="אין משמרת")
        w.db.commit()
        (row,) = self._rows(w)
        assert row["status"] == "missing" and "אין משמרת" in row["reason"] and row["action"]["href"]
        beer, _ = items_of(w, w.original)
        note = credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")], method="card")
        R.resend_cloud_card_refund(uuid.UUID(out["id"]), CloudCardRefundResendIn(machineId=w.tills[0].id), **_ctx(w))
        req2 = w.db.get(RemoteCreditRequest, row_of(w, out).remote_credit_request_id)
        note.remote_credit_request_id = req2.id
        w.db.flush()
        rc.on_documents(w.db, w.tills[0], [note.id])
        w.db.commit()
        (row,) = self._rows(w)
        assert row["status"] == "match" and row["expected"] == 30.0 and row["actual"] == 30.0

    def test_an_unknown_outcome_is_a_difference_and_a_declined_one_is_not_listed(self, world):
        w = world
        w.gw.lose_and_skip = True
        create(w)
        w.gw.lose_and_skip = False
        w.gw.refund_reply = zg.Reply(has_error=True, return_code=-844, return_message="no")
        chips = items_of(w, w.original)[1]
        create(w, lines=[{"itemId": str(chips.id), "quantity": 1}])
        rows = self._rows(w)
        assert [(r["status"], r["gapType"]) for r in rows] == [("difference", "card_refund_unknown")]

    def test_the_check_is_part_of_the_report(self):
        from app.services import reconciliation as REC

        assert "cloud_card_refunds" in REC.CHECKS and "cloud_card_refunds" in REC.CHECK_LABELS


# ── Wiring ───────────────────────────────────────────────────────────────────


def test_the_audit_trail_names_who_and_why(world):
    _, out = create(world, world.company_manager, reasonCode="other", reason="הלקוח   התלונן")
    row = row_of(world, out)
    assert row.reason == "הלקוח התלונן" and row.initiated_by == "cm"
    first = world.db.query(CloudCardRefundEvent).filter_by(refund_id=row.id, action="created").one()
    assert first.user_id == world.company_manager.id and first.data["amount"] == "30.00"


def test_the_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for route in (
        ("GET", "/api/v1/cloud-card-refunds/prepare"),
        ("POST", "/api/v1/cloud-card-refunds"),
        ("GET", "/api/v1/cloud-card-refunds"),
        ("GET", "/api/v1/cloud-card-refunds/{refund_id}"),
        ("POST", "/api/v1/cloud-card-refunds/{refund_id}/check"),
        ("POST", "/api/v1/cloud-card-refunds/{refund_id}/resolve"),
        ("POST", "/api/v1/cloud-card-refunds/{refund_id}/resend"),
    ):
        assert route in mounted


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
    assert "c4e8a2f6b1d3" in {r.revision for r in script.walk_revisions("base", heads[0])}


def test_a_till_too_old_for_card_refunded_is_never_sent_the_credit(world):
    # 6cca075 (0.1.248) is the first build that issues it; an older one would answer
    # unknown_mode after the card was already refunded.
    assert svc.till_version_code("0.1.248+b6e07db-device") == 248
    assert svc.till_version_code("0.1.231") == 231
    assert svc.till_version_code(None) is None and svc.till_version_code("dev") is None
    world.tills[0].app_version = "0.1.231+7579d17-device"
    assert svc.version_refusal(world.tills[0]).detail["code"] == "target_too_old"
    world.tills[0].app_version = None
    assert svc.version_refusal(world.tills[0]).detail["code"] == "target_too_old"
    world.tills[0].app_version = "0.1.300+x"
    assert svc.version_refusal(world.tills[0]) is None
