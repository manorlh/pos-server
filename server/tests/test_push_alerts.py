"""
"התראות לטלפון" — Web Push on the exception alerts (app/services/webpush.py,
app/services/exception_alerts/push.py, till_watch.py, external.py, app/routers/push_alerts.py).

* Web Push itself: the aes128gcm message decrypts with the browser's key, the VAPID token
  verifies with the public key, a gone device is reported;
* the alert types: which kinds each covers (a declined card is not a terminal failure);
* the rules: type, minimum amount, shops / events, the owner's reach (scoping) — a user never
  receives what they could not read in the log, a cashier or a user of another shop nothing;
* throttling and dedupe: the same entry never twice, the rate limit and quiet hours hold back
  and the digest sums up afterwards; a gone device is turned off;
* the detections: a till offline (once per outage, closed when back), an event's target
  reached (once), the insights' hook for a till barely selling (once a day);
* the routes: subscribing (keys checked), preferences, the test message, the alerts feed and
  "טופל", my history.

Runs on the in-memory SQLite world of tests/shift_world.py; the sender runs inline with a fake
push service.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.exception_alerts import ExceptionAlertDispatch, ExceptionLogEntry, PushSubscription
from app.models.shift import ShiftStatus
from app.models.user import User, UserRole
from app.routers import push_alerts as R
from app.services import webpush as W
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import external as X
from app.services.exception_alerts import log as L
from app.services.exception_alerts import push as P
from app.services.exception_alerts import till_watch as TW
from app.services.exception_alerts.rules import RuleError
from event_live_world import at, make_event, sale
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 9, 27, 16, 0, tzinfo=timezone.utc)  # 19:00 local


class FakePushService:
    def __init__(self, status=201):
        self.status = status
        self.calls = []

    def post(self, endpoint, content, headers, timeout):
        self.calls.append(SimpleNamespace(endpoint=endpoint, content=content, headers=headers))
        return SimpleNamespace(status_code=self.status)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    private, public = W.generate_vapid_keys()
    monkeypatch.setattr(W, "config", lambda: W.VapidConfig(public_key=public, private_key=private, subject="mailto:t@example.com"))
    world.push = FakePushService()
    monkeypatch.setattr(P, "SEND_MODE", "inline")
    monkeypatch.setattr(P, "TRANSPORT", world.push)
    monkeypatch.setattr(E, "now_fn", lambda: NOW)
    return world


def browser():
    """A browser's subscription keys, and its private key to read what it receives."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, W.b64u(public), W.b64u(os.urandom(16))


def device(w, user, name="phone"):
    key, p256dh, auth = browser()
    row = P.subscribe(w.db, user, w.tenant.id, endpoint=f"https://fcm.googleapis.com/fcm/send/{name}-{uuid.uuid4().hex}",
                      p256dh=p256dh, auth=auth, user_agent="Mozilla/5.0 (Linux; Android 14) Chrome/130.0")
    row._key, row._auth = key, auth
    return row


def user(w, role, shop=None, username=None):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
             shop_id=shop.id if shop else None, email=f"{uuid.uuid4().hex[:8]}@example.com",
             username=username or uuid.uuid4().hex[:10], is_active=True)
    w.db.add(u)
    w.db.flush()
    return u


def entry(w, kind, *, amount=None, shop=None, machine=None, minutes_ago=1, details=None, severity="medium"):
    till = machine or w.tills[0]
    spec = L.EntrySpec(
        source="test", source_id=uuid.uuid4().hex, dedupe_key=f"test:{uuid.uuid4().hex}", kind=kind, severity=severity,
        occurred_at=NOW - timedelta(minutes=minutes_ago), tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=(shop or w.shop).id, machine_id=till.id, amount=amount, details=details,
    )
    row, _ = L.record(w.db, spec, now=NOW)
    return row


def run(w, e, now=NOW):
    return [d for d in E.process_entry(w.db, e, now=now) if d.channel == "push"]


def pushes(w, *, status=None):
    q = w.db.query(ExceptionAlertDispatch).filter(ExceptionAlertDispatch.channel == "push")
    if status:
        q = q.filter(ExceptionAlertDispatch.status == status)
    return q.all()


# ── Web Push itself ──────────────────────────────────────────────────────────


def test_the_message_decrypts_with_the_browsers_key():
    key, p256dh, auth = browser()
    body = W.encrypt(b'{"title":"hello"}', p256dh, auth)
    assert W.decrypt(body, key, auth) == b'{"title":"hello"}'
    assert body[16:20] == (4096).to_bytes(4, "big") and body[20] == 65


def test_the_encryption_matches_rfc_8291_appendix_a():
    """The RFC's own example: the same keys and salt give the same body, byte for byte."""
    server_key = W.private_key_from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
    assert W.public_key_of(server_key) == (
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    )
    body = W.encrypt(
        b"When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        salt=W.b64u_decode("DGv6ra1nlYgDCS1FRnbzlw"),
        server_key=server_key,
    )
    assert W.b64u(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_y"
        "l95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )
    ua_key = W.private_key_from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
    assert W.decrypt(body, ua_key, "BTBZMqHH6r4Tts7J_aSIgg") == b"When I grow up, I want to be a watermelon"


def test_the_vapid_token_verifies_with_the_public_key():
    private, public = W.generate_vapid_keys()
    token = W.vapid_jwt("https://fcm.googleapis.com/fcm/send/abc", W.private_key_from(private), "mailto:x@example.com", now=1000)
    head, claims, sig = token.split(".")
    assert json.loads(W.b64u_decode(claims)) == {"aud": "https://fcm.googleapis.com", "exp": 1000 + W.JWT_TTL_SECONDS,
                                                 "sub": "mailto:x@example.com"}
    raw = W.b64u_decode(sig)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), W.b64u_decode(public))
    pub.verify(der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))  # raises when wrong
    assert W.public_key_of(W.private_key_from(private)) == public


def test_send_reports_success_gone_and_errors():
    private, public = W.generate_vapid_keys()
    vapid = W.VapidConfig(public, private, "mailto:x@example.com")
    _key, p256dh, auth = browser()
    ok = FakePushService(201)
    res = W.send("https://push.example.com/a", p256dh, auth, {"title": "t"}, vapid=vapid, topic="till_offline:abc-123", client=ok)
    assert res.ok and ok.calls[0].headers["Content-Encoding"] == "aes128gcm"
    assert ok.calls[0].headers["Authorization"].startswith("vapid t=") and f"k={public}" in ok.calls[0].headers["Authorization"]
    assert ok.calls[0].headers["Topic"] == "till_offlineabc-123"
    gone = W.send("https://push.example.com/a", p256dh, auth, {"title": "t"}, vapid=vapid, client=FakePushService(410))
    assert not gone.ok and gone.gone
    broken = W.send("https://push.example.com/a", "not-a-key", auth, {"title": "t"}, vapid=vapid, client=ok)
    assert not broken.ok and broken.error


def test_client_keys_are_checked():
    _key, p256dh, auth = browser()
    assert W.valid_client_key(p256dh, auth)
    assert not W.valid_client_key(p256dh, W.b64u(b"short"))
    assert not W.valid_client_key("AAAA", auth)


# ── The alert types and the preferences ──────────────────────────────────────


def test_each_kind_has_its_alert_type():
    def e(kind, **details):
        return SimpleNamespace(kind=kind, details=details or None)

    assert P.category_of(e("till_offline")) == "till_offline" and P.category_of(e("kiosk_offline")) == "till_offline"
    assert P.category_of(e("failed_payment", outcome="no_answer")) == "card_terminal"
    assert P.category_of(e("failed_payment", outcome="declined")) is None  # the card, not the terminal
    assert P.category_of(e("kiosk_terminal")) == "card_terminal"
    assert P.category_of(e("refund")) == "large_void" and P.category_of(e("line_void")) == "large_void"
    assert P.category_of(e("drawer_open")) == "drawer_no_sale"
    assert P.category_of(e("till_low_sales")) == "till_low_sales"
    assert P.category_of(e("target_reached")) == "target_reached"
    assert P.category_of(e("discount")) is None


def test_preferences_are_validated_with_defaults():
    d = P.clean({})
    assert d["categories"] == list(P.CATEGORY_KEYS) and d["minAmount"] == Decimal("200.00")
    assert d["rateLimitMinutes"] == 2 and d["enabled"] and d["shopIds"] is None
    for bad, code in (({"categories": ["nope"]}, "category_unknown"), ({"quietFrom": "23:00"}, "quiet_needs_both"),
                      ({"shopIds": ["x"]}, "ids_invalid"), ({"minAmount": -1}, "number_out_of_range")):
        with pytest.raises(RuleError) as err:
            P.clean(bad)
        assert err.value.code == code
    assert P.device_label("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1") == "Safari · iPhone"


# ── Who receives what ────────────────────────────────────────────────────────


def test_a_large_refund_reaches_the_owners_phone(w):
    phone = device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"categories": ["large_void"], "minAmount": 200})
    sent = run(w, entry(w, "refund", amount=Decimal("-450")))
    assert [d.status for d in sent] == ["sent"] and sent[0].subscription_id == phone.id and sent[0].user_id == w.admin.id
    payload = json.loads(W.decrypt(w.push.calls[0].content, phone._key, phone._auth))
    assert payload["title"].startswith("ביטול / זיכוי גדול") and payload["url"].startswith("/x/")
    assert "₪450" in payload["body"] and payload["tag"] == f"entry:{sent[0].entry_id}"
    # Under the minimum, another type: nothing.
    assert run(w, entry(w, "refund", amount=Decimal("150"))) == []
    assert run(w, entry(w, "till_offline")) == []
    assert len(w.push.calls) == 1


def test_only_what_the_owner_could_read_and_where_they_chose(w):
    north_manager = user(w, UserRole.SHOP_MANAGER, w.other_shop)
    cashier = user(w, UserRole.CASHIER, w.shop)
    for u in (north_manager, cashier):
        device(w, u)
        P.save_preferences(w.db, u, w.tenant.id, {})
    center = entry(w, "till_offline", severity="high")
    assert run(w, center) == []  # a manager of another shop, a cashier: never
    north = entry(w, "till_offline", shop=w.other_shop, machine=w.other_till)
    assert [d.user_id for d in run(w, north)] == [north_manager.id]

    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"shopIds": [str(w.other_shop.id)]})
    assert run(w, entry(w, "till_offline")) == []  # the admin chose North only
    event = make_event(w, tills=[w.tills[1]])
    P.save_preferences(w.db, w.admin, w.tenant.id, {"shopIds": None, "eventIds": [str(event.id)]})
    assert run(w, entry(w, "till_offline")) == []  # till 1 is not in the event
    in_event = entry(w, "till_offline", machine=w.tills[1])
    in_event.occurred_at = at(30)
    assert len(run(w, in_event, now=at(31))) == 1


def test_the_same_alert_never_twice_and_one_per_device(w):
    device(w, w.admin, "phone")
    device(w, w.admin, "laptop")
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    e = entry(w, "till_offline")
    assert len(run(w, e)) == 2
    assert run(w, e) == []
    assert len(pushes(w)) == 2


def test_the_rate_limit_and_quiet_hours_hold_back_then_one_digest(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"rateLimitMinutes": 10})
    assert run(w, entry(w, "till_offline"))[0].status == "sent"
    held = run(w, entry(w, "drawer_open"))
    assert held[0].status == "suppressed_rate_limit"
    run(w, entry(w, "refund", amount=Decimal("900")))
    # Within the window nothing goes; after it, one digest for both.
    assert E.flush_digests(w.db, now=NOW + timedelta(minutes=5)) == 0
    assert E.flush_digests(w.db, now=NOW + timedelta(minutes=11)) == 1
    digest = [d for d in pushes(w) if d.kind == "digest"]
    assert len(digest) == 1 and digest[0].digest_count == 2 and digest[0].status == "sent"
    assert E.flush_digests(w.db, now=NOW + timedelta(minutes=30)) == 0

    P.save_preferences(w.db, w.admin, w.tenant.id, {"quietFrom": "18:00", "quietTo": "23:00", "rateLimitMinutes": 0})
    quiet = run(w, entry(w, "till_offline"), now=NOW + timedelta(hours=1))  # 20:00 local
    assert quiet[0].status == "suppressed_quiet_hours"


def test_a_stale_alert_is_logged_not_sent(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    assert run(w, entry(w, "till_offline", minutes_ago=7 * 60))[0].status == "suppressed_stale"


def test_a_gone_device_is_turned_off(w):
    phone = device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    w.push.status = 410
    sent = run(w, entry(w, "till_offline"))
    assert sent[0].status == "failed"
    assert w.db.get(PushSubscription, phone.id).disabled_at is not None
    assert run(w, entry(w, "till_offline")) == []  # no device left


def test_a_failure_of_push_never_costs_the_sms_or_the_entry(w, monkeypatch):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    monkeypatch.setattr(P, "process_entry", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    e = entry(w, "till_offline")
    assert E.process_entry(w.db, e, now=NOW) == []
    assert w.db.get(ExceptionLogEntry, e.id) is not None


# ── The detections ───────────────────────────────────────────────────────────


def test_a_till_offline_during_a_shift_is_recorded_once_and_closed_when_back(w):
    till, other = w.tills
    w.shift(till, 1, status=ShiftStatus.OPEN)
    w.shift(other, 2, status=ShiftStatus.OPEN)
    till.last_heartbeat_at = NOW - timedelta(minutes=25)
    other.last_heartbeat_at = NOW - timedelta(minutes=5)   # under the 10 minutes
    w.other_till.last_heartbeat_at = NOW - timedelta(minutes=40)  # no open shift
    w.db.flush()
    assert TW.scan(w.db, now=NOW) == 1
    assert TW.scan(w.db, now=NOW + timedelta(minutes=1)) == 0
    rows = w.db.query(AuditException).filter(AuditException.exception_type == "till_offline").all()
    assert len(rows) == 1 and rows[0].machine_id == till.id and rows[0].severity == "high"
    till.last_heartbeat_at = NOW + timedelta(minutes=3)
    w.db.flush()
    assert TW.scan(w.db, now=NOW + timedelta(minutes=4)) == 1
    assert rows[0].details["backAt"] and rows[0].value == 28


def test_the_till_offline_rule_can_be_switched_off(w, monkeypatch):
    till = w.tills[0]
    w.shift(till, 1, status=ShiftStatus.OPEN)
    till.last_heartbeat_at = NOW - timedelta(minutes=30)
    w.db.flush()
    monkeypatch.setattr(TW, "threshold_of", lambda db, m: None)
    assert TW.scan(w.db, now=NOW) == 0


def test_a_target_reached_is_recorded_once_and_alerts(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"categories": ["target_reached"]})
    event = make_event(w, target=500)
    sale(w, w.tills[0], 10, "300")
    assert X.check_event_targets(w.db, now=at(20)) == 0
    sale(w, w.tills[1], 30, "250")
    assert X.check_event_targets(w.db, now=at(40)) == 1
    assert X.check_event_targets(w.db, now=at(41)) == 0
    reached = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "target_reached").one()
    assert reached.details["eventId"] == str(event.id) and reached.amount == Decimal("550.00")
    sent = pushes(w, status="sent")
    assert len(sent) == 1
    assert sent[0].entry_id == reached.id


def test_the_insights_hook_for_a_till_barely_selling_once_a_day(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"categories": ["till_low_sales"]})
    till = w.tills[1]
    first = X.report_till_low_sales(w.db, machine=till, business_day=date(2026, 9, 27), ratio_pct=22.5,
                                    net_per_hour=80, peers_median_per_hour=360, now=NOW)
    again = X.report_till_low_sales(w.db, machine=till, business_day=date(2026, 9, 27), ratio_pct=20, now=NOW)
    assert first.id == again.id and first.kind == "till_low_sales" and "מוכרת הרבה פחות" in first.summary
    assert len(pushes(w, status="sent")) == 1


# ── The routes ───────────────────────────────────────────────────────────────


def _req(ua="Mozilla/5.0 (Windows NT 10.0) Chrome/130.0"):
    return SimpleNamespace(headers={"user-agent": ua})


def test_subscribing_preferences_test_message_and_history(w, monkeypatch):
    _key, p256dh, auth = browser()
    with pytest.raises(HTTPException) as err:
        R.add_device(_req(), {"endpoint": "http://insecure", "keys": {"p256dh": p256dh, "auth": auth}},
                     current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 422
    out = R.add_device(_req(), {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": p256dh, "auth": auth}},
                       current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["label"] == "Chrome · Windows" and out["active"]
    prefs = R.get_preferences(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert prefs["exists"] and prefs["categories"] == list(P.CATEGORY_KEYS)  # the first device made them
    saved = R.put_preferences({"categories": ["till_offline"], "quietFrom": "23:00", "quietTo": "07:00"},
                              current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert saved["categories"] == ["till_offline"] and saved["quietTo"] == "07:00"
    monkeypatch.setattr(R, "_now", lambda: NOW)
    assert R.send_test(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db) == {"sent": 1}
    with pytest.raises(HTTPException) as err:
        R.send_test(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 429
    history = R.my_history(limit=10, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)["history"]
    assert history[0]["kind"] == "test" and history[0]["status"] == "sent" and history[0]["device"] == "Chrome · Windows"
    devices = R.list_devices(current_user=w.admin, db=w.db)["devices"]
    R.remove_device(uuid.UUID(devices[0]["id"]), current_user=w.admin, db=w.db)
    assert R.list_devices(current_user=w.admin, db=w.db)["devices"][0]["active"] is False
    other = user(w, UserRole.COMPANY_MANAGER)
    with pytest.raises(HTTPException) as err:
        R.remove_device(uuid.UUID(devices[0]["id"]), current_user=other, db=w.db)
    assert err.value.status_code == 404


def test_the_test_message_needs_push_configured(w, monkeypatch):
    monkeypatch.setattr(W, "config", lambda: None)
    with pytest.raises(HTTPException) as err:
        R.send_test(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 409
    assert R.get_push_config(current_user=w.admin)["enabled"] is False


def test_the_alerts_feed_is_scoped_and_acknowledged_in_place(w, monkeypatch):
    monkeypatch.setattr(R, "_now", lambda: NOW)
    if True:
        center = entry(w, "till_offline")
        north = entry(w, "drawer_open", shop=w.other_shop, machine=w.other_till)
        entry(w, "discount", amount=Decimal("10"))  # not a push type
        feed = R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=True,
                             days=2, limit=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert {a["id"] for a in feed["alerts"]} == {str(center.id), str(north.id)} and feed["open"] == 2
        manager = user(w, UserRole.SHOP_MANAGER, w.shop)
        mine = R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=True,
                             days=2, limit=50, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
        assert [a["id"] for a in mine["alerts"]] == [str(center.id)] and mine["alerts"][0]["categoryLabel"] == "קופה התנתקה"
        done = R.acknowledge_alert(center.id, {"note": "טופל בטלפון"}, current_user=manager,
                                   active_tenant_id=w.tenant.id, db=w.db)
        assert done["acknowledged"] is True and done["note"] == "טופל בטלפון"
        with pytest.raises(HTTPException) as err:
            R.acknowledge_alert(north.id, {}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
        assert err.value.status_code == 404
        cashier = user(w, UserRole.CASHIER, w.shop)
        with pytest.raises(HTTPException):
            R.acknowledge_alert(center.id, {}, current_user=cashier, active_tenant_id=w.tenant.id, db=w.db)


def test_a_tap_opens_the_log_only_for_who_may_read_it(w):
    from app.models.dashboard_access import DashboardAccessProfile

    alerts_only = user(w, UserRole.SHOP_MANAGER, w.shop)
    w.db.add(DashboardAccessProfile(user_id=alerts_only.id, full_access=False, sections={"alerts": "view"}))
    w.db.flush()
    phone = device(w, alerts_only)
    P.save_preferences(w.db, alerts_only, w.tenant.id, {})
    admin_phone = device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    run(w, entry(w, "till_offline"))
    by_endpoint = {c.endpoint: c for c in w.push.calls}
    mine = json.loads(W.decrypt(by_endpoint[phone.endpoint].content, phone._key, phone._auth))
    theirs = json.loads(W.decrypt(by_endpoint[admin_phone.endpoint].content, admin_phone._key, admin_phone._auth))
    assert mine["url"] == "/dashboard/alerts" and theirs["url"].startswith("/x/")


def test_a_shift_forgotten_open_overnight_is_not_trading(w):
    till = w.tills[0]
    w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=20))
    till.last_heartbeat_at = NOW - timedelta(minutes=30)
    w.db.flush()
    assert TW.scan(w.db, now=NOW) == 0


def test_only_the_browsers_push_services_and_ten_devices_a_user(w):
    for bad in ("https://evil.example.com/x", "https://127.0.0.1/x", "http://fcm.googleapis.com/x",
                "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x",
                "https://fcm.googleapis.com.evil.com/x", "https://push.apple.com.attacker.net/x"):
        assert P.push_service_endpoint(bad) is False, bad
    for good in ("https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
                 "https://web.push.apple.com/QAB", "https://wns2-db5p.notify.windows.com/w/?token=x"):
        assert P.push_service_endpoint(good) is True, good
    _key, p256dh, auth = browser()
    with pytest.raises(RuleError) as err:
        P.subscribe(w.db, w.admin, w.tenant.id, endpoint="https://evil.example.com/x", p256dh=p256dh, auth=auth)
    assert err.value.code == "endpoint_invalid"
    for i in range(12):
        device(w, w.admin, f"d{i}")
    active = w.db.query(PushSubscription).filter(PushSubscription.user_id == w.admin.id, PushSubscription.disabled_at.is_(None)).count()
    assert active == P.MAX_DEVICES


def test_the_first_device_narrows_to_where_it_subscribed_from(w):
    _key, p256dh, auth = browser()
    P.subscribe(w.db, w.admin, w.tenant.id, endpoint="https://fcm.googleapis.com/fcm/send/narrow", p256dh=p256dh, auth=auth,
                initial={"shopIds": [str(w.other_shop.id)]})
    prefs = P.as_json(P.rule_for_user(w.db, w.admin.id, w.tenant.id))
    assert prefs["shopIds"] == [str(w.other_shop.id)] and prefs["eventIds"] is None


def test_a_one_off_alert_never_replaces_another_on_the_phone(w):
    phone = device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"rateLimitMinutes": 0})
    run(w, entry(w, "refund", amount=Decimal("500")))
    run(w, entry(w, "refund", amount=Decimal("700")))
    run(w, entry(w, "till_offline"))
    tags = [json.loads(W.decrypt(c.content, phone._key, phone._auth))["tag"] for c in w.push.calls]
    assert tags[0] != tags[1] and tags[0].startswith("entry:") and tags[2].startswith("till_offline:")


def test_new_kinds_never_start_an_old_every_kind_sms_rule(w):
    from app.models.exception_alerts import ExceptionAlertRule

    rule = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="הכול", kinds=[],
                              min_severity="medium", recipients=[{"phone": "+972501234567"}])
    assert E.entry_matches(rule, SimpleNamespace(kind="till_offline", severity="high", amount=None, value=None)) is False
    assert E.entry_matches(rule, SimpleNamespace(kind="cash_difference", severity="high", amount=None, value=None)) is True
    rule.kinds = ["till_offline"]
    assert E.entry_matches(rule, SimpleNamespace(kind="till_offline", severity="high", amount=None, value=None)) is True


def test_sending_waits_for_the_commit_and_a_rollback_sends_nothing(w, monkeypatch):
    phone = device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    w.db.commit()
    queued = []
    monkeypatch.setattr(P, "SEND_MODE", "thread")
    monkeypatch.setattr(P, "_enqueue", lambda jobs: queued.extend(jobs))
    run(w, entry(w, "till_offline"))
    assert queued == []                       # not before the commit
    w.db.commit()
    assert len(queued) == 1 and queued[0]["subscriptionId"] == phone.id
    run(w, entry(w, "till_offline"))
    w.db.rollback()
    w.db.commit()
    assert len(queued) == 1                   # the rolled-back one is never sent


def test_who_may_mark_an_alert_handled_is_what_the_ack_route_lets_through(w, monkeypatch):
    """
    "טופל" — the coordinator, 09.10.2026: the branch managers handle the alerts. The feed's
    `canAcknowledge` says exactly what POST /push/alerts/{id}/ack lets through: "התראות" at edit
    (the route's section) and a role other than a cashier's / shift supervisor's — so the
    dashboard (the alerts page, the cockpit) never offers a button the server refuses.
    """
    from app.models.dashboard_access import DashboardAccessProfile
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    monkeypatch.setattr(R, "_now", lambda: NOW)

    def with_sections(role, sections):
        u = user(w, role, w.shop)
        w.db.add(DashboardAccessProfile(user_id=u.id, full_access=False, sections=dict(sections)))
        w.db.flush()
        DA.forget(w.db)
        return u

    def feed(u):
        return R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=True,
                             days=2, limit=50, current_user=u, active_tenant_id=w.tenant.id, db=w.db)

    ack_rule = DS.rule_for("POST", "/push/alerts/{entry_id}/ack")
    center = entry(w, "till_offline")

    # A branch manager (the template, alerts at edit): offered, and let through.
    manager = with_sections(UserRole.SHOP_MANAGER, DS.BRANCH_MANAGER_SECTIONS)
    assert DS.BRANCH_MANAGER_SECTIONS["alerts"] == "edit" and DS.AREA_MANAGER_SECTIONS["alerts"] == "edit"
    assert feed(manager)["canAcknowledge"] is True
    assert DA.check_rule(DA.effective_access(w.db, manager), ack_rule, "POST") is None
    done = R.acknowledge_alert(center.id, {}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert done["acknowledged"] is True

    # Alerts at view only: sees the feed (another open alert), is not offered "טופל", and the route refuses it.
    entry(w, "drawer_open")
    viewer = with_sections(UserRole.SHOP_MANAGER, {"alerts": "view"})
    out = feed(viewer)
    assert out["canAcknowledge"] is False and out["alerts"]
    refusal = DA.check_rule(DA.effective_access(w.db, viewer), ack_rule, "POST")
    assert refusal is not None and refusal.status_code == 403

    # The role check stays the server's too: a shift supervisor with the section is not offered it.
    supervisor = with_sections(UserRole.SHIFT_SUPERVISOR, {"alerts": "edit"})
    assert feed(supervisor)["canAcknowledge"] is False
    with pytest.raises(HTTPException) as err:
        R.acknowledge_alert(center.id, {}, current_user=supervisor, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403

    # The organization manager's default is unchanged: no alerts at all.
    assert "alerts" not in DS.ORG_MANAGER_SECTIONS
