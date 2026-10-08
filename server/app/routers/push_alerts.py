"""
"התראות" — the phone (Web Push) alerts of a dashboard user (app/services/exception_alerts/push.py).

Dashboard (Clerk/user JWT + X-Tenant-Id). The user's own devices and preferences are theirs
(route rule SELF); the alerts feed and the history are the section "alerts". A producer
(PRODUCER_VIEW) has none of this.

GET    /push/config                → push on / off, the VAPID public key, the alert types
GET    /push/devices               → my subscribed devices
POST   /push/devices               → subscribe this browser {endpoint, keys: {p256dh, auth}, label?}
POST   /push/devices/unsubscribe   → {endpoint}: this browser unsubscribed
DELETE /push/devices/{id}          → stop sending to one of my devices
GET    /push/preferences           → my preferences in this organization (defaults when none)
PUT    /push/preferences           → {enabled, categories, shopIds, eventIds, minAmount, quietFrom,
                                     quietTo, rateLimitMinutes, digestEnabled}
POST   /push/test                  → a test message to my devices
GET    /push/options               → the shops and the events (current / next two weeks) I can choose
GET    /push/alerts                → the alerts of the push types in my reach, newest first
                                     (companyId / shopId / areaId / machineId / eventId, open, days)
POST   /push/alerts/{id}/ack       → "טופל" (or back to open), with a note
GET    /push/history               → what was sent to my devices (sent / held back / failed)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.exception_alerts import CHANNEL_PUSH, ExceptionAlertDispatch, ExceptionLogEntry, PushSubscription
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.user import User, UserRole
from app.services.exception_alerts import log as L
from app.services.exception_alerts import push as P
from app.services.exception_alerts.rules import RuleError

router = APIRouter(prefix="/push", tags=["push-alerts"])

NO_ACK_ROLES = {UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR}
FEED_LIMIT_MAX = 200


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _staff(user: User) -> User:
    if getattr(user, "role", None) == getattr(UserRole, "PRODUCER_VIEW", None):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return user


def _rule_error(exc: RuleError) -> HTTPException:
    code = status.HTTP_429_TOO_MANY_REQUESTS if exc.code == "test_too_soon" else status.HTTP_422_UNPROCESSABLE_ENTITY
    return HTTPException(status_code=code, detail={"code": exc.code, "field": exc.field, "detail": exc.detail})


# ── Configuration and devices ────────────────────────────────────────────────


@router.get("/config")
def get_push_config(current_user: User = Depends(get_current_user)):
    from app.services import webpush

    _staff(current_user)
    vapid = webpush.config()
    return {
        "enabled": vapid is not None,
        "publicKey": vapid.public_key if vapid is not None else None,
        "categories": P.categories_json(),
        "defaults": {"minAmount": float(P.DEFAULT_MIN_AMOUNT), "rateLimitMinutes": P.DEFAULT_RATE_LIMIT},
    }


@router.get("/devices")
def list_devices(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _staff(current_user)
    rows = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == current_user.id)
        .order_by(PushSubscription.created_at.desc())
        .all()
    )
    return {"devices": [P.device_json(r) for r in rows]}


@router.post("/devices", status_code=status.HTTP_201_CREATED)
def add_device(
    request: Request,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _staff(current_user)
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    try:
        row = P.subscribe(
            db, current_user, active_tenant_id,
            endpoint=str(body.get("endpoint") or ""), p256dh=str(keys.get("p256dh") or ""), auth=str(keys.get("auth") or ""),
            user_agent=request.headers.get("user-agent"), label=body.get("label"),
        )
    except RuleError as exc:
        raise _rule_error(exc) from None
    db.commit()
    db.refresh(row)
    return P.device_json(row)


@router.post("/devices/unsubscribe")
def unsubscribe_device(body: Dict[str, Any] = Body(...), current_user: User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    _staff(current_user)
    endpoint = str(body.get("endpoint") or "").strip()
    row = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint_hash == P.endpoint_hash(endpoint), PushSubscription.user_id == current_user.id)
        .first() if endpoint else None
    )
    if row is not None and row.disabled_at is None:
        row.disabled_at = _now()
        db.commit()
    return {"ok": True}


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_device(device_id: uuid.UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _staff(current_user)
    row = db.get(PushSubscription, device_id)
    if row is None or row.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    if row.disabled_at is None:
        row.disabled_at = _now()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Preferences ──────────────────────────────────────────────────────────────


@router.get("/preferences")
def get_preferences(current_user: User = Depends(get_current_user), active_tenant_id=Depends(get_active_tenant_id),
                    db: Session = Depends(get_db)):
    _staff(current_user)
    return P.as_json(P.rule_for_user(db, current_user.id, active_tenant_id))


@router.put("/preferences")
def put_preferences(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _staff(current_user)
    try:
        rule = P.save_preferences(db, current_user, active_tenant_id, body)
    except RuleError as exc:
        raise _rule_error(exc) from None
    db.commit()
    db.refresh(rule)
    return P.as_json(rule)


@router.post("/test")
def send_test(current_user: User = Depends(get_current_user), active_tenant_id=Depends(get_active_tenant_id),
              db: Session = Depends(get_db)):
    from app.services import webpush

    _staff(current_user)
    if webpush.config() is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "push_not_configured"})
    try:
        rows = P.send_test(db, current_user, active_tenant_id, now=_now())
    except RuleError as exc:
        raise _rule_error(exc) from None
    db.commit()
    return {"sent": len(rows)}


@router.get("/options")
def get_options(current_user: User = Depends(get_current_user), active_tenant_id=Depends(get_active_tenant_id),
                db: Session = Depends(get_db)):
    """The shops and the events (live now, or within the next two weeks) the preferences may name."""
    from app.services.overview import _visible_shops_query
    from app.services.report_events.common import iso

    _staff(current_user)
    query = _visible_shops_query(db, current_user, active_tenant_id)
    shops = query.order_by(*_shop_order()).all() if query is not None else []
    now = _now()
    events = (
        db.query(ReportEvent)
        .filter(
            ReportEvent.tenant_id == active_tenant_id,
            ReportEvent.shop_id.in_([s.id for s in shops] or [uuid.uuid4()]),
            ReportEvent.ends_at >= now - timedelta(days=1),
            ReportEvent.starts_at <= now + timedelta(days=14),
        )
        .order_by(ReportEvent.starts_at)
        .limit(200)
        .all()
    )
    names = {s.id: s.name for s in shops}
    return {
        "shops": [{"id": str(s.id), "name": s.name} for s in shops],
        "events": [
            {"id": str(e.id), "name": e.name, "shopId": str(e.shop_id), "shopName": names.get(e.shop_id),
             "startsAt": iso(e.starts_at), "endsAt": iso(e.ends_at)}
            for e in events
        ],
    }


def _shop_order():
    from app.models.shop import Shop

    return (Shop.name,)


# ── The alerts feed and the history ──────────────────────────────────────────


@router.get("/alerts")
def list_alerts(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    event_id: Optional[uuid.UUID] = Query(None, alias="eventId"),
    open_only: bool = Query(False, alias="open"),
    days: int = Query(2, ge=1, le=31),
    limit: int = Query(50, ge=1, le=FEED_LIMIT_MAX),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The alerts of the push types in my reach (the exceptions log's scoping), newest first."""
    from app.routers.exception_log import _labels, entry_json, scoped
    from app.services.company_hierarchy import descendant_company_ids

    _staff(current_user)
    q = scoped(db, current_user, active_tenant_id)
    if q is None:
        return {"alerts": [], "open": 0, "canAcknowledge": False, "canOpenLog": False}
    kinds = sorted({k for c in P.CATEGORIES for k in c.kinds})
    q = q.filter(ExceptionLogEntry.kind.in_(kinds), ExceptionLogEntry.occurred_at >= _now() - timedelta(days=days))
    if company_id is not None:
        q = q.filter(ExceptionLogEntry.company_id.in_(descendant_company_ids(db, company_id) or [company_id]))
    if shop_id is not None:
        q = q.filter(ExceptionLogEntry.shop_id == shop_id)
    if area_id is not None:
        q = q.filter(ExceptionLogEntry.area_id == area_id)
    if machine_id is not None:
        q = q.filter(ExceptionLogEntry.machine_id == machine_id)
    if event_id is not None:
        from app.services.report_events import crud as C

        event = C.load_event(db, current_user, active_tenant_id, event_id)
        machines = db.query(ReportEventMachine.machine_id).filter(ReportEventMachine.event_id == event.id)
        q = q.filter(
            ExceptionLogEntry.machine_id.in_(machines),
            ExceptionLogEntry.occurred_at >= event.starts_at,
            ExceptionLogEntry.occurred_at < event.ends_at,
        )
    if open_only:
        q = q.filter(ExceptionLogEntry.acknowledged_at.is_(None))
    rows = [r for r in q.order_by(ExceptionLogEntry.occurred_at.desc()).limit(limit * 2).all() if P.category_of(r)]
    rows = rows[:limit]
    labels = _labels(db, rows)
    out = []
    for r in rows:
        item = entry_json(r, labels)
        item["category"] = P.category_of(r)
        item["categoryLabel"] = P.CATEGORY_BY_KEY[item["category"]].label
        out.append(item)
    return {
        "alerts": out,
        "open": sum(1 for r in rows if r.acknowledged_at is None),
        "canAcknowledge": current_user.role not in NO_ACK_ROLES,
        # An alert's own page is the exceptions log's (`/x/<code>`): only with that section.
        "canOpenLog": P.may_open_log(db, current_user),
    }


@router.post("/alerts/{entry_id}/ack")
def acknowledge_alert(
    entry_id: uuid.UUID,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.routers.exception_log import _labels, entry_json, scoped

    _staff(current_user)
    if current_user.role in NO_ACK_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    q = scoped(db, current_user, active_tenant_id)
    row = q.filter(ExceptionLogEntry.id == entry_id).first() if q is not None else None
    if row is None or P.category_of(row) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    note = body.get("note")
    L.acknowledge(db, row, user=current_user, acknowledged=body.get("acknowledged", True) is not False,
                  note=str(note)[:2000] if note is not None else None)
    db.commit()
    db.refresh(row)
    return entry_json(row, _labels(db, [row]))


@router.get("/history")
def my_history(
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What was sent to my devices in this organization, newest first."""
    from app.routers.exception_log import DISPATCH_LABELS

    _staff(current_user)
    rows: List[ExceptionAlertDispatch] = (
        db.query(ExceptionAlertDispatch)
        .filter(
            ExceptionAlertDispatch.channel == CHANNEL_PUSH,
            ExceptionAlertDispatch.user_id == current_user.id,
            ExceptionAlertDispatch.tenant_id == active_tenant_id,
        )
        .order_by(ExceptionAlertDispatch.created_at.desc())
        .limit(limit)
        .all()
    )
    entry_ids = {r.entry_id for r in rows if r.entry_id}
    entries = {e.id: e for e in db.query(ExceptionLogEntry).filter(ExceptionLogEntry.id.in_(entry_ids)).all()} if entry_ids else {}
    out = []
    for r in rows:
        entry = entries.get(r.entry_id)
        title, _, text = (r.text or "").partition("\n")
        out.append({
            "id": str(r.id),
            "kind": r.kind,
            "status": r.status,
            "statusLabel": DISPATCH_LABELS.get(r.status, r.status),
            "reason": r.reason,
            "device": r.recipient_label or r.recipient_masked,
            "title": title,
            "body": text,
            "at": L.aware(r.created_at).isoformat() if r.created_at else None,
            "sentAt": L.aware(r.sent_at).isoformat() if r.sent_at else None,
            "entryId": str(r.entry_id) if r.entry_id else None,
            "entryCode": entry.short_code if entry is not None else None,
            "category": P.category_of(entry) if entry is not None else None,
            "digestCount": r.digest_count,
        })
    return {"history": out}
