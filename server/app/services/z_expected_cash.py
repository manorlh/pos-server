"""
"Z — מזומן צפוי כולל הפקדות ותנועות מזומן" (the owner, 10.10.2026: "ברירת מחדל שלא יופיע").

The till's X has always reckoned the drawer with the shift's cash movements —
opening + cash sales + cash tips + Cash In − Cash Out − safe deposits (the drawer spec §8) —
while the Z's "מזומן צפוי" did not: a deposit to the safe showed up as a shortage in the Z's
over/short, because the count no longer held the cash the Z expected. The till parameter
`cashDrawer.zExpectedCashMovements` (company → shop → area → till, **off** by default) makes the Z
reckon the drawer the way the X does.

* **Off** (the default): the Z is byte for byte what it was — no new key on its header or its
  sections, no new line on its paper.
* **On**, for a till at the moment its Z is produced: that till's section takes the movements
  off / onto its expected cash (`z_builder.till_cash_summary`), says so with a `cashMovements`
  block (the figures that went in) on the section and, summed over the tills it applied to,
  on the Z's header — and prints three lines in the drawer block, each only when it moved
  something, so every line of the drawer adds up to its expected.
* **A Z already produced is never recomputed.** The value is read once, when the Z is built, and
  frozen with it (the block's presence *is* the stored value; absent means off). A reprint, the
  dashboard, the exports and the day reports read what the Z froze, never the live parameter.
  It applies to the Zs produced after it is turned on.
* **Management only.** A Z's sales, refunds, discounts, VAT, tips, payments and document ranges —
  and the uniform file — never move: Cash In / Out and deposits are not sales.
* **Where the movements come from.** The till freezes them on each shift's close
  (`till.cashIn`, `till.cashOut`, `till.deposits`, only the ones that moved anything), from the
  movements it recorded for that shift — the same figures its X reckoned with — whatever the
  parameter says then, so a later Z can use them. A close without them (an older till, a kiosk, a
  reconstructed or administratively closed shift) moved none, as far as the Z can tell.
* **A till that made its own Z** (closed with no connection, or its part of a shop Z over the
  LAN) declares the value it used on its paper (`cashMovements` on its section); the cloud stores
  the Z the way the till printed it, so it builds with that value, not with the live one.
* **Kiosks** have no drawer: never applied there (as "טיפ באשראי משולם מהמזומן").

The rule is written once per language: here and in `z_builder` (the cloud), pos-android
`domain/ZExpectedCash.kt`; both run `tests/fixtures/z_expected_cash_golden.json` (the same bytes,
pinned by SHA-256 in both).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Mapping, Optional, Tuple

from app.services.cash_drawer import Z_EXPECTED_CASH_MOVEMENTS_KEY as KEY

ZERO = Decimal("0")
CENT = Decimal("0.01")

#: The till's keys on a shift close (`till`, docs/SHIFTS_API.md §1.3): what the shift's movements
#: came to, by type. Present only for the types that moved anything. Not compared with the cloud.
CASH_IN = "cashIn"
CASH_OUT = "cashOut"
DEPOSITS = "deposits"

#: The block a Z's section and header carry when the parameter applied: the figures that went in.
BLOCK = "cashMovements"

Movements = Tuple[Decimal, Decimal, Decimal]  # (cash in, cash out, deposits), each ≥ 0

NONE: Movements = (ZERO, ZERO, ZERO)


def _amount(value: Any) -> Decimal:
    """A frozen amount as a non-negative figure; anything that is not one is no claim (zero)."""
    if value is None or isinstance(value, bool):
        return ZERO
    try:
        amount = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return ZERO
    if not amount.is_finite() or amount < 0:
        return ZERO
    return amount.quantize(CENT)


def movements_of_till(till: Optional[Mapping[str, Any]]) -> Movements:
    """What a close's `till` says the shift's movements came to: (cash in, cash out, deposits)."""
    if not isinstance(till, Mapping):
        return NONE
    return _amount(till.get(CASH_IN)), _amount(till.get(CASH_OUT)), _amount(till.get(DEPOSITS))


def movements_of(shift: Any) -> Movements:
    """
    The shift's cash movements as its till froze them on the close; zeros when the close did not
    carry them (the till had none, an older till, a kiosk, a reconstructed shift) — and for any
    value that is not a non-negative amount. Never read from the parameter.
    """
    return movements_of_till(getattr(shift, "till_totals", None))


def net(movements: Movements) -> Decimal:
    """How the movements move the expected cash: Cash In − Cash Out − deposits."""
    cash_in, cash_out, deposits = movements
    return cash_in - cash_out - deposits


def add(a: Movements, b: Movements) -> Movements:
    return a[0] + b[0], a[1] + b[1], a[2] + b[2]


def block(movements: Movements) -> Dict[str, str]:
    """The figures as a Z freezes them (money strings)."""
    cash_in, cash_out, deposits = movements
    return {
        CASH_IN: str(cash_in.quantize(CENT)),
        CASH_OUT: str(cash_out.quantize(CENT)),
        DEPOSITS: str(deposits.quantize(CENT)),
    }


def movements_of_block(frozen: Any) -> Optional[Movements]:
    """A Z's (or section's) frozen block read back; None when it has none — the parameter was off."""
    if not isinstance(frozen, Mapping):
        return None
    return _amount(frozen.get(CASH_IN)), _amount(frozen.get(CASH_OUT)), _amount(frozen.get(DEPOSITS))


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "כן")


def applies(db, machine) -> bool:
    """
    Whether this till's Z reckons the drawer with the movements, as the parameter stands for it
    now — the value a Z freezes when it is produced. Resolved like every till parameter
    (till › area › shop › company › the parameter's default: off), as the till itself receives it
    (`till_parameters_for_machine`). A kiosk has no drawer: never. A parameter not registered yet
    (or deactivated by a super admin): off.
    """
    if getattr(machine, "is_kiosk", False):
        return False
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import till_parameters_for_machine

    if db.query(TillParameter.id).filter(TillParameter.key == KEY).first() is None:
        return False
    value = till_parameters_for_machine(db, machine).parameters.get(KEY)
    return False if value is None else _truthy(value)
