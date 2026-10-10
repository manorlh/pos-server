"""
Who may do what in the production vouchers' settlement and controls, and their audit trail.

* `prepaid_voucher_settlement` ("התחשבנות שוברי הפקה") — view: the settlement tab and the commercial
  reports (amounts only with `prepaid_voucher_prices` too); edit: agreements, invoice references,
  the gap's explanation.
* `prepaid_voucher_controls` ("בקרת מימוש שוברי הפקה") — view: pauses, quotas, test batches and
  replacements; edit: pausing, quotas, issuing test batches and replacement vouchers.
* `prepaid_voucher_prices` (the core's) — the production price and every amount made of it.

Every route is under `/prepaid-vouchers/*` (the `prepaid_vouchers` section at the door); these
are checked inside, like the core checks the prices. A super admin, a "full access" profile and
a database without profiles (unit tests) allow everything.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.prepaid_voucher_extras import PrepaidVoucherExtraEvent
from app.models.user import User

SETTLEMENT_SECTION = "prepaid_voucher_settlement"
CONTROLS_SECTION = "prepaid_voucher_controls"
PRICES_SECTION = "prepaid_voucher_prices"

SETTLEMENT_FORBIDDEN = "prepaid_settlement_forbidden"
CONTROLS_FORBIDDEN = "prepaid_voucher_controls_forbidden"


def http(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def allows(db: Session, user: Optional[User], section: str, level: str = "view") -> bool:
    from app.services.dashboard_access import effective_access

    try:
        return effective_access(db, user).allows(section, level)
    except Exception:  # noqa: BLE001 — fail closed: an access model that cannot be read allows nothing
        return False


def require(db: Session, user: User, section: str, level: str, detail: str) -> None:
    if not allows(db, user, section, level):
        raise http(status.HTTP_403_FORBIDDEN, detail)


def prices_visible(db: Session, user: Optional[User]) -> bool:
    return allows(db, user, PRICES_SECTION, "view")


def user_name(user: Optional[User]) -> Optional[str]:
    """As the core's audit trail names a user (`prepaid_vouchers._user_name`)."""
    if user is None:
        return None
    v = getattr(user, "username", None) or getattr(user, "email", None)
    return str(v)[:200] if v else None


def audit(
    db: Session,
    tenant_id,
    action: str,
    user: Optional[User],
    *,
    ref_id=None,
    batch_id=None,
    reason: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> PrepaidVoucherExtraEvent:
    ev = PrepaidVoucherExtraEvent(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        action=action,
        ref_id=as_uuid(ref_id),
        batch_id=as_uuid(batch_id),
        reason=reason,
        details=details,
        user_id=getattr(user, "id", None),
        user_name=user_name(user),
    )
    db.add(ev)
    return ev


def _redact(value: Any) -> Any:
    """Every amount (`…Agorot`) out of an audit row's details — for whoever may not see production prices."""
    if isinstance(value, dict):
        return {k: (None if k.endswith("Agorot") else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def event_out(ev: PrepaidVoucherExtraEvent, *, prices: bool = True) -> Dict[str, Any]:
    from app.services.prepaid_vouchers import _iso

    return {
        "id": str(ev.id),
        "action": ev.action,
        "refId": str(ev.ref_id) if ev.ref_id else None,
        "batchId": str(ev.batch_id) if ev.batch_id else None,
        "reason": ev.reason,
        "details": ev.details if prices else _redact(ev.details),
        "userName": ev.user_name,
        "at": _iso(ev.created_at),
    }
