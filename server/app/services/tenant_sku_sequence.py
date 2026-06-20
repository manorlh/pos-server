"""Auto-assign tenant-wide global SKUs for cross-merchant search."""
from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.product import CatalogLevel, Product
from app.models.tenant_sku_sequence import DEFAULT_GLOBAL_SKU_SEQUENCE_START, TenantSkuSequence

MAX_ALLOC_RETRIES = 3


def compute_initial_global_next_value(db: Session, tenant_id: uuid.UUID) -> int:
    rows = (
        db.query(Product.global_sku)
        .filter(
            Product.tenant_id == tenant_id,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.global_sku.isnot(None),
            Product.global_sku.op("~")("^[0-9]+$"),
        )
        .all()
    )
    if not rows:
        return DEFAULT_GLOBAL_SKU_SEQUENCE_START
    return max(int(r[0]) for r in rows) + 1


def _get_or_create_tenant_sequence_row(db: Session, tenant_id: uuid.UUID) -> TenantSkuSequence:
    row = (
        db.query(TenantSkuSequence)
        .filter(TenantSkuSequence.tenant_id == tenant_id)
        .with_for_update()
        .first()
    )
    if row:
        return row
    initial = compute_initial_global_next_value(db, tenant_id)
    row = TenantSkuSequence(tenant_id=tenant_id, next_value=initial)
    db.add(row)
    db.flush()
    return row


def allocate_global_sku(db: Session, tenant_id: uuid.UUID) -> str:
    """Return next tenant-wide global SKU; caller must commit in same transaction."""
    for _ in range(MAX_ALLOC_RETRIES):
        row = _get_or_create_tenant_sequence_row(db, tenant_id)
        candidate = str(row.next_value)
        row.next_value = row.next_value + 1
        db.flush()
        exists = (
            db.query(Product.id)
            .filter(
                Product.tenant_id == tenant_id,
                Product.catalog_level == CatalogLevel.GLOBAL,
                Product.global_sku == candidate,
            )
            .first()
        )
        if not exists:
            return candidate
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Could not allocate a unique global SKU; try again",
    )
