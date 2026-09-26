"""
Lock or unlock a product per company, per shop and per till — and show the result.

    GET /products/{id}/availability                          → the whole picture
    PUT /products/{id}/availability/companies/{company_id}   {"isAvailable": true|false|null}
    PUT /products/{id}/availability/shops/{shop_id}          {"isAvailable": true|false|null}
    PUT /products/{id}/availability/machines/{machine_id}    {"isAvailable": true|false|null}

`null` clears a level back to inherit. The rule itself — nearest level wins, and the
only company consulted is the shop's own — is in `app/services/product_availability.py`;
this module checks who may write, writes, and wakes the tills the write reaches.

Permissions reuse the existing checks and refuse (403) before anything is written:

* company level — whoever may write that company's settings: tenant-wide roles, or a
  company manager whose scope covers the company (`_check_company_settings_write`). A
  shop manager's `company_id` does not make them a company-level actor.
* shop level — the assortment write check (`_check_shop_override_write`).
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
from app.models.product import Product
from app.models.product_availability_override import (
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User
from app.routers.products import _check_product_access, _require_global_catalog_product
from app.routers.settings import _check_company_settings_write
from app.routers.shops import _check_shop_access, _check_shop_override_write
from app.schemas.product_availability import (
    AvailabilitySet,
    AvailabilityWriteResponse,
    CompanyAvailability,
    MachineAvailability,
    ProductAvailabilityResponse,
    ShopAvailability,
)
from app.services import general_item
from app.services import machine_catalog
from app.services import product_availability as availability
from app.services.company_hierarchy import catalog_company_ids
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
        for m in sorted(machines_by_shop.get(str(shop.id), []), key=lambda x: (x.pos_number or "", x.name or "")):
            m_row = machine_levels.get(str(m.id))
            m_value = m_row.is_available if m_row is not None else None
            m_levels = availability.resolve_levels(
                product.is_available, company_value, ovr.is_available, m_value
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
                    **_node(m_levels, Level.MACHINE, m_value),
                )
            )
        node.shops.append(shop_node)

    return ProductAvailabilityResponse(
        product_id=product.id,
        product_available=bool(product.is_available),
        companies=sorted(by_company.values(), key=lambda c: c.company_name or ""),
    )


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
