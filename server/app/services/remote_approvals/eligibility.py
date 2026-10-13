"""
Who may approve one request — the one function every path asks (the approvers list a till
shows, creating a request, "שלח לעוד מאשר", the escalation, and the decision itself), so a
person offered at the till is exactly a person whose decision the cloud accepts.

An approver is a **dashboard user** (the decision is made on the phone, in the dashboard). They
qualify through either permission system the owner named (§0), by role key (catalog.py):

* **a till role** (`till:…`) — through an employee linked to them ("עובד מקושר") in the same
  company: the employee's role is in `approverRoles`, the role allows
  `APPROVE_REMOTE.<type>` ("רשאי לאשר מרחוק", till_permissions.py) and the ceiling covers the
  request. The ceiling, most specific first: the employee's personal one (the card's override)
  → the policy's `limits[role]` → the role's `APPROVE_REMOTE.<type>` limit → the role's existing
  limit on the underlying permission (`limit_covers`, e.g. DISCOUNT's maxPercent).
* **a dashboard role** (`dash:…`) — the user's own role is in `approverRoles`; no ceiling unless
  the policy sets `limits[role]` (§4: "לתפקידי דשבורד: ללא תקרה").

And, for both: the user is active and in this tenant, may open "בקשות אישור" at edit (the
dashboard section `approvals`), their scope covers the till's shop, and:

* **"רק במשמרת"** (`onShiftOnly[role]`): an open attendance shift of a linked employee — in this
  shop, or in any shop of the company (`onShiftScope`). A user with no linked employee is not
  bound by it (§4). The employee card's "רשאי לאשר גם כשאינו במשמרת" lifts it.
* **"לא מקבל בקשות"** on any linked employee (for this type or all): never.
* **`selfApprove`** off: never the person who asked (their linked employee is the requester).

`hasDevice` (an active push subscription) is a flag, not a rule — except when no eligible
approver has one at all: then nobody can be reached and the list is empty (`422 no_approvers`).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.attendance import AttendanceShift
from app.models.exception_alerts import PushSubscription
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.remote_approval import DashboardUserEmployee
from app.models.shop import Shop
from app.models.tenant_membership import TenantMembership
from app.models.user import User, UserRole
from app.services import till_permissions as TP
from app.services.remote_approvals import catalog as C
from app.services.remote_approvals import overrides as OV

SECTION = "approvals"


@dataclass(frozen=True)
class Ask:
    """What is being asked: the type and its figures, and who asks."""

    type_key: str
    amount: Optional[float] = None
    percent: Optional[float] = None
    #: installments_over: the number of payments (`payload.installments`).
    count: Optional[float] = None
    requester_pos_user_id: Optional[uuid.UUID] = None


@dataclass
class Approver:
    user_id: uuid.UUID
    user: Any
    name: str
    role_key: str
    role_label: str
    on_shift: bool
    has_device: bool = False
    #: Their employee at the till's shop, if linked (for the document's approver).
    pos_user_id: Optional[uuid.UUID] = None
    #: The ceiling that applied (None = none).
    limit: Optional[Dict[str, float]] = None
    paths: List[str] = field(default_factory=list)


def _f(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def covers(limits: Optional[Mapping[str, Any]], ask: Ask) -> bool:
    """`limit_covers` for an explicit ceiling: every limit set must cover its figure."""
    if not limits:
        return True
    checks = (("maxAmount", ask.amount, True), ("maxPercent", ask.percent, False), ("maxCount", ask.count, False))
    for key, figure, absolute in checks:
        ceiling = _f(limits.get(key))
        value = _f(figure)
        if ceiling is None or value is None:
            continue
        if (abs(value) if absolute else value) > ceiling + 1e-9:
            return False
    return True


def _personal_limit(ov: Mapping[str, Any]) -> Optional[Dict[str, float]]:
    out = {k: ov[k] for k in C.LIMIT_KEYS if ov.get(k) is not None}
    return out or None


def _name_of_pos_user(pu: Any) -> str:
    full = " ".join(p for p in (getattr(pu, "first_name", None), getattr(pu, "last_name", None)) if p)
    return full or getattr(pu, "username", "") or ""


def _name_of_user(user: Any) -> str:
    return getattr(user, "username", None) or (getattr(user, "email", "") or "").split("@")[0]


def _company_id(db: Session, machine: POSMachine) -> Optional[uuid.UUID]:
    shop = getattr(machine, "shop", None)
    if shop is not None and getattr(shop, "company_id", None) is not None:
        return shop.company_id
    if machine.shop_id is None:
        return None
    row = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).first()
    return row[0] if row else None


def linked_employees(db: Session, user_ids: Iterable[Any]) -> Dict[uuid.UUID, List[PosUser]]:
    ids = [u for u in user_ids if u is not None]
    if not ids:
        return {}
    rows = (
        db.query(DashboardUserEmployee.user_id, PosUser)
        .join(PosUser, PosUser.id == DashboardUserEmployee.pos_user_id)
        .filter(DashboardUserEmployee.user_id.in_(ids))
        .all()
    )
    out: Dict[uuid.UUID, List[PosUser]] = {}
    for user_id, pu in rows:
        out.setdefault(user_id, []).append(pu)
    return out


def users_with_devices(db: Session, user_ids: Iterable[Any]) -> Set[uuid.UUID]:
    ids = [u for u in user_ids if u is not None]
    if not ids:
        return set()
    rows = (
        db.query(PushSubscription.user_id)
        .filter(PushSubscription.user_id.in_(ids), PushSubscription.disabled_at.is_(None))
        .distinct()
        .all()
    )
    return {r[0] for r in rows}


def on_shift_ids(db: Session, pos_user_ids: Iterable[Any], *, scope: str, shop_id: Any,
                 company_id: Any) -> Set[uuid.UUID]:
    """Of these employees, who has an open attendance shift — in the shop, or in the company."""
    ids = [p for p in pos_user_ids if p is not None]
    if not ids:
        return set()
    q = db.query(AttendanceShift.pos_user_id).filter(
        AttendanceShift.pos_user_id.in_(ids), AttendanceShift.clock_out_at.is_(None),
    )
    if scope == "company" and company_id is not None:
        q = q.join(Shop, Shop.id == AttendanceShift.shop_id).filter(Shop.company_id == company_id)
    else:
        q = q.filter(AttendanceShift.shop_id == shop_id)
    return {r[0] for r in q.all()}


def candidate_users(db: Session, machine: POSMachine, company_id: Any) -> List[User]:
    """Active dashboard users of the till's tenant, and anyone linked to an employee of its company."""
    member_ids = db.query(TenantMembership.user_id).filter(TenantMembership.tenant_id == machine.tenant_id)
    linked_ids = (
        db.query(DashboardUserEmployee.user_id)
        .join(PosUser, PosUser.id == DashboardUserEmployee.pos_user_id)
        .join(Shop, Shop.id == PosUser.shop_id)
        .filter(Shop.company_id == company_id)
    )
    users = (
        db.query(User)
        .filter(
            User.is_active.is_(True),
            or_(User.tenant_id == machine.tenant_id, User.id.in_(member_ids), User.id.in_(linked_ids)),
        )
        .all()
    )
    excluded = {UserRole.SUPER_ADMIN, getattr(UserRole, "PRODUCER_VIEW", None)}
    return [u for u in users if u.role not in excluded]


def _may_decide_in_dashboard(db: Session, user: User) -> bool:
    from app.services import dashboard_access

    return dashboard_access.effective_access(db, user).allows(SECTION, "edit")


def _dash_scope_covers(db: Session, user: User, machine: POSMachine) -> bool:
    from app.services.company_hierarchy import user_may_use_machine

    return user_may_use_machine(db, user, machine)


def evaluate(
    db: Session,
    machine: POSMachine,
    ask: Ask,
    type_policy: Mapping[str, Any],
    *,
    users: Optional[Sequence[User]] = None,
    roles: Optional[Sequence[str]] = None,
    ignore_shift: bool = False,
) -> List[Approver]:
    """
    The approvers among `users` (default: every candidate) for this ask, by the policy of the
    type — `roles` replaces `approverRoles` (the escalation's roles). No device rule here.
    `ignore_shift`: who could receive it at all (the settings page), whoever is at work now.
    """
    company_id = _company_id(db, machine)
    if users is None:
        users = candidate_users(db, machine, company_id)
    if not users:
        return []
    approver_roles = set(roles if roles is not None else (type_policy.get("approverRoles") or []))
    policy_limits = type_policy.get("limits") or {}
    shift_scope = type_policy.get("onShiftScope") or "shop"
    self_ok = bool(type_policy.get("selfApprove", True))
    code = f"APPROVE_REMOTE.{ask.type_key}"
    rtype = C.TYPES_BY_KEY[ask.type_key]

    links = linked_employees(db, [u.id for u in users])
    company_shops: Optional[Set[Any]] = None
    employees_all = [pu for pus in links.values() for pu in pus]
    if company_id is not None and employees_all:
        company_shops = {
            r[0] for r in db.query(Shop.id).filter(Shop.company_id == company_id).all()
        }
    from app.services.till_roles import effective_for_users

    effective = effective_for_users(db, employees_all) if employees_all else {}
    shifting = on_shift_ids(
        db, [pu.id for pu in employees_all], scope=shift_scope, shop_id=machine.shop_id, company_id=company_id,
    )

    out: List[Approver] = []
    for user in users:
        if not getattr(user, "is_active", False):
            continue
        employees = [
            pu for pu in links.get(user.id, [])
            if pu.is_active and (company_shops is None or pu.shop_id in company_shops)
        ]
        # "לא מקבל בקשות" on any of their employees, for this type or all.
        if any(OV.for_type(pu, ask.type_key).get("noRequests") for pu in employees):
            continue
        # selfApprove off: never the person who asked.
        if not self_ok and ask.requester_pos_user_id is not None and any(
            str(pu.id) == str(ask.requester_pos_user_id) for pu in employees
        ):
            continue
        if not _may_decide_in_dashboard(db, user):
            continue
        dash_scope = _dash_scope_covers(db, user, machine)
        on_shift = any(pu.id in shifting for pu in employees)
        off_shift_ok = any(OV.for_type(pu, ask.type_key).get("offShift") for pu in employees)
        here = next((pu for pu in employees if str(pu.shop_id) == str(machine.shop_id)), None)
        best: Optional[Approver] = None

        # ── Through a till role (a linked employee) ──
        for pu in sorted(employees, key=lambda p: 0 if str(p.shop_id) == str(machine.shop_id) else 1):
            if str(pu.shop_id) != str(machine.shop_id) and not dash_scope:
                continue
            eff = effective.get(pu.id)
            if eff is None:
                continue
            key = C.till_role_key(eff.role_key, eff.role_id)
            if key is None or key not in approver_roles or not eff.allows(code):
                continue
            ov = OV.for_type(pu, ask.type_key)
            personal = _personal_limit(ov)
            explicit = personal or policy_limits.get(key) or eff.limits.get(code)
            if explicit:
                if not covers(explicit, ask):
                    continue
                limit = dict(explicit)
            elif rtype.base_code:
                if not TP.limit_covers(eff, rtype.base_code, amount=_f(ask.amount), percent=_f(ask.percent)):
                    continue
                limit = dict(eff.limits.get(rtype.base_code) or {}) or None
            else:
                limit = None
            if (C.on_shift_only(type_policy, key) and not ignore_shift and not on_shift
                    and not (ov.get("offShift") or off_shift_ok)):
                continue
            best = Approver(
                user_id=user.id, user=user, name=_name_of_pos_user(here or pu) or _name_of_user(user),
                role_key=key, role_label=eff.role_name or C.role_label(key), on_shift=on_shift,
                pos_user_id=here.id if here is not None else None, limit=limit, paths=["till"],
            )
            break

        # ── Through the dashboard role ──
        if best is None and dash_scope:
            key = C.dash_role_key(user.role)
            if key in approver_roles:
                limit = policy_limits.get(key)
                personal = _personal_limit(OV.for_type(here, ask.type_key)) if here is not None else None
                limit = personal or limit
                shift_bound = bool(employees) and C.on_shift_only(type_policy, key) and not ignore_shift
                if covers(limit, ask) and not (shift_bound and not on_shift and not off_shift_ok):
                    best = Approver(
                        user_id=user.id, user=user,
                        name=_name_of_pos_user(here) if here is not None else _name_of_user(user),
                        role_key=key, role_label=C.role_label(key), on_shift=on_shift,
                        pos_user_id=here.id if here is not None else None,
                        limit=dict(limit) if limit else None, paths=["dash"],
                    )
        if best is not None:
            out.append(best)

    devices = users_with_devices(db, [a.user_id for a in out])
    for a in out:
        a.has_device = a.user_id in devices
    out.sort(key=lambda a: (not a.on_shift, a.name))
    return out


def eligible_approvers(
    db: Session,
    machine: POSMachine,
    ask: Ask,
    type_policy: Mapping[str, Any],
    *,
    roles: Optional[Sequence[str]] = None,
) -> List[Approver]:
    """The approvers a till may ask: `evaluate`, and empty when none of them can be reached."""
    approvers = evaluate(db, machine, ask, type_policy, roles=roles)
    if approvers and not any(a.has_device for a in approvers):
        return []
    return approvers


def approver_for(
    db: Session, machine: POSMachine, ask: Ask, type_policy: Mapping[str, Any], user: User,
    *, escalated: bool = False,
) -> Optional[Approver]:
    """
    This one user, re-checked now (the decision): an `Approver` or None. A request that was
    escalated also counts the escalation's roles.
    """
    roles = list(type_policy.get("approverRoles") or [])
    if escalated:
        roles += [r for r in (type_policy.get("escalationRoles") or []) if r not in roles]
    hits = evaluate(db, machine, ask, type_policy, users=[user], roles=roles)
    return hits[0] if hits else None


def device_health(db: Session, user_ids: Iterable[Any]) -> Dict[uuid.UUID, Dict[str, Any]]:
    """
    Per user, their phones as the push channel sees them: `{devices, lastSuccessAt, lastFailureAt,
    tone}` (tone: green / yellow = no success lately or failing / red = none). The push policy's
    own reading ("התראות בנייד", `push_policy.health_for`) — one seam, so the approvals pages and
    the users list tell one story.
    """
    from app.services.push_policy import health_for

    return health_for(db, [u for u in user_ids if u is not None])
