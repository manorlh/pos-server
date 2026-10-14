"""
"הפעלה אוטומטית כשהמכשיר נדלק" — on by default (P:/specs/autostart-default.md; the owner, 14.10.2026:
"ברירת מחדל עלייה אוטומטית").

The till already tries to open on every boot (pos-android system/BootReceiver.kt). From Android 10
the system lets it only when one of these holds: the "display over other apps" permission was
granted once on the device (`granted`), the till is the device's home app (`homeApp`), or the till
is the device owner with the home screen fixed — "נעילת קופה" (`deviceOwner`).

* **The setting** (§1): the till parameter `autoStartOnBoot` — boolean, on by default, set per
  company / shop / point of sale / till. Off: the till does not open by itself on boot.
* **The report** (§3): every heartbeat may carry `autostart: {enabled, granted, homeApp,
  deviceOwner, ready}` — `ready` when any of the three holds. Cleaned here key by key (never a
  422) and kept with the device's own facts in `pos_machines.device_info["autostart"]`, stamped
  `reportedAt` — beside `batteryPresent`, no column of its own. A build that does not send it
  leaves the last report as it was; a device that never sent one is unknown — no indicator.
* **The dashboard** ("תקינות מכשירים", the devices list and page): `status_of` — "ready" (and
  how: lock / home / permission), "missing" (on, not ready: "חסר אישור במכשיר"), "off".
* **"בעיות"** (app/services/problems.py, devices group): a low item "פתיחה אוטומטית לא מוכנה" for a
  device whose parameter is on (the cloud's resolution, `enabled_by_machine`) and whose last report
  says `ready: false`. Never for one that has not reported, nor one set off.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

AUTO_START_KEY = "autoStartOnBoot"
AUTO_START_DEFAULT = True

#: Where the last report is kept: `pos_machines.device_info[INFO_KEY]`.
INFO_KEY = "autostart"
#: The report's own keys, all booleans.
REPORT_KEYS = ("enabled", "granted", "homeApp", "deviceOwner", "ready")

STATE_READY = "ready"
STATE_MISSING = "missing"
STATE_OFF = "off"

#: How a ready device opens on boot, most reliable first: "נעילת קופה", "מסך בית", "הרשאה".
VIA_LOCK = "lock"
VIA_HOME = "home"
VIA_PERMISSION = "permission"

STATE_LABELS = {STATE_READY: "מוכן", STATE_MISSING: "חסר אישור במכשיר", STATE_OFF: "כבוי"}
VIA_LABELS = {VIA_LOCK: "נעילת קופה", VIA_HOME: "מסך בית", VIA_PERMISSION: "הרשאה"}

PROBLEM_KIND = "autostart_not_ready"
PROBLEM_TITLE = "פתיחה אוטומטית לא מוכנה"
PROBLEM_DETAIL = "חסר אישור במכשיר: המכשיר לא ייפתח לבד כשהוא נדלק"

PARAMETER_SPECS = (
    dict(
        key=AUTO_START_KEY,
        label="הפעלה אוטומטית כשהמכשיר נדלק",
        value_type="boolean",
        default_value=AUTO_START_DEFAULT,
        description=(
            "דלוק (ברירת מחדל): כשהמכשיר נדלק, הקופה נפתחת לבד. באנדרואיד צריך לאשר את זה פעם אחת "
            "במכשיר (\"הצגה מעל אפליקציות אחרות\"), אלא אם הקופה היא מסך הבית של המכשיר או שהמכשיר "
            "ב\"נעילת קופה\". אחרי צימוד הקופה מציגה מסך שמבקש את האישור. מכשיר שעוד לא אושר מופיע "
            "בצהוב ב\"תקינות מכשירים\" ובמסך \"בעיות\". כבוי: הקופה לא נפתחת לבד כשהמכשיר נדלק. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


# ── The heartbeat ────────────────────────────────────────────────────────────


def clean_report(block: Any) -> Optional[Dict[str, bool]]:
    """
    The report as kept: the known keys that are booleans. `ready` the device's own word, else
    worked out from the three ways (§3) when it named any. None when nothing usable was sent.
    Never raises: it rides on the heartbeat, which must never fail.
    """
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True, exclude_none=True)
    if not isinstance(block, dict):
        return None
    out = {k: block[k] for k in REPORT_KEYS if isinstance(block.get(k), bool)}
    if "ready" not in out:
        ways = [out[k] for k in ("granted", "homeApp", "deviceOwner") if k in out]
        if ways:
            out["ready"] = any(ways)
    return out or None


def apply_heartbeat(machine: Any, block: Any, *, now: Optional[datetime] = None) -> None:
    """The beat's `autostart` block into `device_info["autostart"]`. Absent: as it was. Never raises."""
    try:
        report = clean_report(block)
        if report is None:
            return
        stamped = {**report, "reportedAt": (now or datetime.now(timezone.utc)).isoformat()}
        info = machine.device_info if isinstance(machine.device_info, dict) else {}
        # A new dict, so the JSON column sees the change.
        machine.device_info = {**info, INFO_KEY: stamped}
    except Exception:  # noqa: BLE001 - a status block never fails a heartbeat
        logger.exception("autostart report not applied for %s", getattr(machine, "id", None))


def report_of(machine: Any) -> Optional[Dict[str, Any]]:
    """The last report as kept, or None (an older build, or never sent)."""
    info = getattr(machine, "device_info", None)
    report = info.get(INFO_KEY) if isinstance(info, dict) else None
    return report if isinstance(report, dict) else None


# ── What the dashboard shows ─────────────────────────────────────────────────


def status_of(report: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    `{state, via, reportedAt}` for the indicator: "off" (the device has it off), "ready" with how
    it opens, "missing" (on, not ready). None when unknown — no report, or one that says neither
    `enabled` nor `ready`.
    """
    if not isinstance(report, dict):
        return None
    enabled, ready = report.get("enabled"), report.get("ready")
    reported_at = report.get("reportedAt") if isinstance(report.get("reportedAt"), str) else None
    if enabled is False:
        return {"state": STATE_OFF, "via": None, "reportedAt": reported_at}
    if ready is True:
        via = (
            VIA_LOCK if report.get("deviceOwner") is True
            else VIA_HOME if report.get("homeApp") is True
            else VIA_PERMISSION if report.get("granted") is True
            else None
        )
        return {"state": STATE_READY, "via": via, "reportedAt": reported_at}
    if ready is False:
        return {"state": STATE_MISSING, "via": None, "reportedAt": reported_at}
    return None


def status_of_machine(machine: Any) -> Optional[Dict[str, Any]]:
    return status_of(report_of(machine))


def machine_fields(machine: Any) -> Dict[str, Any]:
    """The devices list's and the device page's `autoStart` (null: unknown, no indicator)."""
    return {"autoStart": status_of_machine(machine)}


def label(status: Optional[Dict[str, Any]]) -> Optional[str]:
    """"מוכן · הרשאה" / "חסר אישור במכשיר" / "כבוי" — None when unknown."""
    if not status:
        return None
    text = STATE_LABELS.get(status.get("state"))
    via = VIA_LABELS.get(status.get("via")) if status.get("via") else None
    return f"{text} · {via}" if text and via else text


# ── The cloud's resolution of the parameter ──────────────────────────────────


def enabled_by_machine(db: Session, machines: Iterable[Any]) -> Dict[Any, bool]:
    """
    `autoStartOnBoot` for many devices at once: the parameter's values read once and resolved per
    device's chain (till → area → shop → company). On (the default) when the parameter is missing
    or switched off by a super admin — a till that is sent nothing keeps its own default, on.
    """
    from app.models.shop import Shop
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import TillScopeChain, resolve_till_parameters

    machines = list(machines)
    if not machines:
        return {}
    parameter, values, companies = None, [], {}
    try:
        parameter = db.query(TillParameter).filter(TillParameter.key == AUTO_START_KEY).first()
        if parameter is not None:
            values = db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
        shop_ids = list({m.shop_id for m in machines if m.shop_id is not None})
        if shop_ids:
            companies = dict(db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(shop_ids)).all())
    except Exception:  # noqa: BLE001 - never fail a view over a setting: the default then
        logger.exception("autostart parameter lookup failed")
        parameter, values = None, []
    out: Dict[Any, bool] = {}
    for m in machines:
        value = None
        if parameter is not None:
            chain = TillScopeChain(
                machine_id=m.id, area_id=getattr(m, "area_id", None), shop_id=m.shop_id, company_id=companies.get(m.shop_id),
            )
            value = resolve_till_parameters([parameter], values, chain).parameters.get(AUTO_START_KEY)
        out[m.id] = value if isinstance(value, bool) else AUTO_START_DEFAULT
    return out


def not_ready(db: Session, machines: Iterable[Any]) -> List[Any]:
    """
    The devices "בעיות" lists: the parameter on, and the last report says `ready: false`. A device
    that never reported (an older APK) is unknown, never listed.
    """
    candidates = [m for m in machines if (report_of(m) or {}).get("ready") is False]
    if not candidates:
        return []
    enabled = enabled_by_machine(db, candidates)
    return [m for m in candidates if enabled.get(m.id, AUTO_START_DEFAULT)]
