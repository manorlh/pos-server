"""
"שינוי מחיר מהקופה" (P:/specs/chain-areas.md §9.6): where a price changed at a till lands, whether the till asks,
and who must authorise it.

* **Levels** (`tillPriceChangeLevels`): `auto` (default) — the till's point of sale or the whole shop, when the shop
  has points of sale and the till stands in one; the whole shop otherwise (today's behaviour); `area`; `area_shop`;
  `shop`; `off`.
* **Default level**: the till's point of sale when the shop has points of sale and the till stands in one (and that
  level is allowed); else the shop.
* **Ask "איפה לשנות?"** (`tillPriceChangeAsk`, default on): only when both levels are allowed and the product is sold
  beyond the till's point of sale (in every point of sale, or in another one too). A product sold only here: no
  question — it changes here.
* **Approval** (`tillPriceChangeApproval`, default off): on — always an authorised person's code / a remote approval
  (an elevation grant), even when the signed-in employee holds the permission.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.services import till_parameters as TP

AREA, SHOP = "area", "shop"


def _param(db: Session, machine: POSMachine, key: str) -> Any:
    try:
        return TP._kiosk_parameter(db, machine, key)
    except Exception:  # noqa: BLE001 - an older world without the parameters: the default
        return None


def _till_area(db: Session, machine: POSMachine) -> Optional[ShopArea]:
    area = db.get(ShopArea, machine.area_id) if getattr(machine, "area_id", None) is not None else None
    return area if area is not None and area.archived_at is None else None


def allowed_levels(db: Session, machine: POSMachine) -> List[str]:
    """The levels this till may change a price at, default first."""
    mode = _param(db, machine, TP.TILL_PRICE_LEVELS_KEY)
    if mode not in TP.TILL_PRICE_LEVELS_OPTIONS:
        mode = TP.TILL_PRICE_LEVELS_AUTO
    in_area = _till_area(db, machine) is not None
    if mode == "off":
        return []
    if mode == "shop":
        return [SHOP]
    if mode == "area":
        return [AREA] if in_area else []
    # auto / area_shop
    return [AREA, SHOP] if in_area else [SHOP]


def approval_required(db: Session, machine: POSMachine) -> bool:
    value = _param(db, machine, TP.TILL_PRICE_APPROVAL_KEY)
    return value is True or str(value).lower() in ("true", "1")


def asks(db: Session, machine: POSMachine, row: Optional[ShopProductOverride]) -> bool:
    """"איפה לשנות?": both levels allowed, the setting on, and the product sold beyond the till's point of sale."""
    levels = allowed_levels(db, machine)
    if len(levels) < 2:
        return False
    ask = _param(db, machine, TP.TILL_PRICE_ASK_KEY)
    if ask is False or str(ask).lower() in ("false", "0"):
        return False
    from app.services import product_areas as PA

    ids = PA.stored_ids(row)
    if ids is None:
        return True  # every point of sale of the shop
    return bool(ids - {str(machine.area_id)})


def default_level(db: Session, machine: POSMachine) -> Optional[str]:
    levels = allowed_levels(db, machine)
    return levels[0] if levels else None


def info(db: Session, machine: POSMachine, row: Optional[ShopProductOverride]) -> Dict[str, Any]:
    area = _till_area(db, machine)
    return {
        "levels": allowed_levels(db, machine),
        "defaultLevel": default_level(db, machine),
        "ask": asks(db, machine, row),
        "approvalRequired": approval_required(db, machine),
        "areaId": str(area.id) if area is not None else None,
        "areaName": area.name if area is not None else None,
    }
