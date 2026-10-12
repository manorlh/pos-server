"""
Prepaid voucher rules shared with the tills (docs/SPEC_VOUCHER_PRODUCTION.md §7): which
vouchers may share one sale, and what a discount voucher takes off a basket.

The Android till and kiosk run the very same rules (pos-android domain/VoucherDiscount.kt).
Both sides are pinned by one fixture, `tests/fixtures/prepaid_voucher_rules.json` here and
`app/src/test/resources/prepaid_voucher_rules.json` on the till (same bytes), so what the
till shows and what the cloud checks never disagree. Change both, and the fixture, together.

Pure: no database, no clock. Money in whole agorot; a percent in basis points (2000 = 20%).

**Stacking** (`stacking_refusal`) — per batch, one of:

* `single` ("שובר אחד בעסקה") — no other voucher in the same sale, of any kind ("ניתן לממש
  שובר אחד בלבד בעסקה");
* `unlimited` ("כמה שוברים בעסקה", the default of a new type) — any (every batch made before
  kinds existed);
* `distinct_batches` ("כמה שוברים, רק מסוגים שונים") — others, but none of the same batch.

With `unlimited` / `distinct_batches` a batch may set `max_per_sale` ("מספר שוברים מקסימלי
בעסקה"): the sale holds at most that many vouchers, this one included. Every voucher in the sale
with a maximum is honoured — the smallest wins ("הגעת למספר השוברים המקסימלי בעסקה (N)").

The same voucher again is not "another voucher": a goods voucher may be redeemed twice in
one sale (the rest of its goods), a discount voucher is refused (`already_applied` — its
uses in one sale are taken in one go). Vouchers of one batch follow its stacking — two item
discounts of one batch share a sale under `unlimited` (each on its own units, below) — except
an order discount: two of one batch never share a sale, whatever the stacking (the same order
discounted twice): `same_batch`, worded "שובר הנחה על כל העסקה — ניתן לממש שובר אחד מכל סדרה
בעסקה".

**The discount** (`discount_for`) — on the sale lines as they stand (after line discounts
and promotions, and after the vouchers applied before this one), per the batch's
promotion policy, per line:

* `exclude` ("לא על מוצר במבצע", the default) — a line with a promotion is left out: an
  order discount is computed on the basket without the promoted lines (and its minimum
  purchase checked on that same base); an item discount skips promoted units;
* `best` ("ההטבה הטובה מבין השתיים") — the voucher is computed on the line as if it had no
  promotion; a line keeps the bigger of the two, never both. Lines where the promotion
  wins are left out and the voucher recomputed without them (so a fixed ₪ voucher still
  gives its full value on the other lines); lines where the voucher wins lose their
  promotion (`drop_promotion`);
* `combine` ("מצטבר") — both: the voucher on the line's net after its promotion.

A product that takes no discount ("לא מקבל הנחות") is never discounted. An order discount
is fixed (× the uses taken) or a percent of the base (capped by `max_discount`), never more
than the base, shared over the lines in proportion (largest remainder, ties by line order).
An item discount is per unit — fixed (up to the unit's price) or a percent — on the most
valuable units first, at most `max_units` × uses units.

**Every unit once** (several item discounts in one sale, of one batch or of several): a unit an
earlier item discount took is never discounted again. The line says how many of its units the
vouchers before took (`voucher_units`) and what they took off them (`voucher_units_amount`, a
part of `voucher`); the next item discount takes the line's other units only, each at the
unit's price before those vouchers (after the order discounts before it, as before). A line
with no unit left is not the voucher's; none left anywhere: `no_eligible_items`. The result
says which units each voucher took (`units`), and `discounts_in_order` applies a sale's
vouchers one after another exactly so (`lines_after`).

**Every product type** (docs/SPEC_VOUCHER_PRODUCTION.md §7.14): a line is its actual price
(shop / menu price, with its options and a meal's upcharges, after its line discount and
promotion). A product sold by weight (`weighed`) is discounted per unit of its measure
(a kg) **pro rata**: 0.75 kg takes 0.75 of a kg's discount, and `max_units` counts its
measure — 1 unit = 1 kg (a fraction of one when that is all there is). A whole unit of a
product sold by the piece needs a whole unit of room under `max_units`. The general item
("פריט כללי", `general`) has no identity: an item discount never takes it (not even by its
category); an order discount takes it like any line.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

KINDS = ("items", "order_discount", "item_discount")
DISCOUNT_KINDS = ("order_discount", "item_discount")
DISCOUNT_TYPES = ("fixed", "percent")
STACKING = ("single", "distinct_batches", "unlimited")
PROMOTION_POLICIES = ("exclude", "best", "combine")

# ── Refusals (409 details; the till words them) ──────────────────────────────
ALREADY_APPLIED = "prepaid_voucher_already_applied"
NOT_STACKABLE = "prepaid_voucher_not_stackable"
OTHER_NOT_STACKABLE = "prepaid_voucher_other_not_stackable"
SAME_BATCH = "prepaid_voucher_same_batch"
MAX_PER_SALE = "prepaid_voucher_max_per_sale"
MIN_PURCHASE = "prepaid_voucher_min_purchase"
NO_ELIGIBLE = "prepaid_voucher_no_eligible_items"
PROMOTION_BETTER = "prepaid_voucher_promotion_better"

# ── Why a line was left out (shown under the voucher at the till) ────────────
SKIP_PROMOTED = "promoted"
SKIP_NO_DISCOUNT = "no_discount"
SKIP_PROMOTION_BETTER = "promotion_better"
SKIP_MAX_UNITS = "max_units"

BASIS = 10_000


# ── Stacking ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VoucherInSale:
    """A voucher in (or coming into) one sale, as the stacking rules see it."""

    voucher_id: str
    batch_id: str
    kind: str = "items"
    stacking: str = "single"
    #: "מספר שוברים מקסימלי בעסקה" (with `unlimited` / `distinct_batches`): the most vouchers the
    #: sale may hold, this one included. None: no maximum.
    max_per_sale: Optional[int] = None


#: The Hebrew the cashier reads for a stacking refusal (`{n}`: the maximum). The others are the
#: till's own words for the code.
STACKING_TEXT = {
    NOT_STACKABLE: "ניתן לממש שובר אחד בלבד בעסקה",
    OTHER_NOT_STACKABLE: "ניתן לממש שובר אחד בלבד בעסקה",
    MAX_PER_SALE: "הגעת למספר השוברים המקסימלי בעסקה ({n})",
}

#: `same_batch` of an order discount (two of one batch would discount the same order twice).
ORDER_SAME_BATCH_TEXT = "שובר הנחה על כל העסקה — ניתן לממש שובר אחד מכל סדרה בעסקה"


def sale_limit(existing: Iterable[VoucherInSale], incoming: VoucherInSale) -> Optional[int]:
    """
    The maximum [incoming] would break by joining the sale (the smallest of the vouchers'
    `max_per_sale`, a `single` one aside), or None. A voucher counts once however many of its
    goods the sale takes.
    """
    everyone = [v for v in existing if v.voucher_id != incoming.voucher_id] + [incoming]
    count = len({v.voucher_id for v in everyone})
    limits = [int(v.max_per_sale) for v in everyone if v.max_per_sale and v.stacking != "single"]
    if limits and count > min(limits):
        return min(limits)
    return None


def stacking_text(code: Optional[str], limit: Optional[int] = None, kind: Optional[str] = None) -> Optional[str]:
    """
    The cloud's words for a stacking refusal, or None (the till's own text for the code). [kind]:
    the incoming voucher's — `same_batch` of an order discount has its own words.
    """
    if code == SAME_BATCH and kind == "order_discount":
        return ORDER_SAME_BATCH_TEXT
    text = STACKING_TEXT.get(code or "")
    if text is None:
        return None
    return text.format(n=limit if limit is not None else "")


def stacking_refusal(existing: Iterable[VoucherInSale], incoming: VoucherInSale) -> Optional[str]:
    """Why [incoming] may not join the sale that already holds [existing], or None."""
    existing = list(existing)
    discount = incoming.kind in DISCOUNT_KINDS
    if discount and any(v.voucher_id == incoming.voucher_id for v in existing):
        return ALREADY_APPLIED
    others = [v for v in existing if v.voucher_id != incoming.voucher_id]
    if not others:
        return None
    if incoming.stacking == "single":
        return NOT_STACKABLE
    if any(v.stacking == "single" for v in others):
        return OTHER_NOT_STACKABLE
    same = [v for v in others if v.batch_id == incoming.batch_id]
    if same and (
        # An order discount: one of a batch per sale, whatever the stacking (never the same order twice).
        incoming.kind == "order_discount"
        or any(v.kind == "order_discount" for v in same)
        or incoming.stacking == "distinct_batches"
        or any(v.stacking == "distinct_batches" for v in same)
    ):
        return SAME_BATCH
    if sale_limit(others, incoming) is not None:
        return MAX_PER_SALE
    return None


# ── The discount ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Benefit:
    """A discount batch's terms, as the rules need them."""

    kind: str
    discount_type: str
    #: Agorot (`fixed`) or basis points (`percent`).
    value: int
    min_purchase: Optional[int] = None
    max_discount: Optional[int] = None
    max_units: Optional[int] = None
    product_ids: frozenset = frozenset()
    category_ids: frozenset = frozenset()
    promotion_policy: str = "exclude"


@dataclass(frozen=True)
class BasketLine:
    """One sale line of the basket (refund lines are never given)."""

    id: str
    #: Every id the line's product goes by (the till's own, the cloud's).
    product_ids: Tuple[str, ...] = ()
    category_ids: Tuple[str, ...] = ()
    quantity: float = 1.0
    #: Unit price × quantity, before anything was taken off.
    gross: int = 0
    #: The cashier's own line discount.
    line_discount: int = 0
    #: What promotions took off the line.
    promotion: int = 0
    #: What vouchers applied before this one already took off the line.
    voucher: int = 0
    #: The line's units (its measure: kg when weighed) item discounts before this one took —
    #: never discounted again.
    voucher_units: float = 0.0
    #: What those item discounts took off those units (a part of [voucher]).
    voucher_units_amount: int = 0
    #: False: "לא מקבל הנחות".
    discountable: bool = True
    #: Sold by weight or measure: [quantity] is a decimal (kg), discounted pro rata.
    weighed: bool = False
    #: The general item ("פריט כללי"): never an item discount's, an order discount's like any line.
    general: bool = False


@dataclass
class DiscountResult:
    amount: int = 0
    #: {line id: agorot} — sums to [amount].
    shares: Dict[str, int] = field(default_factory=dict)
    #: `best`: the lines whose promotion gives way to the voucher.
    drop_promotion: List[str] = field(default_factory=list)
    #: (line id, reason) in line order — what the till shows under the voucher.
    skipped: List[Tuple[str, str]] = field(default_factory=list)
    #: Why nothing was taken off, or None.
    refusal: Optional[str] = None
    #: An item discount: {line id: the units it took} (kg when weighed) — never taken again.
    units: Dict[str, float] = field(default_factory=dict)


def _targets(benefit: Benefit, line: BasketLine) -> bool:
    if benefit.kind == "order_discount":
        return True
    if line.general:
        return False  # no identity: never an item discount's, not even by its category
    return bool(set(line.product_ids) & benefit.product_ids) or bool(set(line.category_ids) & benefit.category_ids)


def _whole_units(quantity: float) -> int:
    """The line's whole units; 0 for a fraction of a product sold by the piece (an item discount is per unit)."""
    q = round(quantity)
    return int(q) if q >= 1 and abs(quantity - q) < 1e-9 else 0


#: A unit in thousandths: a weighed line's quantity (kg) is counted in grams.
MILLI = 1000


def _milli(quantity: float) -> int:
    """
    [quantity] in thousandths of a unit (0.734 kg → 734): the double product rounded half up,
    exactly as the till's `Math.round(quantity * 1000)` (never Python's round-half-even).
    """
    return int(Decimal(float(quantity) * MILLI).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _unit_off(benefit: Benefit, unit: int) -> int:
    """What the discount takes off one whole unit whose net price is [unit]."""
    if benefit.discount_type == "fixed":
        return min(benefit.value, unit)
    return unit * benefit.value // BASIS


def _taken(line: BasketLine) -> int:
    """The line's units earlier item discounts took, in thousandths."""
    return _milli(line.voucher_units) if line.voucher_units > 0 else 0


def _free(line: BasketLine) -> int:
    """
    What an item discount may still take of the line, in thousandths: its whole units (any weight
    of a weighed product) less what earlier item discounts took.
    """
    if line.weighed:
        return max(0, _milli(line.quantity) - _taken(line))
    q = _whole_units(line.quantity)
    return max(0, q - (_taken(line) + MILLI - 1) // MILLI) * MILLI


def _has_units(line: BasketLine) -> bool:
    """Something an item discount can count: a whole unit, or any weight of a weighed product, not taken yet."""
    return _free(line) >= 1


def _order_shares(benefit: Benefit, active: List[Tuple[BasketLine, int]], uses: int, base: int) -> Dict[str, int]:
    if benefit.discount_type == "fixed":
        raw = benefit.value * uses
    else:
        raw = base * benefit.value // BASIS
    if benefit.max_discount is not None:
        raw = min(raw, benefit.max_discount)
    amount = max(0, min(raw, base))
    shares: Dict[str, int] = {}
    if amount == 0 or base <= 0:
        return shares
    floors = [(amount * net) // base for _, net in active]
    left = amount - sum(floors)
    remainders = sorted(range(len(active)), key=lambda i: (-((amount * active[i][1]) % base), i))
    for i in remainders[:left]:
        floors[i] += 1
    for (line, _), share in zip(active, floors):
        if share > 0:
            shares[line.id] = share
    return shares


def _item_shares(
    benefit: Benefit, active: List[Tuple[BasketLine, int]], uses: int
) -> Tuple[Dict[str, int], Dict[str, int]]:
    """
    Per unit, the most valuable first, at most `max_units` × uses units. Units are counted in
    thousandths ([MILLI]) so a weighed line's kg are units too: its whole kg, then what is
    left of a kg (its discount pro rata, half up). A unit sold by the piece needs a whole
    unit of room; a weighed slot takes what room is left, pro rata. Only the units no earlier
    item discount took ([_free]), each at the unit's price before those took theirs.
    Returns ({line id: agorot}, {line id: thousandths taken}).
    """
    # (what this slot takes off, position in active, its size in thousandths, a whole unit's discount)
    slots: List[Tuple[int, int, int, int]] = []
    for pos, (line, net) in enumerate(active):
        free = _free(line)
        if free < 1:
            continue
        # The line's net before the item discounts that took some of its units (after any order discount).
        before = net + max(0, int(line.voucher_units_amount))
        if line.weighed:
            mq = _milli(line.quantity)
            unit = (2 * before * MILLI + mq) // (2 * mq)  # the net price of one kg, half up
            off = _unit_off(benefit, unit)
            if off <= 0:
                continue
            whole, rest = divmod(free, MILLI)
            slots.extend([(off, pos, MILLI, off)] * whole)
            if rest:
                slots.append(((off * rest + MILLI // 2) // MILLI, pos, rest, off))
        else:
            q = _whole_units(line.quantity)
            unit = (2 * before + q) // (2 * q)  # the unit's net price, half up
            off = _unit_off(benefit, unit)
            if off > 0:
                slots.extend([(off, pos, MILLI, off)] * (free // MILLI))
    slots.sort(key=lambda s: (-s[0], s[1]))
    room = None if benefit.max_units is None else max(0, benefit.max_units * uses) * MILLI
    shares: Dict[str, int] = {}
    units: Dict[str, int] = {}
    for take, pos, size, per_unit in slots:
        line = active[pos][0]
        if room is not None:
            if room <= 0:
                break
            if size > room:
                if not line.weighed:
                    continue  # a whole unit needs a whole unit of room
                take, size = (per_unit * room + MILLI // 2) // MILLI, room
            room -= size
        if take > 0:
            shares[line.id] = shares.get(line.id, 0) + take
            units[line.id] = units.get(line.id, 0) + size
    for line, net in active:
        if shares.get(line.id, 0) > net:
            shares[line.id] = net
    return shares, units


def discount_for(benefit: Benefit, lines: Sequence[BasketLine], uses: int = 1) -> DiscountResult:
    """What [benefit] takes off [lines] for [uses] uses — see the module docstring."""
    uses = max(1, int(uses))
    policy = benefit.promotion_policy if benefit.promotion_policy in PROMOTION_POLICIES else "exclude"
    order = {line.id: n for n, line in enumerate(lines)}
    skipped: Dict[str, str] = {}
    candidates: List[Tuple[BasketLine, int]] = []
    for line in lines:
        if not _targets(benefit, line):
            continue
        if not line.discountable:
            skipped[line.id] = SKIP_NO_DISCOUNT
            continue
        promoted = line.promotion > 0
        if promoted and policy == "exclude":
            skipped[line.id] = SKIP_PROMOTED
            continue
        if benefit.kind == "item_discount" and not _has_units(line):
            continue  # a fraction of a product sold by the piece has no unit to discount
        promotion = 0 if (promoted and policy == "best") else line.promotion
        net = line.gross - line.line_discount - promotion - line.voucher
        if net > 0:
            candidates.append((line, net))

    def done(amount=0, shares=None, drop=None, refusal=None, units=None) -> DiscountResult:
        return DiscountResult(
            amount=amount,
            shares=shares or {},
            drop_promotion=drop or [],
            skipped=sorted(skipped.items(), key=lambda kv: order[kv[0]]),
            refusal=refusal,
            units={k: v / MILLI for k, v in (units or {}).items() if (shares or {}).get(k, 0) > 0},
        )

    if not candidates:
        return done(refusal=NO_ELIGIBLE)
    excluded: set = set()
    units: Dict[str, int] = {}
    while True:
        active = [(line, net) for line, net in candidates if line.id not in excluded]
        if not active:
            return done(refusal=PROMOTION_BETTER if SKIP_PROMOTION_BETTER in skipped.values() else NO_ELIGIBLE)
        if benefit.kind == "order_discount":
            base = sum(net for _, net in active)
            if benefit.min_purchase and base < benefit.min_purchase:
                return done(refusal=MIN_PURCHASE)
            shares = _order_shares(benefit, active, uses, base)
        else:
            shares, units = _item_shares(benefit, active, uses)
        if policy != "best":
            break
        losers = [
            line.id for line, _ in active
            if line.promotion > 0 and 0 < shares.get(line.id, 0) <= line.promotion
        ]
        if not losers:
            break
        for line_id in losers:
            excluded.add(line_id)
            skipped[line_id] = SKIP_PROMOTION_BETTER
    if benefit.kind == "item_discount":
        for line, _ in active:
            if shares.get(line.id, 0) == 0:
                skipped.setdefault(line.id, SKIP_MAX_UNITS)
    amount = sum(shares.values())
    if amount <= 0:
        return done(refusal=PROMOTION_BETTER if SKIP_PROMOTION_BETTER in skipped.values() else NO_ELIGIBLE)
    drop = (
        [line.id for line, _ in active if line.promotion > 0 and shares.get(line.id, 0) > 0]
        if policy == "best" else []
    )
    return done(amount=amount, shares=shares, drop=drop, units=units)


def lines_after(benefit: Benefit, lines: Sequence[BasketLine], result: DiscountResult) -> List[BasketLine]:
    """
    [lines] as the next voucher sees them once [result] (of [benefit]) is taken off: each share on
    the line's `voucher`, a promotion that gave way (`drop_promotion`) off its line, and an item
    discount's units taken (`voucher_units` + its units, `voucher_units_amount` + its share) —
    never discounted again.
    """
    if result.amount <= 0:
        return list(lines)
    drop = set(result.drop_promotion)
    item = benefit.kind == "item_discount"
    out: List[BasketLine] = []
    for line in lines:
        share = result.shares.get(line.id, 0)
        if share <= 0 and line.id not in drop:
            out.append(line)
            continue
        taken = _milli(result.units.get(line.id, 0.0)) if item and share > 0 else 0
        out.append(replace(
            line,
            voucher=line.voucher + share,
            promotion=0 if line.id in drop else line.promotion,
            voucher_units=(_taken(line) + taken) / MILLI if taken else line.voucher_units,
            voucher_units_amount=line.voucher_units_amount + (share if taken else 0),
        ))
    return out


def discounts_in_order(
    vouchers: Sequence[Tuple[Benefit, int]], lines: Sequence[BasketLine]
) -> List[DiscountResult]:
    """
    A sale's discount vouchers ((benefit, uses), in the order applied) on [lines], each on the
    basket as the ones before left it ([lines_after]) — what the till's basket shows, voucher by
    voucher. A voucher with nothing left to take is refused (`no_eligible_items` …), as alone.
    """
    results: List[DiscountResult] = []
    current = list(lines)
    for benefit, uses in vouchers:
        r = discount_for(benefit, current, uses)
        results.append(r)
        current = lines_after(benefit, current, r)
    return results


def uses_wanted(benefit: Benefit, lines: Sequence[BasketLine], allowed: int) -> int:
    """
    How many uses one sale takes, at most [allowed] (the batch's per-sale limit, the uses
    left, the day's): as many as still add something — a fixed order discount until it
    covers the base, an item discount until every eligible unit is discounted. A percent
    order discount is one use.
    """
    allowed = max(1, int(allowed))
    if allowed == 1:
        return 1
    if benefit.kind == "order_discount" and benefit.discount_type == "percent":
        return 1
    best = discount_for(benefit, lines, 1)
    uses = 1
    while uses < allowed:
        more = discount_for(benefit, lines, uses + 1)
        if more.amount <= best.amount:
            break
        best, uses = more, uses + 1
    return uses


# ── Words ─────────────────────────────────────────────────────────────────────


def money_text(agorot: int) -> str:
    """₪30, ₪12.50 — whole shekels without decimals."""
    agorot = int(agorot)
    if agorot % 100 == 0:
        return f"₪{agorot // 100}"
    return f"₪{agorot // 100}.{agorot % 100:02d}"


def percent_text(basis_points: int) -> str:
    """20%, 12.5% — no trailing zeros."""
    value = (Decimal(int(basis_points)) / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP).normalize()
    return f"{value:f}%"


def benefit_text(
    kind: str,
    discount_type: Optional[str],
    value: Optional[int],
    *,
    min_purchase: Optional[int] = None,
    max_discount: Optional[int] = None,
    max_units: Optional[int] = None,
    target_names: Sequence[str] = (),
) -> Optional[str]:
    """
    What a discount voucher gives, as printed on it and shown on the dashboard: "₪30 הנחה
    על כל ההזמנה", "20% הנחה על קפה (עד 2 יחידות)". None for a goods voucher.
    """
    if kind not in DISCOUNT_KINDS or value is None or discount_type not in DISCOUNT_TYPES:
        return None
    amount = money_text(value) if discount_type == "fixed" else percent_text(value)
    if kind == "order_discount":
        text = f"{amount} הנחה על כל ההזמנה"
        if discount_type == "percent" and max_discount:
            text += f" (עד {money_text(max_discount)})"
        if min_purchase:
            text += f" בקנייה מעל {money_text(min_purchase)}"
        return text
    names = [n.strip() for n in target_names if n and n.strip()]
    shown = ", ".join(names[:3]) + (" ועוד" if len(names) > 3 else "")
    text = f"{amount} הנחה על {shown or 'פריטים נבחרים'}"
    if max_units and max_units > 1:
        text += f" (עד {max_units} יחידות)"
    return text


def benefit_of(batch) -> Optional[Benefit]:
    """A batch's terms as a [Benefit]; None for a goods batch."""
    if getattr(batch, "kind", "items") not in DISCOUNT_KINDS:
        return None
    targets = getattr(batch, "targets", None) or {}
    return Benefit(
        kind=batch.kind,
        discount_type=batch.discount_type or "fixed",
        value=int(batch.discount_value or 0),
        min_purchase=batch.min_purchase,
        max_discount=batch.max_discount,
        max_units=batch.max_units,
        product_ids=frozenset(str(p) for p in targets.get("productIds") or []),
        category_ids=frozenset(str(c) for c in targets.get("categoryIds") or []),
        promotion_policy=getattr(batch, "promotion_policy", None) or "exclude",
    )


def batch_benefit_text(batch) -> Optional[str]:
    targets = getattr(batch, "targets", None) or {}
    return benefit_text(
        getattr(batch, "kind", "items"),
        getattr(batch, "discount_type", None),
        getattr(batch, "discount_value", None),
        min_purchase=getattr(batch, "min_purchase", None),
        max_discount=getattr(batch, "max_discount", None),
        max_units=getattr(batch, "max_units", None),
        target_names=targets.get("names") or [],
    )


__all__ = [
    "Benefit", "BasketLine", "DiscountResult", "VoucherInSale",
    "stacking_refusal", "sale_limit", "stacking_text", "discount_for", "uses_wanted", "benefit_text", "benefit_of",
    "lines_after", "discounts_in_order",
    "batch_benefit_text", "money_text", "percent_text",
]
