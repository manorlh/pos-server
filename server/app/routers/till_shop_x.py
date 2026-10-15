"""
"דוח X סניפי" — the shop-wide interim X (P:/specs/shop-x-report.md; app/services/shop_x.py).

Till (machine token; the till user's permission SHOP_X_REPORT — `X-Pos-User-Id` naming a signed-in
user whose role allows it, or a manager's grant for `report:shop-x` in `X-Elevation-Token`):

GET  /sync/{machine_id}/shop-x   → the report as the cloud holds it now (no refresh)
POST /sync/{machine_id}/shop-x   {posUserName?, outbox?, syncState?, refresh? = true}
                                 → "שלח עכשיו" to the shop's online tills, wait up to
                                   `shopXRefreshSec`, then the report

Both answer `{available, report, printDocument}`: the report JSON (shop_x.build) and the 80 mm print
document in the shape the till prints its X / Z with (`z_print`). Refused: 403
`{code: shop_x_not_available, reason: off | not_selected | not_master}` (`shopXTills`), 401
`elevation_required` (no permission: the till asks for a manager's code), 403
`elevation_missing_scope:report:shop-x`. Every run from a till is journalled (a till event
`shop_x_report`: who, which till, when) — never an exception.

Dashboard (user JWT, "דוחות" view):

GET  /shops/{shop_id}/shop-x?refresh=   → the same report and print document, from the shop's
                                          parameters (`refresh=true`: the shop's online tills first)

Nothing here closes, numbers or claims anything.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ELEVATION_HEADER,
    FISCAL_SYNC_PATH,
    POS_USER_HEADER,
    _checked_grant,
    _elevation_401,
    _operator_with_authority,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import shop_x as SX
from app.services.permissions import Scope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["shop-x"])

SCOPE = Scope.SHOP_X_REPORT


def _tz(db: Session, tenant_id):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    return _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))


def _machine(machine_id: str, machine: POSMachine) -> POSMachine:
    if str(machine.id) != str(machine_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="machine_mismatch")
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    return machine


def _authorize(db: Session, machine: POSMachine, elevation_token: Optional[str], operator_id: Optional[str]) -> Dict[str, Any]:
    """
    SHOP_X_REPORT for this request: a grant for `report:shop-x` at this till (a manager's code — a
    cashier's "באישור"), else the signed-in user named by `X-Pos-User-Id` whose own role allows it.
    Who it was, for the paper's footer and the journal.
    """
    from app.services.tables import approver_name

    if elevation_token:
        session = _checked_grant(db, machine, elevation_token, SCOPE)
        return {
            "posUserId": str(session.pos_user_id) if session.pos_user_id else None,
            "name": approver_name(db, session.user_id, session.pos_user_id),
        }
    operator = _operator_with_authority(db, machine, operator_id, SCOPE)
    if operator is None:
        raise _elevation_401("elevation_required")
    return {"posUserId": str(operator.id), "name": approver_name(db, None, operator.id)}


def _available(db: Session, machine: POSMachine, settings: SX.Settings) -> None:
    ok, reason = SX.available_on(db, machine, settings)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "shop_x_not_available", "reason": reason, "message": "דוח X סניפי לא מופעל בקופה הזו"},
        )


def _answer(db: Session, machine: POSMachine, shop: Shop, settings: SX.Settings, who: Dict[str, Any],
            refresh: Optional[SX.Refresh], by_name: Optional[str]) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    tzinfo = _tz(db, machine.tenant_id)
    report = SX.build(
        db, shop, settings=settings, refresh=refresh, requester=machine, requested_by=by_name, tzinfo=tzinfo, now=now,
    )
    doc = SX.print_document(db, report, shop, tzinfo=tzinfo, printed_by=by_name, till=machine, now=now)
    SX.journal(db, machine, pos_user_id=who.get("posUserId"), by_name=by_name, refreshed=refresh is not None, now=now)
    db.commit()
    return {"available": True, "report": SX.public(report), "printDocument": doc}


@router.get("/sync/{machine_id}/shop-x")
def till_shop_x(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
    operator_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    db: Session = Depends(get_db),
):
    """The report as the cloud holds it now — no refresh of the other tills."""
    machine = _machine(machine_id, machine)
    settings = SX.machine_settings(db, machine)
    _available(db, machine, settings)
    who = _authorize(db, machine, elevation_token, operator_id)
    shop = db.get(Shop, machine.shop_id)
    return _answer(db, machine, shop, settings, who, None, who.get("name"))


#: A till's, as the shop Z's: a display device never asks the shop's tills for "שלח עכשיו" (403 `device_not_fiscal`).
@router.post("/sync/{machine_id}/shop-x", dependencies=FISCAL_SYNC_PATH)
def till_shop_x_refresh(
    machine_id: str,
    body: Any = Body(None),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
    operator_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    db: Session = Depends(get_db),
):
    """
    "רענן": the till has just sent its own outbox (and may say what is left in it, `outbox`, as on
    `POST /sync/{m}/sync-state`); the shop's other online tills get "שלח עכשיו" and the cloud waits
    up to `shopXRefreshSec` for them; then the report, with a warning per till not up to date.
    """
    from app.services import sync_status as SS

    machine = _machine(machine_id, machine)
    data = body if isinstance(body, dict) else {}
    settings = SX.machine_settings(db, machine)
    _available(db, machine, settings)
    who = _authorize(db, machine, elevation_token, operator_id)
    by_name = (str(data.get("posUserName") or "").strip()[:120] or None) or who.get("name")
    SS.apply_report(machine, data.get("syncState"), data.get("outbox"))
    shop = db.get(Shop, machine.shop_id)
    refresh = None
    if data.get("refresh", True) is not False:
        from app.services.z_runs import shop_tills

        refresh = SX.refresh_tills(
            db, shop, shop_tills(db, shop.id), requester=machine, by_name=by_name, wait_sec=settings.refresh_sec,
        )
    return _answer(db, machine, shop, settings, who, refresh, by_name)


@router.get("/shops/{shop_id}/shop-x")
def dashboard_shop_x(
    shop_id: uuid.UUID,
    refresh: bool = Query(False),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The same report for the dashboard and the phone ("דוחות" → "דוח X סניפי"): from the shop's
    parameters (per till / per employee), `refresh=true` asking the shop's online tills first.
    """
    from app.routers.shops import _check_shop_access
    from app.services import dashboard_access as DA

    shop = db.get(Shop, shop_id)
    if shop is None or str(shop.tenant_id) != str(active_tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    _check_shop_access(current_user, shop, db)
    if not DA.effective_access(db, current_user).allows("reports", "view"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    settings = SX.shop_settings(db, shop)
    by_name = current_user.username or current_user.email
    result = None
    if refresh:
        from app.services.z_runs import shop_tills

        result = SX.refresh_tills(db, shop, shop_tills(db, shop.id), requester=None, by_name=by_name, wait_sec=settings.refresh_sec)
    now = datetime.now(timezone.utc)
    tzinfo = _tz(db, shop.tenant_id)
    report = SX.build(db, shop, settings=settings, refresh=result, requested_by=by_name, tzinfo=tzinfo, now=now)
    doc = SX.print_document(db, report, shop, tzinfo=tzinfo, printed_by=by_name, now=now)
    logger.info("shop x for shop %s by %s (refresh=%s)", shop.id, by_name, bool(refresh))
    db.commit()
    return {"available": True, "report": SX.public(report), "printDocument": doc}
