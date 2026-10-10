"""
Production vouchers ("שוברי הפקה", P:\\specs\\production-vouchers-spec.md v1.2) — the pure rules the
cloud and the till must apply alike: which products a group of a voucher type takes, how basket
units are matched to groups, whether a chosen redemption is valid, how a fixed value is split
between the units to the agora, what a cover-up-to voucher pays and what the customer tops up,
and how a product that takes no discounts ("לא מקבל הנחות") is treated.

Every function here is pinned, case by case, by the shared golden fixture
tests/fixtures/prepaid_voucher_rules.json (sections `eligibility`, `assignment`, `selection`,
`splitValue`, `fixedShare`, `cover`, `override`) — the same bytes in pos-android's
app/src/test/resources, SHA-256 pinned on both sides (P:\\specs\\production-vouchers-api.md).
No database, no I/O: ids are strings, money is integer agorot, percents are basis points.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

# ── Refusal codes (the cloud's `detail`, the till's reason) ─────────────────────
NOT_IN_GROUP = "prepaid_voucher_item_not_on_voucher"
EXCLUDED = "prepaid_voucher_item_excluded"
GROUP_OVER = "prepaid_voucher_group_over"
TOTAL_OVER = "prepaid_voucher_total_over"
REPEAT = "prepaid_voucher_repeat_not_allowed"
PACKAGE_INCOMPLETE = "prepaid_voucher_package_incomplete"
NOTHING_CHOSEN = "prepaid_voucher_nothing_chosen"
TOP_UP_NOT_ALLOWED = "prepaid_voucher_top_up_not_allowed"
DISCOUNT_BLOCKED = "prepaid_voucher_discount_blocked"
OVERRIDE_CAP = "prepaid_voucher_override_cap"
APPROVAL_NEEDED = "prepaid_voucher_approval_needed"
VALUE_MISMATCH = "prepaid_voucher_value_mismatch"

#: Assignment reasons for a unit left without a group.
UNIT_NOT_ELIGIBLE = "not_eligible"
UNIT_GROUP_FULL = "group_full"
UNIT_TOTAL_FULL = "total_full"

#: The Hebrew the cashier reads (the spec's §11). `{group}` / `{type}` / `{n}` / `{amount}`.
TEXT = {
    NOT_IN_GROUP: "הפריט אינו כלול בשובר זה",
    EXCLUDED: "הפריט הוחרג משובר זה",
    "one_only": "ניתן לבחור פריט אחד בלבד בשובר זה",
    GROUP_OVER: "ניתן לבחור עד {n} פריטים מ\"{group}\"",
    "group_one": "ניתן לבחור פריט אחד בלבד מ\"{group}\"",
    TOTAL_OVER: "ניתן לבחור עד {n} פריטים בשובר זה",
    REPEAT: "אי אפשר לבחור את אותו פריט פעמיים ב{group}",
    PACKAGE_INCOMPLETE: "חסר {group} להשלמת {type}",
    "voucher": "השובר",
    NOTHING_CHOSEN: "לא נבחר פריט למימוש",
    "top_up": "נדרשת השלמה של {amount}",
    TOP_UP_NOT_ALLOWED: "נדרשת השלמה של {amount} — סוג השובר אינו מאפשר השלמה",
    DISCOUNT_BLOCKED: "הפריט חסום להנחות וסוג השובר אינו מאפשר כפייה",
    "out_of_scope": "הפריט חסום להנחות ואינו בהיקף הכפייה של סוג השובר",
    OVERRIDE_CAP: "ההפחתה חורגת מתקרת הכפייה שהוגדרה בשובר",
    APPROVAL_NEEDED: "נדרש אישור מנהל להנחה שהוגדרה בשובר",
    VALUE_MISMATCH: "ערכי הרכיבים עולים על שווי השובר",
}

BASIS = 10_000


def money_text(agorot: int) -> str:
    """₪30, ₪12.50 (as prepaid_voucher_rules.money_text)."""
    agorot = int(agorot)
    if agorot % 100 == 0:
        return f"₪{agorot // 100}"
    return f"₪{agorot // 100}.{agorot % 100:02d}"


# ── Eligibility: which products a group takes (the spec's §6) ──────────────────


@dataclass(frozen=True)
class Selection:
    """A group's catalog selection. Exclusions win over every inclusion (§6)."""

    all_items: bool = False
    product_ids: Tuple[str, ...] = ()
    category_ids: Tuple[str, ...] = ()
    include_subcategories: bool = True
    exclude_product_ids: Tuple[str, ...] = ()
    exclude_category_ids: Tuple[str, ...] = ()


@dataclass(frozen=True)
class Catalog:
    """products: (id, categoryId | None) in catalog order; categories: (id, parentId | None)."""

    products: Tuple[Tuple[str, Optional[str]], ...]
    categories: Tuple[Tuple[str, Optional[str]], ...] = ()


def _descendants(catalog: Catalog, roots: Iterable[str]) -> Set[str]:
    children: Dict[Optional[str], List[str]] = {}
    for cid, parent in catalog.categories:
        children.setdefault(parent, []).append(cid)
    out: Set[str] = set()
    stack = list(roots)
    while stack:
        c = stack.pop()
        if c in out:
            continue
        out.add(c)
        stack.extend(children.get(c, ()))
    return out


def eligible_products(selection: Selection, catalog: Catalog) -> List[str]:
    """
    The product ids a group takes, in catalog order, each once:

    1. everything (`allItems`), or the products of the chosen categories (with their sub-
       categories when `includeSubcategories`) together with the chosen products;
    2. minus the excluded products and every product of an excluded category — an excluded
       category always takes its sub-categories with it;
    3. a chosen product the catalog does not have is not taken.
    """
    if selection.all_items:
        base = {pid for pid, _ in catalog.products}
    else:
        cats = (
            _descendants(catalog, selection.category_ids) if selection.include_subcategories
            else set(selection.category_ids)
        )
        base = {pid for pid, cid in catalog.products if cid is not None and cid in cats}
        known = {pid for pid, _ in catalog.products}
        base |= {p for p in selection.product_ids if p in known}
    excluded_cats = _descendants(catalog, selection.exclude_category_ids)
    excluded = set(selection.exclude_product_ids) | {
        pid for pid, cid in catalog.products if cid is not None and cid in excluded_cats
    }
    return [pid for pid, _ in catalog.products if pid in base and pid not in excluded]


def eligible_now(mode: str, frozen_ids: Sequence[str], selection: Selection, catalog_now: Catalog) -> List[str]:
    """
    `frozen` (the default, §6): the list expanded when the batch was issued — a product added
    to a category later does not join, one moved out does not leave — still only products the
    catalog has now. `live`: the selection against the catalog of now.
    """
    if mode == "live":
        return eligible_products(selection, catalog_now)
    known = {pid for pid, _ in catalog_now.products}
    return [p for p in frozen_ids if p in known]


# ── Assignment: basket units to groups (§8, §11) ───────────────────────────────


@dataclass(frozen=True)
class GroupCap:
    key: str
    product_ids: Tuple[str, ...]
    remaining: int


@dataclass
class Assignment:
    assigned: Dict[str, str] = field(default_factory=dict)
    unassigned: List[Tuple[str, str]] = field(default_factory=list)
    ambiguous: List[Tuple[str, Tuple[str, ...]]] = field(default_factory=list)


def assign_units(groups: Sequence[GroupCap], units: Sequence[Tuple[str, str]], total_remaining: int) -> Assignment:
    """
    Each basket unit (ref, productId), in basket order, to a group — only when the match is
    single and clear (§11: "בכמה התאמות מציגים בחירה ולא משייכים בסתר"):

    * the voucher's total is used up → `total_full`;
    * no group takes the product → `not_eligible`; every group that takes it is full →
      `group_full`;
    * exactly one group takes it and has room → assigned (that room and the total shrink);
    * more than one → ambiguous, with the groups to choose from (nothing is taken for it).

    A unit fills one group only (§6, §19.26): a line of 3 is three units.
    """
    room = {g.key: int(g.remaining) for g in groups}
    total = int(total_remaining)
    out = Assignment()
    for ref, pid in units:
        if total <= 0:
            out.unassigned.append((ref, UNIT_TOTAL_FULL))
            continue
        takers = [g.key for g in groups if pid in g.product_ids]
        if not takers:
            out.unassigned.append((ref, UNIT_NOT_ELIGIBLE))
            continue
        open_ = [k for k in takers if room[k] > 0]
        if not open_:
            out.unassigned.append((ref, UNIT_GROUP_FULL))
        elif len(open_) == 1:
            out.assigned[ref] = open_[0]
            room[open_[0]] -= 1
            total -= 1
        else:
            out.ambiguous.append((ref, tuple(open_)))
    return out


# ── Selection: is a chosen redemption valid (§4, §8) ───────────────────────────


@dataclass(frozen=True)
class Group:
    key: str
    name: str
    min_qty: int
    max_qty: int
    remaining: int
    product_ids: Tuple[str, ...]
    allow_repeat: bool = True
    excluded_ids: Tuple[str, ...] = ()


@dataclass(frozen=True)
class Refusal:
    code: str
    text: str
    group_key: Optional[str] = None


def check_selection(
    groups: Sequence[Group],
    chosen: Sequence[Tuple[str, str, int]],
    *,
    total_max: int,
    total_remaining: int,
    whole_at_once: bool,
    type_name: Optional[str] = None,
) -> Optional[Refusal]:
    """
    The first thing wrong with redeeming [chosen] — (productId, groupKey, quantity) — or None:

    1. nothing chosen; 2. a product its group does not take (an excluded one says so);
    3. a group over what it has left ("ניתן לבחור פריט אחד בלבד בשובר זה" on a one-of-N voucher);
    4. a product twice in a group that does not allow it; 5. the voucher's total over;
    6. `wholeAtOnce` and a group short of its minimum — "חסר משקה להשלמת שובר הארוחה".
    """
    by_key = {g.key: g for g in groups}
    if not chosen or sum(int(q) for _, _, q in chosen) <= 0:
        return Refusal(NOTHING_CHOSEN, TEXT[NOTHING_CHOSEN])
    taken: Dict[str, int] = {}
    seen: Dict[str, Dict[str, int]] = {}
    for pid, key, q in chosen:
        g = by_key.get(key)
        if g is None or pid not in g.product_ids:
            if g is not None and pid in g.excluded_ids:
                return Refusal(EXCLUDED, TEXT[EXCLUDED], key)
            return Refusal(NOT_IN_GROUP, TEXT[NOT_IN_GROUP], key)
        taken[key] = taken.get(key, 0) + int(q)
        per = seen.setdefault(key, {})
        per[pid] = per.get(pid, 0) + int(q)
    for g in groups:
        if taken.get(g.key, 0) > g.remaining:
            if total_max == 1:
                text = TEXT["one_only"]
            elif g.remaining == 1:
                text = TEXT["group_one"].format(group=g.name)
            else:
                text = TEXT[GROUP_OVER].format(n=g.remaining, group=g.name)
            return Refusal(GROUP_OVER, text, g.key)
    for g in groups:
        if not g.allow_repeat and any(n > 1 for n in seen.get(g.key, {}).values()):
            return Refusal(REPEAT, TEXT[REPEAT].format(group=g.name), g.key)
    total = sum(taken.values())
    if total > total_remaining:
        text = TEXT["one_only"] if total_max == 1 else TEXT[TOTAL_OVER].format(n=total_remaining)
        return Refusal(TOTAL_OVER, text)
    if whole_at_once:
        for g in groups:
            need = min(g.min_qty, g.remaining)
            if taken.get(g.key, 0) < need:
                return Refusal(
                    PACKAGE_INCOMPLETE,
                    TEXT[PACKAGE_INCOMPLETE].format(group=g.name, type=type_name or TEXT["voucher"]),
                    g.key,
                )
    return None


# ── Value: a fixed value split between the units, to the agora (§5) ────────────


def _largest_remainder(total: int, weights: Sequence[int]) -> List[int]:
    """[total] split by [weights] (all ≥ 0, some > 0) in whole agorot, summing exactly: each gets
    the floor of its share, the agorot left go one each to the largest remainders (ties: first)."""
    w_sum = sum(weights)
    nums = [total * w for w in weights]
    out = [n // w_sum for n in nums]
    left = total - sum(out)
    order = sorted(range(len(weights)), key=lambda i: (-(nums[i] % w_sum), i))
    for i in order[:left]:
        out[i] += 1
    return out


def split_value(total: int, units: Sequence[Tuple[int, Optional[int]]]) -> Optional[List[int]]:
    """
    A fixed value (agorot) split between the redeemed units — (listPrice, fixedValue | None)
    each — so the units sum to it exactly (§5, §19.8):

    * a unit with a fixed component value keeps it; the rest of the value is shared by the
      others by their list prices; when all of those are ₪0, equally;
    * every unit fixed: the value is shared by the fixed values (equally when all are 0);
    * the fixed values above the whole value → None (`prepaid_voucher_value_mismatch`).
    """
    if not units:
        return []
    total = int(total)
    fixed_sum = sum(int(f) for _, f in units if f is not None)
    free = [i for i, (_, f) in enumerate(units) if f is None]
    if fixed_sum > total:
        return None
    out = [int(f) if f is not None else 0 for _, f in units]
    rest = total - fixed_sum
    if free:
        weights = [max(0, int(units[i][0])) for i in free]
        if sum(weights) == 0:
            weights = [1] * len(free)
        for i, v in zip(free, _largest_remainder(rest, weights)):
            out[i] = v
    elif rest:
        weights = [int(f) for _, f in units]
        if sum(weights) == 0:
            weights = [1] * len(units)
        for i, v in enumerate(_largest_remainder(rest, weights)):
            out[i] += v
    return out


def fixed_share(value_left: int, units_now: int, units_left: int) -> int:
    """A fixed-value voucher redeemed in parts: this redemption's part of what is left, rounded
    half up; the last redemption (all the units left) takes the rest exactly."""
    if units_left <= 0 or units_now >= units_left:
        return int(value_left)
    return (2 * int(value_left) * int(units_now) + int(units_left)) // (2 * int(units_left))


# ── Cover up to an amount, and the top-up (§5) ──────────────────────────────────


@dataclass(frozen=True)
class Cover:
    covered: int
    top_up: int
    per_unit: Tuple[int, ...]
    refusal: Optional[Refusal] = None
    note: Optional[str] = None


def cover(value_left: Optional[int], units_net: Sequence[int], allow_top_up: bool) -> Cover:
    """
    The voucher pays the units' net prices up to what is left of its value; the difference is
    the customer's top-up — refused when the type allows none (§5: "אם השלמת תשלום אינה מותרת,
    בחירה יקרה מהשווי נחסמת"). No value (a batch made before types): the goods whatever they
    cost. Less than the value: no change, nothing left for later. `per_unit`: the covered
    amount split by the units' prices (the receipt's "כלול בשובר").
    """
    nets = [max(0, int(n)) for n in units_net]
    total = sum(nets)
    covered = total if value_left is None else min(int(value_left), total)
    top_up = total - covered
    per = tuple(_largest_remainder(covered, nets) if total > 0 else [0] * len(nets))
    if top_up > 0 and not allow_top_up:
        return Cover(covered, top_up, per, Refusal(TOP_UP_NOT_ALLOWED, TEXT[TOP_UP_NOT_ALLOWED].format(amount=money_text(top_up))))
    return Cover(covered, top_up, per, None, TEXT["top_up"].format(amount=money_text(top_up)) if top_up else None)


# ── Products that take no discounts, and the override policy (§7) ──────────────

POLICY_HONOUR = "honour"
POLICY_AUTO = "auto"
POLICY_MANAGER = "manager"
POLICIES = (POLICY_HONOUR, POLICY_AUTO, POLICY_MANAGER)


@dataclass(frozen=True)
class OverridePolicy:
    mode: str = POLICY_HONOUR
    max_amount: Optional[int] = None    # agorot off one unit
    max_percent: Optional[int] = None   # basis points off one unit's list price
    max_total: Optional[int] = None     # agorot forced off in one voucher's redemption
    scope_product_ids: Optional[Tuple[str, ...]] = None    # None: every product of the voucher
    scope_category_ids: Optional[Tuple[str, ...]] = None


@dataclass(frozen=True)
class PricedUnit:
    ref: str
    product_id: str
    #: The unit's category and every one above it.
    category_ids: Tuple[str, ...]
    no_discount: bool
    list_price: int
    value: int


@dataclass(frozen=True)
class OverrideResult:
    #: Per unit: (ref, reduction agorot, forced).
    units: Tuple[Tuple[str, int, bool], ...]
    needs_approval: bool
    refusal: Optional[Refusal]


def _in_scope(policy: OverridePolicy, u: PricedUnit) -> bool:
    if policy.scope_product_ids is None and policy.scope_category_ids is None:
        return True
    if u.product_id in (policy.scope_product_ids or ()):
        return True
    return bool(set(u.category_ids) & set(policy.scope_category_ids or ()))


def override_check(policy: OverridePolicy, units: Sequence[PricedUnit], approved: bool) -> OverrideResult:
    """
    A unit whose price the redemption lowers (value below its list price) on a product that
    takes no discounts (§7):

    * `honour` (the default) — refused: "הפריט חסום להנחות וסוג השובר אינו מאפשר כפייה";
    * `auto` — forced, inside the policy's scope and caps (per unit ₪ / %, per voucher ₪);
    * `manager` — the same, and only with a manager's approval ("נדרש אישור מנהל…").

    A unit at or above its list price, or of a product that takes discounts, is not an override.
    The override never lifts anything else (exclusions, quantities, validity — §7). The first
    refusal in unit order wins; the approval is asked only when nothing else is wrong.
    """
    out: List[Tuple[str, int, bool]] = []
    refusal: Optional[Refusal] = None
    forced_total = 0
    any_forced = False
    for u in units:
        reduction = max(0, int(u.list_price) - int(u.value))
        if reduction == 0 or not u.no_discount:
            out.append((u.ref, reduction, False))
            continue
        if refusal is None:
            if policy.mode not in (POLICY_AUTO, POLICY_MANAGER):
                refusal = Refusal(DISCOUNT_BLOCKED, TEXT[DISCOUNT_BLOCKED])
            elif not _in_scope(policy, u):
                refusal = Refusal(DISCOUNT_BLOCKED, TEXT["out_of_scope"])
            elif policy.max_amount is not None and reduction > policy.max_amount:
                refusal = Refusal(OVERRIDE_CAP, TEXT[OVERRIDE_CAP])
            elif policy.max_percent is not None and reduction * BASIS > policy.max_percent * int(u.list_price):
                refusal = Refusal(OVERRIDE_CAP, TEXT[OVERRIDE_CAP])
            elif policy.max_total is not None and forced_total + reduction > policy.max_total:
                refusal = Refusal(OVERRIDE_CAP, TEXT[OVERRIDE_CAP])
        forced_total += reduction
        any_forced = True
        out.append((u.ref, reduction, True))
    needs = any_forced and policy.mode == POLICY_MANAGER and refusal is None
    if needs and not approved:
        refusal = Refusal(APPROVAL_NEEDED, TEXT[APPROVAL_NEEDED])
    return OverrideResult(tuple(out), needs, refusal)
