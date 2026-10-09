"""
Prepaid vouchers ("שוברי הפקה") — see app/services/prepaid_vouchers.py for the rules.

Dashboard (user JWT, the catalog's writers, scoped by company / shop):

GET    /prepaid-vouchers/products                     → the products a batch of a company may carry
GET    /prepaid-vouchers/categories                   → the categories an item discount of a company may name
GET    /prepaid-vouchers/types                        → voucher types (the spec's §2–3)
POST   /prepaid-vouchers/types                        → a new type
GET    /prepaid-vouchers/types/{id}                   → one type
PATCH  /prepaid-vouchers/types/{id}                   → name / code / active; terms → a new version
GET    /prepaid-vouchers/types/{id}/events            → the type's audit trail
GET    /prepaid-vouchers/batches                      → batches with their counts
POST   /prepaid-vouchers/batches                      → make a batch and its vouchers
GET    /prepaid-vouchers/batches/{id}                 → one batch
PATCH  /prepaid-vouchers/batches/{id}                 → texts, logo, validity
POST   /prepaid-vouchers/batches/{id}/vouchers        → issue more vouchers (next serials)
POST   /prepaid-vouchers/batches/{id}/cancel          → cancel the batch and its open vouchers
GET    /prepaid-vouchers/batches/{id}/vouchers        → its vouchers (codes for printing)
GET    /prepaid-vouchers/batches/{id}/file            → PDF / ZIP (a PDF per voucher, or per group
                                                        with cover sheets) / CSV manifest
GET    /prepaid-vouchers/batches/{id}/groups          → per group: serials and how many redeemed
POST   /prepaid-vouchers/batches/{id}/groups          → split the vouchers with no group into groups
POST   /prepaid-vouchers/batches/{id}/groups/{n}/cancel → cancel a whole group (a lost envelope)
GET    /prepaid-vouchers/batches/{id}/events          → the batch's audit trail
GET    /prepaid-vouchers/batches/{id}/report          → counts, goods taken, redemptions by
                                                        hour / day / shop / till / employee
GET    /prepaid-vouchers/vouchers/{id}                → one voucher with its redemptions
POST   /prepaid-vouchers/vouchers/{id}/cancel         → cancel one voucher
PUT    /prepaid-vouchers/vouchers/{id}/note           → its free-text note (blank clears)

Till (machine JWT only, online):

POST   /sync/{machine_id}/prepaid-vouchers/lookup     → the voucher as this till sees it
POST   /sync/{machine_id}/prepaid-vouchers/redeem     → take goods off it; atomic, idempotent
                                                        by `clientRequestId`
POST   /sync/{machine_id}/prepaid-vouchers/reserve    → hold a discount voucher for an open sale
                                                        (idempotent / renewed by `clientRequestId`)
POST   /sync/{machine_id}/prepaid-vouchers/reservations/{id}/confirm → the sale was written
POST   /sync/{machine_id}/prepaid-vouchers/reservations/{id}/release → give it back
"""
from __future__ import annotations

from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, Header, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.prepaid_voucher import (
    PrepaidProductionCreate,
    PrepaidProductionUpdate,
    PrepaidVoucherAddIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherCancelIn,
    PrepaidVoucherConfirmIn,
    PrepaidVoucherGroupsIn,
    PrepaidVoucherLookupIn,
    PrepaidVoucherNoteIn,
    PrepaidOfflineAssignIn,
    PrepaidOfflineReleaseIn,
    PrepaidOfflineSyncIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherReserveIn,
    PrepaidVoucherTypeCreate,
    PrepaidVoucherTypeUpdate,
)
from app.services import prepaid_vouchers as PV
from app.services import prepaid_productions as PPR
from app.services import prepaid_voucher_reports as PVR
from app.services import prepaid_voucher_analytics as PVA

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_MACHINE_TOKEN

router = APIRouter(tags=["prepaid-vouchers"])


# ── Dashboard ─────────────────────────────────────────────────────────────────


@router.get("/prepaid-vouchers/products")
def list_prepaid_voucher_products(
    company_id: str = Query(..., alias="companyId"),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    purpose: str = Query("items"),
    shop_ids: Optional[List[str]] = Query(None, alias="shopIds"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Every product a batch of the company may be looking for, each with whether it can go on
    it — as goods (`purpose=items`) and as an item discount's target — and why not (§7.14).
    `shopIds`: the batch's shops so far (a till's own product is usable only for its shop).
    """
    return {
        "items": PV.eligible_products(
            db, current_user, active_tenant_id, company_id, search, limit, purpose=purpose, shop_ids=shop_ids,
        )
    }


@router.get("/prepaid-vouchers/categories")
def list_prepaid_voucher_categories(
    company_id: str = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The categories an item discount of a company may name — the save's own rule."""
    return {"items": PV.eligible_categories(db, current_user, active_tenant_id, company_id)}


def voucher_scope(
    customer: Optional[List[str]] = Query(None, description="For whom: the production (until then the batch's customer)"),
    event: Optional[List[str]] = Query(None),
    type_id: Optional[List[str]] = Query(None, alias="typeId"),
    kind: Optional[str] = Query(None, description="items | discount"),
    batch_id: Optional[List[str]] = Query(None, alias="batchId"),
    shop_id: Optional[List[str]] = Query(None, alias="shopId"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    accounting: Optional[str] = Query(None, description="discount | payment | zero"),
    pricing: Optional[str] = Query(None, description="fixed | cover"),
    override: Optional[str] = Query(None, description="yes | no: a discount-block policy other than honour"),
    offline: Optional[str] = Query(None, description="yes | no: offline redemption allowed"),
    value_min: Optional[str] = Query(None, alias="valueMin"),
    value_max: Optional[str] = Query(None, alias="valueMax"),
    price_min: Optional[str] = Query(None, alias="priceMin", description="Production price (₪) — only with the prices section"),
    price_max: Optional[str] = Query(None, alias="priceMax"),
    created_by: Optional[str] = Query(None, alias="createdBy"),
    issued_from: Optional[str] = Query(None, alias="issuedFrom"),
    issued_to: Optional[str] = Query(None, alias="issuedTo"),
    valid_on: Optional[str] = Query(None, alias="validOn"),
    batch_status: Optional[str] = Query(None, alias="batchStatus"),
    date_from: Optional[str] = Query(None, alias="from", description="Redeemed from (the tenant's day)"),
    date_to: Optional[str] = Query(None, alias="to"),
    machine_id: Optional[List[str]] = Query(None, alias="machineId"),
    employee: Optional[List[str]] = Query(None),
    state: Optional[str] = Query(None, description="open | partial | redeemed | cancelled | expired"),
    group: Optional[int] = Query(None, ge=1),
    q: Optional[str] = Query(None, max_length=100),
) -> "PVA.Scope":
    """The vouchers' one filter model (app/services/prepaid_voucher_analytics.py)."""
    return PVA.make_scope(
        customer=customer, event=event, type_id=type_id, kind=kind, batch_id=batch_id, shop_id=shop_id,
        company_id=company_id, accounting=accounting, pricing=pricing, override=override, offline=offline,
        value_min=value_min, value_max=value_max, price_min=price_min, price_max=price_max, created_by=created_by,
        issued_from=issued_from, issued_to=issued_to, valid_on=valid_on, batch_status=batch_status,
        date_from=date_from, date_to=date_to, machine_id=machine_id, employee=employee, state=state, group=group, q=q,
    )


def _scope(value) -> "PVA.Scope":
    """The dependency's value; an empty filter for a direct call that left it out."""
    return value if isinstance(value, PVA.Scope) else PVA.Scope()


@router.get("/prepaid-vouchers/batches")
def list_prepaid_voucher_batches(
    include_cancelled: bool = Query(True, alias="includeCancelled"),
    sort: str = Query("newest", description="newest | customer | event | redeemed"),
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The batches under the filters (every one without), each with its figures — issued,
    redeemed (in full or in part), open, the redemption rate — and its status flags.
    """
    out = PVA.list_batches(db, current_user, active_tenant_id, _scope(scope), sort=_given(sort) or "newest")
    if _given(include_cancelled) is False:
        out["items"] = [b for b in out["items"] if b["status"] == "active"]
        out["total"] = len(out["items"])
    return out


@router.get("/prepaid-vouchers/vouchers")
def list_all_prepaid_vouchers(
    limit: int = Query(100, ge=1, le=PVA.PAGE_MAX),
    offset: int = Query(0, ge=0),
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"כל השוברים": vouchers across every batch (or one, `batchId`) under the filters, a page at a time."""
    return PVA.list_vouchers(db, current_user, active_tenant_id, _scope(scope), limit=limit, offset=offset)


@router.get("/prepaid-vouchers/facets")
def prepaid_voucher_facets(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What the filters offer: for whom, events, types, batches, shops, tills, employees, creators."""
    return PVA.facets(db, current_user, active_tenant_id)


# ── Productions ("הפקות") and the events a batch may name (the contract's §13) ──────────────


@router.get("/prepaid-vouchers/productions")
def list_prepaid_productions(
    company_id: Optional[str] = Query(None, alias="companyId"),
    include_inactive: bool = Query(False, alias="includeInactive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The productions (the customers vouchers are made for), by name, with how many batches name each."""
    return PPR.list_productions(db, current_user, active_tenant_id, company_id=company_id, include_inactive=include_inactive)


@router.post("/prepaid-vouchers/productions", status_code=status.HTTP_201_CREATED)
def create_prepaid_production(
    body: PrepaidProductionCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    p = PPR.create_production(db, current_user, active_tenant_id, body)
    db.commit()
    return PPR.production_out(p)


@router.patch("/prepaid-vouchers/productions/{production_id}")
def update_prepaid_production(
    production_id: str,
    body: PrepaidProductionUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """In place; a new name reaches the batches that name the production."""
    p = PPR.update_production(db, current_user, active_tenant_id, production_id, body)
    db.commit()
    return PPR.production_out(p, PPR._counts(db, [p.id]).get(str(p.id), 0))


@router.get("/prepaid-vouchers/events")
def list_prepaid_voucher_events(
    company_id: Optional[str] = Query(None, alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The events a batch may name — the existing report events of the shops the user sees, newest first."""
    return PPR.list_events(db, current_user, active_tenant_id, company_id=company_id)


@router.get("/prepaid-vouchers/search")
def search_prepaid_vouchers(
    q: str = Query(..., min_length=1, max_length=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One box over batches, vouchers, tills and employees, grouped."""
    return PVA.search(db, current_user, active_tenant_id, q)


@router.post("/prepaid-vouchers/batches/{batch_id}/offline/assign")
def assign_prepaid_batch_offline(
    batch_id: str,
    body: PrepaidOfflineAssignIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Assign the batch for redemption without the internet to a till or the shop's LAN host (§7)."""
    from app.services import prepaid_voucher_offline as PVO

    out = PVO.assign(db, current_user, active_tenant_id, batch_id, body.target, body.machine_id, body.shop_id)
    db.commit()
    return out


@router.post("/prepaid-vouchers/batches/{batch_id}/offline/release")
def release_prepaid_batch_offline(
    batch_id: str,
    body: PrepaidOfflineReleaseIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Release it once the device synced everything — or by force, with a reason (audited)."""
    from app.services import prepaid_voucher_offline as PVO

    out = PVO.release(db, current_user, active_tenant_id, batch_id, body.force, body.reason)
    db.commit()
    return out


@router.get("/prepaid-vouchers/batches/{batch_id}/offline/targets")
def prepaid_batch_offline_targets(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Where the batch may be assigned: the tills of its shops the user sees, and each shop's LAN host."""
    from app.services import prepaid_voucher_offline as PVO

    return PVO.targets(db, current_user, active_tenant_id, batch_id)


@router.get("/prepaid-vouchers/batches/{batch_id}/offline")
def get_prepaid_batch_offline(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import prepaid_voucher_offline as PVO

    return PVO.history(db, current_user, active_tenant_id, batch_id)


@router.get("/sync/{machine_id}/prepaid-vouchers/offline", dependencies=FISCAL_MACHINE_TOKEN)
def download_prepaid_offline(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """What is assigned to this device: the batches' terms and their vouchers by code hash (§7)."""
    from app.services import prepaid_voucher_offline as PVO

    out = PVO.download(db, machine)
    db.commit()
    return out


@router.post("/sync/{machine_id}/prepaid-vouchers/offline/sync", dependencies=FISCAL_MACHINE_TOKEN)
def sync_prepaid_offline(
    machine_id: str,
    body: PrepaidOfflineSyncIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """What this device redeemed without the cloud; idempotent by its own id (§7)."""
    from app.services import prepaid_voucher_offline as PVO

    out = PVO.sync(db, machine, body)
    db.commit()
    return out


@router.get("/prepaid-vouchers/analytics/tills")
def prepaid_voucher_tills_report(
    bucket: str = Query("day", description="hour | day"),
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"מימושים לפי קופה": one row per till."""
    return PVA.tills_report(db, current_user, active_tenant_id, _scope(scope), bucket=_given(bucket) or "day")


@router.get("/prepaid-vouchers/analytics/redemptions")
def prepaid_voucher_redemptions(
    limit: int = Query(100, ge=1, le=PVA.PAGE_MAX),
    offset: int = Query(0, ge=0),
    scope: PVA.Scope = Depends(voucher_scope),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The redemptions under the filters, newest first (a till's: `machineId`)."""
    return PVA.redemptions_list(db, current_user, active_tenant_id, _scope(scope), limit=limit, offset=offset)


# ── Voucher types (the spec's §2–3) ───────────────────────────────────────────


@router.get("/prepaid-vouchers/types")
def list_prepaid_voucher_types(
    company_id: Optional[str] = Query(None, alias="companyId"),
    include_inactive: bool = Query(True, alias="includeInactive"),
    include_one_off: bool = Query(False, alias="includeOneOff"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The types batches are issued from — the company's own and its parents' (`companyId`), else
    every company the caller sees. `includeOneOff`: also the types of single batches (made
    without a type, or before types).
    """
    from app.services import prepaid_voucher_types as PVT

    company_id = _given(company_id)
    include_inactive = True if _given(include_inactive) is None else include_inactive
    one_off = bool(_given(include_one_off))
    origins = ("manual", "batch", "legacy") if one_off else ("manual",)
    return {
        "items": PVT.list_types(
            db, current_user, active_tenant_id, company_id=company_id, include_inactive=include_inactive,
            origins=origins,
        ),
        # Whether this user sees / sets production prices at all (the `prepaid_voucher_prices` section).
        "pricesVisible": PVT.prices_visible(db, current_user),
        "pricesEditable": PVT.prices_visible(db, current_user, "edit"),
        # Whether this user sets a discount-block override (the `voucher_discount_override` section).
        "overrideEditable": PVT.override_editable(db, current_user),
    }


@router.post("/prepaid-vouchers/types", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_type(
    body: PrepaidVoucherTypeCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import prepaid_voucher_types as PVT

    t = PVT.create_type(db, current_user, active_tenant_id, body)
    db.commit()
    return PVT.type_out(db, current_user, t)


@router.get("/prepaid-vouchers/types/{type_id}")
def get_prepaid_voucher_type(
    type_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import prepaid_voucher_types as PVT

    return PVT.type_out(db, current_user, PVT.get_type(db, current_user, active_tenant_id, type_id))


@router.patch("/prepaid-vouchers/types/{type_id}")
def update_prepaid_voucher_type(
    type_id: str,
    body: PrepaidVoucherTypeUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Name, code, description, active in place; terms, goods or prices — a new version."""
    from app.services import prepaid_voucher_types as PVT

    t = PVT.update_type(db, current_user, active_tenant_id, type_id, body)
    db.commit()
    return PVT.type_out(db, current_user, t)


@router.get("/prepaid-vouchers/types/{type_id}/events")
def prepaid_voucher_type_events(
    type_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import prepaid_voucher_types as PVT

    return {"items": PVT.type_events(db, current_user, active_tenant_id, type_id)}


@router.post("/prepaid-vouchers/batches", status_code=status.HTTP_201_CREATED)
def create_prepaid_voucher_batch(
    body: PrepaidVoucherBatchCreate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
    response: Response = None,
    idempotency_key: Annotated[Optional[str], Header(alias="Idempotency-Key")] = None,
):
    """
    The batch and all its vouchers in one transaction, its answer built before the commit
    (app/services/prepaid_batch_create.py). `Idempotency-Key`: a retry gets the same batch back
    (200, `Idempotent-Replayed: true`), never a second one; the same key with another body → 422.
    `possibleDuplicate`: an identical batch the same user made a moment ago (a warning only).
    """
    from app.services import command_idempotency as idem
    from app.services import prepaid_batch_create as PBC

    out, replayed = PBC.create(db, current_user, active_tenant_id, body, key=idempotency_key)
    if replayed and response is not None:
        response.status_code = status.HTTP_200_OK
        response.headers[idem.REPLAY_HEADER] = "true"
    return out


@router.get("/prepaid-vouchers/batches/{batch_id}")
def get_prepaid_voucher_batch(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PV.batch_out(db, PV.get_batch(db, current_user, active_tenant_id, batch_id), user=current_user)


@router.post("/prepaid-vouchers/batches/{batch_id}/edit-preview")
def preview_prepaid_voucher_batch_edit(
    batch_id: str,
    body: PrepaidVoucherBatchUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "ערוך סדרה" before it is saved: each setting that changes (before → after, its category)
    and what it touches (`effects`: open vouchers, unredeemed / partly redeemed, the vouchers to
    issue, the serial a new production price starts at). Nothing is written.
    """
    out = PV.preview_batch_edit(db, current_user, active_tenant_id, batch_id, body)
    db.rollback()
    return out


@router.patch("/prepaid-vouchers/batches/{batch_id}")
def update_prepaid_voucher_batch(
    batch_id: str,
    body: PrepaidVoucherBatchUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.update_batch(db, current_user, active_tenant_id, batch_id, body)
    db.commit()
    return PV.batch_out(db, batch, user=current_user)


@router.post("/prepaid-vouchers/batches/{batch_id}/vouchers", status_code=status.HTTP_201_CREATED)
def add_prepaid_vouchers(
    batch_id: str,
    body: PrepaidVoucherAddIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.add_vouchers(db, current_user, active_tenant_id, batch_id, body.count, body.group_size)
    db.commit()
    return PV.batch_out(db, batch, user=current_user)


@router.post("/prepaid-vouchers/batches/{batch_id}/cancel")
def cancel_prepaid_voucher_batch(
    batch_id: str,
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    batch = PV.cancel_batch(db, current_user, active_tenant_id, batch_id, (body.reason if body else None))
    db.commit()
    return PV.batch_out(db, batch, user=current_user)


@router.get("/prepaid-vouchers/batches/{batch_id}/groups")
def prepaid_voucher_groups(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Per group: its serials, its vouchers and how many are unused / partly used / used / cancelled."""
    return PV.batch_groups(db, current_user, active_tenant_id, batch_id)


@router.post("/prepaid-vouchers/batches/{batch_id}/groups")
def assign_prepaid_voucher_groups(
    batch_id: str,
    body: PrepaidVoucherGroupsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Split the vouchers that have no group yet into groups of `groupSize` (409 when none is left)."""
    batch = PV.assign_groups(db, current_user, active_tenant_id, batch_id, body.group_size)
    db.commit()
    return PV.batch_out(db, batch, user=current_user)


@router.post("/prepaid-vouchers/batches/{batch_id}/groups/{group_no}/cancel")
def cancel_prepaid_voucher_group(
    batch_id: str,
    group_no: int,
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Cancel a whole group in one action (an envelope lost): its open vouchers are refused
    at every till from now on; used ones stay used. Logged with the reason.
    """
    out = PV.cancel_group(db, current_user, active_tenant_id, batch_id, group_no, (body.reason if body else None))
    db.commit()
    return out


@router.get("/prepaid-vouchers/batches/{batch_id}/events")
def prepaid_voucher_events(
    batch_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The batch's audit trail, newest first: made, issued, grouped, cancelled — by whom and why."""
    return PV.batch_events(db, current_user, active_tenant_id, batch_id)


@router.get("/prepaid-vouchers/batches/{batch_id}/vouchers")
def list_prepaid_vouchers(
    batch_id: str,
    status_filter: Optional[str] = Query(None, alias="status"),
    serial: Optional[int] = Query(None, ge=1),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    group: Optional[int] = Query(None, ge=1),
    code: Optional[str] = Query(None, max_length=100, description="The code under the barcode, or 4+ characters of it"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return PV.list_vouchers(
        db, current_user, active_tenant_id, batch_id,
        status_filter=status_filter, serial=serial, limit=limit, offset=offset,
        group_no=_given(group), code=_given(code),
    )


def _given(value):
    """A query parameter's value; None for the declaration itself (a direct call that left it out)."""
    from fastapi.params import Param

    return None if isinstance(value, Param) else value


@router.get("/prepaid-vouchers/batches/{batch_id}/file")
def prepaid_vouchers_file(
    batch_id: str,
    fmt: str = Query("pdf", alias="format", pattern="^(pdf|zip|groups|csv)$"),
    layout: str = Query("ticket80x50"),
    width: Optional[float] = Query(None, ge=30, le=300),
    height: Optional[float] = Query(None, ge=30, le=300),
    voucher_id: Optional[str] = Query(None, alias="voucherId"),
    include_used: bool = Query(True, alias="includeUsed"),
    group: Optional[int] = Query(None, ge=1),
    covers: bool = Query(True),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The vouchers as a file, drawn on the server (see app/services/prepaid_voucher_pdf.py):

    * `format=pdf` — one PDF, a page per voucher (or a sheet of several for `a4grid`);
      `group=n` narrows it to that group, opened by its cover sheet (`covers`).
    * `format=zip` — a ZIP with a PDF per voucher.
    * `format=groups` — production in groups: a ZIP with a PDF per group ("1000 in tens" is
      100 files of 10), each opened by its cover sheet, and the CSV manifest. 409
      `prepaid_voucher_not_grouped` for a batch with no groups.
    * `format=csv` — the manifest: every voucher of the batch (any status) with its code.

    `voucherId` narrows it to one voucher. Cancelled vouchers are never printed.
    """
    from fastapi import HTTPException

    from app.models.prepaid_voucher import PrepaidVoucher
    from app.services import prepaid_voucher_pdf as PDF
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    group = _given(group)
    covers = True if _given(covers) is None else covers
    batch = PV.get_batch(db, current_user, active_tenant_id, batch_id)
    pdf_name, zip_name = PDF.file_names(batch)
    base = pdf_name[:-4]

    if fmt == "csv":
        everything = (
            db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial).all()
        )
        return _attachment(PDF.manifest_csv(batch, everything), f"{base}_רשימת-קודים.csv", "text/csv; charset=utf-8", "csv")

    q = db.query(PrepaidVoucher).filter(
        PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.status != "cancelled"
    )
    if voucher_id:
        q = q.filter(PrepaidVoucher.id == PV._as_uuid(voucher_id))
    if not include_used:
        q = q.filter(PrepaidVoucher.status != "used")
    if group is not None:
        q = q.filter(PrepaidVoucher.group_no == group)
    vouchers = q.order_by(PrepaidVoucher.serial).all()
    groups_total = PV._last_group(db, batch.id)
    if fmt == "groups" and groups_total == 0:
        raise HTTPException(status_code=409, detail=PV.NOT_GROUPED)
    if not vouchers:
        raise HTTPException(status_code=404, detail="no_vouchers")

    zone = _load_zoneinfo(resolve_report_timezone(db, batch.tenant_id, None))
    opts = PDF.options_for(batch, zone)
    made = PDF._local_day(batch.created_at, zone)
    g = PDF.geometry(layout, width, height)
    logo = PDF.load_logo(batch.logo_url)
    issued = {r["group"]: (r["fromSerial"], r["toSerial"], r["total"]) for r in PV.groups_report(db, batch) if r["group"]}

    if fmt == "groups":
        everything = (
            db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial).all()
        )
        data, _ = PDF.render_groups_zip(
            batch, vouchers, g, groups_total=groups_total, group_ranges=issued, logo=logo, opts=opts,
            covers=covers, made=made, manifest=PDF.manifest_csv(batch, everything),
        )
        return _attachment(data, f"{base}_קבוצות.zip", "application/zip", "zip")
    if fmt == "zip":
        return _attachment(PDF.render_zip(batch, vouchers, g, logo=logo, opts=opts), zip_name, "application/zip", "zip")

    cover = None
    if group is not None and group in issued:
        low, high, total = issued[group]
        if covers:
            cover = PDF.GroupInfo(group=group, groups=groups_total, low=low, high=high, count=len(vouchers), issued=total)
        pdf_name = PDF.group_file_name(base, group, groups_total, low, high)
    elif voucher_id:
        pdf_name = f"{base}-{str(vouchers[0].serial).zfill(4)}.pdf"
    data = PDF.render_pdf(batch, vouchers, g, logo=logo, opts=opts, cover=cover, made=made)
    return _attachment(data, pdf_name, "application/pdf", "pdf")


def _attachment(data: bytes, name: str, media: str, ext: str):
    from fastapi.responses import Response
    from urllib.parse import quote

    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f"attachment; filename=\"vouchers.{ext}\"; filename*=UTF-8''{quote(name)}"},
    )


@router.get("/prepaid-vouchers/vouchers/{voucher_id}")
def get_prepaid_voucher(
    voucher_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.get_voucher(db, current_user, active_tenant_id, voucher_id)
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.post("/prepaid-vouchers/vouchers/{voucher_id}/cancel")
def cancel_prepaid_voucher(
    voucher_id: str,
    body: Optional[PrepaidVoucherCancelIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.cancel_voucher(db, current_user, active_tenant_id, voucher_id, (body.reason if body else None))
    db.commit()
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.put("/prepaid-vouchers/vouchers/{voucher_id}/note")
def set_prepaid_voucher_note(
    voucher_id: str,
    body: PrepaidVoucherNoteIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    voucher = PV.set_voucher_note(db, current_user, active_tenant_id, voucher_id, body.note)
    db.commit()
    return PV.voucher_out(db, voucher, with_redemptions=True)


@router.get("/prepaid-vouchers/batches/{batch_id}/report")
def prepaid_voucher_batch_report(
    batch_id: str,
    tz: Optional[str] = Query(None, description="IANA zone for hours and days; default the tenant's"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One batch over its life; reversed redemptions are left out everywhere."""
    return PVR.batch_report(db, current_user, active_tenant_id, batch_id, tz)


# ── Till ──────────────────────────────────────────────────────────────────────


@router.post("/sync/{machine_id}/prepaid-vouchers/lookup", dependencies=FISCAL_MACHINE_TOKEN)
def lookup_prepaid_voucher(
    machine_id: str,
    body: PrepaidVoucherLookupIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The voucher as this till sees it: its goods with what is left, the till's own
    product ids, and whether it can be redeemed here now (`redeemable`, else `reason`).
    A discount voucher: its kind, terms (`benefit`) and uses. A client that does not list
    the kind in `supportedKinds` gets it as not redeemable (`prepaid_voucher_kind_unsupported`,
    with a Hebrew `message`). A voucher whose terms need what the client did not list in
    `features` reads as `prepaid_voucher_update_required`. 404 `prepaid_voucher_not_found` for
    an unknown code or another tenant's.
    """
    return PV.lookup(db, machine, body.code, body.supported_kinds, features=body.features)


@router.post("/sync/{machine_id}/prepaid-vouchers/redeem", dependencies=FISCAL_MACHINE_TOKEN)
def redeem_prepaid_voucher(
    machine_id: str,
    body: PrepaidVoucherRedeemIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Take goods off a voucher, atomically. The same `clientRequestId` from this till
    returns the first answer (`replayed: true`). 409 with the reason when refused
    (used, cancelled, expired, not yet valid, wrong shop, partial not allowed,
    more than is left); 404 for an unknown code.
    """
    out = PV.redeem(db, machine, body)
    db.commit()
    return out


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/reverse", dependencies=FISCAL_MACHINE_TOKEN)
def reverse_prepaid_redemption(
    machine_id: str,
    redemption_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Undo a redemption this till took: the payment it was part of was abandoned, so the
    goods go back on the voucher. Idempotent. 404 for a redemption that is not this till's.
    """
    out = PV.reverse_redemption(db, machine, redemption_id)
    db.commit()
    return out


@router.post("/sync/{machine_id}/prepaid-vouchers/redemptions/{redemption_id}/transaction", dependencies=FISCAL_MACHINE_TOKEN)
def attach_prepaid_redemption_transaction(
    machine_id: str,
    redemption_id: str,
    body: dict,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Name the sale document a redemption paid towards: `{"transactionId": "…"}`."""
    from fastapi import HTTPException

    tx = str((body or {}).get("transactionId") or "").strip()
    if not tx:
        raise HTTPException(status_code=422, detail="transactionId required")
    PV.attach_transaction(db, machine, redemption_id, tx)
    db.commit()
    return {"ok": True}


@router.post("/sync/{machine_id}/prepaid-vouchers/reserve", dependencies=FISCAL_MACHINE_TOKEN)
def reserve_prepaid_voucher(
    machine_id: str,
    body: PrepaidVoucherReserveIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    Hold a discount voucher for this till's open sale (`saleRef`), checked against the
    basket sent (`lines`, agorot) under the shared rules: the discount it takes
    (`amountAgorot`, per line `shares`), the lines it leaves out and why (`skipped`), the
    lines whose promotion gives way (`dropPromotion`), the uses granted. Held until
    `expiresAt`; the same `clientRequestId` renews it. 409 with the reason when refused.
    """
    out = PV.reserve(db, machine, body)
    db.commit()
    return out


@router.post(
    "/sync/{machine_id}/prepaid-vouchers/reservations/{reservation_id}/confirm",
    dependencies=FISCAL_MACHINE_TOKEN,
)
def confirm_prepaid_reservation(
    machine_id: str,
    reservation_id: str,
    body: PrepaidVoucherConfirmIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    The sale was written (`transactionId`): the voucher's uses are taken. Idempotent; the
    document itself confirms it too when it reaches the cloud (the till's outbox). A breach
    found by the re-check is recorded in `flags`, never refused.
    """
    out = PV.confirm(db, machine, reservation_id, body.transaction_id, body.amount_agorot, body.uses, units=body.units)
    db.commit()
    return out


@router.post(
    "/sync/{machine_id}/prepaid-vouchers/reservations/{reservation_id}/release",
    dependencies=FISCAL_MACHINE_TOKEN,
)
def release_prepaid_reservation(
    machine_id: str,
    reservation_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """Give a held voucher back (removed, or the sale abandoned). Idempotent."""
    out = PV.release(db, machine, reservation_id)
    db.commit()
    return out
