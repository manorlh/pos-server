"""
Till anomalies — reading what each till did over a window, in a fixed number of grouped
queries (never one per till): its documents and money, the cash on its sales, how long it
was open, and the till events and drawer openings that support a cash finding.

The documents are the reports' (`scoped_documents`: the caller's role, `SALE_STATUSES`, a
credit note subtracting). The peers of a till are the other tills of its shop — or of its
event — so a till-level scope still reads the whole shop and reports on the one till.

"Open" is the till's shifts over the window, each counted at most `MAX_SHIFT_HOURS` (a shift
left open overnight is not a day's trading). A till that keeps no shifts falls back to the
hours in which it sold something.
"""
from __future__ import annotations

import dataclasses
import uuid as uuid_mod
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Sequence, Set

from sqlalchemy import case, distinct, func

from app.models.audit_exception import TillEvent
from app.models.cash_drawer import CashDrawerEvent
from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.services.areas import AREA_NONE
from app.services.reports import _is_refund_condition
from app.services.tenders import EXCHANGE_PAYMENT_METHOD, sale_condition, tender_amount_expr, tender_method_expr

from .analytics import BusinessClock, to_agorot
from .anomalies import MAX_SHIFT_HOURS, TillStats
from .data import InsightScope, _as_dt, _local_keys, clamp_window, scope_shops, scoped_documents


def _peer_scope(db, scope: InsightScope) -> InsightScope:
    """A till-level scope reads its shop (its peers); anything wider reads itself."""
    if scope.machine_id is None:
        return scope
    machine = scope.machine(db)
    return dataclasses.replace(scope, machine_id=None, shop_id=machine.shop_id if machine else scope.shop_id, _machine=None)


def scope_machines(db, scope: InsightScope) -> List[POSMachine]:
    """The tills compared: the event's, else the fiscal active tills of the scope's shops (and area)."""
    if scope.machine_ids is not None:
        ids = list(scope.machine_ids)
        return db.query(POSMachine).filter(POSMachine.id.in_(ids), POSMachine.tenant_id == scope.tenant_id).all() if ids else []
    shops = scope_shops(db, scope)
    if not shops:
        return []
    query = db.query(POSMachine).filter(
        POSMachine.shop_id.in_([s.id for s in shops]),
        POSMachine.tenant_id == scope.tenant_id,
        POSMachine.is_active.is_(True),
        POSMachine.is_fiscal.is_(True),
    )
    if scope.area_filter == AREA_NONE:
        query = query.filter(POSMachine.area_id.is_(None))
    elif scope.area_filter is not None:
        query = query.filter(POSMachine.area_id == scope.area_filter)
    return query.all()


def _kiosks(db, ids: Sequence[uuid_mod.UUID]) -> Set[str]:
    from app.services.z_table import kiosk_machine_ids

    return {str(i) for i in kiosk_machine_ids(db, ids)}


def _shift_hours(db, ids: Sequence[uuid_mod.UUID], start: datetime, end: datetime, now: datetime) -> Dict[str, float]:
    out: Dict[str, float] = {}
    if not ids:
        return out
    rows = (
        db.query(Shift.machine_id, Shift.opened_at, Shift.closed_at)
        .filter(Shift.machine_id.in_(list(ids)), Shift.opened_at < end)
        .filter((Shift.closed_at.is_(None)) | (Shift.closed_at > start))
        .all()
    )
    for machine_id, opened, closed in rows:
        opened = _as_dt(opened)
        closed = _as_dt(closed) or now
        upto = min(closed, end, opened + timedelta(hours=MAX_SHIFT_HOURS))
        span = (upto - max(opened, start)).total_seconds() / 3600
        if span > 0:
            out[str(machine_id)] = out.get(str(machine_id), 0.0) + span
    return out


def load_till_stats(
    db,
    scope: InsightScope,
    clock: BusinessClock,
    start: datetime,
    end: datetime,
    *,
    now: datetime,
) -> List[TillStats]:
    """Every compared till of the scope over [start, end), with its peer group."""
    start, end = clamp_window(scope, start, end)
    peer_scope = _peer_scope(db, scope)
    machines = scope_machines(db, peer_scope)
    query = scoped_documents(db, peer_scope, clock, start, end) if end > start else None

    # Tills that sold in the window but are no longer listed (moved, deactivated) still count.
    by_id: Dict[str, POSMachine] = {str(m.id): m for m in machines}
    if query is not None:
        listed = {m.id for m in machines}
        extra = [r[0] for r in query.with_entities(Transaction.machine_id).distinct().all() if r[0] not in listed]
        if extra:
            for m in db.query(POSMachine).filter(POSMachine.id.in_(extra)).all():
                if m.is_fiscal is not False:
                    by_id[str(m.id)] = m
    if not by_id:
        return []
    ids = [m.id for m in by_id.values()]
    shop_names = {s.id: s.name for s in db.query(Shop.id, Shop.name).filter(Shop.id.in_({m.shop_id for m in by_id.values() if m.shop_id})).all()}
    kiosks = _kiosks(db, ids)
    event = scope.event

    stats: Dict[str, TillStats] = {}
    for key, m in by_id.items():
        if event is not None:
            group, group_name = str(event.id), event.name
        else:
            group, group_name = str(m.shop_id), shop_names.get(m.shop_id)
        stats[key] = TillStats(
            machine_id=key, name=m.name or key, group=group, group_name=group_name,
            shop_id=str(m.shop_id) if m.shop_id else None, shop_name=shop_names.get(m.shop_id),
            kiosk=key in kiosks,
        )

    if query is not None:
        refund = _is_refund_condition()
        discount = func.coalesce(Transaction.document_discount, 0)
        for r in (
            query.with_entities(
                Transaction.machine_id,
                func.count(Transaction.id).label("docs"),
                func.coalesce(func.sum(case((refund, 0), else_=1)), 0).label("sales"),
                func.coalesce(func.sum(case((refund, -Transaction.total_amount), else_=Transaction.total_amount - discount)), 0).label("net"),
                func.coalesce(func.sum(case((refund, 0), else_=Transaction.total_amount)), 0).label("gross"),
                func.coalesce(func.sum(case((refund, 0), else_=discount)), 0).label("discounts"),
                func.coalesce(func.sum(case((refund, Transaction.total_amount), else_=0)), 0).label("refunds"),
                func.coalesce(func.sum(case((refund, 1), else_=0)), 0).label("refunds_count"),
            )
            .group_by(Transaction.machine_id)
            .all()
        ):
            s = stats.get(str(r.machine_id))
            if s is None:
                continue
            s.docs, s.sales = int(r.docs or 0), int(r.sales or 0)
            s.net, s.gross, s.discounts = to_agorot(r.net), to_agorot(r.gross), to_agorot(r.discounts)
            s.refunds, s.refunds_count = to_agorot(r.refunds), int(r.refunds_count or 0)

        # The cash on the sales: each leg (a leg-less document: its own tender and amount).
        method = func.lower(tender_method_expr())
        amount = tender_amount_expr()
        is_cash = method == "cash"
        for r in (
            query.filter(sale_condition())
            .outerjoin(TransactionPayment, TransactionPayment.transaction_id == Transaction.id)
            .with_entities(
                Transaction.machine_id,
                func.coalesce(func.sum(case((is_cash, amount), else_=0)), 0).label("cash"),
                func.coalesce(func.sum(case((method == EXCHANGE_PAYMENT_METHOD, 0), else_=amount)), 0).label("tendered"),
                func.count(distinct(case((is_cash, Transaction.id), else_=None))).label("cash_docs"),
            )
            .group_by(Transaction.machine_id)
            .all()
        ):
            s = stats.get(str(r.machine_id))
            if s is not None:
                s.cash, s.tendered, s.cash_docs = to_agorot(r.cash), to_agorot(r.tendered), int(r.cash_docs or 0)

    # Open hours: shifts, else the hours with a sale.
    hours = _shift_hours(db, ids, start, end, now)
    active: Dict[str, Set] = {}
    if query is not None:
        keys, decode = _local_keys(db, clock, Transaction.created_at)
        for row in query.with_entities(Transaction.machine_id, *[k.label(f"k{i}") for i, k in enumerate(keys)]).group_by(Transaction.machine_id, *keys).all():
            active.setdefault(str(row.machine_id), set()).add(decode(row))
    for key, s in stats.items():
        if hours.get(key, 0) > 0:
            s.open_hours, s.open_source = hours[key], "shifts"
        elif active.get(key):
            s.open_hours, s.open_source = float(len(active[key])), "activity"

    # Supporting evidence: voided lines, cancelled baskets, drawer openings without a sale.
    events = (
        db.query(TillEvent.machine_id, TillEvent.event_type, func.count(TillEvent.id))
        .filter(
            TillEvent.machine_id.in_(ids),
            TillEvent.occurred_at >= start,
            TillEvent.occurred_at < end,
            TillEvent.event_type.in_(("line_void", "basket_cancel", "drawer_open")),
        )
        .group_by(TillEvent.machine_id, TillEvent.event_type)
        .all()
    )
    till_opens: Dict[str, int] = {}
    for machine_id, kind, n in events:
        s = stats.get(str(machine_id))
        if s is None:
            continue
        if kind == "line_void":
            s.voids = int(n or 0)
        elif kind == "basket_cancel":
            s.cancels = int(n or 0)
        else:
            till_opens[str(machine_id)] = int(n or 0)
    drawer = dict(
        (str(m), int(n or 0))
        for m, n in db.query(CashDrawerEvent.machine_id, func.count(CashDrawerEvent.id))
        .filter(
            CashDrawerEvent.machine_id.in_(ids),
            CashDrawerEvent.occurred_at >= start,
            CashDrawerEvent.occurred_at < end,
            CashDrawerEvent.event_type == "MANUAL",
            CashDrawerEvent.result == "approved",
            CashDrawerEvent.training.is_(False),
        )
        .group_by(CashDrawerEvent.machine_id)
        .all()
    )
    for key, s in stats.items():
        # The same opening may arrive both ways (an older till's event and the drawer audit).
        s.no_sale_opens = max(till_opens.get(key, 0), drawer.get(key, 0))

    return list(stats.values())


def only_machine(cards: Iterable[dict], machine_id: Optional[uuid_mod.UUID]) -> List[dict]:
    """A till-level scope: its own cards only (its peers were read to judge it)."""
    if machine_id is None:
        return list(cards)
    return [c for c in cards if c["params"].get("machineId") == str(machine_id)]
