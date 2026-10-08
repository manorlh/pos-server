"""
Till roles per company, their assignment to till users, and the audit of both
(docs/SPEC_ROLES_PERMISSIONS.md). The catalogue and the pure resolution are
`app/services/till_permissions.py`.

**Built-ins are materialised lazily.** A company has no role rows until someone opens its
roles (`ensure_company_roles`); until then every till user resolves from code — their
assigned role, or (no role yet) the legacy role matching `pos_users.role`, which is
exactly today's behaviour. Materialising creates the six built-ins and points every
unassigned till user of the company's shops at the legacy role they already behave as,
so nothing anyone can do changes on that day. A till user created after that with no role
chosen starts on the spec's "קופאי" ("מנהל" when created as a shop manager).

**`pos_users.role` stays true for older tills.** Assigning a role, editing one, or
overriding a user writes the user's `role` from what they may now do
(`till_permissions.legacy_role_for`): `shop_manager` only when they may do alone
everything an older till lets a shop manager do alone. Every such change also bumps the
user's `updated_at`, which is what the till's delta roster pull reads, and notifies the
shop's tills.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.models.till_role import TillRole, TillRoleChange
from app.services import till_permissions as TP

_UNSET = object()


class TillRoleError(ValueError):
    """A request the roles cannot take. `code` is the API's detail; message safe to show."""

    def __init__(self, code: str, message: str = "", status: int = 422):
        super().__init__(message or code)
        self.code = code
        self.status = status


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


# ── Resolution for till users ─────────────────────────────────────────────────


def role_effective(role: TillRole, overrides: Any = None) -> TP.EffectivePermissions:
    return TP.effective_permissions(
        role_states=role.permissions or {},
        role_limits=role.limits or {},
        template=TP.template_of(role.builtin_key, role.base_key),
        overrides=overrides,
        role_id=str(role.id),
        role_key=role.builtin_key,
        role_name=role.name,
    )


def effective_for_pos_user(pos_user: Any, role: Any = _UNSET) -> TP.EffectivePermissions:
    """
    What this till user may do. `role` may be passed in (a batch already loaded it);
    otherwise it is read through the relationship. A role deleted or missing falls back
    to the user's legacy role — never to more.
    """
    overrides = getattr(pos_user, "permission_overrides", None)
    if getattr(pos_user, "till_role_id", None) is None:
        legacy = TP.legacy_effective(getattr(pos_user, "role", None))
        if not overrides:
            return legacy
        return TP.effective_permissions(
            template=legacy.role_key or TP.LEGACY_CASHIER, overrides=overrides,
            role_key=legacy.role_key, role_name=legacy.role_name,
        )
    if role is _UNSET:
        role = getattr(pos_user, "till_role", None)
    if role is None or getattr(role, "deleted_at", None) is not None:
        legacy = TP.legacy_effective(getattr(pos_user, "role", None))
        return TP.effective_permissions(
            template=legacy.role_key or TP.LEGACY_CASHIER, overrides=overrides,
            role_key=legacy.role_key, role_name=legacy.role_name,
        )
    return role_effective(role, overrides)


def effective_for_users(db: Session, users: Sequence[Any]) -> Dict[Any, TP.EffectivePermissions]:
    """`effective_for_pos_user` for many, with one query for their roles."""
    ids = {u.till_role_id for u in users if getattr(u, "till_role_id", None) is not None}
    roles = {r.id: r for r in db.query(TillRole).filter(TillRole.id.in_(ids)).all()} if ids else {}
    out: Dict[Any, TP.EffectivePermissions] = {}
    for u in users:
        role = roles.get(u.till_role_id) if getattr(u, "till_role_id", None) is not None else None
        out[u.id] = effective_for_pos_user(u, role)
    return out


def pos_user_scope_values(pos_user: Any) -> Set[str]:
    """The elevation scope strings this till user may hold (their `allow` ones)."""
    eff = effective_for_pos_user(pos_user)
    return set(TP.scopes_allowed(eff, TP.SCOPE_PERMISSIONS.keys()))


def pos_user_allows(pos_user: Any, code: str) -> bool:
    return effective_for_pos_user(pos_user).allows(code)


def pos_user_scopes(pos_user: Any):
    """
    The elevation `Scope`s this till user may hold or exercise alone — the cloud's side of
    the till's `PermissionService`. Replaces `permissions.pos_user_till_scopes(role)`: for a
    user with no till role it answers from their legacy role, exactly as before.
    """
    from app.services.permissions import Scope

    allowed = pos_user_scope_values(pos_user)
    return frozenset(s for s in Scope if s.value in allowed)


def sync_fields(eff: TP.EffectivePermissions) -> Dict[str, Any]:
    """What a till's roster row carries about permissions (`PosUserSyncRow`)."""
    return {
        "till_role_id": eff.role_id,
        "till_role_key": eff.role_key,
        "till_role_name": eff.role_name,
        "permissions": dict(eff.states),
        "limits": {code: dict(v) for code, v in eff.limits.items()},
    }


# ── Roles of a company ────────────────────────────────────────────────────────


def company_shop_ids(db: Session, company_id: Any) -> List[uuid.UUID]:
    return [row[0] for row in db.query(Shop.id).filter(Shop.company_id == _uuid(company_id)).all()]


def roles_of(db: Session, company_id: Any, *, include_deleted: bool = False) -> List[TillRole]:
    q = db.query(TillRole).filter(TillRole.company_id == _uuid(company_id))
    if not include_deleted:
        q = q.filter(TillRole.deleted_at.is_(None))
    return sorted(q.all(), key=lambda r: (r.sort_order or 0, r.name or ""))


def ensure_company_roles(db: Session, company: Company, *, leave: Iterable[Any] = ()) -> List[TillRole]:
    """
    Create the built-ins this company lacks and point its unassigned till users at the
    legacy role they already behave as — except `leave` (a user being created now, whose
    role is decided by the caller). Idempotent; the caller commits.
    """
    existing = {r.builtin_key: r for r in roles_of(db, company.id, include_deleted=True) if r.builtin_key}
    for spec in TP.BUILTIN_ROLES:
        if spec.key in existing:
            continue
        row = TillRole(
            id=uuid.uuid4(), tenant_id=company.tenant_id, company_id=company.id, builtin_key=spec.key,
            name=spec.name, description=spec.description, permissions={}, limits={},
            sort_order=spec.sort_order,
        )
        db.add(row)
        existing[spec.key] = row
    db.flush()
    shop_ids = company_shop_ids(db, company.id)
    if shop_ids:
        left = {_uuid(i) for i in leave if i is not None}
        unassigned = [
            pu
            for pu in db.query(PosUser)
            .filter(PosUser.shop_id.in_(shop_ids), PosUser.till_role_id.is_(None))
            .all()
            if pu.id not in left
        ]
        for pu in unassigned:
            key = TP.LEGACY_FOR_ROLE.get(TP._role_value(pu.role), TP.LEGACY_CASHIER)
            pu.till_role_id = existing[key].id
            pu.till_role = existing[key]
        if unassigned:
            db.flush()
            _restamp(unassigned)
    return roles_of(db, company.id)


def users_of_role(db: Session, role: TillRole) -> List[PosUser]:
    return db.query(PosUser).filter(PosUser.till_role_id == role.id).all()


def user_counts(db: Session, roles: Iterable[TillRole]) -> Dict[uuid.UUID, int]:
    ids = [r.id for r in roles]
    if not ids:
        return {}
    counts: Dict[uuid.UUID, int] = {}
    for (role_id,) in (
        db.query(PosUser.till_role_id).filter(PosUser.till_role_id.in_(ids), PosUser.is_active.is_(True)).all()
    ):
        counts[role_id] = counts.get(role_id, 0) + 1
    return counts


def role_out(role: TillRole, users: int = 0) -> Dict[str, Any]:
    eff = role_effective(role)
    return {
        "id": str(role.id),
        "companyId": str(role.company_id),
        "builtinKey": role.builtin_key,
        "baseKey": role.base_key,
        "builtin": role.builtin_key is not None,
        "legacy": role.builtin_key in (TP.LEGACY_CASHIER, TP.LEGACY_MANAGER),
        "name": role.name,
        "description": role.description,
        "sortOrder": role.sort_order,
        "own": {"permissions": dict(role.permissions or {}), "limits": dict(role.limits or {})},
        "permissions": eff.states,
        "limits": eff.limits,
        "legacyRole": eff.legacy_role,
        "users": users,
        "updatedAt": role.updated_at.isoformat() if role.updated_at else None,
    }


def _check_name(db: Session, company_id: Any, name: Any, own_id: Any = None) -> str:
    if not isinstance(name, str) or not name.strip():
        raise TillRoleError("name_required", "שם התפקיד חובה")
    cleaned = name.strip()
    if len(cleaned) > 100:
        raise TillRoleError("name_too_long", "שם התפקיד ארוך מדי (עד 100 תווים)")
    for r in roles_of(db, company_id):
        if r.id != own_id and (r.name or "").strip().lower() == cleaned.lower():
            raise TillRoleError("name_taken", "כבר קיים תפקיד בשם הזה", status=409)
    return cleaned


def _clean(permissions: Any, limits: Any) -> Tuple[Dict[str, str], Dict[str, Dict[str, float]]]:
    try:
        return TP.clean_states(permissions), TP.clean_limits(limits)
    except TP.PermissionValueError as exc:
        raise TillRoleError("invalid_permissions", str(exc)) from exc


def _snapshot(role: TillRole) -> Dict[str, Any]:
    return {
        "name": role.name,
        "description": role.description,
        "permissions": dict(role.permissions or {}),
        "limits": dict(role.limits or {}),
    }


def record_change(
    db: Session,
    *,
    company: Any,
    action: str,
    user: Any,
    role: Optional[TillRole] = None,
    pos_user: Optional[PosUser] = None,
    old_value: Any = None,
    new_value: Any = None,
) -> TillRoleChange:
    row = TillRoleChange(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        role_id=role.id if role is not None else None,
        role_name=role.name if role is not None else None,
        pos_user_id=pos_user.id if pos_user is not None else None,
        pos_user_name=_display_name(pos_user) if pos_user is not None else None,
        action=action,
        old_value=old_value,
        new_value=new_value,
        user_id=getattr(user, "id", None),
        user_email=getattr(user, "email", None),
        user_role=_role_str(getattr(user, "role", None)),
        created_at=_now(),
    )
    db.add(row)
    return row


def _role_str(role: Any) -> Optional[str]:
    if role is None:
        return None
    return str(getattr(role, "value", role))[:32]


def _display_name(pu: PosUser) -> str:
    full = " ".join(p for p in ((pu.first_name or ""), (pu.last_name or "")) if p).strip()
    return full or pu.username


def _restamp(users: Iterable[PosUser], role: Optional[TillRole] = None) -> Set[uuid.UUID]:
    """Write each user's legacy `role` from what they may now do, bump `updated_at`."""
    shops: Set[uuid.UUID] = set()
    now = _now()
    for pu in users:
        eff = effective_for_pos_user(pu, role if role is not None and pu.till_role_id == role.id else _UNSET)
        legacy = eff.legacy_role
        pu.role = PosUserRole(legacy)
        pu.updated_at = now
        shops.add(pu.shop_id)
    return shops


def create_role(
    db: Session,
    company: Company,
    *,
    name: Any,
    user: Any,
    description: Optional[str] = None,
    base_key: Optional[str] = None,
    copy_from: Optional[TillRole] = None,
    permissions: Any = None,
    limits: Any = None,
) -> TillRole:
    cleaned_name = _check_name(db, company.id, name)
    states, lims = _clean(permissions, limits)
    if copy_from is not None:
        # A duplicate is the source as it resolves now, written out in full, so later
        # edits to the source never move the copy.
        eff = role_effective(copy_from)
        template = TP.template_of(copy_from.builtin_key, copy_from.base_key)
        own_states = {**eff.states, **states}
        own_limits = {**{k: dict(v) for k, v in eff.limits.items()}, **lims}
    else:
        if base_key is not None and base_key not in TP.DEFAULTS:
            raise TillRoleError("unknown_template", "תבנית לא מוכרת")
        template = base_key or TP.CUSTOM_TEMPLATE
        own_states, own_limits = states, lims
    row = TillRole(
        id=uuid.uuid4(), tenant_id=company.tenant_id, company_id=company.id, builtin_key=None,
        base_key=template, name=cleaned_name, description=(description or "").strip() or None,
        permissions=own_states, limits=own_limits, sort_order=200,
        created_by=getattr(user, "id", None), updated_by=getattr(user, "id", None),
    )
    db.add(row)
    db.flush()
    record_change(db, company=company, action="create", user=user, role=row, new_value=_snapshot(row))
    return row


def update_role(
    db: Session,
    company: Company,
    role: TillRole,
    *,
    user: Any,
    name: Any = _UNSET,
    description: Any = _UNSET,
    permissions: Any = _UNSET,
    limits: Any = _UNSET,
) -> Set[uuid.UUID]:
    """Edit a role; returns the shops whose tills must hear of it."""
    if role.deleted_at is not None:
        raise TillRoleError("role_deleted", "התפקיד נמחק", status=404)
    before = _snapshot(role)
    if name is not _UNSET:
        role.name = _check_name(db, company.id, name, own_id=role.id)
    if description is not _UNSET:
        role.description = (description.strip() or None) if isinstance(description, str) else None
    if permissions is not _UNSET or limits is not _UNSET:
        states, lims = _clean(
            role.permissions if permissions is _UNSET else permissions,
            role.limits if limits is _UNSET else limits,
        )
        role.permissions = states
        role.limits = lims
    role.updated_by = getattr(user, "id", None)
    role.updated_at = _now()
    after = _snapshot(role)
    if after == before:
        return set()
    record_change(db, company=company, action="update", user=user, role=role, old_value=before, new_value=after)
    db.flush()
    return _restamp(users_of_role(db, role), role)


def delete_role(
    db: Session, company: Company, role: TillRole, *, user: Any, reassign_to: Optional[TillRole] = None
) -> Set[uuid.UUID]:
    if role.builtin_key is not None:
        raise TillRoleError("builtin_role", "תפקיד מובנה לא נמחק (אפשר לערוך אותו)", status=409)
    if role.deleted_at is not None:
        return set()
    users = users_of_role(db, role)
    if users and reassign_to is None:
        raise TillRoleError("role_in_use", f"{len(users)} עובדים משויכים לתפקיד — בחרו תפקיד חלופי", status=409)
    if reassign_to is not None and (reassign_to.id == role.id or reassign_to.deleted_at is not None
                                    or reassign_to.company_id != role.company_id):
        raise TillRoleError("invalid_reassign", "תפקיד חלופי לא תקין")
    for pu in users:
        pu.till_role_id = reassign_to.id
        pu.till_role = reassign_to
    role.deleted_at = _now()
    role.updated_by = getattr(user, "id", None)
    record_change(
        db, company=company, action="delete", user=user, role=role, old_value=_snapshot(role),
        new_value={"reassignedTo": str(reassign_to.id) if reassign_to else None, "users": len(users)},
    )
    db.flush()
    return _restamp(users, reassign_to) if users else set()


def assign_role(db: Session, company: Company, pos_user: PosUser, role: TillRole, *, user: Any) -> Set[uuid.UUID]:
    if role.deleted_at is not None or role.company_id != company.id:
        raise TillRoleError("invalid_role", "התפקיד לא שייך לחברה של הסניף")
    if pos_user.till_role_id == role.id:
        return set()
    old = pos_user.till_role_id
    pos_user.till_role_id = role.id
    pos_user.till_role = role
    record_change(
        db, company=company, action="assign", user=user, role=role, pos_user=pos_user,
        old_value={"roleId": str(old) if old else None}, new_value={"roleId": str(role.id), "roleName": role.name},
    )
    db.flush()
    return _restamp([pos_user], role)


def set_overrides(db: Session, company: Company, pos_user: PosUser, overrides: Any, *, user: Any) -> Set[uuid.UUID]:
    if overrides is None:
        cleaned = None
    else:
        if not isinstance(overrides, dict):
            raise TillRoleError("invalid_overrides", "overrides must be an object")
        states, lims = _clean(overrides.get("states"), overrides.get("limits"))
        cleaned = {"states": states, "limits": lims} if (states or lims) else None
    before = pos_user.permission_overrides
    if (before or None) == cleaned:
        return set()
    pos_user.permission_overrides = cleaned
    record_change(
        db, company=company, action="overrides", user=user, role=pos_user.till_role, pos_user=pos_user,
        old_value=before, new_value=cleaned,
    )
    db.flush()
    return _restamp([pos_user])


def apply_spec_defaults(
    db: Session, company: Company, *, user: Any, reset_builtins: bool = True, move_legacy_users: bool = False
) -> Dict[str, Any]:
    """
    "החל ברירות מחדל לפי האפיון": the four spec roles back to the spec's matrix (their own
    values cleared, so the template answers), and — when asked — every user on a legacy
    role moved to its spec counterpart (קופאי (הרשאות קודמות) → קופאי, מנהל חנות → מנהל).
    """
    roles = {r.builtin_key: r for r in ensure_company_roles(db, company) if r.builtin_key}
    shops: Set[uuid.UUID] = set()
    reset: List[str] = []
    moved = 0
    if reset_builtins:
        for key in TP.SPEC_ROLE_KEYS:
            role = roles.get(key)
            if role is None:
                continue
            if role.permissions or role.limits or role.name != TP.BUILTIN_BY_KEY[key].name:
                before = _snapshot(role)
                role.permissions, role.limits = {}, {}
                role.name = TP.BUILTIN_BY_KEY[key].name
                role.updated_at = _now()
                record_change(db, company=company, action="update", user=user, role=role,
                              old_value=before, new_value=_snapshot(role))
                reset.append(key)
                db.flush()
                shops |= _restamp(users_of_role(db, role), role)
    if move_legacy_users:
        for legacy_key, spec_key in TP.SPEC_ROLE_FOR_LEGACY.items():
            src, dst = roles.get(legacy_key), roles.get(spec_key)
            if src is None or dst is None:
                continue
            users = users_of_role(db, src)
            for pu in users:
                pu.till_role_id = dst.id
                pu.till_role = dst
            moved += len(users)
            db.flush()
            if users:
                shops |= _restamp(users, dst)
    record_change(
        db, company=company, action="apply_defaults", user=user,
        new_value={"resetRoles": reset, "movedUsers": moved, "moveLegacyUsers": move_legacy_users},
    )
    db.flush()
    return {"resetRoles": reset, "movedUsers": moved, "shops": shops}


def default_role_for_new_user(db: Session, company: Company, legacy_role: Any, pos_user: Any = None) -> TillRole:
    """
    A NEW till user with no role chosen: the spec's "קופאי" ("מנהל" when created as a shop
    manager). The company's roles are materialised first — its existing users keep the
    legacy role they behave as; only `pos_user` is left for this one.
    """
    key = TP.SPEC_ROLE_FOR_NEW_USER.get(TP._role_value(legacy_role), TP.CASHIER)
    leave = [pos_user.id] if pos_user is not None and getattr(pos_user, "id", None) is not None else []
    roles = {r.builtin_key: r for r in ensure_company_roles(db, company, leave=leave) if r.builtin_key}
    return roles.get(key) or roles[TP.CASHIER]


def legacy_role_for_user(db: Session, company_id: Any, legacy_role: Any) -> Optional[TillRole]:
    """A legacy `role` change (an older dashboard): the company's legacy role for it, if materialised."""
    key = TP.LEGACY_FOR_ROLE.get(TP._role_value(legacy_role), TP.LEGACY_CASHIER)
    return (
        db.query(TillRole)
        .filter(TillRole.company_id == _uuid(company_id), TillRole.builtin_key == key, TillRole.deleted_at.is_(None))
        .first()
    )


def change_out(row: TillRoleChange) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "action": row.action,
        "roleId": str(row.role_id) if row.role_id else None,
        "roleName": row.role_name,
        "posUserId": str(row.pos_user_id) if row.pos_user_id else None,
        "posUserName": row.pos_user_name,
        "oldValue": row.old_value,
        "newValue": row.new_value,
        "userEmail": row.user_email,
        "userRole": row.user_role,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


def notify_shops(db: Session, shop_ids: Iterable[Any], reason: str = "till_roles_updated") -> None:
    from app.services.pos_user_notify import notify_machines_for_shop_pos_users

    for shop_id in {str(s) for s in shop_ids if s is not None}:
        try:
            notify_machines_for_shop_pos_users(db, shop_id, reason=reason)
        except Exception:  # noqa: BLE001 - a missed notify is caught by the next poll
            pass
