"""
"יומן חריגות" and "התראות SMS על חריגות" (app/services/exception_alerts).

What each class pins:

* **The log** — every detection point writes ONE entry per source event (a document,
  a till event, a shift close, a failed payment, a refused document, a kiosk alert, a
  battery alert, training mode, the terminal check bypass, a numbering conflict, an
  over-credited credit note); again = the same entry; a rolled-back source = none; a
  failing log never fails the detection; "טופל" and the exceptions report's review agree.
* **Rules** — kinds / severity, "≥ ₪X", "≥ X%", "N in M minutes", quiet hours, the rate
  limit and its digest, stale events, scope (company / shop / other tenant), recipients.
* **Idempotency** — the same entry processed twice never texts twice.
* **The provider** — dry run by default (setting unset or unknown); the 019 adapter only
  when configured, and even then nothing reaches the network in a test.
* **API** — the log's filters, summary, by-code and "טופל"; the rules' CRUD, validation,
  permissions, change log and the test message.

Runs on the in-memory SQLite world of tests/test_shop_areas.py; every test blocks HTTP.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response

from app.models.audit_exception import AuditException
from app.models.device_battery import DeviceBatteryAlert
from app.models.document_refusal import DocumentRefusal
from app.models.exception_alerts import (
    ExceptionAlertDispatch,
    ExceptionAlertRule,
    ExceptionAlertRuleChange,
    ExceptionLogEntry,
)
from app.models.failed_payment import FailedPaymentAttempt
from app.models.kiosk_ops import KioskAlert
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameterChange
from app.models.training import TrainingAuditLog
from app.models.user import User, UserRole
from app.routers import exception_alerts as AR
from app.routers import exception_log as LR
from app.routers import exceptions as XR
from app.schemas.audit_exception import ReviewIn, TillEventIn
from app.services import exceptions as svc
from app.services.exception_alerts import backfill as BF
from app.services.exception_alerts import catalog as CAT
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import hooks as H
from app.services.exception_alerts import messages as M
from app.services.exception_alerts import sms as SMS
from shift_world import NOW
from test_shop_areas import _ctx, refused, w  # noqa: F401

FROM, TO = date(2026, 9, 1), date(2026, 9, 30)
PHONE = "050-123-4567"
PHONE_E164 = "+972501234567"
PHONE2 = "052-765-4321"


# ── Fixtures ─────────────────────────────────────────────────────────────────


class Clock:
    def __init__(self, start):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now = self.now + timedelta(**kw)
        return self.now


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """No test here may reach an SMS API (or anything else over HTTP)."""
    import httpx

    from app.services.notifications import adapter019 as A

    def boom(*_a, **_k):
        raise AssertionError("a real SMS provider / HTTP endpoint was called")

    monkeypatch.setattr(httpx, "post", boom)
    monkeypatch.setattr(httpx.Client, "send", boom)
    monkeypatch.setattr(A.HttpTransport, "post", boom)
    SMS.DRY_RUN.clear()
    SMS.set_provider_override(None)
    yield
    SMS.set_provider_override(None)
    SMS.DRY_RUN.clear()


@pytest.fixture
def clock(monkeypatch):
    c = Clock(NOW + timedelta(minutes=1))
    monkeypatch.setattr(E, "now_fn", c)
    return c


def make_rule(w, *, shop=None, user=None, **fields):
    body = {
        "companyId": str(w.company.id),
        "shopId": str(shop.id) if shop is not None else None,
        "name": fields.pop("name", "החזרים"),
        "kinds": fields.pop("kinds", ["refund"]),
        "recipients": fields.pop("recipients", [{"phone": PHONE, "label": "דנה"}]),
        "rateLimitMinutes": fields.pop("rateLimitMinutes", 0),
    }
    body.update(fields)
    return AR.create_rule(body, **_ctx(w, user))


def refund(w, total="150", till=None, *, cashier=None, created_at=None):
    tx = w.doc(till or w.tills[0], None, total, credit_note=True)
    if cashier is not None:
        tx.cashier_id = cashier
    if created_at is not None:
        tx.created_at = created_at
    w.db.commit()
    svc.detect_transactions(w.db, [tx.id])
    w.db.commit()
    return tx


def void(w, till=None, amount="20", *, user="pu-1", when=None):
    body = TillEventIn(id=uuid.uuid4(), type="line_void", occurredAt=when or NOW, posUserId=user,
                       amount=Decimal(amount))
    XR.post_till_event(str((till or w.tills[0]).id), body, Response(), machine=till or w.tills[0], db=w.db)
    return body.id


def entries(w, kind=None):
    w.db.expire_all()
    q = w.db.query(ExceptionLogEntry)
    if kind:
        q = q.filter(ExceptionLogEntry.kind == kind)
    return q.order_by(ExceptionLogEntry.occurred_at, ExceptionLogEntry.received_at).all()


def dispatches(w, **filters):
    w.db.expire_all()
    q = w.db.query(ExceptionAlertDispatch)
    for key, value in filters.items():
        q = q.filter(getattr(ExceptionAlertDispatch, key) == value)
    return q.order_by(ExceptionAlertDispatch.created_at, ExceptionAlertDispatch.id).all()


def statuses(w, **filters):
    return [d.status for d in dispatches(w, **filters)]


def listed(w, user=None, **filters):
    args = dict(
        from_date=FROM, to_date=TO, company_id=None, shop_id=None, area_id=None, machine_id=None, kinds=None,
        severities=None, employee=None, acknowledged=None, code=None, rule_id=None, page=1, page_size=50,
    )
    args.update(filters)
    return LR.list_log(**args, **_ctx(w, user))


@pytest.fixture
def supervisor(w):
    u = User(id=uuid.uuid4(), role=UserRole.SHIFT_SUPERVISOR, tenant_id=w.tenant.id, email="sv@x",
             username="sv", shop_id=w.shop.id)
    w.db.add(u)
    w.db.commit()
    return u


# ── The catalog ──────────────────────────────────────────────────────────────


class TestCatalog:
    def test_every_exception_type_is_a_kind_of_the_log(self):
        missing = [t for t in svc.EXCEPTION_TYPES if t not in CAT.KINDS_BY_KEY]
        assert missing == []

    def test_kinds_are_unique_and_labelled(self):
        keys = [k.key for k in CAT.KINDS]
        assert len(keys) == len(set(keys))
        assert all(k.label and k.severity in CAT.SEVERITY_RANK for k in CAT.KINDS)


# ── The log: every detection point ───────────────────────────────────────────


class TestLog:
    def test_a_refund_is_logged_once_with_its_document(self, w, clock):
        tx = refund(w, "150")
        [e] = entries(w)
        assert (e.kind, e.source, e.amount, e.severity) == ("refund", "audit_exception", Decimal("150.00"), "medium")
        assert e.transaction_id == tx.id and e.shop_id == w.shop.id and e.machine_id == w.tills[0].id
        assert e.company_id == w.company.id and e.tenant_id == w.tenant.id
        assert e.audit_exception_id is not None and len(e.short_code) == 8
        assert e.dedupe_key == f"audit:{e.audit_exception_id}"
        # Detected again (a re-push, a rescan): the same entry.
        svc.detect_transactions(w.db, [tx.id])
        w.db.commit()
        assert len(entries(w)) == 1

    def test_a_till_event_and_a_shift_close_are_logged(self, w, clock):
        event_id = void(w, amount="25")
        [e] = entries(w, "line_void")
        assert e.till_event_id == event_id and e.amount == Decimal("25.00") and e.pos_user_id == "pu-1"
        s = w.shift(w.tills[1], 1, counted_cash="65.00")
        s.discrepancy = Decimal("-35")
        w.db.commit()
        svc.detect_shift_close(w.db, s.id)
        w.db.commit()
        [c] = entries(w, "cash_difference")
        assert c.shift_id == s.id and c.amount == Decimal("-35.00") and c.severity == "high"

    def test_the_other_detection_points_are_logged(self, w, clock):
        till = w.tills[0]
        w.db.add(FailedPaymentAttempt(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=till.id, occurred_at=NOW,
            amount_agorot=4590, outcome="card_locked", card_brand="visa", card_last4="1234", pos_user_id="pu-2",
            employee_name="יוסי",
        ))
        w.db.add(DocumentRefusal(
            id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, document_ref="doc-80",
            document_number="80", reason="field cannot be parsed", total_amount="99.90",
            first_seen_at=NOW, last_seen_at=NOW,
        ))
        w.db.add(KioskAlert(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, kiosk_machine_id=till.id, kind="terminal",
            key="terminal:card", reason="card_unknown", text="קיוסק — תשלום לא הוכרע", raised_at=NOW,
            last_reported_at=NOW, detail={"amountAgorot": 3200},
        ))
        w.db.add(KioskAlert(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, kiosk_machine_id=till.id, kind="help",
            key="help", reason="help", text="בקשת עזרה", raised_at=NOW, last_reported_at=NOW,
        ))
        w.db.add(DeviceBatteryAlert(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=till.id, cycle_id=uuid.uuid4(),
            level=5, percent=4, severity="critical", raised_at=NOW,
        ))
        w.db.add(TrainingAuditLog(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, action="dropped", machine_id=till.id,
            details={"kind": "transaction", "count": 2}, created_at=NOW,
        ))
        w.db.add(TillParameterChange(
            id=uuid.uuid4(), parameter_key="terminalNumberCheckBypass", scope_type="machine", scope_id=till.id,
            action="set", old_value=False, new_value=True, user_email="boss@x", created_at=NOW,
        ))
        w.db.add(TillParameterChange(
            id=uuid.uuid4(), parameter_key="terminalNumberCheckBypass", scope_type="machine", scope_id=till.id,
            action="set", old_value=True, new_value=False, user_email="boss@x", created_at=NOW,
        ))
        w.db.commit()
        kinds = sorted(e.kind for e in entries(w))
        assert kinds == sorted([
            "failed_payment", "document_refused", "card_unresolved", "device_battery", "training_dropped",
            "terminal_check_bypass",
        ])
        fp = entries(w, "failed_payment")[0]
        assert (fp.amount, fp.severity, fp.pos_user_name) == (Decimal("45.90"), "high", "יוסי")
        assert entries(w, "card_unresolved")[0].amount == Decimal("32.00")
        assert entries(w, "document_refused")[0].company_id == w.company.id

    def test_a_numbering_conflict_and_an_over_credited_credit_note(self, w, clock):
        holder = w.doc(w.tills[0], None, "50", number="77")
        clash = w.doc(w.tills[0], None, "60", number="77b")
        clash.number_conflict_of = holder.id
        w.db.commit()
        credit = w.doc(w.tills[0], None, "70", credit_note=True)
        w.db.commit()
        credit.over_credited = True
        w.db.commit()
        assert [e.transaction_id for e in entries(w, "document_number_conflict")] == [clash.id]
        assert [e.transaction_id for e in entries(w, "over_credited")] == [credit.id]

    def test_a_note_by_hand_for_a_core_upsert(self, w, clock):
        row = DocumentRefusal(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.tills[0].id,
                              document_ref="x", reason="bad", first_seen_at=NOW, last_seen_at=NOW)
        H.enabled = False
        try:
            w.db.add(row)
            w.db.commit()
        finally:
            H.enabled = True
        assert entries(w) == []
        H.note(w.db, "document_refusal", row.id)
        w.db.commit()
        assert [e.kind for e in entries(w)] == ["document_refused"]

    def test_a_rolled_back_source_is_not_logged(self, w, clock):
        w.db.add(AuditException(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
            machine_id=w.tills[0].id, exception_type="refund", severity="medium", dedupe_key="refund:x",
            status="new", occurred_at=NOW, amount=Decimal("10"),
        ))
        w.db.flush()
        assert w.db.info.get(H.PENDING)
        w.db.rollback()
        w.db.commit()
        assert entries(w) == []

    def test_a_savepoint_release_waits_for_the_real_commit(self, w, clock):
        seen = []
        original = H.process
        H.process = lambda bind, keys, **kw: seen.append(list(keys)) or original(bind, keys, **kw)
        try:
            with w.db.begin_nested():
                w.db.add(AuditException(
                    id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                    machine_id=w.tills[0].id, exception_type="refund", severity="medium", dedupe_key="refund:y",
                    status="new", occurred_at=NOW, amount=Decimal("10"),
                ))
            assert seen == [] and w.db.info.get(H.PENDING)
            w.db.commit()
        finally:
            H.process = original
        assert len(seen) == 1 and [e.kind for e in entries(w)] == ["refund"]

    def test_a_failing_log_never_fails_the_detection(self, w, clock, monkeypatch):
        from app.services.exception_alerts import log as L

        def broken(*_a, **_k):
            raise RuntimeError("log is down")

        monkeypatch.setattr(L, "record", broken)
        refund(w, "150")
        assert w.db.query(AuditException).count() == 1
        assert entries(w) == []

    def test_reviewing_the_exception_acknowledges_the_entry_and_back(self, w, clock):
        refund(w, "150")
        ae = w.db.query(AuditException).one()
        XR.review_exception(ae.id, ReviewIn(status="reviewed", note="בדקתי"), **_ctx(w))
        [e] = entries(w)
        assert e.acknowledged_at is not None and e.note == "בדקתי" and e.acknowledged_by_user_id == w.admin.id
        out = LR.acknowledge_entry(e.id, LR.AckIn(acknowledged=False), **_ctx(w))
        assert out["acknowledged"] is False
        w.db.expire_all()
        assert w.db.get(AuditException, ae.id).status == "new"
        out = LR.acknowledge_entry(e.id, LR.AckIn(acknowledged=True, note="טופל מול העובד"), **_ctx(w))
        assert out["acknowledged"] and out["note"] == "טופל מול העובד" and out["acknowledgedBy"] == "admin"
        w.db.expire_all()
        ae = w.db.get(AuditException, ae.id)
        assert (ae.status, ae.review_note) == ("reviewed", "טופל מול העובד")
        assert entries(w)[0].acknowledged_at is not None


# ── Rules: matching, thresholds, counting ────────────────────────────────────


class TestRules:
    def test_amount_threshold(self, w, clock):
        make_rule(w, minAmount=100)
        refund(w, "50")
        assert dispatches(w) == []
        refund(w, "150")
        [d] = dispatches(w)
        assert d.status == "dry_run" and d.kind == "alert" and d.provider == "dry_run"
        assert "החזר" in d.text and "₪150" in d.text and "Center" in d.text and "קופה 1" in d.text
        assert d.text.endswith(f"/x/{entries(w)[-1].short_code}") and len(d.text) <= 160
        assert d.recipient_masked == "050-•••-4567" and PHONE_E164 not in (d.text or "")
        [sent] = SMS.DRY_RUN.sent()
        assert sent["to"] == PHONE_E164 and sent["text"] == d.text

    def test_percent_threshold_for_a_discount(self, w, clock):
        make_rule(w, kinds=["discount"], minPercent=20)
        small = w.doc(w.tills[0], None, "100", discount="10")
        w.db.commit()
        svc.detect_transactions(w.db, [small.id])
        w.db.commit()
        assert [e.kind for e in entries(w)] == ["discount"]
        assert dispatches(w) == []
        tx = w.doc(w.tills[0], None, "100", discount="30")
        w.db.commit()
        svc.detect_transactions(w.db, [tx.id])
        w.db.commit()
        [d] = dispatches(w)
        assert "הנחה 30%" in d.text and "(₪30)" in d.text

    def test_cash_variance_threshold_is_on_the_absolute_difference(self, w, clock):
        make_rule(w, kinds=["cash_difference"], minAmount=30)
        for seq, diff in ((1, "-25"), (2, "-35")):
            s = w.shift(w.tills[0], seq)
            s.discrepancy = Decimal(diff)
            w.db.commit()
            svc.detect_shift_close(w.db, s.id)
            w.db.commit()
        [d] = dispatches(w)
        assert "הפרש קופה (חוסר) ₪35" in d.text

    def test_n_in_m_minutes_per_till(self, w, clock):
        make_rule(w, kinds=["line_void"], countThreshold=3, countWindowMinutes=10)
        void(w, when=NOW - timedelta(minutes=8))
        void(w, when=NOW - timedelta(minutes=4))
        void(w, till=w.tills[1], when=NOW - timedelta(minutes=3))  # another till: its own count
        assert dispatches(w) == []
        void(w, when=NOW)
        [d] = dispatches(w)
        assert "3× ביטול שורה ב-10 דק׳" in d.text
        # An old one outside the window does not count.
        void(w, till=w.tills[1], when=NOW - timedelta(minutes=30))
        assert len(dispatches(w)) == 1

    def test_kinds_severity_and_scope(self, w, clock):
        make_rule(w, name="גבוהות", kinds=[], minSeverity="high", recipients=[{"phone": PHONE2}])
        make_rule(w, name="צפון בלבד", shop=w.other_shop, kinds=["refund"])
        refund(w, "150")  # medium: neither
        assert dispatches(w) == []
        s = w.shift(w.tills[0], 1)
        s.discrepancy = Decimal("-50")
        w.db.commit()
        svc.detect_shift_close(w.db, s.id)
        w.db.commit()
        [d] = dispatches(w)
        assert d.recipient_masked == "052-•••-4321"
        refund(w, "150", till=w.other_till)
        assert len(dispatches(w)) == 2

    def test_disabled_deleted_and_other_tenant_rules_never_fire(self, w, clock):
        off = make_rule(w, enabled=False, recipients=[])
        gone = make_rule(w, name="נמחק")
        AR.delete_rule(uuid.UUID(gone["id"]), **_ctx(w))
        refund(w, "150")
        assert dispatches(w) == []
        assert off["enabled"] is False

    def test_every_recipient_gets_one_and_numbers_are_never_stored_in_clear(self, w, clock):
        make_rule(w, recipients=[{"phone": PHONE, "label": "דנה"}, {"phone": PHONE2}, {"phone": "0501234567"}])
        refund(w, "150")
        rows = dispatches(w)
        assert sorted(d.recipient_masked for d in rows) == ["050-•••-4567", "052-•••-4321"]
        assert {d.recipient_label for d in rows} == {"דנה", None}
        assert all(PHONE_E164 not in (d.dedupe_key or "") for d in rows)


# ── Rate limit, digest, quiet hours, stale ───────────────────────────────────


class TestHoldingBack:
    def test_rate_limit_then_digest(self, w, clock):
        make_rule(w, rateLimitMinutes=10)
        refund(w, "150")
        clock.advance(minutes=2)
        refund(w, "160")
        clock.advance(minutes=1)
        refund(w, "170")
        assert statuses(w) == ["dry_run", "suppressed_rate_limit", "suppressed_rate_limit"]
        # Inside the window: nothing yet.
        assert E.flush_digests(w.db) == 0
        clock.advance(minutes=8)  # 11 minutes after the first message
        assert E.flush_digests(w.db) == 1
        [digest] = dispatches(w, kind="digest")
        assert digest.status == "dry_run" and digest.digest_count == 2
        assert "סיכום חריגות" in digest.text and "2 נוספות" in digest.text and "זיכוי / החזר ×2" in digest.text
        held = dispatches(w, status="suppressed_rate_limit")
        assert {d.digest_id for d in held} == {digest.id}
        assert E.flush_digests(w.db) == 0
        # The digest is a message: the next exception right after it is held back again.
        clock.advance(minutes=1)
        refund(w, "180")
        assert statuses(w, kind="alert")[-1] == "suppressed_rate_limit"
        clock.advance(minutes=10)
        refund(w, "190")
        assert statuses(w, kind="alert")[-1] == "dry_run"

    def test_a_single_held_back_exception_is_sent_as_itself(self, w, clock):
        make_rule(w, rateLimitMinutes=10)
        refund(w, "150")
        refund(w, "160")
        clock.advance(minutes=11)
        assert E.flush_digests(w.db) == 1
        [digest] = dispatches(w, kind="digest")
        assert digest.text.startswith("חריגה: זיכוי / החזר ₪160")

    def test_no_digest_when_switched_off(self, w, clock):
        make_rule(w, rateLimitMinutes=10, digestEnabled=False)
        refund(w, "150")
        clock.advance(minutes=1)
        refund(w, "160")
        clock.advance(minutes=30)
        assert E.flush_digests(w.db) == 0
        assert statuses(w) == ["dry_run", "suppressed_rate_limit"]

    def test_quiet_hours_hold_back_and_sum_up_in_the_morning(self, w, clock):
        # NOW is 21:00 in Israel (18:00 UTC, summer time).
        make_rule(w, quietFrom="20:00", quietTo="07:00", rateLimitMinutes=10)
        refund(w, "150")
        clock.advance(minutes=5)
        refund(w, "160")
        assert statuses(w) == ["suppressed_quiet_hours", "suppressed_quiet_hours"]
        clock.advance(hours=2)
        assert E.flush_digests(w.db) == 0  # still night
        clock.now = datetime(2026, 9, 28, 4, 5, tzinfo=timezone.utc)  # 07:05 local
        assert E.flush_digests(w.db) == 1
        [digest] = dispatches(w, kind="digest")
        assert "בשעות השקט" in digest.text and digest.digest_count == 2

    def test_quiet_hours_window_math(self):
        rule = ExceptionAlertRule(quiet_from="22:00", quiet_to="06:30")
        at = lambda h, m: datetime(2026, 9, 27, h, m)  # noqa: E731
        assert E.in_quiet_hours(rule, at(23, 0)) and E.in_quiet_hours(rule, at(6, 29))
        assert not E.in_quiet_hours(rule, at(6, 30)) and not E.in_quiet_hours(rule, at(21, 59))
        day = ExceptionAlertRule(quiet_from="13:00", quiet_to="15:00")
        assert E.in_quiet_hours(day, at(14, 0)) and not E.in_quiet_hours(day, at(15, 0))

    def test_an_old_exception_is_logged_but_never_texted(self, w, clock):
        make_rule(w)
        clock.advance(hours=7)
        refund(w, "150")
        assert statuses(w) == ["suppressed_stale"]
        clock.advance(hours=1)
        assert E.flush_digests(w.db) == 0


# ── Idempotency ──────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_processing_an_entry_again_never_texts_twice(self, w, clock):
        make_rule(w)
        refund(w, "150")
        [e] = entries(w)
        assert E.process_entry(w.db, e) == []
        w.db.commit()
        H.process(w.db.get_bind(), [("audit_exception", e.audit_exception_id)])
        assert len(dispatches(w)) == 1 and len(SMS.DRY_RUN.sent()) == 1

    def test_backfill_is_idempotent_and_never_alerts(self, w, clock):
        H.enabled = False
        try:
            refund(w, "150")
        finally:
            H.enabled = True
        make_rule(w)
        assert entries(w) == []
        counts = BF.backfill(w.db, since=NOW - timedelta(days=1))
        assert counts["audit_exception"] == 1
        [e] = entries(w)
        assert e.backfilled is True and dispatches(w) == []
        assert BF.backfill(w.db, since=NOW - timedelta(days=1))["audit_exception"] == 0


# ── The provider ─────────────────────────────────────────────────────────────


class TestProvider:
    def test_dry_run_is_the_default(self, monkeypatch):
        from app.config import get_settings

        settings = get_settings()
        for value in ("", "dry_run", "twilio", "DRY_RUN"):
            monkeypatch.setattr(settings, "exception_alerts_sms_provider", value, raising=False)
            assert SMS.get_provider() is SMS.DRY_RUN
        monkeypatch.setattr(settings, "exception_alerts_sms_provider", "notifications", raising=False)
        assert isinstance(SMS.get_provider(), SMS.NotificationQueueSmsProvider)

    def test_the_019_adapter_queues_and_the_worker_never_reaches_the_network(self, w, clock, monkeypatch):
        from app.models.notifications import Notification
        from app.services.notifications import service as NS
        from app.services.notifications import worker as NW

        config = NS.default_config(w.tenant.id, w.company.id)
        config.sender = "RunnerPOS"
        w.db.add(config)
        w.db.commit()
        SMS.set_provider_override(SMS.NotificationQueueSmsProvider())
        make_rule(w)
        refund(w, "150")
        [d] = dispatches(w)
        assert d.status == "queued" and d.provider == "notifications" and d.provider_mode == "mock"
        n = w.db.get(Notification, d.notification_id)
        assert n.event_type == "ExceptionAlert" and n.body_snapshot == d.text and n.category == "internal_operations"
        owner = "test"
        for nid in NW.claim(w.db, NOW + timedelta(minutes=2), owner):
            NW.process_one(w.db, nid, owner, now_fn=lambda: NOW + timedelta(minutes=2))
        w.db.expire_all()
        assert w.db.get(Notification, d.notification_id).state == "provider_accepted"

    def test_no_provider_account_is_a_failed_attempt_not_a_send(self, w, clock):
        SMS.set_provider_override(SMS.NotificationQueueSmsProvider())
        make_rule(w)
        refund(w, "150")
        [d] = dispatches(w)
        assert (d.status, d.reason) == ("failed", "no_provider_config")


# ── API: rules ───────────────────────────────────────────────────────────────


class TestRulesApi:
    def test_create_validate_update_delete_and_the_change_log(self, w, clock):
        bad = refused(make_rule, w, recipients=[{"phone": "03-1234567"}])
        assert bad.status_code == 422 and bad.detail["code"] == "phone_not_mobile"
        assert refused(make_rule, w, recipients=[]).detail["code"] == "recipients_required"
        assert refused(make_rule, w, countThreshold=3).detail["code"] == "count_needs_both"
        assert refused(make_rule, w, quietFrom="22:00").detail["code"] == "quiet_needs_both"
        assert refused(make_rule, w, quietFrom="25:00", quietTo="07:00").detail["code"] == "time_invalid"
        assert refused(make_rule, w, kinds=["nope"]).detail["code"] == "kind_unknown"
        assert refused(make_rule, w, kinds=[]).detail["code"] == "kinds_required"
        rule = make_rule(w, minAmount=100, quietFrom="22:00", quietTo="07:00")
        assert rule["recipients"] == [{"phone": PHONE_E164, "label": "דנה", "userId": None}]
        assert rule["canWrite"] is True and rule["rateLimitMinutes"] == 0
        rid = uuid.UUID(rule["id"])
        out = AR.update_rule(rid, {"minAmount": 200, "enabled": False}, **_ctx(w))
        assert out["minAmount"] == 200 and out["enabled"] is False and out["quietFrom"] == "22:00"
        AR.delete_rule(rid, **_ctx(w))
        assert AR.list_rules(w.company.id, None, **_ctx(w))["rules"] == []
        changes = [c.action for c in w.db.query(ExceptionAlertRuleChange).order_by(ExceptionAlertRuleChange.created_at)]
        assert changes == ["create", "update", "delete"]
        logged = w.db.query(ExceptionAlertRuleChange).filter_by(action="create").one().new_value
        assert logged["recipients"][0]["phone"] == "050-•••-4567"  # no clear number in the log

    def test_permissions(self, w, clock, supervisor):
        assert refused(AR.list_rules, w.company.id, None, **_ctx(w, w.cashier)).status_code == 403
        assert refused(AR.list_rules, w.company.id, None, **_ctx(w, supervisor)).status_code == 403
        # A shop manager: their shop's rules, never the company-wide ones, never another shop.
        assert refused(make_rule, w, user=w.manager).status_code == 403
        mine = make_rule(w, shop=w.shop, user=w.manager)
        assert refused(make_rule, w, shop=w.other_shop, user=w.manager).status_code == 403
        company_wide = make_rule(w, name="חברה")
        listed_ = AR.list_rules(w.company.id, None, **_ctx(w, w.manager))
        assert [r["id"] for r in listed_["rules"]] == [mine["id"]] and listed_["canWriteCompany"] is False
        assert refused(AR.update_rule, uuid.UUID(company_wide["id"]), {"name": "x"}, **_ctx(w, w.manager)).status_code == 404
        # The company manager sees and writes both.
        cm = AR.list_rules(w.company.id, None, **_ctx(w, w.company_manager))
        assert {r["id"] for r in cm["rules"]} == {mine["id"], company_wide["id"]} and cm["canWriteCompany"]

    def test_the_test_message_uses_the_active_provider(self, w, clock):
        rule = make_rule(w, recipients=[{"phone": PHONE}, {"phone": PHONE2}])
        out = AR.test_rule(uuid.UUID(rule["id"]), **_ctx(w))
        assert out["dryRun"] is True and out["provider"]["provider"] == "dry_run"
        assert [d["status"] for d in out["dispatches"]] == ["dry_run", "dry_run"]
        assert all("(הדמיה)" in s["text"] for s in SMS.DRY_RUN.sent())
        again = refused(AR.test_rule, uuid.UUID(rule["id"]), **_ctx(w))
        assert again.status_code == 429 and again.detail == "test_too_soon"
        assert w.db.query(ExceptionAlertRuleChange).filter_by(action="test").count() == 1
        # The test message never counts as an alert for the rate limit.
        assert E.last_delivered_at(w.db, uuid.UUID(rule["id"])) is None

    def test_provider_endpoint(self, w):
        out = AR.get_provider(w.company.id, **_ctx(w))
        assert out == {"provider": "dry_run", "dryRun": True, "mode": "dry_run", "liveSendingEnabled": False}

    def test_dispatches_and_changes_endpoints(self, w, clock):
        rule = make_rule(w)
        refund(w, "150")
        out = AR.list_dispatches(uuid.UUID(rule["id"]), 50, **_ctx(w))["dispatches"]
        assert [d["status"] for d in out] == ["dry_run"] and out[0]["entryId"] == str(entries(w)[0].id)
        changes = AR.rule_changes(uuid.UUID(rule["id"]), 50, **_ctx(w))["changes"]
        assert [c["action"] for c in changes] == ["create"]


# ── API: the log ─────────────────────────────────────────────────────────────


class TestLogApi:
    def _world(self, w):
        make_rule(w)
        refund(w, "150", cashier="pu-9")
        void(w, amount="15", user="pu-1")
        refund(w, "80", till=w.other_till)

    def test_filters_paging_and_the_sms_on_each_row(self, w, clock):
        self._world(w)
        everything = listed(w)
        assert everything["total"] == 3
        assert listed(w, kinds="refund")["total"] == 2
        assert listed(w, severities="low")["total"] == 1
        assert listed(w, severities="bogus")["total"] == 0
        assert listed(w, shop_id=w.other_shop.id)["total"] == 1
        assert listed(w, machine_id=w.tills[0].id)["total"] == 2
        assert listed(w, employee="pu-1")["items"][0]["kind"] == "line_void"
        assert listed(w, from_date=date(2026, 9, 28), to_date=TO)["total"] == 0
        page = listed(w, page=2, page_size=2)
        assert page["total"] == 3 and len(page["items"]) == 1
        row = next(i for i in everything["items"] if i["kind"] == "refund" and i["shopName"] == "Center")
        assert row["kindLabel"] == "זיכוי / החזר" and row["transactionNumber"] and row["link"] == "document"
        assert [s["status"] for s in row["sms"]] == ["dry_run"] and row["sms"][0]["ruleName"] == "החזרים"
        assert row["sms"][0]["recipient"] == "050-•••-4567"
        e = entries(w, "line_void")[0]
        LR.acknowledge_entry(e.id, LR.AckIn(acknowledged=True, note="ok"), **_ctx(w))
        assert listed(w, acknowledged="true")["total"] == 1
        assert listed(w, acknowledged="false")["total"] == 2
        summary = LR.log_summary(FROM, TO, None, None, None, None, None, None, None, **_ctx(w))
        assert (summary["total"], summary["open"], summary["acknowledged"]) == (3, 2, 1)
        assert summary["byKind"][0] == {"key": "refund", "label": "זיכוי / החזר", "total": 2, "open": 2,
                                        "amount": 230.0}

    def test_by_code_finds_the_entry_whatever_its_date(self, w, clock):
        self._world(w)
        e = entries(w, "line_void")[0]
        out = LR.entry_by_code(e.short_code, **_ctx(w))
        assert out["id"] == str(e.id)
        assert listed(w, code=e.short_code, from_date=date(2020, 1, 1), to_date=date(2020, 1, 2))["total"] == 1
        assert refused(LR.entry_by_code, "nothing1", **_ctx(w)).status_code == 404

    def test_who_sees_what(self, w, clock, supervisor):
        self._world(w)
        assert refused(listed, w, w.cashier).status_code == 403
        assert listed(w, w.manager)["total"] == 2  # their shop
        assert listed(w, w.north_manager)["total"] == 1
        assert listed(w, w.company_manager)["total"] == 3
        assert listed(w, supervisor)["total"] == 2
        e = entries(w, "line_void")[0]
        assert refused(LR.acknowledge_entry, e.id, LR.AckIn(), **_ctx(w, supervisor)).status_code == 403
        other = entries(w)[-1] if entries(w)[-1].shop_id == w.other_shop.id else next(
            x for x in entries(w) if x.shop_id == w.other_shop.id)
        assert refused(LR.acknowledge_entry, other.id, LR.AckIn(), **_ctx(w, w.manager)).status_code == 404
        assert refused(LR.entry_by_code, other.short_code, **_ctx(w, w.manager)).status_code == 404

    def test_kinds_endpoint(self, w):
        out = LR.list_kinds(current_user=w.admin)
        assert {k["key"] for k in out["kinds"]} == set(CAT.KINDS_BY_KEY)
        assert [s["key"] for s in out["severities"]] == ["high", "medium", "low"]


# ── Texts ────────────────────────────────────────────────────────────────────


class TestMessages:
    def test_an_alert_fits_160_and_drops_the_optional_parts_first(self):
        link = "https://dash.r2m.co.il/x/abcd2345"
        text = M.alert_text(M.AlertParts(what="זיכוי / החזר ₪1,250", time="14:32", link=link,
                                         shop="סניף רמת השרון הגדול והמפואר", till="קופה 12",
                                         who="אלכסנדרה בן־שושן־לוי"))
        assert len(text) <= 160 and text.endswith(link) and "14:32" in text and "₪1,250" in text

    def test_money_and_percent(self):
        assert M.money(Decimal("250")) == "₪250"
        assert M.money(Decimal("-12.5")) == "₪12.50"
        assert M.percent(Decimal("30.00")) == "30%"
        assert M.percent(Decimal("12.25")) == "12.3%" or M.percent(Decimal("12.25")) == "12.2%"

    def test_a_digest_fits_160(self):
        text = M.digest_text(rule_name="כל החריגות הגבוהות", count=14, since="22:01", until="06:58",
                             kinds=[("זיכוי / החזר", 6), ("הפרש קופה", 4), ("ביטול שולחן", 3), ("הנחה", 1)],
                             shop="Center", link="https://dash.r2m.co.il/x/abcd2345", quiet=True)
        assert len(text) <= 160 and "14 בשעות השקט" in text


# ── The migration ────────────────────────────────────────────────────────────


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
    assert "f3a9c2e7b5d1" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("f3a9c2e7b5d1").down_revision == "c7e2f4a9d1b6"
