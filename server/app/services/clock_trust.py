"""
"שעון המכשיר" — trusted time and the clock auto-fix (the owner, 17.10.2026: "האם יש דרך לתקן את השעה באנדרואיד כשהתוכנה
מזהה בעיה בשעה, וגם בווינדוס אוטומטית?" — fiscal documents must carry the right time).

The rule lives on the devices (pos-android domain/ClockTrust.kt, kiosk-desktop core/clockTrust.ts) and is pinned by the
shared golden `clock_trust_golden.json` (tests/fixtures here, same bytes on both devices); this module keeps its words.

* **Trusted time.** Every heartbeat measures the device clock against this server's `Date` (`clockSkewMs`, device minus
  server, kept on `pos_machines.clock_skew_ms` as before). From 90 s of skew a device stamps documents, shifts, Zs and the
  business date with the server-corrected time — only from an answer over TLS, and only while its wall clock was not
  stepped since the measurement. A sale is never blocked.
* **The auto-fix** — the till parameter `clockAutoFix` (boolean, on by default; per company / shop / point of sale /
  till): an Android till that is the device owner turns automatic time on, then — if the clock is still off after three
  minutes — sets the server's time (Android 9+); a Windows app that already runs as an administrator fixes it itself (the
  Windows Time service and the server's time). Otherwise the staff are told (Android: a button to the date settings;
  Windows: the technician's "תיקון שעון", through the UAC prompt). Never more than once per half hour, never during a
  payment, never from an unverified answer.
* **The report** — every beat may carry `clockTrust: {source, reason, offsetMs, autoFix, autoFixEnabled, autoTime,
  pending, pendingReason, lastFixAt, lastFixAction, lastFixResult, lastFixFromMs}`, cleaned here key by key (never a
  422) and kept in `pos_machines.device_info["clockTrust"]`, stamped `reportedAt` — no column of its own.
* **The alert** — "שעון המכשיר לא מדויק" (exception kind `till_clock`, app/services/exception_alerts/status_watch.py): a
  till with an open shift, heard from, whose clock is off by the rule's `minutes` (5 by default) or more. High when the
  device still stamps its own wrong time (an older build, or no verified answer), medium when it already stamps the
  server's. Closed by itself when the clock is right again.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

CLOCK_AUTO_FIX_KEY = "clockAutoFix"
CLOCK_AUTO_FIX_DEFAULT = True

INFO_KEY = "clockTrust"

#: The golden's vocabulary (`clock_trust_golden.json` → `vocabulary`).
SOURCES = ("device", "server")
TRUST_REASONS = ("none", "insecure", "small", "stepped", "applied")
CAPABILITIES = ("device_owner", "elevated", "none")
ACTIONS = ("none", "enable_auto_time", "set_time", "prompt")
FIX_REASONS = (
    "unknown", "ok", "insecure", "stale", "off", "manual", "busy", "auto_time_off", "waiting_network_time", "sdk",
    "cooldown", "fix",
)
RESULTS = ("ok", "failed", "refused")

#: The devices' threshold: from here on documents follow the server's clock.
TRUST_MS = 90_000

CAPABILITY_LABELS = {"device_owner": "בעלות מכשיר (אנדרואיד)", "elevated": "הרשאות מנהל (Windows)", "none": "ידני"}
RESULT_LABELS = {"ok": "הצליח", "failed": "נכשל", "refused": "לא אושר"}

PARAMETER_SPECS = (
    dict(
        key=CLOCK_AUTO_FIX_KEY,
        label="תיקון שעון אוטומטי",
        value_type="boolean",
        default_value=CLOCK_AUTO_FIX_DEFAULT,
        description=(
            "כששעון המכשיר רחוק משעון השרת ב-90 שניות או יותר, המסמכים, המשמרות וה-Z נחתמים תמיד לפי שעון השרת "
            "(גם כשהפרמטר כבוי), והמכירה לא נחסמת. דלוק (ברירת מחדל): המכשיר גם מתקן את השעון שלו בעצמו כשהוא יכול — "
            "קופת אנדרואיד ב\"נעילת קופה\" (בעלות מכשיר) מפעילה שעה אוטומטית מהרשת, ואם השעון עדיין לא נכון אחרי 3 "
            "דקות מכוונת אותו לפי השרת (אנדרואיד 9 ומעלה); מחשב Windows שהאפליקציה רצה בו בהרשאות מנהל מפעיל את "
            "שירות השעה של Windows ומכוון לפי השרת. לכל היותר פעם בחצי שעה, לעולם לא באמצע תשלום, ורק לפי תשובה "
            "מאומתת (TLS) מהשרת. במכשיר בלי הרשאות כאלה — באנדרואיד מוצגת לצוות התראה עם כפתור להגדרות תאריך ושעה, "
            "וב-Windows הטכנאי לוחץ \"תיקון שעון\" (Windows מבקש אישור מנהל). כבוי: המכשיר לא משנה את השעון שלו. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


def _str(value: Any, choices) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    return text if text in choices else None


def _int(value: Any, bound: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        n = int(value)
    except (OverflowError, ValueError):
        return None
    return n if -bound <= n <= bound else None


def _stamp(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()[:40]
    return text or None


#: A device off by a few decades still reports; anything past ~±300 years is noise.
_MS_BOUND = 10**13


def clean_report(block: Any) -> Optional[Dict[str, Any]]:
    """The report as kept: known keys only, each typed and cut. None when nothing usable. Never raises."""
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True, exclude_none=True)
    if not isinstance(block, dict):
        return None
    out = {
        "source": _str(block.get("source"), SOURCES),
        "reason": _str(block.get("reason"), TRUST_REASONS),
        "offsetMs": _int(block.get("offsetMs"), _MS_BOUND),
        "autoFix": _str(block.get("autoFix"), CAPABILITIES),
        "autoFixEnabled": block.get("autoFixEnabled") if isinstance(block.get("autoFixEnabled"), bool) else None,
        "autoTime": block.get("autoTime") if isinstance(block.get("autoTime"), bool) else None,
        "pending": _str(block.get("pending"), ACTIONS),
        "pendingReason": _str(block.get("pendingReason"), FIX_REASONS),
        "lastFixAt": _stamp(block.get("lastFixAt")),
        "lastFixAction": _str(block.get("lastFixAction"), ACTIONS),
        "lastFixResult": _str(block.get("lastFixResult"), RESULTS),
        "lastFixFromMs": _int(block.get("lastFixFromMs"), _MS_BOUND),
    }
    cleaned = {k: v for k, v in out.items() if v is not None}
    return cleaned or None


def apply_heartbeat(machine: Any, block: Any, *, now: Optional[datetime] = None) -> None:
    """The beat's `clockTrust` into `device_info["clockTrust"]`. Absent: as it was. Never raises."""
    try:
        report = clean_report(block)
        if report is None:
            return
        before = report_of(machine) or {}
        if report.get("lastFixAt") and report.get("lastFixAt") != before.get("lastFixAt"):
            logger.info(
                "machine %s changed its clock: %s %s (from %s ms)",
                getattr(machine, "id", None), report.get("lastFixAction"), report.get("lastFixResult"),
                report.get("lastFixFromMs"),
            )
        stamped = {**report, "reportedAt": (now or datetime.now(timezone.utc)).isoformat()}
        info = machine.device_info if isinstance(machine.device_info, dict) else {}
        machine.device_info = {**info, INFO_KEY: stamped}
    except Exception:  # noqa: BLE001 - a status block never fails a heartbeat
        logger.exception("clock trust report not applied for %s", getattr(machine, "id", None))


def report_of(machine: Any) -> Optional[Dict[str, Any]]:
    """The last report as kept, or None (an older build, or never sent)."""
    info = getattr(machine, "device_info", None)
    report = info.get(INFO_KEY) if isinstance(info, dict) else None
    return report if isinstance(report, dict) else None


def corrected(machine: Any) -> bool:
    """The device stamps documents with the server's time now (its last report)."""
    return (report_of(machine) or {}).get("source") == "server"


def status_of_machine(machine: Any) -> Optional[Dict[str, Any]]:
    """
    `{source, offsetMs, autoFix, autoFixEnabled, autoTime, pending, pendingReason, lastFix, reportedAt}` for the
    dashboard; None when the device never reported (an older build: the skew alone, as before).
    """
    report = report_of(machine)
    if not report:
        return None
    last_fix = None
    if report.get("lastFixAt"):
        last_fix = {
            "at": report.get("lastFixAt"),
            "action": report.get("lastFixAction"),
            "result": report.get("lastFixResult"),
            "fromMs": report.get("lastFixFromMs"),
        }
    return {
        "source": report.get("source") or "device",
        "reason": report.get("reason"),
        "offsetMs": report.get("offsetMs") or 0,
        "autoFix": report.get("autoFix") or "none",
        "autoFixEnabled": report.get("autoFixEnabled"),
        "autoTime": report.get("autoTime"),
        "pending": report.get("pending"),
        "pendingReason": report.get("pendingReason"),
        "lastFix": last_fix,
        "reportedAt": report.get("reportedAt"),
    }


def machine_fields(machine: Any) -> Dict[str, Any]:
    return {"clockTrust": status_of_machine(machine)}


def skew_words(skew_ms: int) -> str:
    """"מקדים ב-7 דקות" / "מאחר ב-3 שעות" (the alert's summary)."""
    ms = abs(int(skew_ms))
    direction = "מקדים" if skew_ms > 0 else "מאחר"
    if ms < 2 * 3_600_000:
        return f"{direction} ב-{max(1, round(ms / 60_000))} דקות"
    if ms < 2 * 86_400_000:
        return f"{direction} ב-{round(ms / 3_600_000)} שעות"
    return f"{direction} ב-{round(ms / 86_400_000)} ימים"
