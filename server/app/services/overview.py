"""
The manager overview (לוח מנהל): today's takings as company › shop › area › till.

Built for a phone, so it is one request with a fixed number of grouped queries
whatever the size of the tree — never one per shop or per till:

* the visible shops (+ their companies) and the visible tills: two reads;
* the money: `_sales_buckets` grouped by till, by shop and by the area each
  document's shift was stamped with — the per-cashier report's own definition, so
  every figure here adds up to that report's (and an area's to the area report's)
  over the same day, and the levels add up to each other;
* the shops' live areas (points of sale): one read;
* each open shift's takings so far, grouped by shift: one read for the open shifts
  and one `_sales_buckets` over their documents, whatever day they started.

Who sees what is decided exactly as elsewhere, and twice on purpose:

* the **structure** (which shops and tills are listed) follows `GET /shops` and
  `GET /machines` — a company manager gets their company and its subsidiaries, a shop
  manager their shop, a distributor the tills they placed;
* the **money** goes through `build_scoped_transaction_query`, i.e.
  `scope_transactions_by_user`, the scoper every report and `/dashboard/stats` use.

The optional `companyId` / `shopId` / `machineId` narrow within that, and can never
widen it: a narrowing filter is AND-ed onto the role's.
"""
from __future__ import annotations

import uuid as uuid_mod
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.schemas.reports import (
    OverviewArea,
    OverviewCompany,
    OverviewKpis,
    OverviewMachine,
    OverviewResponse,
    OverviewShop,
)
from app.services.company_hierarchy import company_scope_ids, descendant_company_ids
from app.services.dashboard_stats import SALE_STATUSES
from app.services.permission_matrix import SHOP_SCOPED_ROLES
from app.services.reports import (
    ReportWindow,
    _cents,
    _new_sales_bucket,
    _sales_buckets,
    build_scoped_transaction_query,
)
from app.services.scoping import scope_transactions_by_user


def _visible_shops_query(db: Session, user: User, tenant_id):
    """`GET /shops`'s role rule, or None when the role sees no shop at all."""
    query = db.query(Shop).filter(Shop.tenant_id == tenant_id)
    if user.role == UserRole.COMPANY_MANAGER:
        return query.filter(Shop.company_id.in_(company_scope_ids(db, user)))
    if user.role in SHOP_SCOPED_ROLES:
        if not user.shop_id:
            return None
        return query.filter(Shop.id == user.shop_id)
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return query
    return None


def _visible_machines_query(db: Session, user: User, tenant_id, shop_ids: List[uuid_mod.UUID]):
    """`GET /machines`'s role rule, limited to active tills standing in `shop_ids`."""
    query = db.query(POSMachine).filter(
        POSMachine.tenant_id == tenant_id,
        POSMachine.is_active.is_(True),
        POSMachine.shop_id.in_(shop_ids),
    )
    if user.role == UserRole.DISTRIBUTOR:
        return query.filter(POSMachine.distributor_id == user.id)
    # Company and shop managers are already bounded by `shop_ids`, which came from
    # their own shop rule; super admin sees the tenant.
    return query


def _sales_fields(bucket: Dict[str, float]) -> dict:
    gross = _cents(bucket["gross"])
    discounts = _cents(bucket["discounts"])
    refunds = _cents(bucket["refunds"])
    return dict(
        sales_today=_cents(bucket["gross"] - bucket["discounts"] - bucket["refunds"]),
        gross=gross,
        discounts=discounts,
        refunds=refunds,
        documents_today=int(bucket["sales_count"]) + int(bucket["refunds_count"]),
        sales_count=int(bucket["sales_count"]),
        refunds_count=int(bucket["refunds_count"]),
        cash=_cents(bucket["cash_net"]),
        card=_cents(bucket["card_net"]),
        # `exchange` nets to zero over a complete basket; folded into "other" so
        # cash + card + other is the day's net, as on the area report's totals.
        other=_cents(bucket["other_net"] + bucket["exchange_net"]),
        tips=_cents(bucket["tips"]),
    )


def _add(into: Dict[str, float], bucket: Dict[str, float]) -> None:
    for key, value in bucket.items():
        into[key] += value


def _sort_key_number(number: Optional[int], name: str):
    return (number is None, number or 0, (name or "").lower())


def _sort_key_register(pos_number: Optional[str], name: str):
    raw = (pos_number or "").strip()
    n = int(raw) if raw.isdigit() and int(raw) > 0 else None
    return (n is None, n or 0, (name or "").lower())


def build_overview(
    db: Session,
    current_user: User,
    tenant_id: uuid_mod.UUID,
    window: ReportWindow,
    *,
    company_id: Optional[uuid_mod.UUID] = None,
    shop_id: Optional[uuid_mod.UUID] = None,
    machine_id: Optional[uuid_mod.UUID] = None,
) -> OverviewResponse:
    now = datetime.now(timezone.utc)

    # ── Structure ────────────────────────────────────────────────────────────
    shops: List[Shop] = []
    shops_q = _visible_shops_query(db, current_user, tenant_id)
    narrowed_companies: Optional[List[uuid_mod.UUID]] = None
    if company_id is not None:
        # A holding company means the group, as on `/dashboard/stats`.
        narrowed_companies = descendant_company_ids(db, company_id)
    if shops_q is not None:
        if narrowed_companies is not None:
            shops_q = shops_q.filter(Shop.company_id.in_(narrowed_companies))
        if shop_id is not None:
            shops_q = shops_q.filter(Shop.id == shop_id)
        shops = shops_q.all()

    shop_ids = [s.id for s in shops]
    machines: List[POSMachine] = []
    if shop_ids:
        machines_q = _visible_machines_query(db, current_user, tenant_id, shop_ids)
        if machine_id is not None:
            machines_q = machines_q.filter(POSMachine.id == machine_id)
        machines = machines_q.all()
    if machine_id is not None:
        # One till in scope: its shop is the only one worth listing.
        keep = {m.shop_id for m in machines}
        shops = [s for s in shops if s.id in keep]

    areas_by_shop: Dict[uuid_mod.UUID, List[ShopArea]] = {}
    if shops:
        for area in (
            db.query(ShopArea)
            .filter(
                ShopArea.shop_id.in_([s.id for s in shops]),
                ShopArea.archived_at.is_(None),
            )
            .all()
        ):
            areas_by_shop.setdefault(area.shop_id, []).append(area)

    company_ids = {s.company_id for s in shops if s.company_id is not None}
    companies = (
        db.query(Company).filter(Company.id.in_(company_ids)).all() if company_ids else []
    )

    # ── Money ────────────────────────────────────────────────────────────────
    tx_q = build_scoped_transaction_query(
        db, current_user, tenant_id, window, shop_id=shop_id, machine_id=machine_id,
    )
    if tx_q is not None and narrowed_companies is not None:
        tx_q = tx_q.filter(
            Transaction.shop_id.in_(
                db.query(Shop.id).filter(Shop.company_id.in_(narrowed_companies))
            )
        )
    by_machine = _sales_buckets(tx_q, Transaction.machine_id) if tx_q is not None else {}
    by_shop = _sales_buckets(tx_q, Transaction.shop_id) if tx_q is not None else {}
    # Stamped, not joined: the area a document's shift was created in, never the
    # till's area now (app.services.areas). No shift, or no area: the null bucket.
    by_area = (
        _sales_buckets(tx_q, Shift.area_id, joins=((Shift, Shift.id == Transaction.shift_id),))
        if tx_q is not None and areas_by_shop
        else {}
    )

    # Open shifts: what each has taken so far, from its own documents (not the day's).
    open_shift_of: Dict[uuid_mod.UUID, uuid_mod.UUID] = {}
    by_shift: Dict[object, Dict[str, float]] = {}
    if machines:
        open_shift_of = {
            machine: shift
            for shift, machine in db.query(Shift.id, Shift.machine_id).filter(
                Shift.status == ShiftStatus.OPEN,
                Shift.machine_id.in_([m.id for m in machines]),
            )
        }
    if open_shift_of:
        shift_q = scope_transactions_by_user(
            db.query(Transaction).filter(
                Transaction.tenant_id == tenant_id,
                Transaction.status.in_(SALE_STATUSES),
                Transaction.shift_id.in_(list(open_shift_of.values())),
            ),
            current_user,
            db,
        )
        if shift_q is not None:
            by_shift = _sales_buckets(shift_q, Transaction.shift_id)

    def bucket_of(agg, key) -> Dict[str, float]:
        # Keys come back as UUIDs on Postgres and may come back as text elsewhere.
        return agg.get(key) or agg.get(str(key)) or _new_sales_bucket()

    # Whole scope = every shop's documents, including a shop's takings that the
    # structure does not list (a till since decommissioned still sold today).
    total = _new_sales_bucket()
    for key, bucket in by_shop.items():
        if key is not None:
            _add(total, bucket)

    machines_by_shop: Dict[uuid_mod.UUID, List[POSMachine]] = {}
    for m in machines:
        machines_by_shop.setdefault(m.shop_id, []).append(m)

    def shop_node(shop: Shop) -> OverviewShop:
        tills = sorted(
            machines_by_shop.get(shop.id, []),
            key=lambda m: _sort_key_register(m.pos_number, m.name),
        )
        return OverviewShop(
            id=shop.id,
            number=shop.shop_number,
            name=shop.name,
            machines=[
                OverviewMachine(
                    id=m.id,
                    pos_number=m.pos_number,
                    name=m.name,
                    area_id=m.area_id,
                    **open_shift_fields(m),
                    **_sales_fields(bucket_of(by_machine, m.id)),
                )
                for m in tills
            ],
            areas=[
                OverviewArea(
                    id=area.id,
                    name=area.name,
                    sort_order=area.sort_order or 0,
                    machine_ids=[m.id for m in tills if m.area_id == area.id],
                    **_sales_fields(bucket_of(by_area, area.id)),
                )
                for area in sorted(
                    areas_by_shop.get(shop.id, []),
                    key=lambda a: (a.sort_order or 0, (a.name or "").lower()),
                )
            ],
            **_sales_fields(bucket_of(by_shop, shop.id)),
        )

    def open_shift_fields(m: POSMachine) -> dict:
        shift_id = open_shift_of.get(m.id)
        if shift_id is None:
            return {}
        bucket = bucket_of(by_shift, shift_id)
        return dict(
            open_shift_id=shift_id,
            open_shift_sales=_cents(bucket["gross"] - bucket["discounts"] - bucket["refunds"]),
            open_shift_documents=int(bucket["sales_count"]) + int(bucket["refunds_count"]),
        )

    shops_by_company: Dict[uuid_mod.UUID, List[Shop]] = {}
    for s in shops:
        shops_by_company.setdefault(s.company_id, []).append(s)

    company_nodes: List[OverviewCompany] = []
    for company in sorted(companies, key=lambda c: _sort_key_number(c.company_number, c.name)):
        own = sorted(
            shops_by_company.get(company.id, []),
            key=lambda s: _sort_key_number(s.shop_number, s.name),
        )
        company_total = _new_sales_bucket()
        for s in own:
            _add(company_total, bucket_of(by_shop, s.id))
        company_nodes.append(
            OverviewCompany(
                id=company.id,
                number=company.company_number,
                name=company.name,
                parent_company_id=company.parent_company_id,
                shops=[shop_node(s) for s in own],
                **_sales_fields(company_total),
            )
        )

    kpi_fields = _sales_fields(total)
    sales_count = kpi_fields["sales_count"]
    average_ticket = (
        _cents((total["gross"] - total["discounts"]) / sales_count) if sales_count else 0.0
    )
    return OverviewResponse(
        window=window.to_schema(),
        generated_at=now,
        kpis=OverviewKpis(average_ticket=average_ticket, **kpi_fields),
        companies=company_nodes,
    )
