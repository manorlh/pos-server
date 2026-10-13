"""
Per-employee exceptions for remote approvals, in the existing `pos_users.permission_overrides`
(the employee card), under the key `approvals` — beside the role overrides' `states` / `limits`,
which they never touch:

    {"approvals": {"all": {"offShift": true}, "types": {"refund": {"maxAmount": 500, "noRequests": false}}}}

* `offShift` — "רשאי לאשר גם כשאינו במשמרת": "רק במשמרת" does not apply to them.
* `maxAmount` / `maxPercent` / `maxCount` — "תקרה אישית": replaces the role's ceiling.
* `noRequests` — "לא מקבל בקשות": never an approver.

Per type wins over `all`, field by field.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping

from app.services.remote_approvals import catalog as C

KEY = "approvals"
FLAG_KEYS = ("offShift", "noRequests")
LIMIT_MAX = {"maxAmount": 1_000_000, "maxPercent": 100, "maxCount": 99}


class OverrideValueError(ValueError):
    """An override the employee card may not store. Message is safe to show."""


def _clean_one(where: str, raw: Any) -> Dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise OverrideValueError(f"{where} must be an object")
    out: Dict[str, Any] = {}
    for key, value in raw.items():
        if value is None:
            continue
        if key in FLAG_KEYS:
            if not isinstance(value, bool):
                raise OverrideValueError(f"{where}.{key} must be true or false")
            out[key] = value
        elif key in LIMIT_MAX:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
                raise OverrideValueError(f"{where}.{key} must be a number")
            if value < 0 or value > LIMIT_MAX[key]:
                raise OverrideValueError(f"{where}.{key} must be between 0 and {LIMIT_MAX[key]}")
            out[key] = int(value) if float(value).is_integer() else float(value)
        else:
            raise OverrideValueError(f"{where}: unknown field {key!r}")
    return out


def clean(payload: Any) -> Dict[str, Any]:
    """`{all?, types?}` validated; empty parts dropped."""
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise OverrideValueError("overrides must be an object")
    out: Dict[str, Any] = {}
    every = _clean_one("all", payload.get("all"))
    if every:
        out["all"] = every
    types = payload.get("types")
    if types is not None:
        if not isinstance(types, Mapping):
            raise OverrideValueError("types must be an object")
        kept = {}
        for type_key, raw in types.items():
            if type_key not in C.TYPES_BY_KEY:
                raise OverrideValueError(f"unknown request type {type_key!r}")
            one = _clean_one(type_key, raw)
            if one:
                kept[type_key] = one
        if kept:
            out["types"] = kept
    return out


def read(pos_user: Any) -> Dict[str, Any]:
    """The employee's approval overrides, forgivingly (what no longer validates is dropped)."""
    raw = getattr(pos_user, "permission_overrides", None)
    stored = raw.get(KEY) if isinstance(raw, Mapping) else None
    try:
        return clean(stored)
    except OverrideValueError:
        return {}


def for_type(pos_user: Any, type_key: str) -> Dict[str, Any]:
    """The overrides that apply to one type: the type's own over `all`."""
    own = read(pos_user)
    merged = dict(own.get("all") or {})
    merged.update((own.get("types") or {}).get(type_key) or {})
    return merged


def write(pos_user: Any, payload: Any) -> Dict[str, Any]:
    """Store the approval overrides on the employee, keeping the role overrides as they are."""
    cleaned = clean(payload)
    current = getattr(pos_user, "permission_overrides", None)
    base = dict(current) if isinstance(current, Mapping) else {}
    if cleaned:
        base[KEY] = cleaned
    else:
        base.pop(KEY, None)
    pos_user.permission_overrides = base or None
    return cleaned


def as_json(pos_user: Any) -> Dict[str, Any]:
    own = read(pos_user)
    return {"all": own.get("all") or {}, "types": own.get("types") or {}}
