"""
"הודעות" — the notification service's dashboard and till API
(docs/SPEC_NOTIFICATIONS_CLUB.md §18, §31).

Dashboard (Clerk/user JWT + X-Tenant-Id):

GET    /notifications/overview                 → counts by state (24 h), provider summary
GET    /notifications/log                      → the log: recipients masked
GET    /notifications/{id}                     → one message, its attempts and delivery reports
POST   /notifications/{id}/reveal-recipient    → the full number (company managers+, reason, audited)
POST   /notifications/{id}/resend              → a new explicit message (reason, rate limit)
POST   /notifications/{id}/cancel              → a pending message stops
GET    /notifications/templates                → built-in + stored templates
POST   /notifications/templates                → a new draft version
PATCH  /notifications/templates/{id}           → edit a draft
POST   /notifications/templates/{id}/approve | /activate | /archive
POST   /notifications/templates/preview        → render with sample data (never sends)
POST   /notifications/templates/test-send      → to an allow-listed test number, marked TEST
GET    /notifications/provider                 → the account (token: set / not set — never the value)
PUT    /notifications/provider                 → update it (token write-only)
POST   /notifications/provider/pause | /resume
GET    /notifications/order-status?refs=       → KDS / Expo short status
GET    /notifications/campaigns                → P1 skeleton (drafts only)
POST   /notifications/campaigns                → a draft; approving / sending → 409 `campaigns_disabled`
GET    /notifications/mock-inbox               → dev only (super admin + NOTIFICATIONS_MOCK_INBOX)

Till (machine JWT): GET /sync/{machine_id}/notifications/order-status?refs=

Provider adapters are never reachable from here; nothing returns the token.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal, get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_from_sync_machine_token
from app.models.notifications import (
    MODE_LIVE,
    MODES,
    ST_QUEUED,
    STATES,
    Campaign,
    DeliveryEvent,
    Notification,
    NotificationAttempt,
    NotificationProviderConfig,
    NotificationTemplate,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.club.scope import CLUB_ADMIN_ROLES, LOG_ROLES, audit, error, require_role, resolve_company
from app.services.company_hierarchy import company_scope_ids
from app.services.notifications import service as S
from app.services.notifications import templates as T
from app.services.notifications import worker as W
from app.services.notifications.adapter019 import MOCK_019, is_valid_sender
from app.services.notifications.phone import PhoneError, normalize_mobile
from app.services.notifications.secrets import set_token, token_status
from app.services.payment_secrets import PaymentSecretError

router = APIRouter(tags=["notifications"])
till_router = APIRouter(tags=["notifications"])

STATE_LABELS = {
    "queued": "בתור",
    "processing": "בשליחה",
    "provider_accepted": "התקבל אצל הספק",
    "delivered": "נמסר",
    "failed_retryable": "נכשל — ינסה שוב",
    "failed_permanent": "נכשל",
    "unknown_outcome": "תוצאה לא ידועה — בבירור",
    "suppressed": "נחסם",
    "expired": "פג תוקף",
    "cancelled": "בוטל",
}


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = S.as_aware(value)
    return value.isoformat() if value else None


def _uuid(value: Any, code: str = "not_found") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise error(code, 404) from None


# ── Scope ────────────────────────────────────────────────────────────────────


def _scoped(db: Session, user: User, tenant_id: Any, q):
    q = q.filter(Notification.tenant_id == tenant_id)
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return q
    if user.role == UserRole.COMPANY_MANAGER:
        return q.filter(Notification.company_id.in_(company_scope_ids(db, user)))
    if user.role == UserRole.SHOP_MANAGER and user.shop_id:
        return q.filter(Notification.shop_id == user.shop_id)
    raise error("forbidden", 403)


def _get_notification(db: Session, user: User, tenant_id: Any, notification_id: Any) -> Notification:
    n = _scoped(db, user, tenant_id, db.query(Notification)).filter(
        Notification.id == _uuid(notification_id)
    ).first()
    if n is None:
        raise error("not_found", 404)
    return n


def _row(n: Notification, shop_names: Dict[Any, str]) -> Dict[str, Any]:
    return {
        "id": str(n.id),
        "createdAt": _iso(n.created_at),
        "companyId": str(n.company_id) if n.company_id else None,
        "shopId": str(n.shop_id) if n.shop_id else None,
        "shopName": shop_names.get(n.shop_id),
        "eventType": n.event_type,
        "category": n.category,
        "channel": n.channel,
        "recipient": n.recipient_masked,
        "contextLabel": n.context_label,
        "aggregateRef": n.aggregate_ref,
        "state": n.state,
        "stateLabel": STATE_LABELS.get(n.state, n.state),
        "stateReason": n.state_reason,
        "providerMode": n.provider_mode,
        "providerRef": n.provider_ref,
        "attempts": n.attempt_count,
        "isTest": bool(n.is_test),
        "templateKey": n.template_key,
        "text": n.body_snapshot,
        "acceptedAt": _iso(n.accepted_at),
        "deliveredAt": _iso(n.delivered_at),
        "expiresAt": _iso(n.expires_at),
        "resendOf": str(n.resend_of_id) if n.resend_of_id else None,
        "resendReason": n.resend_reason,
    }


def _shop_names(db: Session, rows: List[Notification]) -> Dict[Any, str]:
    ids = {r.shop_id for r in rows if r.shop_id}
    if not ids:
        return {}
    return {sid: name for sid, name in db.query(Shop.id, Shop.name).filter(Shop.id.in_(ids)).all()}


# ── Log ──────────────────────────────────────────────────────────────────────


@router.get("/notifications/log")
def notification_log(
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    state: Optional[str] = None,
    category: Optional[str] = None,
    event_type: Optional[str] = Query(None, alias="eventType"),
    q: Optional[str] = Query(None, max_length=100),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Newest first. `q`: an order / group reference or a context label."""
    require_role(user, LOG_ROLES)
    query = _scoped(db, user, tenant_id, db.query(Notification))
    if company_id:
        query = query.filter(Notification.company_id == _uuid(company_id))
    if shop_id:
        query = query.filter(Notification.shop_id == _uuid(shop_id))
    if state and state in STATES:
        query = query.filter(Notification.state == state)
    if category:
        query = query.filter(Notification.category == category)
    if event_type:
        query = query.filter(Notification.event_type == event_type)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(Notification.aggregate_ref.ilike(like), Notification.context_label.ilike(like)))
    total = query.count()
    rows = query.order_by(Notification.created_at.desc()).offset(offset).limit(limit).all()
    names = _shop_names(db, rows)
    return {"items": [_row(n, names) for n in rows], "total": total}


@router.get("/notifications/overview")
def notification_overview(
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, LOG_ROLES)
    since = S.utcnow() - timedelta(days=1)
    query = _scoped(db, user, tenant_id, db.query(Notification.state, func.count(Notification.id))).filter(
        Notification.created_at >= since
    )
    if company_id:
        query = query.filter(Notification.company_id == _uuid(company_id))
    counts = {state: 0 for state in STATES}
    for state, count in query.group_by(Notification.state).all():
        counts[state] = count
    oldest = _scoped(db, user, tenant_id, db.query(func.min(Notification.created_at))).filter(
        Notification.state == ST_QUEUED
    )
    if company_id:
        oldest = oldest.filter(Notification.company_id == _uuid(company_id))
    queued_oldest = oldest.scalar()
    return {
        "since": _iso(since),
        "counts": counts,
        "oldestQueuedAt": _iso(queued_oldest),
        "liveSendingEnabled": bool(get_settings().notifications_live_sending_enabled),
    }


@router.get("/notifications/order-status")
def dashboard_order_status(
    refs: str = Query(..., max_length=4000),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Short status per order / fulfillment group: לא נדרש / בתור / התקבל אצל הספק / נמסר / כשל."""
    require_role(user, LOG_ROLES)
    return {"items": S.short_status(db, tenant_id, [r.strip() for r in refs.split(",") if r.strip()][:200])}


@router.get("/notifications/mock-inbox")
def mock_inbox(user: User = Depends(get_current_user)):
    """Dev only: the mock provider's in-process inbox (to finish an OTP sign-up locally)."""
    if user.role != UserRole.SUPER_ADMIN or not get_settings().notifications_mock_inbox:
        raise error("not_found", 404)
    return {"items": MOCK_019.inbox()}


@router.post("/notifications/worker/run-once")
def worker_run_once(user: User = Depends(get_current_user)):
    """Super admin: one worker pass now (mock / test gates still apply)."""
    if user.role != UserRole.SUPER_ADMIN:
        raise error("forbidden", 403)
    return W.run_cycle(SessionLocal)


# ── Templates ────────────────────────────────────────────────────────────────


def _template(row: NotificationTemplate) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "companyId": str(row.company_id) if row.company_id else None,
        "eventType": row.event_type,
        "category": row.category,
        "language": row.language,
        "version": row.version,
        "status": row.status,
        "name": row.name,
        "body": row.body,
        "fallbackBody": row.fallback_body,
        "allowedVariables": row.allowed_variables or [],
        "approvedAt": _iso(row.approved_at),
        "activatedAt": _iso(row.activated_at),
        "createdAt": _iso(row.created_at),
    }


def _template_error(exc: T.TemplateError):
    return error(exc.code, 422, detail_field=exc.detail)


@router.get("/notifications/templates")
def list_templates(
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, LOG_ROLES)
    query = db.query(NotificationTemplate).filter(NotificationTemplate.tenant_id == tenant_id)
    if company_id:
        company = resolve_company(db, user, tenant_id, company_id)
        query = query.filter(NotificationTemplate.scope_key.in_([str(company.id), "tenant"]))
    elif user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        query = query.filter(NotificationTemplate.scope_key == "tenant")
    rows = query.order_by(NotificationTemplate.event_type, NotificationTemplate.version.desc()).all()
    builtins = [
        {
            "eventType": spec.event_type,
            "category": spec.category,
            "title": spec.title,
            "body": spec.body,
            "fallbackBody": spec.fallback,
            "required": list(spec.required),
            "optional": list(spec.optional),
            "secret": list(spec.secret),
            "sample": spec.sample,
            "p1": spec.event_type == "Campaign",
        }
        for spec in T.EVENTS.values()
    ]
    return {"builtins": builtins, "items": [_template(r) for r in rows]}


def _own_template(db: Session, user: User, tenant_id: Any, template_id: Any) -> NotificationTemplate:
    row = db.get(NotificationTemplate, _uuid(template_id))
    if row is None or row.tenant_id != tenant_id:
        raise error("not_found", 404)
    if row.company_id is not None:
        resolve_company(db, user, tenant_id, row.company_id)
    elif user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        raise error("forbidden", 403)
    return row


@router.post("/notifications/templates", status_code=201)
def create_template(
    body: Dict[str, Any] = Body(...),
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    company = resolve_company(db, user, tenant_id, company_id) if company_id else None
    if company is None and user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        raise error("company_required", 422)
    try:
        row = T.create_draft(
            db,
            tenant_id=tenant_id,
            company_id=company.id if company else None,
            event_type=str(body.get("eventType") or ""),
            body=str(body.get("body") or ""),
            fallback_body=(str(body["fallbackBody"]) if body.get("fallbackBody") else None),
            name=body.get("name"),
            user_id=user.id,
        )
    except T.TemplateError as exc:
        raise _template_error(exc) from None
    db.commit()
    return _template(row)


@router.patch("/notifications/templates/{template_id}")
def update_template(
    template_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    row = _own_template(db, user, tenant_id, template_id)
    try:
        T.update_draft(
            row,
            body=body.get("body"),
            fallback_body=(body.get("fallbackBody") or None) if "fallbackBody" in body else ...,
            name=body.get("name"),
        )
    except T.TemplateError as exc:
        raise _template_error(exc) from None
    db.commit()
    return _template(row)


@router.post("/notifications/templates/{template_id}/{action}")
def template_action(
    template_id: str,
    action: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """approve (draft → approved), activate (approved → active), archive."""
    require_role(user, CLUB_ADMIN_ROLES)
    if action not in ("approve", "activate", "archive"):
        raise error("not_found", 404)
    row = _own_template(db, user, tenant_id, template_id)
    try:
        if action == "approve":
            T.approve(row, user.id)
        elif action == "activate":
            T.activate(db, row)
        else:
            T.archive(row)
    except T.TemplateError as exc:
        raise error(exc.code, 409) from None
    audit(
        db, tenant_id=tenant_id, company_id=row.company_id, domain="notifications", subject_type="template",
        subject_id=row.id, action=f"template_{action}", actor_user_id=user.id,
    )
    db.commit()
    return _template(row)


@router.post("/notifications/templates/preview")
def preview_template(
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
):
    require_role(user, LOG_ROLES)
    try:
        return T.preview(
            str(body.get("eventType") or ""),
            str(body.get("body") or ""),
            body.get("fallbackBody") or None,
            body.get("sample") if isinstance(body.get("sample"), dict) else None,
        )
    except T.TemplateError as exc:
        raise _template_error(exc) from None


@router.post("/notifications/templates/test-send")
def test_send(
    body: Dict[str, Any] = Body(...),
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A TEST message with sample values to an allow-listed number of the account
    (`testNumbers`). Goes through the queue and every gate like any other message.
    """
    require_role(user, CLUB_ADMIN_ROLES)
    company = resolve_company(db, user, tenant_id, company_id) if company_id else None
    config = S.get_config(db, tenant_id, company.id if company else None)
    if config is None:
        raise error("provider_not_configured", 409)
    try:
        phone = normalize_mobile(body.get("phone"))
    except PhoneError as exc:
        raise error(exc.code, 422) from None
    if phone not in (config.test_numbers or []):
        raise error("not_on_test_list", 403)
    event_type = str(body.get("eventType") or "OrderReady")
    try:
        spec = T.event_spec(event_type)
        text_body = body.get("body") or None
        if text_body:
            T.validate_body(event_type, text_body, fallback=body.get("fallbackBody") or None)
            rendered = T.render(event_type, text_body, spec.sample, fallback=body.get("fallbackBody") or None)
            text = rendered.snapshot
        else:
            _row_, tb, fb, _v, _k = T.resolve_template(db, tenant_id, company.id if company else None, event_type)
            text = T.render(event_type, tb, spec.sample, fallback=fb).snapshot
    except T.TemplateError as exc:
        raise _template_error(exc) from None
    result = S.enqueue(
        db,
        tenant_id=tenant_id,
        company_id=company.id if company else None,
        event_type=event_type,
        recipient_e164=phone,
        variables={},
        dedupe_key=f"test:{uuid.uuid4()}",
        ttl=timedelta(minutes=10),
        context_label="TEST",
        is_test=True,
        created_by=user.id,
        config=config,
        body_override=f"[TEST] {text}",
    )
    db.commit()
    return _row(result.notification, {})


# ── Provider account ─────────────────────────────────────────────────────────


def _config_out(db: Session, config: Optional[NotificationProviderConfig], *, inherited: bool = False) -> Dict[str, Any]:
    settings = get_settings()
    if config is None:
        return {"configured": False, "liveSendingEnabled": bool(settings.notifications_live_sending_enabled)}
    return {
        "configured": True,
        "inherited": inherited,
        "id": str(config.id),
        "companyId": str(config.company_id) if config.company_id else None,
        "provider": config.provider,
        "mode": config.mode,
        "accountUsername": config.account_username,
        "sender": config.sender,
        "brandName": config.brand_name,
        "paused": bool(config.paused),
        "pausedReason": config.paused_reason,
        "pausedAt": _iso(config.paused_at),
        "ratePerMinute": config.rate_per_minute,
        "dailyQuota": config.daily_quota,
        "alertThreshold": config.alert_threshold,
        "testNumbers": list(config.test_numbers or []),
        "liveRestrictedToTestNumbers": bool(config.live_restricted_to_test_numbers),
        "enabledEvents": dict(config.enabled_events or {}),
        "orderReadyTtlMinutes": config.order_ready_ttl_minutes,
        "dlrPollingEnabled": bool(config.dlr_polling_enabled),
        "lastAlert": config.last_alert,
        "lastAlertAt": _iso(config.last_alert_at),
        # Never the token: whether one is stored, and when.
        "token": token_status(db, config),
        # Balance: 019 documents a balance call we have not verified — unknown, not a number.
        "balance": None,
        "liveSendingEnabled": bool(settings.notifications_live_sending_enabled),
    }


def _own_config(db: Session, user: User, tenant_id: Any, company_id: Optional[str], *, create: bool = False):
    if company_id:
        company = resolve_company(db, user, tenant_id, company_id)
        key, cid = str(company.id), company.id
    else:
        if user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
            raise error("company_required", 422)
        key, cid = "tenant", None
    config = (
        db.query(NotificationProviderConfig)
        .filter(NotificationProviderConfig.tenant_id == tenant_id, NotificationProviderConfig.scope_key == key)
        .first()
    )
    if config is None and create:
        config = S.default_config(tenant_id, cid)
        db.add(config)
        db.flush()
    return config, cid


@router.get("/notifications/provider")
def get_provider(
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    own, cid = _own_config(db, user, tenant_id, company_id)
    if own is not None:
        return _config_out(db, own)
    effective = S.get_config(db, tenant_id, cid) if cid else None
    return _config_out(db, effective, inherited=effective is not None)


def _clean_numbers(values: Any) -> List[str]:
    if not isinstance(values, list):
        raise error("test_numbers_invalid", 422)
    out: List[str] = []
    for value in values[:20]:
        try:
            phone = normalize_mobile(value)
        except PhoneError:
            raise error("test_numbers_invalid", 422, value=None) from None
        if phone not in out:
            out.append(phone)
    return out


@router.put("/notifications/provider")
def put_provider(
    body: Dict[str, Any] = Body(...),
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Update the account. `token` is write-only ("" removes it, "••••" keeps it). `mode`
    "live" is the super admin's alone, and still sends nothing while the server switch
    NOTIFICATIONS_LIVE_SENDING_ENABLED is off.
    """
    require_role(user, CLUB_ADMIN_ROLES)
    config, _cid = _own_config(db, user, tenant_id, company_id, create=True)
    if "mode" in body:
        mode = str(body["mode"])
        if mode not in MODES:
            raise error("mode_invalid", 422)
        if mode == MODE_LIVE and user.role != UserRole.SUPER_ADMIN:
            raise error("live_mode_super_admin_only", 403)
        config.mode = mode
    if "accountUsername" in body:
        value = str(body.get("accountUsername") or "").strip()
        config.account_username = value[:100] or None
    if "sender" in body:
        sender = str(body.get("sender") or "").strip()
        if sender and not is_valid_sender(sender):
            raise error("sender_invalid", 422)
        config.sender = sender or None
    if "brandName" in body:
        config.brand_name = (str(body.get("brandName") or "").strip()[:60]) or None
    for key, attr, lo, hi in (
        ("ratePerMinute", "rate_per_minute", 0, 600),
        ("dailyQuota", "daily_quota", 0, 100000),
        ("alertThreshold", "alert_threshold", 0, 100000),
        ("orderReadyTtlMinutes", "order_ready_ttl_minutes", 1, 120),
    ):
        if key in body:
            try:
                value = int(body[key])
            except (TypeError, ValueError):
                raise error(f"{key}_invalid", 422) from None
            if not lo <= value <= hi:
                raise error(f"{key}_invalid", 422)
            setattr(config, attr, value)
    if "testNumbers" in body:
        config.test_numbers = _clean_numbers(body["testNumbers"])
    if "liveRestrictedToTestNumbers" in body:
        restricted = bool(body["liveRestrictedToTestNumbers"])
        if not restricted and user.role != UserRole.SUPER_ADMIN:
            raise error("live_mode_super_admin_only", 403)
        config.live_restricted_to_test_numbers = restricted
    if "enabledEvents" in body and isinstance(body["enabledEvents"], dict):
        config.enabled_events = {
            k: bool(v) for k, v in body["enabledEvents"].items() if k in T.EVENTS and k != "Campaign"
        }
    if "dlrPollingEnabled" in body:
        config.dlr_polling_enabled = bool(body["dlrPollingEnabled"])
    if "token" in body:
        try:
            if set_token(db, config, body.get("token"), user_id=user.id):
                audit(
                    db, tenant_id=tenant_id, company_id=config.company_id, domain="notifications",
                    subject_type="provider_config", subject_id=config.id, action="token_changed",
                    actor_user_id=user.id,
                )
        except PaymentSecretError as exc:
            raise error(exc.code, 422) from None
    config.updated_by = user.id
    config.updated_at = S.utcnow()
    audit(
        db, tenant_id=tenant_id, company_id=config.company_id, domain="notifications",
        subject_type="provider_config", subject_id=config.id, action="provider_updated", actor_user_id=user.id,
        details={"mode": config.mode},
    )
    db.commit()
    return _config_out(db, config)


@router.post("/notifications/provider/{action}")
def provider_pause(
    action: str,
    body: Optional[Dict[str, Any]] = Body(None),
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """pause: nothing is sent (queued messages wait, and expire on their TTL); resume."""
    require_role(user, CLUB_ADMIN_ROLES)
    if action not in ("pause", "resume"):
        raise error("not_found", 404)
    config, _cid = _own_config(db, user, tenant_id, company_id)
    if config is None:
        raise error("provider_not_configured", 409)
    now = S.utcnow()
    if action == "pause":
        config.paused = True
        config.paused_reason = (str((body or {}).get("reason") or "").strip()[:200]) or "manual"
        config.paused_at = now
    else:
        config.paused = False
        config.paused_reason = None
        config.paused_at = None
    audit(
        db, tenant_id=tenant_id, company_id=config.company_id, domain="notifications",
        subject_type="provider_config", subject_id=config.id, action=f"provider_{action}", actor_user_id=user.id,
    )
    db.commit()
    return _config_out(db, config)


# ── Campaigns (P1 skeleton) ──────────────────────────────────────────────────


@router.get("/notifications/campaigns")
def list_campaigns(
    company_id: Optional[str] = Query(None, alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    query = db.query(Campaign).filter(Campaign.tenant_id == tenant_id)
    if company_id:
        company = resolve_company(db, user, tenant_id, company_id)
        query = query.filter(Campaign.company_id == company.id)
    rows = query.order_by(Campaign.created_at.desc()).limit(100).all()
    return {
        "sendingEnabled": False,
        "items": [
            {"id": str(c.id), "name": c.name, "status": c.status, "createdAt": _iso(c.created_at)} for c in rows
        ],
    }


@router.post("/notifications/campaigns", status_code=201)
def create_campaign(
    body: Dict[str, Any] = Body(...),
    company_id: str = Query(..., alias="companyId"),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, CLUB_ADMIN_ROLES)
    company = resolve_company(db, user, tenant_id, company_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise error("name_required", 422)
    row = Campaign(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, name=name[:120], status="draft",
                   created_by=user.id)
    db.add(row)
    db.commit()
    return {"id": str(row.id), "name": row.name, "status": row.status, "createdAt": _iso(row.created_at)}


@router.post("/notifications/campaigns/{campaign_id}/{action}")
def campaign_action(campaign_id: str, action: str, user: User = Depends(get_current_user)):
    """Approving, scheduling and sending campaigns is P1: refused, always."""
    require_role(user, CLUB_ADMIN_ROLES)
    raise error("campaigns_disabled", 409, "קמפיינים אינם זמינים בשלב זה")


# ── One message ──────────────────────────────────────────────────────────────


@router.get("/notifications/{notification_id}")
def notification_detail(
    notification_id: str,
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, LOG_ROLES)
    n = _get_notification(db, user, tenant_id, notification_id)
    out = _row(n, _shop_names(db, [n]))
    out["attemptsDetail"] = [
        {
            "sequence": a.sequence,
            "mode": a.mode,
            "startedAt": _iso(a.started_at),
            "finishedAt": _iso(a.finished_at),
            "outcome": a.outcome,
            "errorClass": a.error_class,
            "providerStatus": a.provider_status,
            "providerMessage": a.provider_message,
            "httpStatus": a.http_status,
        }
        for a in db.query(NotificationAttempt)
        .filter(NotificationAttempt.notification_id == n.id)
        .order_by(NotificationAttempt.sequence)
        .all()
    ]
    out["deliveryEvents"] = [
        {
            "rawStatus": e.raw_status,
            "mappedState": e.mapped_state,
            "applied": e.applied,
            "eventAt": _iso(e.event_at),
            "receivedAt": _iso(e.received_at),
        }
        for e in db.query(DeliveryEvent)
        .filter(DeliveryEvent.notification_id == n.id)
        .order_by(DeliveryEvent.received_at)
        .all()
    ]
    return out


@router.post("/notifications/{notification_id}/reveal-recipient")
def reveal_recipient(
    notification_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The full number — company managers and up, with a reason; every reveal is audited."""
    require_role(user, CLUB_ADMIN_ROLES)
    reason = str(body.get("reason") or "").strip()
    if not reason:
        raise error("reason_required", 422)
    n = _get_notification(db, user, tenant_id, notification_id)
    phone = S.recipient_of(n)
    audit(
        db, tenant_id=tenant_id, company_id=n.company_id, domain="notifications", subject_type="notification",
        subject_id=n.id, action="recipient_revealed", actor_user_id=user.id, reason=reason,
    )
    db.commit()
    return {"recipient": phone}


@router.post("/notifications/{notification_id}/resend")
def resend_notification(
    notification_id: str,
    body: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, LOG_ROLES)
    n = _get_notification(db, user, tenant_id, notification_id)
    try:
        new = S.resend(db, n, user_id=user.id, reason=str(body.get("reason") or ""))
    except S.NotificationError as exc:
        raise error(exc.code, exc.status) from None
    audit(
        db, tenant_id=tenant_id, company_id=n.company_id, domain="notifications", subject_type="notification",
        subject_id=new.id, action="resend", actor_user_id=user.id, reason=new.resend_reason,
        details={"of": str(n.id)},
    )
    db.commit()
    return _row(new, _shop_names(db, [new]))


@router.post("/notifications/{notification_id}/cancel")
def cancel_notification(
    notification_id: str,
    body: Optional[Dict[str, Any]] = Body(None),
    user: User = Depends(get_current_user),
    tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    require_role(user, LOG_ROLES)
    n = _get_notification(db, user, tenant_id, notification_id)
    try:
        S.cancel(db, n, reason=f"manual:{str((body or {}).get('reason') or '').strip()[:100]}")
    except S.NotificationError as exc:
        raise error(exc.code, exc.status) from None
    audit(
        db, tenant_id=tenant_id, company_id=n.company_id, domain="notifications", subject_type="notification",
        subject_id=n.id, action="cancel", actor_user_id=user.id,
    )
    db.commit()
    return _row(n, _shop_names(db, [n]))


# ── The till / KDS ───────────────────────────────────────────────────────────


@till_router.get("/sync/{machine_id}/notifications/order-status")
def till_order_status(
    machine_id: str,
    refs: str = Query(..., max_length=4000),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Short status of the ready messages of these orders / groups — this tenant's only."""
    items = S.short_status(db, machine.tenant_id, [r.strip() for r in refs.split(",") if r.strip()][:200])
    return {"items": items}

