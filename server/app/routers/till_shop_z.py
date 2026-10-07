"""
Shop Z from a master till (Z סניפי מקופה ראשית).

A till in `zMode = till` produces its own Z (`POST /sync/{id}/till-z`,
docs/SHIFTS_API.md §5): the shop Z neither takes it nor waits for it.

A till the cloud marks as the shop's master (`shopZMasterTill` in פרמטרים לקופות) shows
"סגירת Z סניפי": every till of its shop and its state, one command that closes them all
and produces the shop Z, and — when a till does not close — the operator's typed "סגור"
to go on without it (its shift waits for the next Z). It is the dashboard's Z run
(app/services/z_runs.py), driven with the till's own token:

GET    /sync/{machine_id}/shop-z                       → the shop's tills, the shop's
                                                         open-tills rule, any run under way
POST   /sync/{machine_id}/shop-z                       → close every till and start the Z
GET    /sync/{machine_id}/shop-z/runs/{run_id}         → the run as it progresses
POST   /sync/{machine_id}/shop-z/runs/{run_id}/proceed → build now without the tills that
                                                         did not close

The run is strict (`ZRun.strict_cloud_check`): the Z is built only once the cloud holds,
for every till, its shift closed, the close accepted and every sale the till counted —
the server refuses to build otherwise (`app.services.z_runs.verify_item`). The only way
past a till is "סגור", which defers it to the next Z and records who decided.

The master closes its own shift itself, at once, from the start's answer (its item's
`id` is the close request); every other till gets the close by realtime, or on its
heartbeat — which beats every few seconds while this screen is open (`shop_z_fast_beat`).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import UserRole
from app.models.z_run import ZRun, ZRunItemStatus, ZRunStatus
from app.schemas.z_run import ZRunOut
from app.services import main_till as MT
from app.services import z_runs as ZR
from app.services.machine_status import is_online

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_SYNC_PATH

router = APIRouter(tags=["till-shop-z"])

#: The till parameter that makes a till its shop's master for the shop Z (the shop's
#: main till, `mainTill`, is its master too — app/services/main_till.py).
MASTER_PARAM = MT.SHOP_Z_MASTER_KEY


class _TillActor:
    """
    The run's operator when a till starts it. `created_by_user_id` must name a user, so
    it is the till's distributor's; the role is not a distributor's, so the open-tills
    check sees every till of the shop. The operator's own name (the till user) is what
    the run and the Z show (see `_stamp_confirmer`).
    """

    def __init__(self, machine: POSMachine, operator: str):
        self.id = machine.distributor_id
        self.role = UserRole.SHOP_MANAGER
        self.username = operator
        self.email = None


class ShopZStartIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The operator typed "סגור" for the tills the Z goes without.
    confirm_open_tills: bool = Field(False, alias="confirmOpenTills")
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=120)


class ShopZProceedIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=120)


def _machine(machine_id: str, machine: POSMachine) -> POSMachine:
    if str(machine.id) != str(machine_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="machine_mismatch")
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    return machine


def _require_master(db: Session, machine: POSMachine) -> None:
    """
    This till may run its shop's Z: the shop's main till ("קופה ראשית") — the only one,
    when the shop has one, unless `shopZFrom` opens it to every till — else a till marked
    `shopZMasterTill` (app/services/main_till.py). 403 `z_only_from_main_till` or
    `not_master_till` otherwise.
    """
    refusal = MT.till_shop_z_refusal(db, machine)
    if refusal is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=refusal)


def _operator(machine: POSMachine, pos_user_name: Optional[str]) -> str:
    who = (pos_user_name or "").strip()
    till = f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "קופה")
    return f"{who} ({till})" if who else till


def _stamp_confirmer(run: ZRun, operator: str) -> None:
    """Name the till user on the run's open-tills confirmation (the markers' JSON)."""
    for item in run.items:
        if ZR.is_left_out_marker(item):
            try:
                data = json.loads(item.error_message or "{}")
            except ValueError:
                data = {}
            data["confirmedBy"] = operator
            item.error_message = json.dumps(data, ensure_ascii=False)


def _live_run(db: Session, shop_id: uuid.UUID, machine_ids: Optional[set] = None) -> Optional[ZRun]:
    """The run under way for these tills — any of the shop's, or (`machine_ids`) one of theirs."""
    runs = (
        db.query(ZRun)
        .filter(ZRun.shop_id == shop_id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
        .order_by(ZRun.created_at.desc())
        .all()
    )
    for run in runs:
        if machine_ids is None or any(
            i.machine_id in machine_ids and not ZR.is_left_out_marker(i) for i in run.items
        ):
            return run
    return None


def _shop_z_tills(db: Session, machine: POSMachine, shop: Shop, tenant: Optional[Tenant]):
    """
    The tills the shop Z is for — the shop's, but those in `zMode = till`, which make
    their own — from the master till only.
    """
    _require_master(db, machine)
    shop_machines = ZR.shop_tills(db, shop.id)
    own_z = ZR.per_till_ids(db, shop_machines, tenant, shop)
    return [m for m in shop_machines if m.id not in own_z]


@router.get("/sync/{machine_id}/shop-z")
def till_shop_z_status(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    ZR.expire_overdue_runs(db)
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    tenant = db.query(Tenant).filter(Tenant.id == machine.tenant_id).first()
    shop_machines = _shop_z_tills(db, machine, shop, tenant)
    now = datetime.now(timezone.utc)
    # The screen is open: the shop's tills beat fast until shortly after it closes, so the
    # close this screen sends reaches them in seconds even without realtime.
    ZR.note_shop_z_screen(machine, now=now)
    tills = []
    # No Z on nothing ("אל תאפשר לסגור Z על 0"): what a Z now could report, so the master
    # offers the start only when there is something to close. The start refuses it too.
    activity = ZR.shop_activity(db, shop.id, shop_machines)
    for m in sorted(shop_machines, key=lambda x: (str(x.pos_number or "~"), x.name or "")):
        cand = ZR.till_candidates(db, m, shop.id)
        open_shift = cand.open_shift
        tills.append({
            "id": str(m.id),
            "posNumber": m.pos_number,
            "name": m.name,
            "self": m.id == machine.id,
            "online": is_online(m.last_heartbeat_at, now=now),
            "lastSeenAt": m.last_heartbeat_at.isoformat() if m.last_heartbeat_at else None,
            "openShift": None if open_shift is None else {
                "id": str(open_shift.id),
                "openedAt": open_shift.opened_at.isoformat() if open_shift.opened_at else None,
                "openedByName": getattr(open_shift, "opened_by", None),
            },
            "closedWaiting": len(cand.closed),
        })
    live = _live_run(db, shop.id, {m.id for m in shop_machines})
    if live is not None and live.status == ZRunStatus.WAITING:
        # A till that was waiting for its transactions is looked at again on every poll.
        ZR.finalise_if_ready(db, live, now=now)
    db.commit()
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        # "shop" (Z סניפי, from the master) or "machine" (Z לכל קופה, this till alone).
        # The tenant's `zScope`: "shop" (one Z for the shop) or "machine" (one till per Z).
        "zScope": ZR.z_scope_of(tenant),
        # The shop's main till ("קופה ראשית"), or null: the till the shop Z comes from.
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        "rule": ZR.open_tills_rule(db, tenant, shop),
        "serverTime": now.isoformat(),
        "activity": activity,
        "tills": tills,
        "run": ZRunOut.model_validate(ZR.run_to_out(db, live)).model_dump(mode="json", by_alias=True) if live else None,
    }


@router.post("/sync/{machine_id}/shop-z", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_SYNC_PATH)
def till_shop_z_start(
    machine_id: str,
    body: ShopZStartIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Close every till of the shop and produce the shop Z. 409
    `{code: open_tills_need_confirmation | open_tills_block_z, tills}` as from the
    dashboard; the till asks the operator to type "סגור" and sends `confirmOpenTills`.
    """
    machine = _machine(machine_id, machine)
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    tenant = db.query(Tenant).filter(Tenant.id == machine.tenant_id).first()
    operator = _operator(machine, body.pos_user_name)
    shop_machines = _shop_z_tills(db, machine, shop, tenant)
    selections = [ZR.MachineSelection(machine_id=m.id) for m in shop_machines]
    ZR.note_shop_z_screen(machine)
    run = ZR.create_z_run(
        db,
        _TillActor(machine, operator),  # type: ignore[arg-type]
        tenant,
        shop,
        selections,
        confirm_open_tills=body.confirm_open_tills,
        # "Don't close the Z until the cloud confirms every till is closed."
        strict_cloud_check=True,
    )
    _stamp_confirmer(run, operator)
    db.commit()
    db.refresh(run)
    return ZRunOut.model_validate(ZR.run_to_out(db, run)).model_dump(mode="json", by_alias=True)


def _own_run(db: Session, machine: POSMachine, run_id: uuid.UUID) -> ZRun:
    """A run of the shop, for its master till to follow."""
    run = ZR.get_run(db, run_id, machine.tenant_id)
    if run is None or run.shop_id != machine.shop_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run_not_found")
    _require_master(db, machine)
    return run


@router.get("/sync/{machine_id}/shop-z/runs/{run_id}")
def till_shop_z_run(
    machine_id: str,
    run_id: uuid.UUID,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    ZR.expire_overdue_runs(db)
    run = _own_run(db, machine, run_id)
    ZR.note_shop_z_screen(machine)
    if run.status == ZRunStatus.WAITING:
        # The master polls every couple of seconds while it waits: each poll is also the
        # cloud verifying again a till that was waiting for its transactions.
        ZR.finalise_if_ready(db, run)
    db.commit()
    return ZRunOut.model_validate(ZR.run_to_out(db, run)).model_dump(mode="json", by_alias=True)


@router.post("/sync/{machine_id}/shop-z/runs/{run_id}/proceed", dependencies=FISCAL_SYNC_PATH)
def till_shop_z_proceed(
    machine_id: str,
    run_id: uuid.UUID,
    body: ShopZProceedIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    The operator typed "סגור": build now without the tills that have not closed — or
    whose transactions the cloud is still waiting for; their shifts move to the next Z.
    Each such till is noted with who decided, on the run and on the Z itself.
    """
    machine = _machine(machine_id, machine)
    run = _own_run(db, machine, run_id)
    operator = _operator(machine, body.pos_user_name)
    strict = bool(getattr(run, "strict_cloud_check", False))
    waiting = [
        i.machine_id
        for i in run.items
        if not ZR.is_left_out_marker(i)
        and i.status != ZRunItemStatus.EXCLUDED
        and (i.status != ZRunItemStatus.READY or (strict and not ZR.verify_item(db, run, i).ok))
    ]
    ZR.proceed_without(db, run, waiting, deferred_by=operator)
    for item in run.items:
        if (
            item.machine_id in waiting
            and item.status == ZRunItemStatus.EXCLUDED
            and not ZR.is_left_out_marker(item)
        ):
            item.error_message = f"הוצאה מה-Z ע״י {operator} — המשמרת עוברת ל-Z הבא"
    db.commit()
    db.refresh(run)
    return ZRunOut.model_validate(ZR.run_to_out(db, run)).model_dump(mode="json", by_alias=True)
