"""
Company and shop numbers: companies 1, 2, 3 in a tenant; shops 1, 2 in each company.

The till shows "חברה #N · סניף #M · קופה #K" (`GET /machines/me`), so these follow the
rules of register numbers (`register_number.py`):

* **Never reused.** Drawn from a counter (`org_number_sequences`) that only moves
  forward. A deleted company or shop leaves its number spent.
* **Rollback-safe.** The counter row is incremented under `SELECT … FOR UPDATE` in the
  transaction that creates the company or shop; a create that fails takes its number back.
* **Belongs to the current owner.** A shop's number is its company's: a shop moved to
  another company gives its number up (spent in the old company) and draws the new
  company's next one, as a till that changes shop does — `set_shop_company`. Renaming
  changes nothing.

A company with no tenant has no run to draw from, and no number.
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.org_number_sequence import (
    DEFAULT_ORG_NUMBER_START,
    KIND_COMPANY,
    KIND_SHOP,
    OrgNumberSequence,
)
from app.models.shop import Shop


def _highest_issued(db: Session, kind: str, owner_id) -> int:
    """Where a run with no counter row continues: past whatever number is already on a row."""
    if kind == KIND_COMPANY:
        top = db.query(func.max(Company.company_number)).filter(Company.tenant_id == owner_id).scalar()
    else:
        top = db.query(func.max(Shop.shop_number)).filter(Shop.company_id == owner_id).scalar()
    return int(top) + 1 if top else DEFAULT_ORG_NUMBER_START


def _locked_counter(db: Session, kind: str, owner_id) -> OrgNumberSequence:
    """
    The run's counter row, locked for the rest of the transaction.

    A missing row is inserted in a savepoint; losing that race to a concurrent create
    (the primary key) rolls back only the savepoint, and both read the row back under the
    lock, so they serialise on it instead of one of them failing.
    """
    def locked():
        return (
            db.query(OrgNumberSequence)
            .filter(OrgNumberSequence.kind == kind, OrgNumberSequence.owner_id == owner_id)
            .with_for_update()
            .first()
        )

    row = locked()
    if row is not None:
        return row
    start = _highest_issued(db, kind, owner_id)
    try:
        with db.begin_nested():
            db.add(OrgNumberSequence(kind=kind, owner_id=owner_id, next_value=start))
    except IntegrityError:
        pass
    return locked()


def _draw(db: Session, kind: str, owner_id) -> int:
    row = _locked_counter(db, kind, owner_id)
    number = int(row.next_value)
    row.next_value = number + 1
    return number


def assign_company_number(db: Session, company: Company) -> Optional[int]:
    """Give `company` its tenant's next number, or keep the one it has. The caller commits."""
    if company.company_number is not None:
        return company.company_number
    if company.tenant_id is None:
        return None
    company.company_number = _draw(db, KIND_COMPANY, company.tenant_id)
    db.flush()
    return company.company_number


def assign_shop_number(db: Session, shop: Shop) -> Optional[int]:
    """Give `shop` its company's next number, or keep the one it has. The caller commits."""
    if shop.shop_number is not None:
        return shop.shop_number
    if shop.company_id is None:
        return None
    shop.shop_number = _draw(db, KIND_SHOP, shop.company_id)
    db.flush()
    return shop.shop_number


def set_shop_company(db: Session, shop: Shop, company_id: uuid.UUID) -> Optional[int]:
    """
    Move `shop` to `company_id` and settle its number: the new company's next one, the
    old one left spent. Moving it to the company it is already in changes nothing.
    """
    if str(shop.company_id) != str(company_id):
        shop.company_id = company_id
        shop.shop_number = None
    return assign_shop_number(db, shop)


def peek_next_shop_number(db: Session, company_id) -> int:
    """The number the company's next shop would get, without taking it."""
    row = (
        db.query(OrgNumberSequence)
        .filter(OrgNumberSequence.kind == KIND_SHOP, OrgNumberSequence.owner_id == company_id)
        .first()
    )
    return int(row.next_value) if row is not None else _highest_issued(db, KIND_SHOP, company_id)
