"""
"תצורת עבודה לעמדה" — `workflow_mode` and the fulfillment targets of a till
(docs/SPEC_KDS.md §1; owner's spec "החלטה אחרונה וקובעת").

**Where it is stored.** In the till parameters (app/services/till_parameters.py): one
built-in parameter per field, set at company → shop → point of sale → till, the most
specific level winning — the layers every till already syncs (`param.<key>` on the
till), so no second settings system. The dashboard edits them on the "תצורת עבודה"
card only (`managed_on` → "workflow"); the generic parameters page leaves them out.

**The two modes.** DIRECT_SALE ("מכירה במקום"): choose → pay → documents / ticket →
hand over; no preparation state, no ready message. ORDER_PROCESS ("תהליך הזמנה"):
released to the kitchen by the payment policy → queued → preparing → ready → handed
over. BON / KDS are profiles (presets) only, never the setting itself.

**Off by default.** `kdsEnabled` false (the default) is the legacy behaviour whatever
the other fields say: DIRECT_SALE with the printer, exactly as before.

**Validation (§7)** — `validate()` refuses a contradictory configuration on save
(errors) and explains redundant ones (warnings); `normalize()` applies the same rules
at run time, coercing whatever was stored some other way (the generic parameters API)
into something safe, so the engine never acts on an invalid combination.

**Version.** `config_version` is a short hash of the normalized configuration: the same
configuration has the same version everywhere, and an order locks the version (and the
whole configuration) it was released under.

Pure functions over plain dicts, except the `*_for_*` resolvers and `save_values`.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

DIRECT_SALE = "DIRECT_SALE"
ORDER_PROCESS = "ORDER_PROCESS"
MODES = (DIRECT_SALE, ORDER_PROCESS)

#: Fulfillment targets: the kitchen printers (as configured today), a KDS station screen,
#: a view-only KDS ("לצפייה בלבד": no mandatory step), the Expo and the pickup screen.
TARGETS = ("printer", "kds", "kds_view", "expo", "pickup_screen")
AFTER_PAYMENT = "AFTER_PAYMENT"
BEFORE_PAYMENT = "BEFORE_PAYMENT"
PAYMENT_POLICIES = (AFTER_PAYMENT, BEFORE_PAYMENT)
SOURCES = ("POS", "HANDHELD", "KIOSK")
INACTIVITY_MIN = 15
INACTIVITY_MAX = 3600

#: field → till parameter key.
PARAM_KEYS: Dict[str, str] = {
    "enabled": "kdsEnabled",
    "defaultMode": "workflowMode",
    "allowedModes": "workflowAllowedModes",
    "workerCanSwitch": "workflowWorkerCanSwitch",
    "targets": "workflowTargets",
    "paymentPolicy": "workflowPaymentPolicy",
    "requireStartPreparation": "workflowRequireStart",
    "requireExpo": "workflowRequireExpo",
    "trackHandover": "workflowTrackHandover",
    "readyNotification": "workflowReadyNotification",
    "printerFallback": "workflowPrinterFallback",
    "source": "workflowSource",
    "inactivityTable": "inactivityTableSeconds",
    "inactivityQuick": "inactivityQuickSeconds",
    "inactivityKiosk": "inactivityKioskSeconds",
}
FIELD_OF: Dict[str, str] = {v: k for k, v in PARAM_KEYS.items()}
#: Set on a till by the KDS screens page (app/services/kds.py `save_device`), not by the card.
KDS_SCREEN_KEY = "kdsScreen"
WORKFLOW_KEYS = tuple(PARAM_KEYS.values()) + (KDS_SCREEN_KEY,)

DEFAULTS: Dict[str, Any] = {
    "enabled": False,
    "defaultMode": DIRECT_SALE,
    "allowedModes": [DIRECT_SALE],
    "workerCanSwitch": False,
    "targets": ["printer"],
    "paymentPolicy": AFTER_PAYMENT,
    "requireStartPreparation": False,
    "requireExpo": False,
    "trackHandover": True,
    "readyNotification": False,
    "printerFallback": True,
    "source": "POS",
    "inactivityTable": None,
    "inactivityQuick": None,
    "inactivityKiosk": None,
}

#: The built-in till parameters (registered by app/services/till_parameters.py). Plain
#: dicts, so that module can import this one without a cycle.
WORKFLOW_PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key="kdsEnabled", label="תצורת עבודה ו-KDS — הפעלה", value_type="boolean", default_value=False,
        description=(
            "כבוי (ברירת מחדל): הקופה עובדת כמו היום — מכירה במקום ובונים במדפסות לפי הניתוב. "
            "מופעל: חלה תצורת העבודה שנקבעה בכרטיס \"תצורת עבודה\" (מכירה במקום / תהליך הזמנה, KDS, Expo, מסך איסוף)."
        ),
    ),
    dict(
        key="workflowMode", label="תצורת עבודה — ברירת מחדל", value_type="enum",
        enum_options=MODES, default_value=DIRECT_SALE,
        description=(
            "DIRECT_SALE — מכירה במקום: הזמנה ותשלום, הפקת בון, ללא מעקב הכנה. "
            "ORDER_PROCESS — תהליך הזמנה: ניהול הכנה, מוכנות ומסירה לאחר יצירת ההזמנה."
        ),
    ),
    dict(
        key="workflowAllowedModes", label="תצורת עבודה — מצבים מותרים", value_type="string",
        default_value=DIRECT_SALE, description="המצבים המותרים בעמדה, מופרדים בפסיק (DIRECT_SALE,ORDER_PROCESS).",
    ),
    dict(
        key="workflowWorkerCanSwitch", label="תצורת עבודה — עובד יכול להחליף מצב", value_type="boolean",
        default_value=False,
        description="עובד מורשה יכול להחליף מצב להזמנה לפני שליחה/תשלום (נרשם). רק כשמותרים שני מצבים.",
    ),
    dict(
        key="workflowTargets", label="תצורת עבודה — יעדים", value_type="string", default_value="printer",
        description="יעדי ההכנה, מופרדים בפסיק: printer, kds, kds_view, expo, pickup_screen.",
    ),
    dict(
        key="workflowPaymentPolicy", label="תצורת עבודה — שחרור למטבח", value_type="enum",
        enum_options=PAYMENT_POLICIES, default_value=AFTER_PAYMENT,
        description=(
            "הזמנה מהירה: AFTER_PAYMENT — משתחררת למטבח אחרי התשלום; BEFORE_PAYMENT — ב\"שלח למטבח\" לפני התשלום. "
            "שולחן משתחרר תמיד בשליחת המלצר; קיוסק תמיד אחרי תשלום."
        ),
    ),
    dict(
        key="workflowRequireStart", label="תצורת עבודה — חובה \"התחל הכנה\"", value_type="boolean",
        default_value=False, description="תהליך הזמנה: לא ניתן לסמן פריט מוכן לפני שהתחילו להכין אותו.",
    ),
    dict(
        key="workflowRequireExpo", label="תצורת עבודה — מוכנות דרך Expo", value_type="boolean",
        default_value=False,
        description="תהליך הזמנה: \"מוכן לאיסוף\" נקבע רק ב-Expo אחרי שכל התחנות סיימו. כבוי — אוטומטית כשהכול מוכן.",
    ),
    dict(
        key="workflowTrackHandover", label="תצורת עבודה — מעקב מסירה", value_type="boolean",
        default_value=True, description="תהליך הזמנה: הזמנה מוכנה נשארת עד שמסמנים \"נמסר\".",
    ),
    dict(
        key="workflowReadyNotification", label="תצורת עבודה — הודעת מוכנות (SMS)", value_type="boolean",
        default_value=False,
        description="תהליך הזמנה בלבד: אירוע \"מוכן לאיסוף\" נשלח לשירות ההודעות. לעולם לא ממכירה במקום ולא מהדפסה.",
    ),
    dict(
        key="workflowPrinterFallback", label="תצורת עבודה — מדפסת גיבוי ל-KDS", value_type="boolean",
        default_value=True,
        description="כשה-KDS לא זמין, הקופה מדפיסה את הבון במדפסות התחנות ומסמנת אותו; ב-KDS הוא מוצג להתאמה ולא כהזמנה חדשה.",
    ),
    dict(
        key="workflowSource", label="תצורת עבודה — סוג עמדה", value_type="enum", enum_options=SOURCES,
        default_value="POS", description="POS — קופה, HANDHELD — מסופון, KIOSK — קיוסק.",
    ),
    dict(
        key="kdsScreen", label="מסך מטבח (KDS) בקופה זו", value_type="boolean", default_value=False,
        description=(
            "נקבע אוטומטית כשמשייכים את הקופה כמסך KDS בדף \"מסכי מטבח\" (לא לעריכה ידנית): הקופה מציגה "
            "את מסך התחנה / Expo / מסך האיסוף במקום מסך הכניסה."
        ),
    ),
    dict(
        key="inactivityTableSeconds", label="חוסר פעילות — שולחן (שניות)", value_type="integer",
        default_value=None, description="חזרה למפה אחרי חוסר פעילות, הטיוטה נשמרת ולא נשלחת. ריק — כבוי.",
    ),
    dict(
        key="inactivityQuickSeconds", label="חוסר פעילות — הזמנה מהירה (שניות)", value_type="integer",
        default_value=None, description="חזרה למסך ההזמנה החדשה אחרי חוסר פעילות, לא בזמן תשלום. ריק — כבוי.",
    ),
    dict(
        key="inactivityKioskSeconds", label="חוסר פעילות — קיוסק (שניות)", value_type="integer",
        default_value=None, description="איפוס הקיוסק אחרי חוסר פעילות (עם התראה), לא בזמן תשלום. ריק — כבוי.",
    ),
)

#: Ready-made profiles (§5): BON / KDS are presets, not the setting.
PROFILES: Dict[str, Dict[str, Any]] = {
    "kiosk_bon": {
        "source": "KIOSK", "defaultMode": DIRECT_SALE, "allowedModes": [DIRECT_SALE], "targets": ["printer"],
        "paymentPolicy": AFTER_PAYMENT, "readyNotification": False, "requireExpo": False,
    },
    "kiosk_kds": {
        "source": "KIOSK", "defaultMode": ORDER_PROCESS, "allowedModes": [ORDER_PROCESS],
        "targets": ["kds", "pickup_screen"], "paymentPolicy": AFTER_PAYMENT, "trackHandover": True,
    },
    "counter": {
        "source": "POS", "defaultMode": DIRECT_SALE, "allowedModes": [DIRECT_SALE], "targets": ["printer"],
        "readyNotification": False, "requireExpo": False,
    },
    "counter_prep": {
        "source": "POS", "defaultMode": ORDER_PROCESS, "allowedModes": [ORDER_PROCESS],
        "targets": ["printer", "kds", "pickup_screen"], "trackHandover": True,
    },
    "handheld_tables": {
        "source": "HANDHELD", "defaultMode": ORDER_PROCESS, "allowedModes": [ORDER_PROCESS],
        "targets": ["printer", "kds"],
    },
}

#: The steps each mode shows in the preview ("תצוגת שלבים").
STEPS = {
    DIRECT_SALE: ["select", "pay", "documents", "handover"],
    ORDER_PROCESS: ["select", "release", "queued", "preparing", "ready", "handed_over"],
}


# ── Parsing ─────────────────────────────────────────────────────────────────────


def _csv(value: Any) -> List[str]:
    if isinstance(value, (list, tuple)):
        items = [str(v) for v in value]
    elif isinstance(value, str):
        items = value.split(",")
    else:
        return []
    out: List[str] = []
    for item in items:
        item = item.strip()
        if item and item not in out:
            out.append(item)
    return out


def _bool(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)) and float(value).is_integer():
        return int(value)
    return None


def from_parameters(params: Dict[str, Any]) -> Dict[str, Any]:
    """The raw configuration from a till's resolved parameters (missing → default)."""
    raw: Dict[str, Any] = {}
    for field, key in PARAM_KEYS.items():
        raw[field] = params.get(key, DEFAULTS[field])
    raw["allowedModes"] = _csv(raw["allowedModes"])
    raw["targets"] = _csv(raw["targets"])
    for field in ("inactivityTable", "inactivityQuick", "inactivityKiosk"):
        raw[field] = _int(raw[field])
    return raw


def to_parameter_value(field: str, value: Any) -> Any:
    """A field as its till parameter stores it (lists as CSV)."""
    if value is None:
        return None
    if field in ("allowedModes", "targets"):
        return ",".join(_csv(value))
    return value


# ── Validation and normalization ────────────────────────────────────────────────


def _issue(code: str, field: Optional[str] = None) -> Dict[str, Any]:
    return {"code": code, "field": field}


def validate(
    raw: Dict[str, Any],
    devices: Optional[Dict[str, int]] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    (errors, warnings) for a configuration (§7). `devices`: the active KDS devices of the
    shop the configuration applies to, by role — None at company level, where no shop's
    devices are known (those rules are then warnings, checked again per shop).
    """
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    enabled = raw.get("enabled") is True
    default_mode = raw.get("defaultMode")
    allowed = _csv(raw.get("allowedModes"))
    targets = _csv(raw.get("targets"))

    if default_mode not in MODES:
        errors.append(_issue("unknown_mode", "defaultMode"))
    if not allowed:
        errors.append(_issue("allowed_modes_empty", "allowedModes"))
    for mode in allowed:
        if mode not in MODES:
            errors.append(_issue("unknown_mode", "allowedModes"))
    if default_mode in MODES and allowed and default_mode not in allowed:
        errors.append(_issue("default_mode_not_allowed", "defaultMode"))
    if not targets:
        errors.append(_issue("targets_empty", "targets"))
    for target in targets:
        if target not in TARGETS:
            errors.append(_issue("unknown_target", "targets"))
    if raw.get("paymentPolicy") not in PAYMENT_POLICIES:
        errors.append(_issue("unknown_payment_policy", "paymentPolicy"))
    if raw.get("source") not in SOURCES:
        errors.append(_issue("unknown_source", "source"))
    for field in ("inactivityTable", "inactivityQuick", "inactivityKiosk"):
        seconds = raw.get(field)
        # 0 = off here (overrides a timer set above); otherwise 15..3600 seconds.
        if seconds is not None and seconds != 0 and (
            not isinstance(seconds, int) or not INACTIVITY_MIN <= seconds <= INACTIVITY_MAX
        ):
            errors.append(_issue("inactivity_out_of_range", field))

    process = ORDER_PROCESS in allowed
    ready_source = "kds" in targets or "expo" in targets
    if raw.get("readyNotification") is True:
        if not process:
            errors.append(_issue("ready_notification_requires_order_process", "readyNotification"))
        elif not ready_source:
            errors.append(_issue("ready_notification_requires_ready_source", "readyNotification"))
    if "pickup_screen" in targets:
        if not process:
            errors.append(_issue("pickup_screen_requires_order_process", "targets"))
        elif not ready_source:
            errors.append(_issue("pickup_screen_requires_managed_state", "targets"))
    if raw.get("requireExpo") is True:
        if not process:
            errors.append(_issue("order_process_field_in_direct_sale", "requireExpo"))
        elif "expo" not in targets:
            errors.append(_issue("require_expo_requires_expo_target", "requireExpo"))
    if raw.get("requireStartPreparation") is True and not process:
        errors.append(_issue("order_process_field_in_direct_sale", "requireStartPreparation"))
    if raw.get("source") == "KIOSK" and raw.get("paymentPolicy") == BEFORE_PAYMENT:
        errors.append(_issue("kiosk_releases_after_payment", "paymentPolicy"))
    if raw.get("workerCanSwitch") is True and len([m for m in allowed if m in MODES]) < 2:
        warnings.append(_issue("switch_needs_two_modes", "workerCanSwitch"))
    if "kds" in targets and not process:
        warnings.append(_issue("kds_view_only_in_direct_sale", "targets"))
    if targets == ["printer"] and process:
        warnings.append(_issue("process_managed_at_till", "targets"))

    # Destinations that must exist (an active screen of that kind in the shop).
    if devices is not None:
        if "kds" in targets and process and devices.get("station", 0) == 0:
            errors.append(_issue("kds_target_without_device", "targets"))
        if "expo" in targets and devices.get("expo", 0) == 0:
            (errors if raw.get("requireExpo") is True else warnings).append(
                _issue("expo_target_without_device", "targets")
            )
        if "pickup_screen" in targets and devices.get("pickup", 0) == 0:
            warnings.append(_issue("pickup_screen_without_device", "targets"))
    else:
        if "kds" in targets or "expo" in targets:
            warnings.append(_issue("devices_checked_per_shop", "targets"))

    if not enabled:
        # Off: nothing applies — only a malformed value is worth refusing.
        errors = [e for e in errors if e["code"] in ("unknown_mode", "unknown_target", "inactivity_out_of_range")]
        warnings = []
    return errors, warnings


def normalize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    The configuration the engine and the tills act on: every rule of `validate` applied
    by coercion (never refused — a stored value may predate a rule), and the legacy
    configuration when the feature is off.
    """
    if raw.get("enabled") is not True:
        legacy = dict(DEFAULTS)
        legacy["allowedModes"] = list(DEFAULTS["allowedModes"])
        legacy["targets"] = list(DEFAULTS["targets"])
        legacy["inactivityTable"] = _int(raw.get("inactivityTable"))
        legacy["inactivityQuick"] = _int(raw.get("inactivityQuick"))
        legacy["inactivityKiosk"] = _int(raw.get("inactivityKiosk"))
        return legacy
    allowed = [m for m in _csv(raw.get("allowedModes")) if m in MODES]
    default_mode = raw.get("defaultMode") if raw.get("defaultMode") in MODES else (allowed[0] if allowed else DIRECT_SALE)
    if default_mode not in allowed:
        allowed = [default_mode] + allowed
    allowed = [m for m in MODES if m in allowed]
    targets = [t for t in _csv(raw.get("targets")) if t in TARGETS] or ["printer"]
    process = ORDER_PROCESS in allowed
    ready_source = "kds" in targets or "expo" in targets
    if "pickup_screen" in targets and not (process and ready_source):
        targets = [t for t in targets if t != "pickup_screen"]
    source = raw.get("source") if raw.get("source") in SOURCES else "POS"
    policy = raw.get("paymentPolicy") if raw.get("paymentPolicy") in PAYMENT_POLICIES else AFTER_PAYMENT
    if source == "KIOSK":
        policy = AFTER_PAYMENT

    def seconds(field: str) -> Optional[int]:
        value = _int(raw.get(field))
        return value if value is not None and INACTIVITY_MIN <= value <= INACTIVITY_MAX else None

    return {
        "enabled": True,
        "defaultMode": default_mode,
        "allowedModes": allowed,
        "workerCanSwitch": _bool(raw.get("workerCanSwitch"), False) and len(allowed) > 1,
        "targets": [t for t in TARGETS if t in targets],
        "paymentPolicy": policy,
        "requireStartPreparation": process and _bool(raw.get("requireStartPreparation"), False),
        "requireExpo": process and "expo" in targets and _bool(raw.get("requireExpo"), False),
        "trackHandover": _bool(raw.get("trackHandover"), True),
        "readyNotification": process and ready_source and _bool(raw.get("readyNotification"), False),
        "printerFallback": _bool(raw.get("printerFallback"), True),
        "source": source,
        "inactivityTable": seconds("inactivityTable"),
        "inactivityQuick": seconds("inactivityQuick"),
        "inactivityKiosk": seconds("inactivityKiosk"),
    }


def config_version(config: Dict[str, Any]) -> str:
    """A short, stable hash of a normalized configuration."""
    raw = json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def mode_rules(config: Dict[str, Any], mode: str) -> Dict[str, Any]:
    """
    What an order in `mode` gets under `config` (§2, §3, §7): whether KDS tasks exist at
    all, whether they are view-only, and whether the ready event may be emitted.
    DIRECT_SALE never manages preparation: a KDS there is view-only, and with the
    printer only no task is created at all.
    """
    targets = config.get("targets") or []
    kds = "kds" in targets or "kds_view" in targets or "expo" in targets
    if mode == DIRECT_SALE:
        return {
            "createsTasks": "kds" in targets or "kds_view" in targets,
            "viewOnly": True,
            "readyEvent": False,
            "requireStart": False,
            "requireExpo": False,
            "trackHandover": False,
        }
    return {
        # ORDER_PROCESS always tracks its lifecycle: with a printer only, the process is
        # managed at the till / Expo view.
        "createsTasks": True,
        "viewOnly": False,
        "readyEvent": True,
        "requireStart": bool(config.get("requireStartPreparation")),
        "requireExpo": bool(config.get("requireExpo")),
        "trackHandover": bool(config.get("trackHandover", True)),
        "kds": kds,
    }


def profile_of(config: Dict[str, Any]) -> Optional[str]:
    """The preset this configuration is, if it is one."""
    if not config.get("enabled"):
        return None
    for name, preset in PROFILES.items():
        if all(config.get(k) == (list(v) if isinstance(v, list) else v) for k, v in preset.items()):
            return name
    return None


def describe(config: Dict[str, Any]) -> Dict[str, Any]:
    """The normalized configuration with what the dashboard / tills derive from it."""
    out = dict(config)
    out["configVersion"] = config_version(config)
    out["profile"] = profile_of(config)
    out["steps"] = {mode: STEPS[mode] for mode in config.get("allowedModes", [])}
    if config.get("source") == "KIOSK":
        out["kioskFulfillmentMode"] = "KDS" if config.get("defaultMode") == ORDER_PROCESS else "BON"
    return out


def resolve_mode(config: Dict[str, Any], requested: Optional[str]) -> Tuple[str, bool]:
    """
    The mode an order runs in: the configuration's default, or `requested` when the
    worker may switch and it is allowed. (mode, switched).
    """
    if requested and requested != config["defaultMode"]:
        if config.get("workerCanSwitch") and requested in config.get("allowedModes", []):
            return requested, True
    return config["defaultMode"], False


# ── Resolution for a till / a level (database) ──────────────────────────────────


def _parameters_on_chain(db, chain) -> Dict[str, Any]:
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters, resolve_till_parameters
    from sqlalchemy import and_, or_

    ensure_builtin_parameters(db)
    parameters = db.query(TillParameter).filter(TillParameter.key.in_(WORKFLOW_KEYS)).all()
    scopes = chain.scopes()
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident) for kind, ident in scopes
    ]
    values = db.query(TillParameterValue).filter(or_(*on_chain)).all() if on_chain else []
    return resolve_till_parameters(parameters, values, chain).parameters


def raw_for_machine(db, machine) -> Dict[str, Any]:
    from app.services.till_parameters import scope_chain_for_machine

    return from_parameters(_parameters_on_chain(db, scope_chain_for_machine(db, machine)))


def config_for_machine(db, machine) -> Dict[str, Any]:
    """The normalized configuration a till runs under now."""
    return normalize(raw_for_machine(db, machine))


def chain_for_scope(db, scope_type: str, scope_id: Any, *, above_only: bool = False):
    """
    The scope chain of a level (company, shop, area or till). `above_only`: its parents
    only — what the level inherits.
    """
    from fastapi import HTTPException, status

    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.services.till_parameters import TillScopeChain

    ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    if scope_type == "company":
        return TillScopeChain(machine_id=None, company_id=None if above_only else ident), None
    if scope_type == "shop":
        shop = db.query(Shop).filter(Shop.id == ident).first()
        if shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shop_not_found")
        return TillScopeChain(machine_id=None, shop_id=None if above_only else shop.id, company_id=shop.company_id), shop
    if scope_type == "area":
        area = db.query(ShopArea).filter(ShopArea.id == ident).first()
        if area is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="area_not_found")
        shop = db.query(Shop).filter(Shop.id == area.shop_id).first()
        return TillScopeChain(
            machine_id=None, area_id=None if above_only else area.id, shop_id=area.shop_id,
            company_id=shop.company_id if shop else None,
        ), shop
    if scope_type == "machine":
        machine = db.query(POSMachine).filter(POSMachine.id == ident).first()
        if machine is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="machine_not_found")
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
        return TillScopeChain(
            machine_id=None if above_only else machine.id, area_id=machine.area_id, shop_id=machine.shop_id,
            company_id=shop.company_id if shop else None,
        ), shop
    raise HTTPException(status_code=422, detail="bad_scope_type")


def values_at_scope(db, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """field → value set exactly at this level (not inherited)."""
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    rows = (
        db.query(TillParameter.key, TillParameterValue.value)
        .join(TillParameterValue, TillParameterValue.parameter_id == TillParameter.id)
        .filter(
            TillParameter.key.in_(WORKFLOW_KEYS),
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == ident,
        )
        .all()
    )
    out: Dict[str, Any] = {}
    for key, value in rows:
        field = FIELD_OF.get(key)
        if field is None:
            continue
        out[field] = _csv(value) if field in ("allowedModes", "targets") else value
    return out


def shop_device_counts(db, shop_id: Any) -> Dict[str, int]:
    from app.models.kds import KdsDevice

    if shop_id is None:
        return {}
    counts: Dict[str, int] = {}
    rows = db.query(KdsDevice.role).filter(KdsDevice.shop_id == shop_id, KdsDevice.is_active.is_(True)).all()
    for (role,) in rows:
        counts[role] = counts.get(role, 0) + 1
    return counts


def level_view(db, scope_type: str, scope_id: Any, pending: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    The card's data for a level: what is set here, what it inherits, the effective
    configuration (with `pending` changes applied — the preview before saving) and its
    validation.
    """
    chain, shop = chain_for_scope(db, scope_type, scope_id)
    above, _ = chain_for_scope(db, scope_type, scope_id, above_only=True)
    own = values_at_scope(db, scope_type, scope_id)
    inherited = from_parameters(_parameters_on_chain(db, above))
    effective_raw = from_parameters(_parameters_on_chain(db, chain))
    if pending:
        for field, value in pending.items():
            if field not in PARAM_KEYS:
                continue
            if value is None:
                effective_raw[field] = inherited.get(field, DEFAULTS[field])
            else:
                effective_raw[field] = _csv(value) if field in ("allowedModes", "targets") else value
    devices = shop_device_counts(db, shop.id) if shop is not None else None
    errors, warnings = validate(effective_raw, devices)
    effective = normalize(effective_raw)
    return {
        "scopeType": scope_type,
        "scopeId": str(scope_id),
        "shopId": str(shop.id) if shop is not None else None,
        "own": own,
        "inherited": inherited,
        "raw": effective_raw,
        "effective": describe(effective),
        "errors": errors,
        "warnings": warnings,
        "devices": devices,
        "profiles": PROFILES,
        "defaults": DEFAULTS,
    }


def save_values(db, scope_type: str, scope_id: Any, values: Dict[str, Any]) -> List[Tuple[str, str]]:
    """
    Writes `values` (field → value, None removes) at one level, after validating the
    effective result there (422 with the errors otherwise). Returns the tills to notify.
    """
    from datetime import datetime, timezone

    from fastapi import HTTPException, status

    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import (
        TillParameterValueError,
        ensure_builtin_parameters,
        notify_targets_for_scope,
        validate_value,
    )

    unknown = [f for f in values if f not in PARAM_KEYS]
    if unknown:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"unknown_field:{unknown[0]}")
    view = level_view(db, scope_type, scope_id, pending=values)
    if view["errors"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "workflow_invalid", "errors": view["errors"], "warnings": view["warnings"]},
        )
    ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(WORKFLOW_KEYS)).all()}
    ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    now = datetime.now(timezone.utc)
    for field, value in values.items():
        parameter = params.get(PARAM_KEYS[field])
        if parameter is None:
            continue
        stored = to_parameter_value(field, value)
        if stored is not None:
            try:
                stored = validate_value(parameter.value_type, stored, parameter.enum_options)
            except TillParameterValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid_value:{field}: {exc}"
                ) from exc
        row = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == scope_type,
                TillParameterValue.scope_id == ident,
            )
            .first()
        )
        if stored is None:
            if row is not None:
                db.delete(row)
                parameter.updated_at = now
        elif row is None:
            db.add(TillParameterValue(
                id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=ident, value=stored,
            ))
        else:
            row.value = stored
            row.updated_at = now
    db.flush()
    return notify_targets_for_scope(db, scope_type, ident)


def fields_of(values: Iterable[str]) -> Sequence[str]:
    return [v for v in values if v in PARAM_KEYS]
