"""
"WhatsApp Business API" for "הפצה בוואטסאפ" (app/services/whatsapp_cloud.py) — with a mocked HTTP
client only: no test ever reaches Meta (an autouse fixture makes the real client impossible).

What each class pins:

* **The payload** — a template with the PDF as its document header and the body's variables in
  the configured order, sanitised as Meta takes them.
* **The client** — the media upload then the message, the bearer token in the header and nowhere
  else (never in an error, never in a repr); retries only what surely did not take effect
  (connection refused, 429, 5xx, Meta's "try later" codes) with backoff; a refusal fails at once;
  a timeout after the message left is never retried (`unknown_outcome`).
* **The webhook** — Meta's signature (HMAC-SHA256 of the raw body with the app secret) or 403; the
  subscription handshake by the verify token; statuses move a recipient forward only, and only
  a recipient of that config's company.
* **The queue** — off unless the server's switch and the company's configuration say so; a send
  marks the recipient sent by the API with WhatsApp's message id; transient failures come back
  later (`ROUND_BACKOFF`) at most `MAX_ROUNDS` times, then fail; a send interrupted mid-call is not
  retried blindly.
* **The configuration** — secrets encrypted at rest, write-only ("••••" keeps, "" removes), never
  returned; enabling needs a complete configuration; the company's managers only.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.models.voucher_distribution import VoucherDistributionEvent, VoucherDistributionRecipient, WhatsAppCloudConfig
from app.routers import voucher_distribution as R
from app.schemas.voucher_distribution import DistributionApiSendIn, WhatsAppConfigIn
from app.services import prepaid_voucher_pdf as PDF
from app.services import voucher_distribution as VD
from app.services import whatsapp_cloud as WA
from app.services.notifications import crypto
from test_prepaid_vouchers import _ctx, refused, w  # noqa: F401 — `w` is the fixture
from test_voucher_distribution import PEOPLE, do_import, make, recipients

FAKE_BEARER = "fake-bearer-for-tests-0123456789"
FAKE_SIGNER = "fake-signer-for-tests"


@pytest.fixture(autouse=True)
def no_real_http(monkeypatch):
    """No real HTTP client can be made in this file: a test that forgets its mock fails loudly."""
    def refuse():
        raise AssertionError("a real HTTP client was requested in a test")

    monkeypatch.setattr(WA, "_make_http", refuse)
    monkeypatch.setattr(WA, "HTTP_FACTORY", refuse)


def settings(enabled=True):
    return SimpleNamespace(
        voucher_link_base_url="https://api.example.test", public_base_url="",
        whatsapp_cloud_api_enabled=enabled, whatsapp_worker_enabled=True,
        whatsapp_graph_base_url="https://graph.example.test", whatsapp_graph_api_version="v23.0",
    )


class Meta:
    """A fake Graph API: records every request, answers from a script per endpoint."""

    def __init__(self):
        self.requests = []
        self.media = []
        self.messages = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/media"):
            step = self.media.pop(0) if self.media else ("ok", None)
            return self._answer(step, {"id": f"media-{len(self.requests)}"})
        step = self.messages.pop(0) if self.messages else ("ok", None)
        return self._answer(step, {"messaging_product": "whatsapp", "messages": [{"id": f"wamid.{len(self.requests)}"}]})

    @staticmethod
    def _answer(step, ok_body):
        kind, arg = step
        if kind == "ok":
            return httpx.Response(200, json=ok_body)
        if kind == "status":
            status, code = arg
            return httpx.Response(status, json={"error": {"code": code, "message": "boom", "error_user_title": "נכשל"}})
        raise arg  # an httpx exception

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def wa_client(meta: Meta, sleeps=None) -> WA.WhatsAppCloudClient:
    return WA.WhatsAppCloudClient(
        phone_number_id="1234567890", access_token=FAKE_BEARER, api_version="v23.0",
        base_url="https://graph.example.test", http=meta.client(),
        sleep=(sleeps.append if sleeps is not None else (lambda s: None)),
    )


# ── The payload ──────────────────────────────────────────────────────────────


class TestPayload:
    def test_template_with_the_pdf_as_document_header_and_the_body_in_order(self):
        payload = WA.template_payload(
            to="972501234567", template_name="voucher_delivery", language="he", media_id="m-1",
            filename="פסטיבל_0001-0003.pdf", body=["דנה", "פסטיבל הקיץ"],
        )
        assert payload == {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": "972501234567",
            "type": "template",
            "template": {
                "name": "voucher_delivery",
                "language": {"code": "he"},
                "components": [
                    {"type": "header", "parameters": [
                        {"type": "document", "document": {"id": "m-1", "filename": "פסטיבל_0001-0003.pdf"}},
                    ]},
                    {"type": "body", "parameters": [
                        {"type": "text", "text": "דנה"}, {"type": "text", "text": "פסטיבל הקיץ"},
                    ]},
                ],
            },
        }

    def test_no_body_variables_no_body_component(self):
        payload = WA.template_payload(to="1", template_name="t", language="he", media_id="m", filename="f.pdf", body=[])
        assert [c["type"] for c in payload["template"]["components"]] == ["header"]

    def test_variables_as_meta_takes_them(self):
        assert WA.param_text("שורה\nשנייה\t  וגם     רווחים") == "שורה · שנייה · וגם רווחים"
        assert WA.param_text("") == "-" and WA.param_text(None) == "-"
        assert len(WA.param_text("א" * 2000)) == 1024
        values = {"name": "דנה", "event": "פסטיבל", "count": 3, "link": "https://x/v/T"}
        assert WA.body_values(None, values) == ["דנה", "פסטיבל"]
        assert WA.body_values(["count", "link", "group"], values) == ["3", "https://x/v/T", "-"]


# ── The client ───────────────────────────────────────────────────────────────


class TestClient:
    def test_upload_then_send_with_the_token_in_the_header(self):
        meta = Meta()
        c = wa_client(meta)
        media = c.upload_media(b"%PDF-1.4 x", "v.pdf")
        wamid = c.send_message({"to": "972501234567"})
        assert (media, wamid) == ("media-1", "wamid.2")
        up, send = meta.requests
        assert str(up.url) == "https://graph.example.test/v23.0/1234567890/media"
        assert str(send.url) == "https://graph.example.test/v23.0/1234567890/messages"
        assert up.headers["authorization"] == send.headers["authorization"] == f"Bearer {FAKE_BEARER}"
        body = up.read()
        assert b'name="messaging_product"' in body and b"whatsapp" in body and b"application/pdf" in body
        assert b"%PDF-1.4 x" in body
        assert json.loads(send.read()) == {"to": "972501234567"}

    def test_retries_what_surely_did_not_take_effect_with_backoff(self):
        meta = Meta()
        meta.messages = [("status", (503, 1)), ("status", (429, 130429)), ("ok", None)]
        sleeps = []
        assert wa_client(meta, sleeps).send_message({}) == "wamid.3"
        assert sleeps == [0.5, 1.5]

    def test_gives_up_after_its_attempts_as_transient(self):
        meta = Meta()
        meta.messages = [("status", (429, 130429))] * 3
        with pytest.raises(WA.CloudApiError) as e:
            wa_client(meta).send_message({})
        assert (e.value.transient, e.value.code, e.value.http_status) == (True, "130429", 429)
        assert len(meta.requests) == WA.CALL_ATTEMPTS

    def test_a_refusal_fails_at_once(self):
        meta = Meta()
        meta.messages = [("status", (400, 132000))]  # wrong number of template parameters
        with pytest.raises(WA.CloudApiError) as e:
            wa_client(meta).send_message({})
        assert (e.value.transient, e.value.code, e.value.message) == (False, "132000", "נכשל")
        assert len(meta.requests) == 1

    def test_a_timeout_after_the_message_left_is_never_retried(self):
        meta = Meta()
        meta.messages = [("raise", httpx.ReadTimeout("slow"))]
        with pytest.raises(WA.CloudApiError) as e:
            wa_client(meta).send_message({})
        assert (e.value.code, e.value.transient) == ("unknown_outcome", False)
        assert len(meta.requests) == 1
        # An upload is safe to repeat; a refused connection always is.
        meta = Meta()
        meta.media = [("raise", httpx.ReadTimeout("slow")), ("raise", httpx.ConnectError("refused")), ("ok", None)]
        assert wa_client(meta).upload_media(b"x", "v.pdf") == "media-3"

    def test_the_token_is_never_in_an_error_or_a_repr(self):
        meta = Meta()
        meta.messages = [("status", (401, 190))]
        with pytest.raises(WA.CloudApiError) as e:
            wa_client(meta).send_message({})
        assert FAKE_BEARER not in str(e.value) and FAKE_BEARER not in repr(e.value)
        assert FAKE_BEARER not in repr(wa_client(meta))


# ── The webhook ──────────────────────────────────────────────────────────────


def status_payload(*statuses, phone_number_id="1234567890"):
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": "972500000000", "phone_number_id": phone_number_id},
            "statuses": list(statuses),
        }}]}],
    }


def st(wamid, status, ts=1760000000, **extra):
    return {"id": wamid, "status": status, "timestamp": str(ts), "recipient_id": "972501234567", **extra}


class TestWebhookParsing:
    def test_signature(self):
        body = b'{"a":1}'
        good = WA.signature_for(FAKE_SIGNER, body)
        assert good.startswith("sha256=") and WA.verify_signature(FAKE_SIGNER, body, good)
        assert not WA.verify_signature(FAKE_SIGNER, body + b" ", good)
        assert not WA.verify_signature("other", body, good)
        assert not WA.verify_signature(None, body, good) and not WA.verify_signature(FAKE_SIGNER, body, None)

    def test_statuses_parsed_and_anything_else_ignored(self):
        payload = status_payload(
            st("wamid.A", "sent"), st("wamid.A", "delivered"), st("wamid.B", "read"),
            st("wamid.C", "failed", errors=[{"code": 131026, "title": "Message undeliverable"}]),
            st("wamid.D", "deleted"), {"no": "id"},
        )
        payload["entry"][0]["changes"].append({"field": "messages", "value": {"messages": [{"from": "1", "text": {"body": "hi"}}]}})
        out = WA.parse_statuses(payload)
        assert [(u.message_id, u.status) for u in out] == [
            ("wamid.A", "sent"), ("wamid.A", "delivered"), ("wamid.B", "read"), ("wamid.C", "failed"),
        ]
        assert (out[3].error_code, out[3].error_title) == ("131026", "Message undeliverable")
        assert out[0].timestamp == datetime.fromtimestamp(1760000000, tz=timezone.utc)
        assert WA.parse_statuses(None) == [] and WA.parse_statuses({"entry": None}) == []


# ── With a batch ─────────────────────────────────────────────────────────────


@pytest.fixture
def api_on(monkeypatch):
    monkeypatch.setattr(VD, "distribution_settings", lambda: settings(True))
    meta = Meta()
    monkeypatch.setattr(WA, "HTTP_FACTORY", meta.client)
    monkeypatch.setattr(PDF, "load_logo", lambda url: None)
    monkeypatch.setattr(PDF, "render_pdf", lambda batch, vouchers, g, **kw: b"%PDF-stub " + ",".join(str(v.serial) for v in vouchers).encode())
    monkeypatch.setattr(WA.time, "sleep", lambda s: None)
    return meta


def configure(w, **extra):
    body = dict(phoneNumberId="1234567890", templateName="voucher_delivery", templateLanguage="he",
                accessToken=FAKE_BEARER, appSecret=FAKE_SIGNER, enabled=True)
    body.update(extra)
    return R.put_whatsapp_config(WhatsAppConfigIn(**body), company_id=str(w.company.id), **_ctx(w))


def recipient_row(w, rid) -> VoucherDistributionRecipient:
    w.db.expire_all()
    return w.db.query(VoucherDistributionRecipient).filter_by(id=uuid.UUID(rid)).one()


class TestConfig:
    def test_secrets_are_encrypted_write_only_and_never_returned(self, w, api_on):
        out = configure(w)
        assert out["accessTokenSet"] and out["appSecretSet"] and out["ready"]
        assert FAKE_BEARER not in json.dumps(out) and FAKE_SIGNER not in json.dumps(out)
        cfg = w.db.query(WhatsAppCloudConfig).one()
        assert FAKE_BEARER not in cfg.access_token_ciphertext and crypto.decrypt_text(cfg.access_token_ciphertext) == FAKE_BEARER
        assert out["webhookUrl"] == f"https://api.example.test/api/v1/public/whatsapp/webhook/{cfg.id}"
        assert out["verifyToken"] and len(out["verifyToken"]) >= 20
        # The dashboard's mask echoed back keeps it; "" removes it (and the API is no longer ready).
        configure(w, accessToken="••••••••", appSecret="••••")
        assert crypto.decrypt_text(w.db.query(WhatsAppCloudConfig).one().access_token_ciphertext) == FAKE_BEARER
        out = R.put_whatsapp_config(WhatsAppConfigIn(accessToken="", enabled=False), company_id=str(w.company.id), **_ctx(w))
        assert not out["accessTokenSet"] and not out["configured"]

    def test_enabling_needs_a_complete_configuration_and_fields_are_checked(self, w, api_on):
        e = refused(R.put_whatsapp_config, WhatsAppConfigIn(templateName="x", enabled=True), company_id=str(w.company.id), **_ctx(w))
        assert (e.status_code, e.detail) == (409, WA.API_NOT_CONFIGURED)
        for bad in (dict(templateName="Bad Name!"), dict(phoneNumberId="12ab"), dict(templateLanguage="hebrew"),
                    dict(bodyParams=["name", "password"]), dict(apiVersion="23")):
            assert refused(configure, w, **bad).status_code == 400

    def test_only_the_companys_managers(self, w, api_on):
        assert refused(R.get_whatsapp_config, company_id=str(w.company.id), **_ctx(w, w.cashier)).status_code == 403
        assert refused(R.get_whatsapp_config, company_id=str(w.company.id), **_ctx(w, w.manager)).status_code == 403
        assert refused(R.get_whatsapp_config, company_id=str(uuid.uuid4()), **_ctx(w)).status_code == 404

    def test_off_by_default(self):
        assert VD.DistributionSettings.model_fields["whatsapp_cloud_api_enabled"].default is False


class TestQueue:
    def test_refused_while_the_server_or_the_company_has_it_off(self, w, monkeypatch):
        monkeypatch.setattr(VD, "distribution_settings", lambda: settings(False))
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="one")
        e = refused(R.send_by_api, batch["id"], None, **_ctx(w))
        assert (e.status_code, e.detail) == (409, WA.API_DISABLED)
        monkeypatch.setattr(VD, "distribution_settings", lambda: settings(True))
        e = refused(R.send_by_api, batch["id"], None, **_ctx(w))
        assert (e.status_code, e.detail) == (409, WA.API_NOT_CONFIGURED)
        assert VD.distribution_out(w.db, w.db.query(VD.PrepaidVoucherBatch).one())["api"] == {
            "serverEnabled": True, "configured": False, "enabled": False, "ready": False,
        }

    def test_a_send_uploads_their_pdf_and_marks_them_sent_by_the_api(self, w, api_on):
        configure(w, bodyParams=["name", "event", "count", "link"])
        batch = make(w, count=4)
        do_import(w, batch, PEOPLE[:2], mode="count", perRecipient=2)
        out = R.send_by_api(batch["id"], None, **_ctx(w))
        assert out == {"queued": 2, "accepted": 2, "retry": 0, "failed": 0}
        uploads = [r for r in api_on.requests if r.url.path.endswith("/media")]
        sends = [json.loads(r.read()) for r in api_on.requests if r.url.path.endswith("/messages")]
        assert b"%PDF-stub 1,2" in uploads[0].read() and b"%PDF-stub 3,4" in uploads[1].read()
        assert [s["to"] for s in sends] == ["972501234567", "972521234567"]
        body = [p["text"] for p in sends[0]["template"]["components"][1]["parameters"]]
        item = recipients(w, batch)["items"][0]
        assert body == ["דנה", "פסטיבל הקיץ", "2", item["link"]]
        assert sends[0]["template"]["components"][0]["parameters"][0]["document"]["filename"] == "פסטיבל הקיץ_0001-0002.pdf"
        assert (item["state"], item["sentVia"], item["sentByName"], item["api"]["status"]) == ("sent", "api", "admin", "accepted")
        assert recipient_row(w, item["id"]).api_message_id == "wamid.2"
        # Only pending ones: a second press sends nothing again.
        assert R.send_by_api(batch["id"], None, **_ctx(w))["queued"] == 0

    def test_transient_failures_come_back_later_then_fail(self, w, api_on):
        configure(w)
        batch = make(w, count=1)
        do_import(w, batch, PEOPLE[:1], mode="one")
        rid = recipients(w, batch)["items"][0]["id"]
        api_on.messages = [("status", (503, 2))] * (WA.CALL_ATTEMPTS * WA.MAX_ROUNDS)
        out = R.send_by_api(batch["id"], DistributionApiSendIn(recipientIds=[rid]), **_ctx(w))
        assert out["retry"] == 1
        r = recipient_row(w, rid)
        assert (r.api_status, r.api_attempts, r.status) == ("retry", 1, "pending")
        now = datetime.now(timezone.utc)
        for round_ in range(2, WA.MAX_ROUNDS + 1):
            # Not before its time …
            assert WA.process_due(w.db, now=now)["retry"] == 0
            now = now + WA.ROUND_BACKOFF[min(round_ - 2, len(WA.ROUND_BACKOFF) - 1)] + timedelta(seconds=1)
            WA.process_due(w.db, now=now)
        r = recipient_row(w, rid)
        assert (r.api_status, r.status, r.api_attempts) == ("failed", "failed", WA.MAX_ROUNDS)
        assert r.failure_reason.startswith("2")
        actions = [e.action for e in w.db.query(VoucherDistributionEvent).filter_by(recipient_id=r.id).order_by(VoucherDistributionEvent.created_at)]
        assert actions.count("api_retry") == WA.MAX_ROUNDS - 1 and actions[-1] == "api_failed"

    def test_a_refusal_fails_with_metas_code(self, w, api_on):
        configure(w)
        batch = make(w, count=1)
        do_import(w, batch, PEOPLE[:1], mode="one")
        api_on.messages = [("status", (400, 132001))]  # template does not exist
        assert R.send_by_api(batch["id"], None, **_ctx(w))["failed"] == 1
        item = recipients(w, batch)["items"][0]
        assert item["state"] == "failed" and item["failureReason"] == "132001: נכשל"

    def test_an_interrupted_send_is_not_retried_blindly(self, w, api_on):
        configure(w)
        batch = make(w, count=1)
        do_import(w, batch, PEOPLE[:1], mode="one")
        r = w.db.query(VoucherDistributionRecipient).one()
        r.api_status, r.api_lease_until, r.api_attempts = "sending", datetime.now(timezone.utc) - timedelta(minutes=1), 1
        w.db.commit()
        WA.process_due(w.db)
        r = recipient_row(w, str(r.id))
        assert (r.api_status, r.status) == ("failed", "failed") and r.api_last_error.startswith("unknown_outcome")
        assert not api_on.requests

    def test_the_worker_does_nothing_while_the_server_has_it_off(self, monkeypatch):
        monkeypatch.setattr(VD, "distribution_settings", lambda: settings(False))
        assert WA.start_background_worker(lambda: None) is None


# ── The webhook routes ───────────────────────────────────────────────────────


def post(body: bytes, headers: dict) -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()], "client": ("198.51.100.9", 443),
    }, receive)


def get() -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "query_string": b"", "headers": [],
                    "client": (f"198.51.100.{uuid.uuid4().int % 200}", 443)})


class TestWebhookRoutes:
    def _sent(self, w, api_on):
        configure(w)
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:2], mode="one")
        R.send_by_api(batch["id"], None, **_ctx(w))
        cfg = w.db.query(WhatsAppCloudConfig).one()
        items = recipients(w, batch)["items"]
        wamids = [recipient_row(w, i["id"]).api_message_id for i in items]
        return cfg, batch, items, wamids

    def deliver(self, w, cfg, payload, secret=FAKE_SIGNER):
        raw = json.dumps(payload).encode()
        return asyncio.run(R.whatsapp_webhook(str(cfg.id), post(raw, {"X-Hub-Signature-256": WA.signature_for(secret, raw)}), db=w.db))

    def test_the_handshake_needs_the_verify_token(self, w, api_on):
        configure(w)
        cfg = w.db.query(WhatsAppCloudConfig).one()
        token = crypto.decrypt_text(cfg.verify_token_ciphertext)
        ok = R.whatsapp_webhook_verify(str(cfg.id), get(), mode="subscribe", verify_token=token, challenge="12345", db=w.db)
        assert ok.body == b"12345"
        for mode, vt in (("subscribe", "wrong"), ("unsubscribe", token), ("subscribe", None)):
            with pytest.raises(HTTPException) as e:
                R.whatsapp_webhook_verify(str(cfg.id), get(), mode=mode, verify_token=vt, challenge="1", db=w.db)
            assert e.value.status_code == 403

    def test_statuses_move_forward_only(self, w, api_on):
        cfg, batch, items, wamids = self._sent(w, api_on)
        out = self.deliver(w, cfg, status_payload(st(wamids[0], "delivered", 1760000100), st(wamids[0], "read", 1760000200),
                                                  st(wamids[1], "failed", errors=[{"code": 131026, "title": "Message undeliverable"}])))
        assert out == {"ok": True, "updated": 3}
        a, b = (recipient_row(w, i["id"]) for i in items)
        assert (a.status, a.read_at.replace(tzinfo=timezone.utc).timestamp()) == ("read", 1760000200)
        assert (b.status, b.failure_reason) == ("failed", "131026 Message undeliverable")
        # A late "delivered" and a repeated "read" change nothing; "failed" after delivery is ignored.
        out = self.deliver(w, cfg, status_payload(st(wamids[0], "delivered", 1760000300), st(wamids[0], "read"),
                                                  st(wamids[0], "failed")))
        assert out["updated"] == 0 and recipient_row(w, items[0]["id"]).status == "read"
        assert recipients(w, batch, state="read")["items"][0]["id"] == items[0]["id"]

    def test_a_bad_signature_is_refused_and_changes_nothing(self, w, api_on):
        cfg, batch, items, wamids = self._sent(w, api_on)
        with pytest.raises(HTTPException) as e:
            self.deliver(w, cfg, status_payload(st(wamids[0], "read")), secret="forged")
        assert e.value.status_code == 403
        raw = json.dumps(status_payload(st(wamids[0], "read"))).encode()
        with pytest.raises(HTTPException):
            asyncio.run(R.whatsapp_webhook(str(cfg.id), post(raw, {}), db=w.db))
        assert recipient_row(w, items[0]["id"]).status == "sent"

    def test_another_phone_number_or_company_moves_nothing(self, w, api_on):
        cfg, batch, items, wamids = self._sent(w, api_on)
        assert self.deliver(w, cfg, status_payload(st(wamids[0], "read"), phone_number_id="999999999"))["updated"] == 0
        # A config of another company never touches this company's recipients.
        from app.models.company import Company

        company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="חברה אחרת")
        w.db.add(company)
        w.db.flush()
        other = WhatsAppCloudConfig(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=company.id, enabled=False,
                                    template_language="he", app_secret_ciphertext=crypto.encrypt_text(FAKE_SIGNER))
        w.db.add(other)
        w.db.commit()
        assert self.deliver(w, other, status_payload(st(wamids[0], "read")))["updated"] == 0
        assert recipient_row(w, items[0]["id"]).status == "sent"
