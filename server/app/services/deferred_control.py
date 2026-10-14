"""
"מצב לא מקוון לכל המסופונים" — every card terminal of a shop to the deferred (offline) mode and back,
from one till or from the cloud (P:/specs/nayax-deferred-all.md; §8 is the contract — names, fields,
refusals — kept the one source for the till's side).

* **The parameters** (§1, §8.1): `deferredControlTills` — the tills that show the screen
  "מסופונים ברשת — מצב לא מקוון" (ids, comma separated, like `shopXTillIds`; empty: the feature is off
  in the whole shop), `deferredControlIncludeKiosks`, `deferredAutoOff` (ask | auto | never) with
  `deferredAutoOffMinutes`, `deferredAllowUnknownNayax`, and `deferredCommandTtlMin` — how long a
  command lives, on the LAN and in the cloud. Defaults change nothing.
* **The report** (§8.5 "דופק"): every beat of a till whose build says `deferred_control_v1` carries
  `deferredTerminal` — the LAN status's `terminal`, `offline`, `control`, `kiosk` and `at` — cleaned
  key by key (`clean_report`, never a 422) and kept in `device_info["deferredTerminal"]`.
* **Who is included** (§7, §8.2): the till's own word (`terminal.eligible` / `terminal.reason`) when it
  reported one; before that, what the cloud knows — a kiosk left out, the till's card integration
  ("ללא אשראי", Z-Credit, SynqPay, Tap to Pay), the shop's training mode — else `needs_update`. A till
  whose build cannot take the command is `needs_update` whatever it said.
* **The command** (§8.5): `terminal_offline`, a device command (app/services/device_commands.py) whose
  `params` are the LAN switch's body with `source: "cloud"` and the cloud's `issuedAt`; it lives
  `deferredCommandTtlMin` minutes and never reaches a till after that. The latest wins: a new one
  cancels the machine's open ones (`superseded`). The till acknowledges at once (`received`, not
  final), then answers `done` / `failed` / `refused` with the §8.3 result once its terminal was free.
* **The dashboard** (§9): the shop's tills with their terminal, mode, deferred count and the last
  command in the dashboard's words (`state`: pending | received | done | failed | cancelled), and one
  switch for all or per till (app/routers/deferred_terminals.py, section `terminals_offline`).
* **The controller's list** (§8.4): `GET /sync/{m}/deferred-control` — whether this till controls,
  the settings, and the shop's tills with where each listens on the LAN (its print-host report, else
  its `lanIp` on 8399), kept by the till for working without the internet.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

#: What a till's heartbeat says when its build takes the command and reports its terminal (§8.1).
CAPABILITY = "deferred_control_v1"
#: The device command (app/models/device_command.py DEVICE_ACTIONS).
ACTION = "terminal_offline"
#: Where the heartbeat's block is kept (`device_info`).
INFO_KEY = "deferredTerminal"
#: The dashboard section (app/services/dashboard_sections.py).
SECTION = "terminals_offline"
#: The till's permission and its phone approval (app/services/till_permissions.py, remote_approvals/catalog.py).
PERMISSION = "TERMINAL_OFFLINE_ALL"
APPROVAL_TYPE = "terminal_offline_all"
#: The till events of the log (app/services/exceptions.py TILL_EVENT_TYPES) — recorded, no rule.
EVENT_ON = "deferred_mode_on"
EVENT_OFF = "deferred_mode_off"
#: The LAN server's default port (the bons' and the tables' server, app/models/printers.py DEFAULT_LAN_PORT).
DEFAULT_LAN_PORT = 8399
#: What the command says it came from on the dashboard (§8.3 `from.name`).
DASHBOARD_NAME = "דשבורד"
SOURCE_CLOUD = "cloud"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


# ── The parameters (§1, §8.1) ─────────────────────────────────────────────────

TILLS_KEY = "deferredControlTills"
INCLUDE_KIOSKS_KEY = "deferredControlIncludeKiosks"
AUTO_OFF_KEY = "deferredAutoOff"
AUTO_OFF_MINUTES_KEY = "deferredAutoOffMinutes"
ALLOW_UNKNOWN_KEY = "deferredAllowUnknownNayax"
TTL_KEY = "deferredCommandTtlMin"

AUTO_OFF_ASK = "ask"
AUTO_OFF_AUTO = "auto"
AUTO_OFF_NEVER = "never"
AUTO_OFF_OPTIONS = (AUTO_OFF_ASK, AUTO_OFF_AUTO, AUTO_OFF_NEVER)
AUTO_OFF_LABELS = {
    AUTO_OFF_ASK: "לשאול בקופה המנהלת (ברירת מחדל)",
    AUTO_OFF_AUTO: "אוטומטית אחרי דקות של חיבור יציב",
    AUTO_OFF_NEVER: "רק ידנית",
}
AUTO_OFF_MINUTES_DEFAULT, AUTO_OFF_MINUTES_MIN, AUTO_OFF_MINUTES_MAX = 5, 1, 120
TTL_DEFAULT, TTL_MIN, TTL_MAX = 120, 5, 1440
#: The longest list of controlling tills a level names.
TILLS_MAX = 50

KEYS: Tuple[str, ...] = (TILLS_KEY, INCLUDE_KIOSKS_KEY, AUTO_OFF_KEY, AUTO_OFF_MINUTES_KEY, ALLOW_UNKNOWN_KEY, TTL_KEY)
#: Checked beyond their type on every write (app/services/till_parameters.py `validate_keyed_value`).
VALIDATED_KEYS = frozenset({TILLS_KEY, AUTO_OFF_KEY, AUTO_OFF_MINUTES_KEY, TTL_KEY})

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
_WHERE = (
    "המסך \"מסופונים ברשת — מצב לא מקוון\" בהגדרות הקופה מעביר את המסופונים של כל הקופות בסניף (Nayax C4 / "
    "T50 ברשת או ב-USB, ואשראי מובנה Agamento) למצב לא מקוון — כשהאינטרנט או חברת האשראי נופלים — ומחזיר "
    "אותם למקוון; אותו דבר מהדשבורד, בעמוד \"מסופונים — מצב לא מקוון\"."
)

#: The built-ins (app/services/till_parameters.py `BUILTIN_PARAMETERS`).
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=TILLS_KEY,
        label="מסופונים ברשת — קופות מנהלות",
        value_type="string",
        default_value="",
        description=(
            f"{_WHERE} הקופות שבהן המסך מופיע (למי שיש לו ההרשאה \"מצב לא מקוון לכל המסופונים\"): מזהי "
            "קופות מופרדים בפסיקים — בדשבורד מסמנים \"קופה מנהלת מצב לא מקוון\" בכרטיס הקופה. נקבע ברמת "
            "סניף (או נקודת מכירה), כדי שכל הקופות בסניף יידעו שהפיצ'ר פעיל ויפעילו את שרת הרשת שלהן. ריק "
            "(ברירת מחדל) — הפיצ'ר כבוי בכל הסניף."
        ),
    ),
    dict(
        key=INCLUDE_KIOSKS_KEY,
        label="מסופונים ברשת — לכלול קיוסקים",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, \"העבר הכל ללא מקוון\" (בקופה המנהלת ובדשבורד) כולל גם קיוסקים עם מסופון Nayax. כבוי "
            f"(ברירת מחדל) — קיוסקים לא מוצגים ברשימה ולא מועברים. {_LEVELS}"
        ),
    ),
    dict(
        key=AUTO_OFF_KEY,
        label="מסופונים ברשת — חזרה למקוון כשהחיבור חוזר",
        value_type="enum",
        enum_options=AUTO_OFF_OPTIONS,
        enum_labels=AUTO_OFF_LABELS,
        default_value=AUTO_OFF_ASK,
        description=(
            "מה קורה כשהחיבור חוזר אחרי שהמסופונים הועברו למצב לא מקוון. "
            f"«{AUTO_OFF_LABELS[AUTO_OFF_ASK]}» — הקופה המנהלת מציגה \"החיבור חזר — להחזיר הכל למקוון?\". "
            f"«{AUTO_OFF_LABELS[AUTO_OFF_AUTO]}» — חוזרים למקוון לבד אחרי מספר הדקות שבפרמטר \"דקות חיבור "
            f"יציב\". «{AUTO_OFF_LABELS[AUTO_OFF_NEVER]}» — רק מהמסך. בחזרה למקוון כל מסופון שולח מיד את "
            f"העסקאות הדחויות לאישור. {_LEVELS}"
        ),
    ),
    dict(
        key=AUTO_OFF_MINUTES_KEY,
        label="מסופונים ברשת — דקות חיבור יציב לפני חזרה אוטומטית",
        value_type="integer",
        default_value=AUTO_OFF_MINUTES_DEFAULT,
        description=(
            "כשהפרמטר \"חזרה למקוון כשהחיבור חוזר\" הוא «אוטומטית»: כמה דקות של חיבור יציב לפני שהמסופונים "
            f"חוזרים למקוון ({AUTO_OFF_MINUTES_MIN}–{AUTO_OFF_MINUTES_MAX}, ברירת מחדל {AUTO_OFF_MINUTES_DEFAULT}). "
            + _LEVELS
        ),
    ),
    dict(
        key=ALLOW_UNKNOWN_KEY,
        label="מסופונים ברשת — לכלול מסופון Nayax בדגם לא מזוהה",
        value_type="boolean",
        default_value=False,
        description=(
            "רק מסופוני Nayax בדגם C4 או T50 תומכים במצב לא מקוון. כשהמסופון לא אומר מה הדגם שלו הוא מוצג "
            "\"דגם לא מזוהה — לא נכלל\". כשמופעל — מסופון Nayax בדגם לא מזוהה נכלל בכל זאת (על אחריות "
            f"המפעיל). {_LEVELS}"
        ),
    ),
    dict(
        key=TTL_KEY,
        label="מסופונים ברשת — תוקף פקודה (דקות)",
        value_type="integer",
        default_value=TTL_DEFAULT,
        description=(
            "כמה זמן פקודת \"מצב לא מקוון\" (מהקופה המנהלת או מהדשבורד) בתוקף: קופה שמסופון שלה באמצע עסקה "
            "מחכה עד אז שיתפנה, וקופה שלא התחברה עד אז לא תבצע אותה "
            f"({TTL_MIN}–{TTL_MAX}, ברירת מחדל {TTL_DEFAULT}). {_LEVELS}"
        ),
    ),
)


def parse_tills(value: Any) -> List[str]:
    """`deferredControlTills` as the till ids it names (lenient, as `shopXTillIds` is read)."""
    from app.services.shop_x import till_ids_of

    return till_ids_of(value)[:TILLS_MAX]


def tills_value(ids: Sequence[Any]) -> str:
    """The stored `deferredControlTills`: the ids, comma separated, each once (empty: none)."""
    from app.services.shop_x import till_ids_value

    return till_ids_value(list(ids)[:TILLS_MAX])


def _whole(value: Any, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def clean_value(key: str, value: Any) -> Any:
    """`value` as stored for `key` (the codes the till knows, the minutes' ranges, the tills canonical), else ValueError."""
    if value is None or key not in VALIDATED_KEYS:
        return value
    if key == AUTO_OFF_KEY and value not in AUTO_OFF_OPTIONS:
        raise ValueError(f"{AUTO_OFF_KEY} must be one of {', '.join(AUTO_OFF_OPTIONS)}")
    if key == AUTO_OFF_MINUTES_KEY and not _whole(value, AUTO_OFF_MINUTES_MIN, AUTO_OFF_MINUTES_MAX):
        raise ValueError(f"{AUTO_OFF_MINUTES_KEY} must be {AUTO_OFF_MINUTES_MIN}–{AUTO_OFF_MINUTES_MAX} minutes")
    if key == TTL_KEY and not _whole(value, TTL_MIN, TTL_MAX):
        raise ValueError(f"{TTL_KEY} must be {TTL_MIN}–{TTL_MAX} minutes")
    if key == TILLS_KEY:
        if not isinstance(value, str):
            raise ValueError(f"{TILLS_KEY} must be text")
        ids: List[str] = []
        for part in value.replace(";", ",").replace("\n", ",").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                ident = str(uuid.UUID(part))
            except ValueError:
                raise ValueError(f"{TILLS_KEY} must be till ids separated by commas") from None
            if ident not in ids:
                ids.append(ident)
        if len(ids) > TILLS_MAX:
            raise ValueError(f"{TILLS_KEY}: at most {TILLS_MAX} tills")
        return ",".join(ids)
    return value


@dataclass(frozen=True)
class Settings:
    till_ids: Tuple[str, ...] = ()
    include_kiosks: bool = False
    auto_off: str = AUTO_OFF_ASK
    auto_off_minutes: int = AUTO_OFF_MINUTES_DEFAULT
    allow_unknown_nayax: bool = False
    ttl_minutes: int = TTL_DEFAULT

    def controls(self, machine_id: Any) -> bool:
        return str(machine_id).lower() in self.till_ids

    def out(self) -> Dict[str, Any]:
        """§8.4 `settings`."""
        return {
            "includeKiosks": self.include_kiosks,
            "autoOff": self.auto_off,
            "autoOffMinutes": self.auto_off_minutes,
            "allowUnknownNayax": self.allow_unknown_nayax,
            "ttlMinutes": self.ttl_minutes,
        }


def settings_of(params: Dict[str, Any]) -> Settings:
    """Resolved parameters as these rules read them (pure); a missing or odd value is the default."""

    def flag(key: str, default: bool) -> bool:
        value = params.get(key)
        return value if isinstance(value, bool) else default

    def minutes(key: str, default: int, low: int, high: int) -> int:
        value = params.get(key)
        return value if _whole(value, low, high) else default

    auto_off = params.get(AUTO_OFF_KEY)
    return Settings(
        till_ids=tuple(parse_tills(params.get(TILLS_KEY))),
        include_kiosks=flag(INCLUDE_KIOSKS_KEY, False),
        auto_off=auto_off if auto_off in AUTO_OFF_OPTIONS else AUTO_OFF_ASK,
        auto_off_minutes=minutes(AUTO_OFF_MINUTES_KEY, AUTO_OFF_MINUTES_DEFAULT, AUTO_OFF_MINUTES_MIN, AUTO_OFF_MINUTES_MAX),
        allow_unknown_nayax=flag(ALLOW_UNKNOWN_KEY, False),
        ttl_minutes=minutes(TTL_KEY, TTL_DEFAULT, TTL_MIN, TTL_MAX),
    )


def resolve_for_machines(db: Session, machines: Sequence[Any]) -> Dict[Any, Settings]:
    """
    Each till's six parameters (till → point of sale → shop → company → default), in two queries
    for the whole list — the dashboard's rows and a switch's TTLs.
    """
    from sqlalchemy import and_, or_

    from app.models.shop import Shop
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import till_parameters as TP

    out: Dict[Any, Settings] = {}
    if not machines:
        return out
    try:
        parameters = db.query(TillParameter).filter(TillParameter.key.in_(KEYS)).all()
        shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
        companies = (
            {row[0]: row[1] for row in db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(list(shop_ids))).all()}
            if shop_ids else {}
        )
        chains = {
            m.id: TP.TillScopeChain(
                machine_id=m.id, area_id=getattr(m, "area_id", None), shop_id=m.shop_id,
                company_id=companies.get(m.shop_id),
            )
            for m in machines
        }
        scopes = {scope for chain in chains.values() for scope in chain.scopes()}
        values = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id.in_([p.id for p in parameters]),
                or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
            )
            .all()
            if scopes and parameters else []
        )
        for m in machines:
            # Only the values on the till's own chain count (`resolve_till_parameters`).
            out[m.id] = settings_of(TP.resolve_till_parameters(parameters, values, chains[m.id]).parameters)
    except Exception:  # noqa: BLE001 - the defaults, never a failed page
        logger.exception("deferred control: parameters unreadable")
        return {m.id: Settings() for m in machines}
    return out


def machine_settings(db: Session, machine: Any) -> Settings:
    return resolve_for_machines(db, [machine]).get(machine.id, Settings())


def shop_settings(db: Session, shop: Any) -> Settings:
    """The parameters at the shop's own level (shop → company → default): the dashboard's header."""
    from app.services import till_parameters as TP

    try:
        return settings_of(TP.resolve_for_shop(db, shop))
    except Exception:  # noqa: BLE001
        logger.exception("deferred control: parameters of shop %s unreadable", getattr(shop, "id", None))
        return Settings()


# ── Who is included (§7, §8.2) ────────────────────────────────────────────────

KIOSK_EXCLUDED = "kiosk_excluded"
NEEDS_UPDATE = "needs_update"
#: The reasons of §8.2, in its order, and the cloud's own (`needs_update`).
REASONS: Tuple[str, ...] = (
    KIOSK_EXCLUDED, "no_card", "zcredit", "synqpay", "tap_to_pay", "training", "unknown_model", "other_model",
    "not_allowed", NEEDS_UPDATE,
)
#: §8.2 "טקסטים" (`other_model` names the model — `reason_text`).
REASON_TEXTS: Dict[str, str] = {
    KIOSK_EXCLUDED: "קיוסק — לא נכלל",
    "no_card": "ללא אשראי",
    "zcredit": "Z-Credit — לא נתמך",
    "synqpay": "SynqPay — לא נתמך",
    "tap_to_pay": "Tap to Pay — לא נתמך",
    "training": "מצב הדרכה",
    "unknown_model": "דגם לא מזוהה — לא נכלל",
    "other_model": "דגם {model} — לא נתמך",
    "not_allowed": "Nayax לא התירו מצב לא מקוון במסוף",
    NEEDS_UPDATE: "הקופה צריכה עדכון",
}
#: A till's card integration (app/services/payment_integration.py) that is never included, and why.
INTEGRATION_REASONS: Dict[str, str] = {
    "none": "no_card", "zcredit": "zcredit", "synqpay": "synqpay", "tap_to_pay": "tap_to_pay",
}
INCLUDED_KINDS = ("agamento", "nayax_lan", "nayax_usb")
NAYAX_KINDS = ("nayax_lan", "nayax_usb")


def reason_text(reason: Optional[str], model: Optional[str] = None) -> Optional[str]:
    """The Hebrew of a reason (§8.2); an unknown one as it is."""
    if not reason:
        return None
    if reason == "other_model":
        return REASON_TEXTS["other_model"].format(model=(model or "").strip() or "אחר")
    return REASON_TEXTS.get(reason, reason)


def capable(machine: Any) -> bool:
    """The till's build takes `terminal_offline`: its heartbeat said `deferred_control_v1`."""
    if machine is None:
        return False
    words = list(getattr(machine, "capabilities", None) or [])
    reported = getattr(machine, "reported_capabilities", None) or {}
    if isinstance(reported, dict):
        words += list(reported.get("list") or [])
    return CAPABILITY in words


@dataclass(frozen=True)
class Eligibility:
    #: True: included; False: not (`reason`); None: not known yet.
    eligible: Optional[bool]
    reason: Optional[str] = None
    #: "till" — the till's own word (its report); "cloud" — what the cloud knows.
    source: str = "cloud"


def eligibility(
    *,
    report: Optional[Dict[str, Any]],
    is_kiosk: bool,
    settings: Settings,
    is_capable: bool,
    integration: Optional[str] = None,
    training: bool = False,
) -> Eligibility:
    """
    §8.2 as the cloud reads it. The till's word when it reported one (it read its terminal); a kiosk
    out while kiosks are not included; a till that cannot take the command `needs_update` (it is
    never sent one). Without a report: the card integration and the shop's training mode, else the
    integration's own answer — Agamento in, a Nayax of unknown model only with
    `deferredAllowUnknownNayax`.
    """
    if is_kiosk and not settings.include_kiosks:
        return Eligibility(False, KIOSK_EXCLUDED)
    terminal = (report or {}).get("terminal") if isinstance(report, dict) else None
    if isinstance(terminal, dict) and isinstance(terminal.get("eligible"), bool):
        if terminal["eligible"]:
            return Eligibility(True, None, "till") if is_capable else Eligibility(False, NEEDS_UPDATE)
        reason = terminal.get("reason") if isinstance(terminal.get("reason"), str) else None
        return Eligibility(False, reason or "not_allowed", "till")
    if integration in INTEGRATION_REASONS:
        return Eligibility(False, INTEGRATION_REASONS[integration])
    if training:
        return Eligibility(False, "training")
    if not is_capable:
        return Eligibility(False, NEEDS_UPDATE)
    if integration == "agamento":
        return Eligibility(True)
    if integration in NAYAX_KINDS:
        return Eligibility(True) if settings.allow_unknown_nayax else Eligibility(False, "unknown_model")
    return Eligibility(None)


def integration_of(db: Session, machine: Any) -> Optional[str]:
    """The till's card integration over its stored layers, or None when it cannot be read."""
    try:
        from app.services import payment_integration as PI

        return PI.resolve_machine(db, machine).integration
    except Exception:  # noqa: BLE001 - unknown, never a failed page
        logger.debug("deferred control: integration of %s unreadable", getattr(machine, "id", None), exc_info=True)
        return None


# ── The heartbeat's block (§8.5 "דופק") ──────────────────────────────────────


def _text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def _flag(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _count(value: Any, limit: int = 10**9) -> Optional[int]:
    """A whole number ≥ 0 (a whole float too); anything else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and 0 <= value <= limit else None


def _signed(value: Any, limit: int = 10**9) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and -limit <= value <= limit else None


def _amount(value: Any) -> Optional[Any]:
    """A sum ≥ 0 as the till sent it — a number, or a decimal written as text ("412.50")."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value if 0 <= value < 10**12 else None
    if isinstance(value, str):
        text = value.strip()[:32]
        try:
            number = Decimal(text)
        except (InvalidOperation, ValueError):
            return None
        return text if number.is_finite() and number >= 0 else None
    return None


def _port(value: Any) -> Optional[int]:
    port = _count(value, 65535)
    return port if port else None


def _pick(src: Dict[str, Any], cleaners: Dict[str, Any]) -> Dict[str, Any]:
    """The known keys the till sent, each cleaned (junk is None, an unknown key dropped)."""
    return {key: clean(src[key]) for key, clean in cleaners.items() if key in src}


_PINPAD = {
    "host": lambda v: _text(v, 253),
    "port": _port,
    "path": lambda v: _text(v, 100),
    "https": _flag,
}
_TERMINAL = {
    "kind": lambda v: _text(v, 32),
    "model": lambda v: _text(v, 64),
    "eligible": _flag,
    "reason": lambda v: _text(v, 64),
    "allowed": _flag,
    "pinpad": lambda v: _pick(v, _PINPAD) if isinstance(v, dict) else None,
}
_OFFLINE = {
    "working": _flag,
    "pending": _count,
    "txLimit": _count,
    "txLeft": _count,
    "amountLimit": _amount,
    "amountLeft": _amount,
    "readAt": lambda v: _text(v, 40),
}
_CONTROL = {
    "on": _flag,
    "by": lambda v: _text(v, 100),
    "byId": lambda v: _text(v, 64),
    "requestedBy": lambda v: _text(v, 100),
    "from": lambda v: _text(v, 100),
    "fromId": lambda v: _text(v, 64),
    "at": lambda v: _text(v, 40),
    "source": lambda v: _text(v, 16),
    "requestId": lambda v: _text(v, 64),
}
_REPORT = {
    "terminal": lambda v: _pick(v, _TERMINAL) if isinstance(v, dict) else None,
    "offline": lambda v: _pick(v, _OFFLINE) if isinstance(v, dict) else None,
    "control": lambda v: _pick(v, _CONTROL) if isinstance(v, dict) else None,
    "kiosk": _flag,
    "at": lambda v: _text(v, 40),
}


def clean_report(block: Any) -> Optional[Dict[str, Any]]:
    """
    The heartbeat's `deferredTerminal` as kept: its known keys, nested as the till sent them (§8.5:
    the LAN status's `terminal`, `offline`, `control`, `kiosk`, `at`), each cleaned — texts clipped,
    counts whole and ≥ 0, a value that cannot be read null. None when nothing usable was sent.
    Never raises: it rides on the heartbeat, which must never fail.
    """
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True)
    if not isinstance(block, dict):
        return None
    out = _pick(block, _REPORT)
    return out if any(v is not None for v in out.values()) else None


def apply_heartbeat(machine: Any, block: Any, *, now: Optional[datetime] = None) -> None:
    """The beat's block into `device_info["deferredTerminal"]` with `reportedAt`. Absent: as it was. Never raises."""
    try:
        report = clean_report(block)
        if report is None:
            return
        stamped = {**report, "reportedAt": (now or _now()).isoformat()}
        info = machine.device_info if isinstance(machine.device_info, dict) else {}
        # A new dict, so the JSON column sees the change.
        machine.device_info = {**info, INFO_KEY: stamped}
    except Exception:  # noqa: BLE001 - a status block never fails a heartbeat
        logger.exception("deferred terminal report not applied for %s", getattr(machine, "id", None))


def report_of(machine: Any) -> Optional[Dict[str, Any]]:
    """The last report as kept, or None (an older build, or never sent)."""
    info = getattr(machine, "device_info", None)
    report = info.get(INFO_KEY) if isinstance(info, dict) else None
    return report if isinstance(report, dict) else None


def _part(report: Optional[Dict[str, Any]], key: str) -> Dict[str, Any]:
    value = (report or {}).get(key)
    return value if isinstance(value, dict) else {}


def mode_of(report: Optional[Dict[str, Any]]) -> str:
    """The terminal's mode as last reported: offline ("לא מקוון"), online ("מקוון") or unknown."""
    working = _part(report, "offline").get("working")
    if working is True:
        return "offline"
    if working is False:
        return "online"
    return "unknown"


# ── The command (§8.5) ────────────────────────────────────────────────────────

RECEIVED = "received"
#: What a till refuses or fails with (§8.3), kept as it says it — `not_eligible:<reason>` included.
REFUSALS = (
    "not_eligible", "stale", "expired", "bad_request", "timeout_busy", "superseded", "interrupted", "not_active",
)
#: The dashboard's words for a command (§8.5 "מצב בדשבורד").
STATE_PENDING, STATE_RECEIVED, STATE_DONE, STATE_FAILED, STATE_CANCELLED = (
    "pending", "received", "done", "failed", "cancelled",
)
DETAIL_MAX = 300


def who(user: Any) -> Optional[str]:
    name = " ".join(
        part for part in (getattr(user, "first_name", None), getattr(user, "last_name", None)) if isinstance(part, str) and part
    ).strip()
    return name or getattr(user, "username", None) or getattr(user, "email", None)


def switch_params(*, on: bool, user: Any, now: datetime) -> Dict[str, Any]:
    """The LAN switch's body (§8.3) as the cloud sends it; `requestId` is each command's own id."""
    person = {"id": str(getattr(user, "id", "")) or None, "name": who(user)}
    return {
        "on": bool(on),
        "issuedAt": _aware(now).isoformat(timespec="milliseconds"),
        "by": dict(person),
        "requestedBy": dict(person),
        "from": {"machineId": None, "name": DASHBOARD_NAME},
        "source": SOURCE_CLOUD,
    }


def clean_answer(ack_status: str, detail: Optional[str], raw: Any) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    The till's final answer as kept (§8.3): `detail` as it said it (a reason, `not_eligible:<reason>`,
    or a terminal's error), clipped — never refused for a word the cloud does not know; `result` only
    its known fields: {working, pending, authorization {ok, statusCode, approved, declined,
    approvedAmount}, error}.
    """
    text = detail.strip()[:DETAIL_MAX] if isinstance(detail, str) and detail.strip() else None
    raw = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {}
    if "working" in raw:
        out["working"] = _flag(raw.get("working"))
    if "pending" in raw:
        out["pending"] = _count(raw.get("pending"))
    if "authorization" in raw:
        auth = raw.get("authorization")
        out["authorization"] = (
            {
                "ok": _flag(auth.get("ok")),
                "statusCode": _signed(auth.get("statusCode")),
                "approved": _count(auth.get("approved")),
                "declined": _count(auth.get("declined")),
                "approvedAmount": _amount(auth.get("approvedAmount")),
            }
            if isinstance(auth, dict) else None
        )
    if "error" in raw:
        out["error"] = _text(raw.get("error"), DETAIL_MAX)
    return text, (out or None)


def note_received(row: Any, now: datetime) -> None:
    """The till's "received" (not final): delivered, with `result.receivedAt`. A final command stays as it is."""
    from app.models.device_command import FINAL_STATUSES

    if row.status in FINAL_STATUSES:
        return
    if row.status == "pending":
        row.status = "delivered"
    if row.delivered_at is None:
        row.delivered_at = now
    result = dict(row.result or {})
    result.setdefault("receivedAt", now.isoformat())
    row.result = result
    row.updated_at = now


def state_of(status: str, result: Optional[Dict[str, Any]]) -> str:
    """§8.5: pending ממתין, delivered + receivedAt התקבל, done בוצע, failed / refused / expired נכשל, cancelled בוטל."""
    if status == "delivered":
        return STATE_RECEIVED if (result or {}).get("receivedAt") else STATE_PENDING
    if status == "done":
        return STATE_DONE
    if status in ("failed", "refused", "expired"):
        return STATE_FAILED
    if status == "cancelled":
        return STATE_CANCELLED
    return STATE_PENDING


def command_view(row: Any, now: datetime) -> Dict[str, Any]:
    """One `terminal_offline` command as the dashboard shows it, as it stands at [now] (nothing written)."""
    from app.services import device_commands as DC

    out = DC.as_of(row, now)
    result = row.result if isinstance(row.result, dict) else {}
    params = row.params if isinstance(row.params, dict) else {}
    return {
        "id": str(row.id),
        "on": params.get("on"),
        "status": out["status"],
        "state": state_of(out["status"], result),
        "receivedAt": result.get("receivedAt"),
        "createdAt": out["createdAt"],
        "deliveredAt": out["deliveredAt"],
        "doneAt": out["doneAt"],
        "expiresAt": out["expiresAt"],
        "createdBy": row.created_by_name,
        "detail": out["detail"],
        "result": {k: v for k, v in result.items() if k != "receivedAt"} or None,
    }


def is_open(view: Optional[Dict[str, Any]]) -> bool:
    return bool(view) and view["state"] in (STATE_PENDING, STATE_RECEIVED)


def create_commands(
    db: Session, machines: Sequence[Any], *, on: bool, user: Any, now: Optional[datetime] = None,
) -> List[Any]:
    """
    One `terminal_offline` per till, one batch (the caller commits, then wakes them): the §8.3 body,
    `requestId` = the command's id, each living its till's `deferredCommandTtlMin`. Creating one
    cancels the till's open ones (`superseded`, app/services/device_commands.py `create`).
    """
    from app.services import device_commands as DC

    now = now or _now()
    if not machines:
        return []
    base = switch_params(on=on, user=user, now=now)
    ttl = resolve_for_machines(db, machines)
    rows = DC.create(db, machines, ACTION, user=user, by_name=who(user), params=base, now=now)
    for row in rows:
        settings = ttl.get(row.machine_id, Settings())
        row.params = {"requestId": str(row.id), **base}
        row.expires_at = now + timedelta(minutes=settings.ttl_minutes)
    db.flush()
    return rows


# ── The shop's tills ──────────────────────────────────────────────────────────


def shop_tills(db: Session, shop_id: Any) -> List[Any]:
    """The shop's active tills and kiosks — never a screen or a dedicated local server (they have no terminal)."""
    from app.models.pos_machine import POSMachine

    rows = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    return [m for m in rows if getattr(m, "is_fiscal", True) is not False]


def kiosk_ids(db: Session, machine_ids: Iterable[Any]) -> set:
    from app.models.kiosk import KioskDevice

    ids = [m for m in machine_ids if m is not None]
    if not ids:
        return set()
    return {
        r[0] for r in db.query(KioskDevice.machine_id).filter(
            KioskDevice.home_role.is_(None), KioskDevice.machine_id.in_(ids),
        ).all()
    }


def label_of(machine: Any) -> str:
    """"3 · בר" — the register number and the name (app/services/printers.py `machine_label`)."""
    number = (getattr(machine, "pos_number", None) or "").strip()
    name = (getattr(machine, "name", None) or "").strip()
    if number and name:
        return f"{number} · {name}"
    return name or number or str(machine.id)


def last_commands(db: Session, machine_ids: Sequence[Any], *, now: datetime) -> Dict[Any, Any]:
    """Each till's latest `terminal_offline` (the last 30 days)."""
    from app.models.device_command import DeviceCommand

    if not machine_ids:
        return {}
    rows = (
        db.query(DeviceCommand)
        .filter(
            DeviceCommand.machine_id.in_(list(machine_ids)),
            DeviceCommand.action == ACTION,
            DeviceCommand.created_at > now - timedelta(days=30),
        )
        .order_by(DeviceCommand.created_at.desc(), DeviceCommand.id.desc())
        .all()
    )
    out: Dict[Any, Any] = {}
    for row in rows:
        out.setdefault(row.machine_id, row)
    return out


@dataclass
class TillRow:
    machine: Any
    is_kiosk: bool
    capable: bool
    report: Optional[Dict[str, Any]]
    integration: Optional[str]
    eligibility: Eligibility
    settings: Settings
    last: Optional[Any] = None
    extras: Dict[str, Any] = field(default_factory=dict)


def till_rows(db: Session, shop: Any, machines: Sequence[Any], *, shop_level: Settings) -> List[TillRow]:
    """Each till of [machines] (the shop's, as the caller may see them) with its eligibility (§8.2)."""
    from app.services import training_mode

    kiosks = kiosk_ids(db, [m.id for m in machines])
    per_till = resolve_for_machines(db, machines)
    training = training_mode.is_on(shop)
    rows: List[TillRow] = []
    for m in machines:
        report = report_of(m)
        able = capable(m)
        integration = integration_of(db, m) if not _part(report, "terminal") else None
        # Kiosks by the shop's word (the dashboard switches the whole shop); the rest by the till's own.
        settings = per_till.get(m.id, Settings())
        rule = Settings(include_kiosks=shop_level.include_kiosks, allow_unknown_nayax=settings.allow_unknown_nayax)
        rows.append(TillRow(
            machine=m, is_kiosk=m.id in kiosks, capable=able, report=report, integration=integration,
            eligibility=eligibility(
                report=report, is_kiosk=m.id in kiosks, settings=rule, is_capable=able,
                integration=integration, training=training,
            ),
            settings=settings,
        ))
    return rows


def row_out(row: TillRow, *, now: datetime, last_view: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    from app.services.machine_status import is_online

    m = row.machine
    report = row.report
    terminal = _part(report, "terminal")
    offline = _part(report, "offline")
    kind = terminal.get("kind") or row.integration
    model = terminal.get("model")
    elig = row.eligibility
    return {
        "machineId": str(m.id),
        "name": m.name,
        "posNumber": m.pos_number,
        "label": label_of(m),
        "isKiosk": row.is_kiosk,
        "online": is_online(m.last_heartbeat_at, now=now),
        "lastSeenAt": _iso(m.last_heartbeat_at),
        "capable": row.capable,
        "isController": row.settings.controls(m.id),
        "kind": kind,
        "model": model,
        "eligible": elig.eligible,
        "reason": elig.reason,
        "reasonText": reason_text(elig.reason, model),
        "eligibilitySource": elig.source,
        "mode": mode_of(report),
        "pending": offline.get("pending"),
        "txLimit": offline.get("txLimit"),
        "txLeft": offline.get("txLeft"),
        "control": (report or {}).get("control") if isinstance((report or {}).get("control"), dict) else None,
        "reportedAt": (report or {}).get("reportedAt"),
        "terminal": report,
        "lastCommand": last_view,
    }


def shop_view(db: Session, shop: Any, machines: Sequence[Any], *, can_switch: bool, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /shops/{id}/deferred-terminals`: the shop's settings, its controllers and every till (§9)."""
    from app.services import device_commands as DC

    now = now or _now()
    if machines:
        # Commands past their end are settled on the way (as the remote control's panel does).
        DC.expire_old(db, now=now)
    shop_level = shop_settings(db, shop)
    rows = till_rows(db, shop, machines, shop_level=shop_level)
    last = last_commands(db, [m.id for m in machines], now=now)
    tills = []
    for row in rows:
        command = last.get(row.machine.id)
        tills.append(row_out(row, now=now, last_view=command_view(command, now) if command is not None else None))
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "serverTime": now.isoformat(),
        "settings": shop_level.out(),
        "controllers": [t["machineId"] for t in tills if t["isController"]],
        "controllersValue": list(shop_level.till_ids),
        "canSwitch": can_switch,
        "open": any(is_open(t["lastCommand"]) for t in tills),
        "tills": tills,
    }


def plan_switch(
    db: Session, shop: Any, machines: Sequence[Any], *, machine_ids: Optional[Sequence[Any]] = None,
) -> Tuple[List[Any], List[Dict[str, Any]]]:
    """
    Which of the shop's tills a switch goes to: [machine_ids] (absent: all), each one included
    (§8.2) and able to take the command; the rest skipped with why — `kiosk_excluded`,
    `needs_update`, `not_eligible:<reason>`, or `not_found` (not a till of this shop the caller may see).
    """
    shop_level = shop_settings(db, shop)
    by_id = {str(m.id): m for m in machines}
    skipped: List[Dict[str, Any]] = []
    if machine_ids is None:
        chosen = list(machines)
    else:
        chosen = []
        for ident in dict.fromkeys(str(i) for i in machine_ids):
            if ident in by_id:
                chosen.append(by_id[ident])
            else:
                skipped.append({"machineId": ident, "reason": "not_found"})
    targets: List[Any] = []
    for row in till_rows(db, shop, chosen, shop_level=shop_level):
        ident = str(row.machine.id)
        elig = row.eligibility
        if elig.reason == KIOSK_EXCLUDED:
            skipped.append({"machineId": ident, "reason": KIOSK_EXCLUDED})
        elif not row.capable or elig.reason == NEEDS_UPDATE:
            skipped.append({"machineId": ident, "reason": NEEDS_UPDATE})
        elif elig.eligible is not True:
            skipped.append({"machineId": ident, "reason": f"not_eligible:{elig.reason or 'unknown'}"})
        else:
            targets.append(row.machine)
    return targets, skipped


# ── The controller's list (§8.4) ──────────────────────────────────────────────


def lan_address(db: Session, machine: Any) -> Tuple[Optional[str], Optional[int]]:
    """Where the till listens on the shop's LAN: its print-host report, else its `lanIp` on 8399."""
    from app.models.printers import KitchenPrintHost

    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == machine.id).first()
    if row is not None and row.lan_address:
        return row.lan_address, row.port or DEFAULT_LAN_PORT
    lan_ip = (getattr(machine, "lan_ip", None) or "").strip()
    if lan_ip:
        return lan_ip, DEFAULT_LAN_PORT
    return None, None


def control_view(db: Session, machine: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    `GET /sync/{m}/deferred-control` (§8.4): whether this till controls (its id in its resolved
    `deferredControlTills`), the settings, and — for a controller only — the shop's tills: never one
    "מרוחקת בזד הסניפי" (off the shop's LAN), never a kiosk while kiosks are not included.
    """
    from app.services.local_shop_z import is_remote_participant

    now = now or _now()
    settings = machine_settings(db, machine)
    controller = machine.shop_id is not None and settings.controls(machine.id)
    tills: List[Dict[str, Any]] = []
    if controller:
        machines = shop_tills(db, machine.shop_id)
        kiosks = kiosk_ids(db, [m.id for m in machines])
        for m in machines:
            is_self = m.id == machine.id
            is_kiosk = m.id in kiosks
            if not is_self and is_remote_participant(m):
                continue
            if is_kiosk and not settings.include_kiosks:
                continue
            address, port = lan_address(db, m)
            report = report_of(m)
            tills.append({
                "machineId": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "label": label_of(m),
                "isKiosk": is_kiosk,
                "isSelf": is_self,
                "lanAddress": address,
                "lanPort": port,
                "capable": capable(m),
                "terminal": report,
                "reportedAt": (report or {}).get("reportedAt"),
            })
    return {
        "controller": bool(controller),
        "settings": settings.out(),
        "tills": tills,
        "serverTime": now.isoformat(),
    }


# ── The controllers' list from the device page ────────────────────────────────


def set_controller(
    db: Session, shop: Any, machine: Any, on: bool, *, user: Any, now: Optional[datetime] = None,
) -> bool:
    """
    "קופה מנהלת מצב לא מקוון" on the device page: this till in or out of the SHOP's own
    `deferredControlTills` (the list starts from what the shop inherits when it sets none), written as
    the parameters page writes a value (its change log). True when it changed; the caller commits and
    tells the shop's tills.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import till_parameters as TP

    now = now or _now()
    parameter = db.query(TillParameter).filter(TillParameter.key == TILLS_KEY).first()
    if parameter is None:
        TP.ensure_builtin_parameters(db)
        parameter = db.query(TillParameter).filter(TillParameter.key == TILLS_KEY).first()
    own = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "shop",
            TillParameterValue.scope_id == shop.id,
        )
        .first()
    )
    inherited = list(shop_settings(db, shop).till_ids)
    current = parse_tills(own.value) if own is not None else inherited
    ident = str(machine.id).lower()
    wanted = [i for i in current if i != ident] + ([ident] if on else [])
    if sorted(wanted) == sorted(current):
        return False
    # Nothing left: the shop's own row goes, unless it must say "none" over a list it would inherit.
    company_level = settings_of(
        TP.resolve_till_parameters(
            [parameter],
            db.query(TillParameterValue).filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == "company",
                TillParameterValue.scope_id == shop.company_id,
            ).all() if shop.company_id is not None else [],
            TP.TillScopeChain(machine_id=None, shop_id=None, company_id=shop.company_id),
        ).parameters
    ).till_ids
    value: Optional[str] = tills_value(wanted) if wanted or company_level else None
    if value is not None:
        value = clean_value(TILLS_KEY, value)
    return TP.write_value(db, parameter, "shop", shop.id, value, user=user, now=now)
