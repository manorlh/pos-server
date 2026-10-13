"""
"התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md): who must have the dashboard's
phone notifications on, and how a notification behaves on the phone — both dynamic, per level.

**Levels**, least specific first; a level that says nothing inherits from the one above it:

* **company** — `companies.settings["pushPolicy"]`, else the parent company's (a holding group
  sets it for its subsidiaries). A dashboard key: it is not in `MANAGED_SETTING_KEYS`
  (settings_merge.py), so it never reaches a till;
* **dashboard template or role** — the platform setting "pushPolicy":
  `{"templates": {template: policy}, "roles": {role: policy}}` (the templates themselves are
  platform-wide, the super admin's). The user's template first, then their role;
* **user** — `users.preferences["pushPolicy"]`.

A policy, at any level (every field optional = inherit):

    {"required": "off" | "reminder" | "required",
     "notify": {category: {"requireInteraction": "always" | "critical" | "never",
                           "vibrate": "default" | "short" | "double" | "long" | "urgent"}}}

**`required`** — what the dashboard does on a phone with no notifications (the dashboard's
`PushGate`; never on a computer): `off` nothing, `reminder` an orange bar that can be closed for
24 hours, `required` a red bar that cannot and the "הפעל התראות" screen on every open. With no
level setting it, the default (§3):

* `required` — the user may decide approval requests (section `approvals` at edit) and approval
  requests are on in one of their shops. The section is feat/remote-approvals'; until it is
  registered (`SECTION_IDS`) nobody holds it and this never applies;
* `reminder` — the user has the section "התראות" (`alerts`);
* `off` — everyone else.

**`notify`** — per alert category (push.py `CATEGORIES`, plus the ones other branches add):
whether the notification stays on the screen until touched (`requireInteraction`: always /
only a critical one — the alert's severity "high" or `details.critical` — / never) and its
vibration. Defaults (§4): approval requests and data integrity stay on screen, approval
requests vibrate their own pattern, a battery alert stays only at the critical threshold; any
other category keeps today's rule (a high-severity alert stays). Resolved per recipient and
alert — the alert's company, then the recipient's template / role, then the recipient — and
carried in the push payload (`requireInteraction`, `vibrate`), which public/sw.js applies.

Reading is forgiving (an unknown value reads as inherited, never a 500); writing is strict
(`PolicyError` → 422), so only known values are ever stored. Nothing here sends anything.
"""
from __future__ import annotations

import importlib
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

POLICY_KEY = "pushPolicy"

OFF = "off"
REMINDER = "reminder"
REQUIRED = "required"
MODES: Tuple[str, ...] = (OFF, REMINDER, REQUIRED)
_RANK = {OFF: 0, REMINDER: 1, REQUIRED: 2}

#: The sections the defaults read. `approvals` is feat/remote-approvals'.
APPROVALS_SECTION = "approvals"
ALERTS_SECTION = "alerts"

ALWAYS = "always"
CRITICAL = "critical"
NEVER = "never"
INTERACTIONS: Tuple[str, ...] = (ALWAYS, CRITICAL, NEVER)

#: Vibration patterns (ms on / off …); "default" = the phone's own (no pattern sent).
VIBRATE_PRESETS: Dict[str, Optional[List[int]]] = {
    "default": None,
    "short": [200],
    "double": [200, 100, 200],
    "long": [700],
    "urgent": [300, 120, 300, 120, 600],
}

#: Any category no level speaks of: today's rule (sw.js before this) — a high-severity alert stays.
FALLBACK_NOTIFY: Dict[str, str] = {"requireInteraction": CRITICAL, "vibrate": "default"}
#: §4: on by default for approval requests, data integrity and a critical battery.
NOTIFY_DEFAULTS: Dict[str, Dict[str, str]] = {
    "approvals": {"requireInteraction": ALWAYS, "vibrate": "urgent"},
    "integrity": {"requireInteraction": ALWAYS, "vibrate": "default"},
    "device_battery": {"requireInteraction": CRITICAL, "vibrate": "default"},
}
#: Names for the categories other branches bring (push.py names its own).
EXTRA_LABELS: Dict[str, str] = {
    "approvals": "בקשות אישור",
    "integrity": "שלמות נתונים",
    "device_battery": "סוללה חלשה",
}

#: "התראות בנייד" on the users list: no success for this long = yellow.
HEALTH_WINDOW = timedelta(days=7)
#: A device that failed this many times in a row since its last success is not green.
HEALTH_FAILURES = 3

USER_ROLES: Tuple[str, ...] = (
    "super_admin", "distributor", "company_manager", "shop_manager", "shift_supervisor", "cashier",
)

_MEMO = "push_policy_memo"


class PolicyError(ValueError):
    def __init__(self, code: str, field: Optional[str] = None, detail: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.field = field
        self.detail = detail


# ── Categories ───────────────────────────────────────────────────────────────


def category_labels() -> Dict[str, str]:
    """Every category a notification may carry: push.py's (whatever exists) and the defaults'."""
    from app.services.exception_alerts import push as P

    out = {c.key: c.label for c in P.CATEGORIES}
    for key in (*NOTIFY_DEFAULTS, *EXTRA_LABELS):
        out.setdefault(key, EXTRA_LABELS.get(key, key))
    return out


def notify_default(category: Optional[str]) -> Dict[str, str]:
    return dict(NOTIFY_DEFAULTS.get(category or "", FALLBACK_NOTIFY))


def categories_json() -> List[Dict[str, Any]]:
    return [{"key": k, "label": label, "default": notify_default(k)} for k, label in category_labels().items()]


def catalogue_json() -> Dict[str, Any]:
    """What an editor offers: the modes, the categories with their defaults, the choices."""
    return {
        "modes": list(MODES),
        "interactions": list(INTERACTIONS),
        "vibratePresets": list(VIBRATE_PRESETS),
        "categories": categories_json(),
        "roles": list(USER_ROLES),
    }


# ── A policy: cleaning ───────────────────────────────────────────────────────


def _clean_notify_rule(raw: Any, field: str, strict: bool) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if raw is None:
        return out
    if not isinstance(raw, Mapping):
        if strict:
            raise PolicyError("notify_invalid", field)
        return out
    for key, value in raw.items():
        if value is None:
            continue
        if key == "requireInteraction":
            if value in INTERACTIONS:
                out[key] = value
            elif isinstance(value, bool):  # a plain switch: on = always, off = never
                out[key] = ALWAYS if value else NEVER
            elif strict:
                raise PolicyError("interaction_invalid", f"{field}.requireInteraction", str(value))
        elif key == "vibrate":
            if value in VIBRATE_PRESETS:
                out[key] = value
            elif strict:
                raise PolicyError("vibrate_invalid", f"{field}.vibrate", str(value))
        elif strict:
            raise PolicyError("notify_field_unknown", f"{field}.{key}")
    return out


def clean_policy(raw: Any, *, strict: bool = False) -> Dict[str, Any]:
    """
    A policy as stored: only known values, nothing for "inherit". `strict` (a write) refuses
    anything unknown; otherwise (a read) it is dropped.
    """
    out: Dict[str, Any] = {}
    if raw is None:
        return out
    if not isinstance(raw, Mapping):
        if strict:
            raise PolicyError("policy_invalid", None)
        return out
    for key in raw:
        if key not in ("required", "notify") and strict:
            raise PolicyError("policy_field_unknown", str(key))
    required = raw.get("required")
    if required is not None:
        if required in MODES:
            out["required"] = required
        elif strict:
            raise PolicyError("mode_invalid", "required", str(required))
    notify = raw.get("notify")
    if notify is not None:
        if not isinstance(notify, Mapping):
            if strict:
                raise PolicyError("notify_invalid", "notify")
        else:
            known = category_labels() if strict else None
            cleaned: Dict[str, Dict[str, str]] = {}
            for cat, rule in notify.items():
                if not isinstance(cat, str) or (known is not None and cat not in known):
                    if strict:
                        raise PolicyError("category_unknown", "notify", str(cat))
                    continue
                own = _clean_notify_rule(rule, f"notify.{cat}", strict)
                if own:
                    cleaned[cat] = own
            if cleaned:
                out["notify"] = dict(sorted(cleaned.items()))
    return out


def policy_json(stored: Any) -> Dict[str, Any]:
    """On the wire: `required` null = inherit, `notify` only what the level sets."""
    p = clean_policy(stored)
    return {"required": p.get("required"), "notify": p.get("notify", {})}


# ── Where each level is kept ─────────────────────────────────────────────────


def _memo(db: Session) -> Dict[str, Any]:
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return {}
    return info.setdefault(_MEMO, {})


def forget(db: Session) -> None:
    info = getattr(db, "info", None)
    if isinstance(info, dict):
        info.pop(_MEMO, None)


def company_policy(company: Any) -> Dict[str, Any]:
    settings = getattr(company, "settings", None)
    return clean_policy(settings.get(POLICY_KEY) if isinstance(settings, Mapping) else None)


def set_company_policy(company: Any, policy: Dict[str, Any]) -> None:
    """Store (or clear) the company's own; `settings_updated_at` stays — no till reads it."""
    settings = dict(company.settings) if isinstance(company.settings, Mapping) else {}
    if policy:
        settings[POLICY_KEY] = policy
    else:
        settings.pop(POLICY_KEY, None)
    company.settings = settings


def user_policy(user: Any) -> Dict[str, Any]:
    prefs = getattr(user, "preferences", None)
    return clean_policy(prefs.get(POLICY_KEY) if isinstance(prefs, Mapping) else None)


def set_user_policy(user: Any, policy: Dict[str, Any]) -> None:
    prefs = dict(user.preferences) if isinstance(user.preferences, Mapping) else {}
    if policy:
        prefs[POLICY_KEY] = policy
    else:
        prefs.pop(POLICY_KEY, None)
    # A new dict, so the JSON column is seen as changed.
    user.preferences = prefs or None


def platform_policy(db: Session) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """`{"templates": {key: policy}, "roles": {role: policy}}`, read forgivingly (memoised)."""
    memo = _memo(db)
    if "platform" in memo:
        return memo["platform"]
    from app.models.platform_setting import PlatformSetting

    row = db.get(PlatformSetting, POLICY_KEY) if callable(getattr(db, "get", None)) else None
    value = row.value if isinstance(getattr(row, "value", None), Mapping) else {}
    out: Dict[str, Dict[str, Dict[str, Any]]] = {"templates": {}, "roles": {}}
    for part in ("templates", "roles"):
        raw = value.get(part)
        if isinstance(raw, Mapping):
            for key, policy in raw.items():
                if part == "roles" and key not in USER_ROLES:
                    continue
                cleaned = clean_policy(policy)
                if cleaned:
                    out[part][str(key)] = cleaned
    memo["platform"] = out
    return out


def template_keys(db: Session) -> Dict[str, str]:
    """The templates a policy may name: the built-in ones (shown or not) and every saved one."""
    from app.models.dashboard_access import DashboardAccessTemplate
    from app.services import dashboard_sections as DS

    out = {key: spec["label"] for key, spec in DS.BUILTIN_TEMPLATES.items()}
    for tid, name in db.query(DashboardAccessTemplate.id, DashboardAccessTemplate.name).all():
        out[str(tid)] = name
    return out


def clean_platform(db: Session, body: Any) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """A write of the template / role level (strict). An entry set to null or {} is removed."""
    if not isinstance(body, Mapping):
        raise PolicyError("policy_invalid", None)
    templates = template_keys(db)
    out: Dict[str, Dict[str, Dict[str, Any]]] = {"templates": {}, "roles": {}}
    for part in ("templates", "roles"):
        raw = body.get(part) or {}
        if not isinstance(raw, Mapping):
            raise PolicyError("policy_invalid", part)
        for key, policy in raw.items():
            key = str(key)
            if part == "templates" and key not in templates:
                raise PolicyError("template_unknown", part, key)
            if part == "roles" and key not in USER_ROLES:
                raise PolicyError("role_unknown", part, key)
            try:
                cleaned = clean_policy(policy, strict=True)
            except PolicyError as exc:
                raise PolicyError(exc.code, f"{part}.{key}" + (f".{exc.field}" if exc.field else ""), exc.detail) from None
            if cleaned:
                out[part][key] = cleaned
    return out


def save_platform(db: Session, body: Any, user: Any) -> Dict[str, Dict[str, Dict[str, Any]]]:
    from app.models.platform_setting import PlatformSetting

    value = clean_platform(db, body)
    row = db.get(PlatformSetting, POLICY_KEY)
    if row is None:
        row = PlatformSetting(key=POLICY_KEY, value={})
        db.add(row)
    row.value = value
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    forget(db)
    return value


# ── Whom a level applies to ──────────────────────────────────────────────────


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _role_key(user: Any) -> str:
    role = getattr(user, "role", None)
    return role.value if hasattr(role, "value") else str(role or "")


def home_company_id(db: Session, user: Any) -> Optional[uuid.UUID]:
    """The user's company: their own, else their shop's. None for a user of no company."""
    own = _uuid(getattr(user, "company_id", None))
    if own is not None:
        return own
    shop_id = _uuid(getattr(user, "shop_id", None))
    if shop_id is None:
        return None
    from app.models.shop import Shop

    shop = db.get(Shop, shop_id)
    return _uuid(getattr(shop, "company_id", None))


def company_chain(db: Session, company_id: Any) -> List[Any]:
    """The company and its ancestors, nearest first (memoised per session)."""
    start = _uuid(company_id)
    if start is None:
        return []
    memo = _memo(db).setdefault("chains", {})
    if start in memo:
        return memo[start]
    from app.models.company import Company
    from app.services.company_hierarchy import ancestor_company_ids

    out = []
    for cid in [start, *ancestor_company_ids(db, start)]:
        company = db.get(Company, cid)
        if company is not None:
            out.append(company)
    memo[start] = out
    return out


def _template_key(db: Session, user: Any) -> Optional[str]:
    from app.services import dashboard_access as DA

    try:
        return DA.effective_access(db, user).template
    except Exception:  # noqa: BLE001 - a stand-in session: no template
        return None


def _layers(db: Session, user: Any, company_id: Any) -> List[Tuple[str, Dict[str, Any]]]:
    """(level, policy), least specific first: company chain (root → leaf), role, template, user."""
    out: List[Tuple[str, Dict[str, Any]]] = []
    for company in reversed(company_chain(db, company_id)):
        out.append(("company", company_policy(company)))
    platform = platform_policy(db)
    role = platform["roles"].get(_role_key(user))
    if role:
        out.append(("role", role))
    template = _template_key(db, user)
    if template and platform["templates"].get(template):
        out.append(("template", platform["templates"][template]))
    out.append(("user", user_policy(user)))
    return out


# ── `required` ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Required:
    mode: str
    #: "user" | "template" | "role" | "company" | "default"
    source: str
    #: What applies when no level sets it (§3's rule for this user).
    default: str

    def as_json(self) -> Dict[str, str]:
        return {"required": self.mode, "source": self.source, "default": self.default}


def _approvals_policy_module():
    """feat/remote-approvals' policy resolution, when that branch is in this build."""
    try:
        return importlib.import_module("app.services.remote_approvals.policy")
    except ImportError:
        return None


def _approvals_on_by_policy(db: Session, module: Any, shops: Sequence[Any]) -> Optional[bool]:
    """
    feat/remote-approvals (`approval_policy_values`, resolved company → shop → area → machine):
    on in one of the shops, or switched on by one of their points of sale / tills by itself.
    None when the module is not what is expected (then the settings are read instead).
    """
    try:
        for shop in shops:
            chain = module.chain_for(company_id=shop.company_id, shop_id=shop.id)
            if bool(getattr(module.resolve(module.rows_on_chain(db, chain), chain), "enabled", False)):
                return True
        from app.models.pos_machine import POSMachine

        model = importlib.import_module("app.models.remote_approval").ApprovalPolicyValue
        shop_ids = [s.id for s in shops]
        if not shop_ids:
            return False
        machines = db.query(POSMachine.id, POSMachine.area_id).filter(POSMachine.shop_id.in_(shop_ids)).all()
        below = {m for m, _ in machines} | {a for _, a in machines if a is not None}
        if not below:
            return False
        for row in db.query(model).filter(model.scope_type.in_(("area", "machine")), model.scope_id.in_(below)).all():
            values = row.values if isinstance(row.values, Mapping) else {}
            if values.get("enabled") is True:
                return True
        return False
    except Exception:  # noqa: BLE001 - another branch's internals; the settings are the fallback
        logger.warning("push_policy: approval requests policy could not be read", exc_info=True)
        return None


def _approvals_on_by_settings(db: Session, shops: Sequence[Any]) -> bool:
    """`approvalRequests.enabled` in a shop's merged settings (tenant → company → shop)."""
    from app.models.company import Company
    from app.models.tenant import Tenant
    from app.services.settings_merge import merge_all_settings_layers

    for shop in shops:
        company = db.get(Company, shop.company_id) if shop.company_id else None
        if company is None:
            continue
        tenant = db.get(Tenant, shop.tenant_id) if getattr(shop, "tenant_id", None) else None
        block = merge_all_settings_layers(company, shop, tenant).get("approvalRequests")
        if isinstance(block, Mapping) and block.get("enabled") is True:
            return True
    return False


def approvals_enabled_for(db: Session, user: Any, tenant_id: Any) -> bool:
    """Approval requests are on in one of the shops this user sees (in the active organization)."""
    memo = _memo(db).setdefault("approvals", {})
    key = (getattr(user, "id", None), str(tenant_id))
    if key in memo:
        return memo[key]
    from app.services.overview import _visible_shops_query

    try:
        query = _visible_shops_query(db, user, tenant_id) if tenant_id is not None else None
        shops = query.all() if query is not None else []
    except Exception:  # noqa: BLE001 - the default must never fail the request
        logger.warning("push_policy: the user's shops could not be read", exc_info=True)
        shops = []
    result = False
    if shops:
        module = _approvals_policy_module()
        by_policy = _approvals_on_by_policy(db, module, shops) if module is not None else None
        result = by_policy if by_policy is not None else _approvals_on_by_settings(db, shops)
    memo[key] = result
    return result


def default_required(db: Session, user: Any, tenant_id: Any) -> str:
    """§3 with no level setting it: approver with requests on → required; alerts → reminder; else off."""
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    if user is None or DA.is_producer(user):
        return OFF
    access = DA.effective_access(db, user)
    if (
        APPROVALS_SECTION in DS.SECTION_IDS
        and access.allows(APPROVALS_SECTION, DS.EDIT)
        and approvals_enabled_for(db, user, tenant_id)
    ):
        return REQUIRED
    if ALERTS_SECTION in DS.SECTION_IDS and access.allows(ALERTS_SECTION, DS.VIEW):
        return REMINDER
    return OFF


def resolve_required(db: Session, user: Any, tenant_id: Any) -> Required:
    """The most specific level that sets `required`, else the default."""
    default = default_required(db, user, tenant_id)
    from app.services import dashboard_access as DA

    if user is None or DA.is_producer(user):
        return Required(OFF, "default", default)
    for level, policy in reversed(_layers(db, user, home_company_id(db, user))):
        if policy.get("required") in MODES:
            return Required(policy["required"], level, default)
    return Required(default, "default", default)


def inherited_company_required(db: Session, company: Any) -> Optional[str]:
    """What a company inherits from its ancestors (None: nobody above sets it)."""
    for parent in company_chain(db, company.id)[1:]:
        mode = company_policy(parent).get("required")
        if mode:
            return mode
    return None


# ── `notify` ─────────────────────────────────────────────────────────────────


def resolve_notify(db: Session, user: Any, company_id: Any) -> Dict[str, Dict[str, str]]:
    """Per category, per field: the default, overridden by each level from the least specific."""
    out = {cat: notify_default(cat) for cat in category_labels()}
    for _level, policy in _layers(db, user, company_id):
        for cat, rule in (policy.get("notify") or {}).items():
            out.setdefault(cat, notify_default(cat)).update(rule)
    return out


def inherited_company_notify(db: Session, company: Any) -> Dict[str, Dict[str, str]]:
    """The categories' behaviour a company inherits (defaults, then its ancestors)."""
    out = {cat: notify_default(cat) for cat in category_labels()}
    for parent in reversed(company_chain(db, company.id)[1:]):
        for cat, rule in (company_policy(parent).get("notify") or {}).items():
            out.setdefault(cat, notify_default(cat)).update(rule)
    return out


def is_critical(payload: Mapping[str, Any], entry: Any = None) -> bool:
    if payload.get("severity") == "high" or payload.get("critical") is True:
        return True
    if entry is not None:
        if getattr(entry, "severity", None) == "high":
            return True
        details = getattr(entry, "details", None)
        if isinstance(details, Mapping) and details.get("critical") is True:
            return True
    return False


def behaviour(rule: Mapping[str, str], payload: Mapping[str, Any], entry: Any = None) -> Dict[str, Any]:
    """`requireInteraction` (bool) and `vibrate` (a pattern, or absent) for one notification (pure)."""
    interaction = rule.get("requireInteraction", CRITICAL)
    sticky = interaction == ALWAYS or (interaction == CRITICAL and is_critical(payload, entry))
    out: Dict[str, Any] = {"requireInteraction": sticky}
    pattern = VIBRATE_PRESETS.get(rule.get("vibrate") or "default")
    if pattern:
        out["vibrate"] = list(pattern)
    return out


def decorate(db: Session, owner_id: Any, payload: Dict[str, Any], entry: Any = None) -> Dict[str, Any]:
    """
    The payload with this recipient's behaviour for its category (push.py `_deliver`). Never
    fails a delivery: anything unexpected sends the payload as it was.
    """
    try:
        from app.models.user import User

        owner = db.get(User, owner_id) if owner_id is not None else None
        if owner is None:
            return payload
        company_id = getattr(entry, "company_id", None) if entry is not None else None
        if company_id is None:
            company_id = home_company_id(db, owner)
        category = payload.get("category")
        rules = resolve_notify(db, owner, company_id)
        rule = rules.get(category) if category else None
        return {**payload, **behaviour(rule or FALLBACK_NOTIFY, payload, entry)}
    except Exception:  # noqa: BLE001 - a notification is never lost to its decoration
        logger.warning("push_policy: decorating a push payload failed", exc_info=True)
        return payload


# ── Devices: this device, and "התראות בנייד" on the users list ─────────────


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    v = _aware(value)
    return v.isoformat() if v else None


def device_healthy(device: Any, now: datetime) -> bool:
    """
    Succeeded within the window — or registered within it and never failed (a new device has
    not had seven days yet) — and not failing over and over since.
    """
    if int(getattr(device, "failure_count", 0) or 0) >= HEALTH_FAILURES:
        return False
    success = _aware(getattr(device, "last_success_at", None))
    if success is not None:
        return now - success <= HEALTH_WINDOW
    created = _aware(getattr(device, "created_at", None))
    return created is not None and getattr(device, "last_failure_at", None) is None and now - created <= HEALTH_WINDOW


def health_tone(devices: Sequence[Any], now: datetime) -> str:
    """green / yellow (no success for 7 days) / red (no device)."""
    if not devices:
        return "red"
    return "green" if any(device_healthy(d, now) for d in devices) else "yellow"


def _health_of(devices: Sequence[Any], now: datetime) -> Dict[str, Any]:
    successes = [_aware(d.last_success_at) for d in devices if d.last_success_at is not None]
    failures = [_aware(d.last_failure_at) for d in devices if d.last_failure_at is not None]
    return {
        "devices": len(devices),
        "lastSuccessAt": _iso(max(successes)) if successes else None,
        "lastFailureAt": _iso(max(failures)) if failures else None,
        "tone": health_tone(devices, now),
    }


def active_devices(db: Session, user_ids: Iterable[Any]) -> Dict[uuid.UUID, List[Any]]:
    from app.models.exception_alerts import PushSubscription

    ids = [u for u in (_uuid(x) for x in user_ids) if u is not None]
    out: Dict[uuid.UUID, List[Any]] = {u: [] for u in ids}
    if not ids:
        return out
    rows = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id.in_(ids), PushSubscription.disabled_at.is_(None))
        .order_by(PushSubscription.created_at)
        .all()
    )
    for row in rows:
        out.setdefault(_uuid(row.user_id), []).append(row)
    return out


def health_for(db: Session, user_ids: Iterable[Any], *, now: Optional[datetime] = None) -> Dict[uuid.UUID, Dict[str, Any]]:
    """Per user: active devices, the last success / failure, and the tone."""
    now = now or datetime.now(timezone.utc)
    return {uid: _health_of(devices, now) for uid, devices in active_devices(db, user_ids).items()}


def attach_to_users(db: Session, users: Sequence[Any], tenant_id: Any, *, now: Optional[datetime] = None) -> None:
    """
    `GET /users`: each row gets `push_health` ({devices, lastSuccessAt, lastFailureAt, tone,
    required}) and `push_required` (the user's own level; None = inherit). Never fails the list.
    """
    try:
        health = health_for(db, [u.id for u in users], now=now)
    except Exception:  # noqa: BLE001
        logger.warning("push_policy: the users' devices could not be read", exc_info=True)
        return
    for u in users:
        try:
            item = dict(health.get(_uuid(u.id)) or _health_of([], now or datetime.now(timezone.utc)))
            item["required"] = resolve_required(db, u, tenant_id).mode
            u.push_health = item
            u.push_required = user_policy(u).get("required")
        except Exception:  # noqa: BLE001
            logger.warning("push_policy: one user's push health failed", exc_info=True)


def status_for(db: Session, user: Any, tenant_id: Any, endpoint_hash: Optional[str], *,
               now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /push/status`: what this user must have, and what this device and the others have."""
    from app.services import webpush

    now = now or datetime.now(timezone.utc)
    devices = active_devices(db, [user.id]).get(_uuid(user.id), [])
    summary = _health_of(devices, now)
    this = None
    wanted = (endpoint_hash or "").strip().lower()
    if wanted:
        this = next((d for d in devices if d.endpoint_hash == wanted), None)
    required = resolve_required(db, user, tenant_id)
    vapid = webpush.config()
    this_failing = bool(
        this is not None
        and this.last_failure_at is not None
        and (this.last_success_at is None or _aware(this.last_failure_at) > _aware(this.last_success_at))
    )
    return {
        **required.as_json(),
        "devices": summary["devices"],
        "lastSuccessAt": summary["lastSuccessAt"],
        "tone": summary["tone"],
        "thisDeviceRegistered": this is not None,
        "thisDevice": (
            {"lastSuccessAt": _iso(this.last_success_at), "lastFailureAt": _iso(this.last_failure_at),
             "failing": this_failing}
            if this is not None else None
        ),
        "configured": vapid is not None,
        "publicKey": vapid.public_key if vapid is not None else None,
    }


__all__ = [
    "MODES", "POLICY_KEY", "PolicyError", "Required", "attach_to_users", "behaviour", "catalogue_json",
    "clean_policy", "decorate", "default_required", "health_for", "health_tone", "resolve_notify",
    "resolve_required", "status_for",
]
