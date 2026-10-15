"""
"הכסף אצלי" — the employees' wallets (P:/specs/drawer-away.md §5, the owner 15.10.2026: "שישאל, ואם העובד
לא נמצא ליד המגירה? דינמי").

A cash payment on a device away from a drawer (a handheld, a phone, a device with no drawer of its own) may
leave the money with the employee who took it ("הכסף אצלי, אפקיד אחר כך"). Later, at a till with a drawer,
the cash is counted into it ("הפקדת מזומן מעובד"). Both are ordinary cash movements the tills upload
(`cash_movements`, no table of their own, no migration):

* `wallet_in` — the device the payment was on; `employee_*` = who keeps the cash; `amount` = the cash;
  `source` = `sale:<id>`.
* `wallet_deposit` — the till with the drawer; `employee_*` = whose wallet it was, `approver_*` = who
  received it (CASH_DRAWER.WALLET_DEPOSIT); `amount` = what was counted into the drawer;
  `expected_before` = the wallet's balance the till showed (what the deposit settles); `variance` =
  counted − that. A non-zero variance is the exception `cash_wallet_variance`.

**A wallet's balance** (per shop and employee) = Σ `wallet_in.amount` − Σ of each deposit's
`expected_before` (its `amount` when it carried none). Training rows never count. A deposit settles exactly
what it was shown; an accrual that reached the cloud after it stays open for the next one.

**The drawer.** Until deposited the cash is in no drawer: each shift's close freezes `till.walletIn` (the
cash its payments left with employees) and `till.walletDeposits` (what was counted into its drawer), and
every Z's expected cash takes them — always, whatever "Z — מזומן צפוי כולל הפקדות ותנועות מזומן" says;
with none, a Z is byte for byte what it was. A Z says so with a `cashWallets` block (section and header),
and lists "מזומן אצל עובדים (טרם הופקד)" per employee in its header (`cashWithStaff`), frozen when built.
The till's own rule is pos-android domain/DrawerAway.kt + ZExpectedCash.kt.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

ZERO = Decimal("0")
CENT = Decimal("0.01")

WALLET_IN = "wallet_in"
WALLET_DEPOSIT = "wallet_deposit"
WALLET_TYPES = (WALLET_IN, WALLET_DEPOSIT)

#: The till's keys on a shift close (`till`): present only when not zero; already in its `expectedCash`.
WALLET_IN_KEY = "walletIn"
WALLET_DEPOSITS_KEY = "walletDeposits"
#: A Z's section / header block: the wallet figures that went into its expected cash.
BLOCK = "cashWallets"
#: A Z's header (and its whole report sections): "מזומן אצל עובדים (טרם הופקד)", per employee.
STAFF = "cashWithStaff"

#: The exception of a deposit whose count differs from the wallet's balance.
VARIANCE_KIND = "cash_wallet_variance"

STAFF_LABEL = "מזומן אצל עובדים (טרם הופקד)"
STAFF_TOTAL_LABEL = "סה״כ אצל עובדים"
WALLET_IN_LABEL = "הכסף אצל עובדים"
WALLET_DEPOSITS_LABEL = "הפקדות מעובדים"
TYPE_LABELS = {WALLET_IN: "הכסף אצל העובד", WALLET_DEPOSIT: "הפקדה מעובד"}

Wallets = Tuple[Decimal, Decimal]  # (wallet in, wallet deposits), each ≥ 0
NONE: Wallets = (ZERO, ZERO)


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


def wallets_of_till(till: Optional[Mapping[str, Any]]) -> Wallets:
    """What a close's `till` says: (cash left with employees, deposits counted into the drawer)."""
    if not isinstance(till, Mapping):
        return NONE
    return _amount(till.get(WALLET_IN_KEY)), _amount(till.get(WALLET_DEPOSITS_KEY))


def wallets_of(shift: Any) -> Wallets:
    return wallets_of_till(getattr(shift, "till_totals", None))


def net(wallets: Wallets) -> Decimal:
    """How they move the expected drawer: + deposits − the cash left with employees."""
    wallet_in, deposits = wallets
    return deposits - wallet_in


def add(a: Wallets, b: Wallets) -> Wallets:
    return a[0] + b[0], a[1] + b[1]


def is_zero(wallets: Wallets) -> bool:
    return wallets[0] == ZERO and wallets[1] == ZERO


def block(wallets: Wallets) -> Optional[Dict[str, str]]:
    """The block a Z freezes; None when nothing moved (no key — the Z reads as before)."""
    if is_zero(wallets):
        return None
    return {WALLET_IN_KEY: str(wallets[0].quantize(CENT)), WALLET_DEPOSITS_KEY: str(wallets[1].quantize(CENT))}


def wallets_of_block(frozen: Any) -> Wallets:
    if not isinstance(frozen, Mapping):
        return NONE
    return _amount(frozen.get(WALLET_IN_KEY)), _amount(frozen.get(WALLET_DEPOSITS_KEY))


# ── The ledger ─────────────────────────────────────────────────────────────────


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def balances_of_rows(rows: Iterable[Any]) -> List[Dict[str, Any]]:
    """
    Each employee's wallet from movement rows (any order): balance, accruals, first / last accrual and the
    latest name — every employee with a row, the zero and negative ones too, largest balance first.
    """
    by: Dict[str, Dict[str, Any]] = {}
    for m in sorted(rows, key=lambda r: (_utc(r.occurred_at) or datetime.min.replace(tzinfo=timezone.utc))):
        if getattr(m, "training", False) or m.movement_type not in WALLET_TYPES or not m.employee_id:
            continue
        w = by.setdefault(m.employee_id, {
            "employeeId": m.employee_id, "employeeName": None, "balance": ZERO, "accruals": 0,
            "firstAt": None, "lastAt": None,
        })
        if m.employee_name:
            w["employeeName"] = m.employee_name
        amount = Decimal(str(m.amount or 0))
        if m.movement_type == WALLET_IN:
            w["balance"] += amount
            w["accruals"] += 1
            at = _utc(m.occurred_at)
            w["firstAt"] = w["firstAt"] or at
            w["lastAt"] = at
        else:
            settled = m.expected_before if m.expected_before is not None else m.amount
            w["balance"] -= Decimal(str(settled or 0))
    out = list(by.values())
    for w in out:
        w["balance"] = w["balance"].quantize(CENT)
    out.sort(key=lambda w: (-w["balance"], w["employeeName"] or "", w["employeeId"]))
    return out


def balances(
    db,
    *,
    shop_ids: Sequence[Any],
    employee_id: Optional[str] = None,
    tenant_id: Any = None,
    as_of: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """The wallets of [shop_ids] (every employee with a wallet row there), as `balances_of_rows`."""
    from app.models.cash_drawer import CashMovement

    if not shop_ids:
        return []
    q = db.query(CashMovement).filter(
        CashMovement.movement_type.in_(WALLET_TYPES),
        CashMovement.shop_id.in_(list(shop_ids)),
        CashMovement.training.is_(False),
    )
    if tenant_id is not None:
        q = q.filter(CashMovement.tenant_id == tenant_id)
    if employee_id is not None:
        q = q.filter(CashMovement.employee_id == employee_id)
    if as_of is not None:
        q = q.filter(CashMovement.occurred_at <= as_of)
    return balances_of_rows(q.all())


def wallet_out(w: Mapping[str, Any]) -> Dict[str, Any]:
    """One wallet as the till and the dashboard get it (§5.5)."""
    return {
        "employeeId": w["employeeId"],
        "employeeName": w.get("employeeName"),
        "balance": float(w["balance"]),
        "accruals": int(w.get("accruals") or 0),
        "firstAt": w["firstAt"].isoformat() if w.get("firstAt") else None,
        "lastAt": w["lastAt"].isoformat() if w.get("lastAt") else None,
    }


def staff_block(wallets: Iterable[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """`cashWithStaff`: the employees holding any — `{total, employees: [{employeeId, employeeName, amount}]}`; None: nobody."""
    held = [w for w in wallets if Decimal(str(w["balance"])) > ZERO]
    if not held:
        return None
    total = sum((Decimal(str(w["balance"])) for w in held), ZERO)
    return {
        "total": str(total.quantize(CENT)),
        "employees": [
            {
                "employeeId": w["employeeId"],
                "employeeName": w.get("employeeName"),
                "amount": str(Decimal(str(w["balance"])).quantize(CENT)),
            }
            for w in held
        ],
    }


def staff_for_z(db, shop_id: Any, machine_ids: Sequence[Any], *, as_of: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    A Z's "מזומן אצל עובדים (טרם הופקד)": the employees with a wallet accrual on the Z's tills, each with
    their open balance in the shop at [as_of] (the moment the Z is built). None when nobody holds any.
    """
    from app.models.cash_drawer import CashMovement

    if shop_id is None or not machine_ids:
        return None
    rows = (
        db.query(CashMovement)
        .filter(
            CashMovement.movement_type.in_(WALLET_TYPES),
            CashMovement.shop_id == shop_id,
            CashMovement.training.is_(False),
            *([CashMovement.occurred_at <= as_of] if as_of is not None else []),
        )
        .all()
    )
    wanted = {str(m) for m in machine_ids}
    who = {r.employee_id for r in rows if r.movement_type == WALLET_IN and str(r.machine_id) in wanted}
    return staff_block([w for w in balances_of_rows(rows) if w["employeeId"] in who])

