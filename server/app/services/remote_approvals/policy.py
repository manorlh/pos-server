"""
"בקשות אישור" settings per level: company → shop → area (נקודת מכירה) → machine.

A level stores only what it sets (`approval_policy_values.values`):

    {"enabled": true, "types": {"discount_basket": {"enabled": true, "reasons": [...]}}}

and everything else inherits, **field by field** — the master switch, and each field of each
type — from the nearest level above that sets it, else the §4 default (catalog.py). The same
order and rule as the exception rules (`app.services.exceptions.resolve_rules`) and the till
parameters. A field is atomic: `limits` or `onShiftOnly` set at a level replace the whole
mapping below it, so what a level shows is exactly what applies.

Writing is strict (an unknown type, field or value is refused with a message); reading is
forgiving (a stored value that no longer validates reads as inherited, never a 500).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.remote_approval import ApprovalPolicyValue
from app.models.shop import Shop
from app.services.remote_approvals import catalog as C

logger = logging.getLogger(__name__)

Level = Tuple[str, uuid.UUID]

#: What a till reads of a type (§7) — the rest stays in the cloud.
TILL_FIELDS = ("methods", "pickApprover", "reasonMode", "reasons", "noteToManager", "allowPartial", "timeoutSeconds")


class PolicyValueError(ValueError):
    """A value the settings do not accept. The message is safe to show."""


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


# ── Validation ───────────────────────────────────────────────────────────────


def _bool(type_key: str, key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise PolicyValueError(f"{type_key}.{key} must be true or false")
    return value


def _roles(type_key: str, key: str, value: Any) -> List[str]:
    if not isinstance(value, list):
        raise PolicyValueError(f"{type_key}.{key} must be a list of roles")
    out: List[str] = []
    for item in value:
        if not isinstance(item, str) or not C.ROLE_KEY_RE.match(item.strip()):
            raise PolicyValueError(f"{type_key}.{key}: unknown role {item!r}")
        if item.strip() not in out:
            out.append(item.strip())
    if len(out) > C.MAX_ROLES:
        raise PolicyValueError(f"{type_key}.{key}: at most {C.MAX_ROLES} roles")
    return out


def _number(type_key: str, key: str, value: Any, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise PolicyValueError(f"{type_key}.{key} must be a number")
    if value < minimum or value > maximum:
        raise PolicyValueError(f"{type_key}.{key} must be between {minimum:g} and {maximum:g}")
    return int(value) if float(value).is_integer() else float(value)


def _role_limits(type_key: str, value: Any) -> Dict[str, Dict[str, float]]:
    if not isinstance(value, dict):
        raise PolicyValueError(f"{type_key}.limits must be an object")
    out: Dict[str, Dict[str, float]] = {}
    for role, limits in value.items():
        if not isinstance(role, str) or not C.ROLE_KEY_RE.match(role):
            raise PolicyValueError(f"{type_key}.limits: unknown role {role!r}")
        if limits is None:
            continue
        if not isinstance(limits, dict):
            raise PolicyValueError(f"{type_key}.limits.{role} must be an object")
        cleaned: Dict[str, float] = {}
        for lim_key, lim_value in limits.items():
            if lim_key not in C.LIMIT_KEYS:
                raise PolicyValueError(f"{type_key}.limits.{role}: unknown limit {lim_key!r}")
            if lim_value is None:
                continue
            maximum = 100 if lim_key == "maxPercent" else (99 if lim_key == "maxCount" else 1_000_000)
            cleaned[lim_key] = _number(type_key, f"limits.{role}.{lim_key}", lim_value, minimum=0, maximum=maximum)
        if cleaned:
            out[role] = cleaned
    return out


def _role_bools(type_key: str, value: Any) -> Dict[str, bool]:
    if not isinstance(value, dict):
        raise PolicyValueError(f"{type_key}.onShiftOnly must be an object")
    out: Dict[str, bool] = {}
    for role, flag in value.items():
        if not isinstance(role, str) or not C.ROLE_KEY_RE.match(role):
            raise PolicyValueError(f"{type_key}.onShiftOnly: unknown role {role!r}")
        if flag is None:
            continue
        out[role] = _bool(type_key, f"onShiftOnly.{role}", flag)
    return out


def clean_field(type_key: str, key: str, value: Any) -> Any:
    """One field of one type, validated. Raises `PolicyValueError`."""
    spec = C.FIELDS_BY_KEY.get(key)
    if spec is None:
        raise PolicyValueError(f"{type_key}: unknown field {key!r}")
    if spec.kind == "bool":
        return _bool(type_key, key, value)
    if spec.kind == "enum":
        if value not in spec.options:
            raise PolicyValueError(f"{type_key}.{key} must be one of {', '.join(spec.options)}")
        return value
    if spec.kind == "methods":
        if not isinstance(value, list) or not value:
            raise PolicyValueError(f"{type_key}.methods must name at least one of pin, remote")
        out = []
        for item in value:
            if item not in C.METHODS:
                raise PolicyValueError(f"{type_key}.methods: unknown method {item!r}")
            if item not in out:
                out.append(item)
        return [m for m in C.METHODS if m in out]
    if spec.kind == "roles":
        return _roles(type_key, key, value)
    if spec.kind == "roleLimits":
        return _role_limits(type_key, value)
    if spec.kind == "roleBools":
        return _role_bools(type_key, value)
    if spec.kind == "strings":
        if not isinstance(value, list):
            raise PolicyValueError(f"{type_key}.reasons must be a list")
        out = []
        for item in value:
            if not isinstance(item, str) or not item.strip():
                raise PolicyValueError(f"{type_key}.reasons: a reason must be a non-empty text")
            text = item.strip()
            if len(text) > C.MAX_REASON_LENGTH:
                raise PolicyValueError(f"{type_key}.reasons: at most {C.MAX_REASON_LENGTH} characters")
            if text not in out:
                out.append(text)
        if len(out) > C.MAX_REASONS:
            raise PolicyValueError(f"{type_key}.reasons: at most {C.MAX_REASONS} reasons")
        return out
    if spec.kind == "int":
        if isinstance(value, bool) or not isinstance(value, int) and not (isinstance(value, float) and value.is_integer()):
            raise PolicyValueError(f"{type_key}.{key} must be a whole number")
        number = int(value)
        if key == "escalateAfterSeconds":
            if number != 0 and not C.ESCALATE_MIN <= number <= C.ESCALATE_MAX:
                raise PolicyValueError(
                    f"{type_key}.{key} must be 0 (off) or between {C.ESCALATE_MIN} and {C.ESCALATE_MAX}"
                )
            return number
        if number < (spec.minimum or 0) or number > (spec.maximum or number):
            raise PolicyValueError(f"{type_key}.{key} must be between {spec.minimum} and {spec.maximum}")
        return number
    raise PolicyValueError(f"{type_key}: field {key!r} cannot be set")  # pragma: no cover


def clean_styles(payload: Any) -> Dict[str, str]:
    """`approvalStyle`: `{code | "*": approve | takeover | both}`; a null entry inherits."""
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise PolicyValueError("approvalStyle must be an object")
    codes = set(C.style_codes())
    out: Dict[str, str] = {}
    for code, style in payload.items():
        if code != C.STYLE_ALL and code not in codes:
            raise PolicyValueError(f"approvalStyle: unknown permission {code!r}")
        if style is None:
            continue
        if style not in C.STYLES:
            raise PolicyValueError(f"approvalStyle.{code} must be one of {', '.join(C.STYLES)}")
        out[code] = style
    return out


def clean_values(payload: Any) -> Dict[str, Any]:
    """A level's own values from a request body: `{enabled?, types?: {type: {field: value}}, approvalStyle?}`."""
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise PolicyValueError("the settings must be an object")
    out: Dict[str, Any] = {}
    for key in payload:
        if key not in ("enabled", "types", "approvalStyle"):
            raise PolicyValueError(f"unknown setting {key!r}")
    styles = clean_styles(payload.get("approvalStyle"))
    if styles:
        out["approvalStyle"] = styles
    enabled = payload.get("enabled")
    if enabled is not None:
        out["enabled"] = _bool("approvalRequests", "enabled", enabled)
    types = payload.get("types")
    if types is not None:
        if not isinstance(types, Mapping):
            raise PolicyValueError("types must be an object")
        cleaned_types: Dict[str, Dict[str, Any]] = {}
        for type_key, fields in types.items():
            if type_key not in C.TYPES_BY_KEY:
                raise PolicyValueError(f"unknown request type {type_key!r}")
            if fields is None:
                continue
            if not isinstance(fields, Mapping):
                raise PolicyValueError(f"{type_key} must be an object")
            own: Dict[str, Any] = {}
            for key, value in fields.items():
                if value is None:
                    continue
                own[key] = clean_field(type_key, key, value)
            if own:
                cleaned_types[type_key] = own
        if cleaned_types:
            out["types"] = cleaned_types
    return out


def _stored(row_values: Any) -> Dict[str, Any]:
    """A stored row read forgivingly: what no longer validates is dropped (inherits)."""
    if not isinstance(row_values, Mapping):
        return {}
    out: Dict[str, Any] = {}
    if isinstance(row_values.get("enabled"), bool):
        out["enabled"] = row_values["enabled"]
    raw_styles = row_values.get("approvalStyle")
    if isinstance(raw_styles, Mapping):
        codes = set(C.style_codes()) | {C.STYLE_ALL}
        styles = {k: v for k, v in raw_styles.items() if k in codes and v in C.STYLES}
        if styles:
            out["approvalStyle"] = styles
    types = row_values.get("types")
    if isinstance(types, Mapping):
        kept: Dict[str, Dict[str, Any]] = {}
        for type_key, fields in types.items():
            if type_key not in C.TYPES_BY_KEY or not isinstance(fields, Mapping):
                continue
            own: Dict[str, Any] = {}
            for key, value in fields.items():
                if value is None:
                    continue
                try:
                    own[key] = clean_field(type_key, key, value)
                except PolicyValueError:
                    continue
            if own:
                kept[type_key] = own
        if kept:
            out["types"] = kept
    return out


# ── Resolution ───────────────────────────────────────────────────────────────


@dataclass
class EffectivePolicy:
    enabled: bool
    types: Dict[str, Dict[str, Any]]
    #: Where each value came from: a level name, or None (the default).
    enabled_source: Optional[str] = None
    sources: Dict[str, Dict[str, Optional[str]]] = field(default_factory=dict)
    #: "סגנון האישור" per till permission, and where each came from (a level, or None = default).
    styles: Dict[str, str] = field(default_factory=dict)
    style_sources: Dict[str, Optional[str]] = field(default_factory=dict)

    def type(self, type_key: str) -> Dict[str, Any]:
        return self.types[type_key]

    def style(self, code: str) -> str:
        return self.styles.get(code, C.DEFAULT_STYLE)

    def remote_open(self, type_key: str) -> bool:
        """The feature on, the type on, and "remote" among its methods."""
        t = self.types.get(type_key)
        return bool(self.enabled and t and t.get("enabled") and "remote" in (t.get("methods") or []))


def _out_value(key: str, value: Any) -> Any:
    if key == "escalateAfterSeconds" and not value:
        return None
    return value


def resolve(rows: Iterable[ApprovalPolicyValue], chain: Sequence[Level]) -> EffectivePolicy:
    """Field by field, the most specific level on `chain` (most specific first) that sets it."""
    rank = {(kind, _uuid(ident)): i for i, (kind, ident) in enumerate(chain)}
    layered: List[Tuple[int, str, Dict[str, Any]]] = []
    for row in rows:
        position = rank.get((row.scope_type, _uuid(row.scope_id)))
        if position is not None:
            layered.append((position, row.scope_type, _stored(row.values)))
    layered.sort(key=lambda item: item[0])

    enabled, enabled_source = False, None
    for _, level, values in layered:
        if "enabled" in values:
            enabled, enabled_source = values["enabled"], level
            break

    types: Dict[str, Dict[str, Any]] = {}
    sources: Dict[str, Dict[str, Optional[str]]] = {}
    for t in C.TYPES:
        merged = C.type_defaults(t.key)
        src: Dict[str, Optional[str]] = {key: None for key in merged}
        for key in merged:
            for _, level, values in layered:
                own = (values.get("types") or {}).get(t.key) or {}
                if key in own:
                    merged[key], src[key] = own[key], level
                    break
        types[t.key] = {key: _out_value(key, value) for key, value in merged.items()}
        sources[t.key] = src

    # "סגנון האישור": per permission, the nearest level that names it — or says "*" for all.
    styles: Dict[str, str] = {}
    style_sources: Dict[str, Optional[str]] = {}
    for code in C.style_codes():
        styles[code], style_sources[code] = C.DEFAULT_STYLE, None
        for _, level, values in layered:
            own = values.get("approvalStyle") or {}
            if code in own:
                styles[code], style_sources[code] = own[code], level
                break
            if C.STYLE_ALL in own:
                styles[code], style_sources[code] = own[C.STYLE_ALL], level
                break
    return EffectivePolicy(
        enabled=enabled, types=types, enabled_source=enabled_source, sources=sources,
        styles=styles, style_sources=style_sources,
    )


def company_of_shop(db: Session, shop_id: Any) -> Optional[uuid.UUID]:
    if shop_id is None:
        return None
    row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
    return row[0] if row else None


def chain_for(*, company_id=None, shop_id=None, area_id=None, machine_id=None) -> List[Level]:
    ordered = (("machine", machine_id), ("area", area_id), ("shop", shop_id), ("company", company_id))
    return [(kind, _uuid(ident)) for kind, ident in ordered if ident is not None]


def chain_for_machine(db: Session, machine: POSMachine) -> List[Level]:
    return chain_for(
        company_id=company_of_shop(db, machine.shop_id),
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
    )


def rows_on_chain(db: Session, chain: Sequence[Level]) -> List[ApprovalPolicyValue]:
    if not chain:
        return []
    ids = [ident for _, ident in chain]
    rows = db.query(ApprovalPolicyValue).filter(ApprovalPolicyValue.scope_id.in_(ids)).all()
    wanted = set(chain)
    return [r for r in rows if (r.scope_type, _uuid(r.scope_id)) in wanted]


def for_machine(db: Session, machine: POSMachine) -> EffectivePolicy:
    chain = chain_for_machine(db, machine)
    return resolve(rows_on_chain(db, chain), chain)


def changed_at(db: Session, chain: Sequence[Level]) -> Optional[datetime]:
    """When a level on this chain last changed its own values (the settings watermark)."""
    if not chain:
        return None
    ids = [ident for _, ident in chain]
    return db.query(func.max(ApprovalPolicyValue.updated_at)).filter(ApprovalPolicyValue.scope_id.in_(ids)).scalar()


# ── What a till receives (§7) ────────────────────────────────────────────────

#: What a till's heartbeat says when its build implements remote approvals.
CAPABILITY = "remote_approval_v1"


def capable(machine: POSMachine) -> bool:
    caps = getattr(machine, "capabilities", None) or []
    return isinstance(caps, list) and CAPABILITY in caps


def till_block(effective: EffectivePolicy) -> Dict[str, Any]:
    """`approvalRequests` as the till reads it: the enabled types only, with their till fields."""
    if not effective.enabled:
        return {"enabled": False, "types": {}}
    types: Dict[str, Dict[str, Any]] = {}
    for t in C.TYPES:
        value = effective.types[t.key]
        if not value.get("enabled"):
            continue
        types[t.key] = {key: value[key] for key in TILL_FIELDS}
    return {"enabled": True, "types": types}


def for_settings_sync(db: Session, machine: POSMachine) -> Tuple[Optional[datetime], EffectivePolicy]:
    """
    What the settings pull reads of the approvals: the watermark of the till's levels and the
    effective policy. Never fails the pull — on any error, no stamp and the defaults (the feature
    off, every style "both"), and the error is logged.
    """
    try:
        with db.begin_nested():
            chain = chain_for_machine(db, machine)
            rows = rows_on_chain(db, chain)
            stamp = changed_at(db, chain)
            effective = resolve(rows, chain)
        return (stamp if isinstance(stamp, datetime) else None), effective
    except Exception:  # noqa: BLE001 - the approvals never fail a settings pull
        logger.exception("approvals: settings for machine %s fell back to the defaults", getattr(machine, "id", None))
        return None, resolve([], [])


def till_styles(effective: EffectivePolicy) -> Dict[str, str]:
    """`approvalStyle` as every till reads it: each permission's style (approve | takeover | both)."""
    return dict(effective.styles)


def till_settings(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """The settings sync's `approvalRequests` for this till; None for a till without the capability."""
    if not capable(machine):
        return None
    return till_block(for_machine(db, machine))


# ── Writing ──────────────────────────────────────────────────────────────────


def own_row(db: Session, scope_type: str, scope_id: Any) -> Optional[ApprovalPolicyValue]:
    return (
        db.query(ApprovalPolicyValue)
        .filter(ApprovalPolicyValue.scope_type == scope_type, ApprovalPolicyValue.scope_id == _uuid(scope_id))
        .first()
    )


def save_level(db: Session, *, tenant_id: Any, scope_type: str, scope_id: Any, payload: Any, user_id: Any,
               now: datetime) -> Dict[str, Any]:
    """Replace one level's own values (validated). Empty = the level inherits everything again."""
    values = clean_values(payload)
    row = own_row(db, scope_type, scope_id)
    if not values:
        if row is not None:
            db.delete(row)
            db.flush()
        return {}
    if row is None:
        row = ApprovalPolicyValue(
            id=uuid.uuid4(), tenant_id=_uuid(tenant_id), scope_type=scope_type, scope_id=_uuid(scope_id),
        )
        db.add(row)
    row.values = values
    row.updated_by = _uuid(user_id)
    row.updated_at = now
    db.flush()
    return values


def machines_under(db: Session, scope_type: str, scope_id: Any) -> List[POSMachine]:
    """The tills a level's change reaches (for the settings notify)."""
    q = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    ident = _uuid(scope_id)
    if scope_type == "machine":
        q = q.filter(POSMachine.id == ident)
    elif scope_type == "area":
        q = q.filter(POSMachine.area_id == ident)
    elif scope_type == "shop":
        q = q.filter(POSMachine.shop_id == ident)
    else:
        q = q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == ident)
    return q.all()
