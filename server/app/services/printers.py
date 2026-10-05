"""
Kitchen / bar ticket printers ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4).

The rules, in one place:

* **Who edits.** A shop's printers, routing and kitchen options are edited by the managers
  of that shop: super admin, distributor, a company manager whose scope covers the shop's
  company, and the shop's own manager. Shift supervisors and cashiers read nothing here.
* **Which printers a till uses.** Its shop's active printers that are not narrowed away
  from it: narrowed to a till → only that till; to a point of sale → only that area's
  tills; neither → every till of the shop (`printer_applies_to`).
* **Where a line prints** (`resolve_category_routes`, `printers_for_line`). Printers hang
  on whole categories, resolved from the category a product is in now; a category with
  no rows of its own inherits its parent's. A product's own rows in a shop win over its
  category's (a row with no printer = "no ticket" there), and "ללא בון" on the product
  itself (`kitchen_no_ticket_products`) wins over everything, in every shop. A line
  prints on every printer it routes to.
* **The relay.** A `cloud` printer's jobs from other tills wait here for its host till.
  Handed out by `GET pending` (pending → printing), re-handed if not acknowledged within
  `JOB_LEASE`, finished by the host's ack (done / failed), and expired when nobody
  printed them within `JOB_TTL`.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.printers import (
    DEFAULT_LAN_PORT,
    KitchenNoTicketProduct,
    KitchenPrinter,
    KitchenPrinterRoute,
    KitchenPrintHost,
    KitchenPrintJob,
    KitchenStation,
    KitchenStationPrinter,
    KitchenStationTarget,
)
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.config import get_settings
from app.schemas.kitchen_printers import (
    PRODUCT_WIDE_MODES,
    CategoryRoutesIn,
    KitchenOptionsIn,
    KitchenPrintersPatch,
    PrinterIn,
    PrintJobAckIn,
    PrintJobIn,
    ProductRouteIn,
)
from app.services.areas import as_utc
from app.services.company_hierarchy import user_covers_company

#: The till parameters this module reads (and lets a shop's managers set).
ON_SALE_KEY = "kitchenTicketsOnSale"
ON_TILL_KEY = "kitchenTicketsOnTill"
OPTION_KEYS = (ON_SALE_KEY, ON_TILL_KEY)
#: Every till parameter the printers page edits by shop → point of sale → till ("הגדרות
#: הדפסה"); the till parameters page leaves them to it (`PRINTERS_PAGE_KEYS`).
SETTING_KEYS = (
    "receiptPrinter",
    "receiptPrinterAddress",
    "receiptPrinterModel",
    "cashDrawer",
    "askBeforePrint",
    ON_SALE_KEY,
    ON_TILL_KEY,
)

#: A relayed ticket nobody printed by then is failed for its sender.
JOB_TTL = timedelta(minutes=5)
#: A job handed to its host and not acknowledged within this is handed out again.
JOB_LEASE = timedelta(minutes=2)
#: How far back the dashboard's test-print results reach.
TEST_JOBS_WINDOW = timedelta(minutes=15)
#: The most jobs one pending pull hands out.
PENDING_BATCH = 20

#: The Ably notify reason for a change of printers / routing / options.
NOTIFY_REASON = "printers_updated"
#: The Ably event that wakes a till with relayed jobs to print.
PRINT_JOB_EVENT = "print-job"

EDIT_ROLES = frozenset({
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.COMPANY_MANAGER,
    UserRole.SHOP_MANAGER,
})

NotifyTarget = Tuple[str, str]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment else None


# ── Permissions ───────────────────────────────────────────────────────────────


def can_edit(db: Session, user: User, shop: Shop) -> bool:
    """A manager of this shop (see the module docstring)."""
    if user.role not in EDIT_ROLES:
        return False
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if user.role == UserRole.COMPANY_MANAGER:
        return bool(user_covers_company(db, user, shop.company_id))
    return user.shop_id is not None and str(user.shop_id) == str(shop.id)


def check_edit(db: Session, user: User, shop: Shop) -> None:
    if not can_edit(db, user, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def check_read(db: Session, user: User, shop: Shop) -> None:
    """Reading is for the same people: the page is a setup page, not a report."""
    check_edit(db, user, shop)


# ── Printers ──────────────────────────────────────────────────────────────────


def get_printer(db: Session, printer_id: Any) -> KitchenPrinter:
    try:
        ident = _uuid(printer_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")
    printer = db.query(KitchenPrinter).filter(KitchenPrinter.id == ident).first()
    if printer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")
    return printer


def shop_printers(db: Session, shop_id: Any) -> List[KitchenPrinter]:
    return (
        db.query(KitchenPrinter)
        .filter(KitchenPrinter.shop_id == _uuid(shop_id))
        .order_by(KitchenPrinter.sort_order, KitchenPrinter.name)
        .all()
    )


def shop_machines(db: Session, shop_id: Any) -> List[POSMachine]:
    return (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == _uuid(shop_id), POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )


def shop_areas(db: Session, shop_id: Any) -> List[ShopArea]:
    return (
        db.query(ShopArea)
        .filter(ShopArea.shop_id == _uuid(shop_id), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
    )


def machine_label(machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    number = (machine.pos_number or "").strip()
    name = (machine.name or "").strip()
    if number and name:
        return f"{number} · {name}"
    return name or number or str(machine.id)


def printer_out(printer: KitchenPrinter, machines: Dict[uuid.UUID, POSMachine] | None = None,
                areas: Dict[uuid.UUID, ShopArea] | None = None) -> Dict[str, Any]:
    machines = machines or {}
    areas = areas or {}
    host = machines.get(printer.host_machine_id) if printer.host_machine_id else None
    narrowed_till = machines.get(printer.machine_id) if printer.machine_id else None
    area = areas.get(printer.area_id) if printer.area_id else None
    return {
        "id": str(printer.id),
        "shopId": str(printer.shop_id),
        "name": printer.name,
        "purpose": printer.purpose or "kitchen",
        "cashDrawer": bool(printer.cash_drawer),
        "connectionType": printer.connection_type,
        "host": printer.host,
        "port": printer.port,
        "btAddress": printer.bt_address,
        "btName": printer.bt_name,
        "hostMachineId": str(printer.host_machine_id) if printer.host_machine_id else None,
        "hostMachineName": machine_label(host),
        "hostConnection": printer.host_connection,
        "areaId": str(printer.area_id) if printer.area_id else None,
        "areaName": area.name if area else None,
        "machineId": str(printer.machine_id) if printer.machine_id else None,
        "machineName": machine_label(narrowed_till),
        "paperWidth": printer.paper_width,
        "copies": printer.copies,
        "cutPaper": bool(printer.cut_paper),
        "beep": bool(printer.beep),
        "isActive": bool(printer.is_active),
        "sortOrder": printer.sort_order,
        "updatedAt": _iso(printer.updated_at),
    }


def _shop_machine(db: Session, shop: Shop, machine_id: Optional[uuid.UUID], what: str) -> None:
    if machine_id is None:
        return
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None or str(machine.shop_id) != str(shop.id) or not machine.is_active:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"{what}_not_in_shop")


def apply_printer(db: Session, shop: Shop, printer: KitchenPrinter, body: PrinterIn) -> KitchenPrinter:
    """Write `body` onto `printer` (new or existing), checking every reference is the shop's."""
    if body.area_id is not None:
        area = db.query(ShopArea).filter(ShopArea.id == body.area_id).first()
        if area is None or str(area.shop_id) != str(shop.id) or area.archived_at is not None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="area_not_in_shop")
    _shop_machine(db, shop, body.machine_id, "machine")
    _shop_machine(db, shop, body.host_machine_id, "host_machine")

    printer.tenant_id = shop.tenant_id
    printer.shop_id = shop.id
    printer.name = body.name
    printer.purpose = body.purpose
    printer.cash_drawer = body.cash_drawer
    printer.connection_type = body.connection_type
    printer.host = body.host
    printer.port = body.port
    printer.bt_address = body.bt_address
    printer.bt_name = body.bt_name
    printer.host_machine_id = body.host_machine_id
    printer.host_connection = body.host_connection
    printer.area_id = body.area_id
    printer.machine_id = body.machine_id
    printer.paper_width = body.paper_width
    printer.copies = body.copies
    printer.cut_paper = body.cut_paper
    printer.beep = body.beep
    printer.is_active = body.is_active
    printer.sort_order = body.sort_order
    printer.updated_at = _now()
    return printer


def create_printer(db: Session, shop: Shop, body: PrinterIn) -> KitchenPrinter:
    printer = KitchenPrinter(id=uuid.uuid4())
    apply_printer(db, shop, printer, body)
    db.add(printer)
    db.flush()
    return printer


def delete_printer(db: Session, printer: KitchenPrinter) -> None:
    """Its routes go with it (a product routed only there falls back to its category)."""
    db.query(KitchenPrinterRoute).filter(KitchenPrinterRoute.printer_id == printer.id).delete(
        synchronize_session=False
    )
    db.delete(printer)
    db.flush()


def printer_applies_to(printer: KitchenPrinter, machine: POSMachine) -> bool:
    """Is `printer` one of `machine`'s (same shop, active, not narrowed away from it)?"""
    if not printer.is_active or str(printer.shop_id) != str(machine.shop_id):
        return False
    if printer.machine_id is not None:
        return str(printer.machine_id) == str(machine.id)
    if printer.area_id is not None:
        return machine.area_id is not None and str(printer.area_id) == str(machine.area_id)
    return True


def tills_using(db: Session, printer: KitchenPrinter) -> List[POSMachine]:
    """The active tills the printer applies to."""
    return [m for m in shop_machines(db, printer.shop_id) if printer_applies_to(printer, m)]


# ── Routing ───────────────────────────────────────────────────────────────────


def _routes(db: Session, shop_id: Any, target_type: Optional[str] = None) -> List[KitchenPrinterRoute]:
    query = db.query(KitchenPrinterRoute).filter(KitchenPrinterRoute.shop_id == _uuid(shop_id))
    if target_type:
        query = query.filter(KitchenPrinterRoute.target_type == target_type)
    return query.all()


def own_routes(rows: Iterable[KitchenPrinterRoute], target_type: str) -> Dict[str, List[str]]:
    """target id → its own printers, `[]` for an explicit "no ticket"."""
    out: Dict[str, List[str]] = {}
    for row in rows:
        if row.target_type != target_type:
            continue
        printers = out.setdefault(str(row.target_id), [])
        if row.printer_id is not None and str(row.printer_id) not in printers:
            printers.append(str(row.printer_id))
    return out


def resolve_category_routes(
    parents: Dict[str, Optional[str]], own: Dict[str, List[str]]
) -> Dict[str, List[str]]:
    """
    Every category's effective printers: its own rows, else its nearest ancestor's with
    rows, else none. Pure. `parents`: category id → parent id. Categories that end up
    with no printers are left out. A cycle in the tree stops the walk.
    """
    resolved: Dict[str, List[str]] = {}
    for category_id in set(parents) | set(own):
        seen = set()
        current: Optional[str] = category_id
        while current is not None and current not in seen:
            seen.add(current)
            if current in own:
                if own[current]:
                    resolved[category_id] = list(own[current])
                break
            current = parents.get(current)
    return resolved


def printers_for_line(
    product_id: Optional[str],
    category_id: Optional[str],
    product_routes: Dict[str, List[str]],
    category_routes: Dict[str, List[str]],
) -> List[str]:
    """The till's rule, mirrored here for the tests: the product's own, else its category's."""
    if product_id is not None and product_id in product_routes:
        return list(product_routes[product_id])
    if category_id is not None:
        return list(category_routes.get(category_id, []))
    return []


# ── Stations ──────────────────────────────────────────────────────────────────
#
# "תחנות מטבח": one list for the network (גריל, טיגון, סלטים, בר…). A category or product is
# assigned to a station once; each shop says which of its printers a station prints on. A
# shop's own printer rows for the category / product win over the station.

#: Stations and their assignments are network-wide: edited above the shop level.
STATION_EDIT_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER})


def check_station_edit(user: User) -> None:
    if user.role not in STATION_EDIT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def stations_of(db: Session, tenant_id: Any) -> List[KitchenStation]:
    return (
        db.query(KitchenStation)
        .filter(KitchenStation.tenant_id == _uuid(tenant_id))
        .order_by(KitchenStation.sort_order, KitchenStation.name)
        .all()
    )


def station_printers_in_shop(db: Session, tenant_id: Any, shop_id: Any) -> Dict[str, List[str]]:
    """station id → its printers of this shop (active ones), in the shop's printer order."""
    rows = (
        db.query(KitchenStationPrinter.station_id, KitchenPrinter.id)
        .join(KitchenPrinter, KitchenPrinter.id == KitchenStationPrinter.printer_id)
        .join(KitchenStation, KitchenStation.id == KitchenStationPrinter.station_id)
        .filter(
            KitchenStation.tenant_id == _uuid(tenant_id),
            KitchenPrinter.shop_id == _uuid(shop_id),
            KitchenPrinter.is_active.is_(True),
        )
        .order_by(KitchenPrinter.sort_order, KitchenPrinter.name)
        .all()
    )
    out: Dict[str, List[str]] = {}
    for sid, pid in rows:
        out.setdefault(str(sid), []).append(str(pid))
    return out


def station_targets(db: Session, tenant_id: Any) -> List[KitchenStationTarget]:
    return db.query(KitchenStationTarget).filter(KitchenStationTarget.tenant_id == _uuid(tenant_id)).all()


def station_routes(
    db: Session, tenant_id: Any, shop_id: Any
) -> Tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    """
    (category id → printers, product id → printers) that stations give this shop. A target
    whose station has no printer here is left out — it falls to its parent category, or to
    the shop's other routing — rather than becoming "no ticket".
    """
    printers = station_printers_in_shop(db, tenant_id, shop_id)
    categories: Dict[str, List[str]] = {}
    products: Dict[str, List[str]] = {}
    for target in station_targets(db, tenant_id):
        pids = printers.get(str(target.station_id))
        if not pids:
            continue
        (categories if target.target_type == "category" else products)[str(target.target_id)] = list(pids)
    return categories, products


def stations_out(db: Session, tenant_id: Any, shop_id: Any = None) -> Dict[str, Any]:
    """The stations, what is assigned to each, and — for a shop — the printers of each there."""
    printers = station_printers_in_shop(db, tenant_id, shop_id) if shop_id is not None else {}
    targets: Dict[str, Dict[str, List[str]]] = {}
    for t in station_targets(db, tenant_id):
        bucket = targets.setdefault(str(t.station_id), {"categoryIds": [], "productIds": []})
        bucket["categoryIds" if t.target_type == "category" else "productIds"].append(str(t.target_id))
    return {
        "stations": [
            {
                "id": str(s.id),
                "name": s.name,
                "sortOrder": s.sort_order,
                "printerIds": printers.get(str(s.id), []),
                **targets.get(str(s.id), {"categoryIds": [], "productIds": []}),
            }
            for s in stations_of(db, tenant_id)
        ]
    }


def save_station(db: Session, tenant_id: Any, station_id: Any, name: str, sort_order: int = 0) -> KitchenStation:
    clean = (name or "").strip()
    if not clean:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="station_name_required")
    clash = (
        db.query(KitchenStation)
        .filter(KitchenStation.tenant_id == _uuid(tenant_id), KitchenStation.name == clean)
        .first()
    )
    if clash is not None and (station_id is None or str(clash.id) != str(station_id)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="station_name_taken")
    if station_id is None:
        station = KitchenStation(id=uuid.uuid4(), tenant_id=_uuid(tenant_id), name=clean, sort_order=sort_order)
        db.add(station)
    else:
        station = get_station(db, tenant_id, station_id)
        station.name = clean
        station.sort_order = sort_order
    db.flush()
    return station


def get_station(db: Session, tenant_id: Any, station_id: Any) -> KitchenStation:
    station = (
        db.query(KitchenStation)
        .filter(KitchenStation.id == _uuid(station_id), KitchenStation.tenant_id == _uuid(tenant_id))
        .first()
    )
    if station is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="station_not_found")
    return station


def set_station_printers(db: Session, shop: Shop, station: KitchenStation, printer_ids: Iterable[Any]) -> None:
    """The station's printers in this shop, replacing its printers here (other shops untouched)."""
    wanted = _check_printers(db, shop, [_uuid(p) for p in printer_ids])
    mine = [p.id for p in shop_printers(db, shop.id)]
    if mine:
        db.query(KitchenStationPrinter).filter(
            KitchenStationPrinter.station_id == station.id,
            KitchenStationPrinter.printer_id.in_(mine),
        ).delete(synchronize_session=False)
    for pid in wanted:
        db.add(KitchenStationPrinter(station_id=station.id, printer_id=pid))
    db.flush()


def set_station_target(db: Session, tenant_id: Any, target_type: str, target_id: Any, station_id: Any) -> None:
    """Assign a category or product to a station, or (`station_id` None) clear its station."""
    if target_type not in ("category", "product"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_target_type")
    model = Category if target_type == "category" else Product
    if db.query(model.id).filter(model.id == _uuid(target_id), model.tenant_id == _uuid(tenant_id)).first() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{target_type}_not_found")
    db.query(KitchenStationTarget).filter(
        KitchenStationTarget.target_type == target_type,
        KitchenStationTarget.target_id == _uuid(target_id),
    ).delete(synchronize_session=False)
    if station_id is not None:
        station = get_station(db, tenant_id, station_id)
        db.add(KitchenStationTarget(
            target_type=target_type, target_id=_uuid(target_id), tenant_id=_uuid(tenant_id), station_id=station.id,
        ))
    db.flush()


def tenant_targets(db: Session, tenant_id: Any) -> List[NotifyTarget]:
    """Every till of the tenant: a station change can reroute any shop."""
    machines = db.query(POSMachine).filter(POSMachine.tenant_id == _uuid(tenant_id)).all()
    return _targets(machines)


def _tenant_category_parents(db: Session, tenant_id: Any) -> Dict[str, Optional[str]]:
    rows = db.query(Category.id, Category.parent_id).filter(Category.tenant_id == tenant_id).all()
    return {str(cid): (str(pid) if pid else None) for cid, pid in rows}


def shop_categories(db: Session, shop: Shop) -> List[Category]:
    """The categories a shop's tills can sell from, for the dashboard's matrix."""
    return (
        db.query(Category)
        .filter(
            Category.tenant_id == shop.tenant_id,
            Category.is_active.is_(True),
            Category.pos_machine_id.is_(None),
            or_(Category.shop_id.is_(None), Category.shop_id == shop.id),
        )
        .order_by(Category.sort_order, Category.name)
        .all()
    )


def _printer_ids_of_shop(db: Session, shop: Shop) -> set:
    return {str(p.id) for p in shop_printers(db, shop.id)}


def _check_printers(db: Session, shop: Shop, printer_ids: Iterable[uuid.UUID]) -> List[uuid.UUID]:
    """The ids, each a kitchen printer of the shop (a receipt printer prints no ticket)."""
    printers = {str(p.id): p for p in shop_printers(db, shop.id)}
    cleaned: List[uuid.UUID] = []
    for pid in printer_ids:
        if str(pid) not in printers:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_in_shop")
        if not is_kitchen(printers[str(pid)]):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_kitchen")
        if pid not in cleaned:
            cleaned.append(pid)
    return cleaned


def routing_out(db: Session, shop: Shop, user: Optional[User] = None) -> Dict[str, Any]:
    """
    The routing page: the category matrix, and every product with a setting of its own
    that reaches this shop — its rows here, or "ללא בון" on the product itself. Each such
    product says in how many shops it has rows (the reset asks first when more than one)
    and whether `user` may change it product-wide.
    """
    rows = _routes(db, shop.id)
    categories = shop_categories(db, shop)
    category_own = own_routes(rows, "category")
    parents = _tenant_category_parents(db, shop.tenant_id)
    effective = resolve_category_routes(parents, category_own)
    product_own = own_routes(rows, "product")
    flagged = set(no_ticket_ids(db, shop.tenant_id))
    listed = set(product_own) | flagged
    products = {}
    if listed:
        ids = [_uuid(pid) for pid in listed]
        products = {str(p.id): p for p in db.query(Product).filter(Product.id.in_(ids)).all()}
    shop_counts = _override_shop_counts(db, listed)
    return {
        "categories": [
            {
                "id": str(c.id),
                "name": c.name,
                "parentId": str(c.parent_id) if c.parent_id else None,
                "sortOrder": c.sort_order,
            }
            for c in categories
        ],
        "categoryRoutes": {cid: pids for cid, pids in category_own.items() if pids},
        "effectiveCategoryRoutes": effective,
        "products": sorted(
            (
                {
                    "productId": pid,
                    "name": products[pid].name if pid in products else None,
                    "categoryId": str(products[pid].category_id) if pid in products else None,
                    # no_ticket: "ללא בון" on the product, everywhere; else its rows here.
                    "mode": "no_ticket" if pid in flagged else ("printers" if product_own[pid] else "none"),
                    "printerIds": [] if pid in flagged else product_own.get(pid, []),
                    "noTicket": pid in flagged,
                    "overrideShopCount": shop_counts.get(pid, 0),
                    "canEditProduct": (
                        can_edit_product(db, user, products[pid]) if user is not None and pid in products else None
                    ),
                }
                for pid in listed
            ),
            key=lambda row: (row["name"] or "", row["productId"]),
        ),
    }


def set_category_routes(db: Session, shop: Shop, body: CategoryRoutesIn) -> None:
    """The matrix, whole: every category's own rows become exactly what is sent."""
    db.query(KitchenPrinterRoute).filter(
        KitchenPrinterRoute.shop_id == shop.id, KitchenPrinterRoute.target_type == "category"
    ).delete(synchronize_session=False)
    for category_id, printer_ids in body.routes.items():
        for pid in _check_printers(db, shop, printer_ids):
            db.add(KitchenPrinterRoute(
                id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id,
                target_type="category", target_id=category_id, printer_id=pid,
            ))
    db.flush()


def set_product_route(db: Session, shop: Shop, product_id: uuid.UUID, body: ProductRouteIn) -> None:
    """
    A product's own printers in one shop. `409 product_no_ticket` for printers while
    "ללא בון" is on the product: it would print nowhere anyway — switch that off first.
    """
    product = canonical_product(db, product_id, shop.tenant_id)
    product_id = product.id
    if body.mode == "printers" and is_no_ticket(db, product_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="product_no_ticket")
    printer_ids = _check_printers(db, shop, body.printer_ids)
    db.query(KitchenPrinterRoute).filter(
        KitchenPrinterRoute.shop_id == shop.id,
        KitchenPrinterRoute.target_type == "product",
        KitchenPrinterRoute.target_id == product_id,
    ).delete(synchronize_session=False)
    if body.mode == "none":
        db.add(KitchenPrinterRoute(
            id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id,
            target_type="product", target_id=product_id, printer_id=None,
        ))
    for pid in printer_ids:
        db.add(KitchenPrinterRoute(
            id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id,
            target_type="product", target_id=product_id, printer_id=pid,
        ))
    db.flush()


def target_route(
    db: Session,
    shop: Shop,
    target_type: str,
    target_id: Any,
    *,
    machine: Optional[POSMachine] = None,
    user: Optional[User] = None,
) -> Dict[str, Any]:
    """
    One product's or category's printers in a shop, for its edit form: its own setting
    (`mode` inherit / none / printers), and what it gets from its category (a product) or
    its parent (a category) when it inherits — resolved now, from where it sits now. A
    product's also carries its product-wide state and where it prints now (`product_state`);
    with `machine`, as that till sees it.
    """
    if target_type == "product":
        return product_state(db, canonical_product(db, target_id, shop.tenant_id), shop, machine=machine, user=user)
    rows = _routes(db, shop.id)
    category_own = own_routes(rows, "category")
    parents = _tenant_category_parents(db, shop.tenant_id)
    resolved = resolve_category_routes(parents, category_own)
    ident = str(target_id)
    own = own_routes(rows, target_type).get(ident)
    if target_type == "product":
        product = db.query(Product).filter(Product.id == _uuid(target_id)).first()
        if product is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
        from_id = str(product.category_id) if product.category_id else None
        inherited = resolved.get(from_id, []) if from_id else []
    else:
        from_id = parents.get(ident)
        inherited = resolved.get(from_id, []) if from_id else []
    from_name = None
    if from_id:
        row = db.query(Category.name).filter(Category.id == _uuid(from_id)).first()
        from_name = row[0] if row else None
    printers = shop_printers(db, shop.id)
    return {
        "shopId": str(shop.id),
        "mode": "inherit" if own is None else ("printers" if own else "none"),
        "printerIds": own or [],
        "inheritedPrinterIds": inherited,
        "inheritedFromId": from_id,
        "inheritedFromName": from_name,
        "printers": [
            {"id": str(p.id), "name": p.name, "isActive": bool(p.is_active), "type": p.connection_type}
            for p in printers
            if is_kitchen(p)
        ],
    }


def apply_patch(
    db: Session,
    shop: Shop,
    target_type: str,
    target_id: uuid.UUID,
    patch: KitchenPrintersPatch,
    *,
    machine_id: Any = None,
) -> None:
    """A product's / category's printers as its own write sends them (`kitchenPrinters`)."""
    if target_type == "product":
        product = canonical_product(db, target_id, shop.tenant_id)
        if patch.mode == "no_ticket":
            set_no_ticket(db, product, True, machine_id=machine_id)
        elif patch.mode == "ticket":
            set_no_ticket(db, product, False)
        elif patch.mode == "reset":
            reset_product(db, product)
        else:
            set_product_route(db, shop, product.id, ProductRouteIn(mode=patch.mode, printerIds=patch.printer_ids))
        return
    if patch.mode in PRODUCT_WIDE_MODES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="mode_is_for_products")
    category = db.query(Category).filter(Category.id == target_id).first()
    if category is None or (category.tenant_id is not None and str(category.tenant_id) != str(shop.tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    printer_ids = _check_printers(db, shop, patch.printer_ids)
    db.query(KitchenPrinterRoute).filter(
        KitchenPrinterRoute.shop_id == shop.id,
        KitchenPrinterRoute.target_type == "category",
        KitchenPrinterRoute.target_id == target_id,
    ).delete(synchronize_session=False)
    if patch.mode == "none":
        db.add(KitchenPrinterRoute(
            id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id,
            target_type="category", target_id=target_id, printer_id=None,
        ))
    for pid in printer_ids:
        db.add(KitchenPrinterRoute(
            id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id,
            target_type="category", target_id=target_id, printer_id=pid,
        ))
    db.flush()


# ── A product's kitchen settings, across shops ───────────────────────────────
#
# Two one-tap controls on the product itself (the dashboard's product form and routing
# page, the till's product dialog):
#
# * "ללא בון" (`set_no_ticket`): no kitchen ticket for the product in any shop — not on a
#   kitchen printer, not on a till's own. Turning it on also drops the product's rows in
#   every shop, so turning it off again really is "by the category".
# * "אפס להגדרת המחלקה" (`reset_product`): every product-level setting in every shop goes;
#   the product follows its category everywhere.
#
# Both act on the tenant-wide product (a till's machine-local copy names it), and reach
# the tills through the routing pull (`GET /sync/{m}/printers`), whose ETag they move.


def canonical_product(db: Session, product_id: Any, tenant_id: Any = None) -> Product:
    """The product a kitchen setting is kept on; a till's machine-local copy names its global product."""
    try:
        ident = _uuid(product_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    product = db.query(Product).filter(Product.id == ident).first()
    if product is None or (
        tenant_id is not None and product.tenant_id is not None and str(product.tenant_id) != str(tenant_id)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    if product.global_product_id is not None:
        base = db.query(Product).filter(Product.id == product.global_product_id).first()
        if base is not None:
            return base
    return product


def no_ticket_ids(db: Session, tenant_id: Any) -> List[str]:
    """The tenant's products with "ללא בון" on them."""
    rows = (
        db.query(KitchenNoTicketProduct.product_id)
        .filter(KitchenNoTicketProduct.tenant_id == _uuid(tenant_id))
        .all()
        if tenant_id is not None
        else []
    )
    return sorted(str(row[0]) for row in rows)


def is_no_ticket(db: Session, product_id: Any) -> bool:
    return (
        db.query(KitchenNoTicketProduct.product_id)
        .filter(KitchenNoTicketProduct.product_id == _uuid(product_id))
        .first()
        is not None
    )


def _override_shop_counts(db: Session, product_ids: Iterable[str]) -> Dict[str, int]:
    """product id → in how many shops it has rows of its own."""
    ids = [_uuid(pid) for pid in product_ids]
    if not ids:
        return {}
    rows = (
        db.query(KitchenPrinterRoute.target_id, KitchenPrinterRoute.shop_id)
        .filter(KitchenPrinterRoute.target_type == "product", KitchenPrinterRoute.target_id.in_(ids))
        .distinct()
        .all()
    )
    counts: Dict[str, int] = {}
    for target_id, _ in rows:
        counts[str(target_id)] = counts.get(str(target_id), 0) + 1
    return counts


def product_override_shops(db: Session, product: Product) -> List[Dict[str, Any]]:
    """The shops where the product has rows of its own, and what they say."""
    rows = (
        db.query(KitchenPrinterRoute)
        .filter(KitchenPrinterRoute.target_type == "product", KitchenPrinterRoute.target_id == product.id)
        .all()
    )
    if not rows:
        return []
    by_shop: Dict[str, List[str]] = {}
    for row in rows:
        printers = by_shop.setdefault(str(row.shop_id), [])
        if row.printer_id is not None and str(row.printer_id) not in printers:
            printers.append(str(row.printer_id))
    shops = {str(s.id): s.name for s in db.query(Shop).filter(Shop.id.in_([_uuid(s) for s in by_shop])).all()}
    printer_ids = {pid for pids in by_shop.values() for pid in pids}
    names = (
        {str(p.id): p.name for p in db.query(KitchenPrinter).filter(KitchenPrinter.id.in_([_uuid(p) for p in printer_ids])).all()}
        if printer_ids
        else {}
    )
    return sorted(
        (
            {
                "shopId": shop_id,
                "shopName": shops.get(shop_id),
                "mode": "printers" if pids else "none",
                "printerIds": pids,
                "printerNames": [names.get(pid, "?") for pid in pids],
            }
            for shop_id, pids in by_shop.items()
        ),
        key=lambda row: (row["shopName"] or "", row["shopId"]),
    )


def can_edit_product(db: Session, user: Optional[User], product: Product) -> bool:
    """May `user` change the product itself — the product form's own rule (catalog roles, its company / shop)."""
    if user is None:
        return False
    from app.routers.products import _CATALOG_ROLES, _check_product_access

    if user.role not in _CATALOG_ROLES:
        return False
    try:
        _check_product_access(user, product, db)
    except HTTPException:
        return False
    return True


def product_targets(db: Session, product: Product) -> List[NotifyTarget]:
    """Every active till of the product's tenant: a product-wide setting reaches all its shops."""
    if product.tenant_id is None:
        return []
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.tenant_id == product.tenant_id, POSMachine.is_active.is_(True))
        .all()
    )
    return _targets(machines)


def _clear_product_rows(db: Session, product: Product) -> None:
    db.query(KitchenPrinterRoute).filter(
        KitchenPrinterRoute.target_type == "product", KitchenPrinterRoute.target_id == product.id
    ).delete(synchronize_session=False)


def set_no_ticket(
    db: Session, product: Product, on: bool, *, user_id: Any = None, machine_id: Any = None
) -> List[NotifyTarget]:
    """
    "ללא בון" on (no kitchen ticket in any shop; the product's rows in every shop go too) or
    off (back to its category). Idempotent. The tills to tell.
    """
    row = db.query(KitchenNoTicketProduct).filter(KitchenNoTicketProduct.product_id == product.id).first()
    if on:
        _clear_product_rows(db, product)
        if row is None:
            db.add(KitchenNoTicketProduct(
                product_id=product.id,
                tenant_id=product.tenant_id,
                created_by_user_id=user_id,
                created_by_machine_id=machine_id,
            ))
    elif row is not None:
        db.delete(row)
    db.flush()
    return product_targets(db, product)


def reset_product(db: Session, product: Product) -> List[NotifyTarget]:
    """"אפס להגדרת המחלקה": every product-level kitchen setting, in every shop, removed."""
    _clear_product_rows(db, product)
    db.query(KitchenNoTicketProduct).filter(KitchenNoTicketProduct.product_id == product.id).delete(
        synchronize_session=False
    )
    db.flush()
    return product_targets(db, product)


def effective_for_shop(
    db: Session,
    product: Product,
    shop: Shop,
    *,
    flagged: Optional[bool] = None,
    machine: Optional[POSMachine] = None,
) -> Dict[str, Any]:
    """
    Where the product prints in `shop` now, and why. `source`: `no_ticket` ("ללא בון" on
    the product), `product_none` (its "no ticket" in this shop), `product` (its own printers
    here) or `category` (its category's, inherited down the tree). Active printers only;
    with `machine`, only those that till uses.
    """
    if flagged is None:
        flagged = is_no_ticket(db, product.id)
    printers = [
        p for p in shop_printers(db, shop.id)
        if p.is_active and (machine is None or printer_applies_to(p, machine))
    ]
    names = {str(p.id): p.name for p in printers}

    def out(source: str, ids: List[str]) -> Dict[str, Any]:
        mine = [p for p in ids if p in names]
        return {"source": source, "printerIds": mine, "printerNames": [names[p] for p in mine]}

    if flagged:
        return out("no_ticket", [])
    rows = _routes(db, shop.id)
    own = own_routes(rows, "product").get(str(product.id))
    if own is not None:
        return out("product" if own else "product_none", own)
    parents = _tenant_category_parents(db, shop.tenant_id)
    resolved = resolve_category_routes(parents, own_routes(rows, "category"))
    return out("category", resolved.get(str(product.category_id), []) if product.category_id else [])


def product_state(
    db: Session,
    product: Product,
    shop: Optional[Shop] = None,
    *,
    machine: Optional[POSMachine] = None,
    user: Optional[User] = None,
) -> Dict[str, Any]:
    """
    The product's kitchen settings for its edit forms: "ללא בון", the shops where it has
    rows of its own, and — with `shop` — its setting there, what its category gives it, the
    shop's printers and where it prints now (`effective`).
    """
    flagged = is_no_ticket(db, product.id)
    category_name = None
    if product.category_id:
        row = db.query(Category.name).filter(Category.id == product.category_id).first()
        category_name = row[0] if row else None
    out: Dict[str, Any] = {
        "productId": str(product.id),
        "productName": product.name,
        "categoryId": str(product.category_id) if product.category_id else None,
        "categoryName": category_name,
        "noTicket": flagged,
        "overrideShops": product_override_shops(db, product),
        "canEditProduct": can_edit_product(db, user, product) if user is not None else None,
    }
    if shop is None:
        return out
    rows = _routes(db, shop.id)
    own = own_routes(rows, "product").get(str(product.id))
    parents = _tenant_category_parents(db, shop.tenant_id)
    resolved = resolve_category_routes(parents, own_routes(rows, "category"))
    from_id = str(product.category_id) if product.category_id else None
    out.update({
        "shopId": str(shop.id),
        "mode": "inherit" if own is None else ("printers" if own else "none"),
        "printerIds": own or [],
        "inheritedPrinterIds": resolved.get(from_id, []) if from_id else [],
        "inheritedFromId": from_id,
        "inheritedFromName": category_name,
        "printers": [
            {"id": str(p.id), "name": p.name, "isActive": bool(p.is_active), "type": p.connection_type}
            for p in shop_printers(db, shop.id)
            if is_kitchen(p)
        ],
        "effective": effective_for_shop(db, product, shop, flagged=flagged, machine=machine),
    })
    return out


# ── Printing settings (till parameters, by shop → point of sale → till) ────────


def _option_parameters(db: Session) -> Dict[str, TillParameter]:
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    rows = db.query(TillParameter).filter(TillParameter.key.in_(SETTING_KEYS)).all()
    return {row.key: row for row in rows}


def options_out(db: Session, shop: Shop) -> Dict[str, Any]:
    """
    The printing settings as this page edits them: each parameter's definition, what the
    shop inherits from above it (`inherited`: the company's value, else the default), and
    the values set at the shop, its areas and its tills.
    """
    parameters = _option_parameters(db)
    by_id = {p.id: key for key, p in parameters.items()}
    scope_ids = [shop.id] + [a.id for a in shop_areas(db, shop.id)] + [m.id for m in shop_machines(db, shop.id)]
    if shop.company_id is not None:
        scope_ids.append(shop.company_id)
    values = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            TillParameterValue.scope_id.in_(scope_ids),
        )
        .all()
        if by_id
        else []
    )
    levels: Dict[str, Dict[str, Dict[str, Any]]] = {"company": {}, "shop": {}, "area": {}, "machine": {}}
    for row in values:
        if row.scope_type not in levels:
            continue
        levels[row.scope_type].setdefault(str(row.scope_id), {})[by_id[row.parameter_id]] = row.value
    company = levels["company"].get(str(shop.company_id), {}) if shop.company_id is not None else {}
    ordered = [parameters[key] for key in SETTING_KEYS if key in parameters]
    return {
        "parameters": [
            {
                "key": p.key,
                "label": p.label,
                "description": p.description,
                "valueType": p.value_type,
                "enumOptions": p.enum_options,
                "defaultValue": p.default_value,
            }
            for p in ordered
        ],
        "defaults": {p.key: p.default_value for p in ordered},
        "inherited": {p.key: company.get(p.key, p.default_value) for p in ordered},
        "fromCompany": sorted(company),
        "shop": levels["shop"].get(str(shop.id), {}),
        "areas": levels["area"],
        "machines": levels["machine"],
    }


def _wanted_settings(body: KitchenOptionsIn) -> Dict[str, Any]:
    """`key → value or None (remove)` for what the body sets; unknown keys are refused."""
    sent = body.model_fields_set
    wanted: Dict[str, Any] = {}
    if "kitchen_tickets_on_sale" in sent:
        wanted[ON_SALE_KEY] = body.kitchen_tickets_on_sale
    if "kitchen_tickets_on_till" in sent:
        wanted[ON_TILL_KEY] = body.kitchen_tickets_on_till
    for key, value in (body.values or {}).items():
        if key not in SETTING_KEYS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"unknown_setting:{key}")
        wanted[key] = value
    return wanted


def set_options(db: Session, shop: Shop, body: KitchenOptionsIn) -> List[NotifyTarget]:
    """Upsert / remove printing settings at one level of the shop; the tills to tell."""
    if body.scope_type == "shop":
        if str(body.scope_id) != str(shop.id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="scope_not_in_shop")
        tills = shop_machines(db, shop.id)
    elif body.scope_type == "area":
        area = db.query(ShopArea).filter(ShopArea.id == body.scope_id).first()
        if area is None or str(area.shop_id) != str(shop.id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="scope_not_in_shop")
        tills = [m for m in shop_machines(db, shop.id) if str(m.area_id) == str(area.id)]
    else:
        machine = db.query(POSMachine).filter(POSMachine.id == body.scope_id).first()
        if machine is None or str(machine.shop_id) != str(shop.id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="scope_not_in_shop")
        tills = [machine]

    from app.services.till_parameters import TillParameterValueError, validate_value

    parameters = _option_parameters(db)
    wanted = _wanted_settings(body)
    for key, value in list(wanted.items()):
        if value is None or key not in parameters:
            continue
        parameter = parameters[key]
        try:
            wanted[key] = validate_value(parameter.value_type, value, parameter.enum_options)
        except TillParameterValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid_value:{key}: {exc}"
            ) from exc
    now = _now()
    for key, value in wanted.items():
        if key not in parameters:
            continue
        parameter = parameters[key]
        row = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == body.scope_type,
                TillParameterValue.scope_id == body.scope_id,
            )
            .first()
        )
        if value is None:
            if row is not None:
                db.delete(row)
                # A removal still has to move the tills' parameters watermark.
                parameter.updated_at = now
        elif row is None:
            db.add(TillParameterValue(
                id=uuid.uuid4(), parameter_id=parameter.id, scope_type=body.scope_type,
                scope_id=body.scope_id, value=value,
            ))
        else:
            row.value = value
            row.updated_at = now
    db.flush()
    return _targets(tills)


def options_for_machine(db: Session, machine: POSMachine) -> Dict[str, bool]:
    from app.services.till_parameters import till_parameters_for_machine

    resolved = till_parameters_for_machine(db, machine).parameters
    return {key: resolved.get(key) is True for key in OPTION_KEYS}


# ── The till's pull ───────────────────────────────────────────────────────────


HOSTED_TYPES = ("cloud",)
#: The printers a shop's print server prints for the other tills (theirs is the LAN).
SERVED_TYPES = ("network", "bluetooth")
#: The till parameter that makes a till its shop's print server ("שרת הדפסות").
PRINT_HOST_KEY = "printHostTill"


def is_kitchen(printer: KitchenPrinter) -> bool:
    return (printer.purpose or "kitchen") == "kitchen"


def is_served(printer: KitchenPrinter) -> bool:
    """The shop's print server prints it for the other tills: a network / Bluetooth kitchen printer."""
    return printer.connection_type in SERVED_TYPES and is_kitchen(printer)


def is_hosted_by(printer: KitchenPrinter, machine: POSMachine) -> bool:
    """A cloud / print-host printer whose host is `machine`."""
    return printer.connection_type in HOSTED_TYPES and str(printer.host_machine_id) == str(machine.id)


def print_secret(shop_id: Any) -> str:
    """
    The shop's print-host secret: what the tills of a shop present to its print host over
    the LAN. Derived, not stored — the same for every till of the shop, different for
    every shop, and changed for all of them by changing the server key.
    """
    key = (get_settings().jwt_secret_key or "").encode("utf-8")
    return hmac.new(key, f"kitchen-print:{shop_id}".encode("utf-8"), hashlib.sha256).hexdigest()[:40]


def printer_for_till(
    printer: KitchenPrinter, machine: POSMachine, in_scope: bool, serves: bool = False
) -> Dict[str, Any]:
    # This till prints it for others: a cloud printer it hosts, or — as the shop's print
    # server — any network / Bluetooth kitchen printer.
    is_host = is_hosted_by(printer, machine) or (serves and is_served(printer))
    return {
        "id": str(printer.id),
        "name": printer.name,
        #: kitchen | receipt — a receipt printer is never a ticket's: the till prints its
        #: bills and receipts there when asked, and opens its drawer (`cashDrawer`).
        "purpose": printer.purpose or "kitchen",
        "cashDrawer": bool(printer.cash_drawer),
        "type": printer.connection_type,
        "host": printer.host,
        "port": printer.port,
        "btAddress": printer.bt_address,
        "btName": printer.bt_name,
        "hostMachineId": str(printer.host_machine_id) if printer.host_machine_id else None,
        "hostConnection": printer.host_connection,
        #: This till prints the cloud / print-host printer's jobs itself, by `hostConnection`.
        "isHost": is_host,
        #: Lines of this till's tickets may route to it (false: listed only as a host).
        "inScope": in_scope,
        "paperWidth": printer.paper_width,
        "copies": printer.copies,
        "cutPaper": bool(printer.cut_paper),
        "beep": bool(printer.beep),
    }


def print_host_of_shop(db: Session, shop_id: Any) -> Optional[POSMachine]:
    """
    The shop's print server: the active till whose `printHostTill` parameter resolves on
    (normally set at the till's own level, like `shopZMasterTill`). Several: the lowest
    register number, so every till agrees on one. None marked: the shop's main till
    ("קופה ראשית", app/services/main_till.py), else none — off by default.
    """
    from app.services.main_till import main_till_of_shop
    from app.services.till_parameters import till_parameters_for_machine

    if shop_id is None:
        return None
    hosts = [
        m for m in shop_machines(db, shop_id)
        if till_parameters_for_machine(db, m).parameters.get(PRINT_HOST_KEY) is True
    ]
    if not hosts:
        return main_till_of_shop(db, shop_id)

    def order(m: POSMachine):
        number = (m.pos_number or "").strip()
        return (0, int(number), "") if number.isdigit() else (1, 0, number or str(m.id))

    return sorted(hosts, key=order)[0]


def print_host_block(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """The shop's print server as `machine` needs it: who, and where on the LAN."""
    host = print_host_of_shop(db, machine.shop_id)
    if host is None:
        return None
    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == host.id).first()
    return {
        "machineId": str(host.id),
        "name": machine_label(host),
        "isSelf": str(host.id) == str(machine.id),
        # Not the report time: the ETag must not move on every heartbeat.
        "lanAddress": row.lan_address if row is not None else None,
        "port": (row.port if row is not None and row.port else DEFAULT_LAN_PORT),
    }


def report_print_host(db: Session, machine: POSMachine, lan_address: Optional[str], port: int) -> Dict[str, Any]:
    """The print server's heartbeat report of where it listens. Kept for any till."""
    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == machine.id).first()
    if row is None:
        row = KitchenPrintHost(machine_id=machine.id)
        db.add(row)
    row.shop_id = machine.shop_id
    row.lan_address = lan_address
    row.port = port
    row.reported_at = _now()
    db.flush()
    return {"lanAddress": row.lan_address, "port": row.port, "reportedAt": _iso(row.reported_at)}


def sync_payload(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """`GET /sync/{id}/printers` without the ETag fields."""
    printers: List[Dict[str, Any]] = []
    in_scope_ids: set = set()
    print_host = print_host_block(db, machine) if machine.shop_id is not None else None
    serves = bool(print_host and print_host["isSelf"])
    if machine.shop_id is not None:
        for printer in shop_printers(db, machine.shop_id):
            applies = printer_applies_to(printer, machine)
            hosts = printer.is_active and (
                is_hosted_by(printer, machine)
                # The print server prints every network / Bluetooth kitchen printer of the shop.
                or (serves and is_served(printer))
            )
            # A receipt printer: listed for the tills it applies to; no ticket routes there.
            kitchen = is_kitchen(printer)
            if applies or (hosts and kitchen):
                printers.append(printer_for_till(printer, machine, applies and kitchen, serves))
            if applies and kitchen:
                in_scope_ids.add(str(printer.id))

    category_routes: Dict[str, List[str]] = {}
    product_routes: Dict[str, List[str]] = {}
    if machine.shop_id is not None:
        rows = _routes(db, machine.shop_id)
        # Stations ("תחנות"): a category or product assigned to a station prints on the
        # station's printers in this shop — unless the shop routes it itself (its own rows
        # win). Folded into the same two tables, so the till's rule is unchanged.
        station_category, station_product = station_routes(db, machine.tenant_id, machine.shop_id)
        if in_scope_ids:
            parents = _tenant_category_parents(db, machine.tenant_id)
            category_own = own_routes(rows, "category")
            for cid, pids in station_category.items():
                category_own.setdefault(cid, pids)
            for cid, pids in resolve_category_routes(parents, category_own).items():
                mine = [p for p in pids if p in in_scope_ids]
                if mine:
                    category_routes[cid] = mine
        product_own = own_routes(rows, "product")
        for pid, pids in product_own.items():
            # Kept even when empty: [] is "no ticket", not "follow the category". A
            # till with no printer of its own still gets the explicit "no ticket" (its
            # counter-sale fallback must not print the line on itself).
            if in_scope_ids or not pids:
                product_routes[pid] = [p for p in pids if p in in_scope_ids]
        for pid, pids in station_product.items():
            mine = [p for p in pids if p in in_scope_ids]
            if pid not in product_own and mine:
                product_routes[pid] = mine
        # "ללא בון" on the product itself: no ticket here, whatever the shop's rows say.
        for pid in no_ticket_ids(db, machine.tenant_id):
            product_routes[pid] = []
        # A till may hold a machine-local copy of a routed product under its own id.
        if product_routes:
            copies = (
                db.query(Product.id, Product.global_product_id)
                .filter(
                    Product.pos_machine_id == machine.id,
                    Product.global_product_id.in_([_uuid(p) for p in product_routes]),
                )
                .all()
            )
            for local_id, global_id in copies:
                product_routes.setdefault(str(local_id), list(product_routes[str(global_id)]))

    return {
        "machineId": str(machine.id),
        "printers": printers,
        "categoryRoutes": category_routes,
        "productRoutes": product_routes,
        "options": options_for_machine(db, machine),
        "hostsRelay": serves or any(p["isHost"] for p in printers),
        #: The shop's print server ("שרת הדפסות", till parameter `printHostTill`), or null.
        "printHost": print_host,
        #: This till is it: it runs the LAN server and reports where.
        "hostsLan": serves,
        #: Presented to / checked by the print server on the LAN.
        "printSecret": print_secret(machine.shop_id) if machine.shop_id is not None else None,
    }


def etag_of(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def sync_response(db: Session, machine: POSMachine, etag: Optional[str]) -> Dict[str, Any]:
    payload = sync_payload(db, machine)
    tag = etag_of(payload)
    base = {"etag": tag, "serverTime": _now().isoformat()}
    if etag and etag == tag:
        return {"syncType": "unchanged", **base}
    return {"syncType": "full", **base, **payload}


# ── The relay ─────────────────────────────────────────────────────────────────


def expire_jobs(db: Session, jobs: Iterable[KitchenPrintJob], now: Optional[datetime] = None) -> None:
    """Jobs past their time and not finished become `expired` (in place)."""
    now = now or _now()
    for job in jobs:
        if job.status in ("pending", "printing") and as_utc(job.expires_at) <= now:
            job.status = "expired"
            job.completed_at = now
            job.error = job.error or "expired"


def job_out(job: KitchenPrintJob, machines: Dict[uuid.UUID, POSMachine] | None = None) -> Dict[str, Any]:
    machines = machines or {}
    target = machines.get(job.target_machine_id) if job.target_machine_id else None
    return {
        "id": str(job.id),
        "printerId": str(job.printer_id) if job.printer_id else None,
        "printerName": job.printer_name,
        "kind": job.kind,
        "status": job.status,
        "error": job.error,
        "targetMachineId": str(job.target_machine_id) if job.target_machine_id else None,
        "targetMachineName": machine_label(target),
        "createdAt": _iso(job.created_at),
        "expiresAt": _iso(job.expires_at),
        "completedAt": _iso(job.completed_at),
    }


def _job_printer_block(printer: Optional[KitchenPrinter]) -> Optional[Dict[str, Any]]:
    """How the host reaches the printer, so it can print a job for a printer it never pulled."""
    if printer is None:
        return None
    reach = printer.host_connection if printer.connection_type in HOSTED_TYPES else printer.connection_type
    return {
        "id": str(printer.id),
        "name": printer.name,
        "type": printer.connection_type,
        "connection": reach,
        "host": printer.host,
        "port": printer.port,
        "btAddress": printer.bt_address,
        "btName": printer.bt_name,
        "paperWidth": printer.paper_width,
        "copies": printer.copies,
        "cutPaper": bool(printer.cut_paper),
        "beep": bool(printer.beep),
    }


def relay_target(db: Session, printer: KitchenPrinter):
    """
    The till that prints `printer`'s relayed jobs: a cloud printer's host; a network /
    Bluetooth printer's, the shop's print server (when it has one). None: not relayed.
    """
    if printer.connection_type in HOSTED_TYPES:
        return printer.host_machine_id
    if is_served(printer):
        host = print_host_of_shop(db, printer.shop_id)
        return host.id if host is not None else None
    return None


def create_job(db: Session, machine: POSMachine, body: PrintJobIn) -> Tuple[KitchenPrintJob, bool]:
    """
    A ticket from `machine` for a cloud printer of its shop. Idempotent by `body.id`: a
    retried upload returns the job as it stands. `(job, created)`.
    """
    existing = db.query(KitchenPrintJob).filter(KitchenPrintJob.id == body.id).first()
    if existing is not None:
        if str(existing.source_machine_id) != str(machine.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="print_job_id_taken")
        return existing, False
    printer = db.query(KitchenPrinter).filter(KitchenPrinter.id == body.printer_id).first()
    if printer is None or str(printer.shop_id) != str(machine.shop_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")
    if not printer.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_inactive")
    if printer.connection_type in HOSTED_TYPES and printer.host_machine_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_has_no_host")
    target_id = relay_target(db, printer)
    if target_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_relayed")
    now = _now()
    payload = body.ticket.model_dump(by_alias=True)
    if not payload.get("sourceName"):
        payload["sourceName"] = machine_label(machine)
    job = KitchenPrintJob(
        id=body.id,
        tenant_id=printer.tenant_id,
        shop_id=printer.shop_id,
        printer_id=printer.id,
        printer_name=printer.name,
        kind="ticket",
        target_machine_id=target_id,
        source_machine_id=machine.id,
        status="pending",
        payload=payload,
        created_at=now,
        expires_at=now + JOB_TTL,
    )
    db.add(job)
    db.flush()
    return job, True


def create_test_jobs(db: Session, user: User, printer: KitchenPrinter) -> List[KitchenPrintJob]:
    """
    A test ticket for each till that would print on `printer`: its host for a cloud
    printer, otherwise every active till it applies to.
    """
    served_by = print_host_of_shop(db, printer.shop_id) if is_served(printer) else None
    if printer.connection_type in HOSTED_TYPES:
        targets = []
        if printer.host_machine_id is not None:
            host = db.query(POSMachine).filter(POSMachine.id == printer.host_machine_id).first()
            if host is not None and host.is_active:
                targets = [host]
    elif served_by is not None:
        # The shop's print server prints it for everyone: it is the one to test.
        targets = [served_by] if printer.is_active else []
    else:
        targets = tills_using(db, printer) if printer.is_active else []
    if not targets:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_has_no_till")
    now = _now()
    who = (user.username or user.email or "").strip() or None
    jobs = []
    for till in targets:
        job = KitchenPrintJob(
            id=uuid.uuid4(),
            tenant_id=printer.tenant_id,
            shop_id=printer.shop_id,
            printer_id=printer.id,
            printer_name=printer.name,
            kind="test",
            target_machine_id=till.id,
            source_machine_id=None,
            created_by_user_id=user.id,
            status="pending",
            payload={
                "source": "test",
                "tableName": None,
                "zoneName": None,
                "guests": None,
                "waiterName": who,
                "createdAt": now.isoformat(),
                "isAddition": False,
                "lines": [],
                "orderRef": None,
                "sourceName": machine_label(till),
            },
            created_at=now,
            expires_at=now + JOB_TTL,
        )
        db.add(job)
        jobs.append(job)
    db.flush()
    return jobs


def test_jobs(db: Session, printer: KitchenPrinter) -> List[KitchenPrintJob]:
    since = _now() - TEST_JOBS_WINDOW
    jobs = (
        db.query(KitchenPrintJob)
        .filter(
            KitchenPrintJob.printer_id == printer.id,
            KitchenPrintJob.kind == "test",
            KitchenPrintJob.created_at >= since,
        )
        .order_by(KitchenPrintJob.created_at.desc())
        .all()
    )
    expire_jobs(db, jobs)
    return jobs


def pending_jobs(db: Session, machine: POSMachine, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    The jobs `machine` should print now, handed out (pending → printing). A job already
    handed out and not acknowledged within `JOB_LEASE` is handed out again.
    """
    now = now or _now()
    rows = (
        db.query(KitchenPrintJob)
        .filter(
            KitchenPrintJob.target_machine_id == machine.id,
            KitchenPrintJob.status.in_(("pending", "printing")),
        )
        .order_by(KitchenPrintJob.created_at)
        .all()
    )
    expire_jobs(db, rows, now)
    printers = {}
    out: List[Dict[str, Any]] = []
    for job in rows:
        if len(out) >= PENDING_BATCH:
            break
        if job.status == "expired":
            continue
        if job.status == "printing" and job.delivered_at is not None and as_utc(job.delivered_at) + JOB_LEASE > now:
            continue
        job.status = "printing"
        job.delivered_at = now
        job.deliveries = (job.deliveries or 0) + 1
        if job.printer_id is not None and job.printer_id not in printers:
            printers[job.printer_id] = db.query(KitchenPrinter).filter(KitchenPrinter.id == job.printer_id).first()
        out.append({
            "id": str(job.id),
            "kind": job.kind,
            "printerId": str(job.printer_id) if job.printer_id else None,
            "printer": _job_printer_block(printers.get(job.printer_id)),
            "ticket": job.payload,
            "createdAt": _iso(job.created_at),
            "expiresAt": _iso(job.expires_at),
        })
    db.flush()
    return out


def ack_job(db: Session, machine: POSMachine, job_id: Any, body: PrintJobAckIn) -> KitchenPrintJob:
    """The printing till's answer. Only the job's target may give it; a finished job keeps
    its first answer (a repeated ack is harmless)."""
    try:
        ident = _uuid(job_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Print job not found")
    job = db.query(KitchenPrintJob).filter(KitchenPrintJob.id == ident).first()
    if job is None or str(job.target_machine_id) != str(machine.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Print job not found")
    if job.status in ("done", "failed"):
        return job
    now = _now()
    # Printed late is still printed: an ack beats the expiry.
    job.status = body.status
    job.error = (body.error or None) if body.status == "failed" else None
    job.completed_at = now
    db.flush()
    return job


def job_statuses(db: Session, machine: POSMachine, ids: Sequence[str]) -> List[Dict[str, Any]]:
    """The sender's view of jobs it sent; unknown and foreign ids are left out."""
    wanted = []
    for raw in ids:
        try:
            wanted.append(_uuid(raw.strip()))
        except (TypeError, ValueError, AttributeError):
            continue
    if not wanted:
        return []
    jobs = (
        db.query(KitchenPrintJob)
        .filter(KitchenPrintJob.id.in_(wanted[:200]), KitchenPrintJob.source_machine_id == machine.id)
        .all()
    )
    expire_jobs(db, jobs)
    db.flush()
    return [job_out(job) for job in jobs]


# ── Notify ────────────────────────────────────────────────────────────────────


def _targets(machines: Iterable[POSMachine]) -> List[NotifyTarget]:
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id and m.is_active]


def shop_targets(db: Session, shop_id: Any) -> List[NotifyTarget]:
    return _targets(shop_machines(db, shop_id))


def job_targets(db: Session, jobs: Iterable[KitchenPrintJob]) -> List[NotifyTarget]:
    ids = {j.target_machine_id for j in jobs if j.target_machine_id is not None}
    if not ids:
        return []
    return _targets(db.query(POSMachine).filter(POSMachine.id.in_(list(ids))).all())


def publish_config_notify(targets: Iterable[NotifyTarget]) -> None:
    """After the commit: the tills pull again (their `settings` signal runs a full sync)."""
    from app.services import ably_notify

    for tenant_id, machine_id in targets:
        try:
            ably_notify.publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
        except Exception:  # pragma: no cover - best effort; tills also pull on sync
            pass


def publish_job_notify(targets: Iterable[NotifyTarget]) -> None:
    """After the commit: wake the printing till; it also looks on its heartbeat."""
    from app.services import ably_notify

    for tenant_id, machine_id in targets:
        try:
            ably_notify.publish_notify(
                tenant_id, machine_id, PRINT_JOB_EVENT, {"serverTime": _now().isoformat()}
            )
        except Exception:  # pragma: no cover - best effort
            pass


# ── The print server from the dashboard (a till picker over `printHostTill`) ──


def print_host_out(db: Session, shop: Shop) -> Optional[Dict[str, Any]]:
    """The kitchen printers page's "שרת הדפסות": which till, and where it last said it listens."""
    host = print_host_of_shop(db, shop.id)
    if host is None:
        return None
    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == host.id).first()
    return {
        "machineId": str(host.id),
        "name": machine_label(host),
        "lanAddress": row.lan_address if row is not None else None,
        "port": row.port if row is not None and row.port else DEFAULT_LAN_PORT,
        "reportedAt": _iso(row.reported_at) if row is not None else None,
    }


def set_print_host(db: Session, shop: Shop, machine_id: Optional[uuid.UUID]) -> List[NotifyTarget]:
    """
    Make one till of the shop its print server (or, with None, none): `printHostTill` on
    at that till's own level, and off at every other till of the shop. The tills to tell.
    """
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == PRINT_HOST_KEY).first()
    if parameter is None:  # pragma: no cover - created just above
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="print_host_parameter_missing")
    tills = shop_machines(db, shop.id)
    if machine_id is not None and str(machine_id) not in {str(m.id) for m in tills}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="machine_not_in_shop")
    db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == "machine",
        TillParameterValue.scope_id.in_([m.id for m in tills]),
    ).delete(synchronize_session=False)
    if machine_id is not None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine_id, value=True,
        ))
    # A removal must move the tills' parameters watermark too.
    parameter.updated_at = _now()
    db.flush()
    return _targets(tills)
