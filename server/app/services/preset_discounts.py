"""
"הנחות קבועות" — preset basket discounts (P:/specs/preset-discounts.md).

A business gives the same discounts on the whole sale again and again ("הנחת עובדים" 40%,
"הנחת מנוי" 10%): a list of them, one tap each on the till.

**The settings** are two keys in the settings JSON every layer already has (company → shop →
area → till), in `MANAGED_SETTING_KEYS`, so they reach the tills with the ordinary settings
sync and are kept there (offline too):

* `presetDiscounts` — the list (at most `PRESETS_MAX`), the deepest layer that sets it winning
  as a whole (as `tipPresets`); `null` resets a layer to inherit, `[]` is "none here". Each
  item: `id`, `name` (the button's text, printed on the receipt, named in the reports), `kind`
  (`percent` / `amount`), `value`, `active`, `color`, `requiresManager`, `button`, `forWhom`,
  `forWhomSource` — spec §2.
* `presetDiscountButtons` — which presets show as one-tap buttons on the sell screen at this
  layer (ids); unset everywhere = every active preset whose `button` is on.

**The rule** a till applies (`apply_preset`, spec §4) is pinned by the shared golden
`preset_discounts_golden.json` (server tests, kiosk-desktop tests, pos-android test resources);
the till's resolution of the two keys (`resolve_for_till`) too. The cloud itself never prices a
sale: the rule is here as the reference the golden is generated from.

**On the document**: `basketDiscountKind` "preset" and the preset's id, name and "for whom"
(`presetDiscountId` / `presetDiscountName` / `presetDiscountFor` / `presetDiscountForKind` /
`presetDiscountForRef`) — `clean_document_fields`.
"""
from __future__ import annotations

import re
import uuid
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

PRESETS_KEY = "presetDiscounts"
BUTTONS_KEY = "presetDiscountButtons"
SETTING_KEYS = (PRESETS_KEY, BUTTONS_KEY)

#: `basketDiscountKind` of a sale whose basket discount is a preset's.
KIND_PRESET = "preset"

PRESETS_MAX = 20
ID_MAX = 64
NAME_MAX = 24
KINDS = ("percent", "amount")
PERCENT_MAX = Decimal("100")
AMOUNT_MAX = Decimal("100000")
FOR_WHOM = ("none", "optional", "required")
FOR_WHOM_SOURCES = ("free", "employees", "club")
#: `presetDiscountForKind` on the document: picked from the employees, the sale's customer, or typed.
FOR_KINDS = ("employee", "customer", "typed")

#: The document's columns (app/models/transaction.py).
DOC_NAME_MAX = 60
DOC_FOR_MAX = 200
DOC_FOR_REF_MAX = 100

_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_CENT = Decimal("0.01")


# ── values ────────────────────────────────────────────────────────────────────


def _decimal(value: Any) -> Optional[Decimal]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        d = value
    elif isinstance(value, (int, float)):
        d = Decimal(str(value))
    elif isinstance(value, str):
        try:
            d = Decimal(value.strip())
        except (InvalidOperation, ValueError):
            return None
    else:
        return None
    return d if d.is_finite() else None


def _value_of(kind: str, raw: Any) -> Optional[Decimal]:
    """The preset's value to the agora / the hundredth of a percent, or None when out of range."""
    d = _decimal(raw)
    if d is None:
        return None
    d = d.quantize(_CENT, rounding=ROUND_HALF_UP)
    top = PERCENT_MAX if kind == "percent" else AMOUNT_MAX
    return d if Decimal("0") < d <= top else None


def _number(d: Decimal) -> Any:
    """12.5 / 40 — an int when whole, else a float (JSON reads the same on every side)."""
    return int(d) if d == d.to_integral_value() else float(d)


def _name(raw: Any) -> str:
    return " ".join(raw.split())[:NAME_MAX].rstrip() if isinstance(raw, str) else ""


def _flag(raw: Any, default: bool) -> bool:
    return raw if isinstance(raw, bool) else default


def _choice(raw: Any, choices: Tuple[str, ...]) -> str:
    return raw if isinstance(raw, str) and raw in choices else choices[0]


def _color(raw: Any) -> Optional[str]:
    return raw.upper() if isinstance(raw, str) and _COLOR.match(raw) else None


# ── the till's reading (lenient: never refuse, drop what is not a preset) ──────


def _till_preset(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    pid = raw.get("id")
    if not isinstance(pid, str) or not pid.strip() or len(pid.strip()) > ID_MAX:
        return None
    name = _name(raw.get("name"))
    kind = raw.get("kind")
    if not name or kind not in KINDS:
        return None
    value = _value_of(kind, raw.get("value"))
    if value is None or not _flag(raw.get("active"), True):
        return None
    return {
        "id": pid.strip(),
        "name": name,
        "kind": kind,
        "value": _number(value),
        "color": _color(raw.get("color")),
        "requiresManager": _flag(raw.get("requiresManager"), False),
        "button": _flag(raw.get("button"), True),
        "forWhom": _choice(raw.get("forWhom"), FOR_WHOM),
        "forWhomSource": _choice(raw.get("forWhomSource"), FOR_WHOM_SOURCES),
    }


def resolve_for_till(presets: Any, buttons: Any) -> Dict[str, Any]:
    """
    The presets a till offers, in order, and the ids of those that are one-tap buttons.

    [presets] / [buttons] are the merged `presetDiscounts` / `presetDiscountButtons`. A preset
    not active, or not well formed, is dropped; a repeated id keeps its first. Buttons: the
    presets [buttons] names (in the presets' order) when it is a list, else every preset whose
    `button` is on.
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    for raw in presets if isinstance(presets, list) else []:
        p = _till_preset(raw)
        if p is None or p["id"] in seen:
            continue
        seen.add(p["id"])
        out.append(p)
        if len(out) >= PRESETS_MAX:
            break
    if isinstance(buttons, list):
        wanted = {b for b in buttons if isinstance(b, str)}
        button_ids = [p["id"] for p in out if p["id"] in wanted]
    else:
        button_ids = [p["id"] for p in out if p["button"]]
    return {"presets": out, "buttons": button_ids}


# ── the rule (spec §4) ─────────────────────────────────────────────────────────


def apply_preset(payable_agorot: int, non_discountable_agorot: int, kind: str, value: Any) -> Dict[str, Any]:
    """
    What a preset takes off a basket: `{canApply, discountAgorot, totalAgorot, ratePercent}`.

    [payable_agorot] is the sale lines after their own discounts (and promotions, vouchers)
    with no basket discount; [non_discountable_agorot] what of it is products that take no
    discount. The discount is taken over the rest only: a percent of it (hundredths of a
    percent, truncated to the agora, as the till's cart does), or the amount — capped at it,
    never refused. `ratePercent` is the rate a role's `maxPercent` is checked against.
    """
    excluded = non_discountable_agorot if non_discountable_agorot > 0 else 0
    base = payable_agorot - excluded
    v = _value_of(kind, value) if kind in KINDS else None
    if base <= 0 or v is None:
        return {"canApply": False, "discountAgorot": 0, "totalAgorot": payable_agorot, "ratePercent": None}
    if kind == "percent":
        hundredths = int(v * 100)
        discount = base * hundredths // 10_000
        rate = float(v)
    else:
        discount = min(int(v * 100), base)
        rate = float((Decimal(discount) * 100 / Decimal(payable_agorot)).quantize(_CENT, rounding=ROUND_HALF_UP))
    return {
        "canApply": discount > 0,
        "discountAgorot": discount,
        "totalAgorot": payable_agorot - discount,
        "ratePercent": rate,
    }


# ── the dashboard's writes (strict: refuse, name the field) ────────────────────


def validate_presets(value: Optional[List[Any]]) -> Optional[List[Dict[str, Any]]]:
    """
    `presetDiscounts` as a layer stores it, or ValueError naming what is wrong. Ids are kept
    (the documents and the reports name a preset by it) and given when missing.
    """
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("presetDiscounts must be a list")
    if len(value) > PRESETS_MAX:
        raise ValueError(f"at most {PRESETS_MAX} preset discounts")
    out: List[Dict[str, Any]] = []
    seen = set()
    for i, raw in enumerate(value):
        where = f"presetDiscounts[{i}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{where} must be an object")
        unknown = set(raw) - {
            "id", "name", "kind", "value", "active", "color", "requiresManager", "button", "forWhom", "forWhomSource",
        }
        if unknown:
            raise ValueError(f"{where}: unknown keys {sorted(unknown)}")
        pid = raw.get("id")
        if pid in (None, ""):
            pid = str(uuid.uuid4())
        if not isinstance(pid, str) or len(pid.strip()) > ID_MAX or not pid.strip():
            raise ValueError(f"{where}.id must be a string of at most {ID_MAX} characters")
        pid = pid.strip()
        if pid in seen:
            raise ValueError(f"{where}.id repeats")
        seen.add(pid)
        name = " ".join(raw.get("name").split()) if isinstance(raw.get("name"), str) else ""
        if not name:
            raise ValueError(f"{where}.name is required")
        if len(name) > NAME_MAX:
            raise ValueError(f"{where}.name is at most {NAME_MAX} characters")
        kind = raw.get("kind")
        if kind not in KINDS:
            raise ValueError(f"{where}.kind must be percent or amount")
        d = _decimal(raw.get("value"))
        if d is None or d != d.quantize(_CENT, rounding=ROUND_HALF_UP) or _value_of(kind, d) is None:
            top = "100" if kind == "percent" else "100000"
            raise ValueError(f"{where}.value must be above 0 and at most {top}, two decimals at most")
        for key in ("active", "requiresManager", "button"):
            if key in raw and raw[key] is not None and not isinstance(raw[key], bool):
                raise ValueError(f"{where}.{key} must be true or false")
        color = raw.get("color")
        if color not in (None, "") and _color(color) is None:
            raise ValueError(f"{where}.color must be #RRGGBB")
        for key, choices in (("forWhom", FOR_WHOM), ("forWhomSource", FOR_WHOM_SOURCES)):
            if raw.get(key) is not None and raw.get(key) not in choices:
                raise ValueError(f"{where}.{key} must be one of {', '.join(choices)}")
        out.append({
            "id": pid,
            "name": name,
            "kind": kind,
            "value": _number(d),
            "active": _flag(raw.get("active"), True),
            "color": _color(color),
            "requiresManager": _flag(raw.get("requiresManager"), False),
            "button": _flag(raw.get("button"), True),
            "forWhom": _choice(raw.get("forWhom"), FOR_WHOM),
            "forWhomSource": _choice(raw.get("forWhomSource"), FOR_WHOM_SOURCES),
        })
    return out


def validate_buttons(value: Optional[List[Any]]) -> Optional[List[str]]:
    """`presetDiscountButtons`: preset ids, no repeats."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > PRESETS_MAX:
        raise ValueError(f"presetDiscountButtons must be a list of at most {PRESETS_MAX} ids")
    out: List[str] = []
    for v in value:
        if not isinstance(v, str) or not v.strip() or len(v.strip()) > ID_MAX:
            raise ValueError("presetDiscountButtons holds preset ids")
        if v.strip() not in out:
            out.append(v.strip())
    return out


# ── the document ───────────────────────────────────────────────────────────────


def _cut(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] or None


def clean_document_fields(kind: Optional[str], fields: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """
    The preset columns a sale is stored with: only when its basket discount is a preset's
    (`basketDiscountKind` "preset") — never a reason to refuse the document; free text cut.
    """
    empty = {"preset_discount_id": None, "preset_discount_name": None, "preset_discount_for": None,
             "preset_discount_for_kind": None, "preset_discount_for_ref": None}
    if kind != KIND_PRESET:
        return empty
    for_name = _cut(fields.get("for"), DOC_FOR_MAX)
    for_kind = fields.get("forKind")
    return {
        "preset_discount_id": _cut(fields.get("id"), ID_MAX),
        "preset_discount_name": _cut(fields.get("name"), DOC_NAME_MAX),
        "preset_discount_for": for_name,
        "preset_discount_for_kind": (for_kind if for_kind in FOR_KINDS else "typed") if for_name else None,
        "preset_discount_for_ref": _cut(fields.get("forRef"), DOC_FOR_REF_MAX) if for_name else None,
    }
