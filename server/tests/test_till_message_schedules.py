"""
Scheduled and recurring till messages.

The till sees only what `GET /sync/{id}/messages` returns, so scheduling is the
server's: a scheduled message goes out (its receipts are written) on the first fetch
after `sendAt`; a recurring one once per occurrence — on its weekdays at its local time,
within its dates — each with its own receipts and its own "קראתי". The tenant is in
Asia/Jerusalem (UTC+3 in October 2026). 2026-10-04 is a Sunday.

Runs on the world of tests/test_shop_areas.py, with the service's clock pinned.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.till_message import TillMessage, TillMessageReceipt
from app.routers import till_messages as R
from app.schemas.till_message import TillMessageCreate, TillMessageUpdate
from app.services import till_messages as TM
from test_shop_areas import _ctx, refused, w  # noqa: F401
from test_till_messages import ack, listed, pull

UTC = timezone.utc
SUN = date(2026, 10, 4)


def at(y, mo, d, h, mi=0) -> datetime:
    """A UTC moment."""
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


def local(d: date, h, mi=0) -> datetime:
    """Jerusalem wall time on `d` (IDT, UTC+3), as UTC."""
    return datetime(d.year, d.month, d.day, h, mi, tzinfo=UTC) - timedelta(hours=3)


@pytest.fixture
def clock(monkeypatch):
    c = SimpleNamespace(now=local(SUN, 7))
    monkeypatch.setattr(TM, "_now", lambda: c.now)
    return c


def create(w, *, user=None, target=None, level="shop", **fields):
    tasks = BackgroundTasks()
    out = R.send_till_message(
        TillMessageCreate(body=fields.pop("body", "בוקר טוב"), targetLevel=level,
                          targetId=(target or w.shop).id, **fields),
        tasks,
        **_ctx(w, user),
    )
    return out


def recurring(w, days=(0,), time="08:00", **kw):
    return create(w, scheduleKind="recurring", recurDays=list(days), recurTime=time, **kw)


def item(w, message_id):
    return next(i for i in listed(w)["items"] if str(i["id"]) == str(message_id))


def add_till(w, name="Late", pos_number="9"):
    t = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
        name=name, machine_code=f"M-{name}", pos_number=pos_number, is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(t)
    w.db.commit()
    return t


class TestScheduled:
    def test_not_delivered_before_send_at_and_delivered_after(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=datetime(2026, 10, 4, 9, 30))  # local
        assert out["status"] == "scheduled" and out["counts"]["total"] == 0
        assert out["nextOccurrenceAt"] == local(SUN, 9, 30)
        assert w.notified == []  # nothing woken at creation
        assert pull(w, w.tills[0]) == []

        clock.now = local(SUN, 9, 29)
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN, 9, 31)
        items = pull(w, w.tills[0])
        assert [i["id"] for i in items] == [str(out["id"])]
        assert datetime.fromisoformat(items[0]["sentAt"]) == local(SUN, 9, 30)
        row = item(w, out["id"])
        assert row["status"] == "active" and row["counts"] == {"total": 2, "delivered": 1, "acknowledged": 0}
        ack(w, w.tills[0], out["id"])
        assert pull(w, w.tills[0]) == []

    def test_the_audience_is_resolved_when_it_goes_out(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=local(SUN, 9))
        late = add_till(w)
        clock.now = local(SUN, 10)
        assert len(pull(w, late)) == 1
        # The dashboard alone sends it too: every till's receipt exists before they fetch.
        assert item(w, out["id"])["counts"]["total"] == 3
        later = add_till(w, "Later", "8")
        assert pull(w, later) == []

    def test_listed_before_it_goes_out_and_editable_until_then(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=local(SUN, 9))
        assert item(w, out["id"])["canEdit"] is True
        edited = R.update_till_message(
            str(out["id"]), TillMessageUpdate(body="שונה", sendAt=local(SUN, 11)), **_ctx(w)
        )
        assert edited["body"] == "שונה" and edited["sendAt"] == local(SUN, 11)
        clock.now = local(SUN, 10)
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN, 11, 1)
        assert pull(w, w.tills[0])[0]["body"] == "שונה"
        e = refused(R.update_till_message, str(out["id"]), TillMessageUpdate(body="x"), **_ctx(w))
        assert (e.status_code, e.detail) == (409, "till_message_not_editable")

    def test_a_past_send_time_or_an_expiry_before_it_is_refused(self, w, clock):
        e = refused(create, w, scheduleKind="scheduled", sendAt=local(SUN, 6))
        assert e.detail == "till_message_schedule_in_past"
        e = refused(create, w, scheduleKind="scheduled", sendAt=local(SUN, 9), expiresAt=local(SUN, 8, 30))
        assert e.detail == "till_message_expiry_before_send"

    def test_cancelled_before_it_goes_out_it_never_does(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=local(SUN, 9))
        R.cancel_till_message(str(out["id"]), BackgroundTasks(), **_ctx(w))
        clock.now = local(SUN, 10)
        assert pull(w, w.tills[0]) == []
        assert item(w, out["id"])["status"] == "cancelled"


class TestRecurring:
    def test_delivered_on_a_matching_weekday_after_its_time_only(self, w, clock):
        out = recurring(w, days=(0, 2), time="08:00")  # Sunday and Tuesday
        assert out["status"] == "active" and out["nextOccurrenceAt"] == local(SUN, 8)
        clock.now = local(SUN, 7, 59)
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN, 8, 1)
        (sunday,) = pull(w, w.tills[0])
        assert sunday["id"] != str(out["id"])  # each occurrence is its own message to the till
        assert datetime.fromisoformat(sunday["sentAt"]) == local(SUN, 8)
        clock.now = local(SUN + timedelta(days=1), 9)  # Monday
        assert pull(w, w.tills[0]) == []  # Sunday's ended with its day; Monday is not a day
        clock.now = local(SUN + timedelta(days=2), 9)  # Tuesday
        assert len(pull(w, w.tills[0])) == 1

    def test_each_occurrence_needs_its_own_ack(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        (sunday,) = pull(w, w.tills[0])
        assert ack(w, w.tills[0], sunday["id"]) == {"ok": True}
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN + timedelta(days=1), 9)
        (monday,) = pull(w, w.tills[0])
        assert monday["id"] != sunday["id"]
        # The message's own id acknowledges this till's latest occurrence.
        ack(w, w.tills[0], out["id"])
        assert pull(w, w.tills[0]) == []
        rows = w.db.query(TillMessageReceipt).filter(
            TillMessageReceipt.message_id == uuid.UUID(str(out["id"])),
            TillMessageReceipt.machine_id == w.tills[0].id,
        ).all()
        assert sorted(r.occurrence_date for r in rows) == [SUN, SUN + timedelta(days=1)]
        assert all(r.acknowledged_at is not None for r in rows)
        # Another till's ack on a receipt id it was not given is 404.
        assert refused(ack, w, w.tills[1], monday["id"]).status_code == 404

    def test_the_list_shows_the_latest_occurrence(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        ack(w, w.tills[0], pull(w, w.tills[0])[0]["id"])
        clock.now = local(SUN + timedelta(days=1), 9)
        row = item(w, out["id"])
        assert row["occurrence"]["date"] == SUN + timedelta(days=1)
        assert row["occurrence"]["live"] is True
        assert row["counts"] == {"total": 2, "delivered": 0, "acknowledged": 0}
        assert row["recurrence"]["days"] == list(range(7)) and row["recurrence"]["time"] == "08:00"
        assert row["nextOccurrenceAt"] == local(SUN + timedelta(days=2), 8)
        assert row["canEdit"] is True

    def test_an_occurrence_under_way_at_creation_is_not_sent_late(self, w, clock):
        clock.now = local(SUN, 10)
        recurring(w, days=range(7), time="08:00")
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN + timedelta(days=1), 8, 5)
        assert len(pull(w, w.tills[0])) == 1

    def test_a_new_till_gets_the_next_occurrence(self, w, clock):
        recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        pull(w, w.tills[0])
        late = add_till(w)
        assert pull(w, late) == []
        clock.now = local(SUN + timedelta(days=1), 9)
        assert len(pull(w, late)) == 1

    def test_occurrence_ttl(self, w, clock):
        recurring(w, days=range(7), time="08:00", occurrenceTtlMinutes=60)
        clock.now = local(SUN, 8, 59)
        assert len(pull(w, w.tills[0])) == 1
        clock.now = local(SUN, 9, 1)
        assert pull(w, w.tills[0]) == []

    def test_a_long_ttl_stops_at_the_next_occurrence(self, w, clock):
        recurring(w, days=range(7), time="08:00", occurrenceTtlMinutes=48 * 60)
        clock.now = local(SUN, 9)
        sunday = pull(w, w.tills[0])[0]["id"]
        clock.now = local(SUN + timedelta(days=1), 9)
        assert [i["id"] for i in pull(w, w.tills[0])] != [sunday]
        assert len(pull(w, w.tills[0])) == 1

    def test_pause_and_resume(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        paused = R.pause_till_message(str(out["id"]), **_ctx(w))
        assert paused["status"] == "paused" and paused["nextOccurrenceAt"] is None
        clock.now = local(SUN, 9)
        assert pull(w, w.tills[0]) == []
        resumed = R.resume_till_message(str(out["id"]), **_ctx(w))
        assert resumed["status"] == "active"
        assert pull(w, w.tills[0]) == []  # today's had begun: from the next one
        clock.now = local(SUN + timedelta(days=1), 8, 1)
        assert len(pull(w, w.tills[0])) == 1

    def test_pause_is_only_for_recurring(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=local(SUN, 9))
        e = refused(R.pause_till_message, str(out["id"]), **_ctx(w))
        assert (e.status_code, e.detail) == (409, "till_message_not_recurring")

    def test_end_date(self, w, clock):
        out = recurring(w, days=range(7), time="08:00", recurEndDate=SUN + timedelta(days=1))
        clock.now = local(SUN + timedelta(days=1), 9)
        assert len(pull(w, w.tills[0])) == 1
        clock.now = local(SUN + timedelta(days=2), 9)
        assert pull(w, w.tills[0]) == []
        row = item(w, out["id"])
        assert row["status"] == "ended" and row["nextOccurrenceAt"] is None and row["canManage"] is False

    def test_start_date(self, w, clock):
        out = recurring(w, days=range(7), time="08:00", recurStartDate=SUN + timedelta(days=2))
        assert out["nextOccurrenceAt"] == local(SUN + timedelta(days=2), 8)
        clock.now = local(SUN + timedelta(days=1), 9)
        assert pull(w, w.tills[0]) == []

    def test_a_schedule_with_no_occurrence_left_is_refused(self, w, clock):
        e = refused(recurring, w, days=(1,), recurStartDate=SUN, recurEndDate=SUN)  # Monday only, Sunday only
        assert e.detail == "till_message_no_occurrence"

    def test_editing_the_time_takes_effect_next(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        assert len(pull(w, w.tills[0])) == 1
        R.update_till_message(str(out["id"]), TillMessageUpdate(recurTime="12:00"), **_ctx(w))
        clock.now = local(SUN, 12, 30)
        assert len(pull(w, w.tills[0])) == 1  # still Sunday's, not a second one
        clock.now = local(SUN + timedelta(days=1), 11)
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN + timedelta(days=1), 12, 1)
        assert len(pull(w, w.tills[0])) == 1

    def test_cancel_withdraws_the_occurrence_and_the_future(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        assert len(pull(w, w.tills[0])) == 1
        R.cancel_till_message(str(out["id"]), BackgroundTasks(), **_ctx(w))
        assert pull(w, w.tills[0]) == []
        clock.now = local(SUN + timedelta(days=1), 9)
        assert pull(w, w.tills[0]) == []

    def test_resend_wakes_only_todays_unacknowledged(self, w, clock):
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        ack(w, w.tills[0], pull(w, w.tills[0])[0]["id"])
        w.notified.clear()
        tasks = BackgroundTasks()
        again = R.resend_till_message(str(out["id"]), tasks, **_ctx(w))
        assert again["notified"] == 1

    def test_a_racing_second_delivery_is_absorbed(self, w, clock):
        """Two tills' fetches both see the occurrence as due: the unique index keeps one."""
        out = recurring(w, days=range(7), time="08:00")
        clock.now = local(SUN, 9)
        assert len(pull(w, w.tills[0])) == 1
        w.db.commit()
        row = w.db.get(TillMessage, uuid.UUID(str(out["id"])))
        TM._deliver(w.db, row, clock.now, occurrence=SUN)  # as if it had read a stale row
        w.db.commit()
        assert w.db.query(TillMessageReceipt).count() == 2
        assert len(pull(w, w.tills[1])) == 1

    def test_validation(self):
        with pytest.raises(ValueError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), scheduleKind="recurring")
        with pytest.raises(ValueError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(),
                              scheduleKind="recurring", recurDays=[7], recurTime="08:00")
        with pytest.raises(ValueError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(),
                              scheduleKind="recurring", recurDays=[1], recurTime="25:00")
        with pytest.raises(ValueError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), scheduleKind="scheduled")


class TestTimezone:
    def test_local_weekday_and_day_end_across_midnight_utc(self, w, clock):
        """00:30 Sunday in Jerusalem is 21:30 Saturday UTC."""
        clock.now = at(2026, 10, 2, 20)  # Friday 23:00 local
        saturday = recurring(w, days=(6,), time="00:30", body="sat")
        sunday = recurring(w, days=(0,), time="00:30", body="sun")
        assert sunday["nextOccurrenceAt"] == at(2026, 10, 3, 21, 30)

        clock.now = at(2026, 10, 2, 21, 40)  # Saturday 00:40 local
        assert [i["body"] for i in pull(w, w.tills[0])] == ["sat"]

        clock.now = at(2026, 10, 3, 21, 0)  # Sunday 00:00 local: Saturday's day is over
        assert pull(w, w.tills[0]) == []
        clock.now = at(2026, 10, 3, 21, 29)
        assert pull(w, w.tills[0]) == []
        clock.now = at(2026, 10, 3, 21, 40)  # Sunday 00:40 local, still Saturday in UTC
        assert [i["body"] for i in pull(w, w.tills[0])] == ["sun"]
        row = w.db.get(TillMessage, uuid.UUID(str(sunday["id"])))
        assert row.timezone == "Asia/Jerusalem" and row.last_occurrence_date == SUN
        assert w.db.get(TillMessage, uuid.UUID(str(saturday["id"]))).last_occurrence_date == date(2026, 10, 3)

    def test_a_scheduled_time_without_offset_is_the_tenants(self, w, clock):
        out = create(w, scheduleKind="scheduled", sendAt=datetime(2026, 10, 4, 23, 30))
        assert out["sendAt"] == at(2026, 10, 4, 20, 30)
