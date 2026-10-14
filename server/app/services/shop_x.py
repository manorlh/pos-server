"""
"דוח X סניפי" — the shop-wide interim X (P:/specs/shop-x-report.md).

An X of **every till of a shop** for its open period: non-closing, unnumbered, no
accounting document. Nothing here writes a Z, draws a number, claims a shift or changes a
document — it reads what the cloud holds and says it.

**The period** (§1): per till, its shifts no Z has taken yet in this shop (open ones too) —
since the last shop Z for a till in the shop Z, since its own last Z for a till in
`zMode = till` (its own Z claims its shifts, so `z_builder.unreported_shifts` is both).
Each till's shifts are the ones its kind of Z would take (`document_filing.taken_by`).

**The figures** are the Z builder's, over the same shifts, by the same code
(`shift_totals.compute_totals`, `z_builder.machine_section`, `z_builder.till_cash_summary`,
`transmissions.period_block`) — so the X and the Z that later closes the period agree to the
agora. Two differences, both an X's:

* An **open** shift has no frozen figures yet: its cash takings and cash tips come from its
  documents now, and its Cash In / Cash Out / deposits from the movements its till uploaded
  (`cash_movements`), read through a view of the shift (`_ShiftView`) by the same drawer maths.
* The drawer is reckoned **with** the movements (opening + cash sales + Cash In − Cash Out −
  deposits), as every till's X is (§1 "קרן, מכירות במזומן, הכנסות והוצאות"); a kiosk has no
  drawer and none.

Beside the Z's figures, the X says (§1): voids (line voids and cancelled baskets, the till
events), OTH lines ("על חשבון הבית", at their list price), table cancels, the open tables now,
and per till its untransmitted card legs, its shift and when it was last updated.

**Refresh** (§2): before building, the shop's online tills get `sync_now` ("שלח עכשיו", the
same command as "סנכרן עכשיו") and the cloud waits up to `shopXRefreshSec` seconds for their
answers. A till that did not answer, or still reports documents not sent (its sync status,
#107), is marked on the report — "קופה 3 — לא עודכנה מאז 20:10, 4 מסמכים ממתינים" — and the
report is built anyway.

**Where it shows** (§3): `shopXTills` all | selected | master | off (`available_on`).
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.services import till_parameters as TP
from app.services import z_expected_cash as ZEC
from app.services.shift_totals import CENT, DocumentTotals, compute_totals

logger = logging.getLogger(__name__)

TITLE = "דוח X סניפי"
HEADLINE = "דוח X סניפי — דוח ביניים, אינו סוגר יום"
#: The till event that journals every run (who, from which till, when) — never an exception.
JOURNAL_EVENT = "shop_x_report"

ZERO = Decimal("0")

#: `shopXTills` — where the report is offered.
TILLS_ALL, TILLS_SELECTED, TILLS_MASTER, TILLS_OFF = "all", "selected", "master", "off"
TILLS_MODES = (TILLS_ALL, TILLS_SELECTED, TILLS_MASTER, TILLS_OFF)


# ── Parameters ────────────────────────────────────────────────────────────────


def _flag(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on", "כן")


def till_ids_of(value: Any) -> List[str]:
    """`shopXTillIds` as the till ids it names (commas, spaces or a JSON-ish list; junk dropped)."""
    if value is None:
        return []
    raw = value if isinstance(value, (list, tuple)) else str(value).replace("[", "").replace("]", "").replace('"', "")
    items = raw if isinstance(raw, (list, tuple)) else raw.replace(";", ",").replace(" ", ",").split(",")
    out: List[str] = []
    for item in items:
        try:
            ident = str(uuid.UUID(str(item).strip()))
        except (ValueError, AttributeError, TypeError):
            continue
        if ident not in out:
            out.append(ident)
    return out


def till_ids_value(ids: Sequence[Any]) -> str:
    """The stored `shopXTillIds`: the ids, comma separated, each once (empty: none)."""
    return ",".join(till_ids_of(list(ids)))


@dataclass(frozen=True)
class Settings:
    tills: str = TILLS_ALL
    till_ids: Tuple[str, ...] = ()
    refresh_sec: int = TP.SHOP_X_REFRESH_SEC_DEFAULT
    per_till: bool = True
    per_employee: bool = False


def settings_of(params: Dict[str, Any]) -> Settings:
    """The five `shopX*` parameters as resolved (a missing one: its default)."""
    mode = str(params.get(TP.SHOP_X_TILLS_KEY) or TILLS_ALL).strip().lower()
    refresh = params.get(TP.SHOP_X_REFRESH_SEC_KEY)
    try:
        refresh = int(refresh) if refresh is not None and not isinstance(refresh, bool) else TP.SHOP_X_REFRESH_SEC_DEFAULT
    except (TypeError, ValueError):
        refresh = TP.SHOP_X_REFRESH_SEC_DEFAULT
    return Settings(
        tills=mode if mode in TILLS_MODES else TILLS_ALL,
        till_ids=tuple(till_ids_of(params.get(TP.SHOP_X_TILL_IDS_KEY))),
        refresh_sec=max(TP.SHOP_X_REFRESH_SEC_MIN, min(TP.SHOP_X_REFRESH_SEC_MAX, refresh)),
        per_till=_flag(params.get(TP.SHOP_X_PER_TILL_KEY), True),
        per_employee=_flag(params.get(TP.SHOP_X_PER_EMPLOYEE_KEY), False),
    )


def machine_settings(db: Session, machine: POSMachine) -> Settings:
    try:
        return settings_of(TP.till_parameters_for_machine(db, machine).parameters)
    except Exception:  # noqa: BLE001 - the defaults, never a failed report
        logger.exception("shop x: parameters of %s unreadable", getattr(machine, "id", None))
        return Settings()


def shop_settings(db: Session, shop: Shop) -> Settings:
    """The parameters at the shop's level (shop → company → default): the dashboard's report."""
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameter, TillParameterValue

    try:
        chain = TP.TillScopeChain(machine_id=None, shop_id=shop.id, company_id=shop.company_id)
        parameters = db.query(TillParameter).all()
        on_chain = [
            and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
            for kind, ident in chain.scopes()
        ]
        values = db.query(TillParameterValue).filter(or_(*on_chain)).all() if on_chain else []
        return settings_of(TP.resolve_till_parameters(parameters, values, chain).parameters)
    except Exception:  # noqa: BLE001
        logger.exception("shop x: parameters of shop %s unreadable", getattr(shop, "id", None))
        return Settings()


def is_master(db: Session, machine: POSMachine) -> bool:
    """The shop Z's master till: the one "סגירת Z סניפי" runs from (app/services/main_till.py)."""
    from app.services import main_till as MT

    try:
        return MT.till_shop_z_refusal(db, machine) is None
    except Exception:  # noqa: BLE001
        return False


def available_on(db: Session, machine: POSMachine, settings: Optional[Settings] = None) -> Tuple[bool, Optional[str]]:
    """
    Whether "דוח X סניפי" shows on this till (`shopXTills`), and if not why: `off`,
    `not_selected` (selected mode, this till not in `shopXTillIds`), `not_master`.
    """
    settings = settings or machine_settings(db, machine)
    if machine.shop_id is None:
        return False, "machine_has_no_shop"
    if settings.tills == TILLS_OFF:
        return False, "off"
    if settings.tills == TILLS_SELECTED and str(machine.id) not in settings.till_ids:
        return False, "not_selected"
    if settings.tills == TILLS_MASTER and not is_master(db, machine):
        return False, "not_master"
    return True, None


# ── The period ────────────────────────────────────────────────────────────────


class _ShiftView:
    """
    A shift as the drawer maths read it. A closed shift is itself (its figures and movements
    frozen on its close); an open one takes its cash takings and cash tips from its documents
    now and its movements from what its till uploaded (`cash_movements`).
    """

    def __init__(self, shift: Shift, totals: Optional[DocumentTotals] = None, movements: Optional[ZEC.Movements] = None):
        self._shift = shift
        self.id = shift.id
        self.sequence_number = shift.sequence_number
        self.opened_at = shift.opened_at
        self.closed_at = shift.closed_at
        self.business_date = shift.business_date
        self.status = shift.status
        self.opening_cash = shift.opening_cash
        self.counted_cash = shift.counted_cash
        self.reconstructed = bool(getattr(shift, "reconstructed", False))
        self.unattended = bool(getattr(shift, "unattended", False))
        till = dict(shift.till_totals) if isinstance(shift.till_totals, dict) else {}
        if totals is None:
            self.total_cash = shift.total_cash
            self.total_cash_tips = shift.total_cash_tips
        else:
            self.total_cash = totals.total_cash
            self.total_cash_tips = totals.total_cash_tips
        if movements is not None:
            cash_in, cash_out, deposits = movements
            for key, amount in ((ZEC.CASH_IN, cash_in), (ZEC.CASH_OUT, cash_out), (ZEC.DEPOSITS, deposits)):
                till[key] = str(amount)
        self.till_totals = till


def cash_movements(db: Session, shift_ids: Sequence[uuid.UUID]) -> Dict[Any, ZEC.Movements]:
    """{shift id: (Cash In, Cash Out, deposits)} from the movements the tills uploaded (training ones left out)."""
    from app.models.cash_drawer import CashMovement

    ids = [i for i in shift_ids if i is not None]
    if not ids:
        return {}
    out: Dict[Any, List[Decimal]] = {}
    for row in db.query(CashMovement).filter(CashMovement.shift_id.in_(ids)).all():
        if getattr(row, "training", False):
            continue
        slot = {"cash_in": 0, "cash_out": 1, "deposit": 2}.get(row.movement_type)
        if slot is None:
            continue
        acc = out.setdefault(row.shift_id, [ZERO, ZERO, ZERO])
        acc[slot] += abs(Decimal(str(row.amount or 0)))
    return {k: (v[0], v[1], v[2]) for k, v in out.items()}


def till_period(db: Session, machine: POSMachine, shop_id: uuid.UUID) -> List[Shift]:
    """The till's shifts in the open period, oldest first — what its next Z would take."""
    from app.services.document_filing import taken_by
    from app.services.z_builder import Z_MODE_CLOUD, Z_MODE_TILL, unreported_shifts

    kind = Z_MODE_TILL if getattr(machine, "z_mode", None) == Z_MODE_TILL else Z_MODE_CLOUD
    return [s for s in unreported_shifts(db, machine.id, shop_id=shop_id) if taken_by(s, kind)]


# ── The X's own lines: voids, OTH, table cancels, open tables ─────────────────


def _period_start(shifts: Sequence[Any]) -> Optional[datetime]:
    starts = [_aware(s.opened_at) for s in shifts if s.opened_at is not None]
    return min(starts) if starts else None


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _money(value: Any) -> Optional[str]:
    return None if value is None else str(Decimal(str(value)).quantize(CENT))


def till_events(db: Session, machine: POSMachine, since: Optional[datetime]) -> Dict[str, Dict[str, Any]]:
    """Line voids, cancelled baskets and cancelled tables of the till since `since`: {type: {count, amount}}."""
    from sqlalchemy import func

    from app.models.audit_exception import TillEvent

    out = {k: {"count": 0, "amount": ZERO} for k in ("line_void", "basket_cancel", "table_cancelled")}
    if since is None:
        return out
    rows = (
        db.query(TillEvent.event_type, func.count(TillEvent.id), func.coalesce(func.sum(TillEvent.amount), 0))
        .filter(
            TillEvent.machine_id == machine.id,
            TillEvent.event_type.in_(list(out)),
            TillEvent.occurred_at >= since,
        )
        .group_by(TillEvent.event_type)
        .all()
    )
    for kind, count, amount in rows:
        out[kind] = {"count": int(count or 0), "amount": abs(Decimal(str(amount or 0)))}
    return out


def oth_lines(db: Session, shift_ids: Sequence[uuid.UUID], machine_id: Any) -> Dict[str, Any]:
    """OTH ("על חשבון הבית") lines of the till's counted sales: how many, and their list price."""
    from app.models.transaction import Transaction
    from app.models.transaction_item import TransactionItem
    from app.services.dashboard_stats import SALE_STATUSES

    ids = list(shift_ids)
    if not ids:
        return {"count": 0, "amount": ZERO}
    count, amount = 0, ZERO
    for qty, unit in (
        db.query(TransactionItem.quantity, TransactionItem.unit_price)
        .join(Transaction, Transaction.id == TransactionItem.transaction_id)
        .filter(
            Transaction.shift_id.in_(ids),
            Transaction.machine_id == machine_id,
            Transaction.status.in_(list(SALE_STATUSES)),
            TransactionItem.oth_reason.isnot(None),
        )
        .all()
    ):
        count += 1
        amount += abs(Decimal(str(qty or 0)) * Decimal(str(unit or 0)))
    return {"count": count, "amount": amount.quantize(CENT)}


def discounted_documents(db: Session, shift_ids: Sequence[uuid.UUID], machine_id: Any) -> int:
    """The counted sales with a discount on them (the document's or a line's)."""
    from sqlalchemy import or_

    from app.models.transaction import Transaction
    from app.models.transaction_item import TransactionItem
    from app.services.dashboard_stats import SALE_STATUSES

    ids = list(shift_ids)
    if not ids:
        return 0
    line = (
        db.query(TransactionItem.transaction_id)
        .filter(or_(TransactionItem.line_discount > 0, TransactionItem.promotion_discount > 0))
    )
    return (
        db.query(Transaction.id)
        .filter(
            Transaction.shift_id.in_(ids),
            Transaction.machine_id == machine_id,
            Transaction.status.in_(list(SALE_STATUSES)),
            or_(Transaction.document_discount > 0, Transaction.id.in_(line)),
        )
        .count()
    )


def open_tables(db: Session, shop: Shop) -> Dict[str, Any]:
    """The shop's open tables now (`GET /insights/tables-live`'s source): how many, and their amount."""
    try:
        from app.services.insights.data import InsightScope, load_open_tables

        data = load_open_tables(db, InsightScope(user=None, tenant_id=shop.tenant_id, shop_id=shop.id), [shop])
        total = sum(int(o.total or 0) for o in data.open_orders)
        return {"count": len(data.open_orders), "amount": _money(Decimal(total) / 100)}
    except Exception:  # noqa: BLE001 - informational
        logger.exception("shop x: open tables of %s unreadable", shop.id)
        return {"count": 0, "amount": "0.00"}


# ── Refresh (§2) ──────────────────────────────────────────────────────────────


@dataclass
class Refresh:
    """What the pre-build refresh did: the tills asked, and the ones that answered."""

    requested: bool = False
    asked: List[str] = field(default_factory=list)
    answered: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)
    waited_sec: float = 0.0
    timeout_sec: int = 0

    def out(self) -> Dict[str, Any]:
        return {
            "requested": self.requested,
            "asked": len(self.asked),
            "answered": len(self.answered),
            "failed": len(self.failed),
            "waitedSec": round(self.waited_sec, 1),
            "timeoutSec": self.timeout_sec,
        }


#: How long a refresh's `sync_now` waits for its till before it lapses (a till that comes back
#: later has nothing to send it for).
REFRESH_COMMAND_TTL = timedelta(minutes=2)
POLL_SEC = 0.5


def refresh_tills(
    db: Session,
    shop: Shop,
    tills: Sequence[POSMachine],
    *,
    requester: Optional[POSMachine],
    by_name: Optional[str],
    wait_sec: int,
    now: Optional[datetime] = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Refresh:
    """
    "שלח עכשיו" to every online till of the shop (the requester has just sent its own) and wait
    up to `wait_sec` for their answers. Commits (the tills must see the commands). Never raises.
    """
    from app.models.device_command import FINAL_STATUSES, DeviceCommand
    from app.services import device_commands as DC
    from app.services.machine_status import is_online
    from app.services.z_runs import is_seated_in

    now = now or datetime.now(timezone.utc)
    result = Refresh(requested=True, timeout_sec=int(wait_sec))
    targets = [
        m for m in tills
        if is_seated_in(m, shop.id)
        and is_online(m.last_heartbeat_at, now=now)
        and (requester is None or m.id != requester.id)
    ]
    if not targets:
        return result
    try:
        rows = DC.create(
            db, targets, "sync_now", by_name=(by_name or TITLE)[:200],
            source="till" if requester is not None else "dashboard", now=now, expires_in=REFRESH_COMMAND_TTL,
        )
        ids = [r.id for r in rows]
        result.asked = [str(r.machine_id) for r in rows]
        db.commit()
        DC.wake(targets)
    except Exception:  # noqa: BLE001 - the report is built anyway
        logger.exception("shop x: refresh not sent for shop %s", shop.id)
        db.rollback()
        return result
    started = clock()
    while True:
        db.expire_all()
        states = db.query(DeviceCommand.machine_id, DeviceCommand.status).filter(DeviceCommand.id.in_(ids)).all()
        result.answered = [str(mid) for mid, st in states if st == "done"]
        result.failed = [str(mid) for mid, st in states if st in ("failed", "refused")]
        if all(st in FINAL_STATUSES for _mid, st in states):
            break
        if clock() - started >= wait_sec:
            break
        sleep(POLL_SEC)
    result.waited_sec = clock() - started
    return result


def _since_text(moment: Optional[datetime], tzinfo, now: datetime) -> str:
    if moment is None:
        return "—"
    local = moment.astimezone(tzinfo) if tzinfo is not None else moment
    today = now.astimezone(tzinfo).date() if tzinfo is not None else now.date()
    return local.strftime("%H:%M") if local.date() == today else local.strftime("%d/%m %H:%M")


def till_label(machine: POSMachine) -> str:
    if getattr(machine, "is_kiosk", False):
        return f"קיוסק {machine.name}" if machine.name else "קיוסק"
    return f"קופה {machine.pos_number}" if machine.pos_number not in (None, "") else (machine.name or "קופה")


def freshness(
    machine: POSMachine, *, refresh: Optional[Refresh], has_open_shift: bool, now: datetime, tzinfo,
) -> Dict[str, Any]:
    """
    How current the cloud's copy of this till is (§2.3): its outbox as last reported (sync
    status), when it was last updated, and whether to warn — no answer to the refresh with an
    open shift, or documents still waiting to be sent.
    """
    from app.services import sync_status as SS
    from app.services.machine_status import is_online
    from app.services.z_runs import _reported_pending_documents

    box = SS.outbox_out(machine)
    pending = int(box["documents"]) if box is not None else _reported_pending_documents(machine)
    reported_at = SS.parse_moment(box.get("reportedAt")) if box is not None else None
    oldest = SS.parse_moment(box.get("oldestAt")) if box is not None else None
    heartbeat = _aware(machine.last_heartbeat_at)
    last_update = reported_at or heartbeat
    online = is_online(machine.last_heartbeat_at, now=now)
    asked = refresh is not None and str(machine.id) in refresh.asked
    answered = refresh is not None and str(machine.id) in refresh.answered
    # Asked and silent, or out of reach (never asked): with a shift open it may hold more than the cloud.
    # The requester was not asked — it sent its own before asking.
    no_answer = bool(
        refresh is not None and refresh.requested and has_open_shift
        and ((asked and not answered) or not online)
    )
    since = oldest if (pending > 0 and oldest is not None) else last_update
    warn = no_answer or pending > 0
    text = None
    if warn:
        text = f"{till_label(machine)} — לא עודכנה מאז {_since_text(since, tzinfo, now)}"
        if pending > 0:
            text += f", {pending} מסמכים ממתינים"
        elif not online:
            text += " (לא מחוברת)"
    return {
        "online": online,
        "refreshAsked": asked,
        "refreshAnswered": answered,
        "pendingDocuments": pending,
        "lastUpdatedAt": last_update.isoformat() if last_update else None,
        "staleSince": since.isoformat() if (warn and since) else None,
        "warning": text,
    }


# ── The report ────────────────────────────────────────────────────────────────


@dataclass
class TillPart:
    machine: POSMachine
    shifts: List[Shift]
    views: List[_ShiftView]
    totals: DocumentTotals
    with_movements: bool


def _part(db: Session, machine: POSMachine, shop_id: uuid.UUID) -> TillPart:
    shifts = till_period(db, machine, shop_id)
    open_ids = [s.id for s in shifts if s.status != ShiftStatus.CLOSED]
    moved = cash_movements(db, open_ids)
    views = [
        _ShiftView(s, compute_totals(db, [s.id]), moved.get(s.id, ZEC.NONE)) if s.status != ShiftStatus.CLOSED else _ShiftView(s)
        for s in shifts
    ]
    totals = compute_totals(db, [s.id for s in shifts]) if shifts else DocumentTotals()
    return TillPart(machine, shifts, views, totals, not bool(getattr(machine, "is_kiosk", False)))


def _counted_amount(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {"count": int(entry["count"]), "amount": _money(entry["amount"])}


def build(
    db: Session,
    shop: Shop,
    *,
    settings: Settings,
    refresh: Optional[Refresh] = None,
    requester: Optional[POSMachine] = None,
    requested_by: Optional[str] = None,
    tzinfo=None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The report as JSON (money as decimal strings, like a Z's sections). Reads only.
    `settings.per_till` / `per_employee` add the per-till and per-employee sections.
    """
    from app.services.transmissions import period_block
    from app.services.z_builder import machine_section, z_cash_summary
    from app.services.z_runs import shop_tills
    from app.services.z_waiters import waiter_breakdown

    now = now or datetime.now(timezone.utc)
    tills = shop_tills(db, shop.id)
    parts = [_part(db, m, shop.id) for m in tills]
    # A till that left the shop with nothing of the period here is nobody's concern.
    parts = [p for p in parts if p.shifts or p.machine.shop_id == shop.id]

    overall = DocumentTotals()
    for p in parts:
        overall.add(p.totals)
    cash = z_cash_summary([p.views for p in parts], [p.with_movements for p in parts])
    sections: List[Dict[str, Any]] = []
    voids = {"count": 0, "amount": ZERO}
    cancels = {"count": 0, "amount": ZERO}
    tables_cancelled = {"count": 0, "amount": ZERO}
    oth = {"count": 0, "amount": ZERO}
    discounted = 0
    untransmitted: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    for p in sorted(parts, key=lambda p: _pos_order(p.machine)):
        m = p.machine
        section = machine_section(m, p.views, p.totals, p.with_movements)  # type: ignore[arg-type]
        block = period_block(db, m, p.shifts, now=now)
        section["transmission"] = block
        events = till_events(db, m, _period_start(p.shifts))
        till_oth = oth_lines(db, [s.id for s in p.shifts], m.id)
        till_discounted = discounted_documents(db, [s.id for s in p.shifts], m.id)
        open_shift = next((s for s in p.shifts if s.status != ShiftStatus.CLOSED), None)
        fresh = freshness(m, refresh=refresh, has_open_shift=open_shift is not None, now=now, tzinfo=tzinfo)
        section.update({
            "label": till_label(m),
            "zMode": "till" if getattr(m, "z_mode", None) == "till" else "shop",
            "self": requester is not None and m.id == requester.id,
            "periodStart": _period_start(p.shifts).isoformat() if p.shifts else None,
            "shift": None if open_shift is None else {
                "id": str(open_shift.id),
                "status": "open",
                "sequenceNumber": open_shift.sequence_number,
                "openedAt": _aware(open_shift.opened_at).isoformat() if open_shift.opened_at else None,
                "openedBy": open_shift.opened_by,
            },
            "shiftState": "open" if open_shift is not None else ("closed" if p.shifts else "none"),
            "voids": _counted_amount(events["line_void"]),
            "basketCancels": _counted_amount(events["basket_cancel"]),
            "tableCancels": _counted_amount(events["table_cancelled"]),
            "oth": _counted_amount(till_oth),
            "discountedDocuments": till_discounted,
            "untransmittedLegs": int(block.get("untransmittedLegs") or 0),
            "untransmittedAmount": block.get("untransmittedAmount") or "0.00",
            **fresh,
        })
        sections.append(section)
        for acc, entry in ((voids, events["line_void"]), (cancels, events["basket_cancel"]),
                           (tables_cancelled, events["table_cancelled"]), (oth, till_oth)):
            acc["count"] += entry["count"]
            acc["amount"] += entry["amount"]
        discounted += till_discounted
        if section["untransmittedLegs"]:
            untransmitted.append({
                "machineId": str(m.id), "label": section["label"],
                "legs": section["untransmittedLegs"], "amount": section["untransmittedAmount"],
            })
        if fresh["warning"]:
            warnings.append({"machineId": str(m.id), "label": section["label"], "text": fresh["warning"],
                             "pendingDocuments": fresh["pendingDocuments"], "staleSince": fresh["staleSince"]})

    all_shifts = [s for p in parts for s in p.shifts]
    period_start = _period_start(all_shifts)
    movements = cash["cash_movements"] or ZEC.NONE
    report: Dict[str, Any] = {
        "kind": "shop_x",
        "title": TITLE,
        "headline": HEADLINE,
        "closing": False,
        "number": None,
        "shopId": str(shop.id),
        "shopName": shop.name,
        "generatedAt": now.isoformat(),
        "requestedBy": requested_by,
        "requestedFrom": None if requester is None else {
            "machineId": str(requester.id), "posNumber": requester.pos_number, "name": requester.name,
        },
        "periodStart": period_start.isoformat() if period_start else None,
        "settings": {
            "tills": settings.tills, "perTill": settings.per_till, "perEmployee": settings.per_employee,
            "refreshSec": settings.refresh_sec,
        },
        "refresh": (refresh or Refresh()).out(),
        "warnings": warnings,
        "summary": {
            "tills": len(parts),
            "shiftCount": len(all_shifts),
            "openShifts": sum(1 for s in all_shifts if s.status != ShiftStatus.CLOSED),
            "documents": overall.transactions_count,
            "salesCount": overall.sales_count,
            "grossSales": _money(overall.gross_sales),
            "netSales": _money(overall.net_sales),
            "totalSales": _money(overall.total_sales),
            "vatTotal": _money(overall.vat_total),
            "refunds": {"count": overall.credit_notes_count, "amount": _money(overall.total_refunds)},
            "discounts": {"count": discounted, "amount": _money(overall.discounts_total)},
            "voids": _counted_amount(voids),
            "basketCancels": _counted_amount(cancels),
            "oth": _counted_amount(oth),
            "tableCancels": _counted_amount(tables_cancelled),
            "payments": tender_buckets(overall.breakdown_json()),
            "paymentBreakdown": overall.breakdown_json(),
            "tips": {
                "card": _money(overall.total_card_tips), "cash": _money(overall.total_cash_tips),
                "total": _money(overall.total_tips),
            },
            "drawer": {
                "opening": _money(cash["opening"]),
                "cashSales": _money(cash["cash_sales"]),
                "cashTips": _money(cash["cash_tips"]),
                "cashIn": _money(movements[0]),
                "cashOut": _money(movements[1]),
                "deposits": _money(movements[2]),
                "betweenShifts": _money(cash["between_shifts"]),
                "expected": _money(cash["expected"]),
            },
            "openTables": open_tables(db, shop),
            "untransmitted": untransmitted,
        },
        "tills": sections if settings.per_till else [],
        "employees": waiter_breakdown(db, [s.id for s in all_shifts], shop.id) if settings.per_employee else [],
    }
    # For the print document: the till sections even when the screen hides them (the drawer maths
    # read them), dropped from the paper with `perTill` off.
    report["_sections"] = sections
    return report


def _pos_order(machine: POSMachine):
    pos = str(machine.pos_number or "").strip()
    return (0, int(pos), "") if pos.isdigit() else (1, 0, pos or machine.name or "")


def tender_buckets(breakdown: Dict[str, Any]) -> Dict[str, str]:
    """
    Cash / card / voucher / "תשלום בקופה" / other, as §1 lists them — z_print's buckets, plus `atTill`: a
    leg recorded as paid at the till for a kiosk order (`cash_at_till`); the exchange offset is in none.
    """
    out = {"cash": ZERO, "card": ZERO, "voucher": ZERO, "atTill": ZERO, "other": ZERO}
    for method, amount in (breakdown or {}).items():
        value = Decimal(str(amount or 0))
        m = (method or "").strip().lower()
        if m == "cash":
            out["cash"] += value
        elif m in ("card", "credit"):
            out["card"] += value
        elif m in ("voucher", "vouchers", "production_voucher", "prepaid_voucher"):
            out["voucher"] += value
        elif m in ("cash_at_till", "pay_at_till"):
            out["atTill"] += value
        elif m == "exchange":
            continue
        else:
            out["other"] += value
    return {k: str(v.quantize(CENT)) for k, v in out.items()}


def public(report: Dict[str, Any]) -> Dict[str, Any]:
    """The report without the print document's working copy."""
    return {k: v for k, v in report.items() if not k.startswith("_")}


# ── The journal (§4 "רישום") ──────────────────────────────────────────────────


def journal(db: Session, machine: POSMachine, *, pos_user_id: Optional[str], by_name: Optional[str],
            refreshed: bool, now: Optional[datetime] = None) -> None:
    """Every run from a till: a till event of its own (who, which till, when) — never an exception."""
    from app.models.audit_exception import TillEvent

    now = now or datetime.now(timezone.utc)
    try:
        with db.begin_nested():
            db.add(TillEvent(
                id=uuid.uuid4(), tenant_id=machine.tenant_id, machine_id=machine.id, shop_id=machine.shop_id,
                area_id=getattr(machine, "area_id", None), shift_id=None, event_type=JOURNAL_EVENT,
                occurred_at=now, pos_user_id=(pos_user_id or None) and str(pos_user_id)[:100],
                details={"source": "shop_x", "by": by_name, "posNumber": machine.pos_number, "refreshed": refreshed},
                received_at=now,
            ))
            db.flush()
    except Exception:  # noqa: BLE001 - the report is never refused for its journal line
        logger.exception("shop x: run of %s not journalled", machine.id)


# ── The print document (§4) ───────────────────────────────────────────────────


class _ReportAsZ:
    """The report read through the attributes the Z's print blocks read (`z_print`) — never a ZReport."""

    def __init__(self, report: Dict[str, Any], shop: Shop, header: Optional[dict], now: datetime, business_date):
        summary = report["summary"]
        drawer = summary["drawer"]
        sections = report.get("_sections") or []
        self.shop = shop
        self.header = dict(header or {})
        self.per_machine = sections
        self.machine = None
        self.machine_id = None
        self.area_id = None
        self.is_till_z = False
        self.z_number = None
        self.business_date = business_date
        self.closed_at = now
        self.period_start = _parse(report.get("periodStart"))
        self.period_end = now
        self.shift_count = summary["shiftCount"]
        self.machine_count = summary["tills"]
        self.total_sales = _dec(summary["totalSales"])
        self.total_refunds = _dec(summary["refunds"]["amount"])
        self.discounts_total = _dec(summary["discounts"]["amount"])
        self.transactions_count = summary["documents"]
        self.vat_total = _dec(summary["vatTotal"]) if summary["vatTotal"] is not None else None
        self.payment_breakdown = summary["paymentBreakdown"]
        self.total_cash_sales = _dec(drawer["cashSales"])
        self.total_card_sales = None
        self.total_tips = _dec(summary["tips"]["total"])
        self.total_cash_tips = _dec(summary["tips"]["cash"])
        self.total_card_tips = _dec(summary["tips"]["card"])
        self.opening_cash = _dec(drawer["opening"])
        self.expected_cash = _dec(drawer["expected"])
        self.actual_cash = None
        self.discrepancy = None
        self.reconstructed = False
        self.unattended = False
        self.late_documents = 0
        self.amended_documents = 0
        # The drawer block prints the movements that went into the expected cash.
        self.header[ZEC.BLOCK] = ZEC.block((_dec(drawer["cashIn"]), _dec(drawer["cashOut"]), _dec(drawer["deposits"])))
        if report.get("employees"):
            self.header["byWaiter"] = report["employees"]


def _dec(value: Any) -> Decimal:
    return ZERO if value in (None, "") else Decimal(str(value))


def _parse(text: Any) -> Optional[datetime]:
    if not text:
        return None
    try:
        return _aware(datetime.fromisoformat(str(text).replace("Z", "+00:00")))
    except ValueError:
        return None


def print_document(
    db: Session,
    report: Dict[str, Any],
    shop: Shop,
    *,
    tzinfo,
    printed_by: Optional[str] = None,
    till: Optional[POSMachine] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The report as the 80 mm print document the till already prints for its X / Z
    (`z_print`'s shape: title, number, businessName, subtitle, sections, footer) — the Z's
    blocks over the X's figures, then the X's own: warnings first, voids / OTH / table
    cancels, open tables, untransmitted card per till; the till sections only with
    `perTill`. Footer: "הופק ע״י <עובד> בקופה <מספר>, <שעה>".
    """
    from app.services import z_print as ZP
    from app.services.z_header import snapshot_header

    now = now or datetime.now(timezone.utc)
    local_now = now.astimezone(tzinfo) if tzinfo is not None else now
    view = _ReportAsZ(report, shop, snapshot_header(db, shop, now=now), now, local_now.date())
    doc = ZP.build_print_document(view, tzinfo, printed_at=now)  # type: ignore[arg-type]
    sections = list(doc["sections"])
    till_count = len(view.per_machine)
    if not report["settings"]["perTill"] and till_count:
        sections = sections[:-till_count]
    summary = report["summary"]
    row, section, money = ZP.row, ZP.section, ZP.money

    def counted(entry: Dict[str, Any]) -> str:
        return f"{entry['count']} · {money(entry['amount'])}"

    extra = [
        section("ביטולים והנחות", [
            row("זיכויים", counted(summary["refunds"])),
            row("ביטולי שורה", counted(summary["voids"])),
            row("סלים שבוטלו", counted(summary["basketCancels"])),
            row("הנחות", counted(summary["discounts"])),
            row("OTH על חשבון הבית", counted(summary["oth"])),
            row("ביטולי שולחן", counted(summary["tableCancels"])),
        ]),
        section("שולחנות פתוחים", [
            row("שולחנות", str(summary["openTables"]["count"])),
            row("סכום פתוח", money(summary["openTables"]["amount"]), emphasis=True),
        ]),
    ]
    if summary["untransmitted"]:
        extra.append(section("אשראי שלא שודר", [
            row(u["label"], f"{u['legs']} · {money(u['amount'])}", emphasis=True) for u in summary["untransmitted"]
        ]))
    # After the drawer ("קופה"), before the card blocks and the tills.
    at = next((i + 1 for i, s in enumerate(sections) if s["title"] == "קופה"), len(sections))
    sections = sections[:at] + extra + sections[at:]
    if report["warnings"]:
        sections = [section("אזהרות — קופות שלא עודכנו", [
            row(w["label"], w["text"].split(" — ", 1)[-1], emphasis=True) for w in report["warnings"]
        ])] + sections
    footer = [line for line in doc["footer"] if not line.startswith("סוף ")]
    who = (printed_by or report.get("requestedBy") or "").strip()
    where = f"בקופה {till.pos_number}" if till is not None and till.pos_number else ("בקופה" if till is not None else "בדשבורד")
    footer.append(f"הופק ע״י {who or '—'} {where}, {ZP.stamp(now, tzinfo)}")
    footer.append(f"סוף {TITLE}")
    return {
        "title": TITLE,
        "number": None,
        "businessName": doc["businessName"],
        "subtitle": [HEADLINE, *[line for line in doc["subtitle"] if not line.startswith("הופק ")], f"נכון ל-{ZP.stamp(now, tzinfo)}"],
        "sections": sections,
        "footer": footer,
    }
