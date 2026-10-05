"""
The header of a Z (נספח א׳ §4): who issued it — frozen when the Z is built.

A Z is a fiscal document. Built from live settings at read time, a company rename or a
new address would silently rewrite every Z the shop ever filed, so the header is taken
once, at build, and stored on the row (`z_reports.header`). Readers serve that
snapshot and nothing else.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services.settings_merge import build_business_info, merge_all_settings_layers


def snapshot_header(
    db: Session,
    shop: Optional[Shop],
    *,
    area: Optional[ShopArea] = None,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """
    The header as of now, or None when there is no shop to say who issued it.

    `areaId` / `areaName` name the area a Z was started for — null for a whole-shop or
    hand-picked Z — frozen like the rest, so renaming the area later does not rename
    the Zs already filed under it.
    """
    if shop is None:
        return None
    captured = (now or datetime.now(timezone.utc)).isoformat()
    area_fields = {
        "areaId": str(area.id) if area is not None else None,
        "areaName": area.name if area is not None else None,
    }
    company = db.query(Company).filter(Company.id == shop.company_id).first()
    if company is None:
        return {
            "shopId": str(shop.id), "shopName": shop.name, **area_fields, "capturedAt": captured,
        }
    tenant = (
        db.query(Tenant).filter(Tenant.id == company.tenant_id).first()
        if company.tenant_id else None
    )
    info = build_business_info(company, shop, merge_all_settings_layers(company, shop, tenant))
    return {
        "businessName": info.company_name,
        "vatNumber": info.vat_number or None,
        "companyRegNumber": info.company_reg_number,
        "companyId": str(company.id),
        "address": info.company_address or None,
        "addressNumber": info.company_address_number or None,
        "city": info.company_city or None,
        "zip": info.company_zip or None,
        "branchId": info.branch_id,
        # "סוג עוסק" as of the build (docs/SPEC_BUSINESS_TYPE.md): an exempt dealer's Z
        # prints "עוסק פטור — ללא מע״מ", and a later change does not rewrite it.
        "dealerType": info.dealer_type,
        "shopId": str(shop.id),
        "shopName": shop.name,
        **area_fields,
        "capturedAt": captured,
    }
