"""Validate shop ↔ merchant scope (company belongs to merchant)."""
import uuid

from sqlalchemy.orm import Session

from app.models.shop import Shop
from app.models.company import Company


def shop_belongs_to_merchant(db: Session, shop_id: uuid.UUID, merchant_id: uuid.UUID) -> bool:
    row = (
        db.query(Shop.id)
        .join(Company, Shop.company_id == Company.id)
        .filter(Shop.id == shop_id, Company.merchant_id == merchant_id)
        .first()
    )
    return row is not None
