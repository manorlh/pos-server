"""
Customer licenses: a permanent or a temporary customer ("לקוח קבוע / זמני").

A short-term customer or a one-off event is set up as *temporary*, with the date its
license ends (`license_expires_on`), on its organization, its company or its shop. After
that date the till stops selling: it shows "רישיון הקופה הסתיים" and still lets the day be
closed (shift close, X / Z, card transmission), so no money is left unaccounted for.

* **Who sets it.** The super admin only, when creating or editing the organization,
  company or shop, or a single till (`apply_license`). Anyone else sending the fields is
  refused.
* **Which date a till keeps.** The earliest end among the till itself, its shop, its
  company and every company above it, and its organization (`effective_license`) — a
  temporary event shop under a permanent chain ends with the event, and so does a till
  lent to an event out of a permanent shop.
* **Last day.** The license is valid through `license_expires_on` (the whole day, the
  shop's local time is the till's to apply); it ends the day after.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole

PERMANENT = "permanent"
TEMPORARY = "temporary"
LICENSE_TYPES = (PERMANENT, TEMPORARY)
FIELDS = ("license_type", "license_expires_on")

#: Days before the end the till starts warning.
WARN_DAYS = 3


def apply_license(user: User, entity: Any, values: Dict[str, Any], *, creating: bool = False) -> None:
    """
    Take the license fields out of `values` (a create body's or an update's dict) and set
    them on `entity`: the super admin only; temporary needs an end date; permanent has none.
    Leaves `values` without them, so the caller's own field loop never sees them.
    """
    given = {k: values.pop(k) for k in FIELDS if k in values}
    if creating:
        given = {k: v for k, v in given.items() if v is not None}
    if not given:
        return
    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="license_super_admin_only")
    kind = given.get("license_type", getattr(entity, "license_type", None) or PERMANENT)
    if kind not in LICENSE_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_license_type")
    ends = given["license_expires_on"] if "license_expires_on" in given else getattr(entity, "license_expires_on", None)
    if kind == TEMPORARY and ends is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="license_date_required")
    entity.license_type = kind
    entity.license_expires_on = ends if kind == TEMPORARY else None


def _temporary_end(entity: Any) -> Optional[date]:
    if entity is None or getattr(entity, "license_type", None) != TEMPORARY:
        return None
    return getattr(entity, "license_expires_on", None)


def effective_license(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """
    The till's license: `{type, expiresOn, source, name, warnDays}` — temporary with the
    earliest end among the till itself, its shop, its companies (up the chain) and its organization, or
    permanent. The till applies it by its own clock, so it holds offline too.
    """
    candidates = [("machine", machine)]
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    if shop is not None:
        candidates.append(("shop", shop))
        company = db.get(Company, shop.company_id) if shop.company_id else None
        seen = set()
        while company is not None and company.id not in seen:
            seen.add(company.id)
            candidates.append(("company", company))
            company = db.get(Company, company.parent_company_id) if company.parent_company_id else None
    tenant = db.get(Tenant, machine.tenant_id) if machine.tenant_id else None
    if tenant is not None:
        candidates.append(("tenant", tenant))

    best = None
    for source, entity in candidates:
        ends = _temporary_end(entity)
        if ends is not None and (best is None or ends < best[0]):
            best = (ends, source, entity)
    if best is None:
        return {"type": PERMANENT, "expiresOn": None, "source": None, "name": None, "warnDays": WARN_DAYS}
    ends, source, entity = best
    return {
        "type": TEMPORARY,
        "expiresOn": ends.isoformat(),
        "source": source,
        "name": getattr(entity, "name", None),
        "warnDays": WARN_DAYS,
    }
