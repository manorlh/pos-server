"""
"טיפ במסופון" (docs/SPEC_TERMINAL_TIP.md): the card terminal asks the customer for the tip
and the till records what it charged — on the document, exactly as a tip taken at the till:
`tipAmount` with `tipPaymentMethod = card`, the card leg the goods it paid for, the
terminal's word on the tip kept in the leg's `nayaxMeta`.

What is pinned here, and how it could look fine while doing damage:

* **The parameters** — `terminalTipPrompt` (and `pinpadAllowHttp`, the pinpad transport of
  the same work) are built-in booleans, off by default, created with the others.
* **Ingest** — the till's document is accepted as it is (the leg net of the tip), and a leg
  that carried the tip would be refused, which is why the till never sends one.
* **The figures** — the Z (card tips, the drawer), the tips report (the waiter's tips, by
  card), and the events report (tips beside sales, card takings without the tip) all count
  the terminal's tip, and only once.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.routers import report_events as R
from app.schemas.report_event import ReportEventCreate
from app.schemas.shift import ShiftCloseIn
from app.schemas.transaction import TransactionIn
from app.services import till_parameters as TP
from app.services.report_events.report import build_report
from app.services.shift_totals import compute_totals
from app.services.shifts import apply_shift_close
from app.services.tips import build_tips_report
from app.services.transactions import upsert_transactions
from app.services.z_builder import build_z
from shift_world import NOW, accept_str_uuids, make_world

WAITER = str(uuid.uuid4())
OTHER = str(uuid.uuid4())


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


# ── The parameters ───────────────────────────────────────────────────────────


class TestParameters:
    def test_terminal_tip_prompt_is_a_builtin_boolean_off_by_default(self):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == "terminalTipPrompt"]
        assert spec.value_type == "boolean" and spec.default_value is False
        assert spec.label == "טיפ במסופון (Agamento שואל את הלקוח)"
        # What it does, what it skips, and the terminal's own switch.
        assert "רושמת" in spec.description
        assert "מסך הטיפ" in spec.description and "במזומן" in spec.description
        assert "בצד המסופון" in spec.description

    def test_pinpad_allow_http_is_a_builtin_boolean_off_by_default(self):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == "pinpadAllowHttp"]
        assert spec.value_type == "boolean" and spec.default_value is False
        assert spec.label == "מסופון ברשת ללא הצפנה (HTTP)"
        for text in ("192.168.x.x", "10.x.x.x", "172.16–31.x.x", "HTTPS", "הקופה השולחנית", "קופה"):
            assert text in spec.description

    def test_both_are_created_with_the_others(self, w):
        TP.ensure_builtin_parameters(w.db)
        rows = {r.key: r for r in w.db.query(TillParameter).filter(
            TillParameter.key.in_(["terminalTipPrompt", "pinpadAllowHttp"])).all()}
        assert set(rows) == {"terminalTipPrompt", "pinpadAllowHttp"}
        assert all(r.value_type == "boolean" and r.is_active for r in rows.values())


# ── A till's document with a tip the terminal charged ────────────────────────


def terminal_meta(uid: str, requested: int, tip: int) -> dict:
    """The card meta the till writes with "טיפ במסופון" on (CheckoutViewModel.chargeCard)."""
    return {
        "vuid": f"v-{uid}", "uid": uid, "authNum": "0123456", "cardLast4": "4580",
        "statusCode": 0, "outcome": "approved",
        "terminalTip": {
            "agorot": tip, "source": "amount_difference", "requestedAgorot": requested,
            "chargedAgorot": requested + tip, "replyAmountAgorot": requested + tip, "field": None,
        },
        "chargedAmount": requested + tip,
        "result": {"statusCode": 0, "uid": uid, "amount": requested + tip},
    }


def push(w, till, shift, *, total, tip="0", tip_method=None, method="card", cashier=WAITER, leg=None, meta=None):
    tx = TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int % 10**9), "status": "completed",
        "totalAmount": total, "documentDiscount": "0", "paymentMethod": method,
        "tipAmount": tip, "tipPaymentMethod": tip_method, "cashierId": cashier,
        "shiftId": str(shift.id), "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "payments": [{"id": str(uuid.uuid4()), "sequence": 1, "method": method,
                      "amount": leg or total, "nayaxMeta": meta}],
    })
    (result,) = upsert_transactions(w.db, till, [tx])
    return tx, result


def open_shift(w, till):
    return w.shift(till, 1, status=ShiftStatus.OPEN, opening_cash="100.00")


def close(w, till, shift):
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))


class TestIngest:
    def test_the_document_is_accepted_with_the_tip_on_it_and_the_leg_net_of_it(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        tx, result = push(w, till, shift, total="100.00", tip="12.00", tip_method="card",
                          meta=terminal_meta("U-1", 10_000, 1_200))
        assert result.status == "accepted", result.reason
        row = w.db.query(Transaction).filter(Transaction.id == tx.id).one()
        assert (row.tip_amount, row.tip_payment_method) == (Decimal("12.00"), "card")
        leg = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id).one()
        assert leg.amount == Decimal("100.00") and leg.terminal_uid == "U-1"
        # What the terminal said about the tip stays with the leg, for support.
        assert leg.nayax_meta["terminalTip"]["agorot"] == 1_200
        assert leg.nayax_meta["chargedAmount"] == 11_200

    def test_a_leg_that_carried_the_tip_would_be_refused(self, w):
        till = w.tills[0]
        shift = open_shift(w, till)
        _tx, result = push(w, till, shift, total="100.00", tip="12.00", tip_method="card", leg="112.00",
                           meta=terminal_meta("U-2", 10_000, 1_200))
        assert result.status == "rejected"
        assert "Tips are not tender legs" in (result.reason or "")


class TestFigures:
    def _shift(self, w):
        """A ₪100 card sale tipped ₪12 at the terminal, and a ₪50 cash sale tipped ₪5 at the till."""
        till = w.tills[0]
        shift = open_shift(w, till)
        _a, ra = push(w, till, shift, total="100.00", tip="12.00", tip_method="card",
                      meta=terminal_meta("U-10", 10_000, 1_200))
        _b, rb = push(w, till, shift, total="50.00", tip="5.00", tip_method="cash", method="cash", cashier=OTHER)
        assert (ra.status, rb.status) == ("accepted", "accepted")
        close(w, till, shift)
        return till, shift

    def test_the_z_counts_it_as_a_card_tip_and_keeps_it_out_of_the_drawer(self, w):
        till, shift = self._shift(w)
        totals = compute_totals(w.db, [shift.id])
        assert totals.total_tips == Decimal("17.00")
        assert (totals.total_cash_tips, totals.total_card_tips) == (Decimal("5.00"), Decimal("12.00"))
        # Card takings are the goods; the tip is beside them, never inside.
        assert totals.total_card == Decimal("100.00")
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert (z.total_tips, z.total_card_tips, z.total_cash_tips) == (Decimal("17.00"), Decimal("12.00"), Decimal("5.00"))
        assert z.total_card_sales == Decimal("100.00")
        # opening 100 + cash takings 50 + cash tip 5: the terminal's tip is not in the drawer.
        assert z.expected_cash == Decimal("155.00")

    def test_the_tips_report_gives_it_to_the_waiter_by_card(self, w):
        self._shift(w)
        report = build_tips_report(w.db, w.shop)
        assert report.total_tips == Decimal("17.00")
        assert (report.total_card_tips, report.total_cash_tips) == (Decimal("12.00"), Decimal("5.00"))
        mine = next(c for c in report.cashiers if c.cashier_id == WAITER)
        assert (mine.tips_collected, mine.card_tips, mine.cash_tips) == (Decimal("12.00"), Decimal("12.00"), Decimal("0"))
        assert mine.transaction_count == 1

    def test_the_events_report_counts_it_once_beside_the_sales(self, w):
        till, _shift = self._shift(w)
        body = ReportEventCreate(
            shopId=w.shop.id, name="ערב", startDate="2026-09-27", startTime="18:00",
            endDate="2026-09-27", endTime="23:00", machineIds=[till.id],
        )
        out = R.create_report_event(body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        from app.models.report_event import ReportEvent

        event = w.db.query(ReportEvent).filter(ReportEvent.id == uuid.UUID(out["id"])).one()
        w.db.expire_all()
        k = build_report(w.db, event)["kpis"]
        assert k["tips"] == 17.0
        assert (k["cash"], k["card"]) == (50.0, 100.0)
        assert k["sales"] == 150.0
