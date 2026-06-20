"""Validate shop ↔ company scope."""
import uuid

from sqlalchemy.orm import Session

from app.models.shop import Shop
from app.models.company import Company


def shop_belongs_to_company(db: Session, shop_id: uuid.UUID, company_id: uuid.UUID) -> bool:
    row = (
        db.query(Shop.id)
        .join(Company, Shop.company_id == Company.id)
        .filter(Shop.id == shop_id, Company.id == company_id)
        .first()
    )
    return row is not None
