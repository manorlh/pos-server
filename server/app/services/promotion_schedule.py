"""
When a promotion runs, as instants (docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1, "Happy hour").

A promotion's schedule is local and recurring: dates (`valid_from` … `valid_to`, inclusive,
either open), weekdays (0 = Sunday … 6 = Saturday; none: every day) and an hour window
(`start_time` → `end_time`, "HH:MM"; none: the whole day). A window whose end is before its
start crosses midnight, and the hours after midnight belong to the day it started — that
day's weekday and date decide. The tills evaluate this on their own clocks; the cloud needs
it as instants for what happens *at* the start and the end (the announcement to the
cashiers) and to tell whether two schedules overlap.

Local wall times become instants through the zone's rules (zoneinfo): 16:00 is 13:00 UTC
in Israel's summer and 14:00 in its winter, and a window on the night the clocks change is
as long as the clocks say. Pure; no database.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, List, Optional, Sequence, Tuple

#: How far a search for the next / an overlapping occurrence looks.
HORIZON_DAYS = 400


def weekday_of(d: date) -> int:
    """0 = Sunday … 6 = Saturday (the promotions' and the till messages' numbering)."""
    return (d.weekday() + 1) % 7


def _hhmm(value: Optional[str]) -> Optional[time]:
    if not value:
        return None
    hour, minute = (int(x) for x in str(value)[:5].split(":"))
    return time(hour, minute)


@dataclass(frozen=True)
class Schedule:
    valid_from: Optional[date] = None
    valid_to: Optional[date] = None
    weekdays: Optional[Tuple[int, ...]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None

    @classmethod
    def of(cls, promotion) -> "Schedule":
        days = getattr(promotion, "weekdays", None)
        return cls(
            valid_from=getattr(promotion, "valid_from", None),
            valid_to=getattr(promotion, "valid_to", None),
            weekdays=tuple(sorted(int(d) for d in days)) if days else None,
            start_time=getattr(promotion, "start_time", None),
            end_time=getattr(promotion, "end_time", None),
        )

    def runs_on(self, d: date) -> bool:
        if self.valid_from is not None and d < self.valid_from:
            return False
        if self.valid_to is not None and d > self.valid_to:
            return False
        return not self.weekdays or weekday_of(d) in self.weekdays

    def occurrence(self, d: date, tz) -> Tuple[datetime, datetime]:
        """The instants of the occurrence that belongs to local day `d` (whether it runs or not)."""
        start, end = _hhmm(self.start_time), _hhmm(self.end_time)
        if start is None or end is None:
            begins = datetime.combine(d, time(0, 0), tzinfo=tz)
            ends = datetime.combine(d + timedelta(days=1), time(0, 0), tzinfo=tz)
        else:
            begins = datetime.combine(d, start, tzinfo=tz)
            ends = datetime.combine(d + timedelta(days=1) if end <= start else d, end, tzinfo=tz)
        return begins.astimezone(timezone.utc), ends.astimezone(timezone.utc)


def occurrences(schedule: Schedule, tz, since: datetime, until: datetime) -> List[Tuple[datetime, datetime]]:
    """Every occurrence that overlaps [since, until), as UTC instants, in order."""
    out: List[Tuple[datetime, datetime]] = []
    # The day before too: its window may cross into `since`.
    d = since.astimezone(tz).date() - timedelta(days=1)
    last = until.astimezone(tz).date()
    while d <= last:
        if schedule.runs_on(d):
            begins, ends = schedule.occurrence(d, tz)
            if begins < until and ends > since:
                out.append((begins, ends))
        d += timedelta(days=1)
    return out


def current_or_next(schedule: Schedule, tz, now: datetime) -> Optional[Tuple[datetime, datetime]]:
    """The occurrence under way at `now`, else the next one; None when the schedule is over."""
    d = now.astimezone(tz).date() - timedelta(days=1)
    if schedule.valid_from is not None and schedule.valid_from > d:
        d = schedule.valid_from
    for _ in range(HORIZON_DAYS):
        if schedule.valid_to is not None and d > schedule.valid_to:
            return None
        if schedule.runs_on(d):
            begins, ends = schedule.occurrence(d, tz)
            if ends > now:
                return begins, ends
        d += timedelta(days=1)
    return None


def final_end(schedule: Schedule, tz) -> Optional[datetime]:
    """When the last occurrence ends; None for a schedule without an end date (or that never runs)."""
    if schedule.valid_to is None:
        return None
    d = schedule.valid_to
    for _ in range(8):
        if schedule.valid_from is not None and d < schedule.valid_from:
            return None
        if schedule.runs_on(d):
            return schedule.occurrence(d, tz)[1]
        d -= timedelta(days=1)
    return None


def overlaps(a: Schedule, b: Schedule, tz, *, now: Optional[datetime] = None) -> Optional[Tuple[datetime, datetime]]:
    """
    The first moment both run (from `now`, or from the later start), as the overlapping
    span; None when they never run at the same time. Touching windows (16–18 and 18–20) do
    not overlap.
    """
    starts = [s for s in (a.valid_from, b.valid_from) if s is not None]
    first = max(starts) if starts else None
    ends = [e for e in (a.valid_to, b.valid_to) if e is not None]
    last = min(ends) if ends else None
    if first is not None and last is not None and last < first:
        return None
    origin_day = first or (now.astimezone(tz).date() if now else date.today())
    if now is not None and now.astimezone(tz).date() > origin_day:
        origin_day = now.astimezone(tz).date()
    since = datetime.combine(origin_day - timedelta(days=1), time(0, 0), tzinfo=tz).astimezone(timezone.utc)
    # The weekly pattern repeats: two weeks (and the night that crosses into them) is enough,
    # unless the dates end sooner.
    until_day = origin_day + timedelta(days=15)
    if last is not None and last + timedelta(days=1) < until_day:
        until_day = last + timedelta(days=1)
    until = datetime.combine(until_day + timedelta(days=1), time(0, 0), tzinfo=tz).astimezone(timezone.utc)
    occ_a = occurrences(a, tz, since, until)
    occ_b = occurrences(b, tz, since, until)
    for sa, ea in occ_a:
        for sb, eb in occ_b:
            lo, hi = max(sa, sb), min(ea, eb)
            if lo < hi:
                return lo, hi
    return None


def merge_spans(spans: Iterable[Tuple[int, int, int]]) -> List[Tuple[int, int, int]]:
    """(weekday, from hour, to hour) spans of the same weekday that touch or overlap, merged."""
    out: List[List[int]] = []
    for weekday, lo, hi in sorted(spans):
        if out and out[-1][0] == weekday and lo <= out[-1][2]:
            out[-1][2] = max(out[-1][2], hi)
        else:
            out.append([weekday, lo, hi])
    return [tuple(x) for x in out]


def hour_label(hour: int) -> str:
    return f"{hour % 24:02d}:00"


def schedule_of_slot(weekdays: Sequence[int], from_hour: int, to_hour: int, valid_from: date, weeks: int) -> Schedule:
    """A happy hour: these weekdays, from_hour → to_hour (to_hour 24 = midnight), for `weeks` weeks."""
    return Schedule(
        valid_from=valid_from,
        valid_to=valid_from + timedelta(days=7 * weeks - 1),
        weekdays=tuple(sorted(set(int(d) for d in weekdays))),
        start_time=hour_label(from_hour),
        end_time=hour_label(to_hour),
    )
