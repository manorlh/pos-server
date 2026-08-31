"""Role-based query scoping for dashboard and transaction reads.

`scope_query_by_user` is the one implementation. `scope_transactions_by_user` and the
Z-report scoper are thin wrappers over it — the Z-report version used to be a verbatim
copy of the transaction one, which is exactly how the company-manager rule drifts out of
sync between two endpoints that must answer identically.
"""
from typing import Optional

from sqlalchemy.orm import Query, Session

from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.services.company_hierarchy import visible_shop_ids


def scope_query_by_user(
    query: Query,
    current_user: User,
    db: Session,
    *,
    shop_column,
    machine_column,
) -> Optional[Query]:
    """
    Apply role-based filters to any per-shop, per-machine row (transactions, Z-reports).

    Returns None when the user has no access (empty result set) so callers can
    distinguish "nothing matched" from "not allowed to ask".
    """
    if current_user.role == UserRole.SUPER_ADMIN:
        return query
    if current_user.role == UserRole.DISTRIBUTOR:
        return query.join(POSMachine, POSMachine.id == machine_column).filter(
            POSMachine.distributor_id == current_user.id
        )
    if current_user.role == UserRole.COMPANY_MANAGER and current_user.company_id:
        # Every shop under this manager's company *and its subsidiaries*: a group
        # manager sees the group's trading companies.
        return query.filter(shop_column.in_(visible_shop_ids(db, current_user)))
    if current_user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and current_user.shop_id:
        return query.filter(shop_column == current_user.shop_id)
    return None


def scope_transactions_by_user(
    query: Query,
    current_user: User,
    db: Session,
) -> Optional[Query]:
    """
    Apply role-based filters to a Transaction query.
    Returns None when the user has no access (empty result set).
    """
    return scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=Transaction.shop_id,
        machine_column=Transaction.machine_id,
    )
