"""
Dashboard CRUD for POS users (cashiers / shop managers per shop).

Mounted under /shops/{shop_id}/pos-users so RBAC and shop scoping match the rest
of the dashboard. Soft-delete (is_active = false) keeps historical
transactions.cashier_id references intact.
"""
from typing import List, Optional
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.pos_user import (
    PosUserCreate, PosUserUpdate, PosUserResetPin, PosUserResponse,
)
from app.services.auth import get_password_hash
from app.services.company_hierarchy import user_covers_shop
from app.services.pos_user_notify import notify_machines_for_shop_pos_users
from app.services.permission_matrix import SHOP_SCOPED_ROLES, Action, Resource, may


router = APIRouter(prefix="/shops", tags=["pos-users"])


# ── Auth helpers ─────────────────────────────────────────────────────────────

def _get_shop_or_404(db: Session, shop_id: str) -> Shop:
    try:
        sid = uuid_mod.UUID(str(shop_id))
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid shop_id")
    shop = db.query(Shop).filter(Shop.id == sid).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    return shop


def _check_read(user: User, shop: Shop, db: Session) -> None:
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return
    if user.role == UserRole.COMPANY_MANAGER and user_covers_shop(db, user, shop):
        return
    if user.role in SHOP_SCOPED_ROLES and shop.id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_write(user: User, shop: Shop, db: Session) -> None:
    """
    Who may staff a shop's tills.

    Was `role != CASHIER`, which reads as "everyone except cashiers" and behaves as
    "everyone added from now on". The shift supervisor inherited the right to create till
    operators and reset their PINs without anyone deciding to grant it — and an operator's
    PIN is what authorises sales, so whoever can mint one decides who rings up money.
    Asking the grid instead means a new role gets nothing until it is listed.
    """
    if not may(user.role, Resource.POS_USER, Action.WRITE):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    _check_read(user, shop, db)


# ── List / Create ────────────────────────────────────────────────────────────

@router.get("/{shop_id}/pos-users", response_model=List[PosUserResponse])
def list_pos_users(
    shop_id: str,
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_read(current_user, shop, db)

    q = db.query(PosUser).filter(PosUser.shop_id == shop.id, PosUser.tenant_id == active_tenant_id)
    if not include_inactive:
        q = q.filter(PosUser.is_active.is_(True))
    q = q.order_by(PosUser.username)
    return _with_role_names(db, q.all())


def _with_role_names(db: Session, users: List[PosUser]) -> List[PosUser]:
    """Stamp each user's resolved till role name (a plain attribute the response reads)."""
    from app.services.till_roles import effective_for_users

    effective = effective_for_users(db, users)
    for u in users:
        u.till_role_name = effective[u.id].role_name
    # "צבע מלצר" (P:/specs/table-waiter-assignment.md §3): their own, else the shop's automatic one.
    from app.services.table_assignments import colors_of, shop_users

    colors: dict = {}
    for shop_id in {u.shop_id for u in users}:
        colors.update(colors_of(shop_users(db, shop_id)))
    for u in users:
        u.table_color_effective = colors.get(str(u.id))
    return users


def _apply_till_role(
    db: Session, shop: Shop, pu: PosUser, role_id, user: User, *, legacy_role=None, new_user: bool = False
) -> None:
    """
    Put `pu` on the till role `role_id` (must be of the shop's company), or — none given —
    a NEW user on the spec's "קופאי" ("מנהל" for a shop manager), an existing one whose
    legacy `role` changed on the company's legacy role for it when the company's roles exist.
    """
    from app.models.company import Company
    from app.services import till_roles as TR

    company = db.get(Company, shop.company_id) if shop.company_id else None
    if company is None:
        return
    if role_id is None and new_user:
        role = TR.default_role_for_new_user(db, company, legacy_role or pu.role, pu)
    elif role_id is None:
        role = TR.legacy_role_for_user(db, company.id, legacy_role or pu.role)
        if role is None:
            pu.till_role_id = None
            return
    else:
        TR.ensure_company_roles(db, company, leave=[pu.id] if new_user else [])
        from app.models.till_role import TillRole

        role = db.get(TillRole, role_id)
        if role is None or role.company_id != company.id or role.deleted_at is not None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_till_role")
    TR.assign_role(db, company, pu, role, user=user)


@router.post(
    "/{shop_id}/pos-users",
    response_model=PosUserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_pos_user(
    shop_id: str,
    data: PosUserCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)

    existing = (
        db.query(PosUser)
        .filter(PosUser.shop_id == shop.id, PosUser.username == data.username)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists in this shop",
        )

    if data.worker_number:
        wn_dup = (
            db.query(PosUser)
            .filter(PosUser.shop_id == shop.id, PosUser.worker_number == data.worker_number)
            .first()
        )
        if wn_dup:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Worker number already exists in this shop",
            )

    user = PosUser(
        tenant_id=active_tenant_id,
        shop_id=shop.id,
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        worker_number=data.worker_number,
        pin_hash=get_password_hash(data.pin),
        role=data.role,
        is_active=True,
        table_color=data.table_color,
        area_ids=_new_user_areas(db, current_user, shop, data.area_ids),
    )
    db.add(user)
    db.flush()
    _apply_till_role(db, shop, user, data.till_role_id, current_user, legacy_role=data.role, new_user=True)
    db.commit()
    db.refresh(user)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_created")
    return _with_role_names(db, [user])[0]


# ── Update / Reset-PIN / Soft-Delete ─────────────────────────────────────────

def _new_user_areas(db: Session, user: User, shop: Shop, wanted) -> Optional[List[str]]:
    """A new employee's points of sale: as chosen; a manager of points of sale's own (and only theirs)."""
    from app.services import area_scope
    from app.services import product_areas as PA

    if wanted is None and area_scope.narrowed(db, user):
        wanted = area_scope.default_area_ids_for_new(db, user, shop.id) or []
    chosen = PA.clean_user_areas(db, shop.id, wanted) if wanted is not None else None
    PA.check_user_areas_write(db, user, chosen, chosen)
    return chosen


def _get_pos_user_in_shop_or_404(db: Session, shop: Shop, pos_user_id: str) -> PosUser:
    try:
        uid = uuid_mod.UUID(str(pos_user_id))
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid pos_user_id")
    pu = db.query(PosUser).filter(PosUser.id == uid, PosUser.shop_id == shop.id).first()
    if not pu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS user not found")
    return pu


@router.put("/{shop_id}/pos-users/{pos_user_id}", response_model=PosUserResponse)
def update_pos_user(
    shop_id: str,
    pos_user_id: str,
    data: PosUserUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)

    payload = data.model_dump(exclude_unset=True, by_alias=False)

    if "worker_number" in payload:
        wn = payload["worker_number"]
        if wn:
            dup = (
                db.query(PosUser)
                .filter(
                    PosUser.shop_id == shop.id,
                    PosUser.worker_number == wn,
                    PosUser.id != pu.id,
                )
                .first()
            )
            if dup:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Worker number already exists in this shop",
                )

    # "נקודות מכירה" (P:/specs/chain-areas.md §8): a manager of points of sale edits only their own employees.
    from app.services import product_areas as PA

    PA.check_user_areas_write(db, current_user, pu.area_ids, pu.area_ids if "area_ids" not in payload else payload["area_ids"])
    if "area_ids" in payload:
        pu.area_ids = PA.clean_user_areas(db, shop.id, payload["area_ids"] or [])
    role_changed = "role" in payload and payload["role"] is not None and payload["role"] != pu.role
    for field in ("first_name", "last_name", "worker_number", "role", "is_active"):
        if field in payload:
            setattr(pu, field, payload[field])
    # "צבע מלצר": the floor's tills redraw their tables in it.
    color_changed = "table_color" in payload and payload["table_color"] != pu.table_color
    if "table_color" in payload:
        pu.table_color = payload["table_color"]
    # "שולחנות שהעובד רואה" (P:/specs/table-scope.md §3, §10): any zone or table of their shop; logged.
    scope_changed = False
    if "table_scope" in payload:
        from app.services import table_scope as TSC

        try:
            scope = TSC.without_archived(db, shop.id, TSC.clean_scope(payload["table_scope"]))
            TSC.check_against(db, shop.id, scope, any_area=True)
        except TSC.ScopeError as exc:
            raise HTTPException(status_code=422, detail={"code": TSC.INVALID, "reason": exc.reason, **exc.extra})
        scope_changed = TSC.scope_out(pu.table_scope) != scope
        if scope_changed:
            name = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip() or pu.username
            TSC.record_change(
                db, target_type="pos_user", target=pu, name=name, before=pu.table_scope, after=scope,
                user=current_user,
            )
            pu.table_scope = scope

    if "pin" in payload and payload["pin"] is not None:
        pu.pin_hash = get_password_hash(payload["pin"])

    # "תפקידים והרשאות": a till role chosen wins; a legacy `role` change from an older
    # dashboard moves the user to that role's legacy till role, so the two never disagree.
    if payload.get("till_role_id") is not None:
        _apply_till_role(db, shop, pu, payload["till_role_id"], current_user)
    elif role_changed:
        _apply_till_role(db, shop, pu, None, current_user, legacy_role=payload["role"])

    db.commit()
    db.refresh(pu)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_updated")
    if color_changed or scope_changed or "is_active" in payload or "first_name" in payload or "last_name" in payload:
        # The tables state names and colours the waiters ("שיוך מלצרים").
        from app.services import tables as T

        T.tables_changed(db, shop.id, tenant_id=shop.tenant_id)
        db.refresh(pu)
    return _with_role_names(db, [pu])[0]


@router.get("/{shop_id}/pos-users/table-scope-tree")
def pos_users_table_scope_tree(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The employee card's "שולחנות שהעובד רואה" (P:/specs/table-scope.md §3): every zone of the shop with its tables
    (the employee may sit at any device of it), and the devices with a scope of their own — for the warning
    "התחום של המכשיר והתחום של העובד לא חופפים".
    """
    from app.models.pos_machine import POSMachine
    from app.services import table_scope as TSC
    from app.services.printers import machine_label

    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_read(current_user, shop, db)
    devices = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True), POSMachine.table_scope.isnot(None))
        .order_by(POSMachine.pos_number.asc())
        .all()
    )
    return {
        "zones": TSC.scope_tree(db, shop.id, any_area=True),
        "devices": [
            {"id": str(m.id), "name": machine_label(m), "tableScope": TSC.live_out(db, shop.id, m.table_scope)}
            for m in devices
        ],
    }


@router.post(
    "/{shop_id}/pos-users/{pos_user_id}/reset-pin",
    response_model=PosUserResponse,
)
def reset_pos_user_pin(
    shop_id: str,
    pos_user_id: str,
    body: PosUserResetPin,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)
    from app.services import product_areas as PA

    PA.check_user_areas_write(db, current_user, pu.area_ids, pu.area_ids)

    pu.pin_hash = get_password_hash(body.pin)
    db.commit()
    db.refresh(pu)

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_pin_reset")
    return _with_role_names(db, [pu])[0]


@router.delete(
    "/{shop_id}/pos-users/{pos_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def deactivate_pos_user(
    shop_id: str,
    pos_user_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Soft delete: flips is_active=false. Keeps historical transactions.cashier_id valid."""
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    pu = _get_pos_user_in_shop_or_404(db, shop, pos_user_id)
    from app.services import product_areas as PA

    PA.check_user_areas_write(db, current_user, pu.area_ids, pu.area_ids)

    if pu.is_active:
        pu.is_active = False
        db.commit()

    notify_machines_for_shop_pos_users(db, str(shop.id), reason="pos_user_deactivated")
    return None
