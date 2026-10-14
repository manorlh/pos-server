"""
"בקשות אישור" as the dashboard reads them: the list (pending, live; history with filters), one
request in full, and the count beside the menu entry.

Who sees what: the requests of the shops the user's role and dashboard profile cover (the same
scoping as the reports, `scope_query_by_user`) — and, whatever their scope, any request sent to
them or decided by them. Only one it was sent to, still pending, can be decided (`canDecide`).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.remote_approval import ApprovalRequest
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User
from app.services.remote_approvals import catalog as C
from app.services.remote_approvals import policy as P
from app.services.remote_approvals import service as S

MAX_LIMIT = 1000


def _iso(value: Optional[datetime]) -> Optional[str]:
    return S.aware(value).isoformat() if value is not None else None


def _scoped_ids_query(db: Session, user: User, tenant_id: Any):
    from app.services.scoping import scope_query_by_user

    q = db.query(ApprovalRequest.id).filter(ApprovalRequest.tenant_id == tenant_id)
    return scope_query_by_user(
        q, user, db, shop_column=ApprovalRequest.shop_id, machine_column=ApprovalRequest.machine_id,
    )


def _names(db: Session, rows: Iterable[ApprovalRequest]) -> Tuple[Dict[Any, str], Dict[Any, str], Dict[Any, str]]:
    rows = list(rows)
    shop_ids = {r.shop_id for r in rows if r.shop_id}
    machine_ids = {r.machine_id for r in rows if r.machine_id}
    area_ids = {r.area_id for r in rows if r.area_id}
    shops = {s.id: s.name for s in db.query(Shop.id, Shop.name).filter(Shop.id.in_(shop_ids))} if shop_ids else {}
    machines = (
        {m.id: S._machine_name(m) for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids))}
        if machine_ids else {}
    )
    areas = (
        {a.id: a.name for a in db.query(ShopArea.id, ShopArea.name).filter(ShopArea.id.in_(area_ids))}
        if area_ids else {}
    )
    return shops, machines, areas


def card_out(req: ApprovalRequest, user: User, names, now: datetime) -> Dict[str, Any]:
    shops, machines, areas = names
    state = S.shown_status(req, now)
    t = C.TYPES_BY_KEY.get(req.type)
    return {
        "id": str(req.id),
        "type": req.type,
        "typeLabel": t.label if t else req.type,
        "status": state,
        "shopId": str(req.shop_id) if req.shop_id else None,
        "shopName": shops.get(req.shop_id),
        "machineId": str(req.machine_id),
        "machineName": machines.get(req.machine_id),
        "areaName": areas.get(req.area_id),
        "requesterName": req.requester_name,
        "requesterPosUserId": str(req.requester_pos_user_id) if req.requester_pos_user_id else None,
        "amount": S._num(req.amount),
        "percent": S._num(req.percent),
        "reasonCode": req.reason_code,
        "reasonText": req.reason_text,
        "note": req.note,
        "tableLabel": S.table_label(req.payload),
        "createdAt": _iso(req.created_at),
        "expiresAt": _iso(req.expires_at),
        "decidedAt": _iso(req.decided_at),
        "decidedByName": req.decided_by_name,
        "decidedByUserId": str(req.decided_by_user_id) if req.decided_by_user_id else None,
        "approvedAmount": S._num(req.approved_amount),
        "approvedPercent": S._num(req.approved_percent),
        "message": req.message,
        "sentTo": [
            {"userId": item.get("userId"), "name": item.get("name")}
            for item in (req.sent_to or []) if isinstance(item, dict)
        ],
        "canDecide": state == S.PENDING and S.was_sent_to(req, user.id),
    }


def may_view(db: Session, user: User, tenant_id: Any, req: ApprovalRequest) -> bool:
    if req.tenant_id != tenant_id and str(req.tenant_id) != str(tenant_id):
        return False
    if S.was_sent_to(req, user.id) or str(req.decided_by_user_id) == str(user.id):
        return True
    scoped = _scoped_ids_query(db, user, tenant_id)
    return scoped is not None and scoped.filter(ApprovalRequest.id == req.id).first() is not None


def detail_out(db: Session, req: ApprovalRequest, user: User, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or S.utcnow()
    out = card_out(req, user, _names(db, [req]), now)
    machine = db.get(POSMachine, req.machine_id)
    type_policy = P.for_machine(db, machine).type(req.type) if machine is not None else C.type_defaults(req.type)
    my_limit = None
    if out["canDecide"] and machine is not None:
        from app.services.remote_approvals.eligibility import approver_for

        approver = approver_for(db, machine, S.ask_of(req), type_policy, user, escalated=req.escalated_at is not None)
        if approver is None:
            out["canDecide"] = False
        else:
            my_limit = approver.limit
    t = C.TYPES_BY_KEY.get(req.type)
    out.update({
        "clientRequestId": req.client_request_id,
        "payload": req.payload if isinstance(req.payload, dict) else {},
        "allowPartial": bool(type_policy.get("allowPartial")),
        "quickApprove": bool(type_policy.get("quickApprove")),
        "limitUnit": t.unit if t else None,
        "myLimit": my_limit,
        "escalatedAt": _iso(req.escalated_at),
        "decidedFrom": req.decided_from,
    })
    return out


def _day_bounds(db: Session, tenant_id: Any, day_from: Optional[date], day_to: Optional[date]):
    from app.services.exception_alerts.engine import tz_for

    tz = tz_for(db, tenant_id)
    start = datetime.combine(day_from, time.min, tzinfo=tz) if day_from else None
    end = datetime.combine(day_to + timedelta(days=1), time.min, tzinfo=tz) if day_to else None
    return start, end


def _pending_for(db: Session, user: User, tenant_id: Any, now: datetime) -> List[ApprovalRequest]:
    """Pending requests (not yet past) this user may see: in scope, or sent to them."""
    rows = (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.tenant_id == tenant_id,
            ApprovalRequest.status == S.PENDING,
            ApprovalRequest.expires_at > now,
        )
        .order_by(ApprovalRequest.created_at.desc())
        .limit(MAX_LIMIT)
        .all()
    )
    if not rows:
        return []
    scoped = _scoped_ids_query(db, user, tenant_id)
    in_scope: Set[Any] = set()
    if scoped is not None:
        in_scope = {r[0] for r in scoped.filter(ApprovalRequest.id.in_([r.id for r in rows])).all()}
    return [r for r in rows if r.id in in_scope or S.was_sent_to(r, user.id)]


def pending_count(db: Session, user: User, tenant_id: Any, now: Optional[datetime] = None) -> int:
    """For the menu: pending requests this user is one of the approvers of."""
    now = now or S.utcnow()
    rows = (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.tenant_id == tenant_id,
            ApprovalRequest.status == S.PENDING,
            ApprovalRequest.expires_at > now,
        )
        .limit(MAX_LIMIT)
        .all()
    )
    return sum(1 for r in rows if S.was_sent_to(r, user.id))


def list_for(
    db: Session,
    user: User,
    tenant_id: Any,
    *,
    status: str = "all",
    type_key: Optional[str] = None,
    shop_id: Optional[uuid.UUID] = None,
    requester: Optional[str] = None,
    approver: Optional[uuid.UUID] = None,
    outcome: Optional[str] = None,
    reason: Optional[str] = None,
    day_from: Optional[date] = None,
    day_to: Optional[date] = None,
    limit: int = 200,
    offset: int = 0,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    now = now or S.utcnow()
    limit = max(1, min(int(limit or 200), MAX_LIMIT))
    offset = max(0, int(offset or 0))
    pending_rows = _pending_for(db, user, tenant_id, now)
    if status == "pending":
        rows = pending_rows
        if type_key:
            rows = [r for r in rows if r.type == type_key]
        if shop_id:
            rows = [r for r in rows if str(r.shop_id) == str(shop_id)]
        total = len(rows)
        rows = rows[offset:offset + limit]
    else:
        scoped = _scoped_ids_query(db, user, tenant_id)
        q = db.query(ApprovalRequest).filter(ApprovalRequest.tenant_id == tenant_id)
        mine = [r.id for r in pending_rows]
        conditions = [ApprovalRequest.decided_by_user_id == user.id]
        if scoped is not None:
            conditions.append(ApprovalRequest.id.in_(scoped.subquery().select()))
        if mine:
            conditions.append(ApprovalRequest.id.in_(mine))
        q = q.filter(or_(*conditions))
        if type_key:
            q = q.filter(ApprovalRequest.type == type_key)
        if shop_id:
            q = q.filter(ApprovalRequest.shop_id == shop_id)
        if requester:
            q = q.filter(func.lower(ApprovalRequest.requester_name).contains(requester.strip().lower()))
        if approver:
            q = q.filter(ApprovalRequest.decided_by_user_id == approver)
        if outcome:
            if outcome == S.EXPIRED:
                q = q.filter(or_(
                    ApprovalRequest.status == S.EXPIRED,
                    (ApprovalRequest.status == S.PENDING) & (ApprovalRequest.expires_at <= now),
                ))
            elif outcome == S.PENDING:
                q = q.filter(ApprovalRequest.status == S.PENDING, ApprovalRequest.expires_at > now)
            else:
                q = q.filter(ApprovalRequest.status == outcome)
        if reason:
            needle = reason.strip().lower()
            q = q.filter(or_(
                func.lower(ApprovalRequest.reason_code).contains(needle),
                func.lower(ApprovalRequest.reason_text).contains(needle),
            ))
        start, end = _day_bounds(db, tenant_id, day_from, day_to)
        if start is not None:
            q = q.filter(ApprovalRequest.created_at >= start)
        if end is not None:
            q = q.filter(ApprovalRequest.created_at < end)
        total = q.count()
        rows = q.order_by(ApprovalRequest.created_at.desc()).offset(offset).limit(limit).all()
    names = _names(db, rows)
    return {
        "items": [card_out(r, user, names, now) for r in rows],
        "total": total,
        "pendingCount": sum(1 for r in pending_rows if S.was_sent_to(r, user.id)),
    }
