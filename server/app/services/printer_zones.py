"""
"הפניית מדפסות לפי אזור שולחנות" — the per-zone printer redirect (docs/SPEC_PRINT_BY_ZONE.md).

The routing (categories, products, stations) says which printers a line prints on, and a
printer's scope (one point of sale, one till) says which tills use it. Neither knows the
table: a waiter's handheld that serves both the hall and the garden prints the garden's
drinks at its own area's bar. A zone redirect fixes that without touching either:

* A table zone may carry `{fromPrinterId: toPrinterId}` (`kitchen_zone_redirects`). Both are
  kitchen printers of the zone's shop, and differ.
* The till applies it last (KitchenRouting.kt): a line of a table in zone Z that routes to
  printer P prints on `redirect[Z][P]` instead (deduplicated). A counter sale, and a zone
  with no redirect, print exactly as before.
* The zone rule wins over the printer's scope: the target prints even when it is narrowed
  away from the sending till — so the till's pull lists such targets (`inScope: false`).
* A redirect to an inactive (or receipt) printer is left out of the pull: the line prints
  where its routing says.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenZoneRedirect
from app.models.shop import Shop
from app.models.tables import TableZone
from app.schemas.printer_discovery import ZoneRedirectsIn
from app.services import printers as K


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def live_zone(db: Session, shop: Shop, zone_id: Any) -> TableZone:
    """A live table zone of `shop`, or 404 `zone_not_found`."""
    try:
        ident = _uuid(zone_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="zone_not_found")
    zone = db.query(TableZone).filter(TableZone.id == ident).first()
    if zone is None or str(zone.shop_id) != str(shop.id) or zone.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="zone_not_found")
    return zone


def _rows(db: Session, shop_id: Any) -> List[KitchenZoneRedirect]:
    return db.query(KitchenZoneRedirect).filter(KitchenZoneRedirect.shop_id == _uuid(shop_id)).all()


def redirects_by_zone(rows) -> Dict[str, Dict[str, str]]:
    """zone id → {from printer id: to printer id}. Pure."""
    out: Dict[str, Dict[str, str]] = {}
    for row in rows:
        out.setdefault(str(row.zone_id), {})[str(row.from_printer_id)] = str(row.to_printer_id)
    return out


def set_zone_redirects(db: Session, shop: Shop, zone: TableZone, body: ZoneRedirectsIn) -> None:
    """
    The zone's redirect, whole. 422 `redirect_to_itself`, `printer_not_in_shop` or
    `printer_not_kitchen` (a receipt printer prints no ticket) — nothing changed then.
    """
    printers = {str(p.id): p for p in K.shop_printers(db, shop.id)}
    pairs: List[Tuple[uuid.UUID, uuid.UUID]] = []
    for source, target in body.redirects.items():
        if str(source) == str(target):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="redirect_to_itself")
        for pid in (source, target):
            printer = printers.get(str(pid))
            if printer is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_in_shop")
            if not K.is_kitchen(printer):
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_kitchen")
        pairs.append((_uuid(source), _uuid(target)))
    db.query(KitchenZoneRedirect).filter(KitchenZoneRedirect.zone_id == zone.id).delete(synchronize_session=False)
    for source, target in pairs:
        db.add(KitchenZoneRedirect(
            zone_id=zone.id, from_printer_id=source, to_printer_id=target,
            tenant_id=shop.tenant_id, shop_id=shop.id,
        ))
    db.flush()


def zone_redirects_out(db: Session, shop: Shop) -> Dict[str, Any]:
    """The dashboard's section: every live zone of the shop with its redirect, and the shop's kitchen printers."""
    from app.services.tables import zones_for

    zones = zones_for(db, shop.id, all_areas=True)
    areas = {a.id: a.name for a in K.shop_areas(db, shop.id)}
    by_zone = redirects_by_zone(_rows(db, shop.id))
    return {
        "shopId": str(shop.id),
        "zones": [
            {
                "id": str(z.id),
                "name": z.name,
                "areaId": str(z.area_id) if z.area_id else None,
                "areaName": areas.get(z.area_id) if z.area_id else None,
                "redirects": [
                    {"fromPrinterId": source, "toPrinterId": target}
                    for source, target in sorted(by_zone.get(str(z.id), {}).items())
                ],
            }
            for z in zones
        ],
        "printers": [
            {"id": str(p.id), "name": p.name, "isActive": bool(p.is_active)}
            for p in K.shop_printers(db, shop.id)
            if K.is_kitchen(p)
        ],
    }


def till_zone_redirects(db: Session, machine: POSMachine) -> Tuple[Dict[str, Dict[str, str]], List[KitchenPrinter]]:
    """
    For the till's pull: the redirects of the zones it sees (the shop-wide ones and its
    point of sale's), narrowed to active kitchen targets, and those targets — which it
    must be able to print on even when they are out of its scope.
    """
    from app.services.tables import zones_for

    if machine.shop_id is None:
        return {}, []
    zone_ids = {str(z.id) for z in zones_for(db, machine.shop_id, machine.area_id)}
    if not zone_ids:
        return {}, []
    printers = {str(p.id): p for p in K.shop_printers(db, machine.shop_id)}
    out: Dict[str, Dict[str, str]] = {}
    targets: Dict[str, KitchenPrinter] = {}
    for zone_id, pairs in redirects_by_zone(_rows(db, machine.shop_id)).items():
        if zone_id not in zone_ids:
            continue
        for source, target in pairs.items():
            printer = printers.get(target)
            if printer is None or not printer.is_active or not K.is_kitchen(printer):
                continue
            out.setdefault(zone_id, {})[source] = target
            targets[target] = printer
    return out, list(targets.values())


def apply_redirect(printer_ids: List[str], redirect: Optional[Dict[str, str]]) -> List[str]:
    """The till's rule, mirrored for the tests: each printer to its redirect, deduplicated, in order."""
    out: List[str] = []
    for pid in printer_ids:
        target = (redirect or {}).get(pid, pid)
        if target not in out:
            out.append(target)
    return out
