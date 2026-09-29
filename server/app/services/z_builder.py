"""
Building a Z in the cloud (docs: pos-android/docs/shifts-plan.md §4.5).

A Z is built over closed shifts of **one shop**, from the documents the cloud holds —
never from figures a till reported. Everything happens in one database transaction:

1. The shop's `shop_z_sequences` row is locked first, so two builds for one shop
   serialise on it (and the number they draw is gapless).
2. Per till, every shift that no Z has taken yet is locked `FOR UPDATE` and ordered
   oldest first (`sequence_number`, falling back to `opened_at`). The included set is
   that list up to and including the run's `through` shift. The D4 rule is re-checked
   under the lock: the through shift is still closed and unclaimed, and no shift at or
   before it is still open — a Z must never skip an older shift (that would be a gap
   in the till's run) or contain one whose close has not been accepted.
3. Totals are computed from the documents of the whole set, and per till for its
   section (first and last document number, takings by tender, discounts, refunds, VAT,
   tips, and the drawer: per till from the first float through the cash takings and
   the cash moved between shifts to an expected that its last count reconciles with,
   over/short withheld if any shift was uncounted — see `till_cash_summary`).
4. The number is allocated, the Z written, and `shifts.z_report_id` set — which is
   what makes a shift in at most one Z: it was NULL under the lock, and it is set in
   the same transaction.

A refusal raises `ZBuildRefused` before anything is written.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop_z_sequence import ShopZSequence
from app.models.z_report import ZReport
from app.services.shift_totals import CENT, DocumentTotals, compute_totals
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.services.z_header import snapshot_header
from app.services.z_sequence import allocate_shop_z_number, ensure_shop_z_sequence

ZERO = Decimal("0")


class ZBuildRefused(Exception):
    def __init__(self, code: str, message: str, machine_id: Optional[uuid.UUID] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.machine_id = machine_id


def _aware(moment: Optional[datetime]) -> datetime:
    if moment is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def shift_order_key(shift: Shift):
    """
    Oldest first: by the till's own counter, falling back to when it opened.

    Shifts without a counter (from before it existed) sort before every numbered one,
    which is where they belong in time.
    """
    return (shift.sequence_number is not None, shift.sequence_number or 0, _aware(shift.opened_at))


def unreported_shifts(
    db: Session,
    machine_id: uuid.UUID,
    *,
    shop_id: Optional[uuid.UUID] = None,
    lock: bool = False,
) -> List[Shift]:
    """
    Every shift of this till no Z has taken yet, open or closed, oldest first.

    With `shop_id`, only the shifts the till worked **in that shop** (`shifts.shop_id`):
    a Z is one shop's, and a till moved to another shop must not carry its old shop's
    takings into the new shop's Z.
    """
    query = db.query(Shift).filter(Shift.machine_id == machine_id, Shift.z_report_id.is_(None))
    if shop_id is not None:
        query = query.filter(Shift.shop_id == shop_id)
    if lock:
        query = query.with_for_update().populate_existing()
    return sorted(query.all(), key=shift_order_key)


def included_shifts(
    db: Session,
    machine_id: uuid.UUID,
    through_shift_id: uuid.UUID,
    *,
    shop_id: Optional[uuid.UUID] = None,
    lock: bool = True,
) -> List[Shift]:
    """
    The shifts a Z takes for this till: all its un-Z'd shifts **in `shop_id`** up to
    `through`, oldest first.

    Raises `ZBuildRefused` if `through` is not an un-Z'd closed shift of this till, or
    if a shift at or before it is still open (D4: no gaps, no half-closed shift).
    """
    shifts = unreported_shifts(db, machine_id, shop_id=shop_id, lock=lock)
    ids = [s.id for s in shifts]
    if through_shift_id not in ids:
        raise ZBuildRefused(
            "through_shift_unavailable",
            "The chosen shift is no longer waiting for a Z (another Z may have taken it).",
            machine_id,
        )
    included = shifts[: ids.index(through_shift_id) + 1]
    still_open = [s for s in included if s.status != ShiftStatus.CLOSED]
    if still_open:
        raise ZBuildRefused(
            "open_shift_before_through",
            "A shift at or before the chosen one is not closed on the cloud yet.",
            machine_id,
        )
    return included


def _money(value) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(CENT))


def _dec(value) -> Decimal:
    return ZERO if value is None else Decimal(value)


def _shift_expected(shift: Shift) -> Decimal:
    """The server's own expected drawer at a shift's close: its float + cash takings + cash tips."""
    return _dec(shift.opening_cash) + _dec(shift.total_cash) + _dec(shift.total_cash_tips)


def _shift_closing(shift: Shift) -> Decimal:
    """What a shift left in the drawer: its count, or its server expected if uncounted."""
    return _shift_expected(shift) if shift.counted_cash is None else _dec(shift.counted_cash)


def till_cash_summary(shifts: Sequence[Shift]) -> Dict[str, Optional[Decimal]]:
    """
    One till's drawer over the consecutive shifts a Z takes of it (oldest first).

    A till has one drawer, and back-to-back shifts hand it on. Summing floats and
    expecteds over the shifts counted the same banknotes once per shift (a drawer that
    held ~180 read as opening 455, expected 540); taking the last shift's expected
    instead did not add up either once a surplus or shortfall was carried into the next
    float (E2E Z #3: expected 190, counted 189, over/short +1). So
    (docs/SHIFTS_API.md §3.6), with shifts 1..n, float_i their opening float, cash_i
    their cash takings net of cash refunds, tips_i their cash tips, expected_i =
    float_i + cash_i + tips_i (the server's own) and closing_i = the count if counted,
    else expected_i:

    * opening  — float_1: the drawer at the start of the period;
    * between-shift adjustments — Σ_{i<n} (float_{i+1} − closing_i): cash put into or
      taken out of the drawer between shifts (usually 0, or a carried surplus);
    * expected — opening + Σ cash_i + Σ tips_i + adjustments;
    * counted  — the **last** shift's count, NULL if that shift was not counted;
    * over/short — Σ (count_i − expected_i), NULL if **any** shift was not counted: a
      partial count presented as the drawer's would hide exactly the shortfall a count
      exists to find;
    * cash sales — Σ cash_i.

    Why this reconciles. With d_i = closing_i − expected_i (the over/short of a counted
    shift, 0 for an uncounted one), float_{i+1} = closing_i + adj_i
    = float_i + cash_i + tips_i + d_i + adj_i, so telescoping from float_1:

        expected_n = float_1 + Σ_{i≤n} (cash_i + tips_i) + Σ_{i<n} adj_i + Σ_{i<n} d_i
                   = expected + Σ_{i<n} d_i

    i.e. the period's expected is the last shift's expected **less** the earlier shifts'
    over/shorts (they were carried into the floats, and are counted once, in
    over/short). When every shift was counted, counted_n = expected_n + d_n, hence

        counted − expected = d_n + Σ_{i<n} d_i = over/short     exactly.
    """
    if not shifts:
        return {
            "opening": ZERO, "expected": ZERO, "counted": None, "over_short": None,
            "uncounted": 0, "cash_sales": ZERO, "between_shifts": ZERO,
        }
    first, last = shifts[0], shifts[-1]
    uncounted = sum(1 for s in shifts if s.counted_cash is None)
    over_short = (
        None if uncounted
        else sum((_dec(s.counted_cash) - _shift_expected(s) for s in shifts), ZERO)
    )
    cash_sales = sum((_dec(s.total_cash) for s in shifts), ZERO)
    cash_tips = sum((_dec(s.total_cash_tips) for s in shifts), ZERO)
    between_shifts = sum(
        (_dec(after.opening_cash) - _shift_closing(before) for before, after in zip(shifts, shifts[1:])),
        ZERO,
    )
    opening = _dec(first.opening_cash)
    return {
        "opening": opening,
        "expected": opening + cash_sales + cash_tips + between_shifts,
        "counted": None if last.counted_cash is None else _dec(last.counted_cash),
        "over_short": over_short,
        "uncounted": uncounted,
        "cash_sales": cash_sales,
        "between_shifts": between_shifts,
    }


def _sum_or_none(values: Sequence[Optional[Decimal]]) -> Optional[Decimal]:
    return None if any(v is None for v in values) else sum(values, ZERO)


def z_cash_summary(per_till: Sequence[Sequence[Shift]]) -> Dict[str, Optional[Decimal]]:
    """
    The Z's drawer figures: each till's (`till_cash_summary`) summed over the tills.

    Tills have a drawer each, so here summing is right. Counted and over/short are NULL
    if they are NULL for any till.
    """
    tills = [till_cash_summary(shifts) for shifts in per_till]
    return {
        "opening": sum((t["opening"] for t in tills), ZERO),
        "expected": sum((t["expected"] for t in tills), ZERO),
        "counted": _sum_or_none([t["counted"] for t in tills]) if tills else None,
        "over_short": _sum_or_none([t["over_short"] for t in tills]) if tills else None,
        "uncounted": sum(t["uncounted"] for t in tills),
        "cash_sales": sum((t["cash_sales"] for t in tills), ZERO),
        "between_shifts": sum((t["between_shifts"] for t in tills), ZERO),
    }


def machine_section(machine: POSMachine, shifts: Sequence[Shift], totals: DocumentTotals) -> dict:
    """One till's section of a Z (docs/SHIFTS_API.md §3.6). Money as decimal strings."""
    cash = till_cash_summary(shifts)
    seqs = [s.sequence_number for s in shifts if s.sequence_number is not None]
    return {
        "machineId": str(machine.id),
        "machineName": machine.name,
        # The register number, or null when the till has none. It used to fall back to
        # the machine code, which put a non-number where a register number is read; the
        # code has a key of its own.
        "posNumber": machine.pos_number,
        "machineCode": machine.machine_code,
        "shiftIds": [str(s.id) for s in shifts],
        "shiftCount": len(shifts),
        "firstShiftSequence": min(seqs) if seqs else None,
        "lastShiftSequence": max(seqs) if seqs else None,
        "firstDocumentNumber": totals.first_transaction_number,
        "lastDocumentNumber": totals.last_transaction_number,
        "transactionsCount": totals.transactions_count,
        "salesCount": totals.sales_count,
        "creditNotesCount": totals.credit_notes_count,
        "nonSaleDocumentsCount": totals.non_sale_count,
        "totalSales": _money(totals.total_sales),
        "grossSales": _money(totals.gross_sales),
        "netSales": _money(totals.net_sales),
        "totalRefunds": _money(totals.total_refunds),
        "discountsTotal": _money(totals.discounts_total),
        "vatTotal": _money(totals.vat_total),
        "vatMissingCount": totals.vat_missing_count,
        "totalCash": _money(totals.total_cash),
        "totalCard": _money(totals.total_card),
        # The net of the `exchange` legs (mixed baskets, §1.2a): in neither cash nor
        # card, and zero when every basket is complete.
        "totalExchange": _money(totals.total_exchange),
        "paymentBreakdown": totals.breakdown_json(),
        "totalTips": _money(totals.total_tips),
        "totalCashTips": _money(totals.total_cash_tips),
        "totalCardTips": _money(totals.total_card_tips),
        "openingCash": _money(cash["opening"]),
        "expectedCash": _money(cash["expected"]),
        "countedCash": _money(cash["counted"]),
        "overShort": _money(cash["over_short"]),
        # Net of cash refunds: the cash the whole period took.
        "cashSalesNet": _money(cash["cash_sales"]),
        # Cash put into or taken out of the drawer between its shifts (the next float
        # less what the last shift left); part of expectedCash. Usually 0.
        "betweenShiftAdjustments": _money(cash["between_shifts"]),
        "uncountedShiftCount": cash["uncounted"],
        "reconstructedShiftCount": sum(1 for s in shifts if s.reconstructed),
        "unattendedShiftCount": sum(1 for s in shifts if s.unattended),
    }


def build_z(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    shop_id: uuid.UUID,
    selections: Sequence[Tuple[POSMachine, uuid.UUID]],
    created_by_user_id: Optional[uuid.UUID] = None,
    z_run_id: Optional[uuid.UUID] = None,
    business_date: Optional[date] = None,
    area_id: Optional[uuid.UUID] = None,
    now: Optional[datetime] = None,
) -> ZReport:
    """
    Build and write one Z over `selections` — (till, through shift id) pairs of one shop.

    `area_id` records which area of the shop the Z was started for, and its header
    freezes the area's name. It selects nothing here: the tills were chosen by the run.

    The caller owns the transaction: on `ZBuildRefused` nothing has been written, and the
    caller rolls back (or releases its savepoint).
    """
    if shop_id is None:
        raise ZBuildRefused("no_shop", "A Z is per shop; this run has none.")
    if not selections:
        raise ZBuildRefused("nothing_to_report", "No till has anything to include.")
    now = now or datetime.now(timezone.utc)

    # 1. Serialise builds for this shop on its counter row (created first if missing, so
    #    two first Zs of a shop cannot both insert it).
    ensure_shop_z_sequence(db, shop_id)
    db.query(ShopZSequence).filter(ShopZSequence.shop_id == shop_id).with_for_update().first()

    # 2. Per till, the included set under lock, D4 re-checked.
    per_machine: List[Tuple[POSMachine, List[Shift]]] = []
    # Per shift, not per till: a till's shifts belong to the shop it worked them in
    # (`shifts.shop_id`). A till since moved away, or retired, still has its shifts of
    # this shop taken here — and never its shifts of another shop.
    for machine, through_id in selections:
        per_machine.append(
            (machine, included_shifts(db, machine.id, through_id, shop_id=shop_id, lock=True))
        )

    all_shifts = [s for _m, shifts in per_machine for s in shifts]
    claimed = [s for s in all_shifts if s.z_report_id is not None]
    if claimed:
        raise ZBuildRefused("shift_already_in_z", "A shift in this run is already in a Z.")

    # 3. Totals from documents: the whole set, and each till on its own.
    overall = compute_totals(db, [s.id for s in all_shifts])
    sections = [
        machine_section(machine, shifts, compute_totals(db, [s.id for s in shifts]))
        for machine, shifts in per_machine
    ]
    cash = z_cash_summary([shifts for _m, shifts in per_machine])

    # 4. Number, write, claim.
    z = ZReport(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        machine_id=None,
        shop_id=shop_id,
        z_run_id=z_run_id,
        created_by_user_id=created_by_user_id,
        business_date=business_date or max(s.business_date for s in all_shifts),
        period_start=min((_aware(s.opened_at) for s in all_shifts)),
        period_end=max((_aware(s.closed_at or s.close_accepted_at or now) for s in all_shifts)),
        shift_count=len(all_shifts),
        machine_count=len(per_machine),
        total_sales=overall.total_sales,
        total_refunds=overall.total_refunds,
        discounts_total=overall.discounts_total,
        total_cash_sales=overall.total_cash,
        total_card_sales=overall.total_card,
        total_exchange=overall.total_exchange,
        total_tips=overall.total_tips,
        total_cash_tips=overall.total_cash_tips,
        total_card_tips=overall.total_card_tips,
        vat_total=overall.vat_total,
        transactions_count=overall.transactions_count,
        payment_breakdown=overall.breakdown_json(),
        per_machine=sections,
        opening_cash=cash["opening"],
        expected_cash=cash["expected"],
        actual_cash=cash["counted"],
        discrepancy=cash["over_short"],
        unattended=any(s.unattended for s in all_shifts),
        reconstructed=any(s.reconstructed for s in all_shifts),
        closed_at=now,
        area_id=area_id,
        header=snapshot_header(
            db,
            db.query(Shop).filter(Shop.id == shop_id).first(),
            area=db.query(ShopArea).filter(ShopArea.id == area_id).first() if area_id else None,
            now=now,
        ),
        shop_sequence_number=allocate_shop_z_number(db, shop_id),
    )
    db.add(z)
    db.flush()
    for shift in all_shifts:
        shift.z_report_id = z.id
    db.flush()
    return z
