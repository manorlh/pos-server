"""
Kitchen / bar ticket printers ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4).

Dashboard (user JWT; the shop's managers — see app/services/printers.py):

GET    /shops/{shop_id}/printers                 → printers, the shop's areas and tills,
                                                    the kitchen options per level, `canEdit`
POST   /shops/{shop_id}/printers                 → create
PUT    /printers/{id}                            → replace
DELETE /printers/{id}                            → delete (its routes go with it)
POST   /printers/{id}/test                       → a test ticket for its host, or for every
                                                    till it applies to; the jobs
GET    /printers/{id}/test-jobs                  → the last 15 minutes' test jobs, statuses
GET    /shops/{shop_id}/printer-routing          → categories, their own and effective
                                                    printers, product overrides
PUT    /shops/{shop_id}/printer-routing/categories          → the matrix, whole
GET|PUT /shops/{shop_id}/printer-routing/products/{product}   → one product: inherit / none /
                                                    printers, and what its category gives it
GET|PUT /shops/{shop_id}/printer-routing/categories/{category} → one category, the same
PUT    /shops/{shop_id}/print-host               → the shop's print server: a till, or none
PUT    /shops/{shop_id}/printer-options          → `kitchenTicketsOnSale` /
                                                    `kitchenTicketsOnTill` at one level

Kitchen stations ("תחנות" — network-wide; super admin, distributor, company manager):

GET    /kitchen-stations[?shopId=]              → the stations, what each takes, and with a
                                                    shop, each one's printers there
POST   /kitchen-stations | PUT|DELETE /kitchen-stations/{id} → add / rename / delete
PUT    /shops/{shop_id}/kitchen-stations/{id}/printers → a station's printers in a shop
PUT    /kitchen-station-targets                 → a category / product to a station, or none

The product itself, in every shop (whoever may edit the product):

GET    /products/{id}/kitchen-printers[?shopId=] → "ללא בון", the shops with settings of
                                                    its own; with a shop, where it prints now
PUT    /products/{id}/kitchen-printers/no-ticket → "ללא בון" on / off
POST   /products/{id}/kitchen-printers/reset     → "אפס להגדרת המחלקה": all its settings, all shops

Till (machine JWT):

GET    /sync/{m}/printers[?etag=]                → its printers, routing and options, and
                                                    the shop's print-host secret
GET    /sync/{m}/products/{id}/kitchen-printers  → the till's product dialog (written back
GET    /sync/{m}/categories/{id}/kitchen-printers  through the till's product / category PUT
                                                    with `kitchenPrinters`; for a product
                                                    also `no_ticket` / `ticket` / `reset`)
POST   /sync/{m}/print-host                      → the shop's print server: where it listens
                                                    on the LAN (heartbeat cadence)
POST   /sync/{m}/print-jobs                      → relay a ticket to a cloud printer's host,
                                                    or to the shop's print server
GET    /sync/{m}/print-jobs/pending              → jobs this till prints (handed out)
POST   /sync/{m}/print-jobs/{id}/ack             → done / failed
GET    /sync/{m}/print-jobs/status?ids=a,b       → the sender's view of its jobs

Every configuration write wakes the shop's tills after the commit (Ably `settings`,
reason `printers_updated`); a new job wakes its printing till (Ably `print-job`).
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.schemas.kitchen_printers import (
    CategoryRoutesIn,
    KitchenOptionsIn,
    KitchenPrintersPatch,
    PrinterIn,
    PrintHostIn,
    ProductNoTicketIn,
    PrintHostReportIn,
    PrintJobAckIn,
    PrintJobIn,
    ProductRouteIn,
)
from app.services import printers as K

router = APIRouter(tags=["printers"])


def _shop(db: Session, shop_id: uuid.UUID, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _printer_and_shop(db: Session, printer_id: uuid.UUID, user: User, tenant_id):
    printer = K.get_printer(db, printer_id)
    ensure_same_tenant(printer.tenant_id, tenant_id)
    shop = _shop(db, printer.shop_id, tenant_id)
    K.check_edit(db, user, shop)
    return printer, shop


def _page(db: Session, user: User, shop: Shop) -> dict:
    machines = K.shop_machines(db, shop.id)
    areas = K.shop_areas(db, shop.id)
    by_machine = {m.id: m for m in machines}
    by_area = {a.id: a for a in areas}
    printers = K.shop_printers(db, shop.id)
    # A host till may since have left the shop: still named.
    for p in printers:
        for ident in (p.host_machine_id, p.machine_id):
            if ident is not None and ident not in by_machine:
                other = db.query(POSMachine).filter(POSMachine.id == ident).first()
                if other is not None:
                    by_machine[other.id] = other
    return {
        "shopId": str(shop.id),
        "canEdit": K.can_edit(db, user, shop),
        "printers": [K.printer_out(p, by_machine, by_area) for p in printers],
        "areas": [{"id": str(a.id), "name": a.name} for a in areas],
        "machines": [
            {
                "id": str(m.id),
                "name": K.machine_label(m),
                "areaId": str(m.area_id) if m.area_id else None,
                "hasPrinter": bool(m.has_printer),
            }
            for m in machines
        ],
        "options": K.options_out(db, shop),
        "printHost": K.print_host_out(db, shop),
    }


def _config_changed(db: Session, shop: Shop, background_tasks: BackgroundTasks, targets=None) -> None:
    targets = targets if targets is not None else K.shop_targets(db, shop.id)
    db.commit()
    background_tasks.add_task(K.publish_config_notify, targets)


@router.get("/shops/{shop_id}/printers")
def list_printers(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    page = _page(db, current_user, shop)
    db.commit()  # the built-in option parameters, if this created them
    return page


@router.post("/shops/{shop_id}/printers", status_code=status.HTTP_201_CREATED)
def create_printer(
    shop_id: uuid.UUID,
    body: PrinterIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    printer = K.create_printer(db, shop, body)
    _config_changed(db, shop, background_tasks)
    db.refresh(printer)
    return K.printer_out(printer, {m.id: m for m in K.shop_machines(db, shop.id)},
                         {a.id: a for a in K.shop_areas(db, shop.id)})


@router.put("/printers/{printer_id}")
def update_printer(
    printer_id: uuid.UUID,
    body: PrinterIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    printer, shop = _printer_and_shop(db, printer_id, current_user, active_tenant_id)
    K.apply_printer(db, shop, printer, body)
    _config_changed(db, shop, background_tasks)
    db.refresh(printer)
    return K.printer_out(printer, {m.id: m for m in K.shop_machines(db, shop.id)},
                         {a.id: a for a in K.shop_areas(db, shop.id)})


@router.delete("/printers/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_printer(
    printer_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    printer, shop = _printer_and_shop(db, printer_id, current_user, active_tenant_id)
    K.delete_printer(db, printer)
    _config_changed(db, shop, background_tasks)


@router.post("/printers/{printer_id}/test", status_code=status.HTTP_201_CREATED)
def test_printer(
    printer_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """`409 printer_has_no_till` when no till would print it (no host / no till in scope)."""
    printer, shop = _printer_and_shop(db, printer_id, current_user, active_tenant_id)
    jobs = K.create_test_jobs(db, current_user, printer)
    targets = K.job_targets(db, jobs)
    machines = {m.id: m for m in db.query(POSMachine).filter(
        POSMachine.id.in_([j.target_machine_id for j in jobs])
    ).all()}
    out = [K.job_out(j, machines) for j in jobs]
    db.commit()
    background_tasks.add_task(K.publish_job_notify, targets)
    return {"jobs": out}


@router.get("/printers/{printer_id}/test-jobs")
def list_test_jobs(
    printer_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    printer, _ = _printer_and_shop(db, printer_id, current_user, active_tenant_id)
    jobs = K.test_jobs(db, printer)
    ids = [j.target_machine_id for j in jobs if j.target_machine_id is not None]
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()} if ids else {}
    out = [K.job_out(j, machines) for j in jobs]
    db.commit()
    return {"jobs": out}


@router.get("/shops/{shop_id}/printer-routing")
def get_routing(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    return K.routing_out(db, shop, current_user)


@router.put("/shops/{shop_id}/printer-routing/categories")
def put_category_routes(
    shop_id: uuid.UUID,
    body: CategoryRoutesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    K.set_category_routes(db, shop, body)
    _config_changed(db, shop, background_tasks)
    return K.routing_out(db, shop, current_user)


@router.put("/shops/{shop_id}/printer-routing/products/{product_id}")
def put_product_route(
    shop_id: uuid.UUID,
    product_id: uuid.UUID,
    body: ProductRouteIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """`409 product_no_ticket` for printers while "ללא בון" is on the product."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    K.set_product_route(db, shop, product_id, body)
    _config_changed(db, shop, background_tasks)
    return K.routing_out(db, shop, current_user)


@router.get("/shops/{shop_id}/printer-routing/products/{product_id}")
def get_product_route(
    shop_id: uuid.UUID,
    product_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The product form's section: its own setting and what its category gives it now."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    return K.target_route(db, shop, "product", product_id, user=current_user)


# ── The product itself, in every shop ("ללא בון", "אפס להגדרת המחלקה") ─────────


def _product_for(db: Session, product_id: uuid.UUID, tenant_id):
    product = K.canonical_product(db, product_id)
    ensure_same_tenant(product.tenant_id, tenant_id)
    return product


def _state(db: Session, user: User, product, shop_id: Optional[uuid.UUID], tenant_id) -> dict:
    """The product's state, with one shop's part when that shop is the caller's to read."""
    shop = None
    if shop_id is not None:
        candidate = _shop(db, shop_id, tenant_id)
        if K.can_edit(db, user, candidate):
            shop = candidate
    return K.product_state(db, product, shop, user=user)


def _check_product_write(db: Session, user: User, product) -> None:
    """The product form's own rule: whoever may edit the product may change it everywhere."""
    if not K.can_edit_product(db, user, product):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


@router.get("/products/{product_id}/kitchen-printers")
def get_product_kitchen(
    product_id: uuid.UUID,
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    `{productId, noTicket, overrideShops: [{shopId, shopName, mode, printerIds,
    printerNames}], canEditProduct, …}`; with `shopId`, also that shop's `mode`,
    `printerIds`, inherited printers, `printers` and where it prints now (`effective`).
    For whoever may edit the product, or manage the shop asked about.
    """
    product = _product_for(db, product_id, active_tenant_id)
    if shop_id is not None:
        K.check_read(db, current_user, _shop(db, shop_id, active_tenant_id))
    elif not K.can_edit_product(db, current_user, product):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return _state(db, current_user, product, shop_id, active_tenant_id)


@router.put("/products/{product_id}/kitchen-printers/no-ticket")
def put_product_no_ticket(
    product_id: uuid.UUID,
    body: ProductNoTicketIn,
    background_tasks: BackgroundTasks,
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "ללא בון": `noTicket: true` — no kitchen ticket for the product in any shop (its rows in
    every shop go too); `false` — back to its category. Every till of the tenant is told.
    """
    product = _product_for(db, product_id, active_tenant_id)
    _check_product_write(db, current_user, product)
    targets = K.set_no_ticket(db, product, body.no_ticket, user_id=current_user.id)
    db.commit()
    background_tasks.add_task(K.publish_config_notify, targets)
    return _state(db, current_user, product, shop_id, active_tenant_id)


@router.post("/products/{product_id}/kitchen-printers/reset")
def reset_product_kitchen(
    product_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"אפס להגדרת המחלקה": every product-level setting in every shop removed (and "ללא בון")."""
    product = _product_for(db, product_id, active_tenant_id)
    _check_product_write(db, current_user, product)
    targets = K.reset_product(db, product)
    db.commit()
    background_tasks.add_task(K.publish_config_notify, targets)
    return _state(db, current_user, product, shop_id, active_tenant_id)


@router.get("/shops/{shop_id}/printer-routing/categories/{category_id}")
def get_category_route(
    shop_id: uuid.UUID,
    category_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    return K.target_route(db, shop, "category", category_id)


@router.put("/shops/{shop_id}/printer-routing/categories/{category_id}")
def put_category_route(
    shop_id: uuid.UUID,
    category_id: uuid.UUID,
    body: KitchenPrintersPatch,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The category form's picker: inherit (its parent) / none / exactly these printers."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    K.apply_patch(db, shop, "category", category_id, body)
    _config_changed(db, shop, background_tasks)
    return K.target_route(db, shop, "category", category_id)


@router.put("/shops/{shop_id}/print-host")
def put_print_host(
    shop_id: uuid.UUID,
    body: PrintHostIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's print server ("שרת הדפסות"): `printHostTill` on that till only; null = none."""
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    targets = K.set_print_host(db, shop, body.machine_id)
    _config_changed(db, shop, background_tasks, targets)
    return {"printHost": K.print_host_out(db, shop)}


@router.put("/shops/{shop_id}/printer-options")
def put_options(
    shop_id: uuid.UUID,
    body: KitchenOptionsIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    targets = K.set_options(db, shop, body)
    _config_changed(db, shop, background_tasks, targets)
    return K.options_out(db, shop)


# ── The till's side ───────────────────────────────────────────────────────────


@router.get("/sync/{machine_id}/printers")
def get_own_printers(
    machine_id: str,
    etag: Optional[str] = Query(None),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    `{"syncType": "full"|"unchanged", "etag", "serverTime", "machineId", "printers": [...],
    "categoryRoutes": {categoryId: [printerId]}, "productRoutes": {productId: [printerId]},
    "options": {"kitchenTicketsOnSale", "kitchenTicketsOnTill"}, "hostsRelay"}`.

    Category routes are already inherited down the tree and narrowed to this till's
    printers; a product's `[]` is "no ticket". `isHost` printers are printed by this till
    itself (by `hostConnection`); `inScope: false` ones are listed only for that.
    """
    payload = K.sync_response(db, machine, etag)
    db.commit()
    return payload


def _till_shop(db: Session, machine: POSMachine) -> Shop:
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    return shop


@router.get("/sync/{machine_id}/products/{product_id}/kitchen-printers")
def get_till_product_printers(
    machine_id: str,
    product_id: uuid.UUID,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    The till's product dialog: the shop's printers, the product's own setting and what
    its category gives it. Written back through `PUT /sync/{m}/products/{id}` with
    `kitchenPrinters`.
    """
    return K.target_route(db, _till_shop(db, machine), "product", product_id, machine=machine)


@router.get("/sync/{machine_id}/categories/{category_id}/kitchen-printers")
def get_till_category_printers(
    machine_id: str,
    category_id: uuid.UUID,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    return K.target_route(db, _till_shop(db, machine), "category", category_id)


@router.post("/sync/{machine_id}/print-host")
def report_print_host(
    machine_id: str,
    body: PrintHostReportIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    The shop's print server reports where it listens on the LAN (its heartbeat cadence).
    The other tills learn it from `GET /sync/{m}/printers` (`printHost`).
    """
    out = K.report_print_host(db, machine, body.lan_address, body.port)
    db.commit()
    return out


@router.post("/sync/{machine_id}/print-jobs", status_code=status.HTTP_201_CREATED)
def post_print_job(
    machine_id: str,
    body: PrintJobIn,
    background_tasks: BackgroundTasks,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Idempotent by `id`. `422 printer_not_relayed`, `409 printer_has_no_host`."""
    job, created = K.create_job(db, machine, body)
    targets = K.job_targets(db, [job]) if created else []
    out = K.job_out(job)
    db.commit()
    if targets:
        background_tasks.add_task(K.publish_job_notify, targets)
    return out


@router.get("/sync/{machine_id}/print-jobs/pending")
def get_pending_print_jobs(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    `{"jobs": [{id, kind, printerId, printer: {connection…}, ticket, createdAt, expiresAt}],
    "scan": {id, requestedAt, expiresAt} | null}` — `scan`: the dashboard asked this till to
    scan its LAN for printers (app/services/printer_discovery.py), handed out now.
    """
    from app.services.printer_discovery import take_scan_request

    jobs = K.pending_jobs(db, machine)
    scan = take_scan_request(db, machine)
    db.commit()
    return {"jobs": jobs, "scan": scan}


@router.post("/sync/{machine_id}/print-jobs/{job_id}/ack")
def ack_print_job(
    machine_id: str,
    job_id: str,
    body: PrintJobAckIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    job = K.ack_job(db, machine, job_id, body)
    out = K.job_out(job)
    db.commit()
    return out


@router.get("/sync/{machine_id}/print-jobs/status")
def get_print_job_statuses(
    machine_id: str,
    ids: str = Query(""),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = K.job_statuses(db, machine, ids.split(",") if ids else [])
    db.commit()
    return {"jobs": out}


# ── Kitchen stations ("תחנות") ────────────────────────────────────────────────


class StationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(..., min_length=1, max_length=60)
    sort_order: int = Field(0, alias="sortOrder")


class StationPrintersIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    printer_ids: List[uuid.UUID] = Field(default_factory=list, alias="printerIds")


class StationTargetIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    target_type: str = Field(..., alias="targetType", pattern="^(category|product)$")
    target_id: uuid.UUID = Field(..., alias="targetId")
    #: Null clears the target's station.
    station_id: Optional[uuid.UUID] = Field(None, alias="stationId")


def _stations_changed(db: Session, tenant_id, background_tasks: BackgroundTasks) -> None:
    targets = K.tenant_targets(db, tenant_id)
    db.commit()
    background_tasks.add_task(K.publish_config_notify, targets)


@router.get("/kitchen-stations")
def list_stations(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if shop_id is not None:
        K.check_read(db, current_user, _shop(db, shop_id, active_tenant_id))
    elif current_user.role not in K.EDIT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    out = K.stations_out(db, active_tenant_id, shop_id)
    out["canEdit"] = current_user.role in K.STATION_EDIT_ROLES
    return out


@router.post("/kitchen-stations", status_code=status.HTTP_201_CREATED)
def create_station(
    body: StationIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    K.check_station_edit(current_user)
    station = K.save_station(db, active_tenant_id, None, body.name, body.sort_order)
    _stations_changed(db, active_tenant_id, background_tasks)
    return {"id": str(station.id), "name": station.name, "sortOrder": station.sort_order}


@router.put("/kitchen-stations/{station_id}")
def update_station(
    station_id: uuid.UUID,
    body: StationIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    K.check_station_edit(current_user)
    station = K.save_station(db, active_tenant_id, station_id, body.name, body.sort_order)
    _stations_changed(db, active_tenant_id, background_tasks)
    return {"id": str(station.id), "name": station.name, "sortOrder": station.sort_order}


@router.delete("/kitchen-stations/{station_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_station(
    station_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    K.check_station_edit(current_user)
    station = K.get_station(db, active_tenant_id, station_id)
    # Its printers and assignments go with it (ON DELETE CASCADE); deleted explicitly too,
    # for a database that does not enforce foreign keys.
    db.query(K.KitchenStationPrinter).filter(K.KitchenStationPrinter.station_id == station.id).delete()
    db.query(K.KitchenStationTarget).filter(K.KitchenStationTarget.station_id == station.id).delete()
    db.delete(station)
    _stations_changed(db, active_tenant_id, background_tasks)


@router.put("/shops/{shop_id}/kitchen-stations/{station_id}/printers")
def put_station_printers(
    shop_id: uuid.UUID,
    station_id: uuid.UUID,
    body: StationPrintersIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, active_tenant_id)
    K.check_edit(db, current_user, shop)
    station = K.get_station(db, active_tenant_id, station_id)
    K.set_station_printers(db, shop, station, body.printer_ids)
    _config_changed(db, shop, background_tasks)
    return K.stations_out(db, active_tenant_id, shop.id)


@router.put("/kitchen-station-targets")
def put_station_target(
    body: StationTargetIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    K.check_station_edit(current_user)
    K.set_station_target(db, active_tenant_id, body.target_type, body.target_id, body.station_id)
    _stations_changed(db, active_tenant_id, background_tasks)
    return K.stations_out(db, active_tenant_id)
