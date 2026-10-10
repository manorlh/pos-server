"""
"הפצה בוואטסאפ" — prepaid vouchers sent per recipient (app/services/voucher_distribution.py).

Dashboard (user JWT; who manages the batch — PV.get_batch — and edit on "שוברי הפקה", since the
lists hold phone numbers; app/services/dashboard_sections.py):

GET    /prepaid-vouchers/batches/{id}/distribution                         → settings, counts, API readiness
PUT    /prepaid-vouchers/batches/{id}/distribution                         → messages, layout, links' expiry
GET    /prepaid-vouchers/batches/{id}/distribution/groups                  → per group: serials, free / assigned
POST   /prepaid-vouchers/batches/{id}/distribution/preview                 → who would get what (nothing stored)
POST   /prepaid-vouchers/batches/{id}/distribution/recipients              → import: store, assign, issue links
GET    /prepaid-vouchers/batches/{id}/distribution/recipients              → the send queue (state, kind, q)
GET    /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}        → one recipient
GET    /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/pdf    → their PDF (download / share)
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/sent   → marked sent (via)
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/pending → the mark undone
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/revoke  → the link stops working
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/reissue → a new link
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/unassign → vouchers taken back
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/remove   → off the list
POST   /prepaid-vouchers/batches/{id}/distribution/recipients/{rid}/erase    → phone and name erased
POST   /prepaid-vouchers/batches/{id}/distribution/erase                   → every recipient erased (batch over)
POST   /prepaid-vouchers/batches/{id}/distribution/send-api                → send by the Cloud API
GET    /prepaid-vouchers/batches/{id}/distribution/export                  → CSV
GET    /prepaid-vouchers/batches/{id}/distribution/events                  → the audit trail
GET    /prepaid-vouchers/distribution/whatsapp-config?companyId=           → a company's Cloud API settings
PUT    /prepaid-vouchers/distribution/whatsapp-config?companyId=           → … stored (secrets write-only)

Public (no login; rate-limited; every request logged):

GET    /public/vouchers/{token}                → the recipient's page (event, count, the PDF button)
GET    /public/vouchers/{token}/pdf            → only that recipient's PDF
GET    /public/whatsapp/webhook/{config_id}    → Meta's subscription handshake
POST   /public/whatsapp/webhook/{config_id}    → message statuses (signed by the app secret)
"""
from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.middleware.rate_limit import check_rate_limit_by_key
from app.models.company import Company
from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.user import User
from app.schemas.voucher_distribution import (
    DistributionApiSendIn,
    DistributionImportIn,
    DistributionReasonIn,
    DistributionSentIn,
    DistributionSettingsIn,
    DistributionUnassignIn,
    WhatsAppConfigIn,
)
from app.services import prepaid_vouchers as PV
from app.services import voucher_distribution as VD
from app.services import whatsapp_cloud as WA

logger = logging.getLogger(__name__)

# ── The personal links stay out of the logs ───────────────────────────────────
# The token is the whole secret of a link, and it travels in the path: the request log
# ("request completed", app/middleware/request_context.py) and uvicorn's access log write every
# path. Both loggers get this filter, so `/public/vouchers/<token>` is logged as
# `/public/vouchers/[link]` (a body log, when switched on, is redacted the same way).
_LINK_IN_TEXT = re.compile(r"(/public/vouchers/)[A-Za-z0-9_-]{8,}")
_LINK_MARK = "/public/vouchers/"


def redact_links(value):
    """[value] with any personal link's token replaced; anything but text as it is."""
    if isinstance(value, str) and _LINK_MARK in value:
        return _LINK_IN_TEXT.sub(r"\1[link]", value)
    if isinstance(value, bytes) and _LINK_MARK.encode() in value:
        return redact_links(value.decode("utf-8", "replace"))
    return value


class RedactVoucherLinks(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact_links(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_links(a) for a in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: redact_links(v) for k, v in record.args.items()}
        for key in ("path", "request_body", "response_body", "url"):
            if key in record.__dict__:
                record.__dict__[key] = redact_links(record.__dict__[key])
        return True


LOGGERS_WITH_PATHS = ("uvicorn.access", "app.middleware.request_context")
for _name in LOGGERS_WITH_PATHS:
    _logger = logging.getLogger(_name)
    if not any(isinstance(f, RedactVoucherLinks) for f in _logger.filters):
        _logger.addFilter(RedactVoucherLinks())

router = APIRouter(tags=["voucher-distribution"])
public_router = APIRouter(tags=["voucher-distribution-public"])

_BASE = "/prepaid-vouchers/batches/{batch_id}/distribution"
_ONE = _BASE + "/recipients/{recipient_id}"


def _batch(db: Session, user: User, tenant_id, batch_id) -> PrepaidVoucherBatch:
    return PV.get_batch(db, user, tenant_id, batch_id)


# ── Dashboard ─────────────────────────────────────────────────────────────────


@router.get(_BASE)
def get_distribution(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return VD.distribution_out(db, _batch(db, current_user, active_tenant_id, batch_id))


@router.put(_BASE)
def update_distribution(
    batch_id: str,
    body: DistributionSettingsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    VD.update_settings(db, current_user, batch, body)
    db.commit()
    return VD.distribution_out(db, batch)


@router.get(_BASE + "/groups")
def distribution_groups(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return {"items": VD.groups_overview(db, _batch(db, current_user, active_tenant_id, batch_id))}


@router.post(_BASE + "/preview")
def preview_distribution(
    batch_id: str,
    body: DistributionImportIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Who would get which serials, with every row's problems — nothing is stored."""
    return VD.preview(db, _batch(db, current_user, active_tenant_id, batch_id), body)


@router.post(_BASE + "/recipients", status_code=201)
def import_distribution(
    batch_id: str,
    body: DistributionImportIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The rows without a problem stored, their vouchers assigned, their links issued; the rest returned."""
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    out = VD.import_recipients(db, current_user, batch, body)
    db.commit()
    return out


@router.get(_BASE + "/recipients")
def list_distribution(
    batch_id: str,
    state: Optional[str] = Query(None, pattern="^(pending|sent|delivered|read|opened|failed)$"),
    kind: Optional[str] = Query(None, pattern="^(person|group)$"),
    q: Optional[str] = Query(None, max_length=100),
    include_removed: bool = Query(False, alias="includeRemoved"),
    limit: int = Query(500, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    return VD.list_recipients(
        db, batch, state=state, kind=kind, q=q, include_removed=include_removed, limit=limit, offset=offset,
    )


@router.get(_ONE)
def get_recipient(
    batch_id: str,
    recipient_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    return VD.one_out(db, batch, VD.get_recipient(db, batch, recipient_id))


def _pdf_response(data: bytes, name: str, *, inline: bool) -> Response:
    disposition = "inline" if inline else "attachment"
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"{disposition}; filename=\"vouchers.pdf\"; filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(_ONE + "/pdf")
def recipient_pdf(
    batch_id: str,
    recipient_id: str,
    purpose: str = Query("download", pattern="^(download|share|preview)$"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The recipient's PDF, for a download or the share sheet. Logged (who fetched whose vouchers)."""
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    data, name, count = VD.render_recipient_pdf(db, batch, r)
    VD._event(db, batch, "dashboard_pdf", user=current_user, recipient=r, details={"purpose": purpose, "vouchers": count})
    db.commit()
    return _pdf_response(data, name, inline=False)


@router.post(_ONE + "/sent")
def mark_recipient_sent(
    batch_id: str,
    recipient_id: str,
    body: Optional[DistributionSentIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.mark_sent(db, current_user, batch, r, (body.via if body else "manual"))
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_ONE + "/pending")
def mark_recipient_pending(
    batch_id: str,
    recipient_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.mark_pending(db, current_user, batch, r)
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_ONE + "/revoke")
def revoke_recipient_link(
    batch_id: str,
    recipient_id: str,
    body: Optional[DistributionReasonIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.revoke_link(db, current_user, batch, r, body.reason if body else None)
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_ONE + "/reissue")
def reissue_recipient_link(
    batch_id: str,
    recipient_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.reissue_link(db, current_user, batch, r)
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_ONE + "/unassign")
def unassign_recipient_vouchers(
    batch_id: str,
    recipient_id: str,
    body: DistributionUnassignIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    freed = VD.unassign(db, current_user, batch, r, body.voucher_ids, body.reason)
    db.commit()
    return {"freed": freed, "recipient": VD.one_out(db, batch, r)}


@router.post(_ONE + "/remove")
def remove_recipient(
    batch_id: str,
    recipient_id: str,
    body: Optional[DistributionReasonIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.remove_recipient(db, current_user, batch, r, body.reason if body else None)
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_ONE + "/erase")
def erase_recipient(
    batch_id: str,
    recipient_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    r = VD.get_recipient(db, batch, recipient_id)
    VD.erase_recipient(db, current_user, batch, r)
    db.commit()
    return VD.one_out(db, batch, r)


@router.post(_BASE + "/erase")
def erase_all_recipients(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    erased = VD.erase_all(db, current_user, batch)
    db.commit()
    return {"erased": erased}


@router.post(_BASE + "/send-api")
def send_by_api(
    batch_id: str,
    body: Optional[DistributionApiSendIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Queue for the WhatsApp Cloud API (409 `whatsapp_api_disabled` / `whatsapp_api_not_configured`
    when it is not ready); the first ones are sent right away, the rest by the worker.
    """
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    queued = WA.enqueue(db, current_user, batch, body.recipient_ids if body else None)
    db.commit()
    sent = WA.process_due(db, limit=WA.INLINE_LIMIT, batch_id=batch.id)
    return {**queued, **sent}


@router.get(_BASE + "/export")
def export_distribution(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import prepaid_voucher_pdf as PDF

    batch = _batch(db, current_user, active_tenant_id, batch_id)
    name = f"{PDF.safe_name(batch.event_name or batch.name)}_הפצה.csv"
    return Response(
        content=VD.export_csv(db, batch),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"distribution.csv\"; filename*=UTF-8''{quote(name)}",
                 "Cache-Control": "no-store, private"},
    )


@router.get(_BASE + "/events")
def distribution_events(
    batch_id: str,
    recipient_id: Optional[str] = Query(None, alias="recipientId"),
    limit: int = Query(300, ge=1, le=2000),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = _batch(db, current_user, active_tenant_id, batch_id)
    return VD.events_out(db, batch, recipient_id=recipient_id, limit=limit)


def _company(db: Session, user: User, tenant_id, company_id: str) -> Company:
    """A company the caller manages vouchers for (its own credentials are a company decision)."""
    PV._require_role(user)
    cid = PV._as_uuid(company_id)
    company = db.query(Company).filter(Company.id == cid).first() if cid else None
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=404, detail=PV.COMPANY_NOT_FOUND)
    if not PV._covers_company(db, user, company.id):
        raise HTTPException(status_code=403, detail=PV.FORBIDDEN)
    return company


@router.get("/prepaid-vouchers/distribution/whatsapp-config")
def get_whatsapp_config(
    company_id: str = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, current_user, active_tenant_id, company_id)
    return WA.config_out(db, company.id, WA.get_config(db, company.id))


@router.put("/prepaid-vouchers/distribution/whatsapp-config")
def put_whatsapp_config(
    body: WhatsAppConfigIn,
    company_id: str = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, current_user, active_tenant_id, company_id)
    cfg = WA.save_config(db, current_user, active_tenant_id, company.id, body)
    db.commit()
    return WA.config_out(db, company.id, cfg)


# ── Public ────────────────────────────────────────────────────────────────────

#: Per address: pages and PDFs a minute; a PDF is drawn on every request, so it is the tighter.
#: Generous enough for a mobile carrier's shared address (CGNAT) while a batch is being sent.
PAGE_PER_MINUTE = 120
PDF_PER_MINUTE = 60
#: Per link: PDFs a minute (a forwarded link hammered from many addresses).
PDF_PER_LINK_PER_MINUTE = 10
#: Unknown / dead links a minute before 429 — per address, and for the whole server (the address
#: comes from Fly's edge header, which a client could forge where there is no Fly in front).
#: Guessing is pointless at 160 bits; this keeps it expensive anyway.
MISSES_PER_MINUTE = 20
MISSES_PER_MINUTE_ALL = 300

_PUBLIC_HEADERS = {
    "Cache-Control": "no-store, private",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}
_PAGE_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)


def _client_ip(request: Request) -> Optional[str]:
    # Fly's edge sets Fly-Client-IP (the API runs without --proxy-headers, so the socket peer
    # there is Fly's proxy, shared by everyone); elsewhere the socket peer.
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else None)


def _limit(request: Request, key: str, per_minute: int) -> None:
    check_rate_limit_by_key(f"{key}:{_client_ip(request) or 'unknown'}", per_minute, 60)


def _resolve(request: Request, db: Session, token: str):
    """The live recipient and its batch, or the uniform "not valid" page (reason logged only)."""
    ip = _client_ip(request)
    ua = request.headers.get("user-agent")
    r, why = VD.resolve_link(db, token, VD._now())
    if why is not None:
        check_rate_limit_by_key("voucher_link_miss_all", MISSES_PER_MINUTE_ALL, 60)
        check_rate_limit_by_key(f"voucher_link_miss:{ip}", MISSES_PER_MINUTE, 60)
        if r is not None:
            VD.record_denied(db, r, why, ip=ip, user_agent=ua)
            db.commit()
        logger.info("voucher link refused (%s) from %s", why, ip)
        return None, None
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first()
    return r, batch


def _invalid() -> HTMLResponse:
    return HTMLResponse(VD.invalid_page(), status_code=404, headers={**_PUBLIC_HEADERS, "Content-Security-Policy": _PAGE_CSP})


@public_router.get("/public/vouchers/{token}", response_class=HTMLResponse, include_in_schema=False)
def public_voucher_page(token: str, request: Request, db: Session = Depends(get_db)):
    _limit(request, "voucher_link_page", PAGE_PER_MINUTE)
    r, batch = _resolve(request, db, token)
    if r is None:
        return _invalid()
    VD.record_public(db, batch, r, "page", ip=_client_ip(request), user_agent=request.headers.get("user-agent"),
                     head=request.method == "HEAD")
    page = VD.landing_page(db, batch, r, token)
    db.commit()
    return HTMLResponse(page, headers={**_PUBLIC_HEADERS, "Content-Security-Policy": _PAGE_CSP})


@public_router.get("/public/vouchers/{token}/pdf", include_in_schema=False)
def public_voucher_pdf(
    token: str,
    request: Request,
    download: bool = Query(False),
    db: Session = Depends(get_db),
):
    _limit(request, "voucher_link_pdf", PDF_PER_MINUTE)
    r, batch = _resolve(request, db, token)
    if r is None:
        return _invalid()
    check_rate_limit_by_key(f"voucher_link_pdf_token:{r.id}", PDF_PER_LINK_PER_MINUTE, 60)
    try:
        data, name, _count = VD.render_recipient_pdf(db, batch, r)
    except HTTPException:
        page = VD.landing_page(db, batch, r, token)  # "all used or cancelled"
        return HTMLResponse(page, status_code=404, headers={**_PUBLIC_HEADERS, "Content-Security-Policy": _PAGE_CSP})
    VD.record_public(db, batch, r, "pdf", ip=_client_ip(request), user_agent=request.headers.get("user-agent"),
                     head=request.method == "HEAD")
    db.commit()
    resp = _pdf_response(data, name, inline=not download)
    resp.headers.update(_PUBLIC_HEADERS)
    return resp


@public_router.get("/public/whatsapp/webhook/{config_id}", include_in_schema=False)
def whatsapp_webhook_verify(
    config_id: str,
    request: Request,
    mode: Optional[str] = Query(None, alias="hub.mode"),
    verify_token: Optional[str] = Query(None, alias="hub.verify_token"),
    challenge: Optional[str] = Query(None, alias="hub.challenge"),
    db: Session = Depends(get_db),
):
    """Meta's subscription handshake: the verify token shown in the dashboard, echoed by the challenge."""
    from app.models.voucher_distribution import WhatsAppCloudConfig
    from app.services.notifications import crypto

    _limit(request, "whatsapp_webhook_verify", 30)
    cid = PV._as_uuid(config_id)
    cfg = db.query(WhatsAppCloudConfig).filter(WhatsAppCloudConfig.id == cid).first() if cid else None
    expected = WA._secret(cfg, "verify_token_ciphertext")
    if mode != "subscribe" or not crypto.constant_time_equal(expected, verify_token):
        raise HTTPException(status_code=403, detail="forbidden")
    return PlainTextResponse(challenge or "")


@public_router.post("/public/whatsapp/webhook/{config_id}", include_in_schema=False)
async def whatsapp_webhook(config_id: str, request: Request, db: Session = Depends(get_db)):
    """Message statuses, signed with the company's app secret (X-Hub-Signature-256); 403 otherwise."""
    from app.models.voucher_distribution import WhatsAppCloudConfig

    raw = await request.body()
    cid = PV._as_uuid(config_id)
    cfg = db.query(WhatsAppCloudConfig).filter(WhatsAppCloudConfig.id == cid).first() if cid else None
    if cfg is None or not WA.verify_signature(WA._secret(cfg, "app_secret_ciphertext"), raw,
                                             request.headers.get("x-hub-signature-256")):
        logger.warning("WhatsApp webhook refused: bad or missing signature (config %s)", config_id)
        raise HTTPException(status_code=403, detail="forbidden")
    moved = WA.handle_webhook(db, cfg, WA.parse_json(raw))
    db.commit()
    return {"ok": True, "updated": moved}
