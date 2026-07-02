"""Dashboard read endpoints for transactions (Clerk-user JWT)."""
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.transaction import Transaction
from app.models.user import User
from app.services.scoping import scope_transactions_by_user
from app.schemas.transaction import (
    TransactionListItem,
    TransactionListResponse,
    TransactionOut,
)


router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Transaction).filter(Transaction.tenant_id == active_tenant_id)
    query = scope_transactions_by_user(query, current_user, db)
    if query is None:
        return TransactionListResponse(page=page, page_size=page_size, total=0, items=[])

    if machine_id:
        query = query.filter(Transaction.machine_id == machine_id)
    if shop_id:
        query = query.filter(Transaction.shop_id == shop_id)

    if from_date is None and to_date is None:
        from_date = (datetime.now(timezone.utc) - timedelta(days=30)).date()

    if from_date is not None:
        query = query.filter(Transaction.created_at >= datetime.combine(from_date, time.min, tzinfo=timezone.utc))
    if to_date is not None:
        query = query.filter(Transaction.created_at < datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=timezone.utc))

    total = query.count()
    rows = (
        query.order_by(Transaction.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return TransactionListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=[TransactionListItem.model_validate(r) for r in rows],
    )


@router.get("/{transaction_id}", response_model=TransactionOut)
def get_transaction(
    transaction_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Transaction)
        .options(joinedload(Transaction.items), joinedload(Transaction.issued_vouchers))
        .filter(Transaction.id == transaction_id, Transaction.tenant_id == active_tenant_id)
    )
    query = scope_transactions_by_user(query, current_user, db)
    if query is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    tx = query.first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    return tx
