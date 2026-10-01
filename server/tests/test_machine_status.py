"""
The terminal status light.

Precedence is the whole risk here. Each individual rule is obvious; what is not obvious
is which one wins when two apply at once, and a wrong order is invisible until a shop
misses a real outage because every till goes red at closing time anyway.

So most of these tests set up *two* true conditions and assert which one shows.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from app.services.machine_status import (
    CLOCK_SKEW_TOLERANCE_MS,
    LOW_BATTERY_PERCENT,
    ONLINE_WINDOW_SEC,
    MachineFlag,
    MachineStatus,
    StatusInput,
    is_online,
    resolve_status,
)

NOW = datetime(2026, 9, 9, 20, 0, 0, tzinfo=timezone.utc)
TODAY = NOW.date()


def _machine(**kw) -> StatusInput:
    """A healthy, trading terminal. Each test breaks exactly one thing."""
    base = dict(
        is_active=True,
        pairing_status="assigned",
        last_heartbeat_at=NOW - timedelta(seconds=5),
        shift_open=True,
        business_date=TODAY,
        close_shift_pending=False,
        pending_documents=0,
        pending_count=0,
        pending_count_at=NOW - timedelta(seconds=5),
    )
    base.update(kw)
    return StatusInput(**base)


def _status(**kw) -> str:
    return resolve_status(_machine(**kw), now=NOW).status


# ── The four the merchant asked for ──────────────────────────────────────────

class TestTheFourColours:
    def test_online_and_synced(self):
        assert _status() == MachineStatus.ONLINE

    def test_online_with_documents_waiting(self):
        assert _status(pending_documents=3) == MachineStatus.PENDING_SYNC

    def test_offline(self):
        assert _status(last_heartbeat_at=NOW - timedelta(minutes=10)) == MachineStatus.OFFLINE

    def test_no_open_shift(self):
        assert _status(shift_open=False) == MachineStatus.NO_OPEN_SHIFT


# ── Precedence: the part that is easy to get wrong ───────────────────────────

class TestPrecedence:
    def test_no_open_shift_outranks_being_offline(self):
        """
        A till switched off after its shift is behaving correctly. Showing it red every
        evening teaches the shop that red means nothing, which is how a real outage gets
        missed. This is a deliberate inversion of the urgency ordering.
        """
        assert _status(
            shift_open=False, last_heartbeat_at=NOW - timedelta(hours=3)
        ) == MachineStatus.NO_OPEN_SHIFT

    def test_unsynced_documents_outrank_no_open_shift(self):
        """
        Undelivered documents after a close mean the close drained less than it claimed.
        That is anomalous whatever the shift says, so it must not be hidden behind the
        tidy black light above.
        """
        assert _status(
            shift_open=False,
            last_heartbeat_at=NOW - timedelta(hours=3),
            pending_documents=2,
        ) == MachineStatus.OFFLINE_WITH_UNSYNCED

    def test_offline_with_documents_is_not_just_offline(self):
        """The most alarming state there is: money on a device nobody can reach."""
        assert _status(
            last_heartbeat_at=NOW - timedelta(minutes=10), pending_documents=4
        ) == MachineStatus.OFFLINE_WITH_UNSYNCED

    def test_a_backlog_outranks_a_queued_close(self):
        """A queued close is information; unsent sales are a problem."""
        assert _status(close_shift_pending=True, pending_documents=1) == MachineStatus.PENDING_SYNC

    def test_a_queued_close_shows_on_an_otherwise_healthy_till(self):
        assert _status(close_shift_pending=True) == MachineStatus.SHIFT_CLOSE_PENDING

    def test_retired_outranks_everything(self):
        assert _status(
            is_active=False,
            last_heartbeat_at=NOW - timedelta(days=30),
            pending_documents=9,
        ) == MachineStatus.RETIRED

    def test_an_unpaired_terminal_is_not_reported_as_offline(self):
        """It never was online, so "offline" would read as a fault that never happened."""
        assert _status(pairing_status="unpaired") == MachineStatus.NOT_PAIRED

    def test_a_terminal_that_never_beat_is_not_paired_rather_than_offline(self):
        assert _status(last_heartbeat_at=None) == MachineStatus.NOT_PAIRED


# ── The online window ────────────────────────────────────────────────────────

class TestOnlineWindow:
    def test_a_beat_inside_the_window_is_online(self):
        assert is_online(NOW - timedelta(seconds=ONLINE_WINDOW_SEC - 1), now=NOW) is True

    def test_exactly_on_the_boundary_is_still_online(self):
        assert is_online(NOW - timedelta(seconds=ONLINE_WINDOW_SEC), now=NOW) is True

    def test_one_second_past_the_window_is_offline(self):
        assert is_online(NOW - timedelta(seconds=ONLINE_WINDOW_SEC + 1), now=NOW) is False

    def test_the_window_is_five_minutes_for_a_two_minute_beat(self):
        """Two missed beats plus slack; a beat every two minutes must never flicker."""
        assert ONLINE_WINDOW_SEC == 300

    def test_just_under_five_minutes_is_online(self):
        assert is_online(NOW - timedelta(seconds=299), now=NOW) is True

    def test_just_over_five_minutes_is_offline(self):
        assert is_online(NOW - timedelta(seconds=301), now=NOW) is False

    def test_what_the_old_ninety_second_window_called_offline_is_now_online(self):
        for seconds in (91, 120, 121, 240, 299):
            assert is_online(NOW - timedelta(seconds=seconds), now=NOW) is True

    def test_a_beat_missed_once_is_still_online(self):
        assert is_online(NOW - timedelta(minutes=4), now=NOW) is True

    def test_never_beating_is_offline(self):
        assert is_online(None, now=NOW) is False

    def test_a_naive_timestamp_is_read_as_utc_rather_than_raising(self):
        """
        A row that lost its tzinfo would otherwise raise on the subtraction and take the
        whole machine list down — a crash, not a degraded light.
        """
        naive = (NOW - timedelta(seconds=5)).replace(tzinfo=None)

        assert is_online(naive, now=NOW) is True


# ── Reading the backlog ──────────────────────────────────────────────────────

class TestBacklogReading:
    def test_documents_are_preferred_over_the_whole_outbox(self):
        """
        A till stuck on one close-day acknowledgement holds no unsent money. Counting
        the whole outbox would light it amber and teach the shop to ignore amber.
        """
        assert _status(pending_documents=0, pending_count=1) == MachineStatus.ONLINE

    def test_an_older_till_falls_back_to_the_outbox_depth(self):
        """`pendingDocuments` is newer than `pendingCount`; some of a chain will lag."""
        assert _status(pending_documents=None, pending_count=2) == MachineStatus.PENDING_SYNC

    def test_a_terminal_that_has_never_reported_is_not_assumed_to_be_behind(self):
        assert _status(pending_documents=None, pending_count=None) == MachineStatus.ONLINE

    def test_the_reading_is_returned_with_the_moment_it_was_taken(self):
        """The UI has to say "as of", not present a stale count as live."""
        taken = NOW - timedelta(minutes=4)
        out = resolve_status(_machine(pending_documents=3, pending_count_at=taken), now=NOW)

        assert out.pending_documents == 3
        assert out.pending_as_of == taken

    def test_never_reported_is_null_rather_than_zero(self):
        out = resolve_status(_machine(pending_documents=None, pending_count=None), now=NOW)

        assert out.pending_documents is None


# ── Secondary flags ──────────────────────────────────────────────────────────

class TestFlags:
    def _flags(self, **kw):
        return resolve_status(_machine(**kw), now=NOW).flags

    def test_a_shift_left_open_past_its_date_is_flagged(self):
        """What a dead terminal leaves behind — today, only visible if you go looking."""
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE in self._flags(business_date=TODAY - timedelta(days=1))

    def test_todays_open_shift_is_not_flagged(self):
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE not in self._flags()

    def test_a_flag_does_not_change_the_light(self):
        """
        The whole point of the split: a terminal that is trading fine but has drifted a
        clock is still green, with a badge. Folding flags into the colour would make the
        colour mean nothing.
        """
        assert _status(business_date=TODAY - timedelta(days=1), clock_skew_ms=999_999) == MachineStatus.ONLINE

    def test_clock_skew_is_flagged_in_both_directions(self):
        assert MachineFlag.CLOCK_SKEWED in self._flags(clock_skew_ms=CLOCK_SKEW_TOLERANCE_MS + 1)
        assert MachineFlag.CLOCK_SKEWED in self._flags(clock_skew_ms=-(CLOCK_SKEW_TOLERANCE_MS + 1))

    def test_ordinary_drift_is_not_flagged(self):
        assert MachineFlag.CLOCK_SKEWED not in self._flags(clock_skew_ms=CLOCK_SKEW_TOLERANCE_MS)

    def test_low_battery_is_flagged_and_unknown_battery_is_not(self):
        assert MachineFlag.LOW_BATTERY in self._flags(battery_percent=LOW_BATTERY_PERCENT)
        assert MachineFlag.LOW_BATTERY not in self._flags(battery_percent=None)

    def test_a_dead_realtime_channel_is_flagged_only_while_reachable(self):
        """An offline till has no realtime channel by definition; saying so adds nothing."""
        assert MachineFlag.REALTIME_DOWN in self._flags(mqtt_connected=False)
        assert MachineFlag.REALTIME_DOWN not in self._flags(
            mqtt_connected=False, last_heartbeat_at=NOW - timedelta(minutes=10)
        )

    def test_catalog_behind_is_flagged(self):
        assert MachineFlag.CATALOG_BEHIND in self._flags(catalog_pull_stale=True)

    def test_closed_shifts_from_an_earlier_date_awaiting_a_z_are_flagged(self):
        """A shop that forgot its Z: yesterday's closed shifts no Z has taken."""
        assert MachineFlag.CLOSED_SHIFTS_AWAITING_Z in self._flags(
            oldest_awaiting_z_date=TODAY - timedelta(days=1)
        )

    def test_todays_closed_shifts_awaiting_a_z_are_not_flagged(self):
        """The morning shift is closed and the Z is due tonight: nothing is wrong yet."""
        assert MachineFlag.CLOSED_SHIFTS_AWAITING_Z not in self._flags(oldest_awaiting_z_date=TODAY)
        assert MachineFlag.CLOSED_SHIFTS_AWAITING_Z not in self._flags(oldest_awaiting_z_date=None)

    def test_awaiting_z_does_not_change_the_light(self):
        assert _status(oldest_awaiting_z_date=TODAY - timedelta(days=3)) == MachineStatus.ONLINE


# ── "Today" is the shop's date, not UTC's ────────────────────────────────────

class TestTodayIsTheTenantsDate:
    """
    22:30 UTC on 9 September is 01:30 on 10 September in Israel. A shift opened on the
    9th is, for the shop, past its date — and under UTC it looked current until 03:00.
    """

    LATE = datetime(2026, 9, 9, 22, 30, tzinfo=timezone.utc)

    def _flags(self, tz, **kw):
        return resolve_status(_machine(timezone_name=tz, last_heartbeat_at=self.LATE, pending_count_at=self.LATE, **kw), now=self.LATE).flags

    def test_a_shift_from_yesterday_in_israel_is_flagged_after_local_midnight(self):
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE in self._flags(
            "Asia/Jerusalem", business_date=date(2026, 9, 9)
        )

    def test_under_utc_the_same_shift_is_still_current(self):
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE not in self._flags(
            "UTC", business_date=date(2026, 9, 9)
        )

    def test_awaiting_z_uses_the_same_local_today(self):
        assert MachineFlag.CLOSED_SHIFTS_AWAITING_Z in self._flags(
            "Asia/Jerusalem", oldest_awaiting_z_date=date(2026, 9, 9)
        )

    def test_an_unknown_zone_falls_back_to_utc_rather_than_failing(self):
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE not in self._flags(
            "Not/AZone", business_date=date(2026, 9, 9)
        )


# ── The scenario that started this ───────────────────────────────────────────

class TestDeadTerminalScenario:
    def test_a_till_that_died_holding_sales_is_the_loudest_status(self):
        """
        The case discussed with the merchant: a terminal dies mid-day with sales that
        never reached the cloud. It must not read as an ordinary offline till, and the
        shift it left open must be flagged, because nothing can ever close it.
        """
        out = resolve_status(
            _machine(
                last_heartbeat_at=NOW - timedelta(days=1),
                pending_documents=7,
                business_date=TODAY - timedelta(days=1),
            ),
            now=NOW,
        )

        assert out.status == MachineStatus.OFFLINE_WITH_UNSYNCED
        assert out.online is False
        assert out.pending_documents == 7
        assert MachineFlag.SHIFT_OPEN_PAST_ITS_DATE in out.flags


# ── The heartbeat must actually persist what the till reports ────────────────

class TestHeartbeatStoresTheBacklog:
    """
    The resolver is only as good as its input. These cover the wiring between "the till
    said 3" and "the row holds 3", which the status tests above take for granted.
    """

    def _machine_row(self):
        from app.models.pos_machine import POSMachine

        m = POSMachine()
        m.pending_count = None
        m.pending_documents = None
        m.pending_count_at = None
        m.app_version = None
        m.mqtt_connected = None
        m.serial_number = None
        m.battery_percent = None
        m.battery_status = None
        m.clock_skew_ms = None
        m.last_health_report_at = None
        m.last_heartbeat_at = None
        return m

    def _beat(self, **kw):
        from unittest.mock import MagicMock
        from app.services import sync as S

        row = self._machine_row()
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = row
        S.update_machine_heartbeat(db, "m1", **kw)
        return row

    def test_the_reported_counts_are_stored_with_a_timestamp(self):
        row = self._beat(pending_count=5, pending_documents=3)

        assert row.pending_count == 5
        assert row.pending_documents == 3
        assert row.pending_count_at is not None

    def test_zero_is_stored_rather_than_treated_as_nothing_reported(self):
        """
        The distinction the whole light rests on: "I have nothing queued" is a real
        report, and must not be indistinguishable from a till that never said.
        """
        row = self._beat(pending_count=0, pending_documents=0)

        assert row.pending_documents == 0
        assert row.pending_count_at is not None

    def test_an_older_till_that_reports_nothing_leaves_the_last_reading_alone(self):
        """
        Every heartbeat field is "None means the till did not say". Wiping the last known
        backlog on a beat from an older build would make a real backlog vanish.
        """
        row = self._machine_row()
        row.pending_documents = 4
        row.pending_count_at = "earlier"

        from unittest.mock import MagicMock
        from app.services import sync as S

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = row
        S.update_machine_heartbeat(db, "m1", app_version="1.2.3")

        assert row.pending_documents == 4
        assert row.pending_count_at == "earlier"

    def test_a_till_sending_only_the_total_still_updates_the_timestamp(self):
        row = self._beat(pending_count=2)

        assert row.pending_count == 2
        assert row.pending_documents is None
        assert row.pending_count_at is not None
