"""Role-based query scoping for dashboard and transaction reads."""
from typing import Optional

from sqlalchemy.orm import Query, Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.user import User, UserRole


def scope_transactions_by_user(
    query: Query,
    current_user: User,
    db: Session,
) -> Optional[Query]:
    """
    Apply role-based filters to a Transaction query.
    Returns None when the user has no access (empty result set).
    """
    if current_user.role == UserRole.SUPER_ADMIN:
        return query
    if current_user.role == UserRole.DISTRIBUTOR:
        return query.join(POSMachine, POSMachine.id == Transaction.machine_id).filter(
            POSMachine.distributor_id == current_user.id
        )
    if current_user.role == UserRole.COMPANY_MANAGER and current_user.company_id:
        shop_ids = db.query(Shop.id).filter(Shop.company_id == current_user.company_id)
        return query.filter(Transaction.shop_id.in_(shop_ids))
    if current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and current_user.shop_id:
        return query.filter(Transaction.shop_id == current_user.shop_id)
    return None
