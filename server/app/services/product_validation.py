"""Guard rails around open-price ("general item") products."""
from decimal import Decimal, InvalidOperation
from typing import Any, Dict

from fastapi import HTTPException, status

from app.models.product import Product


def validate_open_price_update(product: Product, updates: Dict[str, Any]) -> None:
    """
    Refuse the one product state that would make a till charge the wrong amount.

    On an open-price product the stored `price` is only the amount the till pre-fills before
    the cashier types the real one, so 0 is a perfectly normal value to leave there. Clearing
    the flag promotes that same number to the amount actually charged — so a "general item"
    sitting at 0 would silently become a free product on every till after the next sync.

    Only a true → false transition is checked; already-fixed-price products keep whatever
    price they have, including 0, exactly as before.
    """
    if "is_open_price" not in updates:
        return
    if updates["is_open_price"]:
        return
    if not product.is_open_price:
        return

    raw_price = updates["price"] if "price" in updates else product.price
    try:
        new_price = Decimal(str(raw_price)) if raw_price is not None else None
    except (InvalidOperation, ValueError):
        new_price = None

    if new_price is None or new_price <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Send a price above 0 together with isOpenPrice=false — a fixed-price "
                "product priced at 0 would ring up free on the till"
            ),
        )
