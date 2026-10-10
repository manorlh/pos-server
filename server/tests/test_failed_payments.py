"""
"עסקאות שלא הושלמו" — failed payment attempts (docs/SPEC_FAILED_PAYMENTS.md).

What each class pins:

* **Sync** — `POST /sync/{m}/failed-payments` is an idempotent upsert by the till's id:
  201 accepted → 200 duplicate → 200 updated (the link to the paying sale); an older
  `updatedAt` never clobbers a newer row; another till's id is a 409; a till with no shop
  is a 409; of the card only the last four digits (exactly 4) and the brand are kept; a
  training till's attempt never reaches the real table.
* **Report** — `GET /failed-payments`: the shift filter, the Z filter (every shift / till /
  window it covers, and one till of it), the summary (payouts apart, paid later), the
  cancelled sales no attempt accounts for, labels, and who sees what.
* **Z paper** — the cloud Z's print document gets "עסקאות שלא הושלמו" / "מכירות שבוטלו"
  after every fiscal block; nothing fiscal changes; nothing when there is nothing.
* **Wiring** — the routes are mounted, the till parameter is registered, the migration is
  on the single head.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import copy
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response

from app.models.failed_payment import FailedPaymentAttempt
from app.models.shift import ShiftStatus
from app.models.training import TrainingDocument
from app.models.transaction import TransactionStatus
from app.models.z_report import ZReport
from app.routers import failed_payments as R
from app.routers import sync as sync_router
from app.routers import z_reports as zr_router
from app.schemas.failed_payment import FailedPaymentIn
from app.services import failed_payments as svc
from app.services import z_print
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, refused, w  # noqa: F401

FROM, TO = date(2026, 9, 1), date(2026, 9, 30)


# ── helpers ──────────────────────────────────────────────────────────────────


def body(**over) -> dict:
    base = {
        "id": str(uuid.uuid4()),
        "occurredAt": NOW.isoformat(),
        "resolvedAt": (NOW + timedelta(seconds=40)).isoformat(),
        "shiftId": None,
        "businessDate": TODAY.isoformat(),
        "posUserId": "pu-1",
        "employeeName": "דנה",
        "amountAgorot": 14000,
        "method": "card",
        "kind": "sale",
        "channel": "till",
        "terminalType": "agamento",
        "terminalId": "0882001",
        "outcome": "declined",
        "reasonCode": "003",
        "reasonMessage": "התקשר לחברת האשראי",
        "cardBrand": "visa",
        "cardLast4": "1234",
        "lineCount": 3,
        "vuid": "V-1",
        "transactionId": None,
        "paidByTransactionId": None,
        "paidByMethod": None,
        "paidAt": None,
        "updatedAt": (NOW + timedelta(seconds=40)).isoformat(),
    }
    base.update(over)
    return base


def push(w, till, payload: dict):
    response = Response()
    out = R.post_failed_payment(
        str(till.id), FailedPaymentIn.model_validate(payload), response, machine=till, db=w.db
    )
    return response.status_code, out


def attempt(w, till, **over) -> FailedPaymentAttempt:
    code, out = push(w, till, body(**over))
    assert code == 201, out
    return w.db.get(FailedPaymentAttempt, out.id)


def listed(w, user=None, **filters):
    args = dict(
        machine_id=None, shop_id=None, shift_id=None, z_report_id=None, from_date=None, to_date=None,
        outcome=None, card_last4=None, page=1, page_size=50,
    )
    args.update(filters)
    return R.list_failed_payments(**args, **_ctx(w, user))


def cancelled_sale(w, till, shift=None, total="79.00", basket=None, **kw):
    tx = w.doc(till, shift, total, status=TransactionStatus.CANCELLED, method="card", **kw)
    tx.basket_id = basket
    w.db.commit()
    return tx


def z_of(w, tills, shifts, *, seq=1, origin="cloud", machine=None) -> ZReport:
    sections = [
        {
            "machineId": str(t.id),
            "machineName": t.name,
            "posNumber": t.pos_number,
            "shiftCount": 1,
            "totalSales": "100.00",
            "netSales": "100.00",
            "totalRefunds": "0.00",
            "totalCash": "100.00",
            "totalCard": "0.00",
            "expectedCash": "200.00",
            "overShort": "0.00",
            "uncountedShiftCount": 0,
        }
        for t in tills
    ]
    z = ZReport(
        id=uuid.uuid4(),
        tenant_id=w.tenant.id,
        shop_id=w.shop.id,
        origin=origin,
        machine_id=machine.id if machine is not None else None,
        machine_sequence_number=seq if origin == "till" else None,
        shop_sequence_number=seq if origin != "till" else None,
        business_date=TODAY,
        closed_at=NOW + timedelta(hours=1),
        period_start=NOW - timedelta(hours=10),
        period_end=NOW + timedelta(minutes=30),
        shift_count=len(shifts),
        machine_count=len(tills),
        total_sales=Decimal("100.00"),
        total_refunds=Decimal("0.00"),
        discounts_total=Decimal("0.00"),
        vat_total=Decimal("15.25"),
        total_cash_sales=Decimal("100.00"),
        total_card_sales=Decimal("0.00"),
        transactions_count=1,
        per_machine=sections,
    )
    w.db.add(z)
    w.db.flush()
    for s in shifts:
        s.z_report_id = z.id
    w.db.commit()
    return z


def section_of(doc, title):
    return next((s for s in doc["sections"] if s["title"] == title), None)


# ── Sync ─────────────────────────────────────────────────────────────────────


class TestSync:
    def test_accepted_then_duplicate_then_updated_with_the_link(self, w):
        till = w.tills[0]
        payload = body()
        code, out = push(w, till, payload)
        assert (code, out.status) == (201, "accepted")
        row = w.db.get(FailedPaymentAttempt, out.id)
        assert row.machine_id == till.id and row.shop_id == w.shop.id and row.tenant_id == w.tenant.id
        assert row.company_id == w.company.id
        assert row.amount_agorot == 14000 and row.outcome == "declined" and row.card_last4 == "1234"

        code, out = push(w, till, payload)
        assert (code, out.status) == (200, "duplicate")

        sale = w.doc(till, None, "140.00", method="cash")
        w.db.commit()
        linked = dict(
            payload,
            paidByTransactionId=str(sale.id),
            paidByMethod="cash",
            paidAt=(NOW + timedelta(minutes=2)).isoformat(),
            updatedAt=(NOW + timedelta(minutes=2)).isoformat(),
        )
        code, out = push(w, till, linked)
        assert (code, out.status) == (200, "updated")
        w.db.expire_all()
        row = w.db.get(FailedPaymentAttempt, out.id)
        assert row.paid_by_transaction_id == sale.id and row.paid_by_method == "cash"
        assert w.db.query(FailedPaymentAttempt).count() == 1

    def test_an_older_resend_never_clobbers_a_newer_link(self, w):
        till = w.tills[0]
        payload = body()
        push(w, till, payload)
        newer = dict(
            payload, paidByTransactionId=str(uuid.uuid4()), paidByMethod="card",
            updatedAt=(NOW + timedelta(minutes=5)).isoformat(),
        )
        assert push(w, till, newer)[1].status == "updated"
        # The first version again, still in the outbox: older — nothing applied.
        code, out = push(w, till, payload)
        assert (code, out.status) == (200, "duplicate")
        w.db.expire_all()
        row = w.db.get(FailedPaymentAttempt, out.id)
        assert row.paid_by_method == "card" and row.paid_by_transaction_id is not None

    def test_another_tills_id_is_a_conflict(self, w):
        payload = body()
        push(w, w.tills[0], payload)
        e = refused(push, w, w.tills[1], payload)
        assert e.status_code == 409 and e.detail == "failed_payment_id_conflict"
        assert w.db.get(FailedPaymentAttempt, uuid.UUID(payload["id"])).machine_id == w.tills[0].id

    def test_a_till_with_no_shop_is_refused(self, w):
        till = w.tills[1]
        till.shop_id = None
        w.db.commit()
        e = refused(push, w, till, body())
        assert e.status_code == 409 and e.detail == "machine_not_assigned"

    @pytest.mark.parametrize(
        "sent, kept",
        [("1234", "1234"), ("12345", None), ("4580123412341234", None), ("12a4", None), ("", None), (None, None),
         (" 0042 ", "0042")],
    )
    def test_only_the_last_four_digits_are_kept(self, w, sent, kept):
        row = attempt(w, w.tills[0], cardLast4=sent)
        assert row.card_last4 == kept

    def test_reason_is_cut_brand_normalised_and_unknown_fields_ignored(self, w):
        row = attempt(
            w, w.tills[0], reasonMessage="x" * 500, cardBrand="VISA", track2="4580123412341234=2512",
            pan="4580123412341234",
        )
        assert len(row.reason_message) == 300 and row.card_brand == "visa"
        assert attempt(w, w.tills[0], cardBrand="unionpay").card_brand == "other"
        # Nothing of the card but the last four and the brand is a column at all.
        columns = set(FailedPaymentAttempt.__table__.columns.keys())
        assert not {"pan", "track2", "card_number", "expiry"} & columns

    def test_a_bad_outcome_or_amount_is_a_422(self, w):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            FailedPaymentIn.model_validate(body(outcome="Declined!"))
        with pytest.raises(ValidationError):
            FailedPaymentIn.model_validate(body(amountAgorot=-5))

    def test_a_training_attempt_is_quarantined_and_answered_like_a_real_one(self, w):
        w.shop.training_mode = True
        w.db.commit()
        code, out = push(w, w.tills[0], body(training=True))
        assert (code, out.status) == (201, "accepted")
        assert w.db.query(FailedPaymentAttempt).count() == 0
        assert w.db.query(TrainingDocument).filter(TrainingDocument.kind == "other").count() == 1

    def test_an_attempt_of_a_training_shift_is_quarantined_without_the_flag(self, w):
        from app.services import training_mode as TM

        w.shop.training_mode = True
        till = w.tills[0]
        shift_id = uuid.uuid4()
        TM.store(w.db, till, w.shop, "shift", shift_id, {"open": {}})
        w.db.commit()
        code, out = push(w, till, body(shiftId=str(shift_id)))
        assert code == 201 and w.db.query(FailedPaymentAttempt).count() == 0
        # A real attempt in a training shop (the till has not switched yet) stays real.
        code, out = push(w, till, body())
        assert code == 201 and w.db.query(FailedPaymentAttempt).count() == 1


# ── Report ───────────────────────────────────────────────────────────────────


class TestReport:
    def test_the_shift_filter(self, w):
        till = w.tills[0]
        a, b = w.shift(till, 1), w.shift(till, 2)
        attempt(w, till, shiftId=str(a.id))
        attempt(w, till, shiftId=str(a.id), outcome="no_answer", amountAgorot=5000)
        attempt(w, till, shiftId=str(b.id))
        out = listed(w, shift_id=a.id)
        assert out.total == 2 and {i.shift_id for i in out.items} == {a.id}
        assert out.summary.count == 2 and out.summary.total_agorot == 19000
        # A shift has no default window: an attempt of last year still shows.
        old = attempt(w, till, shiftId=str(b.id), occurredAt=(NOW - timedelta(days=400)).isoformat())
        assert old.id in {i.id for i in listed(w, shift_id=b.id).items}

    def test_the_summary_counts_payouts_apart_and_the_ones_paid_later(self, w):
        till = w.tills[0]
        s = w.shift(till, 1)
        attempt(w, till, shiftId=str(s.id), amountAgorot=14000, paidByTransactionId=str(uuid.uuid4()), paidByMethod="cash")
        attempt(w, till, shiftId=str(s.id), amountAgorot=2500, kind="keyed")
        attempt(w, till, shiftId=str(s.id), amountAgorot=7000, kind="payout", outcome="terminal_error")
        summary = listed(w, shift_id=s.id).summary
        assert (summary.count, summary.total_agorot) == (2, 16500)
        assert (summary.payout_count, summary.payout_total_agorot) == (1, 7000)
        assert summary.paid_later_count == 1

    def test_the_z_filter_covers_its_shifts_tills_and_window(self, w):
        t1, t2 = w.tills
        s1, s2 = w.shift(t1, 1), w.shift(t2, 1)
        later = w.shift(t1, 2)  # not in the Z
        z = z_of(w, [t1, t2], [s1, s2])
        in1 = attempt(w, t1, shiftId=str(s1.id))
        in2 = attempt(w, t2, shiftId=str(s2.id), amountAgorot=900)
        no_shift = attempt(w, t2, shiftId=None, occurredAt=(NOW - timedelta(hours=1)).isoformat())
        attempt(w, t1, shiftId=str(later.id))
        attempt(w, t2, shiftId=None, occurredAt=(NOW + timedelta(days=2)).isoformat())  # outside the window
        attempt(w, w.other_till, shiftId=None, occurredAt=NOW.isoformat())  # another shop's till

        out = listed(w, z_report_id=z.id)
        assert {i.id for i in out.items} == {in1.id, in2.id, no_shift.id}
        # Each item says which till, so a shop Z groups per till.
        by_id = {i.id: i for i in out.items}
        assert by_id[in2.id].machine_name == t2.name and by_id[in2.id].pos_number == t2.pos_number
        assert by_id[in1.id].shop_name == w.shop.name
        # One till of the Z.
        per_till = listed(w, z_report_id=z.id, machine_id=t2.id)
        assert {i.id for i in per_till.items} == {in2.id, no_shift.id}

    def test_an_unknown_z_is_404(self, w):
        e = refused(listed, w, z_report_id=uuid.uuid4())
        assert e.status_code == 404

    def test_items_carry_the_voided_and_the_paying_document_numbers(self, w):
        till = w.tills[0]
        s = w.shift(till, 1)
        voided = cancelled_sale(w, till, s, total="140.00", number="57")
        paying = w.doc(till, s, "140.00", method="cash", number="58")
        w.db.commit()
        attempt(
            w, till, shiftId=str(s.id), transactionId=str(voided.id),
            paidByTransactionId=str(paying.id), paidByMethod="cash",
        )
        item = listed(w, shift_id=s.id).items[0]
        assert item.transaction_number == "57" and item.paid_by_transaction_number == "58"
        assert item.employee_name == "דנה" and item.reason_code == "003" and item.line_count == 3

    def test_cancelled_sales_leave_out_what_an_attempt_accounts_for(self, w):
        till = w.tills[0]
        s = w.shift(till, 1)
        basket, paid_basket = uuid.uuid4(), uuid.uuid4()
        voided = cancelled_sale(w, till, s, total="140.00", basket=basket)
        same_basket = cancelled_sale(w, till, s, total="20.00", basket=basket)
        paying = w.doc(till, s, "140.00", method="cash")
        paying.basket_id = paid_basket
        in_paid_basket = cancelled_sale(w, till, s, total="5.00", basket=paid_basket)
        alone = cancelled_sale(w, till, s, total="79.00")
        completed = w.doc(till, s, "30.00")  # a real sale: never listed here
        w.db.commit()
        attempt(w, till, shiftId=str(s.id), transactionId=str(voided.id), paidByTransactionId=str(paying.id))

        block = listed(w, shift_id=s.id).cancelled_sales
        assert [i.id for i in block.items] == [alone.id]
        assert (block.count, block.total_agorot) == (1, 7900)
        assert block.items[0].total_amount == 79.0 and block.items[0].pos_number == till.pos_number
        assert {same_basket.id, in_paid_basket.id, completed.id}.isdisjoint({i.id for i in block.items})

    def test_cancelled_sales_follow_the_z_and_its_tills(self, w):
        t1, t2 = w.tills
        s1, s2 = w.shift(t1, 1), w.shift(t2, 1)
        z = z_of(w, [t1, t2], [s1, s2])
        a = cancelled_sale(w, t1, s1)
        b = cancelled_sale(w, t2, s2, total="12.50")
        cancelled_sale(w, t1, w.shift(t1, 2))  # a shift after the Z
        assert {i.id for i in listed(w, z_report_id=z.id).cancelled_sales.items} == {a.id, b.id}
        assert listed(w, z_report_id=z.id).cancelled_sales.total_agorot == 7900 + 1250
        assert {i.id for i in listed(w, z_report_id=z.id, machine_id=t2.id).cancelled_sales.items} == {b.id}

    def test_dates_and_outcome(self, w):
        till = w.tills[0]
        attempt(w, till, outcome="declined")
        attempt(w, till, outcome="card_locked")
        attempt(w, till, occurredAt=datetime(2026, 8, 1, 10, tzinfo=timezone.utc).isoformat())
        assert listed(w, from_date=FROM, to_date=TO).total == 2
        assert listed(w, from_date=FROM, to_date=TO, outcome="card_locked").total == 1
        assert listed(w, from_date=date(2026, 8, 1), to_date=date(2026, 8, 1)).total == 1

    def test_the_default_window_is_the_last_30_days(self):
        start, end = svc.Filters().window(today=date(2026, 10, 7))
        assert start == datetime(2026, 9, 7, tzinfo=timezone.utc) and end is None
        assert svc.Filters(shift_id=uuid.uuid4()).window() == (None, None)

    def test_who_sees_what(self, w):
        attempt(w, w.tills[0])
        attempt(w, w.other_till)
        assert listed(w, from_date=FROM, to_date=TO).total == 2  # the super admin
        assert listed(w, w.manager, from_date=FROM, to_date=TO).total == 1
        assert listed(w, w.north_manager, from_date=FROM, to_date=TO).items[0].machine_id == w.other_till.id
        # A cashier sees what they see on the transactions: their shop.
        assert listed(w, w.cashier, from_date=FROM, to_date=TO).total == 1
        assert listed(w, w.company_manager, from_date=FROM, to_date=TO).total == 2

    def test_another_tenant_sees_nothing(self, w):
        attempt(w, w.tills[0])
        out = R.list_failed_payments(
            machine_id=None, shop_id=None, shift_id=None, z_report_id=None, from_date=FROM, to_date=TO,
            outcome=None, card_last4=None, page=1, page_size=50,
            current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db,
        )
        assert out.total == 0 and out.cancelled_sales.count == 0

    def test_the_wire_is_camel_case(self, w):
        attempt(w, w.tills[0])
        dumped = listed(w, from_date=FROM, to_date=TO).model_dump(by_alias=True, mode="json")
        assert {"page", "pageSize", "total", "summary", "items", "cancelledSales"} <= set(dumped)
        assert {
            "count", "totalAgorot", "payoutCount", "payoutTotalAgorot", "paidLaterCount",
            # "לא הוכרע" / "אושר בבדיקה" counted apart (tests/test_card_attempt_commands.py).
            "unresolvedCount", "unresolvedTotalAgorot", "approvedLateCount",
        } == set(dumped["summary"])
        item = dumped["items"][0]
        assert item["amountAgorot"] == 14000 and item["cardLast4"] == "1234" and item["machineName"]


# ── Z paper ──────────────────────────────────────────────────────────────────


class TestZPrint:
    def _setup(self, w):
        t1, t2 = w.tills
        s1, s2 = w.shift(t1, 1), w.shift(t2, 1)
        z = z_of(w, [t1, t2], [s1, s2])
        return t1, t2, s1, s2, z

    def test_a_tills_detail_lists_its_attempts_informational_only(self, w):
        t1, t2, s1, s2, z = self._setup(w)
        attempt(
            w, t1, shiftId=str(s1.id), paidByTransactionId=str(uuid.uuid4()), paidByMethod="cash",
        )
        attempt(w, t1, shiftId=str(s1.id), amountAgorot=7000, kind="payout", outcome="terminal_error")
        attempt(w, t2, shiftId=str(s2.id), amountAgorot=999)  # the other till: not on this one's paper
        voided_elsewhere = cancelled_sale(w, t1, s1, total="79.00", number="61")

        doc = sync_router.get_own_shop_z_print_document(
            str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=w.db
        )
        failed = section_of(doc, "עסקאות שלא הושלמו")
        assert failed["key"] == "failed_payments" and failed["informational"] is True
        rows = [(r["label"], r["value"]) for r in failed["rows"]]
        assert rows[0] == ("מידע בלבד — לא נכלל בסה״כ המכירות", "")
        assert rows[1] == ("מספר / סה״כ", "1 / ₪140.00")
        # 18:00 UTC = 21:00 in Israel.
        assert rows[2] == ("21:00 · אשראי · נדחתה · ****1234", "₪140.00")
        assert rows[3] == ("  שולם בהמשך במזומן", "")
        assert rows[4] == ("זיכויים שלא הושלמו", "1 / ₪70.00")
        cancelled = section_of(doc, "מכירות שבוטלו")
        assert cancelled["key"] == "cancelled_sales"
        assert [(r["label"], r["value"]) for r in cancelled["rows"]] == [
            ("מספר / סה״כ", "1 / ₪79.00"),
            (f"21:00 · {voided_elsewhere.transaction_number}", "₪79.00"),
        ]

    def test_nothing_fiscal_changes_and_the_sections_come_last(self, w):
        t1, _t2, s1, _s2, z = self._setup(w)
        attempt(w, t1, shiftId=str(s1.id))
        tz = __import__("zoneinfo").ZoneInfo("Asia/Jerusalem")
        plain = z_print.build_till_document(z, t1.id, tz)
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=w.db)
        assert doc["sections"][: len(plain["sections"])] == plain["sections"]
        assert [s["title"] for s in doc["sections"][len(plain["sections"]):]] == ["עסקאות שלא הושלמו"]
        assert (doc["subtitle"][1:], doc["number"]) == (plain["subtitle"][1:], plain["number"])
        w.db.refresh(z)
        assert z.total_sales == Decimal("100.00") and z.transactions_count == 1

    def test_no_attempts_no_section(self, w):
        t1, _t2, _s1, _s2, z = self._setup(w)
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=w.db)
        titles = [s["title"] for s in doc["sections"]]
        assert "עסקאות שלא הושלמו" not in titles and "מכירות שבוטלו" not in titles

    def test_a_shop_z_over_several_tills_has_one_line_per_till(self, w):
        t1, t2, s1, s2, z = self._setup(w)
        attempt(w, t1, shiftId=str(s1.id))
        attempt(w, t2, shiftId=str(s2.id), amountAgorot=5000)
        attempt(w, t2, shiftId=str(s2.id), amountAgorot=2500)
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, machine=t1, db=w.db)
        rows = [(r["label"], r["value"]) for r in section_of(doc, "עסקאות שלא הושלמו")["rows"]]
        assert rows[1:] == [
            ("מספר / סה״כ", "3 / ₪215.00"),
            (f"קופה {t1.pos_number}", "1 / ₪140.00"),
            (f"קופה {t2.pos_number}", "2 / ₪75.00"),
        ]
        # The summary part stays compact.
        summary = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part="summary", till=None, machine=t1, db=w.db)
        assert section_of(summary, "עסקאות שלא הושלמו") is None

    def test_a_till_z_and_the_dashboards_copy(self, w):
        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        z = z_of(w, [t1], [s1], origin="till", machine=t1, seq=4)
        attempt(w, t1, shiftId=str(s1.id), outcome="no_answer", cardLast4=None)
        doc = zr_router.get_z_print_document(z.id, **_ctx(w))
        rows = [(r["label"], r["value"]) for r in section_of(doc, "עסקאות שלא הושלמו")["rows"]]
        # Too wide for 80 mm on one line: the outcome goes on the next.
        assert rows[2] == ("21:00 · אשראי", "₪140.00")
        assert rows[3] == ("  אין תשובה מהמסוף — לא חויב", "")

    def test_the_section_never_fails_the_print(self, w, monkeypatch):
        t1, _t2, s1, _s2, z = self._setup(w)
        attempt(w, t1, shiftId=str(s1.id))

        def boom(*a, **k):
            raise RuntimeError("db down")

        monkeypatch.setattr(svc, "print_sections", boom)
        doc = sync_router.get_own_shop_z_print_document(str(t1.id), z.id, part=None, till=t1.id, machine=t1, db=w.db)
        assert section_of(doc, "מכירות") is not None and section_of(doc, "עסקאות שלא הושלמו") is None


# ── Wiring ───────────────────────────────────────────────────────────────────


def test_the_till_parameter_is_registered():
    from app.services.till_parameters import BUILTIN_PARAMETERS

    # Off by default since 09.10.2026 (test_failed_payments_print_parameter.py); the old switch is retired.
    p = next(p for p in BUILTIN_PARAMETERS if p.key == "printFailedPaymentsWithReports")
    assert p.value_type == "boolean" and p.default_value is False
    assert p.label == "הדפסת עסקאות שלא הושלמו בדוח משמרת / Z"
    assert "printFailedPayments" not in {p.key for p in BUILTIN_PARAMETERS}


def test_the_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    assert ("POST", "/api/v1/sync/{machine_id}/failed-payments") in mounted
    assert ("GET", "/api/v1/failed-payments") in mounted


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
    assert "5d9e1f3a7c62" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("5d9e1f3a7c62").down_revision == "a4c8e2f6b9d3"
