"""
Seed the one POS user a brand-new shop needs so a till can be paired and signed into
immediately, before anyone configures staff.

The PIN is a fixed, well-known 1234 by design: it exists so a field installer can prove
the till works. It is hashed with the same `get_password_hash` (passlib bcrypt) the
dashboard POS-user endpoints use, because the Android till verifies bcrypt on-device and
refuses any hash that is not bcrypt.
"""
from typing import Optional

from sqlalchemy.orm import Session

from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.services.auth import get_password_hash


# Reserved identity for the auto-created operator. Lowercase and non-personal so it cannot
# be mistaken for — or collide with — a cashier the merchant names later.
DEFAULT_POS_USER_USERNAME = "default"
DEFAULT_POS_USER_FIRST_NAME = "Default"
DEFAULT_POS_USER_LAST_NAME = "Cashier"
DEFAULT_POS_USER_PIN = "1234"
DEFAULT_POS_USER_ROLE = PosUserRole.SHOP_MANAGER


def ensure_default_pos_user(db: Session, shop: Shop) -> Optional[PosUser]:
    """
    Give `shop` the default POS user if it has no POS users at all.

    Flushes but deliberately does **not** commit: the caller keeps the shop and its POS
    user in one transaction, so a shop can never be committed without an operator.

    Idempotent — returns None (and touches nothing) when the shop already has any
    `pos_users` row, whether that is a previous default or a real cashier.
    """
    already_staffed = db.query(PosUser.id).filter(PosUser.shop_id == shop.id).first()
    if already_staffed is not None:
        return None

    pos_user = PosUser(
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        username=DEFAULT_POS_USER_USERNAME,
        first_name=DEFAULT_POS_USER_FIRST_NAME,
        last_name=DEFAULT_POS_USER_LAST_NAME,
        # Left null on purpose: worker numbers are the merchant's own numbering and carry a
        # partial UNIQUE per shop, so claiming one would collide with a real cashier.
        worker_number=None,
        pin_hash=get_password_hash(DEFAULT_POS_USER_PIN),
        role=DEFAULT_POS_USER_ROLE,
        is_active=True,
    )
    db.add(pos_user)
    db.flush()
    return pos_user
