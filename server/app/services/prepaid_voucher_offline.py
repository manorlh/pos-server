"""
Prepaid vouchers redeemed without the internet ("מימוש ללא אינטרנט", `offline_allowed`) — the
assignment of a batch to one till or to the shop's LAN host, the download of its vouchers (code
hashes, never codes) and the sync of what was redeemed there (P:\\specs\\production-vouchers-api.md §7).

This first part only guards the switch: a batch cannot stop allowing offline redemption while
it is assigned somewhere.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch

OFFLINE_NOT_ALLOWED = "prepaid_voucher_offline_not_allowed"
OFFLINE_PENDING = "prepaid_voucher_offline_pending"
OFFLINE_ASSIGNED = "prepaid_voucher_offline_assigned"


def refuse_if_assigned(db: Session, batch: PrepaidVoucherBatch) -> None:
    """Nothing to refuse until assignments exist (they come with the offline endpoints)."""
    return None
