"""
Table management ("ניהול שולחנות") — see app/services/tables.py for the rules.

Till (machine JWT only; the synced mode's writes answer 409 `tables_not_synced` for a
till in another mode):

GET   /sync/{machine_id}/tables                         → zones, tables (order summary, lock),
                                                          cancellation reasons, lock minutes
POST  /sync/{machine_id}/tables/report                  → single-till mode: orders for reports
POST  /sync/{machine_id}/tables/{table_id}/enter        → lock it; its order (or null)
POST  /sync/{machine_id}/tables/{table_id}/heartbeat    → extend the lock (409 table_lock_lost)
POST  /sync/{machine_id}/tables/{table_id}/save         → save | send | bill | leave (versioned)
POST  /sync/{machine_id}/tables/{table_id}/pay          → paid with a sale document
POST  /sync/{machine_id}/tables/{table_id}/cancel       → reason + approval (`table:cancel`)
POST  /sync/{machine_id}/tables/{table_id}/move         → to a free table
POST  /sync/{machine_id}/tables/{table_id}/release      → leave without saving
POST  /sync/{machine_id}/tables/{table_id}/force-release → another till's lock (`table:unlock`)
POST  /sync/{machine_id}/tables/{table_id}/merge/prepare → lock target + sources (all or none), read them
POST  /sync/{machine_id}/tables/{table_id}/merge        → the merged order; sources closed as `merged`
POST  /sync/{machine_id}/tables/{table_id}/rename       → a manager renames it (`catalog:write`)
POST  /sync/{machine_id}/tables/layout                  → the till's edit mode: zones and tables at once
                                                          (`catalog:write`; all or nothing)

409 bodies are `{code, ...}`: `table_locked` / `table_lock_lost` / `table_target_locked`
(with `lock`: till, employee, expiry), `table_version_conflict` (with the current
`order`), `table_target_occupied`.

An approval is a grant in `X-Elevation-Token` (a manager's PIN at the till), or the
signed-in operator named by `X-Pos-User-Id` when their own role holds the scope — the
same two ways as a catalog write from a till.

Dashboard (Clerk): `/tables/layout`, zones and tables (create, edit, bulk add, the map's
positions, archive), `/tables/cancel-reasons`, `/tables/live`, `/tables/report`, and a
manager's cancel / forced release of a stuck table.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ELEVATION_HEADER,
    POS_USER_HEADER,
    _checked_grant,
    _elevation_401,
    _operator_with_authority,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_for_sync_path,
    get_pos_machine_from_sync_machine_token,
    CatalogActor,
    require_catalog_authority,
)
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.tables import TableCancelReason
from app.models.user import User
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.schemas.tables import (
    BulkTablesIn,
    DashboardCancelIn,
    MergePrepareIn,
    TableAdhocIn,
    TablePartPayIn,
    ReservationIn,
    ReservationStatusIn,
    ReservationUpdate,
    TableTransferIn,
    ReasonCreate,
    ReasonUpdate,
    TableCancelIn,
    TableCreate,
    TableEnterIn,
    TableHeartbeatIn,
    TableMergeIn,
    TableMoveIn,
    TableRenameIn,
    TablePayIn,
    TablePositionsIn,
    TableReleaseIn,
    TableSaveIn,
    TablesReportIn,
    TableUpdate,
    TillLayoutIn,
    ZoneCreate,
    ZoneUpdate,
)
from app.services import tables as T
from app.services.elevation import consume_per_action_use
from app.services.permissions import Scope, requires_per_action_reauth

router = APIRouter(tags=["tables"])


# ── The till's side ───────────────────────────────────────────────────────────


@dataclass
class _Authority:
    scope: Scope
    session: Optional[ElevatedSession] = None
    operator: Optional[PosUser] = None


def _table_authority(scope: Scope):
    """
    A grant for `scope` at this till, or a signed-in operator who holds it — like
    `require_catalog_authority`, except that a per-action grant is spent by the caller
    once the action is certain (`_spend`), so a write refused for a version conflict
    does not cost the manager their PIN.
    """

    def dependency(
        machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
        elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
        operator_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
        db: Session = Depends(get_db),
    ) -> _Authority:
        if elevation_token:
            return _Authority(scope=scope, session=_checked_grant(db, machine, elevation_token, scope))
        operator = _operator_with_authority(db, machine, operator_id, scope)
        if operator is None:
            raise _elevation_401("elevation_required")
        return _Authority(scope=scope, operator=operator)

    return dependency


def _approval(db: Session, auth: _Authority) -> T.Approval:
    if auth.session is not None:
        pos_user_id = str(auth.session.pos_user_id) if auth.session.pos_user_id else None
        return T.Approval(
            user_id=auth.session.user_id,
            pos_user_id=pos_user_id,
            name=T.approver_name(db, auth.session.user_id, auth.session.pos_user_id),
        )
    operator = auth.operator
    return T.Approval(pos_user_id=str(operator.id), name=T.approver_name(db, None, operator.id))


def _spend(db: Session, auth: _Authority) -> None:
    if auth.session is not None and requires_per_action_reauth(auth.scope):
        if not consume_per_action_use(db, auth.session):
            raise _elevation_401("elevation_already_used")


def _actor(machine: POSMachine, body) -> T.Actor:
    return T.Actor(
        machine=machine,
        pos_user_id=(getattr(body, "pos_user_id", None) or None),
        pos_user_name=(getattr(body, "pos_user_name", None) or None),
    )


def _wake(background_tasks: BackgroundTasks, db: Session, machine: POSMachine, table_id: Optional[str] = None) -> None:
    targets = T.notify_targets(db, machine.shop_id, except_machine_id=machine.id)
    if targets:
        background_tasks.add_task(T.publish_tables_notify, targets, table_id)


@router.get("/sync/{machine_id}/tables")
def get_tables_state(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The tables screen: zones, tables with their order and lock, the reasons."""
    out = T.till_state(db, machine)
    db.commit()  # the default reasons, the first time a tenant's are read
    return out


@router.post("/sync/{machine_id}/tables/report")
def report_local_tables(
    machine_id: str,
    body: TablesReportIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Single-till mode: the till's orders, for the dashboard. Idempotent by version."""
    out = T.apply_local_report(db, machine, body.orders)
    db.commit()
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/enter")
def enter_table(
    machine_id: str,
    table_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    body: Optional[TableEnterIn] = None,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Lock the table for this till (409 `table_locked` with who has it) and read it."""
    out = T.enter(db, _actor(machine, body), table_id)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/heartbeat")
def table_heartbeat(
    machine_id: str,
    table_id: uuid.UUID,
    body: Optional[TableHeartbeatIn] = None,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    out = T.heartbeat(db, _actor(machine, body), table_id)
    db.commit()
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/save")
def save_table(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableSaveIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    out = T.save(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/pay")
def pay_table(
    machine_id: str,
    table_id: uuid.UUID,
    body: TablePayIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    out = T.pay(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/cancel")
def cancel_table(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableCancelIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    auth: _Authority = Depends(_table_authority(Scope.TABLE_CANCEL)),
    db: Session = Depends(get_db),
):
    out = T.cancel(db, _actor(machine, body), table_id, body, _approval(db, auth))
    if not out.get("replayed"):
        _spend(db, auth)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/move")
def move_table(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableMoveIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    out = T.move(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/merge/prepare")
def prepare_merge(
    machine_id: str,
    table_id: uuid.UUID,
    body: MergePrepareIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    "איחוד שולחנות", step one: lock the target and every source — all or none (409
    `table_locked` with every table another till holds) — and read their orders.
    """
    out = T.merge_prepare(db, _actor(machine, body), table_id, body.source_table_ids)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/merge")
def merge_tables(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableMergeIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Step two: the merged order, every version checked; the sources are freed."""
    out = T.merge(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/rename")
def rename_table(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableRenameIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    A table's name from a till: a layout edit, so a manager's — the operator's own role or
    a grant, as for a catalog write (401 `elevation_required` otherwise).
    """
    out = T.rename(db, _actor(machine, body), table_id, body.name)
    db.commit()
    targets = T.notify_targets(db, machine.shop_id)
    if targets:
        background_tasks.add_task(T.publish_tables_notify, targets, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/pay-part")
def pay_part(
    machine_id: str,
    table_id: uuid.UUID,
    body: TablePartPayIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """"פיצול חשבון": a part paid — never refused (the money moved); `conflict` when it changed meanwhile."""
    out = T.pay_part(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/transfer")
def transfer_items(
    machine_id: str,
    table_id: uuid.UUID,
    body: TableTransferIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """"העברת פריטים": lines of this table moved to another — both written, or neither."""
    out = T.transfer(db, _actor(machine, body), table_id, body)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/reservations")
def till_create_reservation(
    machine_id: str,
    body: ReservationIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """A booking taken at the till ("הזמנה חדשה"). 409 `reservation_overlap`."""
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="table_not_found")
    shop = db.get(Shop, machine.shop_id)
    r = T.create_reservation(db, shop, body, by_name=body.pos_user_name)
    db.commit()
    _wake(background_tasks, db, machine, None)
    return T.reservation_out(r)


@router.post("/sync/{machine_id}/tables/reservations/{reservation_id}/status")
def till_reservation_status(
    machine_id: str,
    reservation_id: uuid.UUID,
    body: ReservationStatusIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The party came ("הגיעו"), cancelled, or did not come."""
    r = T.get_reservation(db, reservation_id, machine.shop_id)
    r.status = body.status
    r.updated_at = datetime.now(timezone.utc)
    db.commit()
    _wake(background_tasks, db, machine, None)
    return T.reservation_out(r)


@router.post("/sync/{machine_id}/tables/adhoc")
def adhoc_table(
    machine_id: str,
    body: TableAdhocIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    "פתיחת שולחן לפי מספר": the table of that number, made in "שולחנות מזדמנים" when it is
    on no map. Any waiter's — it adds a table to sit at, not a layout edit.
    """
    out = T.adhoc_table(db, machine, body.number)
    db.commit()
    if out["created"]:
        targets = T.notify_targets(db, machine.shop_id)
        if targets:
            background_tasks.add_task(T.publish_tables_notify, targets, None)
    return out


@router.post("/sync/{machine_id}/tables/layout")
def save_till_layout(
    machine_id: str,
    body: TillLayoutIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
):
    """
    The till's edit mode ("שמור"): zones and tables added, changed and removed in one
    all-or-nothing batch — a layout edit, so a manager's, as for a rename. 409
    `table_in_use` / `table_number_taken` / `zone_not_empty`; answers the till's state.
    """
    out = T.apply_till_layout(db, machine, body)
    db.commit()
    targets = T.notify_targets(db, machine.shop_id)
    if targets:
        background_tasks.add_task(T.publish_tables_notify, targets, None)
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/release")
def release_table(
    machine_id: str,
    table_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    body: Optional[TableReleaseIn] = None,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """This till's own lock, without saving. Idempotent."""
    if body is not None and body.force:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="use_force_release")
    out = T.release(db, _actor(machine, body), table_id)
    db.commit()
    _wake(background_tasks, db, machine, str(table_id))
    return out


@router.post("/sync/{machine_id}/tables/{table_id}/force-release")
def force_release_table(
    machine_id: str,
    table_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    body: Optional[TableReleaseIn] = None,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    auth: _Authority = Depends(_table_authority(Scope.TABLE_UNLOCK)),
    db: Session = Depends(get_db),
):
    """A manager frees a table another till left locked (a till that went down)."""
    out = T.release(db, _actor(machine, body), table_id, force=True, approval=_approval(db, auth))
    _spend(db, auth)
    db.commit()
    targets = T.notify_targets(db, machine.shop_id)
    if targets:
        background_tasks.add_task(T.publish_tables_notify, targets, str(table_id))
    return out


# ── Dashboard ─────────────────────────────────────────────────────────────────


def _shop(db: Session, shop_id, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _readable_shop(db: Session, shop_id, user: User, tenant_id) -> Shop:
    shop = _shop(db, shop_id, tenant_id)
    _check_shop_access(user, shop, db)
    return shop


def _writable_shop(db: Session, shop_id, user: User, tenant_id) -> Shop:
    shop = _shop(db, shop_id, tenant_id)
    _check_shop_override_write(user, shop, db)
    return shop


def _wake_shop(background_tasks: BackgroundTasks, db: Session, shop_id) -> None:
    targets = T.notify_targets(db, shop_id)
    if targets:
        background_tasks.add_task(T.publish_tables_notify, targets, None)


@router.get("/tables/layout")
def get_layout(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _readable_shop(db, shop_id, current_user, active_tenant_id)
    return T.layout(db, shop)


@router.post("/tables/zones", status_code=status.HTTP_201_CREATED)
def create_zone(
    body: ZoneCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _writable_shop(db, body.shop_id, current_user, active_tenant_id)
    zone = T.create_zone(db, shop, body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.zone_out(zone)


@router.patch("/tables/zones/{zone_id}")
def update_zone(
    zone_id: uuid.UUID,
    body: ZoneUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    zone = T._live_zone(db, zone_id, active_tenant_id)
    shop = _writable_shop(db, zone.shop_id, current_user, active_tenant_id)
    T.update_zone(db, shop, zone, body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.zone_out(zone)


@router.post("/tables/zones/{zone_id}/archive")
def archive_zone(
    zone_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """With its tables. 409 `table_has_open_order` while any of them is open."""
    zone = T._live_zone(db, zone_id, active_tenant_id)
    shop = _writable_shop(db, zone.shop_id, current_user, active_tenant_id)
    T.archive_zone(db, zone)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return {"ok": True}


@router.post("/tables/zones/{zone_id}/bulk", status_code=status.HTTP_201_CREATED)
def bulk_tables(
    zone_id: uuid.UUID,
    body: BulkTablesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Tables `from`..`to` (at most 500); numbers the shop already has are skipped."""
    zone = T._live_zone(db, zone_id, active_tenant_id)
    shop = _writable_shop(db, zone.shop_id, current_user, active_tenant_id)
    out = T.bulk_create(db, zone, body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return out


@router.put("/tables/zones/{zone_id}/positions")
def save_positions(
    zone_id: uuid.UUID,
    body: TablePositionsIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The map editor's save: every moved table's place, size and rotation at once."""
    zone = T._live_zone(db, zone_id, active_tenant_id)
    shop = _writable_shop(db, zone.shop_id, current_user, active_tenant_id)
    count = T.set_positions(db, zone, body.items)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return {"saved": count}


@router.post("/tables/tables", status_code=status.HTTP_201_CREATED)
def create_table(
    body: TableCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """409 `{code: table_number_taken}` when a live table of the shop has the number."""
    zone = T._live_zone(db, body.zone_id, active_tenant_id)
    shop = _writable_shop(db, zone.shop_id, current_user, active_tenant_id)
    table = T.create_table(db, zone, body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.table_out(table)


@router.patch("/tables/tables/{table_id}")
def update_table(
    table_id: uuid.UUID,
    body: TableUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    table = T._live_table(db, table_id, active_tenant_id)
    shop = _writable_shop(db, table.shop_id, current_user, active_tenant_id)
    T.update_table(db, table, body, active_tenant_id)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.table_out(table)


@router.post("/tables/tables/{table_id}/archive")
def archive_table(
    table_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """409 `table_has_open_order` while it is open."""
    table = T._live_table(db, table_id, active_tenant_id)
    shop = _writable_shop(db, table.shop_id, current_user, active_tenant_id)
    T.archive_table(db, table)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return {"ok": True}


@router.post("/tables/tables/{table_id}/cancel")
def dashboard_cancel_table(
    table_id: uuid.UUID,
    body: DashboardCancelIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A manager cancels a stuck open table (409 `table_locked` while a till is inside)."""
    table = T._live_table(db, table_id, active_tenant_id)
    shop = _writable_shop(db, table.shop_id, current_user, active_tenant_id)
    out = T.dashboard_cancel(db, current_user, shop, table, body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return out


@router.post("/tables/tables/{table_id}/force-release")
def dashboard_force_release(
    table_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    table = T._live_table(db, table_id, active_tenant_id)
    shop = _writable_shop(db, table.shop_id, current_user, active_tenant_id)
    out = T.dashboard_force_release(db, current_user, table)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return out


@router.get("/tables/cancel-reasons")
def list_reasons(
    include_inactive: bool = Query(False, alias="includeInactive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rows = T.reasons_for(db, active_tenant_id, include_inactive=include_inactive)
    db.commit()
    return [T.reason_out(r) for r in rows]


@router.post("/tables/cancel-reasons", status_code=status.HTTP_201_CREATED)
def create_reason(
    body: ReasonCreate,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    existing = T.reasons_for(db, active_tenant_id, include_inactive=True)
    reason = TableCancelReason(
        id=uuid.uuid4(),
        tenant_id=active_tenant_id,
        name=body.name,
        requires_note=body.requires_note,
        sort_order=body.sort_order if body.sort_order is not None else len(existing),
    )
    db.add(reason)
    db.commit()
    return T.reason_out(reason)


@router.patch("/tables/cancel-reasons/{reason_id}")
def update_reason(
    reason_id: uuid.UUID,
    body: ReasonUpdate,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Edit, reorder, or switch off (`isActive: false` — never deleted: reports name it)."""
    reason = db.get(TableCancelReason, reason_id)
    if reason is None or reason.tenant_id != active_tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="reason_not_found")
    if body.name is not None:
        reason.name = body.name
    if body.requires_note is not None:
        reason.requires_note = body.requires_note
    if body.sort_order is not None:
        reason.sort_order = body.sort_order
    if body.is_active is not None:
        reason.is_active = body.is_active
    db.commit()
    return T.reason_out(reason)


@router.get("/tables/live")
def live_tables(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Open tables now, with their order and lock."""
    shop = _readable_shop(db, shop_id, current_user, active_tenant_id)
    return T.live(db, shop)


@router.get("/tables/reservations")
def list_reservations(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    day: date = Query(..., alias="date"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"הזמנות": the shop's bookings of one day, by time."""
    shop = _readable_shop(db, shop_id, current_user, active_tenant_id)
    return T.reservations_of_day(db, shop, day)


@router.post("/tables/reservations", status_code=status.HTTP_201_CREATED)
def create_reservation(
    body: ReservationIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """409 `reservation_overlap` when the table is booked over that time."""
    if body.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="shop_required")
    shop = _readable_shop(db, body.shop_id, current_user, active_tenant_id)
    r = T.create_reservation(db, shop, body, by_name=getattr(current_user, "username", None))
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.reservation_out(r)


@router.patch("/tables/reservations/{reservation_id}")
def update_reservation(
    reservation_id: uuid.UUID,
    body: ReservationUpdate,
    background_tasks: BackgroundTasks,
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _readable_shop(db, shop_id, current_user, active_tenant_id)
    r = T.update_reservation(db, T.get_reservation(db, reservation_id, shop.id), body)
    db.commit()
    _wake_shop(background_tasks, db, shop.id)
    return T.reservation_out(r)


@router.get("/tables/report")
def tables_report(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Revenue and seating time per table / zone, cancellations by reason and employee."""
    shop = _readable_shop(db, shop_id, current_user, active_tenant_id)
    return T.report(db, shop, date_from, date_to)
