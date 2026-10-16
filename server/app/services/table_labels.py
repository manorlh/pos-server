"""
"מספר שולחן עם אותיות" — table labels like "3B" (P:/specs/table-scope.md §6, the owner's decisions of 16.10, §13.5–6).

The pure rules, one per language and pinned by one fixture (tests/fixtures/table_label_sort_golden.json — the
same bytes in pos-android app/src/test/resources; the dashboard's lib/tableLabels.ts reads the server's copy):
this module, pos-android domain/TableLabels.kt, client lib/tableLabels.ts.

**What the field takes** (`parse`): "12" is the number 12; anything with a letter is a label. A label is at most
`LABEL_MAX` (12) characters of Hebrew and English letters, digits, spaces and "-" (no "/" or "."), with at least
one letter; English letters are kept in upper case ("3b" → "3B"); runs of spaces become one.

**Unique by its normalised form** (`label_key`): no spaces, no "-", upper case — "3-B" and "3B" cannot both be
live in a shop, and typing "3b" finds "3B".

**The number of a labelled table** stays an integer (old tills and reports read it): its internal number, the
highest free one from `NUMBER_MAX` (99,999) down (`internal_number`) — never above it, every validator (the
till's layout save, its map editor) stops there.

**Natural order** (`sort_key`): runs of digits as numbers, runs of letters by the alphabet, digits before letters,
English before Hebrew, spaces, "-" and case ignored: 1, 2, 3, 3A, 3B, 10, 10A, A1, A2, A10, B1, תא 2.

**One title** (`table_title`): the label, else the number; with the name after it ("3B · VIP"); a table shown by
its name alone (`label_only`, "ש-12") is its name.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, List, Optional, Sequence, Tuple

LABEL_MAX = 12
NUMBER_MIN = 1
NUMBER_MAX = 99_999
#: "הוספת טווח": at most this many tables in one go (as the numbers' range).
RANGE_MAX = 500
#: The keypad's suggestions while typing (§6.3).
SUGGESTIONS_MAX = 8
#: Between the title and the table's name.
SEPARATOR = " · "

#: Hebrew's final letters, read as their plain ones in the order (ך is כ).
_FINALS = {"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"}
#: The alphabet a Hebrew range steps through (finals are not letters of their own there).
HEBREW_ALPHABET = "אבגדהוזחטיכלמנסעפצקרשת"
ENGLISH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

#: Why a text is refused (`LabelError.reason`, the 422 `table_label_invalid` body's `reason`).
EMPTY = "empty"
TOO_LONG = "too_long"
CHARACTERS = "characters"
NO_LETTER = "no_letter"
NUMBER_RANGE = "number_range"
RANGE_SHAPE = "range_shape"
RANGE_MIXED = "range_mixed"
RANGE_TOO_MANY = "range_too_many"


class LabelError(ValueError):
    """A table number or label the rules refuse; `reason` is one of the codes above."""

    def __init__(self, reason: str, text: Any = None):
        super().__init__(reason)
        self.reason = reason
        self.text = text


def _is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def _is_english(c: str) -> bool:
    return "A" <= c <= "Z" or "a" <= c <= "z"


def _is_hebrew(c: str) -> bool:
    return "\u05d0" <= c <= "\u05ea"


def _is_letter(c: str) -> bool:
    return _is_english(c) or _is_hebrew(c)


def _upper(text: str) -> str:
    """English letters in upper case; everything else as it is (Hebrew has no case)."""
    return "".join(c.upper() if "a" <= c <= "z" else c for c in text)


def _squeezed(text: str) -> str:
    return " ".join(str(text).split())


def label_key(label: Optional[str]) -> Optional[str]:
    """"3-b" → "3B": no spaces, no "-", English in upper case. None for nothing."""
    if label is None:
        return None
    key = "".join(c for c in _upper(str(label)) if c not in " -\t")
    return key or None


@dataclass(frozen=True)
class Parsed:
    """What the field holds: a plain number, or a label with its key (and no number of its own)."""

    number: Optional[int] = None
    label: Optional[str] = None
    key: Optional[str] = None

    @property
    def is_label(self) -> bool:
        return self.label is not None


def parse(value: Any) -> Parsed:
    """
    "12" / 12 → the number 12; "3b" → the label "3B" (key "3B"). LabelError otherwise: `empty`, `number_range`
    (a number outside 1–99,999), `characters` (anything but Hebrew / English letters, digits, space, "-"),
    `no_letter` ("3-4"), `too_long` (over 12).
    """
    if isinstance(value, bool):
        raise LabelError(CHARACTERS, value)
    if isinstance(value, int):
        if not NUMBER_MIN <= value <= NUMBER_MAX:
            raise LabelError(NUMBER_RANGE, value)
        return Parsed(number=value)
    if value is None:
        raise LabelError(EMPTY, value)
    text = _squeezed(value)
    if not text:
        raise LabelError(EMPTY, value)
    if all(_is_digit(c) for c in text):
        number = int(text)
        if not NUMBER_MIN <= number <= NUMBER_MAX:
            raise LabelError(NUMBER_RANGE, value)
        return Parsed(number=number)
    label = _upper(text)
    if any(not (_is_digit(c) or _is_letter(c) or c in " -") for c in label):
        raise LabelError(CHARACTERS, value)
    if not any(_is_letter(c) for c in label):
        raise LabelError(NO_LETTER, value)
    if len(label) > LABEL_MAX:
        raise LabelError(TOO_LONG, value)
    return Parsed(label=label, key=label_key(label))


def clean_label(value: Any) -> Optional[str]:
    """A label as stored ("3B"), None for nothing; LabelError when it is not a label (a number included)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    parsed = parse(value)
    if not parsed.is_label:
        raise LabelError(NO_LETTER, value)
    return parsed.label


# ── The natural order ─────────────────────────────────────────────────────────────────


def _tokens(text: str) -> Tuple[Tuple[Any, ...], ...]:
    key = "".join(_FINALS.get(c, c) for c in (label_key(text) or ""))
    out: List[Tuple[Any, ...]] = []
    i = 0
    while i < len(key):
        j = i
        if _is_digit(key[i]):
            while j < len(key) and _is_digit(key[j]):
                j += 1
            run = key[i:j]
            out.append((0, int(run), len(run)))
        else:
            while j < len(key) and not _is_digit(key[j]):
                j += 1
            out.append((1, key[i:j]))
        i = j
    return tuple(out)


def sort_key(text: Any) -> Tuple[Any, ...]:
    """The natural order of a number or a label ("3" < "3A" < "10" < "A1" < "A10" < "B1" < "תא 2")."""
    raw = str(text if text is not None else "")
    return (_tokens(raw), label_key(raw) or "")


def shown_of(number: Optional[int], label: Optional[str]) -> str:
    """What a table is called by: its label, else its number ("" for neither)."""
    text = (label or "").strip()
    if text:
        return text
    return "" if number is None else str(number)


def table_sort_key(number: Optional[int], label: Optional[str] = None) -> Tuple[Any, ...]:
    """A table's place in the natural order: by what it is called, then (two "3B"s of the past) its number."""
    return (sort_key(shown_of(number, label)), number if number is not None else 0)


def natural_sorted(items: Iterable[Any], number=lambda x: x.number, label=lambda x: getattr(x, "label", None)) -> list:
    """[items] (tables, orders, rows…) in the natural order of their labels and numbers."""
    return sorted(items, key=lambda x: table_sort_key(number(x), label(x)))


# ── Titles ───────────────────────────────────────────────────────────────────────────


def table_title(number: Optional[int], label: Optional[str] = None, name: Optional[str] = None,
                label_only: bool = False) -> str:
    """"12", "3B", "3B · VIP"; a table shown by its name alone ("ש-12") is its name."""
    nm = (name or "").strip()
    if label_only and nm:
        return nm
    shown = shown_of(number, label)
    if not nm:
        return shown
    return f"{shown}{SEPARATOR}{nm}" if shown else nm


def with_term(term: Optional[str], title: str, label_only: bool = False) -> str:
    """"תא 3B" — the word before the number (`tableTerm`); a table shown by its name alone takes none."""
    word = (term or "").strip()
    if not word or label_only or not title:
        return title
    return f"{word} {title}"


# ── The internal number of a labelled table ──────────────────────────────────────────


def internal_number(taken: Iterable[int], *, top: int = NUMBER_MAX) -> int:
    """The highest number from `top` down that no live table of the shop holds."""
    held = set(taken)
    n = top
    while n >= NUMBER_MIN:
        if n not in held:
            return n
        n -= 1
    raise LabelError(NUMBER_RANGE, None)


# ── "הוספת טווח" ─────────────────────────────────────────────────────────────────────


def _last_run(label: str) -> Tuple[str, str, str]:
    """"3A" → ("3", "letters", "A"); "A10" → ("A", "digits", "10")."""
    end = len(label)
    digits = _is_digit(label[-1])
    i = end
    while i > 0 and (_is_digit(label[i - 1]) if digits else _is_letter(label[i - 1])):
        i -= 1
    return label[:i], ("digits" if digits else "letters"), label[i:]


def expand_range(start: Any, end: Any, *, limit: int = RANGE_MAX) -> List[Parsed]:
    """
    "3A" … "3L" → 3A, 3B, … 3L; "A1" … "A10" → A1 … A10; 1 … 20 → the numbers. The same beginning, a letter
    or a number at the end. LabelError: `range_mixed` (a number and a label), `range_shape` (another beginning,
    a letter and a number at the end, more than one letter, letters of two alphabets), `range_too_many`.
    """
    a, b = parse(start), parse(end)
    if not a.is_label and not b.is_label:
        low, high = sorted((a.number, b.number))
        if high - low >= limit:
            raise LabelError(RANGE_TOO_MANY, (start, end))
        return [Parsed(number=n) for n in range(low, high + 1)]
    if a.is_label != b.is_label:
        raise LabelError(RANGE_MIXED, (start, end))
    head_a, kind_a, run_a = _last_run(a.label)
    head_b, kind_b, run_b = _last_run(b.label)
    if head_a != head_b or kind_a != kind_b:
        raise LabelError(RANGE_SHAPE, (start, end))
    out: List[Parsed] = []
    if kind_a == "digits":
        low, high = sorted((int(run_a), int(run_b)))
        if high - low >= limit:
            raise LabelError(RANGE_TOO_MANY, (start, end))
        width = len(run_a) if len(run_a) == len(run_b) and run_a.startswith("0") else 0
        for n in range(low, high + 1):
            out.append(parse(head_a + (str(n).zfill(width) if width else str(n))))
        return out
    if len(run_a) != 1 or len(run_b) != 1:
        raise LabelError(RANGE_SHAPE, (start, end))
    alphabet = ENGLISH_ALPHABET if _is_english(run_a) else HEBREW_ALPHABET
    ca, cb = _FINALS.get(run_a, run_a), _FINALS.get(run_b, run_b)
    if ca not in alphabet or cb not in alphabet:
        raise LabelError(RANGE_SHAPE, (start, end))
    i, j = sorted((alphabet.index(ca), alphabet.index(cb)))
    if j - i >= limit:
        raise LabelError(RANGE_TOO_MANY, (start, end))
    for k in range(i, j + 1):
        out.append(parse(head_a + alphabet[k]))
    return out


# ── The keypad (§6.3) ────────────────────────────────────────────────────────────────


def typed_key(text: Any) -> str:
    """What the keypad holds, as it is matched: "3 b" → "3B"; digits alone without leading zeros ("012" → "12")."""
    key = label_key(_squeezed(text if text is not None else "")) or ""
    if key and all(_is_digit(c) for c in key):
        key = key.lstrip("0")
    return key


def matches(typed: Any, number: Optional[int], label: Optional[str]) -> bool:
    """The table begins with what was typed ("3" finds 3, 3A, 30…; "3b" finds 3B)."""
    key = typed_key(typed)
    if not key:
        return False
    own = label_key(label) if label else (str(number) if number is not None else "")
    return bool(own) and own.startswith(key)


def exact(typed: Any, number: Optional[int], label: Optional[str]) -> bool:
    """The table is what was typed: its label's key, or (no label) its number."""
    key = typed_key(typed)
    if not key:
        return False
    if label:
        return label_key(label) == key
    return number is not None and str(number) == key


def suggestions(typed: Any, tables: Sequence[Any], *, limit: int = SUGGESTIONS_MAX,
                number=lambda t: t.number, label=lambda t: getattr(t, "label", None)) -> list:
    """The keypad's suggestions: the tables that begin with what was typed, in the natural order, at most 8."""
    found = [t for t in tables if matches(typed, number(t), label(t))]
    return natural_sorted(found, number=number, label=label)[:limit]


def letters_in(labels: Iterable[Optional[str]]) -> List[str]:
    """The keypad's row of letters: those the labels use, English first, then Hebrew, each once."""
    seen = {c for lab in labels if lab for c in _upper(lab) if _is_letter(c)}
    return sorted(seen, key=lambda c: (0 if _is_english(c) else 1, _FINALS.get(c, c), c))
