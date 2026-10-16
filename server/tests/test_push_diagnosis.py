"""
"ההתראות לווינדוס ולאנדרואיד לא עובדות מ-PWA, תוסיף גם אופציה לבדיקת התראות" (fix/pwa-push, 16.10).

* **The server's keys, read forgivingly** (app/services/webpush.py `config`): quotes, standard
  base64, padding, a PEM or DER private key; the public key handed to browsers is always the one
  derived from the private key, and what was wrong is a code (`config_problem`), never a key.
* **The Topic header** is ASCII only (a Hebrew letter passed `str.isalnum()` and broke the header).
* **One browser = one device** (`device_key`): a browser that subscribes again replaces its older
  row instead of piling up beside it.
* **"בדיקת התראות"** (`POST /push/test`): this device or all of mine, sent now, the push service's
  status per device, 404 / 410 turn the device off, at most once per 30 s with the seconds left.
* **`pushsubscriptionchange`** (`POST /push/devices/renew`): the old endpoint and its auth secret
  move the row to the browser's new subscription; a removed device stays removed.
* **Why a phone got nothing is logged** (the service and the status — never the endpoint).

Runs on the in-memory SQLite world of tests/shift_world.py with a fake push service.
"""
from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException

from app.models.exception_alerts import ExceptionAlertDispatch, PushSubscription
from app.models.user import User, UserRole
from app.routers import push_alerts as R
from app.services import push_policy as PP
from app.services import webpush as W
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import push as P
from app.services.exception_alerts.rules import RuleError
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)


class FakePushService:
    def __init__(self, status=201, text=""):
        self.status = status
        self.text = text
        self.calls = []

    def post(self, endpoint, content, headers, timeout):
        self.calls.append(SimpleNamespace(endpoint=endpoint, content=content, headers=headers, timeout=timeout))
        status = self.status(endpoint) if callable(self.status) else self.status
        return SimpleNamespace(status_code=status, text=self.text, headers={})


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    private, public = W.generate_vapid_keys()
    world.public_key = public
    monkeypatch.setattr(W, "config", lambda: W.VapidConfig(public_key=public, private_key=private, subject="mailto:t@example.com"))
    world.push = FakePushService()
    monkeypatch.setattr(P, "SEND_MODE", "inline")
    monkeypatch.setattr(P, "TRANSPORT", world.push)
    monkeypatch.setattr(E, "now_fn", lambda: NOW)
    monkeypatch.setattr(R, "_now", lambda: NOW)
    return world


def browser():
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, W.b64u(public), W.b64u(uuid.uuid4().bytes)


def device(w, owner, name=None, *, key=None, ua="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0",
           host="fcm.googleapis.com/fcm/send"):
    private, p256dh, auth = browser()
    row = P.subscribe(w.db, owner, w.tenant.id, endpoint=f"https://{host}/{name or uuid.uuid4().hex}",
                      p256dh=p256dh, auth=auth, user_agent=ua, device_key=key)
    row._key, row._auth = private, auth
    return row


def other_user(w, role=UserRole.COMPANY_MANAGER):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
             email=f"{uuid.uuid4().hex[:8]}@example.com", username=uuid.uuid4().hex[:10], is_active=True)
    w.db.add(u)
    w.db.flush()
    return u


# ── The server's keys ────────────────────────────────────────────────────────


def _settings(monkeypatch, public="", private="", subject="mailto:ops@example.com", base=""):
    from app import config as C

    fake = SimpleNamespace(webpush_vapid_public_key=public, webpush_vapid_private_key=private,
                           webpush_vapid_subject=subject, exception_alerts_link_base_url=base,
                           pairing_mobile_app_base_url="")
    monkeypatch.setattr(C, "get_settings", lambda: fake)
    W._logged.clear()


def test_the_keys_are_read_forgivingly_and_the_public_key_is_always_the_derived_one(monkeypatch, caplog):
    private, public = W.generate_vapid_keys()
    padded_std = base64.b64encode(W.b64u_decode(public)).decode()  # standard alphabet, with padding
    for pasted_public, pasted_private in (
        (public, private),
        (f'"{public}"', f"'{private}'\n"),
        (padded_std, private + "="),
    ):
        _settings(monkeypatch, pasted_public, pasted_private)
        vapid = W.config()
        assert vapid is not None and vapid.public_key == public
        assert W.config_problem() is None

    # A PEM private key (as other tools write it), one-line with literal "\n" too, and base64 DER.
    key = W.private_key_from(private)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.TraditionalOpenSSL,
                            serialization.NoEncryption())
    for pasted in (pem, pem.replace("\n", "\\n"), base64.b64encode(der).decode()):
        _settings(monkeypatch, public, pasted)
        assert W.config().public_key == public

    # The public key of another pair: push stays on with the derived key, and it is logged once.
    _other_private, other_public = W.generate_vapid_keys()
    _settings(monkeypatch, other_public, private)
    caplog.set_level(logging.ERROR, logger=W.logger.name)
    monkeypatch.setattr(W.logger, "disabled", False)
    assert W.config().public_key == public and W.config_problem() == "public_key_mismatch"
    W.config()
    mismatch_logs = [r for r in caplog.records if "does not belong" in r.getMessage()]
    assert len(mismatch_logs) == 1
    assert private not in caplog.text and other_public not in caplog.text

    # No public key at all: derived.
    _settings(monkeypatch, "", private)
    assert W.config().public_key == public and W.config_problem() == "public_key_missing"


def test_push_is_off_without_a_readable_private_key_and_says_why(monkeypatch):
    _private, public = W.generate_vapid_keys()
    _settings(monkeypatch, public, "")
    assert W.config() is None and W.config_problem() == "missing_private_key"
    _settings(monkeypatch, public, "not-a-key")
    assert W.config() is None and W.config_problem() == "private_key_unreadable"
    # A P-384 key is not a VAPID key.
    p384 = ec.generate_private_key(ec.SECP384R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    _settings(monkeypatch, public, p384)
    assert W.config() is None and W.config_problem() == "private_key_unreadable"


def test_the_subject_falls_back_to_https_and_localhost_is_flagged(monkeypatch):
    private, _public = W.generate_vapid_keys()
    _settings(monkeypatch, "", private, subject="ops@example.com")
    assert W.config().subject == "mailto:ops@example.com"
    _settings(monkeypatch, "", private, subject="", base="https://pos-cloud-app.vercel.app")
    assert W.config().subject == "https://pos-cloud-app.vercel.app"
    _settings(monkeypatch, W.public_key_of(W.private_key_from(private)), private, subject="", base="http://localhost:3002")
    assert W.config().subject == "mailto:admin@localhost" and W.config_problem() == "subject_localhost"


def test_the_topic_header_is_ascii_only_and_the_reason_is_kept():
    private, public = W.generate_vapid_keys()
    vapid = W.VapidConfig(public, private, "mailto:x@example.com")
    _key, p256dh, auth = browser()
    svc = FakePushService(201)
    W.send("https://fcm.googleapis.com/fcm/send/a", p256dh, auth, {"title": "t"}, vapid=vapid, topic="קופה:till-1", client=svc)
    assert svc.calls[-1].headers["Topic"] == "till-1"
    W.send("https://fcm.googleapis.com/fcm/send/a", p256dh, auth, {"title": "t"}, vapid=vapid, topic="קופה", client=svc)
    assert "Topic" not in svc.calls[-1].headers
    refused = FakePushService(403, text="the key in the authorization header does not correspond\n to the sender")
    res = W.send("https://fcm.googleapis.com/fcm/send/a", p256dh, auth, {"title": "t"}, vapid=vapid, client=refused)
    assert not res.ok and res.status == 403 and not res.gone
    assert res.detail == "the key in the authorization header does not correspond to the sender"
    assert W.send("https://x", p256dh, auth, {}, vapid=vapid, client=svc, timeout=2) and svc.calls[-1].timeout == 2


def test_the_push_services_are_named():
    assert W.service_of("https://fcm.googleapis.com/fcm/send/x") == "fcm"
    assert W.service_of("https://wns2-par02p.notify.windows.com/w/?token=x") == "wns"
    assert W.service_of("https://updates.push.services.mozilla.com/wpush/v2/x") == "mozilla"
    assert W.service_of("https://web.push.apple.com/QAB") == "apple"
    assert W.service_of("https://notify.windows.com.evil.example/x") == "other"
    assert W.service_of("not a url") == "other"


# ── One browser, one device ──────────────────────────────────────────────────


def test_a_browser_that_subscribes_again_replaces_its_older_row(w):
    first = device(w, w.admin, key="browser-aaaaaaaa")
    laptop = device(w, w.admin, key="browser-bbbbbbbb")
    again = device(w, w.admin, key="browser-aaaaaaaa")  # a new endpoint, the same browser
    w.db.refresh(first)
    assert first.disabled_at is not None and first.last_error == P.REPLACED
    assert again.disabled_at is None and again.device_key == "browser-aaaaaaaa" and laptop.disabled_at is None
    # Someone else signing in on the same browser never turns my devices off.
    theirs = other_user(w)
    device(w, theirs, key="browser-bbbbbbbb")
    w.db.refresh(laptop)
    assert laptop.disabled_at is None
    # No id (an older dashboard): as before.
    assert device(w, w.admin).device_key is None
    with pytest.raises(RuleError) as err:
        device(w, w.admin, key="bad key!")
    assert err.value.code == "device_key_invalid"


def test_the_route_takes_the_browser_id(w):
    _key, p256dh, auth = browser()
    req = SimpleNamespace(headers={"user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/141.0 Mobile"})
    out = R.add_device(req, {"endpoint": "https://fcm.googleapis.com/fcm/send/r1", "keys": {"p256dh": p256dh, "auth": auth},
                             "deviceId": "0f3c9a2e-1111-4222-8333-944455556666"},
                       current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["label"] == "Chrome · Android" and out["service"] == "fcm" and out["failureCount"] == 0
    row = w.db.get(PushSubscription, uuid.UUID(out["id"]))
    assert row.device_key == "0f3c9a2e-1111-4222-8333-944455556666"


# ── "בדיקת התראות" ───────────────────────────────────────────────────────────


def _decrypt(row, call):
    return json.loads(W.decrypt(call.content, row._key, row._auth))


def test_the_test_goes_to_this_device_only_with_its_status(w):
    pc = device(w, w.admin, "pc")
    phone = device(w, w.admin, "phone", ua="Mozilla/5.0 (Linux; Android 14) Chrome/141.0 Mobile")
    out = R.send_test({"scope": "this", "endpointHash": pc.endpoint_hash},
                      current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["sent"] == 1 and out["delivered"] == 1 and len(w.push.calls) == 1
    (result,) = out["results"]
    assert result == {"deviceId": str(pc.id), "label": "Chrome · Windows", "service": "fcm", "thisDevice": True,
                      "ok": True, "status": 201, "error": None, "detail": None, "gone": False}
    assert w.push.calls[0].timeout == P.TEST_SEND_TIMEOUT  # sent in the request, with its own wait
    message = _decrypt(pc, w.push.calls[0])
    assert message["kind"] == "test" and message["tag"] == "test" and message["testId"] == out["testId"]
    assert "Chrome · Windows" in message["body"]
    assert w.db.get(PushSubscription, pc.id).last_success_at is not None
    assert w.db.get(PushSubscription, phone.id).last_success_at is None
    row = w.db.query(ExceptionAlertDispatch).filter(ExceptionAlertDispatch.kind == "test").one()
    assert row.status == "sent" and row.subscription_id == pc.id


def test_the_test_to_all_devices_reports_each_and_turns_a_gone_one_off(w, monkeypatch, caplog):
    pc = device(w, w.admin, "pc")
    edge = device(w, w.admin, "edge", host="wns2-par02p.notify.windows.com/w", ua="Mozilla/5.0 (Windows NT 10.0) Edg/141.0")
    w.push.status = lambda endpoint: 410 if "notify.windows.com" in endpoint else 201
    monkeypatch.setattr(P.logger, "disabled", False)
    caplog.set_level(logging.WARNING, logger=P.logger.name)
    out = R.send_test({"scope": "all", "endpointHash": pc.endpoint_hash},
                      current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    by_label = {r["label"]: r for r in out["results"]}
    assert out["sent"] == 2 and out["delivered"] == 1
    assert by_label["Chrome · Windows"]["thisDevice"] is True and by_label["Chrome · Windows"]["status"] == 201
    gone = by_label["Edge · Windows"]
    assert gone["ok"] is False and gone["status"] == 410 and gone["gone"] is True and gone["service"] == "wns"
    assert w.db.get(PushSubscription, edge.id).disabled_at is not None
    # The log says which service refused and why — never the endpoint.
    assert "wns answered 410" in caplog.text and "par02p" not in caplog.text and "turned off" in caplog.text


def test_the_test_needs_this_device_registered_and_waits_30_seconds(w, monkeypatch):
    pc = device(w, w.admin, "pc")
    with pytest.raises(HTTPException) as err:
        R.send_test({"scope": "this", "endpointHash": "0" * 64}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 422 and err.value.detail["code"] == "device_not_registered"
    with pytest.raises(HTTPException) as err:
        R.send_test({"scope": "everyone"}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 422
    R.send_test({"scope": "this", "endpointHash": pc.endpoint_hash}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    monkeypatch.setattr(R, "_now", lambda: NOW + timedelta(seconds=12))
    with pytest.raises(HTTPException) as err:
        R.send_test({"scope": "this", "endpointHash": pc.endpoint_hash}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 429 and err.value.detail["retryAfter"] == 18
    assert err.value.headers == {"Retry-After": "18"}
    monkeypatch.setattr(R, "_now", lambda: NOW + timedelta(seconds=31))
    assert R.send_test(None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)["delivered"] == 1


def test_the_test_says_why_push_is_off(w, monkeypatch):
    device(w, w.admin, "pc")
    monkeypatch.setattr(W, "config", lambda: None)
    monkeypatch.setattr(W, "config_problem", lambda: "private_key_unreadable")
    with pytest.raises(HTTPException) as err:
        R.send_test({"scope": "all"}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 409 and err.value.detail == {"code": "push_not_configured", "problem": "private_key_unreadable"}
    assert R.get_push_config(current_user=w.admin)["problem"] == "private_key_unreadable"


def test_a_refused_message_keeps_the_push_services_reason_on_the_device(w):
    pc = device(w, w.admin, "pc")
    w.push.status = 403
    w.push.text = "the key in the authorization header does not correspond to the sender ID used to subscribe"
    out = R.send_test({"scope": "this", "endpointHash": pc.endpoint_hash}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    (result,) = out["results"]
    assert result["status"] == 403 and result["error"] == "http_403" and result["detail"].startswith("the key")
    row = w.db.get(PushSubscription, pc.id)
    assert row.last_error.startswith("http_403: the key") and row.disabled_at is None and row.failure_count == 1
    # The device's state as the diagnosis reads it (GET /push/status).
    status = PP.status_for(w.db, w.admin, w.tenant.id, pc.endpoint_hash, now=NOW)
    assert status["thisDevice"]["lastError"].startswith("http_403") and status["thisDevice"]["service"] == "fcm"
    assert status["thisDevice"]["failing"] is True and status["thisDevice"]["label"] == "Chrome · Windows"
    assert "problem" in status


# ── pushsubscriptionchange ───────────────────────────────────────────────────


def _renew_body(old, endpoint):
    _key, p256dh, auth = browser()
    return {"oldEndpoint": old.endpoint, "oldAuth": old._auth, "endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}


def _req():
    return SimpleNamespace(client=SimpleNamespace(host=f"10.0.0.{uuid.uuid4().int % 250}"), headers={})


def test_the_service_worker_moves_a_device_to_its_new_subscription(w):
    pc = device(w, w.admin, "pc", key="browser-aaaaaaaa")
    out = R.renew_device(_req(), _renew_body(pc, "https://fcm.googleapis.com/fcm/send/pc-new"), db=w.db)
    row = w.db.get(PushSubscription, pc.id)
    assert out["ok"] and row.endpoint.endswith("/pc-new") and out["endpointHash"] == row.endpoint_hash
    assert row.user_id == w.admin.id and row.device_key == "browser-aaaaaaaa" and row.disabled_at is None


def test_a_renewal_needs_the_old_secret_and_never_revives_a_removed_device(w):
    pc = device(w, w.admin, "pc")
    wrong = {**_renew_body(pc, "https://fcm.googleapis.com/fcm/send/x"), "oldAuth": W.b64u(b"0" * 16)}
    with pytest.raises(HTTPException) as err:
        R.renew_device(_req(), wrong, db=w.db)
    assert err.value.status_code == 404
    with pytest.raises(HTTPException) as err:
        R.renew_device(_req(), _renew_body(pc, "https://evil.example.com/x"), db=w.db)
    assert err.value.status_code == 422
    # Removed by its user: stays removed.
    R.remove_device(pc.id, current_user=w.admin, db=w.db)
    with pytest.raises(HTTPException) as err:
        R.renew_device(_req(), _renew_body(pc, "https://fcm.googleapis.com/fcm/send/y"), db=w.db)
    assert err.value.status_code == 404
    # Gone at the push service (410): the browser's new subscription brings it back.
    phone = device(w, w.admin, "phone")
    phone.disabled_at, phone.last_error = NOW, "http_410"
    w.db.flush()
    R.renew_device(_req(), _renew_body(phone, "https://fcm.googleapis.com/fcm/send/phone-new"), db=w.db)
    assert w.db.get(PushSubscription, phone.id).disabled_at is None


def test_a_renewal_to_an_endpoint_the_page_registered_already_retires_the_old_row(w):
    old = device(w, w.admin, "old")
    new = device(w, w.admin, "new")
    R.renew_device(_req(), _renew_body(old, new.endpoint), db=w.db)
    assert w.db.get(PushSubscription, old.id).disabled_at is not None
    assert w.db.get(PushSubscription, new.id).disabled_at is None


def test_the_device_list_says_which_push_service_and_how_many_failures(w):
    device(w, w.admin, "edge", host="wns2-par02p.notify.windows.com/w", ua="Mozilla/5.0 (Windows NT 10.0) Edg/141.0")
    (d,) = R.list_devices(current_user=w.admin, db=w.db)["devices"]
    assert d["service"] == "wns" and d["label"] == "Edge · Windows" and d["failureCount"] == 0


# ── The migration ────────────────────────────────────────────────────────────


def test_the_migration_is_idempotent_additive_and_on_the_single_head():
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.config import Config
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    path = root / "alembic" / "versions" / "b8f2c6e4a9d1_push_subscription_device_key.py"
    spec = importlib.util.spec_from_file_location("migration_b8f2c6e4a9d1", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert (module.revision, module.down_revision) == ("b8f2c6e4a9d1", "e5a9c3d1f7b2")
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE push_subscriptions (id CHAR(32) PRIMARY KEY, user_id CHAR(32), endpoint TEXT)"))
        conn.execute(sa.text("INSERT INTO push_subscriptions (id, user_id, endpoint) VALUES ('a', 'u', 'https://x')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        insp = sa.inspect(conn)
        assert "device_key" in {c["name"] for c in insp.get_columns("push_subscriptions")}
        assert "ix_push_subscriptions_user_device" in {i["name"] for i in insp.get_indexes("push_subscriptions")}
        assert conn.execute(sa.text("SELECT device_key FROM push_subscriptions")).scalar() is None
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
        assert "device_key" not in {c["name"] for c in sa.inspect(conn).get_columns("push_subscriptions")}
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    (head,) = script.get_heads()
    assert "b8f2c6e4a9d1" in {r.revision for r in script.iterate_revisions(head, "base")}
