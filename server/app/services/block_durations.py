"""
How long a block lasts ("לכמה זמן"): the dialog's choice turned into an absolute end, in the
shop's time zone (Asia/Jerusalem unless the tenant says otherwise), daylight saving included.

* `none`       — "עד שאבטל": no end.
* `minutes`    — the presets (15 דק׳, 30 דק׳, שעה, שעתיים, 4 שעות) and "דקות": now + N minutes,
                 1 to 7 days' worth.
* `time`       — "עד שעה" (HH:MM, local): today at that time; a time that has passed (or is now)
                 rolls to tomorrow and says so (`rolled`), so the dialog can warn.
* `end_of_day` — "עד סוף היום": the next start of the business day — the one day start the
                 whole system uses (04:00, insights' `DEFAULT_DAY_START_HOUR`): a bar's night
                 belongs to the day it began, for blocks, the daily reset and targets alike.

The end is sent to the tills as an absolute instant; each till lifts the block by its own clock,
connected or not. "הארך" adds minutes to the end (`extend`).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

MODES = ("none", "minutes", "time", "end_of_day")
PRESET_MINUTES = (15, 30, 60, 120, 240)
EXTEND_MINUTES = (15, 30, 60)
MAX_MINUTES = 7 * 24 * 60
DEFAULT_ZONE = "Asia/Jerusalem"


def business_day_start() -> str:
    """"HH:00" — when a business day starts, from the one source insights uses."""
    from app.services.insights.service import DEFAULT_DAY_START_HOUR

    return f"{int(DEFAULT_DAY_START_HOUR):02d}:00"


def business_today(now: datetime, zone_name: Optional[str] = None) -> date:
    """The business day `now` is in (local, the day starting at `business_day_start`), DST-safe."""
    zone = zone_of(zone_name)
    start = parse_hhmm(business_day_start())
    local = (now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)).astimezone(zone)
    return local.date() if now >= _local_at(local.date(), start, zone) else local.date() - timedelta(days=1)

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class DurationRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class End:
    until: Optional[datetime]
    #: "עד שעה" that had passed today, so it is tomorrow's.
    rolled: bool = False
    mode: str = "none"


def zone_of(name: Optional[str]):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(name or DEFAULT_ZONE)
    except Exception:  # noqa: BLE001 - an unreadable zone is Israel's
        return ZoneInfo(DEFAULT_ZONE)


def parse_hhmm(value: Optional[str]) -> Optional[time]:
    if not isinstance(value, str):
        return None
    m = _HHMM.match(value.strip())
    if not m:
        return None
    return time(int(m.group(1)), int(m.group(2)))


def _local_at(day: date, at: time, zone) -> datetime:
    """`day` at wall-clock `at` in `zone`, as UTC; a time that does not exist (spring forward) moves on."""
    local = datetime.combine(day, at).replace(tzinfo=zone)
    # zoneinfo maps a non-existent wall time with fold=0 to the offset before the gap; round-trip
    # it so 02:30 on the night the clocks jump becomes the first real minute after it.
    back = local.astimezone(timezone.utc).astimezone(zone)
    if back.replace(tzinfo=None) != local.replace(tzinfo=None):
        local = back
    return local.astimezone(timezone.utc)


def compute_end(
    mode: str,
    now: datetime,
    *,
    zone_name: Optional[str] = None,
    minutes: Optional[int] = None,
    at: Optional[str] = None,
    day_start: Optional[str] = None,
) -> End:
    """The absolute end of a block chosen now (UTC). Raises DurationRefused on a bad choice."""
    now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    if mode in (None, "", "none"):
        return End(None, False, "none")
    if mode == "minutes":
        if not isinstance(minutes, int) or isinstance(minutes, bool) or not (1 <= minutes <= MAX_MINUTES):
            raise DurationRefused("invalid_minutes", "מספר הדקות חייב להיות בין 1 ל-10080")
        return End((now + timedelta(minutes=minutes)).astimezone(timezone.utc), False, "minutes")
    zone = zone_of(zone_name)
    local_now = now.astimezone(zone)
    if mode == "time":
        hhmm = parse_hhmm(at)
        if hhmm is None:
            raise DurationRefused("invalid_time", "השעה חייבת להיות בתבנית HH:MM")
        end = _local_at(local_now.date(), hhmm, zone)
        if end <= now:
            return End(_local_at(local_now.date() + timedelta(days=1), hhmm, zone), True, "time")
        return End(end, False, "time")
    if mode == "end_of_day":
        start = parse_hhmm(day_start) or parse_hhmm(business_day_start())
        end = _local_at(local_now.date(), start, zone)
        if end <= now:
            end = _local_at(local_now.date() + timedelta(days=1), start, zone)
        return End(end, False, "end_of_day")
    raise DurationRefused("invalid_mode", "בחירת משך לא מוכרת")


def extend(until: Optional[datetime], now: datetime, minutes: int) -> datetime:
    """"הארך": the end moved by `minutes` — from now when it had passed. Raises for an open-ended block."""
    if until is None:
        raise DurationRefused("no_end", "לחסימה הזו אין שעת סיום — אין מה להאריך")
    if not isinstance(minutes, int) or isinstance(minutes, bool) or not (1 <= minutes <= MAX_MINUTES):
        raise DurationRefused("invalid_minutes", "מספר הדקות חייב להיות בין 1 ל-10080")
    until = until if until.tzinfo is not None else until.replace(tzinfo=timezone.utc)
    now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return max(until, now) + timedelta(minutes=minutes)
