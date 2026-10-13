"""
"בקשת אישור ממנהל מהנייד" (P:/specs/manager-approval-mobile.md §7, §9).

The till's side (machine JWT, like `/elevation`):

* `GET  /approvals/approvers` — who this till may ask, already filtered by the rules.
* `POST /approvals` — a request (idempotent per till by `clientRequestId`).
* `POST /approvals/{id}/add-approvers` — "שלח לעוד מאשר".
* `DELETE /approvals/{id}` — "בטל".
* `GET  /approvals/{id}` — its state, and the one-use `grantId` once approved.
* `POST /approvals/{id}/use` — spend the grant on the action it was given for.

The dashboard's side (a dashboard user; sections `approvals` / `approval_settings`):

* `GET  /approvals` — pending (live) and history, with filters.
* `GET  /approvals/pending-count` — the number beside the menu entry.
* `GET  /approvals/{id}` — one request in full (the same path as the till's: the token decides).
* `POST /approvals/{id}/decide` — approve (also partly) or reject; the first decision wins.
* `GET/PUT /approvals/policy?level=company|shop|area|machine&id=` — "בקשות אישור" settings.
* `GET  /approvals/catalog` — the types, fields, roles and defaults.

And beside them, "עובד מקושר" (`/users/{id}/linked-employees`) and the employee card's
overrides (`/shops/{shop}/pos-users/{id}/approval-overrides`).
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_machine_token,
    security,
)
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.remote_approval import POLICY_LEVELS, ApprovalRequest, DashboardUserEmployee
from app.models.shop import Shop
from app.models.till_role import TillRole
from app.models.user import User, UserRole
from app.services.auth import decode_jwt_payload
from app.services.remote_approvals import catalog as C
from app.services.remote_approvals import overrides as OV
from app.services.remote_approvals import policy as P
from app.services.remote_approvals import service as S
from app.services.remote_approvals import views as V

router = APIRouter(prefix="/approvals", tags=["approvals"])
users_router = APIRouter(prefix="/users", tags=["approvals"])
shops_router = APIRouter(prefix="/shops", tags=["approvals"])

_WIRE = ConfigDict(populate_by_name=True)


# ── Wire shapes ──────────────────────────────────────────────────────────────


class ApprovalCreateIn(BaseModel):
    model_config = _WIRE

    client_request_id: str = Field(..., alias="clientRequestId", min_length=1, max_length=64)
    type: str = Field(..., max_length=32)
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    requester_pos_user_id: Optional[uuid.UUID] = Field(None, alias="requesterPosUserId")
    #: Dashboard user ids from `GET /approvals/approvers`; null / [] = "כל המורשים".
    approver_ids: Optional[List[uuid.UUID]] = Field(None, alias="approverIds")
    amount: Optional[float] = Field(None, ge=-10_000_000, le=10_000_000)
    percent: Optional[float] = Field(None, ge=0, le=100)
    reason_code: Optional[str] = Field(None, alias="reasonCode", max_length=100)
    reason_text: Optional[str] = Field(None, alias="reasonText", max_length=500)
    note: Optional[str] = Field(None, max_length=2000)
    payload: Optional[Dict[str, Any]] = None


class AddApproversIn(BaseModel):
    model_config = _WIRE

    approver_ids: Optional[List[uuid.UUID]] = Field(None, alias="approverIds")


class UseGrantIn(BaseModel):
    model_config = _WIRE

    grant_id: str = Field(..., alias="grantId", min_length=1, max_length=200)
    amount: Optional[float] = None
    percent: Optional[float] = None


class DecideIn(BaseModel):
    model_config = _WIRE

    decision: str
    approved_amount: Optional[float] = Field(None, alias="approvedAmount")
    approved_percent: Optional[float] = Field(None, alias="approvedPercent")
    message: Optional[str] = Field(None, max_length=2000)


class LinkedEmployeesIn(BaseModel):
    model_config = _WIRE

    pos_user_ids: List[uuid.UUID] = Field(default_factory=list, alias="posUserIds")


def _check_machine(machine: POSMachine, machine_id: Optional[Any]) -> None:
    if machine_id is not None and str(machine_id) != str(machine.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="machine_mismatch")
    if machine.shop_id is None or machine.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_unassigned")


def _machine_request(db: Session, machine: POSMachine, request_id: uuid.UUID) -> ApprovalRequest:
    req = db.get(ApprovalRequest, request_id)
    if req is None or str(req.machine_id) != str(machine.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    return req


# ── The dashboard's catalog and settings ─────────────────────────────────────
# (Literal paths before `/{request_id}`.)


def _custom_till_roles(db: Session, company_id: Any) -> List[Dict[str, str]]:
    if company_id is None:
        return []
    rows = (
        db.query(TillRole)
        .filter(TillRole.company_id == company_id, TillRole.deleted_at.is_(None), TillRole.builtin_key.is_(None))
        .order_by(TillRole.sort_order, TillRole.name)
        .all()
    )
    return [{"key": f"till:{r.id}", "label": r.name, "kind": "till"} for r in rows]


@router.get("/catalog")
def get_catalog(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The request types, the settings fields, the roles and the §4 defaults."""
    return C.catalog_json(_custom_till_roles(db, company_id))


def _level_target(db: Session, user: User, tenant_id: Any, level: str, target_id: Optional[uuid.UUID]):
    """The chain (most specific first) for the level, its company, and the shop / company to check writes on."""
    from app.middleware.auth import ensure_same_tenant
    from app.routers.companies import _check_company_access
    from app.routers.shops import _check_shop_access
    from app.services.areas import get_area

    if level not in POLICY_LEVELS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="level must be company, shop, area or machine")
    if target_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="id is required")
    if level == "company":
        company = db.get(Company, target_id)
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, tenant_id)
        _check_company_access(user, company, db)
        return P.chain_for(company_id=company.id), company.id, None, company
    if level == "shop":
        shop = db.get(Shop, target_id)
        if shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
        ensure_same_tenant(shop.tenant_id, tenant_id)
        _check_shop_access(user, shop, db)
        return P.chain_for(company_id=shop.company_id, shop_id=shop.id), shop.company_id, shop, None
    if level == "area":
        area = get_area(db, target_id)
        if area is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
        ensure_same_tenant(area.tenant_id, tenant_id)
        shop = db.get(Shop, area.shop_id)
        _check_shop_access(user, shop, db)
        return (
            P.chain_for(company_id=shop.company_id, shop_id=shop.id, area_id=area.id), shop.company_id, shop, None,
        )
    machine = db.get(POSMachine, target_id)
    if machine is None or machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, tenant_id)
    shop = db.get(Shop, machine.shop_id)
    _check_shop_access(user, shop, db)
    return (
        P.chain_for(company_id=shop.company_id, shop_id=shop.id, area_id=machine.area_id, machine_id=machine.id),
        shop.company_id, shop, None,
    )


def _can_write(db: Session, user: User, level: str, shop, company) -> bool:
    from app.routers.settings import _check_company_settings_write, _check_shop_settings_write

    if user.role in (UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR):
        return False
    try:
        if level == "company":
            _check_company_settings_write(user, company, db)
        else:
            _check_shop_settings_write(user, shop, db)
        return True
    except HTTPException:
        return False


def _policy_out(db: Session, level: str, chain, company_id, can_write: bool) -> Dict[str, Any]:
    rows = P.rows_on_chain(db, chain)
    own_scope = chain[0]
    own_row = next((r for r in rows if (r.scope_type, P._uuid(r.scope_id)) == own_scope), None)
    own = P._stored(own_row.values) if own_row is not None else {}
    inherited = P.resolve(rows, chain[1:])
    effective = P.resolve(rows, chain)
    return {
        "level": level,
        "id": str(own_scope[1]),
        "canWrite": can_write,
        "own": {
            "enabled": own.get("enabled"), "types": own.get("types") or {},
            "approvalStyle": own.get("approvalStyle") or {},
        },
        "inherited": {"enabled": inherited.enabled, "types": inherited.types, "approvalStyle": inherited.styles},
        "inheritedSources": {
            "enabled": inherited.enabled_source, "types": inherited.sources,
            "approvalStyle": inherited.style_sources,
        },
        "effective": {"enabled": effective.enabled, "types": effective.types, "approvalStyle": effective.styles},
        "updatedAt": own_row.updated_at.isoformat() if own_row is not None and own_row.updated_at else None,
        "catalog": C.catalog_json(_custom_till_roles(db, company_id)),
    }


@router.get("/policy")
def get_policy(
    level: str = Query(...),
    target_id: Optional[uuid.UUID] = Query(None, alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One level's own values, what it inherits and from where, and what applies."""
    chain, company_id, shop, company = _level_target(db, current_user, active_tenant_id, level, target_id)
    return _policy_out(db, level, chain, company_id, _can_write(db, current_user, level, shop, company))


@router.put("/policy")
def put_policy(
    body: Dict[str, Any],
    level: str = Query(...),
    target_id: Optional[uuid.UUID] = Query(None, alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Replace this level's own values (null / absent = inherit). The tills below are told to pull."""
    chain, company_id, shop, company = _level_target(db, current_user, active_tenant_id, level, target_id)
    if not _can_write(db, current_user, level, shop, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    scope_type, scope_id = chain[0]
    try:
        P.save_level(
            db, tenant_id=active_tenant_id, scope_type=scope_type, scope_id=scope_id, payload=body,
            user_id=current_user.id, now=S.utcnow(),
        )
    except P.PolicyValueError as err:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(err))
    machines = P.machines_under(db, scope_type, scope_id)
    db.commit()
    from app.services import ably_notify

    for m in machines:
        if m.tenant_id is not None and P.capable(m):
            ably_notify.publish_settings_notify(str(m.tenant_id), str(m.id), reason="approval_requests")
    return _policy_out(db, level, chain, company_id, True)


@router.get("/policy/approvers")
def get_policy_approvers(
    level: str = Query(...),
    target_id: Optional[uuid.UUID] = Query(None, alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Who could receive this level's requests — every type that is on, whoever is at work now —
    and their phones (§5: "לאחמ"ש דנה אין נייד רשום, היא לא תקבל בקשות").
    """
    from types import SimpleNamespace

    from app.services.remote_approvals.eligibility import Ask, device_health, evaluate

    chain, company_id, shop, company = _level_target(db, current_user, active_tenant_id, level, target_id)
    if level == "company":
        shops = db.query(Shop).filter(Shop.company_id == company_id).order_by(Shop.name).limit(50).all()
    else:
        shops = [shop]
    area_id = dict(chain).get("area")
    machine_id = dict(chain).get("machine")
    people: Dict[Any, Dict[str, Any]] = {}
    for one in shops:
        place = SimpleNamespace(
            id=machine_id, shop_id=one.id, tenant_id=one.tenant_id, shop=one,
            area_id=area_id if level in ("area", "machine") else None,
        )
        effective = P.resolve(P.rows_on_chain(db, P.chain_for(
            company_id=one.company_id, shop_id=one.id, area_id=place.area_id, machine_id=machine_id,
        )), P.chain_for(company_id=one.company_id, shop_id=one.id, area_id=place.area_id, machine_id=machine_id))
        if not effective.enabled:
            continue
        for t in C.TYPES:
            tp = effective.type(t.key)
            if not tp.get("enabled") or "remote" not in (tp.get("methods") or []):
                continue
            for a in evaluate(db, place, Ask(type_key=t.key), tp, ignore_shift=True):
                item = people.setdefault(a.user_id, {
                    "userId": str(a.user_id), "name": a.name, "roles": [], "types": [], "shops": [],
                })
                if a.role_label not in item["roles"]:
                    item["roles"].append(a.role_label)
                if t.key not in item["types"]:
                    item["types"].append(t.key)
                if one.name not in item["shops"]:
                    item["shops"].append(one.name)
    health = device_health(db, list(people))
    items = []
    for user_id, item in people.items():
        h = health.get(user_id) or {"devices": 0, "lastSuccessAt": None, "lastFailureAt": None, "tone": "red"}
        items.append({**item, "health": h, "hasDevice": bool(h.get("devices"))})
    items.sort(key=lambda i: (i["hasDevice"], i["name"] or ""))
    return {"items": items, "withoutDevice": [i["name"] for i in items if not i["hasDevice"]]}


# ── The dashboard's requests ─────────────────────────────────────────────────


@router.get("/pending-count")
def get_pending_count(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return {"count": V.pending_count(db, current_user, active_tenant_id)}


@router.get("")
def list_requests(
    status_filter: str = Query("all", alias="status"),
    type_key: Optional[str] = Query(None, alias="type"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    requester: Optional[str] = Query(None, max_length=100),
    approver: Optional[uuid.UUID] = Query(None),
    outcome: Optional[str] = Query(None),
    reason: Optional[str] = Query(None, max_length=100),
    day_from: Optional[date] = Query(None, alias="from"),
    day_to: Optional[date] = Query(None, alias="to"),
    limit: int = Query(200, ge=1, le=V.MAX_LIMIT),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Pending (live) or all (history), with the history's filters."""
    if status_filter not in ("pending", "all"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="status must be pending or all")
    if outcome is not None and outcome not in ("pending", "approved", "rejected", "expired", "cancelled"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unknown outcome")
    return V.list_for(
        db, current_user, active_tenant_id, status=status_filter, type_key=type_key, shop_id=shop_id,
        requester=requester, approver=approver, outcome=outcome, reason=reason, day_from=day_from,
        day_to=day_to, limit=limit, offset=offset,
    )


@router.post("/{request_id}/decide")
def decide_request(
    request_id: uuid.UUID,
    body: DecideIn,
    request: Request,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Approve (also for less, where allowed) or reject. The first decision wins (409 after it)."""
    from app.services.exception_alerts.push import device_label

    req = db.get(ApprovalRequest, request_id)
    if req is None or not V.may_view(db, current_user, active_tenant_id, req):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    try:
        req = S.decide(
            db, request_id, current_user, tenant_id=active_tenant_id, decision=body.decision,
            approved_amount=body.approved_amount, approved_percent=body.approved_percent,
            message=body.message, device=device_label(request.headers.get("user-agent")),
        )
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    db.refresh(req)
    return V.detail_out(db, req, current_user)


# ── The till's requests ──────────────────────────────────────────────────────


@router.get("/approvers")
def list_approvers(
    type_key: str = Query(..., alias="type"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    amount: Optional[float] = Query(None),
    percent: Optional[float] = Query(None),
    count: Optional[float] = Query(None),
    requester_pos_user_id: Optional[uuid.UUID] = Query(None, alias="requesterPosUserId"),
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """The approvers this till may ask for this, already filtered by the rules (§7)."""
    _check_machine(machine, machine_id)
    approvers = S.approvers_for_till(
        db, machine, type_key, amount=amount, percent=percent, count=count,
        requester_pos_user_id=requester_pos_user_id,
    )
    return [
        {
            "approverId": str(a.user_id),
            "name": a.name,
            "role": a.role_label,
            "onShift": a.on_shift,
            "hasDevice": a.has_device,
        }
        for a in approvers
    ]


@router.post("")
def create_request(
    body: ApprovalCreateIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """A request (§7). 201 when new; 200 with its current state for a repeated `clientRequestId`."""
    _check_machine(machine, body.machine_id)
    try:
        req, created = S.create(db, machine, body)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return S.created_out(req)


@router.post("/{request_id}/add-approvers")
def add_approvers(
    request_id: uuid.UUID,
    body: AddApproversIn,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """"שלח לעוד מאשר" (null = everyone eligible not asked yet)."""
    req = _machine_request(db, machine, request_id)
    try:
        S.add_approvers(db, machine, req, body.approver_ids)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return S.created_out(req)


@router.delete("/{request_id}")
def cancel_request(
    request_id: uuid.UUID,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """"בטל" at the till. Again: fine. Already decided: 409 `already_decided`."""
    try:
        req = S.cancel(db, machine, request_id)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return S.till_out(db, req)


@router.post("/{request_id}/use")
def use_grant(
    request_id: uuid.UUID,
    body: UseGrantIn,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """Spend the approval's one-use grant on the action (§7 "שימוש באישור", §9.8)."""
    try:
        req = S.use_grant(db, machine, request_id, body.grant_id, amount=body.amount, percent=body.percent)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return {
        "ok": True,
        "approvedBy": req.decided_by_name,
        "approvedByUserId": str(req.decided_by_user_id) if req.decided_by_user_id else None,
        "approvedByPosUserId": str(req.decided_by_pos_user_id) if req.decided_by_pos_user_id else None,
    }


def _caller(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> Tuple[Optional[POSMachine], Optional[User], Any]:
    """`GET /approvals/{id}` serves the till (machine token) and the dashboard (user token)."""
    payload = decode_jwt_payload(credentials.credentials)
    if payload and payload.get("type") == "machine":
        return get_pos_machine_from_machine_token(credentials, db), None, None
    user = get_current_user(request, credentials, db)
    tenant_id = get_active_tenant_id(x_tenant_id=request.headers.get("X-Tenant-Id"), current_user=user, db=db)
    return None, user, tenant_id


@router.get("/{request_id}")
def get_request(
    request_id: uuid.UUID,
    caller=Depends(_caller),
    db: Session = Depends(get_db),
):
    """The till: its request's state and grant (§7). The dashboard: the request in full."""
    machine, user, tenant_id = caller
    if machine is not None:
        req = _machine_request(db, machine, request_id)
        if S.is_past(req, S.utcnow()):
            # Read past its time: expired now (the till is told; the sweep would do the same).
            locked = S._locked(db, request_id)
            if locked is not None and S.expire(db, locked):
                db.commit()
                req = locked
        return S.till_out(db, req)
    req = db.get(ApprovalRequest, request_id)
    if req is None or not V.may_view(db, user, tenant_id, req):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    return V.detail_out(db, req, user)


# ── "עובד מקושר" ─────────────────────────────────────────────────────────────


def _employee_out(db: Session, pus: List[PosUser], links: Optional[Dict[Any, Any]] = None) -> List[Dict[str, Any]]:
    from app.services.till_roles import effective_for_users

    shops = {s.id: s.name for s in db.query(Shop.id, Shop.name).filter(Shop.id.in_({p.shop_id for p in pus}))} if pus else {}
    eff = effective_for_users(db, pus) if pus else {}
    out = []
    for pu in pus:
        item = {
            "posUserId": str(pu.id),
            "name": " ".join(p for p in (pu.first_name, pu.last_name) if p) or pu.username,
            "username": pu.username,
            "shopId": str(pu.shop_id),
            "shopName": shops.get(pu.shop_id),
            "tillRoleName": eff[pu.id].role_name if pu.id in eff else None,
        }
        if links is not None:
            linked = links.get(pu.id)
            item["linkedUserId"] = str(linked) if linked else None
        out.append(item)
    return out


def _target_user(db: Session, actor: User, tenant_id: Any, user_id: uuid.UUID, *, write: bool) -> User:
    from app.middleware.auth import ensure_same_tenant
    from app.routers.users import ROLE_LEVEL, USER_READ_ROLES, _check_scope_access

    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(target.tenant_id, tenant_id)
    if actor.id == target.id and (not write or actor.role in USER_READ_ROLES):
        # Oneself: read always; link one's own employees only as a manager of users (a cashier
        # linking themselves to a manager's employee would be a promotion by their own hand).
        return target
    if actor.role not in USER_READ_ROLES or not _check_scope_access(actor, target, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if write and actor.role != UserRole.SUPER_ADMIN and ROLE_LEVEL.get(actor.role, 0) <= ROLE_LEVEL.get(target.role, 0):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return target


def _linked(db: Session, user_id: Any) -> List[PosUser]:
    return (
        db.query(PosUser)
        .join(DashboardUserEmployee, DashboardUserEmployee.pos_user_id == PosUser.id)
        .filter(DashboardUserEmployee.user_id == user_id)
        .order_by(PosUser.username)
        .all()
    )


def _readable_shops(db: Session, actor: User, tenant_id: Any) -> List[Shop]:
    from app.routers.pos_users import _check_read

    out = []
    for shop in db.query(Shop).filter(Shop.tenant_id == tenant_id).all():
        try:
            _check_read(actor, shop, db)
        except HTTPException:
            continue
        out.append(shop)
    return out


@users_router.get("/linked-employees/candidates")
def linked_employee_candidates(
    q: Optional[str] = Query(None, max_length=100),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Till employees the caller may link (their shops), with whom each is linked to now."""
    shops = [s.id for s in _readable_shops(db, current_user, active_tenant_id)]
    if shop_id is not None:
        shops = [s for s in shops if s == shop_id]
    if not shops:
        return {"items": []}
    query = db.query(PosUser).filter(PosUser.shop_id.in_(shops), PosUser.is_active.is_(True))
    if q:
        needle = f"%{q.strip().lower()}%"
        query = query.filter(or_(
            func.lower(PosUser.username).like(needle),
            func.lower(func.coalesce(PosUser.first_name, "")).like(needle),
            func.lower(func.coalesce(PosUser.last_name, "")).like(needle),
            func.lower(func.coalesce(PosUser.worker_number, "")).like(needle),
        ))
    pus = query.order_by(PosUser.username).limit(200).all()
    links = {
        r.pos_user_id: r.user_id
        for r in db.query(DashboardUserEmployee).filter(DashboardUserEmployee.pos_user_id.in_([p.id for p in pus]))
    } if pus else {}
    return {"items": _employee_out(db, pus, links)}


@users_router.get("/{user_id}/linked-employees")
def get_linked_employees(
    user_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"עובד מקושר": the till employees this dashboard user is."""
    target = _target_user(db, current_user, active_tenant_id, user_id, write=False)
    return {"items": _employee_out(db, _linked(db, target.id))}


@users_router.put("/{user_id}/linked-employees")
def put_linked_employees(
    user_id: uuid.UUID,
    body: LinkedEmployeesIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Set the employees this user is (an employee linked to someone else moves to them)."""
    from app.routers.pos_users import _check_read

    target = _target_user(db, current_user, active_tenant_id, user_id, write=True)
    wanted = list(dict.fromkeys(body.pos_user_ids))
    if len(wanted) > 50:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="at most 50 employees")
    pus = db.query(PosUser).filter(PosUser.id.in_(wanted)).all() if wanted else []
    if len(pus) != len(wanted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
    for pu in pus:
        shop = db.get(Shop, pu.shop_id)
        if shop is None or str(shop.tenant_id) != str(active_tenant_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
        _check_read(current_user, shop, db)
    existing = {r.pos_user_id: r for r in db.query(DashboardUserEmployee).filter(DashboardUserEmployee.user_id == target.id)}
    keep = {pu.id for pu in pus}
    for pos_user_id, row in existing.items():
        if pos_user_id not in keep:
            db.delete(row)
    db.flush()
    for pu in pus:
        if pu.id in existing:
            continue
        other = db.query(DashboardUserEmployee).filter(DashboardUserEmployee.pos_user_id == pu.id).first()
        if other is not None:
            db.delete(other)
            db.flush()
        db.add(DashboardUserEmployee(
            id=uuid.uuid4(), tenant_id=active_tenant_id, user_id=target.id, pos_user_id=pu.id,
            created_by=current_user.id,
        ))
    db.commit()
    return {"items": _employee_out(db, _linked(db, target.id))}


# ── The employee card: approval overrides ────────────────────────────────────


def _card_target(db: Session, actor: User, shop_id: uuid.UUID, pos_user_id: uuid.UUID, *, write: bool) -> PosUser:
    from app.routers.pos_users import _check_read, _check_write

    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    (_check_write if write else _check_read)(actor, shop, db)
    pu = db.query(PosUser).filter(PosUser.id == pos_user_id, PosUser.shop_id == shop.id).first()
    if pu is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
    return pu


@shops_router.get("/{shop_id}/pos-users/{pos_user_id}/approval-overrides")
def get_approval_overrides(
    shop_id: uuid.UUID,
    pos_user_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The employee card's "בקשות אישור מרחוק": off-shift, personal limit, no requests."""
    return OV.as_json(_card_target(db, current_user, shop_id, pos_user_id, write=False))


@shops_router.put("/{shop_id}/pos-users/{pos_user_id}/approval-overrides")
def put_approval_overrides(
    shop_id: uuid.UUID,
    pos_user_id: uuid.UUID,
    body: Dict[str, Any],
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pu = _card_target(db, current_user, shop_id, pos_user_id, write=True)
    try:
        OV.write(pu, body)
    except OV.OverrideValueError as err:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(err))
    db.commit()
    db.refresh(pu)
    return OV.as_json(pu)
