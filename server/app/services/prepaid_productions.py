"""
Productions ("הפקות", the production vouchers contract §13) — the customer vouchers are made for.

A company's production: its name, contact, how it is billed (`redemption` — by what was redeemed,
the default — or `delivery`, by what was handed over) and notes. A batch names one
(`production_id`) and carries its name as `customer_name`, which keeps the filters, the snapshots
and the printed cover sheets as they were; a rename reaches its batches. A batch also names its
event — the existing `report_events` (no second event entity), its printed `event_name` staying.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidProduction, PrepaidVoucherBatch
from app.models.report_event import ReportEvent
from app.models.shop import Shop
from app.models.user import User

PRODUCTION_NOT_FOUND = "prepaid_voucher_production_not_found"
PRODUCTION_NAME_TAKEN = "prepaid_voucher_production_name_taken"
PRODUCTION_INACTIVE = "prepaid_voucher_production_inactive"
PRODUCTION_OTHER_COMPANY = "prepaid_voucher_production_other_company"
EVENT_INVALID = "prepaid_voucher_event_invalid"
BILLING_BASES = ("redemption", "delivery")
EVENTS_LIMIT = 200


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _pvt():
    from app.services import prepaid_voucher_types as PVT

    return PVT


def production_out(p: PrepaidProduction, batch_count: int = 0) -> Dict[str, Any]:
    PV = _pv()
    return {
        "id": str(p.id),
        "companyId": str(p.company_id),
        "name": p.name,
        "contactName": p.contact_name,
        "contactPhone": p.contact_phone,
        "contactEmail": p.contact_email,
        "billingBasis": p.billing_basis or "redemption",
        "notes": p.notes,
        "active": p.active is not False,
        "batchCount": int(batch_count),
        "createdAt": PV._iso(p.created_at),
        "updatedAt": PV._iso(p.updated_at),
    }


def ref_out(p: Optional[PrepaidProduction]) -> Optional[Dict[str, Any]]:
    return None if p is None else {"id": str(p.id), "name": p.name, "billingBasis": p.billing_basis or "redemption"}


def event_ref_out(ev: Optional[ReportEvent]) -> Optional[Dict[str, Any]]:
    PV = _pv()
    if ev is None:
        return None
    return {"id": str(ev.id), "name": ev.name, "startsAt": PV._iso(ev.starts_at), "endsAt": PV._iso(ev.ends_at)}


def _counts(db: Session, ids: List[uuid.UUID]) -> Dict[str, int]:
    if not ids:
        return {}
    rows = (
        db.query(PrepaidVoucherBatch.production_id, func.count(PrepaidVoucherBatch.id))
        .filter(PrepaidVoucherBatch.production_id.in_(ids))
        .group_by(PrepaidVoucherBatch.production_id)
        .all()
    )
    return {str(pid): int(n) for pid, n in rows}


def list_productions(
    db: Session, user: User, tenant_id, *, company_id: Optional[str] = None, include_inactive: bool = False,
) -> Dict[str, Any]:
    """The productions [user] may see (of the companies they cover or whose shops they see), by name."""
    PV, PVT = _pv(), _pvt()
    PV._require_role(user)
    q = db.query(PrepaidProduction).filter(PrepaidProduction.tenant_id == tenant_id)
    if company_id:
        q = q.filter(PrepaidProduction.company_id == PV._as_uuid(company_id))
    if not include_inactive:
        q = q.filter(PrepaidProduction.active.is_(True))
    readable: Dict[str, bool] = {}
    rows = []
    for p in q.order_by(func.lower(PrepaidProduction.name)).all():
        key = str(p.company_id)
        if key not in readable:
            readable[key] = PVT._may_read(db, user, tenant_id, p.company_id)
        if readable[key]:
            rows.append(p)
    counts = _counts(db, [p.id for p in rows])
    return {"items": [production_out(p, counts.get(str(p.id), 0)) for p in rows]}


def get_production(db: Session, user: User, tenant_id, production_id) -> PrepaidProduction:
    PV, PVT = _pv(), _pvt()
    PV._require_role(user)
    wanted = PV._as_uuid(production_id)
    p = db.query(PrepaidProduction).filter(PrepaidProduction.id == wanted).first() if wanted else None
    if p is None or str(p.tenant_id) != str(tenant_id) or not PVT._may_read(db, user, tenant_id, p.company_id):
        raise PV._http(status.HTTP_404_NOT_FOUND, PRODUCTION_NOT_FOUND)
    return p


def _name_free(db: Session, tenant_id, company_id, name: str, but=None) -> None:
    q = db.query(PrepaidProduction.id).filter(
        PrepaidProduction.tenant_id == tenant_id,
        PrepaidProduction.company_id == company_id,
        func.lower(PrepaidProduction.name) == name.lower(),
    )
    if but is not None:
        q = q.filter(PrepaidProduction.id != but)
    if q.first() is not None:
        raise _pv()._http(status.HTTP_409_CONFLICT, PRODUCTION_NAME_TAKEN)


def create_production(db: Session, user: User, tenant_id, body) -> PrepaidProduction:
    PV, PVT = _pv(), _pvt()
    PV._require_role(user)
    company = PVT._company(db, tenant_id, body.company_id)
    PVT._require_write(db, user, company.id)
    _name_free(db, tenant_id, company.id, body.name)
    p = PrepaidProduction(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, name=body.name,
        contact_name=body.contact_name, contact_phone=body.contact_phone, contact_email=body.contact_email,
        billing_basis=body.billing_basis or "redemption", notes=body.notes, active=True,
        created_by=getattr(user, "id", None), created_at=PV._now(), updated_at=PV._now(),
    )
    db.add(p)
    db.flush()
    return p


def update_production(db: Session, user: User, tenant_id, production_id, body) -> PrepaidProduction:
    """In place; a new name reaches the batches that name it (their `customer_name`)."""
    PV, PVT = _pv(), _pvt()
    p = get_production(db, user, tenant_id, production_id)
    PVT._require_write(db, user, p.company_id)
    fields = body.model_dump(exclude_unset=True, by_alias=False)
    if "name" in fields and not fields["name"]:
        fields.pop("name")
    for key in ("billing_basis", "active"):
        if key in fields and fields[key] is None:
            fields.pop(key)
    if "name" in fields and fields["name"] != p.name:
        _name_free(db, tenant_id, p.company_id, fields["name"], but=p.id)
        (
            db.query(PrepaidVoucherBatch)
            .filter(PrepaidVoucherBatch.production_id == p.id)
            .update({PrepaidVoucherBatch.customer_name: fields["name"]}, synchronize_session="fetch")
        )
    for key, value in fields.items():
        setattr(p, key, value)
    p.updated_at = PV._now()
    db.flush()
    return p


def production_for_batch(db: Session, tenant_id, production_id, company_id) -> PrepaidProduction:
    """The production a batch of [company_id] names: the tenant's, of a related company, active."""
    PV = _pv()
    wanted = PV._as_uuid(production_id)
    p = db.query(PrepaidProduction).filter(PrepaidProduction.id == wanted).first() if wanted else None
    if p is None or str(p.tenant_id) != str(tenant_id):
        raise PV._http(status.HTTP_404_NOT_FOUND, PRODUCTION_NOT_FOUND)
    if str(p.company_id) not in PV._related_companies(db, company_id):
        raise PV._http(status.HTTP_400_BAD_REQUEST, PRODUCTION_OTHER_COMPANY)
    if p.active is False:
        raise PV._http(status.HTTP_409_CONFLICT, PRODUCTION_INACTIVE)
    return p


def event_for_batch(db: Session, tenant_id, event_id, company_id, user: Optional[User] = None) -> ReportEvent:
    """The event a batch of [company_id] names: the tenant's, of a shop of a related company (that [user] sees)."""
    PV = _pv()
    wanted = PV._as_uuid(event_id)
    ev = db.query(ReportEvent).filter(ReportEvent.id == wanted).first() if wanted else None
    if ev is None or str(ev.tenant_id) != str(tenant_id):
        raise PV._http(status.HTTP_400_BAD_REQUEST, EVENT_INVALID)
    related = PV._related_companies(db, company_id)
    shop_company = db.query(Shop.company_id).filter(Shop.id == ev.shop_id).scalar()
    if (ev.company_id is not None and str(ev.company_id) not in related) or (
        shop_company is not None and str(shop_company) not in related
    ):
        raise PV._http(status.HTTP_400_BAD_REQUEST, EVENT_INVALID)
    if user is not None and str(ev.shop_id) not in PV._visible_shop_ids(db, user, tenant_id) and not (
        shop_company is not None and PV._covers_company(db, user, shop_company)
    ):
        raise PV._http(status.HTTP_400_BAD_REQUEST, EVENT_INVALID)  # one the user does not see is no event of theirs
    return ev


def list_events(db: Session, user: User, tenant_id, *, company_id: Optional[str] = None) -> Dict[str, Any]:
    """The events a batch may name (the existing `report_events`), newest first, of the shops [user] sees."""
    PV = _pv()
    PV._require_role(user)
    q = db.query(ReportEvent).filter(ReportEvent.tenant_id == tenant_id)
    related = PV._related_companies(db, company_id) if company_id else None
    visible = PV._visible_shop_ids(db, user, tenant_id)
    shop_names = {str(s.id): (s.name, str(s.company_id)) for s in db.query(Shop).filter(Shop.tenant_id == tenant_id)}
    out = []
    for ev in q.order_by(ReportEvent.starts_at.desc()).limit(EVENTS_LIMIT * 2).all():
        shop = shop_names.get(str(ev.shop_id))
        owner = shop[1] if shop else (str(ev.company_id) if ev.company_id else None)
        if str(ev.shop_id) not in visible and not (owner and PV._covers_company(db, user, owner)):
            continue
        if related is not None and shop is not None and shop[1] not in related:
            continue
        out.append({**event_ref_out(ev), "shopId": str(ev.shop_id), "shopName": shop[0] if shop else None,
                    "status": ev.status})
        if len(out) >= EVENTS_LIMIT:
            break
    return {"items": out}
