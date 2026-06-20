"""Auto-assign numeric SKUs per tenant (Sirius-style)."""
from __future__ import annotations

import uuid
from typing import Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.tenant_local_sku_sequence import DEFAULT_SKU_SEQUENCE_START, TenantLocalSkuSequence
from app.models.product import Product

MAX_ALLOC_RETRIES = 3


def compute_initial_next_value(db: Session, tenant_id: uuid.UUID) -> int:
    """Max purely-numeric sku + 1 for tenant, or DEFAULT_SKU_SEQUENCE_START."""
    rows = (
        db.query(Product.sku)
        .filter(Product.tenant_id == tenant_id, Product.sku.op("~")("^[0-9]+$"))
        .all()
    )
    if not rows:
        return DEFAULT_SKU_SEQUENCE_START
    return max(int(r[0]) for r in rows) + 1


def _get_or_create_sequence_row(db: Session, tenant_id: uuid.UUID) -> TenantLocalSkuSequence:
    row = (
        db.query(TenantLocalSkuSequence)
        .filter(TenantLocalSkuSequence.tenant_id == tenant_id)
        .with_for_update()
        .first()
    )
    if row:
        return row
    initial = compute_initial_next_value(db, tenant_id)
    row = TenantLocalSkuSequence(tenant_id=tenant_id, next_value=initial)
    db.add(row)
    db.flush()
    return row


def allocate_sku(db: Session, tenant_id: uuid.UUID) -> str:
    """Return next numeric SKU for tenant; caller must commit in same transaction."""
    for _ in range(MAX_ALLOC_RETRIES):
        row = _get_or_create_sequence_row(db, tenant_id)
        candidate = str(row.next_value)
        row.next_value = row.next_value + 1
        db.flush()
        exists = (
            db.query(Product.id)
            .filter(Product.tenant_id == tenant_id, Product.sku == candidate)
            .first()
        )
        if not exists:
            return candidate
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Could not allocate a unique auto SKU; try again or use manual SKU",
    )


def _normalize_sku(sku: str | None) -> str | None:
    if sku is None:
        return None
    stripped = sku.strip()
    return stripped if stripped else None


def resolve_sku_for_create(
    db: Session,
    tenant_id: uuid.UUID,
    sku: str | None,
) -> Tuple[str, bool]:
    """
    Returns (final_sku, sku_auto_assigned).
    Empty/omitted sku → auto allocate; provided sku → manual (unique check).
    """
    normalized = _normalize_sku(sku)
    if normalized is None:
        return allocate_sku(db, tenant_id), True

    if db.query(Product.id).filter(Product.tenant_id == tenant_id, Product.sku == normalized).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="SKU already exists for this tenant",
        )
    return normalized, False
