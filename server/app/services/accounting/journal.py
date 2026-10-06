"""
A Z as a journal entry (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.2).

Two halves, kept apart so the bookkeeping can be tested without a database:

* `load_z_facts(db, z, ...)` reads what the entry needs: the Z's stored figures (they
  are final — a Z is the fiscal close) and, from the Z's own documents, the split the
  Z does not store (income per VAT rate, card receipts per brand, voucher sales).
* `build_entry(facts, settings)` turns that into lines. Pure.

The entry, signed debit-positive::

    D cash           cash takings + cash tips + over/short   (the money actually counted)
    D card[/brand]   card takings + card tips − declined offline
    D cardDeclined   offline-approved card sales the acquirer declined (a receivable)
    D vouchers       redeemed vouchers (voucher-like tenders)
    D otherTenders   any other tender, one line per method
    C income*        net sales before VAT, per VAT rate (taxable / exempt)
    C vatOutput      the Z's VAT
    C tips           tips owed to staff (cash and card)
    C voucherSales   vouchers sold, when they are booked as a liability
    C cashOverShort  counted − expected
    ± rounding       the remainder, only if it is at most ₪1

Refunds are already netted inside each figure (a credit note's legs are negative), and a
line that comes out negative moves to the other side. The sum of the tenders is the net
the income and VAT are taken from, so the entry balances by construction; what is left
is the `exchange` net of an incomplete mixed basket and cent rounding — and anything over
₪1 refuses the export instead of hiding in a rounding line.
"""
from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.issued_voucher import IssuedVoucher
from app.models.shift import Shift
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZReport
from app.services import card_brands
from app.services.dashboard_stats import SALE_STATUSES
from app.services.offline_authorizations import section_declined
from app.services.tenders import (
    EXCHANGE_PAYMENT_METHOD,
    expected_tender_total,
    is_refund_document,
)

ZERO = Decimal("0")
CENT = Decimal("0.01")
#: Largest remainder written as a rounding line (spec §2.2). Above it the export stops.
MAX_ROUNDING = Decimal("1.00")

#: Tender methods booked as voucher redemptions rather than "other".
VOUCHER_METHODS = frozenset({"voucher", "vouchers", "giftcard", "gift_card", "coupon", "credit_voucher"})

#: Hebrew line labels — the `פרטים` a bookkeeper reads in the ledger.
LABELS = {
    "cash": "מזומן",
    "card": "אשראי",
    "cardDeclined": "אשראי שנדחה",
    "vouchers": "שוברים",
    "otherTenders": "אמצעי תשלום אחר",
    "incomeTaxable": "הכנסות",
    "incomeExempt": "הכנסות פטורות",
    "vatOutput": "מע\"מ עסקאות",
    "tips": "טיפים",
    "voucherSales": "מכירת שוברים",
    "cashOverShort": "הפרשי קופה",
    "rounding": "עיגול",
}

GROUPINGS = ("z", "day", "month")


def _dec(value) -> Decimal:
    if value is None:
        return ZERO
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _q(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


# ── Facts ────────────────────────────────────────────────────────────────────


@dataclass
class ZFacts:
    z_id: uuid.UUID
    z_number: Optional[int]
    business_date: date
    shop_id: Optional[uuid.UUID]
    shop_name: str
    #: Net per tender method, as the Z stores it (refunds already subtracted).
    breakdown: Dict[str, Decimal]
    cash_tips: Decimal = ZERO
    card_tips: Decimal = ZERO
    #: counted − expected; None when nobody counted (then no over/short line).
    variance: Optional[Decimal] = None
    declined_amount: Decimal = ZERO
    #: None = the Z could not state its VAT (a document declared none).
    vat_total: Optional[Decimal] = ZERO
    #: Σ tenders = net sales including VAT.
    net: Decimal = ZERO
    #: "קופה 2" on a till's own Z ("Z לכל קופה"), whose number is that till's; else None.
    till_label: Optional[str] = None
    #: rate (e.g. Decimal("0.18"), 0 = exempt) → (gross incl. VAT, VAT). None = no split.
    income_by_rate: Optional[Dict[Decimal, Tuple[Decimal, Decimal]]] = None
    #: brand → card takings (only brands seen; the rest is in the card total). Used when
    #: `card_legs` is empty (facts built by hand).
    card_by_brand: Dict[str, Decimal] = field(default_factory=dict)
    #: (brand, acquirer) → card legs net (refunds subtracted), from the legs' own
    #: `card_brand` / `card_acquirer` (app.services.card_brands). "other"/"unknown" when
    #: the reply did not say.
    card_legs: Dict[Tuple[str, str], Decimal] = field(default_factory=dict)
    voucher_sales: Decimal = ZERO
    #: The shop's cost centre / branch code in the books, written per line when a
    #: company-level export consolidates shops into one entry.
    cost_center: str = ""


@dataclass
class JournalLine:
    #: "D" (חובה) or "C" (זכות).
    side: str
    #: The mapping key (ACCOUNT_KEYS), plus `card:<brand>` for a brand line.
    key: str
    account: Optional[str]
    amount: Decimal
    label: str
    #: Per-line branch / cost centre (מרכז רווח); None = the entry's branch. Set only on
    #: a consolidated company entry, where each line keeps the shop it came from.
    branch: Optional[str] = None
    #: The shop a consolidated line came from (its mapping gaps are reported per shop).
    shop_name: Optional[str] = None

    @property
    def signed(self) -> Decimal:
        return self.amount if self.side == "D" else -self.amount


@dataclass
class JournalEntry:
    shop_id: Optional[uuid.UUID]
    shop_name: str
    reference1: int
    reference2: str
    entry_date: date
    value_date: date
    details: str
    branch: str
    movement_type: str
    z_ids: List[uuid.UUID]
    lines: List[JournalLine]

    @property
    def total_debit(self) -> Decimal:
        return sum((l.amount for l in self.lines if l.side == "D"), ZERO)

    @property
    def total_credit(self) -> Decimal:
        return sum((l.amount for l in self.lines if l.side == "C"), ZERO)


@dataclass
class Problem:
    """Why an entry cannot be exported. `code` is stable; the dashboard words it."""

    code: str
    z_id: Optional[uuid.UUID]
    z_number: Optional[int]
    shop_name: str
    detail: str = ""


class JournalRefused(Exception):
    def __init__(self, problems: List[Problem]):
        super().__init__("; ".join(f"{p.code}: {p.detail}" for p in problems))
        self.problems = problems


def _leg_brand(leg: TransactionPayment) -> Tuple[str, str]:
    """(brand, acquirer) of a card leg: its stored columns, else read from its reply."""
    brand, acquirer = leg.card_brand, leg.card_acquirer
    if brand is None and acquirer is None:
        brand, acquirer, _issuer = card_brands.derive(leg.nayax_meta)
    return (brand or "other", acquirer or card_brands.UNKNOWN)


def _till_label_of(z: ZReport) -> Optional[str]:
    """
    A till's own Z named by its register ("קופה 2") — and, for an independent till's later
    run, by the run's first day too, its numbers starting again at 1 (SPEC_INDEPENDENT_TILL
    §3.1): "קופה 6 (רצף מ-06/10/2026)".
    """
    if not z.is_till_z or z.machine is None:
        return None
    label = f"קופה {z.machine.pos_number}" if z.machine.pos_number else z.machine.name
    from app.services.z_print import sequence_started_label

    run = sequence_started_label(z)
    return f"{label} ({run})" if label and run else label


def load_z_facts(
    db: Session,
    z: ZReport,
    *,
    want_brands: bool = False,
    want_voucher_sales: bool = False,
) -> ZFacts:
    """What the entry of `z` needs. Z-level figures from the Z; splits from its documents."""
    shop_name = z.shop.name if z.shop is not None else ""
    breakdown = {
        str(k).strip().lower(): _dec(v) for k, v in (z.payment_breakdown or {}).items()
    }
    if not breakdown:
        # A legacy Z from before the breakdown: its two stored totals.
        if z.total_cash_sales is not None:
            breakdown["cash"] = _dec(z.total_cash_sales)
        if z.total_card_sales is not None:
            breakdown["card"] = _dec(z.total_card_sales)

    from app.services.reports import _z_variance  # same rule as the day summary

    declined = sum((section_declined(s)[1] for s in (z.per_machine or [])), ZERO)
    vat = z.vat_total if z.per_machine is not None else None
    if z.per_machine is None:
        from app.services.reports import _z_vat

        vat = _z_vat(z)

    facts = ZFacts(
        z_id=z.id,
        z_number=z.z_number,
        business_date=z.business_date,
        shop_id=z.shop_id,
        shop_name=shop_name,
        breakdown=breakdown,
        cash_tips=_dec(z.total_cash_tips),
        card_tips=_dec(z.total_card_tips),
        variance=_z_variance(z),
        declined_amount=declined,
        vat_total=None if vat is None else _dec(vat),
        net=sum(breakdown.values(), ZERO),
        # A till's own Z (`zMode = till`): named by its register, "קופה 2".
        till_label=_till_label_of(z),
    )

    if z.per_machine is None:
        return facts  # A till-issued Z: no shifts to read documents from.

    documents: List[Transaction] = (
        db.query(Transaction)
        .join(Shift, Shift.id == Transaction.shift_id)
        .filter(
            Shift.z_report_id == z.id,
            Transaction.machine_id == Shift.machine_id,
            Transaction.status.in_(SALE_STATUSES),
        )
        .all()
    )

    # Income per VAT rate. Only used when every document declared its VAT and the
    # documents add up to the Z (a late document is stored but not in the Z's figures);
    # otherwise the entry falls back to the Z's own net and VAT in one income line.
    by_rate: Dict[Decimal, List[Decimal]] = {}
    complete = True
    for doc in documents:
        if doc.vat_amount is None:
            complete = False
            break
        refund = is_refund_document(
            document_type=doc.document_type, refund_of_transaction_id=doc.refund_of_transaction_id
        )
        sign = Decimal("-1") if refund else Decimal("1")
        collected = expected_tender_total(
            total_amount=doc.total_amount,
            document_discount=doc.document_discount,
            document_type=doc.document_type,
            refund_of_transaction_id=doc.refund_of_transaction_id,
        )
        vat_amount = _dec(doc.vat_amount)
        rate = _dec(doc.vat_rate).normalize() if doc.vat_rate is not None else (
            ZERO if vat_amount == 0 else None
        )
        if rate is None:
            complete = False
            break
        bucket = by_rate.setdefault(rate, [ZERO, ZERO])
        bucket[0] += sign * collected
        bucket[1] += sign * vat_amount
    if complete and by_rate:
        gross = sum((b[0] for b in by_rate.values()), ZERO)
        vat_sum = sum((b[1] for b in by_rate.values()), ZERO)
        if (
            abs(gross - facts.net) <= CENT
            and facts.vat_total is not None
            and abs(vat_sum - facts.vat_total) <= CENT
        ):
            facts.income_by_rate = {r: (b[0], b[1]) for r, b in by_rate.items()}

    doc_ids = [d.id for d in documents]
    if want_brands and doc_ids:
        refund_ids = {
            d.id
            for d in documents
            if is_refund_document(
                document_type=d.document_type, refund_of_transaction_id=d.refund_of_transaction_id
            )
        }
        for leg in (
            db.query(TransactionPayment)
            .filter(TransactionPayment.transaction_id.in_(doc_ids))
            .all()
        ):
            if (leg.method or "").strip().lower() != "card":
                continue
            key = _leg_brand(leg)
            sign = Decimal("-1") if leg.transaction_id in refund_ids else Decimal("1")
            facts.card_legs[key] = facts.card_legs.get(key, ZERO) + sign * _dec(leg.amount)
            facts.card_by_brand[key[0]] = facts.card_by_brand.get(key[0], ZERO) + sign * _dec(leg.amount)

    if want_voucher_sales and doc_ids:
        for v in (
            db.query(IssuedVoucher).filter(IssuedVoucher.transaction_id.in_(doc_ids)).all()
        ):
            status = getattr(v.status, "value", v.status)
            if str(status).lower() in ("cancelled", "voided", "void"):
                continue
            face = v.face_value if v.face_value is not None else _dec(v.unit_value) * _dec(v.quantity or 1)
            facts.voucher_sales += _dec(face)
    return facts


# ── Lines ────────────────────────────────────────────────────────────────────


def _line(key: str, signed: Decimal, label: str, accounts: Dict[str, str]) -> Optional[JournalLine]:
    signed = _q(signed)
    if signed == 0:
        return None
    account_key = key.split(":", 1)[0]
    account = accounts.get(account_key)
    if ":" in key and account_key in ("card", "cardAcquirer"):
        account = accounts.get(key)  # filled from cardBrands / cardAcquirers by the caller
    return JournalLine(
        side="D" if signed > 0 else "C",
        key=key,
        account=account,
        amount=abs(signed),
        label=label,
    )


def _z_details(
    numbers: Sequence[Optional[int]], shop_name: str, suffix: str = "", tills: Sequence[str] = ()
) -> str:
    nums = sorted(n for n in numbers if n is not None)
    if not nums:
        ref = "Z"
    elif nums[0] == nums[-1]:
        ref = f"Z {nums[0]}"
    else:
        ref = f"Z {nums[0]}-{nums[-1]}"
    # Tills' own Zs ("Z לכל קופה") are numbered per till: name the tills, or "Z 1" says
    # nothing about which.
    till_names = sorted(set(tills))
    if till_names:
        ref = f"{', '.join(till_names)} {ref}"
    parts = [ref] + ([suffix] if suffix else []) + ([shop_name] if shop_name else [])
    return " · ".join(parts)


def build_lines(facts: ZFacts, settings: Dict) -> Tuple[List[JournalLine], List[Problem]]:
    """The lines of one Z, unbalanced remainder included as `rounding` (or a problem)."""
    accounts: Dict[str, str] = dict(settings.get("accounts") or {})
    brands: Dict[str, str] = dict(settings.get("cardBrands") or {})
    acquirers: Dict[str, str] = dict(settings.get("cardAcquirers") or {})
    for brand, account in brands.items():
        accounts[f"card:{brand}"] = account
    for acquirer, account in acquirers.items():
        accounts[f"cardAcquirer:{acquirer}"] = account

    problems: List[Problem] = []
    raw: List[Tuple[str, Decimal, str]] = []  # (key, debit-positive amount, label)

    breakdown = dict(facts.breakdown)
    cash = breakdown.pop("cash", ZERO)
    card = breakdown.pop("card", ZERO)
    breakdown.pop(EXCHANGE_PAYMENT_METHOD, None)  # nets to zero; any rest is the remainder

    variance = facts.variance or ZERO
    raw.append(("cash", cash + facts.cash_tips + variance, LABELS["cash"]))

    # Card legs to the account of their acquirer (חברת סליקה — what the settlement
    # report is per) when one is mapped, else of their brand (מותג), else the generic
    # card account below, which also carries card tips and the declined offline sales.
    card_rest = card + facts.card_tips - facts.declined_amount
    legs = dict(facts.card_legs) or {
        (b, card_brands.UNKNOWN): a for b, a in facts.card_by_brand.items()
    }
    split: Dict[str, Tuple[Decimal, str]] = {}
    for (brand, acquirer), amount in sorted(legs.items()):
        if acquirer in acquirers:
            key, label = f"cardAcquirer:{acquirer}", f"{LABELS['card']} {card_brands.acquirer_label(acquirer)}"
        elif brand in brands:
            key, label = f"card:{brand}", f"{LABELS['card']} {card_brands.brand_label(brand)}"
        else:
            continue
        prev = split.get(key, (ZERO, label))[0]
        split[key] = (prev + amount, label)
    for key, (amount, label) in split.items():
        raw.append((key, amount, label))
        card_rest -= amount
    raw.append(("card", card_rest, LABELS["card"]))
    raw.append(("cardDeclined", facts.declined_amount, LABELS["cardDeclined"]))

    vouchers = ZERO
    for method in sorted(breakdown):
        amount = breakdown[method]
        if method in VOUCHER_METHODS:
            vouchers += amount
        else:
            raw.append(("otherTenders", amount, f"{LABELS['otherTenders']} {method}"))
    raw.append(("vouchers", vouchers, LABELS["vouchers"]))

    # Income and VAT.
    if facts.vat_total is None:
        problems.append(
            Problem("vat_unknown", facts.z_id, facts.z_number, facts.shop_name,
                    "a document of this Z declared no VAT")
        )
        vat_total = ZERO
    else:
        vat_total = facts.vat_total

    voucher_sales = (
        facts.voucher_sales if settings.get("voucherSalesAsLiability") else ZERO
    )
    if facts.income_by_rate:
        rates = sorted(facts.income_by_rate.items(), key=lambda kv: kv[0], reverse=True)
        vat_lines = ZERO
        for rate, (gross, vat) in rates:
            if voucher_sales and rate == rates[0][0] and gross:
                # Vouchers are sold at the standard rate; move their price out of income.
                share_vat = _q(voucher_sales * vat / gross) if gross else ZERO
                gross -= voucher_sales
                vat -= share_vat
            net = gross - vat
            key = "incomeExempt" if rate == 0 else "incomeTaxable"
            pct = (rate * 100).normalize()
            label = LABELS[key] if rate == 0 else f"{LABELS['incomeTaxable']} {pct:f}%"
            raw.append((key, -net, label))
            vat_lines += vat
        raw.append(("vatOutput", -vat_lines, LABELS["vatOutput"]))
    else:
        # The full net, `exchange` included: an incomplete basket's exchange net is income
        # no tender line carries, so it surfaces as the remainder below.
        income_gross = facts.net - voucher_sales
        vat = vat_total
        if voucher_sales and income_gross + voucher_sales:
            vat -= _q(voucher_sales * vat_total / (income_gross + voucher_sales))
        key = "incomeExempt" if vat_total == 0 and income_gross != 0 else "incomeTaxable"
        raw.append((key, -(income_gross - vat), LABELS[key]))
        raw.append(("vatOutput", -vat, LABELS["vatOutput"]))

    raw.append(("tips", -(facts.cash_tips + facts.card_tips), LABELS["tips"]))
    raw.append(("voucherSales", -voucher_sales, LABELS["voucherSales"]))
    raw.append(("cashOverShort", -variance, LABELS["cashOverShort"]))

    lines = [l for l in (_line(k, a, label, accounts) for k, a, label in raw) if l is not None]
    diff = _q(sum((l.signed for l in lines), ZERO))
    if diff != 0:
        if abs(diff) <= MAX_ROUNDING:
            lines.append(_line("rounding", -diff, LABELS["rounding"], accounts))
        else:
            problems.append(
                Problem("unbalanced", facts.z_id, facts.z_number, facts.shop_name, f"{diff:f}")
            )
    return lines, problems


def _merge_lines(lines: Iterable[JournalLine]) -> List[JournalLine]:
    """
    Sum lines of one key and label (debit-positive) and re-split by sign. Lines of a
    consolidated entry also keep their shop (branch, account) apart.
    """
    order: List[Tuple] = []
    acc: Dict[Tuple, Tuple[Decimal, Optional[str]]] = {}
    for l in lines:
        k = (l.key, l.label, l.branch, l.shop_name, l.account if l.shop_name else None)
        if k not in acc:
            order.append(k)
            acc[k] = (ZERO, l.account)
        acc[k] = (acc[k][0] + l.signed, acc[k][1])
    out: List[JournalLine] = []
    for k in order:
        total, account = acc[k]
        if total != 0:
            out.append(
                JournalLine(
                    "D" if total > 0 else "C", k[0], account, abs(total), k[1],
                    branch=k[2], shop_name=k[3],
                )
            )
    # Debits first, then credits, each in the order they first appeared.
    return [l for l in out if l.side == "D"] + [l for l in out if l.side == "C"]


def build_entries(
    facts_list: Sequence[ZFacts],
    settings_by_shop: Dict[Optional[uuid.UUID], Dict],
    *,
    grouping: str = "z",
    consolidate: bool = False,
    company_settings: Optional[Dict] = None,
    company_name: str = "",
) -> List[JournalEntry]:
    """
    The entries for `facts_list`, one per Z (default), per shop and day, or per shop and
    month. Raises `JournalRefused` with every problem found — mapping gaps included — so
    the user fixes them all at once rather than one per attempt.

    `consolidate` (a company-level export, ברמת חברה): one entry per day / month for all
    the shops together, under the company's movement type and branch code. Each line
    keeps its shop: its account comes from that shop's settings (the company's unless the
    shop overrides it), and its branch field carries the shop's cost centre (מרכז רווח,
    else its branch code). With grouping "z" every Z is still its own entry.
    """
    if grouping not in GROUPINGS:
        raise ValueError(f"grouping must be one of {GROUPINGS}")
    consolidate = consolidate and grouping != "z"

    problems: List[Problem] = []
    per_z: List[Tuple[ZFacts, List[JournalLine]]] = []
    for facts in facts_list:
        lines, found = build_lines(facts, settings_by_shop.get(facts.shop_id, {}))
        problems += found
        if consolidate:
            s = settings_by_shop.get(facts.shop_id, {})
            centre = facts.cost_center or str(s.get("costCenter") or s.get("branchCode") or "")
            for l in lines:
                l.branch = centre
                l.shop_name = facts.shop_name
        per_z.append((facts, lines))

    def group_key(f: ZFacts):
        shop = None if consolidate else f.shop_id
        if grouping == "z":
            return (shop, f.z_id)
        if grouping == "day":
            return (shop, f.business_date)
        return (shop, (f.business_date.year, f.business_date.month))

    groups: Dict[object, List[Tuple[ZFacts, List[JournalLine]]]] = {}
    order_key = (
        (lambda it: (it[0].business_date, str(it[0].shop_id), it[0].z_number or 0))
        if consolidate
        else (lambda it: (str(it[0].shop_id), it[0].business_date, it[0].z_number or 0))
    )
    for item in sorted(per_z, key=order_key):
        groups.setdefault(group_key(item[0]), []).append(item)

    entries: List[JournalEntry] = []
    for _key, items in groups.items():
        first = items[0][0]
        if consolidate:
            settings = company_settings or {}
            shop_id, name = None, company_name
        else:
            settings = settings_by_shop.get(first.shop_id, {})
            shop_id, name = first.shop_id, first.shop_name
        numbers = [f.z_number for f, _ in items]
        tills = [f.till_label for f, _ in items if f.till_label]
        if grouping == "month":
            d = items[-1][0].business_date
            entry_date = date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
            details = _z_details(numbers, name, f"{d.month:02d}/{d.year}", tills)
        else:
            entry_date = max(f.business_date for f, _ in items)
            details = _z_details(numbers, name, tills=tills)
        lines = _merge_lines(l for _f, ls in items for l in ls)
        branch = str(settings.get("branchCode") or "")
        entries.append(
            JournalEntry(
                shop_id=shop_id,
                shop_name=name,
                reference1=min((n for n in numbers if n is not None), default=0),
                reference2=branch,
                entry_date=entry_date,
                value_date=entry_date,
                details=details,
                branch=branch,
                movement_type=str(settings.get("movementType") or ""),
                z_ids=[f.z_id for f, _ in items],
                lines=lines,
            )
        )

    # Mapping gaps: every line must have an account, and the entry a movement type.
    seen = set()
    for entry in entries:
        if not entry.movement_type and ("movementType", entry.shop_id) not in seen:
            seen.add(("movementType", entry.shop_id))
            problems.append(Problem("missing_mapping", None, None, entry.shop_name, "movementType"))
        for line in entry.lines:
            owner = line.shop_name or entry.shop_name
            if not line.account and (line.key, owner) not in seen:
                seen.add((line.key, owner))
                key = line.key.split(":", 1)[0]
                problems.append(
                    Problem("missing_mapping", None, None, owner, f"accounts.{key}")
                )
    if problems:
        raise JournalRefused(problems)
    return entries
