"""
"סוג עוסק" — a company's tax status: company (חברה בע״מ), licensed (עוסק מורשה) or exempt
(עוסק פטור). docs/SPEC_BUSINESS_TYPE.md.

* **What it decides.** A company and a licensed dealer charge VAT and issue tax
  invoice-receipts (320) and credit notes (330). An exempt dealer charges no VAT and
  issues receipts only: 400 for a sale, the internal -400 for money given back (filed as a
  400 with negative amounts). The till decides each document by it, from the settings
  sync (`businessInfo.dealerType`, `settings.dealerType`).
* **Where it is set.** On the company — the legal entity holding the ח.פ. / ע.מ. A shop has
  no business identity of its own, so there is no shop override.
* **Who changes it.** On create: whoever may create a company. A change: the company's
  administrators (`Resource.DEALER_TYPE`) — never a branch. A change applies to new
  documents only; issued documents keep the type they were issued as. Who changed it and
  when is kept on the company, with every change in `dealer_type_history`.
* **The exempt dealer's ceiling.** Exempt status ends above an annual turnover set by law
  and updated every year, so it is a platform setting (`dealerTypes`, the super admin's),
  not a constant. `turnover_status` compares the year's documents with it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, status
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.platform_setting import PlatformSetting
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.user import User
from app.services.permission_matrix import Action, Resource, may

COMPANY = "company"
LICENSED = "licensed"
EXEMPT = "exempt"
DEALER_TYPES = (COMPANY, LICENSED, EXEMPT)
DEFAULT = COMPANY

FIELD = "dealer_type"

#: The label before the business number on anything printed (receipt, Z).
REG_LABELS = {
    COMPANY: "ח.פ.",
    LICENSED: "עוסק מורשה",
    EXEMPT: "עוסק פטור",
}

#: The platform setting holding the exempt dealer's turnover ceiling.
SETTING_KEY = "dealerTypes"
#: Warn from this share of the ceiling, unless the setting says otherwise.
DEFAULT_WARN_RATIO = 0.8


def normalize(value: Any) -> str:
    """A stored or received value as one of DEALER_TYPES; anything else is the default."""
    return value if value in DEALER_TYPES else DEFAULT


def reg_label(dealer_type: Any) -> str:
    return REG_LABELS[normalize(dealer_type)]


def is_exempt(dealer_type: Any) -> bool:
    return normalize(dealer_type) == EXEMPT


def _user_name(user: User) -> Optional[str]:
    for attr in ("full_name", "name", "username", "email"):
        value = getattr(user, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def apply_dealer_type(
    user: User,
    company: Company,
    values: Dict[str, Any],
    *,
    creating: bool = False,
    now: Optional[datetime] = None,
) -> bool:
    """
    Take `dealer_type` out of `values` (a create body's or an update's dict) and set it on
    `company`. Returns True when the type changed (the caller notifies the tills).

    Sending the type the company already has is not a change and needs no right — a form
    that PUTs the whole company back must not 403 a manager who may edit the rest.
    """
    if FIELD not in values:
        if creating:
            company.dealer_type = DEFAULT
            company.dealer_type_history = []
        return False
    requested = values.pop(FIELD)
    if requested is None:
        if creating:
            company.dealer_type = DEFAULT
            company.dealer_type_history = []
        return False
    if requested not in DEALER_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_dealer_type")
    if creating:
        company.dealer_type = requested
        company.dealer_type_history = []
        return False

    current = normalize(getattr(company, "dealer_type", None))
    if requested == current:
        return False
    if not may(user.role, Resource.DEALER_TYPE, Action.WRITE):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="dealer_type_forbidden")

    at = now or datetime.now(timezone.utc)
    by = getattr(user, "id", None)
    company.dealer_type = requested
    company.dealer_type_changed_at = at
    company.dealer_type_changed_by = by
    # A new list, not an append in place: JSONB columns do not track in-place mutation.
    company.dealer_type_history = list(company.dealer_type_history or []) + [
        {
            "from": current,
            "to": requested,
            "at": at.isoformat(),
            "by": str(by) if by is not None else None,
            "byName": _user_name(user),
        }
    ]
    return True


# ── The exempt dealer's turnover ceiling ─────────────────────────────────────


def get_settings(db: Session) -> Dict[str, Any]:
    """`{exemptTurnoverThreshold: number|None, warnRatio: number}` — unset is None."""
    row = db.get(PlatformSetting, SETTING_KEY) if callable(getattr(db, "get", None)) else None
    value = row.value if isinstance(getattr(row, "value", None), dict) else {}
    threshold = value.get("exemptTurnoverThreshold")
    try:
        threshold = float(threshold) if threshold is not None else None
    except (TypeError, ValueError):
        threshold = None
    if threshold is not None and threshold <= 0:
        threshold = None
    ratio = value.get("warnRatio")
    try:
        ratio = float(ratio) if ratio is not None else DEFAULT_WARN_RATIO
    except (TypeError, ValueError):
        ratio = DEFAULT_WARN_RATIO
    if not 0 < ratio <= 1:
        ratio = DEFAULT_WARN_RATIO
    return {"exemptTurnoverThreshold": threshold, "warnRatio": ratio}


def set_settings(db: Session, user: User, body: Dict[str, Any]) -> Dict[str, Any]:
    row = db.get(PlatformSetting, SETTING_KEY)
    if row is None:
        row = PlatformSetting(key=SETTING_KEY, value={})
        db.add(row)
    row.value = {
        "exemptTurnoverThreshold": body.get("exemptTurnoverThreshold"),
        "warnRatio": body.get("warnRatio", DEFAULT_WARN_RATIO),
    }
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    # Stored as given, read back cleaned.
    row.value = get_settings(db)
    db.flush()
    return row.value


def _zone(db: Session, tenant_id) -> ZoneInfo:
    from app.services.reports import resolve_report_timezone

    try:
        return ZoneInfo(resolve_report_timezone(db, tenant_id, None))
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("Asia/Jerusalem")


def year_turnover(db: Session, company: Company, year: int) -> Decimal:
    """
    The company's turnover in calendar `year` (the shop's local year): every sale less
    every refund, before VAT (`net_amount`), across all its shops. For an exempt dealer
    net is the whole amount. A year in which the type changed counts the VAT documents
    too, without their VAT — it is the business's turnover, not one document type's.
    """
    from app.services.dashboard_stats import SALE_STATUSES
    from app.services.tenders import document_collectable_expr, refund_condition

    zone = _zone(db, company.tenant_id)
    start = datetime(year, 1, 1, tzinfo=zone).astimezone(timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=zone).astimezone(timezone.utc)
    shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id == company.id).all()]
    if not shop_ids:
        return Decimal("0.00")
    amount = func.coalesce(Transaction.net_amount, document_collectable_expr())
    signed = case((refund_condition(), -amount), else_=amount)
    q = db.query(func.coalesce(func.sum(signed), 0)).filter(
        Transaction.shop_id.in_(shop_ids),
        Transaction.status.in_(SALE_STATUSES),
        Transaction.created_at >= start,
        Transaction.created_at < end,
    )
    if company.tenant_id is not None:
        q = q.filter(Transaction.tenant_id == company.tenant_id)
    total = q.scalar() or 0
    return Decimal(str(total)).quantize(Decimal("0.01"))


def turnover_state(turnover: Decimal, threshold: Optional[float], warn_ratio: float, exempt: bool) -> str:
    """none (no ceiling set, or not an exempt dealer) | ok | approaching | exceeded."""
    if not exempt or threshold is None:
        return "none"
    limit = Decimal(str(threshold))
    if turnover > limit:
        return "exceeded"
    if turnover >= limit * Decimal(str(warn_ratio)):
        return "approaching"
    return "ok"


def turnover_status(db: Session, company: Company, year: int) -> Dict[str, Any]:
    settings = get_settings(db)
    dealer_type = normalize(getattr(company, "dealer_type", None))
    turnover = year_turnover(db, company, year)
    threshold = settings["exemptTurnoverThreshold"]
    ratio = None
    if threshold:
        ratio = float(turnover / Decimal(str(threshold)))
    return {
        "year": year,
        "dealerType": dealer_type,
        "turnover": turnover,
        "threshold": threshold,
        "warnRatio": settings["warnRatio"],
        "ratio": ratio,
        "status": turnover_state(turnover, threshold, settings["warnRatio"], dealer_type == EXEMPT),
    }
