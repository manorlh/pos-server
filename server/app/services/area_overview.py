"""
"ניהול נקודות מכירה" (P:/specs/chain-areas.md §12): a shop's points of sale side by side — their devices by kind
with their status, the item blocks in force that reach each, the menus assigned to each, and how many products
the shop sells in only some of them.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Sequence

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride

KINDS = ("till", "kiosk", "kds", "board")


def _kinds(db: Session, machines: Sequence[POSMachine]) -> Dict[uuid.UUID, str]:
    ids = [m.id for m in machines]
    out = {m.id: "till" for m in machines}
    if not ids:
        return out
    try:
        from app.models.kiosk import KioskDevice

        for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all():
            if d.home_role is None:
                out[d.machine_id] = "kiosk"
    except Exception:  # noqa: BLE001 - a world without the kiosk tables
        pass
    try:
        from app.models.kds import KdsDevice

        for d in db.query(KdsDevice).filter(KdsDevice.machine_id.in_(ids)).all():
            out[d.machine_id] = "board" if d.role == "pickup" else "kds"
    except Exception:  # noqa: BLE001
        pass
    return out


def _blocks(db: Session, shop: Shop, areas: Sequence[ShopArea]) -> Dict[uuid.UUID, Dict[str, int]]:
    out = {a.id: {"own": 0, "inherited": 0} for a in areas}
    try:
        from app.models.sold_out import SoldOutMark
        from app.services import sold_out
    except Exception:  # noqa: BLE001
        return out
    now = datetime.now(timezone.utc)
    marks = (
        db.query(SoldOutMark)
        .filter(SoldOutMark.tenant_id == shop.tenant_id, sold_out.in_force_filter(now))
        .all()
    )
    cache: Dict[Any, Any] = {}
    for mark in marks:
        if mark.shop_id is not None and mark.shop_id != shop.id:
            continue
        level = sold_out.level_of(mark)
        for area in areas:
            if not sold_out.reaches_area(db, mark, area, company_id=shop.company_id, cache=cache):
                continue
            key = "own" if level in ("area", "machine") else "inherited"
            out[area.id][key] += 1
    return out


def _menus(db: Session, shop: Shop, areas: Sequence[ShopArea]) -> Dict[uuid.UUID, List[Dict[str, Any]]]:
    out: Dict[uuid.UUID, List[Dict[str, Any]]] = {a.id: [] for a in areas}
    try:
        from app.models.catalog_menu import CatalogMenu, CatalogMenuAssignment
    except Exception:  # noqa: BLE001
        return out
    targets = [a.id for a in areas] + [shop.id]
    rows = (
        db.query(CatalogMenuAssignment, CatalogMenu)
        .join(CatalogMenu, CatalogMenu.id == CatalogMenuAssignment.menu_id)
        .filter(CatalogMenuAssignment.target_id.in_(targets), CatalogMenuAssignment.level.in_(("area", "shop")))
        .all()
    )
    for assignment, menu in rows:
        item = {"id": str(menu.id), "name": menu.name, "level": assignment.level, "active": bool(menu.is_active)}
        if assignment.level == "shop":
            for a in areas:
                out[a.id].append(item)
        elif assignment.target_id in out:
            out[assignment.target_id].append(item)
    return out


def overview(db: Session, shop: Shop, areas: Sequence[ShopArea], *, whole_shop: bool) -> Dict[str, Any]:
    from app.services.areas import primary_statuses
    from app.services.machine_status import rollup_status

    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .all()
    )
    statuses = primary_statuses(db, machines)
    kinds = _kinds(db, machines)
    blocks = _blocks(db, shop, areas)
    menus = _menus(db, shop, areas)
    partial = 0
    sold_counts = {a.id: 0 for a in areas}
    live_ids = {str(a.id) for a in areas}
    for row in db.query(ShopProductOverride).filter(
        ShopProductOverride.shop_id == shop.id, ShopProductOverride.is_listed.is_(True)
    ):
        ids = row.area_ids if isinstance(row.area_ids, list) else None
        if ids:
            partial += 1
            for a in areas:
                if str(a.id) in {str(i) for i in ids}:
                    sold_counts[a.id] += 1
        else:
            for a in areas:
                sold_counts[a.id] += 1
    out_areas = []
    for area in areas:
        mine = [m for m in machines if m.area_id == area.id]
        devices = {k: [] for k in KINDS}
        for m in sorted(mine, key=lambda m: (m.pos_number or "", m.name or "")):
            devices[kinds.get(m.id, "till")].append({
                "id": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "status": statuses.get(m.id),
            })
        out_areas.append({
            "id": str(area.id),
            "name": area.name,
            "status": rollup_status(statuses[m.id] for m in mine),
            "devices": devices,
            "deviceCount": len(mine),
            "blocks": blocks.get(area.id, {"own": 0, "inherited": 0}),
            "menus": menus.get(area.id, []),
            "productsSold": sold_counts.get(area.id, 0),
        })
    unassigned = [m for m in machines if m.area_id is None or str(m.area_id) not in live_ids]
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "wholeShop": whole_shop,
        "areas": out_areas,
        "unassignedDevices": len(unassigned) if whole_shop else None,
        "productsInSomeAreas": partial,
    }
