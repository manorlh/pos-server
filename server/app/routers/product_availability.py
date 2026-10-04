"""
Lock or unlock a product per company, per shop, per area and per till — and show the result.

    GET /products/{id}/availability                          → the whole picture
    PUT /products/{id}/availability/companies/{company_id}   {"isAvailable": true|false|null}
    PUT /products/{id}/availability/shops/{shop_id}          {"isAvailable": true|false|null}
    PUT /products/{id}/availability/areas/{area_id}          {"isAvailable": true|false|null}
    PUT /products/{id}/availability/machines/{machine_id}    {"isAvailable": true|false|null}

`null` clears a level back to inherit. The rule itself — nearest level wins, and the
only company consulted is the shop's own — is in `app/services/product_availability.py`;
this module checks who may write, writes, and wakes the tills the write reaches.

Permissions reuse the existing checks and refuse (403) before anything is written:

* company level — whoever may write that company's settings: tenant-wide roles, or a
  company manager whose scope covers the company (`_check_company_settings_write`). A
  shop manager's `company_id` does not make them a company-level actor.
* shop level — the assortment write check (`_check_shop_override_write`).
* area level — the assortment write check on the area's shop.
* machine level — the machine check (`_check_machine_access`) *and* the assortment
  write check on the machine's shop.
"""
from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    _check_machine_access,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
)
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import (
    AreaProductOverride,
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User
from app.routers.products import _check_product_access, _require_global_catalog_product
from app.routers.settings import _check_company_settings_write
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.schemas.product_availability import (
    AreaAvailability,
    AvailabilityException,
    AvailabilitySummaryRequest,
    AvailabilitySummaryResponse,
    AvailabilitySet,
    AvailabilityWriteResponse,
    CompanyAvailability,
    MachineAvailability,
    ProductAvailabilityResponse,
    ProductAvailabilitySummary,
    ShopAvailability,
)
from app.services import general_item
from app.services import machine_catalog
from app.services import product_availability as availability
from app.services.company_hierarchy import catalog_company_ids, catalog_visibility_filter
from app.services.product_availability import Level
from app.services.product_shop_scope import scope_company_allowed

router = APIRouter(prefix="/products", tags=["product-availability"])


def _allowed(check, *args) -> bool:
    try:
        check(*args)
    except HTTPException:
        return False
    return True


def _global_product_or_404(db: Session, product_id, active_tenant_id) -> Product:
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, active_tenant_id)
    _require_global_catalog_product(product)
    return product


def _check_product_visible(user: User, product: Product, db: Session) -> None:
    """
    May this user see the product at all? The product edit check, or — for a parent
    company's product sold in the user's own company — the catalog list's own rule
    (`catalog_company_ids`: a company sees its ancestors' catalog). Without the second
    half a sub-company's manager could set their company's lock but never see it.
    """
    if _allowed(_check_product_access, user, product, db):
        return
    ids = catalog_company_ids(db, user)
    if ids is None or product.company_id is None or any(
        str(i) == str(product.company_id) for i in ids
    ):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _assortment_row(db: Session, shop_id, product_id):
    return (
        db.query(ShopProductOverride)
        .filter(
            ShopProductOverride.shop_id == shop_id,
            ShopProductOverride.global_product_id == product_id,
        )
        .first()
    )


def _node(levels, level: Level, value) -> Dict:
    resolved = levels[level]
    return {
        "value": value,
        "inherited": levels[availability.level_above(level)].available,
        "effective": resolved.available,
        "source": resolved.source.value,
    }


# ── The picture ──────────────────────────────────────────────────────────────


@router.get("/{product_id}/availability", response_model=ProductAvailabilityResponse)
def get_product_availability(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    For every company where the product is sold — the companies of the shops that have
    an assortment row for it — the company's setting, each shop's, and each active
    till's, with the effective value resolved at each. Shops the caller cannot reach
    are left out, like `GET /products/{id}/shops`.
    """
    product = _global_product_or_404(db, product_id, active_tenant_id)
    _check_product_visible(current_user, product, db)

    rows = (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.global_product_id == product.id)
        .all()
    )
    shop_ids = [r.shop_id for r in rows]
    shops = (
        {str(s.id): s for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()}
        if shop_ids
        else {}
    )
    visible = [
        (r, shops[str(r.shop_id)])
        for r in rows
        if str(r.shop_id) in shops and _allowed(_check_shop_access, current_user, shops[str(r.shop_id)], db)
    ]

    # Grouped by each shop's *own* company: that is the only company level that applies
    # in the shop, so it is the only one worth showing above it.
    company_ids = list(
        {
            str(availability.company_level_company_id(s)): availability.company_level_company_id(s)
            for _, s in visible
        }.values()
    )
    companies = (
        {str(c.id): c for c in db.query(Company).filter(Company.id.in_(company_ids)).all()}
        if company_ids
        else {}
    )
    company_levels: Dict[str, CompanyProductOverride] = (
        {
            str(r.company_id): r
            for r in db.query(CompanyProductOverride)
            .filter(
                CompanyProductOverride.product_id == product.id,
                CompanyProductOverride.company_id.in_(company_ids),
            )
            .all()
        }
        if company_ids
        else {}
    )

    visible_shop_ids = [s.id for _, s in visible]
    machines: List[POSMachine] = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id.in_(visible_shop_ids), POSMachine.is_active.is_(True))
        .all()
        if visible_shop_ids
        else []
    )
    machine_levels: Dict[str, MachineProductOverride] = (
        {
            str(r.machine_id): r
            for r in db.query(MachineProductOverride)
            .filter(
                MachineProductOverride.product_id == product.id,
                MachineProductOverride.machine_id.in_([m.id for m in machines]),
            )
            .all()
        }
        if machines
        else {}
    )
    # Each till's own list, for "which tills sell it" — see machine_catalog.
    catalog_rows = (
        {
            str(r.machine_id): r
            for r in db.query(MachineCatalogItem)
            .filter(
                MachineCatalogItem.product_id == product.id,
                MachineCatalogItem.machine_id.in_([m.id for m in machines]),
            )
            .all()
        }
        if machines
        else {}
    )
    machines_by_shop: Dict[str, List[POSMachine]] = {}
    for m in machines:
        machines_by_shop.setdefault(str(m.shop_id), []).append(m)
    # The shops' live areas, and each one's setting. A till's area is always one of
    # its own shop's (`set_machine_shop` clears it on a move).
    areas: List[ShopArea] = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id.in_(visible_shop_ids), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
        if visible_shop_ids
        else []
    )
    area_levels: Dict[str, AreaProductOverride] = (
        {
            str(r.area_id): r
            for r in db.query(AreaProductOverride)
            .filter(
                AreaProductOverride.product_id == product.id,
                AreaProductOverride.area_id.in_([a.id for a in areas]),
            )
            .all()
        }
        if areas
        else {}
    )
    areas_by_shop: Dict[str, List[ShopArea]] = {}
    for a in areas:
        areas_by_shop.setdefault(str(a.shop_id), []).append(a)

    def area_value(area_id):
        row = area_levels.get(str(area_id)) if area_id is not None else None
        return row.is_available if row is not None else None

    by_company: Dict[str, CompanyAvailability] = {}
    for ovr, shop in sorted(visible, key=lambda pair: pair[1].name or ""):
        company_id = availability.company_level_company_id(shop)
        company_row = company_levels.get(str(company_id))
        company_value = company_row.is_available if company_row is not None else None

        node = by_company.get(str(company_id))
        if node is None:
            company = companies.get(str(company_id))
            levels = availability.resolve_levels(product.is_available, company_value)
            node = CompanyAvailability(
                company_id=company_id,
                company_name=company.name if company else None,
                can_edit=company is not None
                and _allowed(_check_company_settings_write, current_user, company, db),
                **_node(levels, Level.COMPANY, company_value),
            )
            by_company[str(company_id)] = node

        shop_levels = availability.resolve_levels(product.is_available, company_value, ovr.is_available)
        shop_can_edit = _allowed(_check_shop_override_write, current_user, shop, db)
        shop_node = ShopAvailability(
            shop_id=shop.id,
            shop_name=shop.name,
            is_listed=bool(ovr.is_listed),
            can_edit=shop_can_edit,
            **_node(shop_levels, Level.SHOP, ovr.is_available),
        )
        for a in areas_by_shop.get(str(shop.id), []):
            a_value = area_value(a.id)
            a_levels = availability.resolve_levels(
                product.is_available, company_value, ovr.is_available, area=a_value
            )
            shop_node.areas.append(
                AreaAvailability(
                    area_id=a.id,
                    name=a.name,
                    can_edit=shop_can_edit,
                    **_node(a_levels, Level.AREA, a_value),
                )
            )
        for m in sorted(machines_by_shop.get(str(shop.id), []), key=lambda x: (x.pos_number or "", x.name or "")):
            m_row = machine_levels.get(str(m.id))
            m_value = m_row.is_available if m_row is not None else None
            m_levels = availability.resolve_levels(
                product.is_available, company_value, ovr.is_available, m_value,
                area=area_value(m.area_id),
            )
            shop_node.machines.append(
                MachineAvailability(
                    machine_id=m.id,
                    name=m.name,
                    pos_number=m.pos_number,
                    can_edit=shop_can_edit and _allowed(_check_machine_access, current_user, m, db),
                    catalog_mode=machine_catalog.mode_of(m),
                    in_catalog=machine_catalog.on_till(
                        machine_catalog.mode_of(m),
                        bool(catalog_rows.get(str(m.id)) and catalog_rows[str(m.id)].is_included),
                        general_item.is_general(product),
                    ),
                    area_id=m.area_id,
                    **_node(m_levels, Level.MACHINE, m_value),
                )
            )
        node.shops.append(shop_node)

    return ProductAvailabilityResponse(
        product_id=product.id,
        product_available=bool(product.is_available),
        companies=sorted(by_company.values(), key=lambda c: c.company_name or ""),
    )


# ── A page of products, one line each ────────────────────────────────────────

#: How many override examples each summary carries.
_SUMMARY_EXCEPTIONS = 5


@router.post("/availability-summary", response_model=AvailabilitySummaryResponse)
def summarize_product_availability(
    body: AvailabilitySummaryRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "Active in 3/4 shops · locked on till 4" for every product on a page of the list.

    The same tree and the same rule as `GET /products/{id}/availability`, counted rather
    than drawn, for many products at once: a fixed number of queries whatever the page
    size. Products the caller cannot see in the list, and local copies (which have no
    tree), are left out; so are shops the caller cannot reach, as in the picture.
    """
    ids = list(dict.fromkeys(body.product_ids))
    if not ids:
        return AvailabilitySummaryResponse(items=[])

    query = db.query(Product).filter(
        Product.id.in_(ids),
        Product.tenant_id == active_tenant_id,
        Product.pos_machine_id.is_(None),
        Product.catalog_level == CatalogLevel.GLOBAL,
    )
    visible_filter = catalog_visibility_filter(db, current_user, Product)
    if visible_filter is not None:
        query = query.filter(visible_filter)
    products = query.all()
    if not products:
        return AvailabilitySummaryResponse(items=[])
    product_ids = [p.id for p in products]

    rows = (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.global_product_id.in_(product_ids))
        .all()
    )
    shop_ids = list({str(r.shop_id): r.shop_id for r in rows}.values())
    shops = (
        {str(s.id): s for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()}
        if shop_ids
        else {}
    )
    shops = {
        sid: s for sid, s in shops.items() if _allowed(_check_shop_access, current_user, s, db)
    }
    visible_shop_ids = [s.id for s in shops.values()]
    company_ids = list(
        {
            str(availability.company_level_company_id(s)): availability.company_level_company_id(s)
            for s in shops.values()
        }.values()
    )
    companies = (
        {str(c.id): c for c in db.query(Company).filter(Company.id.in_(company_ids)).all()}
        if company_ids
        else {}
    )

    def _by_pair(model, owner_col, owner_ids):
        if not owner_ids:
            return {}
        return {
            (str(getattr(r, owner_col)), str(r.product_id)): r
            for r in db.query(model)
            .filter(
                getattr(model, owner_col).in_(owner_ids),
                model.product_id.in_(product_ids),
            )
            .all()
        }

    company_levels = _by_pair(CompanyProductOverride, "company_id", company_ids)
    areas: List[ShopArea] = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id.in_(visible_shop_ids), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
        if visible_shop_ids
        else []
    )
    area_levels = _by_pair(AreaProductOverride, "area_id", [a.id for a in areas])
    machines: List[POSMachine] = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id.in_(visible_shop_ids), POSMachine.is_active.is_(True))
        .all()
        if visible_shop_ids
        else []
    )
    machine_levels = _by_pair(MachineProductOverride, "machine_id", [m.id for m in machines])
    selected = [m.id for m in machines if machine_catalog.mode_of(m) == machine_catalog.MODE_SELECTED]
    catalog_rows = _by_pair(MachineCatalogItem, "machine_id", selected)

    areas_by_shop: Dict[str, List[ShopArea]] = {}
    for a in areas:
        areas_by_shop.setdefault(str(a.shop_id), []).append(a)
    machines_by_shop: Dict[str, List[POSMachine]] = {}
    for m in sorted(machines, key=lambda x: (x.pos_number or "", x.name or "")):
        machines_by_shop.setdefault(str(m.shop_id), []).append(m)
    rows_by_product: Dict[str, List[ShopProductOverride]] = {}
    for r in rows:
        if str(r.shop_id) in shops:
            rows_by_product.setdefault(str(r.global_product_id), []).append(r)

    def value_of(table, owner_id, product_id):
        row = table.get((str(owner_id), str(product_id))) if owner_id is not None else None
        return row.is_available if row is not None else None

    out: List[ProductAvailabilitySummary] = []
    for product in products:
        pid = str(product.id)
        summary = ProductAvailabilitySummary(
            product_id=product.id, product_available=bool(product.is_available)
        )
        found: List[AvailabilityException] = []
        seen_companies = set()
        product_rows = sorted(
            rows_by_product.get(pid, []), key=lambda r: shops[str(r.shop_id)].name or ""
        )
        for ovr in product_rows:
            shop = shops[str(ovr.shop_id)]
            listed = bool(ovr.is_listed)
            company_id = availability.company_level_company_id(shop)
            company_value = value_of(company_levels, company_id, product.id)
            if str(company_id) not in seen_companies:
                seen_companies.add(str(company_id))
                if company_value is not None and company_value != bool(product.is_available):
                    company = companies.get(str(company_id))
                    found.append(
                        AvailabilityException(
                            level="company",
                            id=company_id,
                            name=company.name if company else None,
                            value=company_value,
                        )
                    )
            levels = availability.resolve_levels(product.is_available, company_value, ovr.is_available)
            shop_effective = levels[Level.SHOP].available
            summary.shop_count += 1
            if listed and shop_effective:
                summary.active_shop_count += 1
            if ovr.is_available is not None and ovr.is_available != levels[Level.COMPANY].available:
                found.append(
                    AvailabilityException(
                        level="shop", id=shop.id, name=shop.name, value=ovr.is_available
                    )
                )
            for a in areas_by_shop.get(str(shop.id), []):
                a_value = value_of(area_levels, a.id, product.id)
                a_levels = availability.resolve_levels(
                    product.is_available, company_value, ovr.is_available, area=a_value
                )
                summary.area_count += 1
                if listed and a_levels[Level.AREA].available:
                    summary.active_area_count += 1
                if a_value is not None and a_value != shop_effective:
                    found.append(
                        AvailabilityException(
                            level="area", id=a.id, name=a.name, shop_name=shop.name, value=a_value
                        )
                    )
            for m in machines_by_shop.get(str(shop.id), []):
                m_value = value_of(machine_levels, m.id, product.id)
                m_levels = availability.resolve_levels(
                    product.is_available, company_value, ovr.is_available, m_value,
                    area=value_of(area_levels, m.area_id, product.id),
                )
                catalog_row = catalog_rows.get((str(m.id), pid))
                in_catalog = machine_catalog.on_till(
                    machine_catalog.mode_of(m),
                    bool(catalog_row and catalog_row.is_included),
                    general_item.is_general(product),
                )
                summary.machine_count += 1
                if listed and in_catalog and m_levels[Level.MACHINE].available:
                    summary.active_machine_count += 1
                if m_value is not None and m_value != m_levels[Level.AREA].available:
                    found.append(
                        AvailabilityException(
                            level="machine",
                            id=m.id,
                            name=m.name,
                            shop_name=shop.name,
                            pos_number=m.pos_number,
                            value=m_value,
                        )
                    )
        summary.company_count = len(seen_companies)
        summary.exception_count = len(found)
        # Locks first: "locked on till 4" is what the list has to say out loud.
        found.sort(key=lambda e: e.value)
        summary.exceptions = found[:_SUMMARY_EXCEPTIONS]
        out.append(summary)

    return AvailabilitySummaryResponse(items=out)


# ── Setting a level ──────────────────────────────────────────────────────────


@router.put(
    "/{product_id}/availability/companies/{company_id}",
    response_model=AvailabilityWriteResponse,
)
def set_company_availability(
    product_id: str,
    company_id: str,
    body: AvailabilitySet,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The company's own setting. Applies in its own shops, never a sub-company's."""
    product = _global_product_or_404(db, product_id, active_tenant_id)
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_settings_write(current_user, company, db)
    if str(company.tenant_id) != str(product.tenant_id) or not scope_company_allowed(
        db, product, company.id
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This product cannot be sold in that company's shops",
        )

    availability.set_company_availability(db, company.id, product.id, body.is_available)
    db.commit()
    availability.notify_company_change(db, company.id, product.id)
    return AvailabilityWriteResponse(level="company", value=body.is_available)


@router.put(
    "/{product_id}/availability/shops/{shop_id}",
    response_model=AvailabilityWriteResponse,
)
def set_shop_availability(
    product_id: str,
    shop_id: str,
    body: AvailabilitySet,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's own setting, on its assortment row. The product must be sold there."""
    product = _global_product_or_404(db, product_id, active_tenant_id)
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)
    row = _assortment_row(db, shop.id, product.id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment"
        )

    availability.set_shop_availability(row, body.is_available)
    db.commit()
    availability.notify_shop_change(db, shop.id)
    return AvailabilityWriteResponse(level="shop", value=body.is_available)


@router.put(
    "/{product_id}/availability/areas/{area_id}",
    response_model=AvailabilityWriteResponse,
)
def set_area_availability(
    product_id: str,
    area_id: str,
    body: AvailabilitySet,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A point of sale's setting, for every till standing in it. Its shop must sell the product."""
    product = _global_product_or_404(db, product_id, active_tenant_id)
    area = db.query(ShopArea).filter(ShopArea.id == area_id).first()
    if not area:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
    ensure_same_tenant(area.tenant_id, active_tenant_id)
    shop = db.query(Shop).filter(Shop.id == area.shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_override_write(current_user, shop, db)
    if _assortment_row(db, shop.id, product.id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment"
        )

    availability.set_area_availability(db, area.id, product.id, body.is_available)
    db.commit()
    availability.notify_area_change(db, area.id)
    return AvailabilityWriteResponse(level="area", value=body.is_available)


@router.put(
    "/{product_id}/availability/machines/{machine_id}",
    response_model=AvailabilityWriteResponse,
)
def set_machine_availability(
    product_id: str,
    machine_id: str,
    body: AvailabilitySet,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One till's own setting. The till's shop must sell the product."""
    product = _global_product_or_404(db, product_id, active_tenant_id)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, active_tenant_id)
    if machine.shop_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop"
        )
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if not shop:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop"
        )
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_machine_access(current_user, machine, db)
    _check_shop_override_write(current_user, shop, db)
    if _assortment_row(db, shop.id, product.id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment"
        )

    availability.set_machine_availability(db, machine.id, product.id, body.is_available)
    db.commit()
    availability.notify_machine_change(machine)
    return AvailabilityWriteResponse(level="machine", value=body.is_available)
