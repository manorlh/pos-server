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

A till Z (`zMode = till`, docs/SHIFTS_API.md §5) runs the same steps over one till,
with that till's counter (`machine_z_sequences`) in place of the shop's.

A refusal raises `ZBuildRefused` before anything is written.

**No Z on nothing** ("אל תאפשר לסגור Z על 0"): a set of shifts with no activity — no
document of any kind, no money, no cash moved between shifts (`figures_show_activity`) —
is refused (`empty_z`) after step 3 and before step 4, so no Z is written and no number
is drawn. Its shifts stay closed and in no Z; a later Z with activity takes them along
(they add nothing), so a till's shifts still run without a gap.
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
from app.models.z_report import ZOrigin, ZReport
from app.services.shift_totals import CENT, DocumentTotals, compute_totals, till_totals_mismatch
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.services.offline_authorizations import offline_block
from app.services.transmissions import period_block
from app.services.z_header import snapshot_header
from app.services.z_waiters import waiter_breakdown
from app.services.z_sequence import (
    allocate_machine_z_number,
    allocate_shop_z_number,
    ensure_shop_z_sequence,
    lock_machine_z_sequence,
)

#: `pos_machines.z_mode` of a till that produces its own Z (docs/SHIFTS_API.md §5).
Z_MODE_TILL = "till"
Z_MODE_CLOUD = "cloud"

ZERO = Decimal("0")


class ZBuildRefused(Exception):
    def __init__(self, code: str, message: str, machine_id: Optional[uuid.UUID] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.machine_id = machine_id


#: The refusal of a Z with nothing in it ("אל תאפשר לסגור Z על 0"), and what is said.
EMPTY_Z = "empty_z"
EMPTY_Z_MESSAGE = "אין תנועות — לא ניתן לסגור Z על 0"


def numbers_label(numbers: Sequence[Optional[str]]) -> str:
    """Register numbers for a sentence: "1–5", "1, 3, 6", or as they are when not numbers."""
    shown = [str(n).strip() for n in numbers if n is not None and str(n).strip()]
    if not shown:
        return ""
    if all(n.isdigit() for n in shown):
        ints = sorted({int(n) for n in shown})
        runs: List[str] = []
        start = prev = ints[0]
        for n in ints[1:] + [None]:  # type: ignore[list-item]
            if n is not None and n == prev + 1:
                prev = n
                continue
            runs.append(f"{start}–{prev}" if prev - start >= 2 else ", ".join(str(i) for i in range(start, prev + 1)))
            if n is not None:
                start = prev = n
        return ", ".join(runs)
    return ", ".join(shown)


def _till_ref(machine: POSMachine) -> dict:
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def z_scope(
    db: Session, shop_id: uuid.UUID, machines: Sequence[POSMachine], till_z: bool, area_id=None
) -> dict:
    """
    What a Z includes, frozen on its header as `scope` (docs/SPEC_INDEPENDENT_TILL.md §7):
    `{kind, label, tills, independentOutside}`. A shop Z names its tills and the shop's
    independent tills it does not cover — by design, not left out — so the paper and the
    dashboard say plainly what is in it; a till Z says it is one till's.
    """
    from app.services.independent_till import is_independent

    tills = [_till_ref(m) for m in machines]
    if till_z:
        machine = machines[0]
        label = machine.pos_number or machine.name or ""
        if is_independent(machine):
            return {
                "kind": "independent_till",
                "label": f"Z של קופה {label} בלבד — קופה עצמאית, לא חלק מה-Z הסניפי",
                "tills": tills,
                "independentOutside": [],
            }
        return {"kind": "till", "label": f"Z של קופה {label} בלבד (Z לכל קופה)", "tills": tills, "independentOutside": []}
    outside = (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop_id,
            POSMachine.is_active.is_(True),
            POSMachine.independent_till.is_(True),
        )
        .all()
    )
    outside = sorted((m for m in outside if m.id not in {x.id for x in machines}), key=lambda m: (m.pos_number or "", m.name or ""))
    label = f"Z סניפי — כולל קופות {numbers_label([m.pos_number for m in machines])}"
    if area_id is not None:
        label = f"Z לנקודת מכירה — כולל קופות {numbers_label([m.pos_number for m in machines])}"
    if outside:
        label += f" · לא כולל קופות עצמאיות: {numbers_label([m.pos_number for m in outside])} (Z נפרד לכל אחת)"
    return {
        "kind": "area" if area_id is not None else "shop",
        "label": label,
        "tills": tills,
        "independentOutside": [_till_ref(m) for m in outside],
    }


def figures_show_activity(totals: DocumentTotals, between_shifts=ZERO) -> bool:
    """
    Whether a Z over these figures has anything to report.

    Activity is a document of any kind — a sale, a credit note, a cancelled or declined
    one — any money (sales, refunds, discounts, tips, takings by tender, VAT), or cash put
    into or taken out of a drawer between shifts (`between_shifts`, the only cash movement
    a Z carries). The float a drawer opened with is not activity, and neither is a count
    that disagrees with it: a till that opened and closed with no document has nothing a
    Z could report.
    """
    if totals.transactions_count or totals.non_sale_count:
        return True
    amounts = [
        totals.total_sales,
        totals.total_refunds,
        totals.discounts_total,
        totals.total_tips,
        totals.vat_declared,
        *totals.payment_breakdown.values(),
    ]
    if any(_dec(a) != ZERO for a in amounts):
        return True
    return _dec(between_shifts) != ZERO


def shifts_show_activity(db: Session, per_till: Sequence[Sequence[Shift]]) -> bool:
    """`figures_show_activity` over these shifts (each till's oldest first), open ones too."""
    ids = [s.id for shifts in per_till for s in shifts]
    if not ids:
        return False
    totals = compute_totals(db, ids)
    between = z_cash_summary([list(shifts) for shifts in per_till if shifts])["between_shifts"]
    return figures_show_activity(totals, between)


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
        # Per document type, each on its own number series (docs/SPEC_DOCUMENT_PREFIX.md).
        "documentRanges": totals.document_ranges,
        "transactionsCount": totals.transactions_count,
        "salesCount": totals.sales_count,
        "creditNotesCount": totals.credit_notes_count,
        "nonSaleDocumentsCount": totals.non_sale_count,
        "totalSales": _money(totals.total_sales),
        "grossSales": _money(totals.gross_sales),
        "netSales": _money(totals.net_sales),
        "totalRefunds": _money(totals.total_refunds),
        "discountsTotal": _money(totals.discounts_total),
        "lineDiscountsTotal": _money(totals.line_discounts_total),
        "promotionDiscountsTotal": _money(totals.promotion_discounts_total),
        "vatTotal": _money(totals.vat_total),
        "vatMissingCount": totals.vat_missing_count,
        "totalCash": _money(totals.total_cash),
        "totalCard": _money(totals.total_card),
        # The net of the `exchange` legs (mixed baskets, §1.2a): in neither cash nor
        # card, and zero when every basket is complete.
        "totalExchange": _money(totals.total_exchange),
        "paymentBreakdown": totals.breakdown_json(),
        # Card legs per brand (מותג) and acquirer (חברת סליקה), sales and refunds apart.
        "cardBrands": totals.card_brands_json(),
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
    open_tills_left_out: Optional[dict] = None,
    now: Optional[datetime] = None,
    origin: str = ZOrigin.CLOUD,
    created_by_name: Optional[str] = None,
    created_by_pos_user_id: Optional[str] = None,
    client_request_id: Optional[uuid.UUID] = None,
    till_totals: Optional[dict] = None,
    unattended: bool = False,
    z_id: Optional[uuid.UUID] = None,
    machine_sequence_number: Optional[int] = None,
    allow_empty: bool = False,
    shop_sequence_number: Optional[int] = None,
    leave_late_carry: bool = False,
) -> ZReport:
    """
    Build and write one Z over `selections` — (till, through shift id) pairs of one shop.

    `area_id` records which area of the shop the Z was started for, and its header
    freezes the area's name. It selects nothing here: the tills were chosen by the run.

    `origin = till` builds a till Z (docs/SHIFTS_API.md §5): exactly one till, numbered
    in that till's own run instead of the shop's, filed under its **first** shift's
    business date, `machine_id` set. Everything else — the included shifts, the figures,
    the per-till section, the header — is this same code, so a till Z and a cloud Z over
    the same shifts cannot differ. `till_totals` (the till's own sum) is kept for audit
    and compared; `unattended` marks a Z produced for a dashboard request with nobody at
    the till (on a till Z that is all it means).

    A cloud Z refuses a till in `zMode = till` (`machine_issues_its_own_z`): whichever
    path reaches the build — a new run, a till's close finishing one, expiry, an
    administrative close — the cloud never takes such a till's shifts.

    The caller owns the transaction: on `ZBuildRefused` nothing has been written, and the
    caller rolls back (or releases its savepoint).

    A till Z closed at the till with no connection (docs/SPEC_OFFLINE_TILL_Z.md §6.1)
    comes with its own `z_id` and `machine_sequence_number` — the till numbered it and
    printed it, the caller has already claimed the number (`claim_machine_z_number`) — and
    `allow_empty`: the paper exists, so a set the cloud finds empty is a discrepancy for
    the caller to record, not a refusal.

    A shop Z produced on the main till (docs/SPEC_INDEPENDENT_TILL.md §8) comes the same
    way with its `z_id` and `shop_sequence_number`, the caller having claimed the number
    (`claim_shop_z_number`).

    Every Z freezes what it includes on its header (`scope`, `z_scope`): a shop Z names
    its tills and the shop's independent tills it does not include; a till Z says whose.

    `open_tills_left_out` (`app.services.z_runs.open_tills_left_out`): the tills the
    operator confirmed producing this shop Z without, and who confirmed it. Frozen into
    the header as `openTillsLeftOut`, so the Z itself says what it does not cover.

    Every Z, cloud or till, freezes its per-waiter breakdown on the header (`byWaiter`,
    app/services/z_waiters.py).
    """
    if shop_id is None:
        raise ZBuildRefused("no_shop", "A Z is per shop; this run has none.")
    if not selections:
        raise ZBuildRefused("nothing_to_report", "No till has anything to include.")
    now = now or datetime.now(timezone.utc)
    till_z = origin == ZOrigin.TILL

    if till_z:
        if len(selections) != 1:
            raise ZBuildRefused("till_z_one_till", "A till Z is one till's.")
        # 1. Serialise on the till's own counter (the caller normally holds it already).
        lock_machine_z_sequence(db, selections[0][0].id)
    else:
        for machine, _through in selections:
            if getattr(machine, "z_mode", None) == Z_MODE_TILL:
                raise ZBuildRefused(
                    "machine_issues_its_own_z",
                    "This till produces its own Z; a cloud Z does not take its shifts.",
                    machine.id,
                )
        # 1. Serialise builds for this shop on its counter row (created first if missing,
        #    so two first Zs of a shop cannot both insert it).
        ensure_shop_z_sequence(db, shop_id)
        db.query(ShopZSequence).filter(ShopZSequence.shop_id == shop_id).with_for_update().first()

    # 2. Per till, the included set under lock, D4 re-checked.
    per_machine: List[Tuple[POSMachine, List[Shift]]] = []
    # Per shift, not per till: a till's shifts belong to the shop it worked them in
    # (`shifts.shop_id`). A till since moved away, or retired, still has its shifts of
    # this shop taken here — and never its shifts of another shop.
    for machine, through_id in selections:
        taken = included_shifts(db, machine.id, through_id, shop_id=shop_id, lock=True)
        if leave_late_carry:
            # A Z the till built itself (with no connection) never had the cloud's carried
            # late documents on its paper: they wait for the next Z the cloud builds (§4.6.3).
            from app.services.late_documents import is_carry

            taken = [s for s in taken if not is_carry(s)]
        per_machine.append((machine, taken))

    all_shifts = [s for _m, shifts in per_machine for s in shifts]
    claimed = [s for s in all_shifts if s.z_report_id is not None]
    if claimed:
        raise ZBuildRefused("shift_already_in_z", "A shift in this run is already in a Z.")

    # 3. Totals from documents: the whole set, and each till on its own.
    overall = compute_totals(db, [s.id for s in all_shifts])
    # No Z on nothing ("אל תאפשר לסגור Z על 0"): refused here, before a number is drawn.
    between = z_cash_summary([shifts for _m, shifts in per_machine])["between_shifts"]
    if not allow_empty and not figures_show_activity(overall, between):
        raise ZBuildRefused(EMPTY_Z, EMPTY_Z_MESSAGE)
    sections = [
        machine_section(machine, shifts, compute_totals(db, [s.id for s in shifts]))
        for machine, shifts in per_machine
    ]
    # Card transmission, frozen with the section at build time. Informational: nothing
    # here waits for, or is refused by, a transmission (docs/SHIFTS_API.md §4.11).
    for section, (machine, shifts) in zip(sections, per_machine):
        section["transmission"] = period_block(db, machine, shifts, now=now)
        # Offline-approved card sales the acquirer later declined (or approved), as the
        # till's authorization runs reported them by build time. Informational too.
        section["offline"] = offline_block(db, machine, shifts)
    cash = z_cash_summary([shifts for _m, shifts in per_machine])

    # 4. Number, write, claim.
    if business_date is None:
        # A cloud Z: its latest shift's day. A till Z closes the till's business day,
        # which its first shift opened (§5): the first shift's day.
        business_date = (
            per_machine[0][1][0].business_date if till_z else max(s.business_date for s in all_shifts)
        )
    z = ZReport(
        id=z_id or uuid.uuid4(),
        tenant_id=tenant_id,
        machine_id=per_machine[0][0].id if till_z else None,
        origin=ZOrigin.TILL if till_z else ZOrigin.CLOUD,
        shop_id=shop_id,
        z_run_id=z_run_id,
        created_by_user_id=created_by_user_id,
        created_by_name=created_by_name,
        created_by_pos_user_id=created_by_pos_user_id,
        client_request_id=client_request_id,
        till_totals=till_totals,
        totals_mismatch=till_totals_mismatch(till_totals, overall) if till_z else False,
        business_date=business_date,
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
        # A cloud Z: any shift closed with nobody at the drawer. A till Z: produced for a
        # dashboard request with nobody at the till (§5.5, shown "הופק מרחוק") — its
        # shifts' own flags are on their sections (`unattendedShiftCount`).
        unattended=bool(unattended) if till_z else any(s.unattended for s in all_shifts),
        reconstructed=any(s.reconstructed for s in all_shifts),
        closed_at=now,
        area_id=area_id,
        header=snapshot_header(
            db,
            db.query(Shop).filter(Shop.id == shop_id).first(),
            area=db.query(ShopArea).filter(ShopArea.id == area_id).first() if area_id else None,
            now=now,
        ),
        # One run or the other, never both: a till Z is not a number in the shop's run.
        shop_sequence_number=None if till_z else (shop_sequence_number or allocate_shop_z_number(db, shop_id)),
        machine_sequence_number=(
            (machine_sequence_number or allocate_machine_z_number(db, per_machine[0][0].id)) if till_z else None
        ),
    )
    if open_tills_left_out and z.header is not None:
        z.header = {**z.header, "openTillsLeftOut": open_tills_left_out}
    # Item discounts have no column of their own: frozen on the header, beside the
    # basket discounts' `discounts_total`.
    if z.header is not None:
        z.header = {**z.header, "lineDiscountsTotal": _money(overall.line_discounts_total)}
        # Promotion discounts ("הנחות מבצעים") the same way: inside `discounts_total`.
        z.header = {**z.header, "promotionDiscountsTotal": _money(overall.promotion_discounts_total)}
        # Per waiter ("פירוט לפי מלצר"): the same documents, by whose table or sale they were.
        z.header = {**z.header, "byWaiter": waiter_breakdown(db, [s.id for s in all_shifts], shop_id)}
        # What this Z includes, in words (docs/SPEC_INDEPENDENT_TILL.md §7).
        z.header = {**z.header, "scope": z_scope(db, shop_id, [m for m, _s in per_machine], till_z, area_id)}
    if till_z:
        # The till's run (an independent till starts again at 1, SPEC_INDEPENDENT_TILL §3.1):
        # its epoch on the row, and when it began on the header — printed and shown so two
        # "Z 1" of one till are told apart.
        from app.services.z_sequence import current_machine_epoch

        epoch, started = current_machine_epoch(db, per_machine[0][0].id)
        z.machine_sequence_epoch = epoch
        if z.header is not None:
            z.header = {
                **z.header,
                "sequence": {
                    "epoch": epoch,
                    "startedAt": started.isoformat() if started is not None else None,
                    "independent": bool(getattr(per_machine[0][0], "independent_till", False)),
                },
            }
    # "הוחלפה קופה" (docs/SPEC_OFFLINE_TILL_Z.md §4.6.2): the first Z of a till after its
    # device was replaced says so, once ("המכשיר הוחלף בתאריך …").
    from app.services.till_replacement import note_on_z

    note_on_z(z, [m for m, _s in per_machine])
    # Late documents of a support Z, carried into this Z: their own section (§4.6.3).
    from app.services import late_documents

    late_documents.note_on_z(db, z, all_shifts)
    db.add(z)
    db.flush()
    for shift in all_shifts:
        shift.z_report_id = z.id
    db.flush()
    # "פתיחת פריטים אוטומטית אחרי Z" (docs/SPEC_AVAILABILITY.md): own savepoint, never raises.
    from app.services.availability_reopen import after_z

    after_z(db, z, [m for m, _s in per_machine])
    return z
