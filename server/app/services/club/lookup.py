"""
The till's member lookup (§26): by phone or by the member's QR token, in the club that
serves the till's shop. Minimal on purpose: first name, last-name initial, status,
member number and available benefits. No phone back, no history, no consents, and a
lookup is NOT an authority to redeem (redemption is P1, behind its own verification).
Every lookup is audited with the till that made it.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.club import (
    MEMBERSHIP_ACTIVE,
    MEMBERSHIP_CLOSED,
    MEMBERSHIP_PENDING,
    MEMBERSHIP_SUSPENDED,
    ClubBenefitGrant,
    ClubCustomer,
    ClubMembership,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.club.scope import audit, club_for_company
from app.services.notifications.phone import PhoneError, normalize_phone, phone_hash

STATUS_LABELS = {
    MEMBERSHIP_ACTIVE: "חבר פעיל",
    MEMBERSHIP_PENDING: "ממתין לאימות",
    MEMBERSHIP_SUSPENDED: "מושעה",
    MEMBERSHIP_CLOSED: "סגור",
}


class LookupError_(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def lookup(db: Session, machine: POSMachine, *, phone: Optional[str] = None, qr: Optional[str] = None) -> Dict[str, Any]:
    if not phone and not qr:
        raise LookupError_("lookup_query_required", 422)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    club = club_for_company(db, machine.tenant_id, shop.company_id) if shop is not None else None
    if club is None:
        return {"found": False, "reason": "no_club"}
    membership = None
    if qr:
        token = str(qr).strip()
        # A scanned URL / prefixed payload: the token is its last path part.
        token = token.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
        if 8 <= len(token) <= 64:
            membership = (
                db.query(ClubMembership)
                .filter(ClubMembership.club_id == club.id, ClubMembership.qr_token == token)
                .first()
            )
    else:
        try:
            e164 = normalize_phone(phone)
        except PhoneError as exc:
            raise LookupError_(exc.code, 422) from None
        customer = (
            db.query(ClubCustomer)
            .filter(
                ClubCustomer.tenant_id == machine.tenant_id,
                ClubCustomer.company_id == club.company_id,
                ClubCustomer.phone_hash == phone_hash(e164),
            )
            .first()
        )
        if customer is not None:
            membership = (
                db.query(ClubMembership)
                .filter(ClubMembership.club_id == club.id, ClubMembership.customer_id == customer.id)
                .first()
            )
    audit(
        db,
        tenant_id=machine.tenant_id,
        company_id=club.company_id,
        domain="club",
        subject_type="membership",
        subject_id=membership.id if membership is not None else None,
        action="lookup",
        actor_machine_id=machine.id,
        details={"by": "qr" if qr else "phone", "found": membership is not None},
    )
    if membership is None:
        return {"found": False, "clubName": club.name}
    customer = db.get(ClubCustomer, membership.customer_id)
    grants = []
    if membership.status == MEMBERSHIP_ACTIVE:
        grants = [
            {
                "id": str(g.id),
                "title": g.title,
                "validUntil": g.valid_until.isoformat() if g.valid_until else None,
            }
            for g in db.query(ClubBenefitGrant)
            .filter(ClubBenefitGrant.membership_id == membership.id, ClubBenefitGrant.status == "available")
            .order_by(ClubBenefitGrant.created_at.asc())
            .limit(10)
            .all()
        ]
    last = (customer.last_name or "").strip() if customer is not None else ""
    return {
        "found": True,
        "clubName": club.name,
        "customerId": str(membership.customer_id),
        "membershipId": str(membership.id),
        "firstName": customer.first_name if customer is not None else "",
        "lastInitial": (last[:1] + ".") if last else None,
        "memberNumber": membership.member_number,
        "status": membership.status,
        "statusLabel": STATUS_LABELS.get(membership.status, membership.status),
        "benefits": grants,
        # P1: points ledger and redemption (reserve → commit) are not active in P0.
        "points": None,
        "redemptionAvailable": False,
    }
