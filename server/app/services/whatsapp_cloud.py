"""
"WhatsApp Business API" for "הפצה בוואטסאפ" — the official WhatsApp Cloud API (Meta), optional.

Every recipient gets an approved **template** message whose header is a **document** (their PDF)
and whose body variables are filled from the batch and the recipient (`body_params`, in order:
{{1}} = name, {{2}} = event … by default). Statuses (sent / delivered / read / failed) come back
by **webhook**; transient failures are **retried**.

* **Off by default, twice.** The server's switch `WHATSAPP_CLOUD_API_ENABLED` (env, off) must be
  on, and the company must have configured and enabled it (phone number id, access token,
  template). With either off, no request is ever made to Meta — the dashboard explains what is
  missing. WhatsApp *Web* is never automated (unofficial, against WhatsApp's terms).
* **Secrets are write-only.** The access token and the app secret are encrypted at rest with
  the payment-secrets key (app/services/notifications/crypto.py — the existing pattern), never
  returned to the dashboard ("set" / "not set" only), never logged, never in an error message.
* **Sending** a recipient: their PDF is uploaded (`POST /{phone-number-id}/media`) and the template
  sent with the media id (`POST /{phone-number-id}/messages`). Within one call the client retries a
  request that surely did not take effect (connection refused, 429, 5xx, Meta's "try later"
  codes) with backoff; a recipient whose send still failed that way is retried later by the
  worker (`ROUND_BACKOFF`), at most `MAX_ROUNDS` times; anything else fails at once, with Meta's
  code and title. A send whose outcome is unknown (a timeout after the request left, a crash
  while sending) is never retried blindly: it fails as `unknown_outcome` for a person to check.
* **Leases.** Due rows are claimed `FOR UPDATE SKIP LOCKED` and marked `sending` before any call,
  so two API processes never send the same recipient; the provider is called outside any open
  transaction.
* **The webhook** (`/public/whatsapp/webhook/{config id}`): the subscription handshake checks the
  verify token; every POST must carry Meta's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body
  with the app secret) — without an app secret configured, the webhook accepts nothing. A status
  only moves a recipient forward (a late "delivered" never undoes "read"), and only a recipient
  of that config's company.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

import httpx
from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.user import User
from app.models.voucher_distribution import VoucherDistributionRecipient, WhatsAppCloudConfig
from app.services import voucher_distribution as VD
from app.services.notifications import crypto

logger = logging.getLogger(__name__)

#: What a template's body variables may be filled with, in the order the template numbers them.
BODY_PARAM_KEYS = ("name", "event", "count", "serials", "link", "validUntil", "group")
DEFAULT_BODY_PARAMS = ["name", "event"]
LANGUAGE = re.compile(r"^[a-z]{2,3}(_[A-Z]{2})?$")
TEMPLATE_NAME = re.compile(r"^[a-z0-9_]{1,128}$")
IDENTIFIER = re.compile(r"^\d{5,32}$")
API_VERSION = re.compile(r"^v\d{1,2}\.\d$")

#: HTTP statuses after which the request surely did not take effect.
TRANSIENT_HTTP = frozenset({429, 500, 502, 503, 504})
#: Meta's error codes that mean "try again later" (rate limits, a temporary outage).
TRANSIENT_META_CODES = frozenset({1, 2, 4, 80007, 130429, 131016, 131048, 131056, 133004})
#: Retries inside one call, and the pause before each (seconds).
CALL_ATTEMPTS = 3
CALL_BACKOFF = (0.5, 1.5)
#: Rounds a recipient is tried in all (the worker's retries), and the pause before each next one.
MAX_ROUNDS = 4
ROUND_BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=30))
LEASE = timedelta(minutes=5)
#: Sent inside the dashboard's request at once; the rest waits for the worker.
INLINE_LIMIT = 10
WORKER_INTERVAL_SECONDS = 30

API_DISABLED = "whatsapp_api_disabled"
API_NOT_CONFIGURED = "whatsapp_api_not_configured"
CONFIG_INVALID = "whatsapp_config_invalid"
MASK_CHARS = frozenset("•*●·")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Errors ────────────────────────────────────────────────────────────────────


class CloudApiError(Exception):
    """A refused or failed call. [transient]: worth trying again later. Never carries the token."""

    def __init__(self, code: str, message: str = "", *, http_status: Optional[int] = None, transient: bool = False):
        super().__init__(f"{code}: {message}".strip(": "))
        self.code = code
        self.message = message
        self.http_status = http_status
        self.transient = transient


def _meta_error(resp: httpx.Response) -> CloudApiError:
    code, title = str(resp.status_code), ""
    try:
        err = (resp.json() or {}).get("error") or {}
        if err.get("code") is not None:
            code = str(err.get("code"))
        title = str(err.get("error_user_title") or err.get("title") or err.get("message") or "")[:200]
        meta_code = int(err.get("code")) if str(err.get("code") or "").isdigit() else None
    except ValueError:
        meta_code = None
    transient = resp.status_code in TRANSIENT_HTTP or (meta_code in TRANSIENT_META_CODES)
    return CloudApiError(code, title, http_status=resp.status_code, transient=transient)


# ── The client ────────────────────────────────────────────────────────────────


class WhatsAppCloudClient:
    """
    The two calls a send needs. [http] is an `httpx.Client` (tests give one on a
    `MockTransport`: no request ever leaves a test). [sleep] is the pause between retries.
    """

    def __init__(
        self,
        *,
        phone_number_id: str,
        access_token: str,
        api_version: str,
        base_url: str,
        http: httpx.Client,
        sleep: Callable[[float], None] = time.sleep,
        attempts: int = CALL_ATTEMPTS,
    ):
        self.phone_number_id = phone_number_id
        self._token = access_token
        self.api_version = api_version
        self.base_url = base_url.rstrip("/")
        self.http = http
        self.sleep = sleep
        self.attempts = max(1, attempts)

    def __repr__(self) -> str:  # never the token
        return f"WhatsAppCloudClient(phone_number_id={self.phone_number_id!r}, api_version={self.api_version!r})"

    def _url(self, what: str) -> str:
        return f"{self.base_url}/{self.api_version}/{self.phone_number_id}/{what}"

    def _post(self, what: str, *, idempotent: bool, **kwargs) -> Dict[str, Any]:
        last: Optional[CloudApiError] = None
        for attempt in range(1, self.attempts + 1):
            try:
                resp = self.http.post(self._url(what), headers={"Authorization": f"Bearer {self._token}"}, **kwargs)
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # The request never left: always safe to try again.
                last = CloudApiError("connect_failed", type(exc).__name__, transient=True)
            except httpx.TimeoutException as exc:
                if not idempotent:
                    # It may have left: a second message is worse than a person checking.
                    raise CloudApiError("unknown_outcome", type(exc).__name__, transient=False) from None
                last = CloudApiError("timeout", type(exc).__name__, transient=True)
            except httpx.HTTPError as exc:
                raise CloudApiError("http_error", type(exc).__name__, transient=False) from None
            else:
                if resp.status_code < 300:
                    try:
                        return resp.json() or {}
                    except ValueError:
                        raise CloudApiError("bad_response", "not JSON", http_status=resp.status_code) from None
                last = _meta_error(resp)
                if not last.transient:
                    raise last
            logger.warning("WhatsApp Cloud API %s attempt %s/%s failed: %s", what, attempt, self.attempts, last.code)
            if attempt < self.attempts:
                self.sleep(CALL_BACKOFF[min(attempt - 1, len(CALL_BACKOFF) - 1)])
        assert last is not None
        raise last

    def upload_media(self, data: bytes, filename: str, mime: str = "application/pdf") -> str:
        """The file uploaded to WhatsApp; its media id."""
        out = self._post(
            "media", idempotent=True,
            data={"messaging_product": "whatsapp", "type": mime},
            files={"file": (filename, data, mime)},
        )
        media_id = out.get("id")
        if not media_id:
            raise CloudApiError("bad_response", "no media id")
        return str(media_id)

    def send_message(self, payload: Dict[str, Any]) -> str:
        """The message sent; WhatsApp's message id ("wamid.…")."""
        out = self._post("messages", idempotent=False, json=payload)
        messages = out.get("messages") or []
        if not messages or not messages[0].get("id"):
            raise CloudApiError("bad_response", "no message id")
        return str(messages[0]["id"])


# ── Payloads ──────────────────────────────────────────────────────────────────


def param_text(value: Any) -> str:
    """
    A template variable as Meta takes it: no new lines or tabs, never more than four spaces in a
    row, never empty ("-"), at most 1024 characters.
    """
    text = re.sub(r"[\r\n\t]+", " · ", str(value if value is not None else ""))
    text = re.sub(r" {2,}", " ", text).strip(" ·")
    return (text or "-")[:1024]


def body_values(keys: Optional[Sequence[str]], values: Dict[str, Any]) -> List[str]:
    return [param_text(values.get(k)) for k in (keys if keys is not None else DEFAULT_BODY_PARAMS)]


def template_payload(
    *,
    to: str,
    template_name: str,
    language: str,
    media_id: str,
    filename: str,
    body: Sequence[str],
) -> Dict[str, Any]:
    """A template message with the PDF as its document header and the body's variables in order."""
    components: List[Dict[str, Any]] = [{
        "type": "header",
        "parameters": [{"type": "document", "document": {"id": media_id, "filename": filename}}],
    }]
    if body:
        components.append({"type": "body", "parameters": [{"type": "text", "text": t} for t in body]})
    return {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "template",
        "template": {"name": template_name, "language": {"code": language}, "components": components},
    }


# ── The webhook ───────────────────────────────────────────────────────────────


def signature_for(app_secret: str, raw_body: bytes) -> str:
    return "sha256=" + hmac.new(app_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()


def verify_signature(app_secret: Optional[str], raw_body: bytes, header: Optional[str]) -> bool:
    """Meta's `X-Hub-Signature-256`, compared in constant time. No secret: nothing is trusted."""
    if not app_secret or not header:
        return False
    return hmac.compare_digest(signature_for(app_secret, raw_body), header.strip())


@dataclass(frozen=True)
class StatusUpdate:
    message_id: str
    status: str
    timestamp: Optional[datetime]
    phone_number_id: Optional[str]
    error_code: Optional[str] = None
    error_title: Optional[str] = None


def parse_statuses(payload: Any) -> List[StatusUpdate]:
    """Every message status in a webhook's body (`entry[].changes[].value.statuses[]`); anything else ignored."""
    out: List[StatusUpdate] = []
    if not isinstance(payload, dict):
        return out
    for entry in payload.get("entry") or []:
        for change in (entry or {}).get("changes") or []:
            value = (change or {}).get("value") or {}
            phone_id = ((value.get("metadata") or {}).get("phone_number_id"))
            for st in value.get("statuses") or []:
                if not isinstance(st, dict) or not st.get("id") or st.get("status") not in ("sent", "delivered", "read", "failed"):
                    continue
                stamp = None
                if str(st.get("timestamp") or "").isdigit():
                    stamp = datetime.fromtimestamp(int(st["timestamp"]), tz=timezone.utc)
                err = (st.get("errors") or [{}])[0] or {}
                out.append(StatusUpdate(
                    message_id=str(st["id"]), status=st["status"], timestamp=stamp,
                    phone_number_id=str(phone_id) if phone_id else None,
                    error_code=str(err["code"]) if err.get("code") is not None else None,
                    error_title=(str(err.get("title") or err.get("message") or "")[:200] or None),
                ))
    return out


def apply_status(db: Session, r: VoucherDistributionRecipient, update: StatusUpdate, now: Optional[datetime] = None) -> bool:
    """
    One status on its recipient, forward only: sent → delivered → read; failed only before
    delivered. Returns whether anything changed (a repeated report changes nothing).
    """
    now = now or _now()
    at = update.timestamp or now
    rank = VD.STATUS_RANK.get(r.status, 0)
    changed = False
    if update.status == "sent":
        if r.status in ("pending", "failed") and r.api_status != "failed":
            r.status, changed = "sent", True
        if r.sent_at is None:
            r.sent_at, changed = at, True
    elif update.status == "delivered":
        if r.delivered_at is None:
            r.delivered_at, changed = at, True
        if rank < 2:
            r.status, changed = "delivered", True
    elif update.status == "read":
        if r.read_at is None:
            r.read_at, changed = at, True
        if r.delivered_at is None:
            r.delivered_at = at
        if rank < 3:
            r.status, changed = "read", True
    elif update.status == "failed" and rank < 2:
        reason = " ".join(x for x in (update.error_code, update.error_title) if x) or "failed"
        if r.status != "failed" or r.failure_reason != reason:
            r.status, r.failed_at, r.failure_reason, r.api_status, changed = "failed", at, reason[:300], "failed", True
    if changed:
        batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first()
        if batch is not None:
            VD._event(db, batch, "api_status", recipient=r, now=now, details={
                "status": update.status, "code": update.error_code,
            })
    return changed


def handle_webhook(db: Session, cfg: WhatsAppCloudConfig, payload: Any) -> int:
    """Apply a (signature-checked) webhook body's statuses; how many recipients moved."""
    moved = 0
    for update in parse_statuses(payload):
        if cfg.phone_number_id and update.phone_number_id and update.phone_number_id != cfg.phone_number_id:
            continue
        r = (
            db.query(VoucherDistributionRecipient)
            .join(PrepaidVoucherBatch, PrepaidVoucherBatch.id == VoucherDistributionRecipient.batch_id)
            .filter(
                VoucherDistributionRecipient.api_message_id == update.message_id,
                PrepaidVoucherBatch.company_id == cfg.company_id,
            )
            .first()
        )
        if r is not None and apply_status(db, r, update):
            moved += 1
    return moved


# ── Configuration ─────────────────────────────────────────────────────────────


def server_enabled() -> bool:
    return bool(VD.distribution_settings().whatsapp_cloud_api_enabled)


def get_config(db: Session, company_id) -> Optional[WhatsAppCloudConfig]:
    cid = VD.PV._as_uuid(company_id)
    if cid is None:
        return None
    return db.query(WhatsAppCloudConfig).filter(WhatsAppCloudConfig.company_id == cid).first()


def _secret(cfg: Optional[WhatsAppCloudConfig], attr: str) -> Optional[str]:
    token = getattr(cfg, attr, None) if cfg is not None else None
    return crypto.decrypt_text(token) if token else None


def is_configured(cfg: Optional[WhatsAppCloudConfig]) -> bool:
    return bool(cfg and cfg.phone_number_id and cfg.template_name and cfg.access_token_ciphertext)


def capability(db: Session, company_id) -> Dict[str, Any]:
    cfg = get_config(db, company_id)
    configured = is_configured(cfg)
    enabled = bool(cfg and cfg.enabled)
    return {
        "serverEnabled": server_enabled(),
        "configured": configured,
        "enabled": enabled,
        "ready": server_enabled() and configured and enabled,
    }


def webhook_url(cfg: WhatsAppCloudConfig) -> str:
    return f"{VD.link_base_url()}{VD._api_prefix()}/public/whatsapp/webhook/{cfg.id}"


def config_out(db: Session, company_id, cfg: Optional[WhatsAppCloudConfig]) -> Dict[str, Any]:
    """For the dashboard: everything but the secrets (whether each is set, only)."""
    return {
        "companyId": str(company_id),
        "exists": cfg is not None,
        "enabled": bool(cfg and cfg.enabled),
        "phoneNumberId": cfg.phone_number_id if cfg else None,
        "businessAccountId": cfg.business_account_id if cfg else None,
        "templateName": cfg.template_name if cfg else None,
        "templateLanguage": (cfg.template_language if cfg else None) or "he",
        "bodyParams": list(cfg.body_params) if cfg and cfg.body_params is not None else list(DEFAULT_BODY_PARAMS),
        "bodyParamKeys": list(BODY_PARAM_KEYS),
        "apiVersion": (cfg.api_version if cfg else None) or None,
        "defaultApiVersion": VD.distribution_settings().whatsapp_graph_api_version,
        "accessTokenSet": bool(cfg and cfg.access_token_ciphertext),
        "appSecretSet": bool(cfg and cfg.app_secret_ciphertext),
        # Shown so it can be pasted into Meta's webhook setup; it only gates the handshake.
        "verifyToken": _secret(cfg, "verify_token_ciphertext"),
        "webhookUrl": webhook_url(cfg) if cfg else None,
        "updatedAt": VD._iso(cfg.updated_at) if cfg else None,
        **capability(db, company_id),
    }


def _is_mask(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != "" and set(value.strip()) <= MASK_CHARS


def _clean_secret(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > 1000 or any(ord(c) < 33 or ord(c) == 127 for c in text):
        raise HTTPException(status_code=400, detail=CONFIG_INVALID)
    return text


def _check(value: Optional[str], pattern: "re.Pattern[str]") -> Optional[str]:
    text = (value or "").strip()
    if not text:
        return None
    if not pattern.match(text):
        raise HTTPException(status_code=400, detail=CONFIG_INVALID)
    return text


def save_config(db: Session, user: User, tenant_id, company_id, body) -> WhatsAppCloudConfig:
    """
    Store a company's configuration. The secrets are write-only: sent → encrypted and stored,
    "" or null → removed, the dashboard's "••••" echoed back → kept, left out → kept.
    """
    sent = getattr(body, "model_fields_set", set())
    cfg = get_config(db, company_id)
    if cfg is None:
        cfg = WhatsAppCloudConfig(
            id=uuid.uuid4(), tenant_id=VD.PV._as_uuid(tenant_id), company_id=VD.PV._as_uuid(company_id),
            enabled=False, template_language="he",
            verify_token_ciphertext=crypto.encrypt_text(crypto.random_token(18)),
        )
        db.add(cfg)
    if "phone_number_id" in sent:
        cfg.phone_number_id = _check(body.phone_number_id, IDENTIFIER)
    if "business_account_id" in sent:
        cfg.business_account_id = _check(body.business_account_id, IDENTIFIER)
    if "template_name" in sent:
        cfg.template_name = _check(body.template_name, TEMPLATE_NAME)
    if "template_language" in sent:
        cfg.template_language = _check(body.template_language, LANGUAGE) or "he"
    if "api_version" in sent:
        cfg.api_version = _check(body.api_version, API_VERSION)
    if "body_params" in sent:
        keys = body.body_params
        if keys is not None and (len(keys) > 10 or any(k not in BODY_PARAM_KEYS for k in keys)):
            raise HTTPException(status_code=400, detail=CONFIG_INVALID)
        cfg.body_params = list(keys) if keys is not None else None
    for field, attr in (("access_token", "access_token_ciphertext"), ("app_secret", "app_secret_ciphertext")):
        if field not in sent:
            continue
        raw = getattr(body, field)
        if _is_mask(raw):
            continue
        value = _clean_secret(raw)
        setattr(cfg, attr, crypto.encrypt_text(value) if value else None)
    if getattr(body, "regenerate_verify_token", False):
        cfg.verify_token_ciphertext = crypto.encrypt_text(crypto.random_token(18))
    if "enabled" in sent and body.enabled is not None:
        if body.enabled and not is_configured(cfg):
            raise HTTPException(status_code=409, detail=API_NOT_CONFIGURED)
        cfg.enabled = bool(body.enabled)
    cfg.updated_by = getattr(user, "id", None)
    cfg.updated_at = _now()
    db.flush()
    return cfg


# ── Sending ───────────────────────────────────────────────────────────────────


def _make_http() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))


#: How the clients get their HTTP connection; tests put a `MockTransport` here.
HTTP_FACTORY: Callable[[], httpx.Client] = _make_http


def client_for(cfg: WhatsAppCloudConfig, *, sleep: Callable[[float], None] = time.sleep) -> WhatsAppCloudClient:
    """A client for a ready configuration; 409 when the server or the company has it off."""
    if not server_enabled():
        raise HTTPException(status_code=409, detail=API_DISABLED)
    token = _secret(cfg, "access_token_ciphertext")
    if not (cfg.enabled and is_configured(cfg) and token):
        raise HTTPException(status_code=409, detail=API_NOT_CONFIGURED)
    s = VD.distribution_settings()
    return WhatsAppCloudClient(
        phone_number_id=cfg.phone_number_id, access_token=token,
        api_version=cfg.api_version or s.whatsapp_graph_api_version, base_url=s.whatsapp_graph_base_url,
        http=HTTP_FACTORY(), sleep=sleep,
    )


def enqueue(db: Session, user: User, batch: PrepaidVoucherBatch, recipient_ids: Optional[Sequence[Any]]) -> Dict[str, Any]:
    """
    Queue recipients for the API: the ones named, or every pending (and failed) one with a phone.
    Refused (409) when the API is not ready for the batch's company.
    """
    cap = capability(db, batch.company_id)
    if not cap["serverEnabled"]:
        raise HTTPException(status_code=409, detail=API_DISABLED)
    if not cap["ready"]:
        raise HTTPException(status_code=409, detail=API_NOT_CONFIGURED)
    q = db.query(VoucherDistributionRecipient).filter(
        VoucherDistributionRecipient.batch_id == batch.id,
        VoucherDistributionRecipient.deleted_at.is_(None),
        VoucherDistributionRecipient.anonymized_at.is_(None),
        VoucherDistributionRecipient.phone_ciphertext.isnot(None),
    )
    if recipient_ids:
        q = q.filter(VoucherDistributionRecipient.id.in_([VD.PV._as_uuid(i) for i in recipient_ids if VD.PV._as_uuid(i)]))
    else:
        q = q.filter(VoucherDistributionRecipient.status.in_(("pending", "failed")))
    now = _now()
    queued = 0
    for r in q.all():
        if r.api_status in ("queued", "sending", "retry"):
            continue
        r.api_status = "queued"
        r.api_attempts = 0
        r.api_next_attempt_at = now
        r.api_last_error = None
        r.sent_by = getattr(user, "id", None)
        r.sent_by_name = VD.PV._user_name(user)
        VD._event(db, batch, "api_queued", user=user, recipient=r, now=now)
        queued += 1
    db.flush()
    return {"queued": queued}


def _claim(db: Session, now: datetime, limit: int, batch_id=None) -> List[uuid.UUID]:
    """Due rows, leased to this process (`sending`), committed before any call."""
    # A send that never came back (the process died mid-call) is not retried blindly.
    stuck = db.query(VoucherDistributionRecipient).filter(
        VoucherDistributionRecipient.api_status == "sending", VoucherDistributionRecipient.api_lease_until < now,
    )
    if batch_id is not None:
        stuck = stuck.filter(VoucherDistributionRecipient.batch_id == batch_id)
    for r in stuck.with_for_update(skip_locked=True).all():
        _fail(db, r, "unknown_outcome", "the send was interrupted — check WhatsApp before sending again", now)
    q = db.query(VoucherDistributionRecipient).filter(
        VoucherDistributionRecipient.api_status.in_(("queued", "retry")),
        or_(VoucherDistributionRecipient.api_next_attempt_at.is_(None), VoucherDistributionRecipient.api_next_attempt_at <= now),
        VoucherDistributionRecipient.deleted_at.is_(None),
    )
    if batch_id is not None:
        q = q.filter(VoucherDistributionRecipient.batch_id == batch_id)
    rows = q.order_by(VoucherDistributionRecipient.api_next_attempt_at, VoucherDistributionRecipient.sort_order) \
        .limit(limit).with_for_update(skip_locked=True).all()
    for r in rows:
        r.api_status = "sending"
        r.api_lease_until = now + LEASE
        r.api_attempts = int(r.api_attempts or 0) + 1
    db.commit()
    return [r.id for r in rows]


def _fail(db: Session, r: VoucherDistributionRecipient, code: str, title: str, now: datetime) -> None:
    reason = f"{code}: {title}".strip(": ")[:300]
    r.api_status = "failed"
    r.api_last_error = reason
    r.api_lease_until = None
    if VD.STATUS_RANK.get(r.status, 0) < 2:
        r.status, r.failed_at, r.failure_reason = "failed", now, reason
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first()
    if batch is not None:
        VD._event(db, batch, "api_failed", recipient=r, now=now, details={"code": code, "attempts": r.api_attempts})


def send_one(db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, cfg: WhatsAppCloudConfig,
             client: WhatsAppCloudClient, now: datetime) -> str:
    """Upload the recipient's PDF and send the template. Returns the message id; raises CloudApiError."""
    e164 = VD._phone_of(r)
    if not e164:
        raise CloudApiError("phone_missing", "no phone number")
    try:
        data, filename, _count = VD.render_recipient_pdf(db, batch, r)
    except HTTPException:
        raise CloudApiError("no_vouchers", "nothing left to send") from None
    serials = [a.serial for a in VD.assignments_of(db, [r.id])[r.id]]
    link = VD.link_of(r) if VD.link_active(r, now) else None
    values = VD.message_values(batch, r, serials, link, VD._zone(db, batch))
    media_id = client.upload_media(data, filename)
    payload = template_payload(
        to=VD.wa_digits(e164), template_name=cfg.template_name, language=cfg.template_language or "he",
        media_id=media_id, filename=filename, body=body_values(cfg.body_params, values),
    )
    return client.send_message(payload)


def process_due(
    db: Session,
    *,
    now: Optional[datetime] = None,
    limit: int = 20,
    batch_id=None,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, int]:
    """Send what is due (queued, or a retry whose time came). Commits per recipient."""
    now = now or _now()
    out = {"accepted": 0, "retry": 0, "failed": 0}
    if not server_enabled():
        return out
    clients: Dict[Any, Any] = {}
    for rid in _claim(db, now, limit, batch_id):
        r = db.query(VoucherDistributionRecipient).filter(VoucherDistributionRecipient.id == rid).first()
        batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first() if r else None
        if r is None or batch is None:
            continue
        try:
            if batch.company_id not in clients:
                cfg = get_config(db, batch.company_id)
                try:
                    clients[batch.company_id] = (cfg, client_for(cfg, sleep=sleep) if cfg else None)
                except HTTPException as exc:
                    clients[batch.company_id] = (cfg, exc.detail)
            cfg, client = clients[batch.company_id]
            if not isinstance(client, WhatsAppCloudClient):
                raise CloudApiError(str(client or API_NOT_CONFIGURED), "not configured")
            wamid = send_one(db, batch, r, cfg, client, now)
        except CloudApiError as exc:
            if exc.transient and int(r.api_attempts or 0) < MAX_ROUNDS:
                wait = ROUND_BACKOFF[min(int(r.api_attempts or 1) - 1, len(ROUND_BACKOFF) - 1)]
                r.api_status, r.api_next_attempt_at, r.api_lease_until = "retry", now + wait, None
                r.api_last_error = f"{exc.code}: {exc.message}".strip(": ")[:300]
                VD._event(db, batch, "api_retry", recipient=r, now=now,
                          details={"code": exc.code, "attempts": r.api_attempts, "next": VD._iso(r.api_next_attempt_at)})
                out["retry"] += 1
            else:
                _fail(db, r, exc.code, exc.message, now)
                out["failed"] += 1
        except Exception as exc:  # noqa: BLE001 — one recipient's crash must not stop the queue
            logger.exception("WhatsApp send of recipient %s crashed", rid)
            db.rollback()
            r = db.query(VoucherDistributionRecipient).filter(VoucherDistributionRecipient.id == rid).first()
            if r is not None:
                _fail(db, r, "internal_error", type(exc).__name__, now)
            out["failed"] += 1
        else:
            r.api_status, r.api_message_id, r.api_lease_until, r.api_last_error = "accepted", wamid, None, None
            r.sent_at, r.sent_via = now, "api"
            if VD.STATUS_RANK.get(r.status, 0) < 1:
                r.status = "sent"
            r.failed_at, r.failure_reason = None, None
            VD._event(db, batch, "api_accepted", recipient=r, now=now, details={"attempts": r.api_attempts})
            out["accepted"] += 1
        db.commit()
    for _cfg, client in clients.values():
        if isinstance(client, WhatsAppCloudClient):
            try:
                client.http.close()
            except Exception:  # noqa: BLE001
                pass
    return out


def start_background_worker(session_factory) -> Optional[threading.Thread]:
    """The retries' pass, every WORKER_INTERVAL_SECONDS — only when the server has the API on."""
    s = VD.distribution_settings()
    if not (s.whatsapp_cloud_api_enabled and s.whatsapp_worker_enabled):
        return None

    def loop() -> None:
        while True:
            time.sleep(WORKER_INTERVAL_SECONDS)
            db = session_factory()
            try:
                process_due(db)
            except Exception:  # noqa: BLE001
                logger.exception("WhatsApp distribution worker pass failed")
                db.rollback()
            finally:
                db.close()

    thread = threading.Thread(target=loop, name="whatsapp-distribution", daemon=True)
    thread.start()
    return thread


def parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8") or "null")
    except (ValueError, UnicodeDecodeError):
        return None
