"""
"התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — our Z-Credit card legs against the
terminal's own transactions report, transaction by transaction, and the deposits.

**Only a fake gateway.** Every test here reads `FakeReports`, built from the response examples
Z-Credit documents (tests/fixtures/zcredit_reports/); the real client refuses to be built inside a
test run, and the terminals and passwords below are made up.

What each class pins:

* **The API, read as documented** — the report rows and deposits parsed from the documented
  examples (the card cut to its last four, nothing personal kept), the bodies, our unique id.
* **Read-only** — no write call exists in the reports client; the service never builds the
  refund gateway.
* **Matching** — by reference, else by our `TransactionUniqueID` through a status query; every
  category: matched, amount, status (both ways), Z-Credit only, ours only, duplicate, deposit
  (both ways); the day's margins; what is not compared (another terminal, no money, a J5, a void).
* **A run** — stored with totals per category; every ❌ an exception, once; "טופל" carried to a
  rerun and closing the exception; Z-Credit unreadable → a failed run, nothing compared.
* **Terminals** — tills sharing a terminal are one run, a till's own terminal another; a
  terminal is read whole even from a manager's narrower scope.
* **Nightly** — once per terminal for yesterday after its time; the parameter; retries.
* **Deposits** — Z-Credit's deposit against our transmission of that batch and its legs.
* **Routes** — scope, masking (the terminal's last four only), filters, run now, handle, badge.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import inspect
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.card_transmission import CardTransmission
from app.models.cloud_card_refund import CloudCardRefund
from app.models.transaction import TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.zcredit_reconciliation import ZCreditReconItem, ZCreditReconRun
from app.routers import zcredit_reconciliation as R
from app.services import payment_secrets as PS
from app.services import zcredit_gateway as zg
from app.services import zcredit_recon_match as MATCH
from app.services import zcredit_reconcile as svc
from app.services import zcredit_reconcile_worker as worker
from app.services import zcredit_reports as zr
from shift_world import NOW, TODAY
from test_remote_credits import credit_note, open_shift, sale
from test_shop_areas import _ctx, w  # noqa: F401

FIXTURES = Path(__file__).parent / "fixtures" / "zcredit_reports"
REPORT_EXAMPLE = json.loads((FIXTURES / "transactions_report_example.json").read_text(encoding="utf-8"))
DEPOSIT_EXAMPLE = json.loads((FIXTURES / "deposit_report_example.json").read_text(encoding="utf-8"))

#: Made-up terminals and passwords — never a real terminal's.
SHOP_TERMINAL = "0990000101"
TILL_TERMINAL = "0990000202"
SHOP_PW = "fake-recon-shop-pw"
TILL_PW = "fake-recon-till-pw"
#: NOW is 21:00 in Israel (UTC+3 on 27.09.2026).
LOCAL_NOW = datetime(2026, 9, 27, 21, 0, 0)


# ── The fake gateway ─────────────────────────────────────────────────────────


def zrow(ref, amount, *, status=1, deal="01", at=LOCAL_NOW, card="4580", deposit=None, j=0):
    """A report row: the documented example with this transaction's own fields."""
    row = dict(REPORT_EXAMPLE["Transactions"][0])
    row.update(
        ReferenceNumber=ref, TransactionSum=amount, StatusCode=status, DealTypeCode=deal,
        SaveDate=at.strftime("%Y-%m-%dT%H:%M:%S"), CardNumber=card, DepositID=deposit or "00000000", J=j,
    )
    return row


def zdeposit(ref, debit, credit=0, count=1):
    d = dict(DEPOSIT_EXAMPLE["Data"][0])
    d.update(ReferenceNumber=ref, TotalDebit=debit, TotalCredit=credit, TotalNumber=count)
    return d


class FakeReports:
    """
    Z-Credit's reports as lists: `rows` (report rows, filtered by the asked window as the gateway
    would), `deposits`, and the status queries' answers by reference / by our unique id.
    """

    def __init__(self, rows=(), deposits=()):
        self.rows = list(rows)
        self.deposits = list(deposits)
        self.by_ref = {}
        self.by_unique = {}
        self.calls = []
        self.report_body = None
        self.down = False

    def transactions_report(self, credentials, start, end):
        self.calls.append(("report", credentials.terminal_number, credentials.password, start, end))
        if self.down:
            raise zg.GatewayError("connect refused", maybe_sent=False)
        if self.report_body is not None:
            return zr.parse_transactions_report(json.dumps(self.report_body))
        rows = [r for r in self.rows if start <= datetime.fromisoformat(r["SaveDate"]) <= end]
        return zr.parse_transactions_report(json.dumps(
            {"HasError": False, "ReturnCode": 0, "ReturnMessage": "", "Transactions": rows}
        ))

    def deposit_report(self, credentials, start, end):
        self.calls.append(("deposits", credentials.terminal_number, start, end))
        return zr.parse_deposit_report(json.dumps({"HasError": False, "ReturnCode": 0, "ReturnMessage": "", "Data": self.deposits}))

    def _answer(self, row):
        if row is None:
            return zr.parse_lookup(json.dumps({"HasError": True, "ReturnCode": -80, "ReturnMessage": "Transaction was not found"}))
        return zr.parse_lookup(json.dumps({**row, "HasError": False, "ReturnCode": 0, "ReturnMessage": ""}))

    def status_by_reference(self, credentials, reference):
        self.calls.append(("status_ref", reference))
        return self._answer(self.by_ref.get(reference))

    def status_by_unique_id(self, credentials, unique_id):
        self.calls.append(("status_unique", unique_id))
        return self._answer(self.by_unique.get(unique_id))


# ── The world ────────────────────────────────────────────────────────────────


def zmeta(reference, *, last4="4580", vuid="17"):
    """A Z-Credit card leg's reply as the till stores it (pos-android cardSaleMeta + toAshraitJson)."""
    result = {"provider": "zcredit", "statusCode": 0, "issuerAuthNum": "0123456", "cardNumber": "************" + last4}
    if reference:
        result.update(uid=reference, transactionId=reference, zcreditReferenceNumber=reference)
    meta = {"vuid": vuid, "authNum": "0123456", "cardLast4": last4, "outcome": "approved", "result": result}
    if reference:
        meta["uid"] = reference
    return meta


def card_sale(w, till, shift, amount, reference, *, at=None, last4="4580", vuid="17", status=TransactionStatus.COMPLETED, meta=None):
    tx = sale(w, till, shift, [("Beer", 1, amount)], legs=[("card", amount)], status=status)
    leg = w.db.query(TransactionPayment).filter_by(transaction_id=tx.id).one()
    leg.nayax_meta = meta if meta is not None else zmeta(reference, last4=last4, vuid=vuid)
    if at is not None:
        tx.created_at = at
    w.db.flush()
    return tx, leg


def utc(local):
    return (local - timedelta(hours=3)).replace(tzinfo=timezone.utc)


@pytest.fixture
def world(w, monkeypatch):
    """Center (Till 1, Till 2) charges on one Z-Credit terminal (the shop's layer); North does not."""
    w.shop.settings = {"paymentIntegration": "zcredit", "zcreditTerminalNumber": SHOP_TERMINAL}
    PS.apply_secret_patch(w.db, "shop", w.shop.id, {"zcreditPassword": SHOP_PW}, tenant_id=w.tenant.id)
    w.shift1 = open_shift(w, w.tills[0])
    w.shift2 = open_shift(w, w.tills[1])
    w.gw = FakeReports()
    monkeypatch.setattr(svc, "reports_factory", lambda: w.gw)
    w.db.commit()
    return w


def terminal(w):
    terminals, _ = svc.terminals_of(w.db, w.tenant.id)
    assert len(terminals) == 1
    return terminals[0]


def run(w, day=TODAY, now=None):
    out = svc.run_terminal(w.db, terminal(w), day, now=now or NOW + timedelta(hours=10))
    assert out.status == "done", (out.error_code, out.error_message)
    return out


def items(w, run_row):
    return w.db.query(ZCreditReconItem).filter_by(run_id=run_row.id).all()


def by_category(w, run_row):
    out = {}
    for i in items(w, run_row):
        out.setdefault(i.category, []).append(i)
    return out


# ── The API, read as documented ─────────────────────────────────────────────


class TestReadingTheReports:
    def test_the_documented_report_example_is_read_and_nothing_personal_is_kept(self):
        reply = zr.parse_transactions_report(json.dumps(REPORT_EXAMPLE))
        assert reply.ok and len(reply.transactions) == 1
        t = reply.transactions[0]
        assert (t.reference_number, t.amount_agorot, t.status_code, t.deal_type) == ("998877665", 1035, 2, "01")
        assert t.card_last4 == "0000" and t.card_brand_code == 2 and t.payments == 1 and t.j == 0
        assert t.save_date == datetime(2019, 3, 4, 21, 6, 37)
        # "00000000" is the gateway's "none".
        assert t.deposit_id is None and not t.is_refund
        for kept_out in ("token", "holder_id", "customer_name", "customer_email", "customer_phone", "exp_date"):
            assert not hasattr(t, kept_out)

    def test_a_full_card_number_is_cut_to_its_last_four_and_the_lowercase_deposit_id_is_read(self):
        raw = dict(REPORT_EXAMPLE["Transactions"][0], CardNumber="4580123412341234", DealTypeCode="51")
        raw.pop("DepositID")
        raw["DepositId"] = 4411
        t = zr.parse_report_transaction(raw)
        assert t.card_last4 == "1234" and t.deposit_id == "4411" and t.is_refund

    def test_the_documented_deposit_example_is_agorot(self):
        reply = zr.parse_deposit_report(json.dumps(DEPOSIT_EXAMPLE))
        d = reply.deposits[0]
        assert reply.ok and (d.debit_agorot, d.credit_agorot, d.count, d.net_agorot) == (1035, 0, 1, 1035)

    def test_an_error_reply_and_garbage(self):
        r = zr.parse_transactions_report('{"HasError": true, "ReturnCode": -3, "ReturnMessage": "bad"}')
        assert not r.ok and r.return_code == -3 and r.transactions == []
        assert zr.parse_transactions_report("<html>") is None
        assert zr.parse_lookup('{"HasError": true, "ReturnCode": -80}').not_found

    def test_the_bodies(self):
        creds = zg.Credentials("0990000101", SHOP_PW)
        body = zr.transactions_report_body(creds, datetime(2026, 9, 26, 23, 30), datetime(2026, 9, 28, 0, 30))
        assert body["FromDate"] == "2026-09-26 23:30:00" and body["ToDate"] == "2026-09-28 00:30:00"
        assert body["IncludeJ5"] is False and body["SearchType"] == 0
        dep = zr.deposit_report_body(creds, datetime(2026, 9, 27), datetime(2026, 9, 28, 12))
        assert dep["DepositID"] == -1 and dep["FromDate"] == "2026-09-27 00:00:00"
        assert zr.status_by_unique_id_body(creds, " R2M-x-1 ")["UniqueQuery"] == "R2M-x-1"
        with pytest.raises(ValueError):
            zr.transactions_report_body(creds, datetime(2026, 9, 28), datetime(2026, 9, 27))

    def test_our_unique_id_is_the_tills(self):
        # pos-android zcreditUniqueId: "R2M-" + the first 12 letters/digits of the machine id + "-" + vuid.
        mid = uuid.UUID("675ac8d2-1234-4abc-9def-001122334455")
        assert zr.unique_id_for(mid, "17") == "R2M-675ac8d21234-17"
        assert zr.unique_id_for(mid, None) is None


class TestReadOnly:
    def test_the_reports_client_has_no_write_call(self):
        source = inspect.getsource(zr)
        for write in (
            "/Transaction/RefundTransaction", "/Transaction/CommitFullTransaction", "/Terminal/DepositTerminal",
            "/Transaction/ReleasePinpad", "/Transaction/CompleteJ5Transaction", "REFUND_TRANSACTION", "refund_body",
        ):
            assert write not in source, write
        assert set(zr.READ_ONLY_PATHS) == {
            "/Reports/GetTransactionsReport", "/Terminal/GetDepositReport",
            "/Transaction/GetTransactionStatusByTransactionUniqueIdForQuery",
            "/Transaction/GetTransactionStatusByReferenceId",
        }

    def test_the_real_client_is_never_built_in_a_test(self):
        with pytest.raises(RuntimeError):
            zr.HttpZCreditReports()

    def test_the_service_never_refunds_voids_or_deposits(self):
        for module in (svc, MATCH, R):
            source = inspect.getsource(module)
            assert "HttpZCreditGateway" not in source and ".refund(" not in source and "gateway_factory" not in source


# ── Matching ─────────────────────────────────────────────────────────────────


class TestMatching:
    def test_the_same_reference_amount_and_status_is_matched(self, world):
        w = world
        tx, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00)]
        r = run(w)
        (item,) = items(w, r)
        assert item.category == "matched" and item.transaction_id == tx.id and item.zc_reference == "R-1"
        assert r.summary["matched"] == {"count": 1, "zcredit": 50.0, "ours": 50.0}
        assert w.db.query(AuditException).count() == 0

    def test_an_amount_mismatch(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 55.00)]
        (item,) = items(w, run(w))
        assert item.category == "amount_mismatch" and "₪55.00" in item.reason and "₪50.00" in item.reason

    def test_voided_at_zcredit_and_whole_in_ours_is_a_status_mismatch(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00, status=3)]
        (item,) = items(w, run(w))
        assert item.category == "status_mismatch" and "בוטלה" in item.reason

    def test_refunded_on_the_card_in_ours_and_whole_at_zcredit_is_a_status_mismatch(self, world):
        w = world
        tx, _ = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        from app.models.transaction_item import TransactionItem

        item_line = w.db.query(TransactionItem).filter_by(transaction_id=tx.id).one()
        note = credit_note(w, w.tills[0], w.shift1, tx, [(item_line, 1, "50.00")], method="card")
        note_leg = w.db.query(TransactionPayment).filter_by(transaction_id=note.id).one()
        note_leg.nayax_meta = zmeta("R-1-REF")
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=2), zrow("R-1-REF", 50.00, deal="51", status=2)]
        cats = by_category(w, run(w))
        (sale_item,) = cats["status_mismatch"]
        assert "זוכה באשראי במלואו" in sale_item.reason
        # The refund itself is the credit note's own transaction at Z-Credit.
        # (deposited at Z-Credit, not transmitted in ours: a deposit row of its own)
        assert [i.zc_reference for i in cats["deposit_mismatch"]] == ["R-1-REF"]

    def test_a_charge_at_zcredit_with_no_document_is_an_error_with_its_candidates(self, world):
        w = world
        tx, _ = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00), zrow("R-2", 50.00, at=LOCAL_NOW + timedelta(minutes=2))]
        cats = by_category(w, run(w))
        (orphan,) = cats["zcredit_only"]
        assert orphan.zc_reference == "R-2" and orphan.transaction_id is None
        # The same card and amount two minutes after a documented charge: a possible double charge.
        assert "חיוב כפול" in orphan.reason
        assert orphan.related[0]["transactionId"] == str(tx.id) and orphan.related[0]["kind"] == "documented_charge"

    def test_a_document_with_no_zcredit_transaction_is_an_error_after_a_status_query(self, world):
        w = world
        tx, _ = card_sale(w, w.tills[0], w.shift1, "50.00", "R-9")
        cats = by_category(w, run(w))
        (lost,) = cats["ours_only"]
        assert lost.transaction_id == tx.id and "לפי האסמכתא" in lost.reason
        assert ("status_ref", "R-9") in w.gw.calls

    def test_no_reference_is_matched_through_our_unique_id(self, world):
        w = world
        till = w.tills[0]
        tx, leg = card_sale(w, till, w.shift1, "50.00", None, vuid="31")
        uid = zr.unique_id_for(till.id, "31")
        w.gw.rows = [zrow("R-7", 50.00)]
        w.gw.by_unique[uid] = zrow("R-7", 50.00)
        (item,) = items(w, run(w))
        assert item.category == "matched" and item.payment_id == leg.id and item.zc_reference == "R-7"
        assert ("status_unique", uid) in w.gw.calls

    def test_a_transaction_missing_from_the_report_but_found_by_its_reference(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-5")
        w.gw.by_ref["R-5"] = zrow("R-5", 50.00)
        (item,) = items(w, run(w))
        assert item.category == "matched" and item.zc_source == "lookup" and "בשאילתה" in item.reason

    def test_one_reference_on_two_documents_is_a_duplicate(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        card_sale(w, w.tills[1], w.shift2, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00)]
        (item,) = items(w, run(w))
        assert item.category == "duplicate" and "2 מסמכים" in item.reason and len(item.related) == 1

    def test_a_reference_listed_twice_by_zcredit_is_a_duplicate(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00), zrow("R-1", 50.00)]
        (item,) = items(w, run(w))
        assert item.category == "duplicate" and "2 פעמים" in item.reason

    def test_deposited_at_zcredit_and_not_transmitted_in_ours(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00, status=2, deposit="777")]
        (item,) = items(w, run(w))
        assert item.category == "deposit_mismatch" and "הופקד ב-Z-Credit (הפקדה 777)" in item.reason

    def test_transmitted_in_ours_and_not_deposited_at_zcredit(self, world):
        w = world
        _, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        t = transmission(w, w.tills[0], "778")
        leg.transmission_id, leg.transmitted_batch = t.id, "778"
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=1)]
        (item,) = items(w, run(w))
        assert item.category == "deposit_mismatch" and "טרם הופקד" in item.reason

    def test_deposited_and_transmitted_in_the_same_batch_is_matched(self, world):
        w = world
        _, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        t = transmission(w, w.tills[0], "777")
        leg.transmission_id, leg.transmitted_batch = t.id, "777"
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=2, deposit="777")]
        (item,) = items(w, run(w))
        assert item.category == "matched"

    def test_across_midnight_and_the_next_days_margin(self, world):
        w = world
        # Ours at 23:59 on the 27th, saved by Z-Credit at 00:01 on the 28th: still one transaction.
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1", at=utc(datetime(2026, 9, 27, 23, 59)))
        w.gw.rows = [
            zrow("R-1", 50.00, at=datetime(2026, 9, 28, 0, 1)),
            # The next day's own charge, inside the margin only: the next run owns it.
            zrow("R-8", 20.00, at=datetime(2026, 9, 28, 0, 10)),
        ]
        (item,) = items(w, run(w))
        assert item.category == "matched" and item.zc_reference == "R-1"

    def test_what_is_not_compared(self, world):
        w = world
        # Another terminal's leg on the same till, a leg that moved no money, a cancelled sale with
        # nothing at Z-Credit (a void before the deposit leaves no row), a J5 hold.
        tx, other = card_sale(w, w.tills[0], w.shift1, "10.00", None,
                              meta={"vuid": "18", "uid": "A-555", "result": {"uid": "A-555", "mutag": 1}})
        _, no_money = card_sale(w, w.tills[0], w.shift1, "11.00", "R-NM")
        no_money.no_money_movement = True
        card_sale(w, w.tills[0], w.shift1, "12.00", "R-C", status=TransactionStatus.CANCELLED)
        w.gw.rows = [zrow("R-J5", 99.00, j=5)]
        w.db.flush()
        assert items(w, run(w)) == []

    def test_a_cloud_card_refund_at_zcredit_is_ours_before_its_credit_note_lands(self, world):
        w = world
        tx, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.db.add(CloudCardRefund(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, original_machine_id=w.tills[0].id,
            original_transaction_id=tx.id, original_payment_id=leg.id, original_leg_amount=Decimal("50.00"),
            terminal_number=SHOP_TERMINAL, original_reference="R-1", lines=[], amount=Decimal("50.00"),
            reason="x", target_machine_id=w.tills[0].id, status="refunded", refund_reference="R-1-CR",
            created_by_user_id=w.admin.id,
        ))
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=4), zrow("R-1-CR", 50.00, deal="51")]
        cats = by_category(w, run(w))
        assert "zcredit_only" not in cats and "status_mismatch" not in cats
        refund_item = next(i for i in cats["matched"] if i.zc_reference == "R-1-CR")
        assert "מהענן" in refund_item.reason and refund_item.related[0]["cloudCardRefundId"]


def transmission(w, till, batch):
    t = CardTransmission(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id, trigger="shift_close",
        started_at=NOW + timedelta(hours=1), status="success", batch_number=batch,
        transaction_count=1, amount=Decimal("50.00"), terminal_transaction_count=1,
    )
    w.db.add(t)
    w.db.flush()
    return t


# ── A run ────────────────────────────────────────────────────────────────────


class TestRun:
    def test_every_error_is_an_exception_once_and_a_rerun_keeps_one(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-9")
        w.gw.rows = [zrow("R-2", 30.00)]
        first = run(w)
        assert {i.category for i in items(w, first)} == {"zcredit_only", "ours_only"}
        exc = w.db.query(AuditException).filter_by(exception_type="zcredit_recon").all()
        assert len(exc) == 2 and all(e.severity == "high" for e in exc)
        assert {e.details["category"] for e in exc} == {"zcredit_only", "ours_only"}
        assert all(e.details["runId"] == str(first.id) and e.details["terminal"] == "••••0101" for e in exc)
        assert all(SHOP_TERMINAL not in json.dumps(e.details, ensure_ascii=False) for e in exc)
        run(w, now=NOW + timedelta(hours=11))
        assert w.db.query(AuditException).filter_by(exception_type="zcredit_recon").count() == 2

    def test_handled_is_carried_to_a_rerun_and_closes_the_exception(self, world):
        w = world
        w.gw.rows = [zrow("R-2", 30.00)]
        first = run(w)
        (item,) = items(w, first)
        svc.mark_handled(w.db, item, w.admin, "  זוכה בבק-אופיס של Z-Credit  ")
        ex = w.db.get(AuditException, item.exception_id)
        assert ex.status == "reviewed" and ex.review_note == "זוכה בבק-אופיס של Z-Credit"
        second = run(w, now=NOW + timedelta(hours=11))
        (again,) = items(w, second)
        assert again.handled_at is not None and again.handled_note == "זוכה בבק-אופיס של Z-Credit"
        svc.reopen(w.db, again)
        assert again.handled_at is None

    def test_zcredit_refusing_the_credentials_fails_the_run_and_compares_nothing(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-9")
        w.gw.report_body = {"HasError": True, "ReturnCode": -2, "ReturnMessage": "Invalid credentials"}
        out = svc.run_terminal(w.db, terminal(w), TODAY, now=NOW + timedelta(hours=10))
        assert out.status == "failed" and out.error_code == "credentials_refused"
        assert items(w, out) == [] and w.db.query(AuditException).count() == 0

    def test_zcredit_unreachable_fails_the_run(self, world):
        w = world
        w.gw.down = True
        out = svc.run_terminal(w.db, terminal(w), TODAY, now=NOW + timedelta(hours=10))
        assert out.status == "failed" and out.error_code == "gateway_unreachable"

    def test_the_run_reads_the_day_with_margins_and_the_deposits_until_the_next_noon(self, world):
        w = world
        run(w)
        report = next(c for c in w.gw.calls if c[0] == "report")
        assert report[1] == SHOP_TERMINAL and report[2] == SHOP_PW
        assert report[3] == datetime(2026, 9, 26, 23, 30) and report[4] == datetime(2026, 9, 28, 0, 30)
        deposits = next(c for c in w.gw.calls if c[0] == "deposits")
        assert deposits[2] == datetime(2026, 9, 27) and deposits[3] == datetime(2026, 9, 28, 12)

    def test_a_run_in_progress_is_not_started_twice_and_a_dead_one_is_closed(self, world):
        w = world
        t = terminal(w)
        stuck = ZCreditReconRun(
            id=uuid.uuid4(), tenant_id=w.tenant.id, terminal_number=t.number, terminal_key=t.key, terminal_last4=t.last4,
            business_date=TODAY, status="running", started_at=NOW + timedelta(hours=10), machine_ids=[], shop_ids=[],
            summary={}, deposits=[],
        )
        w.db.add(stuck)
        w.db.commit()
        assert svc.run_terminal(w.db, t, TODAY, now=NOW + timedelta(hours=10, minutes=1)).id == stuck.id
        fresh = svc.run_terminal(w.db, t, TODAY, now=NOW + timedelta(hours=11))
        assert fresh.id != stuck.id and fresh.status == "done"
        assert w.db.get(ZCreditReconRun, stuck.id).status == "failed"

    def test_the_lookups_are_bounded(self, world, monkeypatch):
        w = world
        monkeypatch.setattr(svc, "LOOKUP_MAX", 1)
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-90")
        card_sale(w, w.tills[0], w.shift1, "51.00", "R-91")
        cats = by_category(w, run(w))
        assert len(cats["ours_only"]) == 2
        assert sum(1 for c in w.gw.calls if c[0] == "status_ref") == 1
        assert any("מכסת השאילתות" in i.reason for i in cats["ours_only"])


# ── Terminals ────────────────────────────────────────────────────────────────


class TestTerminals:
    def test_tills_sharing_a_terminal_are_one_run_and_a_tills_own_terminal_another(self, world):
        w = world
        w.tills[1].settings = {"zcreditTerminalNumber": TILL_TERMINAL}
        PS.apply_secret_patch(w.db, "machine", w.tills[1].id, {"zcreditPassword": TILL_PW}, tenant_id=w.tenant.id)
        w.db.commit()
        terminals, problems = svc.terminals_of(w.db, w.tenant.id)
        by = {t.number: t for t in terminals}
        assert set(by) == {SHOP_TERMINAL, TILL_TERMINAL} and problems == []
        assert by[SHOP_TERMINAL].machine_ids == [w.tills[0].id] and by[TILL_TERMINAL].credentials.source == "machine"
        assert w.other_till.id not in by[SHOP_TERMINAL].machine_ids + by[TILL_TERMINAL].machine_ids

    def test_a_zcredit_till_without_a_password_is_a_problem_not_a_run(self, world):
        w = world
        PS.apply_secret_patch(w.db, "shop", w.shop.id, {"zcreditPassword": None}, tenant_id=w.tenant.id)
        w.db.commit()
        terminals, problems = svc.terminals_of(w.db, w.tenant.id)
        assert terminals == [] and {p.code for p in problems} == {"zcredit_password_missing"}

    def test_a_terminal_is_read_whole_from_a_narrower_scope(self, world):
        w = world
        card_sale(w, w.tills[1], w.shift2, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00)]
        runs, _ = svc.run_now(w.db, w.manager, w.tenant.id, [w.tills[0].id], TODAY, now=NOW + timedelta(hours=10))
        (only,) = runs
        assert set(only.machine_ids) == {str(w.tills[0].id), str(w.tills[1].id)}
        assert [i.category for i in items(w, only)] == ["matched"]


# ── Nightly ──────────────────────────────────────────────────────────────────


class TestNightly:
    def test_once_per_terminal_for_yesterday_after_its_time(self, world):
        w = world
        before = datetime(2026, 9, 28, 2, 59, tzinfo=timezone.utc)  # 05:59 in Israel
        assert svc.run_due(w.db, now=before) == 0
        after = datetime(2026, 9, 28, 3, 1, tzinfo=timezone.utc)
        assert svc.run_due(w.db, now=after) == 1
        (r,) = w.db.query(ZCreditReconRun).all()
        assert r.business_date == date(2026, 9, 27) and r.trigger == "nightly"
        assert svc.run_due(w.db, now=after + timedelta(minutes=5)) == 0

    def test_the_parameter_switches_it_off_and_sets_the_time(self, world, monkeypatch):
        w = world
        params = {svc.PARAM_ENABLED: False}
        monkeypatch.setattr(svc, "machine_schedule", lambda db, m: (params.get(svc.PARAM_ENABLED, True), params.get(svc.PARAM_TIME, "06:00")))
        assert svc.run_due(w.db, now=datetime(2026, 9, 28, 3, 1, tzinfo=timezone.utc)) == 0
        params.update({svc.PARAM_ENABLED: True, svc.PARAM_TIME: "07:30"})
        assert svc.run_due(w.db, now=datetime(2026, 9, 28, 4, 29, tzinfo=timezone.utc)) == 0
        assert svc.run_due(w.db, now=datetime(2026, 9, 28, 4, 31, tzinfo=timezone.utc)) == 1

    def test_the_parameters_defaults_and_the_time_is_checked(self, world):
        w = world
        assert svc.machine_schedule(w.db, w.tills[0]) == (True, "06:00")
        from app.services.till_parameters import BUILTIN_PARAMETERS, TillParameterValueError, validate_keyed_value

        specs = {p.key: p for p in BUILTIN_PARAMETERS}
        assert specs[svc.PARAM_ENABLED].default_value is True and specs[svc.PARAM_TIME].default_value == "06:00"
        assert validate_keyed_value(svc.PARAM_TIME, "07:30") == "07:30"
        with pytest.raises(TillParameterValueError):
            validate_keyed_value(svc.PARAM_TIME, "25:00")

    def test_an_unreadable_zcredit_is_tried_again_up_to_three_times(self, world):
        w = world
        w.gw.down = True
        t0 = datetime(2026, 9, 28, 3, 1, tzinfo=timezone.utc)
        assert svc.run_due(w.db, now=t0) == 1
        assert svc.run_due(w.db, now=t0 + timedelta(minutes=10)) == 0
        assert svc.run_due(w.db, now=t0 + timedelta(minutes=31)) == 1
        assert svc.run_due(w.db, now=t0 + timedelta(minutes=62)) == 1
        assert svc.run_due(w.db, now=t0 + timedelta(minutes=93)) == 0
        assert {r.status for r in w.db.query(ZCreditReconRun).all()} == {"failed"}

    def test_the_worker_pass_and_its_switch(self, world, monkeypatch):
        w = world
        made = worker.run_once(lambda: w.db, now=datetime(2026, 9, 28, 3, 1, tzinfo=timezone.utc))
        assert made == 1
        monkeypatch.setenv(worker.ENV_SWITCH, "false")
        assert worker.start_background_worker(lambda: w.db) is False


# ── Deposits ─────────────────────────────────────────────────────────────────


class TestDeposits:
    def test_a_deposit_against_our_transmission_and_its_legs(self, world):
        w = world
        _, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        t = transmission(w, w.tills[0], "777")
        leg.transmission_id, leg.transmitted_batch = t.id, "777"
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=2, deposit="777")]
        w.gw.deposits = [zdeposit("777", 5000)]
        (dep,) = run(w).deposits
        assert dep["depositId"] == "777" and dep["status"] == "match"
        assert dep["zcredit"]["net"] == 50.0 and dep["ours"]["legsNet"] == 50.0 and dep["ours"]["legsCount"] == 1

    def test_a_deposit_with_more_than_our_legs_is_a_difference(self, world):
        w = world
        _, leg = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        t = transmission(w, w.tills[0], "777")
        leg.transmission_id, leg.transmitted_batch = t.id, "777"
        w.db.flush()
        w.gw.rows = [zrow("R-1", 50.00, status=2, deposit="777")]
        w.gw.deposits = [zdeposit("777", 8000, count=2)]
        (dep,) = run(w).deposits
        assert dep["status"] == "difference" and "₪80.00" in dep["reason"] and "2" in dep["reason"]

    def test_a_deposit_no_transmission_of_ours_recorded(self, world):
        w = world
        card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        w.gw.rows = [zrow("R-1", 50.00, status=2, deposit="779")]
        w.gw.deposits = [zdeposit("779", 5000)]
        (dep,) = run(w).deposits
        assert dep["status"] == "missing" and "אין אצלנו שידור" in dep["reason"]


# ── Routes ───────────────────────────────────────────────────────────────────


def runs_of(w, user=None, **kw):
    args = dict(from_date=date(2026, 9, 20), to_date=TODAY, terminal_key=None, shop_id=None, history=False)
    args.update(kw)
    return R.get_runs(**args, **_ctx(w, user))


class TestRoutes:
    def test_terminals_are_masked_to_their_last_four(self, world):
        w = world
        out = R.get_terminals(shop_id=None, **_ctx(w))
        (t,) = out["terminals"]
        assert t["terminal"] == "••••0101" and t["last4"] == "0101" and t["enabled"] is True and t["runTime"] == "06:00"
        assert SHOP_TERMINAL not in json.dumps(out, ensure_ascii=False, default=str)
        assert {c["key"] for c in out["categories"]} >= {"matched", "zcredit_only", "ours_only", "duplicate"}

    def test_run_now_list_detail_filters_handle_and_badge(self, world, monkeypatch):
        w = world
        monkeypatch.setattr(R, "_today", lambda db, tenant_id: date(2026, 9, 28))
        tx, _ = card_sale(w, w.tills[0], w.shift1, "50.00", "R-1")
        card_sale(w, w.tills[0], w.shift1, "20.00", "R-9")
        w.gw.rows = [zrow("R-1", 50.00), zrow("R-2", 30.00)]
        out = R.post_run(R.RunIn.model_validate({"date": "2026-09-27"}), **_ctx(w))
        (r,) = out["runs"]
        assert r["status"] == "done" and r["openHard"] == 2 and r["summary"]["matched"]["count"] == 1
        assert SHOP_TERMINAL not in json.dumps(out, ensure_ascii=False, default=str)

        listed = runs_of(w)["runs"]
        assert [x["id"] for x in listed] == [r["id"]]
        detail = R.get_run(uuid.UUID(r["id"]), category=None, open_only=False, **_ctx(w))
        assert [i["category"] for i in detail["items"]] == ["zcredit_only", "ours_only", "matched"]
        orphan = detail["items"][0]
        assert orphan["canCredit"] and orphan["zcredit"]["reference"] == "R-2" and orphan["zcredit"]["cardLast4"] == "4580"
        assert detail["items"][2]["ours"]["transactionId"] == str(tx.id)
        only = R.get_run(uuid.UUID(r["id"]), category=["ours_only"], open_only=False, **_ctx(w))
        assert [i["category"] for i in only["items"]] == ["ours_only"]

        badge = R.get_attention(shop_id=None, days=14, **_ctx(w))
        assert badge["open"] == 2 and badge["runs"][0]["zcreditOnly"] == 1
        handled = R.post_handle(uuid.UUID(orphan["id"]), R.HandleIn(note="זוכה ידנית"), **_ctx(w))
        assert handled["handled"]["note"] == "זוכה ידנית" and handled["handled"]["by"] == "admin"
        assert R.get_attention(shop_id=None, days=14, **_ctx(w))["open"] == 1
        opened = R.get_run(uuid.UUID(r["id"]), category=None, open_only=True, **_ctx(w))
        assert orphan["id"] not in [i["id"] for i in opened["items"]]
        R.post_reopen(uuid.UUID(orphan["id"]), **_ctx(w))
        assert R.get_attention(shop_id=None, days=14, **_ctx(w))["open"] == 2

    def test_a_future_day_and_no_zcredit_tills_are_refused(self, world, monkeypatch):
        w = world
        monkeypatch.setattr(R, "_today", lambda db, tenant_id: TODAY)
        with pytest.raises(HTTPException) as e:
            R.post_run(R.RunIn.model_validate({"date": "2026-09-28"}), **_ctx(w))
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            R.post_run(R.RunIn.model_validate({"date": "2026-09-27"}), **_ctx(w, w.north_manager))
        assert e.value.status_code == 404

    def test_another_shops_manager_sees_nothing(self, world):
        w = world
        w.gw.rows = [zrow("R-2", 30.00)]
        r = run(w)
        assert runs_of(w, w.north_manager)["runs"] == []
        assert [x["id"] for x in runs_of(w, w.manager)["runs"]] == [str(r.id)]
        with pytest.raises(HTTPException) as e:
            R.get_run(r.id, category=None, open_only=False, **_ctx(w, w.north_manager))
        assert e.value.status_code == 404
        (item,) = items(w, r)
        with pytest.raises(HTTPException):
            R.post_handle(item.id, R.HandleIn(note=None), **_ctx(w, w.north_manager))
        assert R.get_attention(shop_id=None, days=14, **_ctx(w, w.north_manager))["open"] == 0

    def test_an_unknown_category_is_refused(self, world):
        w = world
        r = run(w)
        with pytest.raises(HTTPException) as e:
            R.get_run(r.id, category=["nope"], open_only=False, **_ctx(w))
        assert e.value.status_code == 400

    def test_the_routes_sections(self):
        from app.services.dashboard_sections import rule_for

        assert rule_for("GET", "/zcredit-reconciliation/runs").describe("GET") == "reports|z:view"
        assert rule_for("POST", "/zcredit-reconciliation/run").describe("POST") == "reports|z:edit"
        assert rule_for("POST", "/zcredit-reconciliation/items/{item_id}/handle").describe("POST") == "reports|z:edit"
        assert rule_for("GET", "/zcredit-reconciliation/attention").describe("GET") == "reports|z|cockpit:view"


class TestAlertsWiring:
    def test_the_exception_is_a_kind_of_the_log_and_a_push_category_and_opt_in_for_sms(self):
        from app.services import exceptions as EX
        from app.services.exception_alerts import catalog as CAT
        from app.services.exception_alerts import push as P

        assert EX.RULES_BY_TYPE["zcredit_recon"].severity == "high"
        assert CAT.KINDS_BY_KEY["zcredit_recon"].severity == "high"
        assert "zcredit_recon" in CAT.OPT_IN_KINDS
        assert P.CATEGORY_BY_KEY["card_reconcile"].kinds == ("zcredit_recon",)
