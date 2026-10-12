"""
"סוללה חלשה" — low-battery alerts for any device (docs/SPEC_KIOSK_INSIGHTS.md §6).

The owner: "תבנה התראה למסופון לטאבלט על סוללה חלשה 15, 10, 5 קריטי" — a handheld (or a tablet,
a kiosk with a battery…) running down tells the main till, at 15 %, 10 % and — critical — 5 %.

* **The facts** come on the heartbeat every device already sends (`batteryPercent`,
  `batteryStatus`); `on_heartbeat` runs right after it is stored.
* **The rule** (`step`, pure — the till's domain/BatteryAlerts.kt and the Windows kiosk's
  core/batteryAlerts.ts apply the same one for their own banner and alarm): while discharging,
  the lowest threshold the battery is at or under fires — once per discharge cycle (a level
  already fired in this cycle never fires again); a lower one replaces the higher ("escalated").
  The alert clears when the device charges or climbs `HYSTERESIS` points above its threshold;
  the cycle ends when it charges or climbs `HYSTERESIS` above the highest threshold.
* **The settings** are till parameters (company / shop / point of sale / device):
  `lowBatteryThresholds` ("15,10,5") and `lowBatterySound` (the 2-second alarm, on by default —
  read by the devices themselves).
* **Which devices** ("ניטור סוללה", the owner: "אפשר לבטל מצב סוללה על קופות כי אין בהם סוללות"): the
  till parameter `batteryMonitoring` — "auto" (the default), "on", "off" — decided per device by
  `battery_monitored` from the device's model (`device_is_mains_only`: the SUNMI / iMin desktops,
  the SUNMI K2) and its own `batteryPresent` (Android's EXTRA_PRESENT, on the heartbeat, kept in
  `device_info`). The tills get the answer, "on" or "off" (`apply_to_parameters`). A device not
  watched raises nothing; an open cycle of it ends quietly; the dashboard says "ללא סוללה" /
  "ניטור סוללה כבוי" instead of its battery.
* **To the staff**: the open alerts go to the tills by the kiosk alerts' routing settings
  (`alerts.battery` of the device's kiosk config layers — main till / all / selected, everyone or
  managers; app/services/kiosk_ops.py), with the till's other kiosk alerts (`GET /sync/{m}/kiosk/alerts`):
  "המסופון קופה 2 — סוללה 10%", the critical one marked `severity: critical`. A till's "הבנתי"
  marks it (`battery:<id>`); it clears by itself when the device charges.
* **The dashboard** ("תקינות מכשירים") shows each device's battery and the history (`history`).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.device_battery import DeviceBatteryAlert
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLDS = (15, 10, 5)
#: Points above a threshold the battery must climb (discharging) before its alert clears.
HYSTERESIS = 5
#: A device silent this long: its alert says "as of" (the dashboard), it stays open.
STALE_AFTER = timedelta(minutes=10)
CHARGING_STATUSES = ("charging", "full")
ID_PREFIX = "battery:"

THRESHOLDS_KEY = "lowBatteryThresholds"
SOUND_KEY = "lowBatterySound"
#: "ניטור סוללה": whether a device's battery is watched at all — on the device and in the cloud.
MONITORING_KEY = "batteryMonitoring"
MONITORING_AUTO = "auto"
MONITORING_ON = "on"
MONITORING_OFF = "off"
MONITORING_OPTIONS = (MONITORING_AUTO, MONITORING_ON, MONITORING_OFF)
#: The device's own word on whether it has a battery, kept in `pos_machines.device_info`.
PRESENT_KEY = "batteryPresent"
#: Why a device's battery is not watched (the dashboard's part code): it has none / set off.
REASON_NO_BATTERY = "no_battery"
REASON_MONITORING_OFF = "monitoring_off"
#: How an open alert of a device no longer watched ends (no push, no "recovered").
CLEAR_NOT_MONITORED = "not_monitored"

BATTERY_PARAMETER_SPECS = (
    dict(
        key=THRESHOLDS_KEY,
        label="סוללה חלשה — ספי התראה (אחוזים)",
        value_type="string",
        default_value="15,10,5",
        description=(
            "באילו אחוזי סוללה המכשיר (מסופון, טאבלט, קיוסק עם סוללה) מתריע — עד שלושה מספרים בין 1 ל-50, "
            "מופרדים בפסיק (ברירת מחדל 15,10,5). הנמוך ביותר הוא קריטי. כל סף מתריע פעם אחת בכל פריקה: על "
            "המכשיר עצמו (פס התראה, ובסף הקריטי התראה אדומה על כל הרוחב) ובקופות שנבחרו ב\"התראות לקופות\" "
            "(\"המסופון קופה 2 — סוללה 10%\"). ההתראה יורדת כשהמכשיר בטעינה או עולה 5% מעל הסף. "
            "לא מוצגת ולא משמיעה צליל באמצע תשלום — מיד אחריו. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או מכשיר."
        ),
    ),
    dict(
        key=SOUND_KEY,
        label="סוללה חלשה — צליל אזעקה",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): כשסף סוללה חלשה מתריע, המכשיר — והקופה שמקבלת את ההתראה — משמיעים צליל "
            "אזעקה של 2 שניות (חזק ודחוף יותר בסף הקריטי), בערוץ ההתראות כך שנשמע גם כשעוצמת המדיה נמוכה. "
            "פעם אחת לכל סף בכל פריקה, ולעולם לא באמצע תשלום (מיד אחריו). כבוי — בלי צליל. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או מכשיר."
        ),
    ),
    dict(
        key=MONITORING_KEY,
        label="ניטור סוללה (סוללה חלשה והתראות)",
        value_type="enum",
        enum_options=MONITORING_OPTIONS,
        default_value=MONITORING_AUTO,
        description=(
            "אוטומטי — רק במכשיר שיש בו סוללה. כבוי — לקופה קבועה בלי סוללה: בלי פס 'סוללה חלשה', "
            "בלי אזעקה ובלי התראות סוללה על המכשיר הזה. פעיל — תמיד"
        ),
    ),
)


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat().replace("+00:00", "Z") if value is not None else None


# ── The rule (pure) ──────────────────────────────────────────────────────────


def parse_thresholds(raw: Any) -> Tuple[int, ...]:
    """"15,10,5" (or a list) → (15, 10, 5): 1–50, distinct, highest first, at most three; else the default."""
    if isinstance(raw, (list, tuple)):
        parts = list(raw)
    elif isinstance(raw, str):
        parts = [p for p in raw.replace(";", ",").split(",")]
    else:
        return DEFAULT_THRESHOLDS
    out = set()
    for p in parts:
        try:
            n = int(str(p).strip())
        except ValueError:
            continue
        if 1 <= n <= 50:
            out.add(n)
    return tuple(sorted(out, reverse=True)[:3]) or DEFAULT_THRESHOLDS


@dataclass
class CycleState:
    """Where a device's discharge cycle stands: the levels fired in it, the one open now."""

    open_cycle: bool = False
    fired: set = field(default_factory=set)
    open_level: Optional[int] = None


@dataclass
class Step:
    """What a reading does: fire `fire` (closing the open one as escalated), clear the open one, end the cycle."""

    fire: Optional[int] = None
    clear: Optional[str] = None
    end_cycle: bool = False


def step(state: CycleState, percent: Optional[int], charging: bool, thresholds: Sequence[int]) -> Step:
    """The rule. A reading with no percent changes nothing."""
    if percent is None:
        return Step()
    levels = sorted({int(t) for t in thresholds}, reverse=True) or list(DEFAULT_THRESHOLDS)
    top = levels[0]
    if charging or percent >= top + HYSTERESIS:
        if not state.open_cycle:
            return Step()
        return Step(clear=("charging" if charging else "recovered") if state.open_level is not None else None, end_cycle=True)
    under = [t for t in levels if percent <= t]
    level_now = min(under) if under else None
    fired = state.fired if state.open_cycle else set()
    # Only ever downwards in a cycle: a level at or above one already fired counts as passed —
    # skipping a level (16 % → 9 %) fires the worse one only, and climbing back never re-fires.
    floor = min(fired) if fired else None
    if level_now is not None and (floor is None or level_now < floor):
        return Step(fire=level_now, clear="escalated" if state.open_level is not None else None)
    if state.open_level is not None and percent >= state.open_level + HYSTERESIS:
        return Step(clear="recovered")
    return Step()


def severity_of(level: int, thresholds: Sequence[int]) -> str:
    return "critical" if level == min(thresholds or DEFAULT_THRESHOLDS) else "warning"


# ── The device's settings ────────────────────────────────────────────────────


def _params_of(db: Session, machine: POSMachine) -> Dict[str, Any]:
    try:
        from app.services.till_parameters import till_parameters_for_machine

        return till_parameters_for_machine(db, machine).parameters
    except Exception:  # noqa: BLE001 - never fail a heartbeat over a setting
        return {}


def settings_of(db: Session, machine: POSMachine, params: Optional[Dict[str, Any]] = None) -> Tuple[Tuple[int, ...], bool]:
    """(thresholds, sound) from the till parameters of the device; the defaults when unset."""
    params = _params_of(db, machine) if params is None else params
    sound = params.get(SOUND_KEY)
    return parse_thresholds(params.get(THRESHOLDS_KEY)), (sound is not False and str(sound).lower() not in ("false", "לא", "0"))


def monitored(db: Session, machine: POSMachine, params: Optional[Dict[str, Any]] = None) -> bool:
    """Whether this device's battery is watched (`batteryMonitoring` of its till parameters)."""
    params = _params_of(db, machine) if params is None else params
    return not_monitored_reason(params.get(MONITORING_KEY), machine) is None


def device_label(db: Session, machine: POSMachine) -> str:
    """"המסופון" / "הטאבלט" / "הקיוסק" / "הקופה" — how the tills name the device."""
    from app.models.kiosk import KioskDevice
    from app.models.pos_machine import DEVICE_MODEL_P18, device_has_builtin_terminal

    if db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id == machine.id).first() is not None:
        return "הקיוסק"
    model = getattr(machine, "device_model", None)
    if model == DEVICE_MODEL_P18 or (model and "tablet" in str(model).lower()):
        return "הטאבלט"
    if device_has_builtin_terminal(model):
        return "המסופון"
    return "הקופה"


def alert_text(label: str, name: str, percent: int, critical: bool) -> str:
    """"המסופון קופה 2 — סוללה 10%", the critical one with "חברו למטען מיד"."""
    head = f"{label} {name}".strip()
    text = f"{head} — סוללה {percent}%"
    return (text + " · קריטי: חברו למטען מיד" if critical else text + " · חברו למטען")[:300]


# ── Which devices are watched ("ניטור סוללה") ────────────────────────────────


def battery_monitored(param: Any, model: Any, battery_present: Optional[bool]) -> bool:
    """
    Whether a device's battery is watched (pure). "on": always; "off": never; "auto" — and an
    unset or unknown value — only on a device that has a battery: not when it says it has none
    (`battery_present` False), nor on a model that runs on mains only (`device_is_mains_only`).
    """
    from app.models.pos_machine import device_is_mains_only

    value = param.strip().lower() if isinstance(param, str) else None
    if value == MONITORING_ON:
        return True
    if value == MONITORING_OFF:
        return False
    if battery_present is False:
        return False
    return not device_is_mains_only(model)


def battery_present_of(machine: Any) -> Optional[bool]:
    """The device's last word on its battery (heartbeat `batteryPresent`); None: never said."""
    info = getattr(machine, "device_info", None)
    value = info.get(PRESENT_KEY) if isinstance(info, dict) else None
    return value if isinstance(value, bool) else None


def not_monitored_reason(param: Any, machine: Any) -> Optional[str]:
    """None while watched; else "no_battery" (it has none) or "monitoring_off" (set off)."""
    model = getattr(machine, "device_model", None)
    present = battery_present_of(machine)
    if battery_monitored(param, model, present):
        return None
    from app.models.pos_machine import device_is_mains_only

    return REASON_NO_BATTERY if present is False or device_is_mains_only(model) else REASON_MONITORING_OFF


def apply_to_parameters(machine: Any, parameters: Dict[str, Any]) -> None:
    """The tills get the answer, never "auto": `batteryMonitoring` resolved to "on" / "off" in place."""
    if MONITORING_KEY not in parameters:
        return  # switched off by a super admin: nothing sent, the till goes by its own battery
    on = battery_monitored(parameters.get(MONITORING_KEY), getattr(machine, "device_model", None), battery_present_of(machine))
    parameters[MONITORING_KEY] = MONITORING_ON if on else MONITORING_OFF


def monitoring_by_machine(db: Session, machines: Iterable[POSMachine]) -> Dict[Any, Optional[str]]:
    """
    `not_monitored_reason` for many devices at once (the dashboard, the tills' alerts): the
    parameter's values read once and resolved per device's chain (till → area → shop → company).
    """
    from app.models.shop import Shop
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import TillScopeChain, resolve_till_parameters

    machines = list(machines)
    if not machines:
        return {}
    parameter, values, companies = None, [], {}
    try:
        parameter = db.query(TillParameter).filter(TillParameter.key == MONITORING_KEY).first()
        if parameter is not None:
            values = db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
        shop_ids = list({m.shop_id for m in machines if m.shop_id is not None})
        if shop_ids:
            companies = dict(db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(shop_ids)).all())
    except Exception:  # noqa: BLE001 - never fail a view over a setting: "auto" then
        logger.exception("battery monitoring lookup failed")
        parameter, values = None, []
    out: Dict[Any, Optional[str]] = {}
    for m in machines:
        raw = None
        if parameter is not None:
            chain = TillScopeChain(
                machine_id=m.id, area_id=getattr(m, "area_id", None), shop_id=m.shop_id, company_id=companies.get(m.shop_id),
            )
            raw = resolve_till_parameters([parameter], values, chain).parameters.get(MONITORING_KEY)
        out[m.id] = not_monitored_reason(raw, m)
    return out


# ── The heartbeat ────────────────────────────────────────────────────────────


def _cycle(db: Session, machine_id) -> Tuple[Optional[DeviceBatteryAlert], List[DeviceBatteryAlert]]:
    latest = (
        db.query(DeviceBatteryAlert)
        .filter(DeviceBatteryAlert.machine_id == machine_id)
        .order_by(DeviceBatteryAlert.raised_at.desc(), DeviceBatteryAlert.created_at.desc())
        .first()
    )
    if latest is None or latest.cycle_ended_at is not None:
        return latest, []
    rows = db.query(DeviceBatteryAlert).filter(DeviceBatteryAlert.cycle_id == latest.cycle_id).all()
    return latest, rows


def evaluate(db: Session, machine: POSMachine, percent: Optional[int], charging: bool,
             thresholds: Sequence[int] = DEFAULT_THRESHOLDS, *, now: Optional[datetime] = None) -> Optional[DeviceBatteryAlert]:
    """One reading applied: the row fired (if one did). The caller commits."""
    now = _now(now)
    latest, rows = _cycle(db, machine.id)
    open_row = next((r for r in rows if r.cleared_at is None), None)
    state = CycleState(open_cycle=bool(rows), fired={r.level for r in rows}, open_level=open_row.level if open_row else None)
    s = step(state, percent, charging, thresholds)
    if open_row is not None and percent is not None:
        open_row.last_percent = percent
    if s.clear and open_row is not None:
        open_row.cleared_at = now
        open_row.clear_reason = s.clear
    if s.end_cycle:
        for r in rows:
            r.cycle_ended_at = now
    fired = None
    if s.fire is not None:
        fired = DeviceBatteryAlert(
            id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, machine_id=machine.id,
            cycle_id=latest.cycle_id if rows and latest is not None else uuid.uuid4(),
            level=s.fire, percent=percent, last_percent=percent,
            severity=severity_of(s.fire, thresholds), raised_at=now,
        )
        db.add(fired)
    db.flush()
    return fired


def end_quietly(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> int:
    """
    A device no longer watched ("ניטור סוללה" off, or it has no battery): its open cycle ends and
    its open alert goes, with no push and no "recovered" — the tills just stop getting it. The rows
    ended. The caller commits.
    """
    now = _now(now)
    _latest, rows = _cycle(db, machine.id)
    for r in rows:
        if r.cleared_at is None:
            r.cleared_at = now
            r.clear_reason = CLEAR_NOT_MONITORED
        r.cycle_ended_at = now
    if rows:
        db.flush()
    return len(rows)


def on_heartbeat(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[DeviceBatteryAlert]:
    """After a heartbeat stored the battery: the rule applied; a new alert wakes its tills. The caller commits."""
    percent = machine.battery_percent
    open_cycle = db.query(DeviceBatteryAlert.id).filter(
        DeviceBatteryAlert.machine_id == machine.id, DeviceBatteryAlert.cycle_ended_at.is_(None)
    ).first() is not None
    if percent is None and not open_cycle:
        return None
    params = _params_of(db, machine)
    # "ניטור סוללה": a till on mains (or set off) raises nothing; what was open ends quietly.
    if not monitored(db, machine, params):
        if open_cycle:
            end_quietly(db, machine, now=now)
        return None
    charging = (machine.battery_status or "") in CHARGING_STATUSES
    thresholds, _sound = settings_of(db, machine, params)
    fired = evaluate(db, machine, percent, charging, thresholds, now=now)
    if fired is not None:
        try:
            from app.services import kiosk_config as KC
            from app.services import kiosk_ops as OPS

            cfg = KC.effective_config(db, machine)
            for till in OPS.targets(db, machine, cfg, "battery"):
                OPS.wake_machine(till, "battery_alert")
        except Exception:  # noqa: BLE001 - the tills fetch on their beat anyway
            logger.exception("battery alert wake-up failed for %s", machine.id)
    return fired


# ── The tills ────────────────────────────────────────────────────────────────


def alert_out(db: Session, row: DeviceBatteryAlert, machine: POSMachine, audience: str, label: Optional[str] = None) -> Dict[str, Any]:
    critical = row.severity == "critical"
    percent = row.last_percent if row.last_percent is not None else row.percent
    label = label or device_label(db, machine)
    return {
        "id": f"{ID_PREFIX}{row.id}",
        "kioskMachineId": str(machine.id),
        "kioskName": machine.name,
        "kind": "battery",
        "key": "battery",
        "reason": "battery_critical" if critical else "battery_low",
        "severity": row.severity,
        "text": alert_text(label, machine.name or "", int(percent), critical),
        "detail": {"percent": int(percent), "level": row.level, "critical": critical, "device": label},
        "raisedAt": _iso(row.raised_at),
        "pingCount": 0,
        "pingedAt": None,
        "acknowledgedAt": _iso(row.acknowledged_at),
        "acknowledgedBy": row.acknowledged_by_name,
        "audience": audience,
    }


def alerts_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The open battery alerts routed to [till] (`alerts.battery`), never its own."""
    from app.services import kiosk_config as KC
    from app.services import kiosk_ops as OPS

    if till.tenant_id is None:
        return []
    rows = (
        db.query(DeviceBatteryAlert)
        .filter(DeviceBatteryAlert.tenant_id == till.tenant_id, DeviceBatteryAlert.cleared_at.is_(None))
        .order_by(DeviceBatteryAlert.raised_at)
        .all()
    )
    out: List[Dict[str, Any]] = []
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([r.machine_id for r in rows])).all()} if rows else {}
    # A device set to "ניטור סוללה: כבוי" since its alert opened: gone at once, before its next beat ends it.
    unwatched = {mid for mid, reason in monitoring_by_machine(db, machines.values()).items() if reason is not None}
    for row in rows:
        source = machines.get(row.machine_id)
        if source is None or source.id == till.id or not source.is_active or source.id in unwatched:
            continue
        try:
            cfg = KC.effective_config(db, source)
            if till.id not in {m.id for m in OPS.targets(db, source, cfg, "battery")}:
                continue
            out.append(alert_out(db, row, source, OPS.route_of(cfg, "battery")["audience"]))
        except Exception:  # noqa: BLE001 - an alert never fails the till's fetch
            logger.exception("battery alert routing failed for %s", row.machine_id)
    return out


def acknowledge(db: Session, till: POSMachine, alert_id: str, *, pos_user_name: Optional[str] = None,
                now: Optional[datetime] = None) -> Dict[str, Any]:
    """"הבנתי" on a battery alert routed to [till]: marked, still open until the device charges."""
    from app.services import kiosk_config as KC
    from app.services import kiosk_ops as OPS

    now = _now(now)
    try:
        rid = uuid.UUID(str(alert_id)[len(ID_PREFIX):])
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    row = db.get(DeviceBatteryAlert, rid)
    source = db.get(POSMachine, row.machine_id) if row is not None else None
    if row is None or source is None or row.tenant_id != till.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    # Another point of sale's device, while this till is locked to its own (app/services/area_lock.py).
    from app.services import area_lock

    area_lock.require_shared_device(db, till, source, "device")
    cfg = KC.effective_config(db, source)
    if till.id not in {m.id for m in OPS.targets(db, source, cfg, "battery")}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    if row.acknowledged_at is None:
        name = (pos_user_name or "").strip()[:100]
        row.acknowledged_at = now
        row.acknowledged_by_name = (f"{name} · {till.name}" if name and till.name else (name or till.name or "קופה"))[:200]
    db.flush()
    return alert_out(db, row, source, OPS.route_of(cfg, "battery")["audience"])


# ── The dashboard ────────────────────────────────────────────────────────────


def battery_of(machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """A device's battery as last reported (null: never reported), "as of" when it is old."""
    now = _now(now)
    if machine.battery_percent is None and not machine.battery_status:
        return None
    at = _aware(getattr(machine, "last_health_report_at", None)) or _aware(machine.last_heartbeat_at)
    return {
        "percent": machine.battery_percent,
        "status": machine.battery_status,
        "charging": (machine.battery_status or "") in CHARGING_STATUSES,
        "reportedAt": _iso(at),
        "stale": at is None or now - at >= STALE_AFTER,
    }


def open_by_machine(db: Session, machine_ids: Iterable[Any]) -> Dict[Any, DeviceBatteryAlert]:
    ids = list(machine_ids)
    if not ids:
        return {}
    return {
        r.machine_id: r
        for r in db.query(DeviceBatteryAlert)
        .filter(DeviceBatteryAlert.machine_id.in_(ids), DeviceBatteryAlert.cleared_at.is_(None))
        .all()
    }


def history(db: Session, machine_ids: Iterable[Any], *, limit: int = 30) -> List[Dict[str, Any]]:
    """The last low-battery events of these devices, newest first."""
    ids = list(machine_ids)
    if not ids:
        return []
    rows = (
        db.query(DeviceBatteryAlert)
        .filter(DeviceBatteryAlert.machine_id.in_(ids))
        .order_by(DeviceBatteryAlert.raised_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": str(r.id), "machineId": str(r.machine_id), "level": r.level, "percent": r.percent,
            "lastPercent": r.last_percent, "severity": r.severity, "raisedAt": _iso(r.raised_at),
            "clearedAt": _iso(r.cleared_at), "clearReason": r.clear_reason, "acknowledgedBy": r.acknowledged_by_name,
        }
        for r in rows
    ]
