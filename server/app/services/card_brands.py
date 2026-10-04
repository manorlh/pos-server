"""
Card brand (מותג), acquirer (חברת סליקה / סולק) and issuer (מנפיק) of a card leg.

Pure — no database, no app imports — so the migration that backfills old legs, the
ingest path, the reports and the tests all read a reply the same way.

What the terminal actually sends (Agamento 01.06.94, Shva `ashrait`, seen in the stored
replies of real sales)::

    "mutag": 1, "mutagName": "Mastercard",      # brand code and its name
    "manpik": 1,                                # issuer code
    "solek": 6,                                 # acquirer code
    "cardName": "DEBIT MASTERCARD",
    "cardNumber": "542386***7407",              # BIN (first 6) + last 4
    "cardNumberOriginalLength": "542386******7407"

The till keeps that object in the leg's `nayax_meta` under `result` — as an object, or,
because the till flattens its meta to a string map before sending, as a JSON *string*.
Both are read.

Order of trust, per field:

1. what the till derived and sent (`cardBrand` / `cardAcquirer` / `cardIssuer`), when it
   is one of our codes;
2. the reply's explicit codes — `mutag` (then `mutagName`, `cardName`) for the brand,
   `solek` for the acquirer, `manpik` for the issuer;
3. for the brand only: the BIN of the masked number, by the public IIN ranges. Israeli
   local Isracard cards (8–9 digit numbers, no international BIN) are recognised by the
   number's length. The acquirer and issuer are never guessed from a BIN — which Israeli
   company clears or issued a Visa is not in its first digits.

Shva code tables (the ashrait protocol's own; the acquirer/issuer tables are the same
numbering). Codes not listed map to "other" and are kept visible rather than guessed:

    mutag   0 PL (private label)  1 Mastercard  2 Visa  3 Maestro  4 Amex  5 Isracard
            6 JCB  7 Discover  8 Diners
    solek / manpik
            1 Isracard  2 Cal (Visa Cal)  3 Diners  4 Amex  6 Max (Leumi Card)
            manpik 0 = a foreign-issued card

A private-label card (mutag 0) issued by Isracard is booked as Isracard.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional, Tuple

BRANDS = ("visa", "mastercard", "amex", "diners", "isracard", "jcb", "discover", "maestro", "other")
ACQUIRERS = ("isracard", "cal", "max", "diners", "amex", "other")
ISSUERS = ("isracard", "cal", "max", "diners", "amex", "foreign", "other")

BRAND_LABELS = {
    "visa": "ויזה",
    "mastercard": "מאסטרקארד",
    "amex": "אמריקן אקספרס",
    "diners": "דיינרס",
    "isracard": "ישראכרט",
    "jcb": "JCB",
    "discover": "דיסקבר",
    "maestro": "מאסטרו",
    "other": "אחר",
}
ACQUIRER_LABELS = {
    "isracard": "ישראכרט",
    "cal": "כאל",
    "max": "מקס",
    "diners": "דיינרס",
    "amex": "אמקס",
    "foreign": "חו\"ל",
    "other": "אחר",
}
#: A leg whose acquirer is not known (an old reply, a BIN-only brand).
UNKNOWN = "unknown"
UNKNOWN_LABEL = "לא ידוע"

_MUTAG = {1: "mastercard", 2: "visa", 3: "maestro", 4: "amex", 5: "isracard", 6: "jcb", 7: "discover", 8: "diners"}
_COMPANY = {1: "isracard", 2: "cal", 3: "diners", 4: "amex", 6: "max"}

#: Brand names as replies spell them (mutagName, cardName), lower-case, longest first.
_NAMES = (
    ("american express", "amex"),
    ("mastercard", "mastercard"),
    ("master card", "mastercard"),
    ("isracard", "isracard"),
    ("ישראכרט", "isracard"),
    ("discover", "discover"),
    ("maestro", "maestro"),
    ("diners", "diners"),
    ("דיינרס", "diners"),
    ("amex", "amex"),
    ("visa", "visa"),
    ("ויזה", "visa"),
    ("jcb", "jcb"),
    ("מאסטרקארד", "mastercard"),
)
_ACQUIRER_NAMES = (
    ("isracard", "isracard"),
    ("ישראכרט", "isracard"),
    ("leumi", "max"),
    ("max", "max"),
    ("מקס", "max"),
    ("cal", "cal"),
    ("כאל", "cal"),
    ("diners", "diners"),
    ("amex", "amex"),
    ("american express", "amex"),
)


def brand_label(code: Optional[str]) -> str:
    return BRAND_LABELS.get(code or "", UNKNOWN_LABEL if not code or code == UNKNOWN else code)


def acquirer_label(code: Optional[str]) -> str:
    return ACQUIRER_LABELS.get(code or "", UNKNOWN_LABEL if not code or code == UNKNOWN else code)


# ── Reading the reply ─────────────────────────────────────────────────────────


def _text(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    return text


def _int(value: Any) -> Optional[int]:
    text = _text(value)
    if text is None:
        return None
    try:
        return int(float(text))
    except (TypeError, ValueError, OverflowError):
        return None


def result_of(meta: Any) -> Dict[str, Any]:
    """The reply's `result` object — stored as an object or as a JSON string."""
    if not isinstance(meta, dict):
        return {}
    result = meta.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, RecursionError):
            return {}
    if isinstance(result, dict):
        return result
    # A desktop reply may carry the fields at the top.
    return {}


def _by_name(text: Optional[str], table) -> Optional[str]:
    if not text:
        return None
    low = text.lower()
    for needle, code in table:
        if needle in low:
            return code
    return None


def _digits_prefix(masked: Optional[str]) -> str:
    out = ""
    for ch in masked or "":
        if ch.isdigit():
            out += ch
        else:
            break
    return out


def brand_from_pan(masked: Optional[str], full_length: Optional[int] = None) -> Optional[str]:
    """
    The brand of a (masked) card number by its leading digits, or None if it shows none.

    `full_length` is the real number's length when known (Agamento's
    `cardNumberOriginalLength` keeps one mask character per hidden digit). An 8–9 digit
    number is an Israeli local Isracard card.
    """
    if full_length is not None and 8 <= full_length <= 9:
        return "isracard"
    p = _digits_prefix(masked)
    if not p:
        return None

    def n(k: int) -> Optional[int]:
        return int(p[:k]) if len(p) >= k else None

    if p.startswith("4"):
        return "visa"
    if p.startswith(("34", "37")):
        return "amex"
    if n(4) is not None and 3528 <= n(4) <= 3589:
        return "jcb"
    if p.startswith(("36", "38", "39")) or (n(3) is not None and (300 <= n(3) <= 305 or n(3) == 309)):
        return "diners"
    if n(2) is not None and 51 <= n(2) <= 55:
        return "mastercard"
    if n(4) is not None and 2221 <= n(4) <= 2720:
        return "mastercard"
    if p.startswith(("6011", "65")) or (n(3) is not None and 644 <= n(3) <= 649):
        return "discover"
    if p.startswith(("50", "56", "57", "58", "6304", "6759", "676")) or (n(2) == 67):
        return "maestro"
    return "other" if len(p) >= 4 else None


def _full_length(meta: Dict[str, Any], result: Dict[str, Any]) -> Optional[int]:
    text = _text(result.get("cardNumberOriginalLength")) or _text(meta.get("cardNumberOriginalLength"))
    if text and any(ch in text for ch in "*Xx•") and len(text) <= 19:
        return len(text)
    return None


def _masked(meta: Dict[str, Any], result: Dict[str, Any]) -> Optional[str]:
    for value in (
        result.get("cardNumberOriginalLength"),
        result.get("cardNumber"),
        meta.get("maskedCard"),
        meta.get("cardNumber"),
        meta.get("cardBin"),
        meta.get("bin"),
    ):
        text = _text(value)
        if text and _digits_prefix(text):
            return text
    return None


def _valid(value: Any, allowed) -> Optional[str]:
    text = _text(value)
    if text is None:
        return None
    low = text.lower()
    return low if low in allowed else None


def derive(meta: Any) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """(brand, acquirer, issuer) of a card leg's reply; each None when it cannot be told."""
    if not isinstance(meta, dict):
        return None, None, None
    result = result_of(meta)
    sources = (result, meta)

    def first(key: str) -> Any:
        for s in sources:
            if _text(s.get(key)) is not None:
                return s.get(key)
        return None

    issuer_code = _int(first("manpik"))
    acquirer_code = _int(first("solek"))

    # Brand
    brand = _valid(meta.get("cardBrand"), BRANDS)
    if brand is None:
        mutag = _int(first("mutag"))
        if mutag in _MUTAG:
            brand = _MUTAG[mutag]
        elif mutag == 0:
            # Private label: Isracard's own local card when Isracard issued it.
            brand = "isracard" if issuer_code == 1 else None
        if brand is None:
            brand = _by_name(_text(first("mutagName")), _NAMES) or _by_name(_text(first("cardName")), _NAMES)
        if brand is None:
            brand = brand_from_pan(_masked(meta, result), _full_length(meta, result))
        if brand is None and mutag == 0:
            brand = "other"

    # Acquirer
    acquirer = _valid(meta.get("cardAcquirer"), ACQUIRERS)
    if acquirer is None:
        if acquirer_code in _COMPANY:
            acquirer = _COMPANY[acquirer_code]
        elif acquirer_code is not None:
            acquirer = "other"
        else:
            acquirer = _by_name(_text(first("acquirerName")) or _text(first("solekName")), _ACQUIRER_NAMES)

    # Issuer
    issuer = _valid(meta.get("cardIssuer"), ISSUERS)
    if issuer is None:
        if issuer_code in _COMPANY:
            issuer = _COMPANY[issuer_code]
        elif issuer_code == 0:
            issuer = "foreign"
        elif issuer_code is not None:
            issuer = "other"
    return brand, acquirer, issuer


def resolve(
    meta: Any,
    *,
    brand: Optional[str] = None,
    acquirer: Optional[str] = None,
    issuer: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """What the till sent explicitly (when valid), else what the reply says."""
    b, a, i = derive(meta)
    return (
        _valid(brand, BRANDS) or b,
        _valid(acquirer, ACQUIRERS) or a,
        _valid(issuer, ISSUERS) or i,
    )


# ── Breakdown rows (Z sections, reports) ──────────────────────────────────────


def merge_breakdowns(lists) -> list:
    """
    Sum `cardBrands` rows (as a Z section stores them) over several sections, by
    (brand, acquirer). Money stays decimal strings; largest net first.
    """
    from decimal import Decimal, InvalidOperation

    def dec(v) -> Decimal:
        try:
            return Decimal(str(v)) if v is not None else Decimal("0")
        except (InvalidOperation, ValueError):
            return Decimal("0")

    acc: Dict[Tuple[str, str], list] = {}
    for rows in lists:
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            key = (str(r.get("brand") or "other"), str(r.get("acquirer") or UNKNOWN))
            b = acc.setdefault(key, [0, Decimal("0"), 0, Decimal("0")])
            b[0] += int(r.get("salesCount") or 0)
            b[1] += dec(r.get("salesAmount"))
            b[2] += int(r.get("refundsCount") or 0)
            b[3] += dec(r.get("refundsAmount"))
    cent = Decimal("0.01")
    out = [
        {
            "brand": k[0],
            "acquirer": k[1],
            "salesCount": v[0],
            "salesAmount": str(v[1].quantize(cent)),
            "refundsCount": v[2],
            "refundsAmount": str(v[3].quantize(cent)),
            "net": str((v[1] - v[3]).quantize(cent)),
        }
        for k, v in acc.items()
    ]
    out.sort(key=lambda r: (-Decimal(r["net"]), r["brand"], r["acquirer"]))
    return out


def totals_by(rows, key: str) -> list:
    """Collapse breakdown rows to one dimension: `key` is "brand" or "acquirer"."""
    other = "acquirer" if key == "brand" else "brand"
    # Blank the other dimension so the merge sums over it, then drop it.
    merged = merge_breakdowns([[{**r, other: "*"} for r in rows or [] if isinstance(r, dict)]])
    return [{k: v for k, v in r.items() if k != other} for r in merged]
