"""
"תצורת עבודה — קופה ראשית" on a shop page: which till the shop leans on, and where its
shop Z may come from (app/services/main_till.py).

GET /shops/{shop_id}/main-till → the main till, `zFrom`, and what each role resolves to
                                 now (tables host, print server, the Z mode) for the card
PUT /shops/{shop_id}/main-till → `{machineId | null, zFrom}` — the super admin's alone,
                                 like the Z mode; refused while a Z run is under way
                                 (409 `z_run_in_progress`)

The main till is `mainTill` on at that till's own level and off at the shop's others;
`zFrom` is the shop's own `shopZFrom`. The shop's tills are told (parameters and the
printers' config: the print server may move with it).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.models.z_run import ZRun, ZRunStatus
from app.services import main_till as MT
from app.services import printers as K
from app.services import till_parameters as TP
from app.services import z_runs as ZR

router = APIRouter(tags=["main-till"])


class MainTillIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    z_from: Optional[str] = Field(None, alias="zFrom")
    #: The super admin moves the shop's Z production although the main till holding it may
    #: still have shop Zs the cloud does not (docs/SPEC_INDEPENDENT_TILL.md §8.10).
    force_producer_switch: bool = Field(False, alias="forceProducerSwitch")


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    # The shop's managers read it (the kitchen printers page's people); only the super
    # admin changes it.
    K.check_read(db, user, shop)
    return shop


def _out(db: Session, shop: Shop, user: User) -> dict:
    from app.services.tables import MODE_LAN, TABLES_MODE_KEY, mode_of, tables_host_of_shop

    params = TP.resolve_for_shop(db, shop)
    tenant = db.get(Tenant, shop.tenant_id) if shop.tenant_id else None
    return {
        "shopId": str(shop.id),
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        "zFrom": MT.z_from_of(db, shop),
        "zFromOptions": list(MT.Z_FROM_OPTIONS),
        # What leans on it today — each may name another till explicitly.
        # "machine" when every till of the shop makes its own Z (`zMode = till`): no shop Z.
        "zScope": (
            "machine"
            if (tills := ZR.shop_tills(db, shop.id))
            and len(ZR.per_till_ids(db, tills)) == len(tills)
            else ZR.z_scope_of(tenant)
        ),
        "tablesMode": params.get(TABLES_MODE_KEY),
        # «רשת מקומית (קופה ראשית)»: the tables live on the host, the main till unless named.
        "tablesLan": mode_of(params.get(TABLES_MODE_KEY)) == MODE_LAN,
        "tablesHost": MT.till_ref(tables_host_of_shop(db, shop.id)),
        "printHost": MT.till_ref(K.print_host_of_shop(db, shop.id)),
        "tills": MT.shop_tills_out(db, shop.id),
        "canEdit": user.role == UserRole.SUPER_ADMIN,
    }


@router.get("/shops/{shop_id}/main-till")
def get_main_till(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = _out(db, shop, current_user)
    db.commit()  # the built-in parameters, if reading created them
    return out


def _parameter(db: Session, key: str) -> TillParameter:
    TP.ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == key).first()
    if parameter is None:  # pragma: no cover - created just above
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{key}_parameter_missing")
    return parameter


@router.put("/shops/{shop_id}/main-till")
def put_main_till(
    shop_id: uuid.UUID,
    body: MainTillIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    if body.z_from is not None and body.z_from not in MT.Z_FROM_OPTIONS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_z_from")
    live = (
        db.query(ZRun)
        .filter(ZRun.shop_id == shop.id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
        .first()
    )
    if live is not None:
        # The run's tills and its master were chosen when it started: finish it first.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="z_run_in_progress")

    tills = K.shop_machines(db, shop.id)
    if body.machine_id is not None and str(body.machine_id) not in {str(m.id) for m in tills}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="machine_not_in_shop")
    chosen = next((m for m in tills if body.machine_id is not None and str(m.id) == str(body.machine_id)), None)
    if chosen is not None and getattr(chosen, "independent_till", False):
        # "קופה עצמאית" (docs/SPEC_INDEPENDENT_TILL.md): outside the shop's LAN group.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "main_till_independent",
                "message": "קופה עצמאית לא יכולה להיות הקופה הראשית של הסניף. בחרו קופה מבין הקופות שבזד הסניפי.",
            },
        )
    now = datetime.now(timezone.utc)
    # Exactly one producer of the shop's Z sequence: pinned before, checked after.
    from app.services import local_shop_z as LZ

    guard = LZ.ProducerGuard(db, [shop], now=now)

    main = _parameter(db, MT.MAIN_TILL_KEY)
    db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == main.id,
        TillParameterValue.scope_type == "machine",
        TillParameterValue.scope_id.in_([m.id for m in tills]),
    ).delete(synchronize_session=False)
    if body.machine_id is not None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=main.id, scope_type="machine", scope_id=body.machine_id, value=True,
        ))
    # A removal must move the tills' parameters watermark too.
    main.updated_at = now

    if body.z_from is not None:
        z_from = _parameter(db, MT.SHOP_Z_FROM_KEY)
        db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == z_from.id,
            TillParameterValue.scope_type == "shop",
            TillParameterValue.scope_id == shop.id,
        ).delete(synchronize_session=False)
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=z_from.id, scope_type="shop", scope_id=shop.id, value=body.z_from,
        ))
        z_from.updated_at = now
    db.flush()
    try:
        guard.check(force=body.force_producer_switch, user=current_user)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(
            status_code=refused.status_code,
            # The card's refusals are `{detail: {code, message}}`.
            content={"detail": {"code": refused.body.get("detail"), **{k: v for k, v in refused.body.items() if k != "detail"}}},
        )
    out = _out(db, shop, current_user)
    targets = TP.notify_targets_for_scope(db, "shop", shop.id)
    db.commit()
    # One `settings` signal: the till's full sync pulls its parameters and printers alike.
    background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out
