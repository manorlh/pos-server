"""
"סימוני תזונה" (docs/SPEC_PRODUCT_DIETARY.md): what a dish *is* for the diner — vegan,
vegetarian, dairy, meat, gluten free, spicy — beside its allergens (what it *contains*,
app/models/menu.py). A list of codes on the global product (`products.dietary_tags`),
sent to the till and the kiosk as `dietaryTags`.

The rules, applied here for every way in (the product form, the till, the Excel import):

* only the six codes below; a code in any case or with spaces around is read as itself;
* order does not count, and a code given twice is one: stored in the fixed order below;
* `vegan` is also `vegetarian` — added when missing;
* `meat` and `dairy` never go together (kashrut: בשרי / חלבי);
* `vegan` goes with neither `meat` nor `dairy`, and `vegetarian` not with `meat`.

The dashboard clears the conflicting chip as one is picked (with a note), so a form never
sends a conflict; a request that does is refused rather than silently "fixed", because
there is no telling which of the two the merchant meant.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

VEGAN = "vegan"
VEGETARIAN = "vegetarian"
DAIRY = "dairy"
MEAT = "meat"
GLUTEN_FREE = "gluten_free"
SPICY = "spicy"

#: Every code, in the order they are stored, sent and shown.
DIETARY_TAGS: Tuple[str, ...] = (VEGAN, VEGETARIAN, DAIRY, MEAT, GLUTEN_FREE, SPICY)

#: The codes in Hebrew — the one server-side map (receipts, PDFs, the Excel sheet, the
#: menu-broadcast review). The dashboard (he.json `productDietary.tags`) and the till
#: (`strings_dietary.xml`) carry the same words.
DIETARY_LABELS_HE: Dict[str, str] = {
    VEGAN: "טבעוני",
    VEGETARIAN: "צמחוני",
    DAIRY: "חלבי",
    MEAT: "בשרי",
    GLUTEN_FREE: "ללא גלוטן",
    SPICY: "חריף",
}

#: Pairs that cannot both be on one product.
CONFLICTS: Tuple[Tuple[str, str], ...] = (
    (MEAT, DAIRY),
    (VEGAN, MEAT),
    (VEGAN, DAIRY),
    (VEGETARIAN, MEAT),
)

#: Other ways a sheet may spell a tag (normalized like `_word`): Hebrew forms and English.
_ALIASES: Dict[str, str] = {
    "טבעונית": VEGAN,
    "vegan": VEGAN,
    "צמחונית": VEGETARIAN,
    "vegetarian": VEGETARIAN,
    "veggie": VEGETARIAN,
    "חלבית": DAIRY,
    "dairy": DAIRY,
    "בשרית": MEAT,
    "meat": MEAT,
    "ללא גלוטן": GLUTEN_FREE,
    "נטול גלוטן": GLUTEN_FREE,
    "נטולת גלוטן": GLUTEN_FREE,
    "בלי גלוטן": GLUTEN_FREE,
    "gluten free": GLUTEN_FREE,
    "gluten-free": GLUTEN_FREE,
    "gluten_free": GLUTEN_FREE,
    "gf": GLUTEN_FREE,
    "חריפה": SPICY,
    "spicy": SPICY,
    "hot": SPICY,
}


class DietaryTagError(ValueError):
    """A tag list that cannot be stored: an unknown code, or two that contradict."""


def _word(value: Any) -> str:
    return " ".join(str(value).replace("־", "-").split()).strip().lower()


def label(code: str) -> str:
    """The tag in Hebrew; an unknown code as it is."""
    return DIETARY_LABELS_HE.get(code, code)


def labels(codes: Optional[Iterable[str]]) -> List[str]:
    """The known codes in Hebrew, in the fixed order."""
    return [DIETARY_LABELS_HE[c] for c in tags_out(codes)]


def conflict_of(codes: Iterable[str]) -> Optional[Tuple[str, str]]:
    """The first pair of `codes` that cannot go together, or None."""
    have = set(codes)
    for a, b in CONFLICTS:
        if a in have and b in have:
            return a, b
    return None


def clean(value: Any) -> List[str]:
    """
    The tags to store: known codes only (else DietaryTagError), each once, in the fixed
    order, `vegetarian` added to `vegan`, and no contradicting pair (else DietaryTagError).
    None or empty is [].
    """
    if value is None:
        return []
    if isinstance(value, str):
        # "vegan,dairy" is not a list a client should send, but it is unambiguous.
        value = [p for p in value.split(",") if p.strip()]
    if not isinstance(value, (list, tuple, set, frozenset)):
        raise DietaryTagError("dietaryTags must be a list of codes")
    wanted = set()
    for item in value:
        if not isinstance(item, str):
            raise DietaryTagError("dietaryTags must be a list of codes")
        code = _word(item)
        if not code:
            continue
        if code not in DIETARY_TAGS:
            raise DietaryTagError(
                f"unknown dietary tag: {item.strip()} (allowed: {', '.join(DIETARY_TAGS)})"
            )
        wanted.add(code)
    if VEGAN in wanted:
        wanted.add(VEGETARIAN)
    pair = conflict_of(wanted)
    if pair is not None:
        raise DietaryTagError(f"dietary tags {pair[0]} and {pair[1]} cannot go together")
    return [c for c in DIETARY_TAGS if c in wanted]


def to_column(value: Any) -> Optional[List[str]]:
    """What `products.dietary_tags` holds for `value`: the clean list, or None for none."""
    return clean(value) or None


def tags_out(stored: Any) -> List[str]:
    """
    The tags as the API and the till get them: the known codes of the stored value, in the
    fixed order. Never raises — a row written before a rule existed still reads.
    """
    if not stored or not isinstance(stored, (list, tuple)):
        return []
    have = {_word(c) for c in stored if isinstance(c, str)}
    return [c for c in DIETARY_TAGS if c in have]


def code_of(word: Any) -> Optional[str]:
    """A code from a code, its Hebrew label or a known alias; None if it is none of them."""
    w = _word(word)
    if not w:
        return None
    if w in DIETARY_TAGS:
        return w
    for code, he in DIETARY_LABELS_HE.items():
        if w == _word(he):
            return code
    return _ALIASES.get(w)
