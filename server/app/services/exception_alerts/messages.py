"""
The SMS texts of the exception alerts — pure functions, no database.

One alert:  "חריגה: החזר ₪250 · מרכז · קופה 2 · דנה · 14:32 <link>"
"N in M":   "חריגה: 3× ביטול שורה ב-10 דק׳ · מרכז · קופה 2 · דנה · 14:32 <link>"
A digest:   "סיכום חריגות (החזרים): עוד 5 מ-14:02 עד 14:10 — החזר ×3, הנחה ×2 · מרכז <link>"
A test:     "בדיקה: התראות SMS על חריגות (החזרים) פעילות. <link>"

Kept to 160 characters where possible: the optional parts (the employee, then the till,
then the shop) are shortened and dropped before anything essential (what, the amount, the
time, the link). Hebrew is UCS-2 on the network (70 per segment), so 160 is ~3 segments.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, List, Optional, Sequence, Tuple

TARGET = 160
#: The notification template caps its one variable here (templates._VALUE_CAPS).
HARD_CAP = 200
SEP = " · "


def money(amount: Optional[Decimal]) -> Optional[str]:
    """₪250 / ₪12.50 — the absolute value; the sign is told by words where it matters."""
    if amount is None:
        return None
    value = abs(Decimal(str(amount))).quantize(Decimal("0.01"))
    if value == value.to_integral():
        return f"₪{int(value):,}"
    return f"₪{value:,.2f}"


def percent(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    v = Decimal(str(value)).quantize(Decimal("0.1"))
    text = f"{v.normalize():f}" if v == v.to_integral() else f"{v:f}"
    return f"{text}%"


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if not text:
        return None
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: max(1, limit - 1)].rstrip() + "…"


@dataclass
class AlertParts:
    what: str                     # "החזר ₪250", "הנחה 30% (₪45)", "3× ביטול שורה ב-10 דק׳"
    time: str                     # "14:32"
    link: Optional[str] = None
    shop: Optional[str] = None
    till: Optional[str] = None    # "קופה 2"
    who: Optional[str] = None


def what_of(kind_label: str, kind: str, amount: Optional[Decimal], value: Optional[Decimal],
            percent_kind: bool) -> str:
    """The "what" of one alert: the label, the amount, the percent where it is one."""
    parts = [kind_label]
    if kind == "cash_difference" and amount is not None:
        word = "חוסר" if Decimal(str(amount)) < 0 else "עודף"
        parts = [f"{kind_label} ({word})"]
    if percent_kind and value is not None:
        parts.append(percent(value))
        if amount is not None:
            parts.append(f"({money(amount)})")
    elif amount is not None and Decimal(str(amount)) != 0:
        parts.append(money(amount))
    return " ".join(p for p in parts if p)


def what_of_count(kind_label: str, count: int, window_minutes: int) -> str:
    return f"{count}× {kind_label} ב-{window_minutes} דק׳"


def _join(prefix: str, parts: Sequence[Optional[str]], link: Optional[str]) -> str:
    body = SEP.join(p for p in parts if p)
    text = f"{prefix}{body}"
    return f"{text} {link}" if link else text


def alert_text(p: AlertParts, *, prefix: str = "חריגה: ") -> str:
    """The alert, shortened to TARGET where it can be (never below what · time · link)."""
    what = _clip(p.what, 70)
    shop, till, who = _clip(p.shop, 24), _clip(p.till, 14), _clip(p.who, 18)
    attempts: List[Tuple[Optional[str], ...]] = [
        (what, shop, till, who, p.time),
        (what, _clip(shop, 14), till, _clip(who, 10), p.time),
        (what, _clip(shop, 14), till, p.time),
        (what, _clip(shop, 14), p.time),
        (what, p.time),
    ]
    text = ""
    for parts in attempts:
        text = _join(prefix, parts, p.link)
        if len(text) <= TARGET:
            return text
    return text[:HARD_CAP]


def digest_text(*, rule_name: Optional[str], count: int, since: str, until: str,
                kinds: Iterable[Tuple[str, int]], shop: Optional[str], link: Optional[str],
                quiet: bool = False) -> str:
    """One message summing up what the rate limit / the quiet hours held back."""
    name = _clip(rule_name, 24)
    head = f"סיכום חריגות ({name})" if name else "סיכום חריגות"
    held = "בשעות השקט" if quiet else "נוספות"
    span = since if since == until else f"{since}–{until}"
    top = sorted(kinds, key=lambda k: -k[1])
    for n_kinds in (3, 2, 1, 0):
        listed = ", ".join(f"{label} ×{n}" for label, n in top[:n_kinds])
        rest = len(top) - n_kinds
        if listed and rest > 0:
            listed += " ועוד"
        main = f"{head}: {count} {held} {span}"
        if listed:
            main += f" — {listed}"
        for where in (_clip(shop, 24), _clip(shop, 12), None):
            text = _join("", [main, where], link)
            if len(text) <= TARGET:
                return text
    return _join("", [f"{head}: {count} {held} {span}"], link)[:HARD_CAP]


def test_text(*, rule_name: Optional[str], link: Optional[str], dry_run: bool) -> str:
    name = _clip(rule_name, 30)
    text = f"בדיקה: התראות SMS על חריגות{f' ({name})' if name else ''} פעילות."
    if dry_run:
        text += " (הדמיה)"
    return f"{text} {link}" if link else text
