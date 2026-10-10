"""
"מצב עבודה: קיוסק / קופה" and the kiosk's screen orientation (P:/specs/kiosk-landscape-till-mode.md §3, §5).

The owner (09.10.2026; aligned with P:/specs/web-till-spec-v2.md §6.3, §6.9): a business the owner
allowed chooses by itself how a device works today — as a kiosk or as a till, both ways from the
role it was given. A manager's code with `KIOSK_TILL_MODE` switches it on the device ("ניהול
הקיוסק" → the till; the till's menu → the kiosk), and the dashboard offers the same switch as a
non-blocking kiosk command (`enter_till` / `return_kiosk`). The chosen mode survives a restart.
Held sales never block the way to the kiosk: they wait for the till. Without the owner's gate
nothing of it exists: no button, no menu row, no dashboard switch.

Till parameters (company → shop → area → device, the deepest wins):

* `kioskTillModeEnabled` — boolean, default false. **Admin only**: set by a super admin or a
  distributor, never by the business's own users (`ADMIN_ONLY_KEYS`, enforced by every route that
  writes it).
* `kioskTillModeIdleReturnMinutes` — 0–240, default 3 (0 = never): a kiosk device in till mode goes
  back to the kiosk after that many idle minutes, at rest only — never with a sale open.
* `kioskOrientation` — `auto` (default) | `portrait` | `landscape`: an optional lock for a fixed
  install; the screens fit themselves to whatever the display is, locked or not.

The device reports the mode on kiosk/sync: `flowState = till_mode` and `tillMode` (since, who,
the employee signed in, what holds a pending switch back).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

ENABLED_KEY = "kioskTillModeEnabled"
IDLE_KEY = "kioskTillModeIdleReturnMinutes"
ORIENTATION_KEY = "kioskOrientation"

ORIENTATIONS = ("auto", "portrait", "landscape")
ORIENTATION_LABELS = {"auto": "אוטומטי", "portrait": "לאורך", "landscape": "לרוחב"}
DEFAULT_IDLE_MINUTES = 3
MAX_IDLE_MINUTES = 240
IDLE_MESSAGE = f"חזרה אוטומטית לקיוסק: מספר שלם של דקות, 0 (אף פעם) עד {MAX_IDLE_MINUTES}"

#: Parameters only [ADMIN_ROLES] may change — "if the owner hasn't enabled it, the feature doesn't exist".
ADMIN_ONLY_KEYS = frozenset({ENABLED_KEY})
ADMIN_ROLES = ("super_admin", "distributor")
ADMIN_ONLY_DETAIL = "till_parameter_admin_only"

#: The kiosk commands of the dashboard's switch, the mode each asks for, and how long an unanswered one waits.
ENTER_TILL = "enter_till"
RETURN_KIOSK = "return_kiosk"
ACTION_MODES = {ENTER_TILL: "till", RETURN_KIOSK: "kiosk"}
WORK_MODE_ACTIONS = tuple(ACTION_MODES)
MODES = ("kiosk", "till")
WORK_MODE_TTL = timedelta(hours=24)
#: The device's own refusals while a switch waits (domain/KioskTillMode.kt KioskTillModeRefusal).
BLOCKED_TEXTS = {
    "basket_open": "ממתין — יש מכירה פתוחה בקופה",
    "payment_open": "ממתין — יש תשלום בתהליך",
    "table_open": "ממתין — הזמנת שולחן פתוחה במסך",
    "kiosk_payment": "ממתין — לקוח משלם בקיוסק",
    "customer_ordering": "ממתין — לקוח באמצע הזמנה",
    "disabled": "מצב קופה אינו מופעל",
}

PARAMETER_SPECS = (
    dict(
        key=ENABLED_KEY,
        label="קיוסק — מצב קופה (מצב עבודה: קיוסק / קופה)",
        value_type="boolean",
        default_value=False,
        admin_only=True,
        description=(
            "כשמופעל: בניהול הקיוסק מופיע \"מצב עבודה: קיוסק / קופה\" — מנהל מעביר את המכשיר לעבודה כקופה "
            "(והחוצה, גם מתפריט הקופה), והמצב נשמר גם אחרי הפעלה מחדש. בדשבורד מופיע אותו מתג לכל קיוסק. "
            "אותה מכונה, אותה סדרת מסמכים ואותם חוקי משמרת ו-Z; המסמכים על שם העובד שנכנס. "
            "לא באמצע הזמנה או תשלום. כשכבוי (ברירת המחדל) — האפשרות לא קיימת בכלל. "
            "רק מנהל-על או מפיץ רשאים לשנות. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או מכשיר."
        ),
    ),
    dict(
        key=IDLE_KEY,
        label="קיוסק — חזרה אוטומטית ממצב קופה (דקות)",
        value_type="integer",
        default_value=DEFAULT_IDLE_MINUTES,
        description=(
            "קיוסק במצב קופה: חזרה לקיוסק אחרי מספר הדקות האלה בלי מגע במסך, במנוחה בלבד — לעולם לא עם מכירה "
            "פתוחה, מסך תשלום או תשלום במסופון (מכירות מושהות נשמרות למצב הקופה הבא). 30 שניות לפני — הודעה "
            "עם \"נשארים\". 0 — אף פעם. ברירת מחדל 3, 0–240."
        ),
    ),
    dict(
        key=ORIENTATION_KEY,
        label="קיוסק — כיוון מסך",
        value_type="enum",
        enum_options=ORIENTATIONS,
        default_value="auto",
        description=(
            "auto (ברירת המחדל) — המכשיר מזהה לבד כיוון, רזולוציה וגודל מסך (11\" עד 32\") ומתאים את המסכים, "
            "גם כשהמסך מסתובב או מוחלף. portrait (לאורך) / landscape (לרוחב) — נעילה להתקנה קבועה; המסכים "
            "ממשיכים להתאים את עצמם לגודל. אין צורך לקבוע גודל מסך."
        ),
    ),
)


def _role(user: Any) -> Optional[str]:
    role = getattr(user, "role", None)
    return getattr(role, "value", role)


def may_change(key: str, user: Any) -> bool:
    """Whether `user` may change parameter `key` — always, but for [ADMIN_ONLY_KEYS]."""
    if key not in ADMIN_ONLY_KEYS:
        return True
    return _role(user) in ADMIN_ROLES


def refuse_admin_only(key: str, user: Any) -> None:
    """403 `till_parameter_admin_only` for anyone but a super admin or a distributor on [ADMIN_ONLY_KEYS]."""
    if not may_change(key, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ONLY_DETAIL)


def clean_value(key: str, value: Any) -> Any:
    """A value checked for what its key needs beyond its type (ValueError otherwise)."""
    if value is None:
        return None
    if key == IDLE_KEY:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(IDLE_MESSAGE)
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError(IDLE_MESSAGE)
            value = int(value)
        if value < 0 or value > MAX_IDLE_MINUTES:
            raise ValueError(IDLE_MESSAGE)
        return value
    if key == ORIENTATION_KEY:
        if value not in ORIENTATIONS:
            raise ValueError("כיוון מסך: auto, portrait או landscape")
        return value
    return value


def settings_for(params: Dict[str, Any]) -> Dict[str, Any]:
    """The feature's effective values from a till's resolved parameters (defaults filled in)."""

    def boolean(key: str, default: bool) -> bool:
        v = params.get(key)
        return v if isinstance(v, bool) else default

    idle = params.get(IDLE_KEY)
    try:
        idle = clean_value(IDLE_KEY, idle) if idle is not None else DEFAULT_IDLE_MINUTES
    except ValueError:
        idle = DEFAULT_IDLE_MINUTES
    orientation = params.get(ORIENTATION_KEY)
    return {
        "enabled": boolean(ENABLED_KEY, False),
        "idleReturnMinutes": idle,
        "orientation": orientation if orientation in ORIENTATIONS else "auto",
    }


def effective(db: Session, machine: Any) -> Dict[str, Any]:
    """The feature's effective values for one device."""
    from app.services.till_parameters import till_parameters_for_machine

    try:
        resolved = till_parameters_for_machine(db, machine).parameters
    except Exception:  # noqa: BLE001 - a summary never fails on a parameter
        resolved = {}
    return settings_for(resolved)


# ── The owner's gate, from the dashboard's kiosk page ────────────────────────


def set_gate(db: Session, machine: Any, enabled: Optional[bool], user: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    `kioskTillModeEnabled` at the device's own level: on, off, or `None` — back to what it inherits.
    A super admin or a distributor only (403 otherwise). The caller commits, then notifies the device.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import till_parameter_audit as AUDIT
    from app.services.till_parameters import ensure_builtin_parameters

    refuse_admin_only(ENABLED_KEY, user)
    if enabled is not None and not isinstance(enabled, bool):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="enabled must be true, false or null")
    now = now or datetime.now(timezone.utc)
    ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == ENABLED_KEY).first()
    if parameter is None:  # pragma: no cover - created just above
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="parameter missing")
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        )
        .first()
    )
    old = row.value if row is not None else None
    if enabled is None:
        if row is not None:
            db.delete(row)
        action = AUDIT.CLEAR
    else:
        if row is None:
            db.add(TillParameterValue(
                id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine.id, value=enabled,
            ))
        else:
            row.value = enabled
        action = AUDIT.SET
    AUDIT.record_change(
        db, parameter=parameter, scope_type="machine", scope_id=machine.id,
        action=action, old_value=old, new_value=enabled, user=user, now=now,
    )
    # Moves the tills' parameters watermark, so the device pulls it on its next sync.
    parameter.updated_at = now
    db.flush()
    return effective(db, machine)


# ── The dashboard's switch (the kiosk commands `enter_till` / `return_kiosk`) ────────


def check_work_mode(db: Session, machine: Any, action: str) -> str:
    """The mode `enter_till` / `return_kiosk` asks for, where the owner's gate is open; the refusal otherwise."""
    from app.services.kiosk_control import KioskCommandRefused

    mode = ACTION_MODES.get(action)
    if mode is None:
        raise KioskCommandRefused(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_work_mode", "מצב עבודה: enter_till או return_kiosk")
    if not effective(db, machine)["enabled"]:
        raise KioskCommandRefused(status.HTTP_409_CONFLICT, "till_mode_disabled", "מצב קופה אינו מופעל לקיוסק הזה")
    return mode


def pending_work_mode(db: Session, kiosk: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    The latest `enter_till` / `return_kiosk` the kiosk has still to carry out ({id, mode, by}); an
    older one is superseded, one a day old expires. The caller commits (a read path may not).
    """
    from app.models.kiosk import KioskCommand

    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(KioskCommand)
        .filter(
            KioskCommand.kiosk_machine_id == kiosk.id,
            KioskCommand.action.in_(WORK_MODE_ACTIONS),
            KioskCommand.status == "requested",
        )
        .order_by(KioskCommand.created_at.desc())
        .all()
    )
    latest = None
    for row in rows:
        created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
        if latest is None and now - created <= WORK_MODE_TTL:
            latest = row
            continue
        row.status = "refused"
        row.detail = ((row.detail or "") + (" · expired" if latest is None else " · superseded"))[:500]
    db.flush()
    if latest is None:
        return None
    return {"id": str(latest.id), "mode": ACTION_MODES.get(latest.action), "by": latest.requested_by_name}


def work_mode_of(status_report: Any) -> str:
    """The mode a kiosk reported (its `flowState`)."""
    flow = status_report.get("flowState") if isinstance(status_report, dict) else None
    return "till" if flow == "till_mode" else "kiosk"


def summary_part(db: Session, machine: Any, status_report: Any) -> Dict[str, Any]:
    """What the dashboard's kiosk panels show of the feature: the gate, the mode, the waiting switch."""
    settings = effective(db, machine)
    till = status_report.get("tillMode") if isinstance(status_report, dict) else None
    till = till if isinstance(till, dict) else {}
    blocked = till.get("returnBlocked")
    return {
        "enabled": settings["enabled"],
        "idleReturnMinutes": settings["idleReturnMinutes"],
        "orientation": settings["orientation"],
        "mode": work_mode_of(status_report),
        "since": till.get("since"),
        "enteredBy": till.get("enteredBy"),
        "employee": till.get("employee"),
        "blocked": blocked,
        "blockedText": BLOCKED_TEXTS.get(blocked) if blocked else None,
    }


def clean_till_mode(raw: Any) -> Optional[Dict[str, Any]]:
    """The kiosk's `status.tillMode`, cleaned (strings only, bounded)."""
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    for key, size in (("since", 40), ("enteredBy", 100), ("employee", 100), ("source", 16), ("returnBlocked", 32)):
        v = raw.get(key)
        if isinstance(v, str) and v.strip():
            out[key] = v.strip()[:size]
    return out


DISPLAY_ORIENTATIONS = ("portrait", "landscape")
SIZE_CLASSES = ("handheld", "11", "13", "15", "21", "27", "32")


def clean_display(raw: Any) -> Optional[Dict[str, Any]]:
    """The kiosk's `status.display` (the screen it lays itself out on), cleaned."""
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    if raw.get("orientation") in DISPLAY_ORIENTATIONS:
        out["orientation"] = raw["orientation"]
    if raw.get("sizeClass") in SIZE_CLASSES:
        out["sizeClass"] = raw["sizeClass"]
    if isinstance(raw.get("physical"), bool):
        out["physical"] = raw["physical"]
    for key, lo, hi in (("diagonalInches", 0, 200), ("scale", 0, 10)):
        v = raw.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi:
            out[key] = round(float(v), 2)
    for key in ("widthDp", "heightDp"):
        v = raw.get(key)
        if isinstance(v, int) and not isinstance(v, bool) and 0 < v < 20000:
            out[key] = v
    return out or None


# ── A till that may work as a kiosk (§5.10) ──────────────────────────────────

HOME_TILL = "till"


def ensure_home_till_row(db: Session, machine: Any, *, now: Optional[datetime] = None) -> Optional[Any]:
    """
    The kiosk-mode row of a till whose owner allowed it (`kioskTillModeEnabled`), made when the till (or the
    dashboard's `return_kiosk`) first asks for the kiosk mode; None when it may not — the gate is closed, the
    machine is not an assigned fiscal till of a shop, or it is a kiosk already (its row is returned as is).

    Why a row and not a config resolved without one: everything a kiosk does in the cloud — its status,
    its orders, its pickup numbers, its alerts, its commands — hangs on the row. The row is marked
    `home_role = "till"`, and every "is it a kiosk?" decision (role, built-in terminal, remote Z, device
    commands, catalogs, insights…) reads `home_role IS NULL`, so the machine stays a till everywhere a role
    is asked, and nothing changes for any existing row (all NULL). It is made on demand only, never for
    every till the gate covers. The fiscal identity never moves: the same machine, series and Z.
    """
    from app.models.kiosk import KioskDevice
    from app.models.pos_machine import PairingStatus, set_kiosk_cache
    from app.services import display_devices as DD
    from app.services.kiosk_control import _company_of, _clean_name

    existing = db.get(KioskDevice, machine.id)
    if existing is not None:
        return existing
    if not DD.is_fiscal(machine) or not machine.is_active or machine.shop_id is None:
        return None
    if machine.pairing_status != PairingStatus.ASSIGNED:
        return None
    if not effective(db, machine)["enabled"]:
        return None
    row = KioskDevice(
        machine_id=machine.id,
        tenant_id=machine.tenant_id,
        shop_id=machine.shop_id,
        company_id=_company_of(db, machine),
        name=_clean_name(None, machine.name),
        enabled=True,
        paused=False,
        controller_machine_ids=[],
        created_at=now or datetime.now(timezone.utc),
        home_role=HOME_TILL,
    )
    db.add(row)
    db.flush()
    set_kiosk_cache(machine, False)
    return row
