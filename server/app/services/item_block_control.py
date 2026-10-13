"""
"חסימות מהקופה" — which till may block what, and who releases (P:/specs/item-block-control.md §2, §3, §6).

**The setting.** One POS setting, `itemBlocks`, on any layer (tenant → company → shop → point of sale →
till, the later winning key by key — app/services/settings_merge.py merges a nested object shallowly):

    {"role": "managing" | "local" | "none",
     "localMaxLevel": "machine" | "area" | "shop",
     "localChannels": ["pos", "kiosk", "online", "menu"],     (a non-empty subset)
     "managingMaxLevel": "area" | "shop",
     "releaseMode": "own_scope" | "any_in_shop",
     "localRelease": bool,
     "quickDefaults": {"channels": [...], "level": "shop" | "company",
                       "duration": {"mode": "end_of_day" | "none" | "minutes", "minutes"?: int}}}

Nothing set: `role` is "managing" for the shop's main till (`mainTill`, app/services/main_till.py) and
"local" for every other till; area, ["pos"], shop, own_scope, true; the quick block's all four channels
at the shop until the end of the day. A till gets the first six, worked out here, as
`parameters.itemBlocks` in its parameters pull (`till_out`).

**What a till may write.** Its role caps the reach — a level (`machine`: the till itself; `area`: its
point of sale, or another device in it; `shop`: anything else of the shop — an event too) and the
channels:

* `none` — nothing;
* `local` — up to `localMaxLevel`, on `localChannels` only;
* `managing` — up to `managingMaxLevel`, on any channel.

On top of it the approver's permission (`X-Pos-User-Id`): ITEM_BLOCK within the local caps,
ITEM_BLOCK_WIDE beyond them. A kiosk's staff screen and a till acting for a kiosk it controls keep
today's rules (the kiosks only) — this module is for a till acting for itself.

**Who releases.** Never a company's block, another shop's or an automatic one (stock 0 — the stock or
the cloud lifts it). Otherwise, by the role: `managing` — anything up to `managingMaxLevel`; `local` (and
`none` while `localRelease` is on) — what it could write itself (`own_scope`), or anything of the shop
(`any_in_shop`). The approver's permission as for a write.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant

SETTINGS_KEY = "itemBlocks"

MANAGING, LOCAL, NONE = "managing", "local", "none"
ROLES = (MANAGING, LOCAL, NONE)
LOCAL_LEVELS = ("machine", "area", "shop")
MANAGING_LEVELS = ("area", "shop")
OWN_SCOPE, ANY_IN_SHOP = "own_scope", "any_in_shop"
RELEASE_MODES = (OWN_SCOPE, ANY_IN_SHOP)
CHANNELS = ("pos", "kiosk", "online", "menu")
QUICK_LEVELS = ("shop", "company")
QUICK_DURATION_MODES = ("end_of_day", "none", "minutes")

#: The six a till gets (§6), in the contract's order.
TILL_KEYS = ("role", "localMaxLevel", "localChannels", "managingMaxLevel", "releaseMode", "localRelease")
KEYS = TILL_KEYS + ("quickDefaults",)

DEFAULTS: Dict[str, Any] = {
    "localMaxLevel": "area",
    "localChannels": ["pos"],
    "managingMaxLevel": "shop",
    "releaseMode": OWN_SCOPE,
    "localRelease": True,
}
QUICK_DEFAULTS: Dict[str, Any] = {
    "channels": list(CHANNELS),
    "level": "shop",
    "duration": {"mode": "end_of_day"},
}

#: Where a value came from: a layer, the main till (`role` only) or the default.
SOURCE_MAIN_TILL = "main_till"
SOURCE_DEFAULT = "default"

RANK = {"machine": 0, "area": 1, "shop": 2}
#: The permissions a till user needs: within the local caps, and beyond them.
NARROW, WIDE = "ITEM_BLOCK", "ITEM_BLOCK_WIDE"
#: A till user's state that refuses outright (app/services/till_permissions.py DENY).
DENY = "deny"

LEVEL_WORDS = {"machine": "הקופה הזו", "area": "נקודת המכירה", "shop": "הסניף"}
CHANNEL_WORDS = {"pos": "קופות", "kiosk": "קיוסק", "online": "הזמנות אונליין", "menu": "תפריט דיגיטלי"}

#: The till's explanation instead of a "שחרר" it may not offer (§1).
HINT_CLOUD = "שחרור מהענן"
HINT_MANAGING = "שחרור מהקופה המנהלת / מהענן"


class ItemBlockSettingsError(ValueError):
    """A value of `itemBlocks` that is not one. The message is Hebrew, safe to show."""


# ── The setting, checked ─────────────────────────────────────────────────────


def _channels(value: Any, where: str) -> List[str]:
    if not isinstance(value, list) or not value:
        raise ItemBlockSettingsError(f"{where}: בחרו לפחות ערוץ אחד מתוך {', '.join(CHANNELS)}.")
    unknown = [c for c in value if c not in CHANNELS]
    if unknown:
        raise ItemBlockSettingsError(f"{where}: ערוץ לא מוכר \"{unknown[0]}\". אפשר רק: {', '.join(CHANNELS)}.")
    return [c for c in CHANNELS if c in value]


def _choice(value: Any, allowed: Sequence[str], where: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ItemBlockSettingsError(f"{where}: הערך \"{value}\" לא מוכר. אפשר רק: {', '.join(allowed)}.")
    return value


def clean_quick(value: Any) -> Dict[str, Any]:
    """`quickDefaults` as stored: every key present (a missing one is the default's)."""
    if not isinstance(value, dict):
        raise ItemBlockSettingsError("quickDefaults: צריך אובייקט עם channels, level ו-duration.")
    unknown = [k for k in value if k not in ("channels", "level", "duration")]
    if unknown:
        raise ItemBlockSettingsError(f"quickDefaults: שדה לא מוכר \"{unknown[0]}\".")
    out = copy.deepcopy(QUICK_DEFAULTS)
    if "channels" in value:
        out["channels"] = _channels(value["channels"], "quickDefaults.channels")
    if "level" in value:
        out["level"] = _choice(value["level"], QUICK_LEVELS, "quickDefaults.level")
    if "duration" in value:
        duration = value["duration"]
        if not isinstance(duration, dict):
            raise ItemBlockSettingsError("quickDefaults.duration: צריך אובייקט עם mode.")
        mode = _choice(duration.get("mode"), QUICK_DURATION_MODES, "quickDefaults.duration.mode")
        if mode == "minutes":
            from app.services import block_durations

            minutes = duration.get("minutes")
            if isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= block_durations.MAX_MINUTES:
                raise ItemBlockSettingsError(
                    f"quickDefaults.duration.minutes: מספר דקות שלם בין 1 ל-{block_durations.MAX_MINUTES}."
                )
            out["duration"] = {"mode": mode, "minutes": minutes}
        else:
            out["duration"] = {"mode": mode}
    return out


def clean(value: Any) -> Optional[Dict[str, Any]]:
    """
    One layer's own `itemBlocks` as stored, or None for nothing of its own (null or `{}`).
    Unknown keys and values are refused (ItemBlockSettingsError), a null key is dropped (it inherits).
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ItemBlockSettingsError("itemBlocks: צריך אובייקט.")
    unknown = [k for k in value if k not in KEYS]
    if unknown:
        raise ItemBlockSettingsError(f"itemBlocks: שדה לא מוכר \"{unknown[0]}\". השדות: {', '.join(KEYS)}.")
    out: Dict[str, Any] = {}
    for key, raw in value.items():
        if raw is None:
            continue
        if key == "role":
            out[key] = _choice(raw, ROLES, "role")
        elif key == "localMaxLevel":
            out[key] = _choice(raw, LOCAL_LEVELS, "localMaxLevel")
        elif key == "localChannels":
            out[key] = _channels(raw, "localChannels")
        elif key == "managingMaxLevel":
            out[key] = _choice(raw, MANAGING_LEVELS, "managingMaxLevel")
        elif key == "releaseMode":
            out[key] = _choice(raw, RELEASE_MODES, "releaseMode")
        elif key == "localRelease":
            if not isinstance(raw, bool):
                raise ItemBlockSettingsError("localRelease: true או false.")
            out[key] = raw
        else:
            out[key] = clean_quick(raw)
    return out or None


def own_of(settings: Any) -> Dict[str, Any]:
    """The layer's own values, read leniently: what does not check out is left out (it inherits)."""
    raw = settings.get(SETTINGS_KEY) if isinstance(settings, dict) else None
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    for key, value in raw.items():
        try:
            cleaned = clean({key: value})
        except ItemBlockSettingsError:
            continue
        if cleaned:
            out.update(cleaned)
    return out


# ── The layers ───────────────────────────────────────────────────────────────

#: A level and its stored settings, least specific first.
Layer = Tuple[str, Any]


def _settings(entity: Any) -> Any:
    return getattr(entity, "settings", None) if entity is not None else None


def layers_above_shop(db: Session, shop: Optional[Shop]) -> List[Layer]:
    if shop is None:
        return []
    company = db.get(Company, shop.company_id) if shop.company_id else None
    tenant = db.get(Tenant, company.tenant_id) if company is not None and company.tenant_id else None
    tenant = tenant or (db.get(Tenant, shop.tenant_id) if shop.tenant_id else None)
    return [("tenant", _settings(tenant)), ("company", _settings(company))]


def layers_for_machine(db: Session, machine: POSMachine) -> List[Layer]:
    """Tenant, company, shop, point of sale and the till itself."""
    from app.models.shop_area import ShopArea

    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    area = db.get(ShopArea, machine.area_id) if getattr(machine, "area_id", None) else None
    return layers_above_shop(db, shop) + [
        ("shop", _settings(shop)),
        ("area", _settings(area)),
        ("machine", getattr(machine, "settings", None)),
    ]


def merged(layers: Iterable[Layer]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """`(values, sources)`: per key the most specific layer's value, and that layer's name."""
    values: Dict[str, Any] = {}
    sources: Dict[str, str] = {}
    for level, settings in layers:
        for key, value in own_of(settings).items():
            values[key] = value
            sources[key] = level
    return values, sources


# ── One till's rules ─────────────────────────────────────────────────────────


@dataclass
class TillRules:
    role: str
    local_max_level: str = DEFAULTS["localMaxLevel"]
    local_channels: Tuple[str, ...] = tuple(DEFAULTS["localChannels"])
    managing_max_level: str = DEFAULTS["managingMaxLevel"]
    release_mode: str = DEFAULTS["releaseMode"]
    local_release: bool = DEFAULTS["localRelease"]
    #: Per key: the layer, "main_till" (role) or "default".
    sources: Dict[str, str] = field(default_factory=dict)

    def out(self) -> Dict[str, Any]:
        """`parameters.itemBlocks` (§6): the six, always all of them."""
        return {
            "role": self.role,
            "localMaxLevel": self.local_max_level,
            "localChannels": list(self.local_channels),
            "managingMaxLevel": self.managing_max_level,
            "releaseMode": self.release_mode,
            "localRelease": self.local_release,
        }


def rules_of(values: Dict[str, Any], sources: Dict[str, str], *, is_main_till: bool) -> TillRules:
    """The rules from merged values; `role` unset: managing for the main till, else local."""
    srcs = dict(sources)
    role = values.get("role")
    if role is None:
        role = MANAGING if is_main_till else LOCAL
        srcs["role"] = SOURCE_MAIN_TILL if is_main_till else SOURCE_DEFAULT
    for key in TILL_KEYS[1:]:
        srcs.setdefault(key, SOURCE_DEFAULT)
    return TillRules(
        role=role,
        local_max_level=values.get("localMaxLevel", DEFAULTS["localMaxLevel"]),
        local_channels=tuple(values.get("localChannels", DEFAULTS["localChannels"])),
        managing_max_level=values.get("managingMaxLevel", DEFAULTS["managingMaxLevel"]),
        release_mode=values.get("releaseMode", DEFAULTS["releaseMode"]),
        local_release=values.get("localRelease", DEFAULTS["localRelease"]),
        sources={k: srcs[k] for k in TILL_KEYS},
    )


def is_main_till(db: Session, machine: POSMachine, parameters: Optional[Dict[str, Any]] = None) -> bool:
    """Whether the till is its shop's main till. `parameters`: its resolved till parameters, if at hand."""
    from app.services import main_till

    if machine.shop_id is None:
        return False
    if parameters is None:
        from app.services.till_parameters import till_parameters_for_machine

        parameters = till_parameters_for_machine(db, machine).parameters
    if not main_till.is_on(parameters.get(main_till.MAIN_TILL_KEY)):
        return False  # not marked: never the main till — and no need to look at the shop's others
    main = main_till.main_till_of_shop(db, machine.shop_id)
    return main is not None and str(main.id) == str(machine.id)


def rules_for_machine(
    db: Session, machine: POSMachine, *, parameters: Optional[Dict[str, Any]] = None, main_till_id: Any = ...,
) -> TillRules:
    """This till's rules. `main_till_id`: the shop's main till's id (None: none), when already known."""
    values, sources = merged(layers_for_machine(db, machine))
    if "role" in values:
        main = False  # set at some level: the main till does not matter
    elif main_till_id is not ...:
        main = main_till_id is not None and str(main_till_id) == str(machine.id)
    else:
        main = is_main_till(db, machine, parameters)
    return rules_of(values, sources, is_main_till=main)


def till_out(db: Session, machine: POSMachine, parameters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """`parameters.itemBlocks` for the till's parameters pull."""
    return rules_for_machine(db, machine, parameters=parameters).out()


def quick_defaults_for_shop(db: Session, shop: Shop) -> Dict[str, Any]:
    """The dashboard's quick block (§4): the shop's `quickDefaults`, else its company's / tenant's, else the default."""
    values, _ = merged(layers_above_shop(db, shop) + [("shop", _settings(shop))])
    return copy.deepcopy(values.get("quickDefaults") or QUICK_DEFAULTS)


# ── What a till may write and release ────────────────────────────────────────


@dataclass(frozen=True)
class Verdict:
    ok: bool
    #: The approver's permission it needs (ITEM_BLOCK / ITEM_BLOCK_WIDE) when `ok`.
    needs: Optional[str] = None
    #: Why not (Hebrew) when not `ok`.
    message: Optional[str] = None


def _words(channels: Iterable[str]) -> str:
    return ", ".join(CHANNEL_WORDS.get(c, c) for c in CHANNELS if c in set(channels))


def local_caps_rank(rules: TillRules, home: POSMachine) -> int:
    """How far the local caps reach: a till with no point of sale stops at itself for "area"."""
    rank = RANK[rules.local_max_level]
    if rank == RANK["area"] and getattr(home, "area_id", None) is None:
        return RANK["machine"]
    return rank


def within_local(rules: TillRules, home: POSMachine, level: str, channels: Iterable[str]) -> bool:
    return RANK[level] <= local_caps_rank(rules, home) and set(channels) <= set(rules.local_channels)


def write_verdict(rules: TillRules, home: POSMachine, level: str, channels: Sequence[str]) -> Verdict:
    """May this till write a block reaching `level` ("machine" / "area" / "shop") on `channels`?"""
    local_ok = within_local(rules, home, level, channels)
    if rules.role == NONE:
        return Verdict(False, message="הקופה הזו לא מורשית לחסום פריטים. חוסמים מהקופה המנהלת או מהענן.")
    if rules.role == LOCAL:
        if local_ok:
            return Verdict(True, NARROW)
        reach = LEVEL_WORDS["machine" if local_caps_rank(rules, home) == 0 else rules.local_max_level]
        return Verdict(
            False,
            message=(
                f"מהקופה הזו אפשר לחסום רק ב{_words(rules.local_channels)}, עד {reach}. "
                "חסימה רחבה יותר — מהקופה המנהלת או מהענן."
            ),
        )
    if RANK[level] > RANK[rules.managing_max_level]:
        return Verdict(False, message=f"מהקופה הזו אפשר לחסום עד {LEVEL_WORDS[rules.managing_max_level]}.")
    return Verdict(True, NARROW if local_ok else WIDE)


def release_verdict(rules: TillRules, home: POSMachine, level: str, channels: Sequence[str]) -> Verdict:
    """May this till release a (hand, own shop's) block reaching `level` on `channels`?"""
    local_ok = within_local(rules, home, level, channels)
    needs = NARROW if local_ok else WIDE
    if rules.role == MANAGING:
        if RANK[level] <= RANK[rules.managing_max_level]:
            return Verdict(True, needs)
        return Verdict(False, message=HINT_MANAGING)
    if rules.role == NONE and not rules.local_release:
        return Verdict(False, message=HINT_MANAGING)
    if rules.release_mode == ANY_IN_SHOP or local_ok:
        return Verdict(True, needs)
    return Verdict(False, message=HINT_MANAGING)


def target_level(home: POSMachine, scope: str, scope_id: Any, device_area_id: Any = None) -> Optional[str]:
    """
    How far a level reaches from this till: "machine" (itself), "area" (its point of sale, or another
    device standing in it), "shop" (anything else of the shop: the shop, another point of sale, an event,
    a group); None for the company (no till goes there).
    """
    sid = str(scope_id) if scope_id is not None else None
    home_area = str(home.area_id) if getattr(home, "area_id", None) else None
    if scope in ("machine", "kiosk"):
        if sid == str(home.id):
            return "machine"
        if home_area is not None and device_area_id is not None and str(device_area_id) == home_area:
            return "area"
        return "shop"
    if scope == "area":
        return "area" if home_area is not None and sid == home_area else "shop"
    if scope == "company":
        return None
    return "shop"


def mark_level(db: Session, home: POSMachine, mark: Any) -> Optional[str]:
    """`target_level` of a block (a device's block: where that device stands)."""
    from app.services import sold_out as svc

    level = svc.level_of(mark)
    device_area = None
    if level == "machine" and str(mark.scope_id) != str(home.id):
        device = db.get(POSMachine, mark.scope_id)
        device_area = getattr(device, "area_id", None) if device is not None else None
    if level == "group" and mark.shop_id is None:
        return None
    return target_level(home, level, mark.scope_id, device_area)


def permission_state(pos_user: Any, code: str) -> str:
    """The till user's state for `code`: allow / approval / deny."""
    from app.services.till_roles import effective_for_pos_user

    return effective_for_pos_user(pos_user).state(code)


def allowed_out(rules: TillRules, home: POSMachine) -> Dict[str, Any]:
    """What the till's block sheet offers (§8.3): the levels and channels, and the narrow part of them."""
    levels = ["machine"] + (["area"] if getattr(home, "area_id", None) else []) + ["shop", "event"]

    def rank(level: str) -> int:
        return RANK["shop" if level == "event" else level]

    local_levels = [lv for lv in levels if rank(lv) <= local_caps_rank(rules, home)]
    if rules.role == NONE:
        allowed_levels, allowed_channels = [], []
    elif rules.role == LOCAL:
        allowed_levels, allowed_channels = local_levels, list(rules.local_channels)
    else:
        allowed_levels = [lv for lv in levels if rank(lv) <= RANK[rules.managing_max_level]]
        allowed_channels = list(CHANNELS)
    narrow_levels = [lv for lv in local_levels if lv in allowed_levels]
    narrow_channels = [c for c in rules.local_channels if c in allowed_channels]
    default_level = None
    if allowed_levels:
        default_level = "area" if "area" in narrow_levels else (narrow_levels or allowed_levels)[0]
    return {
        "levels": allowed_levels,
        "channels": allowed_channels,
        "localLevels": narrow_levels,
        "localChannels": narrow_channels,
        "defaults": (
            {"level": default_level, "channels": narrow_channels or allowed_channels[:1]}
            if allowed_levels else None
        ),
    }
