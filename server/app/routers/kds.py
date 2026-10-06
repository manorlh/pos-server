"""
KDS and "תצורת עבודה" endpoints (docs/SPEC_KDS.md §6).

* The till (`/sync/{machine_id}/…`, the till's token): its device assignment and
  workflow configuration, the screen's board, releases and screen actions — every
  mutation idempotent by its `id`.
* The dashboard (`/workflow/config`, `/kds/shops/{shop_id}/…`): the workflow card by
  level, KDS screens, station settings, routing overrides, the live view.
* Public (`/public/kds/pickup/{token}`): the pickup screen — numbers only — by an
  opaque token, for a TV browser without a login.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.kds import (
    KdsActionIn,
    KdsDeviceIn,
    KdsReleaseIn,
    KdsRouteOverrideIn,
    KdsStationSettingIn,
    WorkflowValuesIn,
)
from app.services import kds as KDS
from app.services import kds_workflow as WF
from app.services import printers as K

router = APIRouter(tags=["kds"])


# ── The till ────────────────────────────────────────────────────────────────────


@router.get("/sync/{machine_id}/kds/device")
def get_kds_device(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """`{"device": {...} | null, "workflow": {effective config + configVersion}, "shopName"}`."""
    out = KDS.device_view(db, machine)
    db.commit()
    return out


@router.get("/sync/{machine_id}/workflow")
def get_till_workflow(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = WF.describe(WF.config_for_machine(db, machine))
    db.commit()
    return out


@router.get("/sync/{machine_id}/kds/board")
def get_kds_board(
    machine_id: str,
    since: Optional[int] = Query(None),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = KDS.board(db, machine, since)
    db.commit()
    return out


@router.post("/sync/{machine_id}/kds/release")
def post_kds_release(
    machine_id: str,
    body: KdsReleaseIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Idempotent by `id`. 409 `release_requires_payment` per the release policy (§5)."""
    out = KDS.release(db, machine, body)
    db.commit()
    return out


@router.post("/sync/{machine_id}/kds/actions")
def post_kds_action(
    machine_id: str,
    body: KdsActionIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = KDS.apply_action(db, machine, body)
    db.commit()
    return out


@router.get("/sync/{machine_id}/kds/orders/status")
def get_kds_order_states(
    machine_id: str,
    source: str = Query("table"),
    refs: str = Query(""),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    return KDS.order_states(db, machine, source, refs.split(",") if refs else [])


# ── The dashboard: workflow configuration ───────────────────────────────────────


def _check_scope(db: Session, user: User, tenant_id, scope_type: str, scope_id, write: bool) -> None:
    from app.services.company_hierarchy import user_covers_company

    if scope_type == "company":
        company = db.query(Company).filter(Company.id == scope_id).first()
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="company_not_found")
        ensure_same_tenant(company.tenant_id, tenant_id)
        if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
            return
        if user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, company.id):
            return
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    _, shop = WF.chain_for_scope(db, scope_type, scope_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shop_not_found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    (K.check_edit if write else K.check_read)(db, user, shop)


@router.get("/workflow/config")
def get_workflow_config(
    scope_type: str = Query(..., alias="scopeType", pattern="^(company|shop|area|machine)$"),
    scope_id: uuid.UUID = Query(..., alias="scopeId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _check_scope(db, current_user, active_tenant_id, scope_type, scope_id, write=False)
    out = WF.level_view(db, scope_type, scope_id)
    db.commit()  # the built-in parameters, if this created them
    return out


@router.post("/workflow/config/preview")
def preview_workflow_config(
    body: WorkflowValuesIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The effective configuration and its validation with `values` applied — nothing saved."""
    _check_scope(db, current_user, active_tenant_id, body.scope_type, body.scope_id, write=False)
    out = WF.level_view(db, body.scope_type, body.scope_id, pending=body.values)
    db.rollback()
    return out


@router.put("/workflow/config")
def put_workflow_config(
    body: WorkflowValuesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """422 `workflow_invalid` with the §7 errors; otherwise saved and the tills told."""
    from app.services.till_parameters import publish_parameters_notify

    _check_scope(db, current_user, active_tenant_id, body.scope_type, body.scope_id, write=True)
    targets = WF.save_values(db, body.scope_type, body.scope_id, body.values)
    db.commit()
    background_tasks.add_task(publish_parameters_notify, targets)
    return WF.level_view(db, body.scope_type, body.scope_id)


# ── The dashboard: KDS screens, stations, routing ───────────────────────────────


def _shop(db: Session, shop_id: uuid.UUID, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


@router.get("/kds/shops/{shop_id}")
def get_kds_shop(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    out = KDS.shop_overview(db, shop)
    out["canEdit"] = K.can_edit(db, current_user, shop)
    db.commit()
    return out


@router.put("/kds/shops/{shop_id}/devices/{machine_id}")
def put_kds_device(
    shop_id: uuid.UUID,
    machine_id: uuid.UUID,
    body: KdsDeviceIn,
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Pairs a till of the shop as a KDS screen (and flags it `kdsScreen`, so it asks)."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    device = KDS.save_device(db, shop, machine_id, body)
    out = KDS.device_out(db, device)
    db.commit()
    _notify_till(background_tasks, shop, machine_id)
    return out


def _notify_till(background_tasks: Optional[BackgroundTasks], shop: Shop, machine_id) -> None:
    from app.services.till_parameters import publish_parameters_notify

    if background_tasks is not None:
        background_tasks.add_task(publish_parameters_notify, [(str(shop.tenant_id), str(machine_id))])


@router.delete("/kds/shops/{shop_id}/devices/{machine_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_kds_device(
    shop_id: uuid.UUID,
    machine_id: uuid.UUID,
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    KDS.delete_device(db, shop, machine_id)
    db.commit()
    _notify_till(background_tasks, shop, machine_id)


@router.put("/kds/shops/{shop_id}/stations/{station_id}")
def put_kds_station(
    shop_id: uuid.UUID,
    station_id: uuid.UUID,
    body: KdsStationSettingIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    KDS.save_station_setting(db, shop, station_id, body)
    out = KDS.shop_overview(db, shop)
    db.commit()
    return out


@router.post("/kds/shops/{shop_id}/overrides", status_code=status.HTTP_201_CREATED)
def post_kds_override(
    shop_id: uuid.UUID,
    body: KdsRouteOverrideIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    out = KDS.add_override(db, shop, body)
    db.commit()
    return out


@router.delete("/kds/shops/{shop_id}/overrides/{override_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_kds_override(
    shop_id: uuid.UUID,
    override_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    KDS.delete_override(db, shop, override_id)
    db.commit()


@router.post("/kds/shops/{shop_id}/pickup-token")
def post_pickup_token(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A new opaque token for the public pickup screen (the old link stops working)."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    token = KDS.rotate_pickup_token(db, shop)
    db.commit()
    return {"pickupToken": token}


@router.get("/kds/shops/{shop_id}/board")
def get_kds_shop_board(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    out = KDS.shop_board(db, shop)
    db.commit()
    return out


# ── Public: the pickup screen ───────────────────────────────────────────────────


@router.get("/public/kds/pickup/{token}")
def get_public_pickup(token: str, db: Session = Depends(get_db)):
    """Numbers in preparation and ready — no names, phones or notes (§4, §32)."""
    if len(token) < 20 or len(token) > 64:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    return KDS.public_pickup(db, token)


_PICKUP_HTML = """<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>מסך איסוף</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--text:#f5f6f8;--muted:#9aa3b2;--prep:#f0a020;--ready:#2fbf71}
@media (prefers-color-scheme: light){:root{--bg:#f4f6fa;--card:#ffffff;--text:#11151c;--muted:#5d6676}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,"Segoe UI",Arial,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;font-size:22px}
#state{color:var(--muted);font-size:16px}
main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 16px 16px}
section{background:var(--card);border-radius:16px;padding:16px;min-height:70vh}
h2{margin:0 0 12px;font-size:28px}h2.prep{color:var(--prep)}h2.ready{color:var(--ready)}
.nums{display:flex;flex-wrap:wrap;gap:12px}
.n{font-size:56px;font-weight:700;min-width:120px;text-align:center;padding:8px 16px;border-radius:12px;background:rgba(127,127,127,.12)}
section.r .n{color:var(--ready)}
@media (max-width:640px){main{grid-template-columns:1fr}.n{font-size:40px;min-width:88px}}
</style></head>
<body><header><span id="shop"></span><span id="state">מתחבר…</span></header>
<main><section><h2 class="prep">בהכנה</h2><div class="nums" id="p"></div></section>
<section class="r"><h2 class="ready">מוכן לאיסוף</h2><div class="nums" id="r"></div></section></main>
<script>
const url = location.pathname.replace(/\\/screen$/, '');
function fill(el, items){el.replaceChildren(...items.map(i=>{const d=document.createElement('div');d.className='n';d.textContent=i.number;return d;}));}
async function tick(){
  try{const res=await fetch(url,{cache:'no-store'});if(!res.ok)throw new Error(res.status);
    const data=await res.json();document.getElementById('shop').textContent=data.shopName||'';
    fill(document.getElementById('p'),data.preparing||[]);fill(document.getElementById('r'),data.ready||[]);
    document.getElementById('state').textContent='עודכן '+new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch(e){document.getElementById('state').textContent='אין חיבור — מוצג המידע האחרון';}
}
tick();setInterval(tick,3000);
</script></body></html>"""


@router.get("/public/kds/pickup/{token}/screen", response_class=HTMLResponse)
def get_public_pickup_screen(token: str, db: Session = Depends(get_db)):
    KDS.public_pickup(db, token)  # 404 for an unknown token
    return HTMLResponse(_PICKUP_HTML, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})
