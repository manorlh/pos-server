"""
"נעילה למכירה" and "פתיחה אוטומטית" for a self-order kiosk (docs/SPEC_KIOSK.md §15) — the
pure rules, mirrored on the kiosk (domain/KioskSchedule.kt) and in the dashboard
(client/src/lib/kioskConfig.ts):

* the opening hours (`hours`): a range with a closing time is open between them on its days
  (past midnight belongs to the day it opened); a range **without** a closing time only
  opens — it never closes the kiosk by itself (a lock or the next day's close does);
* the next automatic opening, in the kiosk's local time, across midnight and DST (a time the
  clock skips is the moment after the gap, as java.time does; a time it repeats is the first);
* the lock's end: by hand, at HH:MM today, after N minutes, or at the next automatic opening;
* whether a schedule and the automatic Z agree: close → Z → open, never a Z while open.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

LOCK_MODES = ("manual", "time", "minutes", "next_open")
MINUTES_MAX = 24 * 60


def minutes_of(value: Any) -> Optional[int]:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    try:
        h, m = int(value[:2]), int(value[3:])
    except ValueError:
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _ranges(hours: Any) -> List[Tuple[set, int, Optional[int]]]:
    out = []
    for r in (hours or {}).get("ranges") or []:
        if not isinstance(r, dict):
            continue
        start = minutes_of(r.get("open"))
        if start is None:
            continue
        close = r.get("close")
        end = minutes_of(close) if close not in (None, "") else None
        if close not in (None, "") and end is None:
            continue
        out.append(({d for d in (r.get("days") or []) if isinstance(d, int) and 0 <= d <= 6}, start, end))
    return out


def day_of(local: datetime) -> int:
    """0 = Sunday, as the config numbers days."""
    return (local.weekday() + 1) % 7


def is_open(hours: Any, local: datetime) -> bool:
    """Whether the hours let the kiosk take orders at a local time (no hours: always)."""
    if not (hours or {}).get("enabled"):
        return True
    ranges = _ranges(hours)
    if not ranges:
        return True
    # A range with no closing time never closes the kiosk by itself.
    if any(end is None for _days, _start, end in ranges):
        return True
    day = day_of(local)
    yesterday = (day + 6) % 7
    minute = local.hour * 60 + local.minute
    for days, start, end in ranges:
        if start < end and day in days and start <= minute < end:
            return True
        if start > end and ((day in days and minute >= start) or (yesterday in days and minute < end)):
            return True
    return False


def local_instant(day: date, minute: int, zone) -> datetime:
    """
    The instant a local wall time names. In a DST gap: shifted later by the gap (02:30 on a
    spring-forward night is 03:30), as java.time does; in an overlap: the first (fold 0).
    """
    wall = datetime.combine(day, time(minute // 60, minute % 60)).replace(tzinfo=zone, fold=0)
    return wall.astimezone(timezone.utc).astimezone(zone)


def next_opening(hours: Any, now_local: datetime) -> Optional[datetime]:
    """The next automatic opening strictly after `now_local` (aware), or None with no hours."""
    if not (hours or {}).get("enabled"):
        return None
    ranges = _ranges(hours)
    if not ranges:
        return None
    zone = now_local.tzinfo
    best: Optional[datetime] = None
    for offset in range(0, 8):
        day = now_local.date() + timedelta(days=offset)
        weekday = (day.weekday() + 1) % 7
        for days, start, _end in ranges:
            if weekday not in days:
                continue
            at = local_instant(day, start, zone)
            if at > now_local and (best is None or at < best):
                best = at
        if best is not None and best.date() <= day:
            break
    return best


class LockRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code, self.message = code, message


def lock_until(
    mode: Optional[str],
    *,
    now: datetime,
    zone,
    until_time: Optional[str] = None,
    minutes: Optional[int] = None,
    hours: Any = None,
) -> Optional[datetime]:
    """When a lock asked now lifts by itself (UTC); None: by hand only. Raises LockRefused."""
    mode = mode or "manual"
    if mode not in LOCK_MODES:
        raise LockRefused("invalid_lock_mode", "אופן הנעילה אינו מוכר.")
    if mode == "manual":
        return None
    if mode == "minutes":
        if not isinstance(minutes, int) or isinstance(minutes, bool) or not 1 <= minutes <= MINUTES_MAX:
            raise LockRefused("invalid_minutes", "מספר הדקות חייב להיות בין 1 ל-1440.")
        return now + timedelta(minutes=minutes)
    local_now = now.astimezone(zone)
    if mode == "time":
        minute = minutes_of(until_time)
        if minute is None:
            raise LockRefused("invalid_until_time", "השעה חייבת להיות בתבנית HH:MM.")
        at = local_instant(local_now.date(), minute, zone)
        if at <= local_now:
            raise LockRefused("until_passed", f"השעה {until_time} כבר עברה היום. בחרו שעה מאוחרת יותר, או נעילה עד פתיחה ידנית.")
        return at.astimezone(timezone.utc)
    at = next_opening(hours, local_now)
    if at is None:
        raise LockRefused("no_schedule", "לקיוסק לא הוגדרה פתיחה אוטומטית. הגדירו שעת פתיחה, או בחרו אופן נעילה אחר.")
    return at.astimezone(timezone.utc)


def lock_active(paused: bool, until: Optional[datetime], now: datetime) -> bool:
    """A lock with an end holds until then — on the kiosk's own clock too (offline)."""
    return bool(paused) and (until is None or now < until)


def schedule_issues(hours: Any, auto_close_at: Optional[str]) -> List[Dict[str, str]]:
    """
    Whether a schedule and the automatic Z agree — close → Z → open: the Z never runs while
    the kiosk is open by its hours, nor at an opening time. Empty: consistent.
    """
    issues: List[Dict[str, str]] = []
    if not (hours or {}).get("enabled"):
        return issues
    z = minutes_of(auto_close_at)
    ranges = _ranges(hours)
    if z is None or not ranges:
        return issues
    if any(start == z for days, start, _end in ranges if days):
        issues.append({"code": "auto_z_at_opening", "message": f"ה-Z האוטומטי ({_hhmm(z)}) באותה שעה כמו הפתיחה. קבעו אותו אחרי הסגירה."})
        return issues
    closing = [(days, start, end) for days, start, end in ranges if end is not None]
    if not closing or len(closing) != len(ranges):
        return issues  # a range that never closes: the Z runs while open by design
    probe_days = [(datetime(2026, 1, 4) + timedelta(days=d)) for d in range(7)]  # 4.1.2026 is a Sunday
    for d in probe_days:
        local = d.replace(hour=z // 60, minute=z % 60)
        if is_open(hours, local):
            issues.append({
                "code": "auto_z_while_open",
                "message": f"ה-Z האוטומטי ({_hhmm(z)}) נופל בזמן שהקיוסק פתוח. קבעו אותו בשעת הסגירה או אחריה.",
            })
            break
    return issues


def simple_schedule(body: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[str]]:
    """
    The controlling till's / dashboard's "פתיחה אוטומטית" form → (`hours`, `autoCloseAt`):
    `{enabled, days, open, close?, autoCloseAt?}`. With a closing time and no Z time, the Z
    runs at the close (close → Z → open). `autoCloseAt` None: left as it is.
    """
    enabled = bool(body.get("enabled"))
    days = sorted({d for d in (body.get("days") or [0, 1, 2, 3, 4, 5, 6]) if isinstance(d, int) and 0 <= d <= 6})
    rng: Dict[str, Any] = {"days": days or [0, 1, 2, 3, 4, 5, 6], "open": body.get("open"), "close": body.get("close") or None}
    hours = {"enabled": enabled, "ranges": [rng]}
    auto = body.get("autoCloseAt")
    if auto is None and enabled and rng["close"]:
        auto = rng["close"]
    return hours, auto
