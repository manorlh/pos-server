"""
The club member a sale was made for (§26): the till sends `clubMembershipId` with the
document; the link is kept in `club_sale_links` (customer + membership + the rules
applied — none in P0). Never a reason to refuse a document: a membership that is not
this tenant's, or not in a club serving the till's shop, is simply not linked.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.club import ClubMembership, ClubSaleLink
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.club.scope import club_for_company

logger = logging.getLogger(__name__)


def link_sale(db: Session, machine: POSMachine, transaction_id: Any, membership_id: Any) -> Optional[ClubSaleLink]:
    if not membership_id:
        return None
    try:
        mid = membership_id if isinstance(membership_id, uuid.UUID) else uuid.UUID(str(membership_id))
    except (TypeError, ValueError):
        return None
    try:
        with db.begin_nested():
            membership = db.get(ClubMembership, mid)
            if membership is None or membership.tenant_id != machine.tenant_id:
                return None
            shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
            club = club_for_company(db, machine.tenant_id, shop.company_id, active_only=False) if shop else None
            if club is None or club.id != membership.club_id:
                return None
            link = db.query(ClubSaleLink).filter(ClubSaleLink.transaction_id == transaction_id).first()
            if link is None:
                link = ClubSaleLink(
                    id=uuid.uuid4(),
                    tenant_id=machine.tenant_id,
                    transaction_id=transaction_id,
                    customer_id=membership.customer_id,
                    membership_id=membership.id,
                    machine_id=machine.id,
                    shop_id=machine.shop_id,
                    rules_snapshot={},
                    linked_at=datetime.now(timezone.utc),
                )
                db.add(link)
            else:
                link.customer_id = membership.customer_id
                link.membership_id = membership.id
            db.flush()
            return link
    except Exception:  # noqa: BLE001 - the document stands without its club link
        logger.warning("club sale link for %s not stored", transaction_id)
        return None
