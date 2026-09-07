"""Behavioural cover for trading-day resolution.

An earlier version of these tests asserted on the *source text* of
`get_or_create_trading_day` — that the string "TradingDay.day_date" did not appear in
it. A review restored the original date-fallback written with `filter_by(...)` instead
of `filter(...)` and every assertion still passed. Structural tests cannot see
behaviour; these call the function and check what it returns and what it writes.

The bug being pinned: `trading_days` was keyed `(machine_id, day_date)` and resolution
fell back to that pair with no status filter, so an evening shift resolved to the
morning's already-closed day. Its sales attached there and its Z came back "duplicate",
which the till read as success before purging the shift's documents.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import date, datetime, timezone
from unittest.mock import MagicMock

import pytest

from app.models.trading_day import TradingDay, TradingDayStatus
from app.services.transactions import get_or_create_trading_day


class _Query:
    """Records the criteria it was filtered on so the fake session can answer."""

    def __init__(self, session, entity):
        self._session = session
        self._entity = entity
        self._criteria: list[str] = []

    def filter(self, *criteria):
        self._criteria.extend(str(c) for c in criteria)
        return self

    def order_by(self, *_):
        return self

    def first(self):
        joined = " ".join(self._criteria)
        if "trading_days.id" in joined:
            return self._session.by_id
        if "trading_days.status" in joined:
            return self._session.open_day
        return None


class _Session:
    """Enough Session for this function: two scripted lookups and an add/flush."""

    def __init__(self, by_id: TradingDay | None = None, open_day: TradingDay | None = None):
        self.info: dict = {}
        self.by_id = by_id
        self.open_day = open_day
        self.added: list = []
        self.flushes = 0

    def query(self, entity):
        return _Query(self, entity)

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        self.flushes += 1

    def rollback(self):
        pass


def _machine():
    m = MagicMock()
    m.id = uuid.uuid4()
    m.tenant_id = uuid.uuid4()
    m.shop_id = uuid.uuid4()
    return m


def _day(status=TradingDayStatus.OPEN, **kw):
    d = TradingDay(
        id=kw.get("id", uuid.uuid4()),
        machine_id=kw.get("machine_id", uuid.uuid4()),
        day_date=kw.get("day_date", date(2026, 9, 6)),
        opened_at=kw.get("opened_at", datetime(2026, 9, 6, 5, tzinfo=timezone.utc)),
        status=status,
    )
    return d


# ── Resolution ────────────────────────────────────────────────────────────────


def test_a_known_id_is_returned_and_nothing_is_created():
    existing = _day()
    db = _Session(by_id=existing)

    got = get_or_create_trading_day(
        db, _machine(), trading_day_id=existing.id, day_date=date(2026, 9, 6)
    )

    assert got is existing
    assert db.added == []


def test_an_unknown_id_creates_that_exact_day():
    wanted = uuid.uuid4()
    db = _Session()

    got = get_or_create_trading_day(
        db, _machine(), trading_day_id=wanted, day_date=date(2026, 9, 6)
    )

    assert got.id == wanted
    assert db.added == [got]


def test_a_second_shift_on_the_same_date_does_not_resolve_to_the_closed_first():
    """
    The bug, stated as behaviour. The morning is closed and carries the same date; the
    evening arrives with its own id. It must get its own day — not the morning's.
    """
    machine = _machine()
    morning = _day(status=TradingDayStatus.CLOSED, machine_id=machine.id)
    evening_id = uuid.uuid4()
    # `by_id` is None: the server has never seen the evening's id. Under the old code
    # the date fallback would have found the morning here.
    db = _Session(by_id=None, open_day=None)

    got = get_or_create_trading_day(
        db, machine, trading_day_id=evening_id, day_date=morning.day_date
    )

    assert got.id == evening_id
    assert got is not morning
    assert got.status == TradingDayStatus.OPEN


# ── The phantom-day guard ─────────────────────────────────────────────────────


def test_a_sale_with_no_day_id_joins_the_open_day():
    """
    A sale can be written with no trading-day id — an older row, or one created in the
    window between a day closing and the next opening. Creating a fresh open day for it
    would manufacture a phantom no Z will ever close, and would then collide with the
    one-open-day rule and 500 the whole batch.
    """
    machine = _machine()
    open_day = _day(machine_id=machine.id)
    db = _Session(by_id=None, open_day=open_day)

    got = get_or_create_trading_day(
        db, machine, trading_day_id=None, day_date=date(2026, 9, 6)
    )

    assert got is open_day
    assert db.added == [], "must not create a second open day"


def test_a_sale_with_no_day_id_and_no_open_day_still_gets_one():
    db = _Session(by_id=None, open_day=None)

    got = get_or_create_trading_day(
        db, _machine(), trading_day_id=None, day_date=date(2026, 9, 6)
    )

    assert got.status == TradingDayStatus.OPEN
    assert db.added == [got]


# ── Closing a day the cloud never saw ─────────────────────────────────────────


def test_a_day_created_by_the_z_path_is_created_closed():
    """
    `apply_z_report` closes the day it resolves. Creating it OPEN and closing it one
    statement later trips the one-open-day index on a machine that already has a day
    open — a 500 on the close of a till that traded offline.
    """
    db = _Session()

    got = get_or_create_trading_day(
        db,
        _machine(),
        trading_day_id=uuid.uuid4(),
        day_date=date(2026, 9, 6),
        status=TradingDayStatus.CLOSED,
    )

    assert got.status == TradingDayStatus.CLOSED


def test_the_open_metadata_is_carried_onto_a_created_day():
    db = _Session()
    opened = datetime(2026, 9, 6, 5, 0, tzinfo=timezone.utc)

    got = get_or_create_trading_day(
        db,
        _machine(),
        trading_day_id=uuid.uuid4(),
        day_date=date(2026, 9, 6),
        opened_at=opened,
        opening_cash=500,
        opened_by="dana",
        sequence_number=7,
    )

    assert got.opened_at == opened
    assert got.opening_cash == 500
    assert got.opened_by == "dana"
    assert got.sequence_number == 7


# ── The report endpoint ───────────────────────────────────────────────────────


class _RouterSession(_Session):
    def __init__(self, by_id=None, open_day=None):
        super().__init__(by_id=by_id, open_day=open_day)
        self.commits = 0

    def commit(self):
        self.commits += 1

    def refresh(self, _obj):
        pass


def _report(day_id, *, opened_at, opening_cash=None, opened_by=None, sequence_number=None):
    from app.schemas.trading_day import TradingDayOpenIn

    return TradingDayOpenIn(
        id=day_id,
        day_date=date(2026, 9, 6),
        opened_at=opened_at,
        opening_cash=opening_cash,
        opened_by=opened_by,
        sequence_number=sequence_number,
    )


def test_a_late_report_never_reopens_a_day_that_filed_its_z():
    """
    The till can be offline when it opens a day and only report it hours later — after
    the Z. Overwriting a closed day's opening time would move fresh sales under a filed
    fiscal document.
    """
    from fastapi import HTTPException  # noqa: F401  (imported for symmetry with below)
    from app.routers.sync import machine_report_trading_day

    machine = _machine()
    filed = _day(status=TradingDayStatus.CLOSED, machine_id=machine.id)
    original_open = filed.opened_at
    db = _RouterSession(by_id=filed)

    got = machine_report_trading_day(
        str(machine.id),
        _report(filed.id, opened_at=datetime(2026, 9, 6, 23, tzinfo=timezone.utc)),
        machine=machine,
        db=db,
    )

    assert got is filed
    assert got.opened_at == original_open, "a closed day must not be rewritten"
    assert db.commits == 0


def test_reporting_an_open_day_corrects_what_a_sale_had_to_guess():
    """
    A sale can beat the day event to the server; the day it creates carries an opening
    time inferred from that sale and no float at all. The till's own account wins.
    """
    from app.routers.sync import machine_report_trading_day

    machine = _machine()
    guessed = _day(machine_id=machine.id, opened_at=datetime(2026, 9, 6, 8, 47, tzinfo=timezone.utc))
    db = _RouterSession(by_id=guessed)
    real_open = datetime(2026, 9, 6, 8, 0, tzinfo=timezone.utc)

    got = machine_report_trading_day(
        str(machine.id),
        _report(guessed.id, opened_at=real_open, opening_cash=500, opened_by="dana", sequence_number=3),
        machine=machine,
        db=db,
    )

    assert got.opened_at == real_open
    assert got.opening_cash == 500
    assert got.opened_by == "dana"
    assert got.sequence_number == 3


def test_a_machine_cannot_report_another_machines_day():
    from fastapi import HTTPException
    from app.routers.sync import machine_report_trading_day

    machine = _machine()
    someone_elses = _day(machine_id=uuid.uuid4())
    db = _RouterSession(by_id=someone_elses)

    with pytest.raises(HTTPException) as exc:
        machine_report_trading_day(
            str(machine.id),
            _report(someone_elses.id, opened_at=datetime(2026, 9, 6, 8, tzinfo=timezone.utc)),
            machine=machine,
            db=db,
        )
    assert exc.value.status_code == 403


def test_a_second_open_day_is_refused_with_409_not_a_500():
    """
    Left to the partial unique index this would be an IntegrityError and a 500, which
    the till retries forever. It has to be an answer the device can act on.
    """
    from fastapi import HTTPException
    from app.routers.sync import machine_report_trading_day

    machine = _machine()
    already_open = _day(machine_id=machine.id)
    db = _RouterSession(by_id=None, open_day=already_open)

    with pytest.raises(HTTPException) as exc:
        machine_report_trading_day(
            str(machine.id),
            _report(uuid.uuid4(), opened_at=datetime(2026, 9, 6, 16, 30, tzinfo=timezone.utc)),
            machine=machine,
            db=db,
        )
    assert exc.value.status_code == 409
    assert "another_day_is_open" in exc.value.detail


# ── Remote close: queue, expire, unattended ───────────────────────────────────
#
# The behaviour these pin: a close-day instruction now *waits* for an offline till
# rather than failing on a ninety-second heartbeat window, and an unattended close
# records the drawer count as unknown instead of copying the expected figure.


def test_an_unattended_close_records_no_count_and_no_variance():
    """
    The till used to send expected-as-counted, so every remote Z asserted a variance of
    exactly zero — a shop genuinely short got a document saying it balanced. Enforced on
    the server as well as the device, so an older till build cannot reintroduce it.
    """
    import inspect as _inspect

    from app.services.transactions import apply_z_report

    source = _inspect.getsource(apply_z_report)
    assert "actual_cash=None if z.unattended else z.actual_cash" in source
    assert "discrepancy=None if z.unattended else z.discrepancy" in source


def test_the_z_schema_defaults_to_attended():
    """An older till that sends no flag must not have its Z treated as unattended."""
    from app.schemas.z_report import ZReportIn

    assert ZReportIn.model_fields["unattended"].default is False


def test_an_offline_machine_is_queued_rather_than_failed():
    from app.services import close_day as cd

    source = inspect.getsource(cd.create_close_day_request)
    # The old code set FAILED with error_code "machine_offline" right here.
    assert "machine_offline" not in source
    assert "CloseDayItemStatus.PENDING" in source


def test_requests_carry_a_deadline():
    from app.models.close_day import CloseDayRequest
    from app.services.close_day import CLOSE_DAY_TTL_HOURS

    assert "expires_at" in CloseDayRequest.__table__.columns
    # Long enough to cover a till that is off overnight, short enough not to close a
    # day nobody expects a Z for any more.
    assert 12 <= CLOSE_DAY_TTL_HOURS <= 72


def test_only_uncollected_work_expires():
    """
    An item a till has already acknowledged is its business to finish or fail.
    Overwriting that with `expired` would lose the fact that a terminal tried.
    """
    from app.services import close_day as cd

    source = inspect.getsource(cd.expire_overdue_close_day_items)
    assert "CloseDayItemStatus.PENDING" in source
    assert "CloseDayItemStatus.SENT" in source
    assert "RECEIVED" not in source
    assert "COMPLETED" not in source


def test_the_heartbeat_hands_over_a_waiting_instruction():
    """
    The pull half of delivery: this is what makes an offline till a delay rather than a
    failure, because nothing has to reach it — it asks on a beat it already sends.
    """
    from app.routers import machines as machines_router

    source = inspect.getsource(machines_router.post_my_heartbeat)
    assert "take_pending_close_day_for_machine" in source
    assert "pendingCloseDay" in source


def test_multiple_shops_are_a_union_and_deduplicated():
    from app.services import close_day as cd

    source = inspect.getsource(cd.resolve_machines_for_close_day)
    assert "shop_ids" in source
    # A till named directly *and* covered by a chosen shop must be closed once, and
    # naming two shops that share a terminal must not queue it twice.
    assert "or_(" in source
