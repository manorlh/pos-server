"""
The terminal status light.

One resolver, server-side, because "is this till online" was being decided in two
places with the same ninety-second constant copied into each — the old close-day and the
dashboard's machines page. Two copies of a threshold is one refactor away from a
dashboard that says a terminal is reachable while the close-day gate says it is not.

**Primary status is a single value with strict precedence**, not a set of independent
lights. The four colours a merchant expects (online-and-synced, online-with-pending,
offline, closed) do not sit on one axis: the first three describe connectivity and sync,
the fourth describes the shift. A terminal can be offline *and* holding unsynced
sales, which in a four-state model shows the same red as a tidy powered-off till while
being the single most alarming state there is — money on a device nobody can reach.

So the order below is by what the manager has to *do*, with one deliberate exception:
`NO_OPEN_SHIFT` outranks `OFFLINE`. A till that has closed its shift and been switched off
is behaving correctly and must not look like a fault; the shop would learn to ignore a
row of red lights every evening, which is how a real outage gets missed.

`OFFLINE_WITH_UNSYNCED` still outranks `NO_OPEN_SHIFT`, because undelivered documents with
no shift open mean a close that drained less than it should have — anomalous whatever the
shift says.

Secondary flags never change the colour. They are for things worth showing next to a
terminal that is otherwise fine: a clock that has drifted, a catalog it has not pulled,
a shift it left open, closed shifts no Z has taken yet. Folding those into the light would make the light mean nothing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

#: How long after its last heartbeat a terminal is still considered online.
#:
#: The till beats on a timer well inside this. The window is a compromise that cannot be
#: escaped by any amount of logic: a terminal that dies one second after a beat looks
#: healthy until the window lapses. Widening it hides outages, narrowing it turns an
#: ordinary missed beat into a false alarm.
ONLINE_WINDOW_SEC = 90


class MachineStatus:
    """Primary status values, highest precedence first."""

    NOT_PAIRED = "not_paired"
    RETIRED = "retired"
    OFFLINE_WITH_UNSYNCED = "offline_with_unsynced"
    NO_OPEN_SHIFT = "no_open_shift"
    OFFLINE = "offline"
    PENDING_SYNC = "pending_sync"
    SHIFT_CLOSE_PENDING = "shift_close_pending"
    ONLINE = "online"


class MachineFlag:
    """Secondary conditions. Shown beside the status; never instead of it."""

    SHIFT_OPEN_PAST_ITS_DATE = "shift_open_past_its_date"
    #: Closed shifts that no Z has taken, from a business date before today.
    CLOSED_SHIFTS_AWAITING_Z = "closed_shifts_awaiting_z"
    CATALOG_BEHIND = "catalog_behind"
    CLOCK_SKEWED = "clock_skewed"
    LOW_BATTERY = "low_battery"
    REALTIME_DOWN = "realtime_down"


#: Beyond this, a document's timestamps land in the wrong shift or date often enough to
#: matter. Two minutes is far more drift than NTP ever leaves and far less than the
#: window in which a receipt's time would look wrong to a customer.
CLOCK_SKEW_TOLERANCE_MS = 120_000

LOW_BATTERY_PERCENT = 15


@dataclass
class StatusInput:
    """Everything the resolver reads. Deliberately plain values, not an ORM row."""

    is_active: bool = True
    pairing_status: Optional[str] = None
    last_heartbeat_at: Optional[datetime] = None
    shift_open: bool = False
    #: The open shift's business date.
    business_date: Optional[date] = None
    close_shift_pending: bool = False
    #: The oldest business date among this till's closed shifts not yet in a Z.
    oldest_awaiting_z_date: Optional[date] = None
    #: The tenant's timezone, which is what "today" means for the date flags.
    timezone_name: Optional[str] = None
    pending_documents: Optional[int] = None
    pending_count: Optional[int] = None
    pending_count_at: Optional[datetime] = None
    catalog_pull_stale: bool = False
    clock_skew_ms: Optional[int] = None
    battery_percent: Optional[int] = None
    mqtt_connected: Optional[bool] = None


@dataclass
class StatusResult:
    status: str
    online: bool
    #: Undelivered documents as last reported, and when that reading was taken. Null
    #: when the terminal has never reported one — which is not the same as zero.
    pending_documents: Optional[int] = None
    pending_as_of: Optional[datetime] = None
    flags: List[str] = field(default_factory=list)


def is_online(last_heartbeat_at: Optional[datetime], *, now: Optional[datetime] = None) -> bool:
    """
    The single definition. Everything that asks "is this terminal reachable" asks here.

    A naive timestamp is read as UTC: every heartbeat is stamped by the server in UTC,
    but a row that has been through a driver which drops tzinfo would otherwise raise on
    the subtraction and take the whole machine list down with it.
    """
    if last_heartbeat_at is None:
        return False
    reference = now or datetime.now(timezone.utc)
    beat = last_heartbeat_at
    if beat.tzinfo is None:
        beat = beat.replace(tzinfo=timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return (reference - beat) <= timedelta(seconds=ONLINE_WINDOW_SEC)


def local_today(timezone_name: Optional[str], *, now: Optional[datetime] = None) -> date:
    """
    Today's date where the shop is, not in UTC.

    A business date is the till's local date, so comparing it with the UTC date left
    yesterday's shift in Israel looking current until 02:00-03:00 local, and the flag
    for a shop east of UTC late by the same margin. An unknown or missing zone falls
    back to UTC rather than failing the machine list.
    """
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    if timezone_name:
        try:
            return reference.astimezone(ZoneInfo(timezone_name)).date()
        except Exception:  # noqa: BLE001 - a bad zone string must not take the list down
            pass
    return reference.astimezone(timezone.utc).date()


def _undelivered(data: StatusInput) -> int:
    """
    Undelivered documents, as last reported.

    Falls back to the whole outbox depth for a till that predates the split, because
    "some outbox rows, kind unknown" is still much closer to the truth than zero. Never
    guesses when the terminal has said nothing at all.
    """
    if data.pending_documents is not None:
        return data.pending_documents
    if data.pending_count is not None:
        return data.pending_count
    return 0


def resolve_status(data: StatusInput, *, now: Optional[datetime] = None) -> StatusResult:
    """The primary status and any secondary flags, from one reading of one terminal."""
    online = is_online(data.last_heartbeat_at, now=now)
    undelivered = _undelivered(data)

    status = _primary(data, online=online, undelivered=undelivered)

    return StatusResult(
        status=status,
        online=online,
        pending_documents=(
            data.pending_documents
            if data.pending_documents is not None
            else data.pending_count
        ),
        pending_as_of=data.pending_count_at,
        flags=_flags(data, now=now),
    )


def _primary(data: StatusInput, *, online: bool, undelivered: int) -> str:
    # A terminal that was never paired has no meaningful connectivity to report, and a
    # retired one is not expected to beat. Both come first so neither shows as a fault.
    if not data.is_active:
        return MachineStatus.RETIRED
    if data.pairing_status != "assigned" or data.last_heartbeat_at is None:
        return MachineStatus.NOT_PAIRED

    # Money on a terminal nobody can reach. Outranks everything below, including no open
    # shift, because undelivered documents after a close mean the close drained less
    # than it claimed.
    if not online and undelivered > 0:
        return MachineStatus.OFFLINE_WITH_UNSYNCED

    # Deliberately above OFFLINE: a till switched off after its shift is correct
    # behaviour, and painting it red every evening trains the shop to ignore red.
    if not data.shift_open:
        return MachineStatus.NO_OPEN_SHIFT

    if not online:
        return MachineStatus.OFFLINE

    if undelivered > 0:
        return MachineStatus.PENDING_SYNC

    # Only once the terminal is otherwise healthy: a queued close is information, not a
    # fault, and it would be a strange thing to show over an unsynced backlog.
    if data.close_shift_pending:
        return MachineStatus.SHIFT_CLOSE_PENDING

    return MachineStatus.ONLINE


def _flags(data: StatusInput, *, now: Optional[datetime]) -> List[str]:
    flags: List[str] = []

    today = local_today(data.timezone_name, now=now)
    # A shift still open on a date that has passed. This is what a dead terminal leaves
    # behind — nothing can close it, and today it is visible only to someone who goes
    # looking for it.
    if data.shift_open and data.business_date is not None:
        if data.business_date < today:
            flags.append(MachineFlag.SHIFT_OPEN_PAST_ITS_DATE)
    # A shop that forgot its Z: closed shifts from an earlier date that no Z has taken.
    if data.oldest_awaiting_z_date is not None and data.oldest_awaiting_z_date < today:
        flags.append(MachineFlag.CLOSED_SHIFTS_AWAITING_Z)

    if data.catalog_pull_stale:
        flags.append(MachineFlag.CATALOG_BEHIND)
    if data.clock_skew_ms is not None and abs(data.clock_skew_ms) > CLOCK_SKEW_TOLERANCE_MS:
        flags.append(MachineFlag.CLOCK_SKEWED)
    if data.battery_percent is not None and data.battery_percent <= LOW_BATTERY_PERCENT:
        flags.append(MachineFlag.LOW_BATTERY)
    # Only meaningful while the terminal is actually reachable: an offline till has no
    # realtime channel by definition, and saying so twice adds nothing.
    if is_online(data.last_heartbeat_at, now=now) and data.mqtt_connected is False:
        flags.append(MachineFlag.REALTIME_DOWN)

    return flags


# ── Roll-up over a group of tills (a shop area) ───────────────────────────────

#: Most severe first, for the one light an area shows (docs/AREAS_API.md §2.4).
#:
#: Not the resolver's precedence above, which picks one till's status: that order puts
#: `NO_OPEN_SHIFT` over `OFFLINE` so a till switched off after its shift is not a fault.
#: Across a group the question is "is anything here wrong", so a closed till ranks just
#: above a healthy one, and a queued close above a backlog that is merely syncing.
#: `RETIRED` and `NOT_PAIRED` are absent on purpose: neither says anything about how the
#: area is trading, and an unpaired spare in a drawer must not colour the bar red.
ROLLUP_SEVERITY = (
    MachineStatus.OFFLINE_WITH_UNSYNCED,
    MachineStatus.OFFLINE,
    MachineStatus.SHIFT_CLOSE_PENDING,
    MachineStatus.PENDING_SYNC,
    MachineStatus.NO_OPEN_SHIFT,
    MachineStatus.ONLINE,
)

#: Every primary status value, in the resolver's order — the keys of a roll-up's counts.
ALL_STATUSES = (
    MachineStatus.NOT_PAIRED,
    MachineStatus.RETIRED,
    MachineStatus.OFFLINE_WITH_UNSYNCED,
    MachineStatus.NO_OPEN_SHIFT,
    MachineStatus.OFFLINE,
    MachineStatus.PENDING_SYNC,
    MachineStatus.SHIFT_CLOSE_PENDING,
    MachineStatus.ONLINE,
)


def rollup_status(statuses: Iterable[str]) -> dict:
    """
    `{worst, counts}` over the primary statuses of a group's tills.

    `counts` has every status value, zeros included, so a reader never has to decide
    what a missing key means. `worst` is None when no till has a status that ranks —
    an empty area, or one holding only unpaired tills.
    """
    counts: Dict[str, int] = {value: 0 for value in ALL_STATUSES}
    for value in statuses:
        counts[value] = counts.get(value, 0) + 1
    worst = next((value for value in ROLLUP_SEVERITY if counts.get(value)), None)
    return {"worst": worst, "counts": counts}
