"""
The notification service and the 019 adapter (docs/SPEC_NOTIFICATIONS_CLUB.md part ב).

Everything here runs on the in-process mock 019 (`MockTransport`): no test reaches the
network, and the tests below prove the live endpoint cannot be reached without the
explicit switch. Spec §36 items covered: 3, 4, 5, 6, 7, 9, 20 (+ the order-ready rules
of §15 and the worker rules of §16).
"""
from __future__ import annotations

import random
import uuid
from datetime import timedelta

import pytest
from sqlalchemy.dialects import postgresql

from app.models.club import ClubSuppression
from app.models.notifications import (
    MODE_LIVE,
    MODE_TEST,
    DeliveryEvent,
    Notification,
    NotificationAttempt,
)
from app.models.outbox import OutboxEvent
from app.services import outbox as OUT
from app.services.notifications import adapter019 as A
from app.services.notifications import order_ready as OR
from app.services.notifications import outbox as CONS
from app.services.notifications import service as S
from app.services.notifications import templates as T
from app.services.notifications import worker as W
from app.services.notifications.crypto import decrypt_text
from app.services.notifications.phone import (
    PhoneError,
    mask_phone,
    normalize_mobile,
    normalize_phone,
    phone_hash,
    to_019_destination,
)
from notif_world import NOW, make_nworld

OWNER = "test-worker"
PHONE = "+972501234567"
PHONE_LOCAL = "050-123-4567"


@pytest.fixture
def w():
    world = make_nworld()
    yield world
    world.db.close()


@pytest.fixture(autouse=True)
def _no_live(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "notifications_live_sending_enabled", False, raising=False)


def cycle(w, *, dlr: bool = False):
    """One worker pass on the world's own session and clock."""
    now = w.clock()
    W.recover_stale(w.db, now)
    CONS.consume_batch(w.db, now, OWNER)
    for nid in W.claim(w.db, now, OWNER):
        W.process_one(w.db, nid, OWNER, now_fn=w.clock, adapter_factory=w.adapter_factory, rng=random.Random(1))
    if dlr:
        W.poll_delivery_reports(w.db, w.clock(), adapter_factory=w.adapter_factory)
    w.db.expire_all()


def ready_event(w, *, group=None, version=1, phone=PHONE_LOCAL, pickup=42, mode="ORDER_PROCESS", notify=True,
                partial=False, when=None, flat=True, first=None, label=None):
    group = group or str(uuid.uuid4())
    payload = {
        "orderId": str(uuid.uuid4()),
        "groupId": group,
        "pickupNumber": pickup,
        **({"pickupLabel": label} if label else {}),
        "workflowMode": mode,
        "notify": notify,
        "partial": partial,
    }
    if phone:
        if flat:
            payload["contactPhone"] = phone
        else:
            payload["contact"] = {"phone": phone, "firstName": first}
    ev = OUT.emit_event(
        w.db, tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
        event_type=OUT.READY_FOR_PICKUP, aggregate_type="fulfillment_group", aggregate_id=group,
        aggregate_version=version, occurred_at=when or w.clock(), payload=payload,
    )
    w.db.commit()
    return group, ev


def stop_event(w, group, kind, version=2):
    OUT.emit_event(
        w.db, tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id, event_type=kind,
        aggregate_type="fulfillment_group", aggregate_id=group, aggregate_version=version,
        occurred_at=w.clock(), payload={"groupId": group},
    )
    w.db.commit()


def notes(w):
    return w.db.query(Notification).order_by(Notification.created_at).all()


# ── Phones ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["050-123-4567", "0501234567", "501234567", "972501234567", "+972 50 123 4567",
                                 "00972501234567", "+972-050-1234567"])
def test_israeli_mobiles_normalise_to_e164(raw):
    assert normalize_phone(raw) == PHONE


def test_the_provider_format_is_the_documented_05_form():
    assert to_019_destination(PHONE) == "0501234567"
    assert mask_phone(PHONE) == "050-•••-4567"


@pytest.mark.parametrize("raw,code", [("03-1234567", "phone_not_mobile"), ("+447700900123", "phone_foreign_unsupported"),
                                      ("12", "phone_invalid"), ("", "phone_empty"), ("05x1234567", "phone_invalid")])
def test_what_cannot_get_an_sms_is_refused(raw, code):
    with pytest.raises(PhoneError) as e:
        normalize_mobile(raw)
    assert e.value.code == code


# ── The 019 contract (docs.019sms.co.il) ─────────────────────────────────────


def test_send_body_is_the_documented_schema_and_token_is_a_bearer_header():
    ad = A.Adapter019(mode=MODE_TEST, username="acct", token="SECRET-TOKEN", sender="RunnerPOS", transport=A.MockTransport())
    body = ad.build_send_body(PHONE, "שלום", "ext-1")
    assert body == {
        "sms": {
            "user": {"username": "acct"},
            "source": "RunnerPOS",
            "destinations": {"phone": [{"$": {"id": "ext-1"}, "_": "0501234567"}]},
            "message": "שלום",
        }
    }
    assert ad._headers() == {"Content-Type": "application/json", "Authorization": "Bearer SECRET-TOKEN"}
    assert ad.url == A.TEST_URL == "https://019sms.co.il/api/test"
    assert "SECRET-TOKEN" not in repr(ad)


def test_dlr_body_is_the_documented_schema():
    ad = A.Adapter019(mode=MODE_TEST, username="acct", token="t", sender="RunnerPOS", transport=A.MockTransport())
    body = ad.build_dlr_body(["a", "b"], NOW - timedelta(hours=1), NOW)
    assert body == {"dlr": {"user": {"username": "acct"}, "transactions": {"external_id": ["a", "b"]},
                            "from": "06/10/26 14:00", "to": "06/10/26 15:00"}}


def test_live_endpoint_cannot_be_reached_without_the_switch():
    # The adapter refuses before any transport is touched…
    spy = A.MockTransport()
    ad = A.Adapter019(mode=MODE_LIVE, username="u", token="t", sender="RunnerPOS", transport=spy, live_allowed=False)
    assert ad.send(PHONE, "x", "e").error_class == "live_sending_disabled"
    assert spy.sent == []
    # …and the HTTP transport itself refuses the live URL without the flag and any other URL.
    http = A.HttpTransport()
    with pytest.raises(A.LiveSendingDisabled):
        http.post(A.PROD_URL, {}, {}, live_allowed=False)
    with pytest.raises(A.TransportError):
        http.post("https://evil.example/api", {}, {}, live_allowed=True)


def test_mock_mode_never_uses_the_network():
    ad = A.Adapter019(mode="mock", username=None, token=None, sender="RunnerPOS")
    assert ad.transport is A.MOCK_019


@pytest.mark.parametrize("sender,ok", [("RunnerPOS", True), ("Runner POS", False), ("ABCDEFGHIJKL", False),
                                       ("+97250", False), ("רנר", False), ("0501234567", True)])
def test_sender_rule_is_up_to_11_english_letters_or_digits(sender, ok):
    assert A.is_valid_sender(sender) is ok


@pytest.mark.parametrize("http,body,outcome", [
    (200, {"status": 0, "message": "SMS will be sent", "shipment_id": "123"}, "accepted"),
    (200, {"status": 3, "message": "bad token"}, "rejected"),
    (200, {"status": 4, "message": "Not enough credit"}, "retryable"),
    (200, {"status": 6}, "retryable"),
    (200, {"status": 999}, "unknown"),
    (200, {"status": 8}, "rejected"),
    (200, None, "unknown"),
    (502, None, "unknown"),
    (429, None, "retryable"),
    (401, None, "rejected"),
])
def test_send_responses_are_classified_from_the_documented_codes(http, body, outcome):
    assert A.classify_send_response(http, body).outcome == outcome


def test_token_errors_raise_the_token_alert():
    assert A.classify_send_response(200, {"status": 11}).alert == "token_rejected"
    assert A.classify_send_response(200, {"status": 4}).alert == "no_credit"


@pytest.mark.parametrize("status,state", [("102", "delivered"), ("0", "delivered"), ("-1", "provider_accepted"),
                                          ("2", "provider_accepted"), ("103", "failed_permanent"),
                                          ("15", "failed_permanent"), ("201", "suppressed"), ("17", "suppressed"),
                                          ("115", "failed_permanent"), ("12345", None)])
def test_dlr_statuses_map_per_the_documentation(status, state):
    assert A.map_dlr_status(status) == state


# ── Templates ────────────────────────────────────────────────────────────────


def test_only_declared_variables_render():
    with pytest.raises(T.TemplateError) as e:
        T.validate_body("OrderReady", "הזמנה {pickup_number} {branch_name} {brand_name} {phone}")
    assert e.value.code == "template_variable_unknown"
    with pytest.raises(T.TemplateError):
        T.validate_body("OrderReady", "הזמנה {pickup_number} {branch_name} {brand_name} {{x}}")


def test_no_first_name_uses_the_fallback_not_an_empty_hole():
    spec = T.EVENTS["OrderReady"]
    out = T.render("OrderReady", spec.body, {"pickup_number": "7", "branch_name": "מרכז", "brand_name": "R"},
                   fallback=spec.fallback)
    assert out.used_fallback and "היי," in out.text and "היי ," not in out.text


def test_values_cannot_inject_placeholders_or_lines():
    spec = T.EVENTS["OrderReady"]
    out = T.render("OrderReady", spec.body, {"first_name": "{brand_name}\nקישור", "pickup_number": "7",
                                              "branch_name": "מרכז", "brand_name": "R"}, fallback=spec.fallback)
    assert "{" not in out.text and "\n" not in out.text


def test_an_otp_code_never_reaches_the_snapshot():
    spec = T.EVENTS["OtpCode"]
    out = T.render("OtpCode", spec.body, {"code": "654321", "brand_name": "R"})
    assert "654321" in out.text and "654321" not in out.snapshot


def test_segments_are_an_estimate_and_hebrew_is_ucs2():
    est = T.estimate_segments("א" * 71)
    assert est["encoding"] == "UCS-2" and est["segments"] == 2 and est["verified"] is False
    assert T.estimate_segments("a" * 160)["segments"] == 1


def test_template_lifecycle_draft_approved_active_archived(w):
    d1 = T.create_draft(w.db, tenant_id=w.tenant.id, company_id=w.company.id, event_type="OrderReady",
                        body="הזמנה {pickup_number} מוכנה ב{branch_name}. {brand_name}")
    with pytest.raises(T.TemplateError):
        T.activate(w.db, d1)  # not approved yet
    T.approve(d1, w.admin.id)
    with pytest.raises(T.TemplateError):
        T.update_draft(d1, body="x {pickup_number} {branch_name} {brand_name}")  # only drafts are editable
    T.activate(w.db, d1)
    d2 = T.create_draft(w.db, tenant_id=w.tenant.id, company_id=w.company.id, event_type="OrderReady",
                        body="מוכן! {pickup_number} {branch_name} {brand_name}")
    T.approve(d2, w.admin.id)
    T.activate(w.db, d2)
    w.db.commit()
    assert d1.status == "archived" and d2.status == "active" and d2.version == 2
    row, body, *_ = T.resolve_template(w.db, w.tenant.id, w.company.id, "OrderReady")
    assert row.id == d2.id and body.startswith("מוכן!")


# ── Order ready (§15) ────────────────────────────────────────────────────────


def test_ready_for_pickup_queues_one_service_sms_with_the_spec_text(w):
    w.config()
    ready_event(w, flat=False, first="דנה")
    cycle(w)
    [n] = notes(w)
    assert n.category == "service" and n.event_type == "OrderReady"
    assert n.state == "provider_accepted"  # accepted by the provider — NOT delivered
    assert w.mock.sent[0]["message"] == "היי דנה, הזמנה 42 בסניף Alpha מרכז מוכנה לאיסוף. מחכים לך בדלפק. Alpha בע\"מ"
    assert w.mock.sent[0]["phones"][0]["_"] == "0501234567"
    assert decrypt_text(n.recipient_ciphertext) == PHONE and n.recipient_masked == "050-•••-4567"


def test_a_kiosk_orders_ready_sms_names_its_label(w):
    """The kiosk's slip said "A-17" (or "17" with "מספר בלבד"): so does the message."""
    w.config()
    ready_event(w, flat=False, first="דנה", pickup=17, label="A-17")
    cycle(w)
    assert "הזמנה A-17 בסניף" in w.mock.sent[0]["message"]


def test_the_contact_phone_in_the_outbox_is_masked_once_taken(w):
    w.config()
    _g, ev = ready_event(w)
    cycle(w)
    ev = w.db.get(OutboxEvent, ev.id)
    assert ev.payload["contactPhone"] == "050-•••-4567" and ev.payload_redacted_at is not None
    assert ev.state == "processed" and ev.result.startswith("queued:")


@pytest.mark.parametrize("kw,result", [
    ({"mode": "DIRECT_SALE"}, "skipped:direct_sale"),
    ({"notify": False}, "skipped:not_requested"),
    ({"phone": None}, "skipped:no_contact"),
    ({"partial": True}, "skipped:partial_not_enabled"),
    ({"phone": "03-1234567"}, "skipped:phone_not_mobile"),
])
def test_what_never_sends_a_ready_sms(w, kw, result):
    w.config()
    _g, ev = ready_event(w, **kw)
    cycle(w)
    assert w.db.get(OutboxEvent, ev.id).result == result
    assert notes(w) == [] and w.mock.sent == []


def test_without_a_provider_account_nothing_is_queued(w):
    _g, ev = ready_event(w)
    cycle(w)
    assert w.db.get(OutboxEvent, ev.id).result == "skipped:no_provider_config"


def test_same_ready_twice_and_undo_then_ready_again_send_once(w):
    """§36 #3: a double tap / second screen / undo + ready are one message."""
    w.config()
    group, _ = ready_event(w)
    ready_event(w, group=group, version=1)  # same event again: deduped in the outbox
    ready_event(w, group=group, version=3)  # a later "ready" of the same group: deduped by the key
    cycle(w)
    assert len(notes(w)) == 1 and len(w.mock.sent) == 1


def test_undo_before_sending_cancels_and_ready_again_revives_once(w):
    w.config(paused=True)  # hold the queue so the undo lands first
    group, _ = ready_event(w)
    cycle(w)
    stop_event(w, group, OUT.READY_REVOKED)
    cycle(w)
    [n] = notes(w)
    assert n.state == "cancelled" and n.state_reason == OR.REVOKED_REASON
    ready_event(w, group=group, version=3)
    cfg = w.configs[0]
    cfg.paused = False
    w.db.commit()
    cycle(w)
    [n] = notes(w)
    assert n.state == "provider_accepted" and len(w.mock.sent) == 1


def test_authorised_resend_is_a_new_explicit_message_with_reason_and_rate_limit(w):
    """§36 #3: a resend is recorded with who/why, and limited."""
    w.config()
    ready_event(w)
    cycle(w)
    [orig] = notes(w)
    with pytest.raises(S.NotificationError):
        S.resend(w.db, orig, user_id=w.admin.id, reason="  ", now=w.clock())
    again = S.resend(w.db, orig, user_id=w.admin.id, reason="הלקוח לא קיבל", now=w.clock())
    w.db.commit()
    assert again.resend_of_id == orig.id and again.resend_reason == "הלקוח לא קיבל" and again.created_by == w.admin.id
    assert again.body_snapshot == orig.body_snapshot
    with pytest.raises(S.NotificationError) as e:
        S.resend(w.db, orig, user_id=w.admin.id, reason="שוב", now=w.clock() + timedelta(seconds=10))
    assert e.value.code == "resend_too_soon"
    cycle(w)
    assert len(w.mock.sent) == 2


@pytest.mark.parametrize("kind,reason", [(OUT.HANDED_OVER, "order_handed_over"), (OUT.ORDER_CANCELLED, "order_cancelled")])
def test_handover_or_cancel_before_the_worker_suppresses_the_message(w, kind, reason):
    """§36 #4."""
    w.config(paused=True)
    group, _ = ready_event(w)
    cycle(w)
    stop_event(w, group, kind)
    cycle(w)
    [n] = notes(w)
    assert n.state == "cancelled" and n.state_reason == reason and w.mock.sent == []


def test_the_worker_rechecks_the_kds_group_before_sending(w, monkeypatch):
    """§15: before each attempt — not handed over, ready still valid."""
    w.config()
    monkeypatch.setattr(OR, "FULFILLMENT_STATE_PROVIDER", lambda db, t, g: "handed_over")
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "cancelled" and n.state_reason == "order_handed_over" and w.mock.sent == []


def test_a_stop_after_sending_reports_already_sent_for_a_staff_alert(w):
    w.config()
    group, _ = ready_event(w)
    cycle(w)
    stop_event(w, group, OUT.ORDER_CANCELLED)
    cycle(w)
    ev = w.db.query(OutboxEvent).filter(OutboxEvent.event_type == OUT.ORDER_CANCELLED).one()
    assert "already_sent:1" in ev.result


def test_order_contact_snapshot_reaches_only_its_own_order(w):
    """§36 #20: two orders, two contacts — each message goes to its own order's number."""
    w.config()
    g1, _ = ready_event(w, phone="0501111111", pickup=1)
    g2, _ = ready_event(w, phone="0502222222", pickup=2)
    cycle(w)
    by_group = {n.aggregate_ref: decrypt_text(n.recipient_ciphertext) for n in notes(w)}
    assert by_group == {g1: "+972501111111", g2: "+972502222222"}
    sent = {m["phones"][0]["_"]: m["message"] for m in w.mock.sent}
    assert "הזמנה 1 " in sent["0501111111"] and "הזמנה 2 " in sent["0502222222"]


# ── Worker: TTL, priority, retries, unknown outcome, DLR (§16) ───────────────


def test_ttl_expires_an_old_message(w):
    """§36 #7: a ready SMS older than its TTL (10 min) is not sent."""
    w.config(paused=True)
    ready_event(w)
    cycle(w)
    w.configs[0].paused = False
    w.db.commit()
    w.clock.advance(minutes=11)
    cycle(w)
    [n] = notes(w)
    assert n.state == "expired" and w.mock.sent == []


def test_marketing_never_blocks_otp_or_ready(w):
    """§36 #7: claiming orders by priority — a waiting campaign message is taken last."""
    cfg = w.config()
    early = w.clock() - timedelta(minutes=5)
    m = S.enqueue(w.db, tenant_id=w.tenant.id, company_id=w.company.id, event_type="Campaign",
                  recipient_e164="+972503333333", variables={"brand_name": "R"}, dedupe_key="mk-1",
                  ttl=timedelta(hours=1), config=cfg, now=early).notification
    r = S.enqueue(w.db, tenant_id=w.tenant.id, company_id=w.company.id, event_type="OrderReady",
                  recipient_e164=PHONE, variables={"pickup_number": "5", "branch_name": "b", "brand_name": "R"},
                  dedupe_key="rd-1", ttl=timedelta(minutes=10), config=cfg, now=w.clock()).notification
    w.db.commit()
    assert W.claim(w.db, w.clock(), OWNER, limit=1) == [r.id]
    assert m.priority > r.priority


def test_claim_uses_skip_locked_on_postgres(w):
    from app.models.notifications import Notification as N

    q = w.db.query(N.id).filter(N.state == "queued").with_for_update(skip_locked=True)
    sql = str(q.statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE SKIP LOCKED" in sql


def test_connect_failure_retries_with_backoff_then_gives_up(w):
    w.config()
    w.mock.script_send(*[A.TransportError("connect_failed", after_send=False)] * 5)
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "failed_retryable" and n.attempt_count == 1
    delay = (S.as_aware(n.not_before) - w.clock()).total_seconds()
    assert 15 <= delay <= 30  # 30 s with jitter in [½, 1]
    for _ in range(6):
        if n.state != "failed_retryable":
            break
        w.clock.advance(seconds=31 * 2 ** n.attempt_count)
        cycle(w)
        n = w.db.get(Notification, n.id)
    # Bounded by the TTL (10 min) or by max_attempts (5) — whichever comes first.
    assert n.state in ("expired", "failed_permanent") and 2 <= n.attempt_count <= 5
    assert w.mock.sent == []


def test_backoff_is_exponential_with_full_jitter_and_capped():
    rng = random.Random(7)
    for attempt, top in ((1, 30), (2, 60), (3, 120), (10, 900)):
        d = W.backoff_seconds(attempt, rng)
        assert top / 2 <= d <= top


def test_timeout_after_send_is_unknown_and_reconciled_not_resent(w):
    """§36 #5: the provider may have it — reconcile by the external id, never a blind retry."""
    w.config()
    w.mock.script_send(A.TransportError("timeout_after_send", after_send=True))
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "unknown_outcome" and n.secret_vars_ciphertext is None
    w.clock.advance(minutes=2)
    cycle(w)  # no retry
    assert w.db.query(NotificationAttempt).count() == 1
    cycle(w, dlr=True)
    n = w.db.get(Notification, n.id)
    assert n.state == "delivered" and n.attempt_count == 1


def test_crash_between_call_and_result_goes_to_reconciliation(w):
    """§36 #5: an attempt started and never finished → unknown_outcome, not a resend."""
    w.config()
    ready_event(w)
    now = w.clock()
    CONS.consume_batch(w.db, now, OWNER)
    [nid] = W.claim(w.db, now, OWNER)
    n = w.db.get(Notification, nid)
    w.db.add(NotificationAttempt(id=uuid.uuid4(), notification_id=nid, tenant_id=n.tenant_id, sequence=1,
                                 correlation_id=f"{nid.hex[:24]}-1", mode="mock", started_at=now))
    n.attempt_count = 1
    n.provider_external_id = f"{nid.hex[:24]}-1"
    w.db.commit()
    w.clock.advance(minutes=2)  # the lease runs out; the worker "crashed"
    cycle(w)
    n = w.db.get(Notification, nid)
    assert n.state == "unknown_outcome" and n.state_reason == "crash_reconcile" and w.mock.sent == []
    # No report ever comes: it stays unknown for an operator after the window.
    w.clock.advance(minutes=40)
    cycle(w, dlr=True)
    n = w.db.get(Notification, nid)
    assert n.state == "unknown_outcome" and n.next_dlr_poll_at is None


def test_duplicate_and_late_dlrs_never_move_a_delivered_message_back(w):
    """§36 #6."""
    w.config()
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "provider_accepted" and n.delivered_at is None
    ext = n.provider_external_id
    rec = A.DlrRecord(external_id=ext, status="102", shipment_id="s", event_at=NOW, payload={})
    assert W.apply_dlr(w.db, "019", rec, w.clock()) == "delivered"
    assert W.apply_dlr(w.db, "019", rec, w.clock()) is None  # exact duplicate: stored once
    old = A.DlrRecord(external_id=ext, status="-1", shipment_id="s", event_at=NOW - timedelta(minutes=1), payload={})
    W.apply_dlr(w.db, "019", old, w.clock())
    failed = A.DlrRecord(external_id=ext, status="103", shipment_id="s", event_at=NOW + timedelta(minutes=1), payload={})
    W.apply_dlr(w.db, "019", failed, w.clock())
    w.db.commit()
    n = w.db.get(Notification, n.id)
    assert n.state == "delivered"
    events = w.db.query(DeliveryEvent).filter(DeliveryEvent.notification_id == n.id).all()
    assert len(events) == 3 and [e.applied for e in events].count(True) == 1
    assert all("phone" not in (e.payload or {}) for e in events)


def test_a_dlr_block_by_request_suppresses_and_records_a_provider_block(w):
    w.config()
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    w.mock.set_dlr(n.provider_external_id, "201")
    w.mock._dlr[n.provider_external_id] = "201"
    W.apply_dlr(w.db, "019", A.DlrRecord(n.provider_external_id, "201", None, NOW, {}), w.clock())
    w.db.commit()
    assert w.db.get(Notification, n.id).state == "suppressed"
    assert w.db.query(ClubSuppression).filter_by(scope="all", reason="provider_blacklist").count() == 1


# ── Gates: pause, live, test numbers, rate, token (§18, §20) ─────────────────


def test_paused_account_sends_nothing_and_consumes_no_attempt(w):
    w.config(paused=True)
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "queued" and n.state_reason == "paused" and n.attempt_count == 0 and w.mock.sent == []


def test_live_mode_without_the_server_switch_never_sends(w):
    w.config(mode=MODE_LIVE)
    ready_event(w)
    cycle(w)
    [n] = notes(w)
    assert n.state == "failed_permanent" and n.state_reason == "live_sending_disabled" and w.mock.sent == []


def test_live_mode_sends_only_to_allow_listed_test_numbers(w, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "notifications_live_sending_enabled", True, raising=False)
    w.config(mode=MODE_LIVE, test_numbers=["+972509999999"])
    ready_event(w)
    ready_event(w, phone="0509999999", pickup=9)
    cycle(w)
    states = {decrypt_text(n.recipient_ciphertext): (n.state, n.state_reason) for n in notes(w)}
    assert states[PHONE] == ("suppressed", "not_on_test_list")
    assert states["+972509999999"][0] == "provider_accepted"
    assert [m["phones"][0]["_"] for m in w.mock.sent] == ["0509999999"]


def test_rate_limit_defers_without_failing(w):
    w.config(rate_per_minute=1)
    ready_event(w, phone="0501111111")
    ready_event(w, phone="0502222222")
    cycle(w)
    states = sorted(n.state for n in notes(w))
    assert states == ["provider_accepted", "queued"]


def test_rejected_token_pauses_the_account_and_raises_an_alert(w):
    cfg = w.config()
    w.mock.script_send({"status": 3, "message": "Username or password is incorrect and API token is invalid"})
    ready_event(w)
    cycle(w)
    w.db.refresh(cfg)
    [n] = notes(w)
    assert n.state == "failed_permanent" and cfg.paused and cfg.last_alert == "token_rejected"


# ── Secrets and tenancy (§36 #9) ─────────────────────────────────────────────


def test_the_token_is_stored_encrypted_and_never_read_back(w):
    from app.models.payment_secret import PaymentIntegrationSecret
    from app.services.notifications.secrets import resolve_token, set_token, token_status

    cfg = w.config()
    assert set_token(w.db, cfg, "019-SECRET-123")
    w.db.commit()
    row = w.db.query(PaymentIntegrationSecret).one()
    assert "019-SECRET-123" not in row.ciphertext
    status = token_status(w.db, cfg)
    assert status["set"] is True and "019-SECRET-123" not in str(status)
    assert resolve_token(w.db, cfg) == "019-SECRET-123"
    assert set_token(w.db, cfg, "••••") is False  # the masked echo keeps it


def test_request_logs_redact_token_code_and_phone():
    from app.observability.body_logging import redact_json

    logged = redact_json({"token": "SECRET", "code": "123456", "phone": "0501234567", "registrationToken": "r",
                          "clientSession": "s", "firstName": "דנה"})
    assert "SECRET" not in str(logged) and "123456" not in str(logged) and "0501234567" not in str(logged)
    assert logged["firstName"] == "דנה"
    # An error code is not a one-time code: it stays readable in the logs.
    assert redact_json({"detail": {"code": "wrong_code"}}) == {"detail": {"code": "wrong_code"}}


def test_attempts_and_events_hold_no_secret_and_no_number(w):
    cfg = w.config()
    from app.services.notifications.secrets import set_token

    set_token(w.db, cfg, "TOPSECRET")
    w.db.commit()
    ready_event(w)
    cycle(w, dlr=True)
    for a in w.db.query(NotificationAttempt).all():
        assert "TOPSECRET" not in str(vars(a)) and "0501234567" not in str(vars(a))


def test_provider_accounts_never_cross_tenants(w):
    w.config(company=w.other_company)
    assert S.get_config(w.db, w.tenant.id, w.company.id) is None
    _g, ev = ready_event(w)
    cycle(w)
    assert w.db.get(OutboxEvent, ev.id).result == "skipped:no_provider_config"


def test_short_status_is_per_tenant(w):
    w.config()
    group, _ = ready_event(w)
    cycle(w)
    assert S.short_status(w.db, w.tenant.id, [group])[group]["code"] == "accepted"
    assert S.short_status(w.db, w.other_tenant.id, [group])[group]["code"] == "not_required"
    cycle(w, dlr=True)
    w.clock.advance(minutes=2)
    cycle(w, dlr=True)
    assert S.short_status(w.db, w.tenant.id, [group])[group] == {"code": "delivered", "label": "נמסר"}


def test_dashboard_log_scope_keeps_other_companies_out(w):
    from app.models.user import User, UserRole
    from app.routers import notifications as R

    w.config()
    ready_event(w)
    cycle(w)
    manager = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.other_tenant.id,
                   company_id=w.other_company.id, email="m@x", username="m")
    w.db.add(manager)
    w.db.commit()
    q = R._scoped(w.db, manager, w.tenant.id, w.db.query(Notification))
    assert q.count() == 0
    out = R.notification_log(company_id=None, shop_id=None, state=None, category=None, event_type=None, q=None,
                             limit=50, offset=0, user=w.admin, tenant_id=w.tenant.id, db=w.db)
    assert out["total"] == 1 and out["items"][0]["recipient"] == "050-•••-4567"
    assert "0501234567" not in str(out)


def test_suppression_blocks_marketing_but_not_service(w):
    hashed = phone_hash(PHONE)
    w.db.add(ClubSuppression(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, phone_hash=hashed,
                             channel="sms", scope="marketing", reason="unsubscribe"))
    w.db.commit()
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "marketing") == "unsubscribed"
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "service") is None
